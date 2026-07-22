# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/), versioning per [SemVer](https://semver.org/).

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
