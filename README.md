# pi-threading

Subagent orchestration framework scaffold for [pi](https://github.com/badlogic/pi-mono).

This repository currently provides the package structure, built-in agent definitions, prompt templates, and native SQLite bootstrap that later orchestration slices build on.

## Current status

Implemented in this scaffold:

- package layout for `extensions/`, `src/`, `agents/`, and `prompts/`
- `better-sqlite3` bootstrap with automatic `npm rebuild` fallback
- root vs subagent mode detection in the extension entrypoint
- built-in `scout`, `planner`, `reviewer`, and `worker` agent definitions
- `/orchestrate` and `/scout-and-plan` prompt templates

Planned in later slices:

- runtime and process management
- orchestrator and subagent tools
- question routing and idle wake-up
- visualization, inbox, and management commands

See [PRD #1](https://github.com/mia-cx/pi-threading/issues/1) and the local `.plans/` directory for the full design and slice breakdown.

## Development

```bash
git clone git@github.com:mia-cx/pi-threading.git
cd pi-threading
npm install
pi -e .   # test locally
```

## License

MIT
