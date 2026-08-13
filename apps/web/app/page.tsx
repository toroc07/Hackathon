import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CITIZEN_SESSION_COOKIE, verifyCitizenSession } from '@/src/server/infra/citizenSession';
import { ReportClient } from './report/ReportClient';

export const metadata: Metadata = {
  title: 'Emergencia · Despacho Cartagena',
  description: 'Reporta una emergencia con tu voz y sigue la ayuda en tiempo real.',
};

/** La raiz es la app ciudadana. No expone superficies internas de operacion. */
export default async function HomePage() {
  const store = await cookies();
  const citizen = verifyCitizenSession(store.get(CITIZEN_SESSION_COOKIE)?.value);
  if (!citizen) redirect('/login');
  return <ReportClient citizenPhone={citizen.phone} />;
}
