import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as collector from './collector';
import { DebugTargets, type DebuggedProcess } from './debugTargets';
import { launchConfigurations, pickProcess, resolveLaunchConfig } from './targets';
import type { ProfilerConfig, SessionInfo } from '../../shared/profilerProtocol';

const CONFIG_KEY = 'profiler.config';
const SESSION_KEY = 'profiler.session';
const BURNT_KEY = 'profiler.burntIds';
const CAPTURES_KEY = 'profiler.captures';
/** How long a session id whose start failed stays unused. */
const BURNT_MS = 60 * 60 * 1000;

interface ActiveSession extends SessionInfo {
  collectorPid?: number;
  program?: string;
}

const DEFAULT_CONFIG: ProfilerConfig = {
  targetKind: 'process',
  followDebugger: true,
  program: '',
  args: '',
  cwd: '',
  launchConfig: '',
  rate: 1000,
  startPaused: false,
  stopWhenTargetExits: true,
  openReport: true,
  outputFolder: '',
};

export interface CaptureDone {
  file: string;
  pid?: number;
}

/**
 * One Diagnostics Hub collection session at a time: start (attach or launch), pause, resume, stop into a
 * .diagsession, or discard. The session outlives a window reload: it is kept in global state and re-adopted when
 * the collector still knows it.
 */
export class Profiler implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly captured = new vscode.EventEmitter<CaptureDone>();
  readonly onDidCapture = this.captured.event;
  private active: ActiveSession | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly debugTargets = new DebugTargets();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.debugTargets.onDidChange(() => this.changed.fire());
    this.statusItem = vscode.window.createStatusBarItem('diagsession.profiler', vscode.StatusBarAlignment.Left, 50);
    this.statusItem.name = 'DiagSession Profiler';
    this.statusItem.command = 'diagsession.profiler.focus';
    void this.adopt();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.statusItem.dispose();
    this.debugTargets.dispose();
    this.changed.dispose();
    this.captured.dispose();
  }

  get session(): SessionInfo | undefined {
    return this.active;
  }

  get config(): ProfilerConfig {
    return { ...DEFAULT_CONFIG, ...this.context.workspaceState.get<Partial<ProfilerConfig>>(CONFIG_KEY) };
  }

  /** The process being debugged, if any. */
  get debugProcess(): DebuggedProcess | undefined {
    return this.debugTargets.current();
  }

  async updateConfig(patch: Partial<ProfilerConfig>): Promise<void> {
    await this.context.workspaceState.update(CONFIG_KEY, { ...this.config, ...patch });
    this.changed.fire();
  }

  outputFolder(config = this.config): string {
    const folder = config.outputFolder || vscode.workspace.getConfiguration('diagsession').get<string>('profiler.outputFolder', '');
    if (!folder) return path.join(this.context.globalStorageUri.fsPath, 'captures');
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return path.resolve(ws, folder.replace(/\$\{workspaceFolder\}/g, ws));
  }

  /** Captures written by the profiler, newest first, that still exist. */
  captures(): string[] {
    return this.context.globalState.get<string[]>(CAPTURES_KEY, []).filter((f) => fs.existsSync(f));
  }

  async forgetCapture(file: string): Promise<void> {
    const list = this.context.globalState.get<string[]>(CAPTURES_KEY, []);
    await this.context.globalState.update(CAPTURES_KEY, list.filter((f) => f.toLowerCase() !== file.toLowerCase()));
    this.changed.fire();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.active) throw new Error('A profiling session is already active.');
    const config = this.config;
    const target = await this.resolveTarget(config);
    if (!target) return;

    const burnt = this.burntIds();
    this.set({
      phase: 'starting',
      id: -1,
      target: target.label,
      pid: 'pid' in target.spec ? target.spec.pid : undefined,
      targetExited: false,
      rate: config.rate,
      output: path.join(this.outputFolder(config), `${target.fileBase}_${timestamp()}.diagsession`),
      startedAt: Date.now(),
      recordedMs: 0,
      program: 'program' in target.spec ? target.spec.program : undefined,
    });
    try {
      const id = await collector.pickFreeSessionId(burnt);
      this.active!.id = id;
      const agentConfig = await collector.writeAgentConfig(path.join(this.context.globalStorageUri.fsPath, 'agents'), config.rate);
      let started: collector.StartResult;
      try {
        started = await collector.start(id, agentConfig, target.spec);
      } catch (e) {
        await this.burn(id);
        throw e;
      }
      const s = this.active!;
      s.collectorPid = started.collectorPid;
      s.startedAt = Date.now();
      if (config.startPaused) {
        await collector.pause(id);
        s.phase = 'paused';
      } else {
        s.phase = 'running';
        s.runningSince = s.startedAt;
      }
      await this.persist();
      this.set(s);
      if (s.program && s.collectorPid) {
        const pid = await collector.findLaunchedPid(s.collectorPid, s.program);
        if (pid && this.session === s) {
          s.pid = pid;
          await this.persist();
          this.set(s);
        }
      }
    } catch (e) {
      this.set(undefined);
      throw e;
    }
  }

  async pause(): Promise<void> {
    const s = this.require('running');
    s.phase = 'pausing';
    this.set(s);
    try {
      await collector.pause(s.id);
      this.closeSegment(s);
      s.phase = 'paused';
    } catch (e) {
      s.phase = 'running';
      throw e;
    } finally {
      await this.persist();
      this.set(s);
    }
  }

  async resume(): Promise<void> {
    const s = this.require('paused');
    s.phase = 'resuming';
    this.set(s);
    try {
      await collector.resume(s.id);
      s.phase = 'running';
      s.runningSince = Date.now();
    } catch (e) {
      s.phase = 'paused';
      throw e;
    } finally {
      await this.persist();
      this.set(s);
    }
  }

  /** Stops the session and writes the .diagsession; resolves with its path. */
  async stop(): Promise<string | undefined> {
    const s = this.require('running', 'paused');
    const previous = s.phase;
    this.closeSegment(s);
    s.phase = 'stopping';
    this.set(s);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Profiler: collecting the trace (this takes about 20 s)…' },
        () => collector.stop(s.id, s.output),
      );
    } catch (e) {
      await this.recover(s, previous);
      throw e;
    }
    this.set(undefined);
    await this.context.globalState.update(SESSION_KEY, undefined);
    const list = this.context.globalState.get<string[]>(CAPTURES_KEY, []).filter((f) => f.toLowerCase() !== s.output.toLowerCase());
    await this.context.globalState.update(CAPTURES_KEY, [s.output, ...list].slice(0, 100));
    this.changed.fire();
    this.captured.fire({ file: s.output, pid: s.pid });
    return s.output;
  }

  /** Stops the session and deletes what it collected. */
  async discard(): Promise<void> {
    const s = this.require('running', 'paused');
    const answer = await vscode.window.showWarningMessage(
      'Discard the profiling session? Nothing it collected is kept.',
      { modal: true },
      'Discard',
    );
    if (answer !== 'Discard' || this.active !== s) return;
    const previous = s.phase;
    s.phase = 'discarding';
    this.set(s);
    const scratch = path.join(this.context.globalStorageUri.fsPath, 'discarded', `session_${s.id}_${Date.now()}.diagsession`);
    try {
      await collector.stop(s.id, scratch);
    } catch (e) {
      await this.recover(s, previous);
      throw e;
    } finally {
      await fs.promises.rm(scratch, { force: true }).catch(() => undefined);
    }
    this.set(undefined);
    await this.context.globalState.update(SESSION_KEY, undefined);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------------------------

  private async resolveTarget(config: ProfilerConfig): Promise<
    { label: string; fileBase: string; spec: { pid: number } | collector.LaunchTarget } | undefined
  > {
    switch (config.targetKind) {
      case 'process': {
        let proc = (config.followDebugger && this.debugProcess) || config.process;
        if (!proc || !collector.isAlive(proc.pid)) {
          const picked = await pickProcess();
          if (!picked) return undefined;
          proc = { pid: picked.pid, name: picked.name, title: picked.title };
          await this.updateConfig({ process: proc, followDebugger: false });
        }
        return { label: `${proc.name} (${proc.pid})`, fileBase: stem(proc.name), spec: { pid: proc.pid } };
      }
      case 'executable': {
        if (!config.program) throw new Error('Choose the executable to launch.');
        const program = path.resolve(config.program);
        if (!fs.existsSync(program)) throw new Error(`${program} does not exist.`);
        return {
          label: path.basename(program),
          fileBase: stem(program),
          spec: { program, args: config.args, cwd: config.cwd || path.dirname(program) },
        };
      }
      case 'launchConfig': {
        const all = launchConfigurations();
        const info = config.launchConfig ? all.find((c) => c.name === config.launchConfig) : all[0];
        if (!info) throw new Error(config.launchConfig ? `No launch configuration named "${config.launchConfig}".` : 'Choose a launch configuration.');
        const spec = await resolveLaunchConfig(info);
        if (!fs.existsSync(spec.program)) throw new Error(`${spec.program} does not exist. Build it first.`);
        return { label: `${path.basename(spec.program)} (${info.name})`, fileBase: stem(spec.program), spec };
      }
    }
  }

  private require(...phases: SessionInfo['phase'][]): ActiveSession {
    const s = this.active;
    if (!s) throw new Error('No profiling session is active.');
    if (!phases.includes(s.phase)) throw new Error(`The profiling session is ${s.phase}.`);
    return s;
  }

  private closeSegment(s: ActiveSession): void {
    if (s.runningSince !== undefined) {
      s.recordedMs += Date.now() - s.runningSince;
      s.runningSince = undefined;
    }
  }

  /** After a failed stop: keep the session if the collector still has it. */
  private async recover(s: ActiveSession, previous: SessionInfo['phase']): Promise<void> {
    const st = await collector.status(s.id).catch(() => 'unknown' as const);
    if (st === 'running' || st === 'paused') {
      s.phase = st;
      if (st === 'running') s.runningSince = Date.now();
      this.set(s);
    } else if (st === 'unknown') {
      s.phase = previous;
      this.set(s);
    } else {
      this.set(undefined);
      await this.context.globalState.update(SESSION_KEY, undefined);
    }
  }

  /** Re-adopt the session a previous window (or a reload) left running. */
  private async adopt(): Promise<void> {
    const saved = this.context.globalState.get<ActiveSession>(SESSION_KEY);
    if (!saved || this.active) return;
    const st = await collector.status(saved.id).catch(() => 'unknown' as const);
    if (st !== 'running' && st !== 'paused') {
      await this.context.globalState.update(SESSION_KEY, undefined);
      return;
    }
    if (saved.runningSince !== undefined && st === 'paused') {
      // Paused from elsewhere: the running time since then is unknown.
      saved.runningSince = undefined;
    } else if (st === 'running' && saved.runningSince === undefined) {
      saved.runningSince = Date.now();
    }
    saved.phase = st;
    this.set(saved);
  }

  private async persist(): Promise<void> {
    await this.context.globalState.update(SESSION_KEY, this.active);
  }

  private burntIds(): Set<number> {
    const now = Date.now();
    const map = this.context.globalState.get<Record<string, number>>(BURNT_KEY, {});
    return new Set(Object.entries(map).filter(([, t]) => now - t < BURNT_MS).map(([id]) => Number(id)));
  }

  private async burn(id: number): Promise<void> {
    const now = Date.now();
    const map = Object.fromEntries(
      Object.entries(this.context.globalState.get<Record<string, number>>(BURNT_KEY, {})).filter(([, t]) => now - t < BURNT_MS),
    );
    map[id] = now;
    await this.context.globalState.update(BURNT_KEY, map);
  }

  private set(s: ActiveSession | undefined): void {
    this.active = s;
    const state = !s ? 'idle' : s.phase === 'running' || s.phase === 'paused' ? s.phase : 'busy';
    void vscode.commands.executeCommand('setContext', 'diagsession.profiler.state', state);
    if (s && !this.timer) this.timer = setInterval(() => this.tick(), 1000);
    if (!s && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.updateStatusBar();
    this.changed.fire();
  }

  private tick(): void {
    const s = this.active;
    if (!s) return;
    if (s.pid !== undefined && !s.targetExited && (s.phase === 'running' || s.phase === 'paused') && !collector.isAlive(s.pid)) {
      s.targetExited = true;
      void this.persist();
      this.changed.fire();
      if (this.config.stopWhenTargetExits) {
        this.stop().catch((e) => vscode.window.showErrorMessage(`Profiler: ${e instanceof Error ? e.message : e}`));
      }
    }
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const s = this.active;
    if (!s) {
      this.statusItem.hide();
      return;
    }
    const recorded = s.recordedMs + (s.runningSince !== undefined ? Date.now() - s.runningSince : 0);
    const icon = { running: '$(record)', paused: '$(debug-pause)' }[s.phase as string] ?? '$(loading~spin)';
    const label = { running: '', paused: 'Paused ', starting: 'Starting ', stopping: 'Collecting ' }[s.phase as string] ?? '';
    this.statusItem.text = `${icon} ${label}${formatDuration(recorded)}`;
    this.statusItem.tooltip = `Profiling ${s.target} — ${s.phase}, ${formatDuration(recorded)} recorded`;
    this.statusItem.backgroundColor = s.phase === 'running' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    this.statusItem.show();
  }
}

export function formatDuration(ms: number): string {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mmss = `${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

function stem(file: string): string {
  return path.basename(file).replace(/\.exe$/i, '').replace(/[^\w.-]+/g, '_');
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
