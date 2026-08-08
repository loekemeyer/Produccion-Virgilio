/* Regresión idea 6497 — Completar Pedido (CP) avisa cuando se retira de GÓNDOLA con saldo 0
   (queda negativa "de la nada", sin que nadie se entere hasta que otro pedido la necesite).

   Chequea:
   - Paso 2, origen="terminado" (Góndola) con saldo 0 → cartel de aviso visible.
   - Paso 2, origen="a_guardar" (Tránsito) con góndola en 0 → SIN cartel (no aplica, no se toca
     góndola).
   - Paso 2, origen="terminado" con saldo > 0 → SIN cartel (hay stock real, nada que avisar).
   - cpConfirm() con origen="terminado" y saldo 0 → dispara UN POST a telegram_outbox con el
     código/NP correctos.
   - cpConfirm() con origen="terminado" y saldo > 0 → NO dispara ningún POST a telegram_outbox.
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
    window.alert = function () {};
    function J(data) { return Promise.resolve({ ok: true, status: 200, headers: { get: function () { return null; } }, json: function () { return Promise.resolve(data); } }); }
    const FALT = [{ id: 1, np: "98140", cod_cliente: "771", cod_art: "535", cajas_pedidas: 10, cajas_entregadas: 8, cajas_falto: 2, tanda: "D05B", fecha_salida: "2026-08-01" }];
    let saldo535 = { cod_art: "535", descripcion: "", a_guardar: 4, terminado: 0, excedente: 0, separar_pedidos: 0, a_facturar: 0, racks: 0, insumos: 0 };
    let telegramPosts = [];
    window.fetch = function (url, opts) {
      url = String(url);
      if (url.indexOf("Entregas_Virgilio") >= 0 && url.indexOf("cajas_falto=gt.0") >= 0) return J(FALT);
      if (url.indexOf("vista_saldos_stock") >= 0) return J([saldo535]);
      if (url.indexOf("opcion=eq.TAL") >= 0) return J([]);
      if (url.indexOf("telegram_outbox") >= 0) { try { telegramPosts.push(JSON.parse(opts.body)); } catch (_e) {} return J([]); }
      return J([]);
    };
    window.stockMove = function () { return Promise.resolve(); };
    window.enqueueReport = function () {};
    window.trySendOneReport = function () { return Promise.resolve({ ok: false }); };
    window.cpReduceFaltante = function () { return Promise.resolve(); };
    window.faltMaybeCompletar = function () {};
    window.cpCerrarTareaSiCompleta = function () { return Promise.resolve(); };
    window.opDraftClear = function () {};
    window.updatePendingIndicator = function () {};
    window.cpReloadFaltantes = function () { return Promise.resolve([]); };
    const body = function () { const el = document.getElementById("cpBody"); return el ? el.innerHTML : ""; };

    // ---- Góndola en 0: seleccionar "terminado" muestra el cartel ----
    await showCPModal("104", null, "98140");   // 1 solo artículo → salta al paso 2
    cpOrigen("terminado");
    const h1 = body();
    out.gon0_cartelVisible = /Góndola está en.*0/.test(h1) && /Se avisa por Telegram/.test(h1);

    // ---- Góndola en 0 pero origen="a_guardar" (Tránsito): sin cartel ----
    cpOrigen("a_guardar");
    const h2 = body();
    out.origenTransito_sinCartel = !/Se avisa por Telegram/.test(h2);

    // ---- Confirmar con origen="terminado" y saldo 0 → dispara Telegram ----
    cpOrigen("terminado");
    telegramPosts = [];
    await cpConfirm();
    out.confirm_gon0_disparaTelegram = telegramPosts.length === 1 &&
      telegramPosts[0].text.indexOf("GÓNDOLA VACÍA") >= 0 &&
      telegramPosts[0].text.indexOf("535") >= 0 && telegramPosts[0].text.indexOf("98140") >= 0;

    // ---- Caso con stock real en góndola: sin cartel, sin Telegram ----
    saldo535 = { cod_art: "535", descripcion: "", a_guardar: 0, terminado: 6, excedente: 0, separar_pedidos: 0, a_facturar: 0, racks: 0, insumos: 0 };
    const FALT2 = [{ id: 2, np: "98141", cod_cliente: "771", cod_art: "535", cajas_pedidas: 10, cajas_entregadas: 8, cajas_falto: 2, tanda: "D05C", fecha_salida: "2026-08-01" }];
    window.fetch = function (url, opts) {
      url = String(url);
      if (url.indexOf("Entregas_Virgilio") >= 0 && url.indexOf("cajas_falto=gt.0") >= 0) return J(FALT2);
      if (url.indexOf("vista_saldos_stock") >= 0) return J([saldo535]);
      if (url.indexOf("opcion=eq.TAL") >= 0) return J([]);
      if (url.indexOf("telegram_outbox") >= 0) { try { telegramPosts.push(JSON.parse(opts.body)); } catch (_e) {} return J([]); }
      return J([]);
    };
    await showCPModal("104", null, "98141");
    cpOrigen("terminado");
    const h3 = body();
    out.gonConStock_sinCartel = !/Se avisa por Telegram/.test(h3);
    telegramPosts = [];
    await cpConfirm();
    out.confirm_gonConStock_sinTelegram = telegramPosts.length === 0;

    return out;
  });
  const pass = r.gon0_cartelVisible && r.origenTransito_sinCartel && r.confirm_gon0_disparaTelegram &&
    r.gonConStock_sinCartel && r.confirm_gonConStock_sinTelegram && errs.length === 0;
  console.log("cp-gondola-vacia:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
