import { redirect } from 'next/navigation';

/** Compatibilidad con enlaces antiguos: el reporte ahora vive en la raiz. */
export default function LegacyReportPage() {
  redirect('/');
}
