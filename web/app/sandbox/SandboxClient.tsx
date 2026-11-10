'use client';
import { useState } from 'react';
import { MoveChip } from '@/components/ui';

export interface Preset {
  label: string;
  prompt: string;
}

interface Result {
  mode: 'nearai' | 'mock';
  model: string;
  a_move: 'C' | 'D';
  b_move: 'C' | 'D';
  a_payoff: number;
  b_payoff: number;
  pool_delta: number;
  a_reply: string;
  b_reply: string;
}

const MAX = 4000;

function Side({ id, label, value, onChange, presets }: { id: string; label: string; value: string; onChange: (v: string) => void; presets: Preset[] }) {
  const bytes = new TextEncoder().encode(value).length;
  return (
    <div className="card">
      <div className="section-head" style={{ marginBottom: 8 }}>
        <label htmlFor={id}>
          <b>{label}</b>
        </label>
        <select aria-label={`${label} template`} onChange={(e) => e.target.value && onChange(presets[Number(e.target.value)].prompt)} defaultValue="">
          <option value="">Load a template…</option>
          {presets.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={MAX * 2} spellCheck={false} />
      <div className={`small ${bytes > MAX ? 'error' : 'muted'}`} style={{ textAlign: 'right' }}>
        {bytes}/{MAX} bytes
      </div>
    </div>
  );
}

export function SandboxClient({ presets }: { presets: Preset[] }) {
  const [a, setA] = useState(presets[1]?.prompt ?? '');
  const [b, setB] = useState(presets[4]?.prompt ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);

  async function play() {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await fetch('/api/sandbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a, b }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setRes(body as Result);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sandbox-grid">
        <Side id="prompt-a" label="Strategy A" value={a} onChange={setA} presets={presets} />
        <Side id="prompt-b" label="Strategy B" value={b} onChange={setB} presets={presets} />
      </div>
      <div className="btn-row" style={{ margin: '16px 0' }}>
        <button type="button" className="btn btn-primary" onClick={play} disabled={busy} data-testid="play">
          {busy ? 'Referee thinking…' : 'Play one round'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setA(b);
            setB(a);
          }}
        >
          Swap sides
        </button>
      </div>
      <div aria-live="polite">
        {err && <p className="error">{err}</p>}
        {res && (
          <div className="card" data-testid="sandbox-result">
            <div className="section-head">
              <h2 style={{ margin: 0 }}>
                {res.a_payoff}–{res.b_payoff}
              </h2>
              <span className={`pill ${res.mode === 'mock' ? 'warn' : ''}`} data-testid="sandbox-mode">
                {res.mode === 'mock' ? 'mock referee · no NEAR AI key' : `NEAR AI · ${res.model}`} · not proven
              </span>
            </div>
            <div className="duel" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto minmax(0,1fr)' }}>
              <div className="side">
                <b>A</b> <span className="muted small">replied “{res.a_reply}”</span>
              </div>
              <MoveChip move={res.a_move} large />
              <MoveChip move={res.b_move} large />
              <div className="side right">
                <b>B</b> <span className="muted small">replied “{res.b_reply}”</span>
              </div>
            </div>
            {res.pool_delta > 0 && <p className="small" style={{ color: 'var(--accent)', marginTop: 10 }}>Mutual defection: 4 units would go to the season pool.</p>}
          </div>
        )}
      </div>
    </>
  );
}
