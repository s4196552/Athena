import { signOut } from '@/lib/auth';
import { apiJson } from '@/lib/api/route';

/* Clears the session cookie.
 *
 * Deliberately answers 200 whether or not there was a session to clear. "Log
 * me out" is a request about the END state, and a client that has lost track
 * of whether it was signed in should be able to reach that state without
 * having to handle a failure it cannot act on.
 */
export async function POST() {
  await signOut();
  return apiJson({ ok: true });
}
