# uipath-orchestrator-mcp

Read-only MCP server for **UiPath Orchestrator** — support & monitoring of
automations. Built from the `api-crud` preset (clean architecture + bearer auth
+ client-side rate limiting). The MCP is a thin adapter over the Orchestrator
OData API; it adds a curated *incident* view that the raw API doesn't give.

> **Docs:** `ARCHITECTURE.md` (referência técnica) · `LEARNING.md` (conceitos do
> zero + paralelos UiPath/REFramework, pra quem está aprendendo) ·
> `VALIDATION.md` (checklist contra tenant real).

## Layers (dependency flows inward →)

```
src/
  domain/          orchestrator.ts (Zod schemas/types), errors.ts, auth.ts  ← no deps
  application/     orchestrator-service.ts  (aggregation / triage logic)
  infrastructure/  orchestrator-http-client.ts  (the only HTTP code; OData)
  mcp/
    server.ts          composition root (wires everything)
    middleware/        rate-limiter.ts (token bucket)
    tools/             one file per tool
    resources/         api-info (read-only context)
    prompts/           triage-incidents (user-triggered workflow)
  index.ts         transport (stdio) only
```

Rule: `mcp → application → infrastructure → domain`. Never import backward.

## Tools (all read-only)

| Tool | Purpose |
|------|---------|
| `find_folders` | Resolve a plain-text name (e.g. "compras") to matching folders. The user never needs a folder id — call this first, confirm, then scope by id. |
| `get_folder_overview` | One-call health of an automation: failed/stuck jobs, unhealthy robots, failed queue items, top incidents. Resolves folder by name. |
| `summarize_incidents` | Faulted jobs in a window grouped by process. |
| `list_failed_jobs` | Faulted jobs in a time window. |
| `get_job_logs` | Error/Fatal robot logs for one job (by Key) — raw logs. |
| `explain_failure` | Correlates a job with its Error/Fatal logs, extracts the primary exception, returns a plain-language root-cause summary (one call vs list+logs+read). |
| `get_robot_health` | Robot/runtime sessions; unresponsive/disconnected first. |
| `get_queue_backlog` | Queue items, optionally filtered by status. |
| `find_stuck_jobs` | Jobs running past their per-process baseline (2× avg duration; explicit override; 60min fallback). Adds the baseline that Orchestrator's native fixed-threshold alert lacks. |
| `find_stalled_queue_items` | Queue items stuck in New — added but never picked up. |
| `diagnose_queue_stall` | Why New items aren't running: correlates robot availability + trigger state → likely causes. |
| `get_throughput` | Daily volume series (total/success/fail) for a process or queue, plus avg/day + success rate. |

### Resources & prompts

| Kind | Name | Purpose |
|------|------|---------|
| Resource | `api://info` | Backend description: URL, auth, scope, tool list, flow. |
| Resource | `uipath://glossary` | Job/queue/robot state meanings so the agent reasons correctly (Faulted ≠ Stopped, New ≠ stuck). |
| Prompt | `triage_incidents` | Guided failure triage: summarize → pick job → `explain_failure` → robot health → summary. Optional `folderName` scopes by name. |
| Prompt | `daily_health_report` | `get_folder_overview` + `get_throughput` per top process + stall check → a consistent daily report. |

**Folder-by-name flow:** the user names an area → `find_folders` → if >1 match,
the agent asks which → scoped tools run with the resolved id. Stuck-detection
thresholds are hybrid: an explicit `thresholdMinutes` always wins; otherwise
`find_stuck_jobs` derives a per-process baseline (2× the average duration of
recent successful runs) and falls back to 60 minutes when history is too thin.

## Run

```bash
npm install
UIPATH_PAT=<pat> UIPATH_BASE_URL=https://cloud.uipath.com/<org>/<tenant>/orchestrator_ npm start
npm test                 # unit (no backend) + e2e (skipped unless UIPATH_* set)
npm run mcp:inspect      # open MCP Inspector to poke tools by hand
```

Wire into VS Code / Copilot via `.vscode/mcp.json` (fill in PAT + base URL).

## Config (env)

| Var | Meaning |
|-----|---------|
| `UIPATH_BASE_URL` | `https://cloud.uipath.com/<org>/<tenant>/orchestrator_` |
| `UIPATH_PAT` | Personal Access Token, **read-only scope** (View Jobs/Robots/Queues/Logs). |
| `ORG_UNIT_ID` | Default folder id (`X-UIPATH-OrganizationUnitId`). Optional. |
| `RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SEC` | Client-side token bucket. |

**Folder scoping is hybrid:** each tool takes an optional `folderId` that
overrides the `ORG_UNIT_ID` env default, so the agent can target any folder
dynamically while the common case stays config-only.

## Security model

- **Auth**: `UIPATH_PAT` → `BearerAuth` → `Authorization: Bearer`. Use a
  read-only PAT (least privilege reinforces the read-only design). No token →
  `NoAuth` (dev; Orchestrator will 401).
- **Rate limit**: token bucket inside the MCP guards Orchestrator *before* the
  network. Orchestrator 429 is also mapped.
- **Error translation**: HTTP 401/403/429 → `Unauthorized/Forbidden/RateLimit`
  domain errors → surfaced to the model as `isError + message`.

## v1 scope

Read-only by design. Control actions (retry/start/stop job, resume queue) are
intentionally out — they'd need stronger auth + confirmations. Add them later
via the `add-tool` skill if needed.
