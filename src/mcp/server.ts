import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BearerAuth, NoAuth, type AuthProvider } from "../domain/auth.ts";
import { rateLimiterFromEnv } from "./middleware/rate-limiter.ts";
import { OrchestratorService } from "../application/orchestrator-service.ts";

import { registerSummarizeIncidentsTool } from "./tools/summarize-incidents.ts";
import { registerListFailedJobsTool } from "./tools/list-failed-jobs.ts";
import { registerGetJobLogsTool } from "./tools/get-job-logs.ts";
import { registerGetRobotHealthTool } from "./tools/get-robot-health.ts";
import { registerGetQueueBacklogTool } from "./tools/get-queue-backlog.ts";
import { registerFindFoldersTool } from "./tools/find-folders.ts";
import { registerFindStuckJobsTool } from "./tools/find-stuck-jobs.ts";
import { registerGetFolderOverviewTool } from "./tools/get-folder-overview.ts";
import { registerFindStalledQueueItemsTool } from "./tools/find-stalled-queue-items.ts";
import { registerDiagnoseQueueStallTool } from "./tools/diagnose-queue-stall.ts";
import { registerGetThroughputTool } from "./tools/get-throughput.ts";
import { registerExplainFailureTool } from "./tools/explain-failure.ts";
import { registerApiInfoResource } from "./resources/api-info.ts";
import { registerGlossaryResource } from "./resources/glossary.ts";
import { registerTriageIncidentsPrompt } from "./prompts/triage-incidents.ts";
import { registerDailyHealthReportPrompt } from "./prompts/daily-health-report.ts";

/**
 * COMPOSITION ROOT — the only place that wires the pieces together.
 * Build dependencies here (config -> auth -> limiter -> service) and register
 * every tool/resource/prompt. Stays declarative; logic lives in the service.
 */
const BASE_URL =
    process.env.UIPATH_BASE_URL ?? "https://cloud.uipath.com/ORG/TENANT/orchestrator_";
const UIPATH_PAT = process.env.UIPATH_PAT ?? "";
const ORG_UNIT_ID = process.env.ORG_UNIT_ID || undefined; // default folder scope (hybrid)

// PAT -> Bearer (course style). No token -> NoAuth (dev only, will get 401s).
const auth: AuthProvider = UIPATH_PAT ? new BearerAuth(UIPATH_PAT) : new NoAuth();

// Client-side throttle — guards Orchestrator before the network.
const limiter = rateLimiterFromEnv();

const service = new OrchestratorService(BASE_URL, auth, limiter, ORG_UNIT_ID);

export const server = new McpServer({
    name: "@you/uipath-orchestrator-mcp",
    version: "0.0.1",
});

registerFindFoldersTool(server, service);
registerGetFolderOverviewTool(server, service);
registerSummarizeIncidentsTool(server, service);
registerListFailedJobsTool(server, service);
registerGetJobLogsTool(server, service);
registerExplainFailureTool(server, service);
registerGetRobotHealthTool(server, service);
registerGetQueueBacklogTool(server, service);
registerFindStuckJobsTool(server, service);
registerFindStalledQueueItemsTool(server, service);
registerDiagnoseQueueStallTool(server, service);
registerGetThroughputTool(server, service);
registerApiInfoResource(server, BASE_URL, ORG_UNIT_ID);
registerGlossaryResource(server);
registerTriageIncidentsPrompt(server);
registerDailyHealthReportPrompt(server);
