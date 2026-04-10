import * as vscode from 'vscode';
import { exec as execCallback } from 'child_process';
import * as path from 'path';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { SitecoreTreeItem } from './treeItem';
import { SitecoreItem, SerializationStatus } from './models';
import { AuthoringGraphqlClient } from '../sitecore/previewGraphqlClient';
import { SerializationConfigService } from '../sitecore/serializationConfigService';
import { appendPerfLine, isPerfTracingEnabled, showPerfOutput } from '../perfOutput';

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
  roles: ModulePrincipalPredicate[];
  users: ModulePrincipalPredicate[];
  jsonUri: vscode.Uri;
  rootUri: vscode.Uri;
  includes: ModuleSerializationInclude[];
  pathConfigs: ModuleSerializationPathConfig[];
}

interface ModulePrincipalPredicate {
  domain?: string;
  pattern?: string;
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

interface ModuleItemsListRow {
  itemPath: string;
  status: 'Serialized directly' | 'Serialized indirectly';
  includeOrRule: string;
  yamlPath: string;
  itemId?: string;
}

interface ModuleItemsListingData {
  moduleName: string;
  description?: string;
  references?: string[];
  masterItems: ModuleItemsListRow[];
  coreItems: ModuleItemsListRow[];
  roleItems: ModuleItemsListRow[];
  userItems: ModuleItemsListRow[];
}

interface ModuleItemsCacheEntry {
  md5: string;
  data: ModuleItemsListingData;
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
  private moduleItemsListingCache: Map<string, ModuleItemsCacheEntry> = new Map();
  private readonly perfStats: Map<string, { count: number; totalMs: number; minMs: number; maxMs: number; lastMs: number }> = new Map();
  private expansionTraceCounter = 0;
  private reconcileInFlightByPath: Map<string, Promise<void>> = new Map();

  constructor() {
    this.client = new AuthoringGraphqlClient();
    const config = vscode.workspace.getConfiguration('sitecoreSerializationViewer');
    this.selectedDatabase = config.get<string>('defaultDatabase') || 'master';
    this.client.setDatabase(this.selectedDatabase);
  }

  private withTiming<T>(operation: string, action: () => PromiseLike<T> | T, traceId?: string, extra?: string): Promise<T> {
    const startedAt = Date.now();

    const finalize = (status: 'ok' | 'error') => {
      const durationMs = Date.now() - startedAt;
      this.recordPerf(operation, durationMs, traceId, `${status}${extra ? ` | ${extra}` : ''}`);
    };

    try {
      const result = action();
      if (result && typeof (result as PromiseLike<T>).then === 'function') {
        return Promise.resolve(result).then(value => {
          finalize('ok');
          return value;
        }).catch(error => {
          finalize('error');
          throw error;
        });
      }

      finalize('ok');
      return Promise.resolve(result);
    } catch (error) {
      finalize('error');
      return Promise.reject(error);
    }
  }

  private recordPerf(operation: string, durationMs: number, traceId?: string, detail?: string): void {
    if (!isPerfTracingEnabled()) {
      return;
    }

    const existing = this.perfStats.get(operation);
    if (!existing) {
      this.perfStats.set(operation, {
        count: 1,
        totalMs: durationMs,
        minMs: durationMs,
        maxMs: durationMs,
        lastMs: durationMs
      });
    } else {
      existing.count += 1;
      existing.totalMs += durationMs;
      existing.minMs = Math.min(existing.minMs, durationMs);
      existing.maxMs = Math.max(existing.maxMs, durationMs);
      existing.lastMs = durationMs;
    }

    const stats = this.perfStats.get(operation)!;
    const averageMs = stats.totalMs / stats.count;
    const prefix = traceId ? `[${traceId}] ` : '';
    const suffix = detail ? ` | ${detail}` : '';
    appendPerfLine(
      `${prefix}${operation}: ${durationMs.toFixed(1)}ms (avg ${averageMs.toFixed(1)}ms over ${stats.count}, min ${stats.minMs.toFixed(1)}ms, max ${stats.maxMs.toFixed(1)}ms)${suffix}`
    );
  }

  private nextTraceId(basePath: string): string {
    this.expansionTraceCounter += 1;
    return `expand-${this.expansionTraceCounter}-${basePath}`;
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

  async getModuleItemsListingByJsonPath(jsonFilePath: string): Promise<ModuleItemsListingData | undefined> {
    const jsonUri = await this.resolveModuleJsonUri(jsonFilePath);
    if (!jsonUri) {
      return undefined;
    }

    let jsonBytes: Uint8Array;
    let moduleJson: {
      namespace?: string;
      description?: string;
      references?: string[];
      roles?: ModulePrincipalPredicate[];
      users?: ModulePrincipalPredicate[];
      items?: { includes?: ModuleSerializationInclude[] };
    };

    try {
      jsonBytes = await vscode.workspace.fs.readFile(jsonUri);
      moduleJson = JSON.parse(Buffer.from(jsonBytes).toString('utf8')) as {
        namespace?: string;
        description?: string;
        references?: string[];
        roles?: ModulePrincipalPredicate[];
        users?: ModulePrincipalPredicate[];
        items?: { includes?: ModuleSerializationInclude[] };
      };
    } catch {
      return undefined;
    }

    const jsonPathKey = jsonUri.fsPath.toLowerCase();
    const jsonMd5 = this.computeMd5(jsonBytes);
    const cachedEntry = this.moduleItemsListingCache.get(jsonPathKey);
    if (cachedEntry && cachedEntry.md5 === jsonMd5) {
      return cachedEntry.data;
    }

    const includes = Array.isArray(moduleJson.items?.includes)
      ? moduleJson.items.includes.filter(include => typeof include?.path === 'string' && include.path.trim().length > 0)
      : [];
    const moduleName = moduleJson.namespace?.trim();
    if (!moduleName || includes.length === 0) {
      return undefined;
    }

    const source: ModuleSerializationSource = {
      moduleName,
      description: moduleJson.description,
      references: this.normalizeReferences(moduleJson.references),
      roles: this.normalizePrincipalPredicates(moduleJson.roles),
      users: this.normalizePrincipalPredicates(moduleJson.users),
      jsonUri,
      rootUri: vscode.Uri.file(path.dirname(jsonUri.fsPath)),
      includes,
      pathConfigs: this.flattenPathConfigs(includes)
    };

    const itemYamlPattern = new vscode.RelativePattern(source.rootUri, 'items/**/*.{yml,yaml}');
    const itemYamlUris = await vscode.workspace.findFiles(itemYamlPattern);
    const contentYamlUris: vscode.Uri[] = [];
    const roleYamlUris: vscode.Uri[] = [];
    const userYamlUris: vscode.Uri[] = [];

    for (const yamlUri of itemYamlUris) {
      const relativeYamlPath = path.relative(source.rootUri.fsPath, yamlUri.fsPath).replace(/\\/g, '/').toLowerCase();
      if (this.isPrincipalSerializationPath(relativeYamlPath, 'Role')) {
        roleYamlUris.push(yamlUri);
        continue;
      }

      if (this.isPrincipalSerializationPath(relativeYamlPath, 'User')) {
        userYamlUris.push(yamlUri);
        continue;
      }

      contentYamlUris.push(yamlUri);
    }

    const rowsByPathByDatabase = {
      master: new Map<string, ModuleItemsListRow>(),
      core: new Map<string, ModuleItemsListRow>()
    };

    for (const yamlUri of contentYamlUris) {
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

      const matches = this.getModulePathMatchesByDatabase(parsed.path, source.pathConfigs);
      if (matches.length === 0) {
        continue;
      }

      for (const entry of matches) {
        const rowsByPath = entry.database === 'core'
          ? rowsByPathByDatabase.core
          : rowsByPathByDatabase.master;
        const normalizedPath = this.normalizePath(parsed.path);
        const current = rowsByPath.get(normalizedPath);
        const nextStatus: 'Serialized directly' | 'Serialized indirectly' =
          entry.match.status === SerializationStatus.Direct ? 'Serialized directly' : 'Serialized indirectly';
        const nextRow: ModuleItemsListRow = {
          itemPath: normalizedPath,
          status: nextStatus,
          includeOrRule: this.getIncludeOrRuleLabel(entry.match.config),
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
    }

    const roleItems = await this.buildPrincipalRows(roleYamlUris, source.rootUri, source.roles, 'Role');
    const userItems = await this.buildPrincipalRows(userYamlUris, source.rootUri, source.users, 'User');

    const masterItems = Array.from(rowsByPathByDatabase.master.values()).sort((a, b) => a.itemPath.localeCompare(b.itemPath));
    const coreItems = Array.from(rowsByPathByDatabase.core.values()).sort((a, b) => a.itemPath.localeCompare(b.itemPath));

    const listingData: ModuleItemsListingData = {
      moduleName: source.moduleName,
      description: source.description,
      references: source.references,
      masterItems,
      coreItems,
      roleItems,
      userItems
    };

    this.moduleItemsListingCache.set(jsonPathKey, {
      md5: jsonMd5,
      data: listingData
    });

    return listingData;
  }

  private computeMd5(content: Uint8Array): string {
    return createHash('md5').update(Buffer.from(content)).digest('hex');
  }

  private async resolveModuleJsonUri(jsonFilePath: string): Promise<vscode.Uri | undefined> {
    const workspaceRoot = this.getWorkspaceRootPath();
    const candidatePaths = path.isAbsolute(jsonFilePath)
      ? [jsonFilePath]
      : workspaceRoot ? [jsonFilePath, path.join(workspaceRoot, jsonFilePath)] : [jsonFilePath];

    for (const candidatePath of candidatePaths) {
      const candidateUri = vscode.Uri.file(candidatePath);
      try {
        await vscode.workspace.fs.stat(candidateUri);
        return candidateUri;
      } catch {
        // Ignore missing candidate and continue.
      }
    }

    const sources = await this.loadModuleSerializationSources();
    const normalizedCandidates = candidatePaths.map(p => p.replace(/\\/g, '/').toLowerCase());
    const normalizedInput = jsonFilePath.replace(/\\/g, '/').toLowerCase();
    const source = sources.find(s => {
      const normalizedSource = s.jsonUri.fsPath.replace(/\\/g, '/').toLowerCase();
      return normalizedCandidates.includes(normalizedSource) || normalizedSource.endsWith(normalizedInput);
    });

    return source?.jsonUri;
  }

  private async buildPrincipalRows(
    yamlUris: vscode.Uri[],
    rootUri: vscode.Uri,
    predicates: ModulePrincipalPredicate[],
    principalType: 'Role' | 'User'
  ): Promise<ModuleItemsListRow[]> {
    const rowsByPrincipal = new Map<string, ModuleItemsListRow>();

    for (const yamlUri of yamlUris) {
      let content = '';
      try {
        const bytes = await vscode.workspace.fs.readFile(yamlUri);
        content = Buffer.from(bytes).toString('utf8');
      } catch {
        continue;
      }

      const parsed = this.parsePrincipalYamlMetadata(content, principalType);
      const relativeYamlPath = path.relative(rootUri.fsPath, yamlUri.fsPath).replace(/\\/g, '/');
      const principal = parsed.principal || this.derivePrincipalFromRelativePath(relativeYamlPath, principalType);
      if (!principal) {
        continue;
      }

      const predicateLabel = this.getMatchingPrincipalPredicateLabel(principal, predicates) || `${principalType} serialization`;
      const normalizedPrincipal = principal.toLowerCase();
      const nextRow: ModuleItemsListRow = {
        itemPath: principal,
        status: 'Serialized directly',
        includeOrRule: predicateLabel,
        yamlPath: yamlUri.fsPath,
        itemId: parsed.id
      };

      const existing = rowsByPrincipal.get(normalizedPrincipal);
      if (!existing) {
        rowsByPrincipal.set(normalizedPrincipal, nextRow);
      }
    }

    return Array.from(rowsByPrincipal.values()).sort((a, b) => a.itemPath.localeCompare(b.itemPath));
  }

  private parsePrincipalYamlMetadata(content: string, principalType: 'Role' | 'User'): { principal?: string; id?: string } {
    const lines = content.split(/\r?\n/);
    const primaryKey = principalType === 'Role' ? 'Role' : 'UserName';
    const inlineId = this.extractYamlScalarValue(lines, 'ID');
    const directPrincipal = this.extractYamlScalarValue(lines, primaryKey);
    if (directPrincipal) {
      return { principal: directPrincipal, id: inlineId };
    }

    const roleNamePrincipal = principalType === 'Role'
      ? this.extractYamlScalarValue(lines, 'RoleName')
      : undefined;
    if (roleNamePrincipal) {
      return { principal: roleNamePrincipal, id: inlineId };
    }

    const pathValue = this.extractYamlScalarValue(lines, 'Path');
    return {
      principal: pathValue ? this.derivePrincipalFromPath(pathValue) : undefined,
      id: inlineId
    };
  }

  private extractYamlScalarValue(lines: string[], key: string): string | undefined {
    const keyRegex = new RegExp(`^(\\s*)${key}:\\s*(.*)$`, 'i');

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(keyRegex);
      if (!match) {
        continue;
      }

      const baseIndent = match[1].length;
      const rawValue = match[2].trim();
      if (rawValue.length > 0 && !/^[>|][+-]?$/u.test(rawValue)) {
        return rawValue.replace(/^['"]|['"]$/g, '').trim();
      }

      const blockLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        const nextMatch = nextLine.match(/^(\s*)(.*)$/);
        if (!nextMatch) {
          continue;
        }

        const nextIndent = nextMatch[1].length;
        const nextContent = nextMatch[2];
        if (nextContent.trim().length > 0 && nextIndent <= baseIndent) {
          break;
        }

        if (nextContent.trim().length === 0) {
          if (blockLines.length > 0) {
            blockLines.push('');
          }
          continue;
        }

        blockLines.push(nextLine.slice(Math.min(nextLine.length, baseIndent + 2)).trimEnd());
      }

      const blockValue = blockLines.join('\n').trim();
      if (blockValue.length > 0) {
        return blockValue;
      }
    }

    return undefined;
  }

  private derivePrincipalFromPath(pathValue: string): string {
    const normalizedPath = this.normalizePath(pathValue);
    const segments = normalizedPath.split('/').filter(segment => segment.length > 0);
    if (segments.length === 0) {
      return normalizedPath;
    }

    const domainsIndex = segments.findIndex(segment => segment.toLowerCase() === 'domains');
    if (domainsIndex >= 0 && segments.length > domainsIndex + 2) {
      const domain = segments[domainsIndex + 1];
      const principalName = segments.slice(domainsIndex + 2).join('\\');
      return `${domain}\\${principalName}`;
    }

    return segments[segments.length - 1];
  }

  private derivePrincipalFromRelativePath(relativePath: string, principalType: 'Role' | 'User'): string | undefined {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalizedPath.split('/').filter(segment => segment.length > 0);
    const principalFolder = principalType === 'Role' ? '_roles' : '_users';
    const principalIndex = segments.findIndex(segment => segment.toLowerCase() === principalFolder);
    if (principalIndex < 0 || segments.length <= principalIndex + 2) {
      return undefined;
    }

    const domain = segments[principalIndex + 1];
    const principalSegments = segments.slice(principalIndex + 2);
    if (principalSegments.length === 0) {
      return undefined;
    }

    const lastSegment = principalSegments[principalSegments.length - 1];
    principalSegments[principalSegments.length - 1] = lastSegment.replace(/\.(yml|yaml)$/i, '');
    return `${domain}\\${principalSegments.join('\\')}`;
  }

  private isPrincipalSerializationPath(relativePath: string, principalType: 'Role' | 'User'): boolean {
    const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();
    if (principalType === 'Role') {
      return normalizedPath.includes('/_roles/');
    }

    return normalizedPath.includes('/_users/');
  }

  private getMatchingPrincipalPredicateLabel(principal: string, predicates: ModulePrincipalPredicate[]): string | undefined {
    const [domainRaw, ...rest] = principal.split('\\');
    const domain = (rest.length > 0 ? domainRaw : '').toLowerCase();
    const principalName = (rest.length > 0 ? rest.join('\\') : principal).toLowerCase();

    for (const predicate of predicates) {
      const predicateDomain = (predicate.domain || '').trim().toLowerCase();
      const predicatePattern = (predicate.pattern || '').trim();
      if (!predicatePattern) {
        continue;
      }

      if (predicateDomain && predicateDomain !== domain) {
        continue;
      }

      const regex = this.toWildcardRegex(predicatePattern);
      if (!regex.test(principalName)) {
        continue;
      }

      return `${predicate.domain || '*'}\\${predicate.pattern}`;
    }

    return undefined;
  }

  private toWildcardRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    return new RegExp(`^${escaped}$`, 'i');
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

  private async getRawChildren(basePath: string, requestGeneration: number, traceId?: string): Promise<SitecoreItem[]> {
    if (this.cache.has(basePath)) {
      this.recordPerf('tree.rawChildren.cacheHit', 0, traceId, `path=${basePath}`);
      return this.cache.get(basePath) || [];
    }

    let items: SitecoreItem[] = [];
    try {
      const result = await this.withTiming(
        'tree.graphql.getChildren.total',
        () => this.client.getChildren(basePath, traceId),
        traceId,
        `path=${basePath}`
      );
      items = await this.withTiming(
        'tree.children.filterSelfReference',
        () => (result || []).filter((item: SitecoreItem) => item.path !== basePath),
        traceId,
        `path=${basePath}; input=${result?.length ?? 0}`
      );

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
    this.recordPerf('tree.rawChildren.cacheStore', 0, traceId, `path=${basePath}; count=${items.length}`);
    this.startBackgroundReconcile(basePath, items, requestGeneration, traceId);
    return items;
  }

  private startBackgroundReconcile(basePath: string, items: SitecoreItem[], requestGeneration: number, traceId?: string): void {
    const hasCandidates = items.some(item => item.status === SerializationStatus.Indirect || item.status === SerializationStatus.Untracked);
    if (!hasCandidates) {
      return;
    }

    if (this.reconcileInFlightByPath.has(basePath)) {
      this.recordPerf('tree.children.reconcileStatuses.background.skippedInFlight', 0, traceId, `path=${basePath}`);
      return;
    }

    const reconcilePromise = (async () => {
      const reconciled = await this.withTiming(
        'tree.children.reconcileStatuses.background',
        () => this.reconcileIndirectStatuses(items, traceId),
        traceId,
        `path=${basePath}; count=${items.length}`
      );

      if (requestGeneration !== this.loadGeneration) {
        this.recordPerf('tree.children.reconcileStatuses.background.discardedGeneration', 0, traceId, `path=${basePath}`);
        return;
      }

      const current = this.cache.get(basePath);
      if (!current || current.length !== reconciled.length) {
        return;
      }

      let changed = false;
      for (let i = 0; i < current.length; i++) {
        if (current[i].status !== reconciled[i].status) {
          changed = true;
          break;
        }
      }

      if (!changed) {
        this.recordPerf('tree.children.reconcileStatuses.background.noChanges', 0, traceId, `path=${basePath}`);
        return;
      }

      this.cache.set(basePath, reconciled);
      this.recordPerf('tree.children.reconcileStatuses.background.applied', 0, traceId, `path=${basePath}`);
      this._onDidChangeTreeData.fire();
    })().catch(error => {
      console.warn(`Background reconcile failed for path ${basePath}:`, error);
      this.recordPerf('tree.children.reconcileStatuses.background.error', 0, traceId, `path=${basePath}`);
    });

    this.reconcileInFlightByPath.set(basePath, reconcilePromise.finally(() => {
      this.reconcileInFlightByPath.delete(basePath);
    }));
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
        roles?: ModulePrincipalPredicate[];
        users?: ModulePrincipalPredicate[];
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
        roles: this.normalizePrincipalPredicates(json?.roles),
        users: this.normalizePrincipalPredicates(json?.users),
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

  private getModulePathMatchForDatabase(
    itemPath: string,
    pathConfigs: ModuleSerializationPathConfig[],
    database: 'master' | 'core'
  ): ModulePathMatch | undefined {
    const normalizedItemPath = this.normalizePath(itemPath).toLowerCase();
    let bestMatch: ModulePathMatch | undefined;

    for (const config of pathConfigs) {
      if (!config.path) {
        continue;
      }

      const configDatabase = (config.database || 'master').toLowerCase();
      if (configDatabase !== database) {
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

  private getModulePathMatchesByDatabase(
    itemPath: string,
    pathConfigs: ModuleSerializationPathConfig[]
  ): Array<{ database: 'master' | 'core'; match: ModulePathMatch }> {
    const results: Array<{ database: 'master' | 'core'; match: ModulePathMatch }> = [];
    const masterMatch = this.getModulePathMatchForDatabase(itemPath, pathConfigs, 'master');
    if (masterMatch) {
      results.push({ database: 'master', match: masterMatch });
    }

    const coreMatch = this.getModulePathMatchForDatabase(itemPath, pathConfigs, 'core');
    if (coreMatch) {
      results.push({ database: 'core', match: coreMatch });
    }

    return results;
  }

  private normalizePrincipalPredicates(predicates: unknown): ModulePrincipalPredicate[] {
    if (!Array.isArray(predicates)) {
      return [];
    }

    return predicates
      .filter(predicate => typeof predicate === 'object' && predicate !== null)
      .map(predicate => {
        const rolePredicate = predicate as { domain?: unknown; pattern?: unknown };
        const domain = typeof rolePredicate.domain === 'string' ? rolePredicate.domain.trim() : undefined;
        const pattern = typeof rolePredicate.pattern === 'string' ? rolePredicate.pattern.trim() : undefined;
        return {
          domain,
          pattern
        };
      })
      .filter(predicate => !!predicate.pattern);
  }

  private async findModuleRootDirs(moduleName: string): Promise<vscode.Uri[]> {
    const source = await this.getModuleSerializationSource(moduleName);
    if (!source) {
      return [];
    }

    return [source.rootUri];
  }

  private async ensureModuleYamlTreeLoaded(requestGeneration: number, traceId?: string): Promise<void> {
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
      const yamlUris = await this.withTiming(
        'moduleYaml.findFiles',
        () => vscode.workspace.findFiles(yamlPattern),
        traceId,
        `root=${rootDir.fsPath}`
      );

      for (const yamlUri of yamlUris) {
        if (requestGeneration !== this.loadGeneration) {
          return;
        }

        let content = '';
        try {
          const bytes = await this.withTiming(
            'moduleYaml.readFile',
            () => vscode.workspace.fs.readFile(yamlUri),
            traceId,
            `file=${yamlUri.fsPath}`
          );
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

  private async buildDisplayedChildren(basePath: string, requestGeneration: number, displayedParentPath: string, traceId?: string): Promise<SitecoreItem[]> {
    if (this.isModuleFilterActive()) {
      await this.withTiming(
        'tree.moduleYaml.ensureLoaded',
        () => this.ensureModuleYamlTreeLoaded(requestGeneration, traceId),
        traceId,
        `basePath=${basePath}`
      );
      const children = this.moduleYamlChildrenByPath.get(basePath) || [];
      for (const item of children) {
        this.parentPathByPath.set(item.path, displayedParentPath);
      }
      return children;
    }

    const rawChildren = await this.withTiming(
      'tree.rawChildren.total',
      () => this.getRawChildren(basePath, requestGeneration, traceId),
      traceId,
      `basePath=${basePath}`
    );
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
        await this.withTiming('tree.root.moduleYaml.ensureLoaded', () => this.ensureModuleYamlTreeLoaded(requestGeneration));
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
    const traceId = this.nextTraceId(basePath);
    showPerfOutput(true);
    appendPerfLine(`[${traceId}] expand.request path=${basePath}; database=${this.selectedDatabase}; module=${this.selectedModule}`);

    return this.withTiming('tree.expand.total', async () => {
      const displayedItems = await this.withTiming(
        'tree.buildDisplayedChildren.total',
        () => this.buildDisplayedChildren(basePath, requestGeneration, basePath, traceId),
        traceId,
        `path=${basePath}`
      );

      const treeItems = await this.withTiming(
        'tree.createTreeItems',
        () => displayedItems.map(item => this.createTreeItem(item)),
        traceId,
        `count=${displayedItems.length}`
      );

      appendPerfLine(`[${traceId}] expand.result path=${basePath}; children=${treeItems.length}`);
      return treeItems;
    }, traceId, `path=${basePath}`);
  }

  resetFromScratch(): void {
    const config = vscode.workspace.getConfiguration('sitecoreSerializationViewer');
    this.selectedDatabase = config.get<string>('defaultDatabase') || 'master';
    this.selectedModule = 'All modules';
    this.refresh({ resetState: true });
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
    this.moduleItemsListingCache.clear();
    this.reconcileInFlightByPath.clear();

    if (options?.resetState) {
      this.loadGeneration += 1;
      this.client.reset();
      this.client.setDatabase(this.selectedDatabase);
      this.availableModulesCache = undefined;
      this.moduleSerializationSourceCache.clear();
    }

    this._onDidChangeTreeData.fire();
  }

  private async reconcileIndirectStatuses(items: SitecoreItem[], traceId?: string): Promise<SitecoreItem[]> {
    const updated = [...items];
    const candidates: Array<{ index: number; item: SitecoreItem }> = [];

    for (let i = 0; i < updated.length; i++) {
      const item = updated[i];
      // Reconcile both Indirect items (may need downgrade) and Untracked items
      // (may have been missed by the embedded config but are included by a live module JSON).
      if (item.status !== SerializationStatus.Indirect && item.status !== SerializationStatus.Untracked) {
        continue;
      }

      candidates.push({ index: i, item });
    }

    const explainCalls = candidates.length;
    this.recordPerf('tree.explain.resolveStatus.calls', 0, traceId, `calls=${explainCalls}`);

    if (candidates.length === 0) {
      return updated;
    }

    const maxConcurrency = Math.min(3, candidates.length);
    let nextCandidate = 0;

    await this.withTiming('tree.explain.resolveStatus.parallelBatch', async () => {
      const workers = Array.from({ length: maxConcurrency }, async () => {
        while (nextCandidate < candidates.length) {
          const currentIndex = nextCandidate;
          nextCandidate += 1;
          const candidate = candidates[currentIndex];

          const resolvedStatus = await this.withTiming(
            'tree.explain.resolveStatus',
            () => this.getExplainBasedStatus(candidate.item.path),
            traceId,
            `path=${candidate.item.path}`
          );

          if (resolvedStatus && resolvedStatus !== candidate.item.status) {
            updated[candidate.index] = {
              ...candidate.item,
              status: resolvedStatus
            };
          }
        }
      });

      await Promise.all(workers);
    }, traceId, `calls=${candidates.length}; concurrency=${maxConcurrency}`);

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
      const text = `${stdout || ''}\n${stderr || ''}`;
      const textLower = text.toLowerCase();

      if (/not included in any module configuration|\bnot included[.!]?/i.test(textLower)) {
        this.explainStatusCache.set(itemPath, SerializationStatus.NotSerialized);
        return SerializationStatus.NotSerialized;
      }

      if (/\bis included[.!]?/i.test(text)) {
        const isDirect = /item path matches subtree scope/i.test(text);
        const resolvedStatus = isDirect ? SerializationStatus.Direct : SerializationStatus.Indirect;
        this.explainStatusCache.set(itemPath, resolvedStatus);
        return resolvedStatus;
      }

      // No definitive signal — keep original status.
      return undefined;
    } catch {
      // Keep original status if explain cannot run.
      return undefined;
    }
  }
}