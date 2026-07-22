# Extending nervegraph

The scanning pipeline is two independent registries. Adding support for a new
language, file type, or convention almost never means editing existing files —
it means adding one file and registering it.

```
file on disk
   │
   ▼
src/scan/languages/index.ts   "which language owns this file?"
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

1. Write a pure scanner in `src/scan/scanners/<lang>.ts`:

   ```ts
   export function scanYourLang(file: { id: string; content: string }): ScannerResult {
     // string in, RawRef[] out — no filesystem access, so it's testable on
     // literal strings with no fixtures. See src/scan/scanners/css.ts.
     return { refs: [...] };
   }
   ```

2. Wrap it in `src/scan/languages/<lang>.ts`:

   ```ts
   export const yourLangLanguage: LanguageModule = {
     id: 'yourlang',
     matches: (id) => id.endsWith('.yourext'),
     scan: (file) => scanYourLang(file),
   };
   ```

   `matches` can also branch on `ctx.profile` if the language should only be
   scanned under certain project profiles (see `shopify-json.ts`, which only
   claims `templates/*.json` and `sections/*.json` under the `shopify` profile).

3. Register it in `src/scan/languages/index.ts`'s `LANGUAGES` array. Done —
   `build.ts` never changes; it just iterates the registry.

If your scanner can throw on malformed input (like `css.ts` and
`shopify-json.ts` do), that's fine: `build.ts` wraps every `scan()` call in a
try/catch and records a `parse_error` warning automatically.

## Adding a new relation type (`RelType`)

If your language introduces a relation Liquid/JS/CSS don't already have:

1. Add the string to `RelType` in `src/graph/types.ts` (and to
   `src/graph/types.ts`'s TypeScript union — this is the one central,
   intentionally-narrow contract; see docs/03-graph-schema.md §3.9. Consumers
   are required to ignore unknown `rel` values rather than fail on them.)
2. Register a resolver for it in `src/graph/resolvers/`:
   - Profile-agnostic (works the same in any project): add it to
     `genericResolvers` in `resolvers/generic.ts`.
   - Project-convention-specific (like Shopify's `render`/`section`/...): add
     it to `resolvers/shopify.ts` (or a new `resolvers/<profile>.ts`) with
     `profiles: ['yourprofile']`.
3. Register the new file's resolver array in `resolvers/index.ts`'s
   `RESOLVERS` list if you created a new file.

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

Adding a `NodeType` also means giving it a color — see `COLOR_SCHEME.md` for
the palette, the categorical slot assignment, and how to validate a change
with the palette validator before shipping it.
