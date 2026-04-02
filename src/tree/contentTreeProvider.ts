import * as vscode from 'vscode';
import { SitecoreTreeItem } from './treeItem';
import { SitecoreItem, SerializationStatus } from './models';
import { PreviewGraphqlClient } from '../sitecore/previewGraphqlClient';

export class ContentTreeProvider implements vscode.TreeDataProvider<SitecoreTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SitecoreTreeItem | undefined | void> = new vscode.EventEmitter<SitecoreTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SitecoreTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  private client: PreviewGraphqlClient;
  private cache: Map<string, SitecoreItem[]> = new Map();

  constructor() {
    this.client = new PreviewGraphqlClient();
  }

  private readonly fallbackMockData: SitecoreItem[] = [
  private fallbackMockData: SitecoreItem[] = [
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
    const basePath = element?.item.path || '/sitecore';

    if (this.cache.has(basePath)) {
      return this.cache.get(basePath)!.map(item => new SitecoreTreeItem(
        item,
        item.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      ));
    }

    let items: SitecoreItem[];
    try {
      items = await this.client.getChildren(basePath);
      if (!items || items.length === 0) {
        // Keep the mock fallback if GraphQL returns empty
        throw new Error('No children returned from Preview GraphQL');
      }
    } catch (error) {
      console.warn(`GraphQL load failed for path ${basePath}:`, error);
      vscode.window.showWarningMessage(`Sitecore GraphQL load failed (${basePath}). Using local fallback. ${error instanceof Error ? error.message : ''}`);

      if (!element) {
        items = this.fallbackMockData.filter(item => item.path.split('/').length === 2);
      } else {
        const parentPath = element.item.path;
        items = this.fallbackMockData
          .filter(item => item.path.startsWith(parentPath + '/') && item.path.split('/').length === parentPath.split('/').length + 1);
      }
    }

    this.cache.set(basePath, items);

    return items.map(item => new SitecoreTreeItem(
      item,
      item.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    ));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}