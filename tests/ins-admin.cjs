/* Regresión v7.31 / idea 5572 — Stock y Compras → solapa "🧰 Insumos" (Administrar
   Insumos). Es el lado admin de la botonera del operario (idea 7917). Contrato:
     · la solapa existe, y arranca por "Pendientes de identificar"
     · pendientes = SOLO los TMP-*, con TODO editable: código (sugerido = el temporal),
       detalle, categoría, ubicación, cantidad y unidad
     · aceptar manda insumo_identificar con código + detalle + categoría + ubicación
     · corregir cantidad/unidad postea ASIENTOS (el log es append-only), no edita
     · no deja identificar dejando el TMP como código
     · sección CATEGORÍAS: nombre/emoji, unidades permitidas, y los insumos adentro
       (con el alta de insumo ahí mismo)
     · los "a depurar" viven DENTRO de pendientes (son lo mismo: esperan decisión)
     · Cantidad y Unidad van en COLUMNAS SEPARADAS y son EDITABLES en TODAS las filas
       (venga de un operario o sea un código viejo)
     · sólo hay dos acciones: Aceptar y Borrar
     · Aceptar contra un código que ya existe SUMA los saldos (netea los negativos)
     · Borrar con saldo lo deja en 0 con un asiento antes de sacarlo del catálogo
     · no se puede dar de alta un código que ya está en uso
     · borrar una categoría exige escribir su nombre exacto
     · sección UNIDADES: el vocabulario de medidas, se agregan y se sacan
     · cada categoría tiene un DETALLE editable (qué entra en el grupo)
     · «a depurar» ya no existe: lo que no tiene categoría es «Sin categoría»
     · tabla final de SÓLO LECTURA con todos los insumos, filtrable, que se actualiza
     · una unidad no permitida por la categoría se rechaza con alerta
     · en el listado de cada categoría se edita código, detalle, categoría, ubicación,
       CANTIDAD y UNIDAD (columnas separadas), y sólo se manda lo que cambió
     · Pendientes / Unidades / Categorías son colapsables; la tabla final no
     · sección HISTORIAL (debajo de Categorías, colapsable): junta los movimientos
       (ingresos/egresos/ajustes, con quién y cuándo) con los cambios de catálogo del
       admin (aceptar/fusionar, borrar, editar, categorías…), ordenados por fecha,
       filtrables por grupo
     · VÍNCULO CON EL OPERARIO: lo que define el admin es lo que ve el operario en
       RI/EI — categorías (nombre y unidades permitidas), insumos y unidades
   Sin red (fetch mockeado). */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("Playwright no encontrado."); process.exit(2); }
}
(async () => {
  const root = path.join(__dirname, "..");
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("file://" + path.join(root, "index.html"), { waitUntil: "domcontentloaded" });

  const r = await p.evaluate(async () => {
    const out = {};
    const rpc = [];
    const movs = [];
    // "la base": lo que el admin define. El test la cambia y comprueba que el operario
    // ve exactamente eso.
    let CATS_DB = [
      { clave: "plastico", nombre: "Plásticos", emoji: "🧪", unidades: ["Bolsas"], orden: 1 },
      { clave: "fleje", nombre: "Flejes y alambres", emoji: "🧵", unidades: ["Kg"], orden: 2 },
      { clave: "importados", nombre: "Importados", emoji: "🌎", unidades: [], orden: 3 },
      { clave: "partes_plasticas", nombre: "Partes plásticas", emoji: "🧩", unidades: [], orden: 4 },
      { clave: "cajas", nombre: "Cajas", emoji: "📦", unidades: ["Paquetes", "Uni"], orden: 5, descripcion: "Cartón y embalaje" },
      { clave: "cajas2", nombre: "Cajas grandes", emoji: "🗃", unidades: [], orden: 6 }
    ];
    let UNIS_DB = ["Uni", "Kg", "Bolsas", "Paquetes", "MC", "Cajas"];
    function J(data) {
      return Promise.resolve({ ok: true, status: 200, headers: { get: function () { return null; } }, json: function () { return Promise.resolve(data); } });
    }
    const CAT = [
      { cod: "22", nombre: "121 X 1,20", categoria: "fleje", ubicacion: "V2 Ad", orden: null, creado_por: "104" },
      { cod: "5", nombre: "38 X 0,55", categoria: "fleje", ubicacion: "R4At", orden: null, creado_por: "104" },
      { cod: "PP", nombre: "POLIPROPILENO", categoria: "plastico", ubicacion: "AF1", orden: null, creado_por: "104" },
      { cod: "TMP-0001", nombre: "Bolsa gris sin etiqueta", categoria: "plastico", ubicacion: null, orden: null, creado_por: "104" },
      { cod: "TMP-0002", nombre: "Alambre finito que trajo Perez", categoria: "", ubicacion: null, orden: null, creado_por: "231" },
      { cod: "505C·CUCHILLA CHINA", nombre: "CUCHILLA CHINA", categoria: null, ubicacion: null, orden: null, creado_por: "104" },
      { cod: "FLEJE ESPIRAL·1", nombre: "1", categoria: null, ubicacion: null, orden: null, creado_por: "104" }
    ];
    // El Historial junta dos fuentes: los movimientos de stock (ingresos/egresos/ajustes)
    // y los cambios de catálogo que registra el admin (Insumos_Historial).
    const MOV_DB = [
      { ts: "2026-08-04T13:00:00-03:00", cod_art: "22", descripcion: "121 X 1,20", delta: -50, tipo: "entrega_insumo", legajo: "231", unidad: "Kg" },
      { ts: "2026-08-04T10:00:00-03:00", cod_art: "PP", descripcion: "POLIPROPILENO", delta: 100, tipo: "recepcion_insumo", legajo: "104", unidad: "Bolsas" }
    ];
    const HIST_DB = [
      { ts: "2026-08-04T12:00:00-03:00", accion: "fusionar", cod: "TMP-0009", cod_nuevo: "9090", detalle: "Fusionado TMP-0009 → 9090 (3 mov)", legajo: "admin", datos: { movs: 3 } },
      { ts: "2026-08-04T11:00:00-03:00", accion: "cat_guardar", cod: "cajas", cod_nuevo: null, detalle: "Categoría «Cajas» actualizada", legajo: "admin", datos: {} }
    ];
    window.fetch = function (url, opt) {
      url = String(url);
      if (url.indexOf("/Movimientos_Stock") >= 0 && opt && String(opt.method || "").toUpperCase() === "POST") {
        try { JSON.parse(opt.body).forEach(function (m) { movs.push(m); }); } catch (_e) {}
        return J({});
      }
      if (url.indexOf("/rpc/") >= 0) {
        let body = null; try { body = JSON.parse(opt.body); } catch (_e) {}
        rpc.push({ fn: url.split("/rpc/")[1].split("?")[0], body: body });
        return J(1);
      }
      // Historial: OJO, va ANTES de "/Insumos" (Insumos_Historial contiene "/Insumos")
      if (url.indexOf("Insumos_Historial") >= 0) return J(HIST_DB);
      if (url.indexOf("/Movimientos_Stock") >= 0) return J(MOV_DB);   // GET (el POST ya se atrapó arriba)
      if (url.indexOf("Insumos_Categorias") >= 0) return J(CATS_DB);
      if (url.indexOf("Insumos_Unidades") >= 0) return J(UNIS_DB.map(function (n, i) { return { nombre: n, orden: i }; }));
      if (url.indexOf("/Insumos") >= 0) return J(CAT);
      if (url.indexOf("vista_saldos_insumos_x_unidad") >= 0) {
        return J([{ cod_art: "TMP-0001", unidad: "Bolsas", saldo: 7 }, { cod_art: "22", unidad: "kg", saldo: 1483.95 },
                  { cod_art: "PP", unidad: "Bolsas", saldo: 50 },
                  { cod_art: "505C·CUCHILLA CHINA", unidad: "Uni", saldo: -16000 }]);
      }
      return J([]);
    };
    let confirmado0 = ""; window.confirm = function (m) { confirmado0 = String(m); return true; };
    let alerted = ""; window.alert = function (m) { alerted = String(m); };

    // Esqueleto del modal (lo arma openStockAdmin; acá lo montamos a mano para no
    // depender de toda la carga de stock).
    const ov = document.createElement("div");
    ov.innerHTML = '<div class="stk-tabs" id="stkTabs"></div><div class="stk-body" id="stkBody"></div>';
    document.body.appendChild(ov);

    // La solapa existe y se puede abrir sin pasar por todo el admin de stock
    _stk = { tab: "insumos", filtro: "", arts: [], soloConteo: false, insLoaded: true };
    stkRender();
    const tabTxt = Array.prototype.map.call(document.querySelectorAll("#stkTabs .stk-tab"), function (e) { return e.textContent.trim(); });
    out.tabs = tabTxt;
    out.hayTabInsumos = tabTxt.some(function (t) { return /Insumos/.test(t); });

    await stkInsLoad();
    const body = function () { return document.getElementById("stkBody").innerHTML; };
    const filas = function (sel) { return document.querySelectorAll(sel).length; };

    // 1) Pendientes primero y con TODO editable
    out.primeraSec = (document.querySelector("#stkBody .stk-sec") || {}).textContent || "";
    out.pendCount = document.querySelectorAll("#stkBody table")[0].querySelectorAll("tbody tr").length;   // 2 TMP + 2 viejos
    out.pendTraeViejos = /505C·CUCHILLA CHINA/.test(document.getElementById("stkBody").innerHTML);
    out.viejoQtyEditable = !!document.getElementById("idQty_505C·CUCHILLA CHINA") && !!document.getElementById("idUni_505C·CUCHILLA CHINA");
    out.pendCodSugerido = (document.getElementById("idCod_TMP-0001") || {}).value;   // "TMP-0001"
    out.pendNombre = (document.getElementById("idNom_TMP-0001") || {}).value;        // lo que escribió
    out.pendCat = (document.getElementById("idCat_TMP-0001") || {}).value;           // la que sugirió
    out.pendUbicEditable = !!document.getElementById("idUbi_TMP-0001");
    out.pendQty = (document.getElementById("idQty_TMP-0001") || {}).value;           // "7"
    out.pendUni = (document.getElementById("idUni_TMP-0001") || {}).value;           // "Bolsas"
    const th = Array.prototype.map.call(document.querySelectorAll("#stkBody table")[0].querySelectorAll("thead th"), function (e) { return e.textContent.trim(); });
    out.colsPend = th.join("|");        // "Código|Detalle|Categoría|Ubicación|Cantidad|Unidad|"
    const acc = document.querySelectorAll("#stkBody table")[0].querySelectorAll("tbody tr")[0].querySelectorAll("button");
    out.acciones = Array.prototype.map.call(acc, function (e) { return e.textContent.trim(); }).join("|");   // "✓ Aceptar|🗑 Borrar"
        out.sinColumnaOrden = !/>Orden</.test(document.getElementById("stkBody").innerHTML);
    out.pendMuestraLegajo = /leg 231/.test(document.getElementById("stkBody").innerHTML);

    // 1b) HISTORIAL: grupo nuevo debajo de Categorías. Arranca colapsado; al abrirlo
    // muestra los movimientos (ingresos/egresos) y los cambios de catálogo, mezclados
    // y ordenados por fecha (lo más nuevo arriba), con quién los hizo.
    out.histColapsadoInicio = !/⬆ Egreso/.test(body());
    stkInsSec("hist");                       // abrir
    out.hayHist = /🧾 Historial/.test(body());
    out.histTieneIngreso = /⬇ Ingreso/.test(body());
    out.histTieneEgreso = /⬆ Egreso/.test(body());
    out.histTieneFusion = /Fusionado/.test(body()) && /TMP-0009/.test(body()) && /9090/.test(body());
    out.histTieneCatGuardar = /Categoría «Cajas» actualizada/.test(body());
    out.histMuestraQuien = /leg 231/.test(body()) && /admin/.test(body());
    // orden: el egreso (13:00) es más nuevo que el ingreso (10:00) → aparece antes
    const histBody = body();
    out.histOrdenado = histBody.indexOf("⬆ Egreso") < histBody.indexOf("⬇ Ingreso");
    // filtro por grupo: "Cambios de catálogo" deja los del admin y oculta los movimientos
    stkInsHistGrupo("cat");
    out.histFiltraCat = /Fusionado/.test(body()) && !/⬆ Egreso/.test(body());
    stkInsHistGrupo("");                     // vuelvo a Todo

    // 2) No deja identificar dejando el temporal como código
    const antesTmp = rpc.length;
    await stkInsAceptar("TMP-0001");
    out.rechazaTmpComoCod = rpc.length === antesTmp && /temporal/i.test(alerted);

    // 3) Identificar manda los 5 campos; corregir cantidad/unidad postea un ASIENTO
    document.getElementById("idCod_TMP-0001").value = "1234567";
    document.getElementById("idNom_TMP-0001").value = "Nylon especial";
    document.getElementById("idUbi_TMP-0001").value = "AF9";
    document.getElementById("idQty_TMP-0001").value = "12";
    // pasa a «fleje», que se carga en Kg: la unidad tiene que ser compatible con la
    // categoría elegida (si no, la bloquea el chequeo del punto 8d)
    document.getElementById("idCat_TMP-0001").value = "fleje";
    document.getElementById("idUni_TMP-0001").value = "Kg";
    await stkInsAceptar("TMP-0001");
    const ident = rpc.filter(function (x) { return x.fn === "insumo_identificar"; })[0];
    out.identCod = ident ? ident.body.p_cod : null;          // "1234567"
    out.identNom = ident ? ident.body.p_nombre : null;       // "Nylon especial"
    out.identCat = ident ? ident.body.p_categoria : null;    // "fleje"
    out.identUbi = ident ? ident.body.p_ubicacion : null;    // "AF9"
    // cambió Bolsas→Kg: saca las 7 Bolsas y pone 12 Kg, con el código TODAVÍA temporal
    out.ajusteN = movs.length;                               // 2
    out.ajusteSaca = movs.length ? (movs[0].delta === -7 && movs[0].unidad === "Bolsas") : false;
    out.ajustePone = movs.length > 1 ? (movs[1].delta === 12 && movs[1].unidad === "Kg") : false;
    out.ajusteSobreTmp = movs.length ? movs[0].cod_art === "TMP-0001" : false;

    // 4) Borrar un TMP sin saldo: sale directo
    await stkInsBorrar("TMP-0002");
    const bo0 = rpc.filter(function (x) { return x.fn === "insumo_borrar" && x.body.p_cod === "TMP-0002"; })[0];
    out.borraTmpSinSaldo = !!bo0;
    // 4a) Borrar algo CON saldo avisa y lo deja en 0 con un asiento antes de borrar
    movs.length = 0;
    await stkInsBorrar("505C·CUCHILLA CHINA");
    out.borrarConSaldoAvisa = /tiene saldo/i.test(confirmado0) && /CERO/i.test(confirmado0);
    out.borrarCerorea = movs.length === 1 && movs[0].delta === 16000 && movs[0].tipo === "ajuste";

    // 4b) Un código viejo CON saldo se FUSIONA contra el real (netea el negativo)
    let confirmado = ""; window.confirm = function (m) { confirmado = String(m); confirmado0 = confirmado; return true; };
    document.getElementById("idCod_505C·CUCHILLA CHINA").value = "22";   // ya existe
    // y de paso le corrijo la cantidad: −16000 → −15000, con la misma unidad
    document.getElementById("idQty_505C·CUCHILLA CHINA").value = "-15000";
    movs.length = 0;
    await stkInsAceptar("505C·CUCHILLA CHINA");
    out.viejoAjusta = movs.length === 1 && movs[0].delta === 1000 && movs[0].cod_art === "505C·CUCHILLA CHINA";
    out.fusionAvisa = /YA EXISTE/.test(confirmado) && /SUMA/.test(confirmado);
    const fus = rpc.filter(function (x) { return x.fn === "insumo_identificar" && x.body.p_tmp === "505C·CUCHILLA CHINA"; })[0];
    out.fusionRpc = !!fus && fus.body.p_cod === "22";
    // 4c) Un código viejo SIN movimientos se borra
    await stkInsBorrar("FLEJE ESPIRAL·1");
    out.borraViejo = rpc.some(function (x) { return x.fn === "insumo_borrar" && x.body.p_cod === "FLEJE ESPIRAL·1"; });
    // 4d) Borrar una categoría exige escribir el nombre exacto
    let pedido = ""; window.prompt = function (m) { pedido = String(m); return "no es"; };
    const antesCat = rpc.length;
    await stkInsCatBorrar("cajas");
    out.catBorrarExigeNombre = rpc.length === antesCat && /escribí el nombre exacto/i.test(pedido) && /TODOS los operarios/.test(pedido);
    window.prompt = function () { return "Cajas"; };
    await stkInsCatBorrar("cajas");
    out.catBorrarConNombre = rpc.some(function (x) { return x.fn === "insumo_cat_borrar" && x.body.p_clave === "cajas"; });

    // 5) CATEGORÍAS: una caja por categoría, con sus unidades permitidas
    const cajas = document.querySelectorAll("#stkBody .stk-catbox");
    out.nCajasCat = cajas.length;                            // 6 categorías, ninguna es «a depurar»
    out.sinDepurar = !/A depurar/.test(document.getElementById("stkBody").innerHTML);
    out.catDetalle = /Cartón y embalaje/.test(document.getElementById("stkBody").innerHTML);
    out.catMuestraUnis = /Unidades permitidas/.test(document.getElementById("stkBody").innerHTML);
    out.catCuentaInsumos = /3 insumos|2 insumos|1 insumo/.test(cajas[0].textContent);

    // 6) El listado de insumos y el alta viven ADENTRO de la categoría
    out.listadoOculto = !document.getElementById("stkBody").innerHTML.match(/Agregar insumo a esta categor/);
    stkInsAbrir("fleje");
    out.listadoAbre = /Agregar insumo a esta categor/.test(document.getElementById("stkBody").innerHTML);
    const tblF = document.querySelectorAll("#stkBody .stk-catlist table");
    out.listadoFleje = tblF.length ? tblF[0].querySelectorAll("tbody tr").length : 0;   // 1 (solo 22; el 5 está en 0)
    out.listadoNoTraePP = tblF.length ? !/POLIPROPILENO/.test(tblF[0].innerHTML) : false;
    // v7.37: un código en 0 (fleje "5", 38 X 0,55) NO se lista en su categoría — no
    // ensucia la vista con lo que quedó neteado / sin stock.
    out.ceroOcultoEnCat = tblF.length ? !/38 X 0,55/.test(tblF[0].innerHTML) : false;
    _stkIns.nuevoEn = "fleje"; stkRender();
    document.getElementById("nvCod").value = "7654321";
    await stkInsAlta("fleje");
    const alta = rpc.filter(function (x) { return x.fn === "insumo_alta"; })[0];
    out.altaEnSuCat = !!alta && alta.body.p_cod === "7654321" && alta.body.p_categoria === "fleje";

    // 7) Editar la categoría: nombre + unidades permitidas
    stkInsEdit("cat:cajas");
    out.catEditAbre = !!document.getElementById("cNom_cajas");
    stkInsCatUni("cajas", "MC");                              // agrega MC a las permitidas
    document.getElementById("cNom_cajas").value = "Cajas y embalaje";
    await stkInsCatGuardar("cajas");
    const cg = rpc.filter(function (x) { return x.fn === "insumo_cat_guardar"; })[0];
    out.catGuardaNombre = cg ? cg.body.p_nombre : null;       // "Cajas y embalaje"
    out.catGuardaUnis = cg ? cg.body.p_unidades.join(",") : null;   // "Paquetes,Uni,MC"

    // 8) UNIDADES: van ARRIBA de Categorías y avisan si están en uso
    const secs = Array.prototype.map.call(document.querySelectorAll("#stkBody .stk-sec"), function (e) { return e.textContent.trim(); });
    out.ordenSecciones = secs.join("|");   // Pendientes | Unidades | Categorías
    out.haySecUnidades = /Unidades con las que trabajamos/.test(document.getElementById("stkBody").innerHTML);
    await stkInsUniSacar("Bolsas");        // la usa la categoría Plásticos y un insumo con saldo
    out.uniUsadaAvisa = /EST[ÁA] EN USO/.test(confirmado0) && /Plásticos/.test(confirmado0) && /Insumos con saldo/.test(confirmado0);
    const us = rpc.filter(function (x) { return x.fn === "insumo_unidad_guardar"; })[0];
    out.uniSacar = us ? (us.body.p_nombre === "Bolsas" && us.body.p_activa === false) : false;
    await stkInsUniSacar("Cajas");         // no la usa nadie
    out.uniLibreNoAvisa = !/EST[ÁA] EN USO/.test(confirmado0);

    // 8b) No se puede dar de alta un código que ya está en uso
    _stkIns.nuevoEn = "fleje"; stkRender();
    document.getElementById("nvCod").value = "22";
    const antesAlta = rpc.length;
    await stkInsAlta("fleje");
    out.altaRechazaDuplicado = rpc.length === antesAlta && /ya está en uso/i.test(alerted);

    // 8b2) Secciones colapsables (v7.33: "Todos los insumos" también es plegable)
    out.hayBotonesSec = document.querySelectorAll("#stkBody .stk-secbtn").length;   // 5 (Pendientes, Unidades, Categorías, Historial, Todos)
    stkInsSec("todos");   // v7.33: la tabla final también se pliega
    out.todosColapsa = !/Sólo lectura: la foto completa/.test(document.getElementById("stkBody").innerHTML);
    stkInsSec("todos");   // reabrir para el resto de los chequeos
    stkInsSec("pend");
    out.pendColapsa = document.querySelectorAll("#stkBody table")[0] &&
      !document.getElementById("idCod_TMP-0001");
    stkInsSec("pend");
    out.pendVuelve = !!document.getElementById("idCod_TMP-0001");

    // 8c) TABLA FINAL de sólo lectura, filtrable, y se actualiza con los cambios
    const tablas = document.querySelectorAll("#stkBody table");
    const tot = tablas[tablas.length - 1];
    out.hayTablaTotal = /Todos los insumos/.test(document.getElementById("stkBody").innerHTML);
    out.totalCols = Array.prototype.map.call(tot.querySelectorAll("thead tr")[0].querySelectorAll("th"), function (e) { return e.textContent.trim(); }).join("|");
    out.totalFilas = tot.querySelectorAll("tbody tr").length;
    // v7.37: el 0-code oculto de la categoría SIGUE en «Todos los insumos», con su unidad
    // de categoría (Kg) en vez de "—" (fallback de v7.34). Nada se pierde.
    const tr5Todos = Array.prototype.filter.call(tot.querySelectorAll("tbody tr"), function (tr) { return /38 X 0,55/.test(tr.textContent); })[0];
    out.ceroEnTodosConUni = !!tr5Todos && /Kg/.test(tr5Todos.querySelectorAll("td")[5].textContent);
    // v7.82: la tabla de «Todos los insumos» tiene botón Editar en cada fila (editor
    // de cantidad inline). Sin editar no hay inputs en tbody (sólo botones).
    out.totalTieneEditar = !!tot.querySelector("tbody button") && /Editar/.test(tot.querySelector("tbody button").textContent);
    out.totalSinEditarInline = !tot.querySelector("tbody input") && !tot.querySelector("tbody select");
    // Click en Editar de la fila del código 5 (38 X 0,55, en 0): aparecen inputs
    const btnEd5 = Array.prototype.filter.call(tot.querySelectorAll("tbody button"), function (b) { return b.textContent === "Editar" && b.closest("tr").textContent.indexOf("38 X 0,55") >= 0; })[0];
    if (btnEd5) btnEd5.click();
    const tot2 = document.querySelectorAll("#stkBody table"); const totAfter = tot2[tot2.length - 1];
    out.totalEditAbreInputs = !!totAfter.querySelector("tbody input#edQty_5");
    out.totalEditAbreGuardar = !!totAfter.querySelector("tbody button") && /Guardar/.test(totAfter.innerHTML);
    // idea 8628: los botones Guardar/Cancelar de la fila en edición van en un contenedor
    // nowrap (no se apilan en 2 líneas y agrandan la fila en mobile).
    const _accCell5 = totAfter.querySelector("tbody input#edQty_5") ? totAfter.querySelector("tbody input#edQty_5").closest("tr").querySelector("td:last-child") : null;
    out.totalEditBtnsNowrap = !!_accCell5 && /white-space:\s*nowrap/.test(_accCell5.innerHTML) && _accCell5.querySelectorAll("button").length === 2;
    // Cancelar vuelve al modo lectura
    const btnCancel = Array.prototype.filter.call(totAfter.querySelectorAll("tbody button"), function (b) { return b.textContent === "Cancelar"; })[0];
    if (btnCancel) btnCancel.click();
    const tot3 = document.querySelectorAll("#stkBody table"); const totAfter2 = tot3[tot3.length - 1];
    out.totalEditCancela = !totAfter2.querySelector("tbody input#edQty_5");
    // v7.82 bug-fix: ejercitar el flujo completo de Guardar desde "Todos" en un código
    // con stock 0 (código 5, fleje, sin saldo en la vista). El POST tiene que llegar.
    stkInsEdit("art:5");                                       // abrir editor
    var preMovs = movs.length;
    alerted = "";
    var eQ = document.getElementById("edQty_5");
    if (eQ) eQ.value = "666";
    await stkInsGuardar("5");
    out.totalGuardaPostea = movs.length > preMovs;
    out.totalGuardaDelta = movs.length > preMovs ? movs[movs.length - 1].delta : null;
    out.totalGuardaUni = movs.length > preMovs ? movs[movs.length - 1].unidad : null;
    out.totalGuardaCod = movs.length > preMovs ? movs[movs.length - 1].cod_art : null;
    out.totalGuardaMsg = _stkIns.msg || "";
    out.totalGuardaAlert = alerted;
    out.totalHayFiltros = !!tot.querySelector("thead tr.stk-filtros input");
    stkInsFiltro("cod", "22");
    const tablas2 = document.querySelectorAll("#stkBody table");
    out.totalFiltraCod = tablas2[tablas2.length - 1].querySelectorAll("tbody tr").length;   // 1
    stkInsFiltro("cod", ""); stkInsFiltro("cat", "?");
    const tablas3 = document.querySelectorAll("#stkBody table");
    out.totalFiltraSinCat = tablas3[tablas3.length - 1].querySelectorAll("tbody tr").length;
    stkInsFiltro("cat", "");
    // se actualiza sola: cambio el nombre de un insumo y la tabla lo refleja
    CAT[0].nombre = "RENOMBRADO DESDE ARRIBA";
    await stkInsRefresh(); stkRender();
    const tablas4 = document.querySelectorAll("#stkBody table");
    out.totalSeActualiza = /RENOMBRADO DESDE ARRIBA/.test(tablas4[tablas4.length - 1].innerHTML);

    // 8d) Unidad no permitida por la categoría → alerta y no manda
    _stkIns.abierta = ""; stkRender();
    const antesUni = rpc.length; alerted = "";
    document.getElementById("idCod_TMP-0002").value = "9998887";
    document.getElementById("idCat_TMP-0002").value = "cajas";      // permite Paquetes/Uni
    document.getElementById("idUni_TMP-0002").value = "Kg";         // no permitida
    await stkInsAceptar("TMP-0002");
    out.uniProhibidaBloquea = rpc.length === antesUni && /no permitida/i.test(alerted) && /Paquetes/.test(alerted);

    // 9) VÍNCULO CON EL OPERARIO — el modal de RI/EI lee las MISMAS tablas.
    //    Se prueba con una categoría y una unidad que NO están en el fallback
    //    hardcodeado: si el operario las muestra, es porque salieron de la base.
    CATS_DB = [
      { clave: "etiquetas", nombre: "Etiquetas y sunchos", emoji: "🏷", unidades: ["Rollos"], orden: 1 },
      { clave: "fleje", nombre: "Flejes RENOMBRADO", emoji: "🧵", unidades: ["Kg"], orden: 2 },
      { clave: "cajas2", nombre: "Cajas grandes", emoji: "🗃", unidades: [], orden: 6 }
    ];
    UNIS_DB = ["Rollos", "Kg"];
    CAT.push({ cod: "ET1", nombre: "Etiqueta chica", categoria: "etiquetas", ubicacion: null, creado_por: "104" });
    await showInsumoModal("RI", "104");
    const catsOp = Array.prototype.map.call(document.querySelectorAll("#insBody .ins-catbtn:not(.add)"), function (e) { return e.textContent.replace(/\s+/g, " ").trim(); });
    out.opVeCatsDelAdmin = catsOp.join("|");        // "🏷Etiquetas y sunchos 1|🧵Flejes RENOMBRADO 2|🗑A depurar 2"
    out.opVeCatNueva = catsOp.some(function (t) { return /Etiquetas y sunchos/.test(t); });
    out.opVeRenombrada = catsOp.some(function (t) { return /Flejes RENOMBRADO/.test(t); });
    // el insumo que el admin puso en esa categoría aparece adentro
    insSetCat("etiquetas");
    out.opVeInsumoDeLaCat = /Etiqueta chica/.test(document.getElementById("insBody").innerHTML);
    // la unidad permitida de la categoría es la que se preselecciona
    out.opUniDeLaCat = (_ins.items.filter(function (i) { return i.cod === "ET1"; })[0] || {}).unidad;   // "Rollos"
    // y al sugerir un insumo nuevo ve esas mismas categorías y unidades
    insNuevoOpen("");
    const uniAlta = Array.prototype.map.call(document.querySelectorAll("#insBody .ins-uchip"), function (e) { return e.textContent.trim(); });
    // sin categoría elegida ofrece TODAS las activas; al elegir una con unidad fija,
    // sólo la de ella
    out.opAltaUnidades = uniAlta.filter(function (u) { return u !== "+"; }).join(",");   // "Rollos,Kg"
    insNuevoPick("cat", "etiquetas");
    out.opAltaUniDeLaCat = Array.prototype.map.call(document.querySelectorAll("#insBody .ins-uchip"), function (e) { return e.textContent.trim(); })
      .filter(function (u) { return u !== "+"; }).join(",");                              // "Rollos"
    out.opAltaCats = Array.prototype.map.call(document.querySelectorAll("#insBody .ins-cchip"), function (e) { return e.textContent.trim(); }).join("|");
    return out;
  });

  const pass =
    r.hayTabInsumos === true && /Pendientes de identificar/.test(r.primeraSec || "") &&
    r.pendCount === 4 && /Código\|Detalle\|Categoría\|Ubicación\|Cantidad\|Unidad/.test(r.colsPend || "") && r.acciones === "✓ Aceptar|🗑 Borrar" && r.pendTraeViejos === true && r.viejoQtyEditable === true && r.viejoAjusta === true &&
    r.fusionAvisa === true && r.fusionRpc === true &&
    r.borraViejo === true && r.catBorrarExigeNombre === true && r.catBorrarConNombre === true && r.pendCodSugerido === "TMP-0001" && r.pendNombre === "Bolsa gris sin etiqueta" &&
    r.pendCat === "plastico" && r.pendUbicEditable === true && r.pendQty === "7" && r.pendUni === "Bolsas" &&
    r.sinColumnaOrden === true && r.pendMuestraLegajo === true &&
    r.rechazaTmpComoCod === true &&
    r.identCod === "1234567" && r.identNom === "Nylon especial" && r.identCat === "fleje" && r.identUbi === "AF9" &&
    r.ajusteN === 2 && r.ajusteSaca === true && r.ajustePone === true && r.ajusteSobreTmp === true &&
    r.borraTmpSinSaldo === true && r.borrarConSaldoAvisa === true && r.borrarCerorea === true &&
    r.nCajasCat === 6 && r.sinDepurar === true && r.catDetalle === true && r.catMuestraUnis === true &&
    r.listadoOculto === true && r.listadoAbre === true && r.listadoFleje === 1 && r.listadoNoTraePP === true &&
    r.ceroOcultoEnCat === true && r.ceroEnTodosConUni === true &&
    r.altaEnSuCat === true &&
    r.catEditAbre === true && r.catGuardaNombre === "Cajas y embalaje" && r.catGuardaUnis === "Paquetes,Uni,MC" &&
    r.haySecUnidades === true && r.uniSacar === true && r.uniUsadaAvisa === true && r.uniLibreNoAvisa === true &&
    /Pendientes.*\|.*Unidades.*\|.*Categorías/.test(r.ordenSecciones || "") && r.altaRechazaDuplicado === true &&
    r.hayBotonesSec === 5 && r.todosColapsa === true && r.pendColapsa === true && r.pendVuelve === true &&
    r.histColapsadoInicio === true && r.hayHist === true && r.histTieneIngreso === true && r.histTieneEgreso === true &&
    r.histTieneFusion === true && r.histTieneCatGuardar === true && r.histMuestraQuien === true &&
    r.histOrdenado === true && r.histFiltraCat === true &&
    r.hayTablaTotal === true && /Código\|Detalle\|Categoría\|Rack \/ sector\|Cantidad\|Unidad/.test(r.totalCols || "") &&
    r.totalTieneEditar === true && r.totalSinEditarInline === true &&
    r.totalEditAbreInputs === true && r.totalEditAbreGuardar === true && r.totalEditBtnsNowrap === true && r.totalEditCancela === true &&
    r.totalGuardaPostea === true && r.totalGuardaDelta === 666 && r.totalGuardaUni === "Kg" && r.totalGuardaCod === "5" &&
    r.totalHayFiltros === true && r.totalFiltraCod === 1 &&
    r.totalFiltraSinCat >= 1 && r.totalSeActualiza === true && r.uniProhibidaBloquea === true &&
    r.opVeCatNueva === true && r.opVeRenombrada === true && r.opVeInsumoDeLaCat === true &&
    r.opUniDeLaCat === "Rollos" && r.opAltaUnidades === "Rollos,Kg" && r.opAltaUniDeLaCat === "Rollos" &&
    /Etiquetas y sunchos/.test(r.opAltaCats || "") && /Flejes RENOMBRADO/.test(r.opAltaCats || "") &&
    errs.length === 0;
  console.log("ins-admin:", JSON.stringify(r));
  console.log("  pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close();
  process.exit(pass ? 0 : 1);
})();
