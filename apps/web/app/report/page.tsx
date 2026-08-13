import type { Metadata } from 'next';
import { ReportClient } from './ReportClient';

export const metadata: Metadata = {
  title: 'Reportar emergencia',
  description: 'Describe la emergencia con tu voz. Sin registro.',
};

export default function ReportPage() {
  return <ReportClient />;
}
