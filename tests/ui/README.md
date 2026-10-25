# Placement dialog visual QA

Tag-completion QA: open `/tag-completion.html` or run
`node tests/ui/tag-completion-qa.cjs` against the same local server. This uses
actual editors with delayed/error search fixtures, usage history and alias edits.
`/placement.html?mode=addition&tags=1` enables these fixtures inside the real
nested placement dialog. Search quality and settings reload are tested separately
against the shipped dictionary in `tests/tag-search.test.ts`.

Synchronization check: `node tests/ui/prompt-state-qa.cjs`. It renders actual split fields,
preset selection and generation stores with in-memory queue/settings adapters;
all enqueue calls are captured locally and never sent to an image service.

Model-aware token UI: run `node tests/ui/token-count-qa.cjs` or open
`/token-count.html` (`?mode=panel` or `?mode=scene` for final totals). It renders
the actual editor, prompt panel, character overlay and scene detail with
controlled local IPC responses. Cases cover model limits, delayed/out-of-order
responses, errors, duplicate requests, fragment changes, both character signs
and independent queue-round totals. These fixture counts test UI behavior;
tokenizer accuracy uses the separate official tokenizer reference tests.

Run from the repository root with Node.js and the project dependencies installed:

```sh
node node_modules/vite/bin/vite.js --config tests/ui/vite.config.ts
```

The automated `*-qa.cjs` scripts also need Playwright. Install it locally without
changing the project manifest or lockfile, then install its Chromium browser:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
```

Leave the Vite server running, and run a check in another terminal:

```sh
node tests/ui/tag-enter-qa.cjs
```

`tests/ui/browser-runtime.cjs` resolves the normal `playwright` package. An
existing external installation can instead be supplied through `NODE_PATH`
(the directory containing installed packages) or `NAIS_PLAYWRIGHT_MODULE`
(the module name or absolute path to the Playwright package).

Set `NAIS_BROWSER_EXECUTABLE` to use a particular Chrome/Chromium executable.
Without this setting, Windows uses system Chrome when it exists in the standard
Program Files location; otherwise the checks use Playwright's Chromium. Other
platforms default to Playwright's Chromium. No personal runtime path is required.

Open <http://127.0.0.1:5189/placement.html>. The page renders the production
`ScenePlacementDialog`, not a replica. It seeds 40 fictional fully clothed adult
character cards in browser memory and mocks `window.nais`. Only token counting,
empty tag autocomplete and memory-only card/scene/settings edits are allowed; all other IPC
channels throw. It does not load the Electron preload, app startup code, user
database, authentication, image files or generation APIs. Browser requests are
limited to the local development server by the HTML content security policy.

The fixtures cover repeated character assignments, empty seats with tags,
library-enabled characters, long character names/tags, 32 figures and initially
overlapping figures with coordinates disabled. Controls change the model, image
aspect ratio, fixture and theme. Close the placement dialog to inspect the last
patch and current merged scene state. Reload to reset everything.

Useful direct URLs:

- `/placement.html?size=wide&fixture=slots`
- `/placement.html?size=narrow&fixture=many`
- `/placement.html?model=v45&size=square&fixture=overlap`
- `/placement.html?open=0` (start with the controls visible)
- `/placement.html?mode=addition` (actual scene additions caller, then click 넓게 배치)
- `/placement.html?mode=sequence` (actual sequence caller, then click 넓게 배치)

The nested caller fixture has a 1536×640 scene while the default generation
request is 832×1216, to reveal accidental use of global dimensions. Its state is
shown in the second details disclosure after closing both dialogs. The mocks
acknowledge in-memory store changes but do not persist across page reloads.

Type-check the harness with:

```sh
node node_modules/typescript/bin/tsc --noEmit -p tests/ui/tsconfig.json
```

Check 1366×768 and 1024×768 viewports, and a narrow viewport where the inspector
stacks below the board. Exercise marker selection and movement, coordinate
edits, horizontal/vertical distribution, adding/deleting/assigning seats, tags,
coordinates OFF/ON, dialog expansion and close/reopen. Watch for unstable dialog
size, offscreen controls, label clipping, inaccessible overlapped figures and
changes to unrelated coordinates or tags. V4.5 should use grid centers while V5
supports continuous coordinates. The visible patch JSON is the persistence
boundary evidence; no actual image generation is performed.

All harness files live under `tests/ui`, already excluded by the installer's
`!tests/*` packaging rule. No production entry point imports this directory.

Scene grid navigation: open `/scene-grid.html` (`?kind=background` for the background library,
`?count=300` for more scenes per preset, `?busy=5` to mark the 5th scene as generating, `?panels=1`
to put scrollable fake side panels next to the grid for checking that Home/End/PageUp/PageDown only
move the grid when the last click or the focus was inside it; `?panels=app&left=560` lays the grid
out like the real app — a direct child of the row beside a 240px history column — to check that a
wide prompt panel no longer pushes the history off the window). It renders
the actual `SceneMode` with two fake presets of 120 fictional scenes (canvas-drawn thumbnails) and an
in-memory fake `window.nais`, so no network, file or NAI call is made. Covers the quick-scroll bar and
its bubble, scene find (`Ctrl+Shift+F`, Enter / Shift+Enter, Esc), Home/End/PageUp/PageDown, scroll
position per preset (`scene_grid_scroll`), and the one-line name list view (`scene_grid_view`) with
drag reorder, multi-select drag, Shift painting and the context menu. `window.sceneGridFixture` exposes
the recorded IPC calls, reorders and store state for checks from the browser console.

Worn-clothes auto exposure (입은 옷 자동 젖힘): open `/expose-notes.html` (`?mode=block` default).
It renders the actual components with fictional cards, fictional scene text and an in-memory fake
`window.nais`, so no network, file, database or NAI call is made and no personal data is involved.
`?mode=block` draws the collapsible 「자동 젖힘」 block with synthetic notes that cover all 13 statuses
(`&enabled=0` setting off, `&empty=1` no notes, `&rounds=2` two queue rounds with different results,
`&open=1` start expanded); `?mode=detail` is the real `SceneDetail` (notes come from the real
request builder); `?mode=placement` is the real placement dialog with synthetic notes (「자동 +N」 badges and hover);
`?mode=addition` is the real per-scene addition dialog opened on 「넓게 배치」, so the badges there come from the real request builder;
`?mode=main` is the main-tab 「자동 젖힘」 block (`MainExposeBlock`), which re-runs the real main request assembly read-only;
`?mode=picker&card=1|3` is the real outfit picker (`&notes=0` = scene unknown); `?mode=outfit` is the
real outfit tab with the 「카드 글에서 읽은 옷」 section; `?mode=settings` is the real settings dialog
opened on the 생성 tab (it also checks the two futa switches 「후타 자동 재조립」 and 「후타 시점·구도 정리」;
`&futa=0` starts with the first one off so the second one must be disabled). In the browser console
`await exposeFixture.check()` walks the DOM of the current mode and returns a pass/fail list (no
screenshots needed).

Body/futa reassembly (몸·후타): `?mode=body` draws the collapsible 「몸·후타」 block (`BodyBlock`) with synthetic
`BodyNote`s that cover all 7 kinds (replaced, removed, added, kept, unreadable, suspect, conflict) and
check the folded one-line summary (`&empty=1` draws nothing, `&quiet=1` is a futa that is drawn with nothing
to change = the single line 「후타 1명 · 바꾼 것 없음」, `&rounds=2` two queue rounds, `&open=1`
start expanded). The 「후타 N명」 count comes from the request's `futaPlan` (the harness passes it as `futa`),
never from guessing at the notes. `?mode=placement` also passes synthetic `bodyNotes` and `futaCharIds`, so the
placement dialog shows the 「후타」·「후타 의심」·「후타 충돌」·「후타 못 읽음」 badges on a second line under the card name
(they work with the auto-exposure setting off, too); only the card the plan names gets 「후타」.
`&futa=1` adds a fictional futa card (E) so `?mode=detail&futa=1` (real `SceneDetail`) and
`?mode=main&futa=1` (real main-tab assembly) show that the core module really puts `bodyNotes` and the
`futaPlan` on the request. `&futacard=1` adds the same card without touching the setting: with `&futa=0`
the block must say 「후타 카드 1장 · 재조립 꺼짐」 (the switch is off, not the futa unread; the request itself
is unchanged). `?mode=main&fake=1` needs no
core output: it adds synthetic `bodyNotes` and a two-futa `futaPlan` to the real main request, to check
that the main-tab block reads them (summary starts with 「후타 2명」, shown even with the auto-exposure
setting off).
