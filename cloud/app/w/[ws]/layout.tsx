import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import { TopBar } from '@/components/shell/TopBar';
import s from './ws.module.css';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  const session = await requireSession(`/w/${ws}`);
  const repo = getRepository();

  const ctx = await repo.buildContext(session.user.id, ws);
  // buildContext returns null both for "no such workspace" and for "you are
  // not a member". Rendering the same 404 for each is deliberate: a 403 would
  // confirm that another tenant's workspace exists at this slug.
  if (!ctx) notFound();

  const workspaces = await repo.listWorkspacesForUser(session.user.id);
  const orgsById = new Map<string, string>();
  for (const w of workspaces) {
    if (!orgsById.has(w.orgId)) {
      orgsById.set(w.orgId, (await repo.getOrg(w.orgId))?.name ?? w.orgId);
    }
  }

  return (
    /* The workspace's colour used to be set here as --ws-accent and read by
       every control below, so switching workspace recoloured the whole chrome.
       It no longer is. Those four colours were picked for a dark-only app, and
       once there was a light theme they measured 1.4 to 2.1 against it -- on a
       selected chip, a focus ring and a view toggle, which are controls rather
       than decoration. Controls now take the one brand accent, which clears
       its floor in both appearances.
       The cue itself is not lost: the workspace colour is still the dot beside
       its name in the switcher and the picker, where it sits next to the words
       it is identifying rather than standing in for them. */
    <div className={s.shell}>
      <TopBar
        user={session.user}
        workspace={ctx.workspace}
        orgName={ctx.org.name}
        role={ctx.role}
        workspaces={workspaces.map((w) => ({
          id: w.id, slug: w.slug, name: w.name,
          accentHex: w.accentHex, orgName: orgsById.get(w.orgId) ?? '',
        }))}
      />
      <div className={s.body}>{children}</div>
    </div>
  );
}
