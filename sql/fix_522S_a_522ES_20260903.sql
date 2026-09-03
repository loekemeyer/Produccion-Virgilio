-- =====================================================================
-- 2026-09-03 — Fix del código fantasma 522S (Producción Virgilio)
--
-- QUÉ PASÓ
--   El 23/07/2026 el legajo 104 cargó un ingreso a racks AD2 tipeando
--   "522S". Ese código NO existe en ningún maestro (Importados, Insumos,
--   articulos, Uni_x_Articulo_x_Caja, Importados_Volumen), así que quedó
--   como fila fantasma en la pantalla de Stocks: 80 en RACKS, sin
--   descripción, sin proyección y sin capacidad de góndola.
--
-- EL CÓDIGO REAL ES 522ES — "Sac. Doble Aleta Premium Suelto"
--   Importados: marca LK, proveedor Hugo Wong, FOB 1,15 USD/u, activo.
--   Importados_Volumen: inner = 25 u · master = 100 u  →  4 inner/master
--                       master 38 x 24 x 32 cm = 0,029184 m3
--   (el hermano 522E, el ENCAJADO, es inner 12 / master 120 → 10 inner/master)
--
-- VERIFICACIÓN DE LA CAJA
--   ref del movimiento: "ingreso a racks AD2 (20 master)"
--   20 master x 4 inner = 80 inner  → coincide exacto con el delta 80  ✔ es 522ES
--   20 master x 100 u   = 2000 unidades  ← el valor correcto para el depósito insumos
--   (si hubiera sido 522E, 20 master serían 200 inner, no 80)
--
-- POR QUÉ VA A INSUMOS Y NO A STOCKS
--   Insumos y Movimientos_Stock comparten el espacio de códigos; lo que
--   separa las pantallas es el DEPÓSITO: deposito='insumos' → pestaña
--   Insumos; racks/terminado/... → pestaña Stocks. 522ES es el granel que
--   se envasa y sale como 522E — mismo patrón que 584E, 590E, 437E, 440E.
--   Los insumos importados se llevan en UNIDADES ('Uni'), no en inner/cajas.
-- =====================================================================

-- ---------- BACKUP (estado ANTES, para revertir) ----------------------
-- Importados        id=82  → uni_x_caja era NULL
-- Movimientos_Stock id=12344 → cod_art='522S', deposito='racks', delta=80,
--                    unidad='inner', descripcion=NULL,
--                    ref='ingreso a racks AD2 (20 master)'
-- stocks_carga_rapida cod='522S' → racks=80, stock_total=80 (fila de caché)
-- Insumos           → no existía 522ES

-- ---------- CAMBIOS APLICADOS ----------------------------------------
UPDATE "Importados" SET uni_x_caja = 25, actualizado = now()
 WHERE id = 82 AND cod_art = '522ES';

INSERT INTO "Insumos" (cod, nombre, categoria, ubicacion, creado_por)
VALUES ('522ES', 'Sac. Doble Aleta Premium Suelto', 'importados', 'AD2', 'claude·fix-522S');

UPDATE "Movimientos_Stock"
   SET cod_art     = '522ES',
       deposito    = 'insumos',
       delta       = 2000,               -- 20 master x 100 u/master
       unidad      = 'Uni',
       descripcion = 'Sac. Doble Aleta Premium Suelto',
       ref         = 'ingreso a racks AD2 (20 master x 100 u) — corregido 03/09: era 522S/racks/80 inner'
 WHERE id = 12344;

-- stocks_carga_rapida es un CACHÉ que mantiene actualizar_saldo_trigger, y el
-- trigger solo hace UPSERT del código nuevo: la fila del código viejo queda
-- huérfana y la pantalla la sigue mostrando. Hay que borrarla a mano.
DELETE FROM stocks_carga_rapida WHERE cod = '522S';
UPDATE stocks_carga_rapida
   SET es_insumo = true, descripcion = 'Sac. Doble Aleta Premium Suelto'
 WHERE cod = '522ES';   -- es_insumo alimenta el filtro que saca insumos de la pantalla Stocks

-- ---------- REVERT (si hiciera falta volver atrás) --------------------
-- UPDATE "Importados" SET uni_x_caja = NULL WHERE id = 82;
-- DELETE FROM "Insumos" WHERE cod = '522ES';
-- UPDATE "Movimientos_Stock"
--    SET cod_art='522S', deposito='racks', delta=80, unidad='inner',
--        descripcion=NULL, ref='ingreso a racks AD2 (20 master)'
--  WHERE id = 12344;
-- INSERT INTO stocks_carga_rapida (cod,cod_base,familia_principal,racks,stock_total)
-- VALUES ('522S','522S','522S',80,80);
-- DELETE FROM stocks_carga_rapida WHERE cod = '522ES';

-- ---------- VERIFICACIÓN ---------------------------------------------
-- SELECT 'Movimientos_Stock' t, count(*) n FROM "Movimientos_Stock"    WHERE upper(trim(cod_art))='522S'
-- UNION ALL SELECT 'stocks_carga_rapida',   count(*) FROM stocks_carga_rapida   WHERE upper(trim(cod))='522S'
-- UNION ALL SELECT 'vista_saldos_stock',    count(*) FROM vista_saldos_stock    WHERE upper(trim(cod_art))='522S'
-- UNION ALL SELECT 'vista_stock_procesada', count(*) FROM vista_stock_procesada WHERE upper(trim(cod))='522S';
-- → los 4 en 0. Y 522ES: 2000 Uni en deposito='insumos', fuera de la pantalla Stocks.

-- ---------- DEUDA DETECTADA (NO tocada) -------------------------------
-- actualizar_saldo_trigger llena la columna stocks_carga_rapida.insumos_dep
-- filtrando por deposito='insumos_dep', pero ese depósito NO EXISTE: los
-- depósitos reales son a_facturar, separar_pedidos, terminado, excedente,
-- a_guardar, racks, insumos, para_envasar, racks_ch. Resultado: insumos_dep
-- queda siempre en 0, mientras que stock_total SÍ suma los movimientos de
-- 'insumos' (SUM(delta) sin filtro de depósito) — por eso 522ES muestra
-- stock_total=2000 con todas las columnas de depósito en 0. No afecta la
-- visibilidad en pantalla (el front decide por SECTKEYS, que no incluye
-- insumos), pero stock_total no es confiable para códigos que son insumo.
