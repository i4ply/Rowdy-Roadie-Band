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
// Apple answers for whichever country the request came from when no storefront
// is named, and a 1993 country single can drop out of the results in some of
// them — so the storefront is pinned.
const ITUNES_COUNTRY = 'US';
const RECCOBEATS_URL = 'https://api.reccobeats.com/v1';

const USER_AGENT = 'SongBook/1.0 (song list database)';
const PAGE_SIZE = 50;
const MAX_PAGES = 3;

// YouTube has no keyless API. A plain results page is the only way to resolve a
// video without a developer key, and it needs a browser user agent.
const YOUTUBE_SEARCH = 'https://www.youtube.com/results?search_query=';
const YOUTUBE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Uploads that are not the recording: a karaoke track or an instrumental would
// mislead someone learning the song, so they are never used at all.
const REJECT_VIDEO = /karaoke|instrumental|backing track|tribute|cover band|\(cover\)/i;
// A lyric video is the artist's own audio with the words on screen. It is a
// fine stand-in when that is all the artist has published, but only ever as
// the last resort.
const LYRIC_VIDEO = /lyrics? video|\blyrics?\b/i;
// A different performance from the one the key and BPM describe, so it loses to
// the studio recording whenever there is a choice.
const LIVE_VIDEO = /\blive\b|concert|bootleg|in concert/i;

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

// Sharps are spelled as their flat equivalents. It is the same pitch either
// way, and a flat is the spelling a band reads off a chart far more often than
// the sharp — nobody says "A sharp" when they mean the B flat they are playing.
const PITCH_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

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

// Country and blues titles love the clipped spelling — "Hard Workin' Man" —
// while people type the full word. Dropping the g on -ing words lets the two
// find each other instead of reporting a famous song as missing.
const looseTitle = value => normalize(value).replace(/\b([a-z]{3,})ing\b/g, '$1in');

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
  const url = `${ITUNES_URL}?term=${encodeURIComponent(titleKey)}&entity=song&media=music&limit=15&country=${ITUNES_COUNTRY}`;
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
      const looseCandidate = looseTitle(candidate);
      const looseKey = looseTitle(titleKey);
      if (candidate === titleKey || looseCandidate === looseKey) return true;
      if (titleKey.length <= 2) return false;
      return (
        candidate.includes(titleKey) ||
        titleKey.includes(candidate) ||
        looseCandidate.includes(looseKey) ||
        looseKey.includes(looseCandidate)
      );
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

  const looseKey = looseTitle(titleKey);
  const looseTitles = [looseTitle(rawTitle), looseTitle(candidateTitle)];

  let score = popularity * WEIGHT.popularity;
  let titleMatch = false;

  if (rawTitle === titleKey || candidateTitle === titleKey || looseTitles.includes(looseKey)) {
    score += WEIGHT.titleExact;
    titleMatch = true;
  } else if (
    titleKey.length > 2 &&
    (rawTitle.includes(titleKey) || candidateTitle.includes(titleKey) || looseTitles.some(title => title.includes(looseKey)))
  ) {
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
  const looseRaw = looseTitle(rawTitle);
  const fallback =
    known.find(track => normalize(track.title) === rawTitle || looseTitle(track.title) === looseRaw) ??
    known[0] ??
    null;

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

// The results page is around a megabyte and YouTube is not always quick about
// it, so a slow reply gets one more try instead of a blank link.
async function fetchYouTubeResults(query) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${YOUTUBE_SEARCH}${encodeURIComponent(query)}`, {
        headers: { 'user-agent': YOUTUBE_USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      // try once more, then give up
    }
  }
  return null;
}

// Every video on a results page, in the order YouTube ranked them.
function parseYouTubeResults(html) {
  const pattern =
    /"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,3000}?"title":\{"runs":\[\{"text":"([^"]{3,120})"/g;
  const videos = [];
  for (const [, videoId, title] of html.matchAll(pattern)) {
    if (!videos.some(video => video.videoId === videoId)) videos.push({ videoId, title });
  }
  return videos;
}

// "X Ambassadors" -> the words worth finding in a video title, so a title that
// names the band beats a bare re-upload that only names the song.
function significantWords(artistKey) {
  return artistKey.split(' ').filter(word => word.length >= 3 && !/^(the|and)$/.test(word));
}

// Higher is better. YouTube's own ranking is the tie-break, so the score only
// has to say "this one names the band, looks official, and is the studio
// recording". An official upload outranks a fan re-upload, and the artist's own
// audio behind a lyric video still beats somebody's phone recording of a gig.
function scoreVideo(video, { titleKey, artistKey, index }) {
  const text = normalize(video.title);
  let score = 0;
  if (artistKey && text.includes(artistKey)) score += 40;
  else if (significantWords(artistKey).every(word => text.includes(word))) score += 25;
  if (titleKey && text.includes(titleKey)) score += 20;
  if (/\bofficial\b|\bvevo\b/.test(text)) score += 30;
  if (LYRIC_VIDEO.test(video.title)) score -= 5;
  // Enough to lose to the studio audio even when the live upload does name the
  // band, which it usually does: "Artist - Song (Live 1995)" scores otherwise
  // well on the two checks above.
  if (LIVE_VIDEO.test(video.title)) score -= 45;
  return score - index / 100;
}

// Best effort: the best real video or audio upload for "title artist". A
// karaoke, instrumental or cover upload is refused, because a wrong link is
// worse than no link. When the only thing on offer is a lyric video, that is
// used rather than leaving the row blank — the words on screen still identify
// the recording, and a blank link is no help at all.
// Returns null on any failure so adding a song never depends on this.
export async function findYouTubeUrl(title, artist) {
  const query = [title, artist].filter(Boolean).join(' ').trim();
  if (!query) return null;

  const html = await fetchYouTubeResults(query);
  if (!html) return null;

  const videos = parseYouTubeResults(html).filter(video => !REJECT_VIDEO.test(video.title));
  if (videos.length === 0) return null;

  const titleKey = normalize(title);
  const artistKey = normalize(artist);
  const chosen = videos
    .map((video, index) => ({ video, score: scoreVideo(video, { titleKey, artistKey, index }) }))
    .sort((a, b) => b.score - a.score)[0].video;

  return chosen ? `https://www.youtube.com/watch?v=${chosen.videoId}` : null;
}
