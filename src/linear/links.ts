/**
 * Linear links — import issues, projects and initiatives as notes, and render
 * links to them as status pills through the shared link styler.
 */

import { Notice, Plugin, TFile } from "obsidian";
import type { MarkdownTasksSettings } from "../settings";
import type { LinkStyle, StatusLinkStyler } from "../links/linkStyler";
import { safeCssColor } from "../links/statusIcons";
import { linkInserter } from "../links/insertLink";
import { LinearItemSuggestModal } from "./itemSuggestModal";
import type { LinearManager } from "./manager";

interface HostPlugin extends Plugin {
	settings: MarkdownTasksSettings;
	linkStyler: StatusLinkStyler;
}

/** How a link to `file` looks, or null when it isn't a Linear note. */
function styleFor(plugin: HostPlugin, manager: LinearManager, file: TFile): LinkStyle | null {
	if (!manager.kindOf(file)) return null;
	return { icon: manager.statusKindOf(file), color: safeCssColor(plugin.settings.linearLinkColor) };
}

/** Lets the user pick an issue, project or initiative, imports it, and hands back its note. */
function pickAndImport(plugin: HostPlugin, manager: LinearManager, onImported: (file: TFile) => void): void {
	const clients = manager.getConfiguredWorkspaces().flatMap((workspace) => {
		const client = manager.getClient(workspace.id);
		return client ? [{ workspace, client }] : [];
	});
	if (!clients.length) {
		new Notice("Connect a linear workspace in settings first.");
		return;
	}
	new LinearItemSuggestModal(plugin.app, clients, ({ item }) => {
		void manager
			.importItem(item)
			.then((file) => {
				if (file) onImported(file);
			})
			.catch((err: unknown) => {
				new Notice(`Linear import failed: ${err instanceof Error ? err.message : String(err)}`);
			});
	}).open();
}

export function registerLinearLinks(plugin: HostPlugin, manager: LinearManager): void {
	plugin.linkStyler.addSource({
		isEnabled: () => plugin.settings.linearStyleLinks,
		styleFor: (file) => styleFor(plugin, manager, file),
	});

	plugin.addCommand({
		id: "linear-import",
		name: "Linear: import issue, project, or initiative",
		callback: () =>
			pickAndImport(plugin, manager, (file) => {
				void plugin.app.workspace.getLeaf(false).openFile(file);
			}),
	});

	plugin.addCommand({
		id: "linear-insert-link",
		name: "Linear: insert link to issue, project, or initiative",
		editorCallback: (editor, ctx) => {
			pickAndImport(plugin, manager, linkInserter(plugin.app, editor, ctx));
		},
	});

	plugin.addCommand({
		id: "linear-open-in-browser",
		name: "Linear: open active note in browser",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			const url = file ? manager.urlOf(file) : null;
			if (!url) return false;
			if (!checking) window.open(url);
			return true;
		},
	});
}
