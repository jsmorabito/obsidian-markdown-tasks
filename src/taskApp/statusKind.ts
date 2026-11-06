import type { StatusKind } from "../links/statusIcons";

/**
 * Task App's default workflow is Backlog / Todo / In Progress / Done / Canceled,
 * but teams can rename or add states, so match loosely on the name.
 */
export function taskAppStatusKind(status: string): StatusKind | null {
	const s = status.trim().toLowerCase();
	if (s === "backlog" || s === "triage") return "backlog";
	if (s === "todo" || s === "to do" || s === "unstarted") return "todo";
	if (s === "done" || s === "completed" || s === "complete") return "done";
	if (s === "canceled" || s === "cancelled" || s === "duplicate") return "canceled";
	if (s === "in progress" || s === "started" || s.startsWith("in ")) return "started";
	return null;
}
