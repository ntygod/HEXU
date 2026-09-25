import {rmSync} from 'node:fs';
import {resolve} from 'node:path';
// Only this fixed, disposable fixture directory is cleared; never the user's preview data.
const path=resolve('.hexu/e2e');rmSync(path,{recursive:true,force:true});
process.env.HEXU_DATA_DIR=path;process.env.HEXU_HOST='127.0.0.1';process.env.HEXU_PORT='4310';
await import('../dist/apps/control/src/main.js');
