import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import { describeScope } from '@/lib/data/json/scope';
import { formatBytes, formatNumber } from '@/lib/format';
import s from './sharing.module.css';

export const dynamic = 'force-dynamic';

/* The sharing screen.
 *
 * This is the page that makes the tenancy model legible to someone who has not
 * read the types: one library, several workspaces, each with a scope and a
 * resulting file count they can check. "Shared" stops being an abstraction the
 * moment you can see two teams reading the same row count differently.
 */
export default async function LibrarySharingPage({
  params,
}: {
  params: Promise<{ org: string; lib: string }>;
}) {
  const { org: orgSlug, lib: libSlug } = await params;
  const session = await requireSession(`/org/${orgSlug}/libraries/${libSlug}`);
  const repo = getRepository();

  const org = await repo.getOrgBySlug(orgSlug);
  const lib = await repo.getLibraryBySlug(libSlug);
  if (!org || !lib || lib.ownerOrgId !== org.id) notFound();

  // You may see this page only if you are in the owning org, or in a workspace
  // that holds a grant on it. Same reasoning as the workspace layout: absence
  // rather than refusal.
  const orgMemberships = await repo.getOrgMemberships(session.user.id);
  const mine = await repo.listWorkspacesForUser(session.user.id);
  const allGrants = await repo.listGrantsForLibrary(lib.id);

  const inOwningOrg = orgMemberships.some((m) => m.orgId === org.id);
  const viaGrant = allGrants.some((g) => mine.some((w) => w.id === g.workspaceId));
  if (!inOwningOrg && !viaGrant) notFound();

  const orgWorkspaces = await repo.listWorkspacesInOrg(org.id);

  const rows = await Promise.all(
    allGrants.map(async (g) => {
      const ws = orgWorkspaces.find((w) => w.id === g.workspaceId)
        ?? mine.find((w) => w.id === g.workspaceId);
      const wsOrg = ws ? await repo.getOrg(ws.orgId) : null;
      return {
        id: g.id,
        name: ws?.name ?? g.workspaceId,
        slug: ws?.slug,
        accent: ws?.accentHex ?? 'var(--faint)',
        orgName: wsOrg?.name ?? '',
        crossOrg: Boolean(wsOrg && wsOrg.id !== org.id),
        access: g.access,
        scope: describeScope(g.scope),
        visible: await repo.countForGrant(g),
        isPrimary: g.isPrimary,
      };
    }),
  );

  rows.sort((a, b) => b.visible - a.visible);

  return (
    <main className={s.page}>
      <p className={s.crumb}>
        <Link href="/app">{org.name}</Link> / Libraries
      </p>
      <h1 className={s.h1}>{lib.name}</h1>
      <p className={s.sub}>
        Indexed from <code>{lib.rootLabel}</code> · {formatNumber(lib.fileCount)} files ·{' '}
        {formatNumber(lib.tagCount)} tags · {formatBytes(lib.bytes)} ·{' '}
        <span className={s.ok}>{lib.mutations} files modified</span>
      </p>

      <section className={s.section}>
        <h2 className={s.sect}>Shared with</h2>
        <p className={s.explain}>
          Each row is a <strong>grant</strong>: one workspace&rsquo;s view of this
          catalogue. They all read the same rows — nothing here is a copy, so a
          tag applied in one workspace is the same tag another filters on. What
          differs is scope.
        </p>

        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Access</th>
                <th>Scope</th>
                <th className={s.num}>Files visible</th>
                <th className={s.num}>Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className={s.wsCell}>
                      <span className={s.dot} style={{ background: r.accent }} aria-hidden="true" />
                      {r.slug ? <Link href={`/w/${r.slug}`}>{r.name}</Link> : r.name}
                      {r.crossOrg && (
                        <span className={s.tag} title={`Belongs to ${r.orgName}`}>
                          {r.orgName}
                        </span>
                      )}
                      {r.isPrimary && <span className={s.primary}>primary</span>}
                    </span>
                  </td>
                  <td><code>{r.access}</code></td>
                  <td className={s.scope}>{r.scope}</td>
                  <td className={s.num}>{formatNumber(r.visible)}</td>
                  <td className={s.num}>
                    <span className={s.bar}>
                      <span
                        className={s.barFill}
                        style={{
                          width: `${Math.round((r.visible / Math.max(lib.fileCount, 1)) * 100)}%`,
                          background: r.accent,
                        }}
                      />
                    </span>
                    {Math.round((r.visible / Math.max(lib.fileCount, 1)) * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length > 1 && (
          <p className={s.note}>
            {rows[0].name} and {rows[1].name} both read{' '}
            <strong>{lib.name}</strong>. Changing a scope changes what a team
            sees; it never changes the catalogue, and it never duplicates a file.
          </p>
        )}
      </section>

      <section className={s.section}>
        <h2 className={s.sect}>What a scope can narrow</h2>
        <ul className={s.rules}>
          <li><strong>Folders</strong> — a path prefix, such as <code>Documents/</code>.</li>
          <li><strong>Topics</strong> — any of a set of tags, OR&rsquo;d together.</li>
          <li><strong>Media types</strong> — images, video, audio, documents.</li>
          <li>
            <strong>Exclusions</strong> — which always win over inclusions, because
            that is the only rule that makes a deny list trustworthy.
          </li>
        </ul>
        <p className={s.explain}>
          Within a field the values are OR&rsquo;d; across fields they are AND&rsquo;d
          — the same algebra the desktop app&rsquo;s filters use, so a scope and a
          saved view mean the same thing.
        </p>
      </section>
    </main>
  );
}
