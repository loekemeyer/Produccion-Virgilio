/* Regresión v6.23 — Pop-up al entrar a Facturación si quedan faltantes COMPLETABLES.
   A) faltante recuperable (a_guardar>0) → muestra el pop-up con el texto pedido, 1 sola vez.
   B) el botón "cerrar" lo oculta.
   C) sin stock recuperable → NO muestra el pop-up.
   D) recuperable por "guardado hoy" → sí lo muestra.
   Prueba la lógica de disparo (facMaybeRecPopup) + el render del pop-up (facShowRecPopup).
   Sale 1 si falla. */
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
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("file://" + path.join(root, "index.html"), { waitUntil: "domcontentloaded" });

  const r = await p.evaluate(async () => {
    const out = {};
    const ovVisible = function(){ const o = document.getElementById("facRecPopupOv"); return !!(o && o.style.display !== "none"); };
    const msgTxt = function(){ const m = document.getElementById("facRecPopupMsg"); return m ? m.textContent : ""; };
    const setFalt = function(){ _facFalt = new Map([["98114", { cajas: 10, items: [{ cod: "315", falto: 10 }] }]]); };

    // A) recuperable (a_guardar 10) → muestra pop-up, 1 vez
    _facRecPopupShown = false;
    setFalt(); _facSaldosN = { "315": { a_guardar: 10, terminado: 0 } }; _facGuardadoHoy = new Set();
    facMaybeRecPopup([{ np: "98114" }]);
    out.A_visible = ovVisible();
    out.A_texto = /Todavía no completaron los pedidos con lo que llegó hoy/.test(msgTxt());
    out.A_listaNp = /98114/.test((document.getElementById("facRecPopupList") || {}).innerHTML || "");
    out.A_flag = (_facRecPopupShown === true);

    // A2) segundo disparo con el flag ya en true → no re-hace nada (sigue visible, sin error)
    facMaybeRecPopup([{ np: "98114" }]);
    out.A2_sigueUnaVez = ovVisible();

    // B) cerrar lo oculta
    document.getElementById("facRecPopupClose").click();
    out.B_cerrado = !ovVisible();

    // C) sin stock recuperable → no muestra
    _facRecPopupShown = false;
    setFalt(); _facSaldosN = { "315": { a_guardar: 0, terminado: 0 } }; _facGuardadoHoy = new Set();
    facMaybeRecPopup([{ np: "98114" }]);
    out.C_noVisible = !ovVisible();
    out.C_flagFalse = (_facRecPopupShown === false);

    // D) recuperable por "guardado hoy" → sí muestra
    _facRecPopupShown = false;
    setFalt(); _facSaldosN = { "315": { a_guardar: 0, terminado: 0 } }; _facGuardadoHoy = new Set(["315"]);
    facMaybeRecPopup([{ np: "98114" }]);
    out.D_visible = ovVisible();

    return out;
  });

  const pass = r.A_visible && r.A_texto && r.A_listaNp && r.A_flag && r.A2_sigueUnaVez &&
               r.B_cerrado && r.C_noVisible && r.C_flagFalse && r.D_visible && errs.length === 0;
  console.log("fac-rec-popup:", JSON.stringify(r));
  console.log("  pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close();
  process.exit(pass ? 0 : 1);
})();
