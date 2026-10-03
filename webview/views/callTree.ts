import type { AppApi, View } from '../api';
import { followPath, markHotPath, nodePath, TreeNode, type PathStep } from '../model';

interface CallTreeState {
  inverted: boolean;
  groupByThread: boolean;
  expanded: PathStep[][];
  selected: PathStep[] | null;
}
import { VirtualTable, type Column } from '../table';
import { el } from '../util';
import { costColumns, nameHtml } from './columns';

/** Top-down call tree (VS "Call Tree"), or bottom-up when inverted. */
export class CallTreeView implements View {
  readonly id = 'calltree';
  readonly title = 'Call Tree';
  readonly searchHint = 'Find function (Enter: next match)';
  readonly element: HTMLElement;
  private readonly table: VirtualTable<TreeNode>;
  private root: TreeNode | null = null;
  private inverted = false;
  private groupByThread = false;
  private sort: { col: Column<TreeNode>; desc: boolean } | null = null;
  private matches: TreeNode[] = [];
  private matchIndex = -1;
  private readonly status: HTMLElement;
  private pendingFunc: number | null = null;
  private pendingState: CallTreeState | null = null;
  private readonly setMode: (inverted: boolean) => void;
  private readonly groupBox: HTMLInputElement;

  constructor(private readonly app: AppApi) {
    const name: Column<TreeNode> = {
      id: 'name',
      title: 'Function Name',
      width: 'minmax(320px, 1fr)',
      html: (n) => {
        const pad = (n.depth - 1) * 14;
        const twisty = n.children.length ? `<span class="twisty ${n.expanded ? 'open' : ''}"></span>` : '<span class="twisty none"></span>';
        const hot = n.hot ? '<span class="hot" title="Hot path">🔥</span>' : '';
        return `<span class="indent" style="width:${pad}px"></span>${twisty}${hot}${nameHtml(app, n.func)}`;
      },
      sort: (n) => app.profile.funcLabel(n.func).toLowerCase(),
      desc: false,
      fixed: true,
    };
    this.table = new VirtualTable<TreeNode>([name, ...costColumns<TreeNode>(app, () => this.root?.total ?? 1)], {
      id: 'calltree',
      onToggle: (n, expand) => {
        n.expanded = expand ?? !n.expanded;
        this.reflatten();
      },
      isExpandable: (n) => n.children.length > 0,
      isExpanded: (n) => n.expanded,
      parentOf: (n) => (n.parent && n.parent !== this.root ? n.parent : null),
      onActivate: (n) => {
        if (app.profile.isSynthetic(n.func)) {
          n.expanded = !n.expanded;
          this.reflatten();
        } else {
          app.openSource(n.func);
        }
      },
      onContextMenu: (n, ev) => app.functionMenu(ev, n.func, n),
      onSort: (col, desc) => {
        this.sort = { col, desc };
        if (this.root) this.sortTree(this.root);
        this.reflatten();
      },
      rowClass: (n) => (n.hot ? 'hot-row' : ''),
    });
    this.table.setSort('total', true);

    const mode = el('div', { class: 'segmented' });
    const topDown = el('button', { class: 'active', title: 'Callers above callees (VS Call Tree)' }, 'Top-down');
    const bottomUp = el('button', { title: 'Where time is spent, then who called it' }, 'Bottom-up');
    mode.append(topDown, bottomUp);
    this.setMode = (inv: boolean) => {
      this.inverted = inv;
      topDown.classList.toggle('active', !inv);
      bottomUp.classList.toggle('active', inv);
    };
    topDown.addEventListener('click', () => {
      this.setMode(false);
      this.refresh();
    });
    bottomUp.addEventListener('click', () => {
      this.setMode(true);
      this.refresh();
    });

    const group = (this.groupBox = el('input', { type: 'checkbox', id: 'ct-group' }));
    group.addEventListener('change', () => {
      this.groupByThread = group.checked;
      this.refresh();
    });
    const hot = el('button', { title: 'Expand the path that carries most of the time' }, '🔥 Expand hot path');
    hot.addEventListener('click', () => this.expandHotPath());
    const collapse = el('button', {}, 'Collapse all');
    collapse.addEventListener('click', () => {
      if (!this.root) return;
      this.forEach(this.root, (n) => (n.expanded = false));
      this.root.expanded = true;
      this.reflatten();
    });
    this.status = el('span', { class: 'status' });
    const bar = el(
      'div',
      { class: 'view-toolbar' },
      mode,
      el('label', { class: 'check' }, group, 'Group by thread'),
      hot,
      collapse,
      this.status,
    );
    this.element = el('div', { class: 'view' }, bar, this.table.element);
  }

  refresh(): void {
    const sel = this.app.selection(this.groupByThread);
    const p = this.app.profile;
    this.root = this.inverted ? p.bottomUp(sel, this.app.filter.hideExternal) : p.topDown(sel, this.app.filter.hideExternal);
    if (this.sort && this.sort.col.id !== 'total') this.sortTree(this.root);
    this.root.expanded = true;
    if (!this.inverted) markHotPath(this.root);
    else if (this.root.children[0]) this.root.children[0].expanded = false;
    this.matches = [];
    this.matchIndex = -1;
    this.reflatten(false);
    const hotLeaf = this.lastHot();
    if (this.pendingState) {
      this.applyState(this.pendingState);
      this.pendingState = null;
    } else if (this.pendingFunc !== null) {
      const f = this.pendingFunc;
      this.pendingFunc = null;
      this.revealFunc(f);
    } else if (hotLeaf) {
      this.table.select(hotLeaf, true);
    }
    this.updateStatus();
  }

  saveState(): CallTreeState {
    const expanded: PathStep[][] = [];
    const p = this.app.profile;
    if (this.root) {
      // Only the expanded nodes are visited: collapsed subtrees keep nothing to restore.
      const stack = [...this.root.children];
      while (stack.length) {
        const n = stack.pop()!;
        if (!n.expanded) continue;
        expanded.push(nodePath(p, n));
        stack.push(...n.children);
      }
    }
    const sel = this.table.selection;
    return { inverted: this.inverted, groupByThread: this.groupByThread, expanded, selected: sel ? nodePath(p, sel) : null };
  }

  restoreState(s: CallTreeState): void {
    this.setMode(s.inverted);
    this.groupByThread = this.groupBox.checked = s.groupByThread;
    this.pendingState = s;
  }

  /** Expands what was expanded before the rebuild; paths through frames that changed stop where they diverge. */
  private applyState(s: CallTreeState): void {
    if (!this.root) return;
    const p = this.app.profile;
    this.forEach(this.root, (n) => (n.expanded = false));
    this.root.expanded = true;
    for (const path of s.expanded) {
      // Only a node reached by the whole path was expanded (its ancestors have their own paths); frames without
      // symbols may have become chains of named frames, which are expanded on the way.
      const { node, matched } = followPath(p, this.root, path);
      if (matched === path.length) for (let a: TreeNode | null = node; a; a = a.parent) a.expanded = true;
    }
    this.reflatten(false);
    const sel = s.selected && followPath(p, this.root, s.selected).node;
    if (sel && sel !== this.root) this.revealNode(sel);
  }

  /** Called before the view is shown: select the heaviest node of a function. */
  showFunc(func: number): void {
    this.pendingFunc = func;
  }

  private revealFunc(func: number): void {
    if (!this.root) return;
    let best: TreeNode | null = null;
    this.forEach(this.root, (n) => {
      if (n.func === func && (!best || n.total > best.total)) best = n;
    });
    if (best) this.revealNode(best);
  }

  onSearch(re: RegExp | null, next: boolean): void {
    if (!this.root) return;
    if (!next || !this.matches.length) {
      this.matches = [];
      this.matchIndex = -1;
      if (re) {
        const p = this.app.profile;
        // Pre-order, children by weight: the first match is the heaviest path's.
        const stack = [this.root];
        while (stack.length) {
          const n = stack.pop()!;
          if (n !== this.root && re.test(p.fullName(n.func))) this.matches.push(n);
          for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
        }
      }
    }
    if (this.matches.length) {
      this.matchIndex = (this.matchIndex + 1) % this.matches.length;
      this.revealNode(this.matches[this.matchIndex]);
    } else {
      this.table.setRows(this.table.getRows()); // re-render highlights
    }
    this.updateStatus();
  }

  private updateStatus(): void {
    const re = this.app.searchRegex();
    if (re) {
      this.status.textContent = this.matches.length
        ? `match ${this.matchIndex + 1} of ${this.matches.length}`
        : 'no match';
    } else {
      this.status.textContent = this.inverted ? 'Roots are the functions where samples landed; expand to see callers.' : '';
    }
  }

  private revealNode(n: TreeNode): void {
    for (let a = n.parent; a; a = a.parent) a.expanded = true;
    this.reflatten();
    this.table.select(n, true);
  }

  private lastHot(): TreeNode | null {
    if (!this.root) return null;
    let n = this.root;
    let last: TreeNode | null = null;
    for (;;) {
      const c = n.children.find((x) => x.hot);
      if (!c) break;
      last = c;
      n = c;
    }
    return last;
  }

  private expandHotPath(): void {
    if (!this.root) return;
    const sel = this.table.selection;
    const start = sel ?? this.root;
    // From the selection (or the root), follow the heaviest child.
    let n = start;
    n.expanded = true;
    const floor = (this.root.total || 1) * 0.01;
    while (n.children.length) {
      const c = n.children.reduce((a, b) => (b.total > a.total ? b : a));
      if (c.total < floor || c.total < n.total * 0.3) break;
      c.hot = true;
      n.expanded = true;
      n = c;
    }
    this.reflatten();
    this.table.select(n, true);
  }

  private sortTree(root: TreeNode): void {
    if (!this.sort) return;
    const key = this.sort.col.sort!;
    const dir = this.sort.desc ? -1 : 1;
    const cmp = (a: TreeNode, b: TreeNode) => {
      const ka = key(a);
      const kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir;
    };
    this.forEach(root, (n) => n.children.sort(cmp));
  }

  private forEach(root: TreeNode, fn: (n: TreeNode) => void): void {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      fn(n);
      for (const c of n.children) stack.push(c);
    }
  }

  private reflatten(keepScroll = true): void {
    const rows: TreeNode[] = [];
    if (this.root) {
      const stack: TreeNode[] = [...this.root.children].reverse();
      while (stack.length) {
        const n = stack.pop()!;
        rows.push(n);
        if (n.expanded) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
      }
    }
    this.table.setRows(rows, keepScroll);
  }
}
