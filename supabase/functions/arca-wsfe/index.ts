// arca-wsfe — Edge Function (Deno) para facturación electrónica propia contra ARCA (ex AFIP).
//
// ⚠ ESQUELETO v6.41 — TODAVÍA NO EMITE. Reemplaza (más adelante) al healthcheck
//   `arca-wsfe-healthcheck`. Ver diseño completo en docs/facturacion-arca.md.
//
// Flujo objetivo: App → esta función → ARCA (Web Services) → CAE → tabla Comprobantes_ARCA.
//   1) WSAA: firmar LoginTicketRequest en CMS/PKCS#7 con el certificado → token+sign (~12 h, cacheado).
//   2) WSFE: FECompUltimoAutorizado (correlativo) + FECAESolicitar (pedir CAE).
//   3) Guardar el comprobante en Comprobantes_ARCA (service_role).
//
// BLOQUEADO por (§4/§5 del doc): (1) certificado + PDV nuevo de ARCA; (2) de dónde sale el
//   IMPORTE (la app tiene cajas/m³, no precios); (3) OK del contador. Hasta que se carguen los
//   secrets (ARCA_CERT, ARCA_KEY, ARCA_CUIT, ARCA_PTO_VTA, ARCA_ENV) esta función responde
//   "no configurado" y NO intenta emitir. El interruptor duro es ARCA_EMITIR !== "on".

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const WS_URLS = {
  homo: {
    wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  },
  prod: {
    wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Connection": "keep-alive" },
  });
}

// Config desde secrets de Supabase. Nunca viajan al navegador.
function readConfig() {
  const env = (Deno.env.get("ARCA_ENV") || "homo").toLowerCase() === "prod" ? "prod" : "homo";
  return {
    env,
    cert: Deno.env.get("ARCA_CERT") || "",
    key: Deno.env.get("ARCA_KEY") || "",
    cuit: Deno.env.get("ARCA_CUIT") || "",
    ptoVta: Deno.env.get("ARCA_PTO_VTA") || "",
    emitir: (Deno.env.get("ARCA_EMITIR") || "off").toLowerCase() === "on",
    urls: WS_URLS[env as "homo" | "prod"],
  };
}

function missingSecrets(c: ReturnType<typeof readConfig>): string[] {
  const miss: string[] = [];
  if (!c.cert) miss.push("ARCA_CERT");
  if (!c.key) miss.push("ARCA_KEY");
  if (!c.cuit) miss.push("ARCA_CUIT");
  if (!c.ptoVta) miss.push("ARCA_PTO_VTA");
  return miss;
}

// ───────────────────────────────────────────────────────────────────────────
// TODO (cuando lleguen certificado + PDV + decisión del importe):
//   wsaaLogin(c): firmar LoginTicketRequest (CMS) con node-forge (npm:node-forge),
//                 POST SOAP a c.urls.wsaa → parsear token+sign, cachear ~12 h.
//   feCompUltimoAutorizado(c, ta, tipoCbte): correlativo del PDV+tipo.
//   feCAESolicitar(c, ta, comprobante): pedir el CAE de un comprobante.
//   guardarComprobante(row): insert en Comprobantes_ARCA con service_role.
// Nada de esto se implementa todavía a propósito: el esqueleto no debe poder emitir.
// ───────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const c = readConfig();
  const miss = missingSecrets(c);

  // Ping de estado — no emite. Sirve para chequear que la función está deployada y
  // ver qué falta configurar. (GET, o POST con { action: "status" }.)
  let action = "status";
  if (req.method === "POST") {
    try {
      const b = await req.json();
      action = typeof b?.action === "string" ? b.action : "status";
    } catch (_e) { /* body vacío → status */ }
  }

  if (action === "status") {
    return json({
      ok: true,
      service: "arca-wsfe",
      estado: "esqueleto",
      configured: miss.length === 0,
      emitir_habilitado: c.emitir,
      entorno: c.env,
      faltan_secrets: miss,
      nota: "Esqueleto v6.41 — no emite. Cargá los secrets y ARCA_EMITIR=on cuando esté todo (ver docs/facturacion-arca.md).",
    });
  }

  // Cualquier intento de emisión está deshabilitado hasta cargar config + prender el switch.
  if (action === "emitir") {
    if (miss.length > 0) {
      return json({ ok: false, error: "faltan_secrets", faltan: miss }, 501);
    }
    if (!c.emitir) {
      return json({ ok: false, error: "emision_deshabilitada", nota: "Prendé ARCA_EMITIR=on para habilitar (todavía sin implementar la emisión)." }, 501);
    }
    // TODO: wsaaLogin → feCompUltimoAutorizado → feCAESolicitar → guardarComprobante.
    return json({ ok: false, error: "no_implementado", nota: "La emisión real se implementa cuando estén certificado + PDV + fuente del importe." }, 501);
  }

  return json({ ok: false, error: "accion_desconocida", action }, 400);
});
