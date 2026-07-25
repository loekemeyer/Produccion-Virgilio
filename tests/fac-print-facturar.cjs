/* Regresión v6.24 — Imprimir el remito NP/Líos al FACTURAR (tic de la operadora).
   A) toggle ON + hay resumen → imprime 1 vez, con NP + líos en la hoja.
   B) segundo llamado misma NP → dedup (no reimprime).
   C) toggle OFF → no imprime.
   D) toggle ON pero NP sin resumen → no imprime.
   E) wiring: facTickNP realmente llama a facPrintRemitoAlFacturar.
   Con remitoPrintDoc stubbeado (no imprime de verdad). Sale 1 si falla. */
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
    // Captura de impresión (sin imprimir de verdad)
    window.__PRINTS = [];
    window.remitoPrintDoc = function (inner) { window.__PRINTS.push(String(inner)); };
    // Resumen de líos por NP (lo que normalmente carga facFetchLios)
    _facResumen = new Map([["98114", "A=505X2;B=520X1"]]);
    try { localStorage.removeItem("ps_fac_printed_virgilio_" + cpTodayAR()); } catch (_e) {}

    // A) toggle ON + resumen → imprime 1 vez con NP + líos
    localStorage.setItem("ps_auto_fac_virgilio", "1");
    facPrintRemitoAlFacturar("98114", "D02A", "771", "Distri Norte", "2026-07-24");
    out.A_imprimio1 = window.__PRINTS.length === 1;
    out.A_tieneNp = /98114/.test(window.__PRINTS[0] || "");
    out.A_tieneLios = /505/.test(window.__PRINTS[0] || "") && /520/.test(window.__PRINTS[0] || "");

    // B) segundo llamado misma NP → dedup
    facPrintRemitoAlFacturar("98114", "D02A", "771", "Distri Norte", "2026-07-24");
    out.B_dedup = window.__PRINTS.length === 1;

    // C) toggle OFF → no imprime
    localStorage.setItem("ps_auto_fac_virgilio", "0");
    _facResumen.set("99999", "A=700X1");
    facPrintRemitoAlFacturar("99999", "C97A", "800", "Otro", "2026-07-24");
    out.C_offNoImprime = window.__PRINTS.length === 1;

    // D) toggle ON pero NP sin resumen → no imprime
    localStorage.setItem("ps_auto_fac_virgilio", "1");
    facPrintRemitoAlFacturar("55555", "C10A", "900", "Sin resumen", "2026-07-24");
    out.D_sinResumen = window.__PRINTS.length === 1;

    // E) wiring: facTickNP llama al helper
    out.E_wiring = /facPrintRemitoAlFacturar\(/.test(window.facTickNP.toString());

    return out;
  });

  const pass = r.A_imprimio1 && r.A_tieneNp && r.A_tieneLios && r.B_dedup &&
               r.C_offNoImprime && r.D_sinResumen && r.E_wiring && errs.length === 0;
  console.log("fac-print-facturar:", JSON.stringify(r));
  console.log("  pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close();
  process.exit(pass ? 0 : 1);
})();
