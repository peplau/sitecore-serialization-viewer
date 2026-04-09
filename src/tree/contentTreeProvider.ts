import * as vscode from 'vscode';
import { exec as execCallback } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { SitecoreTreeItem } from './treeItem';
import { SitecoreItem, SerializationStatus } from './models';
import { AuthoringGraphqlClient } from '../sitecore/previewGraphqlClient';
import { SerializationConfigService } from '../sitecore/serializationConfigService';

interface ModuleSerializationInclude {
  name?: string;
  path?: string;
  scope?: string;
  database?: string;
  allowedPushOperations?: string;
  rules?: ModuleSerializationInclude[];
}

interface ModuleSerializationSource {
  moduleName: string;
  description?: string;
  references?: string[];
  jsonUri: vscode.Uri;
  rootUri: vscode.Uri;
  includes: ModuleSerializationInclude[];
  pathConfigs: ModuleSerializationPathConfig[];
}

export interface ModuleListingItem {
  namespace: string;
  description?: string;
  references?: string[];
  jsonFilePath: string;
}

interface ModuleSerializationPathConfig {
  name?: string;
  path: string;
  scope?: string;
  database?: string;
  allowedPushOperations?: string;
  sourceType?: 'include' | 'rule';
  includeName?: string;
}

interface ModulePathMatch {
  config: ModuleSerializationPathConfig;
  status: SerializationStatus;
}

export class ContentTreeProvider implements vscode.TreeDataProvider<SitecoreTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SitecoreTreeItem | undefined | void> = new vscode.EventEmitter<SitecoreTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SitecoreTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  private client: AuthoringGraphqlClient;
  private cache: Map<string, SitecoreItem[]> = new Map();
  private moduleRootItemsByPath: Map<string, SitecoreItem> = new Map();
  private parentPathByPath: Map<string, string> = new Map();
  private explainStatusCache: Map<string, SerializationStatus> = new Map();
  private loadGeneration = 0;
  private readonly exec = promisify(execCallback);
  private selectedDatabase: string;
  private selectedModule: string = 'All modules';
  private readonly serializationConfigService = SerializationConfigService.getInstance();
  private moduleYamlRoots: SitecoreItem[] = [];
  private moduleYamlChildrenByPath: Map<string, SitecoreItem[]> = new Map();
  private moduleYamlItemsByPath: Map<string, SitecoreItem> = new Map();
  private moduleYamlLoadedFor: string | undefined;
  private availableModulesCache: string[] | undefined;
  private moduleSerializationSourceCache: Map<string, ModuleSerializationSource | null> = new Map();

  constructor() {
    this.client = new AuthoringGraphqlClient();
    const config = vscode.workspace.getConfiguration('sitecoreSerializationViewer');
    this.selectedDatabase = config.get<string>('defaultDatabase') || 'master';
    this.client.setDatabase(this.selectedDatabase);
  }

  getSelectedDatabase(): string {
    return this.selectedDatabase;
  }

  setSelectedDatabase(database: string): void {
    this.selectedDatabase = database || 'master';
    this.client.setDatabase(this.selectedDatabase);
  }

  getSelectedModule(): string {
    return this.selectedModule;
  }

  setSelectedModule(moduleName: string): void {
    this.selectedModule = moduleName || 'All modules';
    this.moduleYamlLoadedFor = undefined;
  }

  async getAvailableModules(): Promise<string[]> {
    const configuredModules = await this.getConfiguredModules();
    if (configuredModules.length > 0) {
      return configuredModules.sort((a, b) => a.localeCompare(b));
    }

    return this.serializationConfigService.getModuleNames().sort((a, b) => a.localeCompare(b));
  }

  async getModuleListingItems(): Promise<ModuleListingItem[]> {
    const sources = await this.loadModuleSerializationSources();
    return sources
      .map(source => ({
        namespace: source.moduleName,
        description: source.description,
        references: source.references,
        jsonFilePath: source.jsonUri.fsPath
      }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  async getModuleItemsListingByJsonPath(jsonFilePath: string): Promise<{
    moduleName: string;
    description?: string;
    references?: string[];
    items: Array<{
      itemPath: string;
      status: 'Serialized directly' | 'Serialized indirectly';
      includeOrRule: string;
      yamlPath: string;
      itemId?: string;
    }>;
  } | undefined> {
    const sources = await this.loadModuleSerializationSources();
    const workspaceRoot = this.getWorkspaceRootPath();
    const candidatePaths = path.isAbsolute(jsonFilePath)
      ? [jsonFilePath]
      : workspaceRoot ? [jsonFilePath, path.join(workspaceRoot, jsonFilePath)] : [jsonFilePath];

    const normalizedCandidates = candidatePaths.map(p => p.replace(/\\/g, '/').toLowerCase());
    const normalizedInput = jsonFilePath.replace(/\\/g, '/').toLowerCase();

    const source = sources.find(s => {
      const normalizedSource = s.jsonUri.fsPath.replace(/\\/g, '/').toLowerCase();
      return normalizedCandidates.includes(normalizedSource) || normalizedSource.endsWith(normalizedInput);
    });
    if (!source) {
      return undefined;
    }

    const yamlPattern = new vscode.RelativePattern(source.rootUri, 'items/**/*.{yml,yaml}');
    const yamlUris = await vscode.workspace.findFiles(yamlPattern);

    const rowsByPath = new Map<string, {
      itemPath: string;
      status: 'Serialized directly' | 'Serialized indirectly';
      includeOrRule: string;
      yamlPath: string;
      itemId?: string;
    }>();

    for (const yamlUri of yamlUris) {
      let content = '';
      try {
        const bytes = await vscode.workspace.fs.readFile(yamlUri);
        content = Buffer.from(bytes).toString('utf8');
      } catch {
        continue;
      }

      const parsed = this.parseYamlMetadata(content);
      if (!parsed.path) {
        continue;
      }

      const match = this.getModulePathMatch(parsed.path, source.pathConfigs);
      if (!match) {
        continue;
      }

      const normalizedPath = this.normalizePath(parsed.path);
      const current = rowsByPath.get(normalizedPath);
      const nextStatus: 'Serialized directly' | 'Serialized indirectly' =
        match.status === SerializationStatus.Direct ? 'Serialized directly' : 'Serialized indirectly';
      const nextRow = {
        itemPath: normalizedPath,
        status: nextStatus,
        includeOrRule: this.getIncludeOrRuleLabel(match.config),
        yamlPath: yamlUri.fsPath,
        itemId: parsed.id
      };

      if (!current) {
        rowsByPath.set(normalizedPath, nextRow);
        continue;
      }

      if (current.status === 'Serialized indirectly' && nextRow.status === 'Serialized directly') {
        rowsByPath.set(normalizedPath, nextRow);
      }
    }

    const items = Array.from(rowsByPath.values()).sort((a, b) => a.itemPath.localeCompare(b.itemPath));

    return {
      moduleName: source.moduleName,
      description: source.description,
      references: source.references,
      items
    };
  }

  private isModuleFilterActive(): boolean {
    return this.selectedModule !== 'All modules';
  }

  private isCurrentlySerialized(item: SitecoreItem): boolean {
    return item.status === SerializationStatus.Direct || item.status === SerializationStatus.Indirect;
  }

  private isAffectedBySelectedModule(itemPath: string): boolean {
    if (!this.isModuleFilterActive()) {
      return true;
    }

    return !!this.serializationConfigService.checkSerializationStatusForModule(
      itemPath,
      this.selectedModule,
      this.selectedDatabase
    );
  }

  private shouldDisplayForSelectedModule(item: SitecoreItem): boolean {
    if (!this.isModuleFilterActive()) {
      return true;
    }

    return this.isAffectedBySelectedModule(item.path) && this.isCurrentlySerialized(item);
  }

  async getItemByPath(pathValue: string): Promise<SitecoreItem | undefined> {
    const normalizedPath = this.normalizePath(pathValue);

    if (normalizedPath === '/sitecore') {
      return {
        id: 'sitecore-root',
        name: 'sitecore',
        path: '/sitecore',
        hasChildren: true,
        status: SerializationStatus.NotSerialized
      };
    }

    return this.client.getItemByPath(normalizedPath);
  }

  async getItemById(itemId: string): Promise<SitecoreItem | undefined> {
    return this.client.getItemById(itemId);
  }

  private readonly fallbackMockData: SitecoreItem[] = [
    {
      id: '1',
      name: 'sitecore',
      path: '/sitecore',
      hasChildren: true,
      status: SerializationStatus.NotSerialized
    },
    {
      id: '2',
      name: 'content',
      path: '/sitecore/content',
      hasChildren: true,
      status: SerializationStatus.Direct,
      matchedModule: '_Vizient.Main',
      pushOperations: 'CreateUpdateAndDelete'
    },
    {
      id: '3',
      name: 'templates',
      path: '/sitecore/templates',
      hasChildren: true,
      status: SerializationStatus.Indirect,
      matchedModule: '_Vizient.Main'
    },
    {
      id: '4',
      name: 'system',
      path: '/sitecore/system',
      hasChildren: true,
      status: SerializationStatus.NotSerialized
    }
  ];

  getTreeItem(element: SitecoreTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: SitecoreTreeItem): vscode.ProviderResult<SitecoreTreeItem> {
    const parentPath = this.parentPathByPath.get(element.item.path);
    if (!parentPath) {
      return undefined;
    }

    if (parentPath === '/sitecore') {
      const rootItem: SitecoreItem = {
        id: 'sitecore-root',
        name: 'sitecore',
        path: '/sitecore',
        hasChildren: true,
        status: SerializationStatus.NotSerialized
      };
      return this.createTreeItem(rootItem);
    }

    const moduleRootParent = this.moduleRootItemsByPath.get(parentPath);
    if (moduleRootParent) {
      return this.createModuleRootDisplayItem(moduleRootParent);
    }

    const parent = this.findCachedItemByPath(parentPath);
    return parent ? this.createTreeItem(parent) : undefined;
  }

  private findCachedItemByPath(pathValue: string): SitecoreItem | undefined {
    const moduleRoot = this.moduleRootItemsByPath.get(pathValue);
    if (moduleRoot) {
      return moduleRoot;
    }

    const moduleItem = this.moduleYamlItemsByPath.get(pathValue);
    if (moduleItem) {
      return moduleItem;
    }

    for (const items of this.cache.values()) {
      const found = items.find(item => item.path.toLowerCase() === pathValue.toLowerCase());
      if (found) {
        return found;
      }
    }

    return undefined;
  }

  private createTreeItem(item: SitecoreItem): SitecoreTreeItem {
    return new SitecoreTreeItem(
      item,
      item.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
  }

  private createModuleRootDisplayItem(item: SitecoreItem): SitecoreTreeItem {
    return this.createTreeItem({
      ...item,
      name: item.path
    });
  }

  private async getRawChildren(basePath: string, requestGeneration: number): Promise<SitecoreItem[]> {
    if (this.cache.has(basePath)) {
      return this.cache.get(basePath) || [];
    }

    let items: SitecoreItem[] = [];
    try {
      const result = await this.client.getChildren(basePath);
      items = (result || []).filter((item: SitecoreItem) => item.path !== basePath);
      items = await this.reconcileIndirectStatuses(items);

      if (requestGeneration !== this.loadGeneration) {
        return [];
      }

      if (items.length === 0) {
        console.warn(`No children returned from GraphQL for ${basePath}`);
      }
    } catch (error) {
      console.warn(`GraphQL load failed for path ${basePath}:`, error);
      vscode.window.showWarningMessage(`Sitecore GraphQL load failed (${basePath}). ${error instanceof Error ? error.message : ''}`);
    }

    this.cache.set(basePath, items);
    return items;
  }

  private normalizePath(pathValue: string): string {
    const trimmed = (pathValue || '').trim();
    if (!trimmed) {
      return '/sitecore';
    }

    const leadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    const withoutTrailingSlash = leadingSlash.length > 1 ? leadingSlash.replace(/\/+$/, '') : leadingSlash;
    return withoutTrailingSlash || '/sitecore';
  }

  private getParentPath(pathValue: string): string | undefined {
    const normalized = this.normalizePath(pathValue);
    if (normalized === '/sitecore') {
      return undefined;
    }

    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) {
      return undefined;
    }

    return normalized.substring(0, lastSlash);
  }

  private deriveNameFromPath(pathValue: string): string {
    const normalized = this.normalizePath(pathValue);
    const idx = normalized.lastIndexOf('/');
    if (idx < 0 || idx === normalized.length - 1) {
      return normalized;
    }

    return normalized.substring(idx + 1);
  }

  private parseYamlMetadata(content: string): { path?: string; name?: string; id?: string } {
    const lines = content.split(/\r?\n/);
    let parsedPath: string | undefined;
    let parsedName: string | undefined;
    let parsedId: string | undefined;

    for (let i = 0; i < lines.length; i++) {
      const idMatch = lines[i].match(/^ID:\s*(.+)\s*$/);
      if (idMatch) {
        parsedId = idMatch[1].trim();
      }

      const pathMatch = lines[i].match(/^Path:\s*(.+)\s*$/);
      if (pathMatch) {
        parsedPath = this.normalizePath(pathMatch[1]);
      }

      const hintMatch = lines[i].match(/^\s*Hint:\s*(.+)\s*$/i);
      if (!hintMatch) {
        continue;
      }

      const hint = hintMatch[1].trim().toLowerCase();
      if (hint !== 'name') {
        continue;
      }

      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const valueMatch = lines[j].match(/^\s*Value:\s*(.*)$/i);
        if (!valueMatch) {
          continue;
        }

        const inline = valueMatch[1].trim();
        if (inline && inline !== '|') {
          parsedName = inline;
        }
        break;
      }
    }

    return { path: parsedPath, name: parsedName, id: parsedId };
  }

  private getIncludeOrRuleLabel(config: ModuleSerializationPathConfig): string {
    if (config.sourceType === 'rule') {
      return config.includeName ? `${config.includeName} (Rule)` : 'Rule';
    }

    return config.includeName || config.name || 'Include';
  }

  private getWorkspaceRootPath(): string | undefined {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      return undefined;
    }

    return vscode.workspace.workspaceFolders[0].uri.fsPath;
  }

  private getExcludePattern(): string {
    return '{**/node_modules/**,**/dist/**,**/out/**,**/.git/**,**/.vscode-test/**}';
  }

  private async readJsonFile<T>(uri: vscode.Uri): Promise<T | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private normalizeModuleName(moduleName: string): string {
    return moduleName.trim().toLowerCase();
  }

  private normalizeReferences(references: unknown): string[] {
    if (!Array.isArray(references)) {
      return [];
    }

    return references
      .filter(ref => typeof ref === 'string')
      .map(ref => ref.trim())
      .filter(ref => ref.length > 0);
  }

  private async findSitecoreConfigUris(): Promise<vscode.Uri[]> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      return [];
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    return vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, '**/sitecore.json'), this.getExcludePattern());
  }

  private async loadConfiguredModuleJsonUris(): Promise<vscode.Uri[]> {
    const sitecoreConfigUris = await this.findSitecoreConfigUris();
    const moduleUrisByPath = new Map<string, vscode.Uri>();

    for (const sitecoreConfigUri of sitecoreConfigUris) {
      const sitecoreConfig = await this.readJsonFile<{ modules?: string[] }>(sitecoreConfigUri);
      const moduleGlobs = Array.isArray(sitecoreConfig?.modules) ? sitecoreConfig.modules : [];
      if (moduleGlobs.length === 0) {
        continue;
      }

      const configDirectory = path.dirname(sitecoreConfigUri.fsPath);
      for (const moduleGlob of moduleGlobs) {
        const matchedUris = await vscode.workspace.findFiles(new vscode.RelativePattern(configDirectory, moduleGlob), this.getExcludePattern());
        for (const matchedUri of matchedUris) {
          moduleUrisByPath.set(matchedUri.fsPath.toLowerCase(), matchedUri);
        }
      }
    }

    return Array.from(moduleUrisByPath.values());
  }

  private resolveRulePath(parentPath: string | undefined, rulePath: string | undefined): string | undefined {
    const trimmedPath = (rulePath || '').trim();
    if (!trimmedPath) {
      return undefined;
    }

    if (trimmedPath.toLowerCase().startsWith('/sitecore')) {
      return this.normalizePath(trimmedPath);
    }

    const normalizedParent = parentPath ? this.normalizePath(parentPath) : undefined;
    if (!normalizedParent) {
      return trimmedPath.startsWith('/') ? this.normalizePath(trimmedPath) : this.normalizePath(`/${trimmedPath}`);
    }

    const relativePath = trimmedPath.replace(/^\/+/, '');
    return this.normalizePath(`${normalizedParent}/${relativePath}`);
  }

  private flattenPathConfigs(
    nodes: ModuleSerializationInclude[],
    parentPath?: string,
    sourceType: 'include' | 'rule' = 'include',
    includeName?: string
  ): ModuleSerializationPathConfig[] {
    const flattened: ModuleSerializationPathConfig[] = [];

    for (const node of nodes) {
      const resolvedPath = this.resolveRulePath(parentPath, node.path);
      if (!resolvedPath) {
        continue;
      }

      const effectiveIncludeName = sourceType === 'include'
        ? (node.name?.trim() || includeName)
        : includeName;

      const config: ModuleSerializationPathConfig = {
        name: node.name,
        path: resolvedPath,
        scope: node.scope,
        database: node.database,
        allowedPushOperations: node.allowedPushOperations,
        sourceType,
        includeName: effectiveIncludeName
      };

      flattened.push(config);

      if (Array.isArray(node.rules) && node.rules.length > 0) {
        flattened.push(...this.flattenPathConfigs(node.rules, resolvedPath, 'rule', effectiveIncludeName));
      }
    }

    return flattened;
  }

  private async loadModuleSerializationSources(): Promise<ModuleSerializationSource[]> {
    if (this.availableModulesCache) {
      const cachedSources: ModuleSerializationSource[] = [];
      for (const moduleName of this.availableModulesCache) {
        const source = this.moduleSerializationSourceCache.get(this.normalizeModuleName(moduleName));
        if (source) {
          cachedSources.push(source);
        }
      }

      if (cachedSources.length === this.availableModulesCache.length) {
        return cachedSources;
      }
    }

    const moduleJsonUris = await this.loadConfiguredModuleJsonUris();
    const sources: ModuleSerializationSource[] = [];
    this.moduleSerializationSourceCache.clear();

    for (const jsonUri of moduleJsonUris) {
      const json = await this.readJsonFile<{
        namespace?: string;
        description?: string;
        references?: string[];
        items?: { includes?: ModuleSerializationInclude[] };
      }>(jsonUri);
      const moduleName = json?.namespace?.trim();
      const references = this.normalizeReferences(json?.references);
      const includes = Array.isArray(json?.items?.includes) ? json.items.includes.filter(include => typeof include?.path === 'string' && include.path.trim().length > 0) : [];
      if (!moduleName || includes.length === 0) {
        continue;
      }

      const source: ModuleSerializationSource = {
        moduleName,
        description: json?.description,
        references,
        jsonUri,
        rootUri: vscode.Uri.file(path.dirname(jsonUri.fsPath)),
        includes,
        pathConfigs: this.flattenPathConfigs(includes)
      };

      this.moduleSerializationSourceCache.set(this.normalizeModuleName(moduleName), source);
      sources.push(source);
    }

    this.availableModulesCache = sources.map(source => source.moduleName);
    return sources;
  }

  private async getConfiguredModules(): Promise<string[]> {
    const sources = await this.loadModuleSerializationSources();
    return sources.map(source => source.moduleName);
  }

  private async getModuleSerializationSource(moduleName: string): Promise<ModuleSerializationSource | undefined> {
    const normalizedModuleName = this.normalizeModuleName(moduleName);
    const cached = this.moduleSerializationSourceCache.get(normalizedModuleName);
    if (cached) {
      return cached;
    }

    const sources = await this.loadModuleSerializationSources();
    return sources.find(source => this.normalizeModuleName(source.moduleName) === normalizedModuleName);
  }

  private isIgnoredScope(scopeValue?: string): boolean {
    const normalizedScope = (scopeValue || '').toLowerCase();
    return normalizedScope.includes('ignored') || normalizedScope.includes('exclude');
  }

  private allowsDescendants(scopeValue?: string): boolean {
    const normalizedScope = (scopeValue || 'itemanddescendants').toLowerCase();
    return normalizedScope !== 'singleitem';
  }

  private getModulePathMatch(itemPath: string, pathConfigs: ModuleSerializationPathConfig[]): ModulePathMatch | undefined {
    const normalizedItemPath = this.normalizePath(itemPath).toLowerCase();
    const selectedDatabase = this.selectedDatabase.toLowerCase();
    let bestMatch: ModulePathMatch | undefined;

    for (const config of pathConfigs) {
      if (!config.path) {
        continue;
      }

      if (config.database && config.database.toLowerCase() !== selectedDatabase) {
        continue;
      }

      const normalizedConfigPath = config.path.toLowerCase();
      const exactMatch = normalizedItemPath === normalizedConfigPath;
      const descendantMatch = normalizedItemPath.startsWith(`${normalizedConfigPath}/`);

      if (!exactMatch && !descendantMatch) {
        continue;
      }

      if (this.isIgnoredScope(config.scope)) {
        if (!bestMatch || normalizedConfigPath.length >= bestMatch.config.path.length) {
          bestMatch = {
            config,
            status: SerializationStatus.NotSerialized
          };
        }
        continue;
      }

      if (descendantMatch && !this.allowsDescendants(config.scope)) {
        continue;
      }

      const candidateStatus = exactMatch ? SerializationStatus.Direct : SerializationStatus.Indirect;
      if (!bestMatch || normalizedConfigPath.length > bestMatch.config.path.length) {
        bestMatch = {
          config,
          status: candidateStatus
        };
      }
    }

    if (bestMatch?.status === SerializationStatus.NotSerialized) {
      return undefined;
    }

    return bestMatch;
  }

  private async findModuleRootDirs(moduleName: string): Promise<vscode.Uri[]> {
    const source = await this.getModuleSerializationSource(moduleName);
    if (!source) {
      return [];
    }

    return [source.rootUri];
  }

  private async ensureModuleYamlTreeLoaded(requestGeneration: number): Promise<void> {
    if (!this.isModuleFilterActive()) {
      return;
    }

    const modeKey = `${this.selectedModule}|${this.selectedDatabase}`;
    if (this.moduleYamlLoadedFor === modeKey) {
      return;
    }

    this.moduleYamlRoots = [];
    this.moduleYamlChildrenByPath.clear();
    this.moduleYamlItemsByPath.clear();
    this.moduleRootItemsByPath.clear();

    const source = await this.getModuleSerializationSource(this.selectedModule);
    const moduleRootDirs = source ? [source.rootUri] : [];

    if (requestGeneration !== this.loadGeneration) {
      return;
    }

    const affectedByPath = new Map<string, SitecoreItem>();

    for (const rootDir of moduleRootDirs) {
      if (requestGeneration !== this.loadGeneration) {
        return;
      }

      const yamlPattern = new vscode.RelativePattern(rootDir, 'items/**/*.{yml,yaml}');
      const yamlUris = await vscode.workspace.findFiles(yamlPattern);

      for (const yamlUri of yamlUris) {
        if (requestGeneration !== this.loadGeneration) {
          return;
        }

        let content = '';
        try {
          const bytes = await vscode.workspace.fs.readFile(yamlUri);
          content = Buffer.from(bytes).toString('utf8');
        } catch {
          continue;
        }

        const parsed = this.parseYamlMetadata(content);
        if (!parsed.path || affectedByPath.has(parsed.path)) {
          continue;
        }

        const match = source ? this.getModulePathMatch(parsed.path, source.pathConfigs) : undefined;
        if (!match) {
          continue;
        }

        affectedByPath.set(parsed.path, {
          id: parsed.path,
          name: parsed.name || this.deriveNameFromPath(parsed.path),
          path: parsed.path,
          hasChildren: false,
          status: match.status,
          yamlPath: yamlUri.fsPath,
          matchedModule: this.selectedModule,
          moduleDescription: source?.description,
          moduleJsonPath: source?.jsonUri.fsPath,
          subtreeKey: match.config.name,
          subtreePath: match.config.path,
          subtreeScope: match.config.scope,
          subtreePushOperations: match.config.allowedPushOperations,
          subtreeDatabase: match.config.database
        });
      }
    }

    this.moduleYamlItemsByPath = new Map(affectedByPath);

    const roots: SitecoreItem[] = [];
    const childrenByParent = new Map<string, SitecoreItem[]>();

    for (const item of affectedByPath.values()) {
      const parentPath = this.getParentPath(item.path);
      if (!parentPath || !affectedByPath.has(parentPath)) {
        roots.push(item);
        this.parentPathByPath.delete(item.path);
        this.moduleRootItemsByPath.set(item.path, item);
        continue;
      }

      this.parentPathByPath.set(item.path, parentPath);
      const siblings = childrenByParent.get(parentPath) || [];
      siblings.push(item);
      childrenByParent.set(parentPath, siblings);
    }

    for (const [parentPath, children] of childrenByParent.entries()) {
      children.sort((a, b) => a.name.localeCompare(b.name));
      this.moduleYamlChildrenByPath.set(parentPath, children);

      const parentItem = affectedByPath.get(parentPath);
      if (parentItem) {
        parentItem.hasChildren = children.length > 0;
      }
    }

    roots.sort((a, b) => a.path.localeCompare(b.path));
    this.moduleYamlRoots = roots;
    this.moduleYamlLoadedFor = modeKey;
  }

  private async buildDisplayedChildren(basePath: string, requestGeneration: number, displayedParentPath: string): Promise<SitecoreItem[]> {
    if (this.isModuleFilterActive()) {
      await this.ensureModuleYamlTreeLoaded(requestGeneration);
      const children = this.moduleYamlChildrenByPath.get(basePath) || [];
      for (const item of children) {
        this.parentPathByPath.set(item.path, displayedParentPath);
      }
      return children;
    }

    const rawChildren = await this.getRawChildren(basePath, requestGeneration);
    for (const item of rawChildren) {
      this.parentPathByPath.set(item.path, displayedParentPath);
    }

    return rawChildren;
  }

  async findPathChain(pathValue: string): Promise<SitecoreTreeItem[] | undefined> {
    const normalizedTargetPath = this.normalizePath(pathValue);
    if (!normalizedTargetPath.toLowerCase().startsWith('/sitecore')) {
      return undefined;
    }

    const rootItems = await this.getChildren();
    const root = rootItems[0];
    if (!root) {
      return undefined;
    }

    if (normalizedTargetPath.toLowerCase() === '/sitecore') {
      return [root];
    }

    const segments = normalizedTargetPath.split('/').filter(Boolean);
    if (segments.length === 0 || segments[0].toLowerCase() !== 'sitecore') {
      return undefined;
    }

    const chain: SitecoreTreeItem[] = [root];
    let current = root;
    let currentPath = '/sitecore';

    for (let i = 1; i < segments.length; i++) {
      currentPath = `${currentPath}/${segments[i]}`;
      const children = await this.getChildren(current);
      const next = children.find(child => child.item.path.toLowerCase() === currentPath.toLowerCase());
      if (!next) {
        return undefined;
      }

      chain.push(next);
      current = next;
    }

    return chain;
  }

  async getChildren(element?: SitecoreTreeItem): Promise<SitecoreTreeItem[]> {
    const requestGeneration = this.loadGeneration;

    // If no element, return roots depending on active module filter mode.
    if (!element) {
      if (this.isModuleFilterActive()) {
        await this.ensureModuleYamlTreeLoaded(requestGeneration);
        return this.moduleYamlRoots.map(item => this.createModuleRootDisplayItem(item));
      }

      const rootItem: SitecoreItem = {
        id: 'sitecore-root',
        name: 'sitecore',
        path: '/sitecore',
        hasChildren: true,
        status: SerializationStatus.NotSerialized
      };
      this.parentPathByPath.delete('/sitecore');
      return [new SitecoreTreeItem(rootItem, vscode.TreeItemCollapsibleState.Collapsed)];
    }

    const basePath = element.item.path;

    const displayedItems = await this.buildDisplayedChildren(basePath, requestGeneration, basePath);
    return displayedItems.map(item => this.createTreeItem(item));
  }

  refresh(options?: { resetState?: boolean }): void {
    this.cache.clear();
    this.moduleYamlRoots = [];
    this.moduleYamlChildrenByPath.clear();
    this.moduleYamlItemsByPath.clear();
    this.moduleYamlLoadedFor = undefined;
    this.moduleRootItemsByPath.clear();
    this.parentPathByPath.clear();
    this.explainStatusCache.clear();

    if (options?.resetState) {
      this.loadGeneration += 1;
      this.client.reset();
      this.client.setDatabase(this.selectedDatabase);
      this.availableModulesCache = undefined;
      this.moduleSerializationSourceCache.clear();
    }

    this._onDidChangeTreeData.fire();
  }

  private async reconcileIndirectStatuses(items: SitecoreItem[]): Promise<SitecoreItem[]> {
    const updated = [...items];

    for (let i = 0; i < updated.length; i++) {
      const item = updated[i];
      if (item.status !== SerializationStatus.Indirect) {
        continue;
      }

      const resolvedStatus = await this.getExplainBasedStatus(item.path);
      if (resolvedStatus && resolvedStatus !== item.status) {
        updated[i] = {
          ...item,
          status: resolvedStatus
        };
      }
    }

    return updated;
  }

  private async getExplainBasedStatus(itemPath: string): Promise<SerializationStatus | undefined> {
    const cached = this.explainStatusCache.get(itemPath);
    if (cached) {
      return cached;
    }

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      return undefined;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const command = `dotnet sitecore ser explain -p "${itemPath}"`;

    try {
      const { stdout, stderr } = await this.exec(command, { cwd: workspaceRoot, timeout: 10000 });
      const text = `${stdout || ''}\n${stderr || ''}`.toLowerCase();

      if (/not included in any module configuration|\snot included[.!]?/i.test(text)) {
        this.explainStatusCache.set(itemPath, SerializationStatus.NotSerialized);
        return SerializationStatus.NotSerialized;
      }

      this.explainStatusCache.set(itemPath, SerializationStatus.Indirect);
      return SerializationStatus.Indirect;
    } catch {
      // Keep original status if explain cannot run.
      return undefined;
    }
  }
}