import * as vscode from 'vscode';
import { ModuleListingItem } from './tree/contentTreeProvider';
import { EditModulePanel } from './editModulePanel';

interface ModulesPanelData {
  modules: ModuleListingItem[];
}

export class ModulesPanel {
  public static currentPanel: ModulesPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly onViewItems: (jsonFilePath: string) => Promise<void>;

  private constructor(panel: vscode.WebviewPanel, onViewItems: (jsonFilePath: string) => Promise<void>) {
    this.panel = panel;
    this.onViewItems = onViewItems;
    this.panel.webview.onDidReceiveMessage(async message => {
      if (message.command === 'openModuleJsonPath' && typeof message.jsonFilePath === 'string') {
        await this.openModuleJsonFile(message.jsonFilePath);
      }
      if (message.command === 'editModule' && typeof message.jsonFilePath === 'string') {
        await EditModulePanel.createOrShow(message.jsonFilePath);
      }
      if (message.command === 'viewItems' && typeof message.jsonFilePath === 'string') {
        await this.onViewItems(message.jsonFilePath);
      }
    });
  }

  public static createOrShow(onViewItems: (jsonFilePath: string) => Promise<void>): ModulesPanel {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : vscode.ViewColumn.One;

    if (ModulesPanel.currentPanel) {
      ModulesPanel.currentPanel.panel.reveal(column);
      return ModulesPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'sitecoreSerializationModules',
      'Modules Listing',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true
      }
    );

    ModulesPanel.currentPanel = new ModulesPanel(panel, onViewItems);
    ModulesPanel.currentPanel.panel.onDidDispose(() => {
      ModulesPanel.currentPanel = undefined;
    });

    return ModulesPanel.currentPanel;
  }

  public update(modules: ModuleListingItem[]): void {
    this.panel.title = 'Modules Listing';
    this.panel.webview.html = this.getHtml({ modules });
  }

  private getHtml(data: ModulesPanelData): string {
    const modulesHtml = data.modules.length > 0
      ? `<section class="grid">${data.modules.map(module => this.renderModule(module)).join('')}</section>`
      : '<section class="empty"><p>No active modules were found from the Sitecore configuration files.</p></section>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  color-scheme: light dark;
  --panel-bg: color-mix(in srgb, var(--vscode-editor-background) 92%, #d4b25f 8%);
  --card-bg: color-mix(in srgb, var(--vscode-sideBar-background) 85%, #7b3f00 15%);
  --card-border: color-mix(in srgb, var(--vscode-editorWidget-border) 65%, #d4b25f 35%);
  --accent: #d4b25f;
  --muted: var(--vscode-descriptionForeground);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  font-family: Georgia, 'Segoe UI', serif;
  background:
    radial-gradient(circle at top right, rgba(212, 178, 95, 0.18), transparent 34%),
    linear-gradient(180deg, var(--panel-bg), var(--vscode-editor-background));
  color: var(--vscode-editor-foreground);
}
h1 {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.intro {
  max-width: 960px;
  margin-bottom: 20px;
}
.intro p {
  margin: 0;
  color: var(--muted);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
.card {
  padding: 18px;
  border: 1px solid var(--card-border);
  border-radius: 16px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--card-bg) 95%, white 5%), color-mix(in srgb, var(--card-bg) 88%, black 12%));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
}
.card h2 {
  margin: 0 0 12px;
  font-size: 18px;
  line-height: 1.3;
}
.card-header {
  margin-bottom: 12px;
}
.card-header h2 {
  margin: 0;
}
.card-footer {
  display: flex;
  justify-content: flex-start;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--card-border) 65%, transparent);
}
.card-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.edit-button {
  padding: 6px 12px;
  border: 1px solid var(--card-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--card-bg) 78%, black 22%);
  color: var(--vscode-button-foreground);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.view-items-button {
  padding: 6px 12px;
  border: 1px solid var(--card-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--card-bg) 86%, white 14%);
  color: var(--vscode-button-foreground);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.entry {
  padding: 8px 0;
  border-top: 1px solid color-mix(in srgb, var(--card-border) 65%, transparent);
}
.entry:first-of-type {
  border-top: none;
  padding-top: 0;
}
.entry-key {
  display: block;
  margin-bottom: 2px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent);
}
.entry-value {
  margin: 0;
  word-break: break-word;
}
.description {
  margin: 0 0 14px;
  color: var(--muted);
  line-height: 1.5;
}
.entry-link {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  word-break: break-word;
}
.entry-link:hover {
  text-decoration: underline;
}
.empty {
  padding: 18px;
  border-radius: 16px;
  border: 1px dashed var(--card-border);
}
</style>
</head>
<body>
  <section class="intro">
    <h1>Modules Listing</h1>
    <p>Built from the active <strong>sitecore.json</strong> module globs and the resolved <strong>*.module.json</strong> files.</p>
  </section>
  ${modulesHtml}
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.open-json-path').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const jsonFilePath = target.getAttribute('data-json-path');
        if (jsonFilePath) {
          vscode.postMessage({ command: 'openModuleJsonPath', jsonFilePath });
        }
      });
    });
    document.querySelectorAll('.edit-button').forEach(btn => {
      btn.addEventListener('click', event => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) { return; }
        const jsonFilePath = target.getAttribute('data-json-path');
        if (jsonFilePath) { vscode.postMessage({ command: 'editModule', jsonFilePath }); }
      });
    });
    document.querySelectorAll('.view-items-button').forEach(btn => {
      btn.addEventListener('click', event => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) { return; }
        const jsonFilePath = target.getAttribute('data-json-path');
        if (jsonFilePath) { vscode.postMessage({ command: 'viewItems', jsonFilePath }); }
      });
    });
  </script>
</body>
</html>`;
  }

  private renderModule(module: ModuleListingItem): string {
    const descriptionHtml = module.description
      ? `<p class="description">${this.escapeHtml(module.description)}</p>`
      : '';

    const entriesHtml = [
      {
        key: 'Module JSON File Path',
        value: `<a href="#" class="entry-link open-json-path" data-json-path="${this.escapeHtml(module.jsonFilePath)}">${this.escapeHtml(module.jsonFilePath)}</a>`
      }
    ].map(entry => `
      <div class="entry">
        <span class="entry-key">${this.escapeHtml(entry.key)}</span>
        ${entry.value}
      </div>
    `).join('');

    return `
      <article class="card">
        <div class="card-header">
          <h2>${this.escapeHtml(module.namespace)}</h2>
        </div>
        ${descriptionHtml}
        ${entriesHtml}
        <div class="card-footer">
          <div class="card-actions">
            <button type="button" class="edit-button" data-json-path="${this.escapeHtml(module.jsonFilePath)}">Edit</button>
            <button type="button" class="view-items-button" data-json-path="${this.escapeHtml(module.jsonFilePath)}">View Items</button>
          </div>
        </div>
      </article>
    `;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private async openModuleJsonFile(jsonFilePath: string): Promise<void> {
    try {
      const targetUri = vscode.Uri.file(jsonFilePath);
      const existingTabGroup = vscode.window.tabGroups.all.find(group =>
        group.tabs.some(tab => {
          const input = tab.input;
          return input instanceof vscode.TabInputText && input.uri.fsPath.toLowerCase() === targetUri.fsPath.toLowerCase();
        })
      );

      const document = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: existingTabGroup?.viewColumn || this.panel.viewColumn,
        preserveFocus: false
      });
    } catch {
      vscode.window.showErrorMessage(`Unable to open module JSON file: ${jsonFilePath}`);
    }
  }
}