import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { OrchestratorService } from "../src/application/orchestrator-service.ts";
import { NoAuth } from "../src/domain/auth.ts";

/**
 * UNIT tests for the stall diagnosis + throughput aggregation (the curated
 * logic). Stub global fetch and dispatch by URL so no backend is needed.
 */
describe("OrchestratorService — stall & throughput", () => {
    const realFetch = globalThis.fetch;
    const svc = () => new OrchestratorService("http://x/orchestrator_", new NoAuth());

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

    describe("findStalledQueueItems", () => {
        it("flags New items older than the threshold, sorted oldest first", async () => {
            const old = new Date(Date.now() - 200 * 60000).toISOString();
            const older = new Date(Date.now() - 400 * 60000).toISOString();
            const recent = new Date(Date.now() - 5 * 60000).toISOString();
            stubByUrl(() => [
                { Id: 1, Status: "New", CreationTime: old },
                { Id: 2, Status: "New", CreationTime: older },
                { Id: 3, Status: "New", CreationTime: recent },
            ]);
            const stalled = await svc().findStalledQueueItems(60);
            assert.strictEqual(stalled.length, 2);
            assert.strictEqual(stalled[0].Id, 2); // oldest first
            assert.strictEqual(stalled[0].thresholdSource, "explicit");
        });
    });

    describe("diagnoseQueueStall", () => {
        const old = new Date(Date.now() - 200 * 60000).toISOString();

        it("blames disabled triggers when robots are fine but triggers are off", async () => {
            stubByUrl((url) => {
                if (url.includes("QueueItems")) return [{ Id: 1, Status: "New", CreationTime: old }];
                if (url.includes("Sessions")) return [{ State: "Available" }];
                if (url.includes("ProcessSchedules")) return [{ Enabled: false }, { Enabled: false }];
                return [];
            });
            const d = await svc().diagnoseQueueStall(60);
            assert.strictEqual(d.stalledCount, 1);
            assert.strictEqual(d.availableRobots, 1);
            assert.strictEqual(d.disabledTriggers, 2);
            assert.ok(d.likelyCauses.some((c) => c.toLowerCase().includes("disabled")));
        });

        it("blames robot availability when none are Available", async () => {
            stubByUrl((url) => {
                if (url.includes("QueueItems")) return [{ Id: 1, Status: "New", CreationTime: old }];
                if (url.includes("Sessions")) return [{ State: "Busy" }];
                if (url.includes("ProcessSchedules")) return [{ Enabled: true }];
                return [];
            });
            const d = await svc().diagnoseQueueStall(60);
            assert.strictEqual(d.busyRobots, 1);
            assert.ok(d.likelyCauses.some((c) => c.toLowerCase().includes("busy")));
        });

        it("reports nothing to diagnose when no items are stalled", async () => {
            stubByUrl((url) => {
                if (url.includes("QueueItems")) return []; // no New items
                if (url.includes("Sessions")) return [{ State: "Available" }];
                if (url.includes("ProcessSchedules")) return [{ Enabled: true }];
                return [];
            });
            const d = await svc().diagnoseQueueStall(60);
            assert.strictEqual(d.stalledCount, 0);
            assert.ok(d.likelyCauses.some((c) => c.toLowerCase().includes("nothing to diagnose")));
        });
    });

    describe("getThroughput (process)", () => {
        it("buckets jobs by UTC day and derives avg/day + success rate", async () => {
            stubByUrl((url) => {
                if (!url.includes("Jobs")) return [];
                return [
                    { State: "Successful", CreationTime: "2026-05-28T01:00:00Z" },
                    { State: "Faulted", CreationTime: "2026-05-28T05:00:00Z" },
                    { State: "Successful", CreationTime: "2026-05-29T09:00:00Z" },
                ];
            });
            const r = await svc().getThroughput("MyProc", "process", 2);
            assert.strictEqual(r.targetType, "process");
            assert.strictEqual(r.series.length, 2); // two distinct days
            const d28 = r.series.find((d) => d.date === "2026-05-28")!;
            assert.strictEqual(d28.total, 2);
            assert.strictEqual(d28.successful, 1);
            assert.strictEqual(d28.failed, 1);
            assert.strictEqual(r.avgPerDay, 1.5); // 3 items / 2 days
            assert.strictEqual(r.successRate, 0.667); // 2 success / 3 terminal
        });
    });
});
