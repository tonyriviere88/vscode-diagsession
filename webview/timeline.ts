import type { Profile } from './model';
import { el, fmtTime } from './util';

/** CPU usage graph over the capture; drag to select the time range every view analyses. */
export class Timeline {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly info: HTMLElement;
  private threads: Set<number> | null = null;
  private range: [number, number] | null = null;
  private drag: { x0: number } | null = null;
  private hoverX = -1;
  private cacheAll: Float64Array | null = null;
  private cacheSel: Float64Array | null = null;
  private cacheBins = 0;

  constructor(
    private readonly profile: Profile,
    private readonly onRange: (range: [number, number] | null) => void,
    signal?: AbortSignal,
  ) {
    this.canvas = el('canvas', { class: 'timeline-canvas' });
    this.info = el('div', { class: 'timeline-info' });
    const title = el('div', { class: 'timeline-title' }, 'CPU (% of all processors)');
    this.element = el('div', { class: 'timeline' }, el('div', { class: 'timeline-head' }, title, this.info), this.canvas);
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e), { signal });
    window.addEventListener('mouseup', (e) => this.onUp(e), { signal });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverX = -1;
      this.draw();
    });
    this.canvas.addEventListener('dblclick', () => this.setRange(null, true));
    this.updateInfo();
  }

  setThreads(threads: Set<number> | null): void {
    this.threads = threads;
    this.cacheSel = null;
    this.draw();
  }

  setRange(range: [number, number] | null, notify = false): void {
    this.range = range;
    this.updateInfo();
    this.draw();
    if (notify) this.onRange(range);
  }

  private updateInfo(): void {
    const p = this.profile;
    if (this.range) {
      const [a, b] = this.range;
      this.info.textContent = `Selection ${fmtTime(a)} – ${fmtTime(b)} (${fmtTime(b - a)}) · double-click to clear`;
    } else {
      this.info.textContent = `${fmtTime(p.duration)} · drag to select a time range`;
    }
  }

  private xToMs(x: number): number {
    const w = this.canvas.clientWidth;
    return Math.max(0, Math.min(this.profile.duration, (x / w) * this.profile.duration));
  }

  private onDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    this.drag = { x0: e.offsetX };
  }

  private onMove(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (this.drag) {
      const a = this.xToMs(Math.min(this.drag.x0, x));
      const b = this.xToMs(Math.max(this.drag.x0, x));
      this.range = [a, b];
      this.updateInfo();
      this.draw();
    } else if (e.target === this.canvas) {
      this.hoverX = x;
      this.draw();
    }
  }

  private onUp(e: MouseEvent): void {
    if (!this.drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const moved = Math.abs(x - this.drag.x0) > 3;
    this.drag = null;
    if (!moved) {
      this.setRange(null, this.range !== null);
      return;
    }
    this.setRange(this.range, true);
  }

  draw(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w === 0 || h === 0) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const bins = Math.max(10, Math.floor(w / 2));
    if (bins !== this.cacheBins) {
      this.cacheBins = bins;
      this.cacheAll = null;
      this.cacheSel = null;
    }
    this.cacheAll ??= this.profile.timeline(bins, null);
    this.cacheSel ??= this.threads ? this.profile.timeline(bins, this.threads) : this.cacheAll;
    const all = this.cacheAll;
    const sel = this.cacheSel;

    const css = getComputedStyle(document.body);
    const fg = css.getPropertyValue('--vscode-foreground') || '#ccc';
    const grid = css.getPropertyValue('--vscode-editorWidget-border') || '#444';
    const accent = css.getPropertyValue('--vscode-charts-blue') || '#3794ff';

    let max = 0;
    for (const v of all) max = Math.max(max, v);
    const top = Math.max(0.01, niceCeil(max));
    const plotH = h - 14;
    const y = (v: number) => plotH - (v / top) * (plotH - 4);

    // Grid lines at 0, 50, 100 % of the scale.
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.8;
    ctx.font = '10px var(--vscode-font-family, sans-serif)';
    for (const f of [0.5, 1]) {
      const yy = Math.round(y(top * f)) + 0.5;
      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(`${Math.round(top * f * 100)}%`, 3, yy + 11);
    }
    ctx.globalAlpha = 1;

    const bw = w / bins;
    const drawSeries = (data: Float64Array, fill: string, alpha: number) => {
      ctx.beginPath();
      ctx.moveTo(0, plotH);
      for (let b = 0; b < bins; b++) {
        ctx.lineTo(b * bw, y(data[b]));
        ctx.lineTo((b + 1) * bw, y(data[b]));
      }
      ctx.lineTo(w, plotH);
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    if (sel !== all) drawSeries(all, fg, 0.18);
    drawSeries(sel, accent, 0.75);

    // Time axis.
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.75;
    const step = niceStep(this.profile.duration / Math.max(1, w / 90));
    for (let t = 0; t <= this.profile.duration; t += step) {
      const x = (t / this.profile.duration) * w;
      ctx.fillRect(Math.round(x), plotH, 1, 3);
      const label = (t / 1000).toFixed(step < 1000 ? 1 : 0) + 's';
      ctx.fillText(label, Math.min(w - 24, x + 2), h - 2);
    }
    ctx.globalAlpha = 1;

    if (this.range) {
      const xa = (this.range[0] / this.profile.duration) * w;
      const xb = (this.range[1] / this.profile.duration) * w;
      ctx.fillStyle = css.getPropertyValue('--vscode-editor-background') || '#000';
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, 0, xa, plotH);
      ctx.fillRect(xb, 0, w - xb, plotH);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(xa + 0.5, 0.5, Math.max(1, xb - xa - 1), plotH - 1);
    }

    if (this.hoverX >= 0 && !this.drag) {
      const b = Math.min(bins - 1, Math.floor(this.hoverX / bw));
      ctx.fillStyle = fg;
      ctx.fillRect(Math.round(this.hoverX), 0, 1, plotH);
      const text = `${fmtTime(this.xToMs(this.hoverX))}  ${(sel[b] * 100).toFixed(1)}%`;
      const tw = ctx.measureText(text).width + 8;
      const tx = Math.min(w - tw, this.hoverX + 6);
      ctx.fillStyle = css.getPropertyValue('--vscode-editorHoverWidget-background') || '#252526';
      ctx.fillRect(tx, 2, tw, 15);
      ctx.fillStyle = css.getPropertyValue('--vscode-editorHoverWidget-foreground') || fg;
      ctx.fillText(text, tx + 4, 13);
    }
  }
}

function niceCeil(v: number): number {
  for (const s of [0.05, 0.1, 0.2, 0.25, 0.5, 0.75, 1]) if (v <= s) return s;
  return Math.ceil(v);
}

function niceStep(ms: number): number {
  for (const s of [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000]) {
    if (ms <= s) return s;
  }
  return 1200000;
}
