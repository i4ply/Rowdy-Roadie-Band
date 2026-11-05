const form = document.getElementById('add-form');
const input = document.getElementById('title');
const submit = document.getElementById('submit');
const status = document.getElementById('status');
const rows = document.getElementById('rows');
const empty = document.getElementById('empty');
const summary = document.getElementById('summary');

const batchForm = document.getElementById('batch-form');
const batchInput = document.getElementById('batch-titles');
const batchSubmit = document.getElementById('batch-submit');
const batchStatus = document.getElementById('batch-status');

const setlistSelect = document.getElementById('setlist-select');
const newSetlistForm = document.getElementById('new-setlist-form');
const newSetlistName = document.getElementById('new-setlist-name');
const deleteSetlistButton = document.getElementById('delete-setlist');
const setlistSongs = document.getElementById('setlist-songs');
const setlistEmpty = document.getElementById('setlist-empty');
const setlistStatus = document.getElementById('setlist-status');
const setlistExport = document.getElementById('setlist-export');
const exportTxt = document.getElementById('export-txt');
const exportCsv = document.getElementById('export-csv');
const exportPrint = document.getElementById('export-print');
const findYouTubeButton = document.getElementById('find-youtube');
const searchInput = document.getElementById('search');
const muteButton = document.getElementById('mute-click');

const MAX_BATCH = 200;

let songs = [];
let activeSetlist = null;
let searchText = '';

// Sorting is presentational: the rows are re-rendered from the same objects, so
// nothing is written back, re-fetched or dropped.
const sortState = { column: null, direction: 'asc' };
const sortButtons = [...document.querySelectorAll('th button.sort')];

function setStatus(message, tone = 'info') {
  status.textContent = message;
  status.dataset.tone = tone;
}

function setBatchStatus(message, tone = 'info') {
  batchStatus.textContent = message;
  batchStatus.dataset.tone = tone;
}

function setSetlistStatus(message, tone = 'info') {
  setlistStatus.textContent = message;
  setlistStatus.dataset.tone = tone;
}

function makeButton(text, className, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  if (label) button.setAttribute('aria-label', label);
  return button;
}

function youTubeLink(url, title) {
  const link = document.createElement('a');
  link.className = 'yt-link';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '▶';
  link.title = 'Watch on YouTube';
  link.setAttribute('aria-label', `Watch ${title} on YouTube`);
  return link;
}

function makeInput(value, className, attributes = {}) {
  const field = document.createElement('input');
  field.type = 'text';
  field.value = value ?? '';
  field.className = className;
  for (const [name, attributeValue] of Object.entries(attributes)) {
    field.setAttribute(name, attributeValue);
  }
  return field;
}

// A setlist row carries the same tempo button as the list, so a count-in can
// start from the running order instead of scrolling back to the song.
function describeParts(song) {
  const parts = [];
  if (song.key) parts.push(`key ${song.key}`);

  if (song.bpm) {
    const tempo = document.createElement('span');
    tempo.className = 'setlist-bpm';
    tempo.append(bpmButton(song));

    if (song.timeSignature) {
      const signature = document.createElement('span');
      signature.className = 'signature';
      signature.textContent = song.timeSignature;
      signature.title = `${beatsPerBar(song)} to the bar`;
      tempo.append(signature);
    }
    parts.push(tempo);
  }

  if (!parts.length) return ['—'];
  return parts.flatMap((part, index) => (index === 0 ? [part] : [' · ', part]));
}

// --- Songs ---------------------------------------------------------------

async function removeSong(song) {
  const response = await fetch(`/api/songs/${song.id}`, { method: 'DELETE' });
  if (!response.ok) {
    setStatus('Could not remove that song. Try again.', 'error');
    return;
  }
  setStatus(`Removed “${song.title}”.`);
  await loadSongs();
  await reloadSetlists();
}

// Swap a row for inputs so a wrong or missing artist/key/BPM can be corrected.
function startEdit(song, row) {
  const fields = {
    title: makeInput(song.title, 'row-input', { maxlength: '200', 'aria-label': 'Title' }),
    artist: makeInput(song.artist, 'row-input', { maxlength: '200', 'aria-label': 'Artist' }),
    key: makeInput(song.key, 'row-input', { maxlength: '20', 'aria-label': 'Key' }),
    bpm: makeInput(song.bpm, 'row-input', {
      inputmode: 'numeric',
      'aria-label': 'BPM',
      maxlength: '3',
      placeholder: '—',
    }),
    youtubeUrl: makeInput(song.youtubeUrl, 'row-input', {
      maxlength: '200',
      'aria-label': 'YouTube link',
      placeholder: 'YouTube link',
    }),
    signature: makeInput(song.timeSignature, 'row-input sig', {
      maxlength: '5',
      'aria-label': 'Bar length, like 3/4',
      placeholder: '4/4',
    }),
    notes: makeInput(song.notes, 'row-input', {
      maxlength: '500',
      'aria-label': 'Notes, etc',
      placeholder: 'Notes, etc',
    }),
  };

  const editRow = document.createElement('tr');
  editRow.className = 'editing';
  for (const name of ['title', 'artist', 'key', 'bpm', 'youtubeUrl']) {
    const cell = document.createElement('td');
    if (name === 'key' || name === 'bpm') cell.className = 'num';
    if (name === 'youtubeUrl') cell.className = 'yt';
    if (name === 'bpm') {
      // Tempo and bar length belong together, in the same cell.
      const pair = document.createElement('span');
      pair.className = 'bpm-pair';
      pair.append(fields.bpm, fields.signature);
      cell.append(pair);
    } else {
      cell.append(fields[name]);
    }
    editRow.append(cell);
  }

  // Keep the columns lined up while editing; the date is not editable.
  editRow.append(addedCell(song));

  // The note keeps its own column while the row is open for editing.
  const noteCell = document.createElement('td');
  noteCell.className = 'notes';
  noteCell.append(fields.notes);
  editRow.append(noteCell);

  const actions = document.createElement('td');
  actions.className = 'actions';
  const save = makeButton('Save', 'save');
  const cancel = makeButton('Cancel', 'cancel');
  actions.append(save, cancel);
  editRow.append(actions);

  const restore = () => editRow.replaceWith(row);

  cancel.addEventListener('click', restore);
  save.addEventListener('click', async () => {
    save.disabled = true;
    setStatus(`Saving “${fields.title.value.trim() || song.title}”…`, 'busy');
    try {
      const response = await fetch(`/api/songs/${song.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: fields.title.value.trim(),
          artist: fields.artist.value.trim(),
          key: fields.key.value.trim(),
          bpm: fields.bpm.value.trim(),
          timeSignature: fields.signature.value.trim(),
          youtubeUrl: fields.youtubeUrl.value.trim(),
          notes: fields.notes.value.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error ?? 'Could not save that song.', 'error');
        save.disabled = false;
        return;
      }
      setStatus(`Saved “${data.song.title}”.`, 'success');
      await loadSongs();
    } catch {
      setStatus('Could not reach the server. Try again.', 'error');
      save.disabled = false;
    }
  });

  fields.bpm.addEventListener('keydown', event => {
    if (event.key === 'Enter') save.click();
  });

  row.replaceWith(editRow);
  fields.title.focus();
  fields.title.select();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const sameDay = (a, b) => a.toDateString() === b.toDateString();

// Timestamps are stored in UTC and read back in the reader's own timezone.
function formatMoment(date) {
  const now = new Date();
  if (sameDay(date, now)) {
    return `today ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'yesterday';
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${sameYear ? '' : ` ${date.getFullYear()}`}`;
}

const parseStamp = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// The Added column: when the song entered the list, and — on a second line —
// when it was last corrected.
function addedCell(song) {
  const cell = document.createElement('td');
  cell.className = 'added-cell';

  const created = parseStamp(song.createdAt);
  const updated = parseStamp(song.updatedAt);

  const when = document.createElement('span');
  when.className = 'added';
  when.textContent = created ? formatMoment(created) : 'no date';
  cell.append(when);

  if (updated) {
    const edited = document.createElement('span');
    edited.className = 'edited';
    edited.textContent = `edited ${formatMoment(updated)}`;
    cell.append(edited);
  }

  cell.title = created
    ? `Added ${created.toLocaleString()}${updated ? ` · last edited ${updated.toLocaleString()}` : ''}`
    : 'This song has no date recorded';

  return cell;
}

// A free-form note per song — "capo 3", "starts on the drums", "new ending" —
// typed straight into the row and saved when the box is left.
function saveNotes(song, field) {
  const value = field.value.trim();
  if (value === (song.notes ?? '')) return;

  field.disabled = true;
  fetch(`/api/songs/${song.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notes: value }),
  })
    .then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not save that note.');
      // Keep the row in memory in step, so leaving it and coming back does not
      // offer to save the old note again.
      song.notes = data.song.notes;
      field.value = song.notes ?? '';
      setStatus(`Saved the note on “${song.title}”.`, 'success');
    })
    .catch(error => {
      field.value = song.notes ?? '';
      setStatus(error?.message || 'Could not reach the server. Try again.', 'error');
    })
    .finally(() => {
      field.disabled = false;
    });
}

function notesField(song) {
  const field = makeInput(song.notes, 'note-input', {
    maxlength: '500',
    placeholder: '—',
    'aria-label': `Notes, etc for ${song.title}`,
    title: 'Anything worth remembering — capo, ending, who counts it in',
  });
  field.addEventListener('change', () => saveNotes(song, field));
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      field.blur();
    }
    if (event.key === 'Escape') {
      field.value = song.notes ?? '';
      field.blur();
    }
  });
  return field;
}

// Clicking a tempo flashes the number once per beat, so the pulse carries the
// feel of the song rather than just printing the number. One at a time, and
// clicking the same tempo again stops it.
// How many pulses a bar of this song gets. The band writes the bar as a time
// signature ("3/4", "6/8"); compound metres like 6/8, 9/8 and 12/8 are counted
// in dotted beats — two, three and four — the way a band counts a shuffle in,
// not in six or nine. Anything unset is common time, so the list works before
// any signature is entered.
function beatsPerBar(song) {
  const match = String(song.timeSignature ?? '').match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
  if (!match) return 4;

  const top = Number(match[1]);
  const bottom = Number(match[2]);
  if (top < 2 || top > 12) return 4;

  // 6/8 -> 2, 9/8 -> 3, 12/8 -> 4. Simple metres keep the top number.
  if (bottom >= 8 && top % 3 === 0) return top / 3;
  return top;
}

// Every beat flashes the same, like a click track: no accent, so what you see is
// the pulse itself rather than where the bar starts. The number is at its biggest
// and brightest on the beat, then settles back, so the flash marks the tick.
const PULSE_SHAPE = [
  { transform: 'scale(1.35)', opacity: 1, offset: 0 },
  { transform: 'scale(1)', opacity: 1, offset: 1 },
];

// How many bars one press plays — the flash and the click use the same count.
const BARS = 4;

let audio = null;
let clickNodes = [];

// A browser only allows audio after a gesture, and a click on the tempo is one.
function clickContext() {
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) return null;
  audio ??= new Ctor();
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

// Ticks are scheduled ahead of time, so they keep time instead of drifting with
// the event loop. The lead is how far ahead the first tick is queued; the flash
// starts from that same queued time, so the two never wait on each other.
const CLICK_LEAD = 0.04;

function scheduleClicks(bpm, count) {
  const context = clickContext();
  if (!context) return null;

  const beat = 60 / bpm;
  const start = context.currentTime + CLICK_LEAD;

  for (let index = 0; index < count; index += 1) {
    const at = start + index * beat;
    const osc = context.createOscillator();
    const gain = context.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1200, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.22, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);

    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(at);
    osc.stop(at + 0.06);
    clickNodes.push(osc);
  }

  return start;
}

// What the speakers have actually reached, on the audio clock. Comparing the
// ticks against this rather than against the scheduler is what keeps the flash on
// the sound instead of on the queue; browsers without it use the scheduled time.
function heardTime(context) {
  const stamp = context.getOutputTimestamp?.();
  return stamp?.contextTime > 0 ? stamp.contextTime : context.currentTime;
}

function stopClicks() {
  for (const node of clickNodes) {
    try {
      node.stop();
    } catch {
      // Already finished on its own.
    }
  }
  clickNodes = [];
}

// Muted keeps the flash and drops the sound; the choice is remembered by the browser.
let muted = false;

function setMuted(next) {
  muted = next;
  stopClicks();
}

let beatFrame = null;
let beatTimer = null;
let beatButton = null;

function stopBeat() {
  stopClicks();
  if (beatFrame) cancelAnimationFrame(beatFrame);
  if (beatTimer) window.clearTimeout(beatTimer);
  beatFrame = null;
  beatTimer = null;
  if (!beatButton) return;
  beatButton.classList.remove('beating');
  beatButton.setAttribute('aria-pressed', 'false');
  beatButton = null;
}

function toggleBeat(button, song) {
  if (beatButton === button) {
    stopBeat();
    return;
  }
  stopBeat();
  if (!song.bpm) return;

  const beats = beatsPerBar(song);
  const beat = 60 / song.bpm;
  const total = beat * beats * BARS;

  beatButton = button;
  button.classList.add('beating');
  button.setAttribute('aria-pressed', 'true');

  // The tick is the same count-in a drummer would hear, unless it is muted.
  const context = muted ? null : clickContext();
  const start = context ? scheduleClicks(song.bpm, beats * BARS) : null;

  // A moving pulse is not for everyone; a still ring says the same thing.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    window.setTimeout(stopBeat, total * 1000 + CLICK_LEAD * 1000);
    return;
  }

  // Four bars: long enough to settle into the feel before counting the band in.
  // The flash watches the same clock the ticks were queued on and pulses when the
  // speakers reach each beat, so it cannot run ahead of the click or trail it,
  // whatever delay the device's audio path adds.
  const origin = start ?? performance.now() / 1000 + CLICK_LEAD;
  let shown = null;

  const frame = () => {
    const heard = context ? heardTime(context) : performance.now() / 1000;
    const index = Math.floor((heard - origin) / beat);
    if (index !== shown) {
      shown = index;
      if (index >= beats * BARS) {
        stopBeat();
        return;
      }
      if (index >= 0) {
        button.animate(PULSE_SHAPE, { duration: Math.min(beat * 450, 400), easing: 'ease-out' });
      }
    }
    beatFrame = requestAnimationFrame(frame);
  };
  beatFrame = requestAnimationFrame(frame);

  // If the audio clock never starts — no sound allowed, or a stalled context —
  // stop anyway rather than leaving the number red for good.
  beatTimer = window.setTimeout(stopBeat, (total + 2) * 1000);
}

function bpmButton(song) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bpm-beat';
  const beats = beatsPerBar(song);
  button.textContent = String(song.bpm);
  button.title = `Click ${beats} to the bar at ${song.bpm} BPM`;
  button.setAttribute('aria-label', `Click ${beats} to the bar at ${song.bpm} BPM`);
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => toggleBeat(button, song));
  return button;
}

function songRow(song, used = new Set()) {
  const row = document.createElement('tr');
  row.dataset.id = song.id;
  // Tint a row whose song is already in the setlist being built, so a song the
  // band has used is obvious in the big list without checking the setlist.
  if (used.has(song.id)) {
    row.classList.add('used');
    if (activeSetlist) row.title = `Already in “${activeSetlist.name}”`;
  }

  const title = document.createElement('td');
  title.className = 'title';
  const titleText = document.createElement('span');
  titleText.className = 'song-title';
  titleText.textContent = song.title;
  title.append(titleText);

  const artist = document.createElement('td');
  artist.textContent = song.artist || '—';

  const key = document.createElement('td');
  key.className = 'num key';
  key.textContent = song.key ?? '—';

  const bpm = document.createElement('td');
  bpm.className = 'num bpm';
  if (song.bpm) {
    bpm.append(bpmButton(song));
    // Only worth showing when the song is not in common time.
    if (song.timeSignature) {
      const signature = document.createElement('span');
      signature.className = 'signature';
      signature.textContent = song.timeSignature;
      signature.title = `${beatsPerBar(song)} to the bar`;
      bpm.append(signature);
    }
  } else {
    bpm.textContent = '—';
  }

  const youtube = document.createElement('td');
  youtube.className = 'yt';
  if (song.youtubeUrl) {
    youtube.append(youTubeLink(song.youtubeUrl, song.title));
  } else {
    youtube.classList.add('none');
    youtube.textContent = '—';
  }

  const added = addedCell(song);

  const notes = document.createElement('td');
  notes.className = 'notes';
  notes.append(notesField(song));

  const actions = document.createElement('td');
  actions.className = 'actions';
  const add = makeButton('Add', 'add', `Add ${song.title} to the setlist`);
  const edit = makeButton('Edit', 'edit', `Edit ${song.title}`);
  const remove = makeButton('Remove', 'remove', `Remove ${song.title}`);

  add.disabled = !activeSetlist;
  add.title = activeSetlist ? `Add to ${activeSetlist.name}` : 'Create a setlist first';
  add.addEventListener('click', async () => {
    add.disabled = true;
    await addSongToActiveSetlist(song);
    add.disabled = !activeSetlist;
  });
  edit.addEventListener('click', () => startEdit(song, row));
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    await removeSong(song);
  });

  actions.append(add, edit, remove);

  row.append(title, artist, key, bpm, youtube, added, notes, actions);
  return row;
}

const compareText = (a, b) =>
  String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });

const SORT = {
  title: (a, b) => compareText(a.title, b.title),
  artist: (a, b) => compareText(a.artist, b.artist),
  key: (a, b) => compareText(a.key, b.key),
  bpm: (a, b) => Number(a.bpm) - Number(b.bpm),
  added: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
};

// Songs with no key or BPM stay at the bottom whichever way the column sorts.
const isMissingValue = (song, column) =>
  (column === 'key' && !song.key) ||
  (column === 'bpm' && !song.bpm) ||
  (column === 'added' && !song.createdAt);

function sortedSongs() {
  const { column, direction } = sortState;
  if (!column) return songs;

  const sign = direction === 'desc' ? -1 : 1;
  const known = songs.filter(song => !isMissingValue(song, column));
  const unknown = songs.filter(song => isMissingValue(song, column));
  return [...known.sort((a, b) => SORT[column](a, b) * sign), ...unknown];
}

function syncSortIndicators() {
  for (const button of sortButtons) {
    const active = sortState.column === button.dataset.sort;
    button.dataset.dir = active ? sortState.direction : '';
    button
      .closest('th')
      .setAttribute(
        'aria-sort',
        active ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none',
      );
  }
}

const keyNote = key => String(key ?? '').match(/^[A-G][#b]?/)?.[0] ?? null;

// Compare the note exactly, so "G" finds G and G minor but not G#.
const matchesKey = (song, query) => {
  const note = keyNote(song.key);
  if (!note) return false;

  const cleaned = query.replace(/\s+/g, '').toLowerCase();
  const wantedNote = cleaned.match(/^[a-g][#b]?/)?.[0];
  if (!wantedNote) return false;

  const wantedMode = /minor|min$/.test(cleaned) ? 'minor' : /major|maj/.test(cleaned) ? 'major' : null;
  const songMode = /minor/i.test(song.key) ? 'minor' : 'major';

  if (note.toUpperCase() !== wantedNote.toUpperCase()) return false;
  return !wantedMode || wantedMode === songMode;
};

// A single letter, or a letter with a mode, is read as a key — otherwise "g"
// would return every title with a g in it.
const KEY_SHAPE = /^[a-g][#b]?$/i;
const KEY_WITH_MODE = /^[a-g][#b]?\s*(major|minor|maj|min)$/i;

// One box covers everything: title, artist, key and tempo. "key:" and "bpm:"
// narrow it to a single column when a plain term would be ambiguous.
const matchesFilter = song => {
  const raw = searchText.trim().toLowerCase();
  if (!raw) return true;

  const keyOnly = raw.match(/^key:\s*(.+)$/);
  if (keyOnly) return matchesKey(song, keyOnly[1]);

  const bpmOnly = raw.match(/^bpm:\s*(\d+)$/);
  if (bpmOnly) return song.bpm === Number(bpmOnly[1]);

  if (KEY_SHAPE.test(raw) || KEY_WITH_MODE.test(raw)) return matchesKey(song, raw);

  if (song.title.toLowerCase().includes(raw)) return true;
  if (song.artist.toLowerCase().includes(raw)) return true;
  if (song.key && song.key.toLowerCase().includes(raw)) return true;
  if (song.notes && song.notes.toLowerCase().includes(raw)) return true;

  // A bare number is a tempo, matched exactly so "90" does not also return 190.
  const tempo = raw.replace(/\s*bpm$/, '').trim();
  return /^\d+$/.test(tempo) && song.bpm === Number(tempo);
};

function renderSongs() {
  // A re-render replaces the elements the pulse was running on.
  stopBeat();
  rows.replaceChildren();
  const visible = sortedSongs().filter(matchesFilter);
  const needle = searchText.trim();

  empty.hidden = visible.length > 0;
  if (!visible.length) {
    empty.textContent = songs.length
      ? `No songs match “${needle}”.`
      : 'No songs yet. Add the first one above.';
  }

  summary.textContent = !songs.length
    ? ''
    : needle
      ? `${visible.length} of ${songs.length} songs match`
      : `${songs.length} ${songs.length === 1 ? 'song' : 'songs'} in the list`;

  const usedIds = new Set((activeSetlist?.songs ?? []).map(entry => entry.song.id));
  for (const song of visible) rows.append(songRow(song, usedIds));
  syncSortIndicators();
}

async function loadSongs() {
  const response = await fetch('/api/songs');
  const data = await response.json();
  songs = data.songs ?? [];
  renderSongs();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;

  submit.disabled = true;
  input.disabled = true;
  setStatus(`Looking up “${title}” online…`, 'busy');

  try {
    const response = await fetch('/api/songs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const data = await response.json();

    if (!response.ok) {
      setStatus(data.error ?? 'Lookup failed.', 'error');
      // The title stays in the box, so it can be saved exactly as typed.
      if (response.status === 404) offerManualAdd(title);
      return;
    }

    const { song } = data;
    const details = [song.artist];
    details.push(song.key ? `key ${song.key}` : 'no key found');
    details.push(song.bpm ? `${song.bpm} BPM` : 'no BPM found');
    setStatus(`Added “${song.title}” — ${details.join(', ')}.`, 'success');
    input.value = '';
    await loadSongs();
  } catch {
    setStatus('Could not reach the server. Try again.', 'error');
  } finally {
    submit.disabled = false;
    input.disabled = false;
    input.focus();
  }
});

// The lookup found nothing, so offer to save the typed title as it stands,
// then open the new row for the artist, key and tempo to be filled in.
function offerManualAdd(title) {
  const button = makeButton('Add it by hand', 'secondary', `Add “${title}” without looking it up`);
  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus(`Adding “${title}” by hand…`, 'busy');

    try {
      const response = await fetch('/api/songs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, manual: true }),
      });
      const data = await response.json();

      if (!response.ok) {
        setStatus(data.error ?? 'Could not add that song.', 'error');
        return;
      }

      input.value = '';
      await loadSongs();
      setStatus(`Added “${data.song.title}” by hand — fill in the artist, key and tempo, then Save.`, 'success');
      rows.querySelector(`tr[data-id="${data.song.id}"] button.edit`)?.click();
    } catch {
      setStatus('Could not reach the server. Try again.', 'error');
    }
  });

  status.append(' ', button);
}

// --- Batch add -----------------------------------------------------------

batchForm.addEventListener('submit', async event => {
  event.preventDefault();
  const titles = batchInput.value
    .split(/[\r\n,]+/)
    .map(title => title.trim())
    .filter(Boolean);

  if (titles.length === 0) {
    setBatchStatus('Paste at least one song title.', 'error');
    return;
  }
  if (titles.length > MAX_BATCH) {
    setBatchStatus(`That is ${titles.length} titles; add at most ${MAX_BATCH} at a time.`, 'error');
    return;
  }

  batchSubmit.disabled = true;
  const failed = [];
  let added = 0;
  let duplicates = 0;

  // Sequential on purpose: the music services are rate limited, and this keeps
  // the progress line honest about which title is being looked up.
  for (const [index, title] of titles.entries()) {
    setBatchStatus(`Looking up ${index + 1} of ${titles.length}: ${title}…`, 'busy');
    try {
      const response = await fetch('/api/songs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const data = await response.json();
      if (response.status === 201) added += 1;
      else if (response.status === 409) duplicates += 1;
      else failed.push(`${title} — ${data.error ?? 'lookup failed'}`);
    } catch {
      failed.push(`${title} — could not reach the server`);
    }
  }

  const parts = [`Added ${added} of ${titles.length}`];
  if (duplicates > 0) parts.push(`${duplicates} already in the list`);
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  setBatchStatus(`${parts.join(', ')}.`, failed.length > 0 ? 'error' : 'success');

  // Leave anything that failed in the box so it can be retried or corrected.
  batchInput.value = failed.map(entry => entry.split(' — ')[0]).join('\n');
  batchSubmit.disabled = false;
  await loadSongs();
});

// --- Setlists ------------------------------------------------------------

function renderSetlistOptions() {
  setlistSelect.replaceChildren();
  if (setlistsEmpty()) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No setlists yet';
    setlistSelect.append(option);
    setlistSelect.disabled = true;
    deleteSetlistButton.disabled = true;
    return;
  }
  setlistSelect.disabled = false;
  deleteSetlistButton.disabled = false;
  for (const setlist of setlists) {
    const option = document.createElement('option');
    option.value = String(setlist.id);
    option.textContent = `${setlist.name} (${setlist.songCount})`;
    setlistSelect.append(option);
  }
}

// The export links only make sense while a setlist is selected.
function renderExport() {
  setlistExport.hidden = !activeSetlist;
  if (!activeSetlist) return;
  const base = `/api/setlists/${activeSetlist.id}/export`;
  exportTxt.href = `${base}?format=txt`;
  exportCsv.href = `${base}?format=csv`;
  exportPrint.href = `${base}?format=print`;
}

function renderSetlist() {
  // A re-render replaces the rows the pulse was running on.
  stopBeat();
  renderExport();
  setlistSongs.replaceChildren();
  const entries = activeSetlist?.songs ?? [];
  setlistSongs.hidden = entries.length === 0;
  setlistEmpty.hidden = entries.length > 0;
  if (activeSetlist) {
    setlistEmpty.textContent = `“${activeSetlist.name}” is empty. Use the Add button on a song above.`;
  }

  entries.forEach((entry, index) => {
    const item = document.createElement('li');

    const position = document.createElement('span');
    position.className = 'position';
    position.textContent = String(index + 1);

    const title = document.createElement('span');
    title.className = 'setlist-title';
    title.textContent = entry.song.title;

    const artist = document.createElement('span');
    artist.className = 'setlist-artist';
    artist.textContent = entry.song.artist;

    const meta = document.createElement('span');
    meta.className = 'setlist-meta';
    meta.append(...describeParts(entry.song));

    // The song's note, on its own line under the row, so anything the band
    // wrote down reads while the set is being played rather than only in the
    // big list above.
    const note = document.createElement('span');
    note.className = 'setlist-note';
    note.textContent = entry.song.notes ?? '';

    const actions = document.createElement('span');
    actions.className = 'setlist-actions';
    if (entry.song.youtubeUrl) actions.append(youTubeLink(entry.song.youtubeUrl, entry.song.title));
    const up = makeButton('↑', 'move', `Move ${entry.song.title} up`);
    const down = makeButton('↓', 'move', `Move ${entry.song.title} down`);
    const remove = makeButton('✕', 'remove', `Remove ${entry.song.title} from the setlist`);
    up.disabled = index === 0;
    down.disabled = index === entries.length - 1;
    up.addEventListener('click', () => moveEntry(index, -1));
    down.addEventListener('click', () => moveEntry(index, 1));
    remove.addEventListener('click', () => removeEntry(entry));
    actions.append(up, down, remove);

    item.append(position, title, artist, meta, actions);
    if (entry.song.notes) item.append(note);
    setlistSongs.append(item);
  });
}

let setlists = [];

const setlistsEmpty = () => setlists.length === 0;

async function selectSetlist(id) {
  const response = await fetch(`/api/setlists/${id}`);
  if (!response.ok) {
    activeSetlist = null;
    renderSetlist();
    return;
  }
  activeSetlist = (await response.json()).setlist;
  setlistSelect.value = String(activeSetlist.id);
  renderSetlist();
  renderSongs();
}

async function reloadSetlists({ selectFirst = false } = {}) {
  const response = await fetch('/api/setlists');
  const data = await response.json();
  setlists = data.setlists ?? [];
  renderSetlistOptions();

  if (setlists.length === 0) {
    activeSetlist = null;
    renderSetlist();
    renderSongs();
    return;
  }

  const currentId = activeSetlist?.id;
  if (selectFirst || !currentId || !setlists.some(setlist => setlist.id === currentId)) {
    await selectSetlist(setlists[0].id);
    return;
  }
  setlistSelect.value = String(currentId);
  renderSetlist();
  renderSongs();
}

async function addSongToActiveSetlist(song) {
  if (!activeSetlist) {
    setSetlistStatus('Create a setlist first.', 'error');
    return;
  }
  const response = await fetch(`/api/setlists/${activeSetlist.id}/songs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songId: song.id }),
  });
  const data = await response.json();
  if (!response.ok) {
    setSetlistStatus(data.error ?? 'Could not add that song.', 'error');
    return;
  }
  activeSetlist = data.setlist;
  setSetlistStatus(`Added “${song.title}” to ${activeSetlist.name}.`, 'success');
  await reloadSetlists();
}

async function removeEntry(entry) {
  const response = await fetch(`/api/setlists/${activeSetlist.id}/songs/${entry.entryId}`, {
    method: 'DELETE',
  });
  const data = await response.json();
  if (!response.ok) {
    setSetlistStatus(data.error ?? 'Could not remove that song.', 'error');
    return;
  }
  activeSetlist = data.setlist;
  setSetlistStatus(`Removed “${entry.song.title}” from ${activeSetlist.name}.`);
  await reloadSetlists();
}

async function saveOrder(entryIds) {
  const response = await fetch(`/api/setlists/${activeSetlist.id}/order`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entryIds }),
  });
  const data = await response.json();
  if (!response.ok) {
    setSetlistStatus(data.error ?? 'Could not save the new order.', 'error');
    return;
  }
  activeSetlist = data.setlist;
  renderSetlist();
}

function moveEntry(index, direction) {
  const entries = activeSetlist?.songs ?? [];
  const target = index + direction;
  if (target < 0 || target >= entries.length) return;
  const reordered = entries.slice();
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  saveOrder(reordered.map(entry => entry.entryId));
}

setlistSelect.addEventListener('change', () => {
  const id = Number(setlistSelect.value);
  if (Number.isInteger(id) && id > 0) selectSetlist(id);
});

newSetlistForm.addEventListener('submit', async event => {
  event.preventDefault();
  const name = newSetlistName.value.trim();
  if (!name) return;

  try {
    const response = await fetch('/api/setlists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await response.json();
    if (!response.ok) {
      setSetlistStatus(data.error ?? 'Could not create that setlist.', 'error');
      return;
    }
    activeSetlist = data.setlist;
    newSetlistName.value = '';
    setSetlistStatus(`Created “${activeSetlist.name}”.`, 'success');
    await reloadSetlists();
  } catch {
    setSetlistStatus('Could not reach the server. Try again.', 'error');
  }
});

// Older rows and lookups that missed have no link yet; this fills them in.
findYouTubeButton.addEventListener('click', async () => {
  const missing = songs.filter(song => !song.youtubeUrl);
  if (missing.length === 0) {
    setStatus('Every song already has a YouTube link.');
    return;
  }

  findYouTubeButton.disabled = true;
  let found = 0;

  for (const [index, song] of missing.entries()) {
    setStatus(`Looking for a YouTube video ${index + 1} of ${missing.length}: ${song.title}…`, 'busy');
    try {
      const response = await fetch(`/api/songs/${song.id}/youtube`, { method: 'POST' });
      if (response.ok) found += 1;
    } catch {
      // Keep going; anything skipped is retried on the next run.
    }
  }

  findYouTubeButton.disabled = false;
  setStatus(
    `Found YouTube links for ${found} of ${missing.length} ${missing.length === 1 ? 'song' : 'songs'}.`,
    found > 0 ? 'success' : 'error',
  );
  await loadSongs();
});

// --- Mute ----------------------------------------------------------------

const MUTE_KEY = 'songbook.muted';

function readMuted() {
  try {
    return window.localStorage.getItem(MUTE_KEY) === 'true';
  } catch {
    return false; // Private modes can refuse storage; the default is sound on.
  }
}

function renderMute() {
  muteButton.textContent = muted ? 'Unmute click' : 'Mute click';
  muteButton.setAttribute('aria-pressed', muted ? 'true' : 'false');
  muteButton.title = muted ? 'The tempo flash is silent' : 'The tempo flash also clicks';
}

muteButton.addEventListener('click', () => {
  setMuted(!muted);
  try {
    window.localStorage.setItem(MUTE_KEY, String(muted));
  } catch {
    // Nothing to remember this session.
  }
  renderMute();
});

setMuted(readMuted());
renderMute();

deleteSetlistButton.addEventListener('click', async () => {
  if (!activeSetlist) return;
  const name = activeSetlist.name;
  if (!window.confirm(`Delete the setlist “${name}”? The songs stay in your library.`)) return;

  const response = await fetch(`/api/setlists/${activeSetlist.id}`, { method: 'DELETE' });
  if (!response.ok) {
    setSetlistStatus('Could not delete that setlist.', 'error');
    return;
  }
  activeSetlist = null;
  setSetlistStatus(`Deleted “${name}”.`);
  await reloadSetlists({ selectFirst: true });
});

// Searching is local too: nothing is fetched or written while typing.
searchInput.addEventListener('input', () => {
  if (rows.querySelector('tr.editing')) {
    searchInput.value = searchText;
    setStatus('Save or cancel the row you are editing before searching.', 'error');
    return;
  }
  searchText = searchInput.value;
  renderSongs();
});

// Escape clears the box, for keyboards without a clear button.
searchInput.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !searchInput.value) return;
  searchInput.value = '';
  searchText = '';
  renderSongs();
});

// Click a heading to sort, again to reverse, a third time to go back to newest
// first. A row being edited blocks the re-render so unsaved values are not lost.
for (const button of sortButtons) {
  button.addEventListener('click', () => {
    if (rows.querySelector('tr.editing')) {
      setStatus('Save or cancel the row you are editing before sorting.', 'error');
      return;
    }

    const column = button.dataset.sort;
    if (sortState.column !== column) {
      sortState.column = column;
      sortState.direction = 'asc';
    } else if (sortState.direction === 'asc') {
      sortState.direction = 'desc';
    } else {
      sortState.column = null;
      sortState.direction = 'asc';
    }
    renderSongs();
  });
}

(async () => {
  try {
    await loadSongs();
  } catch {
    setStatus('Could not load the song list.', 'error');
  }
  try {
    await reloadSetlists({ selectFirst: true });
  } catch {
    setSetlistStatus('Could not load setlists.', 'error');
  }
})();
