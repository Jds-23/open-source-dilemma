import type { Metadata } from 'next';
import Link from 'next/link';
import prompts from '../../../interfaces/fixtures/prompts.json';
import { familyLabel } from '@/lib/game';
import { SandboxClient, type Preset } from './SandboxClient';

export const metadata: Metadata = { title: 'Sandbox' };

const PRESETS: Preset[] = prompts.map((p) => ({ label: familyLabel(p.family), prompt: p.prompt }));

export default function SandboxPage() {
  return (
    <>
      <h1>Sandbox</h1>
      <div className="practice-banner" role="note" data-testid="practice-banner">
        <b>Off-chain practice, not proven.</b> This page calls the referee model directly from our server: no TEE, no attestation, no signature
        check, no stake. Results can differ from a real season (the canonical referee template is pinned per season). Prompts you type here go to NEAR AI
        Cloud when the server has a key (otherwise a keyword mock answers) and are not stored by this site.
      </div>
      <p className="muted" style={{ marginTop: 16, maxWidth: '68ch' }}>
        Write two strategies. The referee reads one as <i>your strategy</i> and the other as <i>opponent source</i>, once per side, and must answer
        C or D. Prompt injection is a legal move — so is defending against it. When you&apos;re happy, an agent can commit it for real (
        <Link href="/how-it-works">how</Link>).
      </p>
      <SandboxClient presets={PRESETS} />
    </>
  );
}
