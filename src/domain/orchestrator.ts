import z from "zod";

/**
 * DOMAIN — single source of truth for shapes + types.
 * No deps on application/infrastructure/mcp. Everything points INWARD to here.
 *
 * These model the slice of UiPath Orchestrator we care about for SUPPORT &
 * MONITORING (read-only): jobs, robot/runtime sessions, queue items, and a
 * curated incident summary. Fields mirror the OData entities Orchestrator
 * returns, trimmed to what an agent actually reasons over.
 */

// ---- Job (an execution of a process) ----------------------------------------

export const JobStateSchema = z.enum([
    "Pending",
    "Running",
    "Stopping",
    "Terminating",
    "Faulted",
    "Successful",
    "Stopped",
    "Suspended",
    "Resumed",
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const JobSchema = z.object({
    Id: z.number().describe("Numeric job id"),
    Key: z.string().optional().describe("Job unique key (GUID)"),
    State: JobStateSchema.describe("Current job state"),
    ProcessName: z.string().optional().describe("Name of the process/release that ran"),
    StartTime: z.string().nullable().optional().describe("ISO start time"),
    EndTime: z.string().nullable().optional().describe("ISO end time"),
    CreationTime: z.string().optional().describe("ISO creation time"),
    HostMachineName: z.string().nullable().optional().describe("Machine that executed the job"),
    Info: z.string().nullable().optional().describe("Short status info"),
    HasMediaRecorded: z.boolean().optional().describe("Whether a recording exists"),
    OutputArguments: z.string().nullable().optional().describe("Serialized output args"),
});
export type Job = z.infer<typeof JobSchema>;

// ---- Robot / runtime session ------------------------------------------------

export const SessionStateSchema = z.enum([
    "Available",
    "Busy",
    "Disconnected",
    "Unresponsive",
    "Unknown",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const RobotSessionSchema = z.object({
    Id: z.number().optional().describe("Session id"),
    MachineName: z.string().nullable().optional().describe("Machine hosting the robot"),
    HostMachineName: z.string().nullable().optional().describe("Host machine name"),
    RobotName: z.string().nullable().optional().describe("Robot display name"),
    State: SessionStateSchema.describe("Runtime session state"),
    ReportingTime: z.string().nullable().optional().describe("ISO last heartbeat time"),
    IsUnresponsive: z.boolean().optional().describe("True when robot stopped reporting"),
});
export type RobotSession = z.infer<typeof RobotSessionSchema>;

// ---- Queue item -------------------------------------------------------------

export const QueueItemStatusSchema = z.enum([
    "New",
    "InProgress",
    "Failed",
    "Successful",
    "Abandoned",
    "Retried",
    "Deleted",
]);
export type QueueItemStatus = z.infer<typeof QueueItemStatusSchema>;

export const QueueItemSchema = z.object({
    Id: z.number().describe("Queue item id"),
    QueueDefinitionId: z.number().optional().describe("Parent queue definition id"),
    Status: QueueItemStatusSchema.describe("Processing status"),
    Reference: z.string().nullable().optional().describe("Business reference key"),
    Priority: z.string().nullable().optional().describe("Item priority"),
    CreationTime: z.string().nullable().optional().describe("ISO time the item was added to the queue"),
    StartProcessing: z.string().nullable().optional().describe("ISO time processing started"),
    EndProcessing: z.string().nullable().optional().describe("ISO time processing ended"),
    RetryNumber: z.number().optional().describe("How many times retried"),
    ProcessingException: z
        .object({
            Reason: z.string().nullable().optional(),
            Type: z.string().nullable().optional(),
        })
        .nullable()
        .optional()
        .describe("Exception details when failed"),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

// ---- Robot log (for triage) -------------------------------------------------

export const RobotLogSchema = z.object({
    Id: z.number().optional().describe("Log entry id"),
    Level: z.string().optional().describe("Log level (Error, Warn, Info...)"),
    Message: z.string().optional().describe("Log message"),
    TimeStamp: z.string().optional().describe("ISO timestamp"),
    ProcessName: z.string().nullable().optional().describe("Process that emitted the log"),
    JobKey: z.string().nullable().optional().describe("Owning job key"),
});
export type RobotLog = z.infer<typeof RobotLogSchema>;

// ---- Curated incident summary (computed in the service) ---------------------

export const IncidentGroupSchema = z.object({
    processName: z.string().describe("Process the failures belong to"),
    failureCount: z.number().describe("Number of faulted jobs in the window"),
    lastFailureTime: z.string().nullable().optional().describe("Most recent failure time"),
    sampleInfo: z.string().nullable().optional().describe("Sample error info from a job"),
});
export type IncidentGroup = z.infer<typeof IncidentGroupSchema>;

// ---- Folder (resolved by NAME so the user never needs an id) ----------------

export const FolderSchema = z.object({
    Id: z.number().describe("Folder id (used internally for scoping; not shown to the user)"),
    Key: z
        .string()
        .optional()
        .describe("Folder GUID — stable across licensing changes, unlike the numeric Id"),
    DisplayName: z.string().describe("Human folder name (what the user recognizes)"),
    FullyQualifiedName: z
        .string()
        .nullable()
        .optional()
        .describe("Full path including parent folders"),
});
export type Folder = z.infer<typeof FolderSchema>;

// ---- Stuck job (Running far longer than expected) ---------------------------

export const StuckJobSchema = z.object({
    Id: z.number().describe("Job id"),
    Key: z.string().optional().describe("Job key (GUID)"),
    ProcessName: z.string().nullable().optional().describe("Process that is running"),
    StartTime: z.string().nullable().optional().describe("ISO start time"),
    HostMachineName: z.string().nullable().optional().describe("Machine running the job"),
    runningMinutes: z.number().describe("How long the job has been Running, in minutes"),
    thresholdMinutes: z.number().describe("Threshold it exceeded (fixed or baseline-derived)"),
    thresholdSource: z
        .enum(["explicit", "baseline", "default"])
        .describe("How the threshold was decided"),
});
export type StuckJob = z.infer<typeof StuckJobSchema>;

// ---- Folder overview (multi-call consolidated health for one folder) --------

export const FolderOverviewSchema = z.object({
    folder: FolderSchema.describe("The resolved folder this overview is about"),
    failedJobCount: z.number().describe("Faulted jobs in the window"),
    stuckJobCount: z.number().describe("Jobs running past threshold"),
    unhealthyRobotCount: z.number().describe("Robots unresponsive/disconnected"),
    failedQueueItemCount: z.number().describe("Queue items in Failed status"),
    topIncidents: z.array(IncidentGroupSchema).describe("Worst processes by failure count"),
});
export type FolderOverview = z.infer<typeof FolderOverviewSchema>;

// ---- Stalled queue item (New, never picked up) ------------------------------

export const StalledQueueItemSchema = z.object({
    Id: z.number().describe("Queue item id"),
    QueueDefinitionId: z.number().optional().describe("Parent queue id"),
    Reference: z.string().nullable().optional().describe("Business reference"),
    CreationTime: z.string().nullable().optional().describe("ISO time added to the queue"),
    waitingMinutes: z.number().describe("How long it has sat in New, in minutes"),
    thresholdMinutes: z.number().describe("Threshold it exceeded"),
    thresholdSource: z.enum(["explicit", "default"]).describe("How the threshold was decided"),
});
export type StalledQueueItem = z.infer<typeof StalledQueueItemSchema>;

// ---- Process schedule / trigger (for stall diagnosis) -----------------------

export const ProcessScheduleSchema = z.object({
    Id: z.number().optional().describe("Schedule id"),
    Name: z.string().nullable().optional().describe("Trigger name"),
    ReleaseName: z.string().nullable().optional().describe("Process/release it triggers"),
    Enabled: z.boolean().optional().describe("Whether the trigger is enabled"),
    StartProcessCron: z.string().nullable().optional().describe("Cron expression"),
});
export type ProcessSchedule = z.infer<typeof ProcessScheduleSchema>;

/**
 * Why are New items not being picked up? Correlates the likely causes. Computed
 * in the service from multiple calls — this is the diagnostic value the raw API
 * does not provide.
 */
export const QueueStallDiagnosisSchema = z.object({
    stalledCount: z.number().describe("New items past the threshold"),
    oldestWaitingMinutes: z.number().nullable().optional().describe("Longest wait among stalled items"),
    availableRobots: z.number().describe("Robot sessions currently Available in the folder"),
    busyRobots: z.number().describe("Robot sessions currently Busy"),
    unhealthyRobots: z.number().describe("Robot sessions unresponsive/disconnected"),
    enabledTriggers: z.number().describe("Enabled triggers/schedules in the folder"),
    disabledTriggers: z.number().describe("Disabled triggers/schedules in the folder"),
    likelyCauses: z.array(z.string()).describe("Human-readable probable causes, most likely first"),
});
export type QueueStallDiagnosis = z.infer<typeof QueueStallDiagnosisSchema>;

// ---- Throughput (daily series for a process OR a queue) ---------------------

export const ThroughputDaySchema = z.object({
    date: z.string().describe("Day (YYYY-MM-DD, UTC)"),
    total: z.number().describe("Total items/jobs on that day"),
    successful: z.number().describe("Successful count"),
    failed: z.number().describe("Failed/faulted count"),
});
export type ThroughputDay = z.infer<typeof ThroughputDaySchema>;

export const ThroughputReportSchema = z.object({
    target: z.string().describe("The process or queue name analyzed"),
    targetType: z.enum(["process", "queue"]).describe("What kind of target"),
    days: z.number().describe("Window length in days"),
    series: z.array(ThroughputDaySchema).describe("Per-day counts"),
    avgPerDay: z.number().describe("Average total per day over the window"),
    successRate: z.number().describe("Successful / (successful + failed), 0..1"),
});
export type ThroughputReport = z.infer<typeof ThroughputReportSchema>;

// ---- Failure explanation (job + logs correlated into a diagnosis) -----------

export const FailureExplanationSchema = z.object({
    jobId: z.number().nullable().optional().describe("Job id"),
    jobKey: z.string().describe("Job key that was explained"),
    processName: z.string().nullable().optional().describe("Process that failed"),
    state: z.string().nullable().optional().describe("Job state (e.g. Faulted)"),
    startTime: z.string().nullable().optional().describe("ISO start time"),
    endTime: z.string().nullable().optional().describe("ISO end time"),
    hostMachineName: z.string().nullable().optional().describe("Machine that ran the job"),
    primaryError: z
        .string()
        .nullable()
        .optional()
        .describe("The main exception message extracted from the logs (or job Info)"),
    errorLogCount: z.number().describe("How many Error/Fatal log entries were found"),
    logExcerpt: z
        .array(z.string())
        .describe("The most relevant Error/Fatal log lines, newest first"),
    summary: z.string().describe("Plain-language summary of what failed and where"),
});
export type FailureExplanation = z.infer<typeof FailureExplanationSchema>;

/**
 * Tool result envelope. outputSchema is STRICT: every key a tool may place in
 * structuredContent (success AND error path) MUST be declared here, or the SDK
 * rejects it with "data must NOT have additional properties". Keep this WIDE.
 */
export const OrchestratorResultSchema = z.object({
    message: z.string().optional().describe("Human-readable message / confirmation"),
    isError: z.boolean().optional().describe("True when the operation failed"),
    jobs: z.array(JobSchema).optional().describe("List of jobs"),
    robots: z.array(RobotSessionSchema).optional().describe("List of robot sessions"),
    queueItems: z.array(QueueItemSchema).optional().describe("List of queue items"),
    logs: z.array(RobotLogSchema).optional().describe("List of robot log entries"),
    incidents: z.array(IncidentGroupSchema).optional().describe("Grouped incident summary"),
    folders: z.array(FolderSchema).optional().describe("Folders matching a name query"),
    stuckJobs: z.array(StuckJobSchema).optional().describe("Jobs stuck in Running"),
    overview: FolderOverviewSchema.optional().describe("Consolidated folder health"),
    stalledQueueItems: z.array(StalledQueueItemSchema).optional().describe("New items never picked up"),
    diagnosis: QueueStallDiagnosisSchema.optional().describe("Why New items aren't being processed"),
    throughput: ThroughputReportSchema.optional().describe("Daily volume/success series"),
    explanation: FailureExplanationSchema.optional().describe("Correlated failure diagnosis"),
    count: z.number().optional().describe("Number of items returned"),
});
export type OrchestratorResult = z.infer<typeof OrchestratorResultSchema>;
