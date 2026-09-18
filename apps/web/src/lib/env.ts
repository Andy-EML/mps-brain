import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
 * The monorepo keeps a single `.env` at the repo root (the worker reads it through
 * `tsx --env-file`). Next only looks inside the app directory, and `node --env-file` can't be
 * used because Next re-execs itself through NODE_OPTIONS, which rejects that flag.
 *
 * So in development the root file is parsed here and used as a fallback. `process.env` is
 * deliberately left alone: Next reloads its own env on every config change and would wipe
 * anything we injected. In production there is no `.env` — the container supplies everything.
 */
let fallback: Record<string, string | undefined> | null = null;

function rootEnv(): Record<string, string | undefined> {
  if (fallback) return fallback;
  fallback = {};
  if (process.env.NODE_ENV === 'production') return fallback;

  const cwd = process.cwd();
  for (const dir of [cwd, path.resolve(cwd, '..', '..')]) {
    const file = path.join(dir, '.env');
    if (existsSync(file)) {
      fallback = parseEnv(readFileSync(file, 'utf8'));
      break;
    }
  }
  return fallback;
}

/** Reads a required server-side variable. Never log the result. */
export function requiredEnv(name: string): string {
  const value = process.env[name] || rootEnv()[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
