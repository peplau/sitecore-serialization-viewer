import * as vscode from 'vscode';

interface RuleJson {
  path?: string;
  scope?: string;
  alias?: string;
  allowedPushOperations?: string;
}

interface IncludeJson {
  name?: string;
  path?: string;
  database?: string;
  scope?: string;
  allowedPushOperations?: string;
  maxRelativeDepth?: number;
  rules?: RuleJson[];
}

interface ModuleFileJson {
  namespace?: string;
  description?: string;
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

interface IncludeFormData {
  name: string;
  path: string;
  database: string;
  scope: string;
  allowedPushOperations: string;
  maxRelativeDepth?: number;
  rules: RuleFormData[];
}

interface ModuleSaveData {
  namespace: string;
  description: string;
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

      return existingInclude;
    });

    const merged: ModuleFileJson = {
      ...this.rawJson,
      namespace: data.namespace,
      items: {
        ...(this.rawJson.items ?? {}),
        includes: nextIncludes
      }
    };

    if (data.description?.trim()) {
      merged.description = data.description.trim();
    } else {
      delete merged.description;
    }

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
    return JSON.stringify({
      namespace: this.rawJson.namespace ?? '',
      description: this.rawJson.description ?? '',
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
  padding: 20px;
  margin-bottom: 14px;
}
.include-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
  padding-bottom: 12px;
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
</style>
</head>
<body>
<h1>Edit Module: <span id="title-ns">${this.esc(this.rawJson.namespace ?? '')}</span></h1>

<div class="form-actions form-actions-top">
  <button type="button" id="btn-save-top" class="btn-save">Save Module</button>
</div>

<section class="card">
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
</section>

<div class="section-header">
  <h2>Includes</h2>
  <button type="button" id="btn-add-include" class="btn-secondary">+ Add Include</button>
</div>
<div id="includes-container"></div>

<div class="form-actions">
  <button type="button" id="btn-save" class="btn-save">Save Module</button>
  <span id="feedback" class="feedback"></span>
</div>

<script type="application/json" id="initial-data">${this.buildInitialDataJson()}</script>
<script>
  const vscode = acquireVsCodeApi();
  const data = JSON.parse(document.getElementById('initial-data').textContent);
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

    return '<div class="include-block" data-id="' + id + '">' +
      '<div class="include-header">' +
        '<span class="include-label">Include</span>' +
        '<button type="button" class="btn-danger-text btn-remove-include">Remove Include</button>' +
      '</div>' +
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
    '</div>';
  }

  function renderIncludes() {
    var container = document.getElementById('includes-container');
    var html = '';
    for (var i = 0; i < data.includes.length; i++) {
      html += includeHtml(i, data.includes[i]);
    }
    container.innerHTML = html;
  }

  function focusAndScroll(el) {
    if (!el) { return; }
    el.focus();
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  renderIncludes();

  document.getElementById('namespace').addEventListener('input', function() {
    document.getElementById('title-ns').textContent = this.value;
  });

  document.addEventListener('click', function(evt) {
    var target = evt.target;
    if (!(target instanceof Element)) { return; }

    if (target.classList.contains('btn-remove-include')) {
      var block = target.closest('.include-block');
      if (block) { block.remove(); }
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

    if (target.id === 'btn-add-include') {
      var container = document.getElementById('includes-container');
      var tmp = document.createElement('div');
      tmp.innerHTML = includeHtml(idCounter++, {
        name: '', path: '', database: '',
        scope: '', allowedPushOperations: '',
        maxRelativeDepth: '', rules: []
      });
      var newInclude = tmp.firstChild;
      container.appendChild(newInclude);
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
      var maxDepthRaw = incEl.querySelector('.inc-max-depth').value.trim();
      var maxDepth = parseInt(maxDepthRaw, 10);
      includes.push({
        name: incEl.querySelector('.inc-name').value.trim(),
        path: incEl.querySelector('.inc-path').value.trim(),
        database: incEl.querySelector('.inc-database').value,
        scope: incEl.querySelector('.inc-scope').value,
        allowedPushOperations: incEl.querySelector('.inc-push-ops').value,
        maxRelativeDepth: maxDepthRaw && !isNaN(maxDepth) ? maxDepth : undefined,
        rules: rules
      });
    });
    return {
      namespace: document.getElementById('namespace').value.trim(),
      description: document.getElementById('description').value.trim(),
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
    document.querySelectorAll('.inc-name, .inc-path, .rule-path').forEach(function(el) {
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
