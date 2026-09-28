/** Guard: feature CSS must consume tokens instead of hard-coding palette colors or font sizes.
 *  Raw values are allowed only in packages/ui/src/tokens.css. Escape hatch per line:
 *  add a trailing `/* hx-token-ok *\/` comment explaining why the value cannot be a token. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['apps/web/src', 'packages/ui/src'];
const SKIP = new Set(['tokens.css']);
const PATTERNS = [
  { re: /#[0-9a-fA-F]{3,8}\b/, label: 'raw hex color' },
  { re: /\b(?:font-size|line-height)\s*:\s*[\d.]+px\b/, label: 'raw px font metric' },
];
let failures = 0;
for (const root of roots) {
  for (const file of readdirSync(root)) {
    if (!file.endsWith('.css') || SKIP.has(file)) continue;
    const path = join(root, file);
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (line.includes('hx-token-ok')) return;
        for (const { re, label } of PATTERNS) {
          if (re.test(line)) {
            console.error(`${path}:${index + 1}  ${label}: ${line.trim()}`);
            failures += 1;
          }
        }
      });
  }
}
if (failures) {
  console.error(
    `\n${failures} UI token violation(s). Use var(--hx-*) values from packages/ui/src/tokens.css instead.`,
  );
  process.exit(1);
}
console.log('UI token check passed.');