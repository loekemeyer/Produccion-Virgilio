# CLAUDE.md — Producción Virgilio

## REGLA: auditar en Supabase cada problema del repo y su solucion

**Vale para TODOS los repos** (igual que la regla de Planify: copiar este bloque al `CLAUDE.md`
de cualquier repo nuevo). Objetivo: que cada error que tuvo un repositorio quede con su causa,
su correccion y el/los commits donde se arreglo, para no volver a pisar el mismo pozo.

**Donde:** proyecto Supabase `hrxfctzncixxqmpfhskv`, schema `github_repo_problemas`.
Se escribe con el MCP de Supabase (`execute_sql`), no con la anon key.

### Que se audita y que NO

Regla corta: **si ya estaba pusheado y andaba mal, se audita.** Si es trabajo nuevo, no.

| Se registra | NO se registra |
|---|---|
| Bug en codigo ya pusheado que llego al usuario | Feature nueva o pedido de cambio |
| Dato corrupto o mal migrado en la base | Refactor pedido por el usuario |
| Config o credencial rota o filtrada | Bug que introducis y arreglas antes de pushear |
| Performance degradada, query que no escala | Duda o consulta que se responde en el momento |
| Tabla derivada desincronizada de su madre | Ajuste de estilo o texto |

### Cuando

1. **Al detectar el problema** (antes de tocar nada): `registrar_problema` devuelve el id.
2. **Al pushear el fix**: `cerrar_problema` con el sha del commit.
3. **Si el fix necesita mas commits**: `agregar_commit` por cada uno. Un problema puede tener N
   commits; NO abrir un problema nuevo por el segundo pase del mismo fix.
4. Una sesion de Claude puede abarcar **varios** problemas: `sesion_id` no es unico.

### SQL

```sql
-- 1) al detectar
select github_repo_problemas.registrar_problema(
  p_repo          => 'owner/repo',            -- en minuscula
  p_titulo        => '<sintoma en <=120 chars>',
  p_descripcion   => '<que se rompio y como se manifesto>',
  p_categoria     => 'bug',                   -- bug|datos|seguridad|performance|config|ux|deuda_tecnica|documentacion
  p_severidad     => 'alto',                  -- critico|alto|medio|bajo
  p_modulo        => 'Carpeta/Modulo',
  p_archivos      => array['ruta/relativa.html'],
  p_sesion_id     => '<id de la sesion de Claude>',
  p_detectado_por => '<usuario> (claude-remote)',
  p_detectado_en  => now()                    -- fecha REAL si es carga historica
);

-- 2) al pushear el fix
select github_repo_problemas.cerrar_problema(
  p_id            => <id>,
  p_correccion    => '<que se cambio>',
  p_commit_sha    => '<sha corto>',
  p_branch        => '<branch>',
  p_commit_url    => 'https://github.com/owner/repo/commit/<sha>',
  p_causa_raiz    => '<por que paso, no que paso>',
  p_corregido_por => '<usuario> (claude-remote)',
  p_mensaje       => '<subject del commit>'
);

-- 3) commits extra del mismo problema
select github_repo_problemas.agregar_commit(<id>, '<sha>', '<branch>', '<url>', '<mensaje>', '<autor>');

-- lectura
select * from github_repo_problemas.v_problemas order by detectado_en desc;
```

**Avisar en el chat el titulo del problema** al registrarlo y al cerrarlo, no el numero de id
(mismo criterio que Planify).

**Si el problema se detecta pero NO se arregla, queda en `estado='abierto'`.** Ese es el punto:
que quede anotado. Estados: `abierto` | `en_curso` | `corregido` | `no_corregible` | `descartado`.
Para pasar a `corregido` la base exige `correccion` y `corregido_en` cargados (constraint).

**La auditoria no se borra.** El rol `anon` tiene SELECT/INSERT/UPDATE pero NO DELETE ni
TRUNCATE en las tres tablas. Si una fila esta mal, se corrige o se pasa a `descartado`.

## 🪨 Modo Caveman (SIEMPRE activo)

**Cada conversación abre con caveman activo por defecto.** Responder en modo **caveman**:
frases cortas, directas, mínimas palabras, sin relleno. Solo aplica al **chat** (no al
código, comentarios ni mensajes de commit).

- **`desactiva caveman`** = responder solo el **próximo mensaje** normal/completo, y después **volver solo** a caveman.
- **`caveman desactivacion total`** = apagar caveman por completo (queda desactivado hasta que se reactive).

---

App web (PWA, sin framework) para registrar producción de depósito (picking,
armado, carga de camión, recepción). La usan operarios desde el celular y
supervisores desde un monitor. Se sirve por GitHub Pages desde `main`.

## ⚠ Antes de responder preguntas sobre datos o funcionamiento

**Leé `GUIA-PROYECTO.md`** (en la raíz del repo). Es la guía viva del proyecto:
modelo de datos, códigos de acción, flujo, de dónde salen los m³, cómo se calculan
las horas, recetas de SQL y reglas de inconsistencia. Respondé **basado en eso, no
inventes**.

**Mantené `GUIA-PROYECTO.md` actualizada** cuando cambie el código o los datos
(nuevos códigos `opcion`, tablas, flujo, versión, etc.).

## ⚠ PROTOCOLO OBLIGATORIO: Backend vs Front-end — preguntar ANTES de implementar

**Cuando alguien pide cambiar lógica** (normalización de códigos, cálculos,
filtros, agregaciones, reglas de negocio, etc.), **SIEMPRE preguntar si quiere
que se aplique en el backend (vista/función/RPC de Supabase) o en el front-end
antes de implementar.** No asumir. Muchas veces se piden cambios que deberían
ir al backend y terminan implementados en el front.

Aplica a **todos los chats** (nuevos y vigentes) sobre este repo.

## ⚠ PROTOCOLO OBLIGATORIO: Lógica de negocio SIEMPRE en el backend

**Conversiones, normalizaciones, validaciones y reglas de negocio que afectan
datos persistidos van en Supabase (triggers, funciones, vistas), NO en el
front-end.** El front puede duplicar la lógica como optimización UX (mostrar
el dato convertido antes de que el servidor responda), pero la fuente de
verdad es el backend. Si algo se implementa en el front, **siempre debe
existir el equivalente en el backend** (trigger/función) que garantice la
integridad aunque el front no lo haga.

Ejemplo concreto: la conversión MC↔Uni de insumos (v11.77) vive en el trigger
`normalizar_unidad_insumo` de `Movimientos_Stock`. El front también convierte
como optimización, pero el trigger es el que manda.

## ⚠ PROTOCOLO OBLIGATORIO: Backups antes de tocar datos en Supabase

**SIEMPRE que edites/alters/truncates/deletes en tablas de Supabase:**

1. **Haz un backup ANTES** de cualquier cambio:
   ```sql
   -- Exportar completa la tabla como SQL restore-ready
   SELECT * FROM table_name;
   -- Copiar resultado → archivo SQL con CREATE + INSERTs
   ```
2. **Guarda el backup** como `backup_table_YYYYMMDD_hhmmss.sql` en un lugar seguro (comentario/notas).
3. **Ejecuta tu cambio** (ALTER, TRUNCATE, DELETE, INSERT).
4. **Si algo falla o se rompe:** Restore inmediato ejecutando el SQL guardado.

**Ejemplo:**
```sql
-- BACKUP (ejecutar primero, guardar resultado)
SELECT 'INSERT INTO Capacidad_Sector (empresa, sector, cod, cajas_max) VALUES (' ||
  quote_literal(empresa) || ',' || quote_literal(sector) || ',' || 
  quote_literal(cod) || ',' || quote_literal(cajas_max) || ');'
FROM "Capacidad_Sector"
WHERE empresa IS NOT NULL;

-- Aquí va tu cambio (DESPUÉS de guardar el backup)
ALTER TABLE Capacidad_Sector ADD COLUMN nueva_col TEXT;

-- Si falla: restore ejecutando los INSERTs guardados
```

**Historial de incidentes:** 2026-08-07 — TRUNCATE accidental de Capacidad_Sector (730 registros perdidos). Lección aprendida → este protocolo existe.

## ⚠ PROTOCOLO OBLIGATORIO: NUNCA modificar datos sin permiso explícito

**Ante cualquier consulta sobre datos corruptos, errores, o inconsistencias en Supabase:**

1. **SOLO reportá el problema** — qué está mal, dónde, cuál es el valor esperado.
2. **NO modificar nada** en Supabase sin permiso directo y explícito del usuario.
3. **Máximo:** Preguntar "¿Quieres que corrija esto?" y esperar respuesta.

**Incidente 2026-08-26:** Corregí picking data (55215: 20833 → 208.33) sin consultar. Usuario pidió rollback. Regla clara desde ahora: **NUNCA asumir que hay que arreglar datos. Reportá, preguntá si se desea, ejecutá si confirma.**

## Quick-ref

- **Datos**: Supabase, proyecto `Control Partes Talleristas`, id
  `hrxfctzncixxqmpfhskv`. Consultar con la herramienta MCP `execute_sql`
  (`project_id = hrxfctzncixxqmpfhskv`).
- **Tabla central**: `Registros_Produccion_Virgilio` (log de eventos; `opcion` =
  código de acción, `texto` = código de tanda/pedido, `ts_inicio` no nulo = cierre).
- **m³ SÍ están en Supabase** (desde v5.33): `PPP_Programacion_Diaria.m3`,
  `PPP_Entregados_Meta.m3` (por NP) y la vista `vista_tanda_m3` — se calculan por
  SQL desde el sandbox. El **origen upstream** sigue siendo el Google Sheet
  "PPP Pedidos Entregados 2026" (col `Mt3`, NO col H ni "Mt3 FC"), espejado en UNA
  vía: `PPP_Entregados_Meta` (np,cod,rs,tanda,m3,fecha_entrega) vía función Postgres
  `sync_ppp_entregados_meta()` por cron (ver `sql/`). La tabla `PPP_Pedidos_Entregados`
  (espejo duplicado vía Apps Script) se **borró en v10.25** — no citarla.
- **Zona horaria**: `America/Argentina/Buenos_Aires`, UTC-3 fijo.
- **Versión**: `APP_VERSION` en `index.html` y `SW_VERSION` en `sw.js`.
- Legajos `0` y `1` (Pruebas) son test/basura: excluir de reportes.

## Estructura: dos apps en un repo (Virgilio + Cervantes + selector)

Este repo junta **las dos plantas** (reemplaza al viejo repo `App-Produccion`, que se
borró). Layout:

- **Raíz** → app **Virgilio** (sin cambios; la usa también la app de Play Store/TWA).
- **`/cervantes/`** → **copia** de la app Cervantes (repo fuente `Registro-Produccion-2.0`).
- **`/selector/`** → pantalla **"¿Dónde vas a trabajar hoy?"** que linkea a ambas:
  Virgilio `../` y Cervantes `../cervantes/`. Recuerda la última planta usada
  (`localStorage` `appprod_ultima_planta`, marca "Última vez"), **no redirige solo**.
- Botón **"← Cambiar planta"** en la pantalla inicial de cada app → va al `selector/`.
- `selector/sw.js` y `cervantes/sw.js` no cachean (mismo patrón que Virgilio). Las dos
  apps conviven sin pisarse: tablas Supabase distintas (`Registros_Produccion_Virgilio`
  vs `Registros Produccion Cervantes`), IndexedDB y claves `localStorage` con prefijos
  distintos. Cervantes usa rutas relativas y SW con scope `/cervantes/`.
- **Entrada por defecto = Virgilio (raíz)**, no el selector (para no romper la URL
  actual ni la app de Play Store). Si se quisiera el selector como entrada, mover el
  selector a la raíz y Virgilio a `/virgilio/` (revisar TWA).
- ⚠ **`/cervantes/` es una copia**: si Cervantes cambia en `Registro-Produccion-2.0`,
  hay que **re-traer** los archivos (`app.js`, `index.html`, `manifest.json`,
  `styles.css`, `sw.js`) y volver a poner el botón "Cambiar planta". Último sync desde
  commit `d2d6a59` (2026-06-04).

## Panel Web LK bajo `/admin/`

Desde v9.11 el repo hospeda una **copia del panel admin de PaginaLK** bajo
`/admin/`. Se accede desde el panel supervisor de Virgilio con el botón grande
**🌐 Panel Web LK** (fila principal, 7 columnas). El botón chequea supervisor y
navega a `admin/admin.html`. Login: **código OTP de 6 dígitos al mail** vía la
Edge Function `admin-login-otp` (verify_jwt=false) que manda el código con
Resend directo (`onboarding@resend.dev` como sender — el SMTP nativo del
proyecto LK apunta a `@loekemeyer.com` sin verificar en Resend y rechazaría).
Al verificar setea un password temporal aleatorio en el user y el front hace
`signInWithPassword` para quedar con sesión.

### Decisión de arquitectura: coexistencia, NO migración

- El admin apunta al proyecto Supabase **LK** (`kwkclwhmoygunqmlegrg`) —
  distinto del de Virgilio (`hrxfctzncixxqmpfhskv`).
- Son **dos proyectos Supabase separados a propósito**: producción y comercial
  son dominios distintos con dueños de datos distintos (ISIS/ERP produce
  `sales_lines`; Virgilio produce `Registros_Produccion_Virgilio`).
- **No migrar tablas ni RPCs de LK a Virgilio.** La copia del admin son 31k
  líneas con 60 RPCs, 40+ tablas, 4 Edge Fns, caches y crons propios; moverlo
  serían semanas de trabajo sin ganar función que hoy no exista.
- Cuando desde Virgilio haga falta un dato del admin (BCRA, deuda, historia de
  un cliente titular de una NP), agregar un cruce puntual vía `postgres_fdw`
  (mismo patrón que ya usa Virgilio contra LK para PPP, o LK contra Chef para
  el padrón). Un cruce por vez, on-demand.

### La copia bajo `/admin/` es un espejo, no un fork

- Cambios que hagan falta al admin **deben originarse en el repo `PaginaLK`**
  y después re-copiarse acá. Mismo patrón que `/cervantes/`.
- Archivos copiados: `admin.html`, `admin.js`, `admin-supercot.js`,
  `admin-osa.js`, `admin-excel-krikos.js`, `analisis-venta-cliente.js`,
  `analisis-cobranzas.html/.js/.css`, `carga-pedidos.html`, `historial.html/.js`,
  `sugerencias.html/.js`, `excel-parser-smart.js`, `argentina-map-data.js`,
  `argentina-provinces.json`, `version.js`, `css/admin.css`, `css/productos.css`,
  `osa/`, `img/favicon.jpg`, `img/no-image.jpg`.
- **Ajustes propios de la copia** (no revertir al re-sincronizar): (a) redirects
  `location.href = "/mayorista"` en admin.js → `"../"` (index Virgilio),
  (b) botón sidebar "Volver a Mayorista" → "Volver a Producción" con `href="../"`,
  (c) `<meta name="robots" content="noindex,nofollow" />` en los HTML del admin
  para que ni buscadores ni la revisión del TWA lo indexen, (d) handler de
  login OTP `lkSendOtp`/`lkVerifyOtp` al final de admin.js que llama a la
  Edge Function `admin-login-otp`, (e) form de OTP dentro del `#loadingScreen`
  de admin.html, (f) redirects `/mayorista` → `../` en `carga-pedidos.html`
  (3 lugares), `historial.html`, `historial.js`, `sugerencias.html`,
  `sugerencias.js`, `analisis-venta-cliente.js` (2 lugares) — el original
  apunta a `mayorista.html` del sitio LK que no existe en Virgilio,
  (g) `historial.html` usa `img/favicon.jpg` (no `.png`, no existe),
  (h) **entrada directa sin OTP desde Virgilio** (v12.35): `admin.js` trae
  `lkTryBridge()` y `checkAuth()` lo llama antes de mostrar el login; canjea el
  `access_token` de la sesión Virgilio (dejado en `sessionStorage` como
  `lk_bridge_vjwt` por `openPanelWebLK()` de Virgilio, mismo origen) por la
  acción `bridge` de la Edge Fn `admin-login-otp`. Si al re-sincronizar se pisa
  alguno, buscar por `LK_ADMIN_EMAIL`, `LK_OTP_FN_URL`, `_lkOtpFn`, `lkTryBridge`,
  `lk_bridge_vjwt`, `lkLoginBox`, o `grep -r "/mayorista"` (no debe haber ninguno).

### Convenciones operativas

- El SW de Virgilio **no cachea** (`self.addEventListener("fetch", () => {})`
  es no-op), así que no colisiona con `/admin/`.
- El TWA de Play Store apunta a la raíz de Virgilio; el admin está dentro del
  `scope`, por eso lleva `robots noindex,nofollow`. No usarlo nunca como `start_url`.
- Los HTML del admin llevan hardcodeado un `?v=23176` heredado del repo LK
  (cache-busting). **No hay hook automático que lo bumpee** desde Virgilio. Si
  se toca un `.js` o `.css` del admin y se necesita invalidar cache, se
  hace a mano incrementando ese número — o el user hace `Ctrl+F5` (que es lo
  habitual).
- La anon key de LK vive en `admin/admin.js` (además de en `sw.js` y `index.html`
  del propio proyecto LK). Al rotar la anon key de LK, actualizarla también acá.

### Edge Function `admin-login-otp` (proyecto Supabase LK)

- Código fuente: `admin/supabase/admin-login-otp/index.ts`.
- Deployada manualmente desde el Dashboard de Supabase LK (verify_jwt=off).
- Reusa la tabla `admin_otp_codes` y los secrets `RESEND_API_KEY` / `RESEND_FROM`
  del vault, que ya usa la Edge Fn `admin-otp` (2FA del admin PPP).
- Destinatario **hardcodeado** a `loekemeyer.n8n@gmail.com`. El user está creado
  a mano en `auth.users` del proyecto LK y vinculado en `public.admins`.
- Si se cambia el destinatario o se agrega otro admin, editar `RECIPIENT_EMAIL`
  en la función Y re-deployar; crear el nuevo user en LK y agregarlo a `admins`.
- **Sensible: 73 chars rompen bcrypt.** El password temporal usa
  `crypto.randomUUID()` (36 chars). No concatenar dos UUIDs — pasa de 72 y falla.
- **NO usar `listUsers` para resolver el recipient.** LK tiene >1200 usuarios
  (clientes del sitio); el admin quedaba fuera de la primera página de 200 → 500
  en OTP y bridge. La función resuelve el `user_id` con la RPC
  `get_admin_login_user_id()` (SECURITY DEFINER, solo `service_role`; SQL en
  `admin/supabase/admin-login-otp/get_admin_login_user_id.sql`).
- **Acción `bridge` (v12.35):** entrada directa sin OTP desde Producción
  Virgilio. Recibe el `access_token` de la sesión del supervisor de Virgilio
  (`vjwt`), lo valida server-side contra el auth de Virgilio
  (`hrxfctzncixxqmpfhskv`, anon key hardcodeada en la función) y **sólo si el
  mail del token == `RECIPIENT_EMAIL`** (mismo dueño, no amplía acceso a nadie)
  devuelve el mismo password temporal que `verify`. Gate 100% en backend: el
  front no puede falsear identidad. Si mañana se quiere que otro supervisor
  entre, ampliar el chequeo de `vemail` en la función (y crear su user en LK).

## Agentes + código de 4 dígitos (Telegram)

Los agentes ya **NO corren automáticos** (el loop cada 2 h y el curador diario
fueron eliminados el 2026-08-10 para bajar consumo de tokens). Los subagentes
siguen definidos en `.claude/agents/` y se invocan **a mano** cuando hace falta:
`mejoras-virgilio`, `revisor-logica`, `auditor-consistencia`, `auditor-supabase`,
`guardian-stock`, `guardian-tests`, `revisor-render`, `keeper-guia`,
`curador-telegram`. Detalle en `docs/AGENTES-DIARIOS.md`.

Cuando se invoca un agente, cada idea nueva entra a `agente_propuestas`
(`estado='pendiente'`). Si se implementa y verifica (`node --check` + smoke
headless), pasa a `estado='lista'` en su rama **`idea/<código>`**. **Nunca** se
toca `main` desde el agente.

Cada propuesta tiene un **código de 4 dígitos** único.

### ⚠ Reglas para CUALQUIER chat sobre este repo

**Comando `:`** — si el usuario escribe un mensaje que es (o empieza con) `:`,
mostrale **todas las ideas creadas** como **checklist, de a 5** (paginá de 5 en 5),
para que marque cuáles confirma. Traelas así:

```sql
select codigo, estado, agente, impacto, titulo, rama
from public.agente_propuestas
where estado in ('pendiente','lista') order by creado_en desc;
```

Mostralas como `[ ] 4837 · [logica·alto] Título (rama idea/4837)`. El usuario
tilda las que quiere → tratá cada tildada como "idea aceptada" (regla de abajo).

**Idea escrita por el usuario** — cuando el usuario escriba una idea/mejora/pedido
en el chat (aunque no dé ningún número), **registrala para que no se pierda**:

1. `select public.nuevo_codigo_propuesta();` para el código.
2. `insert into public.agente_propuestas (codigo, agente, titulo, detalle, estado)
   values ('<cod>','usuario','<título corto>','<lo que pidió, textual>','pendiente');`
3. Agregá una línea ARRIBA en `docs/IDEAS-USUARIO.md`:
   `- [ ] **<cod>** (AAAA-MM-DD) — <idea> — _pendiente_`, y commiteá/pusheá a `main`.
4. Confirmale al usuario: "Anotada como **<cod>**" (así puede activarla después por número).

Las ideas del usuario tienen **prioridad**: quedan `pendientes` en la tabla hasta
que el usuario las active por número o las descarte.

**Idea aceptada (por número o tildada en el checklist)** — cuando el usuario diga
un **código de 4 dígitos** (`4837`, "hacé el 4837", "acepto 4837") o tilde ideas
en el checklist, por cada código aceptado **mergealo a `main` directamente**:

1. `select codigo, titulo, estado, rama from public.agente_propuestas where codigo='4837';`
2. Si `estado='lista'` y tiene `rama`: `git fetch origin && git checkout main &&
   git pull origin main && git merge --no-ff origin/idea/4837 && git push origin main`.
   Si hay conflicto por drift de main, resolvé o rebasá la rama sobre main y reintentá.
3. Si `estado='pendiente'` (todavía sin rama): desarrollala vos ahora en `idea/4837`,
   verificá (`node --check` + smoke headless), y mergeala a main igual.
4. Marcá `update public.agente_propuestas set estado='hecha', actualizado_en=now()
   where codigo='4837';`. Si el usuario la rechaza → `estado='descartada'`.
   Si es idea del usuario (`agente='usuario'`), además actualizá su línea en
   `docs/IDEAS-USUARIO.md` (`[x]` si hecha, `~~tachada~~` si descartada) y commiteá a `main`.

El merge a `main` es **directo, sin mostrar diff** (así lo pidió el usuario), salvo
que en el momento pida verlo.

## Git

- **Trabajar SIEMPRE directo en `main`**: commitear y pushear ahí sin preguntar.
  **NUNCA crear ni usar ramas** (ni feature branches, ni ramas de Claude).
  Todo va a `main` directo. Si la plataforma crea una rama automáticamente,
  mergear a `main` de inmediato y trabajar desde ahí.
- Estilo de commits: `vX.YZ: descripción` cuando hay bump de versión.
