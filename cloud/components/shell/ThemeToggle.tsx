'use client';

import { useOptimistic, useTransition } from 'react';
import { Icon } from '@/lib/icons';
import { setThemeAction } from '@/lib/theme/actions';
import type { ThemeChoice } from '@/lib/theme/store';
import s from './topbar.module.css';

/* System / Light / Dark.
 *
 * Apple advises against an app-specific appearance setting -- someone then has
 * two places to change one thing, and an app that ignores the system choice
 * reads as broken. This exists because it was asked for, and the advice is
 * honoured in the default: System is the initial state and clears the cookie
 * rather than storing a third value, so the app follows the machine unless
 * somebody deliberately says otherwise.
 *
 * The attribute is written to <html> here, before the action is awaited. The
 * server is the source of truth -- it stamps data-theme during SSR from the
 * cookie, which is what stops the flash of the wrong appearance -- but waiting
 * for a round-trip to recolour the page would make the control feel broken.
 * useOptimistic keeps the pressed state in step with the paint.
 */

const OPTIONS: { value: ThemeChoice; icon: string; label: string }[] = [
  { value: 'system', icon: 'brightness_auto', label: 'Match the system' },
  { value: 'light', icon: 'light_mode', label: 'Light' },
  { value: 'dark', icon: 'dark_mode', label: 'Dark' },
];

export function ThemeToggle({ choice }: { choice: ThemeChoice }) {
  const [, start] = useTransition();
  const [shown, setShown] = useOptimistic(choice);

  function pick(next: ThemeChoice) {
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);

    start(async () => {
      setShown(next);
      await setThemeAction(next);
    });
  }

  return (
    <div className={s.theme} role="group" aria-label="Appearance">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={s.themeBtn}
          // Styled from the attribute rather than a parallel class, so the
          // pressed look and the announced state cannot drift apart.
          aria-pressed={shown === option.value}
          title={option.label}
          onClick={() => pick(option.value)}
        >
          <Icon name={option.icon} size={15} />
          <span className={s.srOnly}>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
