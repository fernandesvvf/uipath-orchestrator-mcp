import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    target: z.string().describe("Process name or queue name to analyze."),
    targetType: z
        .enum(["process", "queue"])
        .describe("Whether 'target' is a process (jobs) or a queue (queue items)."),
    days: z.number().optional().describe("Window length in days (default 7)."),
    folderId: z
        .string()
        .optional()
        .describe("Folder id (from find_folders) to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerGetThroughputTool(server: McpServer, service: OrchestratorService): void {
    server.registerTool(
        "get_throughput",
        {
            description:
                "Daily volume series for a process or queue over a window: total, successful, failed per day, plus average/day and success rate. Use to spot trends/anomalies — a series, not a single average that hides day-of-week patterns.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ target, targetType, days, folderId }) => {
            try {
                const throughput = await service.getThroughput(target, targetType, days, folderId);
                return {
                    content: [{ type: "text", text: JSON.stringify(throughput) }],
                    structuredContent: { throughput },
                };
            } catch (err) {
                const message = `Failed to get throughput. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
