// 2: node type `module` folded into `javascript`; added `html`/`python`/
// `ruby`/`rust` node types; split the Shopify `asset_url` convention out of
// the path-shaped `asset` relation.
// 3: additive only — new node types (`component`, `go`, `php`, `java`, `c`,
// `markdown`), new rel types for those languages, and the new `poly` profile
// value. A schema-2 consumer that ignores unknown enum values (as 3.9 requires)
// reads a schema-3 graph unchanged.
// 4: additive only — `cycles` (dependency cycles as data, previously only
// readable by regex-parsing a warning's prose; the warnings still ship
// unchanged), `duplicates` (byte-identical file groups), edge `names` (which
// bindings an import pulls in) and node `deadExports`.
export const SCHEMA_VERSION = 4;

// Declared as runtime arrays, with the TypeScript unions derived from them, so
// that consumers (the viewer's color tables, the resolver registry) can be
// checked against the real list instead of a hand-copied duplicate of it.

export const NODE_TYPES = [
  // Shopify theme conventions
  'layout', 'template', 'template_json', 'section_group', 'section',
  'snippet', 'block',
  // language-generic
  'javascript', 'html', 'css', 'python', 'ruby', 'rust',
  'component', 'go', 'php', 'java', 'c', 'markdown',
  'json', 'asset', 'unknown',
] as const;

export const REL_TYPES = [
  // Shopify theme structure
  'render', 'include', 'section', 'section_group', 'template_section',
  'content_for', 'translation', 'asset_url',
  // markup & resources
  'asset', 'script_src', 'link_href', 'class_usage',
  // JS/TS modules
  'import', 'require', 'dynamic_import',
  // CSS
  'css_import',
  // other languages
  'py_import', 'rb_require', 'rb_require_relative', 'rust_mod',
  'go_import', 'php_require', 'php_use', 'java_import', 'c_include',
  'md_link', 'sh_source', 'tf_module',
  // markup <-> customElements.define()
  'custom_element',
] as const;

export type NodeType = typeof NODE_TYPES[number];
export type RelType = typeof REL_TYPES[number];

export type Risk = 'low' | 'medium' | 'high';

export interface GraphNode {
  id: string;
  type: NodeType;
  lang: string;
  size: number;
  loc: number;
  hash: string;
  in: number;
  out: number;
  risk: Risk;
  orphan: boolean;
  entrypoint: boolean;
  /** Commits touching this file in the last 500, when the root is a git repo. */
  churn?: number;
  exports?: string[];
  classes?: string[];
  missing?: boolean;
  /**
   * Exports no importer names. Present only when every incoming reference
   * declares what it imports — one `import *`, `require()` or `<script src>`
   * makes usage unknowable and the field is omitted rather than guessed.
   */
  deadExports?: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: RelType;
  line: number;
  raw: string;
  value?: string;
  /** Bindings this reference pulls in. `['*']` = all / unknowable. */
  names?: string[];
}

export interface UnresolvedRef {
  from: string;
  line: number;
  rel: RelType;
  raw: string;
  reason: 'dynamic' | 'concatenated' | 'external' | 'ambiguous';
  hint: string;
}

export interface Warning {
  code: 'parse_error' | 'file_too_large' | 'read_error' | 'cycle';
  file: string;
  message: string;
}

export interface Graph {
  schemaVersion: number;
  tool: string;
  root: string;
  profile: 'shopify' | 'js' | 'poly';
  scannedAt: string;
  durationMs: number;
  stats: {
    files: number;
    edges: number;
    unresolved: number;
    orphans: number;
    byType: Record<string, number>;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedRef[];
  warnings: Warning[];
  /** Each entry is a closed walk: `[a, b, c, a]`. Capped, see build.ts. */
  cycles: string[][];
  /** Groups of files with byte-identical content. */
  duplicates: string[][];
}

// Scanner-facing types: what a scanner returns for one file.
export interface RawRef {
  rel: RelType;
  target: string;
  line: number;
  raw: string;
  literal: boolean;
  value?: string;
  /** Bindings this reference pulls in. `['*']` = all / unknowable. */
  names?: string[];
}

export interface ScannerResult {
  refs: RawRef[];
  exports?: string[];
  classes?: string[];
  /** Custom element tag names this file registers via customElements.define. */
  defines?: string[];
}

export type Scanner = (file: { id: string; content: string }) => ScannerResult;
