import 'server-only';
import { cookies } from 'next/headers';
import { decodeOverlay, encodeOverlay } from './codec';
import { emptyOverlay, MAX_COOKIE_BYTES } from './types';
import type { Overlay } from './types';
import type { WorkspaceId } from '../data/types';

/* Where the overlay lives.
 *
 * A cookie, per workspace, and the reasoning is worth stating because the
 * obvious alternatives are all worse here:
 *
 *   localStorage  -- the colour-group editor uses it, and it is right there,
 *                    because colours are decided and applied in the browser.
 *                    An overlay is not: removing a tag has to change facet
 *                    COUNTS, which page of 2,971 files you are on, and what the
 *                    graph route returns. All of that runs on the server, and
 *                    the server cannot read localStorage.
 *   module memory -- survives inside one warm lambda and vanishes on a cold
 *                    start, so a correction made before lunch is gone after
 *                    it, unpredictably. A demo that forgets is worse than one
 *                    that admits it is per-browser.
 *   a database    -- the right answer, and the reason the repository takes the
 *                    overlay as an argument instead of reaching for it. When
 *                    there is a Postgres, readOverlay is the only function
 *                    that changes.
 *
 * The honest limit: this is per-browser, not per-team. Priya's correction in
 * Marketing does not reach her colleague's screen. The UI says so.
 */

function cookieName(workspaceId: WorkspaceId): string {
  return `athena_ov_${workspaceId}`;
}

export async function readOverlay(workspaceId: WorkspaceId): Promise<Overlay> {
  const jar = await cookies();
  return decodeOverlay(jar.get(cookieName(workspaceId))?.value, workspaceId);
}

export type WriteResult = { ok: true } | { ok: false; error: string };

/** Server Actions and Route Handlers only -- a Server Component cannot set a
 *  cookie, and Next throws rather than silently dropping it. */
export async function writeOverlay(overlay: Overlay): Promise<WriteResult> {
  const value = encodeOverlay(overlay);

  if (Buffer.byteLength(value, 'utf8') > MAX_COOKIE_BYTES) {
    // Refusing loudly beats a browser silently discarding an oversized cookie
    // and taking every earlier correction with it.
    return {
      ok: false,
      error:
        'This workspace has as many corrections and album entries as a browser '
        + 'cookie can hold. Delete an album, or restore a few tags, to make room.',
    };
  }

  const jar = await cookies();
  jar.set(cookieName(overlay.workspaceId), value, {
    httpOnly: false, // no secret in it; readable by devtools on purpose
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 180 * 24 * 60 * 60,
  });
  return { ok: true };
}

export async function clearOverlay(workspaceId: WorkspaceId): Promise<void> {
  const jar = await cookies();
  jar.delete(cookieName(workspaceId));
}

export { emptyOverlay };
