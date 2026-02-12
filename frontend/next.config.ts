import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Proxy /api/* to Express backend — avoids CORS in dev,
  // same origin so httpOnly cookies work seamlessly
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
