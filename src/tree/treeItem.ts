import * as vscode from 'vscode';
import { SitecoreItem, SerializationStatus } from './models';

export class SitecoreTreeItem extends vscode.TreeItem {
  constructor(
    public readonly item: SitecoreItem,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(item.name, collapsibleState);

    this.tooltip = `${item.path}\nStatus: ${item.status}`;
    this.description = item.status === SerializationStatus.Direct ? 'D' :
                      item.status === SerializationStatus.Indirect ? 'I' :
                      item.status === SerializationStatus.Untracked ? 'U' : 'N';

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