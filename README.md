# Garage TV

A personal media page for the Tesla browser. One home page with collapsible
sections that remember their state and their own preferences:

| Section | What it does |
|---|---|
| Live TV | Local news for your location (tab 1), hand-picked channels (tab 2), the public US index |
| YouTube | Search, trending, categories, channels you follow, your playlist, history. Plays inside the app and remembers where you stopped |
| Sports | ESPN scoreboards per league; your favorite teams pinned on top with today's game or the next one |
| Markets | Live cards and chart for your own tickers, plus a US economic calendar with today and impact highlighted |
| Weather (right column) | Live NEXRAD radar centered on the car, current temperature and conditions, next hours |
| Traffic (right column) | Live Waze jams around the car; with the optional relay also police, crashes, hazards and closures |

No accounts, no server. Files:

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | the page |
| `canvas-player.js` | drive-mode player: decodes HLS itself and draws on a canvas (no `<video>`) |
| `sources.json` | default Live TV channels (with logos), default tickers, optional YouTube defaults |
| `data/calendar.json` | US economic calendar, refreshed by the GitHub Action |
| `data/locals.json` | US local stations with an https stream, tagged by city and state (iptv-org) |
| `data/teams.json` | team lists per league for the favorites picker (ESPN) |
| `tools/build_data.py` | builds the three data files |
| `tools/waze-relay.js` | optional Cloudflare Worker: Waze alerts (police) and the `/media` stream relay for drive mode; setup steps inside |
| `tools/relay_hosts.py` | refreshes the relay's list of allowed stream hosts |
| `tools/yt-server/` | optional YouTube helper for drive mode, runs on your PC (README inside) |
| `.github/workflows/data.yml` | runs the builder every 4 hours and commits the result |

## Use it in the car

Park, open the browser, go to the site URL, bookmark it. Tap a section header
to open or close it. With drive mode (below), live TV keeps playing for passengers
while the car moves.

## Drive mode (passengers)

The Tesla browser pauses every `<video>` element as soon as the car leaves Park.
Drive mode never uses one: `canvas-player.js` downloads the HLS playlist and the
MPEG-TS segments itself, unpacks them, decodes the H.264 video with WebCodecs in a
background worker and draws each frame on a `<canvas>`. Sound is decoded separately
and played through Web Audio, which the car leaves alone. Frames are timed against
the sound clock, so picture and sound stay in sync.

Settings, then **Drive mode**:

| Choice | What happens |
|---|---|
| Auto (default) | Drive mode in the car browser only (it reports itself as desktop Linux Chrome); normal players everywhere else |
| On | Drive mode in every browser that supports it (handy for testing on a PC with Chrome or Edge) |
| Off | Normal players (hls.js `<video>` and the YouTube embed) |

The Settings page tells you whether the current browser can run it and whether it is on.

What plays in drive mode:

- **Live TV**: HLS channels with H.264 video and AAC or MP3 audio, including AES-128
  encrypted ones. Up to 720p is picked to keep the car smooth. Channels that block other
  websites (CORS), or that are plain `http://`, play through the relay's `/media` route
  once the relay URL is set (Settings, Relay). HEVC (H.265), fMP4/CMAF-only, SAMPLE-AES or DRM channels
  fail with a reason and a **Normal player (parked)** button. AC-3 audio plays without sound.
- **YouTube**: needs the YouTube helper (`tools/yt-server`) running on your PC, reachable over
  https. Put its URL in Settings, **YouTube helper URL**. Without it, YouTube uses the normal
  embed, which the car pauses in Drive. Resume and history work in both.

Relay setup: deploy or update the Worker from `tools/waze-relay.js` (steps at the top of
that file) and paste its URL in Settings. To allow another channel host, add its domain to
`MEDIA_HOSTS` in the Worker (or run `python tools/relay_hosts.py`, which rebuilds the
list from the iptv-org US index, `sources.json` and `data/locals.json`) and paste the Worker again.

Limits: no seeking inside a stream, needs WebCodecs (newer Tesla software; older cars
fall back to the normal players), and Tesla could block this in a future update. It is
for passengers: the driver must not watch.

## Preferences and the car link

Every section has its own edit button: "Change location", "My channels",
"Pick teams", "Edit tickers". Choices are saved in that browser. Settings shows
a **car link** that carries all of them (`#p=...`). Bookmark that link in the
car: if the car browser forgets its settings after an update, opening the
bookmark restores everything without typing.

## Local news

Location comes from your connection (ipapi.co) the first time, and can be set
by hand to any state and city. Stations come from the public iptv-org index,
so coverage varies: big metros have several local news feeds, small towns may
only have city-council channels.

## YouTube

youtube.com itself cannot be shown inside another page, so Garage TV uses the
YouTube Data API for browsing and the embedded player for playback (or, in drive
mode with the helper, the canvas player). That needs
a free API key, one time:

1. On a PC open console.cloud.google.com, create a project, enable
   "YouTube Data API v3".
2. Credentials, Create credentials, API key. Restrict it to the website
   `barant123.github.io`.
3. Paste the key in Settings. Bookmark the car link.

The free quota is 10,000 units a day: a search costs 100, trending and
channel feeds cost 1 each. Videos whose owner blocks embedding show an
"open on youtube.com" link instead.

## Weather and traffic

Both follow the car. The page asks the browser for location (allow it once in the
car); if refused, it uses the connection's rough location. Weather numbers come from
Open-Meteo with the US National Weather Service as a fallback, radar tiles from the
Iowa State Mesonet NEXRAD composite. No keys.

The blue **Waze** button in the top bar (and "Police ↗" on the Traffic box) opens Waze's own live map centered on the car in a new tab, so police, crash and hazard reports are one tap away.

Traffic without a relay shows the plain Waze map (jams only; it cannot draw reports).
Police, crashes, hazards and closures need Waze's live-map feed, which refuses
browsers, so `tools/waze-relay.js` is a tiny Cloudflare Worker (free) that fetches it
for the box around the car, trims and caches it for a minute, and hands it to the page.
Status Nov 2026: Waze fronts that feed with reCAPTCHA Enterprise and answers 403 to every
relay, including this one (deployed and tested), so police pins do not work today. The
worker and the Settings field stay in place in case Waze opens the feed again; the page
falls back to the plain jams map whenever the relay is refused.

## Markets

TradingView free embeds, no key. CME futures (NQ1!, ES1!) are licensed data
and the free widgets refuse them, so the defaults use the 24-hour CFD feeds
`OANDA:NAS100USD` and `OANDA:SPX500USD`. Add any symbol with "Edit tickers",
for example `AAPL` or `NASDAQ:TSLA`.

The economic calendar feed has no browser CORS header, so the page cannot
fetch it directly. The GitHub Action fetches it and commits
`data/calendar.json` every 4 hours. High impact rows are dark red, medium
light orange, and today is marked.

## Publish

GitHub Pages: push this folder (without `mock-v4.html`) to a public repo, Settings, Pages, deploy from
branch `main`, folder `/ (root)`. The data workflow needs Actions enabled
(default on public repos). Run it once by hand from the Actions tab to check.

Local preview:

```
python -m http.server 8080
```
