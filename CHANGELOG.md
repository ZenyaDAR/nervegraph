# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/), versioning per [SemVer](https://semver.org/).

## [0.5.0] — 2026-11-10

Agent-facing: answers small enough for a context window, and the questions an
agent asks first. `graph.json` stays on schema 4.

### Added
- **`nerve overview [--json]`** — languages, top folders, entrypoints, hub and
  fan-out files, cycle/missing/orphan/unresolved counts, staleness and the next
  commands to try, in about a kilobyte.
- **`nerve query --symbol <name>`** — where an export is defined and every
  `file:line` that imports it by name; namespace imports of the exporter are
  listed apart as possible sites.
- **`nerve query --changed [--base <ref>]`** — files changed in git (working
  tree, plus vs a ref), their direct and transitive dependents, and the tests
  to run. Read-only git (`status`, `diff --name-only`).
- **Tests covering a file** — the card's `tests` lists test files that reach
  it transitively (`test/`, `__tests__/`, `*.test.*`, `*.spec.*`, `test_*.py`,
  `*_test.go`, `*_spec.rb`, …). `--transitive` lists every dependent;
  `--direction in|out|both` steers `--depth`.
- **`nerve agents-md`** — a ~12-line snippet for CLAUDE.md / AGENTS.md: the key
  commands, entrypoints, hubs, and a warning not to read `graph.json` whole.
- **`nerve diff` with no arguments** — `scan` now keeps the previous graph as
  `graph.prev.json`, and `diff` compares the two.
- **MCP** — tools `nervegraph_overview`, `nervegraph_symbol` and
  `nervegraph_changed`; `nervegraph_query` takes `depth`, `direction`,
  `transitive`, `raw` and `limit`; `nervegraph_list` adds `unresolved` and
  `packages` and takes `all`, `fields` and `limit`. A missing or stale graph is
  re-scanned before a call (`nerve mcp --no-autoscan` turns that off).

### Changed
- **Compact `--json`** — `query`, `overview`, `diff --json` and MCP results are one line;
  `--pretty` indents. `usedBy` / `uses` are grouped per file as
  `{ file, rel, lines, names? }` instead of one `{ file, rel, line, raw }` per
  reference; `raw` comes back with `--raw`. Every list is capped at `--limit`
  (default 50, `0` = all) and dropped counts are reported under `truncated`.
  List modes report `total`, and take `--fields a,b`; their rows drop the
  always-implied `orphan` / `missing` flags.
- **Orphans by kind** — each orphan is classed as code, entry, test, fixture,
  doc, config or asset. `query --orphans` lists only code unless `--all`, with
  counts per kind (`byKind`); the scan report and overview show the split.
- **Entrypoints** — package.json `main` / `module` / `bin` / `exports` paths
  under tsconfig's `outDir` map back to their source under `rootDir`
  (`bin: dist/cli.js` marks `src/cli.ts`).
- **Risk** — an entrypoint is no longer high by default: medium when it imports
  something, low when it is a leaf (a locale file, say). Docs and media are
  always low. Dependents and churn decide the rest, as before.
- **Unresolved vs external** — the scan report, `scan --json` and the overview
  count external references (packages, builtins, URLs) apart from references
  that genuinely could not be followed.

- **`check` budgets** — `--max-unresolved` counts only references that could
  not be followed (not npm packages, builtins or URLs); `--max-orphans` counts
  only orphan code files.
- **`vendor/`, `dist/`, `build/`, `*.min.*`** are listed but not scanned, so a
  `<script src="vendor/x.js">` is an edge, not a missing file.

### Security
- **Viewer XSS** — a node label built from an import string was rendered as
  HTML in the tooltip; a cloned repo could run script on the viewer page.
  Labels are now text.
- **DNS rebinding** — the viewer server answers only `localhost` /
  `127.0.0.1` / `[::1]` Host headers.

### Fixed
- **TypeScript** — `import './x.js'` resolves to `x.ts` (NodeNext style);
  export names for `abstract class`, `declare`, `const enum`, `type`,
  `interface`, `namespace`; `export type { … } from` keeps its edge.
- **tsconfig / workspaces** — `paths` picks the most specific pattern;
  `extends` is followed; workspace packages honour `exports`, `main`, `module`.
- **False edges** — `require()` inside comments and strings; Python imports in
  docstrings; Terraform `source` outside a `module` block.
- **Determinism** — `graph.json` no longer depends on file-read order.
- **Python** — CRLF files lost every import; multi-line `from x import (…)`;
  one missing node per missing module, not per name; packages outside
  `src/`/`lib/`.
- **Shopify** — `content_for 'blocks'` / `'block', type:`; theme blocks used
  from template JSON; `{% doc %}`; `echo … | asset_url` in `{% liquid %}`.
- **CSS / HTML / Markdown** — `url(f.eot?#iefix)`, `?v=` query strings,
  `url(#id)`, Sass `@use 'sass:…'` and `@forward`, `//` comments in SCSS;
  root-relative `src="/app.js"` next to the page; inline module scripts in
  `.html`; percent-encoded Markdown links.
- **Go / PHP / Rust / C** — nested `go.mod`; PSR-0; `#` inside PHP strings;
  `src/bin/*.rs` and `build.rs` as crate roots, `#[cfg(test)] mod x;`,
  `"/*"` in Rust strings; `..` in C include roots.
- **Files** — dotfiles are scanned; nested `.gitignore` files apply;
  gitignored files that are imported are not "missing"; `import './'`;
  case-only matches warn (`case_mismatch`); duplicate imports keep all names;
  git churn for non-ASCII paths.
- **MCP** — replies in flight when stdin closed were lost; `ping`; JSON-RPC
  error codes (-32700/-32600/-32601); tool failures come back as `isError`
  results; an ambiguous or empty `file` no longer picks an arbitrary node.
- **CLI** — absolute paths and `.\src\x` work in `query` and `export --focus`
  (which now accepts short names); `--help` / `--version` exit 0 on stdout;
  bad flags exit 2; `--max-cycles abc` is rejected instead of passing;
  malformed `rules.json` and `graph.json` give a clear error; `scan --watch`
  no longer rescans forever on Windows or with `--out`; `view --port 0`;
  `export --format dot` escaping; deep `--depth` on large graphs is fast.

### Removed
- README advice to `cat .nervegraph/graph.json` — on a real repo that is tens
  of thousands of tokens; the query commands answer the same questions.

## [0.4.0] — 2026-08-18

`graph.json` moves to **schema 4** — additive only: new fields and one new
relation type. A consumer that ignores unknown enum values reads it unchanged.

### Added
- **`nerve check`** — the graph as a CI gate. Budgets are opt-in
  (`--max-cycles`, `--max-unresolved`, `--max-orphans`, `--no-dead-exports`,
  `--no-duplicates`); a reference to a file that isn't on disk fails by default.
  Exit code 7 when a budget is broken.
- **Layer rules** — `.nervegraph/rules.json` (or `--rules`) declares which
  directories may not reach which, and `check` reports the edges that break it.
  The judgement is the user's; the tool only checks it.
- **Unused exports** — an export no importer names is reported per file
  (`deadExports`, `nerve query --dead-exports`, and the issues panel). Silent
  rather than wrong: one `import *`, `require()` or `<script src>` makes usage
  unknowable and the file is skipped.
- **Duplicate files** — byte-identical files grouped by the hash that was
  already on every node (`duplicates`, `nerve query --duplicates`).
- **Git churn** — commits per file over the last 500, when the root is a repo.
  It feeds the risk model: a file with dependents *and* constant change is
  promoted one level. `--no-git` skips it.
- **`nerve diff <a> [b]`** — files and edges added or removed, cycles
  introduced or resolved, new orphans, risk increases.
- **`nerve export --format mermaid|dot`** — the map as text, with `--focus`
  and `--depth` to keep it renderable.
- **`nerve mcp`** — the query surface over MCP on stdio, so an agent discovers
  the tool instead of having to be told about it.
- **`nerve query --packages`** — the same graph folded to one node per package,
  which is the only readable scale for a monorepo.
- **Web components** — `<product-form>` in markup now links to the file that
  calls `customElements.define('product-form', …)` (new `custom_element` rel).
- **Liquid `assign` indirection** — `{% assign card = 'product-card' %}` …
  `{% render card %}` resolves when the name is assigned exactly one literal.
- **Folder clustering in the viewer** — collapse each folder into one node
  (click to expand); on by default past 1200 nodes.
- **The selection lives in the URL**, so a view can be bookmarked or shared,
  and a **copy as context** button hands the file's card to an agent as markdown.
- `cycles` and `duplicates` are fields in `graph.json`; the viewer no longer
  regex-parses cycle warnings to recover the path.
- `--pretty` for an indented `graph.json`.

### Changed
- **`graph.json` is compact by default.** The indentation was megabytes of
  nothing on a large repo; `--pretty` brings it back.

### Removed
- **`--force`**, which was parsed and silently ignored — the incremental cache
  it belonged to was never built, and a full scan of 1500 files takes ~1.7 s.

### Fixed
- `nerve query <name>` resolves the way it was always documented: exact path,
  then path suffix, then basename with or without extension, listing candidates
  when a tier is ambiguous.

## [0.3.1] — 2026-08-16

### Fixed
- **The help card and the issues panel covered the graph on every page load.**
  Both ship with the `hidden` attribute set, but both declare their own
  `display` in `app.css`, which outranks the user agent's
  `[hidden] { display: none }` — so the viewer opened with two overlays on top
  of the canvas and no way to tell they were meant to be closed. `app.css` now
  restates the rule with `!important`, and a test fails if a future overlay
  reintroduces the conflict.
- **A query string no longer 404s a viewer asset.** `nerve view` matched
  `req.url` against its route allowlist whole, so `/app.css?v=2` missed. The
  path is now matched on its own, which makes cache-busting work; the allowlist
  itself is unchanged, so path traversal is still impossible.

## [0.3.0] — 2026-08-16

`graph.json` moves to **schema 3** — additive only: new node types, new rel
types and the new `poly` profile value. A consumer that ignores unknown enum
values, as the schema requires, reads it unchanged.

### Added
- **Single-file components** — `.vue`, `.svelte` and `.astro` are scanned by
  running the existing HTML, JavaScript and style passes over the file's
  regions. They used to be opaque leaf nodes with no edges at all, which hid
  the component tree of every modern frontend.
- **Go** — `import` (single and grouped), resolved against the `module` line of
  `go.mod`; only the repo's own packages become edges.
- **PHP** — `require`/`include` paths, and `use` statements resolved through
  composer.json's PSR-4/PSR-0 autoload map.
- **Java / Kotlin** — `import a.b.C` resolved under `src/main/java`,
  `src/main/kotlin` and the flat layouts, including nested classes.
- **C / C++** — `#include "x.h"` resolved next to the file and under
  `include/`, `src/`, `lib/`; `<angle>` includes are external.
- **Markdown** — links and images that point at project files, so docs join the
  graph. Fenced code blocks and in-page anchors are ignored.
- **Shell** (`source x.sh`) and **Terraform** (`module { source = "./…" }`).
- New node types `component`, `go`, `php`, `java`, `c`, `markdown` and rel types
  `go_import`, `php_require`, `php_use`, `java_import`, `c_include`, `md_link`,
  `sh_source`, `tf_module`.
- `ResolveContext` gained `listDir`, so a resolver can handle an import that
  names a directory (a Go package, a Terraform module) rather than a file.
- **Color by type / language / directory / risk** in the viewer. The eight
  validated palette slots are handed to whatever categories the current graph
  contains, biggest first — so a polyglot repo never depends on two languages
  that share a slot in the type palette being distinguishable.
- **Size by dependents / dependencies / lines of code.**
- **Issues panel** (`i`, or the status-bar button) — the `unresolved` list with
  each reference's reason and hint, the cycles found during the scan, and
  read/parse warnings. All of it was already written to `graph.json` and none
  of it was shown anywhere.
- **Cycle edges are drawn in the critical color**, with an `only cycles` filter
  and a warning in the details panel of any file taking part in one.
- **Shortest path between two files** — shift-click a second node to trace how
  the selected one reaches it; everything off the path recedes.
- **Focus subgraph is configurable**: depth 1–3, and direction (what it uses /
  what uses it / both) instead of a fixed two-hop walk in both directions.
- **Search shows its matches** — a list ordered by dependents instead of
  jumping to the alphabetically first hit.
- **Theme button** (light / dark / follow system) and a **`?` card** with the
  keyboard shortcuts and how to read the graph.
- **`nerve query <file>`** — the agent-facing card: what uses this
  file, what it uses, its risk, its transitive dependent count, and whether the
  file changed since the scan. `--json` prints nothing else, so it is
  pipe-safe. List forms: `--orphans`, `--missing`, `--unresolved`,
  `--risk <level>`, and `--depth <n>` for the neighbourhood.
- **`nerve scan --watch`** — re-scan on change, debounced, skipping its own
  output. `nerve view` now serves an SSE stream and the viewer reloads itself
  when graph.json changes, so a watched scan and an open map stay in step.

### Added
- **Non-relative import resolution** — `tsconfig.json`/`jsconfig.json` `paths`
  and `baseUrl`, `package.json` `imports` (`#alias`), and npm/pnpm workspace
  package names now resolve to project files. A TypeScript project using
  `@/components/Button` previously produced almost no edges, because every
  aliased specifier looked like a bare npm package. tsconfig is read as JSONC,
  so comments and trailing commas are fine.
- **`poly` profile** — a repo with `Cargo.toml`, `go.mod`, `pyproject.toml`,
  `Gemfile`, `composer.json`, `CMakeLists.txt`, `pom.xml` or a Gradle build is
  detected instead of being scanned as JavaScript with a "no known project
  type" warning.

### Fixed
- An external URL in `unresolved` was labelled "name comes from a variable or
  expression"; it now says so.
- A file the JS lexer cannot parse (a `.tsx` with generic arrows is the usual
  case) lost every static import: the fallback pass only matched `import()` and
  `require()`. It now matches `import … from '…'` and `export … from '…'` too.
- Sass `@use`/`@forward`/`@import` without an extension resolved to nothing.
  `base` now finds `_base.scss`, `base.scss`, or `base/_index.scss`.
- The JS extension chain missed `.cjs`, `.mts`, `.cts` and `index.tsx`/
  `index.jsx` directory entries.

## [0.2.1] — 2026-07-22

Bug fixes from a full review of the 0.2.0 code. No schema change.

### Fixed
- **CI ran 55 of 136 tests.** The test script's `test/**/*.test.ts` was left
  unquoted, so `sh` — which has no globstar — collapsed it to `test/*/*.test.ts`
  and ran only `test/scanners/`. Every top-level suite was silently skipped, on
  `npm test` and, through `prepublishOnly`, on publish. Invisible on Windows,
  where npm's `cmd.exe` doesn't glob and Node expanded the pattern correctly.
- Two files whose paths differ only in case (`src/Utils.js`, `src/utils.js`)
  collided in the case-insensitive id index, and every reference to one was
  rewritten onto the other. Colliding ids are now left alone; case-sloppy
  references to non-colliding files are still repaired.
- `loc` counted one extra line for every file ending in a newline — which is
  nearly all of them.
- The scan report's artifact size was measured on compact JSON while the file is
  written indented, understating it by roughly half.
- The viewer showed a blank page when `graph.json` was missing or truncated: the
  server's plain-text hint was parsed as JSON and the rejection went unhandled.
  It now surfaces the server's message.
- The large-graph banner claimed assets were hidden while they were still drawn
  and their checkbox still read checked; it ran after the UI and graph were
  already built.
- Link width read a `_count` that was never assigned, so every link drew at
  width 1 and repeated references between the same pair of files stacked as
  overlapping lines. They now collapse to one link, widened by their count.
- Hovering a node recomputed the neighbour sets by scanning the whole edge list
  once per node per frame; they are now cached on the active node.
- Removed `writeMetaAtomic` and `FileMeta`, which had no callers, along with the
  `.gitignore` each scan wrote for the `meta.json` they never produced.
- `lineAt`/`truncate` were re-implemented in the JavaScript and CSS scanners
  instead of imported from `scanners/util.ts`, hardcoding the `RAW_MAX` cap that
  the other three scanners read from one place.
- `package-lock.json` still declared 0.1.0 after the 0.2.0 release.

## [0.2.0] — 2026-07-22

Multi-language support. `graph.json` moves to **schema 2**; see "Changed" for
the two breaking details.

### Added
- **HTML** scanner — `<script src>`, `<link href>`, and `src` on `img`,
  `source`, `iframe`, `video`, `audio`, `embed`, `track`, `object`. Comments are
  blanked before matching, so commented-out markup produces no edges. `class="…"`
  feeds `--classes`.
- **Python** scanner and resolver — `import x`, `from x import y`, relative
  `from .x import y`. Resolves through `__init__.py`, `src/` and `lib/` layouts,
  and `.pyi` stubs.
- **Ruby** scanner and resolver — `require` (searched under `lib/`, `app/`,
  `test/`, `spec/`) and `require_relative`.
- **Rust** scanner and resolver — `mod x;` declarations, including the crate
  root / `mod.rs` / `a.rs`-owns-`a/` directory rules.
- New node types `html`, `python`, `ruby`, `rust`, and new rel types
  `py_import`, `rb_require`, `rb_require_relative`, `rust_mod`, `asset_url`.
- Extensions recognised: `.cjs`, `.mts`, `.cts`, `.htm`, `.sass`, `.less`,
  `.py`, `.pyi`, `.rb`, `.rake`, `.gemspec`, `.rs`.
- Entrypoint conventions for HTML, Python, Ruby and Rust, so those projects
  don't report every unimported file as an orphan.
- Cycle warnings now name the files on the cycle instead of just saying one
  exists (up to 20 cycles reported).
- `src/scan/extensions.ts` — one extension→language table replacing four
  drifting copies. `npm run typecheck`; `prepublishOnly` runs typecheck, tests
  and build.

### Changed
- **Breaking (schema 2):** node type `module` removed — `.js`/`.ts` outside
  `assets/` is now `javascript`. JS/TS projects no longer render as one grey
  mass. Consumers switching on `module` should treat it as `javascript`.
- **Breaking (schema 2):** `asset` is now the path-shaped relation (CSS `url()`,
  HTML `src`); the Shopify `{{ 'x' | asset_url }}` convention moved to the new
  `asset_url` rel.
- `NodeType`/`RelType` are derived from the runtime arrays `NODE_TYPES` and
  `REL_TYPES`, so the viewer's color tables can be validated against them.
- TypeScript files report `lang: "typescript"` (they previously reported
  `"javascript"`); their node `type` is still `javascript`.

### Fixed
- Root-absolute references (`<script src="/assets/app.js">`) resolved against
  the referencing file's directory instead of the project root, inventing a
  phantom missing node for every one of them.
- A CSS `url("../fonts/x.woff")` in a Shopify theme produced the nonsense id
  `assets/../fonts/x.woff`. Fixed by the `asset`/`asset_url` split above.
- Cycle detection recursed and could overflow the stack on a deep dependency
  chain, crashing the whole scan; it is now iterative.
- Case-insensitive reference resolution scanned every file id per reference
  (O(files × refs)); it now uses a prebuilt index.
- Several references from one source line to one file (`from pkg import a, b`)
  produced duplicate parallel edges; they now collapse to one.
- Removed dead code: an unused `classify()` in the JS scanner that returned the
  same value on both branches, and an empty loop over binary leaves in `build.ts`.
- The version string was hardcoded in four places and had already drifted;
  it now comes from `src/version.ts`.
- README claimed Node ≥ 20; the package requires ≥ 22.6.

## [0.1.0]

### Added
- First version: `nerve scan` builds a Shopify theme's dependency graph (Liquid/JSON/JS/CSS) into `.nervegraph/graph.json`.
- `nerve view` — interactive graph browser (force-graph).
- Path resolvers for Shopify conventions and generic JS/CSS.
- CI: test run on push/PR via GitHub Actions.
