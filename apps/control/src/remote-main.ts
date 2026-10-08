import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../../../packages/db/src/store.js';
import { createRemoteCollaboration } from './remote-collaboration.js';
// Separate opt-in executable; never changes preview/team-local listening policy.
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
function privateFile(name: string) {
  const path = resolve(required(name)),
    stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error(`${name} must be a private regular file (0600)`);
  return readFileSync(path);
}
const databasePath = resolve(required('HEXU_COLLABORATION_DATABASE'));
if (!statSync(databasePath).isFile())
  throw new Error('An existing provisioned team database is required');
const key = privateFile('HEXU_EVENT_KEY_FILE');
if (key.length !== 32) throw new Error('HEXU_EVENT_KEY_FILE must contain exactly 32 raw bytes');
const store = new Store(databasePath, undefined, { team: true });
const { app } = await createRemoteCollaboration({
  store,
  publicOrigin: required('HEXU_COLLABORATION_ORIGIN'),
  encryptionKey: key,
  tls: {
    key: privateFile('HEXU_TLS_KEY_FILE'),
    cert: readFileSync(resolve(required('HEXU_TLS_CERT_FILE'))),
  },
});
const port = Number(process.env.HEXU_COLLABORATION_PORT ?? 8443);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid collaboration port');
app.addHook('onClose', async () => store.close());
await app.listen({ host: process.env.HEXU_COLLABORATION_HOST ?? '127.0.0.1', port });
console.log(
  'HEXU limited collaboration listener started; no host execution or public identity setup.',
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
