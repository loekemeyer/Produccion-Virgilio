/* Regresión v6.30 — Módulo "Líos por artículo" (admin): por artículo, distribución de
   cajas/lío cuando va SOLO (puro), y contador "Mezcla" cuando el lío tiene otro artículo.
   Con fetch (TAL) stubbeado. Sale 1 si falla. */
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
    window.requireSupervisor = function () { return true; };
    // TAL: texto = NP|count|TANDA|resumen
    const TAL = [
      { texto: "98114|3|C87A|A=505X6;B=505X6;C=505X3" },   // 505 puro: 6×2, 3×1
      { texto: "98115|1|C87A|A=505X6,520X3" },             // mezcla 505+520 → +1 mezcla c/u
      { texto: "98116|2|C88A|A=520X4;B=520X4" },           // 520 puro: 4×2
      { texto: "98117|1|C88A|A=505X6" }                    // 505 puro: +1 de 6
    ];
    function resp(rows) { return Promise.resolve({ ok: true, status: 200, headers: { get: function (h) { return String(h).toLowerCase() === "content-range" ? ("0-" + (rows.length - 1) + "/" + rows.length) : null; } }, json: function () { return Promise.resolve(rows); } }); }
    window.fetch = function (url) { url = String(url); if (url.indexOf("opcion=eq.TAL") >= 0) return resp(TAL); return resp([]); };
    openLiosArt();
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 50)); if (document.querySelector("#laWrap .la-tbl tbody tr")) break; }
    const out = {};
    const byCod = {};
    document.querySelectorAll("#laWrap .la-tbl tbody tr").forEach(function (tr) {
      const td = tr.querySelectorAll("td");
      const cod = td[0].textContent.trim();
      const chips = [...td[3].querySelectorAll(".d")].map(function (c) { return c.textContent.replace(/\s+/g, " ").trim(); });
      byCod[cod] = { lios: td[2].textContent.trim(), chips: chips, mez: td[4].textContent.trim() };
    });
    out.has505 = !!byCod["505"]; out.has520 = !!byCod["520"];
    out.p505_lios = byCod["505"] && byCod["505"].lios === "4";           // 6×3 + 3×1 = 4 líos solos
    out.p505_dist6 = byCod["505"] && byCod["505"].chips.indexOf("6 cj × 3") >= 0;
    out.p505_dist3 = byCod["505"] && byCod["505"].chips.indexOf("3 cj × 1") >= 0;
    out.p505_topEs6 = byCod["505"] && /6 cj/.test(byCod["505"].chips[0] || "");  // más común primero
    out.p505_mez = byCod["505"] && byCod["505"].mez === "1";
    out.p520_lios = byCod["520"] && byCod["520"].lios === "2";
    out.p520_dist4 = byCod["520"] && byCod["520"].chips.indexOf("4 cj × 2") >= 0;
    out.p520_mez = byCod["520"] && byCod["520"].mez === "1";
    // filtro
    document.getElementById("laQ").value = "520"; liosArtApply();
    out.filtro = document.querySelectorAll("#laWrap .la-tbl tbody tr").length === 1;
    return out;
  });

  const pass = r.has505 && r.has520 && r.p505_lios && r.p505_dist6 && r.p505_dist3 &&
    r.p505_topEs6 && r.p505_mez && r.p520_lios && r.p520_dist4 && r.p520_mez && r.filtro && errs.length === 0;
  console.log("lios-art:", JSON.stringify(r));
  console.log("  pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close();
  process.exit(pass ? 0 : 1);
})();
