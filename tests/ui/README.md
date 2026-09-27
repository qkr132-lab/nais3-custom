# Placement dialog visual QA

Tag-completion QA: open `/tag-completion.html` or run
`node tests/ui/tag-completion-qa.cjs` against the same local server. This uses
actual editors with delayed/error search fixtures, usage history and alias edits.
`/placement.html?mode=addition&tags=1` enables these fixtures inside the real
nested placement dialog. Search quality and settings reload are tested separately
against the shipped dictionary in `tests/tag-search.test.ts`.

Strength/synchronization checks: `node tests/ui/censor-strength-qa.cjs` and
`node tests/ui/prompt-state-qa.cjs`. The latter renders actual split fields,
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
