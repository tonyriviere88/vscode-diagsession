import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { LineHits } from '../shared/protocol';

interface Annotation {
  hits: LineHits;
  totalSamples: number;
  sampleMs: number;
  label: string;
}

interface OwnedAnnotation extends Annotation {
  /** The report that annotated the file, so closing it removes only its own annotations. */
  owner: object;
}

const HEAT_LEVELS = 5;

/** Per-line CPU cost shown in source editors: a heat background plus "total | self" after the line. */
export class SourceAnnotations implements vscode.Disposable {
  private readonly heat: vscode.TextEditorDecorationType[] = [];
  private readonly text: vscode.TextEditorDecorationType;
  private readonly byFile = new Map<string, OwnedAnnotation>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private sourceGroup: vscode.TabGroup | undefined;

  constructor() {
    for (let i = 0; i < HEAT_LEVELS; i++) {
      const alpha = 0.1 + (0.45 * i) / (HEAT_LEVELS - 1);
      this.heat.push(
        vscode.window.createTextEditorDecorationType({
          backgroundColor: `rgba(232, 72, 52, ${alpha.toFixed(2)})`,
          isWholeLine: true,
          overviewRulerColor: `rgba(232, 72, 52, ${Math.min(1, alpha + 0.3).toFixed(2)})`,
          overviewRulerLane: vscode.OverviewRulerLane.Right,
        }),
      );
    }
    this.text = vscode.window.createTextEditorDecorationType({
      after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em' },
    });
    this.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach((e) => this.apply(e))));
  }

  dispose(): void {
    this.heat.forEach((d) => d.dispose());
    this.text.dispose();
    this.subscriptions.forEach((d) => d.dispose());
  }

  /** Removes the annotations of one report, or all of them when no owner is given. */
  clear(owner?: object): void {
    if (owner === undefined) this.byFile.clear();
    else for (const [file, a] of this.byFile) if (a.owner === owner) this.byFile.delete(file);
    for (const e of vscode.window.visibleTextEditors) this.apply(e);
    this.updateContext();
  }

  /** Shows the "clear" button of the Captures view only while some file is annotated. */
  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'diagsession.hasSourceAnnotations', this.byFile.size > 0);
  }

  async show(owner: object, buildPath: string, line: number, annotation: Annotation): Promise<boolean> {
    const owned = { ...annotation, owner };
    const local = await resolveSourcePath(buildPath);
    if (!local) {
      const pick = await vscode.window.showWarningMessage(
        `Source file not found: ${buildPath}`,
        'Locate File…',
        'Configure Path Mappings',
      );
      if (pick === 'Configure Path Mappings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'diagsession.sourcePathMappings');
      } else if (pick === 'Locate File…') {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false, title: `Locate ${path.basename(buildPath)}` });
        if (uris?.[0]) return this.open(uris[0], line, owned);
      }
      return false;
    }
    return this.open(vscode.Uri.file(local), line, owned);
  }

  /** The editor group that shows sources: by default one split below the report, created once and then reused. */
  private async sourceColumn(): Promise<vscode.ViewColumn> {
    const where = vscode.workspace.getConfiguration('diagsession').get<string>('sourceEditorLocation', 'below');
    if (where === 'active') return vscode.ViewColumn.Active;
    if (where === 'beside') return vscode.ViewColumn.Beside;
    const groups = vscode.window.tabGroups;
    if (this.sourceGroup && groups.all.includes(this.sourceGroup) && this.sourceGroup !== groups.activeTabGroup) {
      return this.sourceGroup.viewColumn;
    }
    // The request comes from the report's webview, so the active group is the report's. Reuse the group below it
    // when there is one (moving the focus down tells us), otherwise split the report's group downwards.
    const report = groups.activeTabGroup;
    await vscode.commands.executeCommand('workbench.action.focusBelowGroup');
    if (groups.activeTabGroup === report) {
      await vscode.commands.executeCommand('workbench.action.newGroupBelow');
    }
    this.sourceGroup = groups.activeTabGroup;
    return this.sourceGroup.viewColumn;
  }

  private async open(uri: vscode.Uri, line: number, annotation: OwnedAnnotation): Promise<boolean> {
    this.byFile.set(uri.fsPath.toLowerCase(), annotation);
    this.updateContext();
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.max(0, Math.min(line - 1, doc.lineCount - 1)), 0);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: await this.sourceColumn(),
      preserveFocus: false,
      selection: new vscode.Range(pos, pos),
    });
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.apply(editor);
    return true;
  }

  private apply(editor: vscode.TextEditor): void {
    const a = this.byFile.get(editor.document.uri.fsPath.toLowerCase());
    const heatRanges: vscode.DecorationOptions[][] = this.heat.map(() => []);
    const textRanges: vscode.DecorationOptions[] = [];
    if (a) {
      const max = Math.max(1, ...Object.values(a.hits).map(([, total]) => total));
      const fmt = (n: number) => {
        const ms = n * a.sampleMs;
        const pct = a.totalSamples ? (100 * n) / a.totalSamples : 0;
        return `${ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(0) + ' ms'} (${pct.toFixed(pct < 10 ? 2 : 1)}%)`;
      };
      for (const [lineStr, [self, total]] of Object.entries(a.hits)) {
        const line = Number(lineStr) - 1;
        if (line < 0 || line >= editor.document.lineCount) continue;
        const range = editor.document.lineAt(line).range;
        const level = Math.min(HEAT_LEVELS - 1, Math.floor((HEAT_LEVELS * total) / (max + 1)));
        const hover = new vscode.MarkdownString(
          `**CPU samples** — ${a.label}\n\n| | |\n|---|---|\n| Total | ${fmt(total)} |\n| Self | ${fmt(self)} |`,
        );
        heatRanges[level].push({ range, hoverMessage: hover });
        textRanges.push({
          range,
          renderOptions: { after: { contentText: `⏱ ${fmt(total)}${self ? ` · self ${fmt(self)}` : ''}` } },
        });
      }
    }
    this.heat.forEach((d, i) => editor.setDecorations(d, heatRanges[i]));
    editor.setDecorations(this.text, textRanges);
  }
}

/** Maps a build-time source path to a local file: as is, through `diagsession.sourcePathMappings`, or by searching the
 * workspace for the file name with the longest matching path suffix. */
export async function resolveSourcePath(buildPath: string): Promise<string | undefined> {
  if (fs.existsSync(buildPath)) return buildPath;

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const mappings = vscode.workspace.getConfiguration('diagsession').get<Record<string, string>>('sourcePathMappings', {});
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  for (const [from, to] of Object.entries(mappings)) {
    if (norm(buildPath).startsWith(norm(from))) {
      const candidate = path.join(to.replace(/\$\{workspaceFolder\}/g, ws), buildPath.slice(from.length));
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const base = path.basename(buildPath.replace(/\\/g, '/'));
  const found = await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 50);
  if (!found.length) return undefined;
  const parts = norm(buildPath).split('\\').reverse();
  let best: vscode.Uri | undefined;
  let bestScore = -1;
  for (const uri of found) {
    const cand = norm(uri.fsPath).split('\\').reverse();
    let score = 0;
    while (score < parts.length && score < cand.length && parts[score] === cand[score]) score++;
    if (score > bestScore) {
      bestScore = score;
      best = uri;
    }
  }
  return best?.fsPath;
}
