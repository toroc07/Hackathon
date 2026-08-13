import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'dispatch_session';
export const SESSION_ROLES = ['DISPATCHER', 'RESPONDER', 'ADMIN'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export interface Session {
  role: SessionRole;
  userId: string;
  expiresAt: number;
}

function isRole(value: unknown): value is SessionRole {
  return typeof value === 'string' && SESSION_ROLES.includes(value as SessionRole);
}

function secret(): string {
  const configured = process.env.SESSION_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET es obligatorio en producción');
  return 'dispatch-cartagena-local-demo-secret';
}

function signature(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifySession(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, suppliedSignature] = token.split('.');
  if (!payload || !suppliedSignature) return null;
  const expected = Buffer.from(signature(payload));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Session>;
    if (!isRole(parsed.role) || typeof parsed.userId !== 'string' || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) return null;
    return { role: parsed.role, userId: parsed.userId, expiresAt: parsed.expiresAt };
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

export function demoRoleSelectorEnabled(): boolean {
  return process.env.DEMO_MODE === 'true';
}

/** En demo permite ?role=; fuera de demo sólo acepta la cookie firmada. */
export function resolveSession(request: Request): Session | null {
  if (demoRoleSelectorEnabled()) {
    const role = new URL(request.url).searchParams.get('role');
    if (isRole(role)) return { role, userId: `demo-${role.toLowerCase()}`, expiresAt: Date.now() + 86_400_000 };
  }
  return verifySession(cookieValue(request, SESSION_COOKIE));
}

export function sessionCookie(role: SessionRole, userId: string, maxAgeSeconds = 86_400): string {
  const token = signSession({ role, userId, expiresAt: Date.now() + maxAgeSeconds * 1000 });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
