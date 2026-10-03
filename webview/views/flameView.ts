import type { AppApi, View } from '../api';
import { FlameGraph } from '../flame';
import { followPath, nodePath, type PathStep, type TreeNode } from '../model';

interface FlameState {
  inverted: boolean;
  groupByThread: boolean;
  zoom: PathStep[];
}
import { el, fmtMs, fmtPct } from '../util';

export class FlameView implements View {
  readonly id = 'flame';
  readonly title = 'Flame Graph';
  readonly searchHint = 'Highlight functions';
  readonly element: HTMLElement;
  private readonly graph: FlameGraph;
  private readonly crumb: HTMLElement;
  private readonly status: HTMLElement;
  private groupByThread = false;
  private pendingFunc: number | null = null;
  private root: TreeNode | null = null;
  private pendingZoom: PathStep[] | null = null;
  private readonly setMode: (inverted: boolean) => void;
  private readonly groupBox: HTMLInputElement;

  constructor(private readonly app: AppApi) {
    this.crumb = el('span', { class: 'status' });
    this.status = el('span', { class: 'status' });
    this.graph = new FlameGraph(app.profile, {
      onActivate: (n) => app.openSource(n.func),
      onContextMenu: (n, ev) => app.functionMenu(ev, n.func, n),
      onFocusChange: (n) => {
        this.crumb.textContent = n ? `Zoomed: ${app.profile.funcLabel(n.func)}` : '';
        reset.disabled = !n;
      },
    });
    const reset = el('button', {}, 'Reset zoom');
    reset.disabled = true;
    reset.addEventListener('click', () => this.graph.zoom(null));

    const mode = el('div', { class: 'segmented' });
    const icicle = el('button', { class: 'active', title: 'Root at the top (Visual Studio style)' }, 'Icicle');
    const flame = el('button', { title: 'Root at the bottom (classic flame graph)' }, 'Flame');
    mode.append(icicle, flame);
    const setMode = (this.setMode = (inv: boolean) => {
      this.graph.inverted = inv;
      icicle.classList.toggle('active', !inv);
      flame.classList.toggle('active', inv);
      this.graph.schedule();
    });
    icicle.addEventListener('click', () => setMode(false));
    flame.addEventListener('click', () => setMode(true));

    const group = (this.groupBox = el('input', { type: 'checkbox' }));
    group.addEventListener('change', () => {
      this.groupByThread = group.checked;
      this.refresh();
    });
    this.element = el(
      'div',
      { class: 'view' },
      el('div', { class: 'view-toolbar' }, mode, el('label', { class: 'check' }, group, 'Group by thread'), reset, this.crumb, this.status),
      this.graph.element,
    );
  }

  saveState(): FlameState {
    const z = this.graph.zoomed;
    return { inverted: this.graph.inverted, groupByThread: this.groupByThread, zoom: z ? nodePath(this.app.profile, z) : [] };
  }

  restoreState(s: FlameState): void {
    this.setMode(s.inverted);
    this.groupByThread = this.groupBox.checked = s.groupByThread;
    this.pendingZoom = s.zoom.length ? s.zoom : null;
  }

  showFunc(func: number): void {
    this.pendingFunc = func;
  }

  refresh(): void {
    const sel = this.app.selection(this.groupByThread);
    this.root = this.app.profile.topDown(sel, this.app.filter.hideExternal);
    this.graph.setTree(this.root);
    if (this.pendingZoom) {
      const n = followPath(this.app.profile, this.root, this.pendingZoom).node;
      this.pendingZoom = null;
      if (n !== this.root) this.graph.zoom(n);
    } else if (this.pendingFunc !== null) {
      if (!this.graph.zoomToFunc(this.pendingFunc)) this.app.toast('Function not in the flame graph (external code hidden?)');
      this.pendingFunc = null;
    }
    this.onSearch(this.app.searchRegex());
  }

  onSearch(re: RegExp | null): void {
    const matched = this.graph.setSearch(re);
    const total = this.root?.total ?? 0;
    this.status.textContent = re ? `matched ${fmtMs(matched * this.app.profile.sampleMs)} (${fmtPct((100 * matched) / Math.max(1, total))})` : '';
  }
}
