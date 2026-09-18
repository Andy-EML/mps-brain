import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  // The dev overlay badge sits bottom-left, exactly on top of the sidebar's signed-in user.
  devIndicators: false,
  // Next otherwise writes its own AGENTS.md/CLAUDE.md into apps/web; the repo has its own.
  agentRules: false,
  // The workspace packages ship raw TypeScript (no build step), so Next has to compile them.
  transpilePackages: ['@mps/db', '@mps/core', '@mps/queue', '@mps/drms', '@mps/vantage'],
  // Native / server-only modules must stay out of the bundle.
  serverExternalPackages: ['@node-rs/argon2', 'pg', 'pg-boss'],
  output: 'standalone',
  // Monorepo: trace from the repo root so the standalone build picks up packages/*.
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
