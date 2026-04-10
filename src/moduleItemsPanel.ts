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
  masterItems: ModuleItemsRow[];
  coreItems: ModuleItemsRow[];
  roleItems: ModuleItemsRow[];
  userItems: ModuleItemsRow[];
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
      masterItems: [],
      coreItems: [],
      roleItems: [],
      userItems: []
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
      masterItems: [...data.masterItems].sort((a, b) => a.itemPath.localeCompare(b.itemPath)),
      coreItems: [...data.coreItems].sort((a, b) => a.itemPath.localeCompare(b.itemPath)),
      roleItems: [...data.roleItems].sort((a, b) => a.itemPath.localeCompare(b.itemPath)),
      userItems: [...data.userItems].sort((a, b) => a.itemPath.localeCompare(b.itemPath))
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

    const masterHtml = this.renderTable('master', 'Master Database', this.data.masterItems, 'Path', 'No serialized master items matched this module.');
    const coreHtml = this.renderTable('core', 'Core Database', this.data.coreItems, 'Path', 'No serialized core items matched this module.');
    const rolesHtml = this.renderTable('roles', 'Roles', this.data.roleItems, 'Role', 'No serialized roles were found for this module.');
    const usersHtml = this.renderTable('users', 'Users', this.data.userItems, 'User', 'No serialized users were found for this module.');

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
.jump-nav {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 18px;
}
.jump-button,
.table-top-button {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, #7b3f00 12%);
  color: var(--vscode-button-foreground);
  padding: 6px 12px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  letter-spacing: 0.02em;
}
.jump-button:hover,
.table-top-button:hover {
  filter: brightness(1.08);
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.table-wrap {
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: auto;
  background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, #7b3f00 8%);
  margin-bottom: 18px;
}
.table-title {
  margin: 0 0 8px;
  font-size: 18px;
  letter-spacing: 0.02em;
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
  flex-wrap: nowrap;
  align-items: center;
  white-space: nowrap;
}
.action-link,
.action-button {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}
.action-button {
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
}
.action-link:hover { text-decoration: underline; }
.action-button:hover { text-decoration: underline; }
.action-link.disabled {
  color: var(--muted);
  pointer-events: none;
  text-decoration: none;
}
.copy-cluster {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.copy-separator {
  color: var(--muted);
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
  <nav class="jump-nav" aria-label="Jump to table section">
    <button type="button" class="jump-button scroll-section" data-scroll-target="master">Master</button>
    <button type="button" class="jump-button scroll-section" data-scroll-target="core">Core</button>
    <button type="button" class="jump-button scroll-section" data-scroll-target="roles">Roles</button>
    <button type="button" class="jump-button scroll-section" data-scroll-target="users">Users</button>
  </nav>
  ${masterHtml}
  ${coreHtml}
  ${rolesHtml}
  ${usersHtml}

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

    document.querySelectorAll('.scroll-section').forEach(btn => {
      btn.addEventListener('click', event => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLElement)) { return; }
        const sectionId = target.getAttribute('data-scroll-target');
        if (!sectionId) { return; }
        const section = document.getElementById(sectionId);
        if (section) {
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    document.querySelectorAll('.scroll-top').forEach(btn => {
      btn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  </script>
</body>
</html>`;
  }

  private renderTable(sectionId: string, title: string, rows: ModuleItemsRow[], firstColumnTitle: string, emptyMessage: string): string {
    const includeCopyId = sectionId === 'master' || sectionId === 'core';
    const showScrollTop = sectionId !== 'master';
    const rowsHtml = rows.length === 0
      ? `<tr><td colspan="4" class="empty-row">${this.escapeHtml(emptyMessage)}</td></tr>`
      : rows.map(item => {
        const idValue = item.itemId?.trim() || '';
        const copyLinks = includeCopyId
          ? (idValue
              ? `<span class="copy-cluster"><span class="copy-separator">|</span><button type="button" class="action-button copy-path" data-item-path="${this.escapeHtml(item.itemPath)}">Path</button><span class="copy-separator">|</span><button type="button" class="action-button copy-id" data-item-id="${this.escapeHtml(idValue)}">ID</button></span>`
              : `<span class="copy-cluster"><span class="copy-separator">|</span><button type="button" class="action-button copy-path" data-item-path="${this.escapeHtml(item.itemPath)}">Path</button><span class="copy-separator">|</span><span class="action-link disabled">ID</span></span>`)
          : `<button type="button" class="action-button copy-path" data-item-path="${this.escapeHtml(item.itemPath)}">Copy Value</button>`;

        return `
          <tr>
            <td class="path-cell">${this.escapeHtml(item.itemPath)}</td>
            <td>${this.escapeHtml(item.status)}</td>
            <td>${this.escapeHtml(item.includeOrRule)}</td>
            <td>
              <div class="actions">
                <button type="button" class="action-button open-yaml" data-yaml-path="${this.escapeHtml(item.yamlPath)}">See YML</button>
                ${copyLinks}
              </div>
            </td>
          </tr>
        `;
      }).join('');

    return `
      <section id="${this.escapeHtml(sectionId)}">
        <div class="section-header">
          <h2 class="table-title">${this.escapeHtml(title)}</h2>
          ${showScrollTop ? '<button type="button" class="table-top-button scroll-top">Scroll to Top</button>' : ''}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>${this.escapeHtml(firstColumnTitle)}</th>
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
      </section>
    `;
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
