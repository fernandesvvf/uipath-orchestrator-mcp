import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createTestClient, getPat, hasLiveBackend } from "../helpers.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Job, RobotSession, IncidentGroup } from "../../src/domain/orchestrator.ts";

/**
 * E2E — drives the MCP through a real stdio client against a LIVE Orchestrator.
 * Requires UIPATH_BASE_URL + UIPATH_PAT in the environment; otherwise skipped
 * so `npm test` stays green in CI (the rate-limiter unit test is the cheap CI
 * signal).
 */
type JobsResult = { structuredContent: { jobs?: Job[]; count?: number; isError?: boolean; message?: string } };
type RobotsResult = { structuredContent: { robots?: RobotSession[]; isError?: boolean; message?: string } };
type IncidentsResult = { structuredContent: { incidents?: IncidentGroup[]; isError?: boolean; message?: string } };

describe("UiPath Orchestrator Tools (e2e)", { skip: !hasLiveBackend() }, () => {
    let client: Client;

    beforeEach(async () => {
        client = await createTestClient(getPat());
    });

    afterEach(async () => {
        await client.close();
    });

    it("lists failed jobs", async () => {
        const r = (await client.callTool({ name: "list_failed_jobs", arguments: {} })) as unknown as JobsResult;
        assert.ok(Array.isArray(r.structuredContent.jobs), "should return a jobs array");
    });

    it("gets robot health", async () => {
        const r = (await client.callTool({ name: "get_robot_health", arguments: {} })) as unknown as RobotsResult;
        assert.ok(Array.isArray(r.structuredContent.robots), "should return a robots array");
    });

    it("summarizes incidents (grouped by process)", async () => {
        const r = (await client.callTool({ name: "summarize_incidents", arguments: {} })) as unknown as IncidentsResult;
        assert.ok(Array.isArray(r.structuredContent.incidents), "should return an incidents array");
    });

    it("returns isError on an invalid PAT", async () => {
        const bad = await createTestClient("invalid-token");
        try {
            const r = (await bad.callTool({ name: "list_failed_jobs", arguments: {} })) as unknown as JobsResult;
            assert.strictEqual(r.structuredContent.isError, true);
            assert.ok(r.structuredContent.message?.toLowerCase().includes("unauthorized"));
        } finally {
            await bad.close();
        }
    });
});
