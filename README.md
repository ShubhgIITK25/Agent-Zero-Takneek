# Nawabs Submission for Agent Zero

Monaco Based Code editor integrated with a multi agent orchestrator. The harness helps achieve great coding capabilities combined with our user friendly features.

```
├── .github
│   └── workflows
├── electron
│   ├── main.ts
│   ├── model-health.ts
│   ├── orchestrator-bridge.ts
│   ├── preload.ts
│   ├── python-interpreter.ts
│   └── tsconfig.json
├── orchestrator
│   ├── agents.ts
│   ├── agentsmd.ts
│   ├── budget.ts
│   ├── compaction.ts
│   ├── diff.ts
│   ├── ignore.ts
│   ├── index.ts
│   ├── models.ts
│   ├── orchestrator.ts
│   ├── protocol.ts
│   ├── providers.ts
│   ├── router.ts
│   ├── store.ts
│   ├── tools.ts
│   └── tsconfig.json
├── retrieval-service
│   ├── README.md
│   ├── chunker.py
│   ├── embeddings.py
│   ├── identifiers.py
│   ├── indexer.py
│   ├── languages.py
│   ├── requirements.txt
│   ├── retrieval.py
│   ├── server.py
│   ├── store.py
│   ├── test_recovery.py
│   ├── test_recovery_e2e.py
│   └── verify.py
├── src
│   ├── app
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components
│   │   ├── ChatPanel.tsx
│   │   ├── Dashboard.tsx
│   │   ├── DiffReview.tsx
│   │   ├── DiffReviewPane.tsx
│   │   ├── EditorPane.tsx
│   │   ├── FileTree.tsx
│   │   ├── InlineDiffEditor.tsx
│   │   ├── SettingsPanel.tsx
│   │   ├── StatusBar.tsx
│   │   ├── Tabs.tsx
│   │   └── TerminalPanel.tsx
│   └── lib
│       ├── electron-api.ts
│       ├── language.ts
│       ├── review-buffer.ts
│       └── trace.ts
├── tests
│   ├── backtrack.js
│   ├── cancel.js
│   ├── execution-graph.js
│   ├── gemini.js
│   ├── git-tool.js
│   ├── health.js
│   ├── ignore.js
│   ├── model-health.js
│   ├── parallel.js
│   ├── protocol.js
│   ├── python-interpreter.js
│   ├── ratelimit.js
│   ├── replan.js
│   ├── resume.js
│   ├── review-buffer.js
│   ├── scheduling.js
│   ├── task-completion.js
│   ├── tree.js
│   ├── unit.js
│   └── watcher.js
├── .gitignore
├── README.md
├── build.cmd
├── launch.cmd
├── next-env.d.ts
├── next.config.js
├── package-lock.json
├── package.json
├── rundev.cmd
├── setup.cmd
└── tsconfig.json
```

## Deliverables
- `documentation` - Contains everything about our project. All of the architecture and everything.
- `binary files` - Cross platform build files to install on any operating system easily (check docs for exact process)
