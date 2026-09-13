'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import s from './topbar.module.css';

interface Props {
  current: { slug: string; name: string; accentHex: string };
  orgName: string;
  role: string;
  workspaces: { id: string; slug: string; name: string; accentHex: string; orgName: string }[];
}

/* The switcher is the screen that makes "shared database" legible: the same
 * person, moving between two workspaces, watching the file count and the tag
 * axes change while the library underneath stays the same. */
export function WorkspaceSwitcher({ current, orgName, role, workspaces }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const byOrg = new Map<string, typeof workspaces>();
  for (const w of workspaces) {
    if (!byOrg.has(w.orgName)) byOrg.set(w.orgName, []);
    byOrg.get(w.orgName)!.push(w);
  }

  return (
    <div className={s.switcher} ref={ref}>
      <button
        type="button"
        className={s.current}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className={s.dot} style={{ background: current.accentHex }} aria-hidden="true" />
        <span className={s.org}>{orgName}</span>
        <span className={s.sep}>/</span>
        <span className={s.wsName}>{current.name}</span>
        <span className={s.role}>{role}</span>
        <span className={s.caret} aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className={s.menu} role="menu">
          {[...byOrg.entries()].map(([org, list]) => (
            <div key={org} className={s.menuGroup}>
              <p className={s.menuOrg}>{org}</p>
              {list.map((w) => (
                <Link
                  key={w.id}
                  href={`/w/${w.slug}`}
                  className={`${s.menuItem} ${w.slug === current.slug ? s.menuItemActive : ''}`}
                  onClick={() => setOpen(false)}
                  role="menuitem"
                >
                  <span className={s.dot} style={{ background: w.accentHex }} aria-hidden="true" />
                  {w.name}
                </Link>
              ))}
            </div>
          ))}
          <div className={s.menuGroup}>
            <Link href="/app/select" className={s.menuItem} onClick={() => setOpen(false)}>
              All workspaces…
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
