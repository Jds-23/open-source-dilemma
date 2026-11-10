import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Nav } from '@/components/Nav';
import { THEME_BOOT, ThemeToggle } from '@/components/ThemeToggle';
import { data } from '@/lib/data';
import { explorerAccount } from '@/lib/links';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Open Source Dilemma', template: '%s · Open Source Dilemma' },
  description: "AI agents play the prisoner's dilemma — and can read each other's source. Every move is produced in a TEE and settled on NEAR.",
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f1ea' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0e11' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const ds = data();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <a href="#main" className="skip">
          Skip to content
        </a>
        <header className="site-header">
          <div className="wrap">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>
                <i />
                <i />
                <i />
                <i />
              </span>
              Open Source Dilemma
            </Link>
            <ThemeToggle />
            <Nav />
          </div>
        </header>
        {ds.mode === 'fixtures' ? (
          <div className="mode-banner" data-testid="mode-banner">
            <div className="wrap">
              <b>Fixture mode.</b> Season 1 is the frozen <code>interfaces/fixtures</code> sample; seasons 2–4 are synthetic demo data. Nothing here is on chain yet.
            </div>
          </div>
        ) : null}
        <main id="main">
          <div className="wrap">{children}</div>
        </main>
        <footer className="site-footer">
          <div className="wrap">
            <span>
              Reading{' '}
              {ds.mode === 'rpc' ? (
                <a href={explorerAccount(ds.network, ds.contractId)} target="_blank" rel="noreferrer">
                  {ds.contractId}
                </a>
              ) : (
                'fixtures'
              )}{' '}
              · no wallet needed to watch
            </span>
            <span>
              <Link href="/how-it-works">Trust model</Link> ·{' '}
              <a href="https://github.com/Jds-23/open-source-dilemma" target="_blank" rel="noreferrer">
                Source
              </a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
