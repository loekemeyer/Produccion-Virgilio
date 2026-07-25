/* Regresión v6.24/v6.25 — Imprimir el remito NP/Líos al FACTURAR (tic de la operadora),
   NUNCA antes, y con la composición del TAL MÁS RECIENTE (refleja faltantes ya
   completados por CP después del armado).
   A) toggle ON → imprime 1 vez, usando el ÚLTIMO TAL (trae el lío nuevo 520 que NO
      está en el _facResumen viejo → prueba que no imprime la versión vieja).
   B) segundo llamado misma NP → dedup.
   C) toggle OFF → no imprime.
   D) NP sin TAL ni resumen → no imprime.
   E) fallback: si el fetch no trae nada, usa _facResumen ya cargado.
   F) wiring: facTickNP llama a facPrintRemitoAlFacturar.
   Con fetch/remitoPrintDoc stubbeados. Sale 1 si falla. */
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
    window.__PRINTS = [];
    window.remitoPrintDoc = function (inner) { window.__PRINTS.push(String(inner)); };
    function J(data) { return Promise.resolve({ ok: true, status: 200, headers: { get: function () { return null; } }, json: function () { return Promise.resolve(data); } }); }

    // TAL más reciente por NP (lo que devuelve el fetch al facturar).
    const TAL_LATEST = { "98114": "98114|2|D02A|A=505X2;B=520X1" };   // ya completado: 2 cajas + lío 520 nuevo
    window.fetch = function (url) {
      url = String(url);
      if (url.indexOf("opcion=eq.TAL") >= 0) {
        let found = [];
        Object.keys(TAL_LATEST).forEach(function (k) { if (url.indexOf(k) >= 0 && TAL_LATEST[k] != null) found = [{ texto: TAL_LATEST[k] }]; });
        return J(found);
      }
      return J([]);
    };
    // _facResumen VIEJO (antes de completar el faltante: solo 505X1, sin 520).
    _facResumen = new Map([["98114", "A=505X1"], ["77777", "A=999X1"]]);
    try { localStorage.removeItem("ps_fac_printed_virgilio_" + cpTodayAR()); } catch (_e) {}

    // A) toggle ON → imprime con el ÚLTIMO TAL (contiene 520, que NO está en el viejo)
    localStorage.setItem("ps_auto_fac_virgilio", "1");
    await facPrintRemitoAlFacturar("98114", "D02A", "771", "Distri Norte", "2026-07-24");
    out.A_imprimio1 = window.__PRINTS.length === 1;
    out.A_tieneNp = /98114/.test(window.__PRINTS[0] || "");
    out.A_usaUltimoTAL = /520/.test(window.__PRINTS[0] || "");   // el lío nuevo (completado) está

    // B) dedup
    await facPrintRemitoAlFacturar("98114", "D02A", "771", "Distri Norte", "2026-07-24");
    out.B_dedup = window.__PRINTS.length === 1;

    // C) toggle OFF → no imprime
    localStorage.setItem("ps_auto_fac_virgilio", "0");
    TAL_LATEST["99999"] = "99999|1|C97A|A=700X1";
    await facPrintRemitoAlFacturar("99999", "C97A", "800", "Otro", "2026-07-24");
    out.C_offNoImprime = window.__PRINTS.length === 1;

    // D) NP sin TAL ni resumen → no imprime
    localStorage.setItem("ps_auto_fac_virgilio", "1");
    await facPrintRemitoAlFacturar("55555", "C10A", "900", "Sin nada", "2026-07-24");
    out.D_sinResumen = window.__PRINTS.length === 1;

    // E) fallback: 77777 no está en el fetch (devuelve []) → usa _facResumen (999)
    await facPrintRemitoAlFacturar("77777", "C11A", "901", "Fallback", "2026-07-24");
    out.E_fallback = window.__PRINTS.length === 2 && /999/.test(window.__PRINTS[1] || "");

    // F) wiring
    out.F_wiring = /facPrintRemitoAlFacturar\(/.test(window.facTickNP.toString());

    return out;
  });

  const pass = r.A_imprimio1 && r.A_tieneNp && r.A_usaUltimoTAL && r.B_dedup &&
               r.C_offNoImprime && r.D_sinResumen && r.E_fallback && r.F_wiring && errs.length === 0;
  console.log("fac-print-facturar:", JSON.stringify(r));
  console.log("  pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close();
  process.exit(pass ? 0 : 1);
})();
