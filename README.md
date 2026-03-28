# pi-threading

Hierarchical agent runtime for [pi](https://github.com/badlogic/pi-mono).

pi-threading models agent work as an **org graph**: explicit parent/child
relationships, scoped responsibility, delegated authority, and status that
rolls up through the tree. It is not a swarm system, a message bus, or a
task board — it is an organizational runtime where every agent has a place
in the hierarchy and a clear chain of accountability.

## Why a hierarchy?

Most multi-agent approaches treat agents as interchangeable peers that
claim work from a shared pool. That works well for embarrassingly parallel
tasks (run linter on 50 files, scout a codebase), but breaks down when
work requires:

- **Delegation with context** — a manager agent decomposes a goal, spawns
  subordinates with scoped instructions, and synthesises their results.
- **Responsibility boundaries** — each agent owns a subtree of work and
  can be held accountable for its outcome.
- **Escalation paths** — when a subordinate is stuck or needs a decision,
  it knows exactly who to ask.
- **Cost and status rollups** — you can ask "how much did the planning
  subtree cost?" or "is the review branch done?" without scanning every
  agent in the system.
- **Human-in-the-loop at specific nodes** — a human approves at one level
  of the hierarchy without being in the loop for every leaf task.

These are properties of organizations, not swarms.

## How it compares

pi exists in an ecosystem with other multi-agent tools. Here is how
pi-threading relates to two that ship with the broader pi package
ecosystem:

### ant-colony (oh-pi)

ant-colony is a **bio-inspired swarm** that maps directly to ant behavior:
a queen dispatches scouts, workers, and soldiers; agents communicate
indirectly through pheromone trails on the filesystem; concurrency
self-adapts based on system load. It is optimized for parallel grunt work
where the structure of the problem is discovered at runtime.

| | ant-colony | pi-threading |
|---|---|---|
| **Mental model** | Ant colony — stigmergy, pheromones, castes | Org chart — managers, delegates, reporting lines |
| **Agent identity** | Caste role (scout / worker / soldier) | Named agent with position in a tree |
| **Coordination** | Indirect via shared filesystem (pheromones) | Direct parent/child RPC and state |
| **Task assignment** | Queen dispatches waves, workers pick up | Parent explicitly delegates to children |
| **Communication** | Pheromone trails with exponential decay | Structured messages through the hierarchy |
| **Lifecycle** | Colony starts, runs waves, terminates | Persistent tree with durable agent state |
| **Observability** | Colony-level progress and TUI panel | Per-node status, subtree rollups, cost tracking |
| **Best for** | Parallel bulk work: migrations, test generation, large refactors | Structured decomposition: planning, review chains, multi-step features |

### pi-messenger

pi-messenger is a **peer-to-peer coordination layer**: agents join a
shared mesh, post to channels, create and claim tasks from a shared board,
and spawn subagents dynamically. It is designed for fluid, self-organizing
collaboration where any agent can do anything.

| | pi-messenger | pi-threading |
|---|---|---|
| **Mental model** | Slack workspace — channels, DMs, a shared task board | Org chart — hierarchy, delegation, rollups |
| **Agent identity** | Peer with a name on a channel | Node in a tree with a parent and children |
| **Coordination** | Message bus + task board + file locks | Parent/child RPC + tree state |
| **Task assignment** | Any agent creates or claims tasks | Parent delegates; children do not self-assign |
| **Communication** | Broadcast channels, direct messages | Scoped to parent ↔ child edges |
| **Lifecycle** | Agents join and leave freely | Agents are spawned into a tree and tracked until exit |
| **Observability** | Activity feed, task list | Tree structure, per-agent status, subtree cost rollups |
| **Best for** | Ad-hoc collaboration, review orchestration, loosely coupled work | Accountable delegation, structured decomposition, HITL workflows |

### When to use what

- **ant-colony** when you have a big pile of independent or
  loosely-coupled work and want maximum parallelism with minimal
  coordination overhead.
- **pi-messenger** when you need fluid, peer-to-peer collaboration
  between agents that don't have a natural reporting structure.
- **pi-threading** when the work has inherent hierarchy — planning that
  decomposes into execution, review that gates a subtree, or any workflow
  where you need to know who delegated what to whom and how it rolled up.

They are not mutually exclusive. A pi-threading orchestrator could spawn
an ant-colony for a bulk subtask, or use pi-messenger to coordinate with
peer agents outside its own tree. The boundaries are about which model of
work best fits the problem, not about exclusive tool choice.

## Current status

Implemented so far:

- **SQLite store** — trunks, agents, tree traversal, cost rollups
- **Agent discovery** — frontmatter-based `.md` definitions from
  `~/.pi/`, `~/.agents/`, and project-local directories
- **RPC client** — subprocess transport for `pi --mode rpc` agents
- **Bootstrap** — `better-sqlite3` native addon loading with automatic
  rebuild fallback

Planned in later slices:

- Runtime lifecycle state machine
- Orchestrator tools (spawn, steer, stop, get_result)
- Subagent tools (ask_question, finish_task)
- Question routing and human-in-the-loop inbox
- Visualization: status line, tree widget, message renderers
- Management commands and graceful shutdown

See [PRD #1](https://github.com/vesta-cx/pi-threading/issues/1) for the
full design.

## Development

```bash
git clone git@github.com:vesta-cx/pi-threading.git
cd pi-threading
npm install
npx biome check src/ test/
node --import @mariozechner/jiti/register --test test/*.test.ts
```

## License

MIT
