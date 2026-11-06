/**
 * LinearClient — thin GraphQL wrapper for the Linear API.
 *
 * Supports both Personal API key auth and OAuth Bearer token auth.
 * Each workspace gets its own instance so tokens are never mixed.
 */

import { requestUrl } from "obsidian";
import type { LinearIssueStub, LinearProjectStub, LinearTeam } from "../types";

const LINEAR_API = "https://api.linear.app/graphql";

const ISSUE_FIELDS = "id identifier title url priority state { name type } team { id name }";
const PROJECT_FIELDS = "id name url status { name type }";
const INITIATIVE_FIELDS = "id name url status";

interface IssueNode {
	id: string;
	identifier: string;
	title: string;
	url: string;
	priority: number;
	state: { name: string; type: string };
	team: { id: string; name: string };
}

interface ProjectNode {
	id: string;
	name: string;
	url: string;
	status: { name: string; type: string } | null;
}

/** Initiative status is a bare enum ("Planned" | "Active" | "Completed"). */
interface InitiativeNode {
	id: string;
	name: string;
	url: string;
	status: string | null;
}

const INITIATIVE_STATE_TYPES: Record<string, string> = {
	planned: "planned",
	active: "started",
	completed: "completed",
};

/**
 * The Authorization header value: an API key, or `Bearer <token>` for OAuth.
 * `refresh` asks for a new OAuth token after Linear rejected the current one;
 * it resolves to null when there is no way to get one (an API key, or OAuth
 * without a refresh token), so the request isn't retried with the same value.
 */
export type LinearAuthProvider = (refresh: boolean) => Promise<string | null>;

/** Linear reports a bad token as HTTP 401, or as HTTP 400 with an AUTHENTICATION_ERROR code. */
function isAuthError(res: { status: number; text: string }): boolean {
	if (res.status === 401) return true;
	if (res.status !== 400) return false;
	try {
		const json = JSON.parse(res.text) as { errors?: { extensions?: { code?: string } }[] };
		return !!json.errors?.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR");
	} catch {
		return false;
	}
}

export class LinearClient {
	private workspaceId: string;
	private getAuth: LinearAuthProvider;

	constructor(workspaceId: string, getAuth: LinearAuthProvider) {
		this.workspaceId = workspaceId;
		this.getAuth = getAuth;
	}

	// ── Core request ────────────────────────────────────────────────────────

	private async query<T>(gql: string, variables?: Record<string, unknown>): Promise<T> {
		const send = (auth: string) =>
			requestUrl({
				url: LINEAR_API,
				method: "POST",
				throw: false,
				headers: {
					"Content-Type": "application/json",
					Authorization: auth,
				},
				body: JSON.stringify({ query: gql, variables }),
			});
		const auth = await this.getAuth(false);
		if (!auth) throw new Error("This workspace isn't connected to Linear.");
		let res = await send(auth);
		// An OAuth token can expire early or be revoked; refresh once and retry.
		if (isAuthError(res)) {
			const fresh = await this.getAuth(true);
			if (fresh) res = await send(fresh);
		}

		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Linear API HTTP ${res.status}`);
		}

		const json = res.json as { data?: T; errors?: { message: string }[] };

		if (json.errors?.length) {
			throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join(", ")}`);
		}

		if (!json.data) throw new Error("Linear API returned no data");
		return json.data;
	}

	// ── Viewer / workspace ──────────────────────────────────────────────────

	async getViewerName(): Promise<string> {
		const data = await this.query<{ viewer: { name: string } }>(`
			query { viewer { name } }
		`);
		return data.viewer.name;
	}

	async getOrganizationName(): Promise<string> {
		const data = await this.query<{ organization: { name: string } }>(`
			query { organization { name } }
		`);
		return data.organization.name;
	}

	// ── Teams ───────────────────────────────────────────────────────────────

	async getTeams(): Promise<LinearTeam[]> {
		const data = await this.query<{ teams: { nodes: { id: string; name: string; key: string }[] } }>(`
			query {
				teams(first: 50) {
					nodes { id name key }
				}
			}
		`);
		return data.teams.nodes;
	}

	// ── Issues ──────────────────────────────────────────────────────────────

	/**
	 * Fetch issues for one team, filtered by states and assignee.
	 * Returns up to `limit` issues ordered by updatedAt desc.
	 */
	async getIssues(opts: {
		teamId?: string;
		assignedToMe?: boolean;
		includeCompleted?: boolean;
		limit?: number;
		after?: string;
	} = {}): Promise<{ issues: LinearIssueStub[]; nextCursor: string | null }> {
		const limit = opts.limit ?? 50;

		// Build filter object for the GraphQL variable
		const filter: Record<string, unknown> = {};
		if (opts.teamId) filter["team"] = { id: { eq: opts.teamId } };
		if (opts.assignedToMe) filter["assignee"] = { isMe: { eq: true } };
		if (!opts.includeCompleted) {
			filter["state"] = { type: { nin: ["completed", "canceled", "cancelled"] } };
		}

		const data = await this.query<{
			issues: {
				nodes: {
					id: string;
					identifier: string;
					title: string;
					url: string;
					priority: number;
					state: { name: string; type: string };
					team: { id: string; name: string };
				}[];
				pageInfo: { hasNextPage: boolean; endCursor: string };
			};
		}>(
			`
			query GetIssues($filter: IssueFilter, $first: Int, $after: String) {
				issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
					nodes {
						id identifier title url priority
						state { name type }
						team { id name }
					}
					pageInfo { hasNextPage endCursor }
				}
			}
		`,
			{ filter, first: limit, after: opts.after ?? null }
		);

		const issues: LinearIssueStub[] = data.issues.nodes.map((n) => ({
			id: n.id,
			identifier: n.identifier,
			title: n.title,
			url: n.url,
			priority: n.priority,
			stateName: n.state.name,
			stateType: n.state.type,
			teamId: n.team.id,
			teamName: n.team.name,
			workspaceId: this.workspaceId,
		}));

		const nextCursor = data.issues.pageInfo.hasNextPage
			? data.issues.pageInfo.endCursor
			: null;

		return { issues, nextCursor };
	}

	/** Fetch a single issue by its Linear UUID. */
	async getIssue(id: string): Promise<LinearIssueStub | null> {
		try {
			const data = await this.query<{
				issue: {
					id: string;
					identifier: string;
					title: string;
					url: string;
					priority: number;
					state: { name: string; type: string };
					team: { id: string; name: string };
				};
			}>(
				`
				query GetIssue($id: String!) {
					issue(id: $id) {
						id identifier title url priority
						state { name type }
						team { id name }
					}
				}
			`,
				{ id }
			);
			const n = data.issue;
			return {
				id: n.id,
				identifier: n.identifier,
				title: n.title,
				url: n.url,
				priority: n.priority,
				stateName: n.state.name,
				stateType: n.state.type,
				teamId: n.team.id,
				teamName: n.team.name,
				workspaceId: this.workspaceId,
			};
		} catch {
			return null;
		}
	}

	/** Full-text search over issues, matching identifiers as well as titles. */
	async searchIssues(term: string, limit = 25): Promise<LinearIssueStub[]> {
		const data = await this.query<{ searchIssues: { nodes: IssueNode[] } }>(
			`query SearchIssues($term: String!, $first: Int) {
				searchIssues(term: $term, first: $first) { nodes { ${ISSUE_FIELDS} } }
			}`,
			{ term, first: limit }
		);
		return data.searchIssues.nodes.map((n) => this.toIssue(n));
	}

	// ── Projects & initiatives ──────────────────────────────────────────────

	/** Projects, most recently updated first; `query` filters by name. */
	async getProjects(query?: string, limit = 50): Promise<LinearProjectStub[]> {
		const filter = query ? { name: { containsIgnoreCase: query } } : undefined;
		const data = await this.query<{ projects: { nodes: ProjectNode[] } }>(
			`query GetProjects($filter: ProjectFilter, $first: Int) {
				projects(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${PROJECT_FIELDS} } }
			}`,
			{ filter, first: limit }
		);
		return data.projects.nodes.map((n) => this.toProject(n));
	}

	async getProject(id: string): Promise<LinearProjectStub | null> {
		try {
			const data = await this.query<{ project: ProjectNode }>(
				`query GetProject($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`,
				{ id }
			);
			return this.toProject(data.project);
		} catch {
			return null;
		}
	}

	/** Initiatives, most recently updated first; `query` filters by name. */
	async getInitiatives(query?: string, limit = 50): Promise<LinearProjectStub[]> {
		const filter = query ? { name: { containsIgnoreCase: query } } : undefined;
		const data = await this.query<{ initiatives: { nodes: InitiativeNode[] } }>(
			`query GetInitiatives($filter: InitiativeFilter, $first: Int) {
				initiatives(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${INITIATIVE_FIELDS} } }
			}`,
			{ filter, first: limit }
		);
		return data.initiatives.nodes.map((n) => this.toInitiative(n));
	}

	async getInitiative(id: string): Promise<LinearProjectStub | null> {
		try {
			const data = await this.query<{ initiative: InitiativeNode }>(
				`query GetInitiative($id: String!) { initiative(id: $id) { ${INITIATIVE_FIELDS} } }`,
				{ id }
			);
			return this.toInitiative(data.initiative);
		} catch {
			return null;
		}
	}

	private toIssue(n: IssueNode): LinearIssueStub {
		return {
			id: n.id,
			identifier: n.identifier,
			title: n.title,
			url: n.url,
			priority: n.priority,
			stateName: n.state.name,
			stateType: n.state.type,
			teamId: n.team.id,
			teamName: n.team.name,
			workspaceId: this.workspaceId,
		};
	}

	private toProject(n: ProjectNode): LinearProjectStub {
		return {
			kind: "project",
			id: n.id,
			title: n.name,
			url: n.url,
			stateName: n.status?.name ?? "",
			stateType: n.status?.type ?? "",
			workspaceId: this.workspaceId,
		};
	}

	private toInitiative(n: InitiativeNode): LinearProjectStub {
		const status = n.status ?? "";
		return {
			kind: "initiative",
			id: n.id,
			title: n.name,
			url: n.url,
			stateName: status,
			stateType: INITIATIVE_STATE_TYPES[status.toLowerCase()] ?? "",
			workspaceId: this.workspaceId,
		};
	}

	// ── Mutations ───────────────────────────────────────────────────────────

	/**
	 * Update the state of a Linear issue.
	 * `stateId` is the Linear UUID of the target WorkflowState.
	 */
	async updateIssueState(issueId: string, stateId: string): Promise<void> {
		await this.query<unknown>(
			`
			mutation UpdateIssue($id: String!, $stateId: String!) {
				issueUpdate(id: $id, input: { stateId: $stateId }) {
					success
				}
			}
		`,
			{ id: issueId, stateId }
		);
	}

	/**
	 * Create a new issue and return its stub.
	 */
	async createIssue(opts: {
		teamId: string;
		title: string;
		description?: string;
		priority?: number;
	}): Promise<LinearIssueStub> {
		const data = await this.query<{
			issueCreate: {
				issue: {
					id: string;
					identifier: string;
					title: string;
					url: string;
					priority: number;
					state: { name: string; type: string };
					team: { id: string; name: string };
				};
			};
		}>(
			`
			mutation CreateIssue($input: IssueCreateInput!) {
				issueCreate(input: $input) {
					issue {
						id identifier title url priority
						state { name type }
						team { id name }
					}
				}
			}
		`,
			{
				input: {
					teamId: opts.teamId,
					title: opts.title,
					description: opts.description,
					priority: opts.priority,
				},
			}
		);
		const n = data.issueCreate.issue;
		return {
			id: n.id,
			identifier: n.identifier,
			title: n.title,
			url: n.url,
			priority: n.priority,
			stateName: n.state.name,
			stateType: n.state.type,
			teamId: n.team.id,
			teamName: n.team.name,
			workspaceId: this.workspaceId,
		};
	}

	/**
	 * Fetch all workflow states for a team, needed to translate status names → IDs.
	 */
	async getWorkflowStates(teamId: string): Promise<{ id: string; name: string; type: string }[]> {
		const data = await this.query<{
			workflowStates: {
				nodes: { id: string; name: string; type: string }[];
			};
		}>(
			`
			query GetStates($filter: WorkflowStateFilter) {
				workflowStates(filter: $filter, first: 100) {
					nodes { id name type }
				}
			}
		`,
			{ filter: { team: { id: { eq: teamId } } } }
		);
		return data.workflowStates.nodes;
	}
}
