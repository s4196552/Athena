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
/* Nodes no colour rule matched.
 *
 * Was #495663, which is 2.56:1 against the page -- under the 3:1 the HIG gives
 * for a meaningful graphical object, and these are not decoration: an unmatched
 * node is a file, and being unable to see it is being unable to see that it is
 * there. #677686 clears 4:1 against BOTH appearances, which matters because a
 * canvas colour cannot be swapped by the cascade. */
export const DEFAULT_NODE_COLOR = '#677686';

// ---------------------------------------------------------------------------
//  Pyramid (layered) graph
// ---------------------------------------------------------------------------

/* The pyramid draws the same tags as the tag graph, but as a hierarchy rather
 * than a cloud. Its edges are a different relation -- containment, not
 * co-occurrence -- so it gets its own thresholds. */

/** Fraction of a tag's files that must also carry another tag before the
 *  second is treated as its parent. At 0.6, "six in ten Invoices are also
 *  Finance" makes Finance the broader tag; below that the two merely overlap
 *  and a hierarchy would be asserting something the data does not say. */
export const MIN_CONTAINMENT = 0.6;

/** The co-occurrence table the pyramid reads must not be truncated the way the
 *  tag graph's is: the tag graph keeps the 240 strongest edges because it only
 *  has to look right, whereas a dropped pair here silently removes a level
 *  from the hierarchy. 60 nodes is 1,770 pairs, which is nothing to compute
 *  and ~60 KB to ship. */
export const MAX_PYRAMID_EDGES = (MAX_TAG_NODES * (MAX_TAG_NODES - 1)) / 2;

/** World units. The pitch is the minimum gap between neighbours in a row and
 *  therefore sets how wide the base gets; the row height is the gap between
 *  levels. Both are defaults the sliders move. */
export const PYRAMID_PITCH = 108;
export const PYRAMID_ROW = 96;

/** Narrowest the wrapped block of unattached tags is allowed to get. Without a
 *  floor, a library with a two-tag hierarchy and thirty loose tags would stack
 *  them fifteen rows deep. */
export const MIN_LOOSE_ROW = 10;
