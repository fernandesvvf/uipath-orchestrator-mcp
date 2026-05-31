import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * PROMPT = a reusable, parameterized workflow the USER triggers (e.g. a
 * slash-command). Standardizes the support triage flow so the agent chains the
 * read-only tools in a sensible order.
 */
export function registerTriageIncidentsPrompt(server: McpServer): void {
    server.registerPrompt(
        "triage_incidents",
        {
            description: "Run a support triage of recent UiPath automation failures",
            argsSchema: {
                folderName: z
                    .string()
                    .optional()
                    .describe("Automation/area name to scope to (e.g. 'compras'). Omit for all folders."),
                since: z
                    .string()
                    .optional()
                    .describe("ISO-8601 lower bound for the window (default last 24h)"),
            },
        },
        ({ folderName, since }) => {
            const steps = [
                `Triage UiPath automation incidents${since ? ` since ${since}` : " from the last 24h"}.`,
            ];
            if (folderName) {
                steps.push(
                    `0. The user means the "${folderName}" area. Call find_folders("${folderName}"). If more than one folder matches, ask which one and stop; otherwise use its id as folderId in every step below.`,
                );
            }
            steps.push(
                "1. Call summarize_incidents to see which processes are failing most.",
                "2. For the top failing process, call list_failed_jobs and pick a representative job's Key.",
                "3. Call explain_failure on that Key to get the root-cause summary.",
                "4. Call get_robot_health to rule out fleet issues.",
                "Then summarize: what is broken, the likely cause, and a recommended next action.",
            );
            return {
                messages: [
                    { role: "user", content: { type: "text", text: steps.join("\n") } },
                ],
            };
        },
    );
}
