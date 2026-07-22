export const SCHEMA_VERSION = 1;

export type NodeType =
  | 'layout' | 'template' | 'template_json' | 'section_group' | 'section'
  | 'snippet' | 'block' | 'javascript' | 'css' | 'json' | 'asset'
  | 'module' | 'unknown';

export type RelType =
  | 'render' | 'include' | 'section' | 'section_group' | 'template_section'
  | 'asset' | 'content_for' | 'import' | 'require' | 'dynamic_import'
  | 'css_import' | 'script_src' | 'link_href' | 'translation' | 'class_usage';

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
  profile: 'shopify' | 'js';
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
