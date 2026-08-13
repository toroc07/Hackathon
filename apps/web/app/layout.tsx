import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Despacho Cartagena',
  description: 'Coordinación local de respuesta prehospitalaria',
  // Se instala en la pantalla de inicio y abre a pantalla completa: en una
  // emergencia nadie quiere buscar una pestaña del navegador.
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Emergencias' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // NO se limita maximumScale ni se pone userScalable:false. Bloquear el zoom
  // es una barrera de accesibilidad seria, y aquí puede usarla alguien con baja
  // visión que necesita ampliar para leer un ETA.
  themeColor: '#070b14',
  // El contenido llega hasta los bordes; las safe-areas se manejan en CSS.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
