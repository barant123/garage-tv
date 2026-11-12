/* Garage TV — personal media page for the Tesla browser.
   One home page with collapsible sections (Live TV, YouTube, Markets, Calendar) that remember
   whether they were open. Live channels play in an HLS player, the YouTube playlist plays in an
   embedded player inside the app and remembers where you stopped. No build step, no accounts. */

(() => {
'use strict';

const VERSION = '2.0.0';
const PUBLIC_US = 'https://iptv-org.github.io/iptv/countries/us.m3u';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const isHttpsPage = location.protocol === 'https:';

/* ---------- storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k)    { try { localStorage.removeItem(k); } catch {} },
};

const state = {
  sources: { tv: [], links: [], markets: [], youtube: {} },
  cfg: store.get('cfg', {}),                 // { ytList }
  favs: store.get('favs', []),
  resume: store.get('yt_resume', null),      // { id, title, t, d, when }
  open: store.get('ui_open', {}),            // { tv:true, yt:true, mk:false, cal:false }
  publicUS: null,
  queue: [], qi: 0,
  hls: null,
};

/* ---------- views ---------- */
const views = ['home', 'tv', 'youtube', 'player', 'settings'];
let current = 'home';
function show(name, push = true, opts = {}) {
  if (name === current && !opts.force) return;
  if (current === 'player') stopPlayer();
  if (current === 'youtube' && name !== 'youtube') ytLeave();
  views.forEach(v => { $('#view-' + v).hidden = v !== name; });
  current = name;
  window.scrollTo(0, 0);
  if (push) history.pushState({ view: name }, '', location.href);
  if (name === 'home') renderHome();
  if (name === 'tv') renderTV();
  if (name === 'youtube') openYouTube(opts);
  if (name === 'settings') renderSettings();
}
window.addEventListener('popstate', e => show((e.state && e.state.view) || 'home', false));
document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); show(go.dataset.go); return; }
  if (e.target.closest('[data-max]')) { toggleMax(); return; }
  const head = e.target.closest('.sec-head');
  if (head) toggleSection(head.parentElement);
});

/* ---------- collapsible sections (state remembered) ---------- */
function toggleSection(sec, force) {
  const key = sec.dataset.sec;
  const open = force == null ? !sec.classList.contains('open') : force;
  sec.classList.toggle('open', open);
  state.open[key] = open; store.set('ui_open', state.open);
  if (open && key === 'mk') mountMarkets();
  if (open && key === 'cal') mountEvents();
  if (open && key === 'yt') ensureYT();
}
function applySections() {
  $$('.sec').forEach(sec => {
    const open = !!state.open[sec.dataset.sec];
    sec.classList.toggle('open', open);
    if (open && sec.dataset.sec === 'mk') mountMarkets();
    if (open && sec.dataset.sec === 'cal') mountEvents();
    if (open && sec.dataset.sec === 'yt') ensureYT();
  });
}

/* ---------- maximize (browser full screen) ---------- */
function toggleMax() {
  try {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (p && p.catch) p.catch(() => alert('This browser refused full screen. Try the browser’s own full-screen control.'));
  } catch { alert('Full screen is not available in this browser.'); }
}

/* ---------- helpers ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function isFav(ch) { return state.favs.some(f => f.url === ch.url); }
function toggleFav(ch) {
  if (isFav(ch)) state.favs = state.favs.filter(f => f.url !== ch.url);
  else state.favs.push({ name: ch.name, url: ch.url, group: ch.group || '', logo: ch.logo || '' });
  store.set('favs', state.favs);
}
function mixedContent(url) { return isHttpsPage && /^http:\/\//i.test(url); }
function mmss(s) { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
function initials(name) { return name.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase(); }

function channelCard(ch, opts = {}) {
  const el = document.createElement('div');
  el.className = 'card' + (mixedContent(ch.url) ? ' warn' : '');
  el.setAttribute('role', 'button');
  el.innerHTML =
    (opts.tag ? `<span class="tag">${esc(opts.tag)}</span>` : '') +
    (opts.star ? `<button class="fav ${isFav(ch) ? 'on' : ''}" aria-label="favorite">${isFav(ch) ? '&#9733;' : '&#9734;'}</button>` : '') +
    (ch.logo ? `<img class="logo" src="${esc(ch.logo)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=logo-text>${esc(initials(ch.name))}</span>'">`
             : `<span class="logo-text">${esc(initials(ch.name))}</span>`) +
    `<span class="name">${esc(ch.name)}</span>`;
  el.addEventListener('click', e => {
    const star = e.target.closest('.fav');
    if (star) { toggleFav(ch); star.classList.toggle('on', isFav(ch)); star.innerHTML = isFav(ch) ? '&#9733;' : '&#9734;'; if (current === 'home') renderHome(); return; }
    play(ch, el.__queue || [ch]);
  });
  return el;
}
function renderCards(grid, list, opts = {}, max = 400) {
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  list.slice(0, max).forEach(ch => { const t = channelCard(ch, typeof opts === 'function' ? opts(ch) : opts); t.__queue = list; frag.appendChild(t); });
  grid.appendChild(frag);
  return list.length > max ? `Showing first ${max} of ${list.length}. Use search to narrow it down.` : '';
}
function filterList(list, q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(ch => (ch.name + ' ' + (ch.group || '')).toLowerCase().includes(q));
}

/* ---------- M3U (public index) ---------- */
function parseM3U(text) {
  const out = [];
  let meta = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      line.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v; return ''; });
      const name = line.slice(line.lastIndexOf(',') + 1).trim() || attrs['tvg-name'] || 'Channel';
      meta = { name, group: (attrs['group-title'] || '').split(';')[0], logo: attrs['tvg-logo'] || '' };
    } else if (line.startsWith('#')) {
      continue;
    } else if (meta) {
      out.push({ ...meta, url: line });
      meta = null;
    }
  }
  return out;
}

/* ---------- clock ---------- */
function tickClock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '  ' +
    d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
}
setInterval(tickClock, 15000); tickClock();

/* ---------- TradingView widgets (free embeds, no key) ---------- */
function tvWidget(container, script, cfg) {
  container.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
  const s = document.createElement('script');
  s.src = 'https://s3.tradingview.com/external-embedding/' + script;
  s.async = true;
  s.textContent = JSON.stringify(cfg);
  container.firstChild.appendChild(s);
}
let marketsMounted = false, eventsMounted = false;
function mountMarkets() {
  if (marketsMounted) return; marketsMounted = true;
  const ms = state.sources.markets || [];
  const grid = $('#mk-cards'); grid.innerHTML = '';
  ms.forEach(m => {
    const card = document.createElement('div'); card.className = 'mk-card';
    card.innerHTML = `<div class="mk-name">${esc(m.name)}</div><div class="mk-body"></div>`;
    grid.appendChild(card);
    tvWidget($('.mk-body', card), 'embed-widget-mini-symbol-overview.js',
      { symbol: m.symbol, width: '100%', height: 190, locale: 'en', dateRange: '1D', colorTheme: 'dark', isTransparent: true, autosize: false, largeChartUrl: '' });
  });
  tvWidget($('#mk-chart'), 'embed-widget-symbol-overview.js', {
    symbols: ms.map(m => [m.name, m.symbol + '|1D']),
    chartOnly: false, width: '100%', height: 480, locale: 'en', colorTheme: 'dark', autosize: false,
    showVolume: false, hideDateRanges: false, scalePosition: 'right', scaleMode: 'Normal', fontSize: '12',
    noTimeScale: false, valuesTracking: '1', changeMode: 'price-and-percent', chartType: 'area', isTransparent: true,
    dateRanges: ['1d|1', '1w|30', '1m|30', '3m|60', '12m|1D'],
  });
}
function mountEvents() {
  if (eventsMounted) return; eventsMounted = true;
  tvWidget($('#mk-events'), 'embed-widget-events.js',
    { colorTheme: 'dark', isTransparent: true, width: '100%', height: 560, locale: 'en', importanceFilter: '0,1', countryFilter: 'us' });
}

/* ---------- HOME ---------- */
function renderHome() {
  // Live TV: my channels, then favorites picked from the public list
  const mine = state.sources.tv;
  const extra = state.favs.filter(f => !mine.some(c => c.url === f.url));
  const list = mine.concat(extra);
  renderCards($('#tv-cards'), list, ch => extra.includes(ch) ? { tag: 'fav', star: true } : { tag: ch.group || '' });
  $('#tv-meta').textContent = `${list.length} channels`;

  // Markets meta
  $('#mk-meta').textContent = (state.sources.markets || []).map(m => m.name.split(' ')[0]).join(' · ');

  // YouTube
  renderResume();
  renderYTHome();
}
function renderResume() {
  const r = state.resume, tile = $('#resume-tile');
  tile.hidden = !(r && r.id && state.cfg.ytList);
  if (tile.hidden) return;
  $('#resume-thumb').src = `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`;
  $('#resume-title').textContent = r.title || ytTitles[r.id] || 'YouTube video';
  $('#resume-sub').textContent = r.d ? `${mmss(r.t)} / ${mmss(r.d)} · ${mmss(r.d - r.t)} left` : `at ${mmss(r.t)}`;
}
$('#resume-tile').addEventListener('click', () => show('youtube', true, { resume: state.resume }));

/* ---------- LIVE TV: public US list ---------- */
async function renderTV() {
  const note = $('#tv-note'); note.hidden = true;
  const q = $('#tv-search').value;
  if (!state.publicUS) {
    $('#tv-grid').innerHTML = '<p class="muted">Loading the public US list…</p>';
    try {
      const r = await fetch(PUBLIC_US, { cache: 'no-store' });
      state.publicUS = parseM3U(await r.text()).filter(ch => !/geo-blocked|not 24\/7/i.test(ch.name));
    } catch (e) {
      $('#tv-grid').innerHTML = ''; note.textContent = 'Could not load the public list: ' + e.message; note.hidden = false; return;
    }
  }
  const extra = renderCards($('#tv-grid'), filterList(state.publicUS, q), ch => ({ tag: ch.group || '', star: true }));
  if (extra) { note.textContent = extra; note.hidden = false; }
}
$('#tv-search').addEventListener('input', renderTV);

/* ---------- YOUTUBE (IFrame API, plays inside the app, remembers position) ---------- */
let ytPlayer = null, ytApi = null, ytIds = store.get('yt_ids', []), ytTimer = null, ytPendingSeek = 0, ytPendingIndex = -1,
    ytTitles = store.get('yt_titles', {}), ytLoading = null;
function ytListId(v) { const m = String(v || '').match(/[?&]list=([A-Za-z0-9_-]+)/); return m ? m[1] : String(v || '').trim(); }
function loadYTApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise(res => {
    if (window.YT && YT.Player) return res();
    window.onYouTubeIframeAPIReady = () => res();
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  });
  return ytApi;
}
// Creates the (hidden) player once and cues the playlist, so the home page can list the videos.
function ensureYT() {
  const list = ytListId(state.cfg.ytList);
  if (!list) return Promise.resolve();
  if (ytLoading && ytPlayer && ytPlayer.__list === list) return ytLoading;
  ytLoading = (async () => {
    await loadYTApi();
    if (!ytPlayer) {
      await new Promise(res => {
        ytPlayer = new YT.Player('yt-player', {
          width: '100%', height: '100%',
          playerVars: { listType: 'playlist', list, rel: 0, playsinline: 1, modestbranding: 1, enablejsapi: 1, origin: location.origin },
          events: { onReady: () => res(), onStateChange: ytState, onError: () => {} },
        });
      });
    } else if (ytPlayer.__list !== list) {
      ytPlayer.cuePlaylist({ list, listType: 'playlist' });
    }
    ytPlayer.__list = list;
    let ids = [];
    for (let i = 0; i < 24 && !(ids = ytPlayer.getPlaylist() || []).length; i++) await new Promise(r => setTimeout(r, 250));
    if (ids.length) { ytIds = ids; store.set('yt_ids', ids); }
    renderYTHome(); renderYTList();
    fetchTitles(ytIds);
  })();
  return ytLoading;
}
function renderYTHome() {
  const list = ytListId(state.cfg.ytList);
  $('#yt-setup').hidden = !!list;
  const grid = $('#yt-cards'); grid.innerHTML = '';
  const links = $('#yt-links'); links.innerHTML = '';
  (state.sources.links || []).forEach(l => {
    const a = document.createElement('a'); a.className = 'btn ghost'; a.href = l.url; a.textContent = l.name + ' ↗'; links.appendChild(a);
  });
  if (!list) { $('#yt-meta').textContent = 'not set up'; return; }
  $('#yt-meta').textContent = ytIds.length ? `${ytIds.length} videos` : 'loading…';
  const r = state.resume || {};
  ytIds.forEach((id, i) => {
    const c = document.createElement('div');
    c.className = 'card video' + (id === r.id ? ' now' : '');
    c.setAttribute('role', 'button');
    const pct = id === r.id && r.d ? Math.round(100 * r.t / r.d) : 0;
    c.innerHTML = `<img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy">` +
      (pct ? `<span class="bar-progress"><i style="width:${pct}%"></i></span>` : '') +
      `<span class="name">${esc(ytTitles[id] || 'Video ' + (i + 1))}</span>`;
    c.addEventListener('click', () => show('youtube', true, id === r.id ? { resume: r } : { index: i }));
    grid.appendChild(c);
  });
}
async function openYouTube(opts = {}) {
  await ensureYT();
  if (!ytPlayer) { show('settings'); return; }
  if (opts.resume && opts.resume.id) {
    const idx = ytIds.indexOf(opts.resume.id);
    ytPendingSeek = opts.resume.t || 0;
    if (idx >= 0) ytPlayer.playVideoAt(idx); else ytPlayer.loadVideoById({ videoId: opts.resume.id, startSeconds: opts.resume.t || 0 });
  } else if (opts.index != null) {
    ytPendingSeek = 0; ytPlayer.playVideoAt(opts.index);
  }
  renderYTList();
  clearInterval(ytTimer); ytTimer = setInterval(ytSave, 5000);
}
function renderYTList() {
  const box = $('#yt-list'); box.innerHTML = '';
  const cur = ytPlayer && ytPlayer.getVideoData ? (ytPlayer.getVideoData() || {}).video_id : '';
  ytIds.forEach((id, i) => {
    const b = document.createElement('button');
    b.className = 'yt-item' + (id === cur ? ' active' : '');
    b.innerHTML = `<img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy"><span>${esc(ytTitles[id] || 'Video ' + (i + 1))}</span>`;
    b.addEventListener('click', () => { ytPendingSeek = 0; ytPlayer.playVideoAt(i); });
    box.appendChild(b);
  });
  if (!ytIds.length) box.innerHTML = '<p class="muted">No videos found. Is the playlist public or unlisted, and does the link contain list=?</p>';
}
async function fetchTitles(ids) {
  const missing = ids.filter(id => !ytTitles[id]).slice(0, 60);
  await Promise.all(missing.map(async id => {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`);
      if (r.ok) ytTitles[id] = (await r.json()).title;
    } catch {}
  }));
  if (missing.length) { store.set('yt_titles', ytTitles); renderYTHome(); renderYTList(); renderResume(); }
}
function ytState(e) {
  const s = e.data;
  if (s === YT.PlayerState.PLAYING) {
    if (ytPendingSeek > 3) { ytPlayer.seekTo(ytPendingSeek, true); ytPendingSeek = 0; }
    const d = ytPlayer.getVideoData() || {};
    if (d.title && d.video_id) { ytTitles[d.video_id] = d.title; store.set('yt_titles', ytTitles); }
    $('#yt-title').textContent = d.title || 'YouTube';
    renderYTList();
  }
  if (s === YT.PlayerState.PAUSED) ytSave();
  if (s === YT.PlayerState.ENDED) { state.resume = null; store.del('yt_resume'); }
}
function ytSave() {
  if (!ytPlayer || !ytPlayer.getPlayerState) return;
  const st = ytPlayer.getPlayerState();
  if (st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.PAUSED) return;
  const d = ytPlayer.getVideoData() || {}; if (!d.video_id) return;
  const t = ytPlayer.getCurrentTime() || 0, dur = ytPlayer.getDuration() || 0;
  if (dur && dur - t < 20) { state.resume = null; store.del('yt_resume'); return; }
  state.resume = { id: d.video_id, title: d.title || ytTitles[d.video_id] || '', t, d: dur, when: Date.now() };
  store.set('yt_resume', state.resume);
}
function ytLeave() { ytSave(); clearInterval(ytTimer); try { ytPlayer && ytPlayer.pauseVideo(); } catch {} }
$('#yt-fs').addEventListener('click', () => {
  const box = $('.yt-player-box'); const iframe = box.querySelector('iframe');
  try { (iframe && iframe.requestFullscreen ? iframe : box).requestFullscreen().catch(() => toggleMax()); } catch { toggleMax(); }
});

/* ---------- LIVE PLAYER ---------- */
const video = $('#video');
let overlayTimer = null;
function showOverlay() {
  $('#overlay').classList.remove('hide');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => { if (!video.paused) $('#overlay').classList.add('hide'); }, 4000);
}
function msg(html) { const m = $('#player-msg'); if (!html) { m.hidden = true; return; } m.innerHTML = html; m.hidden = false; showOverlay(); }

function play(ch, queue) {
  state.queue = queue || [ch];
  state.qi = Math.max(0, state.queue.indexOf(ch));
  show('player');
  startStream(ch);
  try { const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch {}
}
function startStream(ch) {
  stopHls();
  $('#player-title').textContent = ch.name;
  $('#player-fav').innerHTML = isFav(ch) ? '&#9733;' : '&#9734;';
  msg('');
  showOverlay();
  if (mixedContent(ch.url)) {
    msg(`<div>This channel uses plain http and the page is https, so the browser blocks it.</div>
         <button class="btn" id="msg-next">Next channel</button>`);
    $('#msg-next').onclick = () => step(1);
    return;
  }
  const isHls = /\.m3u8(\?|$)/i.test(ch.url) || /\/live\//i.test(ch.url);
  if (isHls && window.Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
    state.hls = hls;
    hls.loadSource(ch.url);
    hls.attachMedia(video);
    let netRetries = 0, mediaRetries = 0, softErrors = 0;
    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    hls.on(Hls.Events.FRAG_LOADED, () => { softErrors = 0; });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) {
        if (++softErrors >= 6) failed(ch, data.details + (data.response ? ' ' + data.response.code : ''));
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries++ < 2) { setTimeout(() => hls.startLoad(), 800); return; }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 2) { hls.recoverMediaError(); return; }
      failed(ch, data.details + (data.response ? ' ' + data.response.code : ''));
    });
  } else {
    video.src = ch.url;
    video.play().catch(() => {});
  }
}
function failed(ch, why) {
  stopHls();
  msg(`<div>Stream failed: ${esc(ch.name)}</div>
       <div class="muted small">${esc(why || '')}. Usually the source is down, geo-blocked, or blocks browsers.</div>
       <button class="btn" id="msg-retry">Retry</button><button class="btn primary" id="msg-next">Next channel</button>`);
  $('#msg-retry').onclick = () => startStream(ch);
  $('#msg-next').onclick = () => step(1);
}
video.addEventListener('error', () => { if (!state.hls) failed(state.queue[state.qi], 'Browser could not play this format'); });
function step(d) {
  if (!state.queue.length) return;
  state.qi = (state.qi + d + state.queue.length) % state.queue.length;
  startStream(state.queue[state.qi]);
}
function stopHls() { if (state.hls) { try { state.hls.destroy(); } catch {} state.hls = null; } video.removeAttribute('src'); try { video.load(); } catch {} }
function stopPlayer() {
  stopHls();
  if (document.fullscreenElement) { try { document.exitFullscreen().catch(() => {}); } catch {} }
}
$('#player-back').addEventListener('click', () => history.back());
$('#player-prev').addEventListener('click', () => step(-1));
$('#player-next').addEventListener('click', () => step(1));
$('#player-fav').addEventListener('click', () => { const ch = state.queue[state.qi]; toggleFav(ch); $('#player-fav').innerHTML = isFav(ch) ? '&#9733;' : '&#9734;'; });
$('#view-player').addEventListener('click', e => { if (!e.target.closest('.btn')) showOverlay(); });
video.addEventListener('pause', showOverlay);

/* ---------- SETTINGS ---------- */
function status(text, ok) { const s = $('#s-status'); s.textContent = text; s.className = 'note' + (ok ? ' ok' : ''); s.hidden = !text; }
function carLink() { const id = ytListId(state.cfg.ytList); return location.origin + location.pathname + (id ? '#yt=' + id : ''); }
function renderSettings() {
  $('#s-ytlist').value = state.cfg.ytList || '';
  $('#s-carlink').value = carLink();
  $('#s-version').textContent = `Garage TV ${VERSION}`;
  status('');
}
$('#s-save').addEventListener('click', () => {
  const id = ytListId($('#s-ytlist').value);
  state.cfg = { ...state.cfg, ytList: id };
  store.set('cfg', state.cfg);
  ytIds = []; store.del('yt_ids');
  $('#s-carlink').value = carLink();
  history.replaceState(history.state, '', carLink());
  status(id ? 'Saved. The playlist is on the home page.' : 'Saved (no playlist).', true);
  state.open.yt = true; store.set('ui_open', state.open);
});
$('#s-clear').addEventListener('click', () => {
  if (!confirm('Clear the playlist link, favorites, resume point and section layout saved in this browser?')) return;
  ['cfg', 'favs', 'yt_resume', 'yt_titles', 'yt_ids', 'ui_open'].forEach(store.del);
  state.cfg = {}; state.favs = []; state.resume = null; state.open = {}; ytTitles = {}; ytIds = [];
  history.replaceState(history.state, '', location.pathname);
  renderSettings(); status('Cleared.', true);
});

/* ---------- boot ---------- */
async function boot() {
  try { const r = await fetch('sources.json', { cache: 'no-store' }); state.sources = await r.json(); } catch {}
  // Playlist can come from the car link (#yt=...), else from what was saved here, else from sources.json.
  const fromHash = (location.hash.match(/[#&]yt=([A-Za-z0-9_-]+)/) || [])[1];
  const fromSources = ytListId((state.sources.youtube || {}).playlist);
  const id = fromHash || state.cfg.ytList || fromSources;
  if (id && id !== state.cfg.ytList) { state.cfg = { ...state.cfg, ytList: id }; store.set('cfg', state.cfg); ytIds = []; }
  history.replaceState({ view: 'home' }, '', location.href);
  renderHome();
  applySections();
  if (state.cfg.ytList && (state.resume || !ytIds.length)) ensureYT();
}
boot();
})();
