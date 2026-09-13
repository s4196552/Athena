import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, demoAccounts } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import s from '../(auth)/auth.module.css';
import { AccountPicker } from './AccountPicker';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Next 16: searchParams is a Promise.
  const { next } = await searchParams;

  if (await getSession()) redirect(next ?? '/app');

  /* Each account is listed with the workspaces it can reach, because the point
     of the demo is the tenancy model and this is the fastest way to show it.
     Priya is the interesting one: she is in Marketing AND Finance, which is
     what makes the workspace switcher worth opening. */
  const repo = getRepository();
  const users = await demoAccounts();
  const accounts = await Promise.all(
    users.map(async (u) => {
      const ws = await repo.listWorkspacesForUser(u.id);
      return {
        email: u.email,
        name: u.name,
        avatarHue: u.avatarHue,
        where: ws.map((w) => w.name).join(' + ') || 'no workspace',
      };
    }),
  );

  return (
    <main className={s.shell}>
      <div className={s.card}>
        <Link href="/" className={s.brand}>
          <span className={s.mark} aria-hidden="true" />
          <span>Athena</span>
        </Link>

        <h1 className={s.title}>Choose an account</h1>
        <p className={s.sub}>
          Pick a name to open its workspaces and their shared library.
        </p>

        <AccountPicker next={next ?? null} accounts={accounts} />

        <p className={s.note}>
          This is a demo with no sign-up and no passwords. Every account below is
          a fixture, and the library they read is sample data committed to the
          repository — so there is nothing to authenticate and nothing private
          behind it. Real accounts would change that, and the sign-in boundary in{' '}
          <code>lib/auth</code> is built for the swap.
        </p>

        <p className={s.alt}>
          Try <strong>Priya Raman</strong> — she is in both Marketing and
          Finance, which share one catalogue.
        </p>
      </div>
    </main>
  );
}
