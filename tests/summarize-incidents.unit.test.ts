import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { OrchestratorService } from "../src/application/orchestrator-service.ts";
import { NoAuth } from "../src/domain/auth.ts";

/**
 * UNIT test for the curated aggregation logic (the reason this MCP exists vs a
 * 1:1 API wrapper). We stub global fetch so no backend is needed — the OData
 * call returns a canned { value: [...] } envelope and we assert the grouping.
 */
describe("OrchestratorService.summarizeIncidents (grouping)", () => {
    const realFetch = globalThis.fetch;

    function stubJobs(jobs: unknown[]): void {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ value: jobs }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            })) as typeof fetch;
    }

    beforeEach(() => {
        // default: no jobs
        stubJobs([]);
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("groups faulted jobs by process and counts them, sorted desc", async () => {
        stubJobs([
            { Id: 1, State: "Faulted", ProcessName: "Invoice", CreationTime: "2026-05-29T10:00:00Z", Info: "boom" },
            { Id: 2, State: "Faulted", ProcessName: "Invoice", CreationTime: "2026-05-29T11:00:00Z" },
            { Id: 3, State: "Faulted", ProcessName: "Payroll", CreationTime: "2026-05-29T09:00:00Z" },
        ]);
        const service = new OrchestratorService("http://x/orchestrator_", new NoAuth());
        const incidents = await service.summarizeIncidents();

        assert.strictEqual(incidents.length, 2);
        assert.strictEqual(incidents[0].processName, "Invoice"); // most failures first
        assert.strictEqual(incidents[0].failureCount, 2);
        assert.strictEqual(incidents[0].sampleInfo, "boom");
        assert.strictEqual(incidents[1].processName, "Payroll");
        assert.strictEqual(incidents[1].failureCount, 1);
    });

    it("labels jobs without a process name", async () => {
        stubJobs([{ Id: 9, State: "Faulted", CreationTime: "2026-05-29T10:00:00Z" }]);
        const service = new OrchestratorService("http://x/orchestrator_", new NoAuth());
        const incidents = await service.summarizeIncidents();

        assert.strictEqual(incidents[0].processName, "(unknown process)");
    });

    it("returns empty when there are no failures", async () => {
        const service = new OrchestratorService("http://x/orchestrator_", new NoAuth());
        const incidents = await service.summarizeIncidents();
        assert.deepStrictEqual(incidents, []);
    });
});
