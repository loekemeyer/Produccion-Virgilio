/* v12.78 — dos reglas nuevas del detalle de la OC:
   1) Sección "Otros artículos de <tallerista>": debajo del detalle se listan TODOS los
      artículos que hace ese tallerista (vista_generador_oc, con el reparto Prov1/Prov2)
      que NO están en esta OC, con los mismos datos (stock/máximo/cap/pedidos/proyección).
   2) "Llenar góndola" (⛽) solo aplica a líneas con Falta > 0 (pedido − recibido): las ya
      recibidas completas no se tocan.
   Sale 1 si falla. */
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
    // La vista del generador: 031 y 066 los hace "Poly" (031 está en la OC, 066 no),
    // 123 es dual Poly/Lucho al 50 (no está en la OC), 900 es de otro tallerista.
    supaFetchAllSafe = async (url) => {
      if (String(url).indexOf("vista_generador_oc") >= 0) return [
        { cod: "031", descripcion: "EnLaOC", proveedor: "Poly", tiene_prov_real: true, pr1: 100, proveedor2: null, pr2: 0, indice: 1.5, proy: 100, cap: 0, maximo: 150, pedidos: 0, stock: 60, uni_x_caja: 24, n_caja: 1, total: 90 },
        { cod: "066", descripcion: "Afuera", proveedor: "Poly", tiene_prov_real: true, pr1: 100, proveedor2: null, pr2: 0, indice: 1.5, proy: 40, cap: 30, maximo: 30, pedidos: 5, stock: 20, uni_x_caja: 12, n_caja: 2, total: 15 },
        { cod: "123", descripcion: "Dual", proveedor: "Poly", tiene_prov_real: true, pr1: 50, proveedor2: "Lucho", pr2: 50, indice: 1.5, proy: 120, cap: 0, maximo: 164, pedidos: 0, stock: 70, uni_x_caja: 12, n_caja: 3, total: 94 },
        { cod: "900", descripcion: "DeOtro", proveedor: "Otro", tiene_prov_real: true, pr1: 100, proveedor2: null, pr2: 0, indice: 1.5, proy: 10, cap: 0, maximo: 15, pedidos: 0, stock: 0, uni_x_caja: 6, n_caja: 4, total: 15 }
      ];
      return [];
    };
    ocRender = function () {};   // sin DOM del modal
    _oc = {
      view: "detail", openKey: ["Poly", "2026-09-01", "Art Term"].join("~|~"), openFecha: "2026-09-01",
      detEdit: {}, detMeses: 6, filtro: "",
      // 1: falta 10 (pendiente) · 2: recibida completa (falta 0) → el ⛽ no la toca
      rows: [
        { id: 1, proveedor: "Poly", fecha: "2026-09-01", rubro: "Art Term", codigo: "031", descripcion: "EnLaOC", cantidad: 100, cantidad_recibida: 90, unidad: "Cajas", estado: "parcial", oc_stock: 10, oc_max: 150, oc_pedidos: 0, oc_proy: 20 },
        { id: 2, proveedor: "Poly", fecha: "2026-09-01", rubro: "Art Term", codigo: "999", descripcion: "YaRecibida", cantidad: 40, cantidad_recibida: 40, unidad: "Cajas", estado: "recibida", oc_stock: 5, oc_max: 30, oc_pedidos: 0, oc_proy: 20 }
      ],
      recepByRow: { 1: 90, 2: 40 },
      capMap: { "31": 200, "999": 200 }, proyHoy: {}
    };
    await ocEnsureArts();

    // ── 1) sección "Otros artículos"
    const x = ocGroups()[_oc.openKey];
    const html = ocDetOtros(x);
    const otros = _oc.artsAll.filter(function (it) { return it.prov === "Poly"; }).map(function (it) { return it.cod; });
    const d123 = _oc.artsAll.find(function (it) { return it.cod === "123" && it.prov === "Poly"; });

    // ── 2) ⛽ solo Falta > 0
    const antes = JSON.stringify(_oc.detEdit);
    window.alert = function () {};
    ocDetFillAll();
    const tocada1 = _oc.detEdit[1] != null;   // falta 10 → sí
    const tocada2 = _oc.detEdit[2] != null;   // falta 0  → NO
    _oc.detEdit = {};
    ocDetFill(2);                              // por línea, también debe rebotar
    const fill2 = _oc.detEdit[2] != null;

    return {
      artsPoly: otros.sort(),                                  // 031, 066, 123
      dual123: d123 ? d123.stock : null,                       // 35 (50% de 70)
      trae066: html.indexOf("Afuera") >= 0,                     // el que NO está en la OC, sí
      trae031: html.indexOf("EnLaOC") >= 0,                     // el que SÍ está en la OC, no
      trae900: html.indexOf("DeOtro") >= 0,                    // otro tallerista, no
      tituloOk: html.indexOf("Otros artículos de <b>Poly</b>") >= 0,
      tocada1: tocada1, tocada2: tocada2, fill2: fill2
    };
  });

  const pass = JSON.stringify(r.artsPoly) === JSON.stringify(["031", "066", "123"]) &&
    r.dual123 === 35 && r.trae066 === true && r.trae031 === false && r.trae900 === false &&
    r.tituloOk === true && r.tocada1 === true && r.tocada2 === false && r.fill2 === false &&
    errs.length === 0;
  console.log("oc-otros-tallerista:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close();
  process.exit(pass ? 0 : 1);
})();
