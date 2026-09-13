'use client';

import { useActionState, useRef } from 'react';
import { signInAction, type FormState } from '../(auth)/actions';
import s from '../(auth)/auth.module.css';

interface Chip {
  user: { id: string; email: string; name: string; avatarHue: number };
  where: string;
}

export function LoginForm({ next, chips }: { next: string | null; chips: Chip[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signInAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  /* A demo chip fills the email in and submits the same form the typed path
     uses, rather than calling a separate "log in as" endpoint. One code path
     means the shortcut cannot drift from the real thing. */
  function fillAndSubmit(email: string) {
    if (!emailRef.current || !formRef.current) return;
    emailRef.current.value = email;
    formRef.current.requestSubmit();
  }

  return (
    <>
      <form ref={formRef} action={action} className={s.form}>
        <input type="hidden" name="next" value={next ?? ''} />

        <div className={s.field}>
          <label className={s.label} htmlFor="email">Email</label>
          <input
            ref={emailRef}
            className={s.input}
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
          />
        </div>

        <div className={s.field}>
          <label className={s.label} htmlFor="password">Password</label>
          <input
            className={s.input}
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="anything at all"
          />
        </div>

        {state.error && <p className={s.error}>{state.error}</p>}

        <button className={s.submit} type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>

        <p className={s.note}>
          Accounts are mocked for this demo: any password is accepted for a
          seeded email address. Nothing here is a real credential check.
        </p>
      </form>

      <div className={s.divider}>or use a demo account</div>

      <div className={s.chips}>
        {chips.map(({ user, where }) => (
          <button
            key={user.id}
            type="button"
            className={s.chip}
            onClick={() => fillAndSubmit(user.email)}
            disabled={pending}
          >
            <span
              className={s.avatar}
              style={{ background: `hsl(${user.avatarHue} 55% 42%)` }}
              aria-hidden="true"
            />
            <span className={s.chipName}>{user.name}</span>
            <span className={s.chipWhere}>{where}</span>
          </button>
        ))}
      </div>
    </>
  );
}
