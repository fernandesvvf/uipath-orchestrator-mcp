import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

/**
 * TOOL = action the model can call. Handler is THIN: call service, shape result,
 * catch -> isError. No logic here. outputSchema uses OrchestratorResultSchema
 * (wide) so both success keys (jobs, count) and error keys (isError, message)
 * are valid — a narrower schema triggers "must NOT have additional properties".
 */
const inputSchema = {
    since: z
        .string()
        .optional()
        .describe("ISO-8601 lower bound for job creation time. Defaults to last 24h."),
    top: z.number().optional().describe("Max jobs to return (default 50)."),
    folderId: z
        .string()
        .optional()
        .describe("Orchestrator folder id to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerListFailedJobsTool(server: McpServer, service: OrchestratorService): void {
    server.registerTool(
        "list_failed_jobs",
        {
            description:
                "List faulted (failed) Orchestrator jobs in a time window. Use to triage recent automation failures.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ since, top, folderId }) => {
            try {
                const jobs = await service.listFailedJobs(since, top, folderId);
                return {
                    content: [{ type: "text", text: JSON.stringify(jobs) }],
                    structuredContent: { jobs, count: jobs.length },
                };
            } catch (err) {
                const message = `Failed to list failed jobs. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
