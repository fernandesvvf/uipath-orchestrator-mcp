import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * TEST HELPERS — spin up the MCP via a real stdio client (true e2e). The test
 * acts as the "agent".
 *
 * UiPath auth is a Personal Access Token (PAT), not a username/password flow,
 * so there's no token-fetch step: read it straight from the environment.
 * E2E tests require a live Orchestrator (UIPATH_BASE_URL + UIPATH_PAT set).
 */
export function getPat(): string {
    return process.env.UIPATH_PAT ?? "";
}

export function hasLiveBackend(): boolean {
    return Boolean(process.env.UIPATH_BASE_URL && process.env.UIPATH_PAT);
}

export async function createTestClient(pat: string): Promise<Client> {
    const transport = new StdioClientTransport({
        command: "node",
        args: ["--experimental-strip-types", "src/index.ts"],
        env: {
            ...process.env,
            UIPATH_PAT: pat,
            // inherit UIPATH_BASE_URL / ORG_UNIT_ID from the parent env
        },
    });

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return client;
}
