import type {
    Job,
    QueueItem,
    RobotSession,
    RobotLog,
    Folder,
    ProcessSchedule,
} from "../domain/orchestrator.ts";
import type { AuthProvider } from "../domain/auth.ts";
import { UnauthorizedError, ForbiddenError, RateLimitError } from "../domain/errors.ts";
import type { RateLimiter } from "../mcp/middleware/rate-limiter.ts";

/**
 * INFRASTRUCTURE — the ONLY layer that knows about HTTP / the backend.
 * Talks to the UiPath Orchestrator OData API. Read-only by design (v1).
 *
 * Responsibilities:
 *   1. attach auth headers (Bearer PAT via AuthProvider)
 *   2. attach folder scope header (X-UIPATH-OrganizationUnitId) — hybrid:
 *      per-call folderId wins, else the env default (#defaultFolderId)
 *   3. throttle outgoing calls (client-side RateLimiter)
 *   4. translate HTTP status -> named domain errors (#assertOk)
 *   5. hide OData mechanics ($filter/$top, { value: [...] } envelope) from
 *      the rest of the app — callers get plain typed arrays.
 *
 * baseUrl example:
 *   https://cloud.uipath.com/{org}/{tenant}/orchestrator_
 */
export class OrchestratorHttpClient {
    #baseUrl: string;
    #auth: AuthProvider;
    #limiter?: RateLimiter;
    #defaultFolderId?: string;

    constructor(
        baseUrl: string,
        auth: AuthProvider,
        limiter?: RateLimiter,
        defaultFolderId?: string,
    ) {
        // normalize: drop a trailing slash so path concatenation is predictable
        this.#baseUrl = baseUrl.replace(/\/$/, "");
        this.#auth = auth;
        this.#limiter = limiter;
        this.#defaultFolderId = defaultFolderId;
    }

    /** Folder scope: explicit arg wins, else env default. May be undefined. */
    #folderHeader(folderId?: string): Record<string, string> {
        const id = folderId ?? this.#defaultFolderId;
        return id ? { "X-UIPATH-OrganizationUnitId": id } : {};
    }

    /** Wrap fetch: spend a rate-limit token, attach auth + folder headers. */
    async #get(path: string, folderId?: string): Promise<Response> {
        this.#limiter?.take(); // throws RateLimitError if bucket empty
        return fetch(`${this.#baseUrl}${path}`, {
            method: "GET",
            headers: {
                Accept: "application/json",
                ...this.#auth.headers(),
                ...this.#folderHeader(folderId),
            },
        });
    }

    /** Map transport status codes to named domain errors. */
    async #assertOk(res: Response): Promise<void> {
        if (res.status === 401) throw new UnauthorizedError();
        if (res.status === 403) throw new ForbiddenError();
        if (res.status === 429) throw new RateLimitError();
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} - ${res.statusText} - ${await res.text()}`);
        }
    }

    /** Unwrap the OData envelope: { value: [...] } -> [...]. */
    async #value<T>(res: Response): Promise<T[]> {
        await this.#assertOk(res);
        const body = (await res.json()) as { value?: T[] };
        return body.value ?? [];
    }

    /**
     * Fetch ALL pages of an OData collection by looping `$skip` in pages of
     * `pageSize` (some endpoints — e.g. QueueItems — cap `$top` at 100). Stops
     * when a page returns fewer than `pageSize`, or at `maxItems` (safety cap so
     * a huge queue can't hang the agent).
     */
    async #getAllPages<T>(
        path: string,
        params: Record<string, string | number | undefined>,
        folderId?: string,
        pageSize = 100,
        maxItems = 2000,
    ): Promise<T[]> {
        const all: T[] = [];
        for (let skip = 0; skip < maxItems; skip += pageSize) {
            const qs = this.#query({ ...params, $top: pageSize, $skip: skip });
            const res = await this.#get(`${path}${qs}`, folderId);
            const page = await this.#value<T>(res);
            all.push(...page);
            if (page.length < pageSize) break; // last page
        }
        return all.slice(0, maxItems);
    }

    /** Build an OData query string from params, skipping undefined values. */
    #query(params: Record<string, string | number | undefined>): string {
        const parts: string[] = [];
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined) continue;
            parts.push(`${key}=${encodeURIComponent(String(value))}`);
        }
        return parts.length ? `?${parts.join("&")}` : "";
    }

    /** Faulted jobs created since `sinceIso`, newest first. */
    async listFailedJobs(sinceIso?: string, top = 50, folderId?: string): Promise<Job[]> {
        const filter = sinceIso
            ? `State eq 'Faulted' and CreationTime gt ${sinceIso}`
            : `State eq 'Faulted'`;
        const qs = this.#query({
            $filter: filter,
            $orderby: "CreationTime desc",
            $top: top,
        });
        const res = await this.#get(`/odata/Jobs${qs}`, folderId);
        return (await this.#value<Raw>(res)).map(toJob);
    }

    /** Jobs in any state (optionally filtered), newest first. */
    async listJobs(state?: string, top = 50, folderId?: string): Promise<Job[]> {
        const qs = this.#query({
            $filter: state ? `State eq '${state}'` : undefined,
            $orderby: "CreationTime desc",
            $top: top,
        });
        const res = await this.#get(`/odata/Jobs${qs}`, folderId);
        return (await this.#value<Raw>(res)).map(toJob);
    }

    /** Fetch a single job by its Key (GUID), or null if not found. */
    async getJobByKey(jobKey: string, folderId?: string): Promise<Job | null> {
        const qs = this.#query({ $filter: `Key eq ${jobKey}`, $top: 1 });
        const res = await this.#get(`/odata/Jobs${qs}`, folderId);
        const jobs = (await this.#value<Raw>(res)).map(toJob);
        return jobs[0] ?? null;
    }

    /** Error/Fatal robot logs for a given job key, newest first. */
    async getJobLogs(jobKey: string, top = 100, folderId?: string): Promise<RobotLog[]> {
        const qs = this.#query({
            $filter: `JobKey eq ${jobKey} and (Level eq 'Error' or Level eq 'Fatal')`,
            $orderby: "TimeStamp desc",
            $top: top,
        });
        const res = await this.#get(`/odata/RobotLogs${qs}`, folderId);
        return (await this.#value<Raw>(res)).map(toRobotLog);
    }

    /** Current robot/runtime sessions (robot health). */
    async listRobotSessions(top = 100, folderId?: string): Promise<RobotSession[]> {
        const qs = this.#query({ $top: top });
        const res = await this.#get(`/odata/Sessions${qs}`, folderId);
        return (await this.#value<Raw>(res)).map(toRobotSession);
    }

    /** Queue items, optionally filtered by status, newest first. */
    async listQueueItems(
        status?: string,
        top = 100,
        folderId?: string,
    ): Promise<QueueItem[]> {
        const qs = this.#query({
            $filter: status ? `Status eq '${status}'` : undefined,
            $orderby: "StartProcessing desc",
            $top: top,
        });
        const res = await this.#get(`/odata/QueueItems${qs}`, folderId);
        return (await this.#value<Raw>(res)).map(toQueueItem);
    }

    /**
     * Folders the current user can see, INCLUDING personal workspaces.
     * Tenant-level — NO folder header here. Returns name + id so the service can
     * resolve a user's plain-text folder name into the id the other calls need.
     *
     * Personal workspaces live in a SEPARATE endpoint (/odata/PersonalWorkspaces)
     * and are NOT returned by /odata/Folders, so we fetch both and merge. The
     * workspace's `Name` is mapped to `DisplayName` to match the Folder shape.
     */
    async listFolders(top = 200): Promise<Folder[]> {
        const foldersQs = this.#query({ $orderby: "DisplayName", $top: top });
        const [foldersRes, wsRes] = await Promise.all([
            this.#get(`/odata/Folders${foldersQs}`),
            this.#get(`/odata/PersonalWorkspaces${this.#query({ $top: top })}`),
        ]);
        // Map BOTH sources down to the declared Folder shape only. The raw
        // OData rows carry many extra fields; outputSchema is strict, so we
        // must not leak them into structuredContent ("additional properties").
        type RawFolder = { Id: number; Key?: string; DisplayName?: string; FullyQualifiedName?: string | null };
        const folders = (await this.#value<RawFolder>(foldersRes)).map((f) => ({
            Id: f.Id,
            Key: f.Key,
            DisplayName: f.DisplayName ?? "(folder)",
            FullyQualifiedName: f.FullyQualifiedName ?? null,
        }));
        const workspaces = await this.#value<{ Id: number; Key?: string; Name?: string }>(wsRes);
        const mappedWorkspaces: Folder[] = workspaces.map((w) => ({
            Id: w.Id,
            Key: w.Key,
            DisplayName: w.Name ?? "(personal workspace)",
            FullyQualifiedName: w.Name ?? null,
        }));
        return [...folders, ...mappedWorkspaces];
    }

    /** Jobs currently in Running state (for stuck detection). */
    async listRunningJobs(top = 200, folderId?: string): Promise<Job[]> {
        const qs = this.#query({
            $filter: `State eq 'Running'`,
            $orderby: "StartTime asc",
            $top: top,
        });
        const res = await this.#get(`/odata/Jobs${qs}`, folderId);
        return (await this.#value<Raw>(res)).map(toJob);
    }

    /**
     * Recently finished (Successful) jobs for one process — used to compute a
     * baseline average duration. Newest first.
     */
    async listFinishedJobsByProcess(
        processName: string,
        top = 20,
        folderId?: string,
    ): Promise<Job[]> {
        const qs = this.#query({
            // Jobs OData filters on ReleaseName (process name), not ProcessName.
            $filter: `State eq 'Successful' and ReleaseName eq '${processName.replace(/'/g, "''")}'`,
            $orderby: "EndTime desc",
            $top: top,
        });
        const res = await this.#get(`/odata/Jobs${qs}`, folderId);
        return (await this.#value<Raw>(res)).map(toJob);
    }

    /** Queue items still in New (never picked up), oldest first. */
    async listNewQueueItems(top = 100, folderId?: string): Promise<QueueItem[]> {
        const qs = this.#query({
            $filter: `Status eq 'New'`,
            $orderby: "CreationTime asc",
            $top: top,
        });
        const res = await this.#get(`/odata/QueueItems${qs}`, folderId);
        return (await this.#value<Raw>(res)).map(toQueueItem);
    }

    /** Triggers/schedules in a folder (for stall diagnosis). */
    async listProcessSchedules(top = 200, folderId?: string): Promise<ProcessSchedule[]> {
        const qs = this.#query({ $top: top });
        const res = await this.#get(`/odata/ProcessSchedules${qs}`, folderId);
        return (await this.#value<Raw>(res)).map(toProcessSchedule);
    }

    /**
     * Jobs created within a window for one process (throughput). We aggregate
     * by day in the service rather than relying on OData $apply, which is not
     * uniformly supported across Orchestrator versions.
     */
    async listJobsByProcessSince(
        processName: string,
        sinceIso: string,
        folderId?: string,
    ): Promise<Job[]> {
        const rows = await this.#getAllPages<Raw>(
            "/odata/Jobs",
            {
                $filter: `ReleaseName eq '${processName.replace(/'/g, "''")}' and CreationTime gt ${sinceIso}`,
                $orderby: "CreationTime asc",
            },
            folderId,
        );
        return rows.map(toJob);
    }

    /** Queue items created within a window for one queue (throughput). Paginated. */
    async listQueueItemsByQueueSince(
        queueDefinitionId: number,
        sinceIso: string,
        folderId?: string,
    ): Promise<QueueItem[]> {
        const rows = await this.#getAllPages<Raw>(
            "/odata/QueueItems",
            {
                $filter: `QueueDefinitionId eq ${queueDefinitionId} and CreationTime gt ${sinceIso}`,
                $orderby: "CreationTime asc",
            },
            folderId,
        );
        return rows.map(toQueueItem);
    }

    /** Resolve a queue name to its definition (id) within a folder. */
    async findQueueDefinition(
        queueName: string,
        folderId?: string,
    ): Promise<{ Id: number; Name: string } | null> {
        const qs = this.#query({
            $filter: `Name eq '${queueName.replace(/'/g, "''")}'`,
            $top: 1,
        });
        const res = await this.#get(`/odata/QueueDefinitions${qs}`, folderId);
        const defs = await this.#value<{ Id: number; Name: string }>(res);
        return defs[0] ?? null;
    }
}

/**
 * MAPPERS — the OData rows carry many more fields than our domain schemas
 * declare. outputSchema is STRICT, so we project each raw row down to exactly
 * the declared shape before it can reach structuredContent. One mapper per
 * entity; drop anything not in the schema.
 */
type Raw = Record<string, unknown>;

function toJob(r: Raw): Job {
    return {
        Id: r.Id as number,
        Key: r.Key as string | undefined,
        State: r.State as Job["State"],
        ProcessName: r.ProcessName as string | undefined,
        StartTime: r.StartTime as string | null | undefined,
        EndTime: r.EndTime as string | null | undefined,
        CreationTime: r.CreationTime as string | undefined,
        HostMachineName: r.HostMachineName as string | null | undefined,
        Info: r.Info as string | null | undefined,
        HasMediaRecorded: r.HasMediaRecorded as boolean | undefined,
        OutputArguments: r.OutputArguments as string | null | undefined,
    };
}

function toRobotSession(r: Raw): RobotSession {
    return {
        Id: r.Id as number | undefined,
        MachineName: r.MachineName as string | null | undefined,
        HostMachineName: r.HostMachineName as string | null | undefined,
        RobotName: r.RobotName as string | null | undefined,
        State: r.State as RobotSession["State"],
        ReportingTime: r.ReportingTime as string | null | undefined,
        IsUnresponsive: r.IsUnresponsive as boolean | undefined,
    };
}

function toQueueItem(r: Raw): QueueItem {
    const ex = r.ProcessingException as Raw | null | undefined;
    return {
        Id: r.Id as number,
        QueueDefinitionId: r.QueueDefinitionId as number | undefined,
        Status: r.Status as QueueItem["Status"],
        Reference: r.Reference as string | null | undefined,
        Priority: r.Priority as string | null | undefined,
        CreationTime: r.CreationTime as string | null | undefined,
        StartProcessing: r.StartProcessing as string | null | undefined,
        EndProcessing: r.EndProcessing as string | null | undefined,
        RetryNumber: r.RetryNumber as number | undefined,
        ProcessingException: ex
            ? { Reason: ex.Reason as string | null | undefined, Type: ex.Type as string | null | undefined }
            : (ex as null | undefined),
    };
}

function toRobotLog(r: Raw): RobotLog {
    return {
        Id: r.Id as number | undefined,
        Level: r.Level as string | undefined,
        Message: r.Message as string | undefined,
        TimeStamp: r.TimeStamp as string | undefined,
        ProcessName: r.ProcessName as string | null | undefined,
        JobKey: r.JobKey as string | null | undefined,
    };
}

function toProcessSchedule(r: Raw): ProcessSchedule {
    return {
        Id: r.Id as number | undefined,
        Name: r.Name as string | null | undefined,
        ReleaseName: r.ReleaseName as string | null | undefined,
        Enabled: r.Enabled as boolean | undefined,
        StartProcessCron: r.StartProcessCron as string | null | undefined,
    };
}
