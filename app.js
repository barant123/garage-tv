/* Garage TV — personal media page for the Tesla browser.
   One home page with collapsible sections that remember their state and their own preferences:
     Live TV   local news (by location) + hand-picked channels + the public US index
     YouTube   search, trending, categories, followed channels, playlist, history (YouTube Data API key)
     Sports    ESPN scoreboards with favorite teams pinned on top
     Markets   TradingView cards/chart with editable tickers + US economic calendar (data/calendar.json)
     Side      Weather radar + conditions (NEXRAD via Iowa State Mesonet, Open-Meteo) and live traffic around the car
               (Waze jams, plus police/crashes/hazards through the optional relay in tools/waze-relay.js)
   No build step, no accounts. Preferences live in this browser and in the car link (#p=...). */

(() => {
'use strict';

const VERSION = '4.0.4';
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
const PREF_DEFAULTS = { ytKey: '', ytList: '', follows: [], tickers: null, teams: [], loc: null, relay: '' };
const UI_DEFAULTS = { open: {}, tvTab: 'local', ytTab: 'trending', spTab: 'favs', calOpen: false };
const prefs = { ...PREF_DEFAULTS, ...store.get('prefs', {}) };
const ui = { ...UI_DEFAULTS, ...store.get('ui', {}) };
function savePrefs() { store.set('prefs', prefs); const l = $('#s-carlink'); if (l) l.value = carLink(); }
function saveUI() { store.set('ui', ui); }

const state = {
  sources: { tv: [], links: [], markets: [], youtube: {} },
  favs: store.get('favs', []),
  hist: store.get('yt_hist', []),          // [{id,title,thumb,channel,dur,t,d,when}]
  publicUS: null, locals: null, teams: null, calendar: null,
  queue: [], qi: 0, hls: null,
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
  if (name === 'tv') renderPublicTV();
  if (name === 'youtube') openYouTube(opts);
  if (name === 'settings') renderSettings();
}
window.addEventListener('popstate', e => show((e.state && e.state.view) || 'home', false));
document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); show(go.dataset.go); return; }
  if (e.target.closest('[data-max]')) { toggleMax(); return; }
  const quick = e.target.closest('[data-quick]');
  if (quick) { quickJump(quick); return; }
  const sub = e.target.closest('.sub-head');
  if (sub) { toggleSub(sub.parentElement); return; }
  const head = e.target.closest('.sec-head');
  if (head) toggleSection(head.parentElement);
});

/* ---------- collapsible sections (state remembered) ---------- */
function toggleSection(sec, force) {
  const key = sec.dataset.sec;
  const open = force == null ? !sec.classList.contains('open') : force;
  sec.classList.toggle('open', open);
  ui.open[key] = open; saveUI();
  if (open) onSectionOpen(key);
}
function onSectionOpen(key) {
  if (key === 'tv') renderTVTab();
  if (key === 'yt') renderYTTab();
  if (key === 'sp') renderSports();
  if (key === 'mk') { mountMarkets(); if (ui.calOpen) renderCalendar(); }
}
function quickJump(el) {
  const sec = el.closest('.sec'), [k, v] = el.dataset.quick.split(':');
  if (k === 'tvtab') { ui.tvTab = v; saveUI(); }
  if (k === 'yttab') { ui.ytTab = v; saveUI(); }
  if (k === 'lg') { ui.spTab = v; saveUI(); }
  toggleSection(sec, true);
  if (k === 'ytsearch') setTimeout(() => $('#yt-q').focus(), 350);
  if (k === 'cal') toggleSub($('.sub[data-sub=cal]'), true);
  setTimeout(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}
function toggleSub(sub, force) {
  const open = force == null ? !sub.classList.contains('open') : force;
  sub.classList.toggle('open', open);
  if (sub.dataset.sub === 'cal') { ui.calOpen = open; saveUI(); if (open) renderCalendar(); }
}
function applySections() {
  $$('.sec').forEach(sec => {
    const open = !!ui.open[sec.dataset.sec];
    sec.classList.toggle('open', open);
    if (open) onSectionOpen(sec.dataset.sec);
  });
  $('.sub[data-sub=cal]').classList.toggle('open', !!ui.calOpen);
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
function initials(name) { return String(name).split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase(); }
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago';
  if (s < 86400 * 365) return Math.round(s / 86400 / 30) + 'mo ago';
  return Math.round(s / 86400 / 365) + 'y ago';
}
function fmtNum(n) { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n); }
function parseDur(iso) { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; }
function pills(container, attr, value) { $$('.pill', container).forEach(p => p.classList.toggle('active', p.dataset[attr] === value)); }
async function getJSON(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
const b64u = {
  enc: s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))),
};

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
    if (star) { toggleFav(ch); star.classList.toggle('on', isFav(ch)); star.innerHTML = isFav(ch) ? '&#9733;' : '&#9734;'; if (current === 'home') renderTVTab(); return; }
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
function parseM3U(text) {
  const out = []; let meta = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      line.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v; return ''; });
      const name = line.slice(line.lastIndexOf(',') + 1).trim() || attrs['tvg-name'] || 'Channel';
      meta = { name, group: (attrs['group-title'] || '').split(';')[0], logo: attrs['tvg-logo'] || '' };
    } else if (line.startsWith('#')) continue;
    else if (meta) { out.push({ ...meta, url: line }); meta = null; }
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

/* ======================================================================
   HOME
   ====================================================================== */
function renderHome() {
  renderResume();
  $('#tv-meta').textContent = (prefs.loc ? locLabel(prefs.loc) + ' · ' : '') + `${state.sources.tv.length} channels`;
  $('#yt-meta').textContent = ytMetaText();
  $('#sp-meta').textContent = prefs.teams.length ? prefs.teams.map(t => t.abbr).join(' · ') : 'pick your teams';
  $('#mk-meta').textContent = tickers().map(m => m.name.split(' ')[0]).join(' · ');
  renderNextEvent();
  startSide();
  Object.values(maps).forEach(m => m && setTimeout(() => m.invalidateSize(), 60));
}
async function renderNextEvent() {
  const el = $('#mk-next'); if (!el) return;
  try {
    if (!state.calendar) state.calendar = await getJSON('data/calendar.json', { cache: 'no-store' });
    const now = Date.now(), todayKey = new Date().toDateString();
    const ev = (state.calendar.events || []).map(e => ({ ...e, ts: new Date(e.d).getTime() }))
      .filter(e => e.i === 'High' && e.ts > now - 30 * 60e3).sort((a, b) => a.ts - b.ts)[0];
    if (!ev) { el.textContent = ''; return; }
    const dt = new Date(ev.ts), today = dt.toDateString() === todayKey;
    el.textContent = (ev.t.length > 24 ? ev.t.slice(0, 23) + '…' : ev.t) + ' · ' +
      (today ? '' : dt.toLocaleDateString([], { weekday: 'short' }) + ' ') + dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { el.textContent = ''; }
}

/* ======================================================================
   LIVE TV: local news, my channels, public list
   ====================================================================== */
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'Washington DC', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico' };
function locLabel(loc) { return loc ? (loc.city ? loc.city + ', ' : '') + loc.state : ''; }

function renderTVTab() {
  pills($('#tv-pills'), 'tvtab', ui.tvTab);
  $('#tv-local').hidden = ui.tvTab !== 'local';
  $('#tv-mine').hidden = ui.tvTab !== 'mine';
  if (ui.tvTab === 'mine') {
    const mine = state.sources.tv;
    const extra = state.favs.filter(f => !mine.some(c => c.url === f.url));
    const list = mine.concat(extra);
    renderCards($('#tv-cards'), list, ch => extra.includes(ch) ? { tag: 'fav', star: true } : { tag: ch.group || '' });
  } else renderLocal();
}
$('#tv-pills').addEventListener('click', e => { const p = e.target.closest('[data-tvtab]'); if (p) { ui.tvTab = p.dataset.tvtab; saveUI(); renderTVTab(); } });

async function loadLocals() {
  if (state.locals) return state.locals;
  const d = await getJSON('data/locals.json', { cache: 'no-store' });
  state.locals = d.stations || [];
  return state.locals;
}
async function detectLocation() {
  const cached = store.get('loc_auto', null);
  if (cached && Date.now() - cached.at < 12 * 3600e3) return cached.loc;
  const d = await getJSON('https://ipapi.co/json/');
  if (d.country_code !== 'US') throw new Error('Outside the US (' + d.country_name + ')');
  const loc = { state: d.region_code, city: d.city, auto: true, lat: d.latitude, lon: d.longitude };
  store.set('loc_auto', { at: Date.now(), loc });
  return loc;
}
async function renderLocal() {
  const hint = $('#local-hint'), grid = $('#local-cards');
  try {
    if (!prefs.loc) {
      hint.textContent = 'Finding your location…';
      prefs.loc = await detectLocation(); savePrefs();
    }
    hint.textContent = 'Loading local stations…';
    const all = await loadLocals();
    const loc = prefs.loc;
    const inState = all.filter(s => s.states.includes(loc.state));
    const score = s => (loc.city && s.cities.includes(loc.city) ? 0 : 2) + (s.cat.some(c => c === 'news' || c === 'general') ? 0 : 1);
    const list = inState.slice().sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
      .map(s => ({ name: s.name, url: s.url, logo: s.logo, group: s.cities[0] || STATES[loc.state] || loc.state, cat: s.cat }));
    renderCards(grid, list, ch => ({ tag: ch.group, star: true }));
    hint.textContent = list.length
      ? `${locLabel(loc)} · ${list.length} stations ${loc.auto ? '(location from your connection)' : ''} · from the public iptv-org index, so coverage varies by city`
      : `No stations listed for ${locLabel(loc)} in the public index. Try another city or state with "Change location".`;
    $('#tv-meta').textContent = `${locLabel(loc)} · ${state.sources.tv.length} channels`;
  } catch (e) {
    hint.textContent = 'Could not load local stations: ' + e.message + '. Use "Change location" to pick a state.';
    grid.innerHTML = '';
  }
}
$('#tv-edit-btn').addEventListener('click', async () => {
  const box = $('#tv-edit'); box.hidden = !box.hidden;
  if (box.hidden) return;
  await loadLocals();
  const counts = {};
  state.locals.forEach(s => s.states.forEach(st => { counts[st] = (counts[st] || 0) + 1; }));
  const sel = $('#loc-state'); sel.innerHTML = Object.keys(STATES).filter(k => counts[k]).sort((a, b) => STATES[a].localeCompare(STATES[b]))
    .map(k => `<option value="${k}">${STATES[k]} (${counts[k]})</option>`).join('');
  sel.value = (prefs.loc && prefs.loc.state) || 'AZ';
  fillCities(); if (prefs.loc && prefs.loc.city) $('#loc-city').value = prefs.loc.city;
  $('#loc-note').textContent = 'Pick a state, then a city to put that city’s stations first. "Detect" uses your connection’s location.';
});
function fillCities() {
  const st = $('#loc-state').value;
  const cities = new Set(); state.locals.forEach(s => { if (s.states.includes(st)) s.cities.forEach(c => cities.add(c)); });
  $('#loc-city').innerHTML = '<option value="">Whole state</option>' + [...cities].sort().map(c => `<option>${esc(c)}</option>`).join('');
}
$('#loc-state').addEventListener('change', fillCities);
$('#loc-detect').addEventListener('click', async () => {
  try { store.del('loc_auto'); const loc = await detectLocation(); $('#loc-state').value = loc.state; fillCities(); $('#loc-city').value = loc.city; $('#loc-note').textContent = 'Detected ' + locLabel(loc) + '. Press "Use this" to keep it.'; }
  catch (e) { $('#loc-note').textContent = 'Could not detect: ' + e.message; }
});
$('#loc-save').addEventListener('click', () => {
  prefs.loc = { state: $('#loc-state').value, city: $('#loc-city').value, auto: false }; savePrefs();
  $('#tv-edit').hidden = true; renderLocal(); renderHome();
});

async function renderPublicTV() {
  const note = $('#tv-note'); note.hidden = true;
  const q = $('#tv-search').value;
  if (!state.publicUS) {
    $('#tv-grid').innerHTML = '<p class="muted">Loading the public US list…</p>';
    try {
      const r = await fetch(PUBLIC_US, { cache: 'no-store' });
      state.publicUS = parseM3U(await r.text()).filter(ch => !/geo-blocked|not 24\/7/i.test(ch.name));
    } catch (e) { $('#tv-grid').innerHTML = ''; note.textContent = 'Could not load the public list: ' + e.message; note.hidden = false; return; }
  }
  const extra = renderCards($('#tv-grid'), filterList(state.publicUS, q), ch => ({ tag: ch.group || '', star: true }));
  if (extra) { note.textContent = extra; note.hidden = false; }
}
$('#tv-search').addEventListener('input', renderPublicTV);

/* ======================================================================
   YOUTUBE (Data API for browsing, IFrame API for playing inside the app)
   ====================================================================== */
const ytCache = {};
async function ytApi(path, params) {
  if (!prefs.ytKey) throw new Error('no key');
  const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  u.searchParams.set('key', prefs.ytKey);
  const r = await fetch(u);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const reason = d.error && d.error.errors && d.error.errors[0] && d.error.errors[0].reason; throw new Error(reason === 'quotaExceeded' ? 'Daily YouTube quota used up; resets at midnight Pacific.' : reason || ('HTTP ' + r.status)); }
  return d;
}
function vidFromItem(it) {
  const s = it.snippet || {}, th = s.thumbnails || {};
  return { id: it.id, title: s.title || '', channel: s.channelTitle || '', thumb: (th.medium || th.high || th.default || {}).url || `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`,
           dur: parseDur(it.contentDetails && it.contentDetails.duration), views: +(it.statistics && it.statistics.viewCount) || 0, published: s.publishedAt || '' };
}
async function videosByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await ytApi('videos', { part: 'snippet,contentDetails,statistics', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    (d.items || []).forEach(it => out.push(vidFromItem(it)));
  }
  return out;
}
async function ytTrending(cat) {
  const p = { part: 'snippet,contentDetails,statistics', chart: 'mostPopular', regionCode: 'US', maxResults: 30 };
  if (cat) p.videoCategoryId = cat;
  const d = await ytApi('videos', p);
  return (d.items || []).map(vidFromItem);
}
async function ytSearch(q) {
  const d = await ytApi('search', { part: 'snippet', type: 'video', q, maxResults: 24, safeSearch: 'none' });
  return videosByIds((d.items || []).map(it => it.id.videoId));
}
async function ytFollowsFeed() {
  const ids = [];
  await Promise.all(prefs.follows.map(async ch => {
    try { const d = await ytApi('playlistItems', { part: 'contentDetails', playlistId: 'UU' + ch.id.slice(2), maxResults: 6 }); (d.items || []).forEach(it => ids.push(it.contentDetails.videoId)); } catch {}
  }));
  const vids = await videosByIds(ids);
  return vids.sort((a, b) => (b.published > a.published ? 1 : -1));
}
function ytListId(v) { const m = String(v || '').match(/[?&]list=([A-Za-z0-9_-]+)/); return m ? m[1] : String(v || '').trim(); }
async function ytPlaylist() {
  const list = ytListId(prefs.ytList);
  if (!list) return [];
  if (prefs.ytKey) {
    const d = await ytApi('playlistItems', { part: 'contentDetails', playlistId: list, maxResults: 50 });
    return videosByIds((d.items || []).map(it => it.contentDetails.videoId));
  }
  // no key: let the embedded player read the playlist, titles via oEmbed
  await ensurePlayer();
  ytPlayer.cuePlaylist({ list, listType: 'playlist' });
  let ids = [];
  for (let i = 0; i < 24 && !(ids = ytPlayer.getPlaylist() || []).length; i++) await new Promise(r => setTimeout(r, 250));
  const titles = store.get('yt_titles', {});
  await Promise.all(ids.filter(id => !titles[id]).slice(0, 50).map(async id => {
    try { const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`); if (r.ok) titles[id] = (await r.json()).title; } catch {}
  }));
  store.set('yt_titles', titles);
  return ids.map(id => ({ id, title: titles[id] || 'Video', channel: '', thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, dur: 0, views: 0, published: '' }));
}

function ytMetaText() {
  if (!prefs.ytKey) return 'needs API key';
  const p = $(`#yt-pills [data-yttab="${ui.ytTab}"]`);
  const tab = ui.ytTab === 'search' ? 'search' : (p ? p.textContent.trim().toLowerCase() : 'trending');
  const n = prefs.follows.length;
  return tab + (n ? ` · ${n} channel${n === 1 ? '' : 's'} followed` : '');
}
async function renderYTTab(force) {
  pills($('#yt-pills'), 'yttab', ui.ytTab);
  $('#yt-meta').textContent = ytMetaText();
  const hint = $('#yt-hint'), grid = $('#yt-cards');
  const needsKey = !prefs.ytKey && !['history', 'playlist'].includes(ui.ytTab);
  $('#yt-setup').hidden = !needsKey;
  if (needsKey) { grid.innerHTML = ''; hint.textContent = ''; return; }
  const key = ui.ytTab + (ui.ytTab === 'search' ? ':' + ($('#yt-q').value || '') : '');
  const c = ytCache[key];
  if (c && !force && Date.now() - c.at < 15 * 60e3) { renderVideos(grid, c.list); hint.textContent = c.note || ''; return; }
  hint.textContent = 'Loading…'; grid.innerHTML = '';
  try {
    let list = [], note = '';
    if (ui.ytTab === 'trending') list = await ytTrending('');
    else if (ui.ytTab.startsWith('cat:')) list = await ytTrending(ui.ytTab.slice(4));
    else if (ui.ytTab === 'search') { const q = $('#yt-q').value.trim(); list = q ? await ytSearch(q) : []; note = q ? `Results for “${q}”` : 'Type something to search.'; }
    else if (ui.ytTab === 'follows') { list = prefs.follows.length ? await ytFollowsFeed() : []; note = prefs.follows.length ? 'Newest from the channels you follow' : 'Tap "My channels" to follow some channels.'; }
    else if (ui.ytTab === 'playlist') { list = await ytPlaylist(); note = list.length ? '' : (prefs.ytList ? 'Playlist is empty or private.' : 'Add a playlist link in Settings.'); }
    else if (ui.ytTab === 'history') { list = state.hist.slice(); note = list.length ? 'Most recent first' : 'Nothing watched yet.'; }
    ytCache[key] = { at: Date.now(), list, note };
    renderVideos(grid, list); hint.textContent = note;
  } catch (e) {
    hint.textContent = (e.message === 'no key' ? 'Add a YouTube API key in Settings.' : 'YouTube said: ' + e.message);
  }
}
function renderVideos(grid, list) {
  grid.innerHTML = '';
  const h = Object.fromEntries(state.hist.map(x => [x.id, x]));
  list.forEach(v => {
    const c = document.createElement('div'); c.className = 'card video'; c.setAttribute('role', 'button');
    const hv = h[v.id], pct = hv && hv.d ? Math.min(100, Math.round(100 * hv.t / hv.d)) : 0;
    const meta = [v.channel, v.views ? fmtNum(v.views) + ' views' : '', v.published ? ago(v.published) : ''].filter(Boolean).join(' · ');
    c.innerHTML = `<span class="thumb"><img src="${esc(v.thumb)}" alt="" loading="lazy">` +
      (v.dur ? `<span class="dur">${mmss(v.dur)}</span>` : '') +
      (pct ? `<span class="prog"><i style="width:${pct}%"></i></span>` : '') +
      `</span><span class="vt">${esc(v.title)}</span><span class="vm">${esc(meta)}</span>`;
    c.addEventListener('click', () => show('youtube', true, { video: v, list, t: hv && hv.d - hv.t > 20 ? hv.t : 0 }));
    grid.appendChild(c);
  });
  if (!list.length) grid.innerHTML = '';
}
$('#yt-pills').addEventListener('click', e => { const p = e.target.closest('[data-yttab]'); if (p) { ui.ytTab = p.dataset.yttab; saveUI(); renderYTTab(); } });
$('#yt-form').addEventListener('submit', e => { e.preventDefault(); ui.ytTab = 'search'; saveUI(); pills($('#yt-pills'), 'yttab', ''); renderYTTab(true); $('#yt-q').blur(); });

// followed channels editor
$('#yt-edit-btn').addEventListener('click', () => { const b = $('#yt-edit'); b.hidden = !b.hidden; if (!b.hidden) renderFollows(); });
function renderFollows() {
  const box = $('#yt-follows'); box.innerHTML = prefs.follows.length ? '' : '<span class="muted small">No channels followed yet.</span>';
  prefs.follows.forEach(ch => {
    const c = document.createElement('span'); c.className = 'chip';
    c.innerHTML = `${ch.thumb ? `<img src="${esc(ch.thumb)}" alt="">` : ''}${esc(ch.title)}<button class="x" title="Unfollow">&times;</button>`;
    $('.x', c).addEventListener('click', () => { prefs.follows = prefs.follows.filter(f => f.id !== ch.id); savePrefs(); delete ytCache.follows; renderFollows(); renderHome(); });
    box.appendChild(c);
  });
}
$('#yt-chfind').addEventListener('click', findChannels);
$('#yt-chq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findChannels(); } });
async function findChannels() {
  const q = $('#yt-chq').value.trim(), box = $('#yt-chresults');
  if (!q) return;
  box.innerHTML = '<span class="muted small">Searching…</span>';
  try {
    const d = await ytApi('search', { part: 'snippet', type: 'channel', q, maxResults: 8 });
    box.innerHTML = '';
    (d.items || []).forEach(it => {
      const ch = { id: it.snippet.channelId, title: it.snippet.channelTitle || it.snippet.title, thumb: (it.snippet.thumbnails.default || {}).url || '' };
      const c = document.createElement('button'); c.className = 'chip add';
      c.innerHTML = `${ch.thumb ? `<img src="${esc(ch.thumb)}" alt="">` : ''}+ ${esc(ch.title)}`;
      c.addEventListener('click', () => { if (!prefs.follows.some(f => f.id === ch.id)) { prefs.follows.push(ch); savePrefs(); delete ytCache.follows; renderFollows(); renderHome(); } c.remove(); });
      box.appendChild(c);
    });
    if (!box.children.length) box.innerHTML = '<span class="muted small">No channels found.</span>';
  } catch (e) { box.innerHTML = `<span class="muted small">${esc(e.message === 'no key' ? 'Add a YouTube API key in Settings first.' : e.message)}</span>`; }
}

/* ---- player (IFrame API) ---- */
let ytPlayer = null, ytApiReady = null, ytTimer = null, ytPendingSeek = 0, ytCurrent = null;
function loadYTApi() {
  if (ytApiReady) return ytApiReady;
  ytApiReady = new Promise(res => {
    if (window.YT && YT.Player) return res();
    window.onYouTubeIframeAPIReady = () => res();
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  });
  return ytApiReady;
}
async function ensurePlayer() {
  await loadYTApi();
  if (ytPlayer) return ytPlayer;
  await new Promise(res => {
    ytPlayer = new YT.Player('yt-player', {
      width: '100%', height: '100%',
      playerVars: { rel: 0, playsinline: 1, modestbranding: 1, enablejsapi: 1, origin: location.origin },
      events: { onReady: () => res(), onStateChange: ytState, onError: ytError },
    });
  });
  return ytPlayer;
}
async function openYouTube(opts = {}) {
  await ensurePlayer();
  if (opts.video) {
    state.queue = opts.list || [opts.video]; state.qi = Math.max(0, state.queue.findIndex(v => v.id === opts.video.id));
    ytCurrent = opts.video; ytPendingSeek = opts.t || 0;
    $('#yt-title').textContent = opts.video.title || 'YouTube';
    ytPlayer.loadVideoById({ videoId: opts.video.id, startSeconds: opts.t || 0 });
  }
  renderQueue();
  clearInterval(ytTimer); ytTimer = setInterval(ytSave, 5000);
}
function renderQueue() {
  const box = $('#yt-list'); box.innerHTML = '';
  state.queue.forEach((v, i) => {
    const b = document.createElement('button');
    b.className = 'yt-item' + (ytCurrent && v.id === ytCurrent.id ? ' active' : '');
    b.innerHTML = `<img src="${esc(v.thumb)}" alt="" loading="lazy"><span>${esc(v.title)}</span>`;
    b.addEventListener('click', () => { ytSave(); state.qi = i; ytCurrent = v; ytPendingSeek = 0; $('#yt-title').textContent = v.title; ytPlayer.loadVideoById(v.id); renderQueue(); });
    box.appendChild(b);
  });
}
function ytState(e) {
  const s = e.data;
  if (s === YT.PlayerState.PLAYING) {
    if (ytPendingSeek > 3) { ytPlayer.seekTo(ytPendingSeek, true); ytPendingSeek = 0; }
    const d = ytPlayer.getVideoData() || {};
    if (ytCurrent && d.title) { ytCurrent.title = d.title; $('#yt-title').textContent = d.title; }
    ytSave();
  }
  if (s === YT.PlayerState.PAUSED) ytSave();
  if (s === YT.PlayerState.ENDED) {
    markHist(ytCurrent, ytPlayer.getDuration() || 0, ytPlayer.getDuration() || 0);
    if (state.queue.length > 1) { state.qi = (state.qi + 1) % state.queue.length; const v = state.queue[state.qi]; ytCurrent = v; $('#yt-title').textContent = v.title; ytPlayer.loadVideoById(v.id); renderQueue(); }
  }
}
function ytError(e) {
  // 101/150: owner disallows embedding
  if (ytCurrent && (e.data === 101 || e.data === 150)) {
    $('#yt-title').innerHTML = `${esc(ytCurrent.title)} <a class="btn ghost small-btn" href="https://www.youtube.com/watch?v=${esc(ytCurrent.id)}">not embeddable, open on youtube.com &#8599;</a>`;
  }
}
function markHist(v, t, d) {
  if (!v) return;
  state.hist = state.hist.filter(x => x.id !== v.id);
  state.hist.unshift({ id: v.id, title: v.title, thumb: v.thumb, channel: v.channel, dur: v.dur || d, t, d, when: Date.now() });
  state.hist = state.hist.slice(0, 40);
  store.set('yt_hist', state.hist);
  delete ytCache.history;
}
function ytSave() {
  if (!ytPlayer || !ytPlayer.getPlayerState || !ytCurrent) return;
  const st = ytPlayer.getPlayerState();
  if (st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.PAUSED) return;
  const d = ytPlayer.getVideoData() || {}; if (!d.video_id || d.video_id !== ytCurrent.id) return;
  markHist(ytCurrent, ytPlayer.getCurrentTime() || 0, ytPlayer.getDuration() || 0);
}
function ytLeave() { ytSave(); clearInterval(ytTimer); try { ytPlayer && ytPlayer.pauseVideo(); } catch {} renderResume(); }
$('#yt-fs').addEventListener('click', () => {
  const box = $('.yt-player-box'); const iframe = box.querySelector('iframe');
  try { (iframe && iframe.requestFullscreen ? iframe : box).requestFullscreen().catch(() => toggleMax()); } catch { toggleMax(); }
});
function renderResume() {
  const r = state.hist.find(x => x.d && x.t > 20 && x.d - x.t > 20);
  const tile = $('#resume-tile'); tile.hidden = !r;
  if (!r) return;
  $('#resume-thumb').src = r.thumb; $('#resume-title').textContent = r.title;
  $('#resume-sub').textContent = `${mmss(r.t)} / ${mmss(r.d)} · ${mmss(r.d - r.t)} left${r.channel ? ' · ' + r.channel : ''}`;
  tile.onclick = () => show('youtube', true, { video: r, list: [r], t: r.t });
}

/* ======================================================================
   SPORTS (ESPN public scoreboard)
   ====================================================================== */
const LG = { nfl: 'football/nfl', nba: 'basketball/nba', mlb: 'baseball/mlb', nhl: 'hockey/nhl', ncaaf: 'football/college-football', ncaam: 'basketball/mens-college-basketball', mls: 'soccer/usa.1' };
const spCache = {}; let spTimer = null;
async function loadScores(lg) {
  const c = spCache[lg];
  if (c && Date.now() - c.at < 60e3) return c.games;
  const d = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${LG[lg]}/scoreboard`);
  const games = (d.events || []).map(ev => gameFromEvent(ev, lg));
  spCache[lg] = { at: Date.now(), games };
  return games;
}
function gameFromEvent(ev, lg) {
  const comp = (ev.competitions || [])[0] || {}, st = ev.status || comp.status || {}, t = st.type || {};
  const teams = (comp.competitors || []).map(c => ({ id: c.team.id, abbr: c.team.abbreviation, name: c.team.shortDisplayName || c.team.displayName, logo: c.team.logo, score: c.score, home: c.homeAway === 'home', winner: !!c.winner, rank: c.curatedRank && c.curatedRank.current <= 25 ? c.curatedRank.current : 0, record: (c.records || []).length ? c.records[0].summary : '' }))
    .sort((a, b) => a.home - b.home);
  return { id: ev.id, lg, state: t.state || 'pre', detail: t.shortDetail || t.detail || '', date: ev.date, teams,
           tv: ((comp.broadcasts || [])[0] || {}).names?.join(', ') || '', note: (comp.notes || [])[0]?.headline || '' };
}
function gameCard(g, fav) {
  const c = document.createElement('div'); c.className = 'card game' + (fav ? ' fav' : '');
  const live = g.state === 'in';
  const when = g.state === 'pre' ? new Date(g.date).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : g.detail;
  c.innerHTML = `<div class="gstat"><span>${esc(g.lg)}${g.note ? ' · ' + esc(g.note) : ''}</span><span class="${live ? 'live' : ''}">${esc(live ? g.detail : when)}</span></div>` +
    g.teams.map(t => `<div class="team ${g.state === 'post' ? (t.winner ? 'win' : 'lose') : ''}"><img src="${esc(t.logo || '')}" alt="" onerror="this.style.visibility='hidden'"><span class="tn">${t.rank ? '#' + t.rank + ' ' : ''}${esc(t.name)}<small>${esc(t.record)}</small></span><span class="sc">${g.state === 'pre' ? '' : esc(t.score ?? '')}</span></div>`).join('') +
    `<div class="gfoot">${esc(g.tv ? 'TV: ' + g.tv : '')}</div>`;
  return c;
}
async function renderSports() {
  pills($('#sp-pills'), 'lg', ui.spTab);
  const grid = $('#sp-games'), hint = $('#sp-hint');
  clearInterval(spTimer); spTimer = setInterval(() => { if (ui.open.sp && !document.hidden && current === 'home') renderSports(); }, 60e3);
  try {
    if (ui.spTab === 'favs') {
      if (!prefs.teams.length) { hint.textContent = 'No teams picked yet. Tap "Pick teams".'; grid.innerHTML = ''; return; }
      hint.textContent = 'Loading…';
      const lgs = [...new Set(prefs.teams.map(t => t.lg))];
      const scores = {}; await Promise.all(lgs.map(async lg => { try { scores[lg] = await loadScores(lg); } catch { scores[lg] = []; } }));
      grid.innerHTML = ''; let shown = 0;
      for (const t of prefs.teams) {
        let g = (scores[t.lg] || []).find(g => g.teams.some(x => x.id === t.id));
        if (!g) g = await nextGame(t);
        if (g && !$$('.card', grid).some(el => el.dataset.gid === g.id)) { const c = gameCard(g, true); c.dataset.gid = g.id; grid.appendChild(c); shown++; }
      }
      hint.textContent = shown ? 'Your teams: today’s game, or the next one scheduled' : 'No games found for your teams.';
    } else {
      hint.textContent = 'Loading…';
      const games = await loadScores(ui.spTab);
      const favIds = new Set(prefs.teams.filter(t => t.lg === ui.spTab).map(t => t.id));
      const isFavG = g => g.teams.some(t => favIds.has(t.id));
      const order = g => (isFavG(g) ? 0 : 1) * 10 + (g.state === 'in' ? 0 : g.state === 'pre' ? 1 : 2);
      games.sort((a, b) => order(a) - order(b) || new Date(a.date) - new Date(b.date));
      grid.innerHTML = ''; games.forEach(g => grid.appendChild(gameCard(g, isFavG(g))));
      hint.textContent = games.length ? `${games.length} games · updates every minute while open` : 'No games on the schedule right now.';
    }
  } catch (e) { hint.textContent = 'Could not load scores: ' + e.message; }
}
async function nextGame(t) {
  const k = `sp_next_${t.lg}_${t.id}`, c = store.get(k, null);
  if (c && Date.now() - c.at < 6 * 3600e3) return c.g;
  try {
    const d = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${LG[t.lg]}/teams/${t.id}`);
    const ev = (d.team && d.team.nextEvent || [])[0];
    const g = ev ? gameFromEvent(ev, t.lg) : null;
    if (g) g.teams.forEach(x => { if (!x.logo) x.logo = `https://a.espncdn.com/i/teamlogos/${t.lg === 'ncaaf' || t.lg === 'ncaam' ? 'ncaa' : t.lg}/500/${x.id}.png`; });
    store.set(k, { at: Date.now(), g }); return g;
  } catch { return null; }
}
$('#sp-pills').addEventListener('click', e => { const p = e.target.closest('[data-lg]'); if (p) { ui.spTab = p.dataset.lg; saveUI(); renderSports(); } });
// team picker
let pickLg = 'nfl';
$('#sp-edit-btn').addEventListener('click', async () => {
  const b = $('#sp-edit'); b.hidden = !b.hidden; if (b.hidden) return;
  if (!state.teams) { try { state.teams = (await getJSON('data/teams.json')).leagues; } catch { $('#sp-teams').innerHTML = '<p class="muted">Team list not available.</p>'; return; } }
  $('#sp-edit-pills').innerHTML = Object.keys(LG).map(k => `<button class="pill" data-plg="${k}">${k.toUpperCase()}</button>`).join('');
  renderPicker();
});
$('#sp-edit-pills').addEventListener('click', e => { const p = e.target.closest('[data-plg]'); if (p) { pickLg = p.dataset.plg; renderPicker(); } });
function renderPicker() {
  pills($('#sp-edit-pills'), 'plg', pickLg);
  const grid = $('#sp-teams'); grid.innerHTML = '';
  (state.teams[pickLg] || []).forEach(t => {
    const on = prefs.teams.some(x => x.lg === pickLg && x.id === t.id);
    const c = document.createElement('div'); c.className = 'card team-pick' + (on ? ' on' : ''); c.setAttribute('role', 'button');
    c.innerHTML = `<img src="${esc(t.logo)}" alt="" loading="lazy"><span class="name">${esc(t.name)}</span>`;
    c.addEventListener('click', () => {
      if (prefs.teams.some(x => x.lg === pickLg && x.id === t.id)) prefs.teams = prefs.teams.filter(x => !(x.lg === pickLg && x.id === t.id));
      else prefs.teams.push({ lg: pickLg, id: t.id, abbr: t.abbr, name: t.name, logo: t.logo });
      savePrefs(); c.classList.toggle('on'); renderHome(); if (ui.spTab === 'favs') renderSports();
    });
    grid.appendChild(c);
  });
}

/* ======================================================================
   MARKETS (TradingView embeds) + ECONOMIC CALENDAR (data/calendar.json)
   ====================================================================== */
function tickers() { return prefs.tickers || state.sources.markets || []; }
function tvWidget(container, script, cfg) {
  container.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
  const s = document.createElement('script');
  s.src = 'https://s3.tradingview.com/external-embedding/' + script; s.async = true; s.textContent = JSON.stringify(cfg);
  container.firstChild.appendChild(s);
}
let mountedKey = '';
function mountMarkets() {
  const ms = tickers(), key = JSON.stringify(ms);
  if (key === mountedKey) return; mountedKey = key;
  const grid = $('#mk-cards'); grid.innerHTML = '';
  ms.forEach(m => {
    const card = document.createElement('div'); card.className = 'mk-card';
    card.innerHTML = `<div class="mk-name">${esc(m.name)}</div><div class="mk-body"></div>`;
    grid.appendChild(card);
    tvWidget($('.mk-body', card), 'embed-widget-mini-symbol-overview.js',
      { symbol: m.symbol, width: '100%', height: 190, locale: 'en', dateRange: '1D', colorTheme: 'dark', isTransparent: true, autosize: false, largeChartUrl: '' });
  });
  if (ms.length) tvWidget($('#mk-chart'), 'embed-widget-symbol-overview.js', {
    symbols: ms.map(m => [m.name, m.symbol + '|1D']),
    chartOnly: false, width: '100%', height: 480, locale: 'en', colorTheme: 'dark', autosize: false,
    showVolume: false, hideDateRanges: false, scalePosition: 'right', scaleMode: 'Normal', fontSize: '12',
    noTimeScale: false, valuesTracking: '1', changeMode: 'price-and-percent', chartType: 'area', isTransparent: true,
    dateRanges: ['1d|1', '1w|30', '1m|30', '3m|60', '12m|1D'],
  }); else $('#mk-chart').innerHTML = '';
  renderHome();
}
$('#mk-edit-btn').addEventListener('click', () => { const b = $('#mk-edit'); b.hidden = !b.hidden; if (!b.hidden) renderTickerChips(); });
function renderTickerChips() {
  const box = $('#mk-chips'); box.innerHTML = '';
  tickers().forEach((m, i) => {
    const c = document.createElement('span'); c.className = 'chip';
    c.innerHTML = `${esc(m.name)} <small class="muted">${esc(m.symbol)}</small><button class="x" title="Remove">&times;</button>`;
    $('.x', c).addEventListener('click', () => { prefs.tickers = tickers().filter((_, j) => j !== i); savePrefs(); renderTickerChips(); mountMarkets(); });
    box.appendChild(c);
  });
}
$('#mk-add').addEventListener('click', () => {
  let sym = $('#mk-sym').value.trim().toUpperCase().replace(/\s+/g, ''); if (!sym) return;
  const name = $('#mk-name').value.trim() || sym.split(':').pop();
  prefs.tickers = tickers().concat([{ name, symbol: sym }]); savePrefs();
  $('#mk-sym').value = ''; $('#mk-name').value = ''; renderTickerChips(); mountMarkets();
});
$('#mk-sym').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#mk-add').click(); } });
$('#mk-reset').addEventListener('click', () => { prefs.tickers = null; savePrefs(); renderTickerChips(); mountMarkets(); });

async function renderCalendar() {
  const box = $('#cal-body');
  try {
    if (!state.calendar) state.calendar = await getJSON('data/calendar.json', { cache: 'no-store' });
    const evs = state.calendar.events || [];
    const now = new Date(), todayKey = now.toDateString();
    const days = new Map();
    evs.forEach(e => { const d = new Date(e.d); const k = d.toDateString(); if (!days.has(k)) days.set(k, { d, rows: [] }); days.get(k).rows.push({ ...e, dt: d }); });
    let html = '';
    [...days.values()].sort((a, b) => a.d - b.d).forEach(day => {
      const isToday = day.d.toDateString() === todayKey;
      if (!isToday && day.d < now && now - day.d > 3 * 86400e3) return; // keep the last couple of days, today, and the rest of the week
      html += `<div class="cal-day ${isToday ? 'today' : ''}">${day.d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div><table class="cal-table">`;
      day.rows.forEach(r => {
        const imp = r.i === 'High' ? 'hi' : r.i === 'Medium' ? 'med' : r.i === 'Holiday' ? 'hol' : 'low';
        const past = r.dt < now;
        const time = r.i === 'Holiday' ? 'All day' : r.dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        html += `<tr class="${imp} ${past && !r.a ? 'past' : ''}"><td class="t">${esc(time)}</td><td class="n"><i class="imp ${imp}"></i>&nbsp; ${esc(r.t)}</td>` +
          `<td class="v">${r.a ? '<b>' + esc(r.a) + '</b>' : '<span class="muted">—</span>'}</td><td class="v">${esc(r.f || '')}</td><td class="v">${esc(r.p || '')}</td></tr>`;
      });
      html += '</table>';
    });
    const upd = state.calendar.updated ? new Date(state.calendar.updated * 1000) : null;
    box.innerHTML = (html || '<p class="muted">No US events this week.</p>') +
      `<p class="muted small">Columns: actual · forecast · previous. Times are local.${upd ? ' Updated ' + ago(upd) + '.' : ''}</p>`;
    $('#cal-meta').textContent = 'US · ' + evs.filter(e => new Date(e.d).toDateString() === todayKey).length + ' today';
  } catch (e) { box.innerHTML = `<p class="muted">Calendar not available yet (${esc(e.message)}). It fills in once the data job has run.</p>`; }
}

/* ======================================================================
   LIVE PLAYER (hls.js)
   ====================================================================== */
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
  msg(''); showOverlay();
  if (mixedContent(ch.url)) {
    msg(`<div>This channel uses plain http and the page is https, so the browser blocks it.</div><button class="btn" id="msg-next">Next channel</button>`);
    $('#msg-next').onclick = () => step(1); return;
  }
  const isHls = /\.m3u8(\?|$)/i.test(ch.url) || /\/live\//i.test(ch.url);
  if (isHls && window.Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
    state.hls = hls; hls.loadSource(ch.url); hls.attachMedia(video);
    let netRetries = 0, mediaRetries = 0, softErrors = 0;
    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    hls.on(Hls.Events.FRAG_LOADED, () => { softErrors = 0; });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) { if (++softErrors >= 6) failed(ch, data.details + (data.response ? ' ' + data.response.code : '')); return; }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries++ < 2) { setTimeout(() => hls.startLoad(), 800); return; }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 2) { hls.recoverMediaError(); return; }
      failed(ch, data.details + (data.response ? ' ' + data.response.code : ''));
    });
  } else { video.src = ch.url; video.play().catch(() => {}); }
}
function failed(ch, why) {
  stopHls();
  msg(`<div>Stream failed: ${esc(ch.name)}</div><div class="muted small">${esc(why || '')}. Usually the source is down, geo-blocked, or blocks browsers.</div>
       <button class="btn" id="msg-retry">Retry</button><button class="btn primary" id="msg-next">Next channel</button>`);
  $('#msg-retry').onclick = () => startStream(ch);
  $('#msg-next').onclick = () => step(1);
}
video.addEventListener('error', () => { if (!state.hls) failed(state.queue[state.qi], 'Browser could not play this format'); });
function step(d) { if (!state.queue.length) return; state.qi = (state.qi + d + state.queue.length) % state.queue.length; startStream(state.queue[state.qi]); }
function stopHls() { if (state.hls) { try { state.hls.destroy(); } catch {} state.hls = null; } video.removeAttribute('src'); try { video.load(); } catch {} }
function stopPlayer() { stopHls(); if (document.fullscreenElement) { try { document.exitFullscreen().catch(() => {}); } catch {} } }
$('#player-back').addEventListener('click', () => history.back());
$('#player-prev').addEventListener('click', () => step(-1));
$('#player-next').addEventListener('click', () => step(1));
$('#player-fav').addEventListener('click', () => { const ch = state.queue[state.qi]; toggleFav(ch); $('#player-fav').innerHTML = isFav(ch) ? '&#9733;' : '&#9734;'; });
$('#view-player').addEventListener('click', e => { if (!e.target.closest('.btn')) showOverlay(); });
video.addEventListener('pause', showOverlay);


/* ======================================================================
   CAR LOCATION + WEATHER + TRAFFIC (the right column)
   ====================================================================== */
const DEFAULT_GEO = { lat: 33.4484, lon: -112.074, src: 'default' };   // used only until a real fix arrives
let geo = store.get('geo_auto', null);
const maps = { wx: null, tr: null };
function geoOK(g) { return !!g && Number.isFinite(g.lat) && Number.isFinite(g.lon); }
function hasLeaflet() { return typeof L !== 'undefined'; }
function km(a, b) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function browserGeo() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude, src: 'gps' }),
      e => rej(e), { timeout: 8000, maximumAge: 120e3, enableHighAccuracy: false });
  });
}
async function ipGeo() {
  const c = store.get('loc_auto', null);
  if (c && c.loc && Number.isFinite(c.loc.lat) && Date.now() - c.at < 12 * 3600e3) return { lat: c.loc.lat, lon: c.loc.lon, src: 'ip' };
  const d = await getJSON('https://ipapi.co/json/');
  if (d.country_code === 'US') store.set('loc_auto', { at: Date.now(), loc: { state: d.region_code, city: d.city, auto: true, lat: d.latitude, lon: d.longitude } });
  return { lat: d.latitude, lon: d.longitude, src: 'ip' };
}
async function locate() {
  let g = null;
  try { g = await browserGeo(); } catch {}
  if (!g) { try { g = await ipGeo(); } catch {} }
  if (!g) g = geoOK(geo) ? geo : DEFAULT_GEO;
  const moved = !geoOK(geo) || km(geo, g) > 0.5;
  geo = { ...g, at: Date.now() }; store.set('geo_auto', geo);
  return moved;
}
function geoName() {
  const c = store.get('loc_auto', null), loc = prefs.loc || (c && c.loc);
  return loc ? locLabel(loc) : (geo.src === 'default' ? 'Phoenix, AZ (default)' : 'car position');
}

function mkMap(id, zoom) {
  const m = L.map(id, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
    keyboard: false, touchZoom: false, tap: false, attributionControl: true });
  m.attributionControl.setPrefix(false);
  // Esri's dark canvas: free with attribution, no key, no referer rules.
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_';
  L.tileLayer(esri + 'Base/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 16, attribution: 'Esri, HERE, Garmin, OpenStreetMap' }).addTo(m);
  L.tileLayer(esri + 'Reference/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 16, zIndex: 3, opacity: .9 }).addTo(m);
  m.setView([geo.lat, geo.lon], zoom);
  m.car = L.marker([geo.lat, geo.lon], { icon: L.divIcon({ className: 'car-dot', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(m);
  return m;
}
function recenter(m) { if (!m) return; m.setView([geo.lat, geo.lon], m.getZoom(), { animate: false }); m.car.setLatLng([geo.lat, geo.lon]); }

/* ---------- weather: RainViewer radar on a dark map, Open-Meteo numbers ---------- */
const WX_ICON = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14a8 8 0 1 1-10-10 6 6 0 0 0 10 10z"/>',
  'cloud-sun': '<circle cx="8" cy="8" r="3"/><path d="M8 2v1.5M2 8h1.5M3.8 3.8l1 1M13 4l-1 1"/><path d="M10 20h8a3.5 3.5 0 0 0 .5-7A5 5 0 0 0 9 14a3 3 0 0 0 1 6z"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 1 6z"/>',
  fog: '<path d="M4 10h16M4 14h12M8 18h12"/>',
  rain: '<path d="M7 15h10a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 1 6z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
  snow: '<path d="M7 15h10a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 1 6z"/><path d="M8 19h.01M12 21h.01M16 19h.01"/>',
  storm: '<path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 1 6z"/><path d="M13 13l-2 4h3l-2 4"/>',
};
function wxKind(code, isDay) {
  const c = +code || 0, night = isDay === 0;
  if (c === 0) return [night ? 'Clear' : 'Sunny', night ? 'moon' : 'sun'];
  if (c <= 2) return ['Partly cloudy', night ? 'moon' : 'cloud-sun'];
  if (c === 3) return ['Overcast', 'cloud'];
  if (c <= 48) return ['Fog', 'fog'];
  if (c <= 57) return ['Drizzle', 'rain'];
  if (c <= 67) return ['Rain', 'rain'];
  if (c <= 77) return ['Snow', 'snow'];
  if (c <= 82) return ['Showers', 'rain'];
  if (c <= 86) return ['Snow showers', 'snow'];
  return ['Thunderstorm', 'storm'];
}
function wxSvg(icon) { return `<svg class="wi-${icon}" viewBox="0 0 24 24">${WX_ICON[icon] || WX_ICON.cloud}</svg>`; }
let wxAt = 0, radarAt = 0, radarLayer = null;
async function renderWeather(force) {
  if (!geoOK(geo)) return;
  const sub = $('#wx-sub'), meta = $('#wx-meta');
  if (hasLeaflet() && !maps.wx) { try { maps.wx = mkMap('wx-map', 8); } catch {} }
  else if (force && maps.wx) recenter(maps.wx);
  if (maps.wx && (force || Date.now() - radarAt > 5 * 60e3)) {
    // NEXRAD composite from Iowa State Mesonet (free, no key, refreshed every ~5 min). The stamp defeats tile caching.
    try {
      const nl = L.tileLayer('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?t=' + Math.floor(Date.now() / 300e3),
        { opacity: .8, maxNativeZoom: 10, zIndex: 5, attribution: 'NEXRAD via IEM' }).addTo(maps.wx);
      const old = radarLayer; radarLayer = nl; radarAt = Date.now();
      if (old) setTimeout(() => { try { maps.wx.removeLayer(old); } catch {} }, 2500);
    } catch {}
  }
  if (!force && Date.now() - wxAt < 10 * 60e3) return;
  try {
    let w;
    try { w = await openMeteo(); } catch (e1) { w = await nwsWeather(); }
    $('#wx-temp').innerHTML = Math.round(w.temp) + '<sup>°F</sup>';
    $('#wx-cond').innerHTML = wxSvg(w.icon) + esc(w.label);
    $('#wx-hl').textContent = `H ${Math.round(w.hi)}° · L ${Math.round(w.lo)}° · ${w.pop ?? 0}% rain`;
    $('#wx-now').hidden = false;
    $('#wx-hours').innerHTML = w.hours.map(h => `<div>${h.lab}${wxSvg(h.icon)}<b>${Math.round(h.temp)}°</b>${h.pop >= 20 ? `<span>${h.pop}%</span>` : ''}</div>`).join('');
    wxAt = Date.now();
    sub.textContent = geoName() + ' · radar';
    meta.textContent = 'updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (w.src === 'nws' ? ' · NWS' : '');
  } catch (e) { meta.textContent = 'weather unavailable'; }
}
function hourLab(ms) { const h = new Date(ms).getHours(); return (h % 12 || 12) + (h < 12 ? 'a' : 'p'); }
async function openMeteo() {
  const q = `latitude=${geo.lat.toFixed(4)}&longitude=${geo.lon.toFixed(4)}&current=temperature_2m,weather_code,is_day` +
    '&hourly=temperature_2m,weather_code,precipitation_probability&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&temperature_unit=fahrenheit&timezone=auto&forecast_days=2';
  const d = await getJSON('https://api.open-meteo.com/v1/forecast?' + q);
  const c = d.current, [label, icon] = wxKind(c.weather_code, c.is_day);
  const now = Date.now(), times = d.hourly.time.map(t => new Date(t).getTime());
  let i = times.findIndex(t => t > now); if (i < 0) i = 0;
  const hours = [];
  for (let k = i; k < times.length && hours.length < 6; k += 2) {
    const h = new Date(times[k]).getHours();
    hours.push({ lab: hourLab(times[k]), icon: wxKind(d.hourly.weather_code[k], h >= 6 && h < 19 ? 1 : 0)[1], temp: d.hourly.temperature_2m[k], pop: d.hourly.precipitation_probability[k] || 0 });
  }
  return { src: 'open-meteo', temp: c.temperature_2m, label, icon, hi: d.daily.temperature_2m_max[0], lo: d.daily.temperature_2m_min[0], pop: d.daily.precipitation_probability_max[0], hours };
}
function nwsKind(text, day) {
  const t = String(text || '').toLowerCase();
  if (/thunder/.test(t)) return ['Thunderstorm', 'storm'];
  if (/snow|flurr|sleet|ice/.test(t)) return ['Snow', 'snow'];
  if (/rain|shower|drizzle/.test(t)) return ['Rain', 'rain'];
  if (/fog|haze|smoke/.test(t)) return ['Fog', 'fog'];
  if (/mostly cloudy|cloudy|overcast/.test(t) && !/partly/.test(t)) return ['Cloudy', 'cloud'];
  if (/partly|mostly sunny|mostly clear/.test(t)) return ['Partly cloudy', day ? 'cloud-sun' : 'moon'];
  return [day ? 'Sunny' : 'Clear', day ? 'sun' : 'moon'];
}
async function nwsWeather() {
  // US National Weather Service: free, no key. Two hops: point → hourly + daily forecast.
  const pt = await getJSON(`https://api.weather.gov/points/${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}`);
  const [hf, df] = await Promise.all([getJSON(pt.properties.forecastHourly), getJSON(pt.properties.forecast)]);
  const hp = hf.properties.periods || [], dp = df.properties.periods || [];
  const c = hp[0], [label, icon] = nwsKind(c.shortForecast, c.isDaytime);
  const hours = [];
  for (let k = 1; k < hp.length && hours.length < 6; k += 2) {
    const h = hp[k];
    hours.push({ lab: hourLab(new Date(h.startTime).getTime()), icon: nwsKind(h.shortForecast, h.isDaytime)[1], temp: h.temperature, pop: (h.probabilityOfPrecipitation && h.probabilityOfPrecipitation.value) || 0 });
  }
  const dayP = dp.find(x => x.isDaytime) || dp[0], nightP = dp.find(x => !x.isDaytime) || dp[1] || dp[0];
  return { src: 'nws', temp: c.temperature, label, icon, hi: dayP ? dayP.temperature : c.temperature, lo: nightP ? nightP.temperature : c.temperature,
    pop: (dayP && dayP.probabilityOfPrecipitation && dayP.probabilityOfPrecipitation.value) || 0, hours };
}

/* ---------- traffic: Waze jams + police/crashes/hazards through the relay ---------- */
const AL_KIND = { POLICE: ['police', 'P', 'police'], ACCIDENT: ['crash', '!', 'crashes'], HAZARD: ['hazard', '▲', 'hazards'], ROAD_CLOSED: ['closed', '×', 'closures'] };
const JAM_COLOR = { 1: '#facc15', 2: '#fb923c', 3: '#ef4444', 4: '#b91c1c', 5: '#7f1d1d' };
let trAt = 0, trLayer = null, trBlocked = 0;
function recenterEmbed(embed) {
  const src = `https://embed.waze.com/iframe?zoom=13&lat=${geo.lat.toFixed(4)}&lon=${geo.lon.toFixed(4)}&ct=livemap`;
  if (embed.dataset.src !== src) { embed.src = src; embed.dataset.src = src; }
}
function relayUrl() { return (prefs.relay || '').trim().replace(/\/+$/, ''); }
async function relayJSON(url) {
  const r = await fetch(url); let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}
async function renderTraffic(force) {
  if (!geoOK(geo)) return;
  const sub = $('#tr-sub'), meta = $('#tr-meta'), legend = $('#tr-legend'), embed = $('#tr-embed'), live = $('#tr-live'), box = $('#tr-map');
  const relay = relayUrl();
  if (!relay || !hasLeaflet()) {
    if (maps.tr) { try { maps.tr.remove(); } catch {} maps.tr = null; trLayer = null; }
    box.hidden = true; embed.hidden = false; live.hidden = false;
    const src = `https://embed.waze.com/iframe?zoom=13&lat=${geo.lat.toFixed(4)}&lon=${geo.lon.toFixed(4)}&ct=livemap`;
    if (embed.dataset.src !== src) { embed.src = src; embed.dataset.src = src; }
    sub.textContent = 'live jams around the car';
    meta.textContent = 'Waze';
    legend.innerHTML = '<span><i style="background:#22c55e"></i>free</span><span><i style="background:#f59e0b"></i>slow</span><span><i style="background:#ef4444"></i>jam</span><span><i style="background:#7f1d1d"></i>standstill</span>';
    return;
  }
  if (trBlocked && Date.now() - trBlocked < 30 * 60e3) { if (force) recenterEmbed(embed); return; }
  if (!embed.hidden) { embed.hidden = true; embed.removeAttribute('src'); embed.dataset.src = ''; }
  box.hidden = false; live.hidden = false;
  if (!maps.tr) { try { maps.tr = mkMap('tr-map', 12); } catch { return; } }
  else if (force) recenter(maps.tr);
  if (!force && Date.now() - trAt < 2 * 60e3) return;
  try {
    const b = maps.tr.getBounds().pad(0.15);
    const d = await relayJSON(`${relay}/waze?top=${b.getNorth().toFixed(4)}&bottom=${b.getSouth().toFixed(4)}&left=${b.getWest().toFixed(4)}&right=${b.getEast().toFixed(4)}`);
    const g = L.layerGroup(), counts = {};
    (d.jams || []).forEach(j => L.polyline(j.line, { color: JAM_COLOR[Math.min(5, Math.max(1, j.l || 1))], weight: 5, opacity: .9, lineCap: 'round', interactive: false }).addTo(g));
    (d.alerts || []).forEach(a => {
      const k = AL_KIND[a.t]; if (!k) return;
      counts[k[0]] = (counts[k[0]] || 0) + 1;
      L.marker([a.y, a.x], { icon: L.divIcon({ className: 'al al-' + k[0], html: k[1], iconSize: [22, 22] }), interactive: false, zIndexOffset: k[0] === 'police' ? 500 : 100 }).addTo(g);
    });
    if (trLayer) { try { maps.tr.removeLayer(trLayer); } catch {} }
    trLayer = g.addTo(maps.tr); trAt = Date.now();
    legend.innerHTML = Object.values(AL_KIND).map(k => `<span><i class="al al-${k[0]}">${k[1]}</i>${counts[k[0]] || 0} ${k[2]}</span>`).join('');
    sub.textContent = `${(d.jams || []).length} jams around the car`;
    meta.textContent = 'updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    // Relay missing or Waze refusing it (it now sits behind reCAPTCHA): show the plain Waze map instead.
    if (trLayer) { meta.textContent = 'relay: ' + (e.message || 'error'); return; }
    trBlocked = Date.now();
    if (maps.tr) { try { maps.tr.remove(); } catch {} maps.tr = null; }
    box.hidden = true; embed.hidden = false;
    const src = `https://embed.waze.com/iframe?zoom=13&lat=${geo.lat.toFixed(4)}&lon=${geo.lon.toFixed(4)}&ct=livemap`;
    if (embed.dataset.src !== src) { embed.src = src; embed.dataset.src = src; }
    sub.textContent = 'jams only';
    meta.textContent = /waze 403/.test(e.message) ? 'police blocked by Waze' : 'relay: ' + (e.message || 'error');
    legend.innerHTML = '<span><i style="background:#22c55e"></i>free</span><span><i style="background:#f59e0b"></i>slow</span><span><i style="background:#ef4444"></i>jam</span><span><i style="background:#7f1d1d"></i>standstill</span>';
  }
}

/* ---------- scheduler: only while the home page is on screen ---------- */
let sideStarted = false, geoAt = 0, sideBusy = false;
async function refreshSide(force) {
  if (current !== 'home' || document.hidden || sideBusy) return;
  sideBusy = true;
  try {
    if (force || Date.now() - geoAt > 5 * 60e3) {
      const moved = await locate(); geoAt = Date.now();
      if (moved) { force = true; recenter(maps.wx); recenter(maps.tr); }
    }
    await Promise.all([renderWeather(force), renderTraffic(force)]);
  } finally { sideBusy = false; }
}
function startSide() {
  if (sideStarted) { refreshSide(false); return; }
  sideStarted = true;
  refreshSide(true);
  setInterval(() => refreshSide(false), 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSide(false); });
  window.addEventListener('resize', () => Object.values(maps).forEach(m => m && m.invalidateSize()));
}

/* ======================================================================
   SETTINGS + car link (#p= carries every preference)
   ====================================================================== */
function status(text, ok) { const s = $('#s-status'); s.textContent = text; s.className = 'note' + (ok ? ' ok' : ''); s.hidden = !text; }
function carLink() {
  const p = {}; Object.keys(PREF_DEFAULTS).forEach(k => { if (JSON.stringify(prefs[k]) !== JSON.stringify(PREF_DEFAULTS[k])) p[k] = prefs[k]; });
  return location.origin + location.pathname + (Object.keys(p).length ? '#p=' + b64u.enc(JSON.stringify(p)) : '');
}
function renderSettings() {
  $('#s-ytkey').value = prefs.ytKey || ''; $('#s-ytlist').value = prefs.ytList || ''; $('#s-relay').value = prefs.relay || '';
  $('#s-carlink').value = carLink(); $('#s-version').textContent = `Garage TV ${VERSION}`; status('');
}
$('#s-save').addEventListener('click', () => {
  prefs.ytKey = $('#s-ytkey').value.trim(); prefs.ytList = ytListId($('#s-ytlist').value);
  prefs.relay = $('#s-relay').value.trim().replace(/\/+$/, ''); trAt = 0; savePrefs();
  Object.keys(ytCache).forEach(k => delete ytCache[k]);
  history.replaceState(history.state, '', carLink());
  status('Saved. Bookmark the car link below so the car never needs this typed.', true);
  ui.open.yt = true; saveUI();
});
$('#s-clear').addEventListener('click', () => {
  if (!confirm('Clear every preference, favorite, history item and section layout saved in this browser?')) return;
  ['prefs', 'ui', 'favs', 'yt_hist', 'yt_titles', 'loc_auto', 'geo_auto'].forEach(store.del);
  Object.keys(localStorage).filter(k => k.startsWith('sp_next_')).forEach(store.del);
  location.replace(location.pathname);
});

/* ---------- boot ---------- */
async function boot() {
  try { state.sources = await getJSON('sources.json', { cache: 'no-store' }); } catch {}
  // preferences from the car link win over what this browser saved; legacy #yt= still works
  const p = (location.hash.match(/[#&]p=([A-Za-z0-9_-]+)/) || [])[1];
  if (p) { try { Object.assign(prefs, JSON.parse(b64u.dec(p))); } catch {} }
  const legacyYt = (location.hash.match(/[#&]yt=([A-Za-z0-9_-]+)/) || [])[1];
  if (legacyYt) prefs.ytList = legacyYt;
  const sy = state.sources.youtube || {};
  if (!prefs.ytList && sy.playlist) prefs.ytList = ytListId(sy.playlist);
  if (!prefs.ytKey && sy.apiKey) prefs.ytKey = sy.apiKey;
  savePrefs();
  history.replaceState({ view: 'home' }, '', location.href);
  renderHome();
  applySections();
}
boot();
})();
