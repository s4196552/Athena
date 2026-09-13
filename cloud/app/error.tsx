'use client';

import Link from 'next/link';
import s from './fallback.module.css';

/* The catch-all error boundary.
 *
 * Next strips the message from a server-side error in production and leaves
 * only a `digest`, so this shows whichever of the two it actually has rather
 * than pretending to a detail it does not hold. The digest is worth surfacing:
 * it is the only string that ties what someone saw to a line in the server log.
 *
 * `reset()` re-renders the segment. It is offered first because most failures
 * here are a transient read of the seeded catalogue, and retrying costs
 * nothing.
 */

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const detail = error.digest
    ? `Reference ${error.digest}`
    : error.message || null;

  return (
    <main className={s.shell} id="main">
      <div className={s.panel}>
        <p className={s.code}>Error</p>
        <h1 className={s.title}>That page could not be loaded</h1>
        <p className={s.body}>
          Nothing was changed — Athena only ever reads. Try again, and if it
          keeps failing, open another workspace or start from the top.
        </p>
        <div className={s.actions}>
          <button type="button" className={s.btn} onClick={reset}>Try again</button>
          <Link href="/app" className={s.ghost}>Your workspaces</Link>
          <Link href="/" className={s.ghost}>Home</Link>
        </div>
        {detail && <p className={s.detail}>{detail}</p>}
      </div>
    </main>
  );
}
