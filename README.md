# pi-threading

A minimal Pi extension scaffold for orchestrating specialist subagents.

## What this starter gives you

- A root `index.ts` extension entrypoint
- A `/subagents` command placeholder
- A status line hook so the extension is visible when loaded
- A local `.references/` area for copied reference material and example implementations

## Reference workspace

Drop reference code and docs into `.references/` while you explore patterns from:

- `@mariozechner/pi-coding-agent`
- other pi extensions you want to study
- local notes about orchestration, volatile state, or signaling ideas

Anything under `.references/` is ignored by git, except this short README note.

## Next obvious step

Add a real subagent registry and decide how to share ephemeral state between instances:

- session-backed state via `appendEntry`
- disk-backed scratch data
- in-memory signaling if multiple instances can coordinate
