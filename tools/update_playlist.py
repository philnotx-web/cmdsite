#!/usr/bin/env python3
"""Rebuild playlist.js from the public Apple Music playlist.

Run from the repository root:  python3 tools/update_playlist.py
Uses only the standard library, so it runs as is on a GitHub Actions runner.

- Track list, durations, artwork and the cover colours come from the playlist page
  (music.apple.com), previews from Apple's lookup API (itunes.apple.com).
- Tracks keep a "file" they already had in playlist.js.
- playlist.js is only rewritten when the tracks changed, so a run without changes
  leaves the file (and its date) alone.
- Anything unexpected (page layout changed, fewer tracks than the page says) stops the
  run with an error and leaves playlist.js untouched.
"""
import datetime
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

PLAYLIST_URL = 'https://music.apple.com/de/playlist/gtbsg/pl.u-xlyNNedsJEo4lpa'
PLAYLIST_NAME = 'GTBSG'
COUNTRY = 'de'
OUT = Path(__file__).resolve().parent.parent / 'playlist.js'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
      '(KHTML, like Gecko) Version/17.0 Safari/605.1.15')
ACCENT_MIN_CHROMA = 46  # below this a colour reads as grey, so the disc gets no accent


def fetch(url, tries=4):
    for n in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9'})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode('utf-8')
        except Exception as e:  # network hiccups: back off and retry
            if n == tries - 1:
                raise
            print(f'fetch failed ({e}), retrying', file=sys.stderr)
            time.sleep(2 ** (n + 1))


def playlist_items():
    html = fetch(PLAYLIST_URL)
    m = re.search(r'<script[^>]*id="serialized-server-data"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        sys.exit('playlist page has no serialized-server-data; Apple changed the page')
    data = json.loads(m.group(1))
    sections = data['data'][0]['data']['sections']
    tracks = next((s['items'] for s in sections if s.get('itemKind') == 'trackLockup'), None)
    if not tracks:
        sys.exit('no track list found on the playlist page')
    # the footer says how many tracks the playlist has ("147 Titel, 7 Stunden ..."):
    # if the page holds fewer, it was cut short and the list would lose songs
    footer = next((s['items'][0] for s in sections if s.get('itemKind') == 'containerDetailTracklistFooterLockup'), {})
    count = re.match(r'\s*(\d+)', footer.get('description', '').replace(' ', ' '))
    if count and int(count.group(1)) != len(tracks):
        sys.exit(f'page lists {len(tracks)} tracks but the playlist has {count.group(1)}')
    return tracks


def previews(ids):
    out = {}
    for i in range(0, len(ids), 150):
        batch = ','.join(ids[i:i + 150])
        res = json.loads(fetch(f'https://itunes.apple.com/lookup?id={batch}&country={COUNTRY}'))
        for r in res.get('results', []):
            if r.get('trackId') and r.get('previewUrl'):
                out[str(r['trackId'])] = r['previewUrl']
    return out


def chroma(hex6):
    c = [int(hex6[i:i + 2], 16) for i in (0, 2, 4)]
    return max(c) - min(c)


def old_tracks():
    if not OUT.exists():
        return {}
    old = {}
    for line in OUT.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line.startswith('{"id"'):
            t = json.loads(line.rstrip(','))
            old[t['id']] = t
    return old


def build():
    items = playlist_items()
    ids = [it['contentDescriptor']['identifiers']['storeAdamID'] for it in items]
    prev = previews(ids)
    old = old_tracks()
    tracks = []
    for it, tid in zip(items, ids):
        art = it['artwork']['dictionary']
        o = old.get(tid, {})
        t = {
            'id': tid,
            'title': it['title'],
            'artist': ', '.join(l['title'] for l in it.get('subtitleLinks', [])) or it.get('artistName', ''),
            'ms': it.get('duration') or 0,
            'preview': prev.get(tid) or o.get('preview', ''),
            'art': art['url'].replace('{w}x{h}bb.{f}', '512x512bb.jpg'),
            'bg': '#' + art['bgColor'],
            'fg': '#' + art['textColor1'],
        }
        # accent: the most colourful of background and the two text colours, if it has colour at all
        key = max(('bgColor', 'textColor1', 'textColor2'), key=lambda k: chroma(art[k]))
        if chroma(art[key]) >= ACCENT_MIN_CHROMA:
            t['accent'] = '#' + art[key]
        if o.get('file'):
            t['file'] = o['file']
        tracks.append(t)
    return tracks, old


def main():
    tracks, old = build()
    if not tracks:
        sys.exit('empty playlist, not writing')
    lines = ['        ' + json.dumps(t, ensure_ascii=False) + ',' for t in tracks]
    if OUT.exists():
        current = [l for l in OUT.read_text(encoding='utf-8').splitlines() if l.strip().startswith('{"id"')]
        if current == lines:
            print(f'playlist unchanged ({len(tracks)} tracks)')
            return
    added = [t['title'] for t in tracks if t['id'] not in old]
    removed = [t['title'] for i, t in old.items() if i not in {x['id'] for x in tracks}]
    today = datetime.date.today().isoformat()
    OUT.write_text('\n'.join([
        f'// Generated from the Apple Music playlist "{PLAYLIST_NAME}" on {today} by tools/update_playlist.py.',
        "// Each track plays its 30-second Apple preview unless it has a `file`: drop an mp3 into",
        '// this folder (or tracks/) and add  "file": "tracks/name.mp3"  to that track for full playback.',
        "// bg / fg / accent are the cover's own colours, used to print each track's record label.",
        'window.STOLE_PLAYLIST = {',
        f"    name: '{PLAYLIST_NAME}',",
        f"    url: '{PLAYLIST_URL}',",
        '    tracks: [',
        *lines,
        '    ],',
        '};',
        '',
    ]), encoding='utf-8')
    print(f'playlist updated: {len(tracks)} tracks, +{len(added)} -{len(removed)}')
    for a in added:
        print('  + ' + a)
    for r in removed:
        print('  - ' + r)


if __name__ == '__main__':
    main()
