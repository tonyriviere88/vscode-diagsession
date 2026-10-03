import type { AppApi, View } from '../api';
import { markHotPath, type TreeNode } from '../model';
import { el, esc, fmtMs, fmtPct, fmtTime } from '../util';

/** Landing page: capture facts, symbol health, hot path and top functions (VS "Summary"). */
export class SummaryView implements View {
  readonly id = 'summary';
  readonly title = 'Summary';
  readonly element: HTMLElement;

  constructor(private readonly app: AppApi) {
    this.element = el('div', { class: 'view summary' });
    this.element.addEventListener('click', (ev) => {
      const t = (ev.target as HTMLElement).closest('[data-func]') as HTMLElement | null;
      if (t) app.showInCallTree(Number(t.dataset.func));
    });
    this.element.addEventListener('contextmenu', (ev) => {
      const t = (ev.target as HTMLElement).closest('[data-func]') as HTMLElement | null;
      if (!t) return;
      ev.preventDefault();
      app.functionMenu(ev, Number(t.dataset.func));
    });
  }

  refresh(): void {
    const app = this.app;
    const p = app.profile;
    const raw = p.raw;
    const sel = app.selection();
    const ms = (n: number) => fmtMs(n * p.sampleMs);
    const pct = (n: number) => fmtPct((100 * n) / Math.max(1, sel.total));
    const windowMs = Math.min(app.filter.t1, p.duration) - app.filter.t0;
    // Averaged over the time the process was actually sampled, not the whole (system-wide) trace.
    const activeMs = sel.total ? Math.max(p.sampleMs, sel.last - sel.first + p.sampleMs) : 0;
    const cores = activeMs > 0 ? (sel.total * p.sampleMs) / activeMs : 0;
    const threadsUsed = p.threads(app.filter).filter((t) => !app.filter.threads || app.filter.threads.has(t.thread));

    const funcs = p.functions(sel);
    const bySelf = [...funcs].filter((f) => !p.isSynthetic(f.func)).sort((a, b) => b.self - a.self).slice(0, 12);
    const byTotal = [...funcs]
      .filter((f) => !p.isSynthetic(f.func) && !p.isExternal(f.func))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);

    // Symbol health: samples whose leaf is in a module without symbols.
    const noSym = new Map<number, number>();
    for (const f of funcs) {
      const m = p.funcModule[f.func];
      if (f.func < p.nFuncs && m >= 0 && !raw.modules[m].symbols && f.self > 0) noSym.set(m, (noSym.get(m) ?? 0) + f.self);
    }
    const noSymTotal = [...noSym.values()].reduce((a, b) => a + b, 0);
    const noSymList = [...noSym.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const withSymbols = raw.modules.filter((m) => m.symbols).length;

    const tree = p.topDown(sel, true);
    const hotLeaf = markHotPath(tree);
    const hotPath: TreeNode[] = [];
    for (let n: TreeNode | null = hotLeaf; n && n.parent; n = n.parent) hotPath.unshift(n);

    const fact = (label: string, value: string, sub = '') =>
      `<div class="fact"><div class="fact-label">${esc(label)}</div><div class="fact-value">${esc(value)}</div>${sub ? `<div class="fact-sub">${esc(sub)}</div>` : ''}</div>`;

    const fnRow = (func: number, value: number, of: number, extra: string) =>
      `<tr class="link" data-func="${func}"><td class="fn-cell"><span class="fn ${p.isExternal(func) ? 'external' : ''}" title="${esc(p.fullName(func))}">${esc(p.funcLabel(func))}</span><span class="module"> ${esc(p.moduleName(func))}</span></td>` +
      `<td class="right">${ms(value)}</td><td class="right pct"><div class="bar ${extra}" style="width:${Math.min(100, (100 * value) / Math.max(1, of)).toFixed(1)}%"></div><span>${pct(value)}</span></td></tr>`;

    const symbolsBlock =
      noSymTotal > 0.02 * sel.total
        ? `<div class="notice">
            <b>${pct(noSymTotal)}</b> of the CPU samples land in modules without symbols:
            ${noSymList
              .map(([m, n]) => `<code>${esc(raw.modules[m].name)}</code> ${pct(n)}${raw.modules[m].path ? ` <button class="load-symbols" data-module="${m}" title="Search this module's PDB in every symbol location, Microsoft symbol server included">Load symbols</button>` : ''}`)
              .join(', ')}.
            ${raw.localSymbols ? 'Only the PDBs next to their binary are loaded (<code>diagsession.localSymbolsOnly</code>).' : ''}
            ${raw.msSymbols ? 'Microsoft symbols were already requested; configure <code>diagsession.symbolPaths</code> for the others.' : '<button id="ms-symbols">Load Microsoft symbols</button> <span class="hint">(downloads into the symbol cache, slow the first time)</span>'}
          </div>`
        : '';

    this.element.innerHTML = `
      <div class="facts">
        ${fact('Process', `${raw.process.name} (PID ${raw.process.pid})`, raw.process.commandLine)}
        ${fact('Analysed range', fmtTime(windowMs), app.filter.t0 > 0 || app.filter.t1 < p.duration ? `${fmtTime(app.filter.t0)} – ${fmtTime(app.filter.t1)}` : `whole capture, started ${new Date(raw.traceStartUtc).toLocaleString()}`)}
        ${fact('CPU time', ms(sel.total), `${sel.total.toLocaleString('en-US')} samples @ ${p.sampleMs} ms`)}
        ${fact('Average CPU', `${cores.toFixed(2)} cores`, `over ${fmtTime(activeMs)} with samples · ${fmtPct((100 * cores) / Math.max(1, raw.cpuCount))} of ${raw.cpuCount} logical processors`)}
        ${fact('Threads', `${threadsUsed.length}`, app.filter.threads ? 'filtered' : `${raw.threads.length} sampled in total`)}
        ${fact('Symbols', `${withSymbols} / ${raw.modules.length} modules`, (raw.localSymbols ? 'PDBs next to the binaries' : 'local symbols and cache') + (raw.msSymbols ? ', Microsoft symbol server' : ''))}
      </div>
      ${symbolsBlock}
      <div class="columns">
        <section>
          <h3>Hot path <span class="hint">external code collapsed</span></h3>
          <table class="grid"><thead><tr><th>Function</th><th class="right">Total CPU</th><th class="right">Total %</th></tr></thead>
          <tbody>${hotPath.map((n) => fnRow(n.func, n.total, sel.total, 'total')).join('')}</tbody></table>
        </section>
        <section>
          <h3>Top functions by self time</h3>
          <table class="grid"><thead><tr><th>Function</th><th class="right">Self CPU</th><th class="right">Self %</th></tr></thead>
          <tbody>${bySelf.map((f) => fnRow(f.func, f.self, sel.total, 'self')).join('')}</tbody></table>
        </section>
        <section>
          <h3>Top functions by total time <span class="hint">your code (${raw.localSymbols ? 'PDB next to the binary' : 'with symbols, outside Windows'})</span></h3>
          <table class="grid"><thead><tr><th>Function</th><th class="right">Total CPU</th><th class="right">Total %</th></tr></thead>
          <tbody>${byTotal.map((f) => fnRow(f.func, f.total, sel.total, 'total')).join('')}</tbody></table>
        </section>
      </div>
      <p class="hint">Click a function to open it in the call tree, right-click for more. CPU sampling only sees threads while they run: time spent waiting (locks, I/O, sleeps) does not appear here.
      Analysed in ${raw.analysisSeconds.toFixed(1)} s · symbol path: <code>${esc(raw.symbolPath)}</code></p>`;
    this.element.querySelector('#ms-symbols')?.addEventListener('click', () => app.reanalyze({ msSymbols: true }));
    for (const b of Array.from(this.element.querySelectorAll<HTMLElement>('.load-symbols'))) {
      b.addEventListener('click', () => app.loadSymbolsItem(Number(b.dataset.module))?.action());
    }
  }
}
