/**
 * Renders links to synced notes (Task App issues, Linear issues, projects and
 * initiatives) as pills with a status icon — the same look as the Note Types
 * plugin's styled links, under this plugin's own class names so the two never
 * fight over one element.
 *
 * Each integration registers a `StyledLinkSource` that says whether a note is
 * one of its own and how a link to it looks. One styler serves them all, so
 * two integrations never undo each other's decoration on the same anchor.
 *
 * Reading view: a markdown post-processor decorates each `a.internal-link`.
 * Live Preview: one Decoration.mark() per wikilink carries the colour and the
 * status icon as custom properties (styles.css draws the icon on ::before); a
 * widget inside the mark would split the pill in two. Folded links that
 * Obsidian renders as a real `<a>` widget get the class through the DOM.
 */

import * as cmLanguage from "@codemirror/language";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { App, MarkdownPostProcessorContext, MarkdownView, Plugin, TFile, debounce, editorInfoField } from "obsidian";
import { StatusKind, statusIconDataUrl, statusIconSvg } from "./statusIcons";

const { syntaxTree } = cmLanguage;

/** How a link to one source's note looks. */
export interface LinkStyle {
	icon: StatusKind | null;
	/** A safe CSS colour, or null for the theme's tag colours. */
	color: string | null;
}

export interface StyledLinkSource {
	/** Whether this source styles links at all (its setting is on). */
	isEnabled(): boolean;
	/** The style for a link to `file`, or null when it isn't this source's note. */
	styleFor(file: TFile): LinkStyle | null;
}

/** A styled wikilink in the editor. */
interface StyledLink {
	from: number;
	to: number;
	style: LinkStyle;
}

/** Forces every editor to rebuild its link decorations (a status or setting changed). */
export const refreshStyledLinksEffect = StateEffect.define<null>();

const WIKILINK = /\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g;

export class StatusLinkStyler {
	private sources: StyledLinkSource[] = [];
	/** Notes that resolved to a style, so a note that stops qualifying still clears its pills. */
	private styledPaths = new Set<string>();

	constructor(private app: App) {}

	addSource(source: StyledLinkSource): void {
		this.sources.push(source);
	}

	/** Hooks the styler into reading view, the editor, and note changes. */
	register(plugin: Plugin): void {
		plugin.registerMarkdownPostProcessor(this.postProcessor);
		plugin.registerEditorExtension(this.editorExtension());

		// A synced note's status changed (by a refresh, a server-side sync, or a
		// hand edit): redraw the icons on links pointing at it, in editors and
		// reading views alike.
		const refreshLinks = debounce(() => this.refreshAll(true), 300, true);
		plugin.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				const styled = !!this.styleOf(file);
				if (styled || this.styledPaths.has(file.path)) refreshLinks();
				if (!styled) this.styledPaths.delete(file.path);
			})
		);
	}

	private get active(): boolean {
		return this.sources.some((source) => source.isEnabled());
	}

	private styleOf(file: TFile): LinkStyle | null {
		for (const source of this.sources) {
			if (!source.isEnabled()) continue;
			const style = source.styleFor(file);
			if (style) return style;
		}
		return null;
	}

	/** The styled note a link points at, if any. */
	private resolve(linktext: string, sourcePath: string): LinkStyle | null {
		const path = linktext.split("#")[0]!.trim();
		if (!path) return null;
		const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		const style = file ? this.styleOf(file) : null;
		if (style) this.styledPaths.add(file!.path);
		return style;
	}

	/**
	 * Adds (or, for a link that no longer qualifies, removes) the pill on a real
	 * `<a>`. Skips the DOM entirely when the anchor already shows the right state,
	 * since folded editor links are revisited on every cursor move.
	 */
	private decorateAnchor(link: HTMLElement, sourcePath: string): void {
		// Nothing to add, and nothing left to remove from a link never styled.
		if (!this.active && link.dataset.mtStatusLink === undefined) return;
		const style = this.resolve(link.getAttribute("data-href") ?? "", sourcePath);
		const key = style ? `${style.icon ?? ""}|${style.color ?? ""}` : "";
		if ((link.dataset.mtStatusLink ?? "") === key) return;
		if (key) link.dataset.mtStatusLink = key;
		else delete link.dataset.mtStatusLink;

		link.querySelector(":scope > .mt-status-icon")?.remove();
		link.classList.toggle("mt-status-link", !!style);
		if (style?.color) link.style.setProperty("--mt-link-color", style.color);
		else link.style.removeProperty("--mt-link-color");

		const svg = statusIconSvg(style?.icon ?? null);
		if (svg) {
			const icon = createSpan({ cls: "mt-status-icon" });
			icon.appendChild(svg);
			link.prepend(icon);
		}
	}

	postProcessor = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		el.querySelectorAll<HTMLElement>("a.internal-link[data-href]").forEach((link) =>
			this.decorateAnchor(link, ctx.sourcePath)
		);
	};

	editorExtension() {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- the view plugin class needs the styler
		const styler = this;
		return ViewPlugin.fromClass(
			class {
				links: StyledLink[];
				decorations: DecorationSet;

				constructor(view: EditorView) {
					this.links = styler.findLinks(view);
					this.decorations = styler.buildDecorations(view, this.links);
					styler.decorateFoldedLinks(view);
				}

				update(update: ViewUpdate): void {
					const forced = update.transactions.some((tr) =>
						tr.effects.some((e) => e.is(refreshStyledLinksEffect))
					);
					// Links are resolved only when the text, viewport or a note changes;
					// a cursor move just re-marks which link is being edited.
					if (forced || update.docChanged || update.viewportChanged) {
						this.links = styler.findLinks(update.view);
					} else if (!update.selectionSet) {
						return;
					}
					this.decorations = styler.buildDecorations(update.view, this.links);
					styler.decorateFoldedLinks(update.view);
				}
			},
			{ decorations: (v) => v.decorations }
		);
	}

	private decorateFoldedLinks(view: EditorView): void {
		const sourcePath = view.state.field(editorInfoField, false)?.file?.path ?? "";
		view.dom.querySelectorAll<HTMLElement>("a.internal-link[data-href]").forEach((link) =>
			this.decorateAnchor(link, sourcePath)
		);
	}

	/**
	 * Styled links in the visible text. Ranges are widened to whole lines so
	 * a link on a range boundary isn't cut in half; embeds and links inside code
	 * are skipped, as Obsidian doesn't render those as links either.
	 */
	findLinks(view: EditorView): StyledLink[] {
		if (!this.active) return [];
		const { doc } = view.state;
		const sourcePath = view.state.field(editorInfoField, false)?.file?.path ?? "";
		const tree = syntaxTree(view.state);
		const links: StyledLink[] = [];
		let scanned = 0;

		for (const range of view.visibleRanges) {
			const from = Math.max(doc.lineAt(range.from).from, scanned);
			const to = doc.lineAt(range.to).to;
			if (from >= to) continue;
			scanned = to;
			for (const m of doc.sliceString(from, to).matchAll(WIKILINK)) {
				const linkFrom = from + m.index;
				if (linkFrom > 0 && doc.sliceString(linkFrom - 1, linkFrom) === "!") continue;
				if (/code/i.test(tree.resolveInner(linkFrom, 1).name)) continue;
				const style = this.resolve(m[1]!, sourcePath);
				if (!style) continue;
				links.push({ from: linkFrom, to: linkFrom + m[0].length, style });
			}
		}
		return links;
	}

	buildDecorations(view: EditorView, links: StyledLink[]): DecorationSet {
		if (!links.length) return Decoration.none;
		const selection = view.state.selection;
		const builder = new RangeSetBuilder<Decoration>();

		for (const link of links) {
			const editing = selection.ranges.some((r) => r.from <= link.to && r.to >= link.from);
			const style: string[] = [];
			if (link.style.color) style.push(`--mt-link-color: ${link.style.color}`);
			// While the raw link is being edited the icon would sit before `[[`, so drop it.
			const iconUrl = editing ? null : statusIconDataUrl(link.style.icon);
			if (iconUrl) style.push(`--mt-status-icon: ${iconUrl}`);

			builder.add(
				link.from,
				link.to,
				Decoration.mark({
					class: editing ? "mt-status-link mt-status-link-editing" : "mt-status-link",
					...(style.length ? { attributes: { style: style.join("; ") } } : {}),
				})
			);
		}
		return builder.finish();
	}

	/** Re-decorate open editors and reading views after a status or setting change. */
	refreshAll(rerenderPreview = false): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			// Obsidian's Editor wraps a CM6 EditorView it doesn't expose in the typings.
			const cm = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
			cm?.dispatch({ effects: refreshStyledLinksEffect.of(null) });
			if (rerenderPreview && leaf.view.getMode() === "preview") leaf.view.previewMode.rerender(true);
		});
	}
}
