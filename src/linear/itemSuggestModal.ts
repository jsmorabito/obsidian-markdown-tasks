import { App, FuzzyMatch, FuzzySuggestModal, Notice, debounce } from "obsidian";
import type { LinearClient } from "./client";
import type { LinearItem, LinearWorkspaceConfig } from "../types";
import { statusIconSvg } from "../links/statusIcons";
import { linearStatusKind } from "./statusKind";

export interface LinearPick {
	item: LinearItem;
	workspace: LinearWorkspaceConfig;
}

interface WorkspaceClient {
	workspace: LinearWorkspaceConfig;
	client: LinearClient;
}

/** How many of each kind the picker preloads; a full page means typing should also search Linear. */
const PRELOAD_LIMIT = 50;

const KIND_LABELS = { issue: "Issue", project: "Project", initiative: "Initiative" } as const;

/**
 * Picks one Linear issue, project or initiative from every configured
 * workspace. Recent open issues, projects and initiatives load after the modal
 * opens; typing also searches Linear, so anything older is still reachable.
 */
export class LinearItemSuggestModal extends FuzzySuggestModal<LinearPick> {
	private picks = new Map<string, LinearPick>();
	private searchedQuery = "";
	/** Kinds whose preload filled a page, so typing searches Linear for more of them. */
	private truncated = new Set<LinearItem["kind"]>(["issue", "project", "initiative"]);

	constructor(
		app: App,
		private clients: WorkspaceClient[],
		private onChoose: (pick: LinearPick) => void
	) {
		super(app);
		this.setPlaceholder("Loading linear issues, projects and initiatives…");
	}

	onOpen(): void {
		void super.onOpen();
		this.inputEl.addEventListener("input", () => this.searchServer());
		void this.load();
	}

	/**
	 * The given kinds from every workspace, each request on its own: a workspace
	 * without initiatives (or a failed search) still yields the rest. Failures
	 * are named by kind and workspace.
	 */
	private async fetch(
		kinds: Set<LinearItem["kind"]>,
		query?: string
	): Promise<{ picks: LinearPick[]; failures: string[] }> {
		const requests = this.clients.flatMap(({ workspace, client }) => {
			const tag = (kind: LinearItem["kind"], request: Promise<LinearItem[]>) =>
				request.then(
					(items) => ({ kind, picks: items.map((item) => ({ item, workspace })) }),
					(err: unknown) => {
						const where = this.clients.length > 1 ? ` in ${workspace.name}` : "";
						throw new Error(`${kind}s${where}: ${err instanceof Error ? err.message : String(err)}`);
					}
				);
			const list: Promise<{ kind: LinearItem["kind"]; picks: LinearPick[] }>[] = [];
			if (kinds.has("issue")) {
				const issues = query
					? client.searchIssues(query)
					: client.getIssues({ limit: PRELOAD_LIMIT }).then((r) => r.issues);
				list.push(tag("issue", issues.then((l) => l.map((issue) => ({ kind: "issue" as const, ...issue })))));
			}
			if (kinds.has("project")) list.push(tag("project", client.getProjects(query, PRELOAD_LIMIT)));
			if (kinds.has("initiative")) list.push(tag("initiative", client.getInitiatives(query, PRELOAD_LIMIT)));
			return list;
		});
		const results = await Promise.allSettled(requests);
		const picks: LinearPick[] = [];
		const failures: string[] = [];
		const full = new Set<LinearItem["kind"]>();
		for (const result of results) {
			if (result.status === "fulfilled") {
				picks.push(...result.value.picks);
				if (result.value.picks.length >= PRELOAD_LIMIT) full.add(result.value.kind);
			} else {
				failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
			}
		}
		if (!query) this.truncated = full;
		return { picks, failures };
	}

	private merge(picks: LinearPick[]): void {
		for (const pick of picks) this.picks.set(`${pick.workspace.id}:${pick.item.id}`, pick);
		// Re-run the query now that there is more to match against.
		this.inputEl.dispatchEvent(new Event("input"));
	}

	private async load(): Promise<void> {
		const { picks, failures } = await this.fetch(new Set(["issue", "project", "initiative"]));
		if (failures.length) new Notice(`Linear couldn't load ${failures.join("; ")}`);
		if (!picks.length && failures.length) {
			this.close();
			return;
		}
		this.setPlaceholder("Search linear issues, projects and initiatives…");
		this.merge(picks);
	}

	private searchServer = debounce(
		() => {
			const query = this.inputEl.value.trim();
			// Only kinds the preload cut short need a server search; the rest are all here already.
			if (query.length < 3 || query === this.searchedQuery || !this.truncated.size) return;
			this.searchedQuery = query;
			// The preloaded list still works; a failed search just adds nothing.
			void this.fetch(this.truncated, query).then(({ picks }) => {
				if (this.inputEl.value.trim().startsWith(query)) this.merge(picks);
			});
		},
		500,
		true
	);

	getItems(): LinearPick[] {
		return [...this.picks.values()];
	}

	getItemText({ item }: LinearPick): string {
		return item.kind === "issue" ? `${item.identifier} ${item.title}` : `${item.title} ${item.kind}`;
	}

	renderSuggestion(match: FuzzyMatch<LinearPick>, el: HTMLElement): void {
		const { item, workspace } = match.item;
		el.addClass("mt-suggestion");
		const icon = el.createSpan({ cls: "mt-status-icon" });
		const svg = statusIconSvg(linearStatusKind(item.stateType));
		if (svg) icon.appendChild(svg);
		el.createSpan({
			cls: "mt-suggestion-id",
			text: item.kind === "issue" ? item.identifier : KIND_LABELS[item.kind],
		});
		el.createSpan({ cls: "mt-suggestion-title", text: item.title });
		const context = [item.kind === "issue" ? item.teamName : item.stateName];
		if (this.clients.length > 1) context.push(workspace.name);
		el.createSpan({ cls: "mt-suggestion-project", text: context.filter(Boolean).join(" · ") });
	}

	onChooseItem(pick: LinearPick): void {
		this.onChoose(pick);
	}
}
