import express from 'express';
import got from 'got';
import { parse } from 'node-html-parser';

const app = express();
const PORT = process.env.PORT || 3000;

// Cache - avoid hammering the site
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Default watchlist - slug prefixes from asuracomic.net/series/SLUG
const DEFAULT_WATCHLIST = [
  'i-killed-an-academy-player',
  'the-player-hides-his-past',
  'nano-machine',
  'solo-leveling',
  'omniscient-readers-viewpoint',
];

// got instance with HTTP/2 + realistic browser headers
// HTTP/2 is key - Cloudflare lets it through, HTTP/1.1 gets 403
const client = got.extend({
  http2: true,
  headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'max-age=0',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  },
  timeout: { request: 15000 },
  retry: { limit: 2 },
});

async function fetchHomepage() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const response = await client.get('https://asuracomic.net/');
  const html = response.body;

  const entries = parseUpdates(html);
  cache = { data: entries, fetchedAt: now };
  return entries;
}

function parseUpdates(html) {
  const root = parse(html);

  // Each update card: div.grid.grid-rows-1.grid-cols-12.m-2
  // Inside: series title link, then chapter rows with time
  const cards = root.querySelectorAll('.grid.grid-rows-1.grid-cols-12.m-2');
  const results = [];

  for (const card of cards) {
    const titleLink = card.querySelector('a[href^="/series/"]');
    if (!titleLink) continue;

    const title = titleLink.text.trim();
    const slugFull = titleLink.getAttribute('href').replace('/series/', '').trim();

    // First chapter row = latest chapter
    const chapterRows = card.querySelectorAll('.flex.flex-row.justify-between');
    for (const row of chapterRows) {
      const chapterLink = row.querySelector('a[href*="/chapter/"]');
      if (!chapterLink) continue;

      const timePara = row.querySelector('p');
      if (!timePara) continue;

      const timeText = timePara.text.trim();

      results.push({
        title,
        slug: slugFull,
        chapter: chapterLink.text.trim(),
        time: timeText,
        isUpcoming: timeText.toLowerCase().startsWith('public in'),
      });
      break; // only latest chapter per series
    }
  }

  return results;
}

function filterByWatchlist(entries, watchlist) {
  if (!watchlist || watchlist.length === 0) return entries;
  return entries.filter(e =>
    watchlist.some(w => e.slug.toLowerCase().startsWith(w.toLowerCase()))
  );
}

// GET /updates?watch=slug1,slug2  (or ?watch=all)
app.get('/updates', async (req, res) => {
  try {
    const entries = await fetchHomepage();
    const filtered = req.query.watch === 'all'
      ? entries
      : filterByWatchlist(entries, req.query.watch
          ? req.query.watch.split(',').map(s => s.trim()).filter(Boolean)
          : DEFAULT_WATCHLIST);

    res.json({
      ok: true,
      fetchedAt: new Date(cache.fetchedAt).toISOString(),
      count: filtered.length,
      updates: filtered,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /updates/esp32?watch=slug1,slug2  — compact payload for ESP32
app.get('/updates/esp32', async (req, res) => {
  try {
    const entries = await fetchHomepage();
    const filtered = req.query.watch === 'all'
      ? entries
      : filterByWatchlist(entries, req.query.watch
          ? req.query.watch.split(',').map(s => s.trim()).filter(Boolean)
          : DEFAULT_WATCHLIST);

    const compact = filtered.slice(0, 8).map(e => ({
      t:  e.title.substring(0, 22),
      c:  e.chapter.substring(0, 20),
      tm: e.time,
      u:  e.isUpcoming ? 1 : 0,
    }));

    res.json({ ok: 1, n: compact.length, d: compact });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: 0, e: err.message });
  }
});

app.get('/', (_req, res) => res.json({ status: 'manhwa-tracker running' }));

app.listen(PORT, () => {
  console.log(`Manhwa tracker on port ${PORT}`);
});
