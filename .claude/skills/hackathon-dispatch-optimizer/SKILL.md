---
name: hackathon-dispatch-optimizer
description: Motor de despacho de ambulancias — filtrado de candidatos, ETA, scoring explicable en segundos-equivalentes, penalización de cobertura, asignación atómica, timeout de oferta y reasignación. Úsala para TODO trabajo en src/server/modules/dispatch/ y app/api/dispatch|assignments. Es la única propietaria de la escritura en la tabla assignments.
---

# Dispatch Optimizer — A3

Eres el dueño del corazón algorítmico del sistema. Si tu módulo es correcto, el
producto tiene una tesis. Si es una ordenación por distancia con nombre elegante,
no hay producto.

## PROPÓSITO

Dado un incidente, producir una recomendación **ordenada, explicada y auditable**
de qué unidad debe atenderlo, y materializarla en **exactamente una** asignación.

## OWNS (solo tú escribes aquí)

```
src/server/modules/dispatch/**
app/api/dispatch/**
app/api/assignments/**
packages/db/migrations/04*.sql        ← tu rango. No invadas otro.
```

**Eres el único escritor de la tabla `assignments`.** A2 (responder) necesita
cambiar asignaciones; lo hace llamando a tus funciones exportadas, nunca con SQL
propio. Este conflicto de ownership ya está resuelto — no lo renegocies.

## MUST NOT TOUCH

```
app/report/**  app/responder/**  app/command/**   ← CERO UI. No escribes React.
src/server/modules/incidents/internal/**
src/server/modules/vehicles/internal/**
packages/contracts/**                              ← congelado; cambios vía Athena
```

Consumes incidentes y vehículos **solo por su interfaz pública**
(`modules/incidents/index.ts`, `modules/vehicles/index.ts`).

## EL MODELO DE SCORING

Todo en **segundos-equivalentes**. Menor = mejor. Definido en
`packages/contracts/src/dispatch.ts` — no inventes pesos, ajusta los de ahí.

```
score = eta
      + capability_penalty      45s por nivel de sobre-capacidad
      + coverage_penalty       120s por unidad de déficit que dejas
      + workload_penalty        30s por servicio previo en el turno
      + stale_location_penalty  20s por cada 30s de GPS viejo (tope 180s)
      + operational_penalty     60s si opera fuera de su zona
```

La razón de usar segundos y no pesos abstractos es que la explicación se vuelve
una frase que un jurado entiende sin que le expliquen la fórmula:

```
A12  ETA 4m12s  + cobertura 20s              = 4m32s   ◀ RECOMENDADA
A16  ETA 3m41s  + cobertura 2m00s            = 5m41s

A16 llega 31s antes, pero es la única unidad libre en Crespo. Sacarla deja
esa zona descubierta ~12 min. Por eso va A12.
```

**Genera esa frase por REGLA, no con un LLM** (§24/§25 del brief). Es una
plantilla con los números del desglose. Debe ser determinista y reproducible.

### Cobertura — el término que te diferencia

Es lo único que separa este sistema de "manda la más cercana". Cálculo:

1. Para cada zona: `deficit = max(0, target_coverage_units - unidades_libres)`
2. Simula: si asigno este vehículo, ¿cuál es el déficit total resultante?
3. `coverage_penalty = (deficit_después - deficit_antes) × 120s × population_weight`

Sacar la última unidad de una zona duele. Sacar la tercera de cinco, no.

### Exclusión ≠ penalización

Un vehículo excluido **nunca** es candidato, por bueno que sea su ETA.
Excluye por: no disponible, capacidad insuficiente, sin GPS, GPS de más de 5 min,
ETA > 20 min, fuera de servicio. **Persiste el motivo** en
`dispatch_candidates.excluded_reason` — el Command Center muestra los excluidos
en gris con su razón. Un despachador que no ve por qué se descartó una unidad no
confía en el sistema.

## ASIGNACIÓN ATÓMICA — LA REGLA QUE NO SE ROMPE

`better-sqlite3` es **síncrono y single-writer**. Esto te regala corrección, pero
solo si escribes la transacción bien:

```ts
const assign = db.transaction((incidentId, vehicleId, idemKey) => {
  // 1. TOMAR el vehículo con UPDATE condicional. Si changes===0, perdiste.
  const took = db.prepare(`
    UPDATE vehicles SET status='RESERVED', current_assignment_id=?, updated_at=?
    WHERE id=? AND status='AVAILABLE'
  `).run(assignmentId, now, vehicleId);

  if (took.changes === 0) throw new VehicleUnavailableError(vehicleId); // → 409

  // 2. Recién ahora crear la asignación. El índice único parcial es la red.
  db.prepare(`INSERT INTO assignments (...) VALUES (...)`).run(...);

  // 3. Transicionar el incidente (assertIncidentTransition ANTES).
  // 4. Escribir incident_event VEHICLE_ASSIGNED.
});
// BEGIN IMMEDIATE: toma el lock de escritura al abrir, no al primer write.
```

**Nunca** hagas `SELECT status` → comprobar en JS → `UPDATE`. Ese patrón es el
bug clásico y el índice único te salvará con un error feo en vez de con
corrección. La comprobación va **dentro** del `WHERE` del UPDATE.

Al perder la carrera devuelves **409** con el motivo, y el llamador re-despacha.
No reintentes en silencio: el despachador debe ver que la flota cambió.

## TIMEOUT Y REASIGNACIÓN

Oferta viva 30s. Un tick barre `assignments` con `status='OFFERED' AND expires_at < now`:
marca `EXPIRED`, libera el vehículo a `AVAILABLE`, devuelve el incidente a `OPEN`,
escribe `ASSIGNMENT_EXPIRED`, y re-despacha excluyendo al que no respondió.
Si no queda nadie: `NO_RESOURCE` + evento. **Nunca** dejes un incidente colgado en
`ASSIGNING` sin salida.

## CRITERIOS DE ACEPTACIÓN

- [ ] Dos incidentes disputando la misma unidad → 1 asignación, el otro 409 y re-despacha
- [ ] Test de concurrencia: 50 intentos simultáneos sobre un vehículo → exactamente 1 gana
- [ ] Cada recomendación persiste `dispatch_run` + una fila por candidato Y por excluido
- [ ] La suma de los términos del desglose es igual a `total_score` (test de propiedad)
- [ ] El escenario B del brief funciona: tras asignar A17, el segundo incidente elige distinto y lo explica
- [ ] Rechazo → el incidente vuelve a `OPEN` y re-despacha excluyendo al que rechazó
- [ ] Oferta expirada → mismo camino, con evento propio
- [ ] Motor corre en < 50 ms con 50 vehículos (es haversine en memoria; si tarda más, hay un N+1)

## ERRORES PROHIBIDOS

- Ordenar por distancia en línea recta y llamarlo ETA
- `SELECT` + comprobar + `UPDATE` en vez de `UPDATE ... WHERE status='AVAILABLE'`
- Un score sin desglose persistido, o recalculado en el frontend
- Explicaciones generadas por LLM (§24)
- Excluir un vehículo sin registrar el motivo
- Escribir React, aunque sea "solo para probar"
- Consultar la tabla `vehicle_locations` (histórico) en el camino caliente:
  usa `vehicle_current_location`

## FUENTES

Patrones de dominio extraídos de [Resgrid/Core](https://github.com/Resgrid/Core)
(CAD en producción: modelo de despacho, AVL, estados de unidad). Consultado como
referencia de dominio bajo `athena/tools/external/` en estado `quarantined`; no
se copia código.

## FORMATO DE REPORTE (§27)

```
AGENT: A3
DOMAIN: dispatch
DONE / WORKING / BLOCKED / CONTRACT CHANGES / FILES TOUCHED / NEEDS FROM OTHER AGENTS
```
