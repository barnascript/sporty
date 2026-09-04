# SportyBet Slip Booker

Upload a tips screenshot → OCR reads the picks in your browser → the server builds
the slip on SportyBet and returns a **booking code + link**. **No stake is placed.**
You open the link, review, and place the bet yourself.

It reproduces, automatically, exactly the manual flow: load SportyBet, find each
fixture, select the market (e.g. *Over 0.5*), and hit *Book Bet* to mint a share code.

## How it works

- **Frontend** (`public/index.html`): OCR via Tesseract.js runs in the browser. Only
  the parsed picks (team + market text) are sent to the server — never the image.
- **Backend** (`server.js`, Express + Playwright): loads a real SportyBet page in
  headless Chromium (so the site's own session signs the booking request), pulls the
  upcoming-football feed, fuzzy-matches each team to a fixture, resolves the market/
  outcome, and calls SportyBet's `orders/share` endpoint to get the booking code.

## Deploy on Render (free)

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com): **New → Blueprint**, point it at the repo.
   `render.yaml` provisions a free Docker web service. (Or **New → Web Service**,
   choose **Docker**, free plan.)
3. Wait for the build (Playwright base image is ~1.5 GB, first build is slow).
4. Open the service URL.

### Config (env vars)
- `SPORTY_COUNTRY` — SportyBet region: `ng` (default), `gh`, `ke`, `ug`, `tz`, `zm`.
- `FEED_PAGES` — how many 100-event feed pages to scan for matching (default `6`).

## Run locally
```bash
npm install
npx playwright install chromium
npm start
# open http://localhost:3000
```

## Honest limitations
- **Free tier RAM (512 MB)** is tight for headless Chromium. It works, but a heavy
  slip can be slow or occasionally OOM; the service also sleeps after ~15 min idle
  (first request after sleep is slow). A paid Starter instance is far more reliable.
- **Team→fixture matching is best-effort.** Always check the *matched* list the app
  shows before placing. Ambiguous names or lower leagues may be skipped.
- **Depends on undocumented SportyBet endpoints/markup.** If SportyBet changes them,
  the resolver/booking step may need updating.
- Booking codes **expire** (odds change / time limits). Use them before kickoff.
- This only *books* selections; it never logs in, stakes, or confirms a bet.
