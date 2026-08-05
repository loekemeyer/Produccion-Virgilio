/* Regresión v7.72: Completar Pedido notifications cuando MG completa un faltante.
   Validamos:
   - MG guarda códigos en buffer al confirmar.
   - CP wizard detecta códigos completados y muestra cartel.
   - Telegram alert se emite (CPR event).
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
    window.alert = function () {};
    window.pkFetchExcedente = async function () { return {}; };
    window.pkNotifySinPlanim = function () {};

    function mapOf(obj) { const m = new Map(); Object.keys(obj).forEach(function (k) { m.set(k, obj[k]); }); return m; }

    // Mock: Tanda T01 con NP 50001 pidiendo art 100 (3 cajas) y art 200 (2 cajas)
    const sheetMap = mapOf({
      "T01": {
        tanda: "T01",
        fechaEntrega: "2026-08-10",
        pedidos: [
          { np: "50001", razonSocial: "CLI01", cod: "C001", direccion: "Av1", art: "100", cajas: 3 },
          { np: "50001", razonSocial: "CLI01", cod: "C001", direccion: "Av1", art: "200", cajas: 2 }
        ]
      }
    });

    // Mock: Picking para NP 50001
    const pickBase = mapOf({
      "50001": [
        { art: "100", cajas: 3 },
        { art: "200", cajas: 2 }
      ]
    });

    // Mock: PKC events (picking completed) con faltantes
    // Art 100: esperado 3, real 2 → falta 1
    // Art 200: esperado 2, real 1 → falta 1
    const pkc_data = [
      { opcion: "PKC", texto: "T01|100|3,2" },
      { opcion: "PKC", texto: "T01|200|2,1" }
    ];

    // Mock: Stock actual (para MG)
    const saldoDatos = {
      "100": { cod: "100", desc: "Art 100", a_guardar: 10, terminado: 50 },
      "200": { cod: "200", desc: "Art 200", a_guardar: 5, terminado: 30 }
    };

    // ===== Mock global de fetch para toda la prueba =====
    const origFetch = window.fetch;
    window.fetch = async function (url) {
      // Proyección madre y capacidad sector (para MG)
      if (url.includes("proyeccion_madre") || url.includes("Capacidad_Sector")) {
        return Promise.resolve({ ok: true, json: async function () { return []; } });
      }
      return origFetch.apply(this, arguments);
    };

    // ===== Paso 1: MG guarda códigos (simulate saving via mgConfirm) =====
    window.stockFetchSaldos = async () => saldoDatos;
    window.loadArtNombres = async () => ({});
    window.ocgDemanda = async () => ({});
    window.rkbFetchCxM = async () => ({ cxm: {}, locs: {} });

    // Simular MG: crear items y confirmar
    _mg = {
      legajo: "123",
      items: [
        { cod: "100", desc: "Art 100", cargar: 5, exc: 0, manual: false },
        { cod: "200", desc: "Art 200", cargar: 3, exc: 0, manual: false }
      ],
      tsInicio: Date.now() - 300000
    };

    // Llamar a mgRecordCompletedCodes (simular lo que hace mgConfirm)
    mgRecordCompletedCodes(_mg.items);
    out.bufferAfterMg = JSON.parse(localStorage.getItem("_mgCompletedCodesBuffer") || "[]");
    out.bufferHas100 = out.bufferAfterMg.some(b => b.cod === "100");
    out.bufferHas200 = out.bufferAfterMg.some(b => b.cod === "200");

    // ===== Paso 2: CP wizard abre para tanda T01 =====
    window.fetchMonitorSheet = async () => sheetMap;
    window.fetchPickingBase = async () => pickBase;

    // Track CPR (Completar Pedido Resuelto) events
    const cprEvents = [];
    const origEnqueue = enqueueReport;
    window.enqueueReport = function (payload) {
      if (payload.opcion === "CPR") cprEvents.push(payload);
      if (typeof origEnqueue === "function") origEnqueue(payload);
    };

    // Mock faltantesDeTanda to return expected faltantes
    window.faltantesDeTanda = async () => [
      { art: "100", esp: 3, real: 2, falta: 1 },
      { art: "200", esp: 2, real: 1, falta: 1 }
    ];

    // Abrir CP wizard para tanda T01
    await showCompletarWizard("123", "T01");
    out.completedByMg = _comp?.completedByMg || [];
    out.hasCompletedCodes = (_comp?.completedByMg?.length || 0) > 0;

    // Validar que los códigos están en completedByMg
    out.completed100 = (_comp?.completedByMg || []).some(c => c.cod === "100");
    out.completed200 = (_comp?.completedByMg || []).some(c => c.cod === "200");

    // Validar que se emitió CPR event
    out.cprEmitted = cprEvents.length > 0;
    if (out.cprEmitted) {
      const cpr = cprEvents[0];
      out.cprTanda = cpr.texto.split("|")[0];
      out.cprCorrect = cpr.opcion === "CPR" && out.cprTanda === "T01";
    }

    // Validar que se limpió el buffer
    const bufferAfter = JSON.parse(localStorage.getItem("_mgCompletedCodesBuffer") || "[]");
    out.bufferCleared = bufferAfter.length === 0;

    return out;
  });

  const checks = [
    ["Buffer grabó art 100 después de MG", r.bufferHas100],
    ["Buffer grabó art 200 después de MG", r.bufferHas200],
    ["CP detectó códigos completados", r.hasCompletedCodes],
    ["CP vio art 100 completado", r.completed100],
    ["CP vio art 200 completado", r.completed200],
    ["CPR event emitido", r.cprEmitted],
    ["CPR para tanda T01", r.cprCorrect],
    ["Buffer se limpió después de CP", r.bufferCleared]
  ];

  const pass = checks.every((c) => c[1]) && errs.length === 0;
  console.log("cp-mg-completado:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none");
  checks.forEach((c) => console.log("  " + (c[1] ? "✓" : "✗") + " " + c[0]));
  console.log(pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
