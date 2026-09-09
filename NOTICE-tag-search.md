# Offline tag search data

NAIS3 Custom includes a derived, read-only search database at
`resources/tag-search.sqlite`. Its precise source hashes, snapshot dates and
coverage are in `resources/tag-search-manifest.json`.

Sources and attribution:

- Danbooru contributors; metadata snapshot prepared by hlibr/baton4ik:
  https://huggingface.co/datasets/hlibr/danbooru-tag-metadata-snapshot
  Snapshot: 2026-04-08. Dataset metadata is published under MIT. Tag names,
  categories, post counts and active alias relationships are used. Deleted,
  retired and cyclic aliases do not create new suggested insertion targets.
  Previously bundled NAI-compatible names without a current alias target are
  retained for compatibility and marked as legacy (이전 태그) in search results.
- Danbooru wiki contributors; 2026-03-10 snapshot distributed by lylogummy:
  https://huggingface.co/datasets/lylogummy/danbooru_wikis_2026
  Korean alternate names and shortened English introductions are extracted.
  The mirror declares MIT; underlying Danbooru wiki text is attributed and
  redistributed under CC BY-SA 4.0, consistent with the existing NAIS3 wiki
  dataset. https://creativecommons.org/licenses/by-sa/4.0/
  Changes: deleted pages removed, markup removed, introductions limited to
  280 characters, titles normalized, aliases resolved, indexes generated.
- KiraraCape / Meiax, Danbooru Tag Assassin v1.1.2:
  https://github.com/Meiax/danbooru-tag-assassin
  GPL-3.0: Korean labels from `data/all-tags.json` and Korean synonyms from
  `data/aliases.json` only. No plugin code, images, user library data or models
  are included. The GPL-3.0 license is included in this application's LICENSE.
  Changes: Korean entries selected, invalid/non-Korean entries excluded,
  canonical tags resolved, labels and synonyms merged and corrected.
- Existing NAIS3 Custom Korean vocabulary, plus project-authored natural
  Korean aliases in `scripts/tag-search-korean.json` and deterministic
  adjective/noun combinations in `scripts/build-tag-search.py`.

The Korean vocabulary is not a translation of every artist, character or
franchise in Danbooru. Unsupported names remain in English. Dataset coverage
does not imply that every tag is understood by every NovelAI model.

Rebuild (development only):

For ordinary source builds, `npm install` restores the prebuilt dictionary from
the pinned `tag-data-2026-09-09` release in `qkr132-lab/nais3-custom` and verifies
its uncompressed SHA-256 and byte count against the committed manifest. Run
`npm run prepare:tag-search` to perform the same step explicitly. The large
generated database is excluded from Git; the source transformations below and
all local vocabulary corrections are included.

To regenerate the dictionary from the original source snapshots:

```text
node scripts/fetch-tag-search-data.mjs
python scripts/build-tag-search.py
node tests/run-tag-worker-check.cjs
```

The builder requires Python 3.10+, pyarrow and SQLite FTS5. The installed app
requires none of those build tools and performs no network requests for tag
search. Updating the source revision/hash is an explicit maintenance operation:
review the source terms and regression results before replacing the database.
User-authored Korean meanings and usage history stay in the user's settings
database and are never overwritten by dictionary updates.
