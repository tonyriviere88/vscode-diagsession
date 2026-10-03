import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Thin wrapper over VSDiagnostics.exe, the Diagnostics Hub standard collector that Visual Studio's Performance
// Profiler drives. It needs no elevation: the collector service starts on demand.

export const CPU_AGENT_CLSID = '4EA90761-2248-496C-B854-3C0399A591A4';

export interface VsdResult {
  code: number;
  out: string;
}

export interface LaunchTarget {
  program: string;
  args: string;
  cwd?: string;
  env?: Record<string, string>;
}

let cachedExe: string | undefined;

/** VSDiagnostics.exe from the setting, else from the newest Visual Studio install that has the profiling tools. */
export function findVsDiagnostics(): string | undefined {
  const override = vscode.workspace.getConfiguration('diagsession').get<string>('profiler.vsDiagnosticsPath', '');
  if (override) return fs.existsSync(override) ? override : undefined;
  if (cachedExe && fs.existsSync(cachedExe)) return cachedExe;

  const installs: string[] = [];
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (fs.existsSync(vswhere)) {
    const r = cp.spawnSync(vswhere, ['-all', '-prerelease', '-products', '*', '-sort', '-property', 'installationPath'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    installs.push(...(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  }
  for (const inst of installs) {
    const exe = path.join(inst, 'Team Tools', 'DiagnosticsHub', 'Collector', 'VSDiagnostics.exe');
    if (fs.existsSync(exe)) return (cachedExe = exe);
  }
  return undefined;
}

function requireExe(): string {
  const exe = findVsDiagnostics();
  if (!exe) {
    throw new Error(
      'VSDiagnostics.exe not found. Install Visual Studio with the C++ profiling tools, or set diagsession.profiler.vsDiagnosticsPath.',
    );
  }
  return exe;
}

export function runVsd(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<VsdResult & { pid?: number }> {
  const exe = requireExe();
  return new Promise((resolve, reject) => {
    const child = cp.spawn(exe, args, {
      windowsHide: true,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: string) => (out += d));
    child.on('error', (e) => reject(new Error(`cannot start ${exe}: ${e.message}`)));
    child.on('close', (code) =>
      resolve({ code: code ?? -1, out: out.replace('Microsoft (R) VS Standard Collector', '').trim(), pid: child.pid }),
    );
  });
}

export type SessionStatus = 'running' | 'paused' | 'stopped' | 'missing' | 'unknown';

export async function status(id: number): Promise<SessionStatus> {
  const { out } = await runVsd(['status', String(id)]);
  if (/does not exist/i.test(out)) return 'missing';
  if (/\bRunning\b/.test(out)) return 'running';
  if (/\bPaused\b/.test(out)) return 'paused';
  if (/\bStopped\b/.test(out)) return 'stopped';
  return 'unknown';
}

/**
 * A session id the collector does not know. A failed start leaves its id stuck in "Created" until the collector
 * service recycles, so ids that failed recently are skipped.
 */
export async function pickFreeSessionId(burnt: Set<number>): Promise<number> {
  for (let id = 100; id < 356; id++) {
    const sid = id % 256;
    if (sid === 0 || burnt.has(sid)) continue;
    if ((await status(sid)) === 'missing') return sid;
  }
  throw new Error('no free VSDiagnostics session id in [1, 255]');
}

export async function writeAgentConfig(dir: string, rate: number): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `cpu_${rate}.json`);
  const cfg = { Agents: [{ CLSID: CPU_AGENT_CLSID, Name: 'DiagnosticsHub.CpuAgent.dll', Config: { cpuSampleRate: rate } }] };
  await fs.promises.writeFile(file, JSON.stringify(cfg, null, 2));
  return file;
}

export interface StartResult {
  /** PID of VSDiagnostics.exe: the parent of a launched target. */
  collectorPid?: number;
}

export async function start(id: number, config: string, target: { pid: number } | LaunchTarget): Promise<StartResult> {
  const args = ['start', String(id), `/loadConfig:${config}`];
  let opts = {};
  if ('pid' in target) {
    args.push(`/attach:${target.pid}`);
  } else {
    args.push(`/launch:${target.program}`);
    if (target.args) args.push(`/launchArgs:${target.args}`);
    // The launched target inherits the collector client's working directory and environment.
    opts = { cwd: target.cwd, env: target.env };
  }
  const r = await runVsd(args, opts);
  if (r.code !== 0 || !/\bRunning\b/.test(r.out)) throw new Error(r.out || `VSDiagnostics start exited with code ${r.code}`);
  return { collectorPid: r.pid };
}

async function expect(args: string[], state: RegExp): Promise<void> {
  const r = await runVsd(args);
  if (!state.test(r.out)) throw new Error(r.out || `VSDiagnostics ${args[0]} exited with code ${r.code}`);
}

export const pause = (id: number) => expect(['pause', String(id)], /\bPaused\b/);
export const resume = (id: number) => expect(['resume', String(id)], /\bRunning\b/);

export async function stop(id: number, output: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const r = await runVsd(['stop', String(id), `/output:${output}`]);
  if (!fs.existsSync(output)) throw new Error(r.out || `VSDiagnostics stop exited with code ${r.code}`);
}

/** PID of the process VSDiagnostics launched: its child. */
export function findLaunchedPid(collectorPid: number, program: string): Promise<number | undefined> {
  const exe = path.basename(program).replace(/'/g, "''");
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ParentProcessId=${collectorPid}" | Where-Object Name -eq '${exe}' | Select-Object -First 1; ` +
    `if ($p) { $p.ProcessId }`;
  return new Promise((resolve) => {
    cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
      const pid = Number.parseInt(String(stdout).trim(), 10);
      resolve(err || !Number.isFinite(pid) ? undefined : pid);
    });
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // exists, but belongs to another user
  }
}
