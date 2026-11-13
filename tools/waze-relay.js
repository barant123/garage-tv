/* Garage TV traffic relay — a Cloudflare Worker (free plan is plenty).

   Why this exists: Waze's live-map feed (jams, police, crashes, hazards) refuses requests
   that come straight from a web page, so the Garage TV page asks this tiny relay instead.
   The relay fetches the feed for the box around the car, trims it, caches it for 60 s and
   returns it with CORS headers so the page may read it. Same approach as teslanav.com.

   Set up (about 10 minutes, once):
     1. dash.cloudflare.com → sign up (free) → Workers & Pages → Create → Create Worker.
     2. Name it (e.g. garage-tv-relay) → Deploy. Then "Edit code", delete the sample,
        paste this whole file, Deploy again.
     3. Copy the worker URL (looks like https://garage-tv-relay.<you>.workers.dev).
     4. Garage TV → Settings → "Traffic relay URL" → paste → Save → bookmark the car link.
   Health check: open the worker URL in a browser; it should say "Garage TV relay OK".

   Honest note: this is Waze's own unofficial web feed, not a published API. It can stop
   working if Waze changes it. When that happens the page falls back to the plain Waze map. */

const ALLOW = [
  'https://barant123.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];
const BOX_MAX = 1.0;        // degrees; keeps requests small and local
const CACHE_SECONDS = 60;   // Waze updates about every minute anyway

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOW.includes(origin) ? origin : ALLOW[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const u = new URL(req.url);
    if (u.pathname === '/' || u.pathname === '') return new Response('Garage TV relay OK', { headers: { ...cors, 'Content-Type': 'text/plain' } });
    if (u.pathname !== '/waze') return json({ error: 'not found' }, 404, cors);

    const n = k => parseFloat(u.searchParams.get(k));
    const top = n('top'), bottom = n('bottom'), left = n('left'), right = n('right');
    const ok = [top, bottom, left, right].every(Number.isFinite) && top > bottom && right > left &&
      top - bottom <= BOX_MAX && right - left <= BOX_MAX;
    if (!ok) return json({ error: 'bad box' }, 400, cors);

    // Snap the box to a 0.02° grid so cars a few blocks apart share one cached answer.
    const snap = x => (Math.round(x / 0.02) * 0.02).toFixed(2);
    const lonMid = (left + right) / 2;
    const env = lonMid >= -170 && lonMid <= -30 ? 'na' : 'row';
    const upstream = 'https://www.waze.com/live-map/api/georss' +
      `?top=${snap(top)}&bottom=${snap(bottom)}&left=${snap(left)}&right=${snap(right)}&env=${env}&types=alerts,traffic`;

    const cache = caches.default;
    const key = new Request(upstream, { method: 'GET' });
    let hit = await cache.match(key);
    if (!hit) {
      let w;
      try {
        w = await fetch(upstream, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; GarageTV-relay/1.0; +https://barant123.github.io/garage-tv/)',
            'Referer': 'https://www.waze.com/live-map/',
          },
        });
      } catch (e) { return json({ error: 'upstream unreachable' }, 502, cors); }
      if (!w.ok) return json({ error: 'waze ' + w.status }, 502, cors);
      let d;
      try { d = await w.json(); } catch { return json({ error: 'waze sent something that is not JSON' }, 502, cors); }

      const slim = {
        at: Date.now(),
        alerts: (d.alerts || []).filter(a => a && a.location).map(a => ({
          t: a.type || '', s: a.subtype || '', y: +(+a.location.y).toFixed(5), x: +(+a.location.x).toFixed(5),
          st: a.street || '', city: a.city || '', r: a.reliability || 0, ms: a.pubMillis || 0,
        })),
        jams: (d.jams || []).filter(j => j && Array.isArray(j.line)).map(j => ({
          l: j.level || 0, kmh: j.speedKMH == null ? null : Math.round(j.speedKMH), st: j.street || '', d: j.delay || 0,
          line: j.line.map(p => [+(+p.y).toFixed(5), +(+p.x).toFixed(5)]),
        })),
      };
      hit = json(slim, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
      await cache.put(key, hit.clone());
    }
    const out = new Response(hit.body, hit);
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
