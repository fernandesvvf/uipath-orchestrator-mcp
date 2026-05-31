import type {
    Job,
    QueueItem,
    RobotSession,
    RobotLog,
    IncidentGroup,
    Folder,
    StuckJob,
    FolderOverview,
    FailureExplanation,
    StalledQueueItem,
    QueueStallDiagnosis,
    ThroughputDay,
    ThroughputReport,
} from "../domain/orchestrator.ts";
import type { AuthProvider } from "../domain/auth.ts";
import { OrchestratorHttpClient } from "../infrastructure/orchestrator-http-client.ts";
import type { RateLimiter } from "../mcp/middleware/rate-limiter.ts";

/**
 * APPLICATION — business logic / orchestration for SUPPORT & MONITORING.
 * Knows the domain and the client, NOT about HTTP or MCP. Curated, multi-step
 * logic (grouping failures into incidents, deriving robot health) lives HERE so
 * tools stay thin.
 */
export class OrchestratorService {
    #client: OrchestratorHttpClient;

    constructor(
        baseUrl: string,
        auth: AuthProvider,
        limiter?: RateLimiter,
        defaultFolderId?: string,
    ) {
        this.#client = new OrchestratorHttpClient(baseUrl, auth, limiter, defaultFolderId);
    }

    /** Faulted jobs in the lookback window (default: last 24h). */
    listFailedJobs(sinceIso?: string, top?: number, folderId?: string): Promise<Job[]> {
        const since = sinceIso ?? defaultSince();
        return this.#client.listFailedJobs(since, top, folderId);
    }

    /** Error/Fatal logs for one job, for triage. */
    getJobLogs(jobKey: string, top?: number, folderId?: string): Promise<RobotLog[]> {
        return this.#client.getJobLogs(jobKey, top, folderId);
    }

    /** Robot/runtime sessions. Flags unresponsive/disconnected as unhealthy. */
    async getRobotHealth(folderId?: string): Promise<RobotSession[]> {
        const sessions = await this.#client.listRobotSessions(undefined, folderId);
        // surface the unhealthy ones first; agent reads top of list
        return sessions.sort((a, b) => unhealthyRank(b) - unhealthyRank(a));
    }

    /** Queue backlog: New + Failed items, optionally filtered by status. */
    getQueueBacklog(status?: string, top?: number, folderId?: string): Promise<QueueItem[]> {
        return this.#client.listQueueItems(status, top, folderId);
    }

    /**
     * Curated incident view: faulted jobs in the window grouped by process,
     * with counts + a sample error. This is the "intelligence" the raw API
     * doesn't give — the reason this MCP exists vs. a 1:1 wrapper.
     */
    async summarizeIncidents(sinceIso?: string, folderId?: string): Promise<IncidentGroup[]> {
        const since = sinceIso ?? defaultSince();
        const jobs = await this.#client.listFailedJobs(since, 200, folderId);

        const groups = new Map<string, IncidentGroup>();
        for (const job of jobs) {
            const name = job.ProcessName ?? "(unknown process)";
            const existing = groups.get(name);
            const failureTime = job.EndTime ?? job.CreationTime ?? null;
            if (existing) {
                existing.failureCount += 1;
                if (failureTime && (!existing.lastFailureTime || failureTime > existing.lastFailureTime)) {
                    existing.lastFailureTime = failureTime;
                }
            } else {
                groups.set(name, {
                    processName: name,
                    failureCount: 1,
                    lastFailureTime: failureTime,
                    sampleInfo: job.Info ?? null,
                });
            }
        }
        return [...groups.values()].sort((a, b) => b.failureCount - a.failureCount);
    }

    /**
     * Resolve a plain-text folder name to its folder(s). Case-insensitive
     * substring match over DisplayName so "compras" returns every folder with
     * that word — the agent shows the names and asks the user which one, and
     * the user NEVER needs to know the folder id.
     */
    async findFolders(query: string): Promise<Folder[]> {
        const folders = await this.#client.listFolders();
        const q = query.trim().toLowerCase();
        if (!q) return folders;
        return folders
            .filter((f) => f.DisplayName.toLowerCase().includes(q))
            .sort((a, b) => folderMatchRank(a, q) - folderMatchRank(b, q));
    }

    /**
     * Jobs stuck in Running. BASELINE-FIRST by design: Orchestrator already has
     * a native fixed-threshold "long-running job" alert, so a per-process
     * baseline (running longer than BASELINE_FACTOR × the average duration of
     * recent Successful runs) is what this tool adds over the platform.
     * Threshold precedence:
     *   1. per-process baseline (the default, the differentiator);
     *   2. explicit thresholdMinutes — escape hatch to force a fixed value;
     *   3. fixed DEFAULT_THRESHOLD_MIN only when history is too thin for a baseline.
     * The chosen source is reported per job so the agent can explain itself.
     */
    async findStuckJobs(thresholdMinutes?: number, folderId?: string): Promise<StuckJob[]> {
        const running = await this.#client.listRunningJobs(200, folderId);
        const now = Date.now();
        // cache baseline per process so we don't refetch for sibling jobs
        const baselineCache = new Map<string, number | null>();
        const stuck: StuckJob[] = [];

        for (const job of running) {
            if (!job.StartTime) continue;
            const runningMin = (now - Date.parse(job.StartTime)) / 60000;

            let threshold = thresholdMinutes;
            let source: StuckJob["thresholdSource"] = "explicit";
            if (threshold === undefined) {
                const proc = job.ProcessName ?? "";
                let baseline = baselineCache.get(proc);
                if (baseline === undefined) {
                    baseline = proc ? await this.#processBaselineMinutes(proc, folderId) : null;
                    baselineCache.set(proc, baseline);
                }
                if (baseline !== null) {
                    threshold = baseline * BASELINE_FACTOR;
                    source = "baseline";
                } else {
                    threshold = DEFAULT_THRESHOLD_MIN;
                    source = "default";
                }
            }

            if (runningMin > threshold) {
                stuck.push({
                    Id: job.Id,
                    Key: job.Key,
                    ProcessName: job.ProcessName ?? null,
                    StartTime: job.StartTime,
                    HostMachineName: job.HostMachineName ?? null,
                    runningMinutes: Math.round(runningMin),
                    thresholdMinutes: Math.round(threshold),
                    thresholdSource: source,
                });
            }
        }
        return stuck.sort((a, b) => b.runningMinutes - a.runningMinutes);
    }

    /**
     * Consolidated health for ONE folder, resolved by name. Multi-call: fans
     * out to failed jobs, stuck jobs, robot health and queue items, then folds
     * them into a single overview. This is the "how is automation X doing?"
     * answer in a single tool call.
     */
    async getFolderOverview(folderName: string, sinceIso?: string): Promise<FolderOverview> {
        const matches = await this.findFolders(folderName);
        if (matches.length === 0) {
            throw new Error(`No folder matches "${folderName}".`);
        }
        if (matches.length > 1) {
            const names = matches.map((f) => f.DisplayName).join(", ");
            throw new Error(
                `"${folderName}" is ambiguous — matches: ${names}. Ask the user which one, then call again with the exact name.`,
            );
        }
        const folder = matches[0];
        const folderId = String(folder.Id);

        const [incidents, stuckJobs, robots, failedQueueItems] = await Promise.all([
            this.summarizeIncidents(sinceIso, folderId),
            this.findStuckJobs(undefined, folderId),
            this.getRobotHealth(folderId),
            this.getQueueBacklog("Failed", 200, folderId),
        ]);

        return {
            folder,
            failedJobCount: incidents.reduce((sum, i) => sum + i.failureCount, 0),
            stuckJobCount: stuckJobs.length,
            unhealthyRobotCount: robots.filter((r) => unhealthyRank(r) > 0).length,
            failedQueueItemCount: failedQueueItems.length,
            topIncidents: incidents.slice(0, 5),
        };
    }

    /**
     * Queue items stuck in New (never picked up) past a threshold. Distinct
     * from stuck-InProgress: New = nobody started it (no robot, trigger off,
     * unpublished). Explicit threshold wins, else DEFAULT_THRESHOLD_MIN.
     */
    async findStalledQueueItems(
        thresholdMinutes?: number,
        folderId?: string,
    ): Promise<StalledQueueItem[]> {
        const items = await this.#client.listNewQueueItems(200, folderId);
        const now = Date.now();
        const threshold = thresholdMinutes ?? DEFAULT_THRESHOLD_MIN;
        const source: StalledQueueItem["thresholdSource"] =
            thresholdMinutes === undefined ? "default" : "explicit";

        const stalled: StalledQueueItem[] = [];
        for (const item of items) {
            if (!item.CreationTime) continue;
            const waitingMin = (now - Date.parse(item.CreationTime)) / 60000;
            if (waitingMin > threshold) {
                stalled.push({
                    Id: item.Id,
                    QueueDefinitionId: item.QueueDefinitionId,
                    Reference: item.Reference ?? null,
                    CreationTime: item.CreationTime,
                    waitingMinutes: Math.round(waitingMin),
                    thresholdMinutes: Math.round(threshold),
                    thresholdSource: source,
                });
            }
        }
        return stalled.sort((a, b) => b.waitingMinutes - a.waitingMinutes);
    }

    /**
     * Diagnose WHY New items aren't being processed. Multi-call: correlates
     * stalled items, robot availability, and trigger state in the folder, then
     * derives probable causes. This is the diagnostic value the raw API lacks.
     */
    async diagnoseQueueStall(
        thresholdMinutes?: number,
        folderId?: string,
    ): Promise<QueueStallDiagnosis> {
        const [stalled, sessions, schedules] = await Promise.all([
            this.findStalledQueueItems(thresholdMinutes, folderId),
            this.#client.listRobotSessions(200, folderId),
            this.#client.listProcessSchedules(200, folderId),
        ]);

        const available = sessions.filter((s) => s.State === "Available").length;
        const busy = sessions.filter((s) => s.State === "Busy").length;
        const unhealthy = sessions.filter((s) => unhealthyRank(s) > 0).length;
        const enabled = schedules.filter((s) => s.Enabled === true).length;
        const disabled = schedules.filter((s) => s.Enabled === false).length;
        const oldest = stalled.length ? stalled[0].waitingMinutes : null;

        const likelyCauses: string[] = [];
        if (stalled.length === 0) {
            likelyCauses.push("No stalled New items — nothing to diagnose.");
        } else {
            if (available === 0 && busy === 0 && unhealthy > 0) {
                likelyCauses.push("All robots are unresponsive/disconnected — no runner to pick items up.");
            } else if (available === 0 && busy > 0) {
                likelyCauses.push("All robots are Busy — items wait until a robot frees up.");
            } else if (available === 0) {
                likelyCauses.push("No robots Available in this folder.");
            }
            if (enabled === 0 && disabled > 0) {
                likelyCauses.push("All triggers for this folder are disabled — nothing is scheduled to run.");
            } else if (enabled === 0) {
                likelyCauses.push("No triggers found — the process may only run on demand or isn't scheduled.");
            }
            if (likelyCauses.length === 0) {
                likelyCauses.push("Robots and triggers look fine — check the process is published and the queue is linked to it.");
            }
        }

        return {
            stalledCount: stalled.length,
            oldestWaitingMinutes: oldest,
            availableRobots: available,
            busyRobots: busy,
            unhealthyRobots: unhealthy,
            enabledTriggers: enabled,
            disabledTriggers: disabled,
            likelyCauses,
        };
    }

    /**
     * Daily throughput series for a process or a queue over `days`. Aggregated
     * in-service (not via OData $apply) for cross-version safety. Returns the
     * per-day series plus derived avg/day and success rate — a series beats a
     * single "average" that hides RPA's heavy day-of-week seasonality.
     */
    async getThroughput(
        target: string,
        targetType: "process" | "queue",
        days = 7,
        folderId?: string,
    ): Promise<ThroughputReport> {
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const buckets = new Map<string, ThroughputDay>();

        if (targetType === "process") {
            const jobs = await this.#client.listJobsByProcessSince(target, sinceIso, 1000, folderId);
            for (const job of jobs) {
                const day = dayKey(job.CreationTime);
                if (!day) continue;
                const b = bucket(buckets, day);
                b.total += 1;
                if (job.State === "Successful") b.successful += 1;
                else if (job.State === "Faulted" || job.State === "Stopped") b.failed += 1;
            }
        } else {
            const def = await this.#client.findQueueDefinition(target, folderId);
            if (!def) throw new Error(`No queue named "${target}" in this folder.`);
            const items = await this.#client.listQueueItemsByQueueSince(def.Id, sinceIso, 1000, folderId);
            for (const item of items) {
                const day = dayKey(item.CreationTime ?? null);
                if (!day) continue;
                const b = bucket(buckets, day);
                b.total += 1;
                if (item.Status === "Successful") b.successful += 1;
                else if (item.Status === "Failed" || item.Status === "Abandoned") b.failed += 1;
            }
        }

        const series = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
        const totalAll = series.reduce((s, d) => s + d.total, 0);
        const successAll = series.reduce((s, d) => s + d.successful, 0);
        const failAll = series.reduce((s, d) => s + d.failed, 0);
        const denom = successAll + failAll;

        return {
            target,
            targetType,
            days,
            series,
            avgPerDay: days > 0 ? Math.round((totalAll / days) * 100) / 100 : 0,
            successRate: denom > 0 ? Math.round((successAll / denom) * 1000) / 1000 : 0,
        };
    }

    /**
     * Explain why one job failed. Multi-call: fetches the job and its Error/Fatal
     * logs in parallel, extracts the primary exception message, and folds it into
     * a plain-language summary. This correlation is the diagnostic value the raw
     * API doesn't provide — one call answers "what broke and where".
     */
    async explainFailure(jobKey: string, folderId?: string): Promise<FailureExplanation> {
        const [job, logs] = await Promise.all([
            this.#client.getJobByKey(jobKey, folderId),
            this.#client.getJobLogs(jobKey, 50, folderId),
        ]);

        // newest first; the client already orders by TimeStamp desc, but be safe
        const ordered = [...logs].sort((a, b) =>
            (b.TimeStamp ?? "").localeCompare(a.TimeStamp ?? ""),
        );
        const logExcerpt = ordered
            .map((l) => l.Message?.trim())
            .filter((m): m is string => Boolean(m))
            .slice(0, 5);

        // Primary error: first non-empty log message, else the job's Info field.
        const primaryError = logExcerpt[0] ?? job?.Info ?? null;

        const processName = job?.ProcessName ?? null;
        const summary = buildFailureSummary({
            found: Boolean(job),
            processName,
            state: job?.State ?? null,
            host: job?.HostMachineName ?? null,
            errorLogCount: ordered.length,
            primaryError,
        });

        return {
            jobId: job?.Id ?? null,
            jobKey,
            processName,
            state: job?.State ?? null,
            startTime: job?.StartTime ?? null,
            endTime: job?.EndTime ?? null,
            hostMachineName: job?.HostMachineName ?? null,
            primaryError,
            errorLogCount: ordered.length,
            logExcerpt,
            summary,
        };
    }

    /** Average duration (minutes) of recent successful runs, or null if too few. */
    async #processBaselineMinutes(processName: string, folderId?: string): Promise<number | null> {
        const finished = await this.#client.listFinishedJobsByProcess(processName, 20, folderId);
        const durations: number[] = [];
        for (const job of finished) {
            if (job.StartTime && job.EndTime) {
                durations.push((Date.parse(job.EndTime) - Date.parse(job.StartTime)) / 60000);
            }
        }
        if (durations.length < BASELINE_MIN_SAMPLES) return null;
        return durations.reduce((a, b) => a + b, 0) / durations.length;
    }
}

/** Stuck-detection tuning. */
const DEFAULT_THRESHOLD_MIN = 60; // fixed fallback when no explicit/baseline value
const BASELINE_FACTOR = 2; // "stuck" = running longer than 2× the average
const BASELINE_MIN_SAMPLES = 3; // need at least this many history points to trust baseline

/** Rank folder matches: exact name first, then prefix, then substring. */
function folderMatchRank(f: Folder, q: string): number {
    const name = f.DisplayName.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    return 2;
}

/** UTC day key (YYYY-MM-DD) from an ISO timestamp, or null if missing/invalid. */
function dayKey(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
}

/** Get-or-create a per-day throughput bucket. */
function bucket(map: Map<string, ThroughputDay>, day: string): ThroughputDay {
    let b = map.get(day);
    if (!b) {
        b = { date: day, total: 0, successful: 0, failed: 0 };
        map.set(day, b);
    }
    return b;
}

/** Compose a plain-language failure summary from the correlated facts. */
function buildFailureSummary(f: {
    found: boolean;
    processName: string | null;
    state: string | null;
    host: string | null;
    errorLogCount: number;
    primaryError: string | null;
}): string {
    if (!f.found) {
        return "No job found for that key — it may be in another folder, or the key is wrong.";
    }
    const proc = f.processName ?? "the process";
    const where = f.host ? ` on ${f.host}` : "";
    if (f.errorLogCount === 0 && !f.primaryError) {
        return `${proc} ended in state ${f.state ?? "unknown"}${where}, but no Error/Fatal logs were recorded. Check the job's output or run with verbose logging.`;
    }
    const error = f.primaryError ?? "(no message captured)";
    return `${proc} failed${where} (state ${f.state ?? "unknown"}). Primary error: ${error}. ${f.errorLogCount} Error/Fatal log entr${f.errorLogCount === 1 ? "y" : "ies"} found.`;
}

/** Default lookback: 24 hours ago, ISO-8601 (OData expects no quotes on dates). */
function defaultSince(): string {
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

/** Higher rank = more urgent for the support agent to see. */
function unhealthyRank(s: RobotSession): number {
    if (s.IsUnresponsive || s.State === "Unresponsive") return 3;
    if (s.State === "Disconnected") return 2;
    if (s.State === "Unknown") return 1;
    return 0;
}
