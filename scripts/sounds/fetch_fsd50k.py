"""Prepares FSD50K's CC0 clips as a sound library pack for scripts/sounds/load.ts.

FSD50K (Fonseca et al., Zenodo record 4060432; the dataset CC BY 4.0) holds 51,197 Freesound
clips, each under its uploader's own licence; only the CC0 ones (19,873) are taken. Each keeps its
Freesound title, description, tags and uploader, and its AudioSet labels as tags. Its category is
the first in PRIORITY that any of its labels is in (a knife whoosh is a whoosh before cutlery).

    python3 -I fetch_fsd50k.py <download dir> <pack dir>

The download dir holds the record's files as Zenodo names them, the split audio archives joined
first (zip -s 0 FSD50K.dev_audio.zip --out dev.zip, the same for eval). Writes <pack dir>/pack.json,
manifest.jsonl and files/<id>.wav. Run where nothing else is trusted to it: it only reads the zips.
"""

import csv
import html
import io
import json
import os
import re
import sys
import zipfile

# AudioSet labels (FSD50K's names) to the library's categories; a label in none is skipped over.
CATEGORIES = {
    'Footsteps and movement': ['Walk_and_footsteps', 'Run'],
    'Impacts and hits': ['Thump_and_thud', 'Boom', 'Slam', 'Crack', 'Crushing', 'Tap', 'Wood',
                         'Knock', 'Hands', 'Finger_snapping'],
    'Glass and breaking': ['Shatter', 'Glass', 'Chink_and_clink'],
    'Whooshes': ['Whoosh_and_swoosh_and_swish'],
    'Weapons and explosions': ['Gunshot_and_gunfire', 'Explosion', 'Fireworks'],
    'Weather and nature': ['Thunderstorm', 'Thunder', 'Rain', 'Raindrop', 'Wind', 'Fire',
                           'Crackle', 'Stream', 'Waves_and_surf', 'Ocean'],
    'Water': ['Splash_and_splatter', 'Drip', 'Trickle_and_dribble', 'Pour', 'Fill_(with_liquid)',
              'Gurgling', 'Boiling', 'Liquid', 'Water'],
    'Animals': ['Bark', 'Dog', 'Growling', 'Meow', 'Purr', 'Cat', 'Chicken_and_rooster', 'Crow',
                'Gull_and_seagull', 'Chirp_and_tweet', 'Bird_vocalization_and_bird_call_and_bird_song',
                'Bird', 'Frog', 'Cricket', 'Insect', 'Fowl', 'Livestock_and_farm_animals_and_working_animals',
                'Wild_animals', 'Animal'],
    'Vehicles': ['Accelerating_and_revving_and_vroom', 'Engine_starting', 'Idling', 'Car_passing_by',
                 'Race_car_and_auto_racing', 'Vehicle_horn_and_car_horn_and_honking', 'Traffic_noise_and_roadway_noise',
                 'Motorcycle', 'Car', 'Bus', 'Truck', 'Subway_and_metro_and_underground', 'Train',
                 'Fixed-wing_aircraft_and_airplane', 'Aircraft', 'Boat_and_Water_vehicle',
                 'Skateboard', 'Bicycle', 'Motor_vehicle_(road)', 'Engine', 'Vehicle'],
    'Crowds': ['Applause', 'Cheering', 'Clapping', 'Crowd', 'Chatter', 'Human_group_actions',
               'Conversation'],
    'Laughter': ['Laughter', 'Giggle', 'Chuckle_and_chortle'],
    'Voices': ['Screaming', 'Yell', 'Shout', 'Crying_and_sobbing', 'Whispering', 'Child_speech_and_kid_speaking',
               'Female_speech_and_woman_speaking', 'Male_speech_and_man_speaking', 'Speech_synthesizer',
               'Speech', 'Human_voice'],
    'Body sounds': ['Breathing', 'Gasp', 'Sigh', 'Cough', 'Sneeze', 'Burping_and_eructation', 'Fart',
                    'Chewing_and_mastication', 'Respiratory_sounds'],
    'Doors': ['Sliding_door', 'Doorbell', 'Door', 'Drawer_open_or_close', 'Cupboard_open_or_close'],
    'Home and kitchen': ['Cutlery_and_silverware', 'Dishes_and_pots_and_pans', 'Frying_(food)',
                         'Microwave_oven', 'Sink_(filling_or_washing)', 'Bathtub_(filling_or_washing)',
                         'Water_tap_and_faucet', 'Toilet_flush', 'Keys_jangling', 'Zipper_(clothing)',
                         'Coin_(dropping)', 'Domestic_sounds_and_home_sounds'],
    'Paper and objects': ['Crumpling_and_crinkling', 'Tearing', 'Packing_tape_and_duct_tape',
                          'Scissors', 'Writing', 'Squeak', 'Rattle'],
    'Tools and machines': ['Drill', 'Sawing', 'Hammer', 'Power_tool', 'Ratchet_and_pawl', 'Tools',
                           'Mechanical_fan', 'Printer', 'Typewriter', 'Mechanisms', 'Hiss', 'Buzz',
                           'Screech'],
    'Clocks and tech': ['Alarm', 'Siren', 'Ringtone', 'Telephone', 'Camera', 'Computer_keyboard',
                        'Typing', 'Tick-tock', 'Tick', 'Clock'],
    'Bells': ['Church_bell', 'Bicycle_bell', 'Wind_chime', 'Chime', 'Gong', 'Cowbell', 'Bell'],
    'Music and instruments': ['Scratching_(performance_technique)', 'Female_singing', 'Male_singing',
                              'Singing', 'Snare_drum', 'Bass_drum', 'Hi-hat', 'Crash_cymbal', 'Cymbal',
                              'Drum_kit', 'Tabla', 'Drum', 'Tambourine', 'Rattle_(instrument)',
                              'Marimba_and_xylophone', 'Glockenspiel', 'Mallet_percussion', 'Percussion',
                              'Electric_guitar', 'Acoustic_guitar', 'Bass_guitar', 'Guitar', 'Strum',
                              'Harp', 'Plucked_string_instrument', 'Bowed_string_instrument', 'Piano',
                              'Organ', 'Keyboard_(musical)', 'Harmonica', 'Accordion', 'Trumpet',
                              'Brass_instrument', 'Wind_instrument_and_woodwind_instrument',
                              'Musical_instrument', 'Music'],
}
# A clip with labels in more than one category goes to the first here: the sounds an edit asks
# for by name before the settings and families they come from.
PRIORITY = ['Whooshes', 'Weapons and explosions', 'Footsteps and movement', 'Glass and breaking',
            'Doors', 'Laughter', 'Crowds', 'Bells', 'Clocks and tech', 'Impacts and hits',
            'Weather and nature', 'Animals', 'Vehicles', 'Water', 'Tools and machines', 'Body sounds',
            'Voices', 'Paper and objects', 'Home and kitchen', 'Music and instruments']
assert sorted(PRIORITY) == sorted(CATEGORIES)


def category_of(labels):
    have = set(labels)
    return next((c for c in PRIORITY if have.intersection(CATEGORIES[c])), None)
CC0 = 'http://creativecommons.org/publicdomain/zero/1.0/'


def words(label):
    """An AudioSet label as plain words: Walk_and_footsteps -> walk, footsteps."""
    return label.replace('_and_', ', ').replace('_', ' ').lower()


def clean(text, most):
    text = html.unescape(re.sub(r'<[^>]+>', ' ', text or ''))
    text = re.sub(r'https?://\S+|www\.\S+', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text if len(text) <= most else text[: most - 1].rsplit(' ', 1)[0] + '…'


def title(name):
    name = re.sub(r'\.(wav|aiff?|flac|mp3|ogg)$', '', name or '', flags=re.I)
    name = re.sub(r'[_]+', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return clean(name[:1].upper() + name[1:], 120) or 'Untitled'


def main(dl, out):
    def read(zip_name, member):
        with zipfile.ZipFile(os.path.join(dl, zip_name)) as z:
            return z.read(member)

    labels = {}
    for split in ('dev', 'eval'):
        rows = csv.DictReader(io.StringIO(read('FSD50K.ground_truth.zip', f'FSD50K.ground_truth/{split}.csv').decode()))
        for r in rows:
            labels[(split, r['fname'])] = r['labels'].split(',')
    os.makedirs(os.path.join(out, 'files'), exist_ok=True)
    kept = 0
    with open(os.path.join(out, 'manifest.jsonl'), 'w') as manifest:
        for split, audio in (('dev', 'dev.zip'), ('eval', 'eval.zip')):
            info = json.loads(read('FSD50K.metadata.zip', f'FSD50K.metadata/{split}_clips_info_FSD50K.json'))
            with zipfile.ZipFile(os.path.join(dl, audio)) as z:
                for fname, clip in info.items():
                    if clip.get('license') != CC0:
                        continue
                    clip_labels = labels.get((split, fname), [])
                    category = category_of(clip_labels)
                    if not category:
                        continue
                    member = f'FSD50K.{split}_audio/{fname}.wav'
                    target = os.path.join(out, 'files', f'{fname}.wav')
                    with z.open(member) as src, open(target, 'wb') as dst:
                        dst.write(src.read())
                    tags = []
                    for t in [words(l) for l in clip_labels] + [str(t).lower() for t in clip.get('tags', [])]:
                        if t and t not in tags:
                            tags.append(t)
                    manifest.write(json.dumps({
                        'id': fname,
                        'file': f'files/{fname}.wav',
                        'name': title(clip.get('title')),
                        'description': clean(clip.get('description'), 600),
                        'tags': tags[:30],
                        'category': category,
                        'author': clip.get('uploader') or None,
                        'source_url': f'https://freesound.org/s/{fname}/',
                        'licence': 'CC0',
                    }) + '\n')
                    kept += 1
    with open(os.path.join(out, 'pack.json'), 'w') as f:
        json.dump({
            'id': 'fsd50k',
            'licence': 'CC0 sounds from FSD50K (Fonseca et al. 2022, CC BY 4.0), first shared on Freesound',
            'source_url': 'https://zenodo.org/records/4060432',
        }, f)
    print(f'fsd50k: {kept} CC0 clips')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
