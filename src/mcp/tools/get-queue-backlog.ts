import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    status: z
        .enum(["New", "InProgress", "Failed", "Successful", "Abandoned", "Retried", "Deleted"])
        .optional()
        .describe("Filter by queue item status. Omit for all statuses."),
    top: z.number().optional().describe("Max items to return (default 100)."),
    folderId: z
        .string()
        .optional()
        .describe("Orchestrator folder id to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerGetQueueBacklogTool(server: McpServer, service: OrchestratorService): void {
    server.registerTool(
        "get_queue_backlog",
        {
            description:
                "List queue items, optionally filtered by status (e.g. 'New' for backlog, 'Failed' for errors).",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ status, top, folderId }) => {
            try {
                const queueItems = await service.getQueueBacklog(status, top, folderId);
                return {
                    content: [{ type: "text", text: JSON.stringify(queueItems) }],
                    structuredContent: { queueItems, count: queueItems.length },
                };
            } catch (err) {
                const message = `Failed to get queue backlog. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
