---
name: hackathon-emergency-incident-engine
description: Motor de incidentes de emergencia — creación desde reportes ciudadanos, agrupación de reportes duplicados en un solo incidente, triage por reglas explícitas, máquina de estados del incidente y timeline de auditoría, más la PWA del reporter. Úsala para TODO trabajo en src/server/modules/incidents/, app/api/incidents/ y app/report/.
---

# Incident Engine — A1

Eres el dueño de la entrada al sistema. Tu módulo decide algo que ningún otro
puede corregir después: **si cuatro llamadas son cuatro emergencias o una sola.**
Equivocarse aquí despacha cuatro ambulancias a un accidente.

## PROPÓSITO

Convertir reportes ciudadanos crudos en incidentes limpios, deduplicados,
priorizados por regla y con trazabilidad completa.

## OWNS

```
src/server/modules/incidents/**       (incl. dedup/ y triage/)
app/api/incidents/**
app/report/**                          ← PWA del reporter
packages/db/migrations/02*.sql         ← tu rango
```

## MUST NOT TOUCH

```
src/server/modules/dispatch/**         ← no calculas ni sugieres unidades
src/server/modules/vehicles/**
assignments (tabla)                    ← A3 es el único escritor
packages/contracts/**                  ← congelado
```

Tu API expone el incidente; **no** expone "qué ambulancia debería ir". Si
necesitas saber si hay unidad asignada, léelo por la interfaz pública de dispatch.

## LA REGLA CENTRAL: 1 INCIDENTE, N REPORTES

`POST /incidents` **siempre** crea un `incident_report`. A veces además crea un
`incident`; a veces lo pega a uno existente. El reporter nunca sabe cuál — el
servidor decide y responde con honestidad:

```ts
{ incident, report, wasMerged: boolean, mergedIntoIncidentId: string | null }
```

### Algoritmo de deduplicación — explícito, no un LLM

Al llegar un reporte, busca incidentes **vivos** creados en los últimos 15 min
(índice `ix_incidents_created_at`) y calcula haversine en JS sobre ese subconjunto.
Son decenas de filas: no necesitas índice espacial.

```
distancia ≤ 150 m  Y  Δt ≤ 5 min  Y  tipo compatible   → MERGE automático
distancia ≤ 400 m  Y  Δt ≤ 10 min                      → SUGERIR merge al despachador
en otro caso                                            → INCIDENTE NUEVO
```

Ajusta el umbral por `accuracy_m` del reporte: un GPS con ±200 m de precisión no
puede afirmar que dos puntos a 150 m son distintos. Usa
`umbral_efectivo = 150 + accuracy_m` para el merge automático.

**Tipos compatibles**: `TRAFFIC_ACCIDENT` con `TRAUMA` sí. `CARDIAC` con
`TRAFFIC_ACCIDENT` no — pueden ser dos emergencias reales en la misma esquina.
Codifica la matriz de compatibilidad de forma explícita y testeable.

Cada merge escribe `merge_confidence`, `merge_reason` y un evento `REPORT_MERGED`.
Un despachador tiene que poder deshacerlo, así que **nunca destruyas** el reporte
original ni sobrescribas su ubicación.

La zona gris (400 m) es una funcionalidad, no una debilidad: el Command Center
muestra "posible duplicado" y el humano decide. Eso es exactamente el §24.

### Triage por reglas (§24 — NUNCA un LLM)

La prioridad sale de una tabla explícita `tipo × señales → P1..P4`. Un LLM puede
*sugerir* el tipo a partir del texto libre, pero la prioridad la fija la tabla y
el operador puede sobrescribirla. Escribe la tabla en
`modules/incidents/triage/rules.ts` con un test por fila.

## REPORTER PWA

Sin login (§2A). Un reporte se hace bajo estrés, quizá con una mano, quizá con
un herido delante. Restricciones:

- Ubicación primero, con permiso del navegador; fallback a marcar en el mapa
- Tipo de emergencia con iconos grandes, no un `<select>`
- Descripción opcional. Si el usuario no escribe nada, el reporte sigue siendo válido
- Confirmación inmediata con el código `INC-482` visible y grande
- Tras confirmar: estado en vivo + ETA cuando exista asignación
- Debe funcionar con conexión mala: optimista al enviar, reintento con `Idempotency-Key`

**Nunca** le digas al ciudadano "tu reporte fue marcado como duplicado". Díselo
como lo que es: *"Ya hay una unidad en camino a esta emergencia."* Es la verdad y
no lo hace sentir ignorado.

## CRITERIOS DE ACEPTACIÓN

- [ ] Escenario §22: 4 reportes del mismo accidente → 1 incidente, 4 reportes, 1 asignación
- [ ] Dos emergencias reales a 100 m pero de tipo incompatible → 2 incidentes
- [ ] Reporte con `accuracy_m` alto no fusiona agresivamente
- [ ] Toda transición pasa por `assertIncidentTransition` — ninguna escritura directa de `status`
- [ ] El timeline devuelve ≥6 eventos con actor y timestamp para un incidente completo
- [ ] La UI del reporter completa un reporte en ≤3 toques desde la carga
- [ ] Doble envío con el mismo `Idempotency-Key` → un solo reporte

## ERRORES PROHIBIDOS

- Crear un incidente por cada reporte (el fallo que este producto existe para evitar)
- Deduplicar en el cliente
- Aceptar `status` desde el frontend
- Determinar prioridad médica con un LLM (§24)
- Borrar o sobrescribir el reporte original al fusionar
- Exigir login para reportar

## FUENTES

Modelo de dominio incidente/reporte contrastado con
[Resgrid/Core](https://github.com/Resgrid/Core) (CAD en producción).
Patrones de Next.js App Router desde
[vercel-labs/next-best-practices](https://github.com/VoltAgent/awesome-agent-skills).
Ambos en `quarantined`; se extraen patrones, no se copia código.

## FORMATO DE REPORTE (§27)

```
AGENT: A1
DOMAIN: incidents
DONE / WORKING / BLOCKED / CONTRACT CHANGES / FILES TOUCHED / NEEDS FROM OTHER AGENTS
```
