import Link from 'next/link';

const surfaces = [
  { href: '/report', title: 'Reportar emergencia', description: 'Entrada ciudadana de incidentes.' },
  { href: '/responder', title: 'Unidad de respuesta', description: 'Vista móvil para tripulaciones.' },
  { href: '/command', title: 'Centro de comando', description: 'Operación y cobertura de Cartagena.' },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16">
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-dispatch-green">Cartagena · operación local</p>
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">Despacho coordinado de ambulancias</h1>
      <p className="mt-5 max-w-2xl text-lg text-slate-600">Una superficie compartida para reportar, responder y coordinar recursos sin depender de servicios cloud.</p>
      <nav className="mt-10 grid gap-4 md:grid-cols-3" aria-label="Superficies de la plataforma">
        {surfaces.map((surface) => (
          <Link key={surface.href} href={surface.href} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md">
            <span className="text-lg font-semibold">{surface.title}</span>
            <span className="mt-2 block text-sm leading-6 text-slate-600">{surface.description}</span>
          </Link>
        ))}
      </nav>
    </main>
  );
}
