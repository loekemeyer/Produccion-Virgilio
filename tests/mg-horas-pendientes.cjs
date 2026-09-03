/* Regresión (pedido del dueño, 2026-09-03): el operario tiene que ver, en el módulo de
   guardado de mercadería, CUÁNTAS HORAS hay para guardar.

   No es un cálculo nuevo: reusa el mismo que la tarjeta del supervisor (v6.30/v8.91),
   backlog ÷ `Stock_Config.guardado_cajas_por_hora`, ratio que el cron recalcula con las
   sesiones reales. Lo que blinda:

   A) El número sale de las cajas de la lista y del ratio traído: con los datos de hoy
      (1.185 cajas, 236 cajas/h) tiene que decir 5 h, NO 3,1 h (que es lo que daría con
      la semilla de 380 si alguien saca el fetch del ratio).
   B) Menos de una hora se muestra en MINUTOS.
   C) Los colores del semáforo son los mismos umbrales que el del supervisor (≥4 ámbar,
      >6 rojo), para que las dos pantallas no se contradigan.
   D) Filtrar por código NO cambia las horas: es el trabajo total, no lo que se ve.
   E) Sin nada para guardar, la tarjeta no aparece. */
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

  const r = await p.evaluate(() => {
    const out = {};
    document.body.insertAdjacentHTML("beforeend", '<div id="mgModal"><div id="mgBody"></div></div>');
    const card = () => document.querySelector("#mgBody .mg-horas");
    const txt = () => { const n = document.querySelector("#mgBody .mg-horas-n"); return n ? n.textContent.trim() : null; };
    const sub = () => { const n = document.querySelector("#mgBody .mg-horas-sub"); return n ? n.textContent.trim() : null; };
    const col = () => { const n = document.querySelector("#mgBody .mg-horas-n"); return n ? n.style.color : null; };

    function armar(items, rate, filtro) {
      _mg = { legajo: "99", items: items, filtro: filtro || "", tsInicio: Date.now(), rate: rate };
      mgRender();
    }
    const it = (cod, disp) => ({ cod: cod, desc: "x", disponible: disp, gond: 0, cap: 0, celdas: [], prio: 1, cargar: 0, exc: 0, ubic: "", excOn: false });

    // A) datos REALES de hoy: 1.185 cajas y ratio medido 236 → 5 h
    armar([it("500", 600), it("501", 585)], 236);
    out.hoy = txt(); out.hoySub = sub();

    // Con la semilla 380 daría 3,1 h — sirve para detectar que se perdió el fetch del ratio
    armar([it("500", 600), it("501", 585)], 380);
    out.conSemilla = txt();

    // B) menos de una hora → minutos
    armar([it("500", 100)], 236);
    out.corto = txt();

    // C) semáforo: mismos umbrales que la tarjeta del supervisor
    armar([it("500", 236 * 2)], 236);  out.col2h = col();    // 2 h  → verde
    armar([it("500", 236 * 5)], 236);  out.col5h = col();    // 5 h  → ámbar
    armar([it("500", 236 * 8)], 236);  out.col8h = col();    // 8 h  → rojo

    // D) filtrar no cambia el total
    armar([it("500", 600), it("501", 585)], 236, "500");
    out.filtrado = txt();

    // E) sin nada para guardar, no hay tarjeta
    armar([], 236);
    out.sinNada = !card();

    /* F) Sin el ritmo REAL todavía (llega en segundo plano), la tarjeta NO aparece.
       stkGRate() devolvería la semilla de 380 y el número saldría ~60% bajo; mostrarlo y
       corregirlo un segundo después es peor que esperar. */
    try { _stk = null; } catch (_e) {}
    armar([it("500", 600), it("501", 585)], null);
    out.sinRitmo = !card();
    return out;
  });

  const fails = [];
  const ck = (ok, m) => { if (!ok) fails.push(m); };

  ck(r.hoy === "5 h", 'A: con 1.185 cajas y 236 cajas/h dio "' + r.hoy + '" (esperaba "5 h")');
  ck(/1185 cajas ÷ 236 cajas\/h/.test(r.hoySub || ""), 'A: el detalle dice "' + r.hoySub + '"');
  ck(r.conSemilla === "3.1 h", 'A: control de la semilla — con 380 tendría que dar "3.1 h", dio "' + r.conSemilla + '"');
  ck(r.hoy !== r.conSemilla, "A: el ratio no se está usando (mismo resultado con 236 que con 380)");
  ck(r.corto === "25 min", 'B: 100 cajas a 236/h dio "' + r.corto + '" (esperaba "25 min")');
  ck(r.col2h === "rgb(22, 101, 52)", 'C: 2 h tendría que ser verde, dio "' + r.col2h + '"');
  ck(r.col5h === "rgb(180, 83, 9)", 'C: 5 h tendría que ser ámbar, dio "' + r.col5h + '"');
  ck(r.col8h === "rgb(185, 28, 28)", 'C: 8 h tendría que ser rojo, dio "' + r.col8h + '"');
  ck(r.filtrado === "5 h", 'D: al filtrar por un código las horas cambiaron a "' + r.filtrado + '" (son el trabajo TOTAL)');
  ck(r.sinNada === true, "E: sin nada para guardar la tarjeta igual apareció");
  ck(r.sinRitmo === true, "F: sin el ritmo real la tarjeta apareció igual — mostraría la semilla de 380 (~60% bajo)");
  ck(errs.length === 0, "errores de página: " + errs.join(" | "));

  await b.close();
  if (fails.length) { console.error("mg-horas-pendientes: FALLÓ\n - " + fails.join("\n - ")); process.exit(1); }
  console.log("mg-horas-pendientes: OK (horas de guardado en la pantalla del operario, con el ratio medido)");
  process.exit(0);
})();
