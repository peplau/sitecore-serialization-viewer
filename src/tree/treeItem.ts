import * as vscode from 'vscode';
import { SitecoreItem, SerializationStatus } from './models';

function createPendingIconSvg(strokeColor: string): vscode.Uri {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M1.75 4.75A1.75 1.75 0 0 1 3.5 3h2.44c.3 0 .58.12.8.34l.91.91c.22.22.5.34.8.34h4.05a1.75 1.75 0 0 1 1.75 1.75v5.16a1.75 1.75 0 0 1-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75z" stroke="${strokeColor}" stroke-width="1.25" stroke-linejoin="round"/>
      <path d="M8 7.05c-.88 0-1.59.66-1.67 1.53" stroke="${strokeColor}" stroke-width="1.25" stroke-linecap="round"/>
      <path d="M8 11.2h.01" stroke="${strokeColor}" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M8 8.58v.44c0 .42-.24.81-.63 1.01" stroke="${strokeColor}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

const pendingIconPath: vscode.IconPath = {
  light: createPendingIconSvg('#6b6b6b'),
  dark: createPendingIconSvg('#c5c5c5')
};

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

  private getIconPath(item: SitecoreItem): vscode.IconPath {
    if (item.statusPending) {
      return pendingIconPath;
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