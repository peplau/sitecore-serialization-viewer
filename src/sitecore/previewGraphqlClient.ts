import * as vscode from 'vscode';
import { SitecoreItem, SerializationStatus } from '../tree/models';
import { SerializationConfigService } from './serializationConfigService';
import { appendPerfLine } from '../perfOutput';

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ItemResult {
  itemId: string;
  name: string;
  path: string;
  iconField?: {
    value?: string;
  };
  fields?: {
    nodes: Array<{
      name?: string;
      value?: string;
    }>;
  };
  template?: {
    name?: string;
    icon?: string;
  };
  children?: {
    nodes: Array<{ itemId: string }>;
  };
}

interface ItemChildrenResponse {
  item?: {
    itemId: string;
    name: string;
    path: string;
    children?: {
      nodes: ItemResult[];
    };
  };
}

interface ItemByPathResponse {
  item?: ItemResult;
}

export class AuthoringGraphqlClient {
  private static readonly defaultItemIconPath = '/sitecore/shell/-/icon/Applications/16x16/Document.png.aspx';
  private endpoint: string | undefined;
  private baseHeaders: Record<string, string> | undefined;
  private language: string = 'en';
  private database: string = 'master';
  private endpointName: string = 'xmCloud';
  private cachedAuthToken: string | undefined;
  private authTokenCacheLoadedAt = 0;
  private authTokenCacheInitialized = false;
  private readonly authTokenCacheTtlMs = 30000;

  private async withTiming<T>(operation: string, action: () => PromiseLike<T> | T, traceId?: string, detail?: string): Promise<T> {
    const startedAt = Date.now();

    const finish = (status: 'ok' | 'error') => {
      const durationMs = Date.now() - startedAt;
      const prefix = traceId ? `[${traceId}] ` : '';
      const suffix = detail ? ` | ${detail}` : '';
      appendPerfLine(`${prefix}${operation}: ${durationMs.toFixed(1)}ms | ${status}${suffix}`);
    };

    try {
      const result = action();
      if (result && typeof (result as PromiseLike<T>).then === 'function') {
        return Promise.resolve(result).then(value => {
          finish('ok');
          return value;
        }).catch(error => {
          finish('error');
          throw error;
        });
      }

      finish('ok');
      return Promise.resolve(result);
    } catch (error) {
      finish('error');
      return Promise.reject(error);
    }
  }

  setDatabase(database: string): void {
    this.database = database || 'master';
  }

  getDatabase(): string {
    return this.database;
  }

  reset(): void {
    this.endpoint = undefined;
    this.baseHeaders = undefined;
    this.language = 'en';
    this.database = 'master';
    this.endpointName = 'xmCloud';
    this.cachedAuthToken = undefined;
    this.authTokenCacheLoadedAt = 0;
    this.authTokenCacheInitialized = false;
  }

  private async getCachedSitecoreAccessToken(): Promise<string | undefined> {
    const now = Date.now();
    const isFresh = this.authTokenCacheInitialized && (now - this.authTokenCacheLoadedAt) < this.authTokenCacheTtlMs;
    if (isFresh) {
      return this.cachedAuthToken;
    }

    this.cachedAuthToken = await this.loadSitecoreAccessToken();
    this.authTokenCacheLoadedAt = now;
    this.authTokenCacheInitialized = true;
    return this.cachedAuthToken;
  }

  private async buildRequestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      ...(this.baseHeaders ?? { 'Content-Type': 'application/json' })
    };

    const authToken = await this.getCachedSitecoreAccessToken();
    if (!authToken) {
      delete headers.Authorization;
      return headers;
    }

    const tokenText = authToken.trim();
    headers.Authorization = /^Bearer\s+/i.test(tokenText)
      ? tokenText
      : `Bearer ${tokenText}`;
    return headers;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.endpoint !== undefined) {
      return;
    } // Already initialized

    const config = vscode.workspace.getConfiguration('sitecoreSerializationViewer');
    const explicitUrl = config.get<string>('authoringGraphqlUrl');

    // Read from .env.local file in workspace
    const envVars = await this.loadEnvFile();
    const hostFromEnv = envVars['SITECORE_EDGE_HOSTNAME'];
    const contextId = config.get<string>('edgeContextId') || envVars['SITECORE_EDGE_CONTEXT_ID'];
    this.endpointName = config.get<string>('endpoint') || envVars['ENDPOINT'] || 'xmCloud';
    this.language = config.get<string>('defaultLanguage') || envVars['LANGUAGE'] || 'en';
    this.database = this.database || config.get<string>('defaultDatabase') || envVars['DATABASE'] || 'master';

    if (explicitUrl && explicitUrl.trim().length > 0) {
      this.endpoint = explicitUrl.trim();
    } else if (hostFromEnv && hostFromEnv.trim().length > 0) {
      // Host may be provided as a full host or full URL; handle both cases
      const hostText = hostFromEnv.trim();
      if (/^https?:\/\//i.test(hostText)) {
        const url = new URL(hostText);
        // append /sitecore/api/authoring/graphql/v1 if missing
        if (!url.pathname.endsWith('/sitecore/api/authoring/graphql/v1')) {
          url.pathname = '/sitecore/api/authoring/graphql/v1';
          url.search = '';
        }
        this.endpoint = url.toString();
      } else {
        this.endpoint = `https://${hostText}/sitecore/api/authoring/graphql/v1`;
      }
    } else {
      this.endpoint = undefined;
    }

    this.baseHeaders = {
      'Content-Type': 'application/json',
      ...(contextId ? { 'SC-Edge-Context-Id': contextId } : {})
    };
  }

  private async loadEnvFile(): Promise<Record<string, string>> {
    const envVars: Record<string, string> = {};

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      return envVars;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri;
    const envFileUri = vscode.Uri.joinPath(workspaceRoot, '.env.local');

    try {
      const envFileContent = await vscode.workspace.fs.readFile(envFileUri);
      const content = Buffer.from(envFileContent).toString('utf8');

      // Simple .env parser (handles basic key=value pairs, ignores comments and empty lines)
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const equalsIndex = trimmed.indexOf('=');
          if (equalsIndex > 0) {
            const key = trimmed.substring(0, equalsIndex).trim();
            const value = trimmed.substring(equalsIndex + 1).trim();
            // Remove surrounding quotes if present
            const cleanValue = value.replace(/^["']|["']$/g, '');
            envVars[key] = cleanValue;
          }
        }
      }
    } catch (error) {
      // File doesn't exist or can't be read - that's ok, we'll use defaults
      console.log('Could not read .env.local file:', error);
    }

    return envVars;
  }

  private async loadSitecoreAccessToken(): Promise<string | undefined> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      return undefined;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri;
    const userJsonUri = vscode.Uri.joinPath(workspaceRoot, '.sitecore', 'user.json');

    try {
      const userJsonContent = await vscode.workspace.fs.readFile(userJsonUri);
      const content = Buffer.from(userJsonContent).toString('utf8');
      const parsed = JSON.parse(content) as {
        accessToken?: unknown;
        endpoints?: Record<string, { accessToken?: unknown } | unknown>;
      };

      // Primary expected shape: .sitecore/user.json -> endpoints -> <endpointName> -> accessToken
      const targetEndpoint =
        parsed.endpoints &&
        typeof parsed.endpoints === 'object'
          ? (parsed.endpoints as Record<string, unknown>)[this.endpointName]
          : undefined;
      const namedAccessToken =
        targetEndpoint &&
        typeof targetEndpoint === 'object' &&
        targetEndpoint !== null &&
        'accessToken' in targetEndpoint
          ? (targetEndpoint as { accessToken?: unknown }).accessToken
          : undefined;

      if (typeof namedAccessToken === 'string' && namedAccessToken.trim().length > 0) {
        return namedAccessToken.trim();
      }

      // Backward-compatible fallback: top-level accessToken
      if (typeof parsed.accessToken === 'string' && parsed.accessToken.trim().length > 0) {
        return parsed.accessToken.trim();
      }

      // Fallback: first endpoint object that contains an accessToken
      if (parsed.endpoints && typeof parsed.endpoints === 'object') {
        for (const endpointValue of Object.values(parsed.endpoints)) {
          if (
            endpointValue &&
            typeof endpointValue === 'object' &&
            'accessToken' in endpointValue
          ) {
            const token = (endpointValue as { accessToken?: unknown }).accessToken;
            if (typeof token === 'string' && token.trim().length > 0) {
              return token.trim();
            }
          }
        }
      }
    } catch (error) {
      // File doesn't exist or can't be read/parsed.
      console.log('Could not read .sitecore/user.json file:', error);
    }

    return undefined;
  }

  private async executeQuery<T>(query: string, variables?: Record<string, unknown>, traceId?: string): Promise<T> {
    await this.withTiming('graphql.ensureInitialized', () => this.ensureInitialized(), traceId);

    if (!this.endpoint) {
      throw new Error('Authoring GraphQL endpoint not configured. Set sitecoreSerializationViewer.authoringGraphqlUrl or ensure .env.local has SITECORE_EDGE_HOSTNAME.');
    }

    const requestHeaders = await this.withTiming('graphql.buildHeaders', () => this.buildRequestHeaders(), traceId);

    console.log(`GraphQL request to: ${this.endpoint}`);

    const requestBody = JSON.stringify({ query, variables });
    const resp = await this.withTiming(
      'graphql.fetch',
      () => fetch(this.endpoint!, {
        method: 'POST',
        headers: requestHeaders,
        body: requestBody
      }),
      traceId,
      `endpoint=${this.endpoint}`
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`GraphQL request failed: ${resp.status} ${resp.statusText} - ${body}`);
    }

    const payload = await this.withTiming(
      'graphql.parseJson',
      async () => (await resp.json()) as GraphqlResponse<T>,
      traceId
    );
    if (payload.errors && payload.errors.length > 0) {
      const errorMsg = payload.errors.map(e => e.message).join('; ');
      if (errorMsg.toLowerCase().includes('not authorized') || errorMsg.toLowerCase().includes('unauthorized')) {
          throw new Error("Authorization denied: Please login again with 'dotnet sitecore cloud login'");
      }
      throw new Error(`GraphQL errors: ${errorMsg}`);
    }
    if (!payload.data) {
      throw new Error('GraphQL response missing data.');
    }

    return payload.data;
  }

  private mapItemResult(item: ItemResult): SitecoreItem {
    const serializationService = SerializationConfigService.getInstance();
    const serializationMatch = serializationService.checkSerializationStatus(item.path);
    const ownIconField = item.fields?.nodes?.find(field => (field.name || '').toLowerCase() === '__icon');
    const iconUrl = this.resolveSitecoreIconUrl(item.iconField?.value || ownIconField?.value || item.template?.icon)
      || this.getDefaultItemIconUrl();

    // If children field is not defined in GraphQL response, assume item might have children (be optimistic).
    // If children field is defined but empty, trust that it has no children.
    // This allows expansion even if GraphQL doesn't return child info for certain items.
    const childrenFieldDefined = item.children !== undefined;
    const childCount = item.children?.nodes?.length ?? 0;
    const hasChildren = childrenFieldDefined ? (childCount > 0) : true;

    return {
      id: item.itemId,
      name: item.name,
      path: item.path,
      iconUrl,
      templateId: undefined,
      templateName: item.template?.name,
      sortOrder: undefined,
      displayName: undefined,
      hasChildren,
      status: serializationMatch?.status ?? SerializationStatus.Untracked,
      yamlPath: serializationMatch?.yamlPath,
      matchedModule: serializationMatch?.moduleName,
      moduleDescription: serializationMatch?.moduleDescription,
      moduleJsonPath: serializationMatch ? serializationService.resolveModuleJsonPath(serializationMatch.moduleName) : undefined,
      subtreeKey: serializationMatch?.subtreeKey,
      subtreePath: serializationMatch?.subtreePath,
      subtreeScope: serializationMatch?.subtreeScope,
      subtreePushOperations: serializationMatch?.subtreePushOperations,
      subtreeDatabase: serializationMatch?.subtreeDatabase
    };
  }

  private resolveSitecoreIconUrl(iconValue: string | undefined): string | undefined {
    const raw = (iconValue || '').trim();
    if (!raw) {
      return undefined;
    }

    if (/^https?:\/\//i.test(raw)) {
      return raw;
    }

    if (/^data:/i.test(raw)) {
      return raw;
    }

    if (!this.endpoint) {
      return undefined;
    }

    let origin: string;
    try {
      origin = new URL(this.endpoint).origin;
    } catch {
      return undefined;
    }

    const normalizedRaw = raw.replace(/\\/g, '/');

    // Sitecore commonly returns icon values as ~/icon/...; map that to /-/icon/...
    if (/^~\/icon\//i.test(normalizedRaw)) {
      const suffix = normalizedRaw.replace(/^~\/icon\//i, '');
      return `${origin}/-/icon/${suffix}`;
    }

    if (/^\/~\/icon\//i.test(normalizedRaw)) {
      const suffix = normalizedRaw.replace(/^\/~\/icon\//i, '');
      return `${origin}/-/icon/${suffix}`;
    }

    // Already in the expected icon route.
    if (/^\/-\/icon\//i.test(normalizedRaw)) {
      return `${origin}${normalizedRaw}`;
    }

    // Absolute site-relative paths can be used as-is.
    if (/^\//.test(normalizedRaw)) {
      return `${origin}${normalizedRaw}`;
    }

    const normalized = normalizedRaw
      .replace(/^icon\//i, '')
      .replace(/^\/+/, '');

    if (!normalized) {
      return undefined;
    }

    return `${origin}/-/icon/${normalized}`;
  }

  getDefaultItemIconUrl(): string | undefined {
    if (!this.endpoint) {
      return undefined;
    }

    try {
      const origin = new URL(this.endpoint).origin;
      return `${origin}${AuthoringGraphqlClient.defaultItemIconPath}`;
    } catch {
      return undefined;
    }
  }

  private isTemplateResolutionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('Cannot resolve a template') || msg.includes("template doesn't exist");
  }

  async fetchIconAsDataUri(iconUrl: string): Promise<string | undefined> {
    try {
      await this.ensureInitialized();
      const headers = await this.buildRequestHeaders();
      const resp = await fetch(iconUrl, { method: 'GET', headers });
      if (!resp.ok) {
        return undefined;
      }
      const contentType = resp.headers.get('content-type') || 'image/png';
      const arrayBuffer = await resp.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mimeType = contentType.split(';')[0].trim();
      return `data:${mimeType};base64,${base64}`;
    } catch {
      return undefined;
    }
  }

  async getItemByPath(path: string): Promise<SitecoreItem | undefined> {
    const normalizedPath = path || '/sitecore';
    const selectedDatabase = this.database || 'master';

    const query = `query ItemByPath($path: String = "/sitecore", $database: String = "master") {\n  item(where: { path: $path, database: $database }) {\n    itemId\n    name\n    path\n    iconField: field(name: "__Icon") {\n      value\n    }\n    fields(ownFields: true) {\n      nodes {\n        name\n        value\n      }\n    }\n    template {\n      name\n      icon\n    }\n    children {\n      nodes {\n        itemId\n      }\n    }\n  }\n}`;    // Note: if template resolution fails for this item, the error will propagate. Single-item queries are less likely to hit broken templates.

    const data = await this.executeQuery<ItemByPathResponse>(query, {
      path: normalizedPath,
      database: selectedDatabase
    });

    return data.item ? this.mapItemResult(data.item) : undefined;
  }

  async getItemById(itemId: string): Promise<SitecoreItem | undefined> {
    const normalizedItemId = itemId.trim();
    const selectedDatabase = this.database || 'master';

    const query = `query ItemById($itemId: ID!, $database: String = "master") {\n  item(where: { itemId: $itemId, database: $database }) {\n    itemId\n    name\n    path\n    iconField: field(name: "__Icon") {\n      value\n    }\n    fields(ownFields: true) {\n      nodes {\n        name\n        value\n      }\n    }\n    template {\n      name\n      icon\n    }\n    children {\n      nodes {\n        itemId\n      }\n    }\n  }\n}`;    // Note: if template resolution fails for this item, the error will propagate. Single-item queries are less likely to hit broken templates.

    const data = await this.executeQuery<ItemByPathResponse>(query, {
      itemId: normalizedItemId,
      database: selectedDatabase
    });

    return data.item ? this.mapItemResult(data.item) : undefined;
  }

  async getChildren(path: string, traceId?: string): Promise<SitecoreItem[]> {
    const normalizedPath = path || '/sitecore';
    const selectedDatabase = this.database || 'master';

    const queryWithTemplate = `query ItemChildren($path: String = "/sitecore", $database: String = "master") {\n  item(where: { path: $path, database: $database }) {\n    itemId\n    name\n    path\n    children {\n      nodes {\n        itemId\n        name\n        path\n        iconField: field(name: "__Icon") {\n          value\n        }\n        fields(ownFields: true) {\n          nodes {\n            name\n            value\n          }\n        }\n        template {\n          name\n          icon\n        }\n        children {\n          nodes {\n            itemId\n          }\n        }\n      }\n    }\n  }\n}`;
    const queryWithoutTemplate = `query ItemChildren($path: String = "/sitecore", $database: String = "master") {\n  item(where: { path: $path, database: $database }) {\n    itemId\n    name\n    path\n    children {\n      nodes {\n        itemId\n        name\n        path\n        iconField: field(name: "__Icon") {\n          value\n        }\n        fields(ownFields: true) {\n          nodes {\n            name\n            value\n          }\n        }\n        children {\n          nodes {\n            itemId\n          }\n        }\n      }\n    }\n  }\n}`;

    const variables = { path: normalizedPath, database: selectedDatabase };
    let data: ItemChildrenResponse;
    try {
      data = await this.withTiming(
        'graphql.query.itemChildren',
        () => this.executeQuery<ItemChildrenResponse>(queryWithTemplate, variables, traceId),
        traceId,
        `path=${normalizedPath}; database=${selectedDatabase}`
      );
    } catch (error) {
      if (this.isTemplateResolutionError(error)) {
        // One or more children have broken templates — retry without template field so
        // those items still load (they'll use the __Icon field or default icon instead).
        console.warn(`Template resolution error for children of ${normalizedPath}, retrying without template field.`);
        data = await this.withTiming(
          'graphql.query.itemChildren.noTemplate',
          () => this.executeQuery<ItemChildrenResponse>(queryWithoutTemplate, variables, traceId),
          traceId,
          `path=${normalizedPath}; database=${selectedDatabase} (no-template retry)`
        );
      } else {
        throw error;
      }
    }
    const children = data.item?.children?.nodes || [];

    console.log(`GraphQL query for ${normalizedPath} (${selectedDatabase}): received ${children.length} children`);

    const items = await this.withTiming(
      'graphql.children.mapResult',
      () => children
        .filter(child => child.path !== normalizedPath) // Prevent self-reference
        .map(child => this.mapItemResult(child)),
      traceId,
      `path=${normalizedPath}; count=${children.length}`
    );

    // Sort by sortOrder (ascending), but handle -1 (unsorted) and other values
    // Then by name as tiebreaker
    return this.withTiming(
      'graphql.children.sort',
      () => items.sort((a, b) => {
        const aSort = a.sortOrder ?? -1;
        const bSort = b.sortOrder ?? -1;

        // Items with sortOrder -1 should appear based on their displayName or name
        if (aSort === -1 && bSort === -1) {
          const aDisplay = a.displayName || a.name;
          const bDisplay = b.displayName || b.name;
          return aDisplay.localeCompare(bDisplay);
        }

        // If only one has sortOrder -1, it appears last
        if (aSort === -1) {
          return 1;
        }
        if (bSort === -1) {
          return -1;
        }

        // Both have explicit sort order, use numeric comparison
        if (aSort !== bSort) {
          return aSort - bSort;
        }

        // Same sortOrder, use displayName/name as tiebreaker
        const aDisplay = a.displayName || a.name;
        const bDisplay = b.displayName || b.name;
        return aDisplay.localeCompare(bDisplay);
      }),
      traceId,
      `path=${normalizedPath}; count=${items.length}`
    );
  }
}
