// The Profiler view of the activity bar: choose a target, start, pause, resume, stop.
import type { FromProfilerView, ProfilerConfig, ProfilerViewState, SessionInfo, TargetKind, ToProfilerView } from '../shared/profilerProtocol';
import { el } from './util';

declare function acquireVsCodeApi(): { postMessage(m: FromProfilerView): void };
const host = acquireVsCodeApi();
const send = (m: FromProfilerView) => host.postMessage(m);
const setConfig = (config: Partial<ProfilerConfig>) => send({ type: 'config', config });

let state: ProfilerViewState | undefined;

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { class: cls, type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

function field(label: string, ...content: (Node | string)[]): HTMLElement {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), el('span', { class: 'field-row' }, ...content));
}

function textInput(key: 'program' | 'args' | 'cwd', placeholder: string): HTMLInputElement {
  const i = el('input', { type: 'text', placeholder, spellcheck: 'false' });
  i.addEventListener('change', () => setConfig({ [key]: i.value.trim() }));
  return i;
}

function checkbox(key: 'startPaused' | 'stopWhenTargetExits' | 'openReport', label: string, hint: string): [HTMLElement, HTMLInputElement] {
  const c = el('input', { type: 'checkbox' });
  c.addEventListener('change', () => setConfig({ [key]: c.checked }));
  return [el('label', { class: 'check', title: hint }, c, el('span', {}, label)), c];
}

// ---------------------------------------------------------------------------------------------------------------------
// Setup form (no active session)
// ---------------------------------------------------------------------------------------------------------------------

const kinds: [TargetKind, string, string][] = [
  ['process', 'Process', 'Attach to a running process'],
  ['executable', 'Executable', 'Launch an executable'],
  ['launchConfig', 'Launch config', 'Launch the program of a launch.json debug configuration'],
];
const kindButtons = new Map<TargetKind, HTMLButtonElement>();
const kindBar = el('div', { class: 'segmented', role: 'tablist' });
for (const [kind, label, hint] of kinds) {
  const b = button(label, () => setConfig({ targetKind: kind }));
  b.title = hint;
  b.setAttribute('role', 'tab');
  kindButtons.set(kind, b);
  kindBar.append(b);
}

const procName = el('div', { class: 'proc-name' });
const procDetail = el('div', { class: 'proc-detail' });
const followDebugger = el('input', { type: 'checkbox' });
followDebugger.addEventListener('change', () => setConfig({ followDebugger: followDebugger.checked }));
const procPane = el(
  'div',
  { class: 'pane' },
  el(
    'label',
    { class: 'check', title: 'Profile the process being debugged, following the active debug session. Choosing another process unchecks it.' },
    followDebugger,
    el('span', {}, 'Current'),
    el('span', { class: 'muted' }, ' — the debugged process'),
  ),
  el('div', { class: 'proc-card' }, procName, procDetail),
  button('Choose process…', () => send({ type: 'pickProcess' })),
);

const program = textInput('program', 'C:\\path\\to\\app.exe');
const args = textInput('args', 'optional');
const cwd = textInput('cwd', 'folder of the executable');
const exePane = el(
  'div',
  { class: 'pane' },
  field('Program', program, button('…', () => send({ type: 'browseProgram' }), 'icon')),
  field('Arguments', args),
  field('Working directory', cwd, button('…', () => send({ type: 'browseCwd' }), 'icon')),
);

const launchSelect = el('select');
launchSelect.addEventListener('change', () => setConfig({ launchConfig: launchSelect.value }));
const launchEmpty = el(
  'div',
  { class: 'hint' },
  'No debug configuration with a program in launch.json. ',
  button('Open launch.json', () => send({ type: 'openLaunchJson' }), 'link'),
);
const launchPane = el('div', { class: 'pane' }, field('Configuration', launchSelect), launchEmpty);

const rateSelect = el('select');
for (const [v, label] of [
  [100, 'Low — 100 Hz (long captures)'],
  [1000, 'Standard — 1 000 Hz'],
  [4000, 'High — 4 000 Hz (short bursts)'],
] as const) {
  rateSelect.append(el('option', { value: String(v) }, label));
}
rateSelect.addEventListener('change', () => setConfig({ rate: Number(rateSelect.value) }));

const [startPausedRow, startPaused] = checkbox(
  'startPaused',
  'Start paused',
  'Attach first, then press Resume at the moment you want to measure: the capture holds only that window.',
);
const [stopOnExitRow, stopOnExit] = checkbox('stopWhenTargetExits', 'Stop when the target exits', 'Collect the report as soon as the profiled process ends.');
const [openReportRow, openReport] = checkbox('openReport', 'Open the report when stopped', 'Open the .diagsession in the profile viewer.');

const outputPath = el('div', { class: 'path' });
const setup = el(
  'div',
  { class: 'setup' },
  el('h3', {}, 'Target'),
  kindBar,
  procPane,
  exePane,
  launchPane,
  el('h3', {}, 'Tool'),
  el('div', { class: 'tool' }, el('span', { class: 'tool-name' }, 'CPU Usage'), el('span', { class: 'muted' }, ' — sampling of every thread')),
  field('Sampling rate', rateSelect),
  el('h3', {}, 'Options'),
  startPausedRow,
  stopOnExitRow,
  openReportRow,
  el('h3', {}, 'Output'),
  el(
    'div',
    { class: 'output' },
    outputPath,
    el(
      'span',
      { class: 'field-row' },
      button('Change…', () => send({ type: 'browseOutput' })),
      button('Open folder', () => send({ type: 'openOutput' })),
    ),
  ),
);
const startButton = button('● Start', () => send({ type: 'command', command: 'start' }), 'primary big');

// ---------------------------------------------------------------------------------------------------------------------
// Live session
// ---------------------------------------------------------------------------------------------------------------------

const dot = el('span', { class: 'dot' });
const phaseLabel = el('span', { class: 'phase' });
const liveTarget = el('div', { class: 'live-target' });
const exited = el('div', { class: 'warning' }, 'The target process has exited.');
const recorded = el('div', { class: 'clock' });
const elapsed = el('div', { class: 'muted' });
const pauseButton = button('❚❚ Pause', () => send({ type: 'command', command: 'pause' }), 'primary');
const resumeButton = button('▶ Resume', () => send({ type: 'command', command: 'resume' }), 'primary');
const stopButton = button('■ Stop', () => send({ type: 'command', command: 'stop' }));
const discardButton = button('Discard', () => send({ type: 'command', command: 'discard' }), 'link');
stopButton.title = 'Stop collecting and write the .diagsession report';
discardButton.title = 'Stop collecting and throw the data away';
const live = el(
  'div',
  { class: 'live' },
  el('div', { class: 'live-head' }, dot, phaseLabel),
  liveTarget,
  exited,
  el('div', { class: 'clock-label' }, 'Recorded'),
  recorded,
  elapsed,
  el('div', { class: 'controls' }, pauseButton, resumeButton, stopButton),
  el('div', { class: 'discard' }, discardButton),
);

const noCollector = el(
  'div',
  { class: 'warning' },
  'VSDiagnostics.exe was not found. Install Visual Studio with the C++ profiling tools, or set ',
  el('code', {}, 'diagsession.profiler.vsDiagnosticsPath'),
  '.',
);

const app = document.getElementById('app')!;
app.append(noCollector, setup, startButton, live);

// ---------------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------------

function show(e: HTMLElement, visible: boolean) {
  e.classList.toggle('hidden', !visible);
}

function setValue(i: HTMLInputElement | HTMLSelectElement, v: string) {
  if (document.activeElement !== i && i.value !== v) i.value = v;
}

function duration(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mmss = `${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

const PHASES: Record<SessionInfo['phase'], string> = {
  starting: 'Starting…',
  running: 'Recording',
  pausing: 'Pausing…',
  paused: 'Paused',
  resuming: 'Resuming…',
  stopping: 'Collecting the trace…',
  discarding: 'Discarding…',
};

function renderClock(s: SessionInfo) {
  const now = Date.now();
  recorded.textContent = duration(s.recordedMs + (s.runningSince !== undefined ? now - s.runningSince : 0));
  elapsed.textContent = `${duration(now - s.startedAt)} since start · ${s.rate.toLocaleString('en-US')} Hz`;
}

function render() {
  if (!state) return;
  const { config: c, session: s } = state;
  show(noCollector, !state.collector);
  show(setup, !s);
  show(startButton, !s);
  show(live, !!s);
  startButton.disabled = !state.collector;

  for (const [kind, b] of kindButtons) {
    b.classList.toggle('selected', kind === c.targetKind);
    b.setAttribute('aria-selected', String(kind === c.targetKind));
  }
  show(procPane, c.targetKind === 'process');
  show(exePane, c.targetKind === 'executable');
  show(launchPane, c.targetKind === 'launchConfig');

  // "Current" shows the debugged process; without a debug session, the last chosen process is used.
  followDebugger.checked = c.followDebugger;
  const debugged = c.followDebugger ? state.debugProcess : null;
  const proc = debugged ?? c.process;
  procName.textContent = proc ? `${proc.name} (${proc.pid})` : 'No process chosen';
  procDetail.textContent = debugged
    ? debugged.title
    : c.followDebugger
      ? (c.process ? 'No debug session: last chosen process. ' : 'No debug session. ') + 'Start debugging, or choose a process.'
      : proc
        ? proc.title
        : 'Start asks for one.';
  procName.classList.toggle('muted', !proc);
  setValue(program, c.program);
  setValue(args, c.args);
  setValue(cwd, c.cwd);

  const options = state.launchConfigs.map((n) => el('option', { value: n }, n));
  if (c.launchConfig && !state.launchConfigs.includes(c.launchConfig)) {
    options.unshift(el('option', { value: c.launchConfig }, `${c.launchConfig} (missing)`));
  }
  launchSelect.replaceChildren(...options);
  if (c.launchConfig) launchSelect.value = c.launchConfig;
  show(launchSelect.closest('.field') as HTMLElement, state.launchConfigs.length > 0);
  show(launchEmpty, state.launchConfigs.length === 0);

  setValue(rateSelect, String(c.rate));
  startPaused.checked = c.startPaused;
  stopOnExit.checked = c.stopWhenTargetExits;
  openReport.checked = c.openReport;
  outputPath.textContent = state.outputFolder;
  outputPath.title = state.outputFolder;
  startButton.textContent = c.startPaused ? '● Start paused' : '● Start';

  if (s) {
    live.dataset.phase = s.phase;
    phaseLabel.textContent = PHASES[s.phase];
    liveTarget.textContent = s.pid !== undefined && !s.target.includes(`(${s.pid})`) ? `${s.target} · PID ${s.pid}` : s.target;
    show(exited, s.targetExited);
    show(pauseButton, s.phase !== 'paused' && s.phase !== 'resuming');
    show(resumeButton, s.phase === 'paused' || s.phase === 'resuming');
    pauseButton.disabled = s.phase !== 'running';
    resumeButton.disabled = s.phase !== 'paused';
    stopButton.disabled = discardButton.disabled = s.phase !== 'running' && s.phase !== 'paused';
    renderClock(s);
  }
}

setInterval(() => state?.session && renderClock(state.session), 250);

window.addEventListener('message', (e: MessageEvent<ToProfilerView>) => {
  if (e.data.type === 'state') {
    state = e.data.state;
    render();
  }
});
send({ type: 'ready' });
