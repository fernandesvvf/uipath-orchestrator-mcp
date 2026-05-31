import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    query: z
        .string()
        .describe("Part of the folder name to search for (case-insensitive substring, e.g. 'compras')."),
};

export function registerFindFoldersTool(server: McpServer, service: OrchestratorService): void {
    server.registerTool(
        "find_folders",
        {
            description:
                "Resolve a plain-text folder name to matching Orchestrator folders. Use this FIRST when the user names an automation/area instead of an id — show the matching folder names and, if more than one, ask which one. The user never needs to know folder ids.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ query }) => {
            try {
                const folders = await service.findFolders(query);
                const message =
                    folders.length === 0
                        ? `No folders match "${query}".`
                        : folders.length === 1
                          ? `One match: ${folders[0].DisplayName}.`
                          : `${folders.length} matches — ask the user which one.`;
                return {
                    content: [{ type: "text", text: JSON.stringify(folders) }],
                    structuredContent: { folders, count: folders.length, message },
                };
            } catch (err) {
                const message = `Failed to find folders. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
