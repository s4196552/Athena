'use server';

import { requireSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import { produceBrief } from '@/lib/brief/produce';
import type { BriefResult } from '@/lib/brief/types';

/* "Summarise this selection."
 *
 * The user flow from athena/agent/brief.py, brought to the web: filter to
 * Finance + Aria Chen, look at eleven documents, and ask what they add up to.
 * That is a question about a SET, which is the thing a file manager has never
 * been able to answer.
 *
 * The work itself lives in lib/brief/produce.ts, so that the speech route can
 * rebuild the same brief without going through a server action -- see the
 * header there for why that mattered. What stays here is what makes this an
 * ACTION: the session, the workspace, and the failure shape a client component
 * can render.
 */

export type { BriefResult };

export async function summarise(ws: string, queryString: string): Promise<BriefResult> {
  const session = await requireSession(`/w/${ws}/library`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) {
    return {
      title: 'Not available',
      body: 'That workspace is not available.',
      producedBy: 'none',
      files: 0,
    };
  }

  // The counted brief is always produced; the model only ever adds an opening
  // paragraph on top of it. Every failure path inside degrades to the counted
  // brief rather than to an error, because the counted brief is the answer.
  return produceBrief(ctx, queryString, { model: 'allow' });
}
