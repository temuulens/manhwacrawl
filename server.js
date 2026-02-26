const express = require('express');
const { parse } = require('node-html-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache to avoid hammering asuracomic.net
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// List of slugs/keywords to watch - configurable via env or query param
// slug = the part after /series/ (without the hash suffix is fine for matching)
const DEFAULT_WATCHLIST = [
  'i-killed-an-academy-player',
  'the-player-hides-his-past',
  'nano-machine',
  'solo-leveling',
  'omniscient-readers-viewpoint',
];

async function fetchHomepage() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const res = await fetch('https://asuracomic.net/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const entries = parseUpdates(html);
  cache = { data: entries, fetchedAt: now };
  return entries;
}

function parseUpdates(html) {
  // The homepage update list structure (from DOM inspection):
  // Each card: .grid.grid-rows-1.grid-cols-12.m-2
  //   col-span-9 div contains:
  //     <a href="/series/SLUG">Title</a>
  //     chapter rows: <a href="/series/SLUG/chapter/N">Chapter N</a>
  //                   <p ...>Public in X hours  OR  X hours ago</p>

  const root = parse(html);

  // Find the latest updates section - series cards
  const cards = root.querySelectorAll('.grid.grid-rows-1.grid-cols-12.m-2');

  const results = [];

  for (const card of cards) {
    // Series title link
    const titleLink = card.querySelector('a[href^="/series/"]');
    if (!titleLink) continue;

    const title = titleLink.text.trim();
    const seriesHref = titleLink.getAttribute('href');
    // slug = "i-killed-an-academy-player-bb451ab6"
    const slugFull = seriesHref.replace('/series/', '').trim();

    // Find all chapter rows inside this card
    const chapterRows = card.querySelectorAll('.flex.flex-row.justify-between');

    for (const row of chapterRows) {
      const chapterLink = row.querySelector('a[href*="/chapter/"]');
      if (!chapterLink) continue;

      const chapterText = chapterLink.text.trim();
      // Time element: "Public in X hours" or "X hours ago" or "X days ago"
      const timePara = row.querySelector('p');
      if (!timePara) continue;

      const timeText = timePara.text.trim();

      results.push({
        title,
        slug: slugFull,
        chapter: chapterText,
        time: timeText,         // e.g. "Public in 4.5 hours" or "14 hours ago"
        isUpcoming: timeText.toLowerCase().startsWith('public in'),
      });
      // Only keep the latest chapter row per series (first one = newest)
      break;
    }
  }

  return results;
}

// Filter entries by watchlist (slug prefix matching)
function filterByWatchlist(entries, watchlist) {
  if (!watchlist || watchlist.length === 0) return entries;
  return entries.filter(e =>
    watchlist.some(w => e.slug.toLowerCase().startsWith(w.toLowerCase()))
  );
}

// ----- Routes -----

// GET /updates?watch=slug1,slug2   (omit watch= to get all)
app.get('/updates', async (req, res) => {
  try {
    const entries = await fetchHomepage();

    let watchlist = DEFAULT_WATCHLIST;
    if (req.query.watch) {
      watchlist = req.query.watch.split(',').map(s => s.trim()).filter(Boolean);
    }

    // 'all' returns everything
    const filtered = req.query.watch === 'all'
      ? entries
      : filterByWatchlist(entries, watchlist);

    res.json({
      ok: true,
      fetchedAt: new Date(cache.fetchedAt).toISOString(),
      count: filtered.length,
      updates: filtered,
    });
  } catch (err) {
    console.error('Error fetching updates:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /updates/esp32?watch=slug1,slug2
// Compact format optimised for small JSON parsing on ESP32
// Returns max 8 items, short field names
app.get('/updates/esp32', async (req, res) => {
  try {
    const entries = await fetchHomepage();

    let watchlist = DEFAULT_WATCHLIST;
    if (req.query.watch) {
      watchlist = req.query.watch.split(',').map(s => s.trim()).filter(Boolean);
    }

    const filtered = req.query.watch === 'all'
      ? entries
      : filterByWatchlist(entries, watchlist);

    // Compact payload: t=title, c=chapter, tm=time, u=isUpcoming
    // Truncate title to 20 chars to fit display width
    const compact = filtered.slice(0, 8).map(e => ({
      t: e.title.substring(0, 22),
      c: e.chapter.substring(0, 20),
      tm: e.time,
      u: e.isUpcoming ? 1 : 0,
    }));

    res.json({ ok: 1, n: compact.length, d: compact });
  } catch (err) {
    res.status(500).json({ ok: 0, e: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'manhwa-tracker running' }));

app.listen(PORT, () => {
  console.log(`Manhwa tracker running on port ${PORT}`);
  console.log(`  /updates           - full JSON`);
  console.log(`  /updates/esp32     - compact JSON for ESP32`);
  console.log(`  ?watch=slug1,slug2 - filter by series slug prefix`);
  console.log(`  ?watch=all         - return all series`);
});
