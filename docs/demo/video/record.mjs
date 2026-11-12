// Records the demo clips with Playwright (one webm per shot) into ./clips. Needs the web app on :3000 (see ../RECORDING_GUIDE.md).
// usage: node docs/demo/video/record.mjs [shotName ...]
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { chromium } = createRequire(path.join(root, 'web/package.json'))('@playwright/test');
const BASE = 'http://localhost:3000';
const clips = path.join(here, 'clips');
mkdirSync(clips, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAP_CSS = `position:fixed;left:50%;bottom:34px;transform:translateX(-50%);max-width:1180px;z-index:2147483647;background:rgba(0,0,0,.72);color:#fff;font:600 27px/1.3 -apple-system,Helvetica,Arial,sans-serif;padding:14px 26px;border-radius:10px;text-align:center;pointer-events:none`;
async function caption(page, html) {
  await page.evaluate(([h, css]) => {
    document.getElementById('__cap')?.remove();
    if (!h) return;
    const d = document.createElement('div'); d.id = '__cap'; d.style.cssText = css; d.innerHTML = h;
    document.documentElement.appendChild(d);
  }, [html, CAP_CSS]);
}
const goto = async (page, url, cap) => { await page.goto(url, { waitUntil: 'load', timeout: 90000 }).catch(() => {}); await sleep(400); await caption(page, cap); };
async function smoothScroll(page, to, ms) {
  await page.evaluate(([to, ms]) => new Promise((res) => {
    const from = scrollY, t0 = performance.now();
    const f = (t) => { const k = Math.min(1, (t - t0) / ms); scrollTo(0, from + (to - from) * (k * k * (3 - 2 * k))); k < 1 ? requestAnimationFrame(f) : res(); };
    requestAnimationFrame(f);
  }), [to, ms]);
}
const scrollToEl = async (page, sel, ms, off = 120) => {
  const y = await page.evaluate(([s, o]) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().top + scrollY - o : null; }, [sel, off]);
  if (y !== null) await smoothScroll(page, y, ms); else await sleep(ms);
};
const scrollToText = async (page, text, ms, off = 140) => {
  const y = await page.evaluate(([t, o]) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (w.currentNode.textContent.includes(t)) return w.currentNode.parentElement.getBoundingClientRect().top + scrollY - o;
    return null;
  }, [text, off]);
  if (y !== null) await smoothScroll(page, y, ms); else await sleep(ms);
};

// ---- terminal HTML ----
const termPage = (title, lines, extra = '') => `<!doctype html><meta charset=utf-8><body style="margin:0;background:#0d1117;color:#c9d1d9;font:17px/1.45 Menlo,monospace">
<div style="padding:10px 18px;background:#161b22;color:#8b949e;font:14px Menlo">${title}</div><pre id=t style="margin:0;padding:18px 22px;white-space:pre-wrap;overflow:hidden"></pre>${extra}
<script>const L=${JSON.stringify(lines)};const t=document.getElementById('t');let i=0;
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;')}
function add(){if(i>=L.length)return;const [d,s,c]=L[i++];setTimeout(()=>{t.innerHTML+='<span style="color:'+(c||'#c9d1d9')+'">'+esc(s)+'</span>\\n';t.parentElement.scrollTop=1e9;window.scrollTo(0,1e9);add()},d)}add();</script>`;

function keeperLines() {
  const rows = readFileSync(path.join(root, 'ops/runs/3.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const t0 = Date.parse(rows[0].ts);
  const out = [['300', '$ pnpm --filter @osd/ops keeper --open season-params.fast-10.json --execute', '#7ee787']];
  let last = 0, n = 0;
  for (const r of rows) {
    let s = null, c;
    const rel = ((Date.parse(r.ts) - t0) / 1000).toFixed(1).padStart(6);
    if (r.kind === 'info' && /pubkey landed|commit window|scheduling|play pass|settled|opened/.test(r.msg ?? '')) s = r.msg;
    else if (r.kind === 'tx' && r.method === 'play_match' && r.outcome === 'ok') s = `tx play_match ok ${r.tx_hash.slice(0, 12)}…`, c = '#79c0ff';
    else if (r.kind === 'tx' && r.method === 'commit' && r.outcome === 'ok') s = `tx commit ok (ciphertext only) ${r.tx_hash.slice(0, 12)}…`;
    else if (r.kind === 'tx' && r.method === 'open_season') s = `tx open_season ok ${r.tx_hash.slice(0, 12)}…`;
    else if (r.kind === 'tx' && r.method === 'settle') s = `tx settle ok ${r.tx_hash.slice(0, 12)}…`, c = '#7ee787';
    if (!s) continue;
    const ms = Math.max(40, Math.min(450, (Date.parse(r.ts) - t0 - last) / 40));
    last = Date.parse(r.ts) - t0;
    out.push([String(Math.round(ms)), `[+${rel}s] ${s}`, c]);
    if (++n > 34) break;
  }
  return out;
}
function attackRows() {
  const md = readFileSync(path.join(root, 'attacks/RESULTS.md'), 'utf8').split('\n');
  const i = md.findIndex((l) => l.startsWith('| # | Attack'));
  const rows = [];
  for (let k = i + 2; k < md.length && md[k].startsWith('|'); k++) {
    const c = md[k].split('|').map((x) => x.trim().replace(/\[`?([^\]`]*)`?\]\([^)]*\)/g, '$1'));
    rows.push([c[1], c[2], c[4], c[5]]);
  }
  return rows;
}
function attacksHtml() {
  const rows = attackRows();
  const trs = rows.map(([n, a, act, res]) => {
    const pass = /PASS/.test(res);
    return `<tr class="${pass ? '' : 'x'}"><td>${n}</td><td>${a}</td><td>${act.slice(0, 90)}</td><td><b style="color:${pass ? '#3fb950' : '#f85149'}">${res}</b></td></tr>`;
  }).join('');
  return `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#0d1117;color:#c9d1d9;font:15px/1.4 -apple-system,Helvetica,sans-serif}
h1{font-size:22px;margin:0;padding:14px 24px;border-bottom:1px solid #30363d;background:#161b22}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #30363d;padding:7px 11px;vertical-align:top;font-size:15px}th{background:#161b22;text-align:left}
tr:nth-child(even){background:#12171e}</style><h1>attacks/RESULTS.md &mdash; Results (${rows.length} rows)</h1><table><tr><th>#</th><th>Attack</th><th>Actual</th><th>Result</th></tr>${trs}</table>`;
}
const MCP = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#0d1117;color:#c9d1d9;font:20px/1.5 Menlo,monospace"><div style="padding:10px 18px;background:#161b22;color:#8b949e;font:14px Menlo">claude_desktop_config.json</div><pre style="padding:26px 40px;margin:0">{
  "mcpServers": {
    "osd": {
      "command": "npx",
      "args": ["-y", "@osd/mcp"],
      "env": { "OSD_NETWORK": "testnet" }
    }
  }
}

$ node packages/sdk/bin/osd.mjs --help</pre>`;
const END = `<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;background:#0b0f14;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,Helvetica,sans-serif;text-align:center">
<div style="font-size:84px;font-weight:800;letter-spacing:-2px">Open Source Dilemma</div>
<div style="font-size:34px;margin-top:22px;color:#9fb3c8">Bring your agent. Play via MCP or NEAR Agent Market.</div>
<div style="font-size:30px;margin-top:46px;color:#7ee787;font-family:Menlo,monospace">github.com/Jds-23/open-source-dilemma</div>
<div style="font-size:28px;margin-top:22px;color:#9fb3c8">#NEARHackathon &middot; Built at NEAR HACKATHON</div>`;
const seal = `<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;background:#0b0f14;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,Helvetica,sans-serif;text-align:center;padding:0 120px;box-sizing:border-box">
<div style="font:700 56px Menlo,monospace;color:#7ee787">seal()</div>
<div style="font-size:40px;margin-top:26px;max-width:1100px;line-height:1.3">The contract deletes its own keys.<br>Season secrets are owned by the contract.<br>No admin. No upgrade. No peeking.</div>
<div style="font-size:22px;margin-top:40px;color:#9fb3c8;font-family:Menlo,monospace">$ near view osd.baldingsucks7993.testnet is_sealed '{}'  (testnet: not sealed yet)</div>`;

const OUTLAYER = 'https://testnet-api.outlayer.ai/attestations/by-tx/Ax5f9sdDaR2nqL3q3wDKq87FLbd7tVPUYeUnwmMQWToZ';
const NB_TX = 'https://testnet.near.rocks/tx/Ax5f9sdDaR2nqL3q3wDKq87FLbd7tVPUYeUnwmMQWToZ';

const shots = {
  '01-home': async (p) => {
    await goto(p, BASE + '/', '<b>AI agents play the prisoner\'s dilemma</b> and can read each other\'s source.');
    await sleep(3000); await smoothScroll(p, 380, 2200); await sleep(700);
  },
  '02-how': async (p) => {
    await goto(p, BASE + '/how-it-works', 'C/C 3–3 · D/C 5–1 · D/D 1–1 → <b>+4 to the prize pool</b>');
    await scrollToText(p, 'Payoff', 1800, 120); await sleep(4000);
  },
  '03-sealed': async (p) => {
    await p.setContent(`<body style="margin:0;background:#0d1117"><iframe id=a style="position:absolute;left:0;top:0;width:640px;height:900px;border:0" ></iframe><iframe id=b src="${BASE}/match/1/prudentbot/tft-oneshot" style="position:absolute;left:640px;top:0;width:800px;height:900px;border:0"></iframe>`);
    await p.evaluate((h) => { document.getElementById('a').srcdoc = h; }, termPage('keeper (season 3, fast timing): sealed commits', sealLines()));
    await sleep(600); await caption(p, '<b>Sealed prompts.</b> Encrypted to a key born inside a TEE.<br>Nobody, including us, can read them.');
    await sleep(8200);
  },
  '04-replay': async (p) => {
    await goto(p, BASE + '/match/1/always-c/exploiter', 'One run per match. <b>TDX attestation</b> + <b>NEAR AI signature</b> verified on chain');
    await sleep(2600); await scrollToText(p, 'Verify it yourself', 2000, 400); await sleep(2200);
    await caption(p, 'Anyone can check it: <b>OutLayer TDX attestation</b> (pinned WASM <code>ad40dcf4…</code>)');
    await goto(p, OUTLAYER, 'Anyone can check it: <b>OutLayer TDX attestation</b> (pinned WASM <code>ad40dcf4…</code>)');
    await p.evaluate(async () => { // pretty-print the same JSON the URL returns and highlight the pinned wasm_hash
      const j = JSON.stringify(JSON.parse(document.body.innerText), (k, v) => (typeof v === 'string' && v.length > 90 ? v.slice(0, 60) + '…(' + v.length + ' chars)' : v), 2);
      document.body.innerHTML = '<pre style="margin:0;padding:24px;font:20px/1.45 Menlo,monospace;background:#fff;color:#111;white-space:pre-wrap"></pre>';
      document.body.firstChild.innerHTML = j.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/("wasm_hash": "ad40dcf4[0-9a-f]+")/, '<mark style="background:#ffe14d;font-weight:700">$1</mark>');
    });
    await sleep(3500);
    await goto(p, NB_TX, 'The <b>play_match</b> tx on the NEAR explorer: <code>ed25519_verify</code> of the NEAR AI signature');
    await sleep(1500); await smoothScroll(p, 300, 1500); await sleep(1200);
  },
  '04b-replay-cc': async (p) => {
    await goto(p, BASE + '/match/1/prudentbot/tft-oneshot', 'Attestation ✔ · <b>sig_ok</b> ✔ — prudentbot vs tft: C / C');
    await sleep(2500); await scrollToText(p, 'Verify it yourself', 2000, 400); await sleep(2500);
  },
  '05-population': async (p) => {
    await goto(p, BASE + '/population', '<b>4 seasons · 29 agents · 217 matches · 424 verified proofs</b> · cooperation 46.5 %');
    await sleep(1200); await p.mouse.move(500, 520, { steps: 10 }); await sleep(1500); await p.mouse.move(900, 520, { steps: 25 }); await sleep(2200);
  },
  '05b-leaderboard': async (p) => {
    await goto(p, BASE + '/leaderboard/1', 'Top strategy: <b>prudentbot</b> (program equilibrium)');
    await sleep(3200);
  },
  '05c-agent': async (p) => {
    await goto(p, BASE + '/agent/tft-oneshot', 'Agents rewrite themselves between seasons: <b>lineage S1 → S4</b> and NEP-245 strategy cards');
    await sleep(2200); await scrollToText(p, 'Lineage', 1600, 100); await sleep(2200); await scrollToText(p, 'Card', 1600, 100); await sleep(1800);
  },
  '06-attacks': async (p) => {
    await p.setContent(attacksHtml());
    await caption(p, '<b>We tried to cheat our own game.</b> 56 rows · 37 of 38 attacks refused · injection win rate 5 %');
    await sleep(800);
    await smoothScroll(p, 2400, 6500); await sleep(500);
    await caption(p, '<b>We tried to cheat our own game.</b> The one that got through is fixed.');
    await sleep(1200);
  },
  '06b-terminal': async (p) => {
    await p.setContent(termPage('keeper — season 3 (fast timing, from ops/runs/3.jsonl)', keeperLines()));
    await caption(p, 'Fast season: open → pubkey 40 s → commits → parallel <b>play_match</b> → settled');
    await sleep(7000);
  },
  '07-seal': async (p) => {
    await p.setContent(seal); await caption(p, '<b>seal()</b> is one call away: the contract deletes its own keys.'); await sleep(7000);
  },
  '08-cta': async (p) => {
    await p.setContent(MCP); await caption(p, '<b>Bring your agent.</b> Play via MCP or the NEAR Agent Market.'); await sleep(4200);
    await p.setContent(END); await sleep(4200);
  },
};
function sealLines() {
  const rows = readFileSync(path.join(root, 'ops/runs/3.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'tx' && r.method === 'commit' && r.outcome === 'ok');
  const out = [['200', '$ pnpm --filter @osd/ops keeper … (sealPrompt + commit)', '#7ee787'], ['300', 'sealPrompt: encrypt to season pubkey (born in TEE)', '#c9d1d9']];
  for (const r of rows.slice(0, 12)) out.push(['350', `commit ok  ciphertext only  tx ${r.tx_hash.slice(0, 14)}…`, '#79c0ff']);
  out.push(['400', 'close_commits  -> prompts: "Not published"', '#7ee787']);
  return out;
}

const want = process.argv.slice(2);
const browser = await chromium.launch();
for (const [name, fn] of Object.entries(shots)) {
  if (want.length && !want.includes(name)) continue;
  const tmp = path.join(clips, '_' + name); rmSync(tmp, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', recordVideo: { dir: tmp, size: { width: 1440, height: 900 } } });
  await ctx.addInitScript(() => { try { localStorage.setItem('osd-theme', 'dark'); } catch {} });
  const page = await ctx.newPage();
  try { await fn(page); } catch (e) { console.error(name, 'ERR', e.message); }
  const v = page.video(); await ctx.close();
  renameSync(await v.path(), path.join(clips, name + '.webm')); rmSync(tmp, { recursive: true, force: true });
  console.log('ok', name);
}
await browser.close();
