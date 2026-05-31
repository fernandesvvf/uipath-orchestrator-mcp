import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { OrchestratorService } from "../src/application/orchestrator-service.ts";
import { NoAuth } from "../src/domain/auth.ts";

/**
 * UNIT test for explainFailure — the multi-call correlation (job + logs ->
 * primary error + summary). Stub fetch and dispatch by URL: RobotLogs vs Jobs.
 */
describe("OrchestratorService.explainFailure", () => {
    const realFetch = globalThis.fetch;
    const svc = () => new OrchestratorService("http://x/orchestrator_", new NoAuth());

    function stub(route: (url: string) => unknown[]): void {
        globalThis.fetch = (async (input: string | URL) => {
            const url = String(input);
            return new Response(JSON.stringify({ value: route(url) }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;
    }

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("correlates job + logs and extracts the newest error as primary", async () => {
        stub((url) => {
            if (url.includes("RobotLogs")) {
                return [
                    { Level: "Error", Message: "Selector not found: btnSubmit", TimeStamp: "2026-05-29T10:05:00Z" },
                    { Level: "Error", Message: "Earlier warning", TimeStamp: "2026-05-29T10:00:00Z" },
                ];
            }
            // Jobs
            return [
                {
                    Id: 42,
                    State: "Faulted",
                    ProcessName: "Invoice",
                    HostMachineName: "VM-01",
                    StartTime: "2026-05-29T10:00:00Z",
                    EndTime: "2026-05-29T10:05:00Z",
                },
            ];
        });

        const r = await svc().explainFailure("guid-123");
        assert.strictEqual(r.jobId, 42);
        assert.strictEqual(r.processName, "Invoice");
        assert.strictEqual(r.errorLogCount, 2);
        assert.strictEqual(r.primaryError, "Selector not found: btnSubmit"); // newest
        assert.ok(r.summary.includes("Invoice"));
        assert.ok(r.summary.includes("VM-01"));
        assert.ok(r.summary.includes("Selector not found"));
    });

    it("falls back to job.Info when there are no logs", async () => {
        stub((url) => {
            if (url.includes("RobotLogs")) return [];
            return [{ Id: 7, State: "Faulted", ProcessName: "Payroll", Info: "Process terminated unexpectedly" }];
        });

        const r = await svc().explainFailure("guid-456");
        assert.strictEqual(r.errorLogCount, 0);
        assert.strictEqual(r.primaryError, "Process terminated unexpectedly");
    });

    it("handles a missing job gracefully", async () => {
        stub(() => []); // no job, no logs
        const r = await svc().explainFailure("guid-nope");
        assert.strictEqual(r.jobId, null);
        assert.ok(r.summary.toLowerCase().includes("no job found"));
    });
});
