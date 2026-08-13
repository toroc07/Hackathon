/**
 * @dispatch/contracts — superficie pública.
 *
 * TODO el sistema importa desde aquí: `import { ... } from '@dispatch/contracts'`.
 * Nunca importes un archivo interno por ruta profunda: si un símbolo no está
 * exportado aquí, no forma parte del contrato.
 *
 * ⚠ CONGELADO. Cualquier cambio: (1) se documenta, (2) se comunica a los 5
 * agentes, (3) actualiza este paquete. Nadie duplica una estructura de aquí (§29).
 */

export * from './enums.js';
export * from './state-machines.js';
export * from './geo.js';
export * from './dispatch.js';
export * from './triage.js';
export * from './models.js';
export * from './api.js';
export * from './mocks.js';
