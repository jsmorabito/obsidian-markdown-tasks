/**
 * Task App notes — import issues into the vault and keep their properties current.
 *
 * Notes use the same layout as Task App's own Obsidian connector
 * (`TSK-12 Title.md` with `id`, `aliases`, `status`, `priority`, `due`,
 * `target`, `labels`; body = description), so if that server-side sync is
 * enabled for this vault it adopts these notes instead of duplicating them.
 */

import { App, Notice, TFile, Vault, normalizePath, stringifyYaml } from "obsidian";
import type { TaskAppClient, TaskAppIssue } from "./client";
import type { MarkdownTasksSettings } from "../settings";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"];
const REFRESH_CONCURRENCY = 4;

/** A year as a plain number, so it reads `target: 2026` as Task App's sync writes it. */
function targetValue(target: string | null): string | number | undefined {
	if (!target) return undefined;
	return /^\d{4}$/.test(target) ? Number(target) : target;
}

/** Mirrors `cleanFileName` in Task App's connector so both sides pick the same filename. */
function cleanFileName(title: string): string {
	return title
		.replace(/[\\/:*?"<>|#^[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\.+$/, "")
		.slice(0, 100)
		.trim();
}

function fileNameFor(identifier: string, title: string): string {
	const clean = cleanFileName(title);
	return clean ? `${identifier} ${clean}.md` : `${identifier}.md`;
}

export class TaskAppNotes {
	constructor(private app: App, private getSettings: () => MarkdownTasksSettings) {}

	get folder(): string {
		return normalizePath(this.getSettings().taskAppFolder || "Tasks");
	}

	/** The issue identifier of a Task App note, or null for any other file. */
	identifierOf(file: TFile): string | null {
		if (file.extension !== "md" || !file.path.startsWith(`${this.folder}/`)) return null;
		const id: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
		return typeof id === "string" && IDENTIFIER.test(id.trim()) ? id.trim() : null;
	}

	/** The note's Task App status, e.g. "In Progress". */
	statusOf(file: TFile): string | null {
		const status: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.status;
		return typeof status === "string" ? status : null;
	}

	/** Markdown files under the issue folder — the only place Task App notes live. */
	private folderFiles(): TFile[] {
		const folder = this.app.vault.getFolderByPath(this.folder);
		if (!folder) return [];
		const files: TFile[] = [];
		Vault.recurseChildren(folder, (f) => {
			if (f instanceof TFile && f.extension === "md") files.push(f);
		});
		return files;
	}

	findNote(identifier: string): TFile | null {
		return this.folderFiles().find((file) => this.identifierOf(file) === identifier) ?? null;
	}

	/**
	 * Creates the note for an issue, or refreshes it if one exists.
	 * `identifier` is looked up as well as the one Task App returns: an issue
	 * that moved teams has a new identifier while its note still has the old.
	 */
	async importIssue(client: TaskAppClient, identifier: string): Promise<TFile> {
		const issue = await client.getIssue(identifier);
		const path = normalizePath(`${this.folder}/${fileNameFor(issue.identifier, issue.title)}`);
		// A file at the target path that isn't indexed yet (just created, or just
		// written by Task App's own sync) is the same note — adopt it.
		const atPath = this.app.vault.getFileByPath(path);
		const existing = this.findNote(identifier) ?? this.findNote(issue.identifier) ?? atPath;
		if (existing) {
			await this.updateProperties(existing, issue);
			await this.renameForIdentifier(existing, issue);
			return existing;
		}

		if (!this.app.vault.getFolderByPath(this.folder)) {
			await this.app.vault.createFolder(this.folder);
		}
		const file = await this.app.vault.create(path, this.renderNote(issue));
		new Notice(`Imported ${issue.identifier}: ${issue.title}`);
		return file;
	}

	/**
	 * Pulls the current properties of every Task App note, a few requests at a
	 * time. Bodies are left alone. `missing` counts issues Task App no longer has.
	 */
	async refreshAll(client: TaskAppClient): Promise<{ updated: number; missing: number; errors: number }> {
		const queue = this.folderFiles().flatMap((file) => {
			const identifier = this.identifierOf(file);
			return identifier ? [{ file, identifier }] : [];
		});
		const result = { updated: 0, missing: 0, errors: 0 };

		const worker = async () => {
			for (let item = queue.shift(); item; item = queue.shift()) {
				try {
					const issue = await client.getIssue(item.identifier);
					const changed = await this.updateProperties(item.file, issue);
					const renamed = await this.renameForIdentifier(item.file, issue);
					if (changed || renamed) result.updated++;
				} catch (err) {
					if (err instanceof Error && /not found/i.test(err.message)) result.missing++;
					else result.errors++;
				}
			}
		};
		await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, worker));
		return result;
	}

	/**
	 * Renames a note whose filename still carries an old identifier (the issue
	 * moved teams), like Task App's own sync does. Links follow the rename; a
	 * name the user chose without an identifier prefix is left alone.
	 * Returns whether the note was renamed.
	 */
	private async renameForIdentifier(file: TFile, issue: TaskAppIssue): Promise<boolean> {
		const prefix = /^([A-Za-z][A-Za-z0-9]*-\d+)(?: |$)/.exec(file.basename)?.[1];
		if (!prefix || prefix === issue.identifier) return false;
		const path = normalizePath(`${file.parent?.path ?? this.folder}/${fileNameFor(issue.identifier, issue.title)}`);
		if (this.app.vault.getAbstractFileByPath(path)) return false;
		await this.app.fileManager.renameFile(file, path);
		return true;
	}

	private renderNote(issue: TaskAppIssue): string {
		const fm: Record<string, unknown> = {
			id: issue.identifier,
			aliases: [issue.identifier],
			status: issue.state.name,
			priority: PRIORITY_NAMES[issue.priority] ?? "none",
		};
		if (issue.dueDate) fm.due = issue.dueDate;
		const target = targetValue(issue.targetDate);
		if (target !== undefined) fm.target = target;
		const labels = [...new Set(issue.labels.map((l) => l.name))].sort();
		if (labels.length) fm.labels = labels;

		const description = (issue.description ?? "").replace(/\r\n/g, "\n").trim();
		return `---\n${stringifyYaml(fm).trimEnd()}\n---\n${description ? `\n${description}\n` : ""}`;
	}

	/**
	 * Writes only the properties that differ, and doesn't touch the file at all
	 * when none do (an idle rewrite would wake Task App's file watcher).
	 * Returns whether anything changed.
	 */
	private async updateProperties(file: TFile, issue: TaskAppIssue): Promise<boolean> {
		const labels = [...new Set(issue.labels.map((l) => l.name))].sort();
		const current = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const aliases: unknown[] = Array.isArray(current.aliases) ? current.aliases : current.aliases ? [current.aliases] : [];
		const wanted: Record<string, unknown> = {
			id: issue.identifier,
			aliases: aliases.includes(issue.identifier) ? current.aliases : [issue.identifier, ...aliases],
			status: issue.state.name,
			priority: PRIORITY_NAMES[issue.priority] ?? "none",
			due: issue.dueDate ?? undefined,
			target: targetValue(issue.targetDate),
			labels: labels.length ? labels : undefined,
		};
		const stale = Object.keys(wanted).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(wanted[k]));
		if (!stale.length) return false;

		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const key of stale) {
				if (wanted[key] === undefined) delete fm[key];
				else fm[key] = wanted[key];
			}
		});
		return true;
	}
}
