import * as vscode from 'vscode';
import * as path from 'path';
import { isAlive } from './collector';
import { listProcesses } from './targets';

export interface DebuggedProcess {
  pid: number;
  name: string;
  /** Shown under the name: the debug session it belongs to. */
  title: string;
}

/**
 * The processes of the running debug sessions, for the profiler's "Current" target. The pid comes from the debug
 * adapter's `process` event (systemProcessId), else from the `processId` of an attach configuration, else from the
 * process list, by the launched program's path.
 */
export class DebugTargets implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly pids = new Map<string, number>();
  /** Running sessions by id, oldest first (the API only exposes the active one). */
  private readonly sessions = new Map<string, vscode.DebugSession>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      this.changed,
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session) => ({
          onWillStartSession: () => void this.sessions.set(session.id, session),
          onDidSendMessage: (m: any) => {
            const pid = m?.type === 'event' && m.event === 'process' ? m.body?.systemProcessId : undefined;
            if (typeof pid === 'number' && pid > 0) this.set(session, pid);
          },
        }),
      }),
      vscode.debug.onDidStartDebugSession((s) => {
        this.sessions.set(s.id, s);
        void this.guess(s);
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        this.sessions.delete(s.id);
        if (this.pids.delete(s.id)) this.changed.fire();
      }),
      vscode.debug.onDidChangeActiveDebugSession(() => this.changed.fire()),
    );
    const active = vscode.debug.activeDebugSession;
    if (active) {
      this.sessions.set(active.id, active);
      void this.guess(active);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /** The process of the active debug session, else of the most recent session that has one. */
  current(): DebuggedProcess | undefined {
    const active = vscode.debug.activeDebugSession;
    const candidates = [...(active ? [active] : []), ...[...this.sessions.values()].reverse()];
    for (const s of candidates) {
      const pid = this.pids.get(s.id);
      if (pid !== undefined && isAlive(pid)) return { pid, name: processName(s), title: `Debug session "${s.name}"` };
    }
    return undefined;
  }

  private set(session: vscode.DebugSession, pid: number): void {
    if (this.pids.get(session.id) === pid) return;
    this.pids.set(session.id, pid);
    this.changed.fire();
  }

  /** For adapters that send no `process` event. */
  private async guess(s: vscode.DebugSession): Promise<void> {
    const c = s.configuration;
    const attached = Number(c.processId);
    if (c.request === 'attach' && Number.isInteger(attached) && attached > 0) {
      this.set(s, attached);
      return;
    }
    const program = typeof c.program === 'string' && path.isAbsolute(c.program) ? path.normalize(c.program).toLowerCase() : '';
    if (!program) return;
    // The launched process appears after a moment; newest pid first if the program runs more than once.
    for (let attempt = 0; attempt < 5 && !this.pids.has(s.id); attempt++) {
      await new Promise((r) => setTimeout(r, 1000 + attempt * 1000));
      if (!this.sessions.has(s.id) || this.pids.has(s.id)) return;
      const procs = await listProcesses().catch(() => []);
      const match = procs.filter((p) => p.path && path.normalize(p.path).toLowerCase() === program).sort((a, b) => b.pid - a.pid)[0];
      if (match) this.set(s, match.pid);
    }
  }
}

function processName(s: vscode.DebugSession): string {
  const program = s.configuration.program;
  return typeof program === 'string' && program ? path.basename(program) : s.name;
}
