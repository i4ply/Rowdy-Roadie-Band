// Setlist exports: plain text to paste and share, CSV for a spreadsheet, and a
// printable page for a music stand.

const describe = song =>
  [song.key ? `key ${song.key}` : null, song.bpm ? `${song.bpm} BPM` : null]
    .filter(Boolean)
    .join(' · ');

const today = () => new Date().toISOString().slice(0, 10);

const countLabel = total => `${total} ${total === 1 ? 'song' : 'songs'}`;

// A whole-library backup: every stored field plus the setlists, in the shape
// POST /api/import accepts, so a deleted row, a bad edit or a wiped setlist can
// all come back from one file.
export function libraryJson(songs, setlists = [], exportedAt = new Date().toISOString()) {
  return `${JSON.stringify(
    {
      format: 'rowdy-roadie-songbook-library',
      version: 2,
      exportedAt,
      count: songs.length,
      setlistCount: setlists.length,
      songs: songs.map(song => ({
        title: song.title,
        artist: song.artist,
        album: song.album ?? null,
        key: song.key ?? null,
        bpm: song.bpm ?? null,
        timeSignature: song.timeSignature ?? null,
        isrc: song.isrc ?? null,
        spotifyUrl: song.spotifyUrl ?? null,
        youtubeUrl: song.youtubeUrl ?? null,
        createdAt: song.createdAt ?? null,
      })),
      // Setlist songs are named rather than numbered: ids change on a restore,
      // so an ISRC (or the title and artist) is what puts them back in place.
      setlists: setlists.map(setlist => ({
        name: setlist.name,
        songs: (setlist.songs ?? []).map(entry => {
          const song = entry.song ?? entry;
          return {
            title: song.title,
            artist: song.artist,
            isrc: song.isrc ?? null,
          };
        }),
      })),
    },
    null,
    2,
  )}\n`;
}

export function libraryFilename() {
  return `songbook-library-${today()}.json`;
}

export function setlistText(setlist) {
  const songs = setlist.songs ?? [];
  const width = String(songs.length).length;
  const lines = [setlist.name, `${countLabel(songs.length)} · exported ${today()}`, ''];

  if (songs.length === 0) {
    lines.push('This setlist is empty.');
    return `${lines.join('\n')}\n`;
  }

  songs.forEach((entry, index) => {
    const { song } = entry;
    lines.push(`${String(index + 1).padStart(width)}. ${song.title}`);
    lines.push(`   ${[song.artist, describe(song)].filter(Boolean).join(' · ')}`);
  });

  return `${lines.join('\n')}\n`;
}

const csvField = value => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function setlistCsv(setlist) {
  const rows = [['Position', 'Title', 'Artist', 'Key', 'BPM']];
  (setlist.songs ?? []).forEach((entry, index) => {
    rows.push([
      index + 1,
      entry.song.title,
      entry.song.artist,
      entry.song.key ?? '',
      entry.song.bpm ?? '',
    ]);
  });
  // A BOM so Excel reads the file as UTF-8, and CRLF because that is what it
  // expects from a .csv.
  return `\uFEFF${rows.map(row => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}

// A safe download name: "Friday Night — 2nd set" becomes "friday-night-2nd-set.txt".
export function exportFilename(name, extension) {
  const base = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'setlist'}.${extension}`;
}

const escapeHtml = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    character =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );

export function setlistPrintPage(setlist) {
  const songs = setlist.songs ?? [];
  const rows = songs
    .map(
      (entry, index) => `
      <li>
        <span class="position">${index + 1}</span>
        <span class="title">${escapeHtml(entry.song.title)}</span>
        <span class="key">${escapeHtml(entry.song.key ?? '—')}</span>
        <span class="tempo">${entry.song.bpm ?? ''}</span>
      </li>`,
    )
    .join('');

  const body =
    songs.length === 0
      ? '<p class="empty">This setlist is empty.</p>'
      : `<ol>${rows}\n    </ol>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(setlist.name)}</title>
    <style>
      :root { color-scheme: light; --reading-size: 17px; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 2.25rem 1.25rem 3.5rem;
        background: #f7f6f3;
        color: #16181d;
        font: var(--reading-size)/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      main { max-width: 42rem; margin: 0 auto; }
      .controls { display: flex; gap: 0.6rem; margin-bottom: 1.75rem; }
      .controls button,
      .controls a {
        padding: 0.5rem 0.9rem;
        border: 1px solid #16181d;
        border-radius: 0.45rem;
        background: #16181d;
        color: #f7f6f3;
        font: inherit;
        font-size: 0.9rem;
        font-weight: 500;
        text-decoration: none;
        cursor: pointer;
      }
      .controls a { background: transparent; color: #16181d; }
      .size-buttons { margin-left: auto; display: flex; gap: 0.35rem; }
      .size-buttons button {
        min-width: 2.5rem;
        background: transparent;
        color: #16181d;
        font-weight: 600;
      }
      .size-buttons button:disabled { opacity: 0.4; cursor: default; }
      header {
        border-bottom: 2px solid #16181d;
        padding-bottom: 0.7rem;
        margin-bottom: 0.6rem;
      }
      h1 { margin: 0 0 0.25rem; font-size: 1.6rem; letter-spacing: -0.01em; }
      .count { margin: 0; color: #5c626e; font-size: 0.9rem; }
      ol { list-style: none; margin: 0; padding: 0; }
      li {
        display: grid;
        grid-template-columns: 1.75rem minmax(0, 1fr) 3.5rem 3rem;
        gap: 0.6rem;
        align-items: baseline;
        padding: 0.55rem 0;
        border-bottom: 1px solid #dcd9d2;
      }
      li:last-child { border-bottom: 0; }
      .position { color: #5c626e; font-variant-numeric: tabular-nums; }
      .title { font-weight: 600; }
      .key { font-weight: 600; text-align: right; }
      .tempo {
        color: #5c626e;
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .empty { color: #5c626e; }
      @media (max-width: 34rem) {
        li { grid-template-columns: 1.5rem minmax(0, 1fr) 3rem 2.5rem; font-size: 0.95rem; }
      }
      @page { margin: 12mm 13mm; }
      @media print {
        body {
          padding: 0;
          background: #fff;
          font-size: calc(var(--reading-size) * 1.1);
        }
        .controls { display: none; }
        li { padding: 0.5rem 0; break-inside: avoid; }
        header { margin-bottom: 0.5rem; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="controls">
        <button type="button" onclick="window.print()">Print</button>
        <a href="/">Back to the song list</a>
        <span class="size-buttons">
          <button type="button" data-step="down" aria-label="Smaller text">A−</button>
          <button type="button" data-step="up" aria-label="Bigger text">A+</button>
        </span>
      </div>
      <header>
        <h1>${escapeHtml(setlist.name)}</h1>
        <p class="count">${countLabel(songs.length)} · exported ${today()}</p>
      </header>
      ${body}
    </main>
    <script>
      (function () {
        var sizes = [14, 15, 16, 17, 19, 21, 24, 27];
        var key = 'songbook.printSize';
        var current = 3;
        var root = document.documentElement;
        function remember(size) {
          try {
            window.localStorage.setItem(key, String(size));
          } catch (error) {
            // Storage can be refused; the choice then lasts for this page only.
          }
        }
        try {
          var saved = sizes.indexOf(Number(window.localStorage.getItem(key)));
          if (saved !== -1) current = saved;
        } catch (error) {
          current = 3;
        }
        function apply() {
          root.style.setProperty('--reading-size', sizes[current] + 'px');
          remember(sizes[current]);
          document.querySelectorAll('[data-step]').forEach(function (button) {
            button.disabled =
              button.dataset.step === 'down' ? current === 0 : current === sizes.length - 1;
          });
        }
        document.addEventListener('click', function (event) {
          var button = event.target.closest('[data-step]');
          if (!button) return;
          current += button.dataset.step === 'up' ? 1 : -1;
          current = Math.max(0, Math.min(sizes.length - 1, current));
          apply();
        });
        apply();
      })();
    </script>
  </body>
</html>
`;
}
