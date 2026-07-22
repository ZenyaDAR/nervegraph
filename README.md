# nervegraph

> Obsidian Graph View, but for source code.
> One command scans the project, another opens an interactive relationship map in the browser.

```bash
npx nervegraph scan     # → .nervegraph/graph.json
npx nervegraph view     # → http://localhost:4210
```

**First target — Shopify themes.** JS/TS projects next.

---

## Why

Open someone else's 60,000-line theme and understand its architecture in 10 seconds.
See who uses a file before deleting it. See what breaks before editing a snippet.

A useful side effect: `graph.json` is machine-readable, so an AI agent (Claude Code, Cursor)
can read the map instead of grepping the whole repo.

---

## Key decisions (locked in)

| Question | Decision | Why |
|--------|---------|-----|
| Package name | `nervegraph`, binary `nerve` | Checked for availability on npm before publishing |
| Runtime | Node ≥ 20, TypeScript, ESM | LTS |
| Argument parser | `node:util` → `parseArgs` | Stdlib, commander not needed |
| HTTP server | `node:http` | 3 static files, express not needed |
| Liquid | Regex over tags, not a full AST | Reference tags are trivially regular |
| JS | `es-module-lexer` + regex for `require` | A full Babel AST is overkill for v0.1 |
| CSS | `postcss` | Correctly extracts `@import` and selectors |
| Visualization | `force-graph` (vasturiano), canvas | Drag, zoom, highlight, 5k+ nodes out of the box |
| Frontend framework | None. Vanilla JS + one HTML file | The detail panel is 150 lines of DOM |
| Storage | A single `graph.json` | SQLite at 100k+ nodes, not before |

Rationale for each — in `docs/06-architecture.md` (internal spec, not tracked in this repo).
