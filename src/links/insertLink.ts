import { App, Editor, MarkdownFileInfo, MarkdownView, Notice, TFile } from "obsidian";

/**
 * Returns a callback that links the cursor's note to an imported note,
 * replacing the selection made when the command ran. The import is a network
 * round trip, so the editor may have moved on by the time the link arrives.
 */
export function linkInserter(
	app: App,
	editor: Editor,
	ctx: MarkdownView | MarkdownFileInfo
): (file: TFile) => void {
	const sourcePath = ctx.file?.path ?? "";
	const from = editor.getCursor("from");
	const to = editor.getCursor("to");
	const selected = editor.getRange(from, to);
	return (file) => {
		const link = app.fileManager.generateMarkdownLink(file, sourcePath);
		if (ctx.file?.path !== sourcePath) {
			new Notice(`Imported ${file.basename}; the note changed, so no link was inserted.`);
			return;
		}
		if (editor.getRange(from, to) === selected) editor.replaceRange(link, from, to);
		else editor.replaceSelection(link);
	};
}
