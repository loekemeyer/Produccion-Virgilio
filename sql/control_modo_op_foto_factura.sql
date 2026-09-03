-- ============================================================================
-- Control_Modo_OP · foto de la FACTURA (v12.64)
-- ============================================================================
-- POR QUÉ: en Recepción de Mercadería, cuando el operario elige "📄🧾 Remito y
-- Factura", ahora se le piden las DOS fotos (una de cada papel) y las dos se ven
-- en la pantalla de Pendientes. La primera sigue yendo a `foto_url`; la segunda
-- necesita esta columna.
--
-- ES ADITIVO Y NO DESTRUCTIVO: agrega una columna nullable. No toca ninguna fila
-- existente, no borra nada, y las recepciones viejas quedan con NULL (se siguen
-- viendo con su única foto, exactamente como hoy).
--
-- MIENTRAS NO SE CORRA: la app NO se rompe. recepcion.js detecta que la columna
-- falta y (a) guarda la recepción igual, sin la foto de la factura, y (b) sigue
-- listando Pendientes sin ella. Deja un warning en la consola. O sea que esta
-- columna se puede crear cuando se quiera, sin apuro y sin ventana de corte.
--
-- BACKUP: no hace falta el dump previo del protocolo del CLAUDE.md — un ADD COLUMN
-- nullable no puede perder datos. Para revertir alcanza con el DROP de abajo, que
-- sólo borraría las URLs de fotos de factura cargadas desde que se creó.
-- ============================================================================

alter table public."Control_Modo_OP"
  add column if not exists foto_factura_url text;

comment on column public."Control_Modo_OP".foto_factura_url is
  'URL pública de la foto de la FACTURA (bucket `remitos`). Se carga sólo cuando el '
  'tipo de documento de la recepción es "Remito y Factura"; en ese caso `foto_url` es '
  'la del remito. NULL en los otros tipos y en todo lo anterior a v12.64.';

-- Comprobación:
--   select count(*) filter (where foto_url is not null)         as con_remito,
--          count(*) filter (where foto_factura_url is not null) as con_factura
--   from public."Control_Modo_OP";

-- Revertir (sólo si hace falta):
--   alter table public."Control_Modo_OP" drop column if exists foto_factura_url;
