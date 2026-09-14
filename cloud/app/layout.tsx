import type { Metadata, Viewport } from 'next';
import { Inter, Playfair_Display } from 'next/font/google';
import { readTheme } from '@/lib/theme/store';
import './globals.css';

/* TWO typefaces, and the HIG's "minimize the number of typefaces you use" is
 * worth answering rather than ignoring. Two is the minimum for a design with a
 * serif identity, because the two are doing different jobs and neither can do
 * the other's:
 *
 *   Playfair Display -- a Didone, with the extreme thick-to-thin contrast and
 *   hairline serifs that give the name its character at 28px and above. Those
 *   same hairlines disappear at 13px, which is most of this app.
 *   Inter -- drawn for UI at small sizes, which is everything else.
 *
 * So the split is by SIZE, not by whim: display type down to --fs-title-2, UI
 * and prose below it. One decision, applied in globals.css, rather than a
 * choice made per component.
 *
 * Inter rather than the system stack, which would give SF Pro on a Mac and
 * Segoe UI Variable on Windows: two different designs for a page whose first
 * impression is the point, and SF Pro cannot be licensed for the web anyway.
 * Inter is drawn for UI at small sizes, which is essentially all of this app.
 *
 * next/font downloads the file at BUILD time and serves it from the app's own
 * origin, so the `font-src 'self'` CSP in next.config.ts needs no exception.
 * Weights are restricted to 400-700: no Ultralight, Thin or Light anywhere.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

/* Weights 500-700 only. A Didone at 400 is already delicate, and the HIG rules
 * out light weights outright; the display sizes here want the sturdier cuts. */
const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  weight: ['500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Athena — a data manager that never touches your files',
  description:
    'Athena indexes, tags and searches a local library without changing, moving or renaming a single file.',
  openGraph: {
    title: 'Athena',
    description: 'Google Photos for general data. Reads everything, writes nothing.',
    type: 'website',
  },
  icons: {
    // The same inline-SVG mark the static landing page used, so the tab looks
    // unchanged to anyone who had it bookmarked.
    icon:
      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#129418;</text></svg>",
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /* The browser chrome follows the appearance too. Two entries rather than
     one: a fixed themeColor would tint a light page's address bar near-black. */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f8fa' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0f14' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /* Stamped during SSR from the cookie, which is the entire reason the choice
     is stored in one -- see lib/theme/store.ts. Absent means "follow the
     system", and the attribute is then omitted so the prefers-color-scheme
     query in globals.css is what decides. */
  const theme = await readTheme();

  return (
    <html
      lang="en"
      className={`${inter.variable} ${playfair.variable}`}
      data-theme={theme === 'system' ? undefined : theme}
    >
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
