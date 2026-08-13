import type { Metadata } from 'next';
import { TrackingClient } from './TrackingClient';

export const metadata: Metadata = {
  title: 'Seguimiento de tu emergencia',
  description: 'Mira dónde viene la ambulancia y cuánto falta.',
};

export const dynamic = 'force-dynamic';

export default async function TrackPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <TrackingClient token={token} />;
}
