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

/**
 * Canvas flame graph of a call tree: click zooms into a frame, the frames above it stay as breadcrumbs. Ctrl+wheel
 * magnifies the zoomed frame around the cursor, dragging or Shift+wheel pans it.
 */
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
  /** The part of the zoomed frame shown, as fractions of its width. */
  private v0 = 0;
  private v1 = 1;
  private drag: { x: number; y: number; v0: number; top: number; moved: boolean } | null = null;
  /** The click that ends a drag does not zoom. */
  private dragged = false;
  /** A frame to put back at this offset from the top of the viewport on the next draw. */
  private anchor: { node: TreeNode; top: number } | null = null;
  /** The zoomed frame was picked by the user: keep it in view when the layout changes. */
  private reveal = false;
  /** zoom() ran since the last draw. */
  private zoomedNow = false;
  /** Canvas height and viewport size of the last draw, to tell a layout change from a repaint. */
  private laidOut = { height: 0, width: 0, view: 0 };
  inverted = false; // true = classic flame (root at the bottom)
  private frame = 0;

  constructor(
    private readonly profile: Profile,
    private readonly handlers: {
      onActivate: (node: TreeNode) => void;
      onContextMenu: (node: TreeNode, ev: MouseEvent) => void;
      onZoomChange: (focus: TreeNode | null) => void;
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
    // Pointer capture keeps the drag going when the pointer leaves the canvas.
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragged = false;
      if (e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, v0: this.v0, top: this.scroller.scrollTop, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => this.onDrag(e));
    const endDrag = () => {
      this.dragged = !!this.drag?.moved;
      this.drag = null;
      this.canvas.classList.remove('panning');
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('click', (e) => {
      if (this.dragged) {
        this.dragged = false;
        return;
      }
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
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  setTree(root: TreeNode): void {
    // Keep the zoom when the same path still exists in the new tree.
    const path: number[] = [];
    for (let n = this.focus; n && n.parent; n = n.parent) path.unshift(n.func);
    this.root = root;
    let f: TreeNode = root;
    let found = true;
    for (const func of path) {
      const c = f.children.find((x) => x.func === func);
      if (!c) {
        found = false;
        break;
      }
      f = c;
    }
    // The magnified part only means something in the same frame.
    if (!found) {
      this.v0 = 0;
      this.v1 = 1;
    }
    this.focus = f;
    this.notifyZoom();
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

  /** The part of the zoomed frame shown (Ctrl+wheel), as fractions of its width. */
  get window(): [number, number] {
    return [this.v0, this.v1];
  }

  get isZoomed(): boolean {
    return this.zoomed !== null || this.v0 > 0 || this.v1 < 1;
  }

  zoom(node: TreeNode | null): void {
    const prev = this.focus;
    this.focus = node ?? this.root;
    this.v0 = 0;
    this.v1 = 1;
    // The zoomed frame keeps its row, so hold it where it is on screen rather than scrolling; when zooming out, hold
    // the frame just left. A frame not on screen yet is scrolled into view by the next draw.
    const held = this.hits.find((h) => h.node === this.focus) ?? (node ? undefined : this.hits.find((h) => h.node === prev));
    this.anchor = held ? { node: held.node, top: held.y - this.scroller.scrollTop } : null;
    this.reveal = node !== null;
    this.zoomedNow = true;
    this.notifyZoom();
    this.schedule();
  }

  setWindow(a: number, b: number): void {
    // No closer than one sample across the whole width.
    const min = Math.min(1, 1 / Math.max(1, this.focus?.total ?? 1));
    const span = Math.min(1, Math.max(min, b - a));
    a = Math.max(0, Math.min(1 - span, a));
    this.v0 = a;
    this.v1 = a + span;
    this.notifyZoom();
    this.schedule();
  }

  private notifyZoom(): void {
    this.handlers.onZoomChange(this.zoomed);
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
    const scale = focus.total > 0 ? width / ((this.v1 - this.v0) * focus.total) : 0;
    const x0 = -this.v0 * focus.total * scale;
    // Only the frames in view count, so a magnified frame does not leave empty rows below.
    let maxDepth = 0;
    const walk: [TreeNode, number, number][] = [[focus, x0, 0]];
    while (walk.length) {
      const [n, x, d] = walk.pop()!;
      if (d > maxDepth) maxDepth = d;
      let cx = x;
      for (const c of n.children) {
        const cw = c.total * scale;
        if (cw >= 0.5 && cx + cw > 0 && cx < width) walk.push([c, cx, d + 1]);
        cx += cw;
      }
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

    const box = (n: TreeNode, left: number, right: number, row: number, matched: boolean, dim: boolean) => {
      // Clipped to the view, so a magnified frame keeps its label in sight.
      const x = Math.max(0, left);
      const w = Math.min(width, right) - x;
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
      box(n, x, x + w, row, matched, false);
      let cx = x;
      for (const ch of n.children) {
        const cw = ch.total * scale;
        if (cw >= 0.5 && cx + cw > 0 && cx < width) draw(ch, cx, row + 1, matched);
        cx += cw;
      }
    };
    draw(focus, x0, base, false);
    this.placeScroll(height, width);
  }

  /** Scrolls only as needed: to hold the anchored frame in place, and to keep the zoomed frame in view after a resize. */
  private placeScroll(height: number, width: number): void {
    const s = this.scroller;
    const view = s.clientHeight;
    const last = this.laidOut;
    const relaid = height !== last.height || width !== last.width || view !== last.view;
    // A classic flame grows from the bottom: when the canvas height changes, keep the distance to the bottom.
    if (this.inverted && last.height && height !== last.height) s.scrollTop += height - last.height;
    this.laidOut = { height, width, view };
    const anchor = this.anchor;
    this.anchor = null;
    const zoomed = this.zoomedNow;
    this.zoomedNow = false;
    if (anchor) {
      const h = this.hits.find((x) => x.node === anchor.node);
      if (h) s.scrollTop = h.y - anchor.top;
    } else if (!relaid && !zoomed) {
      return;
    }
    if (!this.reveal || !this.zoomed) return;
    const h = this.hits.find((x) => x.node === this.focus);
    if (!h) return;
    if (h.y < s.scrollTop) s.scrollTop = h.y;
    else if (h.y + ROW > s.scrollTop + view) s.scrollTop = h.y + ROW - view;
  }

  private onWheel(e: WheelEvent): void {
    const span = this.v1 - this.v0;
    const perPx = span / Math.max(1, this.scroller.clientWidth);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const at = this.v0 + e.offsetX * perPx;
      const f = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.002)));
      this.setWindow(at - (at - this.v0) * f, at + (this.v1 - at) * f);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * perPx;
      this.setWindow(this.v0 + dx, this.v1 + dx);
    } else {
      return; // A plain wheel scrolls the rows.
    }
    this.hover = null;
    this.tooltip.classList.add('hidden');
  }

  private onDrag(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) <= 3) return;
      d.moved = true;
      this.canvas.classList.add('panning');
      this.hover = null;
      this.tooltip.classList.add('hidden');
      this.schedule();
    }
    const span = this.v1 - this.v0;
    const perPx = span / Math.max(1, this.scroller.clientWidth);
    this.setWindow(d.v0 - dx * perPx, d.v0 - dx * perPx + span);
    this.scroller.scrollTop = d.top - dy;
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
    if (this.drag?.moved) return;
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
      `</table><div class="tt-hint">click: zoom · ctrl+wheel: magnify · drag: pan · double-click: source · right-click: more</div>`;
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
