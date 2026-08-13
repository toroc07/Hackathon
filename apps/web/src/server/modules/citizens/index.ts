/**
 * Registro/login de ciudadano — sin contraseña (§33, ver accounts.ts).
 *
 * Un teléfono o correo ya registrado simplemente reingresa a esa cuenta y
 * actualiza nombre/teléfono si cambiaron: no hay "ya existe" como error,
 * porque no hay nada que proteger con una contraseña. El dato que de verdad
 * importa es el teléfono — es lo que le llega al responder para poder llamar.
 */

import type { CitizenRegisterRequest, CitizenSession } from '@dispatch/contracts';
import { db, newId, tx, type Queryable } from '@/src/server/infra/db';

interface CitizenRow {
  id: string;
  name: string;
  email: string;
  phone: string;
}

function toSession(row: CitizenRow): CitizenSession {
  return { id: row.id, name: row.name, email: row.email, phone: row.phone };
}

export async function registerCitizen(input: CitizenRegisterRequest): Promise<CitizenSession> {
  const now = Date.now();
  return tx(async (t: Queryable) => {
    const existing = await t.one<CitizenRow>(
      'SELECT id, name, email, phone FROM citizens WHERE lower(email) = lower(?) OR phone = ?',
      [input.email, input.phone],
    );
    if (existing) {
      await t.run('UPDATE citizens SET name = ?, email = ?, phone = ? WHERE id = ?', [input.name, input.email, input.phone, existing.id]);
      return { id: existing.id, name: input.name, email: input.email, phone: input.phone };
    }
    const id = newId(now);
    await t.run('INSERT INTO citizens (id, name, email, phone, created_at) VALUES (?, ?, ?, ?, ?)', [id, input.name, input.email, input.phone, now]);
    return { id, name: input.name, email: input.email, phone: input.phone };
  });
}

export async function findCitizen(id: string, q: Queryable = db()): Promise<CitizenSession | null> {
  const row = await q.one<CitizenRow>('SELECT id, name, email, phone FROM citizens WHERE id = ?', [id]);
  return row ? toSession(row) : null;
}
