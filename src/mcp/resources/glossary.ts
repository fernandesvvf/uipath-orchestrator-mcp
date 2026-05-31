import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * RESOURCE = read-only context the agent can read WITHOUT spending a tool call.
 * The UiPath domain vocabulary: what each job/queue/robot state means, so the
 * agent reasons correctly about results (e.g. Stopped != Faulted, New != stuck).
 */
export function registerGlossaryResource(server: McpServer): void {
    server.registerResource(
        "uipath://glossary",
        "uipath://glossary",
        {
            description: "UiPath Orchestrator vocabulary: job/queue/robot states and what they mean",
        },
        () => ({
            contents: [
                {
                    uri: "uipath://glossary",
                    mimeType: "text/plain",
                    text: `
UiPath Orchestrator — states & terms (for reasoning about tool results)

JOB STATES
  Pending      Queued, waiting for a robot.
  Running      Currently executing. (Running for too long => see find_stuck_jobs.)
  Successful   Finished OK.
  Faulted      Finished with an unhandled error. THIS is a real failure.
  Stopped      A user/system stopped it before completion. Not a code failure.
  Stopping     Stop requested, winding down.
  Suspended    Paused (long-running workflow waiting on an external event).
  Resumed      Continued after suspension.

QUEUE ITEM STATUSES
  New          Added to the queue, NOT yet picked up. (New for too long =>
               nobody is processing it; see find_stalled_queue_items / diagnose_queue_stall.)
  InProgress   A robot picked it up and is processing it. (InProgress too long =>
               the robot likely died/hung mid-item.)
  Successful   Processed OK.
  Failed       Processing raised a business/application exception.
  Abandoned    Left InProgress too long; auto-abandoned by Orchestrator.
  Retried      Failed and re-enqueued for another attempt.
  Deleted      Removed.

ROBOT / SESSION STATES
  Available    Connected and idle, ready to run.
  Busy         Connected and running a job.
  Disconnected Not connected to Orchestrator.
  Unresponsive No heartbeat for ~2 min — robot likely crashed/network issue.

KEY TERMS
  Folder       An Orchestrator organizational unit. Scoping uses its id
               (X-UIPATH-OrganizationUnitId). Users know NAMES, not ids — use find_folders.
  Process / Release  A deployed automation that jobs are instances of.
  Trigger / Schedule  Starts a process on a cron or queue event. If disabled,
               nothing runs automatically (a common cause of stalled New items).
  Job Key      The GUID identifying a job — pass it to explain_failure / get_job_logs.

REASONING TIPS
  - "Failure" usually means Faulted jobs, not Stopped. Don't count Stopped as errors.
  - A New item is not "stuck"/"running" — it simply hasn't started; the cause is
    upstream (no robot / disabled trigger / unpublished process).
  - Robot Unresponsive + items not moving => no runner, not a code bug.
                    `.trim(),
                },
            ],
        }),
    );
}
