import type { FromWebview, RawProfile, ToWebview } from '../shared/protocol';
import type { AppApi, MenuItem, View } from './api';
import { Profile, type Filter, type Selection, type TreeNode } from './model';
import { setColumnStore } from './table';
import { Timeline } from './timeline';
import { el, esc, searchRegex } from './util';
import { CallerCalleeView } from './views/callerCallee';
import { CallTreeView } from './views/callTree';
import { FlameView } from './views/flameView';
import { FunctionsView, ModulesView, ThreadsView } from './views/lists';
import { SummaryView } from './views/summary';
import { TimelineView } from './views/timelineView';

declare function acquireVsCodeApi(): {
  postMessage(m: FromWebview): void;
  getState(): any;
  setState(s: any): void;
};
const host = acquireVsCodeApi();

/** What a re-analysis of the same process keeps: the filters and what each view shows. */
interface AppState {
  pid: number;
  range: [number, number] | null;
  /** Thread ids (not indexes) kept by the thread filter. */
  threads: number[] | null;
  search: string;
  views: Record<string, unknown>;
}

class App implements AppApi {
  readonly profile: Profile;
  readonly filter: Filter;
  private readonly selCache = new Map<boolean, Selection>();
  private search = '';
  private searchRe: RegExp | null = null;
  private readonly views: View[];
  private readonly dirty = new Set<View>();
  private active: View;
  private readonly tabs: HTMLElement;
  private readonly timeline: Timeline;
  private readonly searchBox: HTMLInputElement;
  private readonly threadBadge: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly showExternalBox: HTMLInputElement;
  private readonly toastEl: HTMLElement;
  private readonly callTree: CallTreeView;
  private readonly callerCallee: CallerCalleeView;
  private readonly flame: FlameView;
  private readonly functions: FunctionsView;
  readonly root: HTMLElement;
  /** Removes the window listeners when the report is rebuilt. */
  private readonly disposer = new AbortController();

  constructor(raw: RawProfile, externalNamespaces: string[], showExternalCode: boolean) {
    this.profile = new Profile(raw, externalNamespaces);
    const state = host.getState() ?? {};
    this.filter = { t0: 0, t1: Infinity, threads: null, hideExternal: !showExternalCode };
    setColumnStore({
      get: (id) => (host.getState() ?? {}).columns?.[id],
      set: (id, hidden) => {
        const s = host.getState() ?? {};
        host.setState({ ...s, columns: { ...(s.columns ?? {}), [id]: hidden } });
      },
    });

    this.callTree = new CallTreeView(this);
    this.callerCallee = new CallerCalleeView(this);
    this.flame = new FlameView(this);
    this.functions = new FunctionsView(this);
    this.views = [
      new SummaryView(this),
      this.callTree,
      this.callerCallee,
      this.functions,
      this.flame,
      new TimelineView(this, this.disposer.signal),
      new ModulesView(this),
      new ThreadsView(this),
    ];
    this.active = this.views.find((v) => v.id === state.tab) ?? this.views[0];

    // Toolbar ---------------------------------------------------------------
    const procSelect = el('select', { title: 'The trace is system-wide: pick the process to analyse' });
    for (const pr of raw.processes.slice(0, 60)) {
      const o = el('option', { value: String(pr.pid) }, `${pr.name} (${pr.pid}) · ${pr.samples.toLocaleString('en-US')} samples`);
      if (pr.pid === raw.process.pid) o.selected = true;
      procSelect.append(o);
    }
    procSelect.addEventListener('change', () => this.reanalyze({ pid: Number(procSelect.value) }));

    const ext = (this.showExternalBox = el('input', { type: 'checkbox' }));
    ext.checked = !this.filter.hideExternal;
    ext.addEventListener('change', () => {
      this.filter.hideExternal = !ext.checked;
      this.invalidate(false);
      host.postMessage({ type: 'setShowExternalCode', show: ext.checked });
    });

    this.threadBadge = el('span', { class: 'badge hidden' });
    this.threadBadge.addEventListener('click', () => this.setThreads(null));

    this.searchBox = el('input', { type: 'search', class: 'search', placeholder: 'Search' });
    this.searchBox.addEventListener('input', () => {
      this.search = this.searchBox.value;
      this.searchRe = searchRegex(this.search);
      this.active.onSearch?.(this.searchRe, false);
      for (const v of this.views) if (v !== this.active && v.onSearch) this.dirty.add(v);
    });
    this.searchBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.active.onSearch?.(this.searchRe, true);
      if (e.key === 'Escape') {
        this.searchBox.value = '';
        this.searchBox.dispatchEvent(new Event('input'));
      }
    });

    const symbols = el('button', { title: 'Re-run the analysis, downloading missing Windows PDBs from the Microsoft symbol server' }, 'Load Microsoft symbols');
    symbols.addEventListener('click', () => this.reanalyze({ msSymbols: true }));
    if (raw.msSymbols) symbols.classList.add('hidden');

    const toolbar = el(
      'div',
      { class: 'toolbar' },
      el('label', { class: 'field' }, 'Process ', procSelect),
      el('label', { class: 'check', title: 'Off: runs of Windows / symbol-less frames collapse into [External Code]' }, ext, 'Show external code'),
      this.threadBadge,
      el('span', { class: 'spacer' }),
      this.searchBox,
      symbols,
    );

    this.timeline = new Timeline(
      this.profile,
      (range) => {
        this.filter.t0 = range ? range[0] : 0;
        this.filter.t1 = range ? range[1] : Infinity;
        this.invalidate(false);
      },
      this.disposer.signal,
    );

    this.tabs = el('div', { class: 'tabs' });
    for (const v of this.views) {
      const t = el('button', { class: 'tab', 'data-view': v.id }, v.title);
      t.addEventListener('click', () => this.activate(v));
      this.tabs.append(t);
    }
    const content = el('div', { class: 'content' }, ...this.views.map((v) => v.element));
    this.menu = el('div', { class: 'menu hidden' });
    this.toastEl = el('div', { class: 'toast hidden' });
    this.root = el('div', { class: 'app' }, toolbar, this.timeline.element, this.tabs, content, this.menu, this.toastEl);
    const signal = this.disposer.signal;
    window.addEventListener(
      'mousedown',
      (e) => {
        if (!this.menu.contains(e.target as Node)) this.menu.classList.add('hidden');
      },
      { signal },
    );
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') this.menu.classList.add('hidden');
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
          e.preventDefault();
          this.searchBox.focus();
          this.searchBox.select();
        }
      },
      { signal },
    );
    window.addEventListener('blur', () => this.menu.classList.add('hidden'), { signal });
    for (const v of this.views) this.dirty.add(v);
  }

  start(): void {
    this.activate(this.active);
  }

  dispose(): void {
    this.disposer.abort();
  }

  captureState(): AppState {
    const views: Record<string, unknown> = {};
    for (const v of this.views) if (v.saveState) views[v.id] = v.saveState();
    const t1 = this.filter.t1;
    return {
      pid: this.profile.raw.process.pid,
      range: this.filter.t0 > 0 || t1 < Infinity ? [this.filter.t0, t1] : null,
      threads: this.filter.threads ? [...this.filter.threads].map((t) => this.profile.raw.threads[t].tid) : null,
      search: this.search,
      views,
    };
  }

  /** Before `start`: re-applies what a report of the same process showed. */
  restoreState(s: AppState): void {
    if (s.pid !== this.profile.raw.process.pid) return;
    for (const v of this.views) if (v.restoreState && s.views[v.id] !== undefined) v.restoreState(s.views[v.id]);
    if (s.range) {
      [this.filter.t0, this.filter.t1] = s.range;
      this.timeline.setRange(s.range);
    }
    if (s.threads) {
      const tids = new Set(s.threads);
      this.showThreads(new Set(this.profile.raw.threads.flatMap((t, i) => (tids.has(t.tid) ? [i] : []))));
    }
    if (s.search) {
      this.searchBox.value = this.search = s.search;
      this.searchRe = searchRegex(s.search);
    }
  }

  // AppApi --------------------------------------------------------------------

  selection(groupByThread = false): Selection {
    let s = this.selCache.get(groupByThread);
    if (!s) {
      s = this.profile.select(this.filter, groupByThread);
      this.selCache.set(groupByThread, s);
    }
    return s;
  }

  searchRegex(): RegExp | null {
    return this.searchRe;
  }

  openSource(func: number): void {
    const p = this.profile;
    if (p.isSynthetic(func)) return;
    const sel = this.selection();
    const loc = p.sourceOf(sel, func);
    if (!loc) {
      const m = p.raw.modules[p.funcModule[func]];
      this.toast(
        m && !m.symbols
          ? `No symbols for ${m.name}: source is unavailable.`
          : `No source line information for ${p.funcLabel(func)}.`,
      );
      return;
    }
    host.postMessage({
      type: 'openSource',
      file: p.raw.files[loc.file],
      line: loc.line,
      hits: p.lineHits(sel, loc.file),
      totalSamples: sel.total,
      sampleMs: p.sampleMs,
      label: `${p.raw.process.name} (${p.raw.process.pid})`,
    });
  }

  showCallerCallee(func: number): void {
    this.callerCallee.show(func);
    this.activate(this.callerCallee, false);
  }

  showInCallTree(func: number): void {
    this.callTree.showFunc(func);
    this.dirty.add(this.callTree);
    this.activate(this.callTree);
  }

  showInFlameGraph(func: number): void {
    this.flame.showFunc(func);
    this.dirty.add(this.flame);
    this.activate(this.flame);
  }

  setThreads(threads: Set<number> | null): void {
    this.showThreads(threads);
    this.invalidate(false);
  }

  private showThreads(threads: Set<number> | null): void {
    this.filter.threads = threads;
    this.timeline.setThreads(threads);
    if (threads) {
      this.threadBadge.textContent = `${threads.size} thread${threads.size === 1 ? '' : 's'} selected ✕`;
      this.threadBadge.title = 'Click to show all threads';
      this.threadBadge.classList.remove('hidden');
    } else {
      this.threadBadge.classList.add('hidden');
    }
  }

  showMenu(ev: MouseEvent, items: MenuItem[]): void {
    this.menu.innerHTML = '';
    for (const it of items) {
      const b = el('button', { class: 'menu-item' }, it.label);
      if (it.disabled) b.disabled = true;
      b.addEventListener('click', () => {
        this.menu.classList.add('hidden');
        it.action();
      });
      this.menu.append(b);
    }
    this.menu.classList.remove('hidden');
    const w = this.menu.offsetWidth;
    const h = this.menu.offsetHeight;
    this.menu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + 'px';
    this.menu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + 'px';
  }

  setTimeRange(range: [number, number] | null): void {
    this.timeline.setRange(range, true);
  }

  functionMenu(ev: MouseEvent, func: number, node?: TreeNode, extra: MenuItem[] = []): void {
    const p = this.profile;
    const real = !p.isSynthetic(func);
    const items: MenuItem[] = [
      ...extra,
      { label: 'View source', action: () => this.openSource(func), disabled: !real },
      { label: 'Show callers / callees', action: () => this.showCallerCallee(func), disabled: !real },
      { label: 'Show in call tree', action: () => this.showInCallTree(func) },
      { label: 'Show in flame graph', action: () => this.showInFlameGraph(func) },
      { label: 'Show in functions', action: () => this.showInFunctions(func), disabled: !real },
      { label: 'Copy function name', action: () => this.copy(p.fullName(func)) },
    ];
    const load = this.loadSymbolsItem(p.moduleOf(func));
    if (load) items.push(load);
    if (node) {
      items.push({
        label: 'Copy call stack',
        action: () => {
          const lines: string[] = [];
          for (let n: TreeNode | null = node; n && n.parent; n = n.parent) lines.push(p.fullName(n.func));
          this.copy(lines.join('\n'));
        },
      });
    }
    this.showMenu(ev, items);
  }

  copy(text: string): void {
    host.postMessage({ type: 'copy', text });
    this.toast('Copied');
  }

  reanalyze(opts: { pid?: number; msSymbols?: boolean }): void {
    showLoading(opts.msSymbols ? 'Downloading Microsoft symbols…' : 'Analysing…', true);
    host.postMessage({ type: 'reanalyze', ...opts });
  }

  loadSymbolsItem(module: number): MenuItem | null {
    const m = this.profile.raw.modules[module];
    if (!m || m.symbols || !m.path) return null;
    return {
      label: `Load symbols for ${m.name}`,
      action: () => {
        showLoading(`Loading symbols for ${m.name}…`, true);
        host.postMessage({ type: 'reanalyze', loadSymbols: m.path });
      },
    };
  }

  private toastTimer = 0;
  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('hidden'), 3500);
  }

  // Internals -----------------------------------------------------------------

  private showInFunctions(func: number): void {
    this.functions.showFunc(func);
    if (this.searchBox.value) {
      this.searchBox.value = '';
      this.searchBox.dispatchEvent(new Event('input'));
    }
    this.dirty.add(this.functions);
    this.activate(this.functions);
  }

  /** The setting changed (from this report, another one, or the settings editor). */
  setShowExternalCode(show: boolean): void {
    this.showExternalBox.checked = show;
    if (this.filter.hideExternal === !show) return;
    this.filter.hideExternal = !show;
    this.invalidate(false);
  }

  setExternalNamespaces(namespaces: string[]): void {
    this.profile.setExternalNamespaces(namespaces);
    this.invalidate(false);
  }

  private invalidate(keepSearch: boolean): void {
    this.selCache.clear();
    for (const v of this.views) this.dirty.add(v);
    this.refreshActive();
    void keepSearch;
  }

  private activate(v: View, refresh = true): void {
    this.active = v;
    for (const view of this.views) view.element.classList.toggle('hidden', view !== v);
    for (const t of Array.from(this.tabs.children) as HTMLElement[]) t.classList.toggle('active', t.dataset.view === v.id);
    this.searchBox.placeholder = v.searchHint ?? 'Search';
    this.searchBox.disabled = !v.onSearch;
    this.saveState();
    if (refresh) this.refreshActive();
    else this.dirty.delete(v);
  }

  private refreshActive(): void {
    const v = this.active;
    if (!this.dirty.has(v)) return;
    this.dirty.delete(v);
    const t = performance.now();
    v.refresh();
    const dt = performance.now() - t;
    if (dt > 500) console.log(`${v.id} refresh took ${dt.toFixed(0)} ms`);
  }

  private saveState(): void {
    host.setState({ ...(host.getState() ?? {}), tab: this.active.id });
  }
}

// Boot ------------------------------------------------------------------------

const appHost = document.getElementById('app')!;
let app: App | null = null;

function showLoading(text: string, overlay = false): void {
  let box = document.querySelector('.loading') as HTMLElement | null;
  if (!box) {
    box = el('div', { class: 'loading' + (overlay ? ' overlay' : '') }, el('div', { class: 'spinner' }), el('div', { id: 'progress' }));
    document.body.append(box);
  }
  box.querySelector('#progress')!.textContent = text;
}

function hideLoading(): void {
  document.querySelectorAll('.loading').forEach((e) => e.remove());
}

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'progress':
      showLoading(m.text, !!app);
      break;
    case 'error':
      hideLoading();
      if (app) {
        app.toast(m.text);
      } else {
        appHost.innerHTML = `<div class="error"><h2>Could not analyse this file</h2><pre>${esc(m.text)}</pre></div>`;
      }
      break;
    case 'profile': {
      const raw = JSON.parse(m.json) as RawProfile;
      hideLoading();
      // A re-analysis (symbols loaded, another process) rebuilds the report; the same process keeps its view.
      const previous = app?.captureState();
      app?.dispose();
      appHost.innerHTML = '';
      app = new App(raw, m.externalNamespaces, m.showExternalCode);
      if (previous) app.restoreState(previous);
      appHost.append(app.root);
      app.start();
      break;
    }
    case 'showExternalCode':
      app?.setShowExternalCode(m.show);
      break;
    case 'externalNamespaces':
      app?.setExternalNamespaces(m.namespaces);
      break;
  }
});

host.postMessage({ type: 'ready' });
