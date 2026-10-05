import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Profiler } from './profiler';

export class CaptureItem extends vscode.TreeItem {
  readonly mtime: number;

  constructor(readonly file: string, stat: fs.Stats) {
    super(path.basename(file), vscode.TreeItemCollapsibleState.None);
    this.mtime = stat.mtimeMs;
    this.resourceUri = vscode.Uri.file(file);
    this.description = `${(stat.size / 1e6).toFixed(1)} MB · ${ago(stat.mtimeMs)}`;
    this.tooltip = `${file}\n${new Date(stat.mtimeMs).toLocaleString()}`;
    this.iconPath = new vscode.ThemeIcon('pulse');
    this.contextValue = 'capture';
    this.command = { command: 'diagsession.captures.open', title: 'Open', arguments: [this] };
  }
}

/** The "Captures" view: .diagsession files recorded by the profiler, and those of its output folder. */
export class CapturesProvider implements vscode.TreeDataProvider<CaptureItem> {
  static readonly viewId = 'diagsession.capturesView';
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly profiler: Profiler) {
    profiler.onDidChange(() => this.changed.fire());
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: CaptureItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<CaptureItem[]> {
    const files = new Map<string, string>();
    for (const f of this.profiler.captures()) files.set(f.toLowerCase(), f);
    const folder = this.profiler.outputFolder();
    const names = await fs.promises.readdir(folder).catch(() => [] as string[]);
    for (const n of names) {
      if (/\.diagsession$/i.test(n)) files.set(path.join(folder, n).toLowerCase(), path.join(folder, n));
    }
    const items: CaptureItem[] = [];
    for (const f of files.values()) {
      const stat = await fs.promises.stat(f).catch(() => undefined);
      if (stat?.isFile()) items.push(new CaptureItem(f, stat));
    }
    void vscode.commands.executeCommand('setContext', 'diagsession.hasCaptures', items.length > 0);
    return items.sort((a, b) => b.mtime - a.mtime);
  }
}

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}
