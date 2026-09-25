import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const processes = [];
let stopping = false;
function start(args) {
  const child = spawn(process.execPath,args,{stdio:'inherit',env:process.env}); processes.push(child);
  child.on('error',error => { console.error(error); stop(1); });
  child.on('exit',code => { if (!stopping) stop(code ?? 1); });
}
function stop(code = 0) { if (stopping) return; stopping = true; process.exitCode = code; for (const child of processes) child.kill('SIGTERM'); }
start([resolve('node_modules/typescript/bin/tsc'),'-p','tsconfig.server.json','--watch','--preserveWatchOutput']);
start(['--env-file-if-exists=.env','--watch','dist/apps/control/src/main.js']);
start([resolve('node_modules/vite/bin/vite.js'),'--config','apps/web/vite.config.ts']);
process.on('SIGINT',() => stop()); process.on('SIGTERM',() => stop());
