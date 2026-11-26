/* global ForceGraph */
// Color values mirror COLOR_SCHEME.md — change there first, then here.
(() => {
  const TYPE_COLOR = {
    dark: {
      section: '#3987e5', section_group: '#3987e5', python: '#3987e5', java: '#3987e5',
      layout: '#d95926', html: '#d95926', markdown: '#d95926',
      snippet: '#199e70', rust: '#199e70', go: '#199e70',
      javascript: '#c98500',
      template: '#d55181', template_json: '#d55181', component: '#d55181', c: '#d55181',
      block: '#008300', ruby: '#008300', php: '#008300',
      css: '#9085e9',
      json: '#e66767',
      asset: '#898781', unknown: '#898781',
    },
    light: {
      section: '#2a78d6', section_group: '#2a78d6', python: '#2a78d6', java: '#2a78d6',
      layout: '#eb6834', html: '#eb6834', markdown: '#eb6834',
      snippet: '#1baf7a', rust: '#1baf7a', go: '#1baf7a',
      javascript: '#eda100',
      template: '#e87ba4', template_json: '#e87ba4', component: '#e87ba4', c: '#e87ba4',
      block: '#008300', ruby: '#008300', php: '#008300',
      css: '#4a3aa7',
      json: '#e34948',
      asset: '#898781', unknown: '#898781',
    },
  };

  const REL_COLOR = {
    dark: {
      render: '#4a5568', include: '#4a5568', section: '#4a5568',
      section_group: '#4a5568', template_section: '#4a5568', content_for: '#4a5568',
      rust_mod: '#4a5568', tf_module: '#4a5568',
      import: '#5a6478', require: '#5a6478', dynamic_import: '#5a6478', css_import: '#5a6478',
      py_import: '#5a6478', rb_require: '#5a6478', rb_require_relative: '#5a6478',
      go_import: '#5a6478', php_require: '#5a6478', php_use: '#5a6478',
      java_import: '#5a6478', c_include: '#5a6478', sh_source: '#5a6478',
      asset: '#3f4a5a', asset_url: '#3f4a5a', script_src: '#3f4a5a', link_href: '#3f4a5a',
      md_link: '#3f4a5a',
      class_usage: '#4a4458',
      custom_element: '#4a5568',
      translation: '#3f4a5a',
    },
    light: {
      render: '#9096a6', include: '#9096a6', section: '#9096a6',
      section_group: '#9096a6', template_section: '#9096a6', content_for: '#9096a6',
      rust_mod: '#9096a6', tf_module: '#9096a6',
      import: '#9aa3b8', require: '#9aa3b8', dynamic_import: '#9aa3b8', css_import: '#9aa3b8',
      py_import: '#9aa3b8', rb_require: '#9aa3b8', rb_require_relative: '#9aa3b8',
      go_import: '#9aa3b8', php_require: '#9aa3b8', php_use: '#9aa3b8',
      java_import: '#9aa3b8', c_include: '#9aa3b8', sh_source: '#9aa3b8',
      asset: '#7c8794', asset_url: '#7c8794', script_src: '#7c8794', link_href: '#7c8794',
      md_link: '#7c8794',
      class_usage: '#9b8fae',
      custom_element: '#9096a6',
      translation: '#7c8794',
    },
  };

  // The eight categorical slots, in the validated order (COLOR_SCHEME.md).
  // "Color by language / directory" hands them out to whatever categories the
  // graph in front of you actually contains, so two languages that share a slot
  // in the type palette are never ambiguous in the same graph.
  const SLOT_HUES = {
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  };
  const OTHER_HUE = '#898781';

  const STATUS_CRITICAL = '#d03b3b';
  const STATUS_WARNING = '#fab219';
  const RISK_COLOR = { high: STATUS_CRITICAL, medium: STATUS_WARNING, low: OTHER_HUE };
  // Code-level imports are dashed; structural inclusion (Liquid render, Rust
  // `mod`) stays solid, because it defines the file tree rather than using it.
  const DASHED_RELS = new Set([
    'import', 'require', 'dynamic_import', 'css_import', 'class_usage',
    'py_import', 'rb_require', 'rb_require_relative',
    'go_import', 'php_require', 'php_use', 'java_import', 'c_include', 'sh_source',
  ]);
  // Mirrors app.css's `@media (prefers-color-scheme: light)` block exactly:
  // light only when explicitly matched, dark otherwise (the project default,
  // including the "no preference reported" case).
  const lightModeQuery = window.matchMedia?.('(prefers-color-scheme: light)');

  const SECTION_DEFAULTS = { view: true, types: true, relations: false, show: true, focus: false };
  const FOCUS_DIR_LABEL = { both: 'both', out: 'uses', in: 'used by' };

  function mode() {
    if (state.theme !== 'auto') return state.theme;
    return lightModeQuery?.matches ? 'light' : 'dark';
  }

  // 'auto' means "no data-theme attribute", which is what app.css's media
  // query keys off — so the three states stay in one place.
  function applyTheme() {
    if (state.theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = state.theme;
    syncSeg(document.getElementById('theme-btn'), b => b.dataset.themeValue === state.theme);
    onPaletteChange();
  }

  // Everything painted with a palette colour has to be repainted when the
  // effective theme flips — the canvas, and the swatches built in the DOM.
  function onPaletteChange() {
    themeColors = readThemeColors();
    categoryColorCache = null;
    for (const sw of document.querySelectorAll('[data-swatch-type]')) sw.style.background = colorForType(sw.dataset.swatchType);
    renderLegend();
    renderSide();
    refreshHighlight();
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  let themeColors = readThemeColors();
  function readThemeColors() {
    return {
      pillBg: cssVar('--label-pill-bg'), ink: cssVar('--label-ink'),
      accent: cssVar('--accent'), edgeHi: cssVar('--edge-hi'),
    };
  }

  const state = {
    graph: null,
    nodesById: new Map(),
    incoming: new Map(),
    typeFilters: new Set(),
    relFilters: new Set(),
    onlyOrphans: false,
    onlyRisk: false,
    onlyMissing: false,
    onlyCycles: false,
    search: '',
    searchActive: 0,
    selected: null,
    hovered: null,
    mode: 'galaxy',
    focusId: null,
    focusDepth: 2,
    focusDir: 'both',
    visibleNodeCount: 0,
    theme: 'auto',
    colorBy: 'type',
    sizeBy: 'in',
    // Set by shift-clicking a second node: the shortest dependency path
    // between two files, which is the "what reaches what" question a plain
    // neighbour highlight can't answer.
    path: null,
    pathTarget: null,
    cycles: { nodes: new Set(), edges: new Set(), list: [] },
    // 0 = show every file; n = collapse each folder at path depth n into one
    // node, except the ones the user has expanded.
    groupBy: 0,
    expanded: new Set(),
    clustersById: new Map(),
    open: { ...SECTION_DEFAULTS },
    filtersCollapsed: false,
    tab: 'usedby',
    perfDismissed: false,
  };

  const storageKey = () => `nervegraph:${state.graph ? state.graph.root : ''}`;

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function savePersisted() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify({
        typeFilters: [...state.typeFilters],
        relFilters: [...state.relFilters],
        mode: state.mode,
        theme: state.theme,
        colorBy: state.colorBy,
        sizeBy: state.sizeBy,
        groupBy: state.groupBy,
        open: state.open,
        filtersCollapsed: state.filtersCollapsed,
      }));
    } catch { /* ignore */ }
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────
  // Every string that came out of graph.json (paths, raw source lines) goes
  // in through textContent: those strings are someone else's code.

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(w, h, parts, cls) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('width', w);
    s.setAttribute('height', h);
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    for (const [tag, attrs] of parts) {
      const p = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      s.appendChild(p);
    }
    return s;
  }
  function icon(ds, cls = '') {
    const s = svgEl(16, 16, ds.map(d => ['path', { d }]), `ic ${cls}`);
    s.setAttribute('viewBox', '0 0 16 16');
    return s;
  }
  const ICON = {
    warn: ['M8 2.2l6.2 11H1.8z', 'M8 6.5v3M8 11.3v.1'],
    ok: ['M3.5 8.5l3 3 6-7'],
    close: ['M4 4l8 8M12 4l-8 8'],
  };
  // The same small marks the filter list and the canvas use, so a row in a
  // list reads like the node it points at.
  const MARK = {
    missing: () => svgEl(12, 12, [['circle', { cx: 6, cy: 6, r: 4.3, fill: 'none', stroke: STATUS_CRITICAL, 'stroke-width': 1.4, 'stroke-dasharray': '2 2' }]]),
    cycle: () => svgEl(12, 12, [['path', { d: 'M2 6a4 4 0 0 1 7-2.6M10 6a4 4 0 0 1-7 2.6', fill: 'none', stroke: STATUS_CRITICAL, 'stroke-width': 1.5, 'stroke-linecap': 'round' }]]),
    entry: (color) => svgEl(12, 12, [['circle', { cx: 6, cy: 6, r: 3, fill: color }], ['circle', { cx: 6, cy: 6, r: 5.2, fill: 'none', stroke: color }]]),
    unused: () => svgEl(12, 12, [['circle', { cx: 6, cy: 6, r: 4.3, fill: 'none', stroke: STATUS_WARNING, 'stroke-width': 1.4 }], ['path', { d: 'M3.5 6h5', stroke: STATUS_WARNING, 'stroke-width': 1.4 }]]),
  };
  function swatch(color, type) {
    const s = el('span', 'sw');
    s.style.background = color;
    if (type) s.dataset.swatchType = type;
    return s;
  }

  const fmt = (n) => Number(n).toLocaleString('en-US');
  const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
  const fileOf = (id) => id.split('/').pop();
  const dirOf = (id) => { const i = id.lastIndexOf('/'); return i < 0 ? '' : id.slice(0, i + 1); };
  const stemOf = (id) => fileOf(id).replace(/\.[^.]+$/, '');
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

  // ── Load ─────────────────────────────────────────────────────────────────

  function showState(which, title, text) {
    document.getElementById('state-card').hidden = false;
    document.getElementById('state-loading').hidden = which !== 'loading';
    document.getElementById('state-empty').hidden = which !== 'empty';
    document.getElementById('state-error').hidden = which !== 'error';
    if (which === 'error') {
      document.getElementById('state-error-title').textContent = title;
      document.getElementById('state-error-text').textContent = text;
    }
  }

  async function main() {
    wireStateCard();
    let res;
    try {
      res = await fetch('/graph.json');
    } catch (e) {
      showState('error', 'Could not reach nerve view', `${e.message}. Is the server still running?`);
      return;
    }
    // The server answers a missing graph with 404 and a plain-text hint.
    if (res.status === 404) { showState('empty'); return; }
    if (!res.ok) {
      showState('error', 'Could not load graph.json', (await res.text().catch(() => '')).trim() || `HTTP ${res.status}`);
      return;
    }
    const graph = await res.json();
    state.graph = graph;
    for (const n of graph.nodes) state.nodesById.set(n.id, n);
    for (const e of graph.edges) {
      if (!state.incoming.has(e.to)) state.incoming.set(e.to, []);
      state.incoming.get(e.to).push(e.from);
    }

    const stepRead = document.getElementById('step-read');
    stepRead.textContent = 'done';
    stepRead.classList.add('done');
    document.getElementById('step-place').classList.remove('dim3');
    document.getElementById('step-read-n').textContent = `${fmt(graph.nodes.length)} files · ${fmt(graph.edges.length)} links`;
    document.getElementById('root-name').textContent = rootName();
    document.getElementById('counts').textContent = `${fmt(graph.nodes.length)} files · ${fmt(graph.edges.length)} links`;
    document.title = `${rootName()} · nervegraph`;

    if (!graph.nodes.length) {
      showState('error', 'Nothing to draw', 'The scan found no files it could read. Check the scan root and .gitignore, then run nerve scan again.');
      return;
    }

    const allTypes = new Set(graph.nodes.map(n => n.type));
    const allRels = new Set(graph.edges.map(e => e.rel));

    const persisted = loadPersisted();
    state.typeFilters = new Set(persisted?.typeFilters ?? [...allTypes].filter(t => t !== 'asset'));
    state.relFilters = new Set(persisted?.relFilters ?? [...allRels].filter(r => r !== 'translation' && r !== 'class_usage'));
    state.mode = persisted?.mode ?? 'galaxy';
    state.theme = persisted?.theme ?? 'auto';
    state.colorBy = persisted?.colorBy ?? 'type';
    state.sizeBy = persisted?.sizeBy ?? 'in';
    state.open = { ...SECTION_DEFAULTS, ...(persisted?.open ?? {}) };
    state.filtersCollapsed = persisted?.filtersCollapsed ?? false;
    // Big graphs open folded: 3000 dots say less than 30 folders do.
    state.groupBy = persisted?.groupBy ?? (graph.nodes.length > 1200 ? 1 : 0);
    state.cycles = indexCycles(graph);

    // Before the UI is built: it may drop the `asset` filter, and the checkbox
    // and the initial graph data both have to be built from the final filter set.
    checkPerfBanner();
    buildFilterUI(allTypes, allRels);
    buildGraphInstance();
    applyTheme();
    updateStatusBar();
    wireTopLevelUI();
    applyHash();
    renderSide();
    renderPerfBanner();

    subscribeToGraphChanges();
    lightModeQuery?.addEventListener?.('change', () => { if (state.theme === 'auto') onPaletteChange(); });

    // Two frames: one for force-graph to lay the first tick out, one to paint it.
    requestAnimationFrame(() => requestAnimationFrame(() => { document.getElementById('state-card').hidden = true; }));
  }

  function rootName() {
    return (state.graph?.root ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  }

  function wireStateCard() {
    const reload = () => location.reload();
    document.getElementById('state-reload').addEventListener('click', reload);
    document.getElementById('state-error-reload').addEventListener('click', reload);
    const copy = document.getElementById('copy-scan');
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText('npx nervegraph@latest scan');
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });
  }

  // `nerve scan --watch` rewrites graph.json; the server turns that into an
  // SSE event. Reloading the page is the honest way to apply it: node
  // positions, filters and the selection all rebuild from persisted state
  // anyway, and a partial in-place merge would be a second code path for the
  // same job.
  function subscribeToGraphChanges() {
    if (!window.EventSource) return;
    const events = new EventSource('/events');
    const watch = document.getElementById('watch-status');
    events.onopen = () => { watch.hidden = false; };
    events.addEventListener('graph', () => {
      showBanner('Graph changed — reloading');
      setTimeout(() => location.reload(), 300);
    });
    // A dropped connection just means `nerve view` stopped; EventSource
    // reconnects on its own, and the indicator comes back with it.
    events.onerror = () => { watch.hidden = true; };
  }

  // ── Filters ──────────────────────────────────────────────────────────────

  const typeRows = [];
  const relRows = [];

  function filterRow(key, set, label, mark, count, rows) {
    const row = el('label', 'row');
    const cb = el('input', 'chk');
    cb.type = 'checkbox';
    cb.checked = set.has(key);
    row.classList.toggle('off', !cb.checked);
    cb.addEventListener('change', () => {
      cb.checked ? set.add(key) : set.delete(key);
      row.classList.toggle('off', !cb.checked);
      onFilterSetChange();
    });
    row.append(cb, mark, label, el('span', 'n', fmt(count)));
    rows.push({ key, cb, row });
    return row;
  }

  function onFilterSetChange() {
    savePersisted();
    applyFilters();
    updateFilterSummaries();
  }

  function setAll(rows, set, on) {
    for (const r of rows) {
      on ? set.add(r.key) : set.delete(r.key);
      r.cb.checked = on;
      r.row.classList.toggle('off', !on);
    }
    onFilterSetChange();
  }

  function buildFilterUI(allTypes, allRels) {
    const typeCounts = {};
    for (const n of state.graph.nodes) typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1;
    const typeBox = document.getElementById('type-filters');
    for (const t of [...allTypes].sort((a, b) => typeCounts[b] - typeCounts[a] || (a < b ? -1 : 1))) {
      typeBox.appendChild(filterRow(t, state.typeFilters, t, swatch(colorForType(t), t), typeCounts[t], typeRows));
    }

    const relCounts = {};
    for (const e of state.graph.edges) relCounts[e.rel] = (relCounts[e.rel] ?? 0) + 1;
    const relBox = document.getElementById('rel-filters');
    for (const r of [...allRels].sort((a, b) => relCounts[b] - relCounts[a] || (a < b ? -1 : 1))) {
      const line = svgEl(20, 8, [['path', { d: 'M1 4H19', stroke: 'var(--edge-hi)', 'stroke-width': 1.6, ...(DASHED_RELS.has(r) ? { 'stroke-dasharray': '3 2' } : {}) }]]);
      relBox.appendChild(filterRow(r, state.relFilters, r, line, relCounts[r], relRows));
    }

    for (const b of document.querySelectorAll('[data-bulk]')) {
      b.addEventListener('click', () => {
        const [kind, how] = b.dataset.bulk.split('-');
        if (kind === 'types') setAll(typeRows, state.typeFilters, how === 'all');
        else setAll(relRows, state.relFilters, how === 'all');
      });
    }

    const counts = {
      orphans: state.graph.nodes.filter(n => n.orphan).length,
      risk: state.graph.nodes.filter(n => n.risk === 'high').length,
      missing: state.graph.nodes.filter(n => n.missing).length,
      cycles: state.cycles.nodes.size,
    };
    for (const [k, v] of Object.entries(counts)) document.getElementById(`count-${k}`).textContent = fmt(v);

    for (const [id, key] of [['only-orphans', 'onlyOrphans'], ['only-risk', 'onlyRisk'], ['only-missing', 'onlyMissing'], ['only-cycles', 'onlyCycles']]) {
      document.getElementById(id).addEventListener('change', (e) => { state[key] = e.target.checked; applyFilters(); updateFilterSummaries(); });
    }

    const colorBy = document.getElementById('color-by');
    colorBy.value = state.colorBy;
    colorBy.addEventListener('change', () => setColorBy(colorBy.value));

    const sizeBy = document.getElementById('size-by');
    sizeBy.value = state.sizeBy;
    sizeBy.addEventListener('change', () => {
      state.sizeBy = sizeBy.value;
      savePersisted();
      // Radius feeds the charge force, so the layout has to be nudged awake.
      fg.d3ReheatSimulation();
      refreshHighlight();
    });

    const groupBy = document.getElementById('group-by');
    groupBy.value = String(state.groupBy);
    groupBy.addEventListener('change', () => setGroupBy(Number(groupBy.value)));

    document.getElementById('collapse-all').addEventListener('click', () => {
      state.expanded.clear();
      applyFilters();
    });

    wireSeg('focus-depth', () => String(state.focusDepth), v => { state.focusDepth = Number(v); });
    wireSeg('focus-dir', () => state.focusDir, v => { state.focusDir = v; });

    for (const sec of document.querySelectorAll('#filters .sec[data-sec]')) {
      const key = sec.dataset.sec;
      const head = sec.querySelector('.sh');
      const sync = () => {
        sec.classList.toggle('closed', !state.open[key]);
        head.setAttribute('aria-expanded', String(!!state.open[key]));
      };
      head.addEventListener('click', () => { state.open[key] = !state.open[key]; sync(); savePersisted(); });
      sync();
    }

    const filters = document.getElementById('filters');
    const syncCollapsed = () => filters.classList.toggle('collapsed', state.filtersCollapsed);
    document.getElementById('filters-collapse').addEventListener('click', () => { state.filtersCollapsed = true; syncCollapsed(); savePersisted(); });
    document.getElementById('filters-expand').addEventListener('click', () => { state.filtersCollapsed = false; syncCollapsed(); savePersisted(); });
    syncCollapsed();

    renderLegend();
    updateFilterSummaries();
  }

  function wireSeg(id, get, set) {
    const seg = document.getElementById(id);
    const sync = () => syncSeg(seg, b => b.dataset.value === get());
    for (const b of seg.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        set(b.dataset.value);
        sync();
        updateFilterSummaries();
        if (state.focusId) applyFilters();
      });
    }
    sync();
  }

  function syncSeg(seg, isOn) {
    for (const b of seg.querySelectorAll('button')) {
      const on = isOn(b);
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  function updateFilterSummaries() {
    document.getElementById('types-summary').textContent = `${typeRows.filter(r => r.cb.checked).length} of ${typeRows.length}`;
    document.getElementById('rels-summary').textContent = `${relRows.filter(r => r.cb.checked).length} of ${relRows.length}`;
    document.getElementById('focus-summary').textContent = `depth ${state.focusDepth} · ${FOCUS_DIR_LABEL[state.focusDir]}`;
    const hiddenTypes = typeRows.filter(r => !r.cb.checked).map(r => r.key);
    const hiddenRels = relRows.filter(r => !r.cb.checked).length;
    const only = ['onlyOrphans', 'onlyRisk', 'onlyMissing', 'onlyCycles'].filter(k => state[k]).length;
    const active = hiddenTypes.length + hiddenRels + only;
    const badge = document.getElementById('filters-active');
    badge.textContent = active ? String(active) : '';
    badge.title = active
      ? [hiddenTypes.length && `hidden: ${hiddenTypes.join(', ')}`, hiddenRels && `${hiddenRels} relations off`, only && `${only} show-only on`].filter(Boolean).join(' · ')
      : '';
  }

  function setGroupBy(depth) {
    state.groupBy = depth;
    state.expanded.clear();
    document.getElementById('group-by').value = String(depth);
    savePersisted();
    applyFilters();
    renderPerfBanner();
  }

  function updateGroupHint() {
    const hint = document.getElementById('group-hint');
    const collapse = document.getElementById('collapse-all');
    hint.hidden = collapse.hidden = !state.groupBy;
    if (!state.groupBy) return;
    const folders = state.clustersById.size;
    const opened = state.expanded.size;
    hint.textContent = `${plural(folders, 'folder')} on the map, ${opened ? `${fmt(opened)} opened` : 'none opened'}. Click a folder to open it.`;
    collapse.disabled = !opened;
  }

  // ── Categorical coloring ─────────────────────────────────────────────────

  function categoryOf(n) {
    if (state.colorBy === 'language') return n.lang || 'other';
    if (state.colorBy === 'directory') {
      const slash = n.id.indexOf('/');
      return slash < 0 ? '(root)' : n.id.slice(0, slash);
    }
    return n.type;
  }

  // Slots go to the biggest categories first: in a repo of 900 JS files and one
  // stray .rb, the JS files are what the eye needs to separate. Everything past
  // the eighth folds into the neutral, which is the method's "Other" rule.
  let categoryColorCache = null;
  function categoryColors() {
    if (categoryColorCache?.key === `${state.colorBy}:${mode()}`) return categoryColorCache.map;
    const counts = new Map();
    for (const n of state.graph.nodes) counts.set(categoryOf(n), (counts.get(categoryOf(n)) ?? 0) + 1);
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const hues = SLOT_HUES[mode()];
    const map = new Map();
    ordered.forEach(([name], i) => map.set(name, i < hues.length ? hues[i] : OTHER_HUE));
    categoryColorCache = { key: `${state.colorBy}:${mode()}`, map, ordered };
    return map;
  }

  function setColorBy(value) {
    state.colorBy = value;
    categoryColorCache = null;
    savePersisted();
    renderLegend();
    refreshHighlight();
  }

  function renderLegend() {
    const box = document.getElementById('legend');
    if (!box || !state.graph) return;
    box.replaceChildren();
    // With "color by type" the File types filter is already the legend, and
    // repeating it would just push the filters off-screen.
    if (state.colorBy === 'type') return;

    const rows = state.colorBy === 'risk'
      ? [['high', RISK_COLOR.high], ['medium', RISK_COLOR.medium], ['low', RISK_COLOR.low], ['missing', STATUS_CRITICAL]]
          .map(([name, color]) => [name, color, state.graph.nodes.filter(n => (name === 'missing' ? n.missing : n.risk === name)).length])
      : (categoryColors(), categoryColorCache.ordered.slice(0, 9)
          .map(([name, count], i) => [i < 8 ? name : 'other', i < 8 ? categoryColorCache.map.get(name) : OTHER_HUE, i < 8 ? count : categoryColorCache.ordered.slice(8).reduce((s, [, c]) => s + c, 0)]));

    for (const [name, color, count] of rows) {
      const row = el('div', 'row');
      row.append(swatch(color), el('span', '', name), el('span', 'n', fmt(count)));
      box.appendChild(row);
    }
  }

  // ── Cycles ───────────────────────────────────────────────────────────────

  // graph.cycles (schema 4+) is the list of closed walks build.ts found. It
  // used to reach the viewer only as the prose of a `cycle` warning, which had
  // to be regex-parsed back into a path — a format nobody could safely reword.
  function indexCycles(graph) {
    const nodes = new Set(), edges = new Set(), list = [];
    for (const files of graph.cycles ?? []) {
      if (files.length < 2) continue;
      list.push(files);
      for (const f of files) nodes.add(f);
      for (let i = 0; i + 1 < files.length; i++) edges.add(`${files[i]}\0${files[i + 1]}`);
    }
    return { nodes, edges, list };
  }

  let fg;

  function visibleNodeIds() {
    const ids = new Set();
    for (const n of state.graph.nodes) {
      if (!state.typeFilters.has(n.type)) continue;
      if (state.onlyOrphans && !n.orphan) continue;
      if (state.onlyRisk && n.risk !== 'high') continue;
      if (state.onlyMissing && !n.missing) continue;
      if (state.onlyCycles && !state.cycles.nodes.has(n.id)) continue;
      ids.add(n.id);
    }
    if (state.focusId) {
      const subgraph = subgraphAround(state.focusId, state.focusDepth, state.focusDir);
      for (const id of [...ids]) if (!subgraph.has(id)) ids.delete(id);
    }
    return ids;
  }

  // dir: 'out' follows dependencies, 'in' follows dependents, 'both' ignores
  // direction. "What breaks if I change this" and "what does this pull in" are
  // different questions and a fixed both-ways walk answered neither cleanly.
  function subgraphAround(id, depth, dir = 'both') {
    const visited = new Set([id]);
    let frontier = [id];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const f of frontier) {
        for (const e of state.graph.edges) {
          if (dir !== 'in' && e.from === f && !visited.has(e.to)) { visited.add(e.to); next.push(e.to); }
          if (dir !== 'out' && e.to === f && !visited.has(e.from)) { visited.add(e.from); next.push(e.from); }
        }
      }
      frontier = next;
    }
    return visited;
  }

  // Every file that reaches `id` through any chain of references: the set a
  // change to `id` can break. Same walk as `nerve query`'s transitiveDependents.
  function transitiveDependents(id) {
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
      for (const from of state.incoming.get(queue.shift()) ?? []) {
        if (!seen.has(from)) { seen.add(from); queue.push(from); }
      }
    }
    seen.delete(id);
    return seen;
  }

  // Shortest dependency path, tried in both directions so shift-clicking works
  // whichever of the two files happens to be upstream.
  function shortestPath(from, to) {
    for (const [a, b] of [[from, to], [to, from]]) {
      const prev = new Map([[a, null]]);
      const queue = [a];
      while (queue.length) {
        const cur = queue.shift();
        if (cur === b) {
          const ids = [];
          for (let at = b; at !== null; at = prev.get(at)) ids.unshift(at);
          const edges = new Set();
          for (let i = 0; i + 1 < ids.length; i++) edges.add(`${ids[i]}\0${ids[i + 1]}`);
          return { ids: new Set(ids), order: ids, edges };
        }
        for (const e of state.graph.edges) {
          if (e.from === cur && !prev.has(e.to)) { prev.set(e.to, cur); queue.push(e.to); }
        }
      }
    }
    return null;
  }

  // ── Folder clustering ────────────────────────────────────────────────────

  // Past a couple of thousand nodes the map stops being readable, which is
  // exactly the size where it would help most. Collapsing a folder into one
  // node trades detail for shape; clicking the folder expands it again, so the
  // detail is one click away rather than gone.
  function clusterKeyFor(id) {
    if (!state.groupBy) return null;
    const parts = id.split('/');
    if (parts.length <= 1) return null; // a root-level file is its own folder
    const key = parts.slice(0, Math.min(state.groupBy, parts.length - 1)).join('/');
    return state.expanded.has(key) ? null : key;
  }

  function foldByFolder(nodes, links) {
    const clusters = new Map();
    const mapId = new Map();

    for (const n of nodes) {
      const key = clusterKeyFor(n.id);
      if (!key) { mapId.set(n.id, n.id); continue; }
      const cid = `${key}/`;
      mapId.set(n.id, cid);
      let c = clusters.get(cid);
      if (!c) {
        c = {
          id: cid, cluster: true, files: [], type: 'unknown', lang: 'folder',
          risk: 'low', in: 0, out: 0, loc: 0, size: 0, orphan: false, entrypoint: false,
          typeCounts: {},
        };
        clusters.set(cid, c);
      }
      c.files.push(n.id);
      c.loc += n.loc;
      c.size += n.size;
      c.typeCounts[n.type] = (c.typeCounts[n.type] ?? 0) + 1;
    }
    // A folder takes the colour of the file type it mostly holds, so
    // "sections/" still reads blue and "snippets/" aqua.
    for (const c of clusters.values()) {
      c.type = Object.entries(c.typeCounts).sort((a, b) => b[1] - a[1])[0][0];
      c.lang = state.nodesById.get(c.files[0])?.lang ?? 'folder';
    }

    const byPair = new Map();
    for (const l of links) {
      const from = mapId.get(l.from), to = mapId.get(l.to);
      if (!from || !to || from === to) continue; // a folder's inner edges are its own business
      const key = `${from}\0${to}\0${l.rel}`;
      const seen = byPair.get(key);
      if (seen) seen._count += l._count;
      else byPair.set(key, { ...l, from, to, source: from, target: to });
    }

    for (const c of clusters.values()) { c.in = 0; c.out = 0; }
    for (const l of byPair.values()) {
      const from = clusters.get(l.from), to = clusters.get(l.to);
      if (from) from.out += 1;
      if (to) to.in += 1;
    }

    state.clustersById = clusters;
    return {
      nodes: [...nodes.filter(n => mapId.get(n.id) === n.id), ...clusters.values()],
      links: [...byPair.values()],
    };
  }

  function buildGraphData() {
    const ids = visibleNodeIds();
    const nodes = state.graph.nodes.filter(n => ids.has(n.id)).map(n => ({ ...n }));
    // Several references between the same pair of files (one per line) are one
    // relationship, drawn once and widened by `_count` — otherwise they stacked
    // as identical overlapping lines and linkWidth had nothing to read.
    const byPair = new Map();
    for (const e of state.graph.edges) {
      if (!ids.has(e.from) || !ids.has(e.to) || !state.relFilters.has(e.rel)) continue;
      const key = `${e.from}\0${e.to}\0${e.rel}`;
      const seen = byPair.get(key);
      if (seen) seen._count++;
      else byPair.set(key, { ...e, source: e.from, target: e.to, _count: 1 });
    }
    const links = [...byPair.values()];
    if (state.groupBy) return foldByFolder(nodes, links);
    state.clustersById = new Map();
    return { nodes, links };
  }

  function setGraphData(data) {
    state.visibleNodeCount = data.nodes.length;
    fg.graphData(data);
    updateGroupHint();
  }

  function nodeRadius(n) {
    // A folder's size is how much it contains, whatever "size by" says about files.
    if (n.cluster) return 6 + Math.min(14, Math.sqrt(n.files.length) * 2.5);
    // loc runs into the thousands where degrees run into the tens, so the two
    // scales need different factors to land in the same 4–16px range.
    const value = state.sizeBy === 'loc' ? n.loc : state.sizeBy === 'out' ? n.out : n.in;
    const factor = state.sizeBy === 'loc' ? 0.45 : 2.5;
    return 4 + Math.min(12, Math.sqrt(Math.max(0, value)) * factor);
  }

  function neighborsOf(id) {
    const out = new Set(), inc = new Set();
    for (const e of state.graph.edges) {
      if (e.from === id) out.add(e.to);
      if (e.to === id) inc.add(e.from);
    }
    return { out, inc };
  }

  // drawNode runs per node per frame and needs the *same* neighbour sets every
  // time; recomputing them there scanned the whole edge list N times a frame.
  // state.graph.edges never changes after load, so caching on the active id is
  // enough.
  let neighborCache = { id: null, value: null };
  function neighborsOfCached(id) {
    if (neighborCache.id !== id) neighborCache = { id, value: neighborsOf(id) };
    return neighborCache.value;
  }

  function nodeTooltip(n) {
    const box = el('span');
    const name = el('b');
    name.textContent = n.id;
    box.append(name);
    const sub = n.cluster ? `${plural(n.files.length, 'file')} · click to open` : `${n.in} in · ${n.out} out`;
    box.append(el('span', 'tip-sub', sub));
    return box;
  }

  function buildGraphInstance() {
    const host = document.getElementById('graph');
    fg = ForceGraph()(host)
      .graphData(buildGraphData())
      .nodeId('id')
      // force-graph renders a string label as HTML, and ids come from import
      // strings in the scanned code; an element with textContent cannot inject.
      .nodeLabel(nodeTooltip)
      .nodeCanvasObjectMode(() => 'replace')
      .nodeCanvasObject(drawNode)
      .nodePointerAreaPaint(paintNodePointerArea)
      .linkLineDash(l => (isMissingLink(l) ? [2, 3] : DASHED_RELS.has(l.rel) ? [3, 2] : null))
      .linkDirectionalArrowLength(3)
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalParticleWidth(2)
      .onNodeClick(handleNodeClick)
      .onNodeHover(handleNodeHover)
      .onBackgroundClick(clearSelection)
      .onNodeDragEnd(n => { n.fx = n.x; n.fy = n.y; })
      .cooldownTime(4000)
      .d3AlphaDecay(0.03)
      .d3VelocityDecay(0.4);

    state.visibleNodeCount = fg.graphData().nodes.length;
    updateGroupHint();

    // Hub nodes (high in-degree) draw a wide label pill that plain -180
    // charge doesn't push clear of neighbors — scale repulsion by the node's
    // own radius so busy hubs shove their surrounding cluster further out.
    fg.d3Force('charge').strength(n => -180 - nodeRadius(n) * 20).distanceMax(500);
    fg.d3Force('link').distance(70).strength(0.4);
    fg.d3Force('center').strength(0.05);

    applyMode();
    refreshHighlight();
    // Covers the window, the filter rail and the mobile sheet alike.
    new ResizeObserver(() => fg.width(host.clientWidth).height(host.clientHeight)).observe(host);
    fg.width(host.clientWidth).height(host.clientHeight);
  }

  function applyMode() {
    fg.dagMode(state.mode === 'tree' ? 'td' : null);
    document.getElementById('mode-indicator').textContent = cap(state.mode);
    syncSeg(document.getElementById('layout-seg'), b => b.dataset.mode === state.mode);
  }

  function setMode(m) {
    state.mode = m;
    savePersisted();
    applyMode();
  }

  function colorForType(type) {
    const table = TYPE_COLOR[mode()];
    return table[type] ?? table.unknown;
  }
  function colorForNode(n) {
    if (state.colorBy === 'risk') return n.missing ? STATUS_CRITICAL : RISK_COLOR[n.risk] ?? OTHER_HUE;
    if (state.colorBy === 'type') return colorForType(n.type);
    return categoryColors().get(categoryOf(n)) ?? OTHER_HUE;
  }
  const linkKey = (l) => `${l.from}\0${l.to}`;
  const isMissingLink = (l) => !!state.nodesById.get(l.to)?.missing;
  const onPath = (l) => !!state.path?.edges.has(linkKey(l));
  function colorForLink(l) {
    if (onPath(l)) return themeColors.accent;
    // A cycle is the one structural defect the graph can prove, so it outranks
    // the relation's own muted colour; a reference to a missing file is next.
    if (state.cycles.edges.has(linkKey(l)) || isMissingLink(l)) return STATUS_CRITICAL;
    if (!state.path && isHighlighted(l)) return themeColors.edgeHi;
    return REL_COLOR[mode()][l.rel] ?? REL_COLOR[mode()].render;
  }

  function isHighlighted(link) {
    if (state.path) return onPath(link);
    const active = state.selected ?? state.hovered;
    if (!active) return false;
    return link.from === active || link.to === active;
  }

  function handleNodeHover(node) {
    state.hovered = node ? node.id : null;
    document.getElementById('graph').style.cursor = node ? 'pointer' : '';
    refreshHighlight();
  }

  function handleNodeClick(node, event) {
    // A folder is a lid, not a file: clicking it lifts the lid.
    if (node.cluster) {
      state.expanded.add(node.id.replace(/\/$/, ''));
      setGraphData(buildGraphData());
      return;
    }
    // Shift-click asks "how does the selected file reach this one".
    if (event?.shiftKey && state.selected && state.selected !== node.id) {
      state.path = shortestPath(state.selected, node.id);
      state.pathTarget = node.id;
      refreshHighlight();
      renderSide();
      updateStatusBar();
      return;
    }
    selectNode(node.id);
  }

  function selectNode(id) {
    // Searching for, or linking to, a file inside a collapsed folder has to
    // open that folder — otherwise the selection points at nothing on screen.
    const hiddenIn = clusterKeyFor(id);
    if (hiddenIn) {
      state.expanded.add(hiddenIn);
      setGraphData(buildGraphData());
    }
    if (state.selected !== id) state.tab = 'usedby';
    state.selected = id;
    state.path = null;
    state.pathTarget = null;
    refreshHighlight();
    renderSide();
    updateStatusBar();
    syncHash();
  }

  function clearPath() {
    state.path = null;
    state.pathTarget = null;
    refreshHighlight();
    renderSide();
    updateStatusBar();
  }

  function clearSelection() {
    state.selected = null;
    state.path = null;
    state.pathTarget = null;
    refreshHighlight();
    renderSide();
    updateStatusBar();
    syncHash();
  }

  // The selection and the focused subgraph live in the URL, so a view can be
  // bookmarked or pasted to a colleague. Everything else (filters, colors) is
  // per-person taste and stays in localStorage.
  function syncHash() {
    const parts = [];
    if (state.selected) parts.push(`file=${encodeURIComponent(state.selected)}`);
    if (state.focusId) parts.push(`focus=${encodeURIComponent(state.focusId)}`);
    history.replaceState(null, '', parts.length ? `#${parts.join('&')}` : location.pathname);
  }

  function applyHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    const focus = params.get('focus');
    if (focus && state.nodesById.has(focus)) {
      state.focusId = focus;
      setGraphData(buildGraphData());
    }
    const file = params.get('file');
    if (file && state.nodesById.has(file)) selectNode(file);
  }

  // Node/link colors are computed fresh from `state` on every canvas frame
  // (see drawNode/colorForLink), so "refreshing the highlight" is really just
  // forcing force-graph to repaint with the current selection/hover state.
  function refreshHighlight() {
    if (!fg) return;
    fg.linkColor(l => {
      const c = colorForLink(l);
      if (state.path) return onPath(l) ? c : dim(c, '38');
      const active = state.selected ?? state.hovered;
      if (!active) return c;
      return (l.from === active || l.to === active) ? c : dim(c, '38');
    });
    fg.linkWidth(l => (onPath(l) ? 3 : isHighlighted(l) ? 1.6 : 1) + Math.min(3, (l._count ?? 1) - 1));
    // Particles cost a draw per link per frame; past 2,000 nodes they cost more
    // than they say.
    const particles = state.visibleNodeCount <= 2000;
    fg.linkDirectionalParticles(l => (particles && isHighlighted(l) ? 2 : 0));
    document.getElementById('shift-hint').hidden = !state.selected || !!state.pathTarget;
  }

  // Alpha as a hex suffix: '24' ≈ 14% for nodes, '38' ≈ 22% for edges.
  function dim(hex, alpha = '24') {
    return hex + alpha;
  }

  // --- Canvas node rendering: circle + entrypoint ring + missing dash +
  // an always-legible basename label (see COLOR_SCHEME.md "Node label pill").
  // Labels thin out as the visible node count grows; see shouldLabel below.
  function drawNode(node, ctx, globalScale) {
    const r = nodeRadius(node);
    const active = state.selected ?? state.hovered;
    const neigh = active ? neighborsOfCached(active) : null;
    const isNeighbor = active && (node.id === active || neigh.out.has(node.id) || neigh.inc.has(node.id));
    // A traced path replaces the neighbour highlight: everything off the path
    // recedes, however close it is to either end of it.
    const dimmed = state.path ? !state.path.ids.has(node.id) : (active && !isNeighbor);
    const baseColor = node.missing ? STATUS_CRITICAL : colorForNode(node);
    const color = dimmed ? dim(baseColor) : baseColor;
    const px = 1 / globalScale;

    // A folder is drawn as a square so it never reads as "one big file".
    if (node.cluster) {
      roundRectPath(ctx, node.x - r, node.y - r, r * 2, r * 2, r / 3);
      ctx.fillStyle = color;
      ctx.fill();
      const size = r * 0.62;
      if (!dimmed && size * globalScale >= 7) {
        ctx.font = `600 ${size}px -apple-system, Segoe UI, sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fmt(node.files.length), node.x, node.y + size * 0.05);
      }
      if (!dimmed) drawLabel(node, ctx, globalScale, r, `${fileOf(node.id.replace(/\/$/, ''))}/`);
      return;
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
    if (node.missing) {
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (node.entrypoint) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI, false);
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    const isSelected = node.id === state.selected && !state.path;
    const pathEnd = state.path && (node.id === state.path.order[0] ? 'A' : node.id === state.path.order.at(-1) ? 'B' : null);
    if (isSelected || pathEnd) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + (node.entrypoint ? 6 : 4), 0, 2 * Math.PI, false);
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = themeColors.accent;
      ctx.stroke();
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + (node.entrypoint ? 6 : 4) + 6 * px, 0, 2 * Math.PI, false);
        ctx.lineWidth = px;
        ctx.strokeStyle = themeColors.accent + '59';
        ctx.stroke();
      }
      drawLabel(node, ctx, globalScale, r + 6, pathEnd ? `${pathEnd} · ${fileOf(node.id)}` : basename(node.id), true);
      return;
    }

    if (!dimmed && (isNeighbor || state.path?.ids.has(node.id) || shouldLabel(node, globalScale))) {
      drawLabel(node, ctx, globalScale, r);
    }
  }

  function shouldLabel(node, globalScale) {
    const n = state.visibleNodeCount;
    if (n <= 500) return true;
    if (n <= 2000) return globalScale >= 1.2 || node.in >= 10;
    return node.in >= 10;
  }

  // `strong` is the selected file's label: an accent pill with white text, so
  // the one file the panel is about is findable in any cloud.
  function drawLabel(node, ctx, globalScale, r, text, strong = false) {
    const label = text ?? basename(node.id);
    const fontSize = Math.max((strong ? 11.5 : 11) / globalScale, 1.6);
    ctx.font = `${strong ? '600 ' : ''}${fontSize}px -apple-system, Segoe UI, sans-serif`;
    const textWidth = ctx.measureText(label).width;
    const padX = (strong ? 6 : 4) / globalScale;
    const padY = (strong ? 4 : 2) / globalScale;
    const boxW = textWidth + padX * 2;
    const boxH = fontSize + padY * 2;
    const top = node.y + r + 2 / globalScale;

    roundRectPath(ctx, node.x - boxW / 2, top, boxW, boxH, (strong ? 5 : 4) / globalScale);
    ctx.fillStyle = strong ? themeColors.accent : themeColors.pillBg;
    ctx.fill();

    ctx.fillStyle = strong ? '#ffffff' : themeColors.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, node.x, top + boxH / 2);
  }

  function basename(id) {
    const b = id.split('/').pop();
    return b.length > 28 ? `${b.slice(0, 26)}…` : b;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function paintNodePointerArea(node, color, ctx) {
    const r = nodeRadius(node) + 2;
    ctx.fillStyle = color;
    if (node.cluster) { ctx.fillRect(node.x - r, node.y - r, r * 2, r * 2); return; }
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
    ctx.fill();
  }

  // ── Side panel ───────────────────────────────────────────────────────────

  function renderSide() {
    if (!state.graph) return;
    document.body.classList.toggle('has-selection', !!state.selected);
    const overview = document.getElementById('overview');
    const body = document.getElementById('details-body');
    const busy = !!state.selected;
    overview.hidden = busy;
    body.hidden = !busy;
    document.getElementById('details').setAttribute('aria-label', state.pathTarget ? 'Path details' : busy ? 'Selected file' : 'Project overview');
    if (state.pathTarget) renderPathDetails();
    else if (busy) renderDetails(state.selected);
    else renderOverview();
    renderPathBanner();
  }

  // One row component for every list of files: swatch or mark, file name,
  // muted directory, relation on the right, and optionally the evidence line.
  function refRow({ id, mark, rel, relClass, src, onClick, label }) {
    const b = el('button', 'ref');
    b.type = 'button';
    const top = el('span', 'top');
    if (mark) top.append(mark);
    if (label) top.append(label);
    else if (id) top.append(el('span', 'file', fileOf(id)), el('span', 'dir', dirOf(id)));
    if (rel) top.append(el('span', `rel ${relClass ?? ''}`, rel));
    b.append(top);
    if (id) b.title = id;
    if (src) b.append(srcLine(src.line, src.raw, src.mark));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // The evidence line: the line number and the source text that creates a
  // relation, with the name it references marked.
  function srcLine(line, raw, markName) {
    const box = el('span', 'src');
    box.append(el('span', 'ln', line ?? ''));
    const code = el('code');
    const text = String(raw ?? '');
    const at = markName ? text.indexOf(markName) : -1;
    if (at < 0) code.textContent = text;
    else code.append(text.slice(0, at), el('mark', '', markName), text.slice(at + markName.length));
    box.append(code);
    return box;
  }

  function markFor(id) {
    const n = state.nodesById.get(id);
    if (!n) return swatch(OTHER_HUE);
    if (n.missing) return MARK.missing();
    return swatch(colorForNode(n));
  }

  function renderOverview() {
    const g = state.graph;
    document.getElementById('ov-name').textContent = rootName();

    const unresolved = g.unresolved ?? [];
    const byReason = {};
    for (const u of unresolved) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;
    const reasons = Object.entries(byReason).map(([r, n]) => `${n} ${r}`).join(', ');
    const stats = [
      ['Files', fmt(g.nodes.length)],
      ['Links', fmt(g.edges.length)],
      ['Orphans', fmt(g.stats?.orphans ?? g.nodes.filter(n => n.orphan).length)],
      ['Unresolved', fmt(unresolved.length), reasons],
      ['Cycles', fmt(state.cycles.list.length), null, state.cycles.list.length > 0],
    ];
    const dl = document.getElementById('ov-stats');
    dl.replaceChildren();
    for (const [k, v, extra, crit] of stats) {
      const dd = el('dd', crit ? 'crit' : '', v);
      if (extra) dd.append(el('span', 'dim3', ` · ${extra}`));
      dl.append(el('dt', '', k), dd);
    }

    const entries = g.nodes.filter(n => n.entrypoint && !n.missing).sort((a, b) => b.out - a.out).slice(0, 5);
    const entryBox = document.getElementById('ov-entry');
    entryBox.replaceChildren(...entries.map(n => refRow({ id: n.id, mark: MARK.entry(colorForNode(n)), rel: `uses ${fmt(n.out)}`, onClick: () => selectNode(n.id) })));
    entryBox.hidden = document.getElementById('ov-entry-title').hidden = !entries.length;

    const hubs = g.nodes.filter(n => !n.missing && n.in > 0).sort((a, b) => b.in - a.in).slice(0, 3);
    const hubBox = document.getElementById('ov-hubs');
    hubBox.replaceChildren(...hubs.map(n => refRow({ id: n.id, mark: swatch(colorForNode(n)), rel: `used by ${fmt(n.in)}`, onClick: () => selectNode(n.id) })));
    hubBox.hidden = document.getElementById('ov-hubs-title').hidden = !hubs.length;
  }

  function detailsHead(dir, title, onClose, closeLabel) {
    const head = el('div', 'd-head');
    const row = el('div', 'd-title');
    const text = el('div');
    if (dir) text.append(el('div', 'd-dir', dir));
    text.append(el('h2', 'title', title));
    const close = el('button', 'btn quiet sq');
    close.type = 'button';
    close.setAttribute('aria-label', closeLabel);
    close.title = closeLabel;
    close.append(icon(ICON.close));
    close.addEventListener('click', onClose);
    row.append(text, close);
    head.append(row);
    return head;
  }

  function renderDetails(id) {
    const n = state.nodesById.get(id);
    const body = document.getElementById('details-body');
    body.replaceChildren();
    if (!n) return;

    const usedBy = state.graph.edges.filter(e => e.to === id);
    const uses = state.graph.edges.filter(e => e.from === id);

    const head = detailsHead(dirOf(n.id), fileOf(n.id), clearSelection, 'Clear selection (Esc)');
    const meta = el('div', 'd-meta');
    if (n.missing) {
      meta.append(MARK.missing(), 'Referenced, not on disk');
    } else {
      const bits = [`${cap(n.lang)} ${n.type}`, plural(n.loc, 'line'), `${(n.size / 1024).toFixed(1)} KB`];
      if (n.churn !== undefined) bits.push(plural(n.churn, 'commit'));
      meta.append(swatch(colorForNode(n)), bits.join(' · '));
    }
    head.append(meta);

    const scroll = el('div', 'd-scroll');
    scroll.append(impactSection(n, uses));

    // Tabs: Used by / Uses, each a list of rows with the evidence line.
    const tabs = el('div', 'tabs d-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Relations of this file');
    const panel = el('div', 'tabpanel');
    panel.setAttribute('role', 'tabpanel');
    const tabDefs = [['usedby', 'Used by', usedBy], ['uses', 'Uses', uses]];
    const tabButtons = tabDefs.map(([key, label, list]) => {
      const b = el('button', state.tab === key ? 'on' : '', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(state.tab === key));
      b.append(el('span', 'n mono', fmt(list.length)));
      b.addEventListener('click', () => { state.tab = key; renderDetails(id); });
      return b;
    });
    tabs.append(...tabButtons);
    if (state.tab === 'usedby') fillRefList(panel, usedBy, e => e.from, () => stemOf(n.id), 'No file references this one.');
    else fillRefList(panel, uses, e => e.to, e => stemOf(e.to), 'It references no other file.');
    scroll.append(tabs, panel);

    const actions = el('div', 'd-actions');
    const focusBtn = el('button', 'btn primary', state.focusId === id ? 'Exit focus' : 'Focus on this file');
    focusBtn.type = 'button';
    focusBtn.title = `Show only files within ${state.focusDepth} steps (${FOCUS_DIR_LABEL[state.focusDir]}); set under Filters › Focus`;
    focusBtn.addEventListener('click', () => {
      state.focusId = state.focusId === id ? null : id;
      setGraphData(buildGraphData());
      renderDetails(id);
      syncHash();
      if (state.focusId) setTimeout(() => fg.zoomToFit(400, 60), 400);
    });
    const copyBtn = el('button', 'btn', 'Copy path');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => flash(copyBtn, n.id, 'Copy path'));
    // The panel already holds exactly what an agent needs before an edit; this
    // hands it over in one click instead of a screenshot or five greps.
    const contextBtn = el('button', 'btn', 'Copy as context');
    contextBtn.type = 'button';
    contextBtn.title = 'Markdown summary of this file and its relations, for a coding agent';
    contextBtn.addEventListener('click', () => flash(contextBtn, contextMarkdown(n, usedBy, uses), 'Copy as context'));
    actions.append(focusBtn, copyBtn, contextBtn);

    body.append(head, scroll, actions);
  }

  function flash(btn, text, label) {
    navigator.clipboard?.writeText(text);
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = label; }, 1200);
  }

  // What a change to this file reaches: risk, the transitive dependents split
  // by type (the impact bar), and any defect that sits on this file itself.
  function impactSection(n, uses) {
    const sec = el('section', 'impact');
    sec.setAttribute('aria-label', 'Impact');
    const head = el('div', 'impact-head');
    const p = el('p');

    if (n.missing) {
      head.append(icon(ICON.warn, 'crit'), el('strong', '', 'Missing file'), el('span', 'dim3', `· ${plural(n.in, 'file')} reference it`));
      p.textContent = 'Each row under Used by is a line that points at a file that is not on disk.';
      sec.append(head, p);
      return sec;
    }

    const riskIcon = { high: icon(ICON.warn, 'crit'), medium: icon(ICON.warn, 'warn'), low: icon(ICON.ok, 'low') }[n.risk] ?? icon(ICON.ok, 'low');
    const why = n.risk === 'high' && n.entrypoint && n.in < 10 ? '· entrypoint'
      : n.risk === 'high' ? `· ${plural(n.in, 'direct dependent')}, limit 10`
      : `· ${plural(n.in, 'direct dependent')}`;
    head.append(riskIcon, el('strong', '', `${cap(n.risk)} risk`), el('span', 'dim3', why));
    sec.append(head);

    const affected = transitiveDependents(n.id);
    const direct = new Set(state.incoming.get(n.id) ?? []);
    direct.delete(n.id);
    const indirect = affected.size - direct.size;
    if (!affected.size) {
      p.textContent = 'Nothing references it, so changing it affects no other file.';
      sec.append(p);
    } else {
      p.append('Changing it can affect ', el('b', '', plural(affected.size, 'file')),
        indirect > 0 ? `, ${fmt(indirect)} of them through another file.` : ', all of them directly.');
      const byType = {};
      for (const id of affected) {
        const t = state.nodesById.get(id)?.type ?? 'unknown';
        byType[t] = (byType[t] ?? 0) + 1;
      }
      const groups = Object.entries(byType).sort((a, b) => b[1] - a[1]);
      const bar = el('div', 'ibar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', `${plural(affected.size, 'affected file')}: ${groups.map(([t, c]) => `${c} ${t}`).join(', ')}`);
      const legend = el('div', 'ilegend');
      for (const [t, c] of groups) {
        const seg = el('span');
        seg.style.flex = String(c);
        seg.style.background = colorForType(t);
        seg.dataset.swatchType = t;
        bar.append(seg);
        const item = el('span');
        item.append(swatch(colorForType(t), t), `${t} `, el('span', 'mono', fmt(c)));
        legend.append(item);
      }
      sec.append(p, bar, legend);
    }

    const notes = el('div', 'notes');
    if (state.cycles.nodes.has(n.id)) {
      notes.append(refRow({ mark: MARK.cycle(), label: el('span', '', 'Part of a dependency cycle'), rel: 'issues', onClick: () => openIssues('cycles') }));
    }
    if (n.deadExports?.length) {
      notes.append(refRow({ mark: MARK.unused(), label: el('span', '', `Unused exports: ${n.deadExports.join(', ')}`) }));
    }
    for (const e of uses.filter(e => state.nodesById.get(e.to)?.missing).slice(0, 3)) {
      const label = el('span');
      label.append(`Line ${e.line} points to `, el('span', 'mono', e.to), ', which is not on disk');
      notes.append(refRow({ mark: MARK.missing(), label, onClick: () => selectNode(e.to) }));
    }
    if (notes.childElementCount) sec.append(notes);
    return sec;
  }

  const LIST_SHOWN = 5;
  const LIST_WITH_SOURCE = 3;

  // The first three rows carry the source line; the rest give the line number
  // only, so a list of 40 stays scannable.
  function fillRefList(panel, list, otherIdFn, markNameFn, emptyText) {
    if (!list.length) { panel.append(el('div', 'empty', emptyText)); return; }
    const row = (e, i) => {
      const other = otherIdFn(e);
      const missing = !!state.nodesById.get(other)?.missing;
      const withSrc = i < LIST_WITH_SOURCE && e.raw;
      return refRow({
        id: other,
        mark: markFor(other),
        rel: missing ? `missing · ${e.line}` : withSrc ? e.rel : `${e.rel} · ${e.line}`,
        relClass: missing ? 'crit' : '',
        src: withSrc ? { line: e.line, raw: e.raw, mark: markNameFn(e) } : null,
        onClick: () => selectNode(other),
      });
    };
    list.slice(0, LIST_SHOWN).forEach((e, i) => panel.append(row(e, i)));
    if (list.length > LIST_SHOWN) {
      const more = el('button', 'btn quiet more', `Show ${fmt(list.length - LIST_SHOWN)} more`);
      more.type = 'button';
      more.addEventListener('click', () => {
        more.remove();
        list.slice(LIST_SHOWN).forEach((e, i) => panel.append(row(e, i + LIST_SHOWN)));
      });
      panel.append(more);
    }
  }

  function edgeBetween(a, b) {
    return state.graph.edges.find(e => e.from === a && e.to === b);
  }

  function renderPathDetails() {
    const body = document.getElementById('details-body');
    body.replaceChildren();
    const from = state.selected, to = state.pathTarget;

    if (!state.path) {
      const head = detailsHead('', 'No path', clearPath, 'Clear path (Esc)');
      head.classList.add('ruled');
      const sub = el('div', 'd-meta');
      sub.append(`${fileOf(from)} and ${fileOf(to)} do not reach each other in either direction.`);
      head.append(sub);
      const actions = el('div', 'd-actions');
      const sel = el('button', 'btn', `Select ${fileOf(to)}`);
      sel.type = 'button';
      sel.addEventListener('click', () => selectNode(to));
      const back = el('button', 'btn', `Back to ${fileOf(from)}`);
      back.type = 'button';
      back.addEventListener('click', clearPath);
      actions.append(sel, back);
      body.append(head, el('div', 'd-scroll'), actions);
      return;
    }

    const order = state.path.order;
    const hops = order.length - 1;
    const head = detailsHead('', `${fileOf(order[0])} → ${fileOf(order.at(-1))}`, clearPath, 'Clear path (Esc)');
    head.classList.add('ruled');
    const sub = el('div', 'd-meta', `Shortest path, ${plural(hops, 'hop')}. Each step is the line that makes the link.`);
    head.append(sub);

    const ol = el('ol', 'path-steps');
    order.forEach((id, i) => {
      const last = i === order.length - 1;
      const li = el('li');
      const rail = el('span', 'rail');
      rail.append(el('span', `dot ${i === 0 || last ? 'end' : ''}`));
      if (!last) rail.append(el('span', 'bar'));
      const step = el('div', 'step');
      step.title = id;
      const n = state.nodesById.get(id);
      const top = el('div', 'top');
      top.style.display = 'flex';
      top.style.alignItems = 'baseline';
      top.style.gap = '6px';
      top.append(el('span', 'name', fileOf(id)), el('span', 'dim3 small', `${dirOf(id)}${n?.risk === 'high' ? ' · high risk' : ''}${n?.missing ? ' · missing' : ''}`));
      step.append(top);
      if (!last) {
        const e = edgeBetween(id, order[i + 1]);
        if (e) {
          step.append(el('div', 'rel', e.rel));
          if (e.raw) step.append(srcLine(e.line, e.raw, stemOf(order[i + 1])));
        }
      }
      step.addEventListener('click', () => selectNode(id));
      li.append(rail, step);
      ol.append(li);
    });

    const actions = el('div', 'd-actions');
    const sel = el('button', 'btn', `Select ${fileOf(to)}`);
    sel.type = 'button';
    sel.addEventListener('click', () => selectNode(to));
    const copy = el('button', 'btn', 'Copy path as text');
    copy.type = 'button';
    copy.addEventListener('click', () => flash(copy, order.join(' → '), 'Copy path as text'));
    actions.append(sel, copy);

    body.append(head, ol, actions);
  }

  function renderPathBanner() {
    const banner = document.getElementById('path-banner');
    banner.hidden = !state.pathTarget;
    if (state.pathTarget) {
      const steps = document.getElementById('path-steps');
      const hops = document.getElementById('path-hops');
      if (state.path) {
        steps.textContent = state.path.order.map(fileOf).join(' → ');
        hops.textContent = plural(state.path.order.length - 1, 'hop');
      } else {
        steps.textContent = `No path between ${fileOf(state.selected)} and ${fileOf(state.pathTarget)}`;
        hops.textContent = '';
      }
    }
    renderPerfBanner();
  }

  function contextMarkdown(n, usedBy, uses) {
    const lines = [
      `## ${n.id}`,
      `- ${n.lang} ${n.type}, ${n.loc} loc, risk ${n.risk}${n.entrypoint ? ', entrypoint' : ''}${n.orphan ? ', orphan' : ''}`,
      `- ${n.in} dependents, ${n.out} dependencies`,
    ];
    if (n.churn !== undefined) lines.push(`- changed in ${n.churn} of the last commits`);
    if (n.deadExports?.length) lines.push(`- exports nothing imports: ${n.deadExports.join(', ')}`);
    if (state.cycles.nodes.has(n.id)) lines.push('- part of a dependency cycle');
    const refs = (title, list, pick) => {
      if (!list.length) return;
      lines.push('', `### ${title}`);
      for (const e of list.slice(0, 20)) lines.push(`- ${pick(e)}:${e.line} — ${e.rel} — \`${e.raw}\``);
      if (list.length > 20) lines.push(`- … ${list.length - 20} more`);
    };
    refs('Used by', usedBy, e => e.from);
    refs('Uses', uses, e => e.to);
    return lines.join('\n') + '\n';
  }

  // ── Status bar ───────────────────────────────────────────────────────────

  function issueCounts() {
    const g = state.graph;
    return {
      cycles: state.cycles.list.length,
      missing: g.nodes.filter(n => n.missing).length,
      unresolved: (g.unresolved ?? []).length,
      unused: g.nodes.filter(n => n.deadExports?.length).length,
      duplicates: (g.duplicates ?? []).length,
    };
  }

  function issueSummary(c) {
    return [
      c.cycles && plural(c.cycles, 'cycle'),
      c.missing && `${fmt(c.missing)} missing`,
      c.unresolved && `${fmt(c.unresolved)} unresolved`,
      c.unused && plural(c.unused, 'unused export'),
      c.duplicates && plural(c.duplicates, 'duplicate'),
    ].filter(Boolean).join(' · ');
  }

  function updateStatusBar() {
    const mid = document.getElementById('status-mid');
    const g = state.graph;
    mid.replaceChildren(`${plural(g.stats?.orphans ?? 0, 'orphan')} · ${fmt(g.stats?.unresolved ?? 0)} unresolved`);
    if (state.selected) {
      const n = state.nodesById.get(state.selected);
      if (n) mid.replaceChildren(el('b', '', fileOf(n.id)), ` · ${fmt(n.in)} in · ${fmt(n.out)} out`);
    }
    if (state.pathTarget) {
      mid.replaceChildren();
      if (state.path) mid.append('Path ', el('b', '', `${fileOf(state.path.order[0])} → ${fileOf(state.path.order.at(-1))}`), ` · ${plural(state.path.order.length - 1, 'hop')}`);
      else mid.append(`No path between ${fileOf(state.selected)} and ${fileOf(state.pathTarget)}`);
    }
    document.getElementById('status-right').textContent = `Scanned ${timeAgo(new Date(g.scannedAt))}`;

    const counts = issueCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const btn = document.getElementById('issues-btn');
    btn.replaceChildren(icon(total ? ICON.warn : ICON.ok), total ? plural(total, 'issue') : 'No issues');
    btn.classList.toggle('clean', !total);
    btn.title = total ? `${issueSummary(counts)} (I)` : 'Issues (I)';
  }

  function timeAgo(date) {
    const min = Math.floor((Date.now() - date.getTime()) / 60000);
    if (!Number.isFinite(min)) return '';
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 48) return `${hr} h ago`;
    return `${Math.floor(hr / 24)} days ago`;
  }

  // ── Issues panel ─────────────────────────────────────────────────────────

  // Everything the scan already knows is wrong: references it could not
  // resolve, cycles it proved, and files it could not read.
  function openIssues(scrollTo) {
    const panel = document.getElementById('issues');
    panel.hidden = false;
    document.getElementById('issues-btn').setAttribute('aria-pressed', 'true');
    renderIssues();
    if (scrollTo) document.getElementById(`issues-${scrollTo}`)?.scrollIntoView({ block: 'start' });
  }

  function closeIssues() {
    document.getElementById('issues').hidden = true;
    document.getElementById('issues-btn').setAttribute('aria-pressed', 'false');
  }

  function toggleIssues() {
    if (document.getElementById('issues').hidden) openIssues(); else closeIssues();
  }

  const ISSUE_LIMIT = 100;

  function renderIssues() {
    const body = document.getElementById('issues-body');
    body.replaceChildren();
    const g = state.graph;
    const counts = issueCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    document.getElementById('issues-count').textContent = fmt(total);
    document.getElementById('issues-summary').textContent = issueSummary(counts);

    const section = (id, title, extra) => {
      const h = el('h3', 'h', title);
      h.id = id;
      if (extra) h.append(el('span', 'dim3', ` ${extra}`));
      body.append(h);
    };
    const more = (n) => { if (n > ISSUE_LIMIT) body.append(el('div', 'empty', `… and ${fmt(n - ISSUE_LIMIT)} more in graph.json`)); };

    if (state.cycles.list.length) {
      section('issues-cycles', 'Cycles');
      for (const files of state.cycles.list) {
        const r = refRow({ mark: MARK.cycle(), label: el('span', 'chain', files.map(fileOf).join(' → ')), onClick: () => selectNode(files[0]) });
        r.title = files.join(' → ');
        body.append(r);
      }
    }

    const missing = g.nodes.filter(n => n.missing);
    if (missing.length) {
      section('issues-missing', 'Missing files');
      for (const n of missing.slice(0, ISSUE_LIMIT)) {
        const ref = edgeTo(n.id);
        body.append(refRow({ id: n.id, mark: MARK.missing(), rel: ref ? `${fileOf(ref.from)}:${ref.line}` : '', onClick: () => selectNode(n.id) }));
      }
      more(missing.length);
    }

    const unresolved = g.unresolved ?? [];
    if (unresolved.length) {
      const byReason = {};
      for (const u of unresolved) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;
      section('issues-unresolved', 'Unresolved', Object.entries(byReason).map(([r, n]) => `${n} ${r}`).join(' · '));
      // Anything the scan could not point at a file is here; past a hundred
      // rows the list stops being read and starts being scrolled.
      for (const u of unresolved.slice(0, ISSUE_LIMIT)) {
        const r = refRow({
          label: el('span', 'chain', `${fileOf(u.from)}:${u.line}`),
          rel: `${u.rel} · ${u.reason}`,
          src: u.raw ? { line: u.line, raw: u.raw } : null,
          onClick: () => selectNode(u.from),
        });
        r.title = u.from;
        if (u.hint) r.append(el('span', 'note', u.hint));
        body.append(r);
      }
      more(unresolved.length);
    }

    const dead = g.nodes.filter(n => n.deadExports?.length);
    if (dead.length) {
      section('issues-dead', 'Unused exports');
      for (const n of dead.slice(0, ISSUE_LIMIT)) {
        const r = refRow({ id: n.id, mark: swatch(colorForNode(n)), onClick: () => selectNode(n.id) });
        r.append(el('span', 'sub', n.deadExports.join(', ')));
        body.append(r);
      }
      more(dead.length);
    }

    const duplicates = g.duplicates ?? [];
    if (duplicates.length) {
      section('issues-duplicates', 'Duplicate files');
      for (const group of duplicates.slice(0, ISSUE_LIMIT)) {
        const r = refRow({ label: el('span', 'chain', group.map(fileOf).join(' = ')), onClick: () => selectNode(group[0]) });
        r.append(el('span', 'note', group.join('  ·  ')));
        body.append(r);
      }
      more(duplicates.length);
    }

    const warnings = (g.warnings ?? []).filter(w => w.code !== 'cycle');
    if (warnings.length) {
      section('issues-warnings', 'Warnings');
      for (const w of warnings.slice(0, ISSUE_LIMIT)) {
        const r = refRow({ label: el('span', 'file', w.file || '(project)'), rel: w.code, onClick: w.file ? () => selectNode(w.file) : null });
        r.append(el('span', 'note', w.message));
        body.append(r);
      }
      more(warnings.length);
    }

    if (!body.childElementCount) {
      body.append(el('div', 'empty', 'Nothing unresolved, no cycles, no missing files, no duplicates, no unused exports.'));
    }
  }

  function edgeTo(id) {
    return state.graph.edges.find(e => e.to === id);
  }

  function applyFilters() {
    setGraphData(buildGraphData());
    refreshHighlight();
  }

  // ── Search ───────────────────────────────────────────────────────────────

  const SEARCH_LIMIT = 20;
  let searchMatches = [];

  // Jumping straight to the first match was wrong more often than right: with
  // ten files called index.ts, the one you want is rarely the alphabetically
  // first. Show the matches and let the keyboard or the click decide.
  function doSearch(q) {
    state.search = q.trim().toLowerCase();
    state.searchActive = 0;
    const box = document.getElementById('search-results');
    const input = document.getElementById('search');
    box.replaceChildren();
    if (!state.search) { box.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }

    searchMatches = state.graph.nodes
      .filter(n => n.id.toLowerCase().includes(state.search))
      .sort((a, b) => b.in - a.in || (a.id < b.id ? -1 : 1));

    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (!searchMatches.length) {
      box.append(el('div', 'none', `No file path contains ‘${q.trim()}’.`));
      return;
    }
    searchMatches.slice(0, SEARCH_LIMIT).forEach((n, i) => {
      const opt = el('div', 'opt');
      opt.id = `search-opt-${i}`;
      opt.setAttribute('role', 'option');
      opt.title = n.id;
      const name = el('span', 'name');
      const file = fileOf(n.id);
      const at = file.toLowerCase().indexOf(state.search);
      if (at < 0) name.textContent = file;
      else name.append(file.slice(0, at), el('b', '', file.slice(at, at + state.search.length)), file.slice(at + state.search.length));
      opt.append(markFor(n.id), name, el('span', 'dir', dirOf(n.id)), el('span', 'n', i === 0 ? plural(n.in, 'dependent') : fmt(n.in)));
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus so Escape still closes the list
        pickSearchResult(i);
      });
      opt.addEventListener('mousemove', () => { if (state.searchActive !== i) { state.searchActive = i; syncSearchActive(); } });
      box.append(opt);
    });
    const foot = el('div', 'foot');
    if (searchMatches.length > SEARCH_LIMIT) foot.append(el('span', '', `${fmt(searchMatches.length - SEARCH_LIMIT)} more`));
    const keys = el('span', 'keys');
    keys.append(el('span', 'kbd', '↑'), ' ', el('span', 'kbd', '↓'), ' move  ', el('span', 'kbd', '↵'), ' select');
    foot.append(keys);
    box.append(foot);
    syncSearchActive();
  }

  function syncSearchActive() {
    const opts = document.getElementById('search-results').querySelectorAll('.opt');
    opts.forEach((o, i) => {
      o.classList.toggle('active', i === state.searchActive);
      o.setAttribute('aria-selected', String(i === state.searchActive));
    });
    opts[state.searchActive]?.scrollIntoView({ block: 'nearest' });
    document.getElementById('search').setAttribute('aria-activedescendant', opts.length ? `search-opt-${state.searchActive}` : '');
  }

  function pickSearchResult(i) {
    const n = searchMatches[i];
    if (!n) return;
    document.getElementById('search-results').hidden = true;
    const input = document.getElementById('search');
    input.setAttribute('aria-expanded', 'false');
    input.blur();
    selectNode(n.id);
    centerOn(n.id);
  }

  function centerOn(id) {
    const node = fg.graphData().nodes.find(x => x.id === id);
    if (node && Number.isFinite(node.x)) fg.centerAt(node.x, node.y, 400);
  }

  // ── Banners ──────────────────────────────────────────────────────────────

  function checkPerfBanner() {
    if (state.graph.nodes.length > 5000) state.typeFilters.delete('asset');
  }

  function renderPerfBanner() {
    const banner = document.getElementById('perf-banner');
    if (banner.dataset.sticky) return;
    const n = state.graph.nodes.length;
    // One banner at a time over the top of the canvas: a traced path wins.
    if (n <= 2000 || state.perfDismissed || state.pathTarget) { banner.hidden = true; return; }
    const text = document.getElementById('perf-text');
    text.replaceChildren(el('b', '', plural(n, 'file')),
      state.groupBy ? ' — opened grouped by folder.' : ' —',
      ' Labels show only on files with 10+ dependents.',
      n > 5000 ? ' Asset files are hidden.' : '');
    document.getElementById('perf-ungroup').hidden = !state.groupBy;
    banner.hidden = false;
  }

  // A banner that outranks everything else, e.g. "reloading".
  function showBanner(message) {
    const banner = document.getElementById('perf-banner');
    banner.dataset.sticky = '1';
    document.getElementById('perf-text').textContent = message;
    document.getElementById('perf-ungroup').hidden = true;
    document.getElementById('path-banner').hidden = true;
    banner.hidden = false;
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  const COLOR_MODES = ['type', 'language', 'directory', 'risk'];

  function wireTopLevelUI() {
    const search = document.getElementById('search');
    const results = document.getElementById('search-results');
    const searchKbd = document.getElementById('search-kbd');
    search.addEventListener('input', () => doSearch(search.value));
    search.addEventListener('focus', () => { searchKbd.textContent = 'Esc'; if (search.value.trim()) doSearch(search.value); });
    search.addEventListener('blur', () => { searchKbd.textContent = '/'; results.hidden = true; search.setAttribute('aria-expanded', 'false'); });
    search.addEventListener('keydown', (e) => {
      const count = Math.min(searchMatches.length, SEARCH_LIMIT);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!count || results.hidden) return;
        state.searchActive = (state.searchActive + (e.key === 'ArrowDown' ? 1 : -1) + count) % count;
        syncSearchActive();
      } else if (e.key === 'Enter') {
        if (!results.hidden) pickSearchResult(state.searchActive);
      } else if (e.key === 'Escape') {
        results.hidden = true;
      }
    });

    document.getElementById('refresh-btn').addEventListener('click', () => location.reload());

    const filters = document.getElementById('filters');
    const toggle = document.getElementById('filters-toggle');
    toggle.addEventListener('click', () => {
      const open = filters.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });

    for (const b of document.querySelectorAll('#theme-btn button')) {
      b.addEventListener('click', () => {
        state.theme = b.dataset.themeValue;
        savePersisted();
        applyTheme();
      });
    }
    for (const b of document.querySelectorAll('#layout-seg button')) {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    }

    document.getElementById('zoom-in').addEventListener('click', () => fg.zoom(fg.zoom() * 1.4, 200));
    document.getElementById('zoom-out').addEventListener('click', () => fg.zoom(fg.zoom() / 1.4, 200));
    document.getElementById('zoom-fit').addEventListener('click', () => fg.zoomToFit(400, 40));

    document.getElementById('path-clear').addEventListener('click', clearPath);
    document.getElementById('perf-dismiss').addEventListener('click', () => {
      state.perfDismissed = true;
      delete document.getElementById('perf-banner').dataset.sticky;
      renderPerfBanner();
    });
    document.getElementById('perf-ungroup').addEventListener('click', () => setGroupBy(0));

    const help = document.getElementById('help');
    const toggleHelp = () => { help.hidden = !help.hidden; };
    document.getElementById('help-btn').addEventListener('click', toggleHelp);
    help.addEventListener('click', () => { help.hidden = true; });

    document.getElementById('issues-btn').addEventListener('click', toggleIssues);
    document.getElementById('issues-close').addEventListener('click', closeIssues);

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); search.focus(); }
        return;
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === '/') {
        e.preventDefault();
        search.focus();
      } else if (key === '?') {
        toggleHelp();
      } else if (key === 'Escape') {
        if (!help.hidden) help.hidden = true;
        else if (filters.classList.contains('open')) { filters.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }
        else if (state.pathTarget) clearPath();
        else clearSelection();
      } else if (key === 'i') {
        toggleIssues();
      } else if (key === 'c') {
        const next = COLOR_MODES[(COLOR_MODES.indexOf(state.colorBy) + 1) % COLOR_MODES.length];
        document.getElementById('color-by').value = next;
        setColorBy(next);
      } else if (key === 'f') {
        fg.zoomToFit(400, 40);
      } else if (key === 'g') {
        setMode('galaxy');
      } else if (key === 't') {
        setMode('tree');
      }
    });
  }

  main().catch(e => showState('error', 'Could not load the graph', e.message));
})();
