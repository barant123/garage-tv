"""Builds the small JSON files in data/ that the page reads.

Run by the GitHub Action in .github/workflows/data.yml every few hours, or by hand:
    python tools/build_data.py

  data/calendar.json  US economic calendar, this week + next (ForexFactory feed; it has no
                      browser CORS header, which is why this runs here and not in the page)
  data/locals.json    US local TV stations with an https stream, tagged by city and state
                      (iptv-org database)
  data/teams.json     team lists per league for the sports favorites picker (ESPN)

Only standard library, so it runs on a bare GitHub runner.
"""
import json, os, sys, time, urllib.request
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data")
os.makedirs(OUT, exist_ok=True)
UA = "Mozilla/5.0 (GarageTV data builder; personal use)"


def get_json(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3 * (i + 1))
    print(f"  skip {url}: {last}", file=sys.stderr)
    return None


def write(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  wrote {name} ({os.path.getsize(path)//1024} KB)")


def build_calendar():
    print("calendar")
    events = []
    for part in ("thisweek",):
        data = get_json(f"https://nfs.faireconomy.media/ff_calendar_{part}.json")
        if not data:
            continue
        for e in data:
            if e.get("country") != "USD":
                continue
            events.append({
                "t": e.get("title", ""), "d": e.get("date", ""), "i": e.get("impact", ""),
                "f": e.get("forecast", ""), "p": e.get("previous", ""), "a": e.get("actual", ""),
            })
    if not events:
        print("  no calendar data; keeping the old file")
        return
    seen, uniq = set(), []
    for e in events:
        k = (e["t"], e["d"])
        if k not in seen:
            seen.add(k); uniq.append(e)
    uniq.sort(key=lambda e: e["d"])
    write("calendar.json", {"updated": int(time.time()), "events": uniq})


def build_locals():
    print("locals")
    base = "https://iptv-org.github.io/api/"
    ch, st, fd, lg, ci = (get_json(base + n) for n in ("channels.json", "streams.json", "feeds.json", "logos.json", "cities.json"))
    if not (ch and st and fd and ci):
        print("  iptv-org data missing; keeping the old file")
        return
    chan = {c["id"]: c for c in ch}
    city = {c["code"]: c for c in ci if c.get("country") == "US"}
    # logos are per feed when the feed has its own (local affiliates), else per channel
    logo = {}
    for l in lg or []:
        k = (l["channel"], l.get("feed"))
        if k not in logo or l.get("in_use"):
            logo[k] = l["url"]
    streams = defaultdict(list)
    for s in st:
        if s["url"].startswith("https://"):
            streams[(s["channel"], s.get("feed"))].append(s["url"])
    out = []
    for f in fd:
        c = chan.get(f["channel"])
        if not c or c.get("country") != "US" or c.get("closed") or c.get("is_nsfw"):
            continue
        areas = f.get("broadcast_area", [])
        cities = [a[3:] for a in areas if a.startswith("ct/")]
        states = {a[2:] for a in areas if a.startswith("s/")}
        if not cities and not states:
            continue
        urls = streams.get((f["channel"], f["id"])) or streams.get((f["channel"], None))
        if not urls:
            continue
        for cc in cities:
            if cc in city:
                states.add(city[cc]["subdivision"])
        out.append({
            "id": c["id"], "net": c.get("network") or "",
            # local affiliates: "Fox" + its call sign, so same-network stations can be told apart
            "name": c["name"] if f.get("is_main") or not f.get("name") or f["name"] == c["name"] else f"{c['name']} {f['name']}",
            "cat": c.get("categories", []),
            "cities": sorted({city[cc]["name"] for cc in cities if cc in city}),
            "states": sorted(s[3:] for s in states if s and s.startswith("US-")),
            "logo": logo.get((c["id"], f["id"])) or logo.get((c["id"], None), ""), "url": urls[0],
        })
    out.sort(key=lambda o: (o["states"], o["name"]))
    write("locals.json", {"updated": int(time.time()), "stations": out})


LEAGUES = {
    "nfl": "football/nfl", "nba": "basketball/nba", "mlb": "baseball/mlb", "nhl": "hockey/nhl",
    "ncaaf": "football/college-football", "ncaam": "basketball/mens-college-basketball", "mls": "soccer/usa.1",
}


def build_teams():
    print("teams")
    leagues = {}
    for key, path in LEAGUES.items():
        d = get_json(f"https://site.api.espn.com/apis/site/v2/sports/{path}/teams?limit=400")
        if not d:
            continue
        teams = []
        for t in d["sports"][0]["leagues"][0]["teams"]:
            t = t["team"]
            teams.append({"id": t["id"], "abbr": t.get("abbreviation", ""), "name": t.get("displayName", ""),
                          "logo": (t.get("logos") or [{}])[0].get("href", "")})
        teams.sort(key=lambda t: t["name"])
        leagues[key] = teams
    if leagues:
        write("teams.json", {"updated": int(time.time()), "leagues": leagues})


if __name__ == "__main__":
    build_calendar()
    build_locals()
    build_teams()
