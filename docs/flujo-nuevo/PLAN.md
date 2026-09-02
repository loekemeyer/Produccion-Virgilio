# Flujo nuevo de pedidos — de la página a la factura

> Estado: **Fase 1 arrancada** (generador en modo sombra, read-only).
> Doc de diseño visual: artifact "De la página a la factura".
> Última actualización: 2026-09-02.

## La idea

Hoy **ISIS manda**: un empleado carga los pedidos de la página a ISIS, ISIS arma
las NP y las manda a la PPP, y recién ahí producción trabaja.

El flujo nuevo lo da vuelta: **producción (Virgilio) arma todo directo desde la
página** — la PPP, las NP, el m³ — y a ISIS le pasa el pedido ya armado, al
final, solo para facturar. ISIS pasa a ser un facturador, deja de ordenar el
proceso.

## Por qué se puede

Casi todas las piezas ya existen. Verificado con datos reales (2026-09-02):

- **m³ propio**: `Volumen_Articulos` cubre 312/320 artículos (faltan 8). Nuestro
  m³ dio **98,5%** del de ISIS sobre 158 NPs.
- **Lógica de split**: ISIS parte un pedido en NPs con tope de **18 líneas
  (Loekemeyer) / 15 (Chef)** en orden de código. 243 NPs reales tienen
  exactamente 18 líneas → firma clarísima.
- **Cruce factura ↔ NP**: ya construido (lo usa el bot de WhatsApp,
  `vista_np_factura`). Ata por monto + cajas + fecha, agrupa por dirección de
  entrega. No hay que hacerlo.
- **Dirección de entrega**: es dato nuestro, capturado en la página
  (`sucursal_entrega` + `direccion`), no de ISIS. El expreso queda en `direccion`
  (ej. depósito compartido "Pergamino 3751").

## Validación del generador en sombra (Fase 1)

`sql/ppp_shadow_generator.sql` genera la PPP desde los pedidos web y la compara
contra la de ISIS. Primer resultado, sobre **89 cliente-día comparables**:

| Métrica | Resultado |
|---|---|
| Mismo número de NPs generadas | **89 / 89 (100%)** |
| Mismas cajas totales | 86 / 89 (97%) |
| m³ dentro del 5% | validado aparte, 98,5% (158 NPs) |

## Plan por fases

### Fase 0 — Confirmar el candado (antes de codear el flip)
- Probar que **ISIS importa el Excel** en el formato nuestro.
- Confirmar si deja meter **nuestra NP** en un campo (ej. orden de compra) para
  conciliación exacta — opcional, no bloquea.
- Es una prueba con la persona de ISIS, no código.

### Fase 1 — Generador en modo sombra ← **ACÁ ESTAMOS**
- Correr el generador **en paralelo**, sin tocar la operación.
- Comparar contra la PPP real y medir el empate (`v_shadow_ppp_compare`).
- **Hecho**: primera versión + validación (100% en número de NPs).

### Fase 2 — Ajustar hasta que empate
- Cerrar los bordes que aparezcan en sombra:
  - Split por **sucursal** (hoy el generador no lo aplica).
  - Multi-pedido mismo día (~9% de cliente-día): ¿ISIS junta o separa?
  - Cargar los **8 artículos** sin volumen.
  - Limpiar direcciones ("SIM-30999...", cliente vs expreso).
- Correrlo **semanas** hasta >99% de empate. Nada de la operación se toca.

### Fase 3 — El corte (flip), con piloto
- Producción deja de cargar a ISIS al inicio; la PPP la manda el generador.
- Al final se exporta el Excel armado y se importa a ISIS solo para facturar.
- Arrancar chico: una tanda, o **Chef primero** (más chico, menos riesgo).
- **Rollback vivo**: hasta acá, el camino viejo (ISIS arma la PPP) queda como
  paracaídas. Si el generador falla un día, se vuelve a ISIS en el acto.

### Fase 4 — Cerrar el ciclo
- Confirmar que la factura vuelve y concilia sola (ya funciona).
- Si se logra meter la NP en la factura, activar eso y matar el ~1,7% ambiguo.

## Requisitos operativos (en paralelo, no bloquean el build)

1. **100% de los pedidos por la página** (incluye teléfono por cotizador).
2. **Capturar bien las dos direcciones en el formulario** (cliente vs entrega) —
   solo se puede hacer en la página, en el momento del pedido.
3. **Cargar los 8 artículos** sin volumen, y candado para que un artículo nuevo
   no salga a la venta sin su medida.
