import * as vscode from 'vscode';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { ContentTreeProvider } from './tree/contentTreeProvider';
import { SitecoreItem } from './tree/models';
import { SitecoreTreeItem } from './tree/treeItem';
import { ExplainPanel } from './explainPanel';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "sitecore-serialization-viewer" is now active!');

	// Create and register the tree data provider
	const treeProvider = new ContentTreeProvider();
	vscode.window.registerTreeDataProvider('sitecoreContentTree', treeProvider);

	// Register commands
	const refreshTreeCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.refreshTree', () => {
		treeProvider.refresh();
	});

	const openYamlCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.openYaml', (item: SitecoreTreeItem) => {
		if (item && item.item.yamlPath) {
			vscode.workspace.openTextDocument(item.item.yamlPath).then(doc => {
				vscode.window.showTextDocument(doc);
			});
		} else {
			vscode.window.showInformationMessage('No YAML file available for this item.');
		}
	});

	const copyPathCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.copyPath', (item: SitecoreTreeItem) => {
		if (item) {
			vscode.env.clipboard.writeText(item.item.path);
			vscode.window.showInformationMessage(`Copied: ${item.item.path}`);
		}
	});

	const showDetailsCommand = vscode.commands.registerCommand('sitecore-serialization-viewer.showDetails', (item: SitecoreItem) => {
		// TODO: Open details panel/webview
		vscode.window.showInformationMessage(`Details for: ${item.path}\nStatus: ${item.status}\nModule: ${item.matchedModule || 'None'}`);
	});

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('sitecore-serialization-viewer.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Sitecore Serialization Viewer!');
	});

	context.subscriptions.push(
		disposable,
		refreshTreeCommand,
		explainItemCommand,
		openYamlCommand,
		copyPathCommand,
		showDetailsCommand
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
