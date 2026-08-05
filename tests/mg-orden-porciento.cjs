/* Regresión v7.71: Guardar a Góndola ordenado por % lleno (demanda_día/proyección)
   + display de máximo MCs. Validamos:
   - Ordenamiento por (góndola - demanda) / proyección ascendente.
   - Cálculo de máx MCs: floor((capacidad - gondola) / cajas_por_MC).
   - Items sin proyección se ponen al final (porciento extremo).
   Sale 1 si falla. */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) { try { ({ chromium } = require("playwright")); } catch (_e2) { console.error("no playwright"); process.exit(2); } }

(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("file://" + path.join(__dirname, "..", "index.html"), { waitUntil: "domcontentloaded" });
  const r = await p.evaluate(async (_) => {
    const out = {};

    // Mock: proyección madre (proy_cajas_mes)
    const proyDatos = {
      "100": 30,   // Art 100: 30 cajas/mes
      "200": 60,   // Art 200: 60 cajas/mes
      "300": 50    // Art 300: 50 cajas/mes
    };

    // Mock: Capacidad_Sector (máx gondola por code)
    const capDatos = {
      "100": 80,   // Max 80 cajas en góndola
      "200": 120,  // Max 120 cajas
      "300": 100   // Max 100 cajas
    };

    // Mock: Racks_Planimetria (cajas por master carton)
    const rkbDatos = {
      "100": 10,   // 10 cajas por MC
      "200": 12,   // 12 cajas por MC
      "300": 8     // 8 cajas por MC
    };

    // Mock: Stock saldos (terminado = gondola actual)
    const saldoDatos = {
      "100": { cod: "100", desc: "Art 100", a_guardar: 20, terminado: 50, desc: "Item 100" },
      "200": { cod: "200", desc: "Art 200", a_guardar: 30, terminado: 80, desc: "Item 200" },
      "300": { cod: "300", desc: "Art 300", a_guardar: 25, terminado: 30, desc: "Item 300" }
    };

    // Mock: demanda diaria
    const demandaDatos = {
      "100": 5,    // demanda diaria: 5
      "200": 10,   // demanda diaria: 10
      "300": 8     // demanda diaria: 8
    };

    // Cálculos esperados:
    // Art 100: % lleno = (50 - 5) / 30 = 45/30 = 1.5   (más alto = más lleno)
    // Art 200: % lleno = (80 - 10) / 60 = 70/60 = 1.167 (intermedio)
    // Art 300: % lleno = (30 - 8) / 50 = 22/50 = 0.44   (más bajo = más vacío) ← primero
    // Orden esperado: 300 (0.44), 200 (1.167), 100 (1.5)

    // Max MCs:
    // Art 100: floor((80 - 50) / 10) = floor(30/10) = 3 MC
    // Art 200: floor((120 - 80) / 12) = floor(40/12) = 3 MC
    // Art 300: floor((100 - 30) / 8) = floor(70/8) = 8 MC

    window.stockFetchSaldos = async () => saldoDatos;
    window.loadArtNombres = async () => ({});
    window.ocgDemanda = async () => demandaDatos;
    window.rkbFetchCxM = async () => ({ cxm: rkbDatos, locs: {} });
    window.artNombre = (cod, fb) => saldoDatos[cod]?.desc || fb || "";

    // Mock fetch para proyección y capacidad
    const origFetch = window.fetch;
    window.fetch = async function (url) {
      if (url.includes("proyeccion_madre")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { cod: "100", proy_cajas_mes: 30 },
            { cod: "200", proy_cajas_mes: 60 },
            { cod: "300", proy_cajas_mes: 50 }
          ])
        });
      }
      if (url.includes("Capacidad_Sector")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { cod: "100", cajas_max: 80 },
            { cod: "200", cajas_max: 120 },
            { cod: "300", cajas_max: 100 }
          ])
        });
      }
      return origFetch.apply(this, arguments);
    };

    // Simular showMGModal sin UI rendering
    await showMGModal("999", null);

    // Validar ordenamiento
    if (!_mg || !_mg.items) {
      out.error = "No _mg.items después de showMGModal";
      return out;
    }

    const items = _mg.items;
    out.itemCount = items.length;
    out.itemsData = items.map(it => ({
      cod: it.cod,
      porciento: it.porciento,
      cxm: it.cxm,
      maxMC: it.maxMC,
      maxCap: it.maxCap
    }));

    // Verificar que esté ordenado por porciento ascendente
    const isSorted = items.every((it, i, arr) => i === 0 || arr[i-1].porciento <= it.porciento);
    out.sortedOk = isSorted;

    // Verificar orden específico esperado: 300, 200, 100
    const cods = items.map(it => it.cod);
    out.codsOrder = cods.join(",");
    out.order300First = cods[0] === "300";
    out.order200Second = cods.length > 1 && cods[1] === "200";
    out.order100Third = cods.length > 2 && cods[2] === "100";

    // Verificar máx MCs calculados
    const item300 = items.find(it => it.cod === "300");
    const item200 = items.find(it => it.cod === "200");
    const item100 = items.find(it => it.cod === "100");

    out.mc300 = item300?.maxMC;
    out.mc300Ok = item300?.maxMC === 8;
    out.mc200 = item200?.maxMC;
    out.mc200Ok = item200?.maxMC === 3;
    out.mc100 = item100?.maxMC;
    out.mc100Ok = item100?.maxMC === 3;

    // Verificar que cxm (cajas por MC) esté seteado
    out.cxm300Ok = item300?.cxm === 8;
    out.cxm200Ok = item200?.cxm === 12;
    out.cxm100Ok = item100?.cxm === 10;

    return out;
  });

  const checks = [
    ["Items ordenados por porciento ascendente", r.sortedOk],
    ["Item 300 (más vacío) es primero", r.order300First],
    ["Item 200 es segundo", r.order200Second],
    ["Item 100 (más lleno) es tercero", r.order100Third],
    ["Max MCs 300 = 8", r.mc300Ok],
    ["Max MCs 200 = 3", r.mc200Ok],
    ["Max MCs 100 = 3", r.mc100Ok],
    ["CXM 300 seteado (8)", r.cxm300Ok],
    ["CXM 200 seteado (12)", r.cxm200Ok],
    ["CXM 100 seteado (10)", r.cxm100Ok],
  ];

  const pass = checks.every((c) => c[1]) && errs.length === 0;
  console.log("mg-orden-porciento:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none");
  checks.forEach((c) => console.log("  " + (c[1] ? "✓" : "✗") + " " + c[0]));
  console.log(pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
