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

   Media relay (added in Garage TV 4.2.0): /media?u=<stream url>
     Drive mode (canvas-player.js) fetches HLS playlists and segments itself, so it needs the
     source to send CORS headers. Many free channels do not, and plain-http channels cannot be
     fetched from an https page at all. The page then asks this worker instead:
       GET /media?u=<absolute http(s) url>   (Range requests pass through, 206 + Content-Range back)
     Playlists (.m3u8) are rewritten so every segment / variant / key URI also goes through
     /media, so one relayed channel stays relayed.
     Only hosts in MEDIA_HOSTS below may be fetched (suffix match: 'amagi.tv' also allows
     'cdn-uw2-prod.tsv2.amagi.tv'). To allow another channel's host, add its domain to
     MEDIA_HOSTS (or to EXTRA_HOSTS in tools/relay_hosts.py and run it, which also refreshes the
     list from the iptv-org US index), then paste this file into the dashboard again.
     Optional: set a secret variable MEDIA_SECRET on the worker (Settings > Variables). Then the
     URIs inside relayed playlists are signed, so CDN hosts a channel redirects to work even when
     they are not in MEDIA_HOSTS. Without it, every host must be on the list.

   Honest note: this is Waze's own unofficial web feed, not a published API. It can stop
   working if Waze changes it. When that happens the page falls back to the plain Waze map. */

const ALLOW = [
  'https://barant123.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];
const ALLOW_HOST_SUFFIXES = ['barant123.github.io']; // any Origin on these hosts is allowed too
const BOX_MAX = 1.0;        // degrees; keeps requests small and local
const CACHE_SECONDS = 60;   // Waze updates about every minute anyway

export default {
  async fetch(req, vars = {}) {
    const origin = req.headers.get('Origin') || '';
    const okOrigin = originAllowed(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : ALLOW[0],
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const u = new URL(req.url);
    if (u.pathname === '/' || u.pathname === '') return new Response('Garage TV relay OK', { headers: { ...cors, 'Content-Type': 'text/plain' } });
    if (u.pathname === '/media') {
      if (origin && !okOrigin) return json({ error: 'origin not allowed' }, 403, cors);
      return media(req, u, vars, cors);
    }
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

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOW.includes(origin)) return true;
  try { const h = new URL(origin).hostname; return ALLOW_HOST_SUFFIXES.some(s => h === s || h.endsWith('.' + s)); } catch { return false; }
}

/* ---------- media relay ---------- */
// HOSTS:BEGIN (generated by tools/relay_hosts.py)
const MEDIA_HOSTS = [
  '103.154.3.101', '103.253.74.210', '107.167.7.162', '138.121.15.230', '138.59.177.78', '144.217.14.88',
  '15.204.246.24', '167.249.23.102', '168.196.127.137', '168.228.44.241', '181.224.255.210', '185.9.2.18',
  '186.148.196.82', '198.58.104.90', '200.115.120.1', '200.32.231.178', '212.5.144.156', '23.237.104.106',
  '305streamhd.com', '30a-tv.com', '31.148.48.15', '37.49.224.5', '38.44.109.41', '38.87.224.19',
  '4.30.180.36', '4.59.210.197', '41.205.93.154', '45.167.1.138', '45.170.130.224', '45.5.117.57',
  '45.6.4.35', '45.70.201.81', '5centscdn.com', '65.36.6.216', '66.242.170.53', '85.237.89.160',
  '89.187.179.148', 'abnvideos.com', 'acetelevisionnetwork.com', 'afghantv.app', 'akaku.org', 'akamaihd.net',
  'akamaized.net', 'akctvcontrol.com', 'almahditv.com', 'alsolnet.com', 'alticeusa.net', 'amagi.tv',
  'amazonaws.com', 'avang.live', 'awe.plus', 'aynaott.com', 'aynascope.net', 'azureedge.net',
  'b-cdn.net', 'bamboo-cloud.com', 'blivenyc.com', 'bloomberg.com', 'boldmss.com', 'botflix.tv',
  'bozztv.com', 'brightcove.com', 'cablecast.tv', 'cammonitorplus.net', 'cbsivideo.com', 'cbsnews.com',
  'cdn01.net', 'cdn77.org', 'cdnstream1.com', 'champaignil.gov', 'champds.com', 'christianworldmedia.com',
  'cinedigm.com', 'cityofrc.us', 'cloud9streaming.com', 'cloudflare.tv', 'cloudflarestream.com', 'cloudfront.net',
  'connectto.com', 'ct-n.com', 'dacast.com', 'dc.gov', 'ddns.net', 'diyatvinc.com',
  'doubleclick.net', 'ebmcdn.net', 'edgenextcdn.net', 'ercdn.net', 'essastream.com', 'fastcast4u.com',
  'fastly.net', 'field59.com', 'foxnews.com', 'frequency.stream', 'fuelmedia.io', 'g-mana.live',
  'getpublica.com', 'getstreamhosting.com', 'giatvcdn.com', 'github.com', 'glorystartv.live', 'google.com',
  'googleusercontent.com', 'granicusops.com', 'gunaz.tv', 'gvideo.io', 'haitilive.net', 'haititivi.com',
  'herringnetwork.com', 'host5245.com', 'ibb.co', 'iili.io', 'imgur.com', 'invintus.com',
  'iptvperu.tv', 'iranefardalive.com', 'isilive.ca', 'its-newid.net', 'jio.com', 'jmp2.uk',
  'jstre.am', 'jwp.services', 'jwplatform.com', 'jwplayer.com', 'jwplive.com', 'kaltura.com',
  'keshishhamid.live', 'klowdtv.com', 'ktcdn.co.kr', 'lakewood.org', 'lifestreamcdn.com', 'littletongov.org',
  'livecdn.io', 'livekadeh.com', 'liveone.com', 'liveplustv.com', 'livescast.com', 'livestreamcdn.net',
  'lura.live', 'malimarcdn.com', 'mcquack.net', 'mdstrm.com', 'mohabat.tv', 'myspirit.tv',
  'nbcuni.com', 'nexgen.bz', 'nocookie.net', 'nowcast.cc', 'nowtelly.com', 'oan.plus',
  'opencaster.com', 'ottera.tv', 'otteravision.com', 'parvizshahbazi.com', 'pbc.gov', 'pbs.org',
  'pbskids.org', 'persiana.live', 'piksel.tech', 'plex.tv', 'pluto.tv', 'quickplay.com',
  'relentlessinnovations.net', 'roku.com', 'rtve.es', 'rumble.com', 'sardius.media', 'scientology.org',
  'secdn.net', 'seminolecountyfl.gov', 'servers10.com', 'siliconweb.com', 'sinclairstoryline.com', 'skygo.mn',
  'smartplaytv.in', 'smc-host.com', 'smotrim.ru', 'sofast.tv', 'srfms.com', 'streambrothers.com',
  'streamguys1.com', 'streamhost.org', 'streamhoster.com', 'streamingmediahosting.com', 'streamlock.net', 'streamology.live',
  'streamready.in', 'streamspot.com', 'swagit.com', 'swamiji.tv', 'talgov.net', 'tapesh.tv',
  'tbnpacific.org.au', 'tegnaone.com', 'teleosmedia.com', 'telvue.com', 'test-streams.mux.dev', 'themediacdn.com',
  'thepalmbeaches.tv', 'toonamiaftermath.com', 'transmit.live', 'tripsmarter.com', 'truecrimenetworktv.com', 'tubi.io',
  'tubi.video', 'tulix.tv', 'tuvideoonline.com.ar', 'tvustream.com', 'twc-tv.com', 'univisionnow.com',
  'univtec.com', 'uplynk.com', 'usatv.com', 'vaughnsoft.net', 'vcdn.fyi', 'vegasplus.us',
  'vgcdn.net', 'vietprocast.app', 'viewtv.cloud', 'viloud.tv', 'vju.tv', 'vos360.video',
  'vtrplay.com', 'vustreams.com', 'warnermediacdn.com', 'watchtstv.com', 'wcetv.com', 'weathernationtv.com',
  'whiplash.cc', 'wikimedia.org', 'wixstatic.com', 'wmncdn.net', 'wns.live', 'workers.dev',
  'worldchannel.org', 'wowza.com', 'wurl.com', 'wurl.tv', 'youtube.com', 'zoomnews.info',
  'zype.com',
];
// HOSTS:END

function hostAllowed(host) {
  host = (host || '').toLowerCase();
  return MEDIA_HOSTS.some(s => host === s || host.endsWith('.' + s));
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...sig.slice(0, 16))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function media(req, u, env, cors) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method' }, 405, cors);
  const raw = u.searchParams.get('u') || '';
  let target;
  try { target = new URL(raw); } catch { return json({ error: 'bad url' }, 400, cors); }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return json({ error: 'bad scheme' }, 400, cors);
  const secret = env.MEDIA_SECRET || '';
  let allowed = hostAllowed(target.hostname);
  if (!allowed && secret) { const k = u.searchParams.get('k'); allowed = !!k && k === await hmac(secret, target.href); }
  if (!allowed) return json({ error: 'host not on the relay list: ' + target.hostname }, 403, cors);

  const headers = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept': '*/*' };
  const range = req.headers.get('Range');
  if (range) headers['Range'] = range;
  let up;
  try { up = await fetch(target.href, { method: req.method, headers, redirect: 'follow' }); }
  catch { return json({ error: 'upstream unreachable' }, 502, cors); }
  if (!up.ok && up.status !== 206) return json({ error: 'upstream ' + up.status }, 502, cors);

  const type = (up.headers.get('Content-Type') || '').toLowerCase();
  const looksPlaylist = /mpegurl|m3u/.test(type) || /\.m3u8?($|\?)/i.test(target.pathname + target.search);
  if (looksPlaylist && req.method === 'GET') {
    const text = await up.text();
    if (text.trimStart().startsWith('#EXTM3U')) {
      const base = up.url || target.href;
      const self = u.origin + '/media?u=';
      const wrap = async ref => {
        let abs; try { abs = new URL(ref, base).href; } catch { return ref; }
        let out = self + encodeURIComponent(abs);
        if (secret) out += '&k=' + await hmac(secret, abs);
        return out;
      };
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l) continue;
        if (l[0] !== '#') lines[i] = await wrap(l);
        else if (/URI="/.test(l)) {
          const parts = []; let last = 0; const re = /URI="([^"]*)"/g; let m;
          while ((m = re.exec(l))) { parts.push(l.slice(last, m.index), 'URI="' + await wrap(m[1]) + '"'); last = m.index + m[0].length; }
          parts.push(l.slice(last)); lines[i] = parts.join('');
        }
      }
      return new Response(lines.join('\n'), { status: 200, headers: { ...cors, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' } });
    }
    return new Response(text, { status: up.status, headers: { ...cors, 'Content-Type': type || 'text/plain', 'Cache-Control': 'no-store' } });
  }
  const out = new Headers(cors);
  const encoded = !!up.headers.get('Content-Encoding'); // fetch already decoded the body, so its length would be wrong
  for (const h of ['Content-Type', ...(encoded ? [] : ['Content-Length']), 'Content-Range', 'Accept-Ranges', 'Cache-Control', 'Last-Modified', 'ETag']) {
    const v = up.headers.get(h); if (v) out.set(h, v);
  }
  return new Response(req.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
