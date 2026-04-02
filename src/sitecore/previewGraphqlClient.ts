import * as vscode from 'vscode';
import { SitecoreItem, SerializationStatus } from '../tree/models';

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ItemResult {
  id: string;
  name: string;
  path: string;
  template?: { id?: string; name?: string };
  children?: { total: number };
}

interface ItemChildrenResponse {
  item?: {
    id: string;
    name: string;
    path: string;
    children?: {
      results: ItemResult[];
    };
  };
}

export class PreviewGraphqlClient {
  private readonly endpoint: string | undefined;
  private readonly headers: Record<string, string>;

  constructor() {
    const config = vscode.workspace.getConfiguration('sitecoreSerializationViewer');
    const explicitUrl = config.get<string>('previewGraphqlUrl');
    const explicitSite = config.get<string>('defaultSiteName');
    const hostFromEnv = process.env.SITECORE_EDGE_HOSTNAME;
    const contextId = process.env.SITECORE_EDGE_CONTEXT_ID;
    const editingSecret = process.env.SITECORE_EDITING_SECRET;
    const siteName = explicitSite || process.env.NEXT_PUBLIC_DEFAULT_SITE_NAME || 'my-website';

    this.endpoint = explicitUrl ||
      (hostFromEnv ? `https://${hostFromEnv}/sitecore/api/graph/edge?sc_site=${encodeURIComponent(siteName)}` : undefined);

    this.headers = {
      'Content-Type': 'application/json',
      ...(contextId ? { 'SC-Edge-Context-Id': contextId } : {}),
      ...(editingSecret ? { 'SC-Editing-Secret': editingSecret } : {})
    };
  }

  private async executeQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (!this.endpoint) {
      throw new Error('Preview GraphQL endpoint not configured. Set sitecoreSerializationViewer.previewGraphqlUrl or SITECORE_EDGE_HOSTNAME in env.');
    }

    const resp = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query, variables })
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`GraphQL request failed: ${resp.status} ${resp.statusText} - ${body}`);
    }

    const payload = (await resp.json()) as GraphqlResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`GraphQL errors: ${payload.errors.map(e => e.message).join('; ')}`);
    }
    if (!payload.data) {
      throw new Error('GraphQL response missing data.');
    }

    return payload.data;
  }

  async getChildren(path: string): Promise<SitecoreItem[]> {
    const normalizedPath = path || '/sitecore';

    const query = `query ItemChildren($path: String!) {\n  item(path: $path) {\n    id\n    name\n    path\n    children {\n      results {\n        id\n        name\n        path\n        template { id name }\n        children { total }\n      }\n    }\n  }\n}`;

    const data = await this.executeQuery<ItemChildrenResponse>(query, { path: normalizedPath });
    const children = data.item?.children?.results || [];

    return children.map(child => ({
      id: child.id,
      name: child.name,
      path: child.path,
      templateId: child.template?.id,
      templateName: child.template?.name,
      hasChildren: (child.children?.total ?? 0) > 0,
      status: SerializationStatus.NotSerialized
    }));
  }
}
