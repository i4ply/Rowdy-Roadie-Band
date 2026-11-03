// Tiny zero-dependency web server: JSON API + static front end.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
} from './src/store.js';
import { lookupSong, findYouTubeUrl, LookupError } from './src/lookup.js';
import { setlistText, setlistCsv, setlistPrintPage, exportFilename } from './src/export.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

// Exports need a body and download headers rather than JSON.
function sendDocument(response, { contentType, filename = null, body }) {
  const buffer = Buffer.from(body, 'utf8');
  const headers = {
    'content-type': contentType,
    'content-length': buffer.length,
    'cache-control': 'no-store',
  };
  if (filename) headers['content-disposition'] = `attachment; filename="${filename}"`;
  response.writeHead(200, headers);
  response.end(buffer);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new LookupError('Request body too large.', { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new LookupError('Request body must be JSON.', { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'content-length': file.length,
    });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

async function handleAddSong(request, response) {
  const body = await readJsonBody(request);
  const title = String(body.title ?? '').trim();

  if (!title) return sendJson(response, 400, { error: 'Enter a song title.' });
  if (title.length > 200) return sendJson(response, 400, { error: 'That title is too long.' });

  let match;
  try {
    match = await lookupSong(title);
  } catch (error) {
    if (error instanceof LookupError) {
      return sendJson(response, error.status, { error: error.message, candidates: error.candidates });
    }
    console.error('[lookup]', error.message);
    return sendJson(response, 502, {
      error: 'The music services could not be reached, or are rate limiting requests. Try again in a moment.',
    });
  }

  // Best effort: the song is still added when YouTube cannot be reached.
  match.youtubeUrl = await findYouTubeUrl(match.title, match.artist);

  const existing = findByIsrc(match.isrc) ?? findByTitleArtist(match.title, match.artist);
  if (existing) {
    return sendJson(response, 409, { error: `“${existing.title}” by ${existing.artist} is already in your list.`, song: existing });
  }

  const song = insertSong(match);
  sendJson(response, 201, {
    song,
    match: { confidence: match.confidence, audioFeatures: match.audioFeatures },
  });
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

async function handleUpdateSong(id, request, response) {
  const body = await readJsonBody(request);
  const patch = {};

  for (const field of ['title', 'artist']) {
    if (!(field in body)) continue;
    const value = String(body[field] ?? '').trim();
    if (!value) return sendJson(response, 400, { error: `The ${field} cannot be empty.` });
    if (value.length > 200) return sendJson(response, 400, { error: `That ${field} is too long.` });
    patch[field] = value;
  }

  if ('key' in body) {
    const value = String(body.key ?? '').trim();
    if (value.length > 20) return sendJson(response, 400, { error: 'That key is too long.' });
    patch.key = value === '' ? null : value;
  }

  if ('bpm' in body) {
    if (body.bpm === null || String(body.bpm).trim() === '') {
      patch.bpm = null;
    } else {
      const bpm = Math.round(Number(body.bpm));
      if (!Number.isFinite(bpm) || bpm < 1 || bpm > 400) {
        return sendJson(response, 400, { error: 'BPM must be a whole number between 1 and 400.' });
      }
      patch.bpm = bpm;
    }
  }

  if ('youtubeUrl' in body) {
    const value = parseYouTubeUrl(body.youtubeUrl);
    if (value === undefined) {
      return sendJson(response, 400, { error: 'That does not look like a YouTube link.' });
    }
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
        return sendJson(response, 400, { error: 'Bar length must look like 4/4, 3/4 or 6/8.' });
      }
      patch.timeSignature = `${beats}/${unit}`;
    }
  }

  if (Object.keys(patch).length === 0) {
    return sendJson(response, 400, { error: 'Nothing to update.' });
  }

  const song = updateSong(id, patch);
  if (!song) return sendJson(response, 404, { error: 'Song not found.' });
  return sendJson(response, 200, { song });
}

async function handleSetlistRoutes(url, request, response) {
  const { pathname } = url;
  if (pathname === '/api/setlists' && request.method === 'GET') {
    sendJson(response, 200, { setlists: listSetlists() });
    return true;
  }

  if (pathname === '/api/setlists' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const name = String(body.name ?? '').trim();
    if (!name) return sendJson(response, 400, { error: 'Give the setlist a name.' }), true;
    if (name.length > 100) return sendJson(response, 400, { error: 'That name is too long.' }), true;
    sendJson(response, 201, { setlist: createSetlist(name) });
    return true;
  }

  // Download the setlist as text or CSV, or open a page that prints cleanly.
  const exportMatch = pathname.match(/^\/api\/setlists\/(\d+)\/export$/);
  if (exportMatch && request.method === 'GET') {
    const setlist = getSetlist(Number(exportMatch[1]));
    if (!setlist) return sendJson(response, 404, { error: 'Setlist not found.' }), true;

    const format = (url.searchParams.get('format') ?? 'txt').toLowerCase();
    if (format === 'txt' || format === 'text') {
      sendDocument(response, {
        contentType: 'text/plain; charset=utf-8',
        filename: exportFilename(setlist.name, 'txt'),
        body: setlistText(setlist),
      });
      return true;
    }
    if (format === 'csv') {
      sendDocument(response, {
        contentType: 'text/csv; charset=utf-8',
        filename: exportFilename(setlist.name, 'csv'),
        body: setlistCsv(setlist),
      });
      return true;
    }
    if (format === 'print' || format === 'html') {
      sendDocument(response, {
        contentType: 'text/html; charset=utf-8',
        body: setlistPrintPage(setlist),
      });
      return true;
    }
    return sendJson(response, 400, { error: 'Supported formats are txt, csv and print.' }), true;
  }

  const setlistMatch = pathname.match(/^\/api\/setlists\/(\d+)$/);
  if (setlistMatch) {
    const id = Number(setlistMatch[1]);
    if (request.method === 'GET') {
      const setlist = getSetlist(id);
      if (!setlist) return sendJson(response, 404, { error: 'Setlist not found.' }), true;
      sendJson(response, 200, { setlist });
      return true;
    }
    if (request.method === 'DELETE') {
      if (!deleteSetlist(id)) return sendJson(response, 404, { error: 'Setlist not found.' }), true;
      response.writeHead(204).end();
      return true;
    }
  }

  const songsMatch = pathname.match(/^\/api\/setlists\/(\d+)\/songs$/);
  if (songsMatch && request.method === 'POST') {
    const setlistId = Number(songsMatch[1]);
    const body = await readJsonBody(request);
    const songId = Number(body.songId);
    if (!Number.isInteger(songId) || songId < 1) {
      return sendJson(response, 400, { error: 'Pick a song to add.' }), true;
    }

    const result = addSongToSetlist(setlistId, songId);
    if (result.status === 'no-setlist') return sendJson(response, 404, { error: 'Setlist not found.' }), true;
    if (result.status === 'no-song') return sendJson(response, 404, { error: 'Song not found.' }), true;
    if (result.status === 'duplicate') {
      return sendJson(response, 409, { error: 'That song is already in this setlist.' }), true;
    }
    sendJson(response, 201, { setlist: result.setlist });
    return true;
  }

  const entryMatch = pathname.match(/^\/api\/setlists\/(\d+)\/songs\/(\d+)$/);
  if (entryMatch && request.method === 'DELETE') {
    const setlist = removeSongFromSetlist(Number(entryMatch[1]), Number(entryMatch[2]));
    if (!setlist) return sendJson(response, 404, { error: 'That song is not in this setlist.' }), true;
    sendJson(response, 200, { setlist });
    return true;
  }

  const orderMatch = pathname.match(/^\/api\/setlists\/(\d+)\/order$/);
  if (orderMatch && request.method === 'PATCH') {
    const body = await readJsonBody(request);
    const entryIds = Array.isArray(body.entryIds) ? body.entryIds.map(Number) : null;
    if (!entryIds || entryIds.some(id => !Number.isInteger(id) || id < 1)) {
      return sendJson(response, 400, { error: 'Send the setlist songs in their new order.' }), true;
    }
    const setlist = reorderSetlist(Number(orderMatch[1]), entryIds);
    if (setlist === null) return sendJson(response, 404, { error: 'Setlist not found.' }), true;
    if (setlist === undefined) {
      return sendJson(response, 400, { error: 'That order does not match the songs in this setlist.' }), true;
    }
    sendJson(response, 200, { setlist });
    return true;
  }

  return false;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/songs' && request.method === 'GET') {
      return sendJson(response, 200, { songs: listSongs() });
    }
    if (pathname === '/api/songs' && request.method === 'POST') {
      return await handleAddSong(request, response);
    }
    const songMatch = pathname.match(/^\/api\/songs\/(\d+)$/);
    if (songMatch && request.method === 'PATCH') {
      return await handleUpdateSong(Number(songMatch[1]), request, response);
    }
    if (songMatch && request.method === 'DELETE') {
      const removed = deleteSong(Number(songMatch[1]));
      if (!removed) return sendJson(response, 404, { error: 'Song not found.' });
      response.writeHead(204).end();
      return;
    }
    // Resolve a YouTube link for one song; used by the "find missing links" pass.
    const youtubeMatch = pathname.match(/^\/api\/songs\/(\d+)\/youtube$/);
    if (youtubeMatch && request.method === 'POST') {
      const song = getSong(Number(youtubeMatch[1]));
      if (!song) return sendJson(response, 404, { error: 'Song not found.' });
      const url = await findYouTubeUrl(song.title, song.artist);
      if (!url) return sendJson(response, 404, { error: 'No YouTube video found for that song.' });
      return sendJson(response, 200, { song: updateSong(song.id, { youtubeUrl: url }) });
    }
    if (pathname.startsWith('/api/setlists')) {
      if (await handleSetlistRoutes(url, request, response)) return;
      return sendJson(response, 404, { error: 'Not found' });
    }
    if (pathname.startsWith('/api/')) {
      return sendJson(response, 404, { error: 'Not found' });
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      return await serveStatic(pathname, response);
    }
    return sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    if (error instanceof LookupError) return sendJson(response, error.status, { error: error.message });
    console.error(error);
    return sendJson(response, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Song list database running at http://${HOST}:${PORT}`);
});
