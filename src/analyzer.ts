import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { RawProfile } from '../shared/protocol';
import { applySymbolPatch, type SymbolPatch } from './symbolPatch';

export interface AnalyzeRequest {
  file: string;
  pid?: number;
  msSymbols: boolean;
  /** Only load the PDBs next to their binary. */
  localSymbols: boolean;
  /** Module files whose PDBs are searched everywhere, Microsoft symbol server included. */
  loadSymbols: string[];
}

export interface AnalyzeResult {
  json: string;
  fromCache: boolean;
}

interface SymbolSettings {
  paths: string[];
  cache?: string;
}

/** Symbol folders and cache from the extension settings, plus the workspace debug configurations. */
function symbolSettings(): SymbolSettings {
  const cfg = vscode.workspace.getConfiguration('diagsession');
  const paths = [...cfg.get<string[]>('symbolPaths', [])];
  let cache = cfg.get<string>('symbolCache', '') || undefined;

  if (cfg.get<boolean>('useLaunchJsonSymbols', true)) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const launches = vscode.workspace.getConfiguration('launch', folder.uri).get<any[]>('configurations', []);
      for (const c of launches) {
        const search = typeof c?.symbolSearchPath === 'string' ? c.symbolSearchPath : '';
        for (const part of search.split(';').map((s: string) => s.trim())) {
          // Symbol-server URLs are only used when downloads are allowed (the server is added by the analyzer).
          if (part && !/^https?:/i.test(part) && !paths.includes(part)) paths.push(part);
        }
        const cachePath = c?.symbolOptions?.cachePath;
        if (!cache && typeof cachePath === 'string' && cachePath) cache = cachePath;
      }
    }
  }
  return { paths: paths.map(expandVars), cache: cache && expandVars(cache) };
}

function expandVars(s: string): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return s.replace(/\$\{workspaceFolder\}/g, ws).replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
}

function analyzerExe(context: vscode.ExtensionContext): string {
  const override = vscode.workspace.getConfiguration('diagsession').get<string>('analyzerPath', '');
  if (override) return override;
  return path.join(context.extensionPath, 'bin', 'analyzer', 'DiagSessionAnalyzer.exe');
}

export function cacheRoot(context: vscode.ExtensionContext): string {
  return context.globalStorageUri.fsPath;
}

/** Runs DiagSessionAnalyzer (or returns a cached profile) and resolves with the profile JSON text. */
export async function analyze(
  context: vscode.ExtensionContext,
  req: AnalyzeRequest,
  onProgress: (text: string) => void,
  token: vscode.CancellationToken,
): Promise<AnalyzeResult> {
  const stat = await fs.promises.stat(req.file);
  const sym = symbolSettings();
  const exe = analyzerExe(context);
  const version = context.extension.packageJSON.version as string;
  const root = cacheRoot(context);
  const profiles = path.join(root, 'profiles');
  await fs.promises.mkdir(profiles, { recursive: true });
  const profilePath = (r: AnalyzeRequest) => {
    const key = crypto
      .createHash('sha1')
      .update(
        JSON.stringify([
          version,
          r.file.toLowerCase(),
          stat.size,
          stat.mtimeMs,
          r.pid ?? null,
          r.msSymbols,
          r.localSymbols,
          [...r.loadSymbols].sort(),
          sym,
        ]),
      )
      .digest('hex')
      .slice(0, 20);
    return path.join(profiles, key + '.json');
  };

  const out = profilePath(req);
  if (fs.existsSync(out)) {
    return { json: await fs.promises.readFile(out, 'utf8'), fromCache: true };
  }
  if (!fs.existsSync(exe)) {
    throw new Error(`DiagSessionAnalyzer not found at ${exe}. Build it with "npm run build:analyzer".`);
  }

  const args = [req.file, '--cache-dir', path.join(root, 'traces')];
  if (sym.paths.length) args.push('--symbols', sym.paths.join(';'));
  if (sym.cache) args.push('--symbol-cache', sym.cache);
  if (req.msSymbols) args.push('--ms-symbols');
  if (req.localSymbols) args.push('--local-symbols');

  // One more module to load on a cached profile: only resolve that module and merge it in (seconds, not a full run).
  const added = req.loadSymbols[req.loadSymbols.length - 1];
  const basePath = added ? profilePath({ ...req, loadSymbols: req.loadSymbols.slice(0, -1) }) : '';
  if (added && fs.existsSync(basePath)) {
    const raw = JSON.parse(await fs.promises.readFile(basePath, 'utf8')) as RawProfile;
    const tmp = out + '.patch.tmp';
    try {
      await runAnalyzer(exe, [...args, '--out', tmp, '--pid', String(raw.process.pid), '--patch', '--load-symbols', added], onProgress, token);
      const patch = JSON.parse(await fs.promises.readFile(tmp, 'utf8')) as SymbolPatch;
      if (applySymbolPatch(raw, patch)) {
        const json = JSON.stringify(raw);
        await fs.promises.writeFile(out, json, 'utf8');
        return { json, fromCache: false };
      }
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
    // The patch did not fit the cached profile: analyse from scratch.
  }

  if (req.pid !== undefined) args.push('--pid', String(req.pid));
  if (req.loadSymbols.length) args.push('--load-symbols', req.loadSymbols.join('|'));
  await runAnalyzer(exe, [...args, '--out', out + '.tmp'], onProgress, token);
  await fs.promises.rename(out + '.tmp', out);
  return { json: await fs.promises.readFile(out, 'utf8'), fromCache: false };
}

function runAnalyzer(exe: string, args: string[], onProgress: (text: string) => void, token: vscode.CancellationToken): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = cp.spawn(exe, args, { windowsHide: true });
    const errors: string[] = [];
    let buffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('PROGRESS ')) onProgress(line.slice(9));
        else if (line.startsWith('ERROR ')) errors.push(line.slice(6));
      }
    });
    child.stdout.resume();
    const cancel = token.onCancellationRequested(() => child.kill());
    child.on('error', (e) =>
      reject(new Error(`cannot start ${exe}: ${e.message}. The analyzer needs the .NET 8 (or later) runtime.`)),
    );
    child.on('close', (code) => {
      cancel.dispose();
      if (token.isCancellationRequested) reject(new vscode.CancellationError());
      else if (code === 0) resolve();
      else reject(new Error(errors.join('\n') || `DiagSessionAnalyzer exited with code ${code}`));
    });
  });
}
