# Songbook — hosted version

The same song list as `../songbook`, but running as a Cloudflare Worker with the
data in D1 instead of a local SQLite file, so it has a URL the band can open on
their phones.

Live site: <https://rowdyroadieband.freebuff.page>

The preview environment keeps its own URL and its own D1 database, so a test
there never touches the band's list.

## What differs from the local version

| | `../songbook` | here |
| --- | --- | --- |
| Server | `node:http` | Worker `fetch` handler |
| Storage | `node:sqlite` file | D1 (`env.DB`) |
| Front end | same `public/` files | same `public/` files |
| Lookup + export | `src/lookup.js`, `src/export.js` | identical copies |

The two are independent: adding a song on the hosted site does not change
`songbook/data/songs.db`, and vice versa.

There are no logins. Anyone with the URL can add, edit and delete songs, and
everyone shares one library.

### YouTube links

Stored per song in `youtube_url` and resolved the same way as the local version —
the public YouTube results page, since there is no keyless API; karaoke,
instrumental and cover uploads are skipped, and an official lyric video is used
only as the last resort, when nothing better is on offer. Deployments created
before this feature get the column from a guarded `ALTER TABLE` inside
`ensureSchema`, on the first request after deploy.

## Layout

```
worker.js        API routes, JSON responses, falls back to env.ASSETS
src/store.js     D1 queries (async; .bind(...).first() everywhere)
src/lookup.js    iTunes + ReccoBeats lookup, unchanged
src/export.js    txt / csv / print renderers, unchanged
public/          index.html, styles.css, app.js
deploy.json      deployment manifest (entrypoint, modules, assets)
wrangler.toml    local dev only — the deployed config comes from the platform
```

The schema is created on the first API request (`ensureSchema`), so there is no
migration step: `songs`, `setlists`, `setlist_songs`, and the unique ISRC index.

## Local development

```bash
npm install          # wrangler only
npx wrangler dev --port 8787
# http://127.0.0.1:8787, with a local D1 database under .wrangler/
```

`sq`/`--local` D1 state lives in `.wrangler/state`. Delete that directory to get
an empty library; the schema is recreated on the next request.

## Seeding an existing library

`POST /api/import` with `{ "songs": [ ... ] }` (max 500) fills an **empty**
library, preserving `created_at`, and returns `409` once any song exists, so it
cannot overwrite a live list. `data/library.json` is the export from the local
SQLite database used to seed this deployment.

## Deploying

Deployment goes through Freebuff Sites with `deploy.json` as the manifest; the
platform injects the `DB` binding and serves `public/` as static assets. Deploy
again after changing any file in `public/` or `src/`, then check the preview
before publishing production.
