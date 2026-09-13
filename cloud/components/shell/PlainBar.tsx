import Link from 'next/link';
import { signOutAction } from '@/app/(auth)/actions';
import s from './topbar.module.css';

/* Chrome for the signed-in pages that sit OUTSIDE /w/[ws].
 *
 * Only /app/select qualifies today, and it had none: no way home, no way out,
 * and no indication of who was signed in. It could only be left by picking a
 * workspace, which is a dead end for anyone who arrived there by accident or
 * who wanted to sign in as somebody else.
 *
 * This deliberately reuses topbar.module.css rather than growing a second
 * stylesheet for six rules -- the two bars must stay the same height and the
 * same colour, and the surest way to guarantee that is one file.
 */

interface Props {
  user?: { name: string; email: string; avatarHue: number };
}

export function PlainBar({ user }: Props) {
  return (
    <header className={s.bar}>
      <Link href="/" className={s.brand} aria-label="Athena — home">
        <span className={s.mark} aria-hidden="true" />
      </Link>

      <div className={s.right}>
        {user && (
          <span className={s.who} title={user.email}>
            <span
              className={s.avatar}
              style={{ background: `hsl(${user.avatarHue} 55% 42%)` }}
              aria-hidden="true"
            />
            {user.name}
          </span>
        )}
        <form action={signOutAction}>
          <button className={s.signout} type="submit">Sign out</button>
        </form>
      </div>
    </header>
  );
}
