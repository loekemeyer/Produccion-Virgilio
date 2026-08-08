/* Regresión idea 2865 — el badge "en curso hace X" del monitor (statusCell) usaba reloj de
   pared puro (Date.now()-startTs), así que una tanda abierta el viernes a la tarde y todavía sin
   cerrar el lunes marcaba ~66h (contaba las dos noches y el fin de semana entero como trabajado).
   Ahora businessDurSinceMs() sólo cuenta horas dentro de horaEntrada-horaSalida del operario y
   saltea sábado/domingo/feriados para los días intermedios y para "hoy".

   Chequea:
   - Mismo día (sin cruzar medianoche AR): sigue siendo la diferencia directa (sin cambios).
   - Cruce Viernes 19:04 → Lunes 13:00 (caso real D14B, legajo horario 08-17): NO son ~66h, el
     resultado queda acotado a horas laborales (abre viernes ya después de la salida programada →
     0 del viernes, sábado/domingo salteados, lunes 08:00→13:00 = 5h).
   - "Hoy" cae en fin de semana (excepción no contemplada): la porción de hoy no suma (limitación
     documentada), pero el cálculo no explota ni da negativo.
   - statusCell() en estado "curso" usa businessDurSinceMs (no Date.now() crudo) para el texto del
     badge.
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
    _empleadosHorarios = new Map([["8", { entrada: "08:00:00", salida: "17:00:00" }]]);

    // ---- CASO 1: mismo día, sin cambios (diferencia directa) ----
    const sameDayStart = new Date("2026-08-03T14:00:00-03:00").getTime(); // lunes 14:00
    const _now1 = Date.now; Date.now = function () { return new Date("2026-08-03T15:30:00-03:00").getTime(); }; // lunes 15:30
    out.sameDay_90min = businessDurSinceMs(sameDayStart, "8") === 90 * 60 * 1000;
    Date.now = _now1;

    // ---- CASO 2: viernes 19:04 → lunes 13:00 (caso real D14B) ----
    const friStart = new Date("2026-07-31T19:04:00-03:00").getTime(); // viernes 31/07/2026 19:04
    const _now2 = Date.now; Date.now = function () { return new Date("2026-08-03T13:00:00-03:00").getTime(); }; // lunes 03/08 13:00
    const durMs = businessDurSinceMs(friStart, "8");
    const wallClockMs = new Date("2026-08-03T13:00:00-03:00").getTime() - friStart; // ~66h
    Date.now = _now2;
    out.crossWeekend_muchoMenosQueReloj = durMs < wallClockMs * 0.15;   // muy por debajo del reloj de pared
    out.crossWeekend_noNegativo = durMs >= 0;
    out.crossWeekend_razonable = durMs <= 6 * 3600 * 1000;              // viernes 0h + sáb/dom saltados + lunes 08→13 = 5h

    // ---- CASO 3: "hoy" cae en fin de semana → no explota, no da negativo ----
    const thuStart = new Date("2026-07-30T10:00:00-03:00").getTime(); // jueves
    const _now3 = Date.now; Date.now = function () { return new Date("2026-08-01T11:00:00-03:00").getTime(); }; // sábado
    const durSab = businessDurSinceMs(thuStart, "8");
    Date.now = _now3;
    out.hoyFinde_noNegativo = durSab >= 0 && isFinite(durSab);

    // ---- CASO 4: statusCell usa businessDurSinceMs (no Date.now() crudo) para el badge ----
    const _now4 = Date.now; Date.now = function () { return new Date("2026-08-03T13:00:00-03:00").getTime(); };
    const html = statusCell("curso", "8", "D14B", "separado", "2026-07-31T22:04:00Z"); // 19:04 ART = 22:04 UTC
    Date.now = _now4;
    out.statusCell_noMarca66h = html.indexOf("66h") === -1 && html.indexOf("65h") === -1 && html.indexOf("64h") === -1;
    out.statusCell_tieneDur = /mon-dur/.test(html);

    return out;
  });
  const pass = r.sameDay_90min && r.crossWeekend_muchoMenosQueReloj && r.crossWeekend_noNegativo &&
    r.crossWeekend_razonable && r.hoyFinde_noNegativo && r.statusCell_noMarca66h && r.statusCell_tieneDur &&
    errs.length === 0;
  console.log("curso-dur-laboral:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
