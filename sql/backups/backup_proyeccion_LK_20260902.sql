-- =====================================================================
-- BACKUP — definiciones VIVAS de la proyección en el proyecto Supabase LK
-- ("loekemeyer's web", kwkclwhmoygunqmlegrg) — tomado el 2026-09-02
-- antes de tocar la lógica de anomalías (propuesta 2496).
--
-- Restore: correr este archivo tal cual en el SQL editor de LK.
--
-- Las otras dos copias de la fórmula (_fn_proy_window y fn_proyeccion_oc_virgilio)
-- ya están fielmente en sql/fn_proyeccion_oc_virgilio.sql de este repo —
-- verificado idénticas contra pg_proc el 2026-09-02.
--
-- ⚠ refresh_estadistica_madre_cache está DESFASADA del repo LK: el archivo
-- sql/estadistica_madre_cache.sql documenta que reusa fn_proyeccion_madre(),
-- pero lo desplegado tiene la fórmula INLINEADA. Este backup es lo REAL.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.fn_proyeccion_madre()
 RETURNS TABLE(cod text, proy_cajas_mes numeric, uxb integer, proy_uni_mes numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with mm as (
    select max(extract(year from (invoice_date)::date)::int*12 + extract(month from (invoice_date)::date)::int) as endm
    from public.sales_lines where invoice_date ~ '^\d{4}-\d{2}-\d{2}'
  ),
  norm as (
    select regexp_replace(upper(sl.item_code),'^0+(?=.)','') as nitem, sl.customer_code as cust,
           (extract(year from (sl.invoice_date)::date)::int*12 + extract(month from (sl.invoice_date)::date)::int) as midx,
           sl.boxes::numeric as v
    from public.sales_lines sl, mm
    where sl.invoice_date ~ '^\d{4}-\d{2}-\d{2}'
      and sl.customer_code is not null and sl.customer_code not in ('1','3878')
      and (extract(year from (sl.invoice_date)::date)::int*12 + extract(month from (sl.invoice_date)::date)::int) between mm.endm-23 and mm.endm
  ),
  base as (
    select coalesce(r.to_code, nz.nitem) as item, nz.cust, nz.midx, sum(nz.v) as v
    from norm nz
    left join public.sales_item_remap r on r.from_code = nz.nitem
    where not exists (select 1 from public.sales_excluded_items e where e.item_code = nz.nitem)
    group by 1,2,3
  ),
  agg as (
    select item, cust, sum(v) as sumactive, ((select endm from mm) - min(midx) + 1)::numeric as n
    from base group by item, cust
  ),
  mo as (
    select b.item, b.cust, b.v, a.sumactive, a.n, a.sumactive/a.n as rawavg,
      case when lag(b.midx) over (partition by b.item,b.cust order by b.midx) = b.midx-1
           then lag(b.v) over (partition by b.item,b.cust order by b.midx) else 0 end as prev_month_v,
      greatest(
        coalesce(max(b.v) over (partition by b.item,b.cust order by b.midx rows between unbounded preceding and 1 preceding),0),
        coalesce(max(b.v) over (partition by b.item,b.cust order by b.midx rows between 1 following and unbounded following),0)
      ) as max_other
    from base b join agg a on a.item=b.item and a.cust=b.cust
  ),
  disr as (
    select item, cust, sumactive, n,
      sum(case when v > 1.5*rawavg and max_other < 0.8*v and prev_month_v < 0.5*v then v else 0 end) as disruptsum
    from mo group by item, cust, sumactive, n
  ),
  proj as ( select item as c, round(sum((sumactive - disruptsum)/n),2) as proy_cajas from disr group by item )
  select pr.c as cod, pr.proy_cajas as proy_cajas_mes,
         coalesce(p.uxb, lk.uxb)::integer as uxb,
         round(pr.proy_cajas * coalesce(p.uxb, lk.uxb, 1))::numeric as proy_uni_mes
  from proj pr
  left join public.products p on regexp_replace(upper(p.cod),'^0+(?=.)','') = pr.c
  left join public.loke_products lk on regexp_replace(upper(lk.cod),'^0+(?=.)','') = pr.c
  order by pr.proy_cajas desc;
$function$;

-- ============================================================
-- ⚠ Ojo: lleva un hack HARDCODEADO para el artículo 505 (mete ventas de
-- chef aunque p_emp='lk'). Es el parche que alguien puso al ver que el 505
-- daba raro — o sea, el síntoma de este mismo bug.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_proyeccion_madre_emp(p_emp text)
 RETURNS TABLE(cod text, proy_cajas_mes numeric, uxb integer, proy_uni_mes numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
  with mm as (
    select max(extract(year from (invoice_date)::date)::int*12 + extract(month from (invoice_date)::date)::int) as endm
    from public.sales_lines where invoice_date ~ '^\d{4}-\d{2}-\d{2}'
  ),
  norm as (
    select regexp_replace(upper(sl.item_code),'^0+(?=.)','') as nitem, sl.customer_code as cust,
           (extract(year from (sl.invoice_date)::date)::int*12 + extract(month from (sl.invoice_date)::date)::int) as midx,
           sl.boxes::numeric as v
    from public.sales_lines sl, mm
    where sl.invoice_date ~ '^\d{4}-\d{2}-\d{2}'
      and sl.customer_code is not null and sl.customer_code not in ('1','3878')
      and ( sl.empresa = p_emp
            OR (p_emp='lk' AND sl.empresa='chef' AND regexp_replace(upper(sl.item_code),'^0+(?=.)','')='505') )
      and (extract(year from (sl.invoice_date)::date)::int*12 + extract(month from (sl.invoice_date)::date)::int) between mm.endm-23 and mm.endm
  ),
  base as (
    select coalesce(r.to_code, nz.nitem) as item, nz.cust, nz.midx, sum(nz.v) as v
    from norm nz
    left join public.sales_item_remap r on r.from_code = nz.nitem
    where not exists (select 1 from public.sales_excluded_items e where e.item_code = nz.nitem)
    group by 1,2,3
  ),
  agg as (
    select item, cust, sum(v) as sumactive, ((select endm from mm) - min(midx) + 1)::numeric as n
    from base group by item, cust
  ),
  mo as (
    select b.item, b.cust, b.v, a.sumactive, a.n, a.sumactive/a.n as rawavg,
      case when lag(b.midx) over (partition by b.item,b.cust order by b.midx) = b.midx-1
           then lag(b.v) over (partition by b.item,b.cust order by b.midx) else 0 end as prev_month_v,
      greatest(
        coalesce(max(b.v) over (partition by b.item,b.cust order by b.midx rows between unbounded preceding and 1 preceding),0),
        coalesce(max(b.v) over (partition by b.item,b.cust order by b.midx rows between 1 following and unbounded following),0)
      ) as max_other
    from base b join agg a on a.item=b.item and a.cust=b.cust
  ),
  disr as (
    select item, cust, sumactive, n,
      sum(case when v > 1.5*rawavg and max_other < 0.8*v and prev_month_v < 0.5*v then v else 0 end) as disruptsum
    from mo group by item, cust, sumactive, n
  ),
  proj as ( select item as c, round(sum((sumactive - disruptsum)/n),2) as proy_cajas from disr group by item )
  select pr.c as cod, pr.proy_cajas as proy_cajas_mes,
         coalesce(p.uxb, lk.uxb)::integer as uxb,
         round(pr.proy_cajas * coalesce(p.uxb, lk.uxb, 1))::numeric as proy_uni_mes
  from proj pr
  left join public.products p on regexp_replace(upper(p.cod),'^0+(?=.)','') = pr.c
  left join public.loke_products lk on regexp_replace(upper(lk.cod),'^0+(?=.)','') = pr.c
  order by pr.proy_cajas desc;
$function$;

-- ============================================================
-- La que alimenta el panel "Estadística Madre" (cron refresh-estadistica-madre-cache,
-- 03:10 diario). Fórmula INLINEADA — esto es lo REALMENTE desplegado, que difiere
-- de lo que documenta sql/estadistica_madre_cache.sql del repo LK.
-- ============================================================

CREATE OR REPLACE FUNCTION public.refresh_estadistica_madre_cache()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows integer;
begin
  delete from public.estadistica_madre_cache where cod is not null;

  insert into public.estadistica_madre_cache
    (cod, descripcion, familia, uxb, proy_uni_mes, proy_cajas_mes, total_unidades, meses, calculado_at)
  with
  src as (
    select mv.customer_code::text cc, mv.item_code::text ic, mv.ym::text ym, mv.boxes::numeric bx
    from public.mv_loke_sales_agg mv
    union all
    select 'C_' || mv.customer_code::text, mv.item_code::text,
           to_char(mv.invoice_date::date, 'YYYY-MM'), sum(coalesce(mv.boxes, 0))::numeric
    from public.mv_chef_sales_loke mv
    where mv.invoice_date is not null
    group by mv.customer_code, mv.item_code, to_char(mv.invoice_date::date, 'YYYY-MM')
  ),
  prod  as (select upper(trim(cod)) k, max(coalesce(nullif(uxb, 0), 1)) uxb from public.products      group by 1),
  lokep as (select upper(trim(cod)) k, max(coalesce(nullif(uxb, 0), 1)) uxb from public.loke_products group by 1),
  excl  as (select distinct upper(trim(item_code)) k from public.sales_excluded_items),
  rmp   as (select upper(trim(from_code)) k, max(upper(trim(to_code))) v from public.sales_item_remap group by 1),
  x as (select upper(trim(s.ic)) item_up, nullif(trim(s.cc), '') cust, s.ym, s.bx from src s),
  kept as (
    select coalesce(rmp.v, x.item_up) item, x.cust, x.ym,
           x.bx * coalesce(prod.uxb, lokep.uxb, 1) unidades
    from x
    left join prod  on prod.k  = x.item_up
    left join lokep on lokep.k = x.item_up
    left join rmp   on rmp.k   = x.item_up
    where not exists (select 1 from excl e where e.k = x.item_up)
      and x.ym ~ '^\d{4}-\d{2}$'
      and x.bx * coalesce(prod.uxb, lokep.uxb, 1) > 0
      and (x.cust is null or x.cust not in ('1', '3878'))
  ),
  idxd as (
    select ym, row_number() over (order by ym) i
    from (select ym from (select distinct ym from kept) a order by ym desc limit 24) b
  ),
  pc as (
    select k.item, k.cust, d.i, sum(k.unidades) u
    from kept k join idxd d on d.ym = k.ym
    where k.cust is not null
    group by 1, 2, 3
  ),
  agg as (
    select item, cust, min(i) firsti, sum(u) sumactive,
           (select max(i) from idxd) - min(i) + 1 n
    from pc group by 1, 2
  ),
  mo as (
    select pc.item, pc.cust, pc.i, pc.u, a.firsti, a.sumactive, a.n,
           a.sumactive / a.n rawavg,
           case when lag(pc.i) over w = pc.i - 1 then lag(pc.u) over w else 0 end prev_v,
           greatest(
             coalesce(max(pc.u) over (partition by pc.item, pc.cust order by pc.i rows between unbounded preceding and 1 preceding), 0),
             coalesce(max(pc.u) over (partition by pc.item, pc.cust order by pc.i rows between 1 following and unbounded following), 0)
           ) max_other
    from pc join agg a on a.item = pc.item and a.cust = pc.cust
    window w as (partition by pc.item, pc.cust order by pc.i)
  ),
  disr as (
    select item, cust, sumactive, n,
           sum(case when u > 1.5 * rawavg and max_other < 0.8 * u and (i = firsti or prev_v < 0.5 * u)
                    then u else 0 end) dsum
    from mo group by 1, 2, 3, 4
  ),
  proj as (select item, sum((sumactive - dsum) / n) proy from disr group by 1),
  mensual as (select item, ym, sum(unidades) u from kept group by 1, 2),
  meses   as (select item, jsonb_object_agg(ym, u) meses, sum(u) total from mensual group by 1)
  select
    m.item,
    coalesce(p.description, lp.description, m.item),
    coalesce(p.category, case when lp.cod is not null then 'Loke' end, '—'),
    coalesce(pu.uxb, lu.uxb, 1)::integer,
    round(coalesce(pr.proy, 0), 2),
    round(coalesce(pr.proy, 0) / coalesce(pu.uxb, lu.uxb, 1), 2),
    m.total,
    m.meses,
    now()
  from meses m
  left join prod  pu on pu.k = m.item
  left join lokep lu on lu.k = m.item
  left join lateral (select p.description, p.category, p.cod from public.products p
                      where upper(trim(p.cod)) = m.item limit 1) p on true
  left join lateral (select lp.description, lp.cod from public.loke_products lp
                      where upper(trim(lp.cod)) = m.item limit 1) lp on true
  left join proj pr on pr.item = m.item;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;
