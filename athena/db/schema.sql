-- ============================================================================
--  Athena :: catalogue schema  (SQLite >= 3.38; 3.43+ recommended)
--
--  INVARIANT: nothing in this file, and nothing that writes to it, ever
--  touches a byte inside a user's library. This database is the ONLY mutable
--  artefact the application owns. It lives in the OS app-data directory,
--  never inside an indexed root.
--
--  Identity model
--  --------------
--    asset  = a unit of *content*, keyed by BLAKE3 of the bytes.
--    file   = a *path* that currently (or formerly) held that content.
--
--  One asset, many files == duplicate detection for free. A file moved
--  outside the app rebinds to the same asset on rediscovery, so every tag,
--  box, colour and OCR line survives the move with zero re-work.
--
--  All extracted metadata hangs off asset_id, never file_id: re-index work is
--  proportional to *distinct content*, not to the number of paths.
--  Every facet table therefore has asset_id as its first column -- the writer
--  relies on this to inject the id into rows produced by workers that have no
--  database access of their own.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
--  Roots and scan bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS root (
  id             INTEGER PRIMARY KEY,
  path           TEXT    NOT NULL UNIQUE,        -- absolute, normalised, no trailing separator
  label          TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  follow_links   INTEGER NOT NULL DEFAULT 0 CHECK (follow_links IN (0, 1)),
  added_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  last_scan_id   INTEGER,
  last_scan_at   INTEGER
);

CREATE TABLE IF NOT EXISTS scan_run (
  id             INTEGER PRIMARY KEY,
  root_id        INTEGER NOT NULL REFERENCES root(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('full', 'incremental', 'watch')),
  started_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at    INTEGER,
  status         TEXT    NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'complete', 'cancelled', 'failed')),
  dirs_seen      INTEGER NOT NULL DEFAULT 0,
  files_seen     INTEGER NOT NULL DEFAULT 0,
  files_added    INTEGER NOT NULL DEFAULT 0,
  files_changed  INTEGER NOT NULL DEFAULT 0,
  files_missing  INTEGER NOT NULL DEFAULT 0,
  files_moved    INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS scan_run_by_root ON scan_run(root_id, started_at DESC);

-- ---------------------------------------------------------------------------
--  Content identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS asset (
  id             INTEGER PRIMARY KEY,
  content_hash   TEXT    NOT NULL UNIQUE,        -- BLAKE3-256, lowercase hex
  size_bytes     INTEGER NOT NULL,
  mime           TEXT,                           -- sniffed from bytes, not from the extension
  media_type     TEXT    NOT NULL
                         CHECK (media_type IN ('image', 'video', 'audio', 'document', 'other')),
  first_seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_run_at    INTEGER,
  pipeline_state TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (pipeline_state IN ('pending', 'partial', 'complete', 'failed'))
);

CREATE INDEX IF NOT EXISTS asset_by_type ON asset(media_type, id);
CREATE INDEX IF NOT EXISTS asset_pending ON asset(pipeline_state) WHERE pipeline_state <> 'complete';

-- ---------------------------------------------------------------------------
--  Paths and the public state machine
--
--    queued  -> discovered, or content changed, or an extractor version moved
--    indexed -> every applicable extractor has run at its current version
--    missing -> previously indexed, path no longer resolves
--    error   -> unreadable, or the pipeline failed max_attempts times
--
--  "Processing" is deliberately NOT a fifth state: a row being worked on is
--  still `queued` with a lease held. A crashed engine therefore self-heals --
--  leases expire and the row becomes claimable again, no recovery sweep.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS file (
  id               INTEGER PRIMARY KEY,
  root_id          INTEGER NOT NULL REFERENCES root(id) ON DELETE CASCADE,
  rel_path         TEXT    NOT NULL,             -- POSIX-separated, relative to root.path
  parent_rel       TEXT    NOT NULL DEFAULT '',  -- enables cheap "this folder only" filters
  name             TEXT    NOT NULL,
  ext              TEXT,                         -- lowercase, no dot

  size_bytes       INTEGER NOT NULL DEFAULT 0,
  mtime_ns         INTEGER NOT NULL DEFAULT 0,
  ctime_ns         INTEGER,
  volume_id        INTEGER,                      -- st_dev / dwVolumeSerialNumber
  file_index       INTEGER,                      -- st_ino / NTFS file id: exact move detection

  asset_id         INTEGER REFERENCES asset(id) ON DELETE SET NULL,

  state            TEXT    NOT NULL DEFAULT 'queued'
                           CHECK (state IN ('queued', 'indexed', 'missing', 'error')),
  state_reason     TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  priority         INTEGER NOT NULL DEFAULT 100, -- lower runs first; UI viewport boosts to 0

  lease_owner      TEXT,                         -- "<engine_run_id>:<stage>"
  lease_expires_at INTEGER,

  discovered_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at     INTEGER,
  last_scan_id     INTEGER,
  indexed_at       INTEGER,
  missing_since    INTEGER,

  UNIQUE (root_id, rel_path)
);

-- The claim query's covering index. Partial, so it holds only the backlog:
-- on a 100k library with 300 items left to do, this index has 300 entries.
CREATE INDEX IF NOT EXISTS file_claim
  ON file(priority, id) WHERE state = 'queued';

CREATE INDEX IF NOT EXISTS file_by_state   ON file(state, id);
CREATE INDEX IF NOT EXISTS file_by_asset   ON file(asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS file_by_scan    ON file(root_id, last_scan_id);
CREATE INDEX IF NOT EXISTS file_by_dir     ON file(root_id, parent_rel, name);
CREATE INDEX IF NOT EXISTS file_by_size    ON file(size_bytes);
CREATE INDEX IF NOT EXISTS file_by_mtime   ON file(mtime_ns DESC);
CREATE INDEX IF NOT EXISTS file_by_ext     ON file(ext, id);
CREATE INDEX IF NOT EXISTS file_by_ident   ON file(volume_id, file_index) WHERE file_index IS NOT NULL;
-- Narrow probe used by move reconciliation: only ever scans the missing set.
CREATE INDEX IF NOT EXISTS file_move_probe ON file(size_bytes, mtime_ns) WHERE state = 'missing';

-- Timestamp bookkeeping, in a trigger so no writer can forget it.
CREATE TRIGGER IF NOT EXISTS file_state_stamps
AFTER UPDATE OF state ON file
WHEN old.state IS NOT new.state
BEGIN
  UPDATE file SET
    indexed_at    = CASE WHEN new.state = 'indexed' THEN unixepoch() ELSE indexed_at END,
    missing_since = CASE WHEN new.state = 'missing' THEN unixepoch()
                         WHEN old.state = 'missing' THEN NULL
                         ELSE missing_since END
  WHERE id = new.id;
END;

-- ---------------------------------------------------------------------------
--  Extractor ledger -- the engine's incremental-work brain.
--
--  Each row records "extractor E at version V has been applied to asset A".
--  Ship a better OCR model, bump its version, and the backlog query below
--  returns exactly the assets that need it. Nothing else is re-touched.
--
--    SELECT a.id FROM asset a
--    LEFT JOIN extractor_run r ON r.asset_id = a.id AND r.extractor = :name
--    WHERE a.media_type IN (:types)
--      AND (r.version IS NULL OR r.version < :version);
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS extractor_run (
  asset_id     INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  extractor    TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('ok', 'error', 'skipped', 'unsupported')),
  started_at   INTEGER,
  duration_ms  INTEGER,
  error_kind   TEXT,
  error_msg    TEXT,
  PRIMARY KEY (asset_id, extractor)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS extractor_run_backlog ON extractor_run(extractor, version);

-- ---------------------------------------------------------------------------
--  Per-media-type metadata (1:1 with asset)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS image_meta (
  asset_id       INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  width          INTEGER,
  height         INTEGER,
  megapixels     REAL,
  orientation    INTEGER,          -- EXIF 1..8, applied logically, never written back
  has_alpha      INTEGER,
  is_animated    INTEGER,
  frame_count    INTEGER,
  color_space    TEXT,
  bit_depth      INTEGER,
  camera_make    TEXT,
  camera_model   TEXT,
  lens_model     TEXT,
  iso            INTEGER,
  f_number       REAL,
  exposure_s     REAL,
  focal_length   REAL,
  flash          INTEGER,
  captured_at    INTEGER,          -- epoch seconds, UTC
  captured_tz    TEXT,
  blurhash       TEXT
);

CREATE INDEX IF NOT EXISTS image_by_captured ON image_meta(captured_at DESC);
CREATE INDEX IF NOT EXISTS image_by_dims     ON image_meta(width, height);
CREATE INDEX IF NOT EXISTS image_by_camera   ON image_meta(camera_make, camera_model);

CREATE TABLE IF NOT EXISTS video_meta (
  asset_id       INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  width          INTEGER,
  height         INTEGER,
  duration_s     REAL,
  fps            REAL,
  video_codec    TEXT,
  audio_codec    TEXT,
  bitrate        INTEGER,
  rotation       INTEGER,
  has_audio      INTEGER,
  stream_count   INTEGER,
  captured_at    INTEGER,
  container      TEXT
);

CREATE INDEX IF NOT EXISTS video_by_duration ON video_meta(duration_s);
CREATE INDEX IF NOT EXISTS video_by_captured ON video_meta(captured_at DESC);

CREATE TABLE IF NOT EXISTS audio_meta (
  asset_id       INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  duration_s     REAL,
  sample_rate    INTEGER,
  channels       INTEGER,
  bit_depth      INTEGER,
  bitrate        INTEGER,
  codec          TEXT,
  lossless       INTEGER,
  title          TEXT,
  artist         TEXT,
  album          TEXT,
  album_artist   TEXT,
  track_no       INTEGER,
  disc_no        INTEGER,
  year           INTEGER,
  genre          TEXT,
  has_cover_art  INTEGER
);

CREATE INDEX IF NOT EXISTS audio_by_artist ON audio_meta(artist, album, track_no);
CREATE INDEX IF NOT EXISTS audio_by_album  ON audio_meta(album);

CREATE TABLE IF NOT EXISTS doc_meta (
  asset_id        INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  page_count      INTEGER,
  word_count      INTEGER,
  char_count      INTEGER,
  title           TEXT,
  author          TEXT,
  subject         TEXT,
  creator         TEXT,
  producer        TEXT,
  doc_created_at  INTEGER,
  doc_modified_at INTEGER,
  language        TEXT,
  has_text_layer  INTEGER,          -- 0 => a scan; the OCR extractor picks it up
  ocr_applied     INTEGER,
  is_encrypted    INTEGER
);

CREATE INDEX IF NOT EXISTS doc_by_author ON doc_meta(author);
CREATE INDEX IF NOT EXISTS doc_by_pages  ON doc_meta(page_count);

-- ---------------------------------------------------------------------------
--  Location. R*Tree handles map viewport / bounding-box queries in log time;
--  the base table keeps the exact values and their provenance.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS geo (
  asset_id     INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  lat          REAL NOT NULL CHECK (lat BETWEEN -90  AND 90),
  lon          REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
  altitude_m   REAL,
  accuracy_m   REAL,
  heading      REAL,
  source       TEXT NOT NULL,        -- 'exif' | 'xmp' | 'quicktime' | 'iptc' | 'user'
  captured_at  INTEGER,
  geohash      TEXT,                 -- prefix-indexed clustering
  place_name   TEXT,                 -- offline reverse geocode, optional
  country_code TEXT,
  admin1       TEXT,
  locality     TEXT
);

CREATE INDEX IF NOT EXISTS geo_by_geohash ON geo(geohash);
CREATE INDEX IF NOT EXISTS geo_by_place   ON geo(country_code, admin1, locality);

CREATE VIRTUAL TABLE IF NOT EXISTS geo_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);

CREATE TRIGGER IF NOT EXISTS geo_rtree_ai AFTER INSERT ON geo BEGIN
  INSERT OR REPLACE INTO geo_rtree VALUES (new.asset_id, new.lat, new.lat, new.lon, new.lon);
END;
CREATE TRIGGER IF NOT EXISTS geo_rtree_au AFTER UPDATE ON geo BEGIN
  INSERT OR REPLACE INTO geo_rtree VALUES (new.asset_id, new.lat, new.lat, new.lon, new.lon);
END;
CREATE TRIGGER IF NOT EXISTS geo_rtree_ad AFTER DELETE ON geo BEGIN
  DELETE FROM geo_rtree WHERE id = old.asset_id;
END;

-- ---------------------------------------------------------------------------
--  Tags. `tag` is the vocabulary, `asset_tag` is the filterable fact
--  (one row per asset/tag/source, carrying the best confidence), `detection`
--  holds the individual boxes. Splitting them keeps the filter index tiny --
--  an image with 40 detected people is still one row in asset_tag.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tag (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN (
                 -- derived by extractors
                 'object', 'scene', 'place', 'keyword', 'topic', 'entity',
                 'genre', 'camera', 'language', 'system',
                 -- derived by the inspection agent
                 'author', 'doctype', 'date', 'pattern',
                 -- typed by a person. 'custom' is theirs to invent; 'user' is
                 -- the account a file is attributed to.
                 'custom', 'user')),
  name         TEXT NOT NULL,                    -- normalised: lowercase, singular
  display_name TEXT,
  parent_id    INTEGER REFERENCES tag(id) ON DELETE SET NULL,   -- "dog" -> "animal"
  canonical_id INTEGER REFERENCES tag(id) ON DELETE SET NULL,   -- synonym folding
  UNIQUE (kind, name)
);

CREATE INDEX IF NOT EXISTS tag_by_name      ON tag(name);
CREATE INDEX IF NOT EXISTS tag_by_parent    ON tag(parent_id);
CREATE INDEX IF NOT EXISTS tag_by_canonical ON tag(canonical_id);

CREATE TABLE IF NOT EXISTS asset_tag (
  asset_id   INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tag(id)   ON DELETE CASCADE,
  source     TEXT    NOT NULL,                    -- 'siglip2@3' | 'rtdetr@1' | 'exif' | 'user'
  confidence REAL    NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  instances  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (asset_id, tag_id, source)
) WITHOUT ROWID;

-- Drives "show me everything tagged X, best matches first".
CREATE INDEX IF NOT EXISTS asset_tag_by_tag ON asset_tag(tag_id, confidence DESC, asset_id);

CREATE TABLE IF NOT EXISTS detection (
  id         INTEGER PRIMARY KEY,
  asset_id   INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tag(id)   ON DELETE CASCADE,
  source     TEXT    NOT NULL,
  confidence REAL    NOT NULL,
  x REAL, y REAL, w REAL, h REAL,                 -- normalised 0..1
  t_ms       INTEGER                              -- video: frame offset
);

CREATE INDEX IF NOT EXISTS detection_by_asset ON detection(asset_id, t_ms);

-- ---------------------------------------------------------------------------
--  The inspection agent's verdict.
--
--  `asset_tag` holds the *facts* the agent produced -- one row per tag, which
--  is what the filter rail and the graph query. This table holds the *reasoning*
--  behind them: which patterns fired, how sure it was, where the author name
--  came from, and whether a model was consulted.
--
--  Keeping them apart matters for two reasons. Filtering must never pay for
--  provenance it is not displaying; and a verdict a user can see the workings
--  of is a verdict they can correct. `decided_by` is what the UI shows when
--  someone asks why a spreadsheet ended up tagged Finance.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_finding (
  asset_id       INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  doctype        TEXT,             -- what the file *is*:    invoice, deck, log
  doctype_score  REAL,
  topic          TEXT,             -- what it is *about*:    finance, legal, hr
  topic_score    REAL,
  author         TEXT,             -- display form, as found
  author_source  TEXT,             -- metadata | signature | filename | email | id3
  event_at       INTEGER,          -- the date the content is about, not the file's
  event_source   TEXT,
  patterns       TEXT,             -- JSON array of pattern names that fired
  numbers        TEXT,             -- JSON object of quantities found (totals, counts)
  decided_by     TEXT NOT NULL,    -- 'rules' | '<provider>:<model>'
  reasoning      TEXT,             -- one human-readable line
  escalated      INTEGER NOT NULL DEFAULT 0,   -- rules were unsure; a model was asked
  decided_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS finding_by_doctype ON agent_finding(doctype);
CREATE INDEX IF NOT EXISTS finding_by_topic   ON agent_finding(topic);
CREATE INDEX IF NOT EXISTS finding_by_author  ON agent_finding(author);
-- The escalation backlog: assets the rules could not confidently classify.
CREATE INDEX IF NOT EXISTS finding_unsure
  ON agent_finding(topic_score) WHERE escalated = 0;

-- ---------------------------------------------------------------------------
--  Briefs: what came out of "summarise this selection".
--
--  Stored rather than streamed and forgotten, because a brief is the one
--  artefact here that costs real money to produce. Keyed by the filter that
--  produced it so the same selection is answered from the table the second
--  time it is asked.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS brief (
  id            INTEGER PRIMARY KEY,
  query         TEXT    NOT NULL,          -- canonicalised filter string
  label         TEXT    NOT NULL,          -- "Finance by Jane Doe", for the list
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,          -- markdown
  asset_count   INTEGER NOT NULL,
  produced_by   TEXT    NOT NULL,          -- 'rules' | '<provider>:<model>'
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (query, produced_by)
);

CREATE INDEX IF NOT EXISTS brief_recent ON brief(created_at DESC);

-- ---------------------------------------------------------------------------
--  Colour. Stored twice on purpose:
--    * hex / Lab  -> "find images near this colour" by perceptual distance
--    * bucket     -> the swatch filter chips, an indexed equality scan
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS color (
  asset_id   INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  rank       INTEGER NOT NULL,                    -- 0 = most dominant
  hex        TEXT    NOT NULL,
  r INTEGER, g INTEGER, b INTEGER,
  lab_l REAL, lab_a REAL, lab_b REAL,
  proportion REAL    NOT NULL CHECK (proportion BETWEEN 0 AND 1),
  bucket     TEXT    NOT NULL,                    -- 'red' | 'teal' | 'black' | 'neutral' | ...
  PRIMARY KEY (asset_id, rank)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS color_by_bucket ON color(bucket, proportion DESC, asset_id);

-- ---------------------------------------------------------------------------
--  Text: document bodies, OCR lines, slide notes, transcripts.
--  FTS5 in external-content mode, so the text is stored exactly once.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS text_block (
  id         INTEGER PRIMARY KEY,
  asset_id   INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,   -- 'pdf_text' | 'pdf_ocr' | 'image_ocr' | 'docx'
                                 -- 'pptx' | 'pptx_notes' | 'transcript' | 'id3'
  ord        INTEGER NOT NULL DEFAULT 0,          -- page / slide / segment index
  t_start_ms INTEGER,
  t_end_ms   INTEGER,
  lang       TEXT,
  confidence REAL,
  body       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS text_block_by_asset ON text_block(asset_id, source, ord);

CREATE VIRTUAL TABLE IF NOT EXISTS text_fts USING fts5(
  body,
  content       = 'text_block',
  content_rowid = 'id',
  tokenize      = "unicode61 remove_diacritics 2",
  prefix        = '2 3 4'
);

CREATE TRIGGER IF NOT EXISTS text_block_ai AFTER INSERT ON text_block BEGIN
  INSERT INTO text_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS text_block_ad AFTER DELETE ON text_block BEGIN
  INSERT INTO text_fts(text_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS text_block_au AFTER UPDATE ON text_block BEGIN
  INSERT INTO text_fts(text_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO text_fts(rowid, body) VALUES (new.id, new.body);
END;

-- Substring-capable filename search ("*report*"). Trigram tokenizer, contentless.
CREATE VIRTUAL TABLE IF NOT EXISTS name_fts USING fts5(
  name, rel_path, content = '', tokenize = "trigram"
);

-- ---------------------------------------------------------------------------
--  Semantic search and near-duplicate detection
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS embedding (
  asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  model    TEXT    NOT NULL,        -- 'siglip2-base-p16-224'
  dim      INTEGER NOT NULL,
  vec      BLOB    NOT NULL,        -- float16 LE, L2-normalised
  PRIMARY KEY (asset_id, model)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS perceptual_hash (
  asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  algo     TEXT    NOT NULL,        -- 'phash64' | 'dhash64' | 'vhash64'
  hash     INTEGER NOT NULL,        -- 64-bit, compared by Hamming distance
  PRIMARY KEY (asset_id, algo)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS phash_lookup ON perceptual_hash(algo, hash);

CREATE TABLE IF NOT EXISTS near_duplicate (
  asset_a  INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  asset_b  INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  method   TEXT    NOT NULL,
  distance REAL    NOT NULL,
  PRIMARY KEY (asset_a, asset_b, method),
  CHECK (asset_a < asset_b)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
--  Derived artefacts. Content-addressed, under the app cache directory --
--  NEVER beside the source file. cache_key is a relative path; deleting the
--  whole cache directory is always safe and always recoverable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS thumbnail (
  asset_id  INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL CHECK (kind IN ('grid', 'preview', 'sheet')),
  width     INTEGER,
  height    INTEGER,
  fmt       TEXT,
  cache_key TEXT    NOT NULL,
  t_ms      INTEGER,
  bytes     INTEGER,
  PRIMARY KEY (asset_id, kind)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
--  Integrity audit -- the receipts behind the read-only promise.
--  Every mutation ever observed is recorded here (it would be our bug, or an
--  external editor); a 1% sample of clean reads is kept so the "files
--  verified untouched" panel has something honest to show.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integrity_audit (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER,
  path            TEXT    NOT NULL,
  at              INTEGER NOT NULL DEFAULT (unixepoch()),
  extractor       TEXT,
  before_size     INTEGER,
  before_mtime_ns INTEGER,
  after_size      INTEGER,
  after_mtime_ns  INTEGER,
  verdict         TEXT    NOT NULL CHECK (verdict IN ('unchanged', 'mutated', 'vanished')),
  detail          TEXT
);

CREATE INDEX IF NOT EXISTS integrity_mutations ON integrity_audit(at DESC) WHERE verdict = 'mutated';

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
--  Read-side views. The UI talks to these, never to raw tables, so the
--  physical layout can change without touching a line of TypeScript.
-- ---------------------------------------------------------------------------

CREATE VIEW IF NOT EXISTS v_library AS
SELECT
  f.id            AS file_id,
  f.root_id,
  r.path          AS root_path,
  f.rel_path,
  f.parent_rel,
  f.name,
  f.ext,
  f.size_bytes,
  f.mtime_ns,
  f.state,
  f.state_reason,
  f.indexed_at,
  a.id            AS asset_id,
  a.content_hash,
  a.mime,
  a.media_type,
  COALESCE(im.width,  vm.width)  AS width,
  COALESCE(im.height, vm.height) AS height,
  COALESCE(im.captured_at, vm.captured_at) AS captured_at,
  COALESCE(vm.duration_s, am.duration_s)   AS duration_s,
  dm.page_count,
  t.cache_key     AS thumb_key,
  g.lat, g.lon, g.locality, g.country_code
FROM file f
JOIN      root       r  ON r.id  = f.root_id
LEFT JOIN asset      a  ON a.id  = f.asset_id
LEFT JOIN image_meta im ON im.asset_id = a.id
LEFT JOIN video_meta vm ON vm.asset_id = a.id
LEFT JOIN audio_meta am ON am.asset_id = a.id
LEFT JOIN doc_meta   dm ON dm.asset_id = a.id
LEFT JOIN geo        g  ON g.asset_id  = a.id
LEFT JOIN thumbnail  t  ON t.asset_id  = a.id AND t.kind = 'grid';

-- Tag vocabulary with live counts. Restricted to assets that still have a
-- path, so a forgotten library's tags stop appearing in the rail immediately.
CREATE VIEW IF NOT EXISTS v_tag_facet AS
SELECT t.id            AS tag_id,
       t.kind,
       t.name,
       COALESCE(t.display_name, t.name) AS display_name,
       COUNT(DISTINCT at.asset_id)      AS n
FROM tag t
JOIN asset_tag at ON at.tag_id = t.id
JOIN file f       ON f.asset_id = at.asset_id AND f.state = 'indexed'
GROUP BY t.id;

CREATE VIEW IF NOT EXISTS v_state_counts AS
SELECT state, COUNT(*) AS n FROM file GROUP BY state;

-- Same bytes at more than one live path.
CREATE VIEW IF NOT EXISTS v_duplicate_group AS
SELECT asset_id, COUNT(*) AS copies, SUM(size_bytes) - MIN(size_bytes) AS reclaimable_bytes
FROM file
WHERE state = 'indexed' AND asset_id IS NOT NULL
GROUP BY asset_id
HAVING COUNT(*) > 1;
