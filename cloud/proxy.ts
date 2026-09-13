import { NextResponse, type NextRequest } from 'next/server';
import { verify, cookieName } from '@/lib/auth/cookie';

/* Route protection. (Next 16 renamed this convention from `middleware` to
 * `proxy`; the behaviour is the same.)
 *
 * This verifies the cookie SIGNATURE and EXPIRY, and nothing else. It never
 * touches the repository, because it runs on every matched request and has to
 * stay in the hundreds of microseconds -- and because loading the catalogue
 * here would pull a 2 MB JSON parse into the edge runtime, where it does not
 * belong.
 *
 * Authorisation -- *may this user see this workspace* -- happens one layer
 * down, in repository.buildContext(), which checks membership and returns null
 * for a non-member. That layering is deliberate: this file answers "are you
 * signed in", the repository answers "is this yours".
 */
export default async function proxy(request: NextRequest) {
  const claims = await verify(request.cookies.get(cookieName)?.value);
  if (claims) return NextResponse.next();

  const { pathname, search } = request.nextUrl;

  // An API route gets a status, not a redirect -- a fetch that follows a 302
  // to an HTML login page produces a confusing JSON parse error at the caller.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    '/app/:path*',
    '/w/:path*',
    '/org/:path*',
    '/api/w/:path*',
  ],
};
