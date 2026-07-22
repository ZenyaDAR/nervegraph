/* global ForceGraph */
// Color values mirror COLOR_SCHEME.md — change there first, then here.
(() => {
  const TYPE_COLOR = {
    dark: {
      section: '#3987e5', section_group: '#3987e5', python: '#3987e5',
      layout: '#d95926', html: '#d95926',
      snippet: '#199e70', rust: '#199e70',
      javascript: '#c98500',
      template: '#d55181', template_json: '#d55181',
      block: '#008300', ruby: '#008300',
      css: '#9085e9',
      json: '#e66767',
      asset: '#898781', unknown: '#898781',
    },
    light: {
      section: '#2a78d6', section_group: '#2a78d6', python: '#2a78d6',
      layout: '#eb6834', html: '#eb6834',
      snippet: '#1baf7a', rust: '#1baf7a',
      javascript: '#eda100',
      template: '#e87ba4', template_json: '#e87ba4',
      block: '#008300', ruby: '#008300',
      css: '#4a3aa7',
      json: '#e34948',
      asset: '#898781', unknown: '#898781',
    },
  };

  const REL_COLOR = {
    dark: {
      render: '#4a5568', include: '#4a5568', section: '#4a5568',
      section_group: '#4a5568', template_section: '#4a5568', content_for: '#4a5568',
      rust_mod: '#4a5568',
      import: '#5a6478', require: '#5a6478', dynamic_import: '#5a6478', css_import: '#5a6478',
      py_import: '#5a6478', rb_require: '#5a6478', rb_require_relative: '#5a6478',
      asset: '#3f4a5a', asset_url: '#3f4a5a', script_src: '#3f4a5a', link_href: '#3f4a5a',
      class_usage: '#4a4458',
      translation: '#3f4a5a',
    },
    light: {
      render: '#9096a6', include: '#9096a6', section: '#9096a6',
      section_group: '#9096a6', template_section: '#9096a6', content_for: '#9096a6',
      rust_mod: '#9096a6',
      import: '#9aa3b8', require: '#9aa3b8', dynamic_import: '#9aa3b8', css_import: '#9aa3b8',
      py_import: '#9aa3b8', rb_require: '#9aa3b8', rb_require_relative: '#9aa3b8',
      asset: '#7c8794', asset_url: '#7c8794', script_src: '#7c8794', link_href: '#7c8794',
      class_usage: '#9b8fae',
      translation: '#7c8794',
    },
  };

  const STATUS_CRITICAL = '#d03b3b';
  // Code-level imports are dashed; structural inclusion (Liquid render, Rust
  // `mod`) stays solid, because it defines the file tree rather than using it.
  const DASHED_RELS = new Set([
    'import', 'require', 'dynamic_import', 'css_import', 'class_usage',
    'py_import', 'rb_require', 'rb_require_relative',
  ]);
  // Mirrors app.css's `@media (prefers-color-scheme: light)` block exactly:
  // light only when explicitly matched, dark otherwise (the project default,
  // including the "no preference reported" case — see docs/05-viewer.md §5.8).
  const lightModeQuery = window.matchMedia?.('(prefers-color-scheme: light)');

  function mode() {
    return lightModeQuery?.matches ? 'light' : 'dark';
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  let themeColors = readThemeColors();
  function readThemeColors() {
    return { pillBg: cssVar('--label-pill-bg'), ink: cssVar('--text') };
  }

  const state = {
    graph: null,
    nodesById: new Map(),
    typeFilters: new Set(),
    relFilters: new Set(),
    onlyOrphans: false,
    onlyRisk: false,
    onlyMissing: false,
    search: '',
    selected: null,
    hovered: null,
    mode: 'galaxy',
    focusId: null,
    visibleNodeCount: 0,
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
      }));
    } catch { /* ignore */ }
  }

  function fatal(message) {
    const banner = document.getElementById('perf-banner');
    banner.textContent = message;
    banner.hidden = false;
  }

  async function main() {
    const res = await fetch('/graph.json');
    // The server answers a missing graph with a plain-text hint, not JSON —
    // parsing it blind threw into an unhandled rejection and left a blank page.
    if (!res.ok) {
      fatal((await res.text().catch(() => '')).trim() || `could not load graph.json (${res.status})`);
      return;
    }
    const graph = await res.json();
    state.graph = graph;
    for (const n of graph.nodes) state.nodesById.set(n.id, n);

    const allTypes = new Set(graph.nodes.map(n => n.type));
    const allRels = new Set(graph.edges.map(e => e.rel));

    const persisted = loadPersisted();
    state.typeFilters = new Set(persisted?.typeFilters ?? [...allTypes].filter(t => t !== 'asset'));
    state.relFilters = new Set(persisted?.relFilters ?? [...allRels].filter(r => r !== 'translation' && r !== 'class_usage'));
    state.mode = persisted?.mode ?? 'galaxy';

    document.getElementById('root-name').textContent = graph.root.split(/[\\/]/).pop();
    document.getElementById('counts').textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`;
    document.getElementById('mode-indicator').textContent = state.mode;

    // Before the UI is built: it may drop the `asset` filter, and the checkbox
    // and the initial graph data both have to be built from the final filter set.
    checkPerfBanner();
    buildFilterUI(allTypes, allRels);
    buildGraphInstance();
    updateStatusBar();
    wireTopLevelUI();

    lightModeQuery?.addEventListener?.('change', () => {
      themeColors = readThemeColors();
      refreshHighlight();
    });
  }

  function buildFilterUI(allTypes, allRels) {
    const typeCounts = {};
    for (const n of state.graph.nodes) typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1;
    const typeBox = document.getElementById('type-filters');
    for (const t of [...allTypes].sort()) {
      const label = document.createElement('label');
      const swatch = document.createElement('span');
      swatch.className = 'type-swatch';
      swatch.style.background = colorForType(t);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.typeFilters.has(t);
      cb.addEventListener('change', () => {
        cb.checked ? state.typeFilters.add(t) : state.typeFilters.delete(t);
        savePersisted();
        applyFilters();
      });
      label.append(cb, swatch, ` ${t} `, span(typeCounts[t]));
      typeBox.appendChild(label);
    }

    const relBox = document.getElementById('rel-filters');
    for (const r of [...allRels].sort()) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.relFilters.has(r);
      cb.addEventListener('change', () => {
        cb.checked ? state.relFilters.add(r) : state.relFilters.delete(r);
        savePersisted();
        applyFilters();
      });
      label.append(cb, ` ${r}`);
      relBox.appendChild(label);
    }

    const orphanCount = state.graph.nodes.filter(n => n.orphan).length;
    const riskCount = state.graph.nodes.filter(n => n.risk === 'high').length;
    const missingCount = state.graph.nodes.filter(n => n.missing).length;
    document.getElementById('count-orphans').textContent = orphanCount;
    document.getElementById('count-risk').textContent = riskCount;
    document.getElementById('count-missing').textContent = missingCount;

    document.getElementById('only-orphans').addEventListener('change', (e) => { state.onlyOrphans = e.target.checked; applyFilters(); });
    document.getElementById('only-risk').addEventListener('change', (e) => { state.onlyRisk = e.target.checked; applyFilters(); });
    document.getElementById('only-missing').addEventListener('change', (e) => { state.onlyMissing = e.target.checked; applyFilters(); });
  }

  function span(text) {
    const s = document.createElement('span');
    s.textContent = text;
    s.style.color = 'var(--text-dim)';
    s.style.marginLeft = 'auto';
    return s;
  }

  let fg;

  function visibleNodeIds() {
    const ids = new Set();
    for (const n of state.graph.nodes) {
      if (!state.typeFilters.has(n.type)) continue;
      if (state.onlyOrphans && !n.orphan) continue;
      if (state.onlyRisk && n.risk !== 'high') continue;
      if (state.onlyMissing && !n.missing) continue;
      ids.add(n.id);
    }
    if (state.focusId) {
      const subgraph = subgraphAround(state.focusId, 2);
      for (const id of [...ids]) if (!subgraph.has(id)) ids.delete(id);
    }
    return ids;
  }

  function subgraphAround(id, depth) {
    const visited = new Set([id]);
    let frontier = [id];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const f of frontier) {
        for (const e of state.graph.edges) {
          if (e.from === f && !visited.has(e.to)) { visited.add(e.to); next.push(e.to); }
          if (e.to === f && !visited.has(e.from)) { visited.add(e.from); next.push(e.from); }
        }
      }
      frontier = next;
    }
    return visited;
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
    return { nodes, links: [...byPair.values()] };
  }

  function setGraphData(data) {
    state.visibleNodeCount = data.nodes.length;
    fg.graphData(data);
  }

  function nodeRadius(n) {
    return 4 + Math.min(12, Math.sqrt(n.in) * 2.5);
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

  function buildGraphInstance() {
    const el = document.getElementById('graph');
    fg = ForceGraph()(el)
      .graphData(buildGraphData())
      .nodeId('id')
      .nodeLabel(n => n.id)
      .nodeCanvasObjectMode(() => 'replace')
      .nodeCanvasObject(drawNode)
      .nodePointerAreaPaint(paintNodePointerArea)
      .linkColor(l => colorForLink(l))
      .linkLineDash(l => DASHED_RELS.has(l.rel) ? [3, 2] : null)
      .linkWidth(l => 1 + Math.min(3, (l._count ?? 1) - 1))
      .linkDirectionalArrowLength(3)
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalParticles(l => isHighlighted(l) ? 2 : 0)
      .linkDirectionalParticleWidth(2)
      .onNodeClick(handleNodeClick)
      .onNodeHover(handleNodeHover)
      .onBackgroundClick(clearSelection)
      .onNodeDragEnd(n => { n.fx = n.x; n.fy = n.y; })
      .cooldownTime(4000)
      .d3AlphaDecay(0.03)
      .d3VelocityDecay(0.4);

    state.visibleNodeCount = fg.graphData().nodes.length;

    // Hub nodes (high in-degree) draw a wide label pill that plain -180
    // charge doesn't push clear of neighbors — scale repulsion by the node's
    // own radius so busy hubs shove their surrounding cluster further out.
    fg.d3Force('charge').strength(n => -180 - nodeRadius(n) * 20).distanceMax(500);
    fg.d3Force('link').distance(70).strength(0.4);
    fg.d3Force('center').strength(0.05);

    applyMode();
    window.addEventListener('resize', () => fg.width(el.clientWidth).height(el.clientHeight));
    fg.width(el.clientWidth).height(el.clientHeight);
  }

  function applyMode() {
    fg.dagMode(state.mode === 'tree' ? 'td' : null);
    document.getElementById('mode-indicator').textContent = state.mode;
  }

  function colorForType(type) {
    const table = TYPE_COLOR[mode()];
    return table[type] ?? table.unknown;
  }
  function colorForNode(n) {
    return colorForType(n.type);
  }
  function colorForLink(l) {
    return REL_COLOR[mode()][l.rel] ?? REL_COLOR[mode()].render;
  }

  function isHighlighted(link) {
    if (!state.selected && !state.hovered) return false;
    const active = state.selected ?? state.hovered;
    return link.from === active || link.to === active;
  }

  function handleNodeHover(node) {
    state.hovered = node ? node.id : null;
    refreshHighlight();
  }

  function handleNodeClick(node) {
    selectNode(node.id);
  }

  function selectNode(id) {
    state.selected = id;
    refreshHighlight();
    renderDetails(id);
    updateStatusBar();
  }

  function clearSelection() {
    state.selected = null;
    closeDetails();
    refreshHighlight();
    updateStatusBar();
  }

  // Node/link colors are computed fresh from `state` on every canvas frame
  // (see drawNode/colorForLink), so "refreshing the highlight" is really just
  // forcing force-graph to repaint with the current selection/hover state.
  function refreshHighlight() {
    fg.linkColor(l => {
      const c = colorForLink(l);
      const active = state.selected ?? state.hovered;
      if (!active) return c;
      return (l.from === active || l.to === active) ? c : dim(c);
    });
    fg.linkDirectionalParticles(l => isHighlighted(l) ? 2 : 0);
  }

  function dim(hex) {
    return hex + '1f'; // ~12% alpha
  }

  // --- Canvas node rendering: circle + entrypoint ring + missing dash +
  // an always-legible basename label (see COLOR_SCHEME.md "Node label pill").
  // Density rules match docs/05-viewer.md §5.7's performance table.
  function drawNode(node, ctx, globalScale) {
    const r = nodeRadius(node);
    const active = state.selected ?? state.hovered;
    const neigh = active ? neighborsOfCached(active) : null;
    const isNeighbor = active && (node.id === active || neigh.out.has(node.id) || neigh.inc.has(node.id));
    const dimmed = active && !isNeighbor;
    const baseColor = node.missing ? STATUS_CRITICAL : colorForNode(node);
    const color = dimmed ? dim(baseColor) : baseColor;

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

    if (!dimmed && (isNeighbor || shouldLabel(node, globalScale))) {
      drawLabel(node, ctx, globalScale, r);
    }
  }

  function shouldLabel(node, globalScale) {
    const n = state.visibleNodeCount;
    if (n <= 500) return true;
    if (n <= 2000) return globalScale >= 1.2 || node.in >= 10;
    return node.in >= 10;
  }

  function drawLabel(node, ctx, globalScale, r) {
    const label = basename(node.id);
    const fontSize = Math.max(11 / globalScale, 1.6);
    ctx.font = `${fontSize}px -apple-system, Segoe UI, sans-serif`;
    const textWidth = ctx.measureText(label).width;
    const padX = 4 / globalScale;
    const padY = 2 / globalScale;
    const boxW = textWidth + padX * 2;
    const boxH = fontSize + padY * 2;
    const top = node.y + r + 2 / globalScale;

    roundRectPath(ctx, node.x - boxW / 2, top, boxW, boxH, 3 / globalScale);
    ctx.fillStyle = themeColors.pillBg;
    ctx.fill();

    ctx.fillStyle = themeColors.ink;
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
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeRadius(node) + 2, 0, 2 * Math.PI, false);
    ctx.fill();
  }

  function renderDetails(id) {
    const n = state.nodesById.get(id);
    const body = document.getElementById('details-body');
    if (!n) { body.innerHTML = ''; return; }

    const usedBy = state.graph.edges.filter(e => e.to === id);
    const uses = state.graph.edges.filter(e => e.from === id);

    body.replaceChildren();

    const h3 = document.createElement('h3');
    h3.textContent = n.id;
    body.appendChild(h3);

    const typeLine = document.createElement('div');
    typeLine.className = 'type-line';
    const swatch = document.createElement('span');
    swatch.className = 'type-swatch';
    swatch.style.background = colorForType(n.type);
    typeLine.append(swatch, ` ${n.lang} ${n.type} · ${n.loc} loc · ${(n.size / 1024).toFixed(1)} KB`);
    body.appendChild(typeLine);

    if (n.missing) {
      const warn = document.createElement('div');
      warn.className = 'risk-box missing';
      warn.textContent = `⚠ file does not exist, but ${n.in} file(s) reference it`;
      body.appendChild(warn);
    } else {
      const riskBox = document.createElement('div');
      riskBox.className = `risk-box ${n.risk}`;
      riskBox.innerHTML = '';
      const left = document.createElement('span');
      left.textContent = `RISK ${n.risk.toUpperCase()}`;
      const right = document.createElement('span');
      right.textContent = `${n.in} dependents`;
      riskBox.append(left, right);
      body.appendChild(riskBox);
    }

    appendRefList(body, `USED BY (${usedBy.length})`, usedBy, e => e.from);
    appendRefList(body, `USES (${uses.length})`, uses, e => e.to);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const focusBtn = document.createElement('button');
    focusBtn.textContent = state.focusId === id ? 'exit focus' : 'focus subgraph';
    focusBtn.addEventListener('click', () => {
      state.focusId = state.focusId === id ? null : id;
      setGraphData(buildGraphData());
      renderDetails(id);
    });
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'copy path';
    copyBtn.addEventListener('click', () => navigator.clipboard?.writeText(n.id));
    actions.append(focusBtn, copyBtn);
    body.appendChild(actions);

    document.getElementById('details').classList.remove('closed');
  }

  function appendRefList(body, title, list, otherIdFn) {
    const t = document.createElement('div');
    t.className = 'section-title';
    t.textContent = title;
    body.appendChild(t);

    const shown = list.slice(0, 5);
    shown.forEach((e, i) => {
      const item = document.createElement('div');
      item.className = 'ref-item';
      const file = document.createElement('div');
      file.className = 'ref-file';
      file.textContent = otherIdFn(e);
      const meta = document.createElement('div');
      meta.className = 'ref-meta';
      meta.textContent = `${e.rel} · line ${e.line}`;
      item.append(file, meta);
      if (i < 3) {
        const raw = document.createElement('div');
        raw.className = 'ref-raw';
        raw.textContent = e.raw;
        item.appendChild(raw);
      }
      item.addEventListener('click', () => selectNode(otherIdFn(e)));
      body.appendChild(item);
    });

    if (list.length > 5) {
      const more = document.createElement('button');
      more.className = 'more-btn';
      more.textContent = `… show ${list.length - 5} more`;
      more.addEventListener('click', () => {
        more.remove();
        list.slice(5).forEach(e => {
          const item = document.createElement('div');
          item.className = 'ref-item';
          const file = document.createElement('div');
          file.className = 'ref-file';
          file.textContent = otherIdFn(e);
          const meta = document.createElement('div');
          meta.className = 'ref-meta';
          meta.textContent = `${e.rel} · line ${e.line}`;
          item.append(file, meta);
          item.addEventListener('click', () => selectNode(otherIdFn(e)));
          body.appendChild(item);
        });
      });
      body.appendChild(more);
    }
  }

  function closeDetails() {
    document.getElementById('details-body').innerHTML = '<p class="hint">Click a node to see its details.</p>';
  }

  function updateStatusBar() {
    const mid = document.getElementById('status-mid');
    const right = document.getElementById('status-right');
    const orphans = state.graph.stats.orphans;
    const unresolved = state.graph.stats.unresolved;
    mid.textContent = `${orphans} orphans · ${unresolved} unresolved`;
    const scanned = new Date(state.graph.scannedAt);
    right.textContent = `scanned ${timeAgo(scanned)}`;

    if (state.selected) {
      const n = state.nodesById.get(state.selected);
      if (n) mid.textContent = `${n.id.split('/').pop()} · ${n.in} in · ${n.out} out`;
    }
  }

  function timeAgo(date) {
    const ms = Date.now() - date.getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    return `${hr}h ago`;
  }

  function applyFilters() {
    setGraphData(buildGraphData());
    refreshHighlight();
  }

  function doSearch(q) {
    state.search = q.toLowerCase();
    if (!state.search) return;
    const match = state.graph.nodes.find(n => n.id.toLowerCase().includes(state.search));
    if (match) selectNode(match.id);
  }

  function checkPerfBanner() {
    const n = state.graph.nodes.length;
    const banner = document.getElementById('perf-banner');
    if (n > 5000) {
      banner.textContent = 'graph is large, enable filters to improve performance';
      banner.hidden = false;
      state.typeFilters.delete('asset');
    } else if (n > 2000) {
      banner.textContent = 'large graph: labels limited to high in-degree nodes, particles disabled';
      banner.hidden = false;
    }
  }

  function wireTopLevelUI() {
    const search = document.getElementById('search');
    search.addEventListener('input', () => doSearch(search.value));
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(search.value); });

    document.getElementById('details-close').addEventListener('click', clearSelection);
    document.getElementById('refresh-btn').addEventListener('click', () => location.reload());
    document.getElementById('filters-toggle').addEventListener('click', () => {
      document.getElementById('filters').classList.toggle('open');
    });

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        search.focus();
      } else if (e.key === 'Escape') {
        clearSelection();
      } else if (e.key === 'f') {
        fg.zoomToFit(400, 40);
      } else if (e.key === 'g' || e.key === 't') {
        state.mode = state.mode === 'galaxy' ? 'tree' : 'galaxy';
        savePersisted();
        applyMode();
      }
    });
  }

  main().catch(e => fatal(`could not load graph.json: ${e.message}`));
})();
