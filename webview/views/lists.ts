import type { AppApi, View } from '../api';
import type { FuncStat, ModuleStat, ThreadStat } from '../model';
import { VirtualTable } from '../table';
import { barCell, el, esc, fmtMs, fmtPct, fmtTime } from '../util';
import { costColumns, nameColumn } from './columns';

/** Flat list of every sampled function with self / total time (VS "Functions"). */
export class FunctionsView implements View {
  readonly id = 'functions';
  readonly title = 'Functions';
  readonly searchHint = 'Filter functions';
  readonly element: HTMLElement;
  private readonly table: VirtualTable<FuncStat>;
  private all: FuncStat[] = [];
  private base = 1;
  private readonly status: HTMLElement;
  private pendingFunc: number | null = null;

  constructor(private readonly app: AppApi) {
    this.table = new VirtualTable<FuncStat>([nameColumn<FuncStat>(app), ...costColumns<FuncStat>(app, () => this.base)], {
      id: 'functions',
      onActivate: (r) => app.openSource(r.func),
      onContextMenu: (r, ev) => app.functionMenu(ev, r.func),
    });
    this.table.setSort('self', true);
    this.status = el('span', { class: 'status' });
    this.element = el(
      'div',
      { class: 'view' },
      el('div', { class: 'view-toolbar' }, el('span', { class: 'hint' }, 'Double-click: source · right-click: callers/callees, flame graph…'), this.status),
      this.table.element,
    );
  }

  showFunc(func: number): void {
    this.pendingFunc = func;
  }

  refresh(): void {
    const sel = this.app.selection();
    this.base = sel.total;
    this.all = this.app.profile.functions(sel);
    this.apply();
    if (this.pendingFunc !== null) {
      const row = this.table.getRows().find((r) => r.func === this.pendingFunc);
      this.pendingFunc = null;
      if (row) this.table.select(row, true);
    }
  }

  onSearch(): void {
    this.apply();
  }

  private apply(): void {
    const re = this.app.searchRegex();
    const p = this.app.profile;
    const rows = re ? this.all.filter((r) => re.test(p.fullName(r.func))) : this.all.slice();
    this.table.setRows(rows);
    this.status.textContent = `${rows.length.toLocaleString('en-US')} functions`;
  }
}

/** Time per binary (VS "Modules"), with symbol status. */
export class ModulesView implements View {
  readonly id = 'modules';
  readonly title = 'Modules';
  readonly searchHint = 'Filter modules';
  readonly element: HTMLElement;
  private readonly table: VirtualTable<ModuleStat>;
  private all: ModuleStat[] = [];
  private base = 1;

  constructor(private readonly app: AppApi) {
    const p = app.profile;
    const ms = (n: number) => fmtMs(n * p.sampleMs);
    const pct = (n: number) => (100 * n) / Math.max(1, this.base);
    this.table = new VirtualTable<ModuleStat>(
      [
        {
          id: 'name',
          title: 'Module',
          width: 'minmax(200px, 1fr)',
          html: (r) => `<span title="${esc(p.raw.modules[r.module]?.path ?? '')}">${esc(p.moduleLabel(r.module))}</span>`,
          sort: (r) => p.moduleLabel(r.module).toLowerCase(),
          desc: false,
          fixed: true,
        },
        { id: 'total', title: 'Total CPU', width: '92px', align: 'right', html: (r) => ms(r.total), sort: (r) => r.total },
        {
          id: 'totalPct',
          title: 'Total %',
          width: '76px',
          align: 'right',
          html: (r) => barCell(pct(r.total), fmtPct(pct(r.total))),
          sort: (r) => r.total,
        },
        { id: 'self', title: 'Self CPU', width: '92px', align: 'right', html: (r) => ms(r.self), sort: (r) => r.self },
        {
          id: 'selfPct',
          title: 'Self %',
          width: '76px',
          align: 'right',
          html: (r) => barCell(pct(r.self), fmtPct(pct(r.self)), 'self'),
          sort: (r) => r.self,
        },
        { id: 'funcs', title: 'Functions', width: '80px', align: 'right', html: (r) => String(r.funcs), sort: (r) => r.funcs },
        {
          id: 'symbols',
          title: 'Symbols',
          width: '90px',
          html: (r) => {
            const m = p.raw.modules[r.module];
            if (!m) return '';
            if (m.local) return '<span class="ok" title="PDB next to the binary: your code">local</span>';
            if (m.symbols) return '<span class="ok">loaded</span>';
            // Local mode only searches next to the binary: right-click to search everywhere.
            return p.raw.localSymbols && !m.system
              ? '<span class="warn" title="Right-click > Load symbols">not loaded</span>'
              : '<span class="warn">not found</span>';
          },
          sort: (r) => {
            const m = p.raw.modules[r.module];
            return m ? (m.local ? 2 : 0) + (m.symbols ? 1 : 0) : -1;
          },
        },
        {
          id: 'path',
          title: 'Path',
          width: 'minmax(200px, 2fr)',
          html: (r) => `<span class="module">${esc(p.raw.modules[r.module]?.path ?? '')}</span>`,
          sort: (r) => p.raw.modules[r.module]?.path ?? '',
          desc: false,
        },
      ],
      {
        id: 'modules',
        onActivate: (r) => {
          app.copy(p.moduleLabel(r.module));
        },
        onContextMenu: (r, ev) => {
          const m = p.raw.modules[r.module];
          const items = [
            { label: 'Copy module name', action: () => app.copy(p.moduleLabel(r.module)) },
            { label: 'Copy path', action: () => app.copy(m?.path ?? ''), disabled: !m?.path },
          ];
          const load = app.loadSymbolsItem(r.module);
          app.showMenu(ev, load ? [load, ...items] : items);
        },
      },
    );
    this.table.setSort('self', true);
    this.element = el(
      'div',
      { class: 'view' },
      el('div', { class: 'view-toolbar' }, el('span', { class: 'hint' }, 'Self = samples whose leaf frame is in the module; Total = samples with the module anywhere on the stack.')),
      this.table.element,
    );
  }

  refresh(): void {
    const sel = this.app.selection();
    this.base = sel.total;
    this.all = this.app.profile.modules(sel);
    this.onSearch();
  }

  onSearch(): void {
    const re = this.app.searchRegex();
    const p = this.app.profile;
    this.table.setRows(re ? this.all.filter((r) => re.test(p.moduleLabel(r.module))) : this.all.slice());
  }
}

/** Threads with their CPU time; the checkboxes filter every other view. */
export class ThreadsView implements View {
  readonly id = 'threads';
  readonly title = 'Threads';
  readonly searchHint = 'Filter threads';
  readonly element: HTMLElement;
  private readonly table: VirtualTable<ThreadStat>;
  private all: ThreadStat[] = [];
  private base = 1;

  constructor(private readonly app: AppApi) {
    const p = app.profile;
    const ms = (n: number) => fmtMs(n * p.sampleMs);
    const pct = (n: number) => (100 * n) / Math.max(1, this.base);
    const checked = (r: ThreadStat) => !app.filter.threads || app.filter.threads.has(r.thread);
    this.table = new VirtualTable<ThreadStat>(
      [
        {
          id: 'check',
          title: '',
          width: '28px',
          html: (r) => `<input type="checkbox" class="thread-check" ${checked(r) ? 'checked' : ''}>`,
          fixed: true,
        },
        { id: 'tid', title: 'Thread ID', width: '80px', align: 'right', html: (r) => String(p.raw.threads[r.thread].tid), sort: (r) => p.raw.threads[r.thread].tid, desc: false },
        {
          id: 'name',
          title: 'Name / start function',
          width: 'minmax(260px, 1fr)',
          html: (r) => {
            const name = p.raw.threads[r.thread].name;
            const start = p.threadStarts[r.thread];
            return (name ? `<b>${esc(name)}</b> ` : '') + `<span class="fn">${esc(start)}</span>`;
          },
          sort: (r) => p.threadLabels[r.thread].toLowerCase(),
          desc: false,
        },
        { id: 'cpu', title: 'CPU', width: '92px', align: 'right', html: (r) => ms(r.samples), sort: (r) => r.samples },
        {
          id: 'pct',
          title: 'CPU %',
          tooltip: 'Share of the process CPU time',
          width: '76px',
          align: 'right',
          html: (r) => barCell(pct(r.samples), fmtPct(pct(r.samples))),
          sort: (r) => r.samples,
        },
        { id: 'first', title: 'First sample', width: '100px', align: 'right', html: (r) => fmtTime(r.first), sort: (r) => r.first, desc: false },
        { id: 'last', title: 'Last sample', width: '100px', align: 'right', html: (r) => fmtTime(r.last), sort: (r) => r.last },
      ],
      {
        id: 'threads',
        onActivate: (r) => app.setThreads(new Set([r.thread])),
        onContextMenu: (r, ev) =>
          app.showMenu(ev, [
            { label: 'Only this thread', action: () => app.setThreads(new Set([r.thread])) },
            {
              label: 'Exclude this thread',
              action: () => {
                const s = new Set(app.filter.threads ?? this.all.map((x) => x.thread));
                s.delete(r.thread);
                app.setThreads(s);
              },
            },
            { label: 'All threads', action: () => app.setThreads(null) },
          ]),
      },
    );
    this.table.setSort('cpu', true);
    this.table.element.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (!t.classList.contains('thread-check')) return;
      const row = this.table.getRows()[Number((t.closest('.vt-row') as HTMLElement).dataset.i)];
      const s = new Set(app.filter.threads ?? this.all.map((x) => x.thread));
      if (t.checked) s.add(row.thread);
      else s.delete(row.thread);
      app.setThreads(s.size === this.all.length ? null : s);
    });
    const all = el('button', {}, 'All threads');
    all.addEventListener('click', () => app.setThreads(null));
    const none = el('button', {}, 'None');
    none.addEventListener('click', () => app.setThreads(new Set()));
    const top = el('button', { title: 'Keep the threads that together use 90% of the CPU' }, 'Busiest threads');
    top.addEventListener('click', () => {
      const sorted = [...this.all].sort((a, b) => b.samples - a.samples);
      const s = new Set<number>();
      let acc = 0;
      for (const r of sorted) {
        if (acc >= 0.9 * this.base) break;
        s.add(r.thread);
        acc += r.samples;
      }
      app.setThreads(s);
    });
    this.element = el(
      'div',
      { class: 'view' },
      el('div', { class: 'view-toolbar' }, all, none, top, el('span', { class: 'hint' }, 'Tick threads to filter every view · double-click: only this thread')),
      this.table.element,
    );
  }

  refresh(): void {
    this.all = this.app.profile.threads(this.app.filter);
    this.base = this.all.reduce((a, r) => a + r.samples, 0);
    this.onSearch();
  }

  onSearch(): void {
    const re = this.app.searchRegex();
    const p = this.app.profile;
    this.table.setRows(re ? this.all.filter((r) => re.test(p.threadLabels[r.thread])) : this.all.slice());
  }
}
