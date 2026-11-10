// Lint step: shellcheck every ops/scripts/*.sh. Required in CI; skipped locally if shellcheck is missing.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.sh')).map((f) => join(dir, f));
try {
  execFileSync('shellcheck', ['--version'], { stdio: 'ignore' });
} catch {
  if (process.env.CI) {
    console.error('shellcheck not installed (required in CI)');
    process.exit(1);
  }
  console.error('shellcheck not installed; skipped (brew install shellcheck)');
  process.exit(0);
}
execFileSync('shellcheck', ['-x', '-S', 'style', ...files], { stdio: 'inherit', cwd: dir });
console.log(`shellcheck ok: ${files.length} script(s)`);
