import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, chmodSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
// Read-only consistent SQLite backup; never overwrites or restores an active database.
const [source, destination] = process.argv.slice(2);
if (!source || !destination || process.argv.length !== 4)
  throw new Error('Usage: node scripts/backup-collaboration.mjs SOURCE NEW_BACKUP');
const target = resolve(destination);
if (resolve(source) === target || existsSync(target))
  throw new Error('Backup destination must be new');
process.umask(0o077);
const db = new DatabaseSync(resolve(source), { readOnly: true });
try {
  if (db.prepare("SELECT value FROM metadata WHERE key='data_mode'").get()?.value !== 'team')
    throw new Error('Only an existing team database can be backed up');
  // Reserve exclusively before SQLite opens it; never replace an existing path.
  closeSync(openSync(target, 'wx', 0o600));
  await backup(db, target);
  chmodSync(target, 0o600);
  console.log(
    'Consistent team database backup completed. Preserve the event encryption key separately.',
  );
} finally {
  db.close();
}
