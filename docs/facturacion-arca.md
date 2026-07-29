# Facturación electrónica propia (ARCA / ex AFIP) — diseño y guía de puesta en marcha

> Estado: **EN PREPARACIÓN** — nada emite todavía. Este documento es la guía viva del
> camino "la app emite desde un punto de venta nuevo, e Isis levanta de ARCA".
> Ver también la nota de investigación en `GUIA-PROYECTO.md` (Isis vs 2º emisor).
>
> **Avance v6.41**: quedó armado el **esqueleto** (sin emitir): (1) la tabla
> `Comprobantes_ARCA` **ya existe** en Supabase con RLS (anon solo lectura) — DDL versionado
> en `sql/comprobantes_arca.sql`; (2) el **esqueleto de la Edge Function `arca-wsfe`** está en
> el repo (`supabase/functions/arca-wsfe/index.ts`), responde `status` y **rechaza emitir**
> hasta cargar los secrets y prender `ARCA_EMITIR=on`. Falta: certificado + PDV (§4), la
> decisión del importe (§5) y el OK del contador.

## 1. Objetivo

Que la **app** pueda **facturar sola** (emitir factura electrónica con CAE contra ARCA),
sin doble carga y **sin depender del Isis on-premise**. La contabilidad se consolida en
Isis levantando esas facturas **desde ARCA** (pendiente de confirmar que Isis puede
importar de ARCA automáticamente — ver ticket a Isis).

Flujo elegido: **App → ARCA (Web Service) → Isis trae de ARCA por CAE**.

## 2. Por qué hace falta un backend (Edge Function)

La app es **estática** (GitHub Pages) + Supabase. **No puede** hablar con ARCA directo:
- ARCA usa **SOAP** y exige **autenticación con certificado digital** (WSAA).
- El certificado (clave privada) **no puede vivir en el navegador** (lo vería cualquiera).

Solución: un **backend mínimo = Supabase Edge Function** (Deno) que:
- Guarda el **certificado + clave privada** como **secrets** de Supabase.
- Hace el login WSAA (firma CMS) y llama a WSFE (pedir CAE).
- La app le pega a esa función; nunca ve el certificado.

Ventaja sobre el plan "API de Isis": **no** hay que exponer el Isis local a internet.
Todo queda en la nube.

## 3. Arquitectura

```
Navegador (app)                 Supabase                         ARCA (ex AFIP)
--------------                  --------                         --------------
[Facturar NP] ── HTTPS ──▶ Edge Function `arca-wsfe`
                            1) WSAA: firma LoginTicketRequest ── SOAP ──▶ WSAA  → token+sign (TA, ~12 h, cacheado)
                            2) WSFE: FECAESolicitar ─────────── SOAP ──▶ WSFE  → CAE + vto
                            3) guarda en tabla `Comprobantes_ARCA`
                        ◀── JSON { cae, nro, pdv, vto } ──
[muestra CAE / imprime]
```

- **WSAA** (auth): `https://wsaahomo.afip.gov.ar/ws/services/LoginCms` (homologación) /
  `https://wsaa.afip.gov.ar/ws/services/LoginCms` (producción). Se firma un XML
  (LoginTicketRequest) en formato **CMS/PKCS#7** con el certificado → devuelve
  **token + sign** válidos ~12 h (se cachean, no se pide en cada factura).
- **WSFEv1** (factura): `https://wswhomo.afip.gov.ar/wsfev1/service.asmx` (homologación) /
  `https://servicios1.afip.gov.ar/wsfev1/service.asmx` (producción). Métodos clave:
  - `FEDummy` — healthcheck sin auth (ya probado, ver §7).
  - `FECompUltimoAutorizado` — último número autorizado de ese PDV+tipo (para el correlativo).
  - `FECAESolicitar` — pide el **CAE** de un comprobante.
  - `FECompConsultar` — consulta un comprobante ya emitido (trae su CAE) → sirve para
    reconciliar / recuperar (lo que hizo el dueño una vez).

## 4. Qué hay que sacar de ARCA (shopping list — lo hace el dueño)

1. **Certificado digital** para Web Service, atado al CUIT de la empresa
   (uno de **homologación** para probar + uno de **producción**). Se genera en el portal
   de ARCA ("Administración de Certificados Digitales" / "WSASS").
2. **Punto de venta NUEVO**, distinto al que usa Isis, dado de alta como
   **"Factura Electrónica - Web Services (RECE/WS)"** (no "Comprobantes en línea").
3. **Asociar el servicio `wsfe`** (Factura Electrónica) a ese certificado en ARCA
   (delegación de servicio), para que el certificado tenga permiso de facturar.
4. Pasar a Claude: el **CUIT**, el **número de PDV nuevo**, y los **dos certificados**
   (.crt + .key) — se cargan como **secrets** en Supabase, NO se commitean al repo.

## 5. Decisiones que necesito del dueño (antes de codear la emisión)

- **⚠ ¿De dónde sale el IMPORTE de cada factura?** — La app hoy tiene **cajas y m³, NO
  precios**. Para emitir una factura válida hace falta **neto + IVA**. Opciones:
  (a) la operadora lo **tipea** por NP al facturar; (b) una **lista de precios** en la app;
  (c) traerlo de Isis. **Sin una fuente del importe, no se puede emitir.** (Es el bloqueo
  #1.)
- **Tipo de comprobante y condición IVA**: ¿Factura **A** (clientes responsables
  inscriptos, la mayoría son S.R.L.), **B** (consumidor final/monotributo), o ambas según
  el cliente? Define la lógica y las alícuotas. **Confirmar con el contador.**
- **Alícuota de IVA** por artículo (21% / 10,5% / etc.) — ¿única o varía?
- **Empezamos en homologación** (pruebas, sin validez fiscal) y recién cuando esté 100%
  pasamos a producción.

## 6. Piezas a construir (cuando lleguen certificado + decisiones)

- **Tabla `Comprobantes_ARCA`** (log de emitidos). ✅ **YA CREADA** (migración
  `comprobantes_arca_skeleton`, DDL versionado en `sql/comprobantes_arca.sql`). RLS: anon
  solo lectura, escritura vía service_role (verificado que anon no puede insertar). DDL:
  ```sql
  create table if not exists public."Comprobantes_ARCA" (
    id           bigint generated always as identity primary key,
    np           text,
    tanda        text,
    cuit_cliente text,
    tipo_cbte    int,            -- 1=FA A, 6=FA B, etc. (tabla ARCA)
    pto_vta      int,
    nro_cbte     bigint,
    importe_neto numeric,
    importe_iva  numeric,
    importe_total numeric,
    cae          text,
    cae_vto      date,
    estado       text default 'pendiente',  -- pendiente|autorizado|rechazado
    entorno      text default 'homo',        -- homo|prod
    raw_resp     jsonb,
    creado       timestamptz not null default now()
  );
  -- RLS: anon SOLO lectura; la escritura la hace la Edge Function (service_role).
  ```
- **Edge Function `arca-wsfe`** (reemplaza al healthcheck): WSAA (firma CMS con
  `node-forge` vía `npm:`) + cache del TA + `FECAESolicitar` + `FECompUltimoAutorizado` +
  guarda en `Comprobantes_ARCA`. Certificado como **secret** (`ARCA_CERT`, `ARCA_KEY`,
  `ARCA_CUIT`, `ARCA_PTO_VTA`, `ARCA_ENV`).
  ✅ **Esqueleto en el repo**: `supabase/functions/arca-wsfe/index.ts`. Responde
  `{action:"status"}` con qué secrets faltan y **rechaza `{action:"emitir"}`** (501) hasta
  cargar los secrets y prender `ARCA_EMITIR=on`. La lógica WSAA/WSFE está marcada con `TODO`
  (a propósito el esqueleto **no puede emitir**). Falta **deployarlo** (hoy sigue vivo solo
  el `arca-wsfe-healthcheck`).
- **Módulo frontend** dentro de **Facturación** (un botón "Facturar electrónicamente" /
  ticket aparte, NO el tilde actual): elige cliente + importe (o lo trae), llama a la
  función, muestra el CAE y permite imprimir. Se hace **al final**, después de que
  homologación funcione.

## 7. Estado actual (lo avanzado sin certificado)

- ✅ **Healthcheck deployado**: Edge Function **`arca-wsfe-healthcheck`** (verify_jwt=off,
  temporal) que llama `FEDummy` (sin auth ni certificado). Prueba que **Supabase llega a
  ARCA**. Se invoca:
  `https://hrxfctzncixxqmpfhskv.supabase.co/functions/v1/arca-wsfe-healthcheck?env=homo`
  (o `env=prod`). Devuelve `{ appserver, dbserver, authserver }` = OK si ARCA responde.
  ⚠ No se pudo verificar desde el sandbox de Claude (su proxy bloquea salidas) — **probar
  abriendo esa URL desde el navegador del celu/monitor**. Se reemplaza por `arca-wsfe`
  real más adelante.
- ⏳ **Bloqueado por**: (1) el certificado + PDV de ARCA (§4); (2) la decisión del importe
  (§5); (3) confirmación fiscal del contador y la respuesta de Isis (¿importa de ARCA?).

## 8. Resumen del camino

App emite factura desde un **PDV nuevo** por Web Service (Edge Function con el
certificado) → ARCA da el **CAE** → Isis **levanta la factura de ARCA** (a confirmar).
Para arrancar a codear la emisión hacen falta: **certificado + PDV** de ARCA, definir **de
dónde sale el importe**, y el **OK del contador**. Mientras tanto, la conectividad
Supabase→ARCA quedó lista para probar (§7).
