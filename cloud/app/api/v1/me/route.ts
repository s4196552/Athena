import { apiJson, apiSession } from '@/lib/api/route';
import { describeUser } from '@/lib/api/identity';
import type { MeResponse } from '@/lib/api/types';
import type { UserId } from '@/lib/data/types';

/** Who the cookie belongs to, and which workspaces it can reach. Also the
 *  cheapest way for a client to find out its stored session has expired, which
 *  is why `athena-cloud whoami` is the first thing the CLI suggests on a 401. */
export async function GET() {
  const gate = await apiSession();
  if ('response' in gate) return gate.response;

  return apiJson<MeResponse>(
    await describeUser(gate.session.user.id as UserId, gate.session.expiresAt),
  );
}
