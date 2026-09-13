'use client';

import { useActionState } from 'react';
import { signUpAction, type FormState } from '../(auth)/actions';
import s from '../(auth)/auth.module.css';

export function SignupForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signUpAction, {});

  return (
    <form action={action} className={s.form}>
      <div className={s.field}>
        <label className={s.label} htmlFor="name">Name</label>
        <input className={s.input} id="name" name="name" autoComplete="name" placeholder="Your name" required />
      </div>

      <div className={s.field}>
        <label className={s.label} htmlFor="email">Email</label>
        <input className={s.input} id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required />
      </div>

      <div className={s.field}>
        <label className={s.label} htmlFor="password">Password</label>
        <input className={s.input} id="password" name="password" type="password" autoComplete="new-password" placeholder="At least six characters" required minLength={6} />
      </div>

      {state.error && <p className={s.error}>{state.error}</p>}

      <button className={s.submit} type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create account'}
      </button>

      {/* Said plainly, because the alternative is someone reporting data loss
          for behaviour that is working as designed. */}
      <p className={s.note}>
        Mock accounts live only for as long as the server process. On a
        serverless deploy that can be a single request, so an account created
        here may not exist a minute later. Sign-up is present to show the flow —
        use a demo account on the sign-in page to explore the data.
      </p>
    </form>
  );
}
