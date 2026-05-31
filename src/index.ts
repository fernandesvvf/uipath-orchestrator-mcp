import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./mcp/server.ts";

/**
 * ENTRYPOINT — owns the TRANSPORT only. stdio = JSON-RPC over stdin/stdout.
 * RULE: stdout is the protocol channel. Log ONLY to stderr (console.error),
 * never console.log, or you corrupt the stream.
 */
async function main() {
    // Default auth is Bearer via UIPATH_PAT; without it the server boots but
    // Orchestrator will reject every call with 401 (NoAuth = dev only).
    if (!process.env.UIPATH_PAT) {
        console.error("[warn] UIPATH_PAT not set — running with NoAuth (Orchestrator will 401)");
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("UiPath Orchestrator MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
