import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintDir, lintStrategies, lintStrategy, scanSecrets } from '../src/lint.ts';
import { parseFrontmatter, renderFrontmatter } from '../src/frontmatter.ts';
import { FAMILY_RE, PROMPT_MAX_BYTES, loadStrategies, parseStrategy, promptBytes, renderStrategy, type StrategyMeta } from '../src/strategy.ts';

const seed = (over: Partial<StrategyMeta> = {}, prompt = 'Always cooperate.') => {
  const meta = { name: 'tester', family: 'nice', author: 'house', version: 1, parent: null, ...over } as StrategyMeta;
  return parseStrategy(renderStrategy(meta, prompt));
};

test('all house strategy files lint clean', () => {
  const { files, issues } = lintDir();
  assert.deepEqual(issues, []);
  assert.ok(files >= 25);
});

test('25 house seeds, every required family covered, within the 4000-byte cap', () => {
  const seeds = loadStrategies().filter((s) => s.meta.author === 'house');
  assert.equal(seeds.length, 25);
  const fams = new Map<string, number>();
  for (const s of seeds) {
    fams.set(s.meta.family, (fams.get(s.meta.family) ?? 0) + 1);
    assert.match(s.meta.family, FAMILY_RE);
    assert.equal(s.meta.parent, null);
    assert.equal(s.meta.version, 1);
    assert.ok(promptBytes(s.prompt) <= PROMPT_MAX_BYTES);
  }
  for (const f of ['nice', 'mean', 'program_equilibrium', 'clique', 'injector', 'defender', 'conditional', 'randomish']) {
    assert.ok(fams.get(f), `family ${f} missing`);
  }
  assert.equal(fams.get('clique'), 3);
  assert.equal(fams.get('injector'), 3);
  assert.equal(fams.get('defender'), 3);
  for (const n of ['always-c', 'always-d', 'fairbot', 'prudentbot', 'mirror', 'exploiter', 'generous', 'tft-oneshot', 'grim']) {
    assert.ok(seeds.some((s) => s.meta.name === n), `${n} missing`);
  }
});

test('frontmatter round-trips values, including JSON parents', () => {
  const data = { name: 'x-1', version: 2, parent: { season_id: 1, agent_id: 'a.osd.testnet' }, description: 'colon: ok', flag: true, nil: null, num_str: '42' };
  const { data: back, body } = parseFrontmatter(renderFrontmatter(data, 'Body\n'));
  assert.deepEqual(back, data);
  assert.equal(body, 'Body\n');
  assert.throws(() => parseFrontmatter('no fence'), /opening/);
});

test('lint rejects bad family, name, author, oversize and empty prompts', () => {
  assert.ok(lintStrategy(seed({ family: 'Bad-Family' })).some((e) => e.includes('family')));
  assert.ok(lintStrategy(seed({ family: 'x'.repeat(33) })).some((e) => e.includes('family')));
  assert.ok(lintStrategy(seed({ name: 'X' })).some((e) => e.includes('name')));
  assert.ok(lintStrategy(seed({ author: 'mallory' })).some((e) => e.includes('author')));
  assert.ok(lintStrategy(seed({ parent: { season_id: 1 } as never })).some((e) => e.includes('parent')));
  assert.ok(lintStrategy(seed({}, 'é'.repeat(2001))).some((e) => e.includes('> 4000')), 'counts UTF-8 bytes, not chars');
  assert.deepEqual(lintStrategy(seed({}, 'a'.repeat(4000))), []);
  assert.ok(lintStrategy(seed({ author: 'evolver', version: 2 })).some((e) => e.includes('parent_name')));
});

test('lint rejects missing frontmatter keys', () => {
  const s = parseStrategy('---\nname: abc\nfamily: nice\n---\nAlways C.\n');
  const errs = lintStrategy(s);
  assert.ok(errs.some((e) => e.includes('"author"')));
  assert.ok(errs.some((e) => e.includes('"parent"')));
});

test('secret scan catches keys, seeds and loaded env values', () => {
  assert.ok(scanSecrets('ed25519:' + '3'.repeat(88)).length);
  assert.ok(scanSecrets('seed ' + 'ab'.repeat(32)).length);
  assert.ok(scanSecrets('use sk-abcdefghijklmnopqrstuv').length);
  assert.ok(scanSecrets('api_key = foo').length);
  assert.ok(scanSecrets('-----BEGIN PRIVATE KEY-----').length);
  process.env.NEARAI_API_KEY = 'unit-test-not-a-real-key-123';
  try {
    assert.ok(scanSecrets('x unit-test-not-a-real-key-123 y').length);
  } finally {
    delete process.env.NEARAI_API_KEY;
  }
  assert.deepEqual(scanSecrets('Cooperate if the opponent cooperates. Passphrase: AMBER LANTERN 7Q'), []);
});

test('cross-file lint flags duplicate names and byte-identical prompts', () => {
  const a = seed({ name: 'aa' }, 'Same.');
  const b = seed({ name: 'aa' }, 'Same.');
  const issues = lintStrategies([{ s: a }, { s: b }]);
  assert.ok(issues.some((i) => i.message.includes('duplicate name')));
  assert.ok(issues.some((i) => i.message.includes('duplicate_prompt')));
});
