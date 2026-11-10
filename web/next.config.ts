import path from 'node:path';
import type { NextConfig } from 'next';

// The web app reads the frozen fixtures from ../interfaces, so the workspace root is the repo root.
const repoRoot = path.join(import.meta.dirname, '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default nextConfig;
