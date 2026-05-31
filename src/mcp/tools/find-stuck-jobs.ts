import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    thresholdMinutes: z
        .number()
        .optional()
        .describe(
            "Escape hatch: force a fixed minute threshold. Omit (recommended) to use the per-process baseline (2× the average duration of recent successful runs), which falls back to 60min only when history is too thin.",
        ),
    folderId: z
        .string()
        .optional()
        .describe("Folder id (from find_folders) to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerFindStuckJobsTool(server: McpServer, service: OrchestratorService): void {
    server.registerTool(
        "find_stuck_jobs",
        {
            description:
                "Find jobs stuck in Running far longer than their normal duration (hung automations). Uses a per-process baseline (vs Orchestrator's native fixed-threshold alert). Reports how long each has run and which threshold it crossed.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ thresholdMinutes, folderId }) => {
            try {
                const stuckJobs = await service.findStuckJobs(thresholdMinutes, folderId);
                return {
                    content: [{ type: "text", text: JSON.stringify(stuckJobs) }],
                    structuredContent: { stuckJobs, count: stuckJobs.length },
                };
            } catch (err) {
                const message = `Failed to find stuck jobs. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
