// Messages between the extension host and the Profiler view (activity bar).

export type TargetKind = 'process' | 'executable' | 'launchConfig';

export interface ProfilerConfig {
  targetKind: TargetKind;
  process?: { pid: number; name: string; title: string };
  /** "Current": the process target follows the process being debugged, when there is one. */
  followDebugger: boolean;
  program: string;
  args: string;
  cwd: string;
  launchConfig: string;
  /** CPU samples per second: 100, 1000 (Visual Studio's default) or 4000. */
  rate: number;
  startPaused: boolean;
  stopWhenTargetExits: boolean;
  openReport: boolean;
  /** Empty uses diagsession.profiler.outputFolder, else the extension storage. */
  outputFolder: string;
}

export type SessionPhase = 'starting' | 'running' | 'paused' | 'pausing' | 'resuming' | 'stopping' | 'discarding';

export interface SessionInfo {
  phase: SessionPhase;
  id: number;
  target: string;
  pid?: number;
  targetExited: boolean;
  rate: number;
  output: string;
  /** Epoch ms. */
  startedAt: number;
  /** Sampled time of the finished running segments. */
  recordedMs: number;
  /** Epoch ms of the start of the current running segment. */
  runningSince?: number;
}

export interface ProfilerViewState {
  config: ProfilerConfig;
  session?: SessionInfo;
  launchConfigs: string[];
  /** The process of the active debug session, if any. */
  debugProcess: { pid: number; name: string; title: string } | null;
  collector: string | null;
  outputFolder: string;
}

export type ToProfilerView = { type: 'state'; state: ProfilerViewState };

export type FromProfilerView =
  | { type: 'ready' }
  | { type: 'config'; config: Partial<ProfilerConfig> }
  | { type: 'pickProcess' }
  | { type: 'browseProgram' }
  | { type: 'browseCwd' }
  | { type: 'browseOutput' }
  | { type: 'openOutput' }
  | { type: 'openLaunchJson' }
  | { type: 'command'; command: 'start' | 'pause' | 'resume' | 'stop' | 'discard' };
