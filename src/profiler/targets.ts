import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import type { LaunchTarget } from './collector';

export interface ProcessInfo {
  pid: number;
  name: string;
  title: string;
  path: string;
}

export function listProcesses(): Promise<ProcessInfo[]> {
  const script =
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
    'Get-Process | Where-Object Id -gt 4 | Select-Object Id, ProcessName, MainWindowTitle, Path | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    cp.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(err);
        const rows = JSON.parse(stdout || '[]');
        resolve(
          (Array.isArray(rows) ? rows : [rows]).map((r: any) => ({
            pid: r.Id,
            name: r.ProcessName + '.exe',
            title: r.MainWindowTitle ?? '',
            path: r.Path ?? '',
          })),
        );
      },
    );
  });
}

/** Quick pick of the running processes, windowed applications first. */
export async function pickProcess(): Promise<ProcessInfo | undefined> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { proc?: ProcessInfo }>();
  qp.title = 'Attach the profiler to a process';
  qp.placeholder = 'Filter by name, PID or window title';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;
  qp.show();
  try {
    const procs = (await listProcesses()).filter((p) => p.pid !== process.pid);
    const byName = (a: ProcessInfo, b: ProcessInfo) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.pid - b.pid;
    const windowed = procs.filter((p) => p.title).sort(byName);
    const others = procs.filter((p) => !p.title).sort(byName);
    const item = (p: ProcessInfo) => ({ label: p.name, description: String(p.pid), detail: p.title || p.path || undefined, proc: p });
    qp.items = [
      { label: 'Applications', kind: vscode.QuickPickItemKind.Separator },
      ...windowed.map(item),
      { label: 'Background processes', kind: vscode.QuickPickItemKind.Separator },
      ...others.map(item),
    ];
  } catch (e) {
    qp.hide();
    throw e;
  } finally {
    qp.busy = false;
  }
  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.proc);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
  });
}

export interface LaunchConfigInfo {
  name: string;
  folder?: vscode.WorkspaceFolder;
  config: any;
  /** The `inputs` of the launch.json that holds the configuration, for `${input:…}`. */
  inputs: any[];
}

/** Workspace debug configurations that start a program (cppvsdbg, cppdbg, …). */
export function launchConfigurations(): LaunchConfigInfo[] {
  const result: LaunchConfigInfo[] = [];
  const add = (folder: vscode.WorkspaceFolder | undefined, configs: any[] | undefined, inputs: any[] | undefined) => {
    for (const c of configs ?? []) {
      if (c?.request === 'launch' && typeof c.program === 'string' && typeof c.name === 'string') {
        result.push({ name: c.name, folder, config: c, inputs: Array.isArray(inputs) ? inputs : [] });
      }
    }
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const launch = vscode.workspace.getConfiguration('launch', folder.uri);
    add(folder, launch.get<any[]>('configurations'), launch.get<any[]>('inputs'));
  }
  if (vscode.workspace.workspaceFile) {
    const launch = vscode.workspace.getConfiguration('launch');
    add(undefined, launch.inspect<any[]>('configurations')?.workspaceValue, launch.inspect<any[]>('inputs')?.workspaceValue);
  }
  return result;
}

/**
 * Resolves the variables VS Code supports in launch.json: workspace and file variables, `${env:…}`, `${config:…}`,
 * `${command:…}` (e.g. `cmake.launchTargetPath`) and `${input:…}`. Each variable is resolved once, so an input used
 * in several fields prompts only once.
 */
class VariableResolver {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly folder: vscode.WorkspaceFolder | undefined,
    private readonly inputs: any[],
  ) {}

  async resolve(value: string): Promise<string> {
    let out = '';
    let last = 0;
    for (const m of value.matchAll(/\$\{([^}]+)\}/g)) {
      out += value.slice(last, m.index) + (await this.variable(m[1]));
      last = m.index! + m[0].length;
    }
    return out + value.slice(last);
  }

  private async variable(name: string): Promise<string> {
    let v = this.cache.get(name);
    if (v === undefined) {
      v = await this.compute(name);
      this.cache.set(name, v);
    }
    return v;
  }

  private async compute(name: string): Promise<string> {
    const folder = this.folder ?? vscode.workspace.workspaceFolders?.[0];
    const ws = folder?.uri.fsPath ?? '';
    const editor = vscode.window.activeTextEditor;
    const file = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined;
    const needFile = (f: (file: string) => string) => {
      if (!file) throw new Error(`\${${name}} needs an open file.`);
      return f(file);
    };

    const colon = name.indexOf(':');
    const [kind, arg] = colon < 0 ? [name, ''] : [name.slice(0, colon), name.slice(colon + 1)];
    switch (kind) {
      case 'workspaceFolder': {
        if (!arg) return ws;
        const f = vscode.workspace.workspaceFolders?.find((w) => w.name === arg);
        if (!f) throw new Error(`no workspace folder named "${arg}".`);
        return f.uri.fsPath;
      }
      case 'workspaceRoot':
      case 'cwd':
        return ws;
      case 'workspaceFolderBasename':
        return path.basename(ws);
      case 'userHome':
        return os.homedir();
      case 'pathSeparator':
      case '/':
        return path.sep;
      case 'execPath':
        return process.execPath;
      case 'env':
        return process.env[arg] ?? '';
      case 'config': {
        const value = vscode.workspace.getConfiguration(undefined, folder?.uri).get(arg);
        if (value === undefined || value === null) return '';
        return typeof value === 'string' ? value : JSON.stringify(value);
      }
      case 'file':
        return needFile((f) => f);
      case 'fileBasename':
        return needFile((f) => path.basename(f));
      case 'fileBasenameNoExtension':
        return needFile((f) => path.parse(f).name);
      case 'fileExtname':
        return needFile((f) => path.extname(f));
      case 'fileDirname':
        return needFile((f) => path.dirname(f));
      case 'fileDirnameBasename':
        return needFile((f) => path.basename(path.dirname(f)));
      case 'relativeFile':
        return needFile((f) => path.relative(ws, f));
      case 'relativeFileDirname':
        return needFile((f) => path.relative(ws, path.dirname(f)));
      case 'fileWorkspaceFolder':
        return needFile((f) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f))?.uri.fsPath ?? ws);
      case 'lineNumber':
        return String((editor?.selection.active.line ?? 0) + 1);
      case 'selectedText':
        return editor ? editor.document.getText(editor.selection) : '';
      case 'command':
        return this.command(arg);
      case 'input':
        return this.input(arg);
    }
    throw new Error(`unsupported variable \${${name}}.`);
  }

  private async command(id: string, args?: unknown): Promise<string> {
    const result = args === undefined ? await vscode.commands.executeCommand<unknown>(id) : await vscode.commands.executeCommand<unknown>(id, args);
    if (result === undefined || result === null || result === '') {
      throw new Error(`the command ${id} returned no value (cancelled, or no target selected?).`);
    }
    return String(result);
  }

  private async input(id: string): Promise<string> {
    const input = this.inputs.find((i) => i?.id === id);
    if (!input) throw new Error(`no input named "${id}" in launch.json.`);
    let value: string | undefined;
    switch (input.type) {
      case 'promptString':
        value = await vscode.window.showInputBox({
          prompt: input.description,
          value: input.default,
          password: !!input.password,
          ignoreFocusOut: true,
        });
        break;
      case 'pickString': {
        const items = (input.options ?? []).map((o: any) =>
          typeof o === 'string' ? { label: o, value: o } : { label: o.label ?? o.value, description: o.label ? o.value : undefined, value: o.value },
        );
        const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { value: string }>(items, {
          placeHolder: input.description,
          ignoreFocusOut: true,
        });
        value = picked?.value;
        break;
      }
      case 'command':
        return this.command(input.command, input.args);
      default:
        throw new Error(`input "${id}" has an unsupported type "${input.type}".`);
    }
    if (value === undefined) throw new vscode.CancellationError();
    return value;
  }
}

/** Windows command-line quoting (the rules CommandLineToArgvW reverses). */
export function quoteArg(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/** Program, arguments, working directory and environment of a debug configuration, variables resolved. */
export async function resolveLaunchConfig(info: LaunchConfigInfo): Promise<LaunchTarget> {
  const c = info.config;
  const vars = new VariableResolver(info.folder, info.inputs);
  const sub = async (s: string) => {
    try {
      return await vars.resolve(s);
    } catch (e) {
      if (e instanceof vscode.CancellationError) throw e;
      throw new Error(`"${info.name}": ${e instanceof Error ? e.message : e}`);
    }
  };
  // Relative paths are relative to the workspace folder, not to VS Code's own working directory.
  const ws = (info.folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath ?? '';
  const program = path.resolve(ws, await sub(c.program));
  let args = '';
  if (Array.isArray(c.args)) {
    const parts: string[] = [];
    for (const a of c.args) parts.push(quoteArg(await sub(String(a))));
    args = parts.join(' ');
  } else if (typeof c.args === 'string') {
    args = await sub(c.args);
  }
  const env: Record<string, string> = {};
  if (Array.isArray(c.environment)) {
    for (const e of c.environment) if (e?.name) env[e.name] = await sub(String(e.value ?? ''));
  }
  if (c.env && typeof c.env === 'object') {
    for (const [k, v] of Object.entries(c.env)) env[k] = await sub(String(v ?? ''));
  }
  return {
    program,
    args,
    cwd: typeof c.cwd === 'string' && c.cwd ? path.resolve(ws, await sub(c.cwd)) : path.dirname(program),
    env: Object.keys(env).length ? env : undefined,
  };
}
