# Ideas del usuario — Producción Virgilio

Proyección en el repo de las ideas que **escribe el usuario** en cualquier chat.
Cada idea queda acá (durable, versionada) y además en la tabla `agente_propuestas`
(Supabase) para entrar al mismo circuito que las de los agentes: se desarrolla sola
en su rama `idea/<código>`, se recuerda en el Telegram de las 8 **todos los días
hasta que el usuario la active**, y se mergea a `main` cuando el usuario dice el número.

- `[ ]` = pendiente / esperando activación · `[x]` = activada (mergeada a main) ·
  `~~tachada~~` = descartada.
- El código de 4 dígitos es el mismo que en la tabla y en el Telegram.

> Este archivo es un espejo legible. La fuente operativa es la tabla
> `agente_propuestas`. Al registrar o activar una idea del usuario se actualizan
> los dos. No borres entradas: se tildan o se tachan.

## Ideas

- [ ] **6650** (2026-07-30) — **PPP sin Excel**: que la programación y la base de pedidos
  no dependan del hook Excel→Apps Script→Sheet, y se puedan **cargar directo en la app**.
  Etapas: (0) carga directa del .xlsx desde la app a Supabase; (1) PK natural `np` + upsert
  + `origen`/`actualizado_en`; (2) subir a Supabase el estado que hoy vive en `localStorage`
  (`vir_ppp_edits`, alias de barrio, override de zona); (3) alta manual de NP en la app;
  (4) `PPP_Base_Pedidos` desde la app; (5) matar `PPP_Pedidos_Entregados` →
  `vista_ppp_pedidos_entregados`. — _pendiente_ · **avance**: v6.66 agregó el botón
  🧪 *PRUEBA* Exportar Excel sugerido (Sugerir tandas → .xlsx importable por la PPP), que
  cierra a mano el ida y vuelta app→Excel→app sin tipear.

<!-- Nuevas entradas se agregan ARRIBA de esta línea, formato:
- [ ] **CÓDIGO** (AAAA-MM-DD) — texto de la idea — _estado_
-->
