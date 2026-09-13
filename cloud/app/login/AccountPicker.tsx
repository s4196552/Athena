'use client';

import { useActionState } from 'react';
import { signInAction, type FormState } from '../(auth)/actions';
import s from '../(auth)/auth.module.css';

interface Account {
  email: string;
  name: string;
  avatarHue: number;
  where: string;
}

/* No password field, because there is no password.
 *
 * The accounts are fixtures and the catalogue behind them is committed to the
 * repository, so a credential form would have been theatre -- it would accept
 * any string and imply a check that never happened. Picking a name is the
 * honest interface for that, and it is also the fastest way into the thing
 * worth looking at.
 *
 * Each account is its own <form> with a hidden field rather than a click
 * handler, so the picker works with JavaScript disabled and goes through
 * exactly the same server action a typed login would have used.
 */
export function AccountPicker({ next, accounts }: { next: string | null; accounts: Account[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signInAction, {});

  return (
    <>
      {state.error && <p className={s.error}>{state.error}</p>}

      <div className={s.chips}>
        {accounts.map((a) => (
          <form key={a.email} action={action}>
            <input type="hidden" name="email" value={a.email} />
            <input type="hidden" name="next" value={next ?? ''} />
            <button className={s.chip} type="submit" disabled={pending}>
              <span
                className={s.avatar}
                style={{ background: `hsl(${a.avatarHue} 55% 42%)` }}
                aria-hidden="true"
              />
              <span className={s.chipName}>{a.name}</span>
              <span className={s.chipWhere}>{a.where}</span>
            </button>
          </form>
        ))}
      </div>

      {pending && <p className={s.pending}>Signing in…</p>}
    </>
  );
}
