/* APP_VERSION (index.html), SW_VERSION (sw.js) y version.json deben tener la MISMA
   base. Evita DOS regresiones distintas:

   1) PWA clásica — si al bumpear se olvidan de sw.js, el service worker sigue
      sirviendo la app vieja y "no se ve el cambio" en producción.
   2) Aviso de nueva versión — checkForUpdate() compara version.json contra
      APP_VERSION y sólo muestra el banner "🔄 Actualizar" si el archivo tiene una
      versión MÁS NUEVA. Un version.json que quedó atrás (pasó: se congeló en
      v12.48 hasta la v12.58) no rompe nada visible, pero apaga el aviso: los
      celulares con un index.html viejo en la caché HTTP no se enteran nunca de
      que hay una versión nueva, que es justo el problema que el banner resuelve.

   Sale con código 1 si están desincronizados. */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const verJsonRaw = fs.readFileSync(path.join(root, "version.json"), "utf8");

const mApp = html.match(/APP_VERSION\s*=\s*["']([^"']+)["']/);
const mSw = sw.match(/SW_VERSION\s*=\s*["']([^"']+)["']/);

if (!mApp) { console.log("version-sync: no encontré APP_VERSION en index.html"); process.exit(1); }
if (!mSw)  { console.log("version-sync: no encontré SW_VERSION en sw.js"); process.exit(1); }

const app = mApp[1].trim();
const swv = mSw[1].trim();
const swBase = swv.replace(/-.*$/, ""); // saca el sufijo "-vir" (u otro) del SW_VERSION

if (app !== swBase) {
  console.log("version-sync: DESYNC — APP_VERSION=" + app + " vs SW_VERSION=" + swv + " (base " + swBase + ")");
  console.log("  Al bumpear la versión hay que tocar LOS DOS (index.html y sw.js); si no, el SW cachea la app vieja.");
  process.exit(1);
}
let verJson;
try { verJson = JSON.parse(verJsonRaw); }
catch (e) { console.log("version-sync: version.json no es JSON válido — " + e.message); process.exit(1); }

const vj = String((verJson && verJson.version) || "").trim();
if (!vj) { console.log("version-sync: version.json no tiene campo \"version\""); process.exit(1); }

if (vj !== app) {
  console.log("version-sync: DESYNC — version.json=" + vj + " vs APP_VERSION=" + app);
  console.log("  checkForUpdate() sólo avisa si version.json es MÁS NUEVO que la app cargada:");
  console.log("  con el archivo atrasado el banner \"🔄 Actualizar\" NUNCA aparece y los");
  console.log("  celulares con el index.html viejo cacheado se quedan en esa versión.");
  process.exit(1);
}

console.log("version-sync: OK — APP_VERSION=" + app + " == SW_VERSION base (" + swv + ") == version.json (" + vj + ")");
process.exit(0);
