import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import type { OrchestratorService } from "../../application/orchestrator-service.ts";
import { OrchestratorResultSchema } from "../../domain/orchestrator.ts";

const inputSchema = {
    folderId: z
        .string()
        .optional()
        .describe("Orchestrator folder id to scope to. Defaults to env ORG_UNIT_ID."),
};

export function registerGetRobotHealthTool(server: McpServer, service: OrchestratorService): void {
    server.registerTool(
        "get_robot_health",
        {
            description:
                "List robot/runtime sessions with state (unresponsive/disconnected sorted first). Use to check fleet health.",
            inputSchema,
            outputSchema: OrchestratorResultSchema.shape,
        },
        async ({ folderId }) => {
            try {
                const robots = await service.getRobotHealth(folderId);
                return {
                    content: [{ type: "text", text: JSON.stringify(robots) }],
                    structuredContent: { robots, count: robots.length },
                };
            } catch (err) {
                const message = `Failed to get robot health. Error: ${err instanceof Error ? err.message : String(err)}`;
                return {
                    content: [{ type: "text", text: message }],
                    structuredContent: { isError: true, message },
                };
            }
        },
    );
}
