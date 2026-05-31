import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    thresholdMinutes: z
        .number()
        .optional()
        .describe("Minutes an item may sit in New before it counts as stalled. Default 60min."),
    folderId: z
        .string()
        .optional()
        .describe("Folder id (from find_folders) to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerFindStalledQueueItemsTool(
    server: McpServer,
    service: OrchestratorService,
): void {
    server.registerTool(
        "find_stalled_queue_items",
        {
            description:
                "Find queue items stuck in New (added but never picked up) past a threshold — nobody is processing them. Use diagnose_queue_stall to find out why.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ thresholdMinutes, folderId }) => {
            try {
                const stalledQueueItems = await service.findStalledQueueItems(thresholdMinutes, folderId);
                return {
                    content: [{ type: "text", text: JSON.stringify(stalledQueueItems) }],
                    structuredContent: { stalledQueueItems, count: stalledQueueItems.length },
                };
            } catch (err) {
                const message = `Failed to find stalled queue items. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
