// SQLite storage for the song list, using Node's built-in node:sqlite.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const dbPath = process.env.SONGBOOK_DB
  ? resolve(process.env.SONGBOOK_DB)
  : resolve(import.meta.dirname, '..', 'data', 'songs.db');

mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
// Removing a song or a setlist should take its setlist entries with it.
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    musical_key TEXT,
    bpm INTEGER,
    time_signature TEXT,
    isrc TEXT,
    spotify_url TEXT,
    youtube_url TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT
  )
`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS songs_isrc ON songs (isrc) WHERE isrc IS NOT NULL');
db.exec(`
  CREATE TABLE IF NOT EXISTS setlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS setlist_songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setlist_id INTEGER NOT NULL REFERENCES setlists (id) ON DELETE CASCADE,
    song_id INTEGER NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    UNIQUE (setlist_id, song_id)
  );
  CREATE INDEX IF NOT EXISTS setlist_songs_order ON setlist_songs (setlist_id, position);
`);

// Databases created before the YouTube links existed need the column added.
try {
  db.exec('ALTER TABLE songs ADD COLUMN youtube_url TEXT');
} catch {
  // Already present.
}

// Older databases predate the "last edited" stamp.
try {
  db.exec('ALTER TABLE songs ADD COLUMN updated_at TEXT');
} catch {
  // Already present.
}

// Bar length per song arrived later too; unset means common time.
try {
  db.exec('ALTER TABLE songs ADD COLUMN time_signature TEXT');
} catch {
  // Already present.
}

const toSong = row => ({
  id: row.id,
  title: row.title,
  artist: row.artist,
  album: row.album,
  key: row.musical_key,
  bpm: row.bpm,
  timeSignature: row.time_signature,
  isrc: row.isrc,
  spotifyUrl: row.spotify_url,
  youtubeUrl: row.youtube_url,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function listSongs() {
  return db.prepare('SELECT * FROM songs ORDER BY datetime(created_at) DESC, id DESC').all().map(toSong);
}

export function getSong(id) {
  const row = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  return row ? toSong(row) : null;
}

export function findByIsrc(isrc) {
  if (!isrc) return null;
  const row = db.prepare('SELECT * FROM songs WHERE isrc = ?').get(isrc);
  return row ? toSong(row) : null;
}

// Rows stored without an ISRC (recording not covered by the features API) can
// still be spotted by title and artist.
export function findByTitleArtist(title, artist) {
  const row = db
    .prepare('SELECT * FROM songs WHERE lower(title) = lower(?) AND lower(artist) = lower(?)')
    .get(title, artist);
  return row ? toSong(row) : null;
}

export function insertSong(song) {
  const info = db
    .prepare(
      'INSERT INTO songs (title, artist, album, musical_key, bpm, isrc, spotify_url, youtube_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      song.title,
      song.artist,
      song.album ?? null,
      song.musicalKey ?? null,
      song.bpm ?? null,
      song.isrc ?? null,
      song.spotifyUrl ?? null,
      song.youtubeUrl ?? null,
    );
  return getSong(Number(info.lastInsertRowid));
}

// Partial update of the fields a user can correct by hand.
const EDITABLE_COLUMNS = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  key: 'musical_key',
  bpm: 'bpm',
  timeSignature: 'time_signature',
  youtubeUrl: 'youtube_url',
};

export function updateSong(id, patch) {
  const assignments = [];
  const values = [];
  for (const [field, column] of Object.entries(EDITABLE_COLUMNS)) {
    if (!(field in patch)) continue;
    assignments.push(`${column} = ?`);
    values.push(patch[field]);
  }
  if (assignments.length === 0) return getSong(id);
  values.push(id);
  // The edit itself is the only thing that moves updated_at; created_at stays put.
  db.prepare(
    `UPDATE songs SET ${assignments.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  ).run(...values);
  return getSong(id);
}

export function deleteSong(id) {
  return db.prepare('DELETE FROM songs WHERE id = ?').run(id).changes > 0;
}

export function countSongs() {
  return db.prepare('SELECT COUNT(*) AS total FROM songs').get().total;
}

// --- Setlists -------------------------------------------------------------

const toSetlist = row => ({
  id: row.id,
  name: row.name,
  songCount: row.song_count ?? 0,
  createdAt: row.created_at,
});

export function listSetlists() {
  return db
    .prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM setlist_songs e WHERE e.setlist_id = s.id) AS song_count
      FROM setlists s
      ORDER BY datetime(s.created_at) DESC, s.id DESC
    `)
    .all()
    .map(toSetlist);
}

export function getSetlist(id) {
  const row = db.prepare('SELECT * FROM setlists WHERE id = ?').get(id);
  if (!row) return null;
  const songs = db
    .prepare(`
      SELECT e.id AS entry_id, e.position, s.*
      FROM setlist_songs e
      JOIN songs s ON s.id = e.song_id
      WHERE e.setlist_id = ?
      ORDER BY e.position, e.id
    `)
    .all(id)
    .map(entry => ({ entryId: entry.entry_id, position: entry.position, song: toSong(entry) }));
  return { ...toSetlist({ ...row, song_count: songs.length }), songs };
}

export function createSetlist(name) {
  const info = db.prepare('INSERT INTO setlists (name) VALUES (?)').run(name);
  return getSetlist(Number(info.lastInsertRowid));
}

export function deleteSetlist(id) {
  return db.prepare('DELETE FROM setlists WHERE id = ?').run(id).changes > 0;
}

export function addSongToSetlist(setlistId, songId) {
  if (!db.prepare('SELECT id FROM setlists WHERE id = ?').get(setlistId)) return { status: 'no-setlist' };
  if (!db.prepare('SELECT id FROM songs WHERE id = ?').get(songId)) return { status: 'no-song' };
  const duplicate = db
    .prepare('SELECT id FROM setlist_songs WHERE setlist_id = ? AND song_id = ?')
    .get(setlistId, songId);
  if (duplicate) return { status: 'duplicate' };

  const next = db
    .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM setlist_songs WHERE setlist_id = ?')
    .get(setlistId).next;
  db.prepare('INSERT INTO setlist_songs (setlist_id, song_id, position) VALUES (?, ?, ?)').run(
    setlistId,
    songId,
    next,
  );
  return { status: 'added', setlist: getSetlist(setlistId) };
}

export function removeSongFromSetlist(setlistId, entryId) {
  const result = db
    .prepare('DELETE FROM setlist_songs WHERE id = ? AND setlist_id = ?')
    .run(entryId, setlistId);
  if (result.changes === 0) return null;
  return getSetlist(setlistId);
}

// The client sends the complete new order; positions are rewritten 1..n.
export function reorderSetlist(setlistId, entryIds) {
  if (!db.prepare('SELECT id FROM setlists WHERE id = ?').get(setlistId)) return null;
  const current = db
    .prepare('SELECT id FROM setlist_songs WHERE setlist_id = ?')
    .all(setlistId)
    .map(row => row.id);
  if (current.length !== entryIds.length || current.some(id => !entryIds.includes(id))) {
    return undefined;
  }

  const update = db.prepare('UPDATE setlist_songs SET position = ? WHERE id = ? AND setlist_id = ?');
  db.exec('BEGIN');
  try {
    entryIds.forEach((entryId, index) => update.run(index + 1, entryId, setlistId));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getSetlist(setlistId);
}
