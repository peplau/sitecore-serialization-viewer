import * as vscode from 'vscode';

interface ModuleItemsRow {
  itemPath: string;
  status: 'Serialized directly' | 'Serialized indirectly';
  includeOrRule: string;
  yamlPath: string;
  itemId?: string;
}

interface ModuleItemsPanelData {
  moduleName: string;
  description?: string;
  references?: string[];
  items: ModuleItemsRow[];
}

export class ModuleItemsPanel {
  private static readonly panels: Map<string, ModuleItemsPanel> = new Map();

  private readonly panel: vscode.WebviewPanel;
  private readonly moduleJsonPath: string;
  private data: ModuleItemsPanelData;

  private constructor(panel: vscode.WebviewPanel, moduleJsonPath: string, data: ModuleItemsPanelData) {
    this.panel = panel;
    this.moduleJsonPath = moduleJsonPath;
    this.data = data;

    this.panel.onDidDispose(() => {
      ModuleItemsPanel.panels.delete(this.moduleJsonPath.toLowerCase());
    });

    this.panel.webview.onDidReceiveMessage(async message => {
      if (message.command === 'openYaml' && typeof message.yamlPath === 'string') {
        await this.openYaml(message.yamlPath);
        return;
      }

      if (message.command === 'copyPath' && typeof message.value === 'string') {
        await vscode.env.clipboard.writeText(message.value);
        vscode.window.showInformationMessage('Copied path: ' + message.value);
        return;
      }

      if (message.command === 'copyId' && typeof message.value === 'string' && message.value.trim().length > 0) {
        await vscode.env.clipboard.writeText(message.value);
        vscode.window.showInformationMessage('Copied ID: ' + message.value);
      }
    });
  }

  public static createOrShowLoading(moduleJsonPath: string): ModuleItemsPanel {
    const key = moduleJsonPath.toLowerCase();
    const existing = ModuleItemsPanel.panels.get(key);
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (existing) {
      existing.panel.reveal(column);
      existing.showLoading();
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      'sitecoreSerializationModuleItems',
      'Items: Loading...',
      column,
      { enableScripts: true }
    );

    const instance = new ModuleItemsPanel(panel, moduleJsonPath, {
      moduleName: this.deriveModuleName(moduleJsonPath),
      items: []
    });
    ModuleItemsPanel.panels.set(key, instance);
    instance.showLoading();
    return instance;
  }

  public static createOrShow(moduleJsonPath: string, data: ModuleItemsPanelData): ModuleItemsPanel {
    const key = moduleJsonPath.toLowerCase();
    const existing = ModuleItemsPanel.panels.get(key);
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (existing) {
      existing.panel.reveal(column);
      existing.update(data);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      'sitecoreSerializationModuleItems',
      `Items: ${data.moduleName}`,
      column,
      { enableScripts: true }
    );

    const instance = new ModuleItemsPanel(panel, moduleJsonPath, data);
    ModuleItemsPanel.panels.set(key, instance);
    instance.update(data);
    return instance;
  }

  public update(data: ModuleItemsPanelData): void {
    this.data = {
      ...data,
      items: [...data.items].sort((a, b) => a.itemPath.localeCompare(b.itemPath))
    };
    this.panel.title = `Items: ${this.data.moduleName}`;
    this.panel.webview.html = this.getHtml();
  }

  public showLoading(): void {
    const moduleName = this.data.moduleName || ModuleItemsPanel.deriveModuleName(this.moduleJsonPath);
    this.panel.title = `Items: ${moduleName}`;
    this.panel.webview.html = this.getLoadingHtml(moduleName);
  }

  public showError(message: string): void {
    const moduleName = this.data.moduleName || ModuleItemsPanel.deriveModuleName(this.moduleJsonPath);
    this.panel.title = `Items: ${moduleName}`;
    this.panel.webview.html = this.getErrorHtml(moduleName, message);
  }

  private static deriveModuleName(moduleJsonPath: string): string {
    const normalized = moduleJsonPath.replace(/\\/g, '/');
    const fileName = normalized.split('/').pop() || normalized;
    return fileName.replace(/\.json$/i, '');
  }

  private async openYaml(yamlPath: string): Promise<void> {
    try {
      const targetUri = vscode.Uri.file(yamlPath);
      const doc = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: this.panel.viewColumn
      });
    } catch {
      vscode.window.showErrorMessage(`Unable to open YML file: ${yamlPath}`);
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private getHtml(): string {
    const descriptionHtml = this.data.description
      ? `<p class="description">${this.escapeHtml(this.data.description)}</p>`
      : '';

    const references = Array.isArray(this.data.references)
      ? this.data.references.filter(reference => typeof reference === 'string' && reference.trim().length > 0)
      : [];

    const referencesHtml = references.length > 0
      ? `<p class="references">References: ${references.map(reference => this.escapeHtml(reference)).join(', ')}</p>`
      : '';

    const rowsHtml = this.data.items.length === 0
      ? `<tr><td colspan="4" class="empty-row">No serialized items matched this module and selected database.</td></tr>`
      : this.data.items.map(item => {
        const idValue = item.itemId?.trim() || '';
        const copyIdLink = idValue
          ? `<a href="#" class="action-link copy-id" data-item-id="${this.escapeHtml(idValue)}">Copy ID</a>`
          : '<span class="action-link disabled">Copy ID</span>';

        return `
          <tr>
            <td class="path-cell">${this.escapeHtml(item.itemPath)}</td>
            <td>${this.escapeHtml(item.status)}</td>
            <td>${this.escapeHtml(item.includeOrRule)}</td>
            <td>
              <div class="actions">
                <a href="#" class="action-link open-yaml" data-yaml-path="${this.escapeHtml(item.yamlPath)}">See YML</a>
                <a href="#" class="action-link copy-path" data-item-path="${this.escapeHtml(item.itemPath)}">Copy Path</a>
                ${copyIdLink}
              </div>
            </td>
          </tr>
        `;
      }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  --panel-bg: color-mix(in srgb, var(--vscode-editor-background) 92%, #d4b25f 8%);
  --border: color-mix(in srgb, var(--vscode-editorWidget-border) 65%, #d4b25f 35%);
  --muted: var(--vscode-descriptionForeground);
  --accent: #d4b25f;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  background:
    radial-gradient(circle at top right, rgba(212, 178, 95, 0.18), transparent 34%),
    linear-gradient(180deg, var(--panel-bg), var(--vscode-editor-background));
  color: var(--vscode-editor-foreground);
  font-family: Georgia, 'Segoe UI', serif;
}
h1 {
  margin: 0;
  font-size: 26px;
}
.description {
  margin: 8px 0 18px;
  color: var(--muted);
}
.references {
  margin: -8px 0 18px;
  color: var(--muted);
  word-break: break-word;
}
.table-wrap {
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: auto;
  background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, #7b3f00 8%);
}
table {
  border-collapse: collapse;
  width: 100%;
  min-width: 860px;
}
th, td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  vertical-align: top;
}
th {
  position: sticky;
  top: 0;
  background: color-mix(in srgb, var(--vscode-editor-background) 85%, #d4b25f 15%);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.path-cell {
  word-break: break-word;
  white-space: normal;
}
.actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.action-link {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}
.action-link:hover { text-decoration: underline; }
.action-link.disabled {
  color: var(--muted);
  pointer-events: none;
  text-decoration: none;
}
.empty-row {
  color: var(--muted);
  font-style: italic;
}
</style>
</head>
<body>
  <h1>${this.escapeHtml(this.data.moduleName)}</h1>
  ${descriptionHtml}
  ${referencesHtml}
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Path</th>
          <th>Status</th>
          <th>Include / Rule</th>
          <th>Links</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    document.querySelectorAll('.open-yaml').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) { return; }
        const yamlPath = target.getAttribute('data-yaml-path');
        if (yamlPath) {
          vscode.postMessage({ command: 'openYaml', yamlPath });
        }
      });
    });

    document.querySelectorAll('.copy-path').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) { return; }
        const value = target.getAttribute('data-item-path');
        if (value) {
          vscode.postMessage({ command: 'copyPath', value });
        }
      });
    });

    document.querySelectorAll('.copy-id').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) { return; }
        const value = target.getAttribute('data-item-id');
        if (value) {
          vscode.postMessage({ command: 'copyId', value });
        }
      });
    });
  </script>
</body>
</html>`;
  }

  private getLoadingHtml(moduleName: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body {
  margin: 0;
  padding: 24px;
  color: var(--vscode-editor-foreground);
  font-family: Georgia, 'Segoe UI', serif;
  background:
    radial-gradient(circle at top right, rgba(212, 178, 95, 0.18), transparent 34%),
    linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 92%, #d4b25f 8%), var(--vscode-editor-background));
}
h1 { margin: 0 0 14px; font-size: 24px; }
.loading-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 65%, #d4b25f 35%);
  border-radius: 10px;
  background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, #7b3f00 8%);
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
</style>
</head>
<body>
  <h1>${this.escapeHtml(moduleName)}</h1>
  <div class="loading-wrap">
    <div class="spinner" aria-hidden="true"></div>
    <div>Loading module items...</div>
  </div>
</body>
</html>`;
  }

  private getErrorHtml(moduleName: string, message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body {
  margin: 0;
  padding: 24px;
  color: var(--vscode-editor-foreground);
  font-family: Georgia, 'Segoe UI', serif;
}
h1 { margin: 0 0 14px; font-size: 24px; }
.error-box {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 55%, var(--vscode-editorWidget-border, #454545) 45%);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, #7b1010 10%);
}
</style>
</head>
<body>
  <h1>${this.escapeHtml(moduleName)}</h1>
  <div class="error-box">${this.escapeHtml(message)}</div>
</body>
</html>`;
  }
}
