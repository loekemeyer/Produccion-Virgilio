-- Planimetria: auto-orden del sector (2026-08-20).
-- Problema: al cargar un código en un sector NUEVO sin nº de orden, quedaba orden=0
-- → se iba al principio del picking (caso 599E / sector J44 / tanda D43B).
-- Solución: trigger BEFORE INSERT/UPDATE que completa `orden` cuando viene en 0/NULL,
-- heredando de vecinos. Respeta el orden si vino explícito (>0).
--
-- Lógica de sugerencia (misma que replica el front en el editor de planimetría):
--   1) Mismo sector exacto  → hereda su orden (misma celda física).
--   2) Vecinos del MISMO pasillo (misma letra inicial), por nombre de sector →
--      interpola entre el anterior y el posterior (o ±1 si hay uno solo).
--   3) Sin pasillo → vecinos globales por nombre de sector.
--   4) Sin nada → max(orden)+1.
-- El orden NO tiene que ser único: es clave de ordenamiento; empata por cod.
-- Backup previo: sql/backup_planimetria_20260820.sql

create or replace function public.planimetria_autoorden()
returns trigger
language plpgsql
as $fn$
declare
  v_val  numeric;
  v_prev numeric;
  v_next numeric;
begin
  if NEW.orden is not null and NEW.orden <> 0 then
    return NEW;  -- respeta el orden explícito
  end if;

  -- 1) Mismo sector exacto → heredar su orden.
  select min(orden) into v_val
    from public."Planimetria"
   where upper(sector) = upper(NEW.sector)
     and cod <> NEW.cod
     and orden is not null and orden <> 0;
  if v_val is not null then
    NEW.orden := v_val;
    return NEW;
  end if;

  -- 2) Vecinos del mismo pasillo (misma letra inicial).
  select max(orden) into v_prev
    from public."Planimetria"
   where left(upper(sector),1) = left(upper(NEW.sector),1)
     and upper(sector) < upper(NEW.sector) and orden is not null and orden <> 0;
  select min(orden) into v_next
    from public."Planimetria"
   where left(upper(sector),1) = left(upper(NEW.sector),1)
     and upper(sector) > upper(NEW.sector) and orden is not null and orden <> 0;

  -- 3) Sin pasillo → vecinos globales.
  if v_prev is null and v_next is null then
    select max(orden) into v_prev from public."Planimetria"
     where upper(sector) < upper(NEW.sector) and orden is not null and orden <> 0;
    select min(orden) into v_next from public."Planimetria"
     where upper(sector) > upper(NEW.sector) and orden is not null and orden <> 0;
  end if;

  if v_prev is not null and v_next is not null then
    NEW.orden := round((v_prev + v_next) / 2.0);
  elsif v_prev is not null then
    NEW.orden := v_prev + 1;
  elsif v_next is not null then
    NEW.orden := greatest(v_next - 1, 1);
  else
    select coalesce(max(orden),0) + 1 into v_val from public."Planimetria";
    NEW.orden := v_val;
  end if;

  return NEW;
end;
$fn$;

drop trigger if exists trg_planimetria_autoorden on public."Planimetria";
create trigger trg_planimetria_autoorden
  before insert or update on public."Planimetria"
  for each row execute function public.planimetria_autoorden();

-- Recalcular las filas existentes sin orden (dispara el trigger).
update public."Planimetria" set orden = null where orden is null or orden = 0;
