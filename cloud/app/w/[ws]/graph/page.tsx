import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { requireSession } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import { GraphClient } from './GraphClient';

export const dynamic = 'force-dynamic';

export default async function GraphPage({
  params,
}: {
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  const session = await requireSession(`/w/${ws}/graph`);
  const repo = getRepository();

  const ctx = await repo.buildContext(session.user.id, ws);
  if (!ctx) notFound();

  /* Colour groups are per workspace, which is the point: Marketing and Finance
     share one catalogue and still colour it differently, because a palette is
     a way of looking rather than a property of the data. */
  const [fileGroups, tagGroups] = await Promise.all([
    repo.getColorGroups(ctx, 'files'),
    repo.getColorGroups(ctx, 'tags'),
  ]);

  return (
    <Suspense fallback={null}>
      <GraphClient
        ws={ws}
        fileRules={fileGroups?.rules ?? []}
        tagRules={tagGroups?.rules ?? []}
      />
    </Suspense>
  );
}
