import type { Profile, TreeNode } from './model';
import { el, esc, fmtMs, fmtPct, hashString } from './util';

interface Hit {
  x: number;
  y: number;
  w: number;
  node: TreeNode;
}

const ROW = 18;

/** Fill and text colour of a frame: own code warm, external cool; while searching, only the matches stand out. */
export function frameColors(p: Profile, func: number, searching: boolean, matched: boolean): [string, string] {
  if (searching) {
    if (matched) return ['hsl(42, 85%, 36%)', '#fff8e0'];
    return ['#3a3d41', '#b8bcc2'];
  }
  if (p.isSynthetic(func)) return ['#44484e', '#e6e6e6'];
  const mod = p.moduleName(func);
  const ext = p.isExternal(func);
  const hue = (hashString(mod) % 50) + (ext ? 190 : 0); // own code warm (0-50), external cool
  const light = 30 + (hashString(p.funcLabel(func)) % 9);
  const sat = ext ? 28 : 62;
  return [`hsl(${hue}, ${sat}%, ${light}%)`, '#f2f2f2'];
}

/** Canvas flame graph of a call tree: click zooms into a frame, the frames above it stay as breadcrumbs. */
export class FlameGraph {
  readonly element: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly tooltip: HTMLElement;
  private root: TreeNode | null = null;
  private focus: TreeNode | null = null;
  private hits: Hit[] = [];
  private hover: TreeNode | null = null;
  private search: RegExp | null = null;
  private matchTotal = 0;
  inverted = false; // true = classic flame (root at the bottom)
  private frame = 0;

  constructor(
    private readonly profile: Profile,
    private readonly handlers: {
      onActivate: (node: TreeNode) => void;
      onContextMenu: (node: TreeNode, ev: MouseEvent) => void;
      onFocusChange: (node: TreeNode | null) => void;
    },
  ) {
    this.canvas = el('canvas', { class: 'flame-canvas' });
    this.scroller = el('div', { class: 'flame-scroller' }, this.canvas);
    this.tooltip = el('div', { class: 'tooltip hidden' });
    this.element = el('div', { class: 'flame' }, this.scroller, this.tooltip);
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.tooltip.classList.add('hidden');
      this.schedule();
    });
    this.canvas.addEventListener('click', (e) => {
      const h = this.hitAt(e);
      if (h) this.zoom(h.node);
    });
    this.canvas.addEventListener('dblclick', (e) => {
      const h = this.hitAt(e);
      if (h) this.handlers.onActivate(h.node);
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      const h = this.hitAt(e);
      if (!h) return;
      e.preventDefault();
      this.handlers.onContextMenu(h.node, e);
    });
  }

  setTree(root: TreeNode): void {
    // Keep the zoom when the same path still exists in the new tree.
    const path: number[] = [];
    for (let n = this.focus; n && n.parent; n = n.parent) path.unshift(n.func);
    this.root = root;
    let f: TreeNode = root;
    for (const func of path) {
      const c = f.children.find((x) => x.func === func);
      if (!c) break;
      f = c;
    }
    this.focus = f;
    this.handlers.onFocusChange(f === root ? null : f);
    this.schedule();
  }

  setSearch(re: RegExp | null): number {
    this.search = re;
    this.matchTotal = 0;
    if (re && this.root) {
      // Samples under a matching frame, counted once (do not descend below a match).
      const stack = [this.root];
      while (stack.length) {
        const n = stack.pop()!;
        if (n !== this.root && re.test(this.profile.fullName(n.func))) {
          this.matchTotal += n.total;
          continue;
        }
        for (const c of n.children) stack.push(c);
      }
    }
    this.schedule();
    return this.matchTotal;
  }

  /** The zoomed node, or null at the root. */
  get zoomed(): TreeNode | null {
    return this.focus === this.root ? null : this.focus;
  }

  zoom(node: TreeNode | null): void {
    this.focus = node ?? this.root;
    this.handlers.onFocusChange(this.focus === this.root ? null : this.focus);
    this.scroller.scrollTop = this.inverted ? this.scroller.scrollHeight : 0;
    this.schedule();
  }

  zoomToFunc(func: number): boolean {
    if (!this.root) return false;
    // The heaviest node of this function.
    let best: TreeNode | null = null;
    const stack = [this.root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.func === func && (!best || n.total > best.total)) best = n;
      for (const c of n.children) stack.push(c);
    }
    if (best) this.zoom(best);
    return best !== null;
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private color(node: TreeNode, matched: boolean): [string, string] {
    return frameColors(this.profile, node.func, !!this.search, matched);
  }

  private draw(): void {
    const root = this.root;
    const focus = this.focus;
    if (!root || !focus) return;
    const width = this.scroller.clientWidth;
    if (width === 0) return;

    // Ancestors of the focus, then the focus subtree down to frames of at least half a pixel.
    const ancestors: TreeNode[] = [];
    for (let n = focus.parent; n; n = n.parent) ancestors.unshift(n);
    const scale = focus.total > 0 ? width / focus.total : 0;
    let maxDepth = 0;
    const walk: [TreeNode, number][] = [[focus, 0]];
    while (walk.length) {
      const [n, d] = walk.pop()!;
      if (d > maxDepth) maxDepth = d;
      for (const c of n.children) if (c.total * scale >= 0.5) walk.push([c, d + 1]);
    }
    const rows = ancestors.length + maxDepth + 1;
    const height = Math.max(this.scroller.clientHeight, rows * ROW + 4);
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    c.style.width = width + 'px';
    c.style.height = height + 'px';
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const css = getComputedStyle(document.body);
    ctx.font = `12px ${css.getPropertyValue('--vscode-font-family') || 'sans-serif'}`;
    ctx.textBaseline = 'middle';
    const charW = ctx.measureText('abcdefghijklmnopqrstuvwxyz').width / 26;
    const hoverBorder = css.getPropertyValue('--vscode-focusBorder') || '#007fd4';

    this.hits = [];
    const yOf = (row: number) => (this.inverted ? height - (row + 1) * ROW : row * ROW);
    const re = this.search;

    const box = (n: TreeNode, x: number, w: number, row: number, matched: boolean, dim: boolean) => {
      const y = yOf(row);
      const [fill, text] = this.color(n, matched);
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, Math.max(0.5, w - 1), ROW - 1);
      if (dim) {
        // Breadcrumb rows above the zoomed frame: dashed outline, readable text, no transparency.
        ctx.strokeStyle = text;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(x + 0.5, y + 0.5, w - 2, ROW - 2);
        ctx.setLineDash([]);
      }
      if (n === this.hover) {
        ctx.strokeStyle = hoverBorder;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 3, ROW - 3);
        ctx.lineWidth = 1;
      }
      if (w > 28) {
        const label = this.profile.funcLabel(n.func);
        const max = Math.floor((w - 8) / charW);
        const t = label.length > max ? label.slice(0, Math.max(0, max - 1)) + '…' : label;
        ctx.fillStyle = text;
        ctx.fillText(t, x + 4, y + ROW / 2);
      }
      this.hits.push({ x, y, w, node: n });
    };

    ancestors.forEach((a, i) => box(a, 0, width, i, !!re && re.test(this.profile.fullName(a.func)), true));

    const base = ancestors.length;
    const draw = (n: TreeNode, x: number, row: number, underMatch: boolean) => {
      const w = n.total * scale;
      const matched = underMatch || (!!re && n !== root && re.test(this.profile.fullName(n.func)));
      box(n, x, w, row, matched, false);
      let cx = x;
      for (const ch of n.children) {
        const cw = ch.total * scale;
        if (cw >= 0.5) draw(ch, cx, row + 1, matched);
        cx += cw;
      }
    };
    draw(focus, 0, base, false);
  }

  private hitAt(e: MouseEvent): Hit | undefined {
    const x = e.offsetX;
    const y = e.offsetY;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + ROW) return h;
    }
    return undefined;
  }

  private onMove(e: MouseEvent): void {
    const h = this.hitAt(e);
    const node = h?.node ?? null;
    if (node !== this.hover) {
      this.hover = node;
      this.schedule();
    }
    if (!node || !this.root) {
      this.tooltip.classList.add('hidden');
      return;
    }
    const p = this.profile;
    const all = this.root.total || 1;
    const ms = (n: number) => fmtMs(n * p.sampleMs);
    const mod = p.moduleName(node.func);
    this.tooltip.innerHTML =
      `<div class="tt-name">${esc(p.funcLabel(node.func))}</div>` +
      (mod ? `<div class="tt-mod">${esc(mod)}</div>` : '') +
      `<table><tr><td>Total</td><td>${ms(node.total)}</td><td>${fmtPct((100 * node.total) / all)}</td></tr>` +
      `<tr><td>Self</td><td>${ms(node.self)}</td><td>${fmtPct((100 * node.self) / all)}</td></tr>` +
      (this.search ? `<tr><td>Matches</td><td>${ms(this.matchTotal)}</td><td>${fmtPct((100 * this.matchTotal) / all)}</td></tr>` : '') +
      `</table><div class="tt-hint">click: zoom · double-click: source · right-click: more</div>`;
    this.tooltip.classList.remove('hidden');
    const rect = this.element.getBoundingClientRect();
    const tw = this.tooltip.offsetWidth;
    const th = this.tooltip.offsetHeight;
    let left = e.clientX - rect.left + 14;
    let top = e.clientY - rect.top + 14;
    if (left + tw > rect.width) left = Math.max(0, e.clientX - rect.left - tw - 10);
    if (top + th > rect.height) top = Math.max(0, e.clientY - rect.top - th - 10);
    this.tooltip.style.left = left + 'px';
    this.tooltip.style.top = top + 'px';
  }
}
