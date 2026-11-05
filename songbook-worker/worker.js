// Cloudflare Worker: the song list JSON API plus the static front end.
// Storage is D1; lookup and export are the same modules the local server uses.
import {
  ensureSchema,
  listSongs,
  getSong,
  insertSong,
  updateSong,
  deleteSong,
  findByIsrc,
  findByTitleArtist,
  listSetlists,
  getSetlist,
  createSetlist,
  deleteSetlist,
  addSongToSetlist,
  removeSongFromSetlist,
  reorderSetlist,
  countSongs,
  importSongs,
  importSetlists,
} from './src/store.js';
import { lookupSong, findYouTubeUrl, LookupError } from './src/lookup.js';
import {
  setlistText,
  setlistCsv,
  setlistPrintPage,
  exportFilename,
  libraryPrintPage,
  libraryJson,
  libraryFilename,
} from './src/export.js';

// A song import may carry up to 500 rows, which is far more than any edit or
// lookup sends, so the cap has to leave room for a whole library.
const MAX_BODY = 256 * 1024;

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

// Exports need a body and download headers rather than JSON.
function document({ contentType, filename = null, body }) {
  const headers = { 'content-type': contentType, 'cache-control': 'no-store' };
  if (filename) headers['content-disposition'] = `attachment; filename="${filename}"`;
  return new Response(body, { status: 200, headers });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new LookupError('Request body too large.', { status: 413 });
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new LookupError('Request body must be JSON.', { status: 400 });
  }
}

async function handleAddSong(db, request) {
  const body = await readJson(request);
  const title = String(body.title ?? '').trim();

  if (!title) return json({ error: 'Enter a song title.' }, 400);
  if (title.length > 200) return json({ error: 'That title is too long.' }, 400);

  // Nothing could be found online, so the row is saved exactly as typed.
  if (body.manual === true) return addSongByHand(db, title);

  let match;
  try {
    match = await lookupSong(title);
  } catch (error) {
    if (error instanceof LookupError) {
      return json({ error: error.message, candidates: error.candidates }, error.status);
    }
    console.error('[lookup]', error.message);
    return json(
      { error: 'The music services could not be reached, or are rate limiting requests. Try again in a moment.' },
      502,
    );
  }

  // Best effort: the song is still added when YouTube cannot be reached.
  match.youtubeUrl = await findYouTubeUrl(match.title, match.artist);

  const existing = (await findByIsrc(db, match.isrc)) ?? (await findByTitleArtist(db, match.title, match.artist));
  if (existing) {
    return json({ error: `“${existing.title}” by ${existing.artist} is already in your list.`, song: existing }, 409);
  }

  const song = await insertSong(db, match);
  return json({ song, match: { confidence: match.confidence, audioFeatures: match.audioFeatures } }, 201);
}

// A song the lookup could not identify is stored as typed rather than guessed:
// "Title - Artist" still fills both columns, and the key, tempo and link are
// left empty for the band to fill in with Edit.
async function addSongByHand(db, typed) {
  const split = typed.match(/^(.*\S)\s+[-\u2013\u2014]\s+(.+)$/);
  const title = (split ? split[1] : typed).trim();
  const artist = split ? split[2].trim() : '';

  if (!title) return json({ error: 'Enter a song title.' }, 400);
  if (artist.length > 200) return json({ error: 'That artist name is too long.' }, 400);

  const existing = await findByTitleArtist(db, title, artist);
  if (existing) return json({ error: `“${existing.title}” is already in your list.`, song: existing }, 409);

  const song = await insertSong(db, {
    title,
    artist,
    album: null,
    musicalKey: null,
    bpm: null,
    isrc: null,
    spotifyUrl: null,
    youtubeUrl: null,
  });
  return json({ song, manual: true }, 201);
}

// null clears the link; undefined means it was not a YouTube URL at all.
function parseYouTubeUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'youtu.be' && !host.endsWith('youtube.com')) return undefined;
  return url.toString();
}

async function handleUpdateSong(db, id, request) {
  const body = await readJson(request);
  const patch = {};

  for (const field of ['title', 'artist']) {
    if (!(field in body)) continue;
    const value = String(body[field] ?? '').trim();
    if (!value) return json({ error: `The ${field} cannot be empty.` }, 400);
    if (value.length > 200) return json({ error: `That ${field} is too long.` }, 400);
    patch[field] = value;
  }

  if ('key' in body) {
    const value = String(body.key ?? '').trim();
    if (value.length > 20) return json({ error: 'That key is too long.' }, 400);
    patch.key = value === '' ? null : value;
  }

  if ('bpm' in body) {
    if (body.bpm === null || String(body.bpm).trim() === '') {
      patch.bpm = null;
    } else {
      const bpm = Math.round(Number(body.bpm));
      if (!Number.isFinite(bpm) || bpm < 1 || bpm > 400) {
        return json({ error: 'BPM must be a whole number between 1 and 400.' }, 400);
      }
      patch.bpm = bpm;
    }
  }

  if ('youtubeUrl' in body) {
    const value = parseYouTubeUrl(body.youtubeUrl);
    if (value === undefined) return json({ error: 'That does not look like a YouTube link.' }, 400);
    patch.youtubeUrl = value;
  }

  if ('timeSignature' in body) {
    const value = String(body.timeSignature ?? '').trim();
    if (value === '') {
      patch.timeSignature = null;
    } else {
      const match = value.match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
      const beats = match ? Number(match[1]) : 0;
      const unit = match ? Number(match[2]) : 0;
      if (!match || beats < 2 || beats > 12 || ![2, 4, 8, 16].includes(unit)) {
        return json({ error: 'Bar length must look like 4/4, 3/4 or 6/8.' }, 400);
      }
      patch.timeSignature = `${beats}/${unit}`;
    }
  }

  // A free-form note: anything worth remembering that has no column of its own.
  if ('notes' in body) {
    const value = String(body.notes ?? '').trim();
    if (value.length > 500) return json({ error: 'That note is too long — keep it under 500 characters.' }, 400);
    patch.notes = value === '' ? null : value;
  }

  if (Object.keys(patch).length === 0) return json({ error: 'Nothing to update.' }, 400);

  const song = await updateSong(db, id, patch);
  if (!song) return json({ error: 'Song not found.' }, 404);
  return json({ song });
}

// Seeding an empty library from an existing song list. Refuses once there are
// songs, so it cannot be used to overwrite a live list.
async function handleImport(db, request) {
  if ((await countSongs(db)) > 0) return json({ error: 'Import only works into an empty library.' }, 409);

  const body = await readJson(request);
  const rows = Array.isArray(body.songs) ? body.songs : [];
  if (rows.length === 0) return json({ error: 'Send { "songs": [...] }.' }, 400);
  if (rows.length > 500) return json({ error: 'At most 500 songs at a time.' }, 400);

  const imported = await importSongs(db, rows);
  // A backup carries the setlists too; files written before that simply have none.
  const setlists = Array.isArray(body.setlists) ? body.setlists.slice(0, 200) : [];
  return json({ imported, setlists: await importSetlists(db, setlists) }, 201);
}

async function handleSetlistRoutes(db, url, request) {
  const { pathname } = url;

  if (pathname === '/api/setlists' && request.method === 'GET') {
    return json({ setlists: await listSetlists(db) });
  }

  if (pathname === '/api/setlists' && request.method === 'POST') {
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    if (!name) return json({ error: 'Give the setlist a name.' }, 400);
    if (name.length > 100) return json({ error: 'That name is too long.' }, 400);
    return json({ setlist: await createSetlist(db, name) }, 201);
  }

  // Download the setlist as text or CSV, or open a page that prints cleanly.
  const exportMatch = pathname.match(/^\/api\/setlists\/(\d+)\/export$/);
  if (exportMatch && request.method === 'GET') {
    const setlist = await getSetlist(db, Number(exportMatch[1]));
    if (!setlist) return json({ error: 'Setlist not found.' }, 404);

    const format = (url.searchParams.get('format') ?? 'txt').toLowerCase();
    if (format === 'txt' || format === 'text') {
      return document({
        contentType: 'text/plain; charset=utf-8',
        filename: exportFilename(setlist.name, 'txt'),
        body: setlistText(setlist),
      });
    }
    if (format === 'csv') {
      return document({
        contentType: 'text/csv; charset=utf-8',
        filename: exportFilename(setlist.name, 'csv'),
        body: setlistCsv(setlist),
      });
    }
    if (format === 'print' || format === 'html') {
      return document({
        contentType: 'text/html; charset=utf-8',
        body: setlistPrintPage(setlist),
      });
    }
    return json({ error: 'Supported formats are txt, csv and print.' }, 400);
  }

  const setlistMatch = pathname.match(/^\/api\/setlists\/(\d+)$/);
  if (setlistMatch) {
    const id = Number(setlistMatch[1]);
    if (request.method === 'GET') {
      const setlist = await getSetlist(db, id);
      if (!setlist) return json({ error: 'Setlist not found.' }, 404);
      return json({ setlist });
    }
    if (request.method === 'DELETE') {
      if (!(await deleteSetlist(db, id))) return json({ error: 'Setlist not found.' }, 404);
      return noContent();
    }
  }

  const songsMatch = pathname.match(/^\/api\/setlists\/(\d+)\/songs$/);
  if (songsMatch && request.method === 'POST') {
    const setlistId = Number(songsMatch[1]);
    const body = await readJson(request);
    const songId = Number(body.songId);
    if (!Number.isInteger(songId) || songId < 1) return json({ error: 'Pick a song to add.' }, 400);

    const result = await addSongToSetlist(db, setlistId, songId);
    if (result.status === 'no-setlist') return json({ error: 'Setlist not found.' }, 404);
    if (result.status === 'no-song') return json({ error: 'Song not found.' }, 404);
    if (result.status === 'duplicate') return json({ error: 'That song is already in this setlist.' }, 409);
    return json({ setlist: result.setlist }, 201);
  }

  const entryMatch = pathname.match(/^\/api\/setlists\/(\d+)\/songs\/(\d+)$/);
  if (entryMatch && request.method === 'DELETE') {
    const setlist = await removeSongFromSetlist(db, Number(entryMatch[1]), Number(entryMatch[2]));
    if (!setlist) return json({ error: 'That song is not in this setlist.' }, 404);
    return json({ setlist });
  }

  const orderMatch = pathname.match(/^\/api\/setlists\/(\d+)\/order$/);
  if (orderMatch && request.method === 'PATCH') {
    const body = await readJson(request);
    const entryIds = Array.isArray(body.entryIds) ? body.entryIds.map(Number) : null;
    if (!entryIds || entryIds.some(id => !Number.isInteger(id) || id < 1)) {
      return json({ error: 'Send the setlist songs in their new order.' }, 400);
    }
    const setlist = await reorderSetlist(db, Number(orderMatch[1]), entryIds);
    if (setlist === null) return json({ error: 'Setlist not found.' }, 404);
    if (setlist === undefined) {
      return json({ error: 'That order does not match the songs in this setlist.' }, 400);
    }
    return json({ setlist });
  }

  return null;
}

// The page, script and stylesheet carry no version in their names, so a cached
// copy would keep a fix off the band's phones until someone hard-reloads. Asking
// the browser to check back every time costs one conditional request: an
// unchanged file comes back as a cheap 304, and a new deploy is picked up on the
// next page load without anyone being told to refresh.
async function freshAsset(env, request) {
  const response = await env.ASSETS.fetch(request);
  const copy = new Response(response.body, response);
  copy.headers.set('cache-control', 'no-cache, must-revalidate');
  return copy;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;
    const db = env.DB;

    try {
      if (!pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
        return await freshAsset(env, request);
      }

      await ensureSchema(db);

      if (pathname === '/api/songs' && method === 'GET') return json({ songs: await listSongs(db) });
      if (pathname === '/api/songs' && method === 'POST') return await handleAddSong(db, request);
      if (pathname === '/api/import' && method === 'POST') return await handleImport(db, request);

      // The whole song library and its setlists as one JSON file.
      if (pathname === '/api/library/export' && method === 'GET') {
        const songs = await listSongs(db);
        const setlists = [];
        for (const entry of await listSetlists(db)) {
          const full = await getSetlist(db, entry.id);
          if (full) setlists.push(full);
        }
        return document({
          contentType: 'application/json; charset=utf-8',
          filename: libraryFilename(),
          body: libraryJson(songs, setlists),
        });
      }

      // The whole list on one printable page, without building a setlist first.
      if (pathname === '/api/library/print' && method === 'GET') {
        return document({
          contentType: 'text/html; charset=utf-8',
          body: libraryPrintPage(await listSongs(db)),
        });
      }

      const songMatch = pathname.match(/^\/api\/songs\/(\d+)$/);
      if (songMatch && method === 'PATCH') return await handleUpdateSong(db, Number(songMatch[1]), request);
      if (songMatch && method === 'DELETE') {
        const removed = await deleteSong(db, Number(songMatch[1]));
        return removed ? noContent() : json({ error: 'Song not found.' }, 404);
      }

      // Resolve a YouTube link for one song; used by the "find missing links" pass.
      const youtubeMatch = pathname.match(/^\/api\/songs\/(\d+)\/youtube$/);
      if (youtubeMatch && method === 'POST') {
        const song = await getSong(db, Number(youtubeMatch[1]));
        if (!song) return json({ error: 'Song not found.' }, 404);
        const url = await findYouTubeUrl(song.title, song.artist);
        if (!url) return json({ error: 'No YouTube video found for that song.' }, 404);
        return json({ song: await updateSong(db, song.id, { youtubeUrl: url }) });
      }

      if (pathname.startsWith('/api/setlists')) {
        const handled = await handleSetlistRoutes(db, url, request);
        if (handled) return handled;
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof LookupError) return json({ error: error.message }, error.status);
      console.error(error?.stack ?? error);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};
