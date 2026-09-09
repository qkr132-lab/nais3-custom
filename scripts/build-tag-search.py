"""Build the offline, read-only search database. No network or user DB access.

python scripts/build-tag-search.py --sources .superloopy/tag-data
Source downloads and licenses: scripts/fetch-tag-search-data.mjs / NOTICE-tag-search.md.
Requires Python 3.10+, pyarrow, SQLite with FTS5 (build time only).
"""
import argparse
import ast
import hashlib
import gc
import json
import re
import sqlite3
import time
import unicodedata
from collections import defaultdict
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--sources', type=Path, default=ROOT / '.superloopy/tag-data')
args = parser.parse_args()

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def norm(s):
    return unicodedata.normalize('NFC', s).lower().replace('_', ' ').strip()

def compact(s):
    return re.sub(r'[\s_\-()/,;|]+', '', norm(s))

INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
VOWELS = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
FINALS = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
def initials(s):
    return ''.join(INITIALS[(ord(c)-0xac00)//588] if '가' <= c <= '힣' else c for c in compact(s))

def jamo(s):
    out = []
    for c in compact(s):
        n = ord(c)-0xac00
        out.append(INITIALS[n//588]+VOWELS[n//28%21]+FINALS[n%28] if 0 <= n < 11172 else c)
    return ''.join(out)

def aliases(s):
    # Old dictionary packs glosses and synonyms in parentheses/slashes.
    return list(dict.fromkeys(norm(x) for x in re.split(r'[(),/;|]', s) if x.strip()))

def clean_label(s):
    return aliases(s)[0] if aliases(s) else ''

def clean_body(s):
    s = re.sub(r'\[\[([^\]|]+)(?:\|([^\]]+))?\]\]', lambda m: (m[2] or m[1]).replace('_', ' '), s or '')
    s = re.sub(r'https?://\S+|\[/?[^\]]+\]', '', s)
    s = next((p for p in s.replace('\r', '').split('\n\n') if p.strip()), '')
    return re.sub(r'\s+', ' ', re.sub(r'^h\d\.\s*', '', s)).strip()[:280]

src = sqlite3.connect(args.sources / 'snapshot.sqlite')
raw_aliases = {norm(a): norm(b) for a, b in src.execute("SELECT antecedent_name, consequent_name FROM tag_aliases WHERE status='active'")}
def canonical(tag):
    seen = set()
    while tag in raw_aliases and tag not in seen:
        seen.add(tag)
        tag = raw_aliases[tag]
    return tag

types = {0:'general', 1:'artist', 3:'copyright', 4:'character', 5:'meta'}
# Inactive, empty, and deprecated spellings remain resolvable through active aliases,
# but are not suggested as duplicate or obsolete insertion targets.
catalog = {}
snapshot_names = set()
for name, cat, count, deprecated in src.execute('SELECT name,category,post_count,is_deprecated FROM tags'):
    name = norm(name)
    snapshot_names.add(name)
    if count and not deprecated and name not in raw_aliases:
        catalog[name] = {'tag':name, 'count':count, 'type':types.get(cat, 'general')}
# Retain the existing NAI vocabulary even when newer Danbooru terminology has
# deprecated it. Active aliases still resolve to their current canonical target.
for row in read(ROOT / 'resources/tags.json'):
    tag = norm(row['value'])
    if tag not in catalog and tag not in raw_aliases:
        catalog[tag] = {'tag':tag, 'count':row['count'], 'type':row['type'], 'legacy':int(tag in snapshot_names)}

ko = defaultdict(list)
en_aliases = defaultdict(list)
descriptions = {}
def add(tag, values, first=False):
    tag = canonical(norm(tag))
    if tag not in catalog:
        return
    values = [re.sub(r'\s+', ' ', v).strip() for v in values if isinstance(v, str) and re.search('[가-힣]', v)]
    values = [v for v in values if 1 <= len(v) <= 80 and '\ufffd' not in v and not re.search(r'https?://|[\u4e00-\u9fff\u3040-\u30ff]', v)]
    ko[tag] = list(dict.fromkeys((values + ko[tag]) if first else (ko[tag] + values)))

for row in read(args.sources / 'data_all-tags.json')['tags']:
    add(row['en'], aliases(row['labels'].get('ko', '')))
for tag, names in read(args.sources / 'data_aliases.json').items():
    if isinstance(names, list):
        add(tag, names)
for tag, value in read(ROOT / 'resources/tags-ko.json').items():
    # The old color composer put standalone color/body fragments in parentheses.
    # Those are not complete aliases: '눈동자' must not mean specifically blue eyes.
    add(tag, aliases(value.split('(')[0]), first=True)

wiki = pq.read_table(args.sources / 'wiki.parquet', columns=['title','body','other_names','is_deleted']).to_pylist()
for row in wiki:
    if not isinstance(row['title'], str):
        continue
    tag = canonical(norm(row['title']))
    if row['is_deleted'] or tag not in catalog:
        continue
    try:
        other = ast.literal_eval(row['other_names'] or '[]')
    except (ValueError, SyntaxError):
        other = []
    if isinstance(other, list):
        add(tag, other)
    if catalog[tag]['type'] in ('general','meta') or tag in ko:
        descriptions[tag] = clean_body(row['body'])

curated = read(ROOT / 'scripts/tag-search-korean.json')
missing = []
for tag, values in curated.items():
    if canonical(tag) not in catalog:
        missing.append(tag)
    add(tag, values, first=True)

# Productive adjective + noun forms. Only actual general tags are generated;
# never translate artist names or franchise names word by word.
modifiers = {
    'black':'검은/검정/검은색', 'white':'흰/하얀/흰색', 'red':'빨간/붉은/빨간색',
    'blue':'파란/푸른/파란색/청색', 'green':'초록/초록색/녹색', 'yellow':'노란/노란색',
    'purple':'보라색/보라', 'pink':'분홍/분홍색/핑크', 'brown':'갈색/밤색',
    'grey':'회색/그레이', 'orange':'주황색/주황', 'gold':'금색/황금색', 'silver':'은색',
    'multicolored':'여러 색의/다색', 'two-tone':'투톤/두 색의', 'rainbow':'무지개색',
    'dark':'어두운', 'light':'밝은', 'long':'긴', 'short':'짧은', 'large':'큰', 'small':'작은',
    'oversized':'헐렁한/오버사이즈', 'striped':'줄무늬/스트라이프', 'polka dot':'물방울무늬/도트',
    'plaid':'체크무늬/체크', 'checkered':'격자무늬', 'floral print':'꽃무늬', 'animal print':'동물무늬',
    'leopard print':'호피무늬/표범무늬', 'star print':'별무늬', 'heart print':'하트무늬',
    'frilled':'프릴 달린', 'lace-trimmed':'레이스 장식의', 'fur-trimmed':'털 장식의',
    'torn':'찢어진', 'wet':'젖은', 'dirty':'더러워진', 'blood-stained':'피 묻은',
    'glowing':'빛나는/발광하는', 'transparent':'투명한', 'translucent':'반투명한',
    'mechanical':'기계식/기계', 'robotic':'로봇', 'wooden':'나무로 된/목제',
    'metal':'금속', 'leather':'가죽', 'latex':'라텍스', 'denim':'데님', 'silk':'실크',
    'floating':'떠 있는', 'burning':'불타는', 'broken':'부서진', 'twin':'쌍둥이',
    'multiple':'여러 개의', 'single':'하나의', 'giant':'거대한', 'miniature':'아주 작은/미니어처'
}
base_labels = {t: clean_label(v[0]) for t,v in ko.items() if v}
composed = 0
for tag, entry in catalog.items():
    if entry['type'] != 'general':
        continue
    for prefix, forms in modifiers.items():
        if not tag.startswith(prefix+' '):
            continue
        rest = tag[len(prefix)+1:]
        if rest not in base_labels or catalog.get(rest,{}).get('type') != 'general':
            continue
        noun = base_labels[rest]
        # A complete phrase is generated for each modifier, not isolated color/part
        # fragments that could match a different body part accidentally.
        add(tag, [f'{f} {noun}' for f in forms.split('/')])
        composed += 1
    for prefix, suffix in [('holding ', '들고 있는'), ('wearing ', '착용한')]:
        rest = tag[len(prefix):] if tag.startswith(prefix) else ''
        if rest in base_labels and catalog.get(rest,{}).get('type') == 'general':
            add(tag, [f'{base_labels[rest]} {suffix}'])
            composed += 1

for alias, target in raw_aliases.items():
    target = canonical(target)
    if target in catalog:
        en_aliases[target].append(alias)

related = defaultdict(list)
for group in read(ROOT / 'scripts/tag-search-related.json'):
    for target in group['tags']:
        target = canonical(norm(target))
        if target in catalog:
            related[target].extend(group['words'])

output = ROOT / 'resources/tag-search.sqlite'
temp = output.with_suffix('.building.sqlite')
temp.unlink(missing_ok=True)
db = sqlite3.connect(temp)
db.executescript('''
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;
PRAGMA temp_store=MEMORY;
CREATE TABLE tags(id INTEGER PRIMARY KEY, tag TEXT NOT NULL UNIQUE, key TEXT NOT NULL, count INTEGER NOT NULL, type TEXT NOT NULL, ko TEXT, description TEXT, aliases TEXT NOT NULL, legacy INTEGER NOT NULL);
CREATE TABLE terms(key TEXT NOT NULL, tag_id INTEGER NOT NULL, kind INTEGER NOT NULL, PRIMARY KEY(key,tag_id,kind)) WITHOUT ROWID;
CREATE TABLE short_terms(key TEXT NOT NULL, kind INTEGER NOT NULL, ids TEXT NOT NULL, PRIMARY KEY(key,kind)) WITHOUT ROWID;
CREATE VIRTUAL TABLE substrings USING fts5(text, tokenize='trigram', detail=none);
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
''')
shorts = defaultdict(list)
short_seen = defaultdict(set)
term_count = 0
ordered = sorted(catalog.values(), key=lambda t:(-t['count'], t['tag']))
for idx, entry in enumerate(ordered, 1):
    tag = entry['tag']
    names = ko[tag]
    english = list(dict.fromkeys(en_aliases[tag]))
    db.execute('INSERT INTO tags VALUES (?,?,?,?,?,?,?,?,?)', (idx, tag, compact(tag), entry['count'], entry['type'], names[0] if names else None, descriptions.get(tag), json.dumps({'ko':names,'en':english},ensure_ascii=False),entry.get('legacy',0)))
    # Canonical name indexing lives in tags.key. terms is the smaller bilingual
    # alias index: exact/prefix(0), Korean suffix(1), initials(2), typing jamo(3).
    terms = set()
    for word in related[tag]:
        terms.add((compact(word), idx, 5))
    for name in names + english:
        key = compact(name)
        if not key:
            continue
        terms.add((key, idx, 0))
        if re.search('[가-힣]', name):
            terms.add((initials(name), idx, 2))
            terms.add((jamo(name), idx, 3))
            for start in range(1, len(key)-1):
                terms.add((key[start:], idx, 1))
    for key, tag_id, kind in terms:
        for size in (1,2):
            if len(key) < size:
                continue
            sk = (key[:size], kind)
            if len(shorts[sk]) < 256 and idx not in short_seen[sk]:
                short_seen[sk].add(idx)
                shorts[sk].append(idx)
    # English short prefixes also use popularity-ordered, bounded postings.
    key = compact(tag)
    for size in (1,2):
        sk = (key[:size], 4)
        if len(shorts[sk]) < 256:
            shorts[sk].append(idx)
    db.executemany('INSERT OR IGNORE INTO terms VALUES (?,?,?)', sorted(terms))
    term_count += len(terms)
    db.execute('INSERT INTO substrings(rowid,text) VALUES (?,?)', (idx,' '.join(dict.fromkeys(compact(n) for n in [tag]+english))))
    if idx % 100000 == 0:
        print('indexed', idx, flush=True)
db.executemany('INSERT INTO short_terms VALUES (?,?,?)', [(k,kind,json.dumps(ids,separators=(',',':'))) for (k,kind),ids in sorted(shorts.items())])
db.execute('CREATE INDEX tags_key ON tags(key)')
db.execute("INSERT INTO substrings(substrings) VALUES('optimize')")
stats = {
    'schema':1, 'snapshotDate':'2026-04-08', 'wikiDate':'2026-03-10',
    'tags':len(catalog), 'koreanTags':sum(bool(v) for v in ko.values()),
    'koreanAliases':sum(len(v) for v in ko.values()), 'englishAliases':sum(len(v) for v in en_aliases.values()),
    'terms':term_count, 'composedForms':composed, 'curatedEntries':len(curated)-len(missing),
    'relatedMappings':sum(len(v) for v in related.values()),
    'legacyTags':sum(t.get('legacy',0) for t in catalog.values()),
    'excludedCurated':missing,
    'sourceHashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.sources.iterdir()) if p.name in ['snapshot.sqlite','wiki.parquet','data_all-tags.json','data_aliases.json']}
}
db.execute('INSERT INTO metadata VALUES (?,?)', ('manifest',json.dumps(stats,ensure_ascii=False)))
db.commit()
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
db.close()
src.close()
gc.collect()
# Windows indexing/antivirus can briefly hold the freshly closed large file.
# Retain the verified .building.sqlite on failure; never destroy the old index.
for attempt in range(10):
    try:
        temp.replace(output)
        break
    except PermissionError:
        if attempt == 9:
            raise
        time.sleep(0.2)
stats['databaseSha256'] = hashlib.sha256(output.read_bytes()).hexdigest()
stats['databaseBytes'] = output.stat().st_size
(ROOT / 'resources/tag-search-manifest.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(stats,ensure_ascii=False,indent=2),flush=True)
