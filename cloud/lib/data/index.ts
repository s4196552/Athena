import 'server-only';
import type { AthenaRepository } from './repository';
import { jsonRepository } from './json/jsonRepository';

/* The driver switch.
 *
 * One line changes when the committed fixtures become a real database:
 *
 *   case 'postgres': return postgresRepository;
 *
 * Nothing that calls getRepository() needs to know which driver answered, and
 * no page or component imports a driver directly -- the ESLint rule in
 * eslint.config.mjs enforces that, so the boundary cannot rot quietly.
 */
export function getRepository(): AthenaRepository {
  const driver = process.env.ATHENA_DATA_DRIVER ?? 'json';
  switch (driver) {
    case 'json':
      return jsonRepository;
    default:
      throw new Error(
        `Unknown ATHENA_DATA_DRIVER "${driver}". Known drivers: json.`,
      );
  }
}

export type { AthenaRepository, WorkspaceContext, FileQuery, FilePage, FacetGroup } from './repository';
