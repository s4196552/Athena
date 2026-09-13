/* Athena UI.

   No framework, no build step: edit, refresh, done. Under hackathon time
   pressure that iteration loop is worth more than any amount of tooling.

   Four things are deliberate rather than lazy:

   * The grid appends pages rather than re-rendering. Rebuilding the DOM on
     every scroll is the classic way a thumbnail wall starts dropping frames.
   * Progress arrives as one aggregate SSE tick per second. Per-file events
     would be tens of thousands of re-renders, which freezes the page far more
     reliably than indexing ever freezes the machine.
   * Filters are multi-select and compose as OR-within-a-group,
     AND-across-groups. Every tag axis holds a set of chosen values, never one
     value, because "Finance AND Invoice AND Jane Doe" is the query the whole
     tagging pipeline exists to answer.
   * The graph is drawn on a canvas by hand. A force layout over sixty nodes
     is fifty lines of arithmetic; a graph library would be a megabyte of
     download for a page that has to work with no network at all. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* Single-valued axes are scalars; tag axes hold a Set each, because choosing
   two topics has to mean "either". */
const state = {
  q: '',
  type: null,
  color: null,
  size: null,
  tags: Object.create(null),   // kind -> Set(values)
  cursor: 0,
  loading: false,
  done: false,
  view: 'grid',
};

const SCALAR_AXES = ['type', 'color', 'size'];

const chosen = (kind) => state.tags[kind] || (state.tags[kind] = new Set());

const anyFilter = () =>
  Boolean(state.q) || SCALAR_AXES.some((k) => state[k]) ||
  Object.values(state.tags).some((s) => s.size);

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};

const fmtDuration = (s) => {
  if (!s) return null;
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const fmtDate = (epoch) => epoch
  ? new Date(epoch * 1000).toLocaleDateString(undefined,
      { day: 'numeric', month: 'short', year: 'numeric' })
  : null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* One filter, two encodings: a query string for GETs and a plain object for
   POST bodies. Both are built from the same state, so a brief always describes
   exactly what the grid is showing. */
function params(extra = {}) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  for (const key of SCALAR_AXES) if (state[key]) p.set(key, state[key]);
  for (const [kind, values] of Object.entries(state.tags)) {
    for (const v of values) p.append(kind, v);
  }
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
}

function filterObject() {
  const out = {};
  if (state.q) out.q = state.q;
  for (const key of SCALAR_AXES) if (state[key]) out[key] = state[key];
  for (const [kind, values] of Object.entries(state.tags)) {
    if (values.size) out[kind] = Array.from(values);
  }
  return out;
}

/* Always resolves, never rejects.

   `makeBrief` puts "Asking the model…" on screen and *then* awaits. When that
   await rejected -- a dropped connection, a 500 carrying an HTML traceback
   rather than JSON, a model call that outran the server -- the function was
   abandoned at that line with the placeholder still showing. The brief sheet
   sat on "Asking the model…" forever, with no error and no way to retry.

   Every caller already branches on `ok`, so a failure object puts all of them
   on the error path they already have. The text is read before parsing so a
   non-JSON body reports its status instead of a `SyntaxError` nobody sees. */
const postJSON = async (url, body) => {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach the server — ${err.message}` };
  }
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: `${response.status} ${response.statusText || 'unreadable response'}`,
    };
  }
};

/* ---------- grid ---------- */

/* A generation counter, so a reset always wins and a slow in-flight response
   can never append rows belonging to a filter the user has already changed.
   The old guard (`if (state.loading) return`) silently dropped resets, which
   meant the one refresh that mattered -- the final one, when indexing finished
   -- was the one most likely to be thrown away. */
let generation = 0;
let lastTotal = 0;
let lastLabel = '';

async function loadPage(reset = false) {
  if (state.view !== 'grid') { if (reset) loadGraph(); return; }
  if (!reset && (state.loading || state.done)) return;
  const gen = reset ? ++generation : generation;
  state.loading = true;
  if (reset) { state.cursor = 0; state.done = false; }

  let data;
  try {
    data = await fetch(`/api/library?${params({ cursor: state.cursor })}`)
      .then((r) => r.json());
  } catch { state.loading = false; return; }

  if (gen !== generation) { state.loading = false; return; }  // superseded

  // Clearing after the response rather than before also removes the flash of
  // empty grid on every refresh.
  if (reset) $('#grid').innerHTML = '';

  lastTotal = data.total;
  lastLabel = data.label || '';
  $('#count').textContent =
    data.total === 1 ? '1 item' : `${data.total.toLocaleString()} items`;
  $('#label').textContent = data.label || '';
  $('#empty').hidden = data.total !== 0;
  $('#clear').hidden = !anyFilter();
  $('#selection-actions').hidden = data.total === 0;

  const frag = document.createDocumentFragment();
  for (const item of data.items) frag.appendChild(card(item));
  $('#grid').appendChild(frag);

  state.cursor = data.next ?? 0;
  state.done = !data.next;
  state.loading = false;
}

function card(item) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = item.file_id;

  const dims = item.width && item.height ? `${item.width}×${item.height}` : null;
  const dur = fmtDuration(item.duration_s);
  const pages = item.page_count ? `${item.page_count} pages` : null;
  const sub = [dims || dur || pages, fmtBytes(item.size_bytes)]
    .filter(Boolean).join(' · ');

  // Documents and audio have no thumbnail, so the card falls back to the
  // file's own dominant colour with the extension on top -- it keeps the wall
  // looking like a library rather than a list of grey boxes.
  const visual = item.thumb_key
    ? `<img class="thumb" loading="lazy" src="/api/thumb/${item.asset_id}" alt="">`
    : `<div class="fallback" style="background:${esc(item.tint || '#1c242e')}">${esc(item.ext || '?')}</div>`;

  // The agent's verdict, on the card. Without it the whole tagging pass is
  // invisible until you open something, and the point of the feature is that
  // the wall itself tells you what it is looking at.
  const badges = [
    item.doctype
      ? `<span class="badge-tag kind">${esc(item.doctype.replace(/-/g, ' '))}</span>` : '',
    item.topic ? `<span class="badge-tag topic">${esc(item.topic)}</span>` : '',
  ].join('');

  const byline = [item.author, fmtDate(item.event_at)].filter(Boolean).join(' · ');

  el.innerHTML = `
    ${visual}
    ${item.copies > 1 ? `<span class="copies">${item.copies} copies</span>` : ''}
    ${badges ? `<div class="badges">${badges}</div>` : ''}
    <div class="meta">
      <div class="fname" title="${esc(item.rel_path)}">${esc(item.name)}</div>
      <div class="sub">${esc(byline || sub)}</div>
    </div>`;

  el.addEventListener('click', () => openPanel(item.file_id));
  return el;
}

/* ---------- filter rail ---------- */

const SIZE_LABELS = {
  tiny: 'under 100 KB', small: '100 KB – 2 MB', medium: '2 – 50 MB',
  large: '50 – 500 MB', huge: 'over 500 MB',
};

async function loadFacets() {
  const f = await fetch('/api/facets').then((r) => r.json());

  $('#f-types').innerHTML = f.types
    .map((t) => chip('type', t.name, t.name, t.n, state.type === t.name)).join('');

  $('#f-sizes').innerHTML = (f.sizes || []).map((s) =>
    chip('size', s.name, SIZE_LABELS[s.name] || s.name, s.n, state.size === s.name)
  ).join('');

  $('#f-colors').innerHTML = f.colors.map((c) =>
    `<button class="swatch" data-facet="color" data-value="${esc(c.name)}"
       style="background:${esc(c.swatch)}" aria-pressed="${state.color === c.name}"
       title="${esc(c.name)} — ${c.n}"></button>`
  ).join('');

  // The agent's axes, each its own group, rendered from the server's list so
  // that adding a tag kind needs no change here.
  $('#f-groups').innerHTML = (f.groups || []).map((g) => `
    <section class="facet" data-group="${esc(g.kind)}">
      <h2>${esc(g.heading)}${chosen(g.kind).size
        ? `<button class="clear-group" data-clear-group="${esc(g.kind)}">clear</button>`
        : ''}</h2>
      <div class="chips">
        ${g.values.map((v) => chip(g.kind, v.name, v.display_name || v.name,
          v.n, chosen(g.kind).has(v.name))).join('')}
      </div>
    </section>`).join('');

  const indexed = f.states.indexed || 0;
  $('#f-stats').innerHTML = `
    <dt>Indexed</dt><dd>${indexed.toLocaleString()}</dd>
    ${f.states.error ? `<dt>Errors</dt><dd>${f.states.error}</dd>` : ''}
    ${f.states.missing ? `<dt>Missing</dt><dd>${f.states.missing}</dd>` : ''}
    ${f.unclassified ? `<dt>No topic yet</dt><dd>${f.unclassified.toLocaleString()}</dd>` : ''}
    <dt>Duplicate sets</dt><dd class="accent">${f.duplicate_groups}</dd>
    <dt>Reclaimable</dt><dd class="accent">${fmtBytes(f.reclaimable_bytes)}</dd>`;

  const bad = f.mutations > 0;
  $('#integrity').className = `badge ${bad ? 'badge-bad' : 'badge-ok'}`;
  $('#integrity-text').textContent = bad
    ? `${f.mutations} files modified`
    : `${indexed.toLocaleString()} files read, 0 modified`;
}

function chip(facet, value, label, n, on) {
  return `<button class="chip" data-facet="${esc(facet)}" data-value="${esc(value)}"
    aria-pressed="${on}">${esc(label)}<span class="n">${n}</span></button>`;
}

/* Scalar axes toggle; tag axes accumulate. Both clear on a second click of the
   same chip, which is what people expect from a chip they can see is pressed. */
document.addEventListener('click', (e) => {
  const clearGroup = e.target.closest('[data-clear-group]');
  if (clearGroup) {
    chosen(clearGroup.dataset.clearGroup).clear();
    return applyFilters();
  }

  const btn = e.target.closest('[data-facet]');
  if (!btn) return;
  const { facet, value } = btn.dataset;

  if (SCALAR_AXES.includes(facet)) {
    state[facet] = state[facet] === value ? null : value;
  } else {
    const set = chosen(facet);
    if (set.has(value)) set.delete(value); else set.add(value);
  }
  applyFilters();
});

function applyFilters() {
  loadFacets();
  if (state.view === 'graph') loadGraph(); else loadPage(true);
  hideBrief();
}

$('#clear').addEventListener('click', () => {
  state.q = '';
  for (const key of SCALAR_AXES) state[key] = null;
  state.tags = Object.create(null);
  $('#search').value = '';
  applyFilters();
});

/* ---------- search ---------- */

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  // Debounced: FTS5 is fast, but a query per keystroke still queues work
  // behind the indexer for no benefit.
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    if (state.view === 'graph') loadGraph(); else loadPage(true);
    $('#clear').hidden = !anyFilter();
  }, 180);
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#search')) {
    e.preventDefault(); $('#search').focus();
  }
  if (e.key === 'Escape') { closePanel(); hideBrief(); }
});

/* ---------- view switch ---------- */

$$('[data-view]').forEach((btn) => btn.addEventListener('click', () => {
  state.view = btn.dataset.view;
  $$('[data-view]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  $('#grid-view').hidden = state.view !== 'grid';
  $('#graph-view').hidden = state.view !== 'graph';
  if (state.view === 'graph') loadGraph(); else loadPage(true);
}));

/* ---------- the graph ---------- */

/* A force-directed layout, written out rather than imported.

   Sixty nodes means naive all-pairs repulsion is 1,770 comparisons a frame,
   which is nothing -- Barnes-Hut would be a pointless optimisation at this
   size. What matters instead is that the simulation *settles*: it cools on a
   schedule and stops, rather than jittering forever behind whatever the user
   is trying to read. */

const KIND_COLOUR = {
  topic: '#6fb2ff',
  doctype: '#ffc861',
  author: '#8ee6a1',
  custom: '#ff9ecb',
  entity: '#c3a8ff',
  date: '#7d8b9c',
};

const KIND_LABEL = {
  topic: 'Topic', doctype: 'Kind', author: 'Author',
  custom: 'My tag', entity: 'Named', date: 'Year',
};

let graphData = { nodes: [], edges: [], files: 0 };
let sim = null;
let hover = null;

async function loadGraph() {
  const g = await fetch(`/api/graph?${params()}`).then((r) => r.json());
  graphData = g;

  // The graph is a full view, not a side panel, so it owns the same chrome the
  // grid does while it is showing. Leaving these to `loadPage` meant the Clear
  // button stayed hidden after filtering entirely from the graph -- with no
  // way back out except reloading the page.
  lastTotal = g.files;
  lastLabel = g.label || '';
  $('#label').textContent = g.label || '';
  $('#count').textContent =
    g.files === 1 ? '1 item' : `${(g.files || 0).toLocaleString()} items`;
  $('#clear').hidden = !anyFilter();
  $('#selection-actions').hidden = !g.files;

  $('#graph-caption').textContent = g.nodes.length
    ? `${g.nodes.length} tags across ${g.files.toLocaleString()} files`
      + (g.label ? ` — ${g.label}` : '')
    : 'Nothing to draw yet. Index a folder, or widen the filter.';
  $('#graph-legend').innerHTML = Object.entries(KIND_LABEL)
    .filter(([k]) => g.nodes.some((n) => n.kind === k))
    .map(([k, label]) =>
      `<span class="key"><i style="background:${KIND_COLOUR[k]}"></i>${esc(label)}</span>`)
    .join('');
  startSim();
}

function startSim() {
  const canvas = $('#graph');
  const box = canvas.getBoundingClientRect();
  const w = Math.max(box.width, 320);
  const h = Math.max(box.height, 320);

  const maxN = Math.max(1, ...graphData.nodes.map((n) => n.n));
  const nodes = graphData.nodes.map((n, i) => {
    // Seeded on a circle rather than at random, so the first frame already
    // has some structure and the layout is not untangling a knot.
    const angle = (i / Math.max(graphData.nodes.length, 1)) * Math.PI * 2;
    return {
      ...n,
      x: w / 2 + Math.cos(angle) * w * 0.3,
      y: h / 2 + Math.sin(angle) * h * 0.3,
      vx: 0, vy: 0,
      r: 6 + 16 * Math.sqrt(n.n / maxN),
    };
  });
  const byId = new Map(nodes.map((n) => [n.tid, n]));
  // `s` is the server's `strength` -- the co-occurrence normalised by the
  // rarer of the two tags, already in 0..1. The layout pulls on that rather
  // than on the raw count, because ranking by count makes the strongest links
  // in any real library "2024 -- everything": nearly every file has a year, so
  // a year co-occurs with everything. That is a base rate, not a relationship.
  const edges = graphData.edges
    .map((e) => ({
      a: byId.get(e.source), b: byId.get(e.target),
      w: e.weight, s: e.strength ?? 0.5,
    }))
    .filter((e) => e.a && e.b);

  if (sim) cancelAnimationFrame(sim.raf);
  sim = { nodes, edges, byId, w, h, temp: 1, raf: 0 };
  if (nodes.length) sim.raf = requestAnimationFrame(step);
  else draw();
}

function step() {
  if (!sim) return;
  const { nodes, edges, w, h } = sim;

  for (let iter = 0; iter < 2; iter++) {
    // Repulsion: every node pushes every other away, softened at very close
    // range so two coincident positions cannot produce an infinite force.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const force = 2600 / d2;
        const fx = (dx / d) * force, fy = (dy / d) * force;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }

    // Springs: a heavier edge pulls harder, so tags that genuinely co-occur
    // end up adjacent and the clusters are the library's real structure.
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const k = 0.0016 * (0.35 + e.s);
      const f = (d - 90) * k * d;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      e.a.vx += fx; e.a.vy += fy; e.b.vx -= fx; e.b.vy -= fy;
    }

    // Gravity towards the middle, which keeps unconnected nodes on screen
    // instead of letting repulsion fling them into the margins forever.
    for (const n of nodes) {
      n.vx += (w / 2 - n.x) * 0.0022;
      n.vy += (h / 2 - n.y) * 0.0022;
      n.vx *= 0.86; n.vy *= 0.86;
      n.x += n.vx * sim.temp;
      n.y += n.vy * sim.temp;
      n.x = Math.min(w - n.r - 4, Math.max(n.r + 4, n.x));
      n.y = Math.min(h - n.r - 4, Math.max(n.r + 4, n.y));
    }
  }

  sim.temp *= 0.992;
  draw();
  // Stop once cool. A layout that never settles is a layout nobody can read.
  if (sim.temp > 0.06) sim.raf = requestAnimationFrame(step);
}

function draw() {
  if (!sim) return;
  const canvas = $('#graph');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(sim.w * dpr)) canvas.width = Math.round(sim.w * dpr);
  if (canvas.height !== Math.round(sim.h * dpr)) canvas.height = Math.round(sim.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, sim.w, sim.h);

  // Hovering one node dims everything it does not touch, which is the only
  // way to read a specific relationship out of a graph this dense.
  const near = hover
    ? new Set(sim.edges
        .flatMap((e) => (e.a === hover ? [e.b] : e.b === hover ? [e.a] : []))
        .concat([hover]))
    : null;

  for (const e of sim.edges) {
    const lit = !near || (near.has(e.a) && near.has(e.b));
    ctx.strokeStyle = lit
      ? `rgba(140,170,205,${0.10 + 0.55 * e.s})`
      : 'rgba(120,140,165,0.05)';
    ctx.lineWidth = lit ? 0.5 + 2.6 * e.s : 0.5;
    ctx.beginPath();
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
    ctx.stroke();
  }

  for (const n of sim.nodes) {
    const lit = !near || near.has(n);
    const active = chosen(n.kind).has(n.name);
    ctx.globalAlpha = lit ? 1 : 0.25;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = KIND_COLOUR[n.kind] || '#8aa';
    ctx.fill();
    if (active) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    // Labels only where they will be readable: the big nodes always, the rest
    // on hover. Sixty labels at once is a smudge, not a diagram.
    if (n.r > 11 || n === hover || active) {
      ctx.globalAlpha = lit ? 1 : 0.3;
      ctx.fillStyle = '#e8eef6';
      const size = Math.min(15, 10 + n.r / 4);
      ctx.font = `${n === hover ? 600 : 400} ${size}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(n.label, n.x, n.y + n.r + 14);
    }
    ctx.globalAlpha = 1;
  }
}

/* What a node is tied to, strongest first -- the question a graph is opened
   to answer, written out so nobody has to read it off the lines. */
function describe(node) {
  const links = sim.edges
    .filter((e) => e.a === node || e.b === node)
    .sort((x, y) => y.s - x.s)
    .slice(0, 3)
    .map((e) => (e.a === node ? e.b : e.a).label);
  const head = `${KIND_LABEL[node.kind] || node.kind}: ${node.label} — ${node.n} files`;
  return links.length
    ? `${head}. Mostly alongside ${links.join(', ')}. Click to filter.`
    : `${head}. Click to filter.`;
}

function nodeAt(ev) {
  if (!sim) return null;
  const box = $('#graph').getBoundingClientRect();
  const x = ev.clientX - box.left, y = ev.clientY - box.top;
  let best = null, bestD = Infinity;
  for (const n of sim.nodes) {
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < (n.r + 6) ** 2 && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

$('#graph').addEventListener('mousemove', (ev) => {
  const found = nodeAt(ev);
  $('#graph').style.cursor = found ? 'pointer' : 'default';
  if (found !== hover) { hover = found; draw(); }
  $('#graph-hint').textContent = found ? describe(found) : '';
});

/* Clicking a node filters by it. That is what turns the graph from a picture
   into a way of getting somewhere. */
$('#graph').addEventListener('click', (ev) => {
  const found = nodeAt(ev);
  if (!found) return;
  const set = chosen(found.kind);
  if (set.has(found.name)) set.delete(found.name); else set.add(found.name);
  loadFacets();
  loadGraph();
  $('#clear').hidden = !anyFilter();
});

window.addEventListener('resize', () => {
  if (state.view === 'graph' && graphData.nodes.length) startSim();
});

/* ---------- briefs ---------- */

/* A very small markdown renderer. The brief is generated by us, so the only
   syntax that has to work is the syntax `agent/brief.py` emits -- and every
   line is escaped before any of it is applied, so a filename containing
   `<script>` renders as text rather than as markup. */
function markdown(src) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_/g, '$1<em>$2</em>');

  const out = [];
  let list = false;
  const closeList = () => { if (list) { out.push('</ul>'); list = false; } };

  for (const raw of String(src).split('\n')) {
    const line = raw.trimEnd();
    if (/^###\s+/.test(line)) {
      closeList();
      out.push(`<h4>${inline(line.replace(/^###\s+/, ''))}</h4>`);
    } else if (/^-\s+/.test(line)) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(line.replace(/^-\s+/, ''))}</li>`);
    } else if (line === '---') {
      closeList();
      out.push('<hr>');
    } else if (!line) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
}

async function makeBrief(useAI = false, refresh = false) {
  $('#brief').hidden = false;
  $('#brief-title').textContent = lastLabel || 'This selection';
  $('#brief-body').innerHTML =
    `<p class="working">${useAI ? 'Asking the model…' : 'Rolling up…'}</p>`;

  const r = await postJSON('/api/brief',
    { filter: filterObject(), use_ai: useAI, refresh });

  if (!r.ok) {
    $('#brief-body').innerHTML = `<p class="err">${esc(r.message || r.error)}</p>`;
    return;
  }
  $('#brief-title').textContent = r.title;
  const provenance = r.produced_by === 'rules'
    ? 'Every figure here is arithmetic over extracted metadata. No model involved.'
    : `Prose by ${esc(r.produced_by)}; the figures are still arithmetic.`;
  $('#brief-body').innerHTML = `
    ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
    ${markdown(r.body)}
    <p class="provenance">${provenance}${r.cached ? ' Served from cache.' : ''}</p>`;
  $('#brief-ai').hidden = r.produced_by !== 'rules';
}

function hideBrief() { $('#brief').hidden = true; }

$('#summarise').addEventListener('click', () => makeBrief(false));
$('#brief-close').addEventListener('click', hideBrief);
$('#brief-ai').addEventListener('click', () => makeBrief(true, true));

/* ---------- tagging a whole selection ---------- */

$('#tag-apply').addEventListener('click', async () => {
  const input = $('#tag-name');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }

  const r = await postJSON('/api/tag',
    { kind: 'custom', name, filter: filterObject() });
  const note = $('#tag-note');
  note.textContent = r.message || r.error || '';
  note.className = `hint ${r.ok ? 'ok' : 'err'}`;
  if (r.ok) {
    input.value = '';
    // The tag lands on content, so it is immediately a facet: reload the rail
    // so the new axis value is there to click.
    await loadFacets();
    if (state.view === 'graph') loadGraph();
  }
  setTimeout(() => { note.textContent = ''; }, 4000);
});

$('#tag-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#tag-apply').click();
});

/* ---------- detail panel ---------- */

async function openPanel(fileId) {
  const d = await fetch(`/api/detail/${fileId}`).then((r) => r.json());
  if (d.error) return;

  const preview = d.media_type === 'image'
    ? `<img class="preview" src="/api/raw/${d.file_id}" alt="">`
    : d.media_type === 'video'
      ? `<video class="preview" controls preload="metadata" src="/api/raw/${d.file_id}"></video>`
      : d.media_type === 'audio'
        ? `<audio class="preview" controls src="/api/raw/${d.file_id}"></audio>`
        : d.thumb_key ? `<img class="preview" src="/api/thumb/${d.asset_id}" alt="">` : '';

  const agent = d.agent || {};
  let money = null;
  try { money = agent.numbers ? (JSON.parse(agent.numbers).money || null) : null; }
  catch { money = null; }

  const facts = [
    ['Type', d.mime || d.ext],
    ['Size', fmtBytes(d.size_bytes)],
    ['Dimensions', d.width && d.height ? `${d.width} × ${d.height}` : null],
    ['Duration', fmtDuration(d.duration_s)],
    ['Pages', d.page_count],
    ['Author', agent.author || d.doc?.author],
    ['Author found in', agent.author_source],
    ['Dated', agent.event_at ? fmtDate(agent.event_at) : null],
    ['Date found in', agent.event_source],
    ['Captured', d.captured_at ? new Date(d.captured_at * 1000).toLocaleString() : null],
    ['Camera', d.image?.camera_model],
    ['Artist', d.audio?.artist],
    ['Album', d.audio?.album],
    ['Location', d.lat ? `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}` : null],
    ['Hash', d.content_hash ? d.content_hash.slice(0, 16) + '…' : null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  /* Why the agent said what it said, shown rather than asserted. A
     classification a user can check is one they can correct; one they cannot
     check is one they stop trusting the first time it is wrong. */
  const verdict = (agent.doctype || agent.topic || agent.reasoning) ? `
    <section class="verdict">
      <h4>What Athena made of this</h4>
      <div class="chips">
        ${agent.doctype
          ? `<span class="badge-tag kind">${esc(agent.doctype.replace(/-/g, ' '))}</span>` : ''}
        ${agent.topic ? `<span class="badge-tag topic">${esc(agent.topic)}</span>` : ''}
      </div>
      ${agent.reasoning ? `<p class="why">${esc(agent.reasoning)}</p>` : ''}
      ${money ? `<p class="why">Largest figure: ${Object.entries(money)
        .map(([code, m]) => `${esc(code)} ${m.max.toLocaleString()}`).join(', ')}</p>` : ''}
      <p class="provenance">Decided by ${esc(agent.decided_by || 'rules')}${
        Number(agent.escalated) ? ', after the rules were unsure' : ''}.</p>
    </section>` : '';

  const userTags = (d.tags || []).filter((t) => t.kind === 'custom');
  const derived = (d.tags || []).filter((t) => t.kind !== 'custom');

  $('#panel-body').innerHTML = `
    <h3>${esc(d.name)}</h3>
    <div class="path">${esc(d.rel_path)}</div>

    <div class="actions">
      <button class="ghost" id="reveal">Reveal in file manager</button>
    </div>

    ${preview}
    ${verdict}

    <section>
      <h4>My tags</h4>
      <div class="chips" id="user-tags">
        ${userTags.map((t) => `<span class="chip user">${esc(t.display_name || t.name)}<button
            class="x" data-untag="${esc(t.name)}" title="Remove">×</button></span>`).join('')
          || '<span class="muted">none yet</span>'}
      </div>
      <div class="row tagrow">
        <input id="file-tag" type="text" placeholder="Add a tag…" maxlength="80">
        <button class="ghost" id="file-tag-add">Add</button>
      </div>
    </section>

    <section>
      <h4>Details</h4>
      <dl class="kv">
        ${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
      </dl>
    </section>

    ${d.colors?.length ? `
    <section>
      <h4>Palette</h4>
      <div class="palette">
        ${d.colors.map((c) =>
          `<span style="background:${esc(c.hex)};flex:${Math.max(c.proportion, 0.02)}"
                 title="${esc(c.hex)} — ${esc(c.bucket)} ${Math.round(c.proportion * 100)}%"></span>`
        ).join('')}
      </div>
    </section>` : ''}

    ${derived.length ? `
    <section>
      <h4>Found by the agent</h4>
      <div class="chips">
        ${derived.map((t) => `<span class="chip static"
            title="${esc(t.kind)} · ${esc(t.sources || '')}">${esc(t.display_name || t.name)}<span
            class="n">${Math.round(t.confidence * 100)}%</span></span>`).join('')}
      </div>
    </section>` : ''}

    ${d.text?.length ? `
    <section>
      <h4>Extracted text</h4>
      ${d.text.map((t) => `<div class="textblock"><span class="src">${esc(t.source)}${
        t.ord ? ` · ${t.ord}` : ''}</span>${esc(t.body)}</div>`).join('')}
    </section>` : ''}

    ${d.copies?.length > 1 ? `
    <section>
      <h4>Identical copies (${d.copies.length})</h4>
      <ul class="copylist">${d.copies.map((c) => `<li>${esc(c.rel_path)}</li>`).join('')}</ul>
    </section>` : ''}

    ${d.runs?.length ? `
    <section>
      <h4>Extractors</h4>
      <div class="runs">
        ${d.runs.map((r) => `
          <div class="run" title="${esc(r.error_msg || r.status)}">
            <span class="st ${esc(r.status)}"></span>
            <span class="name">${esc(r.extractor)} v${r.version}</span>
            <span class="ms">${r.duration_ms ?? 0} ms</span>
          </div>`).join('')}
      </div>
    </section>` : ''}
  `;

  // The demo's punchline: the page cannot open Explorer, but the server can,
  // because it is an ordinary local process rather than a sandboxed tab.
  $('#reveal').addEventListener('click', async () => {
    const r = await postJSON('/api/reveal', { file_id: d.file_id });
    $('#reveal').textContent = r.ok ? 'Opened ✓' : 'Could not open';
    setTimeout(() => { $('#reveal').textContent = 'Reveal in file manager'; }, 1600);
  });

  const addTag = async () => {
    const name = $('#file-tag').value.trim();
    if (!name) return;
    await postJSON('/api/tag', { kind: 'custom', name, file_ids: [d.file_id] });
    await loadFacets();
    openPanel(fileId);
  };
  $('#file-tag-add').addEventListener('click', addTag);
  $('#file-tag').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTag(); });

  $('#user-tags').addEventListener('click', async (e) => {
    const x = e.target.closest('[data-untag]');
    if (!x) return;
    await postJSON('/api/tag',
      { kind: 'custom', name: x.dataset.untag, remove: true, file_ids: [d.file_id] });
    await loadFacets();
    openPanel(fileId);
  });

  $('#panel').hidden = false;
  $('#scrim').hidden = false;
  $('#panel').scrollTop = 0;
}

function closePanel() {
  $('#panel').hidden = true;
  $('#scrim').hidden = true;
}
$('#panel-close').addEventListener('click', closePanel);
$('#scrim').addEventListener('click', closePanel);

/* ---------- libraries ---------- */

async function loadLibraries() {
  const { libraries } = await fetch('/api/roots').then((r) => r.json());
  $('#libsection').hidden = libraries.length === 0;
  $('#f-libraries').innerHTML = libraries.map((lib) => `
    <div class="lib" data-lib="${lib.id}">
      <div class="name" title="${esc(lib.path)}">${esc(lib.path)}</div>
      <div class="stat">
        <span>${lib.indexed.toLocaleString()} indexed · ${fmtBytes(lib.bytes)}${
          lib.exists ? '' : ' · <span class="offline">offline</span>'
        }</span>
        <button class="forget" data-forget="${lib.id}"
                title="Remove from Athena's catalogue">remove</button>
      </div>
    </div>`).join('');
}

/* "Remove library" is the one action in this app a user could catastrophically
   misread. So the confirmation states what is removed, states in green what is
   NOT touched, and requires a second deliberate click. No amount of visual
   polish substitutes for saying plainly that the files stay put. */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-forget]');
  if (!btn) return;

  const card = btn.closest('.lib');
  const { libraries } = await fetch('/api/roots').then((r) => r.json());
  const lib = libraries.find((l) => String(l.id) === btn.dataset.forget);
  if (!lib) return;

  const panel = document.createElement('div');
  panel.className = 'confirm';
  panel.innerHTML = `
    <h4>Remove this library from Athena?</h4>
    <p>${esc(lib.path)}</p>
    <p><strong>${lib.files.toLocaleString()}</strong> catalogue entries, their tags,
       captions and thumbnails will be deleted from Athena's database.</p>
    <strong class="safe">Your files are not deleted. Nothing inside that folder
       is moved, renamed or touched in any way.</strong>
    <label>
      <input type="checkbox" id="keepmeta">
      <span>Keep what Athena learned, so re-adding this folder later is instant
            (no re-parsing, no AI cost).</span>
    </label>
    <div class="row">
      <button class="danger" id="do-forget">Remove from Athena</button>
      <button class="ghost" id="cancel-forget">Cancel</button>
    </div>`;

  card.replaceWith(panel);
  panel.querySelector('#cancel-forget').addEventListener('click', loadLibraries);
  panel.querySelector('#do-forget').addEventListener('click', async () => {
    const keep = panel.querySelector('#keepmeta').checked;
    panel.querySelector('#do-forget').textContent = 'Removing…';
    const r = await postJSON('/api/roots/forget',
      { root_id: lib.id, forget_metadata: !keep });
    const hint = $('#scanhint');
    hint.textContent = r.message || r.error || 'removed';
    hint.className = `hint ${r.ok ? 'ok' : 'err'}`;
    await loadLibraries();
    await loadFacets();
    await loadPage(true);
  });
});

/* ---------- scanning ---------- */

$('#scan').addEventListener('click', async () => {
  const path = $('#rootpath').value.trim();
  if (!path) return;
  const hint = $('#scanhint');
  const r = await postJSON('/api/scan', { path });
  hint.textContent = r.message;
  hint.className = `hint ${r.ok ? 'ok' : 'err'}`;
  if (r.ok) { $('#pause').hidden = false; loadLibraries(); }
});

$('#rootpath').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#scan').click();
});

let paused = false;
$('#pause').addEventListener('click', async () => {
  paused = !paused;
  await postJSON('/api/pause', { paused });
  $('#pause').textContent = paused ? 'Resume' : 'Pause';
});

/* ---------- live progress ---------- */

/* Redrawing the whole grid on every tick is what made the bar appear stuck.
   During indexing `queued` changes every single second, so the old code
   rebuilt 120 cards and re-requested 120 thumbnails per second -- thousands of
   requests against a browser that will only open six connections per origin.
   The fetches queued up behind each other, the connection pool saturated, and
   the SSE stream starved along with everything else.

   Which is the exact failure ARCHITECTURE.md warns about ("never emit
   per-file events"), reintroduced one layer up: the server was well-behaved
   and the client threw the work away by asking for everything again.

   So: update the text every tick (synchronous, free), and re-query on a
   throttle plus once more on the falling edge when the backlog empties. */
const REFRESH_MS = 4000;
let lastQueued = null;
let lastRefresh = 0;
let lastTick = Date.now();

function refresh() {
  loadFacets();
  loadLibraries();
  // Don't yank the grid out from under someone who has scrolled into it.
  if (!anyFilter() && window.scrollY < 400) {
    if (state.view === 'graph') loadGraph(); else loadPage(true);
  }
}

/* One reading of the queue, from either transport. */
function applyProgress(p) {
  lastTick = Date.now();

  const total = p.queued + p.indexed + p.error;
  const busy = p.queued > 0;

  $('#progress').hidden = !busy;
  $('#pause').hidden = !busy;

  if (busy) {
    const pct = total ? (p.indexed / total) * 100 : 0;
    $('#progress-fill').style.width = `${pct}%`;
    $('#progress-text').textContent =
      `${p.indexed.toLocaleString()} indexed · ${p.queued.toLocaleString()} queued` +
      (p.error ? ` · ${p.error} errors` : '');
  }

  const finished = lastQueued > 0 && p.queued === 0;
  const now = Date.now();
  if (finished || (busy && now - lastRefresh > REFRESH_MS)) {
    lastRefresh = now;
    refresh();
  }
  lastQueued = p.queued;
}

const progress = new EventSource('/api/progress');
progress.onmessage = (e) => applyProgress(JSON.parse(e.data));

/* The stall watchdog.

   The old recovery only fired when `readyState` reached CLOSED, and a dropped
   connection never goes there -- EventSource returns to CONNECTING and retries
   on its own, forever. So the fallback this comment used to promise never ran
   once, and a stream that died quietly (server restarted, laptop slept, the
   connection pool starved during a big scan) left the bar frozen on its last
   numbers. Frozen counts are worse than no bar: they read as indexing that has
   stopped making progress, which is a bug report about the wrong component.

   So watch the clock rather than the socket. If no tick has arrived in
   STALL_MS, pull a snapshot over plain fetch and let *that* decide whether the
   bar stays up -- including hiding it, which is the common case, because the
   usual reason ticks stopped is that the scan finished. */
const STALL_MS = 8000;

async function pollProgress() {
  // Bounded, because the thing being recovered from is a request that hangs.
  // An older server ignores `once` and answers this with the event stream
  // itself, which never ends -- so an unbounded `.json()` here would wait
  // forever and the watchdog would be as stuck as the bar it came to fix.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 4000);
  try {
    const r = await fetch('/api/progress?once=1', { signal: stop.signal });
    applyProgress(await r.json());
  } catch {
    // The server is genuinely unreachable. Clear the chrome rather than leave
    // a bar up claiming a scan that nothing is running.
    lastTick = Date.now();
    $('#progress').hidden = true;
    $('#pause').hidden = true;
  } finally {
    clearTimeout(timer);
  }
}

setInterval(() => {
  if (Date.now() - lastTick > STALL_MS) pollProgress();
}, STALL_MS / 2);

/* ---------- infinite scroll ---------- */

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) loadPage();
}, { rootMargin: '600px' }).observe($('#sentinel'));

loadLibraries();
loadFacets();
loadPage(true);
