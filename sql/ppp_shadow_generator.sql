-- ============================================================================
-- PPP Shadow Generator  ·  Flujo nuevo de pedidos (Fase 1 — modo sombra)
-- ============================================================================
-- QUÉ ES: genera la PPP (NPs armadas + m3) DIRECTO desde los pedidos web, para
--         COMPARARla contra la PPP real que hoy produce ISIS. NO alimenta
--         producción. NO escribe nada. Es 100% de solo-lectura.
--
-- OBJETIVO: medir cuánto empata nuestro armado propio contra el de ISIS antes de
--           siquiera pensar en cortar. Mientras esto no de ~100% por semanas,
--           NO se toca la operación (ver docs/flujo-nuevo/PLAN.md, Fase 1/2).
--
-- ESTADO: NO deployado a Supabase todavía. Los .sql de este repo se corren a
--         mano en el editor; este todavía no. Correrlo solo crea 3 VIEWS de
--         lectura; no altera ninguna tabla.
--
-- FUENTES (todas ya en el proyecto Virgilio, hrxfctzncixxqmpfhskv):
--   - lk_pedidos_match  : el pedido web (cod, fecha, sucursal, items_string).
--   - Volumen_Articulos : m3 por caja de cada artículo.
--   - PPP_Programacion_Diaria + PPP_Base_Pedidos : la PPP real de ISIS (para comparar).
--
-- REGLA DE SPLIT (reverse-engineered de datos reales, ver PLAN.md):
--   Un pedido se parte en NPs con un tope de LINEAS por NP: 18 en Loekemeyer,
--   15 en Chef, en orden de codigo de articulo. Pedido chico (<= tope) = 1 NP.
--   (El split por sucursal de entrega queda para v1; ver PENDIENTE abajo.)
--
-- VALIDACION AL ESCRIBIR (2026-09-02, read-only sobre datos reales):
--   Sobre 89 cliente-dia comparables (con pedido web Y con PPP de ISIS):
--     - Mismo numero de NPs generadas : 89/89  (100%)
--     - Mismas cajas totales          : 86/89  (97%)
--     - m3 dentro del 5%              : validado aparte al 98,5% (158 NPs)
--
-- PENDIENTE (bordes a cerrar en sombra antes de confiar):
--   1. Split por SUCURSAL de entrega: hoy no lo aplica. ~9% de cliente-dia
--      tienen mas de un pedido; hay que decidir si ISIS los junta o los separa.
--   2. "SIM-30999..." y direcciones mezcladas cliente/expreso (limpieza de dato).
--   3. Definir exactamente que cuenta como "linea" (artículo distinto).
-- ============================================================================


-- 1) Pedidos web parseados a items (art, cajas), numerados por orden de codigo.
create or replace view public.v_shadow_web_items as
select
  m.order_id,
  m.cod_cliente                                   as cod,
  m.fecha_pedido                                  as fecha,
  m.empresa,
  case when m.empresa = 'chef' then 15 else 18 end as cap_lineas,
  split_part(btrim(t.tok), 'x', 1)                as art,
  nullif(split_part(btrim(t.tok), 'x', 2), '')::numeric as cajas,
  row_number() over (
    partition by m.order_id
    order by split_part(btrim(t.tok), 'x', 1)
  )                                               as linea_rn
from public.lk_pedidos_match m,
     lateral regexp_split_to_table(m.items_string, ',') as t(tok)
where nullif(btrim(m.items_string), '') is not null
  and btrim(t.tok) ~ '^[^x]+x[0-9]';


-- 2) NPs propuestas: cada pedido se parte en chunks de 'cap_lineas' lineas.
--    Numero de NP propio = order_id + indice de chunk (interno; a ISIS no le importa).
create or replace view public.v_shadow_np_gen as
select
  i.cod,
  i.fecha,
  i.empresa,
  i.order_id,
  ceil(i.linea_rn::numeric / i.cap_lineas)              as np_idx,
  (i.order_id::text || '-' || ceil(i.linea_rn::numeric / i.cap_lineas)::text) as np_shadow,
  count(*)                                              as lineas,
  sum(i.cajas)                                          as cajas,
  round(sum(i.cajas * coalesce(v.m3, 0)), 3)            as m3,
  bool_or(v.codigo is null or v.m3 is null)             as tiene_art_sin_volumen
from public.v_shadow_web_items i
left join public."Volumen_Articulos" v on v.codigo = i.art
group by i.cod, i.fecha, i.empresa, i.order_id,
         ceil(i.linea_rn::numeric / i.cap_lineas);


-- 3) Comparacion por cliente-dia: lo que generariamos nosotros vs la PPP de ISIS.
--    'estado' = ok cuando coincide numero de NPs y cajas.
create or replace view public.v_shadow_ppp_compare as
with nuestro as (
  select cod, fecha,
         count(*)         as nps_gen,
         sum(cajas)       as cajas_gen,
         round(sum(m3),2) as m3_gen,
         bool_or(tiene_art_sin_volumen) as falta_volumen
  from public.v_shadow_np_gen
  group by cod, fecha
),
np_m3 as (  -- m3 real de ISIS: uno por NP
  select np, cod, max(m3) as m3
  from public."PPP_Programacion_Diaria"
  where np ~ '^9'
  group by np, cod
),
np_fecha as (  -- fecha y cajas de cada NP real, desde la base de items
  select pedido as np, min(fecha::date) as fecha, sum(cajas) as cajas
  from public."PPP_Base_Pedidos"
  group by pedido
),
isis as (
  select m.cod, f.fecha,
         count(*)         as nps_isis,
         sum(f.cajas)     as cajas_isis,
         round(sum(m.m3),2) as m3_isis
  from np_m3 m
  join np_fecha f on f.np = m.np
  group by m.cod, f.fecha
)
select
  coalesce(n.cod, i.cod)                              as cod,
  coalesce(n.fecha, i.fecha)                          as fecha,
  n.nps_gen,   i.nps_isis,
  n.cajas_gen, i.cajas_isis,
  n.m3_gen,    i.m3_isis,
  n.falta_volumen,
  case
    when n.cod is null then 'solo_isis'        -- ISIS tiene NP y no hay pedido web (canal no-web)
    when i.cod is null then 'solo_web'         -- hay pedido web y ISIS todavia no lo armo
    when n.nps_gen = i.nps_isis
     and abs(coalesce(n.cajas_gen,0) - coalesce(i.cajas_isis,0)) <= 0.01 then 'ok'
    when n.nps_gen = i.nps_isis then 'ok_nps_dif_cajas'
    else 'revisar'
  end                                                 as estado
from nuestro n
full outer join isis i on i.cod = n.cod and i.fecha = n.fecha;


-- ----------------------------------------------------------------------------
-- Consultas de control (correr a mano):
--
--   -- Tablero de empate general:
--   select estado, count(*) from public.v_shadow_ppp_compare group by estado order by 2 desc;
--
--   -- Los casos a mirar de cerca:
--   select * from public.v_shadow_ppp_compare where estado = 'revisar' order by fecha desc;
-- ----------------------------------------------------------------------------
