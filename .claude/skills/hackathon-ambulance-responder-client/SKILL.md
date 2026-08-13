---
name: hackathon-ambulance-responder-client
description: Cliente de ambulancia y dominio de vehículos — turnos, disponibilidad, pipeline de GPS, PWA del responder con aceptar/rechazar asignación, navegación, llegada, traslado y cierre. Úsala para TODO trabajo en src/server/modules/vehicles/, app/api/vehicles/ y app/responder/.
---

# Responder Operations — A2

Tu usuario va en un vehículo en movimiento, con las manos ocupadas y sirena
sonando. Cada toque de más en tu UI es un segundo de retraso real. Diseña para
ese contexto, no para una demo bonita en un monitor.

## OWNS

```
src/server/modules/vehicles/**        (incl. shifts/ y locations/)
app/api/vehicles/**
app/responder/**                       ← PWA de la ambulancia
packages/db/migrations/03*.sql         ← tu rango
```

## MUST NOT TOUCH

```
src/server/modules/dispatch/**         ← no calculas scoring ni eliges unidades
assignments (tabla)                    ← A3 es el único ESCRITOR
app/command/**  app/report/**
packages/contracts/**                  ← congelado
```

Cuando la ambulancia acepta, llamas a la función exportada de dispatch
(`dispatch.acceptAssignment(...)`), **no** escribes SQL sobre `assignments`.
Leer esa tabla sí puedes.

## PIPELINE DE GPS

Dos tablas, dos propósitos. No las confundas:

- `vehicle_locations` — histórico append-only. Traza y auditoría. Tiene trigger
  que prohíbe UPDATE.
- `vehicle_current_location` — **una fila por vehículo**. Es lo que lee el motor
  de despacho en el camino caliente. Se hace UPSERT.

Cada `POST /vehicles/:id/location` escribe en **ambas**, en una sola transacción.

Cadencia: 3s en movimiento, 15s parado. En el navegador usa `watchPosition`, no
un `setInterval` con `getCurrentPosition` (drena batería y da posiciones viejas).
Batchea si la red falla: acumula y envía el lote con timestamps reales, no con la
hora de llegada al servidor. El motor penaliza GPS viejo, así que un timestamp
mentido degrada las decisiones de todo el sistema.

## EL FLUJO, Y LA CARRERA QUE VAS A PERDER

```
turno → AVAILABLE → [oferta] RESERVED → aceptar → ASSIGNED
      → EN_ROUTE → ON_SCENE → TRANSPORTING → COMPLETED → AVAILABLE
```

**Vas a recibir 409.** El despachador puede haber reasignado, la oferta puede
haber expirado (30s), otro incidente pudo ganar la carrera. Cuando aceptas y el
servidor responde 409, la UI **no** puede mostrar la asignación como si hubiera
funcionado. Muestra: *"Esta asignación ya no está disponible"* y vuelve a la
pantalla de disponible. Un estado optimista que miente aquí es peligroso en la
vida real y se ve fatal en la demo.

Rechazar exige motivo de la lista cerrada (`MECHANICAL`, `CREW_UNAVAILABLE`,
`ALREADY_COMMITTED`, `UNSAFE_ACCESS`, `OTHER`). Sin motivo libre: se audita.

## UI EN MOVIMIENTO — RESTRICCIONES DURAS

- **Una acción principal por pantalla.** Un botón enorme que ocupe el tercio
  inferior. Nada de menús.
- Objetivo táctil mínimo 64 px. El estándar de 44 px asume que estás quieto.
- Alto contraste; legible con sol directo y con luz nocturna de cabina.
- Acciones destructivas o irreversibles (rechazar, cerrar servicio):
  deslizar para confirmar, no un diálogo de sí/no que se toca sin querer.
- La oferta entrante debe ser **imposible de ignorar**: pantalla completa,
  vibración, cuenta atrás visible de los 30s.
- Estado offline explícito. Si el GPS no se está enviando, dilo; no finjas.

## CRITERIOS DE ACEPTACIÓN

- [ ] Ciclo completo turno→cierre con `incident_event` en cada paso
- [ ] Toda transición pasa por `assertVehicleTransition`
- [ ] Aceptar una oferta ya tomada → 409 manejado, sin estado optimista falso
- [ ] Oferta expirada a los 30s con cuenta atrás visible en pantalla
- [ ] `vehicle_current_location` siempre coincide con la última fila del histórico
- [ ] Cada acción del flujo se ejecuta en 1 toque (se cuenta y se verifica)
- [ ] Reconexión: cola de posiciones pendientes se envía con timestamps originales
- [ ] Doble toque en aceptar → una sola aceptación (`Idempotency-Key`)

## ERRORES PROHIBIDOS

- Decidir disponibilidad en el cliente. El servidor es la autoridad (§10)
- Escribir SQL sobre `assignments`
- Estado optimista que sobreviva a un 409
- `setInterval` + `getCurrentPosition` para el tracking
- Timestamps de GPS puestos por el servidor en vez del dispositivo
- Flujos de más de un toque por acción en movimiento

## FUENTES

Patrones de PWA/React y ciclo de vida en Next.js desde
[vercel-labs/next-best-practices](https://github.com/VoltAgent/awesome-agent-skills).
Patrones de tracking de vehículos y rendimiento de markers desde
[mapbox/mapbox-agent-skills](https://github.com/mapbox/mapbox-agent-skills)
(`mapbox-web-integration-patterns`, `mapbox-web-performance-patterns`, MIT) —
la API es compatible con MapLibre, que es lo que usamos. Ambos `quarantined`.

## FORMATO DE REPORTE (§27)

```
AGENT: A2
DOMAIN: vehicles / responder
DONE / WORKING / BLOCKED / CONTRACT CHANGES / FILES TOUCHED / NEEDS FROM OTHER AGENTS
```
