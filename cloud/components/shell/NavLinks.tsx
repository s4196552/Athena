'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import s from './topbar.module.css';

/* The workspace nav, split out of TopBar purely because knowing which page you
 * are on requires the pathname, and the pathname requires a client component.
 *
 * The active state is expressed as `aria-current="page"` and STYLED from that
 * attribute rather than from a parallel class. The app already has a bug of
 * that second shape -- LibraryBrowser and GraphClient both set `aria-pressed`
 * and then colour themselves with a separate `.modeOn` class, so the two can
 * drift apart. One source for both is the fix.
 */

interface Props {
  base: string;
}

const ITEMS = [
  { href: '', label: 'Overview' },
  { href: '/library', label: 'Library' },
  { href: '/graph', label: 'Graph' },
  { href: '/agent', label: 'Agent' },
  { href: '/settings/colors', label: 'Colours' },
];

export function NavLinks({ base }: Props) {
  const pathname = usePathname();

  return (
    <nav className={s.nav} aria-label="Workspace">
      {ITEMS.map((item) => {
        const href = `${base}${item.href}`;
        // Overview is the bare base, so it must match exactly or it would claim
        // to be current on every page beneath it.
        const current = item.href === ''
          ? pathname === base
          : pathname === href || pathname.startsWith(`${href}/`);

        return (
          <Link
            key={item.label}
            href={href}
            className={s.link}
            aria-current={current ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
