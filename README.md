# The Rowdy Roadie Band — Song List

A band song list that looks up the artist, musical key, BPM and a YouTube video for
each title, and builds printable setlists.

Two copies live here:

- `songbook/` — the local app. Node 22.5+, no dependencies, data in SQLite.
- `songbook-worker/` — the hosted version the band uses: a Cloudflare Worker with
  the data in D1.

Live site: <https://site-0e184ac6e03a461f957fe7dc51a1ea6e.freebuff.page>

The two databases are separate. Each folder's README covers its own setup; the
worker one has the deployment manifest and the local `wrangler dev` workflow.

## Quick start (local)

```bash
cd songbook
node server.js        # http://localhost:3000
```

Songs live in `songbook/data/songs.db` — back that file up. It is gitignored and is
not part of this repository.

## Deploying the hosted version

Edit the files in `songbook-worker/public/` (mirror front-end changes across from
`songbook/public/`) and deploy using `songbook-worker/deploy.json`.

There are no accounts or logins: anyone with the live link can edit the list.
