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
                      item.status === SerializationStatus.Indirect ? 'I' : 'N';

    // Set icon based on status
    this.iconPath = this.getIconPath(item.status);

    // Context value for menus
    this.contextValue = `sitecoreItem.${item.status}`;

    // Command to show details
    this.command = {
      command: 'sitecore-serialization-viewer.showDetails',
      title: 'Show Details',
      arguments: [item]
    };
  }

  private getIconPath(status: SerializationStatus): vscode.ThemeIcon {
    switch (status) {
      case SerializationStatus.Direct:
        return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.yellow'));
      case SerializationStatus.Indirect:
        return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.orange'));
      case SerializationStatus.NotSerialized:
      default:
        return new vscode.ThemeIcon('folder', new vscode.ThemeColor('disabledForeground'));
    }
  }
}