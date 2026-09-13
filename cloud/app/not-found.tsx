import Link from 'next/link';
import s from './fallback.module.css';

/* The catch-all 404.
 *
 * Reached by a mistyped URL, and also whenever a LAYOUT calls notFound() --
 * app/w/[ws]/layout.tsx does exactly that for a workspace slug the signed-in
 * user cannot reach. Next renders the nearest boundary ABOVE the segment that
 * failed, so in that case the workspace chrome is not available to render
 * inside and this page has to stand on its own. That is why it reads no
 * session and links only to routes that exist for everyone.
 */

export default function NotFound() {
  return (
    <main className={s.shell} id="main">
      <div className={s.panel}>
        <p className={s.code}>404</p>
        <h1 className={s.title}>There is nothing at this address</h1>
        <p className={s.body}>
          The page may have been renamed, or the workspace in the URL may not be
          one this account can open. Workspace addresses look like{' '}
          <span className={s.slug}>/w/hadesmedia-marketing</span>.
        </p>
        <div className={s.actions}>
          <Link href="/app" className={s.btn}>Go to your workspaces</Link>
          <Link href="/" className={s.ghost}>Home</Link>
        </div>
      </div>
    </main>
  );
}
