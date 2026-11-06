import type { StatusKind } from "../links/statusIcons";

/**
 * The status icon for a Linear state type. Issues use workflow state types
 * (backlog / unstarted / started / completed / canceled); projects add
 * planned and paused; initiatives are mapped onto these by the client.
 */
export function linearStatusKind(stateType: unknown): StatusKind | null {
	switch (typeof stateType === "string" ? stateType.toLowerCase() : "") {
		case "backlog":
		case "triage":
			return "backlog";
		case "unstarted":
		case "planned":
			return "todo";
		case "started":
			return "started";
		case "paused":
			return "paused";
		case "completed":
			return "done";
		case "canceled":
		case "cancelled":
			return "canceled";
		default:
			return null;
	}
}
