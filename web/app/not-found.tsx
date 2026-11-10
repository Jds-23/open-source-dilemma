import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="prose">
      <h1>Nothing here</h1>
      <p className="muted">That season, match or agent doesn&apos;t exist (yet).</p>
      <Link className="btn" href="/">
        Back to the feed
      </Link>
    </div>
  );
}
