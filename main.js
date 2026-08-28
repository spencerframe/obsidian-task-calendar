'use strict';
/*
 * Task Planner
 * -----------------
 * Frontmatter is the ONLY source of truth. A scheduled task is any note in the
 * task folder with a parseable `task start`. Nothing is ever written into the
 * note body - no "- [ ] 09:00 - 10:00" lines, no regex round-tripping.
 *
 * Because this plugin owns the grid, every column carries a real data-date and
 * the pixel scale is a constant we set. Date/time resolution is arithmetic,
 * not inference.
 */

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, Menu, Modal, TFile, requestUrl, setIcon, moment,
        prepareFuzzySearch } = require('obsidian');

const VIEW_TYPE = 'task-planner-view';
const DRAG_SOURCE = 'task-planner';
/* Bases' internal markup is still changing between releases, so match a family
 * of plausible row selectors rather than betting on one. */
const ROW_SEL = '.bases-tr, .bases-table-row, .bases-row, [data-bases-row], .bases-cards-card, .bases-card';
const ROW_SKIP = '.bases-thead, .bases-th, .bases-table-header';

/* Categorical palette - validated all-pairs in both light and dark against
 * scripts/validate_palette.js (worst normal-vision dE 19.6 light / 19.3 dark;
 * worst CVD dE 16.2 light / 6.9 dark). The dark CVD pair sits in the 6-8 floor
 * band, which is legal here because every block carries a visible text label. */
const PALETTE = {
  violet:  { light: '#4a3aa7', dark: '#9085e9', name: 'Violet' },
  yellow:  { light: '#eda100', dark: '#c98500', name: 'Amber' },
  green:   { light: '#008300', dark: '#008300', name: 'Green' },
  magenta: { light: '#e87ba4', dark: '#d55181', name: 'Magenta' },
  blue:    { light: '#2a78d6', dark: '#3987e5', name: 'Blue' },
  orange:  { light: '#eb6834', dark: '#d95926', name: 'Orange' },
  aqua:    { light: '#1baf7a', dark: '#199e70', name: 'Aqua' },
  red:     { light: '#e34948', dark: '#e66767', name: 'Red' },
  other:   { light: '#6b7280', dark: '#9aa1ad', name: 'Neutral' },
};
const SLOT_KEYS = ['violet', 'yellow', 'green', 'magenta', 'blue', 'orange', 'aqua', 'red'];

/* Named view presets. `step` is how far the prev/next arrows travel. */
const VIEW_MODES = [
  { key: 'day',      label: 'Day',       cols: 1, step: 1, weekAligned: false },
  { key: '3day',     label: '3 Days',    cols: 3, step: 3, weekAligned: false },
  { key: 'workweek', label: 'Work Week', cols: 5, step: 7, weekAligned: true },
  { key: 'week',     label: 'Week',      cols: 7, step: 7, weekAligned: true },
];
const modeOf = (k) => VIEW_MODES.find((m) => m.key === k) || VIEW_MODES[1];

/* firstDay: 0=Sun, 1=Mon. Computed rather than using locale-dependent
 * startOf('week'), so the week always begins where the setting says. */
function startOfWeek(m, firstDay) {
  const d = m.clone().startOf('day');
  const back = (d.day() - firstDay + 7) % 7;
  return d.subtract(back, 'days');
}

const DEFAULTS = {
  taskFolder: 'tasks',
  startProp: 'task start',
  endProp: 'task end',
  categoryProp: 'category',
  statusProp: 'status',
  estimateProp: 'estimate',
  completedProp: 'completed',
  viewMode: '3day',
  firstDayOfWeek: 1,
  startHour: 6,
  endHour: 23,
  pxPerHour: 60,
  fitToWindow: false,
  snapMinutes: 15,
  defaultDuration: 60,
  useEstimate: true,
  showDone: true,
  autoStatus: true,
  showCalendars: true,
  debug: false,
  alarmsEnabled: true,
  alarmLeadMinutes: 2,
  alarmForEvents: true,
  alarmForTasks: false,
  alarmVolume: 0.5,
  alarmSoundFile: '',
  alarmSystemNotification: true,
  dismissedAlarms: [],
  calendars: [],
  categoryColors: {},
};

/* ---------------- time helpers ---------------- */
const pad2 = (n) => String(n).padStart(2, '0');
const clampMin = (m) => Math.max(0, Math.min(1439, Math.round(m)));
const DT_FORMATS = [
  'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD HH:mm:ss',
  'YYYY-MM-DD HH:mm', 'YYYY-MM-DDTHH:mm:ssZ', 'YYYY-MM-DD',
];

function parseDT(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) { const m = moment(v); return m.isValid() ? m : null; }
  const s = String(v).trim();
  if (!s) return null;
  /* Every supported shape starts with YYYY-MM-DD. Requiring that up front does
   * two things: it stops moment reading a bare number as a year (a mistyped
   * `task start: 60` would otherwise land in 2060 and silently vanish from the
   * grid), and it keeps the non-ISO fallback - which moment deprecates as
   * "not reliable across all browsers" - from firing on free text. */
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  let m = moment(s, DT_FORMATS, false);
  if (!m.isValid()) m = moment(s);
  return m.isValid() ? m : null;
}
const fmtDT = (m) => m.format('YYYY-MM-DDTHH:mm:ss');
const minOfDay = (m) => m.hours() * 60 + m.minutes();
const dayKey = (m) => m.format('YYYY-MM-DD');
const hhmm = (mins) => pad2(Math.floor(clampMin(mins) / 60)) + ':' + pad2(clampMin(mins) % 60);
/* An end time of exactly midnight reads as 24:00, not 23:59 - hhmm clamps to 1439. */
const hhmmEnd = (mins) => (mins < 1440 ? hhmm(mins) : mins === 1440 ? '24:00' : hhmm(mins - 1440) + ' +1d');

function toArray(v) {
  if (v === null || v === undefined || v === '') return [];
  return (Array.isArray(v) ? v : [v])
    .filter((x) => x !== null && x !== undefined)
    .map((x) => String(x).trim())
    .filter(Boolean);
}

/* Paint a colour spec onto an element. A hex is set inline, which beats the
 * [data-color] rules; a slot defers to the theme-aware CSS variables. */
function applyColor(el, spec) {
  el.dataset.color = (spec && spec.slot) || 'other';
  if (spec && spec.hex) el.style.setProperty('--tp-c', spec.hex);
  else el.style.removeProperty('--tp-c');
}

/* Interval layout, the way Google Calendar does it.
 *
 * Three passes over each cluster of mutually overlapping items:
 *   1. columns - greedy interval-graph colouring, so nothing ever shares a
 *      column with something it overlaps;
 *   2. expand  - each item then grows rightwards across columns that are free
 *      for its whole duration. This is what keeps two events wide when they
 *      only clip each other briefly, instead of both being pinned to half;
 *   3. overhang - an item with a neighbour still to its right stretches a
 *      little under it and sits one z-index lower, so the later item overlaps
 *      the earlier one's tail while the earlier one's title stays readable.
 */
const OVERHANG = 0.5;   // fraction of one column an item may bleed rightwards

function packLanes(items) {
  const sorted = items.slice().sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    const columns = [];
    for (const it of cluster) {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const last = columns[i][columns[i].length - 1];
        if (last.e <= it.s) { columns[i].push(it); it.lane = i; placed = true; break; }
      }
      if (!placed) { columns.push([it]); it.lane = columns.length - 1; }
    }
    const n = columns.length;
    for (const it of cluster) {
      let span = 1;
      for (let i = it.lane + 1; i < n; i++) {
        const blocked = columns[i].some((o) => o.s < it.e && it.s < o.e);
        if (blocked) break;
        span++;
      }
      it.lanes = n;
      it.span = span;
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const it of sorted) {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();
  return sorted;
}

/* ================================================================== plugin */
class TaskPlannerPlugin extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULTS, saved);
    /* Migrate the pre-1.1 numeric dayCount. Test against the SAVED data, not the
     * merged settings - DEFAULTS always supplies a viewMode, so a check against
     * the merged object never fires. */
    if (saved && !saved.viewMode && saved.dayCount) {
      this.settings.viewMode = ({ 1: 'day', 3: '3day', 5: 'workweek', 7: 'week' })[saved.dayCount] || DEFAULTS.viewMode;
    }
    delete this.settings.dayCount;
    this.gcache = { at: 0, events: [], cals: [] };

    this.registerView(VIEW_TYPE, (leaf) => new CalendarView(leaf, this));

    this.addRibbonIcon('calendar-clock', 'Task Planner', () => this.activateView());
    this.addCommand({ id: 'open', name: 'Open calendar', callback: () => this.activateView() });
    this.addCommand({
      id: 'refresh-calendars', name: 'Refresh calendars',
      callback: async () => { await this.loadCalendars(true); this.refreshViews(); },
    });

    this.addCommand({ id: 'diagnose', name: 'Diagnose drag and drop', callback: () => this.diagnose() });
    this.addCommand({
      id: 'test-alarm', name: 'Test the alarm sound',
      callback: () => this.ringAlarm([{ key: 'test:' + Date.now(), title: 'Alarm test',
        start: moment().add(Number(this.settings.alarmLeadMinutes) || 2, 'minutes'),
        sub: 'Not a real event', spec: { slot: 'other' } }]),
    });

    this.addSettingTab(new TaskPlannerSettingTab(this.app, this));

    /* Make Bases rows draggable just-in-time. Setting `draggable` during
     * mousedown is enough - the browser reads it when the drag gesture starts,
     * which is strictly after mousedown. No polling, no MutationObserver. */
    this.registerDomEvent(document, 'mousedown', (evt) => {
      const row = evt.target && evt.target.closest && evt.target.closest(ROW_SEL);
      if (!row || row.closest(ROW_SKIP)) return;
      row.draggable = true;
    }, true);

    this.registerDomEvent(document, 'dragstart', (evt) => {
      const row = evt.target && evt.target.closest && evt.target.closest(ROW_SEL);
      if (!row || row.closest(ROW_SKIP)) return;
      const file = this.fileFromRow(row);
      if (!file) return;
      this.dragFile = file;
      const dm = this.app.dragManager;
      if (dm && dm.dragFile) dm.onDragStart(evt, dm.dragFile(evt, file, DRAG_SOURCE));
      try { evt.dataTransfer.setData('text/plain', file.path); } catch (e) { /* noop */ }
    }, true);

    this.registerDomEvent(document, 'dragend', () => { this.dragFile = null; }, true);

    /* Re-render whenever a task note's metadata changes. Debounced so a burst of
     * writes collapses into one paint. */
    this.registerEvent(this.app.metadataCache.on('changed', (f) => {
      if (this.isTaskNote(f)) this.scheduleRefresh();
    }));
    /* Alarms must work whether or not the planner view is open, so the feed is
     * loaded and refreshed by the plugin rather than by the view. */
    this.snoozed = {};
    this.pruneDismissed();
    this.app.workspace.onLayoutReady(() => { this.loadCalendars(false).then(() => this.checkAlarms()); });
    this.registerInterval(window.setInterval(() => this.checkAlarms(), 15000));
    this.registerInterval(window.setInterval(() => this.loadCalendars(false), 600000));

    this.registerEvent(this.app.vault.on('rename', () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleRefresh()));
  }

  onunload() {
    window.clearTimeout(this._refreshT);
    if (this.alarmModal) { this.alarmModal.released = true; this.alarmModal.close(); }
    if (this.alarmPlayer) this.alarmPlayer.stop();
  }

  async saveSettings() { await this.saveData(this.settings); this.refreshViews(); }

  scheduleRefresh() {
    window.clearTimeout(this._refreshT);
    this._refreshT = window.setTimeout(() => this.refreshViews(), 80);
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && leaf.view.render) leaf.view.render();
    }
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /* ---------------- task model ---------------- */
  isTaskNote(file) {
    if (!file || file.extension !== 'md') return false;
    const folder = (this.settings.taskFolder || '').replace(/\/+$/, '');
    return !folder || file.path === folder || file.path.startsWith(folder + '/');
  }

  durationFor(fm) {
    const s = this.settings;
    if (s.useEstimate) {
      const est = Number(fm[s.estimateProp]);
      if (est > 0) return est;
    }
    return Number(s.defaultDuration) || 60;
  }

  collectTasks() {
    const s = this.settings;
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.isTaskNote(f)) continue;
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      const start = parseDT(fm[s.startProp]);
      if (!start) continue;
      let end = parseDT(fm[s.endProp]);
      if (!end || !end.isAfter(start)) end = start.clone().add(this.durationFor(fm), 'minutes');
      const status = toArray(fm[s.statusProp]);
      const done = status.some((x) => x.toLowerCase() === 'done');
      if (done && !s.showDone) continue;
      out.push({
        kind: 'task',
        file: f, path: f.path, title: f.basename,
        start, end, done, status,
        category: toArray(fm[s.categoryProp])[0] || '',
      });
    }
    return out;
  }

  /* A category maps to either a named palette slot or a literal hex. */
  colorSpecFor(category) {
    if (!category) return { slot: 'other' };
    const v = this.settings.categoryColors[category];
    if (typeof v === 'string' && v.charAt(0) === '#') return { hex: v };
    if (v && PALETTE[v]) return { slot: v };
    return { slot: 'other' };
  }

  /* Categories actually present on a task note right now, with usage counts.
   * Distinct from allCategories(), which also carries retired names that only
   * survive because categoryColors still has an entry for them. */
  liveCategories() {
    const counts = new Map();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.isTaskNote(f)) continue;
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      for (const c of toArray(fm[this.settings.categoryProp])) {
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    return counts;
  }

  /* Every category currently used by a task note, plus any already configured. */
  allCategories() {
    const out = new Set(Object.keys(this.settings.categoryColors || {}));
    for (const c of this.liveCategories().keys()) out.add(c);
    return Array.from(out).sort();
  }

  /* A retired category is one no task note uses and no calendar maps onto.
   * Dropping its colour entry is what actually removes it from the UI, since
   * allCategories() seeds itself from categoryColors. Returns the reason it
   * cannot be removed, or '' when it is safe to drop. */
  categoryPinnedBy(cat) {
    const n = this.liveCategories().get(cat) || 0;
    if (n) return 'in use by ' + n + ' task note' + (n === 1 ? '' : 's');
    const cal = (this.settings.calendars || []).find((c) => c.category === cat);
    if (cal) return 'mapped to the "' + (cal.name || 'unnamed') + '" calendar';
    return '';
  }

  /* Forget a category's colour. Safe only for retired names - ensureCategoryColors()
   * re-adds anything a task note still references on the next scan. */
  async removeCategory(cat) {
    if (!(cat in (this.settings.categoryColors || {}))) return false;
    delete this.settings.categoryColors[cat];
    await this.saveData(this.settings);
    this.refreshViews();
    return true;
  }

  /* Categories with no assigned slot fold into the neutral "other" bucket
   * rather than getting a generated hue. Auto-assign fills free slots in
   * fixed order so the mapping is stable across renders. */
  ensureCategoryColors(extra) {
    /* `extra` carries categories that exist but are not in the metadata cache
     * yet - processFrontMatter resolves before the cache is repopulated, so a
     * category invented seconds ago is invisible to allCategories(). */
    const cats = new Set(this.allCategories());
    for (const c of (extra || [])) if (c) cats.add(c);
    const map = this.settings.categoryColors;
    const used = new Set(Object.values(map));
    let changed = false;
    for (const c of Array.from(cats).sort()) {
      if (map[c]) continue;
      const free = SLOT_KEYS.find((k) => !used.has(k));
      if (!free) break;
      map[c] = free; used.add(free); changed = true;
    }
    return changed;
  }

  /* ---------------- writes (frontmatter only) ---------------- */
  log(...a) { if (this.settings.debug) console.log('[task-planner]', ...a); }

  async schedule(file, dateStr, startMin, endMin) {
    const s = this.settings;

    /* processFrontMatter resolves silently when handed anything that is not a
     * real TFile, which looks exactly like a successful no-op. Reject early. */
    if (!(file instanceof TFile)) {
      new Notice('Task Planner: that drag did not resolve to a note file.', 6000);
      console.error('[task-planner] not a TFile:', file);
      return false;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
      new Notice('Task Planner: could not work out a date for that drop.', 6000);
      console.error('[task-planner] bad date:', dateStr);
      return false;
    }

    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    if (endMin === undefined || endMin === null) endMin = startMin + this.durationFor(fm);
    startMin = clampMin(startMin);
    /* Let a block run past midnight rather than truncating it - dropping a 60m
     * task at 23:30 should give 23:30-00:30, not silently halve it. Capped at
     * 24h. The renderer already splits a span across day columns. */
    endMin = Math.max(startMin + (Number(s.snapMinutes) || 15), Math.round(endMin));
    endMin = Math.min(endMin, startMin + 1440);

    const startISO = dateStr + 'T' + hhmm(startMin) + ':00';
    const dayShift = Math.floor(endMin / 1440);
    const endDay = dayShift > 0
      ? moment(dateStr, 'YYYY-MM-DD').add(dayShift, 'day').format('YYYY-MM-DD')
      : dateStr;
    const endISO = endDay + 'T' + hhmm(endMin % 1440) + ':00';

    this.log('schedule', file.path, startISO, '->', endISO);

    try {
      await this.app.fileManager.processFrontMatter(file, (f) => {
        f[s.startProp] = startISO;
        f[s.endProp] = endISO;
        if (s.autoStatus) {
          const st = toArray(f[s.statusProp]);
          const lower = st.map((x) => x.toLowerCase());
          if (!lower.includes('done')) {
            const kept = st.filter((x) => x.toLowerCase() !== 'open');
            if (!kept.some((x) => x.toLowerCase() === 'scheduled')) kept.push('scheduled');
            f[s.statusProp] = kept;
          }
        }
      });
    } catch (e) {
      new Notice('Task Planner: could not write frontmatter.\n' + file.path + '\n' + (e && e.message), 10000);
      console.error('[task-planner] processFrontMatter threw for', file.path, e);
      return false;
    }

    /* Confirm the change actually landed on disk. A silent no-op here is the
     * difference between "scheduled" and "looked like it worked". */
    try {
      const raw = await this.app.vault.read(file);
      if (raw.indexOf(startISO) === -1) {
        new Notice('Task Planner: the write did not stick for\n' + file.path
          + '\nRun "Diagnose drag and drop" and send me the note.', 12000);
        console.error('[task-planner] write verification FAILED', {
          path: file.path, expected: startISO, frontmatter: raw.slice(0, 400),
        });
        return false;
      }
    } catch (e) {
      console.error('[task-planner] could not re-read to verify', file.path, e);
    }

    /* Repaint directly rather than waiting on the metadata event, which does
     * not fire if the note somehow sits outside the task folder. */
    this.refreshViews();
    return true;
  }

  /* Build a brand new task note from the calendar, then schedule it through
   * the same path a drop uses so the frontmatter contract stays in one place. */
  sanitizeName(title) {
    let t = String(title || '').replace(/[\\/:*?"<>|#^\[\]]/g, ' ');
    t = t.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/^\.+/, '').replace(/\.+$/, '').trim();
    return t.slice(0, 120);
  }

  async uniquePath(folder, base) {
    const dir = folder ? folder + '/' : '';
    let name = base, n = 1;
    while (this.app.vault.getAbstractFileByPath(dir + name + '.md')) {
      n++;
      name = base + ' ' + n;
    }
    return dir + name + '.md';
  }

  /* Candidates for the calendar's quick-picker. An empty query lists the
   * backlog (unscheduled first) so a click doubles as "what needs a slot?".
   * Done tasks never appear - you do not schedule finished work. */
  taskCandidates() {
    const s = this.settings;
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.isTaskNote(f)) continue;
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      if (toArray(fm[s.statusProp]).some((x) => x.toLowerCase() === 'done')) continue;
      out.push({
        file: f, title: f.basename,
        category: toArray(fm[s.categoryProp])[0] || '',
        priority: Number(fm.priority) || 0,
        estimate: this.durationFor(fm),
        start: parseDT(fm[s.startProp]),
      });
    }
    return out;
  }

  /* Pure filter over a pool the caller scanned once. An empty query lists the
   * backlog (unscheduled first) so a click doubles as "what needs a slot?";
   * once there IS a query, match quality wins outright - otherwise seven loose
   * backlog matches can evict the task whose full name you just typed. */
  filterTasks(pool, query, limit) {
    const q = String(query || '').trim();
    const fuzzy = (q && typeof prepareFuzzySearch === 'function') ? prepareFuzzySearch(q) : null;
    const ql = q.toLowerCase();
    const hits = [];
    for (const c of pool) {
      let score = 0;
      if (q) {
        if (fuzzy) {
          const r = fuzzy(c.title);
          if (!r) continue;
          score = r.score;
        } else {
          const i = c.title.toLowerCase().indexOf(ql);
          if (i === -1) continue;
          score = -i - c.title.length / 100;
        }
      }
      hits.push(Object.assign({ score }, c));
    }
    hits.sort((a, b) => (q ? 0 : (a.start ? 1 : 0) - (b.start ? 1 : 0))
      || b.score - a.score
      || (a.start ? 1 : 0) - (b.start ? 1 : 0)
      || a.title.localeCompare(b.title));
    return hits.slice(0, limit || 8);
  }

  /* Snap an existing note into a slot, optionally correcting its metadata on
   * the way in. Scheduling still goes through schedule(). */
  async applyToExisting(file, opts) {
    const s = this.settings;
    const dur = Math.max(1, Math.round(opts.endMin - opts.startMin));
    try {
      await this.app.fileManager.processFrontMatter(file, (f) => {
        if (opts.category) f[s.categoryProp] = [opts.category];
        if (opts.priority) f.priority = Number(opts.priority);
        /* Only overwrite the estimate when the slot was swept by hand - a plain
         * click derives its length FROM the estimate, so rewriting it is a no-op
         * at best and a silent edit at worst. */
        if (opts.writeEstimate) f[s.estimateProp] = dur;
      });
    } catch (e) {
      new Notice('Task Planner: could not update that task.\n' + (e && e.message), 8000);
      console.error('[task-planner] frontmatter write failed for', file.path, e);
      return { file, ok: false };
    }
    if (opts.category && this.ensureCategoryColors([opts.category])) await this.saveData(this.settings);
    const ok = await this.schedule(file, opts.date, opts.startMin, opts.endMin);
    this.lastCategory = opts.category || this.lastCategory;
    this.lastPriority = opts.priority || this.lastPriority;
    return { file, ok };
  }

  async createTask(opts) {
    const s = this.settings;
    const title = this.sanitizeName(opts.title);
    if (!title) { new Notice('Task Planner: a task needs a title.'); return null; }

    const folder = (s.taskFolder || '').replace(/\/+$/, '');
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      try { await this.app.vault.createFolder(folder); } catch (e) { /* raced or exists */ }
    }

    let file;
    try {
      file = await this.app.vault.create(await this.uniquePath(folder, title), '');
    } catch (e) {
      new Notice('Task Planner: could not create the note.\n' + (e && e.message), 8000);
      console.error('[task-planner] create failed', e);
      return null;
    }

    const dur = Math.max(1, Math.round(opts.endMin - opts.startMin));
    try {
      await this.app.fileManager.processFrontMatter(file, (f) => {
        if (opts.category) f[s.categoryProp] = [opts.category];
        if (opts.priority) f.priority = Number(opts.priority);
        f[s.estimateProp] = dur;
        f[s.statusProp] = ['open'];
      });
    } catch (e) {
      console.error('[task-planner] frontmatter write failed for new task', e);
    }

    /* A category invented in the modal has no palette slot yet, so its block
     * would paint neutral grey until the view is reopened. */
    if (opts.category && this.ensureCategoryColors([opts.category])) await this.saveData(this.settings);

    const ok = await this.schedule(file, opts.date, opts.startMin, opts.endMin);
    this.lastCategory = opts.category || this.lastCategory;
    this.lastPriority = opts.priority || this.lastPriority;
    this.refreshViews();
    return { file, ok };
  }

  async unschedule(file) {
    const s = this.settings;
    await this.app.fileManager.processFrontMatter(file, (f) => {
      f[s.startProp] = null;
      f[s.endProp] = null;
      if (s.autoStatus) {
        const st = toArray(f[s.statusProp]).filter((x) => x.toLowerCase() !== 'scheduled');
        if (!st.length) st.push('open');
        f[s.statusProp] = st;
      }
    });
  }

  async setDone(file, done) {
    const s = this.settings;
    await this.app.fileManager.processFrontMatter(file, (f) => {
      let st = toArray(f[s.statusProp]);
      if (done) {
        st = st.filter((x) => !['open', 'scheduled'].includes(x.toLowerCase()));
        if (!st.some((x) => x.toLowerCase() === 'done')) st.push('done');
        f[s.completedProp] = moment().format('YYYY-MM-DD');
      } else {
        st = st.filter((x) => x.toLowerCase() !== 'done');
        if (!st.length) st.push(parseDT(f[s.startProp]) ? 'scheduled' : 'open');
        f[s.completedProp] = null;
      }
      f[s.statusProp] = st;
    });
  }

  /* Reuse the Checkbox Sounds plugin so ticking a block feels identical to
   * ticking a markdown checkbox - same sound, same confetti, same settings.
   * That plugin only watches `data-task` attribute mutations, so our badge
   * can never trigger it on its own. */
  celebrate(anchorEl) {
    const cs = this.app.plugins && this.app.plugins.plugins
      && this.app.plugins.plugins['checkbox-sounds'];
    if (!cs || !anchorEl) return;
    try {
      const cfg = cs.settings || {};
      if (cfg.soundSetting) cs.playSound(cfg.soundSetting);
      if (cfg.enableAnimation) cs.showAnimation(anchorEl);
    } catch (e) {
      if (this.settings.debug) console.warn('[task-planner] celebrate failed', e);
    }
  }

  /* Last-resort resolution from a dataTransfer payload: a raw path, a wikilink,
   * a markdown link, or a bare basename. */
  resolveText(txt) {
    let t = String(txt || '').trim();
    const wl = /^!?\[\[([^\]|#]+)/.exec(t);
    if (wl) t = wl[1].trim();
    const md = /\]\(([^)]+)\)/.exec(t);
    if (md) t = decodeURIComponent(md[1]);
    const q = /[?&]file=([^&]+)/.exec(t);
    if (q) t = decodeURIComponent(q[1]);
    t = t.trim();
    if (!t) return null;
    const direct = this.app.vault.getAbstractFileByPath(t) || this.app.vault.getAbstractFileByPath(t + '.md');
    if (direct && direct.extension) return direct;
    const dest = this.app.metadataCache.getFirstLinkpathDest(t, '');
    if (dest) return dest;
    const lc = t.toLowerCase().replace(/\.md$/, '');
    const files = this.app.vault.getMarkdownFiles();
    return files.find((f) => f.basename.toLowerCase() === lc && this.isTaskNote(f))
        || files.find((f) => f.basename.toLowerCase() === lc)
        || null;
  }

  fileFromRow(row) {
    const link = row.querySelector('[data-href], a.internal-link');
    if (link) {
      const href = link.getAttribute('data-href') || link.getAttribute('href') || link.textContent;
      const f = this.app.metadataCache.getFirstLinkpathDest((href || '').trim(), '');
      if (f) return f;
    }
    const cell = row.querySelector('.bases-td, .bases-cell, td');
    const name = ((cell && cell.innerText) || '').trim().split('\n')[0].trim();
    if (!name) return null;
    const direct = this.app.metadataCache.getFirstLinkpathDest(name, '');
    if (direct) return direct;
    const lc = name.toLowerCase();
    const files = this.app.vault.getMarkdownFiles();
    return files.find((f) => f.basename.toLowerCase() === lc && this.isTaskNote(f))
        || files.find((f) => f.basename.toLowerCase() === lc)
        || null;
  }

  /* Reports what the DOM actually looks like, so a drag failure can be pinned
   * on a concrete cause instead of guessed at. */
  async diagnose() {
    const L = ['# Task Planner - drag diagnostics', '', 'Taken: ' + moment().format('YYYY-MM-DD HH:mm'), ''];

    L.push('## Bases rows on screen');
    const sels = ROW_SEL.split(',').map((x) => x.trim());
    let matched = null;
    for (const sel of sels) {
      const n = document.querySelectorAll(sel).length;
      if (n && !matched) matched = sel;
      L.push('- `' + sel + '` -> ' + n);
    }
    if (!matched) {
      L.push('', '**No row matched any selector.** If a Base IS open in this window, Bases has changed its markup - inspect a row and send me its class name.');
    } else {
      const row = document.querySelector(matched);
      const f = this.fileFromRow(row);
      L.push('', '- matched selector: `' + matched + '`');
      L.push('- first row classes: `' + row.className + '`');
      L.push('- first row draggable: ' + row.draggable);
      L.push('- resolves to file: ' + (f ? '`' + f.path + '`' : '**FAILED - row -> note resolution is the problem**'));
    }

    L.push('', '## Drag manager');
    const dm = this.app.dragManager;
    L.push('- app.dragManager: ' + (dm ? 'present' : '**MISSING**'));
    L.push('- dragManager.dragFile(): ' + (dm && typeof dm.dragFile === 'function' ? 'present' : '**MISSING**'));

    L.push('', '## Planner view');
    L.push('- columns rendered: ' + document.querySelectorAll('.tp-col').length);
    L.push('- blocks rendered: ' + document.querySelectorAll('.tp-block').length);
    const b = document.querySelector('.tp-block');
    if (!b) L.push('- **no blocks on screen** - open the planner first, on a day that has scheduled tasks');
    else {
      const cs = getComputedStyle(b);
      L.push('- block height: ' + Math.round(b.getBoundingClientRect().height) + 'px');
      L.push('- block pointer-events: ' + cs.pointerEvents + (cs.pointerEvents === 'none' ? '  **<- blocks cannot be grabbed**' : ''));
      L.push('- block touch-action: ' + cs.touchAction);
      L.push('- block draggable: ' + b.draggable);
      L.push('- resize handles: ' + b.querySelectorAll('.tp-handle').length);
      let anc = b.parentElement, dragAnc = null;
      while (anc && anc !== document.body) { if (anc.draggable) { dragAnc = anc; break; } anc = anc.parentElement; }
      L.push('- draggable ancestor: ' + (dragAnc ? '**YES, `' + dragAnc.className + '` - a native drag here cancels pointer gestures**' : 'none'));
    }

    L.push('', '## Plugins competing for these events');
    for (const id of ['day-planner-drop', 'dragger', 'obsidian-day-planner', 'google-calendar', 'bracket-to-checkbox']) {
      L.push('- ' + id + ': ' + (this.app.plugins.plugins[id] ? '**ENABLED**' : 'off'));
    }

    /* Vault API rather than the adapter: it is cached, serialised against other
     * writes, and keeps the metadata cache in step. */
    const path = 'task-planner-diagnostics.md';
    const body = L.join('\n');
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.create(path, body);
    new Notice('Wrote ' + path);
  }

  /* ---------------- alarms ---------------- */
  alarmKey(kind, id, start) { return kind + ':' + id + ':' + start.format('YYYYMMDDTHHmm'); }

  alarmCandidates() {
    const s = this.settings;
    const out = [];
    if (s.alarmForEvents) {
      for (const e of ((this.gcache && this.gcache.events) || [])) {
        if (e.allDay) continue;
        out.push({ key: this.alarmKey('cal', e.calId, e.start), title: e.title,
                   start: e.start, sub: e.calName, spec: this.calColorSpec(e.calId) });
      }
    }
    if (s.alarmForTasks) {
      for (const t of this.collectTasks()) {
        if (t.done) continue;
        out.push({ key: this.alarmKey('task', t.path, t.start), title: t.title,
                   start: t.start, sub: t.category, spec: this.colorSpecFor(t.category) });
      }
    }
    return out;
  }

  checkAlarms() {
    const s = this.settings;
    if (!s.alarmsEnabled || this.alarmModal) return;
    const now = moment();
    const leadSec = Math.max(0, Number(s.alarmLeadMinutes) || 0) * 60;
    const dismissed = new Set(s.dismissedAlarms || []);
    this.snoozed = this.snoozed || {};
    const due = [];
    for (const c of this.alarmCandidates()) {
      const diff = c.start.diff(now, 'seconds');
      if (diff > leadSec) continue;                 /* still in the future */
      if (diff < -300) continue;                    /* long past; do not ambush */
      if (dismissed.has(c.key)) continue;
      const until = this.snoozed[c.key];
      if (until && now.isBefore(until)) continue;
      due.push(c);
    }
    if (due.length) this.ringAlarm(due);
  }

  ringAlarm(items) {
    if (this.alarmModal) return;
    this.log('alarm firing:', items.map((i) => i.title).join(', '));
    this.alarmPlayer = this.alarmPlayer || new AlarmPlayer(this);
    this.alarmPlayer.start();
    this.alarmModal = new AlarmModal(this.app, this, items);
    this.alarmModal.open();
    if (this.settings.alarmSystemNotification) this.systemNotify(items);
  }

  systemNotify(items) {
    try {
      if (typeof Notification === 'undefined') return;
      const fire = () => new Notification(
        items.length === 1 ? items[0].title : items.length + ' events starting soon',
        { body: items.map((i) => i.start.format('h:mm a') + '  ' + i.title).join('\n'), silent: true });
      if (Notification.permission === 'granted') fire();
      else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((perm) => { if (perm === 'granted') fire(); });
      }
    } catch (e) { /* a nicety, never fatal */ }
  }

  async dismissAlarm(items) {
    const s = this.settings;
    s.dismissedAlarms = (s.dismissedAlarms || []).concat(items.map((i) => i.key));
    this.pruneDismissed();
    await this.saveData(s);
  }

  snoozeAlarm(items, minutes) {
    this.snoozed = this.snoozed || {};
    const until = moment().add(Math.max(1, Number(minutes) || 1), 'minutes');
    for (const i of items) this.snoozed[i.key] = until;
  }

  alarmClosed() {
    if (this.alarmPlayer) this.alarmPlayer.stop();
    this.alarmModal = null;
  }

  /* A dismissal only matters until its event is well past, so old keys are
   * dropped rather than accumulating in data.json forever. */
  pruneDismissed() {
    const cutoff = moment().subtract(2, 'days');
    this.settings.dismissedAlarms = (this.settings.dismissedAlarms || []).filter((k) => {
      const m = /:(\d{8}T\d{4})$/.exec(String(k));
      if (!m) return false;
      const t = moment(m[1], 'YYYYMMDDTHHmm', true);
      return t.isValid() && t.isAfter(cutoff);
    });
  }

  /* ---------------- Calendars (read-only ICS overlay) ----------------
   * Standalone: each configured URL is fetched directly with requestUrl, which
   * is not subject to browser CORS, then parsed locally. No companion plugin. */
  async fetchICS(url) {
    const u = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
    if (!/^https?:\/\//i.test(u)) throw new Error('URL must start with http(s):// or webcal://');
    const res = await requestUrl({ url: u, method: 'GET' });
    const text = res.text || '';
    if (text.indexOf('BEGIN:VCALENDAR') === -1) throw new Error('That URL did not return an iCalendar feed');
    return text;
  }

  async loadCalendars(force) {
    const s = this.settings;
    this.calErrors = this.calErrors || {};
    if (!s.showCalendars) { this.gcache = { at: Date.now(), events: [] }; return this.gcache; }
    const now = Date.now();
    if (!force && this.gcache && now - this.gcache.at < 300000) return this.gcache;

    /* One generous window, so paging around the planner never refetches. */
    const from = moment().startOf('day').subtract(60, 'days');
    const to = moment().startOf('day').add(180, 'days');

    const events = [];
    for (const cal of s.calendars || []) {
      if (!cal.enabled || !cal.url) continue;
      try {
        const text = await this.fetchICS(cal.url);
        const parsed = parseICS(text, from, to);
        for (const e of parsed) {
          e.calId = cal.id;
          e.calName = cal.name || 'Calendar';
          events.push(e);
        }
        delete this.calErrors[cal.id];
        this.log('calendar', cal.name, parsed.length, 'events');
      } catch (err) {
        this.calErrors[cal.id] = String((err && err.message) || err);
        console.error('[task-planner] calendar failed:', cal.name, err);
      }
    }
    this.gcache = { at: now, events };
    return this.gcache;
  }

  calById(id) { return (this.settings.calendars || []).find((c) => c.id === id) || null; }

  /* A calendar linked to a category inherits that category's colour. */
  calColorSpec(calId) {
    const cal = this.calById(calId);
    if (!cal) return { slot: 'other' };
    if (cal.category) return this.colorSpecFor(cal.category);
    if (cal.color) return { hex: cal.color };
    return { slot: 'other' };
  }
}

/* ============================================================ ICS parsing
 * A working subset of RFC 5545: VEVENT with DTSTART/DTEND, all-day dates,
 * UTC and floating times, RRULE expansion (DAILY/WEEKLY/MONTHLY/YEARLY with
 * INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY), EXDATE, and RECURRENCE-ID overrides.
 *
 * TZID is honoured via Intl's IANA database: a wall time in the event's own
 * zone is converted to a real instant, and recurrences are expanded in that
 * zone's wall clock so a series does not drift when the two zones observe DST
 * differently (e.g. America/Phoenix invites viewed from America/Denver).
 */
const WEEKDAY_NUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_OCCURRENCES = 400;

function unfoldICS(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function icsUnescape(v) {
  return String(v || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\');
}

/* "DTSTART;TZID=America/Denver:20260812T090000" -> name, params, value */
function splitICSLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const bits = left.split(';');
  const name = bits[0].toUpperCase();
  const params = {};
  for (let i = 1; i < bits.length; i++) {
    const eq = bits[i].indexOf('=');
    if (eq > 0) params[bits[i].slice(0, eq).toUpperCase()] = bits[i].slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/* ---- IANA timezone support, via Intl. A "wall moment" is a moment whose
 * calendar fields spell out a clock reading in some zone; its own UTC offset
 * is meaningless and must never be read. -------------------------------- */
const _tzFmtCache = new Map();
function tzFormatter(tz) {
  if (_tzFmtCache.has(tz)) return _tzFmtCache.get(tz);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    f.format(new Date(0));
  } catch (e) { f = null; }
  _tzFmtCache.set(tz, f);
  return f;
}

/* Clock reading in `tz` at instant `ms`, encoded as a UTC timestamp. */
function tzWallMs(tz, ms) {
  const f = tzFormatter(tz);
  if (!f) return null;
  const p = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  if (!p.year) return null;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second));
}

/* Inverse: the instant at which `tz` reads `wallMs`. Two passes settle the
 * offset, so times either side of a DST shift land correctly; a reading inside
 * a spring-forward gap resolves to the instant just after the jump. */
function tzMsFromWall(tz, wallMs) {
  const first = tzWallMs(tz, wallMs);
  if (first === null) return null;
  let t = wallMs - (first - wallMs);
  const second = tzWallMs(tz, t);
  if (second !== null && second !== wallMs) t += wallMs - second;
  return t;
}

function momentFieldsToWallMs(m) {
  return Date.UTC(m.year(), m.month(), m.date(), m.hours(), m.minutes(), m.seconds());
}

/* Wall moment in `tz` -> real local moment. No tz means floating: leave it. */
function wallToLocal(m, tz) {
  if (!m) return null;
  if (!tz || !tzFormatter(tz)) return m.clone();
  const t = tzMsFromWall(tz, momentFieldsToWallMs(m));
  return t === null ? m.clone() : moment(t);
}

/* Real moment -> wall moment in `tz`, for comparing against wall occurrences. */
function localToWall(m, tz) {
  if (!m) return null;
  if (!tz || !tzFormatter(tz)) return m.clone();
  const w = tzWallMs(tz, m.valueOf());
  if (w === null) return m.clone();
  const d = new Date(w);
  return moment([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]);
}

/* Returns { m, allDay, tz, floating }. `floating` marks a clock reading with
 * no offset of its own - either a real floating time, or a wall time in `tz`.
 * When floating is false, `m` is an absolute instant already in local time. */
function parseICSDate(value, params) {
  const v = String(value || '').trim();
  if (!v) return null;
  const tz = (params && params.TZID) ? String(params.TZID) : null;
  if ((params && params.VALUE === 'DATE') || /^\d{8}$/.test(v)) {
    const m = moment(v, 'YYYYMMDD', true);
    return m.isValid() ? { m, allDay: true, tz: null, floating: true } : null;
  }
  if (/Z$/.test(v)) {
    const m = moment.utc(v, 'YYYYMMDDTHHmmss[Z]', true);
    return m.isValid() ? { m: m.local(), allDay: false, tz: null, floating: false } : null;
  }
  const m = moment(v, 'YYYYMMDDTHHmmss', true);
  return m.isValid() ? { m, allDay: false, tz, floating: true } : null;
}

/* Re-express any parsed date as a wall moment in `tz`, so EXDATE,
 * RECURRENCE-ID and UNTIL can be keyed against expanded occurrences. */
function toWall(d, tz) {
  if (!d) return null;
  return d.floating ? d.m.clone() : localToWall(d.m, tz);
}

function parseRRule(str) {
  const out = {};
  for (const part of String(str || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

/* Nth weekday of a month, e.g. "2TU" = 2nd Tuesday, "-1FR" = last Friday. */
function nthWeekdayOfMonth(monthStart, ord, dow) {
  if (ord > 0) {
    const first = monthStart.clone().date(1);
    const shift = (dow - first.day() + 7) % 7;
    const d = first.add(shift + (ord - 1) * 7, 'days');
    return d.month() === monthStart.month() ? d : null;
  }
  const last = monthStart.clone().endOf('month').startOf('day');
  const back = (last.day() - dow + 7) % 7;
  const d = last.subtract(back + (Math.abs(ord) - 1) * 7, 'days');
  return d.month() === monthStart.month() ? d : null;
}

/* Occurrence start times within [from, to]. Occurrences before `from` still
 * count toward COUNT, so a capped series does not over-generate. */
/* `start` is a wall moment in `tz` (or floating when tz is null); `from`/`to`
 * are real local bounds. Expansion happens entirely in wall space - that is
 * what keeps "every Monday at 09:00 Phoenix" fixed to 09:00 Phoenix - and the
 * window is translated into that space to match. */
function expandRRule(start, rule, from, to, tz) {
  const freq = String(rule.FREQ || '').toUpperCase();
  if (!freq) return [start.clone()];
  from = localToWall(from, tz);
  to = localToWall(to, tz);
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const untilParsed = rule.UNTIL ? parseICSDate(rule.UNTIL, {}) : null;
  const until = untilParsed ? toWall(untilParsed, tz) : null;
  const byDay = rule.BYDAY ? String(rule.BYDAY).split(',').map((x) => x.trim()).filter(Boolean) : null;
  const byMonthDay = rule.BYMONTHDAY ? String(rule.BYMONTHDAY).split(',').map(Number).filter((n) => !isNaN(n)) : null;

  const hh = start.hours(), mm = start.minutes(), ss = start.seconds();
  const at = (d) => d.clone().hours(hh).minutes(mm).seconds(ss).milliseconds(0);

  const out = [];
  let emitted = 0;
  let cursor = start.clone().startOf('day');
  let guard = 0;

  /* An open-ended series that began years ago would otherwise burn the whole
   * iteration guard walking from DTSTART to the visible window and emit
   * nothing. With no COUNT to honour, jump straight to the window (backing off
   * one interval so a straddling occurrence is not skipped). */
  if (count === null && cursor.isBefore(from, 'day')) {
    const unit = freq === 'DAILY' ? 'days' : freq === 'WEEKLY' ? 'weeks'
      : freq === 'MONTHLY' ? 'months' : freq === 'YEARLY' ? 'years' : null;
    if (unit) {
      const base = (freq === 'WEEKLY' && byDay && byDay.length) ? cursor.clone().startOf('week') : cursor.clone();
      const elapsed = from.clone().startOf('day').diff(base, unit);
      const steps = Math.max(0, Math.floor(elapsed / interval) - 1);
      if (steps > 0) cursor = base.add(steps * interval, unit);
    }
  }

  const push = (d) => {
    if (!d) return true;
    const occ = at(d);
    if (until && occ.isAfter(until)) return false;
    if (count !== null && emitted >= count) return false;
    emitted++;
    if (!occ.isBefore(from) && !occ.isAfter(to)) out.push(occ);
    return !occ.isAfter(to);
  };

  while (guard++ < MAX_OCCURRENCES * 4) {
    if (count !== null && emitted >= count) break;
    if (out.length >= MAX_OCCURRENCES) break;

    let keepGoing = true;
    if (freq === 'DAILY') {
      keepGoing = push(cursor);
      cursor = cursor.add(interval, 'days');
    } else if (freq === 'WEEKLY') {
      if (byDay && byDay.length) {
        const weekStart = cursor.clone().startOf('week');
        for (const token of byDay) {
          const dow = WEEKDAY_NUM[token.slice(-2).toUpperCase()];
          if (dow === undefined) continue;
          const d = weekStart.clone().add(dow, 'days');
          if (d.isBefore(start, 'day')) continue;
          if (!push(d)) { keepGoing = false; break; }
        }
        cursor = weekStart.add(interval, 'weeks');
      } else {
        keepGoing = push(cursor);
        cursor = cursor.add(interval, 'weeks');
      }
    } else if (freq === 'MONTHLY') {
      const monthStart = cursor.clone().startOf('month');
      if (byDay && byDay.length) {
        for (const token of byDay) {
          const mt = /^(-?\d+)?([A-Z]{2})$/i.exec(token.trim());
          if (!mt) continue;
          const dow = WEEKDAY_NUM[mt[2].toUpperCase()];
          if (dow === undefined) continue;
          const d = nthWeekdayOfMonth(monthStart, Number(mt[1] || 1), dow);
          if (!d || d.isBefore(start, 'day')) continue;
          if (!push(d)) { keepGoing = false; break; }
        }
      } else {
        const days = byMonthDay && byMonthDay.length ? byMonthDay : [start.date()];
        for (const dayNum of days) {
          const d = dayNum > 0
            ? monthStart.clone().date(Math.min(dayNum, monthStart.daysInMonth()))
            : monthStart.clone().endOf('month').startOf('day').subtract(Math.abs(dayNum) - 1, 'days');
          if (d.isBefore(start, 'day')) continue;
          if (!push(d)) { keepGoing = false; break; }
        }
      }
      cursor = monthStart.add(interval, 'months');
    } else if (freq === 'YEARLY') {
      const d = cursor.clone().month(start.month()).date(start.date());
      if (!d.isBefore(start, 'day')) keepGoing = push(d);
      cursor = cursor.add(interval, 'years').startOf('year');
    } else {
      out.push(at(start));
      break;
    }
    if (!keepGoing) break;
    if (cursor.isAfter(to) && (count === null)) break;
  }
  return out;
}

/* Parse a calendar into concrete events between `from` and `to`. */
function parseICS(text, from, to) {
  const lines = unfoldICS(text).split('\n');
  const raw = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) { cur = { exdates: [] }; continue; }
    if (line.startsWith('END:VEVENT')) { if (cur) raw.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = splitICSLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.title = icsUnescape(p.value); break;
      case 'LOCATION': cur.location = icsUnescape(p.value); break;
      case 'STATUS': cur.status = p.value; break;
      case 'RRULE': cur.rrule = parseRRule(p.value); break;
      case 'DTSTART': { const d = parseICSDate(p.value, p.params); if (d) { cur.start = d.m; cur.allDay = d.allDay; cur.tz = d.tz; } break; }
      case 'DTEND': { const d = parseICSDate(p.value, p.params); if (d) cur.end = d.m; break; }
      case 'DURATION': cur.duration = p.value; break;
      case 'RECURRENCE-ID': { const d = parseICSDate(p.value, p.params); if (d) cur.recurrenceId = d; break; }
      case 'EXDATE': {
        for (const piece of String(p.value).split(',')) {
          const d = parseICSDate(piece, p.params);
          if (d) cur.exdates.push(d);
        }
        break;
      }
      default: break;
    }
  }

  /* A VEVENT carrying RECURRENCE-ID replaces one occurrence of its series.
   * The override is keyed in the series' own wall clock, which the override
   * VEVENT restates via its own TZID. */
  const overrides = new Set();
  for (const e of raw) {
    if (!e.recurrenceId || !e.uid) continue;
    const w = toWall(e.recurrenceId, e.recurrenceId.tz || e.tz || null);
    overrides.add(e.uid + '@' + w.format('YYYYMMDDTHHmmss'));
  }

  const out = [];
  for (const e of raw) {
    if (!e.start || e.status === 'CANCELLED' || !e.title) continue;
    const tz = e.allDay ? null : (e.tz || null);
    /* Both ends are wall times in the same zone, so the difference is the
     * duration without needing conversion first. */
    const durMin = e.end && e.end.isAfter(e.start)
      ? e.end.diff(e.start, 'minutes')
      : (e.allDay ? 1440 : 60);

    const exdates = e.exdates.map((d) => toWall(d, tz).format('YYYYMMDDTHHmmss'));
    const series = !!(e.rrule && !e.recurrenceId);
    const wallStarts = series
      ? expandRRule(e.start, e.rrule, from, to, tz)
      : [e.start.clone()];

    for (const wst of wallStarts) {
      const key = wst.format('YYYYMMDDTHHmmss');
      if (exdates.indexOf(key) !== -1) continue;
      /* Only a generated occurrence yields to an override. Testing this on the
       * override VEVENT itself made it suppress itself whenever it kept its
       * original start time. */
      if (series && e.uid && overrides.has(e.uid + '@' + key)) continue;
      const st = wallToLocal(wst, tz);
      /* expandRRule already clipped the series to the window. */
      if (!series && (st.isAfter(to) || !st.clone().add(durMin, 'minutes').isAfter(from))) continue;
      out.push({
        kind: 'gcal',
        allDay: !!e.allDay,
        title: e.title,
        start: st,
        end: st.clone().add(durMin, 'minutes'),
        location: e.location || '',
      });
    }
  }
  return out;
}

/* MenuItem.setSubmenu is not available in every Obsidian build. */
let _submenuOk = null;
function hasSubmenu(menu) {
  if (_submenuOk !== null) return _submenuOk;
  try {
    let ok = false;
    menu.addItem((i) => { ok = typeof i.setSubmenu === 'function'; i.setTitle(''); });
    if (menu.items && menu.items.length) menu.items.pop();
    _submenuOk = ok;
  } catch (e) { _submenuOk = false; }
  return _submenuOk;
}

/* ============================================================ alarm
 * A repeating two-tone chirp built with Web Audio, so there is no bundled
 * asset to ship or lose. An optional vault audio file overrides it. The sound
 * restarts on a timer and only stops when the alarm is explicitly dismissed.
 */
class AlarmPlayer {
  constructor(plugin) { this.plugin = plugin; this.timer = null; this.ctx = null; this.audio = null; }

  start() {
    if (this.timer || this.audio) return;
    const s = this.plugin.settings;
    const vol = Math.max(0, Math.min(1, Number(s.alarmVolume) || 0.5));

    if (s.alarmSoundFile) {
      try {
        const url = this.plugin.app.vault.adapter.getResourcePath(s.alarmSoundFile);
        const el = new Audio(url);
        el.loop = true;
        el.volume = vol;
        el.play().catch((e) => { console.error('[task-planner] alarm file failed, using tone', e); this.audio = null; this.startTone(vol); });
        this.audio = el;
        return;
      } catch (e) {
        console.error('[task-planner] alarm file unavailable, using tone', e);
      }
    }
    this.startTone(vol);
  }

  startTone(vol) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const pattern = () => {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        this.beep(t + 0.00, 880, 0.16, vol);
        this.beep(t + 0.22, 1175, 0.16, vol);
        this.beep(t + 0.44, 880, 0.16, vol);
      };
      pattern();
      this.timer = window.setInterval(pattern, 1400);
    } catch (e) {
      console.error('[task-planner] could not start alarm tone', e);
    }
  }

  beep(at, freq, dur, vol) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    /* Ramp the edges so it reads as a chime rather than a click. */
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), at + 0.02);
    gain.gain.setValueAtTime(Math.max(0.0002, vol), at + dur - 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  stop() {
    if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
    if (this.audio) { try { this.audio.pause(); } catch (e) {} this.audio = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
  }
}

/* The modal reopens itself if closed by Escape or a click outside, so the only
 * way out is an explicit Dismiss or Snooze. */
class AlarmModal extends Modal {
  constructor(app, plugin, items) {
    super(app);
    this.plugin = plugin;
    this.items = items;
    this.released = false;
    this.reopens = 0;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('tp-alarm-modal');
    contentEl.empty();

    const head = contentEl.createDiv('tp-alarm-head');
    const bell = head.createDiv('tp-alarm-bell');
    setIcon(bell, 'bell-ring');
    head.createDiv('tp-alarm-heading').setText(
      this.items.length === 1 ? 'Starting soon' : this.items.length + ' starting soon');

    for (const it of this.items) {
      const row = contentEl.createDiv('tp-alarm-row');
      applyColor(row, it.spec || { slot: 'other' });
      row.createDiv('tp-alarm-accent');
      const body = row.createDiv('tp-alarm-body');
      body.createDiv('tp-alarm-title').setText(it.title);
      const mins = it.start.diff(moment(), 'minutes');
      const when = mins <= 0 ? 'now' : 'in ' + mins + ' min';
      body.createDiv('tp-alarm-meta').setText(
        it.start.format('h:mm a') + ' · ' + when + (it.sub ? ' · ' + it.sub : ''));
    }

    const btns = contentEl.createDiv('tp-alarm-buttons');
    const snooze = (m) => {
      btns.createEl('button', { text: 'Snooze ' + m + ' min' }).onclick = () => this.release('snooze', m);
    };
    snooze(1);
    snooze(5);
    const stop = btns.createEl('button', { cls: 'mod-cta', text: 'Stop alarm' });
    stop.onclick = () => this.release('dismiss');
    window.setTimeout(() => stop.focus(), 30);
  }

  release(how, minutes) {
    this.released = true;
    if (how === 'snooze') this.plugin.snoozeAlarm(this.items, minutes);
    else this.plugin.dismissAlarm(this.items);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    /* Escape or a click on the background must not silence it. */
    if (!this.released && this.reopens < 50) {
      this.reopens++;
      window.setTimeout(() => { if (!this.released) this.open(); }, 60);
      return;
    }
    this.plugin.alarmClosed();
  }
}

class NewTaskModal extends Modal {
  /* slot = { date, startMin, endMin, swept }. `swept` means the user dragged an
   * explicit range; a plain click did not, so an existing task gets to keep its
   * own estimate as the length. */
  constructor(app, plugin, slot, onDone) {
    super(app);
    this.plugin = plugin;
    this.slot = slot;
    this.onDone = onDone;
    this.submitted = false;
    this.taskTitle = '';
    this.category = plugin.lastCategory || '';
    this.priority = String(plugin.lastPriority || 3);
    this.newCategory = '';
    this.picked = null;      // TFile when an existing task is snapped in
    this.pool = [];
    this.results = [];
    this.sel = -1;
  }

  /* The slot actually written. A picked task on an unswept slot is sized by its
   * own estimate, so clicking 09:00 and choosing a 30 min task gives 09:00-09:30. */
  effectiveSlot() {
    const s = this.slot;
    let end = s.endMin;
    if (this.picked && !s.swept && this.pickedDur) end = s.startMin + this.pickedDur;
    /* schedule() enforces a minimum of one snap slot; mirror it so the header
     * and the success toast cannot advertise a range that was never written. */
    const floor = Number(this.plugin.settings.snapMinutes) || 15;
    end = Math.max(s.startMin + floor, end);
    return { date: s.date, startMin: s.startMin, endMin: end };
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    const p = this.plugin;
    modalEl.addClass('tp-new-modal');
    contentEl.empty();

    this.headEl = contentEl.createDiv('tp-new-head');
    this.whenEl = contentEl.createDiv('tp-new-when');

    const titleSetting = new Setting(contentEl).setName('Task').addText((t) => {
      this.titleInput = t.inputEl;
      t.setPlaceholder('Search tasks, or type a new title…');
      t.inputEl.addClass('tp-new-title');
    });
    titleSetting.settingEl.addClass('tp-new-title-row');
    /* In normal flow rather than absolutely positioned: a floating list can be
     * clipped by themes that put overflow on .modal, and the modal is short
     * enough that growing it is no hardship. */
    this.suggEl = contentEl.createDiv('tp-sugg');
    this.suggEl.hide();

    this.titleInput.addEventListener('input', () => {
      this.taskTitle = this.titleInput.value;
      if (this.picked && this.taskTitle !== this.picked.basename) this.unpick();
      this.refreshSuggestions();
    });
    this.titleInput.addEventListener('keydown', (evt) => this.onTitleKey(evt));
    this.titleInput.addEventListener('focus', () => this.refreshSuggestions());

    const cats = p.allCategories().filter(Boolean);
    new Setting(contentEl).setName('Category').addDropdown((d) => {
      this.catDrop = d;
      d.addOption('', '(none)');
      for (const c of cats) d.addOption(c, c);
      d.addOption('__new__', '+ New category…');
      d.setValue(cats.includes(this.category) ? this.category : '');
      this.category = d.getValue();
      d.onChange((v) => {
        this.category = v;
        if (this.customSetting) this.customSetting.settingEl.toggle(v === '__new__');
        if (v === '__new__' && this.customEl) this.customEl.inputEl.focus();
      });
    });
    this.customSetting = new Setting(contentEl).setName('New category name').addText((t) => {
      this.customEl = t;
      t.setPlaceholder('e.g. Deep work').onChange((v) => { this.newCategory = v; });
    });
    this.customSetting.settingEl.toggle(this.category === '__new__');

    new Setting(contentEl).setName('Priority').addDropdown((d) => {
      this.prioDrop = d;
      d.addOption('', '(unset)');
      d.addOption('1', '1 · highest');
      d.addOption('2', '2 · high');
      d.addOption('3', '3 · normal');
      d.addOption('4', '4 · low');
      d.addOption('5', '5 · lowest');
      d.setValue(this.priority);
      d.onChange((v) => { this.priority = v; });
    });

    const btns = contentEl.createDiv('tp-new-buttons');
    btns.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    this.openBtn = btns.createEl('button', { text: 'Create & open' });
    this.openBtn.onclick = () => this.submit(true);
    this.submitBtn = btns.createEl('button', { cls: 'mod-cta', text: 'Create' });
    this.submitBtn.onclick = () => this.submit(false);

    /* Enter commits - unless the suggestion list has the keyboard, in which case
     * its own handler already consumed the key. */
    this.scope.register([], 'Enter', (evt) => {
      /* Only yield to the list when it actually has a highlighted row - with
       * nothing selected (the default after every keystroke) Enter commits. */
      if (this.suggOpen() && this.sel >= 0) return;
      if (evt.target && evt.target.tagName === 'BUTTON') return;
      evt.preventDefault();
      this.submit(false);
      return false;
    });

    this.syncChrome();
    window.setTimeout(() => { if (this.titleInput) this.titleInput.focus(); }, 20);
    this.refreshSuggestions();
  }

  /* ---------------- header + button labels ---------------- */
  syncChrome() {
    const eff = this.effectiveSlot();
    const dur = eff.endMin - eff.startMin;
    this.headEl.setText(this.picked ? 'Schedule task' : 'New task');
    this.whenEl.setText(
      moment(eff.date, 'YYYY-MM-DD').format('ddd, MMM D') + '  ·  '
      + hhmm(eff.startMin) + '–' + hhmmEnd(eff.endMin) + '  ·  '
      + (dur >= 60 && dur % 60 === 0 ? (dur / 60) + ' h' : dur + ' min'));
    this.submitBtn.setText(this.picked ? 'Schedule' : 'Create');
    this.openBtn.setText(this.picked ? 'Schedule & open' : 'Create & open');
    this.modalEl.toggleClass('is-picked', !!this.picked);
  }

  /* ---------------- suggestions ---------------- */
  suggOpen() { return this.suggEl && this.suggEl.isShown() && this.results.length > 0; }

  refreshSuggestions() {
    if (this.picked) { this.closeSuggestions(); return; }
    const q = this.titleInput ? this.titleInput.value : '';
    if (!this.pool.length) this.pool = this.plugin.taskCandidates();
    this.results = this.plugin.filterTasks(this.pool, q, 7);
    this.sel = -1;
    this.renderSuggestions(q);
  }

  renderSuggestions(q) {
    const el = this.suggEl;
    el.empty();
    if (!this.results.length) { el.hide(); return; }
    el.show();
    this.results.forEach((r, i) => {
      const item = el.createDiv('tp-sugg-item');
      item.dataset.i = String(i);
      const dot = item.createDiv('tp-sugg-dot');
      applyColor(dot, this.plugin.colorSpecFor(r.category));
      const main = item.createDiv('tp-sugg-main');
      main.createDiv('tp-sugg-title').setText(r.title);
      const bits = [];
      if (r.category) bits.push(r.category);
      if (r.priority) bits.push('P' + r.priority);
      bits.push(r.estimate + 'm');
      bits.push(r.start ? r.start.format('ddd D, HH:mm') : 'unscheduled');
      main.createDiv('tp-sugg-meta').setText(bits.join('  ·  '));
      /* mousedown, not click: the input must not lose focus first. */
      item.addEventListener('mousedown', (evt) => { evt.preventDefault(); this.pick(r); });
      item.addEventListener('mouseenter', () => this.highlight(i));
    });
    if (q && q.trim()) {
      const mk = el.createDiv('tp-sugg-new');
      mk.setText('Create “' + q.trim() + '” as a new task');
      mk.addEventListener('mousedown', (evt) => {
        evt.preventDefault();
        this.closeSuggestions();
        this.submit(false);
      });
    }
  }

  closeSuggestions() {
    this.results = [];
    this.sel = -1;
    if (this.suggEl) { this.suggEl.empty(); this.suggEl.hide(); }
  }

  highlight(i) {
    this.sel = i;
    const items = this.suggEl.querySelectorAll('.tp-sugg-item');
    items.forEach((el, n) => el.toggleClass('is-active', n === i));
    if (i >= 0 && items[i]) items[i].scrollIntoView({ block: 'nearest' });
  }

  onTitleKey(evt) {
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      if (!this.results.length) { this.refreshSuggestions(); if (!this.results.length) return; }
      this.suggEl.show();
      evt.preventDefault();
      const n = this.results.length;
      const next = evt.key === 'ArrowDown'
        ? (this.sel + 1) % n
        : (this.sel <= 0 ? n - 1 : this.sel - 1);
      this.highlight(next);
      return;
    }
    if (evt.key === 'Enter' && this.suggOpen() && this.sel >= 0) {
      evt.preventDefault();
      evt.stopPropagation();
      this.pick(this.results[this.sel]);
      return;
    }
    if (evt.key === 'Escape' && this.suggOpen()) {
      /* First Escape dismisses the list, second one closes the modal. */
      evt.preventDefault();
      evt.stopPropagation();
      this.closeSuggestions();
    }
  }

  pick(r) {
    this.picked = r.file;
    this.pickedDur = r.estimate;
    this.taskTitle = r.title;
    this.titleInput.value = r.title;
    /* Mirror the picked note EXACTLY, empties included. Leaving a field at the
     * modal's carried-over default would stamp the last task's category or
     * priority onto this one the moment we write. */
    if (this.catDrop) {
      const cat = r.category || '';
      const opts = Array.from(this.catDrop.selectEl.options).map((o) => o.value);
      if (cat && !opts.includes(cat)) this.catDrop.addOption(cat, cat);
      this.catDrop.setValue(cat);
      this.category = cat;
    }
    if (this.prioDrop) {
      this.priority = (r.priority >= 1 && r.priority <= 5) ? String(r.priority) : '';
      this.prioDrop.setValue(this.priority);
    }
    if (this.customSetting) this.customSetting.settingEl.toggle(this.category === '__new__');
    this.closeSuggestions();
    this.syncChrome();
    window.setTimeout(() => this.submitBtn && this.submitBtn.focus(), 10);
  }

  unpick() {
    this.picked = null;
    this.pickedDur = 0;
    this.syncChrome();
  }

  resolvedCategory() {
    if (this.category === '__new__') return this.newCategory.trim();
    return this.category;
  }

  async submit(open) {
    if (this.submitted) return;
    const eff = this.effectiveSlot();
    const common = {
      category: this.resolvedCategory(),
      priority: Number(this.priority) || 0,
      date: eff.date,
      startMin: eff.startMin,
      endMin: eff.endMin,
    };

    let res;
    if (this.picked) {
      this.submitted = true;
      this.close();
      res = await this.plugin.applyToExisting(this.picked, Object.assign({ writeEstimate: !!this.slot.swept }, common));
    } else {
      const title = (this.taskTitle || '').trim();
      if (!title) { new Notice('Give the task a title first.'); return; }
      if (!this.plugin.sanitizeName(title)) {
        new Notice('That title is all characters a filename cannot hold.');
        return;
      }
      this.submitted = true;
      this.close();
      res = await this.plugin.createTask(Object.assign({ title: title }, common));
    }

    if (!res || !res.file) return;
    /* schedule() raises its own Notice when a write does not stick - do not
     * paper over it with a success toast. */
    if (res.ok) {
      new Notice(res.file.basename + '\n' + moment(eff.date, 'YYYY-MM-DD').format('ddd, MMM D')
        + '  ' + hhmm(eff.startMin) + '–' + hhmmEnd(eff.endMin), 3000);
    }
    if (open) this.app.workspace.openLinkText(res.file.path, '', false);
    if (this.onDone) this.onDone(res.file);
  }

  onClose() { this.contentEl.empty(); }
}

/* ================================================================== view */
class CalendarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.focus = moment().startOf('day');
    this.drag = null;
    this._move = this._onPointerMove.bind(this);
    this._up = this._onPointerUp.bind(this);
    this.create = null;
    this._cmove = this._onCreateMove.bind(this);
    this._cup = this._onCreateUp.bind(this);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Task Planner'; }
  getIcon() { return 'calendar-clock'; }

  async onOpen() {
    const host = this.containerEl.children[1];
    host.empty();
    host.addClass('tp-host');
    this.root = host.createDiv('tp-root');
    this.buildToolbar();
    this.scroll = this.root.createDiv('tp-scroll');
    this.grid = this.scroll.createDiv('tp-grid');

    if (this.plugin.ensureCategoryColors()) await this.plugin.saveData(this.plugin.settings);

    const cap = { capture: true };
    this.registerDomEvent(this.grid, 'dragover', this.onDragOver.bind(this), cap);
    this.registerDomEvent(this.grid, 'dragleave', this.onDragLeave.bind(this), cap);
    this.registerDomEvent(this.grid, 'drop', this.onDrop.bind(this), cap);
    this.registerDomEvent(this.grid, 'pointerdown', this.onPointerDown.bind(this), cap);
    this.registerDomEvent(this.grid, 'contextmenu', this.onContextMenu.bind(this));
    /* A native drag starting mid-gesture (some plugins mark arbitrary blocks
     * draggable) fires pointercancel and silently kills pointermove. Treat it
     * as an abort so the view never gets stuck in a half-drag. */
    this.registerDomEvent(this.grid, 'pointercancel', () => { this.abortDrag(); this.abortCreate(); });

    this.registerInterval(window.setInterval(() => this.paintNow(), 60000));

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => {
        if (this._fitting) return;
        this._fitting = true;
        const changed = this.applyFit();
        this._fitting = false;
        if (changed) this.render();
      });
      this._ro.observe(this.scroll);
      this.register(() => { if (this._ro) { this._ro.disconnect(); this._ro = null; } });
    }

    this.render();
    /* The first pass has no header to measure, so fit once more now that it exists. */
    window.setTimeout(() => { if (this.applyFit()) this.render(); }, 0);
    this.plugin.loadCalendars(false).then(() => this.render());
    window.setTimeout(() => this.scrollToNow(), 60);
  }

  async onClose() {
    window.clearTimeout(this._saveT);
    this.clearDropLine();
    window.removeEventListener('pointermove', this._move);
    window.removeEventListener('pointerup', this._up);
    this.abortCreate();
    document.body.removeClass('tp-is-dragging');
    this.drag = null;
  }

  /* ---------------- chrome ---------------- */
  buildToolbar() {
    const bar = this.root.createDiv('tp-toolbar');
    const nav = bar.createDiv('tp-group');
    const mk = (parent, cls, label, tip, fn) => {
      const b = parent.createEl('button', { cls: cls, text: label });
      if (tip) b.setAttribute('aria-label', tip);
      b.onclick = fn;
      return b;
    };
    mk(nav, 'tp-btn', '‹', 'Previous', () => this.shift(-1));
    mk(nav, 'tp-btn', 'Today', 'Jump to today', () => { this.focus = moment().startOf('day'); this.render(); this.scrollToNow(); });
    mk(nav, 'tp-btn', '›', 'Next', () => this.shift(1));

    this.rangeEl = bar.createDiv('tp-range');
    bar.createDiv('tp-spacer');

    const modeGroup = bar.createDiv('tp-group tp-modes');
    this.modeBtns = {};
    for (const m of VIEW_MODES) {
      this.modeBtns[m.key] = mk(modeGroup, 'tp-btn tp-btn-sm', m.label, m.label + ' view', async () => {
        this.plugin.settings.viewMode = m.key;
        await this.plugin.saveData(this.plugin.settings);
        this.render();
      });
    }

    const zoom = bar.createDiv('tp-group');
    mk(zoom, 'tp-btn tp-btn-sm', '−', 'Zoom out', () => this.zoom(-10));
    this.fitBtn = mk(zoom, 'tp-btn tp-btn-fit', '', 'Fit the whole day to the window', () => this.toggleFit());
    mk(zoom, 'tp-btn tp-btn-sm', '+', 'Zoom in', () => this.zoom(10));

    mk(bar.createDiv('tp-group'), 'tp-btn tp-btn-sm', '⟳', 'Refresh calendars', async () => {
      await this.plugin.loadCalendars(true);
      this.render();
      new Notice('Calendars refreshed');
    });
  }

  shift(dir) {
    const m = modeOf(this.plugin.settings.viewMode);
    this.focus = this.focus.clone().add(dir * m.step, 'days');
    this.render();
  }

  async zoom(delta) {
    const s = this.plugin.settings;
    s.fitToWindow = false;
    s.pxPerHour = Math.max(8, Math.min(200, s.pxPerHour + delta));
    await this.plugin.saveData(s);
    this.render();
  }

  async toggleFit() {
    const s = this.plugin.settings;
    s.fitToWindow = !s.fitToWindow;
    this.applyFit();
    await this.plugin.saveData(s);
    this.render();
  }

  /* Size an hour so startHour..endHour exactly fills the pane below the header.
   * Returns true when pxPerHour actually changed, so callers know to repaint.
   * The 1px deadband stops a render -> resize -> render feedback loop. */
  applyFit() {
    const s = this.plugin.settings;
    if (!s.fitToWindow || !this.scroll) return false;
    const head = this.grid && this.grid.querySelector('.tp-head');
    const headH = head ? head.getBoundingClientRect().height : 0;
    const avail = this.scroll.clientHeight - headH;
    const hours = Math.max(1, s.endHour - s.startHour + 1);
    const next = Math.floor(avail / hours);
    if (!isFinite(next) || next < 4) return false;
    if (Math.abs(next - s.pxPerHour) < 1) return false;
    s.pxPerHour = next;
    this.queueSave();
    return true;
  }

  queueSave() {
    window.clearTimeout(this._saveT);
    this._saveT = window.setTimeout(() => this.plugin.saveData(this.plugin.settings), 600);
  }

  scrollToNow() {
    if (!this.scroll || this.plugin.settings.fitToWindow) return;
    const s = this.plugin.settings;
    const nowMin = minOfDay(moment());
    const y = ((nowMin - s.startHour * 60) / 60) * s.pxPerHour;
    this.scroll.scrollTop = Math.max(0, y - this.scroll.clientHeight / 3);
  }

  days() {
    const s = this.plugin.settings;
    const m = modeOf(s.viewMode);
    const start = m.weekAligned ? startOfWeek(this.focus, s.firstDayOfWeek) : this.focus.clone();
    const out = [];
    for (let i = 0; i < m.cols; i++) out.push(start.clone().add(i, 'days'));
    return out;
  }

  /* Clip an item to the visible hour window of a given day. */
  segmentFor(item, day, s) {
    const winS = s.startHour * 60;
    const winE = s.endHour * 60 + 60;
    const dayStart = day.clone().startOf('day');
    const dayEnd = dayStart.clone().add(1, 'day');
    if (!item.start.isBefore(dayEnd) || !item.end.isAfter(dayStart)) return null;
    let a = item.start.isBefore(dayStart) ? 0 : minOfDay(item.start);
    let b = item.end.isAfter(dayEnd) ? 1440 : (minOfDay(item.end) || (item.end.isSame(dayEnd) ? 1440 : 0));
    if (b <= a) b = a + 15;
    const s2 = Math.max(a, winS);
    const e2 = Math.min(b, winE);
    if (e2 <= s2) return null;
    return { s: s2, e: e2, clippedTop: a < winS, clippedBottom: b > winE, realStart: a, realEnd: b };
  }

  /* ---------------- render ---------------- */
  render() {
    if (!this.grid) return;
    const p = this.plugin, s = p.settings;
    const days = this.days();
    const hours = Math.max(1, s.endHour - s.startHour + 1);

    if (!this._fitting) {
      this._fitting = true;
      this.applyFit();
      this._fitting = false;
    }
    if (this.fitBtn) this.fitBtn.toggleClass('is-active', !!s.fitToWindow);

    this.grid.empty();
    this.grid.style.setProperty('--tp-cols', String(days.length));
    this.grid.style.setProperty('--tp-hour-h', s.pxPerHour + 'px');
    this.grid.style.setProperty('--tp-body-h', hours * s.pxPerHour + 'px');

    const first = days[0], last = days[days.length - 1];
    this.rangeEl.setText(
      days.length === 1
        ? first.format('dddd, MMM D YYYY')
        : first.format('MMM D') + ' – ' + last.format(first.month() === last.month() ? 'D, YYYY' : 'MMM D, YYYY')
    );
    for (const m of VIEW_MODES) this.modeBtns[m.key].toggleClass('is-active', s.viewMode === m.key);

    const gEvents = p.settings.showCalendars ? ((p.gcache && p.gcache.events) || []) : [];
    const tasks = p.collectTasks();
    const todayKey = dayKey(moment());

    /* row 1: corner + header cells */
    this.grid.createDiv('tp-corner');
    for (const d of days) {
      const head = this.grid.createDiv('tp-head');
      if (dayKey(d) === todayKey) head.addClass('is-today');
      head.createDiv('tp-head-dow').setText(d.format('ddd'));
      head.createDiv('tp-head-num').setText(d.format('D'));
      const allDay = gEvents.filter((e) => e.allDay && this.segmentFor({ start: e.start, end: e.end }, d, { startHour: 0, endHour: 23 }));
      if (allDay.length) {
        const strip = head.createDiv('tp-allday');
        for (const e of allDay.slice(0, 3)) {
          const chip = strip.createDiv('tp-allday-chip');
          chip.setText(e.title);
          chip.setAttribute('aria-label', e.title + ' · ' + e.calName);
          applyColor(chip, p.calColorSpec(e.calId));
        }
        if (allDay.length > 3) strip.createDiv('tp-allday-more').setText('+' + (allDay.length - 3));
      }
    }

    /* row 2: ruler + day columns */
    const ruler = this.grid.createDiv('tp-ruler');
    for (let h = s.startHour; h <= s.endHour; h++) {
      const cell = ruler.createDiv('tp-ruler-h');
      cell.createSpan('tp-ruler-label').setText(moment({ hour: h }).format('h A'));
    }

    this.cols = [];
    for (const d of days) {
      const col = this.grid.createDiv('tp-col');
      col.dataset.date = dayKey(d);
      if (dayKey(d) === todayKey) col.addClass('is-today');
      const lines = col.createDiv('tp-lines');
      for (let h = s.startHour; h <= s.endHour; h++) lines.createDiv('tp-hline');
      this.cols.push(col);

      /* Tasks and calendar events share one layer and one packing pass, so
       * they split width against each other instead of stacking. */
      const layer = col.createDiv('tp-layer');
      const segs = [];
      for (const e of gEvents) {
        if (e.allDay) continue;
        const seg = this.segmentFor(e, d, s);
        if (seg) segs.push(Object.assign({ item: e, kind: 'gcal' }, seg));
      }
      for (const t of tasks) {
        const seg = this.segmentFor(t, d, s);
        if (seg) segs.push(Object.assign({ item: t, kind: 'task' }, seg));
      }
      packLanes(segs);
      for (const seg of segs) {
        if (seg.kind === 'gcal') this.paintGoogle(layer, seg, s);
        else this.paintTask(layer, seg, s, d);
      }
    }

    this.paintNow();
  }

  geom(seg, s) {
    const pxPerMin = s.pxPerHour / 60;
    const top = (seg.s - s.startHour * 60) * pxPerMin;
    const height = Math.max(14, (seg.e - seg.s) * pxPerMin);
    const lanes = seg.lanes || 1;
    const lane = seg.lane || 0;
    const span = seg.span || 1;
    const w = 100 / lanes;
    const hasNeighbourRight = lane + span < lanes;
    const width = w * (span + (hasNeighbourRight ? OVERHANG : 0));
    return { top, height, left: lane * w, width, z: 10 + lane };
  }

  paintGoogle(layer, seg, s) {
    const g = this.geom(seg, s);
    const ev = seg.item;
    const el = layer.createDiv('tp-block tp-block-cal');
    applyColor(el, this.plugin.calColorSpec(ev.calId));
    el.style.top = g.top + 'px';
    el.style.height = g.height + 'px';
    el.style.left = 'calc(' + g.left + '%)';
    el.style.width = 'calc(' + g.width + '% - 3px)';
    el.style.zIndex = String(g.z);
    if (seg.clippedTop) el.addClass('is-clipped-top');
    if (seg.clippedBottom) el.addClass('is-clipped-bottom');

    el.createDiv('tp-block-accent');
    const body = el.createDiv('tp-block-body');
    /* Identity comes from an icon, not from being washed out. */
    if (g.height >= 18) {
      if (g.height < 26) el.addClass('is-compact');
      const badge = body.createDiv('tp-badge tp-badge-cal');
      setIcon(badge, 'calendar');
      badge.setAttribute('aria-label', 'From ' + (ev.calName || 'calendar'));
    }

    const text = body.createDiv('tp-block-text');
    text.createDiv('tp-block-title').setText(ev.title);
    if (g.height >= 34) {
      const meta = text.createDiv('tp-block-meta');
      meta.createSpan('tp-block-time').setText(ev.start.format('h:mm') + '–' + ev.end.format('h:mm a'));
      if (ev.calName) meta.createSpan('tp-block-cat').setText(ev.calName);
    }
    el.setAttribute('aria-label', ev.title + '\n'
      + ev.start.format('ddd h:mm a') + ' – ' + ev.end.format('h:mm a')
      + '\n' + (ev.calName || 'Calendar') + (ev.location ? '\n' + ev.location : ''));
  }

  paintTask(layer, seg, s, day) {
    const p = this.plugin;
    const g = this.geom(seg, s);
    const t = seg.item;
    const el = layer.createDiv('tp-block');
    el.draggable = false;
    applyColor(el, p.colorSpecFor(t.category));
    el.dataset.path = t.path;
    el.dataset.date = dayKey(day);
    el.style.top = g.top + 'px';
    el.style.height = g.height + 'px';
    el.style.left = 'calc(' + g.left + '%)';
    el.style.width = 'calc(' + g.width + '% - 3px)';
    el.style.zIndex = String(g.z);
    if (t.done) el.addClass('is-done');
    if (seg.clippedTop) el.addClass('is-clipped-top');
    if (seg.clippedBottom) el.addClass('is-clipped-bottom');

    el.createDiv('tp-block-accent');
    const body = el.createDiv('tp-block-body');
    if (g.height >= 18) {
      if (g.height < 26) el.addClass('is-compact');
      const check = body.createDiv('tp-badge tp-check');
      if (t.done) check.addClass('is-done');
      check.setAttribute('aria-label', t.done ? 'Mark not done' : 'Mark done');
    }

    const text = body.createDiv('tp-block-text');
    text.createDiv('tp-block-title').setText(t.title);
    if (g.height >= 34) {
      const meta = text.createDiv('tp-block-meta');
      meta.createSpan('tp-block-time').setText(t.start.format('h:mm') + '–' + t.end.format('h:mm a'));
      if (t.category) meta.createSpan('tp-block-cat').setText(t.category);
    }

    /* Resize handles only on the segment that actually owns the edge, and only
     * when the block is tall enough to still leave a grabbable middle. */
    if (g.height >= 20) {
      const hh = Math.max(3, Math.min(6, Math.floor(g.height / 5)));
      if (!seg.clippedTop) el.createDiv('tp-handle tp-handle-top').style.height = hh + 'px';
      if (!seg.clippedBottom) el.createDiv('tp-handle tp-handle-bottom').style.height = hh + 'px';
    }

    el.setAttribute('aria-label',
      t.title + '\n' + t.start.format('ddd h:mm a') + ' – ' + t.end.format('h:mm a')
      + (t.category ? '\n' + t.category : ''));
  }

  paintNow() {
    if (!this.cols) return;
    const s = this.plugin.settings;
    const now = moment();
    const key = dayKey(now);
    const mins = minOfDay(now);
    for (const col of this.cols) {
      const old = col.querySelector('.tp-now');
      if (old) old.remove();
      if (col.dataset.date !== key) continue;
      if (mins < s.startHour * 60 || mins > s.endHour * 60 + 60) continue;
      const line = col.createDiv('tp-now');
      line.style.top = ((mins - s.startHour * 60) * (s.pxPerHour / 60)) + 'px';
    }
  }

  /* ---------------- geometry helpers ---------------- */
  minsAt(col, clientY, mode) {
    return this.minsAtRect(col.getBoundingClientRect(), clientY, mode);
  }

  /* Rect-based twin: a gesture snapshots the column rect at pointerdown, so a
   * re-render mid-sweep cannot silently swap in a detached (all-zero) rect. */
  minsAtRect(rect, clientY, mode) {
    const s = this.plugin.settings;
    const raw = s.startHour * 60 + ((clientY - rect.top) / s.pxPerHour) * 60;
    const snap = Math.max(1, s.snapMinutes);
    const snapped = (mode === 'floor' ? Math.floor(raw / snap) : Math.round(raw / snap)) * snap;
    return Math.max(0, Math.min(1440 - snap, snapped));
  }

  /* ---------------- drop from a Base ---------------- */
  resolveDraggedFile(evt) {
    const dm = this.app.dragManager;
    const d = dm && dm.draggable;
    const isFile = (x) => x instanceof TFile;
    if (d) {
      if (isFile(d.file)) return d.file;
      if (d.files && d.files.length && isFile(d.files[0])) return d.files[0];
    }
    if (isFile(this.plugin.dragFile)) return this.plugin.dragFile;
    try {
      const dt = evt.dataTransfer;
      if (dt && typeof dt.getData === 'function') {
        const txt = dt.getData('text/plain');
        if (txt) return this.plugin.resolveText(txt);
      }
    } catch (e) { /* dataTransfer payloads are protected during dragover */ }
    return null;
  }

  onDragOver(evt) {
    const col = evt.target && evt.target.closest && evt.target.closest('.tp-col');
    if (!col) { this.clearDropLine(); return; }
    const dm = this.app.dragManager;
    const file = this.resolveDraggedFile(evt);
    if (!file || !file.path || !file.path.endsWith('.md')) return;

    evt.preventDefault();
    evt.stopPropagation();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'copy';

    const s = this.plugin.settings;
    const startMin = this.minsAt(col, evt.clientY);
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    const dur = this.plugin.durationFor(fm);
    this.showDropLine(col, startMin, dur, file.basename, this.plugin.colorSpecFor(toArray(fm[s.categoryProp])[0] || ''));
    if (dm && dm.setAction) {
      dm.setAction('Schedule ' + moment(col.dataset.date, 'YYYY-MM-DD').format('ddd D') + ' at ' + hhmm(startMin));
    }
  }

  onDragLeave(evt) {
    if (!evt.relatedTarget || !this.grid.contains(evt.relatedTarget)) this.clearDropLine();
  }

  async onDrop(evt) {
    const col = evt.target && evt.target.closest && evt.target.closest('.tp-col');
    this.clearDropLine();
    if (!col) return;
    evt.preventDefault();
    evt.stopPropagation();

    const file = this.resolveDraggedFile(evt);
    this.plugin.log('drop ->', file && file.path, 'col', col.dataset.date);
    if (!file || !file.path || !file.path.endsWith('.md')) {
      new Notice('Task Planner: could not tell which note that was.\nRun "Diagnose drag and drop".', 8000);
      console.error('[task-planner] drop resolved to', file);
      return;
    }

    const startMin = this.minsAt(col, evt.clientY);
    const date = col.dataset.date;
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    const dur = this.plugin.durationFor(fm);
    const okWrite = await this.plugin.schedule(file, date, startMin, startMin + dur);
    this.plugin.dragFile = null;
    if (okWrite) {
      new Notice(file.basename + '\n' + moment(date, 'YYYY-MM-DD').format('ddd, MMM D')
        + '  ' + hhmm(startMin) + '–' + hhmm(startMin + dur), 3000);
    }
  }

  showDropLine(col, startMin, dur, label, colorSpec) {
    this.clearDropLine();
    const s = this.plugin.settings;
    const pxPerMin = s.pxPerHour / 60;
    const ghost = col.createDiv('tp-ghost tp-ghost-drop');
    applyColor(ghost, colorSpec);
    ghost.style.top = ((startMin - s.startHour * 60) * pxPerMin) + 'px';
    ghost.style.height = Math.max(16, dur * pxPerMin) + 'px';
    ghost.createDiv('tp-ghost-title').setText(label);
    ghost.createDiv('tp-ghost-time').setText(hhmm(startMin) + '–' + hhmm(startMin + dur));
    this.dropLine = ghost;
  }

  clearDropLine() {
    if (this.dropLine) { this.dropLine.remove(); this.dropLine = null; }
  }

  /* ---------------- move / resize ---------------- */
  onPointerDown(evt) {
    if (evt.button !== 0) return;
    const el = evt.target && evt.target.closest && evt.target.closest('.tp-block');
    /* Empty grid space is the "new task" surface: click for a default-length
     * block, drag to sweep out an exact one. Calendar events stay read-only,
     * so a press on one is simply swallowed. */
    if (!el) { this.onCreateDown(evt); return; }
    if (el.hasClass('tp-block-cal')) return;
    const file = this.app.vault.getAbstractFileByPath(el.dataset.path);
    if (!file) return;

    /* The tick circle is a button, not a drag handle. */
    if (evt.target.closest('.tp-check')) {
      evt.preventDefault();
      evt.stopPropagation();
      const wasDone = el.hasClass('is-done');
      const badge = evt.target.closest('.tp-check') || el;
      this.plugin.setDone(file, !wasDone).then(() => {
        if (!wasDone) this.plugin.celebrate(badge);
      }).catch((e) => {
        new Notice('Task Planner: could not update status\n' + (e && e.message));
      });
      return;
    }

    const s = this.plugin.settings;
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    const start = parseDT(fm[s.startProp]);
    if (!start) return;
    let end = parseDT(fm[s.endProp]);
    if (!end || !end.isAfter(start)) end = start.clone().add(this.plugin.durationFor(fm), 'minutes');

    const mode = evt.target.closest('.tp-handle-top') ? 'resize-start'
      : evt.target.closest('.tp-handle-bottom') ? 'resize-end' : 'move';

    this.drag = {
      el, file, mode,
      x0: evt.clientX, y0: evt.clientY,
      startMin: minOfDay(start),
      durMin: Math.max(5, end.diff(start, 'minutes')),
      baseDate: dayKey(start),
      moved: false,
      result: null,
      cols: this.cols.map((c) => ({ date: c.dataset.date, el: c, rect: c.getBoundingClientRect() })),
    };

    evt.preventDefault();
    evt.stopPropagation();
    window.addEventListener('pointermove', this._move);
    window.addEventListener('pointerup', this._up);
  }

  abortDrag() {
    const d = this.drag;
    this.drag = null;
    window.removeEventListener('pointermove', this._move);
    window.removeEventListener('pointerup', this._up);
    document.body.removeClass('tp-is-dragging');
    if (d) {
      if (d.ghost) d.ghost.remove();
      if (d.el) d.el.removeClass('is-source');
    }
  }

  _onPointerMove(evt) {
    const d = this.drag;
    if (!d) return;
    const dx = evt.clientX - d.x0, dy = evt.clientY - d.y0;
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      document.body.addClass('tp-is-dragging');
      d.el.addClass('is-source');
    }

    const s = this.plugin.settings;
    const snap = Math.max(1, s.snapMinutes);
    const delta = Math.round((dy / s.pxPerHour * 60) / snap) * snap;

    let startMin = d.startMin;
    let endMin = d.startMin + d.durMin;
    let date = d.baseDate;

    if (d.mode === 'move') {
      startMin = Math.max(0, Math.min(1440 - d.durMin, d.startMin + delta));
      endMin = startMin + d.durMin;
      const hit = d.cols.find((c) => evt.clientX >= c.rect.left && evt.clientX < c.rect.right);
      if (hit) date = hit.date;
    } else if (d.mode === 'resize-end') {
      endMin = Math.max(startMin + snap, Math.min(1440, endMin + delta));
    } else {
      startMin = Math.min(endMin - snap, Math.max(0, startMin + delta));
    }

    d.result = { date, startMin, endMin };
    this.showMoveGhost(d);
  }

  showMoveGhost(d) {
    const s = this.plugin.settings;
    const pxPerMin = s.pxPerHour / 60;
    const col = d.cols.find((c) => c.date === d.result.date);
    if (!col) return;
    if (!d.ghost) {
      d.ghost = document.createElement('div');
      d.ghost.className = 'tp-ghost tp-ghost-move';
      d.ghost.dataset.color = d.el.dataset.color || 'other';
      const inlineHex = d.el.style.getPropertyValue('--tp-c');
      if (inlineHex) d.ghost.style.setProperty('--tp-c', inlineHex);
      d.ghostTitle = d.ghost.createDiv('tp-ghost-title');
      d.ghostTime = d.ghost.createDiv('tp-ghost-time');
      d.ghostTitle.setText(d.el.querySelector('.tp-block-title').textContent);
    }
    if (d.ghost.parentElement !== col.el) col.el.appendChild(d.ghost);
    d.ghost.style.top = ((d.result.startMin - s.startHour * 60) * pxPerMin) + 'px';
    d.ghost.style.height = Math.max(16, (d.result.endMin - d.result.startMin) * pxPerMin) + 'px';
    const dur = d.result.endMin - d.result.startMin;
    d.ghostTime.setText(hhmm(d.result.startMin) + '–' + hhmm(d.result.endMin) + '  ·  ' + dur + 'm');
  }

  async _onPointerUp(evt) {
    const d = this.drag;
    this.drag = null;
    window.removeEventListener('pointermove', this._move);
    window.removeEventListener('pointerup', this._up);
    if (!d) return;
    document.body.removeClass('tp-is-dragging');
    if (d.ghost) d.ghost.remove();
    if (d.el) d.el.removeClass('is-source');

    if (!d.moved) {
      const newTab = evt.ctrlKey || evt.metaKey || evt.button === 1;
      this.app.workspace.openLinkText(d.file.path, '', newTab);
      return;
    }
    if (!d.result) return;
    await this.plugin.schedule(d.file, d.result.date, d.result.startMin, d.result.endMin);
  }

  /* ---------------- create by click / sweep ---------------- */
  onCreateDown(evt) {
    const col = evt.target && evt.target.closest && evt.target.closest('.tp-col');
    if (!col) return;
    /* A press that is only dismissing an open context menu must not also arm a
     * new task - Obsidian closes the menu but does not swallow the event. */
    if (document.querySelector('.menu')) return;
    this.abortCreate();
    const rect = col.getBoundingClientRect();
    /* Floor the anchor: pressing anywhere inside the 09:00 slot means 09:00,
     * never 09:30. The moving edge rounds, so a sweep tracks the cursor. */
    this.create = {
      col, rect, date: col.dataset.date,
      x0: evt.clientX, y0: evt.clientY,
      anchor: this.minsAtRect(rect, evt.clientY, 'floor'),
      moved: false, ghost: null, result: null,
    };
    /* preventDefault kills the default focus action, so claim the leaf by hand. */
    this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
    evt.preventDefault();
    window.addEventListener('pointermove', this._cmove);
    window.addEventListener('pointerup', this._cup);
  }

  abortCreate() {
    const c = this.create;
    this.create = null;
    window.removeEventListener('pointermove', this._cmove);
    window.removeEventListener('pointerup', this._cup);
    if (c && c.ghost) c.ghost.remove();
    document.body.removeClass('tp-is-creating');
  }

  _onCreateMove(evt) {
    const c = this.create;
    if (!c) return;
    const s = this.plugin.settings;
    const snap = Math.max(1, s.snapMinutes);
    /* A sweep authorises overwriting an existing task's estimate, so the
     * threshold has to mean "asserted a duration", not "twitched". Half a snap
     * slot; below that the whole gesture stays a plain click, ghost included. */
    if (!c.moved && Math.abs(evt.clientY - c.y0) < Math.max(4, (snap * (s.pxPerHour / 60)) / 2)) return;
    if (!c.moved) {
      c.moved = true;
      document.body.addClass('tp-is-creating');
    }
    const cur = this.minsAtRect(c.rect, evt.clientY);
    let a = Math.min(c.anchor, cur), b = Math.max(c.anchor, cur);
    if (b - a < snap) { a = c.anchor; b = a + snap; }   /* upward drags collapse to the anchor slot */
    c.result = { startMin: a, endMin: Math.min(1440, b) };
    this.showCreateGhost(c);
  }

  showCreateGhost(c) {
    const s = this.plugin.settings;
    const pxPerMin = s.pxPerHour / 60;
    /* render() empties the grid, which detaches both the column and the ghost.
     * Re-resolve the live column by date and rebuild rather than painting into
     * an orphaned node. */
    const live = (this.cols || []).find((x) => x.dataset.date === c.date);
    if (live && live !== c.col) c.col = live;
    if (c.ghost && c.ghost.parentElement !== c.col) { c.ghost.remove(); c.ghost = null; }
    if (!c.col || !c.col.isConnected) return;
    if (!c.ghost) {
      c.ghost = c.col.createDiv('tp-ghost tp-ghost-create');
      c.ghostTitle = c.ghost.createDiv('tp-ghost-title');
      c.ghostTitle.setText('New task');
      c.ghostTime = c.ghost.createDiv('tp-ghost-time');
    }
    const dur = c.result.endMin - c.result.startMin;
    c.ghost.style.top = ((c.result.startMin - s.startHour * 60) * pxPerMin) + 'px';
    c.ghost.style.height = Math.max(16, dur * pxPerMin) + 'px';
    c.ghostTime.setText(hhmm(c.result.startMin) + '–' + hhmmEnd(c.result.endMin) + '  ·  ' + dur + 'm');
  }

  _onCreateUp() {
    const c = this.create;
    this.create = null;
    window.removeEventListener('pointermove', this._cmove);
    window.removeEventListener('pointerup', this._cup);
    if (!c) return;
    document.body.removeClass('tp-is-creating');
    if (c.ghost) c.ghost.remove();

    const s = this.plugin.settings;
    const slot = c.moved && c.result
      ? { date: c.date, startMin: c.result.startMin, endMin: c.result.endMin, swept: true }
      : { date: c.date, startMin: c.anchor, endMin: c.anchor + (Number(s.defaultDuration) || 60), swept: false };
    new NewTaskModal(this.app, this.plugin, slot).open();
  }

  /* ---------------- context menu ---------------- */
  onContextMenu(evt) {
    const el = evt.target && evt.target.closest && evt.target.closest('.tp-block');
    if (!el || el.hasClass('tp-block-cal')) return;   // calendar events are read-only
    const file = this.app.vault.getAbstractFileByPath(el.dataset.path);
    if (!file) return;
    evt.preventDefault();

    const p = this.plugin;
    const s = p.settings;
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    const start = parseDT(fm[s.startProp]);
    const done = toArray(fm[s.statusProp]).some((x) => x.toLowerCase() === 'done');

    const menu = new Menu();
    menu.addItem((i) => i.setTitle('Open note').setIcon('file-text')
      .onClick(() => this.app.workspace.openLinkText(file.path, '', false)));
    menu.addItem((i) => i.setTitle('Open in new tab').setIcon('plus-square')
      .onClick(() => this.app.workspace.openLinkText(file.path, '', true)));
    menu.addSeparator();

    menu.addItem((i) => i.setTitle(done ? 'Mark not done' : 'Mark done').setIcon(done ? 'rotate-ccw' : 'check')
      .onClick(async () => {
        await p.setDone(file, !done);
        if (!done) p.celebrate(el.querySelector('.tp-check') || el);
      }));

    const setDur = (m) => async () => {
      if (!start) return;
      await p.schedule(file, dayKey(start), minOfDay(start), minOfDay(start) + m);
    };
    const DURS = [15, 30, 45, 60, 90, 120, 180];
    const durLabel = (m) => (m >= 60 ? (m / 60) + ' h' : m + ' min');
    if (hasSubmenu(menu)) {
      menu.addItem((i) => {
        i.setTitle('Duration').setIcon('clock');
        const sub = i.setSubmenu();
        for (const m of DURS) sub.addItem((x) => x.setTitle(durLabel(m)).onClick(setDur(m)));
      });
    } else {
      for (const m of DURS) {
        menu.addItem((i) => i.setTitle('Duration: ' + durLabel(m)).setIcon('clock').onClick(setDur(m)));
      }
    }

    const moveBy = (n) => async () => {
      if (!start) return;
      const nd = start.clone().add(n, 'days');
      const end = parseDT(fm[s.endProp]);
      const dur = end && end.isAfter(start) ? end.diff(start, 'minutes') : p.durationFor(fm);
      await p.schedule(file, dayKey(nd), minOfDay(start), minOfDay(start) + dur);
    };
    const MOVES = [['Tomorrow', 1], ['In 2 days', 2], ['Next week', 7], ['Yesterday', -1]];
    if (hasSubmenu(menu)) {
      menu.addItem((i) => {
        i.setTitle('Move to').setIcon('calendar');
        const sub = i.setSubmenu();
        for (const [label, n] of MOVES) sub.addItem((x) => x.setTitle(label).onClick(moveBy(n)));
      });
    } else {
      for (const [label, n] of MOVES) {
        menu.addItem((i) => i.setTitle('Move to ' + label.toLowerCase()).setIcon('calendar').onClick(moveBy(n)));
      }
    }

    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Unschedule').setIcon('calendar-x').onClick(async () => {
      await p.unschedule(file);
      new Notice('Unscheduled ' + file.basename);
    }));

    menu.showAtMouseEvent(evt);
  }
}

/* ================================================================== settings */
class TaskPlannerSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    containerEl.empty();

    const save = async () => { await p.saveSettings(); };

    new Setting(containerEl).setName('Tasks').setHeading();

    new Setting(containerEl).setName('Task folder')
      .setDesc('Only notes in this folder are treated as tasks. Leave blank for the whole vault.')
      .addText((t) => t.setValue(s.taskFolder).onChange(async (v) => { s.taskFolder = v.trim(); await save(); }));

    const props = [
      ['startProp', 'Start property', 'Frontmatter key holding the start datetime.'],
      ['endProp', 'End property', 'Frontmatter key holding the end datetime.'],
      ['categoryProp', 'Category property', 'Drives the block color.'],
      ['statusProp', 'Status property', 'Used for done detection and auto status.'],
      ['estimateProp', 'Estimate property', 'Minutes. Sets the block length when dropped.'],
    ];
    for (const [key, name, desc] of props) {
      new Setting(containerEl).setName(name).setDesc(desc)
        .addText((t) => t.setValue(s[key]).onChange(async (v) => { s[key] = v.trim() || DEFAULTS[key]; await save(); }));
    }

    new Setting(containerEl).setName('Use the estimate as duration')
      .setDesc('Size a newly dropped block from the note\'s estimate. Falls back to the default below.')
      .addToggle((t) => t.setValue(s.useEstimate).onChange(async (v) => { s.useEstimate = v; await save(); }));

    new Setting(containerEl).setName('Default duration (minutes)')
      .addText((t) => t.setValue(String(s.defaultDuration)).onChange(async (v) => {
        const n = Number(v); if (n > 0) { s.defaultDuration = n; await save(); }
      }));

    new Setting(containerEl).setName('Update status automatically')
      .setDesc('Scheduling sets status to "scheduled"; unscheduling returns it to "open". Done is never touched.')
      .addToggle((t) => t.setValue(s.autoStatus).onChange(async (v) => { s.autoStatus = v; await save(); }));

    new Setting(containerEl).setName('Show completed tasks')
      .addToggle((t) => t.setValue(s.showDone).onChange(async (v) => { s.showDone = v; await save(); }));

    new Setting(containerEl).setName('Grid').setHeading();

    new Setting(containerEl).setName('Day start hour')
      .addSlider((sl) => sl.setLimits(0, 12, 1).setValue(s.startHour).setDynamicTooltip()
        .onChange(async (v) => { s.startHour = v; await save(); }));
    new Setting(containerEl).setName('Day end hour')
      .addSlider((sl) => sl.setLimits(13, 23, 1).setValue(s.endHour).setDynamicTooltip()
        .onChange(async (v) => { s.endHour = v; await save(); }));
    new Setting(containerEl).setName('Snap (minutes)')
      .addDropdown((d) => {
        for (const n of [5, 10, 15, 20, 30]) d.addOption(String(n), n + ' min');
        d.setValue(String(s.snapMinutes)).onChange(async (v) => { s.snapMinutes = Number(v); await save(); });
      });
    new Setting(containerEl).setName('Row height (px per hour)')
      .addSlider((sl) => sl.setLimits(24, 200, 2).setValue(s.pxPerHour).setDynamicTooltip()
        .onChange(async (v) => { s.pxPerHour = v; await save(); }));

    new Setting(containerEl).setName('Category colours').setHeading();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Presets are validated for colourblind separation against both the light and dark surface. '
          + 'A custom hex is used as-is in both themes.',
    });

    new Setting(containerEl)
      .setName('Rescan categories')
      .setDesc('Pick up categories added to task notes since this list was built.')
      .addButton((b) => b.setButtonText('Rescan').onClick(async () => {
        const before = Object.keys(s.categoryColors).length;
        p.ensureCategoryColors();
        await save();
        const added = Object.keys(s.categoryColors).length - before;
        new Notice(added ? 'Added ' + added + ' new categor' + (added === 1 ? 'y' : 'ies') : 'No new categories found');
        this.display();
      }));

    const hexOf = (spec) => spec.hex || PALETTE[spec.slot].light;
    const darkOf = (spec) => spec.hex || PALETTE[spec.slot].dark;

    for (const cat of p.allCategories()) {
      const setting = new Setting(containerEl).setName(cat);
      const swatch = createSpan('tp-swatch');
      setting.nameEl.prepend(swatch);
      const pinned = p.categoryPinnedBy(cat);
      setting.setDesc(pinned ? cat + ' is ' + pinned + '.' : 'Not used by any task note.');
      let picker = null;
      let syncing = false;
      const paint = () => {
        const spec = p.colorSpecFor(cat);
        swatch.style.background = hexOf(spec);
        swatch.style.setProperty('--tp-sw-dark', darkOf(spec));
      };
      setting.addDropdown((d) => {
        d.addOption('__custom', 'Custom hex');
        d.addOption('other', 'Neutral (Other)');
        for (const k of SLOT_KEYS) d.addOption(k, PALETTE[k].name + ' (validated)');
        const cur = p.colorSpecFor(cat);
        d.setValue(cur.hex ? '__custom' : cur.slot);
        d.onChange(async (v) => {
          s.categoryColors[cat] = (v === '__custom') ? hexOf(p.colorSpecFor(cat)) : v;
          paint();
          if (picker) { syncing = true; picker.setValue(hexOf(p.colorSpecFor(cat))); syncing = false; }
          await save();
        });
      });
      const onHex = async (v) => {
        if (syncing) return;
        s.categoryColors[cat] = v;
        paint();
        await save();
      };
      if (typeof setting.addColorPicker === 'function') {
        setting.addColorPicker((cp) => { picker = cp; cp.setValue(hexOf(p.colorSpecFor(cat))).onChange(onHex); });
      } else {
        setting.addText((t) => t.setPlaceholder('#rrggbb').setValue(hexOf(p.colorSpecFor(cat)))
          .onChange((v) => { if (/^#[0-9a-fA-F]{6}$/.test(v.trim())) onHex(v.trim()); }));
      }
      /* Removal is the only way a retired category leaves this list. A name a
       * task note still carries would just be re-added by the next scan, so
       * those are blocked outright rather than silently reappearing. */
      setting.addExtraButton((b) => b
        .setIcon('trash-2')
        .setTooltip(pinned ? 'Cannot remove - ' + pinned : 'Remove this category')
        .setDisabled(!!pinned)
        .onClick(async () => {
          if (p.categoryPinnedBy(cat)) {
            new Notice('Task Planner: "' + cat + '" is ' + p.categoryPinnedBy(cat) + '.', 6000);
            this.display();
            return;
          }
          await p.removeCategory(cat);
          new Notice('Removed category "' + cat + '"');
          this.display();
        }));
      paint();
    }

    new Setting(containerEl).setName('Alarms').setHeading();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Rings ahead of a start time and keeps ringing until you stop it. '
          + 'Escape and clicking away will not silence it.',
    });

    new Setting(containerEl).setName('Enable alarms')
      .addToggle((t) => t.setValue(s.alarmsEnabled).onChange(async (v) => {
        s.alarmsEnabled = v;
        if (!v && p.alarmModal) { p.alarmModal.released = true; p.alarmModal.close(); }
        await save();
      }));

    new Setting(containerEl).setName('Warning time')
      .setDesc('How many minutes before the start time the alarm goes off.')
      .addSlider((sl) => sl.setLimits(0, 30, 1).setValue(Number(s.alarmLeadMinutes) || 2).setDynamicTooltip()
        .onChange(async (v) => { s.alarmLeadMinutes = v; await save(); }));

    new Setting(containerEl).setName('Alarm for calendar events')
      .addToggle((t) => t.setValue(s.alarmForEvents).onChange(async (v) => { s.alarmForEvents = v; await save(); }));

    new Setting(containerEl).setName('Alarm for scheduled tasks')
      .setDesc('Off by default, so a full planner does not become a full day of alarms.')
      .addToggle((t) => t.setValue(s.alarmForTasks).onChange(async (v) => { s.alarmForTasks = v; await save(); }));

    new Setting(containerEl).setName('Volume')
      .addSlider((sl) => sl.setLimits(0, 100, 5).setValue(Math.round((Number(s.alarmVolume) || 0.5) * 100)).setDynamicTooltip()
        .onChange(async (v) => { s.alarmVolume = v / 100; await save(); }));

    new Setting(containerEl).setName('Custom sound file')
      .setDesc('Vault-relative path to an audio file, e.g. other/alarm.mp3. Leave blank for the built-in chime.')
      .addText((t) => t.setPlaceholder('other/alarm.mp3').setValue(s.alarmSoundFile || '')
        .onChange(async (v) => { s.alarmSoundFile = v.trim(); await save(); }));

    new Setting(containerEl).setName('Also send a system notification')
      .setDesc('Surfaces the alarm even when Obsidian is in the background.')
      .addToggle((t) => t.setValue(s.alarmSystemNotification).onChange(async (v) => { s.alarmSystemNotification = v; await save(); }));

    new Setting(containerEl).setName('Test')
      .setDesc('Fires the alarm now so you can check the sound and volume.')
      .addButton((b) => b.setButtonText('Test alarm').onClick(() => {
        p.ringAlarm([{ key: 'test:' + Date.now(), title: 'Alarm test',
          start: moment().add(Number(s.alarmLeadMinutes) || 2, 'minutes'),
          sub: 'Not a real event', spec: { slot: 'other' } }]);
      }));

    new Setting(containerEl).setName('Calendars').setHeading();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Read-only ICS feeds, drawn behind your tasks. In Google Calendar this is '
          + 'Settings -> the calendar -> "Secret address in iCal format".',
    });

    new Setting(containerEl).setName('Show calendar events')
      .addToggle((t) => t.setValue(s.showCalendars).onChange(async (v) => {
        s.showCalendars = v;
        await save();
        if (v) { await p.loadCalendars(true); p.refreshViews(); }
        this.display();
      }));

    new Setting(containerEl)
      .setName('Feeds')
      .setDesc((s.calendars || []).length + ' configured')
      .addButton((b) => b.setButtonText('Refresh now').onClick(async () => {
        new Notice('Fetching calendars...');
        await p.loadCalendars(true);
        p.refreshViews();
        const n = ((p.gcache && p.gcache.events) || []).length;
        const bad = Object.keys(p.calErrors || {}).length;
        new Notice(bad ? n + ' events loaded, ' + bad + ' feed(s) failed' : n + ' events loaded');
        this.display();
      }))
      .addButton((b) => b.setButtonText('+ Add calendar').setCta().onClick(async () => {
        s.calendars = s.calendars || [];
        s.calendars.push({ id: 'cal' + Date.now(), name: 'New calendar', url: '', color: '#6b7280', category: '', enabled: true });
        await save();
        this.display();
      }));

    for (const cal of s.calendars || []) {
      const box = containerEl.createDiv('tp-cal-box');

      new Setting(box)
        .setName(cal.name || 'Untitled calendar')
        .addText((t) => t.setPlaceholder('Name').setValue(cal.name || '')
          .onChange(async (v) => { cal.name = v; await save(); }))
        .addToggle((t) => t.setValue(cal.enabled !== false)
          .onChange(async (v) => { cal.enabled = v; p.gcache.at = 0; await save(); if (v) { await p.loadCalendars(true); } p.refreshViews(); }))
        .addExtraButton((b) => b.setIcon('trash-2').setTooltip('Remove this calendar').onClick(async () => {
          s.calendars = s.calendars.filter((c) => c !== cal);
          p.gcache.at = 0;
          await save();
          this.display();
        }));

      new Setting(box).setName('ICS URL')
        .addText((t) => t.setPlaceholder('https://... .ics').setValue(cal.url || '')
          .onChange(async (v) => { cal.url = v.trim(); p.gcache.at = 0; await save(); }));

      const colour = new Setting(box).setName('Colour')
        .setDesc(cal.category
          ? 'Inherits the "' + cal.category + '" category colour.'
          : 'Uses its own colour.');
      colour.addDropdown((d) => {
        d.addOption('', 'Own colour');
        for (const c of p.allCategories()) d.addOption(c, 'Match category: ' + c);
        d.setValue(cal.category || '');
        d.onChange(async (v) => { cal.category = v; await save(); p.refreshViews(); this.display(); });
      });
      if (!cal.category) {
        if (typeof colour.addColorPicker === 'function') {
          colour.addColorPicker((cp) => cp.setValue(cal.color || '#6b7280')
            .onChange(async (v) => { cal.color = v; await save(); p.refreshViews(); }));
        } else {
          colour.addText((t) => t.setPlaceholder('#rrggbb').setValue(cal.color || '#6b7280')
            .onChange(async (v) => { if (/^#[0-9a-fA-F]{6}$/.test(v.trim())) { cal.color = v.trim(); await save(); p.refreshViews(); } }));
        }
      }

      const err = (p.calErrors || {})[cal.id];
      if (err) box.createEl('p', { cls: 'setting-item-description tp-cal-error', text: 'Last fetch failed: ' + err });
    }
  }
}

module.exports = TaskPlannerPlugin;
