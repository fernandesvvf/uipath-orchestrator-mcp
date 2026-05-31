import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    jobKey: z.string().describe("The job Key (GUID) to fetch Error/Fatal logs for."),
    top: z.number().optional().describe("Max log entries to return (default 100)."),
    folderId: z
        .string()
        .optional()
        .describe("Orchestrator folder id to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerGetJobLogsTool(server: McpServer, service: OrchestratorService): void {
    server.registerTool(
        "get_job_logs",
        {
            description:
                "Fetch Error/Fatal robot logs for a specific job (by Key). Use after list_failed_jobs to diagnose root cause.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ jobKey, top, folderId }) => {
            try {
                const logs = await service.getJobLogs(jobKey, top, folderId);
                return {
                    content: [{ type: "text", text: JSON.stringify(logs) }],
                    structuredContent: { logs, count: logs.length },
                };
            } catch (err) {
                const message = `Failed to get job logs. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
