/* Regresión — Conteo físico de góndola (solapa Stock y Compras › Conteo).
   Cubre _cntCajas (pilas×cjas/pila + sueltas), cntSet (edición de fila + actualiza
   el total en vivo en el DOM), cntAddRow/cntDelRow (nunca deja la grilla vacía),
   cntCompara (contado vs sistema, dif con signo) y cntGuardar (filtra filas sin
   código/cantidad, postea a Conteo_Stock, resetea la grilla conservando el legajo).
   Sale 1 si falla. */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) { try { ({ chromium } = require("playwright")); } catch (_e2) { console.error("no playwright"); process.exit(2); } }
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("file://" + path.join(__dirname, "..", "index.html"), { waitUntil: "domcontentloaded" });
  const r = await p.evaluate(async () => {
    const out = {};

    // ---- _cntCajas: cálculo puro ----
    out.calc_normal = _cntCajas({ pilas: 3, cxp: 12, sueltas: 4 }) === 40;
    out.calc_vacio = _cntCajas({ pilas: "", cxp: "", sueltas: "" }) === 0;
    out.calc_soloSueltas = _cntCajas({ pilas: "", cxp: "", sueltas: 7 }) === 7;
    out.calc_noNumerico = _cntCajas({ pilas: "abc", cxp: 2, sueltas: 1 }) === 1;   // NaN → 0

    // ---- setup DOM para probar cntSet actualizando el total en vivo ----
    document.body.insertAdjacentHTML("beforeend", '<div id="stkBody"></div>');
    const movs = [
      { cod_art: "500", deposito: "terminado", delta: 30, tipo: "inicial", ts: "2026-08-01T10:00:00Z" },
      { cod_art: "500", deposito: "excedente", delta: 5, tipo: "inicial", ts: "2026-08-01T10:00:00Z" },
      { cod_art: "500", deposito: "separar_pedidos", delta: 8, tipo: "picking", ts: "2026-08-01T10:00:00Z" },
      { cod_art: "600", deposito: "terminado", delta: 12, tipo: "inicial", ts: "2026-08-01T10:00:00Z" }
    ];
    _stk = { movs: movs, cutoff: 0, conteo: { rows: [{ sector: "", cod: "", pilas: "", cxp: "", sueltas: "" }], legajo: "", showComp: false } };
    document.getElementById("stkBody").innerHTML = stkBodyConteo();

    cntSet(0, "cod", "500");
    cntSet(0, "pilas", "2");
    cntSet(0, "cxp", "10");
    cntSet(0, "sueltas", "3");
    out.set_row = JSON.stringify({ cod: _stk.conteo.rows[0].cod, pilas: _stk.conteo.rows[0].pilas, cxp: _stk.conteo.rows[0].cxp, sueltas: _stk.conteo.rows[0].sueltas });
    out.set_domLive = document.getElementById("cntCaj0").textContent === "23";   // 2×10+3, refleja en vivo sin re-render

    // ---- cntAddRow / cntDelRow ----
    cntAddRow();
    out.add_len = _stk.conteo.rows.length === 2;
    cntSet(1, "cod", "600"); cntSet(1, "pilas", "1"); cntSet(1, "cxp", "12"); cntSet(1, "sueltas", "0");
    cntDelRow(1);
    out.del_len = _stk.conteo.rows.length === 1;
    cntDelRow(0);   // borrar la última fila NO debe dejar la grilla en 0 filas
    out.del_nuncaVacio = _stk.conteo.rows.length === 1 && !_stk.conteo.rows[0].cod;

    // ---- cntCompara: contado vs sistema con signo ----
    _stk.conteo.rows = [{ sector: "A1", cod: "500", pilas: 2, cxp: 10, sueltas: 3 }, { sector: "B2", cod: "600", pilas: 1, cxp: 5, sueltas: 0 }];
    cntCompara();
    out.compara_showComp = _stk.conteo.showComp === true;
    const html = stkBodyConteo();
    out.compara_tieneTabla = html.indexOf("Contado vs Sistema") >= 0;
    // 500: contado 23, sistema (terminado 30 + excedente 5) = 35 → dif = 23-35 = -12
    out.compara_dif500 = html.indexOf(">-12<") >= 0;
    // 600: contado 5, sistema (terminado 12) = 12 → dif = 5-12 = -7
    out.compara_dif600 = html.indexOf(">-7<") >= 0;
    // en proceso de 500 (separar_pedidos+a_facturar = 8) debe listarse
    out.compara_enProceso = html.indexOf(">8<") >= 0;

    // ---- cntGuardar: filtra filas sin código/cantidad, postea, resetea conservando legajo ----
    let posted = null, postedUrl = null;
    window.fetch = function (url, opts) { postedUrl = url; try { posted = JSON.parse(opts.body); } catch (_e) {} return Promise.resolve({ ok: true, status: 200 }); };
    let alertMsg = null;
    const origAlert = window.alert; window.alert = function (m) { alertMsg = m; };
    _stk.conteo = { rows: [
      { sector: "A1", cod: "500", pilas: 2, cxp: 10, sueltas: 3 },   // válida → 23
      { sector: "", cod: "", pilas: 1, cxp: 1, sueltas: 1 },          // sin código → descartada
      { sector: "B2", cod: "700", pilas: 0, cxp: 0, sueltas: 0 }      // cajas=0 → descartada
    ], legajo: "122", showComp: true };
    cntGuardar();
    await new Promise(function (res) { setTimeout(res, 30); });
    out.guarda_postUrl = String(postedUrl || "").indexOf("Conteo_Stock") >= 0;
    out.guarda_soloUnaFila = Array.isArray(posted) && posted.length === 1;
    out.guarda_fila = posted && posted[0] ? JSON.stringify({ cod: posted[0].cod, cajas: posted[0].cajas, legajo: posted[0].legajo, sector: posted[0].sector }) : null;
    out.guarda_alertOk = String(alertMsg || "").indexOf("Conteo guardado") >= 0;
    out.guarda_resetRows = _stk.conteo.rows.length === 1 && !_stk.conteo.rows[0].cod;
    out.guarda_conservaLegajo = _stk.conteo.legajo === "122";
    out.guarda_resetShowComp = _stk.conteo.showComp === false;

    // ---- cntGuardar sin filas válidas → alert distinto, no postea ----
    posted = null; alertMsg = null;
    _stk.conteo = { rows: [{ sector: "", cod: "", pilas: "", cxp: "", sueltas: "" }], legajo: "122", showComp: false };
    cntGuardar();
    out.guarda_vacio_noPost = posted === null;
    out.guarda_vacio_alert = String(alertMsg || "").indexOf("No hay filas") >= 0;
    window.alert = origAlert;

    return out;
  });
  const pass = r.calc_normal && r.calc_vacio && r.calc_soloSueltas && r.calc_noNumerico &&
    r.set_domLive && r.add_len && r.del_len && r.del_nuncaVacio &&
    r.compara_showComp && r.compara_tieneTabla && r.compara_dif500 && r.compara_dif600 && r.compara_enProceso &&
    r.guarda_postUrl && r.guarda_soloUnaFila && r.guarda_alertOk && r.guarda_resetRows && r.guarda_conservaLegajo && r.guarda_resetShowComp &&
    r.guarda_vacio_noPost && r.guarda_vacio_alert && errs.length === 0;
  console.log("stk-conteo-fisico:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
