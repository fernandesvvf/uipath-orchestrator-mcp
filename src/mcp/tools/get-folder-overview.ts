import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    folderName: z
        .string()
        .describe(
            "Exact folder name to report on. If unsure which folder, call find_folders first and confirm with the user.",
        ),
    since: z
        .string()
        .optional()
        .describe("ISO-8601 lower bound for the failure window. Defaults to last 24h."),
};

export function registerGetFolderOverviewTool(
    server: McpServer,
    service: OrchestratorService,
): void {
    server.registerTool(
        "get_folder_overview",
        {
            description:
                "Consolidated health of ONE folder/automation: failed jobs, stuck jobs, unhealthy robots, failed queue items, and top failing processes. Answers 'how is automation X doing?' in one call. Resolves the folder by name; errors if the name is ambiguous (call find_folders first).",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ folderName, since }) => {
            try {
                const overview = await service.getFolderOverview(folderName, since);
                return {
                    content: [{ type: "text", text: JSON.stringify(overview) }],
                    structuredContent: { overview },
                };
            } catch (err) {
                const message = `Failed to get folder overview. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
