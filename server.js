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
  'crimson-reset',
  'mount-hua-sects-genius-phantom-swordsman',
  'the-extras-academy-survival-guide',
  'infinite-mage',
  'the-novels-extra-remake',
  'pick-me-up-infinite-gacha',
  'omniscient-readers-viewpoint',
  'what-a-bountiful-harvest-demon-lord',
  'sword-devouring-swordmaster',
  'myst-might-mayhem',
  'eternally-regressing-knight',
  'revenge-of-the-iron-blooded-sword-hound',
  'reaper-of-the-drifting-moon',
  'chronicles-of-the-lazy-sovereign',
  'overgeared',
  'killer-pietro',
  'absolute-regression',
  'solo-max-level-newbie',
  'nano-machine',
  'a-villains-will-to-survive',
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

  // Card structure (from raw HTML inspection):
  //
  // <div class="grid grid-rows-1 grid-cols-12 m-2">
  //   <div class="col-span-3 ...">
  //     <a href="/series/SLUG"><img .../></a>   ← first link, img only, NO text
  //   </div>
  //   <div class="col-span-9 ...">
  //     <span class="text-[15px] font-medium ...">
  //       <a href="/series/SLUG">Title Text</a>  ← second link, HAS text
  //     </span>
  //     <div class="flex flex-col gap-y-1.5 ...">
  //       <span class="flex-1 inline-block mt-1">
  //         <div class="flex flex-row justify-between ...">
  //           <div ...><a href="/series/SLUG/chapter/N">
  //             <p class="w-[80px]">Chapter N</p>
  //           </a></div>
  //           <div class="flex">
  //             <svg .../>
  //             <p class="flex items-end text-[12px] ml-2 text-zinc-500">
  //               Public in <!-- -->4.1<!-- --> hours
  //             </p>
  //           </div>
  //         </div>
  //       </span>
  //     </div>
  //   </div>
  // </div>

  const cards = root.querySelectorAll('.grid.grid-rows-1.grid-cols-12.m-2');
  const results = [];

  for (const card of cards) {
    // col-span-9 contains the title span and chapter rows
    const contentCol = card.querySelector('.col-span-9');
    if (!contentCol) continue;

    // Title: the <a> inside the text-[15px] span
    const titleSpan = contentCol.querySelector('span.text-\\[15px\\]');
    const titleLink = titleSpan
      ? titleSpan.querySelector('a[href^="/series/"]')
      : null;
    if (!titleLink) continue;

    const title = titleLink.text.trim();
    const slugFull = titleLink.getAttribute('href').replace('/series/', '').trim();

    // Chapter rows
    const chapterRows = contentCol.querySelectorAll('.flex.flex-row.justify-between');
    for (const row of chapterRows) {
      const chapterLink = row.querySelector('a[href*="/chapter/"]');
      if (!chapterLink) continue;

      // Chapter text is in <p class="w-[80px]">
      const chapterPara = chapterLink.querySelector('p.w-\\[80px\\]');
      const chapterText = chapterPara ? chapterPara.text.trim() : chapterLink.text.trim();

      // Time is in <p class="flex items-end ...text-zinc-500">
      // Raw HTML: "Public in <!-- -->4.1<!-- --> hours" — strip HTML comments
      const timePara = row.querySelector('p.text-zinc-500');
      if (!timePara) continue;

      // node-html-parser gives us innerHTML with the <!-- --> still in it
      // strip comment nodes and collapse whitespace
      const timeText = timePara.innerHTML
        .replace(/<!--.*?-->/g, '')   // remove React comment nodes
        .replace(/<[^>]+>/g, '')      // remove any other tags
        .replace(/\s+/g, ' ')
        .trim();

      results.push({
        title,
        slug: slugFull,
        chapter: chapterText,
        time: timeText,
        isUpcoming: timeText.toLowerCase().startsWith('public in'),
      });
      break; // only latest chapter per series
    }
  }

  return results;
}

// Parse "X hours ago" / "X days ago" / "X minutes ago" into hours (float).
// Returns Infinity if it can't be parsed (= too old, exclude).
function hoursAgo(timeText) {
  const t = timeText.toLowerCase().trim();
  const m = t.match(/^([\d.]+)\s*(minute|hour|day)/);
  if (!m) return Infinity;
  const val = parseFloat(m[1]);
  if (m[2].startsWith('minute')) return val / 60;
  if (m[2].startsWith('hour'))   return val;
  if (m[2].startsWith('day'))    return val * 24;
  return Infinity;
}

// Returns true if entry should appear:
//   - is in the watchlist AND
//   - is upcoming (not yet public) OR released within last 24 h
function isRelevant(entry, watchlist) {
  const inList = watchlist.some(w =>
    entry.slug.toLowerCase().startsWith(w.toLowerCase())
  );
  if (!inList) return false;
  if (entry.isUpcoming) return true;
  return hoursAgo(entry.time) <= 24;
}

// GET /updates  — human-readable JSON
app.get('/updates', async (req, res) => {
  try {
    const all = await fetchHomepage();
    const watchlist = req.query.watch === 'all'
      ? null
      : (req.query.watch
          ? req.query.watch.split(',').map(s => s.trim()).filter(Boolean)
          : DEFAULT_WATCHLIST);

    const filtered = watchlist
      ? all.filter(e => isRelevant(e, watchlist))
      : all;

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

// GET /updates/esp32  — compact payload for ESP32
// u field: 1 = upcoming, 2 = released within 24 h
app.get('/updates/esp32', async (req, res) => {
  try {
    const all = await fetchHomepage();
    const watchlist = req.query.watch === 'all'
      ? null
      : (req.query.watch
          ? req.query.watch.split(',').map(s => s.trim()).filter(Boolean)
          : DEFAULT_WATCHLIST);

    const filtered = watchlist
      ? all.filter(e => isRelevant(e, watchlist))
      : all;

    const compact = filtered.slice(0, 21).map(e => ({
      t:  e.title.substring(0, 22),
      c:  e.chapter.substring(0, 20),
      tm: e.time,
      // 1 = upcoming (not yet public), 2 = released (within 24 h)
      u:  e.isUpcoming ? 1 : 2,
    }));

    res.json({ ok: 1, n: compact.length, d: compact });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: 0, e: err.message });
  }
});

// Debug: dump a snippet of raw HTML around the first card
app.get('/debug', async (req, res) => {
  try {
    const response = await client.get('https://asuracomic.net/');
    const html = response.body;
    // Find first card and show 2000 chars around it
    const idx = html.indexOf('grid-cols-12 m-2');
    const snippet = idx > -1 ? html.substring(idx - 50, idx + 2000) : 'MARKER NOT FOUND';
    // Also show a piece around "Public in"
    const idx2 = html.indexOf('Public in');
    const snippet2 = idx2 > -1 ? html.substring(idx2 - 500, idx2 + 200) : 'PUBLIC IN NOT FOUND';
    res.type('text/plain').send('=== CARD ===\n' + snippet + '\n\n=== PUBLIC IN ===\n' + snippet2);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/', (_req, res) => res.json({ status: 'manhwa-tracker running' }));

app.listen(PORT, () => {
  console.log(`Manhwa tracker on port ${PORT}`);
});
