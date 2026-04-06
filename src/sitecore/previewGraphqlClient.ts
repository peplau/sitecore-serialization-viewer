import * as vscode from 'vscode';
import { SitecoreItem, SerializationStatus } from '../tree/models';
import { SerializationConfigService } from './serializationConfigService';

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

export class AuthoringGraphqlClient {
  private endpoint: string | undefined;
  private headers: Record<string, string> | undefined;
  private language: string = 'en';

  private async ensureInitialized(): Promise<void> {
    if (this.endpoint !== undefined) {
      return;
    } // Already initialized

    const config = vscode.workspace.getConfiguration('sitecoreSerializationViewer');
    const explicitUrl = config.get<string>('authoringGraphqlUrl');

    // Read from .env.local file in workspace
    const envVars = await this.loadEnvFile();
    const hostFromEnv = envVars['SITECORE_EDGE_HOSTNAME'];
    const contextId = envVars['SITECORE_EDGE_CONTEXT_ID'];
    const editingSecret = envVars['SITECORE_EDITING_SECRET'];
    const authToken = envVars['AUTHORING_BEARER_TOKEN'];
    this.language = config.get<string>('defaultLanguage') || envVars['LANGUAGE'] || 'en';

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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(contextId ? { 'SC-Edge-Context-Id': contextId } : {}),
      ...(editingSecret ? { 'SC-Editing-Secret': editingSecret } : {})
    };

    if (authToken) {
      const tokenText = authToken.trim();
      const isBearerToken = /^Bearer\s+/i.test(tokenText);
      const tokenLength = tokenText.replace(/^Bearer\s+/i, '').length;
      const parts = tokenText.split('.');
      const isJwtFormat = parts.length === 3;

      headers.Authorization = isBearerToken ? tokenText : `Bearer ${tokenText}`;
      console.log(`Using Authorization Bearer token from AUTHORING_BEARER_TOKEN (${tokenLength} chars, JWT format: ${isJwtFormat}) for Authoring GraphQL.`);
    } else {
      console.warn('AUTHORING_BEARER_TOKEN not found in .env.local or environment. Authoring GraphQL requests will fail.');
    }

    this.headers = headers;
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

  private async executeQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    await this.ensureInitialized();

    if (!this.endpoint) {
      throw new Error('Authoring GraphQL endpoint not configured. Set sitecoreSerializationViewer.authoringGraphqlUrl or ensure .env.local has SITECORE_EDGE_HOSTNAME.');
    }

    console.log(`GraphQL request to: ${this.endpoint}`);

    const resp = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers!,
      body: JSON.stringify({ query, variables })
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`GraphQL request failed: ${resp.status} ${resp.statusText} - ${body}`);
    }

    const payload = (await resp.json()) as GraphqlResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      const errorMsg = payload.errors.map(e => e.message).join('; ');
      if (errorMsg.toLowerCase().includes('not authorized') || errorMsg.toLowerCase().includes('unauthorized')) {
        throw new Error(`GraphQL authorization failed: ${errorMsg}. Verify GRAPH_QL_TOKEN is a valid bearer token from Sitecore Identity Server with required permissions.`);
      }
      throw new Error(`GraphQL errors: ${errorMsg}`);
    }
    if (!payload.data) {
      throw new Error('GraphQL response missing data.');
    }

    return payload.data;
  }

  async getChildren(path: string): Promise<SitecoreItem[]> {
    const normalizedPath = path || '/sitecore';

    const query = `query ItemChildren($path: String = "/sitecore") {\n  item(where: { path: $path }) {\n    itemId\n    name\n    path\n    children {\n      nodes {\n        itemId\n        name\n        path\n        template { name }\n        children {\n          nodes {\n            itemId\n          }\n        }\n      }\n    }\n  }\n}`;

    const data = await this.executeQuery<ItemChildrenResponse>(query, { path: normalizedPath });
    const children = data.item?.children?.nodes || [];

    console.log(`GraphQL query for ${normalizedPath}: received ${children.length} children`);

    const serializationService = SerializationConfigService.getInstance();
    const items = children
      .filter(child => child.path !== normalizedPath) // Prevent self-reference
      .map(child => {
        // Check if item is part of serialization
        const serializationMatch = serializationService.checkSerializationStatus(child.path);

        return {
          id: child.itemId,
          name: child.name,
          path: child.path,
          templateId: undefined,
          templateName: child.template?.name,
          sortOrder: undefined,
          displayName: undefined,
          hasChildren: (child.children?.nodes?.length ?? 0) > 0,
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
      });

    // Sort by sortOrder (ascending), but handle -1 (unsorted) and other values
    // Then by name as tiebreaker
    return items.sort((a, b) => {
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
    });
  }
}
