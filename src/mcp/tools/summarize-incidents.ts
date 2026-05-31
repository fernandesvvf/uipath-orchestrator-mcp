import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    since: z
        .string()
        .optional()
        .describe("ISO-8601 lower bound for the window. Defaults to last 24h."),
    folderId: z
        .string()
        .optional()
        .describe("Orchestrator folder id to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerSummarizeIncidentsTool(
    server: McpServer,
    service: OrchestratorService,
): void {
    server.registerTool(
        "summarize_incidents",
        {
            description:
                "Curated incident summary: faulted jobs in the window grouped by process, with counts and a sample error. Start here for a health overview.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ since, folderId }) => {
            try {
                const incidents = await service.summarizeIncidents(since, folderId);
                return {
                    content: [{ type: "text", text: JSON.stringify(incidents) }],
                    structuredContent: { incidents, count: incidents.length },
                };
            } catch (err) {
                const message = `Failed to summarize incidents. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
