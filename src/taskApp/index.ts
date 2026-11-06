/**
 * Task App integration — import Task App issues as notes and render links to
 * them as status pills. Wired into the plugin by `TaskAppIntegration.register()`.
 */

import { Notice, Plugin, TFile } from "obsidian";
import type { MarkdownTasksSettings } from "../settings";
import type { LinkStyle, StatusLinkStyler } from "../links/linkStyler";
import { safeCssColor } from "../links/statusIcons";
import { linkInserter } from "../links/insertLink";
import { TaskAppClient, normalizeBaseUrl } from "./client";
import { TaskAppIssueSuggestModal } from "./issueSuggestModal";
import { TaskAppNotes } from "./notes";
import { taskAppStatusKind } from "./statusKind";

interface HostPlugin extends Plugin {
	settings: MarkdownTasksSettings;
	linkStyler: StatusLinkStyler;
}

export class TaskAppIntegration {
	readonly notes: TaskAppNotes;

	constructor(private plugin: HostPlugin) {
		this.notes = new TaskAppNotes(plugin.app, () => plugin.settings);
	}

	/** How a link to `file` looks, or null when it isn't a Task App note. */
	private styleFor(file: TFile): LinkStyle | null {
		if (!this.notes.identifierOf(file)) return null;
		return {
			icon: taskAppStatusKind(this.notes.statusOf(file) ?? ""),
			color: safeCssColor(this.plugin.settings.taskAppLinkColor),
		};
	}

	/** A client for the configured server, or null (with a notice) when it isn't set up. */
	client(): TaskAppClient | null {
		const { taskAppUrl, taskAppToken } = this.plugin.settings;
		if (!taskAppUrl.trim() || !taskAppToken.trim()) {
			new Notice("Set the task app server URL and API token in settings.");
			return null;
		}
		return new TaskAppClient(taskAppUrl.trim(), taskAppToken.trim());
	}

	/** Where an issue opens in the browser. */
	issueUrl(identifier: string): string {
		const { taskAppWebUrl, taskAppUrl } = this.plugin.settings;
		const base = normalizeBaseUrl(taskAppWebUrl.trim() || taskAppUrl);
		return `${base}/issue/${encodeURIComponent(identifier)}`;
	}

	/** Lets the user pick an issue, imports it, and hands back its note. */
	private pickAndImport(onImported: (file: TFile) => void): void {
		const client = this.client();
		if (!client) return;
		new TaskAppIssueSuggestModal(this.plugin.app, client, (issue) => {
			void this.notes
				.importIssue(client, issue.identifier)
				.then(onImported)
				.catch((err: unknown) => {
					new Notice(`Task App import failed: ${err instanceof Error ? err.message : String(err)}`);
				});
		}).open();
	}

	register(): void {
		const { plugin } = this;

		plugin.linkStyler.addSource({
			isEnabled: () => plugin.settings.taskAppStyleLinks,
			styleFor: (file) => this.styleFor(file),
		});

		plugin.addCommand({
			id: "task-app-import-issue",
			name: "Task app: import issue",
			callback: () =>
				this.pickAndImport((file) => {
					void plugin.app.workspace.getLeaf(false).openFile(file);
				}),
		});

		plugin.addCommand({
			id: "task-app-insert-link",
			name: "Task app: insert link to issue",
			editorCallback: (editor, ctx) => {
				this.pickAndImport(linkInserter(plugin.app, editor, ctx));
			},
		});

		plugin.addCommand({
			id: "task-app-refresh",
			name: "Task app: refresh imported issues",
			callback: async () => {
				const client = this.client();
				if (!client) return;
				const { updated, missing, errors } = await this.notes.refreshAll(client);
				const parts = [`${updated} note${updated === 1 ? "" : "s"} updated`];
				if (missing) parts.push(`${missing} no longer in Task App`);
				if (errors) parts.push(`${errors} failed`);
				new Notice(`Task App: ${parts.join(", ")}.`);
			},
		});

		plugin.addCommand({
			id: "task-app-open-in-browser",
			name: "Task app: open issue in browser",
			checkCallback: (checking) => {
				const file = plugin.app.workspace.getActiveFile();
				const identifier = file ? this.notes.identifierOf(file) : null;
				if (!identifier || !(this.plugin.settings.taskAppWebUrl || this.plugin.settings.taskAppUrl)) {
					return false;
				}
				if (!checking) window.open(this.issueUrl(identifier));
				return true;
			},
		});
	}
}
