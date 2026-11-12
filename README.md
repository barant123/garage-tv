# Garage TV

A personal media page for the Tesla browser. One home page with collapsible
sections that remember their state and their own preferences:

| Section | What it does |
|---|---|
| Live TV | Local news for your location (tab 1), hand-picked channels (tab 2), the public US index |
| YouTube | Search, trending, categories, channels you follow, your playlist, history. Plays inside the app and remembers where you stopped |
| Sports | ESPN scoreboards per league; your favorite teams pinned on top with today's game or the next one |
| Markets | Live cards and chart for your own tickers, plus a US economic calendar with today and impact highlighted |

No accounts, no server. Files:

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | the page |
| `sources.json` | default Live TV channels (with logos), default tickers, optional YouTube defaults |
| `data/calendar.json` | US economic calendar, refreshed by the GitHub Action |
| `data/locals.json` | US local stations with an https stream, tagged by city and state (iptv-org) |
| `data/teams.json` | team lists per league for the favorites picker (ESPN) |
| `tools/build_data.py` | builds the three data files |
| `.github/workflows/data.yml` | runs the builder every 4 hours and commits the result |

## Use it in the car

Park, open the browser, go to the site URL, bookmark it. Tap a section header
to open or close it. Video only plays while parked; that is the car, not the page.

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
YouTube Data API for browsing and the embedded player for playback. That needs
a free API key, one time:

1. On a PC open console.cloud.google.com, create a project, enable
   "YouTube Data API v3".
2. Credentials, Create credentials, API key. Restrict it to the website
   `barant123.github.io`.
3. Paste the key in Settings. Bookmark the car link.

The free quota is 10,000 units a day: a search costs 100, trending and
channel feeds cost 1 each. Videos whose owner blocks embedding show an
"open on youtube.com" link instead.

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

GitHub Pages: push this folder to a public repo, Settings, Pages, deploy from
branch `main`, folder `/ (root)`. The data workflow needs Actions enabled
(default on public repos). Run it once by hand from the Actions tab to check.

Local preview:

```
python -m http.server 8080
```
