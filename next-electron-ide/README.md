# NEXide — a minimal IDE with Next.js + Electron

A small but functional desktop code editor: file explorer, tabbed Monaco
editor, save/dirty tracking, and native "Open Folder" dialog — built as a
starting scaffold, not a finished product.

## Architecture

```
next-electron-ide/
├── electron/              # Electron main process (TypeScript, compiled to electron-dist/)
│   ├── main.ts             # BrowserWindow, native menu, filesystem IPC handlers
│   └── preload.ts          # contextBridge — the ONLY thing the renderer can call into Node with
├── src/                     # Next.js app (the UI), loaded by BrowserWindow — named `src/`
│                            #   because Next.js only auto-detects `app/` at the project
│                            #   root or under `src/`, not under an arbitrary folder
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx         # top-level state: open folder, open tabs, active file
│   │   └── globals.css      # VS Code-ish dark theme
│   ├── components/
│   │   ├── FileTree.tsx     # recursive, lazily-expanded folder tree
│   │   ├── Tabs.tsx         # open-file tab bar with dirty (•) indicator
│   │   ├── EditorPane.tsx   # Monaco editor, Ctrl/Cmd+S save binding
│   │   ├── StatusBar.tsx    # also hosts the terminal toggle
│   │   └── TerminalPanel.tsx # xterm.js, wired to a real shell via node-pty over IPC
│   └── lib/
│       ├── electron-api.ts  # shared TS types + `window.electronAPI` global typing
│       └── language.ts      # file extension → Monaco language id
├── next.config.js          # static export (output: 'export') so Electron can load it as local files
└── package.json
```

### Why it's split this way

- **Electron main process** is the only place with real Node/filesystem access (`fs/promises`).
  It never touches the DOM.
- **preload.ts** exposes a narrow, typed `window.electronAPI` surface via
  `contextBridge`, with `contextIsolation: true` and `nodeIntegration: false`.
  The renderer can never `require('fs')` directly — this is the standard
  Electron security boundary, keep it that way even as you extend the app.
- **Next.js renderer** is a normal React app that happens to be statically
  exported and loaded from disk (`file://.../renderer-out/index.html`) in
  production, or from `http://localhost:3210` during `npm run dev`.

## Getting started

```bash
npm install
npm run dev
```

This runs Next.js dev server and Electron concurrently (`concurrently` +
`wait-on`), with hot reload on the renderer side. Use **File → Open
Folder…** (or `Cmd/Ctrl+O`) to pick a project directory; click files in the
sidebar to open them in tabs; `Cmd/Ctrl+S` to save; **View → Toggle
Terminal** (or `Cmd/Ctrl+\``, or the Terminal button in the status bar) for
a real shell (PowerShell/cmd on Windows, `$SHELL` elsewhere) spawned via
`node-pty` in the main process and rendered with `xterm.js`.

`node-pty` is a native module, so after `npm install` it needs to be built
against Electron's ABI rather than your system Node's — the `postinstall`
script (`electron-builder install-app-deps`) does this automatically. If
the terminal doesn't open, check the Electron devtools console: a missing
native build toolchain (Python + a C++ compiler; on Windows, the
"Desktop development with C++" workload) is the usual cause — see
node-pty's README for platform prerequisites.

## Production build

```bash
npm run build   # next build (static export) + tsc for electron/
npm run dist    # electron-builder — produces installers in release/
```

## What's intentionally NOT here (extend as needed)

This is a scaffold, sized to actually run rather than to be exhaustive.
Natural next additions, each fairly self-contained given the IPC pattern
already in place:

- **Multi-root workspaces / recent folders** — persist via `electron-store`.
- **Search across files** — a `fs:grep` IPC handler (ripgrep binary) + a
  results panel component.
- **Git integration** — shell out to `git` from the main process, surface
  status/diff in the sidebar.
- **Extension/plugin system, LSP** — this is where it becomes a "real" IDE;
  worth designing deliberately rather than bolting on.
- **Unsaved-changes-on-close guard**, multi-window support, settings UI.

## Notes for your Takneek build

If you're adapting this for the agentic-IDE project: swap the file-tree +
editor shell in here for your MUI component library, and put the
FastAPI/Ollama agent calls behind their own IPC channel (or straight
`fetch` to `localhost:8000`, since your agent backend is a separate FastAPI
process) rather than routing them through Electron's main process — main
process IPC is really only needed for things that require Node/OS access
(filesystem, PTY, native dialogs).
