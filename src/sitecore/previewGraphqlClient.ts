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
  template?: { name?: string };
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

    return {
      id: item.itemId,
      name: item.name,
      path: item.path,
      templateId: undefined,
      templateName: item.template?.name,
      sortOrder: undefined,
      displayName: undefined,
      hasChildren: (item.children?.nodes?.length ?? 0) > 0,
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

  async getItemByPath(path: string): Promise<SitecoreItem | undefined> {
    const normalizedPath = path || '/sitecore';
    const selectedDatabase = this.database || 'master';

    const query = `query ItemByPath($path: String = "/sitecore", $database: String = "master") {\n  item(where: { path: $path, database: $database }) {\n    itemId\n    name\n    path\n    template { name }\n    children {\n      nodes {\n        itemId\n      }\n    }\n  }\n}`;

    const data = await this.executeQuery<ItemByPathResponse>(query, {
      path: normalizedPath,
      database: selectedDatabase
    });

    return data.item ? this.mapItemResult(data.item) : undefined;
  }

  async getItemById(itemId: string): Promise<SitecoreItem | undefined> {
    const normalizedItemId = itemId.trim();
    const selectedDatabase = this.database || 'master';

    const query = `query ItemById($itemId: ID!, $database: String = "master") {\n  item(where: { itemId: $itemId, database: $database }) {\n    itemId\n    name\n    path\n    template { name }\n    children {\n      nodes {\n        itemId\n      }\n    }\n  }\n}`;

    const data = await this.executeQuery<ItemByPathResponse>(query, {
      itemId: normalizedItemId,
      database: selectedDatabase
    });

    return data.item ? this.mapItemResult(data.item) : undefined;
  }

  async getChildren(path: string, traceId?: string): Promise<SitecoreItem[]> {
    const normalizedPath = path || '/sitecore';
    const selectedDatabase = this.database || 'master';

    const query = `query ItemChildren($path: String = "/sitecore", $database: String = "master") {\n  item(where: { path: $path, database: $database }) {\n    itemId\n    name\n    path\n    children {\n      nodes {\n        itemId\n        name\n        path\n        template { name }\n        children {\n          nodes {\n            itemId\n          }\n        }\n      }\n    }\n  }\n}`;

    const data = await this.withTiming(
      'graphql.query.itemChildren',
      () => this.executeQuery<ItemChildrenResponse>(
        query,
        {
          path: normalizedPath,
          database: selectedDatabase
        },
        traceId
      ),
      traceId,
      `path=${normalizedPath}; database=${selectedDatabase}`
    );
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
