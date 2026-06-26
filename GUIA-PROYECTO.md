# Guía del Proyecto — Producción Virgilio

> Guía viva de referencia. Documenta **cómo funciona el programa** y **de dónde
> salen los datos**, para poder responder preguntas con precisión y sin inventar.
> **Mantener actualizada en cada cambio del proyecto** (ver § "Mantenimiento").
>
> Última actualización: 2026-06-26 · Versión app al documentar: **v3.99**
>
> Nota: **2026-06-26 (config, sin bump)** — **Alertas Telegram → grupo en vez de chat personal**
> (pedido del usuario). Las **3** funciones que avisan por `@Faltantes_Virgilio_bot`
> (`notificar_faltante_telegram` = faltantes/PKC, `notificar_sin_planimetria_telegram` = PSP,
> `notificar_carga_sin_control_telegram` = CRA) tenían el `chat_id` fijo `6282395816` (un chat
> **personal**); ahora apuntan al **supergrupo** `-1004379879565` ("Faltantes Virgilio"), así reciben
> **todos** los del grupo. Cambio 100% en Supabase (DDL `CREATE OR REPLACE FUNCTION`, migraciones
> `telegram_alertas_a_grupo` → `telegram_alertas_a_grupo_supergrupo`), nada en el repo. Probado con un
> evento `PKC` de prueba (legajo 0) → Telegram respondió `200 ok`. ⚠ El `bot_token` y el `chat_id` están
> **hardcodeados** dentro de cada función. ⚠ **Ojo con el id**: el grupo nació como básico (`-5438870268`)
> y al convertirse en **supergrupo** el id pasó a formato `-100…` (`-1004379879565`); Telegram avisa con
> `400 … migrate_to_chat_id` cuando pasa. El sandbox **no puede leer `api.telegram.org`** (bloqueado por
> egress, como Google), pero **los triggers sí** (corren en Supabase): para verificar un envío, mirar
> `net._http_response` (status 200 = ok). El id del grupo se saca desde el navegador con `…/getUpdates`
> o un bot de id.
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
> `SURVIVING_TOGGLES` (`["CR","RR","MG"]`), `TOGGLE_CODES`, `NEVER_INPUT`, `INC_TOGGLE`/`INC_DESC`
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
- Branch de desarrollo actual: **`claude/fix-virgilio-production-GoGCS`**.
- **Play Store**: la PWA se publica como **TWA** (envoltorio Android que abre la
  web a pantalla completa). Cómo generar el `.aab` y publicar: ver
  **`PLAY-STORE.md`**. Config en `twa-manifest.json`; íconos PNG en `icons/`;
  Digital Asset Links en `.well-known/assetlinks.json` (¡va en la raíz del
  origen, no bajo `/Produccion-Virgilio/`!).

---

## 1. Archivos del repo

| Archivo | Rol |
|---|---|
| `index.html` | **La app completa** (~6.600 líneas): pantalla de operario + monitor + toda la lógica JS/CSS. Es el archivo central. |
| `sw.js` | Service Worker. **NO cachea HTML/assets**: sólo hace Background Sync de la cola offline (IndexedDB). `SW_VERSION = "v3.47-vir"`. |
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
  - **Supervisor** (emails en `SUPERVISOR_EMAILS`: `loekemeyer.n8n@gmail.com`,
    `loekemeyer.logistica@gmail.com`): ve `#supervisorPanel` con **4 botones grandes
    centrados** (📊 Monitor de operarios, 📋 Facturación, ⚠ Inconsistencias,
    📈 Análisis de productividad). No necesita estar en `Empleados` ni tiene legajo.
    (Los antiguos botones flotantes de abajo se eliminaron.)
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
`ts_cliente`, `client_id`, `user_agent`, `ip_hint`, `created_at`. (Hoy está
**muy poco usada** — pocos registros — porque el QR in-app está deshabilitado; ver § 9.)

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
- **`PPP_Pedidos_Entregados`** ← hoja "PPP Excel Pedidos Entregados 2026" (m³
  histórico). Cols: `tanda`, `mt3` (numeric, col Mt3 — NO "Mt3 FC").
- **`PPP_Base_Pedidos`** ← hoja "PPP Excel Base Datos Pedidos". Una fila por línea.
  Cols: `pedido`, `articulo`, `cajas` (numeric).

Las escribe el **Apps Script** (`handleCargaPPPSync_`, el que ya escribe las hojas)
con la `service_role` key del proyecto Virgilio (bypassa RLS); ⚠ las props Supabase
que ya tiene ese script apuntan a OTRO proyecto (`kwkclwhmoygunqmlegrg`, la web), por
eso el hook usa props nuevas `SUPABASE_VIRGILIO_*`. La app sólo las **lee** (RLS
`select` para `anon`/`authenticated`). DDL en `sql/ppp_supabase.sql`; hook en
`apps-script/sync-ppp-supabase.gs`; diseño en `MIGRACION-SUPABASE-PPP.md`.

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

---

## 4. Códigos de acción (`opcion`)

Definidos en `index.html` (objeto `desc`, ~línea 1531). Los botones se arman en
3 filas:

| Código | Descripción | Grupo | ¿Captura `texto`? |
|---|---|---|---|
| `EP` | Empecé Picking | CORE (inicio) | Sí — código de tanda (ej. `A12B`) |
| `TP` | Fin Picking | CORE (cierre) | Sí — código de tanda |
| `AP` | Empecé Armado Pedido | CORE (inicio) | Sí — código de pedido |
| `TAP` | Terminé Armado Pedido | CORE (cierre) | Sí — código de pedido |
| `CR` | Control Remitos | TOGGLE | Sí — abre **popup de control de facturados** (`showControlRemitosCR`, v3.69): lista de facturados del reparto + Líos + tic **Controlado** → `CCR` por NP + cierra el toggle. (Fue toggle plano sin popup en v3.43–v3.68.) |
| `RR` | Recepción Remitos | TOGGLE | Abre el popup de descarga (tabla NP cargados → tildar Controlado → «Terminé» = `CRN` por NP); desde v3.43 lleva la lógica que antes tenía `CR`. **v3.75+**: además hay un botón **"Recepción Remitos (RR)"** en Administración (`openRemitosAdmin` → `showControlRemitos("0", true)`) que abre la **MISMA lista** en modo admin (legajo `0`, sin cerrar toggle). Lo controlan operarios **y** admin. (v3.76 lo había sacado de los operarios; revertido en v3.77.) |
| `CC` | Inicio/Fin Carga Camión | TOGGLE | Sí, al cerrar (Nro) |
| `RT` | Recepción Mercadería | TOGGLE | Sí, al cerrar: `texto` = cantidad de cajas, **calculada sola** del Modo OP de Recepción (suma del día en `localStorage`, ver v2.61). Al abrir RT se lanza el Modo OP (`recepcion.js`). |
| `MG` | Guardado a Góndola | TOGGLE | No |
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

**Grupos (constantes en `index.html`):**
- `CORE_CODES = [EP, TP, AP, TAP]` — el trabajo medible (picking / armado).
- `TOGGLE_CODES = [CR, RR, CC, RT, MG, RI, EI, AT, PB, Limp, PC, Perm, CT]` — abren y cierran.
- `DEAD_TIME_CODES = [AT, PB, Limp, PC, CT]` — mientras están abiertos **bloquean todo**.
- `ALWAYS_ALLOWED_CODES = [PB, PC]` — nunca se bloquean.
- `CLOSE_NEEDS_INPUT_CODES = [CC, RT, RI, EI]` — piden dato al cerrar.
- `SURVIVING_TOGGLES = [CR, RR, MG]` — sobreviven la medianoche; el resto se autocierra.
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

> **CRÍTICO (por defecto): los m³ NO están en Supabase.** Salen de un **Google
> Sheet**, así que no se pueden calcular desde un entorno sin acceso a Google
> (p. ej. el sandbox de Claude, que tiene Google fuera de la allowlist). La **app
> sí** los muestra porque corre en el navegador.
>
> **v2.80** prepara moverlos a Supabase (tablas `PPP_*`, flag `PPP_SOURCE`): una
> vez que la macro las cargó y el flag está activo, **el m³ se consulta por SQL**
> (§ 11). Ver `MIGRACION-SUPABASE-PPP.md`.

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
  `PPP_Programacion_Diaria.m3` / `PPP_Pedidos_Entregados.mt3` (numérico) en vez del
  Sheet → **se puede calcular por SQL** (§ 11). Por defecto sigue saliendo del Sheet;
  la carga la hace la macro (ver `MIGRACION-SUPABASE-PPP.md`).

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
  `Fichadas_Virgilio` (`tipo:"ingreso"`) + espejo a `Fichadas_Historico`
  (`evento:"Entrada"`). El legajo se resuelve por email contra `Empleados`; si el email
  no está cargado, igual ficha con `legajo=null` y el monitor lo marca "sin legajo".
  Flujo verificado: RLS deja al rol `anon` insertar en ambas tablas.
- `PC` y `FJ` se mandan desde la app principal y se espejan a `Fichadas_Historico`
  (`FJ→"Salida"`, `PC` abre→`"Comida Inicia"`, `PC` cierra→`"Comida Termina"`).

---

## 10. Versionado y cache

- `index.html`: `APP_VERSION = "v3.51"`. Badge en pantalla `#versionBadge`:
  `"v3.51 ✓"` (sin cola), `"v3.51 ⏳ N"` (pendientes), `"v3.51 ⚠ N"` (error).
  **Sirve para confirmar qué versión cargó cada pantalla** (mirá el badge en la TV
  para saber si está al día).
- `sw.js`: `SW_VERSION = "v3.47-vir"`. **No precachea nada**; el handler de `fetch`
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
-- m³ histórico por tanda
select upper(tanda) tanda, round(sum(mt3)::numeric,3) m3
from "PPP_Pedidos_Entregados" group by upper(tanda) order by 1;
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

## 13. Mantenimiento de esta guía

- **Actualizar este archivo cuando cambie el proyecto**: nuevos códigos de
  `opcion`, cambios de flujo, nuevas tablas/columnas, cambios en el origen de los
  m³, nueva versión, etc.
- Al subir una versión, actualizar `APP_VERSION` y `SW_VERSION` y la línea de
  versión del encabezado de esta guía.
- Si se agrega una pantalla/pestaña (p. ej. la **hoja de inconsistencias**),
  documentarla en § 2 y sus reglas en § 12.
