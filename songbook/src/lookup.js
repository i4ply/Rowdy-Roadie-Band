// Looks a song up online and returns artist, musical key and BPM.
//
// Two keyless services are combined:
//   * Apple iTunes Search API  -> which recording does the user mean (artist, title)
//   * ReccoBeats API           -> audio features for that recording (key, mode, tempo)
//
// Neither service can be trusted alone: ReccoBeats' search ranks covers and
// karaoke versions first and its popularity figures are stale for older
// catalogues, while Apple has no audio features. Apple's ordering decides which
// artist the user meant; ReccoBeats is then searched for that same artist.
//
// ReccoBeats does not cover every recording. When the artist Apple ranked first
// is missing there, the song is still returned with the correct artist and an
// unknown key/BPM instead of silently storing a cover's tempo.

const ITUNES_URL = 'https://itunes.apple.com/search';
const RECCOBEATS_URL = 'https://api.reccobeats.com/v1';

const USER_AGENT = 'SongBook/1.0 (song list database)';
const PAGE_SIZE = 50;
const MAX_PAGES = 3;

// YouTube has no keyless API. A plain results page is the only way to resolve a
// video without a developer key, and it needs a browser user agent.
const YOUTUBE_SEARCH = 'https://www.youtube.com/results?search_query=';
const YOUTUBE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NOISY_VIDEO = /karaoke|instrumental|backing track|tribute|cover band|\(cover\)|lyrics? video/i;

// Weights for picking the recording the user meant. Artist identity dominates:
// popularity only breaks ties between versions of the same song.
const WEIGHT = {
  titleExact: 40,
  titlePartial: 15,
  artistTop: 45,
  artistHigh: 30,
  artistLow: 10,
  artistHint: 70,
  popularity: 0.2,
};
const MIN_SCORE_WITHOUT_IDENTITY = 45;

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export class LookupError extends Error {
  constructor(message, { status = 404, candidates = [] } = {}) {
    super(message);
    this.name = 'LookupError';
    this.status = status;
    this.candidates = candidates;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "Bohemian Rhapsody - Remastered 2011" -> "bohemian rhapsody"
function baseTitle(value) {
  return normalize(
    String(value ?? '')
      .replace(/\s*[([].*?[)\]]\s*/g, ' ')
      .replace(/\s+-\s+.*$/, ' '),
  );
}

// "The Weeknd & ROSALÍA" should still be recognised as The Weeknd.
function artistMatches(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

async function fetchJson(url, { attempts = 4, timeout = 15000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeout),
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`service replied ${response.status}`);
      }
      if (!response.ok) {
        const error = new Error(`service replied ${response.status}`);
        error.retryable = false;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error.retryable === false) break;
      await sleep(500 * (attempt + 1));
    }
  }
  lastError ??= new Error('request failed');
  throw lastError;
}

// Which recording did the user mean? Apple's relevance ranking is the best
// keyless guide to the canonical version of a song, so its order is preserved.
async function searchItunes(titleKey) {
  const url = `${ITUNES_URL}?term=${encodeURIComponent(titleKey)}&entity=song&media=music&limit=15`;
  const data = await fetchJson(url).catch(() => ({ results: [] }));
  return (data.results ?? [])
    .filter(track => track.trackName && track.artistName)
    .map(track => ({
      title: track.trackName,
      artist: track.artistName,
      album: track.collectionName ?? null,
    }))
    .filter(track => {
      const candidate = baseTitle(track.title);
      if (candidate === titleKey) return true;
      return titleKey.length > 2 && (candidate.includes(titleKey) || titleKey.includes(candidate));
    });
}

async function searchReccoBeats(titleKey) {
  const candidates = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${RECCOBEATS_URL}/track/search?searchText=${encodeURIComponent(titleKey)}&size=${PAGE_SIZE}&page=${page}`;
    const data = await fetchJson(url);
    const content = data.content ?? [];
    candidates.push(...content);
    if (content.length < PAGE_SIZE) break;
  }
  return candidates;
}

async function fetchAudioFeatures(spotifyId) {
  if (!spotifyId) return null;
  try {
    const data = await fetchJson(`${RECCOBEATS_URL}/audio-features?ids=${encodeURIComponent(spotifyId)}`, { attempts: 2 });
    return (data.content ?? [])[0] ?? null;
  } catch {
    return null;
  }
}

function spotifyIdOf(track) {
  const href = String(track?.href ?? '');
  const part = href.split('/').filter(Boolean).pop();
  return part && part.length === 22 ? part : null;
}

// Spotify encodes key as a pitch class 0-11 plus a mode: 1 major, 0 minor.
export function musicalKeyName(key, mode) {
  const pitch = Number(key);
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 11) return null;
  const name = PITCH_NAMES[pitch];
  const scale = Number(mode);
  if (scale === 1) return name;
  if (scale === 0) return `${name} minor`;
  return name;
}

function scoreCandidate(track, { titleKey, artistHint, knownArtists }) {
  const candidateTitle = baseTitle(track.trackTitle);
  const rawTitle = normalize(track.trackTitle);
  const artists = (track.artists ?? []).map(artist => normalize(artist.name));
  const popularity = Number(track.popularity) || 0;

  let score = popularity * WEIGHT.popularity;
  let titleMatch = false;

  if (rawTitle === titleKey || candidateTitle === titleKey) {
    score += WEIGHT.titleExact;
    titleMatch = true;
  } else if (titleKey.length > 2 && (rawTitle.includes(titleKey) || candidateTitle.includes(titleKey))) {
    score += WEIGHT.titlePartial;
    titleMatch = true;
  }
  if (!titleMatch) return null;

  let artistRank;
  for (const known of knownArtists) {
    if (artists.some(name => artistMatches(name, known.name))) {
      if (artistRank === undefined || known.rank < artistRank) artistRank = known.rank;
    }
  }
  if (artistRank === 0) score += WEIGHT.artistTop;
  else if (artistRank !== undefined && artistRank <= 2) score += WEIGHT.artistHigh;
  else if (artistRank !== undefined && artistRank <= 6) score += WEIGHT.artistLow;

  let hintMatch = false;
  if (artistHint) {
    if (artists.includes(artistHint)) {
      score += WEIGHT.artistHint;
      hintMatch = true;
    } else if (artists.some(name => artistMatches(name, artistHint))) {
      score += WEIGHT.artistHint / 2;
      hintMatch = true;
    }
  }

  return { score, track, artistRank, hintMatch };
}

// "Song - Artist" is a natural way to disambiguate, so accept it.
function splitQuery(input) {
  const trimmed = String(input ?? '').trim();
  const match = trimmed.match(/^(.*\S)\s+[-–—]\s+(.+)$/);
  if (!match) return { title: trimmed, artistHint: null };
  const [, title, artist] = match;
  if (normalize(artist).split(' ').length > 4) return { title: trimmed, artistHint: null };
  return { title: title.trim(), artistHint: normalize(artist) };
}

function withoutFeatures(entry) {
  return {
    title: entry.title,
    artist: entry.artist,
    extraArtists: [],
    album: entry.album,
    musicalKey: null,
    bpm: null,
    isrc: null,
    spotifyUrl: null,
    confidence: 0,
    audioFeatures: false,
  };
}

export async function lookupSong(input) {
  const { title, artistHint } = splitQuery(input);
  if (!title) throw new LookupError('Enter a song title.', { status: 400 });

  const titleKey = baseTitle(title);
  const rawTitle = normalize(title);
  const known = await searchItunes(titleKey);

  // Apple's ordering is a relevance signal: an artist near the top of its
  // results is a much stronger hint than one that only appears further down.
  const knownArtists = [];
  known.forEach((track, index) => {
    const name = normalize(track.artist);
    if (!knownArtists.some(entry => entry.name === name)) knownArtists.push({ name, rank: index });
  });

  const candidates = await searchReccoBeats(titleKey);
  const ranked = candidates
    .map(track => scoreCandidate(track, { titleKey, artistHint, knownArtists }))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // If the recording is not covered, still keep the artist the user meant.
  const fallback = known.find(track => normalize(track.title) === rawTitle) ?? known[0] ?? null;

  let chosen = null;
  if (artistHint) {
    chosen = ranked.find(entry => entry.hintMatch) ?? null;
    if (!chosen && fallback && artistMatches(normalize(fallback.artist), artistHint)) {
      return withoutFeatures(fallback);
    }
  } else if (knownArtists.length > 0) {
    // Prefer the plain release over a version of it, e.g. "Sunday Morning"
    // rather than "Sunday Morning - Acoustic".
    const byTopArtist = ranked.filter(entry => entry.artistRank === 0);
    chosen = byTopArtist.find(entry => normalize(entry.track.trackTitle) === rawTitle) ?? byTopArtist[0] ?? null;
    if (!chosen && fallback) return withoutFeatures(fallback);
  } else {
    // Apple had nothing to say; fall back to the most popular exact-title match.
    chosen = ranked.length > 0 && ranked[0].score >= MIN_SCORE_WITHOUT_IDENTITY ? ranked[0] : null;
  }

  if (!chosen) {
    const message = artistHint
      ? `No recording of “${title}” by that artist was found.`
      : `No match for “${title}” in the music database.`;
    throw new LookupError(message, {
      candidates: ranked.slice(0, 5).map(entry => ({
        title: entry.track.trackTitle,
        artist: (entry.track.artists ?? []).map(artist => artist.name).join(', '),
      })),
    });
  }

  const best = chosen.track;
  const features = await fetchAudioFeatures(spotifyIdOf(best));
  const artists = (best.artists ?? []).map(artist => artist.name);

  return {
    title: best.trackTitle,
    artist: artists[0] ?? fallback?.artist ?? 'Unknown artist',
    extraArtists: artists.slice(1),
    album: known.find(track => normalize(track.artist) === normalize(artists[0]))?.album ?? null,
    musicalKey: features ? musicalKeyName(features.key, features.mode) : null,
    bpm: features && Number.isFinite(Number(features.tempo)) ? Math.round(Number(features.tempo)) : null,
    isrc: best.isrc ?? null,
    spotifyUrl: best.href ?? null,
    confidence: Math.round(chosen.score),
    audioFeatures: Boolean(features),
  };
}

// Best effort: take the first YouTube result for "title artist". A karaoke or
// cover upload is rejected, because a wrong link is worse than no link.
// Returns null on any failure so adding a song never depends on this.
export async function findYouTubeUrl(title, artist) {
  const query = [title, artist].filter(Boolean).join(' ').trim();
  if (!query) return null;

  try {
    const response = await fetch(`${YOUTUBE_SEARCH}${encodeURIComponent(query)}`, {
      headers: { 'user-agent': YOUTUBE_USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;

    const html = await response.text();
    const match = html.match(
      /"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,3000}?"title":\{"runs":\[\{"text":"([^"]{3,120})"/,
    );
    if (!match) return null;

    const [, videoId, videoTitle] = match;
    if (NOISY_VIDEO.test(videoTitle)) return null;
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch {
    return null;
  }
}
