/* Garage TV — personal media page for the Tesla browser.
   One file: views, tile grids, HLS player, M3U/Xtream playlist, favorites, markets widgets,
   embedded YouTube car playlist with resume, maximize, and the encrypted car bookmark.
   No build step. Everything private lives in this browser or in the #k= bookmark key. */

(() => {
'use strict';

const VERSION = '1.1.0';
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
  sources: { tv: [], links: [], markets: [] },
  cfg: store.get('cfg', {}),            // { m3u, xhost, xuser, xpass, ytList }
  playlist: store.get('playlist', []),  // [{name,url,group,logo}]
  favs: store.get('favs', []),
  resume: store.get('yt_resume', null), // { id, title, t, d, when }
  publicUS: null,
  tvTab: 'mine',
  plGroup: '',
  queue: [], qi: 0,
  hls: null,
  marketsMounted: false,
};

/* ---------- views ---------- */
const views = ['home', 'markets', 'tv', 'playlist', 'youtube', 'player', 'settings'];
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
  if (name === 'markets') renderMarkets();
  if (name === 'tv') renderTV();
  if (name === 'playlist') renderPlaylist();
  if (name === 'youtube') renderYouTube(opts.resume);
  if (name === 'settings') renderSettings();
}
window.addEventListener('popstate', e => show((e.state && e.state.view) || 'home', false));
document.addEventListener('click', e => {
  const b = e.target.closest('[data-go]');
  if (b) { e.preventDefault(); show(b.dataset.go); return; }
  if (e.target.closest('[data-max]')) toggleMax();
});

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

function tile(ch) {
  const el = document.createElement('div');
  el.className = 'tile' + (mixedContent(ch.url) ? ' warn' : '');
  el.setAttribute('role', 'button');
  el.innerHTML =
    `<button class="fav ${isFav(ch) ? 'on' : ''}" aria-label="favorite">${isFav(ch) ? '&#9733;' : '&#9734;'}</button>` +
    (ch.logo ? `<img class="logo" src="${esc(ch.logo)}" alt="" loading="lazy" onerror="this.remove()">` : '') +
    `<span class="tile-name">${esc(ch.name)}</span>` +
    `<span class="tile-sub">${esc(ch.group || '')}</span>`;
  el.addEventListener('click', e => {
    if (e.target.closest('.fav')) { toggleFav(ch); e.target.closest('.fav').outerHTML =
      `<button class="fav ${isFav(ch) ? 'on' : ''}">${isFav(ch) ? '&#9733;' : '&#9734;'}</button>`; return; }
    play(ch, el.__queue || [ch]);
  });
  return el;
}
function renderTiles(grid, list, max = 400) {
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  list.slice(0, max).forEach(ch => { const t = tile(ch); t.__queue = list; frag.appendChild(t); });
  grid.appendChild(frag);
  return list.length > max ? `Showing first ${max} of ${list.length}. Use search to narrow it down.` : '';
}
function filterList(list, q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(ch => (ch.name + ' ' + (ch.group || '')).toLowerCase().includes(q));
}

/* ---------- M3U ---------- */
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
      meta = { name, group: attrs['group-title'] || '', logo: attrs['tvg-logo'] || '' };
    } else if (line.startsWith('#')) {
      continue;
    } else if (meta) {
      out.push({ ...meta, url: line });
      meta = null;
    }
  }
  return out;
}
function playlistURL(cfg) {
  if (cfg.m3u) return cfg.m3u.trim();
  if (cfg.xhost && cfg.xuser) {
    const host = cfg.xhost.trim().replace(/\/+$/, '');
    return `${host}/get.php?username=${encodeURIComponent(cfg.xuser)}&password=${encodeURIComponent(cfg.xpass || '')}&type=m3u_plus&output=m3u8`;
  }
  return '';
}
async function fetchPlaylist(cfg) {
  const url = playlistURL(cfg);
  if (!url) throw new Error('No playlist link or Xtream login set.');
  const r = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!r.ok) throw new Error(`Provider answered ${r.status}.`);
  const list = parseM3U(await r.text());
  if (!list.length) throw new Error('The file had no channels in it.');
  return list;
}

/* ---------- TradingView widgets (free embeds, no key) ---------- */
function tvWidget(container, script, cfg) {
  container.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
  const s = document.createElement('script');
  s.src = 'https://s3.tradingview.com/external-embedding/' + script;
  s.async = true;
  s.textContent = JSON.stringify(cfg);
  container.firstChild.appendChild(s);
}
function mountHomeMarkets() {
  const grid = $('#home-markets'); if (grid.dataset.done) return;
  grid.dataset.done = '1';
  (state.sources.markets || []).forEach(m => {
    const card = document.createElement('div'); card.className = 'mk-card';
    card.innerHTML = `<div class="mk-name">${esc(m.name)}</div><div class="mk-body"></div>`;
    grid.appendChild(card);
    tvWidget($('.mk-body', card), 'embed-widget-mini-symbol-overview.js',
      { symbol: m.symbol, width: '100%', height: 200, locale: 'en', dateRange: '1D', colorTheme: 'dark', isTransparent: true, autosize: false, largeChartUrl: '' });
  });
}
function renderMarkets() {
  if (state.marketsMounted) return;
  state.marketsMounted = true;
  const ms = state.sources.markets || [];
  tvWidget($('#mk-chart'), 'embed-widget-symbol-overview.js', {
    symbols: ms.map(m => [m.name, m.symbol + '|1D']),
    chartOnly: false, width: '100%', height: 460, locale: 'en', colorTheme: 'dark', autosize: false,
    showVolume: false, hideDateRanges: false, scalePosition: 'right', scaleMode: 'Normal', fontSize: '12',
    noTimeScale: false, valuesTracking: '1', changeMode: 'price-and-percent', chartType: 'area', isTransparent: true,
    dateRanges: ['1d|1', '1w|30', '1m|30', '3m|60', '12m|1D'],
  });
  const info = $('#mk-info'); info.innerHTML = '';
  ms.forEach(m => {
    const box = document.createElement('div'); box.className = 'widget-box'; info.appendChild(box);
    tvWidget(box, 'embed-widget-symbol-info.js', { symbol: m.symbol, width: '100%', locale: 'en', colorTheme: 'dark', isTransparent: true });
  });
  tvWidget($('#mk-events'), 'embed-widget-events.js',
    { colorTheme: 'dark', isTransparent: true, width: '100%', height: 620, locale: 'en', importanceFilter: '0,1', countryFilter: 'us' });
}

/* ---------- HOME ---------- */
function renderHome() {
  $('#home-playlist-sub').textContent = state.playlist.length ? `${state.playlist.length} channels` : 'Not set up';
  $('#home-tv-sub').textContent = `${state.sources.tv.length} channels + public US list`;
  const links = $('#home-links'); links.innerHTML = '';
  const yt = document.createElement('button');
  yt.className = 'tile link'; yt.dataset.go = 'youtube';
  yt.innerHTML = `<span class="tile-name">Car playlist</span><span class="tile-sub">${state.cfg.ytList ? 'YouTube, remembers position' : 'Set up in Settings'}</span>`;
  links.appendChild(yt);
  (state.sources.links || []).forEach(l => {
    const a = document.createElement('a');
    a.className = 'tile link'; a.href = l.url;
    a.innerHTML = `<span class="tile-name">${esc(l.name)}</span>`;
    links.appendChild(a);
  });
  const r = state.resume;
  $('#resume-wrap').hidden = !(r && r.id);
  if (r && r.id) {
    $('#resume-thumb').src = `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`;
    $('#resume-title').textContent = r.title || 'YouTube video';
    $('#resume-sub').textContent = r.d ? `Resume at ${mmss(r.t)} · ${mmss(r.d - r.t)} left` : `Resume at ${mmss(r.t)}`;
  }
  mountHomeMarkets();
  $('#fav-title').hidden = !state.favs.length;
  renderTiles($('#fav-grid'), state.favs);
}
$('#resume-tile').addEventListener('click', () => show('youtube', true, { resume: state.resume }));

/* ---------- LIVE TV ---------- */
async function renderTV() {
  const note = $('#tv-note'); note.hidden = true;
  const q = $('#tv-search').value;
  $$('#tv-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tvtab === state.tvTab));
  if (state.tvTab === 'mine') {
    const extra = renderTiles($('#tv-grid'), filterList(state.sources.tv, q));
    if (extra) { note.textContent = extra; note.hidden = false; }
    return;
  }
  if (!state.publicUS) {
    $('#tv-grid').innerHTML = '<p class="muted">Loading the public US list…</p>';
    try {
      const r = await fetch(PUBLIC_US, { cache: 'no-store' });
      state.publicUS = parseM3U(await r.text()).filter(ch => !/geo-blocked|not 24\/7/i.test(ch.name));
    } catch (e) {
      $('#tv-grid').innerHTML = ''; note.textContent = 'Could not load the public list: ' + e.message; note.hidden = false; return;
    }
  }
  const extra = renderTiles($('#tv-grid'), filterList(state.publicUS, q));
  if (extra) { note.textContent = extra; note.hidden = false; }
}
$('#tv-search').addEventListener('input', renderTV);
$('#tv-tabs').addEventListener('click', e => { const t = e.target.closest('.tab'); if (t) { state.tvTab = t.dataset.tvtab; renderTV(); } });

/* ---------- MY PLAYLIST ---------- */
function renderPlaylist() {
  const empty = !state.playlist.length;
  $('#pl-empty').hidden = !empty;
  $('#pl-groups').hidden = empty; $('#pl-grid').hidden = empty; $('#pl-note').hidden = true;
  if (empty) return;
  const groups = new Map();
  state.playlist.forEach(ch => groups.set(ch.group || 'Other', (groups.get(ch.group || 'Other') || 0) + 1));
  const chips = $('#pl-groups'); chips.innerHTML = '';
  const mk = (name, count, label) => {
    const b = document.createElement('button');
    b.className = 'chip' + ((state.plGroup === name) ? ' active' : '');
    b.innerHTML = `${esc(label || name)}<small>${count}</small>`;
    b.addEventListener('click', () => { state.plGroup = name; renderPlaylist(); });
    return b;
  };
  chips.appendChild(mk('', state.playlist.length, 'All'));
  [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([g, n]) => chips.appendChild(mk(g, n)));
  let list = state.plGroup ? state.playlist.filter(ch => (ch.group || 'Other') === state.plGroup) : state.playlist;
  list = filterList(list, $('#pl-search').value);
  const extra = renderTiles($('#pl-grid'), list);
  if (extra) { $('#pl-note').textContent = extra; $('#pl-note').hidden = false; }
}
$('#pl-search').addEventListener('input', renderPlaylist);
$('#pl-refresh').addEventListener('click', async () => {
  const note = $('#pl-note');
  note.textContent = 'Loading…'; note.hidden = false;
  try {
    state.playlist = await fetchPlaylist(state.cfg);
    store.set('playlist', state.playlist);
    renderPlaylist();
    note.textContent = `Loaded ${state.playlist.length} channels.`; note.hidden = false;
  } catch (e) {
    note.textContent = 'Could not load: ' + e.message + ' If this keeps happening, your provider blocks browser access; import the .m3u file in Settings on a PC instead.';
    note.hidden = false;
  }
});

/* ---------- YOUTUBE car playlist (IFrame API, remembers position) ---------- */
let ytPlayer = null, ytReady = null, ytIds = [], ytTimer = null, ytPendingSeek = 0, ytTitles = store.get('yt_titles', {});
function ytListId(v) { const m = String(v || '').match(/[?&]list=([A-Za-z0-9_-]+)/); return m ? m[1] : String(v || '').trim(); }
function loadYTApi() {
  if (ytReady) return ytReady;
  ytReady = new Promise(res => {
    if (window.YT && YT.Player) return res();
    window.onYouTubeIframeAPIReady = () => res();
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  });
  return ytReady;
}
async function renderYouTube(resume) {
  const list = ytListId(state.cfg.ytList);
  $('#yt-empty').hidden = !!list; $('#yt-wrap').hidden = !list;
  if (!list) return;
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
  // the playlist ids arrive a moment after cueing
  for (let i = 0; i < 20 && !(ytIds = ytPlayer.getPlaylist() || []).length; i++) await new Promise(r => setTimeout(r, 250));
  renderYTList();
  fetchTitles(ytIds);
  if (resume && resume.id) {
    const idx = ytIds.indexOf(resume.id);
    ytPendingSeek = resume.t || 0;
    if (idx >= 0) ytPlayer.playVideoAt(idx); else ytPlayer.loadVideoById({ videoId: resume.id, startSeconds: resume.t || 0 });
  }
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
  if (missing.length) { store.set('yt_titles', ytTitles); renderYTList(); }
}
function ytState(e) {
  const s = e.data;
  if (s === YT.PlayerState.PLAYING) {
    if (ytPendingSeek > 3) { ytPlayer.seekTo(ytPendingSeek, true); ytPendingSeek = 0; }
    const d = ytPlayer.getVideoData() || {};
    if (d.title && d.video_id) { ytTitles[d.video_id] = d.title; store.set('yt_titles', ytTitles); }
    $('#yt-title').textContent = d.title || 'YouTube car playlist';
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
    msg(`<div>This channel uses plain http and the page is https, so the car browser will block it.</div>
         <div class="muted small">Ask your provider for an https link, or use the http version of this page on home Wi-Fi.</div>
         <button class="btn" id="msg-next">Next channel</button>`);
    $('#msg-next').onclick = () => step(1);
    return;
  }
  const isHls = /\.m3u8(\?|$)/i.test(ch.url) || /\/get\.php|\/live\//i.test(ch.url);
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
function readForm() {
  return { ytList: ytListId($('#s-ytlist').value), m3u: $('#s-m3u').value.trim(), xhost: $('#s-xhost').value.trim(), xuser: $('#s-xuser').value.trim(), xpass: $('#s-xpass').value };
}
function renderSettings() {
  $('#s-ytlist').value = state.cfg.ytList || '';
  $('#s-m3u').value = state.cfg.m3u || '';
  $('#s-xhost').value = state.cfg.xhost || '';
  $('#s-xuser').value = state.cfg.xuser || '';
  $('#s-xpass').value = state.cfg.xpass || '';
  $('#s-version').textContent = `Garage TV ${VERSION} · ${state.playlist.length} playlist channels saved on this device` + (keyFromHash() ? ' · car bookmark key present' : '');
  status('');
}
$('#s-save').addEventListener('click', () => {
  state.cfg = { ...state.cfg, ...readForm() };
  store.set('cfg', state.cfg);
  status('Saved on this device.', true);
});
$('#s-load').addEventListener('click', async () => {
  state.cfg = { ...state.cfg, ...readForm() }; store.set('cfg', state.cfg);
  status('Loading…');
  try {
    state.playlist = await fetchPlaylist(state.cfg);
    store.set('playlist', state.playlist);
    status(`Loaded ${state.playlist.length} channels. Open My Playlist.`, true);
  } catch (e) {
    status('Could not load: ' + e.message + ' Your provider may block browser access (CORS). Download the .m3u on your PC and import it below.');
  }
});
$('#s-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  const list = parseM3U(await f.text());
  if (!list.length) { status('That file had no channels in it.'); return; }
  state.playlist = list; store.set('playlist', list);
  status(`Imported ${list.length} channels from ${f.name}.`, true);
});
$('#s-clear').addEventListener('click', () => {
  if (!confirm('Clear playlist, logins, favorites, resume point and settings saved in this browser?')) return;
  ['cfg', 'playlist', 'favs', 'yt_resume', 'yt_titles'].forEach(store.del);
  state.cfg = {}; state.playlist = []; state.favs = []; state.resume = null; ytTitles = {};
  renderSettings(); status('Cleared.', true);
});

/* ---------- car bookmark: AES-GCM with the key in the URL fragment ---------- */
const b64u = {
  enc: buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
                return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
};
function keyFromHash() { const m = location.hash.match(/[#&]k=([A-Za-z0-9_-]{40,})/); return m ? m[1] : ''; }
async function importKey(raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function encryptConfig(obj, rawKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(rawKey);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, iv: b64u.enc(iv), data: b64u.enc(ct) });
}
async function decryptConfig(text, rawKey) {
  const o = JSON.parse(text);
  const key = await importKey(rawKey);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(o.iv) }, key, b64u.dec(o.data));
  return JSON.parse(new TextDecoder().decode(pt));
}
$('#s-makekey').addEventListener('click', async () => {
 try {
  state.cfg = { ...state.cfg, ...readForm() }; store.set('cfg', state.cfg);
  let k = keyFromHash();
  const raw = k ? b64u.dec(k) : crypto.getRandomValues(new Uint8Array(32));
  k = b64u.enc(raw);
  const payload = { cfg: state.cfg, channels: state.playlist, favs: state.favs, made: new Date().toISOString() };
  const enc = await encryptConfig(payload, raw);
  const url = location.origin + location.pathname + '#k=' + k;
  $('#s-bookmark').value = url; $('#s-bookmark-wrap').hidden = false;
  $('#s-enc').value = enc; $('#s-enc-wrap').hidden = false;
  const dl = $('#s-download'); dl.hidden = false;
  dl.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([enc], { type: 'application/json' })); a.download = 'config.enc'; a.click(); };
  history.replaceState(history.state, '', url);
  status('Bookmark made. Put config.enc in the site folder and publish, then open the bookmark in the car.', true);
 } catch (e) { status('Could not make the bookmark: ' + e.message + ' (this needs https or localhost)'); }
});
async function loadFromBookmark() {
  const k = keyFromHash(); if (!k) return false;
  try {
    const r = await fetch('config.enc', { cache: 'no-store' }); if (!r.ok) return false;
    const o = await decryptConfig(await r.text(), b64u.dec(k));
    if (o.cfg) { state.cfg = { ...o.cfg, ...state.cfg, ...Object.fromEntries(Object.entries(o.cfg).filter(([, v]) => v)) }; store.set('cfg', state.cfg); }
    if (o.channels && o.channels.length && !state.playlist.length) { state.playlist = o.channels; store.set('playlist', o.channels); }
    if (o.favs && o.favs.length && !state.favs.length) { state.favs = o.favs; store.set('favs', o.favs); }
    return true;
  } catch { return false; }
}

/* ---------- boot ---------- */
async function boot() {
  try { const r = await fetch('sources.json', { cache: 'no-store' }); state.sources = await r.json(); } catch {}
  await loadFromBookmark();
  if (!state.playlist.length && playlistURL(state.cfg)) {
    fetchPlaylist(state.cfg).then(list => { state.playlist = list; store.set('playlist', list); if (current === 'home') renderHome(); }).catch(() => {});
  }
  history.replaceState({ view: 'home' }, '', location.href);
  renderHome();
}
boot();
})();
