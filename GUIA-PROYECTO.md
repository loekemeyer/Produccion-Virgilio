# Guía del Proyecto — Producción Virgilio

> Guía viva de referencia. Documenta **cómo funciona el programa** y **de dónde
> salen los datos**, para poder responder preguntas con precisión y sin inventar.
> **Mantener actualizada en cada cambio del proyecto** (ver § "Mantenimiento").
>
> ⚠️ **REGLA DE ORO — NUNCA EMPARCHAR.** Nada se resuelve con un parche/band-aid:
> siempre se arregla **en el lugar donde está la causa** (la tabla, la vista, la
> función o el módulo que corresponde). Nada de tapar el síntoma en otra capa
> (ej. corregir en el front lo que está mal en una vista, o duplicar un dato en
> otra tabla para que "se vea bien"). Si un dato ya existe, se lee de su **fuente
> única**; no se replica. Ante la duda entre parche rápido y fix de raíz → **fix
> de raíz**.
>
> Última actualización: 2026-09-02 · Versión app al documentar: **v12.48**
>
> Nota **2026-09-02** — **Legajo 277: 185 reportes atascados ("sin enviar") — NO era señal, era un timeout de 8 s en un trigger, y la cadena de stock EN VIVO documentada.**
> **Síntoma:** el legajo 277 mostraba "185 reportes sin enviar" y la app trabada. Diagnóstico
> sobre `Auditoria_Produccion_Virgilio`: 131 `client_id` distintos fallando con **`server_500`**
> (no `network`), hasta 230 reintentos, y **0 de ellos en `Registros_Produccion_Virgilio`** → el
> server los rechazaba de verdad. Eran picking (`PKC`) de la tanda **D56A**; el último PKC de 277
> había entrado 10:50, los 500 arrancaron ~14:47.
> **Causa raíz:** cada `INSERT` de PKC dispara reconciliación de stock. El trigger
> `trg_pkc_reconciliar_stock` corría `reconciliar_pipeline_stock_etapa1()` — una reconciliación
> **GLOBAL** (todos los artículos, path A histórico + path B forward) que medida en frío tarda
> **~8,8 s**. El rol `authenticated`/`anon` corta a los **~8 s** (`statement_timeout`) → cada PKC
> daba timeout → **500** → el reporte quedaba en la cola local del celular (`localStorage`
> `legajo_queue_virgilio_v1`). A la mañana entraba (<8 s); cruzó el límite ~14:47 al crecer los datos.
> Desde el SQL editor (rol `postgres`, sin ese timeout) el mismo INSERT entraba a los 8,87 s — por eso
> "en la base sí, en la app no".
> **Que NO se perdía data:** `Registros_Produccion_Virgilio.client_id` es UNIQUE y PKC va por
> UPSERT (`?on_conflict=client_id`, `resolution=merge-duplicates`; 409 se trata como OK en
> `trySendOneReport`). Reenviar es idempotente, no duplica. El único escenario real de pérdida era que
> el operario **borrara datos / desinstalara** con la cola llena.
> **Fix (de raíz, no parche):** la reconciliación global de 8,8 s **no va en el hot-path del
> INSERT** — ya la corre el cron `reconciliar-pipeline-stock` (`*/10`, llama a
> `reconciliar_pipeline_stock()` = etapa1+2+3+4). Se **desactivaron** los triggers
> `trg_pkc_reconciliar_stock` y `trg_tp_reconciliar_stock` (la copia global redundante). Quedó
> **ON** `trg_pkc_reconciliar_rt` → `reconciliar_stock_articulo_rt(tanda, art)`, que hace SOLO el
> path forward acotado **al artículo pickeado** (~95–270 ms). Resultado: INSERT de PKC pasó de
> **8872 ms → ~95 ms**, sin 500. Los **131/131** reportes trabados entraron solos al destrabar
> (idempotencia). El histórico (picks anteriores a `Stock_Config.etapa1_pkc_desde` = 2026-08-13) lo
> sigue cubriendo el cron; lo del día (forward) es en vivo.
> **Cadena de STOCK EN VIVO (verificada end-to-end, pick de 7 movió `separar_pedidos` 5→12):**
> (1) operario pickea → INSERT PKC; (2) `trg_pkc_reconciliar_rt` escribe el/los `Movimientos_Stock`
> del artículo (misma tx); (3) `trigger_actualizar_saldo_stock` → `actualizar_saldo_trigger`
> recalcula el saldo del código por depósito y lo **UPSERT-ea en la tabla `stocks_carga_rapida`**
> (misma tx); (4) `stocks_carga_rapida` está en la publicación `supabase_realtime` (REPLICA IDENTITY
> FULL) → el cambio se **empuja por websocket**; (5) el front (`stkSubscribeRealtime`, escucha
> **`UPDATE`**) parchea la fila en `_stk.viewRows` y llama `stkRender()`. **La pantalla de Stocks lee
> `stocks_carga_rapida` como fuente principal (saldos instantáneos), NO `vista_stock_procesada`.**
> Con "En vivo" puesto y la pantalla abierta, PICKEADOS sube y GÓNDOLA baja al toque. Caveats: escucha
> solo `UPDATE` (un código sin ningún movimiento previo entra como INSERT y no repinta hasta recargar);
> solo en modo "En vivo" y con websocket conectado.
> **`vista_stock_procesada` NO hace falta que sea "en vivo":** es una **vista materializada** (cron
> `refresh-vista-stock-procesada` `*/2`) que el front usa solo para campos **derivados/lentos**
> (cajas_pedidas, proy_cajas_mes, capacidad_gondola, línea, descripción) — nada de eso cambia al
> pickear. Hacer una matview refrescar por-pick (`REFRESH MATERIALIZED VIEW`, recálculo completo de
> segundos) es justo el anti-patrón que trababa el INSERT. `refresh_stocks_carga_rapida()` (cron
> `*/5`) es un recálculo completo de respaldo contra drift del trigger incremental.
> **Cartel de alerta fuerte (HECHO, v12.46):** `updatePendingIndicator()` ahora distingue los
> reportes RECHAZADOS por el servidor (los que tienen `lastErr` que NO empieza con `network`) de los
> que solo esperan señal. Si hay alguno rechazado, el banner `#pendingIndicator` toma la clase
> `.critical` (rojo sólido, pulsante) y el texto cambia a *"⛔ N reporte(s) RECHAZADOS por el servidor
> (NO es falta de señal). NO cierres ni borres la app. Tocá para reintentar y avisá a sistemas."* Los
> pendientes solo por falta de red siguen con el aviso ámbar de siempre. Se limpia solo cuando la cola
> drena.
>
> Nota **v12.37** — **Facturación: descuento por VOLUMEN por empresa + listas de SÚPER/distribuidora.**
> Dos arreglos al cálculo del 💵 Neto (`vista_facturacion_neto`, EN VIVO, `sql/facturacion_neto.sql`):
> **(1) `dto_vol` por `(cod_cliente, EMPRESA)`.** `clientes_dto` pasó a PK compuesta
> `(cod_cliente, empresa)` y la Edge Function `sync-clientes-dto` ahora trae los DOS padrones
> (LK `customers.dto_vol` → `'lk'`; Chef `customers.dto_vol` → `'chef'`, vía secreto
> `CHEF_SERVICE_KEY` — el `customers` de Chef tiene RLS, la publishable key devuelve 0). Antes el
> join era solo por código y una NP de Chef tomaba por AZAR el descuento del cliente LK con el mismo
> número (numeraciones independientes). La empresa se deriva de la NP: `^9`=lk, resto=chef. Chef
> tiene 430 clientes con dto (prom 12%), más fuerte que LK (7,5%).
> **(2) Clientes de SÚPER/distribuidora se valorizan con su lista negociada**, no con lista general
> × dto. Si el cliente está en `cobranzas_cliente_cadena` (cadena con lista especial), se usa
> `cobranzas_precios_super` (que ya aplica `item_discount`), **SIN `dto_vol` y SIN el 2% web** — el
> súper no paga el descuento web. Por eso el 2% ahora se aplica **por línea** (columna `factor_web`
> = 1 súper / 0,98 resto) en vez de sobre el subtotal. Artículo fuera de su lista → cae a general.
> Cadenas con `usa_lista_general=true` (ej. Messina) NO son súper acá: van como cliente normal.
> Verificado contra ISIS (`isis_lk`/`isis_ch.documentos`): Coto/Diarco/INC/Abastecedor ≈ 0%;
> **La Anónima** requirió cargar su `item_discount=0.19` en `cobranzas_super_cadena` (quedó ≈ 0%);
> **GM** (Distribuidora GM S.R.L., cod lk 4080) es una **distribuidora con lista propia** cargada a
> mano desde el Excel del ERP (por caja → convertida a por-unidad; NP 97890 pasó de −42% a −6,6%,
> la lista parece ~6% desactualizada). **Pendiente de DATO** (la lógica ya está): Cencosud/Dorinka
> (súper de Chef) sin lista de artículos cargada → caen a general; Toledo/Alberdi/Día/Libertad con
> lista pero sin FC para validar. **Salud del cruce (2 meses): 89,3% de las NP matcheadas cuadran
> ≤5% vs ISIS** (el ISIS parseado arranca en junio 2026; antes no hay con qué comparar).
>
> Nota **v12.36** — **Baja de racks → góndola ahora es ATÓMICA (backend).** Antes los
> dos flujos de operario (`brConfirmar` = orden de racks; `rkbConfirmar` = RKB "De los
> racks") hacían **dos POST sueltos**: `stockMove` (los 2 `Movimientos_Stock` racks−/góndola+)
> por un lado y un POST a `Racks_Bajadas` por otro. Si uno impactaba y el otro no, la
> bajada quedaba **'aprobada' sin su par `baja_racks`** → descuadre (racks inflado, góndola
> corta). Detectado el 2026-09-02: 5 bajadas rotas (id 111·583E·96, 110·582E·48, 10·438E·63,
> 9·438E·3, 5·438E·15), corregidas a mano insertando el par faltante (`client_id LIKE
> 'fix-baja-racks-%'`). **Fix de fondo:** RPC `registrar_baja_racks(p_items jsonb)`
> (SECURITY DEFINER, grant anon/authenticated) que inserta la fila de `Racks_Bajadas`
> 'aprobada' + los 2 movimientos en **UNA transacción**, idempotente por `client_id`
> (`Racks_Bajadas.client_id` nuevo + índice único parcial; `Movimientos_Stock` ya tenía
> `mov_stock_clientid_dedup`; ambos con `ON CONFLICT DO NOTHING`). El front llama `postBajaRacks(items)`
> (offline-safe, cola `vir_baja_racks_pend`, reintento en `online`). `cajas` del ítem = delta
> del movimiento (INNER en RKB). Test `racks-propuesta.cjs` actualizado al nuevo contrato.
>
> Nota **v12.35** — **Panel Web LK: entrada directa sin OTP desde Virgilio.**
> El botón "🌐 Panel Web LK" ahora pasa el `access_token` de la sesión del
> supervisor (mismo origen, vía `sessionStorage` `lk_bridge_vjwt`) al admin LK.
> La Edge Fn `admin-login-otp` gana la acción `bridge`: valida ese token
> **server-side** contra el auth de Virgilio (`hrxfctzncixxqmpfhskv`) y, **sólo si
> el mail == `loekemeyer.n8n@gmail.com`** (mismo dueño, no amplía acceso), setea
> el password temporal y el admin entra sin pedir código. Si no hay token o el
> mail no coincide, cae al login por OTP de siempre. Gate 100% en backend (el
> front no puede falsear identidad). Detalle en `CLAUDE.md` § Panel Web LK.
>
> Nota **v12.34** — **Dos pendientes chicos de Deudores/Extracto banco, resueltos.**
> (1) **"📄 Ver factura"** en el detalle de Deudores: `storage_path` ya venía en
> `deudores_detalle` desde v12.25 pero no había forma de abrirlo — los PDF del
> ISIS viven en buckets PRIVADOS (`isis-lk`/`isis-ch`; verificado: los 31.433
> documentos de `isis_lk.documentos` tienen `storage_path` y el archivo existe
> de verdad en el bucket). Se agregaron 2 policies de `storage.objects`
> (`sql/deudores.sql`) que reusan `es_supervisor_virgilio()` — mismo patrón que
> ya usaba este proyecto para gatear storage por email (`planify_updates_download`,
> preexistente, no inventado ahora). El front pide un signed URL de 60s
> (`sb.storage.from(bucket).createSignedUrl(...)`) y lo abre en pestaña nueva.
> Verificado con `auth.jwt()` simulado: anon/no-supervisor → 0 filas visibles,
> supervisor real → 1. (2) **Extracto banco: "Aplicar" ahora puede imputar a
> una factura puntual**, no solo cobro general — el backend ya lo soportaba
> desde v12.33 (`banco_movimiento_aplicar` acepta `p_documento_id`) pero
> faltaba la UI; ahora, si el deudor tiene facturas abiertas, ofrece elegirla
> antes de aplicar (mejora la precisión del desglose por tramo con el tiempo).
> Sin backend nuevo para esto — solo front.
>
> Nota **v12.33** — **Extracto banco: quinta pestaña del overlay 💰 Deuda/Cobranzas,
> primer paso real hacia cobros automáticos por CUIT.** Objetivo final del usuario:
> que el extracto bancario de Interbanking se lea solo y acredite los cobros contra
> Deudores sin intervención manual. Investigado (2026-09-01/02): Interbanking SÍ
> tiene una API REST oficial para esto (`developers.interbanking.com.ar`, producto
> "Extractos"/"Consulta de Movimientos", OAuth2) — pero el registro de desarrollador
> está **cerrado al autoservicio** ("La incorporación de autoservicio está
> inhabilitada para este sitio"), hace falta que Interbanking lo habilite a mano
> (pedido en curso vía el chat de ayuda → InterAPIs → Ayuda en el ingreso →
> Chatear con una persona, fuera de horario al momento de escribir esto). Mientras
> se espera esa habilitación, se armó el mismo pipeline que va a usar la API el día
> de mañana, pero alimentado A MANO: un supervisor exporta el extracto desde
> Interbanking (Consultas → Extracto de cuenta → Excel) y lo sube en esta pestaña.
>
> **Backend** (`sql/banco_movimientos.sql`): tabla `banco_movimientos` (un
> movimiento = una fila, `cuit_norm` normalizado igual que `deudor_id` en
> Deudores) con dedupe real (índice único sobre cuenta+fecha+concepto+
> comprobante+importe+descripción+cod op — resubir un período superpuesto no
> duplica). `banco_movimientos_importar(...)` (alta en lote desde el Excel ya
> parseado en el navegador), `banco_movimientos_pendientes(...)` (CREDITOS con
> CUIT sin aplicar, con el deudor que matchea al frente si existe),
> `banco_movimiento_aplicar(...)` (acredita como `deuda_cobros` general y marca
> el movimiento usado — no se puede aplicar dos veces), `banco_movimiento_
> ignorar(...)` (para lo que no es un cobro real, ej. transferencias entre
> cuentas propias). Las 3 de escritura piden `es_supervisor_virgilio()` (v12.32).
>
> **Formato real del extracto** (verificado con un export real de Santander Río
> vía Interbanking, cuenta de Tierra Nativa SA — empresa de prueba, no
> Loekemeyer todavía): cabecera de metadata + tabla `Concepto/Cod.Op. | Fecha |
> Comprobante | Sucursal | Importe | Descripción | Cod.Op.Bco. | CUIT |
> Denominación | Saldo`. **El CUIT SOLO viene poblado en los `CREDITOS`**
> (transferencias recibidas) — todo lo demás (impuestos, comisiones,
> extracciones Banelco) lo trae vacío, así que el cruce sólo mira esas filas.
>
> **Validación real fuerte**: el CUIT de Tierra Nativa (30710305362) matcheó
> con un cliente REAL de Loekemeyer ya cargado en `isis_lk` (cód. 3878, mismo
> nombre) — confirma que el cruce por CUIT funciona de punta a punta contra
> datos reales, no sólo en teoría. Como esos movimientos eran transferencias
> entre cuentas propias de Tierra Nativa (no un cobro real de un cliente),
> sirvieron también para probar el botón "Ignorar": aplicarlos de más dejó al
> cliente con saldo **negativo** (-$2.500.000, en una transacción de prueba
> con rollback) — la razón de que "Aplicar" e "Ignorar" sean decisiones
> humanas y no automáticas todavía.
>
> **Front** (`index.html`): reusa el loader de SheetJS que ya tiene la PPP
> (`pppLoadXlsx()` → `vendor/xlsx.full.min.js`, sin CDN externo). El parser
> (`bancoParsearExtracto`) ubica la fila de encabezados por texto
> ("Concepto/Cod.Op.") en vez de por número de fila fijo, así tolera que el
> tamaño de la cabecera de metadata cambie. Pestaña con: input de archivo +
> nombre de banco, resumen (cuántos matchean vs sin cliente conocido), tabla
> con botones ✅ Aplicar / 🚫 Ignorar por fila.
>
> **Pendiente real**: el acceso a la API sigue sin confirmar del lado de
> Interbanking — hasta que llegue, este flujo manual es el camino. Cuando
> llegue, el reemplazo es sólo un cron/Edge Function que llame a
> `banco_movimientos_importar` con `origen='api'` en vez del botón — nada del
> resto del módulo cambia.
>
> Nota **v12.32** — **Gate real de backend para las 4 RPC que escriben dinero**
> (`deuda_registrar_cobro`, `deuda_anular_cobro`, `facturable_anticipado_reservar`,
> `facturable_anticipado_liberar`), decidido por el usuario tras el hallazgo de
> `auditor-supabase` de v12.31 (ver más abajo). Se agregó `es_supervisor_virgilio()`
> (`sql/deudores.sql`) — NO un secreto nuevo tipo `cp_is_admin`, sino un chequeo contra
> la sesión REAL de Supabase Auth (Google OAuth) que ya usan los supervisores en el
> front: `lower(auth.jwt()->>'email')` contra `SUPERVISOR_EMAILS` fijos + tabla
> `Supervisores_Virgilio`, mismo criterio que `isSupervisorEmail()` de `index.html`. Las
> 4 funciones ahora empiezan con `if not es_supervisor_virgilio() then raise exception`.
> Verificado simulando `auth.jwt()`: `anon` → rechazado, `authenticated` con email
> NO supervisor → rechazado, email supervisor real → pasa y ejecuta. `requireSupervisor()`
> del front sigue estando (evita el viaje al servidor para el caso común), pero ya no es
> la única barrera.
>
> Nota **v12.31** — **Dos huecos de diseño encontrados en auditoría propia sobre
> v12.30, cerrados el mismo día.** (1) **Facturable Anticipado no reservaba stock**:
> `vista_saldos_stock.terminado` sale solo de `Movimientos_Stock` (eventos de
> producción), sin ninguna relación con facturación ISIS — facturar anticipado desde
> el módulo no bajaba el stock disponible, así que el mismo stock se le podía volver a
> ofrecer a OTRO cliente en la misma pestaña antes de cargar el camión. Se agregó
> `facturable_anticipado_reservas` (tabla) + `facturable_anticipado_reservar`/
> `liberar`/`reservas_activas` (RPC): reservar resta el pool COMPARTIDO del artículo
> (todas las NP) y la demanda pendiente de la NP propia; se libera a mano cuando el
> movimiento físico real ya se registró. Verificado: reservar 50/200 cajas bajó el pool
> a 150 para el resto de las NP, liberar lo devolvió a 200. UI: botón "📦 Reservar" y
> lista de reservas activas con "Liberar" en el detalle de cada NP. (2) **Deudores
> mostraba deuda BRUTA para siempre**: no existía ninguna tabla de cobros/pagos en toda
> la base, así que un cliente que ya pagó seguía apareciendo como deudor sin límite. Se
> agregó `deuda_cobros` (registro MANUAL, interino hasta la conciliación automática
> contra el extracto de Interbanking, en diseño) + `deuda_registrar_cobro`/
> `anular_cobro`/`cobros_lista` (RPC). Un cobro imputado a un `documento_id` puntual
> netea el saldo de esa factura (`vista_deudores_documentos`); sin `documento_id` es un
> cobro general que `deudores_resumen` resta del total (columna `cobros_generales`) sin
> tocar un tramo específico. Verificado con un cobro real de prueba ($1.000.000 contra
> Cencosud, anulado después): el saldo bajó y subió exacto. UI: botón "💰 Cobrar" por
> factura y "💵 Registrar cobro general" en el detalle de cada deudor, con lista de
> cobros y "Anular". Se evaluó usar `isis_lk/isis_ch.comprobantes_aplicados` como
> fuente en vez de una tabla nueva — descartado: esa tabla vincula NC contra la factura
> que corrige, no cobros (`importe` viene null en la mayoría de sus 19 filas). **Ambos
> objetos nuevos verificados por `auditor-supabase`**: RLS + `REVOKE ALL` correctos
> (explotación real con `SET LOCAL ROLE anon` confirmó 0 acceso), `search_path` fijado,
> sin SQL dinámico.
>
> **Resuelto en v12.32** (ver nota arriba): el usuario decidió agregar el gate real de
> backend. Ya no queda pendiente.
>
> Nota **v12.30** — **Facturable ya: qué mercadería se le puede facturar a un cliente
> ANTES de cargar el camión.** Cuarta pestaña del overlay 💰 Deuda/Cobranzas
> (📦 Facturable ya). Pedido del usuario: de las NP que todavía no se armaron, ver qué
> artículos ya tienen stock en depósito para facturar y entregar esa parte ya, sin
> esperar a que la NP entera esté lista. **Backend** (`sql/facturable_anticipado.sql`):
> `vista_facturable_anticipado` cruza `PPP_Base_Pedidos` (lo pedido, por artículo) de
> las NP **pendientes** (no están en `Facturacion_NP`, no están en `NP_Canceladas`)
> contra `vista_saldos_stock.terminado` (stock disponible). **El stock es un pool
> COMPARTIDO** entre todas las NP pendientes que piden el mismo artículo — comparar
> cada NP contra el stock total sobre-contaría si dos NP piden lo mismo. Se reparte
> por **prioridad de `fecha_entrega`** (la NP con entrega más próxima primero, `np`
> como desempate) con una suma acumulada por *window function*: si el stock no
> alcanza para todas las NP que piden un artículo, a las de entrega más lejana les
> toca cobertura parcial o ninguna — nunca "todo o nada" por NP. Expone
> `cajas_cubribles` (cuánto de lo pedido se puede facturar YA) y `cubre_completo`
> (si cubre el pedido entero de ese artículo o sólo una parte). Valorización: misma
> fórmula que `vista_facturacion_neto` (`precios_venta × uxb × (1-dto_vol) × 0,98`) —
> mismas limitaciones ya documentadas ahí (súper no modelado → `es_super`; sin precio
> → `sin_precio`, no se inventa valor). RPC `facturable_anticipado_resumen` (agregado
> por NP, ordenado por $ estimado desc) y `facturable_anticipado_detalle` (por
> artículo), mismo patrón `SECURITY DEFINER` + `EXECUTE` a anon que el resto del
> módulo. Medido al armar esto: **141 NP pendientes con algo facturable ya, ~$200 M
> estimados, 97,7% de los artículos con cobertura completa** (no sólo parcial).
> Sólo lee y sugiere — no factura ni arma nada solo, la decisión la toma una persona.
>
> Nota **v12.29** — **Cruce Facturación vs ISIS: lo que calculamos vs lo que se
> facturó de verdad.** Tercera pestaña del overlay 💰 Deuda/Cobranzas: **🔍 Facturación
> vs ISIS**. Cruza, por NP, `vista_facturacion_neto.neto` (lo que Virgilio calcula
> sobre lo armado — la misma fuente de la columna 💵 Neto de Facturación) contra el
> `subt_gravado` real del comprobante emitido en el ISIS (`isis_lk`/`isis_ch.documentos`,
> el mismo dato que usa Deudores). Comparación apples-to-apples: los dos son neto SIN
> IVA (verificado: `subt_gravado + iva_21 + iva_105 = total`).
> **Matching**: por cliente (`canon_cod`) + fecha (±3 días de `fecha_salida`, mismo
> criterio que `vista_np_factura`) + cajas armadas vs cajas del comprobante, con
> tolerancia **relativa** (≤1 caja o ≤15%, lo que sea mayor). Sin esa tolerancia la
> vista elegía "el candidato menos malo" aunque no se pareciera en nada (llegó a
> emparejar una NP de 1 caja con una factura de 21 cajas de otro pedido del mismo
> cliente ese día) — daba diffs de hasta **16.940%**, puro ruido de matching. Con el
> umbral, promedio de la bolsa "diff" bajó de 66% a un dígito/decenas — la anomalía de
> julio (153% promedio ese mes) desapareció por completo, confirmando que era matching
> malo, no un problema real de esos meses.
> **Estados**: `ok` (dentro de tolerancia: máx($50, 1%)), `diff` (real y calculado
> difieren de verdad — 197 casos sobre 1.112 NP al armar esto), `ambiguo` (más de un
> comprobante candidato igual de cercano — no se adivina, se marca), `sin_factura`
> (NP facturada acá pero sin comprobante matcheado en el ISIS — puede ser que el
> agente local todavía no subió el PDF, o que la factura consolida varias NP y por
> eso sus cajas no matchean 1:1 con ninguna), `sin_neto` (la NP no tiene neto
> calculable — items sin precio, etc.). Se marca `es_super` (🛒) para los clientes de
> cadena de supermercado (`cobranzas_cliente_cadena`): **su diferencia es esperada**,
> `vista_facturacion_neto` no usa la lista negociada de súper (`precios_super`), sólo
> explican 13 de los 197 "diff" — la mayoría (184) es señal real, sin explicar
> todavía, para que alguien la abra caso por caso.
> **Backend** (`sql/cruce_facturacion.sql`): `vista_cruce_facturacion` (interna,
> REVOKE anon — un comprobante calculado-vs-real por NP), `cruce_facturacion_resumen`
> / `cruce_facturacion_totales` (RPC `SECURITY DEFINER`, `EXECUTE` a anon, mismo
> patrón que Deudores). Ventana por defecto: últimos 30 días (parámetros `p_desde`/
> `p_hasta` para ampliar). **Limitación conocida, no resuelta**: una factura que
> consolida varias NP del mismo cliente/día no matchea 1:1 contra ninguna
> individual — puede salir `sin_factura` o `diff` sin que haya error real;
> `candidatos_cercanos` en la vista ayuda a detectarlo. Sólo lee — no corrige nada
> solo, cada caso lo revisa una persona.
>
> Nota **v12.28** — **Módulo Deudores: reemplaza a "Deuda a cobrar" (v9.23/v11.68), que
> tenía 0 filas en producción.** El viejo dependía de tickear "Facturar" en el celular
> (`deuda_movimientos`, disparaba fire-and-forget y fallaba en silencio — nunca se vio
> el error) y revalorizaba a mano con precios de LK, duplicando lo que ya calculaba
> `vista_facturacion_neto`. Se **borraron** `deuda_movimientos`, `vista_deuda_saldo` y
> las RPC `deuda_registrar_facturado`/`deuda_registrar_cobrado`/`deuda_borrar_facturado`
> (0 filas, sin backup real que hacer — verificado antes de borrar). El módulo nuevo
> **lee `isis_lk`/`isis_ch.documentos` directo** (ver § 3b, esquema hasta ahora sin
> documentar): la deuda existe apenas se factura, no hace falta registrar nada.
> **Backend** (`sql/deudores.sql`): `cobranzas_escalones` (la escalera de descuento por
> pronto pago vigente — 14d 25%, 30d 20%, 45d 15%, 60d 10%, 90d 5% echeq, 120d 0% echeq
> — pública, config no dato de cliente), `deudores_condiciones` (mapa
> `condicion_venta`→días de plazo, sembrado con las 31 condiciones reales de las
> facturas 2019-2026; `dias=NULL` = sin plazo derivable, no se inventa), `cobranzas_excepciones`
> (plazo pactado por cliente que pisa la escalera general — vacía, pendiente que el
> dueño la cargue), `vista_deudores_documentos` (interna, REVOKE anon: un comprobante =
> una fila, deudor_id = **CUIT normalizado** — cruza LK y Chef sin tabla de mapeo,
> verificado: 674 CUIT en LK + 144 en Chef + 50 en ambas, sólo 1 comparte código de
> cliente), `deudores_resumen`/`deudores_detalle` (RPC `SECURITY DEFINER`, `EXECUTE`
> a anon — gateo por `requireSupervisor()` en el front, mismo patrón que
> `facturacion_neto_lote`/`cobranzas_resumen`). **Fase 1: deuda BRUTA** (no descuenta
> cobros — `cobrado` es una constante 0, el enganche para cuando el agente del ISIS
> empiece a parsear recibos es `isis_lk.comprobantes_aplicados`, hoy 19 filas). Por eso
> `deudores_resumen` acota a los **últimos 12 meses por defecto**: sumar todo desde 2019
> sin restar pagos da un número que no significa nada (se midió: **$8.900 M** sólo en el
> tramo +90 de LK contando la historia completa). **Front** (`index.html`): el botón
> **💰 Deuda a cobrar / Cobranzas** (ya existía) ahora pinta desde `deudores_resumen` —
> tabla por cliente con saldo, peor tramo, próximo corte de descuento (escalón + fecha
> + %) y filtro por empresa/tramo/búsqueda; "Detalle" abre el historial de comprobantes
> de `deudores_detalle`. Se sacó el botón "+ Registrar cobro" (escribía a una tabla que
> ya no existe) — vuelve cuando haya de dónde leer un cobro real (conciliación bancaria
> / Interbanking, pendiente). Se sacaron los hooks muertos `deudaRegistrarNP`/
> `deudaBorrarNP` del flujo de tickear/revertir Facturación (ya no hace falta registrar
> nada ahí) y las constantes `SUPABASE_LK_URL`/`SUPABASE_LK_KEY` del front de Virgilio
> (sin otro uso en el repo, verificado por grep — la key de LK sigue en `admin/admin.js`).
> **Pendiente, no resuelto en este pase:** el bot de Cobranzas de WhatsApp que dispare el
> reclamo (repo `GestOpClientes`, todavía no existe), el grant de `SELECT`+policy a
> `lk_ppp_reader` para que LK lea `cobranzas_excepciones` por FDW, la carga de las
> excepciones reales, y la integración con Interbanking (o carga manual del extracto)
> para pasar de deuda bruta a neta. `sql/deudores.sql` documenta todo el diseño.
>
> ⚠ **Hallazgo de seguridad del mismo pase (auditor-supabase), corregido**:
> `cobranzas_escalones` nació con **INSERT/UPDATE/DELETE/TRUNCATE abiertos a
> `anon`/`authenticated`** — no era un `GRANT` explícito, sino los **default
> privileges del schema `public`** (`ALTER DEFAULT PRIVILEGES FOR ROLE postgres
> ... GRANT ALL ON TABLES`), que le dan CRUD completo a **toda tabla nueva** que
> cree el rol `postgres` salvo que se revoque a mano. Confirmado con
> explotación real: con la anon key (pública, está en `index.html`/`sw.js`)
> cualquiera podía `TRUNCATE` la escalera de descuento. Corregido con
> `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ... FROM anon,
> authenticated` (ya en `sql/deudores.sql`). **La causa raíz sigue viva**: el
> default privilege del schema no se tocó — toda tabla nueva que se cree desde
> el SQL editor nace expuesta igual, salvo que alguien se acuerde de revocar a
> mano. Pendiente evaluar `ALTER DEFAULT PRIVILEGES ... REVOKE` a nivel schema
> (afectaría a todo objeto nuevo futuro, no sólo a este módulo — decisión del
> usuario, no se aplica sin permiso explícito).
>
> Nota **v12.45 (2026-09-02)** — **Código canónico para mostrar (`035E`, no `35E`) en toda la app + dependencia OC_Maximos.**
> Los códigos se guardan/normalizan SIN ceros a la izquierda (`_ocgNorm`, para que `27`/`027`/`0027`
> matcheen). Para MOSTRARLOS existe **`codCanon(cod)`** (base canónica desde `OC_Maximos.cod` activo, con
> fallback `_padCod` que solo paddea numéricos puros) y ahora **`codCanonSuf(cod)`** = canoniza la base y
> re-anexa el sufijo `LK`/`CH` (`35E`→`035E`, `438E LK`→`438E LK`). **`codCanonSuf` es la forma ÚNICA de
> mostrar un código**; NO usar para claves/lookups (esos van normalizados). El mapa lo carga
> `loadCodCanon()` (precargado global al arranque, v12.45). Se cablearon ~18 pantallas operativas que
> mostraban el código crudo (Completar/armado, Mercadería a Góndola, Mover, Urgente, Envasar, Racks,
> Capacidad, Ingresos/Salidas, Conteo, etc.). ⚠ **Dependencia: el código canónico sale de `OC_Maximos.cod`.**
> Para cambiar cómo se muestra un artículo se edita esa tabla; varias pantallas (OCs, líneas, línea por
> código, canónico) la leen, así que un cambio ahí impacta en todas. También se unificó una fila duplicada
> en `Planimetria` (`26`→`026`, backup `stock_v2.bkp_planimetria_26_20260902`).
>
> Nota **v12.40 (2026-09-02)** — **Empresa en TODO el recorrido de la reconciliación (picking→separado→facturado→CP).**
> Bug detectado por el usuario: la reconciliación arreglaba el `picking` por empresa (cutover) pero
> las etapas **2 (separado)**, **3 (facturado)** y **4 (CP)** escribían los duales **sin empresa** →
> el trigger los mandaba a `Mixto`. Síntoma: tanda D55A / 809E con picking en LK y separado en Mixto
> (`separar_pedidos LK +2` pegado + `−2` fantasma en Mixto). **Fix backend:**
> `reconciliar_pipeline_stock_etapa2` y las etapas 3/4 de `reconciliar_pipeline_stock` ahora agrupan
> por `empresa`, guardan por `(tanda, artn, empresa)` y **propagan `empresa` al INSERT**. Para
> no-duales no cambia nada (el trigger igual fuerza `Mixto`). Data D55A corregida (2 filas Mixto→LK,
> backup `stock_v2.bkp_d55a_20260902`). Verificado: 0 tandas con picking/separado en empresas
> distintas; 809E `separar_pedidos = 0` en las 3 empresas; `Movimientos_Stock` no crece al re-correr
> (el `etapa1=NNNN` del return es un `row_count` engañoso de `ON CONFLICT DO NOTHING`, no inserta).
> Residuo conocido: la matview deja un renglón pelado `809E` net-cero (`visible_en_stock=false`, NO se
> muestra) de movimientos Mixto históricos pre-cutover; su limpieza fina queda para el conteo (Tarea #6).
>
> Nota **v12.38–v12.39 (2026-09-02)** — **Regla "L" aplicada de punta a punta (armado, faltantes, demanda, monitor) + recepción manda empresa.**
> Completa la nota v12.37 (que sólo cableaba la lista de picking). **v12.38:** recepción manda
> `empresa: opState.linea` (LK/CH) → duales recibidos van a su góndola en vez de `Mixto`.
> **v12.39 — HÍBRIDO backend+front:**
> - **Backend (fuente de verdad):** el trigger `trg_normalizar_empresa_stock` ahora pela la "L"
>   final (`[0-9E]L$`) y **fuerza `empresa='LK'`** → CUALQUIER movimiento que llegue con `438EL`
>   (front viejo, armado, reconciliación) se guarda como `cod_art='438E', empresa='LK'`. La vista
>   `v_cajas_pedidas` pela la "L" al agrupar (438EL→438E) → sin renglón fantasma tras cancelar NP.
> - **Front (duplicado UX):** helper `pkResolveArt(art,np)` (= `pkCodEmpresa(pkStripL, np, pkEmpresaArt)`);
>   el **asistente Completar/armado** ahora muestra y descuenta `438E LK` (antes el crudo `438EL`);
>   `codEmpSplit` pela la L + fuerza LK (faltantes); el popup "Cajas pedidas" trae la variante `L`
>   (`articulo IN (438E,438EL)`) y la cuenta en la fila LK.
> - **Se preserva:** el código del PEDIDO en `Entregas_Virgilio`/factura queda crudo `438EL`
>   (`pedidoFull`, separado de `n.codes`). Modelo: stock/movimiento=`438E LK`, display=`438E LK`,
>   factura=`438EL`. Efecto lateral bueno: el armado ahora también sufija los duales normales por
>   empresa (438E→438E CH/LK), cortando un leak a `Mixto` que tenían los ajustes `picking_difiere`.
> Backups: `stock_v2.bkp_defs_20260902_lcodes` (trigger+vista viejos), `stock_v2.bkp_equiv_20260902_lcodes`.
>
> Nota **v12.37 (2026-09-02)** — **Códigos con "L" final = artículo Loekemeyer que vende Chef → picking va a la góndola LOEKE, no Chef.**
> Los códigos terminados en `L` (`438EL`, `439EL`) son artículos de **Loekemeyer** que **vende Chef**:
> el pedido entra como **NP de Chef**, pero el stock se agarra de la góndola de **Loeke** (`438E LK`),
> NO de la de Chef. Antes el front pelaba la `L` y re-derivaba la empresa por número de NP (Chef→`CH`),
> mandando el picking a la góndola equivocada (`438E CH`). **Corrección:** `pkEmpresaArt(codOriginal, np)`
> fuerza `empresa=LK` para cualquier código terminado en `L` y se pasa a `pkCodEmpresa` como `empForce`
> (call sites `aggFrom` y `pppChkCompute`). **Regla sin excepción:** verificado 2026-09-02 que **ningún
> código de Loekemeyer termina en `L`** (chequeado en `loke_products`, `chef_articulos_activos`,
> `milver_products`, `chef_item_remap` y todo el pipeline de Virgilio). Backend alineado:
> `Equivalencias_Codigos` `438EL → 438E LK` / `439EL → 439E LK` (antes apuntaban a `... CH`), matview
> `vista_stock_procesada` refrescada + `stocks_carga_rapida` repoblada → la demanda de los `L`
> consolida en la góndola Loeke. Backup: `stock_v2.bkp_equiv_20260902_lcodes`. ⚠ Deja obsoleta la
> vieja explicación "reenvasado x24" de la nota v9.16 (ese ruteo a `... CH` era el bug).
>
> Nota SERVER **2026-09-01** — **Stock por empresa: el `cod_art` dejó de llevar el sufijo; ahora es código pelado + columna `empresa`.**
> Antes, los 4 códigos que son **dos productos físicos distintos con el mismo número** (`437E`,
> `438E`, `439E`, `809E` — góndolas separadas LK/CH) se guardaban en `Movimientos_Stock` como
> `438E CH` / `438E LK`, y el saldo se partía por ese sufijo. La recepción no sufijaba → dejaba
> stock pelado en un limbo (bug: `438E CH` en −10). **Modelo nuevo:** `cod_art` **siempre pelado**;
> la empresa vive en la columna `Movimientos_Stock.empresa` ∈ `{LK, CH, Mixto}`. **`Mixto` es el
> default** (mono-empresa y compartidos = una pila común); **solo los duales se separan** por
> empresa. La lista de duales es la **fuente de verdad** `public.codigos_duales` (4 filas). La
> empresa se deriva del **rango de NP** (`public.empresa_de_np(np)`, `>90000`=LK) en el picking, y
> de la **selección del operario** en la recepción. El trigger **`zz_normalizar_empresa`** (BEFORE
> INSERT en `Movimientos_Stock`) es la **red de seguridad y fuente de verdad**: pela el sufijo que
> mande un front viejo y **fuerza `Mixto` a todo lo que no sea dual** (así el front no necesita
> conocer la lista). `vista_saldos_stock` **reconstruye el sufijo** en `cod_art` para los duales
> (`438E CH`) y expone la columna `empresa` → la matview `vista_stock_procesada`, `stocks_carga_rapida`
> y todos los consumidores siguen viendo el formato de siempre (no se reescribió nada de eso).
> `actualizar_saldo_trigger` usa la clave sufijada + filtro `empresa`; `reconciliar_pipeline_stock_etapa1`
> y `_rt` llevan `empresa` en el `ON CONFLICT` (índice `mov_stock_pipeline_dedup`). **Pendiente
> (desacoplado):** migrar el FRONT (mostrar pelado + columna empresa) y pelar `Planimetria` /
> `Equivalencias_Codigos` / `Stock_Ubicaciones` — el front viejo funciona porque el trigger normaliza.
> Paquete SQL: `sql/migracion_stock_por_empresa.sql`. Backup del cutover: `stock_v2.bkp_*`.
>
> Nota **v12.27** — **"Pedidos sin cargar en PPP": se puede tachar la NP que NO es un error.**
> La tercera sección del módulo (`vista_np_prog_sin_base`, v12.05) avisa cuando una NP está en
> Programación Diaria y `PPP_Base_Pedidos` no tiene ni una línea suya → no se puede armar el picking.
> Asume que falta importar del ERP, pero **hay un caso donde no falta nada: el cliente pide con mucha
> anticipación.** Testigo: **Matiz SA** (cod 4263) trabaja con ~85-90 días entre carga y entrega —
> NP 97889 (OC 032112, carga 23/06, entrega 16/09, 9.25 m³), 97964 (03/07 → 07/10) y 98426 (13/08 →
> 28/10). La hoja «PPP Excel Base Datos Pedidos» arrastra una ventana de **~2 meses por fecha de
> CARGA** (al 01/09 va del 01/07 al 01/09): el 97889 se cargó el 23/06 y queda afuera aunque su
> entrega no pasó; los otros dos entran. ⚠ **Esa ventana no se define en Virgilio**:
> `sync_ppp_base_pedidos()` (`sql/sync_ppp_pull_server_side.sql`) trae la pestaña entera del Sheet
> **sin filtro de fecha**; el recorte viene aguas arriba, en lo que escribe esa hoja. Por eso acá sólo
> se silencia el aviso, no se recupera el dato. **Ahora cada fila lleva una ✕**
> (`npSinBaseMarcar`) que hace upsert en la tabla nueva **`NP_Sin_Base_Revisadas`** (`np` PK, `estado`,
> `motivo` opcional que se pide por `prompt`, `creado_en`; RLS anon/authenticated select+insert+update+
> delete, mismo patrón que `NP_Secuencia_Revisadas` de v11.21) y la vista suma un tercer `not exists`
> para excluirlas. Como el cron **`notificar_picking_sin_base`** lee la **misma vista**, el tachado
> **también apaga el aviso de Telegram** — no hay dos lugares que puedan discrepar. El badge del panel
> (`npFaltanLoadBadge`) baja solo. Destachar: `delete from "NP_Sin_Base_Revisadas" where np='…'`.
> DDL en `sql/np_sin_base_revisadas.sql`; test `tests/npf-prog-sin-base.cjs` (caso D).
>
> Nota **v12.26** — **Facturación: la fila amarilla ("en progreso") siempre muestra el badge que la explica.**
> Bug reportado por el usuario en NP 44591: la fila se pintaba amarilla (tarea de faltante activa en
> `Faltantes_Tareas`) pero no aparecía el badge `⏳` al pasar el mouse — inconsistente. Causa raíz:
> `facTareaBadge()` tenía dos guards que devolvían `""` (la fila seguía amarilla igual porque el
> color de fila se decidía SOLO por `facTareaActiva`, no por la misma condición del badge):
>   (a) `cjCompletando <= 0` (ningún ítem faltante tiene stock ahora en `a_guardar` / racks / guardado
>       hoy) → antes escondía el badge; ahora muestra `⏳ Tarea abierta · sin stock ahora · lo hace X`.
>   (b) `f.cajas === 0` (faltante completado, tarea todavía sin cerrar) → el badge sigue oculto pero
>       ahora la fila TAMPOCO se pinta amarilla: `_ft` en el render usa `_ftRaw && _ff && _ff.cajas > 0`
>       para sincronizar color y badge con el mismo predicado.
> Sin cambios de fetch (`facFetchTareas` sigue igual). Suite verde.
>
> Nota **v12.25** — **Facturación: columna unificada "Faltantes y Agregados" + baja de "Cambiar cód".**
> Cierre de la iteración de esta mañana sobre el módulo de Facturación. Cambios respecto de v12.23:
>   - **Una sola columna "Faltantes y Agregados"** (`facFaltAgregDist`) reemplaza a la pareja
>     "A facturar (anomalías)" + "Faltantes (no facturar)" — un mismo código aparecía en las dos
>     cuando había un corto parcial (ej. `609 3/6` verde + `609 −3` rojo, la misma info). Ahora:
>     rojo `cod −N` = faltante (restá o no factures), verde `cod +N` = agregado (sumá a la factura).
>   - **Sacada la columna "Cambiar cód"** — su info sigue disponible en el chip `🔀 Corregir códigos`
>     del header (que abre el panel dedicado). Mostrarla también por fila duplicaba la mano al mismo
>     lugar y ocupaba 13% de ancho. Las funciones `facCambioCod`/`facCambioCodConfirm` quedan
>     definidas por si vuelve o si el chip las reusa a futuro.
> La tabla de Facturación pasa de las 11 columnas originales (v12.22) a **7 columnas**: NP · Cod ·
> Razón Social · Faltantes y Agregados · Líos · Cajas · Subtotal · Acción. Tanda y Salida como
> tooltip en NP; Cajas/Líos = lo armado (no el pedido). Test `fac-falta-filter.cjs` actualizado.
> Suite verde.
>
> Nota **v12.24** — **Cola de impresión NP: imprime también los remitos sin `resumen` en el TAL (súper con etiqueta y NP cerradas con 0 líos).**
> Pedido del usuario: en «🖨️ Cola de impresión — NP armadas» había 3 NP (98109 súper con etiqueta,
> 98582 y 98583 líos con 0 líos armados) que "no dejaba imprimir". Diagnóstico: el TAL de esas NP se
> encoló con el 4to campo (`resumen`) **vacío** (para 98109 es normal — el súper va con etiqueta, no
> arma lío; para 98582/98583 el operario cerró con 0 líos en esas NP). `armadoRemitoData()` sólo
> leía `row.resumen`, así que la tabla del remito quedaba en "— sin artículos —" y la Cola las
> filtraba (`x.resumen` = falsy) → no imprimían. **Fix backend (fuente única de verdad):** la vista
> `vista_cola_impresion` ahora expone también `arts_fallback` y `faltantes_fallback` (JSONB
> agregado desde `Entregas_Virgilio` — `cajas_entregadas>0` y `cajas_falto>0` respectivamente). El
> front (`openColaImpresion` + `colaImprimirTodas` + `_armadoRemitoDataForItems`) los pasa al
> `armadoRemitoData`, que usa `row.artsFallback` como sección **Artículos** cuando el `resumen`
> viene vacío; y `_armadoRemitoDataForItems` prefiere `faltantesFallback` cuando la Cola ya lo
> trajo del server (evita depender del fetch a Entregas). El filtro previo (`items0.filter(...)`)
> ahora acepta NP con `resumen` **o** con `arts_fallback.length>0` **o** con
> `faltantes_fallback.length>0`. Backup previo de la vista en
> `sql/backups/backup_vista_cola_impresion_20260901.sql`; DDL nueva en
> `sql/vista_cola_impresion_arts_fallback_20260901.sql`. Bump `APP_VERSION` + `SW_VERSION` a
> `v12.24`. Smoke suite verde.
>
> Nota **v12.23** — **Facturación: unificación "Faltantes y Agregados" en una sola columna (rojo −N / verde +N).**
> Iteración sobre el fix de la mañana: las dos columnas separadas ("A facturar" verde con `ent/ped` +
> "Faltantes" roja con `−N`) mostraban el mismo código dos veces cuando había un corto parcial
> (ej. 609 ped=6 armó=3 → `609 3/6` verde Y `609 −3` rojo, la misma info). Redundante y confuso.
> Solución: **una sola columna "Faltantes y Agregados"** (`fac-falta-col`) donde cada ítem aparece
> una única vez con el ajuste que la operadora tiene que hacer en la factura:
>   - **FALTANTE** (rojo, `cod −N`): faltó N cajas del pedido → NO facturarlas.
>   - **AGREGADO** (verde, `cod +N`): se armó algo que NO estaba en el pedido → sumar N cajas a la factura.
> Ni siquiera el `ent/ped` del corto parcial: es info que la operadora no necesita cargar (el sistema
> de gestión ya tiene el pedido; ella solo ajusta la diferencia). El header pasó de dos
> ("A facturar (anomalías)" + "Faltantes (no facturar)") a uno ("Faltantes y Agregados"). Funciones:
> `facFactDist` y `facFaltDist` reemplazadas por `facFaltAgregDist`. Test `fac-falta-filter.cjs`
> actualizado a la nueva semántica. Suite verde.
>
> Nota **v12.23 (temprano)** — **Facturación: la tabla ahora refleja lo ARMADO, no el pedido original + tooltip Tanda/Salida en NP.**
> Pedido del usuario: (a) las columnas **Cajas** y **Líos** mostraban el pedido original, deberían mostrar
> lo que se armó realmente (suele haber faltantes); (b) las columnas "A facturar" y "Falta" son asistencia
> para cargar la factura en el ERP — que sean más claras cuando falta algo o se agregó algo que no estaba
> en el pedido; (c) sacar las columnas **Tanda** y **Salida**, mostrar esos datos como tooltip al pasar el
> mouse por el número de NP. Cambios: **(a)** `facFetchCajas()` ahora suma `cajas_entregadas` en vez de
> `cajas_pedidas` de `Entregas_Virgilio` — la columna "Cajas" refleja lo cargado al camión (Líos ya venía
> del evento TAL, que es lo real, no se tocó). **(b)** Misma pasada trae los AGREGADOS (fila con
> `cajas_pedidas=0 AND cajas_entregadas>0`) a un nuevo `Map _facAgreg`; `facFactDist()` los renderiza en la
> columna "A facturar" como `cod +N` en cápsula azul con tooltip "AGREGADO: no estaba en el pedido original.
> Sumá esta línea a la factura." Los ítems armados cortos ahora muestran `cod ent/ped` (ej. `609 3/6`) para
> que la operadora vea de un pantallazo cuánto facturar vs cuánto pedía el pedido; el header pasa a "A
> facturar (anomalías)" con tooltip largo explicando la semántica; el header "Falta" pasa a "Falta (no
> facturar)" con tooltip aclaratorio. **(c)** El `<td>` de Tanda y el de Salida se sacan; el `<td>` de NP
> ahora lleva `title="Tanda D47B · Salida 01/09"` para no perder la info. El header queda con 9 columnas
> (antes 11) y el tooltip del header de NP avisa que la info está al pasar el mouse. Bump `APP_VERSION` +
> `SW_VERSION` a `v12.23`. Suite de tests verde.
>
> Nota **2026-08-28 (solo datos, sin bump de versión) — Tabla nueva `lk_pedidos_match`: string identificador de pedido web + SUCURSAL DE ENTREGA.**
> Virgilio no tenía la sucursal de entrega de los pedidos; LK sí (`orders.sheets_payload.sucursal_entrega`).
> LK la **empuja** cada 15 min a la tabla local **`lk_pedidos_match`** por su FDW existente
> (server `virgilio_db`, rol `lk_ppp_reader`, que ahora escribe SOLO esa tabla; sigue
> solo-lectura para todo lo demás). El cruce va por **`match_string`** =
> `cod_cliente|fecha ART|items` con `items` = `cod_art`x`cajas` ordenado por código y
> cajas sumadas por código repetido (ej `4002|2026-08-27|026x1,027x1,315x2`) — sale de
> `sheets_payload.items`, exactamente lo que viajó al Sheet/ERP, así producción puede
> reconstruir el mismo string. `ambiguo=true` marca la única excepción (mismo cliente,
> mismo día, mismos ítems, DISTINTA sucursal: 17 de 977 pedidos históricos);
> `orden_en_dia` desempata por hora de alta. **Cubre las dos empresas** (columna
> `empresa`, `'lk'`/`'chef'`, PK compuesta con `order_id`): los pedidos web de Chef viven
> en el proyecto Supabase de Chef (portal gemelo) y LK los reenvía por su FDW `chef_db` —
> ⚠ **pendiente un grant en el proyecto Chef** (`grant select on public.orders to
> loke_reader;`); hasta entonces solo se sincroniza LK. La empresa de una NP se deduce
> del número: **9xxxx = lk, 4xxxx = chef** (numeraciones de cliente independientes: el
> mismo cod es otro cliente en cada empresa, por eso todo cruce lleva `empresa` +
> `match_string`). La app todavía **no la consume** — falta
> definir dónde se muestra. DDL en `sql/lk_pedidos_match.sql`; lado LK (vistas
> `v_pedidos_match` / `v_pedidos_match_chef` + `sync_pedidos_match_virgilio()` + cron
> `sync-pedidos-match-virgilio`) en `sql/pedidos_match_virgilio.sql` del repo pagina-LK.
>
> Nota **v12.22** — **El pop-up «🟡 Cajas pedidas» de un artículo no descontaba las NP CANCELADAS
> (idea 6322, bug del usuario — NP 44458 con 18 cajas y sin nombre de cliente).** Una NP marcada 🚫
> «no va» va a `NP_Canceladas` y deja de ser demanda: lo filtran la columna
> (`vista_stock_procesada.cajas_pedidas`, CTE `cerradas`), `ocgDemanda()` y `vista_np_sin_programar`.
> **`stkOpenCajasPedidasArt()` era el único lugar que NO**: descontaba `Facturacion_NP` y
> `PPP_Entregados_Meta` y nada más, así que seguía mostrando las canceladas como cajas pendientes
> (art 719: columna 40, pop-up 58) y encima las marcaba con el ⚠ «en la base pero SIN programar en el
> PPP» — un ⚠ **siempre falso**, porque una NP cancelada nunca se programa. Efecto real al momento del
> fix: **13 NP canceladas el 11/08/2026** (44456/44457/44458 de Dorinka, 97706, 97788, 98286, …)
> inflaban el pop-up de **47 códigos** (55215 +583 cajas, 702E +118, 505 +110, 550 +60, 719 +18…).
> Segundo bug del mismo pop-up: la **Razón Social** se leía sólo de `PPP_Programacion_Diaria`, así que
> toda NP no programada salía con la celda vacía («un pedido con cajas y sin cliente») teniendo el
> nombre a mano en `PPP_Base_Pedidos.cliente`. Fix: (a) fetch a `NP_Canceladas` sumado al `_facSet`
> del pop-up, (b) `rs: info.rs || cliByNp[np] || ""` (el `select` de la base ahora trae `cliente`),
> (c) el encabezado detalla por separado «N NP ya facturadas/entregadas · N NP canceladas (🚫 no va)».
> **La alerta ya existía y estaba bien**: el botón ⚠️ «Pedidos sin cargar en PPP» del panel supervisor
> (`vista_np_sin_programar`) sí excluye las canceladas — el que mentía era el pop-up. Test
> `tests/cajped-canceladas.cjs`.
> Nota **v12.20** — **Facturación: "A facturar" y "Falta" en columnas separadas.**
> Pedido del usuario (idea inline): en la tabla de Facturación la columna "A facturar /
> Falta" mezclaba en la misma celda `"609 FC 3 −3, 760 −3, 859 −4"` — la operadora
> se perdía porque los `−N` (rojo) se leían pegados a los `FC N` (verde). Ahora
> son dos columnas: **A facturar** (verde, ítems con `ent > 0` → `cod N`) y **Falta**
> (rojo, ítems con `falto > 0` → `cod −M`). Los parciales aparecen en las dos; los
> completos, solo en "A facturar"; los que faltaron entero, solo en "Falta". Refactor:
> helper común `_facCompItems(np)` que normaliza los ítems, `facFactDist` y
> `facFaltDist` filtran del mismo set. CSS `td.fac-facturar-col` nuevo (color verde),
> `td.fac-falta-col` sin cambio. Header pasa de 14% a 8%+6%. Test
> `tests/fac-falta-filter.cjs` actualizado con `factDist500` que verifica que "A
> facturar" tenga el cod + verde y NO tenga el `−`; `dist501empty` chequea ambas
> columnas vacías cuando la NP no tiene faltantes. Bump v12.20. Suite verde.
>
> Nota **v12.19** — **Sobrevivientes del incidente canon: FAL server-side + stockMove
> 4xx transient + doc de riesgo estructural.** Complementa v12.18. **(a)
> `_compAddFaltManual`** ahora además de meter el faltante manual en `_comp.arts` emite
> un evento **`opcion=FAL`** en `Registros_Produccion_Virgilio` con `texto =
> NP|COD|CAJAS|LEG|TANDA|MANUAL` — segunda fuente de verdad independiente de que la
> escritura a `Entregas_Virgilio` salga OK. Con esto, si algún día vuelve a romperse
> Entregas (nuevo trigger, RLS mal, otra causa), el faltante manual queda igual y se
> puede reconstruir; los faltantes automáticos del picking ya sobreviven vía PKC.
> **(b) `stockMove`** distinguía "4xx = fila mal formada → drop" indiscriminadamente
> — mismo agujero que rompió `_compSaveEntregas` con el 42501. Ahora lee el body de
> respuesta y clasifica: 401/403/409/429 o mensaje con `42501`/`PERMISSION DENIED`/
> `PGRST301`/`PGRST116` → **encola** en `vir_stock_pend` (como 5xx/red). 400/422 con
> otro mensaje → sigue haciendo `console.error` + drop (evita veneno en la cola).
> **(c)** Nueva doc `docs/RIESGO-ESTRUCTURAL-CANON.md` con las 4 capas de defensa
> propuestas: test de smoke `anon puede escribir`, runbook de migraciones con REVOKE,
> monitor Telegram de escrituras estancadas, grep pre-commit contra `.catch` silencioso.
> Bump `APP_VERSION` + `SW_VERSION` + `version.json` a `v12.19`. Test suite verde.
>
> Nota **v12.18** — **Fix Facturación no mostraba NPs armadas hoy + causa raíz del insert
> roto en `Entregas_Virgilio` desde 28/8.** Bug reportado por el usuario esta tarde: las
> NPs que los operarios armaron hoy no aparecían en Facturación. **Causa raíz:** el 28/8
> se aplicó `sql/canon_cod_art_extendido.sql` (idea 7411, commit `5193af5`): crea
> `canon_cod_art_val(text)` con `REVOKE EXECUTE FROM anon, authenticated` y le engancha
> triggers BEFORE INSERT en 10 tablas — entre ellas `Entregas_Virgilio`. Las trigger fns
> (`fn_canon_col_cod_art`, `fn_canon_col_cod`, `fn_canon_col_cod_art_quoted`,
> `fn_canon_col_codigo`, `fn_canon_col_articulo`) corrían **SECURITY INVOKER**, así que
> cuando `anon` hacía INSERT, Postgres tiraba **42501 permission denied for function
> canon_cod_art_val**. Encima el `.catch` de `_compSaveEntregas` (index.html) tragaba
> silenciosamente todo 4xx *"como error de datos"* — los armados se perdían sin encolar
> siquiera en localStorage. Última fila real en `Entregas_Virgilio`: **28/8 09:42 -03**
> (justo antes del deploy). No se notó porque las NPs seguían apareciendo en Facturación
> hasta que **v12.17 (hoy)** agregó `if (!_facCajas.has(np)) continue;` — ahí el listado
> quedó vacío para todo lo armado desde el 28/8. **Fix backend** (migración
> `fix_canon_col_security_definer` + `fix_canon_col_revoke_rpc`): las 5 `fn_canon_col_*`
> pasan a `SECURITY DEFINER SET search_path = public` (corren como `postgres`, que sí
> tiene EXECUTE sobre `canon_cod_art_val`); se `REVOKE EXECUTE ... FROM public, anon,
> authenticated` en las trigger fns para cerrar la superficie RPC (los triggers no
> chequean EXECUTE del rol invocador, así que el insert de anon sigue funcionando). DDL
> anterior guardado en `sql/backups/backup_fn_canon_col_20260831.sql`. **Fix front** en
> `index.html`: (a) `_compSaveEntregas` ahora encola en `vir_entregas_pend` cualquier
> no-2xx (antes tragaba 4xx) y muestra un toast rojo al operario; (b) nueva
> `facFetchArmadosEventos()` trae NPs con `TAL/TAP` de los últimos 7 días desde
> `Registros_Produccion_Virgilio` como **fallback** del filtro v12.01 — el predicado
> unificado `facEstaArmada(np)` acepta filas en `Entregas_Virgilio` **o** evento
> TAL/TAP reciente, así una futura falla de escritura no vuelve a esconder las NPs. Se
> engancha en el `Promise.all` de `openFacturacion` y en `facLoadBadge`. Bump
> `APP_VERSION` + `SW_VERSION` + `version.json` a `v12.18`. **Pendiente:** decidir si
> se hace backfill de `Entregas_Virgilio` para el 28-31/8 (los armados están perdidos
> porque el catch tragaba el error sin encolar; los operarios podrían re-terminar las
> tandas desde el asistente — `_compTandaYaArmada` retorna false porque
> `Entregas_Virgilio` sigue vacía para esas tandas).
>
> Nota **v12.16** — **Fix banner «🔄 Actualizar» clavado.** `version.json` quedó en v12.07
> mientras `APP_VERSION` avanzó hasta v12.15 (nadie lo bumpeó desde entonces; ya había pasado
> en v12.04): como `checkForUpdate()` comparaba con `!==`, a todos los que YA tenían la última
> versión les aparecía el banner fijo y recargar no lo sacaba. Fix doble: (a) `version.json`
> re-sincronizado, y (b) `checkForUpdate()` ahora solo muestra el banner si la versión del
> server es **numéricamente más nueva** que la cargada (`_verNum()`: "v12.15" → 12015), así un
> `version.json` que quede atrás nunca más molesta. **Regla al bumpear versión: tocar
> `APP_VERSION` (index.html), `SW_VERSION` (sw.js) Y `version.json` juntos.**
>
> Nota **v12.15** — **El badge «en curso» del monitor cuenta horario LABORAL, no reloj de pared
> (idea 2865, bug del usuario — D14B marcaba ~66 h).** `statusCell()` calculaba
> `Date.now() − startTs` crudo: un AP abierto el viernes 19:04 sin cerrar marcaba ~66 h el lunes,
> contando las noches y el finde entero como trabajo. Nueva **`businessDurSinceMs(startMs, legajo)`**:
> dentro del mismo día sigue siendo la diferencia directa; si cruza días, solo cuenta horas dentro
> de `horaEntrada`–`horaSalida` del operario (mismo criterio que `computeClosureDur` para tandas
> cerradas) y saltea sábado/domingo/`FERIADOS_AR`. **Limitación conocida** (en el comentario del
> código): un finde trabajado excepcionalmente no lo cuenta en vivo — se corrige al cerrar la
> tanda, cuando `computeClosureDur` usa la fichada real. Test `tests/curso-dur-laboral.cjs`.
> (Rama `idea/2865`, cherry-pick limpio.)
>
> Nota **v12.14** — **Guardar a Góndola: prioridad con DEMANDA del día + hint de MCs sin rebalsar
> (idea 4926, del usuario).** v8.40 ya ordenaba por góndola÷capacidad; ahora la prioridad es
> **(góndola − demanda del día) ÷ capacidad** (asc): un código con la góndola llena pero con muchos
> pedidos hoy también es urgente. La demanda sale de `ocgDemanda(true)` y las cajas×MC de
> `rkbFetchCxM()` (planimetría), las dos **best-effort** en el `Promise.all` de `showMGModal` —
> si fallan, el modal abre igual y ordena como antes. Además cada tarjeta muestra
> **«📐 Máx sin rebalsar: N MC (N×cxm cajas)»** = `piso((capacidad − góndola) / cajas×MC)` —
> informativo, NO limita el input (el tope real sigue siendo lo disponible en "a guardar"). Sin
> capacidad va al final y sin cxm no hay hint. Se conservan las celdas v10.08 y el badge de % de
> lleno. Test `tests/mg-prioridad.cjs`. (La rama `idea/4926` era pre-v8.40/v10.08; se integró a
> mano el delta que faltaba: demanda + hint.)
>
> Nota **v12.13** — **Completar Pedido avisa si retira de GÓNDOLA con saldo 0 (idea 6497, del
> usuario).** Si en el paso 2 del CP se elige origen **Góndola** y el saldo `terminado` está en 0,
> hoy se retiraba igual sin avisar → góndola negativa "de la nada" hasta que otro pedido explota
> como faltante inexplicable. Ahora: **(a)** cartel rojo en el paso 2 («Góndola está en 0 … queda
> negativa. Se avisa por Telegram») y **(b)** `cpConfirm()` encola un aviso **Telegram** vía
> `telegram_outbox` (`cpSendTelegramGondolaVacia`, mismo canal/patrón que la alerta racks→góndola;
> `dedup_key` = `cp_gondola0_<np>_<cod>_<día>` para no spamear). No bloquea el retiro — el default
> lo acordó el usuario: cartel + Telegram. Test `tests/cp-gondola-vacia.cjs` (5 asserts; fixture
> con `fecha_salida` dinámica para no caer en el filtro de huérfanos de 21 días). (Rama
> `idea/6497`, cherry-pick + fixture corregido.)
>
> Nota **v12.12** — **NPD «de menos + no hay en góndola» ahora descuenta las cajas fantasma de
> `separar_pedidos` (idea 1569, bug reportado por el usuario — caso real 952E/D14B corregido a
> mano).** El picking había movido `c.sale` cajas a `separar_pedidos`, pero en la mesa solo hay
> `real` (= `c.sale − qty`): esas `qty` nunca salieron físicamente de góndola y quedaban de
> fantasma en Pickeados — y la **ETAPA 2** reparte el sobrante de `separar_pedidos` de vuelta a
> **`terminado`** (`net − entregado`), inflando góndola. Ahora `_compDifResolve` **siempre**
> descuenta `−qty` de `separar_pedidos` al resolver «de menos + no hay» (ref = tanda, dual-send
> v11.10: realtime + `_difMovs`), con **`client_id` determinístico** (`npd_<tanda>_<np>_<cod>_…`)
> para que el doble toque no descuente dos veces. La compensación de góndola negativa (v7.39)
> sigue: `terminado +ret` clampeado a llevarla a 0 — pero el `−ret` de `separar_pedidos` que
> había agregado v11.09 (r2) **se reemplazó** por este descuento upfront de `−qty` completo
> (mantener ambos duplicaría). Test `comp-dif-nofantasma.cjs` reescrito (10 asserts, incluye
> dedup por doble toque). (Venía de la rama `idea/1569`; re-aplicada integrándola al dual-send.)
>
> Nota **v12.11** — **Detector de reloj desincronizado del celular (idea 9782, mejoras-virgilio).** Un
> celular con el reloj corrido registra `ts_cliente` corridos → horas de picking/armado corruptas sin
> que nadie lo note. Ahora `trySendOneReport` compara en cada envío el header **`Date`** que Supabase
> devuelve (éxito o error, sin permiso ni endpoint extra) contra `Date.now()` (`_checkClockSkew`); si
> el desfasaje supera **5 min** (`CLOCK_SKEW_THRESHOLD_MS`) aparece un **banner rojo dismissible** en
> la pantalla de opciones (`#clockSkewBanner`: "El reloj de este celular está adelantado/atrasado ~N
> min — avisá a un supervisor"). La ✕ lo descarta por sesión. No bloquea nada: solo avisa. Test
> `tests/clock-skew.cjs`. (Venía de la rama `idea/9782`; re-aplicada a mano sobre el main actual.)
>
> Nota **v12.10** — **Dos fixes de render de revisor-render (ideas 4149 y 8628).** **(4149)** En la
> tabla de **Stocks**, una celda de depósito con saldo **negativo** caía en la clase `stk-hist0`
> (gris, tooltip «Saldo 0») porque el gate era `v <= 0.05` — un −15 se veía como saldo 0. Ahora
> `v < -0.05` prioriza **`stk-neg`** (rojo) con tooltip «Saldo NEGATIVO — tocá para revisar los
> movimientos»; la celda sigue clickeable. **(8628)** En **Insumos**, los botones de la fila en
> edición (✓ Guardar · Cancelar · ＋unidad/⚖Unidades, en las DOS tablas que comparten el patrón)
> iban sueltos en el `<td>` y en mobile (360–390px) se apilaban en 2–3 líneas agrandando la fila;
> ahora van en un `<div>` flex `nowrap`. Assert nuevo `totalEditBtnsNowrap` en `tests/ins-admin.cjs`.
> Las ideas venían de las ramas `idea/4149` / `idea/8628` (sin base común con main tras el reset de
> historia) — se re-aplicaron a mano adaptadas al código actual (v12.06 había reescrito ambos lugares).
>
> Nota **v12.09** — **Limpieza de código muerto (ideas 6750/5877/9703 de auditor-consistencia).** Se
> borraron 6 funciones sin ningún call-site en el repo — `pppSugerirView` (reemplazada por
> `pppSugerirInline`), `facFaltBadge` (reemplazada por `facFaltDist`; también se sacó de los asserts de
> `tests/smoke.cjs` y `tests/fac-npc.cjs`, que eran su único uso), `pickParseCajas`, `_ocgNextAutoTxt`,
> `_ocgNextAutoFecha` (reemplazadas por `_ocgAutoEnTxt`) — y 2 reglas CSS sin uso (`.cmpl-autobar`,
> `.ppp-ent-grid`). `_pkItemCodes` (idea 5877) se **conservó**: no tiene call-site en la app pero la
> cubre `tests/emp-np.cjs` (contrato de la idea 9020, "scanCodes") y queda reservada para el cruce
> por escáner de la idea 8243 — se le actualizó el comentario para que lo diga. Cero cambio de
> comportamiento; suite completa verde.
>
> Nota **v12.08** — **La estación de impresión ahora marca en `Impresion_NP` lo que imprime sola.** La estación (auto-print de remitos al terminar armado, `psPrintBatch`) deduplicaba solo en `localStorage` de la PC del kiosco: el server no se enteraba, así que la **Cola de impresión NP** y su badge seguían acusando como "sin imprimir" NPs que ya habían salido solas por la estación (falsa alarma permanente si conviven las dos cosas). Ahora `psPrintBatch` también llama a `colaImpMarcarImpresas()` (el mismo insert idempotente a `Impresion_NP`, `on_conflict=np`, que usa la Cola) y refresca el badge (`colaImpLoadBadge`, con 1.6 s de espera para que el insert pegue). El dedup local (`psMarkPrinted` en `localStorage`) sigue igual — evita doble impresión con 2 pestañas abiertas; la marca server es para que la Cola refleje la realidad. Sin cambio de esquema: `Impresion_NP` ya tenía RLS anon insert (v11.60).
>
> Nota **v12.07** — **Recepción / Pendientes: el visor de foto ahora muestra AL LADO lo que cargó el operario (código → cajas).** Antes, «👁 Ver foto» abría un overlay negro con la foto sola: tapaba la tarjeta, así que para cotejar la mercadería contra lo declarado había que **cerrar la foto, leer el detalle, volver a abrirla** (y así). Ahora el overlay es de **dos paneles** (`.fotoOverlayBox`): la foto y, al lado, una ficha blanca (`.fotoOverlayInfo`) con **nombre del tallerista/proveedor · tipo · fecha · hora · línea · RTO/FC** y la lista **CÓDIGO → CAJAS** una debajo de la otra, más el **Total**. En celular (≤860px) los dos paneles se **apilan** (foto arriba, ficha abajo, las dos visibles sin cerrar nada). No hay dato nuevo ni consulta nueva: el detalle ya venía en `Control_Modo_OP.detalle` (formato `"COD → N · COD → N"`, lo arma `opEnviar`) y `renderPendientes` ya lo traía en el `select`; lo único que se agregó es el parseo en el front (`pendFotoParseDetalle` + `pendFotoInfoPanel`) — **puramente visual, sin lógica de negocio**, por eso no hay contraparte en el backend. Si algún día cambia el formato de `detalle`, el panel muestra el texto crudo en vez de romper. También se cierra con **Escape**. Test `tests/rcp-foto-detalle.cjs` (PC y celular).

> Nota **v12.06** — **La suite de smoke-tests volvía a estar verde: 10 tests rotos, todos por cambios de contrato que nadie bajó al test.** `tests/run.sh` tiene `set -e` y el primer test que fallaba estaba en la **línea 70 de 171**, así que la suite moría al 40% y los ~50 tests de abajo hacía rato que no corrían. Las causas, todas del mismo tipo — lógica que se fue al backend o loading que cambió, con el test todavía parado en el mundo viejo: **(a) v10.00** `stkBodyStocks` dejó de sumar los movimientos en el navegador (lee `_stk.viewRows`, espejo de `stocks_carga_rapida`, y solo recalcula desde `_stk.movs` en modo As-Of) → 4 tests armaban `movs` y veían la tabla vacía (`stk-solo-negativos`, `stk-envasar-col`, `stk-base-split-oculta`, `mva-quien`); **(b) v10.02** la celda del código dejó de llevar el sufijo de empresa (va en la columna «Línea»), así que la fila se identifica por `data-stk-cod`; **(c) v10.24** `recepcion.js` dejó de importar supabase-js de esm.sh y lo toma de `window.supabase` → 3 tests parchaban un `import` que ya no existe (`rcp-oc`, `rcp-reanudar`, `anular-sesion`), y el guard que los abortaba miraba si quedaba «esm.sh» en el fuente… que sigue, pero en un comentario; **(d) v10.10** el armado de OCs vigentes se fue a la RPC `oc_vigentes_por_proveedor` → `rcp-oc` testeaba en el front un matcheo de proveedor que ahora es SQL (quedaron sin uso `ocProvCoincide`/`ocSplitProv`/`ocDiaLimite` en `recepcion.js`); **(e) v10.26** el estado por tanda se fue a `vista_tanda_status`, que ya filtra los legajos de prueba con `es_legajo_test()` → `mon-armado-legajo0`; **(f)** el catálogo de insumos pasó a leerse de `vista_insumos` y la sección Categorías se rediseñó (grilla `.stk-catbtn` + pop-up `stkInsCatPopup` en vez de cajas `.stk-catbox`) → `ins-admin`; **(g) v8.40/v10.08** `showMGModal` sumó `ocgFetchCapacidad`/`ocgFetchCeldas` sin stub → `dual-ubic-mg-draft`. Los tests se reescribieron contra el contrato de hoy (lo que se fue al backend se verificó a mano contra la base y quedó anotado en la cabecera de cada test). **Además, un arreglo real de código:** desde **v10.31** las celdas de depósito son clickeables siempre, con saldo o sin él, pero el tooltip seguía diciendo «Saldo 0 ahora, pero **tuvo movimientos**» aunque no hubiera ninguno; encima el Set `_stk._histDeps` que lo calculaba quedó sin uso y se cacheaba **vacío para siempre** porque el render rápido (v10.00) dibuja con `movs: []`. Se sacó el Set y el tooltip pasó a «Saldo 0 — tocá para ver el historial de este depósito».

> Nota **v12.05** — **Pedidos sin cargar en PPP: la tercera sección (NP programada sin artículos en la base).** El módulo del panel supervisor (`stkOpenNpFaltan`, botón «⚠️ Pedidos sin cargar en PPP») tenía **dos** secciones y las dos miran el problema **desde la base de pedidos**: `vista_np_sin_programar` (está en `PPP_Base_Pedidos` y **no** en `PPP_Programacion_Diaria`) y `vista_np_faltantes_secuencia` (números que **no existen en ninguna** fuente, huecos ≤5). El caso inverso —**la NP está programada pero `PPP_Base_Pedidos` no tiene ni una línea suya**, así que el picking no se puede armar— **no lo veía nadie**: la sección 1 arranca de la base (y ahí esas NP no están) y la sección 2 no las cuenta como hueco porque **sí existen**, justamente en Programación Diaria. Fue el caso de la tanda **D52B** (NP 98574/98575) del 28/08: lo cazó solo la alerta de Telegram del día anterior (v12.04). Ahora hay una **tercera sección** (`_stkNpSinBaseHtml`, tarjeta naranja arriba de todo) que lee la vista nueva **`vista_np_prog_sin_base`** (np · tanda · cliente · fecha_entrega · m³; normaliza el `.0` final del `pedido` como las otras vistas y descarta lo ya facturado/entregado/cancelado), y el **badge** del panel pasa a sumar **las tres** fuentes (`npFaltanLoadBadge`). La **misma vista** la consume ahora el cron `notificar_picking_sin_base` (antes cruzaba `bp.pedido = pd.np` a secas → un `98574.0` en la base disparaba alerta en falso; y una `tanda`/`fecha_entrega` vacía dejaba el mensaje entero en NULL). DDL en `sql/picking_sin_base_telegram.sql`; test `tests/npf-prog-sin-base.cjs`.

> Nota **v12.03** — **Recepción: se sacó el tilde "Faltantes x Día" del checklist de Pendientes** (pedido del usuario: ese programa ya no se hace). En `recepcion.js`, la tarjeta de un remito pendiente tenía 4 pasos (Carga ISIS · Control Partes Talleristas · Faltantes x Día · Foto) y el botón **Enviar** solo se habilitaba con los 4. Ahora son **3**: el tilde desapareció de la tarjeta y salió de `pendRowComplete`, así que ya no bloquea el envío. La columna `Control_Modo_OP.faltantes` **queda en la base** con lo ya cargado — no se borró ni se dejó de leer por otro lado; simplemente el front no la escribe ni la exige más. Ojo: la solapa **📉 Faltantes x día** del módulo **Stocks** (el reporte) NO se tocó — es otra cosa, solo comparte el nombre.

> Nota **v11.98 — Auto-close RT al enviar + pop-up faltantes Moncayo 15:30 + saca botón Avisar + fix OC recepción.**
> **(1) Auto-close RT:** al presionar **Enviar** en recepción (`opEnviar`, `recepcion.js`), el toggle de
> **Recepción Mercadería (RT)** se cierra automáticamente (`window.autoCloseRT(legajo)` expuesta desde
> `index.html`). El operario ya no necesita volver a la botonera para cerrar RT manualmente. La función
> replica el patrón de `ccSendClose`: `toggleStartOrEnd` + payload con `ts_inicio_iso` + `enqueueReport` +
> `trySendOneReport` + actualiza indicadores. RT se agregó a `AUTO_CLOSE_CODES`. **(2) Pop-up faltantes
> Moncayo:** después de las **15:30 AR**, cuando el legajo **104** (Moncayo) termina cualquier acción
> (`send()`), recibe un `alert` consolidado con **TODOS los faltantes** que tienen stock para completarse
> (góndola + a_guardar + excedente + racks), el **total de cajas** y la **ubicación** de cada NP (evento
> AUB). Solo dispara una vez por sesión (`_cpMoncayoShown`). Función `cpCheckFaltantesMoncayo()` reutiliza
> `cpLoadFaltantes` + `stockFetchSaldos` + consulta AUB. Reemplaza el recordatorio de v6.20 (que solo
> abría el CP sin mostrar datos). **(3) Botón "📢 Avisar" REMOVIDO** del panel Completar Pedido
> (`faltAvRender`): queda solo **📦➕ Cargar yo**. El hint se actualizó. `showFaltAvisar` ya no llama
> a `faltFetchActivasNps()`. La función `faltCrear` sigue definida (dead code). **(4) Fila precio en
> facturación:** se sacó la fila `<div class="facfc-des">` que mostraba "lista $X −N%" debajo de cada
> artículo. **(5) Fix OC en recepción:** `cargarOCVigentes()` llamaba al RPC `oc_vigentes_por_proveedor`
> con parámetro `p_nombre` (incorrecto) → `nombre_ent` (correcto). Sin el fix las cantidades de OC no
> aparecían en los botones de artículo.
>
> Nota **2026-08-27 — Facturación neto/faltantes: cálculo centralizado en vistas (`sql/facturacion_neto.sql`).**
> El neto y los faltantes dejan de vivir sólo en el front: el cálculo está en **vistas en vivo**
> (no se persiste — es dato derivado, fuente única). Objetos: **`vista_facturacion_neto_items`**
> (detalle por ítem CON dto → interna, **REVOKE anon**, protege el padrón); **`vista_facturacion_neto`**
> (por NP: `neto`, `neto_original`, `falto_valor`, cajas ped/ent/falto, items_sin_precio — **pública**);
> **`vista_facturacion_faltantes`** (por ítem con `cajas_falto>0` + `importe_falto` = $ no facturado —
> **pública**). Las RPC `facturacion_neto_lote`/`_detalle` ahora **leen de la vista interna** (misma
> fórmula, un solo lugar). Reusable en reportes/monitor/Telegram sin tocar el front. Las públicas
> **no exponen `dto_vol`** (sólo importes/netos). Verificado NP 98557: neto 753.146,86 · original
> 990.703,56 · faltó $237.556,70.
>
> Nota **2026-08-27 — v11.94 (Desglose Neto: faltantes en rojo + neto original).**
> El modal 💵 Neto ahora también detalla los **faltantes** (productos que no salieron,
> `Entregas_Virgilio.cajas_falto>0`) **en rojo** (código −cajas), y muestra **dos netos**:
> **NETO a facturar** (sobre lo armado = `cajas_entregadas`, sin faltantes) y **Neto original
> (pedido completo)** (sobre `cajas_pedidas`), más "Faltó facturar" = la diferencia. La RPC
> `facturacion_neto_detalle` se reescribió (DROP+CREATE, cambió el tipo de retorno) para devolver
> por ítem `cajas_ped/ent/falto`, `importe_ent` (armado) e `importe_ped` (pedido total). Los "sin
> precio en el maestro" (armados sin precio) siguen abajo, tachaditos, aparte de los faltantes.
>
> Nota **2026-08-27 — v11.93 (Histórico de Recepción: columna Demora de carga).**
> El **Histórico de Recepción** (recepcion.js, `renderHistorico`) muestra una columna
> **Demora** = cuánto tardó en cargarse el remito: **hora de carga de la operadora
> (`Control_Modo_OP.procesado_at`) − hora de llegada del remito (`Control_Modo_OP.created_at`)**
> — los mismos dos timestamps que ya usaba la pantalla **Pendientes** para el "⏱ Xhs" en vivo.
> Backend (vista): `vista_historial_entregas` ahora hace `LEFT JOIN LATERAL` a `Control_Modo_OP`
> (estado='procesado') por **remito + nombre** (LIMIT 1, no multiplica filas) y expone
> `llegada`, `carga` y `demora_hs`. Andan talleristas **y** proveedores (la demora sale de
> Control_Modo_OP, no de `created_at` de la entrega — que en proveedores es NULL). Recepciones
> viejas (previas al flujo de Pendientes) o sin match → `demora_hs` NULL → el front muestra "—".
> Front: helper `histFmtDemora` (m/h/d) + tooltip con las horas exactas (`histHoraTip`).
>
> Nota **2026-08-27 — v11.86 (Facturación: desglose por ítem del 💵 Neto, clickeable).**
> Al tocar la celda **💵 Neto** de una NP se abre un modal con el **desglose por ítem**:
> por cada código `lista × uxb × cajas × (1 − dto_vol) = importe`, luego **subtotal**,
> **− 2% sobre el subtotal** y **NETO**. Explicita la regla del dueño: **el dto x volumen
> se aplica por ÍTEM; el 2% va sobre el subtotal** (el neto del lote ya redondeaba una sola
> vez al final, así que numéricamente no cambió; ahora es explícito y auditable línea a línea).
> Nueva RPC **`facturacion_neto_detalle(p_np text)`** (`SECURITY DEFINER`, anon EXECUTE):
> devuelve `cod, cajas, uxb, precio_lista, dto_vol, importe, sin_precio` por ítem. La RPC
> `facturacion_neto_lote` se reescribió con el mismo redondeo (importe_item redondeado a 2 →
> `Σ × 0,98` → round) para que lote y detalle **siempre coincidan**. Front: la celda 💵 Neto
> es clickeable (`facNetoDetalle`), modal reusa el molde `.facfc-`. ⚠ El detalle **sí muestra
> el dto% del cliente de esa NP** — misma exposición que ya tenía el modal de facturar de
> `arca-wsfe/preciar`; NO expone el padrón entero (sigue por NP puntual, `clientes_dto` con RLS).
>
> Nota **2026-08-27 — v11.86-cron (clientes_dto: sync automático cada 14 días).**
> `clientes_dto` ya **no es sync manual**: se refresca solo desde LK. Como Virgilio **no tiene
> FDW/dblink** (solo la extensión `http` + `pg_net`), el patrón es **Edge Function + pg_cron**
> (igual que los `planify_*` y `sync_ppp_entregados_meta`):
> - **Edge Function `sync-clientes-dto`** (`verify_jwt=off`): lee `customers` de LK (paginado,
>   PostgREST corta en 1000/pág) con `WEB_SERVICE_KEY` (service_role de LK, secret ya existente
>   que usa arca-wsfe — el anon de LK NO puede leer `customers`, RLS lo protege) y hace upsert
>   en `clientes_dto` con el service_role propio. Idempotente. Devuelve `{ok, sincronizados}`.
> - **Cron `sync-clientes-dto-14d`** (jobid 61, `0 8 * * *` = 05:00 ART diario): dispara la
>   función por `net.http_post` **solo si** `max(clientes_dto.actualizado) < now() − 14 días`.
>   Así el intervalo es de **14 días exactos** y, si un día falla, reintenta al día siguiente
>   (auto-recuperación) sin adelantar el ciclo. Trigger manual: `SELECT net.http_post(...)` o
>   `http_post('.../functions/v1/sync-clientes-dto','{}','application/json')` (sincrónico).
>
> Nota **2026-08-27 — v11.85 (Facturación: columna 💵 Neto a facturar por NP).**
> El módulo **Facturación — NPs a FC** muestra ahora, por fila, el **neto a facturar
> (sin IVA)** del pedido: `precio_lista × uxb × cajas_armadas × (1 − dto_vol) × (1 − 2%)`.
> Es **sobre lo ARMADO** (`Entregas_Virgilio.cajas_entregadas`, ya neto de faltantes),
> así el importe baja solo cuando el pedido salió corto. **Solo VISTA** (no emite; el
> neto fiscal exacto al emitir sigue por `arca-wsfe/preciar`, sin tocar). **NO usa arca.**
> **Backend (todo en Virgilio, aditivo):**
> - **`clientes_dto`** (`cod_cliente`, `dto_vol`, `actualizado`) — espejo del `dto_vol`
>   por cliente de LK (`customers.dto_vol`). **RLS ON sin policy + REVOKE anon/authenticated**
>   → el padrón de descuentos **no es legible por anon** (evita filtrarlo). ~1272 clientes
>   (560 con dto > 0). **Sync AUTOMÁTICO cada 14 días** (ver nota v11.86-cron abajo).
> - **`facturacion_neto_lote(p_nps text[])`** — RPC `SECURITY DEFINER` que cruza
>   `Entregas_Virgilio × precios_venta × clientes_dto` y devuelve **solo** `np → neto, faltan[]`
>   (nunca expone dto_vol ni lista). `faltan` = códigos sin precio en `precios_venta` (el neto
>   los excluye). anon tiene **EXECUTE** (definer lee por él), no SELECT sobre la tabla.
> - **`canon_cod(text)`** — helper de normalización de códigos (upper, trim, saca ceros a
>   la izq), igual que `canonCod` del front / `arca-wsfe`.
> **Front (`index.html`, `facRender`):** columna nueva **"💵 Neto"**; al abrir Facturación
> hace **1 llamada** a la RPC con las NP visibles (cache `_facNeto`, se pinta por id
> `fac-neto-<np>` sin re-render). NP sin ítems armados → "—"; con códigos sin precio →
> "⚠ falta precio". **Re-sync de `clientes_dto`**: automático cada 14 días (ver nota
> v11.86-cron); para forzarlo al toque, disparar la Edge Function `sync-clientes-dto`.
>
> Nota **2026-08-26 — v11.82 (Ajuste "llenar góndola a N meses" en la OC puntual).**
> En la vista de detalle de una OC (Compras → abrir OC) la columna **Pedido** ahora
> es **editable** y hay una barra verde **⛽ Llenar góndola** con input de **meses**
> (default **6**) + botón **⛽ Aplicar a todas** + **💾 Guardar cantidades**. Cada
> línea tiene un botón **⛽** que setea la cantidad a `max(0, objetivo + pedidos −
> stock)` con `objetivo = MENOR(capacidad de góndola, proyección × meses)` — usa los
> snapshots de la fila (`oc_stock`/`oc_pedidos`/`oc_proy`, o proyección de hoy si la
> OC es vieja) y la capacidad de HOY (`Capacidad_Sector`, cargada con `ocEnsureCap`).
> Si `proy ≤ 0` o no hay capacidad → el botón no aplica (no llena a ciegas). Se agregó
> la columna **Cap gónd.** al detalle. Guardar hace PATCH de `Ordenes_Compra.cantidad`
> SOLO en esa OC (no toca la config permanente ni el cron). Todo front (index.html):
> `ocDetTarget`/`ocDetFill`/`ocDetFillAll`/`ocDetSave`/`ocEnsureCap`. La casilla
> permanente de v11.81 (llena a capacidad TOTAL) sigue existiendo pero para este caso
> se prefiere el ajuste por-OC a N meses.
>
> Nota **2026-08-26 — v11.81 (Casilla "llenar góndola" en el generador de OCs).**
> Problema: máximo = MENOR(proy×índice, capacidad); la capacidad de góndola era
> solo TECHO. Cuando la proyección es baja, la orden salía de muy pocas cajas
> aunque la góndola fuera grande (ej. Martín C.: 043 Tres en Uno → proy 2 × 1,5 =
> 3, con góndola de 180). Fix backend: nueva columna `OC_Maximos.llenar_gondola`
> (bool, default false). En los artículos tildados, **máximo = capacidad de
> góndola** (llena la góndola, ignora proy×índice); el resto sigue igual. La
> primera rama del CASE de `maximo` en `vista_generador_oc` la aplica, así que el
> cron (`generar_ocs_automaticas`) y el front reflejan solos. El operario elige
> uno por uno con la casilla **Llenar góndola** en Compras (OCs) → ⚙
> Configuraciones (columnas nuevas: Cap gónd. read-only + casilla; el índice se
> deshabilita cuando está tildada). SQL en `sql/oc_llenar_gondola.sql`.
>
> Nota **2026-08-26 — v11.80 (Botón flotante "Guardar cambios" en config OCs).**
> Los cambios de la config (proveedor/%/índice/activo/llenar góndola) no se
> auto-guardan: se marcan en amarillo y hay que apretar 💾 Guardar. Ese botón
> vivía solo arriba y se perdía al scrollear → se agregó un botón flotante fijo
> (abajo der.) con el contador de pendientes, siempre visible. Llama al mismo
> `ocCfgSave()`. Sincronizado vía `_ocCfgSyncBtns()`. Todo front.
>
> Nota **2026-08-26 — v11.79 (Popup capacidad de góndola trae las ubicaciones).**
> El popup "Capacidad de góndola" del tab stocks leía `_stk.cap` de la carga
> rápida (`stocks_carga_rapida`), que trae la capacidad AGREGADA por código (sin
> sector) → mostraba "1 ubicación · —". El detalle por sector (`Capacidad_Sector`)
> solo cargaba en el tab "capacidad" (`stkCapLoad`). Ahora `stkOpenCapArt`
> lazy-carga ese detalle si falta y re-renderiza (`stkRenderCapArt`); mientras
> carga muestra "Cargando ubicaciones…". Todo front.
>
> Nota **2026-08-26 — v11.75 (RR más ancho + fix mezcla tallerista/prov_at).**
> (a) **Recepción Remitos (RR)**: el modal `#tandaModal` usaba `max-width:560px`
> genérico y la tabla de 6 columnas quedaba con scroll horizontal en el monitor.
> Se agregó la clase `.cr-wide` (`max-width:900px`) que `showControlRemitos()`
> pone al abrir y `closeTandaModal()` saca al cerrar; además `.cr-td-rs`
> (Razón Social) pasó de 120px a 220px. Todo front (index.html).
> (b) **Vista `vista_entidades_recepcion`**: 9 entidades (Cabral, Carriero, Lopez
> Jose, Manfer, Maspoli, Melinox, Paternal Goma, Pintos, The Plast) existían en
> las dos tablas fuente y salían DUPLICADAS en recepción (tallerista + prov_at).
> Entregan como **Prov AT**, no como tallerista (ej. Cabral entrega el Filtro de
> Café 031 eventual; el proveedor principal de ese art es **Poly/Ijupa**). Fix
> backend: la mitad tallerista de la vista agrega `NOT EXISTS` que excluye a los
> Prov AT activos (`prov_at AND rec_virg AND activo`). Se auto-mantiene. Datos
> intactos (no se borró nada; una FK desde `Articulos Virgilio X Tallerista` lo
> impide). Talleristas 22 → 13. SQL en `sql/vista_entidades_recepcion.sql`.
>
> Nota **2026-08-26 — v11.74 (Fix OC vigentes no mostraba en recepción).**
> `cargarOCVigentes()` usaba `fetch` manual con la publishable key como Bearer
> token (no es JWT → PostgREST podía rechazarlo). Reemplazado por `supabase.rpc()`
> que usa el token de sesión real de `signInAnonymously`. Ahora "OC XX" aparece
> en los botones de artículo de recepción.
>
> Nota **2026-08-26 — v11.73 (Fix excedente negativo por drift acumulativo).**
> `reconciliar_pipeline_stock_etapa1()` sección B.2 (excedente) usaba
> `ON CONFLICT DO NOTHING`, lo que preservaba asignaciones viejas de excedente
> entre corridas del cron. Al cambiar el excedente disponible (nuevas MGs, otros
> pickings), la window recalculaba `from_exc` pero la fila existente no se
> actualizaba → drift acumulativo → excedente negativo (ej. art 546 llegó a -4).
> Fix: B.2 ahora usa `DO UPDATE SET delta = excluded.delta, legajo = excluded.legajo`
> — misma semántica que B.1 y B.3. Se auto-sana en el próximo cron.
>
> Nota **2026-08-26 — v11.72 (Legajo real en pipeline stock etapa 1 y 2).**
> `reconciliar_pipeline_stock_etapa1()` y `etapa2()` hardcodeaban `'pipeline'`
> como legajo en todos los `Movimientos_Stock` que creaban. Ahora extraen el
> legajo real del operario: etapa1 del último PKC de la tanda, etapa2 del último
> TAP de la tanda. Fallback a `'pipeline'` solo si el registro no tiene legajo.
> Etapa 3 y 4 mantienen `'pipeline'` (el actor es facturación/sistema).
> SQL guardado en `sql/reconciliar_pipeline_stock_etapa1.sql` y
> `sql/reconciliar_pipeline_stock_etapa2.sql`.
>
> Nota **2026-08-25 — v11.71 (OC pend: solo última OC por código).**
> `vista_faltante_catalogo` CTE `oc_pend` sumaba todas las OCs pendientes por
> código (`GROUP BY`). Ahora usa `ROW_NUMBER()` para mostrar solo la más reciente.
> Ejemplo: 590E mostraba 207 cj (suma de 3 OCs) en vez de 59 (última OC del 19/08).
> SQL guardado en `sql/vista_faltante_catalogo.sql`.
>
> Nota **2026-08-25 — v11.70 (Importación: la tabla se pisaba entera).** El pop-up **📦 Pedidos
> Importación** tiene **14 columnas**, pero heredaba el layout genérico de `.mva-tbl`
> (`table-layout:fixed` + la regla `th.num{width:15%}`): 11 columnas numéricas × 15% = **165 %**
> del ancho, así que el navegador achicaba **Código y Descripción casi a 0** (se imprimían una
> encima de la otra) y `.mva-tblwrap{overflow-x:hidden}` **cortaba m³ y Acciones** (los botones
> ✏️/📥 no se veían). Fix **solo de layout, sin tocar datos ni cálculos**: (a) modificador
> `.mva-tbl.wide` + `.mva-tblwrap.wide` con anchos explícitos por `<colgroup>` (suman 1216 px),
> scroll horizontal, header en 2 renglones y **columna Código fija** (sticky) al deslizar;
> (b) `_stkPopShell(title, bodyId, wide)` — tercer parámetro opcional: la tarjeta pasa de 760 px
> a `min(1280px,98vw)` **solo** en los dos pop-ups de Importación (📦 Pedidos y 🏭 Proveedores),
> el resto queda igual; (c) la tabla de 🏭 Proveedores (3 columnas) lleva tope de 900 px para no
> quedar estirada. De 1280 px de ancho para arriba entra **todo sin scroll**; abajo de eso
> (celular) se desliza al costado con Código fijo. La columna **Descripción** es la única que
> recorta con «…» (a propósito: tiene el nombre completo en el `title`; en monitor ancho se
> queda con todo el sobrante). Aparecieron **tres roturas más del mismo módulo**, todas por el
> `button{width:100%;padding:16px;font-size:22px;margin-top:14px}` **global** de la app:
> **(1)** los botones `✏️`/`📥` de la columna Acciones se estiraban al 100 % de la celda porque
> las reglas de `.stk-btn` viven en `#stkCss` — la CSS del módulo **Stocks**, que se inyecta
> recién al abrir Stocks — y este pop-up se abre **directo** desde el panel supervisor; se
> agregaron `.stkpop-body .stk-btn{...}` a `STK_POP_CSS` (mismos valores, acotados al pop-up).
> **(2)** las solapas 📦 Pedidos / 🏭 Proveedores salían como dos barras apiladas de ancho
> completo (`_impTabsHtml` no ponía `width:auto;margin:0`). **(3)** `.mva-clear` y
> `.stkpop-close` no fijaban `font-size`, así que «📥 Excel», «🖨 PDF pedido» y «Cerrar»
> heredaban 22 px y quedaban gigantes (esto último toca **todos** los pop-ups de Stocks: ahora
> se ven proporcionados). Regresión cubierta por `tests/imp-tabla.cjs` (mide el layout real en
> el navegador: ninguna celda más ancha que su columna, Acciones visible, sticky en celular).
>
> Nota **2026-08-25 — v11.62 (Carga Camión: fix «todo sin ubicación en ruta»).** El orden de ruta de
> Carga Camión (`_ccAttachUbicYOrden`) solo corre si el **depósito** está geocodificado en `PPP_Geo`
> (`dir_key='__deposito_virgilio_2788__'`). Estaba **ausente** → `if (depot)` era falso → **ninguna** NP
> se ordenaba y **todas** caían en «📍 Sin ubicación en ruta — cargar aparte» (aunque tuvieran zona y
> dirección geocodificada). Fix: nuevo **`_rtEnsureDepot(cache)`** geocodifica el depósito on-demand
> (Nominatim en el navegador) y lo cachea en `PPP_Geo`; Carga Camión lo llama si falta → se **auto-repara**
> la 1ª vez que se abre y queda cacheado. (No confundir con la ubicación física 📌 AUB por NP, que es otro
> dato y sí funcionaba.)
>
> Nota **2026-08-25 — v11.60 (Cola de impresión de NP armadas).**
>
> Nota **2026-08-25 — v11.60 (Cola de impresión de NP armadas).** Nuevo botón en el panel supervisor
> **«🖨️ Cola de impresión NP»** (`openColaImpresion`). El operario, al **terminar armado**, emite un `TAL`
> por cada NP → la vista **`vista_cola_impresion`** junta las NP armadas (desde el ancla `2026-08-25 12:10`)
> que **todavía no se imprimieron** (`Impresion_NP` = marcador de impresas, PK np, RLS anon select+insert).
> El supervisor toca **«Imprimir todas»** e imprime el **REMITO DE ARMADO** de cada NP —generado en la app
> desde el `resumen` del TAL, **mismo formato que la estación de auto-impresión** (`armadoRemitoData` →
> `armadoRemitoInnerHtml` → `remitoPrintDoc`); **NO usa la carpeta de PDF ISIS**. La construcción se factoró
> en **`_armadoRemitoDataForItems(items)`** (reusada por `psPrintBatch` de la estación y por la cola). La
> vista expone `resumen` y `armador_leg` (del TAL) para armar cada remito. Con Chrome `--kiosk-printing`
> salen solas. Cada NP impresa se marca en `Impresion_NP` y sale de la cola. **Alarma:**
> `vencido = armado hace +24 h` → badge **rojo** con ⚠ (`colaImpLoadBadge`, cargado con los demás badges del
> panel). La cola es **per-NP** vía TAL (se emite al terminar armado, incluye retira/súper con clase). Para
> ampliar/limpiar: subir el ancla en la vista, o borrar filas de `Impresion_NP`.
>
> Nota **2026-08-25 — v11.55→v11.58 (Pasaje de Papeles).** El módulo se reorganizó en **2×2** (encabezado
> `_ppGroupHeader`; `_ppBuildSection(key, kind, …)` separa `kind` = comportamiento del `key` = id de colapso).
> **Eje responsabilidad:** **🏭 Virgilio = ENVÍO** (lo que falta mandar, `enviado=false`, con timer/checkbox) ·
> **🏢 Cervantes = RECEPCIÓN** (lo ya enviado, `enviado=true`, con «Confirmar recepción» + «Recibido el…»
> inline). **Eje tipo:** **Prov** (remito de proveedor/tallerista, `origen != 'rr'`) · **Venta** (remito de
> venta conformado en RR, `origen == 'rr'`). Da 4 módulos: Virgilio → «Envío remitos Prov» + «Envío remitos
> Venta»; Cervantes → «Recepción remitos Prov» + «Recepción remitos Venta». (v11.55-57 tuvieron modelos
> intermedios equivocados — Alan, Logística, Virgilio=recepción — corregidos en v11.58.)
> **v11.59 — se REVIRTIÓ:** por pedido del usuario se sacaron los remitos de **venta/RR** de Pasaje de
> Papeles. El módulo volvió a la **lista única** de 3 secciones (Documentación pendiente · enviada ·
> Recibidos), solo remitos de talleristas. Se **frenó el cron** `sync_pasaje_rr_10min` (unschedule), se
> **borraron** las filas `origen='rr'` y se sacó la llamada al RPC en `ppLoadData`. Queda en pie (por si
> se reactiva): función `sync_pasaje_rr()`, columna `origen` y `oc_proy`. **Se conserva** el chip de
> **código de proveedor** (v11.57) en los remitos de recepción. `pasaje-papeles.js?v=5.2`.
> **(v11.57)** En los remitos de **recepción** se muestra el **código del proveedor/tallerista** (chip azul
> antes de la razón social). Nueva columna `Pasaje_Papeles.cod_proveedor`: se **captura** en Recepción de
> Mercadería (`recepcion.js` pasa `opState.tallCod`) y se **backfilleó** por nombre vía
> `vista_entidades_recepcion` (coalesce `cod_default/cod_lk/cod_ch/cod_factura`). Insumos pueden quedar sin
> código (no siempre está). `pasaje-papeles.js?v=5.0`, `recepcion.js?v=10.25`.
>
> Nota **2026-08-25 — v11.54 (Pasaje de Papeles: remitos de venta conformados en RR).** Los remitos
> de **venta** que el operario controla en **Recepción Remitos (RR)** (eventos **CRN**) ahora también
> aparecen en **Pasaje de Papeles** para pasar sus papeles. **Backend:** RPC **`sync_pasaje_rr()`**
> (SECURITY DEFINER, anon EXECUTE) **materializa** cada NP conformada como fila real de `Pasaje_Papeles`
> (`tipo_documento='remito'`, `tipo_contenido='mercaderia'`, `numero_remito`=NP, `razon_social` de
> `Facturacion_NP`/`PPP_Entregados_Meta`, `fecha_emision`/`fecha_remito`=`fecha_salida`, `created_at`=ts
> del control, **`origen='rr'`** — nueva columna para distinguir de las capturadas en Recepción de
> Mercadería, `origen` NULL/'recepcion'). Se materializa (no vista) para que entren al MISMO flujo
> enviar/confirmar (el front actualiza por `id`). **Idempotente** (dedup por `origen='rr'` + `numero_remito`).
> **Ancla** `2026-08-25` (solo de esa fecha en adelante; evita inundar «pendiente» con ~700 históricos
> cuyos papeles ya se pasaron — subir la constante en la función para ampliar). Se dispara por **cron**
> `sync_pasaje_rr_10min` (cada 10 min) **y** desde el front al abrir el módulo (`ppLoadData`, `pasaje-papeles.js?v=4.7`).
>
> Nota **2026-08-25 — v11.49→v11.52 (varios OC/Stocks).** **(v11.49)** Reporte «Góndola <25%»:
> columna «% góndola» renombrada a **«% Ocup Virgilio»** (tabla + Excel + PDF; solo rótulo).
> **(v11.50)** Vista de OC por fecha (tarjetas por tallerista): **buscador por nombre** (filtra
> por proveedor/rubro, `_oc.filtro`). **(v11.51→v11.52)** Detalle de OC (al abrir un tallerista):
> columnas más juntas + 3 columnas **solo-pantalla** (no van a los impresos Operador/Tallerista/
> WhatsApp): **Stock · Máximo · Proyección**. Son del **momento en que se generó la OC**, no de hoy:
> salen de los snapshots que la OC ya guardaba (`Ordenes_Compra.oc_stock`, `oc_max`) + **nueva
> columna `oc_proy`** (proyección al generar; se empieza a guardar en v11.52, las OC previas quedan
> «—»). El generador (`ocgEnter`) ya traía `proy` del item; el insert de OCs (`oc_stock/oc_max/…`)
> ahora suma `oc_proy: it.proy`. Así el «Pedido» y el contexto (máximo−stock−pedidos) cuadran de la
> misma foto (ej. cód 104: oc_max 40 − oc_stock 24 = 16 pedido).
>
> En la misma versión se sacaron dos `document.body.innerHTML = ...` de la suite
> (`tests/ocg-config.cjs` y `tests/stk-ajuste-deps.cjs`) que **borraban el DOM entero de la app**
> para plantar un input: cualquier timer de la página que corriera después se encontraba con sus
> elementos desaparecidos y tiraba `Cannot read properties of null`, que el test cuenta como
> pageerror y hace fallar algo que no tiene nada que ver. Era una **carrera**: fallaba según cuándo
> cayera el timer, o sea rara vez acá y seguido en un runner lento — que es el patrón de la **CI, en
> rojo desde antes de esta tanda**. Ahora los controles se **agregan** en vez de reemplazar el body.
>
> Nota **2026-09-03 — v12.68: auto-ajuste de ancho (solo si hace falta) en Proy. caj/mes, Total Stock y Cajas Pedidas: si la cifra más larga no entra en el ancho fijo, se ensancha a lo justo (piso = ancho fijo). v12.67: encabezado del Excel de Stocks en NEGRITA (fontId 1). v12.66: formato (bordes + alineación + ajustar texto).**
> Pedido del dueño. El export ya no usa SheetJS: el community NO escribe estilos (bordes/alineación
> son feature Pro) y no se quiso sumar `xlsx-js-style`. Se agregó un generador `.xlsx` OOXML propio
> **`_stkXlsxStyledBlob()`** (reusa `_facZip`/`_facCrc32`/`_facColLetra`, sin dependencias). Formato:
> **toda** celda con *alinear al medio + centrar + ajustar texto*; encabezado (fila 1) con borde
> **grueso negro en las 4 aristas** (interior y exterior); **perímetro** de la tabla grueso; grilla
> interna de datos **fina**. Anchos de columna (unidades Excel): 7.63 / 3.88 / 30.5 / 8.88 / 6.25 /
> 6.63. Códigos van como texto (no se numerizan). Verificado con openpyxl.
>
> Nota **2026-09-03 — v12.65: botón "📥 Excel" en la hoja Stocks (Stock y Compras).**
> Pedido del dueño. En la barra de filtros de la solapa **Stocks** hay un botón que descarga un
> `.xlsx` real (vía SheetJS, `pppLoadXlsx`) con **exactamente lo que se ve en pantalla**: respeta
> TODOS los filtros activos (búsqueda de varios códigos, LK/CH, 🔴 Negativos, ⚠ Stock bajo, 📌
> Fijados, 🚫 Discontinuos, filtro por columna) y el mismo orden. Columnas exportadas: **Código,
> LK/CH, Descripción, Proy. caj/mes, Total Stock, Cajas Pedidas** (de "Código" hasta "Cajas
> Pedidas", sin las de depósitos). Implementación: `stkBodyStocks()` guarda un snapshot de las
> filas mostradas en `_stk._expRows` mientras dibuja; `stkExportarExcelVista()` lo escribe. (La
> vieja `stkDescargarExcel()` v7.77 sigue huérfana desde v8.93 y re-filtraba con lógica vieja —
> por eso NO se reusó.)
>
> Nota **2026-09-03 — v12.64: Remito y Factura pide LAS DOS fotos, y las dos se ven.**
> Pedido del dueño. En Recepción de Mercadería, cuando el operario elige el tipo de documento
> **"📄🧾 Remito y Factura"**, ahora se le piden **dos fotos rotuladas** —una del remito y otra de la
> factura— y **las dos son obligatorias**: "Confirmar y enviar" no se habilita hasta tener ambas.
> Con un solo documento (sólo remito, o sólo factura) sigue siendo **una sola**, igual que siempre.
> En **Pendientes** el botón dice "👁 Ver fotos (2)" y el visor muestra las dos, una al lado de la
> otra en monitor y **una abajo de la otra en celular** (al lado quedarían de ~180 px y un remito no
> se lee). Las recepciones anteriores siguen mostrando su única foto.
> La segunda URL va en la columna nueva **`Control_Modo_OP.foto_factura_url`**; la primera sigue en
> `foto_url`. **El SQL está en `sql/control_modo_op_foto_factura.sql` y NO se ejecutó** — se corre a
> mano cuando el dueño quiera. **Mientras tanto la app no se rompe**: si la columna falta, el insert
> se reintenta sin ella (se pierde la foto de la factura, nunca la recepción) y el `select` de
> Pendientes también, porque sin ese respaldo PostgREST rechaza la consulta entera y la pantalla
> quedaría vacía por una foto. Los dos caminos están cubiertos por
> `tests/rcp-foto-remito-factura.cjs`. Bump a `v12.64`. Suite verde.
>
> Nota **2026-09-03 — v12.63: el filtro "Con faltante" vuelve a tener entrada.**
> Estaba en el chip de `.fac-stats`, oculto desde la v12.53, así que el filtro andaba pero no había
> cómo llegar a él (el test lo llamaba a mano y por eso pasaba en verde ocho versiones sin que
> nadie se enterara). **No vuelve al encabezado** —esa fila el dueño la pidió despejada— sino a una
> barra pegada arriba de la tabla que filtra, que es donde se usa, y que **sólo aparece cuando hay
> al menos una NP con faltante**: el día que no hay ninguna no ocupa nada. Prendido, el botón se
> invierte a rojo pleno y aparece un "✕ Ver todas (N)", para que se vea de un vistazo que la tabla
> está filtrada. `tests/fac-falta-filter.cjs` ahora **hace clic en la barra** en vez de invocar
> `facToggleSoloFalt()`, y exige que se VEA de verdad (`offsetParent`): así el agujero por el que
> se perdió la entrada no puede volver a pasar en verde. Bump a `v12.63`. Suite verde.
>
> Nota **2026-09-03 — v12.62: los avisos de columna vacía van en UNO solo, para que no sean ruido.**
> Los avisos repuestos en v12.61 salían por separado y medidos contra los datos eran demasiado
> frecuentes: en **Chef el vendedor falta en 40 de 65 NP (62 %)**, o sea que el cartel aparecía casi
> siempre. Un aviso que sale siempre enseña a apretar "Aceptar" sin leer, y el que se pierde con eso
> es el que de verdad importa: **más armado que pedido**, que manda el doble de cajas. Ahora
> "vendedor" y "unidades por caja" van juntos en un solo `confirm()`, y el de Chef aclara que es lo
> **esperado**; en Loekemeyer el vendedor falta en 24 de 405 (6 %), así que ahí sí se marca como
> excepción. Los que sí cortan aparte siguen siendo los que rompen la importación: sin código de
> cliente, sucursal vacía o dudosa, y más armado que pedido. Bump a `v12.62`. Suite verde.
>
> Nota **2026-09-03 — v12.61: vuelven los avisos que el Excel de ISIS había perdido.**
> El rewrite de la v12.54 (selección por casillas en vez de pantalla intermedia) se llevó puestos
> los avisos por fila que tenía el checklist. Quedaba **uno solo** (más armado que pedido), así que
> el archivo podía salir **sin sucursal**, **sin vendedor** o con la **sucursal equivocada** y nadie
> se enteraba. Vuelven los tres, como `confirm()` que no cortan la bajada pero la hacen consciente.
> El de sucursal distingue **vacía** de **dudosa**, que es peor porque se ve bien: pasa cuando el
> cliente tiene más de un pedido web ese día y los artículos no alcanzan para desempatar. Además
> se empezó a usar la columna **`ambiguo`** de `lk_pedidos_match`, que se traía y se ignoraba: la
> marca la vista de LK para el caso que el string de match no puede resolver por construcción
> (mismo cliente, mismo día, mismos ítems, sucursal distinta — 17 de 977 pedidos históricos).
> `tests/fac-falta-filter.cjs` medía `style.display` y daba el chip "Con faltante" por visible
> cuando su padre `.fac-stats` está oculto desde v12.53: ahora mide visibilidad real
> (`offsetParent`) y **avisa en cada corrida** que el filtro anda pero no tiene entrada desde la
> pantalla. **Pendiente para el dueño:** decidir dónde reponer esa entrada, o si se deja así.
> Bump a `v12.61`. Suite verde.
>
> Nota **2026-09-03 — v12.60: unidades por caja del Excel de ISIS, sin adivinar.**
> El respaldo que buscaba el `uxb` de un código con letra sacándole la letra y usando el del
> artículo numérico homónimo (`102E` → `102`, `438E` → `438`) tomaba el de **otro producto**: la
> columna de unidades salía con un número plausible y equivocado. Ahora se busca **sólo por el
> código exacto** y, si falta la ficha, la columna va vacía **con aviso** en vez de en silencio.
> Se documentó además que `_facXlsPadCod` da vuelta los códigos que empiezan con letra
> (`XXX4` → `004XXX`) igual que el `padCodArt` de la Edge Function: se deja así **a propósito**,
> porque el archivo tiene que reproducir el que ISIS recibe hoy — arreglarlo de un solo lado haría
> que los códigos dejen de coincidir. Hoy no afecta a nada: los códigos de los pedidos web son
> **3 dígitos + letras opcionales** (16.105 líneas, 0 excepciones) y en `Entregas_Virgilio` lo son
> **9.417 de 9.418** — la única excepción es un `55215` suelto en la NP 98109, que es el mismo
> registro que figura como incidente de dato en el `CLAUDE.md`, o sea basura y no un artículo. Bump a `v12.60`. Suite verde.
>
> Nota **2026-09-03 — v12.59: el Excel de prueba para ISIS respeta el orden REAL de las líneas, y arreglos del módulo Facturación.**
> El botón **⬇ Excel ISIS (prueba)** (Paso 0 de la idea 3717) ordenaba las líneas de cada NP por
> **código de artículo ascendente**. Estaba **mal**: la Edge Function `procesar-pedidos-db` del
> proyecto LK, que arma el Excel que hoy sale por mail a las 12:30, **no ordena nada** — escribe las
> líneas en el orden de `sheets_payload.items` (el orden del carrito) y corta de a **18** (Loekemeyer)
> o **15** (Chef) sobre *ese* orden; ISIS numera lo que recibe. La regla equivocada coincidía casi
> siempre porque el 95 % de los carritos ya viene ordenado por código, así que ningún conteo la
> delataba. Contra los datos: **145 de 801 NP de `PPP_Base_Pedidos` (18,1 %) NO están en orden de
> código**. Ahora el orden se **recupera de `PPP_Base_Pedidos` ordenada por `id`**, que conserva el
> orden con que ISIS tiene las líneas (`_facXlsOrdenIsis` / `_facXlsCmpLineas`); las NP sin fila ahí
> (20 de 470 facturadas en 30 días) caen a código ascendente como respaldo. Todos los códigos de
> artículo son de **3 dígitos** (16.105 líneas, 0 excepciones), así que con el `padStart(3,"0")` el
> orden alfabético y el numérico son el mismo: **no hace falta** un comparador numérico.
> Además: el `.xls` y el `.xlsx` se unificaron (mismo aplanado, mismo aviso del Resumen y **mismo
> nombre con `_HHMM`** — sin eso dos bajadas del mismo día se pisaban); el test `fac-excel-isis.cjs`
> cubre ahora el botón entero y el orden real; y `version.json` estaba clavado en **v12.48** desde
> la v12.49, o sea que el banner **🔄 Actualizar** llevaba diez versiones sin dispararse — se
> corrigió y `tests/version-sync.cjs` ahora lo verifica junto con `APP_VERSION` y `SW_VERSION`.
> Arreglos de render de Facturación: zona tocable de la casilla de **44 px** (el dibujo sigue en 20),
> casilla **sticky a la izquierda** en celular (antes había que volver 616 px de scroll por fila),
> `box-sizing: border-box` en los bloques con `max-width` (el recuadro de Cierre asomaba 13 px por
> lado a 1920 px), los dos botones del encabezado con la misma caja (36 px), y el botón sin NP
> marcadas cambia de **paleta** en vez de bajar a `opacity:.55` (quedaba en 2,7:1 de contraste y se
> leía como deshabilitado). **Revertir** volvió a tener entrada: está en **Administración**
> (`facRevertirDesdeAdmin`), porque su botón vivía en `.fac-stats`, oculto desde v12.53.
> Se sacó de `openFacturacion()` un `facCorreccRefreshCount()` que releía dos tablas para pintar un
> chip invisible, en paralelo con la lectura que `facTick()` ya hace. `tests/mon-silencio.cjs` era
> flaky: sembraba eventos con `Date.now()` y fallaba corrido entre las 00:00 y las 05:00 ART, cuando
> esos eventos caen en el día anterior; ahora tiene la hora clavada al mediodía.
> Bump `APP_VERSION` + `SW_VERSION` + `version.json` a `v12.59`. Suite verde.
>
> Nota **2026-09-02 — v12.50: gate anti TAP-sin-Entregas en Fin de Jornada (rescatado de una rama nunca mergeada).**
> Escrito el 31/08 en `claude/missing-prices` como "v12.17"; ese número lo usó otra sesión en
> paralelo para otra cosa (*facturación solo muestra NPs con ítems armados*) y el gate nunca llegó
> a `main`. En `confirmarTerminarDia()`: si el cierre es un **Armado** y esa tanda **no tiene
> filas en `Entregas_Virgilio`** (`_compTandaYaArmada()` devuelve `false`), no se puede facturar,
> así que se **aborta el Fin de Jornada**, se avisa y se abre el asistente **Completar** para que
> el operario registre el armado primero. Mismo criterio que ya aplicaba `send()` desde v7.74 al
> cerrar un TAP suelto. Exceptúa al operador de prueba y a las tandas ya registradas en
> `_armadoRegistrado`. **Lección de la auditoría de ramas:** dos sesiones paralelas que parten del
> mismo `main` y reusan el mismo número de versión se pisan y una pierde el trabajo.

> Nota **2026-09-02 — limpieza: todo lo que hablaba de "estadística madre" y estaba de sobra (propuesta 2496).**
> Inventario en los dos proyectos: 5 tablas, 2 vistas propias, 1 foránea, 17 funciones y 3 crons
> hablaban de proyección / estadística madre. Se borró lo que no aportaba (backups en
> `sql/backups/backup_limpieza_virgilio_20260902.sql` y `…_estadistica_madre_import_20260506_LK.sql`):
>
> - **Virgilio · `E. Madre LK` / `E. Madre CH` traían una SEGUNDA estadística madre.** Una columna
>   `"E. Madre"` con un número fijo por artículo cargado a mano el 12/03/2026, que
>   `recalcular_maximo_por_cod/desc` usaba para fijar `Partes x Tallerista.maximo` y dos vistas
>   (`v_piezas_por_tallerista_consumo_final`, `v_debug_piezas_consumo`) usaban como "consumo" de
>   piezas. Estado real: 0 de 954 filas con `maximo > 0`, sin llamadores (front, cron, trigger,
>   vista, doc), y las funciones ejecutables por `anon`. Se borraron las dos funciones, las dos
>   vistas y la columna — **y la columna se RESTAURÓ una hora después**, con sus 592 valores
>   desde el backup: los logs de la API de Supabase mostraron que **otra app**,
>   `GestionProductivaEntero` (Vercel, `gestion-productiva-entero…vercel.app`), la pide **42 veces
>   por día** (`select=Cod,"E. Madre"`) en **7 módulos** (Compras/cajas, Envíos y Control de
>   talleristas, Stock flejes/cartones/cajas, Stock SP) como "consumo mensual" en unidades para
>   comprar cajas y flejes y fijar máximos de talleristas. Es la tercera estadística madre, viva,
>   con un número fijo de marzo, y encima cada módulo combina LK y CH distinto (suma / máximo / LK
>   primero). **Lección:** el catálogo de un proyecto no dice quién lo consume desde otra app; hay
>   que mirar `edge_logs` por `request.path` + `referer`. **Resuelto el mismo día:** la columna
>   **se deriva de `proyeccion_madre.proy_uni_mes`** (`actualizar_e_madre_desde_proyeccion()`,
>   trigger `AFTER INSERT` a nivel sentencia sobre `proyeccion_madre`, o sea después de cada push
>   semanal desde LK). `E. Madre LK` recibe el número único LK+Chef y `E. Madre CH` queda en 0 salvo
>   los códigos que sólo existen ahí, así suma / máximo / LK-primero dan lo mismo. La app no cambió.
>   Ver `sql/e_madre_desde_proyeccion.sql`. **Las tablas quedan**: son la fuente prioritaria de **nombres** de artículo
>   (`vista_nombres_articulos`, prioridad `E. Madre LK` > `Articulos Virgilio X Tallerista` >
>   `OC_Maximos`) — por eso se tocó el 24/08 (alta del 599E). Tienen `comment` que lo dice.
> - **Virgilio · `refresh_proyeccion_madre()`** borrada: el pull HTTP con la anon key que fallaba en
>   silencio; no puede funcionar (anon no tiene `EXECUTE` en LK) y dejarla invitaba a correrla a
>   mano creyendo que refresca. `sql/refresh_proyeccion_madre.sql` quedó marcado como histórico.
> - **LK · `fn_proyeccion_madre_emp` y la firma `_fn_proy_window(p_meses, p_emp)`** borradas: sin
>   llamadores. El motor tiene **una sola firma**, `_fn_proy_window(p_meses)`.
> - **LK · `estadistica_madre_import_20260506`** (el último Excel, 294 filas) borrada de la base;
>   queda sólo en el repo.
> - `Pieza Madre` (75 filas) **no se tocó**: es matricería, comparte sólo la palabra.
>
> Lo que queda es exactamente la cadena: `sales_lines` → `_fn_proy_window` → `fn_proyeccion_oc_virgilio`
> → `sync_proyeccion_madre_virgilio` → `proyeccion_madre` (Virgilio) y → `fn_proyeccion_madre` →
> `refresh_estadistica_madre_cache` → `estadistica_madre_cache` → vista `estadistica_madre` (LK).
> Verificado después de borrar: `vista_nombres_articulos` y `vista_generador_oc` siguen vivas,
> 505 = 2.348,7 en todos lados, y los 3 md5 de `sql/fn_proyeccion_oc_virgilio.sql` = deploy.

> Nota **2026-09-02 — v12.47: la proyección tiene UN solo criterio y UN solo número (propuesta 2496, v3).**
> El usuario rechazó la v2 con el gráfico a la vista: *"si está por abajo de 4 de los últimos 6 meses
> no es una proyección confiable. No puede ser diferente el criterio. Es solo UNA estadística
> madre"*. Tenía razón dos veces: (1) cualquier descarte de picos resta volumen que ocurrió y empuja
> la proyección por debajo de la mayoría de los meses — con la v2 lo violaban **70 de 385**
> artículos; (2) las OCs (2080,8) y el panel Estadística Madre de LK (2016,1) daban distinto porque
> el panel tenía su propia tubería en unidades.
>
> **Criterio único, en LK `_fn_proy_window`:** proyección = **promedio simple de cajas facturadas
> de los últimos 6 meses** (LK+Chef, meses sin venta cuentan 0) **con piso en el 4.º mejor mes**,
> así por construcción nunca queda por debajo de 4 de los 6. Medido: **0 violaciones** (el
> promedio pelado tenía 28; la mediana también daba 0 pero sub-proyecta un 10% porque ignora los
> picos). El piso aplica sólo a la ventana de 6; en el fallback de 12 va el promedio pelado, para
> no proyectar el ritmo viejo de un artículo que dejó de venderse. Se eliminó `fn_proy_descarte`.
> `refresh_estadistica_madre_cache` **ya no calcula**: toma la proyección de `fn_proyeccion_madre()`
> → el mismo motor. Y `admin.js` (LK y espejo `/admin/`) **ya no calcula en JS**: tenía tres
> fórmulas de fallback (por cliente con descarte de picos, y "promedio de los últimos 3 meses");
> sin caché la columna queda vacía en vez de inventar un número.
>
> **Verificado:** 505 = **2.348,7** caj/mes en el motor, el caché, la vista `estadistica_madre` y
> `proyeccion_madre` de Virgilio (antes 1.667,6 → 2.080,8 → 2.348,7). Total del catálogo
> **22.371** caj/mes (+14% sobre los 19.593 de la v2; el nivel de compras SUBE, es lo que pide la
> regla). Balance 2,02 meses por encima. Los 5 md5 de `sql/fn_proyeccion_oc_virgilio.sql`
> coinciden con lo desplegado. Pop-up (v12.47): la línea gris "promedio 6m" sólo se dibuja cuando
> difiere de la proyección (o sea, cuando actuó el piso), y el pie lo marca "(piso: 4.º mejor mes)".

> Nota **2026-09-02 — v12.46 (idea 5766): el pop-up de proyección muestra un gráfico en vez del texto.**
> El bloque "¿De dónde surge?" (explicación fija de la regla) se reemplazó por un **gráfico de
> tendencia de 12 meses** (`_stkProyTrendSvg`, SVG inline sin librerías): línea + área de cajas
> facturadas, la **proyección** (violeta, guiones) y el **promedio simple de la ventana** (gris,
> puntos) como líneas de referencia, la **ventana de 6 meses sombreada** y cada mes coloreado según
> quede por encima (violeta) o **por debajo (rojo)** de la proyección. Si las dos etiquetas de
> referencia quedan a menos de 11 px, se separan. El RPC `ventas_mensuales_cod` ahora se pide con
> `p_meses: 12` (rellena con 0 los meses sin venta, así siempre vuelven 12). Las barras de abajo
> muestran sólo la ventana de 6 meses, con la **marca vertical de la proyección** y en rojo los
> meses por debajo; el pie dice **cuántos de los 6 meses quedan por encima**, que es el chequeo de
> sanidad que disparó toda la corrección de la proyección. La regla de cálculo sigue viviendo en LK
> (`fn_proy_descarte`); acá sólo se dibuja. Verificado headless con los datos reales del 505.

> Nota **2026-09-02 — `estadistica_madre` (LK) deja de ser un Excel importado a mano.**
> Era una tabla que se llenaba desde un Excel con un importador en Análisis Venta Cliente,
> importada por última vez el **6/5/2026** (294 filas contra 521 del caché), y la leían el panel
> **y el portal del cliente** (`script.js` de LK): las sugerencias al mayorista se ordenaban con
> datos de mayo y 227 productos ni existían ahí. Decisión del usuario: *"el Excel ya no se
> debería utilizar más; los datos de ventas salen de `sales_lines` y la proyección tiene que
> salir internamente"*. Ahora es una **vista** sobre `estadistica_madre_cache` (cron diario, ya
> con ventana de 6 meses y la regla única `fn_proy_descarte`) con la misma forma que la tabla, así
> que ningún lector cambió. El Excel histórico quedó en `estadistica_madre_import_20260506`. El
> importador se retiró de `admin.html` y `analisis-venta-cliente.js` en LK **y en el espejo
> `/admin/` de este repo** (135 líneas de HTML y 353 de JS, idéntico en los dos). Con esto **la
> proyección tiene una sola fuente en todo el sistema**: OCs, Estadística Madre y portal leen el
> mismo número.

> Nota **2026-09-02 — la proyección pasa de PULL a PUSH, y los watchdogs no avisaban.**
> Al arreglar la proyección (nota de abajo) se descubrió que `refresh_proyeccion_madre()`
> venía fallando **en silencio desde el 12/08**: un barrido de seguridad en LK le revocó el
> `EXECUTE` a `anon` sobre `fn_proyeccion_oc_virgilio`, el GET pasó a dar **401**, la función
> devolvía **−1 sin recargar** y el cron marcaba **"succeeded"**. Tres semanas con el Máximo
> de las OCs calculado sobre una proyección congelada.
>
> **Arreglo — se dio vuelta el sentido.** Ahora **LK EMPUJA** con
> `sync_proyeccion_madre_virgilio()` por el FDW `virgilio_db` (rol `lk_ppp_reader`, cron
> `sync-proyeccion-madre-virgilio`, miércoles 09:20 UTC). Reusa la credencial que ya existía,
> no expone nada, y deja a Virgilio leyendo una tabla **local**. Mismo patrón que
> `sync_pedidos_match_virgilio()`. Se dio de baja el cron `refresh_proyeccion_madre`; la
> función queda como fallback manual. Verificado: el push da un resultado **idéntico** al pull
> (408 filas, md5 `b3d4ad71…`). Detalle en `sql/sync_proyeccion_madre_push.sql`.
>
> ⚠ **Y el watchdog tampoco servía.** `tg_enqueue` es
> `(p_text, p_dedup default null, p_chat default '-1004379879565', p_parse_mode default null)`,
> y `watchdog_syncs_externos` la llamaba como `tg_enqueue(msg, dedup, null, null)`. **El `null`
> explícito pisa el DEFAULT del chat**, así que el insert violaba el `NOT NULL` de
> `telegram_outbox.chat_id` — y como el `PERFORM` estaba envuelto en
> `exception when others then null`, el error se tragaba entero. **El watchdog puesto para
> cazar fallos silenciosos fallaba en silencio desde que se aplicó (28/08).** Corregido: se
> llama con 2 argumentos y el `then null` pasó a `raise warning`.
>
> **Regla que sale de acá:** no pasar `null` explícito a un parámetro que tiene `DEFAULT`, y
> no tragarse errores de un canal de aviso con `then null`.
>
> Se sumó **`watchdog_frescura_datos()`** (cron `watchdog-frescura-datos`, :43 de cada hora),
> que vigila la **edad del dato** en vez del cron. Es lo único que hubiera cazado este fallo:
> sirve aunque el cron reporte "succeeded" sin escribir, y aunque el cron viva en otro
> proyecto. Hoy vigila `proyeccion_madre` (umbral 9 días). Ver `sql/watchdog_frescura_datos.sql`.

> Nota **2026-09-02 — la proyección tenía DOS errores que se compensaban (propuesta 2496).**
> Disparador: la proyección del **art. 505** daba 1667,6 caj/mes contra 5 de sus 6 meses reales
> por encima (2134/2160/3609/2070/1421/2698). Un pronóstico por debajo de casi toda la serie
> real no es un pronóstico.
>
> **(1) El filtro de anomalías anulaba a los clientes de compra ocasional.** Descartaba el mes
> ENTERO si `v > 1.5×promedio AND ningún otro mes llega al 0.8×v AND el mes previo < 0.5×v`.
> Para un cliente con **una sola compra** en la ventana las tres condiciones se cumplen **por
> construcción** (`promedio = v/n`, `max_other = 0`, `prev = 0`): era imposible que zafara. En el
> 505 eran **199 de 420 clientes anulados** y **5.621 de 14.092 cajas tiradas (40%)**. Golpeaba a
> los artículos con muchos compradores esporádicos — la familia 5xx — dejando **29 de 316**
> artículos por debajo de 5 o más de sus 6 meses.
>
> **(2) El divisor inflaba.** `n` era *"meses desde la primera compra del cliente"*, así que un
> cliente que estrenaba el mes pasado (n=1) contaba su único pedido como ritmo mensual completo.
> Sin ningún filtro el catálogo daba 33.208 caj/mes contra 21.935 de promedio real: **+51%**.
> El filtro brutal venía cancelando esa inflación, mal y de forma despareja. **Arreglar solo (1)
> destapaba (2) y subía las compras 40%** — por eso se arreglaron los dos juntos.
>
> **Arreglo:** la regla de descarte se extrajo a **`fn_proy_descarte()`** (LK) — antes estaba
> COPIADA en 4 funciones SQL y 2 archivos JS, y ya habían divergido: el mismo 505 mostraba
> **1667,6** en Virgilio, **2069,7** en el panel Estadística Madre y **2500** en la tabla
> `estadistica_madre` (congelada desde mayo). Ahora se descarta **sólo el excedente**
> (`v − 1.5×promedio`), sólo si el cliente compró en **≥ 2 meses**, y el divisor es la **ventana
> completa**. `fn_proyeccion_madre` y `fn_proyeccion_madre_emp` delegan en el mismo motor
> (y se les sacó un hack hardcodeado que metía ventas de Chef sólo para el 505 — parche puesto
> para tapar este mismo bug). **Estadística Madre pasó de 24 a 6 meses** (pedido del usuario).
>
> **Verificado (385 artículos):** artículos rotos 29 → **6** (y 0 por debajo de los 6 meses);
> balance 2,99 → **3,01** (ideal 3,0); total del catálogo 20.153 → **19.792** caj/mes (−1,8%, no
> mueve el nivel de compras); **art. 505: 1667,6 → 2080,8**. Detalle y backup en
> `sql/fn_proyeccion_oc_virgilio.sql` y `sql/backups/backup_proyeccion_LK_20260902.sql`.
>
> ⚠ **Hallazgo aparte: `refresh_proyeccion_madre()` venía fallando en SILENCIO desde el 12/08.**
> Un barrido de seguridad en LK le revocó el `EXECUTE` a `anon` sobre `fn_proyeccion_oc_virgilio`,
> así que el GET devolvía **401** y la función retornaba **−1 sin recargar**, con el cron marcando
> "succeeded". Tres semanas con la proyección congelada sin que nadie se enterara. Se recargó a
> mano (abrir permiso → refresh → volver a cerrarlo, seguridad igual que antes). **La plomería
> definitiva está PENDIENTE de decisión:** re-abrir a `anon` (expone la proyección a cualquiera con
> la anon key, que es pública) o dar vuelta el sentido y que **LK empuje** a Virgilio por el FDW
> `virgilio_db` que ya existe (mismo patrón que `sync_pedidos_match_virgilio()`, no expone nada).

> Nota **2026-08-25 — v11.48 (Stocks: pop-up "de dónde surge la proyección" + ventas 6m).**
> En la hoja **Stocks** (Stock y Compras), el número de la columna **PROY. CAJ/MES** ahora es
> **clickeable** (`stkShowProyVentas`): abre un pop-up que explica **de dónde surge** la proyección y
> muestra las **cajas facturadas reales de los últimos 6 meses** (mini bar-chart por mes, total y
> promedio simple). **Clave conceptual:** la proyección **NO** es el promedio simple de esas barras —
> se calcula **por cliente** (promedio mensual desde su 1ª compra en la ventana) **descartando
> meses-pico atípicos**, sumando Loeke + Chef, ventana 6m→12m (motor `_fn_proy_window` en LK). Por eso
> p.ej. 315: ventas ~350/mes simples vs proyección depurada 285. **Fuente de las ventas:** `sales_lines`
> de **PáginaLK** (las mismas que alimentan `proyeccion_madre`). **Cruce backend** (protocolo backend):
> RPC Virgilio **`ventas_mensuales_cod(p_cod,p_meses)`** (SECURITY DEFINER, anon EXECUTE) → **http GET**
> a LK **`fn_ventas_mensuales_virgilio(p_cod,p_meses)`** (anon, misma anon key de LK que usa
> `refresh_proyeccion_madre`); el RPC de Virgilio **sanitiza** `p_cod` a `[A-Z0-9]` antes de armar la URL.
> El LK RPC espeja la normalización de la proyección (código sin ceros, `sales_item_remap`,
> `sales_excluded_items`, clientes 1/3878 fuera, empresas lk/chef) y rellena los 6 meses con ceros.
>
> Nota **2026-08-25 — jornada v11.46→v11.47 (Carga Camión: retira/camión + camionero · líos).**
> **(1) Carga Camión (CC) — pregunta primero RETIRA o CAMIÓN.** Al tocar CC ahora aparece un
> selector (`ccRenderChooser`): **🚛 Camión** = todos los pedidos **salvo los retira**, con
> **nombre del camionero** (input con `<datalist>` autocompletado desde el maestro **`Camioneros`**
> — así "Guille"/"Guillermo" siempre se escribe igual para el análisis); **🚶 Retira** = **solo**
> los retira, contados en **cajas** (no piden camionero). **Retira** = `zona="Retira"` (Programación
> Diaria) **o** `clase` del último `TAL` = `'nada'` (`fetchCCData` setea `it.esRetira`). **(2) CCN
> lleva camionero:** el `texto` del evento **`CCN`** pasó de `NP|TANDA` a **`NP|TANDA|CAMIONERO`**
> (3er campo vacío en retira). Las vistas leen `split_part [1]=np, [2]=tanda` → el 3er campo no las
> afecta. Maestro `Camioneros(nombre PK, creado_en)` con RLS anon `SELECT`+`INSERT`; upsert
> `ignore-duplicates` (`ccUpsertCamionero`) al terminar. **(3) Bug de conteo de líos al completar
> faltante (RAÍZ).** `cpUpdateLio` recalculaba el conteo desde el largo del resumen parseado (que
> venía incompleto/vacío) → al completar un faltante que **creaba un lío nuevo**, el total **no
> subía**. Ahora parte del conteo **guardado** en el último `TAL` (`info.count`, campo `[1]`):
> lío nuevo → `max(guardado+1, largo)`, suma a lío existente → `max(guardado, largo)`. Además
> preserva la **clase** (`[4]`) en el re-emit (`liosSend` 6º arg). Corrige el número en **Control
> de Remitos, Recepción de Remitos y Facturación** (los tres leen `TAL[1]`). **(4) Líos, no cajas.**
> En **Control** y **Recepción** de Remitos se habla **solo de líos**; el único caso con cajas es
> **retira** (que no arma líos): en **la misma columna** se muestran las cajas con sufijo **"c"**
> (ej. `12c`) vía `_liosCajasCell` (retira sin líos → `cajas+"c"`, icono 🧺; si no, líos 📦). **Misma
> regla en Facturación** (columna Líos). `vista_control_remitos` ahora expone **`clase`** (de
> `TAL[4]`) y **`cajas`** (Σ `Entregas_Virgilio.cajas_pedidas` por NP) — appended al final del SELECT.
>
> Nota **2026-08-24 — jornada v11.33→v11.38 (resumen).** **(1) Pasaje de Papeles:** header
> de la 1ª columna → "Fecha DDJJ"; se corrigió la fecha de remito/factura que se mostraba
> corrida un día (bug TZ: `new Date("YYYY-MM-DD")` = medianoche UTC → en AR retrocede; ahora
> las fechas peladas se formatean por partes). Badge del botón = cuenta `confirmado=false`
> (pendientes + sin confirmar) → tic verde solo cuando no queda nada por confirmar; antes solo
> contaba pendientes de enviar. **Nueva columna `enviado_en`** (timestamptz) → día/hora de
> envío en la sección "Documentación enviada". **Fix confirmar recepción:** usaba `recibido_en`
> (columna inexistente) → no persistía; ahora usa `confirmado` + `fecha_confirmacion`.
> **(2) Completar datos producto:** convención para códigos que terminan en **E** → `N_Caja=99`
> y `Uni_x_Caja` desde `precios_venta.uxb` (backfill masivo en `Articulos_Cajas`). **(3) Ver
> stock:** el selector de fecha/hora se muestra **solo** al tocar "A esa fecha" (1er toque
> revela, 2º aplica); botones "En vivo/A esa fecha" nivelados al molde de los chips. **(4)
> `vista_correcciones_pedido_rich` — 2 fixes:** (a) solo la corrección de la **operadora**
> (`origen<>'auto'`) apaga el aviso — antes cualquier corrección lo dejaba en 0 (badge vs popup
> desincronizados); (b) **falso "Pickeado"**: NP sin tanda quedaban con tanda `''` y matcheaban
> eventos EP/TP/AP/TAP con `texto` vacío → la vista ahora ignora tanda vacía (ni cuenta esos
> eventos ni matchea con `''`). Se **borraron 18 eventos EP/TP/AP/TAP huérfanos** (tanda vacía,
> ene–ago) de `Registros_Produccion_Virgilio` (backup en `~/pp_backups/`). **(5) Duplicación de
> info detectada** (marca/línea, uxb, descripción en varias tablas/fuentes). **Marca/línea
> unificada** → vista `vista_marca_articulo` (OC_Maximos.linea → Articulos_Cajas.Marca) + función
> `artMarca(cod)` en el front (el sufijo " LK"/" CH" manda); el stock ya la usa. **UxB: NO se
> unifica globalmente — es DEPENDIENTE DEL CONTEXTO:** venta = `precios_venta.uxb` (lo que usan
> los cálculos de plata/facturación, CORRECTO), depósito/empaque = `Articulos_Cajas.Uni_x_Caja`,
> compras = `OC_Maximos.uni_x_caja`. Pueden diferir legítimamente (ej. 724: 24 depósito / 4 venta).
> Existe `vista_uxb_articulo` + `artUxb()` como canónica de la uxb de **depósito** (no tocar los
> cálculos de plata con ella). **Descripción:** canónica `artNombre`/`vista_nombres_articulos`;
> Recepción de talleristas usa a propósito el `Desc` del tallerista (más útil al operario, no
> tocar). **Anon key:** desde v11.101 vive en UN archivo: `supabase-config.js` (lo cargan
index.html, sw.js vía importScripts, recepcion.js, fichada.html/fichada-config.js,
fichadas-monitor.html y productividad.html) — rotar la key = editar solo ese archivo
(+ bump de versiones). La key de LK es aparte (index.html `SUPABASE_LK_KEY` + admin/).
> **Regla nueva: NUNCA EMPARCHAR** (arriba).
>
> Nota **2026-08-22 — jornada v11.14→v11.23 (resumen).** **(1) Facturación:** columna
> "A facturar / Falta" — cada artículo con faltante muestra `cod FC N −M` (N = pedidas−faltó,
> verde; solo si N>0) en vez de solo el faltante (v11.14-16). **(2)** Botones "Proveedor de
> importación" y "Pedidos Importación" unificados en uno con solapas; de paso se arregló
> `_impTabsHtml` sin definir desde v10.42 que rompía el popup de Pedidos (v11.17).
> **(3) BUG SISTÉMICO — PostgREST corta TODA respuesta REST en 1000 filas** aunque se pida
> `limit=50000`. Mordió a las OCs (recepción de talleristas invisible → "Falta = Pedido" en
> todo; v11.20 fix + banner de error v11.18) y se corrigieron preventivamente: Carga Camión
> (PPP_Entregados_Meta, 2300+ filas — entregadas reaparecían como pendientes), % Entregas,
> Consulta NP (corpus TAL), export Excel PPP, Pasaje de Papeles (pendientes viejos fuera del
> corte) y catálogo talleristas (v11.23). **Regla: todo fetch sin filtro acotado va con
> `supaFetchAll`.** **(4) NP salteadas:** chips clickeables "no interesa" → tabla
> `NP_Secuencia_Revisadas`, la vista las excluye (v11.21). **(5) Pasaje de Papeles v4.2:**
> columnas "Demora carga" (fecha doc → cargado; verde<24h/ámbar/rojo>2d) y "Carpeta" (1: Rto+Fc
> prov · 2: solo Rto/Fc · 3: talleristas). **(6) AUTO-CORRECCIÓN SECUNDARIO→PRINCIPAL:**
> trigger `trg_corregir_secundario_auto` en PPP_Base_Pedidos inserta en Correcciones_Pedido
> con `origen='auto'` apenas entra un pedido en código secundario → el picking levanta el
> PRINCIPAL sin esperar a la operadora. El aviso "Cambiar cód" en Facturación sigue vivo hasta
> que ella confirme el ERP (solo `origen='operadora'` lo apaga; upsert merge en `_correccPost`).
> **(7) Seguridad (auditoría):** RLS en 8 tablas planify (admin expuesto a la anon key) +
> 5 tablas public sin RLS; `security_invoker` en vista_saldos_stock y
> vista_np_faltantes_secuencia; secret del sync LK movido al Vault
> (`virgilio_entrega_sync_secret`; rotación pendiente, requiere tocar la Edge Fn LK).
> **(8) Datos:** 589E uxb 12→24 (Importados + OC_Maximos). **(9) Planimetría:** solape de
> orden isla-I vs L/M corregido (+26 a L/M/Ñ) y sector J9→J09.
> Nota **v11.13 — Facturación: Cód Cliente grande + columna "Facturar N" (parciales).**
> Reordené el módulo **Facturación** (`openFacturacion`, monitor de ventas). Nuevo orden de
> columnas: **Cód Cliente** primero y con letra mucho más grande (`.fac-cod-big`, 22px) →
> **NP** → **Faltantes** → **Facturar** → resto a la derecha (Tanda, Salida, Razón Social,
> Cambiar cód, Líos, Cajas, ✓). La columna nueva **Facturar** (`facFacturar(np)`) muestra,
> por artículo que salió **parcial** (pidió X, agarró Y), un badge verde `cod: facturar Y`
> (= `cajas_pedidas − cajas_falto`); **solo aparece si hubo parcial** (si faltó todo, nada).
> **Por qué**: el badge de Faltantes solo mostraba lo que FALTÓ, y la operadora salteaba el
> renglón entero sin facturar lo entregado (bug real NPs 98406/395, 44581/729E y 836 — cajas
> pickeadas que no se facturaron). Es solo front: la data (pedidas + faltó) ya venía en
> `facFetchFaltantes`; cero cambios de backend. Idea de usuario **6542**.
> Además: el checklist **NC a Loeke→Chef** (`facRenderNc`, `vista_nc_loeke_chef` →
> `NC_Loeke_Chef_Hechas`) pasó a ser **secundario y compacto** (fuente 11px, header chico,
> `min-width` liberado, `#facNcList`) para que Facturación sea la parte protagonista. La
> **lógica del NC no cambió** (se verificó que funciona).

> Nota **v11.13 — Planimetría: auto-orden del sector (picking prolijo).** Al cargar un código
> en un sector **nuevo** sin N° de orden quedaba `orden=0` → se iba al **principio del picking**
> (caso 599E / sector J44 / tanda D43B). Ahora el **N° de orden se completa solo** en dos capas:
> **(a) Backend** — trigger `trg_planimetria_autoorden` (`BEFORE INSERT/UPDATE ON "Planimetria"`,
> función `planimetria_autoorden()`, `sql/planimetria_autoorden.sql`): si `orden` viene en 0/NULL
> lo completa heredando de vecinos — mismo sector exacto → su orden; si no, interpola entre los
> vecinos del **mismo pasillo** (misma letra inicial) por nombre de sector; si no hay, vecinos
> globales; si no, `max+1`. Respeta el orden si vino explícito (>0). Cubre TODOS los caminos de
> alta. Se recalcularon las filas existentes en 0 (599E/J44 → 128, al lado de J13=127).
> **(b) Front** — el editor de planimetría (`openPlanimEditor`) **sugiere el orden editable**
> mientras se tipea el sector (`planimSuggestOrden` replica la lógica del trigger; `planimFillOrden`
> autocompleta el input en verde `.planim-ord-sug`, sin pisar un número puesto a mano). Backup:
> `sql/backup_planimetria_20260820.sql`. `Planimetria (cod, sector, orden)` → `window.GONDOLA`.
>
> Nota **2026-08-17 — Cobranzas: valorizar una NP sin ver la factura.** Objetivo del
> usuario: que Virgilio sepa cuánta plata se le facturó a cada NP/cliente sin tener la
> factura a la vista. Hay **dos niveles de precio**, a propósito:
> **(1) Valor de LISTA** — en la base, al toque y en lote (`sql/cobranzas.sql`):
> `cobranzas_valorizar_np(np)` y `cobranzas_resumen()` cruzan `PPP_Base_Pedidos`
> (artículo × cajas) con **`precios_venta`** (snapshot de la lista general de LK,
> `products` ∪ `loke_products`), con match por código canónico (`cob_norm_cod`:
> upper+trim+saca ceros a izq, así `948e`/`029` matchean). **NO aplica dto por cliente**
> porque `precios_venta` es anon-readable y copiar el padrón de descuentos de LK acá lo
> filtraría. **(2) NETO exacto por NP** — la Edge Function `arca-wsfe` acción `preciar`
> lee LK **en vivo** (service_role) y aplica `list_price×(1−dto_vol)×(1−2%)+IVA 21%`;
> ahora también con fallback a `loke_products`. **Empresa por numeración**: 9xxxx = LK,
> 4xxxx = Chef → las NP de Chef salen `lista_no_disponible` (la lista de Chef vive en
> otro Supabase, no está en Virgilio; mismo código = otro artículo en cada empresa).
> **Cobertura medida (NPs en curso)**: LK 145 NP, valor lista ≈ $196,9 M, cobertura
> 96,4% de líneas. El faltante se **clasifica** (`cob_estado_articulo`) porque casi
> nunca es un hueco a cargar: `especial` (código de 5 díg = artículo de un solo cliente,
> "no van"), `loke` (código que empieza con 1 = lista Loke, no se ofrece a cualquiera),
> `discontinuado` (`Articulos_Discontinuados` ∪ `OC_Maximos.activo=false`) y `sin_precio`
> (lo único realmente a cargar en LK). De las 17 líneas LK sin precio, solo **8 son
> `sin_precio` real** (códigos 580 y 67); el resto son especiales/loke/discontinuados.
> `cobranzas_resumen` expone `sin_precio_real` para no alarmar por lo esperado.
> **Alias de código** (`cobranzas_alias`): cuando el código activo en pedidos difiere del
> que tiene precio por grafía (mismo artículo). NO se toca la "E" automáticamente porque
> hay pares distintos (`323`≠`323E`). Confirmados: `580`→`580E` (activo 580). Con eso el
> faltante real LK baja a **1 línea** (código 67). **Chef**: precios en tabla aparte
> `precios_venta_chef` (código Chef ≠ LK); se cargan con `sql/cobranzas_chef_sync.sql`
> (correr en el proyecto Chef, pegar el INSERT en Virgilio — 101 códigos, sin loke). Los
> precios efectivos salen de la vista `cobranzas_precios` (LK+Chef+alias). **Chef con
> fallback a lista LK**: en Chef se venden productos Loeke a clientes puntuales (supers =
> lista especial; FC E = lista LK normal), y esas líneas llevan código de fábrica LK que no
> está en el catálogo Chef, así que se valorizan con la lista de LK (`origen='lk'` en el
> detalle). ⚠ La lista **especial de supers** (`precios_super` de LK) no está en Virgilio →
> para clientes de súper el valor con lista LK normal **sobreestima**. Cobertura NP en curso:
> **LK ~100%, Chef 98,8%**. `precios_venta` se re-sincroniza a mano desde LK; backup en
> `precios_venta_backup_20260817`. **Front-end (v11.04)**: botón **💵 Cobranzas — valor por
> NP** en el panel supervisor (overlay `#cobOverlay`, molde de Plata perdida) que llama a
> `cobranzas_resumen` (tabla de NP con valor y cobertura, filtro por empresa + búsqueda) y a
> `cobranzas_valorizar_np` al tocar una NP (detalle por artículo, origen LK/Chef, estimado
> c/ IVA). Es solo VISTA: `valor_lista` sin dto; el neto exacto sigue en arca-wsfe/preciar.
>
> Nota **v11.05 — Cobranzas: listas de SÚPER (lista especial por cadena).** Tercera lista,
> con prioridad sobre la normal: si el cliente de la NP es una cadena de supermercado con
> lista cargada, cada línea se valoriza con `precios_super_lk` (precio final negociado, sin
> dto; Diarco lleva `item_discount` 10%). El mapeo cliente→cadena sale de
> `cobranzas_cliente_cadena` (sembrado de `precios_super.cadena.cod_cliente_lk/chef` del
> proyecto LK: Coto=801, INC=1651, Diarco=4112, Libertad=325, etc.). El `uxb` de artículos
> que solo están en la lista de súper sale de `cob_uxb_lk` (padrón LK completo). Orden de
> precio por NP: **súper → empresa (LK/Chef) → LK fallback**. `messina` va con lista general
> (`usa_lista_general`), no especial. Hoy hay NP de Diarco e INC en curso valorizadas así.
> El front muestra un badge 🛒 en la NP y la cadena en el detalle. **arca-wsfe NO se
> redeployó**: la función deployada (v23) está adelante del repo (tiene `emitir_nc`/`emitir_nd`
> sin commitear); redeployar el repo la regresaría. El pricing de cobranzas vive en las RPC.
>
> Nota **v10.28 — La columna `Op` del Excel DEJÓ DE SER REQUISITO para mostrar tandas.**
> Hasta acá, una tanda sin `Op=SI` **no aparecía** ni en el monitor de TV ni en las pantallas
> del operario (EP/TP/CC) ni en Facturación. Como nadie mantenía esa columna, quedaban **36
> tandas reales invisibles** para el depósito. **Decisión del usuario: el SI ya no es norma.**
> Se sacaron los **13 filtros** por `opIsSi` (celular, monitor y Facturación) y también el
> marcador **`missingSi`** —la fila roja con "(F Pk)"— que señalaba "le falta el SI": si el SI
> no es norma, ese aviso es ruido (habrían salido 35 filas rojas). Se borró su CSS, que quedó muerto.
> **Lo que acota la lista son los topes que YA existían** (el usuario pidió respetarlos):
> `MAX_PLANNED_NO_ACT` = 6 tandas sin actividad en la tabla del monitor, `TANDAS_LIST_VISIBLE_DAYS`
> = 3 grupos de días en el celular, y la ventana de próximos 3 días hábiles.
> **Medido antes de aplicar:** las 35 tandas que entran son todas de entrega **19/08 → 16/09**,
> o sea **ninguna** cae hoy en la ventana de 3 días — no hay avalancha; van a aparecer solas
> cuando se acerque su fecha. El flag `opIsSi` se sigue **parseando** (por si se quiere volver
> atrás) pero no filtra nada. Smoke **`tests/sin-op-si.cjs`**, que falla si alguien repone un filtro.
>
> Nota **v10.28 — Los códigos de tanda mal tipeados se corrigen solos.** Alguien cargó **`D27A:`**
> (con dos puntos) y para el sistema era un código DISTINTO de `D27A`: no matcheaba con el picking,
> ni con los m³, ni con el stock. **Fix en la base** (elección del usuario: limpiar en el origen, no
> en cada pantalla): función `fn_norm_tanda()` + triggers **BEFORE INSERT/UPDATE** en
> `PPP_Programacion_Diaria` y `PPP_Entregados_Meta`. **Regla:** trim + sacar símbolos **pegados al
> principio o al final**; los del **medio NO se tocan a propósito**, porque hay tandas legítimas
> como **`S/Tanda`**, **`T 06/04`** y **`LA ANONIMA`** que se romperían. Probado contra todos los
> códigos existentes: el **único** que cambia es `D27A:` → `D27A`. Las filas ya cargadas se
> corrigieron en la misma migración. Verificado con una fila de prueba: `"  Z99Z:. "` entra como `Z99Z`.
> Mismo patrón que `fn_canon_cod_art` (el trigger que ya normaliza `cod_art`).
>
> Nota **v10.30 — Importación: los dos botones se unificaron + Góndola<25%: sin discontinuos y ordenada.**
> **(1)** Los botones **"🏭 Proveedor de importación"** y **"📦 Pedidos Importación"** del panel supervisor
> se unificaron en **un solo botón "📦 Importación"** que abre una pantalla con **dos solapas**
> (`_impTabsHtml`): **📦 Pedidos** (`openPedidosImportacion`/`_pedImpRender`) y **🏭 Proveedores**
> (`stkOpenProvImp`/`_provImpRender`). Mismo título de shell "📦 Importación" en las dos; el resto de
> la lógica no cambió. **(2) Hoja "Góndola < 25%"** (`agLoad`/`stkBodyAuditGon`): ahora **excluye los
> discontinuos** (`vista_generador_oc.activo = false`) y ordena, dentro de cada tallerista, por
> **% de góndola de menor a mayor** (el peor primero) en vez de por familia. Todo front. Bump
> `APP_VERSION` + `SW_VERSION` `v10.30`.
>
> Nota **v10.46 — Stock: se reactivó el descuento incremental por PKC (FORWARD) + fix del bug FANTASMA.**
> **Contexto:** v8.00 introdujo el descuento incremental (por cada artículo confirmado, PKC) via
> la rama FORWARD de `reconciliar_pipeline_stock_etapa1()`. v10.29 lo desactivó (`etapa1_pkc_desde =
> infinity`) porque un operario que volvía atrás y dejaba un artículo en 0 producía un fantasma
> (el movimiento de +N no se revertía, porque la CTE `fwd` filtraba `picked>0` y se salteaba el 0).
> **Fix (1 carácter):** en la rama FORWARD, CTE `fwd`, se cambió `p.picked>0` → `p.picked>=0`.
> Ahora cuando picked=0, el UPSERT pone `delta=0` en los 3 depósitos (separar_pedidos, excedente,
> terminado), revirtiendo la baja fantasma. El trigger `actualizar_saldo_trigger` recalcula
> `stocks_carga_rapida` y el monitor ve la reversión en realtime.
> **Rama HISTORIC no se tocó** (sigue con `picked>0`, correcto: está gated en TP y usa DO NOTHING).
> **Edge cases verificados:** (1) pickea 10 → cambia a 5 → UPSERT actualiza delta de 10 a 5 ✓;
> (2) pickea 10 → vuelve atrás → pone 0 → delta=0 (reversa total) ✓;
> (3) Anular picking → `anular_picking_virgilio()` pone delta=0 directamente (mecanismo independiente) ✓;
> (4) Sin Stock (real=0) → picked=0, no genera movimiento nuevo si no existía ✓.
> **Impacto en otras etapas:** ninguno — Etapa 2 protegida por gate TAP/Entregas, Etapa 3 lee de
> a_facturar, Etapa 4 independiente.
> **Config reactivada:** `Stock_Config.etapa1_pkc_desde` = `2026-08-13 09:41:32` (FORWARD activo).
> **Front-end:** `_cntLoadPickingEnCurso` pasó de compensación (⚠ amarillo "el sistema todavía no
> las descontó") a informativo (ℹ azul "El stock ya refleja lo pickeado") — con FORWARD el stock
> ya baja al PKC, el conteo no necesita compensar.
> Documentación del fix: `sql/fix_phantom_forward_etapa1_20260813.sql`.
> Bump `APP_VERSION` + `SW_VERSION` `v10.46`.
>
> Nota **v10.45 — Pasaje de Papeles: simplificación a lista única.**
> El módulo Pasaje de Papeles (`pasaje-papeles.js`) se simplificó: se eliminaron las solapas
> Virgilio/Cervantes (`ppSwitchTab`, `ppRenderVirgilio`, `ppRenderCervantes`, `ppMarkSent`,
> `ppMarkReceived`), dejando una **lista unificada** que muestra todos los documentos de la tabla
> `Pasaje_Papeles` ordenados por fecha (desc, limit 500). La tabla tiene columnas: Fecha, Tipo,
> N° Remito, N° Factura, Proveedor, Contenido. Se eliminaron los documentos de prueba de la tabla.
> El HTML del modal (`pasajePapelesModal`) se simplificó a un solo contenedor `ppDocList` sin tabs.
> Funciones de captura (popup para insumos, guardado directo para mercadería) intactas.
> Bump `APP_VERSION` `v10.45` (intermedio, luego v10.46).
>
> Nota **v10.29 — Stock: el descuento del picking vuelve a hacerse SOLO al terminar (TP) + aviso de picking en curso al contar.**
> **Motivo:** con el descuento incremental (por cada PKC, v8.00/branch FORWARD) un operario que
> pickeaba de más y volvía para atrás dejaba un FANTASMA: el PKC final quedaba en 0 pero el
> movimiento de stock (+N) no se revertía (el pipeline solo actualizaba con `picked>0`, saltaba el 0).
> **Fix backend (config, reversible):** `Stock_Config.etapa1_pkc_desde` volvió a **`infinity`** → se
> desactiva el branch FORWARD de `reconciliar_pipeline_stock_etapa1()` y el descuento vuelve a
> dispararse **una sola vez al TP** (branch histórico, gated en TP, con los números finales del
> picking). Un pickeo deshecho a 0 ya no descuenta nada. Valor anterior (para revertir): `2026-08-08
> 23:39:18.348275-03`. **Fix front (compensación, `stkBodyConteo`/`cntCompara`/`_cntLoadPickingEnCurso`):**
> como ahora el stock no baja hasta el TP, un **picking EN CURSO** (tandas con `PKC` pero sin `TP`)
> saca cajas de la góndola sin descontarlas todavía → al **Comparar** en el Conteo se muestra una
> columna **"🔄 En picking"** y un **aviso** con los códigos/tandas/cantidades en curso, para que el
> conteo físico no dé "diferencia" por eso. Se leyó de `Registros_Produccion_Virgilio` (PKC menos TP,
> ventana 4 días). **Limpieza puntual de datos (366E):** se dejó 366E en 0 en todos los depósitos
> (ajustes `FIX_AFACT_NEG_D20A_98237` y `FIX_STOCK_ZERO_366E_D20E`) porque físicamente había 0.
> Bump `APP_VERSION` + `SW_VERSION` `v10.29`.
>
> Nota **v10.38 — Importación → Pedidos: rediseño (ventanas por proveedor, pedido en master cajas editable, PDF para el chino).**
> Rediseño de `_pedImpRender` (dentro de "📦 Importación" → solapa Pedidos). Cambios: **(1)** filtro con
> dos botones **Solo Pedido / Ver Todo** (reemplaza el toggle "Solo lo que hay que pedir"). **(2)** Cada
> **proveedor** es una **tarjeta/ventana** propia (borde + header con subtotales) en vez de una lista
> corrida. **(3)** El pedido va en **master cajas REDONDAS**: columna **uni/master** (unidades por master
> caja, de `Importados_Volumen.uni_master`) + columna **MC pedido EDITABLE** (`<input>`, `pedImpSetMC` →
> `_stkPop.mcOverride[cod]`; poné **0** para no pedir, vacío = vuelve al calculado) + **Unidades = MC ×
> uni/master**. u$s y m³ se recalculan del MC editado. **(4)** Botón **🖨 PDF pedido** por proveedor
> (`pedImpPdfProv` vía `remitoPrintDoc`): imprime solo **Código · Master Cajas · Unidades**, **sin FOB**,
> para mandarle al proveedor chino a cotizar. **(5)** En `ocgFetchImportados`, alias `IMP_ALIAS` que suma
> **865ED dentro de 865E** (se piden juntos). Helpers nuevos: `_pedImpMcOf/_pedImpUniOf/_pedImpUsdOf/
> _pedImpM3Of`, `pedImpSetFiltro`. Todo front. Bump `APP_VERSION` + `SW_VERSION` `v10.38`.
>
> Nota **v10.25 — Un solo espejo del Sheet "Pedidos Entregados" (se eliminó el duplicado).**
> Esa hoja se estaba espejando **DOS VECES**: (a) el Apps Script la empujaba a
> `PPP_Pedidos_Entregados` (solo `tanda`+`mt3`), y (b) la función Postgres
> `sync_ppp_entregados_meta()` la baja sola cada 30 min a `PPP_Entregados_Meta` (np, cod, rs,
> tanda, m3, fecha_entrega). La (b) es **superconjunto** de la (a). Se dejó solo la (b).
> **Verificado ANTES de tocar**, sobre las **942 tandas realmente trabajadas** (EP/TP/AP/TAP):
> cobertura **883 → 883** (0 perdidas, 0 ganadas) y **880 de 883** con el m³ idéntico; las 3 que
> difieren son de feb–may y por **< 0,6 m³**. Las dos tablas ya coincidían en 983 de 987 tandas.
> **Cambios:** `vista_tanda_m3` lee `PPP_Entregados_Meta` (y de paso **excluye la tanda vacía**,
> que la versión anterior colaba como una fila más); `SUPABASE_PPP_ENTREGADOS_ENDPOINT` en
> index.html apunta a la tabla nueva y la columna pasa de `mt3` a **`m3`**; se sacó la línea
> `'PPP Excel Pedidos Entregados 2026'` del `PPP_SUPABASE_MAP` en `apps-script/sync-ppp-supabase.gs`.
> **La tabla `PPP_Pedidos_Entregados` se BORRÓ** (2026-08-12). Antes se repuntó su último
> consumidor oculto: **`vista_productividad_semanal`**, que la usaba en su CTE de m³ (no estaba
> en el repo, vive sólo en la DB — apareció al chequear `pg_depend`). Se reescribió desde su
> definición viva reemplazando sólo la fuente, y su salida quedó **idéntica** (29 filas,
> arm_m3 153.50, pick_m3 192.14, 223/224 tandas). Backup completo de las 2.465 filas, con DDL,
> policy y `setval`, en **`sql/backup_ppp_pedidos_entregados_20260812.sql`** (restore = ejecutarlo).
> ⚠ **PENDIENTE MANUAL:** **re-pegar el `.gs` en el proyecto de Apps Script**. Hasta que se haga
> va a intentar escribir una tabla que ya no existe; **no rompe nada** — el llamador lo tiene
> envuelto en `try/catch` y el sync del Sheet sigue igual — pero deja error en el log de Apps Script.
>
> Nota **v10.24 — Las librerías se sirven desde el repo (`vendor/`), no de CDNs de terceros.**
> Antes la app bajaba 7 librerías de 4 hosts ajenos en cada carga. **6 ya están adentro**
> (bajadas de **npm**, que es la fuente oficial de cada paquete; los CDN estaban bloqueados por
> el proxy del entorno):
> `jspdf.umd.min.js` (2.5.1) · `jspdf.plugin.autotable.min.js` (3.8.2) · `chart.umd.min.js`
> (4.4.1) · `leaflet.min.js`+`.css` (1.9.4) + **`vendor/images/`** · `supabase.umd.js` (2.112.3).
> **Las imágenes de Leaflet hacen falta**: el mapa pone un `L.marker` para el depósito y Leaflet
> busca los íconos relativo a dónde cargó su script (`vendor/images/`); sin eso el marcador sale roto.
> **supabase-js cambió de forma**: era `import ... from "https://esm.sh/@supabase/supabase-js@2"`
> dentro de `recepcion.js` — **si esm.sh fallaba, Recepción no abría**. Ahora `index.html` carga el
> build **UMD** con un `<script>` clásico **antes** del módulo (los módulos son diferidos, así que
> `window.supabase` ya existe) y `recepcion.js` hace
> `const { createClient } = window.supabase` con un throw claro si falta. Se usa el UMD porque es el
> único autocontenido: `dist/index.mjs` trae imports "bare" (`@supabase/auth-js`…) y necesitaría bundler.
> Efecto colateral bueno: la versión queda **fijada** (antes `@2` resolvía a la última v2, o sea la app
> cambiaba de versión sola).
> ⚠ **`xlsx` (SheetJS 0.20.3) sigue viniendo del CDN, a propósito.** SheetJS dejó de publicar en npm
> en la **0.18.5** y sólo distribuye por `cdn.sheetjs.com`. Bajar a la 0.18.5 **no es opción**:
> arrastra vulnerabilidades corregidas en 0.19.3 (prototype pollution) y 0.20.2 (ReDoS). Impacto
> acotado: se carga **a demanda** (importar PPP / exportar Excel de Stock), no en cada arranque.
> Smoke **`tests/vendor-sin-cdn.cjs`**: sirve la app por HTTP en localhost (los módulos ES no corren
> bajo `file://` por CORS) con **toda** salida a internet abortada, y verifica que jsPDF, autotable,
> Chart, Leaflet, supabase-js y `recepcion.js` funcionen igual.
>
> Nota **v10.23 — La TV del depósito ya no dice "Sin conexión" cada minuto.**
> Síntoma: en el stick tipo Chromecast saltaba el cartel amarillo ⚠ cada ~1 min, con el
> **WiFi vivo**. Causa: `refreshMonitor` mostraba el cartel ante **UN SOLO** fetch fallado, y
> `supaFetchAll` **no tiene ni timeout ni reintento** — así que cualquier hipo normal de un
> stick barato (ahorro de energía del WiFi, DNS lento, TLS) lo disparaba. No era la red.
> **Fix en 3 capas:** (1) **`_monReintentar`** — cada ciclo reintenta `MON_REINTENTOS`(3) veces
> con backoff 1,2s/2,4s, así el hipo se recupera dentro del mismo ciclo y nadie ve nada;
> (2) **tolerancia** — el cartel grande recién tras `MON_FALLOS_P_CARTEL`(4) ciclos SEGUIDOS
> fallando (**~2 min** con el refresh de 30s), y el texto pasó a *"Sin actualizar desde las
> HH:MM (N min) — reintentando"*, que es lo cierto; el indicador chico "● desactualizado" sigue
> mostrando cada fallo y **los datos viejos nunca se borran de la pantalla**;
> (3) **watchdog** — si pasan `MON_RELOAD_MS`(10 min) sin un solo refresh bueno no es la red,
> es un cuelgue → `location.reload()`. **Solo en modo kiosko** (`window.__tvKioskMode`): nunca
> se le recarga la página a un supervisor que la está usando, y exige un refresh OK previo para
> que un arranque sin red no entre en loop de recargas.
> El refresco sigue siendo cada **30 s** (`MONITOR_REFRESH_MS`). Smoke `tests/monitor-red-tolerante.cjs`.
> ⚠ Las constantes son `const` de nivel script: existen como globales léxicas pero **NO** cuelgan
> de `window` (los tests deben usarlas por nombre pelado, no `window.MON_...`).
>
> Nota **2026-08-12 — Aviso por Telegram de "faltantes facturados sin completar".**
> Función `notificar_faltantes_sin_completar_telegram()` + cron **`faltantes-sin-completar`**
> (`45 12 * * 1-5` = **09:45 AR de lunes a viernes**). Es un **digest**: junta los casos nuevos
> desde el último aviso y manda UN mensaje (top 12 + total); si no hay nada nuevo **no dice nada**.
> Un caso se avisa **una sola vez** — se registra en la tabla **`Faltantes_Avisados`** (PK
> tanda+cod, RLS on y **sin policies**: solo la escribe la función). Se marca DESPUÉS de encolar,
> así un fallo del enqueue no lo pierde.
> ⚠ **El backlog se sembró como "ya avisado"**: al crearlo había **372 casos históricos** y se
> insertaron todos en `Faltantes_Avisados` en la misma migración, para que el primer disparo no
> mande una avalancha. Esos 372 se trabajan desde el módulo 📉. Para re-avisar uno, borrar su fila.
> **`dedup_key = 'faltsincompletar_<YYYYMMDD>'`** — NO usar `'faltfact_'`: ya es de
> `notificar_falta_facturacion_telegram` (`faltfact_hoy_…`/`faltfact_manana_…`) y confunde.
> Verificado: corrida en seco → 0 nuevos, 0 encolados, **ningún mensaje mandado al grupo**.
> Diseño en `sql/faltantes_resolver.sql`.
>
> Nota **v10.18 — "Faltantes facturados sin completar": ahora se RESUELVE desde el módulo.**
> El listado (v10.16) solo mostraba; cerrar un caso había que hacerlo a mano por SQL. Ahora cada
> fila tiene dos botones: **📉 "Salió"** (las cajas salieron y se facturaron → ajuste de stock) y
> **✓ "Está bien"** (al cliente se le facturó de menos → el stock ya está bien, solo se archiva).
> Los dos piden **motivo** (lista corta + "Otro" con texto libre), que queda guardado para saber
> después por qué se cerró cada caso — mismo patrón que el 🚫 "No va" de NP que faltan.
> **Backend:** tabla **`Faltantes_Revisados`** (PK tanda+cod; RLS con SELECT para anon y **sin
> policy de INSERT a propósito**) + RPC **`faltante_resolver(tanda, cod, accion, legajo, motivo)`**
> (SECURITY DEFINER). La vista suma la exclusión **(c) ya revisado**, así el caso desaparece solo.
> ⚠ **El front NO manda la cantidad**: la calcula el server leyendo la vista. Es a propósito —
> esto escribe stock, la policy `mst_insert` tiene `with_check = true` (la anon key puede insertar
> cualquier movimiento) y el repo ya se quemó con el fast-path del cliente en v5.76 (~486 cajas
> duplicadas en 4 tandas). **Idempotencia en 3 capas:** la RPC lee la vista primero y devuelve
> `ya_resuelto` si el caso no está + PK de `Faltantes_Revisados` + handler de `unique_violation`
> sobre `client_id` (`faltres_<tanda>_<cod>`). Probado contra un caso real (C58A/035E): dos
> llamadas seguidas → `ok` y `ya_resuelto`, **un solo** movimiento de −1; después se revirtió.
> **No hay "deshacer" en la app** — para revertir, los DELETE están en `sql/faltantes_resolver.sql`.
> Smoke `tests/falt-fact.cjs` (verifica que el POST no lleve la cantidad). Diseño en
> `sql/faltantes_resolver.sql`.
>
> Nota **v10.17 — Facturación: el tilde de una NP EN PROGRESO va NARANJA.** Mismo criterio que
> ya pintaba la fila de amarillo (`tr.fac-en-progreso`, de `facTareaActiva(np)` = le están
> agregando cajas a ese faltante ahora). El ✓ verde se lee como "listo para facturar" y en esas
> filas no lo está. Solo CSS (la clase ya estaba en el `<tr>`): `tr.fac-en-progreso .fac-btn-tick`
> → `#ea580c` (hover `#c2410c`), dentro de `#facFaltCss`. **Las filas rojas** (`fac-has-falta`,
> faltante ya cerrado) **quedan con el tilde verde** — no se pidió cambiarlas. El botón sigue
> habilitado: es un aviso visual, no un bloqueo.
>
> Nota **2026-08-31 — Alta: tallerista Oscar habilitado en Recepción (LK).** Oscar figuraba en
> `Codigos X Tallerista` con `Codigo` NULL en LK y CH → su botón aparecía deshabilitado ("Este
> tallerista no trabaja para...") y sus recepciones se cargaban por **Log/Fabr** (que sí tiene
> código 0001). Además sus artículos en `Articulos Virgilio X Tallerista` estaban mezclados: unos
> bajo el 0001 de Log/Fabr (por eso salían en esa grilla) y otros en NULL (invisibles). Se le
> cargó su **código real 3709** en LK y se normalizaron sus 9 artículos LK a ese código:
> **500, 506, 510, 555, 557, 558, 654, 658, 659** (el 658 se clonó del maestro de Log/Fabr; 3
> duplicados bajo 0001 se borraron). SQL con backup y revert en `sql/alta_oscar_lk_20260831.sql`.
> **Línea CH de Oscar sigue sin código** (botón CH deshabilitado); sus filas LK viejas fuera de la
> lista (280, 759, 762, 764, 769) quedaron como estaban — algunas bajo 0001, siguen en la grilla
> de Log/Fabr. El remito 37584 del 31/08 (557×60 + 558×5) ya cargado quedó bajo Log/Fabr (no se
> re-asignó). No hizo falta tocar `recepcion.js`: Oscar ya venía en la lista del backend
> (`vista_entidades_recepcion`); el botón se habilita solo al tener código.
>
> Nota **2026-08-12 — Alta: Garcia hace los coladores también en CHEF.** Recepción de remitos:
> se habilitaron **437E / 438E / 439E** al tallerista **Garcia** en línea **CH** (código 3915),
> espejando las filas que ya tenía en LK (4317) — misma Desc, Uni_x_Caja y Cajas_x_Master.
> Antes en CH solo tenía 700 y 839; ahora 5 códigos. No hizo falta tocar `Codigos X Tallerista`
> (ya tenía código CH y ya está en `ORDEN_TALL` de recepcion.js, así que aparecía en la lista con
> el botón Chef habilitado). SQL + revert en `sql/alta_garcia_ch_coladores_20260812.sql`.
> **"Bryan Garcia" = el mismo Garcia** (confirmado por el usuario): el maestro guarda solo
> apellidos, por eso "Bryan" no figura. No hay tallerista nuevo que dar de alta.
>
> Nota **v10.16 — Módulo "Faltantes facturados sin completar"** (botón 📉 en el panel supervisor).
> Cierra el agujero que destapó el caso de las NPs 98140/98142/98155: el pickeador registra un
> **PKC con `real < esp`** (no encontró todo), la tanda se **factura entera** igual, y **nadie corre
> "Completar Pedido" (CP)**. Si esas cajas igual salieron, el stock queda **inflado**: sin bajada de
> góndola el artículo nunca entra a `separar_pedidos` ni a `a_facturar`, así que la ETAPA 3 del
> pipeline no tiene nada que drenar. **No lo detectaba nadie** — el caso testigo (art 234, 8 cajas)
> se descubrió 3 semanas tarde y a mano.
> **Backend:** vista **`vista_faltantes_sin_completar`** (migración homónima; `grant select` a anon)
> = PKC con `real<esp` post-cutoff (excluye legajos 0/1) ∩ tandas con **todas** sus NP en
> `Facturacion_NP`, menos las que ya tienen un `cp` de ese artículo en alguna NP de la tanda, menos
> las que ya se ajustaron a mano (`tipo='ajuste'` con `ref` `'<tanda>|…'`). Devuelve tanda · cod ·
> cajas · NPs · clientes · fecha_entrega · ts_pkc. Un caso **se borra solo** de la lista al
> resolverlo (CP o ajuste), así el listado se vacía en vez de crecer.
> **Front:** `stkOpenFaltFact` — tabla caso-por-caso, toggle **"Agrupar por artículo"** y export a
> Excel. **Solo lista, no ajusta:** ⚠ **no todos los casos son fuga** — si al cliente se le facturó
> **de menos**, la factura refleja lo que salió y el stock está bien; hay que cotejar contra el ERP.
> Estado al crearlo: **372 casos · 135 tandas · 1.638 cajas**, concentrado en 870E (344), 224 (107),
> 546 (97), 323E (70), 580E (59). Smoke `tests/falt-fact.cjs`.
>
> Nota **v10.05 — front conectado a vistas/RPCs backend.** Las funciones
> `stkFcsFetch()`, `openAbastecimiento()`, `facCorreccDataRich()` (index.html) y
> `cargarOCVigentes()` (recepcion.js) ahora hacen **1 fetch** cada una contra las
> vistas/RPCs server-side (`vista_fc_sin_salida`, `vista_abastecimiento`,
> `vista_correcciones_pedido_rich`, `oc_vigentes_por_proveedor`) en vez de múltiples
> fetches + lógica client-side. El drill-down mensual de Abastecimiento carga lazy
> (por cod, al expandir). `abastCompute()` se mantiene para el módulo OC. Helpers:
> `norm_cod(text)`, `norm_nombre(text)`. Ver § 3 → "Vistas y funciones backend".
>
> Nota anterior · Versión app al documentar: **v10.03**
>
> Nota **2026-08-12 — Fuga de stock: "faltó en el picking pero se facturó igual" (sin CP).**
> Caso testigo NPs **98140/98142/98155** (tandas D05B/D06B). El pickeador registró
> `PKC D05B|234|5|0` y `PKC D06B|234|3|0` — es decir **real=0**, no encontró ninguna caja del
> art 234. El pipeline hizo lo correcto: sin bajada de góndola, el 234 nunca entró a
> `separar_pedidos` ni a `a_facturar`, y la ETAPA 3 no tuvo nada que drenar (por eso el 234 no
> tiene NINGÚN movimiento en esas tandas, mientras el resto sí: D05B `facturado` −160, D06B
> −112). Pero las cajas **salieron y se facturaron**, y nadie corrió **"Completar Pedido" (CP)**
> — el mecanismo previsto para esto. Quedaron **8 cajas fantasma** de más en el stock.
> Ajuste aplicado en `sql/ajuste_234_D05B_D06B_20260812.sql` (`tipo='ajuste'`,
> `legajo='reconcilia'`, depósito `terminado`, revert por `client_id`): terminado 10 → 2.
> **No es un caso aislado ni un bug del pipeline:** el mismo patrón (faltó en el picking +
> tanda facturada + sin CP) da **1.651 cajas en 136 tandas** desde el cutoff; otras **553 en 36
> tandas** sí se resolvieron con CP. **Ojo:** no todas son fuga — sólo lo son las que
> efectivamente salieron; si al cliente se le facturó de menos, el stock está bien. Hay que
> cotejar contra la factura. Concentración: 870E (344 cajas), 224 (107), 546 (97), 323E (70),
> 580E (59). **Falta un control** que avise cuando una NP se factura con un PKC `real<esp` sin
> CP asociado — hoy no lo detecta nadie.
>
> Nota **v10.03 — fix: tandas ZOMBIE en la lista de EP.** `getActivityStatus()` miraba solo
> los **últimos 7 días** de eventos EP/TP/AP/TAP. Una tanda pickeada hace más de una semana
> salía de esa ventana, `pickingStarted` dejaba de tenerla y el filtro `notStarted` de **EP la
> volvía a ofrecer para siempre**. Caso real (12/08): al operario le aparecían **C89A** (TP
> 23/07), **C99F** (TP 30/07) y **D16A** (TP 04/08) como pendientes. Peor: la lista agrupa por
> fecha **ascendente** y solo muestra `TANDAS_LIST_VISIBLE_DAYS`(3) grupos, así que esas
> zombies de julio **tapaban** las tandas reales. **Fix:** constante `ACTIVITY_LOOKBACK_DAYS`
> = **180** días (≈3.100 filas, muy por debajo del limit, que además subió a 20.000). Afecta a
> todos los consumidores de `getActivityStatus` (EP/TP/AP/TAP, monitor, facturación), siempre
> para mejor. **No relacionado:** que el Monitor muestre pocas tandas a armar **no es un bug** —
> depende de la columna **`Op`** del Sheet: solo 17 tandas tienen `Op=SI` y 15 ya están a FC;
> las 56 tandas desde el 13/08 tienen `Op` vacío, así que ni el monitor ni EP las ofrecen.
>
> Nota **v10.02 — fix: el botón "Enviar" nunca aparecía en Recepción → Pendientes.**
> Desde **v8.83** `opEnviar()` genera el código de 4 dígitos **al crear** la fila de
> `Control_Modo_OP` (para que el operario lo vea y lo escriba en el remito físico), pero
> `pendCard()` seguía con la semántica vieja: `if (r.codigo)` → mostraba el código y **no
> dibujaba el botón Enviar**, asumiendo "ya procesada". Como la lista filtra
> `estado='pendiente'`, toda fila nueva nacía con código y **nada podía salir de Pendientes**
> (10 filas trabadas, incl. Pintos RTO 0426 y Carriero RTO 1735 con el checklist completo).
> **Fix:** la tarjeta muestra el código **y** el botón Enviar (habilitado solo con
> `pendRowComplete` = ISIS + partes + faltantes + foto); `sentRow` ya no se aplica al
> renderizar. Además `pendEnviar()` **reusa** el código existente en vez de generar otro
> (antes quedaban dos códigos distintos para la misma recepción: el del remito físico y el
> del checklist).
>
> Nota anterior · Versión app al documentar: **v9.78**
>
> Nota **v9.78** — **Zonas paso 2 (diagnóstico coord→zona).** En "📍 Mapa de zonas": la
> geocodificación ahora guarda los **componentes oficiales** (`PPP_Geo.comp`) y re-geocodifica
> las viejas que no los tenían. `_zgZonaSug` aplica **tu** mapeo `pppZonaDeBarrio` (PPP_BARRIO_ZONA
> + overrides) al **nombre oficial** (barrio/partido) que devuelve Nominatim → zona sugerida.
> El mapa **marca los desajustes** (anillo negro) donde la zona ACTUAL ≠ la oficial, y lista
> "actual → oficial". Es diagnóstico (no aplica cambios todavía): sirve para ver qué direcciones
> están mal zonificadas. Falta el paso de **aplicar** las correcciones (a definir tras revisar).
>
> Nota anterior · Versión app al documentar: **v9.75**
>
> Nota **v9.75** — **📍 Mapa de zonas (geocoding).** Botón nuevo en el cierre de Facturación
> (al lado de "Armar ruta"). Geocodifica TODAS las direcciones de la programación con
> **Nominatim/OpenStreetMap** (gratis, 1/seg, cache en tabla `PPP_Geo`) y las muestra en un
> **mapa Leaflet/OSM** coloreadas por su **zona actual** (`PPP_ZONA`), para detectar direcciones
> mal zonificadas. `_zgGeocode` usa `addressdetails=1` y NO fuerza CABA (bug del viejo
> `_rtGeocode`), guardando los **componentes oficiales** (partido/barrio) en `PPP_Geo.comp`
> (jsonb nuevo) para el **paso 2**: asignación híbrida de zona por coordenadas (componentes
> oficiales + polígonos en los bordes). Migración `ppp_geo_comp_y_update_policy` (columna
> `comp` + policy UPDATE anon para upsert). Leaflet desde cdnjs. Funciones `openZonasMapa`,
> `_zg*`. **Pendiente (paso 2):** la regla coord→zona híbrida (todavía no toca `pppZonaDeBarrio`).
>
> Nota anterior · Versión app al documentar: **v9.74**
>
> Nota **v9.74** — **Sugerir tandas: empaque BALANCEADO.** Antes empacaba por cliente hasta
> un cap (0.8) y el cierre final dejaba restos chicos (tandas de 0.20). Ahora, por zona (NUNCA
> mezcla zonas), reparte balanceado: **mínimo 0.60 · ideal 0.80 · máximo 1.00 m³**. Ej: 1.60 →
> 2×0.80 (no 1.0+0.6). Un cliente (todas sus NPs juntas) que pesa > 1.00 va en tanda propia
> (indivisible). Lo que no llega a 0.60 en su zona sin mezclar queda **PENDIENTE** (no se
> programa, espera volumen). **Súper** = 1 tanda por **razón social**, van solos (sin mínimo).
> Helper `_pppBalancearZona` (LPT balanceado); usado por `pppSugerirTandas` (escribe) y
> `_pppComputeSugerencia` (vista). El ideal sale de `cfg.tandaCap` (0.80 por defecto).
>
> Nota anterior · Versión app al documentar: **v9.73**
>
> Nota **normalización cod_art (2026-08-12)** — Para que no vuelvan los códigos fantasma:
> (1) se **enganchó el trigger `trg_canon_cod_art`** (`fn_canon_cod_art`) en `Movimientos_Stock`
> — antes la función existía pero no estaba attachada. Al **insertar un artículo de STOCK**
> canoniza el `cod_art` (OC_Maximos curado, o numérico sin ceros a la izq con mínimo 3 dígitos,
> nunca trunca). **Saltea insumos** (usan su catálogo `Insumos.cod`; su espacio numérico pisa el
> de stock: `0027`="Caja Nº 1" canonizado sería `027`=Colador) y los tipos del pipeline
> (picking/separado/facturado, dedup del cron). (2) `vista_saldos_stock` ahora **agrupa por clave
> canónica** (variantes con cero a la izq caen en una fila); con los datos de hoy es no-op
> (0 fusiones), solo red de seguridad. La prevención de insumos sigue siendo el alta con código
> `TMP-NNNN` (idea 5572). `sql/normalizacion_cod_art_20260812.sql`.
>
> Nota **v9.73** — **Fix "Cajas Pedidas" (columna en Stock quedaba vacía).** La vista
> `v_cajas_pedidas` restaba `facturadas` **y** `entregadas` por separado; una NP facturada
> **y** entregada se restaba dos veces → `cajas_pedidas` negativo → fila filtrada. Se rompió
> al poblarse `PPP_Entregados_Meta` (759 NPs). Ahora resta la **unión** (facturadas ∪ entregadas
> ∪ canceladas) UNA sola vez (260 filas / 9353 cajas). `sql/backup_20260812_cajaspedidas_0027.sql`
> guarda la def anterior. También: **eliminado el código fantasma `0027`** ("Caja Nº 1", movs
> neteaban 0) de `Movimientos_Stock` + `Insumos`; y **sacado el cartel "NP que faltan (sin cargar
> en PPP)"** de la tabla de Stock (el módulo sigue en el botón "Pedidos sin cargar en PPP" del
> panel supervisor).
>
> Nota anterior · Versión app al documentar: **v9.65**
>
> Nota **v9.65** — **Generador de OCs: `stock` = TODO el módulo Stocks.** `vista_generador_oc`
> ahora suma los 8 depósitos (terminado + a_guardar + racks + excedente + separar_pedidos +
> a_facturar + para_envasar + racks_ch, NO insumos), igual que la columna "Total Stock". Antes
> solo góndola + a_guardar + racks + excedente. Fórmula intacta (A pedir = máx(0, máximo + pedidos
> − stock)). `sql/vista_generador_oc.sql`. (v9.64: acceso a Avisar programación restringido a 3
> personas — Tomas Gonzalez, Marianela Becker, Giuliana.)
>
> Nota anterior · Versión app al documentar: **v9.63**
>
> Nota **v9.61–v9.63** — **Avisar programación:** (v9.61) `_avpTel` normaliza el teléfono al
> formato **wa.me** (54 9 + área sin 0 + número sin 15) — antes los números locales daban links
> rotos; (v9.62) **cargar/editar teléfono inline** (`avpEditTel` → `whatsapp_clientes`) y **deshacer
> aviso** (`avpUndoCliente` → borra el log, policy `epl_del`). **Recepción (idea 3239, v9.63):**
> `gondReturnCheck` avisa (no bloquea) al recibir si un artículo no estaba en la OC + no entra en
> góndola (×1.20) + baja rotación (<50 caj/mes) → pedir autorización. `recepcion.js?v=9.63`.
>
> Nota anterior · Versión app al documentar: **v9.60**
>
> Nota **v9.60** — **Bajada de racks del operario = INMEDIATA.** El flujo `rkbSubmit`
> (botón RKB del operario) ahora mueve el stock al instante (`stockMove`: racks − / góndola +)
> y deja la fila en `Racks_Bajadas` como **'aprobada'** — ya NO espera la aprobación de la
> operadora ni entra a la cola "Bajadas Racks → góndola" (por eso tampoco se cuenta doble). El
> otro flujo `brConfirmar` (orden de racks) ya movía inmediato desde v8.73. La bajada AUTO
> (`creada_por='auto'`) sigue como 'propuesta' (sugerencia, requiere aprobación).
>
> Nota anterior · Versión app al documentar: **v9.59**
>
> Nota **v9.55–v9.59** — **Avisar programación** (varias): (a) badge de Recepción suma remitos por
> cargar + bajadas de racks; (b) fix 401 al marcar Discontinuo (RLS `Articulos_Discontinuados`);
> (c) date pickers con `min=2025-01-01`; (d) Plata perdida con drill-down por fila (detalle + resumido);
> (e) vendedores en grid de boxes compactos; (f) se sacó la alerta de urgentes de "Qué bajar primero";
> (g) **vend 20 (super) = interno "nosotros"** — no se avisa ni al cliente ni al vendedor
> (`_avpNoVend`/`_avpNoCliente`); (h) la tabla deja solo **pendientes**, los avisados van a una sección
> colapsable; (i) **registro de lo enviado al vendedor**: al mandar el resumen se logea cada grupo
> (tipo='vendedor' con NP) y esos pedidos **no reaparecen** en el resumen los días siguientes
> (`vendSent` en `avpLoad`/`avpSendVendedor`). Teléfonos cargados en `whatsapp_clientes` (473) y
> `whatsapp_vendedores` (vend 6).
>
> Nota **v9.54** — **Plata perdida: drill-down por fila.** Tocar una fila (artículo/cliente/
> vendedor) abre un pop-up con el detalle del período: **Fecha · Cod Cliente · Razón Social ·
> Pedido (NP) · Entregado · Valor no entregado**. Botón **"Resumido"** agrupa por cliente
> (**Cliente · Cajas del plazo · Valor no entregado**). Se sumaron `cajas_pedidas`/`cajas_entregadas`
> al fetch de `Entregas_Virgilio`. `ppOpenDetail`/`ppDetRender`.
>
> Nota **v9.53** — (a) **Badge en "Carga Recepción Mercadería"** (panel supervisor): círculo
> rojo con la cantidad de **remitos pendientes de cargar** (`Control_Modo_OP` estado='pendiente'),
> mismo contador que el botón "📋 Pendientes" del menú de recepción. `recepLoadBadge()`.
> (b) **Fix 401 "marcar Discontinuo"** en *Completar datos producto*: la tabla
> `Articulos_Discontinuados` solo tenía SELECT para anon → el upsert daba HTTP 401. Se
> agregaron policies INSERT+UPDATE para anon (`sql/articulos_discontinuados_rls.sql`).
>
> Nota **v9.52** — **Date pickers con `min="2025-01-01"`**: los selectores de fecha
> (movimientos de stock, producción, OC, fecha de tanda, ruteo) ya no ofrecen años previos a 2025.
>
> Nota **v9.85** — **Faltantes x día: números totales + columnas de referencia + notas editables + imprimir.**
> (a) **Stock** ahora muestra el **stock TOTAL** (todos los depósitos, incluye `separar_pedidos` +
> `a_facturar`) = igual que la solapa Stocks — la PROYECCIÓN de faltante sigue usando el neto no
> comprometido. (b) **Total Pedidos** = **todas** las cajas pedidas **hasta facturar** (incluye
> pickeadas/armadas); el drill del total marca "Armado ✓ / En picking / Sin pickear". (c) Nuevas
> columnas: **Última entrega** (fecha + cajas de la última recepción a góndola, de `Movimientos_Stock`
> `tipo=recepcion deposito=a_guardar`), **OC pend.** (cajas + fecha de `Ordenes_Compra estado=pendiente`),
> y **Día resol.** + **Motivo falta** editables (✏, persisten en tabla nueva `Faltantes_Notas`
> (cod PK, dia_resolucion, motivo, actualizado; RLS anon select/insert/update)). (d) Botón **🖨 Imprimir**:
> abre el módulo tal como está filtrado en ventana nueva + una **observación** al pie de qué NO se muestra
> (solo quiebre / sin E / filtro por columna / búsqueda) → reporte para el gerente. `index.html`.
>
> Nota **v9.49** — **Pestaña Stocks: nueva columna "Proy. caj/mes"** (antes de *Total Stock*).
> Muestra la **proyección de venta en cajas/mes** por código, tomada de `proyeccion_madre.proy_cajas_mes`
> (el mismo valor "antes del índice" que usa el generador de OCs). Header clickeable como las demás
> (filtra filas con proyección > 0). Lookup exacto → base (`_proyOf`). `index.html`.
>
> Nota **v9.44/9.45** — **Faltantes x día:** (a) el **faltó al armar** (realFalt, dato real de tandas
> pickeadas) ahora se ubica en la **celda del día de su fecha de salida** (badge roja) además del
> badge total en el código; (b) los **headers de columna son clickeables** para filtrar: tocar
> **Falt S1 / S2 / Resto / Sin fecha** o **un día** muestra solo los artículos con faltante en esa
> columna, ordenados por ese valor (🔎 en el header activo; chip "✕ Filtro" para quitarlo).
>
> Nota SERVER **v9.45** — **NC a Loeke: 437E/438E solo con la variante "...L".** `vista_nc_loeke_chef`
> agarraba también los códigos **pelados** (437E/438E) → 27 pendientes con 20 que no correspondían.
> Ahora 437E/438E hacen NC a Loeke **solo si el pedido es "...L" (ej. 437EL)**. (439E y demás quedan
> igual — confirmar si también deben requerir "L".) `sql/vista_nc_loeke_chef.sql`. Quedó en 7.
>
> Nota (diagnóstico) — **584E ("Aceitera 400 Ml") no está en la pestaña Stocks** porque su stock
> (2400) está en el depósito **`insumos`**, no en terminados (tot terminados = 0). Se ve en **🧰 Insumos**.
> Probable error de recepción (cargado como insumo).
>
> Nota **v9.38** — **(a) "Corregir códigos de NPs" ahora tiene 2 badges:** ROJO (arriba-derecha) =
> NPs que hay que corregir SÍ o SÍ (el secundario **no tiene stock**), VERDE (arriba-izquierda) =
> NPs donde el secundario **tiene stock** → se puede mandar tal cual, corregir es opcional.
> `corrLoadBadge` cruza `facCorreccData()` con `vista_saldos_stock` de los secundarios; rojo si algún
> item de la NP tiene stock del secundario ≤0. **(b) "Pedidos sin cargar en PPP" ahora avisa NP
> salteadas en la secuencia numérica** (huecos ≤5 entre NPs que sí existen; ej. 98576 y 98578 sin
> 98577). Vista nueva `vista_np_faltantes_secuencia` (`sql/np_faltantes_secuencia.sql`, unión de
> PPP_Base ∪ Programacion ∪ Facturacion ∪ Entregados ∪ Canceladas). Puede ser un pedido no cargado
> o una NP anulada en el ERP. **(c) Precio de venta confirmado:** LK `products.list_price` (proyecto
> "loekemeyer's web" = `kwkclwhmoygunqmlegrg`) es la fuente correcta que ya usa `precios_venta`.
>
> Nota **v9.37** — **Módulo "💸 Plata perdida de facturar" (faltante por quiebre).**
>
> Nota **v9.37** — **Módulo "💸 Plata perdida de facturar" (faltante por quiebre).** Panel supervisor.
> Valoriza las cajas que el cliente pidió y **no se pudieron entregar por falta de stock**
> (`Entregas_Virgilio.cajas_falto`) a **precio de venta**: `plata = cajas_falto × precio_unit × uxb`.
> Precio de venta = snapshot de LK `products.list_price` (por unidad) + `uxb`, en la tabla nueva
> **`precios_venta`** (`sql/plata_perdida.sql`; sin FDW, se re-sincroniza a mano). Agrupa por
> **Artículo / Cliente / Vendedor** (reusa `clientes_vendedor` para el vendedor) con filtro de
> período por fecha de salida. Total actual ~$51M (29/06–13/08). ⚠ precio **8888** en LK = placeholder
> → no se valoriza, se marca "sin precio" (23 códigos sin precio → cargar en `precios_venta`).
>
> Nota **v9.36** — **839 (Rallador Chico Chocolate) es secundario de 838E (primario).**
>
> Nota **v9.36** — **839 (Rallador Chico Chocolate) es secundario de 838E (primario).** Se cargó la
> equivalencia en las **DOS** fuentes (⚠ están separadas y hay que mantenerlas sincronizadas):
> (a) el array **hardcodeado `EQUIV_FAMILIAS`** en `index.html` (lo usa la pantalla de **Faltantes** y
> el picking vía `equivFam`/`equivFamKey` — agrupa 839 bajo 838E y netea el stock, así 839 deja de
> figurar como faltante fantasma), y (b) la tabla Supabase **`Equivalencias_Familia`** (la usa
> `vista_pedidos_secundarios` → módulo "Corregir códigos de NPs"). Antes 839 no estaba en ninguna,
> por eso su demanda no se neteaba contra el stock de 838E y aparecía como faltante que no faltaba.
>
> Nota **v9.35** — **"¿Qué bajar primero?" ahora marca los URGENTES (góndola < 20%).**
>
> Nota **v9.35** — **"¿Qué bajar primero?" ahora marca los URGENTES (góndola < 20%).** Arriba de
> todo, una alerta roja lista los códigos con góndola < 20% de su máximo (sobre TODOS los códigos
> con capacidad, tengan o no stock atrás para bajar); los que dicen «sin stock atrás» no se pueden
> resolver ahí → producir/OC. Además las filas urgentes de la tabla van resaltadas (🆘 + fondo rojo).
> `showGuardarOrden`/`renderGuardarOrden`, umbral 20% (`_URG`).
>
> Nota **v9.34** — **Faltantes excluye también entregadas y canceladas** (consistencia con
> `ocgDemanda`): `stkFaltLoad` ya excluía facturadas + tandas pickeadas; ahora suma al set de
> exclusión `PPP_Entregados_Meta` y `NP_Canceladas`.
>
> Nota **v9.33** — **Avisar programación: vendedores unificados + dedup.** Panel de vendedores fijo
> arriba; el resumen de cada vendedor se arma con los clientes que se van avisando (1 línea por
> aviso). Dedup: mismo cliente + misma fecha de salida = 1 solo mensaje (une sus NPs). El badge de
> "Pedidos sin cargar en PPP" se sincroniza al abrir el módulo.
>
> Última actualización previa · Versión app al documentar: **v9.31**
>
> Nota **v9.31** — **Módulo "📲 Avisar programación".** Panel supervisor → lista los pedidos
> **programados** (con fecha de salida, de `vista_ppp_programacion_pendiente`) ordenados por fecha
> de salida, con columnas: Cod cliente · Razón social · Fecha pedido (`fecha_recep`) · Fecha PPP
> (`fecha_entrega`) · Días demora · WhatsApp Cliente · WhatsApp Vend. Al **entrar pregunta quién**
> entra (queda en el log). Cada botón abre **WhatsApp Web** (`wa.me`) con el mensaje armado y
> registra día/hora + quién en `envio_programacion_log` (se muestra en la fila). El mensaje del
> **vendedor agrupa** todos sus clientes (razón social + fecha de salida). **vend 7 = fábrica
> (nosotros) → sin aviso a vendedor.** 4 tablas nuevas en Virgilio (`sql/aviso_programacion.sql`):
> `clientes_vendedor` (snapshot cliente→vend de LK.customers, 1245 filas, 596 fábrica),
> `whatsapp_clientes` (cod→tel), `whatsapp_vendedores` (vend→tel+nombre), `envio_programacion_log`.
> Mensaje al cliente (v9.32, texto del dueño): *"Estimado Cliente: Su pedido ya fue programado para
> el día {fecha salida DD/MM/AAAA}. Tenga en cuenta que la fecha … es aproximada y puede tener una
> diferencia de 2 o 3 días … Saludos. Dpto. de Ventas."* (en `avpMsgCliente`). Las tablas de
> teléfonos arrancan vacías (cargar a mano). Sin FDW Virgilio↔LK: el mapeo cliente→vend se
> re-sincroniza a mano (ver el SQL).
>
> Nota **v9.30** — **Conteo físico exportable a CSV con "Stock del sistema".** El módulo de conteo
> (Stock → "📋 Hacer conteo") ya comparaba contado vs sistema en pantalla; ahora tiene botón
> **⬇ Exportar CSV** (`cntExportCsv`) que baja el conteo con columnas: Sector, Código, Pilas,
> Cajas por pila, Sueltas, Contado (cajas), **Stock del sistema** (góndola+excedente, mismo cálculo
> que la comparación), Diferencia y En proceso. Formato Excel es-AR (BOM utf-8, `;`, coma decimal).
>
> Nota **v10.27** — **RR: fecha del CC (carga al camión) + Corregir códigos: pestaña "🔴 Urgentes".**
> Dos pedidos del dueño. **(1) Recepción Remitos (RR)** (`crRender`): bajo el número de NP ahora se
> muestra la **fecha/hora en que se cargó al camión** (`🚚 DD/MM HH:mm`, hora AR vía `crFmtCC` sobre
> `it.loadMs` = primer evento **CCN** de esa NP; en rojo si está vencido). Es el dato que ya se usaba
> para calcular el vencimiento (+30 hs), ahora visible. **(2) Corregir códigos (secundario → principal)**
> (`facCorreccRender`): pestaña nueva **"🔴 Urgentes"** (estilada en rojo) que cruza TODOS los estados y
> muestra solo las NP que **SÍ o SÍ** hay que cambiar en el ERP = alguna línea donde el stock del código
> **secundario no cubre lo pedido** (`_corrItemUrgente`: `stkSec < cajas`). Las NP cuyo secundario alcanza
> ("mandalo tal cual, sin tocar NP") no aparecen. Misma idea que el badge ROJO del botón (v9.38), ahora
> filtrable dentro del panel. Todo **front** (lee `it.loadMs` ya cargado y `_facCorrRows`; sin backend).
> Bump `APP_VERSION` + `SW_VERSION` `v10.27`.
>
> Nota **v10.26** — **Carga Camión (CC): orden de carga (inverso de la ruta) + ubicación física por NP.**
> Cierra el follow-up de v5.86 ("mostrar la ubicación por NP en carga de camión"). El reparto de
> Carga Camión (`fetchCCData` → `showCargaCamion`/`ccRender`) ahora enriquece cada NP con dos cosas
> vía la función nueva **`_ccAttachUbicYOrden(items)`**: **(a) UBICACIÓN física** = último evento
> **`AUB`** de esa NP (dónde quedó armada: AB8/AA4…, la que eligió el armador al TAP), mostrada como
> badge violeta `📌`; **(b) ORDEN DE CARGA** = **inverso de la ruta de reparto** — el último destino
> de cada camión se carga primero (1 = primero en subir). Reusa la geocodificación ya cacheada en
> **`PPP_Geo`** (la que llena "Armar ruta de reparto"), el optimizador `_rtOptimize` y las mismas
> **`RT_RUTAS`**/zonas; **no geocodifica nada nuevo** (solo lee cache → instantáneo en el celular).
> Direcciones/zona/m³ salen de `PPP_Programacion_Diaria` por NP. `ccRender` pasó de agrupar por
> **tanda** a renderizar **en orden de carga** con encabezado por ruta, número de posición (`.cc-pos`)
> y el badge de ubicación (`.cc-ubic`). Las NP **sin dirección geocodificada** (o sin zona geográfica:
> Retira/Súper/Expo) caen en una sección aparte **"📍 Sin ubicación en ruta — cargar aparte"** al final.
> Todo **best-effort**: si falla el fetch de AUB, PPP o la cache de geo, el reparto se muestra igual
> (sin orden ni ubicación, orden viejo por tanda como fallback). Solo front (lee eventos/tablas ya
> existentes; sin cambios de backend). Bump `APP_VERSION` + `SW_VERSION` `v10.26`.
>
> Nota **v10.22** — **PPP: "En viaje" renombrado a "En Salida".** El tab del PPP que junta los
> pedidos **facturados** que ya salieron de la Programación pero sin entrega confirmada (`_pppEnViajeHtml`,
> tab key interno sigue `enviaje`) pasó a llamarse **"🚚 En Salida"**. Incluye lo facturado sin cargar y
> lo cargado sin controlar remito. Los facturados ya se excluyen de la Programación (`programados =
> notEnt.filter(...)` en modo normal) y aparecen acá. Solo cambió el rótulo y el texto de ayuda; la
> discriminación fina por sub-estado sigue en los módulos "FC s/salida" y "Recepción Remitos (RR)".
>
> Nota **v10.21** — **Switch "auto-imprimir FACTURADO" ahora en Supabase (no se apaga solo).** El
> toggle de auto-imprimir el remito facturado (Cola de impresión) estaba en `localStorage`
> (`fac_print_facturado_virgilio`) → la TWA/PWA lo borraba y aparecía apagado al volver. Ahora es un
> ajuste **global en `Stock_Config.fac_print_facturado`** (mismo patrón que `etiqueta_lio`), cacheado
> en `_facPrintGlobal`, cargado con `facPrintCfgLoad()` al abrir la Cola de impresión y en el gate
> `facMaybePrintFacturado`. Persiste para siempre. Para mantener "solo la PC imprime", el gate tiene un
> **guard de celular** (`_facIsMobile`): los móviles nunca auto-imprimen aunque el switch global esté
> ON. (Los otros dos switches del módulo —auto-print de armado `psIsAuto` y etiqueta de lío— no se
> tocaron; el de armado sigue per-dispositivo a propósito para no duplicar impresiones.)
>
> Nota **v10.20** — **Ruteo: sacar de la ruta lo ya cargado al camión (y confirmar que Retira no
> entra).** El armado de rutas (`ruteoLoad`) leía `PPP_Programacion_Diaria` y ruteaba todos los
> pedidos del día. Ahora, además de tomar **solo zonas geográficas** (Z1..Z7 — Retira/Súper/Expo ya
> quedaban afuera por el filtro `^zona`), **excluye los pedidos ya cargados al camión**: `_rtFetchCargadas()`
> arma un Set de NPs con evento **CCN** (Carga Camión NP, `texto = NP|TANDA`, últimos 30 días) y el filtro
> saca esos NP. Muestra un aviso "🚛 N pedido(s) ya cargados al camión — fuera de la ruta". Así el
> repartidor no ve como parada lo que ya subió al camión.
>
> Nota **v10.23** — **Ruteo: "Abrir en Google Maps" en tramos (>9 paradas).** El link de Maps
> (`_rtMapsUrl`, ahora `_rtMapsUrls`) mandaba TODAS las paradas como `waypoints`, pero Google Maps
> corta en **~9 waypoints**: una ruta de 16 paradas abría solo 9. Ahora la ruta se parte en **tramos
> de ≤9 waypoints**, encadenados (el destino de un tramo es el origen del siguiente), empezando y
> terminando en el depósito. `_rtMapsUrls()` devuelve un array de URLs; el render muestra **un botón
> por tramo** ("Abrir tramo 1/2…") con un aviso; si hay uno solo, va el botón único de siempre.
>
> Nota **v10.18** — **Hoja "Góndola < 25%" en Stock y Compras (auditoría).** Tab nueva **🔍 Góndola
> <25%** en el módulo Stocks (`openStockAdmin`) → `stkBodyAuditGon` (datos por `agLoad` desde
> `vista_generador_oc`). Lista los artículos cuya **ocupación de góndola = (stock total de todos los
> estadios − pedidos) ÷ proyección** es **< 25%**. Ordenado por **tallerista** (proveedor, con banda de
> grupo fija al scrollear) y dentro por **familia**. Columnas: Código, Descripción, % góndola, Stock
> total, Proyección, Pedidos, Familia. Letra grande (auditor con mala visión de cerca), encabezado +
> tallerista **sticky**, scroll vertical. Baja a **Excel** (`agExportExcel`) y a **PDF** (`agExportPdf`,
> ventana de impresión). ⚠ **Familia = 1ª palabra de la descripción** (proxy): no hay familia de
> producto real en Supabase (la categoría "Cat.Art" vivía en el Excel Madre, sin sincronizar). Si se
> carga una tabla de familias, se cambia el `agFamilia()` por ese cruce.
>
> Nota **v10.17** — **Completar Pedido (operario) muestra todos los faltantes con stock (sin depender
> de "Avisar").** El CP del operario (`showCPModal`) filtraba angosto: solo faltantes cuyo artículo
> estuviera **a guardar** (`a_guardar>0`) o **guardado hoy**. Por eso faltantes completables desde
> góndola/excedente NO le aparecían al operario y dependían de que Marianela apretara **📢 Avisar** en
> el admin (`showFaltAvisar`). Ahora el CP del operario usa el **mismo criterio que el admin**: muestra
> todo faltante con stock en **góndola + a guardar + excedente + racks** (`disp>0`). Aparecen solos, sin
> avisar. El marcador `_guardadoHoy` se conserva para destacar lo recién llegado. El pop-up push
> (`faltPollStart`, vía tarea de "Avisar") sigue existiendo como aviso proactivo aparte.
>
> Nota **v10.16** — **FIX raíz (backend): stock del armado reconciliado contra Entregas.** Al volver
> al modelo de stock por-PKC, el pase **separar_pedidos → a_facturar** (ETAPA 2 del pipeline + el
> fast-path del front `stockSepararAFacturar`) movía TODO lo pickeado a `a_facturar` sin mirar el
> armado → una caja pickeada que el armador marcaba "de menos / no iba" quedaba **fantasma en
> a_facturar** y la góndola en **negativo** (caso 366E/98237/D20A). Ahora la **ETAPA 2 reconcilia
> contra `Entregas_Virgilio`**: a `a_facturar` va **solo lo entregado**, y lo pickeado no entregado
> **vuelve a góndola** (`terminado`). Componentes: `reconciliar_pipeline_stock_etapa2()` (delegada,
> reparte entre variantes de marca con window function), `reconciliar_pipeline_stock()` la llama
> (etapas 1/3/4 intactas), trigger **`trg_entregas_reconciliar_stock`** AFTER INSERT statement en
> `Entregas_Virgilio` que la corre en el acto, y el **front `stockSepararAFacturar` neutralizado**
> (no-op). Solo afecta armados nuevos; validado con ROLLBACK sintético + trigger end-to-end. Doc en
> `sql/pipeline_etapa2_reconciliada_20260812.sql`. (El caso 366E viejo se había ajustado a mano.)
>
> Nota **v10.15** — **Histórico de bajadas de racks (Recepción).** Nuevo botón **📥 Histórico
> bajadas de racks** en el menú de "Carga Recepción Mercadería" (`renderMenu` en `recepcion.js`) →
> `renderHistoricoBajadas()`. Módulo SOLO LECTURA sobre la tabla `Racks_Bajadas` (id, ts, cod_art,
> descripcion, cajas, sector, estado, creada_por, aprobada_at), con buscador por **fecha** (Desde/Hasta
> + chips Hoy/7 días/Este mes/Todo) y por **código / descripción / sector / quién** (un solo campo, `.or`
> ilike). Tabla con Fecha, Código (+desc), Sector, Cajas, Quién y Estado (verde aprobada / ámbar
> propuesta / rojo rechazada) y total de cajas. Reusa el estilo del "Histórico de recepción" (clases
> `hist*`). RLS `rb_select` anon. Sin cambios de datos, es consulta.
>
> Nota **v10.14** — **FIX regresión: "avisar que pickearon mal" borraba separado + líos.** El fix de
> v10.10 (`_compDifResolve` "de menos") ponía `_comp._liosDirty = true` cuando la NP ya tenía líos
> armados, lo que hacía `_compBuildLiosData()` en el próximo `_compRenderSep()` y **reconstruía todo
> desde cero** → se perdía lo separado y los líos de TODAS las NPs. Ahora el descuento reduce sólo el
> `sale`/`rest` de ese código (y registra el faltante para Entregas), **sin** forzar el rebuild. El
> resto del avance queda intacto.
>
> Nota **v10.13** — **Completar Pedido (CP): feedback del lío destino.** En "📦➕ Completar Pedido"
> (`showCPModal` → `cpRenderStep2`/`cpConfirm`), al completar un faltante el destino por defecto ya
> era **lío nuevo** (`_cp.lioSel = "__new__"`, y `cpUpdateLio` con lioSel no-numérico empuja un lío
> nuevo). El problema era de **feedback**: el botón decía sólo "→ a facturar" y el mensaje de éxito no
> nombraba el lío, así que el operario no sabía si se agregaba como lío nuevo. Ahora el botón muestra
> el destino (**"→ Lío NUEVO X"** o **"→ Lío A"** si eligió uno existente) y el mensaje de éxito lo
> confirma ("· Lío NUEVO X (a facturar)"). No cambia la lógica, sólo lo hace explícito.
>
> Nota **v10.12** — **Completar: ubicación del pedido separado por NP.** En el wizard Completar,
> el paso de armar líos (`_compRenderLios`) ahora muestra, por cada NP, un banner 📦 con **dónde
> quedó/lo dejó el picking** (`_comp.pickUbic`, del evento PUB más reciente), además del que ya
> estaba en el header del paso Separar. Así el armador sabe dónde ir a buscar el pedido. (Pendiente,
> idea usuario **3688**: sacar mercadería de excedente moviendo stock.)
>
> Nota **v10.11** — **Un solo código de verificación (recepción), sacado del guardado.** (1) El
> **Guardado a Góndola** (MG, `mgConfirmar`) YA NO pide la "Verificación de Góndola" (código de 4
> dígitos que había que escribir en la góndola) — se confirma directo. (2) La **Recepción**
> (`opEnviar` en `recepcion.js`) daba DOS códigos: uno a escribir en el remito ANTES de enviar
> (`showVerificationModal`) y el **código de confirmación** del final (`pendGenCodigo`, guardado en
> `Control_Modo_OP.codigo` para el checklist). Se sacó el primero → **un solo código, el de
> confirmación al terminar de recibir**. `showVerificationModal` queda definida pero sin uso.
>
> Nota **v10.10** — **FIX Completar/Separar: "de menos" ahora se descuenta del pedido.** En el
> wizard Completar (Separar → Líos), cuando el armador reporta que un artículo **difiere de la mesa
> "de menos"** (hay menos que lo que marcó el picking, ej. "el 366 no estaba en lo que pidieron"),
> antes SOLO emitía el aviso NPD (`Picking difiere de mesa`) y seguía **entero**: se armaba en los
> líos y se facturaba completo. Ahora `_compDifResolve('menos',…)` además **descuenta** ese faltante
> del armado (`c.sale`/`c.rest`) y lo registra como faltante manual en `_comp.arts` (helper nuevo
> `_compAddFaltManual`, NP normalizada con `pickNormNp`), de modo que `compTerminar` lo reste también
> de `Entregas_Virgilio` (`cajas_falto`) → **no se factura lo que no estaba**. El "de más" no cambia
> (las que sobran se re-guardan; el pedido no crece). Es todo front-end (el wizard calcula líos y FAL
> en el cliente). El aviso NPD por Telegram/Agentes se mantiene igual.
>
> Nota **v10.09** — **Botón "Ver módulo operarios" en el panel admin.** En el panel de
> Administración (`#supervisorPanel`, sección "Reportes y configuración") hay un botón nuevo
> **👁️ Ver módulo operarios** (`openOperarioView()`) que abre la grilla completa del operario
> (`#optionsScreen`, EP/TP/AP/MG/etc.) para que el supervisor la recorra sin desloguearse. Entra
> con el **legajo de PRUEBAS (1)** (test/basura, excluido de reportes) — así cualquier toque queda
> como prueba y no ensucia datos — y muestra un banner ámbar con botón "← Volver al panel". Como
> `goToOptions()` oculta todo `#legajoScreen` (que contiene el panel admin), al volver reaparece el
> panel solo; se restaura el "último legajo" para no dejar el 1 pegado en el login por legajo.
>
> Nota **v10.08** — **Guardado a Góndola muestra la ubicación del artículo.** En el módulo "📥 Guardar
> a góndola" (MG), cada fila ahora muestra un chip 📍 con **dónde va el artículo en góndola** (primera
> celda destacada + las siguientes entre paréntesis) y **cuántas ubicaciones tiene** (ej. `📍 Va en P39
> (A12, B03) · 3 ubicaciones`). Sale de `Capacidad_Sector.sector` vía la función nueva `ocgFetchCeldas()`
> (cod → [sectores], ignora celdas `Libre`, mismo `_ocgNorm` que la capacidad). Si el código no tiene
> celda fija cargada → `📍 sin ubicación fija cargada`. Es solo lectura/ayuda visual para el operario;
> no cambia el flujo de guardado ni la ubicación del **excedente** (que sigue siendo un input aparte).
>
> Nota **v10.07** — **Pedidos Importación: cotización USD (FOB) + volumen (m³), todo en Supabase.**
> Cada ítem del módulo "📦 Pedidos Importación" muestra: **FOB u$s/u** (editable ✏ → `Importados.fob_uni`,
> USD/unidad del proveedor), **u$s pedido** (= unidades a pedir × FOB), **Master cjs** (master cajas
> enteras), **m³/master** (editable ✏ → tabla `Importados_Volumen`) y **m³ pedido** (= master cjs ×
> m³/master). Arriba, dos tarjetas con el **TOTAL del pedido**: USD (Σ) y m³ (Σ), con aviso de ítems
> sin FOB/volumen. Subtotales por proveedor (cajas · u$s · m³) y todo baja al Excel + fila TOTALES.
> - ⚠ **Master caja ≠ inner caja.** `Importados.uni_x_caja` es la caja **inner**; el divisor correcto
>   para master cajas es **`Importados_Volumen.uni_master`** (del Excel). Master cjs = `ceil(a_pedir /
>   uni_master)` (sin decimales); si un ítem no tiene `uni_master` cargado, cae a `uni_x_caja` como
>   aprox y se marca con `~`.
> - **Tabla `Importados_Volumen`** (RLS anon select/insert/update): `cod` (PK, = `cod_art` en mayúsculas),
>   `largo_cm`, `ancho_cm`, `alto_cm`, `m3_master`, `uni_master`, `uni_inner`, `fuente`. El ✏ de m³/master
>   pide `Largo×Ancho×Alto` (cm) y calcula m³ = L·A·H/1e6, o acepta el m³ directo.
> - **Carga inicial (2026-08-12)**: se subió el Excel "QUIEBRE ART IMP 11-08" (hojas `Todos` +
>   `TRAZABILIDAD`) a Supabase: **149 códigos** en `Importados_Volumen` (medidas + m³ + uni_master) y
>   **144** FOB actualizados en `Importados`. Backup del FOB previo en `sql/backup_importados_fob_20260812.sql`.
>   **La app no toca el Excel**: todo corre de Supabase. Para re-cargar (nuevo Excel), repetir el upsert.
>
> Nota **v9.29** — **Pedidos Importación operable (editar en curso + marcar llegada).** El módulo
> "📦 Pedidos Importación" era solo-lectura; ahora cada fila tiene **✏️** (editar unidades EN CURSO
> = lo pedido/en camino → `Importados.pedido_curso`, que el motor resta de "a pedir") y **📥**
> (marcar LLEGADA: inserta `Importados_Mov_Stock` tipo `ingreso` +delta_uni y descuenta esa cantidad
> de `pedido_curso`, piso 0). Ambas por RPC **SECURITY DEFINER** por `Importados.id`
> (`importados_set_curso`, `importados_marcar_llegada`; grant anon+authenticated) — el INSERT en
> `Importados_Mov_Stock` es solo-authenticated para anon, por eso va por función. `ocgFetchImportados`
> ahora trae `id` y las filas por marca (`det`). SQL en `sql/importados_pedidos_rpc.sql`. Códigos
> multi-marca (solo 2) se editan por fila. Nuevo tipo de movimiento importado: `ingreso`.
>
> Nota **v9.28** — **Badges de pendientes en el panel supervisor.** Igual que el badge rojo de
> "Completar datos producto" (`dp-badge`), ahora **"Corregir códigos de NPs"** y **"Pedidos sin
> cargar en PPP"** muestran un contador con cuánto hay para corregir: NPs **distintas** en código
> secundario (`facCorreccData()`) y NPs sin programar (`vista_np_sin_programar`). Se cargan
> fire-and-forget al abrir el panel (`corrLoadBadge`/`npFaltanLoadBadge` en `showSupervisor`); el
> de sin-programar se refresca al marcar "🚫 No va". Helper común `supSetBadge(id,count)`.
>
> Nota SERVER (sin bump de app): **Importados — 067 usa el espiral importado 1000900.** Se agregó
> el mapeo `('1000900','067')` a `Importados_Partes_Map` (067 Sacacorcho Tipo Mozo Suelto), así la
> proyección de la parte 1000900 suma la demanda del terminado 067. Deployado + `sql/importados_partes_y_super.sql`.
>
> Nota SERVER (sin bump de app): **FIX alerta ESTANCADO — la tanda mostrada estaba mal (mostraba la última movida, no la trabada).**
> El "pickeado sin avanzar" tomaba la tanda del `ref` del movimiento **más reciente** que dejó stock en
> `separar_pedidos`/`a_facturar`. Pero el saldo trabado casi siempre viene de una tanda **vieja** que
> nunca salió, no de la última que se movió → mostraba **NP y día de PPP equivocados** (ej. cod `598E`:
> mostraba `D07x/Loeke` —última movida— cuando lo clavado era de `D15A/Chef`, más vieja). **Fix:** el CTE
> `tanda_cod` ahora toma la tanda del ingreso **más viejo cuyo stock nunca se descontó** dentro del
> **ciclo abierto** (mismo criterio de "ciclo" que la sección 1: arranca justo después del último
> movimiento que dejó el saldo del depósito en 0). Deployado + `sql/stock_estancado.sql` actualizado.
> Verificado sobre stock actual: ~50 códigos re-atribuidos a su tanda vieja real (D09B/D08A/D07B/D15A…).
>
> Nota: **v11.09/v11.10 — FIX stock fantasma por picking_difiere + fix conteos + fix 102E insumo.**
> Tres arreglos:
> **(1) Doble reversal picking_difiere** (v11.09): `_compDifResolve` ajustaba `terminado +ret` sin
> tocar `separar_pedidos` → la etapa 2 (trigger `trg_entregas_reconciliar_stock`) volvía a devolver
> las mismas cajas a `terminado` porque `separar_pedidos` seguía lleno → **góndola +1 fantasma** (caso
> real 584E). Fix: el ajuste ahora mueve **ambos lados** (`terminado +ret` + `separar_pedidos −ret`).
> **(2) Race condition** (v11.09): el `stockMove` fire-and-forget de `_compDifResolve` podía llegar
> DESPUÉS del trigger de etapa 2 (que lee `separar_pedidos` en la misma transacción que el INSERT de
> Entregas). Fix v11.09: acumular en `_comp._difMovs` y flush síncrono (`await stockMove`) ANTES de
> `_compSaveEntregas`. **v11.10 mejora**: **dual-send** — cada fila lleva un `client_id` pre-asignado
> (`_stockClientId()`); se manda fire-and-forget inmediato (actualización en **tiempo real**) Y se
> acumula en `_difMovs` para el flush síncrono (safety net). Si ambos llegan, `ON CONFLICT DO NOTHING`
> vía `mov_stock_clientid_dedup` deduplica. Si el armado se cancela antes de `compTerminar`, el ajuste
> inmediato ya corrigió la góndola negativa (es correcto: el picking la dejó negativa).
> **(3) Fix Conteo_Stock** (v11.10): la tabla tiene columna `ts` (no `created_at`); 3 lugares del
> front usaban `created_at` → PostgREST fallaba silencioso y los conteos no se veían en ajustes.
> **(4) Fix 102E es_insumo** (server-side): `vista_stock_procesada` clasificaba como insumo a
> cualquier código en la tabla `Insumos` (102E = ABRELATAS MARIPOSA, id 13); ahora solo es insumo si
> además **no tiene stock de mercadería** (`terminado+racks+racks_ch+excedente+a_guardar = 0`).
> Recreada la materialized view + índice + refresh.
>
> Nota SERVER (sin bump de app): **FIX stock — pedidos Chef facturados afuera dejaban stock LK trabado.**
> Los pedidos de **Chef (NP 44xxx)** facturan mercadería **LK** afuera de la app (Cencosud/Chef, lo del
> sufijo "L"). La **ETAPA 3** de `reconciliar_pipeline_stock()` drenaba `a_facturar` **solo si la tanda
> seguía en el PPP del día** (`PPP_Programacion_Diaria`, que se reemplaza a diario). Como los Chef se
> facturan **después** de que la tanda se cae del PPP, nunca drenaban → **stock LK fantasma** en
> `a_facturar` que rompe stocks (caso D15A: 550 cajas colgadas desde 05/08; el 100% de la alerta "stock
> estancado" era esto). **Fix:** ETAPA 3 usa fuente **durable** = NPs de la tanda de `PPP_Entregados_Meta`
> (histórico) ∪ `PPP_Programacion_Diaria` (actual) → drena cuando todas las NP están facturadas, tenga o
> no la tanda en el PPP. **Backlog** (D15A 550 + D06E 3 = 553 cajas) se drenó a mano (`facturado`,
> `legajo='reconcilia'`, `ref='<tanda>|FIX_CHEF_ESTANCADO_20260811'` → trazable/reversible), scope desde
> 1/8. Verificado: sin a_facturar negativos, backlog en 0. SQL en `sql/reconciliar_pipeline_stock.sql`.
>
> Nota SERVER (sin bump de app): **Alerta "STOCK ESTANCADO" ahora dice NP + día de PPP.**
> Cada línea de **pickeado** agrega la **tanda** (del `ref` del movimiento más reciente que dejó
> stock en `separar_pedidos`/`a_facturar`) y, a partir de ella, las **NP(s)** y el **día de PPP**
> (`fecha_entrega`). Fuente tanda→NP+fecha = `PPP_Entregados_Meta` (histórico) ∪
> `PPP_Programacion_Diaria` (actual). El "resto sin guardar" (recepción) no lleva NP. Ej:
> `cod 106E — 51 cj · pickeado sin facturar (hace 4 d. háb.) · tanda D15A · NP 44531/44532/44533 · PPP 05/08`.
> Función `reporte_agentes_stock_estancado()`, SQL en `sql/stock_estancado.sql`.
>
> Nota: **v9.25 — Stock de PARTE cuenta como stock del terminado importado (94xP → 94xE).**
> Los **94xE** (cubiertos ac. inox) se **importan** (maestro, Becky) pero **Log/Fabr los ARMA** a
> partir de la parte **94xP**. El stock de 94xP (depósito `insumos`, en **unidades**) es "94xE en
> parte" → cuenta como stock del 94xE al decidir cuánto importar: `a pedir = objetivo − (stock 94xE +
> stock 94xP) − en curso`. Tabla **`Importados_Stock_Parte`** (`terminado, parte`; hoy
> 942E←942P, 943E←943P, 944E←944P, 945E←945P, 948E←948P) + vista **`vista_importados_stock_parte`**
> (saldo neto de la parte en `Movimientos_Stock`; los `...(2)COPIA` netean 0). `ocgFetchImportados()`
> suma ese stock al del terminado; el módulo Pedidos Importación lo muestra con badge **🔧+N**.
> ⚠ NO es parts-map de demanda (los 94xE se siguen importando como terminados) — solo suma stock.
> Distinto de `Importados_Partes_Map` (505C/1000900/etc.), donde la PROYECCIÓN de la parte sale de
> sus terminados. SQL en `sql/importados_stock_parte.sql`. Bump `v9.25`.
>
> Nota: **v9.22 — Módulo "Pedidos Importación" + maestro Importados al día.**
> Los pedidos de importados se manejan **por fuera de las OC de talleristas** (que quedan igual que
> antes). Nueva pantalla **"📦 Pedidos Importación"** (botón en el panel supervisor, al lado de "🏭
> Proveedor de importación"): `openPedidosImportacion` → reusa `ocgFetchImportados()` (motor
> `v_importados_ordenes` + lógica de partes) y agrupa por **IMPORTADOR → proveedor chino**:
> **Chef** = Ownland/Kangli/Fujian/Frontier · **Tierra Nativa** (empresa aparte, NO Loeke) =
> Becky/Hugo Wong/Zhixin (mapa `_IMPORTADOR_DE`). Columnas: proy u/mes, objetivo, stock, en curso,
> a pedir (u y cajas); 🧩 = parte. Solo lectura por ahora. **Reenvasado por talleristas:** García
> (Cod_Tallerista 4317) reenvasa importados x24 (437E/438E/439E/440E/035E/113/566E/584E/590E/590ES);
> Lopez Jose arma Coladores (110/111/112/824/825); Log/Fabr los 838E/877E. Los importados que **nadie
> reenvasa** quedan con proveedor `Racks` en `OC_Maximos` = "se importa por otra vía, excluido del
> generador de talleristas". **Maestro `Importados`:** 100% de los importados cruzados contra proveedor
> chino (0 sin proveedor); se cargó el nuevo **`599E` Pelador Mgo Madera** (Hugo Wong/Tierra Nativa,
> marca LK, uxb 12, FOB 0.65, 144 pcs/master). Bump `v9.22`.
>
> Nota: **v9.20/v9.21 — Sufijo "L" (Cencosud/Chef), pelado en picking + NC Loeke→Chef en Facturación.**
> **Contexto de negocio:** el sufijo `L`/`EL` al final del código de artículo (ej. `438EL`, `957EL`)
> marca un artículo Loeke facturado dentro de **Chef** (clientes de NP **44xxx**: Cencosud, Dorinka,
> Renatek, etc.). Nace del circuito **Chef importa → vende a Loeke → NC → el tallerista (Brian)
> reenvasa x24 → vuelve como `...EL`**. La `L` se **pela aguas arriba** en el Excel "PPP Base Datos
> Pedidos" (por eso a Supabase llegan casi todos ya pelados; sobrevivió `957EL`). Dos importadores de
> los proveedores chinos: **Chef** (Ownland, Kangli, Fujian, Frontier) y **Tierra Nativa SA** (Becky,
> Hugo Wong, Zhixin) — es otra empresa, NO Loeke. El importador está en `Importados.proveedor`.
> **(1) v9.20 — picking pela la L:** `pkStripL()` saca una `L` final pegada a dígito o `E` (`505L`,
> `438EL`, `957EL` → base), aplicado en `aggFrom` **antes** de `pkCodEmpresa`; así la empresa (LK/CH)
> la sigue poniendo el NP (438EL en NP Chef → `438E` → `438E CH`, misma góndola que hoy) y se tapa el
> `957EL` que caía en "sin planimetría" y **nunca descontaba stock**. `Equivalencias_Codigos` sigue con
> `438E→438E LK`, `809E→809E CH` (nativo Chef). **(2) Corrección de stock:** `437E CH` tenía **36 MC
> (×72 = 2.592 u)** mal en depósito `racks` → son **insumos** (Colador importado por Chef, se envasa
> x24). Movidas `racks→insumos` (2 movimientos `ajuste`). Backup `sql/backup_movimientos_437E_20260811.sql`.
> **(3) v9.21 — NC Loeke→Chef en Facturación:** cuando un cliente de Chef (NP 44xxx) compra un artículo
> **importado por Chef + home Loeke** (Coladores `437E/438E/439E`), al facturarlo por Chef hay que hacer
> **NC a Loeke y pasar el stock a Chef**. Tabla `NC_Loeke_Chef_Hechas` (np,cod,confirmado_por; RLS: lee
> anon, escribe authenticated) + vista `vista_nc_loeke_chef` (pendientes, derivada del maestro:
> importado por Chef ∧ partido LK/CH ∧ home Loeke; excluye nativo-Chef `809E` y lo de Tierra Nativa
> `957E`; excluye las ya confirmadas). En el módulo Facturación, **una fila por NC pendiente**
> (NP·cód·artículo·cajas·RS) con botón **✓ "NC hecha"** (`facFetchNcChef`/`facRenderNc`/`facNcConfirm`,
> contenedor `#facNcList`). Es un **checklist aparte**: NO toca pedidos, cierre ni carga de camión.
> SQL en `sql/nc_loeke_chef.sql`. Bump `v9.21`.
>
> Nota: **v9.14 — PARTES importadas: la demanda sale de sus TERMINADOS + regla "SUPER".**
> Algunos códigos del maestro `Importados` **no son productos de venta sino PARTES** que se meten
> dentro de un terminado nacional; su proyección **no** puede salir de "ventas de la parte" (no se
> vende suelta) sino de la **SUMA de la proyección de los terminados que la usan**. Se formaliza con
> la tabla **`Importados_Partes_Map`** (`parte, terminado`, PK, RLS select anon + all authenticated)
> y la vista **`vista_importados_partes`** (`cod`=parte, `proy_uni_mes`=Σ proy de sus terminados,
> `detalle` jsonb con el aporte de cada terminado). Mapeo inicial: **`523C`** cremallera → 523
> (1.525) · **`1546903`** corta queso → 546 (5.655) · **`1000900`** espiral →
> 520,521,530,531,581,735,730,731,104 (6.160) · **`505C`** cuchilla → 505,586,099,713,123,114,186
> (**29.653**). El front (`ocgFetchImportados`) **pisa** la proyección de esas partes con la suma
> (objetivo = suma × meses(10)); en la OC salen con badge **🧩** y tooltip del detalle. **Ojo códigos:**
> el pelador es **099** (Pelapapas), NO 097 (Afila Cuchillo). **Regla "SUPER"** (equivalente
> primario/secundario *solo para super*): un código super (ej. **`505I`**) es el **mismo producto**
> que su base (**`505`**) pero es el código con el que los supermercados lo piden. Tabla
> **`Equivalencias_Super`** (`super_cod → base_cod`, +empresa/descripcion/nota; RLS igual que arriba)
> y vista **`vista_proyeccion_super`** = `proyeccion_madre` con el super **plegado** sobre su base
> (Σ). `vista_importados_partes` lee la proyección plegada, así que en el mapeo alcanza con poner el
> **base** (505) y el super suma solo. Hoy 505i no tenía proyección propia (no estaba en
> `proyeccion_madre`); al plegar sobre 505 la cuchilla queda en 29.653. Ambas views con
> **`security_invoker=on`** (advisors limpios). SQL en `sql/importados_partes_y_super.sql`. Bump `v9.14`.
>
> Nota: **OCs — consolidación de familias en el principal + discontinuos (2026-08-10, solo Supabase).**
> **`vista_generador_oc`** ahora **consolida la proyección de las familias de equivalentes en el
> PRINCIPAL**: en la CTE `proy`, cada código secundario (de `Equivalencias_Familia`) se remapea a su
> `cod_principal` y se **suma** su `proy` al del principal; el secundario queda con `proy=0`. Así el
> principal pide por **toda la familia** y el secundario deja de pedir por proyección. Además se puso
> **`activo=false`** en `OC_Maximos` a **todos los secundarios** de `Equivalencias_Familia` (el front y
> el cron sólo generan `activo=true`), para que tampoco pidan por capacidad/pedidos. Es **durable**: la
> consolidación pasa al LEER la vista, así que el sync mensual de `proyeccion_madre` (por código) no la
> revierte. Backup de la def anterior de la vista quedó en el historial (pg_get_viewdef). **Discontinuos
> sueltos** (no de familia): se pusieron `activo=false` en `OC_Maximos` a **618, 619, 724, 759**
> (652/771/957EL no existían en el sistema de OCs). Módulo "Completar datos producto" excluye la tabla
> **`Articulos_Discontinuados`** (15,75,563,396,456,517,556 + 029,030,828,830 reemplazados por 437E/438E).
>
> Nota: **v9.11/v9.12 — Circuito de IMPORTADOS (maestro `Importados` + OC por proveedor chino).**
> ⚠ **Ya existía** (desde 2026-07-16) todo el subsistema de importados, separado del generador
> nacional: **`Importados`** (maestro real, 147 códigos; cols `cod_art`, `marca`, `proveedor`,
> `uni_x_caja`, `principal`, `activo`, `est_madre_seed/override`, `pedido_manual`, `pedido_curso`),
> **`Importados_Config`** (`meses_objetivo` = **índice**, ahora **10**), **`Importados_Mov_Stock`**
> (stock **en unidades** event-sourced; `delta_uni`, `tipo='inicial'`) y la vista
> **`v_importados_ordenes`** (motor: `stock_actual` en unidades = mov − ventas×uni_x_caja desde el
> inicial; `est_madre_eff` = proyección madre live/seed; `meses_objetivo`). **Pantalla "Proveedor de
> importación"** (botón 🏭 en Administración, `stkOpenProvImp`): lee/escribe el **maestro `Importados`**
> vía la vista **`vista_prov_importacion`** (1 fila por `cod_art` activo; `cod, descripcion, marca,
> proveedor, n_prov, es_e`; GRANT SELECT anon). Al tocar el desplegable hace **PATCH `Importados.proveedor`**
> (todas las marcas del código; policy anon UPDATE `imp_upd_anon`). Proveedores reales: Fujian, Hugo
> Wong, Becky/Becky 1/Becky 2/Becky 1/2, Kangli, Ownland, Zhixin (= Stephen), Frontier. **García NO
> está** (reenvasa insumos, no importa). **OC de importados dentro de "Generar OCs"** (`ocgFetchImportados`
> + `ocBodyGenImportados`): sección al pie agrupada por proveedor chino; por `cod_art` suma marcas/plantas
> (principal=true) → objetivo = proy_u/mes × meses(10), a pedir en **unidades** y en **cajas** (÷ uni_x_caja).
> **Vista previa (solo lectura)**: la emisión de la OC al proveedor y la fórmula fina (stock por todos los
> estadios: góndola+racks+para_envasar+insumos, partes 94xP→94xE, etc.) **se afinan con más análisis**.
> ⚠ La tabla `Proveedores_Importacion` que se había creado (leía `OC_Maximos`, solo 93 E) fue
> **descartada** por redundante. Bump `v9.12`.
>
> Nota: **v8.96–v9.04 — Cajas Pedidas = toda la demanda real + módulo "NP que faltan".**
> **Demanda (`ocgDemanda`, columna "Cajas Pedidas" del stock):** dejó de contar solo las NP
> programadas en `PPP_Programacion_Diaria`; ahora arranca desde **TODA** la base de pedidos
> (`PPP_Base_Pedidos`, misma fuente que el pop-up) y solo descuenta las NP que **ya salieron**:
> **facturadas** (`Facturacion_NP`) + **entregadas** (`PPP_Entregados_Meta`) + **canceladas**
> (`NP_Canceladas`, ver abajo). Así la columna coincide con el pop-up de cajas pedidas.
> **⚠ (v8.97):** una celda de Cajas Pedidas muestra ⚠ cuando parte de su demanda viene de NP que
> están en la base pero **no** en Programación Diaria (`dem._sinProg`, no-enumerable; helper
> `_demSPOf`). **Módulo "NP que faltan" (v9.02, botón ⚠️ en la solapa Stocks):** lista esas NP
> (en la base, sin programar, sin facturar/entregar/cancelar) con **NP · Fecha · Razón Social ·
> Cajas** + valorizado (total de cajas) + export. Lee la vista **`vista_np_sin_programar`**
> (`PPP_Base_Pedidos` − prog − facturadas − entregadas − canceladas, agregada por NP). La operadora
> marca **🚫 "No va"** con motivo (cancelado/error/duplicado/bloqueado/ya salió/reemplazado/otro) →
> se guarda en **`NP_Canceladas`** (np PK, motivo, legajo, creado; RLS select+insert+delete anon) →
> la NP deja de contar, deja de disparar ⚠ y desaparece del módulo (refresca el stock al instante).
> **Columnas nuevas en `PPP_Base_Pedidos`:** `cliente` (razón social, col E del Excel) y `fecha`
> (col B), sincronizadas por la macro (Apps Script `_pppMapBasePedidos_` en "Carga PPP.gs") y por
> el import manual de la app (`pppMapBase`). **Otros (v8.92/8.95):** capacidad de góndola por marca
> en la tabla (códigos duales suman solo los sectores de su marca vía `PICK_UBIC_DUAL`); filtro
> `> 0` clickeable en TODOS los headers de columna (`_stk.filCol`); se sacó la tira de tarjetas de
> totales de arriba. Bump `APP_VERSION`/`SW_VERSION` `v9.04`.
>
> Nota: **v8.89 — Desconcatenación completa + fix lookups de capacidad/demanda.**
> En **toda la app** (stocks, racks admin, bajar a góndola, excedente, mover stock, conteo,
> salida Cervantes, ingreso racks, para envasar, qué bajar primero, abastecimiento, Excel export)
> el código de artículo ahora muestra el código base sin sufijo LK/CH (`codBase()`). **Lookups**:
> `_demOf()` y `_capOf()` con fallback al código base para que la demanda y la capacidad se
> encuentren correctamente aunque `dem`/`capByCod` estén indexados por código pelado y los saldos
> tengan sufijo. **Capacidad**: en la pantalla de capacidad de góndola, los sectores de códigos
> empresa-split (437E, 438E, 439E, 809E) se agrupan por marca con badges LK (rojo) / CH (azul)
> usando `PICK_UBIC_DUAL`. Picking y completar siguen mostrando el código sufijado (intencional:
> el operario necesita saber de qué marca es). Bump `APP_VERSION`/`SW_VERSION` `v8.89`.
>
> Nota: **v8.89 — Limpieza del código muerto de la idea 9849 (reparto proporcional).** Ahora que
> el reparto es automático y el Paso 1 del wizard "Completar" no existe más (v8.73/v8.74), se
> borraron todos los restos: **(a)** aviso "Preguntá a Marianela" — `#marianelaModal` (HTML),
> `.mar-*` (CSS), `showMarianelaAviso()` y `closeMarianela()` (JS); **(b)** Paso 1 del wizard —
> `#compStep1` (HTML), `_compRenderFalt()`, `_compFaltInput()`, `_compUpdateSec()`,
> `_compToggleMode()` y `let _compMode` (JS); **(c)** simplificaciones: `_compRecalc` ya no itera
> `_comp.arts` (todos son `auto:true`, sólo chequea que los líos estén cerrados); `compTerminar`
> sacó la validación de "Σasig ≤ falta" (el reparto Hamilton la garantiza por construcción);
> `_compGo` sacó las refs a `compStep1`/`compD1`; `_comp.step` arranca en `2` en lugar de `1`;
> comentarios viejos que mencionaban "Paso 1 faltantes" actualizados. **Nota histórica:** los
> comentarios del código dicen `v8.75 (idea 9849)` porque ahí se hizo el trabajo — el número
> saltó a `v8.89` durante los rebases sobre las versiones que aparecieron en `main` (v8.76–v8.88).
> **Verificado:** `checkhtml` (2 scripts, 0 errores), `dead-handlers` (487 handlers, 0 muertos —
> ningún `onclick=` colgado), y toda la suite `comp-*` (dif-nofantasma, doblearmado,
> entregas-prueba, pausar, terminar-unificado) pasa en verde.
>
> Nota: **v8.88 — Desconcatenación: código limpio en tabla de stock.**
> En la solapa **Stocks**, la columna CÓDIGO ahora muestra el código base (sin sufijo LK/CH/LOKE)
> para artículos que tienen marca concatenada en el código (`codBase()`). La columna **LK/CH** detecta
> la marca directamente del sufijo del código además de la OC (fallback `ocLinea()`). El filtro por
> línea (LK/CH) también funciona con códigos sufijados. Internamente los handlers (popups, detalle de
> movimientos, etc.) siguen usando el código completo con sufijo para que las búsquedas y los
> movimientos se resuelvan correctamente. Bump `APP_VERSION`/`SW_VERSION` `v8.88`.
>
> Nota: **v8.87 — Desconcatenación 43XE: limpieza pelado 437E + fix popup racks.**
> Se limpió el último residuo de stock legacy pelado de la familia 43XE: un ajuste
> compensatorio −36 en `racks_ch` del "437E" (duplicado de los 36 que ya estaban en
> "437E CH"). Ahora 437E, 438E y 439E tienen **cero stock pelado** — todo vive en LK/CH.
> Bug fix: el popup de movimientos de racks (click en la columna "Racks" de la tabla de stock)
> solo mostraba movimientos del depósito `racks`, pero la columna muestra `racks + racks_ch`
> (v7.54). Ahora incluye ambos y etiqueta los de `racks_ch` con chip "CH".
>
> Nota: **v8.85 — Góndola: mostrar quién pickeó en vez de "pipeline".** En el popup de
> movimientos por artículo (Stock → click en Góndola/Pickeados/etc.), los movimientos de
> picking/separado escritos por el cron `reconciliar_pipeline_stock` tenían `legajo='pipeline'`
> y mostraban "👤 pipeline · pipeline". Ahora `_stkQuienChip` detecta `legajo='pipeline'` y
> busca el legajo real del TP (Terminó Picking) o TAP (Terminó Armado) de esa tanda en
> `Registros_Produccion_Virgilio`. Se precargan en `stkOpenMovsArt` como `_stkPop._tpByTanda`
> / `_stkPop._tapByTanda`. Si no se encuentra el TP/TAP, no muestra nada (mejor vacío que
> "pipeline"). Idea 1851.
>
> Nota: **v8.84 — Alertas anómalas: NPs reales + detalle de pedido en PPP.** (1) Las tarjetas de
> alertas de pedidos web anómalos ahora muestran las **NPs reales** (ej. "NP 98360, 98361") en vez del
> `order_id` interno del Mayorista, cruzando `cod_cliente` con `PPP_Programacion_Diaria` (enriquecimiento
> en `pppRefreshAlertasWeb`, campo transitorio `a._nps`). (2) Click en el **N° Pedido** en la tabla PPP
> ahora **expande la fila** mostrando los productos del pedido (artículo + cajas) desde
> `PPP_Base_Pedidos`. Toggle click (abrir/cerrar). Cache local `_pppDetalleCache`. Funciones:
> `pppToggleDetalle(np)`, `pppFetchDetalle(np)`, `_pppDetalleHtml(items, np)`. CSS: `.ppp-np-link`,
> `.ppp-detalle-row`, `.ppp-detalle-tbl`, `.ppp-detalle-wrap`, `.ppp-detalle-load`.
>
> Nota: **v8.83 — Alertas pedidos web anómalos + código de 4 dígitos en Recepción.** (1) **Alertas
> pedidos web anómalos**: badge rojo con contador en el botón PPP (pulsa), banner con tarjetas dentro
> del overlay PPP con acciones "Revisado" / "Descartar", poll cada 2 min (`pppAlertPollStart`). Tabla
> Supabase **`Alertas_Pedidos_Web`** en Virgilio (`id`, `order_id`, `cod_cliente`, `cliente`,
> `total_pedido`, `total_historico`, `ratio`, `cajas`, `lineas`, `score`, `motivo`, `origen`, `estado`,
> `revisado_en`, `revisado_por`, `creado_en`). RLS: anon INSERT/SELECT/UPDATE. Trigger
> `trg_alerta_pedido_telegram` → `notificar_alerta_pedido_web()` → `tg_enqueue` al insertar alerta.
> Detección en Mayorista (`kwkclwhmoygunqmlegrg`): función `detectar_pedidos_anomalos()` cada 5 min
> (pg_cron), tabla `alertas_pedidos_log`. 4 señales: ratio vs histórico (>3x/5x/10x), units-as-boxes
> (>70%), cliente nuevo + pedido grande, cajas/línea > 30. Score >= 5 → POST a Virgilio. SQL referencia:
> `sql/alertas_pedidos_web.sql`. Funciones front: `pppFetchAlertasWeb`, `pppAlertBadgeUpdate`,
> `pppAlertBannerRender`, `pppAlertRevisar`, `pppRefreshAlertasWeb`. (2) **Código de 4 dígitos en
> Recepción de Mercadería**: se genera con `pendGenCodigo()` al momento del envío del operario
> (`opEnviar` en `recepcion.js`), se guarda en `Control_Modo_OP.codigo`, se muestra en pantalla de
> éxito. Evita colisiones consultando códigos del día.
>
> Nota: **v8.83 — Completar datos producto: módulos por categoría.** La pantalla 🚦 ahora agrupa
> los productos faltantes en 3 secciones: **📦 Artículos de venta (stock)** (códigos que existen en
> `vista_nombres_articulos` o `Articulos_Cajas`), **🔧 Insumos** (códigos que cruzan con la tabla
> `Insumos` vía campo `isis` o `cod`), y **❓ Otros** (códigos de ISIS que figuran en
> `PPP_Programacion_Diaria` pero no tienen registro en las tablas de Virgilio — con nota explicativa).
> Se fetchea `Insumos` (select=cod,isis,nombre,categoria) en paralelo con las otras tablas.
> Función `_dpRenderCard` extraída de `dpRender` para reutilización.
>
> Nota: **v8.82 — Completar datos producto (pantalla + badge semáforo).** Nuevo botón 🚦 en el menú
> de administración (entre "Consultar NP/Líos" y "Configuración") que detecta códigos de producto
> presentes en `PPP_Programacion_Diaria` pero con datos faltantes en una o más de estas tablas:
> **Articulos_Cajas** (empaque: descripción, marca, N° caja, uni×caja), **Volumen_Articulos** (m³),
> **Capacidad_Sector** (sector de góndola + cajas máx). El botón lleva un badge rojo con la cuenta de
> productos incompletos (se carga asíncronamente al login del supervisor). Al abrir la pantalla, lista
> cada código con un semáforo de 3 puntos (Cj/m³/Sc — verde=cargado, rojo=faltante). Tocando un código
> se despliega un formulario por sección faltante para cargar los datos directo a Supabase (POST
> autenticado). Tras guardar, la card se actualiza automáticamente. Funciones: `openDatosProducto`,
> `dpLoad`, `dpRender`, `dpBuildForm`, `dpSaveCajas`, `dpSaveVol`, `dpSaveCap`, `dpLoadBadge`.
> Overlay: `#datosProductoOverlay`. Cache 5 min (`_dpCache`). Se agregaron policies RLS
> `vol_art_insert_auth` + `vol_art_update_auth` en `Volumen_Articulos` para que supervisores
> autenticados puedan insertar/actualizar m³.
>
> Nota: **v8.80–v8.81 — Facturación: columna "Cajas" + limpieza de columnas.** (v8.80) Nueva columna
> **Cajas** a la derecha de Líos en la tabla "NPs a FC": muestra `sum(cajas_pedidas)` por NP desde
> `Entregas_Virgilio` (reutiliza `_facCajas`, sin query nueva). La columna Líos vuelve a mostrar
> **solo líos** (se quitó el caso especial que mostraba cajas para zona Súper). CSS `.fac-cajas-cell`
> en azul (`#0369a1`) para diferenciar del ámbar de Líos. (v8.81) Se eliminaron las columnas
> **Dirección, M3, Localidad y Zona** del módulo Facturación (sin uso). Los anchos se redistribuyeron
> en las columnas restantes. Columnas finales: **Tanda · Salida · NP · Cod · Razón Social · Faltantes
> · Cambiar cód · Líos · Cajas · Acción**.
>
> Nota: **v8.79 — Faltantes x día: se quitó la columna "🔴 Faltó armado" (pedido del usuario).** La
> tabla pasa de 10 a **9 columnas fijas**. El dato real (`realFalt`) **NO se borró**: se sigue usando
> en el resumen de arriba (chip "🔴 X faltaron al armar") y como **desempate del orden** (fabricante →
> realFalt → S1 → S2 → código). Solo desapareció la columna del cuerpo/thead y el drill `stkFaltDrillReal`
> quedó sin botón (la función sigue existiendo). Colspan del empty-row: `9 + (verDias ? 1+días+super : 0)`.
>
> Nota: **v8.78 — Faltantes x día (super): 2 ajustes.** (1) El día se DESDOBLA (Super | Clientes)
> **solo si hay faltante REAL de super ese día** en algún artículo visible: si el super está cubierto
> (faltante 0), la columna quedaba vacía al lado de la de clientes → sin sentido; ahora se muestra el
> día una sola vez. `superDiaSet` se recalcula **tras los filtros** desde `diasFaltSuper` (>0), no
> desde la demanda. (2) La **"S"** del thead superior ahora es **sticky con offset** (`tr:first-child`
> top:0, `tr:nth-child(2)` top:17px): antes las dos filas del thead quedaban en top:0 y la fila de
> días tapaba la "S" al scrollear ("al bajar se va la S").
>
> Nota: **v8.77 — Faltantes x día: días de SUPERMERCADO desdoblados (Super | Clientes).** En el
> detalle "📅 Ver días", un día que tiene demanda de **supermercado** ahora se muestra **dos veces**:
> una columna **Super** y otra **Clientes**, con una **"S"** en un row arriba (thead de 2 filas) sobre
> la columna de super. El marcador de supermercado sale de `PPP_Programacion_Diaria.zona = 'Super'`
> (se agregó `zona` al select del fetch; `npInfo[np].esSuper`, propagado a cada entry de `demanda`).
> El **reparto del stock disponible es "supermercado primero"**: cada día, el saldo cubre primero al
> super y lo que sobra va a clientes → `faltSuper = max(0, demSuper − disp)`,
> `dispTrasS = max(0, disp − demSuper)`, `faltCli = max(0, demCli − dispTrasS)`. Invariante:
> `faltSuper + faltCli === faltDia` (el total por día no cambia; S1/S2/Resto/Sin fecha intactos). Los
> días sin super se muestran una sola vez como siempre. `superDiaSet` marca qué fechas (día de armado)
> tienen super; `arts[].diasFaltSuper` / `diasFaltCli` guardan el split por día. Drill de ambas
> sub-celdas va al día completo (v1). CSS: `.falt-super-mark`.
>
> Nota: **v8.76 — Faltantes x día: defaults nuevos.** El estado `_stk.falt` arranca con los 3
> botones ACTIVOS por defecto: `soloQuiebre: true` (solo artículos que faltan), `sinE: true`
> (oculta importados sin nacional) y `verDias: true` (columnas por día). Y el orden por defecto
> es `ordenFab: true` → **1° Fabricante, 2° "Faltó armado"** (`realFalt` desc), que ya era la
> lógica de sort. Ambos paths de init (ok y catch) quedan consistentes.
>
> Nota: **v8.74 — Wizard "Completar": chip "1 Falt." fuera del stepper.** Coherencia visual con
> v8.73 (el Paso 1 desapareció del flujo). Ahora el stepper muestra sólo **1 Separar → 2 Líos**
> en vez de "1 Falt. · 2 Separar · 3 Líos". Cambios: se quitó el `<span id="compD1">1 Falt.</span>`
> y su `<span class="comp-line">` en `#completarModal .comp-dots`; se renumeraron los otros dos.
> `_compGo` pasó a chequear `compD1`/`compStep1` con `if (el)` para tolerar que ya no existan (los
> steps internos siguen usando los números 2/3 en el JS — sólo cambió lo que ve el operario).
>
> Nota: **v8.73 — Reparto de faltantes automático + adiós al Paso 1 del wizard "Completar" (idea 9849
> del usuario).** Cuando 2+ NPs pidieron el mismo artículo faltante y el picking agarró **algo pero no
> alcanza**, el operario del TAP **ya no decide** cuántas cajas van a cada NP: el sistema reparte
> **proporcional a lo pedido** (método **Hamilton / largest remainder**). Cada NP recibe
> `floor(pedida × real / total)`; el remanente (para que sume exactamente lo pickeado) se entrega de
> a 1 a las NPs con mayor resto decimal. **Desempate de resto** → NP con **más cajas totales pedidas
> en la tanda** (así el caso "NP1 pide 1, NP2 pide 1, pickearon 1 sola" va al pedido más grande); si
> aún empata, NP numérica más baja. Ej. NP1=10, NP2=5, NP3=3, real=16 → **9 / 4 / 3**. Los otros dos
> casos automáticos siguen igual (1 sola NP → todo a esa NP; agarraron 0 → a cada NP le faltó lo que
> pidió). Implementación: nueva `_compAsigProporcional(anps, real, totalByNp)` (usa `totalByNp` armado
> desde `pickBase` al abrir el wizard); todos los `arts` quedan `auto: true`; `showCompletarWizard`
> arranca en `_compGo(2)` (Separar) y al retomar hace `Math.max(step, 2)` — el Paso 1 (reparto manual)
> queda inalcanzable. `_compNav` no baja del Paso 2 y el `←` queda deshabilitado allí. El aviso
> "Preguntá a Marianela" del AP ya venía sin uso (código huérfano: función definida, cero llamadas).
>
> Nota: **v8.70 — Buscador de "Trazar artículo" (Órdenes de Compra) igual al de Stocks/Faltantes.**
> El input pasó a `type="text" inputmode="numeric" enterkeyhint="search" autocomplete="off"` (teclado
> numérico, no te saca del campo — `ocRender` ya usa `_renderKeepFocus`). Y el match se hizo
> **tolerante a la E**: como el teclado numérico no tipea "E", el filtro compara por BASE del código
> (normalizado sin la E final), así "437" encuentra "437E" (helper `_base` en `ocBodyTrazar`).
>
> Nota: **v8.69 — Monitor / Análisis / Inconsistencias = un solo botón.** En el home quedó un
> único botón **"Monitor / Análisis / Inconsistencias"** (`openMonitor`, abre por defecto la
> pestaña Monitor). Inconsistencias dejó de ser botón aparte: ahora es la **tercera pestaña** del
> `mod-switch` (junto a Monitor y Análisis), en ambos headers (`#monTabSwitch` y `#anTabSwitch`).
> `setMonitorTab` resalta la pestaña activa; `switchToIncons()` cambia de vista sin re-abrir si el
> monitor ya está abierto. Las pestañas se achican y reparten a lo ancho en celular (≤560px) para
> que las 3 entren sin encimarse. `openInconsistencias` sigue existiendo (lo usa la pestaña).
>
> Nota: **v8.68 — Reorganización del menú del supervisor + hub "Configuración".** (1) Nuevo botón
> **⚙️ Configuración** (`openConfiguracion`, modal `#configOverlay`) que agrupa lo que antes eran
> botones sueltos: **Cola de impresión, Mails autorizados, Editar Planimetría, Talleristas de
> Recepción** y el **toggle "Aviso Telegram stock en negativo"**. Los botones del hub cierran
> Configuración antes de abrir (`cfgGo`) porque la cola de impresión usa z-index bajo (210) y
> quedaría tapada. (2) **Fix del toggle Telegram**: `loadSsgSwitch()` solo se llamaba en modo
> kiosko → al supervisor logueado le quedaba "Cargando…". Ahora se llama al abrir Configuración.
> (3) Botón **"Corregir códigos" → "Corregir códigos de NPs"**. (4) Botón **"Faltantes" quitado**
> (esos datos ya están en Supabase y en Consultar NP/Líos; `openFaltantes` queda como código muerto).
>
> Nota: **v8.67 — Header del Monitor/Inconsistencias en celular angosto (fix de layout).** En
> pantallas ≤560px el header se encimaba (pestañas Monitor/Análisis, título, reloj, "Cerrar", stats
> y buscador se pisaban y se cortaban a la derecha). Ahora se apila en renglones: fila 1 = reloj +
> Cerrar; después pestañas, título (`Inconsistencias · al día · WxH · próx`), stats y buscador a lo
> ancho. Solo CSS (nuevo `@media (max-width:560px)` sobre `.monitor-header`); no toca el modo TV.
>
> Nota: **v8.66 — "Completar Pedido — faltante que llegó" (panel `showFaltAvisar`): solo faltantes
> con stock para completar.** Antes listaba TODO faltante sin facturar; ahora solo aparece una NP si
> el artículo tiene stock disponible en **góndola (`terminado`) / a guardar (`a_guardar`) / excedente
> (`excedente`) / racks (`racks`)** (`separar_pedidos`/`a_facturar` NO cuentan, ya están comprometidos).
> Si no hay con qué completarlo, no se muestra (no tiene sentido "Cargar yo"/"Avisar"). Se trae
> `stockFetchSaldos()` en el panel y se filtra por artículo en `faltAvRender` (helper `_dispAv`).
>
> Nota: **v8.65 — Conteo cíclico de góndola (CG): cruce confiable (timing).** El CG ya estaba completo
> (front pide contar 1 artículo random durante el picking + trigger `trg_conteo_gondola_telegram`
> compara vs góndola del sistema y avisa por Telegram "dio igual / X de diferencia"). Fix del timing
> (contar antes/después de sacar daba falsos): (1) la tarjeta aclara **"contala ANTES de empezar a
> sacar de esa celda"**; (2) se elige preferentemente un artículo **todavía no pickeado** en la tanda
> (`pkPickConteo`); (3) **snapshot** de la góndola del sistema al mostrar la tarjeta (pre-picking),
> mandado como 3er campo del evento `CG` (`COD|contado|sistema`, `_pkConteoSistema`/`pkEmitConteo`) →
> el trigger usa ese snapshot si vino (así el TP a mitad no ensucia el cruce). Backup del trigger
> previo en `sql/backup_notificar_conteo_gondola_20260810.sql`.
>
> Nota: **v8.59–v8.64 — Batch de mejoras a otros módulos.**
>
> Nota: **v8.59–v8.64 — Batch de mejoras a otros módulos.** (v8.59) Cola de impresión: estado
> "última revisión / sin conexión" + botón "Revisar ahora" (`psPoll(force)`). (v8.60) Recepción
> (`recepcion.js`): aviso en vivo si las cajas tipeadas superan lo que falta por OC (`_opCajasExceso`).
> (v8.61) PPP: banner de pedidos que salieron en fecha ≠ a la programada (reusa `_pppDelivered.discrep`).
> (v8.62) Capacidad: panel de discontinuados que ocupan góndola (`activo=false` en OC_Maximos).
> (v8.63) Insumos: aviso de insumos con varias unidades sin factor (`_stkInsMezclaUni`). (v8.64)
> Completar Pedido: colapsable de faltantes huérfanos (>21 días) que se caen del CP.
> **Pendiente (necesita decisión/clarificación):** semáforo de camión en Monitor (no hay campo de
> "camión" en la data), alertas Telegram por cron (PPP entrega-hoy-sin-armar, watchdog de impresión),
> y capturar el conteo CT (toca un toggle sensible).
>
> Nota: **v8.58 — Facturación: se saca el badge "🧾 Facturá X (no pelado)" de abajo de Razón Social.**
>
> Nota: **v8.58 — Facturación: se saca el badge "🧾 Facturá X (no pelado)" de abajo de Razón Social.**
> El aviso de equivalencia (`_facEquiv`/`vista_pedidos_equivalencia`, pelado→código de empresa) se
> quitó de la celda de razón social **por decisión del usuario** (queda solo el badge de tarea activa).
> Ojo: NO se solapa con la columna "Cambiar cód" (secundario→principal, `Equivalencias_Familia`) —
> son tablas distintas. Los códigos pelado→empresa (438E→438E LK, 809E→809E CH, 437E→437E LK,
> 439E→439E LK) quedan **sin aviso** a propósito. Los que SÍ eran secundario→principal (029→437E,
> 030→438E) se **migraron** de `Equivalencias_Codigos` a `Equivalencias_Familia` (backup en
> `sql/backup_equivalencias_029_030_20260809.sql`) → los toma "Cambiar cód". (`facFetchEquiv` sigue
> cargando pero ya no se muestra.)
>
> Nota: **v8.57 — Faltantes x día: se saca la columna "⚠ Cambio NP".**
>
> Nota: **v8.56 — Faltantes x día: las columnas de día vuelven, detrás de "📅 Ver días".** En v8.51 se
> habían quitado (scroll lateral). Ahora hay un toggle **📅 Ver días** (`stkFaltVerDias` / `F.verDias`,
> apagado por defecto): apagado = tabla angosta sin scroll; encendido = agrega el separador + las
> columnas de cada día (como antes). Colspan y header/celdas condicionados a `F.verDias`.
>
> Nota: **v8.55 — Capacidad: "Libre" fuera + sectores colapsados + fix de códigos sin E (datos).**
> (1) En la solapa **Capacidad**, `cod='Libre'` (posiciones de góndola vacías) ya **no** se cuenta como
> artículo (se excluye del armado y del flag "sin proyección/máximo"). (2) La columna **Sectores** se
> **colapsa**: si hay >3 ubicaciones muestra las 2 primeras + "+N ubic." y se ensancha al tocar
> (`stkCapToggleSec` / `_stk.capExp`) — antes la tabla quedaba anchísima. (3) **Datos** (`Capacidad_Sector`,
> con backup en `sql/backup_capacidad_sector_20260809_codigos_sinE.sql`): renombrados los códigos mal
> escritos (les faltaba la E) → **102→102E, 106→106E, 124→124E, 439→439E, 877→877E**. Pendiente aparte:
> **592E** es discontinuo (tiene lugar en góndola sin proyección — decidir si se libera el sector).
>
> Nota: **v8.54 — Stock: se saca la pestaña "📦 A Separar" (tab `proceso`).** Quitada de la barra de
> pestañas del módulo Stock y Compras. `stkBodyProceso` queda en el código pero sin acceso por UI.
>
> Nota: **v8.53 — Stocks: la tarjeta "Horas de guardado" se ajusta al contenido.** El panel verde/rojo
> tenía ancho completo (llegaba al fondo al pedo); ahora `width:fit-content` → solo ocupa lo que mide su
> contenido.
>
> Nota: **v8.52 — Stocks: filtro LK/CH · búsqueda multi-código · fijar códigos · backlog capacity-aware.**
> (1) **Filtro LK / CH** (`_stk.filLinea`, por `ocLinea`/OC_Maximos.linea). (2) El buscador acepta
> **varios códigos** a la vez (separá con espacio o coma → OR-match; se sacó el `maxlength`). (3) **📌
> Fijar** códigos: pin por fila (persistente en `localStorage` `stk_pins_vir`) + botón **📌 Fijados**
> para ver solo esos (`_stk.pins`/`_stk.soloPin`). (4) La tarjeta **"Horas de guardado pendientes"**
> ahora cuenta **solo lo que entra en góndola** (misma lógica que "¿Qué bajar primero?"): por artículo
> hueco = min(capacidad, capacidad−góndola); a guardar suelto + racks por master caja (`cxm`, cargado
> en `_stk.cxm` vía `rkbFetchCxM`). Antes contaba todo el a_guardar/racks → horas infladas. El botón
> "Incluir racks" ya no se aleja al pedo (se sacó el `flex:1`).
>
> Nota: **v8.51 — Faltantes x día: sin scroll lateral + orden por fabricante por defecto.** (1) Se
> quitaron las **columnas de día** (eran ~15 y generaban el scroll horizontal): la tabla ahora entra
> sin scroll lateral. El detalle por franja sigue en los pop-ups de **Falt S1 / S2 / Resto / Sin fecha**
> (clickeables). (2) El módulo arranca **ordenado por fabricante** (`_stk.falt.ordenFab = true` por
> defecto; el botón "Fabricante" lo alterna).
>
> Nota: **v8.50 — "¿Qué bajar primero?": switch "Ver todo".** Toggle `gordenVerTodo` (`_gorden.verTodo`):
> por defecto muestra **solo lo que entra ahora** (Cajas a bajar > 0); al activarlo muestra **todo** lo
> que tiene stock para guardar aunque la góndola esté llena (Cajas a bajar = 0). Filtro en `_gordenRows`.
>
> Nota: **v8.49 — "¿Qué bajar primero?": columna "Hay p/ guardar" (disponible).** Además de "Cajas a
> bajar" (lo que entra hasta el máximo) ahora se ve **cuánto HAY** para guardar en el origen del filtro
> (`_gordenDisp`: a guardar / excedente / racks / suma en "todos"). Columna nueva **Hay p/ guardar** +
> chip **📥 Hay para guardar: N** + total al pie (y en el impreso). El filtro ahora muestra todo lo que
> tiene stock en el origen (`disp > 0`), aunque no entre nada ahora — esos aparecen abajo con "Cajas a
> bajar = 0 · góndola llena".
>
> Nota: **v8.48 — "¿Qué bajar primero?": total + hueco topado + s/master.** (1) **Total** de lo que hay
> para bajar: chips arriba (📦 total cajas · N códigos · 🏗 master cajas) + fila TOTAL al pie de la
> tabla (y en el impreso). (2) El **hueco se topa a la capacidad**: si la góndola quedó **negativa**
> (error de stock), `cap − gond` inflaba las "cajas a bajar" por encima del máximo — ahora se limita a
> la capacidad (ej. 566E góndola −29, máx 90 → hueco 90, no 119). (3) Los códigos de racks **sin master
> cargado** en `Racks_Planimetria` (cxm=0) se marcan **"· s/master"** — por eso no muestran master
> cajas (se bajan 1:1). Para que muestre MC hay que cargarles la planimetría.
>
> Nota: **v8.47 — "¿Qué bajar primero?" también en Administración.** Se agregó el botón 📋 **Qué bajar
> primero** en Administración → Reportes y configuración (`showGuardarOrden('')`), además del acceso del
> operario en el chooser "Bajar a góndola". Así el supervisor puede verlo/imprimirlo directo.
>
> Nota: **v8.46 — "¿Qué bajar primero?": filtros + tabla imprimible + regla de master caja.**
> El módulo `showGuardarOrden` ahora: (1) arranca en **Todos** (junta racks + a guardar + excedente,
> ordenado por góndola más vacía) y tiene pestañas para ver **solo un origen** (Racks / A guardar /
> Excedente). (2) Tabla con formato **Cód · Descripción · Cajas a bajar · Góndola · Máximo** +
> botón **🖨 Imprimir** (`gordenPrint` abre ventana con la tabla y `print()`). (3) **Cajas a bajar** =
> lo que entra hasta el máximo (`capacidad − góndola`); de **racks** se baja por **master caja entera**
> (`cxm` = inner cajas por master, de `Racks_Planimetria` vía `rkbFetchCxM`): si el hueco no alcanza
> para 1 master, ese código **no aparece** (ej. góndola 89/100, master de 12 → 0). En 'Todos' el hueco
> se llena primero con a guardar, después excedente, y el resto con racks (por master).
>
> Nota: **v8.45 — Operaria: "¿Qué bajar primero?" + Stocks: menos botones.** (1) En el chooser
> **"📥 Bajar a góndola"** (`showMGChooser`) hay un botón nuevo **📋 ¿Qué conviene bajar primero?**
> → `showGuardarOrden`: overview de solo-lectura que junta las 3 fuentes (a guardar + excedente +
> racks/racks_ch) y las ordena por **góndola más vacía** (stock góndola ÷ capacidad de
> `Capacidad_Sector`). Cada fila: código, % lleno (color) y badges de lo que espera (📦 a guardar ·
> 📦 excedente · 🏗 racks). (2) En la solapa **Stocks** se sacaron los botones "Pedidos por estadio",
> "Movimientos de góndola" e "Historial" del toolbar (quedan Crear código y Descargar Excel).
>
> Nota: **v8.44 — Stocks: barra compacta · Corregir códigos: contar NPs.** (1) En la solapa **Stocks**
> el buscador se achicó a ~5 dígitos (`width:96px`, `maxlength=5`, placeholder "🔎 cód") y **E ·
> 🔴 Negativos · ⚠ Stock bajo** entran todos en **una sola fila**. (2) **Corregir códigos**
> (`facCorreccRender`/`facCorreccRefreshCount`): las pestañas y el chip ahora cuentan **NPs distintas**
> (unidad de acción — se cambia una vez por NP en el ERP), no ítems. Ej.: 67 ítems en código secundario
> = **50 NPs** a corregir.
>
> Nota: **v8.43 — Insumos: botón "＋ unidad" en la edición inline (para la 3ª unidad o más).**
> En la fila de edición por categoría, a la derecha de Guardar/Cancelar, hay un **＋ unidad** que abre
> el editor multi-unidad (`stkInsEditFact(cod, true)` → `_stkInsFactRow`) **sembrado con lo que ya
> cargaste inline**: base = unidad primaria, + las unidades ya guardadas, + la secundaria del renglón,
> + una fila en blanco para la nueva. Así el caso normal (base + 1 secundaria) se hace inline y, si
> hace falta una 3ª, se agrega sin perder lo tipeado. La ⚖ de la lista "Todos" sigue igual (arranca
> desde los factores guardados: `stkInsEditFact(cod)` sin el flag).
>
> Nota: **v8.42 — Insumos: se saca la ⚖ de la lista por categoría (la edición inline alcanza).**
> En la lista **por categoría** (`_stkInsListado`) la edición inline de Cant secundaria / Unidad /
> Factor (v8.35) ya cubre definir la unidad secundaria + factor, así que el botón **⚖** (editor
> `stkInsEditFact`/`_stkInsFactRow`) se quitó de las filas (lectura y edición) — menos ruido. La ⚖
> sigue disponible en la lista **"Todos"** (buscador global) como editor avanzado para insumos con
> 3+ unidades / elegir la base (esa lista no tiene la edición inline de secundaria/factor).
>
> Nota: **v8.41 — Insumos: saldo del operario FACTOR-AWARE (cierra el descuadre por unidades).**
> El catálogo del operario (RI/EI) mostraba el saldo desde `_insStockForUnit`, que era por-unidad:
> tras consolidar en base (v8.40), pedir en "Caja" veía **0** aunque hubiera stock en la base "Uni".
> Ahora `_insStockForUnit` es factor-aware: si el insumo tiene unidad base y la elegida tiene factor,
> devuelve el **saldo total en base ÷ factor** (helper nuevo `_insBaseTotal` suma el desglose por
> unidad × factor). El pop-up muestra las **equivalencias** (`insEquivStr`) para insumos con factores
> (mismo stock en todas las unidades) en vez de un split que suma distinto. Además incluye insumos con
> saldo por-unidad aunque la suma cruda de `vista_saldos_stock.insumos` dé 0 (ej. +10 Caja/−10 Uni).
> Cierra el hallazgo Punto 2/3 de `guardian-stock`. (Pendiente aparte: insumos SIN factores cargados
> en varias unidades siguen sumando mal en esa vista — se resuelve definiéndoles factores.)
>
> Nota: **v8.40 — Guardar a góndola por PRIORIDAD + Faltantes buscador numérico + Insumos consolidan.**
> (1) **Guardar a góndola (MG, `showMGModal`/`mgRender`)**: la lista se ordena por **prioridad** =
> góndola más vacía primero (`terminado ÷ capacidad`, capacidad de `ocgFetchCapacidad`/`Capacidad_Sector`);
> sin capacidad cargada → al final. Cada fila muestra un chip **🛒 Góndola G/C · faltan X** (rojo/ámbar/
> verde según qué tan vacía) para que el operario sepa qué bajar primero. (2) **Faltantes x día**: el
> buscador ahora es `inputmode="numeric" enterkeyhint="search"` (igual al de Stocks) — teclado numérico
> y sin perder el foco al tipear. (3) **Insumos**: `_stkInsAjustar` ahora **consolida** en la unidad
> base — al guardar cero-ea las unidades no-base (con factor conocido) y deja UNA sola línea base.
> Cierra el hallazgo de `guardian-stock` sobre v8.39: evita "fantasmas" por-unidad y el descuadre de
> `vista_saldos_stock.insumos` (que suma crudo distintas unidades). Stock-neutral en base.
>
> Nota: **v8.39 — Insumos (Paso 2): al guardar cantidad, el asiento va en la unidad BASE.** Antes el
> movimiento de stock se guardaba en la unidad elegida y el display convertía. Ahora, si el insumo
> tiene unidad base definida y la unidad elegida tiene factor conocido, `_stkInsAjustar` **convierte
> la cantidad a base** (`qNueva × factor`) y registra el ajuste en la unidad base → el stock se
> acumula SIEMPRE en una sola unidad (cierra el anti-duplicado al cargar en varias). Además el ajuste
> se calcula contra el **saldo TOTAL en base** (`insSaldoBase`), no contra `xuni[0]` — antes, con
> stock repartido en varias unidades, el ajuste comparaba mal (bug latente corregido). Si el insumo
> no tiene factores o la unidad no tiene factor conocido, sigue el comportamiento clásico (asiento en
> la unidad elegida). Es append-only y stock-neutral (el neto en base cambia exactamente lo pedido).
>
> Nota: **v8.38 — Faltantes x día: columna "Sin fecha" + ocultar discontinuos.** (1) Nueva columna
> **Sin fecha** (entre Resto y Cambio NP): faltante de pedidos SIN `fecha_entrega` PPP (o con fecha ya
> pasada) que el stock no cubre — antes eran **invisibles** (consumían stock pero no caían en ninguna
> columna de día). Ahora **Falt S1 + Falt S2 + Resto + Sin fecha = Total Pedidos − Stock** (todo el
> faltante queda a la vista). Se calcula como `Math.max(0, -bal)` (bal = stock − sinFecha − demanda
> pasada). Clickeable → drill `stkFaltDrillSinF` (kind `"sinf"` en `_faltDrillOpen`) con las NPs sin
> fecha/pasadas, editables (achicar cajas). Ej. real 395: Total 59 − Stock 30 = 29 = S1 8 + S2 6 +
> Resto 1 + **Sin fecha 14** (las 14 eran las que "no se veían"). (2) Los códigos **discontinuos**
> (`activo=false` en `OC_Maximos`) ya **no aparecen** en Faltantes: `stkFaltLoad` trae el set
> `discont` y `stkBodyFaltante` saltea la familia si TODOS sus miembros están discontinuados
> (ej. 396/556/573/597/438EZ).
>
> Nota: **v8.37 — Faltantes x día: "Total Pedidos" clickeable → pedidos con franja.** La celda
> **Total Pedidos** ahora abre un drill (`stkFaltDrillPed` → `_faltDrillOpen` kind `"ped"`) con la
> tabla de cada NP que compone el total: **NP · Cód cli · Razón social · Cajas · Fecha PPP · Estado
> (siempre "Sin pickear", por construcción el total solo cuenta la demanda proyectada) · Franja**.
> La **franja** (`_faltFranja`) sale de la fecha de SALIDA (PPP): `S1`/`S2`/`Resto`/`pasada`/`sin
> fecha`, mismas ventanas que Falt S1/S2. Así se ve por qué el total no cae siempre en S1/S2/Resto:
> los pedidos **sin fecha** o con fecha **pasada** consumen stock pero no aparecen en las columnas de
> semana. `stkFaltLoad` ahora trae `PPP_Programacion_Diaria.cod` (Cód cliente) → `npInfo[np].cliente`
> → cada entry de `demanda`. La `.falt-drill.wide` (max 560px) usa `.falt-ped-tbl`.
>
> Nota: **v8.35 — Insumos admin: editar factores en la fila "Editar" + UX.** (1) En **Editar** ahora
> se cargan **Cant secundaria / Unidad secundaria / Factor** directo (sin entrar al ⚖): `stkInsAutoSec`
> autocompleta — cargás Cant sec O Factor y el otro se llena (primaria = secundaria × factor; primaria
> = qty base). Al guardar, `stkInsGuardar` graba los factores (base = unidad del qty). El ⚖ queda para
> multi-unidad. (2) **"Pendientes de identificar" no aparece si es 0.** (3) **Todas las secciones del
> admin arrancan CERRADAS** (`abre` default cerrado; `_stkAbierta`=== true). (v8.34: Excel entregados
> con salida real + PPP; headers sticky en la planilla por categoría.)
>
> Nota: **v8.33 — "Pedidos Entregados": la fecha de salida sale de CARGA CAMIÓN (CCN), default PPP.**
> El bug del sábado era que la fecha venía de `Facturacion_Cierres.fecha_reparto` (= cierre+1, la
> escribía la app; v8.32 le puso weekend-skip). Ahora `vista_ppp_pedidos_entregados` expone
> **`fecha_carga`** (día del CCN, `Registros...opcion='CCN'`, texto=NP|TANDA, en tz AR) y **`fecha_ppp`**
> (fecha_entrega de la PPP). El front usa `frep = fecha_carga || fecha_ppp || fecha_salida ||
> facturado_at` → **la que vale es carga camión; default la PPP**. Si carga ≠ PPP, marca
> **"⚠ PPP decía DD/MM"** en el pedido + contador arriba (para detectar PPP mal cargadas). **Ya no usa
> `fecha_reparto`** → los 15 cierres viejos con reparto sábado se muestran solos en su fecha real, sin
> migrar datos. (v8.31: planilla Insumos por categoría con columnas Cód/ISIS/Detalle/Ubic/Primaria/
> Secundaria/Factor.)
>
> Nota: **v8.30 — Insumos: fix guardado (isis) + editor ⚖ rediseñado (más claro).**
> (1) **Bug**: `insumo_editar` fallaba con "malformed array literal: 'isis'" (append de literal a
> `text[]`); se pasó a `array_append(...)` en todos los cambios. (2) **Editor de factores** rediseñado:
> se elige la **unidad base arriba una sola vez** y cada equivalencia se lee natural **"1 MC = 240 Uni"**
> (+ ejemplo). Estado `_stkIns.factBase` + `_stkIns.factEq` (antes `factRows` con radios, confuso).
> (v8.29: el editor ⚖ no abría fuera de "Todos" → extraído a `_stkInsFactRow` y usado en las dos listas.)
>
> Nota: **v8.28 — Insumos: código `isis` (del sistema) separado del `cod` conocido.** Columna nueva
> `Insumos.isis` (informativa); el `cod` conocido **sigue siendo la clave del stock**. Se edita en el
> form (input "isis (sistema)" bajo el código) y se muestra como sub-línea "isis: …". RPC
> `insumo_editar` ahora acepta `p_isis` (marcador `__sin__` para vaciarlo). (v8.27: admin Insumos sin
> el banner, "Unidades" abajo de "Todos", botón ⚖ también en edición.)
>
> Nota: **v8.26 — Insumos: unidades con FACTOR de conversión (mismo stock, distinta forma).**
> Varias unidades = el mismo stock (no se suman). Cada insumo elige su **base** (la más chica) y
> define cuántas base hay en 1 de cada otra (ej. 1 MC = 240 uni). Tabla `Insumos_Factores` +
> RPC `insumo_factores_guardar` (ver `sql/insumos_factores.sql`). Frontend: editor **⚖** por insumo
> (`stkInsEditFact`) y **display de equivalencias** en "Todos los insumos" (ej. "480 uni · 2 MC").
> **PENDIENTE (paso 2):** al guardar cantidad, convertir a la base y registrar el movimiento en
> base (hoy se guarda en la unidad elegida; el display convierte lo existente). (v8.25: carteles
> verde/rojo de Corregir códigos abreviados.)
>
> Nota: **v8.24 — Faltantes x día: orden por fabricante + separador visual.** (1) El header
> **"Fabricante" es clickeable** (`stkFaltOrdenFab` / `F.ordenFab`): alterna orden por fabricante
> (agrupado, "sin fabricante" al final) ↔ por urgencia (default: real → S1 → S2 → código); marca ▾.
> (2) **Columna separadora** (`.falt-sep`, 14px gris) entre las 4 columnas de resumen (Faltó armado/
> S1/S2/Resto/Cambio NP) y las columnas de día, para despegar visualmente resumen de proyección diaria.
>
> Nota: **v8.23 — Faltantes x día: columna "Total Pedidos" + el pop-up ACHICA cajas (no anula NP).**
> (1) Nueva columna **Total Pedidos** a la derecha de Stock (= `totalDem`, demanda pendiente).
> (2) El pop-up ya **no excluye la NP entera** con un checkbox; ahora tiene un **input de cajas por NP**
> ("15 / 20 cj" = van 15 de 20 pedidas) porque el operador no anula la entrega, la achica. Estado
> `F.ajustes[np|famKey]` = cajas reales (reemplaza `excluidos`); la agregación aplica `_cjEff(e)`
> (escala proporcional por si el NP tiene varias entries). `stkFaltSetCajas(np,key,val,orig)` +
> `stkFaltResetSim` limpian/ajustan. Poner 0 = de hecho excluye.
>
> Nota SERVER: **Generador OCs — 55289 Colador = proveedor "Log/ Fabr"; se filtran códigos que no
> empiezan con dígito** (GASTOTRRECH/TRANSFRECH: filas contables). Con esto + L/546E, "sin proveedor"
> quedó en **2 ítems** → luego **597 (discontinuo)** y **438EZ (no existe más)** se marcaron
> `activo=false` en OC_Maximos → **generador con 0 "sin proveedor"**.
>
> Nota SERVER (sin bump de app): **Generador de OCs — aglomerar códigos "L" en su base.**
> La `proyeccion_madre` trae, por cada código, un gemelo con sufijo **"L" = lo que Chef le vende
> de Loekemeyer a sus clientes** (ej. `505L`). Antes el generador los tomaba como productos
> aparte (uxb nulo → proy_cajas mal, y sin config → "(sin proveedor)"): eran 63 códigos ≈ 1.265
> cajas fantasma que inflaban la lista. Ahora `vista_generador_oc` (CTE `proy`) **strippea la "L"
> final y aglomera en el código base sumando UNIDADES / uni×caja del base** → el 505L cae dentro
> del 505 (se pide 505, nunca 505L). Efecto: "sin proveedor" bajó de **70 ítems/2.431 cj** a
> **6 ítems/521 cj**. Además **alias puntual 546E → 546**: el 546E NO existe como producto real
> (solo en la proyección; el 546 real tiene config "Log/ Fabr", stock y pedidos) → es el mismo 546,
> un typo de la proyección. Se mapea en el CTE `proy` (único caso "E fantasma"; la "E" NO se
> strippea en general porque 574E/809E/etc. sí existen). Con eso "sin proveedor" quedó en **5 ítems/
> 338 cj** (el grande real es 55289 Colador c/333 pedidos; el resto mínimos/contables).
> Backup del def original en `sql/backup_vista_generador_oc_20260809.sql`.
>
> Nota: **v8.21 — Faltantes x día: columna "Resto".** Nueva columna de resumen (entre Falt S2 y
> Cambio NP) que suma los faltantes diarios cuya SALIDA cae **más allá de la S2** (semana 3+),
> igual que el filtro "Resto". Clickeable (drill `key='resto'`). (v8.20: badge NP del pop-up sin
> fondo negro ni letra azul — `.falt-drill-row .falt-np` pisa el `.falt-np` global oscuro.)
>
> Nota: **v8.19 — Faltante: 3 fixes.** (1) **Pop-up NO aparecía**: `.falt-drill` estaba en
> `z-index:200` y el modal de Stock (`#stockAdminOverlay`) en `1280` → el pop-up se abría DETRÁS
> del modal. Subido a `z-index:1600`. (Era el motivo real de "no andan los popups".) (2) **Falt
> S1/S2 no cuadraba con los días**: usaba el déficit ACUMULADO (arrastraba saldo inicial + sinFecha)
> mientras las celdas de día son incrementales → ahora **Falt S1/S2 = SUMA de los faltantes diarios**
> de la ventana (por salida), reconcilia con lo que se ve por día. (3) Tab renombrado
> "Faltante" → **"Faltantes x día"**.
>
> Nota: **v8.18 — Faltante: header "Cambio NP" en dos filas · switch "Sin E" · familia 590E/548.**
> (1) Header ⚠ Cambio NP en dos líneas (ahorra ancho, como Faltó armado). (2) Switch **"Sin E"**
> (`stkFaltSinE` / `F.sinE`): oculta los códigos IMPORTADOS (E) que **no tienen equivalente
> nacional** para reponer — regla `_faltEsSoloE(a)`: si ningún miembro de la familia es nacional
> (no termina en E). Así mantiene 94xE (33x), 574E/574, **590E/548**, 809E CH/809; oculta los
> importados solos (727E, 363E, 367E, 809E LK, 437E/438E/439E, etc.). (3) Nueva familia **Pincel
> Silicona: 590E (importado, PRIMARIO) ↔ 548 (nacional, secundario)** en `EQUIV_FAMILIAS` y en la
> tabla server `Equivalencias_Familia` (empresa LK — solo descriptivo, la vista no lo usa; 590E se
> pide 63× LK vs 2× CH). Backup previo en `sql/backup_equivalencias_familia_20260809.sql`.
>
> Nota: **v8.17 — Faltante: columna "Fabricante" espeja el Generador de OCs.** Antes salía de
> `OC_Maximos` crudo (y quedaba vacía para muchos). Ahora `stkFaltLoad` la trae de
> `vista_generador_oc` (mismo dato que se ve en Generar OCs): proveedor real, ignora
> "(sin proveedor)"; si hay reparto a un 2° proveedor (pr2>0) muestra "P1 / P2". Nota: en esa
> vista el **580 figura "(sin proveedor)"** (su equivalente 580E = "Racks") → si se le quiere
> poner un fabricante, se asigna en el generador y aparece solo acá.
>
> Nota: **v8.16 — Faltante: popups clickeables en las columnas visibles (celular).** En el celular
> las columnas de día quedan scrolleadas a la derecha; las visibles (🔴 Faltó armado / Falt S1 /
> Falt S2) no abrían nada. Ahora las tres abren su drill: **Falt S1/S2** → NPs sin pickear con salida
> en esa ventana (con destildar-para-simular); **🔴 Faltó armado** → NPs/tandas que ya salieron
> cortas (read-only, muestra tanda y "faltó N"). Drill unificado en `_faltDrillOpen(cod, kind, key)`
> (kind day/win/real); re-apertura tras destildar por coords guardadas (no más matcheo por DOM).
> `stkFaltLoad` ahora guarda `realDet` (detalle {tanda,np,rs,cod,falto}). (v8.15: header "Faltó
> armado" en dos líneas.)
>
> Nota: **v8.14 — Faltante por día: separar "ya preparado" (real) de "aún no preparado" (proyección).**
> Antes el faltante era 100% conceptual (demanda PPP vs stock). Problema: si un pedido YA se pickeó,
> su stock se movió a `separar_pedidos` (fuera del total) pero **seguía contando como demanda** →
> **doble-conteo** (faltante inflado). Ahora, en `stkFaltLoad`, cada NP se clasifica por el estado
> de su TANDA (EP/TP): **sin pickear → proyección** (día a día vs stock); **en picking (EP sin TP)
> → fuera de la proyección**, se cuenta aparte (chip "⏳ N en picking"); **preparado (TP) → faltante
> REAL** = Σ(ESP−REAL) de los PKC = lo que el pickeador no encontró en el rack (dato, no pronóstico).
> Nueva columna **🔴 Faltó armado** (rojo sólido) + chip resumen "🔴 N faltaron al armar"; ordena
> primero por real. El real se suffija por empresa (`codEmpSplit`) y se combina por familia como el
> resto. Fuentes: `Registros_Produccion_Virgilio` opcion EP/TP (estado) y PKC `TANDA|COD|ESP|REAL`.
> "Real solo al cerrar el picking (TP)": en picking parcial NO cuenta como real hasta el TP.
>
> Nota: **v8.13 — Faltante por día: ocultar columnas de fin de semana.** Las columnas de día
> son el día de ARMADO, que nunca cae sábado ni domingo, así que una columna de finde siempre
> quedaba vacía. Nuevo helper `_faltEsHabil(ymd)` y `diasCols = diasCols.filter(_faltEsHabil)`
> → sáb/dom no se muestran (aplica a S1/S2/Todo; "Resto" ya venía de fechas de armado hábiles).
>
> Nota: **v8.12 — Faltante por día: celda = faltante del DÍA (no acumulado) + fix pop-up NPs.**
> Las columnas de día mostraban el **déficit acumulado corrido** (`balRun`): una vez negativo,
> arrastraba el faltante a todos los días siguientes (ej.: 395 mostraba 14 el 09/08, 14 el 10/08,
> 19 el 11/08 aunque no hubiera pedido nuevo esos días). Ahora cada celda muestra **solo lo que
> falta ESE día** = la parte de la demanda del día de armado que el saldo disponible no cubre;
> día sin demanda (o cubierto) → celda "—". Efecto secundario resuelto: como los números fantasma
> no tenían NPs reales en esa fecha, tocar la celda cerraba el drill sin mostrar nada → **ahora
> toda celda con número tiene NPs detrás y el pop-up aparece**. El resumen **Falt S1/S2 sigue
> usando el déficit ACUMULADO** (total de cajas que faltan por ventana de salida), sin cambios.
>
> Nota: **v8.11 (#1 completo) — separación por empresa en Faltante por día.**
> El módulo **Faltante por día** (`stkFaltLoad`/`stkBodyFaltante`) ahora keya la demanda con
> `codEmpSplit(it.art, np)`: los códigos split (437E/438E/439E/809E) se cuentan **suffijados
> por empresa** ("438E LK"/"438E CH", etc.), igual que el stock de `vista_saldos_stock` (que ya
> vive suffijado). Antes la demanda iba pelada contra stock suffijado → **faltantes falsos**.
> Ahora "438E LK" y "438E CH" son **dos filas** (mismo producto, distinta empresa). Se agregó
> la familia **Corta Queso (Chef)** `809E CH ↔ 809` a `EQUIV_FAMILIAS` (el 809 nacional se
> guarda **pelado**, Chef-only; el 809E de Chef suffijado) — agrupa sólo esos dos; el **809E LK**
> (cortapizza) queda solo. Fallback de fabricante en `provMap` que strippea el sufijo LK/CH.
> **Nota:** `EMPRESA_SPLIT_CODS` = { 437E, 438E, 439E, 809E } — el **809 NO** va (pelado).
> **RESUELTO (v8.87):** el stock pelado "colgado" **437E = 36 en `racks_ch`** era un **duplicado**
> del ajuste que ya estaba en 437E CH (ambos originados en la migración del 4/8). Se limpió con
> ajuste compensatorio −36 en `racks_ch` del pelado. Ahora **toda la familia 43XE** (437E, 438E,
> 439E) tiene **cero stock pelado** — todo vive en las variantes LK/CH.
> **809 pelado = 1 es CORRECTO** (nacional, Chef-only).
>
> Nota: **v8.02–v8.04 — mejoras faltantes + separación por empresa (parte).**
> **v8.02** Faltante por día: resumen arriba (en quiebre S1/S2, cajas, cambios NP), toggle
> "Solo quiebre", leyenda de colores, borde rojo en el primer día de quiebre.
> **v8.03** Facturación: botón "✓ Ya lo cambié" inline en la columna "Cambiar cód" (confirma
> los cambios de la NP sin abrir el panel). Módulo Faltantes (picking supervisor): tandas
> ordenadas por más faltante primero + magnitud coloreada.
> **v8.04 (#1 parte + #2):** `codEmpSplit(cod,np)` — resuelve los códigos de los paquetes
> importados (437E/438E/439E/809/809E) al **suffijado por empresa** ("438E LK"/"809E CH", etc.,
> la empresa la dice la NP). Aplicado en **Completar Pedido / Recepción** (`cpLoadFaltantes`):
> ahora completa/descuenta el bucket de stock correcto por empresa (+ aplica también la
> corrección secundario→principal, como el picking). El stock ya vivía suffijado (picking);
> antes CP escribía pelado y divergía. **#2 (familia 809 Chef):** en `Equivalencias_Familia`
> se agregó `809 (nacional) → 809E (importado)` empresa CH (809 es Chef-only) → un pedido de
> Chef al 809 aparece en Corregir códigos/Telegram y el picking levanta 809E al confirmar.
> **PENDIENTE:** suffijar también el faltante-por-día (para agrupar 809 CH↔809E CH ahí).
> ~~limpiar los buckets pelados legacy (ej. 437E=36)~~ → **HECHO en v8.87**.
>
> Nota: **v8.00 — Descuento de stock del picking INCREMENTAL (por PKC).**
>
> Nota: **v8.00 — Descuento de stock del picking INCREMENTAL (por PKC).** Antes el picking
> descontaba stock en lote, server-side, recién después del TP (cron cada 10'). Ahora baja por
> **cada artículo confirmado** (evento PKC). Diseño hacia adelante para no tocar la historia:
> marcador `Stock_Config('etapa1_pkc_desde')`; los pickings con actividad ≥ ese ts usan la ruta
> nueva (por artículo, excedente-primero, UPSERT por (tanda,art,depósito) → refleja re-picks),
> lo anterior queda con la lógica original (por tanda, gated en TP) intacto. Trigger
> `trg_pkc_reconciliar_stock` (AFTER INSERT OR UPDATE WHEN opcion='PKC') dispara `etapa1`; el
> trigger del TP y el cron cada 10' quedan de red de seguridad (siguen siendo el único escritor
> server-side; el cliente NO escribe picking desde v5.76). `anular_picking_virgilio()` ahora
> **devuelve el stock** (pone en 0 las filas 'picking' de la tanda) al anular antes del TP.
> Restore-point: `sql/backup_pipeline_stock_20260809.sql`. Diseño: `sql/picking_incremental_pkc.sql`.
>
> Nota: **v7.99 — Códigos IMPORTADOS por empresa: dos paquetes.**
>
> Nota: **v7.99 — Códigos IMPORTADOS por empresa: dos paquetes.** Se documenta y empieza a
> resolver el cruce por empresa (la empresa la dice la NP: >90000 = Loeke, si no Chef).
> **Paquete A — 437E / 438E / 439E (coladores):** MISMO producto en las dos empresas, pero
> **stock separado por empresa**. Importados por Chef, se venden Chef→Loeke listos para venta.
> En **Loeke**: stock en Racks + Góndola. En **Chef**: el mismo artículo arranca como **INSUMO**;
> para venderlo se descuenta el insumo (envío de insumos) y **vuelve como 438E listo para venta**
> (Góndola, o Racks si se envasa mucho). El nombre es el mismo en las dos → no hace falta nombre
> por empresa; sí separación de stock/ubicación (sufijo "438E LK"/"438E CH", vía pkCodEmpresa).
> **Paquete B — 809E:** MISMO código, **PRODUCTOS DISTINTOS** por empresa: Loeke = **Corta Pizza
> Familiar**, Chef = **Corta Queso**. No tienen nada que ver; solo comparten el número. Nunca deben
> mezclarse. → v7.99 agrega `NOMBRE_POR_EMPRESA` + `artNombreEmp(cod, np)` (index.html): para el
> 809E muestra el nombre correcto según la empresa de la NP. Aplicado en Completar Pedido y
> Recepción (donde el operario ve el nombre). **PENDIENTE:** separación de stock/empresa de punta
> a punta (Completar escribe stock suffijado, faltantes/facturación por empresa) y sacar la
> equivalencia fija 809E→809E CH (que hoy fuerza Chef siempre).
>
> Nota: **v7.91
>
> Nota: **v7.91 — Alerta Telegram por pedido a secundario + corrección por NP que el picking levanta.**
> **(A) Alerta Telegram:** tabla `Equivalencias_Familia` (secundario→principal, 13 familias, la misma
> lista curada que `EQUIV_FAMILIAS`) + trigger `trg_pedido_secundario_telegram` en `PPP_Base_Pedidos`
> (por statement, transition table `newrows`, dedup `sec_<np>_<cod>`, blindado): cuando entra un pedido
> a un código secundario, avisa al grupo Faltantes Virgilio (`tg_enqueue`/outbox). El backlog inicial
> (231 combos) se sembró como "ya avisado" para no spamear; solo avisa los nuevos. **(B) Corrección por
> NP:** tabla `Correcciones_Pedido` (np, cod_secundario, cod_principal, cajas, confirmado_por,
> confirmado_en; PK np+cod_secundario; RLS select+insert para la app) + vista `vista_pedidos_secundarios`
> (PPP_Base_Pedidos × Equivalencias_Familia). En Facturación (panel de la operadora) hay un chip
> **🔀 Corregir códigos (N)** → abre la lista de pedidos en secundario; cada uno con **✓ Ya lo cambié**
> (POST a Correcciones_Pedido, idempotente `ignore-duplicates`). El **picking** carga las correcciones
> (`fetchCorrecciones`) y en `aggFrom` (showPickingList) aplica `corrArt(art,np,corr)` antes de
> `pkCodEmpresa` → levanta el PRINCIPAL para esa NP sin esperar el resync del ERP. **PENDIENTE (2ª etapa):**
> descuento incremental de stock durante el picking (EP).
>
> Nota: **v7.90 — Familias de EQUIVALENTES (mismo producto, distinto SKU, MISMA empresa).**
> Constante curada `EQUIV_FAMILIAS` en `index.html` (13 familias, ⚠ NO incluye pares Loeke↔Chef,
> que se facturan por empresas distintas). Cada familia tiene un **principal** (`def`, el que se
> pide/manda/stockea) y **secundario(s)** (excepcionales o nacionales discontinuos). Helpers:
> `equivFam(cod)`, `equivFamKey(cod)` (= default normalizado, clave de agrupación), `equivMiembros(cod)`,
> `_equivDisp(fam,kn)`. **(A) Faltante por día:** los miembros se combinan en UNA fila → faltante REAL
> por familia (stock combinado, porque se cubre con cualquiera cambiando la NP). Nueva columna **⚠ Cambio
> NP** = cajas de demanda cargadas sobre secundarios (hay que corregir la NP al principal). El drill por
> día junta las NP de todos los miembros y muestra el SKU que pidió cada una. **(B) Ventana de stocks:**
> los equivalentes van **aledaños pero cada uno en su fila** (NO se fusionan): se ordenan por la posición
> del principal y, dentro, el principal primero (★ principal / ⇄principal en el secundario). **(C)
> Facturación (columna Faltantes):** si un ítem faltante está sobre un código secundario, muestra
> `cod×n → PRINCIPAL (cambiar NP)` — no deben entrar pedidos al secundario. Familias:
> 574E·574, 525E·525, 580·580E, 702E·702EN, 725E·725, 323E·323, 607E·565 (Grupo A) y
> 941E·338, 942E·334, 943E·336, 945E·332, 946E·335, 948E·333 (Grupo B: nacional 33x discontinuo ↔
> importada 94xE, LK). Sueltos sin par: 337, 944E. **PENDIENTE (2ª etapa):** alerta Telegram cuando
> entra un pedido a un secundario; descuento incremental de stock durante el picking (EP).
>
> Nota: **v7.89 — Columna LK/CH en la tabla de stock** (izquierda de Descripción; LK rojo, CH azul,
> desde `OC_Maximos.linea` vía `ocLoadLineas`). Además fixes visuales del módulo Faltante.
>
> Nota: **v7.82 — Editor de cantidad en "Todos los insumos" + fix trigger `fn_canon_cod_art` para insumos**. **(A) EDITOR:** La tabla de abajo de todo en la solapa Insumos ("📋 Todos los insumos") ahora tiene un botón **"Editar"** en cada fila → abre edición inline con inputs de código, detalle, categoría, ubicación, **cantidad y unidad** (reutiliza `stkInsGuardar` = mismos IDs que el listado por categoría). Permite **cargar stock a insumos que están en 0** (los que quedan ocultos en los listados por categoría porque se filtran los de saldo 0). Se agregó 7ª columna y se actualizó el colspan y el hint del `stk-cut`. Test: `ins-admin.cjs` ahora ejercita el flujo completo de Editar/Guardar/Cancelar desde esta tabla (incluida la verificación del POST a `Movimientos_Stock` con delta=666). **(B) BUG FIX — TRIGGER `fn_canon_cod_art`.** Al editar un insumo con código numérico corto (ej. `25`, `7`, `22`, `62`), el ajuste se **POSTeaba correctamente** a `Movimientos_Stock`, pero el trigger `trg_canon_cod_art` **zero-paddeaba** el `cod_art` a 3 dígitos (`25`→`025`, `7`→`007`). Como `Insumos.cod` guarda sin padding (`25`) y la vista `vista_saldos_insumos_x_unidad` agrupa por `cod_art`, los movimientos caían en un **grupo fantasma** (`025`) que la app nunca leía → parecía que no guardaba. Afectaba **todos los ajustes y entregas de insumos con código numérico < 3 dígitos** (27 códigos en el catálogo). **Fix:** `fn_canon_cod_art` ahora hace `if NEW.deposito = 'insumos' then return NEW; end if;` al principio → los códigos de insumo quedan **tal cual están en la tabla `Insumos`**, sin canonicalizar. **Datos limpiados:** `022`→`22` (−207 Kg de entrega), `062`→`62` (−164 Kg), `007`→`7` (4 movimientos, incluidos 9000 Uni y −345 Kg), y 3 filas huérfanas con `025` borradas (intentos fallidos del usuario). Los saldos que la app mostraba estaban **inflados** (les faltaban esas entregas/ajustes).
>
> Nota: **v7.81 — CAMBIO DE FONDO: el generador de OCs sale de STOCK, no de una lista a mano** (pedido
> del usuario). Antes el universo de artículos era `OC_Maximos` (lista cargada a mano). Ahora sale de lo
> que el sistema **lleva y registra como stock** más lo que vende. Todo el cálculo se encapsuló en la
> vista Supabase **`vista_generador_oc`** (la leen el front `ocgEnter`/`ocgEnterCfg` **y** el cron del
> miércoles — una sola fuente, no se desincronizan). **(1) Universo** = productos TERMINADOS de
> `vista_saldos_stock` ∪ proyección ∪ pedidos ∪ config existente (insumos afuera: no tienen capacidad ni
> proyección). **(2) Proveedor** = de `OC_Maximos` (que pasó a ser SOLO config de proveedor/%/índice/
> activo por código); sin config → **"(sin proveedor)"**: se muestra en el generador y en Configuraciones
> (resaltado) para asignarlo, pero **no** se auto-genera (no se puede enviar). **(3) Stock** ahora suma la
> familia por **empresa `LK`/`CH`** (`437E LK` + `437E CH` → `437E`): arregla un **bug de sobre-pedido**
> (437E/438E/439E veían stock 0 y pedían ~132 cajas de más). **(4) Máximo** = proyección × índice (topado
> a capacidad); si **no hay proyección** (sin ventas 6m→12m→0), el **objetivo = capacidad de góndola**
> (`Capacidad_Sector`), pero SOLO para códigos con proveedor real. **(5) uni×caja** ya no se carga a mano:
> sale de **`vista_uni_x_caja`** (maestro `Articulos Virgilio X Tallerista` → `OC_Maximos` live → `uxb`);
> se migraron al maestro los que faltaban y se dejó **`OC_Maximos_backup_estatico`** (snapshot congelado,
> RLS on) como respaldo. **(6) Configuraciones**: se sacó **"➕ Agregar artículo"** (los artículos aparecen
> solos desde stock) y las columnas **Objetivo** y **Uni×Caja editable** (uni×caja queda read-only). El
> editor hace **upsert** en `OC_Maximos` (INSERT para códigos nuevos de stock, PATCH para los existentes).
> Ambas vistas son **SECURITY INVOKER** (sin advisor). Cron real sigue **desactivado** (corre la
> simulación). Dry-run nuevo: **111 líneas · 18 prov · 7.630 cajas** (antes 104/9.198 — bajó el
> sobre-pedido). Tests `ocg-norm`/`ocg-config` reescritos. SQL en `sql/vista_generador_oc.sql`,
> `sql/oc_maximos_backup_estatico.sql`, `sql/generar_ocs_automaticas.sql`, `sql/simular_ocs_automaticas.sql`.
> Bump **v7.81**.
>
> Nota: **v7.75 — unificar TAP con el asistente Completar** (eliminación de los botones sueltos
> **TP** y **TAP** de la botonera principal). El armado tenía dos pasos desacoplados: (1) el
> asistente `compTerminar` grababa los **registros** (`Entregas_Virgilio` + líos `TAL`), y (2) el
> botón separado **TAP** emitía el evento y movía el stock. **Fix v7.75:** El botón "Terminar" del
> asistente ahora hace **TODO en una sola acción**: graba registros, emite TAP event, y mueve
> stock (`stockSepararAFacturar`) — así no existe la ventana donde TAP se aprieta sin completar
> (que causó la crisis D06B en v7.74). **Botonera:** remover TP (picking termina dentro del picking,
> no desde pantalla principal) y TAP (unificado). **Layout:** AP «Empecé Armado» pasa a row1
> (derecha de EP) — ahora ambos starters en la misma fila. Smoke `tests/comp-terminar-unificado.cjs`.
> Bump **v7.75**.
>
> Nota: **v7.74 — no se puede TERMINAR el armado (TAP) sin completar el asistente «Completar»**. El
> armado tiene dos pasos: (1) el asistente `compTerminar` graba los **registros** (`Entregas_Virgilio`
> + líos `TAL`), y (2) el botón **TAP** emite el evento y mueve el stock (`stockSepararAFacturar`).
> Estaban **desacoplados**: si el operario apretaba el **TAP suelto sin completar el asistente**, la
> tanda quedaba **armada (stock movido) pero SIN registros** → no aparecía en el **PDF de Facturado**
> ni en **Consulta NP → Composición a líos**. Caso real **D06B** (leg 8): armado 08-04, stock
> separado/facturado, **0 Entregas / 0 TAL** → quedó en limbo. Fix: gate en `send()` — al emitir un TAP,
> si la tanda **no tiene registros** (ni en el `Set` local `_armadoRegistrado` que setea `compTerminar`,
> ni Entregas en el server vía `_compTandaYaArmada`), **avisa y abre el asistente** en vez de emitir el
> TAP hueco. El legajo de PRUEBA no crea Entregas (v7.69) → no aplica; falla ABIERTO (sin red no
> bloquea). Datos: reconstruidas a mano las Entregas de D06B (98151/98154/98155, con el faltante real
> del 234). Smoke `tests/tap-sin-completar.cjs`. Bump **v7.74**.
>
> Nota: **v7.72 — fix de regresión (v7.54): un artículo SOLO en `racks_ch` volvió a aparecer en la
> tabla de Stock**. v7.54 fusionó `racks_ch` en la columna «Racks» pero lo **sacó de `SECTKEYS`**, que
> es la lista que decide si una fila se muestra — así un código con stock **sólo** en racks CH (ej.
> 712E, 809E) desaparecía. Se agrega **`_stkStockKeys = SECTKEYS + racks_ch`** para el filtro de
> «mostrar», negativos y el base-split (v7.71); racks_ch se sigue **mostrando sumado** en «Racks».
> Test `tests/stk-envasar-col.cjs` actualizado a la conducta v7.54 (sin columna separada «Racks CH»;
> 712E visible con su 444 en «Racks»). Bump **v7.72**.
>
> Nota: **v7.71 — la tabla de Stock oculta la fila FANTASMA del código base de una familia
> empresa-split** (pedido del usuario). En el empresa-split, el pedido usa el **código base** (ej.
> `438E`) y el stock físico vive en `438E LK` / `438E CH`; la vista mostraba entonces una fila del
> base con **0 stock pero con cajas pedidas** (fila fantasma que confunde: parece faltante). Ahora
> `stkBodyStocks` **oculta la fila del base** cuando (a) es un base sin sufijo (`codBase(cod)===cod`),
> (b) su familia tiene stock en una variante LK/CH/LOKE, y (c) el base **no tiene stock propio**. Un
> base **con** stock propio (ej. `437E`, 36 cj) **sigue visible**. La demanda del base la cubre la
> familia; la detección de faltantes family-aware sigue por otro lado (Chequeo de góndola en la PPP,
> Facturación). Smoke `tests/stk-base-split-oculta.cjs`. Bump **v7.71**. — Contexto: se unificaron a
> mano los códigos duplicados **727/727EN→727E**, **438E/438EL→438E LK/CH**, **439E/439EL→439E LK/CH**
> (re-etiquetado de `Movimientos_Stock` — el cron `reconciliar_pipeline_stock_etapa1` dedupea por
> **tanda** (ref), no por código, así que re-etiquetar no re-crea; equivalencias en
> `Equivalencias_Codigos` para los typos; typos ya sacados del Sheet por el usuario).
>
> Nota: **v7.70 — Aviso URGENTE por Telegram: faltó en el picking pero HABÍA stock en góndola**
> (pedido del usuario). Nuevo evento **`FGU`**. Al **TERMINAR el picking** (`stockBajaPicking`, TP),
> además del `SSG` (pickeó de más) y del `RAG` (faltó pero hay en racks / a guardar), ahora se
> detecta el caso más grave: un artículo **faltó** (`esp>real`) pero la **góndola** (familia
> `codBase`, disponible a esa tanda = saldo `terminado` excluyendo el picking de la propia tanda)
> tenía **al menos lo pedido** (`gond ≥ esp`). Es una contradicción: la mercadería figura en
> góndola y aun así salió corto (mal ubicada, mal contada, o no la vieron). Se emite `FGU`
> (`texto="TANDA|cod:falto:gond,…"`, dedup 1×/tanda/legajo/día) y el trigger
> **`trg_faltante_gondola_telegram`** (`sql/faltante_gondola_telegram.sql`, mismo mecanismo
> `tg_enqueue`→`telegram_outbox` que los demás) manda **"🚨 URGENTE!! FALTÓ EN PICKING PERO HABÍA
> STOCK EN GÓNDOLA"** al grupo. Condición conservadora para no falsos-positivos (no se pisa con
> SSG ni RAG). Regresión `tests/fgu-faltante-gondola.cjs`. El monitor lo ignora. Bump **v7.70**.
>
> Nota: **v7.69 — el operador de PRUEBA (legajo 0/1) ya no crea Entregas fantasma que bloqueen el
> armado**. `_compTandaYaArmada` usa `Entregas_Virgilio` como señal de *«la tanda ya fue armada»*
> (candado anti doble-armado, `showCompletarWizard`). Pero `_compSaveEntregas` **no** estaba guardado
> contra el operador de prueba (a diferencia de `stockMove`, que sí se salta), así que un **armado de
> prueba del legajo 0** creaba filas en `Entregas_Virgilio` **sin mover stock** — y esas Entregas
> fantasma hacían que un operario **real** viera *«La tanda X ya fue armada. No se abre el armado…»* y
> **no pudiera armarla**. Caso real **D06C**: 28 Entregas del legajo 0 (creadas 08-04 13:51, justo tras
> el AP fantasma) bloqueaban al legajo 122. Fix: `_compSaveEntregas` ahora hace `return` temprano si
> `esOperadorPrueba()`. Datos: borradas las 28 Entregas fantasma de D06C (stock intacto — el armado de
> prueba nunca lo tocó; D06C quedó pickeada, lista para armar). Smoke `tests/comp-entregas-prueba.cjs`.
> Bump **v7.69**.
>
> Nota: **v7.68 — Guardado a Góndola (MG) deja de ser un toggle: entrar/salir sin el botón
> trabado en rojo** (pedido del usuario). **Problema:** MG era un toggle (arranca/para). Al cerrar
> el modal (Cerrar/Cancelar) el toggle **no** se apagaba → el botón quedaba en **rojo**, y como es
> toggle, el toque para "volver a entrar" en realidad lo **cerraba** (registrando un evento MG que,
> sin red, fallaba) en vez de reabrir. Resultado: no se podía re-entrar en un toque, el botón
> quedaba rojo y se acumulaban "MG — falló" en el Resumen. **Fix:** MG pasa a ser un **módulo
> directo** como CP/SC: `selectOption("MG")` abre el chooser y `return` (sin Enviar, sin evento y
> **sin toggle**). Entrar/salir no deja nada colgado; un **apretón por error** se deshace con
> **Cancelar/Cerrar** (botón vuelve a normal, no registra nada). El evento `MG` **con su duración**
> (open del modal → confirmar; lo usan Rendimiento `t_movim` y el Monitor `movMs`) lo emite
> `mgConfirmar`→**`mgEmitGuardado`** una sola vez, al **confirmar** el guardado (mismo patrón que
> `cpConfirm`), y aparece limpio en el Resumen. MG salió de `TOGGLE_CODES`, `SURVIVING_TOGGLES`,
> `NEVER_INPUT` y de la sugerencia "Continuar" (sigue en `MOV_TOGGLE_CODES`/`INC_TOGGLE` porque esos
> **leen** el evento cerrado). Migración `migrateClearMGToggle()` (corre al arrancar) borra cualquier
> `st.toggles.MG` viejo para destrabar el botón rojo ya existente. Regresión nueva
> `tests/mg-reentrada.cjs`. Bump **v7.68**.
>
> Nota: **v7.67 — Configuraciones del generador: "Sin proveedor" como opción, Objetivo/Uni×Caja bien
> tratados y cuenta regresiva dentro del botón** (pedido del usuario). **(1) "Sin proveedor"** es ahora
> una opción explícita del desplegable **Proveedor 1** (antes un código sin proveedor —como el `55289`—
> mostraba un valor pero al generar caía en "(sin proveedor)" sin poder elegirlo). El helper
> `_ocProvOptions` pasó de un bool `allowEmpty` a un `emptyLabel` (Prov 1 = "(sin proveedor)", Prov 2 =
> "— (ninguno)"). **(2) Objetivo vs Uni×Caja:** **Uni×Caja** sale de la **ficha del artículo**
> (packaging, `Articulos Virgilio X Tallerista`) → en la lista de Configuraciones se muestra
> **solo lectura** (no se edita ahí); **Objetivo** (`OC_Maximos.max_cajas`, tope/fallback cuando no hay
> proyección) **sigue editable** porque es propio del generador. **(3) Cuenta regresiva** hasta la
> generación automática del miércoles 07:00 AR, **adentro del botón ✓ Generar las OCs**, formato
> **"se genera automáticamente en xDxHxM"** (`_ocgAutoEnTxt` + `ocgStartCountdown`, refresco cada minuto).
> **(4) Auditoría de datos del cálculo** (a pedido): proyección sana (369 códigos, todos >0), todas las
> proporciones suman 100, el único sin proveedor era `55289` (ahora seleccionable), 5 duales al 50/50; se
> trazó la aritmética de 8 códigos (`031→848`, `123→94` split, `809E`=Racks correctamente excluido,
> `55289→334`) y da bien. Verificado: suite completa + render headless (generador con la cuenta regresiva,
> editor con 55289 en "(sin proveedor)" y Uni×Caja solo lectura). Bump **v7.67**.
>
> Nota: **v7.66 — Generador de OCs: reparto por proveedor (duales) + registro de proveedores +
> limpieza de la pantalla** (pedido del usuario, cierra la idea 1382). **(A) UI del generador:** se
> sacaron el recuadro verde ("próxima generación automática") y el azul ("A pedir = máx…"); el botón
> **✓ Generar las OCs** ahora va **grande arriba**, a la altura del ← Volver; el botón de config se
> llama **⚙ Configuraciones**. **(B) Reparto por proveedor (duales).** `OC_Maximos` suma
> **`prop_prov1`, `proveedor2`, `prop_prov2`** (Proveedor 1 = `proveedor`). En **Configuraciones** cada
> código tiene **Proveedor 1 (desplegable) · % P1 · Proveedor 2 (desplegable) · % P2 · Objetivo ·
> Uni×Caja · Índice · Activo**; los desplegables salen del **registro de proveedores** (tabla
> `Talleristas_Contacto` + col `es_proveedor_oc`; se agregaron Kuffo/Log Fabr/Racks y se sacaron los
> rótulos duales); los dos % **deben sumar 100** (valida al guardar, marca en rojo si no). Botón nuevo
> **➕ Agregar proveedor** (nombre + teléfono → `Talleristas_Contacto`, que alimenta también el impreso
> y el WhatsApp). El alta de artículo usa los mismos desplegables + % P1/P2. **(C) Generación con
> split:** el generador (front `ocgEnter` y cron `generar_ocs_automaticas`/`simular_ocs_automaticas`,
> redeployados) reparte el "a pedir" en **dos líneas de OC** por proporción (P2 recibe el resto para
> sumar exacto); un solo proveedor = 100% al P1. Racks se sigue excluyendo por sub-línea. **Migración:**
> los duales viejos (`123`, `222`, `505`, `505I`, `910`) pasaron de `"X / Y"` a Prov 1/Prov 2 **50/50**
> (el dueño ajusta las proporciones reales en Configuraciones). Verificado: dry-run del split (123 →
> Garcia 47 / Lucho 47) + suite completa + chequeo headless del editor y del generador. Cierra la idea
> de usuario **1382**. Bump **v7.66**.
>
> Nota: **v7.65 — Generador de OCs: Log/Fabr AHORA genera OC; Racks se saca del generador**
> (pedido del usuario). **(1) Log/ Fabr** (la fábrica) pasa a generar OC como cualquier proveedor
> (antes estaba marcado "interno — no se genera OC"). **(2) Racks** (importación) se **excluye por
> completo** del generador — ni aparece en el preview ni genera (se abastece por otra vía). Se
> eliminó el concepto "interno" (`OCG_INTERNOS`/`_ocgInterno`) y se reemplazó por
> **`OCG_EXCLUIDOS = ["RACKS","RACK"]`** + `_ocgExcluido`, que filtra en `ocgEnter` **al construir
> los ítems** (así Racks no entra ni al preview). `ocgGroups`/`ocBodyGen`/`ocgGenerar` ya no tienen
> ramas de "interno". Cambio replicado en el **cron del miércoles**: `generar_ocs_automaticas` y
> `simular_ocs_automaticas` (SQL) — el filtro pasó de `not in ('RACKS','LOG/ FABR',…)` a `not in
> ('RACKS','RACK')`; ambas funciones **redeployadas** en Supabase. Verificado (dry-run read-only):
> Log/ Fabr generaría **21 líneas / 1.336 cajas**; Racks no aparece. **(3)** Los duales de talleristas
> («Garcia / Lucho», etc. = códigos repartidos proporcionalmente entre dos talleristas) quedan
> **pendientes a pedido del usuario** → anotado como idea **1382** (`agente_propuestas` +
> `docs/IDEAS-USUARIO.md`): partir la OC dual en dos por proporción; la tabla
> `Proporcion_Articulo_Tallerista` existe pero está vacía y falta la data. Bump **v7.65**.
>
> Nota: **v7.64 — Fix del botón 📲 WhatsApp: ahora SÍ copia la imagen + reusa la misma pestaña**.
> Dos correcciones sobre v7.63. **(1) No copiaba** (reportado por el usuario): el copiado (`clipboard.
> write`) se disparaba **sin `await`** y **antes** de abrir WhatsApp, así que el cambio de foco a la
> pestaña nueva **cortaba** el write y no copiaba nada. Ahora se **espera** a que el copiado TERMINE
> con el documento enfocado y **recién después** se abre WhatsApp (el `window.open` sigue dentro de la
> activación transitoria del click de 5 s, así que no lo bloquea el pop-up). Verificado que `_ocPngBlob`
> genera el PNG bien (sin *taint* del canvas). **(2) Abría ventana nueva cada vez**: el `window.open`
> ahora usa un **target con nombre fijo** (`"pv_whatsapp"`) → reusa la MISMA pestaña de WhatsApp en
> clicks sucesivos (+ `win.focus()`). ⚠ Límite del navegador: **no** se puede tomar una pestaña de
> WhatsApp que abrió el usuario por su cuenta (aislamiento entre pestañas); sólo se reusa la que abre la
> app. Si el portapapeles falla, sigue el fallback de **descargar** la imagen. Bump **v7.64**.
>
> Nota: **v7.63 — 📲 Enviar la OC por WhatsApp al tallerista**. En el detalle de una OC, botón nuevo
> **📲 WhatsApp** (junto a 🖨 Operador / 🖨 Tallerista): **copia la OC como IMAGEN al portapapeles** y
> **abre WhatsApp Web/app del tallerista** — se pega con Ctrl+V en el chat y se manda. ⚠ El navegador
> **no puede copiar un PDF** al portapapeles (ni WhatsApp acepta pegar PDF), por eso se copia una
> imagen (lo más cercano a "listo para enviar"). La imagen se genera **sin librerías**: `ocPrintHtml`
> (vista tallerista) → `<style>`+HTML serializado con `XMLSerializer` → SVG `foreignObject` → canvas →
> PNG (`_ocPngBlob`). El copiado va **dentro del gesto** del click (con `ClipboardItem` tomando una
> Promise de blob) y **recién después** abre WhatsApp (para que el pop-up no se bloquee); si el
> portapapeles no está (Firefox/Safari viejos), **descarga** el PNG como fallback. **El teléfono sale de
> `ocTelDe`** (tabla **`Talleristas_Contacto`**, v7.62) — una sola fuente de verdad, editable, que ya
> resuelve **duales** («Garcia / Lucho») y el caso **«no enviar por WhatsApp»** (Oscar, Pedernera,
> Paternal Goma, Manfer tienen tel NULL → el botón avisa y no abre nada). Se le sacan los no-dígitos
> para armar `https://wa.me/<num>`. Los botones de impresión (PDF) siguen igual. Test `tests/ocg-wa.cjs`;
> `dead-handlers` OK. Bump **v7.63**.
>
> Nota: **v7.62 — Teléfonos de talleristas en el impreso de OC (tabla nueva) + aclaraciones de
> Log/Fabr y duales**. El dueño pasó los teléfonos de los talleristas (antes no había ninguno en la
> base). **(1) Tabla `Talleristas_Contacto`** (`sql/talleristas_contacto.sql`): `nombre, telefono,
> enviar_por_telefono, nota, activo`. RLS **solo lectura** para el front (anon + authenticated);
> **sin política de escritura** — los teléfonos los administra un supervisor por SQL/migración
> (service_role). Cargados: Poly, Lucho, Martin C, Pintos, Carriero, German, Maspoli, Tierra Nativa,
> Carlos E, Garcia, Pettofrezza, Lopez Jose, The Plast. **Sin teléfono a propósito** (quedan con
> `enviar_por_telefono=false` + nota): Oscar y Pedernera (*se les manda desde la fábrica*, no por
> WhatsApp), Paternal Goma (*en pausa*), Manfer (*no existe más*). **Duales** «Garcia / Lucho» y
> «Pintos / Maspoli»: el impreso toma el número de cualquiera de los dos (el de «garcia/lucho» vino
> incompleto). **(2) App**: `ocLoadTels()` carga la tabla en `_oc.tels` (en el `Promise.all` de
> `openOCAdmin`); `ocTelDe(prov)` ahora busca **primero** en `Talleristas_Contacto` (por nombre
> normalizado con `_ocProvKeys`, tolera duales y variantes «Martin C»=Martin) y cae a
> `Ordenes_Compra.proveedor_telefono` como fallback. El impreso muestra el Tel **debajo del nombre**
> (v7.54). **(3) Aclaración Log/Fabr**: **no es un bug** — «Log/ Fabr» (fábrica) y «Racks»
> (importación) están en `OCG_INTERNOS`, se marcan **interno** y el generador **no** les crea OC
> externa (no se le compra a la propia fábrica); aparecen en el preview del generador como «(interno —
> no se genera OC)». `OC_Maximos` tiene 47 ítems activos de Log/Fabr y 78 de Racks. **(4) Duales /
> split**: `Proporcion_Articulo_Tallerista` (cod_art, tallerista, proporcion) **existe pero está
> VACÍA y no la usa nadie** → hoy los duales se generan como **una sola OC combinada** (no se parte
> proporcionalmente). Queda anotado como posible mejora (partir la OC dual en dos por proporción, con
> su propio teléfono cada una) — a confirmar con el dueño y con los datos de proporción. Bump **v7.62**.
>
> Nota (backend, **sin bump de app**): **La proyección que alimenta las OCs pasa a 6 meses (fallback
> 12) y combina Loekemeyer + Chef**. Pedido del usuario: la proyección de ventas que fija el Máximo del
> generador debe usar los **últimos 6 meses corridos** (no 24), combinando **LK + Chef** con el suavizado
> de anomalías ya integrado; **si un producto proyecta 0 en 6 meses, se miran los últimos 12; si sigue en
> 0, queda en 0**. Se creó en PáginaLK (`kwkclwhmoygunqmlegrg`) la función **`fn_proyeccion_oc_virgilio()`**
> (helper `_fn_proy_window(p_meses)` que calcula la proyección combinada+suavizada por ventana; la
> principal hace el coalesce 6m→12m→0). **`refresh_proyeccion_madre()`** (Virgilio) ahora consume esa
> función en vez de `fn_proyeccion_madre_emp?p_emp=lk` (que sigue existiendo, LK-only 24m, pero el refresh
> ya no la usa). Verificado: **369 códigos** (345 con proy en 6m + 23 al fallback de 12m; 28 quedan en 0),
> refresh end-to-end OK, cobertura del generador **175/190 activos = 92%** (subió de 165). El generador y
> el resto de la app no cambian (siguen leyendo `proyeccion_madre`). SQL en
> `sql/fn_proyeccion_oc_virgilio.sql` + `sql/refresh_proyeccion_madre.sql`.
>
> Nota: **v7.61 — REVERT de v7.55: se sacan «Depurar incompletos» y los «Parámetros de la
> proyección» (período + suavizar) del generador de OCs**. Decisión del usuario: la proyección NO se
> configura desde la app — la provee **PáginaLK** ("loekemeyer's web"). Cambios: **(1)** se quitó
> el botón **🧹 Depurar incompletos** y su vista (`ocgEnterDepurar`/`ocBodyDepurar`). **(2)** Se quitó
> la caja **📈 Parámetros de la proyección** (`_ocCfgParamsBox`/`ocCfgSaveParams`, inputs de meses/
> suavizar) de la pantalla de config. **(3)** El botón volvió a **⚙ Config (máximos)** y esa pantalla
> vuelve a editar **sólo `OC_Maximos`** (objetivo/uni×caja/índice/proveedor/activo + alta), como antes
> de v7.55. Backend revertido: **`fn_proyeccion_madre_emp(p_emp)`** volvió a **1 argumento** (se
> conserva el fix de `statement_timeout` 60s); **`refresh_proyeccion_madre()`** vuelve a llamar
> `?p_emp=lk` sin parámetros (conserva aviso Telegram + cron semanal); se **eliminó** la tabla
> `Config_Proyeccion`. Se **mantiene** de v7.55 sólo la **proyección 0 en vez de `xls`** en el
> visualizador (era un pedido aparte del usuario). Suite completa OK; se removieron
> `tests/ocg-depurar.cjs` y `sql/config_proyeccion.sql`. Bump **v7.61**. (La ventana de la proyección
> se ajusta enseguida a 6 meses con fallback a 12 — ver nota de backend siguiente.)
>
> Nota: **v7.60 — Panel «En este momento»: ahora incluye a TODOS los que ficharon hoy** (repregunta
> del usuario: «¿todos los que ficharon aparecen ahí?» — antes **no**). El panel se armaba sólo con la
> **actividad** (`dataC` = eventos de `Registros`), así que un operario aparecía únicamente si ya había
> **tocado algún botón** hoy. Ahora `_monActividadActual` recibe también **`fichadosHoyByLeg`** (legajo →
> hora de ingreso, de la tabla `Fichadas_Virgilio`) y **suma a los que ficharon pero todavía NO
> arrancaron**: salen como **«🕐 fichó · sin arrancar»** desde su hora de ingreso. Sigue **excluyendo a
> los que ya hicieron FJ** (terminaron la jornada) aunque hayan fichado. Cada fila lleva `arranco`:
> `true` = trabajó (muestra su tarea, o «💤 libre · sin tarea abierta» si cerró lo último) · `false` =
> fichó y no tocó nada. Es decir, el panel ahora = **todos los presentes hoy** (fichados y/o con
> actividad, menos los que cerraron jornada). Verificado headless: un legajo que sólo fichó aparece como
> «sin arrancar» desde su ingreso; uno que trabajó y paró, como «libre»; uno que fichó pero hizo FJ, NO
> aparece; smoke/dead-handlers OK. Bump **v7.60**.
>
> Nota: **v7.59 — el SSG «picking sin stock en góndola» NO dispara si no se pudo LEER el stock**.
> `stockBajaPicking` lee TODOS los movimientos con `stockFetchMovs` → `supaFetchAll`, que **tira** si
> falla cualquier página del paginado (Range). Cuando eso pasaba (celular del operario + tabla
> `Movimientos_Stock` enorme), `sal` quedaba `{}` y el `catch` seguía como si **todo estuviera en 0** →
> el SSG avisaba «picking sin stock» de **TODOS** los códigos pickeados. Caso real **D06A** (leg 122):
> **28 códigos** con «el sistema tenía 0» mientras la góndola estaba **llena** (504=1251, 505=2574,
> 506=2356, 513=1968…). Ahora se marca `salOk` sólo si el fetch trajo movimientos; si falló o vino
> vacío, **`return` temprano** — «no sé el stock» ≠ «hay 0» — y no se dispara ni el SSG ni el aviso
> racks/a-guardar. La detección real sigue igual cuando los datos se leen bien. El aviso de D06A fue
> **falso positivo puro** (no hubo que tocar datos). Smoke `tests/ssg-sin-datos.cjs`. Bump **v7.59**.
>
> Nota: **v7.58 — Visualizador de OCs: «Recibido» y «Recep.» se unifican en UNA sola columna + el
> recibido se acota al PERÍODO de la OC** (pedido del usuario). **(1) UNA columna.** En el detalle
> de la OC se saca la columna «📥 Recep.» y el campo editable «Recibido» a mano (y con eso los botones
> «💾 Guardar recibido» y «📥 Traer de recepción», y las funciones `ocGuardarRecibido`,
> `_ocCollectRecibido`, `ocTraerRecepcion`, `ocLiveFalt`, `ocRecDe`). Queda **una sola columna
> «Recibido» = lo que registró la Recepción de Mercadería** (solo lectura). `ocRecEff` ahora devuelve
> **puro lo de recepción** (se sacó el "si hay manual, manda"); como TODAS las OCs tenían
> `cantidad_recibida = 0`, no se pierde nada. Se alinearon a la misma fuente **% Entregas**
> (`ocBodyEntregas`) y **Trazar** (`ocBodyTrazar`). **Marcar recibida** ahora toma una **foto** del
> recibido de recepción en `cantidad_recibida` (registro fijo); Reabrir solo cambia el estado.
> **(2) PERÍODO VIGENTE (no acumula pasado).** `ocBuildRecep` cuenta lo recibido de ese
> tallerista+código **solo dentro del período de la OC**: ventana `[fecha_OC, tope)` donde
> `tope = min(fecha de la OC SIGUIENTE del mismo tallerista+código, fecha_OC + `OC_RECEP_VIGENCIA_DIAS`
> (120 d))`. Las entregas **anteriores** a la OC no cuentan y, si la OC no tiene fecha, no se atribuye
> nada (antes, sin fecha, podía sumar todo el histórico). Helper nuevo `_ocAddDias`. Test
> `tests/oc-print.cjs` sin cambios (OK). Bump **v7.58**.
>
> Nota: **v7.57 — un operario real ya no queda bloqueado por un dueño de PRUEBA (legajo 0/1)**.
> Caso real **D06C**: un **AP fantasma de legajo 0** dejaba la tanda *«en curso por el legajo 0»* y
> ningún operario podía arrancar el armado. `getActivityStatus` ya filtraba 0/1 (v7.06) pero los
> **dos gates de `send()`** (exclusividad por `getActivityStatus` **y** reserva atómica por
> `Tandas_Lock`) igual podían mostrar «ya la está armando el legajo 0» — sobre todo en clientes con la
> app **cacheada vieja**, o si quedaba un lock 0/1 viejo. Ahora ambos gates ignoran a un dueño de
> prueba (`&& !esLegajoPrueba(dueno/lock.legajo)`). Datos reconciliados: borrado el AP fantasma de
> D06C y liberado el lock huérfano (lo tenía 122, que en realidad estaba armando D06D). Smoke
> `tests/send-prueba-nobloquea.cjs` (dispara `send()` con dueño 0 → no bloquea; con 237 → sí). Bump **v7.57**.
>
> Nota: **v7.56 — Monitor: panel «En este momento» (qué está haciendo AHORA cada operario)**.
> Pedido del usuario: la tabla del monitor sólo mostraba la actividad del que trabajaba una tanda
> visible (ej. JF armando D15A con su spinner), no la del resto. Ahora, **debajo de la tabla**, un
> panel lista **por operario activo** lo que está haciendo en este momento + hace cuánto (ámbar >1 h,
> rojo >2 h): **pickeando/armando tal tanda**, **en el baño**, **guardando**, **comiendo**,
> **recibiendo mercadería/insumos**, **cargando camión**, **atendiendo timbre**, **limpiando**,
> **conteo**, **permiso**, etc. Los que no tienen ninguna acción abierta salen como **«libre»**. Cómo
> se calcula: **`_monActividadActual`** hace un *replay* de los eventos de HOY por legajo y busca la
> acción **ABIERTA** más reciente — picking (EP sin TP), armado (AP sin TAP) o un **toggle abierto**
> (la apertura NO lleva `ts_inicio`, el cierre SÍ). Excluye legajos 0/1 y a los que ya hicieron **FJ**.
> Para eso la query `dataC` de `fetchMonitorEvents` ahora trae también **`texto` y `ts_inicio`**
> (mismas filas, 2 columnas más); devuelve `currentActivity`, que `refreshMonitor` guarda en
> `_monActividad` y `renderMonitor` pinta con **`_monActPanelHtml`** (siglas `initialsFromName` +
> ícono + tarea + duración), debajo de `leftHtml` en `.monitor-table-wrap`. CSS `.mon-act-*` (oscuro +
> escala en modo TV). Sin cambios de datos/subida — sólo LECTURA/visualización. Verificado headless:
> el replay ubica cada operario en su tarea (JF→Armando D15A 9m, baño, guardando, libre…), excluye
> FJ/prueba, prioriza la acción abierta actual sobre una anterior ya cerrada; smoke extendido con
> `_monActividadActual`/`_monActPanelHtml`; `dead-handlers` OK; + screenshot del panel. Bump **v7.56**.
>
> Nota: **v7.55 — Generador de OCs: «Depurar incompletos», proyección 0 en vez de `xls`, y
> parámetros de proyección (período + suavizar anómalos)**. Cuatro cosas pedidas por el usuario.
> **(1) Botón «🧹 Depurar incompletos»** al lado de «Generar las OCs»: lista los artículos ACTIVOS de
> `OC_Maximos` con datos faltantes (**sin proveedor / sin objetivo / sin uni×caja**) o **sin historial
> de ventas** (sin proyección), con chips por problema y un resumen por tipo (`ocgEnterDepurar`/
> `ocBodyDepurar`, usa `_oc.gen.maxs` + `_oc.gen.proy`). **(2)** En el visualizador, los artículos sin
> proyección ahora muestran **0** en la columna Proy (antes `xls`) — "no hay data → 0"; igual usan el
> objetivo como Máximo. **(3)** El botón **⚙ Config (máximos)** pasó a **⚙ Configurar parámetros**.
> **(4)** En esa pantalla, además del índice general, una caja **📈 Parámetros de la proyección** con
> **período a contemplar (meses)** y un switch **«Suavizar anómalos»** (descarta el pico de un pedido
> puntual a favor del promedio — ej.: un cliente compra 1000/mes y un mes 2500 → ese 2500 no cuenta).
> Se guardan en la tabla **`Config_Proyeccion`** (Virgilio) y **recalculan la proyección en el momento**
> (botón «💾 Guardar y recalcular» → PATCH + `POST /rpc/refresh_proyeccion_madre`, ahora con `execute`
> para `authenticated`). El motor **`fn_proyeccion_madre_emp`** de PáginaLK acepta ahora
> `p_meses`/`p_suavizar` (defaults 24/true = comportamiento previo; verificado: 24/true = 372 códigos,
> sin suavizar = 372 pero +40% cajas por los picos). Tests `tests/ocg-depurar.cjs` (+ `ocg-config`).
> SQL en `sql/config_proyeccion.sql`. Bump **v7.55**.
>
> Nota: **v7.54 — Impreso de OC: la separación se cierra con líneas + el teléfono va DEBAJO del
> nombre** (ajustes del pedido de v7.52). Dos cosas en `ocPrintHtml`. **(1)** La columna de
> separación entre «Falta Pedido» y «N° Caja» quedaba **abierta** (se veía un hueco feo: la grilla
> se cortaba arriba/abajo) porque usaba `border-style:hidden`. Ahora la `.gap` es una **columna
> vacía angosta (18px) CON bordes** (hereda el borde negro de la grilla) → la tabla queda cerrada y
> la separación se sigue notando. **(2)** El **teléfono** pasa de una fila centrada arriba de la
> tabla a ir **debajo del nombre del tallerista** (bloque `.oc-p-headL`: nombre grande + `Tel: …`
> chico a la izquierda; la fecha en rojo sigue arriba a la derecha). Si no hay teléfono, **no** se
> muestra la línea (antes quedaba una franja vacía). **Origen del teléfono:** `Ordenes_Compra.
> proveedor_telefono` (lo mantiene una herramienta externa). Helper nuevo **`ocTelDe(prov)`**: si la
> OC abierta no trae el tel, lo busca en **cualquier otra OC del mismo tallerista** (nombre
> normalizado con `_ocProvKeys`) y usa el primero con dato; si no hay ninguno, no inventa. **Estado
> real (2026-08-05): la columna `proveedor_telefono` está VACÍA para todos los talleristas** (y la
> tabla `Proveedores` de ARCA no tiene teléfonos ni es de talleristas), así que hoy el impreso sale
> **sin** teléfono — pero en cuanto se cargue el dato en `Ordenes_Compra.proveedor_telefono`
> aparece solo bajo el nombre. Test `tests/oc-print.cjs` sigue OK. Bump **v7.54**.
>
> Nota: **v7.53 — Auditoría del time-tracking del operario + Atención/Conteo/Permiso dejan de
> esconderse en «Otros»**. El usuario pidió chequear que TODO lo que se cronometra desde el operario
> (picking, armado, baño, guardado, atención, limpieza, comida, etc.) registre bien el tiempo, suba a
> Supabase, quede en el historial y se vea en Análisis. **Resultado de la auditoría (todo OK):** el
> mecanismo es sólido — un toggle guarda su `ts_inicio` (ISO) al abrir y el evento de **cierre** sale
> con ese `ts_inicio` (⇒ duración); picking/armado igual con EP↔TP y AP↔TAP (ver `selectOption`
> ~6412). Todo se **encola** (`enqueueReport`) y sube a `Registros_Produccion_Virgilio` con `ts_inicio`
> (también desde el Service Worker, `sw.js`). Verificado con **datos reales de 30 días** (SQL): cada
> opción timeada tiene sus cierres con `ts_inicio`, duraciones sensatas y **0 negativos** (sin bug de
> reloj) — MG mediana 9,8′, TP 25,5′, TAP 57,7′, AT 2,4′, CT 26′, PB 4,4′, PC 31′, etc. **El único
> hueco:** tres actividades timeadas caían en el bucket genérico **«Otros»** del desglose de Rendimiento
> — **AT (Atendí Timbre = atención, 172 eventos)**, **CT (Conteo, 70)** y **Perm (Permiso de salida)**.
> Ahora tienen **bucket propio** (`_PV_BUCKET`: `AT→atencion`, `CT→conteo`, `Perm→permiso`; sumados a
> `_PV_ORDER`/`_PV_CAP`), con su franja y color en «En qué se va la jornada» (Atención `#ea580c`, Conteo
> `#14b8a6`, Permiso `#a855f7`). Además la franja **«Movimiento» se renombró a «Guardado»** (es el único
> código del bucket, `MG` = guardado a góndola/racks) para que se reconozca. Verificado headless: las 14
> actividades caen cada una en SU bucket, `Otros`=0. **Sin cambios de captura/subida** (ya andaban); es
> sólo cómo se **etiqueta** en Análisis. Bump **v7.53**.
>
> Nota: **v7.52 — Visualizador de OCs: se alimenta de la RECEPCIÓN + impreso con el formato de la
> planilla (operador / tallerista)** (pedido del usuario). Dos cosas en el módulo **📑 Órdenes de
> Compra** (`openOCAdmin`). **(1) RECEPCIÓN → OC (backlog v4.11 punto b, ahora hecho).** El
> visualizador **se alimenta solo** de lo realmente recibido en Recepción de Mercadería y marca, por
> OC, cuánto se recibió de lo pedido — sin cargar el "recibido" a mano. **Vínculo recepción→OC:**
> `proveedor(nombre) + código(clave normalizada) + FECHA`, contando desde la fecha de la OC y **hasta
> la fecha de la OC SIGUIENTE** del mismo proveedor+código (ventana `[fecha_OC, fecha_OC_siguiente)`)
> para no atribuir dos veces la misma entrega. Fuentes anon-readable: **`Entregas Tallerista Virgilio`**
> (`Nombre_Tall,Cod,Cajas,Fecha`) y **`Entregas Prov AT`** (`Proveedor,Cod_Art,Cantidad,Dia_mes` — su
> `Dia_mes` "DD-MM" sin año asume el año en curso, como el Histórico v6.50). El proveedor se matchea con
> las mismas reglas que `recepcion.js` (`_ocProvKeys`/`_ocProvKeysMatch`: parte por "/" para OCs
> compartidas tipo "Garcia / Lucho", tolera "Martin C"=Martin). Funciones nuevas: `ocFetchRecepcion`,
> `ocBuildRecep` (devuelve `{row.id → cajas recibidas}`), `ocRecEff` (recibido EFECTIVO = manual si
> `cantidad_recibida>0`, si no lo de recepción), `ocRecDe`. `ocGroupStats` usa el recibido efectivo → las
> **tarjetas de la lista/fecha y los semáforos pendiente/parcial/recibida se marcan solos**. En el
> **detalle** se agregó la columna **📥 Recep.** (solo lectura) y el botón **📥 Traer de recepción** (copia
> lo de recepción a los campos editables para revisar y Guardar). Best-effort: si las tablas de entregas
> no cargan, cae al recibido manual como antes. **(2) IMPRESO con el formato de la planilla.** `ocPrintHtml`
> se reescribió para replicar la hoja que usa el depósito: **nombre grande arriba a la izq, fecha en rojo
> a la der, Tel centrado**, grilla con bordes negros, **primera columna `Linea` (LK en rojo / CH en azul**,
> del `OC_Maximos.linea` vía `ocLoadLineas`/`ocLinea`), **títulos de columna en DOBLE FILA** (para ocupar
> menos), **más espacio para Descripción** (`table-layout:auto` + numéricas al contenido), y una **columna
> en blanco de separación** (`.gap`, `border-style:hidden`) **entre «Falta Pedido» y «N° Caja»** (lo que
> pidió el usuario). Orden de columnas: `Linea · Cod · Descripcion · Cajas · Falta Pedido · [sep] · N° Caja
> · Uni x Caja · % Lleno`. **Dos variantes** (dos botones en el detalle): **🖨 Operador** = con las **3
> columnas «Cajas Recibidas»** vacías para chequear a mano contra lo físico; **🖨 Tallerista** = sin esas
> 3 columnas, para enviarle el pedido (`ocPrintDetalle(conRecibidas)` → `ocPrintHtml(x,{conRecibidas})`).
> Se quitó el pie de firmas (no está en la planilla). Regla del % Lleno / Falta Pedido y el orden
> ascendente por % Lleno **no cambian** (siguen congelados al generar, v7.42). Test `tests/oc-print.cjs`
> actualizado al formato nuevo. Verificado: suite completa (`tests/run.sh`) **TODO OK** + screenshots
> headless de las dos variantes + chequeo unitario del match recepción→OC (ventana por fechas, proveedor
> compartido, override manual). Bump **v7.52** (`APP_VERSION` + `SW_VERSION` `v7.52-vir`).
>
> Nota: **v7.51 — Config del generador de OCs (`OC_Maximos`) EDITABLE desde la app → se elimina la
> dependencia del Excel**. El generador leía dos cosas que venían de un Excel importado a mano:
> la proyección (ya resuelta: ahora se calcula de las ventas en Supabase, ver la nota de la proyección
> más abajo) y la tabla **`OC_Maximos`** (objetivo/`max_cajas`, `uni_x_caja`, `indice`, `proveedor`,
> `activo`). El viejo botón **⚙ Índices** (que sólo editaba el índice) pasó a **⚙ Config (máximos)**:
> un editor completo de `OC_Maximos` con **Objetivo · Uni×Caja · Índice · Proveedor · Activo** editables
> por artículo, **"➕ Agregar artículo"** (alta, `cod` es PK → alta duplicada da 409) y filtro. Escribe
> con **sesión de supervisor** (RLS `ocm_write` → `authenticated`, PATCH por `cod` / POST para el alta;
> no hizo falta RPC). El estado de cambios es un **PATCH parcial por código** (`_oc.cfg.changed =
> {cod:{campo:valor}}`) que mergea varios campos y guarda todo junto. **⚠ Ahora `OC_Maximos` es la
> fuente de verdad: NO re-importar el Excel encima** (pisaría lo editado). La **fórmula del generador
> no cambió**. Funciones: `ocgEnterCfg`/`ocBodyCfg`/`ocCfgEdit`/`ocCfgSetAllIndice`/`ocCfgSave` +
> alta `ocCfgAltaOpen`/`ocCfgAltaSave`. Test `tests/ocg-config.cjs`. Bump **v7.51**. (Quedan 25 códigos
> sin proyección que usan el objetivo — ahora editable acá en vez del Excel.)
>
> Nota: **v7.50 — Chooser de Insumos: dos opciones, el alta vive adentro de «Recibir»**
> (ajuste del pedido de v7.49). El popup `insumoChooser` deja de tener tres botones: ahora son
> **SOLO dos** — **📥 Recibir** (RI) y **📤 Entregar** (EI). Se **sacó** el tercer ítem «➕ Agregar
> insumo nuevo»: dar de alta un insumo sólo tiene sentido **recibiendo**, así que ya vive **dentro
> de Recibir** (el modal de RI trae su botón «+ Agregar insumo nuevo», sin cambios). El subtítulo de
> «Recibir» ahora dice *«(entra stock — o agregá uno nuevo)»* para que se note. Se removió el flag
> `_insAutoNuevo` y su auto-apertura en `showInsumoModal` (ya no hacía falta); `insChooserGo(which)`
> quedó en un simple `selectOption(which)`. Sólo UI del chooser. Verificado: `tests/run.sh` OK +
> chequeo headless (chooser con 2 opciones, sin ítem NUEVO). Bump **v7.50**.
>
> Nota: **v7.49 — Completar Pedido (CP) ahora MIDE su tiempo + botón de Insumos unificado**.
> Dos pedidos del usuario, ambos del lado del operario. (1) **CP mide tiempo**: antes el evento
> `CP` se emitía con `ts_inicio_iso=null` → era un evento puntual, **no registraba cuánto tardó** y
> el dashboard de Rendimiento **no lo contaba**. Ahora `cpPickFalt` arranca un cronómetro
> (`_cp.tStart`) cuando el operario **elige el faltante**, y `cpConfirm` manda el `CP` con
> `ts_inicio` = ese arranque y `ts_cliente` = al confirmar → el evento lleva **duración**. En el
> motor de monitoreo se agregó el bucket **`completar`** (`_PV_BUCKET.CP='completar'`, en
> `_PV_ORDER`/`_PV_CAP` cap 120 min) y una franja **«Completar Ped.»** (color `#c026d3`) en el
> desglose «En qué se va la jornada» de la sección Rendimiento de operarios. Guard: si `tStart`
> falta o quedó en el futuro (borrador viejo), se manda sin `ts_inicio` (evita duraciones
> absurdas). (2) **Insumos = un botón**: los dos botones sueltos **RI (Recepción)** y **EI
> (Entrega)** de la 4ª fila se reemplazaron por **UN** botón 🧰 **«Entregar/Recibir Insumos»**
> (código UI `INS` en `filas.row4`, no es un opcode). Al tocarlo abre un **chooser** liviano
> (`insumoChooser`, estilo `showMGChooser`) con: **📥 Recibir** → `selectOption('RI')`, **📤
> Entregar** → `selectOption('EI')` (misma mecánica de toggle + modal de siempre) y **➕ Agregar
> insumo nuevo** → RI + abre directo el alta (flag `_insAutoNuevo` que consume `showInsumoModal`,
> el mismo «+ Agregar insumo nuevo» que ya tenía la recepción; el alta sigue **solo en RI**, en EI
> no se puede). Los eventos y descripciones RI/EI **no cambian** (siguen en `desc` para el
> historial). Verificado: `tests/run.sh` completo OK (incl. `dead-handlers`, `prod-compute`,
> `ins-categorias`, `ins-admin`, `version-sync`) + chequeo headless (CP suma 30 min al bucket
> `completar` sin contaminar picking; botonera con `INS` y sin `RI`/`EI`; chooser con las 3
> opciones) + screenshot del chooser. Bump **v7.49**.
>
> Nota (backend, **sin bump de app**): **La PROYECCIÓN que alimenta el generador de OCs estaba
> CONGELADA y fallaba en silencio → arreglada**. El Máximo del generador = `proyección × índice`;
> la proyección vive en `proyeccion_madre`, que se trae del proyecto Supabase **"loekemeyer's web"**
> (PáginaLK, `kwkclwhmoygunqmlegrg`) vía `refresh_proyeccion_madre()` → `fn_proyeccion_madre_emp`,
> que la calcula de **`sales_lines`** (228k líneas de venta 2020→hoy: promedio mensual de cajas por
> artículo/cliente en 24 meses, descartando picos one-off). O sea, **ventas + clientes + artículos ya
> están en Supabase** y la proyección sale de ahí, no de un Excel. **El problema:** esa función corre
> en ~2 s pero por REST la mataba el `statement_timeout` corto del rol anon de PáginaLK (HTTP 500 /
> 57014 con caché fría) → `refresh_proyeccion_madre()` devolvía **-1 sin recargar** y nadie se enteraba
> (el cron marcaba "succeeded"). `proyeccion_madre` quedó **frozen desde el 21/07** y la cobertura del
> generador era 112/190 = **59%** (el resto caía al Excel `OC_Maximos.max_cajas`). **Arreglos:**
> **(A)** en PáginaLK, `alter function fn_proyeccion_madre_emp(text) set statement_timeout to '60s'`
> (no cambia resultados, sólo el techo); **(B)** en Virgilio, `refresh_proyeccion_madre()` ahora **avisa
> por Telegram si falla** (dedup `projmadre_fail_<día>`) y **no pisa** la última proyección buena, y su
> cron pasó de **mensual (día 5) a semanal los miércoles 06:00 AR**, 1 h antes de la generación (07:00
> AR). Tras el refresco: **357 códigos** (antes 216) y cobertura **165/190 = 87%**; quedan 25 sin
> historial de ventas → fallback Excel (inevitable, no hay demanda para esos en ningún lado). La
> **fórmula del generador no cambió**. SQL en `sql/refresh_proyeccion_madre.sql`.
>
> Nota: **v7.48 — tilde «🔴 Negativos» en la solapa Stocks** (pedido del usuario). Al lado del
> buscador y del botón «E» hay un toggle **☐/☑ 🔴 Negativos (N)** que deja en la tabla **sólo los
> artículos con saldo negativo en ALGÚN depósito** (góndola, excedente, pickeados, a facturar, a
> guardar, racks, p/envasar, racks CH) — más los **insumos** negativos en su sección. El contador `(N)`
> muestra cuántos hay. (⚠ Desde **v7.85** el contador `(N)` cuenta **solo stock de producto** — los
> insumos negativos ya NO suman al badge, para que el número coincida con lo que muestra el filtro.) Se aplica **además** del buscador; con 0 negativos dice *«✅ No hay stock
> negativo en ningún depósito.»*. Los negativos ya salían en rojo (`.stk-neg`); esto agrega el **filtro
> rápido** para cazarlos. Funciones `stkToggleSoloNeg` + estado `_stk.soloNeg`; helper `_stkArtHasNeg`
> (compara el saldo **redondeado a lo que se muestra**). Smoke `tests/stk-solo-negativos.cjs`. Bump **v7.48**.
>
> Nota: **v7.47 — PPP · Ocupación: fuera las semanas pasadas, ahora es semana actual + 7 a futuro**
> (pedido del usuario). La solapa **📦 Ocupación** tenía un selector de 9 semanas (−4…+4), pero las
> semanas **pasadas nunca tienen datos** — el picking/PPP siempre proyecta a futuro (los pedidos
> viven por `fecha_entrega`, que es de hoy en adelante). Se sacaron: el selector va ahora de la
> **semana actual (0) a las 7 próximas (+7)** = 8 botones ("Esta sem", después las fechas de cada
> lunes). Cambios en `index.html`: `OCUP_WK_MAX = 7`, `pppOcupWeek` clampa a `[0, 7]` (antes
> `[-4, 4]`), el loop del selector va `0…7`, `showSin = true` (todas las semanas son actual/futuras
> → el backlog "A programar" se muestra siempre) y el título de semana perdió la rama "(N atrás)".
> `_ocupWeek` ya arrancaba en 0. Sólo UI de esa solapa; nada de datos ni de stock. Suite completa OK;
> render 400px (los 8 botones envuelven 7+1) y 1000px sin overflow. Bump **v7.47**.
>
> Nota: **v7.46 — «Monitor de operarios» + «Análisis de productividad» = UN módulo con dos
> pestañas**. Pedido del usuario. Los dos modales (`#monitorModal` y `#analisisModal`) ahora se
> presentan como un solo módulo con un **switch de pestañas en el header de ambos** (`.mod-switch`:
> 🖥️ Monitor · 📈 Análisis, misma posición izquierda en los dos → el switch queda fijo y cambia el
> contenido). **Abre en Monitor** (entrada única: botón **«Monitor y Análisis»**, ex «Monitor de
> operarios»); se **quitó el botón suelto «Análisis de productividad»** del menú supervisor (ahora es la
> segunda pestaña). El cambio de vista lo hacen `switchToMonitor()`/`switchToAnalisis()`, que **cierran un
> modal y abren el otro** para respetar el lifecycle propio de cada uno (el monitor: modo TV/vp +
> auto-refresh 30 s + inconsistencias; el análisis: gráficos + Producción por día + sección Rendimiento de
> operarios). En **modo kiosko** (pantalla de pared) el switch se **oculta** (`__tvKioskMode`, display de
> solo-lectura). No cambia ninguna lógica de datos; es reorganización de navegación. Verificado:
> `tests/smoke.cjs` OK + chequeo headless (funciones, pestaña activa correcta en cada vista, botón viejo
> ausente, sin pageerrors) + screenshots de ambos headers. Bump **v7.46**.
>
> Nota: **v7.45 — PPP: el 📦 del chequeo pasa a ser un SEMÁFORO automático** (pedido del usuario
> sobre la v7.16). El ícono ya no es un botón neutro que hay que tocar: **se auto-chequea al abrir
> la PPP** y se pinta solo según el stock REAL de góndola de ese momento — 🟢 **tilde verde** (está
> en góndola **todo** lo que pide el pedido) · 🟠 **! naranja** (faltan **algunos** artículos) · 🔴
> **✕ roja** (no hay en góndola **ninguno**) · ⚪ **⋯ gris** (chequeando / sin datos aún). El
> **hover** (atributo `title`) da el resumen — *"✅ Todo OK — los N están en góndola · chequeado
> HH:MM"* / *"⚠ Faltan X de N (…cajas) · chequeado HH:MM"* / *"🚨 No hay ninguno de los N"* — con la
> **hora del último chequeo**; el **click** abre el detalle artículo-por-artículo y **re-chequea en
> ese momento** (`pppChequeoNp`, sin cambios). El mismo semáforo va en la **franja de cada tanda/bloque**
> (estado combinado de todos sus pedidos, que comparten góndola). **Cómo se banca ~700 pedidos sin
> reventar la red:** una **única carga compartida** por corrida (`pppChkAutoLoad`, TTL 90 s) —
> `fetchPickingBase` (Map NP→líneas, ya cacheada 5′) + `vista_saldos_stock` fresca + los PKC pendientes
> de descontar — y el estado de cada fila/tanda se calcula **en memoria** (`_pppChkStatusFor` +
> `_pppChkBuildMaps`, saldos pre-agregados una sola vez). Cuando el usuario abre el detalle de un
> pedido, esa lectura (la más fresca) **refresca el semáforo de TODO el tablero** con la misma hora,
> sin pegarle de nuevo a la DB. Sigue todo el criterio de la v7.16 (equivalencias 029→437E, empresa
> por NP, familia LK/CH, resta del picking en curso que el cron todavía no escribió) y sigue siendo
> **SOLO LECTURA**. `_pppChkBtn`/`tandaChkBtn` ahora delegan en `_pppChkIcon`; núcleo `pppChkCompute`
> partido para reusar los mapas. Test `tests/ppp-chk-gondola.cjs` extendido (estados del semáforo +
> render del ícono); suite completa OK; render 400px/1100px sin overflow. Bump **v7.45**.
>
> Nota: **v7.43 — Fusión «Productividad» → «Análisis de productividad» + Producción por día 28
> días hábiles + filtro de período en los gráficos**. Tres pedidos del usuario, todos dentro del modal
> **📈 Análisis de productividad** (`#analisisModal`, `openAnalisis`). (1) **Fusión**: el viejo botón/overlay
> **📊 «Productividad»** (rendimiento de operarios, `openProductividad`/`prodRender`) dejó de ser un módulo
> aparte y ahora es una **sección embebida DEBAJO de los gráficos** (`#analisisProdSection` → `#prodBody`,
> tarjeta clara adaptada al modal oscuro). Se quitó el botón «Productividad» del menú supervisor; la CSS de
> las tarjetas se extrajo a **`prodEnsureCss()`** (reusada por `openAnalisis`), y `openProductividad`/
> `closeProductividad` quedaron como **alias** a `openAnalisis`/`closeAnalisis` (compat + smoke-test). La
> sección se carga **una sola vez al abrir** (no en el auto-refresh de 30 s, para no pisar lo que el usuario
> expande/ordena/filtra). (2) **Producción por día**: pasa de 5 a **28 días CONTABLES** (hábiles) con
> **scroll** dentro del recuadro (mismo tamaño; `max-height`+`overflow-y`). Se **ocultan sábados/domingos
> sin m³ pickeado ni pedido**. HOY sigue **en vivo**; el histórico lo trae **`fetchDayTotalsHistory()`**
> (ventana 60 d, agrega TP→pick / TAP→sep por día + empleados = legajos con actividad, cache 5 min). (3)
> **Gráficos Picking y Pedido**: cada uno con su **`<select>` de período** (Última semana · Último mes ·
> Últimos 3/6 meses · YTD · Último año) — estado independiente `_prodPickRange`/`_prodPedRange`, `<select>`
> `#prodRangePick`/`#prodRangePed`, handler `prodChartSetRange`. `fetchProductivityData` ahora **cachea por
> ventana** (`_prodDataCache` = Map por `daysBack`) y usa el helper compartido **`buildM3ByTanda()`**. Se
> **saltean los sábados/domingos sin datos** en el eje X (`prodBuildChartView` + `_anIsWeekend`; los días
> hábiles vacíos quedan como hueco). Verificado: `tests/smoke.cjs` OK (todas las funciones presentes, sin
> pageerrors) + chequeo headless de la lógica nueva (rangos, findes, filtrado). Bump **v7.43**.
>
> Nota: **v7.42 — Impreso de OC: columna «Caja N°» + Falta Pedidos/% Lleno CONGELADOS al generar**.
> Dos pedidos del usuario. (1) **«Caja N°»**: la columna del ejemplo que en v7.39 se había omitido por
> no encontrar la fuente → se encontró en **`Articulos_Cajas.N_Caja`** (catálogo `Cajas`, 14 tipos con
> medidas). El impreso agrega la columna **entre «Uni x Caja» y «% Lleno»**, mostrando la **N_Caja más
> frecuente por código** (desempate: la más chica); "—" si el código no está en `Articulos_Cajas`. Se
> guarda en la nueva columna **`Ordenes_Compra.oc_ncaja`** (nullable). (2) **Congelamiento**: Falta
> Pedidos y % Lleno pasan a llenarse **al momento de generar** y quedar **fijos** (reflejan el estado
> del día de la OC, no el de hoy) → se **eliminó el cron `oc-backfill-diario`** que los refrescaba a
> diario (v7.39). Ambos generadores (`generar_ocs_automaticas` SQL + `ocgGenerar`/`ocgEnter` con la
> nueva `ocgFetchNCaja()` sobre `Articulos_Cajas`) guardan `oc_ncaja`; `ocPrintHtml`/`ocFetchRows` lo
> leen. Las **101 OCs previas** se dejaron con sus valores dinámicos **congelados** tal como estaban, y
> aparte se les rellenó **sólo `oc_ncaja`** con un UPDATE dirigido (92/101 con dato; el resto sin match
> en `Articulos_Cajas`) — sin tocar los valores ya congelados. `oc_backfill_valores` sigue existiendo
> como herramienta MANUAL de reparación (ahora también llena `oc_ncaja`), sin cron. Verificado:
> `tests/oc-print.cjs` extendido (7 columnas + aserción de Caja N°), suite completa OK. SQL en
> `sql/generar_ocs_automaticas.sql` y `sql/oc_backfill_valores.sql`. Bump **v7.42**.
>
> Nota (backend, **sin bump de app**): **OCs viejas imprimían Falta Pedidos / Uni x Caja / % Lleno en
> "—" → backfill + refresco diario**. El usuario imprimió una OC de Oscar (del 29/07, generada ANTES
> de v7.39) y las tres columnas nuevas salían **vacías**: esas OCs no tenían guardados
> `oc_max/oc_pedidos/oc_stock/oc_uni_caja` (los llena el generador desde v7.39, pero las 101 previas
> no). Nueva función **`oc_backfill_valores(p_solo_null)`** que calcula esos valores con la MISMA
> fórmula del generador (Máximo = proy×índice topado a capacidad; Pedidos = demanda neteada por TP;
> Stock = góndola+a_guardar+racks+excedente; Uni x Caja = `OC_Maximos.uni_x_caja`) y los escribe por
> código normalizado — sin tocar `cantidad` (las cajas a pedir) ni las OCs `recibida`. **One-shot**:
> se rellenaron las **101** OCs existentes (0 quedaron sin valores; la de Oscar ahora muestra p.ej.
> 658 → falta 21 / −35%, 758 → falta 14 / −41%, 506 → 0 / 77%). Como **Falta Pedidos y % Lleno son
> estado ACTUAL** (lo que falta cubrir / cuán llena está la góndola hoy, según lo definió el usuario),
> se agregó además un **cron diario** **`oc-backfill-diario`** (`30 9 * * *` = 06:30 AR) que los
> **refresca** en todas las OCs abiertas → el impreso nunca sale vacío ni desactualizado (cubre también
> las de carga manual y el paso del tiempo). Sin cambios en la app (`ocPrintHtml`/`ocFetchRows` ya leen
> esas columnas desde v7.40; sólo se rellenó la data + cron). SQL en `sql/oc_backfill_valores.sql`.
>
> Nota: **v7.41 — «picking difiere de la mesa» ya no infla góndola fantasma**. La regla v4.92
> (`_compDifResolve`, evento **NPD**) devolvía a góndola (`terminado +qty`, `tipo=ajuste`,
> `ref=picking_difiere`) **cada vez** que el armador marcaba *«de menos + no hay en góndola»*. Pero
> cuando el picking ya había descontado bien (real correcto), ese *«de menos»* es un **faltante real
> ya registrado por el PKC** (`esp>real`), y devolverlo creaba **stock fantasma**. Caso real **535 /
> D05B**: PKC `6|3` bajó góndola a **0** y **tres NPD** *«de menos»* (uno **duplicado** por doble tap)
> la subieron a **4**. Ahora la regla **lee el saldo VIVO** de góndola (`vista_saldos_stock`, helper
> `_stkGondolaSaldoVivo`) y devuelve **a lo sumo lo justo para llevar góndola a 0** — sólo compensa si
> el picking la dejó **negativa** (marcó como bajado algo que no estaba); si ya está en 0/+ o no hay
> dato, **no toca el stock**. El aviso NPD (Telegram + tablero) se emite igual. Dato reconciliado: 535
> góndola 4→0. Smoke `tests/comp-dif-nofantasma.cjs`. Bump **v7.41**. (Quedan otros códigos con
> `picking_difiere` viejo — 546/702E/590E/224/031 — con saldo grande donde el fantasma es menor;
> se pueden barrer aparte si se quiere.)
>
> Nota: **v7.40 — Impreso de OC: aclaración de las columnas + orden por % Lleno**. El usuario precisó
> el significado de tres columnas (coinciden con lo de v7.39, se documenta fino) y pidió que las filas
> se **ordenen de menor a mayor por % Lleno**. **Falta Pedidos** = cajas de los pedidos ya programados
> que NO se llegan a cubrir con el stock (= máx(0, Pedidos − Stock)). **Uni x Caja** = unidades del
> producto por caja. **% Lleno** = porcentaje del **espacio de góndola asignado** al producto que
> queda lleno tras reservar los pedidos (= (Stock − Pedidos) / Máximo); es **negativo** cuando hay que
> entregar más de lo que hay (falta pedidos), y en ese caso va en **rojo**. **Nuevo (v7.40)**:
> `ocPrintHtml` ahora **ordena las filas por % Lleno ascendente** (los más negativos / con más falta
> primero, como en la planilla del ejemplo: -33%, -26%, 0%, 28%…); las filas sin % (OCs viejas / de
> carga manual, sin los valores guardados) van al final con "—". Verificado: render headless con las
> filas entrando en orden de código y saliendo ordenadas por %; `tests/oc-print.cjs` extendido con la
> aserción de orden; suite completa OK. Bump **v7.40**.
>
> Nota: **v7.39 — El impreso de la OC usa el formato de la planilla del tallerista** (pedido del
> usuario, con foto de ejemplo). El impreso de "📑 Órdenes de Compra → Imprimir OC" pasó del formato
> genérico (Código · Descripción · Unidad · Cantidad) al de la planilla: **Cod · Descripción · Cajas ·
> Falta Pedidos · Uni x Caja · % Lleno**, con encabezado **tallerista + fecha + Tel** (si la OC trae
> `proveedor_telefono`). Fórmulas confirmadas contra la foto del 29/07: **Cajas** = `cantidad` (a
> pedir); **Falta Pedidos** = máx(0, Pedidos − Stock); **% Lleno** = (Stock − Pedidos) / Máximo
> (negativo = falta, va en rojo, igual que Falta Pedidos). El usuario pidió **omitir** las columnas
> "Lin" y "Caja N°" del ejemplo, y confirmó que "Uni x Caja" sale de `OC_Maximos.uni_x_caja` (el 1 del
> 546 en la foto era error de tipeo). **Para que el impreso sea fiel a la fecha de generación** (no
> recalculando stock/demanda después), cada línea de `Ordenes_Compra` guarda ahora los valores usados:
> **columnas nuevas `oc_max`, `oc_pedidos`, `oc_stock`, `oc_uni_caja`** (nullable), que setean **los
> dos generadores** — el automático (`generar_ocs_automaticas`, SQL) y el manual (`ocgGenerar` →
> `ocgEnter` agrega `it.uni`). El impreso (`ocPrintHtml`) y `ocFetchRows`/`ocGroups` leen esas
> columnas; las OCs viejas o de carga manual (sin esos valores) muestran **"—"** en Falta/Uni/%Lleno.
> Verificado: generación real con `p_forzar` en transacción + `ROLLBACK` (guarda las 4 columnas y las
> derivadas dan bien), render headless del impreso (reproduce la planilla de Lucho), test nuevo
> `tests/oc-print.cjs`, suite completa OK. SQL `sql/generar_ocs_automaticas.sql`. Bump **v7.39**.
>
> Nota: **v7.38 — la solapa «⚙ Ajustes» ofrece TODOS los depósitos en el selector**. Faltaban
> **«Para envasar»** (`para_envasar`) y **«Racks CH»** (`racks_ch`): esos depósitos ya se veían en la
> tabla de *Stocks* (v7.03) pero no se podían **ajustar / fijar / cargar inicial** desde la UI — había
> que hacerlo por SQL (caso real 035E p/envasar y 809E racks CH). Se agregaron los dos `<option>` a
> `stkBodyAjustes` (`#stkAjDep`); el resto ya era genérico (`stockAjustar`/`stockFijar`/`stockGuardarInicial`
> escriben `deposito = _stkDep()` y `stockComputeSaldos` separa el saldo por depósito, línea `m[k][mv.deposito]`).
> Smoke `tests/stk-ajuste-deps.cjs`. Bump **v7.38**.
>
> Nota (backend, **sin bump de app**): **SIMULACIÓN semanal de las OCs automáticas antes del arranque
> real**. El usuario pidió, antes de prender la generación de verdad (prevista **miércoles 12/08,
> pendiente de confirmación**), correr una **prueba** los miércoles 7:00 que haga todos los chequeos y
> la misma cuenta que la real pero **sin generar nada**, y que avise por Telegram el resultado (salga
> bien o mal). Nueva función **`simular_ocs_automaticas()`** (dry-run: misma fórmula que
> `generar_ocs_automaticas` pero es un SELECT, no inserta) que manda **siempre** un mensaje:
> "🧪 SIMULACIÓN OCs automáticas — Generaría N líneas · P prov · C cajas. Top: …" (y "⚠ ya hay N OC(s)
> de hoy → en la real NO se generaría" si aplica), o "🧪🚨 SIMULACIÓN OCs — FALLÓ … <error>" si algo
> revienta; dedup `ocsim_<día>`. **Setup de crons**: se **DESACTIVÓ** `ocs-auto-miercoles` (la
> generación REAL, `active=false`) — si no, generaba de verdad **mañana 05/08** (mañana es miércoles);
> y se creó **`ocs-auto-sim`** (`0 10 * * 3` = miércoles 07:00 AR, activo) que corre la simulación,
> arrancando mañana 05/08 y cada miércoles hasta el go-live. **Switch de go-live** (cuando se
> confirme): `cron.alter_job(... 'ocs-auto-miercoles' ..., active := true)` +
> `cron.alter_job(... 'ocs-auto-sim' ..., active := false)`. Verificado con transacción + `ROLLBACK`
> (sin mandar Telegram): `ok_sim:111` → "Generaría 111 líneas · 19 proveedores · 9489 cajas · Top:
> Poly (1930), Oscar (1464), Lucho (996), Pintos (798), Garcia / Lucho (686)". SQL en
> `sql/simular_ocs_automaticas.sql`.
>
> Nota (backend, **sin bump de app**): **FIX — "✕ Anular este envío" de Recepción no revertía el
> STOCK (fantasma en `a_guardar`)**. Revisando que Recepción de Mercadería interactúe bien con el
> stock. Una recepción escribe en tres lados: `Entregas …`, `Movimientos_Stock` (`a_guardar` +cajas,
> `tipo='recepcion'`) y `Control_Modo_OP`. La RPC **`anular_modo_op(p_id)`** (botón "✕ Anular este
> envío" que sale justo después de confirmar — **no** es el `anular_toggle_virgilio('RT')` de v7.15,
> que cierra la sesión ANTES de mandar) borraba la entrega y marcaba `Control_Modo_OP='anulado'`, y el
> cliente revertía el acumulador de cajas en localStorage… **pero nadie tocaba `Movimientos_Stock`** →
> las cajas quedaban vivas para siempre en `a_guardar`. **Auditoría: sin daño histórico** — las 9
> anulaciones existentes son todas **anteriores** a que recepción empezara a escribir stock (v4.06),
> así que ninguna dejó cajas colgadas (verificado: 0 anulaciones post-arranque con stock vivo); pero
> cualquier anulación de hoy lo corrompía. **Fix**: `anular_modo_op` ahora inserta además un
> movimiento **compensatorio** (`a_guardar −cajas`, `tipo='ajuste'`, `legajo='anula_recep'`,
> `ref='<remito>|ANULA'`, `client_id='anrec_<id>_<cod>'`) por cada código del envío, parseando
> `Control_Modo_OP.detalle` ("cod → cajas · cod → cajas"). Idempotente (early-return `ya_anulado` +
> `client_id` único), acotado a ESE envío (no toca otros que compartan remito), y `tipo='ajuste'` no
> choca con el índice de dedup del pipeline. Verificado con transacción + `ROLLBACK`: envío de prueba
> + su stock → `anular_modo_op()` ×2 → `ok`/`ya_anulado`, saldos `a_guardar` 0/0, 2 compensaciones
> (no dobla), entrega borrada, estado `anulado`. SQL en `sql/anular_modo_op.sql`.
>
> **Resto de la integración Recepción↔Stock: sano.** Conciliación de los últimos ~40 días (153
> remitos): **0 diferencias** entre lo que dice el registro de recepción (`Control_Modo_OP`) y lo que
> entró a `Movimientos_Stock`; **0 pares (remito,código) duplicados** (la dedup por `client_id` de la
> idea 5490 funciona); `delta` siempre > 0; `ref` (remito) siempre presente; y **0 saldos negativos en
> `a_guardar`** (MG nunca sacó más de lo que recepción metió). Los 7 remitos "sin stock" y las filas
> sin `client_id`/`legajo` son todas **previas** al arranque de cada feature (stock v4.06, `client_id`
> ~v6.72, `legajo` idea 7725), no comportamiento actual. RSP ("recibido sin planimetría"), ROC
> (excede OC) y MGX (guardado fuera de lista) emitiéndose OK.
>
> Nota: **v7.36 — el monitor del supervisor ignora legajo 0/1 (pruebas) al mostrar quién empezó
> picking/armado**. Caso real: la tanda **D06C** la pickeó el legajo 122 (EP/TP) y después un **AP
> fantasma de legajo 0** la hacía figurar *"armado por 0 / en curso"* en el tablero. `fetchMonitorEvents`
> (query A → `statusMap.pickLegajo`/`sepLegajo`) era el **único** loop del monitor que no filtraba
> legajo 0/1 (el resto — fichadas, silencios, `getActivityStatus`, `prodCompute` — ya lo hacía); se le
> agregó el mismo `if (leg === "0" || leg === "1") continue;`. Además `facFetchFcKeys` (estado **FC** de
> Facturación) ahora trae `legajo` y descarta 0/1, para que un AP de prueba **posterior a un TAP real**
> no des-marque una tanda ya terminada. Smoke `tests/mon-armado-legajo0.cjs`. Bump **v7.36**.
>
> Nota (backend, **sin bump de app**): **OCs automáticas — aviso de ERROR y "revisá las OCs de hoy"**.
> Dos pedidos del usuario sobre `generar_ocs_automaticas()` (cron `ocs-auto-miercoles`, miércoles
> 07:00 AR). **(1) Si falla, avisa.** Antes moría en silencio y nadie se enteraba hasta mirar la
> pantalla de Compras. Ahora la generación va en su **propio bloque con `exception when others`**: si
> algo revienta, el INSERT se deshace pero el aviso **sí sale** — "🚨 FALLÓ la generación automática
> de OCs — <fecha> / <error SQL + SQLSTATE> / NO se generó ninguna OC. 👉 Generalas a mano…" (dedup
> `ocauto_err_<día>`), y la función devuelve `error: <sqlerrm>` en vez de tirar (el cron no queda en
> `failed` mudo). **(2) La guarda del día ahora mira TODAS las OCs de hoy**, no sólo las `notas like
> 'auto%'`: si alguien generó a mano un miércoles antes de las 7, el cron **no** suma las suyas encima
> (que era el caso nicho que quedaba abierto) y en vez de saltear en silencio manda "⚠ OCs AUTOMÁTICAS
> NO GENERADAS — ya había N línea(s) de hoy (M a mano + K automáticas). No se generó nada para no
> duplicar. 👉 REVISÁ las OCs de hoy…" (dedup `ocauto_skip_<día>`), devolviendo `ya_hay_del_dia:<n>`.
> Los estados posibles quedaron: `ok:<n>` · `sin_items` · `ya_hay_del_dia:<n>` · `error: <sqlerrm>`.
> **Probado sin generar ni mandar nada**, con transacción + `ROLLBACK`: con una OC de hoy →
> `ya_hay_del_dia:1` + aviso encolado; con un check constraint que rompe el INSERT → `error: …` +
> aviso de error encolado; después del rollback quedaron 0 OCs del día, 0 filas en el outbox y 0
> requests colgados en `pg_net`. `sql/generar_ocs_automaticas.sql` actualizado.
>
> Chequeo del seteo (mismo día): cron **activo**, `0 10 * * 3`, base `postgres`; `cron.timezone=GMT`
> → el schedule es **UTC**, verificado contra `job_run_details` (`falta-fact-hoy` `0 11 * * *` corre
> 08:00 AR) ⇒ **07:00 AR los miércoles**. La cuenta del server coincide **exacta** con la del
> generador manual: se compararon los 13 códigos de la pantalla (130, 57, 26, 23, 23, 9, 6, 6, 5, 4,
> 3, 3, 3) y dan igual, incluidos proy/índice/máx/pedidos/stock. Nota: **`xls`** en la columna PROY =
> el artículo **no tiene proyección** en `proyeccion_madre`, así que el Máximo cae al **objetivo del
> Excel** (`OC_Maximos.max_cajas`) y el índice **no se aplica**.
>
> Nota: **v7.1 — idea 3798: CONTEO CÍCLICO de góndola dentro del picking**. Al **terminar un
> picking** (done-screen), `pkPickConteo` elige **al azar UN artículo** de la tanda **de UNA sola
> celda** en góndola (`Capacidad_Sector`; el usuario insistió: sólo 1 celda) y muestra un card ámbar
> **no bloqueante** para que el operario anote cuántas cajas hay **en góndola** (no excedente ni
> racks). Al anotar emite el evento **`CG`** (`texto=COD|contado`) y sigue normal. El trigger
> **`trg_conteo_gondola_telegram`** compara el contado contra el saldo de góndola del sistema
> (`vista_saldos_stock.terminado`, **familia-aware** por empresa) y avisa por **Telegram** con el
> **nombre** del operario (tabla `Empleados`): *"Fulano contó hoy N de COD · ✅ dio igual / ⚠ X de
> diferencia"*. El **historial** ("✅ Confirmado el DD/MM · contó N") se ve en el **detalle de góndola
> del artículo** (`stkOpenMovsArt`, dep `terminado`, banner verde). Detrás del switch
> `Stock_Config.conteo_ciclico_gondola` (**ON** por defecto; ausente = ON). Evento `CG` en la tabla
> de códigos `opcion`. Migración `conteo_ciclico_gondola_telegram_idea_3798`. Smoke
> `tests/pk-conteo-ciclico.cjs`. Bump **v7.1**.
>
> Nota: **v7.33 — Tanda de mejoras de UI (pedido del usuario)** en *Stock y Compras* y en el módulo
> de *Órdenes de Compra*. Seis cambios: **(1)** El botón **«Abastecimiento vs Venta»** se sacó del menú
> de supervisor (*Reportes*); ahora vive **combinado dentro de «% Entregas»** (📑 Órdenes de Compra →
> **📊 % Entregas**): una **sola tabla por artículo** que junta *Fabricación vs Venta (prom 3m)* +
> *Stock vs Pedidos (hoy)* (de `vista_recepcion_mensual` / `vista_venta_mensual` / `vista_stock_vs_pedidos`,
> traídas *lazy* y reusando `abastCompute`) con el *% de entregas de las OC* (pedido vs recibido). Cruce
> por clave normalizada `_ocgNorm`; “—” cuando falta un lado. **(2)** El generador **«⚙ Generar OCs»**
> muestra un **countdown (dd hh mm)** a la próxima automática (cron `ocs-auto-miercoles`, miércoles 07:00 AR),
> calculado en UTC (`_ocgNextAuto`), con timer autolimpiante; el botón de generar **a mano** sigue disponible.
> **(3)** La lista de **Órdenes de Compra** se reorganizó en **3 niveles**: cajas por **fecha** (`OC dd/mm`,
> grid 3×) → cajas por **tallerista** → detalle de la OC (`ocBodyFecha`/`ocOpenFecha`/`_ocDdmm`; `ocBack`
> vuelve un nivel). **(4)** En el pop-up de **Pickeados / A facturar**, los dos botones grandes
> (*Ver NPs/tandas* / *Ver movimientos*) se reemplazaron por un **switch** segmentado (`_stkArtViewSwitch`).
> **(5)** El form **«⚙ Ajustar stock»** (solapa *Ajustes*) usa inputs de ancho fijo (más compacto).
> **(6)** **«📋 Todos los insumos»** ahora es una **sección plegable** (`_stkSec`/`_stkAbierta`, clave
> `todos`) como el resto. Bump **v7.33**. Tests: suite completa verde; `tests/ins-admin.cjs` extendido
> (5 secciones plegables + `todosColapsa`).
>
> Nota: **v7.32 — idea 5703: aviso "la mercadería está en racks / a guardar" al pickear**.
> Cuando al pickear una tanda **faltó** un artículo (PKC con `real < esp`) pero **HAY stock del
> mismo código en `racks` o en `a_guardar`**, ahora se avisa por **dos vías** (lo que pidió el
> usuario) para que lo vayan a buscar y completen el pedido en vez de que salga corto:
> **(1) pop-up al operario** en el momento del TP (`showRacksAguardarPopup`, ámbar, con las NP de
> la tanda) y **(2) Telegram** — el cliente emite el evento **`RAG`** (opcion nueva; texto
> `TANDA|art:falto:racks:aguardar,…`) y el trigger **`trg_racks_aguardar_telegram`** lo reenvía con
> las NP(s) de la tanda. La detección vive en `stockBajaPicking` (al TP), es **familia-aware**
> (`codBase`, suma `437E`+`437E LK`+`437E CH`) igual que el SSG, y sólo dispara si el faltante tiene
> stock en racks/a_guardar (nada de ruido con faltantes genuinos). Dedup 1×/tanda/legajo/día.
> Evento `RAG` documentado en la tabla de códigos `opcion`. `sql/` + migración
> `racks_aguardar_telegram_idea_5703`. Smoke `tests/pk-racks-aguardar.cjs`.
>
> Nota (datos, 2026-08-04): **Unificación de unidades por categoría** (pedido usuario). Operación de
> DATOS sobre Supabase (no de código, sin bump), registrada entera en `Insumos_Historial` (grupo
> 🧾 Historial) + asientos `tipo='ajuste'`. Regla: **Bolsas plásticas → Bolsas**, **Flejes → Kg**,
> **Cajas → Uni/Paquetes**; los que quedan en 0 conservan la unidad correcta. Sólo se borraron
> duplicados **confirmados por el historial de movimientos** (COPIAs, códigos `·` legacy y receptions
> pre-inventario ya contadas en el inicial del 27/07). Resultados clave: `PP`=139 Bolsas (fusión de los
> 3 códigos de POLIPROPILENO 2630), `AI`=44 Bolsas, `PE`=11 Bolsas, `7`=664 / `20`=635,2 / `74`=161 /
> `1060500`=`5`=`25`=0 Kg, `0127`=768 Uni. `4600·ALTO IMPACTO` (−925 Kg) se cerró contra `AI` con
> **25 Kg/bolsa** (se anuló la entrega −750 pre-inventario y la real −175 → −7 Bolsas): `AI` quedó en
> **37 Bolsas**. `Sunchos 12 mm` se movió de Cajas a **Flejes** (Kg). Tras esto, **todo código con
> saldo en estas 3 categorías está en su unidad canónica** (Bolsas / Kg / Uni-Paquetes). Se dejaron
> los códigos ISIS vacíos (`1262500`/`1266500`/`1062500`/`1071500`, en 0). Detalle en
> `sql/insumos_categoria.sql`.
>
> Nota: **v7.31 — Insumos (admin): grupo «🧾 Historial»** (pedido del usuario), debajo de *Categorías*
> en la solapa Administrar Insumos, colapsable (arranca cerrado). Es una **bitácora de sólo lectura**
> que junta **dos fuentes** en una línea de tiempo (lo más nuevo arriba): **(a)** los movimientos de
> stock de insumos (`Movimientos_Stock` con `deposito='insumos'`) — **ingresos** (recepción),
> **egresos** (entrega), **ajustes** y stock **inicial**, con **quién** (legajo), **cuándo** (ts) y
> **cuánto** (delta + unidad); y **(b)** los **cambios de catálogo del admin** que NO mueven stock —
> aceptar/**fusionar** pendientes (las unificaciones), borrar, recodificar, editar, alta manual, y
> altas/bajas de categorías y unidades. (b) se registra en la tabla nueva **`Insumos_Historial`**
> (`id, ts, accion, cod, cod_nuevo, detalle, legajo, datos jsonb`), escrita **sólo** por el helper
> `insumo_hist_log(...)` (SECURITY DEFINER) que ahora invoca **cada** función de mutación de insumos
> (`insumo_alta`, `insumo_identificar`, `insumo_borrar`, `insumo_recodificar`, `insumo_editar`,
> `insumo_cat_guardar`, `insumo_cat_borrar`, `insumo_unidad_guardar`). La anon key **sólo lee**
> `Insumos_Historial` (RLS con policy `ins_hist_select` + grant `SELECT`; se le revocó insert/update/
> delete, y a `insumo_hist_log` se le revocó el execute a PUBLIC): la superficie anon no se ensancha.
> Los **ajustes manuales** de cantidad/unidad y los ceroeos ya vivían en `Movimientos_Stock` como
> `tipo='ajuste'` legajo `admin`, así que aparecen por la vía (a) sin cambios. Front: `_stkInsHist()`
> + `_stkInsHistFetch()` (recarga en cada `stkInsRefresh`), con filtros por grupo (Todo / Ingresos-
> egresos / Ajustes / Cambios de catálogo) y texto (código/detalle/quién). Bump **v7.31**. Test:
> `tests/ins-admin.cjs` (mock de las dos fuentes + orden + filtro). (`origin/main` estaba en v7.30 —
> fix de layout del botón Pausar — al hacer esto; se rebaseó encima.)
>
> Nota: **v7.29 — Insumos: «Agregar insumo» sólo en RECEPCIÓN** (pedido del usuario). En **Entrega de
> insumos (EI)** desaparece el tile `+ Agregar insumo`, tanto el de la grilla de categorías como el de
> adentro de cada categoría, y `insNuevoOpen` **se planta con un aviso** aunque la llamen a mano.
> El criterio: no se puede entregar algo que no existe, y si existe tiene que estar registrado — el
> alta es un acto de **recepción**. Antes se podía sugerir un insumo desde una entrega, lo que creaba
> un `TMP-` cuyo primer movimiento era una **salida**, o sea un saldo negativo desde el minuto cero.
> En RI queda todo igual. Bump **v7.29**.
>
> Nota: **v7.28 — Insumos (admin): la columna «Nombre» pasa a llamarse «Detalle»** en las tres
> tablas de la solapa (Pendientes, el listado de cada categoría y «Todos los insumos») y en el
> placeholder del alta. Es el mismo campo `Insumos.nombre`: lo que cambia es cómo se lo nombra, para
> que coincida con lo que el operario ve al sugerir un insumo («Detalle — qué es, en tus palabras»).
> Bump **v7.28**.
>
> Nota (backend · 2026-08-04): **FIX RLS — la administrativa no veía las bajadas de racks para
> aprobar** ("✓ No hay bajadas pendientes" con 9 propuestas en la base, apiladas desde el 30-07).
> Causa: RLS **por rol**. Recepción (`recepcion.js`) entra con **sesión anónima**
> (`supabase.auth.signInAnonymously()`) → rol **`authenticated`**; el operario (index.html, fetch con
> anon key sin sesión) es **`anon`**. Las policies de `Racks_Bajadas` y `Racks_Ordenes` eran **solo
> `{anon}`** → el operario INSERTA la propuesta pero la admin lee **0 filas**. (`Movimientos_Stock` y
> `Control_Modo_OP` ya eran `{anon,authenticated}`, por eso el resto de Recepción sí le funcionaba.)
> Fix: se agregó `authenticated` a las 6 policies (SELECT/INSERT/UPDATE de las dos tablas) — sin
> exposición nueva (anon y authenticated comparten la publishable key). Barrido: ninguna otra tabla
> anon-only la lee una pantalla authenticated (recepción no toca Insumos/Stock_Config/etc.; fichada/
> monitor/index son anon). `sql/racks_bajadas_rls_authenticated.sql` + migración
> `racks_bajadas_ordenes_rls_authenticated`. **Sin bump de versión** (cambio 100% server-side).
>
> Nota: **v7.27 — Insumos (admin): Cantidad y Unidad editables en TODAS las filas de Pendientes**.
> En v7.22 las dejé de sólo lectura para los códigos viejos, con el criterio de que ahí lo que
> correspondía era fusionar y no reescribir el número — pero el usuario pidió que fueran editables y
> eso manda. Ahora toda fila de Pendientes tiene el input de cantidad y el selector de unidad, venga
> de un operario (`TMP-`) o sea un código viejo, y la corrección se aplica igual para las dos: con un
> **asiento** (`tipo='ajuste'`), no editando el movimiento, y **antes** de renombrar/fusionar, cuando
> todavía está en el código original. El chequeo de unidad permitida por la categoría también corre
> para todas. Sale simple porque desde v7.26 cada código tiene una sola unidad. Bump **v7.27**.
>
> Nota: **v7.26 — Insumos: UN código = UNA cantidad y UNA unidad, edición completa en categorías y
> secciones plegables** (idea 5572, pedido del usuario).
>
> **(1) Un código, una unidad.** Migración `insumos_una_unidad_por_codigo`, en dos pasos porque de los
> **23** códigos que tenían "varias unidades", **6 eran la misma unidad mal escrita** (`kg` vs `Kg`):
> partirlos habría inventado códigos por un problema de tipeo. Primero se **normaliza la grafía**
> contra el vocabulario activo, y recién después se parten los que de verdad difieren: la unidad con
> **más saldo** se queda en el código original y cada una de las otras se lleva a **`<cod>(N)COPIA`**
> con su cantidad y su unidad, heredando nombre, categoría y ubicación. Ej.: `PP` queda con 151
> Bolsas y nace `PP(1)COPIA` con 24 Uni; `942P` se abre en `942P` (1152 s/u), `942P(1)COPIA` (−5 Uni)
> y `942P(2)COPIA` (−2 MC). Se aplicó a los pendientes **y** a los ya categorizados: 23 copias,
> catálogo de 108 → 131, y **0 códigos con más de una unidad**.
>
> **(2) El listado de cada categoría se edita igual que Pendientes**: **Cantidad y Unidad en columnas
> separadas** (antes iba todo junto en una), y ahora también se editan el **código**, la cantidad y la
> unidad. Renombrar un insumo ya clasificado va por `insumo_recodificar`, que le mueve los
> movimientos y **falla si el código destino existe** — fusionar dos stocks sigue siendo una decisión
> que sólo se toma desde «Pendientes».
>
> **(3) Guardar manda sólo lo que CAMBIÓ.** Si tocás nada más la categoría, se manda nada más la
> categoría y el insumo se muda ahí. Para eso `insumo_editar` entiende el marcador `'__sin__'`: antes
> un null significaba "no tocar", así que no había forma de **sacarle** la categoría a un insumo.
>
> **(4) «A depurar» ya no existe en ningún lado** — la fila se borró de `Insumos_Categorias` en v7.24
> y el selector se arma de esa tabla. Si todavía aparece es la app cacheada: se va al recargar.
>
> **(5) Pendientes, Unidades y Categorías son plegables** (`_stkSec` / `stkInsSec`). La tabla
> **«Todos los insumos» queda siempre visible y entera**, sin plegar. Suite completa OK. Bump **v7.26**.
>
> Nota: **v7.24 — Insumos (admin): «a depurar» se elimina, categorías con DETALLE, tabla total y
> bloqueo por unidad no permitida** (idea 5572, pedido del usuario). Cinco cosas:
>
> **(1) «A depurar» dejó de existir como categoría.** Lo que no tiene categoría definida es
> simplemente **Sin categoría**, y eso es lo que lo mete en «Pendientes de identificar»: algo sin
> clasificar es algo que espera una decisión. Los 43 códigos viejos pasaron a `categoria = null` y la
> fila `depurar` se borró de `Insumos_Categorias`. Las guardas de `insumo_identificar` /
> `insumo_borrar` ahora miran **"sin categoría"** en vez de `'depurar'`: un insumo **ya clasificado**
> (= en uso) sigue sin poder renombrarse, fusionarse ni borrarse. En la botonera del operario esos
> códigos caen en la tarjeta **❓ Sin categoría**, con su aviso, y no cuentan entre los "en uso".
>
> **(2) Cada categoría tiene un DETALLE** (`Insumos_Categorias.descripcion`): qué entra en el grupo.
> Se ve debajo del nombre y se edita junto con el resto. Las 5 quedaron descriptas.
>
> **(3) Tabla «📋 Todos los insumos» al final, SÓLO LECTURA**: la foto completa del catálogo, con
> **filtros por código, nombre, categoría, rack/sector, cantidad (≥) y unidad**. No edita nada — para
> cambiar algo se usa la sección de arriba que corresponda — y **se actualiza sola** porque sale del
> mismo `items` que el resto, y todas las acciones terminan en `stkInsRefresh()` + `stkRender()`.
>
> **(4) Una unidad NO permitida por la categoría se rechaza** (`insUniPermitida`), en los tres
> lugares donde se puede elegir: el pop-up de cantidad del operario (el chip prohibido sale tachado
> en rojo con ⛔ y "Listo" queda deshabilitado), su pantalla de alta, y el "Aceptar" del admin. El
> envío (`insConfirmar`) corta y abre el que está mal. ⚠ La comparación **no distingue mayúsculas**:
> en los datos conviven `Kg` y `kg`, y bloquear por eso sería un falso positivo.
>
> **(5)** El chip de cada unidad muestra cuántos la usan. Suite completa OK. Bump **v7.24**.
>
> Nota: **v7.22 — Insumos (admin): Cantidad/Unidad separadas, Aceptar o Borrar, y unidades arriba**
> (idea 5572, pedido del usuario). Cinco cosas:
>
> **(1) «Unidades» se partió en dos columnas**: **Cantidad** (el número) y **Unidad** (la medida de ese
> código). En los `TMP-` las dos se corrigen; en un código viejo se muestran —si arrastra saldo en
> varias unidades va una línea por unidad, los negativos en rojo— porque ahí lo que corresponde no es
> reescribir el número sino fusionarlo.
>
> **(2) Las acciones son sólo dos: ✓ Aceptar y 🗑 Borrar.** Desapareció "Identificar / fusionar":
> **Aceptar** le pone el código real y le lleva el stock, y **si ese código ya existe avisa que los
> saldos se SUMAN** (es la fusión, pero el admin no tiene que saber cómo se llama). **Borrar** lo saca
> del catálogo: si tiene saldo, avisa y lo **deja en 0 con un asiento** antes de borrarlo —
> necesario porque el modal del operario lista defensivamente cualquier código con saldo ≠ 0 aunque
> no esté en el catálogo, y si no se cerorea el borrado reaparecería. También se fue "Descartar", que
> mandaba a «a depurar»: como esa categoría ahora ES esta lista, no resolvía nada.
>
> **(3) No se puede crear un código que ya está en uso.** `insumo_alta` venía con
> `on conflict do nothing`: la fila no se creaba pero la app decía "✓ creado". Ahora la función falla
> con el motivo y el front además chequea antes de mandar, diciendo con qué insumo choca. Lo mismo al
> aceptar una sugerencia del operario contra un código ocupado.
>
> **(4) «Unidades con las que trabajamos» pasó ARRIBA de Categorías** — primero el vocabulario,
> después quién lo usa.
>
> **(5) Sacar una unidad EN USO avisa con detalle**: lista las **categorías que la permiten** y los
> **insumos con saldo** en ella (hasta 8, y cuántos más), aclara que el stock no se toca y que lo que
> cambia es que el operario deja de poder elegirla. Cada chip muestra un contador de uso. Si no la usa
> nadie, la confirmación es la simple. Suite completa OK. Bump **v7.22**.
>
> Nota: **v7.21 — Botón "⏸ Pausar" en el asistente de armado (AP)** (pedido del usuario). Antes el
> asistente "Completar" (que se abre al tildar AP) sólo tenía **"Terminar" (TAP)**: para ir a hacer
> otra tarea había que recargar la app. Ahora hay un botón **"⏸ Pausar"** al lado de Terminar que
> **sale sin terminar**: no manda TAP, deja la tanda **pendiente** (`st.armado.active` sigue en true)
> y el avance persistido en localStorage; en la pantalla del operario aparece **"▶ Seguir armado
> tanda X · Paso N"** para retomarlo donde quedó (sin re-mandar AP). La pausa **no cuenta** en el
> tiempo de armado (prodCompute ya descuenta del tramo AP→TAP lo que se haga en el medio). Nueva
> función `compPausar()`; smoke `tests/comp-pausar.cjs`. Bump **v7.21**.
>
> Nota: **v7.20 — Fuera el piloto de "Picking con lectora"**. El usuario decidió que no lo van a
> usar, así que se sacó de la app (no quedó apagado: se borró). Se fueron: el **switch del operario**
> en la botonera (`_pkScanOperRow`, el que se veía como "🔫 Picking con lectora (piloto)"), la
> **tarjeta del switch en Print Station** (admin), el **listener de la lectora** (`pkScanBind` +
> `pkScanOn/SetOn/Toggle/AllowedLegajo`, `pkOnScan`, `pkScanToast`, EAN) y el **FALTA diferido** que
> existía sólo para el scanner (`pkFaltaPend`, `_pk.faltaPend` en `pkSave`/`pkResume`/`pkRenderDone`
> y `pkConfirmFaltaBatch`, la pantalla "¿Cuántas cajas pusiste?" en lote). El picking queda como
> siempre: botonera Todas / Algunas / Sin stock, artículo por artículo. **Se conservó**
> **`_pkItemCodes`** (acepta el código pelado además del partido por empresa, idea 9020) porque es
> del cruce de códigos, no de la lectora. Se borró `tests/pk-scan.cjs` (y su línea de `run.sh`) y se
> podaron del `emp-np.cjs` las dos aserciones que eran del scanner (`_pkNum3`). `tools/etiquetas-
> gondola.html` **queda** (imprimir etiquetas de góndola sirve igual) y `docs/idea-picking-scanner-
> etiquetas.md` pasó a `docs/archivo-idea-picking-scanner-etiquetas.md` con el cartel de descartada.
> Suite completa OK. Bump **v7.20**.
>
> Nota: **v7.19 — Insumos: «a depurar» se vuelca en Pendientes (+ FUSIÓN) y borrar categoría pide
> escribir el nombre** (idea 5572, pedido del usuario).
>
> **(1) «A depurar» dejó de ser una categoría escondida y vive dentro de «Pendientes de
> identificar»**: son las dos caras de lo mismo — algo que espera una decisión del admin. La sección
> muestra los dos tipos juntos (los `TMP-*` que sugirió un operario y los **43 códigos viejos**), con
> el origen marcado en cada fila. La caja de «A depurar» ya no aparece en Categorías.
>
> **(2) FUSIÓN — el camino para netear los negativos.** `insumo_identificar` ahora acepta también los
> `depurar`, y si el código destino **ya existe** mueve los movimientos ahí y borra la fila vieja: los
> saldos se **suman**. Eso es exactamente lo que resuelve `505C·CUCHILLA CHINA` (−16.000) contra
> `2955`, sin SQL a mano. Pide confirmación diciendo qué se fusiona con qué. ⚠ La fusión **sólo** sale
> desde `depurar` — desde un `TMP-` se rechaza, porque juntaría el stock de dos insumos sin que nadie
> lo haya decidido — y un insumo **en uso** no se puede ni identificar ni borrar. Los códigos viejos
> **sin ningún movimiento** (9 de los 43) se borran del catálogo con `insumo_borrar`; con movimientos
> no se borran, se fusionan. La cantidad/unidad sólo se editan en los `TMP-`: en un código viejo con
> saldo lo que corresponde es fusionarlo, no reescribirle el número.
>
> **(3) Borrar una categoría pide escribir su nombre exacto.** Le cambia la pantalla a todos los
> operarios, así que un OK al voleo no alcanza: el prompt explica qué implica y compara el texto.
> Además, si la categoría tiene insumos adentro ni siquiera llega a preguntar.
>
> **(4) El operario relee la meta en CADA apertura** de RI/EI (`insLoadMeta(true)`): si el admin
> renombra una categoría o agrega una unidad, se ve en la próxima entrada sin recargar la app.
> `tests/ins-admin.cjs` lo verifica de punta a punta — mete en «la base» una categoría que **no**
> existe en el fallback hardcodeado y comprueba que el operario la muestra, con su insumo adentro y
> su unidad preseleccionada. Suite completa OK. Bump **v7.19**.
>
>
> Nota: **v7.18 — OCs AUTOMÁTICAS los miércoles 7:00, con la fórmula de stock que pidió el usuario**.
> Dos cosas. **(1) NUEVA DEFINICIÓN de stock y demanda** (vale para el generador automático **y** para
> el manual, así dan lo mismo): **Stock disponible = góndola (`terminado`) + `a_guardar` + `racks` +
> `excedente`** — antes eran sólo góndola+racks+excedente, ahora **suma lo que está "a guardar"** (ya
> llegó, es stock). **NO** entran `separar_pedidos` (pickeado), `a_facturar`, facturado/FC sin salida,
> `racks_ch` ni `para_envasar`. Y del otro lado **NETEA**: un pedido deja de contar como **Pedidos**
> (demanda) cuando su mercadería ya salió de la góndola, o sea cuando **su tanda tiene `TP`**
> (picking terminado) — su stock está en `separar_pedidos`, que tampoco se cuenta, así que no se pide
> dos veces lo mismo. Los pedidos **"en armar" sin ningún artículo marcado** o **sin empezar** (tanda
> sin TP) **SÍ cuentan** como demanda. En el front: `stockN` suma `a_guardar` y `ocgDemanda(porEmpresa,
> soloNoPickeadas)` acepta el flag nuevo — lo usa **sólo** el generador de OCs (`ocgEnter`), la tabla
> de Stock sigue mostrando la demanda completa; falla **abierto** (si no puede leer los TP cuenta todo,
> antes que sub-pedir). **(2) GENERACIÓN AUTOMÁTICA**: función **`generar_ocs_automaticas(p_forzar)`**
> (SQL, replica exactamente la fórmula del manual: `A pedir = ceil(máx(0, Máximo + Pedidos − Stock))`,
> `Máximo = proyección × índice` topado a capacidad, proveedores internos afuera) + cron
> **`ocs-auto-miercoles`** `0 10 * * 3` = **miércoles 07:00 AR**. Las líneas entran en
> `Ordenes_Compra` con `notas='auto <fecha>'`, estado `pendiente`, rubro `Art Term` → la **Recepción de
> Mercadería las ve como OC vigente al toque** (los botones "OC N", v7.07). Es **idempotente por día**
> (`ya_generada`) y avisa por **Telegram** al terminar. Prueba en seco del 04/08: **104 líneas · 19
> proveedores · 9.198 cajas** (165 NPs sin facturar → **138** cuentan; 27 ya pickeadas se netean).
> SQL en **`sql/generar_ocs_automaticas.sql`**. `tests/ocg-norm.cjs` extendido: verifica que
> `a_guardar` suma, que pickeado/a-facturar **no** suman, y el neteo de la demanda (8 de 15 cajas).
> Bump **v7.18**.
> Nota: **v7.17 — Administrar Insumos: categorías y unidades EDITABLES + pendientes con todo a mano**
> (idea 5572, pedido del usuario). Lo que estaba hardcodeado en `index.html` pasa a tablas que el
> admin edita, y **lo que define ahí es exactamente lo que ve el operario** al sugerir un insumo.
>
> **(1) Pendientes de identificar** (primera sección de la solapa) — cada fila es **editable entera**:
> **Código** (viene con el temporal **sugerido**, y no deja identificar si lo dejás así) · **Nombre**
> (el detalle que escribió quien lo recibió) · **Categoría** (la que sugirió) · **Ubicación** ·
> **Unidades** (antes decía "Saldo": ahora la **cantidad y la unidad son corregibles**). La corrección
> de cantidad/unidad se hace con **asientos** (`tipo='ajuste'`), no editando el movimiento — el log es
> append-only; si cambia la unidad saca todo de la vieja y pone en la nueva, y se postea **antes** de
> renombrar, cuando el movimiento todavía está en el código temporal. Se sacó la columna **Orden** (la
> columna `Insumos.orden` queda y el orden manual sigue mandando si se carga por SQL, pero ya no
> tiene UI).
>
> **(2) Categorías** — tabla nueva **`Insumos_Categorias`** (`clave, nombre, emoji, unidades[], orden,
> activa`). Se les cambia el **nombre**, el emoji y las **unidades permitidas**, se crean y se borran
> (sólo si están vacías; «a depurar» nunca). `unidades` reemplaza al viejo `uni` único: **una sola** =
> unidad fija · **varias** = el operario elige entre ésas · **ninguna** = cualquiera de las activas.
> **El listado de insumos de cada categoría y el botón de agregar viven ADENTRO de la categoría**
> (se despliega con "Ver insumos"): ahí se edita nombre/ubicación, se mueve de categoría y se dan de
> alta con código.
>
> **(3) Unidades con las que trabajamos** — tabla nueva **`Insumos_Unidades`**. Es el vocabulario de
> medidas que ve el operario; se agregan y se sacan (sacar **no toca** el stock ya cargado con esa
> unidad, sólo deja de ofrecerse). Se sembró con las 6 en uso + las que aparecían en movimientos;
> quedaron inactivas tres de basura (`325`, `unidad`, y `kg` que es `Kg` con otra grafía). El "+" de
> unidad del **operario** ahora escribe en esta tabla (antes iba a `localStorage` y moría en su
> celular).
>
> `INS_CATS` / `INS_UNIS` pasan a cargarse de la base (`insLoadMeta`), con los valores actuales como
> **fallback** si no hay red. Funciones nuevas: `insumo_cat_guardar` / `insumo_cat_borrar` /
> `insumo_unidad_guardar`, y `insumo_identificar` toma también la ubicación. Todas SECURITY DEFINER:
> el anon key sigue sin UPDATE directo. `tests/ins-admin.cjs` reescrito para las tres secciones;
> suite completa OK. Bump **v7.17**.
>
> Nota: **v7.16 — PPP: botón 📦 "Chequeo de góndola" por pedido (y por tanda)** (pedido del
> usuario). Al lado del 🖨 de cada pedido de la PPP hay ahora un botón **📦** que responde
> *"¿tengo en góndola todo lo que necesito para armar este pedido?"* y, si falta algo, lo
> **detalla artículo por artículo**. El mismo botón está en la **franja de la tanda/bloque**
> (chequea todos sus pedidos JUNTOS, que es lo correcto: comparten la misma góndola).
> **Qué cruza:** lo que **pide** el pedido sale de **`PPP_Base_Pedidos`** (`pedido, articulo,
> cajas` — la misma base que arma el picking) y lo que **hay** de **`vista_saldos_stock`**
> (respeta el `cutoff_ts` de `Stock_Config`), depósito **`terminado` = góndola**. Cada artículo
> queda en uno de tres estados: **✅ OK** (góndola ≥ pedido) · **🔁 Bajar N** (no alcanza en
> góndola pero hay en **excedente / racks / racks CH / a guardar / p-envasar** → se resuelve
> moviendo) · **🚨 Faltan N** (no está en **ningún** depósito). Los problemas van primero;
> cada fila muestra descripción, **📍 sector** de planimetría y dónde está lo que falta.
> ⚠ **"Stock REAL al momento del chequeo"** (lo pidió explícito el usuario): la lectura es
> siempre **fresca** (`cache:"no-store"`, sin cachés del front) **y** se corrige el desfasaje
> conocido del pipeline — la baja de góndola del picking **recién se escribía cuando la tanda
> mandó TP**, así que lo que un operario estaba sacando de la góndola AHORA (picking en curso)
> todavía figuraba en el saldo. ⚠ **Corrección (2026-08-08):** desde el trigger
> `trg_tp_reconciliar_stock` (AFTER INSERT en `Registros_Produccion_Virgilio` cuando
> `opcion='TP'`, ejecuta `reconciliar_pipeline_stock_etapa1()` al toque) la ETAPA 1 del pipeline
> ya **no espera al cron `reconciliar_pipeline_stock` (jobid 22, cada 10')** — corre apenas se
> guarda el TP. El hueco de **"TP reciente, cron todavía no corrió (hasta 10')"** que este párrafo
> documentaba está **cerrado**; sigue existiendo, sin cambios, el caso del **picking en curso sin
> TP todavía**, que es justo lo que el chequeo resta a mano: los **PKC de las tandas que aún no
> tienen movimiento `picking` escrito** (excedente primero y después góndola, **igual reparto
> que el cron**), avisándolo en el modal ("⏳ Descontado del saldo el picking de N tanda(s)…").
> Además, si la tanda ya se pickeó / se está pickeando, lo dice. **Códigos:** `equivResolve`
> (029→437E) + `pkCodEmpresa` (437E→`437E CH` según la NP) igual que el picking; si el código
> queda **pelado** se suma **toda la familia LK/CH** (mismo criterio que el SSG v7.04 — es la
> misma mercadería física). **Es SOLO LECTURA**: no mueve stock, no reserva y no emite ningún
> evento (si otra tanda pide el mismo artículo, se lo lleva el que pickee primero — está
> aclarado en el pie del modal). Funciones nuevas: `pppChequeoNp` / `pppChkCompute` (núcleo
> puro, testeable) / `_pppChkPicksPendientes` / `_pppChkFetchSaldos` / `_pppChkBody` /
> `_pppChkBtn` / `pppChkReintentar` / `pppChkClose`, más `_pppArg` (escapa un texto para
> meterlo entre comillas simples dentro de un `onclick` — sin eso una razón social con
> apóstrofo, "D'Onofrio", rompía el handler). Test nuevo **`tests/ppp-chk-gondola.cjs`** en
> `tests/run.sh`; suite completa OK; render a 400px y 1100px sin scroll lateral. Bump **v7.16**.
>
> Nota: **v7.15 — "Anular recepción": el botón rojo también en Recepción de Mercadería**. El usuario
> avisó que veía el de picking pero no el de recepción (v7.13 había cubierto picking + insumos). En
> `recepcion.js` (`?v=3.80`) se agregó la barra **`#opAnularBar`** con **"✕ Anular recepción"**, que
> vive **fuera de `#opBody` y `#opActions`** — los render de cada paso reescriben esos dos, así que
> desde afuera queda visible en TODOS los pasos del operario sin tocar ninguna pantalla. Se prende en
> `openOp`/`reanudarRecepcionOp` y se apaga en `closeOp` y en `renderMenu` (el supervisor que entra
> por Administración no tiene sesión RT que anular). `opAnularSesion()` confirma, avisa a Producción
> por **`window.anularRecepcionSesion(legajo)`** (nuevo en `index.html`) y cierra la pantalla dejando
> el estado vacío → el borrador se descarta solo. El hook cierra el **toggle RT** del legajo, saca el
> RT de la cola y del historial del día, pone en **0** el acumulador de cajas (`recepcionResetCajas`)
> y llama a la RPC **`anular_toggle_virgilio(legajo,'RT')`** — se le agregó `'RT'` al whitelist, antes
> sólo `RI`/`EI`. **Guarda importante**: si en esa sesión el operario YA mandó entregas, el hook pide
> una **2ª confirmación** aclarando que se anula el RT (la tarea) pero **no** la mercadería recibida,
> y devuelve `false` si dice que no. `tests/anular-sesion.cjs` cubre ahora las tres pantallas (la de
> recepción con el módulo cargado aparte, igual que `rcp-reanudar`). Bump **v7.15**.
>
> Nota: **v7.14 — ADMINISTRAR INSUMOS: solapa nueva en Stock y Compras + identidad temporal**
> (idea **5572** del usuario). Dos mitades del mismo pedido.
>
> **(A) Identidad temporal asignada por el sistema.** Cuando el operario da de alta un insumo desde
> RI/EI, la clave ya no es el texto del detalle (`NUEVO·<DETALLE>`, v7.10) sino un número que asigna
> el servidor: **`TMP-0001`, `TMP-0002`, …** vía la función `nuevo_insumo_tmp(detalle, categoria,
> legajo)`, y el detalle queda como **descripción**. El motivo: con el texto como clave, dos formas de
> escribir lo mismo creaban dos insumos y un typo quedaba clavado en el `cod_art` de los movimientos.
> Sin red cae a `TMP-L<legajo>-<hhmmss>` (numerar sin servidor arriesga que dos celulares saquen el
> mismo número); el movimiento sale igual por `stockMove`, que ya es offline-safe. En la botonera se
> ven como **🆕 TMP-000N** y no se pueden mandar hasta que el servidor devolvió el número. El alta
> ahora dedupe por **detalle normalizado** (antes por código, que ya no existe).
>
> **(B) Solapa 🧰 Insumos** (`stkBodyInsumos`), entre *Capacidad* y *Ajustes*:
> **(1) Pendientes de identificar** — los `TMP-*` que cargaron los operarios, con lo que escribieron,
> su saldo y el legajo. Se les pone código + nombre + categoría y **el stock ya cargado se mueve al
> código nuevo** (`insumo_identificar` renombra en `Insumos` **y** en `Movimientos_Stock`), o se
> descartan a *a depurar* (no se borran: pueden tener stock). **(2) Catálogo** — filtro por categoría
> y por texto; se edita nombre, categoría, ubicación y **orden**. **(3) Alta con código real**.
>
> **El `orden` que fija el admin manda sobre el orden automático** de la botonera (`_insSortCat`
> envuelve a `_insSortAuto`): vacío = automático (flejes por medida, el resto por saldo).
>
> ⚠ **Seguridad**: el anon key sólo tiene INSERT+SELECT (el log de stock es append-only a propósito).
> Para no abrirle UPDATE a las tablas, cada acción va por una función **SECURITY DEFINER** con su
> validación adentro: `insumo_identificar` **sólo** acepta origen `TMP-*` (no se puede usar para
> renombrar stock real) y **se niega a fusionar** contra un código que ya existe; `insumo_alta`
> rechaza códigos `TMP-` a mano; `nuevo_insumo_tmp` exige detalle. Verificado contra la base real
> (rename + guardas + limpieza). Columnas nuevas: `Insumos.orden`. Ver `sql/insumos_categoria.sql`.
>
> Bonus: el CSS del modal de insumos se extrajo a `insEnsureCss()` porque la solapa admin usa los
> mismos chips de categoría. Test nuevo `tests/ins-admin.cjs` + `ins-categorias.cjs` actualizado;
> suite completa OK. Bump **v7.14**.
>
> Nota: **v7.13 — "Anular picking" / "Anular insumos": salida clara de una sesión empezada por
> error**. Pedido del usuario: al empezar el picking de una tanda no había forma de darla de baja —
> "Cerrar" sólo sale del modal y el picking queda **abierto** (EP sin TP = inconsistencia tipo A), con
> la **tanda reservada** en `Tandas_Lock` y el operario sin poder arrancar otra. Ahora, **abajo de
> todo** de la sesión, hay un botón grande rojo. **(1) PICKING**: pie FIJO del modal
> (`.tanda-modal-foot`, lo pinta `pkFootRender` desde `pkRender`, así aparece en todos los pasos y en
> el resumen; `closeTandaModal` lo limpia porque el modal lo reusan otros flujos) con **"✕ Anular
> picking"**. `pkAnular()` pide confirmación y: saca de la **cola local** el EP y los PKC de esa tanda
> (si no, se re-mandaban los que borramos), llama a la RPC **`anular_picking_virgilio(legajo, tanda)`**
> — borra el EP abierto + sus PKC y hace `tanda_liberar` —, suelta la reserva también desde el cliente,
> deja `picking = {active:false}`, borra el avance guardado (`vir_pk_<legajo>`) y saca EP/PKC del
> historial del día. Después puede marcar EP de nuevo. **(2) INSUMOS (RI/EI)**: mismo criterio, botón
> **"✕ Anular recepción/entrega de insumos"** debajo de "Registrar entrada/salida" (`insAnular()` →
> RPC **`anular_toggle_virgilio(legajo,'RI'|'EI')`**, descarta el borrador `opDraft` y cierra el toggle
> con `closeIns`). **Por qué RPC y no DELETE directo**: la policy de delete con la anon key sólo
> alcanza lo creado hace **<15 min** (`delete_recientes_undo`, la del "Deshacer"), y un picking se
> anula bastante después. Las dos funciones son `SECURITY DEFINER` con guardas: sólo el evento de
> **apertura que sigue abierto**, del propio legajo, de las últimas **24 h**; devuelven `ok` /
> `sin_ep` / `sin_apertura` / `ya_cerrado` / `faltan_datos` (mismo patrón que `anular_modo_op` de
> recepción). Si dice `ya_cerrado` la app limpia igual la pantalla para no dejar trabado al operario.
> SQL en **`sql/anular_sesion_virgilio.sql`**; probadas en Supabase (EP+PKC de prueba → `ok` → 0
> filas). Test nuevo **`tests/anular-sesion.cjs`** en `tests/run.sh`; suite completa OK. Bump **v7.13**.
>
> Nota: **v7.12 — El "Reanudar recepción" se movió de la pantalla inicial a la botonera**. Pedido del
> usuario: sacarlo de "Resumen de hoy" y darle **el mismo formato que el "▶ Seguir picking"** de una
> sesión interrumpida. Ahora lo dibuja **`renderPendingSuggestion`** (dentro de `#pendingSuggestion`,
> junto a "▶ Seguir picking" / "▶ Seguir armado" / "▶ Seguir …"), con la misma clase `primary-btn`:
> **"▶ Seguir recepción Lucho (2 cód · 19 cajas)"** → `reanudarRecepcion(legajo)`. Se revirtió todo lo
> que v7.09 había agregado a `renderLegajoHistory` y su CSS; el borrador de `recepcion.js` no cambió,
> sólo **dónde** se ofrece retomarlo (`window.onRecepcionDraftChange` repinta la sugerencia en vez del
> resumen). `tests/rcp-reanudar.cjs` actualizado (el botón va en la botonera y **no** en "Resumen de
> hoy"). Bump **v7.12**.
>
> Nota: **v7.11 — Insumos: taxonomía definitiva (5 categorías) + el alta arranca por el Detalle**
> (lo fijó el usuario). **(1) Las categorías quedaron así**: 🧪 **Plásticos** (9, todos en **Bolsas**) ·
> 🧵 **Flejes y alambres** (32, todos en **Kg**) · 🌎 **Importados** (13 — ex *Partes inox* + *Espirales*,
> **unidad libre**) · 🧩 **Partes plásticas** (3 — ex *Mangos*, **unidad libre**) · 📦 **Cajas** (8,
> Paquetes/Uni), más 🗑 *A depurar* (43) fuera del listado. **(2) "Unidad libre" = NO se preselecciona
> ninguna**: en Importados y Partes plásticas cada insumo mide distinto, así que el chip arranca vacío y
> el operario tiene que elegir. Y **sin unidad el movimiento NO se manda**: `insConfirmar` corta, nombra
> los que le falta y abre el primero. Antes caía a `"Uni"` por defecto, que es exactamente lo que venía
> **partiendo los saldos** (PP quedó con 151 Bolsas **+ 24 Uni**). El botón del insumo muestra
> `4 ¿unidad?` en ámbar mientras falte. **(3) El alta empieza por el DETALLE** —lo único que el operario
> sabe seguro— y **se sacó el campo de código**: el código real se lo asignan después desde Stock y
> Compras. La identidad sigue siendo `NUEVO·<DETALLE>`. Migración de datos: `inox`+`espirales` →
> `importados`, `mangos` → `partes_plasticas` (ver `sql/insumos_categoria.sql`). ⏳ La taxonomía
> todavía vive en dos lados (`INS_CATS` en index.html + la tabla `Insumos`): el módulo para manejarla
> desde **Stock y Compras** —con las sugerencias `NUEVO·` de los operarios, el orden de los insumos y el
> alta con código— quedó anotado como **idea 5572**. `tests/ins-categorias.cjs` extendido (orden de los
> campos del alta, categorías sin default, bloqueo por unidad faltante); suite completa OK; render 390px
> sin overflow. Bump **v7.11**.
>
> Nota: **v7.10 — Insumos: ALTA de un insumo nuevo desde la botonera** (pedido del usuario). En la
> grilla de categorías de RI/EI hay ahora un tile **`+ Agregar insumo`** (y otro dentro de cada
> categoría) que lleva a una **pantalla de alta** propia: **categoría** (las 6 + **"Sin categoría
> clara"**) · **cantidad** · **unidad** · **detalle** en las palabras del operario. Lo importante:
> **no pide código**, porque el operario no tiene por qué saberlo cuando llega algo que no está en
> ninguna lista. La identidad la arma el sistema como **`NUEVO·<DETALLE>`** — el prefijo los deja
> encontrables de un saque para asignarles el código real después — y hay un campo **opcional** de
> código de 7 dígitos para cuando sí se sabe, así no se genera un huérfano al pedo. Elegir la
> categoría **propone su unidad sola** (Plástico ⇒ Bolsas…) salvo que el operario ya haya tocado
> otra; si el detalle ya existe **no se duplica**, se abre el que hay para que sume. Con cantidad
> queda cargado directo; sin cantidad se abre el pop-up para que la ponga. Además las unidades
> base pasaron de `Uni/Paquetes/Kg` a **`Uni/Kg/Bolsas/Paquetes/MC/Cajas`** (las que realmente se
> usan: antes había que apretar "+" y tipear "Bolsas", que es lo más común del sector AF).
> Reemplaza el alta vieja (`insCrear`, que pedía código de 7 dígitos **o** sector + descripción y
> vivía embutida en el listado). Funciones nuevas: `insNuevoOpen` / `insNuevoOk` / `insNuevoPick` /
> `insNuevoCancel` / `insNuevoAddUni` / `insCrearItem` / `_insNuevoHtml`. ⚠ **Los `NUEVO·` hay que
> reconciliarlos**: mientras no tengan código real no cruzan con el maestro de artículos.
> `tests/ins-categorias.cjs` extendido (alta completa, "sin categoría clara", validaciones, unidades
> ofrecidas); suite completa OK; render 390px sin overflow. Bump **v7.10**.
>
> Nota: **v7.09 — Recepción a medio cargar: no se pierde y se REANUDA desde "Resumen de hoy"**.
> Pedido del usuario: si el operario arranca una recepción y se va para atrás o cierra la pantalla,
> antes perdía todo (tallerista, línea, remito y las cajas ya marcadas) y tenía que empezar de cero.
> Ahora `recepcion.js` (`?v=3.78`) deja un **borrador** en `localStorage`
> (`vir_recepcion_draft_<legajo>_<día>`) con el paso exacto donde estaba + todo el estado; se guarda
> en cada paso (elegir línea, remito, cada cambio de cajas, resumen) y al salir (`closeOp`). En
> **"Resumen de hoy"** aparece, colgado de la fila **RT** más reciente (o como tarjeta propia si esa
> fila no está), el bloque ámbar **"📦 Recepción sin terminar — Lucho · LK · RTO/FC 38770 · 2 códigos
> · 19 cajas ya marcadas"** con el botón **"▶ Reanudar"** (`recepcionDraftHtml` / `reanudarRecepcion`
> en `index.html`), que llama a **`window.reanudarRecepcionOp(legajo, día)`** y reabre el módulo **en
> el mismo paso**. El borrador se borra al **enviar** la recepción y al **empezar una nueva** (RT otra
> vez); es **por legajo + día** (los de días viejos se limpian solos al leer) y el **supervisor** que
> entra por Administración **no** deja borrador. `recepcion.js` avisa los cambios con
> `window.onRecepcionDraftChange` → Producción repinta el resumen y el botón aparece/desaparece solo.
> De paso, `renderLista` ahora carga los talleristas si faltan (al reanudar se entra directo a un paso
> interno, y el "‹ Atrás" hasta la lista quedaba vacío). Test nuevo **`tests/rcp-reanudar.cjs`** (las
> dos mitades: el borrador en `recepcion.js` y el botón en `index.html`; sirve la página por
> `route()` con origen http real porque `localStorage` no funciona en `about:blank`) en
> `tests/run.sh`; suite completa OK. Bump **v7.09**.
>
> Nota: **v7.08 — Insumos (RI/EI): navegación por categorías con la MISMA FORMA que RT**
> (pedido del usuario sobre la 7917). Los chips de la v7.05 mostraban todos los insumos de una,
> en filas. Ahora es el mismo gesto que la **Recepción de Mercadería** (`recepcion.js`), que el
> operario ya conoce: **pantalla 1** = grilla de **categorías** en botones cuadrados (emoji +
> nombre + cuántos insumos tiene + cuántos lleva cargados) → tocás una y entrás a la **pantalla 2**
> = grilla de los **insumos de esa categoría** (código grande + descripción + 📍 ubicación) →
> tocás uno y se abre el **pop-up de cantidad** (–/+ grandes, chips de unidad, aviso de negativo),
> igual que el pop-up de cajas de RT. **`‹ Atrás`** vuelve a las categorías **sin perder lo
> cargado**: se puede cargar de varias categorías y mandar todo junto con **✓ Registrar (N)**.
> El botón del insumo cargado queda pintado con su cantidad, y la tarjeta de la categoría muestra
> "N cargados". El **buscador** de la pantalla 1 mira **todo** (incluso lo que está a depurar);
> dentro de una categoría filtra ahí, y si no encuentra nada ofrece "buscar en todas". El alta
> ("+ Agregar insumo", sólo dentro de una categoría) nace clasificada y abre el pop-up directo.
> Funciones nuevas: `insOpenQty` / `insCloseQty` / `insBack` / `_insQtyHtml` / `_insCrearHtml` /
> `_insBtnCod`. Test `tests/ins-categorias.cjs` reescrito para la navegación; suite completa OK;
> render 390px sin overflow. Bump **v7.08**.
>
> Nota: **v7.07 — Recepción de Mercadería: la OC vigente en cada botón de código + aviso Telegram
> si entra +20% de más**. Pedido del usuario, todo en `recepcion.js` (`?v=3.77`) + un trigger nuevo.
> **(1) DETALLE DE LA OC EN EL BOTÓN**: al marcar la mercadería que recibe, cada código de la grilla
> muestra debajo, chiquito y en ámbar, **`OC N`** = cajas pedidas a ese tallerista/proveedor en la
> **orden de compra vigente** (si ya hay recibido parcial cargado en el módulo de OCs → **`OC
> falta/pedidas`**, ej. `OC 40/100`). El pop-up de cajas repite la línea "📑 OC vigente (29/jul/26):
> 49 caja(s) pedidas". **Fuente: `Ordenes_Compra`**, la MISMA tabla que llena el generador **desde el
> PPP** (📑 Órdenes de Compra → ⚙ Generar OCs: A pedir = máx(0, Máximo + Pedidos PPP − Stock)) — no
> hay tabla ni carga aparte: lo que se ve se alimenta solo con cada generación de OCs. Lectura con la
> anon key (`select_all`), best-effort y **en paralelo** a la grilla (si falla, la pantalla queda como
> antes). *Vigente* = línea con `estado ≠ 'recibida'` y `cantidad > cantidad_recibida` de los últimos
> **120 días**, y si hay varias generaciones del mismo artículo se toma **sólo la más nueva** (sumando
> sus líneas), para no acumular OCs viejas ya reemplazadas. El **proveedor** de la OC se cruza con el
> tallerista por clave normalizada (`ocProvCoincide`): exacta, **compartida** ("Garcia / Lucho",
> "Pintos / Maspoli" → aplica a los dos), con inicial de apellido pegada ("Martin C" = Martin,
> "Carlos E" = Carlos) y por `ALIAS_NOMBRE` (Pettofrezza = Rafael); el código cruza con `_ocgNorm`
> ("057" de la OC = botón "57"). **(2) EXCESO → TELEGRAM, SIN FRENAR AL OPERARIO**: si entra **más del
> +20%** de lo que pide la OC (referencia = lo que FALTA recibir), **no hay pop-up ni aprobación** —
> sólo el botón queda **en rojo con ⚠**. Al enviar, `opEnviar` recalcula qué códigos exceden
> (`ocExcede`) y emite UNA fila **`ROC`** en `Registros_Produccion_Virgilio` (`texto =
> proveedor|remito|cod:recibidas/pedidas`), y el trigger nuevo **`trg_recepcion_excede_oc_telegram`**
> (función `notificar_recepcion_excede_oc_telegram`, `sql/recepcion_excede_oc_telegram.sql`) manda el
> aviso por Telegram con el mismo mecanismo que el resto (`tg_enqueue` → `telegram_outbox` →
> `tg_outbox_flush`, dedup por `client_id`, token del Vault) resolviendo el legajo a nombre por
> `Empleados`. Hubo un paso intermedio con pop-up "Requiere aprobación" que el usuario pidió **sacar**
> (nunca llegó a producción). **Test end-to-end OK**: evento ROC de prueba → outbox → Telegram
> **HTTP 200** (message_id 678); el evento de prueba se borró después. Test nuevo
> **`tests/rcp-oc.cjs`** (parchea el import de supabase-js por un cliente falso) en `tests/run.sh`;
> suite completa OK + render headless a 390px (sin overflow). Bump **v7.07**.
> Nota: **v7.06 — Cuatro cosas que reportó el usuario en el chat (todas con test + suite verde)**:
> **(A) SSG "picking sin stock" — falso positivo por carrera con el cron.** Tanda `D16A` avisó
> "764 pidió 20 / había 9" y "729E 5 / 0" con stock que **alcanzaba justo**. Desde v5.76 la baja del
> picking la escribe **sólo el cron** (`reconciliar_pipeline_stock`, jobid 22); en D16A corrió
> **antes** del chequeo del cliente → `stockBajaPicking` leía el saldo **ya descontado** y avisaba si
> había menos del **doble** de lo pickeado. Fix: excluye del saldo los `tipo='picking'` de ESA tanda.
> Texto reescrito ("se pickearon N cj · el sistema tenía M", aclara que el operario no agarró de más).
> `tests/ssg-carrera-cron.cjs`.
> **(B) SSG falso en códigos PARTIDOS POR EMPRESA** (`437E`/`438E`…). Tanda `D05D` avisó "437E: 1 / 0"
> con **61 cajas en `437E LK`**. El stock vive con sufijo (`437E LK`/`437E CH`, idea 9020) pero el PKC
> guarda el **pelado**; `stockBajaPicking` miraba `sal["437E"]` = 0. El descuento por NP lo hace bien el
> cron; el bug era la alerta. Fix: suma **toda la familia** del código (pelado + `LK`/`CH`/`LOKE`, vía
> `codBase()`). `tests/ssg-familia-empresa.cjs`.
> **(C) "A guardar" no coincidía app vs Telegram** (cod `234`: app **42**, Telegram **29**).
> `reporte_agentes_falta_llego()` filtraba `legajo not in ('0','1')`; la recepción `+13` (legajo 0,
> real) quedaba afuera pero su `guardado −13` sí contaba → 13 de menos para siempre. Se sacó el filtro
> ahí y en `generar_reporte_agentes()` (`mg_pendiente`, `pipeline_atascado`); mismo criterio que idea
> 1636. Barrido: 17 códigos / 404 cajas. `sql/falta_llego.sql`.
> **(D) La tabla de Stock ahora muestra `para_envasar` y `racks_ch`.** El `035E` tenía 44 cajas en
> "p/ envasar" invisibles; artículos que estaban SOLO ahí (`439E`, `809E`) no aparecían. `stkBodyStocks`
> tenía los depósitos hardcodeados sin ellos. Fix: agregados a `SECT` (`extra:true`) y `SECTKEYS`,
> columnas/tiras **condicionales** (sólo si hay saldo), celda clickeable → `stkOpenMovsArt`, Total Stock
> los incluye. Barrido: 884 + 840 cajas ocultas. `tests/stk-envasar-col.cjs`.
> **(E) Tanda FANTASMA en el monitor por un EP de legajo 0.** `D05B` figuraba "en picking hace 17 h"
> por un `EP` de legajo 0 (Pruebas). `getActivityStatus()` no excluía legajo 0/1 al armar el estado del
> tablero. Fix: los saltea → las tandas de prueba no figuran iniciadas/en curso. `tests/act-legajo0.cjs`.
> Bump **v7.06**.
>
> Nota: **v7.05 — Insumos (RI/EI): botonera de CATEGORÍAS** (idea 7917 del usuario). El modal de
> Recepción/Entrega de Insumos listaba los **108 códigos planos ordenados por código** y la única
> forma de llegar a uno era el buscador de texto (el operario tenía que saber que el fleje de
> 121 × 1,20 es el código `22`). Ahora `Insumos` tiene **`categoria`** y **`ubicacion`**, y arriba
> del buscador van los **chips**: `Todos` · 🧵 Fleje y alambre (32) · 🧪 Plástico (9) · 🍴 Partes
> inox (11) · 🪵 Mangos (3) · 🌀 Espirales (2) · 📦 Cajas y embalaje (8) · 🗑 **A depurar (43)**.
> **Cuatro cosas más, todas consecuencia de la agrupación**: **(1)** los **43 duplicados/negativos**
> del formato viejo `sector·descripción` quedan **fuera del listado por defecto** (chip aparte, con
> aviso ⚠ — no se esconden del todo porque algunos todavía arrastran saldo). **(2) Unidad por
> defecto POR CATEGORÍA** (Fleje ⇒ Kg, Plástico ⇒ Bolsas, Espirales ⇒ MC, Cajas ⇒ Paquetes): es lo
> que venía **partiendo los saldos** (`PP` tenía 151 Bolsas **+ 24 Uni** porque el chip arrancaba en
> "Uni" y nadie lo cambiaba). La idea 7382 sigue mandando: si el insumo ya tiene saldo en **una
> sola** unidad, gana esa. Los chips de unidad ahora **dedupean sin distinguir mayúsculas** (`Kg`
> vs `kg` eran dos chips = dos saldos del mismo insumo). **(3)** Se **cargaron al catálogo los 62
> insumos que sólo existían como movimiento** — antes un fleje que llegaba a 0 **desaparecía** del
> modal y había que re-crearlo para poder recibirlo (`4`, `10` y `25` estaban así). **(4)** El
> alta nace **con categoría** (selector en el formulario, arranca en la del chip activo) y el
> movimiento guarda la **ubicación física** (`V9 Ad`, `AF7`) en vez del sector. Chip y buscador son
> **alternativos** (buscar mira todo, incluso lo a depurar) para que nunca haya un "0 resultados"
> por estar parado en la categoría equivocada. Relevamiento completo en `docs/INSUMOS-CATEGORIAS.md`.
> Test nuevo `tests/ins-categorias.cjs`; suite completa OK; render 390px sin overflow. Bump **v7.05**.
>
> Nota: **v7.04 — Ocupación: drag&drop de "A programar" a días (planificación LOCAL)**. Completa el
> #3 del usuario. Se pueden **arrastrar** los pedidos "a programar" (chips en el detalle de la barra
> ámbar) a un día del gráfico, o **tocar el chip y después el día** (fallback touch, robusto). Asigna
> una `fecha_entrega` **solo en el navegador** (localStorage `vir_ocup_plan = {np:"YYYYMMDD"}`) — NO
> toca la PPP real (elección del usuario: proyección/planificación). El pedido planificado se dibuja
> en su día en **ámbar con borde punteado** (color plan), suma a la ocupación proyectada de ese día,
> y sale de la barra "A programar". Reversible: **✕** por pedido en el detalle + botón **"🧹 Limpiar
> plan (N)"**. Drop targets = segmentos de cada día + zona de la etiqueta del día; en modo asignar
> (`_ocupPlanSel`) los días se resaltan en verde. Funciones: `_ocupLoadPlan`/`_ocupSavePlan`,
> `pppOcupAssign`, `pppOcupUnplan`, `pppOcupClearPlan`, `pppOcupChipSel`, `pppOcupDragStart`,
> `pppOcupDrop`; `_ocupUnified` mueve los planificados de `sinFecha`→`dated` con flag `plan`. Verificado:
> render headless del flujo tocar-chip→tocar-día (el pedido migra al día en ámbar, aparece "Limpiar
> plan", badge 📋 plan + ✕). `checkhtml` + `smoke` OK. Bump **v7.04**.
>
> Nota: **v7.03 — Ocupación: armado vs a-entregar (%) + apilado POR PEDIDO + tooltip + escala del
> histórico**. Tres pedidos del usuario. **(1) Comparativa armado vs a-entregar**: cada pedido trae
> ahora `armado` (bool) en `_ocupUnified` — entregados (Meta) = armado; programados = su tanda tiene
> **TAP** (`_pppArmadoDone`, se carga en `pppRefreshOcupacion`); a-programar = no. Se ve como **% del
> total** por día (`✓X%` sobre la barra, línea "🔧 Armado X% (Y de Z m³) · falta armar W m³" en el
> detalle, badges ✓ armado / ⏳ a armar por pedido, KPI "armado %" y % en el título de la semana), y
> **visualmente**: los segmentos armados van **sólidos abajo**, los pendientes **claros arriba**
> (`opacity` 1 vs 0.42, `_ocupSortPeds`). **(2) Escala provisoria del histórico**: los buckets de
> tamaño se recalibraron con la distribución real de m³ por pedido (n≈2242: p25≈0.10, p75≈0.35,
> p90≈0.75) → **Chico ≤0.10 · Mediano ≤0.35 · Grande ≤0.75 · Muy grande >0.75**. **(3, parcial)
> Tooltip**: las barras ahora se apilan **por pedido individual** (segmento = 1 pedido, no bucket
> agregado), cada uno con `<title>` = **NP · cliente · m³ · estado** (hover). ⏳ **Falta el drag&drop**
> de #3 (arrastrar los "a programar" a días) — se decide aparte (planificación local vs programar de
> verdad en Supabase). Verificado: render headless (semana con armado sólido/claro + %, detalle con
> badges). `checkhtml` + `smoke` OK. Bump **v7.03**.
>
> Nota: **v7.02 — Ocupación: vista SEMANAL con barras apiladas por tamaño de pedido + "A programar"**.
> El usuario pidió cambiar la visión: en vez del gráfico continuo de −30…+30 días, ahora es
> **semanal** con **selector de 9 semanas** (`pppOcupWeek`, −4…+4; "Esta sem" resaltada). Cada día es
> una **barra apilada por `fecha de entrega`**, segmentada por **tamaño de pedido** (4 buckets
> `OCUP_BK`: Chico ≤0.10 / Mediano ≤0.30 / Grande ≤0.80 / Muy grande >0.80, escala de azules) — así se
> "discriminan los pedidos que componen los m³". Fuente **por pedido**, unificada por `fecha_entrega`
> (`_ocupUnified`): entregados = `PPP_Entregados_Meta` (reusa `_pppDeliveredFull`), programados =
> `_pppParsed.prog`. **Pedidos "A programar"** (sin fecha) se incluyen como **barra de proyección**
> (color ámbar, sólo en semana actual/futuras `_ocupWeek≥0`) + KPI "a programar (m³)". Click en una
> barra → detalle de pedidos del día (NP, cliente, m³, punto de color por tamaño). Línea de capacidad
> **diaria** opcional (mismo `vir_ocup_cap_m3`). Se **reemplazó** todo lo de armado/TAP anterior
> (`_ocupArmado`, `_ocupSvg`, `_ocupProgByDay`, scroll horizontal) por `_ocupWeekData`/`_ocupWeekSvg`/
> `_ocupWeekDetailHtml`. Nota: la métrica pasó de "armado por día" a **"a entregar por día"** (fecha de
> entrega), consistente para pasado (entregados) + futuro (programados) + proyección (a programar).
> Verificado: render headless de semana actual (con "A programar" ámbar + HOY), detalle por día, y
> semana pasada. `checkhtml` + `smoke` OK. Bump **v7.02**.
>
> Nota: **v7.01 — El guard de stock-negativo ahora TAMBIÉN avisa por `insumos`**. El usuario pidió
> "que mande" también los negativos de insumos (antes se excluían para no spamear con los
> `entrega_insumo` sin recepción). Se sacó la exclusión de `insumos` en
> `notificar_stock_negativo_telegram()`; la dedup (cod+depósito+día) limita a **1 aviso por código
> de insumo por día**. **Test end-to-end OK**: se disparó un aviso de prueba (movimiento negativo en
> `insumos`, código `PRUEBA-NEG`, borrado después) → `telegram_outbox` status `sent`, HTTP **200**
> desde Telegram. (Nota de la infra: `tg_outbox_flush` solo despacha **07:00–21:00 AR** y usa `pg_net`
> async — el status pasa a `sent` en el flush siguiente aunque el mensaje ya salió.) `sql/guard_stock_negativo_telegram.sql`
> actualizado. Bump **v7.01**.
>
> Nota: **v7.00 — Stock: alerta Telegram "en el momento" cuando algo queda en negativo + fix de
> 2 negativos imposibles**. El usuario pidió auditar el stock. Hallazgos (vía `vista_saldos_stock`):
> **(1)** 2 negativos "imposibles" físicos, chicos y recientes, **corregidos con `ajuste`**:
> **595** (Pinza de Fiambre) `separar_pedidos` −1 → 0 (residuo de un ajuste manual "faltante D01E");
> **580E** (Batidor Mini) `terminado` −3 → 0. Causa del 580E (confirmada por el usuario): el
> **conteo del 01-08 se cargó bajo `580` (sin E)** en vez de `580E` — `580` tenía `terminado`=+3 y
> `580E` había quedado en −3 tras 3 picks; se **relocalizó** el conteo (`ajuste` +3 a 580E, −3 a 580,
> ambos → 0). `fn_canon_cod_art` no reescribe el código en `ajuste` (mapea por clave normalizada vía
> OC_Maximos; `580` y `580E` tienen claves distintas). **(2)** Negativos grandes en depósito
> **`insumos`** (505C·Cuchilla China −16006, H201PART −14000, etc.): son movimientos `entrega_insumo`
> (materia prima entregada a talleristas) **sin la recepción previa** → hueco de tracking del lado
> de compra/recepción, NO bug de picking. Quedan pendientes (decisión del usuario). **(3) Feature —
> "nunca algo puede quedar en negativo, avisá al toque":** nuevo trigger server-side
> **`trg_stock_negativo_telegram`** (AFTER INSERT en `Movimientos_Stock`) que, cuando un movimiento
> deja **cualquier** depósito físico/pipeline en negativo, manda alerta Telegram (vía `tg_enqueue`/
> `tg_outbox_flush`, dedup por cod+depósito+día). Excluye `insumos`, `inicial` (reset/conteo) y
> picking→góndola (ya lo cubre SSG). **NO bloquea** el insert (alerta, no corta el pipeline).
> Comparte el switch con SSG: **`Stock_Config.alerta_sin_stock_gondola`**, que **estaba en `0`
> (desactivado desde 07-16) y se REACTIVÓ a `1`** (el "switch que había quedado desactivado" que pidió
> el usuario). El toggle admin se renombró a **"📦 Aviso Telegram 'stock en negativo'"** y ahora
> gatea ambos avisos. SQL del trigger en `sql/guard_stock_negativo_telegram.sql`. Verificado: el
> trigger NO rompe inserts (test con rollback), `checkhtml` + `smoke` OK. Bump **v7.00**.
>
> Nota: **v6.99 — El histórico del Excel ahora trae FECHA + m³ (no solo NP+cliente)**. Seguimiento
> del pedido del usuario: quería que los entregados **viejos** (anteriores al 26/05, que solo están
> en el Sheet) también salgan con fecha y m³. Se descubrió que el Sheet **"PPP Pedidos Entregados
> 2026"** SÍ tiene esas columnas (layout por campo entrecomillado: `1 Tanda · 3 NP · 5 Cod · 6 Razón ·
> **7 Mt3** · 8 Mt3 FC · 13 Fecha de Entrega`), pero el sync server-side **`sync_ppp_entregados_meta()`**
> (función Postgres que lee el CSV del Sheet vía extensión `http`, corre por cron pg_cron cada :07/:37)
> solo capturaba np/cod/rs. **Fix (todo server-side, sin tocar el Apps Script):** (1) migración
> `alter table PPP_Entregados_Meta add tanda text, m3 numeric, fecha_entrega text`; (2) se reescribió
> la función para parsear también **tanda (ord 1)**, **Mt3 = m³ (ord 7, NO "Mt3 FC"/ord 8)** y
> **Fecha de Entrega (ord 13)**, con el mismo parseo de coma-decimal que la app; (3) se corrió a mano
> → **2043 filas, 2039 con m³, 1994 con fecha** (backfill inmediato; el cron la mantiene). En la app:
> la solapa **"📄 Histórico completo del Excel"** ahora se renderiza **agrupada por fecha → tanda con
> m³** (mismo formato que "Con detalle", vía `_pppEntGroupedHtml` compartido), no una grilla plana de
> NP. `pppRefreshEntregadosFull` trae `np,cod,rs,tanda,m3,fecha_entrega`. Copia versionada de la
> función en `sql/sync_ppp_entregados_meta.sql`. **Ojo**: `PPP_Entregados_Meta` ya NO es solo
> NP→cliente — tiene tanda/m3/fecha_entrega (lo usa Recepción Remitos por np→cod/rs, sigue OK).
> Verificado: `checkhtml` + `smoke` + render headless (Excel agrupado por fecha con m³). Bump **v6.99**.
>
> Nota: **v6.98 — "Pedidos Entregados": ahora muestra TODO (no 45 días de CRN)**. El usuario notó
> que se veían pocos ("tendría que haber ~mil pedidos"). Diagnóstico sobre la data cruda: el espejo
> del Excel funciona bien (`PPP_Entregados_Meta` = **2337 NPs**, full-replace sincronizado hoy 17:37;
> la macro anda) — el problema era **cómo lo exponía la página**: la v6.97 mostraba solo los eventos
> **CRN de los últimos 45 días** (~250). Se rehízo la solapa con **dos fuentes** (el usuario eligió
> "las dos"): **(a) DEFAULT "Con detalle"** = vista **`vista_ppp_pedidos_entregados`** (690 pedidos
> facturados + cerrados en reparto, desde el 26/05, cuando arrancó el flujo de facturación/cierre):
> NP, tanda, cliente, **m³**, **cajas entregadas/faltó** y **fecha de reparto** → agrupado por fecha
> (desc) → por tanda, con total de m³. **(b) Toggle "Histórico completo del Excel"** = espejo
> **`PPP_Entregados_Meta`** (2337 NP+cliente, todo el Sheet) en grilla de 2 columnas, cap 600 visibles
> + buscador (lazy: solo se trae al tocar el toggle). Las dos comparten el 🔎 buscador del PPP.
> Relación de las fuentes: la vista (690) es un subconjunto reciente y RICO; el Excel (2337) es el
> histórico completo pero SIN fecha ni m³ por fila (esas columnas no se espejan). Funciones nuevas:
> `pppRefreshDelivered` (ahora lee la vista, no CRN), `pppRefreshEntregadosFull`, `pppEntMode`,
> `_pppEntAppHtml`, `_pppEntExcelHtml`, `_pppEntTabsHtml`, `_pppYmdKey` (`_pppDelivered` /
> `_pppDeliveredFull` / `_pppEntMode`). Todo LECTURA. Verificado: `checkhtml` + `smoke` OK, render
> headless de ambos modos (vista con m³/cajas; grilla del Excel). Bump **v6.98**.
>
> Nota: **v6.97 — PPP: fix "Pedidos Entregados" (daba 0) + nueva solapa "📦 Ocupación"**. Dos
> pedidos del usuario. **(1) Bug "Pedidos Entregados" siempre en 0 / "los pedidos entregados
> desaparecen".** La solapa mostraba `entreg = prog ∩ controlados`: pedidos que están **todavía en
> `PPP_Programacion_Diaria`** Y marcados controlados. Pero un pedido **SALE** de la Programación
> Diaria en cuanto se entrega/controla (el sync upstream lo saca) → esa intersección es
> estructuralmente ~0 (verificado: de 203 NP en prog, 0 tienen CRN; de 361 CRN, 0 siguen en prog).
> **Fix:** la lista ahora es **durable** y sale de los eventos **CRN** (control hecho, últimos 45
> días) enriquecidos con `PPP_Entregados_Meta` (NP→cod/razón) y `vista_tanda_m3` (tanda→m³), agrupada
> por **día de control → tanda**. Funciones nuevas: `pppRefreshDelivered` (`_pppDelivered`),
> `_pppEntBodyHtml`, `pppTandaM3Map` (cache 5 min de `vista_tanda_m3`). Se dispara en `openPPP` (para
> el badge) y al entrar a la solapa. El viejo `entreg` (prog∩ent) sigue calculándose pero ya no se
> usa para la solapa. **(2) Nueva solapa "📦 Ocupación"** (m³ por día): gráfico de barras
> **últimos 30 días** = m³ **armado real** (evento **TAP** por tanda × `vista_tanda_m3`, verde) +
> **próximos 30 días** = m³ **programado a entregar** (`PPP_Programacion_Diaria.fecha_entrega` × `m3`,
> azul); **HOY** resaltado (violeta) y auto-scrolleado al centro; se actualiza solo al llegar
> registros. **Comparativa de capacidad**: Virgilio **no guarda** una capacidad total del depósito en
> m³ (`Capacidad_Sector` es capacidad de **góndola en cajas**, otra cosa) → se agregó un input para
> cargarla a mano (localStorage `vir_ocup_cap_m3`); al setearla dibuja la línea de capacidad + el %
> de ocupación de hoy. **Detalle por día** (tocar una barra): m³ **pendientes de entrega** ese día
> (por tanda + NPs) y m³ armado ese día. KPIs: armado hoy, a entregar hoy, m³ próx. 30 días, día pico.
> Funciones: `pppRefreshOcupacion` (`_ocupArmado`), `_ocupProgByDay`, `pppOcupHtml`, `_ocupSvg`,
> `_ocupDetailHtml`, `pppOcupSetCap`, `pppOcupDay`. Todo **LECTURA** de Supabase (no rompe el "solo
> local" de la PPP). Verificado: `checkhtml` + `smoke` OK, render headless a 400px de ambas solapas
> (entregados agrupado por día; gráfico con barras verdes/azules, HOY, línea de capacidad al 81%).
> Bump **v6.97**.
>
> Nota: **v6.96 — Fix UI: el botón "Cerrar" tapaba el título del modal**. Pedido del usuario (dos
> capturas: "Picking — Tanda …" y "🚛 Carga Camión — reparto"): el título quedaba ATRÁS del botón
> "Cerrar", que se veía estirado a lo ancho de todo el modal. Causa: `.hist-modal-close` no
> sobrescribía la regla global `button{ width:100%; margin-top:14px }` (index.html ~línea 25), así
> que el botón se estiraba al 100%. En `.tanda-modal-header` (Picking / Carga Camión / Armado / RR)
> el título es `flex:1; min-width:0` (puede colapsar a 0) y el botón `flex:0 0 auto` (no encoge) →
> el botón se quedaba con todo el ancho y el texto del título quedaba desbordado por detrás. Fix: a
> la clase base `.hist-modal-close` se le puso `width:auto; margin:0; flex:0 0 auto` — un botón de
> cerrar va SIEMPRE compacto arriba a la derecha. Arregla los 5 modales que usan esa clase (tanda,
> historial, terminar-día, monitor, análisis) sin regresiones. Verificado con render headless a
> 400px y 900px (título y botón sin solaparse; los otros modales quedaron más prolijos). Bump **v6.96**.
>
> Nota: **v6.95 — Fix: "Seguir armado" (retomar) no refrescaba el switch/legajos de etiqueta de
> lío**. Bug real encontrado en el piloto: `showCompletarWizard` llama a `etlLoadGlobal()` sólo en
> el camino de armado **NUEVO** (`_comp = {...}`); el camino de **RETOMAR** un armado en curso
> (`_compRestore(tanda)` → `_comp = _savedC` → `return` temprano) se saltea esa llamada por
> completo. Resultado: un armado que quedó abierto desde ANTES de que existiera la tabla
> `Etiqueta_Lio_Legajos` (o desde antes de un cambio de legajos habilitados) podía quedar **para
> siempre** con el mirror local vacío o desactualizado — el switch aparecía prendido y el legajo
> habilitado del lado del servidor, pero ESE armado en particular nunca se enteraba y no imprimía
> nada, sin ningún error visible (síntoma: "andaba perfecto y de repente dejó de andar" justo
   después de tocar la lista de legajos). Fix: se agregó el mismo `try { etlLoadGlobal(); } catch
> {}` también en el camino de retomar, antes del `return`. Verificado: `ap-resume` (retomar armado)
> y `comp-doblearmado` siguen OK, suite completa OK (398 handlers, 0 muertos). Bump **v6.95**.
>
> Nota: **v6.94 — Etiqueta de lío: control fino por LEGAJO (piloto restringido al 8)**. Pedido del
> dueño: "por ahora que funcione solo contra legajo 8" + un switch para activar/desactivar
> empleados. Nueva tabla **`Etiqueta_Lio_Legajos`** (`legajo` PK, `habilitado` bool default true) —
> hoy sólo tiene el **8** cargado. **Doble gate** en `etlBuildLioRow`: el switch global
> `Stock_Config.etiqueta_lio` (apagado maestro) **Y** `etlLegajoHabilitado(comp.legajo)` (lee un
> mirror local `vir_etiqueta_lio_legajos`, poblado por `etlLoadGlobal` junto con el switch — mismo
> patrón sin-red que `etlOn()`). En el **Print Station** hay una tarjeta nueva "👥 Legajos
> habilitados": input + botón **"+ Agregar"** (upsert `habilitado=true`) y un switch por legajo ya
> cargado (`etlLegToggle`) — `etlLegRenderList()` hace fetch fresco cada vez que se abre (es panel
> de admin, no el gate rápido) y de paso refresca el mirror. Con el legajo NO habilitado (aunque el
> switch global esté prendido) no se encola nada — igual que con el switch apagado. Tests
> reescritos sobre el mirror (`_etlSetLegajosMirror`): legajo habilitado/deshabilitado/inexistente,
> switch-off-con-legajo-habilitado, switch-on-con-legajo-no-habilitado. Suite OK (398 handlers, 0
> muertos). Bump **v6.94**.
>
> Nota: **v6.93 — Etiqueta de lío: agrega la LETRA del lío (A, B, C1, C2, C3, D…)**. Pedido del
> dueño: la misma letra que usa "Consultar NP/Líos" (`liosLabels`, agrupa por composición y
> sub-indexa los repetidos) ahora sale también en la etiqueta, en un **badge grande** (78pt)
> arriba a la derecha. `_etlLioLetra(n)` la calcula en el momento de cerrar el lío — el lío ya
> está en `n.liosArr` (lo agregó `_compAddLio` antes de llamar a `etlEnqueueLio`), así que la
> **última** etiqueta de `liosLabels(n.liosArr)` es la de este lío. Nueva columna
> `Etiquetas_Lio.lio_letra`. Para que el nombre/NP nunca choquen con el badge, esas dos líneas
> usan **`^FB` (field block)** con ancho fijo a la izquierda del badge en vez de posición libre.
> ⚠ **Límite conocido** (documentado en el código, mismo tipo que `lio_total`): la letra es
> *best-effort al momento de imprimir* — si más adelante se cierra OTRO lío con la MISMA
> composición, `liosLabels` re-numera TODO el array (A→A1, y el nuevo sale A2), pero la etiqueta
> **ya impresa** del primero sigue diciendo sólo "A" (no se puede reimprimir sola). Tests
> actualizados (`lio_letra`, badge en el ZPL, caso de re-letrado A/A2). Suite OK. Bump **v6.93**.
>
> Nota: **v6.92 — Etiqueta de lío: fuentes bien más grandes** (piloto en vivo, primera impresión
> real a la medida 100×55mm: entró bien pero el dueño la vio "muy chica"). Se re-repartió el
> mismo canvas 800×440: razón social 40→**50**, línea NP/tanda/lío 22→**28**, divisor más grueso
> (2→4), TOTAL 28→**40**, operario 20→**26**; el techo de la fuente de ítems (pocos códigos) subió
> 36→**66** (`rowH` techo 46→84) — con 1-2 ítems por lío (el caso típico) ahora ocupan casi toda la
> etiqueta. El piso para líos con muchos códigos baja un poco (16→14) para seguir garantizando que
> **siempre entra** sin cortarse. Mismos tests (no dependen de tamaños de fuente, sólo de contenido/
> `^PW`/`^LL`). Suite OK. Bump **v6.92**.
>
> Nota: **v6.91 — Etiqueta de lío a la medida FÍSICA real: 100×55mm**. Piloto en vivo (03/08):
> imprimió pero con el tamaño mal (el `_etlZpl` anterior usaba 600×dinámico "a ojo"). Fijado a
> **800×440 dots** (100×55mm @ 203dpi ≈ 8 dots/mm — medida confirmada por el dueño en la impresora
> real). Header (razón social + NP/tanda/lío) y footer (total + operario) son de alto fijo; la
> **zona de ítems reparte el espacio libre entre todos los ítems del lío** con una fuente que se
> achica sola si hay muchos códigos (`rowH`/`fontH` calculados, piso 20/16 dots) — así el lío
> **siempre entra** en la etiqueta física en vez de cortarse. Smoke `etl-lio` verifica `^PW800`/
> `^LL440` y un caso de 12 ítems (fuente achicada, mismo alto de etiqueta). Suite OK. Bump **v6.91**.
> (De paso: la cola de etiquetas del piloto llegó a **0 pendientes** — el imprimidor de la PC de
> la S4M, `tools/imprimir-etiquetas-lio.ps1`, quedó andando en esa PC con Windows 7 tras 2 fixes:
> reescrito 100% ASCII — el guion largo/tildes rompían el parseo en PowerShell — y reescrito sin
> `Invoke-RestMethod`/`ConvertFrom-Json` porque esa PC corre **PowerShell 2.0**, que no los tiene;
> usa `WebClient` + `JavaScriptSerializer` (.NET) y fuerza TLS 1.2 vía `COMPLUS_Version=v4.0.30319`
> en el `.bat` para que cargue CLR 4 en vez del 2.0 default.)
>
> Nota: **v6.90 — El switch de etiquetas de lío pasa a ser GLOBAL, en el módulo de la operadora**.
> Pedido del dueño: el switch va en el **Print Station** (módulo de la operadora, la PC al lado de
> la impresora) y **NO** gateado por legajo 0/1. Ahora es un **ajuste global** en
> `Stock_Config.etiqueta_lio` ('1'/'0', default off) — mismo patrón que `alerta_sin_stock_gondola`.
> La operadora lo prende/apaga con `etlToggleGlobal` (POST a `Stock_Config`); cada **armador** lo
> toma con `etlLoadGlobal` (fetch → espejo a `localStorage` que lee `etlOn`) **al abrir el armado**
> (tras construir `_comp`) y la operadora lo re-sincroniza al abrir el Print Station. Se **sacó** el
> toggle del módulo del operador (`_etlOperRow`) y el **gate de legajo** de `etlBuildLioRow` (ahora
> el único gate es el switch global). Con el switch apagado no se encola nada. Toggle nuevo en
> `psRender` (card "🏷️ Etiqueta de lío automática"). Smoke `etl-lio` actualizado (sin gate de
> legajo). Suite OK. Bump **v6.90**.
>
> Nota: **v6.89 — Etiquetas de lío: imprime AL CERRAR CADA LÍO (no al TAP)**. Pedido del dueño:
> que la etiqueta salga apenas confirman la pilita (para ensuncharla en el acto), no todas juntas
> al terminar. Se reemplazó el hook del TAP (v6.88) por un **único punto de alta de líos**:
> `_compAddLio(n, lio)` — reemplaza los 4 `n.liosArr.push(...)` (Cerrar Lío, suelta, líos-de-a-N,
> repetir/grupo) — que agrega el lío **y encola su etiqueta en el acto** (`etlEnqueueLio` →
> `etlBuildLioRow`, PURO). `client_id` con **secuencia monotónica** `comp._etlSeq` (persistida en
> `_compPersist`) → nunca choca aunque borren/editen líos; como el total aún no se conoce, la
> etiqueta muestra sólo **"Lío N"**. Sigue detrás del switch `vir_etiqueta_lio` + legajo 0/1 (con el
> switch apagado `_compAddLio` sólo agrega el lío, no encola nada). ⚠ Contra conocida: si borran un
> lío ya impreso, la etiqueta ya salió (papel de más). Smoke `etl-lio` reescrito sobre `_compAddLio`.
> Suite OK. Bump **v6.89**.
>
> Nota: **v6.88 — Etiquetas de lío automáticas (idea 5290), piloto detrás del switch + legajo 0/1**.
> Al **terminar el armado** (finalizar, junto al `liosSend`/TAL), la app **encola una etiqueta por
> lío** de cada NP en la tabla nueva **`Etiquetas_Lio`** (Supabase): `client_id` determinístico
> (`etl_<tanda>_<np>_<lío>_<día>`), **razón social abreviada** (`_etlAbrev`: saca S.R.L./S.A. y
> recorta a 22), **composición cód+cajas** (`items` jsonb), tanda/NP, operario y el **ZPL** ya
> armado (`_etlZpl`, ~75 mm de ancho, alto según ítems). Un **imprimidor** en la PC de la
> **Zebra S4M** (`tools/imprimir-etiquetas-lio.ps1`, PowerShell, envío RAW por `winspool`) lee las
> `estado='pendiente'`, imprime y marca `impreso`. **TODO detrás del switch `vir_etiqueta_lio` y
> SÓLO para legajos de prueba 0/1** (mismo `pkScanAllowedLegajo`); con el switch apagado NO se
> encola nada (`etlBuildLabels` devuelve `[]`). Toggle en el módulo del operador (`_etlOperRow`,
> sólo 0/1). RLS: anon inserta sólo filas `pendiente` y sólo actualiza las `pendiente`. Falta el
> **lugar de entrega** (el dueño lo tiene que parametrizar; hoy va cliente + composición). Fns:
> `etlOn/SetOn/Toggle`, `_etlAbrev`, `_etlZpl`, `etlBuildLabels`, `etlPost`, `etlEnqueueArmado`,
> `_etlOperRow`. Smoke `tests/etl-lio.cjs`. Suite completa OK. Bump **v6.88**.
>
> Nota: **v6.87 — El piloto de la lectora queda restringido a los legajos de PRUEBA (0 y 1)**.
> Pedido del dueño: poder prender la lectora para probarla **él mismo** con los legajos 0/1
> (los de test/basura, ya excluidos de reportes) sin que ningún operario real la active. Helper
> `pkScanAllowedLegajo(lg)` = `lg ∈ {"0","1"}`. **Efecto gateado en un solo choke-point**: el
> listener de teclado (`pkScanBind`) corta si `!pkScanAllowedLegajo(_pk.legajo)` → aunque el flag
> `vir_picking_scanner` esté prendido, un picking de otro legajo NO procesa scans y `_pk.faltaPend`
> nunca se puebla (la pantalla de lote tampoco aparece). Además el **toggle del operador**
> (`_pkScanOperRow(box, legajo)`) **sólo se dibuja para 0/1**; el del Print Station aclara que sólo
> corre para esos legajos. Smoke `pk-scan` extendido (`legGate` + `operRowGate`). Verificado: suite
> OK. Bump **v6.87**. (Cuando el dueño valide el flujo, se amplía a los legajos reales.)
>
> Nota: **v6.86 — Picking con lectora (idea 8243): FALTA DIFERIDO, cero toques de pantalla**.
> Refinamiento pedido por el dueño: con el switch `vir_picking_scanner` prendido, durante el
> picking el operario **no toca la pantalla** — sólo dispara la lectora. **TODO** (`779558700`+NNN)
> = agarró todo → registra las cajas pedidas y avanza. **FALTA** (`779558701`+NNN) = agarró de
> menos → **ya NO abre el input** en el momento: marca el artículo como *falta pendiente*
> (`_pk.faltaPend`, se borra su result si tenía) y avanza. Recién **al terminar (TP)**,
> `pkRenderDone` muestra **una pantalla que pide en LOTE** las cantidades de todos los FALTA
> (inputs `type=text inputmode=numeric` para tipear al derecho; blanco/0 = no había);
> `pkConfirmFaltaBatch` emite un PKC por artículo y dispara el TP. Los *falta pendiente* no
> cuentan como "sin marcar" (el bloqueo de fin sigue exigiendo marcar los que NO se escanearon).
> Objetivo: que el armador (cuello de botella) reciba las cajas prolijas sin esperar. Fns nuevas
> `pkFaltaPend`/`pkConfirmFaltaBatch`; `faltaPend` persiste en `pkSave`/`pkResume`. **Con el switch
> apagado (default) `_pk.faltaPend` no existe y el picking es EXACTO al de hoy.** Smoke `pk-scan`
> extendido (batch + confirmación). Verificado: suite completa OK (0 handlers muertos). Bump
> `APP_VERSION`/`SW_VERSION` **v6.86**. ⏳ Falta el piloto con la lectora real (llega mañana).
>
> Nota: **v6.85 — la columna CAJAS PEDIDAS del Stock también parte por empresa**. Cola de
> la idea 9020: el picking ya resolvía la empresa por NP, pero la demanda seguía saliendo del
> pedido con el código **pelado**, así que `809E` sumaba en un solo número las cajas de *Corta
> Queso* (Chef) y las de *Corta Pizza Familiar* (Loekemeyer) — dos productos distintos.
> `ocgDemanda(porEmpresa)` toma ahora un flag: la **tabla de Stock** lo llama con `true` (la
> demanda se agrupa por `pkCodEmpresa(art, np)`), y el **generador de OCs** lo sigue llamando
> **sin** el flag a propósito, porque cruza la demanda contra `OC_Maximos`, donde el código
> está pelado: partirla ahí haría que no encuentre el máximo y **pida de menos**. Los códigos
> no partidos no cambian. `tests/emp-np.cjs` sube a 22 asserts (cubre las dos formas de la
> demanda). Bump `APP_VERSION`/`SW_VERSION` `v6.85`.
>
> Nota: **v6.84 — idea 9020: la EMPRESA del pedido sale del número de NP y parte el
> stock en el picking**. Cierra lo que quedó a medias en el split por empresa (idea 3197):
> ahí el código pelado se resolvía con una equivalencia **fija** por artículo, que acierta
> la mayoría pero **falla en la minoría** (hay 71 cajas de `809E` pedidas por NPs de
> Loekemeyer que son *Corta Pizza Familiar*, no *Corta Queso*). Ahora la empresa se decide
> **por NP**: `empresaDeNp(np)` → **NP > 90000 = Loekemeyer (`LK`), si no Chef (`CH`)**
> — mismo umbral que el `pkNpEsLoeke` que ya existía desde v6.12, así que hay **una sola
> regla** en el código. Verificado: las 947 NPs son 4xxxx (143, Chef) o 9xxxx (804, Loeke),
> sin excepciones. **Dónde pega**: en `aggFrom` de `showPickingList`, que antes sumaba las
> cajas por código entre todas las NPs de la tanda (perdiendo el origen) y ahora agrupa por
> **`pkCodEmpresa(art, np)`** → el mismo `438E` pedido por una NP 98… y otra 44… da **dos
> renglones** (`438E LK` y `438E CH`), cada uno con **su** sector desde la planimetría y su
> cantidad. Como el `PKC` sale con el código ya sufijado, el **cron descuenta del saldo
> correcto sin tocar nada más**. `pkCodEmpresa` **sólo** actúa si la planimetría tiene ese
> código con sufijo → un artículo no partido se comporta igual que siempre. Nuevo
> **`codBase(cod)`** saca el sufijo: el sufijo vive **sólo** en el picking (sector) y en el
> stock (saldo), mientras que todo lo que se cruza contra el **pedido** —faltantes,
> `Entregas_Virgilio`, facturación— usa el código pelado, que es el que pidió el cliente
> (`faltantesDeTanda` devuelve pelado, `_compMatchArt` compara por base). El mapa
> `PICK_UBIC_DUAL` de v6.12 queda de **fallback de display** (se le sumó `439E`) y no
> matchea los códigos ya partidos. Tabla **`Planimetria`**: columna nueva **`empresa`**,
> rellenada por sector desde los conteos del 01/08 (la calle Ñ es mixta: Ñ53/Ñ56/Ñ57/Ñ59
> son de Chef). Las equivalencias fijas de la 3197 se **dejan como red de seguridad** para
> cuando no se pueda resolver la empresa. Nuevo smoke `tests/emp-np.cjs` (17 asserts, incluye que la
> **lectora** siga encontrando el ítem: `_pkItemCodes` acepta el código pelado además del
> sufijado, porque la etiqueta del slot dice `438E` a secas) en `tests/run.sh` — de paso se
> registró ahí `tests/pk-scan.cjs`, que había quedado sin correr en la suite. Bump `APP_VERSION`/`SW_VERSION` `v6.84` (la v6.83 se la llevó el merge del picking-scanner).
>
> Nota: **STOCK SEPARADO POR EMPRESA (01/08/2026)** — pedido del dueño. Hay códigos que
> **significan productos distintos según la empresa**: el caso testigo es **`809E`**, que en el
> maestro de **Chef** es *Corta Queso* y en el de **Loekemeyer** (`e_madre_lk`) es
> ***Corta Pizza Familiar***. El stock los sumaba en un solo número (381 = 338 + 43), o sea
> estaba **mal**, no sólo mal mostrado. Solución adoptada (la pidió el dueño así):
> **la empresa va en el `cod_art`**, con sufijo ` LK` / ` CH`:
>
> | Código | Producto | Góndola | Sectores |
> |---|---|---:|---|
> | `437E LK` / `437E CH` | Colador 16cm | 63 / 27 | F09-F11 / L07-L08 |
> | `438E LK` / `438E CH` | Colador 20cm | 50 / 24 | F13-F16 / L05-L06 |
> | `439E LK` / `439E CH` | Colapasta | 29 / 18 | H33-H34 / Ñ53 |
> | `809E CH` | **Corta Queso** X12 | 338 | M13-M15 |
> | `809E LK` | **Corta Pizza Familiar** | 43 | J13-J14 |
>
> ⚠ **Lo que hay que entender para no romperlo**: el pedido (`PPP_Base_Pedidos`) trae el código
> **pelado** (`438E`), y los movimientos de picking los escribe el **cron server-side**
> (ETAPA 1 de `reconciliar_pipeline_stock`) con ese código tal cual. Si el stock vive en
> `438E LK` y nadie traduce, el cron descuenta contra `438E` (saldo 0) y lo deja **negativo**.
> Por eso el split vino con tres piezas más: **(1)** filas en **`Equivalencias_Codigos`**
> (`437E`→`437E LK`, `438E`→`438E LK`, `439E`→`439E LK`, `809E`→`809E CH`; la empresa elegida
> es a la que **ya apuntaba la planimetría**). Ojo: `equivResolve` resuelve **un solo salto**,
> así que las viejas `029`→`437E` y `030`→`438E` se re-apuntaron directo a `437E LK`/`438E LK`.
> **(2)** entradas de **`Planimetria`** para los 8 códigos nuevos (mismo sector y orden que el
> original). **(3)** migración **`pipeline_etapa1_resuelve_equivalencias`**: el CTE `picks` de
> la ETAPA 1 ahora hace `left join Equivalencias_Codigos` y usa `coalesce(e.cod_real, <código
> del PKC>)` — el server resuelve igual que el cliente. **Nada más de la función cambió.**
> ⚠ **Pendiente**: los saldos de **racks** siguen bajo el código pelado y sin empresa asignada
> (`437E` 258, `438E` 156, `809E` 400) — hay que contarlos y repartirlos. Y si algún día un
> cliente de Chef pide `438E`, el descuento va a salir del stock de Loekemeyer: la única forma
> de resolverlo bien es saber la **empresa del cliente** en el pedido.
>
> Nota (dato — **505I resuelto + C15/C20, 01/08/2026**). **(a) La zona `AD` es RACKS**, no
> góndola ni excedente — por eso `505I` no aparecía en ninguno de los dos conteos y venía
> arrastrando saldos en los tres depósitos. Composición real dada por el dueño: **racks
> AD07 420 · AD08 490 · AD09 400 = 1.310**, más **a_guardar 100** → **total 1.410** (el sistema
> tenía 1.746 repartidas en góndola 659 / excedente 651 / racks 336 / a_guardar 100). Se
> resetearon góndola, excedente y racks de `505I` y se cargó el conteo por sector
> (`ref='conteo 505I 01-08'`). ⚠ Los `guardado` a **excedente** con `ubicacion` AD07/AD08/AD9
> del 23 y 28/07 estaban mal de depósito: el operario guardó a racks y quedó como excedente.
> **(b) Sectores `C15` y `C20`**: la planilla del conteo los trajo con el **código vacío** y 0
> (fueron 4 de las filas salteadas); el dueño los pasó aparte → `587T` **81** (C20) y `581T`
> **73** (C15), cargados. El dueño confirmó que el `582T` que había pasado era un
> **error de tipeo**: son **`502T`** «Abrelata Mariposa Tira Imp» (24 cj, C20), el código que la
> planimetría ya ubicaba ahí y de la misma familia *Tira Imp* que 581T/587T — cargado. Con eso
> **C20** queda completo (587T 81 + 502T 24) y **C15** con 581T 73. A `581T` se le puso el
> nombre del maestro con un movimiento `inicial` de delta **0** (la vista toma la descripción
> más corta no vacía; sin eso salía en blanco en la tabla de Stock).
> **(c)** Quedan sin contar los sectores **`O1`/`O2`** (`441` 42 cj y `026` 86 cj en excedente).
>
> Nota (dato — **CONTEO DE EXCEDENTE, 01/08/2026**): mismo método que el de góndola
> (`inicial` negativo de reset + `inicial` una fila por sector, sin tocar el cutoff).
> Planilla `Conteo de Exedente.xlsx` (hoja "Excedente", encabezado en la **fila 2**), 52 filas,
> **46 códigos / 1.593 cajas**, todos los totales cerrando. `ref='conteo excedente 01-08'` y
> `ubicacion` = `"<sector> · <emp>"`. **31 de los 46 códigos coincidían exacto** con el sistema.
> ⚠ **El excedente tiene TRES zonas y la planilla cubre sólo una**: **P1–P30** (contada),
> **AD07/AD08/AD9** (sólo `505I`, 651 cj) y **O1/O2** (`441` 42 cj y `026` 86 cj). Los sectores
> `O` y `AD` son los mismos que faltaron en el conteo de góndola, así que esos **tres códigos se
> dejaron intactos** y el reset los excluye explícitamente. Sí fueron a 0 `229` (2, estaba en
> P14) y `338` (1, estaba en P8): sus sectores se contaron y ya no figuran. Diferencias mayores:
> `186` 15→92, `335` 6→47, `731` 238→202, `590E` 25→45, `613` 17→30, `723` 95→84.
> Resultado: excedente **2.372** (1.593 del conteo + 651 `505I` + 86 `026` + 42 `441`), 49
> artículos, 0 negativos, 0 descuadres contra la planilla.
> ⚠ **Pendiente: nadie contó las zonas `O` y `AD`** (ni en góndola ni en excedente).
>
> Nota (**PLANIMETRÍA + saldos imposibles, 01/08/2026**). Tres cosas que salieron del conteo:
> **(1) Planimetría — 10 códigos con stock no tenían ubicación** (el picking no los ubica y
> dispara `PSP`): se cargaron en la **tabla Supabase `Planimetria`** (que `loadPlanimetriaRemote`
> mergea sobre `planimetria.js` en cada arranque, `cache:"no-store"`) — **NO** se editó el `.js`,
> que es **generado** desde el Excel "AAA_PPP_Vigente.xlsm" y perdería el cambio al regenerarse;
> la tabla es la capa de correcciones (ya vivían ahí `335`, `948E`, `838E`). Cargados con el
> sector del conteo y el orden interpolado del sector vecino: `120` Ñ50·291, `124E` Ñ30·286,
> `554` A73·34, `563` A72·33, `702EN` M10·179, `727EN` L33·199, `809` M16·183, `828` L08·176,
> `865ED` L57·266, `877E` M45·248. ⚠ Quedan **44 códigos pedidos sin ubicación**: 32 son la
> familia **`…L`** (`031L`, `102EL`, `544L`, `951EL`…, 1.331 cajas) que nadie sabe qué es todavía,
> más `55215`/`55289` (parecen typos), `574E`, `830`, `517` y `992E`–`999E`.
> **(2) Pickeados fantasma**: `595` 1, `952E` 2, `957E` 2, `727EN` 1 figuraban en
> `separar_pedidos` pero eran **faltantes** (el picking los descontó de góndola y no estaban;
> `952E` y `957E` habían dejado la góndola en **negativo**). Se descontaron con `ajuste`
> (+ `727E` +1, que cerraba el −1 de la reasignación). Lo demás en Pickeados son las tandas
> **D14B** (30/07) y **D01E** (31/07), legítimas, esperando armado.
> **(3) 7 saldos `a_facturar` NEGATIVOS (−189 cajas)** — `758` −55, `702EN` −52, `769` −49,
> `727EN` −17, `439EL` −13, `877E` −2, `542` −1. **Causa única**: el **21/07** se hizo a mano
> una *"limpieza residuo a_facturar"* de las NP **44482/44483** (Dorinka) con `tipo='ajuste'` y
> `ref` = **texto descriptivo**; el **31/07** la **ETAPA 4** del cron drenó lo mismo otra vez,
> porque agrupa por `split_part(ref,'|',1)` = número de NP y ese `ref` de texto **no matchea**
> la NP → para el cron el bucket seguía positivo. Idem `542` con el cierre manual de la NP 97870.
> **Es el mismo error que el de 546**: reparaciones a mano cuyo `ref` no encaja con la clave que
> netea el cron. ⚠ **Regla para la próxima**: al corregir `a_facturar` de un CP, o usás
> `ref = '<NP>|CP'` (que el cron reconoce y dedupea) o un `ref` de texto que **no empiece con el
> número de NP** — nunca algo que el cron pueda contar a medias. Los 13 ajustes de esta nota
> usan `ref` de texto a propósito, para no reactivar la ETAPA 4. Resultado: **0 saldos negativos
> en toda la base** (verificado corriendo el cron después).
>
> Nota (dato — **CONTEO INICIAL DE GÓNDOLA, 01/08/2026**): se cargó el inventario físico
> del depósito como nuevo baseline de `terminado`. Planilla del usuario `Conteo_2026.xlsx`
> (hoja "Conteo 01-08"): `Emp · Sector · COD · Pilas · Cajas x Pila · Exced. Cajas · Total`,
> 689 filas, **316 códigos / 28.652 cajas** (los totales cerraban: ninguna fila con
> `Total ≠ Pilas×CxP + Exced`). **Cómo se cargó** (importante para la próxima vez): los
> movimientos `tipo='inicial'` **siempre** cuentan, aun antes del cutoff, así que apilar un
> conteo nuevo sobre el baseline viejo (26/06, 286 arts / 35.084 cajas) **duplicaría** todo;
> y **"Marcar inicio"** (mover `cutoff_ts`) **no** servía porque es **global** y habría
> reseteado también A guardar / A facturar / Pickeados / Excedente / Racks. Solución: (1) un
> `inicial` **negativo por artículo** (`ref='reset previo conteo 01-08'`, 301 filas) que lleva
> `terminado` a 0 leyendo el saldo de `vista_saldos_stock`, y (2) el conteo como `inicial`
> **una fila por sector** (`ref='conteo 01-08'`, 529 filas) con **`ubicacion` = `"<sector> · <emp>"`**
> (ej. `M13 · CH`). **Sin tocar el cutoff ni los otros depósitos.** **Mapeos de código**
> confirmados por el dueño: `102→102E`, `106→106E`, `124→124E` (la línea LOKE se contó sin la
> "E"; el resto — `101`,`103`,`104`,`108`… — no lleva E) y `865E→865ED`. `LIBRE` = sector
> vacío (15), se excluye. `798E` es **sólo Chef**. **Decisiones**: todo lo no contado quedó en
> **0** (typos `582`/`583`/`584` — ya había un fix igual "583→583E" el 30/06 —, fantasmas sin
> movimientos desde junio `587T`/`502T`/`029`/`030`/`525`/`725`, y los negativos imposibles
> `439EL` −15 / `830` −5 / `574E` −2), **excepto `505I`** (659 cj, con guardados reales de
> +253 el 10/07 y +323 el 20/07): quedó **sin tocar** hasta verificar si es el mismo artículo
> que `505`. Resultado: góndola **29.311** (28.652 del conteo + 659 de `505I`), 279 artículos
> con stock, **0 saldos negativos**. ⚠ Pendientes de chequeo físico: **`106E`** (contado 173 vs
> 1248 que decía el sistema) y **`505I`**. ⚠ Limitación conocida (idea **3197**): el stock es
> **uno por código**, no por empresa — `437E`/`438E`/`439E`/`809E` existen en CH y LK a la vez
> y se suman; la empresa sólo queda visible en `ubicacion`.
>
> Nota (dato — corrección manual de stock, 01/08): **"A facturar" inflado en 546 (14→3) y
> 836 (5→0)**. Al preguntar de qué se componían esas cajas se encontraron dos causas
> distintas. **(1) 546 — corrección aplicada DOS veces (11 cajas fantasma).** El
> doble-facturado sintético del pipeline sobre C88A/C90A/C98A/C98B ya se había deshecho
> (27/07 12:19 con un `ajuste +8` bajo el ref **combinado** `C88A/C90A`, y 28/07 12:18 con
> `+2` C98A / `+1` C98B), pero el barrido global del 28/07 12:35 ("corrige facturado doble
> … no puede quedar < 0", 364 filas / 137 artículos) lo volvió a sumar: **+1 C88A, +7 C90A,
> +2 C98A, +1 C98B = 11**. Pasó porque ese barrido netea por tanda mirando sólo
> `separado`+`facturado` (**ignora los `ajuste` previos**) y el +8 del 27/07 estaba bajo un
> ref combinado que no matchea ninguna tanda. **546 fue el único artículo afectado** (el
> único que ya tenía un "deshace" previo). ⚠ Ojo: **no es un bug del cron** —
> `reconciliar_pipeline_stock()` (jobid 22) escribe con legajo `pipeline` y tiene su propio
> dedup por tanda; estas filas son legajo `reconcilia`, de un script de reparación corrido a
> mano. **La lección es para los scripts de reparación ad-hoc: netear incluyendo `ajuste`
> antes de "corregir".** **(2) 836 — CP a una NP que nunca se facturó.** El 28/07 17:19
> (legajo 104) un **CP** completó la NP **44500** (cliente 1768, tanda C86C, ya salida el
> 22/07 con esas 5 cajas faltando) sacando 5 cajas de góndola → `a_facturar +5` `ref=44500`.
> La NP nunca entró a `Facturacion_NP`, así que **ni el fast-path `stockDrenarCPFacturado`
> ni la ETAPA 4 del cron la drenan** (ambos exigen NP facturada) y, al no estar más en el
> PPP, quedaba colgada para siempre. El dueño confirmó que **las cajas volvieron a góndola**.
> **Ajustes insertados** (legajo `ajuste`, `client_id` `fix_20260801_*`, imputados de modo
> que cada bucket por tanda cierre en 0): 546 `a_facturar −11` (C88A/C90A/C98A/C98B), 836
> `a_facturar −5` + `terminado +5` (ref 44500). Resultado: 546 a_facturar **3** (lo único
> real: NP **98049** de C98F, armada el 28/07, lío B = 546×3, **sin facturar**), 836
> a_facturar **0** / góndola **64**. Verificado corriendo el cron a mano después:
> `etapa1=0 etapa2=0 etapa3=0 etapa4=0` (no re-inserta nada).
> Nota: **v6.83 — Picking con LECTORA de código de barras (idea 8243) + fix del MG, TODO
> detrás de un SWITCH**. Se mergeó a `main` (deploy) el trabajo del scanner y el arreglo del
> MG. **⚠ Garantía pedida por el dueño: con el switch APAGADO (default) el picking funciona
> EXACTO como hoy** — las fns nuevas del scanner (`pkOnScan`, etc.) **sólo** se invocan desde
> un listener keydown-wedge que corta en la 1ª línea si `!pkScanOn()`; ningún otro lado las
> llama (verificado por grep). **El switch se prende desde DOS lugares**: el **módulo del
> operador** (fila-toggle "🔫 Picking con lectora (piloto)" en la pantalla de inicio del
> operario — `renderPendingSuggestion` → `_pkScanOperRow`, cuando hay legajo) y el **Print
> Station** del supervisor; `pkScanToggle` refresca ambos. Flag `localStorage
> vir_picking_scanner`. **Prendido**: cada lectura dispara la **misma** botonera del picking
> (`pkOk` = todas / `pkF` = algunas) sobre el artículo que matchea; `ninguna` sigue en la
> tablet. **Etiquetas EAN-13, dos por artículo** (esquema que definí): **TODO** =
> `779558700`+NNN+verificador (mercadería completa → "agarré todas"); **FALTA** =
> `779558701`+NNN+verificador (le falta algo → abre la tablet para completar, como "algunas").
> `NNN` = parte numérica del código (943E→943); el verificador (mod-10) lo calcula la
> impresora (ZPL `^BE`) / el algoritmo público. `pkOnScan` **decodifica el EAN** (`_pkNum3`,
> `_pkDecodeEAN`, `_pkFindByNum3`) y resuelve el artículo por **contexto de la tanda** (para
> NNN compartidos: 502/502T, 323/323E…); sigue leyendo el Code-128 `código|T/A` como fallback.
> Fns nuevas: `pkScanOn/SetOn/Toggle`, `_pkItemCodes`, `_pkFindByCode`, `pkScanToast`.
> Herramienta nueva **`tools/etiquetas-gondola.html`** = genera el **ZPL** EAN-13 (TODO/FALTA)
> de las etiquetas de slot desde la planimetría, exporta **CSV** de los EAN y **marca las
> colisiones de NNN**. Diseño completo (+ idea 5290 impresora/ensunchadora) en
> **`docs/idea-picking-scanner-etiquetas.md`**. Smoke nuevo **`tests/pk-scan.cjs`**. **Fix del
> MG** (mismo deploy): en el modal *Guardar a góndola* los inputs de cantidad eran
> `type="number"`; como `mgRender` re-renderiza en **cada tecla** vía `_renderKeepFocus` y los
> `number` **no exponen `selectionStart/End`**, el cursor volvía al inicio y los dígitos se
> **antepondían** ("12" salía "21"). Se cambiaron a **`type="text" inputmode="numeric"`** →
> se tipea normal (izq→der); `mgConfirmar` cierra el modal al enviar. Verificado: pk-scan +
> mva-quien + checkhtml + version-sync + smoke **OK**. Bump `APP_VERSION`/`SW_VERSION`
> **v6.83**. ⚠ Falta el **piloto con la lectora real** y la **idea 5290** (puente de impresión
> + etiqueta por lío + ensunchadora).
>
> Nota (dato — corrección de stock, 31/07 cont.): **727E / 727EN** (Sacacorcho Doble Imp.). **727E**
> → **0 en TODOS los depósitos** (conteo del dueño: `racks −36`, `separar_pedidos −1`, `terminado
> −18`). **727EN** → góndola (`terminado`) **17→10** y **`separar_pedidos +1`** ("lo pickeado del
> 727E es de 727EN" — estaba mal atribuido). ⚠ Queda `727EN a_facturar −17` (negativo raro) sin
> tocar, a revisar aparte.
>
> Nota (dato — facturación, 31/07): **NP 98049 devuelta a "a FC"**. El pedido (Numida S.A., tanda
> **C98F**, FC-ready: TP 07-28 09:20 + TAP 07-28 13:19; con lío TAL + PPP + Base_Pedidos) figuraba
> **marcado facturado** en `Facturacion_NP` (07-28 16:52, cierre `8112d61e…`, fecha_salida 29/07)
> **pero SIN comprobante ARCA** → fue un tilde/mark de la app (posible artefacto del pipeline), no
> una factura fiscal. Por eso NO aparecía en *Facturación — NPs a FC* (el módulo excluye las que
> están en `Facturacion_NP`). Se **borró la fila** (equivale a destildar) → vuelve a "a FC".
> **Restaurable**: np 98049 · tanda C98F · cod_cliente 118 · facturado_at `2026-07-28 16:52:04.378`
> · cierre_id `8112d61e-3641-4fa8-998a-6e660641a8fb` · m3 0.083 · fecha_salida 2026-07-29. **El
> dueño confirmó que NO se facturó NI salió** (sin evento `CCN` → nunca despachada): además de la
> fila de `Facturacion_NP` se **borraron las 7 filas `facturado` fantasma** (ref `C98F|98049`, ids
> 17117-17123) que habían drenado el `a_facturar` → las **18 cajas vuelven a "A Facturar" en
> stock** (501+3 · 502+4 · 513+4 · 535+1 · 546+3 · 555+1 · 816E+2). Se **borró** (no se reversó con
> ajuste) para **liberar la clave de dedup** `(ref,cod,depósito,facturado)` — si no, al facturar
> 98049 de verdad el drenaje de stock quedaría bloqueado. Con esto sale del cierre/reparto del
> 29/07 (correcto: no salió).
>
> Nota (dato — corrección manual de stock + revisión, 31/07): **NP 97822 → 256 y 502**.
> Revisión pedida por el dueño de los dos códigos que quedaron colgando de la reconstrucción
> de la NP **97822** (tanda **C54B**, Superimperio S A; facturada 29/07, despachada 30/07,
> ya cerrada). **256:** góndola (`terminado`) estaba en **−3**, un negativo imposible — sus
> **únicos** movimientos son 3 pickings (C75A/C87C/C98B) que descontaron góndola **sin ninguna
> recepción/guardado/inicial** que la acreditara; el pipeline ya estaba en 0 (la porción de la
> 97822 se facturó/barrió el 29/07). Se insertó un **ajuste +3 en `terminado`** (legajo
> `ajuste`, `client_id fix_256_gondola_neg_20260731`, id 19870) → góndola **−3 → 0**. ⚠ Si hay
> stock físico real de 256, sumar otro ajuste tras contar (el 0 es sólo el piso: saca el
> negativo imposible). **502** (Abrelatas Mariposa): **NO se tocó** — sus "remanentes en el
> pipeline" (a_facturar C99H **+6** / C99J **+4**; separar_pedidos C99K **+4**) son **todos del
> 31/07** = trabajo en curso normal (pickeado/armado sin facturar aún), no un cuelgue; la
> porción de la 97822 ya neteó a 0. **Insumos 505C/CB01/523C/H201Lever → HECHO** (mismo
> mensaje; decisión del dueño en el chat: **saldo en unidades** con el desglose "MC×UNI" como
> dato en la descripción, bajo **códigos numéricos**). Se puso en 0 lo viejo (505C insumos
> 168000, CB01 insumos 2950, 523C racks 240) y se cargó en `insumos` (unidad `Uni`,
> ubicación=sector): **2955**=142000 (X20) · **4626**=2950 (N7) · **1685**=6000 (W1) ·
> **2815**=26400 (O1; Cabezal Importado, confirmado **distinto** del Espiral 2805). Quedan
> aparte los negativos compuestos `505C·CUCHILLA CHINA` (−16000/−6) y `523C·CREMALLERA`
> (−30 MC) = sub-ledger de entregas, cleanup separado. Propuesta **2769** → hecha.
>
> Nota (dato — lock huérfano, 31/07): **tanda D01A "pickeando" fantasma**. D01A figuraba como
> *pickeando por el legajo 122* (Adrian Villalba) pero **no se había pickeado nada**: había un
> **lock en `Tandas_Lock`** (fase picking, 122, 12:00:34) **sin ningún evento** EP/PKC/TP ni
> movimiento de stock (la agarró, no la pickeó, y a las 13:30 pasó a armar C99K). Los locks se
> auto-expiran a las **+10h**, pero éste tenía ~2h → seguía bloqueando. Se **borró el lock** de
> D01A (queda libre para pickear). ⚠ Quedan 2 locks de **legajo 999** (sistema/test) <10h —
> C72F picking y D11X armado — que también podrían ser fantasma; no se tocaron.
>
> Nota (dato — baja de stock, 31/07): **14 insumos FLEJE/ALAMBRE dados de baja** (pedido del
> dueño: "los art con ese cod dar de baja el stock"). Códigos compuestos (`nombre·medida`) con
> nombres fragmentados (FLEJES **CHEF** / **LOEKE** / **LOEKEMEYER** para la misma familia) y
> separador decimal mezclado (`1.00` vs `1,00`) — todos puestos en **saldo 0** con un `ajuste`
> −saldo por código (legajo `ajuste`, `client_id baja_*`, en la unidad original). Bajados:
> ALAMBRE LARGO·11 (110 Kg) · FLEJE ESPIRAL·1 (46 Kg) · FLEJE PROLIPROPILENO·SUNCHOS 12 MM
> (9 u) · FLEJE·11.00 X 0.90 (8750 u) · FLEJE·91 X 1,75 (258 Kg) · FLEJES CHEF·1.00 X 121 (112) ·
> ·1.00 X 84 (154) · ·1.50 X 132 (165) · ·1.50 X 84 (155 Kg) · FLEJES LOEKE·1,00 X 121 (335) ·
> ·1.00 X 84 (315) · ·1.50 X 132 (583 Kg) · FLEJES LOEKEMEYER·0.80 X 64 (161 Kg) · ·1.50 X 84
> (922). Reversible (event-sourced): reponer = `ajuste` +saldo si fue error. **Además** se dio
> de baja **1266500** ("Abs", 850 Kg + 13 en unidad "325"/"Avc") → 0. **863** (*Corta Pizza
> Grande*, **producto de VENTA** con góndola 26 + excedente 25) y el código **ABS** (18 Bolsas /
> −6 Uni): el dueño confirmó **NO darlos de baja** → quedan **intactos**.
>
> Nota (dato — descripciones + recodificación de insumos, 31/07): **(a)** Descripciones a códigos
> de partes que estaban sin nombre (UPDATE de `descripcion` en `Movimientos_Stock`, no afecta
> saldos): **942P** Parte Cuchara Ac. Inox · **943P** Parte Cucharon Ac. Inox · **944P** Parte
> Cuchara Fideos Ac. Inox · **945P** Parte Espátula Calada Ac. Inox · **948P** Parte Espumadera
> Ac. Inox · **967H** Mango Bambu. **(b)** Recodificación de insumos de alambre (UPDATE `cod_art`,
> se guarda la forma **canónica** sin ceros a la izq porque el trigger `fn_canon_cod_art`
> normaliza `0605`→`605`): **1062500 → 605** ("60 x 2.1", 664 Kg) · **1071500 → 695** ("11 x 0.9",
> 337 Kg). ⚠ **1060500 → 0565 NO se hizo**: `0565` canoniza a **565** = **"Pinza De Hielo"**,
> producto de VENTA activo en `OC_Maximos` — renombrar ahí fusionaría el alambre con el producto.
> **Decisión del dueño:** al ver que en Virgilio el `0` no distingue (`0565`=`565`), **dejar
> 1060500 con su código actual** (no se renombra). Mismatch conocido: la convención del dueño
> usa el cero a la izquierda como significativo; Virgilio lo saca (fix histórico 66/066). **(c)**
> Renombrados los mangos (eran códigos por nombre): **MANGO NEGRO PELADOR → 4496** ("Mango Pelador
> Ergonómico Negro", 8750) y **MANGO ROJO PELADOR → 666** (pedido "0666"; queda `666` por la misma
> normalización, "Mango Pelador 505 Rojo", 27000). **(d)** Art **727** dado de baja ("no existe"):
> tenía góndola **7** de una recepción errónea (remito 38481, guardada por leg 104 el 10/07);
> `ajuste terminado −7` → 0 (`client_id baja_727_noexiste_20260731`, reversible). ⏳ Si se quiere
> **borrar las filas** del todo (no solo dejar en 0), avisar.
>
> Nota (dato — ubicación + consolidación + góndola, 31/07): **(a)** Ubicación **948E → I11**
> (orden 186) escrita en la tabla `Planimetria` (antes solo estaba en la planimetría estática
> `planimetria.js`; la familia 94xE/95xE es reciente y podía figurar "sin planimetría" en la app
> desplegada). **(b)** Consolidados los duplicados de partes: **942P·942P → 942P** · **943P·943P →
> 943P** · **944P·944P → 944P** · **945P·945P → 945P** · **948P·948P → 948P** (UPDATE `cod_art` +
> descripción buena — el compuesto traía la desc corta "942P" que le ganaba a "Parte Cuchara…" en
> la vista). Cada compuesto era `insumos MC −2`; ahora quedan bajo un solo código. **(c)**
> Corrección de góndola (`terminado`) por conteo físico: **702** 60→**0** · **702E** 110→**97** ·
> **702EN** **−36**→**20** (ajustes `terminado`; el 702EN sacaba un negativo imposible). ⚠ Fuera
> del pedido, quedó sin tocar el **702EN `a_facturar` −52** — anomalía aparte a revisar.
>
> Nota: **v6.80 — Abastecimiento: se sacó el intro y los títulos quedan fijos**. Se eliminó
> el párrafo de explicación (la nota de importados excluidos pasó al headline). La tabla ahora
> scrollea internamente (`.abast-tblwrap` `max-height:64vh`) con el **thead sticky** (las dos
> filas de encabezado: grupo `top:0`, columnas `top:27px`; `border-collapse:separate` para que
> los bordes acompañen). Bump `APP_VERSION`/`SW_VERSION` `v6.80`.
>
> Nota: **v6.79 — Abastecimiento: códigos con 0 adelante, estética y meses anteriores**.
> (1) Los códigos numéricos se muestran a 3 dígitos (`_abastCodDisp`: "31"→"031", "7"→"007";
> los que tienen letras quedan igual) — display, no cambia joins; el buscador matchea ambas
> formas. (2) Estética: código como pill, zebra en filas, fila abierta resaltada, tabla con
> borde/redondeo. (3) El detalle mes a mes muestra los últimos 6 meses con un botón
> **"▾ ver los N meses"** (`abastToggleMeses`) para ver todo el historial. Bump `APP_VERSION`/
> `SW_VERSION` `v6.79`.
>
> Nota: **v6.78 — Abastecimiento: la "falta de capacidad" ya no suena si hay stock de sobra**.
> Que un fabricante entregue menos de lo que se vende NO es problema si el stock alcanza para
> los pedidos: se entrega menos a propósito cuando hay sobrestock (lo pide el usuario). Ahora
> el problema de capacidad es `capReal = capFalla && stkFalla` (fabrican < venta **Y** falta
> stock para lo pedido). Si `capFalla` pero el stock cubre los pedidos (`falta=0`), se muestra
> una nota gris "🏭 −X/m (cubierto por stock)" en vez de warning, y no cuenta en el headline.
> Ej. `587`: recibió 379 / vendió 285 (fabricó menos) pero stock 543 vs 98 pedidos → sin alarma.
> Bump `APP_VERSION`/`SW_VERSION` `v6.78`.
>
> Nota: **v6.77 — Abastecimiento: una sola vista integrada** (se sacó el toggle de v6.74).
> Ahora una única tabla muestra por artículo, con dos grupos de columnas: **🏭 Fabricación
> vs Venta** (fabricantes, recibido/mes, vendido/mes, balance/mes — prom 3 meses) y **📦
> Stock vs Pedidos (hoy)** (stock actual total, pedido pendiente, falta p/ normalizar),
> más una columna de Estado con chips combinados. Ordena peor primero (urgente=falta stock,
> luego estructural=fabricación no alcanza). Al expandir una fila se ven las **dos** sub-tablas
> lado a lado (mes a mes con fabricantes + stock por depósito). Se eliminaron `abastSetTab`/
> `abastRenderFab`/`abastRenderStock`; todo vive en `abastRender`. Bump `APP_VERSION`/`SW_VERSION` `v6.77`.
>
> Nota: **v6.76 — Abastecimiento excluye los artículos IMPORTADOS (código con "E")**.
> Los códigos que contienen `E` (ej. `870E`, `812E`, `439EL`, `702EN`) son importados y
> se analizan por otro lado (pedido del usuario), así que el módulo Abastecimiento (ambas
> sub-vistas) los saca del análisis. Helper `_abastEsImportado(cod)` = `/E/i.test(cod)`;
> `abastCompute` filtra esos códigos y expone `nImport` (se muestra en el intro: "Importados
> excluidos: N"). Bump `APP_VERSION`/`SW_VERSION` `v6.76`.
>
> Nota: **v6.75 — Fix: el buscador de Abastecimiento sólo dejaba tipear 1 dígito**.
> El `oninput` re-dibujaba todo el body (`abastRender`) en cada tecla → el `<input>` se
> recreaba y perdía el foco. Nuevo `abastSetFiltro(v)` con `id="abastFiltroInp"` que, tras
> re-renderizar, vuelve a enfocar y deja el cursor al final (mismo patrón que `pppSetSearch`).
> Bump `APP_VERSION`/`SW_VERSION` `v6.75`.
>
> Nota: **v6.74 — El módulo "📈 Abastecimiento vs Venta" ahora tiene 2 sub-vistas**
> (toggle arriba): **🏭 Fabricación vs Venta** (la de v6.73) y **📦 Stock vs Pedidos**
> (nueva). La nueva cruza, por artículo, el **stock actual total** (suma de TODOS los
> depósitos de producto terminado: terminado/góndola + excedente + separar_pedidos +
> a_facturar + a_guardar + racks + racks_ch + para_envasar — **NO** insumos, que van en
> unidades heterogéneas) contra los **pedidos pendientes** (NP programadas en el PPP y
> **no** facturadas, cajas por artículo de `PPP_Base_Pedidos`), y muestra **"Falta p/
> normalizar"** = `max(0, pedidos − stock)` **sólo si hay pedidos** (un saldo negativo sin
> demanda es inconsistencia, no necesidad → no cuenta). Al tocar una fila se ve en qué
> depósitos está el stock. Datos desde la vista nueva **`vista_stock_vs_pedidos`**
> (`security_invoker=true`, select `anon`/`authenticated`; misma normalización de `cod`
> que venta/recepción: upper+btrim+strip ceros). Front: `abastCompute(recep,venta,sp)`,
> `abastSetTab`, `abastRenderFab`, `abastRenderStock`. Bump `APP_VERSION`/`SW_VERSION` `v6.74`.
>
> Nota: **v6.73 — Nuevo módulo "📈 Abastecimiento vs Venta"** (botón en el panel de
> supervisor, al lado de "Rendimiento de operarios"). Muestra, **por artículo**, cuántas
> cajas te **ENTREGA cada fabricante/tallerista por mes** contra cuánto **VENDÉS**, para
> ver si la fabricación alcanza el ritmo de venta y si conviene **sumar otro fabricante**
> (ej. el `031`: jul recibido 701 / vendido 862 → balance **−161**, con **1 solo
> fabricante** → falta capacidad). Ventana: **último mes completo** + **promedio de los
> últimos 3 meses**; la fila se expande al mes-a-mes con los fabricantes de cada mes.
> Datos desde dos vistas nuevas de Supabase (`security_invoker=true`, select para
> `anon`/`authenticated`): **`vista_recepcion_mensual`** (parsea `Control_Modo_OP.detalle`
> "cod → cajas" por mes y proveedor) y **`vista_venta_mensual`** (`Entregas_Virgilio`
> agrupado por mes). Front: `openAbastecimiento`/`abastCompute`/`abastRender`/`abastToggle`
> en `index.html`. Bump `APP_VERSION`/`SW_VERSION` `v6.73`.
>
> Nota: **v6.72 — Fix: subir foto en Recepción fallaba con "row-level security policy"**.
> El cliente de `recepcion.js` se autentica con **`signInAnonymously()`** (rol
> `authenticated`); el **31/07 el login anónimo dejó de crear usuarios** (0 usuarios
> anónimos nuevos ese día, venían 3-12/día) → el cliente mandaba una sesión rota/vencida
> y la subida al bucket `remitos` fallaba con RLS. La **policy RLS estaba bien** (anon y
> authenticated pueden insertar en `remitos` **y** en `Control_Modo_OP` — verificado), o
> sea recepción **no necesita** la sesión anónima. Fix en **`pendUploadFoto`**: si la
> subida falla, renueva la sesión anónima y, si tampoco, hace `signOut` y reintenta con
> la **publishable key** (rol `anon`, que la RLS permite) → la foto entra igual sin
> depender del login. Bump `recepcion.js?v=3.73` + `APP_VERSION`/`SW_VERSION` `v6.72`.
> ⚠ **Causa raíz pendiente (config, no código):** re-habilitar "Allow anonymous
> sign-ins" en Supabase → Authentication (alguien lo desactivó o pegó un límite hoy);
> si otras cosas usan la sesión anónima de recepción, conviene restaurarlo.
>
> Nota: **v6.71 — El monitor (TV) saca las tandas ya FACTURADAS Y DESPACHADAS**
> (pedido del usuario: "las tandas que están FC y se despacharon en el camión no
> tienen que estar acá"). Antes una tanda quedaba en el tablero hasta que la limpiaba
> el sync del Sheet (o el CRN de entrega), así que las facturadas+cargadas seguían
> figurando (ej. C98J). Ahora `renderMonitor` filtra: una tanda cuyas **todas** las NP
> están **facturadas** (`_facNpsHoy`/`_facNpsTodos`) **y despachadas** (evento `CCN`,
> salvo que un `FSS` más reciente la haya devuelto) se saca de la tabla principal **y**
> del panel "Tandas a FC". El set de despachadas lo trae **`fetchDespachadosTodos()`**
> (nuevo; `_ccnNpsTodos`, mismo TTL/patrón que las facturadas, disparado fire-and-forget
> en cada refresh). Reusa `fetchSinSalidaMap` para respetar los retornos (FSS). Bump
> `APP_VERSION` + `SW_VERSION` `v6.71`.
>
> Nota: **v6.70 — FC s/Salida pasó a ser una COLUMNA de la tabla de Stock (a la
> derecha de Racks), ítem por ítem** (pedido del usuario; reemplaza al segmento que
> había agregado v6.69). Se quitó el segmento «🧾 FC s/Salida» y la vista `stkBodyFcs`;
> ahora cada artículo muestra sus **cajas facturadas sin salida** en una columna nueva
> (celda azul, clickeable → popup `stkOpenFcsArt` con las NP y cajas de cada una), más
> un chip de total en la tira de arriba. Los datos se cargan junto con el stock:
> `stkFcsLoad` se convirtió en **`stkFcsFetch()`** (loader puro `{pend, porArt}`),
> llamado en `openStockAdmin` (no en modo solo-conteo). Artículos que están **solo** en
> FC s/Salida (facturados, ya sin stock contable) se agregan a la tabla igual. Bump
> `APP_VERSION` + `SW_VERSION` `v6.70`.
>
> Nota: **v6.69 — Remito "Facturado sin salida" (volvió al depósito) + FC s/Salida
> ahora es un segmento DENTRO de Stocks** (pedido del usuario). Caso: una NP se cargó
> al camión (`CCN`) pero el cliente estaba cerrado y la mercadería **volvió**. En
> **Recepción Remitos (RR)** cada fila tiene ahora un botón **«↩ s/salida»**
> (`crMarkSinSalida`) que emite un evento nuevo **`FSS`** (`texto = NP|TANDA`,
> `crSendSinSalida`). Regla en **todos los lectores de `CCN`** (helper
> `fetchSinSalidaMap`): una NP está "sin salida" si su **último `FSS` es más reciente
> que su último `CCN`**; si se vuelve a cargar (CCN nuevo) deja de estarlo. Efecto de
> marcar una NP sin salida: **sale de RR** (`fetchCRData`/`showControlRemitos`), **deja
> de contar como entregada** y no dispara la alarma "cargado sin controlar"
> (`pppRefreshEntregado`), **reaparece en «FC s/Salida»** (`stkFcsLoad`) y en **Carga
> Camión** (`fetchCCData`) para re-despacharla. **NO toca el libro de stock**
> (`Movimientos_Stock`): esa mercadería ya salió del stock contable al facturar; FC
> s/Salida es una **vista** (facturado − cargado), no un depósito. Además, **«🧾 FC
> s/Salida» dejó de ser una solapa aparte** del módulo Stock: ahora es un **segmento
> dentro de la solapa «📊 Stocks»** (junto a Stock / Ingresos / Salidas; `stkSetView`
> con carga lazy). Bump `APP_VERSION` + `SW_VERSION` `v6.69`.
>
> Nota: **v6.69 (server) — El cron de reconciliación ahora drena las cajas de
> "Completar Pedido" (CP) de NPs ya facturadas** (pedido del usuario: "en a facturar
> también debe salir porque ya salió"; el CP con legajo 0 es real, no prueba). Es la
> contraparte en **`a_facturar`** del fix de estancado de v6.68 (que arregló el lado
> `a_guardar`): mismo principio "los legajos de sistema/0 NO son basura para el stock".
> Un CP que completa una NP **ya facturada** mete cajas en `a_facturar` con `tipo='cp'`
> y `ref=NP` (sin tanda); el fast-path del cliente (`stockDrenarCPFacturado`) debía
> sacarlas pero falló en 13 casos reales (~202 cajas, ej. NP 98017 art 534), y el cron
> **no las veía** (su ETAPA 3 agrupa por tanda y solo mira `separado`/`facturado`). Se
> agregó la **ETAPA 4** a `reconciliar_pipeline_stock()` (migración
> `pipeline_etapa4_drenar_cp_facturado`): netea el bucket "por NP"
> (`split_part(ref,'|',1)` = número de NP; suma solo `cp`+`facturado`+`ajuste`, excluye
> `rc`/`separado`) y, si queda >0 y la NP está en `Facturacion_NP`, la saca con un
> `facturado` −neto `ref=NP|CP` (mismo formato que el cliente). **Idempotente**
> (net>0→0 + índice único), **nunca negativo**, **no filtra por legajo** (leg 0 =
> real). Las NPs aún **no** facturadas quedan intactas. Se corrió una vez a mano al
> aplicar la migración → drenó los 13 casos colgados. **Sin cambio de cliente**
> (server-side). Detalle en `sql/reconciliar_pipeline_stock.sql`.
>
> Nota: **v6.68 — Prolijado del pop-up de movimientos + "Cerrar" del módulo Consulta NP
> arriba a la derecha**. (a) En el pop-up 🔁/📦 de movimientos por artículo la celda
> MOVIMIENTO pasó a un **flex**: un **slot fijo (20px)** para el "+" (vacío en los que no
> son recepción) → los rótulos (`recepcion`/`guardado`/`cp`…) arrancan **alineados**;
> chips 👤/NP en **pill**; el "+" alineado con la primera línea (le faltaba `margin:0`
> contra el `button{margin-top:14px}` global). Padding y hover de fila más prolijos. (b)
> El botón **Cerrar** del módulo *Consulta de Notas de Pedido — Composición a líos*
> (`npConsultaModal`) estaba suelto en medio del panel → ahora **absoluto arriba a la
> derecha** (`.fac-close-btn.npc`), con `padding-right` en el `h1` para no colisionar.
> Bump `v6.68`. Smoke `mva-quien.cjs` sigue verde.
>
> Nota (backend Supabase): **Fix ESTANCADO — el saldo NO debe filtrar legajo (bug 534/323E)**
> (pedido del dueño, cod 1636). La alerta `reporte_agentes_stock_estancado()` filtraba
> `legajo not in ('0','1')` para saltear datos de prueba, pero varios movimientos REALES
> registran **legajo 0** —típicamente `cp` (completar pedido)—; excluirlos rompía el saldo
> event-sourced. Caso **534**: llegan 6, `cp -1` (legajo 0) saca 1 a `a_facturar`, guardan
> 5 → `a_guardar` = 0; con el filtro parecía "6 − 5 = 1 sin guardar" (falso positivo). Idem
> **323E**. Ahora la función computa el saldo sobre **TODOS** los movimientos (sin filtrar
> legajo), igual que `stockComputeSaldos` en la app → la alerta coincide con lo que muestra
> la app. Los legajos de sistema ('pipeline','reconcilia','0') NO son basura para el stock.
> Deployado + `sql/stock_estancado.sql` actualizado.
>
> Nota (dato — corrección manual de stock, 31/07): **824 y 559 "mandados a góndola"**.
> El dueño confirmó que **824** (14 cj, recepción 0245 sin marcar) y **559** (20 cj,
> recepción 38770 sin marcar) se **guardaron físicamente** pero el operario no lo marcó en
> la app (los ítems quedaron en `cargar:0` en el modal MG → `mgConfirmar` solo graba los
> que tienen cantidad; **no es bug**, el guardado multi-código funciona: la tanda de las
> 09:46 del 29/7 grabó 325+521+735 juntos). Se insertó el `guardado` correctivo
> (`a_guardar → terminado`, legajo `ajuste`, `client_id` `fix_*`): 824 a_guardar 14→0 /
> góndola 208→222; 559 a_guardar 20→0 / góndola 94→114. **534** ya estaba en 0 (lo resolvió
> el fix de arriba). ⚠ *Ojo UX pendiente*: el modal MG no avisa si quedan códigos en 0 sin
> guardar → fácil olvidarse uno.
>
> Nota: **v6.67 — Pop-up de movimientos por artículo: (a) "+" que despliega la ENTREGA
> completa y (b) columnas en 0 clickeables si tuvieron movimientos**. Dos pedidos del
> dueño sobre el pop-up 🔁/📦 de un artículo (Stock y Compras → tocar una columna de la
> tabla). **(a)** Cada fila de `recepcion` trae ahora un **`+`** que abre un panel con la
> **entrega completa**: 📅 **día**, **Proveedor/Tallerista** + nombre, **RTO/FC**, y los
> **códigos con cuántas cajas de cada uno** (el código del artículo abierto queda
> resaltado en verde). Fuente: **`Control_Modo_OP`** (recepcion.js graba una fila por
> envío: `fecha`, `tipo` `tallerista`/`prov_at`, `nombre`, `remito`, `detalle`=`"cod →
> cajas · …"`); se busca por `remito` y se elige la fila del **mismo día** (si el remito
> se reusó). Si no hay fila (envíos viejos), **fallback**: arma los códigos/cajas desde
> los propios movimientos de recepción del mismo remito+día (`_stk.movs`), sin el nombre
> del proveedor. Funciones `stkRtoToggle` / `stkRtoFetch` / `_stkRtoDetail`. **(b)** En la
> tabla de stock, las celdas de depósito (Góndola/Excedente/Pickeados/A facturar/A
> guardar/Racks) ahora son **clickeables aunque el saldo sea 0**, si el artículo **tuvo
> movimientos** ahí alguna vez (el pop-up muestra el historial que neteó a 0). Se marca en
> **gris** (`stk-hist0`) con tooltip "Saldo 0 ahora, pero tuvo movimientos". Se cachea el
> set `codN|deposito` en `_stk._histDeps` (O(movs) una vez, no por tecla). Smoke
> `tests/mva-quien.cjs` extendido. Bump `v6.67`.
>
> Nota: **"ESTANCADO" — definición FINAL del dueño: se mide por CICLO, no por el
> histórico del código** (backend Supabase, `sql/stock_estancado.sql`, función
> `reporte_agentes_stock_estancado()`). **Estancado = de lo que LLEGÓ guardaron una
> PARTE (entre góndola y excedente) pero NO la TOTALIDAD** → el resto quedó trabado.
> Ej del dueño: llegan 14, guardan 10, quedan **4 a guardar** → **ESO** es estancado.
> La versión anterior miraba "¿hubo algún `guardado` para este código alguna vez?"
> sobre **todo el histórico** → daba **falsos positivos** con los códigos de rotación:
> caso real **824** (llegan 10 → guardan 10 · llegan 22 → guardan 22 · llegan 14 y
> nadie las tocó todavía) salía como estancado, cuando en realidad es una **recepción
> nueva intacta = pendiente normal**. Ahora se calcula el **saldo corrido** de
> `a_guardar` por código y se toma el **ciclo abierto** = lo que pasó **después** del
> último movimiento que dejó el saldo en **0** (la última vez que se guardó todo).
> Es estancado sólo si **dentro de ese ciclo** hubo un `guardado` y quedó resto. La
> **cantidad** informada es el **resto que dejó el último `guardado` del ciclo** (no
> el saldo total: si después llegó una recepción nueva, esas cajas son pendiente
> normal), y la **antigüedad** se cuenta desde **ese `guardado`** — o sea, desde
> cuándo se dejó el resto sin terminar. Se mantiene todo lo demás: días **hábiles**
> (lun–vie), umbral `Stock_Config.dias_estancado` (default 2), caso (2) *pickeado sin
> avanzar* (`separar_pedidos`/`a_facturar`) igual, sólo Telegram, respeta cutoff,
> excluye legajos 0/1, dedup diario, encadenada al cron de agentes (jobid 14).
> Verificado read-only hoy (31/07): pasa de **20** códigos "a guardar" con el criterio
> viejo a **3 restos reales** (534, 323E, 731 — ej. 731: llegaron 83+64, guardaron 83,
> quedan **64** sin guardar), y **824 ya no aparece**.
>
> Nota: **v6.66 — 👤 SIGLAS + LEGAJO de quién hizo cada movimiento (y de quién recibió)
> en el detalle por artículo**. En el pop-up de movimientos de un depósito (📦 A guardar,
> 🔁 Góndola, 🏗 Racks — `_stkMovsBlock`) cada fila muestra ahora un chip
> `👤 SIGLAS · legajo` al lado del movimiento. De dónde sale: **(a)** si el movimiento
> trae `Movimientos_Stock.legajo` (guardado, picking, ajustes… y las recepciones nuevas
> desde la **idea 7725**, 30/07/2026) → chip **gris**, dato exacto; **(b)** si es una
> `recepcion` **sin** legajo (todas las anteriores al 30/07 lo tienen **NULL**) → se
> **deduce por la sesión de RT**: el evento `RT` de `Registros_Produccion_Virgilio`
> (la fila de cierre trae `ts_inicio`=arranque y `ts_cliente`=cierre; la de apertura,
> sólo `ts_cliente`=arranque) cuyo intervalo **contiene** el `ts` del movimiento → chip
> **ámbar con `~`** (aproximado). Si dos sesiones se superponen gana la que **arrancó
> más tarde**; hay 10 min de gracia al cierre (el movimiento se inserta un toque después
> de cerrar el RT); si ninguna lo contiene, **no se inventa** nada (sin chip). Las siglas
> salen de `Empleados` vía `getEmpleadosNombres()` + `initialsFromName()`; el nombre
> completo va en el `title` (hover). Nuevo smoke `tests/mva-quien.cjs`. Bump `v6.66`.
>
> Nota: **idea 7382 — Saldo de insumos SEPARADO por unidad**. El saldo de insumos
> (`vista_saldos_stock.insumos`) sumaba `delta` mezclando unidades heterogéneas (kg, Uni,
> Bolsas, MC, Paquetes, null…) como si fueran cajas → número sin sentido físico. Ahora
> **(a)** vista aditiva nueva **`vista_saldos_insumos_x_unidad`** (`cod_art`, `unidad`,
> `saldo`; una fila por unidad; variantes de case como kg/Kg se unifican; `security_invoker`,
> `grant select` anon/authenticated; DDL en `sql/vista_saldos_insumos_x_unidad.sql`), y
> **(b)** la solapa **Insumos** de Stock desglosa el saldo por unidad cuando un artículo
> tiene movimientos en más de una (marca **⚠ varias**), y **(c)** el módulo de **conteo/
> entrega de insumos** (`insLoad`/`insRender`) también: lee `vista_saldos_insumos_x_unidad`,
> el chip de unidad arranca en la unidad real del saldo, la referencia "stock:" se muestra
> por unidad y el aviso "quedaría en…" es por la unidad seleccionada. `vista_saldos_stock`
> **no** se tocó (retro-compatible).
>
> Nota: **v6.65 — Pulidos de facturación (hallazgos revisor-render)** (commit `30ea5ad`).
> Ajustes de UI del módulo de Facturación surgidos de la auditoría de render. Además, en
> esta pasada se **documentó el subsistema de facturación en el catálogo de tablas (§3)**:
> `Facturacion_NP`, `Facturacion_Cierres`, `Comprobantes_ARCA` + la Edge Function
> `arca-wsfe`, y el subsistema **NC** (`Comprobantes_NC` / `Comprobantes_NC_Items`,
> `agente-local/nc_ingest.py`); y se corrigieron las versiones fósiles v3.51/v3.47 en §1/§10
> (ahora `APP_VERSION`/`SW_VERSION` = **v6.65**).
>
> Nota: **🎉 HITO — Facturación electrónica ARCA en PRODUCCIÓN (facturas reales con validez fiscal)** (server-side, 2026-07-30). La Edge Function **`arca-wsfe`** pasó de homologación a **`ARCA_ENV=prod`**: usa el **certificado de producción `virgilioapp`** (creado en AFIP, con el servicio **`wsfe`** autorizado) y el **punto de venta 11** ("APP PRODUCCIÓN WS"). **Login WSAA confirmado** y **primera Factura A real emitida: NP 98277, CAE `86316114309666`**. La app emite **Factura A con validez fiscal** al tocar **"Facturar (pedir CAE)"** en el modal de Facturación. **Secrets en Supabase** (nunca en el repo): `ARCA_CERT` + `ARCA_KEY` (cert+key de `virgilioapp`), `ARCA_ENV=prod`, `ARCA_PTO_VTA=11`, `ARCA_CUIT=30515842450`, `ARCA_EMITIR=on`, `WEB_SERVICE_KEY` (service_role del proyecto web, para leer precios/CUIT sin exponerlos). Los comprobantes se loguean en **`Comprobantes_ARCA`** con `entorno='prod'`. Detalle en `docs/facturacion-arca.md`. ⚠ **Supera** las notas previas que decían "por ahora HOMOLOGACIÓN" (v6.51) y la prueba homo end-to-end (2026-07-30): el entorno vivo ahora es **producción, emitiendo facturas reales**.
>
> Nota: **v6.64 — Facturación: Notas de Crédito (anular una factura ya emitida)**. Nueva acción **`emitir_nc`** en la Edge Function `arca-wsfe` (commit `8319b6d`): busca la factura original en `Comprobantes_ARCA` por **CAE** (o por **NP**, con `tipo_cbte in (1,6,11)`) —solo `estado='autorizado'`—, valida **mismo entorno** y **mismo PV**, y emite la **Nota de Crédito del tipo correspondiente** (FA A(1)→**NC A(3)**, FA B(6)→NC B(8), FA C(11)→NC C(13); mapa `ncMap`, default 3) por el **mismo importe** (neto/IVA/total del original), con el bloque **`CbtesAsoc`** que referencia la factura anulada (Tipo/PtoVta/Nro). En la app, botón **"🧾 Anular factura (Nota de Crédito)"** en el bloque de **cierre de jornada** (`.fac-cierre`); funciones nuevas **`facNCOpen`** / **`facNCEmitir`** (+ `facNCClose`). **Acciones de `arca-wsfe` ahora:** `status`, `ta`, `ultimo`, `emitir`, `preciar`, `emitir_np`, `emitir_nc`. Bump `APP_VERSION` + `SW_VERSION` `v6.64`.
>
> Nota: **v6.63 — Fix de render en celular de la tabla de facturación** (regresiones de v6.61, commit `13ec659`). Ajustes de CSS (`min-width`, `overflow-x`) para que la tabla de NPs de Facturación no desborde el body en pantallas chicas y scrollee dentro de su wrapper. Solo UI. Bump `APP_VERSION` + `SW_VERSION` `v6.63`.
>
> Nota: **v6.62 (2ª parte) — Facturación: el cartel de validez fiscal depende del entorno REAL** (commit `8ae8621`). En el modal "Facturar electrónicamente" (`facFCOpen`) el cartel ya **no** está hardcodeado a "homologación": se dibuja según el campo **`d.entorno`** que devuelven las acciones **`preciar`** / **`emitir_np`** de `arca-wsfe` (= el secret `ARCA_ENV`). **prod →** "✔ Producción — factura con validez fiscal" (`.facfc-note-prod`); **homo →** "Homologación — sin validez fiscal". Todas las acciones de la función devuelven ahora `entorno` en la respuesta. Bump `v6.62`. (Nota: hubo **dos** commits v6.62; el otro es la unificación PPP de la nota siguiente.)
>
> Nota: **Integración con ISIS (contabilidad + stock) — en definición** (docs, 2026-07-30). El dueño quiere **facturar desde la app** y que esas ventas **entren solas al ISIS** (stock + contabilidad/libro IVA), con **cero carga manual**. Veredicto técnico: **"Modelo A"** — la app **empuja el pedido a la API `/api/ISISPedido`** del ISIS y el ISIS **auto-factura** (emite CAE + mueve stock + contabiliza, patrón "Balcony" de Mercado Libre); la emisión directa por **PV 11** (`arca-wsfe`) queda como **respaldo**. Se descartó el "Comprobante Manual" (es carga manual) y el Modelo B (no hay API para registrar un CAE ya emitido). **Pendiente (comercial + soporte del proveedor):** doc real del endpoint (auth+payload), si soporta **cuenta corriente** (no solo contado), si requiere el módulo pago **Balcony** y su costo, y evaluar **ISIS Cloud** (para que la API sea alcanzable desde la app cloud). Detalle vivo en **`docs/integracion-isis.md`**.
>
> Nota: **v6.62 — Unificado PPP / "PPP Espejo" (eran lo mismo)**. El botón **"🪞 PPP Espejo"** del panel de Administración —agregado en v6.46 como *seam* a futuro, pero que **por ahora solo delegaba en `openPPP()`**, o sea idéntico a PPP— se **removió** por pedido del dueño ("son lo mismo, unificalos"). Se sacó el botón y la función `openPPPEspejo()`. Los primarios quedan en **10** (grid `repeat(6,1fr)` → 6+4, sin cambio de CSS). Verificado render (sin overflow) + checkhtml + smoke. Bump `v6.62`.
>
> Nota: **v6.61 — Facturación: desglose del P.unit en el modal ARCA, tic azul "✓ ARCA" y lista de NPs ya tildadas hoy**. Solo **UI** del módulo de facturación (`index.html` + bump `sw.js`, commit `5358799`); **no** cambia el modelo de datos ni los códigos `opcion`. **(A) DESGLOSE DEL P.UNIT** en el modal "Facturar electrónicamente" (`facFCOpen`): bajo cada precio unitario de la tabla aparece el desglose **`lista $X −N% −2%`** (clase `.facfc-des`; solo si el ítem trae `list_price`) y al pie una **línea de fórmula** (`.facfc-formula`): **"P.unit = precio de lista − N% dto volumen − 2% dto fijo (sin IVA)"**. Los datos salen de la acción **`preciar`** de la Edge Function **`arca-wsfe`** (campos `list_price`, `dto_vol`, `precio_unit` por ítem del `detalle`); `N` = `dto_vol × 100` redondeado a 1 decimal (`dtoPct`), y se omite el " −N%" cuando el dto es 0. Reafirma la regla ya vigente (v6.51): **`neto_unit = list_price × (1 − dto_vol) × (1 − 2%)`**, IVA 21%, precios sin IVA. **(B) COLUMNA ACCIÓN** de la tabla de NPs (`facRender`): el 2º botón (antes 🧾, "Facturar electrónicamente") pasó a ser un **tic azul apilado** — "✓" arriba, "ARCA" abajo (clases `.fac-btn-fc` / `.fac-btn-fc-tic` / `.fac-btn-fc-lbl`; sigue llamando a **`facFacturarNP`**) —; los dos botones de la celda (el ✓ verde de tildar `facTickNP` + el tic azul ARCA) quedan **centrados verticalmente** en la fila (celda `.fac-accion-cell`, `vertical-align:middle`). **(C) LISTA DE NPs YA TILDADAS HOY:** debajo del botón "🗺️ Armar ruta de reparto de mañana" (dentro del bloque `.fac-cierre` "Cierre de jornada") se agregó el contenedor **`#facTickedList`** (`.fac-ticked-list`) que lista las NPs de **`_facNpsHoy`** (tildadas y pendientes de cierre) con **NP · tanda · razón social** (los detalles se buscan en `_facLastTandas`). Lo dibuja la función nueva **`facRenderTicked()`**, invocada dentro de **`facRender()`**, así se refresca en cada tilde, reversión, cierre y reconciliación. Bump `APP_VERSION` + `SW_VERSION` `v6.61`.
>
> Nota: **v6.60 — Pop-up del Resumen: 3+ NPs correlativas como rango ("44506 a 08")**. Ajuste sobre v6.59 (`_pppNpsCompact`, `index.html`, commit `20603ac`): las NPs se agrupan primero en **corridas de números CONSECUTIVOS** (mismo largo, numéricas); una corrida de **3 o más** se muestra como **rango** — la 1ª completa + `" a "` + sufijo compacto de la última (mínimo 2 dígitos): `44506 a 08`, `44598 a 600` —; los **pares** siguen como `44506/07` y las **salteadas** como `44598/601`; las corridas se unen con `/` (ej. `44506 a 09/12`, `44506/08 a 10`). Helper interno **`sufijo(np, prev)`** (extrae la lógica de "dígitos que cambian" de v6.59). Bump `APP_VERSION` + `SW_VERSION` `v6.60`.
>
> Nota: **v6.59 — Pop-up del Resumen: NPs del mismo cliente unificadas en una fila**. Ajuste sobre v6.58 pedido por el dueño (`pppResTgl`, `index.html`, commit `932d564`): en el pop-up de composición las filas se **agrupan por CLIENTE** (`razon_social`; si no hay, cada NP queda sola) — cada fila muestra sus **NPs en notación compacta** vía el helper nuevo **`_pppNpsCompact`** (la 1ª NP completa; las siguientes solo los **dígitos que cambian** respecto de la anterior, con **mínimo 2** — correlativas `44506/07`, salteadas con cambio de centena `44598/601`; solo aplica entre NPs **numéricas del mismo largo**, si no va completa; ⚠ desde v6.60, 3+ correlativas se muestran como rango `44506 a 08`), **tandas únicas** unidas con `/`, **localidades únicas** con ` / `, y el **m³ SUMADO** del cliente; NPs ordenadas numéricamente asc dentro de la fila, filas por **m³ desc**. La línea resumen (`.pppres-sum`) agrega **"· N cliente(s)"** cuando hubo unificación (`merged < items`). La agrupación es **solo de display**: los datos de `_pppResDet` no cambian. Bump `APP_VERSION` + `SW_VERSION` `v6.59`.
>
> Nota: **v6.58 — PPP Resumen: la composición pasa a un pop-up estructurado**. Ajuste sobre v6.57 pedido por el dueño (`index.html`, commit `1dde633`): el click en las celdas del Resumen (**Z1–Z7, Retira, Súper y Total**) ya **no despliega la fila inline de chips** sino un **modal** (`#pppResPopOv`, clase `.pppres-ov`, `z-index:1400`, se crea on-demand y se agrega a `body`): encabezado oscuro con **"🧩 zona · fecha"** y botón **✕** (`.pppres-x`), línea resumen **"N NP(s) · X m³"** (`.pppres-sum`), y tabla **`.pppres-tbl`** con columnas **NP · Tanda · Cliente · Localidad · m³** — ordenada por **m³ desc**, NP en monoespaciada (`.np`), **total en `tfoot`** (⚠ desde v6.59 la tabla muestra **una fila por cliente**, no por NP), cuerpo scrolleable (`.pppres-wrap`, `max-height:60vh`) con **thead sticky**. Cierra con ✕ o click en el fondo del overlay. **`pppResTgl(dk, zkey)`** ahora arma el modal (se **eliminaron** `_pppResOpenKey` y la fila `tr.ppp-res-detrow` + CSS `.ppp-res-det`/`.ppp-res-np`); `_pppResDet[dk].__fecha__` guarda la fecha del día para el título; función nueva **`pppResPopClose()`**. Bump `APP_VERSION` + `SW_VERSION` `v6.58`.
>
> Nota: **v6.57 — PPP Resumen: click en cada celda muestra de qué NPs se compone**. En la solapa **Resumen** de la PPP (`pppResumenHtml`, `index.html`, commit `065baf8`), cada número de la tabla — **Z1–Z7, Retira, Súper y el Total m³ del día** — pasa a ser **clickeable** (clase `.zc`, hover con outline; las celdas en cero `z0` NO son clickeables): despliega debajo de la fila del día una **fila de detalle** (`tr.ppp-res-detrow`, `colspan 14`, oculta por defecto; ⚠ la fila inline fue **superada por v6.58**: la composición ahora se muestra en un pop-up) con **chips de las NPs que componen ese número** — NP · tanda · cliente · localidad · m³ — ordenadas por **m³ desc**, con encabezado "zona — N NP(s) · X m³". **Segundo click** en la misma celda la cierra; click en **otra celda del mismo día** cambia el contenido. La composición se acumula en **`_pppResDet`** (mapa fecha→zona→items, más la clave `__tot__` con todas las NPs del día) al armar la tabla, y **`pppResTgl(dk, zkey)`** la despliega (estado abierto en `_pppResOpenKey`). Se eliminó el helper `cell` que quedó sin uso (el render de celdas se inline-ó para meter el `onclick`). CSS nuevo bajo `.ppp-restbl`: `.zc`, `.ppp-res-detrow`, `.ppp-res-det`(+`-h`), `.ppp-res-np`. Bump `APP_VERSION` + `SW_VERSION` `v6.57`.
>
> Nota: **v6.56 — Histórico de Recepción: el botón ＋ de filtros va al lado del buscador, en dos líneas**. Ajuste de UI sobre v6.55 pedido por el dueño (`renderHistorico`/`histBuscar`, `recepcion.js`, commit `0e18ed9`): el botón ＋ **sale de la fila Buscar/Limpiar** y se ubica a la **DERECHA del campo "Código o quién entregó"**, apilado en **dos líneas** — "＋" arriba (span `.plusIco`) y "filtros" abajo (span `.plusTxt`, id `histMasTxt`). El contador de filtros extra activos pasa a la línea de abajo: **"filtros (2)"** en vez de "＋ (2)" (⚠ supera el texto del botón descripto en v6.55; la lógica de filtros AND no cambia). CSS: `.histBtn.plus` con `flex-direction:column` + estilos de `.plusIco`/`.plusTxt`. Cache-bust **`recepcion.js?v=3.72`** en `index.html`. Bump `APP_VERSION` + `SW_VERSION` `v6.56`.
>
> Nota: **v6.55 — Histórico de Recepción: botón ＋ con filtros extra combinables**. En la barra de filtros del Histórico (`renderHistorico`, `recepcion.js`, commit `d41d93a`), botón nuevo **＋** junto a Buscar/Limpiar que despliega una segunda fila (`.histMore`, CSS nuevo scopeado en `#rcpRoot`) con tres buscadores: **Quién entregó** (`ilike` sobre `Nombre_Tall` en `Entregas Tallerista Virgilio` / `Proveedor` en `Entregas Prov AT`), **Remito** (`ilike Remito` en ambas) y **Cajas mínimas** (`gte` sobre `Cajas`/`Cantidad`). Se **combinan en AND** con el buscador principal (código o quién entregó, v6.54) y las fechas. Enter dispara la búsqueda desde cualquier campo; "Limpiar" vacía todos (`histBuscar` centraliza la lectura de los 6 campos con el helper `v()`); el botón ＋ muestra la cantidad de filtros extra activos ("＋ (2)") y se marca `.on` al desplegarse. Cache-bust **`recepcion.js?v=3.71`** en `index.html`. Bump `APP_VERSION` + `SW_VERSION` `v6.55`.
>
> Nota: **v6.54 — Histórico de Recepción: buscador único + fecha dd/mm + columna Entregó limpia**. Tres ajustes pedidos por el dueño sobre la pantalla "Histórico de Recepción" (v6.50) de `recepcion.js` (`renderHistorico`/`histLoad`/`histRender`), commit `d9dab1e`. **(1) BUSCADOR ÚNICO:** el campo pasa de "Código" a **"Código o quién entregó"** — un solo input que matchea código **O** nombre del que entregó, vía filtro `.or()` de PostgREST: `Cod.ilike/Nombre_Tall.ilike` en `Entregas Tallerista Virgilio` y `Cod_Art.ilike/Proveedor.ilike` en `Entregas Prov AT`. El término se **sanea** (se reemplazan comas y paréntesis por espacio) porque va dentro del `.or()`. **(2) FECHA UNIFORME `dd/mm`** en todas las filas (helper `ddmm` sobre el YMD): antes las filas de talleristas mostraban `04/jun/26` (vía `fechaCorta`) y las de proveedores `04/jun` — ahora ambas `04/06`. **(3) COLUMNA "ENTREGÓ" LIMPIA:** se saca el badge `Prov` y la descripción del artículo — queda solo el nombre. Cache-bust **`recepcion.js?v=3.70`** en `index.html`. Bump `APP_VERSION` + `SW_VERSION` `v6.54`.
>
> Nota: **v6.53 — Fixes visuales del modal de facturación (button{} global) + siempre Factura A**. **(A) VISUAL:** el 🧾 de v6.51 estaba en el DOM pero **no se veía** — el `button{ width:100% }` global (línea 25) hacía que **tanto ✓ como 🧾 ocuparan el 100% de la celda**, así que el 🧾 quedaba apilado/tapado detrás del ✓ (que se veía como barra verde ancha). Diagnosticado con la consola del dueño (`botones_en_pantalla: 1` → estaba, pero invisible). Fix: `.fac-btn-tick` y `.fac-btn-fc` ahora tienen **`width:auto; display:inline-block`** → quedan **chicos y lado a lado**. Verificado headless (rects: ✓ y 🧾 en la misma línea, 🧾 a la derecha, ambos con ancho>0). **(B) SIEMPRE Factura A:** el dueño confirmó que **NO se hace Factura B** — a **todos los clientes, incluidos los monotributistas, se les emite Factura A (tipo 1)**. Así que `emitir_np` emite **siempre tipo 1**, `cond_iva_receptor=1` (Resp.Inscripto) por defecto (ambos overrideables por body si algún día hace falta, pero por defecto es A). No hay selector A/B en el modal. **(C) VISUAL:** se centró la **✕** del modal de facturación (misma causa: el `button{}` global le metía padding/margin) → ahora `.facfc-x` con `display:inline-flex; align-items/justify-content:center; padding:0`. Bump `v6.53`.
>
> Nota: **v6.51 — 2ª tilde "🧾 Facturar" en Facturación (factura electrónica ARCA con importe automático)**. Pedido del dueño: al lado del tilde ✓ actual (que marca facturada + imprime FACTURADO), una **segunda tilde 🧾** que **emite la factura electrónica** contra ARCA. **Front (`index.html`, `facFacturarNP`→`facFCOpen`/`facFCEmitir`):** abre un modal que primero **muestra el importe** (preview) — cliente, CUIT, detalle por artículo, **Neto + IVA 21% + TOTAL** — y con "Facturar (pedir CAE)" **pide el CAE** y lo muestra. Llama a la Edge Function `arca-wsfe` (`arcaCall`). **El importe se calcula SERVER-SIDE** en la función (acciones nuevas **`preciar`** y **`emitir_np`**): cruza los **ítems entregados** de la NP (`Entregas_Virgilio.cajas_entregadas`, service role propio) con los **precios del proyecto web** ("loekemeyer's web", `kwkclwhmoygunqmlegrg`): `products.list_price` + `products.uxb` + `customers.dto_vol` + `customers.cuit`. **Fórmula (dueño):** `neto_unit = list_price × (1 − dto_vol) × (1 − 2%)`, IVA 21%, precios **SIN IVA**. Match de artículos por **código canónico** (066↔66). **Factura A** por defecto (receptor Responsable Inscripto, `doc_tipo=80`, `cond_iva_receptor=1`). Como `customers` está protegida (RLS), la función la lee con **`WEB_SERVICE_KEY`** (service_role del proyecto web, secret) — los precios/CUIT **nunca** se exponen en el navegador. Si un artículo no tiene precio → avisa y **no factura**. Se agregó **CORS** a la función (la app en github.io la llama cross-origin) — ⚠ producción: restringir origen + `verify_jwt=on`. **Por ahora HOMOLOGACIÓN** (el modal lo aclara). **Pendiente de puesta en marcha:** cargar el secret `WEB_SERVICE_KEY` + **re-deployar** la función `arca-wsfe`. Verificado: checkhtml + smoke (funciones nuevas) + render del modal a 900/400px. Bump `v6.51`. **Falta:** regla A-vs-FCE MiPyME (2º paso), certificado de producción, OK del contador.
>
> Nota: **server-side (sin bump) — Facturación electrónica ARCA: HOMOLOGACIÓN probada de punta a punta (2026-07-30)**. Se completó el shopping list de ARCA en el entorno de PRUEBA (§4 de `docs/facturacion-arca.md`) y se probó la Edge Function `arca-wsfe` contra ARCA homologación: **`ta`** (login WSAA firmando con el certificado) → OK; **`ultimo`** (`FECompUltimoAutorizado`, PDV 11) → OK; **`emitir`** (`FECAESolicitar`, Factura B de prueba $121) → **CAE AUTORIZADO** (`resultado='A'`) y logueado en `Comprobantes_ARCA` (`entorno='homo'`). **Config:** **PDV nuevo = 11** (`ARCA_PTO_VTA`), `ARCA_ENV=homo`. **Certificado:** por una limitación de la homologación de AFIP (ata el cert al CUIT de la **persona** que opera), el certificado es del **representante (persona)** con una **autorización `wsfe` cuyo *representado* es la EMPRESA** → el **emisor de las facturas es la empresa** igual (delegación); en producción se puede sacar el cert directo a nombre de la empresa. **Secrets** (`ARCA_CERT/KEY/CUIT/PTO_VTA/ENV/EMITIR`) en **Supabase**, no en el repo. **Falta para producción:** fuente del **importe** (§5, bloqueo #1), **OK del contador**, **certificado de producción** (`ARCA_ENV=prod`) y el **módulo frontend** en Facturación. Detalle completo en `docs/facturacion-arca.md`.
>
> Nota: **v6.50 — Histórico de recepción (registro de mercadería recibida, filtrable por fecha y/o código)**. Pedido del dueño. En el menú de **Recepción de Mercadería** (supervisor, botón **"Carga Recepción Mercadería"** → `openRecepcionMenu` → `renderMenu`, en `recepcion.js`) se agregó un botón **"📜 Histórico de recepción"** (`renderHistorico`). Es **SOLO LECTURA**: no crea nada, consulta el registro que **Virgilio ya genera y mantiene solo** en cada recepción (`opEnviar` graba `Entregas Tallerista Virgilio` / `Entregas Prov AT`). Pantalla: barra de filtros **Desde / Hasta** (`<input type=date>`) + **Código** (texto) + atajos **Hoy / 7 días / Este mes / Todo**, y una **tabla** Fecha · Código · Cajas · Entregó · Remito, ordenada por fecha↓, con resumen "N recepciones · X cajas". **Fuentes:** (1) **`Entregas Tallerista Virgilio`** (principal, ~1056 filas desde 2026-04) — se filtra por la **col `Fecha` (texto YYYY-MM-DD)** para evitar líos de zona horaria, y se ordena `Fecha`↓ + `created_at`↓; código con `ilike %q%`. (2) **`Entregas Prov AT`** (secundaria, ~87 filas, proveedores AT) — su `Dia_mes` es **"DD-MM" SIN año**, así que el filtro de fecha asume el **año en curso** (best-effort; hoy todos los datos son del año actual) y las filas se marcan con un chip **"Prov"** + descripción. Las dos tablas tienen `select_all` para `anon`, así que la sesión anónima de `recepcion.js` puede leerlas sin tocar RLS. Tope de 1000 filas por tabla (avisa "acotá por fecha" si se llega) y muestra hasta 500 (con nota). Todo el CSS scopeado bajo `#rcpRoot`; datos escapados (`escapeHtmlRcp`). **Cache-bust `recepcion.js?v=3.69`** (que también empuja a los dispositivos los cambios de recepcion.js de la otra sesión —`_ocgNorm` idea 3521 + dedup de remito idea 9047— que habían quedado con el cache-bust viejo). Verificado: syntax ESM + checkhtml + smoke + render headless a 390px (sin overflow del body; la tabla scrollea en su wrapper) y 900px. Bump `v6.50`.
>
> Nota: **v6.49 — Popup "🟡 Cajas pedidas" muestra SOLO PENDIENTES + botón "🕓 Historial" por artículo en Stocks**. Dos cosas en la solapa Stocks (commit `f69b36e`, solo `index.html` + `sw.js`). **(A) DETALLE "CAJAS PEDIDAS" SOLO PENDIENTES** (`stkOpenCajasPedidasArt`): ahora **excluye las NP ya facturadas** (fetch a `Facturacion_NP` con `np=in.(...)` sobre las NP de la base y filtra), para que el detalle **acompañe a la columna**, que ya las descontaba desde v6.47. El hint dice "pedido **PENDIENTE**: X cajas en N NP(s) (+Y NP ya facturadas — no se muestran; verlas en 🕓 Historial)"; si TODO está facturado, mensaje que deriva al Historial. Sigue incluyendo NP **sin programar** (por eso puede dar algo más que la columna); tooltip del encabezado de la columna actualizado. Esto ajusta el ⚠ de la nota v6.47(B) sobre el detalle que sumaba todas las NP. **(B) BOTÓN NUEVO "🕓 HISTORIAL"** junto a "📋 Pedidos por estadio" y "🔁 Movimientos de góndola" (funciones nuevas `stkOpenHistorial` / `stkHistBuscar`): se busca un código (acepta variantes de relleno de ceros: consulta `PPP_Base_Pedidos` con `articulo=in.(raw, codCanon, normalizado)`) y muestra, **por NP (cliente)**, el recorrido de sus cajas con **DÍA y HORA**: **🛒 pickeado** (ts del movimiento `picking` de la TANDA en `_stk.movs`) → **🧾 armado** (ts del `separado` de la tanda) → **✅ facturado** (`Facturacion_NP.facturado_at`, por NP) → **🚛 cargado** (evento `CCN` `texto=NP|…`, por `ts_cliente`, desde `CC_REPARTO_DESDE_ISO`). Cada NP lleva un badge de estado: **⏳ pendiente / 🛒 pickeada / 🧾 armada / ✅ FC s/salida / 🚛 cargada**. Incluye **TODO** (pendientes y entregadas) — es el complemento del popup de Cajas pedidas (A). Aclaración: pickeado/armado son **por tanda** (las cajas se mueven por tanda entera); facturado/cargado son **por NP**. Ordenado por NP descendente, tope 800 NPs. Bump `APP_VERSION` + `SW_VERSION` `v6.49`.
>
> Nota: **v6.48 — Stocks: navegación de vuelta al detalle por NP/ubicación desde el popup de movimientos**. Cierra el ⚠ de v6.47: al re-rutear el click de columna a `stkOpenMovsArt`, los detalles "clásicos" (`stkOpenEstadioArt` NP/tanda de Pickeados/A facturar, `stkOpenExcedenteArt` ubicaciones de Excedente) habían quedado sin caller. Ahora `stkMovsArtRender` agrega arriba un botón según el depósito — **"📋 Ver NPs / tandas"** (separar_pedidos / a_facturar) o **"📍 Ver ubicaciones"** (excedente) — y esos popups conservan su "🔁 Ver movimientos": **navegación en ambos sentidos**, ninguna vista quedó muerta. Bump `APP_VERSION` + `SW_VERSION` `v6.48`.
>
> Nota: **v6.47 — Solapa "🧾 FC s/Salida" (facturado sin cargar al camión) + "Cajas Pedidas" neto de facturadas + movimientos en Pickeados/A facturar/Excedente**. Tres cosas en **Stock y Compras** (commit `67ca420`, solo `index.html` + `sw.js`). **(A) SOLAPA NUEVA "🧾 FC s/Salida"** (entre "📦 A Separar" y "🏗 Racks"; view `"fcs"` en `stkTab`/`stkRender`, carga lazy como Capacidad/Racks; funciones nuevas `stkFcsLoad`/`stkBodyFcs`): lista las **NP FACTURADAS** (tick de la operadora en Facturación → fila en `Facturacion_NP` con `facturado_at >= CC_REPARTO_DESDE_ISO`, el corte 2026-06-22 del CC) que **todavía NO se cargaron al camión** (sin evento **`CCN`** de esa NP en `Registros_Produccion_Virgilio`, `texto=NP|TANDA`, mismo corte por `ts_cliente`). Es la mercadería que **ya salió del stock contable** (el tick de facturación drena `a_facturar` con `tipo='facturado'`) pero **sigue física en el depósito**. Las **cajas** por artículo y por NP salen de **`Entregas_Virgilio`** (`cajas_entregadas` = lo realmente armado; agrupa por clave `_ocgNorm` y muestra el **código canónico** vía `codCanon`). Dos tablas + buscador: **por artículo** (código · descripción · cajas FC s/salida · NPs) y **por NP** (NP · tanda · cliente · cajas · fecha facturado). **Se descuenta sola** cuando el operario marca la NP en Carga Camión (manda el `CCN`). **(B) "CAJAS PEDIDAS" NETO DE FACTURADAS:** `ocgDemanda` ahora **excluye del set de NP programadas las presentes en `Facturacion_NP`** — una vez facturada, la NP **deja de ser demanda** (su stock ya salió). Afecta la columna **"Cajas Pedidas"** de la solapa Stocks (v5.48) **y** la demanda del **generador de OCs** (v4.13) — es la **misma función**. Si el fetch de `Facturacion_NP` falla, cae al comportamiento anterior (todas las programadas = peor caso, sobre-cuenta). Tooltips de la columna y del chip "Pedidas" actualizados. ⚠ El **detalle** al tocar el número (`stkOpenCajasPedidasArt`) sigue sumando TODAS las NP de la base (incluidas sin programar y facturadas) → puede dar más que la columna (el tooltip lo aclara) — **ajustado en v6.49**: el detalle ya no muestra las facturadas (sigue incluyendo las sin programar). **(C) MOVIMIENTOS EN PICKEADOS / A FACTURAR / EXCEDENTE:** el detalle de **entradas/salidas + saldo corrido** (`stkOpenMovsArt`, v5.100) que ya tenían góndola, racks y a guardar llega a esos tres depósitos: el **click en la columna** de Stocks ahora abre **directo** `stkOpenMovsArt` (`separar_pedidos`/`a_facturar`/`excedente`), y los popups `stkOpenEstadioArt` (NP/tanda + ubicación, v5.102/v5.103) y `stkOpenExcedenteArt` (ubicaciones, incluido el caso "sin ubicación") suman el botón **"🔁 Ver movimientos (entradas/salidas + saldo)"**. ⚠ Ojo: con ese re-ruteo del click, `stkOpenEstadioArt`/`stkOpenExcedenteArt` quedaron sin punto de entrada en la UI — **resuelto en v6.48** (ver nota siguiente). Bump `APP_VERSION` + `SW_VERSION` `v6.47`.
>
> Nota: **v6.46 — Menú "🪞 PPP Espejo" en Administración (por ahora idéntico a PPP)**. Tarjeta grande nueva en el panel de Administración, al lado de PPP (commit `b2a13a7`, solo `index.html` + `sw.js`). `openPPPEspejo()` por ahora **delega en `openPPP()`** — es el *seam* para que más adelante diverja (ej. mostrar la versión de la PPP generada por Supabase en vez del import del Excel). Bump `APP_VERSION` + `SW_VERSION` `v6.46`.
>
> Nota: **v6.45 — PPP: "Exportar Excel" como botón propio**. El botón de exportación de v6.44 estaba **escondido adentro de la línea de estado** del menú Importar (`pppRenderSupaCounts`); ahora es un **botón full-width propio "⬇ Exportar Excel"** (clase `ppp-imp-toggle`, mismo estilo que sus vecinos), ubicado entre **"⬆ Importar Excel ▾"** y **"🛒 Clientes súper"** (commit `cd16beb`, solo `index.html` + `sw.js`). Sin cambio de lógica: sigue llamando `pppExportExcel`. Bump `APP_VERSION` + `SW_VERSION` `v6.45`.
>
> Nota: **v6.44 — PPP a Excel: botón de descarga en la app + Apps Script `ppp-a-excel.gs` (Supabase → .xlsx en Drive)**. Dos salidas de la PPP a Excel, ambas alimentadas por **dos vistas nuevas de Supabase** (ver § 3): `vista_ppp_programacion_pendiente` (programación MENOS las NP "entregadas" = con `Facturacion_NP.cierre_id` no nulo) y `vista_ppp_pedidos_entregados` (NP facturadas + cerradas, con m³ y cajas reales de `Entregas_Virgilio`). **(A) BOTÓN EN LA APP** (función `pppExportExcel`, config `PPP_XLS_HOJAS` en `index.html`): baja un **.xls multi-hoja** (formato SpreadsheetML/HTML que Excel abre con 2 pestañas: "Programación Diaria" y "Pedidos Entregados"), **en vivo** desde las vistas (foto on-demand, `limit=50000`). En v6.44 quedó dentro de la línea de estado del menú Importar — ⚠ superado por v6.45, que lo saca a botón propio. **(B) APPS SCRIPT `apps-script/ppp-a-excel.gs`** (reemplaza al `ppp-a-sheets.gs`, que **nunca llegó a usarse** y se borró): genera/actualiza un **archivo .xlsx en Google Drive** cada 10 min (disparador por tiempo) — arma una planilla temporal, la exporta a xlsx y hace `Drive.Files.update` sobre el archivo destino (`PPP_XLSX_ID` en Script Properties; requiere el **Advanced Drive Service**; reusa las props `SUPABASE_VIRGILIO_*`). Lo deploya **el dueño** (Google es inaccesible desde el sandbox). Las vistas se crearon en la migración **`vistas_ppp_sheet`** (`security_invoker` + grant select `anon`/`authenticated`; DDL versionado en `sql/ppp_vistas_sheet.sql`), auditadas por auditor-supabase (aprobadas; se agregó el índice **`entregas_virgilio_np_idx`**, migración homónima). ⚠ Git: el commit `283ef20` con este título salió **incompleto** por un error de `git add` (solo trajo la eliminación de `ppp-a-sheets.gs`); el contenido real está en **`c59908c`**. Bump `APP_VERSION` + `SW_VERSION` `v6.44`. ⚠ **2026-07-30: la vía (B) se ELIMINÓ** por decisión del usuario (`ppp-a-excel.gs` borrado del repo, nunca se deployó) — queda **solo el botón de la app** (v6.45) sobre las mismas vistas.
>
> Nota: **v6.43 — Fix "códigos duplicados en el stock" (canonicalización del `cod_art` en `Movimientos_Stock`)**. **Problema:** el mismo artículo entraba a `Movimientos_Stock` con **distinto relleno de ceros** (`0027`/`27`/`027`, `66`/`066`) porque el stock **event-sourced no canonicalizaba el `cod_art` al escribir**; la solapa **Stocks agrupa por `cod_art` crudo** → se veían **filas duplicadas** (saldo partido). **Disparador:** una **carga inicial manual del 27/7** metió ~113 filas al depósito `insumos`, y muchas eran **artículos terminados con el código mal escrito**. Se arregló en 4 capas (⚠ esto es lo canónico; complementa/corrige el enfoque *solo-front* de la nota v6.41, que canonicalizaba display+dedup del módulo OCs pero **no** tocaba lo que se escribía en `Movimientos_Stock`). **(1) TRIGGER CANÓNICO EN LA BASE** (migración `canon_cod_art_trigger`, versionado en `sql/canon_cod_art.sql`): función `fn_canon_cod_art()` + trigger `trg_canon_cod_art` **BEFORE INSERT** en `Movimientos_Stock`. Canonicaliza el `cod_art` **venga de donde venga** (pegado manual, app, cron, TWA): fuente del canónico = **`OC_Maximos`** (lista curada, 1 por clave normalizada; ahí el Colador es `027`, mismo criterio que `codCanon()` del front); **fallback SOLO numéricos** = sin ceros a la izq + `lpad` a **mínimo 3** (nunca trunca: `27`→`027`, `66`→`066`); **alfanuméricos** (`PP`, `FLEJE…`, `ALAMBRE`, `46B`) quedan **intactos**. ⚠ **EXCLUYE `tipo IN ('picking','separado','facturado')`** porque el cron `reconciliar_pipeline_stock` tiene un **índice único parcial `mov_stock_pipeline_dedup`** sobre `(upper(trim(ref)), upper(trim(cod_art)), deposito, tipo)` para esos tipos — tocarles el `cod_art` interferiría con esa dedup. Auditado por auditor-supabase (aprobado). Se **revocó el EXECUTE** de la función (migración `canon_cod_art_revoke_execute`) para dejar los advisors 0028/0029 en verde — el trigger sigue corriendo con privilegios del owner. **(2) SEGURIDAD / GRANTS** (migración `revoke_anon_peligrosos_stock_ocmax`, versionado en `sql/seguridad_grants_stock.sql`): se revocó **TRUNCATE/DELETE/UPDATE/REFERENCES** de `anon`+`authenticated` en `Movimientos_Stock`, y **TRUNCATE/DELETE/UPDATE/INSERT/REFERENCES** de `anon` en `OC_Maximos`. Motivo: **TRUNCATE no respeta RLS** y con la anon key (pública en el JS del cliente) alguien podía **vaciar el stock**. Se **mantiene** lo que la app usa: `anon` **INSERT+SELECT** en `Movimientos_Stock` (`stockMove`) y `anon` **SELECT** en `OC_Maximos`. **(3) APP v6.43** (`index.html`, `stockGuardarInicial`): antes de guardar la carga inicial, **canonicaliza el código client-side** y avisa por `confirm()`: códigos que **se corrigen**, **repetidos** (se **suman**), y **artículos terminados que van a `insumos`** (el error del 27/7). Bump `APP_VERSION` + `SW_VERSION` `v6.43`. **(4) LIMPIEZA DE DATOS:** se **borraron 13 filas** de artículos terminados mal cargados como insumos el 27/7 (Colador, Abrelatas, Filtro, Bowl, Pinza, Afila, Destapa) = **5.172 cajas fantasma**; con eso **desaparecieron los duplicados** (cada código quedó con su única variante canónica). **TODO (pendiente):** **Capa 1b** — cubrir `picking`/`separado`/`facturado` + **consolidar el split del código `66`**, coordinado con el cron `reconciliar_pipeline_stock` (por el índice de dedup); y **purga opcional** del resto de numéricos del batch del 27/7.
>
> Nota: **v6.41 — Módulo OCs: código canónico (027) + Imprimir OC + Trazabilidad punta a punta**. Tres cosas en el módulo **📑 Órdenes de Compra** (`openOCAdmin`). **(A) CÓDIGO CANÓNICO.** En las hojas fuente un mismo artículo aparece con **distinto relleno de ceros** (ej. el Colador N°10 = `27` / `027` / `0027`). Todos ya normalizaban a la misma clave con `_ocgNorm` (upper+trim+**saca ceros a la izquierda**), pero al **MOSTRARLOS** se veían mezclados. Helper nuevo **`codCanon(cod)`** que colapsa las variantes al **código curado de `OC_Maximos`** (ahí el Colador es `027`): `loadCodCanon()` arma el mapa `clave normalizada → código canónico` desde `OC_Maximos` (`cod`, `activo=true`; si hay varias variantes por clave prefiere la que trae ceros a la izquierda / la más larga), se carga en el `Promise.all` de `openOCAdmin` (`_codCanon`). **Fallback** si el artículo no está en `OC_Maximos` (`_padCod`): dígitos puros → **pad a 3** (`27`→`027`); alfanuméricos → tal cual (upper+trim). Aplicado en **display y dedup** de todo el módulo: generador (`ocBodyGen` display **y lo que escribe en `Ordenes_Compra`** vía `ocgGenerar`), **% Entregas** (`ocBodyEntregas` ahora **agrupa por clave `_ocgNorm`**, antes agrupaba por el código crudo y separaba `27` de `027` como dos artículos), detalle (`ocBodyDetail`), y la **carga manual** (`ocNuevaCrear`) **canonicaliza el código al guardar**. Estado real: `OC_Maximos` está **limpio** (315 códigos activos, clave normalizada única, sin choques) y `Ordenes_Compra` hoy **no tiene variantes** → los fantasmas `27`/`0027` viven **solo en la hoja de Google** (no accesible del sandbox), así que el fix es **correctivo + preventivo**. **(B) IMPRIMIR OC.** Botón **"🖨 Imprimir OC"** en el detalle de una OC → abre una **hoja print-friendly por proveedor** (encabezado "Orden de Compra / Producción Virgilio", proveedor, fecha, rubro, tabla de ítems con **código canónico + descripción + unidad + cantidad**, total, y pie con **líneas de firma** proveedor/responsable). Reusa el patrón `window.open`+`document.write`+auto-print de `pppPrintSug`. Funciones nuevas: `ocPrintDetalle`, `ocPrintHtml`, const `_OC_PRINT_CSS`. **(C) TRAZABILIDAD PUNTA A PUNTA.** Vista nueva **"🔎 Trazar artículo"** (botón en la lista de OC, `_oc.view==='trazar'`). Por artículo (buscando por **código o descripción**) cruza **por código canónico**: **① Config** (`OC_Maximos`: máximo objetivo, proveedor, índice, uni/caja) → **② Órdenes** (`Ordenes_Compra`: cada línea con fecha, proveedor, pedido, recibido, falta, estado) → **③ Totales** (pedido, recibido, **% de entrega**, falta). Deja seguir un ítem desde la config hasta la recepción en una sola pantalla. Funciones nuevas: `ocTrazar`, `ocBodyTrazar` (view `"trazar"` sumada al switch de `ocRender`; usa `ocgFetchMaximos` para `_oc.max`). Bump `v6.41` (`APP_VERSION` + `SW_VERSION` `v6.41-vir`).
>
> Nota: **v6.40 — Remito: tope al auto-ajuste de la letra (la hoja de prueba salía GIGANTE)**. El dueño imprimió la **"hoja de prueba"** (`psTestPrint`) y las letras salieron **absurdamente grandes** ("NP PRUEBA"/"ARMADO" ocupaban media hoja). Causa: el auto-ajuste de `remitoPrintDoc` **agranda** la fuente hasta **llenar** la A4 (1010px de alto útil); con **poquísimo contenido** (2 líos) tenía que subir a **34px de font root** para llenar → letras gigantes (NP a 2.1em = **71px**). Fix: se le puso **TOPE de 16px** al font root del auto-ajuste (`hi = 34 → 16` en el binary-search). Ahora: un remito **liviano** (o la hoja de prueba) queda en **16px** (NP ≈ 34px, "grande pero normal", con blanco abajo — está bien que una hoja casi vacía no se llene), y un remito **con contenido real** sigue **llenando la hoja** bajando la fuente hasta 11px si hace falta (ej. 10 líos → 15px, llena hasta abajo; 24 líos ya son 2 páginas, como corresponde). **Solo afecta el máximo**, no el mínimo → los remitos cargados salen igual que antes. Verificado headless (render de hoja de prueba = NP 34px no 71px; remito de 10 líos llena 1010px) + checkhtml + smoke. Bump `v6.40`.
>
> Nota: **v6.39 — Mini-UI barrio→zona (asignar guarda en Supabase, no solo local) + limpieza del diagnóstico temporal**. **(A)** El desplegable **"⚠ asignar…"** de la PPP (`pppZonaCell`, para barrios sin zona) guardaba el barrio→zona **solo en un override LOCAL** (localStorage de esa compu) → no lo veían los demás ni el ruteo/sugeridor. Ahora `pppAsignarZona` **persiste al diccionario COMPARTIDO** (`Zonas_Barrios`) vía RPC nuevo **`zona_barrio_set(p_barrio,p_zona)`** (`SECURITY DEFINER`, normaliza con `_norm_barrio`, `upsert` con `on conflict do update`; grant a `anon`/`authenticated`, mismo patrón que los `racks_plani_*` porque la anon key no puede escribir la tabla directo). Mantiene el override local + `_pppZonaSupa` en memoria para feedback instantáneo, y avisa si el guardado remoto falla. Así, un barrio nuevo cargado a mano queda para todos y alimenta autozona. **(B)** Se quitó el diagnóstico temporal **"(cuenta detectada: …)"** del cartel de bloqueo de facturación (estaba desde v6.23 para verificar el fix de la operadora; ya confirmado). Smoke verde. Bump `v6.39`.
>
> Nota: **v6.38 — Auto-imprimir el remito FACTURADO al tildar Facturación** (pedido del dueño). Hasta acá el remito **FACTURADO** (variante de `armadoRemitoInnerHtml` con el recuadro "Controlado / Legajo") estaba codeado pero **sin ningún disparador**. Ahora, al tildar una NP en Facturación (`facTickNP`, tras marcarla facturada y drenar el stock), se imprime **solo** el remito FACTURADO de esa NP. Funciones nuevas: `facPrintFacturado(np,tanda)` (trae el `resumen` del **TAL** de la NP + PPP + faltantes + picker/armador y llama `remitoPrintDoc(armadoRemitoInnerHtml(d,"FACTURADO"))`) y `facMaybePrintFacturado` (gate). **Por dispositivo** (localStorage `fac_print_facturado_virgilio`), igual que la estación de armado: **solo la PC de la operadora imprime**, los celulares no. **Se auto-configura en el 1er tic**: pregunta UNA vez ("¿imprimir el FACTURADO en esta PC?") y guarda la respuesta; la 1ª impresión abre el diálogo del navegador para **elegir la impresora** (Chrome la recuerda; con `--kiosk-printing` + impresora predeterminada sale sin diálogo). También hay un **toggle** en la pantalla **Cola de impresión** (🧾 "Auto-imprimir remito FACTURADO al tildar Facturación") para prender/apagar sin depender del prompt. Si la NP no tiene armado (sin TAL) → no imprime y avisa por toast. ⚠ **Solo imprime al TICKEAR** (no al revertir); una NP sin TAL (facturada sin pasar por armado) no genera hoja. Smoke verde (`fac-block-recuperable`). Bump `v6.38`.
>
> Nota (backend, sin bump de app): **PPP autozona ahora APRENDE el barrio nuevo (auto-mantenimiento) + Telegram si falta**. Complemento de v6.37 (pedido del dueño: *"debería ser automático o tirar por Telegram"*). Antes, un barrio NUEVO con zona **cargada en el Excel** no disparaba nada (no estaba "sin zona") y nadie lo aprendía → quedaba el desajuste. Ahora el trigger `ppp_autozona` (`sql/autozona.sql`, migración `ppp_autozona_aprende_barrio_nuevo`) hace DOS cosas: **(1) COMPLETAR** (como siempre): pedido sin zona + barrio conocido → deriva del diccionario; **(2) APRENDER** (nuevo): pedido **con zona geográfica** (`'Zona %'`) + barrio **no mapeado** → lo **inserta en `Zonas_Barrios`** (`ON CONFLICT DO NOTHING`, el 1º gana) → de ahí en más deriva solo, nunca más "sin zona" para ese barrio. **NO** aprende `Super/Retira/Expo` (tipo de cliente, no barrio). Si el Excel viene **sin zona** y el barrio es desconocido → no hay nada que aprender → queda sin zona → **la alerta `ppp_sin_zona` ya existente** (`sql/ppp_sin_zona.sql`, cron jobid 14 c/2h) avisa por **Telegram** (con dedup). Verificado end-to-end: aprende geo, ignora Super, y un pedido posterior del mismo barrio sin zona se autocompleta (test creado y limpiado). Backend puro → **sin bump de app**.
>
> Nota: **v6.37 — PPP "Sin tanda — por zona": la zona sale de Supabase (`Zonas_Barrios`), NO del Excel**. Ajuste sobre v6.36 (pedido del dueño: *"que la zona la tome sola en función de Supabase, no del Excel"*). v6.36 había hecho que el agrupador cayera a la **columna ZONA del Excel** cuando el barrio no resolvía — pero la fuente de verdad debe ser el **diccionario barrio→zona de Supabase** (`Zonas_Barrios`, el mismo que lee `pppZonaDeBarrio` y que llena el trigger `ppp_autozona` cuando la fila entra con zona vacía). El problema real era que ese **diccionario estaba incompleto**. **Fix (data):** se **completó `Zonas_Barrios`** con TODOS los barrios geográficos que aparecían en la PPP con zona cargada y consistente (un solo `zona` por barrio) — 26 altas en total (incluye `v.devoto`/`villa devoto`/`devoto`→Z2 y `villa bosch`/`v.bosch`→Z5 de v6.36, más `villa luro`,`avellaneda`,`vicente lopez`,`once`,`flores`,`villa lugano`,`gregorio de laferrere`,`p.patricios`,`rafael calzada`,`san cristobal`,`san martin`,`temperley`,`tigre`,`v.alsina`,`villa ballester`,`villa pueyrredon`,`ciudadela`,`f.varela`,`guernica`,`munro`,`olivos`,`pilar`,`quilmes`,`quilmes oeste`). Verificado: **0 barrios geográficos** de la PPP quedan sin diccionario. **Fix (código):** el agrupador vuelve a derivar la zona **de Supabase** (`pppZonaDeBarrio(localidad)`); la columna ZONA del Excel queda como respaldo **solo para Super/Retira/Expo** (`_PPP_ZONA_EXENTA`), que son **tipo de cliente** y no se pueden derivar del barrio. ⚠ De ahora en más, un barrio **nuevo desconocido** cae en "sin zona" hasta cargarlo en `Zonas_Barrios` (no hay UI aún para eso desde la app; el `⚠ asignar…` de la fila guarda un override LOCAL, no Supabase). Solo front + data (`index.html`, ~L16972). Smoke verde. Bump `v6.37`.
>
> Nota: **v6.36 — PPP "Sin tanda — por zona": agrupar por la columna ZONA del Excel cuando el barrio es desconocido** (SUPERSEDIDA por v6.37: se cambió el enfoque a diccionario de Supabase). En la Programación, el bloque **"Sin tanda — por zona"** tiraba pedidos a **"— sin zona —"** aunque la **columna ZONA de la tabla los mostraba con zona**. Causa: el **agrupador** (`pppRenderProg`) derivaba la zona **solo del barrio** (`pppZonaDeBarrio(localidad)` → mapa override/Supabase `Zonas_Barrios`/hardcodeado), **ignorando la columna `zona`** que trae el Excel; en cambio la **celda ZONA** de la tabla ya usaba `p.zona || pppZonaDeBarrio(...)`, y el **panel de errores** ya marcaba sin-zona **solo si NI barrio NI columna** la resuelven. O sea el agrupador era el único que no miraba la columna → inconsistente. Se vio con **NP 98213/98214 (V.Devoto → Zona 2)** y **98241 (Villa Bosch → Zona 5)**: barrios que la app no conocía, pero con la zona bien cargada en el Excel. **Fix (1 línea)**: el agrupador ahora usa `pppZonaDeBarrio(localidad) || _pppS(p.zona) || "— sin zona —"` (mismo criterio que el panel de errores). **Además** se cargaron esos barrios en `Zonas_Barrios` (con variantes: `v.devoto`/`villa devoto`/`devoto` → Zona 2 · `villa bosch`/`v.bosch` → Zona 5) para que el **ruteo y el sugeridor** (que sí derivan del barrio) también los conozcan. Solo front + data (`index.html`, ~L16968). Smoke verde. Bump `v6.36`.
>
> Nota (backend Supabase, sin bump de app): **Ratio de guardado — el auto-medido salía INFLADO, filtro de cordura + vuelta a valor fijo**. El recálculo (v6.30) reemplazó la semilla 380 por **871 cajas/h**, pero era falso: el operario **acomoda las cajas primero y recién al final abre el MG y confirma en segundos** → la instrumentación (modal-open→confirm) mide solo el tiempo de carga de datos, no el guardado real (ej. registrado: **420 cajas en 49 s** = 30.857 cajas/h, imposible). Con 4 sesiones, dos absurdas (420/49s, 283/4.8min) arrastraron el promedio. Fix: `guardado_recalc_ratio` ahora **descarta sesiones con ritmo implausible** (deja solo **20..500 cajas/h**) y exige **≥1500 cajas limpias** antes de pisar el valor; si no, queda el **valor fijo** (`Stock_Config.guardado_cajas_por_hora`, editable a mano). Se reseteó a **380**. ⚠ En la práctica, mientras registren al final, el auto-medido casi nunca va a juntar datos limpios → conviene **fijar el ratio a mano** con el número real (cronometrar un guardado con el modal abierto, o de experiencia). Hoy: ~4,5 h pendientes (1720 cajas ÷ 380).
>
> Nota: **v6.35 — Monitor TV: reload PREVENTIVO por memoria (crash "Aw Snap")**. El box de la TV (MX9, barato) se queda sin RAM y **Chrome mata la pestaña** ("¡Vaya!"/Aw-Snap); ahí el **JS de la página ya está muerto**, así que el reload interno no puede recuperarla (queda en la pantalla de error hasta que alguien recarga a mano). El reload fijo de 10' (v5.94) a veces **no se adelanta** al crash. Ahora (kiosko, `?monitor=`) el timer **chequea cada 1 minuto** y recarga **ANTES de llenarse**: si el heap JS supera **~65% del límite** (`performance.memory`, Chrome) o pasaron **7 min** desde la carga (piso, y fallback si el box no expone `performance.memory`). Reset limpio de 1-2s. ⚠ **Es una mitigación, no una cura**: una vez que el navegador crashea, desde la web no se puede auto-recuperar. La solución robusta es **del lado del aparato**: un **navegador kiosko** (ej. *Fully Kiosk Browser* para Android TV) que recargue solo al crashear + limpie memoria, o un box con más RAM.
>
> Nota: **v6.34 — Ubicaciones de armado (TAP): renumeradas 3/4/9/10 → 1/2/7/8**. Pedido del dueño. En el modal `askArmadoUbicaciones` (al mandar **TAP**, el armador elige en qué ubicación queda cada NP; evento **AUB**, v5.86), `ARM_UBIC_OPCIONES` pasó de **AB10/AB9/AB4/AB3 · AA10/AA9/AA4/AA3 · AC3/AC4/AC9/AC10 · AD3/AD4/AD9/AD10** a **AB8/AB7/AB2/AB1 · AA8/AA7/AA2/AA1 · AC1/AC2/AC7/AC8 · AD1/AD2/AD7/AD8** (para cada prefijo AA/AB/AC/AD: **3→1, 4→2, 9→7, 10→8**). Solo la lista de opciones; el flujo (AUB, wizard) no cambia. Smoke verde.
>
> Nota: **v6.33 — Consulta NP/Líos: marcar los artículos que salieron de "a guardar"**. Pedido del dueño: en la composición a líos (`npcRenderList`), saber de un vistazo si un artículo se completó desde **a_guardar** (un faltante que llegó y se cargó por **CP**). Se agregó a `npcLoad` un fetch de los eventos **`CP`** (texto = `NP|COD|QTY|GONDOLA\|AGUARDAR|LÍO`; **campo 3 = origen**) → mapa `aguardarByNp = {NP:{COD:cajas}}` con solo los de origen **AGUARDAR**; cada fila lleva `aguardar`. En el render, esos ítems se pintan con **📥 + estilo violeta** (`.npc-item.ag`, distinto del rojo de faltante `.f`) + tooltip "Salió de «a guardar»". Ej.: NP 98119 completó **546×1** desde a_guardar → sale marcado. Solo lectura (no cambia el CP). Verificado con render mock + checkhtml + smoke.
>
> Nota: **v6.32 — Stock: siglas de picker/separador en "Cajas pedidas" + movimientos de góndola sin scroll lateral + NP en cada picking**. Dos pedidos del dueño. **(A) "Cajas pedidas"** (`stkOpenCajasPedidasArt`): por cada NP que se **pickeó/separó** ahora se muestran las **siglas** del que pickeó (evento **TP** de la tanda) y del que separó/armó (evento **TAP**), con el mismo formato del monitor (`initialsFromName` + `_empleadosNombres`, chip verde/azul). Se fetchean TP/TAP por tanda + `getEmpleadosNombres`. **(B) Movimientos por rubro** (`_stkMovsBlock`, góndola/a guardar/racks): la tabla `.mva-tbl` era **más ancha que la pantalla** (había que scrollear al costado para ver Entró/Salió/Saldo). Ahora **entra al 100%** (`table-layout:fixed`, columnas 33/37/15/15%): se **combinó Entró+Salió en una sola columna "Cant."** (+ verde / − rojo) y **Fecha/Movimiento se acomodan** (wrap); `overflow-x:hidden`. Además, en las filas de **picking/separado** (ref = tanda) se muestra el/los **NP** que pidieron ese artículo en esa tanda (chip `NP …`): `stkOpenMovsArt` es ahora async y trae `npByTanda` (de `PPP_Base_Pedidos` + `PPP_Programacion_Diaria`) y re-renderiza. Verificado: tabla a 360px sin scroll lateral (render mock) + checkhtml + smoke.
>
> Nota: **v6.31 — Remito rediseñado (ARMADO/FACTURADO) con nombres + faltantes + auto-ajuste**. Pedido del dueño (formato en PDF, aprobado). Se reescribió el remito (`armadoRemitoInnerHtml(d, tipo)` + CSS em-based): encabezado **NP · Fecha Entrega**, **Cliente** (cod - razón social), **Tanda** (- cajas - líos), la **palabra grande** (`ARMADO` o `FACTURADO`), y **Picking / Armado** (nombres). Cuerpo en **dos columnas**: izquierda **Artículos** (Cod·Cajas·Lío) + **Total** + **Faltantes** (Cod·Cajas); derecha **Líos** (Lío·Composición). `FACTURADO` suma arriba a la derecha el recuadro **"Legajo / Controlado: ___"** (se completa a mano). **Auto-ajuste:** `remitoPrintDoc` mide en un iframe con ancho real de A4 (703px) y sube el font-size hasta **llenar la hoja** (1 página siempre). **Datos nuevos:** `armadoRemitoData` resuelve `pickName/armName` (de `pickerLeg/armadorLeg` vía `npcNombre`) y `faltantes` (de `row.falt.items` o `row.faltantes`). **Manual** (Consultar NP/Líos): la fila de `_npcRows` ya trae picker/armador/faltantes → sale directo. **Auto-print al TAP** (Estación de Impresión): `psPoll` agrega `legajo` al TAL (armador) y `psPrintBatch` trae faltantes (`Entregas_Virgilio`), picker (evento `TP` por tanda) y nombres (`getEmpleadosNombres`) → imprime **una hoja ARMADO por cada NP** de la tanda al terminar el armado. **FACTURADO:** la función está lista (`armadoRemitoInnerHtml(d,"FACTURADO")`); **falta engancharla al tick de Facturación** (`facTickNP`) — se coordina con la otra sesión que trabaja ahí (opción A). Verificado con render A4 real (ARMADO+FACTURADO, 1 página, nombres/faltantes/Controlado OK) + checkhtml + smoke.
>
> Nota: **v6.30 — Ratio de guardado (cajas/hora) + "horas de guardado pendientes" en Stock y Compras + alerta Cervantes**. Pedido del dueño. **El problema de datos:** los movimientos guardan CUÁNTO se guardó (~20k cajas) pero no CUÁNTO tiempo llevó (el operario acomoda un batch y toca "confirmar" una vez), así que el ratio no se puede sacar bien del histórico (el mismo operario da 66 o 1140 cajas/h según el día). **Solución:** (1) **semilla** = 380 cajas/h (estimada de los intervalos "activos" del histórico, tope 45'); (2) **instrumentación**: cada MG registra `(cajas, segundos)` reales de la sesión (desde que abre el modal hasta confirmar) en la tabla nueva **`Guardado_Sesiones`** (RLS anon insert+select) vía `emitGuardadoSesion`; (3) el cron **`guardado-recalc-ratio`** (diario) reemplaza la semilla por el ratio **medido** cuando hay ≥500 cajas medidas (`guardado_recalc_ratio`, filtra sesiones 30s..2h). El ratio vive en `Stock_Config.guardado_cajas_por_hora`. **En Stock y Compras:** tarjeta **"⏱ Horas de guardado pendientes"** = backlog (saldo `a_guardar` [+ `racks` si el switch está ON]) ÷ ratio, con color (verde/ámbar/rojo) y el aviso ">6h → pedir a Cervantes". **Switch "Incluir racks"** (`Stock_Config.guardado_incluir_racks`, **default OFF** porque todavía no confían en el stock de góndola). **Alerta Telegram:** cron **`guardado-alerta-cervantes`** (`*/30 11-21` AR) → si (backlog/ratio) > **6 h** manda *"solicitar personal a Cervantes para guardado de mercadería"* (dedup mañana/tarde). Funciones DB: `guardado_recalc_ratio`, `guardado_backlog_cajas`, `guardado_alerta_cervantes`. Front: `emitGuardadoSesion` + `stkGRate/stkGRacksOn/stkGuardadoToggleRacks/stkGConfVal` + la tarjeta en `stkBodyStocks`. Hoy: **~3.8 h** pendientes (1445 cajas). ⚠ El ratio medido depende de que tengan el modal MG abierto mientras guardan; si no, se queda en la semilla (razonable). Smoke verde.
>
> Nota: **v6.29 — El detalle de "A facturar" (por NP/tanda) muestra SOLO lo pendiente**. Al abrir el popup de un artículo en **A facturar** (`stkOpenEstadioArt`), el detalle por tanda mostraba de más: sumaba las cajas `separado(+)` pero **no descontaba lo ya facturado** cuando el facturado venía del cliente (`ref=tanda|NP`) o de un ajuste de reconciliación (`ref=NP`). Ej.: el 530 decía **4 cajas en 3 grupos** (C89A 2 · C98C 1 · C99I 1) cuando el saldo real era **1** (solo C99I sigue pendiente; C89A/C98C ya se facturaron). Causa: agrupaba por `ref` **crudo**, así el `separado` con `ref=tanda` y el `facturado` con `ref=tanda|NP` caían en grupos distintos y no se netaban. Fix (una línea): la clave de agrupación toma la **tanda/NP base** (`ref.split("|")[0]`) → el neto por tanda descuenta separados, facturados del cliente y ajustes, y solo se listan las tandas con neto > 0. Ahora el detalle **coincide con el saldo**. Seguro para `separar_pedidos` (sus refs no llevan `|`). Solo front (`index.html`, ~L9825). Smoke verde. Bump `v6.29`.
>
> Nota (backend, sin bump de app): **FIX DOBLE-FACTURADO del pipeline → `a_facturar` NEGATIVO (restaba stock del total)**. Varios códigos (530/531/520…) mostraban `a_facturar` en negativo → el total de stock salía sub-contado. Causa: la **ETAPA 3** de `reconciliar_pipeline_stock` (cron jobid 22, cada 10') drenaba `a_facturar` agrupando por `ref` crudo y solo deduplicaba contra `facturado ref=tanda`; pero el **cliente** factura por NP con `ref=tanda|NP`, que el cron **no veía** → volvía a facturar (`ref=tanda`) → **doble facturado** → saldo negativo. Alcance: **137 códigos / 364 tandas / 1.417 cajas**, 100% de este pipeline (ni una caja era error real de operación). **Prevención** (migración `pipeline_etapa3_facturado_por_tanda_evita_doble`): la ETAPA 3 ahora calcula neto y dedup **por tanda** (normaliza `ref=tanda|NP` con `split_part`), drenando solo el remanente real (si el cliente ya lo sacó, `net<=0` y no hace nada) — verificado `etapa3=0` post-fix. **Limpieza**: los 1.417 ya colgados se compensaron con 364 ajustes trazables (`tipo='ajuste'`, `legajo='reconcilia'`, uno por tanda → cada `a_facturar`-por-tanda a 0). Post: **0 códigos con a_facturar negativo**. Doc en `sql/reconciliar_pipeline_stock.sql`.
>
> Nota (backend, sin bump de app): **Aviso de faltante completable: "LLEGÓ" vs "ESTÁ A GUARDAR"**. El aviso Telegram de `detectar_faltantes_llegaron` (`sql/detectar_faltantes_llegaron.sql`) decía siempre **"FALTANTE QUE LLEGÓ"**, aunque el stock estuviera hace días en `a_guardar` (confundía: no siempre "llegó recién"). Ahora distingue según **cuándo llegó el stock respecto del armado** (`Entregas_Virgilio.creado`): si hubo una **recepción POSTERIOR al armado** → **"FALTANTE QUE LLEGÓ"** (ingresó en el día, después de armar); si el stock **ya estaba** a guardar antes de armar → **"FALTANTE QUE ESTÁ A GUARDAR"** (pendiente de subir a góndola, por eso no lo tomaron al pickear). Flag `arrived_after` por código (recepción con `ts > creado`), agregado por NP como `es_llego`. Verificado con NP 98199/546 (recepción 27/07 16:43 < armado 28/07 10:38 → "está a guardar"). Migración `faltante_llego_vs_esta_a_guardar`.
>
> Nota: **v6.28 — Ingreso a racks: IMPORTACIÓN vs NACIONAL (mover stock existente a racks)**. El módulo **Ingreso a racks (IR)** ahora arranca con un toggle **📦 Importación** (lógica de siempre: stock NUEVO que llega → RPC `racks_plani_ingreso`, crea `ingreso` en racks) / **🏠 Nacional**. En **Nacional** la mercadería YA está en stock: se elige **origen** (`a guardar` o `excedente`), **código** (buscador que lista SOLO los que tienen stock en ese depósito, con cuántas cajas hay), **cajas** (tope = disponible) y **sector**. Al confirmar NO crea stock nuevo: **traslada** (origen − , racks +, tipo `traslado`) y ocupa/suma la celda, vía RPC nueva **`racks_plani_ingreso_nacional`** (`sql/racks_plani_ingreso_nacional.sql`) que **valida el stock disponible** (respeta el cutoff) → nunca deja el origen en negativo; devuelve `sin_stock:N` si no alcanza. La **operadora** tiene el mismo flujo desde **Stock y Compras → Racks** ("🏠 Ingresar nacional a racks"). El evento IR marca el nacional con `|NAC:<origen>` en el `texto`. Verificado end-to-end (traslado 5 cj 501 a_guardar→racks, balanceado, y guardas sin_stock/ocupado/origen inválido) + smoke verde. Bump `v6.28`.
>
> Nota: **v6.27 — Fix de raíz: el `facturado` ahora descuenta las cajas de COMPLETAR PEDIDO (CP)**. Bug recurrente (546/280/221/323E): al facturar una NP, sus cajas agregadas por **CP quedaban colgadas en `a_facturar`** y había que limpiarlas a mano. Causa: el CP marca sus filas con **`ref = NP`** (solo el número), pero el drenaje del facturado (`stockSalidaFacturadoNP` + barrido) busca por **`ref = tanda` / `tanda|NP`** → nunca las veía. Fix: helper nuevo **`stockDrenarCPFacturado(np)`** que saca de `a_facturar` las cajas `tipo='cp' ref=NP` de la NP, con un `facturado -neto` por código y **`ref = NP|CP`**. Idempotente e incremental (drena `pendiente = CP − ya_drenado`; **NO hay unique** en `Movimientos_Stock`, el dedup es en cliente). Se llama en DOS lados: (1) al **tildar Facturación** (`facTickNP`, tras `stockSalidaFacturadoNP`) → CP hecho ANTES de facturar; (2) en **`cpConfirm`**, si la NP **ya estaba facturada** (chequea `Facturacion_NP`) → CP hecho DESPUÉS de facturar (caso real visto: NP 97976 facturada 17:05, CP 17:10). `stockMove` en `cpConfirm` pasó a `await`. Smoke verde (cp-focus, fac-block-recuperable). Bump `v6.27`. ⚠ Las que ya estaban colgadas se limpiaron a mano (ajustes `reconcilia`); de acá en más se drenan solas.
>
> Nota: **v6.26 — El Monitor muestra el TOTAL de tandas programadas**. El encabezado del Monitor mostraba solo el conteo de la **ventana de fechas** visible (`N entrega <fechas> · X en curso · Y a FC`) — no el total global. Ahora antepone **`N programadas (total)`** = todas las tandas con **Op=SI** en `PPP_Programacion_Diaria` (cualquier fecha, contadas desde `sheetMap` en `renderMonitor`). El "46" de la ventana no era el total (dejaba afuera las programadas para fechas fuera de la ventana). Bump `v6.26`.
>
> Nota (backend, sin bump de app): **Aviso "📦 RACK LIBRE" reescrito (era confuso)**. Decía *"se bajó lo último de 566E … Ese artículo todavía está en X28"* → sonaba contradictorio (¿se terminó o queda?). Ahora aclara que se vació **esa posición**, no el artículo: *"La posición AA02 quedó VACÍA: se bajó TODO el 566E … que había EN ESA POSICIÓN. Quedó LIBRE para otro palet."* + línea aparte: *"✅ El 566E TODAVÍA tiene stock en rack: X28 (64 cj)."* (o *"⚠ El 566E ya NO queda en ninguna otra posición de rack."*). Función `racks_plani_descontar` (`sql/racks_plani_viva.sql`), migración `rack_libre_mensaje_mas_claro`.
>
> Nota: **v6.25 — La solapa Insumos muestra Medida y Sector**. La tabla "📦 Insumos" (en Stock y Compras → Stocks) pasó de `Código · Descripción · Stock` a `Código · Descripción · Stock · **Medida** · **Sector**`. Los valores salen del movimiento **más reciente con dato** de cada insumo: `stockComputeSaldos` ahora captura `_uni` (de `unidad`) y `_ubi` (de `ubicacion`) — los movs vienen `ts.desc`, así que el primer valor no vacío es el más nuevo. Completa lo de v6.24 (que ya cargaba esos campos). Bump `v6.25`.
>
> Nota: **v6.24 — Stock inicial de INSUMOS con 5 campos (cod / descripción / cantidad / medida / sector)**. En Stock y Compras → **Ajustes** → "Stock inicial", cuando el **Depósito = Insumos** la caja acepta una línea por insumo con `CÓDIGO ; DESCRIPCIÓN ; CANTIDAD ; MEDIDA ; SECTOR` (separá con `;` **o** pegá 5 columnas de Excel = TAB). **Código** y **cantidad** obligatorios; descripción/medida/sector opcionales. Mapean a columnas ya existentes de `Movimientos_Stock`: `descripcion`, `unidad` (medida), `ubicacion` (sector). Cae al formato clásico `CÓDIGO CANTIDAD` si la línea no trae separador, y los demás depósitos siguen igual. El instructivo + placeholder cambian solos según el depósito (`stkIniHintUpdate`, `onchange` del selector). Pendiente/ofrecido: mostrar descripción/medida/sector en la solapa Insumos. Bump `v6.24`.
>
> Nota: **v6.23 — Fix: la OPERADORA quedaba bloqueada para "facturar corto" (override no aparecía)**. La operadora, logueada como supervisor con su mail (`loekemeyer.n8n@gmail.com`), veía el **bloqueo** duro (solo "Aceptar") en vez del **confirm** para forzar la facturación de una NP con faltante recuperable. Causa: `_facEsOperadora()` dependía **solo** de `__identity.email`, y si algo repisaba `__identity` después del render (dejándolo sin `email`) el chequeo daba `false`. Fix: (1) en `showLoggedIn` se guarda el mail autenticado en un global **estable** `window.__authEmail` (se limpia en `showLoggedOut`); (2) `_facEsOperadora()` ahora toma `__identity.email` **o** `__identity.nombre` (en supervisor ambos SON el mail) **o** `window.__authEmail` de respaldo. Se agregó un diagnóstico temporal en el cartel de bloqueo ("cuenta detectada: …") para confirmar el valor en runtime — **quitar** una vez validado. Smoke `fac-block-recuperable` sigue verde (bloqueo/override/normal). Bump `v6.23`.
>
> Nota: **v6.22 — `pipeline_atascado` del tablero de Agentes: mismo criterio que la alerta (última actividad + días hábiles)**. El bloque 16 de `generar_reporte_agentes` (`sql/generar_reporte_agentes_v2.sql`) medía la antigüedad de lo pickeado (`separar_pedidos`/`a_facturar`) desde **la caja más vieja que entró** (`min(ts) filter delta>0`) en **días corridos** → marcaba "hace 27–28 días" a **códigos de alta rotación** que en realidad se pickean y separan **todos los días** (la "caja más vieja" es del arranque del sistema, pero el saldo churnea a diario). Eran falsos positivos (ej. 26/07 mostraba "20 · hace 28 días"). Ahora mide por **última actividad** (`max(ts)`) y en **días hábiles** (lun–vie, sáb/dom no cuentan), con umbral `Stock_Config.dias_estancado` (default 2) — **idéntico** a la alerta Telegram "STOCK ESTANCADO". Verificado: post-cambio da **0** hoy (lunes; lo del viernes va 1 día hábil, salta el martes si sigue quieto). Se actualizó el rótulo del tablero (`index.html` → "Pipeline atascado (+2 días hábiles)"). Bump `v6.22` (APP_VERSION + SW_VERSION) por tocar `index.html`.
>
> Nota (backend Supabase, sin bump de app) — ⚠ **SUPERADA por la nota "ESTANCADO — definición FINAL del dueño" (31/07, arriba): el criterio (1) ahora se mide por CICLO ABIERTO, no sobre el histórico del código**: **"👀 STOCK ESTANCADO" — redefinido el concepto (errores reales, no "cantidad hace X días") + días HÁBILES**. Pedido del dueño: la alerta ya **no** avisa "cuánto hay a guardar hace tantos días" (una recepción entera sin tocar es pendiente normal, no un error), sino los **potenciales errores reales** — mercadería trabada porque alguien **empezó y no cerró**. Dos casos en `reporte_agentes_stock_estancado()` (`sql/stock_estancado.sql`): **(1) RESTO SIN GUARDAR** (`a_guardar`): guardaron **parte** de un artículo (a góndola y/o excedente) y dejaron un **resto** sin guardar. Ej: llegan 100, suben 50 a góndola + 40 a excedente → quedan **10 estancadas**. La señal es que **hubo `guardado`** para ese código (guardado parcial) **Y** todavía queda `saldo > 0` en `a_guardar`; si **nunca se guardó nada** (recepción intacta) **NO** avisa. **(2) PICKEADO SIN AVANZAR** (`separar_pedidos` + `a_facturar`): mercadería ya pickeada, sin que nadie la trabaje (pickeada sin separar/armar, o armada sin facturar), que no puede quedar así +N días. **DÍAS HÁBILES:** los operarios no trabajan sáb/dom → la antigüedad se cuenta en **días hábiles (lun–vie)**, no corridos (algo del **viernes** recién dispara el **martes**: vie+lun = 2). Umbral `Stock_Config.dias_estancado` (default **2**), ahora interpretado en días hábiles. Sigue **solo Telegram**, respeta cutoff, excluye legajos 0/1, dedup diario, encadenada al cron de agentes (jobid 14). Verificado read-only: hoy (lun 27/07) marcaría **3** restos sin guardar (cod 248/501/535, guardado parcial + resto), y **cero** falsos positivos por recepciones intactas (323E, 99, 335…) ni por el picking/armado del propio día. Deja atrás los ~40 avisos anteriores (recepciones enteras que inflaban la lista).
>
> Nota (backend Supabase, sin bump de app): **Artículos DISCONTINUADOS — no disparan la alerta "CAPACIDAD SIN PROYECCIÓN"**. Esa alerta (`reporte_agentes_capacidad_sin_maximo`, Telegram) avisa cuando un artículo tiene **lugar en góndola** (`Capacidad_Sector`) pero **sin máximo/proyección** (`OC_Maximos`), asumiendo un typo de código. Pero los **discontinuados** (se venden hasta agotar stock, no se reponen) tienen lugar sin proyección **a propósito** → eran falsos positivos. Se creó la tabla **`Articulos_Discontinuados`** (`cod` PK, `motivo`, `creado_ts`; RLS anon **solo SELECT**) y la función ahora **excluye** esos códigos (CTE `disc`, normalizado). Cargados: **554, 573, 592**. Para marcar otro: `INSERT INTO "Articulos_Discontinuados"(cod,motivo) VALUES ('XXX','discontinuado')`. **Fix de dato:** el 3º venía mal escrito como **592E** en `Capacidad_Sector` (lo confirmó el dueño: es **592**) → corregido a `592` (H60, 18 cj). ⚠ El **`planimetria.js`** (mapa de picking, generado del Excel) todavía lista ese lugar como **592E@H60**; es inerte (el artículo tiene **0 pedidos y 0 movimientos de stock**), pero para dejarlo 100% consistente hay que corregirlo en la hoja **"Picking"** del Excel (592E→592) y regenerar.
>
> Nota: **v6.21 — Parte B: bloqueo del tilde de Facturación cuando el faltante se puede COMPLETAR + fix del CI (smoke tests)**. Dos cosas. **(A) Parte B (pedido del dueño):** al tickear una NP en **Facturación** (`facTickNP`), si la NP tiene faltante y **al menos un artículo faltante tiene stock para completarlo** — o sea `a_guardar > 0`, o **góndola** (`terminado > 0`), o **guardado hoy** — ya **no se factura corto**: hay que completarlo antes desde **CP**. Para todos (otros supervisores incluidos) queda **BLOQUEADO** con un `alert` que dice dónde está el stock y que "lo tiene que autorizar la operadora". **Solo la operadora** (`__identity.email === loekemeyer.n8n@gmail.com`, vía `_facEsOperadora()`) puede **forzar**: le sale un `confirm` de override y, si acepta, factura corto **y emite el evento `FCO`** (`facEmitOverride`, `texto = NP|TANDA|detalle|RS`) → **aviso Telegram** por el trigger nuevo `trg_facturacion_override_telegram` ("🧾⚠ FACTURÓ CON FALTANTE RECUPERABLE …"). Si el faltante **NO es recuperable** (no hay stock en ningún lado), sigue el `confirm` de siempre ("facturá por lo ENTREGADO"). Helpers nuevos: `_facEsOperadora`, `_facFaltRecuperables(falt)`, `facEmitOverride`. Reusa `_facSaldosN` (saldos de `vista_saldos_stock`, con `a_guardar` y `terminado`) + `_facGuardadoHoy` que ya se cargaban en el render de Facturación. Test nuevo `fac-block-recuperable.cjs` (A bloqueo · B override+FCO+cancelar · C normal) al `run.sh`. **(B) CI arreglado:** estaba **rojo en todos los pushes desde v6.15** (spam de mails "Run failed"). Dos tests quedaron desactualizados por cambios intencionales: `falt-tareas` probaba el **pop-up de faltantes** desactivado en v6.15 (`faltPoll` ya no crea `#faltPopupBody` → null) y `cp-focus` §3 asumía que el CP sin foco lista **todo** cuando v6.18 lo filtra a "a_guardar O guardado hoy". Se reescribieron al contrato actual (pop-up siempre oculto + badge de Facturación con el gate v6.18/v6.19; y `cp-focus` stubbea `vista_saldos_stock`). Suite verde de punta a punta. Nuevo código de acción **`FCO`** (ver § 4).
>
> Nota: **v6.20 — Recordatorio automático de "Completar Pedido" para Moncayo (legajo 104)**. Pedido del dueño: todos los días **hábiles (lun-vie)**, a partir de las **15:30 AR**, cuando Moncayo esté en la **botonera** (o sea, NO en medio de una tarea), que le avise *"es hora de completar los faltantes"* y le **abra directamente el módulo CP**. Implementado del lado del operario con un poll liviano cada 25s: `cpRecordCheck()` reutiliza `_faltActivo()` (asegura que está en `optionsScreen`, no mid-tarea, no prueba) + `_faltMiLegajo()`, chequea día hábil y hora ≥ 15:30 vía `_cpRecordNowAR()` (TZ AR), y **dispara una sola vez por día** (dedup en `localStorage` `vir_cp_record_104_<YYYY-MM-DD>`) con `alert(...)` + `showCPModal("104")`. Si a las 15:30 está en medio de una tarea, **no lo interrumpe**: espera a que vuelva a la botonera y ahí dispara. Auto-arranca con `cpRecordStart()`; el chequeo se auto-limita al legajo 104 (inofensivo para el resto). Config en el tope del módulo: `CP_RECORD_LEGAJO` / `CP_RECORD_MIN`.
>
> Nota: **v6.19 — Fix: el badge "⏳ Completando · completo" no se iba tras completar por CP**. Causa: al desactivar el pop-up de faltantes (v6.15), `faltMaybeCompletar` (que cierra la `Faltantes_Tarea` al llegar a 0) **dejó de correr** — solo cerraba si el operario había **tomado** la tarea por el pop-up (`_faltTareaMia`). Como ahora se completa por CP directo, la tarea quedaba `pendiente` aunque `cajas_falto`=0 → en Facturación el badge mostraba "⏳ Completando · completo · sin asignar aún". Dos fixes: **(a)** `facTareaBadge` ahora **oculta el aviso si ya no falta nada** en la NP (`facFaltInfo` sin cajas > 0), aunque la tarea siga abierta — la NP está lista para facturar. **(b)** nuevo `cpCerrarTareaSiCompleta(np)` que `cpConfirm` llama tras bajar el faltante: si la NP quedó sin `cajas_falto`, **cierra la(s) tarea(s)** activas (RPC `faltante_tarea_completar`), sin depender de que se haya tomado por pop-up. Además se cerraron por datos las tareas viejas ya completadas (97978, 98026, 98017).
>
> Nota: **v6.18 — CP: filtro = "a guardar O guardado hoy" + nombre del cliente**. Pedido del dueño: lo que hay que completar en los pedidos es **lo que está a guardar O lo que se guardó hoy** (aunque ya haya pasado a góndola), si hay faltante de ese artículo en una NP ya armada. Nuevo helper **`cpLoadGuardadoHoy()`** (movimientos `tipo='guardado'` del día AR → set de códigos); el filtro de `showCPModal`/`cpReloadFaltantes` ahora es `a_guardar>0 || guardado_hoy` (antes solo a_guardar). Los guardados hoy se completan desde **góndola** (origen del paso 2). La fila muestra "guardado hoy · góndola: M" cuando no tiene a_guardar. Además, **nombre del cliente**: `cpLoadRazonSocial()` trae `razon_social` de `PPP_Programacion_Diaria` por NP y se muestra en la fila (antes solo el código de cliente). El **badge** de Facturación (`facTareaBadge`) usa el mismo criterio (a_guardar O guardado hoy; `_facGuardadoHoy` cargado en el `Promise.all` de facturación). Se revirtió el hack manual del 280 (la regla lo maneja) y se corrigió su saldo (una completada del 280 vía CP había salido de a_guardar cuando físicamente estaba en góndola → ajuste a_guardar +1 / góndola −1; 280 quedó góndola 52 · a_guardar 0, sin negativo).
>
> Nota: **v6.17 — CP/badge: filtro corregido a SOLO "a guardar" (no góndola)**. Corrige v6.14, que había ampliado el filtro a "a_guardar O góndola" — mal: el CP mostraba faltantes de artículos que solo estaban en **góndola** (ej. 836/839/911/280) cuando el dueño solo quiere ver los que están **a guardar** (llegó mercadería nueva para completar el pedido). Un faltante contra algo que está en góndola es un tema de picking, no "llegó algo para completar". Ahora `showCPModal`, `cpReloadFaltantes` y el badge `facTareaBadge` filtran por **`a_guardar > 0` únicamente**. La fila muestra "a guardar: N" (se quitó el "· góndola: M"). Ejemplo real: quedan 323E (a_guardar 72) y 534 (a_guardar 6); desaparecen 836/839/911/280 (solo góndola). Nota: la lógica de **bloqueo del tilde** (parte B, pendiente) sí contempla góndola además de a_guardar — es otra cosa (no dejar facturar si el faltante es recuperable de cualquier lado).
>
> Nota: **v6.16 — Facturación: el aviso ⏳ "Completando faltante" solo aparece si hay stock para completar**. El badge `facTareaBadge` (amarillo, "⏳ Completando · faltan N · sin asignar aún") se mostraba para cualquier NP con una `Faltantes_Tarea` activa, **sin mirar stock**. Ahora Facturación carga los **saldos** (`stockFetchSaldos` sumado al `Promise.all` de la carga; `_facSaldosN` normalizado) y el badge se **oculta si NINGÚN artículo faltante de la NP tiene stock** en `a_guardar` o `terminado` (góndola) — pedido del dueño: si no hay mercadería, nadie lo va a completar, se factura corto, y no tiene sentido avisar que "falta guardarlo". El badge rojo de faltantes (`facFaltDist`/`facFaltBadge`, "qué salió corto") no cambia. Nota: reversa de un ajuste manual erróneo (942P `terminado` −288 → +288 = 0) hecha por datos.
>
> Nota: **v6.15 — Alerta automática de faltantes (pop-up) DESACTIVADA**. El pop-up que les aparecía a los operarios cada 6s para completar un faltante que llegó (`faltPollStart`/`faltDecidePopup`/`faltShowPopup`) queda apagado con el flag **`FALT_POPUP_ENABLED = false`**: no arranca el poll ni se muestra el pop-up (pedido del dueño — genera confusión; la carga de faltantes se hace desde el módulo **CP · Completar Pedido**, que desde v6.14 solo muestra los completables —con stock en a_guardar o góndola—). Reversible: poner el flag en `true`. Las **alertas Telegram** de faltantes son server-side (triggers/cron) y **no** dependen de esto. El botón/tile "Completar Pedido" (CP manual) sigue funcionando.
>
> Nota: **v6.14 — CP: filtro por "completable" = a guardar O góndola** (ajuste del v6.09). El dueño marcó que el CP le pedía completar faltantes de artículos **sin stock en ningún lado** (ej. NP 97986: 361E/367E, que no tienen ni a_guardar ni góndola). Ahora el filtro de `showCPModal`/`cpReloadFaltantes` muestra un faltante **solo si su artículo tiene stock en `a_guardar` > 0 O en `terminado` (góndola) > 0** — que son justamente los dos orígenes desde los que el CP puede completar (paso 2). Si no hay en ninguno, no figura. Cada fila muestra dónde está el stock ("a guardar: N · góndola: M"). Sigue sin filtrarse el acceso directo `focusNp`.
>
> Nota: **v6.13 — Merge de la rama `stock-negativo` sobre main v6.12 (2º reintegro)**. Main volvió a avanzar (v6.08→v6.12: rediseño Editar líos, picking ubicación por origen/Otra, excedente→góndola, MG borrador, faltante-que-llegó automático). Se remergeó `origin/main` a la rama: **cero conflictos de código** otra vez (solo versiones). La rama trae, sobre v6.12: (a) Facturación NPs a FC con anchos **%** (sin scroll) + box-sizing; (b) **racks** — guardarraíles al aprobar (`racksBajadaAlerta`) + botón "✗ Rechazar"; (c) **a_facturar por NP** (`stockSalidaFacturadoNP`, `ref=tanda|NP`); (d) **PPP** Avellaneda→Zona 1 + Z2 en ruta Sur/Centro/Oeste; (e) **CP operario** filtrado a solo artículos "a guardar" con faltante (v6.09 de la rama). Datos ya live: 931E/984E, C86C, 982E #28, 97822, Avellaneda. **Pendiente**: parte B del CP (vista operadora en Facturación + bloqueo del tilde + Telegram).
>
> Nota (backend Supabase, sin bump de app): **Faltante que llegó — AUTOMÁTICO reactivado, ahora avisa SOLO el código que llegó**. Se retomó el pendiente que dejó v5.84. La función `detectar_faltantes_llegaron()` se reescribió: la **tarea** (`Faltantes_Tareas.articulos`/`cajas`) y el **aviso Telegram** ahora incluyen **únicamente los código(s) que realmente llegaron a `a_guardar`** (los que tienen saldo > 0, match normalizado + tolerante a la E), **no** todo el faltante de la NP. Antes creaba la tarea con TODO el faltante (ej. 280+534) aunque solo hubiera llegado uno (534) → por eso se había apagado. Ahora, ej.: NP 44502 tenía faltante de 17 cajas en 5 códigos, pero solo llegó el **856 (1 caja)** → la tarea/aviso dice solo "856". El pop-up en los celulares (`faltHtmlMine`→`faltArtsHtml` lee `articulos`) y el CP quedan bien acotados. Dedup Telegram por `NP|códigos|día`. **Cron reactivado**: `detectar-faltantes-llegaron` (**jobid 34**, `*/2 * * * *`). El resto del flujo (pop-up, asignación atómica, autocierre, botón manual "📢 Avisar faltante llegó") no cambia.
>
> Nota: **v6.12 — Picking: ubicación por ORIGEN (Loeke/Chef) en códigos duales + MG guarda el borrador sin "Cerrar"**. Dos pedidos del dueño. **(A) Ubicación dual:** hay códigos que se importan **de Loeke y de Chef con el MISMO número** pero se guardan en lugares distintos. La ubicación de picking ahora depende del **origen del pedido**: **NP > 90000 = Loeke, si no = Chef** (`pkNpEsLoeke`). Mapa `PICK_UBIC_DUAL` (v6.12): **809E** → Loeke **J13 y J14** / Chef **M13 y M14**; **437E** → Loeke **F9 a F12** / Chef **L7 y L8**; **438E** → Loeke **F13 a F16** / Chef **L5 y L6**. En `showPickingList`, para esos códigos se calcula el reparto por origen (`pkDualBreakdown` sobre las NPs de la tanda) y se **sobre-escribe el sector** + se pinta una nota (`.pk-orig`, azul Loeke / naranja Chef): "🏷️ Pedido de LOEKE — buscá en J13 y J14". Se verificó en los datos que **cada tanda real es de un solo origen** (la única mezcla eran NPs sin tanda); si llegara mezclada, muestra las dos ubicaciones con el reparto (`.pk-orig.mix`). ⚠ El **809E estaba mal**: su planimetría apuntaba a **M13 (Chef) siempre**, así que a Loeke lo mandaba al lugar equivocado — ahora va a J13. El override vive en el código (no toca `planimetria.js`); es la fuente de verdad para esos 3 códigos en el picking. **(B) MG "Seguir Guardar a góndola" robusto:** MG (y el nuevo Excedente→góndola) ya tenían borrador recuperable (`opDraftResume`), pero **solo se guardaba al tocar "Cerrar"** (`opAskClose`). Si el operario salía de otra forma (se iba a la botonera, tocaba otras teclas, se recargaba), no quedaba nada. Ahora `mgRender`/`excRender` **auto-guardan en cada cambio** (si hay algo cargado) con `opDraftSaveQuiet` (sin re-render de la sugerencia, como `pkSave`), así el "▶ Seguir …" aparece siempre al volver. Funciones `pkNpEsLoeke`/`pkDualBreakdown`/`opDraftSaveQuiet` al smoke + test `dual-ubic-mg-draft.cjs` (Loeke→J13/F9/F13, Chef→M13/L7/L5, MG guarda borrador sin Cerrar). Suite verde.
>
> Nota: **v6.11 — Picking: forzar retirar de GÓNDOLA (aviso Telegram) + el cartel de "Terminar armado" solo cuando faltan líos**. Dos pedidos del dueño. **(A) Forzar góndola:** cuando un artículo tiene **excedente que cubre todo lo pedido**, el picking **saltea la góndola** (`it.skip`) y lo levanta del excedente al final (v4.26). Ahora esa pantalla (`pk-skip`) suma un botón **"🟢 Retirar de góndola igual"** → `pkForzarGondola(idx)`: pide confirmar, **deja de saltear** ese artículo (se levanta de góndola, monto completo), **saca su paso de excedente** (`art·EXC`) y **emite el evento `PGE`** (`pkEmitRetiroGondola`, `texto="COD|TANDA"`). Un **trigger nuevo de Supabase** `trg_picking_gondola_excedente_telegram` (`WHEN opcion='PGE'`, resuelve `legajo→Empleado`) manda por Telegram **"🟢⚠ RETIRÓ DE GÓNDOLA (había excedente) — {Nombre} retiró de GÓNDOLA en lugar del excedente. Art X · tanda Y · Legajo N"**. La decisión se persiste (`_pk.forced`) para sobrevivir un retomar que rearma la lista (`showPickingList` la re-aplica; `pkResume` ya restaura los ítems tal cual). Un badge verde "🟢 Estás retirando de góndola…" queda en el paso. **(B) Cartel de Terminar armado:** el `confirm()` de v5.84 ("¿Terminaste de armar…? NO vas a poder volver a entrar") **molestaba cuando ya estaba todo hecho**. Ahora en `compTerminar` el cartel aparece **SOLO si faltan líos** por armar (`pendLios.length`): si están todos → **termina directo, sin cartel**; si faltan → avisa y, si igual quieren, terminan (o Cancelar → Paso 2). El candado anti doble-armado (v5.72/73) sigue protegiendo contra duplicar. Nuevo código de acción **`PGE`**. Funciones `pkForzarGondola`/`pkEmitRetiroGondola` al smoke + test `pk-forzar-gondola.cjs` (forzado: skip→pick, saca ·EXC, evento PGE, persiste; y confirm solo con pendientes). Suite verde.
>
> Nota: **v6.10 — Botón "📦 Del excedente → góndola" (bajar el excedente cuando hay lugar)**. Pedido del dueño. El **excedente** son cajas que no entraron cuando la góndola estaba llena (se guardan "arriba" con su ubicación, en el MG v4.26); hasta ahora **no había forma en la app** de bajarlas a góndola cuando se liberaba lugar (se hacía a mano por SQL — hay 22 movimientos `tipo='traslado'` viejos, ref "excedente a gondola 29/06"). Ahora el chooser de **MG (📥 Bajar a góndola)** tiene un **tercer botón "📦 Del excedente (lo que no entró)"** (ámbar, entre "Lo que llegó" y "De los racks") → abre `showExcModal`: lista los artículos con **excedente > 0** (saldo autoritativo de `stockFetchSaldos().excedente`, misma fuente que MG), muestra **dónde están** (ubicaciones de los eventos +, vía `pkFetchExcedente`, best-effort — si no hay dato dice "sin ubicación anotada") y un stepper por código (0..saldo). Al confirmar (`excConfirmar`) mueve **`excedente −N` + `terminado (góndola) +N`** con **`tipo='traslado'`**, `ref="excedente_a_gondola"` (mismo par que se hacía a mano; es la **reversa exacta** del excedente del MG). Si el código tiene **una sola** ubicación, se anota en el movimiento `excedente−` (dato; el saldo autoritativo sigue siendo el **NET por código**, igual que lo consume el picking). Funciones `showExcModal/excRender/excConfirmar/excSet/excChg/excAskClose/closeExc` (+ borrador recuperable, op `"EXC"` en `opDraftResume`) al smoke. Verificado headless (lista+orden+ubicaciones+clamp + los 4 movimientos correctos: −3/−30 exc, +3/+30 góndola, tipo traslado, ubic única→se anota, doble→null) + render mock + suite verde. No toca picking ni MG.
>
> Nota: **v6.09 — Picking · ubicación "✏️ Otra…" (escribir a mano)**. Pedido del dueño: en el modal de "¿Dónde dejás la tanda?" (`askPickUbicacion`, evento **PUB** v5.78) los operarios estaban atados a las opciones fijas (`PICK_UBIC_OPCIONES`: Mesa 1/2, Carro, AA3…AB10). Ahora al final de la grilla hay un botón **"✏️ Otra…"** (`.pub-otra`, ámbar) → abre un `prompt()` donde escriben la ubicación a mano (ej. "Pasillo 3 / Rack B12"); si escriben algo, ese texto libre va como `descripcion` del evento PUB igual que una opción fija; si cancelan o dejan vacío, el modal **no se cierra** (pueden elegir otra opción o Cancelar). No cambia el modelo (mismo evento PUB, `texto=tanda`, `descripcion=ubicación`); el wizard de armado lo muestra igual ("📍 Dejado en: X"). Solo UI. Verificado headless (grilla con 12 opciones, "Otra…" última y estilada, sin errores de página) + `checkhtml`.
>
> Nota: **v6.08 — "Editar líos": rediseño estético** (el dueño lo marcó feo). La lista de líos generados (`_compRenderLios`, vista *editar*) tenía cada lío como una **fila apretada** con 4 botoncitos chicos (−, +, ✏️, ×) al lado de la composición → amontonado y difícil de tocar. Ahora cada lío es una **tarjeta en 2 partes**: arriba badge de letra (A1–A2…) + composición (monoespaciada, negrita) + chip **×N** si es grupo; abajo botones **grandes** (42px) **[−] [+]** (solo si es grupo) + **✏️ Editar** + **🗑 Borrar**. CSS: `.cmpl-eg/.cmpl-eg-top/.cmpl-eg-acts/.cmpl-egb/.cmpl-egedit/.cmpl-egdel/.cmpl-lab/.cmpl-egn`. Solo estética + tap targets, misma lógica (`_compGroupMore/Less/Reopen/Del`). Verificado con render mock (sin overflow).
>
> Nota: **v6.07 — "🔁 Repetir" a prueba de errores + dato de tamaño de lío por artículo (top 30)**. **(1)** El botón Repetir ahora queda **siempre visible** tras cerrar un lío; si ya no quedan cajas para repetirlo se **grisa** (`.cmpl-rep.off`) y al tocarlo **avisa** ("Ya usaste todas las cajas del {cod} — no se puede armar otro lío igual") — nunca rompe ni descuenta de más (`_compRepetirLast` guarda con `canMore`). Antes se ocultaba; ahora se ve + avisa (pedido del dueño: que aunque toquen de más no rompa). **(2) Dato base para sugerencias futuras** (corre por fuera del botón): análisis de los 30 artículos más pickeados (suma de PKC) × **tamaño del lío PURO más común** (parseando el resumen de TAL, líos de un solo código). Resultado: el estándar es **de a 5** (505/504/513/506/501/031/586/546/510/544/026/027/… todos 5, con 75-98% de sus líos puros). **Excepciones:** `321 → de a 3` (83%), `315 → de a 4`, `583E → de a 4`, `706 → de a 6`. Sin dato: `103/522E/198E` (siempre mezclados, sin líos puros). Servirá para, más adelante, **sugerirle al operario la medida por artículo**.
>
> Nota: **v6.06 — Botón "🔁 Repetir" en el armado de líos** (reemplaza al atajo ⚡ que se sacó en v5.105, ahora claro y sin vista nueva). Pedido del dueño. En el paso Líos (`_compRenderLios`, vista *armar*), **después de cerrar un lío** aparece **🔁 Repetir Lío X** (otro igual) — **SOLO si quedan cajas para repetirlo** (`_compLioGroups().canMore`); si no, no se muestra. Cada toque arma otro lío idéntico al ÚLTIMO cerrado (`_compRepetirLast` → `_compGroupMore`); un **−** saca el último si se pasó (`_compQuitarLast` → `_compGroupLess`, aparece con ≥2 de ese lío). Reusa la lógica de grupos que ya existía en "Editar líos" (por eso es sólido). Dato que lo motiva: el historial de TAL muestra que los líos **puros** de un artículo son muy consistentes (ej. **505 → de a 5 cajas en 165 de ~200 veces**), así que "repetir el último" es lo natural. Verificado: `comp-doblearmado.cjs` + smoke OK.
>
> Nota: **v6.05 — Bump de versión (reset del esquema: v5.105 → v6.05)**. Pedido del dueño. Sin cambios funcionales, solo `APP_VERSION` (index.html) y `SW_VERSION` (sw.js). De acá en más se sigue con **v6.0x**.
>
> Nota: **v5.105 — Atajo "⚡ Líos de a N" SACADO (funcionaba mal)**. Pedido del dueño. En el paso **Líos** del armado (`_compRenderLios`) se quitó la UI del auto-armado (la barra "⚡ Líos de a N" con el input `.cmpl-szinp` + el botón "⚡×N" por código `.cmpl-auto`, v5.85) porque funcionaba mal. Las funciones **`_compLioAuto` y `_compSetLioSize` quedan definidas** (y el CSS `.cmpl-auto/.cmpl-autobar/.cmpl-szinp`) por si se reactiva más adelante ("por ahora"). El armado manual de líos (tocar el código +1, − para restar, **✓ Cerrar Lío**) queda igual. Verificado: `comp-doblearmado.cjs` + smoke OK.
>
> Nota: **v5.104 — Cajas pedidas exportable a Excel + fix de alineación de las tablas de movimientos**. **(1)** La vista "Cajas pedidas" (`stkOpenCajasPedidasArt`) tiene botón **⬇ Exportar a Excel** (`stkCajasPedidasExport`) → baja un `.xls` (tabla HTML con MIME `application/vnd.ms-excel` + BOM, mismo patrón que el export de excedentes) con columnas NP · Tanda · Razón Social · Pidió · Pickeado · Separado. Guarda las filas en `_stkPop.rows`. **(2) Fix (lo reportó el dueño: "corrido fuera de su columna"):** en `.mva-tbl` (movimientos de Góndola/A guardar/Racks) los números quedaban **alineados a la izquierda** mientras los headers iban a la derecha, porque `.mva-tbl td{text-align:left}` (especificidad 0,2,1) le ganaba a `.mva-in/.mva-out/.mva-sal{text-align:right}` (0,1,0). Se scopeó la alineación a `.mva-tbl td.mva-in/out/sal` (0,2,1) → los números caen bajo su columna (verificado headless: borde derecho del header == del valor).
>
> Nota: **v5.103 — Stock rediseño parte 4 (última): Cajas pedidas (#1) → rediseño COMPLETO**. La columna **Cajas pedidas** ahora es clickeable → `stkOpenCajasPedidasArt`: **qué NP pidió cuántas** de ese código (de `PPP_Base_Pedidos` por `articulo=eq.cod`), la **tanda** de cada NP (`PPP_Programacion_Diaria`), y si esa tanda ya se **pickeó** (hay `separar_pedidos`/`picking`/delta>0 de ese código para la tanda en `_stk.movs`) y/o **separó** (`a_facturar`/`separado`/delta>0). **Con esto el rediseño de "Stock y Compras" queda COMPLETO** — cada columna abre SOLO su rubro: **#1** Cajas pedidas (NP + pickeado/separado), **#2** Capacidad (ubicaciones + cap, `stkOpenCapArt`), **#3** Góndola (movs por fecha + saldo + rango, `stkOpenMovsArt`), **#4** Excedente (igual, `stkOpenExcedenteArt`), **#5** Pickeados (+ubicación PUB), **#6** A facturar (+ubicación AUB), **#7** A guardar (movs+fechas+saldo), **#8** Racks (posiciones + movs + fechas, `stkRacksArtRender`). El expand de la fila (todos los movimientos juntos) sigue existiendo. ⚠ Sin test headless automatizado (los popups dependen de `_stk`/`_stkPop` module-scoped); verificado por parse + render-mocks + patrón reusado. Cajas pedidas matchea por código exacto (equivalencias 029→437E podrían no cruzar; revisar si hace falta).
>
> Nota: **v5.102 — Stock rediseño parte 3: ubicación FÍSICA en Pickeados (#5) + A facturar (#6)**. En `stkOpenEstadioArt`, además de las NPs/tandas, ahora muestra **DÓNDE** está el pedido (badge violeta `.stkpop-ubic`): **Pickeados** (`separar_pedidos`) → ubicación del picking **por tanda** (Mesa 1/2, Carro) desde eventos **PUB** (`texto=tanda`, `descripcion=ubicación`, v5.78); **A facturar** (`a_facturar`) → ubicación del armado **por NP** (AB10/AA4…) desde eventos **AUB** (`texto=NP`, `descripcion=ubicación`, v5.86). Se cruza por tanda/NP con un fetch a `Registros_Produccion_Virgilio` (última carga gana). **Falta del rediseño (última parte):** #1 **Cajas pedidas** (qué NP pidió cuántas + si ya se pickeó / separó). El resto (#2 Capacidad, #3 Góndola, #4 Excedente, #5 Pickeados, #6 A facturar, #7 A guardar, #8 Racks) ya está.
>
> Nota: **v5.101 — Stock rediseño parte 2: Capacidad (#2) + Racks con fechas (#8)**. Sigue de v5.100. **#2 Capacidad de góndola:** la columna ahora es clickeable → `stkOpenCapArt` muestra las **ubicaciones (sectores) y la capacidad (cajas_max) de cada una** (de `_stk.cap` = `Capacidad_Sector`, ya cargado). **#8 Racks:** `stkOpenRacksArt` ahora muestra las posiciones de la planimetría (como antes) **+ los movimientos** del depósito `racks` con **filtro de rango de fechas** y saldo. Se extrajo **`_stkMovsBlock()`** (la tabla de movimientos por fecha con Entró/Salió/Saldo corrido) para compartirla entre Góndola/A guardar (`stkMovsArtRender`) y Racks (`stkRacksArtRender`); `stkMovsArtDate` despacha según `_stkPop.kind` (`racksArt` → posiciones + movs; si no → solo movs). **Faltan del rediseño:** #1 **Cajas pedidas** (qué NP pidió + pickeado/separado), #5 **Pickeados** + ubicación (mesa/carro, eventos **PUB**), #6 **A facturar** + ubicación (AA4/AA5, eventos **AUB**).
>
> Nota: **v5.100 — Stock: vista de movimientos POR RUBRO por artículo (parte 1 del rediseño de "Stock y Compras")**. Pedido del dueño: al pararse sobre un artículo quería ver los movimientos SOLO del rubro que elige (no todos juntos como el expand de la fila). **Parte 1:** las columnas **Góndola** (`terminado`) y **A guardar** (`a_guardar`) ahora son **clickeables** → `stkOpenMovsArt(cod, dep, titulo, icono)` abre una tabla con SOLO ese depósito de ese artículo, **ordenada por fecha (ASC)**, con **Entró / Salió / Saldo corrido** + **filtro por rango de fechas** (`stkMovsArtDate('desde'/'hasta'/'clear')` → `stkMovsArtRender`). Reusa `_stk.movs` (ya cargado), `_stkWin` (respeta cutoff/asOf global), `_stkNormCod` y `_stkPopShell`; CSS `.mva-*` en `STK_POP_CSS`. **Faltan (próximas partes):** #1 **Cajas pedidas** (qué NP pidió cuántas + si ya se pickeó/separó); #2 **Capacidad góndola** (ubicaciones + capacidad de cada una, de `Capacidad_Sector`); #5 **Pickeados** + en qué ubicación está (mesa 1/2, carro — de eventos PUB v5.78); #6 **A facturar** + ubicación (AA4/AA5 — de eventos AUB v5.86); #8 **Racks** + filtro de fechas de movimientos. #4 **Excedente** queda igual (ya tenía `stkOpenExcedenteArt`).
>
> Nota: **v5.99 — Monitor: tabla = 3 días hábiles fijos + "Tandas a FC" muestra TODAS**. Pedido del dueño (en la TV no se veían todas las tandas a facturar). **(A)** La tabla principal (pendientes de armado) muestra **siempre los próximos 3 días hábiles** (`targetDeliveryDates(sheetMap,3)`, saltea findes/feriados); se **sacó el auto-expand a 7 días** que había cuando quedaban ≤3 pickings (`refreshMonitor`: `targetDates = narrowDates`). Lo más lejano sigue en la card **"+ Fuera de ventana"** con sus m³ (ya existía; ahora aparece más seguido). **(B)** El panel **"Tandas a FC"** ahora lista **TODAS** las terminadas (picking+separado), aunque estén FUERA de los 3 días — antes solo las de la ventana. En `renderMonitor` se agrega un pase extra sobre `sheetMap` usando el `statusMap` (que `refreshMonitor` trae para 7 días) y se re-ordena por fecha+tanda. **(C)** "Fuera de ventana" ahora **excluye las terminadas** (ya están en a FC) → cuenta solo el trabajo **pendiente** más lejano, sin doble conteo. Test `mon-fc.cjs` (terminada fuera de ventana → a FC; no en tabla ni en fuera-de-ventana; pendiente lejana → fuera de ventana). ⚠ Verificar en la TV real (1920×919): si con muchas a FC no entran, ajustar layout (columnas/densidad).
>
> Nota: **v5.98 — "Movimientos de góndola" muestra QUIÉN hizo cada movimiento**. Pedido del dueño. En el popup **"🔁 Movimientos de góndola"** (admin Stock → `stkOpenGondola`/`stkGondRender`) faltaba ver qué empleado hizo cada guardado/picking. Cada fila ahora muestra **👤 empleado** (columna nueva `.stkpop-mv-emp`, violeta, con ellipsis + `title` con el nombre completo). El dato ya estaba: **`Movimientos_Stock.legajo`** (lo trae `stockFetchMovs` con `select=*`) y el nombre sale de `_empleadosNombres` (legajo→nombre, `getEmpleadosNombres`, cacheado 1h). `stkOpenGondola` ahora dispara `getEmpleadosNombres()` y re-renderiza al resolver. Sin legajo (ajustes / filas viejas) muestra **"s/dato"**; si no resuelve el nombre, **"Leg N"**. **Recordatorio del modelo de datos:** la góndola es el depósito **`terminado`**; el guardado a góndola son movimientos en `Movimientos_Stock` con `deposito='terminado'` (o `excedente` si la góndola estaba llena) y `tipo IN ('guardado','guardado_fuera_lista')` (o `baja_racks` cuando baja de los racks), `delta>0`, y `legajo` = quién lo hizo. Receta: `select ts, cod_art, delta, legajo from "Movimientos_Stock" where deposito='terminado' and tipo in ('guardado','guardado_fuera_lista') and delta>0 and cod_art='<cod>' order by ts desc`.
>
> Nota: **v5.97 — Picking OFFLINE-FIRST (mal WiFi al fondo del depósito)**. Pedido del dueño: al fondo del depósito el WiFi es malo y "tardaba en mostrar el siguiente código". El picking YA se precargaba entero al tocar **EP** y marcar/avanzar ya eran 100% locales (`pkOk`/`pkF`/`pkNext` + `pkSendDetail` fire-and-forget encolado); lo que faltaba era que al **REABRIR** (se bloquea el cel, cambian de pantalla, re-tocan EP) no volviera a pegarle a la red. Ahora `showPickingList`, al arrancar, si hay guardado local de ESA tanda hoy (`pkLoadSaved`), reabre al **INSTANTE** desde el guardado (`pkResume`) **SIN tocar la red** (ni `fetchMonitorSheet`, ni `fetchPickingBase`, ni el excedente). Solo el **primer EP** de una tanda baja de red (ahí necesitan señal, una sola vez); de ahí en más es 100% offline. Además `pkFetchExcedente` ahora tiene **timeout** (AbortController 7s): un WiFi lento no cuelga la carga — si tarda, el picking se arma **sin** el excedente (se levanta todo de góndola, degradación aceptable). La reconstrucción desde el servidor (`seedFromServer`, v5.91) NO usa el offline-first (re-baja fresca: es un "retomar" con señal). Test `pk-offline.cjs` (reabrir misma tanda = sin red + restaura; otra tanda = sí red).
>
> Nota: **v5.96 — Paso "Separar" (matriz códigos×NP): líneas de grilla + ya no salta arriba al tocar una celda**. Dos pedidos del dueño sobre la vista **"Modo picking"** del paso Separar del armado (`_compSepMatrix`, tabla `.csep-mx`). **(1) Gridlines:** la tabla solo tenía un `border-bottom` tenue → sin líneas verticales no se veía qué cantidad iba a qué NP. Se agregó `border-right` (líneas **verticales** entre columnas de NP), se reforzó el `border-bottom` (#d7dee7) y se puso un separador **2px** después de las columnas fijas Cod/Tot (`.csep-mxc` con `box-shadow`, `.csep-mxt`). **(2) Scroll salta arriba:** tocar una celda → `_compSepTap` → `_compRenderSep` reemplaza `#compStepSep` innerHTML, recreando la matriz `.csep-mxwrap` (scroll interno `max-height:60vh`) y el `.comp-body` (scroll del modal) → la vista se iba al tope. Ahora `_compRenderSep` **guarda el `scrollTop` de ambos ANTES** de reemplazar y lo **restaura después** (setear `scrollTop` sobre el elemento recién insertado funciona sincrónico, verificado). Verificado con mock (gridlines claras: vertical por NP + separador Cod/Tot) + test de restaurar scrollTop (before==after).
>
> Nota: **v5.95 — Unificado "Completar Pedido" + "Avisar faltante llegó" en un solo tile**. Pedido del dueño: en Administración había **dos tiles separados para lo mismo** (un faltante que llegó a un pedido sin facturar). Ahora hay **UN** tile **"📦➕ Completar Pedido"** (se sacó el de "📢 Avisar faltante llegó") que abre `showFaltAvisar` (el hub): lista las NPs con faltante sin facturar (`cpLoadFaltantes`) y por cada una ofrece **DOS acciones** — **📦➕ Cargar yo** (`faltCargarYo(np)` → cierra el hub y abre `showCPModal('0', null, np)`, el CP **enfocado** en esa NP vía el `focusNp` de v5.89) o **📢 Avisar** (`faltCrear` → crea la `Faltantes_Tarea` y salta el pop-up en los celulares, FALT v5.71; si ya se avisó muestra "✓ Avisado"). El CP directo sigue accesible desde la botonera del operario (**CP**) y desde el pop-up. `faltAvRender`: botón verde Cargar / rojo Avisar por fila (`.fav-actions`/`.fav-btn-cargar`). `_faltNpNorm` (`trim`+quita `.0`) == el normalizador del filtro `focusNp` → la NP matchea siempre. Verificado headless (hub con Cargar+Avisar+Avisado, sin errores; tile "Avisar" ya no está). Título del modal: "📦➕ Completar Pedido — faltante que llegó".
>
> Nota: **v5.94 — Monitor TV: auto-reload cada 10 min (evita el crash por memoria)**. Reporte del dueño: la TV de pared mostraba **"¡Vaya!" (Chrome Aw-Snap) cada ~15 min** y había que tocar "Volver a cargar". **No es el wifi** (un corte de red da otra pantalla). Es el **navegador quedándose sin memoria**: el aparato MXQ es barato (poca RAM) y el monitor corre 24/7 refrescando cada 30s (`MONITOR_REFRESH_MS`) **sin recargarse nunca** → la memoria se acumula hasta que Chrome mata la pestaña. Fix: en el bloque de **kiosko** (`if (__pendingMonitorParam && (_keyValid || _kioskEnrolled))`, index.html ~16693) se agrega `setInterval(location.reload, 10min)` (guard `window._kioskReloadTimer`) → la pantalla se recarga sola y arranca limpia antes de llenarse. **Solo aplica al kiosko de pared** (no al monitor que un supervisor abre en su PC). Si aun así crashea, el aparato es demasiado débil (cambiarlo).
>
> Nota: **v5.93 — Menú de Recepción de Mercadería: reordenado por importancia + contador de remitos**. Pedido del dueño. En `renderMenu` (`recepcion.js`) el orden pasó a: **1º 📋 Pendientes** (lo más usado) · **2º 📦 Bajadas Racks → góndola** · **3º ✍️ Carga Manual**. Carga Manual ahora es **chico y apagado** (clase nueva `.opTipoBtn.opBtnSm`: height 52px vs 90px, font 15px, gris #64748b) porque es de uso puntual. **Pendientes muestra el contador de remitos por cargar entre paréntesis** — "📋 Pendientes (N)" — vía `pendBadgePend(btn)` (nueva, espejo de `racksBadgePend`): `count exact head` sobre `Control_Modo_OP` con `estado='pendiente'` (las mismas filas que lista `renderPendientes`). Solo se muestra el número si N>0 (igual que el de Bajadas Racks). Cache-bust `recepcion.js?v=3.68`. Verificado: sintaxis OK + mock con el CSS real (Pendientes (8) grande arriba, Carga Manual chico gris abajo) + la DB tiene 8 pendientes ahora.
>
> Nota: **v5.92 — Rediseño de la botonera del operario (más peso a lo importante)**. Pedido del dueño: darle prioridad visual a los botones más usados. Nueva estructura de `filas` (index.html): **row1 = Picking [EP, TP]** (grandes, azul) · **row2 = Armado [AP, TAP]** (grandes, verde) · **row3 = Depósito y carga [RT, MG, CC]** (medianos, sin color; RT a la izquierda y MG a la derecha por pedido del dueño) · **row4 = secundarias [CR, RR, RI, EI, CP, RC, IR, EA, SC]** (chicas) · **row5 = tiempos/pausas [AT, PB, Limp, Perm, PC, CT]** (chicas). `BOTONERA_SECUNDARIAS = { row4:true, row5:true }`. **Únicos con color: EP·TP (azul) y AP·TAP (verde)** — se sacó el color de CP/RC/EA/IR (antes tenían). CSS nuevo: `.row-2`/`.row-3` (grillas), `.row-core .box` (padding/título grandes), colores por `data-code`, `.botonera-grp` (etiquetas de grupo 🛒/🔨/📦). El borde rojo de **pendiente/disabled** se subió de especificidad (`.box[data-code].pending`) para que gane sobre el color de core. **🔀 Mover racks** dejó de ser el botón ancho aparte (`#moverOpBtn`, borrado del HTML) → ahora es un **box chico** que se agrega al final de las secundarias en el render (onclick `showMoverModal`). Verificado headless (layout 2/2/3/10/6, sin overflow a 412px, rojo pendiente OK) + suite completa en verde. HTML: grupos con separadores en `#optionsScreen`.
>
> Nota: **v5.91 — Continuar un PICKING que cruzó de día (reconstrucción desde el servidor)**. **Bug urgente (24/07):** un operario (legajo 122) empezó el picking de una tanda a la tarde (EP 16:04), marcó 25 artículos y **no lo cerró**; al otro día la app solo le ofrecía **"Presioná para terminar" (TP)** — no continuarlo — y EP estaba deshabilitado por el picking abierto → **trancado**. Causa: el avance interactivo (`_pk`) se guarda en `localStorage` (`vir_pk_<legajo>`) **protegido por día** (`pkLoadSaved` borraba el snapshot si `day !== hoy`), así que al abrir hoy se limpiaba y el botón "▶ Seguir picking" no aparecía. Pero **los eventos PKC de ayer sí quedaron en Supabase** (`Registros_Produccion_Virgilio`, `texto = TANDA|COD|ESP|REAL`) → el avance es **recuperable**. Fix (index.html): **(1)** `pkLoadSaved` conserva el guardado de otro día **si el picking sigue abierto** para esa tanda (cruce de día); si no, limpia como antes. **(2)** `pkFetchServerMarks(tanda, legajo, sinceIso)` reconstruye `Map<código, reales>` desde los PKC (acotado por `ts_inicio` del EP para no traer marcas de una vez anterior). **(3)** `showPickingList(tanda, legajo, opts)` con `opts.seedFromServer` siembra el avance del servidor sobre la lista fresca y ubica en el **primer artículo sin marcar**. **(4)** `pkResumeServer` + botón morado **"▶ Seguir picking tanda X"** en `renderPendingSuggestion` cuando hay un picking abierto **sin snapshot local** (cruzó de día / otro celular / se limpió): reconstruye desde el servidor en vez de dejar solo "terminar". El operario ve marcado lo de ayer y sigue con lo que falta; termina normal con "Terminé el picking" (TP). Reconstruye por **código** (no marca los pasos de excedente, raros). Necesita señal (es un "retomar", no el picking 100% offline — eso es el pendiente aparte del WiFi). Test `pk-resume-server.cjs` (reconstrucción + guard cross-day). ⚠ **Pendiente aún abierto:** precargar el picking para que ande al fondo del depósito sin señal (lo de "los primeros dos botones + mal WiFi").
>
> Nota: **v5.90 — Pop-up de faltantes avisa cuántos hay (avisos consecutivos)**. Pedido del dueño: si llegaron faltantes de **más de una NP**, que se vea que son varios (no uno solo). La detección server-side (`detectar_faltantes_llegaron`, v5.83) ya crea **una tarea por NP** (loop por NP, idempotente); lo que faltaba era mostrarlo. Ahora `faltDecidePopup` cuenta las tareas **pendientes** y se lo pasa a `faltHtmlPend(t, n)`: si hay más de una, arriba del pop-up sale un cartel amarillo **"⚠ Hay N pedidos con faltante para completar — van saliendo de a uno"**. Siguen apareciendo de a uno (el que uno toma → el resto ve el siguiente), pero ahora se sabe que hay más. Con 1 solo no muestra contador. Test `falt-tareas.cjs` extendido (1 → sin contador, 3 → "Hay 3").
>
> Nota: **v5.89 — Pop-up de faltantes: "Cargar las cajas" va DERECHO al CP de esa NP + se sacó "Ya lo completé"**. Pedido del dueño (confusión con los 2 botones). Cambios en `faltHtmlMine`: el botón principal ahora dice **"📦➕ Cargar las cajas"** (antes "Completar ahora") y el secundario **"Soltar (que lo haga otro)"**; se **eliminó "Ya lo completé"** (era redundante y confuso: la tarea se autocierra sola cuando el CP baja el faltante a 0, vía `faltMaybeCompletar`). Antes "Completar ahora" abría el CP con la **lista de TODOS los faltantes** y el operario tenía que buscar el suyo; ahora `faltCompletar(id,np)` → `showCPModal(legajo, null, np)` abre el CP **enfocado en esa NP**: nuevo 3er parámetro `focusNp` filtra `_cp.falt` a esa NP (y `cpReloadFaltantes` lo respeta), y si queda **1 solo artículo salta directo al paso 2** (cuántas cajas · de dónde —default "a guardar"— · en qué lío / lío nuevo). El paso 2 del CP ya existía; solo cambió el punto de entrada. Test `cp-focus.cjs`. **`faltYaListo` sigue definido** (no se llama desde la UI, pero queda por si algo lo referencia + smoke). Rebase sobre la línea concurrente (v5.88).
>
> Nota: **v5.88 — En "Bajadas Racks → góndola" (aprobación) se muestra sector + día/hora**. Cada tarjeta de la cola de aprobación (recepcion.js, `racksBajaCard`) ahora muestra debajo del pedido: **📍 Sector** (de qué ubicación del rack se bajó) y **🕒 día/hora** en que el operario la marcó (zona AR, 24h). El día/hora ya estaba (`Racks_Bajadas.ts`, se agregó al `select`). El sector no se guardaba: columna nueva **`Racks_Bajadas.sector`** (nullable) + `rkbConfirmar` (index.html) ahora persiste `sector: it.sec` (el operario ya elegía la ubicación para descontar de la planimetría, solo faltaba guardarla). Bajadas viejas / auto / del flujo `_br` no tienen sector → la tarjeta muestra solo la fecha. Cache-bust `recepcion.js?v=3.67`.
>
> 💡 **IDEA / BACKLOG (pedido del dueño, 23/07 — NO implementado): Reporte semanal de cumplimiento de proveedores + alerta Telegram.** **Contexto:** hoy las **OCs** de *talleristas* y de *proveedores de artículo terminado* (los que entregan mercadería acá) se arman por **Excel**. Existe el **módulo generador de OCs** en la app (usa `OC_Maximos` = máximos/proyección, escribe `Ordenes_Compra`) pero el dueño **todavía no confía** — falta validar que dé **lo mismo que el Excel**. *(Deuda aparte: pulir/validar ese generador contra el Excel antes de usarlo en serio.)* Además, hoy las OCs se generan **automáticamente los miércoles**. **La idea (2 partes):** **(1)** que, junto con la generación del miércoles, se emita un **reporte de la SEMANA PASADA**: por **proveedor × artículo**, el **% de entrega** = *entregado / pedido*. Fuentes: lo **pedido** = `Ordenes_Compra` (de la semana anterior); lo **entregado** = tablas de entregas según el tipo de proveedor — talleristas: `Entregas Tallerista Virgilio` / `Entregas_Tall_Todas`; proveedores de artículo terminado: `Entregas Prov AT` / `Entregas PS`. **(2)** **Alerta Telegram automática** para el/los proveedor(es)·artículo(s) que **no cubrieron** lo pedido (entregado < pedido), sobre todo los que ya venían con **faltante** y no se cubrió con lo pedido. **A definir al implementar:** ventana exacta de "semana pasada" (¿mié→mié?), cómo matchear OC↔entrega (proveedor + artículo + período), umbral de la alerta (<100% o <X%), y a qué chat de Telegram va. Encaja como extensión del cron semanal de OCs (reusar `tg_enqueue`/`tg_outbox_flush`).
>
> Nota: **v5.87 — Admin Stocks · popup de Pickeados: marca "🟢 Pickeando AHORA"**. Pedido del dueño: en el popup del pickeado de un artículo, ver además **en qué tanda se está pickeando el artículo AHORA** (no solo lo ya terminado). En `stkOpenEstadioArt` (solo `dep='separar_pedidos'`): trae las tandas **EP sin TP** de `getActivityStatus().pickingEnCursoBy` (que **no** están ya en `separar_pedidos` — el stock recién baja al TP, por eso todavía no figuran como "pickeado"), les resuelve las NPs (`_stkFetchNpsByTanda`) y cruza con `PPP_Base_Pedidos` (mismo `pidio` que ya usaba) para quedarse con las que **incluyen este artículo**. Si hay, pinta arriba una **caja verde** (`.stkpop-live`) "🟢 Pickeando AHORA (todavía sin terminar)" con **tanda · quién la pickea** (nombre vía `getEmpleadosNombres`, o "leg N") **· pidió N**. Si el artículo **no** tiene pickeado terminado pero sí en curso, igual abre el popup y muestra solo la sección verde. Solo lectura, no toca stock. Verificado headless (C90A pickeado + C99Z en vivo por Ramón → sección verde "pidió 7" + el pickeado C90A abajo) + suite verde.
>
> Nota: **v5.86 — Al TERMINAR ARMADO (TAP) el armador elige EN QUÉ UBICACIÓN queda cada NP**. Gemelo del `PUB` del picking (v5.78), pero **por NP**: al mandar **TAP**, antes de registrar, aparece un modal (`askArmadoUbicaciones`) que lista **cada nota de pedido de la tanda** (NP + razón social, traídas con `_stkFetchNpsByTanda` desde la PPP) con un **`<select>` de ubicación** por NP + un atajo **"Todas a la misma"** (los pedidos de una tanda pueden coincidir o no). Opciones fijas (`ARM_UBIC_OPCIONES`): **AB10, AB9, AB4, AB3, AA10, AA9, AA4, AA3, AC3, AC4, AC9, AC10, AD3, AD4, AD9, AD10**. Botones: **Listo** (habilitado cuando TODOS los NP tienen ubicación) → emite **1 evento `AUB` por NP** (`opcion='AUB'`, `texto=NP`, `descripcion=ubicación`, vía `emitArmadoUbic`, mismo patrón que PUB: encola + envía, id único, no persiste para legajo PRUEBA); **Omitir** (`{}`) → sigue el TAP sin registrar ubicaciones; **Cancelar** (`null`) → **aborta el TAP** (se puede re-mandar), igual que el PUB aborta el TP. Si la PPP no tiene los NP de la tanda, cae a **una** ubicación para toda la tanda (fallback, no bloquea el TAP). Enganchado en `send()` en la rama TAP (mismo lugar donde el TP dispara el PUB). Sin CHECK en `opcion` (entra directo, RLS anon ya permite el insert). Solo UI + evento (no toca stock). Verificado headless (modal 3 NPs → map correcto {np:ubic}, "Listo" se habilita al completar) + suite verde. `askArmadoUbicaciones`/`emitArmadoUbic` (y de paso `askPickUbicacion`/`emitPickUbic`) agregadas al smoke. **Follow-up:** mostrar la ubicación por NP en Facturación / carga de camión (hoy solo se registra).
>
> Nota: **v5.85 — Armado/Líos: atajo "líos de a N" (arma varios iguales de una)**. En el paso **Líos** del armado (`_compRenderLios`, vista "armar"), los operarios arman **líos de a 5** (o el pack que sea) repitiendo "poner 5 → Cerrar Lío" — para 20 cajas, 4 veces lo mismo. Ahora: barra **"⚡ Líos de a [N]"** (input `.cmpl-szinp`, default 5, `_comp.lioSize`/`_compSetLioSize`) + botón **⚡×N** en cada código (esquina sup-izq del cuadrado, `.cmpl-auto`) que arma de una **⌊rest/N⌋ líos de N** de ESE código (`_compLioAuto`: mete cada lío como `{items:[{cod,qty:N}],cajas:N}` a `liosArr` y descuenta `rest`). El resto (< N) queda en `rest` para cerrarlo a mano o como suelta. No cambia el modelo de líos (mismos `liosArr`/TAL); solo evita la repetición. `stopPropagation` para no chocar con el +1 del cuadrado. Verificado con la suite.
>
> Nota: **v5.84 — "Terminar" armado pide CONFIRMACIÓN (salir ≠ terminar) + faltante-auto REVERTIDO**. **(1)** `compTerminar` ahora pide `confirm()` explícito antes de guardar ("¿Terminaste de armar la tanda X? … NO vas a poder volver a entrar"). **Por qué:** un armado se completó por un toque en "Terminar" (con los líos ya hechos) y la tanda quedó **trabada** por el candado anti-doble-armado (v5.72) — el operario no podía re-entrar a separar. **Aclaración del diagnóstico:** NO había un "guardar al salir"; `compTerminar` (único que guarda Entregas/TAL) está solo en el botón "Terminar" con guardas — el confirm evita el toque accidental. *(Caso real: C87H quedó armada por accidente; se limpiaron sus Entregas+TAL a mano para destrabar y el operario la rehízo.)* La confirmación va **después** de las guardas de líos y **antes** del candado/guardado (el test `comp-doblearmado` sigue verde: candado antes de líos). **(2)** El **faltante automático (v5.83) quedó APAGADO** (cron `detectar-faltantes-llegaron` desprogramado) porque el aviso mostraba TODO el faltante (ej. 280+534) en vez de solo el código que llegó (534) → confundía. Se **restauró el botón manual "📢 Avisar faltante llegó"** en la pantalla del supervisor. La función server-side sigue existiendo pero sin cron. Pendiente: que el aviso liste solo el/los código(s) que realmente llegaron a a_guardar, y recién ahí reactivar.
>
> Nota: **v5.83 — Faltante que llegó = AUTOMÁTICO (se elimina el botón manual)**. Antes el supervisor apretaba **"📢 Avisar faltante llegó"** (`showFaltAvisar`→`faltante_tarea_crear`). Ahora es **automático**: función server-side **`detectar_faltantes_llegaron()`** (cron **jobid 30, `*/2 * * * *`**, cada 2 min) que, para cada **NP con faltante abierto** (`Entregas_Virgilio.cajas_falto>0`), **no facturado** (no en `Facturacion_NP`) y **sin tarea activa** (`Faltantes_Tareas` estado pendiente/asignado), cuyo/s código/s tenga **cualquier cantidad** en **`a_guardar`** (`Movimientos_Stock` deposito='a_guardar', saldo>0; match normalizado + tolerante a la E), crea la tarea (`faltante_tarea_crear`, idempotente por NP) **y avisa por Telegram** (dedup por NP/día). Eso dispara el **pop-up en los celulares** de los operarios (poll `faltPoll` de v5.71, cada 6s) → uno se lo asigna y va directo a **Completar Pedido**. Es decir: el flujo quedó en **un solo camino** (Completar), abierto por el aviso automático; el operario ya no aprieta nada para "avisar". **Cliente:** se sacó el botón "📢 Avisar faltante llegó" de la pantalla del supervisor (`showFaltAvisar`/`faltCrear`/`faltEnsureAvisar`/`_faltAvData` quedan como código muerto, se pueden limpiar). `SECURITY DEFINER`, revoke public / grant service_role. Dry-run al implementar: 1 caso real (NP 98017 · C87E, faltan 280×2+534×1, el **534 llegó** con 6 en a_guardar). El pop-up, la asignación atómica y el autocierre (v5.71) no cambian.
>
> Nota: **v5.82 — Admin Stocks: más columnas clickeables + card más ancho (sin scroll lateral)**. Extiende v5.81. En la tabla por artículo ahora son clickeables (`.stk-pick-cell`): **Pickeados** y **A facturar** → `stkOpenEstadioArt(cod, dep)` (generaliza v5.81: junta el depósito por ref; ref con letra = **tanda** → NPs del PPP; ref numérica = **NP directo** de CP/RC → se muestra sola con su razón social; cruza `PPP_Base_Pedidos` para marcar "· pidió N"). **Excedente** → `stkOpenExcedenteArt` (ubicaciones desde `Movimientos_Stock.ubicacion`, misma lógica de atribución que el export de excedentes). **Racks** → `stkOpenRacksArt` (posiciones desde `Racks_Planimetria`, conteo físico por sector). Además: el card del admin de Stocks pasó de `max-width:880px` a **`min(1500px,97vw)`** para que la tabla ancha **no tenga scroll lateral** en el monitor; el popup de detalle (`.stkpop-card`) a `min(760px,96vw)`. Solo lectura. Verificado con la suite.
>
> Nota: **v5.81 — Admin Stocks: click en el PICKEADO de un artículo → qué NPs lo tienen**. En la tabla por artículo, la celda de la columna **Pickeados** (`separar_pedidos`) ahora es **clickeable** (`.stk-pick-cell`, `stopPropagation` para no abrir el detalle de movimientos de la fila). Abre un popup (`stkOpenPickeadoArt`, reusa `_stkPopShell`) que: (1) junta los movimientos `separar_pedidos` de ESE artículo por tanda (misma ventana corte/asOf que la tabla), (2) resuelve tanda→NPs con `_stkFetchNpsByTanda` (PPP), (3) cruza con **`PPP_Base_Pedidos`** (`pedido`,`articulo`,`cajas`) para marcar **qué NP pidió ese artículo** y cuántas cajas ("· pidió N", en verde). Muestra por tanda las NPs (las que pidieron el artículo; si no hay match cae a todas las NPs de la tanda). Complementa el "📋 Pedidos por estadio" global (que es por tanda, no por artículo). Solo lectura. `_stkNormCod` normaliza (mayúsculas, sin espacios, sin ceros a la izquierda). Verificado con la suite.
>
> Nota: **v5.80 — Facturación (NPs a FC): faltantes en COLUMNA aparte, solo la distribución**. Antes el faltante salía como badge **dentro** de la Razón Social ("⚠ FALTA N cj: cod×n, …"). Pedido de la operadora: que sea una **columna separada** y que muestre **solo la distribución** por artículo (`cod×faltó`), **sin** el total "FALTA N cj" (lo usa para facturar por lo entregado). Cambios en `facRender`: nueva columna **Faltantes** (th, entre Razón Social y Dirección) con `facFaltDist(np)` (= `items.map(cod×faltó).join(", ")`, sin total ni truncado); se sacó `facFaltBadge` de la celda de Razón Social (queda solo el nombre + el aviso de equivalencia + el ⏳ "completando" si hay tarea en progreso). CSS `.fac-falta-col` (wrap, sin clip, rojo). `facFaltBadge` sigue existiendo (lo usa la consulta NP). Test `fac-falta-filter.cjs` actualizado (valida la distribución en la columna, sin el total, y que la Razón Social ya no lleva el badge). Verificado con la suite.
>
> Nota: **v5.79 — Fix: la dirección del cliente (v5.77) no aparecía en armados RETOMADOS**. La dirección se leía de `n.dir`, que se setea al **construir** las `nps` (v5.77). Pero cuando el wizard se abre **retomado** (`_compRestore`, armado en curso guardado ANTES de v5.77), las `nps` guardadas no tenían `dir` → no mostraba nada (aunque la PPP sí tiene la dirección, ej. C87H/98153 = "R DE ESCALADA 3630"). Fix: `showCompletarWizard` arma un mapa **`_comp.dirByNp`** (NP→dirección) desde la PPP **fresca** (`entry.pedidos`, que ya trae `direccion` vía `fetchMonitorFromSupabase`); `_compSepPedido` y `_compSepMatrix` usan `_comp.dirByNp[n.np]` con fallback a `n.dir`. Así la dirección aparece **también en armados retomados**, no solo en los nuevos. Solo UI. Verificado con la suite.
>
> Nota: **v5.78 — Al TERMINAR PICKING (TP) el operario elige DÓNDE dejó lo pickeado**. Nuevo evento **`PUB`** (Picking UBicación). Al mandar **TP**, antes de registrar, aparece un modal (`askPickUbicacion`) con opciones fijas: **Mesa 1, Mesa 2, Carro, AA3, AA4, AA9, AA10, AB3, AB4, AB9, AB10** (`PICK_UBIC_OPCIONES`). Elegir una → sigue el TP y emite el evento **`PUB`** (`opcion='PUB'`, `texto=tanda`, `descripcion=ubicación`, vía `emitPickUbic`, mismo patrón que SSG: encola + envía, id único, no persiste para legajo de PRUEBA). Cerrar el modal **aborta el TP** (se puede re-mandar). ⚠ La ubicación va en un evento **aparte**, NO en el `texto` del TP, porque ese se usa como **clave de tanda** en `getActivityStatus`/lock (meterle `|ubic` rompería el emparejado EP/TP). **Se muestra** en el wizard de armado (**Completar · Separar**): `showCompletarWizard` trae el `PUB` más reciente de la tanda (`_comp.pickUbic`) y `_compRenderSep` lo pinta como chip **"📍 Dejado en: X"** debajo de "en mesa" (`.csep-ubic`). Sin CHECK en `opcion` (entra directo); RLS de eventos ya permitía el insert anon. Solo UI + evento (no toca stock). Verificado con la suite (sin errores de página). Posible follow-up: mostrarlo también en el monitor / lista de tandas.
>
> Nota: **v5.77 — Completar/Separar: reclasificar arriba de "en mesa" + dirección del cliente**. En el wizard **Completar · paso 2 (Separar)** (`_compRenderSep`): (1) el link **"✎ reclasificar"** pasó a estar **arriba de "N en mesa"** (misma columna izquierda `.csep-mesawrap`), el toggle Modo picking/Por pedido queda a la derecha. (2) Se muestra la **dirección del cliente** (columna `direccion` de la PPP, ya venía en `entry.pedidos[].direccion` de `fetchMonitorSheet`; se agregó `dir` a `_comp.nps`): en **vista Por pedido** (`_compSepPedido`) a la **derecha de la razón social** (`.csep-dir`, `margin-left:auto`); en **vista Modo picking** (`_compSepMatrix`) **chiquita arriba de cada NP** en el encabezado de columna (`.csep-mxdir`, 8.5px). Solo UI (no toca datos ni stock); si un pedido no tiene dirección, no muestra nada. Verificado con la suite (checkhtml + comp-doblearmado, sin errores de página).
>
> Nota: **v5.76 — Picking al stock = UN SOLO escritor (el cron). Fin del doble-conteo por race.** **Bug encontrado (investigando "el 031 muestra 20 pickeadas y el pedido es 10"):** el picking se cargaba al stock desde **DOS fuentes** — el cliente `stockBajaPicking` (TP, "fast path") y el cron server-side **`reconciliar_pipeline_stock()`** (jobid 22, `*/10`, la "red de seguridad" para la app vieja TWA). Los dos deduplican por `tipo='picking' & ref=tanda`, **pero el guard es chequear-y-después-insertar (NO atómico)** y el POST del cliente pasa por la cola offline (`vir_stock_pend`), así que el cron caía en la ventana entre el chequeo del cliente y su escritura → **duplicaba** (`separar_pedidos` +2×, góndola −2×). Se materializó en **4 tandas: C81B, C87A, C87F, C87H** (~486 cajas infladas). **Fix (código):** el cliente `stockBajaPicking` **ya NO escribe stock** — quedó solo detectando "picking sin stock en góndola" para el aviso **SSG** (Telegram). El **cron es la única fuente** del picking (cubre app nueva y vieja porque deriva de los eventos PKC/TP). Costo: "Pickeados"/"A Facturar" aparecen hasta ~10 min después (cadencia del cron), ya no instantáneo. **Fix (datos):** borradas las filas de picking del **cliente** (legajo numérico) en esas 4 tandas → góndola queda en el pick único del cron (ej. C87H `separar` 358→179; el 031 vuelve a 10). **C87F/C87H** (solo pickeadas) quedaron perfectas. **C81B/C87A** ya estaban **facturadas** (el `separado` había movido el monto duplicado a `a_facturar` y salió), así que borrar solo el picking dejó `separar_pedidos` **negativo** (−104/−73); se cerró con un **ajuste compensatorio** por artículo (`tipo='ajuste_doble_pipeline'`) → separar y a_facturar en 0, góndola en el pick único. Las **C58B/C58C/C58D** NO se tocaron (no eran doble: separar del cron + góndola del seed, una fuente por depósito). **2ª parte (dedup atómico + excedente-first, hecho):** (1) **Excedente-first portado al cron** (migración `reconciliar_pipeline_stock_excedente_first`): ETAPA 1 baja **primero de excedente** y el resto de góndola (window por artículo para no sobre-descontar el excedente si dos tandas del mismo art caen en la misma corrida). **No se perdió** la lógica que tenía el cliente. Verificado con caso sintético (art con exc=5 y dos tandas → drena exactamente 5, sin pasarse). (2) **Índice único parcial `mov_stock_pipeline_dedup`** = `UNIQUE (upper(trim(ref)), upper(trim(cod_art)), deposito, tipo) WHERE tipo IN ('picking','separado','facturado')` → **una sola fila por (tanda, art, depósito, etapa)**: mata la race de las **3 etapas** a nivel DB (no solo picking). Las 3 etapas del cron ahora usan **`ON CONFLICT DO NOTHING`**; el cliente que todavía escribe `separado`/`facturado` (hasta el merge) choca y su 4xx se traga solo → dedup garantizado **incluso antes de deployar el front**. `tipo` va **en la clave** porque en `separar_pedidos` conviven `picking`(+) y `separado`(−). Se verificó que no había duplicados previos (el índice creó limpio) y que el cron sigue corriendo `ok etapa1=0 etapa2=0 etapa3=0`. La definición viva del cron está en la migración (doc de diseño en `sql/reconciliar_pipeline_stock.sql`).
>
> Nota: **v5.75 — Reserva ATÓMICA de tanda (cierra la ventana de carrera de v5.74)**. Tabla nueva **`Tandas_Lock`** (`PK (tanda, fase)`, `fase` = picking|armado, `legajo, nombre, ts`). **RLS: anon solo SELECT**; escrituras por RPC SECURITY DEFINER (anon,authenticated; PUBLIC revocado): **`tanda_reservar(tanda,fase,legajo,nombre)`** = `INSERT … ON CONFLICT (tanda,fase) DO NOTHING` → **gana el primero**; devuelve SIEMPRE el dueño que quedó (para avisar al que pierde); suelta reservas abandonadas (>10h). **`tanda_liberar(tanda,fase,legajo)`** = borra el lock (solo el dueño) al terminar. **Cliente:** helpers `tandaReservar`/`tandaLiberar`; en `send()`, última compuerta antes de emitir **EP/AP** → reserva atómica: si el dueño que vuelve **no soy yo**, bloquea ("⛔ ya la está pickeando/armando Fulano"). Al **TP/TAP** libera la reserva. Falla **ABIERTO** (sin red no bloquea) y el legajo de PRUEBA no reserva. Con esto, aunque dos aprieten Enviar al mismo tiempo, la PK garantiza que **solo uno** arranca. Convive con el lock por eventos de v5.74 (que sigue escondiendo las tandas tomadas de la lista). Test `tanda-lock.cjs` extendido (reserva devuelve dueño + cableado send reserva/libera). Verificado en base: 104 gana, 55 pierde y ve a 104; solo el dueño libera.
>
> Nota: **v5.74 — Exclusividad de tanda: no pueden empezar DOS el mismo picking/armado**. `getActivityStatus` ahora arma dos mapas nuevos: **`pickingEnCursoBy`** (tanda con EP sin TP → legajo que la arrancó) y **`armadoEnCursoBy`** (AP sin TAP → legajo). Con eso: **(1)** la lista de tandas para **AP** (`populateTandasList` modo `pickingDone`) además de excluir las TAP-terminadas ahora **esconde las que otro ya está armando** (`!armadoEnCursoBy`) — antes solo miraba TAP, por eso se podían armar dos la misma (lo de la NP 98114). El EP (`notStarted`) ya excluía cualquier picking arrancado. **(2)** En `send()`, antes de emitir **EP o AP**, un chequeo **fresco** (`getActivityStatus(true)`, sin cache) bloquea si **OTRO** operario (legajo distinto) la tiene en curso: "⛔ La tanda X ya la está pickeando/armando Fulano". Lo propio se maneja como antes (v5.26 reabre tu propio AP). Tras emitir EP/TP/AP/TAP se invalida el cache de actividad (`_activityStatusTs=0`) para que la próxima lista salga fresca. `getActivityStatus(force)` acepta forzar el refetch. ⚠ **Es un lock blando** (falla ABIERTO si no hay red; y queda una ventana de carrera sub-segundo si dos aprietan Enviar casi al mismo tiempo, porque EP/AP son eventos, no un claim atómico). Si se quiere 100% a prueba de carrera habría que un claim atómico por RPC (como `faltante_tarea_asignar`). Test `tanda-lock.cjs` (cálculo de los mapas + cableado en send/populateTandasList).
>
> Nota: **v5.73 — El candado anti doble-armado también bloquea al ABRIR**. Además del bloqueo en `compTerminar` (v5.72), ahora `showCompletarWizard` chequea `_compTandaYaArmada(tanda)` **antes de restaurar/abrir**: si la tanda ya tiene Entregas (ya fue armada), **ni se abre** el armado (mismo aviso). El "Seguir armado" de una tanda **en curso** sigue funcionando porque un armado sin terminar todavía **no tiene Entregas** (solo avance en localStorage) → el chequeo da false. Test `comp-doblearmado.cjs` extendido (cablea el candado también en `showCompletarWizard`, antes de `_compRestore`).
>
> Nota: **v5.72 — Candado anti doble-armado + fix de datos NP 98114**. **Bug encontrado:** la NP 98114 (tanda D02A) se **armó dos veces** → quedaron **2 filas de cada artículo** en `Entregas_Virgilio` (32 filas / 16 arts). Como el 546 tenía 2 filas de faltante, se pudo **completar (CP) dos veces**: CP1 (legajo 8, correcto, tomó los 60 que llegaron de `a_guardar`) + CP2 (legajo 0, el "Completar Pedido" admin, tomó 60 de más de góndola) → último TAL con **`T=546X120`** (debía ser 60), `a_facturar` 546 = 120, góndola −60. **Fix de datos (a mano, NP no facturada):** borrados los 2 movimientos del CP2 (revierte góndola y el +60 de más), borrado el TAL malo (`T=546X120`, legajo 0) → el último TAL vuelve a ser el bueno (`T=546X60`), borrado el evento CP erróneo, y **dedup de `Entregas_Virgilio`** (32→16, se deja la fila de menor id por artículo). Estado final verificado: 16 filas, lío 546×60, `a_facturar` 546=60, góndola neta 0. **Candado (código):** nuevo `_compTandaYaArmada(tanda)` (¿ya hay filas en `Entregas_Virgilio` para esa tanda?) + guarda en `compTerminar`: antes de mandar líos/guardar, si la tanda **ya fue armada** → **bloquea** ("La tanda ya fue armada, no se puede armar de nuevo") en vez de duplicar; más `_comp._terminando` contra doble-click. Ante error de red el chequeo devuelve false (no traba el laburo). Test `comp-doblearmado.cjs` + `_compTandaYaArmada` al smoke. ⚠ Pendiente estructural (aparte): CP suma a `a_facturar` con `ref=NP` y facturación limpia por `ref=tanda` → el 546 va a dejar un residuo de 60 en `a_facturar` al facturar (mismo desfasaje que Dorinka; opciones A/B/C/D siguen esperando).
>
> Nota (backend Supabase, sin bump de app): **Alerta Telegram 16:30 "facturar HOY → salen MAÑANA"**. Cron **`falta-fact-1630-manana`** (jobid 29, `30 19 * * *` = **16:30 ART**, pg_cron en UTC) → `notificar_falta_facturacion_1630_telegram()`: lista las **NP** cuya `PPP_Programacion_Diaria.fecha_entrega = mañana`, que ya están **separadas (evento `TAP`, últimos 5 días)** y **NO** están en `Facturacion_NP` (o sea, sin apretar el botón de facturar). Mensaje = "🧾🚨 FACTURAR HOY — salen MAÑANA (DD/MM)" + una línea por pedido `• NP <np> · <tanda> · <cliente>` (cap 60, luego "…y N más"), dedup `faltfact1630_YYYYMMDD`, al chat por default; si no hay ninguno, no manda nada. Reusa `tg_enqueue`/`tg_outbox_flush`. ⚠ **Convive** con la alerta previa **`falta-fact-manana`** (jobid 7, `0 21`=18:00 ART) que manda un **resumen por tandas** de lo mismo (dedup distinto → las dos pueden mandar). La lógica del filtro es idéntica a `notificar_falta_facturacion_telegram('manana')`; la nueva sólo cambia la hora (16:30) y **lista las NP** en vez de sólo las tandas.
>
> Nota: **v5.71 — FALT · Faltante que LLEGÓ → completar (coordinación en vivo entre celulares)**. Pedido del dueño: cuando llega mercadería de un faltante que **todavía no salió ni se facturó**, que a los celulares de los que están en Virgilio ese día les salte un **pop-up grande**; que **uno solo** se lo asigne (atómico); complete la caja; y que a los demás les diga "ya la toma Fulano". Cuando la caja queda en el pedido, Marianela la ve como siempre y se apaga el faltante. Y si ella va a facturar en el medio, un aviso **amarillo**. **Datos (Supabase):** tabla nueva **`Faltantes_Tareas`** (`np, cod_cliente, razon_social, tanda, articulos jsonb [{cod,falto}], cajas, estado [pendiente|asignado|completado|cancelado], asignado_legajo/nombre/ts, creado_por/ts, completado_ts, fecha`). **RLS: anon solo SELECT** (para pollear); toda escritura por **RPC SECURITY DEFINER** (anon,authenticated): `faltante_tarea_crear` (idempotente por NP), `faltante_tarea_asignar` (**UPDATE atómico `WHERE estado='pendiente'`** → gana el 1º; devuelve la fila para que el que pierde vea quién la tiene), `faltante_tarea_completar`, `faltante_tarea_cancelar`, `faltante_tarea_soltar`. **Cliente:** el supervisor dispara desde **botón "📢 Avisar faltante llegó"** (panel `showFaltAvisar` → lista faltantes de `cpLoadFaltantes` agrupados por NP, excluye los que ya tienen tarea activa, `faltCrear` llama al RPC). En la **botonera** del operario un **poll cada 6s** (`faltPollStart`/`faltPoll`, arranca en `goToOptions`, solo si está en `optionsScreen` y **no** es legajo 0/1) → pop-up (`#faltPopup`, clases **`ftk-*`** —OJO: `.falt-*` ya existía en la vista Faltantes admin, por eso el prefijo distinto—): estado **pendiente** = "¡Llegó un faltante! ¿Quién lo hace?" + "Me lo asigno"/"Ahora no" (snooze 90s); **asignada a mí** = detalle (NP, cliente, artículos) + "Completar ahora" (abre **CP**, reutiliza todo el flujo lío/re-emitir TAL) / "Ya lo completé" / "Soltar"; **la tomó otro** = "Ya lo está haciendo X" (5s). **Autocierre:** en `cpConfirm`, tras bajar el faltante, `faltMaybeCompletar(np)` chequea si la NP quedó sin `cajas_falto` → marca la tarea `completado`. **Marianela (Facturación):** `facFetchTareas()` (Map np→tarea activa, en el `Promise.all` de la carga) → aviso **amarillo** `.fac-progreso-badge`/`tr.fac-en-progreso` ("⏳ Completando · faltan X cj · lo hace Fulano"), distinto del rojo (rojo = salió corto); y `facTickNP` **pregunta antes de facturar** si la NP está en progreso. Estado del pedido = `cajas_falto` en vivo (completo / faltan X por artículo). Nuevas funciones al smoke + test headless `falt-tareas.cjs` (pendiente→asignar gano/pierdo, badge facturación, guard legajo 0). **Nota de diseño:** granularidad **por NP** (una llegada que completa varios pedidos = varios avisos); pop-up **posponible** (no bloquea); le aparece a **todos los logueados en Virgilio** (no solo a los que ya laburaron). **Seguridad** (auditada, OK): `anon` solo LEE `Faltantes_Tareas` (probado impersonando `anon`: INSERT/UPDATE/DELETE directos bloqueados por RLS); los 5 RPCs son `SECURITY DEFINER` con `search_path=public`, tocan **solo** esa tabla; hardening aplicado → `REVOKE EXECUTE … FROM PUBLIC` (quedan `anon`/`authenticated`), `CHECK estado IN (pendiente/asignado/completado/cancelado)`, y `faltante_tarea_crear` **auto-purga** las cerradas de +14 días (sin cron).
>
> Nota: **v5.70 — Faltantes VISIBLES en Facturación (bug de clip) + chip/filtro "solo con faltante"**. Reporte del dueño: "en Facturación no hay cómo le aparecen los faltantes a la operadora" — y ella entra a facturar **antes** de que el pedido salga, justo para ver el faltante de cada NP. **Causa raíz (bug real, no cache):** el badge `⚠ FALTA … cj` existía desde v5.36 y se renderizaba en la celda Razón Social, **pero `table.fac-np-tbl td` tenía `overflow:hidden; white-space:nowrap`** y la columna es fija (175px) → el badge quedaba en el mismo renglón que la razón social y **se cortaba fuera del borde: NUNCA se veía**. (Por eso "refrescá" no lo arreglaba.) Fix: la celda ahora es `td.fac-rs-cell{white-space:normal;overflow:visible}` con el nombre en `.fac-rs-name` (trunca en su renglón) y los avisos (⚠ faltante / 🧾 equivalencia) **bajan a su propio renglón y se ven**. Timing verificado: `cajas_falto` se escribe en **`compTerminar`** (armado, línea ~7549-7555), **antes** de facturación → el dato ya está disponible cuando ella factura. Además, **chip rojo "⚠ Con faltante: N"** en la toolbar (`facChipFalt`/`facCntFalt`) que es **clickeable** → `facToggleSoloFalt()` filtra la tabla para ver **SOLO** las NPs con faltante (estado `_facSoloFalt`, se resetea si no hay ninguna). `facRender` ahora setea `_facLastTandas = tandas` al entrar (para que el toggle redibuje el mismo set). Recordatorio: el aviso ⚠ + el `confirm()` de "facturá por lo ENTREGADO" al tocar ✓ ya existían (v5.36) y siguen. Datos hoy: 108 NPs con faltante histórico (1002 cajas), **10 pendientes** de facturar. Nuevo test `fac-falta-filter.cjs` (chip+filtro **y** regresión del clip: la celda no puede volver a `nowrap`/overflow-hidden). `facFaltBadge`/`facToggleSoloFalt` en smoke.
>
> Nota: **v5.69 — IR con paso de revisión ("Revisar → Confirmar / ← Volver")**. Pedido del dueño: en el módulo **📥 Ingreso a Racks** poder **revisar antes de confirmar** (evita cargar mal, como el X7/574E que se cargó con la cantidad equivocada). El botón del formulario ya **no ejecuta directo**: dice **"Revisar carga →"** y llama `irRevisar()` (valida cod+cajas+sector libre; si falta algo no avanza) → `_ir.confirming=true` → `irRenderConfirm()` muestra un **panel de resumen** (código, artículo, sector —marca "➕ suma a X" si el sector ya tiene ese código—, masters, **cajas** resaltadas, empresa) con dos botones: **"← Volver"** (`irVolver()` → `confirming=false`, vuelve al formulario con **los datos intactos** para corregir) y **"✓ Confirmar carga"** (verde, `irCargar()`, el que realmente escribe planimetría+saldo por RPC). `irCargar` limpia `confirming` al terminar. Sólo UI/estado — no cambia el RPC ni el stock. Nuevas `irRevisar`/`irRenderConfirm`/`irVolver` + CSS `.ir-rev*`/`.ir-back`/`.ir-confirm`; agregadas al smoke + test de flujo headless (form→revisar→panel→volver→datos intactos + guard sin sector). **Dato (sin bump)**: corregido **X7/574E** en `Racks_Planimetria` (venía `master_cajas=54`, era **45**; el inner 540 ya estaba bien: 45×12=540; saldo sin cambio).
>
> Nota: **v5.68 — Candado legajo de PRUEBA + súper muestran cajas en Facturación + limpiezas**. **(1) Legajo 0/1 no persiste** (regla del dueño; lo que rompió el 542): `esLegajoPrueba(leg)` (true para "0"/"1") + `esOperadorPrueba()` (mira `#legajoInput`, el legajo logueado). Candado al inicio de `enqueueReport`, `stockMove` y `trySendOneReport` → si el **operador logueado** es 0/1, **NO sube nada** a Supabase (ni eventos ni stock). Se chequea el operador logueado, **no** la fila/payload, así las acciones de **sistema/admin** que hardcodean `legajo:"0"` (racksAprobar, ajustes, CRA/PPE) siguen subiendo. ⚠ Cubre eventos+stock (el 95%); las cargas directas por RPC de racks (IR/Mover) y `Envasar_Ubicaciones` (EA) NO pasan por esos 3 → quedan afuera (superficie chica). **(2) Súper → cajas en la columna Líos** (Facturación): los súper arman por etiqueta (TAL con líos=0) → antes mostraban 0. Ahora si el pedido es súper (`zona` ~ "Super" o `pppZonaDeBarrio(barrio)="Super"`), la celda muestra el **total de cajas** (`facFetchCajas()` = Σ `cajas_pedidas` de `Entregas_Virgilio` por NP, vía `supaFetchAll`, cache 30s) con sufijo "cj"; los no-súper siguen con los líos del TAL. **(3) Datos (sin bump)**: 505 → excedente **N5 (500) / N6 (500)** cargado (físico); **dedup `Racks_Planimetria`** (borradas 8 filas libres duplicadas AD07/W01/X02/Y01, unificado Z07 589E 6/72; queda Y14 con 2 filas = palet mezclado 954E+983E, correcto); **542 cerrado** (borrado el CP de prueba leg0, la caja real salió con el pedido 97870 —que salió hace 15d—, guardada la caja recibida, `cajas_falto=0`; queda góndola −1 = descuadre real a conteo). Nuevas 3 funciones en smoke + check funcional `pruebaOk`.
>
> Nota: **v5.67 — 📥 IR · Ingreso a Racks (botonera operario)**. Faltaba el flujo para **dar de ALTA lo que llega** a racks (importaciones) — solo estaban **Mover** (`racks_plani_mover`) y **Bajar** (`racks_plani_descontar`). Nuevo botón **IR** en la botonera (`row3`, secundario, cian `.box[data-code="IR"]`) → `showIngresoRacksModal(legajo)`. **Un palet por vez**: código (muestra el **CxM** del maestro `Articulos Virgilio X Tallerista.Cajas_x_Master`, o derivado de la planimetría como `rkbFetchCxM`, y **calcula las cajas = masters × CxM**), masters, cajas (inner, editable), **sector** (sugiere uno **LIBRE** —dedup + excluye zonas insumo `_racksZonaInsumo`— editable, valida). Al cargar guarda **planimetría + saldo** vía **RPC nuevo `racks_plani_ingreso(p_sector,p_cod,p_master,p_inner,p_emp,p_legajo)`** (SECURITY DEFINER: la anon key **no puede** escribir `Racks_Planimetria`; sí `Movimientos_Stock`). El RPC: sector **libre** → ocupa; **mismo código** → **suma** master/inner; **otro código** → devuelve `ocupado:<cod>` (rechaza). Inserta `Movimientos_Stock` deposito='racks', tipo='ingreso', unidad='inner'. Emite evento **IR** por palet (`texto = COD|SECTOR|<m>M|<i>C`). Funciones `showIngresoRacksModal`/`irRender`/`irFetchCxM`/`irSetCod`/`irSetM`/`irChgM`/`irSetI`/`irChgI`/`irSetSec`/`irSetEmp`/`irCargar`/`irEmitEvent`/`closeIR`. Verificado: RPC round-trip (alta 1/8 + suma 2/16 = 3/24, saldo 24; guards falta-datos y ocupado-por-otro; test limpiado) + render headless (CxM, masters→cajas, chips libres, suma/warning/bloqueo, LK/CH). Nuevas en smoke. ⚠ **Dato pendiente**: `Racks_Planimetria` tiene **sectores duplicados** (AD07 ×4, W01/X02 ×3, Y01/Y14/Z07 ×2 — del seed) — el IR los dedup en la sugerencia y el RPC usa `limit 1`, pero convendría deduplicar las filas. En la solapa **📊 Stocks** (arriba, bajo Stock/Ingresos/Salidas) un botón `stkExportExcedentes()` que baja un **`.xls`** (tabla HTML con MIME `application/vnd.ms-excel` + BOM UTF-8 → lo abre Excel; **sin librería**, cliente-side, no toca Supabase) del depósito `excedente` **ORDENADO POR UBICACIÓN**: **una fila por (ubicación, código)** — si un código está en varias ubicaciones **se repite** (ej. 501 → `N3` 330 y `N11` 416). Columnas **Ubicación · Código · Cajas** + TOTAL. Lógica: neto por `(cod, ubicacion real)` desde `_stk.movs` (respeta corte/asOf igual que `stockComputeSaldos`: `inicial` siempre cuenta, se filtra lo anterior al corte y lo posterior al asOf); las **bajas de picking SIN ubicación** (~127 cajas — el picking de excedente NO guarda de qué ubicación saca, otro gap) se **atribuyen** al código si tiene **una sola** ubicación (exacto), y quedan sin atribuir si tiene varias (esos códigos —587/723/731— leen un poco alto). Orden natural por ubicación (N3, N11, P1…P30). Al documentar: **44 filas / 2104 cajas**. Nueva en smoke. (v5.65 fue la 1ª versión del botón, por código con descripción — reemplazada por ésta.)
>
> Nota: **v5.64 — 🐛 BUG CRÍTICO: el guardado a EXCEDENTE (MG) nunca persistió**. Un operario guardó 416 cajas del 501 a excedente (ubic N11), la app dijo "✓ Guardado", pero al reabrir MG seguían las 1003 en "a guardar" — **no descontó nada ni cargó el excedente**. Causa: **PostgREST rechaza un bulk insert si los objetos del array no tienen todos las MISMAS claves** (400 "All object keys must match"). En `mgConfirmar` la fila del **excedente lleva `ubicacion`** y la de **`a_guardar`/góndola no** → claves mezcladas → **400**. Y `stockMove` tenía `if (r.ok || (r.status>=400 && r.status<500)) return` → **se tragaba el 4xx como si fuera éxito** y perdía TODO el guardado (sin reintento, sin aviso). Verificado en datos: **`guardados_excedente` = 0 histórico** — jamás se guardó una caja a excedente por MG (el excedente solo tenía stock por `inicial`/`traslado`). **Fix**: nuevo `_stockNormRows(rows)` normaliza todas las filas al **union de claves** (faltante = `null`) antes del POST, en `stockMove` y `stockFlushPend`; y el 4xx ahora se **loguea en consola** en vez de tragarse mudo. Test `normOk` en smoke (filas mezcladas a/exc → mismas claves, `ubicacion` null vs "N11"). ⚠ **Recuperación de datos pendiente**: los guardados a excedente perdidos no dejan rastro (no emiten evento); el del 501 (416 a N11) se puede reponer a mano si el dueño confirma.
>
> Nota: **v5.63 — Ubicación para "para envasar" (módulo EA), separada del mapa de racks**. Regla del dueño: **`racks` y `para envasar` son estados distintos aunque compartan el estante físico** — *racks* = terminado que va a **góndola**; *para envasar* = mercadería que tiene que **salir** a envasarse. Pueden estar en el mismo sector, pero la app los trata aparte. Hasta ahora `para_envasar` no tenía ubicación (solo saldo). Se agregó: **tabla nueva `Envasar_Ubicaciones`** (`id, cod_art, sector, master_cajas, innercajas, emp, updated_at`; único `(cod_art, sector)` para upsert; RLS ON + policy `eu_all` ALL anon+authenticated, mismo patrón que `Racks_Ordenes`/`Stock_Config`) — **es solo mapa, NO toca ningún saldo** (el stock sigue en `Movimientos_Stock` `deposito='para_envasar'`, se entrega por EA). En el modal **EA** cada código ahora muestra **📍 chips con su(s) sector(es) · cajas** y un **+ ubicación**; tocarlos abre un editor inline (sector + master + cajas) para **cargar/mover/borrar** dónde está (`eaFetchUbics`/`eaRenderEdit`/`eaEditUbic`/`eaEditSet`/`eaUbicSave`/`eaUbicDelete`/`eaUbicCancel`; endpoint `SUPABASE_ENVASAR_UBIC_ENDPOINT`; POST upsert `on_conflict=cod_art,sector` para alta, PATCH por id para mover, DELETE para sacar; clave por `_cpNorm`). **Importante — NO usar `Racks_Planimetria` para para-envasar**: ese mapa es solo del depósito `racks` (lo filtran por `racks>0` "bajar de racks", el admin "Stock en racks" y la auto-bajada; meter un para-envasar ahí lo trataría como stock de racks/camino a góndola y saldría en "Mover mercadería"). Semilla: **035E → Y29 (11 MC / 44 cajas)** — venía de "se movió de Y27 a Y29"; Y27 nunca estuvo en el sistema (el Conteo Definitivo del 8/7 lo pasó a `para_envasar` y lo sacó del mapa de racks). Verificado headless (chips, editor con value del sector, alta sin sector = guardar deshabilitado, mover normaliza a mayúsculas, borrar, volver a la lista) + checkhtml + suite completa. Nuevas 7 funciones en smoke. Advisor: la policy `eu_all` sale `rls_policy_always_true` (WARN) = el patrón deliberado de la app (284 policies iguales); sin ERROR.
>
> Nota: **server-side (sin bump) — ⚠ Máximos de OC ahora SOLO Loke (no mezclar Chef)**. Hallazgo grande (lo destapó el dueño mirando el 809E): la proyección (`proyeccion_madre` → máximos de OC de Virgilio) se calculaba **mezclando las ventas de las dos empresas** de `sales_lines` (`lk` y `chef`) — `fn_proyeccion_madre` no filtra empresa. Como **la góndola de Virgilio es solo Loke** (marcas **Loke = códigos 101-193** + **Loeke = el resto**, ambas venden por `lk`; **Chef = empresa `chef`**, 2 góndolas aparte todavía NO cargadas en `Capacidad_Sector`), los máximos de ~114 códigos "duales" estaban **inflados por Chef** → se compraba de más, y había **productos puros de Chef en la OC de Loke** (706, 701, 99, 840, 713, 824, 97, 901, 546E… todos 0 ventas lk). **Fix**: nueva función **`fn_proyeccion_madre_emp(p_emp)`** en el proyecto web `kwkclwhmoygunqmlegrg` (calco de `fn_proyeccion_madre` con filtro `empresa=p_emp`; **excepción 505**: para `lk` incluye las ventas Chef del código exacto `505` porque comparten stock — "505L=505"). `refresh_proyeccion_madre()` (este proyecto) ahora pega a `.../rpc/fn_proyeccion_madre_emp?p_emp=lk` en vez de la mezclada, y se re-corrió → `proyeccion_madre` quedó **solo-lk** (216 códigos). No toca `fn_proyeccion_madre` original (la sigue usando Chef). **Reversible** (volver el endpoint a `rpc/fn_proyeccion_madre` y re-correr). Efecto: **809E 270→11,35** · **566E 216,5→58,3** · **504 1523→1067** · puros-chef fuera. La solapa "meses de capacidad" (v5.62) se corrige sola (lee `proyeccion_madre` en vivo): **13 no alcanzan** (antes 18), peor ahora **522E 0,27**. ⚠ **`empresa` en `sales_lines` = `lk`/`chef`** (2 valores), NO las tablas osa/pa/tyl (esas son otros sistemas). Excel "Meses de capacidad por artículo" regenerado con esta base (ventas+proyección solo-lk).
>
> Nota: **server-side (sin bump) — Alertas Telegram "pedido adelantado" (al TAP) + "tandas para adelantar" (16 hs)**. Pedido del dueño: avisar a Marianela cuando adelantan pedidos NO súper. **"Súper"** = `PPP_Programacion_Diaria.tipo='KRIKOS'` (cadenas: CENCOSUD/Coto/INC/Carrefour/El Abastecedor) **o** zona `Super`; el resto (`WEB` = bazares/distribuidoras) NO es súper. **"Adelantado"** = `fecha_entrega` posterior a **mañana** (armado ≥2 días antes; armar el día antes es normal). **(1)** Trigger **`notificar_pedido_adelantado_telegram()`** en `Registros_Produccion_Virgilio` `WHEN opcion='TAL'` (mismo patrón que las otras alertas, escribe en `telegram_outbox` con dedup, nunca bloquea): al armar (TAL) un pedido adelantado no-súper, manda **1 mensaje por tanda/día** (`dedup adel_<tanda>_<día>`, se va actualizando con las NP de esa tanda) listando NP · cliente · zona · fecha proyectada. Validado: capturó exactamente los 13 pedidos que adelantaron ayer (20/7 → proyectados 22/7, Zona 1, WEB). **(2)** Función **`notificar_tandas_adelantar_telegram()`** (cron **`adelantar_tandas_16h`**, `0 19 * * *` UTC = **16 hs AR**): lista las **tandas listas para facturar** (saldo en `a_facturar`) cuya **zona coincide con una zona que YA se entrega mañana** (distinct `zona` del PPP con `fecha_entrega=mañana`) y están **proyectadas para después de mañana** — o sea conviene adelantarlas un día para que salgan con ese camión. No súper. `fecha_entrega` se parsea con guard `~ '^\d{4}-\d{2}-\d{2}'` (hay valores rotos tipo `30/`). Zona horaria AR (UTC-3) en todo. ⚠ Ambas van al chat grupal `-1004379879565` (si Marianela tuviera chat propio, cambiar ahí).
>
> Nota: **v5.62 — "Meses de capacidad" en la solapa Capacidad (los que no alcanzan)**. En **Stock y Compras → 📐 Capacidad**, métrica nueva **meses de capacidad = capacidad de góndola del código (Σ `Capacidad_Sector.cajas_max` de sus ubicaciones) ÷ venta mensual proyectada (`proyeccion_madre.proy_cajas_mes`)** = cuántos meses de venta aguanta la góndola llena. **<1 mes = la ubicación NO le alcanza a la proyección** (se vacía antes del mes). Pedido del dueño: verlo en **meses**, no en diferencia de cajas. Se agregó: (1) columna **"Meses cap."** (color: 🔴<1 · 🟡1–2 · 🟢≥2) + columna **"Vende caj/mes"**; (2) **orden por defecto = meses ascendente** (los que no alcanzan, primero; toggle `stkCapSort` a orden por código); (3) resumen con los conteos por banda. Los datos ya estaban cargados en la solapa (`_stk.cap` capacidad, `_stk.cproy` proyección vía `ocgFetchProyeccion`), sin fetch extra. Normalización `_ocgNorm` (upper + sin ceros a la izquierda) para cruzar capacidad↔proyección (mismo criterio en ambas fuentes). Estado real hoy: **198 códigos** con capacidad y proyección, **18 no alcanzan (<1 mes)** — el peor **566E** (cap 90 / vende 216,5 mes → **0,42 meses**), después 583E 0,47 · 582E/591 0,52. Verificado headless (orden asc 566E→583E→315, 0.42 rojo / 10.00 verde, banda "sin proyección" a "revisar") + checkhtml/suite. La vieja columna "Dif" (cajas) sigue pero el foco pasó a meses. `stkCapSort` en smoke.
>
> Nota: **v5.61 — Dos pop-ups en el módulo Stocks (Stock y Compras → Stocks)**. Dos botones nuevos arriba de la tabla: (1) **📋 Pedidos por estadio** (`stkOpenPedidos`) — muestra qué **notas de pedido** hay en cada estadio del pipeline desde el pickeado: **📦 Pickeados** (`separar_pedidos`) y **🧾 A Facturar** (`a_facturar`). El stock de esos depósitos está por **tanda** (`ref`), así que agrupa por tanda (con sus cajas) y mapea **tanda→NPs** con el PPP (`PPP_Programacion_Diaria`, np+razón social, fetch scoped `tanda=in.(...)`). (2) **🔁 Movimientos de góndola** (`stkOpenGondola`) — los movimientos que tuvo específicamente la góndola (`terminado`): resumen **⬆ Guardado** (tipos `guardado`/`guardado_fuera_lista`/`baja_racks`) y **⬇ Picking** (tipo `picking`) + neto, filtros, buscador por código/tanda, y la lista de movimientos (fecha, tipo con color, código, tanda, delta; tope 300). Ambos leen `_stk.movs` (ya cargado, salvo el PPP del #1) y respetan el **corte** y **"a esa fecha/hora"** (`_stkWin`). El `inicial` NO entra en los totales de guardado/picking. Funciones `_stkPopAgg`/`_stkFetchNpsByTanda`/`stkOpenPedidos`/`stkOpenGondola`/`stkGondRender`. Verificado headless (Pickeados C91A→NPs, A Facturar C80B→NPs; góndola Guardado +70/Picking −20/Neto 50) + checkhtml/suite. Nuevas en smoke.
>
> Nota: **v5.53 — Capacidad de POSICIONES de racks (¿cuántos palets vacíos entran hoy?)**. Pedido del dueño: saber cuántos **palets vacíos** entran en los racks **ahora** (planimetría + realidad de hoy) y verificar rápido si entra una **importación** (ej. 2 importaciones = 26 palets), viendo además las posiciones **por liberarse** (con poca mercadería). Se agregó **arriba de la solapa 🏗 Racks** (`stkBodyRacks`, panel 📦 Stock y Compras) un bloque de capacidad que lee **`Racks_Planimetria`** (anon SELECT; **1 posición física = 1 palet**, dedup por `sector`) vía **`racksFetchPlani`**/**`stkPlaniLoad`** (carga perezosa al entrar a la solapa, gate en `stkTab`, estado `_stk.plani`/`_stk.planiLoaded`). **`stkRacksCapCompute`** agrupa por sector y clasifica: **libres** (sin `estado=ocupado`), **agotadas** (código real pero `inner=0 y master=0` → "casi libres, se barren"), **reservadas** (`cod_art='Pedidos'`), slot **Cajas**, y **ocupadas c/ mercadería** (`inner>0 o master>0`; ojo **505I** = 0 master pero 336 inner → cuenta como llena). **`stkRacksCapSummary`** muestra: badges del conteo, un **simulador** "¿entra la importación?" (input `stkPlnSet`, default **26**, persiste en `localStorage vir_racks_palets_in`) con semáforo verde/ámbar/rojo (verde = entran en libres; ámbar = entran pero hay que liberar N agotadas; rojo = faltan posiciones aun liberando las agotadas), los **chips de posiciones libres** (dónde meterlos) y una tabla **"por liberarse"** (agotadas + ocupadas con `inner≤36`, orden asc, top 15). Estado real al documentar: **23 libres · 5 agotadas · 9 reservadas Pedidos · 1 slot Cajas · 86 ocupadas** (124 posiciones) → 26 palets **NO** entran solo en libres, pero **sí** liberando las 5 agotadas (23+5=28). Solo lectura (no escribe nada). Verificado headless (lógica de clasificación con 505I/multi-código por sector, render 430px sin overflow) + smoke (funciones nuevas en `need`). ⚠ La planimetría se mantiene con las bajas de racks (RPC `racks_plani_descontar`); si se desincroniza, este panel lo refleja igual que "bajar de racks".
>
> Nota: **server-side (sin bump) — Alerta Telegram "📐 CAPACIDAD SIN PROYECCIÓN" + limpieza `Capacidad_Gondola` + corrección de 5 códigos**. Tres cosas de datos: **(1) Alerta** `reporte_agentes_capacidad_sin_maximo()` (`sql/capacidad_sin_maximo.sql`): avisa por Telegram (dedup **semanal**, encadenada al cron 14) los códigos con lugar en `Capacidad_Sector` pero sin máximo **activo** en `OC_Maximos`, y sugiere la E si el código+E sí tiene máximo — versión proactiva del banner de la solapa (v5.60). Hoy flag: **554, 573, 592E**. **(2) Corrección de datos**: se renombraron en `Capacidad_Sector` los 5 códigos a los que les faltaba la E (**102/106/124/439/580 → +E**, 13 celdas) — la capacidad estaba pegada al código sin proyección. Quedan 554/573 (máximo DESACTIVADO = discontinuados, con lugar+stock) y 592E (sin máximo ni stock) para que el dueño defina. **(3) Limpieza de modelo (#5)**: la tabla vieja **`Capacidad_Gondola`** (730 filas, superseded por `Capacidad_Sector` que es la que usa la app; 0 refs en código/funciones/vistas/triggers) se **archivó** con rename a `zzz_backup_Capacidad_Gondola` (reversible; no se borró por el riesgo de un flujo n8n externo). El resto de los hallazgos del repaso de datos (drift racks planimetría↔ledger, tablas vacías funcionales Planimetria/Conteo_Stock, Auditoria_Produccion_Virgilio) se dejaron: o son funcionales o necesitan decisión.
>
> Nota: **v5.60 — Alerta "con lugar en góndola pero SIN proyección/máximo" (solapa Capacidad)**. Regla del dueño: **un artículo no debería tener lugar en góndola si no tiene proyección de ventas** — si `Capacidad_Sector` tiene el código pero `OC_Maximos` no, casi siempre es el **código mal escrito** (le falta la E, un cero, etc.). `stkBodyCapacidad` ahora muestra un **banner rojo** arriba con los códigos que tienen capacidad y `max==null`, y si el mismo código **+ "E"** SÍ tiene máximo, lo **sugiere** ("102 (60 cj) → ¿102E?"). Estado real: **8 códigos** (5 se arreglan con E: 102/106/124/439/580 → +E; 3 sin proyección ni con E: 554, 573, 592E). Verificado headless (banner + sugerencia + código sin sugerencia). ⚠ Es un aviso en la solapa (no manda Telegram todavía — se puede sumar como alerta de Agentes si se quiere proactivo).
>
> Nota: **v5.59 — Sugeridor inline + Ciudadela + aviso "ayer quedó abierto" + botonera más prolija**. Cuatro cosas: **(1) Sugeridor de tandas SIN popup** (`pppSugerirInline`): en la vista solo-lectura de "A Programar", el botón 🪄 ahora muestra la sugerencia **inline** (qué tanda va cada pedido por m³+zona) en la misma vista; el pop-up (ventana de impresión) aparece **solo** al tocar **"📄 Exportar PDF"** (`pppPrintSug`). Antes abría el overlay directo. **(2) Ciudadela no marca "tanda mezclada"** (`_pppEsCiudadela`): la fábrica está en Villarreal y Ciudadela queda pegada camino a Zona 1 por la autopista → en la detección de rutas mezcladas (`_pppComputeErrors`) los pedidos de Ciudadela **no cuentan como ruta aparte** (no toca el ruteo real, solo la alerta). **(3) "Ayer te quedó SIN CERRAR"**: banner ámbar arriba de `renderPendingSuggestion` cuando un **picking/armado** quedó `active` de un **día anterior** (compara `ts_inicio` con `isoToDayKey` vs hoy) — dice qué tarea, cuándo se abrió y con qué cerrarla (TP/TAP), para que la terminen si fue sin querer o la continúen. **(4) Botonera más prolija**: `.box-desc` pasa a `word-break:normal;hyphens:none` (antes partía "Empec-é"/"Recepci-ón" feo) y **`#row2` (RT·RR·MG) a 3 columnas** full-width (usaban media fila, ahora entra "Recepción Mercadería" sin cortar). Verificado headless (Ciudadela match, banner de ayer, render botonera 390px). ⚠ **Pendiente de decisión**: hay **tres botones "Recepción"** (RT Mercadería / RR Remitos / RI Insumos) medio confusos — propuesto relabel, sin aplicar (muscle memory).
>
> Nota: **v5.58 — Bajada automática: botón de EJECUCIÓN (genera propuestas, gated por el switch)**. Con el switch ON, debajo del preview aparece **"📋 Generar la bajada (queda para que Marianela apruebe)"** (`stkAutoBajadaGenerar`): confirma, y crea las bajadas como **`Racks_Bajadas` estado='propuesta'** (`creada_por='auto'`, `cajas`=inner) — el **mismo camino** que el operario en "bajar de racks" → las **aprueba Marianela** en Recepción y ahí recién se mueve el stock (`racks−`/`terminado+` vía `racksAprobarBaja`). NO mueve stock solo (approval-gated, reversible). ⚠ NO decrementa la planimetría (no elige celda; se reconcilia aparte). Solo visible con el **switch ON** (default OFF) → queda **preparado y dormido** hasta que el dueño cargue el stock de góndola. Confirm avisa de revisar góndola antes (los negativos bajan de más). Verificado headless (postea propuesta 536E · 60 cajas inner) + smoke. **Estado de #3: cálculo + preview + CxM planimetría + ejecución = listos; solo falta que el dueño cargue el stock de góndola para prenderlo.**
>
> Nota: **v5.57 — Bajada automática: el CxM sale de la planimetría (destraba el preview)**. La bajada automática (v5.54) daba **0 para bajar** porque el `Cajas_x_Master` del maestro (`Articulos Virgilio X Tallerista`) está cargado para casi ningún código (los 33 candidatos reales lo tenían en 0). Fix: `stkAutoBajadaCompute` ahora **deriva el CxM de la planimetría** (por código, si todas las celdas ocupadas con master>0 dan el mismo ratio ENTERO `inner/master`, ese es el CxM — mismo criterio que `rkbFetchCxM`), con **prioridad al maestro** y fallback a la planimetría. De 33 candidatos, **32 quedan con CxM** (solo 809E tiene ratios distintos). Preview real de hoy: **~27 códigos / cientos de cajas** para bajar (ej. 538E 5 master/60 cj, 536E 5/60, 601E 6/60). ⚠ Sigue mostrando **góndolas en negativo** (607E −37, 812E −3) que inflan el hueco → el stock de góndola todavía hay que sanearlo antes de enchufar la **ejecución** real. Verificado headless (536E sin maestro → CxM 12 de la planimetría → 5 master) + smoke.
>
> Nota: **server-side (sin bump) — Alerta Telegram "👀 STOCK ESTANCADO"** (⚠ **REDEFINIDA** — ver la nota más nueva arriba: ahora son "errores reales" en días hábiles, no "cantidad hace X días"). Pedido del dueño: avisar cuando algo quedó en un **estado intermedio** más días de lo normal (suele ser que ya lo hicieron físicamente y **se olvidaron de marcarlo** en la app). Función **`reporte_agentes_stock_estancado()`** (`sql/stock_estancado.sql`): por artículo, en los depósitos **`a_guardar`** (llegó y no pasó a góndola), **`separar_pedidos`** (pickeado sin separar/armar) y **`a_facturar`** (armado sin facturar), si el **saldo > 0** y la **última actividad** es de hace **más de N días** (`Stock_Config.dias_estancado`, default **2**) → **Telegram** con la lista (los 15 más viejos + "… y N más"). Respeta el cutoff, excluye legajos 0/1, dedup diario por el set. Encadenada al **cron de agentes** (jobid 14, 3×/día). **Solo Telegram** (NO toca el tablero): el tablero Agentes ya mostraba `mg_pendiente` (a guardar +8 h) y `pipeline_atascado` (pickeado/a facturar +2 días) vía `generar_reporte_agentes` — lo que faltaba era el aviso. Verificado con rollback (hoy marcaría **40**: 15 a guardar / 25 a facturar, hasta 18 días; *a separar* en 0). Para tunear el umbral: setear `Stock_Config.dias_estancado`. ⚠ `a_facturar` puede tener falsos positivos si hay pedidos armados para fecha lejana (subir `dias_estancado` si molesta).
>
> Nota: **v5.56 — Columna "Capacidad góndola" por artículo + buscador numérico con botón E (solapa Stocks)**. (1) En **Stock y Compras → 📊 Stock**, columna nueva **"Capacidad góndola"** = capacidad MÁXIMA de góndola por artículo (suma de sus celdas en `Capacidad_Sector`; un artículo puede tener varias, ej. **506 = 16 celdas = 3252 cajas**). Además un tile **"Capacidad"** en la tira de totales (suma global). `openStockAdmin` ahora trae `Capacidad_Sector` (`_stk.cap`); `stkBodyStocks` arma `capByCod` con `_ocgNorm` y lo muestra (verde). (2) El **buscador de código** de esa solapa pasó a **teclado numérico** (`type=text inputmode=numeric`, los códigos son números) con un **botón "E"** al lado (`stkFiltroToggleE`) que agrega/quita la E de los importados (506 ↔ 506E) sin cambiar de teclado. Verificado headless (3252 en la columna + tile total; toggle E) + smoke.
>
> Nota: **v5.55 — "Volver al cuadro" en los modales + Mover mercadería entre ubicaciones + 2 fixes de racks**. Cuatro cosas: **(1) "Volver al cuadro" (#1)**: si el operario cierra un modal de operación (**MG · Bajar de racks · Insumos · Cervantes · Completar · RC · EA**) con cosas cargadas, ahora **pregunta** "¿Salir sin terminar?" y —si sale— guarda un **borrador** (snapshot del estado en `localStorage`, uno por legajo: `vir_op_draft_<legajo>`). En la pantalla de inicio (`renderPendingSuggestion`) aparece **"▶ Seguir…"** que reabre el modal **EXACTO** donde quedó (cada `show*()` acepta un snapshot opcional que setea el estado y renderiza, **sin recargar**). Antes se perdía todo y había que terminar+empezar de nuevo. Helpers `opDraftSave/Load/Clear/opAskClose/opDraftResume`; `x`AskClose`/x`HasProgress por modal; se limpia el borrador al confirmar. (Picking/armado ya tenían su propio retomar.) **(2) Mover mercadería entre ubicaciones (#2)**: botón **🔀** para el **operario** (debajo de la botonera) y en **admin** (solapa 🏗 Racks) → `showMoverModal`. Elegís origen (celda con mercadería) → cuántas cajas → destino (celda **libre** o con el **mismo código**, excluye otro código y las zonas de insumos). Solo mueve la **planimetría** vía RPC nueva **`racks_plani_mover`** (origen −, destino +; origen a 0 → se libera; master proporcional a las cajas movidas); **NO toca `Movimientos_Stock`** (mover entre celdas no cambia el total de racks). Rechaza destino ocupado por otro artículo o reservado. **(3) Telegram RACK LIBRE (#5)**: el aviso ahora lista **en qué otras posiciones** sigue estando el artículo. **(4) Zonas de insumos (#4)**: `_racksZonaInsumo` excluye **V01–V16/V21/V22** y **R01–R18** del conteo de racks (hoy no cambia el número: la planimetría arranca en V17/R20). Verificado headless (borrador guardar/retomar MG+RC; mover Y07→Y16 con master proporcional 4, destinos filtrados; RPC probada con rollback) + smoke. **Sigue pendiente**: la EJECUCIÓN real de la bajada automática (v5.54 es preview).
>
> Nota: **v5.54 — Bajada automática de racks (por capacidad de góndola), detrás de un switch**. Módulo NUEVO en la solapa 🏗 Racks (arriba, bajo el resumen de capacidad) que calcula **automáticamente qué bajar de racks → góndola**. Regla del dueño: por artículo, se baja para **llenar la góndola** = **capacidad** (suma de sus celdas en `Capacidad_Sector`, un artículo puede tener varias) **−** lo que ya hay en góndola (`terminado`), **SOLO en MASTER cajas completas** (`floor(hueco/CxM)`, nunca se abre un master) y **topeado por lo que haya en racks** (`min(floor(hueco/CxM), floor(racks/CxM))`). CxM sale de `Articulos Virgilio X Tallerista` (`stockFetchArtFactors`); los que tienen hueco pero **sin CxM** se listan aparte ("no entran al automático"). Va **detrás de un switch** `Stock_Config.bajada_auto_racks` (`'1'/'0'`, **default OFF**, anon r/w igual que el SSG `alerta_sin_stock_gondola`) — el dueño lo prende **cuando confíe en el stock de góndola** (hoy no lo chequeó → OFF y no muestra nada). Funciones `stkAutoBajadaCompute`/`stkAutoBajadaSection`/`stkToggleAutoBajada`; `stkPlaniLoad` ahora también trae `Capacidad_Sector` (`_stk.cap`) y el flag (`_stk.abrOn`). **Es PREVIEW**: muestra la tabla (Código · Cap · Góndola · Hueco · Bajar N master · Racks + total) pero **todavía NO crea la orden ni pre-carga al operario** (ese paso se activa cuando el dueño valide los números). Verificado headless (437E: cap60−gónd10=hueco50, CxM3 → floor(50/3)=16 pero racks 40/3=13 → **13 master/39 cj**; góndola llena no baja; sin-CxM avisa) + render 430px + smoke. **Pendientes anotados** (no implementados): "volver al cuadro" en modales de operación, botón mover mercadería entre ubicaciones, excluir zonas de insumos V01–V16/V21/V22 y R01–R18 del conteo de racks libres, y listar en el Telegram "RACK LIBRE" en qué otras posiciones queda el art.
>
> Nota: **v5.53 (follow-up) — Posición en 0 → se libera sola + solapas sin scroll + stepper centrado**. (1) **Regla del dueño: "si una posición quedó en cero, se anula ese artículo para esa ubicación y pasa a libre"**. Se metió DENTRO de la RPC **`racks_plani_descontar`** (migración `racks_plani_descontar_libera_celda_en_cero`, ver `sql/racks_plani_viva.sql`): cuando la celda llega a `innercajas ≤ 0`, además del aviso Telegram "📦 RACK LIBRE", hace `update … set estado='libre', cod_art=null, master_cajas=0, innercajas=0` de esa celda → cuenta como **posición vacía** en el panel de capacidad (no como "agotada"). **One-time** al aplicar: se liberaron las que ya estaban en 0/0 (7 posiciones). Efecto en el panel: **casi libres (agotadas) → ~0** y esas posiciones pasan a **LIBRES**. Estado tras aplicar: **30 libres · 0 agotadas · 9 reservadas · 1 slot Cajas · 84 con mercadería** → los 26 palets de la importación **entran directo** (semáforo verde). La detección de "agotada" en el front queda como **fallback** (por si una celda llega a 0 fuera de la RPC, ej. edición manual de planimetría; el path admin `racksAprobar` no toca la planimetría, solo el ledger). (2) **Solapas de 📦 Stock y Compras sin barra de scroll**: `.stk-tabs` pasó de `overflow-x:auto;flex-wrap:nowrap` a **`flex-wrap:wrap`** y `.stk-tab` ganó **`flex:0 1 auto;width:auto`** (antes `flex:1 0 auto` + el global `button{width:100%}` las estiraba a fila completa y scrolleaban). Ahora entran las 7 en una fila en monitor y **envuelven** en celular, sin scroll. (3) **Botones ± del simulador de importación centrados** verticalmente con el número (`margin:0;height:40px;inline-flex` — el mismo `button{margin-top:14px}` global que ya mordió a otros steppers, v5.45). Verificado headless (solapas: 1 fila @880px / 2 @430px sin scroll; stepper alineado top 215 los 3).
>
> Nota: **v5.52 — EA · Entrega Artículos para envasar (operario)**. Botón nuevo **EA** en la botonera del operario (`row3`, secundario, violeta `.box[data-code="EA"]`) que abre un modal directo (`showEAModal`, sin Enviar) para **dar de baja el stock del depósito `para_envasar`**. Resuelve el limbo detectado: el "Conteo Definitivo 2026-07" (8/7) movió 4 códigos de `racks` → `para_envasar` (**035E**=44, **439E**=84, **440E**=147, **584E**=424) y **ningún módulo de la app leía ese depósito** → quedaban invisibles (no aparecían en "bajar de racks" ni en ningún lado). El módulo es calcado del de "bajar de racks" pero: (1) lee el saldo de `para_envasar` **directo de `Movimientos_Stock`** (`deposito=eq.para_envasar`, agregado por código con `_cpNorm`) — ese depósito está **fuera de los 7 hardcodeados** de `stockComputeSaldos`/labels/OC, así que sigue **sin contaminar** los totales de Loeke; (2) baja en **cajas (inner)**, sin master ni ubicaciones; (3) es **baja DIRECTA** (no cola de aprobación como racks): al confirmar hace `stockMove` **`para_envasar −qty`** (`tipo='entrega_envasar'`, `ref='operario'`) y emite el evento **`EA`** por código (`texto = COD|qty`). Funciones `eaFetchStock`/`showEAModal`/`eaRender`/`eaChg`/`eaSet`/`eaConfirmar`/`eaEmitEvent` (~9767). Verificado headless 412px (los 4 códigos ordenados por código, stepper centrado; confirmar de 30 del 440E genera `para_envasar −30` + evento `EA 440E|30` + cierra) + checkhtml/suite verdes. Funciones nuevas en smoke. ⚠ Es baja **hacia afuera** (los artículos salen a envasar); si en tu operación tuvieran que ir a **góndola** tras envasar, hay que agregar un `+terminado` (follow-up ofrecido).
>
> Nota: **v5.51 — Estación de impresión: auto-print de remitos al TAP**. Pantalla nueva **🖨️ Cola de impresión** (`openPrintStation`, panel admin, al lado de "Consultar NP/Líos") pensada para correr en la **PC fija de la operadora** (al lado de la impresora). Un **toggle "Auto-imprimir remitos al terminar armado"** (`psToggle`, estado en `localStorage.ps_auto_virgilio` — **por dispositivo**, así solo esa PC imprime y los celulares nunca) prende un loop que cada **12 s** (`psPoll`) busca **eventos TAL nuevos** (NPs recién terminadas), trae la cabecera del PPP (`psPrintBatch`) y las **imprime solas** vía `remitoPrintDoc`. **Dedup por NP/día** en `localStorage` (`ps_printed_virgilio_<día>`) para no repetir ni al recargar; al prender por 1ª vez en el día **siembra** lo ya terminado (`psSeedTodayIfNeeded`, lo marca impreso SIN imprimir) para no volcar el día entero; cola **serializada** (1 hoja cada ~2.6 s, `psDrain`). Al recargar la página, si `ps_auto=1` **retoma solo** (setTimeout diferido en el boot). Log en pantalla con **Re-imprimir** por NP + botón **"Imprimir hoja de prueba"** (`psTestPrint`). **Cómo sale sin diálogo**: Chrome con **`--kiosk-printing`** + impresora **predeterminada de Windows** (decisión del dueño: impresora A4 láser/chorro + PC fija de la operadora → kiosk-printing, no hace falta QZ Tray). El navegador **no puede** elegir impresora ni saltear el diálogo por JS: se resuelve por cómo se corre Chrome, no por código. Verificado headless (pantalla OFF/ON, toggle, log con totales correctos 97950=58/13, cola serializada, `print()` no re-dispara). Funciones nuevas en smoke.
>
> Nota: **v5.50 — Remito de armado imprimible por NP (operadora)**. Botón **🖨️ Imprimir** en cada fila de **Consultar NP / Líos** (`openNpConsulta`, panel de la operadora) → abre un **preview** del remito y un botón "Imprimir" que manda a la impresora **solo esa hoja** (iframe aislado `remitoPrintDoc`, sin popup ni páginas en blanco del resto de la página). Layout (confirmado por el dueño, **opción a** = sin nombre de artículo, orden por código): **cabecera** (NP grande · Cod Cliente · Razón Social · Fecha Entrega · Tanda·cajas·líos) + tabla **Artículos** (`Cod` / `Cajas` / `Va en lío(s)` + fila TOTAL) + tabla **Líos** (`Lío` / `Composición`). Los datos salen de la fila de `_npcRows` que ya trae `resumen` (TAL), `cod`/`rs`/`fecha_entrega` (PPP) — **no** re-consulta nada. `armadoRemitoData(row)` parsea el resumen con `cpParseResumen`+`liosLabels` (rótulos agrupados A1/A2…), agrega por artículo (Σ cajas + en qué líos aparece, dedup) y arma la composición por lío; `armadoRemitoInnerHtml(d)` renderiza; `remitoPrintDoc(inner)` imprime. **Por ahora es MANUAL** (lo pidió así el dueño); el auto-print al **TAP** se hará después reusando estas mismas funciones. Verificado con NP real 97950 (58 cajas, 13 líos, 505→A1/A2, 520→F/G, orden por código) headless + `print()` dispara 1 vez + suite verde. Funciones nuevas en smoke.
>
> Nota: **v5.49 — RC · Pasar cajas a un pedido urgente (operarios)**. Botón nuevo **RC** en la botonera del operario (`row3`, secundario, borde naranja `.box[data-code="RC"]`) y dispatch directo (`if (code === "RC") { showRCModal(legajoStr); return; }`, sin pasar por Enviar; el evento `RC` lo emite el modal al confirmar). Resuelve: cuando un pedido **urgente** (sale antes) tiene faltante de un artículo, sacarle cajas a **otro pedido que sale después** (armado **o** pickeado). **Flujo** (`showRCModal`): (1) elegir el **urgente** — lista de `cpLoadFaltantes()` (Entregas con `cajas_falto>0`, no facturadas) **ordenada por `fecha_salida` ASC** (los que salen antes, primero); (2) la app **sugiere donantes** con ese mismo `cod_art` que salen después, pero **el operario elige cualquiera** (no impone) — donantes **armados** (`Entregas_Virgilio.cajas_entregadas>0`, otra NP) y **pickeados** (`Movimientos_Stock deposito=separar_pedidos`, neto>0 por `ref`/tanda + `fecha_entrega` del PPP), ordenados por fecha desc y disponible desc; (3) cuántas cajas (tope = `min(faltante, disponible del donante)`). **Al confirmar** (`rcConfirm`): RPC atómica **`reasignar_cajas(p_target_id, p_qty, p_donor_id)`** (urgente `cajas_falto−`/`entregadas+`; donante armado `entregadas−`/`falto+` → **queda con faltante + aviso**; `p_donor_id=null` si el donante es pickeado) · `stockMove` `a_facturar +qty` ref=NP-urgente y donante `a_facturar −qty` (armado) o `separar_pedidos −qty` (pickeado), tipo `rc` · **líos**: suma al urgente (`rcAddToLio`→`cpUpdateLio` lío nuevo) y descuenta del donante armado (`rcRemoveFromLio`, re-emite el TAL) · evento **`RC`** (`texto = NP|NPdonor o Ttanda|cod|qty`). Funciones `showRCModal`/`rcRender`/`rcRenderStep2`/`rcLoadDonors`/`rcPickUrgent`/`rcPickDonor`/`rcConfirm`/`rcAddToLio`/`rcRemoveFromLio`/`rcEmitEvent` (~10018). Verificado headless 412px (paso 1 lista ordenada, paso 2 donantes armado+pickeado + stepper centrado) + checkhtml/suite verdes.
>
> Nota: **v5.48 — Columna "Cajas Pedidas" (demanda) en la solapa Stocks**. En Stock y Compras → Stocks, por artículo se ve la **sumatoria de cajas pedidas** (la demanda del PPP), más un chip total **"Pedidas"**. Sale de `ocgDemanda()` (Σ cajas por artículo en los pedidos del PPP según la base de picking; desde **v6.47** excluye las NP ya facturadas — con fila en `Facturacion_NP`) — el mismo cálculo que la columna "Pedidos" del generador de OCs. Se carga en el `Promise.all` de `openStockAdmin` → `_stk.dem`, y se usa en `stkBodyStocks` (columna + total + se **incluyen artículos que tienen pedidas aunque no tengan stock** cargado, matcheando por `_ocgNorm`). Rendereado OK: 999 con 50 pedidas y 0 stock aparece; total = suma de todos.
>
> Nota: **v5.47 — Tabla de Facturación: scroll horizontal en vez de cortarse**. `.fac-table-wrap` tenía `overflow:hidden` → en pantallas más angostas que la tabla (`table-layout:fixed`, columnas suman ~1180px) las columnas de la derecha (Razón Social, Dirección…) se **cortaban**. Fix: `overflow-x:auto` + `-webkit-overflow-scrolling:touch` (mismo patrón que las otras tablas: ppp-tablewrap, cr-tablewrap, etc.). Verificado: a 400px `scrollWidth=1181 > clientWidth=374` → scrollea; en el monitor (1240px) entra sin scroll. Facturación se usa en monitor, así que el corte era sólo a ancho celular, pero ahora es prolijo en cualquier ancho.
>
> Nota: **v5.46 — Mismo fix del stepper a MG, Completar Pedido e Insumos**. Los steppers `− [n] +` de MG (`.mg-sb/.mg-inp`, góndola + excedente), Completar Pedido (`.cp-sb/.cp-inp`) e Insumos (`.ins-sb/.ins-inp`) tenían el MISMO problema que racks: los botones ± heredaban `margin-top:14px` de la regla global `button{}` y los inputs no tenían `box-sizing:border-box` (2px de borde → 4px más altos). Fix: `margin:0` en los `-sb` + `box-sizing:border-box;margin:0` en los `-inp` (ya tenían flex-center). Verificado por medición: el stepper de CP quedó con −/input/+ al mismo `top` (235,235,235). checkhtml + suite verde. Queda pendiente (ofrecido): un barrido general de otras botoneras afectadas por `button{margin-top:14px}`, y la tabla de Facturación cortada en celular.
>
> Nota: **v5.45 — Stepper de racks: el fix de v5.44 quedó a medias (la causa REAL)**. Los botones − / + seguían **14px más abajo** que el "0". Medido: contenedor `.rkb-stp` = 60px (no 46), botones con `margin-top:14px`. Causa: la regla **GLOBAL `button { … margin-top:14px; width:100%; padding:16px }`** (index.html:25-31) — mi CSS de `.rkb-sb` sobrescribía width/padding/font pero NO el margin. Fix: **`margin:0` en `.rkb-sb`**. Verificado: −, input y + ahora al mismo `top` (contenedor 46px). ⚠ **Esa regla global pisa a TODOS los `<button>`** — cualquier stepper o botonera nueva tiene que overridear `margin` (varios ya lo hacen con `.xxx button{margin-top:0}`, ver líneas 279/2007/2157). Al emparejar los steppers de MG / Completar Pedido, agregarles `margin:0` a sus botones ± también.
>
> Nota: **v5.44 — Estética: stepper de racks (bajar del rack) parejo**. El `.rkb-inp` tenía `border:2px` **sin** `box-sizing:border-box` → medía 50px de alto mientras los botones `.rkb-sb` medían 46px, quedando 4px más bajos (se veían "no centrados con el número"). Fix: `box-sizing:border-box` en el input (misma altura) + `.rkb-sb` a flex-center con `line-height:1` (signo − / + centrado en el cuadrado). Además el label de unidad (`master`/`cajas`) pasó de estar **a la derecha** del stepper a estar **arriba** (nuevo `.rkb-stpcol` columna), como pidió el dueño. Sólo CSS/HTML del render de `showRacksBajarModal` (test `racks-propuesta` sigue verde). ⚠ El "NaN m" que se vio en la captura del auditor de render era **dato de prueba del stub** (código 237 inexistente), NO un bug: con datos reales el chip del sector siempre muestra un número (`Number(innercajas)||0`, master exige `cxm>0`). Pendiente ofrecido: aplicar el mismo arreglo a los steppers de MG / Completar Pedido.
>
> Nota: **server-side (sin bump) — Alerta Telegram cuando en MG → "De los racks" una posición/artículo queda en 0**. Pedido del dueño. Se enganchó **dentro de la RPC `racks_plani_descontar`** (migración `racks_plani_descontar_alerta_rack_vacio`), que es la que descuenta la posición elegida al **PROPONER** la baja (`rkbConfirmar`, único call-site; NO se llama al aprobar → sin doble aviso). Dos avisos vía `tg_enqueue`: **(1) 📦 RACK LIBRE** cuando esa celda queda vacía (`innercajas ≤ 0`); **(2) 🚨 SIN STOCK EN RACKS** cuando el artículo llega a 0 en TODAS sus posiciones ocupadas (`sum(innercajas)=0`). Dedup con **bucket por minuto** (`rackpos0|sector|cod|YYYYMMDD_HH24MI` y `rackzero|cod|…`) para que un doble-tap no repita pero se re-avise si la celda se vuelve a vaciar. El nombre del artículo sale de `vista_nombres_articulos` (best-effort). ⚠ Dispara al **proponer** la baja (ahí decrementa la planimetría), no al aprobar — coherente con "cuando están poniendo MG". La lógica de descuento quedó **idéntica** (solo se agregó el aviso). Probado con rollback (DO block + `raise exception`) sin mandar nada real: 971E única posición → los 2 avisos; 598E vaciar 1 de 6 → solo (1); baja parcial → ninguno.
>
> Nota: **v5.43 — Auditoría de cálculo (3 auditores) + más truncados + cutoff robusto**. Tres auditores confirmaron que el NÚCLEO está sano (stock event-sourced conservado y front==server, ruteo/haversine, faltantes con signo correcto, timezone AR, divisiones m³/h todas con guarda). El problema era la misma clase de truncado que v5.41/42. Arreglados con `supaFetchAll`: (1) **Monitor Query C** (`~L14927`, traía TODAS las opciones de 10 días = >1800 filas → PostgREST cortaba en 1000 y **se caía HOY**: "empleados hoy", en jornada/cerrados y "últimos 5 días" daban mal) — ERA ACTIVO, confirmado por 2 auditores independientes; (2) **Monitor Query B** y (3) **`fetchProductivityData`** (EP/TP/AP/TAP — blindaje proactivo); (4) **Consulta NP/Líos** (`npcLoad`, Entregas por `np=in` podía pasar 1000 → faltantes por NP incompletos); (5) **`stockFetchSaldos`** (`vista_saldos_stock`, la usan MG/racks/insumos/CP/Cervantes — blindaje). (6) **`stockGetCutoff` normaliza el cutoff a ISO** (`_stkNormTs`): el valor cargado a mano `"2026-06-26 00:01:00-03"` (espacio en vez de `T`, offset sin `:00`) daba **Invalid Date en iOS Safari** → el corte se ignoraba y el front divergía de la vista. Test `tests/fac-npc.cjs`: el stub `J()` ahora manda `content-range` para `supaFetchAll`. ⚠ **PENDIENTES DE DECISIÓN del dueño (NO tocados)**: tope de `<24h` en `fetchMonitorDayStats` (`L11490`) descarta cierres cross-day (subestima m³); el Monitor NO descuenta faltantes pero el panel Rendimiento SÍ (dan distinto); aprobación de racks sin idempotencia (`racksAprobar` L9141 + `recepcion.js` L1082 — riesgo doble-movimiento, hay un −48 histórico en 583E de refs manuales); `stockBajaPicking` PKC sin acotar por tanda (`L10005`, latente); `FERIADOS_AR` sólo 2026; `facTodayKey` usa TZ del dispositivo; insumos mezcla unidades (Uni/Paq/Kg).
>
> Nota: **v5.42 — Más truncados de 1000 filas (misma clase que v5.41), auditados en toda la app**. Barrido de todos los `fetch` con `limit>1000` sin paginar: los que pegan a tablas que superan 1000 filas traían datos incompletos → cálculos mal. Arreglados con `supaFetchAll` (pagina con Range): (1) **`fetchVolumenArticulos`** (`Volumen_Articulos` ~2500 códigos → traía 1000) → **m³ por artículo incompleto** = m³ mal en TODOS los módulos (productividad, armado guiado, etc.); (2) **`prodLoad`** (Productividad): traía los eventos del período con `limit=100000` pero un rango de varios días supera 1000 eventos → productividad de cualquier período largo salía a medias; (3) **`fetchEntregadosMeta`** (`PPP_Entregados_Meta` ~2100 → 1000) = NP→cliente/razón social faltaba para ~1100 NPs en Recepción Remitos; (4) **`_pvFetchM3`** (`vista_tanda_m3`, 910 hoy) blindado antes de que pase 1000. Verificado que el resto de los fetches con limit alto están acotados por filtro de día/tanda/np-in (<1000): faltantesDeTanda, stockBajaPicking, fetchInconsEvents, fetchMonitorDayStats, npcLoad, CCN/TAL/CRN (esas tablas tienen <220 filas). ⚠ **Regla para adelante**: nunca confiar en `limit=N` para traer "todo" — PostgREST corta en **1000** (db-max-rows). Si la tabla puede superar 1000, usar `supaFetchAll(endpoint, query)`. Tablas hoy >1000: Registros_Produccion_Virgilio (13561), PKC (2656), Volumen_Articulos (2542), PPP_Entregados_Meta (2143); vista_tanda_m3 (910) al borde.
>
> Nota: **v5.41 — BUG GRAVE de stock: `stockFetchMovs` sólo veía los 1000 movimientos más recientes**. `stockFetchMovs` pedía `?select=*&order=ts.desc&limit=20000`, pero **PostgREST corta las respuestas en 1000 filas** (`db-max-rows`) sin importar el `limit`. Con **8880** movimientos en `Movimientos_Stock`, la app calculaba el stock event-sourced desde **sólo los ~1000 más recientes** (≈ últimos 2 días): perdía el `inicial` y el picking viejo pero conservaba el armado/facturado nuevo → **NEGATIVOS FANTASMA** en góndola/Pickeados/A facturar, que **empeoraban con el tiempo** (cada día la ventana de 1000 cubría menos). Confirmado: la ventana de 1000 daba EXACTO lo de la pantalla (510 → góndola −37, pickeados −196; totales −328/−1801/−444). **Fix**: `stockFetchMovs` ahora usa `supaFetchAll` (pagina con `Range` de a 1000 y trae TODO). Afecta a TODO lo que arma el stock: solapa Stocks, Conteo, Ajustes y el **generador de OCs** (`ocgEnter` también llama `stockFetchMovs`). Test `tests/fac-npc.cjs` (F5): con 1500 filas simuladas, `stockFetchMovs` devuelve 1500 (no 1000) y paginó. ⚠ **Corrige el diagnóstico de v5.40**: el Pickeados negativo NO era el corte "Marcá inicio" partiendo el par picking/armado (eso puede pasar pero no era el caso: el corte estaba en 26/06) — era **este tope de 1000 filas**. El "snapshot al Marcá inicio" que se había sugerido **ya no hace falta** para este síntoma. ⚠ **Patrón a revisar**: cualquier otro fetch que use `limit=20000` esperando traer todo y cuya tabla supere 1000 filas tiene el mismo bug latente (hoy TAL/Precios/OC_Maximos están por debajo de 1000, pero Entregas_Virgilio y otros pueden crecer). Usar `supaFetchAll` donde el volumen pueda superar 1000.
>
> Nota: **v5.40 — Stock "En vivo" vs "a una fecha y hora determinada"** (solapa Stocks de Stock y Compras). Como el stock es event-sourced, se agregó un selector: por defecto **🔴 En vivo** (saldo actual), y un `datetime-local` + botón **📅 A esa fecha/hora** que reconstruye el saldo **al momento elegido** contando sólo los movimientos con `ts ≤` esa fecha/hora (hora Argentina UTC-3). `stockComputeSaldos(movs, cutoff, asOf)` suma un tope superior `asOf` (el `inicial` sigue siendo baseline y siempre cuenta; el corte sigue como piso). Estado en `_stk.asOf`/`_stk.asOfInput`, funciones `stkAsOfControl/stkAsOfApply/stkAsOfLive`; el detalle por artículo también respeta el tope. Sólo aplica a la solapa Stocks (las otras siguen en vivo). Sirve para auditar la evolución del stock (p. ej. ver las cajas "en tránsito" en Pickeados en un instante dado). Test `tests/fac-npc.cjs` (F4): a la fecha entre picking y armado, Pickeados = lo pickeado; el `inicial` cuenta siempre. ⚠ CORREGIDO EN v5.41: los saldos NEGATIVOS fantasma NO eran el corte (ver v5.41) sino el tope de 1000 filas de PostgREST en `stockFetchMovs`.
>
> Nota: **v5.39 — Rótulos de líos agrupados A1, A2, A3… (no se gastan letras)**. Cuando un mismo artículo llena varios líos idénticos (mismo **cod Y cantidad**), en vez de ocupar letras seguidas (A, B, C, D) comparten **una letra base con sub-índice**: A1, A2, A3, A4. Los líos únicos quedan con la letra sola. Nuevo helper compartido **`liosLabels(lios)`** (usa la misma firma `_compLioSig` que el `_compLioGroups` del armado). Aplica en **ambos** lados: (1) **armado** → serialización `_compLiosResumen` y `cpBuildResumen` ahora emiten los rótulos agrupados; la vista "Editar líos" muestra el rango (ej. `A1–A4 · ×4`). (2) **Consulta NP/Líos** → re-rotula al vuelo (funciona también sobre TAL viejos guardados posicional A/B/C/D). ⚠ Al cambiar el rótulo, **Completar Pedido** ya no puede seleccionar el lío por letra: se pasó a **selección por índice** (`_cp.lioSel` = índice; `cpUpdateLio` toma `lios[idx]`). Test `tests/fac-npc.cjs` (F3): `liosLabels` da `["A1","A2","A3","A4","B"]` y `["A1","B","A2"]` (repetido no consecutivo), y `_compLiosResumen` da `A1=026x5;A2=…`.
>
> Nota: **v5.38 — Consulta NP/Líos: día de salida (PPP), día de armado, quién pickeó y quién armó**. Cada tarjeta suma una línea meta: **📅 Sale** (fecha_entrega de `PPP_Programacion_Diaria`), **🛠 Armado** (fecha del evento TAL), **📦 Pickeó** (legajo de los eventos **EP/TP** de la tanda — TP=terminó pisa a EP=empezó) y **🧰 Armó** (legajo del TAL). `npcLoad` ahora también trae los EP/TP de las tandas del corpus (`pickerByTanda`) y llama `getEmpleadosNombres()` (legajo→nombre, cacheado 1h); el buscador único también matchea por **nombre de operario**. Aclaración: los NP armados **antes** de v5.12 tienen TAL sin resumen (`NP|líos|tanda`) → se muestran "sin detalle de líos" (sólo se guardó la cantidad, no la composición; no es recuperable). Test `tests/fac-npc.cjs` extendido (salePpp/armadorLeg/pickerLeg + render de la línea meta + búsqueda por nombre).
>
> Nota: **v5.37 — Consulta NP/Líos: un solo buscador en vez de 5**. Los 5 inputs por-campo (NP · Tanda · Cod · Razón Social · Fecha) se reemplazaron por **un único buscador** que matchea contra **todos** los campos a la vez (incluye fecha ISO y dd/mm/aaaa, y la clase lío/etiqueta/retira). Multi-término separado por espacios = **AND** (ej. «osa 15/07» filtra por razón social Y fecha). `npcApply` ahora arma un `npcHaystack(r)` por fila y testea que cada término esté contenido; `npcClear` limpia el único input `#npcQ`. Regresión `tests/fac-npc.cjs` actualizada (busca por NP/RS/fecha/tanda y multi-término contra el mismo input).
>
> Nota: **v5.36 — Aviso de faltantes en Facturación + módulo "Consultar NP / Líos"**. Dos features. **(1) Faltantes en Facturación**: cuando una NP salió **incompleta** (`Entregas_Virgilio.cajas_falto > 0`), la operadora lo ve **antes** de facturarla. `facFetchFaltantes()` (nuevo, cache 30 s, va en el `Promise.all` de `facTick`) trae `Entregas_Virgilio?cajas_falto=gt.0` → `Map<np,{cajas,items:[{cod,falto,ped}]}>`. En `facRender`: la fila con faltante lleva clase `fac-has-falta` (fondo rosa + barra roja a la izquierda) y un badge `⚠ FALTA N cj: cód×falto…` en la celda Razón Social (`facFaltBadge`/`facFaltInfo`). Además, al tildar (`facTickNP`) una NP con faltante, **`confirm()` obligatorio** ("Faltaron N cajas… ¿facturar igual? Facturá por lo ENTREGADO, no lo pedido") — cancelar aborta el tilde. **(2) Consulta NP/Líos** (botón "🔎 Consultar NP / Líos" en el panel supervisor, `openNpConsulta`): modal `#npConsultaModal` para ver **cómo se compuso una NP a líos** y buscar en vivo por **NP · Tanda · Cod Cliente · Razón Social · Fecha**. `npcLoad()` trae **todo el corpus TAL** (opcion=TAL, un registro por NP, el más reciente — es chico, ~200 filas) y lo enriquece con `Entregas_Virgilio` (cod_cliente, fecha_salida, tanda, faltantes por `np=in.()`), `PPP_Programacion_Diaria` (razón social, fecha_entrega) y `PPP_Entregados_Meta` (cod/rs histórico). Filtra en el cliente (`npcApply`, `oninput`). El detalle de cada lío sale de parsear el `resumen` del TAL con **`cpParseResumen`** (reusado) → cada lío `A=cód×cant,…`, y los artículos **faltantes se marcan en rojo** dentro de la composición. Recordatorio del formato TAL: `texto = NP|líos|tanda|resumen|clase`, y `liosSend` hace `toUpperCase()` (por eso el separador queda `X` mayúscula, `(S)` para suelta). Regresión `tests/fac-npc.cjs` (badge + confirm-guard + carga/filtro/marcado de faltantes). Ninguna tabla nueva; todo read-only con anon key.
>
> Nota: **v5.35 — Switch en el admin para apagar el aviso "picking sin stock en góndola" (SSG)**. El dueño **no está cargando el stock inicial** todavía → cada picking da "había 0" para todos los códigos y dispara el aviso 📦🚨 **PICKEADOS SIN STOCK CARGADO EN GÓNDOLA** (trigger `notificar_picking_sin_stock_telegram`), puro ruido. (⚠ Se confirmó que **MG SÍ suma a góndola** — 2.927 cajas por `guardado` en 10 días; los ceros son por falta de stock inicial, no por un MG roto.) Fix: flag **`Stock_Config.alerta_sin_stock_gondola`** (`'1'` on / `'0'` off, **default OFF** mientras no hay stock); el trigger lo lee antes de notificar (migración `switch_alerta_picking_sin_stock_gondola`). En el cliente, **switch en el panel de supervisor** ("Reportes y configuración"): `loadSsgSwitch()` (lee el flag al abrir el panel, hook tras `show("supervisorPanel")`), `toggleSsgAlert()` (escribe con anon key, upsert `on_conflict=clave`, igual que el cutoff), `ssgSetSwitchUI()`. Cuando carguen el stock inicial, lo prenden. Regresión `tests/ssg-switch.cjs` (carga refleja el flag, toggle POSTea flipeado). ⚠ **Solo apaga el SSG** — los avisos de **faltantes** (`notificar_faltante_telegram`) y **sin planimetría** (`notificar_sin_planimetria_telegram`) siguen ON (pendiente si se quieren gatear con el mismo switch). (SW_VERSION venía desfasada en v5.30-vir por otra sesión; realineada a v5.35-vir.)
>
> Nota: **server-side (sin bump) — Telegram duplicado por TIMEOUT de pg_net (fix `tg_outbox_flush`)**. El dueño recibió **el mismo aviso ~20 veces** ("🗺 SIN PLANIMETRÍA — Tanda C82A"). Causa: **1 solo** evento PSP y **1 sola** fila en `telegram_outbox` (dedup OK), pero el envío por **pg_net timeaba** (`net._http_response`: `status_code=null`, `timed_out=true`) **aunque Telegram SÍ entregaba** el mensaje. El flush trataba el timeout como fallo → `req_id=null` → **re-enviaba** cada corrida (attempts 0→60), duplicando. Fix en `tg_outbox_flush` (migración `tg_outbox_flush_no_reenviar_en_timeout`): (1) si la respuesta viene **`timed_out`** → se marca **`sent`** (no se reintenta: Telegram ya lo recibió); solo se reintenta ante **error HTTP real** (4xx/5xx). (2) si la respuesta **no está** en el rolling window de `net._http_response` (se purga rápido) y pasaron **>2 min** → también se da por **`sent`** (antes re-enviaba). (3) `timeout_milliseconds` 20000→**30000**. Se cortó el spam marcando la fila stuck (id 583) como `sent`. ⚠ Trade-off: un timeout REAL sin entrega quedaría sin reenviar (raro; un aviso perdido es mejor que 20 duplicados).
>
> Nota: **v5.34 — Corte TOTAL de Google Sheets: fichadas-monitor migrado + NP→cliente a Supabase + código muerto PPP eliminado**. (1) **`fichadas-monitor.html`** ahora lee 100% de Supabase: tiempos de `Fichadas_Historico`, roster/secciones de la tabla nueva **`Fichadas_Estructura`**. Las dos hojas de Google (respuestas del Google Form + pivot) se sincronizan **server-side** con `pg_cron` + extensión `http`: `sync_fichadas_respuestas()` (**job 25**, cada 2 min, respuestas→`Fichadas_Historico`, upsert idempotente por el UNIQUE `(ts_evento,email,evento)`) y `sync_fichadas_estructura()` (**job 26**, cada 10 min, pivot→`Fichadas_Estructura`, full replace). Fechas Hoy/Día Anterior se calculan en el cliente (hora AR); "Búsqueda Manual" es un `<input type=date>`. (2) **NP→cliente**: `fetchEntregadosMeta()` (Recepción Remitos) leía el histórico por gviz para el NP/COD/Razón — que **no** estaban en Supabase (`PPP_Pedidos_Entregados` solo tiene tanda+mt3). Nueva tabla **`PPP_Entregados_Meta`** (`np`/`cod`/`rs`, RLS SELECT anon) sincronizada por `sync_ppp_entregados_meta()` (**job 27**, cada 30 min); la función ahora lee de ahí. (3) **Código muerto PPP eliminado en `index.html`**: se sacaron los dos *backfills* que todavía caían al Sheet (en `enrichPickBase` y `faltEnsureBase` → ahora no-op), los tres dispatchers (`fetchMonitorSheet`/`fetchHistoricSheet`/`fetchPickingBase`) pasaron a **solo-Supabase**, y se borraron `fetchMonitorFromSheets`/`fetchHistoricFromSheets`/`fetchPickingBaseFromSheets`, las URLs gviz (`MONITOR_CSV_URL`, `MONITOR_HISTORIC_CSV_URL`, `PICKING_BASE_*`) y los helpers `parseCSV`/`monitorParseM3`/`dedupeHeaderCell`/`findMonitorHeader`. **`index.html` ya no contacta Google** (0 URLs vivas; smoke OK). ⚠ Al no haber caída al Sheet, si un NP no está aún en `PPP_Base_Pedidos` queda sin filas hasta que la macro lo sincronice (antes se rellenaba del Sheet). Crons de sync Sheet→Supabase activos: **25, 26, 27** (`select jobid,jobname,schedule from cron.job`).
>
> Nota: **v5.33 — `VolumenArticulos` migrado a Supabase + se cortó la conexión con Google Sheets**. (1) Nueva tabla **`Volumen_Articulos`** (`codigo` PK, `m3` numeric, RLS SELECT para `anon`) cargada desde la hoja `VolumenArticulos` con la **extensión `http` de Postgres** (`http_get` server-side, que sí alcanza Google — el sandbox de Claude NO). Se levantaron **los DOS bloques** código/m³ de la hoja → **2.542 códigos** (el parser gviz viejo leía solo el bloque izquierdo → perdía ~190 códigos "L" y otros; además descartaba los que no empezaban con dígito). En **13 códigos los dos bloques discrepan**; se guardó el valor del **bloque izquierdo** (el que la app venía usando): `035E`, `437E`, `438E`, `439E`, `440E`, `724`, `823`, `809E`, `7026803`, `7055800`, `7439900`, `7658800`, `7659800` — **revisar en la hoja cuál es el correcto**. (2) `fetchVolumenArticulos()` ahora lee de `Volumen_Articulos` por REST; se borró la constante `VOLUMEN_ART_CSV_URL`. (3) **`PPP_SOURCE` pasó de `"auto"` a `"supabase"`**: la app **ya no lee ninguna hoja de Google** — programación, histórico, base de pedidos y volumen salen 100% de Supabase. El código `…FromSheets` y las URLs gviz de PPP quedan **dormidos** (no se invocan) por si hay que revertir; se pueden borrar más adelante. ⚠ Sin caída al Sheet, la app **depende de que la macro Apps Script (Sheet→Supabase) mantenga PPP al día**; y `Volumen_Articulos` ahora se actualiza en Supabase (re-corriendo la carga `http_get`, o editando la tabla). **Pendiente aparte:** `fichadas-monitor.html` usa OTRO Sheet (pivot de fichadas), no tocado.
>
> Nota: **v5.32 — descarga diaria: una fila por cada picking/armado** (formato largo). Reemplaza el formato ancho de v5.31 (una fila por operario/día con columnas picking+armado). Ver punto (2) de la nota siguiente. El resto de v5.31 (m³ neto de faltantes) sigue igual.
>
> Nota: **v5.31 — m³ real descontando faltantes + descarga diaria en 📊 Rendimiento de operarios**. (1) **m³ neto de faltantes**: desde que se registran faltantes (evento `PKC` = `TANDA|CÓDIGO|ESPERADAS|REALES`; primer uso real **12-jun-2026**, prueba el 11-jun con legajo 1), el m³ acreditado por picking y por armado se **descuenta** por lo que faltó. Nueva `_pvFaltanteFactores(events, VolumenArticulos)` arma un **factor por tanda** = `1 − (volumen faltante ÷ volumen pedido)`, ponderando cada caja por su m³ de la hoja `VolumenArticulos` (código sin volumen → pesa 1 = proporción por cajas). `prodCompute(…, factorMap)` lo aplica en `m3of()` → afecta **todo el dashboard 📊 y las dos descargas**. Tandas **sin `PKC`** (antes del 12-jun, o pickeadas fuera del flujo guiado) quedan con **factor 1 = m³ completo**, así el descuento arranca solo desde que hay faltantes cargados. (2) Botón **"⬇ Excel × día"** (`prodExportCsvDiario`): **una fila por cada picking y cada armado** individual (por tanda) — ej. 5 pickings + 3 armados en un día = **8 filas**. Columnas: `Fecha; legajo; tarea; hora inicio; hora fin; mins otra tarea; minutos netos; mt3 reales; ritmo`. `minutos netos` = tiempo real dentro del envase (span − comida/otras tareas que cayeron adentro); `mins otra tarea` = span − netos; `mt3 reales` ya viene descontado por faltantes (el m³ se acredita 1 sola vez por tanda/día); `ritmo` = m³ ÷ (netos ÷ 60). El motor `_pvOperator` ahora devuelve `rows` (lista por envase con `ini/cli/net/m3`); `_prod` guarda `events`/`m3map`/`factorMap`. (3) Sin bump: cambió el **título del aviso de Telegram** de picking sin stock → ahora **"📦🚨 PICKEADOS SIN STOCK CARGADO EN GÓNDOLA"** (antes "PICKING SIN STOCK EN GÓNDOLA"), porque el stock de góndola todavía no se carga y el aviso no refleja una falta real; se editó la función `notificar_picking_sin_stock_telegram()` (trigger `trg_picking_sin_stock_telegram`).
>
> Nota: **v5.30 — MG "De los racks" ahora PROPONE (requiere aprobación de Marianela)**. El dueño reportó: la bajada de racks→góndola por **MG → "De los racks"** no aparecía en Recepción → **"Bajadas Racks → góndola"** para aprobar. Causa: había **dos** módulos operario: (a) el de las **OCs** (`showBajarRacks`/`brConfirmar`) crea una **propuesta** en `Racks_Bajadas` → va a la cola de Marianela → el stock se mueve al **aprobar** (`racksAprobarBaja` en recepcion.js: `racks−/terminado+`); (b) el de **MG "De los racks"** (`rkbConfirmar`, v5.15) movía el stock **directo** (sin aprobación) → nunca entraba a la cola. Fix (decisión del dueño): `rkbConfirmar` ahora **también propone** — arma filas `Racks_Bajadas` (`orden_id=null`, `cajas`=INNER [master×CxM], `estado='propuesta'`, `creada_por`=legajo), con fallback a `localStorage vir_racks_pend` si no hay red (igual que `brConfirmar`); **NO** mueve stock. El stock recién se mueve cuando Marianela aprueba en Recepción (la aprobación ya soporta bajadas sin `orden_id`). Se mantienen la baja en master, la planimetría viva (descuento de la celda) y el aviso RKX de "fuera de lista"; textos actualizados ("Registrar bajada", "Lo aprueba Marianela"). Regresión `tests/racks-propuesta.cjs` (verifica: NO llama `stockMove`, POSTea `Racks_Bajadas` con `estado='propuesta'` y cajas inner) en `run.sh`. ⚠ Revierte el "camino directo" de v5.15.
>
> Nota: **v5.29 — Los días intermedios cross-day tampoco cuentan FERIADOS nacionales**. Extiende v5.28: además de sábado/domingo, el conteo de días intermedios (`fetchMonitorDayStats`) saltea los **feriados nacionales** de Argentina, tomados de una lista **`FERIADOS_AR`** (Set de `"YYYY-MM-DD"`, definida cerca de `WORKDAY_END_HOUR_AR`). ⚠ **SOLO feriados** — los **"días no laborables" con fines turísticos** (puentes) NO van en la lista porque **en el depósito SÍ se trabaja** (decisión del dueño); en 2026 esos días son 23/03, 10/07 y 07/12 → cuentan como jornada. Los **trasladables** ya van con su fecha OBSERVADA (movida al lunes): Güemes 17→**15/06**, Soberanía 20→**23/11**. La fecha AR se saca con `new Date(dm).toISOString().slice(0,10)` (00:00 AR = 03:00 UTC → misma fecha). Fuente: `argentina.gob.ar/jefatura`. ⚠ **`FERIADOS_AR` HAY QUE ACTUALIZARLA CADA AÑO** (hoy solo tiene 2026); si no, en 2027 los feriados vuelven a contar (pero el finde se sigue salteando siempre). Verificado el algoritmo (feriado salteado / día no laborable contado / Güemes trasladado) + suite. ES2017-safe.
>
> Nota: **v5.28 — Los días intermedios de cierres cross-day NO cuentan sábado ni domingo**. En el reporte **"Mts3 × Hora"** (cross-day, `fetchMonitorDayStats`), un cierre que cruza días (ej. armado con AP el viernes y TAP el lunes) partía el tiempo en apertura + **días intermedios** + cierre, y cada día intermedio contaba como **una jornada completa** (`workH` = hora_salida − hora_entrada, default 9h). Como contaba TODOS los días, un armado de viernes a lunes sumaba **+1080 min** (sábado + domingo × 9h) que no se trabajaron. Fix: el conteo de días intermedios ahora recorre **día por día en hora AR** (`00:00 AR = 03:00 UTC` → `new Date(dm).getUTCDay()`) y **saltea `wd===0` (domingo) y `wd===6` (sábado)** — solo cuentan los hábiles. Es un cálculo (no dato), así que **corrige retroactivamente** C73A y todos los cierres pasados sobre fin de semana, y aplica a futuro. ⚠ **Feriados**: por ahora NO se contemplan (no hay lista de feriados) — un feriado en el medio seguiría contando como jornada; si molesta, se agrega una lista. Verificado el algoritmo (Vie→Lun=0, Jue→Lun=1, Lun→Jue=2, Vie→Mié=2) + checkhtml + suite. ES2017-safe (`let`/`for`, sin `??`/`?.`).
>
> Nota: **v5.27 — Aviso al pickear (EP) una tanda que NO está en el PPP del día**. Frena el error de agarrar la tanda equivocada en el segundo 0 (antes se detectaba recién en el monitor, "Tandas trabajadas que NO están en PPP", tras perder ~1h). Guard en `send()` (después del de AP v5.26, antes de encolar): si `opcion==='EP'` y hay texto, `await fetchMonitorSheet()` y si el mapa tiene tandas pero **no** contiene la tanda tipeada → `confirm("⚠ La tanda X NO está en la programación (PPP) de hoy… ¿seguro?")`; si cancela, **return** (no registra el EP). **Falla ABIERTO**: si no se puede verificar (sin red → `fetchMonitorSheet` tira/`size===0`) NO bloquea. **Solo EP** — el armado (AP) puede ir un día después, fuera del PPP del día, así que ahí NO avisamos. Regresión `tests/ep-ppp-warn.cjs` (no-en-PPP cancela→0 EP; acepta→EP; en-PPP→sin confirm; PPP vacío→sin confirm) en `run.sh`. Origen: caso real — Jhonny (104) re-pickeó **C69C** (tanda ya terminada el 3/7) creyendo que era **C72F**; se limpiaron los 18 eventos del re-picking (EP+PSP+16 PKC, sin TP → sin stock).
>
> Nota: **datos (sin bump) — Conteo Definitivo de racks cargado + 2 depósitos nuevos (#5)**. El dueño pasó `Conteo_de_Racks.xlsx` (hoja "Definitivo", conteo físico). **`Inner caja` = total inner** (= M.C.×CxM, sin sueltos) → se usa esa columna directo como saldo. Se cargó en `Movimientos_Stock` (`tipo='conteo_racks'`, `ref='Conteo Definitivo 2026-07'`, `unidad='inner'`), **reconciliando a exacto** (delta = conteo − saldo actual, con 0 negativos), en **3 depósitos**: **`racks`** (Loeke, 58 cód / **13.399** inner) · **`racks_ch`** (Chef, 3 cód / 840 — 712E/809E/437E) · **`para_envasar`** (4 cód / 699 — 035E/439E/440E/584E, el N°4 "Virgilio Art para Envasar" del Excel). ⚠ **Migración `movimientos_stock_add_racks_ch_para_envasar`**: el CHECK de `deposito` ahora admite `racks_ch` y `para_envasar` (antes 7 valores). **`Racks_Planimetria` refrescada** (full replace) con las celdas N°2: **134 filas** (101 con artículo, 23 `libre`, 10 `Pedidos`/`Cajas`), `emp` LK/CH. **Notas**: (1) `racks_ch`/`para_envasar` **quedan registrados en Supabase pero NO se ven en la app** — `stockComputeSaldos`, las labels (~8515) y el dropdown de ajustes (~8856) tienen los **7 depósitos hardcodeados**; por lo mismo **NO contaminan** los totales de Loeke ni el cálculo de OC (que solo leen terminado/racks/excedente/…). Si se quiere verlos, hay que sumarlos a esas listas. (2) **CxM**: 54 de 62 códigos **no están** en `Articulos Virgilio X Tallerista` → la app no tiene su `Cajas_x_Master` para mostrar master (se ven en inner); el conteo da el CxM real (Inner/M.C.) si se quiere poblar. **035E**: la tabla dice CxM=12 pero el conteo dice **4**. (3) Correcciones del conteo: `206E`→`260E` (transposición), `035E`/`439E`/`440E` mudados de `racks` a `para_envasar`, `712E` movido de `racks` a `racks_ch` (era Chef mal cargado), `363E`/`366E` (huérfanos viejos) a 0. Reemplaza el seed anterior (nota "Racks sembrado desde la planimetría", 53 cód/14.236 inner).
>
> Nota: **v5.26 — AP repetido sobre la misma tanda ya no duplica el evento**. Complemento de v5.25: si el operario aprieta **AP por costumbre** sobre una tanda que YA tiene armado abierto (`st.armado.active` y mismo código, comparación normalizada trim+upper), el `send()` **no encola un 2º evento AP** (evita el doble arranque que ensuciaba los tiempos) — solo **reabre el asistente** donde quedó y avisa "ese armado ya estaba abierto…". Si el código es **otra tanda**, sigue el flujo normal (armado nuevo). Guard al principio de `send()`, antes de armar/encolar el payload. Regresión en `tests/ap-resume.cjs` (misma tanda → 0 encolados + reabre; otra tanda → encola AP).
>
> Nota: **v5.25 — "Seguir armado": retomar el armado después de una pausa (sin re-mandar AP)**. El dueño reportó: el operario hace **AP** (empecé armado) de una tanda, después hace otra cosa (**PC comida**, etc.) y al volver "no lo deja continuar" — tenía que apretar **AP de nuevo**. Problema real: el asistente de armado (`showCompletarWizard`, Paso 1 Faltantes → Paso 2 Líos) **ya persistía** su avance (`_compPersist`/`_compRestore`, TTL 36h) y **ya se retomaba en el paso guardado**, PERO el único modo de reabrirlo era volver a tocar AP → mandaba **un 2º evento AP** (doble arranque) y, durante la pausa, el botón AP quedaba **deshabilitado** (regla: con cualquier toggle activo, EP/TP/AP/TAP se bloquean) y toda pista del armado desaparecía (la sugerencia "Armado pendiente" está DEBAJO del `getAnyToggleActive` que corta). El picking ya tenía su **"▶ Seguir picking"** ARRIBA de ese corte; el armado no. Fix: nuevo botón **"▶ Seguir armado tanda X · Paso N"** en `renderPendingSuggestion` (ámbar `#b45309`), puesto **arriba del corte de toggles** (se ve incluso durante la comida), que llama `showCompletarWizard(legajo, st.armado.value)` — reabre el wizard **en el paso guardado, SIN encolar/mandar AP**. Se muestra mientras `st.armado.active`; desaparece al TAP (que limpia el persist). Regresión nueva `tests/ap-resume.cjs` (visible con toggle activo, texto con "Paso 2", click llama al wizard, no aparece sin armado) chained en `run.sh`. NOTA: el armado guiado por m³/líos (`showArmadoGuide`, `ARMADO_GUIADO_ACTIVO`) sigue **apagado**; esto toca el wizard "Completar" que sí está vivo.
>
> Nota: **v5.24 — La ubicación del excedente (MG y picking) acepta letras Y números**. El campo de ubicación del excedente (dónde se guardó lo que sobró) no dejaba escribir números: el regex `[^A-Z]` los borraba y la validación exigía exactamente 3 letras. Ahora acepta alfanumérico (ej. **A12**, **AB12**): `mgRender`/`mgSetUbic`/validación con `[^A-Za-z0-9]`, `maxlength` 6, placeholder "A12", exige ≥1 carácter; mismo arreglo en el prompt del picking (`pkMarkExcedente`).
>
> Nota: **v5.23 — CP avisa "tandas pickeadas sin armar todavía"**. El dueño buscó la NP 97898 en Completar Pedido y no la encontró. Causa (NO era bug): el CP lee `Entregas_Virgilio`, que se llena **al terminar el ARMADO** (separar por NP → `_compSaveEntregas`), no en el picking. La 97898 (tanda C78A) estaba **pickeada** (TP 07:41, faltantes 550/573/870E) pero **sin armar** (0 TAL/TAP) → sin faltante atribuido a la NP → no aparece. Fix de VISIBILIDAD (el dueño confirmó que estos pedidos SIEMPRE se arman): nueva `cpLoadPickSinArmar()` — cruza los **PKC con faltante** de los últimos 3 días (`Registros_Produccion_Virgilio`) contra las tandas que YA tienen filas en `Entregas_Virgilio` (fetch acotado con `tanda=in.(...)`), y las que quedan (pickeadas con faltante pero no armadas) se muestran en un **cartel ámbar** arriba del CP: *"⏳ N tanda(s) pickeadas SIN armar todavía — sus faltantes aparecen al terminar el armado: C78A…"*. Así se entiende por qué una NP todavía no está, sin preguntar. Liviano (PKC ~cientos de filas/3d; 1 fetch de Entregas scoped). `_cp.pickPend` (4º del `Promise.all` de `showCPModal`), render en `cpRender` paso 1, CSS `.cp-pend`. Verificado headless (cartel con C78A/C69D) + smoke (suma `cpLoadPickSinArmar`).
>
> Nota: **Telegram menos disperso (2026-07-03, decisión del dueño)** — dos ajustes server-side sobre lo anterior: **(A) Faltantes AGRUPADOS por tanda**: `notificar_faltante_telegram` (trigger AFTER INSERT PKC) antes mandaba **1 Telegram por artículo** faltante (dedup `pkc_<client_id>`); ahora usa dedup **por tanda+día** (`pkc_<tanda>_<día AR>`), arma **UN mensaje con todos los faltantes** de la tanda (`⚠ FALTANTES — Tanda X · Legajo N` + lista `• Art…: puso R de E (faltan Z)`) vía UPSERT `on conflict do update … where status='pending'` (la lista crece mientras esté sin enviar), y **NO** hace flush inmediato. El envío lo hace el flush con un **DEBOUNCE de 3 min**: los mensajes `pkc_` salen recién 3 min después del último faltante (así junta toda la tanda). Blindada con `exception when others then null` → un fallo de Telegram **nunca** bloquea el registro del picking (trigger AFTER = rollback). Verificado: C69D pasó de **12 mensajes → 1**. (Los otros avisos de picking, `psp` sin-planimetría y `ssg` sin-stock, YA eran 1 por tanda — no se tocaron.) **(B) Agentes 3×/día**: el cron jobid 14 pasó de cada-2h-diurno a **`0 11,15,19 * * *`** = **08/12/16 AR** (mañana/mediodía/tarde). Migración `faltantes_agrupados_por_tanda` (incluye el debounce en `tg_outbox_flush`, que sigue con el horario silencioso 07–21).
>
> Nota: **cron (2026-07-03) — Agentes en horario DIURNO (basta de Telegram de madrugada)**. El dueño reportó avisos "muy dispersos y a cualquier hora". Diagnóstico (outbox real): salían mensajes a la **01:02 AR** — el cron **jobid 14 `generar-reporte-agentes`** corría **cada 2h las 24hs** (`0 */2 * * *` UTC → 21/23/**01/03/05**/07…/19 AR) y, como el `dedup_key` de las categorías es **por día**, al cambiar la fecha a medianoche la **primera corrida post-medianoche (01:00 AR)** re-mandaba las alertas persistentes sin resolver (`equiv_facturar` NP 97874, `falta_llego`, `ppp_error`). Fix: `cron.alter_job(14, '0 10-22/2 * * *')` → ahora corre **solo 07:00–19:00 AR** (10-22 UTC, 7 corridas). Las alertas que sigan abiertas re-pingan a las **07:00 AR** (arranque de jornada) en vez de la madrugada. Los demás jobs Telegram ya eran diurnos (08:00 falta-fact-hoy/anomalías, 10:00 outbox-salud, 18:00 falta-fact-mañana/rendimiento/reporte-diario, 19:00 resumen-agentes, Lun 08:00 semanal, Mié 08:00 OC-pendientes). **PERO el cron no alcanzaba**: hay alertas **event-driven** (no cron) que también mandan Telegram directo — `ppe` (trigger al cargar la PPP, ej. 04:36 AR) y los faltantes/`psp`/`ssg` en **tiempo real** cuando el operario pickea (ej. 07:30 AR). Fix definitivo: **HORARIO SILENCIOSO en el envío mismo** — `tg_outbox_flush` (jobid 10, cada minuto) ahora **solo MANDA entre 07:00 y 21:00 AR** (`v_hora_ar between 7 and 20`); fuera de esa franja los mensajes quedan `pending` y salen a las 07:00. Cubre TODAS las fuentes (cron, triggers, tiempo real), no solo el cron. La 1ª parte del flush (revisar respuestas en vuelo) sigue corriendo siempre. Migración `tg_outbox_flush_quiet_hours`; para mover la ventana, ajustar el `between`. **Nota**: los faltantes de las 07:30 son avisos REALES de un operario pickeando (correctos); si el dueño los quiere menos dispersos, opciones a futuro: agrupar faltantes por tanda (1 msg en vez de 1×artículo) o subir el inicio de la ventana. **Opcional pendiente**: frecuencia diurna de Agentes (cada 2h → 3×/día) o 1 digest.
>
> Nota: **server-side APLICADO (2026-07-03, al volver el conector Supabase)** — se ejecutó todo el backlog que había quedado en cola con el conector caído: **(1) Capacidad de góndola** (`sql/capacidad_gondola_final.sql`): `Capacidad_Gondola` 730 filas (LK+CH, +col `emp`) y **`Capacidad_Sector` 512 filas / 38.728 cajas** — el tope del generador de OCs ya usa los máximos reales del Excel (verificado md5 vs archivo). **(2) RPC planimetría viva** (`sql/racks_plani_viva.sql`): `racks_plani_descontar` aplicada + probada (descuenta inner de la celda y ajusta master proporcional; deshecho el test). **(3) Auditoría SE**: marcados **resuelto** los hallazgos de `Auditoria_Codigo` id 8/9/10/11/12 (los fixes de v5.17+v5.18); **8 funciones** con `search_path` pinneado (migración `pin_search_path_funciones`). **Quedan abiertos para decidir**: id 3 (9 vistas SECURITY DEFINER — lista en la nota), id 4 (bucket `remitos` con policy SELECT que permite listar), id 5 (backup horas sin RLS), id 7 (anon escribe ~100 tablas, tradeoff no-auth), id 13 (endpoint ART duplicado ≠ id 10). **(4) Fix alerta `error_envio`** (migración `fix_error_envio_antijoin_y_recuperados`, función `generar_reporte_agentes`): ahora **excluye por anti-join** los envíos cuyo `client_id` ya está en `Registros_Produccion_Virgilio` + dedup → **error_envio pasó de 5 filas (16 "veces") a 0** (eran 100% falsos positivos: los 12 client_id de 7 días estaban TODOS en Registros); nueva categoría **`envio_recuperado`** (info, 10 filas) para los que fallaron por red pero entraron. Backup del original en `sql/generar_reporte_agentes_original.sql`, versión nueva en `_v2.sql`. ⚠ Al correr `generar_reporte_agentes()` a mano, las categorías de OTRAS funciones (`equivalencia_facturar`/`falta_llego`/`faltante_articulo`/`evento_imposible`) quedan vacías hasta el próximo cron (jobid 14, cada 2h) — se reponen solas. **Verificación de los 5 "envíos fallidos" del tablero (legajos 237/104): los 11 client_id ENTRARON, 0 perdidos.**
>
> Nota: **v5.22 — Planimetría de racks VIVA en "Bajar de racks" + categoría "envíos recuperados"**. (1) **Planimetría viva**: el módulo operario racks→góndola ahora muestra por código **chips con sus UBICACIONES** (de `Racks_Planimetria`, orden por stock desc: "Z05 · 40 m" en master o "Y07 · 200 cj" en cajas) — sirven para **encontrar** la mercadería y marcan **de qué celda se baja** (preselecciona la de más stock; el operario toca otra si corresponde). Al confirmar, además del ledger, se llama **best-effort** la RPC **`racks_plani_descontar(p_sector, p_cod, p_inner)`** que descuenta inner de esa celda y ajusta master proporcional (clamp 0, solo filas `ocupado`, match por código normalizado). Sin esto la planimetría cargada el 30/06 moría con la primera bajada. `rkbFetchCxM` ahora devuelve `{cxm, locs}`; nuevos `it.locs`/`it.sec`, `rkbSetSec`, CSS `.rkb-locs`/`.rkb-loc`. **⚠ La RPC está en `sql/racks_plani_viva.sql` PENDIENTE de aplicar** (conector caído; la aplica el vigía) — mientras tanto el fetch de la RPC falla silencioso y solo corre el ledger (sin romper nada). Verificado headless (chips, preselección, cambio de celda, RPC con conversión master×CxM y cajas 1:1). (2) **`envio_recuperado`** agregado a `CATS` del tablero Agentes (📶 "Envíos con reintento (llegaron igual)", informativo): la llena el server cuando el vigía modifique `generar_reporte_agentes` — muestra los envíos que fallaron por señal pero entraron al reintentar, para leer el "mapa de wifi flojo" sin alarma falsa.
>
> Nota: **v5.21 — Sesión estable + ventana de 20hs (diagnóstico con workflow de 9 agentes)**. El dueño reportaba "me saca de la sesión al refrescar o a veces ya logueado" y pidió sesión de ~20hs. Causas encontradas y fixes: (1) **🔴 `recepcion.js` PISABA la sesión Google**: creaba un 2º cliente Supabase **sobre la misma `storageKey`** default y, si al cargar no veía sesión (token vencido + wifi), hacía `signInAnonymously()` **encima** → sesión del supervisor destruida de verdad. Fix: el cliente de recepción pasa a **`storageKey: 'sb-hrxfctzncixxqmpfhskv-recepcion'`** propia + `detectSessionInUrl:false` (tampoco canjea el `?code` del callback OAuth ajeno). ⚠ NO tocar la storageKey del cliente PRINCIPAL: Cervantes hereda la sesión justamente por la key default compartida. (2) **Ventana de 20hs**: se reemplazó el corte por día calendario BsAs (`vir_auth_day`, deslogueaba a medianoche) por **`vir_auth_since` + `AUTH_MAX_MS` = 20h corridas** desde el primer login; se limpia en `signOutGoogle`/`endDaySignOut`. La sesión de operario por legajo sigue durando el día (a propósito). (3) **"Reconectando…" en vez de login**: `applyAuthState` distingue "no hay sesión" de "hay tokens en `AUTH_TOKEN_LS_KEY` pero el refresh falló (red)" → muestra estado Reconectando con botón DESHABILITADO y reintenta (offline: cada 5s sin límite; online: 3 intentos con backoff) — antes un refresh fallido mostraba login clickeable y un tap pisaba la sesión. (4) **Rol sin signOut por red**: `loadSupervisoresRemotos` ya NO cachea un Set vacío ante error (flag `_rolCheckFailed`, también en `resolveEmpleadoByEmail`); `showLoggedIn` con rol no-verificable por red muestra "Sin conexión para verificar tu cuenta — reintentando…" SIN `signOut` (antes borraba el refresh token de verdad para emails no hardcodeados). (5) **"Conectando…" por defecto**: `#googleSignInBtn` arranca `disabled` hasta resolver el estado; **failsafe 8s** que solo habilita el login si el cliente auth NUNCA arrancó (`__authClientReady`) — si está vivo con tokens guardados, cambia a "Reconectando…" sin habilitar. (6) **Mensajes honestos**: helper `authNoSesionMsg(base)` en los 19 avisos de escritura ("Iniciá sesión con Google…") → si `sbAuth.lastFailNetwork` dice red, muestra "Sin conexión — seguís logueado; reintentá"; `getAccessToken` reintenta 1 vez (1,5s) antes de rendirse. (7) El handler `onAuthStateChange` pasa a **por evento**: `TOKEN_REFRESHED` solo chequea la ventana de 20h (antes re-ruteaba TODA la UI cada ~1h), `SIGNED_OUT` → login. Verificado headless: sin sesión → login normal habilitado; con tokens+sin red (pasando el failsafe de 8s) → Reconectando, botón deshabilitado, tokens intactos; mensajes según causa. ⚠ **Config del dashboard Supabase (acción del dueño)**: JWT expiry 3600→**14400s**, Refresh token reuse interval 10→**60s**, "Enforce single session" **OFF**, Inactivity timeout **never** — sin esto la rotación del token con wifi inestable y varias pestañas puede seguir tirando sesiones cada tanto.
>
> Nota: **v5.20 — Envíos que fallaban por wifi: 6 fixes del pipeline de la cola (diagnóstico con workflow de 11 agentes)**. Origen: el tablero Agentes mostraba "Envíos que fallaron (operarios)" (CT/MG/PC/TAP/PKC, motivo network). Diagnóstico: **la mayoría eran FALSOS POSITIVOS** — la alerta cuenta filas de `Auditoria_Produccion_Virgilio` (log de intentos que se escribe al 1er fallo y cada 5) **sin cruzar** contra `Registros_Produccion_Virgilio`; con el reintento cada 3s los ítems casi siempre entran al toque (409=éxito). El único escenario de pérdida real: **Terminar Día** hacía un solo `flushQueue()` sin esperar y cerraba — sin señal, el operario se iba con la cola llena y sin aviso. Fixes cliente: (1) **`terminarDiaDrenarCola()`**: drena ~9s con espera (salta si `onLine===false`, sleep 400ms entre vueltas) y si quedan pendientes avisa con confirm "esperar / salir igual"; (2) **timeout de fondo 12→30s**: `trySendOneReport` gana 2º arg `timeoutMs` (los ~16 sends interactivos siguen en 12s; el flush de página y `SEND_TIMEOUT_MS` del SW pasan a 30s) — con wifi LENTO 12s clasificaba "network" y auditaba envíos que entraban con paciencia; (3) **`#pendingIndicator` global**: banner `position:fixed` abajo (arriba del versionBadge), visible en TODAS las pantallas (antes vivía dentro de `#legajoScreen`), tap = `flushQueue()`; (4) **re-registrar Background Sync** en la rama networkFail del flush (Chrome lo descarta tras ~3 backoffs y moría hasta el próximo encolado) + el listener `online` ahora también manda **`FLUSH_NOW`** al SW (handler que existía muerto en sw.js); (5) **espejar `attempts` a IDB** (`idbPut(cur[i])`) — página y SW llevaban contadores separados y duplicaban filas de auditoría ("9 veces" inflado); (6) **`reconcileQueueFromIDB()`** (+helper `idbGetAll` en la página): rescata ítems que quedaron SOLO en IDB (QuotaExceeded silencioso de LS), corre tras `migrateQueueToIDB` en el init. Verificado headless (banner fixed visible→drena→cola 0→banner oculto, sin confirm con red OK) + suite. **PENDIENTE server-side (en cola del vigía del conector)**: anti-join de la categoría `error_envio` contra Registros por `client_id` + dedup (el fix de mayor impacto: saca los falsos positivos del tablero).
>
> Nota: **v5.19 — Panel Administración: los 6 botones grandes en UNA fila**. Al sumar "Completar Pedido" (v5.05) los primarios pasaron a ser 6 pero la grilla seguía en `repeat(5, 1fr)` → "Recepción Remitos (RR)" caía solo a una 2ª fila (lo marcó el dueño con captura). Fix: `.sup-actions.sup-primary` pasa a **`repeat(6, 1fr)`**. En celular (≤680px) sigue 2 por fila (2×3). Verificado headless a 1720px: 6 botones mismo top, 202px c/u, sin overflow.
>
> Nota: **datos (sin bump) — llegó el Excel DEFINITIVO de capacidad de góndola (`Maximo_por_Estanteria.xlsx`) → `sql/capacidad_gondola_final.sql` (PENDIENTE de aplicar, conector caído)**. El Excel del dueño (730 filas: `Empresa|Sector|COD|Máximo`) **reemplaza** la transcripción provisional de fotos y cubre MUCHO más: **LK** A–J + **Ñ** (rotulado "LOKE"; se normaliza a LK) = 524 celdas con código, cap **38.728 cajas**, y **Chef (CH)** L/M/P = 152 celdas, **6.850 cajas**; 54 Libres; 13 con máximo en blanco. **Cotejo vs fotos: 324/338 exactas.** Correcciones que trae: **E10=225→50** (yo leí 40), **E15 NO es 225 → 337 (12) + 312 (40)**, **E18 sigue 550 (105)** (el tachado era al revés), **C10: el 6 era del 547** (071 queda sin máx), **G13/G14 = 823 sin máx** (no Libres), y **F09–F12 = 437E (30 c/u) / F13–F16 = 438E (16 c/u)** — las celdas de góndola llevan el **código real** (no el de cliente 029/030), consistente con el stock físico (v5.09). **Destino doble** (clave): la tabla **funcional** que lee la app es **`Capacidad_Sector`** (`sector,cod,cajas_max` — tope del generador de OCs vía `ocgFetchCapacidad` + solapa 📐) → va **SOLO LK con máximo** (512 filas; meter CH inflaría la suma por código); `Capacidad_Gondola` queda como **snapshot completo** (gana columna `emp`; incluye CH, Libres y sin-máximo). ⚠ El conector Supabase sigue caído → el SQL quedó **generado y commiteado**, correr entero al volver el acceso.
>
> Nota: **v5.18 — Limpieza de CSS muerto (auditoría SE, [baja]) + tests de regresión**. (1) **CSS muerto**: se re-derivó la lista con el agente `auditor-consistencia` (la original quedó inaccesible en `Auditoria_Codigo` por la caída del conector) y se borraron **102 reglas ≈ 10 KB / 65 clases** verificadas (0 usos estáticos/JS/dinámicos, cruzado index.html + recepcion.js + fichadas): grupos `cmpl-*` viejo (stepper de Cerrar lío, reemplazado por `cmpl-eg*/s*`), panel viejo de totales del monitor (`monitor-totales-side`/`totales-*`/`monitor-tot-*`, hoy `monitor-total-*`), leyenda del monitor (`monitor-legend`/`legend-*` + se quitó el vestigio `legendHtml=""`), `monitor-tab` (el monitor ya no tiene pestañas), `status-pend`, `incons-badge` (⚠ su elemento `#inconsBadge` no existe en el DOM — el JS que lo busca quedó no-op; si se quiere el badge de inconsistencias de vuelta hay que re-agregar el span), facturación vieja (`fac-group`/`fac-tanda-meta`/`fac-progress`), `row-4`/`row-5` (botonera usa `row-6`), `lios-row`, y muertas de los CSS inyectados (stk/oc/prod/ins/mg). **Vivas confirmadas** (dinámicas, NO tocar): `inc-row-alta/media` (`"inc-row-"+sev`), `prod-rol-arm/pick` (`"prod-rol-"+role`), `oc-pill`+estado, `ins-cod-sec`. La cirugía fue con parser CSS (reglas enteras + 1 selector parcial `.fac-group` sacado de una lista de comas), dry-run verificado contra el informe. (2) **Tests**: `tests/ocg-norm.cjs` NUEVO (regresión permanente del fix ALTA v5.17, encadenado en `run.sh`) y el smoke suma las **11 funciones** de los módulos recientes (MG chooser, bajar racks, CP, instructivo, equivalencias, zonas). (3) `sql/auditoria_se_pendientes.sql` NUEVO: queries preparadas para cuando vuelva el conector (marcar resueltos, vistas SECURITY DEFINER, search_path, bucket `remitos`, backups sin RLS, re-digest).
>
> Nota: **v5.17 — Fixes de la auditoría SE (los hallazgos de CÓDIGO)**. Se corrigieron los hallazgos de `Auditoria_Codigo` que viven en el cliente: (1) **[ALTA] Generador de OCs — normalización unificada**: `ocgEnter` cruzaba stock/demanda por `upper+trim` pero proyección/capacidad por `_ocgNorm` (upper + **sin ceros a la izquierda**), y las claves de `stockComputeSaldos` son el `cod_art` **crudo** → si el máximo decía `007` y el stock estaba como `7`, el stock daba **0 silencioso y se sobre-pedía**. Ahora **TODOS** los cruces usan `_ocgNorm`: el stock se re-indexa (`stockN`, sumando por clave normalizada), y demanda (`ocgDemanda`), proyección y capacidad se buscan por `codN`. Verificado headless con fixtures (007↔7: stock 60→pide 40; 066↔66 con tope de góndola: capped 30→pide 10). (2) **[media] Fechas sin tz**: `formatDateTime` (~3498) y el `todayStr` del monitor (~15326) ahora fuerzan `America/Argentina/Buenos_Aires` (en un dispositivo fuera de AR mostraban hora/fecha local). Los otros 2 lugares reportados ya tenían tz (corrimiento de líneas). (3) **[media] URL/KEY duplicada dentro de index.html**: el bloque de auth (~17118) usaba literales `SB_URL`/`SB_KEY` → ahora referencia las globales (`SUPABASE_URL`/`SUPABASE_KEY`, únicas en la página). `sw.js`, `recepcion.js`, `fichada-config.js`, `fichadas-monitor.html` y `productividad.html` **siguen con copia propia a propósito** (workers / módulos aparte — al rotar la key hay que tocar los **6 archivos**: `index.html`, `sw.js`, `fichada-config.js`, `fichadas-monitor.html`, `recepcion.js`, `productividad.html`). (4) **[baja] Función muerta `_compLioReset`** eliminada. **Pendientes del backlog SE** (bloqueados: el acceso MCP a Supabase se cayó en la sesión): las ~33 clases CSS muertas (la lista exacta está en `Auditoria_Codigo`), los server-side (9 vistas SECURITY DEFINER, bucket `remitos`, search_path mutable, backup horas sin RLS, tradeoff no-auth) y **marcar `estado='resuelto'`** en `Auditoria_Codigo` de los 4 corregidos acá.
>
> Nota: **v5.16 — "Bajar de racks" baja en MASTER cajas**. El módulo operario racks→góndola (v5.15) ahora baja en **master cajas** (regla del dueño *"bajan en master siempre"*). Por cada código con **CxM limpio** (ratio inner/master entero y consistente, leído de la planimetría vía **`rkbFetchCxM()`**) el stepper va en **master** (tope `floor(inner/CxM)`, muestra "N master (X cj · ×CxM)"); al confirmar **convierte master→inner** (`racks −baja·CxM` / `terminado +baja·CxM` — el ledger sigue en inner). Los **9 no-limpios** (583E/598E/812E/404E/522E/582E/809E/817E/819E) y los **fuera de lista** caen a **cajas** (1:1, exacto) con la nota "master pendiente", hasta definir su master real. Verificado headless 430px (437E→122 master, 960E→48 master, botón suma el inner correcto: 5×6+2=32). `rkbFetchCxM` nuevo; `showRacksBajarModal`/`rkbRender`/`rkbChg`/`rkbSet`/`rkbConfirmar`/`rkbAddManual` ganan `it.cxm`.
>
> Nota: **stock (sin bump) — Racks sembrado desde la planimetría · guardado = INNER CAJAS (#5)**. Regla del dueño: *"cuando bajan, bajan en master cajas siempre"* → pero el **guardado** en el depósito **`racks`** de `Movimientos_Stock` va en **inner cajas** (igual que la góndola), porque el cálculo de OC (`stock = góndola+racks+excedente`, index ~7855) y la pantalla de Racks (~9005, `master = racks ÷ Cajas_x_Master`) ya **suman/convierten en cajas** → guardar master rompía el "a pedir". La regla se respeta a nivel **operación/vista** (opción B elegida por el dueño): el operario **baja en master** (el módulo debe convertir master→inner) y la pantalla **muestra master** (÷CxM). Seed: 1 ajuste por código (`tipo='ajuste'`, `ref='seed_planimetria_racks_inner_2026-06-30'`, **reversible**) para que `saldo racks = inner de la planimetría` (`Racks_Planimetria`, `ocupado`, LK+CH). **53 códigos**, total **14.236 inner** (583E=**526**, 584E=400, 598E=1992, 503E=88; reconcilió los negativos de las `baja_racks`). **4 huérfanos sin tocar** (saldo viejo, NO en la planimetría → revisar/zerar): 363E=6, 366E=4, 536E=15.67, 585E=60. **Estado de `Cajas_x_Master`**: seteado para los **limpios que ya tenían fila** en `Articulos Virgilio X Tallerista` (7: 035E/437E/438E/439E/440E/566E/584E — corrige los que estaban MAL, ej. 437E figuraba 7.17 → 3). **37 limpios más NO tienen fila** en el maestro → el módulo igual los resuelve con `rkbFetchCxM()` (planimetría). **9 no-limpios** (583E 8.09, 598E 11.65, 812E 7.92, 404E, 522E, 582E, 809E, 817E, 819E 1.41) → CxM real **a definir** (por ahora bajan en cajas). El módulo "Bajar de racks en master" ya está (✅ **v5.16**, ver arriba). ⚠ Pendiente menor: los **4 huérfanos** (revisar/zerar).
>
> Nota: **datos (sin bump) — Capacidad de GÓNDOLA + Planimetría de RACKS (#5, PROVISIONAL)**. Dos cosas distintas que al principio se confundieron:
> **(1) `Capacidad_Gondola(id, sector, cod_art, maximo, nota)`** = **capacidad (máximo de cajas) por celda de GÓNDOLA** (terminado), NO de racks. Fuente: las hojas fotografiadas (sectores A01…H09), columna **MANUSCRITA "Total de Cj por estantería"** = el máximo (NO la impresa "Cjas Total", que es un conteo y se descarta — aclarado por el dueño: *"el máximo son de góndola"*, *"manuscrito = máximo"*). **338 filas / 325 celdas**, capacidad total **28.067 cajas**. PK surrogada `id` (celdas con 2–3 códigos: A64/A67/A73/A78/C09/C14/C19/C20/G03/G19). **5 sin máximo**: A62 (rótulo en blanco) + los 4 **"T" discontinuados** (C15 581T/510T, C20 587T/502T = "DISCO"). Libres omitidas (A60/A65/A80/A83/C01/D35/G09/G13/G14). A revisar (anotaciones confusas en la foto): **E10** (era 337/312 → 225), **E15** (figuraba Libre → 225), **E18** (550 tachado → 224). ⚠ **PROVISIONAL** — el dueño pasará el Excel final. Sirve para topear "a pedir"/reposición de góndola. *(Reemplazó la tabla vieja `Racks_Capacidad`, que por error había cargado la columna IMPRESA.)*
> **(2) `Racks_Planimetria(id, emp, sector, cod_art, master_cajas, innercajas, estado)`** = **planimetría/stock real de RACKS**, de `PLANIMETRIA_racks.xlsx` (hoja DETALLE). **128 ubicaciones** (pasillos AA–AE, X, Y, Z, W, R), 103 ocupadas, 8 "PEDIDOS" (reservadas), 1 "EXCEDENTE", 23 vacías. **1642 master cajas / 14236 inner**. `emp` LK (121) / CH (4: 601E/809E/106E/439E). Códigos importados (E). Referencia: **NO** es `Movimientos_Stock`. Sirve para **sembrar/reconciliar el stock de racks** (los saldos `racks` de `Movimientos_Stock` están fraccionados/desparejos y con negativos 583E/584E/598E de las `baja_racks`). Ambas tablas: RLS ON + solo anon-SELECT.
>
> Nota: **v5.15 — MG pregunta QUÉ bajar + "Bajar de racks" (operario, directo) + alerta**. Al tocar **MG** ahora aparece un chooser (`showMGChooser`): **"📦 Lo que llegó (a guardar)"** (el MG de siempre) o **"🏗 De los racks"**. La opción racks (`showRacksBajarModal`/`_rkb`): lista lo que hay en racks **ordenado por código**; buscador; si algo físico **no figura**, **➕** para agregarlo → al confirmar avisa por **Telegram** (evento **RKX**, texto `COD|R<cajas>` → trigger `trg_racks_fuera_lista` → `notificar_racks_fuera_lista_telegram`, igual patrón que MGX). Si tipean un código que **no existe** pero sí su versión con **E** (583 vs **583E**), lo **sugiere** ("¿No será 583E?") — usa los saldos normalizados (`_cpNorm`). Al confirmar: `racks −` / `terminado +` (`tipo='baja_racks'`, `ref='operario'`). NO toca el stock de racks de fondo (se reconcilia con la carga inicial de racks, #5). Antes el racks→góndola era **solo admin-iniciado** (orden "OCs generadas" + aprobación de Marianela en la solapa 🏗 Racks); esto da el **camino directo para el operario**. Verificado headless (chooser, lista ordenada, sugerencia 583→583E). **Origen**: la alerta "guardado fuera de lista — Art 583" (era racks→góndola con typo **583** en vez de **583E**; el código 583 no existe). De paso se corrigió ese stock (las 48 cajas pasaron de "583" a 583E en góndola).
>
> Nota: **v5.14 — Instructivo de onboarding (#29)**. Botón **"❓ ¿Cómo se usa?"** en la pantalla inicial (`legajoScreen`, visible logueado o no) → modal con ayuda **breve por rubro**: 🛒 Picking (EP/TP), 🔨 Armado (AP/TAP + los 4 pasos del asistente: faltantes/clasificar/separar/líos), 📦➕ Completar Pedido (CP), 🏭 Recepción (RT/RR), 🚚 Carga y control (CC/CR), 📥 Guardar a góndola (MG), 🧰 Insumos y Cervantes (RI/EI/SC), ⏱ Pausas (AT/PB/Limp/Perm/PC/CT). Solo lectura, contenido **estático** (`showInstructivo`/`closeInstructivo`). Verificado headless. Cierra #29.
>
> Nota: **v5.13 — `Zonas_Barrios` (Supabase) → cliente (#37)**. `pppZonaDeBarrio` ahora **mergea la tabla `Zonas_Barrios`** (la misma que llena autozona) en su lookup: prioridad **override local > Supabase (`_pppZonaSupa`) > `PPP_BARRIO_ZONA` hardcodeado**. Así el **RUTEO** y el **SUGERIDOR** conocen los barrios nuevos (Suárez, Chilavert…) sin re-hardcodear — **completa el fix v5.04** (que solo arreglaba la detección de "sin zona" en el monitor, no el ruteo). `loadZonasBarriosRemote()` se llama al cargar (fetch `Zonas_Barrios?select=barrio_norm,zona`); la clave `barrio_norm` == `pppNormBarrio(barrio)` (NFKD + sin tildes + minúsculas, verificado). `_pppZonaSupa` declarado **antes** de `pppZonaDeBarrio` (evita TDZ, el patrón que cazó el agente SE). Verificado headless (Suárez/Chilavert resuelven, barrio desconocido → ""). Cierra la tarea #37.
>
> Nota: **v5.12 — Clasificar cada NP Lío/Etiqueta/Nada (wizard Completar)**. Después de **Faltantes** y antes de **Separar**, un **GATE**: por cada NP marcar **🎁 Lío** (clientes) · **🏷 Etiqueta** (súper) · **🚶 Nada** (retira). **Solo se marca** (sin cantidades, pedido del dueño). No se puede separar/armar hasta clasificar todos (botón "✓ Listo — separar" deshabilitado). **Etiqueta/Nada NO arman líos** (`liosDone=true` → en el paso Líos muestran "sin líos, ya marcado"); solo **Lío** arma líos normal. La **clase se guarda en el evento TAL** (campo 5: `NP|líos|tanda|resumen|clase`) para confirmar más adelante el patrón (lío=cliente / etiqueta=súper / nada=retira) y eventualmente auto-derivarlo. Botón "✎ reclasificar" arriba de Separar. Funciones `_compRenderClasif`/`_compSetClase`/`_compClasifDone`/`_compReclasif` + gate en `_compRenderSep` + rama en `_compRenderLios`; `liosSend` gana 6º arg `clase`; `compTerminar` valida `clasifDone`. Se hizo como **sub-estado del Paso 2 (Separar)** para no renumerar el wizard (3 pasos). Verificado headless (gate, etiqueta sin líos, clases registradas: 97874:lio / 97875:etiqueta). (Tarea #33.)
>
> Nota: **v5.11 — Cartel de equivalencia DENTRO del módulo de Facturación**. Además del Telegram (v5.10), el módulo de **Facturación** (`facRender`) ahora muestra, por NP que tenga un código de equivalencia, un **cartel naranja** debajo de la Razón Social: "🧾 Facturá **437E** (no 029)". Así Marianela lo ve **justo cuando va a facturar** (la factura se hace afuera de la app y va con el código real). Fuente: **vista nueva `vista_pedidos_equivalencia`** (`security_invoker`, une `PPP_Base_Pedidos` × `Equivalencias_Codigos` normalizando ceros), leída por **`facFetchEquiv`** (cache 60s, sumada al `Promise.all` de `facTick`) → `_facEquiv` (NP → `[{cod,real,nota}]`). Si un NP tiene varias (029 y 030), las lista todas. Verificado headless (cartel en el NP con equivalencia, nada en el resto).
>
> Nota: **v5.10 — Alerta "facturar con el código real" (equivalencias)**. Cierra el circuito de equivalencias: como la **facturación se hace AFUERA de la app** (ISIS) y debe ir con el código **real** (437E), no con el del pedido (029), hay que avisarle a Marianela al facturar. Función server-side **`reporte_agentes_equivalencia_facturar()`**: cruza `PPP_Base_Pedidos` (`pedido`,`articulo`) con `Equivalencias_Codigos` para los NP de la **programación actual** (`PPP_Programacion_Diaria`) que **NO** están facturados (no en `Facturacion_NP`), y avisa por **Telegram** ("🧾 FACTURACIÓN — cambiá el código: NP X facturá 437E (no 029)") + **tablero Agentes** (categoría `equivalencia_facturar`, severidad media). Encadenada al **cron de agentes** (jobid 14, cada 2h), dedup por el set de (np|cod) del día; SECURITY DEFINER + revoke anon. Cliente: categoría agregada al array `CATS` de `agtRender` (icono 🧾). El picking ya resuelve planimetría/stock (v5.08/5.09); esto cubre la **facturación manual externa**. ⚠ `PPP_Base_Pedidos` = `pedido`(NP) · `articulo`(código) · `cajas` (las líneas del pedido). Detectó/avisó NP 97874 y 97898 (029→437E).
>
> Nota: **v5.09 — Equivalencias: el stock que baja es el REAL (437E/438E)**. Completa la v5.08: cuando se pickea un código de pedido (029), `stockBajaPicking` ahora resuelve `029→437E` al agregar las cajas pickeadas (`byArt[equivResolve(art)]`), así la baja de góndola (y el "a separar") es del **código real 437E** — físicamente eso sale. El resto del pipeline (a separar → a facturar → facturado) es **code-agnostic** (mueve lo que hay en cada depósito **por tanda**, vía `_stockNetoDepTanda`), así que el 437E fluye solo sin tocar TAP/facturación. `equivResolve` es **idempotente** (un código ya real se devuelve igual), así que no rompe los picks normales. **Faltantes y facturación siguen con el código del pedido (029)** — son otra dimensión (lo que pidió el cliente), separada del stock físico. La alerta SSG "sin stock en góndola" ahora referencia el 437E si se queda corto. Verificado checkhtml/smoke. (Tarea #38.)
>
> Nota: **v5.08 — Equivalencias de código cliente→interno (029→437E, 030→438E)**. El cliente pide un código que **no es de depósito** (029) pero físicamente se levanta/manda otro (437E = colador 16cm importado). Por eso saltaba **"SIN PLANIMETRÍA"** (029 no está en `planimetria.js`; 437E sí, sector F09). Solución: tabla Supabase **`Equivalencias_Codigos`** (`cod_pedido → cod_real + nota`, anon select; seed 029→437E, 030→438E), cargada al cliente (`_codeEquiv`, claves normalizadas **sin ceros a la izquierda**). El picking **RESUELVE** `cod_pedido→cod_real` para: (a) **planimetría/ubicación** (`gOf` cae a `equivResolve` → 029 ubica en F09 del 437E), (b) **alerta "sin planimetría"** (`pkNotifySinPlanim` no marca si resuelve; los genuinamente ausentes sí), (c) **cartel naranja** en el paso de picking: "👉 Levantá el **437E** — Colador 16cm importado (el cliente lo pidió como 029)". El código **trackeado** sigue siendo el del pedido (029) para faltantes/facturación — solo se resuelve para ubicar y no dar falsa alerta. Helpers `_equivNorm`/`equivLookup`/`equivResolve`/`loadEquivalencias`. **PENDIENTE (a confirmar con el dueño)**: que el picking **descuente el stock del código REAL (437E)** en vez del pedido (029) — sustitución de stock en `stockBajaPicking`/PKC. Verificado headless (resolución + alerta). ⚠ La alerta vieja de Telegram no se borra sola (ya se mandó); deja de re-saltar.
>
> Nota: **v5.07 — Fix CP: el faltante completado NO desaparecía (RLS) + refresh en vivo**. `Entregas_Virgilio` solo tiene RLS **INSERT/SELECT** para anon (no UPDATE) → el PATCH de `cpReduceFaltante` que bajaba `cajas_falto` se **rechazaba en silencio** y el faltante seguía en la lista de CP (reportado: "lo completaron pero no desapareció"). Fix: **RPC SECURITY DEFINER acotada** `cp_completar_faltante(p_id bigint, p_qty numeric)` (resta `cajas_falto` / suma `cajas_entregadas` por id, clamp 0; `grant anon`) en vez de abrir un UPDATE general a la anon key. `cpReduceFaltante` ahora la llama (`POST /rpc/...`). Además **`cpConfirm` pasa a async**: espera la baja y **REFRESCA la lista** (ya no cierra el modal) → el completado **desaparece a la vista** + banner verde "✓ N caja(s) …" (`.cp-done`) y se pueden completar **varios seguidos**. Verificado headless (RPC llamada, re-fetch, item fuera de la lista, banner). Las columnas `cajas_*` son `numeric` (el JSON las muestra como string). Apaga la alerta #28 al llegar `cajas_falto` a 0.
>
> Nota: **v5.06 — Botonera jerarquizada (primarios grandes / secundarios chicos)**. El dueño separó la botonera del operario: **primarios** (quedan grandes, como siempre, = ~90% del uso) y **secundarios** (más chicos, uso puntual). **Primarios**: `row1` EP·TP·AP·TAP·CR·CC + `row2` RT·RR·MG (picking/armado + carga/control + recepción/guardado). Debajo, separador **"acciones secundarias"** y **secundarios** (clase `.box-sm`): `row3` RI·EI·SC·**CP** + `row4` AT·PB·Limp·Perm·PC·CT. **CP** (Completar Pedido, v5.05) pasó a secundario con un **borde verde sutil** (`.box[data-code="CP"]`) para encontrarlo. Render: `BOTONERA_SECUNDARIAS={row3,row4}` marca qué filas van chicas; el loop agrega `.box-sm` + `data-code`. Verificado headless 430px. (Tarea #32.)
>
> Nota: **v5.05 — CP · Completar Pedido (agregar cajas que llegaron tarde a una NP armada sin facturar)**. Botón nuevo **CP** en la botonera del operario (**4ª fila**, verde, full-width) y en el panel de **Marianela** (sup-action "📦➕ Completar Pedido", abre con legajo `0`). Resuelve el caso de la alerta #28 (`falta_llego`): cuando un faltante llegó por recepción (quedó en *a guardar*) y el pedido sigue sin facturar, se lo suma al pedido. **Flujo** (modal `showCPModal`, abre directo sin pasar por Enviar): (1) elegir el **faltante** (lista de `Entregas_Virgilio.cajas_falto>0`, NP no facturada, fecha ≤21 d), (2) **cuántas cajas** llegaron (tope = lo que faltaba), (3) **de dónde salen** (Tránsito=`a_guardar` / Góndola=`terminado`, muestra el saldo de cada uno), (4) **a qué lío** va — chips con los líos actuales del pedido (leídos del TAL: `A=535X3;B=542X4…`) **o** 🆕 lío nuevo. **Al confirmar**: `stockMove` origen `−qty` / `a_facturar` `+qty` (tipo `cp`, ref=NP) · evento **`CP`** (texto `NP|cod|qty|GONDOLA|AGUARDAR|lío`) · **re-emite el TAL** del pedido con el lío actualizado (gana el más reciente) · **baja `cajas_falto`** (y sube `cajas_entregadas`) en `Entregas_Virgilio` por id → cuando llega a 0 **apaga la alerta #28**. Funciones `showCPModal`/`cpRender`/`cpRenderStep2`/`cpConfirm`/`cpUpdateLio`/`cpReduceFaltante`/`cpParseResumen`/`cpBuildResumen` (~9293). Parser de líos robusto (multi-item + sueltas `(s)`, separador `X`, letras A–Z luego `L27…`). Verificado headless 430px (paso 1, paso 2 con líos, paso 2 sin líos) + checkhtml/smoke verdes. **Pendiente**: cap de cantidad = lo que faltó (no permite agregar un código que no era faltante — caso raro, follow-up si hace falta).
>
> Nota: **v5.04 — Fix "la PPP no toma la zona nueva" (falsos SIN ZONA)**. El monitor PPP marcaba pedidos **SIN ZONA** (y los mandaba por Telegram vía PPE → `notificar_ppp_error_telegram`) usando **solo** el mapa de barrios del **cliente** (`pppZonaDeBarrio` → `PPP_BARRIO_ZONA` + overrides locales), **ignorando la columna `zona` que Supabase ya completó** por autozona (trigger `trg_ppp_autozona` + tabla `Zonas_Barrios`). Como veníamos agregando barrios a **Supabase** (ej. **José León Suárez**, Chilavert, Villa Sarmiento…) pero **no** al mapa hardcodeado del cliente, salían **falsos "9 SIN ZONA"** aunque en la PPP real (Supabase) **todos** tenían zona. Fix en `_pppComputeErrors` (index.html): "sin zona" **solo** si NI el barrio (cliente) NI la columna `zona` de Supabase la resuelven (`if (!zb && !zCol)`); y "zona distinta" solo si ambas existen y difieren (`zb && zCol && …`). Verificado contra los 113 pedidos: 0 sin zona reales; la **única** tanda mezclada legítima es **C67A** (Retira + Super, fechas 01/07 y 13/07). **Pendiente (follow-up)**: el mapa del cliente sigue usándose para **rutear/sugerir** tandas → sincronizar `Zonas_Barrios` (Supabase) hacia el cliente para que el ruteo también conozca esos barrios.
>
> Nota: **server-side (sin bump) — Agente de Ingeniería de Software (#35), 1ª auditoría**. Se montó el sustrato del agente que "revisa el programa y Supabase para encontrar defectos/mejoras" (`sql/auditoria_codigo.sql`). (1) Tabla **`Auditoria_Codigo`** = backlog PERSISTENTE de hallazgos (`area` codigo/supabase/seguridad · `severidad` · `estado` abierto/resuelto/descartado · `ubicacion` · `huella` única para upsert al re-correr). Vive aparte de `reporte_agentes` porque `generar_reporte_agentes()` hace delete+rebuild cada 2 h y borraría los del SE. RLS ON sin policy anon (notas internas; el digest las lee como owner). (2) Función **`auditoria_codigo_resumen_telegram(p_enqueue)`** = digest de los ABIERTOS por severidad (🔴/🟡/🟢, ícono por área 🔒/💻/🗄) → Telegram (dedup diario); SECURITY DEFINER + revoke anon. La llama el agente recurrente (web scheduled trigger, opción A) al terminar su pasada. (3) **Arreglado en el acto** (holes claros, patrón ya autorizado): **14 funciones cron/trigger-only de Telegram/agentes** (`notificar_*_telegram` ×10, `notificar_outbox_salud`, `generar_reporte_agentes`, `reporte_agentes_faltante_articulo/recepcion_absurda`) eran ejecutables por la **anon key** → revoke public/anon/authenticated + grant service_role + search_path fijo (migración `lockdown_cron_telegram_agentes_functions`; verificado que ninguna se llama desde el cliente y que los triggers se disparan igual); y **`vista_productividad_diaria`** había quedado **SECURITY DEFINER** tras el rebuild con dedup (regresión) → vuelta a `security_invoker` (sus 2 base-tables son anon-SELECTables). (4) **Reportado** (sembrado en `Auditoria_Codigo`, sin tocar, 11 abiertos): 1 alta de código = **`ocgRecompute` normaliza códigos de 3 formas distintas y las cruza** (index.html:7728, `007`≠`7` falla silencioso); media = fechas sin `timeZone` UTC-3 (3481/14803), URL/KEY Supabase triplicada (16578 vs 3379 + sw.js), 9 vistas SECURITY DEFINER por revisar, bucket público `remitos` lista archivos; baja = ~33 clases CSS muertas, 1 función muerta `_compLioReset`, search_path mutable en ~9 funciones, backup de horas sin RLS, y el tradeoff no-auth (la anon key escribe ~100 tablas). **Nada de TDZ nuevo** ni reglas CSS duplicadas (verificado). Confirmaciones limpias no se siembran.
>
> Nota: **v4.99 + server-side** — (1) **Columna "Total Stock"** en Stock y Compras → solapa Stocks: suma por código de todos los depósitos (Góndola+Excedente+Pickeados+A facturar+A guardar+Racks), destacada después de Descripción (`stkBodyStocks`). (2) **Zona automática en la PPP** (`sql/autozona.sql`, server-side, NO toca la app): el Excel ya **no carga la zona** — Supabase la deriva del **barrio** vía trigger `trg_ppp_autozona` en `PPP_Programacion_Diaria` (completa `zona` cuando llega vacía, no pisa una cargada). Mapeo en tabla **`Zonas_Barrios`** (barrio_norm→zona, 33 barrios del histórico, 0 ambiguos). Normalización `_norm_barrio()` = minúsculas + **sin tildes** (translate áéíóúü→aeiouu) + espacios. Barrio nuevo no mapeado → sin zona → salta la alerta `ppp_sin_zona` → se agrega 1 vez a `Zonas_Barrios`. (3) **Carga manual de stock**: se cargó "a guardar" (16 códigos, 2661 cajas, ref `carga manual a guardar 29/06`) y se descontó góndola por esas cantidades (ref `descuento gondola…`); los que sobraban de antes (121/550) se pusieron en 0 con ajuste (sin borrar historial).
>
> Nota: **v4.97–v4.98** — v4.97: el cartel "diferente a la mesa" pasa a **acción secundaria** (más finito/clarito, no compite con el botón verde). v4.98: **alerta "llegó un faltante, completá antes de facturar"** (`sql/falta_llego.sql`, `reporte_agentes_falta_llego()`): cruza lo que llegó y quedó en **'a guardar'** (`Movimientos_Stock`, respeta el cutoff) con los **faltantes por pedido** (`Entregas_Virgilio.cajas_falto>0`) de NPs **armadas y SIN facturar** (no en `Facturacion_NP`), match por código normalizado (upper + sin ceros a la izquierda). Avisa por **Telegram + tablero Agentes** (categoría `falta_llego`, severidad alta), encadenada al cron jobid 14 (cada 2 h), dedup por el set de (np|cod) del día; SECURITY DEFINER con revoke de anon. ⚠ `Entregas_Virgilio.fecha_salida` es **TEXT** → comparar con `left(...,10) >= 'YYYY-MM-DD'`, NO castear a date (si no, el `exception when others` lo tapa y nunca alerta).
>
> Nota: **v4.93–v4.96** — **Pulidos de Separar por NP (estética + UX)**. v4.93: el diálogo "diferente a la mesa" pide **"Levantadas según picking" (fijo) vs "Levantadas real" (input)** y la app calcula la diferencia. v4.94–v4.95: tarjetas de código más altas (casillero limpio) y **sin tic** — tocar cualquier parte de la tarjeta la marca **toda en verde**. v4.96 (pasada a fondo): **fix del `button` global** (`margin-top:14px` + `padding:16px`) que se filtraba a los botones del módulo y descentraba el switch (7px abajo) y las flechas del header; ahora las **flechas del header** son redondas y centradas, el **toggle** Modo picking/Por pedido queda alineado, "Sin faltantes" es un **estado vacío centrado**, y las **celdas separadas de la matriz** son pastillas redondeadas. Solo CSS/HTML.
>
> Nota: **v4.92** — **"Diferente a la mesa" en el paso Separar (completa el módulo Separar por NP, en main)**. En la vista "Por pedido" hay un cartel naranja **"⚠ Hay un artículo diferente a la mesa"**: el AP/TAP reporta (de a 1 artículo) que algo NO coincide con lo que marcó el picking (EP/TP) — NO es su error, sólo avisa y sigue (no lo frena). Flujo: cartel → elegir el artículo (grilla de la NP) → diálogo **de más / de menos** + **¿cuántas cajas?** + si es de menos **¿hay en góndola?** (sí/no) + **← Volver**. Persiste evento **opcode NPD** (`texto="NP|cod|tipo|gond|qty|sale|tanda"`). **Stock**: sólo "de menos + sin góndola" devuelve `qty` a góndola (`terminado`, `tipo='ajuste'`, ref `picking_difiere`) para no quedar negativo; "de menos + sí" NO descuenta (ya lo hizo el picking); "de más" no toca stock (se vuelve a guardar a mano). **Alerta** server-side `reporte_agentes_picking_difiere()` (`sql/picking_difiere.sql`): Telegram (digest del día, dedup por set de eventos) + tablero Agentes (categoría `picking_difiere`), encadenada al cron jobid 14 (cada 2 h); SECURITY DEFINER con revoke de anon. Funciones cliente `_compDif*`. Verificado headless (pick → diálogo → góndola → resolve sin errores) + parseo del digest en SQL.
>
> Nota: **v4.91** — **Paso "Separar por NP" en el wizard Completar (AP/TAP)** [CORE]. Nuevo **Paso 2** entre Faltantes y Líos (Líos pasa a **Paso 3**): antes de armar líos, el AP/TAP separa la mesa (mezcla de varias NPs) por pedido. **Dos vistas con estado compartido** (`c.sep` por código×NP) + toggle estilo iOS: **"Por pedido"** (grilla de una NP, 3 por fila, chips para elegir NP con sus cajas pendientes) y **"Modo picking"** (matriz códigos × NPs, columnas Cod+Tot fijas, scroll horizontal). Contador **"📦 N en mesa"** = cajas sin separar (global). Botón verde **"🔨 Armar líos con lo separado"** → Paso 3 con la NP actual. **Sólo lo separado pasa a Líos**: el grid y las sueltas de Líos filtran por `c.sep`; si quedan códigos sin separar aparece **"↩ Volver a separar · faltan N cajas"**. `liosDone` exige separar + lío de TODO (Terminar no se habilita si falta separar). Funciones `_compSep*` (`_compRenderSep`/`_compSepPedido`/`_compSepMatrix`/`_compSepTap`/`_compSepArmar`/`_compSepMesa`), nav `_compGo` ahora 1/2/3 + `_compNav(±1)`, CSS `.csep-*`. Verificado headless con `_comp` sembrado (las 2 vistas sincronizadas + filtro de Líos + nav). **PENDIENTE (próximo commit en la rama)**: flujo **"diferente a la mesa"** (reportar error del picking de a 1 artículo → de más/de menos → ¿hay en góndola? → Volver) + alertas Telegram/Agentes + reglas de stock (no descontar si el EP/TP ya descontó; devolver a góndola si no hay; sobra = volver a guardar).
>
> Nota: **v4.90** — **Fix wizard Completar (AP/TAP): el botón "Terminar" ya no obliga a entrar al paso Líos**. `liosDone` (lo que habilita Terminar) se calculaba recién al entrar al **Paso 2 (Líos)** → al abrir el wizard quedaba sin calcular y Terminar arrancaba **deshabilitado**; si **agarró 0 / todo faltó**, Líos quedaba vacío pero igual había que tocar "→" para destrabar (reportado por Marianela, tanda C58B "no la dejaba terminar"). Ahora `_compBuildLiosData()` se llama **al abrir** el wizard (y en el restore si se guardó en Paso 1) → `liosDone` correcto desde el arranque (Terminar habilitado directo cuando no hay nada que separar en líos). Si se **cambia un faltante** en el Paso 1 se marca `_comp._liosDirty=true` y se rearma la data de líos al entrar a Líos / al Terminar (evita armar líos con cantidades viejas; `_compRecalc` deja Terminar deshabilitado mientras esté `_liosDirty`). Solo timing de cálculo, no cambia el flujo de armado.
>
> Nota: **v4.85–v4.89** — **Rediseño del paso Líos (tap-to-add)**: cuadrados que **suman al tocar** (sin botones +/−), botón "−" en la esquina para corregir, **líos compartidos sin mínimo** (ej. 4 cajas de un código + 1 de otro), "↶ Deshacer", el "+ suelta" pasa a una **solapa "📦 Sueltas"** (cada suelta = 1 lío de 1 caja), **agrupación por composición** (líos idénticos comparten letra y se muestran ×N), vista "Editar líos generados". Fila de controles contextual (Armando/Editar/Sueltas) en lugar del botón "Armar líos". *(Detalle fino pendiente de volcar al cuerpo de la guía.)*
>
> Nota: **v4.84** — **Ruteo de reparto (orden óptimo de paradas + Google Maps) + alerta de PPP sin zona**. (1) **Ruteo** (módulo nuevo): para los pedidos que entregamos NOSOTROS, arma el **orden óptimo de paradas por camión** y abre la ruta en **Google Maps** (la navegación la hace Maps → sin API de ruteo paga). Vive en **Facturación** (botón "🗺️ Armar ruta de reparto de mañana", al lado de "Terminé — Generar PDF", donde Marianela cierra el día). Reusa la lógica de camiones existente (`pppResumenHtml`): rutas fijas **Sur/Oeste=Z1+Z3+Z4 · Norte=Z5+Z6+Z7 · Centro=Z2**, tope `CAP=pppGetCfg().dayCap` (6) m³/camión. **Excluye Retira/Súper/Expo** (se entregan aparte; Expo=exportación, p.ej. Bolivia). Lee `PPP_Programacion_Diaria` (`direccion/barrio/zona/m3/razon_social`) con `fecha_entrega`=mañana. **Geocoding en el NAVEGADOR** (Nominatim/OSM, sin API key — el sandbox no sale a internet, por eso va en cliente), cacheado en **tabla nueva `PPP_Geo`** (`dir_key,lat,lng`; RLS anon select+insert, CHECK de lat/lng). **Optimizador**: nearest-neighbor + 2-opt con haversine desde el depósito **Virgilio 2788, CABA**; parte cada ruta en camiones ≤CAP m³ contiguos. Salida: paradas numeradas con m³ + km estimados + botón "Abrir en Google Maps" (waypoints en orden, ida y vuelta al depósito). Las direcciones que no geocodifican se listan aparte para corregir en la PPP. Funciones prefijo `_rt`/`ruteo` (`openRuteo`/`ruteoLoad`/`ruteoRender`/`_rtOptimize`/`_rtGeocode`/`_rtMapsUrl`). ⚠ El geocoding NO se pudo testear desde el sandbox (Nominatim bloqueado) — **verificar en el navegador real** la 1ª vez (geocodifica ~54 direcciones, ~1/seg, después cacheado). (2) **Alerta "PPP sin zona"** (`reporte_agentes_ppp_sin_zona()`, `sql/ppp_sin_zona.sql`): cuando llega un pedido a `PPP_Programacion_Diaria` **SIN zona** cargada (no se puede rutear ni asignar camión), avisa por **Telegram** (digest deduped por el set de NPs del día) + tablero **Agentes** (categoría `ppp_sin_zona`). Server-side, encadenada al **cron de agentes** (jobid 14, cada 2h) → salta aunque nadie abra el monitor PPP. SECURITY DEFINER con `revoke` de anon (mismo patrón de seguridad que el resto de las funciones Telegram).
>
> Nota: **v4.83** — **Pasada de estética celular + PC (rol diseñador, 3 auditorías headless)**. Se renderizaron todas las pantallas a 390/460/1280/1920px con Playwright (3 subagentes `revisor-render`: operario / monitor / admin) y se arreglaron TODOS los hallazgos ALTA + varios MEDIA. **Operario (celular)**: la **botonera EP/TP** ya no clipa la última columna a 390px (`.row-6/5/4` con `minmax(0,1fr)` + `.box-desc` con wrap; cajas con radio 10px); **Control Remitos** trunca la Razón Social para que el checkbox CONTROLADO no quede fuera de pantalla; **Picking** dejó de escalonar el header de 2 columnas (`.pk-big-row` a `flex-start`); los **CTA deshabilitados** (MG/Insumos/Cervantes/Bajar Racks) pasan de texto blanco ilegible (1.48:1) a gris AA (`:disabled{color:#64748b}`); headers de `.tanda-modal` no montan el título sobre "Cerrar"; el botón "Salir" (`.auth-logout-btn`) deja de verse default del browser. **Supervisor/Monitor**: **Inconsistencias** — las pastillas de día dejan de heredar `button{width:100%}` (eran 7 botones full-width apilados) → chips, contraste TV subido; **PPP** — el pill "¡VENCIDA!" no se monta sobre la meta (`.ppp-tanda-h` track de fecha a `minmax(120px,max-content)`), las solapas envuelven en celular; **Análisis** — el botón "Cerrar" gigante (heredaba width:100%) → `width:auto`. **Admin/Datos** (era 5/10 en celular): las tablas densas de **OC** (6) y **Conteo** (2) van en wrappers con scroll horizontal (`.oc-tblwrap`/`.stk-tblwrap`) → ya no se ocultan columnas decisivas (%, Falta, A pedir, Sueltas, ✕); las **solapas de Stock** scrollean; números a la derecha (tabular) en `stk-tbl-fit`/`oc-tbl`; header de Agentes con ellipsis + Cerrar fijo. **Causa raíz** detectada: el `button{width:100%}` global (línea 25) se filtra a pantallas de supervisor que no lo sobreescriben — se parchó por componente (no se tocó la regla global, es deuda conocida). Verificado headless (0 overflow, divs balanceados) + `checkhtml`/`smoke` verdes.
>
> Nota: **v4.82** — **Premios por área (solo pantalla admin 📊) + lockdown de seguridad Telegram + estética móvil**. (1) **Premios**: cada área tiene una **meta m³/h** donde el premio es 0%; el premio % de cada operario = **(su ritmo ÷ meta − 1) × 100**, con signo (negativo si está por debajo). Ej. meta Picking 1.6: 1.6→0%, 1.76→+10%, 1.44→−10%. Metas **editables** arriba del tablero (default Picking **1.6** · Armado **0.7**), persisten en `localStorage 'prod_metas'`. Badges verde/rojo en tarjeta resumida, expandida y tabla. **NO se manda por Telegram** (solo la ve el supervisor). Helpers `_pvMetas`/`_pvPremio`/`prodSetMeta`/`premioBadge`. (2) **Seguridad** (migración `lock_down_telegram_report_functions`): se revocó `execute` de **public/anon/authenticated** en las 5 funciones `SECURITY DEFINER` que mandan Telegram o fuerzan reportes (`tg_enqueue`, `reporte_diario_telegram`, `reporte_semanal_telegram`, `reporte_agentes_rendimiento_anomalo`, `reporte_agentes_zona_lista`) — quedan solo `postgres` + `service_role`; los crons siguen andando. La anon key (pública en index.html/sw.js) ya **no** puede inyectar mensajes al grupo. `_es`/`_h` con `search_path` pinneado. (3) **Motor confirmado**: las interrupciones en el medio de un envase (carga/movimiento/comida/recepción/etc.) **se restan** del tiempo de la tanda. El app las guarda como **par** (fila "open" sin `ts_inicio` + fila "close" con `ts_inicio→ts_cliente` = la duración real); el motor usa el `close` y lo descuenta del envase. Ej. `8:10 EP, carga 8:40→8:50, 9:10 TP` → **picking = 50 min** (no 60). Generaliza a N interrupciones (resta la unión). Único caso que quedaría en 60: una tarea tapeada sin "close" (sin duración registrada) — raro.
>
> Nota: **v4.81** — **Fixes de render en productividad (auditoría) + smoke ampliado**. `revisor-render` encontró 2 bugs de CSS en la pantalla 📊 y se corrigieron: (1) [HIGH] la columna **"Operario"** de la tabla quedaba alineada a la derecha porque `.prod-tbl td{text-align:right}` le ganaba en especificidad a `.prod-tdn` → se agregó `.prod-tbl td.prod-tdn{text-align:left}`; (2) [MEDIUM] el **sparkline** se estiraba feo con pocas semanas (2–4 barras desparramadas en los bordes) → `.prod-sp` pasa de `flex:1` a `width` fijo (30px) y `.prod-spark` usa `justify-content:flex-start`. Smoke verde: se sumaron `prodCompute`/`prodLoad`/`prodExportCsv` al array `need` (`tests/smoke.cjs`) para proteger el motor nuevo de productividad. Solo CSS/tests, sin cambio funcional.
>
> Nota: **v4.80** — **Alerta "zona lista" (≥1 m³) + reporte SEMANAL por Telegram**. (1) **Zona lista** (`sql/zona_lista.sql`, `reporte_agentes_zona_lista()`): cuando una **zona** junta **≥1 m³** de pedidos pendientes **SIN fecha** de entrega, avisa que conviene programar el reparto. Va al tablero **Agentes** (nueva categoría `zona_lista`, una fila por zona, en `CATS` de `agtRender`) + **Telegram** (un mensaje con todas las zonas, 1 vez/semana, dedup). **Excluye "Retira"** (el cliente retira, no hay reparto). Umbral 1 m³ (constante en el `HAVING`). Enganchada al cron de Agentes (cada 2h) después de los demás `reporte_agentes_*`. (2) **Reporte semanal** (`sql/reporte_semanal.sql`, `reporte_semanal_telegram(p_lunes, p_enqueue)`): **lunes 8:00 AR** (cron `reporte-semanal-telegram`, `0 11 * * 1` UTC), resumen de la semana que terminó: total del equipo (m³, armadas, pickeadas), mejor pickeando/armando (piso 5 tandas) y una **tabla monoespaciada** por operario con m³ pick/arm, ritmo m³/h pick/arm y **tendencia vs semana previa** (↑/↓/=). Reusa `vista_productividad_semanal`; tabla vía `parse_mode=HTML` (`<pre>`).
>
> Nota: **v4.79** — **Nudge de cerrar armados al Terminar Día + export Excel/CSV en productividad**. (1) En **"Terminar Día"**, cuando un **Armado/Picking** queda para arrastrarse al otro día, se muestra un aviso al operario (banner ámbar) para que lo **finalice hoy** si ya lo terminó: dejarlo abierto cruza la noche y rompe la medición del ritmo (el caso C57A cross-day). (2) Botón **"⬇ Excel"** (verde) en la pantalla 📊 que baja la tabla del período a **CSV** abrible en Excel: columnas Operario, Legajo, Picking m³, Armado m³, Picking m³/h, Armado m³/h, Tandas; separador `;`, **coma decimal** (es-AR) y **BOM utf-8** (acentos). Helper `prodExportCsv()`; nombre de archivo `productividad_<d1>_a_<d2>.csv`.
>
> Nota: **v4.78** — **Reporte DIARIO por Telegram (server-side)**. Cron `reporte-diario-telegram` (**18:00 AR** = `0 21 * * *` UTC) que manda al grupo un resumen del día (`sql/reporte_diario.sql`, `reporte_diario_telegram(p_dia, p_enqueue)`): producción del día (m³ picking+armado), **PPP pendiente** (m³ + pedidos) y hasta qué fecha llega (días hábiles) + lo sin fecha, **ritmo necesario** (pendiente ÷ días) y si la producción lo cubrió/sobrepasó/quedó corto, **días para terminar la PPP al ritmo real** (m³ armado/día), pedidos con fecha lejana (outliers > hoy+21d), y **rendimiento por operario del día** (m³ pick/arm + m³/h, solo quienes trabajaron). Decisiones del dueño: "cubrir lo proyectado" = contra el ritmo necesario; "días según PPP" = hasta la última fecha programada + lo sin fecha. **m³ volumen** = todo lo cerrado en el día (incl. cierres cross-day como C57A=10,3 m³); el **m³/h** usa solo cierres mismo-día válidos. Vista nueva `vista_productividad_diaria` + helper `_es` (formato es-AR). **Follow-up (mismo bump)**: el rendimiento por operario pasa a **tabla monoespaciada** (bloque `<pre>`, columnas Pick/Arm = m³ y Pk/h/Ar/h = m³/h) vía soporte **opcional** de `parse_mode` en el pipeline Telegram: columna `telegram_outbox.parse_mode` + 4º arg `p_parse_mode` (default null) en `tg_enqueue`; `tg_outbox_flush` lo agrega al body solo si está seteado (las demás alertas siguen en texto plano). Helper `_h()` escapa SIEMPRE el texto dinámico cuando se manda con `parse_mode=HTML`.
>
> Nota: **v4.77** — **Productividad: sacar la columna "% prod" de la tabla**. El dueño no le encontraba sentido al % productivo como número suelto (lo preguntó dos veces), así que se quita de la **tabla** (vista 📊 Tabla). El desglose visual "en qué se va la jornada" (en la tarjeta expandida) sigue mostrando la parte productiva con contexto. El orden por defecto de la tabla pasa de `pct` a **Tandas** (`_prodSort` arranca en `{col:"tandas", dir:-1}`).
>
> Nota: **v4.76** — **Alerta de rendimiento anómalo (Agentes + Telegram)**. Detector server-side `reporte_agentes_rendimiento_anomalo()` (`sql/rendimiento_anomalo.sql`), enganchado al cron de Agentes (cada 2h) después de `generar_reporte_agentes`. Marca operarios con **m³/h por rol** muy bajo o muy alto, por dos criterios: **relativo** (fuera de **0.45× .. 2.2×** la mediana del rol, solo si el rol tiene ≥3 operarios y el operario ≥8 tandas con m³) o **absoluto** (valores imposibles = dato roto: armado <0.12 o >2.0; picking <0.18 o >3.5 m³/h). Avisa en el tablero **Agentes** (nueva categoría `rendimiento_anomalo` en `CATS`) y por **Telegram** (1 vez/semana por operario, vía dedup). Se calcula sobre `vista_productividad_semanal` (últimas 4 semanas). Con datos limpios **no marca a nadie** (la banda es pareja); salta cuando algo se va de rango o se rompe el dato.
>
> Nota: **v4.75** — **Productividad: orden Picking primero, después Armado**. Solo orden de display: se reordenaron todos los pares (los rates de cada tarjeta, las columnas de la tabla, las secciones Pickers/Armadores, el resumen del equipo, "mejor pickeando/armando" y la nota) para que **Picking** vaya primero y **Armado** después, como pidió el dueño. Sin cambio de cálculo.
>
> Nota: **v4.74** — **Productividad: textos en vez de logos**. Se cambiaron los íconos 🔧/🛒 por las palabras **Armado** / **Picking** (en color: armado violeta, picking azul) en toda la vista — la gente no entendía los logos. Y la tabla aclara que **% prod** = parte de la jornada que estuvo armando/pickeando.\n>\n> Nota: **v4.73** — **Productividad: vista TABLA (ranking)**. Toggle 📇 Tarjetas ↔ 📊 Tabla. La tabla lista a todos en filas, ordenable por columna (nombre, 🔧 armado m³/h, 🛒 picking m³/h, tandas, % prod color-coded). Tocás un encabezado = ordena; tocás una fila = abre la tarjeta del operario. `_prodTab`/`_prodSort`, `prodSetTab`/`prodTabSort`. Sirve para comparar a todos de un vistazo.\n>\n> Nota: **v4.72** — **Productividad: resumen ultra-compacto**. La tarjeta colapsada es ahora UNA línea: nombre + solo el/los **m³/h** (armado y/o picking), sin tandas/m³/horas. Se abre al tocar. Pocos-datos van atenuados.\n>\n> Nota: **v4.71** — **Productividad: tarjetas resumidas al entrar**. Cada operario entra **colapsado**: solo el nombre + los dos ritmos (🔧 armado / 🛒 picking). Al **tocar** la tarjeta (o "Ver detalle ▾") se expande con el sparkline + el desglose tocable. Estado `_prodExpand` (vacío = todas resumidas; se resetea al recargar período); `prodToggleOp(leg)`. Hace el módulo mucho más rápido de escanear.
>
> Nota: **v4.70** — **Productividad: desglose tocable + nombres más grandes**. (1) Los títulos **🔧 Armado**
> y **🛒 Picking** ahora son un header grande (15px, en color) arriba del número. (2) Cada color del
> desglose "en qué se va la jornada" (Productivo, Carga, Recepción, Comida, Ocio, etc.) es **tocable**:
> abre un panel con **de qué se compone** ese tiempo. Productivo → lista de tandas (m³ + tiempo asignado);
> tareas → cada evento con hora, código/NP y duración; Ocio → los huecos (hora + duración). El motor ahora
> devuelve `detail` por bucket (`prodDetail`/`detailPanel`, estado `_prodOpen`). Sirve para auditar (ej.
> ver que una tanda "armada" estuvo 4h abierta, o en qué se fue la recepción).
>
> Nota: **v4.69** — **Productividad: los DOS ritmos por separado**. Cada operario muestra **🔧 armado** y
> **🛒 picking** como **valores distintos** (m³/h cada uno, con su propia flecha de tendencia) — antes
> mostraba solo el del rol primario. Si un operario no hace una de las dos, esa línea no aparece. El resumen
> del equipo suma un **"Ritmo del equipo · 🔧 Armado X · 🛒 Picking Y"** (suma/suma), y "mejor armando /
> mejor pickeando" se eligen por el ritmo real de cada actividad (no por el rol). El motor ya calculaba
> ambos por separado (`armM3/armTimeM3` vs `pickM3/pickTimeM3`); fue solo cambio de `prodRender`.
>
> Nota: **v4.68** — **Productividad: MOTOR evento-por-evento + selector de período** (reescritura del
> cálculo). El módulo 📊 deja de leer la vista semanal y ahora trae los **eventos crudos** del período que
> elijas (desde/hasta, o presets 7d/4sem/8sem) y los procesa en el navegador con las reglas que definió el
> dueño: (1) el **"envase" AP→TAP / EP→TP ES la actividad** — los **huecos dentro del envase** (en horario
> de jornada, menos otras tareas) cuentan como **armado/picking, NO ocio** (un armador, si no hace otra
> cosa, está armando; por eso es habitual dejar un armado abierto al otro día); (2) **ocio** real = jornada
> con nada abierto; (3) **borde IZQ**: tanda que cierra adentro pero empezó antes del período → se descarta
> de inicio-de-jornada hasta el cierre (no se mide); (4) **borde DER**: tanda que abrió y no cerró → se
> descartan sus huecos. Tareas secundarias con **tope** (un MG de 5h = botón olvidado); TAP/TP **sin tope**
> (cruzan noches; las noches se sacan al intersectar con la jornada real, primer evento→FJ por día). m³ por
> tanda desde **`vista_tanda_m3`** = `PPP_Pedidos_Entregados` (entregado) **+ `PPP_Programacion_Diaria`** de
> respaldo (sube cobertura 93%→96%; arregla tandas armadas-no-entregadas tipo C57A=10,3 m³). Motor en
> `prodCompute`/`_pvOperator`/`prodLoad` (matemática de intervalos, prefijo `_pv`). Validado contra el día
> real de Farias Juan (leg 8): armado 0,66 m³/h con los huecos contados; borde izq excluye la mañana hasta
> cerrar la tanda. ⚠ Los nombres salen SIEMPRE de `Empleados` (`getEmpleadosNombres`); no hay nombres
> hardcodeados. La vista `vista_productividad_semanal` (v4.67) queda de referencia, ya no la usa la app.
>
> Nota: **v4.67** — **📊 "Rendimiento de operarios" reescrito (dashboard de ingeniería industrial, 100%
> Supabase)**. El servicio `openProductividad` (botón 📊) deja de mostrar conteo de tandas y pasa a un
> tablero serio para evaluar el rinde. **KPI rector = m³/h por ROL** (armador vs picker, nunca cruzados;
> toggle a **min/m³**, estado propio `_prodToggle`, no el `_mtsHoraFmt` del monitor). Por operario:
> headline m³/h + **flecha de tendencia** (última semana vs promedio previo = "¿bajó el ritmo?"),
> throughput (tandas, m³, min/tanda, jornadas), **sparkline semanal**, y **desglose "en qué se va la
> jornada"** (productivo + carga/control/movimiento/comida/recepción/limpieza/otros repartidos + **esperas /
> sin registrar**) = los **motivos de la ociosidad** que pidió el usuario. Resumen de equipo (m³, tandas,
> mejor armador/picker). Nombres de `Empleados` (`getEmpleadosNombres`). La vista
> **`vista_productividad_semanal`** se reescribió (ver `sql/productividad_operario.sql`): m³ desde
> `PPP_Pedidos_Entregados` (NO el Sheet); **tiempo EFECTIVO por unión de intervalos** (descuenta solapes +
> topes por actividad para botones abiertos); **bucket por `ts_cliente`** (no `created_at` — el backfill
> metía 415 eventos de 14 semanas en una sola); **m³ solo sobre tandas con duración válida** (consistencia
> numerador/denominador). Invariante garantizado: `prod_eff ≤ all_eff ≤ jornada`. Datos reales:
> armado 0.46–0.49 m³/h, picking 0.61–1.24; % productivo 18–57% (los bajos = mucha carga/control, lo
> explica el desglose). Verificado headless a 430 y 900 px, ambos toggles, sin overflow. El **otro** módulo
> (📈 Análisis, que usa el Sheet) NO se tocó: conviven los dos.
>
> Nota: **v4.66** — **Toggle m³/hora ↔ min/m³ en "Mts3 x Hora"** (monitor). En el panel de productividad
> del monitor (tabla "Mts3 x Hora" por operario + las "Parcial" del equipo, en `renderMonitor`) hay un
> **switch verde** en la cabecera que cambia la vista entre **m³ por hora** (default) y **minutos por m³**
> (= 60 / m³h). Reusa los m³/h que ya se calculan con **horas REALES de cada actividad**
> (`computeClosureDur` descuenta los tiempos muertos / interrupciones) — NO recalcula nada, solo invierte
> el número. Estado global `_mtsHoraFmt`, `toggleMtsHora()` (refresca el monitor), helper `prodVal()`.
> ⚠ Nota de arquitectura: la lógica buena de productividad (descontar interrupciones + m³ por tanda vía
> `tandaM3` del sheet) vive en el **módulo que ya existía** (`openAnalisis` / monitor), NO en el servicio
> `openProductividad` que se agregó antes (ese usa `vista_productividad_semanal`, con duración cruda
> `ts_inicio→ts_cliente` — sirve para tendencia semanal de tandas, pero NO para min/m³ fino). Por pedido
> del usuario se dejan **los dos** módulos por ahora.
>
> Nota: **Token de Telegram** (2026-06-28) — el usuario **rotó** el bot token (BotFather `/revoke`). El
> nuevo quedó en **Vault** (`telegram_bot_token`). Se validó con `getMe` (200). Alertas online.
>
> Nota: **v4.65** — **Agentes: `faltante_articulo`** (señal de reposición). Categoría nueva (la 19):
> agrupa los faltantes de picking (PKC) **por artículo** en 30 días → "art X faltó N cajas en M pickings".
> Distinto de `faltante` (que es por tanda, 7 días): este dice **qué códigos reforzar / revisar en la
> compra**. Función auxiliar `reporte_agentes_faltante_articulo()` encadenada en el cron 14 (junto a
> `reporte_agentes_recepcion_absurda`). Datos reales: 15 artículos (945E, etc.).
>
> Nota: **v4.64** — **Briefing "qué hacer hoy"** arriba del tablero Agentes (servicio: asistente diario).
> En `agtRender`, antes del termómetro, un bloque **📅 Hoy** con: (1) **nudge del día** — miércoles
> "generá las OCs", martes/jueves "día de conteo" (`new Date().getDay()`); (2) **to-do accionable** armado
> del mismo reporte: facturar (falta_facturacion), controlar remitos (carga_sin_control), guardar a góndola
> (mg_pendiente), cerrar armados (armado_sin_terminar). Convierte el tablero pasivo en "esto es lo que
> tenés que hacer hoy". Sin datos nuevos (reusa el reporte). Verificado con render.
>
> Nota: **v4.63** — **Servicio nuevo: Productividad por operario** (primer "servicio" más allá de alertas;
> de la idea del agente predictivo). Botón **📊 Productividad** en la botonera del supervisor →
> `openProductividad` (overlay azul, mismo patrón que Agentes). Lee la vista nueva
> **`vista_productividad_semanal`** (`security_invoker`): por legajo y semana ISO (últimas 8, excluye
> legajos 0/1) cuenta **TAP=armadas** y **TP=pickeadas**, y la **mediana de min/armado** (de `ts_inicio`→
> `ts_cliente` de los TAP, filtrando duraciones 1 min–12 h para sacar los "se olvidaron de cerrar").
> `prodRender` muestra una tarjeta por operario con rol (Armador/Picking según qué hace más), la última
> semana y un mini-gráfico de barras por semana (violeta=armadas, azul=pickeadas, escala por-operario).
> Sirve para "ver quién rinde sin pararse al lado". Datos REALES: 5 meses de log; se ve la especialización
> (237 armador, 104/270 picking) y la velocidad (104 ≈14 min/armado, 8 ≈104). ⚠ **SUPERADO por v4.67**:
> ahora los m³ SÍ entran (desde `PPP_Pedidos_Entregados`, no el Sheet) y el KPI es m³/h por rol; el
> `prodRender` de tandas/barras se reemplazó por el dashboard.
>
> Nota: **v4.62** — **Agentes: pendientes que se traban + recepción rara** (de la investigación con agentes).
> `generar_reporte_agentes` sumó 5 categorías (ahora 18): **`mg_pendiente`** (mercadería en `a_guardar` sin
> subir a góndola >8 h — bloquea stock disponible), **`armado_sin_terminar`** (AP sin su TAP >24 h),
> **`pipeline_atascado`** (separar_pedidos/a_facturar sin avanzar >2 días — *future-ready*: esos depósitos
> todavía no se usan), **`excedente_estancado`** (excedente sin moverse >5 días — *future-ready*), y
> **`recepcion_absurda`** (recepción con cantidad ≤0 o muchísimo mayor a lo normal). Esta última además
> tiene **alerta Telegram inmediata**: trigger `trg_recepcion_absurda_telegram` en `Movimientos_Stock`
> (AFTER INSERT, tipo='recepcion'), umbral = `max(10× mediana del artículo, 1000)` o `delta≤0`. ⚠ El trigger
> está **blindado** (`exception when others then return new`) para NO bloquear jamás una recepción. La
> categoría `recepcion_absurda` se encadena en el cron (jobid 14) vía función auxiliar
> `reporte_agentes_recepcion_absurda()` (para no re-tipear la función gigante). El termómetro NO cuenta
> estas categorías (son "pendientes/rarezas", no errores de operario). `mg_pendiente`/`armado_sin_terminar`
> dan 0 en el sandbox (datos de prueba con legajo 0, excluidos) pero disparan con datos reales.
>
> Nota: **v4.61** — **Alerta "recibido sin planimetría" (RSP)**. Completa lo que en v4.60 quedó pendiente:
> ahora la **recepción** (`recepcion.js opEnviar`, tras grabar a `a_guardar`) chequea cada código recibido
> contra `window.GONDOLA` (la planimetría = planimetria.js + merge Supabase) y, si alguno NO tiene lugar,
> emite un evento `RSP` (`texto = remito|cod1,cod2`). Nuevo trigger `trg_recepcion_sin_planim_telegram`
> (función `notificar_recepcion_sin_planim_telegram`, opcion='RSP') → Telegram "📦🗺 RECIBIDO SIN
> PLANIMETRÍA". Ya aparece también en el tablero **Agentes** (categoría `sin_planimetria`, que une PSP de
> picking + RSP de recepción). Diferencia con PSP: PSP detecta en el **picking** (la tanda trae códigos sin
> sector); RSP detecta en la **recepción** (llegan códigos sin sector) — más temprano. (`recepcion.js?v=3.66`.)
>
> Nota: **v4.60** — **Agentes = espejo de TODO Telegram** (regla del usuario: "todo lo que va por Telegram
> también lo toman los agentes"). El reporte `generar_reporte_agentes` (cron c/2h) pasó de 6 a **13
> categorías**: se sumaron las que solo iban a Telegram → `excedente` (Movimientos_Stock, góndola llena),
> `carga_sin_control` (★ medido por **estado**: CCN cargado al camión sin su CRN de control >30 h, no por
> el evento CRA que casi no se emite), `mg_fuera_lista` (MGX), `picking_sin_stock` (SSG), `ppp_error`
> (PPE, último chequeo), `sin_planimetria` (PSP picking **+ RSP recepción**), `falta_facturacion`
> (entrega hoy/mañana con armado TAP sin `Facturacion_NP`). Además se **corrigió `faltante`**: ahora
> filtra `rea<esp` (antes mostraba PKC que NO eran faltante, ej. "puso 1 de 1"). El overlay `agtRender`
> lista las 13 con su color/ícono/hint, y el **termómetro de estabilidad** ahora cuenta los errores de
> operario reales (`error_envio` + `picking_sin_stock` + `carga_sin_control` + `mg_fuera_lista` +
> `error_app`), no solo crashes/envíos. Mapa completo de alertas Telegram ↔ categoría Agentes en
> `generar_reporte_agentes`. Pendiente: detección de "recibido sin planimetría" en `recepcion.js` (emite
> `RSP`, la categoría ya lo contempla). ⚠ Hallazgo de seguridad (de paso): el **token del bot de
> Telegram estaba hardcodeado** en `tg_outbox_flush()` — **✓ RESUELTO el 2026-06-28**: se movió a
> **Supabase Vault** (secreto `telegram_bot_token`); `tg_outbox_flush` lo lee con
> `select decrypted_secret from vault.decrypted_secrets where name='telegram_bot_token'` y, si no lo
> puede leer, **no envía** (los mensajes quedan `pending` y los levanta la categoría `outbox` de Agentes).
> Verificado end-to-end: envío de prueba a Telegram OK (HTTP 200). El `chat_id` default sigue en
> `tg_enqueue` (menos sensible). **Token de seguridad de Telegram = NO está más en el código.**
>
> Nota: **v4.59** — **Optimización: más código y CSS muerto** (sin cambio de comportamiento; sigue de
> v4.58). (1) Funciones: se removió `idbGetAll` (helper de IndexedDB sin caller en la página — el flush
> por `getAll` lo hace el SW) y el **modal standalone `showLiosModal`** (+ `_liosId`/`liosRender`/
> `liosClose`/`liosSave`), inalcanzable desde v4.03 cuando los líos se metieron en el wizard Completar.
> ⚠ Se **conservaron** `liosSend` (lo llama el wizard Completar) y `let _lios` (lo lee un guard de
> salida). (2) **CSS**: se borraron **73 reglas muertas** (~7,5 KB) de los 2 bloques `<style>` reales —
> restos de layouts viejos ya reemplazados: `fac-group*`/`fac-tanda-*`/`fac-progress` (Facturación),
> `monitor-totales`/`monitor-tot-*`/`totales-*`/`monitor-charts-col`/`day-box-clickable` (totales),
> `monitor-legend`/`legend-*`/`status-pend`, `monitor-tab*`/`incons-badge` (inconsistencias),
> `pk-fq`/`pk-fq-input`/`pk-prog`/`pk-sector-exc` (picking viejo), `ppp-res*`/`ppp-map*`/`ppp-prev*`/
> `ppp-subir-btn`/`ppp-over`/`ppp-diag-h`/`ppp-imp-row`, `recp-admin-frame`/`recp-choice*`/`recp-chooser`,
> `auth-user-*`, `comp-l*`, `lios-inp`/`lios-row`. Método: detector whole-word + guard anti
> concatenación-dinámica (ej. `inc-row-${sev}` se preservó) + chequeo de llaves balanceadas + smoke +
> render. Pendiente menor: ~15 clases muertas que viven en CSS inyectado por JS (`mg-*`, `ins-*`,
> `stk-ini*`). (`SW_VERSION` v4.59-vir.)
>
> Nota: **v4.58** — **Limpieza de código muerto** (auditoría de consistencia, sin cambio de comportamiento).
> Se removieron ~135 líneas sin uso de `index.html`: `readLastLegajo`, `closeCompletar` (duplicado exacto
> del cierre inline del wizard Completar), `toggleMonitorTV` (+ su botón `btnMonitorTV` que ya no existía;
> el modo TV se entra por otro lado), `pppMapProg`, y todo el **island de scaffolding de mapeo de la PPP**
> (`pppShowMapping`/`pppApplyMapping`/`pppRenderBase` + helpers `_pppGuessMap`/`_pppColSamples`/
> `_pppColLetter` + `PPP_FIELDS`/`PPP_MAP_KEY`/`_pppRawProg`) — restos del módulo PPP v2.95 "NO activado",
> reemplazado por `pppMapBase`+`pppBuildProg`. ⚠ El cluster `showLiosModal` (que la auditoría marcó muerto)
> **NO se tocó**: `liosSend` lo llama el wizard Completar y `_lios` se lee en un guard de salida — borrarlo
> rompía código vivo. **Pendiente detectado (no es limpieza)**: `pppSubir` (subir la PPP a Supabase con
> verificación, v4.55) **no tiene botón que lo llame** — la importación in-app hoy queda "solo local". Hay
> que cablearlo o decidir descartarlo. (`SW_VERSION` v4.58-vir.)
>
> Nota: **v4.57** — **Agentes = tablero de estabilidad** (hacia "soltar lo manual"). El objetivo del
> usuario es dejar de controlar a mano, pero para eso necesita ~2 semanas sin que los operarios marquen
> errores que hoy **no se ven**. Por eso el reporte de Agentes (`generar_reporte_agentes`, cron c/2 h)
> ahora suma 3 categorías y un termómetro: **`error_envio`** (📡 envíos de operarios que fallaron y
> quedaron en `Auditoria_Produccion_Virgilio`, últimos 7 días, excluye legajos 0/1 — "lo que hoy no
> ves"); **`faltante`** (🚚 faltantes de picking `PKC`, 7 días); **`oc_baja`** (📉 OCs con <50% recibido).
> El overlay (`agtRender`) muestra arriba un **termómetro de estabilidad**: cuenta tipos de error de
> operarios (`error_app` + `error_envio`) en 7 días → verde "✓ 0 errores … buena señal para ir soltando
> lo manual" / ámbar "⚠ N tipo(s) … revisalos antes de soltar lo manual". Se le aplica `artNombre` a
> `stock_negativo` y `oc_baja` (muestran descripción del artículo). **Además** se corrigieron los 3
> saldos negativos que había (222, 503E, 702E) con movimientos de ajuste en `Movimientos_Stock`
> (`tipo='ajuste'`, ref `fix-neg`) → 0 negativos. (`SW_VERSION` v4.57-vir.)
>
> Nota: **v4.56** — **Control de la PPP contra el espejo**. En el menú de importación de la PPP,
> `pppShowBaseInfo` ahora además **cuenta en vivo** lo que hay en las 3 tablas de Supabase
> (`pppRenderSupaCounts` → "🛰 En la PPP ahora: Base X · Programación Y · Entregados Z filas"), o sea **lo
> que cargó el espejo** (sync automático del Excel) o el último import. Así el supervisor ve si la PPP
> tiene datos y los puede cotejar contra el Excel antes/después de importar (complementa la verificación
> post-import de v4.55). Decisión del usuario: por ahora **sigue cargando en el Excel** (el espejo
> sincroniza); la carga manual sin Excel queda para más adelante.
>
> Nota: **v4.55** — **Validación de carga a la PPP** (hacia "eliminar el Excel"). La **doble vía** ya
> existía: picking y programación leen de Supabase (`PPP_Base_Pedidos`, `PPP_Programacion_Diaria`,
> `PPP_Pedidos_Entregados`) con fallback a Sheets, y el importador in-app (`pppSubir`) sube el Excel a
> esas tablas (DELETE+INSERT con el JWT del supervisor) — ⚠ pero `pppSubir` **hoy quedó sin botón que lo
> dispare** (ver la nota v4.58 más arriba); la carga real a la PPP la hace el espejo del Excel, no este
> importador in-app. **Lo nuevo** en v4.55: `pppSubir` ahora **verifica** que
> la carga realmente entró — después del INSERT re-cuenta en Supabase (`pppCountTable`, Content-Range
> con `Prefer: count=exact`) y compara contra lo que mandó: si coincide dice **"✓ VERIFICADO: N filas"**,
> si no, avisa **fuerte** ("⚠ subiste N pero quedaron M — algo falló"). Antes decía "✓ Listo" usando el
> conteo local (podía mentir si el INSERT fallaba en silencio). Pendiente (más grande, a confirmar):
> **carga manual** de picking/programación sin Excel (data-entry directo en el programa).
>
> Nota: **v4.54** — **Override de barrios mal escritos + tidy en errores** (sigue de v4.53). (1) Si un
> barrio viene con **typo** que no matchea ninguno conocido, ahora se puede **corregir**: en la celda de
> Zona de los pedidos sin reconocer hay un botón **✎** → `pppCorregirBarrioNp(np)` pide el barrio
> correcto (de la lista conocida) y guarda un **alias** (localStorage `vir_ppp_barrio_alias`, typo →
> barrio canónico). De ahí en más ese barrio toma **nombre canónico + zona** solo (`pppAliasResolve`
> lo consulta desde `pppZonaDeBarrio` y `pppLocDisp`). (2) El **display prolijo** (`pppLocDisp`) se
> aplicó también en los **mensajes de error** de la PPP (antes mostraban el barrio crudo). Nota: "barrios
> sin mapear en Agentes" NO se hizo: el reporte de Agentes corre en el server (cron) y el diccionario de
> barrios vive en el front — se surfacean y corrigen en la PPP misma (el ✎ + el desplegable de zona).
>
> Nota: **v4.53** — **Barrio/Localidad prolijo en la PPP**. Aunque en el Excel venga en MAYÚSCULAS, con
> acentos raros, paréntesis o variantes, ahora se muestra lindo: `pppLocDisp(s)` → si el barrio es
> **conocido** (está en `PPP_BARRIO_ZONA`, ~85) devuelve el **nombre canónico Title Case** (con acento
> donde corresponde, ej. `MORÓN`/`moron` → *Morón*, `JOSE C PAZ` → *José C. Paz*, `NUÑEZ` → *Núñez*);
> si **no** lo conoce, lo pasa a **Title Case** respetando conectores (`de`/`del`/`la`…) y preservando
> acrónimos cortos en mayúscula (`(CABA)`, `GBA`). Se aplica solo al **display** de las filas
> (`escapeHtml(pppLocDisp(p.localidad))`); el **matcheo de zona NO cambia** (sigue con `pppNormBarrio`
> sobre el crudo). Typos que no normalizan a un barrio conocido se ven en Title Case pero no se
> autocorrigen (para eso sirve el override de zona ya existente).
>
> Nota: **v4.52** — **“🤖 Agentes” pasó a botón propio** (no más solapa de Stocks). Botón en el panel de
> supervisor (sección *Reportes y configuración*) → `openAgentesAdmin()` abre un overlay propio
> (`agentesAdminOverlay`, header teal) con el mismo reporte. Funciones: `openAgentesAdmin` /
> `closeAgentesAdmin` / `agtFetchReporte` / `agtRender`. El backend (tabla `reporte_agentes` + cron)
> no cambió.
>
> Nota: **v4.51** — *(movido a botón en v4.52)* **Solapa “🤖 Agentes”** en *Stock y Compras* (2da, después de Stocks): **reporte de
> cosas para mirar**. Lee el snapshot `reporte_agentes` (tabla curada, SELECT anon — NO expone las
> tablas crudas) que genera la función `generar_reporte_agentes()` (SECURITY DEFINER, lee
> `vista_saldos_stock` / `errores_cliente` / `telegram_outbox` como owner y escribe un resumen) por
> **cron cada 2 h** (`generar-reporte-agentes`). 3 secciones color-codeadas: **⚠ Stock negativo**
> (saldo imposible), **🐛 Errores de la app** (últimos 7 días, agrupados por mensaje), **📨 Telegram sin
> enviar** (outbox trabado >15 min). Front: `stkBodyAgentes()` + `stkLoadReporte()`. Si no hay nada,
> muestra "Nada para mirar 👍". `generar_reporte_agentes` no es ejecutable por RPC (revocado de PUBLIC).
>
> Nota: **v4.50** — **Robustez/infra (4 cosas).** (1) **Vista de saldos** `vista_saldos_stock`
> (`security_invoker`, SELECT anon): suma `delta` por depósito en el SERVER respetando el cutoff de
> `Stock_Config` (misma lógica que `stockComputeSaldos`). El front tiene `stockFetchSaldos()` y los
> módulos que solo necesitan saldos (MG, bajar racks, insumos, salida Cervantes) ahora bajan **~1 fila
> por artículo** en vez de las ~20k de `Movimientos_Stock`. El admin de Stocks sigue con los
> movimientos (muestra el detalle). (2) **Baliza de errores**: tabla `errores_cliente` (INSERT anon) +
> `logClientError` enganchado a `window.onerror`/`unhandledrejection` → manda los crashes de JS
> (pantallas en blanco) a Supabase, best-effort, tope 25/sesión. Se leen del dashboard/MCP. (3)
> **Anomalías de stock**: función `check_stock_anomalias()` + cron `check-stock-anomalias` (diario
> 11:00 UTC / 08:00 AR) → si hay **saldos negativos** (imposibles) avisa por Telegram (outbox, dedup
> por día). (4) **6 sub-agentes** de revisión en `.claude/agents/`: `revisor-render`, `guardian-stock`,
> `auditor-supabase`, `guardian-tests`, `auditor-consistencia`, `keeper-guia`. **Hardening de seguridad**
> (de la auditoría del `auditor-supabase`): las funciones internas de Telegram/anomalías (`tg_enqueue`,
> `tg_outbox_flush`, `check_stock_anomalias`, `notificar_excedente_telegram`) ya **NO son ejecutables
> vía RPC** (se revocó `EXECUTE` de `PUBLIC`; corren solo desde sus triggers/cron como owner) y tienen
> `search_path` fijado; y `telegram_outbox` pasó a tener **RLS prendida** (la app no la toca directo;
> solo la usan esas funciones `SECURITY DEFINER` y el cron). La vista `vista_saldos_stock` fue
> **validada por el `guardian-stock`**: coincide 100% con `stockComputeSaldos` (288 art, 0 diferencias).
>
> Nota: **v4.49** — **Rediseño del paso de picking** (`pkRender`). (1) Cabecera: **SECTOR (sin guion) a la
> izquierda + CÓDIGO a la derecha**, ambos grandes (`bigRow`, reusado en el paso normal y en la pantalla
> de Faltan). (2) **3 botones** en fila: **Sin Stock** (rojo, `pkSinStock` → registra 0 y avanza =
> faltante completo) · **Faltan** (ámbar) · **✓ Puse N** (verde, `pkOk`). Tanto Puse como Confirmar de
> Faltan llaman a `pkAdvance()` → **saltan solos** al siguiente. (3) **Faltan** (`fInput`): dos cuadros —
> **PUSE** (input) + **FALTAN** (automático = pedido − puse, `pkFaltanCalc` en vivo). (4) **Próximas
> ubicaciones** abajo (`pkNextHtml`, hasta 4: sector + código + cajas). (5) **Excedente**: si está
> **registrado** (de stock), el paso de góndola dice "(hay N en excedente <ubic>)" y, si cubre todo, el
> paso pasa a **"Salteá la góndola — hay excedente en <ubic>"**; el botón manual **"Tiene Excedente"**
> (`pkMarkExcedente`, pop-up de ubicación → paso al final) aparece **solo si NO hay excedente
> registrado**. (6) De los 4 botones se puede **volver** (← Atrás / Volver / Cancelar el pop-up /
> destildar el excedente con `pkUnmarkExcedente`). Sin cambios de datos.
>
> Nota: **v4.48** — **Picking: botón “Tiene Excedente” + ajuste de alineación del MG**. (1) En cada
> paso del picking (no en los de excedente) hay un botón **“📦 Tiene Excedente — anotar ubicación”**:
> como todavía no está cargado qué artículos tienen excedente, el operario lo marca a mano → **pop-up**
> (`prompt`) que pide la ubicación (1 letra + 2 letras) → agrega un **paso de excedente al final** del
> picking para ir a buscarlo ahí (`pkMarkExcedente`, reusa el render `isExc`; `manualExc=true`,
> `key=art·EXC`, `esp` = el pedido como referencia). ⚠ Pendiente a confirmar: la cantidad objetivo del
> paso manual usa el pedido (no resta lo de góndola). (2) MG: el recuadro **“¿Hay Excedente?”** estaba
> levemente más abajo que el de Góndola → se alineó (label arriba como “GÓNDOLA”, tilde en una caja de
> 50px igual que el stepper) y se centraron los textos.
>
> Nota: **v4.47** — **MG botonera en 2 estados** (pedido del usuario sobre la v4.46). Por defecto cada
> código muestra el stepper de **Góndola grande y centrado** (caja verde) y a la derecha un recuadro
> **“¿Hay Excedente?”** con un tilde. Al tildarlo (`mgToggleExc`/`excOn`) la fila pasa a **2 columnas**
> Góndola | ☑ Excedente + la **ubicación** abajo (el layout que el usuario eligió). Destildar (tocar
> “☑ Excedente”) vuelve al estado por defecto y resetea. La alerta Telegram de excedente (v4.46) no
> cambia: salta al guardar con excedente > 0.
>
> Nota: **v4.46** — **MG rediseñado + alerta de excedente por Telegram**. (1) **Excedente opt-in**: la
> tarjeta de *Guardar a góndola* ahora muestra **solo el stepper de Góndola** por defecto; el de
> Excedente y la ubicación están ocultos detrás de un **tilde** "¿Va algo a EXCEDENTE? (góndola
> llena)". Tildarlo los revela; destildarlo resetea (`mgToggleExc`, campo `excOn`). Layout apilado
> (etiqueta izq + stepper der) → se fue el "zigzag" Góndola/Excedente que era horrible. (2) **Alerta
> Telegram de excedente**: trigger `trg_excedente_telegram` en `Movimientos_Stock` (AFTER INSERT WHEN
> `deposito='excedente' AND delta>0 AND tipo='guardado'`) → arma el mensaje con el nombre canónico
> (vista) + cajas + ubicación + legajo y lo encola en el outbox (`tg_enqueue`, dedup por `id`). Salta
> **al guardar** con excedente (góndola llena) — no en el tilde, así lleva la cantidad y la ubicación
> y nunca es falso positivo. El *fuera de lista* sigue con su propia alerta MGX (no se duplica).
>
> Nota: **v4.45** — **Barrido de estética (resto de pantallas)**, vía auditoría con sub-agentes en
> paralelo. Arreglos concretos: (1) **`fichadas-monitor.html`**: `colspan` de las filas de sección/
> espaciador/empty estaba en **17** cuando la tabla tiene **18 columnas** → cada banda de sección
> quedaba corta una celda a la derecha. Corregido a 18. (2) **Recepción (`recepcion.js`)**: el `⏱ X hs`
> de demora salía en **18px** dentro de una línea meta de 13px (desalineado) → bajado a 14px; los
> botones de código (`.opCodeBtn`) podían desbordar con códigos Log/Fabr largos → `overflow-wrap`; el
> footer de "Listo" (Cerrar/Anular/Cargar otra) no envolvía y tenía alturas distintas → `flex-wrap` +
> altura pareja (52px). **Quedó FLAG (no tocado)**: densidad de la botonera (row-6 Virgilio / row-5
> Cervantes — diseño establecido), recorte de "Mts3 x Hora" en el monitor con muchos operarios (layout
> afinado para la TV — verificar en la TV real), y los issues de **Cervantes** (es una copia: se
> arreglan upstream en `Registro-Produccion-2.0` y se re-sincroniza).
>
> Nota: **v4.44** — **Nombres consistentes también en operario**. El lookup `artNombre` (vista
> `vista_nombres_articulos`, ver v4.43) ahora también se usa en los módulos **operario** que muestran
> artículo terminado: **MG (Guardar a góndola)** y **Bajar racks → góndola**, más la fila de
> aprobación de bajadas en el admin de Racks. Antes mostraban la descripción del movimiento (Excel) y
> quedaban inconsistentes con el admin. *Picking* sigue sin nombre (es por **código + sector**, a
> propósito) e *Insumos* mantiene su propio nombre (no son artículo terminado, no van por la vista).
>
> Nota: **v4.43** — **Nombres de artículo: fuente corregida**. La v4.41 sacaba la descripción de
> `Articulos_Cajas`, que **tiene códigos duplicados** (ej. `026` aparece como *Colador N°8* y también
> como *Pinza de Fideos*) → el lookup agarraba el equivocado y mostraba **nombres mal**. Se reemplazó
> por una **vista en Supabase**, `vista_nombres_articulos` (`security_invoker=true`, SELECT para
> `anon`), que resuelve el nombre por **prioridad en el server**: **`E. Madre LK` > `Articulos
> Virgilio X Tallerista` > `OC_Maximos` (Excel)**, ya deduplicada y 1 fila por código normalizado
> (mismo normalizado que `_ocgNorm`: upper+trim+saca ceros a la izquierda). Cobertura: 279 nombres de
> E. Madre LK, 123 de Virgilio x Tallerista, 23 del Excel (425 códigos). `loadArtNombres()` ahora hace
> **un solo fetch** a la vista. Si se quiere cambiar la prioridad o sumar tablas, editar la vista (no
> el front). `artNombre(cod, fallback)` sigue igual.
>
> Nota: **v4.42** — **Pasada de estética en la solapa Stocks**. (1) La tabla de stock se salía del
> card y **clipeaba la columna Racks**: se bajó el padding de las columnas numéricas (16→9px), se
> acotó el ancho de Descripción (300→210px) y se envolvió en un contenedor con scroll horizontal
> (`.stk-tblwrap`) para que nunca se corte. (2) Los artículos **solo-insumos** (y cualquiera en 0 en
> todos los sectores) **ya no aparecen como filas todo-cero** en la tabla principal — solo se ven en
> su sección *Insumos*; siguen siendo encontrables con el buscador. (3) Se agregó padding base a
> `.stk-tbl td` (antes solo lo tenían las filas `.stk-row`), arreglando el choque "−20tanda" en
> *Salidas* y la falta de aire en *Racks*/*Insumos*. Sin cambios de datos ni de lógica.
>
> Nota: **v4.41** — *(⚠ fuente superada por v4.43 — `Articulos_Cajas` tenía duplicados)* **Nombres de artículo desde Supabase** (fuente única de descripciones). Lookup vivo
> `loadArtNombres()` / `artNombre(cod, fallback)`: arma un mapa `cod normalizado → descripción` desde
> **`Articulos_Cajas`** (`Cod_Art`/`Descripcion`, 361 artículos, la lista más completa) y, para los que falten,
> el **objetivo del Excel** (`OC_Maximos.descripcion`). Se carga junto al admin (`openStockAdmin` / `openOCAdmin`,
> dentro del `Promise.all`) y reemplaza al `desc` que venía en cada fila en **todos** los módulos: Stocks
> (góndola/insumos/racks), detalle por sector, generador de OCs, índices y % entregas. Si un código no está en
> ninguna tabla, cae al `desc` propio de la fila (movimiento/OC). No copia datos: es solo lectura. Normaliza el
> código con `_ocgNorm` (saca ceros a la izquierda) para que matchee igual que el resto del stock.
>
> Nota (repo, 2026-06-27) — **Suite de smoke-tests** en `tests/` (`bash tests/run.sh`): `node --check sw.js` +
> `checkhtml.cjs` (sintaxis de los `<script>` inline del index.html — lo que más rompe) + `smoke.cjs` (Playwright:
> funciones clave existen, sin errores de página, `stockComputeSaldos` ok). Correr antes de pushear. Ver
> `tests/README.md`.
>
> Nota: **v4.40** — **% de entregas de OCs** (vista **📊 % Entregas** en el módulo de OCs). Cruza lo **pedido**
> (`Ordenes_Compra.cantidad`) contra lo **entregado** (`cantidad_recibida`) por artículo y global → % de
> cumplimiento del proveedor. Ordenado por peor %. `ocEntregas`/`ocBodyEntregas` (`_oc.view==='entregas'`).
> `Ordenes_Compra` retiene el histórico de OCs (es el archivo). ⚠ Si en el futuro se borran OCs viejas, habría
> que agregar una tabla snapshot para no perder el histórico del %.
>
> Nota: **v4.39** — **Módulo de Conteo de stock** (solapa **📋 Conteo** en *Stock y Compras*; la empleada cuenta
> martes/jueves). Formato planilla (como el repo `Planilla-Conteo-Cajas`): filas **Sector · Código · Pilas ·
> Cjas×Pila · Sueltas** → **cajas = pilas×cjas/pila + sueltas**. Botón **"Comparar con el sistema"** → tabla
> **Contado vs Sistema (góndola+excedente)** con la **diferencia** y lo **"en proceso"** (Pickeados + A facturar,
> que no está en la góndola). **Guardar** → tabla `Conteo_Stock` (`sesion, legajo, cod, sector, pilas, cjas_x_pila,
> sueltas, cajas`; RLS read+insert anon). `stkBodyConteo`/`cntSet`/`cntAddRow`/`cntCompara`/`cntGuardar`.
> ⚠ A revisar el lunes con la empleada: el repo original tenía "Cargar" con 2 códigos y un resumen con
> "Pickings Armados / Pedidos FC / Mercadería en Tránsito" — acá se simplificó (legajo + comparación directa).
>
> Nota (Supabase, 2026-06-27) — **Aviso semanal "generá las OCs" por Telegram.** Función
> `notificar_oc_pendientes_telegram()` + `pg_cron` **`alerta-oc-pendientes`** (`'0 11 * * 3'` = miércoles 08:00 AR).
> Lista los artículos con **stock (góndola+racks+excedente) por debajo del máximo** (= proy×índice topado a
> capacidad; si no hay proy, objetivo del Excel), respetando el corte de `Stock_Config`. Va por el **outbox**
> confiable. Helper `_cod_norm(text)` (saca ceros a la izquierda) para matchear códigos entre tablas. ⚠ Con datos
> de prueba da ~165 (stock bajo + índice 1.5 sin capacidad); con datos reales será representativo.
> **Monitor del outbox**: `notificar_outbox_salud()` + cron **`outbox-salud`** (`'0 13 * * *'` = diario 10:00 AR)
> avisa si quedaron avisos `failed`/`pending` viejos. **Índice de OC recuperado del Excel**: `OC_Maximos.indice`
> se seteó por artículo = `max_cajas ÷ e_madre_cajas` (estadística madre del Excel, de PaginaLK
> `estadistica_madre.e_madre_cajas`). **No era todo 1.5**: 22 de 339 distintos (0,67–4,50; mayoría 1,0/2,0/2,5/3,0).
> Reproduce el máximo del Excel; afinable en ⚙ Índices.
>
> Nota: **v4.38** — **Números bien centrados en toda la app** (#8). Regla **global**: `input[type=number]` sin
> flechitas (`-moz-appearance:textfield` + `::-webkit-*-spin-button{appearance:none}`) → el número centra de
> verdad en todos los steppers (MG, Insumos, Cervantes, Racks, ajustes, etc.). Además se centraron `.oc-rinp`
> (recibido OC), `.stk-aj-inp` (cantidad de ajuste) y los números de la tabla de OC (`.oc-tbl .num`). (v4.24/v4.28
> ya habían centrado los símbolos `–/+` de los steppers.) Se sacó el cartel **BETA** del generador de OCs.
>
> Nota: **v4.36/v4.37** — **Insumos (RI/EI) rediseñado.** Alta con **un solo campo identificador**: **código de
> 7 dígitos** (`/^\d{7}$/`) **o sector** (el sector va *en el lugar del código*) + un campo **descripción**. Si el
> id son 7 dígitos → código (`cod_art = código`); si no → sector (`cod_art = SECTOR·DESCRIPCIÓN`, se muestra
> "📍 sector" en la posición del código). Descripción obligatoria para sectores. Cada ítem lleva **unidad de medida** (chips **Uni / Paquetes / Kg** + un **"+"** que agrega una
> unidad custom, guardada en `localStorage` `vir_ins_units`). Los movimientos (`deposito='insumos'`) ahora
> guardan **`unidad`** y **`ubicacion`** (= sector, para los sin código). Columnas nuevas en Supabase:
> `Movimientos_Stock.unidad`, `Insumos.sector`. Funciones `insLoadUnits`/`insSetUnidad`/`insAddUnidad`,
> `insCrear` (valida 7 díg o sector+desc), `insConfirmar` (manda unidad + ubicación).
>
> Nota: **v4.35** — Vista **Stocks**: (1) sectores **reordenados** → Góndola · Excedente · Pickeados · A facturar ·
> A guardar · Racks (· Insumos aparte). (2) Columnas numéricas **centradas** y títulos multi-palabra en **doble
> fila** ("A guardar"→"A / guardar"). (3) **Tocar el total de un sector** (chip de la tira) abre el **detalle**
> (`stkSectDetail`/`stkBodySectDetail`): lista **sector · código · descripción · cajas**, ordenable **por código
> o por sector**. Para **Excedente** el "sector" es la **ubicación** cargada en el MG (por movimiento); para el
> resto, el sector de planimetría (`window.GONDOLA`).
>
> Nota: **v4.33** — Vista **Stocks**: el sector `separar_pedidos` se muestra como **"Pickeados"** (antes "A
> separar"; solo el label de la vista de Stocks — la solapa y el pipeline siguen "A Separar"). Las columnas de la
> tabla pasan a ser **TODAS fijas** (Góndola · A guardar · Excedente · Racks · Pickeados · A facturar), no solo
> las que tienen stock.
>
> Nota: **v4.32** — Tabla de **Stocks** mide según el contenido (`.stk-tbl-fit` = `width:auto`), no estira a
> 100% (sin huecos al pedo). Columnas: Código · Descripción · una por sector con stock (Góndola y A guardar
> siempre; Excedente/Racks/A separar/A facturar si hay) · "✚". Arriba, la tira de totales por sector.
>
> Nota: **v4.31** — **OC máximo topado a la capacidad de góndola** (proy×índice ≤ capacidad; marca ⤓ en el
> generador cuando topa) + la vista **Capacidad** compara contra el máximo generado (proy×índice), no `max_cajas`.
>
> Nota: **v4.30** — **Stocks / Ingresos / Salidas unificados** en una sola solapa con un **segmento** arriba
> (default "📊 Stock"; `stkBodyStocksTab`/`stkSetView`, estado `_stk.stkView`). Las solapas del admin de Stock
> quedan: Stocks · A Separar · Racks · Capacidad · Ajustes · Compras (OCs).
>
> Nota: **v4.29** — **Módulo Capacidad por sector** (solapa **📐 Capacidad** en *Stock y Compras*). Tabla
> **`Capacidad_Sector`** (`sector, cod, cajas_max`, único `(sector,cod)`; RLS read anon + write authenticated).
> Se **pega** una tabla `Sector ; código ; cajas max` (una por línea; separadores `; , | tab`) → upsert. La vista
> compara, por código, la **capacidad** (suma de `cajas_max` de todos sus sectores) con el **máximo de OC**
> (`OC_Maximos.max_cajas`): **dif +** = sobra lugar (máximo podría estar bajo), **dif −** = no entra (máximo alto
> → iría a excedente). Resumen arriba (códigos, capacidad total, cuántos con máx bajo / no entran). Funciones
> `stkCapLoad`/`stkBodyCapacidad`/`stkCapImport`/`stkCapBorrar`. Sirve para tunear el índice/máximo de las OCs.
> ⚠ Muchos sectores son nuevos (la planimetría tiene 1 sector "representativo" por artículo; acá hay varios).
> (v4.28: centrado de los steppers `–/+` de Racks/Insumos/Cervantes, igual que el MG.)
>
> Nota: **v4.27** — **Picking con excedente PARCIAL** (refina v4.26). Si el excedente **no alcanza** lo pedido,
> la góndola pide **el resto** y el excedente lo que hay. Ej: piden 15, hay 10 en excedente → góndola pide **5**
> ("Levantá 5 (+ 10 en EXCEDENTE, al final)") y el paso de excedente pide **10**. Si el excedente cubre todo →
> góndola se saltea. Cada paso lleva **`key` propia** (`art` para góndola, `art·EXC` para excedente) así los dos
> picks del mismo código **cuentan por separado** (confirmar uno no marca el otro). `pkSendDetail` sigue
> emitiendo PKC con el código real; `stockBajaPicking` saca primero del excedente y el resto de góndola (coincide
> con el split). Validado con Playwright.
>
> Nota: **v4.26** — **Excedente con ubicación (no tiene lugar fijo) → el picking lo busca al final.**
> (1) Nueva columna **`Movimientos_Stock.ubicacion`** (text). (2) **MG**: al guardar al excedente (stepper exc > 0)
> aparece un campo **"📍 Ubicación"** — **formato 1 letra + 2 letras** (ej. `ABC`, mayúsculas), **obligatorio**
> (sin ubicación no deja confirmar). Se guarda en `ubicacion` de la fila `deposito='excedente'`. (3) **Picking**:
> `showPickingList` adjunta el excedente a cada artículo (`pkFetchExcedente`: saldo + ubicaciones). Los artículos
> con excedente se **SALTEAN** en el orden de góndola (`it.skip`, banner **"⏭ Salteá — hay N en EXCEDENTE, se
> busca al final"**) y se **agregan al final** como pasos de pick en su ubicación (`isExc`, "📦 EXCEDENTE — &lt;ubic&gt;").
> Los `skip` no cuentan para terminar (mismo `it.art` que el paso de excedente → un solo resultado). (4) **Contabilidad**
> (`stockBajaPicking`): la baja del picking sale **primero del `excedente`** (ahí se lo mandó a buscar) y el resto
> de `terminado`; si entre los dos no alcanza → alerta **SSG**.
>
> Nota (Supabase, 2026-06-27) — **Telegram confiable (outbox + reintento) y fix de avisos duplicados.**
> (1) **Duplicado de faltantes**: el trigger `trg_faltante_telegram` estaba como `AFTER INSERT **OR UPDATE**`
> (único así). Como `PKC` es **upsert** (la app reenvía el mismo evento), cada UPDATE re-disparaba el aviso →
> 2-3 Telegram por faltante. Se dejó **solo `AFTER INSERT`** (como el resto) → 1 aviso. (2) **Confiabilidad**:
> las notificaciones eran `net.http_post` "fire-and-forget" — si fallaba (timeout/red/Telegram caído) el aviso
> se **perdía sin reintento** (se vio: handshake TLS > 5 s default → timeout). Ahora **todas** pasan por
> **`telegram_outbox`** (tabla): el trigger **encola** (`tg_enqueue`, escritura local, nunca falla por red) +
> **flush inmediato**; un **pg_cron cada 1 min** (`telegram-outbox-flush` → `tg_outbox_flush()`) **reintenta
> hasta status 200** (timeout 20 s, hasta 60 intentos ≈ 1 h) y reconcilia la respuesta async de pg_net. La
> **`dedup_key`** (= `client_id`) evita doble-envío aunque un trigger dispare de más. Migrados: faltante (PKC),
> carga-sin-control (CRA), ppp-error (PPE), sin-planimetría (PSP), falta-facturación (cron), + los nuevos MGX/SSG.
>
> Nota: **v4.25** — MG: cada fila muestra **"a guardar: N"** (antes "disponible") y abajo **"Faltan: N"** =
> `disponible − góndola − excedente` (lo que queda por asignar; verde en 0, ámbar si falta). Vivo a medida que
> se cargan los steppers.
>
> Nota: **v4.24** — **MG (Guardar a góndola): Excedente + buscador + guardar fuera de lista + 2 alertas Telegram.**
> (1) **Excedente**: nuevo depósito **`excedente`** (góndola que no entra). Cada artículo tiene **dos steppers**
> lado a lado — **Góndola** y **Excedente** — independientes, topados a `góndola + exc ≤ disponible`. Al
> confirmar: `a_guardar −(g+e)` · `terminado +g` · `excedente +e`. El excedente es un sector más en Stocks
> (tira + columna + Ajustes) y **cuenta como stock disponible para las OCs** (`terminado + racks + excedente`).
> (2) **Buscador** arriba (teclado numérico) que filtra por código. (3) **Guardar fuera de lista**: si el código
> buscado **no está** en "a guardar" (típico error de tipeo en recepción), botón "➕ Guardarlo igual" → item
> `manual` que **NO descuenta `a_guardar`** (solo entra a góndola/excedente) y **emite evento `MGX`** →
> **alerta Telegram** (trigger `trg_mg_fuera_lista_telegram`). (4) **Alerta picking sin stock**: en el TP, si se
> sacó de góndola **más de lo que el sistema tenía** (saldo `terminado` quedaría negativo), `stockBajaPicking`
> emite **evento `SSG`** → **alerta Telegram** (trigger `trg_picking_sin_stock_telegram`). Símbolos `– / +` y
> números **centrados** (prolijo). Validado con Playwright. ⚠ Los dos triggers Telegram usan el bot/grupo
> "Faltantes Virgilio" (`-1004379879565`), patrón `net.http_post` como el resto.
>
> Nota: **v4.23** — **Solapa Stocks: "cuánto hay en cada sector"** (`stkBodyStocks`). (1) **Tira de totales
> por depósito** arriba (Góndola · A guardar · Racks · A separar · A facturar · Insumos), totales GLOBALES en
> cajas (no filtrados). (2) **Columnas por sector** en la tabla por artículo: Góndola y A guardar siempre;
> Racks / A separar / A facturar **solo si tienen stock** (no ensanchan de gusto). `fmtCajas` redondea a 1
> decimal (racks fraccionados). El `colspan` de las filas de detalle/empty es dinámico. Insumos sigue como
> sección aparte abajo (artículos distintos). Validado con Playwright.
>
> Nota: **v4.22** — **Pipeline de stock "Separar Pedidos" → "A Facturar"** (dos depósitos intermedios entre
> el picking y la facturación). Recorrido de las cajas pickeadas: **góndola** `--TP-->` **separar_pedidos**
> `--TAP-->` **a_facturar** `--facturado-->` fuera del stock. (1) **TP** (`stockBajaPicking`): saca de góndola
> (`terminado −`) y mete en **`separar_pedidos +`** las cajas reales pickeadas (eventos PKC, por tanda),
> `tipo='picking'`. (2) **TAP** (`stockSepararAFacturar`, hook en `send()`): mueve el neto de la tanda
> `separar_pedidos −` / **`a_facturar +`**, `tipo='separado'`. (3) **Marianela factura el último NP de la
> tanda** (la tanda queda 100% facturada en `facTickNP`) → `stockSalidaFacturado`: **`a_facturar −`**,
> `tipo='facturado'` → sale del stock. Cada paso mueve el **neto real** del depósito de origen para esa tanda
> (`_stockNetoDepTanda`, nunca deja negativos) y es **idempotente** (dedup por `tipo`+`ref=tanda`). Nueva
> **solapa "📦 A Separar"** en *Stock y Compras* (`stkBodyProceso`): muestra por tanda las cajas en *a separar*
> (pickeado, falta armar) y en *a facturar* (armado, falta facturar), con totales y filtro. `stockComputeSaldos`
> ahora inicializa `separar_pedidos` y `a_facturar`; el dropdown de *⚙ Ajustes* y la solapa *Salidas* (solo la
> baja de góndola del picking) contemplan los nuevos depósitos. Validado con Playwright. ⚠ El stock disponible
> para OCs sigue siendo `terminado + racks` (NO cuenta estos intermedios: son cajas comprometidas a pedidos).
>
> Nota: **v5.01** — **Rol "solo conteo"** (`CONTEO_EMAILS`, ej. Giuliana
> `delavegagiulianab@gmail.com`): al loguear con Google aterriza en `#conteoPanel` (un único
> botón "Hacer conteo") → `openStockAdmin(true)` abre el admin de Stock en modo **solo conteo**
> (`_stk.soloConteo`: sin solapas, directo a `stkBodyConteo`). No es supervisor ni operario (no
> necesita estar en Empleados); `cntGuardar` no requiere supervisor. **v5.00** — detalle por sector
> de Stocks (`stkBodySectDetail`) reordenado a **Código · Cajas · Descripción · Sector** (entra en
> el celu sin recortar). **Excedente cargado** (conteo 29/06: 48 líneas / 1664 cajas, posiciones
> **P1–P30** en `ubicacion`, `ref='conteo excedente 29/06'`): el picking lo levanta primero solo
> (v4.26 `pkFetchExcedente` lee `deposito=excedente` con su ubicación). ⚠ Códigos con doble
> identidad (099↔99, 124↔124E): se cargó el de la **góndola** para que el Total sume bien.
>
> Nota: **v4.99 (server-side)** — **Pipeline de stock también del lado del SERVER**
> (`reconciliar_pipeline_stock()` + cron jobid 22 `*/10 * * * *`; ver
> `sql/reconciliar_pipeline_stock.sql`). **Root cause** de por qué *Pickeados*/*A facturar*
> mostraban 0 **y la góndola nunca bajaba por el picking**: era UN solo bug — el CHECK
> `Movimientos_Stock_deposito_check` no incluía `separar_pedidos`/`a_facturar`/`excedente`,
> y como `stockBajaPicking` manda `[terminado−, separar_pedidos+]` en **un batch** y
> `stockMove` **se traga los 4xx**, el rechazo del CHECK volteaba TODO el movimiento en
> silencio (ni góndola − ni separar +). Encima los equipos de picking corren app vieja (TWA)
> que ni intenta el pipeline. **Fix**: (1) migración `movimientos_stock_deposito_check_pipeline`
> amplía el CHECK a `terminado/excedente/separar_pedidos/a_facturar/a_guardar/racks/insumos`;
> (2) `reconciliar_pipeline_stock()` replica las 3 etapas (PKC/TP→separar+góndola−,
> TAP→a_facturar, 100% facturado→fuera), **idempotente** (dedup por movimiento), **respeta
> descuentos de góndola previos** (no re-descuenta el seed de C58B/C/D), sólo post-cutoff,
> comparte los `tipo` con el cliente (guards evitan doble conteo si una app nueva sí corre el
> pipeline). Backlog 29/06 reconciliado: **Pickeados 627** (C58C/C58E/C59C), **A facturar 442**
> (C58A/C58B/C58D), góndola −634 (sólo las 3 sin descuento previo; quedó con 2 arts en −5).
>
> Nota: **v4.21** — **Fix m³/hora del monitor pegado en 0** (panel "Mts3 x Hora" / "Parcial").
> `fetchMonitorDayStats` leía el m³ por tanda del cache global `_monitorSheetCache`, pero `renderMonitor`
> lo setea **después** de llamar a esa función. En la 1ª carga el cache estaba `null` → todas las tandas
> caían a la histórica del Sheet; las tandas **nuevas del día** (que no están en la histórica) daban m³ 0 y
> el panel quedaba en 0,0 (los primeros ~15 s, o para siempre si la histórica no las tenía). Fix: el render
> le pasa el `sheetMap` recién fetcheado como **2º parámetro** y el cache de 15 s sólo se reutiliza si se
> calculó **con** sheet (flag `hadSheet`). El m³ NO está en Supabase para producción real, pero la PPP del
> día sí (`PPP_Programacion_Diaria`, `PPP_SOURCE="auto"`) → el m³ por tanda sale de ahí o de la histórica.
>
> Nota: **v4.20** — **PPP: tilde de AP/TAP a la derecha de la impresora**. Cada fila de la PPP muestra dos
> pastillas **AP** (armado empezado) y **TAP** (armado terminado) por tanda, verdes con ✓ cuando están
> hechas. Se nutren de `getActivityStatus()` (`armadoStarted` / `armadoDone`) — lectura de Supabase, no
> escribe la PPP. Helper `_pppApTapBadge(p)`; se inserta tras el botón 🖨️ en `_pppRowTr`/`_pppRowTrRO`.
>
> Nota: **v4.18–v4.19** — **PPP, dos ajustes**. v4.18: la **razón social larga** ya no desfasa ni ensancha
> la columna (`.ppp-cli-in`: `max-width:180px` + ellipsis + tooltip con el nombre completo). v4.19:
> **clickear un pedido en el panel de errores** lleva a su fila (`pppGoToRow(np)` → `scrollIntoView` +
> flash `.ppp-row-flash`; cada `<tr>` tiene `id="ppprow_<np>"`; los NP del panel son `<a class="ppp-go">`).
>
> Nota: **v4.17** — **Máximo de OC = Proyección por tendencia (PaginaLK) × índice (configurable)**.
> El máximo del generador ya no sale del Excel estático; sale de la **estadística madre por tendencia**
> que calcula PaginaLK (repo `loekemeyer/PaginaLK`, Supabase `kwkclwhmoygunqmlegrg`). Esa proyección
> **no está guardada** allá: se computa al vuelo en su admin (`_computeEstMadreProjections`: por
> cliente×artículo, ventana 24m, promedio desde 1ª compra **descartando picos disruptivos**; suma sobre
> clientes; excluye clientes test 1/3878 y `sales_excluded_items`). **Fluctúa mes a mes**. Se expuso como
> **RPC `fn_proyeccion_madre()`** (PaginaLK, anon) y se **sincroniza** a Virgilio: tabla
> **`proyeccion_madre`** (`cod, proy_cajas_mes, uxb, proy_uni_mes, actualizado`) + función
> **`refresh_proyeccion_madre()`** (extensión `http`, GET al RPC, filtra `proy>0` para descartar códigos
> de descuento) + **`pg_cron` mensual** (`'0 6 5 * *'` = día 5, después del import). En el generador:
> `ocgFetchProyeccion` (mapa cod→proy_cajas, cod normalizado sin ceros a la izquierda); **máximo (cajas)
> = ceil(proyección × índice)**; si un artículo no tiene proyección, cae al objetivo del Excel
> (`OC_Maximos.max_cajas`, marcado *xls*). **Índice configurable**: columna **`OC_Maximos.indice`**
> (default 1,5) + **módulo "⚙ Índices"** en el generador (`ocgEnterIndices`/`ocBodyIndices`/`ociSetAll`/
> `ociSave`): editar global ("a todos en X") o por artículo, guardar con sesión de supervisor. Validado
> con Playwright (proy×índice, fallback, editor). ⚠ Regla en PaginaLK: tabla `sales_excluded_items` +
> trigger `trg_sl_excluir_no_venta` en `sales_lines` que descarta al importar códigos no-venta (ej. 1101).
>
> Nota: **v4.16** — Admin: 5 grandes en una fila + 7 chicos en una tira (fix de breakpoints).
>
> Nota: **v4.15** — **Vista Administración en 2 niveles** (pedido del usuario). **GRANDES** (uso diario,
> mismo tamaño, fila de 5, `.sup-primary`): **Facturación · PPP · Carga Recepción Mercadería · Stock y
> Compras · Recepción Remitos (RR)** (ese orden lo definió el usuario). **CHICOS** (ocasionales,
> `.sup-secondary`, más chicos y atenuados, bajo el rótulo "Reportes y configuración"): Monitor de
> operarios · Análisis de productividad · Inconsistencias · Faltantes · Editar Planimetría · Talleristas
> de Recepción · Mails autorizados. **"Stocks" + "Órdenes de Compra" se unificaron en UN botón**: "📦
> Stock y Compras" abre `openStockAdmin`, que ahora tiene una solapa **"📑 Compras (OCs)"** (`stkTab`
> intercepta `compras` → `openOCAdmin`). Responsive: 5→3→2 columnas.
>
> Nota: **v4.14** — **Fix de foco en buscadores/steppers**. Reemplazar `innerHTML` en cada tecla
> "sacaba" del campo (había que re-clickear por dígito). Helper **`_renderKeepFocus(container, html)`**:
> guarda el input activo (tag+clase+índice) y el cursor, y los restaura tras el re-render. Aplicado a
> `stkRender, ocRender, insRender, scRender, brRender, mgRender`.
>
> Nota: **v4.13** — **GENERADOR DE OCs en la página (replica el Excel "Pedidos Talleristas/Prov")**.
> **BETA, coded pero no para usar** hasta que esté el stock inicial cargado. Vive en el admin **Órdenes
> de Compra** (`openOCAdmin` → botón "⚙ Generar OCs (beta)" → vista `ocBodyGen`). **Fórmula (= la del
> Excel, hoja OCUPACION VIRGILIO col H)**: por artículo **`A pedir = max(0, Máximo + Pedidos − Stock)`**,
> redondeado para arriba a cajas enteras. **Fuentes**: (a) **Stock** = `Movimientos_Stock` **Góndola
> (terminado) + Racks** (NO cuenta "a guardar"), vía `stockComputeSaldos`; (b) **Pedidos/demanda** =
> Σ cajas por artículo en los pedidos del **PPP** (`PPP_Programacion_Diaria`, set de NP) según la **base
> de picking** (`PPP_Base_Pedidos`, vía `fetchPickingBase`) — función `ocgDemanda` (desde **v6.47** neto de las NP ya facturadas en `Facturacion_NP`); (c) **Máximo +
> Proveedor** = tabla nueva **`OC_Maximos`** (`cod, descripcion, linea, max_cajas, proveedor, uni_x_caja,
> activo`; RLS lectura anon / escritura authenticated), **importada del Excel** (OCUPACION VIRGILIO:
> Stock Max Cajas + Proveedor) — 339 códigos (315 activos, 22 proveedores). El **Máximo** del Excel =
> Est.Madre_Uni × Índice ÷ Uni-x-Caja (Est.Madre se actualiza ~cada 3 meses → re-importar). **Agrupa por
> proveedor**; los **proveedores internos** (`Racks` = importación, `Log/ Fabr` = fábrica) se muestran
> pero **NO** generan OC externa. Al **"Generar las OCs"** escribe las líneas de los externos en
> `Ordenes_Compra` (proveedor, fecha, codigo, descripcion, cantidad=falta, estado=pendiente, rubro='Art
> Term'; escritura con sesión de supervisor). Validado con Playwright (fórmula, internos, generación).
> **Decisiones/pendientes**: códigos con proveedor combinado ("Garcia / Lucho") quedan como ese string
> (a futuro, partir); **futuro**: que se genere automático + guardar PDFs en una carpeta / enviar por
> WhatsApp con plantilla (a trabajar después). El usuario carga el stock inicial más adelante (recién ahí
> da números reales).
>
> Nota: **v4.12** — **Stock inicial / "marcar inicio" robusto**. (1) `stockComputeSaldos` ahora cuenta
> **SIEMPRE** los movimientos `tipo='inicial'` (stock inicial = base), aunque sean anteriores al corte;
> el `cutoff` sólo desconsidera los movimientos **reales** previos (recepción/guardado/picking/ajuste/
> salida_cervantes/baja_racks/etc.), sin borrarlos. Así se puede cargar el inicial de **varios depósitos**
> (góndola/racks/insumos) en cualquier orden y **marcar inicio una sola vez**, sin que un depósito pise a
> otro. (2) En el admin Stocks → ⚙ Ajustes, la carga inicial pasó a **dos pasos separados**:
> **`stockGuardarInicial()`** (carga el inicial del depósito elegido, sin tocar el corte) y
> **`stockMarcarInicio()`** (botón aparte que fija `cutoff_ts = ahora`, una sola vez). Se quitó el botón
> combinado "Guardar + marcar inicio" (era un footgun multi-depósito: movía el corte y dejaba afuera lo
> cargado antes). Validado con Playwright. Decisión del usuario: **el stock inicial se carga más adelante**
> (primero verifica que el resto del flujo sume/reste bien).
>
> Nota: **v4.11** — **ÓRDENES DE COMPRA** (módulo admin, base del match recibido↔pedido). Botón
> supervisor **"📑 Órdenes de Compra"** (`openOCAdmin`). **Descubrimiento importante**: la tabla
> **`Ordenes_Compra` YA EXISTÍA** con datos reales (18 líneas de cajas de "Corrugadora"). Es **plana**:
> una fila por artículo pedido (`codigo, descripcion, cantidad, cantidad_recibida, unidad, proveedor,
> rubro, fecha, estado` + campos de mensajería al proveedor `mensaje_enviado/fecha_mensaje/
> proveedor_telefono` que mantiene otra herramienta). Una **"OC" = grupo (proveedor · fecha · rubro)**.
> El módulo lista las OCs agrupadas con **Pedido / Falta** (= Σcantidad − Σrecibida) y estado
> (pendiente|parcial|recibida); al abrir una OC muestra sus líneas con **recibido editable** y
> **faltante en vivo**; permite **guardar recibido** y **marcar recibida/reabrir**; y **crear OC manual**
> (carga líneas planas). **RLS de la tabla** (pre-existente, respetada): `select_all` anon+auth (lectura),
> pero `insert/update/delete` **sólo `authenticated`** → las **escrituras usan `facAuthWriteHeaders`**
> (sesión Google de supervisor, igual que Planimetría/Talleristas); la lectura va con anon. ⚠ Se creó por
> error una tabla `OC_Items` (modelo header+items) y una policy `oc_all` anon-write: **ambas
> revertidas/eliminadas** (se usa la tabla plana existente y su RLS original). **Pendiente** (necesita
> input del usuario): (a) **importar los PDF de OC** (share Windows `D:\Shares\...\A2 OC Art Term VIGENTE`,
> no accesible del sandbox) — poblaría esta misma tabla; (b) **auto-actualizar `cantidad_recibida` desde
> la recepción** (definir el vínculo recepción→OC: por `codigo`, por remito, desde qué fecha).
>
> Nota: **v4.10** — **SALIDA A CERVANTES** (botón nuevo de operario). Se agregó el botón **`SC`**
> ("Salida a Cervantes") a la botonera (en la fila de logística; **`CT` Conteo** se corrió a la
> 3ª fila, ahora ambas filas de 6). Manda **artículo terminado** a la otra planta (muestra /
> devolución): es una **baja de góndola** → `Movimientos_Stock` `deposito='terminado'`, `delta`
> negativo, `tipo='salida_cervantes'`, `ref` = remito/motivo opcional. **No** es un toggle ni genera
> evento en `Registros`: el botón intercepta en `selectOption` y abre **directo** el modal
> `showCervantesModal` (sin "Enviar"); la salida queda registrada sólo en `Movimientos_Stock` (con
> legajo + ts como traza). El modal (tipo MG) muestra lo que hay en góndola (stock terminado > 0),
> buscador, stepper por artículo (tope = stock) y un campo remito/motivo; confirmar usa **`stockMove`**
> (offline-safe). En el **admin Stocks** la solapa **Salidas** ahora muestra picking **+** salida a
> Cervantes (columna "Destino": tanda vs 🚚 Cervantes · motivo). Validado con Playwright (layout de
> botonera, intercept del botón, render, clamp, fila de movimiento).
>
> Nota: **v4.09** — **INSUMOS** (stock de insumos en la página). Los botones **RI** (Recepción
> Insumos) y **EI** (Entrega Insumos) —que ya existían como toggles de actividad— ahora, **al
> tocarse (inicio)**, abren un modal que registra **stock de insumos** en `Movimientos_Stock`
> (`deposito='insumos'`, tipo `recepcion_insumo` `+` / `entrega_insumo` `−`). El modal
> (`showInsumoModal('RI'|'EI', legajo)`) tiene **buscador** sobre el catálogo **`Insumos`** (tabla
> nueva: `id, cod (unique), nombre, creado_por, creado`, + `sector` desde v4.36 y
> `categoria`/`ubicacion` desde **v7.05**; RLS: anon `select` + `insert`) y **alta de código
> al vuelo** (`insCrear` → POST a `Insumos`) para cuando el insumo no está. Cada fila muestra el
> **stock actual** y un stepper; en EI avisa si va a quedar negativo (no lo bloquea — "como entra,
> puede salir"). Confirmar usa **`stockMove`** (offline-safe `vir_stock_pend`). En el **admin Stocks**
> (solapa Stocks) se agregó una sección **"📦 Insumos"** con el saldo por código. El selector de
> depósito de **Ajustes** ya permite cargar/ajustar `insumos`. Validado con Playwright (RI/EI render,
> buscador, warning, clamps, filas de movimiento correctas) y shape de insert en Supabase.
> ⏳ Falta que el usuario pase el **listado de insumos** para precargar el catálogo (igual se crea solo
> al usarse).
>
> Nota: **v4.08** — **RACKS → GÓNDOLA** (page-based, sin Telegram). Los **racks** son góndolas de
> pallets donde se guarda stock en **master cajas**; una vez por semana (al generar las OCs, miércoles)
> se baja de racks a la góndola. **Modelo**: depósito nuevo **`racks`** en `Movimientos_Stock` (en cajas;
> se muestran 3 unidades por artículo: **master ↔ caja ↔ unidad** vía `Cajas_x_Master` —columna nueva en
> `Articulos Virgilio X Tallerista`, junto a `Uni_x_Caja`). Tablas nuevas: **`Racks_Ordenes`**
> (`id, fecha, estado pendiente|bajado, creada_por, creada, cerrada_at`) y **`Racks_Bajadas`**
> (`id, orden_id, cod_art, descripcion, cajas, estado propuesta|aprobada, creada_por, ts, aprobada_at, client_id`);
> RLS abierta anon+authenticated. **v12.36**: los flujos de operario (`brConfirmar`/`rkbConfirmar`)
> ya NO postean la fila + los movimientos por separado — llaman al RPC atómico
> `registrar_baja_racks(p_items)` (fila 'aprobada' + los 2 `Movimientos_Stock` en una
> transacción, idempotente por `client_id`; front `postBajaRacks`, cola `vir_baja_racks_pend`). **Flujo**: (1) la operadora toca **"OCs generadas"** en el admin Stocks
> (solapa 🏗 **Racks**) → crea una `Racks_Ordenes` **pendiente** (`racksCrearOrden`). (2) **Alarma en la
> página**: mientras haya orden pendiente, a los operarios les aparece un banner en la botonera
> (`#racksAlarma`, `racksCheckAlarma`, refresco 5′, llamado desde `goToOptions`). (3) **Operario baja**:
> botón "Registrar bajada" → `showBajarRacks` (módulo tipo MG: muestra stock de racks en las 3 unidades,
> el operario marca cuántas cajas baja) → guarda en `Racks_Bajadas` **estado `propuesta`** (NO mueve stock
> todavía; reintento offline `vir_racks_pend`). (4) **Marianela aprueba** en **Carga Recepción Mercadería**
> (`recepcion.js`, botón "📦 Bajadas Racks → góndola" con contador de pendientes) → `racksAprobarBaja`:
> inserta 2 `Movimientos_Stock` (`-racks` / `+terminado`, tipo `baja_racks`), marca la bajada `aprobada` y,
> si era la última de la orden, cierra la orden (`bajado` → apaga la alarma). **Si no se baja, NO se mueve
> stock.** Mismo patrón reusable a futuro para reclamar artículos con poco stock (botón → orden/alarma en la
> página). Admin Stocks ahora tiene **5 solapas** (Stocks · 🏗 Racks · Ingresos · Salidas · Ajustes) y el
> selector de **depósito** en Ajustes incluye racks/insumos/a_guardar (`_stkDep`). Validado con Playwright
> (admin render, operario `brRender`, clamps, alarma).
>
> Nota: **v4.06–v4.07** — **STOCK ONLINE** (pedido del usuario; objetivo: stock dentro de la página).
> Modelo **event-sourced**: tabla **`Movimientos_Stock`** (`ts, cod_art, descripcion, deposito
> ('a_guardar'|'terminado'), delta (+/- cajas), tipo, ref, legajo`); el **stock = suma de `delta`** por
> `cod_art`/`deposito` considerando sólo `ts >= corte`. Tabla **`Stock_Config`** guarda el corte
> (`clave='cutoff_ts'`). **Flujos**: (1) **RT/recepción** (`recepcion.js opEnviar`) → cada artículo recibido
> suma a **'a_guardar'** (tipo `recepcion`). (2) **MG** (Guardado a Góndola) → al tocar MG, `showMGModal`
> muestra lo que hay en 'a_guardar', el operario elige cuántas cajas guarda y al confirmar genera 2
> movimientos por artículo (`-a_guardar`, `+terminado`, tipo `guardado`). (3) **Picking** → al **TP**,
> `stockBajaPicking` suma las cajas **reales** de los PKC de la tanda y resta de **'terminado'** (tipo
> `picking`, dedup por `ref=tanda`). **Admin** "📦 Stock / Movimientos" (`openStockAdmin`): saldos por
> artículo (terminado negativo en rojo), detalle de movimientos, **cargar stock inicial** (movimientos
> `inicial`) y botón **"marcar inicio"** (setea `cutoff_ts` → desconsidera lo anterior sin borrarlo).
> Cliente: `stockMove`/`stockFlushPend` (POST + reintento `vir_stock_pend`), `stockFetchMovs`/`GetCutoff`/
> `ComputeSaldos`. Helpers offline-safe. (Arranca en 0; el corte permite resetear cuando se carga el inicial.)
>
> Nota: **v4.05** — **Dos alertas nuevas a Telegram** (grupo **"Faltantes Virgilio"**, chat `-1004379879565`, el
> mismo bot/grupo de faltantes y sin planimetría). (1) **FALTA DE FACTURACIÓN** — *server-side* (`pg_cron` +
> `pg_net`): función `notificar_falta_facturacion_telegram(modo)`. **`'manana'`** (cron `falta-fact-manana`,
> `0 21 * * *` = 18:00 AR): pedidos con **entrega mañana**, **armado terminado** (hay TAP en ≤5 días) y **sin
> facturar** (no están en `Facturacion_NP`) → avisa. **`'hoy'`** (cron `falta-fact-hoy`, `0 11 * * *` = 08:00
> AR): **entrega HOY y sin facturar** (urgente/vencido). (2) **ERROR EN PPP** — *client-emit*: el monitor PPP
> (modo readonly) al detectar errores (`_pppComputeErrors`) emite un evento **`PPE`** (`texto =
> sinzona:N|zonadif:N|tandamal:N|sacar:N`, id determinístico `ppe_<día>` + upsert → **1 aviso por día**); el
> trigger **`trg_ppp_error_telegram`** (`notificar_ppp_error_telegram`, AFTER INSERT) lo reenvía con el detalle
> (sin zona · zona≠barrio · tandas mezcladas fecha/ruta · a sacar). Cliente: función nueva `_pppEmitError`;
> `PPE` agregado a `isUpsert` (index.html + sw.js). Verificado end-to-end (POST 200, `ok:true`).
>
> Nota: **v4.04** — **El wizard "Completar" se movió a AP + TAP sin pop-up + persistencia** (cierra el pedido
> del usuario sobre el flujo). Al tocar **AP** ahora se abre el wizard (Paso 1 Faltantes → Paso 2 Líos) en
> lugar del aviso read-only `showMarianelaAviso`; **TAP ya NO abre ningún pop-up** (es solo el cierre del
> armado). Como el wizard queda **abierto durante el armado**, se **persiste el avance** en `localStorage`
> (clave `vir_comp_<TANDA>`, ventana 36 h): se guarda en cada cambio (`_compPersist`, llamado desde
> `_compRecalc` y `_compLioNp`), se **retoma al reabrir AP** (`_compRestore` al inicio de
> `showCompletarWizard`, antes de reconstruir) y se **borra al Terminar** (`_compClearPersist`). Cerrar con la
> **X NO borra** (se retoma al reabrir). Validado con Playwright (guardar → cerrar → restaurar → terminar →
> limpiar, sin errores). El flujo completo del usuario: **AP → faltantes → líos → TAP (sin popup)**.
>
> Nota: **v4.03** — **Wizard "Completar" reordenado + botonera de líos** (pedido del usuario). (1) **Orden
> nuevo**: Paso 1 = **Faltantes** (antes Paso 2), Paso 2 = **LÍOS en botonera de cuadrados** (reemplaza el
> tipeo del número). (2) **Los líos se arman sobre lo ENTREGADO** (`pedido − faltó` del Paso 1):
> `_compBuildLiosData` calcula por NP las cajas que salen por código (descuenta el faltante repartido en el
> Paso 1, clave `np|cod` sin la E final). (3) **Botonera por NP** (una a la vez, nav ← / →): cada código un
> cuadrado **código / (en este lío / quedan) / − +** con **+ suelta**, ordenada por nº de código; los códigos
> ya repartidos salen de la grilla. **La cantidad de líos sale sola** (= cuántos se cierran). (4) **Guardado**:
> evento **TAL** con texto extendido `NP|LÍOS|TANDA|RESUMEN` (resumen = composición `A=544x1;B=546x5;…`;
> retrocompatible: lo viejo sigue leyendo `NP|LÍOS|TANDA`). `compTerminar` valida que cada NP tenga TODAS sus
> cajas repartidas antes de cerrar. Funciones `_compBuildLiosData`/`_compLioStep`/`_compLioSuelta`/
> `_compLioSiguiente`/`_compLioDel`/`_compLioNp`/`_compLiosResumen`/`_compRenderLios`. ⚠ **Sigue disparándose
> en TAP** (todavía no se movió a AP ni se sacó el popup de TAP — pendiente: disparo en AP, TAP sin popup,
> persistencia del avance en localStorage). **v4.00–v4.02** (interim): v4.00 faltantes permiten completar
> (`sum ≤ a.falta`, llegó stock); v4.01 columna **Líos** en monitor de Facturación (lee TAL); v4.02 ensanchar
> esa vista a 1240px para que entre Acción.
>
> Nota: **v3.99** — **Entregas en Supabase: UNA tabla persistente `Entregas_Virgilio` (no más vistas)**
> (pedido del usuario: "una sola tabla, sin duplicar"). Se **borraron las vistas** `Entregas_Virgilio` y
> `Faltantes_Virgilio` (v3.97/v3.98) y se creó una **TABLA** `Entregas_Virgilio` con columnas exactas:
> `fecha_salida · cod_cliente · np · cod_art · cajas_pedidas · cajas_entregadas · cajas_falto · tanda`
> (+ `id`, `creado`). **La app la llena al dar TAP**: en `compTerminar` arma el **pedido entero** de la tanda
> (una fila por **NP × artículo**, sacado de `pedidoFull` = picking base por NP), calcula el `cajas_falto` del
> reparto del Paso 2 (`faltMap`, clave `np|art` sin la E final) y `cajas_entregadas = pedidas − faltó`, y hace
> **un POST en bloque** (`_compSaveEntregas`, 1 sola llamada). **Sin duplicar la base**: la fila guarda el
> pedido tal cual estaba al entregar (no se re-lee la base efímera `PPP_Base_Pedidos`). **Offline-safe**: si
> el POST falla por red, las filas quedan en `localStorage` (`vir_entregas_pend`, cap 5000) y se reintentan al
> volver online y al cargar (`_compFlushEntregas`); un 4xx (error de datos) NO se reintenta (evita loop).
> **`fecha_salida` = `fecha_entrega`** de `PPP_Programacion_Diaria` (no la de armado: el pedido se arma el día
> anterior). **Se quitaron los eventos FAL** (el faltante ya queda en la tabla; los líos siguen yendo como
> **TAL** por la cola). RLS: `ent_insert`/`ent_select` para `anon`+`authenticated`. Funciones nuevas:
> `_compSaveEntregas` / `_compFlushEntregas`; `showCompletarWizard` ahora arma `pedidoFull` + captura `fecha`.
>
> Nota: **v3.98** — **Wizard "Completar" Paso 2: modo CARGÓ + tope + auto-fill + switch** (pedido del
> usuario). (1) **Modo `_compMode`** (default **"cargo"**, elegido por el usuario): el operario anota lo que
> **CARGÓ** a cada NP y el **faltó** sale por diferencia (`pidió − cargó`); modo `"falto"` = anota el
> faltante. El switch es **solo de UI** — internamente siempre se guarda el FALTANTE (`asig`), así **FAL /
> la vista `Entregas_Virgilio` / los cálculos NO cambian**. Hay un **toggle en vivo** en el Paso 2 (para
> que prueben los dos). (2) **Tope**: cada input no puede superar lo que **pidió** esa NP (`max=pidio`,
> clamp en `_compFaltInput`). (3) **Auto-fill "agarró 0"**: si el picking levantó **0** (`real===0`), cada
> NP queda con faltó = lo que pidió, **automático** (readonly), sin que lo marquen (igual que el caso de 1
> solo cliente). `arts[].auto`/`real`. (4) **Claridad**: label **CARGÓ** (verde) + secundario **faltó X**
> (rojo, chico) por NP, para no confundir lo cargado con lo faltante. CSS `.comp-mode-toggle`/`.comp-fnp-box`/
> `.comp-fnp-lbl`/`.comp-fnp-sec`. La vista `Entregas_Virgilio` ya trae `cajas_pedidas · cajas_faltantes ·
> cajas_entregadas` (entregó + faltó en Supabase).
>
> Nota: **v3.97** — **TAP: wizard "Completar" (líos + reparto de faltantes) + vista `Entregas_Virgilio`**
> (pedido del usuario). Al dar **TAP** se abre `showCompletarWizard` (reemplaza al `showLiosModal` suelto):
> **Paso 1** = líos por NP (guarda como antes, opcion **TAL**); **Paso 2** = repartir las **cajas
> faltantes** del picking (de `faltantesDeTanda`/PKC) entre las NP que pidieron cada artículo (1 NP →
> automático; 2+ → el operario reparte hasta completar). Navegación con flechas ← →, botón **Terminar**
> (se habilita con líos completos + faltantes repartidos). Si la tanda no tiene faltantes, sólo Paso 1.
> **Guardado de faltantes**: opcion **FAL**, `texto = tanda|np|cod_cliente|cod_art|cajas_faltantes` (por la
> cola → offline-safe). **Vista Supabase `Entregas_Virgilio`** (security_invoker, grant anon/auth): cruza
> `PPP_Programacion_Diaria` (np→cliente+`fecha_entrega`) × `PPP_Base_Pedidos` (pedido entero) − faltantes
> (FAL) → columnas `fecha · cod_cliente · razon_social · tanda · np · cod_art · cajas_pedidas ·
> cajas_faltantes · cajas_entregadas`. **Sin duplicar la base**: la vista la lee al vuelo; el faltante se
> guarda 1 vez (FAL); `entregadas = pedidas − faltó`. **fecha = fecha_entrega** (no la de armado: el pedido
> se arma el día anterior). ⚠ La base es del día en curso (se reemplaza al sync) → el programa externo lee
> la vista el mismo día y guarda su histórico. Funciones: `showCompletarWizard`/`_compRenderLios`/
> `_compRenderFalt`/`_compRecalc`/`_compGo`/`compTerminar`/`_compSendFalt`.
>
> Nota: **v3.96** — **Armado (AP): el aviso muestra TODOS los faltantes de la tanda** (pedido del usuario).
> Antes `showMarianelaAviso` (se dispara al tocar **AP**, línea ~5295) sólo mostraba los faltantes que había
> que **REPARTIR** (faltante >1 y pedido por 2+ NP); si no había reparto, no mostraba nada. Ahora muestra
> **todos** los faltantes del picking de la tanda (de los eventos **PKC**, `real < esperado`, últimos 5
> días, vía `faltantesDeTanda`), ordenados con los de reparto primero. Los de **reparto** van marcados en
> **rojo** (`.mar-art-rep`) con "repartir · N ped."; el resto en ámbar. Texto del modal actualizado
> ("Revisá los faltantes antes de separar…"). El supervisor sigue teniendo la vista completa en **📦
> Faltantes**.
>
> Nota: **v3.95** — **Talleristas / Artículos: fix "no aparece nada" (ej. Pintos) + estética + ← Volver**.
> (1) **Bug del vínculo**: el panel de artículos buscaba por `Cod_Tallerista` (código), pero **varios
> talleristas no tienen código** (en `Codigos X Tallerista` el `Codigo` es NULL, ej. **Pintos**) y sus
> artículos en `Articulos Virgilio X Tallerista` están ligados por **`Tallerista` (NOMBRE)** con
> `Cod_Tallerista` NULL → no aparecía nada. Ahora `tallArtsLoad` consulta por **`Tallerista=eq.<nombre>` +
> `Linea`** (el nombre es NOT NULL, siempre está) y `tallOpenArts` ya **no exige código**; `tallArtAdd` setea
> `Cod_Tallerista: cod || null`. (Pintos LK tiene 224/225/220-223/208/229…; CH 229/901/902/910/911/920/922.)
> (2) **Estética**: `.tall-row` pasó a tarjeta de **2 líneas** (`.tall-row-top` Nombre + Borrar arriba;
> `.tall-controls` LK/CH abajo) — antes el 📦 ensanchaba los chips y "Borrar" se iba a otro renglón apretado.
> (3) **← Volver**: botón en la barra del panel de artículos (`.recp-admin-back` → `closeTallArts`).
>
> Nota: **v3.94** — **PPP / Imprimir: diagnóstico del "Buscando" trabado**. Si la ruta rápida no matchea,
> el escaneo de una carpeta de red grande tardaba sin feedback (parecía colgado en "Buscando el PDF…").
> Ahora: (a) la ruta rápida `getFileHandle` prueba el prefijo **con y sin punto** (`Pedido de Clte._Div_` /
> `Pedido de Clte_Div_`) y extensión `.pdf`/`.PDF`; (b) el escaneo muestra **progreso** ("Revisando la
> carpeta… N archivos") vía `onProgress` y tiene **tope de 25 s** (`Date.now()`), así nunca parece colgado;
> si corta, el cartel "no encontré" muestra nombres reales (`_pppDirSamples`) para ver el formato.
>
> Nota: **v3.93** — **PPP / Imprimir: fix "no hace nada"** (pedido del usuario). Dos causas y dos fixes.
> (1) **Lentitud**: desde v3.90 `pppFindNpPdf` **escaneaba TODA la carpeta** por pedido → con carpetas
> grandes tardaba mucho y parecía colgado (y consumía el gesto del click). Ahora primero hace la ruta
> **RÁPIDA** (`getFileHandle` con el nombre exacto ISIS `PDF_PREFIX`+NP-con-ceros+`_NN.pdf`, sin escanear),
> y sólo si no matchea cae al **escaneo por número** (fallback para otro prefijo/relleno, ej. CHEF).
> (2) **Impresión silenciosa**: `_pppPrintPdf` subió el delay 400→700ms (que el visor renderice antes de
> `print()`) y se quitó el `window.open` interno (lo bloqueaba el popup-blocker). Ahora guarda el blob en
> `_pppLastPdfUrl` y al imprimir el estado muestra un link **"Abrir el PDF"** (`pppAbrirUltimoPdf`) — lo toca
> el usuario (gesto) → no se bloquea → imprime con Ctrl+P. Respaldo garantizado si la impresión automática
> del iframe no sale.
>
> Nota: **v3.92** — **Talleristas de Recepción: editor de ARTÍCULOS por tallerista** (pedido del usuario).
> En el editor "👷 Talleristas de Recepción", el badge **LK/CH** ahora es un botón (📦): al tocarlo abre un
> sub-overlay (`tallArtsOverlay`, z-index 1260) para **ver/agregar/editar/borrar** los artículos que ese
> tallerista entrega en esa línea. Tabla `Articulos Virgilio X Tallerista`; vínculo **`Cod_Tallerista`
> (= código LK/CH) + `Linea`** (la MISMA query que usa Recepción `renderArticulos`). Cada fila: `Cod_Art` ·
> `Desc` · `Uni_x_Caja` editables inline + Borrar. Al **agregar**, si dejás Desc/U×Caja vacíos y el
> `Cod_Art` ya existe en otro tallerista, los **completa de ahí** (maestro). NOT NULL de la tabla: `Linea,
> Cod_Art, Desc, Tallerista, Uni_x_Caja` (se setean todos). **RLS**: lectura anon (`select_all`), escritura
> con JWT supervisor (`insert_all`/`update_all`/`delete_all` = authenticated) vía `facAuthWriteHeaders` →
> **sin SQL**. Funciones: `tallOpenArts`/`tallArtsLoad`/`tallArtsRender`/`tallArtSave`/`tallArtAdd`/
> `tallArtDelete`. ⚠ Los artículos se ligan por **código**: si cambiás el código LK/CH de un tallerista,
> sus artículos viejos (con el código anterior) quedan con ese código.
>
> Nota: **v3.91** — **PPP / Imprimir: ruteo de carpeta por N° de pedido + prefijo real**. Regla del usuario:
> NP que empieza con **4** → PDF en `X:\PDF_ISISCHEF`; empieza con **9** → `X:\PDF_ISIS`. `_pppOrderDirsForNp`
> ordena las carpetas para buscar **primero en la correcta** (identifica la CHEF por el nombre, `/chef/i`),
> con fallback al resto. Si no encuentra y la carpeta que correspondía NO está conectada, el cartel lo
> **avisa** ("empieza con 4 → va en PDF_ISISCHEF, conectala"). El **formato real** del archivo es
> `Pedido de Clte._Div_000000097904_00.pdf` — con **punto** después de "Clte" (el `PDF_PREFIX` viejo decía
> `Clte_` sin punto: por eso la búsqueda por nombre exacto de ≤v3.89 fallaba). Desde v3.90 la búsqueda es
> por NÚMERO, así que el prefijo/punto ya no importan; `PDF_PREFIX` quedó solo de referencia (corregido).
>
> Nota: **v3.90** — **PPP / Imprimir: búsqueda de PDF por NÚMERO (robusta) + diagnóstico**. Antes
> `pppFindNpPdf` **armaba el nombre exacto** (`PDF_PREFIX` + NP con ceros + `_NN.pdf`) y fallaba si el
> prefijo o el relleno difería (típico entre `PDF_ISIS` y `PDF_ISISCHEF`). Ahora **lista la carpeta** y
> compara el **número embebido** en cada `.pdf`: el NP = la corrida de dígitos más larga del nombre
> (`nm.match(/\d+/g)`), el sufijo `_NN` = versión (se queda con la más alta). Anda con cualquier prefijo y
> cualquier cantidad de ceros, y no confunde 97904 con 979040/97905 (probado). `pppPrintTanda` usa
> `_pppIndexDirs(dirs)` (1 pasada por carpeta → `Map(NP→archivo)`). Si NO encuentra, el cartel ahora muestra
> **nombres reales** de la carpeta (`_pppDirSamples`) para ver el formato. `PDF_PREFIX`/`PDF_WIDTHS`/
> `PDF_VERS` quedan solo de referencia (ya no se usan para construir el nombre).
>
> Nota: **v3.89** — **PPP / Carpeta PDF: soporte de VARIAS carpetas** (pedido del usuario: los PDF están en
> `X:\PDF_ISIS` **y** `X:\PDF_ISISCHEF`). Antes la app conectaba **una sola** carpeta. Ahora guarda una
> **lista** (`PDF_DIRS_KEY = "pdf_isis_dirs"`, array de handles en IndexedDB vía `fshGet/fshSet`) y al
> imprimir busca el PDF en **todas** (`pppFindNpPdfAny(dirs, np)` → primer match). El botón **🖨️ Carpeta(s)
> PDF** ahora **agrega** una carpeta por click (`pppConnectPdfDir` → `_pppPickPdfDir`, dedupe por
> `isSameEntry`); el estado lista todas con ✓/🔒 y un link **olvidar** (`pppForgetPdfDir`, borra la lista).
> `pppGetPdfDirs(interactive)` devuelve las carpetas con permiso concedido. **Migración**: `_pppLoadPdfDirs`
> incorpora el handle único viejo (`pdf_isis_dir`) a la lista y borra la clave vieja. Recordatorio del
> **bloqueo de Chrome** (v3.88): hay que elegir la **subcarpeta** (`X:\PDF_ISIS`), no el disco `X:\`.
>
> Nota: **v3.88** — **PPP / Carpeta PDF: guía ante el bloqueo de Chrome** ("Esta carpeta no se puede abrir…
> contiene archivos del sistema"). NO es un bug: el File System Access API (`showDirectoryPicker`) **bloquea
> carpetas sensibles** — la **raíz de un disco** (`C:\`, `D:\`, `Z:\`), la carpeta de usuario, Escritorio,
> Windows, Archivos de programa, etc. **Solución (lado usuario)**: elegir la **subcarpeta** donde están los
> PDF (ej. `Z:\PDF_ISIS`, no `Z:\`), o copiar los PDF a una carpeta común (Documentos) y elegir esa.
> **Cambios de código**: el picker ahora abre con `startIn: "documents"`, el `confirm` avisa que no se puede
> elegir el disco entero, y el `catch` (no-Abort) explica el caso «contiene archivos del sistema». Tooltip
> del botón **🖨️ Carpeta PDF** actualizado.
>
> Nota: **v3.87** — **PPP: tabla sin scroll horizontal (garantizado)** (pedido del usuario: "no quiero
> scrollear"). Las columnas largas **Razón Social** (`.ppp-cli`), **Localidad** (col 7) y **Zona** (col 9)
> ahora envuelven con `overflow-wrap:anywhere` → su ancho **mínimo** deja de depender del texto. Resultado
> medido (Playwright, peor caso): el **mínimo** de la tabla es **~917px fijo**, y como la PPP está topeada
> en **1240px** (`#pppOverlay .planim-body > *{max-width:1240px}`), **nunca hay scroll** en monitor/laptop
> (sólo aparecería por debajo de ~920px de ancho de contenedor). El `.ppp-tablewrap{overflow-x:auto}` queda
> como red de seguridad pero no se dispara.
>
> Nota: **v3.86** — **PPP: buscador + tandas con error en rojo + imprimir por tanda + tabla más compacta**
> (pedido del usuario). (1) **Buscador** (`#pppSearchInp`, `_pppSearch`/`pppSetSearch`/`_pppSearchStr`):
> filtra por **cualquier dato** de la fila (NP, cliente, cód, tanda, localidad, zona, fecha, tipo) y sólo
> muestra coincidencias (filtra `programados`/`aProgramar`/`entreg` → los contadores de las pestañas
> reflejan los matches); al buscar, las tandas con coincidencias se **abren solas** (`_pppBlock`:
> `open = _pppOpen.has(id) || _pppSearch`). (2) **Tandas con error en ROJO + ⚠️**: en `_pppBlock`,
> `hasErr = pedidos.some(p._err.length)` → clase `ppp-tanda-err` (franja roja) + `⚠️` antes del nombre.
> (3) **Imprimir por tanda**: botón 🖨 en la **franja** (`pppPrintTanda(npsCsv)`) que busca e imprime **todos
> los PDF** de los pedidos de la tanda en secuencia (con Chrome `--kiosk-printing` salen solos; si no, un
> diálogo por PDF). (4) **Tabla más compacta** (sacar scroll + espacios muertos): padding de celda 8/12→5/7,
> botones de fila 5/12→4/8 y font 13→12, `.ppp-cli` min-width 160→130, Localidad min 84→72.
>
> Nota: **v3.85** — **PPP: control POR NP + fix del wrap "feo" + header "Localidad"** (pedido del usuario).
> (1) **Wrap**: el v3.83 había puesto `.ppp-tbl{white-space:normal}` para evitar scroll, pero con el ancho
> de 1240px (v3.84) **envolvía todo** (headers, badges) y quedaba feo. Se volvió a `white-space:nowrap` y
> sólo envuelven las columnas largas: **Razón Social** (`.ppp-cli`, ya envolvía) y **Localidad**
> (`.ppp-tbl td/th:nth-child(7){white-space:normal}`). (2) **Control POR NP, no por tanda**: en solo-lectura
> se **sacó** el botón **"✓ Controlar"** de la franja (`entBtn` gateado a `!PPP_READONLY`) y el panel
> **"✓ Controlar TODA la tanda"** (`pppControlarTanda`, ahora `if(!PPP_READONLY)`). En su lugar, cada fila
> de la pestaña **Programación** tiene un botón **Controlar / ✓ Controlado** (toggle `pppControlarToggle`,
> verde lleno = controlado, outline = sin controlar; sólo `_pppTab==="plan"`). Sigue siendo **local**
> (`vir_ppp_entregados`, no emite CRN); controlado + aún en Supabase ⇒ alarma 🚮 SACAR. (3) Header de la
> tabla **"Localidad / Barrio" → "Localidad"** (`PPP_THEAD`). Celda de acciones `.ppp-acc` (nowrap,
> derecha) con los botones Controlar + 🖨.
>
> Nota: **v3.84** — **PPP: layout compacto (ancho máx 1240px centrado, no 100%) + "✓ Controlar" local
> reactivado** (pedido del usuario: "nunca hace falta usar el 100%; optimizá los espacios"). (1) **Ancho**:
> el v3.83 había puesto la PPP a `max-width:none` (100%) → quedaba enorme. Ahora `#pppOverlay .planim-body
> > *{max-width:1240px}` + `align-items:center` → **columna centrada de 1240px**. (2) **Espaciado más
> compacto**: `.ppp-tanda` margin-bottom 12→5px y radio 12→10px; `.ppp-tanda-h` padding 10→6px y grid
> flexible (`18px 200px 1fr 120px auto`, antes anchos fijos 460/124); `.ppp-sec-t` margin 18→11 / padding
> 7→5 / fuente 14→13; `.ppp-tabs` margin 14/12→6/8; `.ppp-preview` margin-top 14→6; gap del `.planim-body`
> del PPP 12→8. (3) **"✓ Controlar" anda de nuevo desde la PPP** (segunda vía, **local**, lo eligió el
> usuario): en `_pppRowTrRO` volvió el tilde **✓ Controlado** por fila (clase `ppp-ctrl-only`, se ve sólo
> en modo Controlar) y el botón **✓ Controlar** de la franja sigue (abre `pppSetMode('ctrl')` →
> `pppControlar`/`pppControlarTanda`, escribe `vir_ppp_entregados` **local**). El **✏️ Editar** y su panel
> (fecha/devolver) quedan **ocultos en solo-lectura** (eso se corrige en Excel). ⚠ El tilde de la PPP es
> LOCAL (no emite CRN ni va a Supabase): se ve sólo en ese navegador. El control "real" sigue siendo el
> **RR** del operario (CRN → Supabase). Un pedido marcado como controlado y aún en la Programación de
> Supabase dispara la alarma **🚮 SACAR** (sacarlo del Excel).
>
> Nota: **v3.83** — **PPP: ancho completo (sin scroll) + "Sugerir tandas" solo-lectura e imprimible**
> (pedido del usuario). (1) **Ancho**: la PPP estaba limitada a **560px** por `.planim-body > *{max-width:560px}`
> (cap del editor de planimetría, v3.67) → la tabla de 12 columnas se salía con scroll horizontal. Override
> `#pppOverlay .planim-body{align-items:stretch}` + `> *{max-width:none}` → usa **todo el ancho de la
> página**; y `.ppp-tbl{white-space:normal;table-layout:auto}` (antes `nowrap`) → el texto largo (razón
> social, localidad) **envuelve** en vez de forzar scroll. (2) **Sugerir tandas (solo-lectura)**: en modo
> `PPP_READONLY` volvió el botón **🪄 Sugerir tandas**, pero NO edita: `pppSugerirView` calcula la
> sugerencia con el MISMO algoritmo que `pppSugerirTandas` (`_pppComputeSugerencia`: súper 1×cliente; resto
> por zona→cliente empacando ≤ m³/tanda; códigos `C<N°base><letra>`) **sin escribir edits**, y la muestra
> en un overlay `#pppSugOverlay` (`_pppSugHtml`: una tabla por tanda con NP·Cód·Cliente·Localidad·m³ +
> totales + aviso de los SIN ZONA que quedan afuera). Sirve para que la operadora la **cargue a mano en el
> Excel**. (3) **Imprimible**: botón 🖨 Imprimir (`pppPrintSug`) abre la sugerencia en una ventana nueva con
> CSS propio (`_PPP_SUG_PRINT_CSS`) y dispara `window.print()`. El N° base de la sugerencia sale del auto
> (v3.78, última tanda Supabase +1). No toca la PPP ni Supabase.
>
> Nota: **v3.82** — **PPP = visor SOLO-LECTURA de Supabase + panel de errores** (pedido del usuario: "por
> ahora que solo funcione en función de Supabase, que no corrija nada, solo visualizar; se sigue
> corrigiendo en Excel"). Flag **`PPP_READONLY = true`** (poner `false` vuelve a la PPP editable). En
> modo lectura: (a) `merge` ignora `vir_ppp_edits` y `pppLoadProgFromSupabase` no suma extras locales →
> la vista es **Supabase puro**; (b) se ocultan los controles de edición (Sugerir/Confirmar/N° base/borrar,
> el cuadro 🔗 "agregar a tanda", "Tandas armadas", botones OK/↩/✏️/✓); las filas (`_pppRowTrRO`) van como
> **texto** + botón 🖨 Imprimir. (c) **Panel de errores** arriba (`pppErroresHtml`/`_pppComputeErrors`,
> los 4 que pidió el usuario, anota `p._err` y resalta la fila): **🚮 SACAR** = pedido `programmed` cuyo NP
> está en entregados/controlados (CRN/CCR — sigue en la Programación de Supabase pero ya se entregó);
> **⚠ SIN ZONA** = el barrio no cae en ninguna zona (`pppZonaDeBarrio` vacío; no para Súper/Retira/Expo);
> **⚠ ZONA?** = la columna `zona` del Excel ≠ la que da el barrio (compara con `_pppZonaNorm`, formato/acentos);
> **⚠ TANDA** = tanda con rutas/camión mezclados (`_pppRuta`) o varias fechas de entrega. En lectura, los
> entregados **NO** se sacan de Programación (se muestran con el 🚮 para verlos). Verificado contra los
> datos: `zona` en Supabase viene igual que la que calcula la app (`Zona 1 - CABA Sur`…), y hay casos
> reales con `zona=''` (Micro Centro, Villa Sarmiento). ⚠ La PPP **no escribe nada** (ni local ni
> Supabase); las correcciones siguen en el Excel.
>
> Nota: **v3.81** — **PPP: la Programación pasa a salir de Supabase + el import dedupea contra Supabase**
> (pedido del usuario; antes era SOLO LOCAL y mostraba 0 programados aunque Supabase tuviera ~63). (1)
> Al abrir la PPP, `pppLoadProgFromSupabase()` lee **`PPP_Programacion_Diaria`** (`supaFetchAll`) y la usa
> como **BASE** de `_pppParsed.prog` (mapeo en `_pppRowFromSupa`: ⚠ `p.fecha`=`fecha_recep`,
> `p.localidad`=`barrio`; fechas `YYYY-MM-DD`→`dd/mm/aaaa` con `_pppSupaFecha`). Un pedido queda
> **`programmed`** si tiene **tanda O fecha de entrega** (los súper van por fecha; no se deriva por
> `tanda&&fecha` porque la semilla tenía casos con tanda-sin-fecha y fecha-sin-tanda). Las **ediciones
> locales** (`vir_ppp_edits`) siguen mandando **encima** (merge), y los pedidos locales cuyo NP **no**
> está en Supabase (importados sin sincronizar) se **mantienen** (`extra`). Si Supabase falla, queda lo
> local (no rompe). Primero renderiza local (instantáneo) y después reemplaza con Supabase. (2)
> **Dedupe de import**: `pppMergePedidos` ahora **omite** los NP que ya están en Supabase
> (`_pppSupaNps`, set que deja `pppLoadProgFromSupabase`) → al importar Formato PPP no se duplica lo que
> ya está; el status muestra "N ya en Supabase (omitidos)". (3) **Fix**: "↩ devolver a A Programar"
> (`pppPedidoAProgramar`/`pppTandaAProgramar`) ahora setea `programmed=false` + `fecha_entrega=""` (antes
> `delete`) para **override explícito** sobre la base de Supabase (si no, el pedido seguía "programado").
> ⚠ La **semilla** (`PPP_SEED`, 123 ped · ~83 programados en sus `edits`) sigue de fallback local; los
> `edits` viejos pueden pisar Supabase para esos NP (no se limpian para no perder trabajo del usuario).
> **Base Pedidos (Picking)**: el import local sigue inerte (solo timestamp; el picking ya lee
> `PPP_Base_Pedidos` de Supabase directo → sin riesgo de duplicado). El N° base (v3.78-79) no cambió.
>
> Nota: **v3.80** — **PPP: botón "🖨️ Imprimir" por pedido → manda a imprimir el PDF del NP desde la
> carpeta del servidor (ISIS)** (pedido del usuario). Cada fila de pedido (`_pppRowTr`) tiene un botón
> **🖨️ Imprimir** que llama `pppPrintNp(np)`. El admin conecta **UNA vez** la carpeta donde están los PDF
> (ej. `Z:\PDF_ISIS` en `\\LOEKE-SVR`) con el botón **"🖨️ Carpeta PDF"** (`pppConnectPdfDir` →
> `showDirectoryPicker({mode:"read"})`); el handle se guarda en IndexedDB (`vir-fs-handles`, key
> `pdf_isis_dir`) reusando los helpers `fshGet/Set/Del` + `_fshPerm` de la auto-carga del Excel (v3.41).
> **Por qué File System Access y no un link**: una página `https://…github.io` **no puede abrir un
> archivo `Z:\…` directo** (el navegador bloquea `file://`); esta API es la forma web-nativa de leer la
> carpeta local/mapeada. La carpeta tiene **~130k archivos** → NO se escanea: se abre por **nombre exacto**
> con `getFileHandle` (O(1)). Patrón del archivo: `Pedido de Clte_Div_` + **NP con ceros a 12 dígitos**
> (`000000097899`) + `_NN.pdf`; `pppFindNpPdf` prueba versiones `_00.._05` y se queda con la **más alta**
> (ancho 12 primario, fallback 13/11 por si difiere — constantes `PDF_PREFIX`/`PDF_WIDTHS`/`PDF_VERS`).
> **Imprime, NO sólo abre**: `_pppPrintPdf` lee el PDF a memoria (ArrayBuffer), lo carga en un **iframe
> oculto** y dispara `contentWindow.print()` (diálogo de impresión directo); si el navegador bloquea el
> print, último recurso abre el PDF en otra pestaña. ⚠ El diálogo de impresión **siempre aparece** (no se
> puede imprimir 100% silencioso desde el navegador, es por seguridad) — queda a un clic. Sólo **Chrome/
> Edge en PC** (el monitor; en celular no corre, igual que la auto-carga). Estado de la carpeta en
> `#pppPdfDirStatus` (`pppRenderPdfDirStatus`, al abrir la PPP). Sólo lectura → no toca el "SOLO LOCAL".
>
> Nota: **v3.79** — **PPP N° base: ahora se VE de dónde sale (vinculado a Supabase visible)** (el usuario
> reportó "no está vinculado a Supabase": el número salía bien pero sin ninguna señal de que viniera de la
> tabla, y si la lectura fallaba caía a local **en silencio**). Cambios: (1) **nota de origen** bajo el
> toolbar (`#pppBaseNote`, `_pppRenderBaseNote`) — **verde** "🟢 Supabase (Prog. Diaria): última tanda
> C63 → N° base 64" cuando la lectura anduvo, **roja** "🔴 No pude leer Supabase (…) — N° base local: N"
> cuando falla, "✍️ puesto a mano" si lo editás. (2) **Supabase es la fuente primaria**: `base = supaMax
> + 1`; lo local/`baseLast` quedó sólo como **piso anti-colisión** (si aplica, la nota lo aclara
> "ajustado"). (3) **Ya no se queda pegado a local**: sólo fija el día (`baseAutoDate`) si Supabase
> **respondió**; si falla, reintenta al reabrir (cooldown 6s, guard `_pppBaseBusy`). Verificado que el
> **RLS permite la lectura anónima**: `sql/ppp_supabase.sql` tiene `policy ppp_prog_select ... for select
> to anon using (true)` → en el navegador del usuario la lectura de `PPP_Programacion_Diaria` está
> habilitada (el sandbox NO puede probarla: el proxy bloquea `*.supabase.co`, igual que Google). `baseNote`
> + `baseOk` se guardan en `vir_ppp_cfg`. Resto de la lógica de v3.78 igual.
>
> Nota: **v3.78** — **PPP: el "N° base" (con el que se nombran las tandas `C<NN><letra>`) se calcula
> SOLO** (pedido del usuario; antes era fijo `60` a mano). Regla elegida = **un número nuevo por día de
> programación = última tanda en Supabase + 1**: lee la tabla **`PPP_Programacion_Diaria`** (las hojas
> de Programación Diaria espejadas; `pppFetchMaxTandaBase` vía `supaFetchAll`, **solo lectura** — no
> cambia el "SOLO LOCAL" de la PPP), saca el **mayor `C<NN>`** (`_pppBaseNumOf`, formato `C` + número +
> letra; ignora formatos de operario tipo `A15C`) y suma 1. **Mismo día → reusa** el número ya fijado
> (no sube); **día nuevo → recalcula**. Persiste en `vir_ppp_cfg` (`baseN` + `baseAutoDate` + `baseLast`
> high-water). Toma el **máx** entre Supabase, lo **local** (`pppLocalMaxBase`, edits+pedidos) y `baseLast`
> → no se repite ni baja aunque Supabase todavía no haya espejado lo de hoy. Hoy (última = `C63`) da
> **64** → tandas `C64A, C64B…`; mañana **65**. `pppSugerirTandas` ahora **continúa las letras**
> (`_pppLetterIdx`) si re-armás el mismo día (no pisa `C64A`). El campo **N° base** (`#pppBaseNInp`) se
> autocompleta al abrir/renderizar 📥 A Programar (`pppAutoBaseN` en `pppRenderProg`) y **se puede editar
> a mano** igual (un edit manual queda fijado para ese día; al otro día vuelve a autocalcular).
>
> Nota: **v3.77** — **REVIERTE v3.76: RR queda en los operarios Y se suma el botón admin** (aclaración
> del usuario). RR vuelve a la botonera del operario (`filas.row2` incluye `"RR"` de nuevo) y se sacó el
> cleanup de `showOperario` (ya no hace falta). El supervisor tiene **además** el botón **"Recepción
> Remitos (RR)"** en Administración (`openRemitosAdmin` → `showControlRemitos("0", true)`) que abre **la
> MISMA lista que el operario**: NP · Cod Cliente · Razón Social · Líos · Controlado (se quitó la columna
> Demora y `crFmtDemora` que se habían agregado en v3.75, para que sea idéntica). El modo admin sólo
> cambia el comportamiento de fondo (legajo `0`, no cierra ningún toggle). Resumen del modelo: RR lo
> pueden controlar **los operarios (botonera) y el admin (botón)**, los dos sobre la misma lista.
>
> Nota: **v3.76** — *(revertida en v3.77)* RR (Recepción Remitos) pasa a ser SOLO del admin (pedido del usuario). Se
> **sacó el botón RR de la botonera del operario** (`filas.row2`, ya no incluye `"RR"`). El control de
> remitos lo hace ahora el supervisor desde Administración con el botón **"Recepción Remitos (RR)"**
> (el de v3.75, `openRemitosAdmin` → `showControlRemitos("0", true)`; se renombró de "Remitos a
> controlar"). **Cleanup**: `showOperario` cierra cualquier **toggle RR colgado** del operario (`delete
> st.toggles.RR`) — un toggle abierto bloquea EP/TP/AP/TAP, así que sin el botón quedarían trabados. El
> resto de la infra RR (dispatch `code==="RR"`, `TOGGLE_CODES`, `INC_TOGGLE`, `SURVIVING_TOGGLES`) se
> deja: es inofensiva sin botón y el cleanup la neutraliza. **CR** (Control Remitos, otra cosa) sigue en
> la botonera del operario.
>
> Nota: **v3.75** — **Admin: botón "🚚 Remitos a controlar"** (pedido del usuario). Da al supervisor
> la MISMA lista de RR (`showControlRemitos`) — cargados al camión sin controlar, con cliente (PPP +
> "Pedidos Entregados"), líos y **Demora** desde que se cargó — y puede **tildar Controlado**. Botón
> nuevo en el panel de Administración (`openRemitosAdmin`). Se reusa todo el código de RR con un flag
> `_cr.admin`: el título cambia, se agrega la columna **Demora** (`crFmtDemora`, sólo en admin), y al
> «Terminé» emite **CRN** por NP igual que el operario **pero NO cierra ningún toggle RR** (el admin no
> tiene botonera). Usa **legajo "0"** (sistema, excluido de reportes de operario, igual que CRA); el
> CRN igual mueve el pedido a Pedidos Entregados y limpia la alarma "🚨 SIN CONTROLAR" del PPP. NO es
> lo mismo que **🏭 "Carga Recepción Mercadería"** (esa es la mercadería que ENTRA de talleristas).
>
> Nota: **v3.74** — **Recepción Remitos (RR): el cliente de los NP arrastrados sale de "Pedidos
> Entregados"** (pedido del usuario). Síntoma: RR mostraba **Cod Cliente / Razón Social en "—"** para
> casi todos los NP. Causa: esas dos columnas salían SÓLO del **PPP del día** (`fetchMonitorSheet`); los
> NP cargados en días anteriores (backlog cargado-sin-controlar, ventana de 7 días) **ya no están** en
> la PPP de hoy → "—". **Fix**: nuevo `fetchEntregadosMeta()` lee la hoja **"PPP Excel Pedidos Entregados
> 2026"** (`MONITOR_HISTORIC_CSV_URL`, gid `2146771217`) y arma `NP → {cod, rs}`; `fetchCRData` lo usa
> como **fallback** sólo para los NP que faltan (no lee la hoja si no hace falta). La hoja usa el **mismo
> layout de columnas que la PPP** en las filas recientes (`NP=col2, COD=col4, RS=col5`; filas viejas tienen
> la Razón en col6 → fallback; indexa col1 y col2 porque en filas viejas el N° está en col1). Cacheado 5
> min. ⚠ Los **Líos** siguen saliendo de `TAL` (armado): si una tanda no cargó los líos, quedan en "—"
> igual (eso NO lo arregla esto). No se tocó Carga Camión (CC ya saca la razón de `Facturacion_NP`).
>
> Nota: **v3.73** — **Planimetría: el código 513 pasa de sector D36 → F13** (pedido del usuario).
> En `planimetria.js`: `"513":["D36",100]` → `"513":["F13",100]`. Se cambió **sólo el sector**; el
> orden de picking queda en **100** (no se tocó la secuencia). Cache-buster `planimetria.js?v=3.73`.
> No hay override en Supabase para 513, así que manda la estática. ⚠ Con orden 100 el 513 se levanta
> entre los códigos del sector D (orden 100–103); si se quiere que se levante junto con los otros de
> F13 (~orden 104), hay que reordenar aparte.
>
> Nota: **v3.72** — **Planimetría: alias con cero adelante para TODOS los códigos de 2 dígitos**
> (pedido del usuario, generaliza v3.70/v3.71). En vez de ir uno por uno, se agregó a `planimetria.js`
> el alias `"0XX":["sector",orden]` = `"XX"` para **cada código numérico de 2 dígitos** (12 nuevos:
> 052,053,054,055,058,059,066,067,070,034,043,097 — los 5 previos 026/027/031/057/099 ya estaban →
> 17 en total). Mismo sector que el gemelo, sin colisiones (el script saltea los que ya tenían alias).
> Cache-buster `planimetria.js?v=3.72`. ⚠ Siguen siendo alias **sobre el archivo generado**: si se
> regenera del Excel se pierden (re-correr el script o que la hoja "Picking" ya traiga el cero). Los
> códigos de **1 dígito no existen** en la planimetría, y los de **3+** ya vienen completos, así que
> con esto queda cubierto todo el rango de ceros adelante numéricos.
>
> Nota: **v3.71** — **Planimetría: más alias con cero adelante 031/099** (mismo caso que v3.70).
> Se agregaron a `planimetria.js`: `"031":["H45",158]` (=`31`) y `"099":["L09",177]` (=`99`),
> mismo sector que su gemelo. Cache-buster `planimetria.js?v=3.71`. Mismo ⚠ que v3.70 (son alias
> manuales sobre el archivo generado; si se regenera del Excel, re-agregarlos).
>
> Nota: **v3.70** — **Planimetría: alias con cero adelante 026/027/057** (reporte de campo:
> tanda **C54D**, legajo 8, "SIN PLANIMETRÍA"). Mismo patrón de ceros que la "E" (v3.43/44): el
> picking lee la base por `/export` y trae los códigos **como texto con cero adelante** (`026`),
> pero `planimetria.js` (`window.GONDOLA`) los tenía **sin** cero (`26`). El lookup es exacto
> (`gOf = G[String(c).toUpperCase()]`, **no normaliza** ceros) → `G["026"]` no encontraba `"26"` →
> `PSP` (Picking sin planimetría) + aviso Telegram. **Fix de datos**: se agregaron a `planimetria.js`
> los alias `"026":["F01",107]` (=`26`), `"027":["F05",106]` (=`27`), `"057":["B57",18]` (=`57`) —
> **mismo sector** que su gemelo. Bump del cache-buster `planimetria.js?v=3.70` (si no, el browser
> sirve el cacheado). ⚠ `planimetria.js` es **generado** de la hoja "Picking" de `AAA_PPP_Vigente.xlsm`:
> si se regenera, estos alias se pierden salvo que se sumen también a esa hoja (o se cargue por el
> editor de planimetría → Supabase, que mergea sobre la estática y sobrevive a la regeneración).
> 💡 Pendiente/opción ofrecida: **normalizar ceros en el lookup** (`gOf` probar `G[cod]` y
> `G[cod.replace(/^0+/,"")]`) cerraría toda la clase de bug de una, sin alias manuales (no implementado
> por ahora: toca la lógica de pares Nacional/Importado y el aviso PSP).
>
> Nota: **v3.69** — **Control Remitos (CR): pasa de *toggle plano* a una pantalla de control**
> (pedido del usuario; cierra "los facturados con líos tienen que aparecer en CC **y en CR**").
> **Modelo confirmado por el usuario**: CR y CC **se nutren los dos de los NP facturados** del
> reparto (misma fuente: `Facturacion_NP` cerrados ≥ `CC_REPARTO_DESDE_ISO`), pero son **pasos
> independientes** — un NP está en CC hasta que se **carga** (`CCN`) y en CR hasta que se
> **controla** (`CCR`). **RR se nutre de lo que marca CC** (`CCN`), eso **no cambió**. Al tocar
> **CR** se abre un popup (`showControlRemitosCR`/`fetchCCRData`/`ccrRender`, espejo de Carga
> Camión) con NP · Razón Social · **Líos** (de `TAL`) · **Controlado** (tic); al «Terminé Control»
> manda un **`CCR`** (`texto="NP|TANDA"`, id determinístico `ccr_<legajo>_<np>_<día>` + upsert) por
> NP tildada y cierra el toggle CR. **El NP controlado desaparece SÓLO de CR** (no resta `CCN`) y
> **`CCR` NO alimenta RR** (a diferencia de CC, que sí: RR lee `CCN`). `CCR` está en el `isUpsert`
> (index.html + sw.js); lo **ignoran** el monitor y el módulo de inconsistencias (no está en
> `INC_CORE`/`INC_TOGGLE`), igual que `CCN`/`CRN`. Wiring del botón CR igual que CC/RR (re-toque
> re-abre el popup; el cierre es sólo por «Terminé»). 📦 **A futuro (guardado, NO implementado)**:
> medir **productividad de CC y CR en m³/hora** = Σ m³ de los NP con `CCN` (CC) / `CCR` (CR) sobre
> el **tiempo del toggle** (ej.: 2 m³ en 1 h → 2 m³/h). Los eventos ya llevan `NP|TANDA` + timestamp
> y el toggle CR/CC ya registra apertura/cierre → alcanza para cruzar los m³ (del PPP/Sheet) después.
>
> Nota: **v3.68** — **Carga Camión (CC): ahora muestra la cantidad de líos por NP** (📦), pedido
> del usuario ("los NP facturados tienen que aparecer en CC … con la cantidad de líos"). Los líos
> salen de los eventos **TAL** (anotados al terminar armado), el **mismo origen** que ya usa
> Recepción Remitos (RR). `fetchCCData` ahora también trae los `TAL` (ventana 7 días) y arma un
> `Map` NP→líos; cada item lleva `lios` (o `null` si el armador no lo cargó). `ccRender` agrega
> `📦 N` por fila (gris `—` si no hay dato, gris si es 0; clases `.cc-lios`/`.cc-lios0`). No cambia
> qué NP aparecen (siguen siendo el reparto: facturados+cerrados − cargados) ni los eventos.
> ⚠ **Pendiente (a definir con el usuario)**: hacer que **CR = Control Remitos** (hoy *toggle plano*
> desde la v3.45, sin lista; distinto de RR) muestre también los facturados con líos — falta decidir
> si CR sólo **muestra** la lista o además lleva un tic "Controlado" registrado (evento nuevo).
>
> Nota: **v3.67** — Editor de Planimetría, polish estético: todo el cuerpo se acota a una
> **columna centrada de 560px** (`.planim-body{align-items:center}` + `.planim-body > *{max-width:560px}`)
> → ya no se estira a todo el ancho ni queda el hueco. Filas con **hover** (sombra suave),
> botones Guardar/Borrar de **igual alto** (42px) con hover, inputs con **anillo de foco**, la
> columna Sector más justa (150px) y el N° de orden centrado. Solo CSS de `#planimEditorOverlay`.
>
> Nota: **v3.66** — Editor de Planimetría: (a) el buscador **vacío ahora muestra TODAS las
> ubicaciones** (antes pedía buscar algo) **ordenadas por N° de orden** (orden de góndola, no
> alfabético) — `planimRender` ordena por `ordOf`, cap 500. (b) La columna **Sector** dejó de
> ocupar el 100% (`flex:1 1 120px` → `flex:0 1 220px` en `.plh-sec`/`.planim-row-sec`) y los
> botones Guardar/Borrar se alinean a la derecha (`margin-left:auto`). Además, **limpieza en
> Supabase**: se deduplicaron policies RLS (se borraron las `{authenticated}`-solo que estaban
> de más en `Control_Modo_OP` y `Entregas …`, quedando las `{anon,authenticated}`) y se
> normalizó la única fila `estado='listo'` → `'procesado'`.
>
> Nota: **v3.65** — limpieza post-auditoría de `recepcion.js`: se sacó el **CSS muerto** que
> quedó de los reworks de Pendientes (bloque del checklist `chk*` de v3.58 y de las tarjetas
> v1 `pendList`/`pendItem`/`pendElapsed`/…) y la función **`pendTd`** (la usaba la versión
> tabla, ya no). Sin cambios de comportamiento. Auditoría: sintaxis OK, sin funciones
> rotas/llamadas-sin-definir; backend OK (columnas + RLS de `Control_Modo_OP`, bucket
> `remitos`, policies de Entregas), 0 archivos huérfanos. `recepcion.js?v=3.65`.
>
> Nota: **v3.64** — Pendientes: la **Demora** (`.pcDemora`, "⏱ Xhs") se agranda a 18px (vs 13px
> del resto de la meta) para que se note. `recepcion.js?v=3.64`.
>
> Nota: **v3.63** — Pendientes: las tarjetas tienen **ancho fijo** (360px) en vez de estirarse
> (`1fr`) → cada una mide siempre lo mismo haya 2 o 7, y entran las que quepan por fila
> (`grid-template-columns: repeat(auto-fill, minmax(min(100%,360px), 360px))`). `recepcion.js?v=3.63`.
>
> Nota: **v3.62** — Pendientes optimizado **para PC** (lo usa una operadora en monitor): las
> tarjetas pasan de una columna a una **grilla multi-columna** (`grid-template-columns:
> repeat(auto-fill, minmax(340px,1fr))`) usando **todo el ancho** (clase `pendWide` en `opPage`
> → saca el cap de 780px) → se ven varias recepciones por fila y se **scrollea mucho menos**.
> Tarjetas un poco más compactas. `recepcion.js?v=3.62`.
>
> Nota: **v3.61** — fix visual en Recepción: el header sticky del Modo OP (`.opHeader`) no
> tenía `z-index`, así que al scrollear Pendientes las tarjetas (y su botón Enviar) se
> pintaban **por encima** de la barra "Pendientes". Se le puso `z-index:6` → ahora el header
> tapa lo que scrollea debajo. `recepcion.js?v=3.61`.
>
> Nota: **v3.60** — **Pendientes pasó de TABLA horizontal a TARJETAS verticales** (pedido del
> usuario; evita scroll horizontal y deja los controles grandes/claros). Cada recepción = una
> tarjeta: header (Tallerista + Tipo + RTO/FC), meta (Fecha · Hora · Marca · ⏱ Demora en vivo),
> Entrega (detalle + total), y debajo las acciones en filas: **Carga ISIS** (tilde), **Control
> Partes Talleristas** (tilde "Corresponde" + botón "No corresponde"), **Faltantes x Día**
> (tilde), **Foto RTO** (adjuntar/arrastrar → Storage). Pie con **Enviar** → código de 4 díg.
> El tilde se rediseñó (checkmark dibujado con `::after`, más prolijo). Misma lógica de
> persistencia viva en Supabase de v3.59 (UPDATE por toque, nada en localStorage; `pendCard`/
> `pendCheckRow`/`pendPartesRow`/`pendFotoRow` reemplazan las celdas de tabla). `recepcion.js?v=3.60`.
>
> Nota: **v3.59** — **Pendientes (Marianela) = TABLA con acciones por fila, todo en
> Supabase (NADA en localStorage)**. Columnas: Fecha · Hora · Demora (en vivo, "Xhs"/"X,5hs"
> desde `created_at`) · RTO/FC · Tipo · Marca (línea) · Tallerista · Entrega (detalle) ·
> **Carga ISIS** (tick) · **Control Partes** (tick "Corresponde" + botón "No corresponde") ·
> **Faltantes x Día** (tick) · **Foto RTO** (adjuntar/arrastrar → sube a Storage bucket
> `remitos`) · **Enviar**. Cada tick/foto se **persiste al toque** (`pendPersist` = UPDATE de
> la fila; **no duplica**, y al recargar la fila vuelve con lo guardado — columnas nuevas en
> `Control_Modo_OP`: `isis bool`, `control_partes text`, `faltantes bool`, `foto_url text`,
> `codigo text`). **Enviar** (habilitado con los 4 completos) genera un **código de 4 dígitos
> único del día** (`pendGenCodigo`), lo guarda con `estado='procesado'` + `procesado_at`, y lo
> muestra en la fila. Se reemplazó el checklist en pantalla aparte (v3.58) por esta tabla.
> Storage: bucket público `remitos` + policies insert/select para anon/authenticated.
> `recepcion.js?v=3.59`.
>
> Nota: **v3.58** — **Recepción → Pendientes: botón "Procesar" + checklist de Marianela +
> horas en vivo**. (a) El botón de cada pendiente ahora dice **"Procesar"** (antes "Listo").
> (b) Cada fila muestra **⏱ "hace X h Y min"** desde `created_at` (cuándo se cargó por RT),
> refrescado **en vivo** cada 30 s (`pendFmtElapsed`/`pendTickElapsed`/`_pendTimer`). (c) Al
> tocar **Procesar** se abre un **checklist** (`pendAbrirChecklist`/`renderChecklist`, step
> `"checklist"`) que Marianela tiene que confirmar: **Carga a ISIS · Control Partes Talleristas
> (botones Corresponde / No corresponde) · Faltantes x Día · Enviar la foto del remito**. Recién
> con los 4 tildados se habilita **"✓ Procesar recepción"**, que hace **SOLO UPDATE** de la fila
> existente (`estado='procesado'`) → **no se duplica en Supabase**, y vuelve a la lista (la
> recepción ya sale de Pendientes). ⚠ Por ahora el checklist es un **gate** (no persiste qué
> tildó); si se quiere auditoría (ISIS/corresponde/etc.) se agrega columna + se guarda en el
> mismo UPDATE. La foto del remito es un **tilde de confirmación** (no sube archivo todavía).
> `recepcion.js?v=3.58`.
>
> Nota: **v3.57** — **Recepción (supervisor): menú LOCAL Carga / Pendientes + checklist
> "Pendientes"**. El botón "Carga Recepción Mercadería" ahora abre `window.openRecepcionMenu()`
> (en `recepcion.js`): un menú con **✍️ Carga Manual** (el flujo del operario) y **📋 Pendientes**.
> **Pendientes** lista las recepciones cargadas leyendo **`Control_Modo_OP`** (`estado='pendiente'`,
> orden por `created_at` desc) — fecha · tallerista/prov · línea · RTO/FC · detalle (códigos·cajas) ·
> total — con un botón **✓ Listo** por fila que la marca revisada (`update estado='listo'`) y la saca
> de la lista. Lee/escribe con la sesión anónima del módulo (`supabase` en recepcion.js). Navegación:
> nuevo flag `opState.fromMenu` (operario RT entra directo a la carga sin "Atrás"; el supervisor ve
> "Atrás" → vuelve al menú); `opResetState` extraído de `openOp`. ⚠ Requiere la tabla
> **`Control_Modo_OP`** + RLS (insert/select/update para anon/authenticated) — SQL por chat; si falta,
> Pendientes avisa "¿falta la tabla/permisos?". `recepcion.js?v=3.57`.
>
> Nota: **v3.56** — **"Carga Recepción Mercadería" (supervisor) ahora es 100% LOCAL**. El
> usuario **borró** la app externa `Control-Carga-Remitos-FC`, así que el iframe del panel
> Admin daba **404**. Se quitó el iframe (overlay `#recepcionAdminOverlay`, `recpOpen`,
> `recpShowChooser`, `recpAutoNav`, `closeRecepcionAdmin`, `RECEPCION_ADMIN_URL`/`_CARGA_URL`)
> y `openRecepcionAdmin` ahora abre el **Modo OP embebido** `window.openRecepcionOp()` de
> `recepcion.js` (el mismo que usan los operarios al tocar **RT**), sin legajo (no toca el
> acumulador de cajas del RT). ⚠ Para que **guarde** hace falta la **policy RLS de INSERT**
> en `Entregas Tallerista Virgilio` / `Entregas Prov AT` (sesión anónima → rol
> `authenticated`); si no, salta *"new row violates row-level security policy"*. La opción
> **"Pendientes"** del chooser viejo no quedó embebida (era la home de la app borrada).
>
> Nota: **v3.55** — **Revertido el corte de v3.54** en `facFetchFcKeys`. El backlog de tandas viejas
> en "a facturar" no era por falta de un corte en el código, sino porque **la PPP no estaba
> actualizada** (la Programación Diaria todavía tenía esas tandas ya entregadas). Como "a facturar"
> se nutre de la PPP, el fix correcto es **actualizar la PPP** (sacar/mover las entregadas), no meter
> un corte por fecha de armado que además podría esconder tandas legítimas. `facFetchFcKeys` vuelve a
> marcar FC con solo `TP` + `TAP` (sin filtro de fecha). El corte del **CC** (`CC_REPARTO_DESDE_ISO`
> en `fetchCCData`) se mantiene: ese sí filtra `Facturacion_NP` (otra fuente, no la PPP).
>
> Nota: **v3.54** — *(revertida en v3.55, ver arriba)* corte de go-live por fecha de ARMADO (TAP) en
> "a facturar". Se descartó: el backlog salía por la **PPP desactualizada**, no por falta de corte.
>
> Nota: **v3.53** — **Contador "NPs facturados hoy" ya no se resetea al "Generar PDF"**. Mostraba
> `_facNpsHoy.size` (facturados **pendientes de cierre**), así que al cerrar (PDF) los NP pasaban a
> tener `cierre_id` y el contador volvía a **0** (parecía que no se había facturado nada). Ahora
> cuenta los NP con **`facturado_at` de hoy** (BsAs), con o sin cierre → nuevo `_facCountHoy`, que
> `fetchFacturadosTodos` calcula (suma `facturado_at,np` al select). El chip "NPs facturados hoy" y la
> línea de estado usan `_facCountHoy`. Los botones "Generar PDF"/"Revertir" siguen atados a
> `_facNpsHoy` (los pendientes de cierre, que sí es lo que se cierra/revierte).
>
> Nota: **v3.52** — **Carga Camión (CC) = el REPARTO, no los facturados sin cerrar** (cambio de
> modelo, pedido del usuario). Antes el CC mostraba los facturados **sin cerrar** (`cierre_id IS
> NULL`) y al "Generar PDF" desaparecían — al revés de lo correcto. Ahora el ciclo termina cuando se
> **carga al camión**, no cuando se factura. **Nuevo CC** (`fetchCCData` + `showCargaCamion`): muestra
> los NP **facturados y CERRADOS** (`cierre_id` no nulo = ya pasaron por "Generar PDF" / están en un
> reparto) **menos** los ya cargados (eventos **`CCN`**). O sea: aparecen **al Generar PDF**, y
> desaparecen **al cargarlos** (en la próxima apertura, tras "Terminé"). Mismo patrón que Control
> Remitos (cargados − controlados), un paso antes. **Sin ventana de tiempo**: si un NP del reparto no
> se cargó, queda visible (se ve el error) hasta que se carga. **Corte de arranque**
> `CC_REPARTO_DESDE_ISO = 2026-06-22`: lo facturado/cerrado antes se asume entregado a mano (había
> 279 cerrados sin ningún CCN — el flujo de CC por app es nuevo) y NO ensucia la pantalla.
> `Facturacion_NP` ya trae tanda/razón social → el CC no usa el Google Sheet. **El PDF / cierre NO
> cambió.** Monitor: el **✅ "Tandas a FC" ahora PERSISTE** tras el PDF (usa `_facNpsTodos` además de
> `_facNpsHoy`; antes desaparecía al cerrar); la tanda sigue saliendo del panel sola al entregarse
> (`CRN`).
>
> Nota: **v3.51** — **Ajuste del QR de fichada en el TV box**: el QR de v3.50 (clamp 140px) quedaba
> ~3px más ancho que el espacio reservado a la derecha (`padding-right` ~157px del `.monitor-right-bottom`)
> y **tapaba un pedacito de "Total por día"**. Se baja a `clamp(120px, 24vh, 150px)` → entra con ~17px
> de aire, sigue ~3× más grande que el original (40px) y no se solapa. Además se **centra dentro de su
> zona** (`bottom: 20px; right: 12px` en vez de pegado a la esquina 8/8) → márgenes parejos arriba/abajo
> e izq/der. (Nota: con MUCHAS tandas a FC,
> las últimas filas siguen sin entrar en la TV; se evaluó una banda full-width multi-columna pero se
> descartó porque al haber muchas tandas en la tabla izquierda no hay forma de que entre todo en 494px.)
>
> Nota: **v3.50** — **Monitor TV en pantallas CORTAS/achatadas** (TV box ~979×494 "modo
> ordenador"): el layout escalaba por **ancho** (vp-narrow/medium/wide) pero faltaba el eje de
> **alto** → a poca altura el panel derecho (stats + FC + Total) no entraba y los cards de abajo
> ("Tandas a FC", "Total por día") quedaban cortados (había que scrollear). **Fix CSS-only**: nuevo
> bloque `@media (max-height: 560px)` al **final** del `<style>` (gana por orden de fuente a las
> reglas base del modo TV/vp-narrow) que comprime los verticales (header, paddings de tablas, gaps)
> para que entre **sin scroll**. Además **agranda el QR de fichada** en angosto: estaba clavado a
> 40px desperdiciando el ~espacio reservado a la derecha → ahora `clamp(140px, 28vh, 180px)`. No
> toca el JS ni afecta TVs de alto normal (>560px).
>
> Nota: **v3.49** — **FIX Facturación: un NP ya facturado reaparecía como pendiente** (y al
> re-tildarlo se reabría, dejando cierres huérfanos). Síntoma: tildabas un NP, dabas "Terminé —
> Generar PDF" (se generaba el cierre OK) y **el NP volvía a la lista** con su ✓, en un loop; cada
> vuelta dejaba el cierre anterior con 0 NPs. **Causa**: `facRender` ocultaba sólo los facturados
> **pendientes de cierre** (`_facNpsHoy` = `cierre_id IS NULL`), no los ya **cerrados**; si la tanda
> seguía en FC, el NP cerrado reaparecía. **Fix**: nuevo set **`_facNpsTodos`** (todos los NP en
> `Facturacion_NP`, con o sin cierre, vía `fetchFacturadosTodos`) y `facRender` ahora excluye
> `_facNpsHoy` **o** `_facNpsTodos` → un NP facturado (pendiente o cerrado) **no vuelve** a la lista.
> `facRevertir` saca los revertidos de `_facNpsTodos` para que sí vuelvan a pendientes. Se mantiene
> el conteo "facturados hoy" sobre `_facNpsHoy` (pendientes de cierre) y la Carga Camión sigue
> leyendo `cierre_id IS NULL`.
>
> Nota: **v3.48** — **FIX crítico: HTTP 400 en Facturación, Carga Camión, PPP-Supabase y
> Planimetría** por el cache-buster `&_=<timestamp>` en las URLs de Supabase. **Causa**: PostgREST
> (Supabase actualizó la versión y se volvió estricto) interpreta `_=1782…` como un **filtro sobre
> una columna inexistente `_`** y responde **400**. Confirmado en los logs de la API: de los GET
> recientes, los que llevaban `&_=` daban **400** y los que no, **200**. Síntomas: el operario tocaba
> **Carga Camión** y veía "No se pudo cargar (¿sin conexión?). HTTP 400" (`fetchFacturadosHoy` no
> tiene fallback); en **Facturación** el monitor de ventas mostraba "NPs facturados hoy: 0", el
> botón "Terminé — Generar PDF" gris y **NPs ya cerrados reaparecían** (al fallar la query,
> `_facNpsHoy` quedaba vacío → no ocultaba nada ni contaba). **Fix**: se quitó `&_=`+`Date.now()` de
> las 3 llamadas REST a Supabase (`fetchFacturadosHoy`, `supaFetchAll`/PPP, `loadPlanimetriaRemote`);
> el anti-caché ya lo daba `cache:"no-store"`. Los cache-busters `&_=` de las URLs **CSV de Google**
> (picking, volumen, monitor PPP/histórico, fichadas-monitor) se mantienen: Google sí los tolera.
> ⚠ Regla: **nunca** poner `&_=`/params desconocidos en URLs de PostgREST/Supabase; cache-bustear con
> `cache:"no-store"`.
>
> Nota: **v3.47** — **Carga Camión: botón "Terminar sin cargar por app"** (pedido del usuario).
> El popup de Carga Camión (`showCargaCamion`) cuando **falla la carga de la lista** (HTTP 400 /
> sin conexión) o **no hay NP facturados** sólo ofrecía "Cerrar" (que **minimiza** y deja el
> toggle `CC` abierto → el operario quedaba trabado). Se agregó **"✓ Terminar Carga Camión (sin
> cargar por app)"** (`ccEndWithoutLoading`) que **cierra el toggle CC** (evento `CC`, con
> `ts_inicio`) **sin** mandar ningún `CCN` — escape para cuando se cargó el camión sin usar la
> app o la lista no levanta. Pide confirmación. (El flujo normal ya podía cerrar con "Terminé
> (0 cargadas)"; esto cubre los estados de error/vacío donde ese botón no aparecía.)
>
> Nota: **v3.46** — **FIX crítico de compatibilidad: la app NO cargaba en navegadores
> viejos de TV** (kiosko/monitor). El bloque principal de `<script>` de `index.html`
> usaba el operador **`??` (nullish coalescing, ES2020)** en `parseHHMMtoHours(...) ?? 8/17`
> (cálculo de horas trabajadas). `??` recién existe desde **Chrome 80**; el **TV box tiene
> Chrome 75** y la **TV LG** (webOS) es aún más vieja → tiraban **SyntaxError** y abortaba
> TODO el bloque principal de JS, que incluye el código de **modo kiosko** (`?monitor=tv&key=tv`).
> Síntoma: la URL entraba con `&key=tv` pero **NO se borraba la clave** ni abría el Monitor
> → caía al **login** (el `<script>` de `initAuth` es otro bloque y sí parseaba). Se
> reemplazó `?? N` por un chequeo `(_x == null) ? N : _x` (ES2017, mismas semánticas: el
> default solo si es null/undefined, respeta el `0`=medianoche). También se reescribió un
> `Object.fromEntries` (Chrome 73+) a mano por la LG. **Regla:** el proyecto apunta a
> **ES2017** — NO usar `??`, `?.`, `||=`, `?.()`, `replaceAll`, `Promise.allSettled`
> ni nada ≥ES2018 en `index.html` (rompe las TVs). Diagnóstico rápido (v2.52): si el
> `#versionBadge` queda **vacío** = el JS NO corrió (parse error en un navegador viejo).
>
> Nota: **v3.45** — **Se separó el "Control Remitos" en DOS botones** (pedido del usuario).
> Toda la lógica de descarga (popup `showControlRemitos`: tabla de NP cargadas al camión,
> tildar **Controlado**, «Terminé» → un **CRN** por NP + pasar a Pedidos Entregados) pasó del
> botón **CR** a un botón NUEVO **RR = "Recepción Remitos"** (en `filas.row2`). **RR** es ahora
> el toggle que abre/re-abre el popup (1er toque = abre + evento `RR` apertura; «Terminé» =
> `CRN` por NP + cierra el toggle `RR`); reusa todo el código `_cr*`/`crRender`/`fetchCRData`
> (sólo cambió a qué toggle se ata). **CR = "Control Remitos"** quedó como **toggle plano**: el
> operario sólo lo toca **al inicio y al fin** (sin popup, no pide cantidad). Ambos están en
> `SURVIVING_TOGGLES` (`["CR","RR"]`; MG salió en v7.68), `TOGGLE_CODES`, `NEVER_INPUT`, `INC_TOGGLE`/`INC_DESC`
> y la sugerencia "Continuar". Los eventos **CRN/CRA** y la integración PPP (controlados →
> Pedidos Entregados) **no cambiaron** (siguen leyendo `CRN`).
>
> Nota: **v3.44** — **Origen del fix de importados (E) en el picking**: `fetchPickingBaseFromSheets`
> ahora lee la base por **`/export?format=csv&gid=845301421`** (pestaña "PPP Excel Base Datos
> Pedidos") en vez de **gviz**. El `export` devuelve los valores **como texto** → respeta los
> códigos `035E` y el cero adelante `026`, que gviz coaccionaba a número y descartaba (v3.43).
> **gviz queda de respaldo** (`PICKING_BASE_CSV_URL_GVIZ`): si el export falla o devuelve HTML
> (login/permiso), cae a gviz para no dejar el picking vacío (detecta HTML con `slice(0,64).trim()`
> empezando en `<`). Con esto, hasta una tanda pickeada **antes** de sincronizar a Supabase trae
> bien los importados. Constantes nuevas `PICKING_BASE_DOC` / `PICKING_BASE_GID`. ⚠ El `export`
> requiere que la hoja sea accesible por link (igual que gviz); si algún día deja de andar, revisar
> el compartido del Sheet.
>
> Nota: **v3.43** — **FIX picking: los códigos IMPORTADOS (terminados en "E") no se
> pickeaban**. Diagnóstico (datos): en 60 días, 0 de 398 `PKC` tenían código E, pese a que
> los E son ~25% de la base. El picking suma la base por NP; cuando a la tanda le faltaban
> NP en Supabase (pedidos del día sin sincronizar), el fallback **reemplazaba TODO** el
> agregado con la hoja de Google (`fetchPickingBaseFromSheets`). Esa hoja, leída vía
> **gviz** (`tqx=out:csv`), **infiere la columna Artículo como NUMÉRICA** → descarta los
> códigos **texto** `035E` (los devuelve vacíos → `if(!art)continue` los saltea) y les saca
> el cero (`026`→`26`). Por eso desaparecían los importados de toda la tanda. **Fix (app)**:
> el fallback ahora **solo rellena los NP faltantes** desde Sheets, **sin pisar** los que
> Supabase trae bien (con la E) → apenas la tanda sincroniza a Supabase, el picking muestra
> los importados. ⚠ **Pendiente (origen)**: una tanda pickeada ANTES de sincronizar todavía
> cae a gviz (sin E); se cierra haciendo que la hoja entregue la columna **Artículo como
> TEXTO** (formato Texto plano en el Sheet, o leerla con `/export?format=csv&gid=…` en vez
> de gviz). La base correcta vive en `PPP_Base_Pedidos` (Supabase).
>
> Nota: **v3.42** — **El "picking" ya estaba en la auto-carga (v3.41), era cuestión de
> nombre**: el archivo del picking es el que la app llama **"Base Pedidos"**
> (`PPP Excel Base Datos Pedidos`, Pedido·Artículo·Cajas) — la misma fuente que usa el
> picking en vivo. Se **renombró a "Base Pedidos (Picking)"** en el botón de import, en
> el cartel de "última importación" y en la fila de auto-carga (`PPP_AUTO_LABEL.base`),
> para que se vea claro que ese slot ES el picking. Comportamiento idéntico al Formato
> PPP (elegir 1 vez → auto-levanta al cambiar, con anti-duplicado por firma). Aclaración:
> el picking *en vivo* (flujo EP `fetchPickingBase`) sigue leyendo de Google Sheets /
> Supabase (se refresca solo); este import local de Base Pedidos sigue SOLO LOCAL.
>
> Nota: **v3.41** — **PPP: auto-carga del Excel desde una carpeta local** (File System
> Access API; pedido del usuario). En vez de importar a mano, el supervisor **elige el
> archivo una vez** (botón "Elegir archivo" en el menú ⬆ Importar, para Formato PPP y/o
> Base Pedidos) y la app lo **levanta solo** al abrir la PPP y cada 3 min mientras esté
> abierta. ⚠ **Solo Chrome/Edge en PC** (la API no existe en Safari/Firefox/iOS → ahí se
> degrada y queda solo el import manual, que **sigue disponible**). El **handle** se
> guarda en IndexedDB (DB aparte `vir-fs-handles`, sobrevive recargas); tras reiniciar el
> navegador el permiso se re-confirma con **1 clic** ("🔓 Reconectar"). **ANTI-DUPLICADO**
> (los 2 reportes se pisan a diario en la misma ruta): guarda una **firma** por archivo en
> `vir_ppp_auto` (`{name,meta,hash,ts}`) — `meta`=lastModified+size, `hash`=SHA-256 del
> contenido; si la `meta` no cambió, o el `hash` es igual a lo último importado, **NO**
> re-importa (evita duplicar). Si cambió, llama al mismo `pppHandleFile` (que ya dedupea
> por NP y conserva las ediciones de tanda). Funciones: `fshOpen/Get/Set/Del`,
> `pppAutoPick/Check/CheckAll/Start/Stop/Forget/Reconnect/RenderStatus`, `_sha256Hex`,
> `_fshPerm`; `pppHandleFile` ahora acepta `(tipo,f,buf,quiet)`. UI en `#pppAutoBox`
> dentro del menú de import. Sigue SOLO LOCAL.
>
> Nota: **v3.40** — **PPP: sugerir agregar un pedido de "A Programar" a una tanda YA
> en Programación del mismo cliente** (pedido del usuario). En el tab 📥 A Programar,
> arriba, aparece un cuadro 🔗 (`.ppp-match-box`) con cada **cliente que ya tiene tanda
> en Programación** y sus pedidos sueltos; el botón **"→ Agregar a Tanda CXX · 📅 fecha"**
> (`pppAddToProgrammedTanda`) los mete en esa tanda (setea `tanda` + `fecha_entrega` +
> `programmed` en los edits) **aunque pase el m³/tanda objetivo (0,8)** → los pedidos de
> un mismo cliente quedan juntos. Match por **cód cliente** (`_pppCliKey`; si no hay cód,
> razón social); si el cliente tiene varias tandas programadas toma la de **fecha de
> entrega más temprana**. Excluye súper (van por su propia vía). Cálculo + banner en
> `pppRenderProg` (tab A Programar). Sólo toca edits locales (`vir_ppp_edits`) → SOLO LOCAL.
>
> Nota: **v3.39** — **CR: la tabla va como lista plana** (pedido del usuario): se
> sacó la fila separadora **"TANDA …"** (y su CSS `.cr-tanda-row`). `crRender` ahora
> itera `_cr.items` directo, sin agrupar. El orden de `showControlRemitos` se mantiene
> (**vencidos primero, luego por tanda y NP**) → las NP de una misma tanda quedan
> juntas igual, sin encabezado. Columnas intactas: NP · Cod Cliente · Razón Social ·
> Líos · Controlado.
>
> Nota: **v3.38** — **Control Remitos (CR): la lista pasó a TABLA con columnas
> fijas** (pedido del usuario). El popup `crRender` ahora arma una tabla con
> encabezados **NP · Cod Cliente · Razón Social · Líos · Controlado** (antes era
> una lista de tarjetas agrupadas y el tilde se rotulaba "Recibido"). La última
> columna **Controlado** es el tic que marca el operario; el flujo no cambió:
> tildar → «Terminé» emite **CRN** por NP y pasa el pedido a Pedidos Entregados.
> Se mantiene el agrupado por tanda como **fila separadora** (no es columna) y el
> resaltado de **VENCIDO** (fila roja + chip "VENCIDO" en Razón Social; el
> "temblando" por `translateX` se reemplazó por un **pulso de fondo**
> `cr-rowpulse`, más robusto en `<tr>`). Sólo cambia la presentación: datos,
> eventos (`CRN`/`CR`) y persistencia (`vir_cr_checked_<legajo>_<día>`) intactos.
>
> Nota: **v3.37** — **Alarma + aviso Telegram de "cargado sin controlar y vencido"** (Parte 4, cierra
> el ciclo de CR). En la PPP de la operadora, un pedido **cargado al camión (CCN) pero NO controlado**
> (ni CRN ni manual) que **pasó el plazo** (`crVencido`: 30 hs; viernes→lunes 12 hs) se marca **en rojo
> grande y temblando**: la tanda (`.ppp-cargvenc` + badge "🚨 SIN CONTROLAR" parpadeante en la franja)
> y la fila del pedido (`.ppp-cargvenc-row`, celda "🚨 SIN CONTROLAR" en lugar de "Entregado"). Lógica:
> `pppRefreshEntregado` ahora trae también `ts_cliente` y arma `_pppLoadMs` (NP→ms de la 1ª carga);
> helper `_pppCargaVencida(p)`. **Telegram**: `pppCheckCargaVencida()` emite **un evento `CRA`** por NP
> vencida (`texto="NP|TANDA|RAZÓN"`, client_id `cra_<np>_<día>` + upsert) y el trigger Supabase
> **`trg_carga_sin_control_telegram`** (función `notificar_carga_sin_control_telegram`, **AFTER INSERT**,
> mismo bot/chat `@Faltantes_Virgilio_bot` que faltantes/planimetría, vía `net.http_post`) lo reenvía.
> Como el trigger es **AFTER INSERT** y el id es determinístico+upsert, **avisa 1 sola vez por NP/día**
> (re-emisiones son UPDATE → no re-disparan). El chequeo corre al abrir la PPP y en cada cambio de
> pestaña (`pppRefreshControlado`/`pppRefreshEntregado`); exige tener cargados CCN **y** CRN para no dar
> falsos positivos. El evento `CRA` usa legajo `0` (test/basura, excluido de reportes).
>
> Nota: **v3.36** — **Control Remitos (CR)** para el operario (cierre del ciclo de entrega).
> El botón **CR** de la botonera (ya existía como toggle, label "Control Remitos") abre un popup
> (`showControlRemitos`, reusa `#tandaModal`) con la **lista de NP que YA se cargaron al camión**
> (eventos **CCN**), mostrando **NP · Cod Cliente · Razón Social · Líos · Controlado (tic)** (tabla desde v3.38). Cód y
> Razón salen del PPP del día (`fetchMonitorSheet`); **Líos** de los eventos **TAL** (anotados al
> terminar armado, ver v3.34); el tilde "Recibido" lo marca el operario. Al tocar **«Terminé»**:
> (1) manda un evento **CRN** (`texto="NP|TANDA"`, client_id determinístico `crn_<legajo>_<np>_<día>`,
> upsert) por cada NP tildada, y (2) **cierra el toggle CR** (evento `CR`). Persistencia del
> tildado en `vir_cr_checked_<legajo>_<día>`; **Wake Lock** para que no se salga si se bloquea el
> cel; re-tocar CR re-abre el popup (no cierra). **Integración PPP**: `pppRefreshControlado` lee los
> **CRN** y los **mergea al set de controlados** (`vir_ppp_entregados`) → esos pedidos salen de
> Programación y pasan a **Pedidos Entregados**, **coexistiendo** con el "✓ Controlado" manual de la
> operadora (los dos caminos valen). **Plazo de control / alarma VENCIDO**: desde que se cargó (CCN)
> hay **30 hs** para controlar; si el vencimiento cae **sábado/domingo (incluye las cargas del
> viernes)** se corre al **lunes 12:00** (`crDeadline`/`crVencido`, AR=UTC-3). Los NP vencidos van
> **arriba, en rojo y temblando** (`.cr-venc`) dentro del popup. (La alarma en la vista de la operadora
> + aviso Telegram se agregó en **v3.37**.)
>
> Nota: **v3.33–v3.35** — Ciclo de entrega del **operario** (previo a CR). **v3.33/34 (Líos)**: al
> mandar **TAP** (terminé armado) se abre un popup que **obliga** a anotar cuántos **líos** lleva
> cada NP de la tanda (`showLiosModal`; si no lleva, poné **0**; no se puede dejar vacío ni salir sin
> completar). Cada NP → evento **TAL** (`texto="NP|LÍOS|TANDA"`). **v3.35 (Carga Camión)**: al iniciar
> **CC** se abre un checklist con **las NP facturadas pendientes** (las ya FC por admin,
> `fetchFacturadosHoy`) agrupadas por tanda; el operario tilda lo que cargó (Wake Lock activo). El
> botón **"🚛 Terminé Carga Camión"** manda **CCN** (`texto="NP|TANDA"`) por cada NP tildada y
> **cierra** el toggle CC. Re-tocar CC re-abre el checklist; "Cerrar (sigo después)" minimiza.
>
> Nota: **v3.32** — PPP: **editor de clientes súper**. Botón **🛒 Clientes súper** en la PPP →
> overlay `#pppSupersOverlay` para **agregar (cód + nombre) / borrar**; persiste en
> `vir_ppp_supers` (`openPppSupers`/`pppSuperAdd`/`pppSuperDel`/`pppSupersRender`) y re-renderiza
> la PPP. La detección de súper sigue siendo: lista de clientes (por cód) + Tipo KRIKOS +
> barrio/zona Súper.
>
> Nota: **v3.31** — PPP: en Programación, dentro de **cada día** las tandas se **ordenan por
> camión (color)** y no por número: Sur/Oeste · Norte · Centro · Súper · Retira (y dentro de
> cada camión, por tanda). Así lo que va junto queda junto aunque el N° de tanda no sea
> consecutivo (`_pppCamKey` en el sort del tab Programación).
>
> Nota: **v3.30** — PPP: **botonera de tanda en 2 modos separados** (pedido del usuario, antes
> se mezclaba). La franja tiene **✓ Controlar** (verde) y **✏️ Editar** (ámbar); cada botón abre
> SU modo, excluyente (`pppSetMode` con `_pppMode` por id, persiste entre renders). En **modo
> Controlar** se ve solo lo de tildar entregas ("✓ Controlar TODA la tanda" + "✓ Controlado"
> por fila `.ppp-ctrl-only`; inputs bloqueados). En **modo Editar** solo lo de corregir (panel
> de fecha + "↩ toda la tanda" + "↩" por fila `.ppp-edit-only`; inputs Tanda/Fecha editables).
> Borde izq. verde/ámbar según el modo. (v3.29: badge VENCIDA en blanco bold legible.)
>
> Nota: **v3.28** — PPP: **editar tanda (✏️ lápiz)** en Programación. El botón ✏️ abre la
> tanda en **modo edición** (`pppEditTanda`, clase `.ppp-edit-mode`) y muestra un panel:
> **(1) cambiar la Fecha de Entrega de toda la tanda** (date input → `pppTandaFecha`, aplica
> a todos los NP de la tanda); **(2) mover** un pedido a otra tanda = cambiar su **Tanda** en
> la fila (input ya existente, sigue programado); **(3) devolver a "A Programar"**: botón ↩
> por fila (`pppPedidoAProgramar`) y botón "↩ toda la tanda" (`pppTandaAProgramar`) que le
> sacan tanda+fecha+programación. Helper `_pppTandaNps`.
>
> Nota: **v3.27** — PPP: **alarma de tanda VENCIDA**. Si una tanda programada tiene Fecha de
> Entrega **en el pasado** y sigue en Programación (no entregada), la franja se pone **roja,
> con badge "⏰ ¡VENCIDA!" y una sacudida (shake) periódica** para que la operadora la
> reprograme. Clase `.ppp-vencida` (chequea `_pppFechaDate(fe) < hoy` en `_pppBlock`),
> animación `pppShake`.
>
> Nota: **v3.26** — PPP: **franja de tanda rediseñada**. (a) La **Fecha de Entrega quedó en
> columna propia alineada** (franja en CSS grid: caret · nombre · resumen · fecha · meta). (b)
> **Color por camión/ruta** (`_pppRuta` + clases `rt-so/rt-n/rt-c/rt-ret` en `.ppp-tanda-h`):
> Sur/Oeste azul · Norte teal · Centro violeta · Retira gris · Súper ámbar; legend arriba de
> Programación. (c) El botón **"✓ Controlar" ahora ABRE la tanda** (`pppAbrirControlar` vía
> placeholder `__BLOCKID__`) para tildar **pedido por pedido** (cada fila tiene su "✓
> Controlado"). (d) **El estado abierto/cerrado de cada tanda PERSISTE** entre renders
> (`_pppOpen` por clave estable `_pppKid`), así controlar un pedido no cierra la tanda.
> (e) En la franja, los **N° Pedido consecutivos se colapsan en rango** `inicio/sufijo`
> (`_pppNpFmt`): 97757…97763 → **97757/63**; los no consecutivos quedan sueltos.
>
> Nota: **v3.25** — PPP: **(a) tandas colapsables (acordeón)**. Cada bloque arranca
> **cerrado**; la franja azul muestra los datos clave (**Razón Social · N° Pedido · 📅 Fecha
> de Entrega**) y al **tocarla se expande** el detalle (`_pppBlock` con id + `pppToggleBlock`,
> caret ▸/▾, `.ppp-tanda .ppp-tablewrap{display:none}`). Los botones del header llevan
> `event.stopPropagation()` para no abrir/cerrar al clickearlos. **(b) Ciclo Entregado →
> Controlado**: la columna **"Entregado"** se nutre sola del evento **CCN** (carga de camión
> por NP que marcan los operarios) — `pppRefreshEntregado`/`_pppEntregadoCC`, lectura de
> Supabase. El botón manual ahora es **"✓ Controlado"** (lo marca la operadora,
> `pppControlar`/`pppControlarTanda`): **recién al Controlar** el pedido pasa a **"Pedidos
> Entregados"** (tab renombrado). "Listo FC" sigue del evento TAP. Todo lectura, sigue SOLO LOCAL.
>
> Nota: **v3.24** — PPP: **3 retoques de UI**. (a) Los dos botones gigantes de importar se
> reemplazaron por **un botón mínimo "⬆ Importar Excel ▾"** que abre un **popup**
> (`pppToggleImport`/`pppCloseImport`, `#pppImportMenu`) con las dos opciones (Formato PPP /
> Base Pedidos) y el dato de última importación de Base Pedidos adentro. (b) Se **sacó la
> barra "🔄 Estado operarios (Listo FC)"** de Programación (el Listo FC se refresca solo al
> entrar al tab). (c) **Resumen rediseñado como TABLA compacta** estilo Excel (`Resumen
> Prog`): una fila por día de entrega, columnas Z1..Z7 / Retira / Súper / Total / Camiones /
> Demora, fila TOTAL, con tinte de color por zona — **entra todo en una sola hoja**
> (`pppResumenHtml`, `.ppp-restbl`).
>
> Nota: **v3.23** — PPP: **dedupe por N° Pedido** en `pppRenderProg` (codeado, automático en
> cada render): un NP aparece **una sola vez** y cae en una única solapa según su estado por
> NP (Entregado > Programado > A Programar). Si un pedido ya está programado o entregado, **no
> se vuelve a mostrar en "A Programar"** aunque venga repetido en los datos (p. ej. al
> reimportar el Formato PPP del día con pedidos ya programados).
>
> Nota: **v3.22** — PPP: **estado actual PRECARGADO** (semilla). El estado de la PPP del
> Excel `AAA_PPP_Vigente` quedó **embebido** en `PPP_SEED` (123 pedidos · 83 programados en
> 7 días · 8 súper). `pppSeedIfNeeded()` (llamado en `openPPP`) lo carga **una sola vez** en
> `localStorage` (`vir_ppp_pedidos` + `vir_ppp_edits`), marcado con `vir_ppp_seeded_v1`. Así
> al abrir la PPP ya está todo cargado **sin importar nada**. Temporal hasta Supabase (para
> re-sembrar: borrar la clave `vir_ppp_seeded_v1`). La migración por archivo (v3.21) sigue
> disponible.
>
> Nota: **v3.21** — PPP: **migración del estado actual desde el Excel**. Si en "Importar
> Formato PPP" se sube el Excel de la PPP completo (hoja **"Programacion Diaria"**, 15 cols
> por posición con secciones), se **autodetecta** (`pppEsPPPCompleta`) y se carga TODO
> (`pppLoadProgCompleta`/`pppImportarCompleta`): lo de la sección **Programación** con tanda
> → **ya programado** con su fecha de entrega; **súper** → por su fecha; el resto → **A
> Programar**. Verificado con `AAA_PPP_Vigente`: **123 pedidos** (75 programados en 7 días
> de entrega, 8 súper, 39 a programar). Lee la hoja "Programacion Diaria" aunque no sea la
> primera. El Formato PPP simple (export del día) se sigue detectando y acumulando como antes.
>
> Nota: **v3.20** — PPP: el encabezado de cada tanda ahora **alinea a la izquierda** (m³ +
> botón OK/Entregada a la altura de la columna Fecha, `min-width` en `.ppp-tanda-name` +
> `flex-wrap`) para que el botón **no quede cortado** a la derecha en pantallas anchas.
>
> Nota: **v3.19** — PPP: **OK por tanda**. Cada tanda armada (y cada súper) en 📥 A Programar
> tiene un botón **✓ OK → Programar** que la **saca de A Programar** y la pasa a 🗓️
> Programación. La **Fecha de Entrega se elige automática**: `_pppScheduleTandas` la mete en
> el **día más temprano con lugar** según los **m³ ya programados ese día** y el tope **6
> m³/día** (`dayCap`); una tanda gigante (> día) se lleva un día vacío. Los **súper van por
> su fecha preestablecida** (no usan el cupo). `pppOkTanda`/`pppOkSuper` comparten el
> scheduler con **✅ Confirmar todas** (`pppConfirmarProgramar`, hace todas por prioridad de
> fecha de recepción). Reversible con "borrar tandas".
>
> Nota: **v3.18** — PPP: el **m³/tanda (0,8) es un objetivo modificable, no un tope duro**.
> Se sacó el cartel "⚠ > 0,8 m³" de las tandas grandes: pasarse es normal (un cliente con
> varios NP queda junto aunque supere 0,8) y se programan igual. La capacidad se edita en
> la barra; nada bloquea tandas > objetivo.
>
> Nota: **v3.17** — PPP: el botón **"Entregado" ya NO aparece en 📥 A Programar** (el pedido
> todavía no está programado); va **solo en 🗓️ Programación** (y "↺ Deshacer" en Entregados).
>
> Nota: **v3.16** — PPP: **ciclo de vida del pedido**. (a) Columna **"Listo FC"** en
> Programación: se **tilda sola** cuando el operario termina el armado de la tanda (evento
> **`TAP`**) — se lee de Supabase con `getActivityStatus().armadoDone` (`_pppArmadoDone`,
> `_pppListoFC`, `pppRefreshArmado`; es solo lectura, no rompe el "solo local"). Botón "🔄
> Estado operarios" + auto al abrir/entrar a Programación. (b) **Entregado → Entregados**:
> botón por pedido **y por tanda** (`✓ Entregada`, `pppEntregarTanda`); **persistido** en
> `vir_ppp_entregados` (sobrevive recarga). Flujo completo: descarga → 📥 A Programar →
> armar+confirmar → 🗓️ Programación (Listo FC al armar) → Marianela marca Entregado → ✅
> Entregados.
>
> Nota: **v3.15** — PPP: las **entregas son sólo Lun–Vie** (no Sáb/Dom). `_pppDeliveryDate`
> ahora saltea sábado **y** domingo al asignar las fechas de entrega automáticas.
>
> Nota: **v3.14** — PPP: **flujo en 2 etapas** (refinado por el usuario). (a) **Todo lo
> importado cae en la solapa 📥 "A Programar"** (no programado). (b) Ahí se **arman tandas**
> (`🪄 Sugerir tandas`) con tope **m³/tanda = 0,8** (`tandaCap`, antes 6 era mal); los súper
> quedan exentos (van solos por su fecha de entrega). (c) **`✅ Confirmar y programar`**
> (`pppConfirmarProgramar`) pasa las tandas a **🗓️ "Programación"** asignándoles **Fecha de
> Entrega automática**: empaca las tandas en días de entrega a **m³/día = 6** (`dayCap`,
> máximo por día), priorizando fecha de recepción vieja; fecha base = próximo día,
> **saltea domingos** (`_pppDeliveryDate`). Los súper se programan por SU fecha (no usan el
> cupo de 6). Estado nuevo `programmed` en `vir_ppp_edits`. Solapas: 📥 A Programar · 🗓️
> Programación (por fecha de entrega → tanda) · 🚚 Resumen (usa programados) · ✅ Entregados.
> `borrar tandas` resetea tanda+programación. Config en `vir_ppp_cfg` {tandaCap,dayCap,baseN}.
>
> Nota: **v3.13** — PPP Fase 3: **tab 🚚 Resumen de camiones** (réplica de `Resumen Prog`).
> Agrupa los pedidos **por Fecha de Entrega**; suma m³ **por zona** (los súper cuentan en
> "Súper", no en su zona geográfica); arma camiones por **ruta fija**: Sur/Oeste=Z1+Z3+Z4 ·
> Norte=Z5+Z6+Z7 · Centro=Z2 · Súper (uno por cliente) · Retira (sin camión). Cada ruta a
> **6 m³/día** → `ceil(m³/cap)` camiones. Muestra m³ por zona (chips), desglose de camiones
> y **demora promedio** (Fecha Entrega − Fecha Recep) por día + total. `pppResumenHtml`,
> `_pppFechaDate`. **Verificado**: el mapeo de zona coincide con el Excel en 104/104 filas y
> los totales por zona dan idénticos al `Resumen Prog`. SOLO LOCAL.
>
> Nota: **v3.12** — PPP Fase 2: **botón "Sugerir tandas"** (armado automático asistido).
> Barra con **m³/tanda** (capacidad, default **6**) y **N° base** (default 60), persistidos
> en `vir_ppp_cfg`. `pppSugerirTandas`: dentro de cada **zona** ordena por **fecha de
> recepción** (más vieja primero) y empaca por **cliente** (los pedidos de un mismo cód van
> juntos) hasta llegar a la capacidad; al pasarse abre otra tanda; un cliente que solo ya
> supera la cap queda en su tanda. **Súper** = una tanda por cliente. **No pisa** tandas ya
> puestas a mano ni programa pedidos **sin zona** (primero asignarles el barrio). Códigos
> `C<base><A,B,C…>`. Escribe como edits (editable/reversible); "borrar tandas" limpia todas.
> Capacidad real del negocio: **6 m³ por camión/día**.
>
> Nota: **v3.11** — PPP Fase 1 completa: **acumulación + 3 secciones + detección de súper**.
> **Acumulación**: importar el Formato PPP ya NO reemplaza — los pedidos del día **se suman**
> a los existentes (dedupe por N° NP; si el NP repite, actualiza sus datos del Excel y
> conserva los edits de tanda/fecha). Persistido en `localStorage` `vir_ppp_pedidos`
> (`pppMergePedidos`/`pppLoadPedidosStore`); `openPPP` lo recarga al abrir. Status: "X
> nuevos · Y actualizados · Z total". **3 secciones** (réplica del Excel): 🛒 **Súper**
> (cada cliente súper su propia tanda), 📋 **Pedidos a Programar** (sin tanda, agrupados por
> **Zona** y ordenados por **fecha de recepción** más vieja primero), ✅ **Programados**
> (con tanda, agrupados por tanda con total m³). Asignar la Tanda mueve el pedido de "a
> Programar" a "Programados" en vivo. **Súper** = (1) lista de clientes editable
> `vir_ppp_supers` sembrada con los 4 actuales (Coto/Dorinka/Matiz/S.A.Imp Exp Patagonia),
> (2) Tipo=KRIKOS si el Excel lo trae, (3) Zona=Super del barrio (`pppEsSuper`). SOLO LOCAL.
>
> Nota: **v3.10** — PPP: **Zona automática desde el Barrio** (réplica de la lógica del
> Excel real `AAA_PPP_Vigente`). La Zona NO se escribe: sale del barrio de entrega
> buscado en la tabla `Resumen Prog`!AC:AD del Excel (**84 barrios → 10 zonas**: Z1 CABA
> Sur, Z2 CABA Centro, Z3 CABA Oeste, Z4 GBA Sur, Z5 GBA Oeste, Z6 GBA Norte, Z7 GBA
> Norte Lejos, Super, Retira, Expo). Tabla embebida en `PPP_BARRIO_ZONA`; match
> normalizado (sin acentos/mayúsc/paréntesis) en `pppNormBarrio`/`pppZonaDeBarrio`. La
> Zona se muestra como **chip de color** por zona; barrios fuera de tabla muestran un
> selector "⚠ asignar" y se **recuerdan** por barrio (`vir_ppp_zona_ovr`), extendiendo
> la tabla como en el Excel. **Auditoría del Excel real** (para fases siguientes): hoja
> `Programacion Diaria` = 1 fila/pedido en secciones apiladas (Problemas / Súper a
> Programar / a Programar / Programación con `Total CXX:`); súper = Tipo KRIKOS, un
> camión por súper; camiones por ruta fija Z1+Z3+Z4 / Z5+Z6+Z7 / Z2 solo / Retira /
> Súpers; `Resumen Prog` agrupa por Fecha Entrega+Zona y calcula demora promedio. SOLO LOCAL.
>
> Nota: **v3.09** — PPP: **Tanda y Fecha Entrega editables a mano** (no vienen del Excel).
> Cada fila tiene un input para **Tanda** (primera columna) y otro para **Fecha Entrega**.
> Lo tipeado se guarda en `localStorage` `vir_ppp_edits` **por N° Pedido** (sobrevive
> recarga y reimportación del mismo Excel; SOLO LOCAL) y se mergea al render
> (`pppLoadEdits`/`pppSaveEdits`/`pppSetEdit`). Al escribir una Tanda, el pedido se
> reagrupa en vivo (re-render). Los pedidos **sin tanda** quedan en el grupo
> **"Sin tanda asignada"** que aparece **primero** (tarjeta ámbar) para cargarlos cómodo;
> el resto de las tandas, A→Z. Fecha Entrega no reagrupa (solo guarda). Sigue SOLO LOCAL.
>
> Nota: **v3.08** — PPP: **detección por PATRÓN de datos** (reescritura de
> `pppDetectProgCols`). El Excel "Formato PPP" trae el **encabezado disperso** (celdas
> vacías/combinadas) que NO alinea con las filas de datos → la detección por nombre de
> columna agarraba columnas vacías (Cód/Razón/m³ salían en blanco). Ahora se detecta por
> el **patrón del dato**: N° Pedido = 5 dígitos, Cód = 4 dígitos, m³ = decimal, Fecha =
> fechas; y para los textos (Razón Social / Localidad) se **realinea** el encabezado
> (k-ésimo header no vacío ↔ k-ésima columna con datos) y se usa el nombre lógico. Esto
> sigue la posición REAL del dato, sin importar columnas vacías intercaladas. Además el
> **diagnóstico 🔧** ahora vuelca **columna por columna** (letra + encabezado + 2 ejemplos)
> para ver la "verdad" del Excel. Tanda/Fecha Entrega/Zona pueden seguir vacías. SOLO LOCAL.
>
> Nota: **v3.07** — PPP: **fix de keywords** en `pppDetectProgCols` para que peguen con
> los encabezados REALES del Excel "Formato PPP" que usa el usuario:
> `pedido | fecha | codigo | cliente | mts 3 | vendedor | dir. entrega | loc. entrega |
> prov. entrega`. Mapeo: **Cód Cli ← codigo**, **N° Pedido ← pedido**, **Fecha ← fecha**,
> **Razón Social ← cliente**, **m³ ← mts 3**, **Localidad Entrega ← loc. entrega**.
> ⚠ **Ese Excel NO trae Tanda, Fecha Entrega ni Zona** (son campos que hoy completa la
> planificación; el usuario dijo que Zona/Fecha Entrega "se rellenan después"). Por eso la
> "unificación por tanda" todavía no puede salir de este archivo — **falta definir de dónde
> sale la Tanda** (asignar en la PPP / otro Excel / cruce por NP). Mientras tanto, si ningún
> pedido tiene tanda, el grupo se rotula **"Sin tanda asignada"** (antes "Tanda —"). Sigue
> SOLO LOCAL.
>
> Nota: **v3.06** — PPP: la detección de columnas no levantaba varios campos. Ahora
> `pppDetectProgCols` elige la fila de encabezado **por puntaje** (la que más keywords
> tiene) y se agregó un **diagnóstico desplegable** en la vista (`.ppp-diag`,
> `_pppLastDetect`) que muestra qué columna detectó cada campo + los **encabezados
> reales** del Excel, para ajustar las palabras clave si algo cae en "✗ FALTA".
>
> Nota: **v3.05** — **PPP: formato fijo (sin panel de mapeo)**. Por pedido del usuario
> se sacó el panel de elegir columnas. Ahora el **Formato PPP** detecta las columnas
> **por el NOMBRE del encabezado** (`pppDetectProgCols`: tanda/cod cli/pedido/fecha/
> razón/m3/localidad/fecha entrega/zona) y arma la vista agrupada por tanda con esas
> 9 columnas (m³ a **2 decimales**; fechas formateadas DD/MM/YYYY, `cellDates`+`_pppFecha`).
> **Base Pedidos** ya NO muestra tabla: solo la **fecha/hora de la última importación**
> (`#pppBaseInfo`/`pppShowBaseInfo`, persistida en `localStorage` `vir_ppp_base_ts`).
> Sigue SOLO LOCAL. (El panel de mapeo y `_pppGuessMap` quedaron dormidos.)
>
> Nota: **v3.04** — PPP: el auto-guess del mapeo ahora también detecta **Tanda**
> (texto corto alfanumérico tipo C41A), **Zona** (valores con "zona") y **Localidad**
> (siguiente columna de texto) — antes quedaban en "ninguna" y salían vacías.
> `_pppGuessMap` usa un set de columnas ya usadas (cada col se asigna una vez).
> Además `pppShowMapping` respeta el mapeo guardado solo si la columna es válida
> (`>=0`); si un campo quedó sin mapear, cae al auto-guess mejorado.
>
> Nota: **v3.03** — dos cosas. **(a) PPP: drag-drop** — además del click, podés
> **arrastrar el `.xls` encima** de cada botón de importar (`pppHandleFile` compartido
> por click y drop; `pppDragOver`/`pppDrop`; highlight `.ppp-drag`). **(b) #4 parte 2:
> editor de Talleristas de Recepción** — botón "👷 Talleristas de Recepción" (panel
> Admin) → overlay que lee `Codigos X Tallerista` (id, Nombre, Linea LK/CH, Codigo),
> agrupa por Nombre y muestra el código LK/CH editable + agregar/borrar. Escribe con
> el JWT del supervisor (la RLS de esa tabla ya permite INSERT/UPDATE/DELETE a
> authenticated → no hace falta SQL). `tallLoad`/`tallRender`/`tallSaveCod`/`tallAdd`/
> `tallDelete`. Con esto, #4 (Mails + Talleristas) queda completo.
>
> Nota: **v3.02** — **PPP: mapeo de columnas configurable** (fix del import). El
> "Formato PPP" tiene su propio layout (NO el de Programacion Diaria): el NP es de 5
> dígitos y antes se tomaba mal el cód. cliente como NP. Ahora al Importar Formato PPP
> aparece un panel para **elegir qué columna es cada campo** (NP/Tanda/Cliente/Cód/m³/
> Zona/Localidad), con **auto-guess por patrón** (`_pppGuessMap`: 5díg→NP, 4díg→cód,
> decimal→m³, texto largo→cliente) y se **guarda en localStorage** (`PPP_MAP_KEY`).
> `pppApplyMapping` arma los pedidos y `pppRenderProg` agrupa por la Tanda elegida.
> Sigue SOLO LOCAL. Pendiente del usuario: pulir estética si hace falta.
>
> Nota: **v3.01** — **#4 (parte 1): editor de Mails autorizados (supervisores)**.
> Botón "✉️ Mails autorizados" (panel Admin) → overlay para agregar/borrar mails de
> supervisor. Tabla Supabase `Supervisores_Virgilio` (email) que se **mergea sobre los
> 3 fijos** de `SUPERVISOR_EMAILS` (los fijos no se borran → no hay lockout).
> `loadSupervisoresRemotos` la baja (anon) y `isSupervisorEmail` chequea fijos + remotos;
> `showLoggedIn` la espera antes del check. Escribe con el JWT del supervisor
> (`mailsAdd`/`mailsDelete`). ⚠ Requiere crear la tabla + RLS (SQL por chat). Falta la
> parte 2 de #4: editor de **Talleristas de Recepción** (tabla `Codigos X Tallerista`).
>
> Nota: **v3.00** — **PPP Fase 2 (vista, SOLO LOCAL)**. Por pedido del usuario, el PPP
> ahora **no escribe nada en Supabase** (banner "EN PRUEBAS — SOLO LOCAL"; `pppSubir`
> queda dormido). Al **Importar Formato PPP** se renderiza la **Programación** linda
> (`pppRenderProg`): agrupada **por tanda** (card azul con N pedidos + m³), tabla
> NP·Cliente·Cód·m³·Zona·Entrega, y botón **"✓ Entregado"** por pedido que lo mueve a
> la pestaña **"Entregados"** (estado local en memoria, `_pppEntregados`/`pppEntregar`/
> `pppDeshacer`/`pppTab`). **Importar Base Pedidos** muestra solo un vistazo
> (`pppRenderBase`, es data para el picking). Falta (cuando guste el formato): conectar
> a Supabase (subir + Entregado→`PPP_Pedidos_Entregados`) y el vínculo con Facturación.
>
> Nota: **v2.99** — **#1 Carga Recepción: "Carga Manual" auto-navega al form**. Como no
> hay deep-link (repo privado), al elegir "Carga Manual" se carga la app y, por ser
> **mismo origen**, `recpAutoNav` busca dentro del iframe un botón/link hacia "Recepción
> de Mercadería" (keywords) y lo clickea (reintenta ~5,5s; fallback al home). `recpOpen`
> fuerza recarga (about:blank→url) y, si algún día se setea `RECEPCION_CARGA_URL` con un
> deep-link real, lo abre directo sin heurística. ⚠ **Heurístico sin probar** (no tengo
> acceso a esa app); si no acierta el botón, hace falta el deep-link o el texto exacto
> del botón del home.
>
> Nota: **v2.98** — **integrado el flujo de LOGIN GLOBAL + selector de planta in-app +
> rebrand a "Producción"** (del branch `claude/login-global-flow`, otra sesión).
> Ahora: login (Google/legajo) → **`#plantSelector`** (Virgilio / Cervantes, sesión
> compartida, no re-pide login) → `chooseVirgilio()` → `_renderIdentity()` →
> `showSupervisor`/`showOperario` (mis pantallas). Funciones: `showSelector`,
> `_routeAfterAuth`, `_renderIdentity`, `chooseVirgilio/Cervantes`, `cambiarPlanta`,
> botón `#btnCambiarPlanta`. Cervantes (`cervGate`) levanta la sesión compartida y
> redirige a la raíz si no hay. Rebrand: íconos/manifest/twa. ⚠ Mi **`/selector/`
> standalone (v2.82) quedó REDUNDANTE** (ahora el selector es in-app); no se borró —
> queda como página huérfana, se puede limpiar después. Se integró sobre mi v2.97
> (cherry-pick limpio: las zonas no se solapaban; mis features v2.9x intactas).
>
> Nota: **v2.97** — **PPP Fase 1: importador de Excel → Supabase**. Los botones del
> módulo PPP ahora **leen el `.xls`/`.xlsx`** (SheetJS lazy desde CDN —
> `pppLoadXlsx`—, el navegador del supervisor lo baja), **mapean columnas IGUAL que el
> Apps Script** (`pppMapBase`: Pedido=A/Art=C/Cajas=F → `PPP_Base_Pedidos`; `pppMapProg`:
> por posición, fila=pedido si col C tiene NP → `PPP_Programacion_Diaria`), muestran
> **preview** (5 filas) y al confirmar hacen **reemplazo total** (DELETE+INSERT por
> lotes de 1000) con el **JWT del supervisor** (`facAuthWriteHeaders`/`pppSubir`).
> ⚠ Requiere **1 SQL una vez**: policies RLS de escritura para los mails de supervisor
> en `PPP_Base_Pedidos` y `PPP_Programacion_Diaria` (hoy solo escribe el service_role).
> Falta **Fase 2**: generar la vista PPP (Programación) linda + botones "Entregado" que
> muevan el pedido a `PPP_Pedidos_Entregados`, vinculado a Facturación.
>
> Nota: **v2.96** — **Carga Recepción Mercadería: chooser Pendientes / Carga Manual**.
> Al abrir (`openRecepcionAdmin`) ahora aparece un chooser con dos tarjetas; el iframe
> de `Control-Carga-Remitos-FC` carga recién al elegir (`recpOpen`), con botón **← Volver**
> (`recpShowChooser`). **Pendientes** → home de la app (como antes). **Carga Manual** →
> `RECEPCION_CARGA_URL` ⚠ **TODO**: hoy cae al home; falta el **deep-link real** de la
> pantalla "Recepción de Mercadería" (repo privado + github.io bloqueado en el sandbox →
> el usuario tiene que pasar el `#hash`/`?param` de esa pantalla).
>
> Nota: **v2.95** — tres cosas en el panel Admin. **(a)** Botón **"Recepción (Admin)" →
> "Carga Recepción Mercadería"** (sigue llamando a `openRecepcionAdmin`, iframe de
> `Control-Carga-Remitos-FC`). **(b)** Nuevo botón **"🗓️ PPP"** (`openPPP`/`#pppOverlay`)
> — **scaffolding, NO activado**: dos botones "Importar Base Pedidos" / "Importar Formato
> PPP" inertes (`pppImportar` no toca Supabase). Objetivo: **reemplazar el sync
> Excel→Supabase** de la PPP, subiendo las hojas a `PPP_Base_Pedidos` /
> `PPP_Programacion_Diaria` (reemplazo total). ⚠ El write real necesita una **Edge
> Function con service_role** (la app con key pública SOLO lee esas tablas; ver
> `sql/ppp_supabase.sql`). Pendiente: fuente del archivo + Edge Function. **(c)**
> Pendiente del chooser **Pendientes / Carga Manual** en Carga Recepción — bloqueado: el
> repo `Control-Carga-Remitos-FC` es **privado** y github.io está fuera del allowlist →
> falta el deep-link de cada pantalla.
>
> Nota: **v2.94** — dos cosas. **(a) FIX Inconsistencias mostraba el tablero del Monitor.**
> Como el monitor abre SIEMPRE en modo TV y la regla `#monitorModal.tv #monitorContent`
> (display:flex) le ganaba en especificidad al `.hidden` que pone `setMonitorTab("incons")`,
> el tablero se veía encima de Inconsistencias. Se acotó la regla con `:not(.hidden)`
> → ahora al cambiar de pestaña, `#monitorContent` se oculta y se ve `#inconsContent`
> (que ya tenía estilos TV). **(b) Editor de Planimetría más ordenado**: título de sección
> "Buscar y editar ubicaciones" + **fila de encabezados** (Código · Sector · Orden ·
> Acciones) alineada con las columnas de cada fila (`.planim-list-head`/`.plh-*`,
> `planimRender` prepende el header; inputs con `.planim-row-sec`/`.planim-row-ord`).
>
> Nota: **v2.93** — **panel Administración en grilla tipo teclado**. Los botones grandes
> (`.sup-actions`/`.sup-action-btn`) pasaron de una columna a **grid de 3 columnas**
> (ícono arriba + texto centrado, tarjetas), que usa el ancho de la pantalla; en celular
> (≤560px) baja a **2 columnas**. Solo CSS.
>
> Nota: **v2.92** — **Facturación: se reubicó el botón "Cerrar"**. Estaba como barra
> roja a todo el ancho en el medio del header (heredaba el `button{width:100%}` global,
> igual que pasaba en Faltantes). Ahora es un botón **compacto arriba a la derecha**
> (`.fac-close-btn` con `width:auto; margin-left:auto`, sacado de `.fac-stats` y puesto
> como hijo directo de `.fac-top`). De paso, `↺ Revertir` también quedó compacto (no
> más barra). Solo CSS/markup.
>
> Nota: **v2.91** — el fallback del picking (v2.90) ahora también cubre el **monitor**
> (faltantes / quién pidió / aviso Marianela). Helper `faltEnsureBase(enr, tandas)`:
> si a los NP de las tandas mostradas les faltan filas en la base (mirror de Supabase
> atrasado), trae la base de Google Sheets y **mergea** los NP faltantes en
> `enr.pickBase` (mismo objeto que cachea el picking → sana ambos). Enganchado en
> `refreshFaltantes` y `showMarianelaAviso`. No hace nada si la fuente ya es Sheets.
>
> Nota: **v2.90** — **fix picking vacío por mirror de Supabase atrasado**. Si una tanda
> tiene NP que **todavía no están en `PPP_Base_Pedidos`** (Supabase), el picking
> mostraba "No encontré artículos… sin filas en la base". Ahora `showPickingList`
> detecta los NP sin filas y **reintenta con la base de Google Sheets** (siempre al
> día) — `aggFrom`/`npsSinFilas` → `fetchPickingBaseFromSheets`, y sana el cache de la
> sesión. El fallback global solo saltaba si la base venía **totalmente vacía**; este
> es por-tanda. Causa de fondo: el sync del Apps Script a Supabase corre más espaciado
> que la actualización del Sheet (los pedidos nuevos tardan en espejarse).
>
> Nota: **v2.89** — **planimetría: ajustes**. Se borraron `030`, `830`, `828`, `029`
> (no vigentes). `255`(G10) y `724`(G15) pasan a orden 75/76 (justo tras G07).
> `548` comparte lugar con `565` (A64). `planimetria.js?v=2.89`.
>
> Nota: **v2.88** — el aviso "preguntá a Marianela" ahora solo aparece cuando hay una
> **decisión de reparto real**. Por cada artículo faltante exige: **pickearon >1 caja**
> (`real>1`), **falta >1 caja** (sino va a un solo cliente) y el artículo lo pidió
> **más de 1 pedido** (se cuenta con `enr`/PPP, `contarPedidos`). Si ningún artículo
> califica, el modal NO se muestra. `faltantesDeTanda` ahora devuelve `esp`/`real`;
> el chip muestra "N pedidos". Sin acceso a la PPP, degrada a los gates de cajas.
>
> Nota: **v2.87** — **aviso "preguntá a Marianela" al armar una tanda con faltantes**.
> Cuando el armador EMPIEZA el separado (`AP`) de un pedido cuya **tanda se pickeó con
> faltantes**, se abre un modal (`#marianelaModal`) que le dice que **le pregunte a
> Marianela** cómo repartir, y le muestra los artículos cortos. El código de `AP` puede
> ser la tanda o el pedido (NP): se prueba como tanda y, si no, se busca la tanda del NP
> en la PPP (`faltGetEnrich`). Detección por los `PKC` con `real<esp` de esa tanda
> (últimos 5 días). Funciones: `showMarianelaAviso`/`faltantesDeTanda`/`closeMarianela`;
> hook en `send()` (rama `AP`). Si no hay faltantes (o sin red) no muestra nada.
>
> Nota: **v2.86** — **Faltantes: estimar quién quedó SIN SERVIR**. En la sub-fila
> "Pidieron" se reparten las cajas que el operario **puso** entre los NP **sirviendo
> primero a los pedidos más grandes**; cada NP queda marcado **"sin servir"** (pedido
> entero sin cubrir, badge rojo), **"faltan N"** (parcial, ámbar) o **"✓ completo"**
> (verde). El reparto descompone exactamente la `falta` por NP. Es un **estimado**
> (no se conoce el reparto real; se aclara con `title` en "Pidieron"). `quienPidio`
> ahora recibe el `puso` y setea `faltaCj`; `whoRow` pinta el estado.
>
> Nota: **v2.85** — **Faltantes: "quién pidió" (NP + Cód cliente)**. Bajo cada
> artículo faltante, una sub-fila lista los **NP** que pidieron ese artículo en la
> tanda, con su **Cód cliente + Razón Social + cajas pedidas** (orden por cajas desc).
> Cruce: `fetchMonitorSheet` (tanda→NPs + `cod`/`razonSocial`) × `fetchPickingBase`
> (NP→artículos+cajas), cacheado 2 min (`faltGetEnrich`). Con la lectura PPP desde
> Supabase (v2.84, `PPP_SOURCE`) **ya no depende de Google** si la fuente es Supabase.
> Matchea el par Nac/Imp (`580E`↔`580`). Funciones: `faltGetEnrich`, `quienPidio`/
> `whoRow` en `refreshFaltantes`.
>
> Nota: **v2.84** — **lectura PPP desde Supabase ACTIVADA** (programación / pedidos
> / m³ migrados de Google Sheets a Supabase). 3 tablas espejan las hojas que lee la
> app — `PPP_Programacion_Diaria`, `PPP_Pedidos_Entregados`, `PPP_Base_Pedidos` (DDL
> en `sql/ppp_supabase.sql`) — para sacar la dependencia de Google y **poder calcular
> m³ por SQL**. `index.html` elige la fuente con el flag **`PPP_SOURCE`** (`"sheets"` /
> `"auto"` con fallback a Sheets / `"supabase"`), hoy en **`"auto"`**:
> `fetchMonitorSheet`, `fetchHistoricSheet` y `fetchPickingBase` quedaron como
> *dispatcher* + `…FromSheets` + `…FromSupabase` (mismo Map; m³ leído **numérico**,
> sin `monitorParseM3`); helper `supaFetchAll` (pagina PostgREST con `Range` +
> `count=exact`). La carga la hace el **Apps Script** (`handleCargaPPPSync_`, el que ya
> escribe las hojas): un hook las **espeja** con **reemplazo total** (DELETE all +
> INSERT) y la `service_role` key del proyecto Virgilio — props
> `SUPABASE_VIRGILIO_URL`/`_SERVICE_KEY` (ver `MIGRACION-SUPABASE-PPP.md` +
> `apps-script/sync-ppp-supabase.gs`). Tablas con `id` autonumérico. Alcance: NO
> incluye `VolumenArticulos` ni la planimetría.
>
> Nota: **v2.83** — **rediseño estético del modal Faltantes** (vista supervisor).
> Antes los chips de fecha y el "Cerrar" salían a todo el ancho (heredaban el
> `button{width:100%}` global). Ahora: header prolijo con "Cerrar" compacto, chips de
> fecha redondeados en fila scrolleable, resumen en 3 tarjetas (tandas / artículos /
> cajas faltantes en ámbar), y cada tanda como card con badge rojo y tabla con
> jerarquía (Falta resaltada en chip, Puso/Pedía atenuados, números tabulares). Solo
> CSS/markup, misma lógica/datos (`.falt-*`, `refreshFaltantes`).
>
> Nota: **v2.82** — **las dos plantas en un repo** (reemplaza al repo `App-Produccion`,
> que se borra). Virgilio queda en la **raíz** (sin cambios), Cervantes se **copia** en
> **`/cervantes/`** (repo fuente `Registro-Produccion-2.0`, commit `d2d6a59`), y el
> **`/selector/`** ("¿Dónde vas a trabajar hoy?") linkea a ambas (`../` y `../cervantes/`).
> Cada app tiene botón **"← Cambiar planta"** → `selector/`. La entrada por defecto
> sigue siendo Virgilio (raíz). ⚠ `/cervantes/` es copia → re-sincronizar si cambia en
> su repo. Detalle en `CLAUDE.md` (sección "Estructura: dos apps en un repo").
>
> Nota: **v2.81** — editor de Planimetría: se **sacó** el botón "subir toda" y se
> agregó un **ayudante de ubicaciones aledañas** (`planimNearby`): al escribir un
> código/sector de referencia, muestra las ubicaciones cercanas **por orden** (4
> antes y 4 después) con su número de orden y sector → para elegir bien el orden de
> la ubicación nueva. Lee de `window.GONDOLA` (estática + lo que ya esté en Supabase).
>
> Nota: **v2.80** — **editor de Planimetría en el panel Admin (a Supabase)**.
> Botón "🗺️ Editar Planimetría" (supervisores) → overlay para agregar/editar/borrar
> códigos (cod, sector, orden) y cargar los pares Nacional/Importado. **Cada cambio
> se escribe DIRECTO a Supabase** (tabla `Planimetria`, upsert con el JWT del
> supervisor), no solo local. La app al arrancar baja `Planimetria` (anon) y la
> **mergea sobre planimetria.js** (`loadPlanimetriaRemote` → `window.GONDOLA`); si
> no hay tabla/red queda la estática. Botón "Subir toda la planimetría actual"
> (`planimSeedAll`). ⚠ Requiere crear la tabla `Planimetria` + RLS (SQL por chat).
> Primera parte del editor self-service (faltan mails y talleristas).
>
> Nota: **v2.79** — **planimetría: se borró `441E`** (código fantasma; solo existe
> `441`→J28, sin par E → sin aviso Nacional/Importado).
>
> Nota: **v2.78** — **planimetría: alta de 13 códigos** sin góndola en la base de
> pedidos (758→Ñ56, 071→C10, 255→G10, 724→G15, 256→G20, 828→L08, 548→A64, 29→F12,
> 556→A65, 30→A72, 830→L05, 396→A65, 759→Ñ59, 441→J28; orden interpolado). `809E`
> quedó solo en M13 (no puede estar en dos sectores).
>
> Nota: **v2.77** — **picking: aclarar Nacional/Importado en pares de planimetría**.
> Si un código tiene su par (base + E) cargado en `planimetria.js` **en el MISMO
> sector** (ej. `580`/`580E` en C19), al pickearlo el operario ve un aviso y dos
> botones **Nacional / Importado**; lo que toca **define el código que se registra**
> en el `PKC` (Nacional→`580`, Importado→`580E`) — así no se cruzan los stocks.
> `showPickingList` calcula `dual` por ítem (`dualOf`); `pkRender` muestra el paso
> de aclaración; `pkClarify`/`pkReclarify` setean `it.pick`; `pkOk`/`pkConfirmF`
> mandan el código elegido. **Activo** desde que existe el par `580`/`580E` (v2.76).
>
> Nota: **v2.76** — **planimetría: alta del código `580`**. Se agregó `"580":["C19",60]`
> a `window.GONDOLA` (planimetria.js), mismo sector y orden que `580E` (C19, 60).
> Antes solo existía `580E`; un picking con el código `580` pelado caía sin
> planimetría (orden al final + evento `PSP`/aviso Telegram). `index.html` ahora
> carga `planimetria.js?v=2.76` para bustear caché.
>
> Nota: **v2.75** — **acceso al panel Admin de Recepción + nuevo supervisor**.
> (a) Se agregó `comexloekemeyer@gmail.com` a `SUPERVISOR_EMAILS` (ve los
> monitores de Producción + el botón nuevo). (b) Botón **"🏭 Recepción (Admin)"**
> en `#supervisorPanel` que abre `openRecepcionAdmin()`: un overlay
> (`#recepcionAdminOverlay`, z-index 1250) con la app de Recepción
> (`Control-Carga-Remitos-FC`) **embebida en un iframe**. Como las dos apps están
> en el **mismo dominio** (`loekemeyer.github.io`), el iframe **comparte
> sesión/almacenamiento** y anda como nativo, sin duplicar las ~1500 líneas del
> Admin ni mantener dos copias. El `src` se setea lazy al abrir. (Alternativa
> descartada por ahora: copiar todo el Admin dentro de Producción.)
>
> Nota: **v2.74** — Recepción: el pop-up de **cajas** ya **no se cierra al tocar
> el fondo** (se sacó el handler de backdrop-dismiss de `#opCajasModal`). Así, si
> el empleado tarda en cargar el número o toca fuera sin querer, el pop-up **se
> mantiene**; solo se cierra con la ✕ o al confirmar el número.
>
> Nota: **v2.73** — al agregar un código a Log/Fabr, en vez de dejar `Desc`
> vacío, `arSaveCodeRemote` **busca el mismo `Cod_Art` en `Articulos Virgilio X
> Tallerista` (cualquier tallerista) y copia TODAS sus columnas** (Desc, UxB y
> cualquier otro dato del artículo); solo cambia `Cod_Tallerista` + `Linea`
> (borra `id`/`created_at`/`updated_at` para que las regenere la DB). Así el alta
> queda completa con la descripción y los datos que el sistema usa después. Si el
> código no existe en ningún lado, cae a un alta mínima (`Desc: ""`).
>
> Nota: **v2.72** — fix del alta de Log/Fabr: la tabla `Articulos Virgilio X
> Tallerista` tiene la columna **`Desc` NOT NULL**, así que `arSaveCodeRemote`
> mandaba `Desc: ""`. (No era RLS: la tabla sí acepta INSERT.)
>
> Nota: **v2.71** — los artículos agregados a Log/Fabr con "+" ahora se guardan
> en **`Articulos Virgilio X Tallerista`** (la MISMA tabla que lee la grilla),
> NO en localStorage ni en una tabla aparte → quedan fijos y **compartidos entre
> dispositivos**. `arAddCode` inserta una fila por línea (LK y CH) con el
> `Cod_Tallerista` de Log/Fabr (`arSaveCodeRemote`); la lectura normal de
> `renderArticulos` ya las trae (y en Log/Fabr se relaja el filtro "empieza con
> número"). Best-effort: si falla el insert (RLS), avisa con `alert`. ⚠ Requiere
> que la tabla acepte **INSERT** para el rol de la app (policy RLS, SQL por chat);
> y que esa tabla **no se pise** con la sync del Excel. (`?v=2.71`.)
>
> Nota: **v2.70** — Recepción: la grilla de códigos se muestra **ordenada por
> valor numérico** del código (`drawArticulosGrid` ordena por los dígitos
> iniciales, desempate alfabético). Así el artículo agregado a mano con "+" en
> Log/Fabr queda en su **lugar numérico**, no al final. (`recepcion.js?v=2.70`.)
>
> Nota: **v2.69** — **Recepción (Modo OP): agregar artículos a Log/Fabr con "+"**.
> En la grilla de códigos de **Log/Fabr** (solo ese tallerista) aparece un botón
> **"+"**; al tocarlo pide un código nuevo, lo agrega a la grilla, abre el pop-up
> de cajas y lo deja **fijo** para próximas recepciones. Persistencia en
> **localStorage** del dispositivo (`vir_recp_extra_<claveTall>`, ver
> `arEsLogFabr`/`arLoadExtras`/`arSaveExtra`/`arAddCode` en `recepcion.js`).
> ⚠ Es **por dispositivo** (no se comparte entre celulares todavía). El módulo
> `recepcion.js` ahora se carga con `?v=2.69` para bustear caché en cada cambio.
>
> Nota: **v2.68** — **facturación, el NP tildado seguía volviendo (v2.67 no
> alcanzó)**. Causa real: `fetchFacturadosHoy` era el **único** fetch sin
> anti-caché → el refresco leía la lista **vieja** (sin el NP recién facturado) y
> la fila reaparecía. Fix: `&_=Date.now()` + `cache:"no-store"`. Además, refuerzo
> `_facTickedLocal`: los NP tildados con **POST OK** se mantienen ocultos aunque
> la lectura tarde/falle, y se sueltan cuando el server los confirma (se limpia en
> Revertir y en el Cierre). Antes el `_facNpsHoy` se reconstruía del server en
> cada ciclo y descartaba el tilde optimista.
>
> Nota: **v2.67** — **fix facturación: el NP tildado "volvía" a la lista**. El
> tilde se **escribía** con el JWT del supervisor (`facAuthWriteHeaders`) pero
> `fetchFacturadosHoy` **leía con la key anónima**; si las RLS de `Facturacion_NP`
> exigen rol `authenticated` para `SELECT`, el refresco anónimo no veía el NP
> recién facturado y la fila reaparecía en cada ciclo. Ahora `fetchFacturadosHoy`
> lee con el **JWT** si hay sesión (cae a anónimo solo para la TV sin login).
>
> Nota: **v2.66** — **picking que no se pierde si se bloquea el celular**. El
> estado del picking interactivo (`_pk`) ahora se **persiste en `localStorage`**
> (`vir_pk_<legajo>`, incluye los ítems → reanuda offline) en **cada render**
> (`pkSave` en `pkRender`). Al reabrir, `renderPendingSuggestion` muestra
> **"▶ Seguir picking tanda X (hechos/total)"** que retoma exacto donde quedó
> (`pkResume`). Re-tocar EP de la misma tanda también restaura lo ya marcado
> (`showPickingList` mergea los `results` guardados). Se borra al terminar
> (`pkClearSaved` en `pkFinishPicking`); los guardados de días anteriores se
> ignoran y limpian. Antes, si el navegador mataba la pestaña, se perdía todo.
> *(**v5.91** cambió esto: si el picking sigue ABIERTO, el guardado de otro día se
> conserva —cruce de día— y se puede reconstruir desde el servidor. Ver nota v5.91.)*
>
> Nota: **v2.65** — armado guiado (sigue apagado): **(a) m³ desde la hoja
> `VolumenArticulos`** (`fetchVolumenArticulos`, gid por `&sheet=VolumenArticulos`;
> detecta col código + col m³ por header) — ya NO se lee de la base de pedidos.
> **(b) Sueltas nunca**: `arPackLios` reparte las cajas en **`round(total/lío)`**
> líos (mín 1) lo más parejo posible, así lo que sobra se **agrega a otro lío o se
> junta entre sí** (mismo m³). Ej.: 11 cajas/lío 5 → **[6,5]**; con override
> 321=4, 11 cajas → **[4,4,3]**; 3 → [3]; 6 → [6]. Cada lío muestra su total de
> cajas. (Edge: si una caja/m³ tiene 1 sola unidad en el pedido, queda 1 lío de
> 1 — inevitable, no se puede mezclar con otra caja.)
>
> Nota: **v2.64** — dos cosas. (a) **Picking: no se puede terminar con artículos
> salteados.** Si el operario usó "Adelante" y dejó artículos sin marcar Ok/F,
> la pantalla final (`pkRenderDone`) **bloquea** "Terminé el picking", lista los
> que faltan y ofrece "Completar los que faltan →" (`pkGoFirstPending` salta al
> primer pendiente). `pkFinishPicking` tiene el mismo guard. Hay que marcar cada
> uno (Ok o F) sí o sí. (b) **Armado guiado (v2.63): total de líos del pedido +
> composición de cada lío.** Ahora muestra un banner "Pedido X · N líos en total"
> y, por caja, **qué juntar en cada lío** (`arPackLios` empaqueta en orden:
> "Lío 1: 505×5", "Lío 2: 505×2 + 586×3", "Sueltas: 586×1"). Sigue apagado por
> defecto.
>
> Nota: **v2.63** — **armado guiado por caja (OPCIONAL, apagado por defecto)**.
> Al tocar **AP** (Empecé Armado Pedido), si `ARMADO_GUIADO_ACTIVO === true` y el
> sheet **"PPP Excel Base Datos Pedidos"** tiene una columna de **m³** (header que
> contenga `m3`/`mt3`/`volum` — lo lee `fetchPickingBase` → `_pickM3Cache`), abre
> una guía interactiva (reusa `#tandaModal` + estilos `pk-*`): agrupa los ítems
> del pedido por **caja = mismo m³** (ítems distintos con igual m³ van juntos) y
> dice cuántos **líos** armar. Lío = `LIO_DEFAULT` (**5**) cajas; el parámetro es
> **por m³**, con override sembrado por código (`LIO_OVERRIDE_COD = {"321":4}` →
> se aplica a la caja/m³ de ese código). Lo que no llega a un lío queda **suelto**.
> Termina sugiriendo **TAP** (igual que el picking sugiere TP). Funciones
> `showArmadoGuide`/`arRender`/`arConfirm`/`arFinish`; hook en `send()`
> (`opcion === "AP"`). **No obligatorio / no rompe nada**: la flag está en
> **false** (no se les muestra a los operarios), es saltable, y si falta el m³ ni
> se activa (AP funciona como hoy). Pendiente del dueño: confirmar la
> hoja/columna real del m³, y dar OK para activarlo. (Aún no emite evento de
> detalle por caja — se agrega cuando se active.)
>
> Nota: **v2.62** — **cantidad de cajas por defecto al cerrar RT**. Al tocar RT
> para **cerrarlo** (2º toque, "Indicar Cantidad" en `selectOption`), el campo ya
> viene **pre-cargado** con las cajas que contó el Modo OP (editable). Para que
> cada recepción muestre **lo suyo** y no se acumule entre recepciones del día,
> el contador se **reinicia a 0 cada vez que se abre RT** (`recepcionResetCajas`
> en el hook de `send()`). El cierre por Terminar Día sigue igual (read-only). Es
> el mismo acumulador `localStorage` de v2.61.
>
> Nota: **v2.61** — **Modo OP de Recepción integrado en RT**. Al tocar **`RT`**
> (Recepción Mercadería, 1er toque/apertura) se abre el **Modo OP** portado de
> la app `Control-Carga-Remitos-FC` (v1.13.0): elegir Talleristas / Prov. Art.
> Terminado → buscar → línea **LK/CH** + fecha → N° RTO/FC → grilla de códigos
> con pop-up de cajas → resumen → confirmar. Graba en `Entregas Tallerista
> Virgilio` / `Entregas Prov AT` + deja el pendiente en `Control_Modo_OP` (mismo
> Supabase `hrxfctzncixxqmpfhskv`, pero con **login anónimo** vía `supabase-js`
> para pasar RLS). Vive en **`recepcion.js`** (`<script type="module">`),
> aislado bajo `#rcpRoot` (DOM + CSS scopeados, no choca con el `button{}` global
> de Producción). Expone `window.openRecepcionOp(legajo, dayKey)`; el hook está
> en `send()` (`if (opcion === "RT" && toggles.RT)`). **Necesita conexión** (lee
> y escribe datos vivos), a diferencia del resto de la app. **Cantidad de RT
> automática**: cada confirmación suma las cajas a `localStorage`
> (`vir_recepcion_cajas_<legajo>_<día>`); al **Terminar Día**, RT se cierra con
> ese total (`recepcionCajasDelDia`) **sin pedir el número a mano** — el campo es
> read-only y la validación no lo bloquea. Anular un envío resta del acumulador.
>
> Nota: **v2.60** — **aviso Telegram por códigos sin planimetría**. Al armar el
> picking, si hay códigos que no figuran en `window.GONDOLA` (planimetria.js),
> la app emite **un** evento **`PSP`** por tanda/legajo/día (`texto =
> TANDA|COD1,COD2`, id `psp_<legajo>_<tanda>_<día>` + upsert) por la cola
> offline. Un trigger de Supabase (`trg_sin_planim_telegram` →
> `notificar_sin_planimetria_telegram()`, **solo INSERT** a propósito: reabrir
> el picking upsertea y NO re-avisa) lo manda al bot `@Faltantes_Virgilio_bot`
> (mismo bot/chat que faltantes). Guard: si planimetria.js no cargó (`GONDOLA`
> vacío) NO avisa (serían todos falsos positivos). Función
> `pkNotifySinPlanim` en `index.html`; `PSP` agregado al `isUpsert` de ambos
> `trySendOneReport` (index + sw).
>
>
> Nota: **v2.59** — **planimetría / orden de góndola activado** en el picking. Se
> agregó **`planimetria.js`** (`window.GONDOLA = { "502":["A01",1], … }`, 315
> artículos código→[sector, orden]) generado de la hoja **"Picking"** del Excel
> `AAA_PPP_Vigente.xlsm` (cols Emp·Cod·Sector·Orden). `showPickingList` ahora
> **ordena los artículos por el `orden` de góndola** (los sin planimetría caen al
> final, numérico) y le adjunta el **sector**; `pkRender` muestra `Sector: A01`
> real (antes placeholder). Para actualizar la planimetría: re-subir el Excel y
> regenerar `planimetria.js` desde la hoja "Picking". `index.html` lo carga con
> `<script src="planimetria.js">`.
>
>
> Nota: **v2.58** — **vista "Faltantes"** en el panel del supervisor (botón 📦,
> modal `#faltantesModal`). Lee los eventos `PKC` del día elegido (selector hoy +
> 6) con la clave pública (REST, igual que el resto del monitor), filtra los que
> tienen `real < esperadas` y los **agrupa por tanda** (Artículo · Puso · Pedía ·
> Falta · Legajo) + resumen (tandas / artículos / cajas faltantes). Auto-refresco
> 20s. Funciones: `openFaltantes`/`refreshFaltantes`/`faltantesSetDay`.
>
>
> Nota: **v2.57** — **Carga Camión**: al iniciar `CC` (1er toque), el operario ve un
> checklist de las **NP de las tandas con armado terminado** (`TAP`, de
> `getActivityStatus().armadoDone` cruzado con `fetchMonitorSheet` para los NP) y
> **tilda las que cargó**. Cada NP marcada → evento **`CCN`** (texto = `NP|TANDA`)
> por la cola offline, con id determinístico `ccn_<legajo>_<np>_<día>` + upsert.
> Funciones: `showCargaCamion`/`ccRender`/`ccToggle`/`ccSave`/`ccSendDetail`.
> (v2.56: sector del picking como placeholder visible.)
>
> Nota: **v2.55** — el picking interactivo ahora tiene navegación ← Atrás /
>
> Nota: **v2.55** — el picking interactivo ahora tiene **navegación ← Atrás /
> Adelante →** entre artículos (se puede ir y volver; al revisitar uno confirmado
> muestra "ya confirmaste X (faltaron Y) — podés cambiarlo"). Para que ir y volver
> NO duplique registros, el evento `PKC` pasa a **client_id determinístico**
> (`pkc_<legajo>_<tanda>_<art>_<día>`) y **upsert** (merge-duplicates): reenviar o
> corregir hace UPDATE de la misma fila. Se extendió el `isUpsert` (antes solo FJ)
> en `trySendOneReport` de `index.html` y `sw.js` para incluir `PKC`. Funciones
> nuevas: `pkPrev`/`pkNext`/`pkAdvance`/`pkCount`. El popup se mantiene (no es
> pantalla completa).
>
> Nota: **v2.54** — el pop-up de picking pasó de **solo-lectura** a **flujo
> interactivo de a un artículo**: muestra `CÓDIGO` + cajas a levantar (y `sector`
> en gris hasta que se suba el orden de góndola), y el operario confirma con
> **Ok** (puso lo pedido → siguiente directo) o **F** (no está todo → anota
> cuántas cajas puso). Cada confirmación **se guarda en Supabase** como un evento
> nuevo **`PKC`** ("Picking artículo") por la **cola offline** (no se pierde sin
> red): `texto = "TANDA|CÓDIGO|ESPERADAS|REALES"` (ej. `A15C|502|5|3`), un evento
> por artículo. Reporte de faltantes: `where opcion='PKC'`, `split('|')` →
> faltante = esperadas − reales. Funciones en `index.html`: `showPickingList`
> (ahora arma `items[{art,esp}]` ordenados y abre el flujo), `pkRender`, `pkOk`,
> `pkF`/`pkConfirmF`, `pkSendDetail`. Al terminar todos los artículos, la pantalla
> final ofrece **"Terminé el picking"** (`pkFinishPicking`) que dispara el `TP`
> reusando `send()` (setea `selected="TP"` + el código de tanda). Pendiente: orden
> de góndola + sector real (cuando se suba ese dato).
>
> Nota: **v2.53** — **lista de picking** (pop-up al "Empecé Picking"). Cuando el
> operario manda `EP` con una tanda, aparece un modal (reusa `#tandaModal`) con
> los **artículos a levantar**: cruza la tanda → sus pedidos (`PPP Excel
> Programacion Diaria`, vía `fetchMonitorSheet` → `sheetMap.pedidos[].np`) con los
> artículos de cada pedido (hoja **`PPP Excel Base Datos Pedidos`**, ~20k filas:
> `Pedido | Fecha | Artículo | … | Cantidad Cajas`), **suma las cajas por código**
> y las muestra **ordenadas numéricamente** (después: orden de góndola). La base se
> baja por gviz **por nombre** (`&sheet=PPP Excel Base Datos Pedidos`, no por gid)
> y se cachea 5 min (`fetchPickingBase`). Si la tanda no está o no hay conexión, el
> modal lo avisa. Funciones nuevas en `index.html`: `fetchPickingBase`,
> `showPickingList`, `renderPickingList`; enganche en el flujo de envío (rama
> `opcion === "EP"`). La hoja `PPP Excel Base Datos Pedidos` la pushea la macro de
> Excel (vía `handleCargaPPPSync_`, ALLOWED_SHEETS), igual que Programación y
> Pedidos Entregados.
>
> Nota: **v2.52** — (a) el `#versionBadge` ya **no trae versión hardcodeada** en el
> HTML (antes decía `v2.04 ✓` y nunca se actualizó → engañaba el diagnóstico):
> queda **vacío** y lo llena el JS (`updatePendingIndicator`). **Regla de
> diagnóstico:** si el badge muestra versión → el JS corrió; si queda **vacío** →
> el JS NO corrió (navegador que no parsea el código / error). (b) El Service
> Worker, en `activate`, ahora **borra todas las cachés viejas** (`caches.delete`):
> versiones MUY viejas del SW precacheaban el HTML y dejaban TVs pegadas a un
> `index.html` viejo aunque se cambiara la URL; con esto, cualquier device que
> agarre el SW nuevo se auto-despega. ⚠ Un navegador que NO pueda ejecutar el JS
> (ES2017) tampoco corre el SW nuevo → para esos hay que **borrar datos del
> navegador** a mano (o usar una página de monitor en ES5, aún no existe).
>
> Nota: **v2.51** — en **modo kiosko** (TV de pared, `?monitor=tv&key=tv`) el
> handler de `load` ahora llama a `maybeAutoOpenMonitor()` además de
> `showKioskAdminPanel()`, así la TV **entra directo a la vista que pide la URL**
> (`?monitor=tv`→Monitor, `fc`→Facturación, `incons`→Inconsistencias) en cada
> recarga, en vez de quedarse en el panel "Administración". El panel queda de
> fondo: si se cierra la vista, sigue estando para elegir otra. (Antes el kiosko
> no auto-abría nada porque `initAuth()` corta en `__tvKioskMode` antes de llamar
> a `maybeAutoOpenMonitor()`.)
>
> Nota: **v2.50** — `fetchMonitorSheet` ahora lee la pestaña "PPP Excel
> Programacion Diaria" por **posición de columna FIJA**, no por nombre de
> encabezado. La pestaña tiene sub-tablas apiladas con encabezados repetidos,
> incompletos y duplicados por gviz; depender del header era frágil. Layout fijo
> (índices, 0-based): `Tanda=0, Tipo=1, N° NP=2, Fecha Recep=3, Cod=4, Razon
> Social=5, M3=6, V=7, Direccion=8, Barrio=9, Op=10, Fecha Entrega=11, Fecha
> Fc=12, Zona=13, Observaciones=14`. Se recorren TODAS las filas y se toman como
> pedido sólo las que tienen **N° NP** (las de título/encabezado/total no lo
> traen). `opIsSi` respeta la columna `Op`. Sanity-guard: si no hay ningún
> encabezado reconocible (p.ej. una página de login HTML) tira error; si lo hay
> pero las columnas no caen donde se esperan, avisa por consola (señal de que
> cambió el Excel → actualizar el objeto `C` en `fetchMonitorSheet`). ⚠ **Si se
> reordena/agrega una columna en el Excel, hay que actualizar esos índices.**
> Validado contra el CSV real del 2026-06-05. (v2.48/v2.49 fueron pasos previos:
> detección de header tolerante; v2.50 la reemplaza por posición fija.)
>
> Nota: **v2.49** arregla del todo el bug "Sin tandas planificadas" en la pestaña
> "PPP Excel Programacion Diaria" (la que lee el monitor, `gid=1947169223`). Esa
> pestaña tiene **varias sub-tablas apiladas** ("Pedidos con Problemas o Nuevos",
> "…Super a Programar", "…a Programar", "Programacion"), cada una con su fila de
> encabezado. Dos problemas: (1) gviz **duplica** los labels del header bueno
> ("Op Op", "M3 M3", "Fecha Entrega Fecha Entrega") → el match exacto de columnas
> fallaba; (2) los headers de las sub-tablas son **incompletos** (traen "Op" pero
> la col "Fecha Entrega" vacía). Cuando las sub-tablas crecen, el parser agarraba
> un header parcial y ninguna tanda quedaba con fecha → monitor vacío con `● al
> día`. Fix (index.html, `fetchMonitorSheet`/`findMonitorHeader`): `dedupeHeaderCell`
> colapsa los labels duplicados, `findMonitorHeader` exige tanda+op+`fecha entrega`
> (1ra pasada) escaneando 50 filas, se saltean las filas de encabezado repetidas
> (`Op`/`Tanda` literales) y `opIsSi` pasa a respetar la columna `Op` (antes
> `!tanda` marcaba como planificadas las filas sin código de tanda → los pedidos
> "a Programar"/"con Problemas" con Op vacío entraban como `S/Tanda` y sus fechas
> futuras desplazaban tandas reales de la ventana). Validado contra el CSV real
> del 2026-06-05 (header en fila 0 ya de-duplicada; C19H/C32C/C31A salen para hoy).
> **v2.48** fue un intento previo insuficiente (no contemplaba los labels
> duplicados ni el header incompleto).
>
> Nota: **v2.45** re-aplica el parche **"entrar con legajo"** (de Producción
> Virgilio v1.86): debajo del botón de Google, la pantalla de login tiene un
> input para tipear el legajo; se resuelve contra `Empleados` y la sesión
> (`vir_legajo_auth`) dura el día. Se había perdido al rebasar sobre tv-v.
>
> Nota: **v2.44** parte de la base **tv-v v2.43** (monitor en vivo + kiosko TV
> actualizados: tablas Mts3 x Hora, Parcial, Total por día, FC ✓, legajo en
> picking, duraciones cross-day, etc.) y le re-aplica dos features de operario:
> **(a) Llegada Tarde (`LT`)** automática y **(b) continuar tarea al día
> siguiente** (ver § 4). Importante: el **tiempo de LT NO se cuenta como
> trabajado** en el monitor (se excluye `opcion="LT"` en `fetchMonitorDayStats`,
> `showDayBreakdown` y `fetchProductivityData`). Sede `V` quedó con jornada
> **08:00–17:00** en `Empleados`.
>
> Nota: v1.49 (de otra branch) agregó la **pantalla de Facturación** (botón 🧾,
> tick por NP, tabla `Facturacion_NP`) y **gráficos de productividad** (Chart.js:
> m³/h por operario por día, picking y pedido) con export **PDF** (jsPDF) en el
> monitor. En **v1.51**: los días sin datos ya no se grafican en 0 (quedan como
> hueco) y al **tocar/click en un punto** se abre la composición de ese promedio
> (las tandas con su m³ y tiempo que suman el m³/h).
>
> En **v1.52**: se **habilitó el QR de fichada** (`QR_DISABLED=false`, flujo
> Supabase verificado), el monitor **excluye legajos test 0/1** de conteos/gráficos,
> los botones 📊/📋 ya no aparecen en el celular del operario (el supervisor abre
> monitor/facturación por URL `?monitor` / `?monitor=fc`), más varios fixes de
> estética/CSS.
>
> En **v1.53**: compatibilidad con navegadores de TVs viejas (~2017+). Se quitó la
> sintaxis que rompía el parseo en esos navegadores (`?.`, `catch` sin binding,
> spread de objeto, `Promise.allSettled`). ⚠ El código usa `async/await` y arrow
> functions (ES2016-2017), así que **TVs de 2015-2016 todavía NO lo corren** — para
> esas haría falta una página de monitor aparte escrita en ES5.
>
> En **v1.55**: el logo de la app (`icon.svg`) se muestra en los headers del
> **Monitor Virgilio** y de **Facturación (ventas)** — clase `.hdr-logo`, escala con
> el título (em) así crece en modo TV. (En v1.54 se había puesto en la pantalla de
> legajo; se movió a los monitores.) Resto pendiente de detallar.
>
> En **v1.56**: los botones flotantes **📊 Monitor Virgilio** y **📋 Facturación
> (ventas)** vuelven a estar **siempre visibles** abajo a la izquierda, en cualquier
> pantalla y dispositivo (se revierte el ocultamiento de v1.52). Cualquiera puede
> abrir los monitores tocándolos.
>
> En **v1.57**: (a) **3er botón flotante ⚠ Inconsistencias** a la derecha del de
> Facturación (abre el monitor directo en esa pestaña; también por URL
> `?monitor=incons`). (b) El **Monitor Virgilio abre SIEMPRE en modo TV** (fondo
> azul, tablero completo), aunque la pantalla sea chica — ya no usa el popup blanco.
>
> En **v1.58**: (a) se **quitó la pestaña de Inconsistencias del Monitor Virgilio**
> (el modal ya no tiene pestañas); Inconsistencias se abre solo por su botón ⚠ y el
> título del modal cambia a "Inconsistencias". (b) **Responsive del monitor TV**: el
> tablero azul ahora **scrollea** si no entra (antes se recortaba con `overflow:hidden`)
> y **se apila en 1 columna en celular** (`@media max-width:760px`) → entra bien en la
> TV de 32" y en pantallas chicas.

---

## 0. Qué es

App web de una sola página (PWA, sin framework) para registrar la **producción
de un depósito** (picking, armado de pedidos, carga de camión, recepción, etc.).
La usan los **operarios** desde el celular tocando botones de acción, y los
**supervisores** desde un **monitor** que cruza esos eventos con la programación
de pedidos de un Google Sheet.

- Se sirve desde **GitHub Pages**: `https://loekemeyer.github.io/Produccion-Virgilio/`
- Repo: `loekemeyer/produccion-virgilio` · se publica desde la branch **`main`**
  (lo que llega a `main` queda online en ~1 min; cada pantalla lo ve al refrescar).
- **No hay branch de desarrollo**: se trabaja y pushea **directo en `main`**. Las
  ramas `idea/<código>` existen solo para propuestas de agentes pendientes de
  aceptar (ver § Agentes).
- **Play Store**: la PWA se publica como **TWA** (envoltorio Android que abre la
  web a pantalla completa). Cómo generar el `.aab` y publicar: ver
  **`PLAY-STORE.md`**. Config en `twa-manifest.json`; íconos PNG en `icons/`;
  Digital Asset Links en `.well-known/assetlinks.json` (¡va en la raíz del
  origen, no bajo `/Produccion-Virgilio/`!).

---

## 1. Archivos del repo

| Archivo | Rol |
|---|---|
| `index.html` | **La app completa** (~35.000 líneas): pantalla de operario + monitor + toda la lógica JS/CSS. Es el archivo central. |
| `recepcion.js` | Módulo de **Recepción** (~2.600 líneas): control de remitos de talleristas/proveedores, checklist de Pendientes, OCs, fotos. Lo carga `index.html`. |
| `sw.js` | Service Worker. **NO cachea HTML/assets**: sólo hace Background Sync de la cola offline (IndexedDB). `SW_VERSION = "vX.YZ-vir"` (la versión real acompaña a `APP_VERSION`). |
| `manifest.json` | Manifiesto PWA. |
| `fichada.html` / `fichada.js` / `fichada-config.js` / `fichada-totp.js` / `fichada.css` | Sistema de **fichada por QR rotativo (TOTP)**. La página `fichada.html` se abre escaneando el QR y registra el **ingreso**. |
| `fichadas-monitor.html` | Tablero **independiente** "Monitor Fichadas Esnaola" (lee de `Fichadas_Historico` y sincroniza otro Google Sheet distinto). No está enlazado desde `index.html`. |
| `monitor/index.html` | Shim de **redirección**: da la URL limpia `/Produccion-Virgilio/monitor` → redirige a `/?monitor=tv` (para colgar la Smart TV). |
| `qrcode.js` | Librería vendorizada para generar QR. |
| `icon.svg` | Ícono (fuente vectorial). |
| `icons/` | Íconos PNG 192/512 + maskable + ícono 512 para la ficha de Play (generados desde `icon.svg`). Requeridos por la PWA/TWA. |
| `twa-manifest.json` | Config de Bubblewrap para empaquetar la TWA (Play Store). |
| `.well-known/assetlinks.json` | Plantilla de Digital Asset Links (verificación de la TWA). |
| `PLAY-STORE.md` | Guía paso a paso para generar el `.aab` y publicar en Google Play. |

---

## 2. Pantallas y navegación

Todo vive en `index.html`, alternando con la clase `.hidden` (no hay router):

- **Pantalla de legajo** (`#legajoScreen`): **login obligatorio con Google**
  (Supabase Auth, provider Google del proyecto `hrxfctzncixxqmpfhskv`). Arranca
  mostrando sólo el botón "Iniciar sesión con Google" (`#authBlock`). Tras loguear,
  el módulo de auth decide el **rol** por email y muestra la pantalla acorde:
  - **Supervisor** (emails fijos en `SUPERVISOR_EMAILS`: `loekemeyer.n8n@gmail.com`,
    `loekemeyer.logistica@gmail.com`, `comexloekemeyer@gmail.com` — más los
    remotos de la tabla `Supervisores_Mails`): ve `#supervisorPanel` con los
    **botones grandes** del panel (hoy ~15 en varias filas: 📊 Monitor, 📋 Facturación,
    ⚠ Inconsistencias, 📈 Análisis, 📦 Stocks, 🗓 PPP, 🖨️ Cola de impresión NP,
    🌐 Panel Web LK, ⚙ Configuraciones, etc.). No necesita estar en `Empleados` ni
    tiene legajo. (Los antiguos botones flotantes de abajo se eliminaron.)
  - **Operario** (email cargado en `Empleados`): se resuelve `email → {Legajo, Empleado}`
    (`select=Legajo,Empleado`). Ya **no se tipea el legajo** y **salta directo a la
    grilla de opciones** (EP/TP/...) vía `goToOptions()`. El **nombre** se muestra en
    `#userTag` arriba a la izquierda (persistente, también en opciones). El `#legajoInput`
    queda oculto (`display:none`) pero conserva el Legajo, así todo el código que lee
    `legajoInput.value` (~15 lugares: envíos, historial) sigue funcionando sin cambios.
    El `#legajoEntry` (saludo "Hola, {nombre}" + Continuar + Salir) queda como pantalla
    de "volver" (botón ← de opciones) y para el logout. **No** ve nada de supervisor.
  - **No autorizado** (ni supervisor ni en `Empleados`): `signOut()` inmediato +
    aviso "no autorizada". No se le da acceso usable.
  - **Gate de monitores:** `requireSupervisor()` protege `openMonitor/openFacturacion/
    openInconsistencias/openAnalisis` (vía `window.__isSupervisor`), así no se entra
    por la URL directa. El auto-open por URL (`?monitor=tv/fc/incons`) se difiere a
    `maybeAutoOpenMonitor()`, que el módulo de auth llama sólo si el email es supervisor.
  - **Modo kiosko (TV box / pantalla de pared, SIN login), con enrolamiento:** como el
    TV box no puede loguearse con Google (navegador viejo / webview bloqueado), se
    accede al monitor con una **URL + clave que se usa UNA sola vez**:
    `?monitor=tv&key=<MONITOR_TV_KEY>` (también `fc`, `incons`). Flujo:
    1. Primera vez en ese dispositivo: la clave válida marca el device como kiosko en
       `localStorage` (`vir_tv_kiosk=1`) y **borra la clave de la URL** con
       `history.replaceState` (queda `?monitor=tv` pelado, la clave no queda a la vista).
    2. De ahí en más, ese TV entra con `?monitor=tv` solo. Un dispositivo no enrolado
       que lea esa URL en la pantalla **no entra** (no tiene flag ni clave) → login.
    El main script setea `window.__tvKioskMode=true` + `window.__isSupervisor=true` y
    en `load` muestra el **panel "Administración"** (`showKioskAdminPanel()`: revela
    `#supervisorPanel` con los 4 botones, oculta login/operario y el botón Salir) **como
    fondo** y, desde **v2.51**, **auto-abre directo la vista que pide la URL**
    (`maybeAutoOpenMonitor()`: `?monitor=tv`→Monitor, `fc`→Facturación, `incons`→
    Inconsistencias) — la TV de pared va derecho al tablero en cada recarga; si se
    cierra esa vista, queda el panel detrás para elegir otra. Todo **sin Google y sin depender de
    `supabase.js`** (el módulo de auth detecta `__tvKioskMode` y no inicializa). `MONITOR_TV_KEY` es constante en
    `index.html` (hoy `"tv"`); cambiala para rotar la clave (los devices ya
    enrolados siguen hasta que se borren los datos del navegador). Para des-enrolar un
    device: borrar datos del navegador. El resto (celulares/PC) sigue con login Google.
  - **Duración de la sesión:** `supabase-js` la persiste en `localStorage` y dura
    **todo el día** (cerrar el navegador NO desloguea). Se cierra: (a) al cambiar de
    día — `applyAuthState` compara `vir_auth_day` (día BsAs guardado al loguear) con
    `getTodayKey()` y si difiere hace `signOut`; (b) al confirmar **Terminar Día**
    (`confirmarTerminarDia` llama `window.endDaySignOut()`). Así a la mañana siguiente
    o tras finalizar el día se vuelve a pedir login.
  - **supabase-js va SELF-HOSTED**: `supabase.js` (bundle UMD, ~200 KB) en la raíz del
    repo, cargado con `<script src="supabase.js">` (expone el global `supabase`). NO se
    usa CDN, así el login no depende de un tercero. El `redirectTo` preserva el query
    (`?monitor=tv`) para que la TV vuelva a la misma URL tras el login. (Para actualizar
    la lib: `npm pack @supabase/supabase-js@2` y copiar `dist/umd/supabase.js`.)
  - **Para autorizar a un operario nuevo:** cargar su `email` en `Empleados`. Para un
    supervisor nuevo: agregar el email a `SUPERVISOR_EMAILS` en `index.html`.
  - **Requisitos de config (fuera del código):** provider Google habilitado en
    Supabase Auth · la URL de GitHub Pages (`https://loekemeyer.github.io/Produccion-Virgilio/`)
    en la allowlist de *Redirect URLs* · consent screen de Google OAuth en
    producción (o el operario como test user) · el `email` del empleado cargado
    en `Empleados` (hoy sólo ~9 de 58 lo tienen).
  - La allowlist es a nivel app (chequeo contra `Empleados`/`SUPERVISOR_EMAILS` +
    `signOut`). Una cuenta de Google ajena que complete el OAuth igual crea una fila
    transitoria en `auth.users`, pero queda deslogueada y sin acceso. El login es una
    **puerta de UI**, no el candado de los datos (la app lee/escribe con la clave
    pública anon igual que antes; el blindaje real de datos sería RLS).
  - El límite de "sólo 2 mails" del otro programa que usa el mismo proyecto Auth
    es lógica de *esa* app, **no** una restricción de Supabase (no hay hook ni
    trigger en el esquema `auth`): no afecta a esta app.
- **Pantalla de opciones** (`#optionsScreen`): la grilla de botones de acción +
  botón rojo **"Terminar Día"** (dispara el `FJ`).
- **Botones flotantes**: 📅 historial de días anteriores · 📊 **monitor** del supervisor.
- **Monitor**: se abre con 📊 o automáticamente con `?monitor=tv` (o si la pantalla
  mide ≥1600 px). La URL `/Produccion-Virgilio/monitor` entra directo en modo TV
  (con **cache-buster** automático para no quedar pegada a una versión vieja, ver § 10).
  Tiene **dos pestañas**: **Monitor** (tablero de tandas) e **Inconsistencias**
  (hoja de alertas, ver § 12).

---

## 3. Modelo de datos (Supabase)

- Proyecto Supabase: **`Control Partes Talleristas`** · id **`hrxfctzncixxqmpfhskv`**
  · región `sa-east-1` · Postgres 17. (La base es **compartida** con otros
  sistemas: tiene ~90 tablas; abajo sólo las que usa esta app.)
- URL: `https://hrxfctzncixxqmpfhskv.supabase.co`
- Key en el cliente: `sb_publishable_BqpAgZH6ty-9wft10_YMhw_0rcIPuWT`
  (**publishable / pública por diseño**; RLS permite INSERT de producción/fichadas
  y los SELECT que el monitor necesita). La misma trinca está en `sw.js`,
  `fichada-config.js` y `fichadas-monitor.html`.
- Acceso desde Claude: usar la **herramienta MCP `execute_sql`** con
  `project_id = hrxfctzncixxqmpfhskv` (no requiere red del sandbox).

### Tablas que usa la app

**`Registros_Produccion_Virgilio`** — el **log de eventos de producción** (la tabla
clave para casi todo). Cada fila = una acción de un operario:

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid | |
| `client_id` | text | id de la cola offline; en `FJ` es determinístico `fj_<legajo>_<YYYY-MM-DD>` |
| `legajo` | text | número de operario (texto) |
| `opcion` | text | **código de acción** (ver § 4) |
| `descripcion` | text | texto legible de la acción ("Empecé Picking", …) |
| `texto` | text | dato capturado: **código de tanda/pedido** o cantidad o (en FJ) un JSON de conteos. Siempre `.trim().toUpperCase()` |
| `ts_cliente` | timestamptz | momento del evento (cierre, si es un cierre) |
| `ts_inicio` | timestamptz | **sólo en eventos de cierre** = momento de apertura → `duración = ts_cliente − ts_inicio` |
| `created_at` | timestamptz | insert en servidor |

**`Fichadas_Virgilio`** — ingresos por QR: `legajo`, `email`, `tipo` (= `"ingreso"`),
`ts_cliente`, `client_id`, `user_agent`, `ip_hint`, `created_at`. (El QR in-app
está **habilitado** — `QR_DISABLED = false` desde v1.52, ver § 9 — aunque la tabla
sigue con pocos registros.)

**`Fichadas_Historico`** — espejo de marcas: `ts_evento`, `evento`
(`Entrada` / `Salida` / `Comida Inicia` / `Comida Termina`), `email`, `legajo`,
`empresa`, `imported_at`.

**`Empleados`** — maestro: `Legajo`, `Empleado` (nombre), `email`, `Num_Tel`,
`Activo`, `Sede`, `hora_entrada`, `hora_salida`, `tipo`. Sirve para resolver
legajo↔nombre y legajo↔email.

**`Auditoria_Produccion_Virgilio`** — auditoría de envíos (intentos, motivos,
user_agent, ts_inicio/ts_cliente).

**Tablas PPP (espejo de Google Sheets, v2.80 — opcionales: se leen sólo si
`PPP_SOURCE` ≠ `"sheets"`):** cada una con `id` autonumérico y carga por
**reemplazo total** (DELETE all + INSERT), igual que el `clearContents`+`setValues`
del Apps Script → se permiten filas repetidas, fiel a la hoja.
- **`PPP_Programacion_Diaria`** ← hoja "PPP Excel Programacion Diaria" (1 fila por
  N° NP). Cols: `np`, `tanda`, `tipo`, `fecha_recep`, `cod`, `razon_social`,
  `m3` (numeric), `v`, `direccion`, `barrio`, `op`, `fecha_entrega`, `fecha_fc`,
  `zona`, `observaciones`.
- ~~`PPP_Pedidos_Entregados`~~ **BORRADA en v10.25** (2026-08-12): era el espejo
  duplicado de la hoja "PPP Excel Pedidos Entregados 2026" (solo `tanda`+`mt3`). El m³
  entregado ahora sale de **`PPP_Entregados_Meta`** (`np`, `cod`, `rs`, `tanda`, `m3`,
  `fecha_entrega` — superconjunto), que se sincroniza sola cada 30 min por la función
  Postgres `sync_ppp_entregados_meta()` (col Mt3 — NO "Mt3 FC"). `vista_tanda_m3` ya la lee.
- **`PPP_Base_Pedidos`** ← hoja "PPP Excel Base Datos Pedidos". Una fila por línea.
  Cols: `pedido`, `articulo`, `cajas` (numeric).

Las escribe el **Apps Script** (`handleCargaPPPSync_`, el que ya escribe las hojas)
con la `service_role` key del proyecto Virgilio (bypassa RLS); ⚠ las props Supabase
que ya tiene ese script apuntan a OTRO proyecto (`kwkclwhmoygunqmlegrg`, la web), por
eso el hook usa props nuevas `SUPABASE_VIRGILIO_*`. La app sólo las **lee** (RLS
`select` para `anon`/`authenticated`). DDL en `sql/ppp_supabase.sql`; hook en
`apps-script/sync-ppp-supabase.gs`; diseño en `MIGRACION-SUPABASE-PPP.md`.

**Vistas PPP → Excel (v6.44, migración `vistas_ppp_sheet`)** — el camino **inverso**
al espejo anterior: Supabase → Excel. Dos vistas (`security_invoker = true`, grant
`select` a `anon`/`authenticated`; DDL versionado en `sql/ppp_vistas_sheet.sql`):
- **`vista_ppp_programacion_pendiente`** — `PPP_Programacion_Diaria` MENOS las NP
  "entregadas" (= con fila en `Facturacion_NP` con `cierre_id` no nulo). Cols: `tanda`,
  `np`, `tipo`, `cod_cliente`, `razon_social`, `m3`, `zona`, `barrio`, `direccion`,
  `op`, `fecha_recep`, `fecha_entrega`, `fecha_fc`, `observaciones`.
- **`vista_ppp_pedidos_entregados`** — NP **facturadas + cerradas**
  (`Facturacion_NP` con `cierre_id` no nulo, join a `Facturacion_Cierres`), con m³ y
  las **cajas reales** (pedidas/entregadas/faltó) sumadas de `Entregas_Virgilio`
  (lateral por `np`; lo apoya el índice `entregas_virgilio_np_idx`).

Cuando una NP se cierra, sale sola de "pendiente" y aparece en "entregados" — es una
condición en la vista, no un movimiento. Las lee el botón **"⬇ Exportar Excel"** de
la PPP (`pppExportExcel`). Auditadas por auditor-supabase (aprobadas). (El Apps
Script `ppp-a-excel.gs` que también las leía se **eliminó el 2026-07-30** por
decisión del usuario, sin haberse deployado.)

**`Entregas_Virgilio`** (v3.99) — **registro de lo entregado por pedido** (NO es una
vista; es una **tabla** persistente que **la app llena al dar TAP**, vía
`_compSaveEntregas`). Una fila por **NP × artículo** del pedido entero de la tanda:

| Columna | Tipo | Notas |
|---|---|---|
| `id` | bigint | autonumérico |
| `fecha_salida` | text | **fecha de ENTREGA** (`fecha_entrega` de `PPP_Programacion_Diaria`, no la de armado) |
| `cod_cliente` | text | código de cliente del NP |
| `np` | text | número de NP |
| `cod_art` | text | código de artículo |
| `cajas_pedidas` | numeric | lo que pedía el picking para esa NP/artículo |
| `cajas_entregadas` | numeric | `cajas_pedidas − cajas_falto` |
| `cajas_falto` | numeric | faltante asignado a esa NP en el reparto del Paso 2 del wizard (0 si no faltó) |
| `tanda` | text | código de tanda |
| `creado` | timestamptz | insert en servidor (default `now()`) |

RLS: `ent_insert`/`ent_select` para `anon`+`authenticated` (la app escribe con la
publishable key). **No duplica la base**: la fila guarda el pedido tal como estaba al
entregar (no se re-lee la efímera `PPP_Base_Pedidos`). **Offline-safe**: si el POST
falla por red, las filas quedan en `localStorage` `vir_entregas_pend` y se reintentan
al volver online / al cargar (`_compFlushEntregas`). La consume el **programa externo**
de seguimiento de entregas. (Reemplaza a las vistas `Entregas_Virgilio`/`Faltantes_Virgilio`
y a los eventos `FAL` de v3.97/v3.98, ya eliminados.)

**Facturación (tick de la operadora + cierre de reparto):** cuando ventas tilda una
NP en la pantalla **Facturación — NPs a FC** (`facTickNP`, escritura con **sesión
Google `authenticated`**, RLS exige ese rol), se graba una fila en:
- **`Facturacion_NP`** — una fila por NP facturada. Cols: `np`, `tanda`, `fecha_salida`,
  `m3` (numeric), `razon_social`, `cod_cliente`, `facturado_at` (timestamptz del tick),
  `cierre_id` (null hasta el cierre → apunta a `Facturacion_Cierres.id`). PK `np`
  (upsert merge-duplicates, por si hay doble click). Es la que consumen las vistas PPP
  (pendiente/entregados), el segmento **FC s/Salida** de Stocks (v6.66: antes solapa
  aparte, ahora dentro de «📊 Stocks») y el descuento de demanda.
- **`Facturacion_Cierres`** — una fila por **cierre de jornada** ("Terminé" de la
  operadora → PDF de reparto). Cols: `id`, `fecha_cierre`, `fecha_reparto`, `cant_nps`,
  `cant_tandas`, `generado_at`. Al cerrar, las `Facturacion_NP` del día toman su
  `cierre_id` → salen de "pendiente" y pasan a "entregados" (condición de las vistas).

**Facturación electrónica ARCA (v6.51+, en PRODUCCIÓN desde v6.64):** la 2ª tilde
**"✓ ARCA"** (`facFacturarNP` → `facFCOpen`/`facFCEmitir`) emite la factura real contra
AFIP/ARCA vía la **Edge Function `arca-wsfe`** (Supabase Functions). Los comprobantes se
loguean en:
- **`Comprobantes_ARCA`** — Cols: `id`, `np`, `tanda`, `cuit_cliente`, `tipo_cbte`
  (1=FA A, 6=B, 11=C, 3/8/13=NC), `pto_vta`, `nro_cbte`, `importe_neto`, `importe_iva`,
  `importe_total`, `cae`, `cae_vto`, `estado` (`autorizado`/…), `entorno`
  (`prod`/`homo`), `raw_resp` (jsonb de la respuesta WSFE), `creado`.
- **Edge Function `arca-wsfe`** — acciones: `status`, `ta`, `ultimo`, `emitir`,
  `preciar` (calcula importe server-side cruzando `Entregas_Virgilio` con precios del
  proyecto web), `emitir_np`, `emitir_nc`. Secrets en Supabase (nunca en el repo):
  `ARCA_CERT`/`ARCA_KEY` (cert `virgilioapp`), `ARCA_ENV=prod`, `ARCA_PTO_VTA=11`,
  `ARCA_CUIT`, `WEB_SERVICE_KEY`. Detalle en `docs/facturacion-arca.md`.

**`lk_pedidos_match`** (2026-08-28) — espejo del **string identificador de pedido web**
de los DOS portales (LK y Chef), con la **sucursal de entrega** (dato que Virgilio no
tenía). La llena LK cada 15 min empujando por su FDW (rol `lk_ppp_reader`, único permiso
de escritura de ese rol); los pedidos de Chef los lee LK de su FDW `chef_db` y los
reenvía (pendiente un grant en el proyecto Chef — hasta entonces solo hay filas `lk`).
Cols: `empresa` (`'lk'`/`'chef'` — PK con `order_id`; NP 9xxxx = lk, 4xxxx = chef),
`order_id` (= order_number del portal/Sheet), `cod_cliente`, `status`,
`fecha_pedido` (date ART), `hora_pedido`, `created_at`, `sucursal_entrega`,
`items_string`, `match_string` (`cod_cliente|fecha|items`, items = `cod`x`cajas`
ordenado por código, cajas sumadas por código repetido), `ambiguo` (mismo string ese
día con >1 sucursal distinta — el único caso que el string no resuelve), `orden_en_dia`
(desempate por hora), `synced_at`. RLS: anon/authenticated SELECT; escribe solo
`lk_ppp_reader`. Ver `sql/lk_pedidos_match.sql`.

**`Alertas_Pedidos_Web`** (v8.83) — alertas de **pedidos web anómalos** detectados por el
Mayorista. Una fila por alerta:

| Columna | Tipo | Notas |
|---|---|---|
| `id` | bigint | autonumérico |
| `order_id` | bigint | UNIQUE — id del pedido en el Mayorista |
| `cod_cliente` | text | código de cliente |
| `cliente` | text | razón social |
| `total_pedido` | numeric | monto del pedido |
| `total_historico` | numeric | promedio histórico del cliente |
| `ratio` | numeric | total/histórico |
| `cajas` | integer | total de cajas del pedido |
| `lineas` | integer | cantidad de líneas |
| `score` | integer | puntaje de anomalía (>= 5 para alertar) |
| `motivo` | text | descripción de las señales detectadas |
| `origen` | text | siempre `mayorista_detector` |
| `estado` | text | `pendiente` / `revisada` / `descartada` |
| `revisado_en` | timestamptz | cuándo se revisó/descartó |
| `revisado_por` | text | legajo del supervisor que revisó |
| `creado_en` | timestamptz | default `now()` |

RLS: `anon` INSERT (el Mayorista POSTea con la publishable key) + SELECT (el front lee) +
UPDATE (el supervisor marca revisada/descartada). Trigger `trg_alerta_pedido_telegram` →
`notificar_alerta_pedido_web()` → `tg_enqueue` al insertar. La **detección** corre en el
proyecto Mayorista (`kwkclwhmoygunqmlegrg`): función `detectar_pedidos_anomalos()` cada 5 min
(pg_cron), con tabla de log `alertas_pedidos_log` (evita re-alertar). 4 señales: ratio vs
histórico (>3x +2 / >5x +4 / >10x +6), units-as-boxes >70% (+4), cliente nuevo + pedido >$3M
(+3), cajas/línea >30 (+2). Score >= 5 → POST a Virgilio vía REST. DDL: `sql/alertas_pedidos_web.sql`.

**Subsistema NC (devoluciones — comprobantes de proveedores, v6.64):** ingestión local
por `agente-local/nc_ingest.py` (parsea PDFs de Notas de Crédito/Débito) a dos tablas:
- **`Comprobantes_NC`** — cabecera. Cols: `id`, `division`, `tipo`, `numero`, `fecha`,
  `contraparte`, `total`, `stock_dir` (dirección del ajuste de stock), `estado`
  (`pendiente`/`confirmado`), `archivo`, `huella` (dedup del PDF), `creado_at`,
  `confirmado_at`, `confirmado_por`.
- **`Comprobantes_NC_Items`** — líneas. Cols: `id`, `nc_id` (→ `Comprobantes_NC.id`),
  `cod_raw`, `cod_art`, `descripcion`, `cajas`, `unidades`, `importe`.

### Esquemas `isis_lk` / `isis_ch` — facturación real del ISIS (sin documentar hasta v12.25)

Dos esquemas (**no `public`**) que guardan los **comprobantes reales** del ERP ISIS,
parseados de PDF: `isis_lk` (Loekemeyer) e `isis_ch` (Chef). Es la **fuente de verdad
de facturación** — más confiable que cualquier cálculo del lado de Virgilio o de LK,
porque es lo que efectivamente se facturó, con CAE y todo.

- **Ingesta**: agente local en Python (mismo patrón que `agente-local/nc_ingest.py` de
  las NC), corre en el desktop con acceso a las carpetas `PDF_ISIS`/`PDF_ISISCHEF`,
  parsea con `pypdf` y sube con la secret key. Corre cada 1-2 min mientras hay PDF
  nuevos — verificado 2026-09-01: última ingesta 31/08 17:12, ~30.700 documentos
  cargados el 28/08 en una sola corrida (carga histórica) más el goteo diario.
- **`isis_lk.documentos`** / **`isis_ch.documentos`** — un comprobante por fila.
  Columnas clave: `familia` (`factura_venta`/`nc_venta`/`nd_venta`/`factura_compra`/…),
  `tipo`, `letra`, `numero`, `punto_venta`, `fecha`, `vto_factura` (**sólo 4% de las
  facturas de venta lo trae parseado**), `condicion_venta` (**100% cargado** — es el
  texto libre del ISIS: `"30 FF"`, `"Pago Contado -25%"`, `"IMPORTADOR"`, etc., 31
  variantes distintas verificadas), `condicion_pago` (NULL siempre, no lo trae el
  parser), `contraparte_cuit`/`contraparte_codigo`/`contraparte_nombre`, `subtotal`,
  `iva`/`iva_21`/`iva_105`, `total`, `cae`/`cae_vto`, `total_cajas`, `storage_path`
  (PDF en el bucket privado `isis-lk`/`isis-ch`), `comprobante_id`. **RLS ON, revocado
  a anon/authenticated** — sólo se lee vía vista/RPC (`vista_deudores_documentos` etc.),
  igual criterio que `clientes_dto`.
  ⚠ El `contraparte_codigo` viene con **dos grafías**: ceros a la izquierda
  (`"001587"`) en facturas anteriores a mayo 2022, sin ceros después — pasar siempre
  por `public.canon_cod()` antes de comparar/agrupar por código.
- **`isis_lk.documento_items`** / **`documento_valores`** / **`comprobantes_aplicados`**
  — líneas de detalle, valores de pago (cheques: banco, número, `fecha_valor`, 197
  filas) e imputación recibo→factura (19 filas). El agente **todavía no parsea
  recibos/cobranzas** — son las tablas donde va a entrar eso cuando lo haga (ver
  módulo Deudores, nota v12.25).
- **Volumen verificado (2026-09-01)**: 21.870 facturas + 8.941 NC + 146 ND de venta LK
  (desde 2019-06); 6.122 facturas + 2.137 NC + 57 ND de venta Chef (desde 2019-08).
- **Vistas que ya lo usan**: `comprobantes_venta` (LK+Chef unidas, con signo),
  `vista_factura_metodo_pago` (cruza contra `Comprobantes_ARCA`/`vista_np_sucursal` —
  ⚠ hoy pega mal: `Comprobantes_ARCA` sólo tiene 6 filas de la prueba de julio, así
  que casi nada matchea), `vista_np_factura` (concilia el neto calculado de Virgilio
  contra la factura real del ISIS por NP, ±5% y ±0,5 caja de tolerancia).
- **CUIT cruza LK y Chef; el código de cliente NO** (numeraciones independientes por
  diseño, ver § Panel Web LK / Clientes vinculados en el repo LK). Verificado sobre
  facturas 2025-2026: 674 CUIT distintos en LK, 144 en Chef, 50 facturan en las dos
  empresas y de esos **sólo 1** comparte el mismo código de cliente.

### Subsistema de stock / OC (event-sourced)

Además del log de eventos, el stock físico y las compras viven en tablas propias:

- **`Movimientos_Stock`** — libro mayor event-sourced del stock. Una fila por
  movimiento: `cod_art`, `deposito` (`terminado`/`excedente`/`separar_pedidos`/
  `a_facturar`/`a_guardar`/`para_envasar`/`racks_ch`…), `delta`, `tipo`
  (`inicial`/`recepcion`/`guardado`/`picking`/`separado`/`facturado`/`ajuste`/…),
  `ts`, y opcional `ubicacion`/`unidad`/`ref`. El saldo se calcula con
  `stockComputeSaldos(movs, cutoff, asOf)` (front, solo para modo As-Of) y la
  vista `vista_saldos_stock` (server). Desde **v10.00** el front lee
  **`vista_stock_procesada`** (**MATERIALIZED VIEW** desde 2026-08-12; antes era
  VIEW regular) que une saldos + demanda + proyección + capacidad + config OC en
  una sola query. Se refresca automáticamente cada 2 min vía **pg_cron** (job 55:
  `REFRESH MATERIALIZED VIEW CONCURRENTLY vista_stock_procesada`) y bajo demanda
  con la RPC **`refresh_stock_view()`** (SECURITY DEFINER). Tiene índice único
  `idx_vista_stock_procesada_cod` sobre `(cod)` (requerido por CONCURRENTLY).
  Lectura: ~0.2 ms (vs ~215 ms como VIEW regular). El front solo cae a
  `stockComputeSaldos` cuando el usuario activa "A una fecha" (As-Of).
  Helper: `_stkSaldosFromView(rows)`.
  `tipo='inicial'` es baseline y **siempre** cuenta; el **cutoff**
  ("marcar inicio", `Stock_Config.cutoff_ts`) desconsidera los movimientos reales previos.
- **`Stock_Config`** — flags/config del stock (cutoff, alertas, toggles), keyed por
  `clave` (upsert `merge-duplicates`).
- **`OC_Maximos`** — máximos por artículo para el generador de OC (`cod`, descripción,
  `linea`, `max_cajas`, `proveedor`, `uni_x_caja`, `indice`, `activo`).
- **`Ordenes_Compra`** — OC generadas/recibidas (proveedor, fecha, rubro, ítems,
  `cantidad`/`cantidad_recibida`, estado). Las edita el módulo Compras/Recepción OC.
  Las **genera** "📑 Órdenes de Compra → ⚙ Generar OCs" (`ocgEnter`/`ocgGenerar`) a
  partir del **PPP** (demanda) + stock + `OC_Maximos`. Desde **v7.04** también las
  **lee la Recepción de Mercadería** (`recepcion.js`): muestra en cada botón de código
  la cantidad de la OC vigente del proveedor y, si lo recibido la excede en +20%, avisa
  por Telegram (evento `ROC`, ver § 4) sin frenar al operario.
- **`Racks_Bajadas`** / **`Racks_Ordenes`** — flujo de bajada de racks (propuesta →
  aprobación → bajado); `Racks_Planimetria` guarda el layout.
- **`Envasar_Ubicaciones`** — dónde está lo del depósito `para_envasar` (aparte de la
  planimetría de góndola).
- **`Zonas_Barrios`** — mapa barrio → zona para la PPP.

RLS `anon` (hardening 2026-07): lectura + escritura **acotada por tabla** — insert
siempre; update sólo donde la app lo usa; **sin delete** salvo `Envasar_Ubicaciones`.
Ver `sql/agente_propuestas.sql` y las notas de seguridad.

### Vistas y funciones backend (v10.10, 2026-08-12)

Desde v10.10, lógica que antes se hacía con múltiples fetches en el front se movió a
vistas/funciones server-side. El front consume estas vistas en un solo fetch cada una:

- **`norm_cod(text)`** — función `IMMUTABLE`. Normaliza códigos de artículo:
  `regexp_replace(upper(trim(coalesce(c,''))), '^0+(?=.)', '')`. Usada por
  `vista_stock_procesada` (exclusión de insumos puros) y otras vistas.
- **`norm_nombre(text)`** — función `IMMUTABLE`. Normaliza nombres para matching
  fuzzy: `lower(trim(…))`, quita acentos con `translate`, reemplaza `.`, `,`, `'`
  por espacio, colapsa espacios múltiples. Usada por `oc_vigentes_por_proveedor`.
- **`vista_fc_sin_salida`** — VIEW. Reemplaza 6 fetches de `stkFcsFetch()`:
  NPs facturadas no cargadas a camión. Columnas: `cod`, `cajas`, `cant_nps`,
  `detalle_nps` (jsonb: `[{np, cajas, tanda, rs, fecha}]`). Front: `stkFcsFetch()`.
- **`vista_abastecimiento`** — VIEW. Reemplaza 3 fetches + `abastCompute()` (~120k
  filas) del módulo Abastecimiento. Columnas principales: `cod`, `descripcion`,
  `rec_avg`, `rec_ult`, `ven_avg`, `ven_ult`, `bal_avg`, `bal_ult`, `n_prov`,
  `stock`, `pedidos`, `nps_ped`, 8 columnas de depósito, `falta`, `cap_falla`,
  `stk_falla`, `provs_ult_detalle` (jsonb), `mes_ultimo`, `es_importado`.
  Front: `openAbastecimiento()`. Detalle mensual por artículo se carga lazy
  desde `vista_recepcion_mensual` / `vista_venta_mensual` al expandir la fila.
  Nota: `abastCompute()` sigue existiendo — la usa el módulo OC (línea ~10114).
- **`vista_correcciones_pedido_rich`** — VIEW. Reemplaza 5+ fetches secuenciales
  de `facCorreccDataRich()` para el panel de correcciones. Columnas: `np`, `sec`,
  `ppal`, `descripcion`, `cajas`, `razon_social`, `tanda`, `fecha`, `stk_sec`,
  `stk_ppal`, `ent_ped`, `ent_entr`, `ent_falto`, `estado`.
  Front: `facCorreccDataRich()`. Nota: `pkcReal`/`pkcHay` no están en la vista
  (se hardcodean a 0/false en el front — solo afectan drill-down de enpicking).
- **`oc_vigentes_por_proveedor(p_nombre text)`** — RPC (SECURITY INVOKER). Reemplaza
  fetch de 5000 filas + filtrado client-side de `cargarOCVigentes()` en `recepcion.js`.
  Recibe nombre de proveedor, maneja alias (Pettofrezza→Rafael), splits por
  `/,+& y`, prefix match con ≤2 chars de slack. Columnas: `cod`, `fecha`, `ped`,
  `rec`, `pend` (bigint). Front: `cargarOCVigentes()` en `recepcion.js`.
- **`vista_tanda_status`** — VIEW. Estado de tandas para el monitor + correcciones.
  Columnas: `tanda`, `last_pick_op`, `pick_legajo`, `pick_start_ts`, `last_arm_op`,
  `arm_legajo`, `arm_start_ts`, `estado`. **No conectada al front todavía** (prioridad media).

Rollback batch 1: `rollback_alta_prioridad_20260812.sql` en el scratchpad del agente.
Backup de `vista_stock_procesada` pre-cambios: `backup_vista_stock_procesada_matview_20260812.sql`.

#### Batch 2 — objetos ALTA prioridad (v10.10b, 2026-08-12)

Segundo lote de migración front→back. Objetos creados, **aún no conectados al front**:

- **`generar_inconsistencias(p_dia date)`** — RPC (VOLATILE, SECURITY DEFINER).
  Reemplaza `computeInconsistencias()` (~135 líneas de motor de reglas, 5k events).
  Todas las reglas replicadas: pedido duplicado, FJ duplicado, evento post-FJ,
  jornada sin FJ (solo días pasados), jornada >12h, duración excesiva (TP/TAP >8h,
  toggles >3h, comida >90min), múltiples comidas, cierre sin apertura, abierto sin
  cerrar (con threshold 3h para hoy), pedido inválido (no en PPP), hueco >90min.
  Excluye legajos 0/1 (test). Devuelve `(sev, cat, legajo, hora, detalle)`.
  Front: `refreshInconsistencias()` en index.html.

- **`vista_faltante_catalogo`** — VIEW. 1 fila por artículo con stock (neto/bruto),
  proveedor (con reparto P1/P2), flag discontinuo, última entrega (fecha/cajas),
  OC pendiente (cajas/fecha/prov), notas (día resolución/motivo). Pre-joinea
  `vista_saldos_stock` + `vista_generador_oc` + `OC_Maximos` + `Movimientos_Stock`
  + `Ordenes_Compra` + `Faltantes_Notas`. Reemplaza 6 de los 13 fetches de
  `stkFaltLoad()`. **OC pend muestra solo la última OC** por código
  (`ROW_NUMBER() OVER PARTITION BY cod ORDER BY fecha DESC, id DESC`), no la
  suma de todas las pendientes (fix v11.71, 2026-08-25). SQL: `sql/vista_faltante_catalogo.sql`.

- **`vista_faltante_demanda`** — VIEW. 1 fila por (NP, artículo) con empresa-split
  (437E/438E/439E/809E → LK/CH), estado picking por tanda (sinpickear/enpicking/
  preparado), fecha armado (día hábil previo vía `dia_armado()`), fecha salida,
  razón social, es_super. Pre-joinea `PPP_Programacion_Diaria` + `PPP_Base_Pedidos`
  + EP/TP de `Registros_Produccion_Virgilio`, excluye NPs facturadas/entregadas/
  canceladas. Reemplaza 5 de los 13 fetches de `stkFaltLoad()`.

- **`vista_faltante_real`** — VIEW. Faltante real del picking: último PKC por
  (tanda, artículo), ESP−REAL > 0. Solo tandas "preparado" (con TP). Con empresa-
  split. Reemplaza los 2 fetches de PKC de `stkFaltLoad()`.

- **`vista_avisar_programacion`** — VIEW. Reemplaza 5 fetches de `avpLoad()`.
  Agrupa PPP pendiente por (cliente, fecha_salida) = 1 envío, pre-joinea teléfonos
  (whatsapp_clientes), vendedor (clientes_vendedor), teléfono/nombre vendedor
  (whatsapp_vendedores), último aviso al cliente (envio_programacion_log), flag
  ya-enviado al vendedor. Columnas: `grp_key`, `cod`, `rs`, `fppp`, `fped`, `dias`,
  `nps` (array), `tel_cli`, `vend`, `tel_vend`, `vend_nombre`, `last_cli_ts`,
  `last_cli_quien`, `vend_sent`.

- **`vista_racks_bajadas_pendientes`** — VIEW. Reemplaza fetch de 20k filas en
  `renderBajadasRacks()`. Joinea `Racks_Bajadas` (estado='propuesta') con
  `Articulos Virgilio X Tallerista` para cajas_x_master y uni_x_caja.

- **`gondola_return_check(p_items jsonb)`** — RPC (STABLE). Reemplaza 3 fetches
  de `gondReturnCheck()`. Recibe `[{cod, cajas}]`, devuelve flags `exceso_gondola`
  (stock+cajas > cap×1.2) y `baja_rotacion` (proyección < 50).

- **`vista_plata_perdida`** — VIEW. Reemplaza 4 fetches/200k filas de `ppLoad()`.
  Columnas: `np`, `cod`, `cajas`, `ped`, `ent`, `fecha`, `cod_cliente`, `precio_unit`,
  `uxb`, `descripcion`, `precio_ok`, `plata`, `vendedor`, `razon_social`.

- **`dia_armado(date)`** — función `IMMUTABLE`. Último día hábil antes de una fecha
  (sáb/dom → viernes). Helper para `vista_faltante_demanda`.
- **`prox_habil(date)`** — función `IMMUTABLE`. Próximo día hábil después de una fecha.

Rollback batch 2: `sql/rollback_alta_batch2_20260812.sql`.

- **`vista_insumos`** — VIEW. Pestaña Insumos lee ubicación como read-only desde
  esta vista (v10.10+). COALESCE de 3 fuentes en orden de prioridad:
  (1) `Racks_Planimetria` (sectores ocupados, para producto terminado en racks),
  (2) `Insumos_Ubicaciones` (tabla relacional de piezas/flejes),
  (3) `Insumos.ubicacion` (campo legacy directo).
  Columnas: id, cod, nombre, categoria, isis, creado_por, creado, orden, ubicacion.
  Ubicación es read-only en el front; cambios solo vía "Mover Racks" o edición
  directa de las tablas fuente.

#### Batch 3 — objetos MEDIA prioridad (v10.10c, 2026-08-12)

Tercer lote. Objetos creados, **aún no conectados al front**:

- **`vista_entidades_recepcion`** — VIEW. Reemplaza 2 fetches de `cargarEntidades()`
  (recepcion.js). Une talleristas (Codigos X Tallerista, agrupados por nombre con
  cod_lk/cod_ch) + proveedores AT (Tall_ProvAT_PS, activos con rec_virg).

- **`vista_historial_entregas`** — VIEW. Reemplaza 2 fetches paralelos de `histLoad()`
  (recepcion.js). Unifica `Entregas Tallerista Virgilio` + `Entregas Prov AT` con
  columnas normalizadas (fuente, fecha, cod_art, cajas, quien, remito). El cliente
  filtra por cod/quien/remito/fechas con PostgREST.

- **`vista_articulos_prov_at`** — VIEW. Reemplaza 2 fetches secuenciales de
  `renderArticulos()` (rama prov_at, recepcion.js). Pre-joinea `Articulos x Prov AT`
  (activos) con `Articulos Virgilio X Tallerista` para la línea LK/CH. El cliente
  filtra por proveedor y linea.

- **`vista_control_remitos`** — VIEW. Reemplaza 5 fetches de `fetchCRData()`.
  Consolida CCN/TAL/CRN/FSS (últimos 7 días) con metadatos PPP/Entregados. Ya
  excluye controlados (CRN) y sin salida (FSS), ordena vencidos primero. Columnas:
  np, tanda, lios, cod_cliente, rs, vencido, first_load, last_ccn.

**Pendiente MEDIA**: `prodLoad/prodCompute` — RPC parametrizado por rango de fechas,
cálculo de productividad con m³ y factores. Complejidad alta, dejado para después.

---

## 4. Códigos de acción (`opcion`)

Definidos en `index.html` (objeto `desc`; buscarlo por `const desc = {`). Los
botones se arman en **5 filas** (`row1`…`row5` en el HTML de la grilla de opciones):

| Código | Descripción | Grupo | ¿Captura `texto`? |
|---|---|---|---|
| `EP` | Empecé Picking | CORE (inicio) | Sí — código de tanda (ej. `A12B`) |
| `TP` | Fin Picking | CORE (cierre) | Sí — código de tanda |
| `AP` | Empecé Armado Pedido | CORE (inicio) | Sí — código de pedido |
| `TAP` | Terminé Armado Pedido | CORE (cierre) | Sí — código de pedido |
| `CR` | Control Remitos | TOGGLE | Sí — abre **popup de control de facturados** (`showControlRemitosCR`, v3.69): lista de facturados del reparto + Líos + tic **Controlado** → `CCR` por NP + cierra el toggle. (Fue toggle plano sin popup en v3.43–v3.68.) |
| `RR` | Recepción Remitos | TOGGLE | Abre el popup de descarga (tabla NP cargados → tildar Controlado → «Terminé» = `CRN` por NP); desde v3.43 lleva la lógica que antes tenía `CR`. **v3.75+**: además hay un botón **"Recepción Remitos (RR)"** en Administración (`openRemitosAdmin` → `showControlRemitos("0", true)`) que abre la **MISMA lista** en modo admin (legajo `0`, sin cerrar toggle). Lo controlan operarios **y** admin. (v3.76 lo había sacado de los operarios; revertido en v3.77.) |
| `CC` | Inicio/Fin Carga Camión | TOGGLE | Sí, al cerrar (Nro) |
| `RT` | Recepción Mercadería | TOGGLE | Sí, al cerrar: `texto` = cantidad de cajas, **calculada sola** del Modo OP de Recepción (suma del día en `localStorage`, ver v2.61). Al abrir RT se lanza el Modo OP (`recepcion.js`); si el operario lo deja por la mitad, la recepción queda como **borrador** y se retoma con **"▶ Seguir recepción …"** desde la botonera (v7.09, movido a la botonera en v7.12). Desde **v7.07** la grilla de códigos muestra la **OC vigente** del proveedor y avisa por Telegram si lo recibido la excede (+20%, evento `ROC`). |
| `MG` | Guardado a Góndola | MÓDULO (abre/cierra, como CP/SC) | No — abre el chooser directo (📥 a guardar / excedente / racks). **v7.68**: dejó de ser toggle. Entrar/salir **NO** deja el botón en rojo; un apretón por error se deshace con **Cancelar/Cerrar** (sale limpio, no registra nada). El evento `MG` con su **duración** (open del modal → confirmar; lo usan Rendimiento `t_movim` y el Monitor `movMs`) lo emite `mgConfirmar`→`mgEmitGuardado` **una** vez por guardado confirmado (no más pares apertura/cierre). |
| `RI` | Recepción Insumos | TOGGLE | Sí, al cerrar (cantidad) |
| `EI` | Entrega Insumos | TOGGLE | Sí, al cerrar (cantidad) |
| `AT` | Atendí Timbre | TOGGLE / tiempo muerto | No |
| `PB` | Paré Baño | TOGGLE / tiempo muerto | No |
| `Limp` | Limpieza | TOGGLE / tiempo muerto | No |
| `Perm` | Permiso de Salida | TOGGLE | No |
| `PC` | Paré Comida | TOGGLE / tiempo muerto | No |
| `CT` | Conteo | TOGGLE / tiempo muerto | No |
| `FJ` | Fin de Jornada | (botón "Terminar Día") | `texto` = JSON con los conteos del día |
| `LT` | Llegada Tarde | (automático) | `texto` = minutos de demora; `ts_inicio` = inicio de jornada, `ts_cliente` = primer mensaje. **NO cuenta como trabajado** en el monitor |
| `PKC` | Picking artículo | (detalle de picking, v2.54) | `texto` = `TANDA\|CÓDIGO\|ESPERADAS\|REALES` (ej. `A15C\|502\|5\|3`). Un evento por artículo confirmado en el flujo de picking. El monitor lo ignora (no está en los grupos). |
| `CCN` | Carga Camión NP | (detalle de carga, v2.57) | `texto` = `NP\|TANDA` (ej. `97754\|C47B`). Un evento por NP marcada como cargada al camión. id determinístico `ccn_<legajo>_<np>_<día>` + upsert. El monitor lo ignora. |
| `PSP` | Picking sin planimetría | (automático, v2.60) | `texto` = `TANDA\|COD1,COD2` (códigos del picking que no están en `planimetria.js`). UNO por tanda/legajo/día (id `psp_<legajo>_<tanda>_<día>` + upsert). Dispara aviso Telegram vía trigger `trg_sin_planim_telegram` (solo INSERT → no spamea al reabrir). El monitor lo ignora. |
| `TAL` | Líos por NP (TAP) | (detalle de armado, v3.34) | `texto` = `NP\|LÍOS\|TANDA` (ej. `97754\|3\|C47B`). Un evento por NP de la tanda al terminar armado (popup obligatorio tras `TAP`; si no lleva, `0`). Lo lee Control Remitos para la columna Líos. id aleatorio (no upsert). El monitor lo ignora. |
| `CRN` | Control Remito NP | (detalle de control, v3.36) | `texto` = `NP\|TANDA` (ej. `97754\|C47B`). Un evento por NP marcada como **recibida/controlada** en Recepción Remitos (`RR`, antes `CR`). id determinístico `crn_<legajo>_<np>_<día>` + upsert. La PPP lo lee (`pppRefreshControlado`) y pasa el pedido a **Pedidos Entregados**. El monitor lo ignora. |
| `CRA` | Carga sin control (vencido) | (automático, v3.37) | `texto` = `NP\|TANDA\|RAZÓN`. Lo emite la PPP (`pppCheckCargaVencida`) cuando un pedido **cargado (CCN) sigue sin controlar (CRN/manual)** pasado el plazo (`crVencido`). id determinístico `cra_<np>_<día>` + upsert; legajo `0`. Dispara aviso Telegram vía trigger `trg_carga_sin_control_telegram` (**AFTER INSERT** → 1 vez por NP/día). El monitor lo ignora. |
| `CCR` | Control Remito CR NP | (detalle de control CR, v3.69) | `texto` = `NP\|TANDA` (ej. `97754\|C47B`). Un evento por NP marcada como **controlada** en **Control Remitos (CR)** — paso **independiente** de la Carga Camión. id determinístico `ccr_<legajo>_<np>_<día>` + upsert. El NP sale **sólo de CR** (`fetchCCRData` lo resta de los facturados). ⚠ **NO alimenta RR** (RR lee `CCN`, no `CCR`). El monitor y las inconsistencias lo ignoran. Con el tiempo del toggle CR + los m³ sirve para medir productividad de CR (m³/h). |
| `FSS` | Facturado sin salida (volvió a depósito) | (detalle, v6.66) | `texto` = `NP\|TANDA` (ej. `98085\|C47B`). Lo emite el botón **«↩ s/salida»** de **Recepción Remitos** (`crMarkSinSalida`→`crSendSinSalida`) cuando una NP **cargada al camión (`CCN`) volvió** porque el cliente no recibió (cerrado, etc.). id aleatorio `fss_<legajo>_<np>_<ts>` (**no** upsert: cada retorno es un evento con su `ts`). Regla en **todos los lectores de `CCN`** (helper `fetchSinSalidaMap`): la NP está "sin salida" si su **último `FSS` > su último `CCN`**; si se re-carga (CCN nuevo) deja de estarlo. Efecto: sale de **RR** (`fetchCRData`), deja de contar como entregada / no dispara la alarma de carga sin control (`pppRefreshEntregado`), y **reaparece** en **«FC s/Salida»** (`stkFcsLoad`) y en **Carga Camión** (`fetchCCData`). **NO toca `Movimientos_Stock`** (esa mercadería ya salió del stock contable al facturar). El monitor lo ignora. |
| `MGX` | Guardado fuera de lista | (automático, v4.24) | `texto` = `COD\|G<góndola>\|E<excedente>`. Lo emite el MG (`mgEmitFueraLista`) cuando se guarda un código que **NO estaba en "Mercadería a guardar"** (botón "Guardarlo igual"; típico error de tipeo en recepción). id `mgx_<cod>_<legajo>_<ts>`. Dispara aviso Telegram vía trigger `trg_mg_fuera_lista_telegram` (**AFTER INSERT** WHEN `opcion='MGX'`). El monitor lo ignora. |
| `SSG` | Picking sin stock en góndola | (automático, v4.24) | `texto` = `TANDA\|COD:pedido>habia,…`. Lo emite `stockBajaPicking` al **TP** cuando se sacó de góndola **más de lo que el sistema tenía** (saldo `terminado` quedaría negativo). id determinístico `ssg_<legajo>_<tanda>_<día>` + upsert (1 aviso/tanda/día). Dispara aviso Telegram vía trigger `trg_picking_sin_stock_telegram` (**AFTER INSERT** WHEN `opcion='SSG'`). El monitor lo ignora. |
| `CG` | Conteo cíclico de góndola (idea 3798) | (operario, v7.1) | `texto` = `COD\|contado`. Lo emite `pkEmitConteo` cuando el operario, al terminar un picking, anota las cajas de góndola del artículo elegido (uno al azar de **UNA sola celda**). id `cg_<legajo>_<cod>_<día>`. Dispara **Telegram** vía trigger `trg_conteo_gondola_telegram` (**AFTER INSERT** WHEN `opcion='CG'`), que compara contra `vista_saldos_stock.terminado` (familia por empresa) y resuelve `legajo→Empleado`. Detrás del switch `Stock_Config.conteo_ciclico_gondola`. El monitor lo ignora. |
| `RAG` | Faltó al pickear pero hay en racks / a guardar (idea 5703) | (automático, v7.32) | `texto` = `TANDA\|art:falto:racks:aguardar,…`. Lo emite `stockBajaPicking` al **TP** cuando un artículo **faltó** (`real<esp`) pero hay stock del mismo código (familia `codBase`) en `racks` o `a_guardar`. id determinístico `rag_<legajo>_<tanda>_<día>` (1 aviso/tanda/legajo/día). Dispara **pop-up al operario** (`showRacksAguardarPopup`) + **Telegram** vía trigger `trg_racks_aguardar_telegram` (**AFTER INSERT** WHEN `opcion='RAG'`), que agrega las **NP(s)** de la tanda. El monitor lo ignora. |
| `FGU` | Faltó al pickear pero HABÍA stock en góndola — URGENTE (idea del usuario) | (automático, v7.70) | `texto` = `TANDA\|cod:falto:gond,…` (`gond` = cajas que el sistema tenía en góndola). Lo emite `stockBajaPicking` al **TP** cuando un artículo **faltó** (`esp>real`) pero la **góndola** (familia `codBase`, disponible a esa tanda) tenía **al menos lo pedido** (`gond ≥ esp`) → contradicción grave. id determinístico `fgu_<legajo>_<tanda>_<día>` (1 aviso/tanda/legajo/día). Dispara **Telegram** vía trigger `trg_faltante_gondola_telegram` (**AFTER INSERT** WHEN `opcion='FGU'`, `sql/faltante_gondola_telegram.sql`) → "🚨 URGENTE!! FALTÓ EN PICKING PERO HABÍA STOCK EN GÓNDOLA — Tanda X · • Art Y: faltó F, tenía G en góndola · Pickeó: {Nombre}". Condición conservadora (no se pisa con SSG/RAG). El monitor lo ignora. |
| `PGE` | Picking · retiró de góndola en vez de excedente | (aviso, v6.11) | `texto` = `COD\|TANDA`. Lo emite `pkEmitRetiroGondola` cuando el operario, en un artículo cuyo **excedente cubría todo** (paso salteado), toca **"🟢 Retirar de góndola igual"** (`pkForzarGondola`). id `pge_<cod>_<legajo>_<ts>`. Dispara aviso Telegram vía trigger `trg_picking_gondola_excedente_telegram` (**AFTER INSERT** WHEN `opcion='PGE'`), que **resuelve `legajo→Empleado`** → "🟢⚠ RETIRÓ DE GÓNDOLA (había excedente) — {Nombre} … Art X · tanda Y". No toca stock (el picking baja de góndola como cualquier otro). El monitor lo ignora. |
| `FCO` | Facturación · override de la operadora (facturó corto un faltante recuperable) | (aviso, v6.21) | `texto` = `NP\|TANDA\|detalle\|RS` (detalle = `cod×falto,…`). Lo emite `facEmitOverride` (legajo vacío: la operadora es supervisor) cuando **la operadora** confirma facturar una NP cuyo faltante **se podía completar** (había stock en `a_guardar` o góndola). El resto de los usuarios queda **bloqueado** (no llega a emitir). Dispara Telegram vía trigger `trg_facturacion_override_telegram` (**AFTER INSERT** WHEN `opcion='FCO'`) → "🧾⚠ FACTURÓ CON FALTANTE RECUPERABLE — la operadora facturó CORTO la NP … Había stock para completarlo …". No toca stock (el drenaje de `a_facturar` lo hace `stockSalidaFacturadoNP` como siempre). El monitor lo ignora. |
| `CP` | Completar Pedido | (detalle, v5.05) | `texto` = `NP\|COD\|QTY\|GONDOLA\|AGUARDAR\|LÍO`. Lo emite el modal `showCPModal` al sumar cajas que llegaron tarde a una NP armada sin facturar (mueve stock origen→`a_facturar` con `tipo='cp'`, `ref=NP`; baja `cajas_falto` en `Entregas_Virgilio`, re-emite el TAL). Si la NP **ya estaba facturada**, esas cajas de `a_facturar` se drenan: fast-path `stockDrenarCPFacturado` (en cpConfirm y en el tilde de Facturación) y, como red de seguridad, la **ETAPA 4** del cron `reconciliar_pipeline_stock()` (v6.69; `facturado` −neto `ref=NP\|CP`). El monitor lo ignora. |
| `EA` | Entrega Artículos para envasar | (detalle, v5.52) | `texto` = `COD\|QTY` (ej. `440E\|30`). Lo emite el modal `showEAModal` (botonera operario) al dar de baja stock del depósito **`para_envasar`**: `stockMove` `para_envasar −qty` (`tipo='entrega_envasar'`), un evento por código. `para_envasar` está **fuera de los 7 depósitos** de `stockComputeSaldos` (no entra en totales/OC). El monitor lo ignora. **v5.63**: el modal ahora tiene además un **editor de ubicación 📍** (tabla `Envasar_Ubicaciones`, aparte de `Racks_Planimetria`) para cargar/mover dónde está lo para-envasar — no emite evento ni toca saldo. |
| `RC` | Pasar cajas a un pedido urgente | (detalle, v5.49) | `texto` = `NP_URGENTE\|NP<donor> o T<tanda>\|COD\|QTY`. Lo emite el modal `showRCModal` al sacarle cajas a un pedido que sale después (armado o pickeado) y dárselas a uno urgente. Al confirmar: RPC `reasignar_cajas` (faltantes), `stockMove` tipo `rc` (donante `a_facturar`/`separar_pedidos −`, urgente `a_facturar +`), líos (suma al urgente, resta al donante armado). El monitor lo ignora. |
| `PUB` | Picking · dónde lo dejó | (detalle, v5.78) | `descripcion` = ubicación (mesa/carro/rack), `texto` = código de tanda. Lo emite `emitPickUbic` al **TP**: registra dónde quedó lo pickeado (se muestra al Separar). El monitor lo ignora. |
| `AUB` | Armado · dónde lo dejó | (detalle) | `descripcion` = ubicación, `texto` = NP. Lo emite `emitArmadoUbic`: dónde quedó el armado, por NP. El monitor lo ignora. |
| `IR` | Ingreso a Racks | (detalle) | `texto` = `COD\|SECTOR\|<M>M\|<C>C[\|NAC:origen]`. Lo emite `irEmitEvent` (`showIngresoRacksModal`) al ingresar mercadería a racks (masters + inner por sector). El monitor lo ignora. |
| `RKX` | Bajada de racks fuera de lista | (automático) | `texto` = `COD\|R<cajas>`. Lo emite `rkbEmitFueraLista` cuando se baja de racks un código que **no estaba** en la lista de bajada. Dispara aviso Telegram (`notificar_racks_fuera_lista_telegram`). El monitor lo ignora. |
| `NPD` | Picking difiere de mesa | (detalle) | `texto` = `NP\|COD\|tipo(menos/mas)\|GÓNDOLA\|QTY\|SALE\|TANDA`. Lo emite el flujo de Completar cuando lo levantado real difiere de lo pickeado en la mesa. El monitor lo ignora. |
| `PPE` | Errores en PPP | (automático, legajo 0) | `texto` = `sinzona:N\|zonadif:N\|tandamal:N\|sacar:N`. Lo emite el monitor PPP al detectar inconsistencias; id `ppe_<día>`. Dispara aviso Telegram (`notificar_ppp_error_telegram`, sólo si hay errores). El monitor lo ignora. |
| `ROC` | Recepción que excede la OC (+20%) | (automático, v7.07) | `texto` = `PROVEEDOR\|REMITO\|cod:recibidas/pedidas,…` (ej. `Lucho\|38770\|518:90/49`). Lo emite `opEnviar` (`recepcion.js`) cuando lo recibido de un código supera en más de **20%** lo que pide la **OC vigente** de ese proveedor (`Ordenes_Compra`; referencia = lo que **falta** recibir). **Sin pop-up ni aprobación** — al operario no se lo interrumpe: sólo el botón queda en rojo con ⚠. id `roc_<ts>`, best-effort (no bloquea la recepción). Dispara Telegram vía trigger `trg_recepcion_excede_oc_telegram` (**AFTER INSERT** WHEN `opcion='ROC'`, función `notificar_recepcion_excede_oc_telegram`, `sql/recepcion_excede_oc_telegram.sql`) → "📦⚠ RECEPCIÓN POR ENCIMA DE LA ORDEN DE COMPRA — {Proveedor} / Remito N / • Art X: recibió A vs B pedidas (+P%) / Recibió: {Nombre}". El monitor lo ignora. |

**Grupos (constantes en `index.html`):**
- `CORE_CODES = [EP, TP, AP, TAP]` — el trabajo medible (picking / armado).
- `TOGGLE_CODES = [CR, RR, CC, RT, RI, EI, AT, PB, Limp, PC, Perm, CT]` — abren y cierran. (MG salió en **v7.68**: pasó a módulo directo tipo CP/SC.)
- `DEAD_TIME_CODES = [AT, PB, Limp, PC, CT]` — mientras están abiertos **bloquean todo**.
- `ALWAYS_ALLOWED_CODES = [PB, PC]` — nunca se bloquean.
- `CLOSE_NEEDS_INPUT_CODES = [CC, RT, RI, EI]` — piden dato al cerrar.
- `SURVIVING_TOGGLES = [CR, RR]` — sobreviven la medianoche; el resto se autocierra. (MG salió en **v7.68**: ya no es toggle.)
- `AUTO_CLOSE_CODES = [AT, PB, Limp, PC, CT, Perm, CC, RT, RI, EI]` — se autocierran a las **17:00** (`WORKDAY_END_HOUR_AR = 17`) del día si quedaron abiertos.

### Continuar tarea al día siguiente (v2.44)

Al **Terminar Día**, por cada tarea abierta que sobrevive (Picking, Armado,
`CR`, `RR`, `MG`) el operario elige **Continúa mañana** o **Finalizar ahora**:
- **Continúa** → se marca `st.continuar[<tipo>] = <YYYY-MM-DD>` y la tarea se
  arrastra. Al día siguiente, `renderPendingSuggestion()` muestra un botón verde
  **"▶ Continuar [tarea]"**; al tocarlo se borra la marca, se dispara la
  evaluación de `LT`, y el cierre real se hace luego con `TP`/`TAP`/toggle.
- **Finalizar ahora** → cierra en el acto (Picking/Armado piden el dato de
  cierre y emiten `TP`/`TAP`; `CR`/`RR`/`MG` cierran el toggle) y limpia el estado.

### Llegada Tarde (`LT`, v2.44)

`LT` = minutos entre `hora_entrada` del empleado (`Empleados`) y el **primer
mensaje del día** del operario. Se evalúa en la primera acción del día
(`maybeRegisterLateArrival`): el primer reporte que envía **o** el botón
**"▶ Continuar [tarea]"**. Se registra **una** `LT` por día por legajo
(`client_id = lt_<legajo>_<día>`). Si no hay `hora_entrada`, o el primer mensaje
fue sin conexión, no se marca. El **tiempo de LT es no trabajado**: el monitor
lo excluye de horas/productividad (guard `opcion==="LT"` en
`fetchMonitorDayStats`, `showDayBreakdown` y `fetchProductivityData`).

---

## 5. Cómo se registran los eventos (semántica clave)

- **`ts_cliente`** = momento del evento. **`ts_inicio`** se completa **sólo cuando
  el evento es un cierre**. Entonces: **una fila con `ts_inicio` no nulo ES el
  cierre de una acción pareada**, y su duración = `ts_cliente − ts_inicio`.
- **Picking**: `EP` (abre, `ts_inicio` nulo) → `TP` (cierra, `ts_inicio` = apertura).
  Uno abierto por vez por legajo.
- **Armado**: `AP` (abre) → `TAP` (cierra). En el monitor la columna de armado se
  rotula **"Pedido Separado"** ("separado" = armado completo).
- **Toggles** (CR, CC, …): 1er toque abre (`ts_inicio` nulo), 2do toque cierra
  (`ts_inicio` = apertura). Son **mismo código** las dos veces.
- **`FJ` (Fin de Jornada)**: una sola fila por legajo/día (upsert por
  `client_id = fj_<legajo>_<día>`); `texto` guarda el JSON de conteos del día.
- Verificado en datos: `EP`/`AP`/`FJ` nunca traen `ts_inicio`; `TP`/`TAP` y los
  toggles lo traen ~la mitad de las filas (= sus cierres). No hay duraciones
  negativas (`ts_cliente < ts_inicio` = 0 casos).

---

## 6. Flujo de negocio

- **Tanda**: unidad de trabajo, un código de lote que el operario tipea en `texto`
  (ej. `C10B`, `C15A`, `A57B`; a veces numérico como `46112`). Viene de la
  programación del Google Sheet (filas con `Op = SI`).
- **NP**: número de pedido. Una tanda agrupa **uno o más NP**, cada uno con Razón
  Social y **m³** propios (se ven en el modal de detalle de tanda).
- **Camión**: se deriva del código de tanda (`tandaCamion()`): `C03A` y `C03B`
  → camión "03". El monitor agrupa por camión en "Total por día".
- **Secuencia esperada de un pedido/tanda**: `EP→TP` (picking) y `AP→TAP`
  (armado/separado); `CC` es la carga de camión (evento aparte).

---

## 7. De dónde salen los metros cúbicos (m³)

> **Los m³ SÍ están en Supabase** (desde v5.33, `PPP_SOURCE=supabase`):
> `PPP_Programacion_Diaria.m3`, `PPP_Entregados_Meta.m3` (por NP) y la vista
> `vista_tanda_m3` — **se calculan por SQL** desde el sandbox (§ 11). El **origen
> upstream** sigue siendo el Google Sheet (col `Mt3`), espejado en una sola vía a
> `PPP_Entregados_Meta` por la función `sync_ppp_entregados_meta()` (cron, ver
> `sql/`). Lo que sigue abajo describe ese Sheet de origen. (Histórico: hasta
> v5.33 los m³ solo vivían en el Sheet y no se podían calcular sin Google;
> `MIGRACION-SUPABASE-PPP.md` documenta la migración.)

- Documento Sheet: `1-16YXe0xq6x9i-Yhk5cm5V3VqvQ0PWZtcDbm8OeeKW0`.
- **Histórico** (todos los pedidos entregados): hoja "PPP Excel Pedidos Entregados
  2026", `gid=2146771217`. Se mapea **`Tanda` → m³ sumando la columna `Mt3` (col G)**.
- **Programación diaria**: `gid=1947169223` (cols `Tanda`, `M3`, `Op`, `Fecha
  Entrega`, `N° NP`, `Razon Social`).
- **⚠ NO usar la columna H "Mt3 FC"**: pese al nombre, NO son m³ — son códigos
  chicos (zonas) que inflan los totales. **Sólo col G "Mt3".**
- Para resolver los m³ de una tanda: primero el sheet de programación, si no está,
  el histórico, si no, 0. `monitorParseM3` entiende coma decimal (`"0,289"` → 0.289).
- El monitor ya calcula y muestra **m³ de picking / m³ de armado / total / m³ por
  hora por operario** en el modal **"Rendimiento del día"** (`showDayBreakdown`).
- **v2.80 — m³ migrables a Supabase:** si `PPP_SOURCE` ≠ `"sheets"`, el m³ sale de
  `PPP_Programacion_Diaria.m3` / `PPP_Entregados_Meta.m3` (numérico; hasta v10.25 era
  `PPP_Pedidos_Entregados.mt3`, tabla borrada) en vez del Sheet → **se puede calcular
  por SQL** (§ 11). Hoy `PPP_SOURCE = "supabase"` (desde v5.33).

---

## 8. Cómo se calculan horas / jornada

En `showDayBreakdown` (monitor, por operario por día):

- **Jornada** = `(FJ − ingreso) − comida`, donde `ingreso` viene de
  `Fichadas_Virgilio (tipo=ingreso)`, `FJ` del evento `FJ`, y `comida` = suma de
  duraciones de `PC` (cap de sanidad: sólo si `0 < dur < 8 h`).
- Como hoy casi no hay fichadas de ingreso, la jornada suele quedar incompleta.
  La métrica robusta y usada para reportes es **horas trabajadas = primera acción
  → `FJ` (o última acción si no hay FJ), menos la comida (`PC`)**.
- Zona horaria: **`America/Argentina/Buenos_Aires`, UTC-3 fijo** (Argentina no
  tiene horario de verano). Los límites de día son `T00:00:00-03:00` /
  `T23:59:59-03:00`.

---

## 9. Fichada / QR (TOTP)

- `fichada-config.js`: `hmacSecret`, `tokenPeriodSec = 30`, `tokenTolerance = 1`
  (acepta el bucket actual ±1). El secreto está en JS público → "disuasivo, no
  barrera criptográfica".
- `fichada-totp.js`: token = `<bucket>.<sig16hex>` con HMAC-SHA256 sobre
  `floor(now/1000/30)`; `verifyToken` con comparación de tiempo constante.
- El QR in-app **está habilitado** (`QR_DISABLED = false`, desde v1.52). El monitor/TV
  muestra el QR rotativo abajo-derecha (sólo con el monitor abierto). El operario lo
  escanea → abre `fichada.html?t=<token>` → pone su email → registra el **ingreso** en
  `Fichadas_Virgilio` (`tipo:"ingreso"`). El trigger `trg_fichadas_virgilio_espejo`
  lo copia server-side a `Fichadas_Historico` (`evento:"Entrada"`). El legajo se
  resuelve por email contra `Empleados`; si el email no está cargado, igual ficha
  con `legajo=null` y el monitor lo marca "sin legajo".
- `PC` y `FJ` se escriben en `Registros_Produccion_Virgilio` y el trigger
  `trg_registros_fichada_espejo` los copia server-side a `Fichadas_Historico`
  (`FJ→"Salida"`, `PC` abre→`"Comida Inicia"`, `PC` cierra→`"Comida Termina"`).
  El front ya NO escribe directamente en `Fichadas_Historico` (eliminado en la
  Fase 2 del espejo, 2026-08-28).

---

## 10. Versionado y cache

- `index.html`: `APP_VERSION = "vX.YZ"` (la versión vigente vive en el código, no
  acá — no citar un número fijo en esta guía porque queda viejo). Badge en pantalla
  `#versionBadge`: `"vX.YZ ✓"` (sin cola), `"vX.YZ ⏳ N"` (pendientes), `"vX.YZ ⚠ N"` (error).
  **Sirve para confirmar qué versión cargó cada pantalla** (mirá el badge en la TV
  para saber si está al día).
- `sw.js`: `SW_VERSION = "vX.YZ-vir"` (misma base que `APP_VERSION`; el test
  `version-sync.cjs` lo verifica). **No precachea nada**; el handler de `fetch`
  está vacío. Usa `skipWaiting()` + `clients.claim()`. La página hace
  `reg.update()` cada 60 s con `updateViaCache:"none"` (esto **sólo actualiza el
  SW**; NO recarga la app ni cambia lo que se ve en pantalla).
- Por eso, el problema de "la TV muestra una versión vieja" es **cache HTTP del
  navegador/TV**, no del SW: la TV vieja se queda pegada al `index.html` cacheado
  hasta que se la fuerza a bajar uno nuevo.
- **Cache-buster para refrescar una TV pegada (v2.47+):**
  - *Manual* (tipeado en el control remoto): agregar `?v=N` (o `&v=N`) a la URL —
    ej. `?monitor=tv&v=1`; la próxima vez subir el número (`v=2`, …). Otra URL =
    otra entrada de caché → baja el HTML fresco. La app **lee sólo `monitor`/`key`**,
    ignora `v`/`cb`, y tras cargar los **borra de la URL** con `history.replaceState`
    (`stripCacheBuster()` en `index.html`), así queda `?monitor=tv` limpio para el
    siguiente refresco. También se acepta `cb` por compatibilidad.
  - *Automático*: la ruta corta **`/monitor`** (`monitor/index.html`) redirige con
    `?monitor=tv&v=<timestamp>`, así esa entrada baja **siempre** el HTML fresco sin
    tipear nada. (Ojo: si `/monitor` ya quedó cacheado viejo en esa TV, forzarlo una
    vez con `/monitor?z` para bajar el redirect nuevo.)

---

## 11. Cómo responder preguntas con SQL (recetas validadas)

Usar MCP `execute_sql` con `project_id = hrxfctzncixxqmpfhskv`. Ventana de día en
hora Argentina: `ts_cliente >= 'YYYY-MM-DD 00:00:00-03'`.

**Horas trabajadas + pedidos por legajo (rango de días):**
```sql
with ev as (
  select nullif(trim(legajo),'') legajo,
         (ts_cliente at time zone 'America/Argentina/Buenos_Aires')::date dia,
         opcion, upper(trim(coalesce(texto,''))) tanda, ts_cliente, ts_inicio
  from "Registros_Produccion_Virgilio"
  where ts_cliente >= '2026-05-22 00:00:00-03' and ts_cliente < '2026-05-27 00:00:00-03'),
perday as (
  select legajo, dia, min(ts_cliente) first_ts, max(ts_cliente) last_ts,
    max(ts_cliente) filter (where opcion='FJ') fj_ts,
    coalesce(sum(extract(epoch from (ts_cliente-ts_inicio)))
      filter (where opcion='PC' and ts_inicio is not null and ts_cliente>ts_inicio
              and (ts_cliente-ts_inicio) < interval '8 hours'),0) comida_seg
  from ev where legajo is not null group by legajo, dia)
select legajo, count(*) dias,
  round(sum(extract(epoch from (coalesce(fj_ts,last_ts)-first_ts)) - comida_seg)/3600.0,2) horas
from perday group by legajo order by horas desc;
```

**Pedidos completados por día** (picking = `TP`, armado = `TAP`, distintos):
```sql
select (ts_cliente at time zone 'America/Argentina/Buenos_Aires')::date dia,
  count(distinct upper(trim(texto))) filter (where opcion='TP'  and trim(coalesce(texto,''))<>'') pickeados,
  count(distinct upper(trim(texto))) filter (where opcion='TAP' and trim(coalesce(texto,''))<>'') armados
from "Registros_Produccion_Virgilio"
where ts_cliente >= now() - interval '7 days' group by 1 order by 1;
```

**m³ por SQL:** por defecto **no** se puede (viven en el Sheet, § 7) → mirar el
monitor o exportar. **Desde v2.80**, si la macro ya cargó las tablas `PPP_*`, el m³
**sí** sale por SQL:
```sql
-- m³ por tanda (programación del día) — requiere PPP_Programacion_Diaria cargada
select upper(tanda) tanda, round(sum(m3)::numeric,3) m3
from "PPP_Programacion_Diaria" where coalesce(tanda,'')<>''
group by upper(tanda) order by 1;
-- m³ histórico (entregado) por tanda — PPP_Pedidos_Entregados se borró en v10.25
select upper(tanda) tanda, round(sum(m3)::numeric,3) m3
from "PPP_Entregados_Meta" group by upper(tanda) order by 1;
```

**Notas de datos:** legajos `1` (= "Pruebas") y `0` son test/basura, excluirlos.
Operarios reales vistos recientemente: 104 (Jhonny Moncayo), 237 (Franco Ortiz),
8 (Farias Juan Hilario), 270 (Matias Insaurralde), 260 (Tomas Valdes), 94 (Isidro Tevez).

---

## 12. Reglas de inconsistencia (qué es "correcto" vs anómalo)

Una inconsistencia = lo que el operario registró no condice con cómo debería
operar el sistema. **Implementado (v1.47)** como la pestaña **Inconsistencias**
del monitor: selector de día (hoy + 6 anteriores), severidad **ALTA** (rojo) /
**media** (ámbar), badge con el conteo y auto-refresco cada 20 s. Excluye los
legajos test `0` y `1`. Reglas y umbrales (en `index.html`, sección "HOJA DE
INCONSISTENCIAS"):

**A. Tareas sin cerrar / duración absurda**
- `EP` sin su `TP` (mismo legajo/tanda/día) → picking sin cerrar.
- `AP` sin su `TAP` → armado sin cerrar.
- Toggle abierto sin cerrar al fin del día.
- Cierre con duración disparatada (visto: `TP` hasta ~65 h, `TAP` hasta ~121 h →
  se olvidaron de cerrar). Umbral sugerido: picking/armado > ~6–8 h.

**B. Secuencia inválida**
- `TP` sin `EP` previo / `TAP` sin `AP` previo (mismo legajo/tanda/día).
- Evento de producción con `ts_cliente` posterior al `FJ` del día.
- `FJ` duplicado en el día (no debería: usa upsert determinístico).
- Jornada con actividad pero **sin `FJ`** (día ya cerrado).

**C. Pedido inválido o duplicado**
- Código de tanda/pedido (`texto` de EP/TP/AP/TAP) que **no está en la planilla PPP**
  (la app ya lo detecta: banner "Tandas trabajadas que NO están en PPP — alguien se
  equivocó").
- Misma tanda completada (`TP` o `TAP`) por **dos legajos** distintos el mismo día.

**D. Tiempos anómalos**
- `PC` (comida) muy larga (> ~75 min) o **más de una** por día.
- Hueco de inactividad largo entre eventos (> ~60 min) dentro de la jornada.
- Jornada excesiva (> ~12 h).

---

## 12b. Sistema de alertas (tablero **Agentes** + **Telegram**)

> Construido principalmente 2026-06-27/28 (v4.57→v4.65). **Regla del usuario: todo lo que va por
> Telegram también aparece en Agentes** (Agentes = vista única de "qué mirar").

**Cómo funciona**
- **Telegram (inmediato)**: triggers/cron llaman `tg_enqueue(text, dedup, chat)` → tabla `telegram_outbox`
  → `tg_outbox_flush()` (lee el token de **Vault**, secreto `telegram_bot_token`; envía con pg_net). Chat
  default `-1004379879565`.
- **Agentes (panel, 3×/día)**: cron jobid 14 (`0 11,15,19 * * *` UTC = 08/12/16 AR;
  antes era cada 2 h) corre `generar_reporte_agentes()` +
  `reporte_agentes_recepcion_absurda()` + `reporte_agentes_faltante_articulo()` → llena la tabla
  `reporte_agentes` (DELETE+INSERT). El front (`openAgentesAdmin`/`agtRender`, botón 🤖) la lee; arriba
  muestra el **briefing "📅 Hoy"** (nudge del día + to-do) y el **termómetro de estabilidad** (cuenta
  errores de operario en 7 días: error_envio/picking_sin_stock/carga_sin_control/mg_fuera_lista/error_app).
  Solo se muestran las categorías **con datos** (las vacías no aparecen).

**Las categorías de `reporte_agentes`** (cada una = `categoria`; las con ⚡ también van a
Telegram; la lista canónica del front es el array `CATS` de `agtRender` en `index.html` —
no citar un número fijo acá, queda viejo):

| categoría | qué | fuente | Telegram |
|---|---|---|---|
| `stock_negativo` | saldo imposible | `vista_saldos_stock` | ⚡ `check_stock_anomalias` (cron) |
| `excedente` | guardado a excedente (góndola llena) | `Movimientos_Stock` exc | ⚡ `trg_excedente_telegram` |
| `carga_sin_control` | CCN cargado al camión sin CRN >30 h | `Registros` CCN/CRN | ⚡ `trg_carga_sin_control` (evento CRA) |
| `mg_fuera_lista` | guardó código fuera de "a guardar" | `Registros` MGX | ⚡ `trg_mg_fuera_lista` |
| `picking_sin_stock` | sacó cajas sin stock | `Registros` SSG | ⚡ `trg_picking_sin_stock` |
| `sin_planimetria` | códigos sin sector (picking PSP + recepción RSP) | `Registros` PSP/RSP | ⚡ `trg_sin_planim` / `trg_recepcion_sin_planim` |
| `ppp_error` | errores de la PPP | `Registros` PPE | ⚡ `trg_ppp_error` |
| `falta_facturacion` | TAP sin facturar, entrega hoy/mañana | PPP+TAP+Facturacion_NP | ⚡ `notificar_falta_facturacion` (cron) |
| `recepcion_absurda` | recepción ≤0 o ≫ normal | `Movimientos_Stock` recep | ⚡ `trg_recepcion_absurda` |
| — (sólo Telegram) | recepción **+20% por encima de la OC** vigente | `Registros` ROC | ⚡ `trg_recepcion_excede_oc_telegram` (v7.07) |
| `faltante` | faltantes picking por tanda (7 d, rea<esp) | `Registros` PKC | ⚡ `trg_faltante` |
| `faltante_articulo` | qué artículos faltan más (30 d) — reposición | `Registros` PKC | — |
| `mg_pendiente` | mercadería en a_guardar sin subir a góndola >8 h | `Movimientos_Stock` | — |
| `armado_sin_terminar` | AP sin TAP >24 h | `Registros` AP/TAP | — |
| `pipeline_atascado` | separar_pedidos/a_facturar >2 d (*future*) | `Movimientos_Stock` | — |
| `excedente_estancado` | excedente sin mover >5 d (*future*) | `Movimientos_Stock` | — |
| `oc_baja` | OC <50% recibido | `Ordenes_Compra` | — |
| `error_app` | crashes JS de operarios (7 d) | `errores_cliente` | — |
| `error_envio` | envíos de operarios que fallaron (7 d) | `Auditoria_*` | — |
| `outbox` | Telegram trabado >15 min | `telegram_outbox` | ⚡ `notificar_outbox_salud` (cron) |
| `equivalencia_facturar` | facturar con el código REAL (no el del pedido) — equivalencias | `PPP_Base_Pedidos`+`Equivalencias_Codigos` | ⚡ cron 14 (v5.10) |
| `falta_llego` | llegó un faltante: completá antes de facturar | `Movimientos_Stock`+`Entregas_Virgilio` | ⚡ cron 14 (v4.98) |
| `envio_recuperado` | envíos que fallaron por red pero ENTRARON (info) | `Auditoria_*`+`Registros` | — |
| `rendimiento_anomalo` | m³/h por rol muy bajo/alto (relativo a la mediana o absoluto) | `reporte_agentes_rendimiento_anomalo()` | ⚡ 1×/semana por operario (v4.76) |
| `zona_lista` | una zona juntó ≥1 m³ de pedidos SIN fecha → conviene programarla | `reporte_agentes_zona_lista()` | ⚡ |
| `ppp_sin_zona` | llegó un pedido a la PPP con barrio sin zona asignada | `reporte_agentes_ppp_sin_zona()` | ⚡ |
| `picking_difiere` | el armador marcó «de menos + no hay en góndola» (picking ≠ armado) | `Registros` (v11.x) | — |
| — (sólo Telegram + PPP) | **pedido web anómalo** (score >= 5) | `Alertas_Pedidos_Web` (v8.83) | ⚡ `trg_alerta_pedido_telegram` (trigger INSERT) |

**Para agregar una alerta nueva**: (1) si la detecta el cliente → emitir un evento `Registros` con un
`opcion` nuevo + trigger `notificar_*` que llame `tg_enqueue`; (2) sumar la categoría a
`generar_reporte_agentes` (o a una función auxiliar encadenada en el cron 14 para no re-tipear la grande);
(3) agregar el `key` al array `CATS` de `agtRender` + su CSS `.stk-rep-cat.<key>`. **Siempre las dos vías**.

**Servicio Productividad / "Rendimiento de operarios"** (`prodRender`, v4.67; **desde v7.43 embebido en el
modal 📈 Análisis**): dashboard de ingeniería industrial. **Ya NO es un overlay/botón aparte**: es una
**sección debajo de los gráficos** del modal Análisis (`#analisisProdSection` → `#prodBody`), que carga
`openAnalisis` una vez al abrir. `openProductividad`/`closeProductividad` quedaron como **alias** a
`openAnalisis`/`closeAnalisis`; la CSS de las tarjetas se inyecta con `prodEnsureCss()`. **KPI = m³/h por
rol** (armador/picker, toggle min/m³ con `_prodToggle`/`prodToggleVista`) sobre **tiempo efectivo** (unión
de intervalos), tendencia, sparkline, y **desglose de la jornada** (motivos de la ociosidad: productivo +
secundarias + esperas). No es alerta; es analítica de equipo. (El resto del modal 📈 Análisis — Producción
por día + gráficos Picking/Pedido, que salen del Sheet/eventos — es OTRA cosa y sigue arriba de esta sección.)
**Premios (v4.82, solo esta pantalla admin)**: cada área tiene una **meta m³/h** editable (default Picking
1.6 · Armado 0.7, en `localStorage 'prod_metas'`); el premio % de cada operario = `(ritmo ÷ meta − 1) × 100`
con signo (badges verde/rojo en tarjetas + tabla). No se manda por Telegram. Nota técnica del motor: las
**interrupciones en el medio del envase** (carga, movimiento, comida, etc.) se **restan** del tiempo de la
tanda — se guardan como par open/close y el motor descuenta el `close` (la duración real).

---

## 13. Mantenimiento de esta guía

- **Actualizar este archivo cuando cambie el proyecto**: nuevos códigos de
  `opcion`, cambios de flujo, nuevas tablas/columnas, cambios en el origen de los
  m³, nueva versión, etc.
- Al subir una versión, actualizar `APP_VERSION` y `SW_VERSION` y la línea de
  versión del encabezado de esta guía.
- Si se agrega una pantalla/pestaña (p. ej. la **hoja de inconsistencias**),
  documentarla en § 2 y sus reglas en § 12.

> Nota **2026-08-28 — Hardening de seguridad + candados de facturación (ideas 4297, 9082,
> 3362 + seguridad).** Backend Supabase (todo verificado):
> - **4297** — `arca-wsfe` v26: candado de idempotencia en `emitir_np` (409 `ya_facturada`
>   si la NP ya tiene FC autorizada sin NC que la anule; cuenta FC 1/6/11 − NC 3/8/13).
>   Override `{forzar:true}`. Reconciliada la copia del repo con lo deployado (suma `emitir_nd`).
> - **9082** — trigger `trg_revertir_drenaje_facturado` (AFTER DELETE en `Facturacion_NP`):
>   al revertir una NP sin cierre, borra su drenaje `tipo=facturado` (refs `TANDA|NP` y
>   `NP|CP`) → el stock vuelve y un re-tick re-drena.
> - **3362** — trigger `trg_entregas_virgilio_dedup` (BEFORE INSERT): advisory lock por
>   np|tanda|cod + descarte de duplicado EXACTO (retry offline / TOCTOU no duplican).
> - **Seguridad aplicada:** 1037 (RLS+revoke en `Uni_x_Articulo_x_Caja` y 2 backups),
>   5341 (`usuarios`: anon pierde `password_hash` y escritura; login sigue por
>   `validar_login` definer), 2758 (search_path fijo en 7 funciones), 7240
>   (`ppp_etapa_tanda` a security_invoker), 6932 (grants inertes de `planify.admin_kv/premios`
>   limpiados; ya tenían RLS), 1542 parcial (revoke anon de 4 RPCs de notificación Telegram
>   = anti-spam). Copia versionada en `sql/hardening_seguridad_20260828.sql`.
> - **PENDIENTES de seguridad (apps externas / privilegios):** 8436 (http SSRF — la extensión
>   la posee `supabase_admin`, `postgres` no puede revocar; mover a schema `extensions`),
>   6738 (login Planify ignora password), 2221 (brute-force login texto plano), 1712
>   (enumeración FichadaQR), 4072 (portal proveedores), 1431 (clave prode hardcodeada),
>   5035 (triggers Telegram sin WHEN, eficiencia). Detalle en el .sql.

> Nota **2026-08-28 — Virgilio ↔ Planify: recepción de remito → tarea a Pagos (idea 4041).**
> Pedido del usuario. Al recepcionar un **remito** en Virgilio, se crea una tarea en el
> **Planify del sector Pagos** (`planify.tasks`, `department_id=6`, `assignment_type='department'`,
> `system_generated=true` — mismo patrón que las tareas automáticas de Planify, ej.
> cumpleaños→RRHH). Backend: trigger **`recepcion_crea_tarea_pagos`** (AFTER INSERT) en
> **`Entregas Prov AT`** y **`Entregas Tallerista Virgilio`**. Ambos orígenes; **1 tarea por
> remito** (con o sin factura); solo dispara **si hay `Remito`**. Dedup por marcador oculto
> `[vrec:origen|REMITO|ENTIDAD]` al final de `note` + `pg_advisory_xact_lock` → los N artículos
> del remito generan una sola tarea (no se recrea aunque Pagos ya la haya cerrado). Es el
> primer cruce Virgilio→Planify (ambos schemas viven en el mismo Postgres
> `hrxfctzncixxqmpfhskv`). DDL versionado en `sql/recepcion_tarea_pagos_planify.sql`.

---

## ⚠ EL CASO 809 — tres artículos distintos bajo el mismo número

> Relevado contra datos reales el **2026-08-28**. Es la trampa más cara del proyecto:
> **`809`, `809E LK` y `809E CH` NO son el mismo artículo**. Si se confunden, se pickea
> mal, se factura mal y se compra mal. Leer esto ANTES de tocar cualquier cosa con 809.

### Los tres artículos

| Código en stock | Qué es | Empresa | Dónde está | Saldo (28/08) |
|---|---|---|---|---|
| **`809`** | Corta Queso Alambre **nacional** | Chef | góndola **M16** (cap. 80) | terminado 9 |
| **`809E CH`** | Corta Queso **importado** | Chef | góndola **M13** (cap. 96; M14/M15 también) | terminado 177 · racks 336 · a_facturar 12 · separar 6 |
| **`809E LK`** | **Corta Pizza Familiar** | Loekemeyer | góndola **J13** (cap. 50; J14 también) | terminado 47 · a_facturar 5 |

**El punto que hay que tener grabado:** `809E` de Loekemeyer **no tiene nada que ver** con
el Corta Queso. Es un Corta Pizza Familiar. Mismo número, producto distinto, góndola
distinta, empresa distinta.

### Cómo lo resuelve el sistema

1. **La NP decide la empresa.** `empresaDeNp(np)` (`index.html:7360`): NP > 90000 → `LK`,
   si no → `CH`. Verificado: las NP de Loekemeyer van 97428–98291 y las de Chef
   44389–44547, así que "empieza con 9 / empieza con 4" y "> 90000" son la misma regla.
2. **El pedido trae el código pelado** (`809E`) y el picking lo resuelve a la empresa:
   `codEmpSplit` / `pkCodEmpresa` (`index.html:10200`, `7365`) → `809E LK` o `809E CH`.
   `EMPRESA_SPLIT_CODS = {437E, 438E, 439E, 809E}`.
   ⚠ El **`809` nacional NO entra** en ese split: es Chef-only y su stock se guarda
   **pelado**, sin sufijo.
3. **El nombre también cambia por empresa:** `NOMBRE_POR_EMPRESA`
   (`index.html:10188`) = `{ "809E": { LK: "Corta Pizza Familiar", CH: "Corta Queso" } }`.
   Los coladores 437E/438E/439E son el MISMO producto en las dos empresas → NO van ahí.
4. **Al cruzar contra el pedido se vuelve al código pelado:** `codBase()`
   (`index.html:7387`) saca el sufijo ` LK`/` CH`/` LOKE`, porque faltantes,
   `Entregas_Virgilio` y facturación usan el código que pidió el cliente.
5. **`809` (nacional) y `809E CH` (importado) son familia** — el nacional está
   discontinuándose y se sustituye por el importado. En `EQUIV_FAMILIAS` la familia es
   `def: "809E CH"`, `cods: ["809E CH", "809"]`. El `809E LK` **queda solo, fuera de la
   familia** (es otro producto).
6. **`Equivalencias_Codigos`** manda el pedido pelado al stock correcto:
   `809E → 809E CH`, con la nota *"Corta Queso — el pedido pelado se levanta del stock de
   Chef (planimetría M13). El 809E de Loekemeyer es Corta Pizza Familiar = 809E LK"*.
7. **En la tabla de Stock, "Cajas pedidas" del `809E` se parte por empresa**
   (`porEmpresa`, idea 9020) para no sumar Corta Queso con Corta Pizza. El **generador de
   OCs lo llama SIN ese flag a propósito**, porque cruza contra `OC_Maximos`, que tiene el
   código pelado.

### Volumen real (28/08)

`PPP_Base_Pedidos`: `809E` 81 pedidos / 361 cajas · `809` 4 pedidos / 57 cajas.
`Entregas_Virgilio`: `809E` 62 líneas · `809` 2.

### ⚠ Inconsistencias VIVAS (no resueltas — no las "arregles" sin preguntar)

1. **`Equivalencias_Familia` dice que el principal es `809E` (sin sufijo), el front dice
   `809E CH`.** Por eso el loader de familias (v11.102) **no adopta** esa fila de la tabla:
   si lo hiciera, el código `809` quedaría en dos familias a la vez y `famOf["809"]` sería
   indefinido según el orden de las claves. Hay que decidir cuál de los dos se corrige.
2. **Los nombres se contradicen entre fuentes.** `vista_nombres_articulos` devuelve
   `809E` = *"Corta Pizza Familiar"* (de `E. Madre LK`), mientras `OC_Maximos` tiene
   `809E` = *"Corta Queso X 12"* con línea **CH**. Las dos "tienen razón" según la empresa;
   el nombre plano por código es, para el 809E, **estructuralmente ambiguo**. Por eso
   existe `artNombreEmp(cod, np)`: **nunca** mostrar el nombre del 809E sin la NP.
3. **El picking puede escribir el código equivocado** — es la **idea 8606**, pendiente:
   el pipeline saca el código del evento `PKC` (`texto = tanda|articulo|pedido|pickeado`),
   y cuando el pedido referencia `809` en vez de `809E`, la app escribe `809` sin E ni
   marca. Caso real: `PKC D29A|809|14|14` debía ser `D29A|809E CH|14|14` (ya corregido a
   mano). Mientras 8606 no se haga, un pedido mal cargado arriba se propaga al stock.

### Reglas prácticas

- **Nunca** mostrar ni cruzar un `809E` sin saber la NP.
- **Nunca** sumar `809E LK` + `809E CH`: son productos distintos, no un total.
- El `809` pelado es **Chef nacional**; no lleva sufijo, y no es "el 809E sin la E".
- Antes de tocar equivalencias, familias o planimetría del 809, releer esta sección.

> Nota **2026-08-28 — Normalización PPP aplicada · prode eliminado · watchdog de syncs.**
> - **Normalización al entrar (idea 7411, items 4.3/4.4)** — migración
>   `norm_ppp_np_tanda_articulo_7411`. `fn_norm_tanda` ahora **uppercasea** (antes solo
>   recortaba bordes) y hay 3 triggers BEFORE nuevos: `trg_norm_ppp_base`,
>   `trg_norm_ppp_prog_np`, `trg_norm_ppp_meta_np`. Solo DDL, no tocó datos: las 3 tablas
>   son full-replace, así que el próximo sync las deja limpias.
>   **El motivo real** no era el `.0` (ya no existía: 0 de 11.954 filas, lo arreglaron
>   upstream el Apps Script y el importador): eran **19 filas de `PPP_Base_Pedidos` con
>   `articulo` en minúscula** (943e, 948e, 942e, 838e, 580e, 574e) que el front —que
>   consulta con `codBase()` en mayúscula— **no veía**: 19 NPs y 36 cajas invisibles en
>   "Cajas pedidas", que le faltaban al generador de OCs. Cuando el sync reescriba la
>   tabla, las cajas pedidas de esos códigos **suben**; es dato que estaba escondido.
>   ⚠ En `PPP_Entregados_Meta` NO se quitan ceros a la izquierda a propósito: `np` es PK y
>   colapsar dos np distintos abortaría el INSERT completo del cron.
> - **prode eliminado** (idea 1431 + pedido del dueño): no quedaban tablas ni crons, solo
>   la función huérfana `prode_set_result` —que además apuntaba a una tabla inexistente y
>   tenía la clave de admin hardcodeada con EXECUTE para anon—. Borrada; 0 objetos prode.
> - **`watchdog_syncs_externos()`** (cron `watchdog-syncs-externos`, cada hora a los :23):
>   avisa por Telegram si alguno de los 3 syncs de hojas de Google deja de correr
>   (umbral ≈ 3× su período; dedup un aviso por sync por día). **No se creó tabla
>   `Sync_Estado`**: `cron.job_run_details` ya tiene la verdad. DDL en
>   `sql/watchdog_syncs_externos.sql`.
