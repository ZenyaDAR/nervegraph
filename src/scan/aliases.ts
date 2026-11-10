import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/** The `module` line of go.mod: the import-path prefix of the repo's own packages. */
export function loadGoModule(root: string): string | undefined {
  return loadGoModules(root, ['go.mod'])[0]?.module;
}

export interface GoModule {
  /** Project-relative directory holding the go.mod ('' for the root). */
  dir: string;
  /** Its `module` path. */
  module: string;
}

/**
 * Every go.mod among `ids` — a multi-module repo has one per module, not
 * necessarily at the root — deepest directory first, so the first one whose
 * directory contains a file is that file's nearest module.
 */
export function loadGoModules(root: string, ids: Iterable<string>): GoModule[] {
  const out: GoModule[] = [];
  for (const id of ids) {
    if (id !== 'go.mod' && !id.endsWith('/go.mod')) continue;
    const file = path.join(root, id);
    if (!existsSync(file)) continue;
    const m = /^\s*module\s+(\S+)/m.exec(readFileSync(file, 'utf8'));
    if (m) out.push({ dir: id.slice(0, -'go.mod'.length).replace(/\/$/, ''), module: m[1] });
  }
  return out.sort((a, b) => b.dir.length - a.dir.length || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/** composer.json's PSR-4/PSR-0 autoload map, as alias rules over '/'-joined names. */
export function loadPsr4(root: string): AliasRule[] {
  const composer = readJson(path.join(root, 'composer.json'));
  if (!composer) return [];
  const rules: AliasRule[] = [];
  for (const key of ['autoload', 'autoload-dev']) {
    const block = composer[key];
    for (const std of ['psr-4', 'psr-0']) {
      const map = block?.[std];
      if (!map || typeof map !== 'object') continue;
      for (const [ns, dirs] of Object.entries(map)) {
        const nsPath = ns.replace(/\\/g, '/');
        // PSR-4 maps the namespace prefix *onto* the directory; PSR-0 keeps the
        // full namespace path under it: Acme\Util\Str -> src/Acme/Util/Str.php.
        const targets = (Array.isArray(dirs) ? dirs : [dirs])
          .filter((d): d is string => typeof d === 'string')
          .map(d => joinRel(stripDot(d), std === 'psr-0' ? `${nsPath}*` : '*'));
        if (targets.length) rules.push({ prefix: `${nsPath}*`, targets });
      }
    }
  }
  return rules;
}

export function loadAliases(root: string): AliasRule[] {
  return [
    ...fromTsconfig(root),
    ...fromPackageImports(root),
    ...fromWorkspaces(root),
  ];
}

// ── tsconfig / jsconfig ────────────────────────────────────────────────────

// ponytail: only a root-level config is read. Per-package configs in a
// monorepo would need a config per directory — add that when a real repo
// needs it; the workspace rules below already cover the common cross-package
// case.
function fromTsconfig(root: string): AliasRule[] {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const opts = readTsconfigChain(file, root, new Set());
    if (!opts) continue;
    // baseUrl is relative to the config that set it; `paths` targets are
    // relative to baseUrl, or to the config that set `paths` when there is none.
    const baseUrl = opts.baseUrl !== undefined ? projectRel(root, opts.baseUrl) : undefined;
    const pathsBase = baseUrl ?? (opts.pathsDir !== undefined ? projectRel(root, opts.pathsDir) : '');
    const rules: AliasRule[] = [];
    if (opts.paths) {
      for (const [prefix, targets] of Object.entries(opts.paths)) {
        if (!Array.isArray(targets)) continue;
        rules.push({
          prefix,
          targets: targets
            .filter((t): t is string => typeof t === 'string')
            .map(t => joinRel(pathsBase, stripDot(t))),
        });
      }
      // TypeScript uses the most specific pattern: an exact key first, then
      // the wildcard with the longest prefix — not declaration order.
      rules.sort((a, b) => specificity(b.prefix) - specificity(a.prefix));
    }
    // baseUrl alone makes every bare specifier resolvable as baseUrl/<spec>.
    // Last, so an explicit `paths` entry wins.
    if (baseUrl !== undefined) rules.push({ prefix: '*', targets: [joinRel(baseUrl, '*')] });
    return rules;
  }
  return [];
}

function specificity(prefix: string): number {
  return prefix.endsWith('*') ? prefix.length - 1 : Number.MAX_SAFE_INTEGER;
}

interface TsOptions {
  /** Absolute directory baseUrl points at. */
  baseUrl?: string;
  paths?: Record<string, unknown>;
  /** Absolute directory of the config that declared `paths`. */
  pathsDir?: string;
}

/**
 * compilerOptions of `file` merged over everything it `extends` (a relative
 * path, a package name, or an array of either); the child wins per option.
 * Undefined when neither the config nor its parents have compilerOptions.
 */
function readTsconfigChain(file: string, root: string, seen: Set<string>): TsOptions | undefined {
  if (seen.has(file) || !existsSync(file)) return undefined;
  seen.add(file);
  const cfg = parseJsonc(readFileSync(file, 'utf8'));
  if (!cfg || typeof cfg !== 'object') return undefined;
  const dir = path.dirname(file);
  let merged: TsOptions | undefined;
  const parents = Array.isArray(cfg.extends) ? cfg.extends : cfg.extends !== undefined ? [cfg.extends] : [];
  for (const ext of parents) {
    if (typeof ext !== 'string') continue;
    const parentFile = resolveExtends(ext, dir, root);
    const parent = parentFile && readTsconfigChain(parentFile, root, seen);
    if (parent) merged = { ...merged, ...parent };
  }
  const co = cfg.compilerOptions;
  if (co && typeof co === 'object') {
    merged ??= {};
    if (typeof co.baseUrl === 'string') merged.baseUrl = path.resolve(dir, co.baseUrl);
    if (co.paths && typeof co.paths === 'object') {
      merged.paths = co.paths;
      merged.pathsDir = dir;
    }
  }
  return merged;
}

function resolveExtends(spec: string, fromDir: string, root: string): string | undefined {
  const withJson = (p: string) => [p, `${p}.json`, path.join(p, 'tsconfig.json')];
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    return withJson(path.resolve(fromDir, spec)).find(isFile);
  }
  // A package name ("@tsconfig/node20/tsconfig.json"): node_modules lookup,
  // walking up from the config, never above the project root.
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const hit = withJson(path.join(dir, 'node_modules', spec)).find(isFile);
    if (hit) return hit;
    if (path.relative(root, dir) === '' || path.dirname(dir) === dir) return undefined;
  }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Absolute path -> project-relative posix path ('' for the root itself). */
function projectRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
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

// Conditions tried first: the ESM entry, then the generic one, then `types`
// (in a monorepo it often points at the .ts source while `import` points at
// an unbuilt dist/). Any other condition follows in declaration order.
const PREFERRED_CONDITIONS = ['import', 'module', 'default', 'types'];

/** `"#x": "./a.js"` or `"#x": { "import": "./a.js", "default": "./b.cjs" }`. */
function conditionTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(conditionTargets);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = [
      ...PREFERRED_CONDITIONS.filter(k => k in obj),
      ...Object.keys(obj).filter(k => !PREFERRED_CONDITIONS.includes(k)),
    ];
    return keys.flatMap(k => conditionTargets(obj[k]));
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
    const inPkg = (t: string) => joinRel(dir, stripDot(t));
    // `exports` subpaths ("./button", "./utils/*") come first, as their own
    // rules, so "@app/ui/button" goes where the package says it does.
    const entry: string[] = [];
    const exp = sub.exports;
    const isSubpathMap = exp && typeof exp === 'object' && !Array.isArray(exp)
      && Object.keys(exp).some(k => k.startsWith('.'));
    if (isSubpathMap) {
      for (const [key, value] of Object.entries(exp as Record<string, unknown>)) {
        const targets = conditionTargets(value).map(inPkg);
        if (key === '.') entry.push(...targets);
        else if (key.startsWith('./') && targets.length) rules.push({ prefix: `${sub.name}/${key.slice(2)}`, targets });
      }
    } else if (exp !== undefined) {
      entry.push(...conditionTargets(exp).map(inPkg)); // "exports": "./x.js" or { import, default }
    }
    for (const field of ['module', 'main']) {
      if (typeof sub[field] === 'string') entry.push(inPkg(sub[field]));
    }
    // The directory last: the usual extension/index chain finds index.* there,
    // and expandAlias maps any other subpath ("@app/ui/button") under it.
    rules.push({ prefix: sub.name, targets: [...entry, dir] });
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
