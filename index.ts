export default function threadingExtension(pi: any) {
  pi.registerCommand("subagents", {
    description: "Describe the subagent orchestration scaffold",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(
        "pi-threading scaffold loaded. Next steps: add orchestrator/subagent roles, shared volatile state, and an event/signaling layer.",
        "info",
      );
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    ctx.ui.setStatus("pi-threading", "subagent scaffold ready");
  });
}
