/**
 * LinearManager — coordinates all Linear ↔ Obsidian activity.
 *
 * Responsibilities:
 *  - Hold one LinearClient per configured workspace
 *  - Import Linear issues as Obsidian notes
 *  - Push status changes from Obsidian → Linear
 *  - Pull status updates from Linear → Obsidian (manual + scheduled)
 *  - Surface errors without crashing the plugin
 */

import { App, Notice, TFile, normalizePath, stringifyYaml } from "obsidian";
import { LinearClient } from "./client";
import { LinearOAuthTokens, LinearTokenRejectedError, refreshLinearTokens } from "./oauth";
import type { LinearIssueStub, LinearItem, LinearItemKind, LinearWorkspaceConfig } from "../types";
import type { MarkdownTasksSettings } from "../settings";
import type { StatusKind } from "../links/statusIcons";
import { linearStatusKind } from "./statusKind";

/** Frontmatter keys written to imported notes. Issue-only keys are left off projects and initiatives. */
export const LINEAR_FM = {
	kind: "linear-type",
	workspaceId: "linear-workspace-id",
	issueId: "linear-id",
	identifier: "linear-identifier",
	url: "linear-url",
	stateName: "linear-state",
	stateType: "linear-state-type",
	priority: "linear-priority",
	teamId: "linear-team-id",
	teamName: "linear-team",
	lastSynced: "linear-synced-at",
} as const;

export class LinearManager {
	private app: App;
	private getSettings: () => MarkdownTasksSettings;
	private saveSettings: () => Promise<void>;
	private clients: Map<string, LinearClient> = new Map();
	/** In-flight OAuth refreshes per workspace: Linear rotates refresh tokens, so only one may run. */
	private refreshing = new Map<LinearWorkspaceConfig, Promise<string>>();

	constructor(
		app: App,
		getSettings: () => MarkdownTasksSettings,
		saveSettings: () => Promise<void>
	) {
		this.app = app;
		this.getSettings = getSettings;
		this.saveSettings = saveSettings;
	}

	// ── Client management ───────────────────────────────────────────────────

	/** Rebuild client map from current settings. Call after settings change. */
	refreshClients(): void {
		this.clients.clear();
		for (const ws of this.getSettings().linearWorkspaces) {
			if (this.tokenFor(ws)) this.clients.set(ws.id, new LinearClient(ws.id, (refresh) => this.authFor(ws, refresh)));
		}
	}

	/** Refresh an OAuth token this close to expiry instead of waiting for a 401. */
	private static readonly REFRESH_MARGIN_MS = 5 * 60_000;

	/** The Authorization header for a workspace, refreshing an expiring OAuth token first. */
	private async authFor(ws: LinearWorkspaceConfig, forceRefresh: boolean): Promise<string | null> {
		if (ws.authType === "apiKey") {
			if (forceRefresh) return null; // an API key can't be refreshed
			if (!ws.apiKey) throw new Error("No API key set for this workspace.");
			return ws.apiKey;
		}
		if (!ws.oauthToken) throw new Error("This workspace isn't connected to Linear.");
		const canRefresh = !!(ws.oauthRefreshToken && ws.oauthClientId);
		if (forceRefresh && !canRefresh) return null;
		const expiring = ws.oauthExpiresAt !== undefined && ws.oauthExpiresAt - Date.now() < LinearManager.REFRESH_MARGIN_MS;
		if ((forceRefresh || expiring) && canRefresh) {
			return `Bearer ${await this.refreshOAuth(ws)}`;
		}
		return `Bearer ${ws.oauthToken}`;
	}

	private refreshOAuth(ws: LinearWorkspaceConfig): Promise<string> {
		let pending = this.refreshing.get(ws);
		if (!pending) {
			pending = (async () => {
				try {
					const tokens = await refreshLinearTokens(ws.oauthClientId!, ws.oauthRefreshToken!);
					this.applyTokens(ws, ws.oauthClientId!, tokens);
					await this.saveSettings();
					return tokens.accessToken;
				} catch (err) {
					// Only a refusal from Linear means the sign-in is gone; a network error may pass.
					if (err instanceof LinearTokenRejectedError) {
						new Notice(`Linear sign-in for "${ws.name}" expired. Connect it again in settings.`);
					}
					throw err;
				} finally {
					this.refreshing.delete(ws);
				}
			})();
			this.refreshing.set(ws, pending);
		}
		return pending;
	}

	private applyTokens(ws: LinearWorkspaceConfig, clientId: string, tokens: LinearOAuthTokens): void {
		ws.authType = "oauth";
		ws.oauthToken = tokens.accessToken;
		ws.oauthRefreshToken = tokens.refreshToken ?? ws.oauthRefreshToken;
		ws.oauthExpiresAt = tokens.expiresAt;
		ws.oauthClientId = clientId;
	}

	private tokenFor(ws: LinearWorkspaceConfig): string | null {
		if (ws.authType === "apiKey" && ws.apiKey) return ws.apiKey;
		if (ws.authType === "oauth" && ws.oauthToken) return `Bearer ${ws.oauthToken}`;
		return null;
	}

	getClient(workspaceId: string): LinearClient | null {
		return this.clients.get(workspaceId) ?? null;
	}

	getConfiguredWorkspaces(): LinearWorkspaceConfig[] {
		return this.getSettings().linearWorkspaces.filter((ws) => !!this.tokenFor(ws));
	}

	// ── Import ──────────────────────────────────────────────────────────────

	/**
	 * Import a Linear issue as an Obsidian note.
	 * Returns the created/updated TFile, or null on failure.
	 */
	async importIssue(issue: LinearIssueStub): Promise<TFile | null> {
		return this.importItem({ kind: "issue", ...issue });
	}

	/** Import an issue, project or initiative as a note, or refresh its existing note. */
	async importItem(item: LinearItem): Promise<TFile | null> {
		const settings = this.getSettings();
		const folder = normalizePath(settings.linearIssueFolder || "Linear");

		// Ensure folder exists
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}

		// Check if a note for this item already exists (by linear-id frontmatter)
		const existing = this.findNoteForIssue(item.id);
		if (existing) {
			await this.updateNoteFrontmatter(existing, item);
			new Notice(`Updated "${existing.basename}" from Linear.`);
			return existing;
		}

		const file = await this.app.vault.create(this.newNotePath(folder, item), this.buildNoteBody(item));
		new Notice(`Imported ${item.kind === "issue" ? item.identifier : item.kind}: ${item.title}`);
		return file;
	}

	/**
	 * `ENG-42 Title.md` for an issue, `Name.md` for a project or initiative.
	 * A name already taken by another note gets the kind, then a number, appended.
	 */
	private newNotePath(folder: string, item: LinearItem): string {
		const safeName = item.title.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim().slice(0, 80) || item.id;
		const base = item.kind === "issue" ? `${item.identifier} ${safeName}` : safeName;
		const free = (name: string) => {
			const path = normalizePath(`${folder}/${name}.md`);
			return this.app.vault.getAbstractFileByPath(path) ? null : path;
		};
		const first = free(base) ?? (item.kind === "issue" ? null : free(`${base} (${item.kind})`));
		if (first) return first;
		for (let n = 2; ; n++) {
			const path = free(`${base} (${item.kind} ${n})`);
			if (path) return path;
		}
	}

	/** Find the vault note that has linear-id === id (an issue, project or initiative). */
	findNoteForIssue(id: string): TFile | null {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm?.[LINEAR_FM.issueId] === id) return file;
		}
		return null;
	}

	/** Build the initial markdown content for a newly imported note. */
	private buildNoteBody(item: LinearItem): string {
		const fm: Record<string, unknown> = {
			[LINEAR_FM.kind]: item.kind,
			[LINEAR_FM.workspaceId]: item.workspaceId,
			[LINEAR_FM.issueId]: item.id,
		};
		if (item.kind === "issue") fm[LINEAR_FM.identifier] = item.identifier;
		fm[LINEAR_FM.url] = item.url;
		fm[LINEAR_FM.stateName] = item.stateName;
		fm[LINEAR_FM.stateType] = item.stateType;
		if (item.kind === "issue") {
			fm[LINEAR_FM.priority] = item.priority;
			fm[LINEAR_FM.teamId] = item.teamId;
			fm[LINEAR_FM.teamName] = item.teamName;
		}
		fm[LINEAR_FM.lastSynced] = new Date().toISOString();

		const heading = item.kind === "issue" ? `${item.identifier}: ${item.title}` : item.title;
		const details = [`**Status:** ${item.stateName || "None"}`];
		if (item.kind === "issue") {
			const priorityLabel = ["No priority", "Urgent", "High", "Medium", "Low"][item.priority] ?? "Unknown";
			details.push(`**Priority:** ${priorityLabel}`, `**Team:** ${item.teamName}`);
		}
		return `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n# ${heading}\n\n[Open in Linear](${item.url})\n\n${details.join("  \n")}\n`;
	}

	/** Update only the Linear-managed frontmatter keys on an existing note. */
	private async updateNoteFrontmatter(file: TFile, item: LinearItem): Promise<void> {
		const now = new Date().toISOString();
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm[LINEAR_FM.kind] = item.kind;
			fm[LINEAR_FM.stateName] = item.stateName;
			fm[LINEAR_FM.stateType] = item.stateType;
			if (item.kind === "issue") fm[LINEAR_FM.priority] = item.priority;
			fm[LINEAR_FM.lastSynced] = now;
		});
	}

	/** Fetch the current state of one item, or null when it can't be read. */
	private async fetchItem(client: LinearClient, kind: LinearItemKind, id: string): Promise<LinearItem | null> {
		if (kind === "project") return client.getProject(id);
		if (kind === "initiative") return client.getInitiative(id);
		const issue = await client.getIssue(id);
		return issue ? { kind: "issue", ...issue } : null;
	}

	// ── Sync: pull ──────────────────────────────────────────────────────────

	/**
	 * Pull latest status for every linked note in the vault.
	 * Safe to call on open or on interval — skips notes with no linear-id.
	 */
	async pullAll(): Promise<{ updated: number; errors: number }> {
		const linkedFiles = this.app.vault
			.getMarkdownFiles()
			.filter((f) => !!this.app.metadataCache.getFileCache(f)?.frontmatter?.[LINEAR_FM.issueId]);

		let updated = 0;
		let errors = 0;

		// Group by workspace to minimize API calls
		const byWorkspace = new Map<string, { file: TFile; id: string; kind: LinearItemKind }[]>();
		for (const file of linkedFiles) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const kind = this.kindOf(file);
			if (!fm || !kind) continue;
			const wsId = fm[LINEAR_FM.workspaceId] as string | undefined;
			const id = fm[LINEAR_FM.issueId] as string | undefined;
			if (!wsId || !id) continue;
			if (!byWorkspace.has(wsId)) byWorkspace.set(wsId, []);
			byWorkspace.get(wsId)!.push({ file, id, kind });
		}

		for (const [wsId, items] of byWorkspace) {
			const client = this.clients.get(wsId);
			if (!client) continue;

			for (const { file, id, kind } of items) {
				try {
					const item = await this.fetchItem(client, kind, id);
					if (!item) continue;
					const currentFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
					if (
						currentFm?.[LINEAR_FM.stateName] !== item.stateName ||
						currentFm?.[LINEAR_FM.stateType] !== item.stateType
					) {
						await this.updateNoteFrontmatter(file, item);
						updated++;
					}
				} catch {
					errors++;
				}
			}
		}

		return { updated, errors };
	}

	// ── Sync: push ──────────────────────────────────────────────────────────

	/**
	 * Push a status change from Obsidian → Linear.
	 *
	 * `targetStateName` is a human-readable state name (e.g. "In Progress").
	 * We look up the matching WorkflowState ID on the fly.
	 */
	async pushStatusChange(file: TFile, targetStateName: string): Promise<boolean> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return false;

		const wsId = fm[LINEAR_FM.workspaceId] as string | undefined;
		const issueId = fm[LINEAR_FM.issueId] as string | undefined;
		const teamId = fm[LINEAR_FM.teamId] as string | undefined;
		if (!wsId || !issueId || !teamId) return false;

		const client = this.clients.get(wsId);
		if (!client) return false;

		try {
			const states = await client.getWorkflowStates(teamId);
			const target = states.find(
				(s) => s.name.toLowerCase() === targetStateName.toLowerCase()
			);
			if (!target) {
				new Notice(`Linear: no state named "${targetStateName}" found in this team.`);
				return false;
			}
			await client.updateIssueState(issueId, target.id);
			// Reflect the update locally
			const now = new Date().toISOString();
			await this.app.fileManager.processFrontMatter(file, (fmw: Record<string, unknown>) => {
				fmw[LINEAR_FM.stateName] = target.name;
				fmw[LINEAR_FM.stateType] = target.type;
				fmw[LINEAR_FM.lastSynced] = now;
			});
			return true;
		} catch (err) {
			new Notice(`Linear push failed: ${String(err)}`);
			return false;
		}
	}

	// ── OAuth ───────────────────────────────────────────────────────────────

	/**
	 * Store the tokens from a finished browser sign-in and rebuild clients.
	 * Returns the Linear organization's name.
	 */
	async storeOAuthTokens(workspaceId: string, clientId: string, tokens: LinearOAuthTokens): Promise<string> {
		const ws = this.getSettings().linearWorkspaces.find((w) => w.id === workspaceId);
		if (!ws) throw new Error(`Workspace "${workspaceId}" not found`);
		this.applyTokens(ws, clientId, tokens);
		this.refreshClients();
		// Save first: Linear rotates refresh tokens, so losing these would force a new sign-in.
		await this.saveSettings();
		try {
			const orgName = await this.getClient(ws.id)!.getOrganizationName();
			// A workspace still carrying a placeholder name takes the organization's.
			if (!ws.name || ws.name === "New Workspace" || ws.name === "Workspace") {
				ws.name = orgName;
				await this.saveSettings();
			}
			return orgName;
		} catch {
			// Connected all the same; the name is only cosmetic.
			return ws.name;
		}
	}

	// ── Convenience ─────────────────────────────────────────────────────────

	/** What a linked note holds. Notes imported before `linear-type` existed are issues. */
	kindOf(file: TFile): LinearItemKind | null {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm?.[LINEAR_FM.issueId]) return null;
		const kind: unknown = fm[LINEAR_FM.kind];
		return kind === "project" || kind === "initiative" ? kind : "issue";
	}

	/** The note's Linear URL, if it has one. */
	urlOf(file: TFile): string | null {
		const url: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[LINEAR_FM.url];
		return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
	}

	/** The status icon for a linked note, from its Linear state type. */
	statusKindOf(file: TFile): StatusKind | null {
		return linearStatusKind(this.app.metadataCache.getFileCache(file)?.frontmatter?.[LINEAR_FM.stateType]);
	}

	/** Returns the LinearIssueStub reconstructed from a note's frontmatter. */
	getIssueMeta(file: TFile): Partial<LinearIssueStub> | null {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm?.[LINEAR_FM.issueId]) return null;
		return {
			id: fm[LINEAR_FM.issueId] as string,
			identifier: fm[LINEAR_FM.identifier] as string,
			title: file.basename,
			url: fm[LINEAR_FM.url] as string,
			stateName: fm[LINEAR_FM.stateName] as string,
			stateType: fm[LINEAR_FM.stateType] as string,
			priority: fm[LINEAR_FM.priority] as number,
			teamId: fm[LINEAR_FM.teamId] as string,
			teamName: fm[LINEAR_FM.teamName] as string,
			workspaceId: fm[LINEAR_FM.workspaceId] as string,
		};
	}
}
