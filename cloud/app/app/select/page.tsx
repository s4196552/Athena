import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import { describeScope } from '@/lib/data/json/scope';
import { formatCount } from '@/lib/format';
import { PlainBar } from '@/components/shell/PlainBar';
import s from './select.module.css';

export const dynamic = 'force-dynamic';

export default async function SelectWorkspace() {
  const session = await requireSession('/app/select');
  const repo = getRepository();
  const workspaces = await repo.listWorkspacesForUser(session.user.id);

  // Group by org, because "which company" is the first distinction a person
  // makes and the second is "which team".
  const byOrg = new Map<string, { name: string; rows: React.ReactNode[] }>();

  for (const ws of workspaces) {
    const org = await repo.getOrg(ws.orgId);
    const ctx = await repo.buildContext(session.user.id, ws.slug);
    if (!org || !ctx) continue;

    const summary = await repo.summary(ctx);
    const libs = await Promise.all(
      ctx.grants.map(async (g) => ({
        name: (await repo.getLibrary(g.libraryId))?.name ?? g.libraryId,
        scope: describeScope(g.scope),
        access: g.access,
      })),
    );

    if (!byOrg.has(org.id)) byOrg.set(org.id, { name: org.name, rows: [] });
    byOrg.get(org.id)!.rows.push(
      <Link key={ws.id} href={`/w/${ws.slug}`} className={s.card}>
        <div className={s.head}>
          <span className={s.dot} style={{ background: ws.accentHex }} aria-hidden="true" />
          <span className={s.name}>{ws.name}</span>
          <span className={s.role}>{ctx.role}</span>
        </div>
        <p className={s.count}>
          {formatCount(summary.files, 'file')} · {formatCount(summary.tags, 'tag')}
        </p>
        <ul className={s.libs}>
          {libs.map((l) => (
            <li key={l.name}>
              <span className={s.libName}>{l.name}</span>
              <span className={s.libScope}>{l.scope}</span>
            </li>
          ))}
        </ul>
      </Link>,
    );
  }

  return (
    <>
      <PlainBar user={session.user} />
      <main className={s.shell} id="main">
        <div className={s.wrap}>
          <h1 className={s.title}>Choose a workspace</h1>
          <p className={s.sub}>
            Signed in as {session.user.name}. A workspace is a team&rsquo;s view of a
            library — two teams can share one catalogue and still see different
            slices of it.
          </p>

          {[...byOrg.values()].map((org) => (
            <section key={org.name} className={s.org}>
              <h2 className={s.orgName}>{org.name}</h2>
              <div className={s.grid}>{org.rows}</div>
            </section>
          ))}

          {workspaces.length === 0 && (
            <p className={s.empty}>
              This account is not a member of any workspace yet. Ask an owner to
              invite you, or sign in as one of the demo accounts to look around.
              {' '}
              <Link href="/login">Switch account</Link>
            </p>
          )}
        </div>
      </main>
    </>
  );
}
