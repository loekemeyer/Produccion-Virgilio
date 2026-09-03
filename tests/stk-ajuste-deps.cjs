/* Regresión v7.38 — el selector de Depósito de la solapa "⚙ Ajustes" ofrece TODOS los
   depósitos reales, incluyendo "Para envasar" (para_envasar) y "Racks CH" (racks_ch).
   Antes faltaban y esos depósitos sólo se podían ajustar por SQL (caso 035E p/envasar,
   809E racks CH). También verifica que stockFijar/stockAjustar leen el depósito elegido y
   que stockComputeSaldos separa el saldo por depósito. Sale 1 si falla. */
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
    // 1) El HTML del selector ofrece para_envasar y racks_ch (+ los clásicos)
    const html = stkBodyAjustes();
    out.tieneEnvasar = html.indexOf('value="para_envasar"') >= 0;
    out.tieneRacksCh = html.indexOf('value="racks_ch"') >= 0;
    out.tieneTerminado = html.indexOf('value="terminado"') >= 0;
    out.tieneGuardar = html.indexOf('value="a_guardar"') >= 0;
    out.labelEnvasar = html.indexOf('>Para envasar<') >= 0;

    // 2) stockComputeSaldos separa el saldo por depósito (para_envasar / racks_ch)
    const movs = [
      { cod_art: "035E", deposito: "terminado",    delta: 33, tipo: "inicial", ts: "2026-08-01T10:00:00Z" },
      { cod_art: "035E", deposito: "para_envasar", delta: 44, tipo: "inicial", ts: "2026-08-01T10:00:00Z" },
      { cod_art: "809E", deposito: "racks_ch",     delta: 12, tipo: "inicial", ts: "2026-08-01T10:00:00Z" }
    ];
    const sd = stockComputeSaldos(movs, 0);
    out.envasar035 = sd["035E"].para_envasar === 44;
    out.term035 = sd["035E"].terminado === 33;
    out.racksch809 = sd["809E"].racks_ch === 12;

    // 3) stockAjustar usa el depósito elegido en el <select> (escribe deposito=para_envasar)
    /* Se AGREGAN los controles; antes acá había un `document.body.innerHTML = ...` que
       borraba el DOM entero de la app. Cualquier timer de la página que corriera después
       se encontraba con sus elementos desaparecidos y tiraba "Cannot read properties of
       null", que el test cuenta como pageerror y hace fallar algo que no tiene que ver.
       Era una carrera: fallaba según cuándo cayera el timer, o sea rara vez en una
       máquina rápida y seguido en un runner lento. */
    const _cont = document.createElement("div");
    _cont.innerHTML = '<select id="stkAjDep"><option value="para_envasar" selected>x</option></select>' +
      '<input id="stkAjCod" value="035E"><input id="stkAjCant" value="5">';
    document.body.appendChild(_cont);
    _stk = { movs: movs, cutoff: 0 };
    let posted = null;
    window.stkInsertMov = function (rows) { posted = rows; return Promise.resolve(); };
    await stockAjustar();
    out.postDep = posted && posted[0] && posted[0].deposito === "para_envasar";
    out.postDelta = posted && posted[0] && posted[0].delta === 5;
    return out;
  });
  const pass = r.tieneEnvasar && r.tieneRacksCh && r.tieneTerminado && r.tieneGuardar && r.labelEnvasar &&
    r.envasar035 && r.term035 && r.racksch809 && r.postDep && r.postDelta && errs.length === 0;
  console.log("stk-ajuste-deps:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
