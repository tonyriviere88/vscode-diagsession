import { el, esc } from './util';

export interface Column<R> {
  id: string;
  title: string;
  width: string;
  align?: 'left' | 'right';
  /** Returns cell HTML (already escaped). */
  html: (row: R, index: number) => string;
  /** Sort key; columns without one are not sortable. */
  sort?: (row: R) => number | string;
  /** Initial sort direction when the header is first clicked. */
  desc?: boolean;
  tooltip?: string;
  /** Always shown: not listed in the header's column menu. */
  fixed?: boolean;
  /** Hidden until the user enables it from the header's column menu. */
  hiddenByDefault?: boolean;
}

export interface TableOptions<R> {
  /** Key under which the visible columns are remembered; tables sharing it share the choice. */
  id?: string;
  rowHeight?: number;
  onActivate?: (row: R) => void;
  onSelect?: (row: R) => void;
  onContextMenu?: (row: R, ev: MouseEvent) => void;
  /** Click on an element inside a row; return true when handled (the row is still selected). */
  onClick?: (row: R, target: HTMLElement) => boolean;
  /** Tree support: a click on `.twisty` and Left/Right keys call these. */
  onToggle?: (row: R, expand?: boolean) => void;
  isExpandable?: (row: R) => boolean;
  isExpanded?: (row: R) => boolean;
  parentOf?: (row: R) => R | null;
  /** Sorting handled by the owner (trees sort children, not rows). */
  onSort?: (column: Column<R>, desc: boolean) => void;
  rowClass?: (row: R) => string;
}

/** Where tables remember their hidden columns (set up by the app with the webview state). */
export interface ColumnStore {
  get(id: string): string[] | undefined;
  set(id: string, hidden: string[]): void;
}

let columnStore: ColumnStore | null = null;
const liveTables = new Set<VirtualTable<any>>();

export function setColumnStore(store: ColumnStore): void {
  columnStore = store;
}

/** A virtualized table: only the rows in view are in the DOM, so trees with 100k nodes stay responsive. */
export class VirtualTable<R> {
  readonly element: HTMLElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly rowsHost: HTMLElement;
  private rows: R[] = [];
  private selected: R | null = null;
  private readonly rowHeight: number;
  private sortCol: Column<R> | null = null;
  private sortDesc = true;
  private frame = 0;
  private hidden: Set<string>;
  private visible: Column<R>[] = [];
  private menu: HTMLElement | null = null;

  constructor(
    private readonly columns: Column<R>[],
    private readonly opts: TableOptions<R> = {},
  ) {
    this.rowHeight = opts.rowHeight ?? 22;
    const saved = opts.id ? columnStore?.get(opts.id) : undefined;
    this.hidden = new Set(saved ?? columns.filter((c) => c.hiddenByDefault).map((c) => c.id));

    this.header = el('div', { class: 'vt-header' });
    this.spacer = el('div', { class: 'vt-spacer' });
    this.rowsHost = el('div', { class: 'vt-rows' });
    this.body = el('div', { class: 'vt-body', tabindex: '0' }, this.spacer, this.rowsHost);
    this.body.style.setProperty('--vt-row', this.rowHeight + 'px');
    this.element = el('div', { class: 'vt' }, this.header, this.body);
    this.buildHeader();
    if (opts.id) liveTables.add(this);

    this.body.addEventListener('scroll', () => {
      this.header.scrollLeft = this.body.scrollLeft; // the header follows when the columns are wider than the view
      this.schedule();
    });
    new ResizeObserver(() => this.schedule()).observe(this.body);
    this.body.addEventListener('click', (ev) => this.onClick(ev));
    this.body.addEventListener('contextmenu', (ev) => {
      const row = this.rowAt(ev);
      if (row === undefined) return;
      ev.preventDefault();
      this.select(row);
      opts.onContextMenu?.(row, ev);
    });
    this.body.addEventListener('keydown', (ev) => this.onKey(ev));
    this.header.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.showColumnMenu(ev);
    });
  }

  setRows(rows: R[], keepScroll = true): void {
    this.rows = rows;
    if (this.sortCol?.sort && !this.opts.onSort) this.applySort();
    if (!keepScroll) this.body.scrollTop = 0;
    this.spacer.style.height = rows.length * this.rowHeight + 'px';
    this.render();
  }

  getRows(): R[] {
    return this.rows;
  }

  get selection(): R | null {
    return this.selected;
  }

  select(row: R | null, reveal = false): void {
    const changed = row !== this.selected;
    this.selected = row;
    if (row !== null && changed) this.opts.onSelect?.(row);
    if (reveal && row !== null && this.reveal(row)) {
      this.render();
      return;
    }
    // Only move the highlight: replacing the row elements between two clicks would swallow the double-click.
    const index = row === null ? -1 : this.rows.indexOf(row);
    for (const rowEl of Array.from(this.rowsHost.children) as HTMLElement[]) {
      rowEl.classList.toggle('selected', Number(rowEl.dataset.i) === index);
    }
  }

  /** Scrolls a row into view; returns true when the view scrolled. */
  reveal(row: R): boolean {
    const i = this.rows.indexOf(row);
    if (i < 0) return false;
    const top = i * this.rowHeight;
    const view = this.body.clientHeight;
    if (top < this.body.scrollTop || top + this.rowHeight > this.body.scrollTop + view) {
      this.body.scrollTop = Math.max(0, top - view / 3);
      return true;
    }
    return false;
  }

  focus(): void {
    this.body.focus();
  }

  setSort(columnId: string, desc: boolean): void {
    this.sortCol = this.columns.find((c) => c.id === columnId) ?? null;
    this.sortDesc = desc;
    this.updateHeader();
  }

  // ------------------------------------------------------------------ columns

  private buildHeader(): void {
    this.visible = this.columns.filter((c) => c.fixed || !this.hidden.has(c.id));
    const template = this.visible.map((c) => c.width).join(' ');
    this.header.style.gridTemplateColumns = template;
    this.body.style.setProperty('--vt-cols', template);
    this.header.innerHTML = '';
    for (const c of this.visible) {
      const h = el('div', { class: 'vt-hcell' + (c.align === 'right' ? ' right' : '') + (c.sort || this.opts.onSort ? ' sortable' : '') });
      h.innerHTML = esc(c.title);
      h.title = (c.tooltip ? c.tooltip + ' · ' : '') + 'right-click to choose columns';
      h.dataset.col = c.id;
      h.addEventListener('click', () => this.sortBy(c));
      this.header.append(h);
    }
    this.updateHeader();
  }

  private setHidden(hidden: Set<string>, save = true): void {
    this.hidden = hidden;
    this.buildHeader();
    this.render();
    if (save && this.opts.id) {
      columnStore?.set(this.opts.id, [...hidden]);
      // Tables showing the same kind of data (e.g. the three Caller/Callee lists) follow the same choice.
      for (const t of liveTables) {
        if (t !== this && t.opts.id === this.opts.id) t.setHidden(new Set(hidden), false);
      }
    }
  }

  private showColumnMenu(ev: MouseEvent): void {
    this.closeMenu();
    const menu = el('div', { class: 'menu column-menu' });
    const hideable = this.columns.filter((c) => !c.fixed && c.title);
    for (const c of hideable) {
      const box = el('input', { type: 'checkbox' });
      box.checked = !this.hidden.has(c.id);
      box.addEventListener('change', () => {
        const next = new Set(this.hidden);
        if (box.checked) next.delete(c.id);
        else next.add(c.id);
        this.setHidden(next);
      });
      menu.append(el('label', { class: 'menu-item menu-check' }, box, c.title));
    }
    const reset = el('button', { class: 'menu-item' }, 'Reset columns');
    reset.addEventListener('click', () => {
      this.setHidden(new Set(this.columns.filter((c) => c.hiddenByDefault).map((c) => c.id)));
      this.closeMenu();
    });
    menu.append(el('div', { class: 'menu-sep' }), reset);
    document.body.append(menu);
    menu.style.left = Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 4) + 'px';
    menu.style.top = Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 4) + 'px';
    this.menu = menu;
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      if (e.type === 'mousedown' && menu.contains(e.target as Node)) return;
      this.closeMenu();
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', close);
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', close);
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  // ------------------------------------------------------------------ sorting

  private sortBy(c: Column<R>): void {
    if (!c.sort && !this.opts.onSort) return;
    this.sortDesc = this.sortCol === c ? !this.sortDesc : (c.desc ?? true);
    this.sortCol = c;
    this.updateHeader();
    if (this.opts.onSort) {
      this.opts.onSort(c, this.sortDesc);
    } else {
      this.applySort();
      this.render();
    }
  }

  private updateHeader(): void {
    for (const h of Array.from(this.header.children) as HTMLElement[]) {
      h.classList.toggle('sorted', h.dataset.col === this.sortCol?.id);
      h.classList.toggle('desc', h.dataset.col === this.sortCol?.id && this.sortDesc);
    }
  }

  private applySort(): void {
    const key = this.sortCol?.sort;
    if (!key) return;
    const dir = this.sortDesc ? -1 : 1;
    this.rows.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir;
    });
  }

  // ------------------------------------------------------------------ rendering

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const h = this.rowHeight;
    const first = Math.max(0, Math.floor(this.body.scrollTop / h) - 5);
    const last = Math.min(this.rows.length, Math.ceil((this.body.scrollTop + this.body.clientHeight) / h) + 5);
    const parts: string[] = [];
    for (let i = first; i < last; i++) {
      const r = this.rows[i];
      const cls = (r === this.selected ? ' selected' : '') + (this.opts.rowClass ? ' ' + this.opts.rowClass(r) : '');
      parts.push(`<div class="vt-row${cls}" data-i="${i}" style="top:${i * h}px">`);
      for (const c of this.visible) {
        parts.push(`<div class="vt-cell${c.align === 'right' ? ' right' : ''}">${c.html(r, i)}</div>`);
      }
      parts.push('</div>');
    }
    this.rowsHost.innerHTML = parts.join('');
  }

  private rowAt(ev: Event): R | undefined {
    const rowEl = (ev.target as HTMLElement).closest('.vt-row') as HTMLElement | null;
    if (!rowEl) return undefined;
    return this.rows[Number(rowEl.dataset.i)];
  }

  private onClick(ev: MouseEvent): void {
    const row = this.rowAt(ev);
    if (row === undefined) return;
    const target = ev.target as HTMLElement;
    this.body.focus();
    if (target.classList.contains('twisty')) {
      this.select(row);
      this.opts.onToggle?.(row);
      return;
    }
    if (this.opts.onClick?.(row, target)) {
      this.select(row);
      return;
    }
    if (target instanceof HTMLInputElement) return; // checkboxes handle themselves
    this.select(row);
    // The click count survives re-renders, unlike the dblclick event.
    if (ev.detail === 2) this.opts.onActivate?.(row);
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.rows.length) return;
    let i = this.selected === null ? -1 : this.rows.indexOf(this.selected);
    const page = Math.max(1, Math.floor(this.body.clientHeight / this.rowHeight) - 1);
    const sel = this.selected;
    switch (ev.key) {
      case 'ArrowDown':
        i = Math.min(this.rows.length - 1, i + 1);
        break;
      case 'ArrowUp':
        i = Math.max(0, i - 1);
        break;
      case 'PageDown':
        i = Math.min(this.rows.length - 1, i + page);
        break;
      case 'PageUp':
        i = Math.max(0, i - page);
        break;
      case 'Home':
        i = 0;
        break;
      case 'End':
        i = this.rows.length - 1;
        break;
      case 'ArrowRight':
        if (sel !== null && this.opts.isExpandable?.(sel)) {
          if (!this.opts.isExpanded?.(sel)) this.opts.onToggle?.(sel, true);
          else i = Math.min(this.rows.length - 1, i + 1);
        }
        break;
      case 'ArrowLeft':
        if (sel !== null) {
          if (this.opts.isExpandable?.(sel) && this.opts.isExpanded?.(sel)) this.opts.onToggle?.(sel, false);
          else {
            const p = this.opts.parentOf?.(sel);
            if (p) i = this.rows.indexOf(p);
          }
        }
        break;
      case 'Enter':
        if (sel !== null) this.opts.onActivate?.(sel);
        ev.preventDefault();
        return;
      default:
        return;
    }
    ev.preventDefault();
    if (i >= 0 && this.rows[i] !== undefined) this.select(this.rows[i], true);
  }
}
