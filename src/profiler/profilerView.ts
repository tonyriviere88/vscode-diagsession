import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Profiler } from './profiler';
import { findVsDiagnostics } from './collector';
import { launchConfigurations, pickProcess } from './targets';
import type { FromProfilerView, ProfilerViewState, ToProfilerView } from '../../shared/profilerProtocol';

/** The "Profiler" view of the activity bar container: target, tool options and the session controls. */
export class ProfilerViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'diagsession.profilerView';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly profiler: Profiler,
  ) {
    context.subscriptions.push(
      profiler.onDidChange(() => this.post()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('launch') || e.affectsConfiguration('diagsession')) this.post();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [media, dist] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromProfilerView) =>
      this.handle(m).catch((e) => vscode.window.showErrorMessage(`Profiler: ${e instanceof Error ? e.message : e}`)),
    );
    view.onDidChangeVisibility(() => view.visible && this.post());
    view.onDidDispose(() => (this.view = undefined));
  }

  private state(): ProfilerViewState {
    return {
      config: this.profiler.config,
      session: this.profiler.session,
      launchConfigs: launchConfigurations().map((c) => c.name),
      debugProcess: this.profiler.debugProcess ?? null,
      collector: findVsDiagnostics() ?? null,
      outputFolder: this.profiler.outputFolder(),
    };
  }

  private post(): void {
    if (!this.view) return;
    const m: ToProfilerView = { type: 'state', state: this.state() };
    void this.view.webview.postMessage(m);
  }

  private async handle(m: FromProfilerView): Promise<void> {
    const p = this.profiler;
    switch (m.type) {
      case 'ready':
        this.post();
        break;
      case 'config':
        await p.updateConfig(m.config);
        break;
      case 'pickProcess': {
        const proc = await pickProcess();
        // Another process than the debugged one: stop following the debugger.
        if (proc) {
          await p.updateConfig({ targetKind: 'process', process: { pid: proc.pid, name: proc.name, title: proc.title }, followDebugger: false });
        }
        break;
      }
      case 'browseProgram': {
        const picked = await vscode.window.showOpenDialog({
          title: 'Executable to profile',
          canSelectMany: false,
          filters: { Executables: ['exe'], 'All files': ['*'] },
          defaultUri: p.config.program ? vscode.Uri.file(p.config.program) : vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (picked?.[0]) await p.updateConfig({ program: picked[0].fsPath });
        break;
      }
      case 'browseCwd':
      case 'browseOutput': {
        const current = m.type === 'browseCwd' ? p.config.cwd : p.outputFolder();
        const picked = await vscode.window.showOpenDialog({
          title: m.type === 'browseCwd' ? 'Working directory' : 'Folder for the .diagsession files',
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: current ? vscode.Uri.file(current) : vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (picked?.[0]) await p.updateConfig(m.type === 'browseCwd' ? { cwd: picked[0].fsPath } : { outputFolder: picked[0].fsPath });
        break;
      }
      case 'openOutput': {
        const folder = p.outputFolder();
        await fs.promises.mkdir(folder, { recursive: true });
        await vscode.env.openExternal(vscode.Uri.file(folder));
        break;
      }
      case 'openLaunchJson':
        await vscode.commands.executeCommand('workbench.action.debug.configure');
        break;
      case 'command':
        await vscode.commands.executeCommand(`diagsession.profiler.${m.command}`);
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'profiler.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'profiler.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Profiler</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
