import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JustMyCodeConfig } from './justMyCode';
import { ProfileEditorProvider, rememberProcess } from './profileEditor';
import { SourceAnnotations } from './sourceAnnotations';
import { cacheRoot } from './analyzer';
import { Profiler } from './profiler/profiler';
import { ProfilerViewProvider } from './profiler/profilerView';
import { CaptureItem, CapturesProvider } from './profiler/capturesView';
import { pickProcess } from './profiler/targets';

export function activate(context: vscode.ExtensionContext): { annotations: SourceAnnotations; profiler: Profiler } {
  const annotations = new SourceAnnotations();
  const profiler = new Profiler(context);
  const captures = new CapturesProvider(profiler);
  const justMyCode = new JustMyCodeConfig();

  const openReport = (file: string) =>
    vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), ProfileEditorProvider.viewType);

  /** Runs a profiler command, reporting failures instead of rejecting. */
  const guarded =
    <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (e) {
        if (e instanceof vscode.CancellationError) return;
        vscode.window.showErrorMessage(`Profiler: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

  context.subscriptions.push(
    annotations,
    profiler,
    justMyCode,
    vscode.window.registerCustomEditorProvider(
      ProfileEditorProvider.viewType,
      new ProfileEditorProvider(context, annotations, justMyCode),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true },
    ),
    vscode.window.registerWebviewViewProvider(ProfilerViewProvider.viewId, new ProfilerViewProvider(context, profiler)),
    vscode.window.registerTreeDataProvider(CapturesProvider.viewId, captures),
    profiler.onDidCapture(async ({ file, pid }) => {
      if (pid !== undefined) await rememberProcess(context, file, pid);
      if (profiler.config.openReport) await openReport(file);
      else {
        const pick = await vscode.window.showInformationMessage(`Profiler: wrote ${path.basename(file)}.`, 'Open Report');
        if (pick) await openReport(file);
      }
    }),

    vscode.commands.registerCommand('diagsession.clearSourceAnnotations', () => annotations.clear()),
    vscode.commands.registerCommand('diagsession.clearCache', async () => {
      // Only the analyzer's cache: the default capture folder lives next to it.
      for (const sub of ['profiles', 'traces']) {
        await fs.promises.rm(path.join(cacheRoot(context), sub), { recursive: true, force: true });
      }
      vscode.window.showInformationMessage('DiagSession analysis cache cleared.');
    }),

    vscode.commands.registerCommand('diagsession.profiler.focus', () =>
      vscode.commands.executeCommand(`${ProfilerViewProvider.viewId}.focus`),
    ),
    vscode.commands.registerCommand('diagsession.profiler.start', guarded(() => profiler.start())),
    vscode.commands.registerCommand(
      'diagsession.profiler.attach',
      guarded(async () => {
        const proc = await pickProcess();
        if (!proc) return;
        await profiler.updateConfig({
          targetKind: 'process',
          process: { pid: proc.pid, name: proc.name, title: proc.title },
          followDebugger: false,
        });
        await vscode.commands.executeCommand('diagsession.profiler.focus');
        await profiler.start();
      }),
    ),
    vscode.commands.registerCommand('diagsession.profiler.pause', guarded(() => profiler.pause())),
    vscode.commands.registerCommand('diagsession.profiler.resume', guarded(() => profiler.resume())),
    vscode.commands.registerCommand('diagsession.profiler.stop', guarded(() => profiler.stop())),
    vscode.commands.registerCommand('diagsession.profiler.discard', guarded(() => profiler.discard())),

    vscode.commands.registerCommand('diagsession.captures.refresh', () => captures.refresh()),
    vscode.commands.registerCommand('diagsession.captures.open', (item: CaptureItem) => openReport(item.file)),
    vscode.commands.registerCommand('diagsession.captures.openFile', async () => {
      const picked = await vscode.window.showOpenDialog({
        title: 'Open a profiler capture',
        canSelectMany: false,
        filters: { 'Profiler captures': ['diagsession', 'etl'] },
        defaultUri: vscode.Uri.file(profiler.outputFolder()),
      });
      if (picked?.[0]) await openReport(picked[0].fsPath);
    }),
    vscode.commands.registerCommand('diagsession.captures.reveal', (item: CaptureItem) =>
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.file)),
    ),
    vscode.commands.registerCommand('diagsession.captures.copyPath', (item: CaptureItem) => vscode.env.clipboard.writeText(item.file)),
    vscode.commands.registerCommand(
      'diagsession.captures.delete',
      guarded(async (item: CaptureItem) => {
        const answer = await vscode.window.showWarningMessage(`Delete ${path.basename(item.file)}?`, { modal: true }, 'Delete');
        if (answer !== 'Delete') return;
        await fs.promises.rm(item.file, { force: true });
        await profiler.forgetCapture(item.file);
      }),
    ),
    vscode.commands.registerCommand(
      'diagsession.captures.deleteAll',
      guarded(async () => {
        const files = (await captures.getChildren()).map((c) => c.file);
        if (!files.length) return;
        const answer = await vscode.window.showWarningMessage(
          files.length === 1 ? `Delete ${path.basename(files[0])}?` : `Delete all ${files.length} captures?`,
          { modal: true, detail: 'The files are deleted from disk.' },
          'Delete All',
        );
        if (answer !== 'Delete All') return;
        // Delete what can be, then forget those, so one locked file does not keep the others.
        const results = await Promise.allSettled(files.map((f) => fs.promises.rm(f, { force: true })));
        await profiler.forgetCaptures(files.filter((_, i) => results[i].status === 'fulfilled'));
        const failed = files.filter((_, i) => results[i].status === 'rejected');
        if (failed.length) throw new Error(`Could not delete ${failed.map((f) => path.basename(f)).join(', ')}.`);
      }),
    ),
  );
  return { annotations, profiler }; // for integration tests
}

export function deactivate(): void {}
