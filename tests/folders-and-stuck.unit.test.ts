import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { OrchestratorService } from "../src/application/orchestrator-service.ts";
import { NoAuth } from "../src/domain/auth.ts";

/**
 * UNIT tests for the curated logic that justifies this MCP over a 1:1 wrapper:
 *   - find_folders: name -> matching folders (no ids needed by the user)
 *   - find_stuck_jobs: hybrid threshold (explicit / baseline / default)
 *
 * We stub global fetch and dispatch by URL so no backend is needed.
 */
describe("OrchestratorService — folders & stuck jobs", () => {
    const realFetch = globalThis.fetch;
    const svc = () => new OrchestratorService("http://x/orchestrator_", new NoAuth());

    /** route(url) -> array; wrapped in the OData { value } envelope. */
    function stubByUrl(route: (url: string) => unknown[]): void {
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

    describe("findFolders", () => {
        beforeEach(() => {
            stubByUrl(() => [
                { Id: 1, DisplayName: "W0473 - O2C Compras" },
                { Id: 2, DisplayName: "W109 Fraud Compras" },
                { Id: 3, DisplayName: "W0325 compliance ABC" },
            ]);
        });

        it("returns only folders whose name contains the query (case-insensitive)", async () => {
            const folders = await svc().findFolders("compras");
            assert.strictEqual(folders.length, 2);
            const names = folders.map((f) => f.DisplayName);
            assert.ok(names.includes("W0473 - O2C Compras"));
            assert.ok(names.includes("W109 Fraud Compras"));
        });

        it("returns no folders when nothing matches", async () => {
            const folders = await svc().findFolders("xyz");
            assert.deepStrictEqual(folders, []);
        });
    });

    describe("findStuckJobs threshold", () => {
        const longAgoIso = new Date(Date.now() - 120 * 60000).toISOString(); // 120 min ago
        const recentIso = new Date(Date.now() - 5 * 60000).toISOString(); // 5 min ago

        it("uses the explicit threshold when provided", async () => {
            stubByUrl((url) =>
                url.includes("Running")
                    ? [{ Id: 1, State: "Running", ProcessName: "P", StartTime: longAgoIso }]
                    : [],
            );
            const stuck = await svc().findStuckJobs(60);
            assert.strictEqual(stuck.length, 1);
            assert.strictEqual(stuck[0].thresholdSource, "explicit");
            assert.strictEqual(stuck[0].thresholdMinutes, 60);
        });

        it("does not flag a job running under the explicit threshold", async () => {
            stubByUrl((url) =>
                url.includes("Running")
                    ? [{ Id: 1, State: "Running", ProcessName: "P", StartTime: recentIso }]
                    : [],
            );
            const stuck = await svc().findStuckJobs(60);
            assert.strictEqual(stuck.length, 0);
        });

        it("derives a baseline (2x avg) when no explicit threshold and history exists", async () => {
            // 4 successful runs of ~10 min each -> avg 10 -> threshold 20 min.
            const tenMinRun = (offsetMin: number) => ({
                State: "Successful",
                ProcessName: "P",
                StartTime: new Date(Date.now() - (offsetMin + 10) * 60000).toISOString(),
                EndTime: new Date(Date.now() - offsetMin * 60000).toISOString(),
            });
            stubByUrl((url) => {
                if (url.includes("Running")) {
                    return [{ Id: 1, State: "Running", ProcessName: "P", StartTime: longAgoIso }];
                }
                if (url.includes("Successful")) {
                    return [tenMinRun(100), tenMinRun(200), tenMinRun(300), tenMinRun(400)];
                }
                return [];
            });
            const stuck = await svc().findStuckJobs();
            assert.strictEqual(stuck.length, 1);
            assert.strictEqual(stuck[0].thresholdSource, "baseline");
            assert.strictEqual(stuck[0].thresholdMinutes, 20); // 2 * 10
        });

        it("falls back to the default threshold when history is too thin", async () => {
            stubByUrl((url) => {
                if (url.includes("Running")) {
                    return [{ Id: 1, State: "Running", ProcessName: "P", StartTime: longAgoIso }];
                }
                return []; // no successful history -> baseline null
            });
            const stuck = await svc().findStuckJobs();
            assert.strictEqual(stuck.length, 1);
            assert.strictEqual(stuck[0].thresholdSource, "default");
            assert.strictEqual(stuck[0].thresholdMinutes, 60);
        });
    });
});
