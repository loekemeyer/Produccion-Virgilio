/* Test de regresión (v7.68) — EDITOR de config del generador de OCs. Desde v7.68 la lista
   sale SOLA de stock (vista_generador_oc): acá solo se configura proveedor(es) + % + índice +
   activo. Ya NO hay columna Objetivo, ni "➕ Agregar artículo", ni uni×caja editable. Verifica
   sobre funciones puras/estado (sin red, sin sesión):
   - ocBodyCfg() dibuja Proveedor 1/2 (dropdown) · % P1/P2 · Uni×Caja (solo lectura) · Índice · Activo,
     y NO dibuja Objetivo ni "Agregar artículo",
   - el desplegable ofrece "(sin proveedor)" y resalta las filas sin proveedor,
   - ocCfgEdit acumula un PATCH parcial por código en _oc.cfg.changed,
   - ocCfgSetAllIndice pone el índice a todos y lo registra como cambio.
   Sale 1 si falla. */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("Playwright no encontrado (ver tests/smoke.cjs)."); process.exit(2); }
}

(async () => {
  const root = path.join(__dirname, "..");
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("file://" + path.join(root, "index.html"), { waitUntil: "domcontentloaded" });

  const r = await p.evaluate(() => {
    const out = {};
    _oc = { view: "cfg", cfg: {
      changed: {}, filtro: "", error: null, altaProv: null,
      provs: ["Lucho", "Poly", "Garcia"],
      rows: [
        { cod: "107", descripcion: "Colador", proveedor: "Lucho", prop_prov1: 100, proveedor2: "", prop_prov2: 0, uni_x_caja: 12, indice: 1.5, activo: true, en_config: true, total: 40 },
        { cod: "202", descripcion: "SinProv", proveedor: "", prop_prov1: 100, proveedor2: "", prop_prov2: 0, uni_x_caja: 24, indice: 1.5, activo: true, en_config: false, total: 10 }
      ]
    } };
    ocRender = function () {};   // sin re-dibujar el modal

    const html = ocBodyCfg();
    out.cols = ["Proveedor 1", "% P1", "Proveedor 2", "% P2", "Uni×Caja", "Índice", "Activo"].every((c) => html.indexOf(c) >= 0);
    out.noObjetivoCol = html.indexOf(">Objetivo<") < 0;                 // ya no hay columna Objetivo
    out.noAlta = html.indexOf("➕ Agregar artículo") < 0;              // ya no se dan de alta a mano
    out.noMaxInput = html.indexOf("max_cajas") < 0;                    // no hay input de objetivo
    out.provDropdown = html.indexOf("(sin proveedor)") >= 0;           // opción del desplegable
    out.provOption = html.indexOf('value="Lucho"') >= 0;               // proveedor cargado como <option>
    out.sinProvHighlight = html.indexOf("#fff7ed") >= 0;               // fila sin proveedor resaltada
    out.stockWord = html.indexOf("sola de stock") >= 0;               // texto nuevo (la lista sale de stock)

    // Editar proveedor + índice del 107 → PATCH parcial acumulado (merge)
    ocCfgEdit(0, "proveedor", "Poly");
    ocCfgEdit(0, "indice", "2");
    out.mergePatch = _oc.cfg.changed["107"] && _oc.cfg.changed["107"].proveedor === "Poly" && _oc.cfg.changed["107"].indice === 2;
    out.rowUpdated = _oc.cfg.rows[0].proveedor === "Poly";

    // Desactivar el 202
    ocCfgEdit(1, "activo", false);
    out.activoOff = _oc.cfg.changed["202"] && _oc.cfg.changed["202"].activo === false;

    out.changedN = Object.keys(_oc.cfg.changed).length === 2;   // 107 y 202

    // Índice a todos (necesita el input #ociAll en el DOM).
    // Se AGREGA el input; antes acá había un `document.body.innerHTML = ...` que borraba
    // el DOM entero de la app. Cualquier timer de la página que corriera después
    // (el refresco de Facturación, el chequeo de versión, los badges) se encontraba con
    // sus elementos desaparecidos y tiraba "Cannot read properties of null", que el test
    // cuenta como pageerror y hace fallar algo que no tiene nada que ver. Era una carrera:
    // fallaba según cuándo cayera el timer, o sea rara vez en una máquina rápida y seguido
    // en un runner lento — el patrón de la CI, que está en rojo hace rato.
    const _inpAll = document.createElement("input");
    _inpAll.id = "ociAll"; _inpAll.value = "3";
    document.body.appendChild(_inpAll);
    ocCfgSetAllIndice();
    out.setAll = _oc.cfg.rows.every((a) => a.indice === 3) &&
                 _oc.cfg.changed["107"].indice === 3 && _oc.cfg.changed["202"].indice === 3;
    return out;
  });

  await b.close();
  const fail = [];
  Object.keys(r).forEach(function (k) { if (r[k] !== true) fail.push(k + "=" + JSON.stringify(r[k])); });
  if (errs.length) fail.push("pageerror: " + errs.join(" | "));
  if (fail.length) { console.error("ocg-config: FALLÓ →", fail.join(", ")); process.exit(1); }
  console.log("ocg-config: OK — editor de config (proveedor dropdown + '(sin proveedor)' + índice/activo, lista desde stock)");
  process.exit(0);
})();
