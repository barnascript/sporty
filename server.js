import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- config -------------------------------------------------------------
const COUNTRY = process.env.SPORTY_COUNTRY || "ng"; // ng, gh, ke, ...
const BASE = `https://www.sportybet.com/${COUNTRY}`;
const FEED_PAGES = Number(process.env.FEED_PAGES || 6); // 100 events/page
const SPORT_ID = "sr:sport:1"; // football
// markets we want in the feed: 1=1X2, 18=Over/Under, 10=DC, 29=BTTS ...
const MARKET_IDS = "1,18,10,29,11,26,36,14";

// ---- shared browser (reused across requests; free tier is RAM-limited) --
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
      ],
    });
  }
  return browserPromise;
}

// A ready SportyBet page we can run in-page fetches from (has a live session).
let pagePromise = null;
async function getSportyPage() {
  if (!pagePromise) {
    pagePromise = (async () => {
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        viewport: { width: 1280, height: 900 },
      });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/sport/football`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      // let the SPA boot so cookies / session are established
      await page.waitForTimeout(4000);
      return page;
    })().catch((e) => {
      pagePromise = null;
      throw e;
    });
  }
  return pagePromise;
}

// ---- team-name normalisation -------------------------------------------
const ALIASES = {
  "man city": "manchester city",
  "man utd": "manchester united",
  "man united": "manchester united",
  "inter milano": "inter",
  "intermilano": "inter",
  "inter milan": "inter",
  "bvb": "borussia dortmund",
  "dortmund": "borussia dortmund",
  "bodo glimt": "bodo/glimt",
  "bodo/glimt": "bodo/glimt",
  "crvena zvezda": "red star belgrade",
  "hadjuk split": "hajduk split",
  "hajduk split": "hajduk split",
  "psg": "paris saint germain",
  "rb leipzig": "rb leipzig",
  "spurs": "tottenham",
  "sporting cp": "sporting lisbon",
  "az alkmaar": "az alkmaar",
};

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[.\-_/]/g, " ")
    .replace(/\b(fc|cf|sc|afc|if|bk|ff|club|the)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonical(team) {
  const n = norm(team);
  return ALIASES[n] ? norm(ALIASES[n]) : n;
}

function tokens(s) {
  return new Set(norm(s).split(" ").filter((w) => w.length > 2));
}

// score how well a query team matches an event team name
function nameScore(queryCanon, eventName) {
  const en = norm(eventName);
  if (!en) return 0;
  if (en === queryCanon) return 1;
  if (en.includes(queryCanon) || queryCanon.includes(en)) return 0.9;
  const a = tokens(queryCanon);
  const b = tokens(eventName);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.max(a.size, b.size);
}

// ---- market parsing -----------------------------------------------------
// Turn "Over 0.5" / "Under 2.5" / "1X2 Home" / "BTTS" into a resolver.
function parseMarket(text) {
  const t = norm(text);
  let m;
  if ((m = t.match(/over\s*([0-9]+(?:\s*[0-9])?)/))) {
    return { kind: "ou", side: "Over", line: fixLine(m[1]) };
  }
  if ((m = t.match(/under\s*([0-9]+(?:\s*[0-9])?)/))) {
    return { kind: "ou", side: "Under", line: fixLine(m[1]) };
  }
  if (/both.*score|btts|gg\b/.test(t)) return { kind: "btts", yes: !/no\b/.test(t) };
  if (/\bhome\b|\bwin\b|\b1\b/.test(t)) return { kind: "1x2", desc: "Home" };
  if (/\baway\b|\b2\b/.test(t)) return { kind: "1x2", desc: "Away" };
  if (/\bdraw\b|\bx\b/.test(t)) return { kind: "1x2", desc: "Draw" };
  // default for these tip lists
  return { kind: "ou", side: "Over", line: "0.5" };
}
function fixLine(raw) {
  const n = String(raw).replace(/\s+/g, "");
  if (/^\d$/.test(n)) return n + ".5"; // "0" typed for "0.5" etc. -> best guess
  return n;
}

// Find the concrete {marketId, specifier, outcomeId, odds} inside a feed event.
function resolveSelection(event, want) {
  const markets = event.markets || [];
  const findOutcomeByDesc = (mkId, desc) => {
    for (const mk of markets) {
      if (mk.id !== mkId) continue;
      for (const o of mk.outcomes || []) {
        if (norm(o.desc) === norm(desc) && o.isActive) {
          return { marketId: mk.id, specifier: mk.specifier || "", outcomeId: o.id, odds: o.odds };
        }
      }
    }
    return null;
  };
  if (want.kind === "ou") {
    return findOutcomeByDesc("18", `${want.side} ${want.line}`);
  }
  if (want.kind === "1x2") {
    return findOutcomeByDesc("1", want.desc);
  }
  if (want.kind === "btts") {
    return findOutcomeByDesc("29", want.yes ? "Yes" : "No");
  }
  return null;
}

// ---- feed ---------------------------------------------------------------
// Pull upcoming football events. Primary path uses Playwright's request
// context (real HTTP with the page's cookies, bypassing SportyBet's patched
// window.fetch); falls back to an in-page fetch if that ever fails.
async function apiGet(page, pathAndQuery) {
  try {
    const resp = await page.context().request.get(BASE.replace(/\/[a-z]{2}$/, "") + pathAndQuery, {
      headers: { accept: "application/json", referer: `${BASE}/sport/football` },
    });
    if (resp.ok()) return await resp.json();
  } catch { /* fall through */ }
  return await page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { accept: "application/json" } });
    return await r.json();
  }, pathAndQuery);
}

async function loadEvents(page) {
  const all = [];
  for (let p = 1; p <= FEED_PAGES; p++) {
    const url =
      `/api/${COUNTRY}/factsCenter/pcUpcomingEvents` +
      `?sportId=${encodeURIComponent(SPORT_ID)}` +
      `&marketId=${encodeURIComponent(MARKET_IDS)}` +
      `&pageSize=100&pageNum=${p}&option=1&_t=${Date.now()}`;
    let json;
    try { json = await apiGet(page, url); } catch { break; }
    const tours = json && json.data && json.data.tournaments;
    if (!tours || !tours.length) break;
    for (const t of tours) for (const ev of t.events || []) all.push(ev);
    if (json.data.totalNum && all.length >= json.data.totalNum) break;
  }
  return all;
}

// ---- booking ------------------------------------------------------------
async function bookSelections(page, selections) {
  const body = { selections };
  // Primary: real HTTP POST carrying the context cookies.
  try {
    const resp = await page.context().request.post(
      `${BASE.replace(/\/[a-z]{2}$/, "")}/api/${COUNTRY}/orders/share`,
      {
        headers: {
          "content-type": "application/json;charset=UTF-8",
          referer: `${BASE}/sport/football`,
        },
        data: body,
      }
    );
    const json = await resp.json().catch(async () => ({ raw: await resp.text() }));
    if (json && json.data && json.data.shareCode) return { status: resp.status(), body: json };
    // fall through to in-page attempt if no code
    var firstTry = { status: resp.status(), body: json };
  } catch (e) {
    var firstTry = { status: 0, body: { message: String(e && e.message) } };
  }
  // Fallback: run inside the page so its own fetch wrapper / signing applies.
  try {
    const inPage = await page.evaluate(async (payload) => {
      const r = await fetch("/api/" + window.__C + "/orders/share", {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify(payload),
      });
      let b; try { b = await r.json(); } catch { b = { raw: await r.text() }; }
      return { status: r.status, body: b };
    }, body);
    if (inPage && inPage.body && inPage.body.data && inPage.body.data.shareCode) return inPage;
    return inPage || firstTry;
  } catch {
    return firstTry;
  }
}

// ---- API ----------------------------------------------------------------
app.post("/api/book", async (req, res) => {
  const picks = Array.isArray(req.body && req.body.picks) ? req.body.picks : [];
  if (!picks.length) return res.status(400).json({ error: "No picks provided." });

  try {
    const page = await getSportyPage();
    await page.evaluate((c) => { window.__C = c; }, COUNTRY);

    const events = await loadEvents(page);
    if (!events.length) {
      return res.status(502).json({ error: "Could not load SportyBet events feed. Try again shortly." });
    }

    const matched = [];
    const unmatched = [];
    const selections = [];

    for (const pick of picks) {
      const want = parseMarket(pick.market || "");
      const qc = canonical(pick.team || "");
      // best matching upcoming event for this team
      let best = null;
      for (const ev of events) {
        const s = Math.max(
          nameScore(qc, ev.homeTeamName),
          nameScore(qc, ev.awayTeamName)
        );
        if (s >= 0.6 && (!best || s > best.s || (s === best.s && ev.estimateStartTime < best.ev.estimateStartTime))) {
          best = { s, ev };
        }
      }
      if (!best) { unmatched.push({ ...pick, reason: "no fixture found" }); continue; }

      const sel = resolveSelection(best.ev, want);
      if (!sel) {
        unmatched.push({ ...pick, reason: `market '${pick.market}' not available`, event: `${best.ev.homeTeamName} v ${best.ev.awayTeamName}` });
        continue;
      }
      selections.push({
        eventId: best.ev.eventId,
        marketId: sel.marketId,
        specifier: sel.specifier,
        outcomeId: sel.outcomeId,
        sportId: SPORT_ID,
      });
      matched.push({
        team: pick.team,
        market: pick.market,
        event: `${best.ev.homeTeamName} v ${best.ev.awayTeamName}`,
        pick: `${want.kind === "ou" ? want.side + " " + want.line : want.desc || (want.yes ? "BTTS Yes" : "BTTS No")}`,
        odds: sel.odds,
        startTime: best.ev.estimateStartTime,
      });
    }

    if (!selections.length) {
      return res.status(422).json({ error: "None of the picks could be matched.", matched, unmatched });
    }

    const result = await bookSelections(page, selections);
    const data = result.body && result.body.data;
    if (!(data && data.shareCode)) {
      return res.status(502).json({
        error: "SportyBet did not return a booking code.",
        detail: result.body && (result.body.message || result.body.raw),
        matched, unmatched,
      });
    }

    res.json({
      code: data.shareCode,
      url: (data.shareURL || `${BASE}/?shareCode=${data.shareCode}`).replace(/^http:/, "https:"),
      matched,
      unmatched,
    });
  } catch (err) {
    res.status(500).json({ error: "Booking failed: " + (err && err.message) });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`sporty-booker listening on :${PORT}`));
