/**
 * CONTRACTS — registro de ciudadano y de ambulancia (§33, aditivo).
 *
 * El ciudadano se registra con nombre, correo y telefono antes de reportar.
 * El telefono es lo que permite al responder llamarlo desde el panel de la
 * ambulancia cuando un reporte no trae suficiente informacion — por eso es
 * el unico dato realmente obligatorio para que el sistema funcione; nombre
 * y correo son identificacion, no bloquean el flujo si son minimos.
 *
 * Sin contraseña a proposito: es una demo de hackathon, no un sistema de
 * cuentas con recuperacion de acceso. La sesion es una cookie firmada
 * (mismo patron HMAC que session.ts), no hay verificacion de identidad
 * real — un telefono/correo repetido simplemente reingresa a esa cuenta.
 */

import { z } from 'zod';
import { zCapabilityLevel, zId } from './models.js';

// ─── CIUDADANO ──────────────────────────────────────────────────────────────

export const zCitizenRegisterRequest = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(160),
  phone: z.string().trim().min(7).max(30),
});
export type CitizenRegisterRequest = z.infer<typeof zCitizenRegisterRequest>;

export const zCitizenSession = z.object({
  id: zId,
  name: z.string(),
  email: z.string(),
  phone: z.string(),
});
export type CitizenSession = z.infer<typeof zCitizenSession>;

export const zCitizenRegisterResponse = z.object({ citizen: zCitizenSession });
export type CitizenRegisterResponse = z.infer<typeof zCitizenRegisterResponse>;

// ─── AMBULANCIA ─────────────────────────────────────────────────────────────

/** Registra una unidad nueva: placa + numero de unidad (callsign) + hospital
 *  al que pertenece. No reemplaza el seed de la flota — la complementa. */
export const zRegisterVehicleRequest = z.object({
  plate: z.string().trim().toUpperCase().min(4).max(12),
  callsign: z.string().trim().min(2).max(12),
  hospitalFacilityId: z.string().min(1),
  capabilityLevel: zCapabilityLevel.default('BLS'),
});
export type RegisterVehicleRequest = z.infer<typeof zRegisterVehicleRequest>;

export const zRegisterVehicleResponse = z.object({
  vehicleId: zId,
  callsign: z.string(),
});
export type RegisterVehicleResponse = z.infer<typeof zRegisterVehicleResponse>;
