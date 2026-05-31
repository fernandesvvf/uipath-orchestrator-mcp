import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * RESOURCE = read-only context the client can attach (like a GET). The model
 * does NOT call it like a tool. Describes the backend so the agent "knows" the
 * shape without spending a tool call.
 */
export function registerApiInfoResource(
    server: McpServer,
    baseUrl: string,
    defaultFolderId?: string,
): void {
    server.registerResource(
        "api://info",
        "api://info",
        {
            description: "Describes this MCP's backend: UiPath Orchestrator base URL, auth, scope, tools",
        },
        () => ({
            contents: [
                {
                    uri: "api://info",
                    mimeType: "text/plain",
                    text: `
Backend  : UiPath Orchestrator (OData API), READ-ONLY
Base URL : ${baseUrl}
Auth     : Bearer Personal Access Token (env UIPATH_PAT), sent as Authorization header
Folder   : X-UIPATH-OrganizationUnitId header. Default: ${defaultFolderId ?? "(none — pass folderId per tool)"}
           Hybrid: a tool's folderId argument overrides the env default.
Rate limit: client-side token bucket + Orchestrator enforcement (429 -> RateLimitError)
Entities : Folder, Job, RobotSession, QueueItem, RobotLog, IncidentGroup,
           StuckJob, FolderOverview, StalledQueueItem,
           QueueStallDiagnosis, ThroughputReport, FailureExplanation (curated)
Tools    : find_folders (resolve name->id; the user never types ids),
           get_folder_overview (one-call health of an automation),
           summarize_incidents, list_failed_jobs, get_job_logs,
           explain_failure (job + logs -> root cause summary),
           get_robot_health, get_queue_backlog,
           find_stuck_jobs (Running past its baseline duration),
           find_stalled_queue_items (New, never picked up),
           diagnose_queue_stall (why New items aren't running),
           get_throughput (daily volume/success series, process or queue)
Resources: api://info (this), uipath://glossary (job/queue/robot state meanings)
Prompts  : triage_incidents (guided failure triage),
           daily_health_report (overview + trend report for one area)
Flow     : user names an area -> find_folders -> confirm -> scoped tools by id
                    `.trim(),
                },
            ],
        }),
    );
}
