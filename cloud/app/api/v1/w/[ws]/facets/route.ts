import { getRepository } from '@/lib/data';
import { parseFilterParams } from '@/lib/filter/params';
import { apiJson, apiWorkspace } from '@/lib/api/route';
import type { FacetsResponse } from '@/lib/api/types';

/* The facet rail, as JSON.
 *
 * Takes the same filter as /files, because facet counts are RELATIVE to the
 * current selection -- "how many of what I am already looking at are also
 * invoices". A rail computed against the whole library instead would offer
 * refinements that lead to nothing, which is the classic broken-facet bug.
 *
 * Tag ids are dropped on the way out. They are a detail of this repository
 * driver, they are not stable across a reseed, and a client that stored one
 * would be storing something that means nothing tomorrow. Names are the
 * stable identifier and the thing the filter takes anyway.
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ws: string }> },
) {
  const { ws } = await params;
  const gate = await apiWorkspace(ws);
  if ('response' in gate) return gate.response;

  const query = parseFilterParams(new URL(request.url).searchParams);
  const groups = await getRepository().facets(gate.ctx, query);

  return apiJson<FacetsResponse>({
    axes: groups.map((g) => ({
      kind: g.kind,
      label: g.label,
      values: g.values.map((v) => ({ name: v.name, display: v.display, count: v.count })),
    })),
  });
}
