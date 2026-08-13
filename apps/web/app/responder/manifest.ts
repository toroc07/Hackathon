import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Responder · Despacho Cartagena',
    short_name: 'Responder',
    description: 'Operación móvil de unidades prehospitalarias',
    start_url: '/responder',
    scope: '/responder',
    display: 'standalone',
    background_color: '#07151f',
    theme_color: '#07151f',
    orientation: 'portrait',
  };
}
