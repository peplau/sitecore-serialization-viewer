import * as vscode from 'vscode';
import { SitecoreItem, SerializationStatus } from './models';

export class SitecoreTreeItem extends vscode.TreeItem {
  constructor(
    public readonly item: SitecoreItem,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(item.name, collapsibleState);

    this.id = item.path;
    this.tooltip = `${item.path}\nStatus: ${item.status}`;
    // Set icon based on status and serialization content
    this.iconPath = this.getIconPath(item);

    // Context value for menus
    this.contextValue = `sitecoreItem.${item.status}`;

    // Command to show details
    this.command = {
      command: 'sitecore-serialization-viewer.showDetails',
      title: 'Show Details',
      arguments: [item]
    };
  }

  private getIconPath(item: SitecoreItem): vscode.ThemeIcon {
    if (item.statusPending) {
      return new vscode.ThemeIcon('question', new vscode.ThemeColor('disabledForeground'));
    }

    switch (item.status) {
      case SerializationStatus.Direct:
        // Show yellow only if item is part of JSON files (has yamlPath)
        if (item.yamlPath) {
          return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.yellow'));
        }
        // Direct status without yamlPath shows orange
        return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.orange'));
      case SerializationStatus.Indirect:
        return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.orange'));
      case SerializationStatus.Untracked:
        return new vscode.ThemeIcon('folder', new vscode.ThemeColor('descriptionForeground'));
      case SerializationStatus.NotSerialized:
      default:
        return new vscode.ThemeIcon('folder', new vscode.ThemeColor('disabledForeground'));
    }
  }
}