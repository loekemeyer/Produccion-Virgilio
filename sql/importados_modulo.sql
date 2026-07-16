-- ============================================================================
-- importados_modulo.sql  (v5.40)
--
-- Módulo "📦 Importados / OC" — réplica del Excel "QUIEBRE de art importados"
-- (motor = hoja "Todos") con stock ROTATIVO event-sourced y Est Madre live.
--
-- ESTADO: YA APLICADO en Supabase (proyecto Control Partes Talleristas,
-- hrxfctzncixxqmpfhskv) vía apply_migration. Este archivo queda como registro
-- reproducible del esquema. El SEED de las 161 filas salió del Excel del dueño
-- (QUIEBRE_de_art_importados.xlsx, hoja "Todos") — ver docs/ para el archivo.
--
-- Motor (por artículo, en UNIDADES):
--   Máximo Determinado = Meses_objetivo (perilla global, def 8) × Est Madre
--   Total Stock        = Stock Actual (ROTATIVO) + Pedido en Curso
--   Genera Pedido      = máx(0, Máximo − Total Stock)
--   Meses de cobertura = Total Stock ÷ Est Madre   (bajo = quiebre)
--   Total FOB          = FOB_uni × (Pedido Manual si se cargó, si no Genera Pedido)
--
-- Est Madre efectiva: override manual > (LK/Loke: proyeccion_madre live de
--   PaginaLK) > seed del Excel. CH usa seed (no hay proyección de Chef aún).
-- FOB por (código, proveedor): multi-proveedor = filas alternas (principal=false).
-- Stock rotativo: inicial/compra/ajuste en Importados_Mov_Stock; las VENTAS se
--   derivan solas del armado real (Entregas) en la vista.
-- ============================================================================

-- 1) Universo mantenido (plano, espeja "Todos"): una fila por (cod, marca, proveedor)
create table if not exists public."Importados" (
  id                 bigint generated always as identity primary key,
  cod_art            text not null,
  marca              text,                 -- LK / Loke / CH
  proveedor          text,
  descripcion        text,
  fob_uni            numeric,              -- USD, por (cod, proveedor)
  uni_x_caja         numeric,              -- para convertir cajas->unidades (armado)
  est_madre_seed     numeric,              -- valor pegado del Excel (referencia, no se pisa)
  est_madre_override numeric,              -- override manual del usuario (gana si se carga)
  pedido_manual      numeric,              -- override de cantidad para costear FOB
  pedido_curso       numeric default 0,    -- unidades en OC abierta (seed Excel; luego Ordenes_Compra)
  principal          boolean default true, -- fila que genera OC / cuenta stock por (cod,marca)
  activo             boolean default true,
  notas              text,
  creado             timestamptz default now(),
  actualizado        timestamptz default now()
);
create index if not exists importados_cod_idx    on public."Importados" (upper(btrim(cod_art)));
create index if not exists importados_marca_idx  on public."Importados" (marca);
create index if not exists importados_activo_idx on public."Importados" (activo);

alter table public."Importados" enable row level security;
drop policy if exists imp_read  on public."Importados";
drop policy if exists imp_write on public."Importados";
create policy imp_read  on public."Importados" for select to authenticated, anon using (true);
create policy imp_write on public."Importados" for all    to authenticated using (true) with check (true);

-- 2) Stock ROTATIVO event-sourced (append-only). Stock Actual = Σ delta_uni por (cod,marca).
--    Ventas automáticas NO se guardan acá: se derivan en la vista desde el armado real.
create table if not exists public."Importados_Mov_Stock" (
  id         bigint generated always as identity primary key,
  ts         timestamptz default now(),
  cod_art    text not null,
  marca      text,                  -- LK / Loke / CH (planta)
  tipo       text not null,         -- 'inicial' | 'compra' | 'ajuste'  (venta = derivada)
  delta_uni  numeric not null,      -- +/- unidades
  ref        text,
  legajo     text,
  creado     timestamptz default now()
);
create index if not exists impmov_cod_idx on public."Importados_Mov_Stock" (upper(btrim(cod_art)), marca);

alter table public."Importados_Mov_Stock" enable row level security;
drop policy if exists impmov_read   on public."Importados_Mov_Stock";
drop policy if exists impmov_insert on public."Importados_Mov_Stock";
create policy impmov_read   on public."Importados_Mov_Stock" for select to authenticated, anon using (true);
-- Insert solo authenticated (acciones de supervisor; no hay flujo anónimo que escriba).
create policy impmov_insert on public."Importados_Mov_Stock" for insert to authenticated with check (true);

-- 3) Config global (fila única): perilla Meses objetivo (I3 del Excel = 8)
create table if not exists public."Importados_Config" (
  id             integer primary key default 1,
  meses_objetivo numeric not null default 8,
  actualizado    timestamptz default now(),
  constraint importados_config_singleton check (id = 1)
);
insert into public."Importados_Config" (id, meses_objetivo) values (1, 8)
  on conflict (id) do nothing;

alter table public."Importados_Config" enable row level security;
drop policy if exists impcfg_read  on public."Importados_Config";
drop policy if exists impcfg_write on public."Importados_Config";
create policy impcfg_read  on public."Importados_Config" for select to authenticated, anon using (true);
create policy impcfg_write on public."Importados_Config" for all    to authenticated using (true) with check (true);

-- 4) Vista motor "Todos": el front sólo LEE de acá.
--    Normalización de código = upper + sin ceros a la izquierda (igual que _ocgNorm del app).
--    SECURITY DEFINER (default): necesita leer "Entregas Tallerista Cervantes",
--    que la anon key NO puede leer directamente.
create or replace view public.v_importados_ordenes as
with cfg as (
  select meses_objetivo from public."Importados_Config" where id = 1
),
mov as (
  select ltrim(upper(btrim(cod_art)),'0') cod_norm,
         case when upper(coalesce(marca,'')) = 'CH' then 'Chef' else 'Loeke' end plant,
         sum(delta_uni)                        as base_uni,
         min(ts) filter (where tipo='inicial') as inicial_ts
  from public."Importados_Mov_Stock"
  group by 1,2
),
arm as (
  select ltrim(upper(btrim(e.cod_art)),'0') cod_norm, 'Loeke'::text plant,
         e.creado ts, coalesce(e.cajas_entregadas,0) cajas
  from public."Entregas_Virgilio" e
  union all
  select ltrim(upper(btrim(e."Cod")),'0') cod_norm, 'Chef'::text plant,
         e.created_at ts, coalesce(e."Cajas",0) cajas
  from public."Entregas Tallerista Cervantes" e
),
ventas as (
  select a.cod_norm, a.plant, sum(a.cajas) as vc
  from arm a
  join mov m on m.cod_norm = a.cod_norm and m.plant = a.plant
  where m.inicial_ts is not null and a.ts >= m.inicial_ts
  group by 1,2
),
proy as (
  select ltrim(upper(btrim(cod)),'0') cod_norm, max(proy_uni_mes) proy_uni_mes
  from public.proyeccion_madre group by 1
)
select
  i.id, i.cod_art, i.marca, i.proveedor, i.descripcion,
  i.fob_uni, i.uni_x_caja, i.principal, i.activo, i.notas,
  i.est_madre_seed, i.est_madre_override, i.pedido_manual,
  coalesce(i.pedido_curso,0)                                   as pedido_curso,
  (case when upper(coalesce(i.marca,''))='CH' then 'Chef' else 'Loeke' end) as planta,
  p.proy_uni_mes                                              as est_madre_live,
  (select meses_objetivo from cfg)                           as meses_objetivo,
  coalesce(
    i.est_madre_override,
    case when upper(coalesce(i.marca,'')) <> 'CH' then p.proy_uni_mes end,
    i.est_madre_seed, 0
  )                                                          as est_madre_eff,
  (case when i.est_madre_override is not null then 'override'
        when upper(coalesce(i.marca,'')) <> 'CH' and p.proy_uni_mes is not null then 'live'
        else 'seed' end)                                     as est_madre_fuente,
  (coalesce(m.base_uni,0) - coalesce(v.vc,0)*coalesce(i.uni_x_caja,0)) as stock_actual
from public."Importados" i
left join mov   m on m.cod_norm = ltrim(upper(btrim(i.cod_art)),'0')
                 and m.plant   = (case when upper(coalesce(i.marca,''))='CH' then 'Chef' else 'Loeke' end)
left join ventas v on v.cod_norm = ltrim(upper(btrim(i.cod_art)),'0')
                  and v.plant   = (case when upper(coalesce(i.marca,''))='CH' then 'Chef' else 'Loeke' end)
left join proy  p on p.cod_norm = ltrim(upper(btrim(i.cod_art)),'0');

grant select on public.v_importados_ordenes to anon, authenticated;

-- 5) uni_x_caja resuelto desde OC_Maximos / proyeccion_madre (los que existan):
update public."Importados" i set uni_x_caja = sub.uxb
from (
  select i2.id,
    coalesce(
      (select ocm.uni_x_caja from "OC_Maximos" ocm
        where ltrim(upper(btrim(ocm.cod)),'0')=ltrim(upper(btrim(i2.cod_art)),'0') and ocm.uni_x_caja>0 limit 1),
      (select pm.uxb from proyeccion_madre pm
        where ltrim(upper(btrim(pm.cod)),'0')=ltrim(upper(btrim(i2.cod_art)),'0') and pm.uxb>0 limit 1)
    ) uxb
  from public."Importados" i2
) sub
where sub.id = i.id and sub.uxb is not null;

-- El SEED de las 161 filas de "Importados" y sus movimientos 'inicial' se cargó
-- desde el Excel del dueño (parseado con openpyxl). No se replica acá por tamaño;
-- si hay que re-sembrar, regenerar desde docs/QUIEBRE_de_art_importados.xlsx.
