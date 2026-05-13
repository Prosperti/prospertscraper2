# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the app (Express + Vite middleware on `http://localhost:3000`). `tsx server.ts` runs the TypeScript server directly; the Vite dev server is mounted as middleware inside Express, so the same port serves both the React SPA and the `/api/*` routes.
- `npm run build` — `vite build` produces the SPA in `dist/`, then `esbuild` bundles `server.ts` to `dist/server.js` (ESM, node18). `express`, `vite`, `cheerio`, `axios`, and `@google/genai` are kept external and must be present in `node_modules` at runtime.
- `npm start` — run the production build (`node dist/server.js`). Set `NODE_ENV=production` so the server serves the static `dist/` instead of attaching Vite middleware.
- `npm run lint` — `tsc --noEmit` typecheck (the project has no test runner).
- `npm run clean` — `rm -rf dist` (POSIX command; use `Remove-Item -Recurse -Force dist` on PowerShell).

The `.env.local` keys actually consumed at runtime: `VITE_GOOGLE_MAPS_API_KEY` (read server-side via `process.env`, not just on the client), `OPENAI_API_KEY`, and `GEMINI_API_KEY` (also inlined into the client bundle by `vite.config.ts`).

## Architecture

This is a single-page React 19 app on top of an Express server. The whole app is one process — there is no separate backend service.

### Job/streaming model (the core flow)

The UI does **not** call scraping endpoints directly. The flow is:

1. `POST /api/start-job` (server.ts) returns a random `jobId` and kicks off `processJob` in the background. Job state lives in an in-memory `Map<jobId, JobState>` where `JobState = { emitter, results, logs, isDone }`.
2. The client opens `GET /api/job-stream?jobId=...&lastResultCount=...&lastLogCount=...` as an `EventSource`. The server replays any buffered logs/results past the client's counts, then attaches an `emitter.on('log')` listener and streams new events as SSE messages.
3. On `done`, the SSE closes and the job is deleted after a 5-minute grace window so reconnects can still replay.
4. The client (`App.tsx` `connectSSE`) auto-reconnects on `onerror` with a 3s backoff, sending the latest counts so nothing is lost.

When editing the streaming path, keep the replay-by-counter contract intact — both sides depend on `results` and `logs` being append-only arrays whose indexes are stable for the lifetime of the job.

### Two search modes share one pipeline

`processJob` builds a `pointsToSearch[]` list from `config.mode`:

- `radius`: if no lat/lng, geocode `city` via Nominatim, then generate a square grid stepped by `max(3 km, sqrt(πr²/N))` and filter to points within `radius` km. Each grid point becomes a Google Places `textsearch` call.
- `landkreis`: take `config.cities` (sent from the frontend's `germanDistricts` dataset) or fall back to the small hard-coded `LANDKREIS_DATA` map at the top of `server.ts`. Each city becomes a text query of the form `"${industry} in ${city}, ${region}, Germany"` — no grid.

Both modes then run the same loop: Places textsearch (up to 3 pages per point, 2s sleep between page tokens, dedupe on `place_id`) → Places `details` for website + phone → `analyzeWebsite(url)` if a website exists → push a normalized record via `addResult`.

### Website scraping + LLM extraction

`analyzeWebsite` (and the duplicate `POST /api/analyze-website` route) does the same thing in two places:

1. `axios` fetch homepage, parse with `cheerio`, strip `script/style/noscript/iframe/img/svg/video`.
2. Collect same-origin links, pick the first matching `impressum|imprint|legal`, `kontakt|contact`, (and for the standalone endpoint also `datenschutz|privacy` plus up to 3 "about/team" pages). Fall back to `${root}/impressum`, etc. if no link is found.
3. Concatenate text, de-obfuscate emails (`[at]`, `(dot)`, `[email protected]`), then regex-extract emails (preferring `info|kontakt|hello|office`) and German phone numbers.
4. Send the first 6000 chars to OpenAI `gpt-4o-mini` with `response_format: json_object` to pull out `vorname/nachname/anrede/phone/email` (and `companyName` in the job path). OpenAI's answers override the regex results.

If you change the prompt or the JSON keys, update both copies — they have drifted before (`/api/analyze-website` also returns `linkedinUrl`, `favicon`, `inhalt`; `processJob`'s inline version returns `homepage_inhalt`).

### Persistence

History is written to `data/history/` next to `process.cwd()`:
- `index.json` — array of `{ id, timestamp, date, config, resultCount }`, most-recent first.
- `${searchId}.json` — the full results array for that job.

The `GET /api/history` and `GET /api/history/:id` endpoints just read those files. There is no DB and no auth.

### Frontend specifics

- `src/App.tsx` is the entire UI (~700 lines, in German). The Landkreis selector reads from `src/data/german_districts.ts` and posts `cities: selectedDistrict.cities` so the server doesn't need to know about the dataset.
- `src/components/MapSelector.tsx` uses `react-leaflet` for the radius picker and patches Leaflet's default-icon URLs to a CDN — required because Vite doesn't auto-resolve Leaflet's image assets.
- `src/types.ts` defines `Company`/`AnalyzedCompany` but the streamed result records use a separate German-keyed shape (`branche`, `anrede`, `vorname`, `nachname`, ...) constructed inline in `server.ts`. The "require full data" filter and history CSV/XLSX export both rely on those German keys.
- Vite alias `@/*` → repo root (`tsconfig.json` and `vite.config.ts`). `process.env.GEMINI_API_KEY` is statically inlined into the client bundle by `vite.config.ts`.
- HMR is gated on `DISABLE_HMR` — AI Studio sets this to suppress flicker during agent edits. Don't remove that guard.

### One-off scripts

`update.ts` is a single-run migration that rewrote `german_districts.ts` to add the `state` field. It is not wired into any npm script and should not be re-run — running it again will prepend a second `state?: string;` field to the interface.
