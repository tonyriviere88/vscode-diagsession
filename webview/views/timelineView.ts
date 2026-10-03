import type { AppApi, View } from '../api';
import { ThreadChart, type Lane } from '../threadChart';
import { el, fmtMs, fmtTime } from '../util';

interface TimelineState {
  /** Thread ids of the expanded lanes; null: the default ones. */
  expanded: number[] | null;
  maxPauseMs: number;
}

/** Lanes expanded until the user picks: the first one (the main thread); a deep stack fills the view on its own. */
const DEFAULT_EXPANDED = 1;

/** How long a thread may pause (preempted, waiting) inside a call that goes on after it. */
const PAUSES: [number, string][] = [
  [0, 'none'],
  [20, '20 ms'],
  [50, '50 ms'],
  [200, '200 ms'],
  [1000, '1 s'],
  [Infinity, 'any length'],
];
const DEFAULT_PAUSE = 50;

/** The calls of each thread over time (a flame chart per thread), the main thread first, then the busiest. */
export class TimelineView implements View {
  readonly id = 'timeline';
  readonly title = 'Timeline';
  readonly searchHint = 'Highlight functions';
  readonly element: HTMLElement;
  private readonly chart: ThreadChart;
  private readonly status: HTMLElement;
  private readonly selection: HTMLElement;
  private readonly reset: HTMLButtonElement;
  private readonly pauseSelect: HTMLSelectElement;
  private maxPauseMs = DEFAULT_PAUSE;
  private lanes: Lane[] = [];
  private expanded: Set<number> | null = null;
  private limits = '';

  constructor(private readonly app: AppApi, signal: AbortSignal) {
    const p = app.profile;
    this.status = el('span', { class: 'status' });
    this.selection = el('span', { class: 'status' });
    this.chart = new ThreadChart(
      p,
      {
        loadRows: (thread) => p.callSpans(app.filter, thread, this.maxPauseMs),
        onActivate: (func) => app.openSource(func),
        onContextMenu: (ref, ev) => {
          const s = this.chart.span(ref);
          app.functionMenu(ev, s.func, undefined, [
            { label: 'Zoom to this call', action: () => this.chart.zoomTo(s.start, s.end) },
            { label: 'Analyse this call only', action: () => app.setTimeRange([s.start, s.end]) },
          ]);
        },
        onLaneMenu: (lane, ev) => {
          app.showMenu(ev, [
            { label: 'Only this thread', action: () => app.setThreads(new Set([lane.thread])) },
            {
              label: 'Hide this thread',
              action: () => {
                const s = new Set(app.filter.threads ?? this.lanes.map((l) => l.thread));
                s.delete(lane.thread);
                app.setThreads(s);
              },
            },
            { label: 'All threads', action: () => app.setThreads(null), disabled: !app.filter.threads },
          ]);
        },
        onToggle: () => {
          this.expanded = new Set(this.lanes.filter((l) => l.expanded).map((l) => p.raw.threads[l.thread].tid));
        },
        onSelect: (func) => {
          this.selection.textContent =
            func < 0 ? '' : `${p.funcLabel(func)}: ${this.chart.countSpans(func).toLocaleString('en-US')} calls in the expanded threads`;
        },
        onWindow: (v0, v1) => {
          this.status.textContent = `${fmtTime(v0)} – ${fmtTime(v1)} (${fmtMs(v1 - v0)})`;
          this.reset.disabled = !this.chart.isZoomed;
        },
      },
      signal,
    );

    this.reset = el('button', { title: 'Show the whole time range' }, 'Reset zoom');
    this.reset.disabled = true;
    this.reset.addEventListener('click', () => this.chart.resetZoom());
    const use = el('button', { title: 'Make the time shown the range every view analyses' }, 'Analyse visible range');
    use.addEventListener('click', () => app.setTimeRange(this.chart.window));
    this.pauseSelect = el('select', {
      title:
        'A thread is not sampled while it is preempted or waiting. A call goes on across such a pause, up to this long, ' +
        'when the same functions are on the stack after it. The strip under each thread name shows the pauses.',
    });
    for (const [ms, label] of PAUSES) {
      const o = el('option', { value: String(ms) }, label);
      if (ms === this.maxPauseMs) o.selected = true;
      this.pauseSelect.append(o);
    }
    this.pauseSelect.addEventListener('change', () => {
      this.maxPauseMs = Number(this.pauseSelect.value);
      this.refresh();
    });
    const expand = el('button', {}, 'Expand all');
    expand.addEventListener('click', () => this.chart.expandAll(true));
    const collapse = el('button', {}, 'Collapse all');
    collapse.addEventListener('click', () => this.chart.expandAll(false));
    this.element = el(
      'div',
      { class: 'view' },
      el(
        'div',
        { class: 'view-toolbar' },
        expand,
        collapse,
        this.reset,
        use,
        el('label', { class: 'field' }, 'Join calls across pauses up to ', this.pauseSelect),
        el('span', { class: 'hint' }, 'Ctrl+wheel: zoom · drag: pan · click a thread: expand · double-click: source'),
        this.status,
        this.selection,
      ),
      this.chart.element,
    );
  }

  saveState(): TimelineState {
    return { expanded: this.expanded ? [...this.expanded] : null, maxPauseMs: this.maxPauseMs };
  }

  restoreState(s: TimelineState): void {
    this.expanded = s.expanded ? new Set(s.expanded) : null;
    this.maxPauseMs = s.maxPauseMs ?? DEFAULT_PAUSE;
    this.pauseSelect.value = String(this.maxPauseMs);
  }

  refresh(): void {
    const p = this.app.profile;
    const f = this.app.filter;
    const stats = p.threadsByWork(f);
    const lanes: Lane[] = stats.map((s, i) => {
      const open = this.expanded ? this.expanded.has(p.raw.threads[s.thread].tid) : i < DEFAULT_EXPANDED;
      return {
        thread: s.thread,
        samples: s.samples,
        main: s.thread === p.mainThread,
        activity: p.activity(f, s.thread),
        rows: open ? p.callSpans(f, s.thread, this.maxPauseMs) : null,
        expanded: open,
      };
    });
    this.lanes = lanes;
    const min = f.t0;
    const max = Math.min(f.t1, p.duration);
    const limits = `${min}:${max}`;
    this.chart.setLanes(lanes, stats.reduce((a, s) => a + s.samples, 0), min, max, limits === this.limits);
    this.limits = limits;
    this.onSearch(this.app.searchRegex());
  }

  onSearch(re: RegExp | null): void {
    this.chart.setSearch(re);
  }
}
