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
			if (message.command === 'openIncludeJsonByPath' && message.jsonFilePath && message.includeName) {
				const resolvedPath = await ExplainPanel.currentPanel?.resolveModuleJsonPath(message.jsonFilePath);
				if (!resolvedPath) {
					vscode.window.showErrorMessage(`Unable to resolve module JSON file: ${message.jsonFilePath}`);
					return;
				}
				await ExplainPanel.currentPanel?.openIncludeInModuleJson(resolvedPath, message.includeName, message.rulePath);
			}
			if (message.command === 'editModuleIncludeByPath' && message.jsonFilePath && message.includeName) {
				const resolvedPath = await ExplainPanel.currentPanel?.resolveModuleJsonPath(message.jsonFilePath);
				if (!resolvedPath) {
					vscode.window.showErrorMessage(`Unable to resolve module JSON file: ${message.jsonFilePath}`);
					return;
				}
				await EditModulePanel.createOrShow(resolvedPath, { includeName: message.includeName, rulePath: message.rulePath });
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
		const serializationConfigService = SerializationConfigService.getInstance();
		const lines = explainOutput.split(/\r?\n/).filter(line => line.trim().length > 0);
		const explainModuleName = lines[0]?.match(/^\[([^\]]+)\]/)?.[1]?.trim();
		const moduleName = explainModuleName || item.matchedModule || 'Unknown';
		const moduleConfig = moduleName === 'Unknown'
			? undefined
			: serializationConfigService.getModuleByName(moduleName);
		const moduleJsonPath = moduleName === 'Unknown'
			? undefined
			: (moduleConfig?.jsonPath || serializationConfigService.resolveModuleJsonPath(moduleName));
		let status = 'Not serialized';
		let isSerialized = false;
		if (item.status === 'direct') {
			status = 'Serialized (Directly)';
			isSerialized = true;
		} else if (item.status === 'indirect') {
			status = 'Serialized (Indirectly)';
			isSerialized = true;
		}

		// Let the explain output be authoritative.
		// "is included!" is a definitive positive signal; "not included" is a definitive negative signal.
		// Positive wins when both appear (shouldn't happen, but be safe).
		const explainSaysIncluded = lines.some(line => /\bis included[.!]?/i.test(line));
		const explainSaysNotIncluded = lines.some(line => /not included/i.test(line));

		if (explainSaysIncluded) {
			isSerialized = true;
			if (!status.startsWith('Serialized')) {
				const isDirect = lines.some(line => /item path matches subtree scope/i.test(line));
				status = isDirect ? 'Serialized (Directly)' : 'Serialized (Indirectly)';
			}
		} else if (explainSaysNotIncluded) {
			status = 'Not serialized';
			isSerialized = false;
		}

		const yamlRegex = /([A-Za-z]:[\\/].*?\.(?:yml|yaml))/i;
		const yamlPathFromOutput = this.extractYamlPathFromExplainLines(lines, yamlRegex);

		const reasonLines = lines
			.filter(line =>
				!/Physical path:/i.test(line) &&
				!/^[^\]]*dotnet sitecore ser explain/i.test(line) &&
				!yamlRegex.test(line)
			)
			.map(line => line.replace(/^\[[^\]]+\]\s*/, ''));

		const yamlPath = yamlPathFromOutput ?? item.yamlPath;
		const inferredIncludeName = serializationConfigService.inferIncludeFromYamlPath(yamlPath);
		const includeName = inferredIncludeName || item.subtreeKey;
		const inferredIncludeInfo = moduleName === 'Unknown'
			? undefined
			: serializationConfigService.getIncludeInfo(moduleName, includeName);
		const subtreeMatchesInclude = !!item.subtreeKey && !!includeName
			&& item.subtreeKey.toLowerCase() === includeName.toLowerCase();
		const itemSuggestsSerialization = item.status === 'direct' || item.status === 'indirect';

		const matchedRulePath = this.extractRulePathFromExplainLines(lines);

		const includeInfo = includeName && (isSerialized || itemSuggestsSerialization)
			? {
				include: inferredIncludeInfo?.include || includeName,
				path: inferredIncludeInfo?.path || (subtreeMatchesInclude ? item.subtreePath : undefined),
				scope: inferredIncludeInfo?.scope || (subtreeMatchesInclude ? item.subtreeScope : undefined),
				pushOperations: inferredIncludeInfo?.pushOperations || (subtreeMatchesInclude ? item.subtreePushOperations : undefined),
				database: inferredIncludeInfo?.database || (subtreeMatchesInclude ? item.subtreeDatabase : undefined),
				moduleJsonPath,
				rulePath: matchedRulePath
			}
			: undefined;

		return {
			moduleName,
			moduleDescription: moduleName === 'Unknown' ? undefined : (moduleConfig?.description || item.moduleDescription),
			moduleJsonPath,
			status,
			isSerialized,
			reasons: reasonLines,
			yamlPath,
			directIncludeInfo: includeInfo
		};
	}

	private extractYamlPathFromExplainLines(lines: string[], yamlRegex: RegExp): string | undefined {
		const physicalPathLineIndex = lines.findIndex(line => /Physical path:/i.test(line));
		if (physicalPathLineIndex >= 0) {
			const inlineMatch = lines[physicalPathLineIndex].match(yamlRegex)?.[1];
			if (inlineMatch) {
				return this.sanitizeYamlPath(inlineMatch);
			}

			for (let i = physicalPathLineIndex + 1; i < lines.length; i++) {
				const candidateLine = lines[i].trim();
				if (!candidateLine) {
					continue;
				}

				const candidateMatch = candidateLine.match(yamlRegex)?.[1] || candidateLine;
				const sanitizedCandidate = this.sanitizeYamlPath(candidateMatch);
				if (/^[A-Za-z]:[\\/].*\.(?:yml|yaml)$/i.test(sanitizedCandidate)) {
					return sanitizedCandidate;
				}
			}
		}

		const fallbackMatch = lines
			.map(line => line.match(yamlRegex)?.[1])
			.find(Boolean);

		return fallbackMatch ? this.sanitizeYamlPath(fallbackMatch) : undefined;
	}

	private sanitizeYamlPath(value: string): string {
		return value.trim().replace(/^['"]+|['"]+$/g, '');
	}

	private extractRulePathFromExplainLines(lines: string[]): string | undefined {
		for (const line of lines) {
			const match = line.match(/\bRule\s+(.+?)\s+set allowed push operations/i);
			if (match?.[1]) {
				return match[1].trim();
			}
		}

		return undefined;
	}

	private getHtml(item: SitecoreItem, parsed: { moduleName: string; moduleDescription?: string; moduleJsonPath?: string; status: string; isSerialized: boolean; reasons: string[]; yamlPath?: string; directIncludeInfo?: { include: string; path?: string; scope?: string; pushOperations?: string; database?: string; moduleJsonPath?: string; rulePath?: string } }): string {
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

		const includeActions = parsed.directIncludeInfo
			? `<div class="module-actions"><button type="button" id="open-include-editor" data-json="${this.escapeHtml(parsed.directIncludeInfo.moduleJsonPath || '')}" data-include="${this.escapeHtml(parsed.directIncludeInfo.include)}" data-rule-path="${this.escapeHtml(parsed.directIncludeInfo.rulePath || '')}">Edit</button><button type="button" id="open-include-json" data-json="${this.escapeHtml(parsed.directIncludeInfo.moduleJsonPath || '')}" data-include="${this.escapeHtml(parsed.directIncludeInfo.include)}" data-rule-path="${this.escapeHtml(parsed.directIncludeInfo.rulePath || '')}" ${(parsed.directIncludeInfo.moduleJsonPath || '').trim().length > 0 ? '' : 'disabled'}>JSON</button></div>`
			: '';

		const includeSection = parsed.directIncludeInfo
			? `<section>\n\t<h1>Included by</h1>\n\t<ul>\n\t\t<li>${this.escapeHtml(parsed.directIncludeInfo.include)}</li>\n\t\t${parsed.directIncludeInfo.rulePath ? `<li>Rule: ${this.escapeHtml(parsed.directIncludeInfo.rulePath)}</li>` : ''}\n\t</ul>\n\t${includeActions}\n</section>`
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
.module-actions button:disabled {
	opacity: 0.5;
	cursor: default;
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

	const openIncludeEditorButton = document.getElementById('open-include-editor');
	if (openIncludeEditorButton) {
		openIncludeEditorButton.addEventListener('click', event => {
			event.preventDefault();
			const target = event.currentTarget;
			if (target instanceof HTMLElement) {
				const jsonFilePath = target.getAttribute('data-json');
				const includeName = target.getAttribute('data-include');
				const rulePath = target.getAttribute('data-rule-path');
				if (jsonFilePath && includeName) {
					vscode.postMessage({ command: 'editModuleIncludeByPath', jsonFilePath, includeName, rulePath });
				}
			}
		});
	}

	const openIncludeJsonButton = document.getElementById('open-include-json');
	if (openIncludeJsonButton) {
		openIncludeJsonButton.addEventListener('click', event => {
			event.preventDefault();
			const target = event.currentTarget;
			if (target instanceof HTMLElement) {
				const jsonFilePath = target.getAttribute('data-json');
				const includeName = target.getAttribute('data-include');
				const rulePath = target.getAttribute('data-rule-path');
				if (jsonFilePath && includeName) {
					vscode.postMessage({ command: 'openIncludeJsonByPath', jsonFilePath, includeName, rulePath });
				}
			}
		});
	}

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

		const normalizedYamlPath = this.sanitizeYamlPath(yamlPath);

		const rootFolder = workspaceFolders[0].uri.fsPath;
		const candidatePaths = [normalizedYamlPath, `${rootFolder}/${normalizedYamlPath}`];
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
			const searchTerm = normalizedYamlPath.replace(/\\/g, '/').toLowerCase();
			const results = await vscode.workspace.findFiles('**/*.{yml,yaml}', '**/node_modules/**', 200);
			foundUri = results.find(uri => uri.fsPath.toLowerCase().includes(searchTerm));
			if (!foundUri) {
				const basename = normalizedYamlPath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
				foundUri = results.find(uri => uri.fsPath.toLowerCase().endsWith(basename));
			}
		}

		if (foundUri) {
			const doc = await vscode.workspace.openTextDocument(foundUri);
			await vscode.window.showTextDocument(doc);
			return;
		}

		vscode.window.showErrorMessage(`Unable to open YAML file: ${normalizedYamlPath}`);
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
		if (matched) {
			return matched.fsPath;
		}

		const inputBaseName = path.basename(inputPath).replace(/\.json$/i, '');
		const inputBaseToken = this.normalizeLookupToken(inputBaseName);
		const inputParentToken = this.normalizeLookupToken(path.basename(path.dirname(inputPath)));
		const normalizedInputToken = this.normalizeLookupToken(normalizedInput);

		let bestScore = 0;
		let bestMatch: vscode.Uri | undefined;
		for (const uri of jsonUris) {
			const normalized = uri.fsPath.replace(/\\/g, '/').toLowerCase();
			const fileNameToken = this.normalizeLookupToken(path.basename(normalized).replace(/\.json$/i, ''));
			const parentToken = this.normalizeLookupToken(path.basename(path.dirname(normalized)));
			const fullToken = this.normalizeLookupToken(normalized);

			let score = 0;
			if (inputBaseToken && fileNameToken === inputBaseToken) {
				score += 80;
			}
			if (inputParentToken && parentToken === inputParentToken) {
				score += 45;
			}
			if (inputBaseToken && parentToken === inputBaseToken) {
				score += 30;
			}
			if (inputBaseToken && fullToken.includes(inputBaseToken)) {
				score += 20;
			}
			if (normalizedInputToken && fullToken.includes(normalizedInputToken)) {
				score += 15;
			}
			if (normalized.includes('/serialization/')) {
				score += 5;
			}

			if (score > bestScore) {
				bestScore = score;
				bestMatch = uri;
			}
		}

		if (bestMatch) {
			return bestMatch.fsPath;
		}

		return undefined;
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

			if (!foundUri) {
				const moduleToken = this.normalizeLookupToken(moduleName);
				let bestScore = 0;
				let bestMatch: vscode.Uri | undefined;
				for (const uri of results) {
					const normalized = uri.fsPath.replace(/\\/g, '/').toLowerCase();
					const fileNameToken = this.normalizeLookupToken(path.basename(normalized).replace(/\.json$/i, ''));
					const parentToken = this.normalizeLookupToken(path.basename(path.dirname(normalized)));
					const fullToken = this.normalizeLookupToken(normalized);

					let score = 0;
					if (moduleToken && fileNameToken === moduleToken) {
						score += 85;
					}
					if (moduleToken && parentToken === moduleToken) {
						score += 55;
					}
					if (moduleToken && fullToken.includes(moduleToken)) {
						score += 20;
					}
					if (normalized.includes('/serialization/')) {
						score += 5;
					}

					if (score > bestScore) {
						bestScore = score;
						bestMatch = uri;
					}
				}

				foundUri = bestMatch;
			}
		}

		if (foundUri) {
			const doc = await vscode.workspace.openTextDocument(foundUri);
			await vscode.window.showTextDocument(doc);
			return;
		}

		vscode.window.showErrorMessage(`Unable to open module JSON file: ${moduleName}`);
	}

	private async openIncludeInModuleJson(jsonFilePath: string, includeName: string, rulePath?: string): Promise<void> {
		const targetUri = vscode.Uri.file(jsonFilePath);
		const document = await vscode.workspace.openTextDocument(targetUri);
		const editor = await vscode.window.showTextDocument(document, { preview: false });

		const escapedIncludeName = includeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const escapedRulePath = (rulePath || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const includeNamePattern = new RegExp(`"name"\\s*:\\s*"${escapedIncludeName}"`, 'i');
		const rulePathPattern = escapedRulePath
			? new RegExp(`"path"\\s*:\\s*"${escapedRulePath}"`, 'i')
			: undefined;
		const fallbackPattern = new RegExp(escapedIncludeName, 'i');
		const lines = document.getText().split(/\r?\n/);

		let targetLineIndex = rulePathPattern
			? lines.findIndex(line => rulePathPattern.test(line))
			: -1;
		if (targetLineIndex < 0) {
			targetLineIndex = lines.findIndex(line => includeNamePattern.test(line));
		}
		if (targetLineIndex < 0) {
			targetLineIndex = lines.findIndex(line => fallbackPattern.test(line));
		}

		if (targetLineIndex < 0) {
			return;
		}

		const targetLine = lines[targetLineIndex];
		const matchIndex = rulePathPattern
			? targetLine.search(rulePathPattern)
			: targetLine.search(includeNamePattern);
		const column = matchIndex >= 0 ? matchIndex : 0;
		const position = new vscode.Position(targetLineIndex, column);
		const range = new vscode.Range(position, position);

		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	}

	private escapeHtml(value: string): string {
		return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	private normalizeLookupToken(value: string): string {
		return value.toLowerCase().replace(/[^a-z0-9]/g, '');
	}
}
