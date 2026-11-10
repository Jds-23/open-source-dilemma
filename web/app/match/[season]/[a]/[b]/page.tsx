import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FamilyTag, Glyph, MoveChip, short, StatusPill } from '@/components/ui';
import { data } from '@/lib/data';
import { outcomeLabel } from '@/lib/game';
import { agentHref, explorerAccount, explorerTx, OUTLAYER_ATTESTATION } from '@/lib/links';
import { allMatchParams, matchDetail, type MatchDetail, type PromptView } from '@/lib/queries';
import type { Move } from '@/lib/types';

export const revalidate = 30;
export const dynamicParams = true;

type Params = { season: string; a: string; b: string };

export async function generateStaticParams() {
  return data().mode === 'fixtures' ? allMatchParams() : [];
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { season, a, b } = await params;
  return { title: `${decodeURIComponent(a)} vs ${decodeURIComponent(b)} · S${season}` };
}

function Prompt({ view }: { view: PromptView }) {
  switch (view.state) {
    case 'revealed':
      return (
        <>
          <div className="prompt-box" data-testid="prompt-revealed">
            {view.prompt}
          </div>
          <div className="small muted">
            <span className="pill ok">commitment ✓</span> sha256(prompt ‖ salt ‖ agent_id) matches the on-chain commitment.
          </div>
        </>
      );
    case 'sealed':
      return (
        <div className="sealed" data-testid="prompt-sealed">
          <span aria-hidden>🔒</span>
          <span>
            <b>Sealed.</b> Encrypted to the season key; only the TEE reads it during play. Owners may publish after the season settles.
          </span>
        </div>
      );
    case 'unpublished':
      return (
        <div className="sealed" data-testid="prompt-unpublished">
          <span aria-hidden>🔒</span>
          <span>
            <b>Not published.</b> The season is settled but the owner has not revealed this prompt.
          </span>
        </div>
      );
    case 'mismatch':
      return (
        <div className="sealed error" data-testid="prompt-mismatch">
          A published text exists but does not hash to the committed value, so it is not shown.
        </div>
      );
  }
}

function Player({ side, d }: { side: 'a' | 'b'; d: MatchDetail }) {
  const p = d[side];
  const m = d.match;
  const move = (side === 'a' ? m.a_move : m.b_move) as Move | null;
  const pay = side === 'a' ? m.a_payoff : m.b_payoff;
  const sigOk = side === 'a' ? m.sig_a_ok : m.sig_b_ok;
  const signed = side === 'a' ? m.a_signed_text : m.b_signed_text;
  const chat = side === 'a' ? m.a_chat_id : m.b_chat_id;
  const sig = side === 'a' ? m.a_sig : m.b_sig;
  const [model, reqHash, respHash] = signed ? signed.split(/:(?=[0-9a-f]{64}(?::|$))/) : [];
  return (
    <article className="card player" data-testid={`player-${side}`}>
      <div className="kicker">Player {side.toUpperCase()}</div>
      <h2>
        <Link href={agentHref(p.name)}>{p.name}</Link>
      </h2>
      <div className="btn-row" style={{ gap: 6 }}>
        {p.entry && <FamilyTag family={p.entry.family} />}
        {p.entry && <span className="tag">owner {p.entry.owner}</span>}
      </div>
      <div className="move-line">
        <MoveChip move={move} large />
        <div>
          <div className="payoff">{m.status === 'settled' ? `+${pay}` : '—'}</div>
          <div className="small muted">units (staked 3)</div>
        </div>
      </div>
      <h3>Strategy prompt</h3>
      <Prompt view={p.prompt} />
      <h3 style={{ marginTop: 16 }}>NEAR AI signature</h3>
      {m.status === 'settled' && move !== 'F' ? (
        <dl className="kv">
          <dt>sig_ok</dt>
          <dd>
            <span className={`pill ${sigOk ? 'ok' : 'warn'}`} data-testid={`sig-${side}`}>
              {sigOk ? 'verified on chain' : 'not verified'}
            </span>
          </dd>
          <dt>model</dt>
          <dd>{model ?? '—'}</dd>
          <dt>sha256(req)</dt>
          <dd title={reqHash}>{short(reqHash, 10)}</dd>
          <dt>sha256(resp)</dt>
          <dd title={respHash}>{short(respHash, 10)}</dd>
          <dt>chat id</dt>
          <dd>{chat ?? '—'}</dd>
          <dt>ed25519 sig</dt>
          <dd title={sig ?? ''}>{short(sig, 10)}</dd>
          <dt>commitment</dt>
          <dd title={p.entry?.commitment}>{short(p.entry?.commitment, 10)}</dd>
        </dl>
      ) : (
        <p className="small muted">{move === 'F' ? 'Forfeit: entry invalid, no inference was run.' : 'No signed inference for this match.'}</p>
      )}
    </article>
  );
}

export default async function MatchPage({ params }: { params: Promise<Params> }) {
  const { season, a, b } = await params;
  const sid = Number(season);
  if (!Number.isInteger(sid) || sid < 1) notFound();
  const ds = data();
  const d = await matchDetail(sid, decodeURIComponent(a), decodeURIComponent(b), ds);
  if (!d) notFound();
  const m = d.match;
  return (
    <>
      <div className="kicker">
        <Link href="/matches">Matches</Link> / Season {m.season_id} / Round {m.round + 1}
      </div>
      <h1 className="break" style={{ fontSize: 'clamp(1.6rem, 5vw, 2.6rem)' }}>
        {d.a.name} <span className="muted">vs</span> {d.b.name}
      </h1>
      <div className="btn-row" style={{ alignItems: 'center', marginBottom: 20 }}>
        <StatusPill status={m.status} />
        <span className="muted small mono break">{m.match_key}</span>
      </div>

      <div className="versus">
        <Player side="a" d={d} />
        <div className="mid card" data-testid="outcome">
          <Glyph a={m.a_move} b={m.b_move} size={64} status={m.status} />
          <div style={{ textAlign: 'center' }}>
            <div className="countdown" style={{ fontSize: '1.8rem' }}>
              {m.status === 'settled' ? `${m.a_payoff}–${m.b_payoff}` : m.status}
            </div>
            <div className="small muted">{m.status === 'settled' ? outcomeLabel(m.a_move, m.b_move) : m.void_reason ? `void: ${m.void_reason}` : 'not settled'}</div>
            {m.pool_delta > 0 && <div className="small" style={{ color: 'var(--accent)' }}>+{m.pool_delta} to the season pool</div>}
            {m.status === 'void' && <div className="small muted">Both sides refunded 3 units (refund_void).</div>}
          </div>
        </div>
        <Player side="b" d={d} />
      </div>

      <section aria-labelledby="verify-h">
        <h2 id="verify-h">Verify it yourself</h2>
        <div className="card">
          <div className="proof-links">
            {d.tx ? (
              <>
                <a className="btn" href={explorerTx(ds.network, d.tx)} target="_blank" rel="noreferrer" data-testid="explorer-link">
                  NEAR explorer tx ↗
                </a>
                <a className="btn" href={OUTLAYER_ATTESTATION(d.tx)} target="_blank" rel="noreferrer" data-testid="attestation-link">
                  OutLayer TDX attestation ↗
                </a>
              </>
            ) : (
              <>
                <span className="btn disabled-link" aria-disabled="true" data-testid="explorer-link">
                  NEAR explorer tx — no tx hash yet
                </span>
                <span className="btn disabled-link" aria-disabled="true" data-testid="attestation-link">
                  OutLayer attestation — no tx hash yet
                </span>
              </>
            )}
            <a className="btn" href={explorerAccount(ds.network, ds.contractId)} target="_blank" rel="noreferrer">
              Contract {ds.contractId} ↗
            </a>
          </div>
          <dl className="kv" style={{ marginTop: 16 }}>
            <dt>play_match tx</dt>
            <dd>{d.tx ?? (ds.mode === 'fixtures' ? 'fixture data has no transactions' : 'not in the index yet')}</dd>
            <dt>attestation URL</dt>
            <dd>{d.tx ? OUTLAYER_ATTESTATION(d.tx) : 'https://testnet-api.outlayer.ai/attestations/by-tx/{tx}'}</dd>
            <dt>blocks</dt>
            <dd>
              requested {m.requested_at_block ?? '—'} · settled {m.settled_at_block ?? '—'}
            </dd>
            <dt>referee template</dt>
            <dd>{short(d.season.params.referee_template_hash, 12)}</dd>
            <dt>WASM</dt>
            <dd>{d.season.wasm.hash}</dd>
          </dl>
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            The attestation shows the TDX quote for this run, including the WASM hash the contract pinned. Signature flags come from
            <code> env::ed25519_verify</code> against the pinned NEAR AI signer; a false flag never blocks settlement.{' '}
            <Link href="/how-it-works">Read the trust model →</Link>
          </p>
        </div>
      </section>
    </>
  );
}
