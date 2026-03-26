---
name: orchestrate
description: Orchestrate a task using subagents — delegates to specialists automatically
---

You have access to subagent orchestration via pi-threading. For the task below, use `spawn_subagent` to delegate work to specialist agents.

Available agents can be listed via `list_subagents` or discovered from the `spawn_subagent` tool description. Common specialists:
- **scout** — fast read-only recon (grep, find, read)
- **planner** — creates structured implementation plans
- **reviewer** — code review without modifying files
- **worker** — general-purpose implementation

Workflow:
1. Spawn a scout to explore the relevant code
2. Once the scout reports back, spawn a planner to create an implementation plan
3. Spawn one or more workers to execute the plan
4. Optionally spawn a reviewer to verify the work

Use `steer_subagent` to redirect agents if they go off track. Answer any questions that bubble up from subagents. Monitor progress via `list_subagents`.

Task: {args}
