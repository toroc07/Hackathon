import type { Metadata } from 'next';
import { ReportClient } from './report/ReportClient';

export const metadata: Metadata = {
  title: 'Emergencia · Despacho Cartagena',
  description: 'Reporta una emergencia con tu voz y sigue la ayuda en tiempo real.',
};

/** La raiz es la app ciudadana. No expone superficies internas de operacion. */
export default function HomePage() {
  return <ReportClient />;
}
