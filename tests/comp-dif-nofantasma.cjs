/* Regresión v7.39 (+ idea 1569, ajuste de separar_pedidos) — "picking difiere de la mesa"
   NO infla góndola fantasma Y descuenta lo que corresponde de Pickeados (separar_pedidos).

   La regla "de menos + no hay en góndola":
   - SIEMPRE descuenta `qty` de separar_pedidos (ref=tanda, client_id determinístico) — esas
     cajas quedaron registradas como pickeadas pero nunca salieron realmente de góndola, así que
     hay que sacarlas de Pickeados o la ETAPA 2 del cron las arrastra hasta a_facturar como si de
     verdad se hubieran armado (idea 1569).
   - Además COMPENSA una góndola que el picking dejó NEGATIVA (lee el saldo vivo y devuelve, a lo
     sumo, lo justo para llegar a 0). Antes devolvía `qty` SIEMPRE ahí y, cuando el picking ya
     había descontado bien, creaba stock fantasma (caso real 535/D05B: góndola en 0 y tres NPD
     "de menos" la subieron a 4). Eso NO debe volver a pasar.

   Chequea:
   - Góndola en 0 (faltante real ya registrado): separar_pedidos se descuenta, pero NO se toca
     "terminado" (sin fantasma en góndola).
   - Góndola en -5 (picking marcó de más): además del descuento de separar_pedidos, devuelve
     min(qty, 5) a "terminado" para llevarla a 0.
   - Góndola en -1, qty=2: el retorno a "terminado" clampea a 1 (sólo hasta 0, no por debajo).
   - Sin dato de saldo (fetch falló → null): separar_pedidos se descuenta igual, "terminado" NO.
   - El evento NPD (aviso al picking) se emite SIEMPRE, con formato correcto.
   - Doble toque del mismo caso → mismo client_id en el ajuste de separar_pedidos (idempotente).
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
    const wait = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };
    window.alert = function () {};
    window._compRenderSep = function () {};
    window.trySendOneReport = function () { return Promise.resolve({ ok: false }); };
    let npd = null; window.enqueueReport = function (pl) { if (pl && pl.opcion === "NPD") npd = pl; };
    let calls = []; window.stockMove = function (rows) { calls.push.apply(calls, rows); return Promise.resolve(); };
    window.esOperadorPrueba = function () { return false; };
    function sep(cs) { return cs.filter(function (c) { return c.deposito === "separar_pedidos"; }); }
    function term(cs) { return cs.filter(function (c) { return c.deposito === "terminado"; }); }

    function setup() {
      _comp = { legajo: "8", tanda: "D05B", sepDif: { npIdx: 0, ci: 0 },
        nps: [{ np: "98140", codes: [{ cod: "535", sale: 2 }] }] };
      const inp = document.createElement("input"); inp.id = "csep-difreal"; inp.value = "0"; // real=0 → qty = sale-0 = 2
      const old = document.getElementById("csep-difreal"); if (old) old.remove();
      document.body.appendChild(inp);
    }

    // ---- CASO 1: góndola en 0 (faltante real). Descuenta separar_pedidos, NO toca terminado. ----
    window._stkGondolaSaldoVivo = async function () { return 0; };
    setup(); calls = []; npd = null;
    _compDifResolve("menos", "no");
    await wait(40);
    const s1 = sep(calls);
    out.caso0_sepDescuenta = s1.length === 1 && s1[0].delta === -2 && s1[0].ref === "D05B" && s1[0].cod_art === "535" && !!s1[0].client_id;
    out.caso0_sinFantasmaGondola = term(calls).length === 0;
    out.caso0_npd = !!npd && npd.texto === "98140|535|menos|no|2|2|D05B";

    // ---- CASO 2: góndola en -5 (picking marcó de más). Devuelve min(qty=2, 5) = 2 a terminado. ----
    window._stkGondolaSaldoVivo = async function () { return -5; };
    setup(); calls = []; npd = null;
    _compDifResolve("menos", "no");
    await wait(40);
    out.caso_neg_sep = sep(calls).length === 1 && sep(calls)[0].delta === -2;
    const t2 = term(calls);
    out.caso_neg_stock = t2.length === 1 && t2[0].delta === 2 && t2[0].ref === "picking_difiere";
    out.caso_neg_npd = !!npd;

    // ---- CASO 3: góndola en -1, qty=2 → clamp a 1 en terminado (sólo hasta 0, no por debajo) ----
    window._stkGondolaSaldoVivo = async function () { return -1; };
    setup(); calls = [];
    _compDifResolve("menos", "no");
    await wait(40);
    out.caso_clamp = term(calls).length === 1 && term(calls)[0].delta === 1;

    // ---- CASO 4: sin dato de saldo (fetch falló → null) → descuenta separar_pedidos, NO terminado ----
    window._stkGondolaSaldoVivo = async function () { return null; };
    setup(); calls = [];
    _compDifResolve("menos", "no");
    await wait(40);
    out.caso_null_sep = sep(calls).length === 1;
    out.caso_null_sinStockGondola = term(calls).length === 0;

    // ---- CASO 5: doble toque del mismo caso → mismo client_id (dedup del lado servidor) ----
    window._stkGondolaSaldoVivo = async function () { return 0; };
    setup(); calls = [];
    _compDifResolve("menos", "no");
    await wait(20);
    const cid1 = sep(calls)[0] && sep(calls)[0].client_id;
    setup(); // el modal se reabre igual (mismo caso: misma tanda/np/cod/tipo/gond/qty)
    _compDifResolve("menos", "no");
    await wait(20);
    const cid2 = sep(calls).length > 1 && sep(calls)[1].client_id;
    out.caso_dedup_mismoClientId = !!cid1 && cid1 === cid2;
    return out;
  });
  const pass = r.caso0_sepDescuenta && r.caso0_sinFantasmaGondola && r.caso0_npd &&
    r.caso_neg_sep && r.caso_neg_stock && r.caso_neg_npd &&
    r.caso_clamp && r.caso_null_sep && r.caso_null_sinStockGondola &&
    r.caso_dedup_mismoClientId && errs.length === 0;
  console.log("comp-dif-nofantasma:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
