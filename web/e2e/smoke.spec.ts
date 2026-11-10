import { expect, test } from '@playwright/test';

test.describe('fixture-mode smoke', () => {
  test('home: hero, season status, live feed', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText("AI agents play the prisoner's dilemma");
    await expect(page.getByTestId('mode-banner')).toBeVisible();
    await expect(page.getByTestId('season-card')).toContainText('Season 4');
    await expect(page.getByTestId('countdown')).toBeVisible();
    await expect(page.getByTestId('feed-item').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('no horizontal scroll on any page', async ({ page }) => {
    for (const path of ['/', '/matches', '/match/1/fairbot/tft', '/leaderboard', '/population', '/agent/fairbot2', '/sandbox', '/how-it-works']) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
    }
  });

  test('match replay (settled season): revealed + verified prompts, sig flags, proof links', async ({ page }) => {
    await page.goto('/match/1/fairbot/tft');
    await expect(page.getByTestId('player-a')).toContainText('fairbot');
    await expect(page.getByTestId('prompt-revealed')).toHaveCount(2);
    await expect(page.getByTestId('player-a')).toContainText('commitment ✓');
    await expect(page.getByTestId('sig-a')).toHaveText('verified on chain');
    await expect(page.getByTestId('outcome')).toContainText('3–3');
    await expect(page.getByTestId('attestation-link')).toBeVisible();
    await expect(page.getByTestId('explorer-link')).toBeVisible();
  });

  test('match replay (season in play): prompts sealed', async ({ page }) => {
    await page.goto('/matches');
    await page.locator('#s4 ~ ul [data-testid=feed-item] a, section:has(#s4) [data-testid=feed-item] a').first().click();
    await expect(page).toHaveURL(/\/match\/4\//);
    await expect(page.getByTestId('prompt-sealed')).toHaveCount(2);
    await expect(page.getByTestId('prompt-revealed')).toHaveCount(0);
  });

  test('void match shows refund', async ({ page }) => {
    await page.goto('/match/1/fairbot/injector');
    await expect(page.getByTestId('outcome')).toContainText('llm_status_503');
  });

  test('leaderboard ranks by avg payoff with family tags', async ({ page }) => {
    await page.goto('/leaderboard/1');
    const rows = page.getByTestId('leaderboard').locator('tbody tr');
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText('injector');
    await expect(rows.first()).toContainText('3.00');
    await expect(page.getByText('alice.testnet runs more than one agent')).toBeVisible();
  });

  test('population chart renders every season', async ({ page }) => {
    await page.goto('/population');
    const chart = page.getByTestId('population-chart');
    await expect(chart).toBeVisible();
    for (const s of ['S1', 'S2', 'S3', 'S4*']) await expect(chart.locator('text', { hasText: s }).first()).toBeAttached();
  });

  test('agent page: lineage tree reaches ancestors and descendants', async ({ page }) => {
    await page.goto('/agent/fairbot2');
    const tree = page.getByTestId('lineage-tree');
    await expect(tree).toContainText('fairbot'); // root S1 fairbot
    await expect(tree).toContainText('fairbot3');
    await expect(tree).toContainText('prudent');
  });

  test('sandbox: mock referee when no NEAR AI key, labeled not proven', async ({ page }) => {
    await page.goto('/sandbox');
    await expect(page.getByTestId('practice-banner')).toContainText('Off-chain practice, not proven');
    await page.getByTestId('play').click();
    await expect(page.getByTestId('sandbox-result')).toBeVisible();
    await expect(page.getByTestId('sandbox-mode')).toContainText('mock referee');
    await expect(page.getByTestId('sandbox-mode')).toContainText('not proven');
  });

  test('sandbox API rejects oversize prompts', async ({ request }) => {
    const r = await request.post('/api/sandbox', { data: { a: 'x'.repeat(4001), b: 'ok' } });
    expect(r.status()).toBe(400);
  });

  test('how it works states the OutLayer operator caveat', async ({ page }) => {
    await page.goto('/how-it-works');
    await expect(page.getByTestId('operator-caveat')).toContainText('worker.outlayer.testnet');
  });

  test('theme toggle switches to dark', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Change theme/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
