'use client';

import type { CitizenRegisterResponse } from '@dispatch/contracts';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertIcon } from '@/src/components/ui/icons';
import { Button } from '@/src/components/ui';

export function LoginClient() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      const response = await fetch('/api/citizens/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? 'No pudimos registrarte. Revisa los datos.');
      }
      await response.json() as CitizenRegisterResponse;
      router.push('/');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No pudimos registrarte');
      setSending(false);
    }
  };

  return (
    <main className="app-light mobile-app-shell safe-x flex flex-col justify-center">
      <header className="pb-6">
        <p className="text-xs font-bold uppercase tracking-[.16em] text-emergency">Emergencias Cartagena</p>
        <h1 className="mt-2 text-3xl font-bold leading-tight">Antes de reportar</h1>
        <p className="mt-2 text-content-secondary text-[15px] leading-relaxed">
          Dejanos tu contacto. Si tu reporte no da suficiente información, la ambulancia te llama directo a este teléfono.
        </p>
      </header>

      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Nombre completo">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            className="mt-2 w-full rounded-xl border border-edge-strong bg-surface-base px-4 py-3 text-[16px] text-content"
            placeholder="Ej. María Torres"
          />
        </Field>
        <Field label="Correo">
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className="mt-2 w-full rounded-xl border border-edge-strong bg-surface-base px-4 py-3 text-[16px] text-content"
            placeholder="tu@correo.com"
          />
        </Field>
        <Field label="Teléfono">
          <input
            required
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            className="mt-2 w-full rounded-xl border border-edge-strong bg-surface-base px-4 py-3 text-[16px] text-content"
            placeholder="+57 300 000 0000"
          />
        </Field>

        {error && (
          <p role="alert" className="flex items-start gap-2 text-emergency text-sm">
            <AlertIcon size={18} /> <span>{error}</span>
          </p>
        )}

        <Button type="submit" disabled={sending} aria-busy={sending} className="mt-2 min-h-touch-lg w-full text-[17px]">
          {sending ? 'Ingresando…' : 'Continuar'}
        </Button>
      </form>

      <p className="mt-6 text-center text-xs text-content-muted">
        No es una cuenta con contraseña — solo tu contacto para que la ambulancia pueda ubicarte.
      </p>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-semibold text-content-secondary">
      {label}
      {children}
    </label>
  );
}
