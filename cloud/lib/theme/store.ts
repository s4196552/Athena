import 'server-only';
import { cookies } from 'next/headers';

/* The viewer's appearance choice.
 *
 * WHY A COOKIE AND NOT localStorage
 *
 * The appearance has to be known at the moment the HTML is generated. Anything
 * the browser holds is not: the server would emit a dark page, the client would
 * read storage and swap it, and the viewer would see a flash of the wrong
 * appearance on every navigation. Worse, React would be comparing a server
 * render against a client render that disagreed -- this app has already been
 * bitten by exactly that (hydration error #418, from dates formatted in the
 * lambda's UTC and re-formatted in the viewer's timezone; see lib/format.ts).
 *
 * A cookie travels with the request, so the server stamps data-theme on <html>
 * itself and there is nothing to correct afterwards. lib/overlay/store.ts uses
 * the same mechanism for the same reason.
 *
 * THE COST, stated plainly: reading a cookie in the root layout opts the whole
 * tree into dynamic rendering, so the landing page's `revalidate = 60` no
 * longer produces a static document. Every other page in the app is already
 * force-dynamic, and the gateway status it shows is still a cached fetch, so
 * what is actually lost is the HTML caching on one page.
 *
 * ABSENT MEANS SYSTEM. Apple advises against an app-specific appearance
 * setting at all -- "they may think your app is broken because it doesn't
 * respond to their systemwide appearance choice" -- so following the system is
 * what happens until someone deliberately chooses otherwise, and choosing
 * "System" clears the cookie rather than recording a third value.
 */

export type Theme = 'light' | 'dark';
export type ThemeChoice = Theme | 'system';

const COOKIE = 'athena_theme';
const YEAR = 60 * 60 * 24 * 365;

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** The explicit choice, or 'system' when none has been made. */
export async function readTheme(): Promise<ThemeChoice> {
  const jar = await cookies();
  const value = jar.get(COOKIE)?.value;
  return isTheme(value) ? value : 'system';
}

/** Server Actions and Route Handlers only -- a Server Component cannot set a
 *  cookie, and Next throws rather than silently dropping it. */
export async function writeTheme(choice: ThemeChoice): Promise<void> {
  const jar = await cookies();

  if (choice === 'system') {
    jar.delete(COOKIE);
    return;
  }

  jar.set(COOKIE, choice, {
    // Not httpOnly: this is a display preference, and the toggle applies it in
    // the browser before the server round-trip finishes so the change feels
    // immediate. Nothing about it is a secret.
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: YEAR,
  });
}
