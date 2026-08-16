// 2: node type `module` folded into `javascript`; added `html`/`python`/
// `ruby`/`rust` node types; split the Shopify `asset_url` convention out of
// the path-shaped `asset` relation.
// 3: additive only — new node types (`component`, `go`, `php`, `java`, `c`,
// `markdown`), new rel types for those languages, and the new `poly` profile
// value. A schema-2 consumer that ignores unknown enum values (as 3.9 requires)
// reads a schema-3 graph unchanged.
export const SCHEMA_VERSION = 3;

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
  exports?: string[];
  classes?: string[];
  missing?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: RelType;
  line: number;
  raw: string;
  value?: string;
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
}

// Scanner-facing types (see docs/04-scanners.md)
export interface RawRef {
  rel: RelType;
  target: string;
  line: number;
  raw: string;
  literal: boolean;
  value?: string;
}

export interface ScannerResult {
  refs: RawRef[];
  exports?: string[];
  classes?: string[];
}

export type Scanner = (file: { id: string; content: string }) => ScannerResult;
