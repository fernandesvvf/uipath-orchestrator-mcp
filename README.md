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

## Quick start

Follow in order — each step builds on the previous:

```bash
# 1. install dependencies (Node >= 22.9 required)
npm install

# 2. generate your PAT  → see "Generating the PAT" below

# 3. create your .env from the template, then fill in the values
cp .env.example .env        # (PowerShell: Copy-Item .env.example .env)
#    edit .env → paste UIPATH_PAT and set UIPATH_BASE_URL

# 4. try it in the browser (MCP Inspector) — loads .env automatically
npm run mcp:inspect

# other commands:
npm start     # run the server on stdio (loads .env automatically)
npm test      # unit tests (no backend); e2e skipped unless UIPATH_* set
```

The npm scripts load `.env` automatically (`node --env-file-if-exists=.env`).
No `.env`? They still run — `npm start`/`mcp:inspect` just won't be authenticated
(calls return 401). To use the server from VS Code / an agent instead of `.env`,
put the same values in `.vscode/mcp.json`'s `env` block.

## Inspect / test in the browser (MCP Inspector)

Open a browser UI that connects to the server over stdio, lists all tools /
resources / prompts, and lets you run them by hand:

```bash
npm run mcp:inspect
```

It prints a `http://localhost:...` URL — open it, click **Connect**, pick a tool,
fill the input, **Run**. With a filled `.env` the calls hit your tenant; without
a PAT the tools still *list* (good for a structure smoke test) but *calling* them
returns 401.

Suggested first check: run `find_folders` with an empty `query` — if it returns
folders, your PAT + base URL are correct. See `VALIDATION.md` for the full checklist.

## Config (env)

Set these in `.env` (copy from `.env.example`) or in `.vscode/mcp.json`:

| Var | Meaning |
|-----|---------|
| `UIPATH_BASE_URL` | `https://cloud.uipath.com/<org>/<tenant>/orchestrator_` |
| `UIPATH_PAT` | Personal Access Token, **read-only scopes** (see "Generating the PAT"). |
| `ORG_UNIT_ID` | Default folder id (`X-UIPATH-OrganizationUnitId`). Optional. |
| `RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SEC` | Client-side token bucket. Optional (defaults 20 / 5). |

**Folder scoping is hybrid:** each tool takes an optional `folderId` that
overrides the `ORG_UNIT_ID` env default, so the agent can target any folder
dynamically while the common case stays config-only.

### Finding the `ORG_UNIT_ID` (folder id)

It's optional — leave it empty and let `find_folders` resolve folders by name.
If you do want a fixed default, the folder id can be found three ways:

1. **From the Orchestrator URL** — open the folder; the address bar has
   `...?fid=2032&tid=8` → `fid` is the folder id.
2. **Via `find_folders`** — run the tool (e.g. in the Inspector) with part of the
   folder name; the result includes each match's `Id`. This is what the tool
   exists for — you never have to hunt for the number.
3. **Via the API** — `GET /odata/Folders` and read the `Id` field.

> ⚠️ The numeric `FolderId` **changes if you switch licensing plan** (e.g.
> Trial → Enterprise); the `FolderKey` (GUID) stays stable. If a fixed
> `ORG_UNIT_ID` suddenly stops working, the id likely changed — re-resolve it
> with `find_folders`.

## Generating the PAT (UiPath Automation Cloud)

The `UIPATH_PAT` is a **Personal Access Token** generated in your UiPath user
preferences ([official docs](https://docs.uipath.com/automation-cloud/automation-cloud/latest/api-guide/personal-access-tokens)):

1. Sign in to Automation Cloud, click the **user icon** (top-right) → **Preferences**.
2. In the left menu, open **Personal Access Token**.
3. Click **Generate new token**.
4. Fill in:
   - **Name** — e.g. `uipath-orchestrator-mcp (read-only)`.
   - **Expiration Date** — after this the token stops working (you'll regenerate).
   - **Scopes → Resources** — pick the **smallest read-only set** the tools need
     (see below).
5. Click **Save**, then **copy the token immediately** — this is the *only* time
   it's shown.
6. Paste it into your `.env` as `UIPATH_PAT=...` (step 3 of Quick start), or into
   `.vscode/mcp.json`. **Never commit it** — `.env` is gitignored.

### Scopes to select (least privilege, read-only)

All tools here are read-only, so grant only read/view access to:

| Resource (scope prefix `OR.…`) | Used by |
|--------------------------------|---------|
| **Folders** | `find_folders`, every folder-scoped call |
| **Jobs** | `list_failed_jobs`, `summarize_incidents`, `find_stuck_jobs`, `explain_failure`, `get_throughput`, `get_folder_overview` |
| **Robots** (Sessions) | `get_robot_health`, `diagnose_queue_stall`, `get_folder_overview` |
| **Queues** / Transactions | `get_queue_backlog`, `find_stalled_queue_items`, `get_throughput`, `diagnose_queue_stall` |
| **Monitoring / Logs** | `get_job_logs`, `explain_failure` |
| **Triggers / Schedules** | `diagnose_queue_stall` |

> Scope names follow the `OR.<Resource>` convention; the View/Read level comes
> from the **user's role permissions** per endpoint (GET needs View/Read). When
> in doubt, start with the read/view scopes for the resources above and widen
> only if a tool returns **403**. The token also inherits the permissions of the
> user who created it — that user needs at least View on those resources in the
> target folder(s).

### Base URL — finding `<org>` and `<tenant>`

`UIPATH_BASE_URL` is your tenant's Orchestrator URL plus the literal
`orchestrator_` suffix. The two placeholders come straight from the browser
address bar while you're in Orchestrator:

```
https://cloud.uipath.com/AcmeCorp/Production/orchestrator_/...
                         └──┬───┘ └───┬────┘
                          <org>    <tenant>
```

- **`<org>`** — your organization (account) name, the first path segment after
  `cloud.uipath.com/`. Also shown in **Admin → Organization settings**.
- **`<tenant>`** — the tenant name, the second segment. Also in the tenant
  switcher (top of Orchestrator) and under **Admin → Tenants**.

So for the example above: `UIPATH_BASE_URL=https://cloud.uipath.com/AcmeCorp/Production/orchestrator_`

> On-prem / Automation Suite installs use a different host (e.g.
> `https://orchestrator.mycompany.com/<tenant>/orchestrator_`) — copy whatever
> precedes the app path in your address bar and append `orchestrator_`.

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
