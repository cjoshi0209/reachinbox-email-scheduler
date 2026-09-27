import path from 'node:path';
import type { NextConfig } from 'next';

const backend = process.env.BACKEND_URL ?? 'http://localhost:4000';

/**
 * The browser only talks to this origin; /api and /auth are proxied to the Express API.
 * That keeps the session cookie first-party and avoids CORS in the browser.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  outputFileTracingRoot: path.join(__dirname),
  images: { remotePatterns: [{ protocol: 'https', hostname: 'lh3.googleusercontent.com' }] },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/auth/:path*', destination: `${backend}/auth/:path*` },
    ];
  },
};

export default nextConfig;
