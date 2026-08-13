import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  transpilePackages: ['@dispatch/contracts', '@dispatch/db'],
};

export default nextConfig;
