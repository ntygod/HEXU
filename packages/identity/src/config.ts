import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityOptions } from './index.js';

/** Local operator files only; no shared password and no secret printed to logs. */
export function localIdentityOptions(directory: string, port: number): IdentityOptions {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const value = (name: string, override: string | undefined) => {
    if (override) return override;
    const path = join(directory, name);
    try {
      writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    chmodSync(path, 0o600);
    return readFileSync(path, 'utf8').trim();
  };
  return {
    databasePath: join(directory, 'identity.sqlite'),
    secret: value('auth-secret', process.env.HEXU_AUTH_SECRET),
    setupCode: value('setup-code', process.env.HEXU_SETUP_CODE),
    baseURL: `http://127.0.0.1:${port}`,
    trustedOrigins: [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ],
  };
}
