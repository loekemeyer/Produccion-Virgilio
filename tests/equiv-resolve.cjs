/* Regresión idea 2260 — equivResolve()/equivLookup() (código pedido → código real) sin test
   pese a usarse en 6+ puntos críticos (armado con código de barras, stockBajaPicking, resolución
   de faltantes/entregas, facturación). Un fallo silencioso de normalización (espacios, mayúsculas,
   ceros a la izquierda) o de "no encontrado" hace que se pickee/facture el código EQUIVOCADO sin
   ningún error visible.

   Chequea:
   - Equivalencia conocida (29→437E) ida.
   - Normalización: ceros a la izquierda ("029"), espacios (" 29 ") resuelven igual que "29".
   - Código sin equivalencia: equivResolve devuelve el MISMO código (passthrough), sin romper.
   - equivLookup de un código sin match devuelve null (no undefined, no excepción).
   - equivLookup de un código conocido devuelve el objeto completo ({real, nota}).
   - equivResolve(null/undefined/"") no explota — devuelve string vacío.
   Sale 1 si falla. */
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

    // ---- Equivalencia conocida (mapa por defecto: 29→437E, 30→438E) ----
    out.conocida_29 = equivResolve("29") === "437E";
    out.conocida_30 = equivResolve("30") === "438E";

    // ---- Normalización: ceros a la izquierda ----
    out.norm_cerosIzq = equivResolve("029") === "437E";
    out.norm_cerosIzq2 = equivResolve("0029") === "437E";

    // ---- Normalización: espacios ----
    out.norm_espacios = equivResolve(" 29 ") === "437E";

    // ---- Sin equivalencia: passthrough (mismo código, sin romper) ----
    out.sinEquiv_passthrough = equivResolve("999") === "999";
    out.sinEquiv_passthroughLetra = equivResolve("437E") === "437E";

    // ---- equivLookup: null cuando no hay match (no undefined) ----
    const lk999 = equivLookup("999");
    out.lookup_nullSinMatch = lk999 === null;

    // ---- equivLookup: objeto completo cuando SÍ hay match ----
    const lk29 = equivLookup("29");
    out.lookup_objetoCompleto = !!lk29 && lk29.real === "437E" && typeof lk29.nota === "string" && lk29.nota.length > 0;
    // el código normalizado con ceros/espacios encuentra el MISMO objeto
    const lk029 = equivLookup(" 029 ");
    out.lookup_normalizaIgual = !!lk029 && lk029.real === "437E";

    // ---- Entradas vacías/nulas no explotan ----
    out.vacio_null = equivResolve(null) === "";
    out.vacio_undefined = equivResolve(undefined) === "";
    out.vacio_string = equivResolve("") === "";
    out.lookup_vacio_null = equivLookup(null) === null;

    return out;
  });
  const pass = r.conocida_29 && r.conocida_30 && r.norm_cerosIzq && r.norm_cerosIzq2 &&
    r.norm_espacios && r.sinEquiv_passthrough && r.sinEquiv_passthroughLetra &&
    r.lookup_nullSinMatch && r.lookup_objetoCompleto && r.lookup_normalizaIgual &&
    r.vacio_null && r.vacio_undefined && r.vacio_string && r.lookup_vacio_null &&
    errs.length === 0;
  console.log("equiv-resolve:", JSON.stringify(r), "· pageerrors:", errs.length ? errs.join("|") : "none", "·", pass ? "✓ OK" : "✗ FAIL");
  await b.close(); process.exit(pass ? 0 : 1);
})();
