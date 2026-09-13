import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

/* Why these live here and not in vercel.json:
 *
 * `vercel.json` headers are applied by Vercel's edge, which means they do not
 * exist under `next dev`. Keeping CSP there would mean dev and production
 * disagree about the one setting whose failure mode is a silently blank page.
 * `next.config.ts` headers apply in dev, in `next start`, and on Vercel alike.
 *
 * On 'unsafe-inline' in script-src: the App Router streams hydration data as
 * inline <script>self.__next_f.push(...)</script> tags. The only supported way
 * to drop it is a per-request nonce set in middleware -- which forces every
 * nonce-bearing route to render dynamically, giving up static generation and
 * the full-route cache. That is a deliberate later trade (see the plan's
 * hardening phase), not something to adopt before the app works, because a
 * broken CSP fails as a white page with no error.
 *
 * Dev additionally needs 'unsafe-eval' for hot module replacement. If this
 * header were identical in both environments, HMR would silently stop working.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",          // was 'none'; login/signup post to our own routes
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob:",  // blob: for exporting the graph as a PNG
  "font-src 'self'",
  "connect-src 'self'",          // the gateway ping is proxied server-side now
  "worker-src 'self' blob:",     // the force simulation runs in a Web Worker
  "style-src 'self' 'unsafe-inline'",
  isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'",
].join('; ');

const nextConfig: NextConfig = {
  /* The seed catalogue is read with fs at runtime. Next's output tracing does
   * not reliably follow dynamically-constructed paths, and the failure mode is
   * nasty: works locally, ENOENT on Vercel. Naming the files explicitly is the
   * fix. Verify with `ls .vercel/output/functions/**\/data/seed` after a build. */
  outputFileTracingIncludes: {
    '/api/**': ['./data/seed/**'],
    '/w/**': ['./data/seed/**'],
    '/org/**': ['./data/seed/**'],
    '/app/**': ['./data/seed/**'],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
