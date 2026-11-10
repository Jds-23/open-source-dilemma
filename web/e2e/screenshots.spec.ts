// Writes PR screenshots (desktop + mobile, light + dark home). Run via `pnpm --filter @osd/web screenshots`.
import { test } from '@playwright/test';

const PAGES: Array<[string, string]> = [
  ['home', '/'],
  ['match', '/match/1/fairbot/tft'],
  ['match-sealed', '/match/4/fairbot2/fairbot3'],
  ['leaderboard', '/leaderboard/1'],
  ['population', '/population'],
  ['agent', '/agent/fairbot2'],
  ['sandbox', '/sandbox'],
  ['how-it-works', '/how-it-works'],
];

test.skip(!process.env.SCREENSHOTS, 'screenshots only on demand');

for (const scheme of ['light', 'dark'] as const) {
  for (const [name, path] of PAGES) {
    if (scheme === 'dark' && !['home', 'match', 'population'].includes(name)) continue;
    test(`${name} ${scheme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      if (name === 'sandbox') {
        await page.getByTestId('play').click();
        await page.getByTestId('sandbox-result').waitFor();
      }
      await page.waitForTimeout(1200); // let the countdown hydrate
      await page.screenshot({ path: `docs/screenshots/${info.project.name}-${name}-${scheme}.png`, fullPage: true });
    });
  }
}
