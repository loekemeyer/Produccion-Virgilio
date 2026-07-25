/* Regresión v6.22 — Cadena del recordatorio "Completar Pedido":
   primario Moncayo (104) → si NO vino, backup Farías (8) → (server) Telegram.
   Este test cubre los DOS eslabones del cliente:
     A) legajo 104 en la botonera, 15:30+ → se le avisa (showCPModal 104).
     B) legajo 8 y Moncayo SÍ mandó mensajes hoy → NO se le avisa (no escala).
     C) legajo 8 y Moncayo NO mandó nada hoy → se le avisa al backup (showCPModal 8).
     D) legajo 8 pero antes de las 15:30 → no se le avisa.
     E) otro legajo (55) → nunca se le avisa.
   Con fetch/_faltMiLegajo/_faltActivo/_cpRecordNowAR stubbeados. Sale 1 si falla. */
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
    window.alert = function () {};

    // --- stubs de entorno ---
    const YMD = "2026-07-20";                     // lunes
    let NOW = { ymd: YMD, min: 16 * 60, habil: true };   // 16:00, día hábil (≥ 15:30)
    let MI_LEGAJO = "104";
    let MONCAYO_TUVO = true;                       // ¿el legajo 104 tiene mensajes hoy?
    const cpCalls = [];

    window._cpRecordNowAR = function () { return NOW; };
    window._faltMiLegajo  = function () { return MI_LEGAJO; };
    window._faltActivo    = function () { return true; };            // en la botonera
    window.showCPModal    = function (leg) { cpCalls.push(String(leg)); return Promise.resolve(); };

    function J(data) {
      return Promise.resolve({ ok: true, status: 200,
        headers: { get: function () { return null; } },
        json: function () { return Promise.resolve(data); } });
    }
    window.fetch = function (url) {
      url = String(url);
      // consulta "¿el legajo 104 mandó algún mensaje hoy?"
      if (url.indexOf("Registros_Produccion_Virgilio") >= 0 && url.indexOf("legajo=eq.104") >= 0) {
        return J(MONCAYO_TUVO ? [{ id: "x" }] : []);
      }
      return J([]);
    };

    async function corrida() { localStorage.clear(); cpCalls.length = 0; await cpRecordCheck(); return cpCalls.slice(); }

    // A) 104 en la botonera, 15:30+ → se le avisa
    MI_LEGAJO = "104"; NOW = { ymd: YMD, min: 16 * 60, habil: true };
    out.A_primario = JSON.stringify(await corrida()) === JSON.stringify(["104"]);

    // B) 8, Moncayo SÍ vino → NO escala
    MI_LEGAJO = "8"; MONCAYO_TUVO = true;
    out.B_backupSuprimido = (await corrida()).length === 0;

    // C) 8, Moncayo NO vino → se avisa al backup con su propio legajo
    MI_LEGAJO = "8"; MONCAYO_TUVO = false;
    out.C_backupAvisa = JSON.stringify(await corrida()) === JSON.stringify(["8"]);

    // D) 8, pero antes de las 15:30 → no se avisa
    MI_LEGAJO = "8"; MONCAYO_TUVO = false; NOW = { ymd: YMD, min: 15 * 60, habil: true }; // 15:00
    out.D_antesDeHora = (await corrida()).length === 0;
    NOW = { ymd: YMD, min: 16 * 60, habil: true };

    // E) otro legajo → nunca
    MI_LEGAJO = "55"; MONCAYO_TUVO = false;
    out.E_otroLegajo = (await corrida()).length === 0;

    // F) dedup: 104 dos veces el mismo día → solo avisa la primera
    MI_LEGAJO = "104";
    localStorage.clear(); cpCalls.length = 0;
    await cpRecordCheck(); await cpRecordCheck();
    out.F_dedup = cpCalls.length === 1;

    return out;
  });

  const pass = r.A_primario && r.B_backupSuprimido && r.C_backupAvisa &&
               r.D_antesDeHora && r.E_otroLegajo && r.F_dedup && errs.length === 0;
  console.log("cp-record-backup:", JSON.stringify(r));
  console.log("  pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close();
  process.exit(pass ? 0 : 1);
})();
