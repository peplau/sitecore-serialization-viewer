import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let perfOutputChannel: vscode.OutputChannel | undefined;

function getPerfOutputChannel(): vscode.OutputChannel {
  if (!perfOutputChannel) {
    perfOutputChannel = vscode.window.createOutputChannel('Sitecore Serialization Performance');
  }

  return perfOutputChannel;
}

function normalizeFlagValue(rawValue: string): string {
  return rawValue.trim().replace(/^['"]|['"]$/g, '');
}

function tryGetDebugFromDotEnvLocal(): string | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    return undefined;
  }

  const envFilePath = path.join(workspaceFolder, '.env.local');
  if (!fs.existsSync(envFilePath)) {
    return undefined;
  }

  try {
    const envContent = fs.readFileSync(envFilePath, 'utf8');
    const lines = envContent.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex <= 0) {
        continue;
      }

      const key = trimmed.substring(0, equalsIndex).trim();
      if (key !== 'DEBUG') {
        continue;
      }

      const value = trimmed.substring(equalsIndex + 1);
      return normalizeFlagValue(value);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function isPerfTracingEnabled(): boolean {
  const processDebug = process.env.DEBUG;
  const processEnabled = typeof processDebug === 'string' && normalizeFlagValue(processDebug) === 'true';
  if (processEnabled) {
    return true;
  }

  const dotEnvDebug = tryGetDebugFromDotEnvLocal();
  const dotEnvEnabled = typeof dotEnvDebug === 'string' && normalizeFlagValue(dotEnvDebug) === 'true';
  if (dotEnvEnabled) {
    return true;
  }

  return false;
}

export function initializePerfOutputIfEnabled(): void {
  if (!isPerfTracingEnabled()) {
    return;
  }

  getPerfOutputChannel().appendLine('Performance tracing enabled (DEBUG=true).');
}

export function resetPerfOutputFromEnv(): void {
  if (perfOutputChannel) {
    perfOutputChannel.dispose();
    perfOutputChannel = undefined;
  }

  initializePerfOutputIfEnabled();
}

export function appendPerfLine(message: string): void {
  if (!isPerfTracingEnabled()) {
    return;
  }

  getPerfOutputChannel().appendLine(message);
}

export function showPerfOutput(preserveFocus?: boolean): void {
  if (!isPerfTracingEnabled()) {
    return;
  }

  getPerfOutputChannel().show(preserveFocus);
}
