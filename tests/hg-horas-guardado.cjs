/* Regresión (pedido del dueño, 2026-09-03): botón "⏱ Horas guardado" en el módulo de
   operarios, para ver cuánto trabajo de guardado hay y de qué se compone (mercadería a
   guardar / racks / excedente).

   LO CRÍTICO ES QUE NO REGISTRE NADA. El dueño lo pidió explícito: "que no genere
   registro de cuánto tiempo le dedicó a ver eso, eso no tiene que tomarse". Mirar cuánto
   falta no es una tarea y no puede descontarle horas al operario. Este test falla si
   alguien le cuelga un evento, un toggle o una entrada de historial.

   A) El botón existe en la botonera y abre el modal.
   B) NO emite evento: ni enqueueReport, ni pushHistoryForLegajo, ni fetch de escritura a
      Registros_Produccion_Virgilio, ni estado de toggle para el legajo.
   C) El desglose usa el ratio real y suma: total = a_guardar + racks + excedente.
   D) Menos de una hora se muestra en minutos.
   E) Sin ratio no inventa un número. */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) { try { ({ chromium } = require("playwright")); } catch (_e2) { console.error("Playwright no encontrado."); process.exit(2); } }

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("file://" + path.join(__dirname, "..", "index.html"), { waitUntil: "domcontentloaded" });

  const r = await p.evaluate(async () => {
    const out = {};

    // ---- B: espiar TODO lo que podría dejar registro
    const espia = { enqueue: 0, hist: 0, postEventos: 0, otrosPost: 0 };
    if (typeof enqueueReport === "function") { const o = enqueueReport; window.enqueueReport = function () { espia.enqueue++; return o.apply(this, arguments); }; }
    if (typeof pushHistoryForLegajo === "function") { const o = pushHistoryForLegajo; window.pushHistoryForLegajo = function () { espia.hist++; return o.apply(this, arguments); }; }
    const of = window.fetch;
    window.fetch = function (u, opts) {
      const url = String(u), m = String((opts && opts.method) || "GET").toUpperCase();
      if (m !== "GET") {
        if (/Registros_Produccion_Virgilio/.test(url)) espia.postEventos++;
        else espia.otrosPost++;
      }
      // Stock_Config → el ratio; vista_saldos_stock → los saldos
      if (/Stock_Config/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve([{ valor: "236" }]) });
      return of.apply(this, arguments);
    };
    // stockFetchSaldos pagina con supaFetchAll (headers Range), así que se stubea la
    // función entera en vez del fetch. Números REALES del 03/09.
    window.stockFetchSaldos = async function () {
      return {
        "500": { cod: "500", desc: "A", a_guardar: 1185, racks: 0, excedente: 0 },
        "501": { cod: "501", desc: "B", a_guardar: 0, racks: 16658, excedente: 0 },
        "502": { cod: "502", desc: "C", a_guardar: 0, racks: 0, excedente: 1216 }
      };
    };

    // ---- A: el botón está en la botonera
    const btn = document.querySelector('#row4 .box[data-code="HG"]');
    out.botonExiste = !!btn;
    out.botonTexto = btn ? btn.textContent.replace(/\s+/g, " ").trim() : null;

    const legajo = "77";
    try { legajoInput.value = legajo; } catch (_e) {}
    const estadoAntes = JSON.stringify((typeof getLegajoState === "function") ? getLegajoState(legajo) : {});

    if (btn) btn.click();
    await new Promise((r2) => setTimeout(r2, 250));

    const ov = document.getElementById("hgModal");
    out.modalAbrio = !!(ov && ov.style.display !== "none");
    out.texto = ov ? ov.textContent.replace(/\s+/g, " ") : "";

    const estadoDespues = JSON.stringify((typeof getLegajoState === "function") ? getLegajoState(legajo) : {});
    out.estadoIgual = estadoAntes === estadoDespues;
    out.espia = espia;

    // ---- C/D/E: el cuerpo, con números fijos
    out.body_total = (function () {
      const h = hgBody(1185, 16658, 1216, 236);
      const m = h.match(/font-size:32px[^>]*>([^<]+)</);
      return m ? m[1].trim() : null;
    })();
    out.body_min = (function () {
      const h = hgBody(100, 0, 0, 236);
      const m = h.match(/font-size:32px[^>]*>([^<]+)</);
      return m ? m[1].trim() : null;
    })();
    out.body_sinRate = /No pude traer el ritmo/.test(hgBody(1185, 0, 0, 0));
    window.fetch = of;
    return out;
  });

  const fails = [];
  const ck = (ok, m) => { if (!ok) fails.push(m); };

  ck(r.botonExiste === true, "A: no está el botón HG en la botonera del operario");
  ck(/Horas guardado/.test(r.botonTexto || ""), 'A: el botón dice "' + r.botonTexto + '"');
  ck(r.modalAbrio === true, "A: el botón no abrió el modal");

  // B — lo que el dueño pidió explícitamente
  ck(r.espia.enqueue === 0, "B: se encoló un evento (enqueueReport ×" + r.espia.enqueue + ") — esto NO tiene que registrarse");
  ck(r.espia.hist === 0, "B: se escribió historial del legajo (×" + r.espia.hist + ") — esto NO tiene que registrarse");
  ck(r.espia.postEventos === 0, "B: se mandó un evento a Registros_Produccion_Virgilio (×" + r.espia.postEventos + ")");
  ck(r.espia.otrosPost === 0, "B: hubo " + r.espia.otrosPost + " escritura(s) a la base — la consulta tiene que ser sólo lectura");
  ck(r.estadoIgual === true, "B: cambió el estado del legajo (quedó un toggle abierto)");

  // C/D/E
  ck(/1185/.test(r.texto) && /16658/.test(r.texto) && /1216/.test(r.texto),
     "C: el modal no muestra las cajas de los tres depósitos");
  ck(/Racks/.test(r.texto) && /Excedente/.test(r.texto) && /Mercader/.test(r.texto),
     "C: falta alguno de los tres rubros en el modal");
  ck(/no registra tiempo/.test(r.texto), "C: falta el aviso de que mirar esto no registra tiempo");
  // (1185 + 16658 + 1216) / 236 = 80,8 h
  ck(r.body_total === "80.8 h", 'C: el total dio "' + r.body_total + '" (esperaba "80.8 h")');
  ck(r.body_min === "25 min", 'D: 100 cajas dio "' + r.body_min + '" (esperaba "25 min")');
  ck(r.body_sinRate === true, "E: sin ratio tendría que avisar, no mostrar un número inventado");
  ck(errs.length === 0, "errores de página: " + errs.join(" | "));

  await b.close();
  if (fails.length) { console.error("hg-horas-guardado: FALLÓ\n - " + fails.join("\n - ")); process.exit(1); }
  console.log("hg-horas-guardado: OK (desglose por depósito y, sobre todo, SIN registrar tiempo)");
  process.exit(0);
})();
