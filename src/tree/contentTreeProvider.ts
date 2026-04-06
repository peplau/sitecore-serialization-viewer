import * as vscode from 'vscode';
import { SitecoreTreeItem } from './treeItem';
import { SitecoreItem, SerializationStatus } from './models';
import { AuthoringGraphqlClient } from '../sitecore/previewGraphqlClient';

export class ContentTreeProvider implements vscode.TreeDataProvider<SitecoreTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SitecoreTreeItem | undefined | void> = new vscode.EventEmitter<SitecoreTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SitecoreTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  private client: AuthoringGraphqlClient;
  private cache: Map<string, SitecoreItem[]> = new Map();

  constructor() {
    this.client = new AuthoringGraphqlClient();
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

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }
}