-- =====================================================================
-- idea 8436 — http SSRF (extensión http en schema public, callable por anon)
-- RUNBOOK para cerrarlo SIN ROMPER NADA. 2026-08-28.
--
-- POR QUÉ NO SE APLICÓ EN LA SESIÓN DEL 2026-08-28:
--   * La extensión `http` la posee `supabase_admin`. El rol `postgres` (con el que
--     corren el MCP y el SQL Editor del dashboard) NO es miembro de supabase_admin,
--     así que NO puede `alter extension http set schema ...` (falla por ownership) ni
--     revocar el EXECUTE de anon (el grant es de supabase_admin). Verificado:
--     pg_has_role('postgres','supabase_admin','MEMBER') = false.
--   * Además 2 funciones (refresh_proyeccion_madre, ventas_mensuales_cod) llaman a la
--     extensión CALIFICADA (public.http, public.http_header, tipos public.http_response/
--     public.http_request) → un move a ciegas las rompe.
--
-- QUIÉN LO CORRE: alguien con rol `supabase_admin`/superuser, o soporte Supabase.
--   El Step 0 (des-calificar) lo puede correr `postgres`; el Step 1 (mover la extensión)
--   necesita el dueño. Correr en orden 0 → 1 → 2. Es NON-BREAKING si se respeta el orden:
--   tras el Step 0, las funciones resuelven `http_*` por search_path (public,extensions),
--   idéntico ANTES y DESPUÉS del move.
--
-- POR QUÉ CIERRA EL SSRF: PostgREST expone solo el schema `public`. Al mover `http` a
--   `extensions` (schema NO expuesto), anon deja de poder llamar http_get/http_post por
--   /rest/v1/rpc → se corta el SSRF. Los callers internos son SECURITY DEFINER y siguen
--   funcionando porque `extensions` queda en su search_path.
-- =====================================================================

-- ---------------------------------------------------------------------
-- STEP 0 — des-calificar los 2 callers que usan public.http* (corre postgres).
--   Idéntico comportamiento hoy (public sigue en el search_path). Cuerpo intacto salvo
--   quitar el prefijo `public.` de http/http_header/http_response/http_request y sumar
--   `extensions` al search_path.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_proyeccion_madre()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  resp http_response;
  body jsonb;
  n integer;
  v_err text;
  v_dia text := to_char((now() at time zone 'America/Argentina/Buenos_Aires'), 'YYYYMMDD');
  k constant text := 'sb_publishable_mVX5MnjwM770cNjgiL6yLw_LDNl9pML';
begin
  begin
    resp := http(('GET',
      'https://kwkclwhmoygunqmlegrg.supabase.co/rest/v1/rpc/fn_proyeccion_oc_virgilio',
      array[ http_header('apikey', k), http_header('Authorization', 'Bearer ' || k) ],
      null, null)::http_request);
  exception when others then
    resp := null; v_err := 'excepción HTTP: ' || coalesce(sqlerrm, '?');
  end;

  if resp is null or resp.status <> 200 then
    v_err := coalesce(v_err, 'HTTP ' || coalesce(resp.status::text, '?') || ' — ' || left(coalesce(resp.content, ''), 180));
    begin
      perform public.tg_enqueue(
        '🚨 PROYECCIÓN NO ACTUALIZADA — ' || to_char((now() at time zone 'America/Argentina/Buenos_Aires'), 'DD/MM') || E'\n' ||
        'El generador de OCs sigue con la última proyección buena. Motivo: ' || v_err || E'\n' ||
        'Revisá el motor fn_proyeccion_oc_virgilio en "loekemeyer''s web".',
        'projmadre_fail_' || v_dia);
      perform public.tg_outbox_flush();
    exception when others then null; end;
    raise notice 'refresh_proyeccion_madre: %', v_err;
    return -1;
  end if;

  body := resp.content::jsonb;
  if jsonb_typeof(body) <> 'array' or jsonb_array_length(body) = 0 then
    begin
      perform public.tg_enqueue(
        '🚨 PROYECCIÓN NO ACTUALIZADA — ' || to_char((now() at time zone 'America/Argentina/Buenos_Aires'), 'DD/MM') || E'\n' ||
        'El motor de proyección devolvió una respuesta vacía o inesperada. El generador de OCs sigue con la última proyección buena.',
        'projmadre_fail_' || v_dia);
      perform public.tg_outbox_flush();
    exception when others then null; end;
    raise notice 'refresh_proyeccion_madre: respuesta vacia/inesperada';
    return -1;
  end if;

  delete from public.proyeccion_madre;
  insert into public.proyeccion_madre (cod, proy_cajas_mes, uxb, proy_uni_mes, actualizado)
  select upper(btrim(x.cod)), x.proy_cajas_mes, x.uxb, x.proy_uni_mes, now()
  from jsonb_to_recordset(body) as x(cod text, proy_cajas_mes numeric, uxb integer, proy_uni_mes numeric)
  where x.proy_cajas_mes > 0 and coalesce(btrim(x.cod), '') <> '';
  get diagnostics n = row_count;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public.ventas_mensuales_cod(p_cod text, p_meses integer DEFAULT 6)
 RETURNS TABLE(mes text, cajas numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  resp http_response;
  v_cod text;
  v_url text;
  k constant text := 'sb_publishable_mVX5MnjwM770cNjgiL6yLw_LDNl9pML';
begin
  v_cod := regexp_replace(upper(btrim(coalesce(p_cod,''))), '[^A-Z0-9]', '', 'g');
  if v_cod = '' then return; end if;
  v_url := 'https://kwkclwhmoygunqmlegrg.supabase.co/rest/v1/rpc/fn_ventas_mensuales_virgilio'
         || '?p_cod=' || v_cod
         || '&p_meses=' || greatest(coalesce(p_meses,6),1)::text;
  begin
    resp := http(('GET', v_url,
      array[ http_header('apikey', k), http_header('Authorization', 'Bearer ' || k) ],
      null, null)::http_request);
  exception when others then
    return;
  end;
  if resp is null or resp.status <> 200 then return; end if;
  return query
    select x.mes, x.cajas
    from jsonb_to_recordset(resp.content::jsonb) as x(mes text, cajas numeric);
end $function$;

-- Los otros callers (sync_fichadas_respuestas/_estructura, sync_ppp_entregados_meta) ya
-- llaman a http_* SIN calificar y ya tienen `extensions` en su search_path → move-safe.
-- tg_outbox_flush / rc_alerta_recepcion_fleje / fn_facturado_notif_wa /
-- fn_virgilio_entrega_to_formato usan net.http_* (pg_net), NO la extensión http → no aplican.

-- ---------------------------------------------------------------------
-- STEP 1 — mover la extensión (NECESITA supabase_admin/superuser; postgres NO puede).
-- ---------------------------------------------------------------------
-- alter extension http set schema extensions;

-- ---------------------------------------------------------------------
-- STEP 2 — verificar (anon ya no puede; los callers siguen OK).
-- ---------------------------------------------------------------------
-- select (select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='http') as http_schema; -- => extensions
-- select has_function_privilege('anon','extensions.http_get(varchar)','EXECUTE');  -- (da true, pero PostgREST no expone `extensions`)
-- -- Recargar el schema cache de PostgREST: notify pgrst, 'reload schema';
-- select public.refresh_proyeccion_madre();      -- debe devolver >=0 (no romper)
-- select * from public.ventas_mensuales_cod('590E', 6) limit 1;

-- ---------------------------------------------------------------------
-- ROLLBACK (si algo sale mal): volver la extensión a public.
-- ---------------------------------------------------------------------
-- alter extension http set schema public;   -- (como supabase_admin)
-- Las funciones des-calificadas del Step 0 siguen funcionando con http en public
-- (search_path incluye public), así que NO hay que revertirlas.
