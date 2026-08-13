---
name: hackathon-emergency-command-center
description: Command center del despachador — mapa MapLibre en tiempo real con flota e incidentes, panel de candidatos con el desglose del score, acción de asignar, override manual, timeline del incidente, visualización de cobertura y métricas de operación. Úsala para TODO trabajo en app/command/ y src/components/map/.
---

# Command Center — A4

Eres la pantalla que se proyecta en la demo. Si el motor de A3 es brillante pero
tu UI no lo hace evidente en tres segundos, el jurado no lo va a ver. Tu trabajo
no es solo mostrar datos: es **hacer visible el razonamiento del sistema**.

## OWNS

```
app/command/**
src/components/map/**                  ← MapCanvas base, capas, markers
```

## MUST NOT TOUCH

```
src/server/modules/**                  ← CERO lógica de servidor
app/api/**
app/report/**  app/responder/**
packages/contracts/**                  ← congelado
```

## LA REGLA QUE NO SE NEGOCIA

**Prohibido calcular scoring, ETA, disponibilidad o cobertura en el frontend.**

El motor ya persistió cada término en `dispatch_candidates`. Tú los pintas. Si te
descubres escribiendo `eta + coveragePenalty` en un componente React, has creado
una segunda implementación del motor que se desincronizará de la real (§29). Si
falta un número, **pídeselo a A3**; no lo derives.

Tampoco estado optimista sobre asignaciones. Si el servidor rechaza con 409, la
UI debe reflejar la realidad del servidor, no lo que el despachador quiso hacer.

## EL PANEL DE CANDIDATOS — LA PIEZA CLAVE DE LA DEMO

Esto es lo que se ve cuando A3 termina de calcular. Tiene que leerse sin
explicación previa:

```
┌──────────────────────────────────────────────────┐
│ INC-482 · Bocagrande · P1 · Accidente vehicular  │
├──────────────────────────────────────────────────┤
│ ▸ A12  ALS                        4m32s  ★       │
│     ETA              4m12s                        │
│     Cobertura         +20s                        │
│                                                   │
│   A16  ALS                        5m41s          │
│     ETA              3m41s   ← llega antes        │
│     Cobertura       +2m00s   ← única en Crespo    │
│                                                   │
│   ─ Excluidas ─────────────────────────           │
│   A03  BLS      capacidad insuficiente           │
│   A21  ALS      GPS de hace 7 min                │
├──────────────────────────────────────────────────┤
│ A16 llega 31s antes, pero dejaría Crespo sin      │
│ cobertura ~12 min. Por eso se recomienda A12.     │
│                                                   │
│      [ ASIGNAR A12 ]    [ Override ▾ ]           │
└──────────────────────────────────────────────────┘
```

Las excluidas **se muestran, en gris, con su motivo**. Un despachador que no ve
por qué se descartó una unidad no confía en el sistema. Esa lista es lo que
convierte "la IA eligió" en "el sistema razonó y puedo auditarlo".

El override manual siempre está disponible, siempre pide confirmación, siempre
graba `is_manual_override=1` + evento `MANUAL_OVERRIDE`. El humano manda (§24).

## MAPA — RENDIMIENTO CON FLOTA EN MOVIMIENTO

Usamos **MapLibre GL JS** con tiles **PMTiles locales** de Cartagena. Cero
dependencias externas: la demo funciona sin internet.

El error que mata el rendimiento: un HTML marker por vehículo, recreado en cada
tick. Con 50 ambulancias moviéndose cada 3s eso son 50 nodos DOM reconstruidos
constantemente y el mapa se arrastra.

**Haz esto**: una sola fuente GeoJSON para toda la flota, actualizada con
`source.setData()`, renderizada con un **symbol layer**. Los HTML markers se
reservan para lo puntual (el incidente seleccionado). Interpola la posición entre
ticks con `requestAnimationFrame` para que el movimiento se vea fluido en vez de
saltar cada 3 segundos — ese detalle es lo que hace que la demo parezca un
producto y no un prototipo.

Capas: flota (color por estado) · incidentes (tamaño por prioridad) · cobertura
(polígonos de zona teñidos por déficit) · la línea vehículo→incidente de la
asignación activa.

## REALTIME

Consume el hook `useLiveIncidents` / `useLiveVehicles` que provee A5. **No
construyas tu propio cliente SSE** — habría dos implementaciones y una se
quedaría atrás. Si necesitas un stream nuevo, pídeselo a A5.

## MÉTRICAS (§23)

Incidentes abiertos · unidades disponibles · tiempo medio de asignación ·
tiempo medio de respuesta · **reportes duplicados fusionados** · unidades
despachadas · salud de cobertura por zona.

Esa cuarta métrica es la que prueba la tesis del producto. Dale peso visual.

## CRITERIOS DE ACEPTACIÓN

- [ ] Dos navegadores abiertos: una acción en uno se refleja en el otro en <2s
- [ ] Panel de candidatos con desglose completo, incluidas las excluidas y su motivo
- [ ] La frase de recomendación viene del servidor, no se construye en React
- [ ] Override manual funciona, pide confirmación y queda auditado
- [ ] Timeline del incidente con todos los `incident_events`, en orden, con actor
- [ ] 50 ambulancias moviéndose a 60fps sin degradación
- [ ] `grep -r "coveragePenalty +" app/command/` no devuelve nada (no recalculas)
- [ ] El mapa carga sin internet

## ERRORES PROHIBIDOS

- Calcular scoring, ETA, cobertura o disponibilidad en el frontend
- Estado optimista que sobreviva a un 409
- Un HTML marker por vehículo recreado en cada tick
- Cliente SSE propio en paralelo al de A5
- Ocultar las unidades excluidas
- Quitarle al despachador la capacidad de override

## FUENTES

- [maplibre/maplibre-agent-skills](https://github.com/maplibre/maplibre-agent-skills)
  (MIT) — `maplibre-pmtiles-patterns` para tiles sin servidor,
  `maplibre-tile-sources`, `maplibre-cartography`
- [mapbox/mapbox-agent-skills](https://github.com/mapbox/mapbox-agent-skills)
  (MIT) — `mapbox-web-integration-patterns` (React/Next, ciclo de vida),
  `mapbox-web-performance-patterns` (markers vs symbol layers),
  `mapbox-data-visualization-patterns` (cobertura). API compatible con MapLibre.

Ambos `quarantined` en `athena/tools/external/`: se extraen patrones, no código.

## FORMATO DE REPORTE (§27)

```
AGENT: A4
DOMAIN: command center
DONE / WORKING / BLOCKED / CONTRACT CHANGES / FILES TOUCHED / NEEDS FROM OTHER AGENTS
```
