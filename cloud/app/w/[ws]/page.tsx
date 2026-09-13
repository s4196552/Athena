import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import { workspaceContext } from '@/lib/data/context';
import { describeScope } from '@/lib/data/json/scope';
import { formatBytes, formatNumber } from '@/lib/format';
import s from './ws.module.css';

export const dynamic = 'force-dynamic';

export default async function WorkspaceOverview({
  params,
}: {
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  const session = await requireSession(`/w/${ws}`);
  const repo = getRepository();

  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) notFound();

  const [summary, facets, views] = await Promise.all([
    repo.summary(ctx),
    repo.facets(ctx, {}),
    repo.listSavedViews(ctx),
  ]);

  // For each granted library, also report who else can see it. That single
  // line is what makes the sharing model visible without reading any docs.
  const libs = await Promise.all(
    ctx.grants.map(async (g) => {
      const lib = await repo.getLibrary(g.libraryId);
      const all = await repo.listGrantsForLibrary(g.libraryId);
      const others = await Promise.all(
        all
          .filter((o) => o.workspaceId !== ctx.workspace.id)
          .map(async (o) => {
            const w = (await repo.listWorkspacesInOrg(ctx.org.id)).find((x) => x.id === o.workspaceId);
            if (w) return w.name;
            // Cross-org share: the other workspace is in a different org.
            const every = await repo.listWorkspacesForUser(session.user.id);
            return every.find((x) => x.id === o.workspaceId)?.name ?? 'another team';
          }),
      );
      // The sharing page is addressed by slug, and by the slug of the org that
      // OWNS the library -- which is not always this workspace's org, because a
      // library can be granted across orgs.
      const ownerOrg = lib ? await repo.getOrg(lib.ownerOrgId) : null;

      return {
        id: g.libraryId,
        name: lib?.name ?? g.libraryId,
        rootLabel: lib?.rootLabel ?? '',
        access: g.access,
        scope: describeScope(g.scope),
        visible: await repo.countForGrant(g),
        total: lib?.fileCount ?? 0,
        others,
        href: lib && ownerOrg ? `/org/${ownerOrg.slug}/libraries/${lib.slug}` : null,
      };
    }),
  );

  const topics = facets.find((f) => f.kind === 'topic');
  const base = `/w/${ws}`;

  return (
    <main className={s.wrap} id="main">
      <h1 className={s.title}>{ctx.workspace.name}</h1>
      <p className={s.subtitle}>
        {ctx.org.name} · you are {ctx.role === 'admin' ? 'an' : 'a'} {ctx.role}
      </p>

      <div className={s.stats}>
        <div className={s.stat}>
          <div className={s.statValue}>{formatNumber(summary.files)}</div>
          <div className={s.statLabel}>Files in scope</div>
        </div>
        <div className={s.stat}>
          <div className={s.statValue}>{formatNumber(summary.tags)}</div>
          <div className={s.statLabel}>Distinct tags</div>
        </div>
        <div className={s.stat}>
          <div className={s.statValue}>{formatBytes(summary.bytes)}</div>
          <div className={s.statLabel}>Indexed</div>
        </div>
        <div className={s.stat}>
          {/* The guarantee, carried through from the engine to the web app.
              The desktop UI shows the same badge in its top bar. */}
          <div className={`${s.statValue} ${s.statOk}`}>0</div>
          <div className={s.statLabel}>Files modified</div>
        </div>
      </div>

      <section className={s.section}>
        <h2 className={s.sect}>Libraries</h2>
        <div className={s.libs}>
          {libs.map((l) => (
            <div key={l.id} className={s.lib}>
              <div className={s.libHead}>
                <span className={s.libName}>{l.name}</span>
                <span className={s.libAccess}>{l.access}</span>
              </div>
              <dl>
                <div className={s.libRow}>
                  <dt>Indexed root</dt>
                  <dd><code>{l.rootLabel}</code></dd>
                </div>
                <div className={s.libRow}>
                  <dt>Your scope</dt>
                  <dd>{l.scope}</dd>
                </div>
                <div className={s.libRow}>
                  <dt>Visible to you</dt>
                  <dd>
                    {formatNumber(l.visible)}
                    {l.visible !== l.total && (
                      <span style={{ color: 'var(--faint)' }}> of {formatNumber(l.total)}</span>
                    )}
                  </dd>
                </div>
              </dl>
              {l.others.length > 0 && (
                <p className={s.shared}>
                  Also shared with{' '}
                  <span className={s.sharedWith}>{l.others.join(', ')}</span> — the same
                  catalogue, not a copy.
                </p>
              )}
              {l.href && (
                <p className={s.libLink}>
                  <Link href={l.href}>Who else can see this library →</Link>
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {topics && topics.values.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sect}>Topics in scope</h2>
          <div className={s.chips}>
            {topics.values.slice(0, 12).map((v) => (
              <Link key={v.tagId} href={`${base}/library?topic=${encodeURIComponent(v.name)}`} className={s.chip}>
                {v.display}
                <span className={s.chipCount}>{formatNumber(v.count)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {views.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sect}>Saved views</h2>
          <ul className={s.viewList}>
            {views.map((v) => (
              <li key={v.id}>
                <Link href={`${base}/library?${v.query}`} className={s.viewItem}>
                  <span>{v.name}</span>
                  <span className={s.viewQuery}>{v.query}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={s.section}>
        <h2 className={s.sect}>Explore</h2>
        <div className={s.cta}>
          <Link href={`${base}/graph`} className={`${s.btn} ${s.btnPrimary}`}>Open the graph</Link>
          <Link href={`${base}/library`} className={s.btn}>Browse files</Link>
        </div>
      </section>
    </main>
  );
}
