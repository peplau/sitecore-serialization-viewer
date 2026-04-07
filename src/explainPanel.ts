import * as vscode from 'vscode';
import * as path from 'path';
import { SitecoreItem } from './tree/models';
import { SerializationConfigService } from './sitecore/serializationConfigService';
import { EditModulePanel } from './editModulePanel';

export class ExplainPanel {
	public static currentPanel: ExplainPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly onViewItems: (jsonFilePath: string) => Promise<void>;

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, onViewItems: (jsonFilePath: string) => Promise<void>) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.onViewItems = onViewItems;
	}

	public static createOrShow(extensionUri: vscode.Uri, onViewItems: (jsonFilePath: string) => Promise<void>): ExplainPanel {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : vscode.ViewColumn.One;

		if (ExplainPanel.currentPanel) {
			ExplainPanel.currentPanel.panel.reveal(column);
			return ExplainPanel.currentPanel;
		}

		const panel = vscode.window.createWebviewPanel(
			'sitecoreSerializationExplain',
			'Sitecore Explain',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
			}
		);

		ExplainPanel.currentPanel = new ExplainPanel(panel, extensionUri, onViewItems);
		ExplainPanel.currentPanel.panel.onDidDispose(() => {
			ExplainPanel.currentPanel = undefined;
		});

		ExplainPanel.currentPanel.panel.webview.onDidReceiveMessage(async message => {
			if (message.command === 'openYaml' && message.yamlPath) {
				await ExplainPanel.currentPanel?.openYamlFile(message.yamlPath);
			}
			if (message.command === 'openModuleJson' && message.moduleName) {
				await ExplainPanel.currentPanel?.openModuleJsonFile(message.moduleName);
			}
			if (message.command === 'editModuleByPath' && message.jsonFilePath) {
				const resolvedPath = await ExplainPanel.currentPanel?.resolveModuleJsonPath(message.jsonFilePath);
				if (!resolvedPath) {
					vscode.window.showErrorMessage(`Unable to resolve module JSON file: ${message.jsonFilePath}`);
					return;
				}
				await EditModulePanel.createOrShow(resolvedPath);
			}
			if (message.command === 'viewItemsByPath' && message.jsonFilePath) {
				const resolvedPath = await ExplainPanel.currentPanel?.resolveModuleJsonPath(message.jsonFilePath);
				if (!resolvedPath) {
					vscode.window.showErrorMessage(`Unable to resolve module JSON file: ${message.jsonFilePath}`);
					return;
				}
				await ExplainPanel.currentPanel?.onViewItems(resolvedPath);
			}
		});

		return ExplainPanel.currentPanel;
	}

	public update(item: SitecoreItem, explainOutput: string): void {
		const parsed = this.parseExplainOutput(item, explainOutput);
		this.panel.title = `Explain: ${item.path}`;
		this.panel.webview.html = this.getHtml(item, parsed);
	}

	public showLoading(itemPath: string): void {
		this.panel.title = `Explain: ${itemPath}`;
		this.panel.webview.html = this.getLoadingHtml(itemPath);
	}

	private getLoadingHtml(itemPath: string): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body {
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', sans-serif;
	margin: 16px;
	color: var(--vscode-editor-foreground);
}
.loading-wrap {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 12px;
	border: 1px solid var(--vscode-editorWidget-border, #454545);
	border-radius: 8px;
	background: var(--vscode-editor-background);
}
.spinner {
	width: 16px;
	height: 16px;
	border: 2px solid var(--vscode-editorWidget-border, #454545);
	border-top-color: var(--vscode-textLink-foreground, #3794ff);
	border-radius: 50%;
	animation: spin 0.9s linear infinite;
}
@keyframes spin {
	from { transform: rotate(0deg); }
	to { transform: rotate(360deg); }
}
h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
p { margin: 0 0 0.8rem; }
</style>
</head>
<body>
<h1>Path</h1>
<p>${this.escapeHtml(itemPath)}</p>
<div class="loading-wrap">
	<div class="spinner" aria-hidden="true"></div>
	<div>Loading explain data...</div>
</div>
</body>
</html>`;
	}

	private parseExplainOutput(item: SitecoreItem, explainOutput: string) {
		const lines = explainOutput.split(/\r?\n/).filter(line => line.trim().length > 0);
		const moduleName = item.matchedModule || (lines[0]?.match(/^\[([^\]]+)\]/)?.[1] ?? 'Unknown');
		const moduleJsonPath = moduleName === 'Unknown'
			? undefined
			: (item.moduleJsonPath || SerializationConfigService.getInstance().resolveModuleJsonPath(moduleName));
		let status = 'Not serialized';
		let isSerialized = false;
		if (item.status === 'direct') {
			status = 'Serialized (Directly)';
			isSerialized = true;
		} else if (item.status === 'indirect') {
			status = 'Serialized (Indirectly)';
			isSerialized = true;
		}
		if (lines.some(line => /not included/i.test(line))) {
			status = 'Not serialized';
			isSerialized = false;
		}

		const yamlRegex = /([A-Za-z]:[\\/][^\s"']+\.(?:yml|yaml))/i;
		const yamlPathFromOutput = lines
			.map(line => line.match(yamlRegex)?.[1])
			.find(Boolean);

		const reasonLines = lines
			.filter(line =>
				!/Physical path:/i.test(line) &&
				!/^[^\]]*dotnet sitecore ser explain/i.test(line) &&
				!yamlRegex.test(line)
			)
			.map(line => line.replace(/^\[[^\]]+\]\s*/, ''));

		const includeInfo = item.status === 'direct' && item.subtreeKey
			? {
				include: item.subtreeKey,
				path: item.subtreePath,
				scope: item.subtreeScope,
				pushOperations: item.subtreePushOperations,
				database: item.subtreeDatabase,
				moduleJsonPath
			}
			: undefined;

		return {
			moduleName,
			moduleDescription: moduleName === 'Unknown' ? undefined : item.moduleDescription,
			moduleJsonPath,
			status,
			isSerialized,
			reasons: reasonLines,
			yamlPath: yamlPathFromOutput ?? item.yamlPath,
			directIncludeInfo: includeInfo
		};
	}

	private getHtml(item: SitecoreItem, parsed: { moduleName: string; moduleDescription?: string; moduleJsonPath?: string; status: string; isSerialized: boolean; reasons: string[]; yamlPath?: string; directIncludeInfo?: { include: string; path?: string; scope?: string; pushOperations?: string; database?: string; moduleJsonPath?: string } }): string {
		const reasonHtml = parsed.reasons.length > 0
			? parsed.reasons.map(line => `<li>${this.escapeHtml(line)}</li>`).join('')
			: '<li>No explain output available.</li>';

		const moduleSection = parsed.moduleName !== 'Unknown'
			? `<section>\n\t<h1>Module</h1>\n\t<p><a href="#" id="open-module-json" data-module="${this.escapeHtml(parsed.moduleName)}">${this.escapeHtml(parsed.moduleName)}</a>${parsed.moduleDescription ? ` - ${this.escapeHtml(parsed.moduleDescription)}` : ''}</p>\n\t${parsed.moduleJsonPath ? `<div class="module-actions"><button type="button" id="edit-module" data-json="${this.escapeHtml(parsed.moduleJsonPath)}">Edit</button><button type="button" id="view-module-items" data-json="${this.escapeHtml(parsed.moduleJsonPath)}">View Items</button></div>` : ''}\n</section>`
			: '';


		const yamlFileName = parsed.yamlPath ? parsed.yamlPath.replace(/.*[\/]/, '') : undefined;
		const yamlSection = parsed.isSerialized && yamlFileName
			? `<section>\n\t<h1>YAML</h1>\n\t<p><a href=\"#\" id=\"open-yaml\" data-path=\"${this.escapeHtml(parsed.yamlPath!)}\">${this.escapeHtml(yamlFileName)}</a></p>\n</section>`
			: '';

		const includeSection = parsed.directIncludeInfo
			? `<section>\n\t<h1>Included by</h1>\n\t<ul>\n\t\t<li><a href=\"#\" class=\"open-include\" data-include=\"${this.escapeHtml(parsed.directIncludeInfo.include)}\" data-json=\"${this.escapeHtml(parsed.directIncludeInfo.moduleJsonPath || '')}\">${this.escapeHtml(parsed.directIncludeInfo.include)}</a></li>\n\t\t${parsed.directIncludeInfo.path ? `<li>Path: ${this.escapeHtml(parsed.directIncludeInfo.path)}</li>` : ''}\n\t\t${parsed.directIncludeInfo.scope ? `<li>Scope: ${this.escapeHtml(parsed.directIncludeInfo.scope)}</li>` : ''}\n\t\t${parsed.directIncludeInfo.pushOperations ? `<li>Allowed Push Operations: ${this.escapeHtml(parsed.directIncludeInfo.pushOperations)}</li>` : ''}\n\t\t${parsed.directIncludeInfo.database ? `<li>Database: ${this.escapeHtml(parsed.directIncludeInfo.database)}</li>` : ''}\n\t</ul>\n</section>`
			: '';

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', sans-serif; margin: 16px; }
h1 { font-size: 1.1rem; margin-bottom: 0.5rem; }
section { margin-bottom: 1rem; }
pre { white-space: pre-wrap; word-break: break-word; background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 6px; }
li { margin-bottom: 0.4rem; }
a { color: #3794ff; text-decoration: none; }
a:hover { text-decoration: underline; }
.module-actions { display: flex; gap: 8px; margin-top: 8px; }
.module-actions button {
	padding: 6px 12px;
	border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 65%, #d4b25f 35%);
	border-radius: 999px;
	background: color-mix(in srgb, var(--vscode-sideBar-background) 78%, black 22%);
	color: var(--vscode-button-foreground);
	font: inherit;
	font-size: 12px;
	font-weight: 700;
	letter-spacing: 0.04em;
	cursor: pointer;
}
.module-actions button#view-module-items {
	background: color-mix(in srgb, var(--vscode-sideBar-background) 86%, white 14%);
}
.module-actions button:hover {
	opacity: 0.9;
}
</style>
</head>
<body>
<section>
	<h1>Path</h1>
	<p>${this.escapeHtml(item.path)}</p>
</section>
<section>
	<h1>Status</h1>
	<p>${this.escapeHtml(parsed.status)}</p>
</section>
${moduleSection}
<section>
	<h1>Reason</h1>
	<ul>${reasonHtml}</ul>
</section>
${includeSection}
${yamlSection}
<script>
	const vscode = acquireVsCodeApi();
	const openYamlButton = document.getElementById('open-yaml');
	if (openYamlButton) {
		openYamlButton.addEventListener('click', event => {
			event.preventDefault();
			const target = event.currentTarget;
			if (target instanceof HTMLElement) {
				const yamlPath = target.getAttribute('data-path');
				if (yamlPath) {
					vscode.postMessage({ command: 'openYaml', yamlPath });
				}
			}
		});
	}

	const openModuleJsonButton = document.getElementById('open-module-json');
	if (openModuleJsonButton) {
		openModuleJsonButton.addEventListener('click', event => {
			event.preventDefault();
			const target = event.currentTarget;
			if (target instanceof HTMLElement) {
				const moduleName = target.getAttribute('data-module');
				if (moduleName) {
					vscode.postMessage({ command: 'openModuleJson', moduleName });
				}
			}
		});
	}

	const editModuleButton = document.getElementById('edit-module');
	if (editModuleButton) {
		editModuleButton.addEventListener('click', event => {
			event.preventDefault();
			const target = event.currentTarget;
			if (target instanceof HTMLElement) {
				const jsonFilePath = target.getAttribute('data-json');
				if (jsonFilePath) {
					vscode.postMessage({ command: 'editModuleByPath', jsonFilePath });
				}
			}
		});
	}

	const viewItemsButton = document.getElementById('view-module-items');
	if (viewItemsButton) {
		viewItemsButton.addEventListener('click', event => {
			event.preventDefault();
			const target = event.currentTarget;
			if (target instanceof HTMLElement) {
				const jsonFilePath = target.getAttribute('data-json');
				if (jsonFilePath) {
					vscode.postMessage({ command: 'viewItemsByPath', jsonFilePath });
				}
			}
		});
	}

	document.querySelectorAll('.open-include').forEach(el => {
		el.addEventListener('click', event => {
			event.preventDefault();
			const target = event.currentTarget;
			if (target instanceof HTMLElement) {
				const includeName = target.getAttribute('data-include');
				const jsonPath = target.getAttribute('data-json');
				if (includeName && jsonPath) {
					vscode.postMessage({ command: 'openIncludeInJson', includeName, jsonPath });
				}
			}
		});
	});
</script>
</body>
</html>`;
	}

	private async openYamlFile(yamlPath: string): Promise<void> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage('No workspace is open to resolve YAML file.');
			return;
		}

		const rootFolder = workspaceFolders[0].uri.fsPath;
		const candidatePaths = [yamlPath, `${rootFolder}/${yamlPath}`];
		let foundUri: vscode.Uri | undefined;

		for (const candidate of candidatePaths) {
			try {
				const uri = vscode.Uri.file(candidate);
				await vscode.workspace.openTextDocument(uri);
				foundUri = uri;
				break;
			} catch {
				foundUri = undefined;
			}
		}

		if (!foundUri) {
			const searchTerm = yamlPath.replace(/\\/g, '/').toLowerCase();
			const results = await vscode.workspace.findFiles('**/*.{yml,yaml}', '**/node_modules/**', 200);
			foundUri = results.find(uri => uri.fsPath.toLowerCase().includes(searchTerm));
			if (!foundUri) {
				const basename = yamlPath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
				foundUri = results.find(uri => uri.fsPath.toLowerCase().endsWith(basename));
			}
		}

		if (foundUri) {
			const doc = await vscode.workspace.openTextDocument(foundUri);
			await vscode.window.showTextDocument(doc);
			return;
		}

		vscode.window.showErrorMessage(`Unable to open YAML file: ${yamlPath}`);
	}

	private async resolveModuleJsonPath(inputPath: string): Promise<string | undefined> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return undefined;
		}

		const rootFolder = workspaceFolders[0].uri.fsPath;
		const candidates = path.isAbsolute(inputPath)
			? [inputPath]
			: [inputPath, path.join(rootFolder, inputPath)];

		for (const candidate of candidates) {
			try {
				const uri = vscode.Uri.file(candidate);
				await vscode.workspace.openTextDocument(uri);
				return uri.fsPath;
			} catch {
				// Continue trying candidates.
			}
		}

		const normalizedInput = inputPath.replace(/\\/g, '/').toLowerCase();
		const jsonUris = await vscode.workspace.findFiles('**/*.json', '**/node_modules/**', 500);
		const matched = jsonUris.find(uri => {
			const normalized = uri.fsPath.replace(/\\/g, '/').toLowerCase();
			return normalized.endsWith(normalizedInput);
		});

		return matched?.fsPath;
	}

	private async openModuleJsonFile(moduleName: string): Promise<void> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage('No workspace is open to resolve module JSON file.');
			return;
		}

		const modulePath = SerializationConfigService.getInstance().resolveModuleJsonPath(moduleName);
		const rootFolder = workspaceFolders[0].uri.fsPath;
		const candidatePaths = [modulePath, `${rootFolder}/${modulePath}`];
		let foundUri: vscode.Uri | undefined;

		for (const candidate of candidatePaths) {
			try {
				const uri = vscode.Uri.file(candidate);
				await vscode.workspace.openTextDocument(uri);
				foundUri = uri;
				break;
			} catch {
				foundUri = undefined;
			}
		}

		if (!foundUri) {
			const normalizedModuleName = moduleName.toLowerCase();
			const results = await vscode.workspace.findFiles('**/*.json', '**/node_modules/**', 200);
			foundUri = results.find(uri => uri.fsPath.toLowerCase().includes(normalizedModuleName));
		}

		if (foundUri) {
			const doc = await vscode.workspace.openTextDocument(foundUri);
			await vscode.window.showTextDocument(doc);
			return;
		}

		vscode.window.showErrorMessage(`Unable to open module JSON file: ${moduleName}`);
	}

	private escapeHtml(value: string): string {
		return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
}
