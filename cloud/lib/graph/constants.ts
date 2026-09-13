/* Graph tuning.
 *
 * The tag-graph values are ported verbatim from athena/web/queries.py so the
 * cloud view and the desktop view are the same picture. Do not adjust one
 * without the other.
 */

/** Node kinds the tag graph draws, in priority order. When the node budget
 *  runs out, earlier kinds win. `pattern` is in here because the structural
 *  findings are what make the graph explain rather than restate.
 *  (queries.py GRAPH_KINDS) */
export const GRAPH_KINDS = [
  'topic', 'doctype', 'author', 'custom', 'pattern', 'entity', 'date',
] as const;

/** A graph is a HIGH-LEVEL view; past roughly this size it stops being one.
 *  (queries.py MAX_NODES / MAX_EDGES) */
export const MAX_TAG_NODES = 60;
export const MAX_TAG_EDGES = 240;

/** Per-kind cap, applied before the global one. Without it the graph fills
 *  with whichever axis has the most values, and on a real library that is
 *  always `date` or `entity`. Years are the least informative nodes there are:
 *  every file has one, so a year connects to everything and the layout
 *  collapses into a wheel with 2024 at the hub. (queries.py MAX_PER_KIND) */
export const MAX_PER_KIND = 12;

/** Two files sharing a pair of tags is a coincidence; five is a structure.
 *  (queries.py MIN_EDGE_WEIGHT) */
export const MIN_EDGE_WEIGHT = 2;

// ---------------------------------------------------------------------------
//  File graph
// ---------------------------------------------------------------------------

/** Default node budget for the file view. Past this the picture stops being
 *  readable before it stops being fast, so the cap is about legibility. */
export const DEFAULT_FILE_NODES = 2000;
export const MAX_FILE_NODES = 4000;

/** Unmatched nodes: a desaturated cousin of --faint, quiet enough that the
 *  coloured clusters read against it. */
export const DEFAULT_NODE_COLOR = '#495663';
