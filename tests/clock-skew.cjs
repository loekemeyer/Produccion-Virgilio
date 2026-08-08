/* Regresión — idea 9782: detectar reloj del celular desincronizado (clock skew).
   _checkClockSkew(res) lee el header Date de la respuesta y compara contra Date.now();
   si el desfasaje supera el umbral (5 min) muestra un banner dismissible en
   #clockSkewBanner con la dirección (adelantado/atrasado) y los minutos. Por debajo
   del umbral, o tras descartarlo, el banner queda vacío. Sale 1 si falla. */
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
    const mkRes = function (dateHeader) { return { headers: { get: function (k) { return k === "date" ? dateHeader : null; } } }; };

    // ---- dentro del umbral: no banner ----
    _checkClockSkew(mkRes(new Date(Date.now()).toUTCString()));
    out.dentroUmbral_vacio = document.getElementById("clockSkewBanner").innerHTML === "";

    // ---- adelantado 20 min: banner con "adelantado" y "20" ----
    _clockSkewDismissed = false;
    _checkClockSkew(mkRes(new Date(Date.now() - 20 * 60000).toUTCString()));   // server 20min en el pasado → cliente adelantado
    const htmlAdel = document.getElementById("clockSkewBanner").innerHTML;
    out.adelantado_muestra = htmlAdel.indexOf("adelantado") >= 0 && htmlAdel.indexOf("20") >= 0;

    // ---- atrasado 45 min ----
    _clockSkewDismissed = false;
    _checkClockSkew(mkRes(new Date(Date.now() + 45 * 60000).toUTCString()));   // server 45min en el futuro → cliente atrasado
    const htmlAtr = document.getElementById("clockSkewBanner").innerHTML;
    out.atrasado_muestra = htmlAtr.indexOf("atrasado") >= 0 && htmlAtr.indexOf("45") >= 0;

    // ---- dismiss: banner queda vacío aunque el skew siga vigente ----
    dismissClockSkewBanner();
    out.dismiss_vacio = document.getElementById("clockSkewBanner").innerHTML === "";
    // un nuevo chequeo con el MISMO desfasaje no debe reaparecer (dismissed persiste)
    _checkClockSkew(mkRes(new Date(Date.now() + 45 * 60000).toUTCString()));
    out.dismiss_persiste = document.getElementById("clockSkewBanner").innerHTML === "";

    // ---- header ausente / inválido: no rompe, no banner ----
    _clockSkewMs = null; _clockSkewDismissed = false;
    _checkClockSkew(mkRes(null));
    out.sinHeader_noRompe = document.getElementById("clockSkewBanner").innerHTML === "" && _clockSkewMs === null;
    _checkClockSkew(mkRes("fecha-invalida"));
    out.headerInvalido_noRompe = document.getElementById("clockSkewBanner").innerHTML === "" && _clockSkewMs === null;

    // ---- res sin headers (ej. objeto mockeado a medias en otro test) no rompe ----
    _checkClockSkew({});
    out.sinHeaders_noRompe = true;   // si no tiró excepción, ok

    return out;
  });
  const pass = r.dentroUmbral_vacio && r.adelantado_muestra && r.atrasado_muestra &&
    r.dismiss_vacio && r.dismiss_persiste && r.sinHeader_noRompe && r.headerInvalido_noRompe && r.sinHeaders_noRompe &&
    errs.length === 0;
  console.log("clock-skew:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
