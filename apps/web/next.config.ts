import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 'standalone' sigue sirviendo para Docker/Railway; Vercel lo ignora.
  output: 'standalone',
  // `pg` es un paquete de Node (usa net/tls): no debe pasar por el bundler.
  serverExternalPackages: ['pg'],
  transpilePackages: ['@dispatch/contracts', '@dispatch/db'],
};

export default nextConfig;
