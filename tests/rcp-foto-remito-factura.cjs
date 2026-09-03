/* Regresión (pedido del dueño, 2026-09-03): en Recepción de Mercadería, cuando el
   operario elige "Remito y Factura" hay que pedirle DOS fotos —la del remito y la de
   la factura— y las dos tienen que verse en Pendientes.

   Lo que blinda:
   A) Con tipoDoc = remito_factura se dibujan DOS bloques de foto, rotulados, y
      "Confirmar" queda deshabilitado hasta que estén LAS DOS.
   B) Con un solo documento (remito, o factura) sigue habiendo UNA sola foto, como
      siempre: el pedido era para el caso combinado, no para todos.
   C) El visor de Pendientes muestra las dos imágenes cuando hay foto_factura_url, y
      una sola cuando no (recepciones viejas: la columna es nueva y va en NULL).
   D) Si la columna foto_factura_url NO existe todavía, ni el guardado ni la lista de
      Pendientes se rompen — es lo que permite desplegar el front antes que el SQL. */
const fs = require("fs");
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) { try { ({ chromium } = require("playwright")); } catch (_e2) { console.error("Playwright no encontrado."); process.exit(2); } }

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "recepcion.js"), "utf8");

// Mismo stub que rcp-foto-detalle.cjs: recepcion.js toma createClient de window.supabase.
// `__fake.colFalta` simula que la columna foto_factura_url TODAVÍA no existe: PostgREST
// contesta el mismo error que en producción y así se prueba el camino D.
const FAKE_CLIENT = `
const __fake = { pend: [], colFalta: false };
window.__fakePend = function (rows) { __fake.pend = rows; };
window.__fakeColFalta = function (v) { __fake.colFalta = !!v; };
window.__sel = [];
function __q(table) {
  const o = {}; let cols = "";
  ["gte","lte","neq","in","not","or","ilike","order","limit","single","delete","update","insert"]
    .forEach(function (m) { o[m] = function () { return o; }; });
  o.eq = function () { return o; };
  o.select = function (c) { cols = c || ""; window.__sel.push(cols); return o; };
  o.then = function (res, rej) {
    if (__fake.colFalta && /foto_factura_url/.test(cols)) {
      return Promise.resolve({ data: null, error: { message: 'column Control_Modo_OP.foto_factura_url does not exist', code: 'PGRST204' } }).then(res, rej);
    }
    return Promise.resolve({ data: (table === "Control_Modo_OP" ? __fake.pend : []), error: null }).then(res, rej);
  };
  return o;
}
window.supabase = { createClient: function () {
  return {
    from: __q,
    rpc: function () { return Promise.resolve({ data: null, error: null }); },
    storage: { from: function () { return { upload: function () { return Promise.resolve({ error: null }); },
      getPublicUrl: function () { return { data: { publicUrl: "x" } }; } }; } },
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: { fake: true } } }); },
      signInAnonymously: function () { return Promise.resolve({ data: { session: { fake: true } }, error: null }); }
    }
  };
} };
`;

const patched = src + `
window.__rcp = { opState: opState, renderResumen: renderResumen, renderPendientes: renderPendientes };
`;

if (!/window\.supabase/.test(src)) { console.error("rcp-foto-remito-factura: recepcion.js ya no toma createClient de window.supabase — actualizá el stub."); process.exit(1); }

const PX = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.setContent('<!doctype html><meta charset="utf-8"><body><script>' + FAKE_CLIENT + '<\/script><script type="module">' + patched + "<\/script></body>");
  await p.waitForFunction(() => !!window.__rcp, null, { timeout: 10000 });

  const r = await p.evaluate(async (PX) => {
    const R = window.__rcp, S = R.opState, out = {};
    const $ = (s) => document.querySelectorAll(s);

    function pedirFotos(tipoDoc) {
      S.tipoDoc = tipoDoc;
      S.cargas = { "500": 3 };
      S.articulos = [{ cod: "500", desc: "x" }];
      S.fotoFile = null; S.fotoFile2 = null;
      S.fotoPreviewUrl = null; S.fotoPreviewUrl2 = null;
      R.renderResumen();
      return {
        bloques: $("#rcpRoot .opFotoSection").length,
        titulos: Array.from($("#rcpRoot .opFotoTitulo")).map((e) => e.textContent.trim()),
        confirmarOff: !!(document.getElementById("opConfirmar") || {}).disabled,
        inputs: $("#rcpRoot .opFotoSection input[type=file]").length
      };
    }

    // ---- A: "Remito y Factura" pide DOS
    out.rf = pedirFotos("remito_factura");
    S.fotoFile = new File(["a"], "r.jpg", { type: "image/jpeg" });
    R.renderResumen();
    out.conUnaSolaSigueOff = !!(document.getElementById("opConfirmar") || {}).disabled;
    S.fotoFile2 = new File(["b"], "f.jpg", { type: "image/jpeg" });
    R.renderResumen();
    out.conLasDosHabilita = !(document.getElementById("opConfirmar") || {}).disabled;

    // ---- B: un solo documento sigue pidiendo UNA
    out.soloRemito = pedirFotos("remito");
    S.fotoFile = new File(["a"], "r.jpg", { type: "image/jpeg" });
    R.renderResumen();
    out.unaSolaHabilita = !(document.getElementById("opConfirmar") || {}).disabled;
    out.soloFactura = pedirFotos("factura");

    // ---- C: el visor muestra las DOS
    const fila = {
      id: 91, fecha: "2026-09-03", tipo: "tallerista", nombre: "Lucho", linea: "LK",
      remito: "12345", detalle: "518 → 12", cantidad_total: 12,
      created_at: new Date().toISOString(), isis: false, control_partes: null,
      foto_url: PX, foto_factura_url: PX, foto_vista: false, codigo: "4321"
    };
    window.__fakePend([fila]);
    await R.renderPendientes();
    await new Promise((r2) => setTimeout(r2, 30));
    const card = document.querySelector('#rcpRoot .pendCard[data-id="91"]');
    const btn = card && card.querySelector(".fotoViewBtn");
    out.botonDice2 = !!btn && /\(2\)/.test(btn.textContent);
    if (btn) btn.click();
    let ov = document.querySelector("#rcpRoot .fotoOverlay");
    out.dosImgs = !!ov && ov.querySelectorAll(".fotoOverlayCel img").length === 2;
    out.rotulos = !!ov && Array.from(ov.querySelectorAll(".fotoOverlayCelTit")).map((e) => e.textContent).join("|");
    if (ov) ov.querySelector(".fotoOverlayClose").click();
    await new Promise((r2) => setTimeout(r2, 20));

    // ---- C-bis: recepción vieja (sin la segunda foto) → UNA sola, como antes
    window.__fakePend([Object.assign({}, fila, { id: 92, foto_factura_url: null })]);
    await R.renderPendientes();
    await new Promise((r2) => setTimeout(r2, 30));
    const card2 = document.querySelector('#rcpRoot .pendCard[data-id="92"]');
    const btn2 = card2 && card2.querySelector(".fotoViewBtn");
    out.viejaDiceUna = !!btn2 && /Ver foto/.test(btn2.textContent) && !/\(2\)/.test(btn2.textContent);
    if (btn2) btn2.click();
    ov = document.querySelector("#rcpRoot .fotoOverlay");
    out.viejaUnaImg = !!ov && ov.querySelectorAll("img").length === 1;
    if (ov) ov.querySelector(".fotoOverlayClose").click();
    await new Promise((r2) => setTimeout(r2, 20));

    // ---- D: sin la columna creada, Pendientes NO se rompe
    window.__fakeColFalta(true);
    window.__sel = [];
    window.__fakePend([Object.assign({}, fila, { id: 93 })]);
    await R.renderPendientes();
    await new Promise((r2) => setTimeout(r2, 40));
    out.sinColumnaIgualLista = !!document.querySelector('#rcpRoot .pendCard[data-id="93"]');
    out.reintentoSinColumna = window.__sel.some((c) => /foto_factura_url/.test(c))
                           && window.__sel.some((c) => !/foto_factura_url/.test(c) && /foto_url/.test(c));
    return out;
  }, PX);

  const fails = [];
  const ck = (ok, m) => { if (!ok) fails.push(m); };

  ck(r.rf.bloques === 2, "A: con 'Remito y Factura' se dibujaron " + r.rf.bloques + " bloques de foto (esperaba 2)");
  ck(r.rf.inputs === 2, "A: hay " + r.rf.inputs + " <input type=file> (esperaba 2, uno por foto)");
  ck(r.rf.titulos.length === 2 && /REMITO/i.test(r.rf.titulos[0]) && /FACTURA/i.test(r.rf.titulos[1]),
     "A: los rótulos salieron " + JSON.stringify(r.rf.titulos) + " (esperaba REMITO y FACTURA)");
  ck(r.rf.confirmarOff === true, "A: sin fotos, Confirmar tendría que estar deshabilitado");
  ck(r.conUnaSolaSigueOff === true, "A: con UNA sola foto Confirmar se habilitó — tiene que exigir las dos");
  ck(r.conLasDosHabilita === true, "A: con las dos fotos Confirmar sigue deshabilitado");
  ck(r.soloRemito.bloques === 1, "B: con sólo remito se dibujaron " + r.soloRemito.bloques + " bloques (esperaba 1)");
  ck(r.soloFactura.bloques === 1, "B: con sólo factura se dibujaron " + r.soloFactura.bloques + " bloques (esperaba 1)");
  ck(r.unaSolaHabilita === true, "B: con un solo documento y su foto, Confirmar tiene que habilitarse");
  ck(r.botonDice2 === true, "C: el botón del visor no anuncia las 2 fotos");
  ck(r.dosImgs === true, "C: el visor no mostró las DOS imágenes");
  ck(/Remito/.test(r.rotulos || "") && /Factura/.test(r.rotulos || ""),
     "C: faltan los rótulos Remito/Factura en el visor (salió '" + r.rotulos + "')");
  ck(r.viejaDiceUna === true, "C-bis: una recepción vieja (sin foto de factura) tiene que decir 'Ver foto', sin (2)");
  ck(r.viejaUnaImg === true, "C-bis: una recepción vieja mostró más de una imagen");
  ck(r.sinColumnaIgualLista === true, "D: sin la columna foto_factura_url, Pendientes dejó de listar — no puede romperse por una foto");
  ck(r.reintentoSinColumna === true, "D: no se ve el reintento del select sin la columna");
  ck(errs.length === 0, "errores de página: " + errs.join(" | "));

  await b.close();
  if (fails.length) { console.error("rcp-foto-remito-factura: FALLÓ\n - " + fails.join("\n - ")); process.exit(1); }
  console.log("rcp-foto-remito-factura: OK (2 fotos en Remito y Factura, 1 en los simples, las 2 en el visor, y no rompe sin la columna)");
  process.exit(0);
})();
