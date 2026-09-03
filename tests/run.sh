#!/usr/bin/env bash
# Suite de smoke-tests. Correr antes de pushear cambios a index.html / sw.js.
set -e
cd "$(dirname "$0")/.."

echo "== node --check sw.js =="
node --check sw.js

echo "== checkhtml (sintaxis de los <script> inline) =="
node tests/checkhtml.cjs

echo "== version-sync (APP_VERSION == SW_VERSION base — evita PWA cacheando app vieja) =="
node tests/version-sync.cjs

echo "== smoke (Playwright headless) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/smoke.cjs

echo "== ocg-norm (regresión: cruce de códigos del generador de OCs) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ocg-norm.cjs

echo "== stock-cutoff (regresión: stockComputeSaldos con cutoff/asOf, inicial siempre base) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/stock-cutoff.cjs

echo "== stock-idempotent (regresión: stockMove con client_id + ignore-duplicates; reintento no duplica) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/stock-idempotent.cjs

echo "== mon-silencio (regresión: operarios 'en silencio' en vivo — excluye FJ/PC/PB/prueba) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/mon-silencio.cjs

echo "== prod-compute (regresión: motor de Rendimiento — armM3/pickM3/tiempos, exclusión 0/1, factor faltantes) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/prod-compute.cjs

echo "== dead-handlers (regresión: ningún onclick/oninput llama a una función inexistente = botón muerto) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/dead-handlers.cjs

echo "== ap-resume (regresión: 'Seguir armado' retoma sin re-mandar AP) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ap-resume.cjs

echo "== ep-ppp-warn (regresión: EP de tanda fuera del PPP avisa antes de arrancar) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ep-ppp-warn.cjs

echo "== racks-propuesta (regresión: MG 'De los racks' propone para aprobar, no mueve stock) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/racks-propuesta.cjs

echo "== ssg-switch (regresión: switch admin del aviso 'picking sin stock') =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ssg-switch.cjs

echo "== fac-npc (regresión: aviso faltantes en Facturación + consulta NP/Líos) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/fac-npc.cjs

echo "== fac-falta-filter (regresión: chip + filtro 'solo con faltante' en Facturación) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/fac-falta-filter.cjs

echo "== falt-tareas (regresión: pop-up + asignación atómica de faltante que llegó) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/falt-tareas.cjs

echo "== comp-doblearmado (regresión: candado anti doble-armado de tanda) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/comp-doblearmado.cjs

echo "== tanda-lock (regresión: exclusividad picking/armado — no empiezan dos la misma) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/tanda-lock.cjs

echo "== cp-focus (regresion: Cargar las cajas abre el CP enfocado en la NP) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/cp-focus.cjs

echo "== pk-forzar-gondola (regresión: forzar góndola c/ excedente + confirm solo con líos pendientes) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/pk-forzar-gondola.cjs

echo "== dual-ubic-mg-draft (regresión: ubicación Loeke/Chef por NP + MG guarda borrador sin Cerrar) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/dual-ubic-mg-draft.cjs

echo "== mg-reentrada (v7.68: MG ya no es toggle — entrar/salir sin rojo pegado; confirmar emite el evento c/ duración) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/mg-reentrada.cjs

echo "== fac-block-recuperable (regresión v6.21: bloqueo del tilde si el faltante se puede completar) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/fac-block-recuperable.cjs

echo "== mva-quien (regresión v6.66: 👤 siglas + legajo del que hizo/recibió cada movimiento) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/mva-quien.cjs

echo "== emp-np (regresión v6.85 / idea 9020: empresa por NP → sufijo LK/CH en el picking) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/emp-np.cjs

echo "== etl-lio (idea 5290 / v6.89: etiquetas de lío al cerrar cada lío, switch + legajo 0/1) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/etl-lio.cjs

echo "== ins-categorias (idea 7917 / v7.31: navegación + alta por categorías en RI/EI) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ins-categorias.cjs

echo "== ssg-carrera-cron (v7.06: SSG no avisa si el cron ya descontó el picking de la tanda) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ssg-carrera-cron.cjs

echo "== stk-envasar-col (v7.06: la tabla de Stock muestra p/envasar y racks CH) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/stk-envasar-col.cjs

echo "== ssg-familia-empresa (v7.06: SSG suma la familia LK/CH del código partido) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ssg-familia-empresa.cjs

echo "== fgu-faltante-gondola (faltó al pickear pero había stock en góndola → aviso URGENTE Telegram) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/fgu-faltante-gondola.cjs

echo "== act-legajo0 (v7.06: getActivityStatus ignora legajo 0/1 → no tandas fantasma) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/act-legajo0.cjs

echo "== rcp-oc (v7.07: OC vigente en los botones de recepción + evento ROC por exceso +20%) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/rcp-oc.cjs

echo "== rcp-reanudar (v7.12: recepcion a medio cargar sobrevive + boton Seguir recepcion) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/rcp-reanudar.cjs

echo "== anular-sesion (v7.15: botón rojo Anular picking / recepción / insumos) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/anular-sesion.cjs

echo "== ins-admin (idea 5572 / v7.34: Administrar Insumos (pendientes + categorías + unidades + historial + unidad en 0)) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ins-admin.cjs

echo "== ppp-chk-gondola (v7.45: semáforo auto de góndola por pedido/tanda en la PPP) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ppp-chk-gondola.cjs

echo "== comp-pausar (v7.30: botón Pausar del armado — sale sin terminar, retomable) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/comp-pausar.cjs

echo "== pk-racks-aguardar (idea 5703: faltó al pickear pero hay en racks/a guardar → aviso) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/pk-racks-aguardar.cjs

echo "== pk-conteo-ciclico (idea 3798: conteo de góndola de un art de una sola celda) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/pk-conteo-ciclico.cjs

echo "== mon-armado-legajo0 (v7.36: el monitor ignora AP/EP de legajo 0/1 — no 'armado por 0') =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/mon-armado-legajo0.cjs

echo "== stk-ajuste-deps (v7.38: Ajustes ofrece Para envasar y Racks CH en el selector de depósito) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/stk-ajuste-deps.cjs

echo "== oc-print (v7.40: impreso de OC con Cajas / Falta Pedidos / Uni x Caja / % Lleno) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/oc-print.cjs

echo "== ocg-config (v7.51: editor de OC_Maximos (objetivo/uni×caja/índice/proveedor/activo + alta) → sin Excel) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ocg-config.cjs

echo "== ocg-wa (v7.62: enviar OC por WhatsApp al tallerista — matcheo tel + botón) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ocg-wa.cjs

echo "== comp-dif-nofantasma (v7.39: 'picking difiere' no infla góndola fantasma — sólo compensa negativo) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/comp-dif-nofantasma.cjs

echo "== stk-solo-negativos (v7.48: tilde 🔴 Negativos filtra los art con saldo negativo en algún depósito) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/stk-solo-negativos.cjs

echo "== send-prueba-nobloquea (v7.57: un operario real no queda bloqueado por un dueño de prueba 0/1) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/send-prueba-nobloquea.cjs

echo "== ssg-sin-datos (v7.58: el SSG no dispara si no se pudo LEER el stock — evita aviso masivo falso) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ssg-sin-datos.cjs

echo "== comp-entregas-prueba (v7.69: el operador de prueba 0/1 no crea Entregas fantasma que bloqueen el armado) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/comp-entregas-prueba.cjs

echo "== stk-base-split-oculta (v7.71: la tabla de Stock oculta el código base sin stock de una familia LK/CH) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/stk-base-split-oculta.cjs

echo "== comp-terminar-unificado (v7.75: botón 'Terminar' emite TAP + mueve stock — sin TAP/TP sueltos) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/comp-terminar-unificado.cjs

echo "== imp-tabla (v11.70: la tabla de Pedidos Importación no se pisa ni corta la columna Acciones) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/imp-tabla.cjs

echo "== npf-prog-sin-base (v12.05: el módulo Pedidos sin cargar en PPP ve la NP programada sin base) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/npf-prog-sin-base.cjs

echo "== rcp-foto-detalle (v12.07: el visor de foto de Pendientes muestra código→cajas junto a la foto) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/rcp-foto-detalle.cjs

echo "== clock-skew (idea 9782: banner si el reloj del celular está desfasado vs el servidor) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/clock-skew.cjs

echo "== print-station (idea 5044: estación de impresión — seed, poll, dedup, drain, Impresion_NP) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/print-station.cjs

echo "== mg-prioridad (idea 4926: Guardar a Góndola — prioridad con demanda + hint de MCs) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/mg-prioridad.cjs

echo "== incons-motor (idea 9051: computeInconsistencias — motor de alertas del supervisor) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/incons-motor.cjs

echo "== cola-offline (idea 4155: enqueueReport/flushQueue — resiliencia de la cola offline) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/cola-offline.cjs

echo "== auto-bajada (idea 7180: stkAutoBajadaCompute — bajada automática racks a góndola) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/auto-bajada.cjs

echo "== racks-aprobar (idea 4328: racksAprobarBaja — aprobación de bajadas de racks en Recepción) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/racks-aprobar.cjs

echo "== pend-checklist (idea 5267: checklist de Pendientes — completitud, envío y código único) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/pend-checklist.cjs

echo "== ppp-errores (idea 5334: _pppComputeErrors — panel de errores de la PPP) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/ppp-errores.cjs

echo "== abast-compute (idea 9799: abastCompute — cálculo de Abastecimiento vs Venta) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/abast-compute.cjs

echo "== rt-ruteo (idea 3812: _rtOptimize/_rtSplitTrucks/_rtMapsUrls — ruteo de camiones) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/rt-ruteo.cjs

echo "== equiv-resolve (idea 2260: equivResolve/equivLookup — resolución de códigos equivalentes) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/equiv-resolve.cjs
echo "== stk-conteo-fisico (idea 2793: conteo físico de góndola — cálculo, comparación y guardado) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/stk-conteo-fisico.cjs
echo "== cp-gondola-vacia (idea 6497: Completar Pedido avisa cartel+Telegram si retira de góndola en 0) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/cp-gondola-vacia.cjs
echo "== curso-dur-laboral (idea 2865: badge 'en curso' horario-laboral-aware, no reloj de pared) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/curso-dur-laboral.cjs

echo "== cajped-canceladas (v12.22: el pop-up Cajas pedidas descuenta NP canceladas + RS de la base) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/cajped-canceladas.cjs

echo "== fac-excel-isis (Paso 0 idea 3717: Excel de prueba para ISIS — dedup, split 18/15, orden real de ISIS) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/fac-excel-isis.cjs

echo "== rcp-foto-remito-factura (Remito y Factura → 2 fotos, y las 2 en el visor de Pendientes) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/rcp-foto-remito-factura.cjs

echo "== pk-ubic-excedente (la ubicación del excedente se lee: sin sufijo de empresa ni repetidos) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/pk-ubic-excedente.cjs

echo "== mg-horas-pendientes (el operario ve cuántas horas hay para guardar, con el ratio medido) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/mg-horas-pendientes.cjs

echo "== hg-horas-guardado (consulta de horas por depósito y, sobre todo, que NO registre tiempo) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/hg-horas-guardado.cjs

echo "== oc-otros-tallerista (otros artículos del tallerista bajo la OC + ⛽ solo si Falta > 0) =="
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" node tests/oc-otros-tallerista.cjs

# El "TODO OK" va ÚLTIMO: estaba antes de este test y lo imprimía aunque el que seguía
# fallara (set -e corta después, pero el cartel de OK ya salió y engaña al que mira).
echo "== TODO OK =="
