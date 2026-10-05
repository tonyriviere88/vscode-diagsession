import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as jsonc from 'jsonc-parser';
import type { JmcConfig } from '../shared/jmc';
import type { JmcSettings } from '../shared/protocol';

const CONFIG_FILE = path.join('.vscode', 'jmc.json');

/** The workspace folder whose `.vscode/jmc.json` applies to a report: its own, else the first one. */
function folderOf(uri: vscode.Uri): string | undefined {
  return (vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
}

const keyOf = (folder: string) => path.normalize(folder).toLowerCase();

/**
 * The Just My Code rules of the workspace folders (`.vscode/jmc.json`, the vscode-windbg format), re-read when a file
 * changes. A missing file means the built-in rules.
 */
export class JustMyCodeConfig implements vscode.Disposable {
  private readonly cache = new Map<string, JmcSettings>();
  private readonly changed = new vscode.EventEmitter<string>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/jmc.json');
  /** Fires the key of the folder whose rules changed (see `keyFor`). */
  readonly onDidChange = this.changed.event;

  constructor() {
    const reload = (uri: vscode.Uri) => {
      const key = keyOf(path.dirname(path.dirname(uri.fsPath)));
      if (!this.cache.delete(key)) return;
      this.changed.fire(key);
    };
    this.watcher.onDidCreate(reload);
    this.watcher.onDidChange(reload);
    this.watcher.onDidDelete(reload);
  }

  /** Identifies the rules a report uses, to match `onDidChange` events. */
  keyFor(uri: vscode.Uri): string {
    const folder = folderOf(uri);
    return folder ? keyOf(folder) : '';
  }

  settingsFor(uri: vscode.Uri): JmcSettings {
    const folder = folderOf(uri);
    if (!folder) return { config: {} };
    const key = keyOf(folder);
    let settings = this.cache.get(key);
    if (!settings) this.cache.set(key, (settings = { config: this.read(path.join(folder, CONFIG_FILE)), workspaceFolder: folder }));
    return settings;
  }

  private read(file: string): JmcConfig {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return {};
    }
    const errors: jsonc.ParseError[] = [];
    const parsed: unknown = jsonc.parse(text, errors, { allowTrailingComma: true });
    if (errors.length) {
      const e = errors[0];
      void vscode.window.showWarningMessage(
        `DiagSession: ${file}: ${jsonc.printParseErrorCode(e.error)} at offset ${e.offset}. The rules it could read apply.`,
      );
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JmcConfig) : {};
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
  }
}
