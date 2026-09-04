-- =============================================================================
-- lk_pedidos_match.sql — Espejo local del string identificador de pedido web
-- (LK + CHEF), con SUCURSAL DE ENTREGA y MÉTODO DE PAGO (2026-08-28)
-- =============================================================================
-- Virgilio no tenía la sucursal de entrega de los pedidos; los portales web sí
-- (orders.sheets_payload.sucursal_entrega). LK EMPUJA acá cada 15 min por su
-- FDW existente (server virgilio_db, rol lk_ppp_reader — el mismo del espejo
-- PPP, ahora con permiso de escritura SOLO sobre esta tabla). Los pedidos de
-- CHEF (portal gemelo en el proyecto Supabase de Chef) entran por el mismo
-- camino: LK los lee por su FDW chef_db y los reenvía con empresa='chef'
-- (⚠ requiere en el proyecto Chef: grant select on public.orders to loke_reader;
-- hasta entonces solo se sincroniza LK). Virgilio lee su tabla LOCAL: cero FDW
-- en el camino caliente. La empresa de una NP se deduce del número:
-- 9xxxx = lk, 4xxxx = chef (numeraciones de cliente independientes).
--
--   match_string = cod_cliente | fecha (ART, YYYY-MM-DD) | items
--   items        = cod_art x cajas, ordenado por cod_art, cajas sumadas por
--                  código repetido (ej: "026x1,027x10,315x2")
--
-- `ambiguo` = ese mismo string aparece ese día con MÁS DE UNA sucursal
-- distinta (mismo cliente, mismo día, mismo pedido exacto a dos sucursales:
-- la única excepción que el string no resuelve — histórico: 17 pedidos de
-- 977). `orden_en_dia` desempata por hora de alta. `order_id` es el
-- order_number del portal web (el mismo que viaja al Sheet).
--
-- Lado LK: vista fuente + sync + cron en sql/pedidos_match_virgilio.sql del
-- repo pagina-LK (hoy `pagina-LK-copia`; `PaginaLK` quedó archivado).
--
-- 2026-09-04 — se agregan `fecha_entrega` / `fecha_entrega_txt` (integración
-- Krikos). Ver la nota larga más abajo, junto a los ALTER.
-- =============================================================================

create table if not exists public.lk_pedidos_match (
  empresa          text not null default 'lk', -- 'lk' | 'chef' (NP 9xxxx = lk, 4xxxx = chef)
  order_id         bigint,                  -- orders.id en el portal (= order_number del Sheet)
  cod_cliente      text not null,
  status           text,
  fecha_pedido     date not null,           -- fecha del pedido en hora argentina
  hora_pedido      text,                    -- HH24:MI:SS hora argentina
  created_at       timestamptz,
  sucursal_entrega text,                    -- el dato que Virgilio no tenía
  metodo_pago      text,                    -- orders.payment_method del portal web
  fecha_entrega     date,                   -- cuándo hay que ENTREGARLO (ver nota Krikos abajo)
  fecha_entrega_txt text,                   -- el crudo "dd/mm/yyyy [hh:mm]", por la franja horaria
  items_string     text,
  match_string     text,
  ambiguo          boolean default false,
  orden_en_dia     bigint,
  synced_at        timestamptz default now(),
  primary key (empresa, order_id)          -- los order_id de los dos portales pueden chocar
);

-- -----------------------------------------------------------------------------
-- FECHA DE ENTREGA — integración Krikos (2026-09-04)
-- -----------------------------------------------------------------------------
-- La tabla ya existía en producción, así que el `create table if not exists` de
-- arriba NO agrega columnas nuevas: para la tabla viva hacen falta estos ALTER.
-- Quedan los dos (columna en el CREATE + ALTER idempotente) para que el archivo
-- se pueda correr entero, en una base nueva o en la que ya está.
--
-- QUÉ ES: la fecha en que el súper espera la mercadería. Hasta ahora Virgilio no
-- la tenía: la fecha de entrega la elegía el supervisor al programar la tanda.
-- Para un súper es al revés — la fecha viene dada en la orden de compra y la
-- tanda se arma alrededor.
--
-- DE DÓNDE SALE: la Edge Function `krikos-ingest` del proyecto LK lee por IMAP
-- las notificaciones de OC de Planexware, baja el PDF y guarda la fecha en
-- `krikos_oc_inbox`; de ahí viaja en `orders.sheets_payload.fecha_entrega`
-- (string dd/mm/yyyy, a veces con hora) más `fecha_entrega_origen`
-- ("Krikos" | "PDF"). ⚠ NO confundir con `due_date`, que es el vencimiento de
-- COBRO — es lo único que se parseaba antes.
--
-- CÓMO LLEGA ACÁ: por el camino de siempre. `v_pedidos_match` (en LK) expone el
-- campo y `sync_pedidos_match_virgilio()` lo copia por el FDW `virgilio_db`. El
-- rol `lk_ppp_reader` ya tiene INSERT/UPDATE/DELETE sobre esta tabla, así que no
-- hace falta ningún grant nuevo.
--
-- POR QUÉ DOS COLUMNAS: `fecha_entrega` es `date` para filtrar y ordenar sin
-- parsear texto; `fecha_entrega_txt` conserva el crudo con la hora, porque
-- algunas cadenas dan franja horaria y ese dato no entra en un `date`. Si se
-- guardara sólo el `date` habría que volver al PDF para recuperarla.
--
-- SEGURO PARA LO QUE YA CORRE: las dos son NULLABLE, sin default y sin backfill.
-- Los dos únicos consumidores de esta tabla piden las columnas por nombre
-- (`vista_np_sucursal` y el fetch de `index.html`), así que no se enteran.
-- Rollback: alter table public.lk_pedidos_match drop column fecha_entrega, drop column fecha_entrega_txt;
-- -----------------------------------------------------------------------------
alter table public.lk_pedidos_match add column if not exists fecha_entrega     date;
alter table public.lk_pedidos_match add column if not exists fecha_entrega_txt text;

create index if not exists lk_pedidos_match_entrega_idx on public.lk_pedidos_match (fecha_entrega)
  where fecha_entrega is not null;

create index if not exists lk_pedidos_match_string_idx  on public.lk_pedidos_match (match_string);
create index if not exists lk_pedidos_match_fecha_idx   on public.lk_pedidos_match (fecha_pedido);
create index if not exists lk_pedidos_match_cliente_idx on public.lk_pedidos_match (empresa, cod_cliente, fecha_pedido);

alter table public.lk_pedidos_match enable row level security;

-- La app de Virgilio (anon) solo lee
drop policy if exists lk_pedidos_match_select on public.lk_pedidos_match;
create policy lk_pedidos_match_select on public.lk_pedidos_match
  for select to anon, authenticated using (true);

-- LK escribe vía FDW con lk_ppp_reader (única tabla donde ese rol escribe)
drop policy if exists lk_pedidos_match_writer on public.lk_pedidos_match;
create policy lk_pedidos_match_writer on public.lk_pedidos_match
  for all to lk_ppp_reader using (true) with check (true);

grant usage on schema public to lk_ppp_reader;
grant select, insert, update, delete on public.lk_pedidos_match to lk_ppp_reader;

-- =============================================================================
-- vista_np_sucursal — Resuelve la sucursal de entrega por NP.
-- Cruza PPP_Programacion_Diaria (cod del cliente) con PPP_Base_Pedidos (fecha
-- del pedido) contra lk_pedidos_match. El frontend la usa para mostrar la
-- sucursal en el wizard AP/TAP (Separar) y el método de pago en el monitor.
-- Si un cod+fecha tiene más de una sucursal distinta (ambiguo), devuelve la
-- primera por orden_en_dia.
-- =============================================================================
create or replace view public.vista_np_sucursal as
with np_fecha as (
    select distinct pedido as np, fecha::date as fecha_pedido
    from "PPP_Base_Pedidos"
)
select distinct on (p.np)
    p.np,
    m.sucursal_entrega,
    m.metodo_pago
from "PPP_Programacion_Diaria" p
join np_fecha f on f.np = p.np
join lk_pedidos_match m
    on m.cod_cliente = p.cod
    and m.fecha_pedido = f.fecha_pedido
    and m.empresa = case
        when p.np ~ '^9' then 'lk'
        when p.np ~ '^4' then 'chef'
        else 'lk'
    end
where m.sucursal_entrega is not null
order by p.np, m.orden_en_dia;

grant select on public.vista_np_sucursal to anon, authenticated;
