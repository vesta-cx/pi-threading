---
name: scout-and-plan
description: Recon then plan — spawn a scout to explore, then a planner to design the approach
---

Use pi-threading subagents to explore and plan (no implementation).

1. Spawn a **scout** agent to explore the codebase for the task below. The scout should find relevant files, understand the current architecture, and report back.

2. Once the scout completes, spawn a **planner** agent with the scout's findings. The planner should create a detailed, step-by-step implementation plan with acceptance criteria.

3. Present the planner's output to me for review.

Do not spawn any worker agents — this is reconnaissance and planning only.

Task: {args}
