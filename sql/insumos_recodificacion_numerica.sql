-- =====================================================================
-- insumos_recodificacion_numerica.sql — recodificación de insumos plásticos
-- de códigos alfabéticos a numéricos (usuario).
--
-- Mapeo:
--   AI (ALTO IMPACTO)          → 1135
--   ABS                        → 2455
--   PE (POLIETILENO)           → 2435
--   PP (POLIPROPILENO)         → 2405
--   PS (POLIESTIRENO)          → 2425
--   NV (NYLON VIRGEN)          → 2475
--   NR (NYLON RECUPERADO)      → 2505
--   N25 (NYLON CON CARGA AL 25) → 2485
--   (nuevo) EVA BRASKEM PN 2021 → 1445
--
-- EBA se deja de momento (no fue mapeado).
--
-- Operaciones:
-- 1. Insertar nuevos códigos en Insumos (si no existen)
-- 2. Renombrar en Movimientos_Stock
-- 3. Renombrar en Insumos
-- 4. Registrar en Insumos_Historial
-- =====================================================================

-- paso 0: guardar el mapeo en una CTE para referencia
with mapeo as (
  select 'AI' as cod_viejo, '1135' as cod_nuevo, 'ALTO IMPACTO' as detalle union all
  select 'ABS', '2455', 'ABS' union all
  select 'PE', '2435', 'PE POLIETILENO (if33)' union all
  select 'PP', '2405', 'POLIPROPILENO (2630)' union all
  select 'PS', '2425', 'PS POLIESTIRENO (h555)' union all
  select 'NV', '2475', 'NYLON VIRGEN' union all
  select 'NR', '2505', 'NYLON RECUPERADO' union all
  select 'N25', '2485', 'NYLON CON CARGA AL 25'
)
select count(*) as verificacion_mapeo from mapeo;

-- paso 1: insertar EVA BRASKEM si no existe
insert into public."Insumos" (cod, nombre, categoria, creado_por)
values ('1445', 'EVA BRASKEM PN 2021', 'plastico', 'sistema·insumos_recodif')
on conflict (cod) do nothing;

-- paso 2: renombrar en Movimientos_Stock y Insumos de forma segura
-- (se hace en una transacción implícita; si algo falla, nada se aplica)

begin;

-- 2a. AI → 1135
update public."Movimientos_Stock" set cod_art = '1135' where cod_art = 'AI' and deposito = 'insumos';
update public."Insumos" set cod = '1135' where cod = 'AI';
insert into public."Insumos_Historial" (accion, cod, cod_nuevo, detalle, legajo)
  values ('recodificar', 'AI', '1135', 'Recodificación numérica (usuario)', 'admin');

-- 2b. ABS → 2455
update public."Movimientos_Stock" set cod_art = '2455' where cod_art = 'ABS' and deposito = 'insumos';
update public."Insumos" set cod = '2455' where cod = 'ABS';
insert into public."Insumos_Historial" (accion, cod, cod_nuevo, detalle, legajo)
  values ('recodificar', 'ABS', '2455', 'Recodificación numérica (usuario)', 'admin');

-- 2c. PE → 2435
update public."Movimientos_Stock" set cod_art = '2435' where cod_art = 'PE' and deposito = 'insumos';
update public."Insumos" set cod = '2435' where cod = 'PE';
insert into public."Insumos_Historial" (accion, cod, cod_nuevo, detalle, legajo)
  values ('recodificar', 'PE', '2435', 'Recodificación numérica (usuario)', 'admin');

-- 2d. PP → 2405
update public."Movimientos_Stock" set cod_art = '2405' where cod_art = 'PP' and deposito = 'insumos';
update public."Insumos" set cod = '2405' where cod = 'PP';
insert into public."Insumos_Historial" (accion, cod, cod_nuevo, detalle, legajo)
  values ('recodificar', 'PP', '2405', 'Recodificación numérica (usuario)', 'admin');

-- 2e. PS → 2425
update public."Movimientos_Stock" set cod_art = '2425' where cod_art = 'PS' and deposito = 'insumos';
update public."Insumos" set cod = '2425' where cod = 'PS';
insert into public."Insumos_Historial" (accion, cod, cod_nuevo, detalle, legajo)
  values ('recodificar', 'PS', '2425', 'Recodificación numérica (usuario)', 'admin');

-- 2f. NV → 2475
update public."Movimientos_Stock" set cod_art = '2475' where cod_art = 'NV' and deposito = 'insumos';
update public."Insumos" set cod = '2475' where cod = 'NV';
insert into public."Insumos_Historial" (accion, cod, cod_nuevo, detalle, legajo)
  values ('recodificar', 'NV', '2475', 'Recodificación numérica (usuario)', 'admin');

-- 2g. NR → 2505
update public."Movimientos_Stock" set cod_art = '2505' where cod_art = 'NR' and deposito = 'insumos';
update public."Insumos" set cod = '2505' where cod = 'NR';
insert into public."Insumos_Historial" (accion, cod, cod_nuevo, detalle, legajo)
  values ('recodificar', 'NR', '2505', 'Recodificación numérica (usuario)', 'admin');

-- 2h. N25 → 2485
update public."Movimientos_Stock" set cod_art = '2485' where cod_art = 'N25' and deposito = 'insumos';
update public."Insumos" set cod = '2485' where cod = 'N25';
insert into public."Insumos_Historial" (accion, cod, cod_nuevo, detalle, legajo)
  values ('recodificar', 'N25', '2485', 'Recodificación numérica (usuario)', 'admin');

commit;

-- paso 3: verificación
select 'Insumos plásticos post-recodificación:' as chequeo;
select cod, nombre from public."Insumos" where categoria = 'plastico' order by cod;

select 'Movimientos stock insumos post-recodificación:' as chequeo;
select cod_art, count(*) as movimientos from public."Movimientos_Stock"
  where deposito = 'insumos' and cod_art in ('1135','2455','2435','2405','2425','2475','2505','2485','1445','EBA')
  group by cod_art order by cod_art;
