import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    thresholdMinutes: z
        .number()
        .optional()
        .describe("Minutes an item may sit in New before counting as stalled. Default 60min."),
    folderId: z
        .string()
        .optional()
        .describe("Folder id (from find_folders) to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerDiagnoseQueueStallTool(
    server: McpServer,
    service: OrchestratorService,
): void {
    server.registerTool(
        "diagnose_queue_stall",
        {
            description:
                "Diagnose WHY New queue items aren't being processed: correlates stalled items with robot availability and trigger state, and returns likely causes. Run after find_stalled_queue_items reports a problem.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ thresholdMinutes, folderId }) => {
            try {
                const diagnosis = await service.diagnoseQueueStall(thresholdMinutes, folderId);
                return {
                    content: [{ type: "text", text: JSON.stringify(diagnosis) }],
                    structuredContent: { diagnosis },
                };
            } catch (err) {
                const message = `Failed to diagnose queue stall. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
