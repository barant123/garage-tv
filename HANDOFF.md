# Garage TV — project handoff

Version 4.1.1 (2026-11-13). Static site, no build step, no framework.

| Item | Where |
|---|---|
| Live site | https://barant123.github.io/garage-tv/ |
| Repo | https://github.com/barant123/garage-tv (branch `main`, GitHub Pages from `/`) |
| Deploy | Upload changed files at `github.com/barant123/garage-tv/upload/main` (subfolders: `/upload/main/tools`). Pages publishes in about 1 minute. Page HTML is cached 10 min. |
| Cache busting | `index.html` loads `style.css?v=X` and `app.js?v=X`; bump both plus `VERSION` in `app.js` on every release. |
| Traffic relay | Cloudflare Worker `garage-tv-relay` at https://garage-tv-relay.brandonarant.workers.dev (source: `tools/waze-relay.js`). |
| YouTube key | Google Cloud project `lookingforbotox`, API key "Garage TV", restricted to YouTube Data API v3 + site barant123.github.io. Lives only in browser localStorage / car link, never in the repo. |

## Files

| File | Purpose |
|---|---|
| `index.html` | All views in one page: home, public TV list, YouTube player, live player, settings. SVG icon symbols at the top. |
| `style.css` | Theme tokens, sections, cards, side widgets, Leaflet overrides. |
| `app.js` | Everything, one IIFE. Section map below. |
| `sources.json` | Default Live TV channels (name, url, logo), default market tickers, optional YouTube defaults. |
| `data/calendar.json` | US economic calendar `{updated, events[{t,d,i,f,p,a}]}`. Rebuilt by the Action. |
| `data/locals.json` | Local stations by city/state from iptv-org. Rebuilt by the Action. |
| `data/teams.json` | Team lists per league from ESPN for the favorites picker. Rebuilt by the Action. |
| `tools/build_data.py` | Builds the three data files. `build_calendar()` L44, `build_locals()` L70, `build_teams()` L124. |
| `tools/waze-relay.js` | Cloudflare Worker: `/` health check, `/waze?top&bottom&left&right` → `{at, alerts[], jams[]}` with CORS for barant123.github.io and localhost:8080. |
| `.github/workflows/data.yml` | "Refresh data": cron `17 */4 * * *` + manual. Runs the builder and commits `data/` as garage-tv-bot. |
| `README.md` | User-facing docs. |
| `mock-v4.html`, `mock-relay/` | Local design mockup and fake relay response. Git-ignored, not deployed. |

## index.html layout

| Lines | Block |
|---|---|
| 15–25 | `<symbol>` icons: `i-tv`, `i-yt`, `i-sp` (football), `i-mk`, `i-gear`, `i-max` |
| 27 | `#view-home`: top bar, then `.home-grid` = `.home-main` (sections) + `aside.home-side` (widgets) |
| 52 | `.sec[data-sec=yt]` YouTube (search form `#yt-form`, pills `#yt-pills`, editor `#yt-edit`, `#yt-setup`, `#yt-cards`) |
| 104 | `.sec[data-sec=tv]` Live TV (pills `#tv-pills` local/mine, location editor `#tv-edit`, `#local-cards`, `#tv-cards`) |
| 140 | `.sec[data-sec=sp]` Sports (`#sp-pills`, team picker `#sp-edit`, `#sp-games`) |
| 171 | `.sec[data-sec=mk]` Markets (`#mk-edit` tickers, `#mk-cards`, `#mk-chart`, nested `.sub[data-sub=cal]` calendar) |
| 214 | `.wid.wx` Weather: `#wx-map`, `#wx-now` (`#wx-temp #wx-cond #wx-hl`), `#wx-hours` |
| 232 | `.wid.traffic` Traffic: `#tr-map` (Leaflet, relay mode), `#tr-embed` (Waze iframe fallback), `#tr-legend` |
| 250 | `#view-tv` public US channel list |
| 264 | `#view-youtube` in-app player (`#yt-player`, queue `#yt-list`) |
| 280 | `#view-player` live stream player (`#video`, overlay) |
| 298 | `#view-settings` (`#s-ytkey`, `#s-ytlist`, `#s-relay`, `#s-carlink`, `#s-clear`) |

Section header pattern: `.sec-head` > `.logo` (tile, colour from `--c`) + `.sec-title` (`.sec-name`, `.sec-sub` with id `*-meta`) + `.sec-quick` (`.qp[data-quick]`) + `.chev`.

## app.js map

| Lines | Area |
|---|---|
| 14 | `VERSION` |
| 19–31 | `store` (localStorage), `PREF_DEFAULTS` (ytKey, ytList, follows, tickers, teams, loc, relay), `UI_DEFAULTS` (open, tvTab, ytTab, spTab, calOpen), `prefs`, `ui`, `savePrefs/saveUI` |
| 33 | `state` (sources, favs, hist, publicUS, locals, teams, calendar, queue, hls) |
| 44 | `show(name, push, opts)` view switch; click delegation follows (`[data-go]`, `[data-max]`, `[data-quick]`, `.sub-head`, `.sec-head`) |
| 71–105 | sections: `toggleSection`, `onSectionOpen`, `quickJump` (84), `toggleSub`, `applySections`, `toggleMax` |
| 201 | `renderHome` (metas, `renderNextEvent` 211, `startSide`) |
| 226–325 | Live TV: `renderTVTab` 231, `loadLocals` 244, `detectLocation` 250 (ipapi.co → `loc_auto`), `renderLocal` 259, `renderPublicTV` 310 |
| 326–566 | YouTube: `ytApi` 329, `ytTrending` 352, `ytSearch` 358, `ytFollowsFeed` 362, `ytPlaylist` 371, `renderYTTab` 398 (15-min `ytCache`), `renderVideos` 423, `findChannels` 455, player `openYouTube` 496, `markHist` 537, `renderResume` 557 |
| 567–661 | Sports: `LG` map 569, `loadScores` 571 (ESPN scoreboard, 60 s cache), `renderSports` 595, `nextGame` 624 (`sp_next_*` cache 6 h), `renderPicker` 645 |
| 662–740 | Markets: `tickers` 664, `mountMarkets` 672 (TradingView embeds), `renderCalendar` 711 |
| 741–800 | Live player: `play` 751, `startStream` 758 (hls.js with retry caps), `failed` 782, prev/next, overlay |
| 802–1057 | Side column: `DEFAULT_GEO` 804, `browserGeo` 814, `ipGeo` 822, `locate` 835 (IP first, GPS in background), `mkMap` 861 (Leaflet, Esri dark canvas + reference), `renderWeather` 901 (NEXRAD tiles from mesonet.agron.iastate.edu, 5-min refresh), `openMeteo` 930, `nwsWeather` 955 (fallback), `AL_KIND`/`JAM_COLOR` 972, `renderTraffic` 986 (relay mode draws jams + pins; otherwise cropped Waze embed; on relay error falls back and retries after 30 min), `refreshSide` 1037, `startSide` 1048 (60 s tick, visibility + resize handlers) |
| 1058–1084 | Settings: `carLink` 1061 (`#p=` base64url JSON of non-default prefs), `renderSettings` 1065, save/clear handlers |
| 1085 | `boot`: loads `sources.json`, merges `#p=` from the URL (wins over saved prefs), legacy `#yt=`, renders home, restores open sections |

## style.css map

| Lines | Block |
|---|---|
| 3–25 | `:root` tokens: `--tv` blue, `--yt` red, `--sp` violet, `--mk` green, `--cal` amber, `--wx`, `--tr`, `--accent` cyan |
| 38 | top bar, brand mark |
| 50 | buttons, inputs, pills, editor, chips |
| 96 | collapsible sections, `.logo` tiles, `.sec-quick`/`.qp`, `.sec-body` grid-rows transition |
| 137 | cards: channel, video, game, team picker, markets, calendar |
| 218 | continue-watching tile |
| 239–271 | live player overlay, YouTube player view, settings form |
| 272 | `.home-grid` (`minmax(0,1fr) 380px`, one column under 1100px) |
| 283 | side widgets: `.wid`, `.map` (16:10), `.now`, `.strip`, `.tr-legend`, Leaflet overrides, `.car-dot`, `.al-*` pins |

## Browser storage keys

| Key | Content |
|---|---|
| `prefs` | see `PREF_DEFAULTS` |
| `ui` | open sections and active tabs |
| `favs` | starred public channels |
| `yt_hist` | last 40 videos with position (`t`) and duration (`d`) |
| `loc_auto` | IP location `{at, loc{state, city, lat, lon}}` (12 h) |
| `geo_auto` | last fix `{lat, lon, src: gps/ip/default, at}` |
| `sp_next_<lg>_<id>` | next game per favorite team (6 h) |

## External endpoints (all called from the browser)

| Service | Used for |
|---|---|
| `https://www.googleapis.com/youtube/v3/*` | search, trending, categories, channel uploads, playlist (user key) |
| YouTube IFrame API | in-app playback |
| `https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard`, `/teams/{id}` | scores, next game |
| TradingView embed scripts | market cards and chart |
| `https://ipapi.co/json/` | rough location |
| `https://api.open-meteo.com/v1/forecast` → fallback `https://api.weather.gov` | weather numbers |
| `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png` | radar tiles |
| `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_{Base,Reference}/MapServer/tile/{z}/{y}/{x}` | map tiles |
| `https://embed.waze.com/iframe?ct=livemap` | traffic jams map |
| relay `/waze` | alerts + jams JSON (currently answered 403 by Waze upstream; page falls back) |
| `https://iptv-org.github.io/iptv/countries/us.m3u` | public US channel list |
| `https://cdnjs.cloudflare.com` hls.js 1.5.17, leaflet 1.9.4; Google Fonts Inter + JetBrains Mono | libraries |

## Local preview

```
python -m http.server 8080 --bind 127.0.0.1 --directory garage-tv
```

Open http://localhost:8080/. The relay allows that origin. `mock-relay/waze` serves a fake relay answer if `prefs.relay` is set to `http://localhost:8080/mock-relay`.
