import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    jobKey: z.string().describe("The job Key (GUID) to explain. Get it from list_failed_jobs."),
    folderId: z
        .string()
        .optional()
        .describe("Folder id (from find_folders) to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerExplainFailureTool(server: McpServer, service: OrchestratorService): void {
    server.registerTool(
        "explain_failure",
        {
            description:
                "Explain why a single job failed: correlates the job with its Error/Fatal logs, extracts the primary exception, and returns a plain-language summary. One call instead of list_failed_jobs + get_job_logs + manual reading.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ jobKey, folderId }) => {
            try {
                const explanation = await service.explainFailure(jobKey, folderId);
                return {
                    content: [{ type: "text", text: explanation.summary }],
                    structuredContent: { explanation },
                };
            } catch (err) {
                const message = `Failed to explain failure. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
