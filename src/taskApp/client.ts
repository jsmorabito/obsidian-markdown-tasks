/**
 * TaskAppClient — talks to a Task App server through its HTTP MCP endpoint.
 *
 * Task App's machine credential (`API_TOKEN`) opens `/mcp`, not `/trpc`, so the
 * plugin calls the same MCP tools Claude does. The endpoint is stateless, so
 * each request is a single JSON-RPC `tools/call` with no initialize handshake.
 */

import { requestUrl } from "obsidian";

/** One issue as `list_issues` summarizes it. */
export interface TaskAppIssueSummary {
	identifier: string;
	title: string;
	status: string;
	priority: number;
	dueDate: string | null;
	targetDate: string | null;
	labels: string[];
	project: string | null;
}

/** The fields of `get_issue` the plugin uses. */
export interface TaskAppIssue {
	identifier: string;
	title: string;
	description: string | null;
	priority: number;
	dueDate: string | null;
	targetDate: string | null;
	state: { name: string; type: string };
	labels: { name: string }[];
}

/**
 * Adds a scheme to a bare host, without a trailing slash: `http://` only for
 * this machine (`127.0.0.1:4100`), `https://` for anything else so the bearer
 * token never crosses the network in the clear. An explicit scheme wins.
 */
export function normalizeBaseUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, "");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
	const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[^/:]+\.localhost)(?::\d+)?(?:\/|$)/i.test(trimmed);
	return `${local ? "http" : "https"}://${trimmed}`;
}

/** The server's `list_issues` maximum. */
export const LIST_ISSUES_MAX = 500;

interface JsonRpcResponse {
	result?: { content?: { type: string; text?: string }[]; isError?: boolean };
	error?: { message: string };
}

export class TaskAppClient {
	private nextId = 1;

	constructor(private baseUrl: string, private token: string) {}

	private async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
		const res = await requestUrl({
			url: `${normalizeBaseUrl(this.baseUrl)}/mcp`,
			method: "POST",
			throw: false,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: this.nextId++,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});

		if (res.status === 401) throw new Error("Task App rejected the API token");
		if (res.status === 404) throw new Error("Task App has no /mcp endpoint (is API_TOKEN set on the server?)");
		if (res.status < 200 || res.status >= 300) throw new Error(`Task App HTTP ${res.status}`);

		const rpc = parseRpc(res.text);
		if (rpc.error) throw new Error(`Task App error: ${rpc.error.message}`);
		const text = rpc.result?.content?.find((c) => c.type === "text")?.text ?? "";
		if (rpc.result?.isError) throw new Error(`Task App error: ${text}`);
		return JSON.parse(text) as T;
	}

	listIssues(opts: { query?: string; stateType?: string; limit?: number } = {}): Promise<TaskAppIssueSummary[]> {
		return this.callTool("list_issues", { limit: LIST_ISSUES_MAX, ...opts });
	}

	getIssue(ref: string): Promise<TaskAppIssue> {
		return this.callTool("get_issue", { ref });
	}

	listTeams(): Promise<{ key: string; name: string }[]> {
		return this.callTool("list_teams");
	}
}

/** The server answers with JSON, or with an SSE stream if it ignores `enableJsonResponse`. */
function parseRpc(text: string): JsonRpcResponse {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcResponse;
	const data = trimmed
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.pop();
	if (!data) throw new Error("Task App returned an empty response");
	return JSON.parse(data) as JsonRpcResponse;
}
