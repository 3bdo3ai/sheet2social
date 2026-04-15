import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Language',
            value: 'ar',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
