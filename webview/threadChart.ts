import { frameColors } from './flame';
import type { Activity, CallSpans, Profile } from './model';
import { el, esc, fmtMs, fmtPct, fmtTime } from './util';

/** One thread of the chart; `rows` is built when the lane is first expanded. */
export interface Lane {
  thread: number;
  samples: number;
  main: boolean;
  activity: Activity;
  rows: CallSpans[] | null;
  expanded: boolean;
}

/** A span of the chart: `lane.rows[depth]`, entry `index`. */
export interface SpanRef {
  lane: Lane;
  depth: number;
  index: number;
}

interface Hit {
  lane: Lane;
  header: boolean;
  span: SpanRef | null;
}

const RULER = 20;
const HEADER = 22;
const ROW = 16;
const LANE_PAD = 4;

/** First index whose value is greater than `v`, in an ascending array. */
function upperBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A round tick interval near `ms`: 1, 2 or 5 times a power of ten. */
function tickStep(ms: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(ms)));
  for (const m of [1, 2, 5]) if (ms <= m * p) return m * p;
  return 10 * p;
}

/**
 * Flame chart of the calls of each thread over time: one lane per thread, time across, stack depth down. Ctrl+wheel
 * zooms around the cursor, dragging pans, a click on a lane header expands or collapses its calls.
 */
export class ThreadChart {
  readonly element: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly spacer: HTMLElement;
  private readonly tooltip: HTMLElement;
  private lanes: Lane[] = [];
  private tops: number[] = [];
  private total = 1;
  /** The window shown, within the limits [min, max] (ms). */
  private v0 = 0;
  private v1 = 1;
  private min = 0;
  private max = 1;
  private hover: SpanRef | null = null;
  private hoverLane: Lane | null = null;
  private selected = -1;
  private search: RegExp | null = null;
  private readonly matches = new Map<number, boolean>();
  private readonly colors = new Map<number, [string, string]>();
  private drag: { x: number; y: number; v0: number; top: number; moved: boolean } | null = null;
  private frame = 0;

  constructor(
    private readonly profile: Profile,
    private readonly handlers: {
      loadRows: (thread: number) => CallSpans[];
      onActivate: (func: number) => void;
      onContextMenu: (span: SpanRef, ev: MouseEvent) => void;
      onLaneMenu: (lane: Lane, ev: MouseEvent) => void;
      onToggle: () => void;
      onSelect: (func: number) => void;
      onWindow: (v0: number, v1: number) => void;
    },
    signal: AbortSignal,
  ) {
    this.canvas = el('canvas', { class: 'tl-canvas' });
    this.spacer = el('div');
    this.scroller = el('div', { class: 'tl-scroller' }, this.canvas, this.spacer);
    this.tooltip = el('div', { class: 'tooltip hidden' });
    this.element = el('div', { class: 'tl' }, this.scroller, this.tooltip);
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.scroller.addEventListener('scroll', () => this.schedule());
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, v0: this.v0, top: this.scroller.scrollTop, moved: false };
    });
    window.addEventListener('mousemove', (e) => this.onMove(e), { signal });
    window.addEventListener('mouseup', (e) => this.onUp(e), { signal });
    this.canvas.addEventListener('mouseleave', () => this.setHover(null, null));
    this.canvas.addEventListener('dblclick', (e) => {
      const h = this.hitAt(e.offsetX, e.offsetY);
      if (h?.span) this.handlers.onActivate(this.span(h.span).func);
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      const h = this.hitAt(e.offsetX, e.offsetY);
      if (!h) return;
      e.preventDefault();
      if (h.span) this.handlers.onContextMenu(h.span, e);
      else this.handlers.onLaneMenu(h.lane, e);
    });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  /** `keepWindow`: the limits did not change, keep the zoom. */
  setLanes(lanes: Lane[], total: number, min: number, max: number, keepWindow: boolean): void {
    this.lanes = lanes;
    this.total = Math.max(1, total);
    this.min = min;
    this.max = Math.max(min + this.profile.sampleMs, max);
    this.hover = null;
    this.colors.clear();
    this.layout();
    if (keepWindow) this.setWindow(this.v0, this.v1);
    else this.setWindow(this.min, this.max);
  }

  setSearch(re: RegExp | null): void {
    this.search = re;
    this.matches.clear();
    this.schedule();
  }

  get window(): [number, number] {
    return [this.v0, this.v1];
  }

  get isZoomed(): boolean {
    return this.v0 > this.min || this.v1 < this.max;
  }

  resetZoom(): void {
    this.setWindow(this.min, this.max);
  }

  /** Shows a span with a margin on both sides. */
  zoomTo(start: number, end: number): void {
    const m = (end - start) * 0.05;
    this.setWindow(start - m, end + m);
  }

  expandAll(expanded: boolean): void {
    for (const l of this.lanes) this.expand(l, expanded);
    this.layout();
    this.handlers.onToggle();
    this.schedule();
  }

  span(ref: SpanRef): { func: number; start: number; end: number; samples: number } {
    const r = ref.lane.rows![ref.depth];
    return { func: r.func[ref.index], start: r.start[ref.index], end: r.end[ref.index], samples: r.samples[ref.index] };
  }

  /** Spans of a function in the expanded lanes. */
  countSpans(func: number): number {
    let n = 0;
    for (const l of this.lanes) {
      if (!l.expanded || !l.rows) continue;
      for (const r of l.rows) for (const f of r.func) if (f === func) n++;
    }
    return n;
  }

  // Layout ------------------------------------------------------------------------

  private expand(lane: Lane, expanded: boolean): void {
    lane.expanded = expanded;
    if (expanded && !lane.rows) lane.rows = this.handlers.loadRows(lane.thread);
  }

  private laneHeight(l: Lane): number {
    return HEADER + (l.expanded && l.rows ? l.rows.length * ROW + LANE_PAD : 0);
  }

  private layout(): void {
    let y = 0;
    this.tops = this.lanes.map((l) => {
      const top = y;
      y += this.laneHeight(l);
      return top;
    });
    this.spacer.style.height = Math.max(0, RULER + y - this.scroller.clientHeight) + 'px';
  }

  private contentHeight(): number {
    const n = this.lanes.length;
    return n ? this.tops[n - 1] + this.laneHeight(this.lanes[n - 1]) : 0;
  }

  private setWindow(a: number, b: number): void {
    const range = this.max - this.min;
    const span = Math.min(range, Math.max(this.profile.sampleMs * 4, b - a));
    a = Math.max(this.min, Math.min(this.max - span, a));
    this.v0 = a;
    this.v1 = a + span;
    this.handlers.onWindow(this.v0, this.v1);
    this.schedule();
  }

  private hitAt(x: number, y: number): Hit | null {
    if (y < RULER || !this.lanes.length) return null;
    const cy = y - RULER + this.scroller.scrollTop;
    const i = upperBound(this.tops, cy) - 1;
    if (i < 0) return null;
    const lane = this.lanes[i];
    const ly = cy - this.tops[i];
    if (ly >= this.laneHeight(lane)) return null;
    if (ly < HEADER) return { lane, header: true, span: null };
    const depth = Math.floor((ly - HEADER) / ROW);
    const r = lane.rows?.[depth];
    if (!lane.expanded || !r) return { lane, header: false, span: null };
    // A pixel of slack, so that spans narrower than a pixel can be pointed at.
    const ms = (this.v1 - this.v0) / Math.max(1, this.canvas.clientWidth);
    const t = this.v0 + x * ms;
    const k = upperBound(r.end, t - ms);
    const span = k < r.start.length && r.start[k] <= t + ms ? { lane, depth, index: k } : null;
    return { lane, header: false, span };
  }

  // Interaction -------------------------------------------------------------------

  private onMove(e: MouseEvent): void {
    const d = this.drag;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        d.moved = true;
        this.canvas.classList.add('panning');
        this.setHover(null, null);
      }
      if (d.moved) {
        const msPerPx = (this.v1 - this.v0) / Math.max(1, this.canvas.clientWidth);
        this.setWindow(d.v0 - dx * msPerPx, d.v0 - dx * msPerPx + (this.v1 - this.v0));
        this.scroller.scrollTop = d.top - dy;
      }
      return;
    }
    if (e.target !== this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const h = this.hitAt(e.clientX - rect.left, e.clientY - rect.top);
    this.setHover(h?.span ?? null, h?.header ? h.lane : null);
    if (h) this.showTooltip(h, e);
  }

  private onUp(e: MouseEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.canvas.classList.remove('panning');
    if (d.moved || e.target !== this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const h = this.hitAt(e.clientX - rect.left, e.clientY - rect.top);
    if (h?.header) {
      // The second click of a double-click would undo the first.
      if (e.detail > 1) return;
      this.expand(h.lane, !h.lane.expanded);
      this.layout();
      this.handlers.onToggle();
      this.schedule();
      return;
    }
    this.selected = h?.span ? this.span(h.span).func : -1;
    this.handlers.onSelect(this.selected);
    this.schedule();
  }

  private onWheel(e: WheelEvent): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const msPerPx = (this.v1 - this.v0) / w;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const at = this.v0 + (e.clientX - rect.left) * msPerPx;
      const f = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.002)));
      this.setWindow(at - (at - this.v0) * f, at + (this.v1 - at) * f);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * msPerPx;
      this.setWindow(this.v0 + dx, this.v1 + dx);
    }
    // A plain wheel scrolls the lanes.
  }

  private setHover(span: SpanRef | null, lane: Lane | null): void {
    const same = span && this.hover ? span.lane === this.hover.lane && span.depth === this.hover.depth && span.index === this.hover.index : span === this.hover;
    if (!same || lane !== this.hoverLane) {
      this.hover = span;
      this.hoverLane = lane;
      this.schedule();
    }
    if (!span && !lane) this.tooltip.classList.add('hidden');
  }

  private showTooltip(h: Hit, e: MouseEvent): void {
    const p = this.profile;
    const ms = (n: number) => fmtMs(n * p.sampleMs);
    if (h.span) {
      const s = this.span(h.span);
      const mod = p.moduleName(s.func);
      this.tooltip.innerHTML =
        `<div class="tt-name">${esc(p.funcLabel(s.func))}</div>` +
        (mod ? `<div class="tt-mod">${esc(mod)}</div>` : '') +
        `<table><tr><td>Start</td><td>${fmtTime(s.start)}</td></tr>` +
        `<tr><td>Duration</td><td>${fmtMs(s.end - s.start)}</td></tr>` +
        `<tr><td>CPU</td><td>${ms(s.samples)}</td></tr></table>` +
        `<div class="tt-hint">click: highlight · double-click: source · right-click: more</div>`;
    } else if (h.header) {
      const l = h.lane;
      this.tooltip.innerHTML =
        `<div class="tt-name">${esc(this.laneTitle(l))}</div>` +
        `<table><tr><td>CPU</td><td>${ms(l.samples)}</td><td>${fmtPct((100 * l.samples) / this.total)}</td></tr></table>` +
        `<div class="tt-hint">click: ${l.expanded ? 'collapse' : 'expand'} · right-click: thread filter</div>`;
    } else {
      this.tooltip.classList.add('hidden');
      return;
    }
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

  private laneTitle(l: Lane): string {
    return (l.main ? 'Main thread · ' : '') + this.profile.threadLabels[l.thread];
  }

  // Drawing -----------------------------------------------------------------------

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private matched(func: number): boolean {
    let m = this.matches.get(func);
    if (m === undefined) this.matches.set(func, (m = this.search!.test(this.profile.fullName(func))));
    return m;
  }

  private color(func: number, matched: boolean): [string, string] {
    if (this.search) return frameColors(this.profile, func, true, matched);
    let c = this.colors.get(func);
    if (!c) this.colors.set(func, (c = frameColors(this.profile, func, false, false)));
    return c;
  }

  private draw(): void {
    const w = this.scroller.clientWidth;
    const h = this.scroller.clientHeight;
    if (w === 0 || h === 0) return;
    this.spacer.style.height = Math.max(0, RULER + this.contentHeight() - h) + 'px';
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.body);
    const theme = {
      fg: css.getPropertyValue('--vscode-foreground') || '#ccc',
      muted: css.getPropertyValue('--vscode-descriptionForeground') || '#9d9d9d',
      bg: css.getPropertyValue('--vscode-editor-background') || '#1e1e1e',
      header: css.getPropertyValue('--vscode-sideBarSectionHeader-background') || 'rgba(128, 128, 128, 0.14)',
      grid: css.getPropertyValue('--vscode-editorWidget-border') || '#444',
      accent: css.getPropertyValue('--vscode-charts-blue') || '#3794ff',
      focus: css.getPropertyValue('--vscode-focusBorder') || '#007fd4',
      font: css.getPropertyValue('--vscode-font-family') || 'sans-serif',
    };
    ctx.textBaseline = 'middle';

    if (!this.lanes.length) {
      ctx.fillStyle = theme.muted;
      ctx.font = `12px ${theme.font}`;
      ctx.fillText('No samples in the selected threads and time range.', 10, RULER + 16);
    }

    const scrollTop = this.scroller.scrollTop;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER, w, h - RULER);
    ctx.clip();
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      const y = RULER + this.tops[i] - scrollTop;
      if (y > h) break;
      if (y + this.laneHeight(lane) < RULER) continue;
      this.drawLane(ctx, lane, y, w, h, theme);
    }
    ctx.restore();
    this.drawRuler(ctx, w, theme);
  }

  private drawLane(ctx: CanvasRenderingContext2D, lane: Lane, y: number, w: number, h: number, theme: Record<string, string>): void {
    const px = w / (this.v1 - this.v0);
    const xOf = (t: number) => (t - this.v0) * px;

    // Header: thread name over a strip of when the thread ran.
    ctx.fillStyle = theme.header;
    ctx.fillRect(0, y, w, HEADER);
    ctx.fillStyle = theme.grid;
    ctx.fillRect(0, y, w, 1);
    const a = lane.activity;
    ctx.fillStyle = theme.accent;
    let lastPx = -Infinity;
    for (let k = upperBound(a.end, this.v0); k < a.start.length && a.start[k] < this.v1; k++) {
      const x0 = Math.max(0, xOf(a.start[k]));
      const x1 = Math.min(w, xOf(a.end[k]));
      if (x1 - x0 < 1 && Math.floor(x0) <= lastPx) continue;
      lastPx = Math.floor(x0);
      ctx.fillRect(x0, y + HEADER - 5, Math.max(1, x1 - x0), 4);
    }
    ctx.font = `12px ${theme.font}`;
    ctx.fillStyle = lane === this.hoverLane ? theme.focus : theme.fg;
    const cpu = `${fmtMs(lane.samples * this.profile.sampleMs)} (${fmtPct((100 * lane.samples) / this.total)})`;
    const title = `${lane.expanded ? '▾' : '▸'} ${this.laneTitle(lane)}`;
    ctx.fillText(this.fit(ctx, title, w - 120), 6, y + (HEADER - 5) / 2 + 1);
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'right';
    ctx.fillText(cpu, w - 6, y + (HEADER - 5) / 2 + 1);
    ctx.textAlign = 'left';

    if (!lane.expanded || !lane.rows) return;
    ctx.font = `11px ${theme.font}`;
    const charW = ctx.measureText('abcdefghijklmnopqrstuvwxyz').width / 26;
    const searching = !!this.search;
    // While searching, a frame under a match is highlighted too: these are the matched intervals of the row above.
    let above: number[] = [];
    for (let d = 0; d < lane.rows.length; d++) {
      const r = lane.rows[d];
      const ry = y + HEADER + d * ROW;
      const visible = ry + ROW >= RULER && ry <= h;
      if (!visible && !searching) continue;
      if (ry > h) break;
      const here: number[] = [];
      let p = 0;
      lastPx = -Infinity;
      for (let k = upperBound(r.end, this.v0); k < r.start.length && r.start[k] < this.v1; k++) {
        const func = r.func[k];
        let hit = false;
        if (searching) {
          while (p < above.length && above[p + 1] <= r.start[k]) p += 2;
          hit = (p < above.length && above[p] <= r.start[k]) || this.matched(func);
          if (hit) here.push(r.start[k], r.end[k]);
        }
        if (!visible) continue;
        const x0 = xOf(r.start[k]);
        const x1 = xOf(r.end[k]);
        const bw = x1 - x0;
        if (bw < 1) {
          // Sub-pixel calls: one pixel per column is enough.
          if (Math.floor(x0) <= lastPx) continue;
          lastPx = Math.floor(x0);
        }
        const [fill, text] = this.color(func, hit);
        ctx.fillStyle = fill;
        ctx.fillRect(x0, ry, Math.max(1, bw - 1), ROW - 1);
        const hovered = this.hover?.lane === lane && this.hover.depth === d && this.hover.index === k;
        if (hovered || func === this.selected) {
          ctx.strokeStyle = hovered ? theme.focus : text;
          ctx.lineWidth = hovered ? 2 : 1;
          ctx.strokeRect(x0 + 1, ry + 1, Math.max(1, bw - 3), ROW - 3);
          ctx.lineWidth = 1;
        }
        // The label stays on the visible part of the span.
        const lx = Math.max(0, x0);
        const lw = Math.min(w, x1) - lx;
        if (lw > 28) {
          const label = this.profile.funcLabel(func);
          const max = Math.floor((lw - 8) / charW);
          ctx.fillStyle = text;
          ctx.fillText(label.length > max ? label.slice(0, Math.max(0, max - 1)) + '…' : label, lx + 4, ry + ROW / 2);
        }
      }
      above = here;
    }
  }

  private drawRuler(ctx: CanvasRenderingContext2D, w: number, theme: Record<string, string>): void {
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, RULER);
    ctx.fillStyle = theme.grid;
    ctx.fillRect(0, RULER - 1, w, 1);
    const span = this.v1 - this.v0;
    const step = tickStep(span / Math.max(1, w / 100));
    const decimals = Math.max(0, 3 - Math.floor(Math.log10(step)));
    ctx.font = `10px ${theme.font}`;
    ctx.fillStyle = theme.muted;
    for (let i = Math.ceil(this.v0 / step); i * step <= this.v1; i++) {
      const t = i * step;
      const x = Math.round(((t - this.v0) / span) * w);
      ctx.fillRect(x, RULER - 6, 1, 5);
      ctx.fillText(`${(t / 1000).toFixed(decimals)} s`, Math.min(w - 40, x + 3), RULER / 2 - 1);
    }
  }

  /** `text` cut with an ellipsis to fit `width` pixels. */
  private fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
    if (ctx.measureText(text).width <= width) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= width) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }
}
