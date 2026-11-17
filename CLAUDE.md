# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Glass is an Electron desktop assistant (fork of pickle-com/glass): it listens to mic and system audio, transcribes in real time, makes live meeting summaries, and answers questions ("Ask") using the screen and the transcript. It runs from the menu bar (the dock icon is hidden) and is excluded from screen capture.

## Commands

Node **20.x** is required (`.nvmrc`), because native deps (`better-sqlite3`, `keytar`, `sharp`) are rebuilt for Electron by `postinstall`.

```bash
npm run setup            # first time: install root + pickleglass_web, build web, start
npm start                # build renderer bundles (esbuild) then launch Electron
npm run watch:renderer   # rebuild renderer bundles on change (re-run electron to pick them up)
npm run build:web        # Next.js static export -> pickleglass_web/out (required before start)
npm run build            # full production build via electron-builder (macOS dmg/zip)
npm run package          # unpacked build (--dir), quicker for local testing
```

### Checks: run after every change
```bash
npm run check                               # lint (errors only) + all tests; must stay green
npm run lint                                # ESLint incl. warnings (unused vars etc.)
npm test                                    # all test/**/*.test.js
npm test -- test/whisper.test.js            # one file
npm test -- --test-name-pattern="close"     # tests matching a name
DEBUG_TESTS=1 npm test                      # show app console.log output (silenced by test/setup.js)
```
- Tests use `node:test` + `node:assert`, but `scripts/run-tests.js` runs them inside **Electron's Node** (`ELECTRON_RUN_AS_NODE=1`), not the system `node`. Native modules (`better-sqlite3`, `keytar`) are compiled for Electron's ABI, so plain `node --test` can't load them.
- Tests `require` modules from `src/` directly. Main-process modules load fine outside a real Electron app as long as they don't touch `app`/`BrowserWindow` at require time. Keep that property: do Electron calls inside functions.
- DB tests point the `sqliteClient` singleton at a temp file per test (see `test/sqlite.test.js`). Use the same pattern for repository tests.
- To test a pure helper inside a module, export it with a `// Exported for tests.` comment (as in `whisper.js`).
- ESLint 9 flat config (`eslint.config.js`): main/Node code is CommonJS, `src/ui/**` is browser ESM, and `src/ui/listen/audioCore` is CommonJS bundled for the browser. Vendored and generated files (`src/ui/assets`, `public/assets`, `audioCore/aec.js`) and the Next.js frontend (which has its own `next lint`) are ignored. Errors fail the check; warnings are existing upstream debt.
- Don't run `eslint --fix` or `prettier --write` over the whole repo. Upstream formatting is inconsistent and the diff would be huge. Format only the code you touch.
- CI (`.github/workflows/build.yml`) runs lint → test → macOS production build on push to `main`.
- A Claude Code Stop hook (`.claude/settings.json` → `.claude/hooks/check-on-stop.js`) runs `npm run check` at the end of a turn whenever watched JS/JSON files differ from HEAD, and blocks the stop with the failures (max 3 times in a row). It skips changes that already passed; that state lives in `.git/claude-check-ok`.
- When launching Electron from a VSCode terminal or tool call, unset `ELECTRON_RUN_AS_NODE` (`env -u ELECTRON_RUN_AS_NODE npm start`). Otherwise Electron silently runs as plain Node.
- `postbuild`/`postpackage` run `scripts/reset-tcc.js`, which resets the macOS Screen Recording grant for `com.pickle.glass`. A rebuild changes the code signature and invalidates the old grant, so permission has to be granted again after each build.

### Environment variables
- `GLASS_DEVTOOLS=1` opens DevTools for all windows; `GLASS_DEVTOOLS=listen` opens them only for the listen window. This only works when the app is not packaged.
- `OPENAI_TRANSCRIBE_LANG` overrides the OpenAI STT language.
- `pickleglass_API_URL` / `pickleglass_WEB_URL` / ports are set at runtime by `startWebStack()`. Don't configure them by hand.

## Architecture

`docs/DESIGN_PATTERNS.md` is the authoritative design doc. It refers to `src/common/...`, but that code actually lives in **`src/features/common/...`**.

### Processes and layers
- **Main process** (`src/index.js`): startup order matters. It goes: Firebase init → `databaseInitializer` (SQLite) → `authService` → `modelStateService` → `featureBridge`/`windowBridge` IPC registration → web data handlers → web stack → `createWindows()` → tray. `before-quit` runs an ordered graceful shutdown (tray → listen session → end active sessions → Ollama → DB close).
- **IPC**: renderer → main calls are registered centrally in `src/bridge/featureBridge.js` (feature services) and `src/bridge/windowBridge.js` (window control). `src/bridge/internalBridge.js` is an EventEmitter that connects services to the window manager. The renderer-side API is `window.api.*` in `src/preload.js`, namespaced per UI component (`askView`, `listenCapture`, `settingsView`, …). A new IPC channel needs both a `featureBridge` handler and a `preload.js` entry.
- **Renderer UI** (`src/ui/`): Lit web components (vendored `lit-core` in `src/ui/assets`), bundled by `build.js` into `public/build/header.js` (from `HeaderController.js`) and `public/build/content.js` (from `PickleGlassApp.js`). Edits under `src/ui` need a renderer rebuild to take effect. Every feature window (listen, ask, settings, shortcut-settings) loads the same `src/ui/app/content.html` with a `?view=` query param; the `header` window is separate.
- **Windows** (`src/window/windowManager.js`): a `windowPool` Map keyed by name. Child windows are positioned relative to the header by `windowLayoutManager` and animated by `smoothMovementManager`.

### Features: Service → Repository
Code is organized by feature under `src/features/` (`ask`, `listen` with `stt/` + `summary/`, `settings`, `shortcuts`, `tray`, `common`). Services hold the logic, and repositories are the only code that touches databases.

Each repository directory has `sqlite.repository.js` and `firebase.repository.js` with identical interfaces, plus an `index.js` adapter. The adapter picks Firebase if the user is logged in and SQLite otherwise, and injects `uid` from `authService`, so services never pass user IDs. Firebase writes of sensitive fields go through the encrypted Firestore converter (`common/repositories/firestoreConverter.js` + `encryptionService`).

SQLite schema lives only in `src/features/common/config/schema.js`. `sqliteClient.synchronizeSchema()` creates missing tables and `ALTER TABLE ADD COLUMN`s missing columns on startup. There are no migration files, so add columns to the schema and they get applied automatically.

### AI providers
`src/features/common/ai/factory.js` holds the `PROVIDERS` registry: openai, openai-glass, gemini, anthropic, deepgram, ollama (dynamic models), whisper (local, main-process only). Each provider lists its LLM/STT models and a lazy `handler` module. Provider modules in `ai/providers/` export `createSTT`, `createLLM`, and `createStreamingLLM`. API keys and selected models are managed by `modelStateService` (stored in SQLite `provider_settings`; `electron-store` is only read for legacy migration). Local models are handled by `ollamaService`, `whisperService`, and `localAIManager`. Prompts live in `common/prompts/`.

### Audio / STT pipeline
`sttService` keeps two STT sessions: **"my"** (microphone) and **"their"** (system audio), each with its own VAD settings and reconnect/renew logic.
- macOS system audio comes from the bundled `src/ui/assets/SystemAudioDump` binary, which `sttService` spawns. Its stdout PCM is sent to the listen renderer as `system-audio-data`. The renderer (`src/ui/listen/audioCore/listenCapture.js`) applies gain (and AEC, currently disabled) and sends chunks back via `window.api.listenCapture.sendSystemAudioContent` → `sttService` → the provider.
- The mic is captured in the renderer with `getUserMedia` and sent via `sendMicAudioContent`.
- On Windows, system audio uses Electron loopback (`setDisplayMediaRequestHandler` in `index.js`).
- `listenService` orchestrates the session, and `summaryService` produces the live summaries.
- The `aec/` git submodule (Rust AEC) is usually empty in checkouts.

### Web dashboard (`pickleglass_web/`)
- Next.js 14 with `output: 'export'`. The static build in `pickleglass_web/out` is served by an Express server **inside the Electron main process**. `startWebStack()` quits the app if `out/` is missing.
- `pickleglass_web/backend_node/` is an Express API mounted in-process. It never touches the DB. Instead, `ipcRequest()` emits `web-data-request` on an in-process EventEmitter (`eventBridge`), and `setupWebDataHandlers()` in `src/index.js` answers by calling the repositories.
- Ports are picked dynamically and passed to the frontend through `runtime-config.json`, which is written to the OS temp dir.
- Deep links (`pickleglass://`) handle the Firebase auth callback and personalize flows (`handleCustomUrl` in `src/index.js`).

### Other
- `functions/` contains Firebase Cloud Functions (Node 20), deployed separately via `firebase.json`.
- Many code comments are in Korean (from the upstream project).
- The fork-specific changes (OpenAI STT reconnect, gain boost, multilingual summaries, etc.) are documented at the bottom of `README.md`.
