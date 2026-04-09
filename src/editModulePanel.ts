import * as vscode from 'vscode';

interface RuleJson {
  path?: string;
  scope?: string;
  alias?: string;
  allowedPushOperations?: string;
}

interface ExcludedFieldJson {
  fieldID?: string;
  description?: string;
}

interface IncludeJson {
  name?: string;
  path?: string;
  database?: string;
  scope?: string;
  allowedPushOperations?: string;
  maxRelativeDepth?: number;
  rules?: RuleJson[];
  excludedFields?: ExcludedFieldJson[];
}

interface ModuleFileJson {
  namespace?: string;
  description?: string;
  references?: string[];
  items?: {
    includes?: IncludeJson[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RuleFormData {
  path: string;
  scope: string;
  alias?: string;
  allowedPushOperations?: string;
}

interface ExcludedFieldFormData {
  fieldID: string;
  description: string;
}

interface IncludeFormData {
  name: string;
  path: string;
  database: string;
  scope: string;
  allowedPushOperations: string;
  maxRelativeDepth?: number;
  rules: RuleFormData[];
  excludedFields: ExcludedFieldFormData[];
}

interface ModuleSaveData {
  namespace: string;
  description: string;
  references: string[];
  includes: IncludeFormData[];
}

export class EditModulePanel {
  private static readonly panels: Map<string, EditModulePanel> = new Map();
  private readonly panel: vscode.WebviewPanel;
  private readonly jsonFileUri: vscode.Uri;
  private rawJson: ModuleFileJson = { namespace: '' };

  private constructor(panel: vscode.WebviewPanel, jsonFileUri: vscode.Uri) {
    this.panel = panel;
    this.jsonFileUri = jsonFileUri;

    this.panel.webview.onDidReceiveMessage(async (message: { command: string; data?: ModuleSaveData }) => {
      if (message.command === 'saveModule' && message.data) {
        await this.saveModule(message.data);
      }
    });

    this.panel.onDidDispose(() => {
      EditModulePanel.panels.delete(this.jsonFileUri.fsPath.toLowerCase());
    });
  }

  public static async createOrShow(jsonFilePath: string): Promise<void> {
    const key = jsonFilePath.toLowerCase();
    const existing = EditModulePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const jsonFileUri = vscode.Uri.file(jsonFilePath);
    const activeColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    const panel = vscode.window.createWebviewPanel(
      'sitecoreEditModule',
      'Edit Module',
      activeColumn,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const instance = new EditModulePanel(panel, jsonFileUri);
    EditModulePanel.panels.set(key, instance);
    await instance.loadAndRender();
  }

  private async loadAndRender(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.jsonFileUri);
      this.rawJson = JSON.parse(Buffer.from(bytes).toString('utf8')) as ModuleFileJson;
    } catch {
      this.rawJson = { namespace: '' };
    }
    this.panel.title = 'Edit: ' + (this.rawJson.namespace ?? 'Module');
    this.panel.webview.html = this.buildHtml();
  }

  private async saveModule(data: ModuleSaveData): Promise<void> {
    const existingIncludes = Array.isArray(this.rawJson.items?.includes) ? this.rawJson.items?.includes ?? [] : [];

    const nextIncludes: IncludeJson[] = data.includes.map((inc, includeIndex) => {
      const existingInclude = existingIncludes[includeIndex] ? { ...existingIncludes[includeIndex] } : {};

      existingInclude.name = inc.name.trim();
      existingInclude.path = inc.path.trim();

      if (inc.database?.trim()) {
        existingInclude.database = inc.database.trim();
      } else {
        delete existingInclude.database;
      }

      if (inc.scope?.trim()) {
        existingInclude.scope = inc.scope.trim();
      } else {
        delete existingInclude.scope;
      }

      if (inc.allowedPushOperations?.trim()) {
        existingInclude.allowedPushOperations = inc.allowedPushOperations.trim();
      } else {
        delete existingInclude.allowedPushOperations;
      }

      if (typeof inc.maxRelativeDepth === 'number' && Number.isFinite(inc.maxRelativeDepth)) {
        existingInclude.maxRelativeDepth = inc.maxRelativeDepth;
      } else {
        delete existingInclude.maxRelativeDepth;
      }

      const existingRules = Array.isArray(existingInclude.rules) ? existingInclude.rules : [];
      const nextRules: RuleJson[] = inc.rules.map((rule, ruleIndex) => {
        const existingRule = existingRules[ruleIndex] ? { ...existingRules[ruleIndex] } : {};

        existingRule.path = rule.path.trim();
        existingRule.scope = rule.scope;

        if (rule.alias?.trim()) {
          existingRule.alias = rule.alias.trim();
        } else {
          delete existingRule.alias;
        }

        if (rule.allowedPushOperations?.trim() && rule.allowedPushOperations !== '__inherited__') {
          existingRule.allowedPushOperations = rule.allowedPushOperations.trim();
        } else {
          delete existingRule.allowedPushOperations;
        }

        return existingRule;
      });

      if (nextRules.length > 0) {
        existingInclude.rules = nextRules;
      } else {
        delete existingInclude.rules;
      }

      const existingExcludedFields = Array.isArray(existingInclude.excludedFields) ? existingInclude.excludedFields : [];
      const nextExcludedFields: ExcludedFieldJson[] = inc.excludedFields.map((field, fieldIndex) => {
        const existingField = existingExcludedFields[fieldIndex] ? { ...existingExcludedFields[fieldIndex] } : {};

        existingField.fieldID = field.fieldID.trim();
        existingField.description = field.description.trim();

        return existingField;
      });

      if (nextExcludedFields.length > 0) {
        existingInclude.excludedFields = nextExcludedFields;
      } else {
        delete existingInclude.excludedFields;
      }

      return existingInclude;
    });

    const references = Array.isArray(data.references)
      ? data.references
        .filter(reference => typeof reference === 'string')
        .map(reference => reference.trim())
        .filter(reference => reference.length > 0)
      : [];

    const description = data.description?.trim();
    const {
      namespace: _existingNamespace,
      description: _existingDescription,
      references: _existingReferences,
      items: existingItems,
      ...restRaw
    } = this.rawJson;

    const merged: ModuleFileJson = {
      namespace: data.namespace,
      ...(references.length > 0 ? { references } : {}),
      ...(description ? { description } : {}),
      ...restRaw,
      items: {
        ...(existingItems ?? {}),
        includes: nextIncludes
      }
    };

    try {
      await vscode.workspace.fs.writeFile(
        this.jsonFileUri,
        Buffer.from(JSON.stringify(merged, null, 2), 'utf8')
      );
      this.rawJson = merged;
      this.panel.title = 'Edit: ' + (merged.namespace ?? 'Module');
      this.panel.webview.postMessage({ command: 'saved' });
      vscode.window.showInformationMessage('Module "' + (merged.namespace ?? '') + '" saved.');
    } catch (err) {
      vscode.window.showErrorMessage('Failed to save: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private esc(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private buildInitialDataJson(): string {
    const includes = this.rawJson.items?.includes ?? [];
    const references = Array.isArray(this.rawJson.references)
      ? this.rawJson.references
        .filter(reference => typeof reference === 'string')
        .map(reference => reference.trim())
        .filter(reference => reference.length > 0)
      : [];

    return JSON.stringify({
      namespace: this.rawJson.namespace ?? '',
      description: this.rawJson.description ?? '',
      references,
      includes: includes.map(inc => ({
        name: inc.name ?? '',
        path: inc.path ?? '',
        database: inc.database ?? '',
        scope: inc.scope ?? '',
        allowedPushOperations: inc.allowedPushOperations ?? '',
        maxRelativeDepth: typeof inc.maxRelativeDepth === 'number' ? inc.maxRelativeDepth : '',
        rules: (inc.rules ?? []).map(rule => ({
          path: rule.path ?? '',
          scope: rule.scope ?? '',
          alias: rule.alias ?? '',
          allowedPushOperations: rule.allowedPushOperations ?? '__inherited__'
        })),
        excludedFields: (inc.excludedFields ?? []).map(field => ({
          fieldID: field.fieldID ?? '',
          description: field.description ?? ''
        }))
      }))
    });
  }

  private buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  --surface: var(--vscode-sideBar-background, #252526);
  --border: var(--vscode-editorWidget-border, #454545);
  --text: var(--vscode-editor-foreground, #cccccc);
  --muted: var(--vscode-descriptionForeground, #858585);
  --accent: #d4b25f;
  --input-bg: var(--vscode-input-background, #3c3c3c);
  --input-border: var(--vscode-input-border, #3c3c3c);
  --input-fg: var(--vscode-input-foreground, #cccccc);
  --focus: var(--vscode-focusBorder, #007fd4);
  --danger: #f48771;
  --card-bg: color-mix(in srgb, var(--surface) 90%, #7b3f00 10%);
  --card-border: color-mix(in srgb, var(--border) 65%, #d4b25f 35%);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--vscode-editor-background);
  color: var(--text);
  font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
  font-size: 13px;
  padding: 24px;
  max-width: 900px;
}
h1 { font-size: 20px; font-weight: 700; margin-bottom: 20px; color: var(--accent); }
h2 { font-size: 14px; font-weight: 700; }
h3 { font-size: 11px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.07em; }
.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
}
.fields-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.field { display: flex; flex-direction: column; gap: 5px; }
.field.span-2 { grid-column: span 2; }
label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--accent);
}
input[type="text"], input[type="number"], select {
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  color: var(--input-fg);
  font: inherit;
  font-size: 13px;
  padding: 7px 10px;
  width: 100%;
  outline: none;
}
input:focus, select:focus { border-color: var(--focus); }
input::placeholder { color: var(--muted); opacity: 0.7; }
.req { color: var(--danger); margin-left: 2px; }
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.include-block {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 0;
  margin-bottom: 14px;
}
.include-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0;
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--card-border) 60%, transparent);
}
.include-label {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.rules-section { margin-top: 20px; }
.rules-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--card-border) 50%, transparent);
}
.rule-block {
  background: color-mix(in srgb, var(--vscode-editor-background) 75%, var(--card-bg) 25%);
  border: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 10px;
}
.rule-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.rule-field { display: flex; flex-direction: column; gap: 5px; }
.rule-remove-row {
  grid-column: span 2;
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}
.excluded-fields-section { margin-top: 20px; }
.excluded-fields-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--card-border) 50%, transparent);
}
.excluded-field-block {
  background: color-mix(in srgb, var(--vscode-editor-background) 75%, var(--card-bg) 25%);
  border: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 10px;
}
.excluded-field-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.excluded-field-field { display: flex; flex-direction: column; gap: 5px; }
.excluded-field-remove-row {
  grid-column: span 2;
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}
button { cursor: pointer; font: inherit; }
.btn-save {
  background: var(--accent);
  border: none;
  border-radius: 8px;
  color: #1a1a1a;
  font-weight: 700;
  font-size: 14px;
  padding: 10px 28px;
}
.btn-save:hover { opacity: 0.88; }
.btn-secondary {
  background: transparent;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  color: var(--accent);
  font-weight: 600;
  font-size: 13px;
  padding: 7px 14px;
}
.btn-secondary:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.btn-secondary-sm {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--card-border) 80%, transparent);
  border-radius: 6px;
  color: var(--accent);
  font-size: 12px;
  padding: 4px 10px;
}
.btn-secondary-sm:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.btn-danger-text {
  background: transparent;
  border: none;
  color: var(--danger);
  font-size: 12px;
  padding: 4px 0;
}
.btn-danger-text:hover { text-decoration: underline; }
.btn-danger-sm {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--danger) 60%, transparent);
  border-radius: 6px;
  color: var(--danger);
  font-size: 12px;
  padding: 4px 10px;
}
.btn-danger-sm:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }
.form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}
.form-actions-top {
  margin-top: 0;
  margin-bottom: 16px;
  padding-top: 0;
  border-top: none;
}
.feedback { font-size: 12px; color: var(--muted); }
.feedback.ok { color: #89d185; }
.references-section {
  margin-top: 16px;
}
.references-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.reference-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.reference-row input {
  flex: 1;
}
.nav-links {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.nav-links-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.nav-btn {
  background: transparent;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
}
.nav-btn:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.scroll-to-top {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--card-border) 80%, transparent);
  border-radius: 6px;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 10px;
}
.scroll-to-top:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.expand-collapse-buttons {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}
.expand-collapse-btn {
  background: transparent;
  border: 1px solid var(--card-border);
  border-radius: 6px;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 10px;
}
.expand-collapse-btn:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.include-block.collapsed .include-content {
  display: none;
}
.include-block.collapsed .include-header {
  border-bottom: none;
}
.include-block.collapsed .include-actions-row .scroll-to-top {
  display: none;
}
.include-toggle {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  margin-right: 8px;
  padding: 0;
  width: 20px;
  text-align: center;
}
.include-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.include-name-display {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}
.include-actions-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.include-content {
  padding: 14px;
}
.excluded-fields-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 14px;
  position: relative;
}
</style>
</head>
<body>
<h1>Edit Module: <span id="title-ns">${this.esc(this.rawJson.namespace ?? '')}</span></h1>

<nav class="nav-links">
  <div class="nav-links-left">
    <button type="button" class="nav-btn" id="nav-module">Module</button>
    <button type="button" class="nav-btn" id="nav-includes">Includes</button>
    <button type="button" class="nav-btn" id="nav-excluded-fields">Excluded Fields</button>
  </div>
  <button type="button" id="btn-save-top" class="btn-save">Save Module</button>
</nav>

<section class="card" id="section-module">
  <div class="fields-grid">
    <div class="field span-2">
      <label for="namespace">Namespace<span class="req">*</span></label>
      <input id="namespace" type="text" value="${this.esc(this.rawJson.namespace ?? '')}" required placeholder="e.g. Vizient.Heroes">
    </div>
    <div class="field span-2">
      <label for="description">Description</label>
      <input id="description" type="text" value="${this.esc(this.rawJson.description ?? '')}" placeholder="Optional description">
    </div>
  </div>

  <div class="references-section">
    <div class="section-header">
      <h2>References</h2>
      <button type="button" id="btn-add-reference" class="btn-secondary-sm">+ Add Reference</button>
    </div>
    <div id="references-container" class="references-list"></div>
  </div>
</section>

<div class="section-header" id="section-includes">
  <h2>Includes</h2>
  <button type="button" id="btn-add-include" class="btn-secondary">+ Add Include</button>
</div>
<div class="expand-collapse-buttons">
  <button type="button" id="btn-expand-all" class="expand-collapse-btn">Expand All</button>
  <button type="button" id="btn-collapse-all" class="expand-collapse-btn">Collapse All</button>
</div>
<div id="includes-container"></div>

<div id="section-excluded-fields">
  <div class="section-header">
    <h2>Excluded Fields</h2>
  </div>
  <div id="excluded-fields-container"></div>
</div>

<div class="form-actions">
  <button type="button" id="btn-save" class="btn-save">Save Module</button>
  <span id="feedback" class="feedback"></span>
</div>

<script type="application/json" id="initial-data">${this.buildInitialDataJson()}</script>
<script>
  const vscode = acquireVsCodeApi();
  const data = JSON.parse(document.getElementById('initial-data').textContent);
  data.references = Array.isArray(data.references) ? data.references : [];
  let idCounter = data.includes.length;

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function opted(selected, values) {
    return values.map(function(v) {
      return '<option value="' + v + '"' + (v.toLowerCase() === (selected || '').toLowerCase() ? ' selected' : '') + '>' + v + '</option>';
    }).join('');
  }

  function ruleHtml(rule) {
    var pushOpts =
      '<option value="__inherited__"' + (!rule.allowedPushOperations || rule.allowedPushOperations === '__inherited__' ? ' selected' : '') + '>\u2014 Inherited from parent (default) \u2014</option>' +
      '<option value="CreateOnly"' + (rule.allowedPushOperations === 'CreateOnly' ? ' selected' : '') + '>CreateOnly</option>' +
      '<option value="CreateAndUpdate"' + (rule.allowedPushOperations === 'CreateAndUpdate' ? ' selected' : '') + '>CreateAndUpdate</option>' +
      '<option value="CreateUpdateAndDelete"' + (rule.allowedPushOperations === 'CreateUpdateAndDelete' ? ' selected' : '') + '>CreateUpdateAndDelete</option>';

    return '<div class="rule-block">' +
      '<div class="rule-fields">' +
        '<div class="rule-field">' +
          '<label>Path<span class="req">*</span></label>' +
          '<input class="rule-path" type="text" value="' + esc(rule.path) + '" required placeholder="/relative or /sitecore/...">' +
        '</div>' +
        '<div class="rule-field">' +
          '<label>Scope</label>' +
          '<select class="rule-scope">' +
            '<option value=""' + (!rule.scope ? ' selected' : '') + '>— Not set —</option>' +
            opted(rule.scope, ['Ignored', 'SingleItem', 'ItemAndChildren', 'ItemAndDescendants']) +
          '</select>' +
        '</div>' +
        '<div class="rule-field">' +
          '<label>Alias</label>' +
          '<input class="rule-alias" type="text" value="' + esc(rule.alias) + '" placeholder="Optional alias">' +
        '</div>' +
        '<div class="rule-field">' +
          '<label>Allowed Push Operations</label>' +
          '<select class="rule-push-ops">' + pushOpts + '</select>' +
        '</div>' +
        '<div class="rule-remove-row">' +
          '<button type="button" class="btn-danger-sm btn-remove-rule">Remove Rule</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function excludedFieldHtml(field) {
    return '<div class="excluded-field-block">' +
      '<div class="excluded-field-fields">' +
        '<div class="excluded-field-field">' +
          '<label>Field ID<span class="req">*</span></label>' +
          '<input class="excluded-field-id" type="text" value="' + esc(field.fieldID) + '" required placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}">' +
        '</div>' +
        '<div class="excluded-field-field">' +
          '<label>Description</label>' +
          '<input class="excluded-field-description" type="text" value="' + esc(field.description) + '" placeholder="Optional description">' +
        '</div>' +
        '<div class="excluded-field-remove-row">' +
          '<button type="button" class="btn-danger-sm btn-remove-excluded-field">Remove Field</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function includeHtml(id, inc) {
    var incPushOpts =
      '<option value=""' + (!inc.allowedPushOperations ? ' selected' : '') + '>\u2014 Not set (default: CreateUpdateAndDelete) \u2014</option>' +
      '<option value="CreateOnly"' + (inc.allowedPushOperations === 'CreateOnly' ? ' selected' : '') + '>CreateOnly</option>' +
      '<option value="CreateAndUpdate"' + (inc.allowedPushOperations === 'CreateAndUpdate' ? ' selected' : '') + '>CreateAndUpdate</option>' +
      '<option value="CreateUpdateAndDelete"' + (inc.allowedPushOperations === 'CreateUpdateAndDelete' ? ' selected' : '') + '>CreateUpdateAndDelete</option>';

    var dbOpts =
      '<option value=""' + (!inc.database ? ' selected' : '') + '>\u2014 Not set (default: master) \u2014</option>' +
      '<option value="master"' + (inc.database === 'master' ? ' selected' : '') + '>master</option>' +
      '<option value="core"' + (inc.database === 'core' ? ' selected' : '') + '>core</option>';

    var rulesHtml = (inc.rules || []).map(ruleHtml).join('');

      return '<div class="include-block collapsed" data-id="' + id + '">' +
        '<div class="include-header">' +
          '<div class="include-title-row">' +
            '<button type="button" class="include-toggle">▶</button>' +
            '<span class="include-name-display">' + esc(inc.name || '(Unnamed)') + '</span>' +
          '</div>' +
          '<div class="include-actions-row">' +
            '<button type="button" class="scroll-to-top" title="Scroll to top">Scroll to the top</button>' +
            '<button type="button" class="btn-danger-sm btn-remove-include">Remove Include</button>' +
          '</div>' +
        '</div>' +
        '<div class="include-content">' +
      '<div class="fields-grid">' +
        '<div class="field span-2">' +
          '<label>Name<span class="req">*</span></label>' +
          '<input class="inc-name" type="text" value="' + esc(inc.name) + '" required placeholder="e.g. Templates.Feature.Module.Name">' +
        '</div>' +
        '<div class="field span-2">' +
          '<label>Path<span class="req">*</span></label>' +
          '<input class="inc-path" type="text" value="' + esc(inc.path) + '" required placeholder="/sitecore/...">' +
        '</div>' +
        '<div class="field">' +
          '<label>Database</label>' +
          '<select class="inc-database">' + dbOpts + '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label>Scope</label>' +
          '<select class="inc-scope">' +
            '<option value=""' + (!inc.scope ? ' selected' : '') + '>— Not set (default: ItemAndDescendants) —</option>' +
            opted(inc.scope, ['SingleItem', 'ItemAndChildren', 'ItemAndDescendants', 'DescendantsOnly', 'Ignored']) +
          '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label>Allowed Push Operations</label>' +
          '<select class="inc-push-ops">' + incPushOpts + '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label>Max Relative Path Length (default: 130)</label>' +
          '<input class="inc-max-depth" type="number" min="1" value="' + esc(inc.maxRelativeDepth) + '" placeholder="Optional">' +
        '</div>' +
      '</div>' +
      '<div class="rules-section">' +
        '<div class="rules-header">' +
          '<h3>Rules</h3>' +
          '<button type="button" class="btn-secondary-sm btn-add-rule">+ Add Rule</button>' +
        '</div>' +
        '<div class="rules-container">' + rulesHtml + '</div>' +
      '</div>' +
        '</div>' +
    '</div>';
  }

  function excludedFieldsCardHtml(id, excludedFields) {
    var excludedFieldsHtml = (excludedFields || []).map(excludedFieldHtml).join('');
    
    if (!excludedFieldsHtml) {
      return '<div class="excluded-fields-card" data-include-id="' + id + '" style="display:none"></div>';
    }

    return '<div class="excluded-fields-card" data-include-id="' + id + '">' +
      '<button type="button" class="scroll-to-top" style="position: absolute; top: 14px; right: 14px;" title="Scroll to top">Top</button>' +
      '<div class="include-header">' +
        '<span class="include-label">Excluded Fields (Include #' + (id + 1) + ')</span>' +
      '</div>' +
      '<div class="excluded-fields-section">' +
        '<div class="excluded-fields-header">' +
          '<h3>Fields</h3>' +
          '<button type="button" class="btn-secondary-sm btn-add-excluded-field" data-include-id="' + id + '">+ Add Excluded Field</button>' +
        '</div>' +
        '<div class="excluded-fields-container" data-include-id="' + id + '">' + excludedFieldsHtml + '</div>' +
      '</div>' +
    '</div>';
  }

  function referenceHtml(reference) {
    return '<div class="reference-row">' +
      '<input class="reference-value" type="text" value="' + esc(reference) + '" placeholder="e.g. Foundation.*">' +
      '<button type="button" class="btn-danger-sm btn-remove-reference">Remove</button>' +
    '</div>';
  }

  function renderReferences() {
    var container = document.getElementById('references-container');
    var html = '';
    for (var i = 0; i < data.references.length; i++) {
      html += referenceHtml(data.references[i]);
    }
    container.innerHTML = html;
  }

  function renderIncludes() {
    var container = document.getElementById('includes-container');
    var excludedFieldsContainer = document.getElementById('excluded-fields-container');
    
    var includesHtml = '';
    var excludedFieldsHtml = '';
    
    for (var i = 0; i < data.includes.length; i++) {
      includesHtml += includeHtml(i, data.includes[i]);
      excludedFieldsHtml += excludedFieldsCardHtml(i, data.includes[i].excludedFields || []);
    }
    
    container.innerHTML = includesHtml;
    excludedFieldsContainer.innerHTML = excludedFieldsHtml;
  }

  function focusAndScroll(el) {
    if (!el) { return; }
    el.focus();
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  renderIncludes();
  renderReferences();

  document.getElementById('namespace').addEventListener('input', function() {
    document.getElementById('title-ns').textContent = this.value;
  });

  document.addEventListener('click', function(evt) {
    var target = evt.target;
    if (!(target instanceof Element)) { return; }

      // Scroll to top
      if (target.classList.contains('scroll-to-top')) {
        evt.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

    // Navigation links
    if (target.id === 'nav-module') {
      var moduleSection = document.getElementById('section-module');
      if (moduleSection) { moduleSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }

    if (target.id === 'nav-includes') {
      var includesSection = document.getElementById('section-includes');
      if (includesSection) { includesSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }

    if (target.id === 'nav-excluded-fields') {
      var excludedSection = document.getElementById('section-excluded-fields');
      if (excludedSection) { excludedSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }

      // Include toggle
      if (target.classList.contains('include-toggle')) {
        var incBlock = target.closest('.include-block');
        if (incBlock) {
          incBlock.classList.toggle('collapsed');
          target.textContent = incBlock.classList.contains('collapsed') ? '▶' : '▼';
        }
        return;
      }

      // Expand all includes
      if (target.id === 'btn-expand-all') {
        document.querySelectorAll('.include-block.collapsed').forEach(function(block) {
          block.classList.remove('collapsed');
          var toggle = block.querySelector('.include-toggle');
          if (toggle) { toggle.textContent = '▼'; }
        });
        return;
      }

      // Collapse all includes
      if (target.id === 'btn-collapse-all') {
        document.querySelectorAll('.include-block:not(.collapsed)').forEach(function(block) {
          block.classList.add('collapsed');
          var toggle = block.querySelector('.include-toggle');
          if (toggle) { toggle.textContent = '▶'; }
        });
        return;
      }

    if (target.classList.contains('btn-remove-include')) {
      var block = target.closest('.include-block');
      if (block) {
        var id = block.getAttribute('data-id');
        block.remove();
        // Also remove corresponding excluded fields card
        var excludedCard = document.querySelector('.excluded-fields-card[data-include-id="' + id + '"]');
        if (excludedCard) { excludedCard.remove(); }
      }
      return;
    }

    if (target.classList.contains('btn-add-rule')) {
      var incBlock = target.closest('.include-block');
      if (incBlock) {
        var rulesContainer = incBlock.querySelector('.rules-container');
        if (rulesContainer) {
          var tmp = document.createElement('div');
          tmp.innerHTML = ruleHtml({ path: '', scope: '', alias: '', allowedPushOperations: '__inherited__' });
          var newRule = tmp.firstChild;
          rulesContainer.appendChild(newRule);
          var firstRuleField = newRule && newRule.querySelector ? newRule.querySelector('.rule-path') : null;
          focusAndScroll(firstRuleField);
        }
      }
      return;
    }

    if (target.classList.contains('btn-remove-rule')) {
      var rule = target.closest('.rule-block');
      if (rule) { rule.remove(); }
      return;
    }

    if (target.classList.contains('btn-add-excluded-field')) {
      var includeId = target.getAttribute('data-include-id');
      var fieldsContainer = document.querySelector('.excluded-fields-container[data-include-id="' + includeId + '"]');
      if (!fieldsContainer) {
        // Field might be in include block for legacy support
        var incBlock = target.closest('.included-block');
        if (incBlock) {
          fieldsContainer = incBlock.querySelector('.excluded-fields-container');
        }
      }
      if (fieldsContainer) {
        var tmp = document.createElement('div');
        tmp.innerHTML = excludedFieldHtml({ fieldID: '', description: '' });
        var newField = tmp.firstChild;
        fieldsContainer.appendChild(newField);
        var firstFieldField = newField && newField.querySelector ? newField.querySelector('.excluded-field-id') : null;
        focusAndScroll(firstFieldField);
      }
      return;
    }

    if (target.classList.contains('btn-remove-excluded-field')) {
      var field = target.closest('.excluded-field-block');
      if (field) { field.remove(); }
      return;
    }

    if (target.classList.contains('btn-remove-reference')) {
      var row = target.closest('.reference-row');
      if (row) { row.remove(); }
      return;
    }

    if (target.id === 'btn-add-reference') {
      var referencesContainer = document.getElementById('references-container');
      var tmpRef = document.createElement('div');
      tmpRef.innerHTML = referenceHtml('');
      var newRef = tmpRef.firstChild;
      referencesContainer.appendChild(newRef);
      var firstReferenceField = newRef && newRef.querySelector ? newRef.querySelector('.reference-value') : null;
      focusAndScroll(firstReferenceField);
      return;
    }

    if (target.id === 'btn-add-include') {
      var container = document.getElementById('includes-container');
      var tmp = document.createElement('div');
      tmp.innerHTML = includeHtml(idCounter++, {
        name: '', path: '', database: '',
        scope: '', allowedPushOperations: '',
        maxRelativeDepth: '', rules: [], excludedFields: []
      });
      var newInclude = tmp.firstChild;
      container.appendChild(newInclude);
      
      // Also add empty excluded fields card
      var excludedFieldsContainer = document.getElementById('excluded-fields-container');
      var tmpExcluded = document.createElement('div');
      tmpExcluded.innerHTML = excludedFieldsCardHtml(idCounter - 1, []);
      excludedFieldsContainer.appendChild(tmpExcluded.firstChild);
      
      
      var firstIncludeField = newInclude && newInclude.querySelector ? newInclude.querySelector('.inc-name') : null;
      focusAndScroll(firstIncludeField);
      return;
    }

    if (target.id === 'btn-save' || target.id === 'btn-save-top') {
      doSave();
    }
  });

  function collectData() {
    var includes = [];
    document.querySelectorAll('.include-block').forEach(function(incEl) {
      var id = incEl.getAttribute('data-id');
      var rules = [];
      incEl.querySelectorAll('.rule-block').forEach(function(ruleEl) {
        var pushOps = ruleEl.querySelector('.rule-push-ops').value;
        rules.push({
          path: ruleEl.querySelector('.rule-path').value.trim(),
          scope: ruleEl.querySelector('.rule-scope').value,
          alias: ruleEl.querySelector('.rule-alias').value.trim() || undefined,
          allowedPushOperations: pushOps === '__inherited__' ? undefined : pushOps
        });
      });
      
      // Collect excluded fields from the separated card
      var excludedFields = [];
      var excludedCard = document.querySelector('.excluded-fields-card[data-include-id="' + id + '"]');
      if (excludedCard) {
        excludedCard.querySelectorAll('.excluded-field-block').forEach(function(fieldEl) {
          excludedFields.push({
            fieldID: fieldEl.querySelector('.excluded-field-id').value.trim(),
            description: fieldEl.querySelector('.excluded-field-description').value.trim()
          });
        });
      }
      
      var maxDepthRaw = incEl.querySelector('.inc-max-depth').value.trim();
      var maxDepth = parseInt(maxDepthRaw, 10);
      includes.push({
        name: incEl.querySelector('.inc-name').value.trim(),
        path: incEl.querySelector('.inc-path').value.trim(),
        database: incEl.querySelector('.inc-database').value,
        scope: incEl.querySelector('.inc-scope').value,
        allowedPushOperations: incEl.querySelector('.inc-push-ops').value,
        maxRelativeDepth: maxDepthRaw && !isNaN(maxDepth) ? maxDepth : undefined,
        rules: rules,
        excludedFields: excludedFields
      });
    });
    return {
      namespace: document.getElementById('namespace').value.trim(),
      description: document.getElementById('description').value.trim(),
      references: Array.from(document.querySelectorAll('.reference-value'))
        .map(function(el) { return el.value.trim(); })
        .filter(function(value) { return value.length > 0; }),
      includes: includes
    };
  }

  function doSave() {
    var formData = collectData();
    if (!formData.namespace) {
      alert('Namespace is required.');
      document.getElementById('namespace').focus();
      return;
    }
    var valid = true;
    document.querySelectorAll('.inc-name, .inc-path, .rule-path, .excluded-field-id').forEach(function(el) {
      if (!el.value.trim()) { valid = false; el.style.borderColor = 'var(--danger)'; }
      else { el.style.borderColor = ''; }
    });

    if (!valid) {
      alert('Please fill in all required fields marked with *.');
      return;
    }
    var feedback = document.getElementById('feedback');
    feedback.textContent = 'Saving\u2026';
    feedback.className = 'feedback';
    vscode.postMessage({ command: 'saveModule', data: formData });
  }

  window.addEventListener('message', function(event) {
    if (event.data && event.data.command === 'saved') {
      var feedback = document.getElementById('feedback');
      feedback.textContent = 'Saved \u2713';
      feedback.className = 'feedback ok';
      setTimeout(function() { feedback.textContent = ''; }, 2500);
    }
  });
</script>
</body>
</html>`;
  }
}
