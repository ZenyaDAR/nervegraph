# nervegraph color scheme

This is the single source of truth for every color the viewer uses — UI chrome,
node types, relation lines, and risk/status. It's built with the categorical /
status color method (see `EXTENDING.md` for how to extend it when a new
`NodeType` is added), validated with the method's colorblind-safety checker
rather than picked by eye. `viewer/app.css` and `viewer/app.js` implement this
file; if you change a color, change it here first, re-validate, then apply.

## Why these values

- **Node type = categorical (identity).** 8 fixed hues in a fixed order, each
  assigned to one node-type group. The order is the colorblind-safety
  mechanism — it's what got validated, so slots keep their hue even if you
  relabel which node type sits in which slot.
- **`asset`/`unknown` = "Other," not a 9th hue.** The method is
  explicit that a 9th category should never be a freshly generated hue — it
  folds into a neutral. These two types are exactly that: files nervegraph
  doesn't have a structural opinion about. They get muted ink gray.
- **Languages share slots with Shopify types they can't co-occur with.**
  `python`, `ruby`, `rust` and `html` reuse the hues of `section`, `block`,
  `snippet` and `layout` rather than inventing new ones, because the Shopify
  types only exist under the `shopify` profile and the language types only
  appear in projects that contain those languages. This keeps the validated
  8-slot order intact — no re-validation is needed to add a language, only a
  check that the new type can't realistically share a graph with its slot-mate.
- **Risk = status (state), not categorical.** Status colors are a small fixed
  scale with reserved meaning (good → warning → critical) that must stay
  visually distinct from the 8 category hues so a risk badge never reads as
  "series 9." Always paired with the text label (`RISK HIGH`, not color alone).
- **Relation-line colors are deliberately outside the categorical system.**
  Edges recede on purpose (see docs/05-viewer.md §5.2 — "more muted than nodes")
  and are already differentiated by line style (solid vs dashed) as well as
  color, so they don't need to clear the same CVD bar as node identity. They're
  muted slate variants, listed below for completeness but not run through the
  categorical validator.

## Validation

Run whenever a node-type→slot assignment changes:

```bash
node <dataviz-skill>/scripts/validate_palette.js \
  "#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#4a3aa7,#e34948" \
  --mode light --surface "#fcfcfb"

node <dataviz-skill>/scripts/validate_palette.js \
  "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" \
  --mode dark --surface "#1a1a19"
```

Both pass every hard gate at this order: worst adjacent CVD ΔE 9.1 light /
8.4 dark (≥8 target), worst adjacent normal-vision ΔE 19.6 light / 19.3 dark
(≥15 floor). Light mode WARNs on raw fill contrast for 3 of the 8 slots
(aqua `#1baf7a` 2.74:1, yellow `#eda100` 2.11:1, magenta `#e87ba4` 2.62:1 on
`#fcfcfb`) — the relief this project ships is the **always-on node label**
(see the viewer's node rendering), so identity never depends on the fill
alone. Dark mode clears 3:1 contrast on all 8 slots outright.

## Node types (categorical, 8 slots + Other)

| Slot | Hue | Light | Dark | Node types |
|---|---|---|---|---|
| 1 | blue | `#2a78d6` | `#3987e5` | `section`, `section_group`, `python`, `java` |
| 2 | orange | `#eb6834` | `#d95926` | `layout`, `html`, `markdown` |
| 3 | aqua | `#1baf7a` | `#199e70` | `snippet`, `rust`, `go` |
| 4 | yellow | `#eda100` | `#c98500` | `javascript` (JS **and** TS) |
| 5 | magenta | `#e87ba4` | `#d55181` | `template`, `template_json`, `component`, `c` |
| 6 | green | `#008300` | `#008300` | `block`, `ruby`, `php` |
| 7 | violet | `#4a3aa7` | `#9085e9` | `css` |
| 8 | red | `#e34948` | `#e66767` | `json` |
| — | other (gray) | `#898781` | `#898781` | `asset`, `unknown` |

Slot-mates are picked so they don't realistically share a repo: Vue/Svelte
components and C sources, Go and Rust, PHP and Ruby, Java and Python. Two of
those pairings *can* co-occur in a genuinely polyglot repo (Python + Java in a
data project, Markdown + HTML in a docs site) — that is what the viewer's
**color by language** mode is for: it assigns the same eight slots to whatever
languages the graph in front of you actually contains, so identity is never
ambiguous in practice.

`shell` and `hcl` files are scanned for references but have no node type of
their own; they render in the "Other" grey. A colour slot is scarcer than they
are common.

TypeScript deliberately shares the `javascript` slot: the distinction is carried
by the node's `lang` field, and splitting one concern across two hues would
spend a scarce categorical slot on a compile-target difference.

Slot order is fixed — if a 9th real category ever earns its own hue (unlikely;
see "Other" above), don't insert it into the middle of this list. Re-run the
enumeration in the dataviz skill's `color-formula.md` § Themes and pick a new
passing order, or add it as a facet/filter instead of a color.

## Risk / status (fixed, never themed)

| Risk | Hex | Used for |
|---|---|---|
| low | *(neutral border, no status hue)* | risk badge border only |
| medium | `#fab219` (warning) | risk badge, `in ∈ [3, 10)` |
| high | `#d03b3b` (critical) | risk badge, `in ≥ 10` or entrypoint |
| missing | `#d03b3b` (critical) | dashed node ring + detail-panel warning |

Same hex in both modes — status is mode-invariant by design. Always shown
with the text label (`RISK HIGH`, `⚠ file does not exist`), never as a bare
color chip.

## Relation-line colors (muted, not categorical)

| Group | Rel types | Dark | Light | Style |
|---|---|---|---|---|
| structural | `render`, `include`, `section`, `section_group`, `template_section`, `content_for`, `rust_mod`, `tf_module` | `#4a5568` | `#9096a6` | solid |
| code | `import`, `require`, `dynamic_import`, `css_import`, `py_import`, `rb_require`, `rb_require_relative`, `go_import`, `php_require`, `php_use`, `java_import`, `c_include`, `sh_source` | `#5a6478` | `#9aa3b8` | dashed |
| resource | `asset`, `asset_url`, `script_src`, `link_href`, `md_link` | `#3f4a5a` | `#7c8794` | solid |
| class usage | `class_usage` | `#4a4458` | `#9b8fae` | thin dashed |
| translation | `translation` | `#3f4a5a` | `#7c8794` | solid, hidden by default |

`tf_module` joins `rust_mod` as **structural** for the same reason: a module
block is what pulls a directory into the configuration. `md_link` is grouped as
a **resource** edge — a doc pointing at another doc references it, it doesn't
include it.

`rust_mod` is grouped as **structural**, not code: `mod foo;` is what pulls a
file into the crate, so it defines the module tree the way a Liquid `render`
defines page structure. `py_import`/`rb_require` are ordinary code imports.

## UI chrome & ink

Straight from the dataviz skill's neutral surface/ink roles — not invented
per-project, so the whole app (not just the graph) reads as one system.

| Role | Light | Dark |
|---|---|---|
| Page plane (topbar/panels/statusbar) | `#f9f9f7` | `#0d0d0d` |
| Chart surface (graph canvas) | `#fcfcfb` | `#1a1a19` |
| Primary ink (headings, node labels) | `#0b0b0b` | `#ffffff` |
| Secondary ink (body text) | `#52514e` | `#c3c2b7` |
| Muted ink (dim counts, hints) | `#898781` | `#898781` |
| Border (hairline) | `rgba(11,11,11,0.10)` | `rgba(255,255,255,0.10)` |
| Accent (focus, buttons, links) | `#2a78d6` (slot 1) | `#3987e5` (slot 1) |

## Node label pill (canvas-drawn, see viewer/app.js)

The label background is a semi-transparent chart-surface chip so text stays
legible over any node color or edge crossing it: `rgba(26,26,25,0.78)` dark /
`rgba(252,252,251,0.82)` light, text in primary ink.
