import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import s from '../(auth)/auth.module.css';
import { SignupForm } from './SignupForm';

export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  if (await getSession()) redirect('/app');

  return (
    <main className={s.shell}>
      <div className={s.card}>
        <Link href="/" className={s.brand}>
          <span className={s.mark} aria-hidden="true" />
          <span>Athena</span>
        </Link>

        <h1 className={s.title}>Create an account</h1>
        <p className={s.sub}>You will land in a personal workspace.</p>

        <SignupForm />

        <p className={s.alt}>
          Already have one? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
