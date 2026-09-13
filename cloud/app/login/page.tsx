import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, demoAccounts } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import s from '../(auth)/auth.module.css';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Next 16: searchParams is a Promise.
  const { next } = await searchParams;

  if (await getSession()) redirect(next ?? '/app');

  // Demo chips carry the workspaces each account can reach, because the point
  // of the demo is the tenancy model and that is the fastest way to show it.
  const repo = getRepository();
  const users = await demoAccounts();
  const chips = await Promise.all(
    users.map(async (u) => {
      const ws = await repo.listWorkspacesForUser(u.id);
      return { user: u, where: ws.map((w) => w.name).join(' + ') || 'no workspace' };
    }),
  );

  return (
    <main className={s.shell}>
      <div className={s.card}>
        <Link href="/" className={s.brand}>
          <span className={s.mark} aria-hidden="true" />
          <span>Athena</span>
        </Link>

        <h1 className={s.title}>Sign in</h1>
        <p className={s.sub}>Open a shared library and its graph.</p>

        <LoginForm next={next ?? null} chips={chips} />

        <p className={s.alt}>
          No account? <Link href="/signup">Create one</Link>
        </p>
      </div>
    </main>
  );
}
