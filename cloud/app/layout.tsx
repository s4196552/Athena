import type { Metadata, Viewport } from 'next';
import './globals.css';

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
  themeColor: '#0d1117',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
