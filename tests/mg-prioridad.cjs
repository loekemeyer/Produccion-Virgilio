/* Regresión — idea 4926: "Guardar a góndola" ordena por prioridad = (góndola − demanda
   del día PPP) / capacidad máxima (ascendente = lo más vacío primero, va antes) y muestra
   por código el máximo de MCs que entran en góndola sin rebalsar = piso((capacidad −
   góndola actual) / cajas×MC). Códigos sin capacidad cargada quedan al final (no se puede
   calcular el %), y el hint es solo informativo (nunca reduce lo que se puede guardar).
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
    window.loadArtNombres = async function () { return {}; };
    // 500: góndola 10, demanda 2, capacidad 100, cxm 20 → ratio (10-2)/100=0.08, maxMC=floor((100-10)/20)=4
    // 600: góndola 90, demanda 0, capacidad 100, cxm 10 → ratio 0.90, maxMC=floor((100-90)/10)=1
    // 700: góndola 5,  demanda 0, capacidad 0 (sin capacidad cargada) → ratio null, va al final
    window.stockFetchSaldos = async function () {
      return {
        "500": { cod: "500", desc: "Uno", a_guardar: 8, terminado: 10 },
        "600": { cod: "600", desc: "Dos", a_guardar: 3, terminado: 90 },
        "700": { cod: "700", desc: "Tres", a_guardar: 6, terminado: 5 }
      };
    };
    window.ocgDemanda = async function () { return { "500": 2, "600": 0 }; };
    window.rkbFetchCxM = async function () { return { cxm: { "500": 20, "600": 10 }, locs: {} }; };
    window.fetch = function (url) {
      if (String(url).indexOf("Capacidad_Sector") >= 0) {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve([{ cod: "500", cajas_max: 100 }, { cod: "600", cajas_max: 100 }]); } });
      }
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve([]); } });
    };
    showMGModal("77");
    await new Promise(function (res) { setTimeout(res, 60); });

    out.orden = _mg.items.map(function (it) { return it.cod; });   // esperado: 500 (0.08), 600 (0.90), 700 (sin cap → último)
    const it500 = _mg.items.find(function (it) { return it.cod === "500"; });
    const it600 = _mg.items.find(function (it) { return it.cod === "600"; });
    const it700 = _mg.items.find(function (it) { return it.cod === "700"; });
    out.maxMC500 = it500._maxMC; out.maxMC600 = it600._maxMC; out.maxMC700 = it700._maxMC;
    out.ratio500 = Math.round(it500._ratio * 100) / 100;

    const html = document.getElementById("mgBody").innerHTML;
    out.htmlTiene500Hint = html.indexOf("Máx sin rebalsar: <b>4 MC</b> (80 cajas)") >= 0;
    out.htmlTiene600Hint = html.indexOf("Máx sin rebalsar: <b>1 MC</b> (10 cajas)") >= 0;
    out.htmlSin700Hint = html.indexOf('mg-mchint') < html.indexOf('stk-cod') || true;   // placeholder, chequeo real abajo

    // el hint es SOLO informativo: el tope real del input sigue siendo lo disponible
    const maxAttrMatch = html.match(/max="(\d+)"[^>]*value="0"[^>]*oninput="mgSet\(0,/);
    out.maxSigueSiendoDisponible = !!maxAttrMatch && Number(maxAttrMatch[1]) === it500.disponible;   // 8, no 80

    // código 700 (sin capacidad) no debe mostrar ningún hint de MC
    const idx700 = html.indexOf('>700<');
    const chunk700 = idx700 >= 0 ? html.slice(idx700, idx700 + 400) : "";
    out.sin700NoTieneHint = chunk700.indexOf("mg-mchint") < 0;

    // mgAddManual: item fuera de lista nunca tiene hint ni rompe el orden
    _mg.filtro = "999";
    mgAddManual();
    const it999 = _mg.items.find(function (it) { return it.cod === "999"; });
    out.manualSinHint = it999 && it999._maxMC == null;

    return out;
  });
  const pass = JSON.stringify(r.orden) === JSON.stringify(["500", "600", "700"]) &&
    r.maxMC500 === 4 && r.maxMC600 === 1 && r.maxMC700 === null && r.ratio500 === 0.08 &&
    r.htmlTiene500Hint && r.htmlTiene600Hint && r.maxSigueSiendoDisponible && r.sin700NoTieneHint && r.manualSinHint &&
    errs.length === 0;
  console.log("mg-prioridad:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
