/* Regresión (2026-09-03, foto del operario en la tanda D59A): la ubicación del
   excedente salía ilegible — "P9 · LK · P8 · LK · P9".

   Causa: en Movimientos_Stock hay ubicaciones con el sufijo de empresa pegado y
   escrito con el MISMO separador que el código usaba para unir varias ("P8 · LK",
   "P12 · CH"). Al hacer ubics.join(" · ") no se distinguía dónde terminaba un lugar
   y empezaba el otro. Y además "P9" y "P9 · LK" son el mismo estante, así que el
   operario veía la misma balda dos veces.

   Casos tomados de datos REALES:
     · art 186 (el de la foto): P8 · LK / P9 / P9 · LK   → "P8 y P9"
     · art 731 (el peor):       9 ubicaciones con CH     → 7 distintas de verdad
     · art 246:                 P19 / P19 · LK / P9 / P9 · LK → "P19 y P9" */
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
    // Normalización de una sola ubicación
    out.suf_punto   = pkUbicNorm("P9 · LK");
    out.suf_espacio = pkUbicNorm("P9 LK");
    out.suf_ch      = pkUbicNorm("P12 · CH");
    out.sinSufijo   = pkUbicNorm("P9");
    out.guiones     = pkUbicNorm("P-9 · LK");
    out.vacio       = pkUbicNorm(null);
    // Ojo: NO tiene que comerse una ubicación que TERMINE en otra cosa
    out.noRompe     = pkUbicNorm("P9 · A1");

    // Listas reales
    out.a186 = pkUbicLista(["P8 · LK", "P9", "P9 · LK"]);
    out.a246 = pkUbicLista(["P19", "P19 · LK", "P9", "P9 · LK"]);
    out.a731 = pkUbicLista(["P03", "P13", "P16", "P25", "P3", "P3 · CH", "P4", "P4 · CH", "P8"]);
    out.una  = pkUbicLista(["P8 · LK"]);
    out.ninguna = pkUbicLista([]);
    return out;
  });

  const fails = [];
  const ck = (ok, m) => { if (!ok) fails.push(m); };

  ck(r.suf_punto === "P9", 'norm: "P9 · LK" dio "' + r.suf_punto + '" (esperaba "P9")');
  ck(r.suf_espacio === "P9", 'norm: "P9 LK" dio "' + r.suf_espacio + '"');
  ck(r.suf_ch === "P12", 'norm: "P12 · CH" dio "' + r.suf_ch + '"');
  ck(r.sinSufijo === "P9", 'norm: "P9" dio "' + r.sinSufijo + '"');
  ck(r.guiones === "P9", 'norm: "P-9 · LK" dio "' + r.guiones + '"');
  ck(r.vacio === "", "norm: null tendría que dar cadena vacía");
  ck(r.noRompe === "P9 · A1", 'norm: se comió una ubicación que no es sufijo de empresa ("' + r.noRompe + '")');

  // El caso de la foto: tres entradas, dos lugares reales, y se lee.
  ck(r.a186 === "P8 y P9", 'art 186: dio "' + r.a186 + '" (esperaba "P8 y P9", no la sopa "P9 · LK · P8 · LK · P9")');
  ck(r.a246 === "P19 y P9", 'art 246: dio "' + r.a246 + '"');
  ck(r.a731 === "P03, P13, P16, P25, P3, P4 y P8", 'art 731: dio "' + r.a731 + '"');
  ck(r.una === "P8", 'una sola ubicación: dio "' + r.una + '"');
  ck(r.ninguna === "", "sin ubicaciones tendría que dar cadena vacía");
  // Lo esencial: el separador de la lista NO puede aparecer dentro de un lugar
  ck(r.a186.indexOf("·") < 0 && r.a731.indexOf("·") < 0,
     "quedó un '·' en la lista — vuelve a ser ambiguo");
  ck(errs.length === 0, "errores de página: " + errs.join(" | "));

  await b.close();
  if (fails.length) { console.error("pk-ubic-excedente: FALLÓ\n - " + fails.join("\n - ")); process.exit(1); }
  console.log("pk-ubic-excedente: OK (ubicación de excedente sin sufijo de empresa, sin repetidos y legible)");
  process.exit(0);
})();
