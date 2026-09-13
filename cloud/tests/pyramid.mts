/* The pyramid layout, checked without a browser.
 *
 *   npm run check:pyramid
 *
 * The HTTP checks in verify.mjs cover the payload the view is fed; this covers
 * what it does with it, which is the part with the arithmetic in it. Plain
 * assertions under tsx, no framework, matching the rest of the repo.
 */
import { buildPyramid, type PyramidEdgeInput } from '../lib/graph/pyramid.ts';

let failures = 0;
let checks = 0;
function check(label: string, pass: boolean, detail = '') {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}
function section(name: string) { console.log(`\n--- ${name} ---`); }

/* A library shaped like the thing this view exists to show:
 *
 *      finance (100)
 *       |      \
 *   invoice(50) contract(30)
 *       |
 *   overdue(20)                    scratch(9) -- unrelated to everything
 *
 * Written as raw co-occurrence counts, because that is what the API sends and
 * the containment is meant to be DERIVED rather than declared. */
const nodes = [
  { tid: 1, n: 100 }, // finance
  { tid: 2, n: 50 },  // invoice
  { tid: 3, n: 30 },  // contract
  { tid: 4, n: 20 },  // overdue
  { tid: 5, n: 9 },   // scratch
];
const label = ['finance', 'invoice', 'contract', 'overdue', 'scratch'];
const at = (tid: number) => nodes.findIndex((n) => n.tid === tid);

const edges: PyramidEdgeInput[] = [
  { source: 1, target: 2, weight: 50 },  // every invoice is finance
  { source: 1, target: 3, weight: 30 },  // every contract is finance
  { source: 1, target: 4, weight: 20 },  // every overdue is finance, transitively
  { source: 2, target: 4, weight: 19 },  // 95% of overdue are invoices
  { source: 3, target: 4, weight: 2 },   // 10%: not a hierarchy, just an overlap
];

section('levels');
{
  const p = buildPyramid(nodes, edges);
  check('the broadest tag is the apex', p.depth[at(1)] === 0);
  check('what it contains sits one row below',
    p.depth[at(2)] === 1 && p.depth[at(3)] === 1);
  check('a tag inside a tag inside a tag is two rows below', p.depth[at(4)] === 2,
    `overdue is on row ${p.depth[at(4)]}`);
  check('every edge points downward',
    p.edges.every((e) => p.depth[e.parent] < p.depth[e.child]));
  check('no tag is its own parent', p.edges.every((e) => e.parent !== e.child));

  const drawn = p.edges.map((e) => `${label[e.parent]}>${label[e.child]}`).sort();
  check('the implied edge is reduced away', !drawn.includes('finance>overdue'),
    drawn.join(' '));
  check('the edges that survive are the direct ones',
    drawn.join(' ') === 'finance>contract finance>invoice invoice>overdue',
    drawn.join(' '));
  check('a 10% overlap is not a parent', !drawn.includes('contract>overdue'));
}

section('unattached tags');
{
  const p = buildPyramid(nodes, edges);
  const loose = p.layers[p.layers.length - 1];
  check('go below the base, not in the apex row', p.depth[at(5)] === p.maxDepth + 1,
    `scratch is on row ${p.depth[at(5)]}`);
  check('are labelled as such', loose.label === 'Unattached' && loose.unattached);
  check('have degree 0, so the Orphans toggle hides them',
    p.parents[at(5)].length === 0 && p.children[at(5)].length === 0);
  check('the rows above them are labelled general to specific',
    p.layers[0].label === 'Broadest' && p.layers[p.maxDepth].label === 'Most specific',
    p.layers.map((l) => l.label).join(' / '));
}

section('the wrapped block of unattached tags');
{
  // Thirty loose tags beside a two-row hierarchy: the case that would
  // otherwise draw a ribbon four times wider than the structure above it.
  const many = [
    { tid: 1, n: 100 }, { tid: 2, n: 50 },
    ...Array.from({ length: 30 }, (_, i) => ({ tid: 100 + i, n: 40 - i })),
  ];
  const p = buildPyramid(many, [{ source: 1, target: 2, weight: 50 }]);
  const loose = p.layers.filter((l) => l.unattached);

  check('wraps into several rows rather than one long one', loose.length > 1,
    `${loose.length} rows`);
  check('the rows are even', new Set(loose.map((l) => l.nodes.length)).size <= 2,
    loose.map((l) => l.nodes.length).join('/'));
  check('the block is no wider than it needs to be',
    Math.max(...loose.map((l) => l.nodes.length)) <= 10);
  check('only the first row is captioned',
    loose[0].label === 'Unattached' && loose.slice(1).every((l) => l.label === ''));
  check('and it carries the size of the whole block, not of its row',
    loose[0].groupSize === 30 && loose[0].nodes.length < 30,
    `${loose[0].nodes.length} of ${loose[0].groupSize}`);
  check('the hierarchy above is untouched',
    p.layers[0].label === 'Broadest' && p.layers[0].nodes.length === 1);
  check('every loose row sits below the base',
    loose.every((l) => l.y > p.layers[p.maxDepth].y));
}

section('the containment threshold');
{
  const strict = buildPyramid(nodes, edges, { containment: 0.96 });
  check('raising it drops the weaker relation',
    !strict.edges.some((e) => e.child === at(4) && e.parent === at(2)),
    `95% of overdue are invoices, which is below 96%`);
  check('and the tag rises to sit under what still contains it',
    strict.depth[at(4)] === 1);

  const loose = buildPyramid(nodes, edges, { containment: 0.09 });
  check('lowering it pulls the overlap in',
    loose.edges.some((e) => e.child === at(4) && e.parent === at(3)));
  check('and reduction still keeps the drawing a hierarchy',
    loose.edges.every((e) => loose.depth[e.parent] < loose.depth[e.child]));
}

section('geometry');
{
  const p = buildPyramid(nodes, edges, { pitch: 100, rowHeight: 80 });
  check('rows are one row height apart',
    p.layers.every((l, i) => l.y === i * 80));
  check('every coordinate is a number',
    p.x.every(Number.isFinite) && p.y.every(Number.isFinite));

  const tooClose = p.layers.some((layer) => {
    const xs = layer.nodes.map((i) => p.x[i]).sort((a, b) => a - b);
    return xs.some((v, i) => i > 0 && v - xs[i - 1] < 99.99);
  });
  check('nothing in a row is closer than the pitch', !tooClose);

  const again = buildPyramid(nodes, edges, { pitch: 100, rowHeight: 80 });
  check('the same input gives the same drawing every time',
    JSON.stringify(p.x) === JSON.stringify(again.x),
    'a force layout cannot promise this, which is the point');
}

section('degenerate input');
{
  check('no tags at all', buildPyramid([], []).layers.length === 0);
  const flat = buildPyramid([{ tid: 1, n: 5 }, { tid: 2, n: 4 }], []);
  check('tags with no relation between them are one row',
    flat.layers.length === 1 && flat.layers[0].nodes.length === 2);
  check('and that row is not called Unattached or Broadest, because there is no '
    + 'hierarchy for it to be the top or the bottom of',
    flat.layers[0].label === 'All tags', flat.layers[0].label);

  const identical = buildPyramid(
    [{ tid: 1, n: 10 }, { tid: 2, n: 10 }],
    [{ source: 1, target: 2, weight: 10 }],
  );
  check('two tags on exactly the same files still order deterministically',
    identical.depth[0] === 0 && identical.depth[1] === 1);
}

section('scale');
{
  // The 60-node cap with every pair present: the worst case the API can send.
  const many = Array.from({ length: 60 }, (_, i) => ({ tid: i + 1, n: 600 - i * 10 }));
  const dense: PyramidEdgeInput[] = [];
  for (let a = 0; a < 60; a++) {
    for (let b = a + 1; b < 60; b++) {
      dense.push({ source: a + 1, target: b + 1, weight: many[b].n });
    }
  }
  const started = performance.now();
  const p = buildPyramid(many, dense);
  const ms = performance.now() - started;
  check('60 nodes and 1,770 edges lay out in under 50 ms', ms < 50, `${ms.toFixed(1)} ms`);
  check('a total order gives a chain, not a cycle', p.maxDepth === 59,
    `deepest row is ${p.maxDepth}`);
  check('and reduction leaves exactly the 59 links of that chain',
    p.edges.length === 59, `${p.edges.length} edges`);
}

console.log(`\n${checks - failures}/${checks} passed\n`);
process.exit(failures ? 1 : 0);
