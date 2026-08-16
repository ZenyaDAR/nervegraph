# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/), versioning per [SemVer](https://semver.org/).

## [Unreleased]

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
- **`nerve query <file>`** — the agent-facing card from docs/07: what uses this
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
