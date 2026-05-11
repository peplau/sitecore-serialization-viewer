import * as vscode from 'vscode';
import { AuthoringGraphqlClient } from './sitecore/previewGraphqlClient';
import { SerializationConfigService } from './sitecore/serializationConfigService';
import { SitecoreItem, SerializationStatus } from './tree/models';
import { Buffer } from 'buffer';

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

interface RolePredicateJson {
  domain?: string;
  pattern?: string;
}

interface UserPredicateJson {
  domain?: string;
  pattern?: string;
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
  roles?: RolePredicateJson[];
  users?: UserPredicateJson[];
  items?: {
    includes?: IncludeJson[];
    excludedFields?: ExcludedFieldJson[];
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

interface RolePredicateFormData {
  domain: string;
  pattern: string;
}

interface UserPredicateFormData {
  domain: string;
  pattern: string;
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
  references: string[];
  roles: RolePredicateFormData[];
  users: UserPredicateFormData[];
  excludedFields: ExcludedFieldFormData[];
  includes: IncludeFormData[];
}

interface IncludeTreeLoadMessage {
  command: 'loadIncludeTree';
  requestId: string;
  includeId: string;
  includePath: string;
  includeName?: string;
  includeScope?: string;
  database?: string;
}

interface IncludeTreeChildrenMessage {
  command: 'loadIncludeTreeChildren';
  requestId: string;
  includeId: string;
  parentPath: string;
  includePath?: string;
  includeName?: string;
  includeScope?: string;
  database?: string;
}

interface IncludeRemoveRequestMessage {
  command: 'requestRemoveInclude';
  includeId: string;
}

interface OpenModuleJsonPathMessage {
  command: 'openModuleJsonPath';
}

interface OpenExplainForPathMessage {
  command: 'openExplainForPath';
  path: string;
  database?: string;
  itemId?: string;
}

interface ResolveIconMessage {
  command: 'resolveIcon';
  iconUrl: string;
}

interface IncludeTreeNodeDto {
  kind: 'database' | 'path' | 'item';
  label: string;
  path: string;
  database: string;
  hasChildren: boolean;
  status: SerializationStatus;
  yamlPath?: string;
  iconUrl?: string;
  itemId?: string;
}

interface IncludeTreeNodeWithChildrenDto extends IncludeTreeNodeDto {
  children: IncludeTreeNodeWithChildrenDto[];
}

type WebviewMessage = { command: string; data?: ModuleSaveData } | IncludeTreeLoadMessage | IncludeTreeChildrenMessage | IncludeRemoveRequestMessage | OpenModuleJsonPathMessage | OpenExplainForPathMessage | ResolveIconMessage;

export class EditModulePanel {
  private static readonly panels: Map<string, EditModulePanel> = new Map();
  private readonly panel: vscode.WebviewPanel;
  private readonly jsonFileUri: vscode.Uri;
  private readonly graphqlClient = new AuthoringGraphqlClient();
  private readonly iconCache = new Map<string, string>();
  private static readonly iconCacheMaxSize = 200;
  private rawJson: ModuleFileJson = { namespace: '' };
  private pendingRevealIncludeName: string | undefined;
  private pendingRevealRulePath: string | undefined;

  private constructor(panel: vscode.WebviewPanel, jsonFileUri: vscode.Uri) {
    this.panel = panel;
    this.jsonFileUri = jsonFileUri;

    this.panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (this.isSaveModuleMessage(message) && message.data) {
        await this.saveModule(message.data);
        return;
      }

      if (this.isLoadIncludeTreeMessage(message)) {
        await this.handleLoadIncludeTree(message);
        return;
      }

      if (this.isLoadIncludeTreeChildrenMessage(message)) {
        await this.handleLoadIncludeTreeChildren(message);
        return;
      }

      if (this.isRemoveIncludeRequestMessage(message)) {
        await this.handleRemoveIncludeRequest(message);
        return;
      }

      if (this.isOpenModuleJsonPathMessage(message)) {
        await this.openCurrentModuleJson();
        return;
      }

      if (this.isOpenExplainForPathMessage(message)) {
        await this.openExplainForPath(message);
        return;
      }

      if (this.isResolveIconMessage(message)) {
        await this.handleResolveIcon(message);
        return;
      }
    });

    this.panel.onDidDispose(() => {
      EditModulePanel.panels.delete(this.jsonFileUri.fsPath.toLowerCase());
    });
  }

  private isSaveModuleMessage(message: WebviewMessage): message is { command: 'saveModule'; data?: ModuleSaveData } {
    return message.command === 'saveModule';
  }

  // Refine type guards for message handling
  private isLoadIncludeTreeMessage(message: WebviewMessage): message is IncludeTreeLoadMessage {
    return message.command === 'loadIncludeTree';
  }

  private isLoadIncludeTreeChildrenMessage(message: WebviewMessage): message is IncludeTreeChildrenMessage {
    return message.command === 'loadIncludeTreeChildren';
  }

  private isRemoveIncludeRequestMessage(message: WebviewMessage): message is IncludeRemoveRequestMessage {
    return message.command === 'requestRemoveInclude';
  }

  private isOpenModuleJsonPathMessage(message: WebviewMessage): message is OpenModuleJsonPathMessage {
    return message.command === 'openModuleJsonPath';
  }

  private isOpenExplainForPathMessage(message: WebviewMessage): message is OpenExplainForPathMessage {
    return message.command === 'openExplainForPath';
  }

  private isResolveIconMessage(message: WebviewMessage): message is ResolveIconMessage {
    return message.command === 'resolveIcon';
  }

  private async handleResolveIcon(message: ResolveIconMessage): Promise<void> {
    const { iconUrl } = message;
    if (!iconUrl) {
      return;
    }

    if (this.iconCache.has(iconUrl)) {
      void this.panel.webview.postMessage({ command: 'iconResolved', iconUrl, dataUri: this.iconCache.get(iconUrl) });
      return;
    }

    let dataUri = await this.graphqlClient.fetchIconAsDataUri(iconUrl);
    if (!dataUri) {
      const fallbackIconUrl = this.graphqlClient.getDefaultItemIconUrl();
      if (fallbackIconUrl && fallbackIconUrl !== iconUrl) {
        dataUri = await this.graphqlClient.fetchIconAsDataUri(fallbackIconUrl);
      }
    }

    if (dataUri) {
      if (this.iconCache.size >= EditModulePanel.iconCacheMaxSize) {
        const firstKey = this.iconCache.keys().next().value;
        if (firstKey !== undefined) {
          this.iconCache.delete(firstKey);
        }
      }
      this.iconCache.set(iconUrl, dataUri);
    }

    void this.panel.webview.postMessage({ command: 'iconResolved', iconUrl, dataUri: dataUri ?? null });
  }

  private async openCurrentModuleJson(): Promise<void> {
    const document = await vscode.workspace.openTextDocument(this.jsonFileUri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async openExplainForPath(message: OpenExplainForPathMessage): Promise<void> {
    const itemPath = (message.path || '').trim();
    const itemId = (message.itemId || '').trim();
    if (!itemPath) {
      return;
    }

    this.graphqlClient.setDatabase(this.normalizeDatabase(message.database));
    let item = await this.graphqlClient.getItemByPath(itemPath);
    if (!item && itemId) {
      item = await this.graphqlClient.getItemById(itemId);
    }
    if (!item) {
      vscode.window.showWarningMessage(`Unable to resolve item for explain: ${itemPath}`);
      return;
    }

    await vscode.commands.executeCommand('sitecore-serialization-viewer.showDetails', item);
  }

  private async handleRemoveIncludeRequest(message: IncludeRemoveRequestMessage): Promise<void> {
    const removeAction = await vscode.window.showWarningMessage(
      'Are you sure you want to remove this include?',
      { modal: true },
      'Remove'
    );

    if (removeAction === 'Remove') {
      void this.panel.webview.postMessage({ command: 'removeIncludeConfirmed', includeId: message.includeId });
    }
  }

  public static async createOrShow(jsonFilePath: string, options?: { includeName?: string; rulePath?: string }): Promise<void> {
    const key = jsonFilePath.toLowerCase();
    const existing = EditModulePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      if (options?.includeName || options?.rulePath) {
        existing.panel.webview.postMessage({ command: 'revealInclude', includeName: options?.includeName, rulePath: options?.rulePath });
      }
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
    instance.pendingRevealIncludeName = options?.includeName;
    instance.pendingRevealRulePath = options?.rulePath;
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
    const existingExcludedFields = Array.isArray(this.rawJson.items?.excludedFields) ? this.rawJson.items.excludedFields : [];
    const existingRoles = Array.isArray(this.rawJson.roles) ? this.rawJson.roles : [];
    const existingUsers = Array.isArray(this.rawJson.users) ? this.rawJson.users : [];

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

      // Ensure excluded fields are persisted only at items.excludedFields (top-level sibling of includes).
      delete existingInclude.excludedFields;

      return existingInclude;
    });

    const references = Array.isArray(data.references)
      ? data.references
        .filter(reference => typeof reference === 'string')
        .map(reference => reference.trim())
        .filter(reference => reference.length > 0)
      : [];

    const description = data.description?.trim();
    const nextExcludedFields: ExcludedFieldJson[] = Array.isArray(data.excludedFields)
      ? data.excludedFields.map((field, fieldIndex) => {
        const existingField = existingExcludedFields[fieldIndex] ? { ...existingExcludedFields[fieldIndex] } : {};
        existingField.fieldID = field.fieldID.trim();
        existingField.description = field.description.trim();
        return existingField;
      })
      : [];

    const nextRoles: RolePredicateJson[] = Array.isArray(data.roles)
      ? data.roles.map((role, roleIndex) => {
        const existingRole = existingRoles[roleIndex] ? { ...existingRoles[roleIndex] } : {};
        existingRole.domain = role.domain.trim();
        existingRole.pattern = role.pattern.trim();
        return existingRole;
      })
      : [];

    const nextUsers: UserPredicateJson[] = Array.isArray(data.users)
      ? data.users.map((user, userIndex) => {
        const existingUser = existingUsers[userIndex] ? { ...existingUsers[userIndex] } : {};
        existingUser.domain = user.domain.trim();
        existingUser.pattern = user.pattern.trim();
        return existingUser;
      })
      : [];

    const {
      namespace: _existingNamespace,
      description: _existingDescription,
      references: _existingReferences,
      roles: _existingRoles,
      users: _existingUsers,
      items: existingItems,
      ...restRaw
    } = this.rawJson;

    const mergedItems: Record<string, unknown> = {
      ...(existingItems ?? {}),
      includes: nextIncludes
    };

    if (nextExcludedFields.length > 0) {
      mergedItems.excludedFields = nextExcludedFields;
    } else {
      delete mergedItems.excludedFields;
    }

    const mergedBase: ModuleFileJson = {
      namespace: data.namespace,
      ...(references.length > 0 ? { references } : {}),
      ...(description ? { description } : {}),
      ...restRaw,
      items: mergedItems
    };

    let merged: ModuleFileJson = mergedBase;
    if (nextRoles.length > 0) {
      merged = { ...merged, roles: nextRoles };
    }
    if (nextUsers.length > 0) {
      merged = { ...merged, users: nextUsers };
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

  private normalizeDatabase(database?: string): string {
    return (database || '').trim() || 'master';
  }

  private getPathNodeLabel(pathValue: string): string {
    const normalized = (pathValue || '').trim();
    if (!normalized) {
      return '/';
    }

    return normalized;
  }

  private normalizeIncludeName(includeName: string | undefined): string {
    return (includeName || '').trim().toLowerCase();
  }

  private normalizePath(pathValue: string | undefined): string {
    return (pathValue || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  private isPathInIncludeScope(itemPath: string | undefined, includePath: string | undefined, includeScope: string | undefined): boolean {
    const normalizedItemPath = this.normalizePath(itemPath);
    const normalizedIncludePath = this.normalizePath(includePath);

    if (!normalizedItemPath || !normalizedIncludePath) {
      return false;
    }

    if (normalizedItemPath === normalizedIncludePath) {
      return true;
    }

    const normalizedScope = (includeScope || '').trim().toLowerCase();
    if (normalizedScope === 'singleitem') {
      return false;
    }

    // Keep behavior aligned with SerializationConfigService scope handling.
    if (normalizedScope === 'itemandchildren' || normalizedScope === 'itemanddescendants' || normalizedScope === 'descendantsonly' || normalizedScope === '') {
      return normalizedItemPath.startsWith(normalizedIncludePath + '/');
    }

    return false;
  }

  private getIncludeScopedStatus(item: SitecoreItem, includePath?: string, includeScope?: string): SerializationStatus {
    const normalizedIncludePath = this.normalizePath(includePath);
    if (!normalizedIncludePath) {
      return item.status;
    }

    const normalizedItemPath = this.normalizePath(item.path);
    const normalizedScope = (includeScope || '').trim().toLowerCase();

    if (normalizedItemPath === normalizedIncludePath) {
      // DescendantsOnly: root path itself is NOT serialized
      if (normalizedScope === 'descendantsonly') {
        return SerializationStatus.NotSerialized;
      }
      return SerializationStatus.Direct;
    }

    const suffix = normalizedItemPath.slice(normalizedIncludePath.length);
    const isDescendant = suffix.startsWith('/');
    if (!isDescendant) {
      return SerializationStatus.NotSerialized;
    }

    if (normalizedScope === 'singleitem' || normalizedScope === 'ignored') {
      return SerializationStatus.NotSerialized;
    }

    // ItemAndChildren: only direct children (suffix has exactly one more path segment)
    if (normalizedScope === 'itemandchildren') {
      const isDirectChild = !suffix.slice(1).includes('/');
      return isDirectChild ? SerializationStatus.Indirect : SerializationStatus.NotSerialized;
    }

    // DescendantsOnly: root itself is not serialized, descendants are
    if (normalizedScope === 'descendantsonly') {
      return SerializationStatus.Indirect;
    }

    // ItemAndDescendants (or empty/default): all descendants are indirect
    return SerializationStatus.Indirect;
  }

  private isItemSerializedByInclude(item: SitecoreItem, includeName: string | undefined, includePath?: string, includeDatabase?: string, includeScope?: string): boolean {
    if (this.getIncludeScopedStatus(item, includePath, includeScope) !== SerializationStatus.NotSerialized) {
      return true;
    }

    if (item.status !== SerializationStatus.Direct && item.status !== SerializationStatus.Indirect) {
      return false;
    }

    const normalizedIncludeName = this.normalizeIncludeName(includeName);
    const normalizedIncludePath = this.normalizePath(includePath);
    if (!normalizedIncludeName && !normalizedIncludePath) {
      return item.status === SerializationStatus.Direct || item.status === SerializationStatus.Indirect;
    }

    const serializationService = SerializationConfigService.getInstance();

    if (item.matchedModule && normalizedIncludeName) {
      const includeInfo = serializationService.getIncludeInfo(item.matchedModule, includeName);
      const includeDb = (includeInfo?.database || '').trim().toLowerCase();
      const selectedDb = (includeDatabase || '').trim().toLowerCase();
      const dbMatches = !includeDb || !selectedDb || includeDb === selectedDb;
      if (dbMatches && includeInfo && this.isPathInIncludeScope(item.path, includeInfo.path, includeInfo.scope)) {
        return true;
      }
    }

    if (normalizedIncludePath && this.isPathInIncludeScope(item.path, includePath, item.subtreeScope)) {
      const normalizedSubtreePath = this.normalizePath(item.subtreePath);
      if (!normalizedSubtreePath || normalizedSubtreePath === normalizedIncludePath) {
        return true;
      }
    }

    const inferredFromYaml = serializationService.inferIncludeFromYamlPath(item.yamlPath);
    const normalizedSubtreeKey = this.normalizeIncludeName(item.subtreeKey);
    const normalizedInferredInclude = this.normalizeIncludeName(inferredFromYaml);

    return normalizedSubtreeKey === normalizedIncludeName || normalizedInferredInclude === normalizedIncludeName;
  }

  private mapTreeNode(item: SitecoreItem, database: string, includeName?: string, includePath?: string, includeScope?: string): IncludeTreeNodeDto {
    let includeScopedStatus: SerializationStatus;

    if (includePath) {
      // Include path is known: only color if item was enriched (in this module's includes)
      if (item.yamlPath) {
        // Item is in this module's includes → use scope calculation
        includeScopedStatus = this.getIncludeScopedStatus(item, includePath, includeScope);
      } else {
        // Item is not in this module's includes yet → gray
        includeScopedStatus = SerializationStatus.NotSerialized;
      }
    } else {
      // No include path available – fall back to name/yaml-inference matching.
      includeScopedStatus = this.isItemSerializedByInclude(item, includeName, includePath, database, includeScope)
        ? item.status
        : SerializationStatus.NotSerialized;
    }

    return {
      kind: 'item',
      label: item.name,
      path: item.path,
      database,
      hasChildren: item.hasChildren,
      status: includeScopedStatus,
      yamlPath: item.yamlPath,
      iconUrl: item.iconUrl,
      itemId: item.id
    };
  }

  private async buildIncludeTreeNode(
    item: SitecoreItem,
    database: string,
    includeName: string | undefined,
    includePath: string | undefined,
    includeScope: string | undefined,
    visitedPaths: Set<string>
  ): Promise<IncludeTreeNodeWithChildrenDto> {
    // Enrich item only if it's in this module's includes list
    const includes = Array.isArray(this.rawJson.items?.includes) ? this.rawJson.items.includes : [];
    const normalizedItemPath = this.normalizePath(item.path);
    
    for (const inc of includes) {
      const normalizedIncludePath = this.normalizePath(inc.path);
      if (normalizedItemPath === normalizedIncludePath || 
          normalizedItemPath.startsWith(normalizedIncludePath + '/')) {
        // Item is in THIS module's includes → enrich from config
        const configService = SerializationConfigService.getInstance();
        const match = configService.checkSerializationStatus(item.path);
        if (match) {
          item.status = match.status;
          item.matchedModule = match.moduleName;
          item.yamlPath = match.yamlPath;
        }
        break;
      }
    }

    const node = this.mapTreeNode(item, database, includeName, includePath, includeScope);
    const normalizedPath = item.path.toLowerCase();

    if (visitedPaths.has(normalizedPath)) {
      return {
        ...node,
        hasChildren: false,
        children: []
      };
    }

    visitedPaths.add(normalizedPath);

    let children: IncludeTreeNodeWithChildrenDto[] = [];
    if (item.hasChildren) {
      try {
        const rawChildren: SitecoreItem[] = await this.graphqlClient.getChildren(item.path);
        children = await Promise.all(rawChildren.map((child: SitecoreItem) => this.buildIncludeTreeNode(child, database, includeName, includePath, includeScope, visitedPaths)));
      } catch (error) {
        // Keep rendering the rest of the tree if a single branch cannot be expanded.
        console.warn(`Unable to load children for ${item.path}:`, error);
        children = [];
      }
    }

    return {
      ...node,
      hasChildren: children.length > 0,
      children
    };
  }

  private async buildIncludeTreeChildren(path: string, database: string, includeName: string | undefined, includePath?: string, includeScope?: string): Promise<IncludeTreeNodeWithChildrenDto[]> {
    const visitedPaths = new Set<string>();
    const children: SitecoreItem[] = await this.graphqlClient.getChildren(path);
    return Promise.all(children.map((item: SitecoreItem) => this.buildIncludeTreeNode(item, database, includeName, includePath, includeScope, visitedPaths)));
  }

  private async handleLoadIncludeTree(message: IncludeTreeLoadMessage): Promise<void> {
    const requestId = message.requestId;
    const includeId = message.includeId;
    const includePath = (message.includePath || '').trim();
    const includeName = (message.includeName || '').trim();
    const includeScope = (message.includeScope || '').trim();
    const database = this.normalizeDatabase(message.database);

    if (!includePath) {
      void this.panel.webview.postMessage({
        command: 'includeTreeLoaded',
        requestId,
        includeId,
        error: 'Include path is required.'
      });
      return;
    }

    try {
      this.graphqlClient.setDatabase(database);
      const includeRootItem = await this.graphqlClient.getItemByPath(includePath);
      let includeRootNode: IncludeTreeNodeWithChildrenDto | undefined;
      let children: IncludeTreeNodeWithChildrenDto[] = [];

      if (includeRootItem) {
        includeRootNode = await this.buildIncludeTreeNode(includeRootItem, database, includeName, includePath, includeScope, new Set<string>());
      } else {
        // Fallback for paths that cannot be resolved as an item.
        children = await this.buildIncludeTreeChildren(includePath, database, includeName, includePath, includeScope);
      }

      const root: IncludeTreeNodeDto = {
        kind: 'database',
        label: database,
        path: `db:${database}`,
        database,
        hasChildren: true,
        status: SerializationStatus.NotSerialized
      };

      const includePathNode: IncludeTreeNodeDto = {
        kind: 'path',
        label: this.getPathNodeLabel(includePath),
        path: includePath,
        database,
        hasChildren: true,
        status: SerializationStatus.NotSerialized
      };

      void this.panel.webview.postMessage({
        command: 'includeTreeLoaded',
        requestId,
        includeId,
        root,
        includePathNode,
        includeRootNode,
        children
      });
    } catch (error) {
      void this.panel.webview.postMessage({
        command: 'includeTreeLoaded',
        requestId,
        includeId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleLoadIncludeTreeChildren(message: IncludeTreeChildrenMessage): Promise<void> {
    const requestId = message.requestId;
    const includeId = message.includeId;
    const parentPath = (message.parentPath || '').trim();
    const includePath = (message.includePath || '').trim();
    const includeName = (message.includeName || '').trim();
    const includeScope = (message.includeScope || '').trim();
    const database = this.normalizeDatabase(message.database);

    if (!parentPath) {
      void this.panel.webview.postMessage({
        command: 'includeTreeChildrenLoaded',
        requestId,
        includeId,
        parentPath,
        children: []
      });
      return;
    }

    try {
      this.graphqlClient.setDatabase(database);
      const children: SitecoreItem[] = await this.graphqlClient.getChildren(parentPath);
      console.log(`Tree children loaded for ${parentPath}: ${children.length} children`);

      void this.panel.webview.postMessage({
        command: 'includeTreeChildrenLoaded',
        requestId,
        includeId,
        parentPath,
        children: children.map(item => this.mapTreeNode(item, database, includeName, includePath, includeScope))
      });
    } catch (error) {
      console.error(`Error loading tree children for ${parentPath}:`, error);
      void this.panel.webview.postMessage({
        command: 'includeTreeChildrenLoaded',
        requestId,
        includeId,
        parentPath,
        error: error instanceof Error ? error.message : String(error)
      });
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
    const excludedFields = Array.isArray(this.rawJson.items?.excludedFields)
      ? this.rawJson.items.excludedFields
      : includes.flatMap(inc => Array.isArray(inc.excludedFields) ? inc.excludedFields : []);
    const references = Array.isArray(this.rawJson.references)
      ? this.rawJson.references
        .filter(reference => typeof reference === 'string')
        .map(reference => reference.trim())
        .filter(reference => reference.length > 0)
      : [];
    const roles = Array.isArray(this.rawJson.roles) ? this.rawJson.roles : [];
    const users = Array.isArray(this.rawJson.users) ? this.rawJson.users : [];

    return JSON.stringify({
      namespace: this.rawJson.namespace ?? '',
      description: this.rawJson.description ?? '',
      references,
      roles: roles.map(role => ({
        domain: role.domain ?? '',
        pattern: role.pattern ?? ''
      })),
      users: users.map(user => ({
        domain: user.domain ?? '',
        pattern: user.pattern ?? ''
      })),
      excludedFields: excludedFields.map(field => ({
        fieldID: field.fieldID ?? '',
        description: field.description ?? ''
      })),
      includes: includes.map(inc => ({
        isSaved: true,
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
    const initialRevealIncludeNameJson = JSON.stringify(this.pendingRevealIncludeName ?? '');
    const initialRevealRulePathJson = JSON.stringify(this.pendingRevealRulePath ?? '');
    const moduleJsonPathEscaped = this.esc(this.jsonFileUri.fsPath);
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
  margin-bottom: 14px;
}
.include-group {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
}
.include-card {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
}
.include-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 0;
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--card-border) 60%, transparent);
  gap: 12px;
}
.include-title-section {
  display: flex;
  flex-direction: column;
  flex: 1;
}
.include-drag-handle {
  cursor: grab;
}
.include-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.include-label {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.include-quick-info {
  display: none;
  font-size: 0.85rem;
  color: var(--vscode-descriptionForeground, #999);
  margin-top: 4px;
  line-height: 1.3;
  word-break: break-word;
}
.include-block.collapsed .include-quick-info {
  display: block;
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
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.expand-collapse-left {
  display: flex;
  align-items: center;
  gap: 12px;
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
.include-tree-controls {
  display: none;
}
.include-tree-bar {
  display: flex;
  align-items: center;
  margin: 6px 0 0;
  padding: 6px 10px;
  background: var(--vscode-editor-background);
  border: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
  border-radius: 10px;
}
.include-tree-bar.is-open {
  display: block;
  padding: 10px 12px 12px;
}
.include-tree-bar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.include-content {
  padding: 14px;
}
.include-block.dragging {
  opacity: 0.65;
}
.include-block.drop-before .include-card {
  box-shadow: inset 0 3px 0 0 var(--accent);
}
.include-block.drop-after .include-card {
  box-shadow: inset 0 -3px 0 0 var(--accent);
}
.include-block.drop-before .include-group {
  box-shadow: inset 0 3px 0 0 var(--accent);
}
.include-block.drop-after .include-group {
  box-shadow: inset 0 -3px 0 0 var(--accent);
}
.excluded-fields-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 14px;
  position: relative;
}
.roles-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 14px;
  position: relative;
}
.roles-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--card-border) 50%, transparent);
}
.roles-section { margin-top: 20px; }
.roles-container {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.role-block {
  background: color-mix(in srgb, var(--vscode-editor-background) 75%, var(--card-bg) 25%);
  border: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  border-radius: 8px;
  padding: 14px;
}
.role-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.role-field { display: flex; flex-direction: column; gap: 5px; }
.role-remove-row {
  grid-column: span 2;
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}
.helper-text {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
}
.include-tree-toggle {
  align-items: center;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--danger) 60%, transparent);
  border-radius: 6px;
  color: var(--danger);
  cursor: pointer;
  display: inline-flex;
  font-size: 12px;
  gap: 6px;
  height: auto;
  justify-content: center;
  padding: 4px 10px;
  transition: background-color 120ms ease, color 120ms ease;
  width: auto;
}
.include-tree-toggle:hover {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
.include-tree-toggle.is-active {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}
.include-tree-toggle-icon {
  height: 12px;
  width: 12px;
}
.include-tree-panel {
  background: transparent;
  border: none;
  border-radius: 0;
  margin: 0;
  padding: 0;
}
.include-tree-toolbar {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: flex-start;
  margin-bottom: 8px;
}
.include-tree-refresh {
  text-align: left;
  width: auto;
}
.include-tree-root {
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border: 1px solid color-mix(in srgb, var(--vscode-sideBar-border, var(--border)) 70%, transparent);
  border-radius: 8px;
  max-height: 360px;
  overflow: auto;
  padding: 8px;
}
.include-tree-list {
  list-style: none;
  margin: 0;
  padding-left: 16px;
}
.include-tree-list.root-level {
  padding-left: 0;
}
.include-tree-node {
  margin: 0;
}
.include-tree-node-row {
  align-items: center;
  display: flex;
  gap: 5px;
  min-height: 22px;
  padding: 0 4px;
  border-radius: 4px;
}
.include-tree-node-row:hover {
  background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
}
.include-tree-node-toggle {
  background: transparent;
  border: none;
  border-radius: 0;
  color: var(--vscode-icon-foreground, var(--text));
  cursor: pointer;
  font-size: 11px;
  height: 16px;
  line-height: 1;
  padding: 0;
  width: 16px;
}
.include-tree-node-spacer {
  display: inline-block;
  height: 16px;
  width: 16px;
}
.include-tree-node-label {
  align-items: center;
  color: var(--vscode-list-foreground, var(--text));
  display: inline-flex;
  font-size: 13px;
  gap: 5px;
}
.include-tree-node-label.is-clickable {
  cursor: pointer;
}
.include-tree-node-label.is-clickable:hover {
  text-decoration: underline;
}
.include-tree-node-icon-wrap {
  align-items: center;
  display: inline-flex;
  height: 16px;
  justify-content: center;
  width: 16px;
}
.include-tree-node-icon {
  height: 16px;
  width: 16px;
}
.include-tree-node-sitecore-icon {
  display: block;
  height: 16px;
  width: 16px;
}
.include-tree-node-label.status-direct,
.include-tree-node-label.status-indirect,
.include-tree-node-label.status-untracked,
.include-tree-node-label.status-not-serialized,
.include-tree-node-label.status-loading,
.include-tree-node-label.node-kind-database,
.include-tree-node-label.node-kind-path {
  color: var(--vscode-list-foreground, var(--text));
}
.include-tree-node-icon-wrap .include-tree-node-icon {
  color: var(--vscode-symbolIcon-folderForeground, var(--vscode-list-foreground, var(--text)));
}
.include-tree-node-icon-wrap.status-direct .include-tree-node-icon {
  color: var(--vscode-charts-orange, #ce9178);
}
.include-tree-node-icon-wrap.status-indirect .include-tree-node-icon {
  color: var(--vscode-charts-yellow, #dcdcaa);
}
.include-tree-node-icon-wrap.status-not-serialized .include-tree-node-sitecore-icon,
.include-tree-node-icon-wrap.status-untracked .include-tree-node-sitecore-icon,
.include-tree-node-icon-wrap.status-loading .include-tree-node-sitecore-icon {
  filter: grayscale(1);
  opacity: 0.55;
}
.include-tree-node-icon-wrap.status-untracked .include-tree-node-icon,
.include-tree-node-icon-wrap.status-not-serialized .include-tree-node-icon,
.include-tree-node-icon-wrap.status-loading .include-tree-node-icon {
  color: var(--vscode-disabledForeground, #8c8c8c);
}
.include-tree-node-label.node-kind-item.status-not-serialized,
.include-tree-node-label.node-kind-item.status-untracked,
.include-tree-node-label.node-kind-item.status-loading {
  color: var(--vscode-disabledForeground, #8c8c8c);
}
.include-tree-node-icon-wrap.node-kind-path .include-tree-node-icon {
  color: var(--vscode-charts-orange, #ce9178);
}
.include-tree-node-icon-wrap.node-kind-database .include-tree-node-icon {
  color: var(--vscode-testing-iconPassed, #73c991);
}
.include-tree-root-empty {
  color: var(--muted);
  font-size: 12px;
  padding: 4px 0;
}
.module-json-path-wrap {
  margin: -12px 0 16px;
}
.module-json-path-link {
  color: var(--vscode-textLink-foreground, #3794ff);
  cursor: pointer;
  text-decoration: none;
  word-break: break-all;
}
.module-json-path-link:hover {
  text-decoration: underline;
}
</style>
</head>
<body>
<h1>Edit Module: <span id="title-ns">${this.esc(this.rawJson.namespace ?? '')}</span></h1>
<div class="module-json-path-wrap">
  <a href="#" id="module-json-path-link" class="module-json-path-link">${moduleJsonPathEscaped}</a>
</div>

<nav class="nav-links">
  <div class="nav-links-left">
    <button type="button" class="nav-btn" id="nav-module">Module</button>
    <button type="button" class="nav-btn" id="nav-includes">Includes</button>
    <button type="button" class="nav-btn" id="nav-excluded-fields">Excluded Fields</button>
    <button type="button" class="nav-btn" id="nav-roles">Roles</button>
    <button type="button" class="nav-btn" id="nav-users">Users</button>
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
</div>
<div class="expand-collapse-buttons">
  <div class="expand-collapse-left">
    <button type="button" id="btn-expand-all" class="expand-collapse-btn">Expand All</button>
    <button type="button" id="btn-collapse-all" class="expand-collapse-btn">Collapse All</button>
  </div>
  <button type="button" id="btn-add-include" class="expand-collapse-btn">+ Add Include</button>
</div>
<div id="includes-container"></div>

<div id="section-excluded-fields">
  <div class="section-header">
    <h2>Excluded Fields</h2>
  </div>
  <div id="excluded-fields-container"></div>
</div>

<div id="section-roles">
  <div class="section-header">
    <h2>Roles</h2>
  </div>
  <div id="roles-container"></div>
</div>

<div id="section-users">
  <div class="section-header">
    <h2>Users</h2>
  </div>
  <div id="users-container"></div>
</div>

<div class="form-actions">
  <button type="button" id="btn-save" class="btn-save">Save Module</button>
  <span id="feedback" class="feedback"></span>
</div>

<script type="application/json" id="initial-data">${this.buildInitialDataJson()}</script>
<script>
  const vscode = acquireVsCodeApi();
  const initialRevealIncludeName = ${initialRevealIncludeNameJson};
  const initialRevealRulePath = ${initialRevealRulePathJson};
  const data = JSON.parse(document.getElementById('initial-data').textContent);
  data.references = Array.isArray(data.references) ? data.references : [];
  data.roles = Array.isArray(data.roles) ? data.roles : [];
  data.users = Array.isArray(data.users) ? data.users : [];
  data.excludedFields = Array.isArray(data.excludedFields) ? data.excludedFields : [];
  let idCounter = data.includes.length;
  let draggedInclude = null;
  let includeTreeRequestCounter = 0;
  var resolvedIconCache = new Map(); // iconUrl -> dataUri or 'pending'

  function nextIncludeTreeRequestId() {
    includeTreeRequestCounter += 1;
    return 'include-tree-' + includeTreeRequestCounter;
  }

  function getStatusClass(node) {
    if (!node || !node.status) {
      return 'status-not-serialized';
    }

    if (node.status === 'direct') {
      return 'status-direct';
    }

    if (node.status === 'indirect') {
      return 'status-indirect';
    }

    if (node.status === 'untracked') {
      return 'status-untracked';
    }

    return 'status-not-serialized';
  }

  function getNodeIconMarkup(node) {
    if (node.kind === 'database') {
      return '<svg viewBox="0 0 16 16" class="include-tree-node-icon" aria-hidden="true"><ellipse cx="8" cy="3" rx="4.5" ry="1.8" fill="none" stroke="currentColor" stroke-width="1.2"></ellipse><path d="M3.5 3V6.2C3.5 7.2 5.5 8 8 8C10.5 8 12.5 7.2 12.5 6.2V3" fill="none" stroke="currentColor" stroke-width="1.2"></path><ellipse cx="8" cy="8" rx="4.5" ry="1.8" fill="none" stroke="currentColor" stroke-width="1.2"></ellipse><path d="M3.5 8V11.2C3.5 12.2 5.5 13 8 13C10.5 13 12.5 12.2 12.5 11.2V8" fill="none" stroke="currentColor" stroke-width="1.2"></path><ellipse cx="8" cy="13" rx="4.5" ry="1.8" fill="none" stroke="currentColor" stroke-width="1.2"></ellipse></svg>';
    }

    if (node.kind === 'item' && node.iconUrl) {
      return '<img data-icon-url="' + esc(node.iconUrl) + '" class="include-tree-node-sitecore-icon" alt="">';
    }

    var isFolder = node.kind === 'database' || node.kind === 'path' || !!node.hasChildren;
    if (isFolder) {
      return '<svg viewBox="0 0 16 16" class="include-tree-node-icon icon-folder" aria-hidden="true"><path d="M1.5 4H6L7.4 5.5H14.5V12.5H1.5V4Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"></path></svg>';
    }

    return '<svg viewBox="0 0 16 16" class="include-tree-node-icon icon-file" aria-hidden="true"><path d="M3 1.5H9.7L13 4.8V14.5H3V1.5Z" fill="none" stroke="currentColor" stroke-width="1.2"></path><path d="M9.7 1.5V4.8H13" fill="none" stroke="currentColor" stroke-width="1.2"></path></svg>';
  }

  function createNodeElement(node, includeId, database, expandedByDefault) {
    var li = document.createElement('li');
    li.className = 'include-tree-node';
    li.dataset.nodePath = node.path;
    li.dataset.nodeId = node.itemId || '';
    li.dataset.nodeKind = node.kind;
    li.dataset.hasChildren = node.hasChildren ? 'true' : 'false';
    li.dataset.includeId = includeId;
    li.dataset.database = database;
    var hasPreloadedChildren = Array.isArray(node.children);
    li.dataset.loadedChildren = hasPreloadedChildren || expandedByDefault ? 'true' : 'false';

    var row = document.createElement('div');
    row.className = 'include-tree-node-row';

    if (node.hasChildren) {
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'include-tree-node-toggle';
      toggle.textContent = expandedByDefault ? '▾' : '▸';
      toggle.setAttribute('aria-label', expandedByDefault ? 'Collapse tree node' : 'Expand tree node');
      row.appendChild(toggle);
    } else {
      var spacer = document.createElement('span');
      spacer.className = 'include-tree-node-spacer';
      row.appendChild(spacer);
    }

    var statusClass = getStatusClass(node);
    var label = document.createElement('span');
    label.className = 'include-tree-node-label ' + statusClass + ' node-kind-' + node.kind;
    label.innerHTML = '<span class="include-tree-node-icon-wrap ' + statusClass + ' node-kind-' + node.kind + '">' + getNodeIconMarkup(node) + '</span><span>' + esc(node.label) + '</span>';
    if (node.kind === 'item') {
      label.classList.add('is-clickable');
      label.title = 'Open Explain';
    }
    row.appendChild(label);
    li.appendChild(row);

    if (node.hasChildren) {
      var childrenList = document.createElement('ul');
      childrenList.className = 'include-tree-list';
      if (!expandedByDefault) {
        childrenList.hidden = true;
      }

      if (hasPreloadedChildren) {
        node.children.forEach(function(childNode) {
          childrenList.appendChild(createNodeElement(childNode, includeId, database, expandedByDefault));
        });
      }

      li.appendChild(childrenList);
    }

    if (node.kind === 'item' && node.iconUrl) {
      var cachedDataUri = resolvedIconCache.get(node.iconUrl);
      if (cachedDataUri && cachedDataUri !== 'pending') {
        var imgEl = li.querySelector('.include-tree-node-sitecore-icon[data-icon-url]');
        if (imgEl) {
          imgEl.src = cachedDataUri;
        }
      } else if (!cachedDataUri) {
        resolvedIconCache.set(node.iconUrl, 'pending');
        vscode.postMessage({ command: 'resolveIcon', iconUrl: node.iconUrl });
      }
    }

    return li;
  }

  function setIncludeTreeStatus(panel, text, isError) {
    if (!panel) {
      return;
    }

    var statusEl = panel.querySelector('.include-tree-status');
    if (!statusEl) {
      return;
    }

    statusEl.textContent = text;
    statusEl.style.color = isError ? 'var(--danger)' : '';
  }

  function getIncludeBlockById(includeId) {
    return document.querySelector('.include-block[data-id="' + includeId + '"]');
  }

  function getIncludeTreePanel(includeBlock) {
    return includeBlock ? includeBlock.querySelector('.include-tree-panel') : null;
  }

  function getIncludeTreeBar(includeBlock) {
    return includeBlock ? includeBlock.querySelector('.include-tree-bar') : null;
  }

  function getIncludeTreeRoot(includePanel) {
    return includePanel ? includePanel.querySelector('.include-tree-root') : null;
  }

  function loadIncludeTree(includeBlock, forceRefresh) {
    if (!includeBlock) {
      return;
    }

    var panel = getIncludeTreePanel(includeBlock);
    if (!panel) {
      return;
    }

    var includePathInput = includeBlock.querySelector('.inc-path');
    var includeNameInput = includeBlock.querySelector('.inc-name');
    var includeScopeSelect = includeBlock.querySelector('.inc-scope');
    var includeDbSelect = includeBlock.querySelector('.inc-database');
    var includeId = includeBlock.getAttribute('data-id') || '';
    var includePath = includePathInput ? String(includePathInput.value || '').trim() : '';
    var includeName = includeNameInput ? String(includeNameInput.value || '').trim() : '';
    var includeScope = includeScopeSelect ? String(includeScopeSelect.value || '').trim() : '';
    var includeDatabase = includeDbSelect ? String(includeDbSelect.value || '').trim() : '';
    var database = includeDatabase || 'master';

    if (!includePath) {
      var rootMissingPath = getIncludeTreeRoot(panel);
      if (rootMissingPath) {
        rootMissingPath.innerHTML = '<div class="include-tree-root-empty">Include path is required to build the tree.</div>';
      }
      setIncludeTreeStatus(panel, 'Cannot load tree until include path is set.', true);
      return;
    }

    if (!forceRefresh && panel.dataset.loaded === 'true') {
      return;
    }

    var requestId = nextIncludeTreeRequestId();
    panel.dataset.requestId = requestId;
    panel.dataset.loaded = 'false';

    var root = getIncludeTreeRoot(panel);
    if (root) {
      root.innerHTML = '<div class="include-tree-root-empty">Loading tree...</div>';
    }

    vscode.postMessage({
      command: 'loadIncludeTree',
      requestId: requestId,
      includeId: includeId,
      includePath: includePath,
      includeName: includeName,
      includeScope: includeScope,
      database: database
    });
  }

  function loadIncludeTreeChildren(includeBlock, nodeElement) {
    if (!includeBlock || !nodeElement) {
      return;
    }

    if (nodeElement.dataset.loadedChildren === 'true') {
      return;
    }

    var panel = getIncludeTreePanel(includeBlock);
    if (!panel) {
      return;
    }

    var includeId = includeBlock.getAttribute('data-id') || '';
    var includePathInput = includeBlock.querySelector('.inc-path');
    var includeNameInput = includeBlock.querySelector('.inc-name');
    var includeScopeSelect = includeBlock.querySelector('.inc-scope');
    var includePath = includePathInput ? String(includePathInput.value || '').trim() : '';
    var includeName = includeNameInput ? String(includeNameInput.value || '').trim() : '';
    var includeScope = includeScopeSelect ? String(includeScopeSelect.value || '').trim() : '';
    var parentPath = nodeElement.dataset.nodePath || '';
    var database = nodeElement.dataset.database || 'master';
    var requestId = nextIncludeTreeRequestId();
    nodeElement.dataset.childrenRequestId = requestId;

    var childrenList = nodeElement.querySelector(':scope > .include-tree-list');
    if (childrenList) {
      childrenList.innerHTML = '<li class="include-tree-node"><div class="include-tree-node-row"><span class="include-tree-node-spacer"></span><span class="include-tree-node-label status-loading">Loading...</span></div></li>';
    }

    vscode.postMessage({
      command: 'loadIncludeTreeChildren',
      requestId: requestId,
      includeId: includeId,
      parentPath: parentPath,
      includePath: includePath,
      includeName: includeName,
      includeScope: includeScope,
      database: database
    });
  }

  function renderIncludeTree(includeId, payload) {
    var includeBlock = getIncludeBlockById(includeId);
    if (!includeBlock) {
      return;
    }

    var panel = getIncludeTreePanel(includeBlock);
    if (!panel) {
      return;
    }

    if (panel.dataset.requestId !== payload.requestId) {
      return;
    }

    var root = getIncludeTreeRoot(panel);
    if (!root) {
      return;
    }

    if (payload.error) {
      root.innerHTML = '<div class="include-tree-root-empty">Unable to load tree: ' + esc(payload.error) + '</div>';
      setIncludeTreeStatus(panel, payload.error, true);
      return;
    }

    root.innerHTML = '';
    var rootList = document.createElement('ul');
    rootList.className = 'include-tree-list root-level';
    var dbNode = createNodeElement(payload.root, includeId, payload.root.database, true);
    var dbChildrenList = dbNode.querySelector(':scope > .include-tree-list');

    if (dbChildrenList) {
      if (payload.includeRootNode) {
        dbChildrenList.appendChild(createNodeElement(payload.includeRootNode, includeId, payload.root.database, true));
      } else {
        var childNodes = Array.isArray(payload.children) ? payload.children : [];
        if (childNodes.length > 0) {
          childNodes.forEach(function(childNode) {
            dbChildrenList.appendChild(createNodeElement(childNode, includeId, payload.root.database, true));
          });
        }
      }
    }

    rootList.appendChild(dbNode);
    root.appendChild(rootList);
    panel.dataset.loaded = 'true';
  }

  function renderIncludeTreeChildren(includeId, payload) {
    var includeBlock = getIncludeBlockById(includeId);
    if (!includeBlock) {
      return;
    }

    var nodeElement = null;
    includeBlock.querySelectorAll('.include-tree-node').forEach(function(candidate) {
      if (!nodeElement && candidate.dataset.nodePath === payload.parentPath) {
        nodeElement = candidate;
      }
    });
    if (!nodeElement) {
      return;
    }

    if (nodeElement.dataset.childrenRequestId !== payload.requestId) {
      return;
    }

    var panel = getIncludeTreePanel(includeBlock);
    var childrenList = nodeElement.querySelector(':scope > .include-tree-list');
    if (!childrenList) {
      return;
    }

    if (payload.error) {
      childrenList.innerHTML = '<li class="include-tree-node"><div class="include-tree-node-row"><span class="include-tree-node-spacer"></span><span class="include-tree-node-label status-not-serialized">Error: Unable to load children.</span></div></li>';
      if (panel) {
        setIncludeTreeStatus(panel, 'Error loading children for ' + payload.parentPath + ': ' + payload.error, true);
      }
      console.warn('Tree children error for ' + payload.parentPath + ':', payload.error);
      return;
    }

    childrenList.innerHTML = '';
    var childNodes = Array.isArray(payload.children) ? payload.children : [];
    if (childNodes.length > 0) {
      var database = nodeElement.dataset.database || 'master';
      childNodes.forEach(function(childNode) {
        childrenList.appendChild(createNodeElement(childNode, includeId, database, false));
      });
    } else {
      // No children returned - could be expected (empty folder) or could indicate a problem
      childrenList.innerHTML = '<li class="include-tree-node"><div class="include-tree-node-row"><span class="include-tree-node-spacer"></span><span class="include-tree-node-label status-not-serialized">(No children)</span></div></li>';
      console.log('No children returned for ' + payload.parentPath);
    }

    nodeElement.dataset.loadedChildren = 'true';
    if (panel) {
      setIncludeTreeStatus(panel, 'Tree updated.', false);
    }
  }

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

    return '<div class="rule-block" data-rule-path="' + esc(rule.path || '') + '">' +
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
    var showTreeToggle = !!inc.isSaved;
    var treeToggleHtml = showTreeToggle
      ? '<button type="button" class="include-tree-toggle" title="Show include content tree" aria-pressed="false">' +
          '<svg class="include-tree-toggle-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<circle cx="4" cy="3" r="1.5" fill="currentColor"></circle>' +
            '<circle cx="12" cy="8" r="1.5" fill="currentColor"></circle>' +
            '<circle cx="4" cy="13" r="1.5" fill="currentColor"></circle>' +
            '<path d="M5.5 3H8.5V8H10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
            '<path d="M5.5 13H8.5V8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
          '</svg>' +
          '<span>Show Tree</span>' +
        '</button>'
      : '';

    var treePanelHtml = showTreeToggle
      ? '<div class="include-tree-bar">' +
          treeToggleHtml +
        '</div>'
      : '';

    var treeControlsHtml = ''; // kept for backward compat, no longer used in markup

      return '<div class="include-block collapsed" data-id="' + id + '" data-include-name="' + esc(inc.name || '') + '" data-scope="' + esc(inc.scope || '') + '" data-path="' + esc(inc.path || '') + '" data-database="' + esc(inc.database || '') + '">' +
        '<div class="include-group">' +
          '<div class="include-card">' +
            '<div class="include-header">' +
              '<div class="include-title-section include-drag-handle" draggable="true">' +
                '<div class="include-title-row">' +
                  '<button type="button" class="include-toggle">▶</button>' +
                  '<span class="include-name-display">' + esc(inc.name || '(Unnamed)') + '</span>' +
                '</div>' +
                '<div class="include-quick-info">' + getIncludeQuickInfoText(inc.scope, inc.path, inc.database) + '</div>' +
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
          '</div>' +
        '</div>' +
        treePanelHtml +
      '</div>';
  }

  function getIncludeQuickInfoText(scope, path, database) {
    var parts = [];
    var effectiveScope = scope || 'ItemAndDescendants';
    parts.push('[' + esc(effectiveScope) + ']');
    var dbPath = '';
    if (database || path) {
      dbPath = (database || 'master') + ':' + (path || '');
      parts.push(dbPath);
    }
    return parts.length > 0 ? parts.join(' - ') : '';
  }

  function excludedFieldsCardHtml(excludedFields) {
    var excludedFieldsHtml = (excludedFields || []).map(excludedFieldHtml).join('');

    return '<div class="excluded-fields-card">' +
      '<button type="button" class="scroll-to-top" style="position: absolute; top: 14px; right: 14px;" title="Scroll to top">Top</button>' +
      '<div class="include-header">' +
        '<span class="include-label">Excluded Fields</span>' +
      '</div>' +
      '<div class="excluded-fields-section">' +
        '<div class="excluded-fields-header">' +
          '<h3>Fields</h3>' +
          '<button type="button" class="btn-secondary-sm btn-add-excluded-field">+ Add Excluded Field</button>' +
        '</div>' +
        '<div class="excluded-fields-container" id="excluded-fields-list">' + excludedFieldsHtml + '</div>' +
      '</div>' +
    '</div>';
  }

  function referenceHtml(reference) {
    return '<div class="reference-row">' +
      '<input class="reference-value" type="text" value="' + esc(reference) + '" placeholder="e.g. Foundation.*">' +
      '<button type="button" class="btn-danger-sm btn-remove-reference">Remove</button>' +
    '</div>';
  }

  function rolePredicateHtml(role) {
    return '<div class="role-block role-only-block">' +
      '<div class="role-fields">' +
        '<div class="role-field">' +
          '<label>Domain<span class="req">*</span></label>' +
          '<input class="role-domain" type="text" value="' + esc(role.domain) + '" required placeholder="e.g. sitecore">' +
        '</div>' +
        '<div class="role-field">' +
          '<label>Pattern<span class="req">*</span></label>' +
          '<input class="role-pattern" type="text" value="' + esc(role.pattern) + '" required placeholder="e.g. ^MySite.*$">' +
          '<span class="helper-text">Regex pattern used to include matching roles within the selected domain.</span>' +
        '</div>' +
        '<div class="role-remove-row">' +
          '<button type="button" class="btn-danger-sm btn-remove-role">Remove Role Predicate</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function rolesCardHtml(roles) {
    var rolesHtml = (roles || []).map(rolePredicateHtml).join('');
    return '<div class="roles-card">' +
      '<button type="button" class="scroll-to-top" style="position: absolute; top: 14px; right: 14px;" title="Scroll to top">Top</button>' +
      '<div class="include-header">' +
        '<span class="include-label">Roles</span>' +
      '</div>' +
      '<div class="roles-section">' +
        '<div class="roles-header">' +
          '<h3>Role Predicates</h3>' +
          '<button type="button" class="btn-secondary-sm" id="btn-add-role">+ Add Role Predicate</button>' +
        '</div>' +
        '<div class="roles-container" id="role-predicates-container">' + rolesHtml + '</div>' +
      '</div>' +
    '</div>';
  }

  function userPredicateHtml(user) {
    return '<div class="role-block user-block">' +
      '<div class="role-fields">' +
        '<div class="role-field">' +
          '<label>Domain<span class="req">*</span></label>' +
          '<input class="user-domain" type="text" value="' + esc(user.domain) + '" required placeholder="e.g. sitecore">' +
        '</div>' +
        '<div class="role-field">' +
          '<label>Pattern<span class="req">*</span></label>' +
          '<input class="user-pattern" type="text" value="' + esc(user.pattern) + '" required placeholder="e.g. ^MySite.*$">' +
          '<span class="helper-text">Regex pattern used to include matching users within the selected domain.</span>' +
        '</div>' +
        '<div class="role-remove-row">' +
          '<button type="button" class="btn-danger-sm btn-remove-user">Remove User Predicate</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function usersCardHtml(users) {
    var usersHtml = (users || []).map(userPredicateHtml).join('');
    return '<div class="roles-card">' +
      '<button type="button" class="scroll-to-top" style="position: absolute; top: 14px; right: 14px;" title="Scroll to top">Top</button>' +
      '<div class="include-header">' +
        '<span class="include-label">Users</span>' +
      '</div>' +
      '<div class="roles-section">' +
        '<div class="roles-header">' +
          '<h3>User Predicates</h3>' +
          '<button type="button" class="btn-secondary-sm" id="btn-add-user">+ Add User Predicate</button>' +
        '</div>' +
        '<div class="roles-container" id="user-predicates-container">' + usersHtml + '</div>' +
      '</div>' +
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
    var includesHtml = '';

    for (var i = 0; i < data.includes.length; i++) {
      includesHtml += includeHtml(i, data.includes[i]);
    }

    container.innerHTML = includesHtml;
  }

  function renderExcludedFields() {
    var container = document.getElementById('excluded-fields-container');
    container.innerHTML = excludedFieldsCardHtml(data.excludedFields || []);
  }

  function renderRoles() {
    var container = document.getElementById('roles-container');
    container.innerHTML = rolesCardHtml(data.roles || []);
  }

  function renderUsers() {
    var container = document.getElementById('users-container');
    container.innerHTML = usersCardHtml(data.users || []);
  }

  function ensureSavedIncludeTreeControls() {
    document.querySelectorAll('.include-block').forEach(function(block) {
      var treeBar = block.querySelector('.include-tree-bar');
      if (!treeBar) {
        treeBar = document.createElement('div');
        treeBar.className = 'include-tree-bar';
        block.appendChild(treeBar);
      }

      var existingToggle = treeBar.querySelector('.include-tree-toggle');
      if (!existingToggle) {
        var treeToggle = document.createElement('button');
        treeToggle.type = 'button';
        treeToggle.className = 'include-tree-toggle';
        treeToggle.title = 'Show include content tree';
        treeToggle.setAttribute('aria-pressed', 'false');
        treeToggle.innerHTML =
          '<svg class="include-tree-toggle-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<circle cx="4" cy="3" r="1.5" fill="currentColor"></circle>' +
            '<circle cx="12" cy="8" r="1.5" fill="currentColor"></circle>' +
            '<circle cx="4" cy="13" r="1.5" fill="currentColor"></circle>' +
            '<path d="M5.5 3H8.5V8H10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
            '<path d="M5.5 13H8.5V8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>' +
          '</svg>' +
          '<span>Show Tree</span>';
        treeBar.insertBefore(treeToggle, treeBar.firstChild);
      }
    });
  }

  function focusAndScroll(el) {
    if (!el) { return; }
    el.focus();
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function revealIncludeByName(includeName) {
    if (!includeName) {
      return;
    }

    var normalizedTarget = String(includeName).trim().toLowerCase();
    if (!normalizedTarget) {
      return;
    }

    var includeBlocks = Array.from(document.querySelectorAll('.include-block'));
    var targetBlock = includeBlocks.find(function(block) {
      var headerName = (block.getAttribute('data-include-name') || '').trim().toLowerCase();
      if (headerName === normalizedTarget) {
        return true;
      }

      var input = block.querySelector('.inc-name');
      var inputName = input ? String(input.value || '').trim().toLowerCase() : '';
      return inputName === normalizedTarget;
    });

    if (!targetBlock) {
      return;
    }

    targetBlock.classList.remove('collapsed');
    var toggle = targetBlock.querySelector('.include-toggle');
    if (toggle) {
      toggle.textContent = '▼';
    }

    targetBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var includeNameInput = targetBlock.querySelector('.inc-name');
    if (includeNameInput) {
      includeNameInput.focus();
    }
  }

  function revealRuleByPath(rulePath, includeName) {
    if (!rulePath) {
      return;
    }

    var normalizedRulePath = String(rulePath).trim().toLowerCase();
    if (!normalizedRulePath) {
      return;
    }

    var ruleInputs = Array.from(document.querySelectorAll('.rule-path'));
    var targetInput = ruleInputs.find(function(input) {
      return String(input.value || '').trim().toLowerCase() === normalizedRulePath;
    });

    if (!targetInput) {
      revealIncludeByName(includeName);
      return;
    }

    var targetRuleBlock = targetInput.closest('.rule-block');
    var targetIncludeBlock = targetInput.closest('.include-block');
    if (targetIncludeBlock) {
      targetIncludeBlock.classList.remove('collapsed');
      var toggle = targetIncludeBlock.querySelector('.include-toggle');
      if (toggle) {
        toggle.textContent = '▼';
      }
    }

    if (targetRuleBlock) {
      targetRuleBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    targetInput.focus();
  }

  function clearIncludeDropIndicators() {
    document.querySelectorAll('.include-block.drop-before, .include-block.drop-after').forEach(function(block) {
      block.classList.remove('drop-before');
      block.classList.remove('drop-after');
    });
  }

  function getDragAfterElement(container, y) {
    var blocks = Array.from(container.querySelectorAll('.include-block:not(.dragging)'));
    var closest = { offset: Number.NEGATIVE_INFINITY, element: null };

    blocks.forEach(function(block) {
      var rect = block.getBoundingClientRect();
      var offset = y - rect.top - rect.height / 2;
      if (offset < 0 && offset > closest.offset) {
        closest = { offset: offset, element: block };
      }
    });

    return closest.element;
  }

  renderIncludes();
  renderReferences();
  renderExcludedFields();
  renderRoles();
  renderUsers();

  if (initialRevealRulePath) {
    setTimeout(function() {
      revealRuleByPath(initialRevealRulePath, initialRevealIncludeName);
    }, 50);
  } else if (initialRevealIncludeName) {
    setTimeout(function() {
      revealIncludeByName(initialRevealIncludeName);
    }, 50);
  }

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

    if (target.id === 'nav-roles') {
      var rolesSection = document.getElementById('section-roles');
      if (rolesSection) { rolesSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }

    if (target.id === 'nav-users') {
      var usersSection = document.getElementById('section-users');
      if (usersSection) { usersSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }

    var moduleJsonPathLink = target.closest('#module-json-path-link');
    if (moduleJsonPathLink) {
      evt.preventDefault();
      vscode.postMessage({ command: 'openModuleJsonPath' });
      return;
    }

      // Include tree toggle (saved includes only)
      var treeToggleButton = target.closest('.include-tree-toggle');
      if (treeToggleButton) {
        var includeBlockForTree = treeToggleButton.closest('.include-block');
        if (!includeBlockForTree) {
          return;
        }

        var includeTreeBar = getIncludeTreeBar(includeBlockForTree);
        if (!includeTreeBar) {
          return;
        }

        var isCurrentlyActive = treeToggleButton.classList.contains('is-active');
        if (isCurrentlyActive) {
          // Collapse: move button back to bar root, remove panel
          includeTreeBar.insertBefore(treeToggleButton, includeTreeBar.firstChild);
          treeToggleButton.classList.remove('is-active');
          treeToggleButton.setAttribute('aria-pressed', 'false');
          treeToggleButton.title = 'Show include content tree';
          var showLabel = treeToggleButton.querySelector('span');
          if (showLabel) { showLabel.textContent = 'Show Tree'; }
          var existingPanel = includeTreeBar.querySelector('.include-tree-panel');
          if (existingPanel) { existingPanel.remove(); }
          includeTreeBar.classList.remove('is-open');
          return;
        }

        // Expand: add panel into bar
        treeToggleButton.classList.add('is-active');
        treeToggleButton.setAttribute('aria-pressed', 'true');
        treeToggleButton.title = 'Hide include content tree';
        var hideLabel = treeToggleButton.querySelector('span');
        if (hideLabel) { hideLabel.textContent = 'Hide Tree'; }
        includeTreeBar.classList.add('is-open');

        var panelInBar = includeTreeBar.querySelector('.include-tree-panel');
        if (!panelInBar) {
          panelInBar = document.createElement('div');
          panelInBar.className = 'include-tree-panel';
          panelInBar.innerHTML =
            '<div class="include-tree-toolbar">' +
              '<button type="button" class="btn-secondary-sm include-tree-refresh" title="Refresh include tree">Refresh Tree</button>' +
            '</div>' +
            '<div class="include-tree-status"></div>' +
            '<div class="include-tree-root"></div>';
          includeTreeBar.appendChild(panelInBar);
        }

        // Move the toggle button into the toolbar so it sits next to Refresh Tree (on the left)
        var toolbar = panelInBar.querySelector('.include-tree-toolbar');
        if (toolbar && !toolbar.contains(treeToggleButton)) {
          toolbar.insertBefore(treeToggleButton, toolbar.firstChild);
        }

        includeTreeBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        loadIncludeTree(includeBlockForTree, true);
        return;
      }

      // Include tree manual refresh
      if (target.classList.contains('include-tree-refresh')) {
        var refreshIncludeBlock = target.closest('.include-block');
        if (refreshIncludeBlock) {
          loadIncludeTree(refreshIncludeBlock, true);
        }
        return;
      }

      // Include tree node expand/collapse
      if (target.classList.contains('include-tree-node-toggle')) {
        var nodeElement = target.closest('.include-tree-node');
        var includeBlockForNode = target.closest('.include-block');
        if (!nodeElement || !includeBlockForNode) {
          return;
        }

        var childrenList = nodeElement.querySelector(':scope > .include-tree-list');
        if (!childrenList) {
          return;
        }

        var willExpand = childrenList.hidden;
        if (willExpand) {
          childrenList.hidden = false;
          target.textContent = '▾';
          target.setAttribute('aria-label', 'Collapse tree node');
          loadIncludeTreeChildren(includeBlockForNode, nodeElement);
        } else {
          childrenList.hidden = true;
          target.textContent = '▸';
          target.setAttribute('aria-label', 'Expand tree node');
        }
        return;
      }

      // Include tree item click opens Explain panel
      var includeTreeItemLabel = target.closest('.include-tree-node-label.is-clickable');
      if (includeTreeItemLabel) {
        evt.preventDefault();
        evt.stopPropagation();

        var includeTreeNode = includeTreeItemLabel.closest('.include-tree-node');
        if (!includeTreeNode) {
          return;
        }

        var includeTreeNodePath = includeTreeNode.dataset.nodePath || '';
        var includeTreeNodeId = includeTreeNode.dataset.nodeId || '';
        var includeTreeNodeDatabase = includeTreeNode.dataset.database || 'master';
        if (!includeTreeNodePath) {
          return;
        }

        vscode.postMessage({
          command: 'openExplainForPath',
          path: includeTreeNodePath,
          database: includeTreeNodeDatabase,
          itemId: includeTreeNodeId
        });
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

    var removeIncludeButton = target.closest('.btn-remove-include');
    if (removeIncludeButton) {
      evt.preventDefault();
      evt.stopPropagation();
      var block = removeIncludeButton.closest('.include-block');
      if (block) {
        var includeId = block.getAttribute('data-id') || '';
        vscode.postMessage({ command: 'requestRemoveInclude', includeId: includeId });
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
      var fieldsContainer = document.getElementById('excluded-fields-list');
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

    if (target.id === 'btn-add-role') {
      var rolesList = document.getElementById('role-predicates-container');
      if (!rolesList) { return; }
      var tmpRole = document.createElement('div');
      tmpRole.innerHTML = rolePredicateHtml({ domain: '', pattern: '' });
      var newRole = tmpRole.firstChild;
      rolesList.appendChild(newRole);
      var firstRoleField = newRole && newRole.querySelector ? newRole.querySelector('.role-domain') : null;
      focusAndScroll(firstRoleField);
      return;
    }

    if (target.classList.contains('btn-remove-role')) {
      var role = target.closest('.role-only-block');
      if (role) { role.remove(); }
      return;
    }

    if (target.id === 'btn-add-user') {
      var usersList = document.getElementById('user-predicates-container');
      if (!usersList) { return; }
      var tmpUser = document.createElement('div');
      tmpUser.innerHTML = userPredicateHtml({ domain: '', pattern: '' });
      var newUser = tmpUser.firstChild;
      usersList.appendChild(newUser);
      var firstUserField = newUser && newUser.querySelector ? newUser.querySelector('.user-domain') : null;
      focusAndScroll(firstUserField);
      return;
    }

    if (target.classList.contains('btn-remove-user')) {
      var user = target.closest('.user-block');
      if (user) { user.remove(); }
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
        maxRelativeDepth: '', rules: []
      });
      var newInclude = tmp.firstChild;
      container.appendChild(newInclude);

      if (newInclude && newInclude.classList && newInclude.classList.contains('collapsed')) {
        newInclude.classList.remove('collapsed');
        var toggle = newInclude.querySelector('.include-toggle');
        if (toggle) { toggle.textContent = '▼'; }
      }

      if (newInclude && typeof newInclude.scrollIntoView === 'function') {
        newInclude.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      var firstIncludeField = newInclude && newInclude.querySelector ? newInclude.querySelector('.inc-name') : null;
      focusAndScroll(firstIncludeField);
      return;
    }

    if (target.id === 'btn-save' || target.id === 'btn-save-top') {
      doSave();
    }
  });

  // Update quick info when include fields change
  document.addEventListener('change', function(evt) {
    var target = evt.target;
    if (!(target instanceof Element)) { return; }
    
    if (target.classList.contains('inc-scope') || target.classList.contains('inc-path') || target.classList.contains('inc-database')) {
      var incBlock = target.closest('.include-block');
      if (incBlock) {
        var pathInput = incBlock.querySelector('.inc-path');
        var scopeSelect = incBlock.querySelector('.inc-scope');
        var dbSelect = incBlock.querySelector('.inc-database');
        var quickInfo = incBlock.querySelector('.include-quick-info');
        
        if (quickInfo) {
          var path = pathInput ? pathInput.value : '';
          var scope = scopeSelect ? scopeSelect.value : '';
          var db = dbSelect ? dbSelect.value : '';
          quickInfo.textContent = getIncludeQuickInfoText(scope, path, db);
        }
      }
    }
  });

  document.addEventListener('dragstart', function(evt) {
    var target = evt.target;
    if (!(target instanceof Element)) { return; }

    // Don't drag if clicking on a button or interactive element
    if (target.tagName === 'BUTTON' || target.closest('button')) {
      evt.preventDefault();
      return;
    }

    var dragHandle = target.closest('.include-drag-handle');
    if (!dragHandle) { return; }

    var includeBlock = dragHandle.closest('.include-block');
    if (!includeBlock) { return; }

    draggedInclude = includeBlock;
    includeBlock.classList.add('dragging');
    if (evt.dataTransfer) {
      evt.dataTransfer.effectAllowed = 'move';
      evt.dataTransfer.setData('text/plain', includeBlock.getAttribute('data-id') || '');
    }
  });

  document.addEventListener('dragover', function(evt) {
    if (!draggedInclude) { return; }

    var includesContainer = document.getElementById('includes-container');
    if (!includesContainer) { return; }

    var target = evt.target;
    if (!(target instanceof Element)) { return; }
    if (!includesContainer.contains(target)) { return; }

    evt.preventDefault();

    clearIncludeDropIndicators();

    var afterElement = getDragAfterElement(includesContainer, evt.clientY);
    if (afterElement) {
      includesContainer.insertBefore(draggedInclude, afterElement);
      afterElement.classList.add('drop-before');
      return;
    }

    includesContainer.appendChild(draggedInclude);

    var blocks = includesContainer.querySelectorAll('.include-block:not(.dragging)');
    if (blocks.length > 0) {
      blocks[blocks.length - 1].classList.add('drop-after');
    }
  });

  document.addEventListener('drop', function(evt) {
    if (!draggedInclude) { return; }

    var includesContainer = document.getElementById('includes-container');
    if (!includesContainer) { return; }

    var target = evt.target;
    if (!(target instanceof Element)) { return; }
    if (!includesContainer.contains(target)) { return; }

    evt.preventDefault();
    clearIncludeDropIndicators();
  });

  document.addEventListener('dragend', function() {
    if (draggedInclude) {
      draggedInclude.classList.remove('dragging');
      draggedInclude = null;
    }
    clearIncludeDropIndicators();
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
      references: Array.from(document.querySelectorAll('.reference-value'))
        .map(function(el) { return el.value.trim(); })
        .filter(function(value) { return value.length > 0; }),
      roles: Array.from(document.querySelectorAll('.role-only-block')).map(function(roleEl) {
        return {
          domain: roleEl.querySelector('.role-domain').value.trim(),
          pattern: roleEl.querySelector('.role-pattern').value.trim()
        };
      }),
      users: Array.from(document.querySelectorAll('.user-block')).map(function(userEl) {
        return {
          domain: userEl.querySelector('.user-domain').value.trim(),
          pattern: userEl.querySelector('.user-pattern').value.trim()
        };
      }),
      excludedFields: Array.from(document.querySelectorAll('.excluded-field-block')).map(function(fieldEl) {
        return {
          fieldID: fieldEl.querySelector('.excluded-field-id').value.trim(),
          description: fieldEl.querySelector('.excluded-field-description').value.trim()
        };
      }),
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
    document.querySelectorAll('.inc-name, .inc-path, .rule-path, .excluded-field-id, .role-domain, .role-pattern, .user-domain, .user-pattern').forEach(function(el) {
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
      ensureSavedIncludeTreeControls();
      setTimeout(function() { feedback.textContent = ''; }, 2500);
      return;
    }

    if (event.data && event.data.command === 'includeTreeLoaded') {
      renderIncludeTree(event.data.includeId, event.data);
      return;
    }

    if (event.data && event.data.command === 'includeTreeChildrenLoaded') {
      renderIncludeTreeChildren(event.data.includeId, event.data);
      return;
    }

    if (event.data && event.data.command === 'revealInclude') {
      if (event.data.rulePath) {
        revealRuleByPath(event.data.rulePath, event.data.includeName);
        return;
      }

      if (event.data.includeName) {
        revealIncludeByName(event.data.includeName);
      }
      return;
    }

    if (event.data && event.data.command === 'removeIncludeConfirmed') {
      var includeId = String(event.data.includeId || '');
      if (!includeId) {
        return;
      }
      var includeBlock = document.querySelector('.include-block[data-id="' + includeId + '"]');
      if (includeBlock) {
        includeBlock.remove();
      }
    }

    if (event.data && event.data.command === 'iconResolved') {
      var resolvedUrl = event.data.iconUrl;
      var dataUri = event.data.dataUri;
      if (resolvedUrl && dataUri) {
        resolvedIconCache.set(resolvedUrl, dataUri);
        var imgs = document.querySelectorAll('.include-tree-node-sitecore-icon[data-icon-url]');
        imgs.forEach(function(img) {
          if (img.getAttribute('data-icon-url') === resolvedUrl) {
            img.src = dataUri;
          }
        });
      } else if (resolvedUrl) {
        resolvedIconCache.set(resolvedUrl, 'failed');
      }
    }
  });
</script>
</body>
</html>`;
  }
}
