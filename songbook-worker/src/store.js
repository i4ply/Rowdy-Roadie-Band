// D1 storage for the song list. Same tables and behaviour as the local
// node:sqlite version, but every call is async because D1 is a network database.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    musical_key TEXT,
    bpm INTEGER,
    isrc TEXT,
    spotify_url TEXT,
    youtube_url TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS songs_isrc ON songs (isrc) WHERE isrc IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS setlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`,
  `CREATE TABLE IF NOT EXISTS setlist_songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setlist_id INTEGER NOT NULL REFERENCES setlists (id) ON DELETE CASCADE,
    song_id INTEGER NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    UNIQUE (setlist_id, song_id)
  )`,
  'CREATE INDEX IF NOT EXISTS setlist_songs_order ON setlist_songs (setlist_id, position)',
];

// D1 enforces foreign keys and has no per-connection pragmas, so deleting a song
// or a setlist still cascades. Created once per isolate and cached.
let schemaReady = null;
export function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .batch(SCHEMA.map(sql => db.prepare(sql)))
      .then(async () => {
        // Tables created before the YouTube link existed need the column added.
        try {
          await db.prepare('ALTER TABLE songs ADD COLUMN youtube_url TEXT').run();
        } catch {
          // Already present.
        }
      })
      .catch(error => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

const toSong = row => ({
  id: row.id,
  title: row.title,
  artist: row.artist,
  album: row.album,
  key: row.musical_key,
  bpm: row.bpm,
  isrc: row.isrc,
  spotifyUrl: row.spotify_url,
  youtubeUrl: row.youtube_url,
  createdAt: row.created_at,
});

export async function listSongs(db) {
  const { results } = await db
    .prepare('SELECT * FROM songs ORDER BY datetime(created_at) DESC, id DESC')
    .all();
  return results.map(toSong);
}

export async function getSong(db, id) {
  const row = await db.prepare('SELECT * FROM songs WHERE id = ?').bind(id).first();
  return row ? toSong(row) : null;
}

export async function findByIsrc(db, isrc) {
  if (!isrc) return null;
  const row = await db.prepare('SELECT * FROM songs WHERE isrc = ?').bind(isrc).first();
  return row ? toSong(row) : null;
}

// Rows stored without an ISRC (recording not covered by the features API) can
// still be spotted by title and artist.
export async function findByTitleArtist(db, title, artist) {
  const row = await db
    .prepare('SELECT * FROM songs WHERE lower(title) = lower(?) AND lower(artist) = lower(?)')
    .bind(title, artist)
    .first();
  return row ? toSong(row) : null;
}

export async function insertSong(db, song) {
  const result = await db
    .prepare(
      'INSERT INTO songs (title, artist, album, musical_key, bpm, isrc, spotify_url, youtube_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      song.title,
      song.artist,
      song.album ?? null,
      song.musicalKey ?? null,
      song.bpm ?? null,
      song.isrc ?? null,
      song.spotifyUrl ?? null,
      song.youtubeUrl ?? null,
    )
    .run();
  return getSong(db, Number(result.meta.last_row_id));
}

// Partial update of the fields a user can correct by hand.
const EDITABLE_COLUMNS = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  key: 'musical_key',
  bpm: 'bpm',
  youtubeUrl: 'youtube_url',
};

export async function updateSong(db, id, patch) {
  const assignments = [];
  const values = [];
  for (const [field, column] of Object.entries(EDITABLE_COLUMNS)) {
    if (!(field in patch)) continue;
    assignments.push(`${column} = ?`);
    values.push(patch[field]);
  }
  if (assignments.length === 0) return getSong(db, id);
  values.push(id);
  await db.prepare(`UPDATE songs SET ${assignments.join(', ')} WHERE id = ?`).bind(...values).run();
  return getSong(db, id);
}

export async function deleteSong(db, id) {
  const result = await db.prepare('DELETE FROM songs WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}

export async function countSongs(db) {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM songs').first();
  return row?.total ?? 0;
}

// One-time seed of an empty library, used to move an existing song list into D1.
export async function importSongs(db, rows) {
  const statements = [];
  for (const row of rows) {
    const title = String(row.title ?? '').trim();
    const artist = String(row.artist ?? '').trim();
    if (!title || !artist) continue;
    const bpm = Number.isFinite(Number(row.bpm)) && row.bpm !== null && row.bpm !== '' ? Math.round(Number(row.bpm)) : null;
    statements.push(
      db
        .prepare(`
          INSERT OR IGNORE INTO songs (title, artist, album, musical_key, bpm, isrc, spotify_url, youtube_url, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
        `)
        .bind(
          title,
          artist,
          row.album ?? null,
          row.musical_key ?? row.key ?? null,
          bpm,
          row.isrc ?? null,
          row.spotify_url ?? row.spotifyUrl ?? null,
          row.youtube_url ?? row.youtubeUrl ?? null,
          row.created_at ?? row.createdAt ?? null,
        ),
    );
  }
  if (statements.length === 0) return 0;
  const results = await db.batch(statements);
  return results.reduce((total, result) => total + (result.meta.changes > 0 ? 1 : 0), 0);
}

// --- Setlists -------------------------------------------------------------

const toSetlist = row => ({
  id: row.id,
  name: row.name,
  songCount: row.song_count ?? 0,
  createdAt: row.created_at,
});

export async function listSetlists(db) {
  const { results } = await db
    .prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM setlist_songs e WHERE e.setlist_id = s.id) AS song_count
      FROM setlists s
      ORDER BY datetime(s.created_at) DESC, s.id DESC
    `)
    .all();
  return results.map(toSetlist);
}

export async function getSetlist(db, id) {
  const row = await db.prepare('SELECT * FROM setlists WHERE id = ?').bind(id).first();
  if (!row) return null;
  const { results } = await db
    .prepare(`
      SELECT e.id AS entry_id, e.position, s.*
      FROM setlist_songs e
      JOIN songs s ON s.id = e.song_id
      WHERE e.setlist_id = ?
      ORDER BY e.position, e.id
    `)
    .bind(id)
    .all();
  const songs = results.map(entry => ({
    entryId: entry.entry_id,
    position: entry.position,
    song: toSong(entry),
  }));
  return { ...toSetlist({ ...row, song_count: songs.length }), songs };
}

export async function createSetlist(db, name) {
  const result = await db.prepare('INSERT INTO setlists (name) VALUES (?)').bind(name).run();
  return getSetlist(db, Number(result.meta.last_row_id));
}

export async function deleteSetlist(db, id) {
  const result = await db.prepare('DELETE FROM setlists WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}

export async function addSongToSetlist(db, setlistId, songId) {
  if (!(await db.prepare('SELECT id FROM setlists WHERE id = ?').bind(setlistId).first())) {
    return { status: 'no-setlist' };
  }
  if (!(await db.prepare('SELECT id FROM songs WHERE id = ?').bind(songId).first())) {
    return { status: 'no-song' };
  }
  const duplicate = await db
    .prepare('SELECT id FROM setlist_songs WHERE setlist_id = ? AND song_id = ?')
    .bind(setlistId, songId)
    .first();
  if (duplicate) return { status: 'duplicate' };

  const next = await db
    .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM setlist_songs WHERE setlist_id = ?')
    .bind(setlistId)
    .first();
  await db
    .prepare('INSERT INTO setlist_songs (setlist_id, song_id, position) VALUES (?, ?, ?)')
    .bind(setlistId, songId, next.next)
    .run();
  return { status: 'added', setlist: await getSetlist(db, setlistId) };
}

export async function removeSongFromSetlist(db, setlistId, entryId) {
  const result = await db
    .prepare('DELETE FROM setlist_songs WHERE id = ? AND setlist_id = ?')
    .bind(entryId, setlistId)
    .run();
  if (result.meta.changes === 0) return null;
  return getSetlist(db, setlistId);
}

// The client sends the complete new order; positions are rewritten 1..n in one
// batch, which D1 runs as a single transaction.
export async function reorderSetlist(db, setlistId, entryIds) {
  if (!(await db.prepare('SELECT id FROM setlists WHERE id = ?').bind(setlistId).first())) return null;
  const { results } = await db
    .prepare('SELECT id FROM setlist_songs WHERE setlist_id = ?')
    .bind(setlistId)
    .all();
  const current = results.map(row => row.id);
  if (current.length !== entryIds.length || current.some(id => !entryIds.includes(id))) {
    return undefined;
  }

  await db.batch(
    entryIds.map((entryId, index) =>
      db
        .prepare('UPDATE setlist_songs SET position = ? WHERE id = ? AND setlist_id = ?')
        .bind(index + 1, entryId, setlistId),
    ),
  );
  return getSetlist(db, setlistId);
}
