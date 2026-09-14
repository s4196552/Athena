import { getRepository } from '@/lib/data';
import { planView, type ViewPlan, type Vocabulary } from '@/lib/agent/view';
import { planKey, recallAnswer, rememberAnswer } from '@/lib/agent/recall';
import { toSearchParams } from '@/lib/filter/params';
import { checkBudget, spend } from '@/lib/brief/budget';
import { geminiStatus, GeminiError } from '@/lib/ai/gemini';
import { apiJson, apiWorkspace, fail } from '@/lib/api/route';
import type { AskResponse } from '@/lib/api/types';

/* "Show me how finance and legal overlap", from a terminal.
 *
 * POST rather than GET, and for the opposite reason /brief is a GET: this
 * SPENDS something. A model call behind a GET is a URL that costs money when a
 * crawler, a link preview or a browser prefetch touches it, and every one of
 * those follows GETs by design.
 *
 * The split the web UI makes is kept exactly: the model chooses a filter and a
 * drawing, and the repository does the counting. `matches` below is arithmetic
 * over the catalogue, never a number the model produced.
 *
 * It shares the web UI's memory of what the agent said, which is one decision
 * with two consequences. The same question asked twice -- from a terminal, from
 * a browser, or one of each -- is one model call rather than two. And an answer
 * produced here can be READ ALOUD by the browser afterwards, because the speech
 * route can only ever replay a remembered answer and never generate one.
 */

const MAX_QUESTION = 300;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ws: string }> },
) {
  const { ws } = await params;
  const gate = await apiWorkspace(ws);
  if ('response' in gate) return gate.response;
  const { ctx } = gate;

  let question = '';
  try {
    const body = await request.json();
    if (typeof body?.question === 'string') question = body.question.trim().slice(0, MAX_QUESTION);
  } catch {
    return fail(400, 'Send a JSON body.', 'For example: {"question":"what did aria chen do in 2024"}');
  }

  if (!question) {
    return fail(400, 'A question is required.', 'Try "how do finance and legal overlap".');
  }

  const repo = getRepository();
  const key = planKey(ctx.workspace.id, question);
  const remembered = recallAnswer(key);

  let plan: ViewPlan;

  if (remembered?.kind === 'plan') {
    plan = remembered.plan;
  } else {
    if (!geminiStatus().configured) {
      return fail(
        503,
        'No model is configured on this server, so questions cannot be turned into views.',
        'The facet rail and `athena-cloud ls --topic finance` do the same job by hand.',
      );
    }

    const budget = await checkBudget();
    if (!budget.allowed) {
      // 429 with the reason the UI would have shown. A CLI can back off on the
      // status; a person needs the sentence.
      return fail(429, budget.reason ?? 'Out of model calls for today.', 'Resets at midnight UTC.');
    }

    const tags = await repo.listTags(ctx);

    /* THIS workspace's vocabulary, so a question can never be answered with a
       tag the caller has no grant to see. */
    const vocab: Vocabulary = {};
    for (const tag of tags) {
      (vocab[tag.kind] ??= []).push({
        name: tag.name,
        display: tag.displayName,
        count: tag.fileCount,
      });
    }
    for (const list of Object.values(vocab)) list.sort((a, b) => b.count - a.count);

    try {
      plan = await planView(question, vocab);
      await spend();
    } catch (err) {
      const detail = err instanceof GeminiError ? err.message : 'The model could not be reached.';
      return fail(502, detail);
    }
  }

  /* Recounted even on a remembered plan. The filter is what was remembered;
     the number is not, and a tag corrected since would have changed it. */
  const tagFilter = Object.keys(plan.tags).length ? plan.tags : undefined;
  const page = await repo.listFiles(ctx, {
    tags: tagFilter,
    q: plan.q,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const matches = page.files.length;

  rememberAnswer(key, { kind: 'plan', question, plan, matches });

  const sp = toSearchParams({ tags: tagFilter, q: plan.q });
  const libraryPath = `/w/${ws}/library${sp.toString() ? `?${sp}` : ''}`;
  sp.set('mode', plan.mode);

  return apiJson<AskResponse>({
    question,
    mode: plan.mode,
    title: plan.title,
    why: plan.why,
    tags: plan.tags,
    ...(plan.q ? { q: plan.q } : {}),
    dropped: plan.dropped,
    matches,
    graphPath: `/w/${ws}/graph?${sp}`,
    libraryPath,
    model: plan.model,
  });
}
