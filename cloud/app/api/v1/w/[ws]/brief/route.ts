import { produceBrief } from '@/lib/brief/produce';
import { apiJson, apiWorkspace } from '@/lib/api/route';
import type { BriefResponse } from '@/lib/api/types';

/* "What is this selection?" over HTTP.
 *
 * GET, not POST, and that is a real decision rather than a habit. A brief is a
 * pure function of a filter -- no state changes, the same filter gives the
 * same answer -- so it belongs in a URL a person can paste, bookmark and diff.
 * The `model=off` escape below only makes sense in a GET too.
 *
 * It takes the same parameters as /files, so the CLI can read a table and then
 * ask what it adds up to without restating the filter.
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ws: string }> },
) {
  const { ws } = await params;
  const gate = await apiWorkspace(ws);
  if ('response' in gate) return gate.response;

  const url = new URL(request.url);

  /* `?model=off` asks for the counted brief only, never spending a call.
     Worth offering because a script looping over twenty filters would
     otherwise burn the day's budget on prose nobody reads, and the counted
     half is the half carrying every number. */
  const wantsModel = url.searchParams.get('model') !== 'off';

  // The filter is whatever else is in the query string, which is exactly what
  // the page passes and what /files accepts.
  const filter = new URLSearchParams(url.searchParams);
  filter.delete('model');

  const brief = await produceBrief(gate.ctx, filter.toString(), {
    model: wantsModel ? 'allow' : 'cached-only',
  });

  return apiJson<BriefResponse>(brief);
}
