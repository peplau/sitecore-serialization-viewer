import * as vscode from 'vscode';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { SitecoreTreeItem } from './treeItem';
import { SitecoreItem, SerializationStatus } from './models';
import { AuthoringGraphqlClient } from '../sitecore/previewGraphqlClient';

export class ContentTreeProvider implements vscode.TreeDataProvider<SitecoreTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SitecoreTreeItem | undefined | void> = new vscode.EventEmitter<SitecoreTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SitecoreTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  private client: AuthoringGraphqlClient;
  private cache: Map<string, SitecoreItem[]> = new Map();
  private explainStatusCache: Map<string, SerializationStatus> = new Map();
  private loadGeneration = 0;
  private readonly exec = promisify(execCallback);
  private selectedDatabase: string;

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

  async getChildren(element?: SitecoreTreeItem): Promise<SitecoreTreeItem[]> {
    const requestGeneration = this.loadGeneration;

    // If no element, return the root /sitecore node
    if (!element) {
      const rootItem: SitecoreItem = {
        id: 'sitecore-root',
        name: 'sitecore',
        path: '/sitecore',
        hasChildren: true,
        status: SerializationStatus.NotSerialized
      };
      return [new SitecoreTreeItem(rootItem, vscode.TreeItemCollapsibleState.Collapsed)];
    }

    const basePath = element.item.path;

    if (this.cache.has(basePath)) {
      const cachedItems = this.cache.get(basePath) || [];
      return cachedItems.map(item => new SitecoreTreeItem(
        item,
        item.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      ));
    }

    let items: SitecoreItem[] = [];
    try {
      const result = await this.client.getChildren(basePath);
      // Filter out any children that are the same as parent (self-reference)
      items = (result || []).filter((item: SitecoreItem) => item.path !== basePath);
      items = await this.reconcileIndirectStatuses(items);

      // If a hard reset happened while this request was in flight, discard stale results.
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

    return items.map(item => new SitecoreTreeItem(
      item,
      item.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    ));
  }

  refresh(options?: { resetState?: boolean }): void {
    this.cache.clear();
    this.explainStatusCache.clear();

    if (options?.resetState) {
      this.loadGeneration += 1;
      this.client.reset();
      this.client.setDatabase(this.selectedDatabase);
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