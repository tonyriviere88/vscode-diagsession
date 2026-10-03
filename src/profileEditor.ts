import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { analyze } from './analyzer';
import { SourceAnnotations } from './sourceAnnotations';
import type { FromWebview, ToWebview } from '../shared/protocol';

interface Choice {
  pid?: number;
  msSymbols?: boolean;
  /** Modules whose symbols the user loaded on demand. */
  loadSymbols?: string[];
}

const choiceKey = (file: string) => 'choice:' + file.toLowerCase();

const externalNamespaces = () => vscode.workspace.getConfiguration('diagsession').get<string[]>('externalNamespaces', []);
const showExternalCode = () => vscode.workspace.getConfiguration('diagsession').get<boolean>('showExternalCode', false);

/** Saves the checkbox where the effective value comes from, so a workspace value is not shadowing it. */
async function saveShowExternalCode(show: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('diagsession');
  const info = cfg.inspect<boolean>('showExternalCode');
  const target =
    info?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : info?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await cfg.update('showExternalCode', show, target);
}
const localSymbolsOnly = () => vscode.workspace.getConfiguration('diagsession').get<boolean>('localSymbolsOnly', true);

/** Makes the report of a capture open on the process it profiled rather than the busiest one. */
export async function rememberProcess(context: vscode.ExtensionContext, file: string, pid: number): Promise<void> {
  const prev = context.workspaceState.get<Choice>(choiceKey(file)) ?? {};
  await context.workspaceState.update(choiceKey(file), { ...prev, pid });
}

class ProfileDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class ProfileEditorProvider implements vscode.CustomReadonlyEditorProvider<ProfileDocument> {
  static readonly viewType = 'diagsession.profile';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly annotations: SourceAnnotations,
  ) {}

  openCustomDocument(uri: vscode.Uri): ProfileDocument {
    return new ProfileDocument(uri);
  }

  resolveCustomEditor(document: ProfileDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    webview.html = this.html(webview);

    const post = (m: ToWebview) => void webview.postMessage(m);
    const key = choiceKey(document.uri.fsPath);
    let running: vscode.CancellationTokenSource | undefined;

    const load = async (choice: Choice) => {
      running?.cancel();
      const cts = (running = new vscode.CancellationTokenSource());
      const msSymbols =
        choice.msSymbols ?? vscode.workspace.getConfiguration('diagsession').get<boolean>('useMicrosoftSymbolServer', false);
      try {
        const result = await analyze(
          this.context,
          {
            file: document.uri.fsPath,
            pid: choice.pid,
            msSymbols,
            localSymbols: localSymbolsOnly(),
            loadSymbols: choice.loadSymbols ?? [],
          },
          (text) => post({ type: 'progress', text }),
          cts.token,
        );
        if (cts.token.isCancellationRequested) return;
        post({
          type: 'profile',
          json: result.json,
          fromCache: result.fromCache,
          externalNamespaces: externalNamespaces(),
          showExternalCode: showExternalCode(),
        });
      } catch (e) {
        if (e instanceof vscode.CancellationError || cts.token.isCancellationRequested) return;
        post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
      }
    };

    webview.onDidReceiveMessage(async (m: FromWebview) => {
      switch (m.type) {
        case 'ready':
          await load(this.context.workspaceState.get<Choice>(key) ?? {});
          break;
        case 'reanalyze': {
          const prev = this.context.workspaceState.get<Choice>(key) ?? {};
          const loadSymbols = [...(prev.loadSymbols ?? [])];
          if (m.loadSymbols && !loadSymbols.some((p) => p.toLowerCase() === m.loadSymbols!.toLowerCase())) loadSymbols.push(m.loadSymbols);
          const next: Choice = { pid: m.pid ?? prev.pid, msSymbols: m.msSymbols ?? prev.msSymbols, loadSymbols };
          await this.context.workspaceState.update(key, next);
          await load(next);
          break;
        }
        case 'openSource':
          await this.annotations.show(panel, m.file, m.line, {
            hits: m.hits,
            totalSamples: m.totalSamples,
            sampleMs: m.sampleMs,
            label: m.label,
          });
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          break;
        case 'setShowExternalCode':
          if (m.show !== showExternalCode()) await saveShowExternalCode(m.show);
          break;
      }
    });
    const config = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('diagsession.showExternalCode')) post({ type: 'showExternalCode', show: showExternalCode() });
      if (e.affectsConfiguration('diagsession.externalNamespaces')) post({ type: 'externalNamespaces', namespaces: externalNamespaces() });
      if (e.affectsConfiguration('diagsession.localSymbolsOnly')) {
        post({ type: 'progress', text: 'Reloading symbols…' });
        void load(this.context.workspaceState.get<Choice>(key) ?? {});
      }
    });
    panel.onDidDispose(() => {
      running?.cancel();
      config.dispose();
      this.annotations.clear(panel);
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>DiagSession</title>
</head>
<body>
<div id="app"><div class="loading"><div class="spinner"></div><div id="progress">Starting analyzer…</div></div></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
