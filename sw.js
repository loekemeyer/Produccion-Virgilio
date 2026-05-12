const CACHE_VERSION = "v1.0";
const CACHE_NAME = `virgilio-cache-${CACHE_VERSION}`;
const STATIC_ASSETS = [
  "./",
  "./index.html"
];

const GOOGLE_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwtBRC-bEeVkFNa8MQnJwJr_L4DalBVoS6N8H9C1Z0vh2CLI29Sep7ZZIIVKz6eOGzj/exec";

const IDB_NAME = "virgilio-prod";
const IDB_VERSION = 1;
const IDB_STORE = "queue";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll() {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const r = tx.objectStore(IDB_STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  }));
}

function idbDelete(id) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const r = tx.objectStore(IDB_STORE).delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}

async function postToSheet(item) {
  const res = await fetch(GOOGLE_SCRIPT_URL, {
    method: "POST",
    body: JSON.stringify({
      id: item.id,
      legajo: item.legajo,
      opcion: item.opcion,
      descripcion: item.descripcion,
      texto: item.texto,
      ts_event: item.ts_event
    }),
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function processQueueInBackground() {
  let items;
  try { items = await idbGetAll(); } catch { return; }
  if (!items || !items.length) return;

  let anyFailed = false;
  for (const item of items) {
    try {
      await postToSheet(item);
      try { await idbDelete(item.id); } catch { /* ignore */ }
    } catch {
      anyFailed = true;
    }
  }
  // Si quedó alguno fallido, lanzar para que el browser reintente el sync mas tarde.
  if (anyFailed) throw new Error("Algunos items quedaron pendientes");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
      // Avisar a las tabs abiertas que hay versión nueva.
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        try { await client.navigate(client.url); } catch { /* ignore */ }
        try { client.postMessage({ type: "SW_UPDATED", version: CACHE_VERSION }); } catch {}
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === "navigate" ||
                 (req.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    // Network-first para HTML, fallback a cache si no hay red.
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./")))
    );
  } else {
    // Cache-first para el resto (no hay assets externos en este repo, pero queda preparado).
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        });
      })
    );
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "flush-queue") {
    event.waitUntil(processQueueInBackground());
  }
});
