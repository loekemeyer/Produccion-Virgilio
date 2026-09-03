/* =========================================================
   recepcion.js — MODO OP de Recepción de Mercadería, integrado en
   Producción Virgilio. Portado de la app "Control-Carga-Remitos-FC"
   (v1.13.0), pruning del modo Admin / Pendientes (eso queda en la otra app).

   Se dispara cuando el operario toca **RT (Recepción Mercadería)** y abre el
   flujo: Talleristas / Prov. Art. Terminado → buscar → línea + fecha →
   N° RTO/FC → grilla de códigos con pop-up de cajas → resumen → confirmar.
   Graba en "Entregas Tallerista Virgilio" / "Entregas Prov AT" + deja el
   pendiente en "Control_Modo_OP" (mismo Supabase que Producción).

   AISLAMIENTO: todo el DOM va dentro de #rcpRoot y todo el CSS está scopeado
   bajo #rcpRoot (con sus propias variables), así no pisa ni lo pisan los
   estilos de Producción (que tiene un `button{}` global, etc.).

   PUENTE CON PRODUCCIÓN: al confirmar un envío, suma las cajas al acumulador
   del día en localStorage ("vir_recepcion_cajas_<legajo>_<día>"). Producción
   lo lee al "Terminar Día" para cerrar RT con esa cantidad sin pedirla a mano.
   La app llama window.openRecepcionOp(legajo, dayKey).
   ========================================================= */
/* v10.24 — supabase-js se sirve desde el repo (vendor/supabase.umd.js), no de esm.sh.
   Lo carga index.html con un <script> clasico ANTES de este modulo, asi que el global
   `supabase` ya esta. Antes esto era un `import` a esm.sh: si ese CDN fallaba, Recepcion
   NO abria. */
const { createClient } = (typeof window !== "undefined" && window.supabase) || {};
if (!createClient) throw new Error("Falta vendor/supabase.umd.js (cargalo antes de recepcion.js)");

/* v11.101: URL + key viven en supabase-config.js (index.html la carga con un
   <script> clásico antes de este módulo, igual que vendor/supabase.umd.js). */
const SUPABASE_URL = window.VIR_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = window.VIR_SUPABASE_KEY;
// ⚠ storageKey PROPIA (v5.21): sin esto, este cliente comparte la key default
// "sb-<ref>-auth-token" con el login Google de index.html y el signInAnonymously
// de abajo PISABA la sesión del supervisor (deslogueos "de la nada"). Además:
// detectSessionInUrl:false para no canjear el ?code= del callback OAuth ajeno.
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storageKey: "sb-hrxfctzncixxqmpfhskv-recepcion",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

// Sesion anonima silenciosa: las policies RLS de INSERT permiten rol authenticated.
const sessionReady = (async () => {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) return session;
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) { console.error("Recepcion: anonymous sign-in failed:", error); return null; }
    return data.session;
  } catch (e) { console.error("Recepcion: auth init exception:", e); return null; }
})();

/* ============== Estado del puente con Producción ============== */
const RECP = { legajo: null, dayKey: null };

/* ===== BORRADOR de la recepción en curso (v7.12) =====
   Si el operario arranca una recepción y se va para atrás / cierra la pantalla,
   NO se pierde: el estado (tallerista, línea, fecha, remito y las cajas ya
   marcadas) queda en localStorage por legajo+día. Producción lo lee para mostrar
   el botón "▶ Reanudar" en "Resumen de hoy" (window.recepcionDraftInfo) y lo
   restaura con window.reanudarRecepcionOp, volviendo al MISMO paso donde estaba.
   El borrador se borra al enviar la recepción o al empezar una nueva. */
const RCP_DRAFT_PREFIX = "vir_recepcion_draft_";
function rcpDraftKey(legajo, dayKey) { return RCP_DRAFT_PREFIX + String(legajo || "") + "_" + String(dayKey || ""); }
function rcpDraftNotify() {
  try { if (typeof window.onRecepcionDraftChange === "function") window.onRecepcionDraftChange(); }
  catch (_e) { /* no-op */ }
}
function rcpDraftClear(silencioso) {
  try { if (RECP.legajo && RECP.dayKey) localStorage.removeItem(rcpDraftKey(RECP.legajo, RECP.dayKey)); }
  catch (_e) { /* no-op */ }
  if (!silencioso) rcpDraftNotify();
}
function rcpDraftSave() {
  // Sólo el flujo del OPERARIO (entró por RT, con legajo). El supervisor que entra
  // por el menú de Administración no deja borrador.
  if (!RECP.legajo || !RECP.dayKey || opState.fromMenu === true) return;
  const cargas = opState.cargas || {};
  const hayAlgo = !!opState.tallNombre || Object.keys(cargas).length > 0;
  if (!hayAlgo) { rcpDraftClear(); return; }   // todavía no eligió nada: no hay qué reanudar
  try {
    localStorage.setItem(rcpDraftKey(RECP.legajo, RECP.dayKey), JSON.stringify({
      v: 1, ts: Date.now(), step: opState.step,
      tipo: opState.tipo, tallCod: opState.tallCod, tallNombre: opState.tallNombre,
      tallCods: opState.tallCods, articulosManual: opState.articulosManual,
      linea: opState.linea, fecha: opState.fecha, remito: opState.remito,
      articulos: opState.articulos, cargas: cargas
    }));
  } catch (_e) { /* localStorage lleno / modo privado: no rompe la carga */ }
  rcpDraftNotify();
}
function rcpDraftLoad(legajo, dayKey) {
  const hoy = String(dayKey || "");
  const pref = RCP_DRAFT_PREFIX + String(legajo || "") + "_";
  let d = null;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || k.indexOf(pref) !== 0) continue;
      if (k === pref + hoy) { try { d = JSON.parse(localStorage.getItem(k) || "null"); } catch (_e) { d = null; } }
      // Sólo se limpia lo ANTERIOR al día consultado (YYYY-MM-DD compara bien como
      // texto). Con `!==` una consulta por otro día borraba el borrador de hoy.
      else if (k.slice(pref.length) < hoy) localStorage.removeItem(k);
    }
  } catch (_e) { return null; }
  return (d && typeof d === "object") ? d : null;
}
/* Resumen del borrador para el botón de "Resumen de hoy" (lo llama index.html). */
window.recepcionDraftInfo = function (legajo, dayKey) {
  const d = rcpDraftLoad(legajo, dayKey);
  if (!d) return null;
  const cargas = d.cargas || {};
  const cods = Object.keys(cargas).filter(function (c) { return cargas[c] > 0; });
  let cajas = 0; cods.forEach(function (c) { cajas += Number(cargas[c]) || 0; });
  return {
    nombre: displayName(d.tallNombre || ""), linea: d.linea || "", remito: d.remito || "",
    fecha: d.fecha || "", codigos: cods.length, cajas: cajas, step: d.step || "", ts: d.ts || 0
  };
};
function recpAddCajas(n) {
  try {
    if (!RECP.legajo || !RECP.dayKey || !n) return;
    const k = "vir_recepcion_cajas_" + RECP.legajo + "_" + RECP.dayKey;
    const cur = parseInt(localStorage.getItem(k), 10) || 0;
    localStorage.setItem(k, String(cur + n));
  } catch (e) { /* no-op */ }
}

/* ============== CSS (scopeado bajo #rcpRoot) ============== */
const RCP_CSS = `
#rcpRoot{ --border:#d0d7de; --bg:#fafafa; --danger:#b42318; --ok:#0a7a2f; }
#rcpRoot *{ box-sizing:border-box; }
#rcpRoot button{ width:auto; margin:0; }
#rcpRoot .opSubtitle{ font-size:14px; font-weight:700; color:#555; margin:-6px 0 12px; min-height:18px; }
#rcpRoot .opGrid{ display:grid; gap:10px; }
#rcpRoot .opGrid.codes{ grid-template-columns:repeat(auto-fill,minmax(92px,1fr)); }
#rcpRoot .opTipoBtns{ display:flex; flex-direction:column; gap:16px; max-width:420px; margin:10px auto 0; }
#rcpRoot .opTipoBtn{ height:90px; font-size:22px; font-weight:900; border-radius:14px; border:2px solid var(--border); background:#fff; color:#111; cursor:pointer; }
#rcpRoot .opTipoBtn:hover{ border-color:#111; }
/* Botón secundario (Carga Manual): más chico y apagado (v5.93). */
#rcpRoot .opTipoBtn.opBtnSm{ height:52px; font-size:15px; font-weight:700; color:#64748b; }
#rcpRoot .opLista{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
#rcpRoot .btnBig{ height:52px; font-size:18px; padding:0 24px; }
#rcpRoot .btnAnular{ border:2px solid var(--danger); background:#fff; color:var(--danger); border-radius:10px; padding:10px 16px; font-weight:900; cursor:pointer; }
#rcpRoot .resHeader{ font-size:24px; font-weight:900; margin-bottom:12px; }
#rcpRoot .resList{ display:flex; flex-direction:column; gap:8px; }
#rcpRoot .resItem{ display:flex; align-items:center; justify-content:space-between; border:2px solid var(--border); border-radius:10px; padding:12px 16px; }
#rcpRoot .resCod{ font-size:24px; font-weight:900; color:#111; }
#rcpRoot .resCajas{ font-size:18px; font-weight:900; color:var(--ok); }
#rcpRoot .resTotal{ margin-top:14px; font-size:16px; font-weight:900; color:#333; }
#rcpRoot .cajasCodLine{ font-size:20px; margin-bottom:4px; }
#rcpRoot .cajasCodLine strong{ font-size:34px; }
#rcpRoot .cajasOc{ font-size:13px; font-weight:800; color:#a06000; background:#fff7e6; border:1px solid #ffd98a; border-radius:9px; padding:7px 10px; margin:6px 0 2px; }
#rcpRoot .cajasLabel{ display:block; font-weight:900; font-size:18px; margin:6px 0 10px; }
#rcpRoot .cajasRow{ display:flex; align-items:stretch; gap:12px; }
#rcpRoot .modalCard input[type="text"].cajasInput{ width:104px; height:104px; font-size:48px; font-weight:900; text-align:center; letter-spacing:normal; padding:0; border:2px solid var(--border); border-radius:12px; box-sizing:border-box; flex:0 0 auto; }
#rcpRoot .cajasNext{ flex:1; font-size:24px; font-weight:900; border:0; border-radius:12px; background:#111; color:#fff; cursor:pointer; }
#rcpRoot .cajasActions{ margin-top:12px; display:flex; justify-content:flex-end; }
#rcpRoot .opFechaBox{ position:relative; }
#rcpRoot .opFechaTxt{ display:block; height:64px; line-height:64px; text-align:center; font-size:32px; font-weight:900; border:2px solid var(--border); border-radius:10px; background:#f5f5f5; color:#111; }
#rcpRoot .opFechaHidden{ position:absolute; inset:0; width:100%; height:100%; opacity:0; border:0; margin:0; cursor:pointer; }
#rcpRoot .opNameBtn{ padding:18px 12px; font-weight:900; font-size:16px; border:2px solid var(--border); border-radius:12px; background:#fff; cursor:pointer; text-align:center; line-height:1.2; }
#rcpRoot .opNameBtn:hover{ border-color:#111; }
#rcpRoot .opNameBtn .tag{ display:block; font-size:11px; font-weight:800; color:#a06000; margin-top:4px; }
#rcpRoot input[type="text"].opSearch{ width:100%; height:50px; font-size:18px; letter-spacing:normal; text-align:left; border-radius:10px; border:2px solid var(--border); padding:0 14px; box-sizing:border-box; margin-bottom:14px; }
#rcpRoot .opCodeBtn{ aspect-ratio:1/1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; font-weight:900; font-size:18px; border:2px solid var(--border); border-radius:12px; background:#fff; cursor:pointer; padding:6px; text-align:center; min-width:0; overflow-wrap:anywhere; }
#rcpRoot .opCodeBtn .cnt{ font-size:12px; font-weight:800; color:var(--ok); }
#rcpRoot .opCodeBtn.loaded{ background:#eef7ee; border-color:var(--ok); color:#333; }
/* v7.07 — detalle de la OC vigente en el botón del código (cuánto se pidió) y
   marca roja cuando lo recibido excede la OC en más de 20%. */
#rcpRoot .opCodeBtn .ocq{ font-size:11px; font-weight:800; color:#a06000; line-height:1.15; }
#rcpRoot .opCodeBtn.exceso{ border-color:var(--danger); background:#fff5f4; }
#rcpRoot .opCodeBtn.exceso .cnt{ color:var(--danger); }
#rcpRoot .opCodeBtn.opCodeAdd{ border:2px dashed var(--ok); color:var(--ok); background:#f6fff8; }
#rcpRoot .opCodeAddPlus{ font-size:34px; line-height:1; font-weight:900; }
#rcpRoot .opLineRow{ display:flex; gap:14px; margin-top:14px; }
#rcpRoot .opLineBtn{ flex:1; height:90px; font-size:24px; font-weight:900; border-radius:14px; border:2px solid var(--border); background:#fff; cursor:pointer; }
#rcpRoot .opLineBtn.active{ background:#111; color:#fff; border-color:#111; }
#rcpRoot .opField{ margin-top:14px; }
#rcpRoot .opField label{ display:block; font-weight:900; margin-bottom:6px; }
#rcpRoot input[type="text"].opRtoInput{ width:100%; height:56px; font-size:30px; letter-spacing:8px; text-align:center; border-radius:10px; border:2px solid var(--border); box-sizing:border-box; }
#rcpRoot .opEmpty{ padding:10px; color:#666; }
#rcpRoot .opOk{ padding:14px; color:var(--ok); font-weight:900; font-size:18px; }
#rcpRoot .opPage{ position:fixed; inset:0; background:var(--bg); overflow:auto; display:none; z-index:1300; }
#rcpRoot .opPage.open{ display:block; }
#rcpRoot .opPageInner{ max-width:780px; margin:0 auto; padding:16px; min-height:100%; box-sizing:border-box; display:flex; flex-direction:column; }
#rcpRoot .opHeader{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 0 14px; margin-bottom:14px; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--bg); z-index:6; }
#rcpRoot .opPageTitle{ flex:1; text-align:center; font-size:22px; font-weight:900; }
#rcpRoot .opNav{ background:#fff; border:2px solid var(--border); border-radius:12px; padding:14px 20px; font-size:18px; font-weight:900; cursor:pointer; white-space:nowrap; }
#rcpRoot .opPageBody{ flex:1; }
#rcpRoot .opPageActions{ margin-top:18px; display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:10px; position:sticky; bottom:0; background:var(--bg); padding:12px 0; }
#rcpRoot .opPageActions .btnSend{ height:52px; font-size:18px; padding:0 24px; }
#rcpRoot .opPageActions .btnCancel, #rcpRoot .opPageActions .btnAnular{ height:52px; padding:0 16px; }
/* v7.15 — "Anular recepción": salida clara de una sesión abierta por error (mismo
   criterio que el "Anular picking"). Barra propia ABAJO DE TODO, fuera de #opBody y
   de #opActions, así no la pisa ningún render de paso. */
#rcpRoot .opAnularBar:empty{ display:none; }
#rcpRoot .opAnularBar{ padding:4px 0 16px; }
#rcpRoot button.opAnular{ width:100%; margin:0; padding:16px 14px; font-size:19px; font-weight:900; background:#dc2626; color:#fff; border:0; border-radius:12px; cursor:pointer; }
#rcpRoot button.opAnular:hover{ background:#b91c1c; }
#rcpRoot button.opAnular small{ display:block; font-size:12px; font-weight:700; opacity:.9; margin-top:2px; }
#rcpRoot .modal{ position:fixed; inset:0; background:rgba(0,0,0,.45); display:none; align-items:flex-start; justify-content:center; padding:24px; overflow:auto; z-index:1400; }
#rcpRoot .modal.open{ display:flex; }
#rcpRoot .modalCard{ background:#fff; border-radius:14px; padding:20px; width:100%; max-width:360px; max-height:90vh; display:flex; flex-direction:column; }
#rcpRoot .modalHeader{ display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
#rcpRoot .modalTitle{ font-size:22px; font-weight:900; }
#rcpRoot .modalClose{ background:#fff; border:1px solid var(--border); width:32px; height:32px; border-radius:50%; cursor:pointer; font-size:14px; font-weight:900; }
#rcpRoot .btnCancel{ padding:10px 16px; border-radius:10px; border:1px solid var(--border); background:#fff; font-weight:900; cursor:pointer; }
#rcpRoot .btnSend{ padding:10px 16px; border-radius:10px; border:0; background:#111; color:#fff; font-weight:900; cursor:pointer; }
/* Pendientes (Marianela) = TARJETAS verticales (sin scroll horizontal): tilde + No
   corresponde + foto (adjuntar/arrastrar) + Enviar (código). */
#rcpRoot .opPage.pendWide .opPageInner{ max-width:none; }   /* PC: usa todo el ancho */
#rcpRoot .pendCards{ display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 360px), 360px)); gap:12px; align-items:start; }
#rcpRoot .pendCard{ border:2px solid var(--border); border-radius:14px; background:#fff; padding:12px 14px; }
#rcpRoot .pendCard.sentRow{ border-color:var(--ok); background:#f6fff8; }
#rcpRoot .pcHead{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
#rcpRoot .pcName{ font-size:18px; font-weight:900; color:#111; }
#rcpRoot .pcTag{ font-size:11px; font-weight:800; color:#a06000; background:#fff7e6; border:1px solid #ffd98a; border-radius:999px; padding:2px 8px; }
#rcpRoot .pcRto{ margin-left:auto; font-size:13px; font-weight:800; color:#475569; white-space:nowrap; }
#rcpRoot .pcMeta{ font-size:13px; color:#666; margin-top:3px; }
#rcpRoot .pcDemora{ font-weight:900; color:#b45309; font-size:14px; }
#rcpRoot .pcEntrega{ font-size:14px; color:#333; margin-top:6px; font-variant-numeric:tabular-nums; word-break:break-word; }
#rcpRoot .pcActs{ margin-top:10px; border-top:1px solid #eee; padding-top:10px; display:flex; flex-direction:column; gap:10px; }
#rcpRoot .pcRow{ display:flex; align-items:center; gap:12px; }
#rcpRoot .pcRow.pcFotoRow{ flex-wrap:wrap; }
#rcpRoot .pcLbl{ font-size:16px; font-weight:800; color:#111; }
#rcpRoot .tickBtn{ width:28px; height:28px; border-radius:8px; border:2px solid #cbd5e1; background:#fff; font-size:0; cursor:pointer; position:relative; padding:0; flex:0 0 auto; }
#rcpRoot .tickBtn.on{ background:var(--ok); border-color:var(--ok); }
#rcpRoot .tickBtn.on::after{ content:""; position:absolute; left:50%; top:46%; width:7px; height:13px; border:solid #fff; border-width:0 3px 3px 0; transform:translate(-50%,-50%) rotate(45deg); }
#rcpRoot .noBtn{ margin-left:auto; padding:8px 12px; font-size:12px; font-weight:800; border:2px solid var(--border); border-radius:9px; background:#fff; color:#111; cursor:pointer; white-space:nowrap; }
#rcpRoot .noBtn.on{ background:var(--danger); border-color:var(--danger); color:#fff; }
#rcpRoot .pcFotoRow .fotoDrop{ flex:1; }
/* v12.64 — rótulo arriba de cada bloque de foto cuando se piden las dos. */
#rcpRoot .opFotoTitulo{ font-size:14px; font-weight:800; color:#334155; margin:14px 0 6px; }
#rcpRoot .fotoDrop{ display:inline-flex; align-items:center; justify-content:center; min-width:160px; min-height:46px; padding:8px 12px; border:2px dashed #cbd5e1; border-radius:10px; background:#fff; cursor:pointer; font-weight:800; font-size:13px; color:#475569; }
#rcpRoot .fotoDrop.has{ border-style:solid; border-color:var(--ok); color:var(--ok); background:#eef7ee; }
#rcpRoot .fotoDrop.drag{ border-color:#1e6bd6; background:#eff6ff; }
/* v11.xx — Foto del operario en resumen */
#rcpRoot .opFotoSection{ margin:16px 0 4px; text-align:center; }
#rcpRoot .opFotoBtn{ width:100%; padding:18px; font-size:18px; font-weight:900; border:2px dashed #94a3b8; border-radius:14px; background:#fff; color:#475569; cursor:pointer; }
#rcpRoot .opFotoBtn.has{ border-style:solid; border-color:var(--ok); color:var(--ok); background:#eef7ee; }
#rcpRoot .opFotoPreview{ margin-top:10px; }
#rcpRoot .opFotoPreview img{ max-width:100%; max-height:220px; border-radius:10px; border:2px solid var(--ok); }
#rcpRoot .opFotoHint{ font-size:13px; color:#b91c1c; font-weight:700; margin-top:6px; }
/* v11.xx — Admin: visor de foto (en pendientes) */
#rcpRoot .fotoViewBtn{ display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border:2px solid #cbd5e1; border-radius:10px; background:#fff; font-weight:800; font-size:13px; color:#475569; cursor:pointer; flex:1; justify-content:center; min-height:46px; }
#rcpRoot .fotoViewBtn.viewed{ border-color:var(--ok); color:var(--ok); background:#eef7ee; }
#rcpRoot .fotoViewBtn.noFoto{ border-color:#e5e7eb; color:#9ca3af; cursor:default; font-style:italic; }
#rcpRoot .fotoOverlay{ position:fixed; inset:0; background:rgba(0,0,0,.88); display:flex; align-items:center; justify-content:center; z-index:1500; padding:16px; overflow:auto; }
#rcpRoot .fotoOverlay img{ max-width:100%; max-height:88vh; border-radius:8px; object-fit:contain; }
#rcpRoot .fotoOverlayClose{ position:absolute; top:14px; right:14px; width:48px; height:48px; border-radius:50%; background:#fff; border:0; font-size:22px; font-weight:900; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 8px rgba(0,0,0,.3); z-index:2; }
/* v12.07 — La foto y lo que cargó el operario, JUNTOS en el mismo visor. Antes había
   que cerrar la foto para leer los códigos/cajas y volver a abrirla para cotejar. */
#rcpRoot .fotoOverlayBox{ display:flex; align-items:center; justify-content:center; gap:14px; width:100%; max-width:1280px; margin:auto; }
#rcpRoot .fotoOverlayImg{ flex:1 1 auto; min-width:0; display:flex; align-items:center; justify-content:center; }
/* v12.64 — dos fotos (remito + factura) una al lado de la otra en el visor. Cada una
   con su rótulo, porque a simple vista los dos papeles se parecen. */
#rcpRoot .fotoOverlayImg.dos{ gap:10px; align-items:flex-start; }
#rcpRoot .fotoOverlayCel{ flex:1 1 0; min-width:0; display:flex; flex-direction:column; align-items:center; gap:6px; }
#rcpRoot .fotoOverlayCelTit{ color:#fff; font-size:13px; font-weight:800; letter-spacing:.3px; }
#rcpRoot .fotoOverlayImg.dos img{ max-height:78vh; }
#rcpRoot .fotoOverlayInfo{ flex:0 0 330px; max-width:330px; max-height:88vh; overflow:auto; background:#fff; border-radius:12px; padding:14px 16px; box-shadow:0 2px 14px rgba(0,0,0,.4); }
#rcpRoot .fovName{ font-size:19px; font-weight:900; color:#111; }
#rcpRoot .fovMeta{ font-size:13px; font-weight:700; color:#475569; margin-top:2px; }
#rcpRoot .fovRto{ font-size:14px; font-weight:900; color:#111; margin-top:4px; }
#rcpRoot .fovTit{ font-size:12px; font-weight:900; color:#64748b; text-transform:uppercase; letter-spacing:.5px; margin:12px 0 6px; border-top:1px solid #e5e7eb; padding-top:10px; }
#rcpRoot .fovItem{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:5px 0; border-bottom:1px dashed #eef2f7; font-variant-numeric:tabular-nums; }
#rcpRoot .fovCod{ font-size:16px; font-weight:900; color:#111; word-break:break-word; }
#rcpRoot .fovCaj{ font-size:17px; font-weight:900; color:#0a7a2f; white-space:nowrap; }
#rcpRoot .fovTotal{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-top:10px; padding-top:9px; border-top:2px solid #111; font-size:17px; font-weight:900; color:#111; font-variant-numeric:tabular-nums; }
#rcpRoot .fovRaw{ font-size:15px; font-weight:800; color:#111; word-break:break-word; }
@media (max-width:860px){
  #rcpRoot .fotoOverlayBox{ flex-direction:column; align-items:stretch; gap:10px; }
  #rcpRoot .fotoOverlayInfo{ flex:0 0 auto; max-width:none; max-height:38vh; }
  #rcpRoot .fotoOverlay img{ max-height:46vh; }
  /* En el celular las dos fotos van UNA ABAJO DE LA OTRA: al lado quedarían de ~180px
     y un remito no se lee. El overlay ya scrollea (overflow:auto). */
  #rcpRoot .fotoOverlayImg.dos{ flex-direction:column; align-items:stretch; }
  #rcpRoot .fotoOverlayImg.dos img{ max-height:44vh; }
}
#rcpRoot .pcFoot{ margin-top:10px; display:flex; align-items:center; justify-content:flex-end; gap:12px; }
#rcpRoot .enviarBtn{ padding:11px 22px; font-size:16px; font-weight:900; border:0; border-radius:11px; background:#111; color:#fff; cursor:pointer; }
#rcpRoot .enviarBtn:disabled{ opacity:.4; cursor:default; }
#rcpRoot .codigoBox{ font-size:26px; font-weight:900; letter-spacing:4px; color:#0a7a2f; font-variant-numeric:tabular-nums; }
/* Histórico de recepción (v6.41): barra de filtros + tabla. */
#rcpRoot .histBar{ display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; margin-bottom:10px; }
#rcpRoot .histField{ display:flex; flex-direction:column; gap:4px; }
#rcpRoot .histField label{ font-size:12px; font-weight:800; color:#475569; }
#rcpRoot .histField input{ height:44px; border:2px solid var(--border); border-radius:10px; padding:0 12px; font-size:16px; font-weight:700; background:#fff; box-sizing:border-box; }
#rcpRoot input[type="text"].histCod{ width:150px; letter-spacing:normal; text-align:left; }
#rcpRoot .histField input.histDate{ width:158px; }
#rcpRoot .histBtns{ display:flex; gap:8px; }
#rcpRoot .histBtn{ height:44px; padding:0 18px; border-radius:10px; border:2px solid var(--border); background:#fff; font-weight:900; font-size:15px; cursor:pointer; }
#rcpRoot .histBtn.pri{ background:#111; color:#fff; border-color:#111; }
/* v6.55: "+" que despliega los filtros extra (Quién entregó / Remito / Cajas mín.).
   v6.56: va a la DERECHA del buscador principal, en dos líneas: "+" arriba, "filtros" abajo. */
#rcpRoot .histBtn.plus{ padding:0 12px; display:flex; flex-direction:column; align-items:center; justify-content:center; line-height:1.05; }
#rcpRoot .histBtn.plus .plusIco{ font-size:15px; font-weight:900; }
#rcpRoot .histBtn.plus .plusTxt{ font-size:10px; font-weight:800; color:#475569; }
#rcpRoot .histBtn.plus.on{ border-color:#111; background:#f1f5f9; }
#rcpRoot .histMore{ display:none; }
#rcpRoot .histMore.show{ display:flex; }
#rcpRoot .histPresets{ display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
#rcpRoot .histChip{ padding:7px 14px; border-radius:999px; border:2px solid var(--border); background:#fff; font-weight:800; font-size:13px; cursor:pointer; color:#334155; }
#rcpRoot .histChip:hover{ border-color:#111; }
#rcpRoot .histSummary{ font-size:14px; font-weight:800; color:#0f172a; margin-bottom:8px; }
#rcpRoot .histSummary b{ color:var(--ok); }
#rcpRoot .histNote{ font-size:12.5px; color:#b45309; font-weight:700; margin-bottom:10px; }
#rcpRoot .histTblWrap{ overflow-x:auto; -webkit-overflow-scrolling:touch; border:1px solid var(--border); border-radius:12px; }
#rcpRoot table.histTbl{ width:100%; border-collapse:collapse; font-size:14px; min-width:520px; }
#rcpRoot table.histTbl th{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#64748b; font-weight:900; padding:10px 12px; background:#f1f5f9; position:sticky; top:0; }
#rcpRoot table.histTbl td{ padding:9px 12px; border-top:1px solid #eef2f6; vertical-align:top; }
#rcpRoot .histCodCell{ font-weight:900; color:#111; font-family:Consolas,Menlo,monospace; white-space:nowrap; }
#rcpRoot .histCaj{ font-weight:900; color:var(--ok); text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
#rcpRoot .histFe{ white-space:nowrap; color:#334155; font-weight:700; }
#rcpRoot .histWho{ color:#334155; }
#rcpRoot .histWho .provTag{ font-size:10px; font-weight:800; color:#a06000; background:#fff7e6; border:1px solid #ffd98a; border-radius:999px; padding:1px 7px; margin-right:5px; }
#rcpRoot .histWho .histDesc{ color:#94a3b8; }
#rcpRoot .histRto{ color:#64748b; font-variant-numeric:tabular-nums; white-space:nowrap; }
#rcpRoot .histDem{ text-align:right; font-weight:800; color:#b45309; font-variant-numeric:tabular-nums; white-space:nowrap; }
#rcpRoot .histLoading, #rcpRoot .histEmpty{ padding:26px; text-align:center; color:#64748b; font-weight:700; }
`;

/* ============== DOM (inyectado dentro de #rcpRoot) ============== */
const RCP_HTML = `
<div id="opPage" class="opPage">
  <div class="opPageInner">
    <div class="opHeader">
      <button id="opBack" class="opNav" style="display:none">‹ Atrás</button>
      <div id="opTitle" class="opPageTitle">Recepción</div>
      <button id="opClose" class="opNav">✕ Salir</button>
    </div>
    <div id="opSubtitle" class="opSubtitle"></div>
    <div id="opBody" class="opPageBody"></div>
    <div id="opActions" class="opPageActions"></div>
    <div id="opAnularBar" class="opAnularBar"></div>
  </div>
</div>
<div id="opCajasModal" class="modal" role="dialog" aria-modal="true">
  <div class="modalCard">
    <div class="modalHeader">
      <div class="modalTitle">Cajas entregadas</div>
      <button id="opCajasClose" class="modalClose" aria-label="Cerrar">×</button>
    </div>
    <div class="cajasCodLine">Código <strong id="opCajasCod"></strong></div>
    <div id="opCajasOc" class="cajasOc" style="display:none"></div>
    <label for="opCajasInput" class="cajasLabel">¿Cuántas cajas?</label>
    <div class="cajasRow">
      <input id="opCajasInput" class="cajasInput" type="text" inputmode="numeric" />
      <button id="opCajasNext" class="cajasNext">Siguiente</button>
    </div>
    <div class="cajasActions">
      <button id="opCajasDelete" class="btnCancel" style="display:none">Quitar</button>
    </div>
  </div>
</div>
`;

const rcpRoot = document.createElement("div");
rcpRoot.id = "rcpRoot";
rcpRoot.innerHTML = RCP_HTML;
const rcpStyle = document.createElement("style");
rcpStyle.textContent = RCP_CSS;
document.head.appendChild(rcpStyle);
document.body.appendChild(rcpRoot);

/* ============== Refs ============== */
const opPage = document.getElementById("opPage");
const opTitle = document.getElementById("opTitle");
const opSubtitle = document.getElementById("opSubtitle");
const opBody = document.getElementById("opBody");
const opActions = document.getElementById("opActions");
const opBack = document.getElementById("opBack");
const opClose = document.getElementById("opClose");
const opCajasModal = document.getElementById("opCajasModal");
const opCajasCod = document.getElementById("opCajasCod");
const opCajasInput = document.getElementById("opCajasInput");
const opCajasNext = document.getElementById("opCajasNext");
const opCajasDelete = document.getElementById("opCajasDelete");
const opCajasClose = document.getElementById("opCajasClose");
const opCajasOc = document.getElementById("opCajasOc");
const opAnularBar = document.getElementById("opAnularBar");

const opState = {
  step: null,
  tipo: null,        // 'tallerista' | 'prov_at'
  entidades: null,   // lista completa para el buscador
  tallCod: null, tallNombre: null,
  tallCods: null,    // { LK:codigo, CH:codigo } del tallerista (prov_at: {LK:true,CH:true})
  articulosManual: null,
  linea: null, fecha: null,
  remito: "",
  articulos: null,   // [{Cod_Art, Desc}]
  cargas: {},        // { Cod_Art: cajas }
  cajasCod: null,    // codigo abierto en el popup
  listaTipo: null,
  ocPorCod: null     // v7.07: OCs vigentes del proveedor { codNorm: {ped,rec,pend,fecha} } (null = sin cargar)
};

/* v3.81-fix: usar TZ Argentina (igual que getTodayKey() en index.html) en
   vez de la hora LOCAL del dispositivo. Si la tablet tiene TZ mal configurada
   (UTC, etc.), el operario veía "hoy" en fecha incorrecta y descuadraba la
   ventana de OC vigente y el Dia_mes grabado en Entregas Tallerista. */
function opTodayStr() {
  try {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return yyyy + "-" + mm + "-" + dd;
  } catch (_e) {
    // Fallback: hora local del dispositivo (mejor que nada)
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return yyyy + "-" + mm + "-" + dd;
  }
}

/* ===== v7.15 — ANULAR la sesión de recepción =====
   "✕ Salir" sólo cierra la pantalla: el toggle RT sigue ABIERTO en Supabase (y el
   operario, al volver a tocar RT, cae en el cierre "Indicar Cantidad"). Esto la anula
   de verdad: tira el borrador y le pide a Producción que cierre el RT y borre el
   evento de apertura (window.anularRecepcionSesion → RPC anular_toggle_virgilio).
   La barra vive fuera de #opBody/#opActions, así queda en TODOS los pasos del
   operario; el supervisor (menú de Administración) no la ve. */
function opAnularBarRender(mostrar) {
  if (!opAnularBar) return;
  opAnularBar.innerHTML = (mostrar && RECP.legajo)
    ? '<button type="button" class="opAnular">✕ Anular recepción<small>descarta lo cargado y cierra la sesión</small></button>'
    : "";
  const b = opAnularBar.querySelector("button");
  if (b) b.onclick = opAnularSesion;
}
async function opAnularSesion() {
  const legajo = RECP.legajo;
  const cargados = Object.keys(opState.cargas || {}).filter(function (c) { return opState.cargas[c] > 0; }).length;
  if (!confirm("¿ANULAR esta recepción?\n\n" +
      (cargados ? "Se descartan los " + cargados + " código(s) que marcaste y se " : "Se ") +
      "cierra la sesión de Recepción (RT).\n\nNo se puede deshacer.")) return;
  let hecho = true;
  try {
    if (typeof window.anularRecepcionSesion === "function") hecho = await window.anularRecepcionSesion(legajo);
  } catch (e) { console.warn("anularRecepcionSesion:", e); }
  if (hecho === false) return;   // Producción lo frenó (2ª confirmación cancelada)
  opResetState();                // deja el estado vacío → closeOp borra el borrador
  closeOp();
  alert("✕ Recepción anulada.");
}

/* ============== Navegación ============== */
function opResetState() {
  opState.step = null;
  opState.tipo = null;
  opState.entidades = null;
  opState.tallCod = null; opState.tallNombre = null; opState.tallCods = null;
  opState.articulosManual = null;
  opState.linea = null; opState.fecha = opTodayStr();
  opState.remito = ""; opState.articulos = null; opState.cargas = {};
  opState.ocPorCod = null;
  opState.fotoFile = null;
  if (opState.fotoPreviewUrl) { try { URL.revokeObjectURL(opState.fotoPreviewUrl); } catch(_e){} }
  opState.fotoPreviewUrl = null;
  // v12.64 — segunda foto: cuando el tipo de documento es "Remito y Factura" se piden
  // las DOS (foto 1 = remito, foto 2 = factura). En los otros tipos queda en null.
  opState.fotoFile2 = null;
  if (opState.fotoPreviewUrl2) { try { URL.revokeObjectURL(opState.fotoPreviewUrl2); } catch(_e){} }
  opState.fotoPreviewUrl2 = null;
}
function openOp() {
  opResetState();
  opState.fromMenu = false;     // operario (RT) entra directo a la carga, sin menú
  rcpDraftClear(true);          // v7.12: recepción NUEVA → el borrador anterior ya no sirve
  opPage.classList.remove("pendWide");
  opPage.classList.add("open");
  opAnularBarRender(true);
  renderTipoElegir();
}
/* v7.12 — REANUDAR: vuelve a la recepción que el operario dejó por la mitad, en el
   MISMO paso en el que estaba (lo llama el botón "▶ Reanudar" de "Resumen de hoy").
   Sin borrador cae al flujo normal, así el botón nunca deja al operario colgado. */
window.reanudarRecepcionOp = function (legajo, dayKey) {
  RECP.legajo = String(legajo || "").trim() || null;
  RECP.dayKey = dayKey || opTodayStr();
  const d = rcpDraftLoad(RECP.legajo, RECP.dayKey);
  if (!d) { openOp(); return; }
  opResetState();
  opState.fromMenu = false;
  opState.tipo = d.tipo || null;
  opState.tallCod = d.tallCod || null;
  opState.tallNombre = d.tallNombre || null;
  opState.tallCods = d.tallCods || null;
  opState.articulosManual = d.articulosManual || null;
  opState.linea = d.linea || null;
  opState.fecha = d.fecha || opTodayStr();
  opState.remito = d.remito || "";
  opState.articulos = d.articulos || null;
  opState.cargas = d.cargas || {};
  opPage.classList.remove("pendWide");
  opPage.classList.add("open");
  opAnularBarRender(true);
  if (d.step === "resumen" && Object.keys(opState.cargas).length) renderResumen();
  else if (d.step === "articulos" && opState.linea) renderArticulos();
  else if (d.step === "remito" && opState.linea) renderRemito();
  else if (opState.tallNombre) renderLinea();
  else renderTipoElegir();
};
let _pendTimer = null;   // timer del "hace X hs" en vivo de Pendientes
let _deepLinkRemito = null;  // remito a resaltar al abrir Pendientes desde Planify
function closeOp() {
  rcpDraftSave();   // v7.12: salir NO pierde la recepción a medio cargar
  opAnularBarRender(false);
  opPage.classList.remove("open");
  if (_pendTimer) { clearInterval(_pendTimer); _pendTimer = null; }
}
opClose.onclick = closeOp;

opBack.onclick = () => {
  if (opState.step === "tipo" || opState.step === "pend" || opState.step === "racks" || opState.step === "hist" || opState.step === "histbaj") renderMenu();
  else if (opState.step === "lista") renderTipoElegir();
  else if (opState.step === "linea") renderLista(opState.tipo);
  else if (opState.step === "tipoDoc") renderLinea();
  else if (opState.step === "docFields") renderTipoDoc();
  else if (opState.step === "remito") renderLinea();
  else if (opState.step === "articulos") renderDocFields();
  else if (opState.step === "resumen") renderArticulos();
};

function opSetBack(show) { opBack.style.display = show ? "" : "none"; }

function opNorm(s) { return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function displayName(s) {
  return (s || "").replace(/\S+/g, w => /[a-z]/.test(w) ? w : (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()));
}

const ORDEN_TALL = ["Poly", "Martin", "Lucho", "Rafael", "Carlos", "Garcia", "Pedernera", "German", "BlistPack", "Log/Fabr"];
const OCULTAR_TALL = ["Ester", "Aguirre Carlos Rodolfo"];
const OCULTAR_PROV = ["Rafael"];
const PROV_MANUAL = [
  { nombre: "Kuffo", cod_factura: null, articulos: ["193"] }
];
function claveTall(n) { return opNorm(n).replace(/[\s\-\/.]/g, ""); }

const ALIAS_NOMBRE = [
  { de: "Pettofrezza", a: "Rafael" }
];
function aliasNombre(n) {
  const k = claveTall(n);
  for (const x of ALIAS_NOMBRE) { if (k.includes(claveTall(x.de))) return x.a; }
  return n;
}

const ordenTallMap = {};
ORDEN_TALL.forEach((n, i) => { ordenTallMap[claveTall(n)] = i; });
const ocultarTallSet = new Set(OCULTAR_TALL.map(claveTall));
const ocultarProvSet = new Set(OCULTAR_PROV.map(claveTall));

const MESES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function fechaCorta(yyyymmdd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd || "");
  if (!m) return "—";
  return m[3] + "/" + MESES_CORTO[parseInt(m[2], 10) - 1] + "/" + m[1].slice(2);
}

/* ============== Carga de entidades ============== */
async function cargarEntidades() {
  // v10.25: usa vista_entidades_recepcion (join talleristas + proveedores hecho en backend)
  const res = await supabase
    .from("vista_entidades_recepcion")
    .select("tipo,nombre,cod_lk,cod_ch,cod_default,cod_factura")
    .order("nombre");
  if (res.error) { opState.entidades = null; return res.error.message; }

  const entidades = [];
  const vistosProv = new Set();
  (res.data || []).forEach(r => {
    const nom = aliasNombre((r.nombre || "").trim());
    if (!nom) return;
    if (r.tipo === 'tallerista') {
      entidades.push({
        tipo: 'tallerista', Nombre: nom,
        cods: { LK: r.cod_lk || r.cod_default || null, CH: r.cod_ch || r.cod_default || null }
      });
    } else if (r.tipo === 'prov_at' && !vistosProv.has(opNorm(nom))) {
      vistosProv.add(opNorm(nom));
      entidades.push({ tipo: 'prov_at', Nombre: nom, cod: r.cod_factura, cods: { LK: true, CH: true } });
    }
  });

  PROV_MANUAL.forEach(p => {
    if (vistosProv.has(opNorm(p.nombre))) return;
    vistosProv.add(opNorm(p.nombre));
    entidades.push({
      tipo: 'prov_at', Nombre: p.nombre, cod: p.cod_factura || null,
      cods: { LK: true, CH: true },
      articulos: p.articulos.map(a => ({ Cod_Art: String(a), Desc: "" }))
    });
  });

  opState.entidades = entidades;
  return null;
}

function listaPorTipo(tipo, filtro) {
  const f = opNorm(filtro || "").trim();
  let arr = (opState.entidades || []).filter(e => e.tipo === tipo);
  if (tipo === 'tallerista') arr = arr.filter(e => !ocultarTallSet.has(claveTall(e.Nombre)));
  else if (tipo === 'prov_at') arr = arr.filter(e => !ocultarProvSet.has(claveTall(e.Nombre)));
  if (f) arr = arr.filter(e => opNorm(e.Nombre).includes(f));
  arr = arr.slice().sort((a, b) => {
    if (tipo === 'tallerista') {
      const ia = ordenTallMap[claveTall(a.Nombre)] != null ? ordenTallMap[claveTall(a.Nombre)] : 999;
      const ib = ordenTallMap[claveTall(b.Nombre)] != null ? ordenTallMap[claveTall(b.Nombre)] : 999;
      if (ia !== ib) return ia - ib;
    } else if (f) {
      const aw = opNorm(a.Nombre).startsWith(f) ? 0 : 1;
      const bw = opNorm(b.Nombre).startsWith(f) ? 0 : 1;
      if (aw !== bw) return aw - bw;
    }
    return a.Nombre.localeCompare(b.Nombre, 'es');
  });
  return arr;
}

/* ============== Paso 1: elegir tipo ============== */
async function renderTipoElegir() {
  opState.step = "tipo";
  opSetBack(opState.fromMenu === true);   // sólo muestra "Atrás" si se entró por el menú (supervisor)
  opTitle.textContent = "¿Qué vas a cargar?";
  opSubtitle.textContent = "";
  opActions.innerHTML = "";

  if (opState.entidades === null) {
    opBody.innerHTML = '<div class="opEmpty">Cargando…</div>';
    const err = await cargarEntidades();
    if (opState.step !== "tipo") return;
    if (err) { opBody.innerHTML = '<div class="opEmpty" style="color:var(--danger)">Error: ' + err + '</div>'; return; }
  }

  const nTall = listaPorTipo('tallerista').length;
  const nProv = listaPorTipo('prov_at').length;
  opBody.innerHTML = "";
  const cont = document.createElement("div");
  cont.className = "opTipoBtns";
  const bt = document.createElement("button");
  bt.type = "button"; bt.className = "opTipoBtn";
  bt.textContent = "Talleristas (" + nTall + ")";
  bt.onclick = () => renderLista('tallerista');
  const bp = document.createElement("button");
  bp.type = "button"; bp.className = "opTipoBtn";
  bp.textContent = "Prov. Art. Terminado (" + nProv + ")";
  bp.onclick = () => renderLista('prov_at');
  cont.appendChild(bt); cont.appendChild(bp);
  opBody.appendChild(cont);
}

/* ============== Paso 2: lista del tipo ============== */
function renderLista(tipo) {
  opState.step = "lista";
  opState.listaTipo = tipo;
  opSetBack(true);
  opTitle.textContent = tipo === 'tallerista' ? "Talleristas" : "Prov. Art. Terminado";
  opSubtitle.textContent = "";
  opActions.innerHTML = "";

  opBody.innerHTML = "";
  const search = document.createElement("input");
  search.className = "opSearch";
  search.type = "text";
  search.placeholder = "🔍 Buscar por nombre…";
  search.oninput = () => drawLista(search.value);
  opBody.appendChild(search);
  const grid = document.createElement("div");
  grid.id = "opListaGrid";
  grid.className = "opLista";
  opBody.appendChild(grid);
  // Al REANUDAR se entra directo a un paso interno, así que la lista de
  // talleristas puede no estar cargada todavía: se trae acá si falta.
  if (opState.entidades === null) {
    grid.innerHTML = '<div class="opEmpty">Cargando…</div>';
    cargarEntidades().then(function () { if (opState.step === "lista") drawLista(search.value); });
    return;
  }
  drawLista("");
}

function drawLista(filter) {
  const grid = document.getElementById("opListaGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const lista = listaPorTipo(opState.listaTipo, filter);
  if (lista.length === 0) { grid.innerHTML = '<div class="opEmpty">Nada coincide.</div>'; return; }
  lista.forEach(e => grid.appendChild(opEntBtn(e)));
}

function seleccionarEntidad(e) {
  opState.tipo = e.tipo;
  opState.tallNombre = e.Nombre;
  opState.tallCods = e.cods;
  opState.tallCod = e.tipo === 'prov_at' ? (e.cod || null) : null;
  opState.articulosManual = e.articulos || null;
  opState.linea = null;
  opState.articulos = null;
  opState.cargas = {};
  opState.ocPorCod = null;   // las OCs vigentes son POR proveedor → se recargan
  renderLinea();
}

function opEntBtn(e) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "opNameBtn";
  b.textContent = displayName(e.Nombre);
  b.onclick = () => seleccionarEntidad(e);
  return b;
}

/* ============== Paso 2: fecha + línea ============== */
function renderLinea() {
  opState.step = "linea";
  opSetBack(true);
  opTitle.textContent = displayName(opState.tallNombre);
  opSubtitle.textContent = "Fecha y línea";
  opActions.innerHTML = "";

  opBody.innerHTML = "";
  const fField = document.createElement("div");
  fField.className = "opField";
  fField.innerHTML = '<label>Fecha</label>';
  const fBox = document.createElement("div");
  fBox.className = "opFechaBox";
  const fTxt = document.createElement("span");
  fTxt.className = "opFechaTxt";
  fTxt.textContent = fechaCorta(opState.fecha);
  const fInput = document.createElement("input");
  fInput.type = "date";
  fInput.className = "opFechaHidden";
  fInput.value = opState.fecha;
  fInput.oninput = () => { opState.fecha = fInput.value; fTxt.textContent = fechaCorta(fInput.value); };
  fBox.appendChild(fTxt);
  fBox.appendChild(fInput);
  fField.appendChild(fBox);
  opBody.appendChild(fField);

  const lbl = document.createElement("div");
  lbl.className = "opField";
  lbl.innerHTML = '<label>Línea</label>';
  opBody.appendChild(lbl);

  const cods = opState.tallCods || {};
  const row = document.createElement("div");
  row.className = "opLineRow";
  [["LK", "Loeke"], ["CH", "Chef"]].forEach(([lineCode, nom]) => {
    const tieneCod = !!cods[lineCode];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opLineBtn" + (opState.linea === lineCode ? " active" : "");
    b.innerHTML = lineCode + '<br><span style="font-size:13px;font-weight:700">' + nom + '</span>';
    b.disabled = !tieneCod;
    if (!tieneCod) { b.style.opacity = ".35"; b.style.cursor = "not-allowed"; b.title = "Este tallerista no trabaja para " + nom; }
    b.onclick = () => {
      if (!tieneCod) return;
      if (opState.linea !== lineCode) { opState.articulos = null; opState.cargas = {}; }
      opState.linea = lineCode;
      if (opState.tipo === 'tallerista') opState.tallCod = cods[lineCode];
      renderTipoDoc();
    };
    row.appendChild(b);
  });
  opBody.appendChild(row);
  rcpDraftSave();
}

/* ============== Paso 3: ¿Qué documentación recibís? ============== */
function renderTipoDoc() {
  opState.step = "tipoDoc";
  opSetBack(true);
  opTitle.textContent = displayName(opState.tallNombre);
  opSubtitle.textContent = opState.linea + " · " + fechaCorta(opState.fecha);
  opBody.innerHTML = "";

  const heading = document.createElement("div");
  heading.style.cssText = "font-size:15px;font-weight:700;color:#475569;margin-bottom:14px;";
  heading.textContent = "¿Qué documentación recibís?";
  opBody.appendChild(heading);

  const tipos = [
    { key: "remito", label: "📄 Remito", color: "#4f46e5" },
    { key: "factura", label: "🧾 Factura", color: "#0d9488" },
    { key: "remito_factura", label: "📄🧾 Remito y Factura", color: "#1e6bd6" }
  ];
  tipos.forEach(t => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t.label;
    b.style.cssText = "width:100%;padding:18px;margin-bottom:10px;border:none;border-radius:12px;background:" + t.color + ";color:#fff;font-size:17px;font-weight:800;cursor:pointer;text-align:left;";
    b.onclick = () => { opState.tipoDoc = t.key; renderDocFields(); };
    opBody.appendChild(b);
  });

  opActions.innerHTML = "";
  rcpDraftSave();
}

/* ============== Paso 3b: Campos de documentación ============== */
function renderDocFields() {
  opState.step = "docFields";
  opSetBack(true);
  opTitle.textContent = displayName(opState.tallNombre);
  opSubtitle.textContent = opState.linea + " · " + fechaCorta(opState.fecha);
  opBody.innerHTML = "";

  const hasRemito = opState.tipoDoc === 'remito' || opState.tipoDoc === 'remito_factura';
  const hasFactura = opState.tipoDoc === 'factura' || opState.tipoDoc === 'remito_factura';

  // Defaults hoy AR
  var _hoyAR = "";
  try { _hoyAR = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" }); } catch (_e) {}
  if (hasRemito && !opState.nroRemito) opState.nroRemito = "";
  if (hasRemito && !opState.fechaRemito) opState.fechaRemito = _hoyAR;
  if (hasFactura && !opState.nroFactura) opState.nroFactura = "";
  if (hasFactura && !opState.fechaFactura) opState.fechaFactura = _hoyAR;

  // Botón Continuar arriba a la derecha
  const actRow = document.createElement("div");
  actRow.style.cssText = "display:flex;justify-content:flex-end;margin-bottom:16px;";
  const cont = document.createElement("button");
  cont.className = "btnSend btnBig";
  cont.textContent = "Continuar";
  cont.disabled = true;
  cont.onclick = () => {
    // Backwards compat: opState.remito para dedup/ref
    opState.remito = opState.nroRemito || opState.nroFactura || "";
    renderArticulos();
  };
  actRow.appendChild(cont);
  opBody.appendChild(actRow);

  function _updateCont() {
    var ok = true;
    if (hasRemito && (!opState.nroRemito || !opState.fechaRemito)) ok = false;
    if (hasFactura && (!opState.nroFactura || !opState.fechaFactura)) ok = false;
    cont.disabled = !ok;
    cont.classList.toggle("enabled", ok);
  }

  if (hasRemito) {
    var f1 = document.createElement("div"); f1.className = "opField";
    f1.innerHTML = '<label for="opNroRemito">N° de Remito</label>';
    var inp1 = document.createElement("input"); inp1.id = "opNroRemito";
    inp1.type = "text"; inp1.inputMode = "numeric";
    inp1.style.cssText = "width:100%;padding:12px;border:1.5px solid #cbd5e1;border-radius:10px;font-size:16px;box-sizing:border-box;background:#fff;";
    inp1.value = opState.nroRemito;
    inp1.oninput = () => { opState.nroRemito = inp1.value.replace(/\D/g, ""); inp1.value = opState.nroRemito; _updateCont(); };
    f1.appendChild(inp1); opBody.appendChild(f1);

    var f2 = document.createElement("div"); f2.className = "opField";
    f2.innerHTML = '<label for="opFechaRemito">Fecha de Remito</label>';
    var inp2 = document.createElement("input"); inp2.id = "opFechaRemito"; inp2.type = "date";
    inp2.style.cssText = "width:100%;padding:12px;border:1.5px solid #cbd5e1;border-radius:10px;font-size:16px;box-sizing:border-box;background:#fff;";
    inp2.value = opState.fechaRemito;
    inp2.onchange = () => { opState.fechaRemito = inp2.value; _updateCont(); };
    f2.appendChild(inp2); opBody.appendChild(f2);
  }

  if (hasFactura) {
    var f3 = document.createElement("div"); f3.className = "opField";
    f3.innerHTML = '<label for="opNroFactura">N° de Factura</label>';
    var inp3 = document.createElement("input"); inp3.id = "opNroFactura";
    inp3.type = "text"; inp3.inputMode = "numeric";
    inp3.style.cssText = "width:100%;padding:12px;border:1.5px solid #cbd5e1;border-radius:10px;font-size:16px;box-sizing:border-box;background:#fff;";
    inp3.value = opState.nroFactura;
    inp3.oninput = () => { opState.nroFactura = inp3.value.replace(/\D/g, ""); inp3.value = opState.nroFactura; _updateCont(); };
    f3.appendChild(inp3); opBody.appendChild(f3);

    var f4 = document.createElement("div"); f4.className = "opField";
    f4.innerHTML = '<label for="opFechaFactura">Fecha de Factura</label>';
    var inp4 = document.createElement("input"); inp4.id = "opFechaFactura"; inp4.type = "date";
    inp4.style.cssText = "width:100%;padding:12px;border:1.5px solid #cbd5e1;border-radius:10px;font-size:16px;box-sizing:border-box;background:#fff;";
    inp4.value = opState.fechaFactura;
    inp4.onchange = () => { opState.fechaFactura = inp4.value; _updateCont(); };
    f4.appendChild(inp4); opBody.appendChild(f4);
  }

  _updateCont();
  opActions.innerHTML = "";
  rcpDraftSave();
}

/* Compat: renderRemito redirige al nuevo flujo */
function renderRemito() { renderTipoDoc(); }

/* ============== Órdenes de Compra vigentes (v7.07) ==============
   El operario, al marcar la mercadería que recibe, ve en cada botón de código
   CUÁNTO se le pidió a ese tallerista/proveedor en la OC vigente ("OC 100"). Si
   carga más del +20% de esa cantidad NO se le interrumpe (nada de pop-up): el
   botón queda marcado en rojo y, al enviar, sale el aviso por Telegram (evento
   ROC → trigger `trg_recepcion_excede_oc_telegram`).

   FUENTE: tabla `Ordenes_Compra` — la MISMA que llena el generador de OCs desde el
   PPP (index.html → "📑 Órdenes de Compra" → "⚙ Generar OCs": A pedir = máx(0,
   Máximo + Pedidos PPP − Stock) por proveedor). O sea: lo que se muestra acá se
   alimenta solo con cada generación de OCs; no hay tabla ni carga aparte. Lectura
   con la anon key (policy `select_all`).

   VIGENTE = línea con estado ≠ 'recibida' y pedido > recibido, de los últimos
   OC_DIAS_VIGENCIA días. Si hay varias generaciones del mismo artículo se toma
   SOLO la más nueva (sumando sus líneas), para no acumular OCs viejas que ya se
   reemplazaron por una nueva corrida del generador.

   PROVEEDOR: `Ordenes_Compra.proveedor` viene de `OC_Maximos` y no siempre es
   idéntico al nombre del tallerista ("Martin C" = Martin, "Carlos E" = Carlos,
   "Pettofrezza" = Rafael por ALIAS_NOMBRE) y puede ser COMPARTIDO ("Garcia /
   Lucho", "Pintos / Maspoli" → la OC aplica a los dos). ocProvCoincide() parte por
   "/" y compara con la misma clave normalizada de los talleristas. */
const OC_EXCESO_PCT = 0.20;        // margen tolerado sobre lo pedido en la OC
const OC_DIAS_VIGENCIA = 120;      // más viejo que esto ya no se considera vigente

function ocSplitProv(prov) {
  const t = String(prov || "").trim();
  // El nombre ENTERO primero: hay proveedores que llevan "/" adentro y NO son
  // compartidos ("Log/ Fabr"). Después las partes, para las OCs de a dos.
  const keys = [claveTall(aliasNombre(t))];
  t.split(/[\/,+&]|\sy\s/i).forEach(function (s) { keys.push(claveTall(aliasNombre(s.trim()))); });
  return keys.filter(function (s, i) { return !!s && keys.indexOf(s) === i; });
}
function ocProvCoincide(prov, nombreEnt) {
  const k = claveTall(aliasNombre(nombreEnt || ""));
  if (!k) return false;
  return ocSplitProv(prov).some(function (p) {
    if (p === k) return true;
    // "Martin C" / "Carlos E": mismo nombre + una inicial de apellido pegada en la
    // config de OC. Se aceptan hasta 2 caracteres de diferencia, no más (para que
    // "Poly" no matchee cualquier cosa que empiece igual).
    const largo = p.length > k.length ? p : k, corto = p.length > k.length ? k : p;
    return largo.length - corto.length <= 2 && largo.indexOf(corto) === 0;
  });
}
function ocDiaLimite() {
  const d = new Date(); d.setDate(d.getDate() - OC_DIAS_VIGENCIA);
  const p = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
/* Carga las OCs vigentes del proveedor elegido en opState.ocPorCod (clave = código
   normalizado). Best-effort: si falla, queda {} y la pantalla funciona como antes. */
async function cargarOCVigentes() {
  /* v10.10 — reemplaza fetch de 5000 OC rows + filtro client-side por RPC server-side
     oc_vigentes_por_proveedor(nombre). La RPC aplica alias (Pettofrezza→Rafael),
     split por delimitadores (/,+& y), y prefix match con ≤2 chars de slack. */
  /* v11.74 — usa supabase.rpc() en vez de fetch manual. El fetch usaba la publishable
     key como Bearer token (no es JWT) → PostgREST podía rechazarlo silenciosamente.
     supabase.rpc() usa el token de sesión real (de signInAnonymously). */
  const nombre = opState.tallNombre;
  try {
    await sessionReady;
    const { data: rows, error } = await supabase.rpc('oc_vigentes_por_proveedor', { nombre_ent: nombre });
    if (error) throw new Error(error.message);
    const porCod = {};
    (rows || []).forEach(function (r) {
      const k = String(r.cod || ""); if (!k) return;
      porCod[k] = { fecha: r.fecha || "", ped: Number(r.ped) || 0, rec: Number(r.rec) || 0, pend: Number(r.pend) || 0 };
    });
    if (opState.tallNombre !== nombre) return;
    opState.ocPorCod = porCod;
  } catch (e) {
    console.warn("OCs vigentes (sigue sin el detalle):", e);
    if (opState.tallNombre === nombre) opState.ocPorCod = {};
  }
}
function ocDeCod(cod) {
  const m = opState.ocPorCod;
  if (!m) return null;
  return m[_ocgNorm(cod)] || null;
}
/* Cantidad de referencia de la OC: lo que FALTA recibir (= lo pedido mientras no se
   haya marcado nada recibido en el módulo de OCs). */
function ocRef(oc) { return (oc && oc.pend > 0) ? oc.pend : (oc ? oc.ped : 0); }
function ocExcede(cod, cajas) {
  const oc = ocDeCod(cod);
  const ref = ocRef(oc);
  return (ref > 0 && cajas > ref * (1 + OC_EXCESO_PCT));
}
function ocPctExceso(cod, cajas) {
  const ref = ocRef(ocDeCod(cod));
  return ref > 0 ? Math.round((cajas / ref - 1) * 100) : 0;
}

/* v9.63 (idea 3239) — AVISO "no entra en góndola / capaz se devuelve". Al recibir, marca (NO
   bloquea) los artículos que cumplen LAS TRES: (1) NO estaban en la OC vigente, (2) NO entran en
   góndola por mucho ((góndola actual + lo recibido) > capacidad × 1.20), (3) baja rotación
   (proyección < 50 caj/mes). El operario tiene que pedir confirmación de que no se devuelve.
   Best-effort: si no hay capacidad cargada para el código, NO avisa (evita falsos positivos).
   Datos: Capacidad_Sector (góndola máx), vista_saldos_stock.terminado (góndola actual),
   proyeccion_madre.proy_cajas_mes (rotación), opState.ocPorCod (lo pedido en la OC). */
const GOND_EXCESO_FACTOR = 1.20;   // "por mucho" = 20% arriba de la capacidad de góndola
const GOND_BAJA_ROT = 50;          // baja rotación = menos de 50 cajas/mes de proyección
async function gondReturnCheck(items) {
  try {
    await sessionReady;
    const cods = [];
    (items || []).forEach(function (it) { const c = String(it.cod || "").trim(); if (c && cods.indexOf(c) < 0) cods.push(c); });
    if (!cods.length) return [];
    const res = await Promise.all([
      supabase.from("Capacidad_Sector").select("cod,cajas_max"),
      supabase.from("vista_saldos_stock").select("cod_art,terminado").in("cod_art", cods),
      supabase.from("proyeccion_madre").select("cod,proy_cajas_mes")
    ]);
    const cap = {}, gond = {}, proy = {};
    ((res[0] && res[0].data) || []).forEach(function (r) { const k = _ocgNorm(r.cod); if (k) cap[k] = (cap[k] || 0) + (Number(r.cajas_max) || 0); });
    ((res[1] && res[1].data) || []).forEach(function (r) { gond[_ocgNorm(r.cod_art)] = Number(r.terminado) || 0; });
    ((res[2] && res[2].data) || []).forEach(function (r) { const k = _ocgNorm(r.cod); if (k) proy[k] = Number(r.proy_cajas_mes) || 0; });
    const flag = [];
    (items || []).forEach(function (it) {
      const k = _ocgNorm(it.cod);
      const c = cap[k] || 0; if (c <= 0) return;             // sin capacidad conocida → no aviso (evita falso positivo)
      if (ocDeCod(it.cod)) return;                           // estaba en la OC → no aviso
      const p = proy[k] || 0; if (p >= GOND_BAJA_ROT) return; // rota bien → no aviso
      const g = gond[k] || 0;
      if ((g + Number(it.cajas || 0)) > c * GOND_EXCESO_FACTOR) flag.push({ cod: it.cod, cajas: it.cajas, cap: c, gond: g, proy: p });
    });
    return flag;
  } catch (_e) { return []; }
}

/* ============== Paso 4: grilla de códigos ============== */
async function renderArticulos() {
  opState.step = "articulos";
  opSetBack(true);
  opTitle.textContent = displayName(opState.tallNombre);
  opSubtitle.textContent = opState.linea + " · " + fechaCorta(opState.fecha) + " · RTO/FC " + opState.remito;
  opActions.innerHTML = "";

  // v7.07: las OCs vigentes se traen EN PARALELO (no bloquean la grilla); cuando
  // llegan se repinta para que aparezca el detalle "OC N" en cada botón.
  if (opState.ocPorCod === null) {
    cargarOCVigentes().then(function () {
      if (opState.step === "articulos") drawArticulosGrid();
    });
  }

  if (opState.articulos === null) {
    opBody.innerHTML = '<div class="opEmpty">Cargando códigos…</div>';
    let lista = [], error = null;

    if (opState.articulosManual) {
      lista = opState.articulosManual.map(a => ({ Cod_Art: a.Cod_Art, Desc: a.Desc || "" }));
    } else if (opState.tipo === 'prov_at') {
      // v10.25: usa vista_articulos_prov_at (join ya hecho en el backend)
      const res = await supabase
        .from("vista_articulos_prov_at")
        .select("cod_art,descripcion")
        .eq("proveedor", opState.tallNombre)
        .eq("linea", opState.linea)
        .order("cod_art");
      error = res.error;
      if (res.data) {
        lista = res.data.map(r => ({ Cod_Art: r.cod_art, Desc: r.descripcion || "" }));
      }
    } else {
      const res = await supabase
        .from("Articulos Virgilio X Tallerista")
        .select("Cod_Art")
        .eq("Cod_Tallerista", opState.tallCod)
        .eq("Linea", opState.linea)
        .order("Cod_Art");
      error = res.error;
      if (res.data) lista = res.data.map(r => ({ Cod_Art: r.Cod_Art, Desc: "" }));
    }

    if (opState.step !== "articulos") return;
    if (error) { opBody.innerHTML = '<div class="opEmpty" style="color:var(--danger)">Error: ' + error.message + '</div>'; return; }
    const vistos = new Set();
    opState.articulos = [];
    // En Log/Fabr no aplicamos el filtro "empieza con número" (ahí van los
    // códigos agregados a mano con "+", que ya viven en la misma tabla).
    const permitirNoNum = arEsLogFabr();
    lista.forEach(r => {
      const codArt = String(r.Cod_Art || "").trim();
      if (codArt && (permitirNoNum || /^[0-9]/.test(codArt)) && !vistos.has(r.Cod_Art)) {
        vistos.add(r.Cod_Art);
        opState.articulos.push({ Cod_Art: r.Cod_Art, Desc: r.Desc || "" });
      }
    });
  }

  drawArticulosGrid();
}

function drawArticulosGrid() {
  opBody.innerHTML = "";
  const hayArts = opState.articulos && opState.articulos.length > 0;
  // Sin códigos: aviso normal, salvo en Log/Fabr (ahí igual mostramos el "+").
  if (!hayArts && !arEsLogFabr()) {
    opBody.innerHTML = '<div class="opEmpty">No hay códigos para la línea ' + opState.linea + '.</div>';
    opActions.innerHTML = "";
    return;
  }
  const grid = document.createElement("div");
  grid.className = "opGrid codes";
  // Orden numérico por código (el agregado a mano queda en su lugar, no al final).
  const numKey = c => { const m = String(c).match(/^(\d+)/); return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER; };
  const artsOrden = (opState.articulos || []).slice().sort((a, b) =>
    (numKey(a.Cod_Art) - numKey(b.Cod_Art))
    || (String(a.Cod_Art) < String(b.Cod_Art) ? -1 : String(a.Cod_Art) > String(b.Cod_Art) ? 1 : 0)
  );
  artsOrden.forEach(a => {
    const cajas = opState.cargas[a.Cod_Art];
    const oc = ocDeCod(a.Cod_Art);
    const exc = cajas > 0 && ocExcede(a.Cod_Art, cajas);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opCodeBtn" + (cajas > 0 ? " loaded" : "") + (exc ? " exceso" : "");
    // v7.07: detalle de la OC vigente del proveedor. "OC 100" = pedidas 100 cajas;
    // si ya hay recibido parcial cargado en el módulo de OCs → "OC 40/100" (faltan/pedidas).
    let ocHtml = "";
    if (oc) {
      const txt = (oc.rec > 0) ? (oc.pend + "/" + oc.ped) : String(oc.ped);
      const title = "Orden de compra vigente (" + fechaCorta(oc.fecha) + "): " + oc.ped + " caja(s) pedidas" +
        (oc.rec > 0 ? ", " + oc.rec + " ya recibida(s) → faltan " + oc.pend : "");
      ocHtml = '<span class="ocq" title="' + escapeHtmlRcp(title) + '">OC ' + escapeHtmlRcp(txt) + '</span>';
    }
    b.innerHTML = '<span>' + a.Cod_Art + '</span>' + ocHtml +
      (cajas > 0 ? '<span class="cnt">' + cajas + ' caja' + (cajas === 1 ? '' : 's') + (exc ? ' ⚠' : '') + '</span>' : '');
    b.onclick = () => openCajas(a.Cod_Art);
    grid.appendChild(b);
  });
  // Log/Fabr: botón "+" para agregar un artículo nuevo (queda fijo).
  if (arEsLogFabr()) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "opCodeBtn opCodeAdd";
    addBtn.innerHTML = '<span class="opCodeAddPlus">+</span>';
    addBtn.title = "Agregar artículo a Log/Fabr";
    addBtn.onclick = arAddCode;
    grid.appendChild(addBtn);
  }
  opBody.appendChild(grid);

  const total = Object.values(opState.cargas).filter(n => n > 0).length;
  opActions.innerHTML = "";
  const enviarBtn = document.createElement("button");
  enviarBtn.className = "btnSend btnBig";
  enviarBtn.textContent = "Enviar" + (total > 0 ? " (" + total + ")" : "");
  enviarBtn.disabled = total === 0;
  enviarBtn.onclick = renderResumen;
  opActions.appendChild(enviarBtn);
  rcpDraftSave();
}

/* ============== Agregar artículo a Log/Fabr (botón "+") ==============
   Solo para el tallerista Log/Fabr. El código nuevo se inserta en la MISMA tabla
   que lee la grilla ("Articulos Virgilio X Tallerista"), para las dos líneas de
   Log/Fabr → queda fijo y compartido entre dispositivos, SIN tablas extra. */
function arEsLogFabr() {
  return opState.tipo === 'tallerista' && claveTall(opState.tallNombre || "") === claveTall("Log/Fabr");
}
/* Guarda el código en "Articulos Virgilio X Tallerista" (best-effort).
   MAESTRO: busca una fila existente del MISMO código (cualquier tallerista) y
   COPIA todas sus columnas (Desc, UxB y cualquier otro dato del artículo);
   solo cambia Cod_Tallerista + Línea. Así el alta queda con la descripción y
   demás datos que el sistema usa después, sin dejar nada vacío. Inserta una fila
   por cada línea de Log/Fabr (LK y CH) → aparece en ambas y en cualquier device.
   Si el código no existe en ningún lado, cae a un alta mínima (Desc: ""). */
async function arSaveCodeRemote(cod) {
  let base = null;
  try {
    const res = await supabase.from("Articulos Virgilio X Tallerista")
      .select("*").eq("Cod_Art", cod).limit(1);
    if (!res.error && res.data && res.data.length) base = res.data[0];
  } catch (e) { /* sin red: alta mínima */ }

  const cods = opState.tallCods || {};
  const dest = [];
  if (cods.LK) dest.push({ codTall: cods.LK, linea: "LK" });
  if (cods.CH) dest.push({ codTall: cods.CH, linea: "CH" });
  if (!dest.length && opState.tallCod) dest.push({ codTall: opState.tallCod, linea: opState.linea });
  if (!dest.length) return;

  const rows = dest.map(function (d) {
    const row = base ? Object.assign({}, base) : { Cod_Art: cod, Desc: "" };
    delete row.id; delete row.created_at; delete row.updated_at;   // PK/auto: que las genere la DB
    row.Cod_Art = cod;
    row.Cod_Tallerista = d.codTall;
    row.Linea = d.linea;
    return row;
  });
  try {
    const ins = await supabase.from("Articulos Virgilio X Tallerista").insert(rows);
    if (ins && ins.error) {
      console.warn("alta artículo Log/Fabr:", ins.error.message);
      alert("El código quedó para esta carga, pero NO se pudo guardar fijo en la base:\n" +
            ins.error.message + "\n\nAvisá al admin.");
    }
  } catch (e) { /* no-op */ }
}
/* idea 3521: MISMA normalización de códigos que index.html (_ocgNorm = upper + trim +
   sin ceros a la izquierda). recepcion.js es un módulo (scope propio) y no ve el
   _ocgNorm de index.html, así que replicamos el canónico acá para que "027" cruce
   con "27" y no se dupliquen artículos. */
function _ocgNorm(c) { return String(c == null ? "" : c).toUpperCase().trim().replace(/^0+(?=.)/, ""); }

function arAddCode() {
  let cod = prompt("Código del artículo nuevo para Log/Fabr:");
  if (cod == null) return;                       // canceló
  cod = _ocgNorm(cod);
  if (!cod) return;
  if (!opState.articulos) opState.articulos = [];
  const existe = opState.articulos.some(a => _ocgNorm(a.Cod_Art) === cod);
  if (!existe) {
    opState.articulos.push({ Cod_Art: cod, Desc: "" });   // mostrar al instante
    arSaveCodeRemote(cod);                                  // guardar fijo (compartido)
  }
  drawArticulosGrid();
  openCajas(cod);                                // que le cargue las cajas ya mismo
}

/* ============== Paso 5: resumen ============== */
function renderResumen() {
  const items = Object.entries(opState.cargas)
    .filter(([, n]) => n > 0)
    .map(([cod, n]) => ({ cod, cajas: n }));
  if (items.length === 0) { alert("Cargá al menos un código con cajas."); return; }

  opState.step = "resumen";
  opSetBack(true);
  opTitle.textContent = "Confirmá el envío";
  opSubtitle.textContent = opState.linea + " · " + fechaCorta(opState.fecha) + " · RTO/FC " + opState.remito;

  opBody.innerHTML = "";
  const h = document.createElement("div");
  h.className = "resHeader";
  h.textContent = displayName(opState.tallNombre);
  opBody.appendChild(h);

  const list = document.createElement("div");
  list.className = "resList";
  items.forEach(i => {
    const r = document.createElement("div");
    r.className = "resItem";
    const c = document.createElement("span"); c.className = "resCod"; c.textContent = i.cod;
    const q = document.createElement("span"); q.className = "resCajas"; q.textContent = i.cajas + " caja" + (i.cajas === 1 ? "" : "s");
    r.appendChild(c); r.appendChild(q);
    list.appendChild(r);
  });
  opBody.appendChild(list);

  const tot = document.createElement("div");
  tot.className = "resTotal";
  const totalCajas = items.reduce((s, i) => s + i.cajas, 0);
  tot.textContent = "Total: " + items.length + " código(s) · " + totalCajas + " cajas";
  opBody.appendChild(tot);

  /* v11.xx — Foto obligatoria de la mercadería (se sube al confirmar).
     v12.64 — Si el operario eligió "Remito y Factura" se piden DOS fotos, una de cada
     papel, y las dos son obligatorias. Con un solo documento sigue siendo una sola,
     igual que siempre. El bloque se arma con la misma función para que las dos se
     comporten idéntico (preview, cambiar, validación). */
  const dosFotos = (opState.tipoDoc === "remito_factura");

  function _fotoBloque(slot, titulo, textoBtn) {
    // slot 1 → opState.fotoFile / fotoPreviewUrl ; slot 2 → fotoFile2 / fotoPreviewUrl2
    const kFile = slot === 2 ? "fotoFile2" : "fotoFile";
    const kUrl  = slot === 2 ? "fotoPreviewUrl2" : "fotoPreviewUrl";
    const sec = document.createElement("div");
    sec.className = "opFotoSection";
    if (titulo) {
      const h = document.createElement("div");
      h.className = "opFotoTitulo";
      h.textContent = titulo;
      sec.appendChild(h);
    }
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*";
    input.setAttribute("capture", "environment");
    input.style.display = "none";
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "opFotoBtn" + (opState[kFile] ? " has" : "");
    btn.textContent = opState[kFile] ? "📷 ✓ Foto sacada — tocá para cambiar" : textoBtn;
    const prev = document.createElement("div");
    prev.className = "opFotoPreview";
    if (opState[kUrl]) { const pi = document.createElement("img"); pi.src = opState[kUrl]; prev.appendChild(pi); }
    const hint = document.createElement("div");
    hint.className = "opFotoHint";
    hint.textContent = opState[kFile] ? "" : "Obligatorio: sacá esta foto antes de enviar";
    hint.style.display = opState[kFile] ? "none" : "";
    btn.onclick = function() { input.click(); };
    input.onchange = function() {
      if (input.files && input.files[0]) {
        opState[kFile] = input.files[0];
        btn.textContent = "📷 ✓ Foto sacada — tocá para cambiar";
        btn.classList.add("has");
        hint.style.display = "none";
        try {
          if (opState[kUrl]) URL.revokeObjectURL(opState[kUrl]);
          opState[kUrl] = URL.createObjectURL(opState[kFile]);
          prev.innerHTML = "";
          const pi = document.createElement("img"); pi.src = opState[kUrl]; prev.appendChild(pi);
        } catch(_e){}
        _fotosSync();
      }
    };
    sec.appendChild(input); sec.appendChild(btn); sec.appendChild(prev); sec.appendChild(hint);
    return sec;
  }

  // Habilita Confirmar sólo con TODAS las fotos que corresponden a este tipo de doc.
  function _fotosOk() { return !!opState.fotoFile && (!dosFotos || !!opState.fotoFile2); }
  function _fotosSync() {
    const cb = document.getElementById("opConfirmar");
    if (cb) cb.disabled = !_fotosOk();
  }

  if (dosFotos) {
    opBody.appendChild(_fotoBloque(1, "📄 Foto del REMITO", "📷 Sacar foto del remito"));
    opBody.appendChild(_fotoBloque(2, "🧾 Foto de la FACTURA", "📷 Sacar foto de la factura"));
  } else {
    opBody.appendChild(_fotoBloque(1, "", "📷 Sacar foto de la mercadería"));
  }

  opActions.innerHTML = "";
  const volver = document.createElement("button");
  volver.className = "btnCancel btnBig";
  volver.textContent = "‹ Volver";
  volver.onclick = () => renderArticulos();
  const conf = document.createElement("button");
  conf.className = "btnSend btnBig";
  conf.id = "opConfirmar";
  conf.textContent = "✓ Confirmar y enviar";
  conf.onclick = opEnviar;
  conf.disabled = !_fotosOk();
  opActions.appendChild(volver);
  opActions.appendChild(conf);
  rcpDraftSave();
}

/* ============== Popup de cajas ============== */
function openCajas(cod) {
  opState.cajasCod = cod;
  opCajasCod.textContent = cod;
  const actual = opState.cargas[cod];
  opCajasInput.value = actual > 0 ? String(actual) : "";
  opCajasDelete.style.display = actual > 0 ? "" : "none";
  // v7.07: recordatorio de la OC vigente mientras carga las cajas.
  const oc = ocDeCod(cod);
  opState.cajasOc = oc || null;   // v8.60 — guardado para el aviso de exceso en vivo
  if (opCajasOc) {
    if (oc) {
      opCajasOc.style.display = "";
      opCajasOc.style.background = ""; opCajasOc.style.borderColor = "";
      opCajasOc.innerHTML = _opCajasOcBase(oc);
    } else {
      opCajasOc.style.display = "none";
      opCajasOc.innerHTML = "";
    }
  }
  // v11.78: teclado con punto decimal para códigos fraccionarios
  opCajasInput.inputMode = _esCodDecimal(cod) ? "decimal" : "numeric";
  opCajasModal.classList.add("open");
  setTimeout(() => { opCajasInput.focus(); _opCajasExceso(); }, 50);
}
/* v8.60 — texto base del recordatorio de OC. */
function _opCajasOcBase(oc) {
  return "📑 OC vigente (" + escapeHtmlRcp(fechaCorta(oc.fecha)) + "): <b>" + oc.ped + "</b> caja(s) pedidas" +
    (oc.rec > 0 ? " · <b>" + oc.pend + "</b> por recibir" : "");
}
/* v8.60 — aviso EN VIVO si lo tipeado supera lo que falta recibir por OC (caza typos tipo 500 vs 50
   antes de enviar; sin pop-up, no bloquea — mismo espíritu que el aviso ROC pero visible al momento). */
function _opCajasExceso() {
  if (!opCajasOc) return;
  const oc = opState.cajasOc;
  if (!oc || !(oc.pend > 0)) return;
  const n = _esCodDecimal(opState.cajasCod) ? (parseFloat(opCajasInput.value) || 0) : (parseInt(opCajasInput.value, 10) || 0);
  if (n > oc.pend) {
    opCajasOc.style.background = "#fef2f2"; opCajasOc.style.borderColor = "#fca5a5";
    opCajasOc.innerHTML = _opCajasOcBase(oc) + '<br><b style="color:#b91c1c;">⚠ Cargás ' + n + ' pero por OC faltan ' + oc.pend + '. Revisá que no sea un error de tipeo.</b>';
  } else {
    opCajasOc.style.background = ""; opCajasOc.style.borderColor = "";
    opCajasOc.innerHTML = _opCajasOcBase(oc);
  }
}
function closeCajas() { opCajasModal.classList.remove("open"); opState.cajasCod = null; }
// v11.78: códigos con decimales permitidos (cajas fraccionarias)
const _CODS_DECIMAL = ["55215","55219","55289"];
const _esCodDecimal = (c) => _CODS_DECIMAL.indexOf(String(c).replace(/\D/g,"")) >= 0;
opCajasInput.oninput = () => {
  if (_esCodDecimal(opState.cajasCod)) {
    opCajasInput.value = opCajasInput.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
  } else {
    opCajasInput.value = opCajasInput.value.replace(/\D/g, "");
  }
  _opCajasExceso();
};
opCajasInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); opCajasNext.click(); }
});
opCajasClose.onclick = closeCajas;
// Antes: tocar el fondo oscuro cerraba el pop-up. Lo sacamos para que NO se cierre
// solo si el empleado tarda en cargar / toca fuera sin querer — solo se cierra con
// la ✕ o al cargar el número. (Pedido: "que se mantenga".)
opCajasNext.onclick = () => {
  const n = _esCodDecimal(opState.cajasCod) ? (parseFloat(opCajasInput.value) || 0) : (parseInt(opCajasInput.value, 10) || 0);
  if (n > 0) opState.cargas[opState.cajasCod] = n;
  else delete opState.cargas[opState.cajasCod];
  closeCajas();
  drawArticulosGrid();
};
opCajasDelete.onclick = () => {
  delete opState.cargas[opState.cajasCod];
  closeCajas();
  drawArticulosGrid();
};

/* ============== Verificación de código (v9.26) ============== */
/* Genera código de 4 dígitos al azar */
function generateVerificationCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/* Modal de verificación: pide escribir el código antes de enviar */
async function showVerificationModal() {
  const code = generateVerificationCode();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "rcpVerifyOverlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      font-family: inherit;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
      background: white; border-radius: 12px; padding: 24px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 400px; width: 90vw; text-align: center;
      font-family: inherit;
    `;

    const title = document.createElement("h2");
    title.textContent = "Verificación de Remito";
    title.style.cssText = `margin: 0 0 16px 0; font-size: 18px; color: #1f2937;`;
    modal.appendChild(title);

    const instruction = document.createElement("p");
    instruction.textContent = "Escribí este código en el remito y copialo acá:";
    instruction.style.cssText = `margin: 0 0 16px 0; color: #6b7280; font-size: 14px;`;
    modal.appendChild(instruction);

    const codeDisplay = document.createElement("div");
    codeDisplay.textContent = code;
    codeDisplay.style.cssText = `
      background: #f3f4f6; padding: 16px; border-radius: 8px;
      font-size: 32px; font-weight: bold; letter-spacing: 8px;
      margin: 0 0 8px 0; font-family: 'Courier New', monospace;
      color: #1f2937;
    `;
    modal.appendChild(codeDisplay);

    const codeHint = document.createElement("p");
    codeHint.textContent = "✏️ Escribir en el remito físico";
    codeHint.style.cssText = `
      margin: 0 0 20px 0; color: #9ca3af; font-size: 13px; font-style: italic;
    `;
    modal.appendChild(codeHint);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Escribí el código";
    input.maxLength = "4";
    input.style.cssText = `
      width: 100%; padding: 12px; font-size: 18px; border: 2px solid #e5e7eb;
      border-radius: 8px; box-sizing: border-box; margin: 0 0 16px 0;
      font-family: 'Courier New', monospace; letter-spacing: 4px;
      text-align: center;
    `;
    input.oninput = () => {
      input.value = input.value.replace(/[^0-9]/g, "");
    };
    modal.appendChild(input);

    const buttonContainer = document.createElement("div");
    buttonContainer.style.cssText = `
      display: flex; gap: 10px; margin-top: 16px;
    `;

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "✓ Confirmar";
    confirmBtn.style.cssText = `
      flex: 1; padding: 12px; background: #2563eb; color: white;
      border: none; border-radius: 8px; font-size: 14px; font-weight: bold;
      cursor: pointer; transition: background 0.2s;
    `;
    confirmBtn.onmouseover = () => { confirmBtn.style.background = "#1d4ed8"; };
    confirmBtn.onmouseout = () => { confirmBtn.style.background = "#2563eb"; };
    confirmBtn.onclick = () => {
      if (input.value === code) {
        overlay.remove();
        resolve(true);
      } else {
        input.style.borderColor = "#ef4444";
        input.style.background = "#fee2e2";
        setTimeout(() => {
          input.style.borderColor = "#e5e7eb";
          input.style.background = "white";
          input.value = "";
          input.focus();
        }, 1000);
      }
    };
    buttonContainer.appendChild(confirmBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "✕ Cancelar";
    cancelBtn.style.cssText = `
      flex: 1; padding: 12px; background: #e5e7eb; color: #1f2937;
      border: none; border-radius: 8px; font-size: 14px; font-weight: bold;
      cursor: pointer; transition: background 0.2s;
    `;
    cancelBtn.onmouseover = () => { cancelBtn.style.background = "#d1d5db"; };
    cancelBtn.onmouseout = () => { cancelBtn.style.background = "#e5e7eb"; };
    cancelBtn.onclick = () => {
      overlay.remove();
      resolve(false);
    };
    buttonContainer.appendChild(cancelBtn);

    modal.appendChild(buttonContainer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    input.focus();
  });
}

/* Exponer showVerificationModal globalmente para acceso desde index.html (MG, etc.) */
if (typeof window !== "undefined") {
  window.showVerificationModal = showVerificationModal;
}

/* ============== Enviar (graba todo) ============== */
async function opEnviar() {
  // v10.11 — SACADA la "Verificación de Remito" (código a escribir en el remito ANTES de enviar):
  // la recepción da UN SOLO código, el de confirmación del final (pendGenCodigo, más abajo).
  const descPorCod = {};
  (opState.articulos || []).forEach(a => { descPorCod[a.Cod_Art] = a.Desc || ""; });
  const items = Object.entries(opState.cargas)
    .filter(([, n]) => n > 0)
    .map(([cod, n]) => ({ cod, cajas: n, desc: descPorCod[cod] || "" }));
  if (items.length === 0) { alert("Cargá al menos un código con cajas."); return; }
  const totalCajas = items.reduce((s, i) => s + i.cajas, 0);

  const btn = document.getElementById("opConfirmar");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Enviando…";

  const session = await sessionReady;
  if (!session) {
    btn.disabled = false; btn.textContent = prev;
    alert("No se pudo iniciar sesión anónima. Avisá al admin y refrescá la página.");
    return;
  }

  let tabla, rows;
  if (opState.tipo === 'prov_at') {
    tabla = "Entregas Prov AT";
    const partes = (opState.fecha || "").split("-");
    const diaMes = (partes.length === 3) ? (partes[2] + "-" + partes[1]) : "";
    rows = items.map(i => ({
      Dia_mes: diaMes,
      Proveedor: opState.tallNombre,
      Cod_Art: i.cod,
      Descripcion: i.desc,
      Cantidad: i.cajas,
      Remito: opState.remito,
      Tipo_Entrega: opState.tipoDoc || null,
      Fecha_RTO: opState.fechaRemito || null,
      Numero_Factura: opState.nroFactura || null,
      Fecha_Factura: opState.fechaFactura || null
    }));
  } else {
    tabla = "Entregas Tallerista Virgilio";
    rows = items.map(i => ({
      Fecha: opState.fecha,
      Codigo_Tall: opState.tallCod,
      Nombre_Tall: opState.tallNombre,
      Cod: i.cod,
      Cajas: i.cajas,
      Remito: opState.remito,
      Tipo_Entrega: opState.tipoDoc || null,
      Fecha_RTO: opState.fechaRemito || null,
      Numero_Factura: opState.nroFactura || null,
      Fecha_Factura: opState.fechaFactura || null
    }));
  }

  // idea 9047: dedup de remito. Reenviar el mismo remito (timeout ambiguo / recarga con
  // mala señal de depósito) duplicaba cajas en Movimientos_Stock y filas de Entregas. Antes
  // de insertar chequeamos si ese remito ya está cargado para este proveedor/tallerista y
  // pedimos confirmación. Falla ABIERTO: si el chequeo no se puede hacer (red), no bloquea.
  if (String(opState.remito || "").trim()) {
    try {
      let q = supabase.from(tabla).select("Remito").eq("Remito", opState.remito).limit(1);
      q = (opState.tipo === 'prov_at') ? q.eq("Proveedor", opState.tallNombre) : q.eq("Codigo_Tall", opState.tallCod);
      const { data: yaHay } = await q;
      if (yaHay && yaHay.length) {
        const ok = confirm("⚠ El remito " + opState.remito + " ya figura cargado para " + opState.tallNombre + ".\n\nSi lo reenviás se DUPLICAN las cajas y el stock.\n\n¿Cargarlo igual?");
        if (!ok) { btn.disabled = false; btn.textContent = prev; return; }
      }
    } catch (_e) { /* chequeo falla abierto: no bloquea la carga */ }
  }

  const { error } = await supabase.from(tabla).insert(rows);

  if (error) {
    btn.disabled = false; btn.textContent = prev;
    const msg = error.message || "";
    if (/remito/i.test(msg)) {
      alert('Falta crear la columna "Remito" en la tabla "' + tabla + '".\n\n' +
        'Pedile al admin que ejecute en el SQL Editor de Supabase:\n\n' +
        'ALTER TABLE "' + tabla + '" ADD COLUMN "Remito" text;');
    } else {
      alert("Error al guardar: " + msg);
    }
    return;
  }

  // Suma al acumulador del día para que Producción cierre RT con esta cantidad.
  recpAddCajas(totalCajas);
  // v11.98: cierra el toggle RT automáticamente (el operario ya no tiene que volver
  // a la botonera para terminar el inicio→fin de Recepción Mercadería).
  try { if (typeof window.autoCloseRT === "function") window.autoCloseRT(RECP.legajo); } catch (_e) {}
  rcpDraftClear();   // v7.12: ya se envió, no hay nada que reanudar

  // v1.1 — Pasaje de Papeles: mostrar pop-up para capturar documentación
  try {
    if (typeof window.ppShowCaptureDialog === 'function') {
      window.ppShowCaptureDialog('mercaderia', {
        tipoDoc: opState.tipoDoc || '',
        nroRemito: opState.nroRemito || '',
        nroFactura: opState.nroFactura || '',
        fechaRemito: opState.fechaRemito || '',
        fechaFactura: opState.fechaFactura || '',
        proveedor: opState.tallNombre || '',
        codProveedor: opState.tallCod || ''   // v1.2 — código del tallerista/prov. AT (para Pasaje de Papeles)
      });
    }
  } catch (_e) { /* no-op si el módulo no está cargado */ }

  // v4.06: STOCK — lo recibido ENTRA a "Mercadería a guardar" (Movimientos_Stock).
  // Best-effort; si falla, queda en vir_stock_pend y lo reintenta index.html (stockFlushPend).
  // idea 5490: un client_id ESTABLE por fila; el mismo id se usa en el insert y en la
  // cola offline, así el reintento (POST que llegó pero cuya respuesta se perdió) NO
  // duplica cajas (índice único parcial mov_stock_clientid_dedup + ignore-duplicates).
  const _cid = () => { try { if (typeof crypto !== "undefined" && crypto.randomUUID) return "mst_" + crypto.randomUUID(); } catch (_e) {} return "mst_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10); };
  const stockRows = items.map(i => ({
    cod_art: String(i.cod), descripcion: i.desc || null,
    deposito: 'a_guardar', delta: i.cajas, tipo: 'recepcion', ref: opState.remito || null,
    legajo: RECP.legajo || null,   // idea 7725: legajo para sumar el total del día cruzando dispositivos al cerrar RT
    // v12.38 — empresa de la recepción = línea que eligió el operario (LK/CH). Para los
    // códigos duales (437E/438E/439E/809E) esto ubica el stock recibido en la góndola
    // correcta; para el resto el trigger zz_normalizar_empresa lo fuerza a 'Mixto'. Sin
    // esto un dual recibido quedaba en limbo 'Mixto' (ni LK ni CH). La fuente de verdad
    // sigue siendo el trigger en el backend; esto es la señal correcta que el front manda.
    empresa: opState.linea || null,
    client_id: _cid()
  }));
  try {
    const { error: stErr } = await supabase.from("Movimientos_Stock").insert(stockRows);
    if (stErr) throw stErr;
  } catch (e) {
    console.warn("Movimientos_Stock recepcion (queda pendiente):", e);
    try {
      const p = JSON.parse(localStorage.getItem("vir_stock_pend") || "[]");
      p.push.apply(p, stockRows);   // MISMO client_id → stockFlushPend reintenta idempotente
      localStorage.setItem("vir_stock_pend", JSON.stringify(p.slice(-5000)));
    } catch (_e) {}
  }

  // idea 3239 — AVISO (no bloquea): lo recibido no entra en góndola + no estaba en la OC + baja
  // rotación → pedir confirmación de que no se devuelve. Best-effort, después de registrar.
  gondReturnCheck(items).then(function (flag) {
    if (!flag || !flag.length) return;
    const txt = flag.map(function (f) { return "• " + f.cod + " — llegan " + f.cajas + " (góndola " + Math.round(f.gond) + "/" + Math.round(f.cap) + " máx · proy " + Math.round(f.proy) + " caj/mes)"; }).join("\n");
    try { alert("⚠ OJO: esto NO entra en góndola, es de baja rotación y NO estaba en la OC:\n\n" + txt + "\n\nPedí AUTORIZACIÓN / confirmación de que no se devuelve."); } catch (_e) {}
  }).catch(function () {});

  // v4.61 — AVISO recepción sin planimetría: si llegan códigos que NO tienen lugar en
  // la góndola (window.GONDOLA, planimetría), se emite un evento RSP → trigger Telegram
  // + categoría "sin_planimetria" en el tablero Agentes. Best-effort, no bloquea.
  try {
    const G = (typeof window !== "undefined" && window.GONDOLA) ? window.GONDOLA : null;
    if (G) {
      const seen = {}, sinLugar = [];
      items.forEach(i => { const k = _ocgNorm(i.cod); if (k && !G[k] && !seen[k]) { seen[k] = 1; sinLugar.push(String(i.cod)); } });
      if (sinLugar.length) {
        const cid = "rsp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        supabase.from("Registros_Produccion_Virgilio").insert({
          client_id: cid, legajo: String(RECP.legajo || ""), opcion: "RSP",
          descripcion: "Recepción sin planimetría",
          texto: (opState.remito || "s/remito") + "|" + sinLugar.join(","),
          ts_cliente: new Date().toISOString()
        }).then(() => {}, () => {});
      }
    }
  } catch (_e) {}

  // v7.07 — AVISO recepción que EXCEDE la OC vigente (+20%): SIN pop-up ni aprobación,
  // al operario no se lo interrumpe. Se emite el evento ROC (mismo patrón que RSP) con
  // proveedor, remito y "cod:recibidas/pedidas"; el trigger
  // trg_recepcion_excede_oc_telegram manda el aviso por Telegram. Best-effort.
  try {
    const exc = items.filter(i => ocExcede(i.cod, i.cajas));
    if (exc.length) {
      const det = exc.map(i => i.cod + ":" + i.cajas + "/" + ocRef(ocDeCod(i.cod))).join(",");
      const cid = "roc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      supabase.from("Registros_Produccion_Virgilio").insert({
        client_id: cid, legajo: String(RECP.legajo || ""), opcion: "ROC",
        descripcion: "Recepción excede la OC (+" + Math.round(OC_EXCESO_PCT * 100) + "%)",
        texto: (opState.tallNombre || "?") + "|" + (opState.remito || "s/remito") + "|" + det,
        ts_cliente: new Date().toISOString()
      }).then(() => {}, () => {});
    }
  } catch (_e) {}

  // v11.xx — Subir foto de la mercadería ANTES del insert a Control_Modo_OP.
  let fotoUrl = null, fotoUrl2 = null;
  if (opState.fotoFile) {
    try {
      const fId = "op_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
      fotoUrl = await pendUploadFoto(fId, opState.fotoFile);
    } catch (e) { console.warn("Foto upload failed (sigue sin foto):", e); }
  }
  // v12.64 — segunda foto (la factura) cuando el tipo de doc es "Remito y Factura".
  // Se sube aparte y con su propio try: si falla una, la otra igual queda guardada.
  if (opState.fotoFile2) {
    try {
      const fId2 = "op_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7) + "_fac";
      fotoUrl2 = await pendUploadFoto(fId2, opState.fotoFile2);
    } catch (e) { console.warn("Foto factura upload failed (sigue sin foto):", e); }
  }

  // v8.83: generar código de 4 dígitos ANTES de insertar, así el operario lo ve de una.
  let codigoConf = null;
  try { codigoConf = await pendGenCodigo(); } catch (_e) {}

  // Registro para el checklist de Marianela (un renglón por envío). No bloquea.
  let pendId = null;
  try {
    const detalle = items.map(i => i.cod + " → " + i.cajas).join(" · ");
    const insertObj = {
      fecha: opState.fecha,
      tipo: opState.tipo,
      nombre: opState.tallNombre,
      codigo_tall: opState.tallCod || null,
      linea: opState.linea,
      remito: opState.remito,
      detalle: detalle,
      cantidad_total: totalCajas,
      estado: 'pendiente'
    };
    if (fotoUrl) insertObj.foto_url = fotoUrl;
    if (fotoUrl2) insertObj.foto_factura_url = fotoUrl2;
    if (codigoConf) insertObj.codigo = codigoConf;
    let { data: regData, error: errReg } = await supabase.from("Control_Modo_OP").insert(insertObj).select("id").single();
    /* v12.64 — Red de seguridad por si `foto_factura_url` todavía no existe en la tabla:
       PostgREST rechaza el insert entero con PGRST204 ("column not found") y el operario
       perdería la recepción completa por una foto. Si pasa eso, se reintenta SIN esa
       columna: se pierde la foto de la factura, no la recepción. Cuando la columna esté
       creada este camino no se usa nunca. */
    if (errReg && fotoUrl2 && /foto_factura_url/.test(String(errReg.message || ""))) {
      console.warn("Falta la columna foto_factura_url en Control_Modo_OP — se guarda sin la foto de la factura. Crearla con sql/control_modo_op_foto_factura.sql");
      delete insertObj.foto_factura_url;
      ({ data: regData, error: errReg } = await supabase.from("Control_Modo_OP").insert(insertObj).select("id").single());
    }
    if (errReg) console.warn("Control_Modo_OP insert error (¿falta crear la tabla?):", errReg);
    else { pendId = regData ? regData.id : null; }
  } catch (e) { console.warn("Control_Modo_OP excepcion:", e); }

  opSetBack(false);
  opTitle.textContent = "Listo";
  opSubtitle.textContent = "";
  opBody.innerHTML = "";
  const ok = document.createElement("div");
  ok.className = "opOk";
  ok.textContent = "✓ Enviado. " + rows.length + " código(s) guardado(s) para " + displayName(opState.tallNombre) +
    " (" + opState.linea + ") · RTO/FC " + opState.remito + ".";
  opBody.appendChild(ok);
  // v8.83: mostrar código de confirmación al operario
  if (codigoConf) {
    const codWrap = document.createElement("div");
    codWrap.style.cssText = "text-align:center;margin:14px 0 6px;";
    const codLbl = document.createElement("div");
    codLbl.style.cssText = "font-size:13px;color:#64748b;margin-bottom:4px;";
    codLbl.textContent = "Código de confirmación:";
    const codBox = document.createElement("div");
    codBox.className = "codigoBox";
    codBox.textContent = codigoConf;
    codWrap.appendChild(codLbl);
    codWrap.appendChild(codBox);
    opBody.appendChild(codWrap);
  }

  opActions.innerHTML = "";
  const cerrar = document.createElement("button");
  cerrar.className = "btnCancel";
  cerrar.textContent = "Cerrar";
  cerrar.onclick = closeOp;
  if (pendId != null) {
    const anular = document.createElement("button");
    anular.className = "btnAnular";
    anular.textContent = "✕ Anular este envío";
    anular.onclick = async () => {
      const okAnu = await anularModoOP(pendId);
      if (okAnu) {
        recpAddCajas(-totalCajas);   // revertir el acumulador del día
        opBody.innerHTML = '<div class="opOk" style="color:var(--danger)">✕ Envío anulado. Cargalo de nuevo cuando quieras.</div>';
        opActions.innerHTML = "";
        const c = document.createElement("button"); c.className = "btnSend"; c.textContent = "Cargar de nuevo"; c.onclick = openOp;
        const cc = document.createElement("button"); cc.className = "btnCancel"; cc.textContent = "Cerrar"; cc.onclick = closeOp;
        opActions.appendChild(cc); opActions.appendChild(c);
      }
    };
    opActions.appendChild(anular);
  }
  const otra = document.createElement("button");
  otra.className = "btnSend";
  otra.textContent = "Cargar otra entrega";
  otra.onclick = openOp;
  opActions.appendChild(cerrar);
  opActions.appendChild(otra);
}

async function anularModoOP(pendId) {
  if (pendId == null) { alert("No se puede anular (no se guardó el registro)."); return false; }
  if (!confirm("¿ANULAR esta carga?\n\nSe borra de la base y vas a tener que cargarla de nuevo.")) return false;
  const { data, error } = await supabase.rpc("anular_modo_op", { p_id: pendId });
  if (error) {
    alert("No se pudo anular: " + error.message + "\n\n(Puede que falte crear la función 'anular_modo_op' en Supabase.)");
    return false;
  }
  if (data === 'ok') return true;
  if (data === 'vencido') { alert("Esta carga tiene más de 48 h: no se puede anular desde la app. Pedíselo al admin."); return false; }
  if (data === 'ya_anulado') { alert("Esta carga ya estaba anulada."); return false; }
  alert("No se encontró la carga."); return false;
}

/* ============== Menú (supervisor) + Pendientes ==============
   El supervisor entra por "Carga Recepción Mercadería" → menú LOCAL con dos
   opciones: Carga Manual (el mismo flujo del operario) y Pendientes (checklist
   de las recepciones cargadas, leídas de Control_Modo_OP). Todo embebido, sin
   iframe. "Listo" marca la recepción como revisada (estado='listo'). */
function renderMenu() {
  opState.step = "menu";
  opState.fromMenu = true;
  opAnularBarRender(false);   // supervisor: no hay sesión RT que anular
  opPage.classList.remove("pendWide");
  opSetBack(false);
  opTitle.textContent = "Recepción de Mercadería";
  opSubtitle.textContent = "";
  opActions.innerHTML = "";
  opBody.innerHTML = "";
  const cont = document.createElement("div");
  cont.className = "opTipoBtns";
  // Orden por importancia (pedido del dueño, v5.93): 1º Pendientes (con contador de
  // remitos por cargar), 2º Bajadas Racks, 3º Carga Manual (chico = uso puntual).
  const bp = document.createElement("button");
  bp.type = "button"; bp.className = "opTipoBtn";
  bp.textContent = "📋 Pendientes";
  bp.onclick = () => renderPendientes();
  const br = document.createElement("button");
  br.type = "button"; br.className = "opTipoBtn";
  br.textContent = "📦 Bajadas Racks → góndola";
  br.onclick = () => renderBajadasRacks();
  const bc = document.createElement("button");
  bc.type = "button"; bc.className = "opTipoBtn opBtnSm";
  bc.textContent = "✍️ Carga Manual";
  bc.onclick = () => { opResetState(); renderTipoElegir(); };   // fromMenu sigue true → "Atrás" vuelve al menú
  const bh = document.createElement("button");
  bh.type = "button"; bh.className = "opTipoBtn opBtnSm";
  bh.textContent = "📜 Histórico de recepción";
  bh.onclick = () => renderHistorico();
  const bhb = document.createElement("button");   // v10.15 — histórico de bajadas de racks
  bhb.type = "button"; bhb.className = "opTipoBtn opBtnSm";
  bhb.textContent = "📥 Histórico bajadas de racks";
  bhb.onclick = () => renderHistoricoBajadas();
  cont.appendChild(bp); cont.appendChild(br); cont.appendChild(bc); cont.appendChild(bh); cont.appendChild(bhb);
  opBody.appendChild(cont);
  // Contadores en los botones: remitos pendientes de cargar + bajadas por aprobar.
  pendBadgePend(bp);
  racksBadgePend(br);
}

/* ===== HISTÓRICO de recepción (v6.41) — registro de la mercadería recibida,
   SOLO LECTURA, filtrable por fecha y/o código. Fuentes durables:
   • "Entregas Tallerista Virgilio" (principal): Fecha texto YYYY-MM-DD + created_at,
     Cod, Cajas, Nombre_Tall, Remito. Se filtra por la col Fecha (texto) para
     evitar líos de zona horaria; se ordena Fecha↓ + created_at↓.
   • "Entregas Prov AT" (secundaria): Dia_mes "DD-MM" SIN año → se asume el año en
     curso para filtrar/ordenar (todos los datos son del año actual). Cod_Art,
     Cantidad, Descripcion, Proveedor, Remito.
   El registro lo genera y mantiene Virgilio solo: cada recepción (opEnviar) ya
   graba estas tablas; acá únicamente se consultan. ===== */
function escapeHtmlRcp(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
  });
}
function histShiftYmd(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function histMonthStartYmd() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-01";
}
let _histReqSeq = 0;
function renderHistorico() {
  opState.step = "hist";
  opPage.classList.remove("pendWide");
  opSetBack(true);
  opTitle.textContent = "Histórico de Recepción";
  opSubtitle.textContent = "Mercadería recibida — filtrá por fecha y/o código";
  opActions.innerHTML = "";
  opBody.innerHTML =
    '<div class="histBar">' +
      '<div class="histField"><label for="histDesde">Desde</label><input type="date" id="histDesde" class="histDate"></div>' +
      '<div class="histField"><label for="histHasta">Hasta</label><input type="date" id="histHasta" class="histDate"></div>' +
      '<div class="histField"><label for="histCod">Código o quién entregó</label><input type="text" id="histCod" class="histCod" placeholder="ej. 590 o Rafael" inputmode="text" autocomplete="off"></div>' +
      '<button class="histBtn plus" id="histMas" title="Más filtros"><span class="plusIco">＋</span><span class="plusTxt" id="histMasTxt">filtros</span></button>' +
      '<div class="histBtns"><button class="histBtn pri" id="histBuscar">Buscar</button><button class="histBtn" id="histLimpiar">Limpiar</button></div>' +
    '</div>' +
    '<div class="histBar histMore" id="histMore">' +
      '<div class="histField"><label for="histQuien">Quién entregó</label><input type="text" id="histQuien" class="histCod" placeholder="ej. Pintos" autocomplete="off"></div>' +
      '<div class="histField"><label for="histRemito">Remito</label><input type="text" id="histRemito" class="histCod" placeholder="ej. 37573" autocomplete="off"></div>' +
      '<div class="histField"><label for="histCajMin">Cajas mínimas</label><input type="number" id="histCajMin" class="histCod" placeholder="ej. 50" min="0" inputmode="numeric"></div>' +
    '</div>' +
    '<div class="histPresets">' +
      '<button class="histChip" data-preset="hoy">Hoy</button>' +
      '<button class="histChip" data-preset="7">7 días</button>' +
      '<button class="histChip" data-preset="mes">Este mes</button>' +
      '<button class="histChip" data-preset="todo">Todo</button>' +
    '</div>' +
    '<div id="histResults"><div class="histLoading">Cargando…</div></div>';
  document.getElementById("histBuscar").onclick = () => histBuscar();
  document.getElementById("histLimpiar").onclick = () => {
    ["histDesde", "histHasta", "histCod", "histQuien", "histRemito", "histCajMin"].forEach(function (id) {
      const el = document.getElementById(id); if (el) el.value = "";
    });
    histBuscar();
  };
  // v6.55: "+" despliega/oculta los filtros extra; muestra cuántos están activos.
  document.getElementById("histMas").onclick = () => {
    const more = document.getElementById("histMore"), btn = document.getElementById("histMas");
    if (!more || !btn) return;
    more.classList.toggle("show");
    btn.classList.toggle("on", more.classList.contains("show"));
  };
  ["histCod", "histQuien", "histRemito", "histCajMin"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.onkeydown = (e) => { if (e.key === "Enter") histBuscar(); };
  });
  document.getElementById("histDesde").onchange = () => histBuscar();
  document.getElementById("histHasta").onchange = () => histBuscar();
  opBody.querySelectorAll(".histChip").forEach(function (ch) {
    ch.onclick = function () {
      const p = ch.getAttribute("data-preset");
      const desde = document.getElementById("histDesde"), hasta = document.getElementById("histHasta");
      if (p === "hoy") { desde.value = opTodayStr(); hasta.value = opTodayStr(); }
      else if (p === "7") { desde.value = histShiftYmd(-6); hasta.value = opTodayStr(); }
      else if (p === "mes") { desde.value = histMonthStartYmd(); hasta.value = opTodayStr(); }
      else if (p === "todo") { desde.value = ""; hasta.value = ""; }
      histBuscar();
    };
  });
  histBuscar();   // primera carga: recepciones recientes
}
function histBuscar() {
  const v = function (id) { return ((document.getElementById(id) || {}).value || "").trim(); };
  // v6.55: los filtros extra del "+" se COMBINAN (AND) con el buscador principal.
  const f = { desde: v("histDesde"), hasta: v("histHasta"), cod: v("histCod"),
              quien: v("histQuien"), remito: v("histRemito"), cajasMin: parseInt(v("histCajMin"), 10) || 0 };
  const txt = document.getElementById("histMasTxt");
  if (txt) {
    const n = (f.quien ? 1 : 0) + (f.remito ? 1 : 0) + (f.cajasMin > 0 ? 1 : 0);
    txt.textContent = n ? ("filtros (" + n + ")") : "filtros";
  }
  histLoad(f);
}
async function histLoad(f) {
  const box = document.getElementById("histResults");
  if (box) box.innerHTML = '<div class="histLoading">Cargando…</div>';
  const myseq = ++_histReqSeq;
  await sessionReady;
  if (myseq !== _histReqSeq) return;   // ya hay una búsqueda más nueva en curso
  const CAP = 500, HARD = 1000;
  // v6.54: un solo buscador — matchea CÓDIGO o QUIÉN ENTREGÓ (tallerista/proveedor).
  // Se sanea el término (sin comas/paréntesis) porque va dentro de un filtro .or() de PostgREST.
  const codN = f.cod ? f.cod.toUpperCase().replace(/[,()]/g, " ").trim() : "";
  try {
    // v10.26: una sola query a vista_historial_entregas (antes 2 queries separadas).
    // La vista ya convierte DD-MM → YYYY-MM-DD para prov_at.
    let q = supabase.from("vista_historial_entregas")
      .select("fuente,fecha,created_at,cod_art,descripcion,cajas,quien,remito,llegada,carga,demora_hs");
    if (f.desde) q = q.gte("fecha", f.desde);
    if (f.hasta) q = q.lte("fecha", f.hasta);
    if (codN) q = q.or("cod_art.ilike.%" + codN + "%,quien.ilike.%" + codN + "%");
    if (f.quien) q = q.ilike("quien", "%" + f.quien + "%");
    if (f.remito) q = q.ilike("remito", "%" + f.remito + "%");
    if (f.cajasMin > 0) q = q.gte("cajas", f.cajasMin);
    q = q.order("fecha", { ascending: false }).order("created_at", { ascending: false, nullsFirst: false }).limit(HARD);

    const res = await q;
    if (myseq !== _histReqSeq) return;
    if (res.error) throw res.error;

    const ddmm = function (ymd) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ""); return m ? (m[3] + "/" + m[2]) : (ymd || "—"); };
    const rows = ((res.data) || []).map(function (r) {
      return {
        ymd: r.fecha || "", ms: r.created_at ? Date.parse(r.created_at) : 0,
        fechaTxt: ddmm(r.fecha), cod: r.cod_art || "—", desc: r.descripcion || "",
        cajas: Number(r.cajas) || 0, quien: r.fuente === "tallerista" ? displayName(r.quien || "—") : (r.quien || "—"),
        remito: r.remito || "", origen: r.fuente === "tallerista" ? "tall" : "prov",
        demoraHs: (r.demora_hs != null) ? Number(r.demora_hs) : null,
        llegada: r.llegada || null, carga: r.carga || null
      };
    });
    rows.sort(function (a, b) { if (a.ymd !== b.ymd) return a.ymd < b.ymd ? 1 : -1; return b.ms - a.ms; });
    histRender(rows, CAP, rows.length >= HARD);
  } catch (e) {
    if (myseq !== _histReqSeq) return;
    console.warn("histLoad error:", e);
    if (box) box.innerHTML = '<div class="histEmpty">No se pudo cargar el histórico. Probá de nuevo.</div>';
  }
}
/* Demora de carga del remito (hora carga operadora − hora llegada), en texto compacto.
   Viene de vista_historial_entregas.demora_hs. Solo existe para recepciones cargadas por
   el flujo de Pendientes (Control_Modo_OP); las viejas o sin match dan "—". */
function histFmtDemora(hs) {
  if (hs == null || isNaN(hs)) return "—";
  if (hs < 0) hs = 0;
  if (hs < 1) return Math.round(hs * 60) + "m";
  if (hs < 24) { const r = Math.round(hs * 10) / 10; return String(r).replace(".", ",") + "h"; }
  const d = Math.round(hs / 24 * 10) / 10; return String(d).replace(".", ",") + "d";
}
function histHoraTip(r) {
  if (!r.llegada || !r.carga) return "";
  try {
    const opt = { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", timeZone: "America/Argentina/Buenos_Aires" };
    return "Llegó " + new Date(r.llegada).toLocaleString("es-AR", opt) + " · Cargó " + new Date(r.carga).toLocaleString("es-AR", opt);
  } catch (_e) { return ""; }
}
function histRender(rows, CAP, capped) {
  const box = document.getElementById("histResults");
  if (!box) return;
  const n = rows.length;
  if (!n) { box.innerHTML = '<div class="histEmpty">No hay recepciones para ese filtro.</div>'; return; }
  const total = rows.reduce((s, r) => s + r.cajas, 0);
  const shown = rows.slice(0, CAP);
  let html = '<div class="histSummary">' + n + ' recepci' + (n === 1 ? 'ón' : 'ones') + ' · <b>' + total + ' cajas</b></div>';
  if (capped) html += '<div class="histNote">⚠ Hay más de 1000 filas; se muestran las más recientes. Acotá por fecha para ver el resto.</div>';
  else if (n > CAP) html += '<div class="histNote">Mostrando las primeras ' + CAP + ' de ' + n + '. Acotá el filtro para ver menos.</div>';
  html += '<div class="histTblWrap"><table class="histTbl"><thead><tr>' +
    '<th>Fecha</th><th>Código</th><th style="text-align:right">Cajas</th><th>Entregó</th><th style="text-align:right" title="Cuánto tardó en cargarse el remito: hora de carga de la operadora − hora de llegada del remito.">Demora</th><th>Remito</th>' +
    '</tr></thead><tbody>';
  shown.forEach(function (r) {
    // v6.54: sin badge "Prov" ni la descripción del artículo — solo el nombre (pedido del dueño).
    const who = escapeHtmlRcp(r.quien);
    const demTxt = histFmtDemora(r.demoraHs);
    const demTip = histHoraTip(r);
    html += '<tr>' +
      '<td class="histFe">' + escapeHtmlRcp(r.fechaTxt) + '</td>' +
      '<td class="histCodCell">' + escapeHtmlRcp(r.cod) + '</td>' +
      '<td class="histCaj">' + r.cajas + '</td>' +
      '<td class="histWho">' + who + '</td>' +
      '<td class="histDem"' + (demTip ? ' title="' + escapeHtmlRcp(demTip) + '"' : '') + '>' + escapeHtmlRcp(demTxt) + '</td>' +
      '<td class="histRto">' + escapeHtmlRcp(r.remito || "—") + '</td>' +
    '</tr>';
  });
  html += '</tbody></table></div>';
  box.innerHTML = html;
}
/* ===== HISTÓRICO de BAJADAS DE RACKS (v10.15) — todas las bajadas de rack a góndola
   (tabla Racks_Bajadas), SOLO LECTURA, filtrable por fecha y por código / descripción /
   sector / quién la hizo. Reusa el estilo del histórico de recepción (clases hist*). ===== */
let _hbReqSeq = 0;
function renderHistoricoBajadas() {
  opState.step = "histbaj";
  opPage.classList.remove("pendWide");
  opSetBack(true);
  opTitle.textContent = "Histórico de Bajadas de Racks";
  opSubtitle.textContent = "Bajadas de rack a góndola — filtrá por fecha y/o código, sector o quién";
  opActions.innerHTML = "";
  opBody.innerHTML =
    '<div class="histBar">' +
      '<div class="histField"><label for="hbDesde">Desde</label><input type="date" id="hbDesde" class="histDate"></div>' +
      '<div class="histField"><label for="hbHasta">Hasta</label><input type="date" id="hbHasta" class="histDate"></div>' +
      '<div class="histField"><label for="hbCod">Código, sector o quién</label><input type="text" id="hbCod" class="histCod" placeholder="ej. 590, A12 o Rafael" autocomplete="off"></div>' +
      '<div class="histBtns"><button class="histBtn pri" id="hbBuscar">Buscar</button><button class="histBtn" id="hbLimpiar">Limpiar</button></div>' +
    '</div>' +
    '<div class="histPresets">' +
      '<button class="histChip" data-preset="hoy">Hoy</button>' +
      '<button class="histChip" data-preset="7">7 días</button>' +
      '<button class="histChip" data-preset="mes">Este mes</button>' +
      '<button class="histChip" data-preset="todo">Todo</button>' +
    '</div>' +
    '<div id="hbResults"><div class="histLoading">Cargando…</div></div>';
  document.getElementById("hbBuscar").onclick = () => hbBuscar();
  document.getElementById("hbLimpiar").onclick = () => {
    ["hbDesde", "hbHasta", "hbCod"].forEach(function (id) { const el = document.getElementById(id); if (el) el.value = ""; });
    hbBuscar();
  };
  document.getElementById("hbCod").onkeydown = (e) => { if (e.key === "Enter") hbBuscar(); };
  document.getElementById("hbDesde").onchange = () => hbBuscar();
  document.getElementById("hbHasta").onchange = () => hbBuscar();
  opBody.querySelectorAll(".histChip").forEach(function (ch) {
    ch.onclick = function () {
      const p = ch.getAttribute("data-preset");
      const desde = document.getElementById("hbDesde"), hasta = document.getElementById("hbHasta");
      if (p === "hoy") { desde.value = opTodayStr(); hasta.value = opTodayStr(); }
      else if (p === "7") { desde.value = histShiftYmd(-6); hasta.value = opTodayStr(); }
      else if (p === "mes") { desde.value = histMonthStartYmd(); hasta.value = opTodayStr(); }
      else if (p === "todo") { desde.value = ""; hasta.value = ""; }
      hbBuscar();
    };
  });
  hbBuscar();
}
function hbBuscar() {
  const v = function (id) { return ((document.getElementById(id) || {}).value || "").trim(); };
  hbLoad({ desde: v("hbDesde"), hasta: v("hbHasta"), cod: v("hbCod") });
}
async function hbLoad(f) {
  const box = document.getElementById("hbResults");
  if (box) box.innerHTML = '<div class="histLoading">Cargando…</div>';
  const myseq = ++_hbReqSeq;
  await sessionReady;
  if (myseq !== _hbReqSeq) return;
  const HARD = 2000;
  const term = f.cod ? f.cod.toUpperCase().replace(/[,()]/g, " ").trim() : "";
  try {
    let q = supabase.from("Racks_Bajadas").select("id,ts,aprobada_at,cod_art,descripcion,cajas,sector,estado,creada_por");
    if (f.desde) q = q.gte("ts", f.desde);
    if (f.hasta) q = q.lte("ts", f.hasta + "T23:59:59.999-03:00");
    if (term) q = q.or("cod_art.ilike.%" + term + "%,descripcion.ilike.%" + term + "%,sector.ilike.%" + term + "%,creada_por.ilike.%" + term + "%");
    q = q.order("ts", { ascending: false }).limit(HARD);
    const r = await q;
    if (myseq !== _hbReqSeq) return;
    if (r && r.error) throw r.error;
    hbRender((r && r.data) || [], HARD);
  } catch (e) {
    if (myseq !== _hbReqSeq) return;
    console.warn("hbLoad error:", e);
    if (box) box.innerHTML = '<div class="histEmpty">No se pudo cargar el histórico de bajadas. Probá de nuevo.</div>';
  }
}
function hbRender(rows, HARD) {
  const box = document.getElementById("hbResults");
  if (!box) return;
  const n = rows.length;
  if (!n) { box.innerHTML = '<div class="histEmpty">No hay bajadas de racks para ese filtro.</div>'; return; }
  const total = rows.reduce(function (s, r) { return s + (Number(r.cajas) || 0); }, 0);
  let html = '<div class="histSummary">' + n + ' bajada' + (n === 1 ? '' : 's') + ' · <b>' + total + ' cajas</b></div>';
  if (n >= HARD) html += '<div class="histNote">⚠ Hay muchas filas; se muestran las más recientes. Acotá por fecha para ver el resto.</div>';
  html += '<div class="histTblWrap"><table class="histTbl"><thead><tr>' +
    '<th>Fecha</th><th>Código</th><th>Sector</th><th style="text-align:right">Cajas</th><th>Quién</th><th>Estado</th>' +
    '</tr></thead><tbody>';
  const fmt = function (ts) { if (!ts) return "—"; const d = new Date(ts); if (isNaN(d.getTime())) return "—"; const p = function (x) { return String(x).padStart(2, "0"); }; return p(d.getDate()) + "/" + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };
  const estColor = { aprobada: "#15803d", propuesta: "#b45309", rechazada: "#b91c1c" };
  rows.forEach(function (r) {
    const est = String(r.estado || "—");
    const col = estColor[est] || "#64748b";
    html += '<tr>' +
      '<td class="histFe">' + escapeHtmlRcp(fmt(r.ts)) + '</td>' +
      '<td class="histCodCell">' + escapeHtmlRcp(r.cod_art || "—") + (r.descripcion ? '<br><small style="color:#94a3b8">' + escapeHtmlRcp(r.descripcion) + '</small>' : '') + '</td>' +
      '<td>' + escapeHtmlRcp(r.sector || "—") + '</td>' +
      '<td class="histCaj">' + (Number(r.cajas) || 0) + '</td>' +
      '<td class="histWho">' + escapeHtmlRcp(displayName(r.creada_por || "—")) + '</td>' +
      '<td style="font-weight:800;color:' + col + '">' + escapeHtmlRcp(est) + '</td>' +
    '</tr>';
  });
  html += '</tbody></table></div>';
  box.innerHTML = html;
}
/* v5.93 — Contador de remitos pendientes de cargar en el botón "Pendientes"
   (mismas filas que renderPendientes: Control_Modo_OP con estado='pendiente'). */
async function pendBadgePend(btn) {
  try {
    await sessionReady;
    const r = await supabase.from("Control_Modo_OP").select("id", { count: "exact", head: true }).eq("estado", "pendiente");
    const n = r.count || 0;
    if (n > 0 && btn) btn.textContent = "📋 Pendientes (" + n + ")";
  } catch (_e) {}
}
/* ===== RACKS → góndola (v4.08): Marianela aprueba acá lo que los operarios
   marcaron para bajar. Al aprobar se hace el movimiento entre depósitos
   (racks − / terminado +) en Movimientos_Stock y la bajada queda 'aprobada'
   (si era la última de la orden, la orden pasa a 'bajado' y se apaga la alarma). */
async function racksBadgePend(btn) {
  try {
    await sessionReady;
    const r = await supabase.from("Racks_Bajadas").select("id", { count: "exact", head: true }).eq("estado", "propuesta");
    const n = r.count || 0;
    if (n > 0 && btn) btn.textContent = "📦 Bajadas Racks → góndola (" + n + ")";
  } catch (_e) {}
}
async function renderBajadasRacks() {
  opState.step = "racks";
  opPage.classList.add("pendWide");
  opSetBack(true);
  opTitle.textContent = "Bajadas Racks → góndola";
  opSubtitle.textContent = "Lo que los operarios marcaron para bajar. Revisá y aprobá: recién ahí pasa de racks a góndola.";
  opActions.innerHTML = "";
  opBody.innerHTML = '<div class="opEmpty">Cargando…</div>';
  await sessionReady;
  let res, fres;
  try {
    res = await supabase.from("Racks_Bajadas").select("id,orden_id,cod_art,descripcion,cajas,estado,creada_por,ts,sector").eq("estado", "propuesta").order("ts", { ascending: true }).limit(500);
    fres = await supabase.from("Articulos Virgilio X Tallerista").select("Cod_Art,Cajas_x_Master,Uni_x_Caja").limit(20000);
  } catch (e) { res = { error: e }; }
  if (opState.step !== "racks") return;
  if (res.error) { opBody.innerHTML = '<div class="opEmpty" style="color:var(--danger)">No se pudo leer Racks_Bajadas.<br><small>' + (res.error.message || "") + '</small></div>'; return; }
  const rows = res.data || [];
  _racksFactors = {};
  ((fres && fres.data) || []).forEach(function (x) { const k = String(x.Cod_Art || "").toUpperCase(); if (k && !_racksFactors[k]) _racksFactors[k] = { cajasXMaster: Number(x.Cajas_x_Master) || 0, uniXCaja: Number(x.Uni_x_Caja) || 0 }; });
  if (!rows.length) {
    opBody.innerHTML = '<div class="opOk">✓ No hay bajadas pendientes de aprobar.</div>';
    // Mostrar histórico de aprobadas recientes (últimas 2h) para confirmar que se procesaron
    try {
      const twoHoursAgo = new Date(Date.now() - 2*60*60*1000).toISOString();
      const approved = await supabase.from("Racks_Bajadas").select("id,cod_art,cajas,aprobada_at,creada_por").eq("estado", "aprobada").gt("aprobada_at", twoHoursAgo).order("aprobada_at", { ascending: false }).limit(20);
      if (approved.data && approved.data.length) {
        const hist = document.createElement("div");
        hist.style.cssText = "margin-top:20px;padding-top:15px;border-top:1px solid #e2e8f0;";
        const title = document.createElement("div");
        title.style.cssText = "font-size:13px;color:#64748b;font-weight:700;margin-bottom:8px;";
        title.textContent = "Aprobadas en las últimas 2h:";
        hist.appendChild(title);
        const list = document.createElement("div");
        list.style.cssText = "font-size:12px;color:#475569;line-height:1.6;";
        approved.data.forEach(function (a) {
          const row = document.createElement("div");
          row.style.cssText = "padding:4px 0;";
          const at = a.aprobada_at ? new Date(a.aprobada_at).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
          row.textContent = a.cod_art + " · " + a.cajas + " cajas · " + at;
          list.appendChild(row);
        });
        hist.appendChild(list);
        opBody.appendChild(hist);
      }
    } catch (_e) {}
    return;
  }
  opBody.innerHTML = "";
  const list = document.createElement("div"); list.className = "pendCards";
  rows.forEach(function (b) { list.appendChild(racksBajaCard(b)); });
  opBody.appendChild(list);
}
let _racksFactors = {};
function racksFmtUnits(cajas, cod) {
  const f = _racksFactors[String(cod).toUpperCase()] || {}, M = f.cajasXMaster > 0 ? f.cajasXMaster : 0, U = f.uniXCaja > 0 ? f.uniXCaja : 0, p = [];
  if (M) p.push((Math.round((cajas / M) * 100) / 100) + " master");
  if (U) p.push((cajas * U) + " u");
  return p.length ? p.join(" · ") : "";
}
/* Día y hora (Buenos Aires, 24h) de cuándo el operario marcó la bajada. */
function racksBajaFecha(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch (_e) { return ""; }
}
function racksBajaCard(b) {
  const card = document.createElement("div"); card.className = "pendCard"; card.setAttribute("data-id", String(b.id));
  const head = document.createElement("div"); head.className = "pcHead";
  const name = document.createElement("span"); name.className = "pcName"; name.textContent = b.cod_art || "—";
  const tag = document.createElement("span"); tag.className = "pcTag"; tag.textContent = b.creada_por ? ("Leg " + b.creada_por) : "operario";
  head.appendChild(name); head.appendChild(tag);
  card.appendChild(head);
  const ent = document.createElement("div"); ent.className = "pcEntrega";
  const u = racksFmtUnits(Number(b.cajas), b.cod_art);
  ent.textContent = (b.descripcion || "") + "   ·   " + b.cajas + " cajas" + (u ? "  (" + u + ")" : "");
  card.appendChild(ent);
  // Sector del rack + día/hora en que el operario la marcó
  const metaParts = [];
  if (b.sector) metaParts.push("📍 Sector " + b.sector);
  const fch = racksBajaFecha(b.ts);
  if (fch) metaParts.push("🕒 " + fch);
  if (metaParts.length) {
    const meta = document.createElement("div");
    meta.style.cssText = "font-size:12.5px;color:#64748b;font-weight:600;margin-top:5px;";
    meta.textContent = metaParts.join("   ·   ");
    card.appendChild(meta);
  }
  const foot = document.createElement("div"); foot.className = "pcFoot";
  const ok = document.createElement("button"); ok.type = "button"; ok.className = "enviarBtn"; ok.textContent = "✓ Aprobar";
  ok.onclick = function () { racksAprobarBaja(b, foot); };
  foot.appendChild(ok);
  card.appendChild(foot);
  return card;
}
async function racksAprobarBaja(b, foot) {
  const btn = foot.querySelector("button");
  if (btn) { btn.disabled = true; btn.textContent = "Aprobando…"; }
  try {
    await sessionReady;
    const ref = "orden " + (b.orden_id || "");
    const mov = await supabase.from("Movimientos_Stock").insert([
      { cod_art: b.cod_art, descripcion: b.descripcion || null, deposito: "racks", delta: -Number(b.cajas), tipo: "baja_racks", ref: ref, legajo: "0" },
      { cod_art: b.cod_art, descripcion: b.descripcion || null, deposito: "terminado", delta: Number(b.cajas), tipo: "baja_racks", ref: ref, legajo: "0" }
    ]);
    if (mov.error) throw mov.error;
    const upd = await supabase.from("Racks_Bajadas").update({ estado: "aprobada", aprobada_at: new Date().toISOString() }).eq("id", b.id);
    if (upd.error) throw upd.error;
    // ¿Era la última propuesta de la orden? Entonces cerramos la orden (apaga la alarma).
    if (b.orden_id) {
      const rest = await supabase.from("Racks_Bajadas").select("id", { count: "exact", head: true }).eq("orden_id", b.orden_id).eq("estado", "propuesta");
      if ((rest.count || 0) === 0) {
        await supabase.from("Racks_Ordenes").update({ estado: "bajado", cerrada_at: new Date().toISOString() }).eq("id", b.orden_id);
      }
    }
    const card = foot.closest(".pendCard");
    if (card) { card.classList.add("sentRow"); foot.innerHTML = '<span class="pcLbl" style="color:var(--ok);font-weight:900">✓ Aprobado — pasó a góndola</span>'; }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "✓ Aprobar"; }
    alert("No se pudo aprobar: " + (e.message || e));
  }
}
let _pendRows = {};   // id -> estado vivo (espejo de lo persistido en Supabase). NADA en localStorage.
async function renderPendientes() {
  opState.step = "pend";
  opPage.classList.add("pendWide");   // PC: ancho completo → grilla de tarjetas (menos scroll)
  opSetBack(true);
  opTitle.textContent = "Pendientes";
  opSubtitle.textContent = "Recepciones cargadas. Tildá, adjuntá la foto y tocá Enviar.";
  opActions.innerHTML = "";
  opBody.innerHTML = '<div class="opEmpty">Cargando…</div>';
  await sessionReady;
  /* v12.64 — `foto_factura_url` (la foto de la factura, cuando el doc es "Remito y
     Factura") se pide en el select. Si la columna todavía no está creada, PostgREST
     rechaza la consulta ENTERA y la pantalla de Pendientes quedaría vacía por una foto
     — mucho peor que no tenerla. Por eso se reintenta sin ella. Con la columna creada
     este segundo camino no se usa nunca. */
  const _COLS_PEND = "id,fecha,tipo,nombre,linea,remito,detalle,cantidad_total,created_at,isis,control_partes,foto_url,foto_vista,codigo";
  let res;
  async function _leerPend(cols) {
    try {
      return await supabase.from("Control_Modo_OP")
        .select(cols)
        .eq("estado", "pendiente")
        .order("created_at", { ascending: true })
        .limit(300);
    } catch (e) { return { error: e }; }
  }
  res = await _leerPend(_COLS_PEND + ",foto_factura_url");
  if (res && res.error && /foto_factura_url/.test(String(res.error.message || ""))) {
    console.warn("Falta la columna foto_factura_url en Control_Modo_OP — Pendientes sigue sin la foto de la factura. Crearla con sql/control_modo_op_foto_factura.sql");
    res = await _leerPend(_COLS_PEND);
  }
  if (opState.step !== "pend") return;
  if (res.error) {
    opBody.innerHTML = '<div class="opEmpty" style="color:var(--danger)">No se pudo leer Pendientes (¿permisos de Control_Modo_OP?).<br><small>' + (res.error.message || "") + '</small></div>';
    return;
  }
  const rows = res.data || [];
  if (!rows.length) { opBody.innerHTML = '<div class="opOk">✓ No hay recepciones pendientes.</div>'; return; }
  _pendRows = {};
  opBody.innerHTML = "";
  const list = document.createElement("div"); list.className = "pendCards";
  rows.forEach(function (r) { list.appendChild(pendCard(r)); });
  opBody.appendChild(list);
  if (_pendTimer) clearInterval(_pendTimer);
  _pendTimer = setInterval(pendTickElapsed, 30000);   // refresca "Demora" en vivo
  // Deep-link desde Planify: resaltar y scrollear al remito específico
  if (_deepLinkRemito) {
    const hl = _deepLinkRemito;
    _deepLinkRemito = null;
    setTimeout(function () {
      const card = Array.from(opBody.querySelectorAll(".pendCard")).find(function (c) {
        const rto = c.querySelector(".pcRto");
        return rto && rto.textContent.toUpperCase().includes(hl.toUpperCase());
      });
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.style.outline = "3px solid #2563eb";
        setTimeout(function () { card.style.outline = ""; }, 3000);
      }
    }, 200);
  }
}
function pendFmtFecha(fecha, tsMs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha || ""));
  if (m) return m[3] + "-" + m[2];
  if (tsMs) { const d = new Date(tsMs); return String(d.getDate()).padStart(2, "0") + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  return "";
}
function pendFmtHora(tsMs) {
  if (!tsMs) return "";
  try { return new Date(tsMs).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Argentina/Buenos_Aires" }); }
  catch (_e) { const d = new Date(tsMs); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
}
function pendFmtDemora(tsMs) {
  let hh = Math.round((Date.now() - tsMs) / 1800000);   // medias horas
  if (hh < 0) hh = 0;
  const h = hh / 2;
  return (Number.isInteger(h) ? String(h) : (Math.floor(h) + ",5")) + "hs";
}
function pendTickElapsed() {
  if (opState.step !== "pend") { if (_pendTimer) { clearInterval(_pendTimer); _pendTimer = null; } return; }
  document.querySelectorAll("#rcpRoot .pendDemora").forEach(function (el) {
    const ts = parseInt(el.getAttribute("data-ts"), 10);
    if (ts) el.textContent = "⏱ " + pendFmtDemora(ts);
  });
}
function pendCard(r) {
  const id = r.id;
  _pendRows[id] = { isis: !!r.isis, partes: r.control_partes || null, foto_url: r.foto_url || null, foto_factura_url: r.foto_factura_url || null, foto_vista: !!r.foto_vista, codigo: r.codigo || null, sent: false, row: r };
  const tsMs = r.created_at ? new Date(r.created_at).getTime() : 0;
  const card = document.createElement("div"); card.className = "pendCard"; card.setAttribute("data-id", String(id));
  const head = document.createElement("div"); head.className = "pcHead";
  const name = document.createElement("span"); name.className = "pcName"; name.textContent = r.nombre || "—";
  const tag = document.createElement("span"); tag.className = "pcTag"; tag.textContent = (r.tipo === "prov_at") ? "Prov. AT" : "Tallerista";
  const rto = document.createElement("span"); rto.className = "pcRto"; rto.textContent = r.remito ? ("RTO/FC " + r.remito) : "";
  head.appendChild(name); head.appendChild(tag); head.appendChild(rto);
  card.appendChild(head);
  const meta = document.createElement("div"); meta.className = "pcMeta";
  const mp = [pendFmtFecha(r.fecha, tsMs)]; if (tsMs) mp.push(pendFmtHora(tsMs)); if (r.linea) mp.push(r.linea);
  meta.textContent = mp.filter(Boolean).join(" · ");
  if (tsMs) {
    const dem = document.createElement("span"); dem.className = "pcDemora pendDemora"; dem.setAttribute("data-ts", String(tsMs));
    dem.textContent = "⏱ " + pendFmtDemora(tsMs);
    meta.appendChild(document.createTextNode(" · ")); meta.appendChild(dem);
  }
  card.appendChild(meta);
  const ent = document.createElement("div"); ent.className = "pcEntrega";
  ent.textContent = (r.detalle || "") + (r.cantidad_total != null ? "   ·   " + r.cantidad_total + " cajas" : "");
  card.appendChild(ent);
  const acts = document.createElement("div"); acts.className = "pcActs";
  acts.appendChild(pendCheckRow(id, "isis", "Carga ISIS"));
  acts.appendChild(pendPartesRow(id));
  /* v12.03 — se sacó el tilde "Faltantes x Día" (pedido del usuario): ese programa
     ya no se hace, así que no hay nada que tildar y no puede seguir bloqueando el
     botón Enviar. La columna Control_Modo_OP.faltantes queda en la base con lo ya
     cargado — no se toca ni se borra, solo dejó de usarse desde acá. */
  acts.appendChild(pendFotoRow(id));
  card.appendChild(acts);
  const foot = document.createElement("div"); foot.className = "pcFoot";
  /* v10.02 — el código lo genera opEnviar() AL CREAR la fila (v8.83), para que el operario
     lo vea y lo escriba en el remito físico. Por eso tener `codigo` NO significa "ya
     procesada": esta lista trae SOLO estado='pendiente'. Antes el `if (r.codigo)` tapaba
     el botón Enviar en toda fila nueva y nada podía salir de Pendientes. Ahora se muestra
     el código (para cotejar contra el remito) Y el botón al lado. */
  if (r.codigo) {
    const lab = document.createElement("span"); lab.className = "pcLbl"; lab.textContent = "Código:";
    const c = document.createElement("div"); c.className = "codigoBox"; c.textContent = r.codigo;
    foot.appendChild(lab); foot.appendChild(c);
  }
  const b = document.createElement("button"); b.type = "button"; b.className = "enviarBtn"; b.textContent = "Enviar"; b.disabled = !pendRowComplete(id);
  b.onclick = function () { pendEnviar(id, foot); };
  foot.appendChild(b);
  card.appendChild(foot);
  return card;
}
/* Cada cambio se PERSISTE en Supabase al toque (UPDATE de la fila; no duplica, nada
   en localStorage). Al recargar, la tarjeta vuelve con lo ya guardado. */
async function pendPersist(id, patch) {
  await sessionReady;
  const r = await supabase.from("Control_Modo_OP").update(patch).eq("id", id);
  if (r.error) throw r.error;
}
function pendCheckRow(id, field, label) {
  const row = document.createElement("div"); row.className = "pcRow";
  const b = document.createElement("button"); b.type = "button"; b.className = "tickBtn" + (_pendRows[id][field] ? " on" : "");
  b.onclick = async function () {
    if (_pendRows[id].sent) return;
    const nv = !_pendRows[id][field]; b.disabled = true;
    try { await pendPersist(id, { [field]: nv }); _pendRows[id][field] = nv; b.classList.toggle("on", nv); }
    catch (e) { alert("No se pudo guardar: " + (e.message || e)); }
    b.disabled = false; pendRefreshEnviar(id);
  };
  const lbl = document.createElement("span"); lbl.className = "pcLbl"; lbl.textContent = label;
  row.appendChild(b); row.appendChild(lbl); return row;
}
function pendPartesRow(id) {
  const row = document.createElement("div"); row.className = "pcRow";
  const tick = document.createElement("button"); tick.type = "button"; tick.className = "tickBtn";
  const lbl = document.createElement("span"); lbl.className = "pcLbl"; lbl.textContent = "Control Partes Talleristas";
  const no = document.createElement("button"); no.type = "button"; no.className = "noBtn"; no.textContent = "No corresponde";
  function sync() { const v = _pendRows[id].partes; tick.classList.toggle("on", v === "corresponde"); no.classList.toggle("on", v === "no"); }
  async function setVal(v) {
    if (_pendRows[id].sent) return;
    const nv = (_pendRows[id].partes === v) ? null : v; tick.disabled = no.disabled = true;
    try { await pendPersist(id, { control_partes: nv }); _pendRows[id].partes = nv; sync(); }
    catch (e) { alert("No se pudo guardar: " + (e.message || e)); }
    tick.disabled = no.disabled = false; pendRefreshEnviar(id);
  }
  tick.onclick = function () { setVal("corresponde"); };
  no.onclick = function () { setVal("no"); };
  sync(); row.appendChild(tick); row.appendChild(lbl); row.appendChild(no); return row;
}
function pendFotoRow(id) {
  const row = document.createElement("div"); row.className = "pcRow pcFotoRow";
  const lbl = document.createElement("span"); lbl.className = "pcLbl"; lbl.textContent = "Foto Mercadería";
  const fotoUrl = _pendRows[id].foto_url;
  // v12.64 — cuando la recepción entró como "Remito y Factura" hay DOS fotos y las dos
  // se muestran: la del remito y la de la factura, una al lado de la otra.
  const fotoUrl2 = _pendRows[id].foto_factura_url;
  const _fotos = [];
  if (fotoUrl)  _fotos.push({ url: fotoUrl,  tit: fotoUrl2 ? "📄 Remito" : "Foto mercadería" });
  if (fotoUrl2) _fotos.push({ url: fotoUrl2, tit: "🧾 Factura" });
  if (!fotoUrl) {
    // Legacy: item sin foto del operario — auto-check, no bloquea
    const noF = document.createElement("span"); noF.className = "fotoViewBtn noFoto"; noF.textContent = "Sin foto";
    _pendRows[id].foto_vista = true;
    row.appendChild(lbl); row.appendChild(noF); return row;
  }
  const btn = document.createElement("button"); btn.type = "button";
  btn.className = "fotoViewBtn" + (_pendRows[id].foto_vista ? " viewed" : "");
  const _nF = _fotos.length;
  btn.textContent = _pendRows[id].foto_vista
    ? (_nF > 1 ? "✓ Fotos vistas (" + _nF + ")" : "✓ Foto vista")
    : (_nF > 1 ? "👁 Ver fotos (" + _nF + ")" : "👁 Ver foto");
  btn.onclick = function () {
    if (_pendRows[id].sent) return;
    const ov = document.createElement("div"); ov.className = "fotoOverlay";
    const box = document.createElement("div"); box.className = "fotoOverlayBox";
    const imgWrap = document.createElement("div"); imgWrap.className = "fotoOverlayImg" + (_fotos.length > 1 ? " dos" : "");
    _fotos.forEach(function (f) {
      const cel = document.createElement("div"); cel.className = "fotoOverlayCel";
      if (_fotos.length > 1) {
        const t = document.createElement("div"); t.className = "fotoOverlayCelTit"; t.textContent = f.tit;
        cel.appendChild(t);
      }
      const im = document.createElement("img"); im.src = f.url; im.alt = f.tit;
      cel.appendChild(im);
      imgWrap.appendChild(cel);
    });
    const cl = document.createElement("button"); cl.className = "fotoOverlayClose"; cl.textContent = "✕";
    cl.onclick = async function () {
      ov.remove();
      document.removeEventListener("keydown", esc);
      if (!_pendRows[id].foto_vista) {
        _pendRows[id].foto_vista = true;
        btn.classList.add("viewed"); btn.textContent = "✓ Foto vista";
        try { await pendPersist(id, { foto_vista: true }); } catch(_e){}
        pendRefreshEnviar(id);
      }
    };
    function esc(e) { if (e.key === "Escape") cl.click(); }
    document.addEventListener("keydown", esc);
    ov.onclick = function (e) { if (e.target === ov || e.target === box) cl.click(); };
    box.appendChild(imgWrap);
    box.appendChild(pendFotoInfoPanel(_pendRows[id].row));
    ov.appendChild(box); ov.appendChild(cl);
    document.getElementById("rcpRoot").appendChild(ov);
  };
  row.appendChild(lbl); row.appendChild(btn); return row;
}
/* v12.07 — Panel que acompaña a la foto en el visor: quién entregó, qué remito y,
   sobre todo, CÓDIGO → CAJAS tal cual lo cargó el operario. El detalle ya viene en
   la fila (`Control_Modo_OP.detalle`, formato "COD → N · COD → N"); acá solo se
   parsea para mostrarlo en columnas. Si algún día el formato cambia, se muestra el
   texto crudo en vez de romper. */
function pendFotoParseDetalle(det) {
  const txt = String(det || "").trim();
  if (!txt) return [];
  const items = [];
  txt.split(/\s*·\s*/).forEach(function (part) {
    const p = part.trim(); if (!p) return;
    const m = /^(.*?)\s*(?:→|->)\s*(.+)$/.exec(p);
    if (m) items.push({ cod: m[1].trim(), cajas: m[2].trim() });
    else items.push({ cod: p, cajas: "" });
  });
  return items;
}
function pendFotoInfoPanel(r) {
  const box = document.createElement("div"); box.className = "fotoOverlayInfo";
  r = r || {};
  const tsMs = r.created_at ? new Date(r.created_at).getTime() : 0;
  const nm = document.createElement("div"); nm.className = "fovName";
  nm.textContent = (typeof displayName === "function" ? displayName(r.nombre || "") : (r.nombre || "")) || "—";
  box.appendChild(nm);
  const mp = [(r.tipo === "prov_at") ? "Prov. AT" : "Tallerista", pendFmtFecha(r.fecha, tsMs)];
  if (tsMs) mp.push(pendFmtHora(tsMs));
  if (r.linea) mp.push(r.linea);
  const mt = document.createElement("div"); mt.className = "fovMeta"; mt.textContent = mp.filter(Boolean).join(" · ");
  box.appendChild(mt);
  if (r.remito) { const rt = document.createElement("div"); rt.className = "fovRto"; rt.textContent = "RTO/FC " + r.remito; box.appendChild(rt); }
  const tit = document.createElement("div"); tit.className = "fovTit"; tit.textContent = "Cargado por el operario";
  box.appendChild(tit);
  const items = pendFotoParseDetalle(r.detalle);
  if (!items.length) {
    const raw = document.createElement("div"); raw.className = "fovRaw"; raw.textContent = r.detalle || "—";
    box.appendChild(raw);
  } else {
    items.forEach(function (it) {
      const rowEl = document.createElement("div"); rowEl.className = "fovItem";
      const c = document.createElement("span"); c.className = "fovCod"; c.textContent = it.cod;
      const q = document.createElement("span"); q.className = "fovCaj"; q.textContent = it.cajas ? (it.cajas + " cj") : "";
      rowEl.appendChild(c); rowEl.appendChild(q); box.appendChild(rowEl);
    });
  }
  if (r.cantidad_total != null) {
    const tot = document.createElement("div"); tot.className = "fovTotal";
    const l = document.createElement("span"); l.textContent = "Total";
    const v = document.createElement("span"); v.textContent = r.cantidad_total + " cajas";
    tot.appendChild(l); tot.appendChild(v); box.appendChild(tot);
  }
  return box;
}
async function pendUploadFoto(id, file) {
  await sessionReady;
  const ext = (file.name && file.name.indexOf(".") >= 0) ? file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "jpg";
  const path = id + "_" + Date.now() + "." + (ext || "jpg");
  const opts = { upsert: true, contentType: file.type || "image/jpeg" };
  let up = await supabase.storage.from("remitos").upload(path, file, opts);
  if (up && up.error) {
    // v6.72 — Fallback anti "row-level security policy": el login anónimo puede vencer
    // o caerse (pasó el 31/07: 0 usuarios anónimos nuevos) y el cliente manda una
    // sesión rota. La RLS del bucket `remitos` (y de Control_Modo_OP) permite rol
    // `anon`, así que renovamos la sesión anónima y, si tampoco, la limpiamos y subimos
    // con la publishable key (rol anon). Así la foto entra igual sin depender del login.
    try { await supabase.auth.signInAnonymously(); } catch (_e) {}
    up = await supabase.storage.from("remitos").upload(path, file, opts);
    if (up && up.error) {
      try { await supabase.auth.signOut(); } catch (_e) {}
      up = await supabase.storage.from("remitos").upload(path, file, opts);
    }
  }
  if (up.error) throw up.error;
  const pub = supabase.storage.from("remitos").getPublicUrl(path);
  return (pub && pub.data) ? pub.data.publicUrl : null;
}
function pendRowComplete(id) { const s = _pendRows[id]; return !!(s && s.isis && s.partes && s.foto_vista); }
function pendRefreshEnviar(id) {
  const card = document.querySelector('#rcpRoot .pendCard[data-id="' + id + '"]');
  if (!card) return; const b = card.querySelector(".enviarBtn");
  if (b && !_pendRows[id].sent) b.disabled = !pendRowComplete(id);
}
async function pendEnviar(id, foot) {
  if (!pendRowComplete(id) || _pendRows[id].sent) return;
  const b = foot.querySelector(".enviarBtn"); if (b) { b.disabled = true; b.textContent = "Enviando…"; }
  try {
    /* v10.02 — REUSAR el código que la fila ya trae (el que el operario escribió en el remito
       físico al cargarla). Generar uno nuevo acá dejaba dos códigos distintos para la misma
       recepción. Solo se genera si la fila es vieja (anterior a v8.83) y no tiene. */
    const codigo = _pendRows[id].codigo || await pendGenCodigo();
    await pendPersist(id, { estado: "procesado", procesado_at: new Date().toISOString(), codigo: codigo });
    _pendRows[id].sent = true; _pendRows[id].codigo = codigo;
    foot.innerHTML = "";
    const lab = document.createElement("span"); lab.className = "pcLbl"; lab.textContent = "Código:";
    const c = document.createElement("div"); c.className = "codigoBox"; c.textContent = codigo;
    foot.appendChild(lab); foot.appendChild(c);
    const card = foot.parentNode; if (card) card.classList.add("sentRow");
  } catch (e) {
    if (b) { b.disabled = false; b.textContent = "Enviar"; }
    alert("No se pudo enviar: " + (e.message || e));
  }
}
async function pendGenCodigo() {
  await sessionReady;
  const usados = new Set();
  try {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const r = await supabase.from("Control_Modo_OP").select("codigo").gte("created_at", since.toISOString()).not("codigo", "is", null);
    if (r.data) r.data.forEach(function (x) { if (x.codigo) usados.add(String(x.codigo)); });
  } catch (_e) {}
  let c, tries = 0;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); tries++; } while (usados.has(c) && tries < 200);
  return c;
}

/* ============== API pública para Producción ============== */
window.openRecepcionOp = function (legajo, dayKey) {
  RECP.legajo = String(legajo || "").trim() || null;
  RECP.dayKey = dayKey || opTodayStr();
  openOp();
};
/* Menú de Recepción (supervisor "Carga Recepción Mercadería"): Carga / Pendientes, LOCALES. */
window.openRecepcionMenu = function () {
  RECP.legajo = null;
  RECP.dayKey = opTodayStr();
  opPage.classList.add("open");
  renderMenu();
};

/* Deep-link desde Planify: abre el módulo directo en Pendientes y resalta el remito. */
window.recepcionAbrirPendientes = async function (remito) {
  _deepLinkRemito = remito || null;
  RECP.legajo = null;
  RECP.dayKey = opTodayStr();
  opPage.classList.add("open");
  await renderPendientes();
};
