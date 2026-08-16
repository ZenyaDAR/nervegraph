import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Non-relative import specifiers that are *not* npm packages: tsconfig `paths`,
// `baseUrl`, package.json `imports` (#alias) and workspace package names.
// Without these a modern TS project resolves almost nothing — every
// `@/components/Button` looked like a bare package specifier and was reported
// external, so the graph came out nearly edgeless.

export interface AliasRule {
  /** Specifier prefix to match; a trailing '*' makes it a wildcard rule. */
  prefix: string;
  /** Project-relative path templates, '*' replaced by whatever the prefix captured. */
  targets: string[];
}

/** Expand `spec` through the rules, returning candidate project-relative paths. */
export function expandAlias(spec: string, rules: AliasRule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (rule.prefix.endsWith('*')) {
      const head = rule.prefix.slice(0, -1);
      if (!spec.startsWith(head)) continue;
      const rest = spec.slice(head.length);
      for (const t of rule.targets) out.push(t.replace('*', rest));
    } else if (spec === rule.prefix) {
      for (const t of rule.targets) out.push(t.replace('*', ''));
    } else if (spec.startsWith(`${rule.prefix}/`)) {
      // A workspace package imported by subpath: "@app/ui/button".
      const rest = spec.slice(rule.prefix.length + 1);
      for (const t of rule.targets) out.push(`${t.replace('*', '')}/${rest}`);
    }
  }
  return out.map(normalizeRel).filter(p => p !== undefined) as string[];
}

export function loadAliases(root: string): AliasRule[] {
  return [
    ...fromTsconfig(root),
    ...fromPackageImports(root),
    ...fromWorkspaces(root),
  ];
}

// ── tsconfig / jsconfig ────────────────────────────────────────────────────

// ponytail: `extends` chains are not followed, and only a root-level config is
// read. Per-package configs in a monorepo would need a config per directory —
// add that when a real repo needs it; the workspace rules below already cover
// the common cross-package case.
function fromTsconfig(root: string): AliasRule[] {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const cfg = parseJsonc(readFileSync(file, 'utf8'));
    const co = cfg?.compilerOptions;
    if (!co) continue;
    const baseUrl = typeof co.baseUrl === 'string' ? stripDot(co.baseUrl) : '';
    const rules: AliasRule[] = [];
    if (co.paths && typeof co.paths === 'object') {
      for (const [prefix, targets] of Object.entries(co.paths)) {
        if (!Array.isArray(targets)) continue;
        rules.push({
          prefix,
          targets: targets
            .filter((t): t is string => typeof t === 'string')
            .map(t => joinRel(baseUrl, stripDot(t))),
        });
      }
    }
    // baseUrl alone makes every bare specifier resolvable as baseUrl/<spec>.
    // Last, so an explicit `paths` entry wins.
    if (baseUrl) rules.push({ prefix: '*', targets: [joinRel(baseUrl, '*')] });
    return rules;
  }
  return [];
}

// ── package.json "imports" ─────────────────────────────────────────────────

function fromPackageImports(root: string): AliasRule[] {
  const pkg = readJson(path.join(root, 'package.json'));
  const imports = pkg?.imports;
  if (!imports || typeof imports !== 'object') return [];
  const rules: AliasRule[] = [];
  for (const [prefix, value] of Object.entries(imports)) {
    const targets = conditionTargets(value);
    if (targets.length) rules.push({ prefix, targets: targets.map(stripDot) });
  }
  return rules;
}

/** `"#x": "./a.js"` or `"#x": { "import": "./a.js", "default": "./b.cjs" }`. */
function conditionTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(conditionTargets);
  }
  return [];
}

// ── npm/pnpm workspaces ────────────────────────────────────────────────────

function fromWorkspaces(root: string): AliasRule[] {
  const pkg = readJson(path.join(root, 'package.json'));
  const patterns: string[] = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : [];
  const rules: AliasRule[] = [];
  for (const dir of patterns.flatMap(p => expandWorkspacePattern(root, p))) {
    const sub = readJson(path.join(root, dir, 'package.json'));
    if (typeof sub?.name !== 'string') continue;
    // The package's own entry file is found by the usual extension/index chain
    // once the resolver has the directory, so pointing at the directory is enough.
    rules.push({ prefix: sub.name, targets: [dir] });
  }
  return rules;
}

/** Only the one wildcard form npm actually uses: "packages/*". */
function expandWorkspacePattern(root: string, pattern: string): string[] {
  const clean = stripDot(pattern);
  if (!clean.includes('*')) return [clean];
  const base = clean.slice(0, clean.indexOf('*')).replace(/\/$/, '');
  try {
    return readdirSync(path.join(root, base), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => `${base}/${e.name}`);
  } catch {
    return [];
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function readJson(file: string): any {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

function stripDot(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/$/, '');
}

function joinRel(base: string, rest: string): string {
  return base ? `${base}/${rest}` : rest;
}

/** Drop anything escaping the project root — it can't be a node either way. */
function normalizeRel(p: string): string | undefined {
  const n = path.posix.normalize(p).replace(/^\.\//, '');
  return n.startsWith('..') ? undefined : n;
}

/**
 * tsconfig.json is JSONC: comments and trailing commas are legal and common.
 * String-aware rather than a blind regex, so a "https://…" value survives.
 */
export function parseJsonc(text: string): any {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}
