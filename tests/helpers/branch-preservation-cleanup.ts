import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Release only this fixture's deliberately retained claim, then always stop its server. */
export async function closePreservationFixture(
  fixture: { view: { request: { id: string } }; close(): Promise<void> },
  registry = join(homedir(), '.hexu/workspace-leases/registry.sqlite'),
) {
  try {
    const db = new DatabaseSync(registry);
    try {
      // Other test-file processes share the same registry, as production writers do.
      db.exec('PRAGMA busy_timeout=5000');
      db.prepare('DELETE FROM claims WHERE dispatch_id=?').run(
        'branch-preserve:' + fixture.view.request.id,
      );
    } finally {
      db.close();
    }
  } finally {
    // A cleanup error must fail the test without retaining a listening HTTP server.
    await fixture.close();
  }
}
