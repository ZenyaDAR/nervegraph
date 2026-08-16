# Extending nervegraph

The scanning pipeline is two independent registries. Adding support for a new
language, file type, or convention almost never means editing existing files —
it means adding one file and registering it.

```
file on disk
   │
   ▼
src/scan/extensions.ts        "is this a text file, and what language?"
   │  (SOURCE_EXT: extension -> Lang)
   ▼
src/scan/languages/index.ts   "which language module owns this file?"
   │  (LanguageModule: matches + scan)
   ▼
RawRef[]  (rel, target string, line, literal?)
   │
   ▼
src/graph/resolvers/index.ts  "what node does this rel+target point to?"
   │  (RelResolver: keyed by rel type + optional profile)
   ▼
GraphEdge | UnresolvedRef
```

The split matters: a **language** (Liquid, JS, CSS, ...) knows how to *read*
a file into raw references. A **resolver** knows how to turn one relation
type's target string into a node id. They're decoupled because two different
languages can produce the same `rel` (e.g. a future language could emit
`css_import` too) and it must resolve identically — resolution is a property
of the relation, not of who emitted it.

## Adding a new language

1. Add the extensions to `SOURCE_EXT` in `src/scan/extensions.ts`, mapping them
   to a new `Lang` value:

   ```ts
   '.go': 'go',
   ```

   This one table decides what gets read as text (`scan/files.ts`), what the
   node's `lang` label is (`graph/build.ts`), and which node type it gets
   (`scan/profile.ts`). A test asserts every text extension has a language, so
   forgetting a row fails the suite rather than silently producing `other`.

2. Write a pure scanner in `src/scan/scanners/<lang>.ts`:

   ```ts
   export function scanYourLang(file: { id: string; content: string }): ScannerResult {
     // string in, RawRef[] out — no filesystem access, so it's testable on
     // literal strings with no fixtures. See src/scan/scanners/rust.ts.
     return { refs: [...] };
   }
   ```

   `src/scan/scanners/util.ts` has the shared pieces: `lineAt`, `truncate`,
   `blank` (blank out comments without shifting offsets, so line numbers stay
   correct) and `isExternalUrl`.

   A file that embeds other languages doesn't need a new scanner for each part:
   `scanners/component.ts` (`.vue`/`.svelte`/`.astro`) runs the HTML, JavaScript
   and style passes over the regions it finds and shifts their line numbers by
   the region's offset.

   A file that embeds other languages doesn't need a new scanner for each part:
   `scanners/component.ts` (`.vue`/`.svelte`/`.astro`) runs the HTML, JavaScript
   and style passes over the regions it finds and shifts their line numbers by
   the region's offset.

3. Register it in `src/scan/languages/index.ts`'s `LANGUAGES` array:

   ```ts
   byLang('go', ['go'], scanGo),
   ```

   `byLang` covers the usual case: "claim exactly the files whose extension
   maps to this `Lang`". A language needing more — a profile check, a directory
   rule — gets its own file instead, like `shopify-json.ts`, which only claims
   `templates/*.json` and `sections/*.json` under the `shopify` profile.

4. If the language deserves its own color in the viewer, add a `NodeType` (see
   "Node type colors" below) and map it in `LANG_NODE_TYPE` in
   `src/scan/profile.ts`. Add its conventional entrypoints to
   `GENERIC_ENTRYPOINTS` in the same file, or every file in the project that
   nothing imports will be reported as an orphan.

`build.ts` never changes — it just iterates the registries.

If your scanner can throw on malformed input (like `css.ts` and
`shopify-json.ts` do), that's fine: `build.ts` wraps every `scan()` call in a
try/catch and records a `parse_error` warning automatically.

### When an import names a directory

A Go package or a Terraform module is a *directory*, but graph nodes are files.
`ResolveContext.listDir(dir)` gives a resolver the ids directly inside a
directory so it can pick the file that stands for it (see `packageFile` in
`resolvers/languages.ts`). The index is built once in `build.ts`; don't scan the
id set yourself.

### Config a resolver may need

Project-level facts that resolution depends on are loaded once in
`src/scan/aliases.ts` and handed to every resolver through `ResolveContext`:
`aliases` (tsconfig `paths`/`baseUrl`, package.json `imports`, workspaces),
`psr4` (composer autoload) and `goModule` (the `module` line of go.mod). Add a
loader there rather than reading a config file from inside a resolver — a
resolver is called once per reference.

### When an import names a directory

A Go package or a Terraform module is a *directory*, but graph nodes are files.
`ResolveContext.listDir(dir)` gives a resolver the ids directly inside a
directory so it can pick the file that stands for it (see `packageFile` in
`resolvers/languages.ts`). The index is built once in `build.ts`; don't scan the
id set yourself.

### Config a resolver may need

Project-level facts that resolution depends on are loaded once in
`src/scan/aliases.ts` and handed to every resolver through `ResolveContext`:
`aliases` (tsconfig `paths`/`baseUrl`, package.json `imports`, workspaces),
`psr4` (composer autoload) and `goModule` (the `module` line of go.mod). Add a
loader there rather than reading a config file from inside a resolver — a
resolver is called once per reference.

### What counts as `missing` vs `external`

Get this right or the graph fills with noise. A reference that cannot be found
on disk is only **missing** when the syntax guarantees it must be a project
file — a relative Python import, a Ruby `require_relative`, a Rust `mod`
declaration. A bare specifier that might name a package (`import requests`,
`require 'json'`, `import lodash`) resolves to **external** instead, so a
project doesn't sprout a missing node per third-party dependency.

## Adding a new relation type (`RelType`)

If your language introduces a relation Liquid/JS/CSS don't already have:

1. Add the string to the `REL_TYPES` array in `src/graph/types.ts`. The
   `RelType` union is derived from that array, so the runtime list and the type
   can't drift; this is the one central, intentionally-narrow contract (see
   docs/03-graph-schema.md §3.9). Consumers are required to ignore unknown
   `rel` values rather than fail on them.
2. Register a resolver for it in `src/graph/resolvers/`:
   - Path-shaped and profile-agnostic (`import`, `css_import`, `asset`): add it
     to `genericResolvers` in `resolvers/generic.ts`.
   - A language's own module-lookup rules (Python packages, Ruby load paths,
     Rust `mod`): add it to `resolvers/languages.ts`.
   - Project-convention-specific (like Shopify's `render`/`section`/...): add
     it to `resolvers/shopify.ts` (or a new `resolvers/<profile>.ts`) with
     `profiles: ['yourprofile']`.
3. Register the new file's resolver array in `resolvers/index.ts`'s
   `RESOLVERS` list if you created a new file. Two entries may share a `rel`
   only if their `profiles` are disjoint — `findResolver` takes the first match.
4. Give it a line color in `viewer/app.js`'s `REL_COLOR` and a row in
   `COLOR_SCHEME.md`. Tests assert both, so a missing color fails the suite.

`resolve.ts` itself never needs to change — it only calls
`findResolver(rel, profile)`.

## Adding a new project profile

A "profile" (`shopify` | `js` today) is a bundle of: which directories mean
what (`classifyNodeType` in `src/scan/profile.ts`), what counts as an
entrypoint (`isEntrypoint`, same file), and which resolvers apply
(`profiles: [...]` on `RelResolver`). Add the profile string to the `Profile`
type, add detection logic to `detectProfile`, add its directory rules to
`classifyNodeType`, and add any profile-specific resolvers. Existing
resolvers and languages that don't mention your profile are unaffected.

## Node type colors

Adding a `NodeType` (to `NODE_TYPES` in `src/graph/types.ts`) also means giving
it a color in both modes of `viewer/app.js`'s `TYPE_COLOR` and a row in
`COLOR_SCHEME.md` — see that file for the palette, the categorical slot
assignment, and how to validate a change with the palette validator.

The cheap path is to **reuse an existing slot** whose current occupant can't
appear in the same graph — `python` shares blue with `section` because the
Shopify types only exist under the `shopify` profile. That keeps the validated
8-slot order intact and needs no re-validation, only a judgement that the two
types won't realistically co-occur. Generating a 9th hue is the expensive path
and usually the wrong one.

`test/viewer-colors.test.ts` asserts that every `NodeType` and `RelType` has a
color in both modes and is documented in `COLOR_SCHEME.md`, and that the viewer
defines no colors for types that no longer exist.
