import * as vscode from 'vscode';
import { SitecoreItem } from './tree/models';
import { SerializationConfigService } from './sitecore/serializationConfigService';

export class ExplainPanel {
	public static currentPanel: ExplainPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this.panel = panel;
		this.extensionUri = extensionUri;
	}

	public static createOrShow(extensionUri: vscode.Uri): ExplainPanel {
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

		ExplainPanel.currentPanel = new ExplainPanel(panel, extensionUri);
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
		});

		return ExplainPanel.currentPanel;
	}

	public update(item: SitecoreItem, explainOutput: string): void {
		const parsed = this.parseExplainOutput(item, explainOutput);
		this.panel.title = `Explain: ${item.path}`;
		this.panel.webview.html = this.getHtml(item, parsed);
	}

	private parseExplainOutput(item: SitecoreItem, explainOutput: string) {
		const lines = explainOutput.split(/\r?\n/).filter(line => line.trim().length > 0);
		const moduleName = item.matchedModule || (lines[0]?.match(/^\[([^\]]+)\]/)?.[1] ?? 'Unknown');
		let status = 'Not serialized';
		if (item.status === 'direct') {
			status = 'Serialized (Directly)';
		} else if (item.status === 'indirect') {
			status = 'Serialized (Indirectly)';
		}
		if (lines.some(line => /not included/i.test(line))) {
			status = 'Not serialized';
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
				database: item.subtreeDatabase
			}
			: undefined;

		return {
			moduleName,
			moduleDescription: moduleName === 'Unknown' ? undefined : item.moduleDescription,
			moduleJsonPath: moduleName === 'Unknown' ? undefined : item.moduleJsonPath,
			status,
			reasons: reasonLines,
			yamlPath: yamlPathFromOutput ?? item.yamlPath,
			directIncludeInfo: includeInfo
		};
	}

	private getHtml(item: SitecoreItem, parsed: { moduleName: string; moduleDescription?: string; moduleJsonPath?: string; status: string; reasons: string[]; yamlPath?: string; directIncludeInfo?: { include: string; path?: string; scope?: string; pushOperations?: string; database?: string; moduleJsonPath?: string } }): string {
		const reasonHtml = parsed.reasons.length > 0
			? parsed.reasons.map(line => `<li>${this.escapeHtml(line)}</li>`).join('')
			: '<li>No explain output available.</li>';

		const yamlFileName = parsed.yamlPath ? parsed.yamlPath.replace(/.*[\\/]/, '') : undefined;
		const yamlSection = yamlFileName
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
