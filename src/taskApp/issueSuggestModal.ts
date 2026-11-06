import { App, FuzzyMatch, FuzzySuggestModal, Notice, debounce } from "obsidian";
import { LIST_ISSUES_MAX, type TaskAppClient, type TaskAppIssueSummary } from "./client";
import { statusIconSvg } from "../links/statusIcons";
import { taskAppStatusKind } from "./statusKind";

const OPEN_STATE_TYPES = ["started", "unstarted", "backlog"];

/**
 * Picks one open Task App issue. Issues load after the modal opens. When a
 * status has more open issues than one list returns, typing also searches the
 * server by title, so older issues are still reachable.
 */
export class TaskAppIssueSuggestModal extends FuzzySuggestModal<TaskAppIssueSummary> {
	private issues = new Map<string, TaskAppIssueSummary>();
	private truncated = false;
	private searchedQuery = "";

	constructor(
		app: App,
		private client: TaskAppClient,
		private onChoose: (issue: TaskAppIssueSummary) => void
	) {
		super(app);
		this.setPlaceholder("Loading task app issues…");
	}

	onOpen(): void {
		void super.onOpen();
		this.inputEl.addEventListener("input", () => this.searchServer());
		void this.load();
	}

	private async fetchOpen(query?: string): Promise<TaskAppIssueSummary[][]> {
		return Promise.all(OPEN_STATE_TYPES.map((stateType) => this.client.listIssues({ stateType, query })));
	}

	private merge(lists: TaskAppIssueSummary[][]): void {
		for (const issue of lists.flat()) this.issues.set(issue.identifier, issue);
		// Re-run the query now that there is more to match against.
		this.inputEl.dispatchEvent(new Event("input"));
	}

	private async load(): Promise<void> {
		try {
			const lists = await this.fetchOpen();
			this.truncated = lists.some((list) => list.length >= LIST_ISSUES_MAX);
			this.setPlaceholder(
				this.truncated ? "Search task app issues (older ones load as you type)…" : "Search task app issues…"
			);
			this.merge(lists);
		} catch (err) {
			new Notice(`Task App: ${err instanceof Error ? err.message : String(err)}`);
			this.close();
		}
	}

	private searchServer = debounce(
		() => {
			const query = this.inputEl.value.trim();
			if (!this.truncated || query.length < 2 || query === this.searchedQuery) return;
			this.searchedQuery = query;
			this.fetchOpen(query).then(
				(lists) => this.merge(lists),
				() => {} // The preloaded list still works; a failed search just adds nothing.
			);
		},
		300,
		true
	);

	getItems(): TaskAppIssueSummary[] {
		return [...this.issues.values()];
	}

	getItemText(issue: TaskAppIssueSummary): string {
		return `${issue.identifier} ${issue.title}`;
	}

	renderSuggestion(match: FuzzyMatch<TaskAppIssueSummary>, el: HTMLElement): void {
		const issue = match.item;
		el.addClass("mt-suggestion");
		const icon = el.createSpan({ cls: "mt-status-icon" });
		const svg = statusIconSvg(taskAppStatusKind(issue.status));
		if (svg) icon.appendChild(svg);
		el.createSpan({ cls: "mt-suggestion-id", text: issue.identifier });
		el.createSpan({ cls: "mt-suggestion-title", text: issue.title });
		if (issue.project) el.createSpan({ cls: "mt-suggestion-project", text: issue.project });
	}

	onChooseItem(issue: TaskAppIssueSummary): void {
		this.onChoose(issue);
	}
}
