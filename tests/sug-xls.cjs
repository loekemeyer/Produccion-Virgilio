/* Regresión v6.66 — "*PRUEBA* Exportar Excel sugerido" (idea 6650, "PPP sin Excel").
   El Excel que genera pppExportSugExcel() tiene que volver a entrar por el MISMO
   importador de la PPP. Se stubea XLSX para capturar la matriz (AoA) en vez de bajar
   el archivo, y esa matriz se le pasa tal cual a pppEsPPPCompleta + pppLoadProgCompleta
   (el camino real de pppHandleFile('prog')). Comprueba:
   1) el importador RECONOCE el archivo como "PPP completa" (≥2 títulos de sección);
   2) vuelven los mismos pedidos, con su tanda, y la fila de encabezado NO entra como
      pedido;
   3) los de la sección "Programacion" quedan programados (edits.programmed);
   4) los súper caen en su sección y conservan tanda;
   5) los "sin zona" vuelven SIN tanda (a programar);
   6) la hoja se llama /programaci/i, que es como la busca pppHandleFile.
   Sale 1 si falla. */
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
    const ped = function (np, cod, rs, barrio, zona, m3, tipo) {
      return { np: np, cod: cod, razon_social: rs, localidad: barrio, zona: zona,
               m3: m3, tipo: tipo || "", fecha: "22/07/2026", fecha_entrega: "",
               direccion: "Calle Falsa " + np };
    };
    // Sugerencia sintética: 2 tandas normales, 1 súper (por zona "Super" del barrio) y 1 sin zona.
    // OJO: _pppSugCache es un `let` de script — hay que asignarlo SIN `window.` (si no,
    // se crea una propiedad aparte y la función sigue viendo null).
    _pppSugCache = {
      cap: 0.8,
      tandas: [
        { code: "E01A", sup: true, pedidos: [ped("90001", "801", "Coto C.I.C.S.A.", "Campo de Mayo", "Super", 0.9)] },
        { code: "E02A", zona: "Zona 1 - CABA Sur", pedidos: [ped("90002", "500", "Cliente Dos", "Barracas", "Zona 1 - CABA Sur", 0.4),
                                                              ped("90003", "501", "Cliente Tres", "Pompeya", "Zona 1 - CABA Sur", 0.3)] },
        { code: "E02B", zona: "Zona 4 - GBA Sur", pedidos: [ped("90004", "502", "Cliente Cuatro", "Quilmes", "Zona 4 - GBA Sur", 0.5)] }
      ],
      sinZona: [ped("90005", "503", "Cliente Cinco", "Barrio Inventado", "", 0.2)]
    };

    // Stub de SheetJS: captura la AoA y el nombre de hoja, no baja nada.
    let cap = null;
    window.XLSX = {
      utils: {
        aoa_to_sheet: function (aoa) { return { __aoa: aoa }; },
        book_new: function () { return { sheets: [] }; },
        book_append_sheet: function (wb, ws, name) { wb.sheets.push({ name: name, aoa: ws.__aoa }); }
      },
      writeFile: function (wb, fname) { cap = { fname: fname, sheet: wb.sheets[0] }; }
    };
    window.pppLoadXlsx = async function () { return window.XLSX; };

    await pppExportSugExcel();
    const st = document.getElementById("pppStatus");
    out.status = st ? st.textContent : "";
    if (!cap) { out.error = "pppExportSugExcel no llamó a writeFile"; return out; }

    const aoa = cap.sheet.aoa;
    out.fname = cap.fname;
    out.hojaOk = /programaci/i.test(cap.sheet.name);           // (6) como la busca pppHandleFile
    out.reconocido = pppEsPPPCompleta(aoa);                    // (1)
    out.cols15 = aoa.filter(function (r) { return r.length > 1; }).every(function (r) { return r.length === 15; });

    const res = pppLoadProgCompleta(aoa);                      // camino real del importador
    const byNp = {}; res.ped.forEach(function (x) { byNp[String(x.np)] = x; });
    out.nPed = res.ped.length;                                 // (2) 5 pedidos, sin encabezados
    out.nps = res.ped.map(function (x) { return String(x.np); }).sort();
    out.tandas = {
      "90001": (byNp["90001"] || {}).tanda, "90002": (byNp["90002"] || {}).tanda,
      "90003": (byNp["90003"] || {}).tanda, "90004": (byNp["90004"] || {}).tanda,
      "90005": (byNp["90005"] || {}).tanda
    };
    out.datosOk = !!(byNp["90002"] && byNp["90002"].razon_social === "Cliente Dos" &&
                     byNp["90002"].cod === "500" && Number(byNp["90002"].m3) === 0.4 &&
                     byNp["90002"].localidad === "Barracas" && byNp["90002"].zona === "Zona 1 - CABA Sur");
    out.programados = {                                        // (3) y (4)
      "90001": !!(res.edits["90001"] && res.edits["90001"].tanda === "E01A"),
      "90002": !!(res.edits["90002"] && res.edits["90002"].programmed),
      "90004": !!(res.edits["90004"] && res.edits["90004"].programmed)
    };
    out.sinZonaNoProgramado = !res.edits["90005"];             // (5)
    out.headerNoEsPedido = res.ped.every(function (x) { return /^\d/.test(String(x.np)); });
    return out;
  });

  await b.close();
  console.log("sug-xls:", JSON.stringify(r));
  console.log("  pageerrors:", errs.length ? errs.join(" | ") : "none");

  const fails = [];
  if (r.error) fails.push(r.error);
  if (!r.hojaOk) fails.push("la hoja no matchea /programaci/i");
  if (!r.reconocido) fails.push("pppEsPPPCompleta NO reconoce el archivo generado");
  if (!r.cols15) fails.push("hay filas de datos que no tienen 15 columnas");
  if (r.nPed !== 5) fails.push("esperaba 5 pedidos, volvieron " + r.nPed);
  if (!r.headerNoEsPedido) fails.push("una fila de encabezado entró como pedido");
  if (!r.datosOk) fails.push("los datos del pedido 90002 no volvieron iguales");
  const t = r.tandas || {};
  if (t["90001"] !== "E01A" || t["90002"] !== "E02A" || t["90003"] !== "E02A" || t["90004"] !== "E02B") fails.push("tandas mal: " + JSON.stringify(t));
  if (t["90005"] !== "—") fails.push("el pedido sin zona volvió con tanda: " + t["90005"]);
  const pr = r.programados || {};
  if (!pr["90001"] || !pr["90002"] || !pr["90004"]) fails.push("no quedaron programados: " + JSON.stringify(pr));
  if (!r.sinZonaNoProgramado) fails.push("el pedido sin zona quedó programado");
  if (errs.length) fails.push("pageerrors: " + errs.join(" | "));

  if (fails.length) { console.error("  ✗ FALLA: " + fails.join(" · ")); process.exit(1); }
  console.log("  reconocido ✓ · pedidos ✓ · tandas ✓ · programados ✓ · sin-zona ✓ · OK");
})();
