# pi-threading

Recursive subagent orchestration framework for [pi](https://github.com/badlogic/pi-mono).

Spawn specialist agent trees, steer them mid-work, route questions upward, and track everything in a persistent tree-state store.

## Install

```bash
pi install npm:pi-threading
```

## What you get

- **`spawn_subagent`** — non-blocking tool the LLM calls to delegate work
- **`list_subagents`** / **`steer_subagent`** / **`stop_subagent`** — manage running agents
- **`ask_question`** / **`finish_task`** — subagent-side coordination tools
- **Live tree widget** — always-on visualization of the agent tree
- **Question inbox** (Ctrl+I) — batch-answer pending questions
- **`/orchestrate`** / **`/scout-and-plan`** — workflow prompt templates
- **`/subagents`** / **`/dump`** / **`/clear`** / **`/threading`** — inspection and settings commands

## Built-in agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General implementation | Sonnet | all defaults |

Define your own agents as markdown files in `~/.pi/agent/agents/` or `.pi/agents/`.

## For extension authors

pi-threading exposes a TypeScript API for building higher-level workflows:

```typescript
import { ThreadRuntime, AgentHandle } from "pi-threading";
```

See [PRD #1](https://github.com/mia-cx/pi-threading/issues/1) for the full design.

## Development

```bash
git clone git@github.com:mia-cx/pi-threading.git
cd pi-threading
npm install
pi -e .   # test locally
```

## License

MIT
