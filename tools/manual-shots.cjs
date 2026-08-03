/* Capturas para el MANUAL DE USO (docs/manual/img/*.png).
   Abre index.html headless, siembra estado MOCK (los mismos globals que usa la app:
   _pk, _comp, _mg, _cc, _cr …), llama a las funciones de render y saca el PNG.
   NO toca la red: todas las llamadas a Supabase se interceptan y devuelven [].

   Uso:  node tools/manual-shots.cjs            (todas)
         node tools/manual-shots.cjs picking    (solo las que matchean)
*/
const path = require("path");
const fs = require("fs");
const http = require("http");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) { ({ chromium } = require("playwright")); }

const ROOT = path.join(__dirname, "..");
const OUT = process.env.MANUAL_OUT || path.join(ROOT, "docs", "manual", "img");
const SCALE = Number(process.env.MANUAL_SCALE || 2);   // 1 = versión liviana (para embeber)
const only = process.argv.slice(2);

const MOBILE = { width: 430, height: 900 };
const DESK = { width: 1280, height: 850 };

fs.mkdirSync(OUT, { recursive: true });

/* ── Datos mock (nombres/códigos de ejemplo, no son datos reales) ───────── */
const PK_ITEMS = [
  { art: "502", key: "502", esp: 6, sector: "B04", dual: null, real: null, realNota: null },
  { art: "438E", key: "438E", esp: 4, sector: "F13", dual: null, real: null, realNota: null },
  { art: "809E", key: "809E", esp: 12, sector: "M14", dual: null, real: null, realNota: null },
  { art: "440E", key: "440E", esp: 3, sector: "H21", dual: null, real: null, realNota: null },
  { art: "581T", key: "581T", esp: 8, sector: "C15", dual: null, real: null, realNota: null }
];

const NPS = [
  { np: "97754", rs: "Distribuidora del Norte S.R.L.", dir: "Av. Mitre 1234", cod: "1042", lios: null },
  { np: "97761", rs: "Autoservicio La Esquina", dir: "Rivadavia 880", cod: "2210", lios: null }
];

const shots = [];
function shot(name, fn, opts) { shots.push({ name, fn, opts: opts || {} }); }

/* ─────────────────────── OPERARIOS ─────────────────────── */

shot("01-login", async (p) => {
  await p.evaluate(() => {
    const b = document.getElementById("googleSignInBtn"); if (b) b.disabled = false;
    const s = document.getElementById("authStatus"); if (s) s.textContent = "Elegí cómo entrar";
  });
  return "body";
}, { clip: { height: 470 } });

shot("02-botonera", async (p) => {
  await p.evaluate(() => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    const u = document.getElementById("userTag");
    if (u) { u.textContent = "Juan P. · legajo 104"; u.classList.remove("hidden"); }
  });
  return "body";
}, { clip: { height: 620 } });

shot("03-picking-articulo", async (p) => {
  await p.evaluate((items) => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    const m = document.getElementById("tandaModal");
    m.querySelector(".tanda-modal-title").textContent = "Picking — Tanda C15A";
    m.classList.add("show");
    _pk = { tanda: "C15A", legajo: "104", items: items, idx: 1, results: { "502": 6 }, mode: "" };
    pkRender();
  }, PK_ITEMS);
  return "#tandaModal .tanda-modal-card";
});

shot("04-picking-falta", async (p) => {
  await p.evaluate((items) => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    const m = document.getElementById("tandaModal");
    m.querySelector(".tanda-modal-title").textContent = "Picking — Tanda C15A";
    m.classList.add("show");
    _pk = { tanda: "C15A", legajo: "104", items: items, idx: 1, results: { "502": 6 }, mode: "fInput" };
    pkRender();
  }, PK_ITEMS);
  return "#tandaModal .tanda-modal-card";
});

shot("05-picking-fin", async (p) => {
  await p.evaluate((items) => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    const m = document.getElementById("tandaModal");
    m.querySelector(".tanda-modal-title").textContent = "Picking — Tanda C15A";
    m.classList.add("show");
    _pk = {
      tanda: "C15A", legajo: "104", items: items, idx: items.length,
      results: { "502": 6, "438E": 4, "809E": 10, "440E": 3, "581T": 8 }, mode: ""
    };
    pkRender();
  }, PK_ITEMS);
  return "#tandaModal .tanda-modal-card";
});

/* Armado — wizard de 3 pasos (#completarModal) */
function seedComp(p, step) {
  return p.evaluate(({ nps, step }) => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    const pedidoFull = [
      { np: "97754", cod: "1042", items: [{ art: "502", cajas: 4 }, { art: "438E", cajas: 3 }, { art: "809E", cajas: 6 }] },
      { np: "97761", cod: "2210", items: [{ art: "440E", cajas: 3 }, { art: "581T", cajas: 8 }] }
    ];
    _comp = {
      legajo: "104", tanda: "C15A", fecha: "", nps: JSON.parse(JSON.stringify(nps)),
      arts: [{
        art: "809E", falta: 2, real: 10,
        nps: [{ np: "97754", cod: "1042", rs: nps[0].rs, pidio: 6, asig: 2 }], auto: true
      }],
      pedidoFull: pedidoFull, hayFalt: true, step: step,
      pickUbic: "Mesa 3", dirByNp: { "97754": nps[0].dir, "97761": nps[1].dir },
      liosNpIdx: 0
    };
    document.getElementById("compTanda").textContent = "Tanda C15A · " + nps[0].rs;
    _compBuildLiosData();
    _compRenderFalt();
    _compGo(step);
    document.getElementById("completarModal").classList.add("show");
  }, { nps: NPS, step });
}
shot("06-armado-faltantes", async (p) => { await seedComp(p, 1); return "#completarModal .comp-card"; });
shot("07-armado-separar", async (p) => { await seedComp(p, 2); return "#completarModal .comp-card"; });
shot("08-armado-lios", async (p) => {
  await seedComp(p, 3);
  await p.evaluate(() => {
    // Paso 2 ya hecho: las NP quedaron clasificadas como "Lío" y sus códigos separados.
    _comp.nps.forEach((n) => { n.clase = "lio"; (n.codes || []).forEach((c) => { c.sep = true; }); });
    _compRenderLios();
    const n = _compLioNow(); if (n && n.codes[0]) { _compLioStep(0, 1); _compLioStep(0, 1); }
  });
  return "#completarModal .comp-card";
});

shot("09-mg-chooser", async (p) => {
  await p.evaluate(() => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    showMGChooser("104");
  });
  return "#mgChooserModal > div";
});

shot("09b-guardar-gondola", async (p) => {
  await p.evaluate(async () => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    await showMGModal("104", {
      legajo: "104", filtro: "", tsInicio: Date.now(),
      items: [
        { cod: "502", desc: "Colador chico", disponible: 12, cargar: 12, exc: 0, excOn: false, ubic: "" },
        { cod: "809E", desc: "Corta Queso X12", disponible: 20, cargar: 14, exc: 6, excOn: true, ubic: "P07" },
        { cod: "581T", desc: "Abrelata Tira Imp", disponible: 6, cargar: 0, exc: 0, excOn: false, ubic: "" }
      ]
    });
  });
  return "#mgModal .mg-card";
});

shot("10-carga-camion", async (p) => {
  await p.evaluate((nps) => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    const m = document.getElementById("tandaModal");
    m.querySelector(".tanda-modal-title").textContent = "🚛 Carga Camión — reparto";
    m.classList.add("show");
    _cc = {
      legajo: "104", checked: new Set(["97754"]),
      items: [
        { tanda: "C15A", np: "97754", rs: nps[0].rs, lios: 3 },
        { tanda: "C15A", np: "97761", rs: nps[1].rs, lios: 2 },
        { tanda: "C15B", np: "97772", rs: "Almacén San Martín", lios: 1 }
      ]
    };
    ccRender();
  }, NPS);
  return "#tandaModal .tanda-modal-card";
});

shot("11-recepcion-remitos", async (p) => {
  await p.evaluate((nps) => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    const m = document.getElementById("tandaModal");
    m.querySelector(".tanda-modal-title").textContent = "📥 Recepción Remitos";
    m.classList.add("show");
    _cr = {
      legajo: "104", admin: false, checked: new Set(["97754"]),
      items: [
        { np: "97754", tanda: "C15A", cod: "1042", rs: nps[0].rs, lios: 3, venc: false },
        { np: "97761", tanda: "C15A", cod: "2210", rs: nps[1].rs, lios: 2, venc: false },
        { np: "97772", tanda: "C15B", cod: "3301", rs: "Almacén San Martín", lios: 1, venc: true }
      ]
    };
    crRender();
  }, NPS);
  return "#tandaModal .tanda-modal-card";
});

/* Recepción de mercadería (RT → Modo OP de recepcion.js). Es un <script type="module">,
   así que no se le puede sembrar el estado: se maneja con clicks reales y las tablas
   de Supabase mockeadas por URL (opts.mocks). */
const RECEP_TABLES = {
  "Codigos X Tallerista": [
    { Codigo: "T01", Nombre: "Taller Gómez", Linea: "LK" },
    { Codigo: "T02", Nombre: "Metalúrgica Sur", Linea: "LK" },
    { Codigo: "T03", Nombre: "Plásticos del Oeste", Linea: "CH" }
  ],
  "Articulos Virgilio X Tallerista": [
    { Cod_Art: "502", Linea: "LK" }, { Cod_Art: "438E", Linea: "LK" },
    { Cod_Art: "440E", Linea: "LK" }, { Cod_Art: "581T", Linea: "LK" }
  ]
};

async function recepGoto(p, hasta) {
  await p.evaluate(() => window.openRecepcionOp("104", new Date().toISOString().slice(0, 10)));
  await p.waitForTimeout(500);
  if (hasta === "tipo") return;
  await p.click("button.opTipoBtn >> nth=0");            // Talleristas
  await p.waitForTimeout(250);
  if (hasta === "lista") return;
  await p.click("text=Taller Gómez");
  await p.waitForTimeout(250);
  await p.click("button.opLineBtn >> nth=0");            // línea LK
  await p.waitForTimeout(250);
  await p.fill("#opRto", "45678");
  await p.waitForTimeout(150);
  await p.click("#opPage button:has-text('Continuar')");
  await p.waitForTimeout(500);
}

shot("13-recepcion-quien", async (p) => {
  await recepGoto(p, "tipo");
  return "#opPage";
}, { supaTables: RECEP_TABLES, viewport: { width: 430, height: 460 } });

shot("14-recepcion-codigos", async (p) => {
  await recepGoto(p);
  return "#opPage";
}, { supaTables: RECEP_TABLES, viewport: { width: 430, height: 460 } });

shot("15-recepcion-cajas", async (p) => {
  await recepGoto(p);
  await p.evaluate(() => { const b = document.querySelector("#opPage button.opCodeBtn"); if (b) b.click(); });
  await p.waitForTimeout(350);
  const inp = await p.$("#opPage .opCajasModal input, #opPage input[inputmode='numeric']");
  if (inp) await inp.fill("12");
  await p.waitForTimeout(150);
  return "#opPage";
}, { supaTables: RECEP_TABLES, viewport: { width: 430, height: 460 } });

shot("12-terminar-dia", async (p) => {
  await p.evaluate(() => {
    document.getElementById("legajoInput").value = "104";
    goToOptions();
    terminarDia();
  });
  await p.waitForTimeout(300);
  return ".td-card, #terminarDiaModal .hist-modal-card, #terminarDiaModal, body";
});

/* ─────────────────────── ADMINISTRACIÓN ─────────────────────── */

shot("20-panel-admin", async (p) => {
  await p.evaluate(() => {
    document.getElementById("authBlock").style.display = "none";
    const bi = document.getElementById("btnInstructivo"); if (bi) bi.style.display = "none";
    document.getElementById("supervisorPanel").classList.remove("hidden");
    const t = document.getElementById("legajoTitle"); if (t) t.style.display = "none";
    const h = document.getElementById("legajoHistorySpace"); if (h) h.style.display = "none";
  });
  return "body";
}, { viewport: DESK, clip: { height: 800 } });

shot("21-facturacion", async (p) => {
  await p.evaluate(() => {
    const m = document.getElementById("facturacionModal"); if (m) m.classList.add("show");
    facRender([{
      tanda: "C15A", fechaEntrega: "hoy", fechaEntregaRaw: "",
      pedidos: [
        { np: "97754", cod: "1042", razonSocial: "Distribuidora del Norte S.R.L.", direccion: "Av. Mitre 1234", m3: 1.8, barrio: "San Martín", zona: "Norte" },
        { np: "97761", cod: "2210", razonSocial: "Autoservicio La Esquina", direccion: "Rivadavia 880", m3: 0.9, barrio: "Ramos", zona: "Oeste" }
      ]
    }]);
  });
  return "#facturacionModal .fac-card, #facturacionModal";
}, { viewport: DESK, clip: { height: 700 } });

shot("22-stock", async (p) => {
  await p.evaluate(() => openStockAdmin());   // arma el overlay (la data llega vacía: sin red)
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const ts = new Date().toISOString();
    const mk = (cod, desc, dep, delta) => ({ cod_art: cod, descripcion: desc, deposito: dep, delta: delta, tipo: "inicial", ts: ts, ref: "conteo" });
    _stk = {
      movs: [
        mk("502", "Colador chico", "terminado", 120), mk("502", "Colador chico", "excedente", 40),
        mk("438E", "Colador 20cm", "terminado", 50), mk("438E", "Colador 20cm", "a_guardar", 24),
        mk("809E", "Corta Queso X12", "terminado", 338), mk("809E", "Corta Queso X12", "racks", 400),
        mk("581T", "Abrelata Tira Imp", "terminado", 73),
        mk("440E", "Fuente honda", "terminado", 18), mk("440E", "Fuente honda", "a_separar", 12)
      ],
      cutoff: null, factors: {}, ordenes: [], bajadas: [], tab: "stocks", soloConteo: false,
      filtro: "", openArt: null, ingMode: "remito", asOf: null, asOfInput: "",
      dem: {}, cap: [], gConf: [], fcs: { pend: {}, porArt: {} }, fcsLoaded: true
    };
    const ov = document.getElementById("stockAdminOverlay"); if (ov) ov.classList.add("show");
    stkRender();
  });
  return "#stockAdminOverlay .stk-card, #stockAdminOverlay";
}, { viewport: DESK, clip: { height: 700 } });

shot("23-monitor", async (p) => {
  await p.evaluate(() => {
    const hoy = new Date().toISOString().slice(0, 10);
    const ped = (np, rs, m3) => ({ np: np, m3: m3, razonSocial: rs, cod: "", direccion: "", barrio: "", zona: "" });
    const ent = (t, m3, peds) => ({ tanda: t, _key: t, m3: m3, fechaEntrega: "hoy", fechaEntregaRaw: hoy, opIsSi: true, pedidos: peds });
    const sheetMap = new Map([
      ["C15A", ent("C15A", 2.7, [ped("97754", "Distribuidora del Norte S.R.L.", 1.8), ped("97761", "Autoservicio La Esquina", 0.9)])],
      ["C15B", ent("C15B", 1.4, [ped("97772", "Almacén San Martín", 1.4)])],
      ["C16A", ent("C16A", 3.1, [ped("97780", "Mayorista Sur S.A.", 3.1)])]
    ]);
    const nowMs = Date.now();
    const statusMap = new Map([
      ["C15A", { picking: "done", separado: "done", doneTodayP: true, doneTodayA: true, pickLegajo: "104", sepLegajo: "8", pickStartTs: nowMs - 5400000, sepStartTs: nowMs - 3600000 }],
      ["C15B", { picking: "done", separado: "curso", doneTodayP: true, doneTodayA: false, pickLegajo: "104", sepLegajo: "8", pickStartTs: nowMs - 3600000, sepStartTs: nowMs - 1200000 }],
      ["C16A", { picking: "curso", separado: null, doneTodayP: false, doneTodayA: false, pickLegajo: "27", sepLegajo: null, pickStartTs: nowMs - 900000, sepStartTs: null }]
    ]);
    const m = document.getElementById("monitorModal"); if (m) m.classList.add("show");
    renderMonitor(sheetMap, statusMap, [], [hoy], new Set(["104", "8", "27"]), [], null, null, null, null,
      isoToDayKey(nowMs), isoToDayKey(nowMs - 86400000));
  });
  return "#monitorModal .monitor-card, #monitorModal";
}, { viewport: { width: 1600, height: 1000 } });

/* Stub ESM de supabase-js: devuelve las filas de window.__SUPA_TABLES por nombre
   de tabla y no toca la red. Sólo lo consume recepcion.js. */
const SUPA_STUB = `
export function createClient() {
  const rows = (t) => (window.__SUPA_TABLES && window.__SUPA_TABLES[t]) || [];
  const q = (t) => {
    const o = { then: (res, rej) => Promise.resolve({ data: rows(t), error: null }).then(res, rej) };
    ["select","eq","neq","in","is","gte","lte","gt","lt","like","ilike","not","or","order","limit","range","single","maybeSingle","insert","upsert","update","delete"]
      .forEach((m) => { o[m] = () => o; });
    return o;
  };
  return {
    from: q,
    rpc: () => q(""),
    auth: {
      signInAnonymously: async () => ({ data: { user: { id: "stub" } }, error: null }),
      getSession: async () => ({ data: { session: { user: { id: "stub" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } })
  };
}
export default { createClient };
`;

/* ─────────────────────── runner ─────────────────────── */
/* Servidor estático local: `recepcion.js` es un <script type="module"> y no carga
   por file:// (los módulos exigen un origen http). */
const PORT = 8899;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
function serve() {
  return new Promise((ok) => {
    const srv = http.createServer((req, res) => {
      const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
      fs.readFile(f, (e, data) => {
        if (e) { res.writeHead(404); return res.end("no"); }
        res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
        res.end(data);
      });
    });
    srv.listen(PORT, "127.0.0.1", () => ok(srv));
  });
}

(async () => {
  const srv = await serve();
  const b = await chromium.launch();
  const errs = [];
  for (const s of shots) {
    if (only.length && !only.some((o) => s.name.includes(o))) continue;
    const ctx = await b.newContext({ viewport: s.opts.viewport || MOBILE, deviceScaleFactor: SCALE });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errs.push(s.name + ": " + e.message));
    // Nada de red: Supabase y cualquier host externo devuelven vacío.
    await p.route("**://**", (r) => {
      const u = r.request().url();
      if (u.startsWith("file://") || u.includes("127.0.0.1:" + PORT)) return r.continue();
      // recepcion.js es un módulo ESM que importa supabase-js del CDN: se le da un
      // stub offline que sirve las tablas de opts.supaTables.
      if (u.includes("esm.sh")) return r.fulfill({ status: 200, contentType: "text/javascript", body: SUPA_STUB });
      return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    if (s.opts.supaTables) await p.addInitScript((t) => { window.__SUPA_TABLES = t; }, s.opts.supaTables);
    await p.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(400);
    let sel;
    try { sel = await s.fn(p); } catch (e) { errs.push(s.name + " seed: " + e.message); await ctx.close(); continue; }
    await p.waitForTimeout(250);
    let target = null;
    for (const one of String(sel).split(",").map((x) => x.trim())) {
      const el = await p.$(one);
      if (el && await el.isVisible().catch(() => false)) { target = el; break; }
    }
    const file = path.join(OUT, s.name + ".png");
    if (s.opts.clip) {
      const vp = s.opts.viewport || MOBILE;
      await p.screenshot({ path: file, clip: { x: 0, y: 0, width: vp.width, height: Math.min(s.opts.clip.height, vp.height) } });
    } else if (target && !/^body$/.test(sel)) await target.screenshot({ path: file });
    else await p.screenshot({ path: file, fullPage: true });
    console.log("✓", s.name);
    await ctx.close();
  }
  await b.close();
  srv.close();
  if (errs.length) { console.log("\n⚠ avisos:\n" + errs.join("\n")); }
})();
