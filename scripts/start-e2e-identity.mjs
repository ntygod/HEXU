import { join, resolve } from 'node:path';
import { createApp } from '../dist/apps/control/src/app.js';

// Called only by start-e2e.mjs after it prepares the fixed disposable directory.
const fixtures = {
  team: {
    port: 4311,
    secret: 'fictional-browser-auth-secret-not-real-0123456789',
    setupCode: 'fictional-browser-setup-code-not-real-0123456789',
  },
  node: {
    port: 4312,
    secret: 'fictional-node-browser-auth-secret-0123456789',
    setupCode: 'fictional-node-browser-setup-code-0123456789',
  },
};
const name = process.argv[2];
if (!process.send || !Object.hasOwn(fixtures, name) || process.argv.length !== 3)
  throw new Error('Identity fixture requires the e2e parent and a fixed fixture name');
const fixture = fixtures[name];
const directory = resolve('.hexu/e2e');
const origin = `http://127.0.0.1:${fixture.port}`;
const app = await createApp({
  port: fixture.port,
  databasePath: join(directory, `${name}-workspace.sqlite`),
  identity: {
    databasePath: join(directory, `${name}-identity.sqlite`),
    secret: fixture.secret,
    setupCode: fixture.setupCode,
    baseURL: origin,
    trustedOrigins: [origin],
  },
});
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 5000);
  timeout.unref();
  void app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
for (const event of ['SIGINT', 'SIGTERM', 'disconnect']) process.once(event, close);
await app.listen({ host: '127.0.0.1', port: fixture.port });
process.send({ ready: name });
