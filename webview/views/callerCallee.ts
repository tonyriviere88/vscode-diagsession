import type { AppApi, View } from '../api';
import type { FuncStat } from '../model';
import { VirtualTable, type Column } from '../table';
import { el, esc } from '../util';
import { costColumns, nameColumn } from './columns';

/** Butterfly view of one function: who calls it, and what it calls (VS "Caller/Callee"). */
export class CallerCalleeView implements View {
  readonly id = 'callercallee';
  readonly title = 'Caller/Callee';
  readonly searchHint = 'Find function, Enter to show it';
  readonly element: HTMLElement;
  private func: number | null = null;
  private pendingFunc: string | null = null;
  private base = 1;
  private readonly callers: VirtualTable<FuncStat>;
  private readonly current: VirtualTable<FuncStat>;
  private readonly callees: VirtualTable<FuncStat>;
  private readonly header: HTMLElement;
  private readonly history: number[] = [];
  private readonly back: HTMLButtonElement;

  constructor(private readonly app: AppApi) {
    const base = nameColumn<FuncStat>(app);
    // Callers and callees get a navigate icon: double-click stays "go to source", as everywhere else.
    const navName: Column<FuncStat> = {
      ...base,
      html: (r, i) =>
        (app.profile.isSynthetic(r.func)
          ? '<span class="nav none"></span>'
          : '<span class="nav" title="Make this the current function">⇄</span>') + base.html(r, i),
    };
    const cols = (name: Column<FuncStat>) => [name, ...costColumns<FuncStat>(app, () => this.base)];
    const opts = {
      id: 'callercallee',
      onActivate: (r: FuncStat) => app.openSource(r.func),
      onContextMenu: (r: FuncStat, ev: MouseEvent) => app.functionMenu(ev, r.func),
      onClick: (r: FuncStat, target: HTMLElement) => {
        if (!target.classList.contains('nav') || app.profile.isSynthetic(r.func)) return false;
        this.show(r.func);
        return true;
      },
    };
    this.callers = new VirtualTable<FuncStat>(cols(navName), opts);
    this.current = new VirtualTable<FuncStat>(cols(base), opts);
    this.callees = new VirtualTable<FuncStat>(cols(navName), opts);
    this.callers.setSort('total', true);
    this.callees.setSort('total', true);

    this.back = el('button', { title: 'Previous function' }, '← Back');
    this.back.disabled = true;
    this.back.addEventListener('click', () => {
      this.history.pop();
      const prev = this.history.pop();
      if (prev !== undefined) this.show(prev);
    });
    this.header = el('span', { class: 'status' });
    const section = (title: string, hint: string, t: VirtualTable<FuncStat>, cls: string) =>
      el('div', { class: 'cc-section ' + cls }, el('div', { class: 'cc-title' }, title, el('span', { class: 'hint' }, hint)), t.element);
    this.element = el(
      'div',
      { class: 'view cc' },
      el('div', { class: 'view-toolbar' }, this.back, this.header),
      section('Calling functions', '⇄ to navigate · double-click for source', this.callers, 'cc-callers'),
      section('Current function', 'double-click for source', this.current, 'cc-current'),
      section('Called functions', '⇄ to navigate · double-click for source', this.callees, 'cc-callees'),
    );
  }

  show(func: number): void {
    if (this.history[this.history.length - 1] !== func) this.history.push(func);
    this.func = func;
    this.back.disabled = this.history.length < 2;
    this.refresh();
  }

  refresh(): void {
    const p = this.app.profile;
    const sel = this.app.selection();
    this.base = sel.total;
    if (this.pendingFunc !== null) {
      const f = p.funcNamed(this.pendingFunc);
      this.pendingFunc = null;
      if (f >= 0) {
        this.func = f;
        this.history.push(f);
      }
    }
    if (this.func === null) {
      // Default to the function with the most self time, as a starting point.
      const top = p.functions(sel).filter((f) => !p.isSynthetic(f.func)).sort((a, b) => b.self - a.self)[0];
      if (!top) return;
      this.func = top.func;
      this.history.push(top.func);
    }
    const cc = p.callerCallee(sel, this.func);
    this.header.innerHTML = `Function: <b>${esc(p.fullName(this.func))}</b>`;
    this.callers.setRows(cc.callers, false);
    this.current.setRows([{ func: cc.func, self: cc.self, total: cc.total }], false);
    this.callees.setRows(cc.callees, false);
  }

  saveState(): { func: string | null } {
    return { func: this.func === null ? null : this.app.profile.fullName(this.func) };
  }

  restoreState(s: { func: string | null }): void {
    this.pendingFunc = s.func;
  }

  onSearch(re: RegExp | null, next: boolean): void {
    if (!re || !next) return;
    const p = this.app.profile;
    const hit = p
      .functions(this.app.selection())
      .filter((f) => re.test(p.fullName(f.func)))
      .sort((a, b) => b.total - a.total)[0];
    if (hit) this.show(hit.func);
    else this.app.toast('No sampled function matches');
  }
}
