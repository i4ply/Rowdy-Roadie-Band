# Song list database

A small song list that fills in the **artist**, **musical key** and **BPM** itself
when you add a song title.

![status](https://img.shields.io/badge/dependencies-none-brightgreen)

## The live site

The band uses the hosted copy:
<https://site-53c88bd5582041d58d82b21c1ce4b981.freebuff.page>

That deployment lives in `../songbook-worker/` (Cloudflare Worker + D1) and is
built from `../songbook-worker/public/`. The two copies are independent
databases: adding a song here does not change the hosted list, or the reverse.

To change what the band sees, edit the three files in
`../songbook-worker/public/` (copy them over from `public/` if you changed the
front end here) and redeploy using `../songbook-worker/deploy.json`.
`../songbook-worker/README.md` covers the manifest, the D1 binding and the local
`wrangler dev` workflow.

## Run it

```bash
cd songbook
node server.js
# open http://localhost:3000
```

Requires Node.js 22.5+ (it uses the built-in `node:sqlite`). There is nothing to
install — no `npm install`, no build step, no API keys.

Songs are stored in `data/songs.db`, a SQLite file created on first run. Set
`SONGBOOK_DB` to store it elsewhere, `PORT` to change the port.

## How the lookup works

Two free, keyless services are combined, because neither is enough on its own:

| Step | Service | Purpose |
| --- | --- | --- |
| 1 | [iTunes Search API](https://performance-partners.apple.com/search-api) | Decides *which recording* you mean — Apple's relevance ranking is a good guide to the canonical version, and supplies the artist name. |
| 2 | [ReccoBeats API](https://reccobeats.com/docs/documentation/introduction) | Returns audio features for that recording: `key` + `mode` → musical key, `tempo` → BPM. |

Spotify IDs are used to fetch the features; `key` is a pitch class 0–11 and
`mode` is 1 for major and 0 for minor, so `key: 8, mode: 1` becomes `G#`.

ReccoBeats' own search ranks covers and karaoke versions first and its popularity
figures are stale for older catalogues, so it is only ever used *after* Apple has
named the artist. Its database does not cover every recording: in that case the
song is still added with the correct artist and `—` for key and BPM rather than
storing a cover's tempo.

### Setlists

Create a setlist, select it, then use the **Add** button on any song to build it
up. Songs keep their order: use ↑ / ↓ to move an entry and ✕ to take it out.
Deleting a setlist leaves your songs untouched; deleting a song removes it from
any setlist that used it. A song can only appear once per setlist.

### Printing and sharing a setlist

The **Download .txt** button saves the setlist as a numbered text list (title,
artist, key, BPM) — the easiest thing to paste into a message. **Download .csv**
opens in a spreadsheet. **Print or save as PDF** opens a clean printed layout for a
music stand — number, title, key and tempo, without the artist — in a new tab with
a Print button, plus **A−** / **A+** buttons that resize the type (the size you pick
is the size that prints, and is remembered for next time); choose “Save as PDF” in
the print dialog to keep a copy.
The page prints with narrow margins to give the list more room. The file name comes
from the setlist name.

### Batch adding

Open **Batch add** and paste a list — one title per line, or separated by commas.
Titles are looked up one at a time (the services are rate limited) with a progress
line, and anything that failed is left in the box so it can be corrected and
retried. Up to 200 titles per batch.

### Fixing a row

Every row has an **Edit** button: title, artist, key and BPM become editable and
save straight to the database. Useful when the lookup missed the recording (it can
only leave `—` for a key it does not have) or picked the wrong version. BPM must be
a whole number between 1 and 400; an empty key or BPM is stored as unknown.

### When a song was added or edited

The **Added** column shows when a song entered the list, and once the row has been
corrected a second line reads `edited <date>`. Hovering the cell gives the exact
date and time. Only a real edit (title, artist, key, BPM or YouTube link) moves the
edited stamp, so `created_at` never changes underneath a row. The list is
newest-first by default, and the column sorts like the rest: one click for
oldest-first, a second for newest, a third back to the default order.

### Feeling the tempoClick a BPM number and it flashes once per beat at that tempo — four bars, then it
stops, so you can see the feel before counting the band in. Every beat flashes
the same, like a click track — no accent — so what you see is the pulse itself. While it
runs the number is red, so a glance across the list finds the tempo you are
counting. It also clicks: a short tick on every beat at the same tempo, so the list works
as a click track without leaving the page. **Mute click** in the toolbar silences
the sound and leaves the flash running; the choice is remembered in the browser.
The same button sits in every setlist row, next to the key, so the count-in can
start from the running order. Click it again to stop early, or click
another tempo to switch, and the sound stops with the flash either way. With
"reduce motion" turned on in the operating system it rings once in red instead of
pulsing. Songs with no BPM stay plain text and are not clickable.

A bar is four beats unless the song says otherwise. Use **Edit** on a row and type
the bar length in the small box beside BPM — `3/4` for a waltz, `6/8` for a
shuffle. The signature then shows beside the tempo in the list, and blank means
common time.

How many pulses a bar gets depends on the metre. Simple metres use the top number:
`4/4` flashes four, `3/4` three, `2/4` two. Compound metres are counted in dotted
beats, the way a band counts them in: `6/8` flashes two, `9/8` three, `12/8` four.
So the BPM you enter is the pulse you see — a shuffle written 6/8 and played at 120
flashes twice a bar, not six times.

### Searching

The search box filters the list as you type, case-insensitive, across title, artist,
key and BPM. Two kinds of short query mean something more specific than text:

- **A key.** A single letter is read as a key, compared on the note alone, so `G`
  returns the songs in G and G minor but not G# — and not every title containing a
  g. `G minor` narrows it to that mode. To search text that happens to be one
  letter, type more of the word.
- **A tempo.** A bare number is matched exactly, so `90` finds 90 BPM but not 190
  (or, say, a title with 1990 in it).

`key:c#` and `bpm:90` force a single column for anything the rules above miss.
Escape clears the box.

### YouTube links

Every song can carry a YouTube link. When a song is added the app searches YouTube
and saves the first result, skipping karaoke and cover uploads — a wrong link is
worse than none, so anything doubtful is left blank. The ▶ button in the table and
in a setlist opens it. **Find missing YouTube links** fills in the rest one at a
time; it is safe to run again, and any row can be given a link by hand with
**Edit**.

YouTube has no free API, so this reads its public results page. That can be
throttled from a busy address, in which case the song is added without a link and
a later run usually succeeds.

### Ambiguous titles

Add `- Artist` to the title to disambiguate:

```
Creep - Radiohead
Hello - Adele
```

Without it the most likely canonical version is used. The artist that was matched
is shown in the confirmation message, so a wrong match is easy to spot — remove
the row and re-add it with the artist.

## API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/songs` | List every song. |
| `POST` | `/api/songs` | `{"title": "Hotel California"}` — looks the song up, stores it, returns `201` with the row. |
| `PATCH` | `/api/songs/:id` | Correct a row: any of `title`, `artist`, `key`, `bpm`, `youtubeUrl` (send `""` or `null` to clear key/BPM/link). Returns the updated row. |
| `POST` | `/api/songs/:id/youtube` | Look the song up on YouTube and save the link; `404` when no video is found. |
| `DELETE` | `/api/songs/:id` | Remove a song, `204` on success. |
| `GET` | `/api/setlists` | List setlists with song counts. |
| `POST` | `/api/setlists` | `{"name": "Friday"}` — create a setlist. |
| `GET` | `/api/setlists/:id` | One setlist with its songs in order. |
| `DELETE` | `/api/setlists/:id` | Delete a setlist (songs stay), `204` on success. |
| `POST` | `/api/setlists/:id/songs` | `{"songId": 3}` — append a song. `409` if already in that setlist. |
| `DELETE` | `/api/setlists/:id/songs/:entryId` | Remove one entry, returns the updated setlist. |
| `PATCH` | `/api/setlists/:id/order` | `{"entryIds": [4, 2, 7]}` — save a new order. |
| `GET` | `/api/setlists/:id/export?format=txt` | Download the setlist as a numbered text list. |
| `GET` | `/api/setlists/:id/export?format=csv` | Download it as CSV (`Position, Title, Artist, Key, BPM`). |
| `GET` | `/api/setlists/:id/export?format=print` | Printable HTML page; open it and print, or save as PDF. |

`POST` returns `409` when the same recording is already in the list (matched by
ISRC, or by title and artist when the recording has no ISRC), `404` when nothing
could be identified, and `502` when the music services cannot be reached.

```bash
curl -X POST http://localhost:3000/api/songs \
  -H 'content-type: application/json' \
  -d '{"title":"Hotel California"}'
```

## Notes and limits

- Key and BPM come from studio audio analysis, so they describe the recording,
  not any particular performance; live versions and remasters can differ.
- Lookups take a second or two because they make several upstream requests.
- Both services are public and rate limited; lookups use a short retry with
  backoff but a burst of additions may be throttled.
