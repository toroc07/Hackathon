import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 'standalone' sigue sirviendo para Docker/Railway; Vercel lo ignora.
  output: 'standalone',
  // `pg` es un paquete de Node (usa net/tls): no debe pasar por el bundler.
  serverExternalPackages: ['pg'],
  transpilePackages: ['@dispatch/contracts', '@dispatch/db'],
  webpack: (config) => {
    // Los paquetes internos son ESM y sus imports relativos llevan extension
    // `.js` (obligatorio en ESM), pero los archivos en disco son `.ts`.
    // Sin este alias webpack busca literalmente `geo.js` y falla el build.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
