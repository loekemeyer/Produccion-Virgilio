/* Test de regresión (v6.91): el botón "⚠ Negativos" del módulo de Stock filtra la
   tabla a los artículos con saldo < 0 en algún depósito. Un negativo es imposible
   físicamente (siempre es un error de carga o del pipeline), así que tiene que poder
   listarse sin barrer columna por columna.
   Fixture: 4 artículos — uno negativo en góndola, uno negativo en Pickeados (el caso
   real 957E/D14B), uno positivo y uno en cero. Cubre: el conteo del botón, que el
   filtro deje SOLO los negativos, que prenderlo limpie la búsqueda de texto (si no,
   la intersección puede dar vacío y parece que no hay negativos), y que apagarlo
   devuelva la tabla completa. Sale 1 si falla. */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("Playwright no encontrado (ver tests/smoke.cjs)."); process.exit(2); }
}
(async () => {
  const root = path.join(__dirname, "..");
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("file://" + path.join(root, "index.html"), { waitUntil: "domcontentloaded" });
  const r = await p.evaluate(async () => {
    const MOVS = [
      // 100: góndola negativa (se pickeó más de lo que había)
      { cod_art: "100", descripcion: "Neg góndola", deposito: "terminado", delta: 3, tipo: "inicial", ts: "2026-06-30T00:00:00Z" },
      { cod_art: "100", descripcion: "Neg góndola", deposito: "terminado", delta: -5, tipo: "picking", ts: "2026-07-30T00:00:00Z", ref: "T1" },
      // 200: Pickeados negativo — el caso real 957E/D14B (doble descuento de separar_pedidos)
      { cod_art: "200", descripcion: "Neg pickeados", deposito: "separar_pedidos", delta: 2, tipo: "picking", ts: "2026-07-30T00:00:00Z", ref: "T2" },
      { cod_art: "200", descripcion: "Neg pickeados", deposito: "separar_pedidos", delta: -4, tipo: "separado", ts: "2026-07-31T00:00:00Z", ref: "T2" },
      // 300: sano
      { cod_art: "300", descripcion: "Sano", deposito: "terminado", delta: 9, tipo: "inicial", ts: "2026-06-30T00:00:00Z" },
      // 400: neteado a cero — NO es negativo, no debe contarse
      { cod_art: "400", descripcion: "Cero", deposito: "terminado", delta: 4, tipo: "inicial", ts: "2026-06-30T00:00:00Z" },
      { cod_art: "400", descripcion: "Cero", deposito: "terminado", delta: -4, tipo: "picking", ts: "2026-07-30T00:00:00Z", ref: "T3" }
    ];
    _stk = {
      movs: MOVS, cutoff: null, factors: {}, ordenes: [], bajadas: [], tab: "stocks",
      soloConteo: false, filtro: "", openArt: null, ingMode: "remito", asOf: null,
      asOfInput: "", dem: {}, cap: [], gConf: [], fcs: { pend: {}, porArt: {} }, fcsLoaded: true
    };
    const codsDe = (html) => (html.match(/class="stk-cod">([^<]+)</g) || [])
      .map((s) => s.replace(/^.*>/, "").replace(/<$/, ""));
    const out = {};

    // Apagado: están los 3 con saldo (el 400 quedó en 0 → se oculta) y el botón cuenta 2.
    let h = stkBodyStocks();
    out.btnOff = /⚠ Negativos \(2\)/.test(h);
    out.offTiene100 = codsDe(h).indexOf("100") >= 0;
    out.offTiene300 = codsDe(h).indexOf("300") >= 0;

    // Con búsqueda cargada, prender el filtro tiene que LIMPIARLA.
    _stk.filtro = "300";
    stkRender = function () {};   // sin DOM del modal
    stkToggleNeg();
    out.limpioFiltro = _stk.filtro === "";
    out.prendido = _stk.soloNeg === true;

    // Prendido: SOLO los negativos, y el botón queda en estado activo.
    h = stkBodyStocks();
    const cods = codsDe(h);
    out.onCods = cods.slice().sort();
    out.onSoloNeg = cods.length === 2 && cods.indexOf("100") >= 0 && cods.indexOf("200") >= 0;
    out.onSin300 = cods.indexOf("300") < 0;
    out.onSin400 = cods.indexOf("400") < 0;
    out.btnOn = /☑ Negativos \(2\)/.test(h);

    // Apagar → vuelve la tabla completa.
    stkToggleNeg();
    h = stkBodyStocks();
    out.apagado = _stk.soloNeg === false;
    out.volvio300 = codsDe(h).indexOf("300") >= 0;

    // Sin negativos: contador en 0 y cartel propio (no "Sin stock todavía").
    _stk.movs = [MOVS[4]];   // solo el sano
    _stk._histDeps = null;
    _stk.soloNeg = true;
    h = stkBodyStocks();
    out.btnCero = /Negativos \(0\)/.test(h);   // prendido → el ícono es ☑, lo que importa es el contador
    out.cartelVacio = h.indexOf("No hay ningún saldo negativo") >= 0;
    return out;
  });
  await b.close();
  const ok = r.btnOff && r.offTiene100 && r.offTiene300 && r.limpioFiltro && r.prendido &&
    r.onSoloNeg && r.onSin300 && r.onSin400 && r.btnOn && r.apagado && r.volvio300 &&
    r.btnCero && r.cartelVacio && errs.length === 0;
  console.log("stk-negativos:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join(" | ") : "none", ok ? "· ✓ OK" : "· ✗ FALLA");
  process.exit(ok ? 0 : 1);
})();
