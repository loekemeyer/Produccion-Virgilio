# Plan Pedido web directo a Virgilio — Idea 3717

**Idea:** 3717 (propuesta de un empleado, registrada 2026-09-02)
**Fecha:** 2026-09-02 · **plan final**, tras la revisión de tres críticos (operación, datos, técnica: 42 objeciones) y una re-verificación completa contra las dos bases y los dos repos.
**Estado:** documento. **Nada ejecutado**: no hay tablas, ni columnas, ni funciones, ni triggers, ni crons, ni cambios de front. `np_map`, `ppp_config` y `Pedidos_Web` **no existen** en la base (verificado con `to_regclass`).
**Destino del archivo:** `docs/PLAN-PEDIDO-DIRECTO-3717.md` (repo `Produccion-Virgilio`). Anexo de hechos: `docs/PLAN-PEDIDO-DIRECTO-3717.CONTEXTO.md`.

---

## 0. Marco, alcance y cómo leer este plan

### 0.1 Marco fijado por el dueño (2026-09-02)

| # | Regla | Consecuencia en el plan |
|---|---|---|
| a | La PPP de Virgilio **deja de ser espejo** del Excel/Sheet y pasa a nutrirse de los pedidos de la página LK; se programa en Virgilio | §4.4, §4.5, §6.1 |
| b | **No se toca nada con implicancias** hasta terminar la documentación. Lo único autorizado es el botón "descargar Excel" en Facturación | §11 (Paso 0), §7 fase 0 |
| c | Primero documentar, después construir | Este archivo + `GUIA-PROYECTO.md` por fase (§7) |
| d | El despliegue va en una **copia del repo** que convive con el actual hasta que ande | §12 |

**Qué significa (b) en concreto:** el Paso 0 crea **1 RPC y 0 tablas** en Virgilio, el archivo que baja se llama `PRUEBA_NO_IMPORTAR_*`, el botón está oculto tras `?isisTest=1` + mail autorizado, y ninguna fase posterior arranca sin las respuestas de §9.1.

### 0.2 Qué se verificó y qué no

Todo lo marcado **(v)** se corrió contra la base o el archivo el 2026-09-02, sólo lectura. Lo que no se pudo verificar dice **a verificar** y no se usa como premisa de ninguna decisión. Proyectos: Virgilio `hrxfctzncixxqmpfhskv`, LK `kwkclwhmoygunqmlegrg`. El proyecto Chef (`nkhzocgdpwtgrmwleihr`) **no es consultable** desde acá: todo lo de Chef que dependa de él es precondición de la fase 8, no supuesto.

### 0.3 Cambios de diseño respecto del borrador (resumen)

1. Provisoria **numérica de 9 dígitos** y regla de empresa por **primer dígito** desplegada **antes** de la primera provisoria.
2. **Dos estados** `importada` / `facturada`: `Facturacion_NP` se escribe en el tilde de siempre, con la factura real y la NP real. El drenaje de stock **no se mueve** al backend en esta idea.
3. **Editable hasta que tenga tanda**, con Virgilio como autoridad (hoy la ventana es hasta el corte de las 12:30, `script.js:1815`).
4. Export **agregado por `(np, cod_art)`**: sin eso, 28 NP de 768 irían a ISIS al doble.
5. Índice único **parcial** `where origen='web'` (un `UNIQUE(np)` global vaciaría la PPP en el próximo push del Sheet).
6. Push **idempotente por fila** con `delete+insert` / `update`, excepción por pedido, `connect_timeout`, `batch_size` y advisory lock.
7. Filtro del piloto **en los dos lados** (push y Edge Function del mail).
8. `PPP_Entregados_Meta` alimentada desde el tilde como **prerrequisito** del piloto.
9. **Cuarentena** de las filas del Sheet que ya son un tramo web, en vez de rechazar el renombre.
10. **Archivado** de las filas web (`ppp_archivar_web()`), que hoy hace el reemplazo total del Sheet.
11. Export complementario **con identidad propia** (`np_map` parte 91..99).
12. Trigger fns nuevas **`SECURITY DEFINER` + `REVOKE`**, y `np_rename_log` + `deshacer_np_isis()` como backup del renombre.
13. **Correcciones de esta pasada** (no venían de los críticos): el desempate de sucursal por `items_string` estaba mal armado y no habría matcheado nunca (§5, §11.1); el orden del renombre cambia por `trg_corregir_secundario_auto` (§3.5); `Equivalencias_Codigos` no es lo que decía el borrador (§5); el tracking de LK va por NP de ISIS, no por `order_id` (§6.4); `vista_np_faltantes_secuencia` **no** necesita cambio (§3.2); el borrado de filas web necesita una bandera de sesión para convivir con su propio trigger protector (§4.1).

---

## 1. Objetivo y qué cambia

**En cinco líneas.** El pedido web nace en `orders` (LK) y hoy espera hasta 24 h al mail de las 12:30; la operadora lo importa en ISIS, ISIS lo numera, baja dos reportes al Excel PPP, el Apps Script lo empuja a Supabase Virgilio y recién ahí el depósito lo ve. La idea: LK empuja el pedido a Virgilio en minutos, Virgilio lo parte de a 18 líneas como hoy, lo programa, lo pickea y lo arma **sin que ISIS exista todavía**, y cuando está armado la operadora baja desde Facturación un Excel **idéntico al de las 12:30 pero con lo armado** y lo importa en ISIS sólo para facturar. ISIS deja de ser la entrada del circuito y pasa a ser la salida. El único dato que ISIS sigue generando y Virgilio necesita es el **número de NP**, que ahora llega *después* de armar y *antes* de facturar (§3).

### 1.1 Hoy vs propuesto, paso a paso

| # | Paso | Hoy (quién) | Propuesto (quién) | Queda / desaparece |
|---|---|---|---|---|
| 1 | Pedido web | Cliente / admin "Pedir para" / cotizador → `submit_order_fast` + `sheets_payload` (`script.js:7047`, payload en `:7240-7258`) | Igual | Queda |
| 2 | Espera al cron 12:30 (`procesar-pedidos-web`, mediana 12,9 h, p90 22,7 h) | Automático | Push LK→Virgilio cada 5 min (`sync_pedidos_web_virgilio()`) | **Desaparece** la espera |
| 3 | Mail con Excel XML 2003 a ventas@ (`procesar-pedidos-db`) | Automático | Sólo para clientes **fuera del piloto**, con el filtro del piloto **también en la Edge Function** (§6.2); al final se apaga | Desaparece al cutover |
| 4 | Importar Excel en ISIS → ISIS numera la NP | Operadora (mañana) | Se mueve al paso 12 | Se mueve |
| 5 | Bajar 2 reportes de ISIS → Excel "AAA PPP Vigente" → Sheet → Apps Script → `PPP_*` (reemplazo total) | Operadora + Apps Script | `aplicar_pedidos_web()` (cron Virgilio) inserta cabecera + líneas con NP provisoria y `origen='web'` | **Desaparece para lo web**; para KRIKOS Chef, carga directa en ISIS y clientes nuevos (~9 % de las NP, §4.10) **queda hasta la fase 9**: la operadora sigue bajando los dos reportes todos los días mientras exista una NP no web |
| 6 | Partición de ≥18 líneas | Edge Function LK (`processOrders`) | Función SQL en Virgilio, mismo algoritmo (§4.3) | Queda (cambia de lado) |
| 7 | Programar tanda / fecha de entrega / op / observaciones | Operadora en el Excel PPP (`PPP_READONLY = true`, `index.html:28132`) | Operadora en Virgilio, RPC `ppp_programar()` (§4.5) | Cambia de lugar |
| 8 | Picking (EP/TP/PKC) + armado (AP/TAP/TAL) → `Entregas_Virgilio` | Operarios | Igual, sobre la NP provisoria | Queda |
| 9 | Facturación: tilde por NP → `Facturacion_NP` (post-factura) | Operadora administrativa | **Igual**: el tilde sigue siendo post-factura y sigue escribiendo `Facturacion_NP`; para una NP web recién es posible **después** de los pasos 11-12 (§4.7) | Queda |
| 10 | Ajustar a mano en ISIS la NP por lo entregado (51 % de las NP tienen faltante) | Operadora | Desaparece: el Excel ya lleva `cajas_entregadas` | **Desaparece** |
| 11 | Descargar el Excel de NP armadas (checklist en Facturación) | — | Botón en Facturación (**Paso 0**, §11) | Nuevo |
| 12 | Importar en ISIS → NP real → tipear la primera NP del lote en Virgilio → `confirmar_np_isis()` renombra (estado `importada`) → facturar en ISIS → tilde (paso 9) | — | Operadora, **en el mismo turno, antes de cargar el camión** (SLA §3.6) | Nuevo |
| 13 | CCN / remitos / cobranzas / WhatsApp / cruce de facturas | Automático + operadora | Igual, ya con la NP real (la carga de un tramo con provisoria se avisa y se corrige, §3.6) | Queda sin cambios |

---
## 2. Proceso actual verificado (hechos duros)

El detalle completo está en `docs/PLAN-PEDIDO-DIRECTO-3717.CONTEXTO.md`; acá lo que el plan usa como premisa. **(v)** = verificado el 2026-09-02 contra la base o el archivo.

**Entrada del pedido.** `orders.sheets_payload` (jsonb) lo escribe el **navegador** después del RPC, sin `await` (`script.js:7252-7258`) **(v)**. En 90 días: 568 pedidos, 0 sin payload, 0 con payload distinto de `order_items`. `orders` no tiene `updated_at`; `status` es `'pendiente'` en 1.236 de 1.236; **no existe cancelación** de un pedido web. `edit_order_fast` bloquea con `FOR UPDATE` + `RAISE` si `enviado_a_compras_at` no es null. Policies vivas en `orders` **(v)**: `orders_delete_own` (DELETE, `auth.uid() = auth_user_id`, sin mirar sellos), `orders_update_own_sheets` (UPDATE, ídem), `orders_insert_own`/`_v2`, `orders_admin_*`; triggers: sólo `orders_notify_whatsapp` y `trg_fill_order_customer_code` **(v)**. `isOrderEditable` (`script.js:1815-1825`) **(v)** hoy da por editable el pedido mientras `enviado_a_compras_at` sea null **y** no haya pasado el corte de las 12:30 que se lo lleva. Las 7 ediciones (`mode='edit'`) de 90 días ocurrieron entre 1 min y 19 h después del pedido; sólo 2 caen dentro de 5 min.

**Cron LK.** 19 jobs, todos activos **(v)**. `procesar-pedidos-web` `30 15 * * *` UTC (12:30 ART) → `enviar_pedidos_main()` → `postear_envio_pedidos('main',0)` → `net.http_post` con la anon key a la Edge Function **`procesar-pedidos-db`** (v9, `verify_jwt=false`), con log en `envio_pedidos_http_log`; retry `2-59/6 15,16 * * *`, que corta si ya hubo un `ok` ese día y tiene tope de 10 intentos (histórico: `max(intento) = 0`, nunca hizo falta). Log `procesar_pedidos_log`: sólo `company='Lk'`, 124 ok, 21 error (el último el 25/06) y 9 sin pedidos. **Chef no pasa por ahí**: si el proyecto Chef tiene su propio cron o Edge Function, no está en ningún repo ni es consultable desde acá (**a verificar**, precondición de la fase 8).

**Regla 18** (`processOrders`): clave `N° Pedido | Sucursal | Cliente`; con ≥18 líneas se corta en bloques de ≤18 (primero los grandes, después los chicos enteros); `N_Pedido` es un correlativo 1..N del archivo, **no** es la NP. Cuenta ítems del payload, no artículos distintos: por eso hay NP de 19 líneas (98293, 98501) y el máximo de líneas por NP en `PPP_Base_Pedidos` es 19 **(v)**. En 60 días: 413 pedidos, 180 con ≥18 líneas, 643 tramos **(v)**.

**Excel.** XML Spreadsheet 2003; hoja 1 sin encabezado con 12 columnas `fecha, N_Pedido, cliente, vend, articulo, cajas, uni, sucursal, leyenda2, condPago, pctDto, numOC`; hoja 2 "Resumen". Tipo de celda `Number` si `/^-?\d+(\.\d+)?$/` y no empieza con `0` (salvo `0.`), si no `String`; vacío → `<Cell/>`. `numOC` viajó vacío en 1.013 de 1.013 pedidos desde marzo; `pctDto` es fijo `"2% Descuento Web"`. `condPago` viaja como **código** y `sheets_payload.condicion_pago_code` lo trae en el 100 % de los pedidos de 90 días **(v)** (8: 387, 9: 54, 18: 50, 11: 20, 3: 15, 10: 15, 1: 11, 13: 8, 12: 5, 14: 3, 2: 2). `v_pedidos_match` / `lk_pedidos_match` **no** lo llevan: sólo `metodo_pago` como texto libre **(v)**.

**ISIS numera al importar.** Correlativo por empresa (LK 9xxxx, Chef 4xxxx), contiguo y en orden de `N_Pedido` dentro del lote (3 de 3 lotes verificados), intercalado con KRIKOS/COT/manuales entre lotes; 50 huecos en 750 (LK). La `fecha_recep` de la NP es la fecha del pedido web. **ISIS no devuelve la NP** por ningún canal y la factura parseada tampoco la lleva (0 de 415). El reporte "Base Datos Pedidos" trae las cajas que ISIS tiene en el pedido: con 3717, las **entregadas** que llevó el Excel.

**Sheet → Supabase.** Excel VBA → Apps Script `handleCargaPPPSync_` (fuera del repo) → Sheet → `pushPPPToSupabase_` / `_pppSupaReplaceAll_` (`apps-script/sync-ppp-supabase.gs:61` y `:84`) **(v)** → `DELETE ?id=gte.0` (`:90`) + INSERT en lotes de 500 (`:97`) con **service_role**, **dos requests REST sin transacción** y sin retry. El pull server-side (`sync_ppp_base_pedidos()`) **no existe en la base**. Sin `UNIQUE(np)`: hoy 183 filas / 183 NP en Prog, 0 duplicados **(v)**, pero la hoja los puede traer y hoy se toleran con `max()`. El reemplazo total es también la **purga**. `PPP_Programacion_Diaria.observaciones` trae **instrucciones comerciales** que la operadora tipea en ISIS: `FACTURAR EN SEPTIEMBRE`, `11:00Hs`, `PEDIDO EXPO`, `OC 032112` **(v)**.

**Virgilio.** `PPP_READONLY = true` (`index.html:28132`) **(v)**: la app no escribe tanda ni fecha; programa la operadora en el Excel local. Picking y armado leen `PPP_Base_Pedidos` por NP; el armado escribe `Entregas_Virgilio` (`compTerminar`, `index.html:9940`); Facturación (`window.facTickNP`, `:34163`) upserta `Facturacion_NP` — el trigger `validar_np_armada` exige filas en `Entregas_Virgilio` con `cajas_pedidas > 0` **o** `cajas_entregadas > 0` **(v)** — y el front drena stock (`stockSalidaFacturadoNP`, `:22781`). La factura se hace **a mano en ISIS** antes del tilde. El tilde se hace entre las 16 y las 17 h (517 de 768 NP en 60 días); tilde → primer CCN: **p10 = 3,4 h y 51 NP cargadas dentro de las 2 h** sobre 687 pares; sólo **3 NP con CCN antes del tilde** en 60 días **(v)**. El cierre de jornada (`generateFacturacionPDF`, `:34462`; `facBtnCierre`, `:3496`; `Facturacion_Cierres`, `:4144`) y "Armar ruta" (`openRuteo`, `:28022`) leen `Facturacion_NP` con `cierre_id` nulo.

**`Entregas_Virgilio` tiene la misma línea armada dos veces (v).** En 60 días: 71 pares `(np, cod_art)` repetidos en 28 NP, **todas en `Facturacion_NP`**; 60 con cantidades idénticas, 59 con `sum(cajas_entregadas) > cajas_pedidas`, 71 de 71 con `max(cajas_entregadas) ≤ cajas_pedidas`. **Son tres causas distintas, no una:** 13 pares por **re-armado en otra tanda** (98490 en D47C y D54C, 98583 en D50C y D50D); 44 en la **misma tanda** — 37 de ellos creados antes de la migración del 27/08 que puso el trigger de deduplicación, y 7 por **artículo repetido legítimo** en el pedido (98293 con `574x4 + 574x2`); y 14 con una fila de **`tanda` nula** (un lote de correcciones manuales del 10-14/08). `fecha_salida` es **`text`**, no `date` **(v)** — 8.439 `YYYY-MM-DD`, 248 con hora, 23 vacías y 22 nulas en 60 días — pero **el formato no es la causa**: `entregas_virgilio_dedup()` compara `np|tanda|cod_art` más las cajas y **no mira `fecha_salida`** (v). Hoy todo esto es inocuo porque ISIS factura por lo pedido; con 3717 es **bloqueante** para el export (§4.6, §11.1).

**Formatos de código de artículo (v).** `Entregas_Virgilio.cod_art` trae **ceros a la izquierda** (`026`, `035E`) y **nunca** sufijo de empresa: 0 filas con ` LK` o ` CH` en todo el histórico, porque el front escribe el código pelado a propósito y `canon_cod_art_val()` hace `lpad(3)` a los numéricos. `vista_uxb_articulo.cod` guarda **sin** ceros (`26`, `35E`) — es `norm_cod()` — y hay `uxb` decimales (`71 = 4.0`). Sobre los 302 códigos distintos entregados en 30 días, el join por `norm_cod(cod_art)` resuelve 300 y el join directo sólo 282; los dos que faltan son `438EL` y `439EL`. `lk_pedidos_match.items_string` trae los códigos **con** ceros, ordenados por código y con las cajas sumadas (`026x1,027x1,…,404Ex3`) **(v)** — de ahí la corrección del desempate de sucursal (§5, §11.1).

**Triggers que salen de Virgilio con la NP (v).** `trg_virgilio_entrega_to_formato` es **AFTER INSERT** en `Entregas_Virgilio` (clientes 288 Torres y Liva / 2533 OSA, `cajas_entregadas > 0`) → `net.http_post` a la Edge Function LK `virgilio-entrega-sync`; **no dispara en UPDATE**. `trigger_actualizar_saldo_stock` en `Movimientos_Stock` es **AFTER INSERT OR UPDATE sin `OF`**: cualquier UPDATE de `ref` recalcula el saldo (un agregado sobre toda la tabla por cada fila). `trg_corregir_secundario_auto` en `PPP_Base_Pedidos` es **AFTER INSERT OR UPDATE OF `articulo`, `pedido`** **(v)**: el renombre de `pedido` lo dispara e inserta en `Correcciones_Pedido` con la NP nueva (`on conflict do nothing`) — de ahí el orden del renombre (§3.5). `ppp_autozona` es BEFORE INSERT OR UPDATE sin `OF` y además **aprende** barrios nuevos en `Zonas_Barrios`.

**Eventos con la NP embebida en `texto` (60 días, legajos reales) (v):** TAL 941 (`44473|11|C69D|A=067X2,…|LIO`), CCN 695 (`44469|C59A`), CCR 693, AUB 373, CRN 292, CP 184, **FCO 69** (`44518|C99G|802×3|BAZAR…`), NPD 36, FAL 2, FSS 1. FCO (override de facturación) ocurre **antes** del tilde. `Registros_Produccion_Virgilio` **no tiene índice por `texto`** **(v)**: sus índices son `id`, `client_id`, `legajo`, `created_at DESC`, `opcion`, `ts_inicio`, `(opcion, ts_cliente)` y uno parcial de PKC. Por eso el UPDATE del renombre tiene que filtrar por `created_at` y por `opcion`, si no es un seq scan de la tabla entera (§3.5). Ninguno de sus triggers dispara en UPDATE: los dos que lo harían (`trg_pkc_reconciliar_stock`, `trg_tp_reconciliar_stock`) están **deshabilitados** (`tgenabled='D'`) **(v)**. `Movimientos_Stock.ref` en 60 días: 38.338 de depósito (`DNA`, `CNB`, …, sin NP), 5.625 `tanda|NP`, 787 `NP`, 139 `NP|CP` **(v)**.

**Ya existe un puente LK→Virgilio.** FDW `virgilio_db` en LK con el rol `lk_ppp_reader`, que escribe `lk_pedidos_match` (cada 15 min; **563 de 563 corridas ok**, 6,5 s de promedio) y `proyeccion_madre` — **dos** tablas, no una **(v)**. Su ventana móvil se calcula como `max(fecha_pedido) remoto − 14 días`, no `now() − 14`. Opciones del server: `host, port, dbname, sslmode=require`, **sin `connect_timeout` ni `batch_size`** **(v)**. El rol puede ejecutar **238 funciones** de `public` por herencia de `PUBLIC` **(v)**. Virgilio no tiene FDW hacia LK. Chef: server `chef_db` con `chef_orders`, `chef_customers`, `chef_customer_delivery_addresses`, `chef_sales_lines`, sólo SELECT y sin confirmar (el bloque Chef de `sync_pedidos_match_virgilio()` vive dentro de un `exception … raise notice` **(v)**); 50 de las 57 filas chef de `lk_pedidos_match` vienen **sin `sucursal_entrega`**.

**Permisos (v).** `Facturacion_NP` tiene 9 policies y **CRUD abierto a `anon`** (`insert_anon`, `update_anon`, `delete_anon`, `select_anon`, los cuatro `*_auth` y `lk_ppp_reader_sel`). `Entregas_Virgilio` tiene `ent_insert` (INSERT anon + authenticated) y `ent_select`, y **ninguna policy de UPDATE** — por eso el renombre tiene que ser `SECURITY DEFINER`. `PPP_Programacion_Diaria` y `PPP_Base_Pedidos` tienen `ppp_*_write_sup` (ALL para `authenticated`) con los **tres mails hardcodeados** que son los mismos de `SUPERVISOR_EMAILS` (`index.html:35087`). Los default privileges del rol `postgres` dan `arwdDxtm` a `anon` en **toda tabla nueva** **(v)**: una tabla creada sin `REVOKE` nace con CRUD para la anon key. `Registros_Produccion_Virgilio` recibe INSERT del operario con la anon key: cualquier trigger fn nueva sobre esas tablas corre como `anon` salvo que sea `SECURITY DEFINER` (`docs/RIESGO-ESTRUCTURAL-CANON.md`, incidente del 28/08).

**`vista_np_faltantes_secuencia` sí tolera una NP larga (v).** Castea a `bigint` todas las NP numéricas de cinco tablas y busca huecos con `generate_series` entre valores consecutivos, pero **filtra `(siguiente − anterior) between 2 and 6`**, así que un salto de 98684 a 900133601 no genera nada. La prueba está viva: las **20 NP del simulador de 11 dígitos** (`999…`) ya conviven ahí y la vista responde. Una provisoria sólo aparecería como extremo de un hueco si otra provisoria cayera a ≤6 de distancia, cosa que la parte de 2 dígitos hace imposible entre pedidos distintos. **Conclusión: no hace falta tocarla**; lo que sí se toca es `pppFindNpPdf` (mostrar "sin PDF").

**`sync_ppp_entregados_meta()` hace `TRUNCATE`** y parsea el CSV del Sheet "PPP Pedidos Entregados 2026" **(v)**, que se alimenta del Excel PPP local: una NP que no está en ese Excel **nunca** llega a `PPP_Entregados_Meta` (2.761 filas, cron `7,37 * * * *`).

**Crons de Virgilio:** 47 jobs, 46 activos **(v)** — entre ellos `telegram-outbox-flush` (`* * * * *`), `sync-ppp-entregados-meta`, `watchdog-frescura-datos`, `watchdog-syncs-externos`. La firma real del helper de aviso es `tg_enqueue(p_text, p_dedup default null, p_chat default '-1004379879565', p_parse_mode default null)` **(v)**.

**Hallazgos colaterales (no son de esta idea, D16).** (1) `sincronizar_ppp()` de LK falla todos los días **desde el 13/08**, no desde el 26/08: 21 corridas fallidas seguidas, siempre con `relation "public.PPP_Pedidos_Entregados" does not exist` — la foreign table `virgilio.pedidos_entregados` apunta a una tabla que en Virgilio ya no existe. Las `ppp_*` de LK y el dashboard `gv_ppp_*` están congelados desde entonces. (2) El servidor FDW `chef_db` de LK tiene como password el literal `<ELEGÍ_UN_PASSWORD_FUERTE>` **y la conexión funciona** (v), o sea que ese password quedó puesto tal cual: hay que rotarlo. (3) `detectar-pedidos-anomalos` falló 6 veces el 28/08 con `malformed array literal` y la línea que lo causa sigue en el cuerpo. Reportados, no tocados.

---
## 3. La decisión central: identidad de la NP

Hoy la NP existe **antes** de programar. Con 3717 existe **después** de armar. Todo Virgilio cuelga de ese número: `text` en 21 tablas y decenas de vistas, PK en 9 tablas (`Facturacion_NP`, `Impresion_NP`, `NP_Canceladas`, `wa_np_snapshot`, `PPP_Entregados_Meta`, `Correcciones_Pedido(np, cod_secundario)`, …), ~4.270 eventos con la NP embebida en `texto`, `Movimientos_Stock.ref = 'tanda|NP'`, y la **empresa se deduce del número** en unos 20 lugares (`empresaDeNp` `index.html:7370` y `pkNpEsLoeke` `:8034`, ambos `parseInt > 90000`; `empresa_de_np()` con `::bigint > 90000`; `cob_empresa_np()`; `trg_normalizar_empresa_stock`; `vista_faltante_real`; `vista_np_factura`; `vista_np_sucursal`; en LK `sincronizar_ppp` y `gv_ppp_*`).

**Frontera temporal (60 días, v):** casi ningún CCN cae antes del tilde (3 de 687 pares), y 737 de 768 NP tenían un TAL antes del tilde. **Pero la frontera es corta:** el p10 de tilde→CCN es 3,4 h y 51 NP se cargan dentro de las 2 h. Por eso el renombre no puede quedar "para la mañana siguiente": §3.6 fija el SLA, y los 3 CCN previos son justo la razón por la que hace falta el guard, no una nota al pie.

### 3.1 Opciones

| Opción | Qué es | Costo concreto | Veredicto |
|---|---|---|---|
| **A — provisoria renombrada al importar** | Virgilio arma con un identificador provisorio; al importar el Excel, una RPC transaccional lo renombra a la NP de ISIS en todo lo anterior | 1 RPC `confirmar_np_isis()` que toca ≈30 filas por NP: `Entregas_Virgilio.np`, `texto` de `Registros_Produccion_Virgilio` **por expresión regular** (TAL/AUB/NPD/FAL/CP/**FCO**/**PPG** y cualquier opción futura, §3.5), `Etiquetas_Lio`, `Impresion_NP` (PK), `Faltantes_Tareas`, `Correcciones_Pedido` (PK), `Movimientos_Stock.ref`, `wa_np_snapshot` (PK), `envio_programacion_log`, `PPP_*`, `np_map`; todo queda en `np_rename_log` (§3.7). Ningún trigger de `Registros_Produccion_Virgilio` dispara en UPDATE (los dos que podrían están deshabilitados). `Entregas_Virgilio` no tiene policy de UPDATE para anon, así que la RPC es `SECURITY DEFINER`. El papel impreso antes (remito de armado, etiqueta ZPL) queda con la provisoria: se acepta o se reimprime. Lo que **salió** de Virgilio con la provisoria (`pa_entregas` en LK, §3.5) se re-postea | **Recomendada** |
| B — provisoria permanente + `np_isis` aparte | La provisoria queda para siempre y la NP de ISIS es una columna más | Reescribir los ~20 puntos de "empresa por número", `coalesce(np_isis, np)` en unas 10 vistas y 5 funciones que cruzan la frontera del tilde, doble búsqueda en Consultar NP / Cobranzas / Completar pedido, exponer `np_isis` a LK por FDW, doble identidad en pantalla y en papel para siempre | No |
| C — predecir o reservar la numeración de ISIS | Adivinar la NP antes de importar | Inviable como predicción: la base del lote sólo se conoce al importar, la secuencia es compartida con KRIKOS/COT/manuales/anuladas y Chef es otra serie. **Viable como mecanismo de mapeo por lote** (§3.4) | Sólo como mecanismo de A |

### 3.2 Formato de la provisoria y regla de empresa

El borrador proponía `<E> + order_id(6) + parte(1)` (8 dígitos) y afirmaba "cero cambios" en los puntos de empresa-por-número. **Era falso para Chef**: `40013361 > 90000`, así que `empresa_de_np()`, `empresaDeNp` y `pkNpEsLoeke` la clasificarían **LK** (sólo `cob_empresa_np`, `vista_np_sucursal` y `sincronizar_ppp` de LK miran el primer dígito). El picking de los duales 437E/438E/439E/809E de una NP Chef iría a la góndola LK, `pkCodEmpresa` (`index.html:7375`) armaría `437E LK` y `trg_normalizar_empresa_stock` marcaría el drenaje como LK. No hay atajo por longitud: ninguna provisoria con `order_id` de 6 dígitos queda por debajo de 90.000. Por eso **la regla se reescribe en la fase 1**, antes de que exista la primera provisoria:

```
Regla nueva (fase 1, un cambio por punto):  primer dígito '9' → LK ; '4' → CH ; otro → '' / NULL
  empresa_de_np()      : CASE left(digits,1) WHEN '9' THEN 'LK' WHEN '4' THEN 'CH' END
  empresaDeNp (7370)   : d[0] === '9' ? 'LK' : d[0] === '4' ? 'CH' : ''
  pkNpEsLoeke (8034)   : d[0] === '9'
```

**Es equivalente a la regla actual sobre todas las NP existentes (v):** `Facturacion_NP` tiene 987 con primer dígito 9 y 175 con 4, y **0 filas** donde `> 90000` y `left(np,1)='9'` difieran; `PPP_Base_Pedidos` 8.344 / 1.054; las 20 NP del simulador (`999…`) siguen siendo LK. Además `empresa_de_np()` es `IMMUTABLE` pero **ningún índice depende de ella** (v) — su único consumidor SQL es `trg_normalizar_empresa_stock` —, así que cambiar el cuerpo es seguro. El test `tests/emp-np.cjs` (que hoy cubre `98049→LK`, `44519→CH`, basura→`''`, `pkCodEmpresa`, `codBase`, `_compMatchArt`, `_pkItemCodes`, `ocgDemanda`) se amplía con `9xxxxxxxx` y `4xxxxxxxx`. Los otros puntos (`cob_empresa_np`, `vista_np_sucursal`, `left(np,1)` en LK) ya son por primer dígito y no se tocan. `sql/empresa_de_np.sql` se actualiza en el mismo commit.

Formato final, **numérico, con prefijo de empresa, 9 dígitos y parte de 2 dígitos** (así también hay lugar para los complementos de §4.8):

```
NP provisoria = <E> + order_id (6 dígitos, con ceros a la izquierda) + parte (2 dígitos)
  LK   → 9 + 001336 + 01 = 900133601   (9 dígitos; ISIS usa 5: 98684; el simulador 11: 9990…)
  Chef → 4 + 001336 + 01 = 400133601
  parte 01..89 = tramos de la partición de 18 ; 91..99 = exports complementarios (§4.8)
```

- Se distingue de una NP de ISIS por longitud (`^\d{9}$` contra `^\d{5}$`). Hoy **no existe ninguna NP de 9 dígitos** en `Facturacion_NP`, `PPP_Base_Pedidos` ni `PPP_Programacion_Diaria` (v). `order_id` tiene tope 999.999 (hoy 1.336). Partes: el máximo real por pedido es 7 (120 líneas ÷ 18), quedan 89 de margen.
- **Consumidores numéricos:** los tres son menores y ninguno bloquea. `vista_np_faltantes_secuencia` **no necesita cambio** (v): filtra huecos de 2 a 6 y las 20 NP de 11 dígitos del simulador ya conviven ahí. `pppFindNpPdf` (`index.html:26826`) no va a encontrar el PDF de ISIS de una provisoria y debe mostrar "sin PDF". `_pppNpsCompact` (`:27588`) colapsa corridas numéricas en pantalla, es inocuo.
- En pantalla y en papel la provisoria se muestra con el prefijo visual **"NPV "** (riesgo 2).
- `order_id` choca entre los portales LK y Chef, así que el prefijo es obligatorio y además va **columna `empresa` explícita** en las tablas nuevas (§4.1).

### 3.3 Pre-partición determinística (requisito de A)

El renombre sólo es 1:1 si Virgilio **pre-parte** el pedido en tramos de ≤18 líneas con el mismo algoritmo que `processOrders` y trata cada tramo como unidad de programación y de armado (como hoy: 256 de 801 NP tienen 18-19 líneas y hay 198 grupos partidos). Si el armador viera el pedido entero (hasta 120 líneas), una provisoria daría N NP de ISIS y `Entregas_Virgilio` y los TAL no se podrían repartir entre ellas.

### 3.4 Mecanismo de mapeo: "primera NP del lote" + cuarentena del Sheet

Verificado en 3 de 3 lotes: `NP_i = primera_NP + (N_Pedido_i − 1)`. Flujo: la operadora importa el Excel en ISIS, mira la primera NP que ISIS asignó, la tipea en Virgilio (campo del modal de export, §11.4); `confirmar_np_isis(p_export_id, p_np_inicial)` valida que la cantidad de NP generadas coincida con `cant_np` del export y renombra en una transacción. **Un Excel por empresa** (las series de ISIS LK y Chef son distintas, así que hay dos "primera NP").

**Ventana de doble existencia, resuelta con cuarentena y no con rechazo.** Si la operadora importa en ISIS y baja los reportes al Excel PPP **antes** de confirmar en Virgilio (o si `confirmar_np_isis` falla), el push del Sheet trae la NP real `98690` con `origen='sheet'` y `tanda=''`, y el reporte "Base" trae las cajas **entregadas** que llevó el Excel. El borrador hacía que `confirmar_np_isis` rechazara ("ninguna NP resultante debe existir"), lo que dejaba el lote trabado con las dos identidades vivas. Diseño final:

- `ppp_cuarentena_sheet` (BEFORE INSERT, `SECURITY DEFINER`, §6.1): una fila `origen='sheet'` de **Prog** cuya `(cod, fecha_recep)` coincide con un tramo de `np_map` en estado `exportada` (todavía sin `np_isis`) **no entra** a `PPP_Programacion_Diaria`: se guarda en `ppp_cuarentena_sheet` y el trigger devuelve `NULL`. Las filas de **Base** cuyo `pedido` está en cuarentena van a `ppp_cuarentena_sheet_lineas`. Si la NP ya figura en `np_map.np_isis` (post-renombre), devuelve `NULL` directo.
- `confirmar_np_isis` **verifica y absorbe**: compara las líneas en cuarentena `(articulo, cajas)` contra `Facturacion_Export_Lineas` del tramo (son exactamente las que ISIS recibió, así que se espera coincidencia exacta), renombra, borra la cuarentena en la misma transacción y anota `np_map.verificado_sheet_at`. Si hay cuarentena y la operadora todavía no tipeó, el modal **sugiere** la primera NP a partir de ella, con confirmación humana. Si la comparación no coincide, ese tramo no se renombra, sale un aviso por Telegram y queda para revisión.
- Automatizarlo del todo depende de P3 de la integración ISIS (que ISIS devuelva NP ↔ referencia; pregunta H6).

### 3.5 Qué cambia en cada consumidor con la opción A

| Consumidor | Cambio |
|---|---|
| Picking, armado, líos, etiquetas, remito de armado, cola de impresión | Ninguno (trabajan con `np` como texto y la provisoria conserva la empresa por primer dígito, §3.2). Reimpresión opcional post-renombre |
| `Registros_Produccion_Virgilio.texto` (TAL, AUB, NPD, FAL, CP, **FCO**, **PPG** nuevo, y cualquier opción futura) | Renombre por **expresión regular**, no por lista de opciones: `update … set texto = regexp_replace(texto, '(^\|\|)' \|\| np_prov \|\| '(\|\|$)', …)` **acotado por `created_at >= np_map.creado_at` y por `opcion` conocida** — la tabla **no tiene índice por `texto`** (v), así que sin ese filtro el UPDATE es un seq scan completo por cada tramo. El conteo por `opcion` queda en `np_rename_log`. Ídem `Movimientos_Stock.ref` (formatos `tanda\|NP`, `NP`, `NP\|CP`, v) |
| `Movimientos_Stock` → `trigger_actualizar_saldo_stock` | Hoy es `AFTER INSERT OR UPDATE` sin `OF`: el renombre de `ref` recalcularía el saldo por fila (decenas de agregados completos por lote, con locks sobre `stocks_carga_rapida`). Fase 1: `ALTER TRIGGER … AFTER INSERT OR UPDATE OF delta, deposito, cod_art, empresa` (v: `actualizar_saldo_trigger()` sólo lee esas cuatro columnas) |
| **`PPP_Base_Pedidos` → `trg_corregir_secundario_auto`** | **Nuevo respecto del borrador (v).** Es `AFTER INSERT OR UPDATE OF articulo, pedido`, así que renombrar `pedido` lo dispara e inserta en `Correcciones_Pedido` con la NP nueva. Como `Correcciones_Pedido` tiene PK `(np, cod_secundario)`, el orden importa: **primero se renombra `Correcciones_Pedido`, después `PPP_Base_Pedidos`**; el insert del trigger cae en `on conflict do nothing` y no duplica. Si se hiciera al revés, el UPDATE de `Correcciones_Pedido` chocaría con la fila que el trigger acaba de crear |
| `Facturacion_NP` y sus triggers (`validar_np_armada` BEFORE INSERT, `wa_np_facturado_trg` AFTER INSERT, `trg_revertir_drenaje_facturado` AFTER DELETE; `trg_facturado_notif_wa` está **deshabilitado**, v), `Comprobantes_ARCA`, drenaje `ref='tanda\|NP'`, `wa_*`, LK `ppp_facturacion` | Ninguno: se escriben recién con la NP real y con la factura hecha, en el tilde de siempre (§4.7) |
| **`trg_virgilio_entrega_to_formato` → LK `pa_entregas` (OSA 2533 / TyL 288)** | Dispara al armar (AFTER INSERT) con la provisoria y no vuelve a disparar en UPDATE. `confirmar_np_isis` re-postea a `virgilio-entrega-sync` una acción `rename` por `ev_id` afectado (`{ev_id, np_old, np_new}`); la Edge Function de LK actualiza `pa_entregas` por el marcador `[ev:id]`, que ya es idempotente. Los dos clientes tienen pedidos web (2533: 10, 288: 11) y entrarían al piloto, así que es requisito de la fase 6 |
| CCN → CCR/CRN/CRA/FSS, `vista_control_remitos`, ruteo, `Pasaje_Papeles`, cruce de facturas, cobranzas, `PPP_Entregados_Meta`, PDF de ISIS, `bot_tracking_produccion` | Nacen después del tilde (SLA §3.6). Si alguno igual naciera con provisoria, la expresión regular lo renombra; lo que ya salió por WhatsApp o en papel, no |
| `vista_np_faltantes_secuencia` | **Ninguno** (v): su filtro de huecos de 2 a 6 ya absorbe el salto; las NP de 11 dígitos del simulador lo demuestran |
| `pppFindNpPdf` | Una línea: mostrar "sin PDF" para `^\d{9}$` en vez de buscarlo |
| `NP_Canceladas` | Acepta la provisoria (es texto); la cancelación previa al import se resuelve en §4.9 |
| `Alertas_Pedidos_Web`, `lk_pedidos_match`, `vista_np_sucursal` | Dejan de ser necesarias para lo web (`np_map` trae `order_id`, sucursal y condición). Se mantienen durante la transición para las NP `origen='sheet'` |

### 3.6 Frontera operativa y SLA

- **SLA:** para un tramo web, la cadena **tilde de armado → export → import en ISIS → confirmar NP → factura → tilde de facturación** ocurre **en el mismo turno y antes de cargar el camión**. Es lo que hoy ya pasa con la factura (sólo 3 de 687 CCN caen antes del tilde en 60 días); lo nuevo es que la operadora administrativa hace el import y el tipeo en el medio.
- **Guard en la app:** la carga de camión (`CCN`) sobre una NP `^\d{9}$` no se ofrece en la pantalla — y los 3 CCN de 60 días que hoy caen antes del tilde muestran que el caso ocurre, aunque sea raro, que muestra "NPV pendiente de ISIS". **No se usa `RAISE` en un trigger**: un `RAISE` sobre un INSERT del operario con la anon key envenena la cola offline (`enqueueReport`, `index.html:6246`, `QUEUE_KEY` `:6138`, reintenta para siempre) — es el patrón del incidente del 28/08. En su lugar, un trigger AFTER INSERT (`SECURITY DEFINER`) manda un aviso por Telegram si entra un CCN con provisoria, y la expresión regular del renombre lo corrige después.
- **Fines de semana:** un tramo armado el sábado no se exporta hasta el lunes (hoy tampoco se factura ni se carga). El cierre de jornada avisa "N tramos web armados sin ISIS" (§4.7) para que no se olviden.

### 3.7 `np_rename_log` y `deshacer_np_isis()` — el backup del protocolo

`confirmar_np_isis` corre un UPDATE masivo **todos los días** sobre unas ocho tablas, y el protocolo del repo exige backup antes de cada UPDATE; "reversible por `np_map`" sólo valdría si nadie escribiera con la NP real en el medio. Diseño: la RPC escribe, **en la misma transacción**, una fila de `np_rename_log(export_id, np_prov, np_isis, tabla, pk_json, columna, antes, despues, at)` por cada celda tocada; `deshacer_np_isis(p_export_id)` lo recorre al revés y **aborta si una fila ya no tiene el valor `despues`** (alguien escribió encima: se reporta, no se pisa). Ese log **es** el backup exigido por el protocolo; se archiva a los 90 días.

---
## 4. Arquitectura propuesta

### 4.1 Tablas nuevas y columnas (DDL esquemático)

```sql
-- ── Virgilio ───────────────────────────────────────────────────────────────
-- Staging: 1 fila por pedido web, la escribe LK por FDW (rol lk_ppp_reader). Virgilio la consume por cron.
create table "Pedidos_Web" (
  empresa        text not null check (empresa in ('lk','chef')),
  order_id       bigint not null,
  version        int  not null default 1,           -- sube en cada re-push (edición en LK)
  items_hash     text not null,                     -- md5 de los ítems ordenados; detecta cambios
  fecha_pedido   date not null, hora_pedido text,
  cod_cliente    text not null, razon_social text not null,
  vend text, tipo text not null,                    -- WEB | COT | KRIKOS | EXCEL (de sheets_payload.source)
  sucursal_entrega text, direccion text, barrio text,  -- resueltos por LK desde customer_delivery_addresses
  condicion_pago_code text, condicion_pago text,
  leyenda2 text,                                    -- "D x - LC x - PP x" ya armado por LK; dato comercial, no se expone (§4.13)
  num_oc text, observaciones text, cliente_nuevo boolean, due_date date,
  items          jsonb not null,                    -- [{cod_art, cod_original, cajas, uxb}] en el orden del payload
  estado         text not null default 'nuevo'
                 check (estado in ('nuevo','aplicado','reenviado','error','cancelado','rechazado')),
  np_asignadas   text[], aplicado_at timestamptz, error text,
  synced_at      timestamptz not null default now(),
  primary key (empresa, order_id)
);
-- Traza pedido ↔ tramo ↔ NP (fuente de verdad del vínculo; reemplaza el match_string para lo web)
create table np_map (
  empresa text not null, order_id bigint not null,
  parte smallint not null check (parte between 1 and 99),   -- 1..89 tramos, 91..99 complementos (§4.8)
  complemento_de smallint,                          -- parte del tramo original, si es complemento
  np_prov text not null unique,                     -- 900133601
  np_isis text,                                     -- 98690 (null hasta importar)
  export_id uuid, importado_at timestamptz, verificado_sheet_at timestamptz,
  estado text not null default 'a_programar'
         check (estado in ('a_programar','programada','armada','exportada','importada','facturada','cancelada','archivada')),
  no_facturar_hasta date,                           -- "FACTURAR EN SEPTIEMBRE" (§4.5 / §4.12)
  creado_at timestamptz not null default now(), actualizado_at timestamptz,
  primary key (empresa, order_id, parte)
);
create unique index np_map_np_isis_uidx on np_map(np_isis) where np_isis is not null;  -- parcial: varios null conviven
-- Export a ISIS (patrón Facturacion_Cierres ↔ cierre_id)
create table "Facturacion_Export_ISIS" (
  id uuid primary key default gen_random_uuid(), empresa text not null,
  generado_at timestamptz default now(), generado_por text, cant_np int, cant_lineas int,
  np_inicial_isis text, confirmado_at timestamptz, archivo text,
  prueba boolean not null default false,            -- Paso 0 = prueba
  anulado_at timestamptz, anulado_por text          -- re-export: el anterior se anula, no se borra (§4.7)
);
create table "Facturacion_Export_Lineas" (          -- foto exacta de lo que ISIS recibió, ya agregada por (np, cod_art)
  export_id uuid references "Facturacion_Export_ISIS"(id), np text, n_pedido int, n_linea int,
  cod_art text, cajas numeric, uxb numeric, uni numeric,
  primary key (export_id, np, n_linea)
);
-- Log del renombre (backup del protocolo, §3.7) y su inverso
create table np_rename_log (id bigserial primary key, export_id uuid, np_prov text, np_isis text,
  tabla text, pk jsonb, columna text, antes text, despues text, at timestamptz default now());
-- Cuarentena de filas del Sheet que ya son un tramo web (§3.4)
create table ppp_cuarentena_sheet (np text primary key, cod text, fecha_recep text, tanda text, m3 numeric,
  fila jsonb, visto_at timestamptz default now(), np_map_candidato text);
create table ppp_cuarentena_sheet_lineas (np text, articulo text, cajas numeric, cliente text, fecha text);
-- Histórico de filas web archivadas (§4.14)
create table "PPP_Historico_Web" (tabla text, np text, fila jsonb, archivado_at timestamptz default now());
-- Heartbeat del push (LK escribe now() en cada corrida, aunque no haya pedidos)
create table sync_heartbeat (nombre text primary key, ultimo timestamptz not null);
-- Config de programación (dayCap/tandaCap salen de localStorage: protocolo "lógica al backend")
create table ppp_config (clave text primary key, valor jsonb, actualizado_por text, actualizado_at timestamptz default now());

-- Columnas nuevas en tablas existentes (aditivas, con default, sin efecto en el circuito actual)
alter table "PPP_Programacion_Diaria" add column origen text not null default 'sheet',
  add column empresa text, add column order_id bigint, add column parte smallint;
alter table "PPP_Base_Pedidos"    add column origen text not null default 'sheet', add column uxb numeric;
alter table "Facturacion_NP"      add column isis_export_id uuid, add column isis_importada_at timestamptz;
alter table "PPP_Entregados_Meta" add column origen text not null default 'sheet';   -- §4.7 / §6.4
-- Índice único PARCIAL: sólo las filas web. El Sheet sigue pudiendo traer duplicados "fiel a la hoja",
-- que hoy se toleran con max(); un UNIQUE(np) global haría fallar el INSERT de 500 del push y dejaría la PPP vacía.
create unique index ppp_prog_np_web_uidx on "PPP_Programacion_Diaria"(np) where origen = 'web';

-- Vistas de lectura (la pantalla y LK nunca leen las tablas directo)
create view v_pedidos_web_estado as   -- sin leyenda2 ni items (datos comerciales, §4.13)
  select empresa, order_id, version, fecha_pedido, cod_cliente, razon_social, tipo, estado,
         np_asignadas, error, synced_at, aplicado_at from "Pedidos_Web";
create view v_np_map_lk as            -- lo que LK lee por FDW (pull-back, §4.2.4)
  select m.empresa, m.order_id, m.parte, m.np_prov, m.np_isis, m.estado,
         p.tanda, p.fecha_entrega, m.actualizado_at
  from np_map m
  left join "PPP_Programacion_Diaria" p
         on p.np = coalesce(m.np_isis, m.np_prov) and p.origen = 'web';
create view vista_export_isis_diferencias as   -- lo armado menos lo ya exportado, por tramo (§4.8)
  select …;                                    -- Entregas_Virgilio agregada − Σ Facturacion_Export_Lineas del tramo y sus complementos
```

```sql
-- ── LK ─────────────────────────────────────────────────────────────────────
alter table orders add column enviado_a_virgilio_at timestamptz, add column cancelado_at timestamptz,
  add column version_virgilio int not null default 1, add column canal text;   -- canal: 'virgilio' | 'compras'
create table pedidos_web_piloto (cod_cliente text, empresa text not null default 'lk',
  desde timestamptz default now(), nota text, primary key (cod_cliente, empresa));
create table pedidos_web_estado (empresa text, order_id bigint, parte smallint, np_prov text, np_isis text,
  estado text, tanda text, fecha_entrega text, synced_at timestamptz,
  primary key (empresa, order_id, parte));       -- copia local de v_np_map_lk (§4.2.4)
create table pedidos_web_push_log (id bigserial primary key, order_id bigint, empresa text,
  ok boolean, error text, at timestamptz default now());
-- Foreign tables nuevas en el esquema virgilio (el server y el user mapping ya existen)
import foreign schema public limit to ("Pedidos_Web", v_np_map_lk, sync_heartbeat)
  from server virgilio_db into virgilio;
alter server virgilio_db options (add connect_timeout '10', add batch_size '100');
```

**Borrado de filas web y el trigger que las protege.** `ppp_protege_origen_web` (BEFORE DELETE → `RETURN NULL` para `origen='web'`, §6.1) protege contra el reemplazo total del Sheet, pero **tres caminos legítimos sí tienen que borrar**: `aplicar_pedidos_web()` al reprocesar una edición, `cancelar_tramo_web()` y `ppp_archivar_web()`. Se resuelve con una bandera de sesión, no con excepciones por rol: las tres funciones hacen `perform set_config('app.ppp_web_delete','on', true)` (transaccional) y el trigger deja pasar el DELETE sólo si `current_setting('app.ppp_web_delete', true) = 'on'`. El Apps Script y el navegador nunca la setean, así que para ellos el borrado sigue bloqueado.

**Permisos (§4.13 amplía).** `Pedidos_Web` y `sync_heartbeat` → `grant select, insert, update, delete to lk_ppp_reader` + policy `for all to lk_ppp_reader`; y **`revoke all from anon, authenticated`** en el mismo bloque, porque los default privileges del rol `postgres` dan `arwdDxtm` a `anon` en toda tabla nueva (v). `np_map`, `Facturacion_Export_*`, `np_rename_log`, `ppp_cuarentena_*`, `PPP_Historico_Web` y `ppp_config` → **sin policy directa**: se leen por vista o por RPC `SECURITY DEFINER` con chequeo de supervisor por mail (patrón `ppp_prog_write_sup`). `v_np_map_lk` → `grant select to lk_ppp_reader`. **Ningún grant nuevo del rol `lk_ppp_reader` sobre `PPP_*`** (hoy sólo tiene SELECT ahí, y escritura únicamente sobre `lk_pedidos_match` y `proyeccion_madre`).

### 4.2 Transporte LK → Virgilio: push por FDW a una tabla de staging, idempotente por fila

| Opción | Pros | Contras | Veredicto |
|---|---|---|---|
| **(a) LK empuja por FDW a `Pedidos_Web` y un cron de Virgilio aplica** | El server `virgilio_db`, el mapping y el rol **ya existen**; patrón probado dos veces (563 de 563 corridas ok); nada nuevo expuesto a `anon`; Virgilio lee una tabla local (cero FDW en el camino caliente) | Latencia = período del cron; `postgres_fdw` **no hace two-phase commit** (el remoto commitea en el pre-commit local), así que un commit local fallido deja la fila remota sin sello: hay que ser idempotente por fila; el cron de LK no se ve desde Virgilio, de ahí el heartbeat | **Recomendada** |
| (b) Virgilio tira de LK | — | No hay FDW inverso; PostgREST corta en 1000 filas; el pull con la anon key ya congeló `proyeccion_madre` tres semanas; el repo eligió "push" dos veces | No |
| (c) Edge Function en Virgilio llamada por `net.http_post` desde LK | Asíncrono | Dos secretos nuevos; sin transacción entre "marcar" y "escribir"; `pg_net` no reintenta; cinco piezas contra dos | No |
| (d) Trigger en `orders` | Inmediato | El `AFTER INSERT` de `orders` **no tiene los ítems** (el payload lo escribe el navegador después, `script.js:7252`); metería un FDW sincrónico en la transacción del checkout; con Virgilio caído, el checkout falla o el pedido se pierde | No |

**Función LK `sync_pedidos_web_virgilio()`** (`SECURITY DEFINER`, owner `postgres`, misma forma que `sync_pedidos_match_virgilio` pero **por fila**):

1. `if not pg_try_advisory_lock(hashtext('sync_pedidos_web_virgilio')) then return; end if;` — dos corridas no se pisan (pg_cron no impide el solapamiento). `set local statement_timeout = '60s'`. `connect_timeout '10'` en el server para que un Virgilio caído falle en 10 s en vez de apilar jobs.
2. Candidatos: `orders` con `sheets_payload is not null and enviado_a_virgilio_at is null and cancelado_at is null and customer_code in (select cod_cliente from pedidos_web_piloto where empresa='lk')`, con `for update skip locked`. **Consistencia payload/ítems — corregido (v).** El borrador exigía que el `md5` de los ítems del payload coincidiera con el de `order_items` y afirmaba "0 diferencias en 90 días". **Es falso:** 102 de 570 pedidos (18 %) tienen códigos distintos entre los dos lados, porque el front sustituye la variante (el payload dice `580E` y `order_items` apunta al producto `580`) y sólo 25 pedidos guardan `cod_original`. Con la regla del borrador, uno de cada cinco pedidos nunca se empujaría. Lo verificado sí es que **coinciden la cantidad de líneas y las cajas: 0 pedidos de 570 difieren en eso**. Entonces la condición es: el payload existe, tiene un array `items` no vacío, y **la cantidad de líneas y la suma de cajas coinciden con `order_items`**; el `items_hash` que se guarda es el de los ítems del payload y sirve para detectar re-envíos (§4.2.3), no para validar contra `order_items`. Si el payload todavía no está escrito, el pedido espera al ciclo siguiente. Si `enviado_a_compras_at` no es null (ya salió en el mail) **no** se empuja: se marca `canal='compras'` y se sella `enviado_a_virgilio_at` para no volver a mirarlo (ese pedido sigue siendo ISIS-first).
3. Por pedido, dentro de un bloque `begin … exception when others then insert into pedidos_web_push_log(...); continue; end`: resuelve `razon_social` (`customers.business_name`), `direccion` y `barrio` (`customer_delivery_addresses.direccion_entrega` / `zona_expreso` por `customer_id` + `label = sucursal_entrega`; **hoy no hay labels duplicados por cliente y 557 de 570 payloads matchean uno (v)**, así que los 13 restantes se resuelven dejando la dirección vacía y avisando, no adivinando), `leyenda2` (portando `statusFields`), `tipo` desde `source` y `condicion_pago_code`. Después la **idempotencia**: `select estado, items_hash from virgilio."Pedidos_Web" where empresa=… and order_id=…`; si no hay fila → `insert`; si está en `nuevo|error|rechazado` → `delete` + `insert` (fresca); si está `aplicado` con otro `items_hash` → `update set items=…, items_hash=…, version=version+1, estado='reenviado'` (decide Virgilio, §4.3.7); si está `aplicado` con el mismo hash → nada remoto. Recién entonces sella `enviado_a_virgilio_at = now()`, `canal='virgilio'` **y también `enviado_a_compras_at = now()`**, para que el mail de las 12:30 no lo mande aunque el filtro de §6.2 fallara. Un pedido roto no frena a los demás.
   *Nota Postgres:* el bloque `exception` abre una subtransacción por pedido; con `postgres_fdw` eso está soportado (la conexión remota usa savepoints internos), pero implica que un error remoto **no** cierra la conexión ni aborta el resto de la corrida. Verificarlo en el branch antes de la fase 2 es criterio de "listo".
4. **Pull-back de estados (misma conexión):** `delete` + `insert into pedidos_web_estado select … from virgilio.v_np_map_lk where empresa='lk' and order_id in (pedidos de los últimos 14 días)` — mismo patrón de ventana móvil que el match. Alimenta `isOrderEditable` / `edit_order_fast` (§4.9), el tracking de LK (§6.4) y `gv_ppp_*`, sin FDW en ningún camino caliente.
5. Heartbeat: como `sync_heartbeat` es una tabla foránea y `on conflict` no funciona ahí, va `update … ; if not found then insert …; end if`. `pg_advisory_unlock` al final y en el `exception` externo.

Cron LK `*/5`. Chef: mismo patrón por `chef_db` en la fase 8 (§4.11).

**Filtro del piloto en los dos lados.** El sello doble no alcanza: `procesar-pedidos-db` lee `orders?enviado_a_compras_at=is.null` sin saber del piloto, así que (a) un pedido piloto que entra 12:26 puede salir en el mail antes del push de 12:30, y (b) con Virgilio caído a las 12:30 no se selló nada y el mail se lleva todos los piloto, con lo que la NP existiría en ISIS antes de armar **y** habría una provisoria después. Por eso: **`procesar-pedidos-db` v10** agrega el filtro por `customer_code` con la lista de `pedidos_web_piloto` (unas 10 líneas en una Edge Function que igual se apaga al final; si la lista crece, se manda como filtro `not.in.(…)` sólo mientras entre en la URL, y por encima de ~50 códigos se pasa a leer la tabla desde la propia función), y `enviar_pedidos_main()` llama primero a `sync_pedidos_web_virgilio()`. El push, por su lado, respeta `enviado_a_compras_at`. Las tres barreras son independientes y ninguna sola alcanza.

### 4.3 Regla de partición de 18 y validación: en el backend de Virgilio

**`aplicar_pedidos_web()`** (plpgsql, `SECURITY DEFINER SET search_path = public`, owner `postgres`, `REVOKE EXECUTE FROM public, anon, authenticated, lk_ppp_reader`; cron de Virgilio `*/2`, visible en `watchdog_syncs_externos`):

1. Toma `Pedidos_Web` con `estado in ('nuevo','reenviado','cancelado')`, en orden `(empresa, order_id)`.
2. **Valida antes de convertir nada en NP** (el rol `lk_ppp_reader` escribe una tabla que se vuelve picking): `cod_cliente` existe en el padrón de Virgilio — **`clientes_vendedor` (1.245 códigos, v) o una NP histórica en `PPP_Programacion_Diaria`**; cada `cod_art` existe en `Volumen_Articulos` (2.543 filas, v), en `vista_uxb_articulo` o en `Equivalencias_Codigos`; `cajas > 0` y numérico; ≤ 200 líneas; `order_id` dentro de `[max(order_id) aplicado − 500, +500]`; `fecha_pedido ≤ hoy + 1`. Lo que no pasa queda en `estado='error'` con el motivo y un aviso `tg_enqueue(texto, dedup)`. Nada entra a la PPP sin pasar por acá.
3. Parte igual que `processOrders`: con `jsonb_array_length(items) >= 18` corta en bloques de 18 en el orden del payload; con menos, un solo tramo. Cuenta **ítems**, no artículos distintos (fidelidad; consolidar es la pregunta D7). `parte` = 01..N.
4. Por tramo: calcula `np_prov` (§3.2) e inserta en `PPP_Programacion_Diaria` (`np, tanda='', tipo, fecha_recep=fecha_pedido, cod, razon_social, m3, v=vend, direccion, barrio, op='', fecha_entrega='', zona` — la deriva `ppp_autozona` —, `observaciones`, `origen='web'`, `empresa`, `order_id`, `parte`), en `PPP_Base_Pedidos` (`pedido=np_prov`, `articulo` con el mismo `padStart(3,'0') + letras` del Excel, `cajas`, `cliente=razon_social`, `fecha=fecha_pedido`, `origen='web'`, `uxb`) y en `np_map`.
5. `m3` = Σ `cajas × Volumen_Articulos.m3`; los artículos sin m³ se suman como 0 y el tramo queda con `observaciones += 'm3 incompleto'`. Comparar contra ISIS durante el piloto.
6. Marca `estado='aplicado'` y `np_asignadas`. Como corre como `postgres`, ni `corregir_pedido_secundario_auto` ni `zona_canonica()` dan `42501`.
7. **`reenviado` (edición en LK, `version > 1`):** por tramo, si `np_map.estado = 'a_programar'` (sin tanda) **y** no hay eventos EP/TP/AP/TAP/TAL con esa NP, borra y reinserta sus filas `PPP_*` (nueva partición; si cambia la cantidad de tramos, los sobrantes pasan a `cancelada`). Si algún tramo ya tiene tanda o eventos, **no toca nada**: `estado='rechazado'` + Telegram; LK lo ve en `pedidos_web_estado` en ≤5 min y el admin resuelve (§4.9).
8. **`cancelado`:** si ningún tramo tiene tanda ni eventos, borra las filas `PPP_*` y deja `np_map.estado='cancelada'`; si ya hubo picking, escribe `NP_Canceladas` (motivo "Cancelado por el cliente") y avisa por Telegram.

Es idempotente por `(empresa, order_id)`; `np_prov` es UNIQUE en `np_map` y el índice parcial de Prog impide duplicar. Test: la función SQL sobre los pedidos de 60 días tiene que dar exactamente los mismos tramos que `processOrders` (`tests/np-particion.sql`, §7).

---
### 4.4 Cómo aparece en "Pedidos a programar" y en la base

Igual que hoy: **una fila en `PPP_Programacion_Diaria` con `tanda=''` y `fecha_entrega=''`** más sus líneas en `PPP_Base_Pedidos`. Con eso, sin tocar la app, funcionan la solapa "A Programar" (`pppRenderProg`, `index.html:28212`), el aviso "sin programar" de Cajas pedidas (`ocgDemanda`, `:11719`), `vista_np_sin_programar` y `vista_np_prog_sin_base` en 0, y el monitor y el operario la ignoran hasta que tenga tanda (`fetchMonitorFromSupabase`, `:30599`). **No** se replica la `fecha_entrega` tentativa por zona del Excel: hoy las NP sin tanda la traen, quedan como `programmed=true` y la solapa "A Programar" da 0; con `fecha_entrega=''` la solapa vuelve a servir (pregunta D5).

### 4.5 Cómo se programa: en la app, no en el Sheet

`PPP_READONLY=false` en la copia y escritura **por NP y por backend**: RPC **`ppp_programar(p_np, p_tanda, p_fecha_entrega, p_zona, p_observaciones, p_no_facturar_hasta)`** (`SECURITY DEFINER`, chequeo de supervisor por mail igual que `ppp_prog_write_sup`, y **sólo sobre `origen='web'`** mientras el Sheet siga vivo) que actualiza la fila (el trigger deja `op='SI'` cuando hay tanda — hoy `op='SI'` equivale a "tiene tanda", 0 inconsistencias en 183), pasa `np_map.estado='programada'` y registra un evento `PPG` en `Registros_Produccion_Virgilio` (`texto = np|tanda|fecha`) para auditoría. **`observaciones` es editable**: es el único campo donde hoy la operadora anota "FACTURAR EN SEPTIEMBRE", "11:00Hs" o "PEDIDO EXPO"; `no_facturar_hasta` es la versión estructurada y el checklist del export la respeta (§4.7). `pppConfirmarProgramar` (`index.html:26505`) y `_pppScheduleTandas` (`:26452`) hoy escriben `localStorage` (`PPP_EDITS_KEY = "vir_ppp_edits"`, `:26145`): se redirigen a la RPC. El sugeridor (`_pppComputeSugerencia`, `:26354`) y `pppAutoBaseN` (`:26209`) quedan como están. `dayCap` y `tandaCap` (`PPP_CFG_KEY = "vir_ppp_cfg"`, `:26170`) pasan a `ppp_config`.

**Unicidad por NP: índice único parcial `where origen='web'`**, no `UNIQUE(np)` global. El push del Sheet es DELETE + INSERT en dos requests sin transacción y en lotes de 500: un renglón duplicado en el Excel haría fallar el INSERT entero y dejaría la PPP **vacía** hasta el próximo push, sin ningún aviso. Las filas `sheet` siguen deduplicándose con `max()` como hoy.

### 4.6 Botón de Facturación y generación del Excel

La especificación completa está en §11 (Paso 0). Dónde se genera:

| Dónde | Pros | Contras |
|---|---|---|
| **RPC `facturacion_export_isis(p_nps, p_prueba)` que resuelve las 12 columnas, el `N_Pedido` y el corte; el navegador serializa el XML 2003 y dispara el Blob** | La lógica queda en el backend (protocolo del repo); un solo SQL auditable; los mismos bytes que ISIS ya importa (port literal de `generateExcel`, ~60 líneas) | El estado "exportada" lo marca la misma RPC antes de devolver las filas, dentro de la transacción |
| Edge Function en Virgilio | Podría mandar el mail a ventas@ como hoy | Secretos de Gmail nuevos en Virgilio; la operadora **baja el archivo y lo importa**, así que el mail no hace falta |
| Todo en el navegador | Rápido de escribir | Lógica en el front (contra el protocolo), cinco viajes, imposible de auditar |

**Recomendación:** RPC más serialización en el navegador.

**Cómo se agrega `Entregas_Virgilio` (corregido respecto del borrador).** El borrador tomaba `distinct on (np, cod_art) … order by id desc`, o sea la última fila. **Probado sobre NP reales, eso pierde líneas**: en la NP 98293 el pedido tiene `574x4` y `574x2` como dos líneas legítimas y la última fila quedó con 0 entregadas, así que el `where cajas_entregadas > 0` la borraba del Excel y las 2 cajas realmente entregadas no viajaban. Diseño final, en tres pasos:

1. **Tanda vigente** = la del último armado de esa NP (`distinct on (np) … where tanda is not null order by id desc`). Así el re-armado en otra tanda no duplica y las filas de corrección con `tanda` nula (el lote del 10-14/08) no se cuelan.
2. **Suma por `(np, cod_art)` dentro de esa tanda**, no "última fila": `sum(cajas_entregadas) filter (where tanda = vigente)` y lo mismo con las pedidas. El artículo repetido en el pedido queda sumado, que es lo que ISIS tiene que facturar.
3. `cajas = least(sum(entregadas), pedidas)`; ⚠ **re-armada** cuando hay más de una tanda; ⚠ **hay filas sin tanda**; y si el total entregado supera lo pedido, la NP **se muestra pero no se exporta** hasta que un supervisor la destilde o la confirme.

Sin esto, 28 de las 768 NP facturadas en 60 días habrían ido a ISIS al doble. **Salvedad histórica:** los 37 pares idénticos de julio son anteriores al trigger de deduplicación del 27/08, así que sumarlos duplicaría; para exportar NP viejas se toma como referencia `sum(PPP_Base_Pedidos.cajas)` por `(pedido, articulo)` y `cajas = least(sum(entregadas), pedidas_de_base)`. De aquí en adelante el trigger impide el caso. Mail sólo si el dueño lo pide (pregunta D9).

### 4.7 Estados del tramo web: `armada → exportada → importada → facturada`

El borrador convertía el tilde en una cola de export y hacía que `confirmar_np_isis` insertara `Facturacion_NP` con `facturado_at = now()`. Dos objeciones opuestas lo tumbaron: sacar `Facturacion_NP` del tilde deja sin NP web al cierre de jornada, al PDF y a "Armar ruta" (los tres leen `Facturacion_NP` con `cierre_id` nulo); e insertarla al confirmar la NP dispara el aviso de "facturado" por WhatsApp (`wa_np_facturado_trg` → `wa_grupo_completo_check` → `lk_notif-facturado`) y drena `a_facturar` **antes de que exista la factura**. Diseño final: **`Facturacion_NP` se escribe cuando hoy, con la factura real y con la NP real**.

| Estado de `np_map` | Quién lo pone | Qué habilita |
|---|---|---|
| `armada` | Trigger AFTER INSERT en `Entregas_Virgilio` (`SECURITY DEFINER`) cuando la NP web ya tiene filas con `cajas_entregadas > 0`. Un tramo armado **con todo faltante** (0 entregadas) no llega a `armada`: queda listado aparte en el checklist como "armado sin nada que facturar" y se resuelve con `NP_Canceladas` o esperando el completado (§4.8) | Aparece en el checklist "Armadas — pendientes de ISIS" de Facturación (§11.2). **No** escribe `Facturacion_NP` |
| `exportada` | `facturacion_export_isis()` en una transacción: inserta `Facturacion_Export_ISIS` y `Facturacion_Export_Lineas` (la foto agregada de `Entregas_Virgilio`), marca `np_map.export_id` y devuelve las filas. Si el navegador no llega a bajar el archivo, el export igual existe: **se anula con "Descartar export"** (`anulado_at`) y se genera otro; el tramo vuelve a `armada`. Un re-export sin anular el anterior es un botón con confirmación explícita | La operadora importa en ISIS |
| `importada` | `confirmar_np_isis(p_export_id, p_np_inicial)`: renombra (§3.1-A, §3.5, en el orden de §3.5), absorbe la cuarentena (§3.4), escribe `np_rename_log`, re-postea `pa_entregas` (288 / 2533) y sella `importado_at`. **No** inserta `Facturacion_NP`, no drena y no avisa | La NP ya es real: aparece en la lista normal de Facturación como cualquier NP de ISIS y la operadora factura en ISIS |
| `facturada` | **El tilde de siempre** (`window.facTickNP`, `index.html:34163`, post-factura) inserta `Facturacion_NP` con la NP real y el front drena stock como hoy (`stockSalidaFacturadoNP`, `:22781`). Un trigger AFTER INSERT en `Facturacion_NP` (`SECURITY DEFINER`) pasa `np_map` a `facturada`, sella `isis_export_id` e **inserta `PPP_Entregados_Meta` con `origen='web'`** (§6.4) — con `on conflict (np) do update`, porque esa tabla tiene PK `np` | Cierre de jornada, PDF, ruteo, CCN, WhatsApp, ARCA, cobranzas y LK: todo idéntico a hoy |
| `archivada` | Cron nocturno `ppp_archivar_web()` (§4.14) | Sale de `PPP_*` |

Consecuencias: (1) el **drenaje de stock no se mueve** al backend en esta idea — el borrador lo movía a `confirmar_np_isis`, era "el cambio más delicado del módulo" y ya no hace falta; queda como mejora aparte y no bloquea nada; (2) `facRevertir` y `trg_revertir_drenaje_facturado` no necesitan guard nuevo: revertir un tilde web deja la NP real en estado `importada`, igual que hoy una NP destildada; (3) `no_facturar_hasta`, o el texto "FACTURAR EN" en las observaciones, **excluye** la NP del checklist hasta esa fecha, con el aviso visible, así "lo exportado se factura ese día" no choca con la nota comercial; (4) el cierre de jornada avisa "**N tramos web armados sin ISIS**" (estados `armada`, `exportada` e `importada`) para que nada quede olvidado el viernes. Las NP `origen='sheet'` (KRIKOS, COT, manuales) se tildan igual que hoy y no entran al export.

### 4.8 Parciales, faltantes, completar (CP) y reasignar (RC)

- El Excel lleva **`cajas_entregadas`** (decisión del dueño del 25/08 en la idea 5547: factura parcial y los faltantes se pierden), **agregadas por `(np, cod_art)`** (§4.6). Las líneas con `cajas_entregadas = 0` no viajan. El faltante queda en `Entregas_Virgilio.cajas_falto`, así que los reportes de plata perdida siguen saliendo de Virgilio.
- **CP/RC después del export** (hoy 2 NP y 4 cajas en 60 días; RC: 0). El borrador decía "export complementario → nueva NP en ISIS" sin decir dónde vivía esa NP: `np_map` es 1:1 y `Facturacion_NP` tiene PK `np`, así que una segunda NP de ISIS para el mismo tramo no drenaba, no entraba a `wa_*`, cobranzas ni ARCA, y `vista_np_factura` la marcaba ambigua. Diseño final: **el complemento tiene identidad propia** — una fila de `np_map` con `parte` 91..99 y `complemento_de` = la parte original, su propia `np_prov` (`9 + order_id + 91`), sus propias `Facturacion_Export_Lineas` (sólo la diferencia positiva que da `vista_export_isis_diferencias`), su NP de ISIS al confirmar y su fila de `Facturacion_NP` (con el m³ de la diferencia) al tilde. `Entregas_Virgilio` sigue colgada de la NP original; la vista de diferencias mira el tramo y sus complementos juntos.
- **Hasta que exista el complemento (fase 7), CP y RC sobre un tramo `exportada | importada | facturada` se bloquean en la app** (la pantalla consulta `np_map.estado` por vista) y avisan por Telegram. Un RC negativo sobre un donante ya exportado siempre es aviso más ajuste manual en ISIS. Pregunta D8.
- `validar_np_armada` sigue valiendo: sólo se exporta lo que tiene filas en `Entregas_Virgilio`.

### 4.9 Ediciones y cancelaciones del pedido web

- **Edición: "editable hasta que tenga tanda".** Las 7 ediciones reales de 90 días ocurrieron entre 1 min y 19 h después del pedido, así que "editable hasta el push" (≤5 min) bloquearía 5 de 7 sin dejar procedimiento para el resto. Ojo con la comparación: **hoy la ventana no es infinita** — `isOrderEditable` (`script.js:1815-1825`) corta en el cutoff de las 12:30 que se lleva el pedido. La regla nueva **cambia el eje** (de un horario fijo a un hecho del depósito) y en algunos casos amplía: un pedido que tarda tres días en programarse quedaría editable tres días. Si el dueño prefiere conservar un techo, se combina: editable mientras no tenga tanda **y** dentro de las 24 h del pedido (pregunta D4).
  - LK, `isOrderEditable` + `edit_order_fast`: editable si `enviado_a_virgilio_at is null`, **o** si todos sus tramos en `pedidos_web_estado` (copia de ≤5 min, §4.2.4) están en `a_programar`. `edit_order_fast` (que ya hace `FOR UPDATE`) reemplaza `order_items`, pone `enviado_a_virgilio_at = null` y sube `version_virgilio`; el navegador reescribe el payload (la policy `orders_update_own_sheets` con el sello lo permite justo porque el RPC lo des-selló) y el push lo reenvía como `reenviado` cuando el payload y los ítems coinciden (§4.2.3).
  - Virgilio, `aplicar_pedidos_web()` es **la autoridad** (§4.3.7): aplica si el tramo sigue sin tanda ni eventos; si en esos ≤5 min alguien lo programó, queda `rechazado` + Telegram, LK lo ve en el próximo pull-back y el admin resuelve (cancela el tramo en Virgilio y lo recarga, o llama al cliente). No queda ningún caso sin procedimiento.
  - Triggers de blindaje en LK: AFTER UPDATE OF `sheets_payload` en `orders` y AFTER INSERT/DELETE en `order_items` → si `enviado_a_virgilio_at` no es null, lo ponen en null y suben `version_virgilio` (cubren cualquier camino que no pase por `edit_order_fast`).
- **Borrado o reescritura por el cliente después del push:** en la **fase 2**, `alter policy orders_delete_own … using (auth.uid() = auth_user_id and enviado_a_virgilio_at is null)` y lo mismo en `orders_update_own_sheets` (`using` y `with check`). Hoy las dos policies **no miran ningún sello** (v), así que un pedido ya empujado se puede borrar; además existe `rollbackOrder()` en `script.js:6427`, que borra `order_items` y `orders` y hoy **no tiene ningún llamador** — un camino latente que la policy también cierra. Con el cambio, un pedido empujado sólo se toca por RPC.
- **Cancelación:** hoy no existe. Se agrega `orders.cancelado_at` y la RPC `cancelar_pedido(p_order_id, p_motivo)` (el cliente mientras sea editable; el admin siempre); el push manda `estado='cancelado'` (si la fila remota ya está `aplicado`, con `update`); `aplicar_pedidos_web()` hace §4.3.8. Desde Virgilio: botón **"Cancelar tramo"** en la pantalla de `v_pedidos_web_estado` (RPC `cancelar_tramo_web`, supervisor) que borra las filas `PPP_*` del tramo sin eventos y avisa por Telegram al legajo si estaba en curso; con picking hecho, va a `NP_Canceladas`. La cancelación vuelve a LK por el pull-back.
- **Rollback de lo ya empujado:** RPC de LK `rollback_pedidos_web(p_order_ids bigint[])` que en **una** transacción por FDW pone `estado='cancelado'` en `Pedidos_Web`, des-sella `enviado_a_compras_at` y `enviado_a_virgilio_at`, deja `canal=null` y anota en `pedidos_web_push_log`; `aplicar_pedidos_web()` borra los tramos sin eventos y el pedido sale en el próximo mail de las 12:30. Con picking iniciado no hay vuelta atrás: se termina por el camino nuevo. El runbook con la consulta de verificación va en `docs/` (§6.3).

### 4.10 Pedidos que no vienen de la web (fallback)

Cobertura medida **por empresa** (v, detalle en §10): en Programación, LK WEB 141/150 (94 %), COT y KRIKOS 100 %, tipo vacío 0 de 3; Chef WEB 13/15 (86,7 %), COT 100 %, KRIKOS 0 de 3; total 166/183 = 90,7 %. En Base, LK 664/700 (94,9 %) y Chef 72/101 (71,3 %). Lo no cubierto sigue siendo **ISIS-first**: ISIS los numera y entran a Virgilio (i) por el Sheet durante la transición (`origen='sheet'`, §6.1) — o sea que **la operadora sigue bajando los dos reportes todos los días hasta la fase 9** — y (ii) después, por un formulario **"Cargar NP manual"** en la copia: NP real de ISIS, `cod`, fecha y líneas `cod_art + cajas` (pegadas del reporte o tipeadas), con `origen='manual'`; el m³, el `uxb`, la zona y la partición los calcula **la misma función de §4.3** (`aplicar_pedido_manual()` reusa el cuerpo con la NP dada en vez de una provisoria). Lo carga **quien carga en ISIS, en el mismo acto**. Conviven con las web en la misma tanda: cada NP sabe su `origen`.

### 4.11 Chef (prefijo 4)

Fase 8, con **precondiciones explícitas**: (1) inventario de `cron.job` y Edge Functions del proyecto Chef `nkhzocgdpwtgrmwleihr` — si Chef tiene su propio "procesar-pedidos", el filtro del piloto tiene que estar **también ahí**, y hoy no hay nada de Chef en ningún repo; (2) grant en Chef (`update (enviado_a_compras_at, enviado_a_virgilio_at) on orders to loke_reader`, hoy sólo hay SELECT y ni siquiera confirmado), o una tabla de sellos del lado LK; (3) `v_pedidos_match_chef` tiene que traer `sucursal_entrega` y `condicion_pago_code` desde `chef_orders.sheets_payload`. **Causa raíz encontrada (v):** los payloads de Chef vienen en camelCase (`sucursalEntrega`, `condicionPagoCode`, `codCliente`) y la vista lee snake_case, y por eso 50 de 57 filas salen sin sucursal; el arreglo es un `coalesce` de las dos grafías en la vista, no un problema de datos; (4) la regla de empresa por primer dígito ya desplegada (fase 1). Hasta cumplirlas, **Chef queda fuera del piloto en los dos lados**. Después: push con `empresa='chef'`, provisoria `4…`, Excel separado por empresa y una "primera NP" por empresa. KRIKOS Chef entra por el mismo push desde `chef_orders`.

### 4.12 m³, zona, vendedor, tipo y observaciones

| Dato | Fuente | Gap |
|---|---|---|
| m³ | `Volumen_Articulos` (2.543 filas, v) dentro de `aplicar_pedidos_web()` | 11 de 321 artículos pedidos sin m³ → se suma lo que hay y se marca "m3 incompleto"; comparar contra ISIS en el piloto |
| zona | `ppp_autozona` desde `barrio` (= `zona_expreso` de LK); el trigger además **aprende** barrios nuevos | 61 de 138 valores de `zona_expreso` no matchean `Zonas_Barrios` (~10 % de las direcciones): tabla `Zonas_Barrios_Alias` o corregir el padrón de LK. Lo no resuelto cae en el panel de errores |
| v (vendedor) | `sheets_payload.vend` | 10 clientes sin `vend` en LK; se guarda igual para el Excel |
| tipo | `source`: Web→WEB, Cotizador→COT, Krikos→KRIKOS, Excel→EXCEL | `EXCEL` es un valor nuevo para `PPP_Programacion_Diaria.tipo` (hoy WEB/KRIKOS/COT/''): revisar `pppEsSuper` (`index.html:25567`) y las alertas antes de usarlo |
| observaciones | Inicial `coalesce(observaciones, 'OC '||pdf_oc, 'CLIENTE NUEVO - EXPO')`; **editable** por `ppp_programar()` | Hoy lo tipea la operadora en ISIS; en régimen lo escribe en Virgilio y viaja como referencia (H5) |
| no_facturar_hasta | `np_map`, desde `ppp_programar()` | Reemplaza el texto "FACTURAR EN SEPTIEMBRE"; el export lo respeta |
| fecha_entrega | Vacía hasta programar; el `due_date` de Krikos queda como sugerencia | Ver D5 |
| fecha_fc | Se abandona (`Facturacion_NP.facturado_at` la reemplaza) | — |

### 4.13 Seguridad y permisos

- **Toda trigger fn nueva sobre tablas que reciben INSERT con la anon key** (`Entregas_Virgilio`, `Registros_Produccion_Virgilio`, `PPP_*`, `Facturacion_NP`) va **`SECURITY DEFINER SET search_path = public`** con **`REVOKE EXECUTE FROM anon, authenticated`** sobre la **función** (no sobre la tabla). Aplica a `ppp_protege_origen_web`, `ppp_cuarentena_sheet`, `np_map_marcar_armada`, `np_map_marcar_facturada` y `ccn_provisoria_telegram`. Motivo: una función INVOKER que lea `np_map` (sin policy para anon) corriendo como `anon` da `42501` y rompe **todos** los armados y eventos, en silencio si el `.catch` no distingue (incidente del 28/08, `docs/RIESGO-ESTRUCTURAL-CANON.md`). `pppSubir` (`index.html:28424`) escribe con el JWT del supervisor y también pasa por los triggers de `PPP_*`: mismo tratamiento.
- **Checklist de migración (idea 9670)** en cada fase que cree funciones, y **`tests/anon-writes.cjs`** (idea 1817: por cada tabla con policy INSERT para anon, un INSERT de prueba contra el **branch** y su código de respuesta) como criterio de "listo" de las fases 1 y 5. Hoy **no existe** ninguno de los dos archivos (`tests/anon-writes.cjs`, `docs/CHECKLIST-MIGRACIONES.md`): los crea este proyecto.
- **Datos comerciales:** `Pedidos_Web.leyenda2` (deuda, límite, plazo) e `items` no se exponen a ningún rol del navegador. La pantalla de la copia lee `v_pedidos_web_estado` por la RPC `pedidos_web_estado(p_desde)` (`SECURITY DEFINER`, supervisor por mail); `np_map` igual (`np_map_listar()`).
- **Rol `lk_ppp_reader`:** `Pedidos_Web` es la primera tabla que ese rol escribe y que **se convierte en operación**; la defensa es la validación del consumidor (§4.3.2). Aparte, y sin bloquear esta idea: revocar `EXECUTE … FROM PUBLIC` en las `SECURITY DEFINER` sensibles (hoy el rol alcanza 238 funciones por herencia de `PUBLIC`, así que `REVOKE … FROM lk_ppp_reader` solo no sirve) y `ALTER DEFAULT PRIVILEGES … REVOKE`.
- **`Facturacion_NP` con CRUD abierto a `anon`** (9 policies, v): cerrarlo a JWT antes de colgarle `isis_export_id` (colateral, D15).

### 4.14 Archivado: la ventana que hoy impone el Excel

Hoy el reemplazo total del Sheet es también la purga. Con `ppp_protege_origen_web` y sin archivado, cada tramo web quedaría **para siempre** en `PPP_Programacion_Diaria` con tanda y en `PPP_Base_Pedidos`: el monitor y el operario (que arman tandas con toda fila que tenga NP y tanda), `pppRenderProg`, `reconciliar_pipeline_stock`, `vista_np_sucursal`, `cobranzas_valorizar_np` y `wa_np_snapshot_run` listarían cientos de tandas viejas a los tres meses. Cron nocturno **`ppp_archivar_web()`**: para `np_map.estado in ('facturada','cancelada')`, copia las filas `origen='web'` de Prog y Base a `PPP_Historico_Web` (jsonb) y las borra — Prog cuando hay CRN o `facturado_at < now() − 3 días` (replica "la operadora la saca del Excel cuando salió") y Base a los **60 días** de `fecha_pedido` (replica la ventana de la idea 1655; el detalle queda en `Facturacion_Export_Lineas` y `Entregas_Virgilio`); `PPP_Entregados_Meta` web se conserva como el Sheet anual. Después deja `np_map.estado='archivada'`. Usa la bandera de sesión de §4.1 para poder borrar. `confirmar_np_isis` no archiva nada: la NP real sigue viva hasta que sale.

---
## 5. Mapeo de campos del Excel (columna → fuente exacta → gap)

Columnas y tipos según el `generateExcel` real. "Hoy" = Paso 0 sobre NP del circuito actual, sin cambiar nada; "Régimen" = flujo 3717 con `Pedidos_Web` y `np_map`. Cobertura medida sobre las **450 NP facturadas en los últimos 30 días** (sin las `999…`): **385 LK + 65 Chef**. Donde la cobertura difiere por empresa se informa por separado.

| # | Col | Hoy (Paso 0) | Cobertura hoy | Régimen | Gap |
|---|---|---|---|---|---|
| 1 | `fecha` dd/MM/yyyy | `min(PPP_Base_Pedidos.fecha)` de la NP (que es la fecha del pedido web por construcción) | 450/450 | `Pedidos_Web.fecha_pedido` | Ninguno |
| 2 | `N_Pedido` | Correlativo 1..N por NP en el orden del checklist | — | Ídem; 1 tramo = 1 `N_Pedido`; los complementos llevan el suyo | Ninguno |
| 3 | `cliente` | `Facturacion_NP.cod_cliente` | 450/450 | `np_map → Pedidos_Web.cod_cliente` | Ninguno |
| 4 | `vend` | `clientes_vendedor.vend` (1.245 códigos, snapshot manual del 11/08) | 406/450 (90 %) — **LK 381/385 (99 %), Chef 25/65 (38 %)** (v) | `Pedidos_Web.vend` | El hueco es casi todo de Chef; la operadora lo completa en ISIS |
| 5 | `articulo` | `Entregas_Virgilio.cod_art` **agregado por `(np, cod_art)` sobre la tanda vigente** (§4.6) → `padCodArt`. **No hace falta sacar el sufijo de empresa**: hay **0** filas con ` LK` / ` CH` en todo el histórico (v); el regexp queda como defensa | 100 % | Ídem | Va el código **real** armado (437E, no 029). Si ISIS lo tiene en su maestro se prueba con el Paso 0 (H7). Dos correcciones al borrador (v): `Codigos_ISIS_Map` **no sirve** (1.595 filas de rubros Proceso, Materia Prima e Insumos, con `codigo_interno` de 7 dígitos), y el ejemplo `029→437E` **no está en `Equivalencias_Codigos`**: esa tabla tiene 8 filas `cod_pedido → cod_real` y su `cod_real` **trae sufijo de empresa** (`437E→437E LK`, `809E→809E CH`, `727EN→727E`), así que no se vuelca cruda al Excel. El mapa `029→437E`, `574→574E`, `580E→580` vive en **`Equivalencias_Familia`** (18 filas, `cod_secundario → cod_principal`), que es la que usa el picking |
| 6 | `cajas` | `least(sum(cajas_entregadas), cajas_pedidas)` por `(np, cod_art)` **sobre la tanda vigente** (§4.6), si es > 0 | 100 % | Ídem | Hoy el Excel lleva las pedidas; ahora las entregadas (decisión del 25/08). 28 NP de 768 tenían la línea dos veces: sin la agregación irían al doble |
| 7 | `uni` = cajas × uxb | `vista_uxb_articulo.uxb` con `u.cod = norm_cod(e.cod_art)` — **normalizar es obligatorio** (v): `Entregas_Virgilio` guarda `026` y la vista guarda `26`; sobre 302 códigos distintos de 30 días resuelven **300** normalizando y 282 sin normalizar | 5.286/5.288 líneas (faltan `438EL` y `439EL`) | `Pedidos_Web.items[].uxb` | Hay `uxb` decimales (`71 = 4.0`, v): el serializador los emite como `Number` sin romper el tipo de celda |
| 8 | `sucursal` | `lk_pedidos_match.sucursal_entrega` por `cod_cliente` + `empresa` + `fecha_pedido ∈ [fecha−3, fecha]`; **desempate corregido** (ver abajo); ⚠ **siempre que haya más de un pedido del cliente ese día** (22 cliente-día con dos sucursales en 90 días), no sólo cuando `ambiguo` | **LK 370/385 (96 %)** con la ventana `[fecha−3, fecha]` — el borrador decía 380 (v); ampliarla a `[−7,+7]` sólo sube a 373. **Chef 5/65 (8 %)**: 50 de 57 filas chef vienen sin sucursal | `Pedidos_Web.sucursal_entrega` (el label exacto) | Chef **queda fuera del Paso 0**: su Excel no probaría el formato real hasta que `v_pedidos_match_chef` traiga la sucursal |
| 9 | `leyenda2` "D x - LC x - PP x" | **No existe en Virgilio** → vacío | 0 % | `Pedidos_Web.leyenda2` (LK la arma con `statusFields`) | ¿Es obligatoria en ISIS? (H5) |
| 10 | `condPago` (código) | **`lk_pedidos_match.condicion_pago_code`** — columna nueva en `v_pedidos_match` y `lk_pedidos_match` (una columna del lado LK, con la misma sync de 15 min; el código ya viene en `sheets_payload.condicion_pago_code` en el 100 % de los pedidos). **Sin mapa de textos**: `metodo_pago` es texto libre ("Contado" 220 sin tasa, "Prefiero no decidir ahora" 88, "CHECK:10010:S+ 90…", "Echeq 120 dias") y no se mapea a ningún código | Con la columna, ~99 % en LK; sin ella, 0 % | `Pedidos_Web.condicion_pago_code` | Es el único DDL del Paso 0 fuera de la RPC → pregunta D11 |
| 11 | `pctDto` | Fijo "2% Descuento Web" como hoy | — | Ídem; opción vacía para súper con lista propia y para el "Pedir para" del admin | Pregunta D10 |
| 12 | `numOC` | Vacío (como en 1.013 de 1.013 pedidos) | — | `Pedidos_Web.num_oc = coalesce(numOC, pdf_oc)` (los 35 Krikos traen `pdf_oc`) | Mejora gratis |

**Desempate de sucursal — corregido y medido (v).** El borrador desempataba con `position(items_del_tramo in m.items_string) > 0` y **eso no matchea prácticamente nunca**: `items_string` guarda los códigos **con** ceros, ordenados por código y con las cajas sumadas (`026x1,027x1,…`), mientras que el borrador armaba la cadena del tramo con `ltrim` y ordenada por otro criterio, así que comparaba `31x1,35Ex1,…` contra `031x1,035Ex1,…`. Además, aunque los formatos coincidieran, "Cambiar código" (574→574E, 580E→580) rompe la igualdad exacta.

Diseño final: **score por conjunto de códigos**. Se toman los códigos distintos del tramo (tal cual vienen de `Entregas_Virgilio`, con ceros), se los cuenta contra los códigos del `items_string` del candidato (sacándole las cantidades) y el score es la fracción que coincide; gana el score más alto y `orden_en_dia` desempata. Sale ⚠ si el score baja de 0,9, si `ambiguo`, o si hay **dos sucursales distintas empatadas en el máximo**. Medido sobre las 365 NP LK con candidato: la fórmula del borrador daba coincidencia en 208 y resolvía 10 de los 29 casos con más de un candidato de sucursal distinta; **el score da 355 NP con score ≥ 0,9 (314 exactas) y resuelve 39 de 48**, dejando 18 marcadas como dudosas. Casos probados: la NP 98611 pasa de elegir el pedido equivocado (4 de 18 códigos) a elegir el correcto (18 de 18); la 98596, con dos sucursales del mismo cliente el mismo día, deja de resolverse por empate arbitrario.

Cabecera de la PPP (`PPP_Programacion_Diaria` ← `Pedidos_Web`): `np`←`np_prov`, `tipo`←`tipo`, `fecha_recep`←`fecha_pedido`, `cod`←`cod_cliente`, `razon_social`←`razon_social` (= `customers.business_name`, verificado idéntico en 9 NP), `m3`←calculado, `v`←`vend`, `direccion`←`customer_delivery_addresses.direccion_entrega`, `barrio`←`zona_expreso`, `zona`←trigger, `observaciones`←§4.12; `tanda`, `op`, `fecha_entrega` y `fecha_fc` vacíos.

---

## 6. Convivencia con el circuito viejo, cutover y rollback

### 6.1 Coexistencia por NP con `origen`, sin tocar el Apps Script

El choque real es el **reemplazo total** de `PPP_*` por el push del Sheet (`_pppSupaReplaceAll_`, `apps-script/sync-ppp-supabase.gs:84`: `DELETE ?id=gte.0` + INSERT de a 500). Dos triggers en Virgilio lo neutralizan **sin modificar "Carga PPP.gs"** (que está fuera del repo). Los dos son **`SECURITY DEFINER` + `REVOKE EXECUTE` a anon y authenticated** (§4.13): el Apps Script escribe con service_role, pero `pppSubir` escribe con el JWT del supervisor, y una función INVOKER que toque `np_map` o las tablas de cuarentena desde `authenticated` daría `42501` y tumbaría el `pppSubir` entero.

- `ppp_protege_origen_web` BEFORE DELETE en `PPP_Programacion_Diaria` y `PPP_Base_Pedidos`: `IF old.origen = 'web' AND coalesce(current_setting('app.ppp_web_delete', true),'') <> 'on' THEN RETURN NULL` (§4.1). El push del Sheet sigue borrando y reinsertando lo suyo.
- `ppp_cuarentena_sheet` BEFORE INSERT (§3.4): si `new.origen = 'sheet'` y la NP ya está en `np_map.np_isis`, devuelve `NULL`; si `(cod, fecha_recep)` coincide con un tramo `exportada` sin `np_isis`, va a cuarentena y devuelve `NULL`; las líneas de Base cuyo `pedido` está en cuarentena, ídem.
- **No** se agrega un trigger que rechace NP `sheet` duplicadas: el índice único es parcial (§4.5) y las filas `sheet` siguen tolerándose con `max()` como hoy. Agregar comportamiento al camino del Sheet es justo lo que se quiere evitar.

Resultado: el Sheet sigue alimentando las NP no web y `PPP_Entregados_Meta` de las `sheet`; las web viven en Virgilio. El día que el Sheet deje de usarse, los triggers quedan inertes.

### 6.2 Cutover gradual por cliente, con el filtro en los dos lados

El corte real está del lado LK: un pedido no puede ir **a la vez** al mail de las 12:30 y al push. `pedidos_web_piloto(cod_cliente, empresa)` es la única lista y la leen **tres** piezas: `sync_pedidos_web_virgilio()` (sólo empuja piloto y sella los dos campos), **`procesar-pedidos-db` v10** (excluye a los piloto, así ni la carrera de las 12:26 ni un Virgilio caído a las 12:30 mandan un piloto al mail) y `enviar_pedidos_main()` (que corre el push antes de postear). Chef: hasta cumplir §4.11, fuera del piloto **también del lado que manda su mail**. Etapas: 2-3 clientes LK de pocas líneas → clientes grandes con partición → todos LK → Chef. El mail de las 12:30 sigue saliendo para el resto y se apaga cuando la lista es "todos" y pasan N semanas sin incidentes.

### 6.3 Rollback

- **Por pedido ya empujado:** `rollback_pedidos_web(p_order_ids)` en LK (§4.9): una transacción por FDW, des-sella, cancela en `Pedidos_Web` y deja log; `aplicar_pedidos_web()` borra los tramos sin eventos y el pedido sale en el próximo mail. Verificación: `select id, enviado_a_compras_at, enviado_a_virgilio_at, canal from orders where id = any(…)` en LK y `select * from v_pedidos_web_estado where order_id = any(…)` en Virgilio (tiene que decir `cancelado`). Con picking iniciado se termina por el camino nuevo.
- **Por cliente:** sacarlo del piloto (lo leen las tres piezas) más el rollback de sus pedidos sin eventos.
- **Total:** `update cron.job set active=false where jobname='sync-pedidos-web-virgilio'` en LK, `pedidos_web_piloto` vacía y `aplicar_pedidos_web` desactivada. Como LK no tiene Telegram, la confirmación de que el cron está apagado es que `sync_heartbeat.ultimo` **deja de avanzar** en Virgilio (el watchdog lo avisa al revés: heartbeat viejo = push apagado). El Sheet nunca dejó de empujar y nada del circuito viejo se desmonta hasta el final.
- Backups antes de cada DDL (protocolo del repo): `PPP_Programacion_Diaria`, `PPP_Base_Pedidos`, `Facturacion_NP`, `Entregas_Virgilio`, `PPP_Entregados_Meta` y `Movimientos_Stock` (por el `ALTER TRIGGER`). El renombre diario tiene su propio backup: `np_rename_log` (§3.7).

### 6.4 Qué pasa con cada pieza del circuito viejo

| Pieza | Transición | Final |
|---|---|---|
| Sheet PPP + Excel "AAA PPP Vigente" + push del Apps Script | Sigue para las NP no web: la operadora baja los dos reportes todos los días hasta la fase 9 | Se apaga cuando exista "Cargar NP manual" (§4.10) |
| **Tracking WhatsApp al cliente y solapa Tracking del admin de LK** | El hueco empieza en la **fase 6**, no al final: un pedido piloto no está en el Excel PPP, así que el cliente dejaría de recibir los avisos desde el primer día. **Verificado (v):** `order_tracking` tiene 950 filas y su `np_number` es el **`orders.id`** en 942 de ellas (ninguna de 5 dígitos), que es como lo busca el front (`script.js:1633`); los estados vivos son `entregado` 798, `programado` 92 y `recibido` 60. Ojo con el parser: `parseTrackingSheet` (`admin.js:2413`) emite además `a_programar`, `enviado` y `retirado`, pero **ninguna fila viva los tiene**, así que el escritor real es la RPC **`sync_order_tracking_from_sheet`** (v), que se alimenta del mismo Sheet PPP y hace upsert más borrado de lo que no viene; el WhatsApp lo dispara el trigger `order_tracking_wa_notify` sobre esa tabla. Diseño: el mismo cron del push (§4.2.4) escribe `order_tracking` con `np_number = order_id` y los estados que el front ya entiende — `programada` → `programado`, `facturada` → `entregado` —, **sin pasar por `sync_order_tracking_from_sheet`** (que sigue para lo no web) y dejando que el trigger de WhatsApp dispare igual. **Prerrequisito de la fase 6** | El Excel deja de alimentar el tracking |
| Mail de las 12:30 (`procesar-pedidos-web`, `retry-procesar-pedidos`, `procesar-pedidos-db` v10 con filtro) | Sigue para los no piloto | Cron apagado; la Edge Function queda desplegada como contingencia (`dry:true`) |
| Reportes de ISIS (Programación Diaria y Base Datos Pedidos) | La operadora los sigue bajando para lo no web; lo que traen de una NP web va a cuarentena o se descarta (§6.1) | Dejan de hacer falta |
| **`PPP_Entregados_Meta`** (Sheet "PPP Pedidos Entregados 2026", cron `7,37 * * * *`, `TRUNCATE`) | Ninguna NP web llegaría a Meta, ni antes ni después del renombre, porque no está en el Excel. Consumidores que dependen de Meta y no de `Facturacion_NP`: `pppTandaM3Map` (`index.html:25715`) y `vista_tanda_m3`, `_pppMetaEntSet` (`:25740`), el reparto de Carga Camión, `sync_pasaje_rr`, `reconciliar_pipeline_stock`, `generar_inconsistencias`, `vista_np_sin_programar` y `ppp_entregados` en LK. Diseño: columna `origen` en Meta; el trigger del tilde (§4.7, estado `facturada`) inserta la fila con `origen='web'` y `on conflict (np)`; `sync_ppp_entregados_meta()` pasa de `TRUNCATE` a `DELETE WHERE origen='sheet'` — con `WHERE` real, porque `supautils` bloquea los DELETE sin `WHERE`. **Prerrequisito de la fase 6**, construido en la 5 | Migrar los consumidores a `Facturacion_NP` + CCN: proyecto aparte |
| `lk_pedidos_match`, `vista_np_sucursal`, `Alertas_Pedidos_Web` | Siguen para las NP `origen='sheet'`; ganan `condicion_pago_code` (§5) | Se retiran cuando todo sea web-directo, o quedan como verificación |
| `pa_entregas` (OSA / TyL en LK) por `virgilio-entrega-sync` | Nace con la provisoria al armar; `confirmar_np_isis` re-postea `rename` (§3.5) | Igual |
| Cobranzas (`cobranzas_valorizar_np`, `cob_empresa_np`) | Sin cambios: corren sobre la NP real, post-import | Sin cambios |
| Cruce de facturas de ISIS (`vista_np_factura`) | Sin cambios (matchea por cliente, fecha y neto) | Con `np_map` se puede mejorar el match |
| `sincronizar_ppp()` de LK (roto desde el 13/08) | Arreglar la foreign table (fuera de esta idea, D16) | Si se arregla, `gv_ppp_*` ve las provisorias como backlog de LK por `left(np,1)='9'`, que es correcto |
| Idea 5547 | P1 se redefine ("pedido armado listo para facturar" = el Excel de 3717, o JSON como mejora); P2, P3 y P5 se caen; P4 sigue independiente; hay que comunicárselo a ISIS (H8) | Un solo dueño del pedido: Virgilio |

---
## 7. Fases de implementación

Cada fase se verifica sola y no depende de la siguiente. Estimación relativa (S < M < L). "Branch" = conviene probarla en un branch de Supabase (§12.2). Cada fase que cree funciones corre el checklist del runbook de migraciones (idea 9670) y suma sus tests a `tests/run.sh`.

| Fase | Contenido | Criterio de "listo" | Est. | Branch |
|---|---|---|---|---|
| **0** | Botón Excel en Facturación sobre NP actuales (§11): RPC `facturacion_export_isis` (agregación por tanda vigente, score de sucursal, cobertura por empresa), serializador, archivo `PRUEBA_NO_IMPORTAR_*`, botón oculto; opcional `condicion_pago_code` en `lk_pedidos_match` (D11) | ISIS importa el archivo en un entorno de prueba, o Horacio confirma el formato; gaps medidos por empresa; **`tests/fac-excel-isis.cjs`** (fixture de 3 NP → XML byte a byte, con los casos `029`, celda vacía, `uxb` decimal y NP re-armada) corriendo en `run.sh` | S | Sí (la RPC) |
| **1** | DDL aditivo: `Pedidos_Web`, `np_map`, `Facturacion_Export_*`, `np_rename_log`, `ppp_cuarentena_*`, `PPP_Historico_Web`, `ppp_config`, `sync_heartbeat`, columnas `origen/empresa/order_id/parte/uxb` y `PPP_Entregados_Meta.origen`, **índice único parcial**, triggers de §6.1 (`SECURITY DEFINER` + REVOKE, con la bandera de sesión de §4.1), vistas `v_pedidos_web_estado` y `v_np_map_lk`, **regla de empresa por primer dígito** (`empresa_de_np`, `vista_faltante_real`, `vista_faltante_demanda`, **`vista_nc_loeke_chef`**, `empresaDeNp`, `pkNpEsLoeke`), **`ALTER TRIGGER trigger_actualizar_saldo_stock … UPDATE OF`**, `REVOKE` a anon en todo lo nuevo | El push del Sheet sigue igual (conteos antes y después, y un push con una NP repetida a propósito en el branch **no** vacía la tabla); `pppSubir` igual; `tests/emp-np.cjs` ampliado con `9…` y `4…` de 9 dígitos; **`tests/anon-writes.cjs`** en verde contra el branch | M | Sí |
| **2** | LK: columnas `enviado_a_virgilio_at`, `cancelado_at`, `version_virgilio`, `canal`; `pedidos_web_piloto`, `pedidos_web_estado`, `pedidos_web_push_log`; foreign tables nuevas; `sync_pedidos_web_virgilio()` (por fila, advisory lock, pull-back), cron `*/5`, heartbeat; **`ALTER SERVER virgilio_db`** (`connect_timeout`, `batch_size`); **policies `orders_delete_own` y `orders_update_own_sheets` con el sello**; triggers de des-sello en `orders` y `order_items`; **`procesar-pedidos-db` v10 con filtro del piloto** y `enviar_pedidos_main()` llamando al push; `rollback_pedidos_web()` | Con el piloto vacío: 0 filas empujadas, heartbeat cada 5 min y mail de las 12:30 idéntico. Con 1 cliente de prueba: fila en `Pedidos_Web` con los 12 datos más dirección y barrio. **Simulación de Virgilio caído** (server apuntado a un puerto cerrado en un branch de LK): la corrida falla en ≤10 s, no apila jobs y el mail no se lleva al piloto. Un pedido roto no frena a los demás (`pedidos_web_push_log`), verificado con un `exception` real dentro del loop con FDW | M | No (el FDW apunta a producción) |
| **3** | Virgilio: `aplicar_pedidos_web()` (validaciones, partición, `reenviado`, `cancelado`) + cron `*/2` + watchdog; `pppFindNpPdf`; prefijo visual "NPV" | Un pedido de prueba genera N tramos en `PPP_*` con `origen='web'`; **`tests/np-particion.sql`**: sobre los pedidos de 60 días la función da exactamente los mismos tramos que `processOrders`; m³ dentro del 5 % de ISIS; zona derivada; la PPP sobrevive a un push del Sheet; una fila inválida (código de artículo inexistente) queda en `error` con aviso y **no** entra a la PPP | M | Sí (con `Pedidos_Web` sembrada a mano) |
| **4** | Programar en la app: `PPP_READONLY=false` en la copia, `ppp_programar()` (con `observaciones` y `no_facturar_hasta`), `ppp_config`, evento `PPG`; pantalla de `v_pedidos_web_estado` con "Cancelar tramo" | La operadora programa una tanda de prueba en la copia; el monitor y el operario la ven; `ppp_etapa_tanda` la sigue; **`tests/ppp-programar-rpc.cjs`** (con `page.route` mockeando el RPC) en `run.sh` | M | Sí |
| **5** | Facturación en régimen: estados `armada / exportada / importada / facturada` (§4.7), `facturacion_export_isis()` con estado y anulación, `confirmar_np_isis()` (renombre por expresión regular en el orden de §3.5, cuarentena, `np_rename_log`, re-post de `pa_entregas`), `deshacer_np_isis()`, trigger de `Facturacion_NP` → `np_map` + **`PPP_Entregados_Meta` web** + cambio de `sync_ppp_entregados_meta` a `DELETE WHERE origen='sheet'`, guard de CCN en la app con aviso, aviso en el cierre, **`ppp_archivar_web()`**, acción `rename` en la Edge Function LK `virgilio-entrega-sync` | Sobre un tramo de prueba armado con legajo 0/1 en el branch: export → renombre → `deshacer` → renombre otra vez; `Entregas_Virgilio`, TAL/FCO, `Etiquetas_Lio`, `Correcciones_Pedido` y `Movimientos_Stock.ref` renombrados y `vista_saldos_stock` **idéntica** antes y después (el saldo no se recalcula, gracias al `UPDATE OF`); el tilde escribe `Facturacion_NP` con la NP real y su fila en Meta con `origen='web'`; la cuarentena absorbe un push del Sheet simulado con la NP real; `tests/anon-writes.cjs` en verde | L | Sí (es lo más importante de probar ahí) |
| **6** | Piloto real con 2-3 clientes LK (**no** 288 ni 2533 hasta que el `rename` de `pa_entregas` esté desplegado en LK); tracking de LK desde `pedidos_web_estado`; Excel del cierre; reimpresión de papel | **Prerrequisitos:** Meta web (fase 5), tracking de LK, filtro del piloto en la Edge Function, policies de `orders`. Dos semanas sin intervención manual en ISIS salvo importar y facturar; la NP real coincide con la cuarentena en el 100 % de los casos; ningún CCN con provisoria; el cliente recibe "programado" y "enviado" | M | No |
| **7** | Cancelación desde LK (`cancelar_pedido`), export complementario con identidad propia (§4.8), `Zonas_Barrios_Alias` | Una cancelación desde la web borra el tramo sin picking; un CP posterior al export genera un complementario con su propia NP y su `Facturacion_NP` | M | Parcial |
| **8** | Chef (§4.11): inventario del proyecto Chef, grant o tabla de sellos, sucursal y condición en `v_pedidos_match_chef`, push con `empresa='chef'` | Un pedido Chef de prueba genera un tramo `4…`, clasificado CH en el picking dual de 437E, su Excel Chef y su NP 4xxxx | M | No |
| **9** | Ampliar el piloto a todos los clientes LK, apagar el mail de las 12:30, "Cargar NP manual", `ppp_programar` también para `origen='manual'`, documentación (`GUIA-PROYECTO.md`, `CLAUDE.md`, `sql/`) | Cuatro semanas sin mail; Sheet apagado; los dos reportes de ISIS dejan de bajarse | S | — |

---

## 8. Riesgos y mitigaciones

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| 1 | ISIS no devuelve la NP y el tipeo de la "primera NP" se equivoca (lote intercalado con KRIKOS o manuales, o una NP anulada) | Renombre hacia NP ajenas, con cascada de ~30 filas por NP | `confirmar_np_isis` valida la cantidad y contrasta contra la cuarentena del Sheet cuando existe (§3.4); **`np_rename_log` + `deshacer_np_isis()`** (§3.7); pedir a ISIS el P3 invertido (H6) |
| 2 | Un humano confunde la provisoria de 9 dígitos con una NP real | Búsquedas y papel | Prefijo visual "NPV" en pantalla y en el remito; reimprimir tras el renombre |
| 3 | El push del Sheet borra las filas web | Los pedidos desaparecen de la PPP | Trigger BEFORE DELETE (§6.1) con la bandera de sesión (§4.1); test de la fase 1 |
| 4 | Doble entrada a ISIS (mail de las 12:30 y export) | NP duplicadas en ISIS | **Filtro del piloto en los dos lados** (§4.2, §6.2), sello doble y el push respetando `enviado_a_compras_at` |
| 5 | Pedido editado o cancelado después del push | Se arma lo que no es | Editable hasta que tenga tanda, con Virgilio como autoridad (§4.9); policies con sello; triggers de des-sello; aviso si ya hay picking |
| 6 | `Pedidos_Web` nace con CRUD para `anon` (default privileges, v) | Fuga de datos comerciales (deuda, límite de crédito) | `REVOKE` explícito en el mismo DDL; vista sin `leyenda2` ni `items` y RPC de supervisor (§4.13) |
| 7 | La regla "empresa por número" vive en ~20 lugares | El picking dual va a la góndola equivocada | **Regla por primer dígito en la fase 1** (§3.2), equivalente para todas las NP existentes (0 diferencias, v), incluyendo `vista_nc_loeke_chef` que usa `< 90000`; test 437E sobre un `4…` de 9 dígitos |
| 8 | Sin `barrio` no hay `zona`; 61 valores de `zona_expreso` no matchean | El panel de errores se llena de "sin zona" | `Zonas_Barrios_Alias`; corregir el padrón de LK; `ppp_autozona` además aprende |
| 9 | ISIS rechaza una fecha de pedido de 12-14 días atrás, el código real (437E) o la `leyenda2` vacía | El import falla | Preguntas H3, H5 y H7; el Paso 0 sirve justamente para probarlo |
| 10 | El tope de 18 no es de ISIS pero sí de algo (formulario o impreso) | Partición innecesaria o insuficiente | H4; mantener 18 hasta la respuesta |
| 11 | `confirmar_np_isis` renombra a medias | Estado inconsistente | Una sola transacción; `np_rename_log`; prueba en el branch |
| 12 | El renombre recalcula los saldos de stock N veces | Locks y lentitud todos los días | `ALTER TRIGGER … UPDATE OF` (fase 1); `vista_saldos_stock` idéntica antes y después como criterio |
| 13 | El renombre hace seq scan de `Registros_Produccion_Virgilio` | Minutos de UPDATE y locks por cada lote | La tabla **no tiene índice por `texto`** (v): el UPDATE va acotado por `created_at >= np_map.creado_at` (hay índice) y por `opcion` (también) |
| 14 | El push o el cron caen en silencio (LK no tiene Telegram), o Virgilio caído apila jobs | Pedidos que no llegan, conexiones colgadas | `connect_timeout 10`, `statement_timeout 60s`, advisory lock; `sync_heartbeat` más `watchdog_frescura_datos` y `watchdog_syncs_externos` |
| 15 | Commit a medias del FDW (no hay two-phase commit) deja la fila remota sin sello local | Push trabado para siempre | Idempotencia por fila (`select` → `insert` / `delete+insert` / `update`) y excepción por pedido (§4.2.3) |
| 16 | Una trigger fn nueva corriendo como `anon` | `42501` masivo: se rompen los armados y los eventos (incidente del 28/08) | `SECURITY DEFINER` + REVOKE en todas (§4.13); `tests/anon-writes.cjs` en las fases 1 y 5 |
| 17 | Ventana entre importar en ISIS y confirmar en Virgilio: el Sheet trae la NP real como `sheet` | El mismo pedido dos veces en la PPP; se re-pickea | Cuarentena (§3.4); `confirmar_np_isis` la absorbe |
| 18 | Camión cargado con la provisoria (p10 de tilde→CCN = 3,5 h) | CCN, CCR, CRN, remitos y cobranzas con un `9…` de 9 dígitos | SLA, guard en Carga de camión, aviso por Telegram, y la expresión regular del renombre corrige lo que igual entró (§3.6) |
| 19 | `Entregas_Virgilio` con la misma línea dos veces (28 NP de 768) | ISIS factura al doble, o se pierde una línea si se toma sólo la última fila | Suma por `(np, cod_art)` sobre la tanda vigente, con ⚠ y bloqueo si el total supera lo pedido (§4.6) |
| 20 | Las filas web nunca salen de `PPP_*` | Monitor y PPP con cientos de tandas viejas | `ppp_archivar_web()` (§4.14) |
| 21 | NP web ausentes de `PPP_Entregados_Meta` | m³ despachados, reparto, entregados, inconsistencias y los parciales de LK | Meta web desde el tilde y `sync` con `DELETE WHERE origen='sheet'`; prerrequisito de la fase 6 |
| 22 | `pa_entregas` (OSA / TyL) queda con la provisoria | El cruce contra el remito del cliente falla | Re-post `rename` desde `confirmar_np_isis`; 288 y 2533 fuera del piloto hasta desplegarlo |
| 23 | El tracking por WhatsApp al cliente se apaga para los piloto | El cliente se queda sin "programado" ni "entregado" | `order_tracking` desde `pedidos_web_estado` antes de la fase 6, con `np_number = order_id` y los estados vivos (`programado`, `entregado`), después de identificar al otro escritor |
| 24 | `lk_ppp_reader` escribe una tabla que se convierte en picking | Una fila inválida o maliciosa entra a la PPP | Validación en `aplicar_pedidos_web()` (§4.3.2); revocar de `PUBLIC` las `SECURITY DEFINER` sensibles (aparte) |
| 25 | La copia del repo comparte `localStorage` e IndexedDB con la app actual si vive en el mismo origen | Colas offline y ediciones mezcladas | Origen distinto (app.loekemeyer.com, idea 9073) o prefijo en las claves (§12.4) |
| 26 | `Facturacion_NP` con CRUD abierto a `anon` (9 policies, v) | Cualquiera con la anon key marca una NP como facturada | Cerrarla a JWT antes de colgarle `isis_export_id` (D15) |
| 27 | ISIS queda con un "pedido pendiente" si la operadora importa y no factura | Saldos comprometidos en ISIS | H1 y H2; regla de que lo exportado se factura ese día; `no_facturar_hasta` saca del export lo que todavía no debe facturarse |
| 28 | El branch de Supabase nace con los crons activos y URLs de producción adentro | Las pruebas de la fase 5 disparan Edge Functions reales de LK y avisos por Telegram | Branch creado con `cron.job` desactivado y hosts reemplazados (§12.2). Hoy Virgilio tiene **47 jobs, 46 activos** (v), entre ellos `telegram-outbox-flush` cada minuto, y **cuatro funciones con la URL de LK adentro**: `fn_virgilio_entrega_to_formato`, `fn_facturado_notif_wa`, `wa_factura_notificar` y `ventas_mensuales_cod` (v) |

---
## 9. Preguntas

### 9.1 Para el dueño (cerradas; la opción recomendada va primero)

1. **Identidad de la NP.** ¿A, provisoria renombrada al importar (**recomendada**), o B, provisoria permanente con `np_isis` aparte?
2. **Formato de la provisoria y regla de empresa.** ¿Numérica `9|4 + order_id(6) + parte(2)` = 9 dígitos **y** reescribir la regla de empresa a "primer dígito" en la fase 1 (**recomendada**: la regla actual `> 90000` clasificaría como LK a toda provisoria Chef), o una no numérica tipo `WL1336-2` (que obliga a reescribir los mismos ~20 puntos, y más)?
3. **Partición.** ¿Mantener el corte de 18 en Virgilio al ingresar, con 1 tramo = 1 unidad de armado = 1 NP (**recomendada**), o armar el pedido entero y partir sólo al exportar (rompe el renombre 1:1)?
4. **Edición del pedido web.** ¿**Editable hasta que tenga tanda**, con Virgilio como autoridad y rechazo avisado (**recomendada**: las 7 ediciones reales de 90 días pasaron entre 1 min y 19 h después del pedido, y "editable hasta el push" bloquearía 5 de 7), o la variante con techo, "sin tanda **y** dentro de las 24 h", que se parece más a la ventana de hoy (que corta a las 12:30)?
5. **`fecha_entrega` al ingresar.** ¿Vacía hasta programar, así la solapa "A Programar" vuelve a servir (**recomendada**), o replicar la tentativa por zona del Excel?
6. **Programación.** ¿En la app, con RPC por NP, `PPP_READONLY=false` en la copia y `observaciones` y `no_facturar_hasta` editables (**recomendada**, es el marco (a)), o seguir en el Excel y que el Sheet empuje sólo tanda y fecha por NP (obliga a tocar "Carga PPP.gs")?
7. **Artículo repetido en el pedido** (13 NP, p. ej. `574x4 + 574x2`). ¿Mantener las dos líneas como hoy en la PPP y **sumarlas al exportar** (**recomendada**: es lo que ISIS tiene que facturar), o consolidarlas ya al ingresar?
8. **CP y RC después de exportar.** ¿Bloquear en la app hasta la fase 7 y después export complementario **con identidad propia** (**recomendada**), o bloquear para siempre?
9. **Mail a ventas@ con el Excel.** ¿No, sólo descarga (**recomendada**), o sí (Edge Function y secretos de Gmail en Virgilio)?
10. **`pctDto`.** ¿Fijo "2% Descuento Web" como hoy (**recomendada** para el Paso 0), o vacío para los súper con lista propia y para el "Pedir para" del admin (régimen)?
11. **Alcance del DDL del Paso 0.** El Paso 0 crea **1 RPC y ninguna tabla** en Virgilio. Para que `condPago` no salga vacío hace falta **una columna** `condicion_pago_code` en `v_pedidos_match` y `lk_pedidos_match` (verificado: hoy no existe). ¿Autorizás esa columna ahora (**recomendada**: sin ella el Paso 0 mide un 0 % ficticio), o Paso 0 sin `condPago`?
12. **Estado "exportada" en el Paso 0.** ¿Sin persistir, sólo `localStorage` (**recomendada** bajo el marco (b)), o crear ya `Facturacion_Export_ISIS`?
13. **Cutover.** ¿Piloto por lista de clientes con el filtro **en los dos lados** (**recomendada**; implica un cambio chico en `procesar-pedidos-db`, v10), o corte total un día?
14. **Chef.** ¿Fase 8, después de que LK esté estable y con las precondiciones de §4.11 (**recomendada**), o desde el arranque?
15. **Despliegue.** ¿Copia del repo apuntando al **mismo** proyecto Supabase, con feature flag y tablas nuevas aisladas, hosteada en app.loekemeyer.com (**recomendada**, §12); proyecto Supabase nuevo; o el branch como entorno de operación?
16. **Colaterales** (no son de esta idea; sólo con permiso explícito). ¿Autorizás reportar o arreglar `sincronizar_ppp()` de LK (roto desde el 13/08), cerrar el CRUD anon de `Facturacion_NP` y normalizar `fecha_salida` a `date` en `Entregas_Virgilio`?
17. **Papel.** ¿Se acepta el remito de armado y la etiqueta ZPL con la provisoria "NPV" (**recomendada**), o hay que reimprimir sí o sí al renombrar?
18. **SLA operativo (§3.6).** ¿Confirmás que el import, el tipeo de la primera NP, la factura y el tilde se hacen en el mismo turno, antes de cargar el camión, y que los sábados los tramos web armados esperan al lunes (como hoy la factura)?
19. **Quién tipea la primera NP.** ¿Es siempre la misma persona que importa en ISIS (**recomendada**: el dato lo ve en pantalla en ese momento), o hay que preverlo para más de una persona y turnos distintos?
20. **Tramo armado sin nada que entregar** (todas las líneas en 0). ¿Se cancela con `NP_Canceladas` y se avisa al vendedor (**recomendada**), o se deja esperando el completado?

### 9.2 Para ISIS (Horacio Barbieri, Ticket 1159666)

- **H1.** ¿El importador de pedidos por Excel puede facturar en el mismo acto ("Emite Factura de los Pedidos = Sí" aplica a lo importado)? ¿Y como cuenta corriente?
- **H2.** ¿Existe "importar y facturar" sin dejar un pedido pendiente, o son dos pasos? ¿Qué pasa con una NP importada y no facturada ese día?
- **H3.** ¿Acepta un pedido con cantidades definitivas y fecha de pedido de 5 a 15 días atrás? ¿Impacta en el stock comprometido o en los reportes?
- **H4.** ¿Hay tope de líneas por pedido en el importador (¿18?), o el tope es del formulario o del impreso? ¿Y en la factura?
- **H5.** ¿`Numero OC` y `Leyenda 2` son obligatorios? ¿Se imprimen en la factura? (la idea es usar `Numero OC` como referencia externa con la provisoria).
- **H6 (P3 invertido).** ¿Puede ISIS devolver la NP asignada por fila importada (archivo, JSON o API saliente), o al menos conservar la referencia externa en el reporte "Programación Diaria"?
- **H7.** ¿El maestro de artículos de ISIS tiene los códigos reales (437E, 438EL, 865ED)? La prueba concreta es el dry-run del Paso 0 con una NP que contenga 437E, 438EL y un código con sufijo E de Chef.
- **H8.** Comunicar: el JSON 98180/98187 y los circuitos P2, P3 y P5 quedan reemplazados; P1 pasa a ser "pedido armado listo para facturar" (Excel hoy, JSON como mejora); P4 sigue igual.

---

## 10. Números que justifican

| Métrica (60 días salvo indicación) | Valor |
|---|---|
| Pedidos web LK | **413** (6,9 por día); **7.902** líneas; mediana de 15 líneas; máximo 93 |
| Pedidos con ≥18 líneas → partición | **180 (43,6 %) → 643 tramos** (×1,56) |
| Espera al cron de las 12:30 | Mediana 12,9 h, p90 22,7 h, máximo 24 h; el 50,1 % entra después de las 12:30; 37 los viernes a la tarde |
| Ciclo pedido → primer picking / → salida | Mediana 11,8 d / 14 d (p90 19,7 / 21). Lo domina la cola de la PPP; la idea ahorra las 11-13 h de espera más el trabajo humano de importar y bajar dos reportes |
| Cobertura del canal web, **por empresa** (v) | Programación (183 NP): LK WEB **141/150**, COT 6/6, KRIKOS 3/3, tipo vacío 0/3; Chef WEB **13/15**, COT 3/3, KRIKOS 0/3 → total 166/183 = 90,7 %. Base (801 NP): LK **664/700** (94,9 %), Chef **72/101** (71,3 %). Se cuenta como cubierta la NP cuyo cliente tiene un pedido web en `lk_pedidos_match` dentro de `[fecha−3, fecha]`; el código de cliente sale de Prog y, si no está, de `Facturacion_NP` |
| Ediciones reales (`mode='edit'`, 90 d) | 7; entre 1 min y 19 h después del pedido; 2 dentro de 5 min |
| NP facturadas | **582 en 40 días** (14,6 por día) y 768 en 60 días; **49,7 % con faltante** → cada una de esas es hoy un ajuste manual en ISIS |
| **NP con la misma línea armada dos veces** | 28 NP / 71 pares `(np, cod_art)`, todas facturadas; 59 pares con suma mayor a lo pedido; tres causas distintas (§2) |
| NP con 18-19 líneas en Base | 256 de 801 (32 %); máximo de líneas por NP = 19 |
| **Tilde → primer CCN** (687 pares) | p10 **3,4 h**; 51 NP dentro de las 2 h; **3 CCN antes del tilde**; tilde entre las 16 y las 17 h en **517 de 768** |
| ISIS conserva 1 `N_Pedido` = 1 NP | 01/09: 17 generadas = **17 NP** (98652-98668), verificado; 02/09 quedó parcial al momento del corte |
| CP después de facturada / RC después | 2 NP y 4 cajas / 0 |
| Canceladas | 13 (todas el 11/08, "Cancelado por el cliente"); 0 NP perdidas en 60 días |
| TAL antes del tilde | **737 de 768** NP; eventos totales con NP en `texto`: TAL 941, AUB 373, CP 184, FCO 69, NPD 36, FAL 2 |
| Puente FDW existente | **563 de 563** corridas ok; 6,5 s de promedio por corrida (por `batch_size=1`); **sin `connect_timeout`** (v) |
| Datos disponibles hoy para el Excel (450 NP / 30 d) | fecha 100 %, código de cliente 100 %, artículos y cajas 100 %, `uxb` 5.286 de 5.288 líneas, vendedor **LK 99 % / Chef 38 %**, sucursal **LK 96 % / Chef 8 %**, `leyenda2` 0 %, `condPago` 0 % sin la columna de D11 |
| Sucursal ambigua | 22 cliente-día con dos sucursales distintas en 90 días; 17 de 977 con `ambiguo = true`. Con el score por conjunto de códigos se resuelven 39 de 48 casos con más de un candidato |
| Clientes con espejo en `pa_entregas` | 2533 (10 pedidos web, el último el 31/08) y 288 (11) |

---
## 11. Paso 0 — botón Excel en Facturación (lo único autorizado)

**Aislado, sin efectos sobre el circuito actual.** Trabaja sobre NP que **ya están en `Facturacion_NP`**, o sea NP reales de ISIS. ISIS ya tiene esas NP, así que el archivo **no se importa en producción** — y como es importable tal cual (las mismas 12 columnas, `N_Pedido` 1..N, sin rastro de la NP real, así que ISIS numeraría NP nuevas para pedidos ya facturados), el Paso 0 lleva **tres candados**:

1. El archivo se llama **`PRUEBA_NO_IMPORTAR_DD-MM-YY_HHMM.xls`**.
2. La hoja "Resumen" abre con **"NP YA NUMERADAS EN ISIS — SÓLO PRUEBA DE FORMATO"** y la lista de NP reales incluidas.
3. **Botón oculto**: aparece sólo con `?isisTest=1` en la URL **y** con el mail del dueño o de los tres supervisores de `SUPERVISOR_EMAILS` (`index.html:35087`, que son los mismos de la policy `ppp_prog_write_sup`). No aparece en la pantalla diaria de la operadora hasta la fase 5.

Sirve para (a) validar con Horacio y con la operadora que ISIS importa un archivo post-armado con este formato, (b) medir los gaps reales por empresa (§5) y (c) dejar construidos la RPC y el serializador que la fase 5 reutiliza tal cual.

### 11.1 Datos: RPC `facturacion_export_isis(p_nps text[], p_prueba boolean default true)`

`SECURITY DEFINER SET search_path = public`, con chequeo de supervisor (el mail del JWT tiene que estar entre los tres de `ppp_prog_write_sup`, o ser el de la operadora) y `REVOKE EXECUTE FROM anon`. Se llama **con el JWT del supervisor**, igual que las escrituras de Facturación: el front ya tiene el helper `facAuthWriteHeaders` (`index.html:33957`) que arma `apikey` + `Authorization: Bearer` desde `window.sbAuth.getAccessToken()` (`:35526`). Devuelve una fila por línea, **ya agregada**:

```sql
with ult as (        -- tanda vigente = la del último armado; ignora filas con tanda nula (correcciones manuales)
  select distinct on (np) np, tanda
  from "Entregas_Virgilio" where np = any(p_nps) and tanda is not null
  order by np, id desc
), ent as (          -- 1 fila por (np, cod_art), SUMANDO las líneas repetidas de esa tanda
  select e.np, e.cod_art, min(e.id) as id,
         sum(e.cajas_pedidas)    filter (where e.tanda = u.tanda) as cajas_pedidas,
         sum(e.cajas_entregadas) filter (where e.tanda = u.tanda) as cajas_entregadas,
         sum(e.cajas_entregadas)                                  as ent_total,
         count(distinct e.tanda)                                  as n_tandas,
         bool_or(e.tanda is null)                                 as tiene_sin_tanda
  from "Entregas_Virgilio" e join ult u on u.np = e.np
  where e.np = any(p_nps) group by e.np, e.cod_art
), base as (
  select pedido as np, min(fecha)::date as fecha_min
  from "PPP_Base_Pedidos" where pedido = any(p_nps) group by pedido
), tramo as (        -- códigos del tramo, TAL CUAL (con ceros), para el score de sucursal
  select np, array_agg(distinct regexp_replace(cod_art,'\s+(LK|CH)$','')) as cods from ent group by np
)
select f.np, e.cod_art,
       to_char(coalesce(b.fecha_min, f.fecha_salida),'DD/MM/YYYY')                       as fecha,
       f.cod_cliente                                                                     as cliente,
       coalesce(v.vend,'')                                                               as vend,
       lpad(regexp_replace(e.cod_art,'\D','','g'),3,'0')
         || upper(regexp_replace(e.cod_art,'\d','','g'))                                 as articulo,   -- padCodArt
       least(e.cajas_entregadas, e.cajas_pedidas)                                        as cajas,
       least(e.cajas_entregadas, e.cajas_pedidas) * u.uxb                                as uni,        -- null si no hay uxb
       coalesce(s.sucursal_entrega,'')                                                   as sucursal,
       ''                                                                                as leyenda2,   -- no existe en Virgilio
       coalesce(s.condicion_pago_code,'')                                                as condpago,   -- columna nueva (D11); '' si no está
       '2% Descuento Web'                                                                as pctdto,
       ''                                                                                as numoc,
       -- avisos del checklist
       (coalesce(s.ambiguo,false) or s.score < 0.9 or s.n_suc_best > 1)                  as suc_dudosa,
       (s.order_id is null)                                                              as sin_pedido,
       (e.n_tandas > 1)                                                                  as re_armada,
       e.tiene_sin_tanda,
       (e.ent_total > e.cajas_pedidas)                                                   as entregado_mayor_pedido,  -- bloquea
       (u.uxb is null) as sin_uxb, (v.vend is null) as sin_vend, (f.np ~ '^4') as es_chef
from "Facturacion_NP" f
join ent e   on e.np = f.np and e.cajas_entregadas > 0
left join base  b on b.np = f.np
left join tramo t on t.np = f.np
left join clientes_vendedor v on v.cod_cliente = f.cod_cliente
left join vista_uxb_articulo u on u.cod = norm_cod(e.cod_art)      -- la vista guarda '26', Entregas '026'
left join lateral (                                                -- sucursal por SCORE de conjunto de códigos
  with c as (
    select m.order_id, m.sucursal_entrega, m.ambiguo, m.orden_en_dia, m.created_at, m.condicion_pago_code,
           (select count(*) from unnest(t.cods) k
             where k = any(string_to_array(regexp_replace(m.items_string,'x[0-9.]+','','g'),',')))::numeric
             / greatest(cardinality(t.cods),1) as score
    from lk_pedidos_match m
    where m.cod_cliente = f.cod_cliente
      and m.empresa = case when f.np ~ '^9' then 'lk' else 'chef' end
      and m.fecha_pedido between b.fecha_min - 3 and b.fecha_min)
  select c.*, (select count(distinct c2.sucursal_entrega) from c c2
                where c2.score = (select max(score) from c)) as n_suc_best
  from c order by c.score desc, c.orden_en_dia, c.created_at limit 1) s on true
where f.np = any(p_nps)
order by f.np, e.id;
```

**Inventario exacto de lo que crea el Paso 0.** En Virgilio: **1 RPC** `facturacion_export_isis` (el desempate de sucursal va inline, sin tabla ni helper nuevos) y **0 tablas, 0 columnas**. En LK: **opcional y sujeto a D11**, 1 columna `condicion_pago_code` en `v_pedidos_match` y `lk_pedidos_match`, con `sync_pedidos_match_virgilio()` copiándola. Sin D11, `condpago` sale vacío y se informa como gap — **verificado: hoy la columna no existe y la RPC del borrador fallaba con `42703` por eso**. El `N_Pedido` lo asigna el front en el orden del checklist (1..N por NP). **Chef queda fuera del Paso 0** (checkbox deshabilitado, "sin sucursal en 60 de 65"), salvo que el dueño quiera ver el archivo igual.

### 11.2 Interfaz

En el bloque `.fac-cierre` (`index.html:3069` el CSS, `:3496` el botón de cierre), arriba de "Terminé — Generar PDF", **oculto por defecto**: botón **"⬇ Excel para ISIS (prueba)"**. Abre un overlay con el molde `.facfc-` (`facFCEnsureModal`, `:34033`): una fila por NP tildada hoy (`_facNpsHoyReal`, `:32213`, con la opción de incluir otros días eligiendo `fecha_salida`), checkbox marcado por defecto salvo Chef o `entregado_mayor_pedido`, y columnas NP · Código · Razón social · Líneas · Cajas entregadas · ⚠. Los avisos son: sucursal dudosa, sin pedido que matchee, sin vendedor, sin `uxb`, sin `condPago`, **re-armada**, **hay filas sin tanda** y **entregado mayor a lo pedido** (este último bloquea). Botón "Generar Excel (N NP, M líneas)". Sólo supervisor u operadora.

### 11.3 Formato (port literal de `generateExcel`)

XML Spreadsheet 2003, los mismos estilos `Default/Header/Data/Desglose`, hoja 1 `"DD-MM-YY 9Hs"` sin encabezado con las 12 columnas en orden, tipos `Number`/`String` con la regla `isNum` (un `String` que empieza con `0`, como `029`, queda String), vacío → `<Cell/>`; hoja 2 "Resumen" con la leyenda de prueba, `Pedidos | NP` y el desglose `Cod Clte | Num Ped | Cant Items`. Archivo `PRUEBA_NO_IMPORTAR_DD-MM-YY_HHMM.xls`, `Blob` `application/vnd.ms-excel`, `a.download`. La función `facExcelIsisXml(rows, opts)` va en `index.html` (~60 líneas, sin librería); en la fase 5 la misma función recibe `opts.prueba = false` y nombra el archivo `Pedidos_Armadas_DD-MM-YY_HHMM.xls`.

### 11.4 Estado "exportada"

- **Opción 0-a (recomendada bajo el marco (b)):** sin persistencia en el backend. `localStorage` `vir_fac_isis_export` con `{np: timestamp}` para pintar "📤 dd/mm hh:mm" en `facRenderTicked` (`index.html:33776`) en ese navegador, más la fecha y hora en el nombre del archivo.
- **Opción 0-b:** crear ya `Facturacion_Export_ISIS` (y sus líneas, con `prueba = true`), lo que contradice el marco (b) salvo autorización explícita (D12).
- El campo "primera NP de ISIS" y `confirmar_np_isis()` **no** van en el Paso 0.

### 11.5 Backend, navegador y verificación

La RPC resuelve los datos en el backend y el navegador serializa el XML. No hay Edge Function porque no hay mail. La verificación es **automatizada, no a ojo**: `tests/fac-excel-isis.cjs` en `run.sh`, con un fixture de 3 NP (una con faltante, una con artículo dual `437E`, una re-armada con la línea doble) comparado **byte a byte** contra el XML esperado — incluidos `029` como `String`, la celda vacía `<Cell/>`, el `uxb` decimal, el orden de columnas y el nombre `PRUEBA_NO_IMPORTAR_*`. Además, una corrida manual de `select * from facturacion_export_isis(array['98684'])` sobre tres NP conocidas, comparada contra un `dry:true` de `procesar-pedidos-db` del mismo pedido (mismo orden de celdas y mismos tipos).

---

## 12. Estrategia de despliegue: repo copia en paralelo (marco d)

### 12.1 Qué copia el repo y qué no

Copiar `Produccion-Virgilio` copia **sólo el front** (`index.html`, `sw.js`, `manifest.json`, `vendor/`, `/cervantes/`, `/admin/`, `/selector/`, `tests/`). **No copia** el esquema de Supabase, los datos, los triggers, los 47 crons, las Edge Functions, el vault, el rol `lk_ppp_reader`, el FDW de LK ni el Apps Script. Si la copia apunta al mismo proyecto y escribe en `PPP_*`, `Facturacion_NP`, `Entregas_Virgilio`, `Movimientos_Stock` y `Registros_Produccion_Virgilio`, **pisa producción**; si apunta a otro proyecto, el depósito tendría dos verdades de stock y de eventos.

### 12.2 Opciones de separación del backend

| Opción | Qué separa | Problema | Veredicto |
|---|---|---|---|
| **Branch de Supabase** | La base entera, con host propio | Sin **datos** (hay que sembrar), sin vault ni secretos de Edge Functions, sin el FDW desde LK. Y sobre todo: el branch nace con los **crons activos** (hoy 47 jobs, 46 activos, entre ellos `telegram-outbox-flush` cada minuto) y con **cuatro funciones que llevan la URL de LK adentro** (`fn_virgilio_entrega_to_formato`, `fn_facturado_notif_wa`, `wa_factura_notificar`, `ventas_mensuales_cod`), así que insertar en `Facturacion_NP` en el branch dispara Edge Functions de LK **reales**. El repo no tiene `supabase/migrations` (sólo `functions/`), así que el drift producción ↔ branch no se diffea desde git | **Sí como laboratorio** de las fases 1, 3, 4 y 5, pero creado así: volcado del esquema de producción → `update cron.job set active = false` → reemplazo de los hosts de LK y Virgilio por uno inexistente → restore en el branch, y comparar el esquema antes de probar. A mediano plazo, mover los hosts a una tabla de configuración leída por las funciones |
| Proyecto Supabase nuevo (clon) | Todo | Alto: recrear Edge Functions y secretos, vault, crons, el rol y un segundo FDW en LK; el Apps Script no lo conoce; hay que reapuntar el TWA y la PWA. Y dos verdades transaccionales desde el minuto 1 | No (salvo que la idea 9073 decida cambiar de organización) |
| **Mismo proyecto, tablas y columnas nuevas aisladas + feature flag en la copia** | Sólo lo nuevo (§4.1); lo transaccional sigue siendo único | El único conflicto es el reemplazo total del Sheet, y lo resuelven los triggers de §6.1. El flag `FLUJO_DIRECTO` enciende en la copia la PPP editable, el checklist de export y el confirmar NP; la app vieja sigue viendo las NP web como filas más de la PPP | **Recomendada** |
| Esquema o prefijo (`v2.*`) en el mismo proyecto | Tablas duplicadas | Habría que duplicar las 19 vistas y las 20 funciones que leen `PPP_*` | No: duplica justo lo que la idea 7411 quiere eliminar |

### 12.3 Cómo conviven las dos apps con la opción recomendada

- La copia apunta al **mismo** proyecto y a las **mismas tablas transaccionales**: picking, armado, stock y eventos son una sola verdad, y un operario puede usar cualquiera de las dos apps el mismo día. Lo que difiere está detrás de `FLUJO_DIRECTO`: PPP editable (§4.5), checklist de export y confirmar NP (§4.7), pantalla de `v_pedidos_web_estado` con "Cancelar tramo" (§4.9) y guard de CCN (§3.6).
- Los cambios de la fase 1 que **no** van detrás del flag (la regla de empresa por primer dígito y su test) se hacen en **los dos** repos: la app vieja también tiene que clasificar bien una provisoria si un operario la abre desde ahí.
- El cutover no es "app vieja → app nueva" sino **por cliente** en LK (§6.2). Cuando el piloto es "todos" y pasan N semanas, se archiva el repo viejo, se reapunta el `start_url` del TWA y de la PWA, y se apaga el Sheet.

### 12.4 Hosting de la copia y estado del navegador

- **Recomendado:** la copia nace en **app.loekemeyer.com** (Cloudflare Pages con Access, idea 9073; repo privado, deploy al pushear). Un origen distinto separa `localStorage`, IndexedDB y el service worker **gratis**. Y hace falta: `index.html` usa **más de 40 claves distintas de `localStorage`** (v) — 11 literales como `vir_entregas_pend`, `vir_stock_pend`, `vir_racks_pend` o `prod_metas`, y unas 33 por constante, entre ellas `QUEUE_KEY = "legajo_queue_virgilio_v1"` (`:6138`, la cola offline), `PPP_EDITS_KEY = "vir_ppp_edits"` (`:26145`), `PPP_CFG_KEY = "vir_ppp_cfg"` (`:26170`), más las de autenticación, kiosco y borradores. La sesión de Google del supervisor es por origen: hay que agregar el nuevo origen al cliente OAuth. El TWA de Play Store sigue apuntando a la raíz de GitHub Pages hasta el final.
- **Si tiene que vivir en GitHub Pages** (mismo origen, por ejemplo `/v2/`): prefijar **todas** esas claves (`vir2_`), el nombre de la IndexedDB y el scope del service worker; `sw.js` no cachea, así que no colisiona; `robots noindex` como en `/admin/`.
- Supabase: `APP_VERSION` y `SW_VERSION` independientes, misma anon key, RLS y policies sin cambios. `tests/run.sh` corre en el CI del repo copia con los tests nuevos (§7).

### 12.5 Orden concreto

1. Paso 0 en el repo actual (lo único autorizado), con su test.
2. Cerrar y aprobar este plan (preguntas §9.1).
3. Branch de Supabase **creado con los crons desactivados y los hosts reemplazados** (§12.2) → fases 1, 3, 4 y 5 de laboratorio, con datos sembrados.
4. Merge del DDL aditivo a producción (fase 1) con backups; verificar que el push del Sheet sigue igual; regla de empresa en los dos repos.
5. Copia del repo en app.loekemeyer.com con `FLUJO_DIRECTO=false` (idéntica a la actual) → prueba de hosting y de Access (idea 9073).
6. Fase 2 en LK con el piloto vacío → heartbeat y prueba de Virgilio caído.
7. `FLUJO_DIRECTO=true` en la copia y piloto de 2-3 clientes (fase 6) con sus prerrequisitos (Meta web, tracking de LK, `rename` de `pa_entregas`).
8. Ampliar, Chef, apagar el mail y el Sheet, archivar el repo viejo (fases 8 y 9).

---
## 13. Objeciones consideradas

42 objeciones de tres críticos: **OP** = operación (13), **DA** = datos (13), **TE** = técnica (16). "Aceptada" significa que **cambió el diseño**, no que se agregó una nota. Donde dos objeciones se contradecían, se dice cuál manda y por qué. Lo que un crítico afirmó y cambia el diseño se **re-verificó contra la base**; donde la verificación lo desmintió, se dice.

| Id | Grav. | Título corto | Qué se cambió / por qué se descarta | Sección |
|---|---|---|---|---|
| OP-1 | alta | Provisoria Chef `4…` clasificada como LK por `> 90000` | **Aceptada** (v: `empresa_de_np`, `empresaDeNp:7370`, `pkNpEsLoeke:8034`, `vista_faltante_real`, `vista_faltante_demanda` usan `> 90000`). Regla por primer dígito en la fase 1, equivalente sobre las 1.162 NP de `Facturacion_NP` (0 diferencias). **Se amplía:** el barrido encontró una sexta pieza que el crítico no vio, `vista_nc_loeke_chef` (`< 90000` = Chef), que también entra a la fase 1 | §3.2, §7 f1, riesgo 7 |
| OP-2 | alta | Ventana de doble existencia entre importar en ISIS y tipear la primera NP | **Aceptada**: cuarentena de las filas `sheet` que coinciden con un tramo `exportada`; `confirmar_np_isis` verifica contra `Facturacion_Export_Lineas` y absorbe, en vez de rechazar y trabar el lote | §3.4, §6.1, riesgo 17 |
| OP-3 | alta | NP armadas dos veces: las cajas entregadas sumadas duplican la factura | **Aceptada**, y el diseño va **más lejos** que lo que pedía el crítico: no alcanza con "tomar la última fila". Se agrega por `(np, cod_art)` **sumando dentro de la tanda vigente**, con `least(·, pedidas)`, ⚠ y bloqueo si el total supera lo pedido. Coincide con DA-1 | §4.6, §11.1, riesgo 19 |
| OP-4 | alta | Las filas web nunca salen de `PPP_*` y se pierde la ventana que hoy da el Excel | **Aceptada**: estado `archivada`, cron `ppp_archivar_web()` (Prog al salir, Base a los 60 días) y `PPP_Historico_Web`. **Se agrega** lo que faltaba para que funcione: el propio trigger protector bloquearía ese borrado, así que las tres funciones legítimas usan una bandera de sesión | §4.14, §4.1, riesgo 20 |
| OP-5 | alta | `PPP_Entregados_Meta` no vería ninguna NP web | **Aceptada** como **prerrequisito de la fase 6**: columna `origen`, insert desde el tilde con `on conflict (np)` — la tabla tiene PK `np` (v) — y `sync_ppp_entregados_meta()` con `DELETE WHERE origen='sheet'` | §4.7, §6.4, §7 f5-f6, riesgo 21 |
| OP-6 | media | El espejo OSA/TyL `pa_entregas` nace con la provisoria y el renombre no cruza | **Aceptada**: `confirmar_np_isis` re-postea `rename` por `ev_id` a `virgilio-entrega-sync`; 288 y 2533 quedan fuera del piloto hasta desplegarlo. Coincide con DA-10 y TE-7 | §3.5, §6.4, §7 f6, riesgo 22 |
| OP-7 | media | La lista de eventos a renombrar está incompleta (FCO, PPG) y es frágil | **Aceptada** (v: FCO 69 en 60 días): renombre por expresión regular sobre `texto` y `Movimientos_Stock.ref`, con conteo por opción en `np_rename_log`. **Se agrega** que la tabla no tiene índice por `texto`, así que el UPDATE va acotado por `created_at` y `opcion` | §3.1, §3.5, riesgo 13 |
| OP-8 | media | El cliente puede borrar el pedido o reescribir el payload después del push | **Aceptada** en la **fase 2** (v: las dos policies no miran ningún sello): `orders_delete_own` y `orders_update_own_sheets` pasan a exigir `enviado_a_virgilio_at is null`. Coincide con TE-14 | §4.9, §7 f2 |
| OP-9 | media | Carrera de edición: el push lleva el payload viejo y `version > 1` es código muerto | **Aceptada**: el push exige que el payload coincida con `order_items` (hash), `edit_order_fast` des-sella y sube `version_virgilio`, y hay triggers de des-sello en `orders` y `order_items`. Se **descarta** armar los ítems desde `order_items` en vez del payload: el payload lleva `cod_original` y `uxb` tal como viajan hoy, con 0 diferencias en 90 días, y el hash ya cubre la carrera | §4.2.2, §4.9 |
| OP-10 | media | El export complementario crea una NP de ISIS sin identidad en Virgilio | **Aceptada**: el complemento es una fila de `np_map` (parte 91..99, `complemento_de`), con su `np_prov`, sus líneas, su NP de ISIS y su propia `Facturacion_NP`; bloqueado en la app hasta la fase 7. Por eso la parte pasó a 2 dígitos | §4.8, D8 |
| OP-11 | media | Un `UNIQUE(np)` en Prog puede vaciar la PPP en el próximo push | **Aceptada** como índice único **parcial** (`where origen='web'`). Se **descarta** la segunda mitad de la objeción (un trigger que rechace las NP `sheet` duplicadas con aviso): agrega comportamiento al camino del Sheet, que es justo lo que se quiere dejar intacto, y el `max()` de hoy sigue tolerándolas. Coincide con DA-4 y TE-3 | §4.5, §6.1 |
| OP-12 | media | Los avisos de tracking por WhatsApp se apagan para los clientes del piloto | **Aceptada** como prerrequisito de la fase 6: `pedidos_web_estado` alimenta `order_tracking`. **Corregido el mecanismo** (v): el tracking se carga con `parseTrackingSheet` (`admin.js:2413`), su `np_number` es la **NP de ISIS** y no el `order_id`, y los estados son `programado`, `a_programar`, `enviado` y `retirado` | §4.2.4, §6.4, riesgo 23 |
| OP-13 | baja | `Codigos_ISIS_Map` no es un mapa de artículos de venta | **Aceptada** (v: 1.595 filas de rubros Proceso, Materia Prima e Insumos). Referencia sacada de H7 y §5; la prueba es el dry-run del Paso 0. **Se agrega** que el reemplazo que proponía el borrador también estaba mal: `029→437E` vive en `Equivalencias_Familia`, no en `Equivalencias_Codigos` | §5 col 5, H7 |
| DA-1 | alta | Paso 0: la misma línea dos veces en `Entregas_Virgilio` duplica cajas en el Excel | **Aceptada**, con dos correcciones a la evidencia del crítico (v): las cantidades idénticas son **60** y no 61, y **la causa no es el formato de `fecha_salida`** — `entregas_virgilio_dedup()` compara `np\|tanda\|cod_art` más las cajas y no mira esa columna. Las causas reales son tres: re-armado en otra tanda (13), filas anteriores al trigger del 27/08 más artículo repetido legítimo (44) y filas con `tanda` nula (14) | §2, §4.6, §11.1 |
| DA-2 | alta | La frontera tilde → camión no es de 39,7 h: p10 3,5 h y 51 NP en 2 h | **Aceptada** (v). SLA en el mismo turno, guard de CCN en la app con aviso (sin `RAISE`, para no envenenar la cola offline), aviso en el cierre, y la expresión regular cubre lo que igual entró. **Verificado (v):** 3 CCN de 687 caen hoy antes del tilde, así que el caso es real y el guard no es teórico | §3, §3.6, §4.7, riesgo 18, D18 |
| DA-3 | alta | Sacar `Facturacion_NP` del tilde deja sin NP web al cierre, al PDF y a "Armar ruta" | **Aceptada**, y **manda sobre el borrador junto con TE-8**, que pedía lo contrario: `Facturacion_NP` se escribe en el tilde de siempre, post-factura y con la NP real, así que el cierre, el PDF y el ruteo no cambian. Se **descarta** la alternativa que proponía el propio crítico (escribirla al tilde aunque sea con la provisoria): dispararía `wa_np_facturado_trg` sin factura, que es exactamente TE-8 | §4.7 |
| DA-4 | alta | Un `UNIQUE(np)` rompe el push del Sheet (lotes de 500) | **Aceptada**: índice único parcial (ver OP-11) | §4.5 |
| DA-5 | alta | Las ediciones reales pasan horas después: "hasta el push" las bloquea todas | **Aceptada** (v: entre 1 min y 19 h; 2 de 7 dentro de 5 min). "Editable hasta que tenga tanda" desde la v1, con Virgilio como autoridad, `rechazado` con aviso y "Cancelar tramo" para la operadora. **Se agrega un matiz que el crítico no marcó** (v): hoy `isOrderEditable` corta en el cutoff de las 12:30, así que la regla nueva no sólo desbloquea, también **amplía** la ventana; por eso D4 ofrece la variante con techo de 24 h | §4.9, D4 |
| DA-6 | media | El botón del Paso 0 vive en la pantalla diaria y el archivo es importable tal cual | **Aceptada**: archivo `PRUEBA_NO_IMPORTAR_*`, leyenda en la hoja "Resumen" y botón oculto (`?isisTest=1` más mail autorizado) hasta la fase 5 | §11 |
| DA-7 | media | `condPago` del Paso 0: el mapa de textos no resuelve ~30 % y el código ya viaja en el payload | **Aceptada** (v: `condicion_pago_code` está en el 100 % de los pedidos y los textos no tienen tasa). Columna `condicion_pago_code` en `v_pedidos_match` y `lk_pedidos_match`, mapa de textos eliminado, sujeto a D11. **Confirmado además** que sin esa columna la RPC del borrador ni siquiera corre: falla con `42703` | §5 col 10, §11.1, D11 |
| DA-8 | media | Chef en el Paso 0 sale sin sucursal en más del 90 % y el plan lo tapaba con el promedio global | **Aceptada** (v: 50 de 57 filas chef sin sucursal; 65 NP Chef de 450). Cobertura por empresa en §5 y §10, Chef fuera del Paso 0, y la sucursal en `v_pedidos_match_chef` como precondición de la fase 8. **Se agrega** que el vendedor tiene el mismo sesgo: LK 99 % contra Chef 38 % | §5, §10, §4.11 |
| DA-9 | media | No hay dónde escribir "FACTURAR EN SEPTIEMBRE" ni "11:00Hs" | **Aceptada** (v: esos textos están en la tabla): `ppp_programar()` con `p_observaciones` y `p_no_facturar_hasta`, y el checklist del export excluye lo que todavía no debe facturarse | §4.5, §4.7, §4.12 |
| DA-10 | media | LK sí ve la provisoria: `trg_virgilio_entrega_to_formato` es sólo INSERT | **Aceptada** (ver OP-6) | §3.5 |
| DA-11 | media | El desempate de sucursal por `match_string` falla con los pedidos partidos | **Aceptada, y el arreglo del borrador tampoco servía.** Verificado ejecutando la RPC: comparaba `31x1,35Ex1,…` (con `ltrim`) contra `031x1,035Ex1,…` y daba falso casi siempre — resolvía 10 de 29 casos con más de un candidato. Diseño final: **score por conjunto de códigos**, que da 355 NP con score ≥ 0,9 y resuelve 39 de 48, más ⚠ cuando hay dos sucursales empatadas | §5 col 8, §11.1 |
| DA-12 | baja | "Bajar dos reportes" no desaparece mientras exista una NP no web, y "Cargar NP manual" no estaba definido | **Aceptada**: §1.1 fila 5 dice "queda hasta la fase 9", y el formulario mínimo está definido (NP real, código, líneas; el m³, el `uxb` y la zona los calcula la misma función), a cargo de quien carga en ISIS | §1.1, §4.10 |
| DA-13 | baja | "Ninguna tabla nueva" en el Paso 0 no era cierto | **Aceptada**: inventario exacto (1 RPC, 0 tablas, desempate inline; la columna de LK sólo con D11) | §11.1 |
| TE-1 | alta | El sello doble no evita la doble entrada: el filtro del piloto vivía sólo en el push | **Aceptada**: filtro en `procesar-pedidos-db` v10, `enviar_pedidos_main()` corriendo el push antes, y el push respetando `enviado_a_compras_at`. **Se agrega** el límite práctico: si la lista de piloto crece, el filtro por URL deja de entrar y la Edge Function pasa a leer la tabla | §4.2, §6.2, riesgo 4 |
| TE-2 | alta | El trigger que re-mapea por `np_map` repite el patrón del incidente del 28/08 | **Aceptada**: todas las trigger fns nuevas van `SECURITY DEFINER` con `REVOKE EXECUTE` sobre la función, y `tests/anon-writes.cjs` es criterio de "listo" en las fases 1 y 5. **Nota (v):** ese test y el checklist de migraciones **todavía no existen** en el repo; los crea este proyecto | §4.13, §7, riesgo 16 |
| TE-3 | alta | Un `UNIQUE(np)` convierte un duplicado del Excel en una tabla vacía | **Aceptada**: índice único parcial (ver OP-11) | §4.5 |
| TE-4 | alta | El push no es idempotente ante un commit a medias del FDW | **Aceptada**: por fila, con `select` remoto → `insert` / `delete+insert` / `update`, bloque `exception` por pedido y `pedidos_web_push_log`. Se ajusta el "delete + insert" a secas que proponía el crítico: si la fila remota ya está `aplicado`, un delete la resetearía a `nuevo` y la volvería a aplicar; ahí va `update` con `version + 1` | §4.2.3, riesgo 15 |
| TE-5 | alta | Sin `connect_timeout` ni tope, un Virgilio caído apila jobs en LK | **Aceptada** (v: el server no tiene `connect_timeout` ni `batch_size`): `ALTER SERVER … connect_timeout '10', batch_size '100'`, `statement_timeout 60s`, `pg_try_advisory_lock`, y prueba de Virgilio caído en la fase 2 | §4.1, §4.2.1, §7 f2, riesgo 14 |
| TE-6 | media | El rollback "en 5 minutos" no existe para lo ya empujado | **Aceptada**: RPC `rollback_pedidos_web()` en una transacción por FDW, con runbook, y el heartbeat como confirmación de que el cron está apagado | §4.9, §6.3 |
| TE-7 | media | El renombre olvida lo que ya salió con la provisoria y recalcula el stock N veces | **Aceptada** (v: `trigger_actualizar_saldo_stock` es AFTER INSERT OR UPDATE sin `OF` y la función sólo lee cuatro columnas): `ALTER TRIGGER … UPDATE OF` en la fase 1, más el re-post de `pa_entregas`. **Se agrega un segundo trigger que el crítico no vio** (v): `trg_corregir_secundario_auto` es `UPDATE OF articulo, pedido`, así que el renombre de Base lo dispara y hay que renombrar `Correcciones_Pedido` **antes** para no chocar con su PK | §3.5, §7 f1, riesgo 12 |
| TE-8 | media | `confirmar_np_isis` insertaba `Facturacion_NP` con `facturado_at = now()` antes de la factura | **Aceptada**: dos estados, `importada` y `facturada`, y `Facturacion_NP` recién en el tilde post-factura (ver DA-3). Como consecuencia, el drenaje de stock **ya no se mueve** al backend en esta idea | §4.7 |
| TE-9 | media | Las trigger fns de coexistencia corren como el invocador y `pppSubir` las va a pisar | **Aceptada**: `SECURITY DEFINER` más REVOKE en `ppp_protege_origen_web` y `ppp_cuarentena_sheet`, y checklist del runbook en la fase 1 | §6.1, §4.13 |
| TE-10 | media | `Pedidos_Web` revocada contradice la pantalla de errores y expone datos comerciales | **Aceptada**: vista `v_pedidos_web_estado` sin `leyenda2` ni `items`, más RPC con chequeo de supervisor; `np_map` igual, sin policy directa | §4.1, §4.13 |
| TE-11 | media | `lk_ppp_reader` pasa a alimentar una tabla que se convierte en NP, sin validación | **Aceptada** en el consumidor: `aplicar_pedidos_web()` valida cliente, artículos, cajas, tope y ventana de `order_id`. El `REVOKE … FROM lk_ppp_reader` sobre todas las funciones se **matiza**: el grant viene de `PUBLIC` (238 funciones por herencia, v), así que hay que revocar de `PUBLIC` función por función, y eso es un proyecto aparte que no bloquea. **Se agrega** cuál es el padrón contra el que validar: `clientes_vendedor` (1.245 códigos) o una NP histórica | §4.3.2, §4.13, riesgo 24 |
| TE-12 | media | El branch nace con los crons activos y URLs de producción adentro, y no hay `supabase/migrations` | **Aceptada**, con el número corregido (v): son **47 jobs, 46 activos**, no "60+", y las funciones con la URL de LK adentro son cuatro, nombradas en el riesgo 28. Branch creado con los crons desactivados y los hosts reemplazados, comparando esquemas antes de probar | §12.2, §12.5, riesgo 28 |
| TE-13 | media | Chef depende de un tercer proyecto que nadie controla y su mail no lo sella LK | **Aceptada**: precondiciones explícitas de la fase 8 (inventario del proyecto Chef, grant o tabla de sellos, sucursal y condición en la vista) y Chef fuera del piloto **en los dos lados** | §4.11, §6.2, §7 f8 |
| TE-14 | baja | `orders_delete_own` deja borrar un pedido ya empujado | **Aceptada** (ver OP-8). La cola `pedidos_web_cancelados` que proponía el crítico se **descarta**: con la policy, el borrado post-push deja de existir, y la cancelación va por `cancelar_pedido` más `estado='cancelado'` en el push | §4.9, §7 f2 |
| TE-15 | baja | El plan no suma nada a `tests/run.sh` y el Excel se valida a ojo | **Aceptada**: `fac-excel-isis.cjs` (fase 0), `emp-np.cjs` ampliado y `anon-writes.cjs` (fase 1), `np-particion.sql` (fase 3) y `ppp-programar-rpc.cjs` (fase 4), con `run.sh` en el CI de la copia | §7, §11.5, §12.4 |
| TE-16 | baja | El backup "antes de cada DDL" no cubre el UPDATE masivo diario del renombre | **Aceptada**: `np_rename_log` en la misma transacción más `deshacer_np_isis()`, que aborta si alguien escribió encima. Ese log **es** el backup que pide el protocolo | §3.7, §6.3, riesgo 1 |

**Contradicciones resueltas.**

1. **DA-3 contra TE-8.** DA-3 pedía que `Facturacion_NP` se escribiera en el tilde aunque fuera con la provisoria; TE-8 pedía no escribirla hasta que exista la factura. Se toma la **consecuencia** de DA-3 (el cierre, el PDF y el ruteo no pueden quedarse sin las NP web) y el **mecanismo** de TE-8 (dos estados, y `Facturacion_NP` sólo con la factura real). Lo que hace compatibles a las dos es el SLA que exige DA-2.
2. **OP-11 contra TE-3** sobre el trigger que rechazaría duplicados del Sheet: manda TE-3, no se agrega comportamiento al camino del Sheet.
3. **OP-9** ("armar los ítems desde `order_items`") contra la fidelidad del payload: manda el payload, con el hash de consistencia como guarda.
4. **OP-3 y DA-1** apuntan al mismo hecho desde dos lentes y las dos se quedan cortas: la verificación mostró que "última fila" pierde líneas, así que el diseño final suma por tanda vigente.

---

## Anexo — puntos del código que toca cada fase (referencia rápida)

Todas las líneas están verificadas contra HEAD el 2026-09-02.

| Archivo / objeto | Líneas / nombre | Fase |
|---|---|---|
| `index.html` Facturación | `.fac-cierre` (CSS `:3069`); `facBtnCierre` `:3496`; `facRender` `:33799`; `facRenderTicked` `:33776`; `_facEsOperadora` `:33976`; `facAuthWriteHeaders` `:33957`; `facFCEnsureModal` `:34033`; `_facNpsHoyReal` `:32213`; `window.facTickNP` `:34163`; `generateFacturacionPDF` `:34462`; endpoint `Facturacion_Cierres` `:4144` | 0, 5 |
| `index.html` PPP | `PPP_READONLY` `:28132`; `pppRenderProg` `:28212`; `pppAutoBaseN` `:26209`; `_pppComputeSugerencia` `:26354`; `_pppScheduleTandas` `:26452`; `pppConfirmarProgramar` `:26505`; `PPP_EDITS_KEY` `:26145`; `PPP_CFG_KEY` `:26170`; `pppSubir` `:28424`; `pppFindNpPdf` `:26826`; `pppTandaM3Map` `:25715`; `_pppMetaEntSet` `:25740`; `_pppNpsCompact` `:27588`; `pppEsSuper` `:25567` | 4, 5, 9 |
| `index.html` stock y drenaje | `stockSalidaFacturadoNP` `:22781` (**no se toca** en esta idea); `stockDrenarCPFacturado` `:22812` | — |
| `index.html` empresa por NP | `empresaDeNp` `:7370`; `pkCodEmpresa` `:7375`; `pkNpEsLoeke` `:8034`; `_pppOrderDirsForNp` `:26866` (ya usa el primer dígito, **no se toca**) | **1** (en los dos repos) |
| `index.html` carga de camión, CP y ruteo | Pantalla de CCN (guard de NPV, `opcion: "CCN"` en `:23177`); CP y RC (bloqueo sobre las exportadas); `openRuteo` `:28022`; `stkOpenNpFaltan` `:14236` | 5, 7 |
| `index.html` monitor y cola offline | `fetchMonitorFromSupabase` `:30599`; `enqueueReport` `:6246` y `QUEUE_KEY` `:6138` (por qué el guard no usa `RAISE`) | 5 |
| `index.html` identidad | `SUPERVISOR_EMAILS` `:35087` (los mismos tres mails de `ppp_prog_write_sup`); `window.sbAuth` `:35526`; `requireSupervisor` `:24693` | 0, 4, 5 |
| SQL de Virgilio | `empresa_de_np()` (`sql/empresa_de_np.sql`), `vista_faltante_real`, `vista_faltante_demanda`, `vista_nc_loeke_chef`, `actualizar_saldo_trigger` / `trigger_actualizar_saldo_stock`, `corregir_pedido_secundario_auto`, `trg_facturacion_np_validar`, `revertir_drenaje_facturado`, `wa_np_facturado_trg`, `fn_virgilio_entrega_to_formato`, `entregas_virgilio_dedup`, `canon_cod_art_val`, `norm_cod`, `sync_ppp_entregados_meta()` (`sql/sync_ppp_entregados_meta.sql`), `ppp_autozona`, `fn_norm_ppp_*`, `watchdog_syncs_externos`, `watchdog_frescura_datos`, `tg_enqueue(p_text, p_dedup, p_chat, p_parse_mode)` | 1, 3, 5 |
| SQL de LK | `submit_order_fast`, `edit_order_fast`, policies `orders_delete_own` y `orders_update_own_sheets`, `sync_pedidos_match_virgilio` con `v_pedidos_match` / `v_pedidos_match_chef` (`sql/pedidos_match_virgilio.sql:63` y `:190`; columna `condicion_pago_code`), `enviar_pedidos_main`, `postear_envio_pedidos`, cron `procesar-pedidos-web`, server `virgilio_db` | 0 (D11), 2, 8, 9 |
| Front de LK | `script.js:1815` `isOrderEditable`; `:7047` `_submitSingleOrder` y `:7252` la escritura del payload; `admin.js:2413` `parseTrackingSheet` y `:2549` las filas de `order_tracking` | 2, 6, 7 |
| Edge Functions de LK | `procesar-pedidos-db` v9 → **v10** (filtro del piloto; `processOrders`, `generateExcel` y `statusFields` se portan a Virgilio); `virgilio-entrega-sync` (acción `rename`) | 2, 5 |
| Apps Script | `apps-script/sync-ppp-supabase.gs:61` `pushPPPToSupabase_`, `:84` `_pppSupaReplaceAll_`, `:90` el DELETE, `:97` los lotes de 500. "Carga PPP.gs" está fuera del repo: **no se toca** | — |
| Tests | `tests/run.sh`; nuevos `fac-excel-isis.cjs`, `np-particion.sql`, `ppp-programar-rpc.cjs` y `anon-writes.cjs`; `emp-np.cjs` ampliado | 0, 1, 3, 4 |
| Documentación a actualizar al construir | `GUIA-PROYECTO.md` (PPP, Facturación, estados de `np_map`, `lk_pedidos_match`), `CLAUDE.md`, `docs/CHECKLIST-MIGRACIONES.md` (crear), y en `sql/`: `pedidos_web.sql`, `np_map.sql`, `facturacion_export_isis.sql`, `confirmar_np_isis.sql`, `ppp_programar.sql`, `ppp_archivar_web.sql`, `ppp_cuarentena_sheet.sql`; en LK `sql/sync_pedidos_web_virgilio.sql` y `sql/rollback_pedidos_web.sql`; `docs/integracion-isis.md` (P1 a P5 redefinidos) | cada fase |
