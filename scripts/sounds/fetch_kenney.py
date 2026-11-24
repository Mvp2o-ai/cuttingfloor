"""Prepares Kenney's audio packs (kenney.nl, CC0) as a sound library pack for scripts/sounds/load.ts.

Each pack is downloaded as the site serves it (a pack page, then its signed download link), and
taken only when its License.txt says CC0. Sounds are named from their file names; the category
comes from the name where it says what the sound is (a footstep, a door), else from the pack.

    python3 -I fetch_kenney.py <pack dir>

Writes <pack dir>/pack.json, manifest.jsonl and files/<pack>/<file>.
"""

import http.cookiejar
import io
import json
import os
import re
import sys
import urllib.request
import zipfile

# Pack slug on kenney.nl, and the category its sounds take when their names don't say.
PACKS = {
    'impact-sounds': 'Impacts and hits',
    'interface-sounds': 'Interface and game',
    'ui-audio': 'Interface and game',
    'digital-audio': 'Interface and game',
    'casino-audio': 'Interface and game',
    'rpg-audio': 'Interface and game',
    'sci-fi-sounds': 'Sci-fi',
    'voiceover-pack': 'Voices',
    'voiceover-pack-fighter': 'Voices',
    'music-jingles': 'Music and instruments',
}
# A word in the file name that says what the sound is, and its category.
BY_NAME = [
    (r'footstep', 'Footsteps and movement'),
    (r'door', 'Doors'),
    (r'explosion', 'Weapons and explosions'),
    (r'laser', 'Sci-fi'),
    (r'impact|punch|hit|thud', 'Impacts and hits'),
    (r'glass', 'Glass and breaking'),
]
AUDIO = re.compile(r'\.(ogg|wav|mp3|flac)$', re.I)
AGENT = 'Mozilla/5.0 (cuttingfloor sound library loader)'


def opener():
    jar = http.cookiejar.CookieJar()
    o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    o.addheaders = [('User-Agent', AGENT)]
    return o


def download(o, slug):
    page = f'https://kenney.nl/assets/{slug}'
    o.open(page).read()
    link = 'https://kenney.nl/download-link/' + f'assets/{slug}'.encode().hex()
    request = urllib.request.Request(link, headers={'Referer': page})
    url = json.loads(o.open(request).read())['url']
    if not url.startswith('https://kenney.nl/'):
        raise ValueError(f'{slug}: download link points elsewhere')
    return o.open(url).read()


NUMBERS = 'zero one two three four five six seven eight nine ten'.split()


def words(stem):
    """impactMetal_medium_000 -> impact metal medium 1; a name that is only a number is spelled."""
    if stem.isdigit() and int(stem) <= 10:
        return NUMBERS[int(stem)]
    spaced = re.sub(r'([a-z])([A-Z0-9])', r'\1 \2', stem)
    parts = re.split(r'[_\-\s]+', spaced)
    out = []
    for p in parts:
        if p.isdigit():
            # Zero-padded numbering (000, 001) counts from zero; plain numbers from one.
            out.append(str(int(p) + 1) if len(p) > 1 and p.startswith('0') else p)
        elif p:
            out.append(p.lower())
    return ' '.join(out)


def main(out):
    o = opener()
    os.makedirs(os.path.join(out, 'files'), exist_ok=True)
    kept = 0
    with open(os.path.join(out, 'manifest.jsonl'), 'w') as manifest:
        for slug, default in PACKS.items():
            z = zipfile.ZipFile(io.BytesIO(download(o, slug)))
            licence = next((n for n in z.namelist() if n.lower().endswith('license.txt')), None)
            text = z.read(licence).decode('utf-8', 'replace') if licence else ''
            if 'CC0' not in text and 'publicdomain/zero' not in text:
                print(f'skip {slug}: no CC0 licence in the pack', file=sys.stderr)
                continue
            for member in z.namelist():
                if not AUDIO.search(member) or member.startswith('__MACOSX'):
                    continue
                stem = os.path.splitext(os.path.basename(member))[0]
                # Folders that tell sounds apart (Male/ and Female/ voices), not the pack's own.
                folders = [f for f in os.path.dirname(member).split('/') if f and f.lower() not in ('audio', 'sounds', 'ogg', 'wav')]
                name = words(stem)
                if not name:
                    continue
                if folders:
                    name = f'{name} ({", ".join(words(f) for f in folders)})'
                key = re.sub(r'[^a-z0-9]+', '-', '/'.join(folders + [stem]).lower()).strip('-')
                target_rel = f'files/{slug}/{key}{os.path.splitext(member)[1].lower()}'
                target = os.path.join(out, target_rel)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, 'wb') as f:
                    f.write(z.read(member))
                category = next((c for pattern, c in BY_NAME if re.search(pattern, name)), default)
                tags = [t for t in re.findall(r'[a-z]+', name) if len(t) > 1]
                tags += [w for w in slug.replace('-', ' ').split() if w not in ('audio', 'sounds', 'pack')]
                manifest.write(json.dumps({
                    'id': f'{slug}-{key}',
                    'file': target_rel,
                    'name': name[:1].upper() + name[1:],
                    'description': f'{name[:1].upper() + name[1:]}, from Kenney\'s {slug.replace("-", " ")} pack',
                    'tags': list(dict.fromkeys(tags)),
                    'category': category,
                    'author': 'Kenney',
                    'source_url': f'https://kenney.nl/assets/{slug}',
                    'licence': 'CC0',
                }) + '\n')
                kept += 1
    with open(os.path.join(out, 'pack.json'), 'w') as f:
        json.dump({'id': 'kenney', 'licence': 'CC0', 'source_url': 'https://kenney.nl/assets/category:Audio'}, f)
    print(f'kenney: {kept} sounds')


if __name__ == '__main__':
    main(sys.argv[1])
