import { Notice, Setting } from "obsidian";
import type MarkdownTasksPlugin from "../main";

export function renderTaskAppSettings(containerEl: HTMLElement, plugin: MarkdownTasksPlugin): void {
	const settings = plugin.settings;
	new Setting(containerEl).setName("Task app integration").setHeading();

	new Setting(containerEl)
		.setName("Server URL")
		.setDesc("Address of the task app API server, such as 127.0.0.1:4100 or your hosted address. Without a scheme, local addresses use plain HTTP and everything else uses HTTPS. The server needs an API token configured.")
		.addText((text) =>
			text
				.setPlaceholder("127.0.0.1:4100")
				.setValue(settings.taskAppUrl)
				.onChange(async (value) => {
					settings.taskAppUrl = value.trim();
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("API token")
		.setDesc("The API token configured on the server.")
		.addText((text) => {
			text.inputEl.type = "password";
			text.setValue(settings.taskAppToken).onChange(async (value) => {
				settings.taskAppToken = value.trim();
				await plugin.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName("Web app URL")
		.setDesc("Where issues open in the browser. Leave empty to use the server URL, which works for a hosted server.")
		.addText((text) =>
			text
				.setPlaceholder("127.0.0.1:3100")
				.setValue(settings.taskAppWebUrl)
				.onChange(async (value) => {
					settings.taskAppWebUrl = value.trim();
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Issue folder")
		.setDesc("Folder for imported issues. If the server syncs with this vault, use the same folder it syncs to.")
		.addText((text) =>
			text
				.setPlaceholder("Tasks")
				.setValue(settings.taskAppFolder)
				.onChange(async (value) => {
					settings.taskAppFolder = value.trim() || "Tasks";
					await plugin.saveSettings();
					plugin.linkStyler.refreshAll(true);
				})
		);

	new Setting(containerEl)
		.setName("Style issue links")
		.setDesc("Show links to imported issues as pills with a status icon.")
		.addToggle((toggle) =>
			toggle.setValue(settings.taskAppStyleLinks).onChange(async (value) => {
				settings.taskAppStyleLinks = value;
				await plugin.saveSettings();
				plugin.linkStyler.refreshAll(true);
			})
		);

	new Setting(containerEl)
		.setName("Link colour")
		.setDesc("Any CSS colour. Leave empty to use the theme's tag colours.")
		.addText((text) =>
			text
				.setValue(settings.taskAppLinkColor)
				.onChange(async (value) => {
					settings.taskAppLinkColor = value.trim();
					await plugin.saveSettings();
					plugin.linkStyler.refreshAll(true);
				})
		);

	new Setting(containerEl).addButton((btn) =>
		btn.setButtonText("Test connection").onClick(async () => {
			const client = plugin.taskApp.client();
			if (!client) return;
			try {
				const teams = await client.listTeams();
				new Notice(`Connected to Task App: ${teams.map((t) => t.key).join(", ") || "no teams"}`);
			} catch (err) {
				new Notice(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		})
	);
}
