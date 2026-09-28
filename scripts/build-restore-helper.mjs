import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// No runtime compiler/download fallback. Non-Linux clients retain the explicit
// unsupported response; source builds on Linux need a local C compiler + libc headers.
if (process.platform === 'linux') {
  const source = fileURLToPath(
    new URL('../apps/runner/src/native/restore-publish.c', import.meta.url),
  );
  const output = fileURLToPath(
    new URL('../dist/apps/runner/src/native/restore-publish', import.meta.url),
  );
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    execFileSync(
      'cc',
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-D_FORTIFY_SOURCE=2',
        '-fstack-protector-strong',
        source,
        '-o',
        temporary,
      ],
      { stdio: 'inherit' },
    );
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
}
