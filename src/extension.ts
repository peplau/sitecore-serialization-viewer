import * as vscode from 'vscode';
import * as path from 'path';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { ContentTreeProvider } from './tree/contentTreeProvider';
import { SitecoreItem } from './tree/models';
import { SitecoreTreeItem } from './tree/treeItem';
import { ExplainPanel } from './explainPanel';
import { ModulesPanel } from './modulesPanel';
import { ModuleItemsPanel } from './moduleItemsPanel';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "sitecore-serialization-viewer" is now active!');

	// Create and register the tree data provider
	const treeProvider = new ContentTreeProvider();
	const treeView = vscode.window.createTreeView('sitecoreContentTree', {
		treeDataProvider: treeProvider,
		showCollapseAll: true
	});

	const revealPathInTree = async (pathValue: string) => {
		const rawValue = (pathValue || '').trim();
		if (!rawValue) {
			return;
		}

		const normalizedGuid = normalizeGuid(rawValue);
		const matchedItem = normalizedGuid
			? await treeProvider.getItemById(normalizedGuid)
			: await getItemByPathInput(rawValue);

		if (!matchedItem) {
			vscode.window.showWarningMessage(`Item not found for search value: ${rawValue}`);
			return;
		}

		const normalizedPath = matchedItem.path.length > 1 ? matchedItem.path.replace(/\/+$/, '') : matchedItem.path;
		if (!normalizedPath.toLowerCase().startsWith('/sitecore')) {
			vscode.window.showWarningMessage(`Item not found for search value: ${rawValue}`);
			return;
		}

		const segments = normalizedPath.split('/').filter(Boolean);
		if (segments.length === 0 || segments[0].toLowerCase() !== 'sitecore') {
			vscode.window.showWarningMessage(`Item not found for search value: ${rawValue}`);
			return;
		}

		await vscode.commands.executeCommand('sitecore-serialization-viewer.showDetails', matchedItem);

		const roots = await treeProvider.getChildren();
		const root = roots[0];
		if (!root) {
			vscode.window.showWarningMessage('Unable to load Sitecore root node.');
			return;
		}

		if (segments.length === 1) {
			await treeView.reveal(root, { expand: true, focus: true, select: true });
			return;
		}

		let current = root;
		let currentPath = '/sitecore';

		for (let i = 1; i < segments.length; i++) {
			// Expand first so users can see each level opening and loading naturally.
			await treeView.reveal(current, { expand: true, focus: false, select: false });

			const children = await treeProvider.getChildren(current);
			currentPath = `${currentPath}/${segments[i]}`;
			const next = children.find(child => child.item.path.toLowerCase() === currentPath.toLowerCase());
			if (!next) {
				vscode.window.showWarningMessage(`Item not found in tree for path: ${normalizedPath}`);
				return;
			}

			current = next;
		}

		await treeView.reveal(current, { expand: false, focus: true, select: true });
	};

	const getItemByPathInput = async (inputValue: string) => {
		if (!inputValue.startsWith('/')) {
			vscode.window.showWarningMessage('Search must be a /sitecore path or a Sitecore item GUID.');
			return undefined;
		}

		const normalizedPath = inputValue.length > 1 ? inputValue.replace(/\/+$/, '') : inputValue;
		if (!normalizedPath.toLowerCase().startsWith('/sitecore')) {
			vscode.window.showWarningMessage('Path searches must start with /sitecore.');
			return undefined;
		}

		return treeProvider.getItemByPath(normalizedPath);
	};

	const normalizeGuid = (value: string): string | undefined => {
		const trimmed = value.trim();
		const stripped = trimmed.replace(/[{}]/g, '');
		if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(stripped)) {
			return undefined;
		}

		return `{${stripped.toUpperCase()}}`;
	};

	const searchPathCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.searchPath', async () => {
		const value = await vscode.window.showInputBox({
			prompt: 'Type the item path or ID',
			placeHolder: '/sitecore/content/home or {FBFE3DAE-E317-4DCE-97D2-94C806896642}',
			ignoreFocusOut: true
		});

		if (!value) {
			return;
		}

		await revealPathInTree(value);
	});

	context.subscriptions.push(treeView);

	const expandVisibleBranch = async (node: SitecoreTreeItem): Promise<void> => {
		if (!node.item.hasChildren) {
			return;
		}

		// Expand first so the tree shows its built-in loading state while children are fetched.
		await treeView.reveal(node, { expand: true, focus: false, select: false });
		const children = await treeProvider.getChildren(node);

		for (const child of children) {
			await expandVisibleBranch(child);
		}
	};

	const expandVisibleModuleTree = async (): Promise<void> => {
		const roots = await treeProvider.getChildren();
		for (const root of roots) {
			await expandVisibleBranch(root);
		}
	};

	const databaseStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
	const updateDatabaseStatus = () => {
		databaseStatus.text = `Sitecore DB: ${treeProvider.getSelectedDatabase()} $(chevron-down)`;
		databaseStatus.name = 'Sitecore Database Selector';
		databaseStatus.tooltip = 'Select Sitecore database for content tree (master/core)';
	};
	updateDatabaseStatus();
	databaseStatus.command = 'sitecore-serialization-viewer.selectDatabase';
	databaseStatus.show();

	const moduleStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
	const updateModuleStatus = () => {
		moduleStatus.text = `Module: ${treeProvider.getSelectedModule()} $(chevron-down)`;
		moduleStatus.name = 'Sitecore Module Selector';
		moduleStatus.tooltip = 'Select module filter for content tree';
	};
	updateModuleStatus();
	moduleStatus.command = 'sitecore-serialization-viewer.selectModule';
	moduleStatus.show();

	// Register commands
	const refreshTreeCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.refreshTree', async () => {
		await vscode.commands.executeCommand('workbench.actions.treeView.sitecoreContentTree.collapseAll');
		treeProvider.refresh({ resetState: true });
	});

	const selectDatabaseCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.selectDatabase', async () => {
		const current = treeProvider.getSelectedDatabase();
		const selection = await vscode.window.showQuickPick(
			[
				{ label: 'master', description: current === 'master' ? 'Current' : '' },
				{ label: 'core', description: current === 'core' ? 'Current' : '' }
			],
			{
				title: 'Select Sitecore Database',
				placeHolder: 'Choose the Sitecore database for tree loading'
			}
		);

		if (!selection || selection.label === current) {
			return;
		}

		treeProvider.setSelectedDatabase(selection.label);
		updateDatabaseStatus();
		await vscode.commands.executeCommand('workbench.actions.treeView.sitecoreContentTree.collapseAll');
		treeProvider.refresh({ resetState: true });
	});

	const selectModuleCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.selectModule', async () => {
		const current = treeProvider.getSelectedModule();
		const moduleOptions = ['All modules', ...(await treeProvider.getAvailableModules())];
		const selection = await vscode.window.showQuickPick(
			moduleOptions.map(label => ({ label, description: label === current ? 'Current' : '' })),
			{
				title: 'Select Module',
				placeHolder: 'Choose module filter for content tree'
			}
		);

		if (!selection || selection.label === current) {
			return;
		}

		treeProvider.setSelectedModule(selection.label);
		updateModuleStatus();
		treeProvider.refresh();

		if (selection.label === 'All modules') {
			await vscode.commands.executeCommand('workbench.actions.treeView.sitecoreContentTree.collapseAll');
			return;
		}

		await expandVisibleModuleTree();
	});

	const copyPathCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.copyPath', (item: SitecoreTreeItem) => {
		if (item) {
			vscode.env.clipboard.writeText(item.item.path);
			vscode.window.showInformationMessage(`Copied: ${item.item.path}`);
		}
	});

	const exec = promisify(execCallback);

	const showDetailsCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.showDetails', async (item: SitecoreItem) => {
		const panel = ExplainPanel.createOrShow(context.extensionUri, async (jsonFilePath: string) => {
			const itemsPanel = ModuleItemsPanel.createOrShowLoading(jsonFilePath);
			const moduleItems = await treeProvider.getModuleItemsListingByJsonPath(jsonFilePath);
			if (!moduleItems) {
				const message = `Unable to build module items list for: ${jsonFilePath}`;
				itemsPanel.showError(message);
				vscode.window.showErrorMessage(message);
				return;
			}

			itemsPanel.update(moduleItems);
		});
		panel.showLoading(item.path);
		const explainResult = await runSitecoreExplain(item.path);
		panel.update(item, explainResult);
	});

	const showAllModulesCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.showAllModules', async () => {
		const panel = ModulesPanel.createOrShow(async (jsonFilePath: string) => {
			const itemsPanel = ModuleItemsPanel.createOrShowLoading(jsonFilePath);
			const moduleItems = await treeProvider.getModuleItemsListingByJsonPath(jsonFilePath);
			if (!moduleItems) {
				const message = `Unable to build module items list for: ${jsonFilePath}`;
				itemsPanel.showError(message);
				vscode.window.showErrorMessage(message);
				return;
			}

			itemsPanel.update(moduleItems);
		});
		const modules = await treeProvider.getModuleListingItems();
		panel.update(modules);
	});

	vscode.window.registerWebviewPanelSerializer('sitecoreSerializationExplain', {
		deserializeWebviewPanel: async (panel, state) => {
			// No-op for now
		}
	});

	(vscode.window as any).onDidReceiveMessage?.(async (message: any) => {
		if (message.command === 'openIncludeInJson' && message.includeName && message.jsonPath) {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				vscode.window.showErrorMessage('No workspace is open to resolve JSON file.');
				return;
			}
			const rootFolder = workspaceFolders[0].uri.fsPath;
			const candidatePaths = [message.jsonPath, path.join(rootFolder, message.jsonPath)];
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
				const results = await vscode.workspace.findFiles('**/*.json', '**/node_modules/**', 200);
				foundUri = results.find(uri => uri.fsPath.toLowerCase().includes(message.jsonPath.toLowerCase()));
			}
			if (foundUri) {
				const doc = await vscode.workspace.openTextDocument(foundUri);
				const editor = await vscode.window.showTextDocument(doc);
				const text = doc.getText();
				const lines = text.split(/\r?\n/);
				const idx = lines.findIndex(line => line.includes(message.includeName));
				if (idx >= 0) {
					const pos = new vscode.Position(idx, 0);
					editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
					editor.selection = new vscode.Selection(pos, pos);
				}
				return;
			}
			vscode.window.showErrorMessage(`Unable to open JSON file or find include: ${message.includeName}`);
		}
	});

	async function runSitecoreExplain(path: string): Promise<string> {
		if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
			return 'No workspace open to run dotnet sitecore explain.';
		}

		const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const command = `dotnet sitecore ser explain -p "${path}"`;
		try {
			const { stdout, stderr } = await exec(command, { cwd: workspaceRoot, timeout: 30000 });
			return stdout.trim() || stderr.trim();
		} catch (error: any) {
			return `Error running explain command: ${error.message || String(error)}`;
		}
	}

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('sitecore-serialization-viewer.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Sitecore Serialization Viewer!');
	});

	context.subscriptions.push(
		databaseStatus,
		moduleStatus,
		disposable,
		refreshTreeCommand,
		searchPathCommand,
		selectDatabaseCommand,
		selectModuleCommand,
		copyPathCommand,
		showDetailsCommand,
		showAllModulesCommand
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
