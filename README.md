# Garage TV

A personal media page for the Tesla browser. Three things on the home screen:
My Playlist, Live TV, YouTube. No accounts, no timers, no tracking.

Five files, no build step:

| File | What it is |
|---|---|
| `index.html` | the one page; every screen is a section toggled by JS |
| `style.css` | dark theme, big tap targets |
| `app.js` | tiles, HLS player, M3U/Xtream playlist, favorites, car bookmark |
| `sources.json` | your hand-picked Live TV channels and home links |
| `config.enc` | optional, encrypted playlist settings for the car bookmark |

## Use it in the car

Park, open the browser, go to the site URL, bookmark it. Tap a channel.
Video only plays while parked; that is the car, not the page.

## Add or change a Live TV channel

Edit `sources.json`. Each entry is a name and an HLS `.m3u8` link:

```json
{ "name": "ABC News Live", "url": "https://.../master.m3u8", "group": "News", "logo": "" }
```

The link must be `https`. Plain `http` streams are blocked on a secure page
and show a warning badge. "All public US" in Live TV loads the free index at
iptv-org.github.io live, so you can search there for a channel first and copy
its link into `sources.json` if you want it on your own list.

## Your own playlist (M3U or Xtream)

Settings, paste the M3U link or the Xtream server, username and password, then
"Load playlist now". It is stored only in that browser. If the provider blocks
browser requests (common), download the `.m3u` file on a PC and use "Import a
playlist file" instead; the channels are then saved in that browser.

## Car bookmark: no typing in the car, nothing private in the repo

On the PC: Settings, "Make car bookmark". Save the downloaded `config.enc`
into this folder next to `index.html` and publish. Bookmark the shown
`...#k=...` link in the car. The key only exists in that link; the repo holds
ciphertext. Opening the plain URL shows an empty playlist.

## Publish

GitHub Pages: push this folder to a public repo, Settings, Pages, deploy from
branch `main`, folder `/ (root)`. The site is then at
`https://<user>.github.io/<repo>/`.

Local preview:

```
python -m http.server 8080
```

then open http://localhost:8080/ on the PC, or http://<pc-lan-ip>:8080/ in the
car on home Wi-Fi.
