import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OSD_EVENT_NAMES, eventsFromOutcome, formatEventLog, isEvent, parseEventLog, parseEventLogs } from '../src/index.js';
import { DEFAULT_FIXTURES_DIR } from '../src/node.js';

const lines = readFileSync(join(DEFAULT_FIXTURES_DIR, 'events.jsonl'), 'utf8').split('\n');

describe('NEP-297 event parser', () => {
  test('parses the fixture stream', () => {
    const evs = parseEventLogs(lines);
    expect(evs).toHaveLength(lines.filter((l) => l.trim()).length);
    const count = (n: string) => evs.filter((e) => e.event === n).length;
    expect(count('agent_registered')).toBe(6);
    expect(count('committed')).toBe(6);
    expect(count('match_played') + count('match_void')).toBe(15);
    expect(count('season_settled')).toBe(1);
    for (const e of evs) expect(OSD_EVENT_NAMES).toContain(e.event);
  });

  test('typed narrowing', () => {
    const evs = parseEventLogs(lines);
    const voids = evs.filter(isEvent('match_void'));
    expect(voids).toHaveLength(1);
    expect(voids[0]!.data.reason).toBe('llm_status_503');
    const settled = evs.find(isEvent('season_settled'))!;
    expect(settled.data.ranking[0]).toMatchObject({ rank: 1, agent_id: 'injector.osd.baldingsucks7993.testnet' });
    const c = evs.find(isEvent('committed'))!;
    expect(c.data.commitment).toMatch(/^[0-9a-f]{64}$/);
  });

  test('ignores non-event logs and other standards', () => {
    expect(parseEventLog('hello')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{}]}')).toBeNull();
    expect(parseEventLog('EVENT_JSON:not json')).toBeNull();
  });

  test('rejects malformed osd events', () => {
    expect(() => parseEventLog('EVENT_JSON:{"standard":"osd","version":"1.0.0","event":"nope","data":[{}]}')).toThrow(/unknown/);
    expect(() => parseEventLog('EVENT_JSON:{"standard":"osd","version":"1.0.0","event":"committed","data":[]}')).toThrow(/1-element/);
    expect(() => parseEventLog('EVENT_JSON:{"standard":"osd",oops')).toThrow(/malformed/);
  });

  test('extracts events from a tx outcome and round-trips formatting', () => {
    const line = formatEventLog('match_void', { season_id: 2, a: 'a.x', b: 'b.x', reason: 'duplicate_prompt' });
    const outcome = {
      transaction_outcome: { outcome: { logs: [] } },
      receipts_outcome: [{ outcome: { logs: ['plain log'] } }, { outcome: { logs: [line] } }],
    };
    expect(eventsFromOutcome(outcome)).toEqual([
      { standard: 'osd', version: '1.0.0', event: 'match_void', data: { season_id: 2, a: 'a.x', b: 'b.x', reason: 'duplicate_prompt' } },
    ]);
  });
});
