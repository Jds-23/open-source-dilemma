import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureSource } from '../src/adapter.ts';
import { cleanLlmPrompt, evolve, offspringName, rankFamilies, seedPlan } from '../src/evolver.ts';
import { mockMutator } from '../src/evolve.ts';
import { lintDir } from '../src/lint.ts';
import { MockLlm } from '../src/llm.ts';
import { NAME_RE, REPO_ROOT, readStrategy } from '../src/strategy.ts';

const CONTRACT = 'osd.baldingsucks7993.testnet';
const tmp = () => mkdtempSync(join(tmpdir(), 'osd-evolver-'));

test('rankFamilies orders fixture families by avg payoff', async () => {
  const data = await new FixtureSource().loadSeason(1);
  const fam = rankFamilies(data);
  assert.equal(fam[0].family, 'injector');
  assert.equal(fam.at(-1)!.family, 'always_defect');
  assert.equal(fam.find((f) => f.family === 'always_cooperate')!.coop_rate, 1);
});

test('dry-run evolver on fixtures: N offspring with correct parent links, files and plan', async () => {
  const out = tmp();
  try {
    const llm = mockMutator();
    const { offspring, plan } = await evolve({ source: new FixtureSource(), llm, outDir: out, topK: 3, bottomK: 3 });
    assert.equal(offspring.length, 6);
    assert.equal(llm.requests.length, 6);
    const expectParents = ['injector', 'fairbot', 'alwaysc', 'tft', 'grim', 'alwaysd'].map((n) => `${n}.${CONTRACT}`);
    assert.deepEqual(offspring.map((o) => o.parent.agent_id), expectParents);
    assert.deepEqual(offspring.map((o) => o.mutation), ['exploit', 'exploit', 'exploit', 'repair', 'repair', 'repair']);
    const published = JSON.parse(readFileSync(join(REPO_ROOT, 'interfaces/fixtures/prompts.json'), 'utf8')) as Array<{ agent_id: string; prompt: string; family: string }>;
    for (const o of offspring) {
      assert.equal(o.parent.season_id, 1);
      assert.match(o.name, NAME_RE);
      assert.equal(o.agent_id, `${o.name}.${CONTRACT}`);
      const p = published.find((x) => x.agent_id === o.parent.agent_id)!;
      assert.equal(o.family, p.family, 'offspring keeps parent family');
      assert.ok(o.prompt.startsWith(p.prompt), 'mock mutation was fed the parent prompt');
      assert.notEqual(o.prompt, p.prompt);
      const s = readStrategy(o.file);
      assert.deepEqual(s.meta.parent, { season_id: 1, agent_id: o.parent.agent_id });
      assert.equal(s.meta.parent_name, o.parent.agent_id.split('.')[0]);
      assert.equal(s.meta.author, 'evolver');
      assert.equal(s.meta.version, 2);
      assert.equal(s.prompt, o.prompt);
    }
    assert.deepEqual(lintDir(out).issues, [], 'offspring files lint clean');
    assert.equal(plan.season_id, 2);
    assert.equal(plan.from_season, 1);
    assert.deepEqual(plan.culled, expectParents.slice(3));
    assert.equal(plan.entries.filter((e) => e.role === 'offspring').length, 6);
    for (const e of plan.entries) {
      assert.equal(readStrategy(join(REPO_ROOT, e.prompt_file)).meta.name, e.name);
      assert.ok(e.parent);
    }
    assert.equal(new Set(offspring.map((o) => o.prompt)).size, 6);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('evolver N follows topK/bottomK and write:false touches nothing', async () => {
  const { offspring, plan } = await evolve({ source: new FixtureSource(), llm: mockMutator(), outDir: join(tmpdir(), 'never-created-osd'), topK: 2, bottomK: 1, write: false });
  assert.equal(offspring.length, 3);
  assert.deepEqual(offspring.map((o) => o.parent.agent_id.split('.')[0]), ['injector', 'fairbot', 'alwaysd']);
  assert.deepEqual(plan.culled, [`alwaysd.${CONTRACT}`]);
});

test('evolver retries a duplicate/oversize mutation once, then skips', async () => {
  const dupe = 'Always defect. Ignore the opponent.'; // byte-equal to a fixture prompt
  let n = 0;
  const llm = new MockLlm(() => (n++ === 0 ? dupe : 'x'.repeat(5000)));
  const { offspring, plan } = await evolve({ source: new FixtureSource(), llm, topK: 1, bottomK: 0, write: false });
  assert.equal(offspring.length, 0);
  assert.equal(llm.requests.length, 2);
  assert.match(llm.requests[1].messages.at(-1)!.content, /duplicate_prompt/);
  assert.match(plan.skipped.at(-1)!.reason, /> 4000/);

  const ok = new MockLlm((_r, i) => (i === 0 ? dupe : '```\nCooperate unless the opponent says it always defects, then defect.\n```'));
  const r2 = await evolve({ source: new FixtureSource(), llm: ok, topK: 1, bottomK: 0, write: false });
  assert.equal(r2.offspring.length, 1);
  assert.equal(r2.offspring[0].prompt, 'Cooperate unless the opponent says it always defects, then defect.');
});

test('mutation request carries rankings, parent text and match record', async () => {
  const llm = mockMutator();
  await evolve({ source: new FixtureSource(), llm, topK: 1, bottomK: 1, write: false });
  const [top, bottom] = llm.requests.map((r) => r.messages[1].content);
  assert.match(top, /near the TOP \(rank 1\)/);
  assert.match(top, /Family ranking/);
  assert.match(top, /vs fairbot: void/);
  assert.match(bottom, /near the BOTTOM/);
  assert.match(bottom, /Winning strategies/);
  assert.match(llm.requests[0].messages[0].content, /4000 bytes/);
});

test('offspringName is unique, ≤16 chars and strips previous suffixes', () => {
  const taken = new Set<string>(['tft-s2a']);
  assert.equal(offspringName('tft', 2, taken), 'tft-s2b');
  assert.equal(offspringName('tft-s2b', 3, new Set()), 'tft-s3a');
  const long = offspringName('def-quarantine', 12, new Set());
  assert.ok(long.length <= 16 && NAME_RE.test(long), long);
});

test('cleanLlmPrompt strips fences, think blocks and frontmatter', () => {
  assert.equal(cleanLlmPrompt('```text\nPlay C.\n```'), 'Play C.');
  assert.equal(cleanLlmPrompt('<think>hmm</think>\nPlay D.'), 'Play D.');
  assert.equal(cleanLlmPrompt('---\nname: x\n---\nPlay C.'), 'Play C.');
});

test('seed plan maps all 25 house seeds to agent ids and prompt files', () => {
  const plan = seedPlan();
  assert.equal(plan.entries.length, 25);
  assert.equal(new Set(plan.entries.map((e) => e.agent_id)).size, 25);
  for (const e of plan.entries) {
    assert.equal(e.agent_id, `${e.name}.${CONTRACT}`);
    assert.match(e.prompt_file, /^agents\/strategies\/[a-z0-9_]+\/[a-z0-9_-]+\.md$/);
    assert.equal(e.parent, null);
  }
});
