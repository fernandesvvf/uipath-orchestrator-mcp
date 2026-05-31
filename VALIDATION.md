# Validation checklist — UiPath Orchestrator MCP

Validate against a **real tenant** before trusting the tools. The unit tests
stub fetch; only a live run proves the OData filters, the folder header, the
PAT scopes, and the response shapes are right. Work top-down — later steps
depend on earlier ones passing.

## 0. Setup

1. Create a **read-only PAT** (Automation Cloud → user icon → **Preferences** →
   **Personal Access Token**). Pick read/view scopes for: **Folders, Jobs,
   Robots (Sessions), Queues/Transactions, Monitoring/Logs, Triggers/Schedules**.
   Full step-by-step + scope→tool table: see `README.md` → "Generating the PAT".
2. Find your base URL `https://cloud.uipath.com/<org>/<tenant>/orchestrator_`
   (README → "Base URL — finding `<org>` and `<tenant>`").
3. Configure the env — `cp .env.example .env`, then set `UIPATH_BASE_URL` and
   `UIPATH_PAT`. Leave `ORG_UNIT_ID` empty for now (we test folder resolution
   first). The Inspector loads `.env` automatically. (Alternatively, put the same
   values in `.vscode/mcp.json`'s `env` block.)
4. Launch the Inspector:
   ```bash
   npm run mcp:inspect
   ```
5. Confirm the server boots and lists **14 tools, 2 resources, 2 prompts**.
   Read the `api://info` resource to sanity-check the wiring.

---

## 1. Auth smoke test (do this FIRST)

| Step | Tool | Expect | If it fails |
|------|------|--------|-------------|
| 1.1 | `find_folders` with `query=""` (empty) | A list of folders | **401** → PAT wrong/expired. **403** → PAT missing Folders.View. |

If 1.1 returns folders, auth + base URL are correct. Everything else builds on this.

---

## 2. Folder resolution (the foundation — `/odata/Folders`)

| Step | Tool / call | Expect | Watch for |
|------|-------------|--------|-----------|
| 2.1 | `find_folders` query = a word you know is in a folder name | Only matching folders, names readable | If empty but folders exist → the endpoint may be `GetFoldersForCurrentUser` instead of plain `/odata/Folders`. |
| 2.2 | Note one folder's `Id` | — | This `Id` (as a string) is the `folderId` for every later step. |

> **Likely gotcha:** some tenants only return folders via
> `/odata/Folders/UiPath.Server.Configuration.OData.GetFoldersForCurrentUser`.
> If 2.1 is empty (or 404), patch `listFolders` in
> `infrastructure/orchestrator-http-client.ts` to that path.

---

## 3. Jobs endpoints (`/odata/Jobs`)

Use the `folderId` from step 2.2 in each call.

| Step | Tool | Underlying filter | Expect | Watch for |
|------|------|-------------------|--------|-----------|
| 3.1 | `list_failed_jobs` | `State eq 'Faulted' and CreationTime gt {iso}` | Array (maybe empty) | **400** on the date → tenant wants `datetime'...'` or a cast around `CreationTime gt`. Adjust the `$filter` in `listFailedJobs`. |
| 3.2 | `summarize_incidents` | same as 3.1, grouped in-service | Incidents grouped by process | Empty is fine if no failures; force a window with `since` far in the past. |
| 3.3 | `find_stuck_jobs` | `State eq 'Running'` + baseline | Stuck jobs or empty | Needs `StartTime`; if always empty with running jobs, check `StartTime` is populated. |
| 3.4 | `explain_failure` with a Faulted job's `Key` | Summary + primaryError | **400** on `Key eq {guid}` → tenant wants `Key eq guid'...'` quoting. Adjust `getJobByKey`. |

> **Two filters most likely to 400:** the bare `CreationTime gt {iso}` (date
> literal format) and `Key eq {guid}` (GUID quoting). Test 3.1 and 3.4 early.

---

## 4. Logs (`/odata/RobotLogs`)

| Step | Tool | Filter | Expect | Watch for |
|------|------|--------|--------|-----------|
| 4.1 | `get_job_logs` with a job `Key` | `JobKey eq {key} and (Level eq 'Error' or Level eq 'Fatal')` | Error/Fatal log lines | **400** if `JobKey` also needs GUID quoting. **403** → missing Logs.View. Empty → that job had no Error/Fatal logs (try a known-failed job). |

---

## 5. Robots / sessions (`/odata/Sessions`)

| Step | Tool | Expect | Watch for |
|------|------|--------|-----------|
| 5.1 | `get_robot_health` | Sessions with `State` | **404/400** → modern tenants may expose runtime state via a different entity (e.g. `Sessions` vs a robots/machines endpoint). Check the returned shape matches `RobotSessionSchema` (State, MachineName, IsUnresponsive). Adjust schema/endpoint if fields differ. |

---

## 6. Queues (`/odata/QueueItems`, `/odata/QueueDefinitions`)

| Step | Tool | Filter | Expect | Watch for |
|------|------|--------|--------|-----------|
| 6.1 | `get_queue_backlog` (no status) | none | Queue items | Confirm `CreationTime` is present on items (added to schema — verify it's actually returned). |
| 6.2 | `find_stalled_queue_items` | `Status eq 'New'` | New items past threshold | Needs `CreationTime`; if always empty with New items, the field is named differently. |
| 6.3 | `get_throughput` targetType=`queue`, target = a real queue name | resolves via `/odata/QueueDefinitions` `Name eq '...'` then items | Daily series | **404/empty** → queue name not found; check `QueueDefinitions` returns `Name`. |
| 6.4 | `get_throughput` targetType=`process`, target = a real process name | `/odata/Jobs` `ProcessName eq '...'` | Daily series | Process name must match `ProcessName` exactly (case-sensitive in OData). |

---

## 7. Triggers + the diagnosis (`/odata/ProcessSchedules`)

| Step | Tool | Expect | Watch for |
|------|------|--------|-----------|
| 7.1 | (raw) read `/odata/ProcessSchedules` via `diagnose_queue_stall` | `enabledTriggers` / `disabledTriggers` counts > 0 if folder has triggers | **403** → PAT missing Triggers/Schedules permission. The tool still returns the robot half; only trigger counts go to 0. |
| 7.2 | `diagnose_queue_stall` (with stalled New items present) | `likelyCauses` makes sense vs reality | If a cause is wrong, the heuristic in `diagnoseQueueStall` needs tuning. Note: trigger counts are folder-wide, not per-queue (documented limitation). |

---

## 8. Multi-call / aggregate tools (run last — they depend on 3–7)

| Step | Tool | Depends on | Expect |
|------|------|-----------|--------|
| 8.1 | `get_folder_overview` with an exact folder name | Jobs + stuck + Sessions + QueueItems | One consolidated object; ambiguous name → a clear "ask which one" error. |
| 8.2 | Prompt `triage_incidents` (folderName + since) | find_folders → summarize → explain_failure → robot health | Agent chains tools in order. |
| 8.3 | Prompt `daily_health_report` | overview → throughput → stall check | A coherent report. |

---

## 9. Negative tests (confirm error handling)

| Step | Call | Expect |
|------|------|--------|
| 9.1 | Set `UIPATH_PAT` to garbage, call `list_failed_jobs` | `isError: true`, message contains "unauthorized" |
| 9.2 | `explain_failure` with a non-existent Key | `summary` says "No job found", no crash |
| 9.3 | `get_throughput` queue name that doesn't exist | `isError: true` with a readable message |
| 9.4 | Hammer any tool fast (loop) | Eventually `isError: true` with rate-limit message (client-side bucket) |

---

## Quick triage of failures

- **401 everywhere** → PAT wrong/expired or base URL missing `/orchestrator_`.
- **403 on one entity** → PAT missing that entity's View scope.
- **400 on a date filter** → `CreationTime gt {iso}` format; try `datetime` literal.
- **400 on Key/JobKey** → GUID needs quoting (`guid'...'`).
- **Empty when data should exist** → wrong `folderId` (folder header), or the
  field used in `$filter`/`$orderby` is named differently in your version.
- **404 on Folders/Sessions** → endpoint name differs; see steps 2 and 5.

## Where to fix each thing

All HTTP/OData lives in **one file**:
`src/infrastructure/orchestrator-http-client.ts`. Endpoints, `$filter`
strings, and the `{ value }` unwrap are all there — adjust there, nowhere else.
Status→error mapping (401/403/429) is in `#assertOk` in the same file.
