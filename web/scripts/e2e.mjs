// Build (fixture mode) → ensure Chromium → Playwright smoke. `--screenshots` also writes docs/screenshots/*.png.
import { spawnSync } from 'node:child_process';

const env = { ...process.env, NEXT_PUBLIC_CONTRACT_ID: '', NEARAI_API_KEY: '' };
const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...env, ...extra } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('next', ['build']);
// On CI (Linux) also pull the OS libraries Chromium needs; locally just the browser (no-op if cached).
run('playwright', ['install', ...(process.env.CI ? ['--with-deps'] : []), 'chromium']);
const shots = process.argv.includes('--screenshots');
run('playwright', ['test', ...(shots ? ['e2e/screenshots.spec.ts'] : ['e2e/smoke.spec.ts'])], shots ? { SCREENSHOTS: '1' } : {});
