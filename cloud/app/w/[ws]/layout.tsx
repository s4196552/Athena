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
    // The accent is set once here and read by every descendant, so switching
    // workspace visibly recolours the whole chrome. Sharing one library
    // between two teams gets confusing fast without that cue.
    <div className={s.shell} style={{ ['--ws-accent' as string]: ctx.workspace.accentHex }}>
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
