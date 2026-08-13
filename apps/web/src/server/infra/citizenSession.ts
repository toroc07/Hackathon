/**
 * Sesión del ciudadano — cookie firmada, mismo patrón HMAC que session.ts
 * (staff), pero deliberadamente separada: es otro concepto (identidad de
 * quien reporta, no rol operativo) y no tiene contraseña — ver accounts.ts.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CitizenSession } from '@dispatch/contracts';

export const CITIZEN_SESSION_COOKIE = 'dispatch_citizen';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 días: no tiene sentido volver a pedir el registro cada día

function secret(): string {
  const configured = process.env.SESSION_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET es obligatorio en producción');
  return 'dispatch-cartagena-local-demo-secret';
}

function signature(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function signCitizenSession(citizen: CitizenSession): string {
  const payload = Buffer.from(JSON.stringify(citizen), 'utf8').toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifyCitizenSession(token: string | undefined): CitizenSession | null {
  if (!token) return null;
  const [payload, suppliedSignature] = token.split('.');
  if (!payload || !suppliedSignature) return null;
  const expected = Buffer.from(signature(payload));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<CitizenSession>;
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string'
      || typeof parsed.email !== 'string' || typeof parsed.phone !== 'string') return null;
    return { id: parsed.id, name: parsed.name, email: parsed.email, phone: parsed.phone };
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

export function resolveCitizenSession(request: Request): CitizenSession | null {
  return verifyCitizenSession(cookieValue(request, CITIZEN_SESSION_COOKIE));
}

export function citizenSessionCookie(citizen: CitizenSession): string {
  const token = signCitizenSession(citizen);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${CITIZEN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure}`;
}
