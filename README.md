# Garage TV

A personal media page for the Tesla browser. One home page with collapsible
sections: Live TV, YouTube, Markets, Economic calendar. No accounts, no tracking.

Four files, no build step:

| File | What it is |
|---|---|
| `index.html` | the one page; every screen is a section toggled by JS |
| `style.css` | dark technical theme, big tap targets |
| `app.js` | sections, HLS player, embedded YouTube player with resume, favorites |
| `sources.json` | your Live TV channels (with logos), market symbols, YouTube playlist |

## Use it in the car

Park, open the browser, go to the site URL, bookmark it. Tap a section header
to open or close it; the page remembers which ones were open. Video only plays
while parked; that is the car, not the page.

## Live TV

`sources.json` lists the channels. Each entry is a name, a group, a logo and an
HLS `.m3u8` link:

```json
{ "name": "DW News", "group": "World", "logo": "https://.../logo.png", "url": "https://.../index.m3u8" }
```

The link must be `https`. "Browse all public US channels" loads the free index
at iptv-org.github.io live; star a channel there and it shows up in the Live TV
section on the home page. Logos come from that same index.

## YouTube (plays inside Garage TV, remembers where you stopped)

youtube.com itself cannot be shown inside another page, so Garage TV plays a
playlist you control through the YouTube embedded player. Setup, once:

1. On your phone, make a YouTube playlist (public or unlisted), for example
   "Car". Save videos to it from the YouTube app.
2. Either paste the playlist link in Settings on the car, or put the link in
   `sources.json` under `youtube.playlist` so every browser gets it.

The YouTube section then shows those videos with thumbnails. Tap one and it
plays inside the app with the list beside it. Stop anywhere and the home page
shows a "Continue watching" tile at the top with the thumbnail and time left.

Settings also shows a car link (`...#yt=PLAYLISTID`). Bookmark that in the car:
if the car browser forgets its settings after an update, the bookmark puts the
playlist back.

## Markets

Four live cards (price, day change, intraday line) plus a chart with range
buttons. They are free TradingView embeds, no key needed. CME futures (NQ1!,
ES1!) are licensed data and the free widgets refuse them, so NQ and ES use the
24-hour CFD feeds `OANDA:NAS100USD` and `OANDA:SPX500USD`. They move with the
futures but the price level differs by the basis. Symbols live in
`sources.json` under `markets`.

## Maximize

The square button at the top right asks the browser for full screen. The live
player and the YouTube view also have their own.

## Publish

GitHub Pages: push this folder to a public repo, Settings, Pages, deploy from
branch `main`, folder `/ (root)`. The site is then at
`https://<user>.github.io/<repo>/`.

Local preview:

```
python -m http.server 8080
```
