import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * PROMPT = a reusable, parameterized workflow the USER triggers. Produces a
 * daily health report for one automation/area, chaining the overview + trend
 * tools so the user gets a consistent report shape every time.
 */
export function registerDailyHealthReportPrompt(server: McpServer): void {
    server.registerPrompt(
        "daily_health_report",
        {
            description: "Produce a daily health report for one UiPath automation/area",
            argsSchema: {
                folderName: z
                    .string()
                    .describe("Automation/area name to report on (e.g. 'compras')."),
                days: z
                    .string()
                    .optional()
                    .describe("Trend window in days for throughput (default 7)."),
            },
        },
        ({ folderName, days }) => {
            const window = days ?? "7";
            const text = [
                `Produce a daily health report for the "${folderName}" automation.`,
                `0. Call find_folders("${folderName}"). If more than one matches, ask which one and stop; otherwise use its id as folderId below.`,
                "1. Call get_folder_overview to get failed/stuck jobs, unhealthy robots, failed queue items, and the top failing processes.",
                `2. For each of the top failing processes in the overview, call get_throughput(target=process, days=${window}) to show the recent trend and success rate.`,
                "3. Call find_stalled_queue_items; if any are stalled, call diagnose_queue_stall to find out why.",
                "Then write a concise report: overall status (green/yellow/red), what's degrading, the most likely causes, and recommended actions. Lead with the headline.",
            ].join("\n");
            return {
                messages: [{ role: "user", content: { type: "text", text } }],
            };
        },
    );
}
