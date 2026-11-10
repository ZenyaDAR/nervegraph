import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readGraph } from '../graph/io.ts';
import { fileKind, isExternal } from '../graph/analysis.ts';
import type { Graph } from '../graph/types.ts';

// The gate. `scan` and `view` answer "how is this connected"; `check` turns the
// same artifact into a pass/fail a pipeline can act on, so a regression is
// caught in the PR that causes it rather than in the map six weeks later.
//
// Every budget is opt-in: with no flags, check only fails on a broken graph
// (references to files that are not on disk), which is the one thing nobody
// wants on purpose.

export interface CheckArgs {
  graph?: string;
  json?: boolean;
  maxCycles?: number;
  maxUnresolved?: number;
  maxOrphans?: number;
  allowMissing?: boolean;
  noDeadExports?: boolean;
  noDuplicates?: boolean;
  rules?: string;
}

/**
 * Layer rules, read from a JSON file the user writes:
 *
 *   [{ "name": "ui must not reach the database",
 *      "from": "src/ui/**", "deny": "src/db/**" }]
 *
 * This is the one place the tool passes judgement, and it only ever repeats a
 * judgement the user already made — the tool still has no opinion of its own.
 * `allow` inverts it: any edge out of `from` that does not land in `allow` is
 * a violation.
 */
export interface LayerRule {
  name?: string;
  from: string;
  deny?: string;
  allow?: string;
}

/** Minimal glob: `**` spans separators, `*` does not, `?` is one character. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Why a parsed rules file is unusable, or undefined when it is fine. */
export function validateRules(rules: unknown): string | undefined {
  if (!Array.isArray(rules)) return 'rules must be a JSON array';
  for (const [i, rule] of rules.entries()) {
    const at = `rule #${i + 1}`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return `${at} must be an object`;
    const r = rule as Record<string, unknown>;
    if (typeof r.from !== 'string' || !r.from) return `${at}: "from" must be a non-empty glob string`;
    if (r.deny === undefined && r.allow === undefined) return `${at}: needs "deny" or "allow"`;
    for (const key of ['deny', 'allow', 'name']) {
      if (r[key] !== undefined && typeof r[key] !== 'string') return `${at}: "${key}" must be a string`;
    }
  }
  return undefined;
}

export function checkRules(graph: Graph, rules: LayerRule[]): Violation[] {
  const out: Violation[] = [];
  for (const rule of rules) {
    const from = globToRegExp(rule.from);
    const deny = rule.deny ? globToRegExp(rule.deny) : undefined;
    const allow = rule.allow ? globToRegExp(rule.allow) : undefined;
    const broken = graph.edges.filter(e => {
      if (!from.test(e.from)) return false;
      if (deny) return deny.test(e.to);
      if (allow) return !allow.test(e.to) && !from.test(e.to);
      return false;
    });
    if (broken.length) {
      out.push({
        rule: rule.name ?? `${rule.from} → ${rule.deny ?? `anything but ${rule.allow}`}`,
        actual: broken.length,
        budget: 0,
        detail: broken.map(e => `${e.from}:${e.line} → ${e.to}`),
      });
    }
  }
  return out;
}

export interface Violation {
  rule: string;
  actual: number;
  budget: number | null;
  detail: string[];
}

export async function runCheck(args: CheckArgs): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');
  if (!existsSync(graphPath)) {
    console.error(`error: graph not found at ${graphPath}`);
    console.error('run: nerve scan');
    return 5;
  }
  const graph = await readGraph(graphPath);
  const violations = collectViolations(graph, args);

  // Default location, so `nerve check` picks the rules up with no flag once
  // the file exists; an explicit --rules that is missing is an error.
  const rulesPath = args.rules ? path.resolve(args.rules) : path.join(path.dirname(graphPath), 'rules.json');
  if (existsSync(rulesPath)) {
    let rules: unknown;
    try {
      rules = JSON.parse(await readFile(rulesPath, 'utf8'));
    } catch (e: any) {
      console.error(`error: could not read ${rulesPath}: ${e?.message ?? e}`);
      return 2;
    }
    const problem = validateRules(rules);
    if (problem) {
      console.error(`error: ${rulesPath}: ${problem}`);
      console.error('expected: [{ "name"?: string, "from": "<glob>", "deny": "<glob>" | "allow": "<glob>" }]');
      return 2;
    }
    violations.push(...checkRules(graph, rules as LayerRule[]));
  } else if (args.rules) {
    console.error(`error: rules file not found at ${rulesPath}`);
    return 2;
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
    return violations.length ? 7 : 0;
  }

  if (!violations.length) {
    console.log(`✓ ${graph.stats.files} files, ${graph.stats.edges} edges — every budget met`);
    return 0;
  }

  for (const v of violations) {
    const budget = v.budget === null ? 'not allowed' : `budget ${v.budget}`;
    console.error(`✗ ${v.rule}: ${v.actual} (${budget})`);
    for (const line of v.detail.slice(0, 10)) console.error(`    ${line}`);
    if (v.detail.length > 10) console.error(`    … ${v.detail.length - 10} more`);
  }
  return 7;
}

export function collectViolations(graph: Graph, args: CheckArgs): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, actual: number, budget: number | null, detail: string[]) => {
    out.push({ rule, actual, budget, detail });
  };

  const missing = graph.nodes.filter(n => n.missing);
  if (missing.length && !args.allowMissing) {
    add('missing files', missing.length, 0, missing.map(n => n.id));
  }

  const cycles = graph.cycles ?? [];
  if (args.maxCycles !== undefined && cycles.length > args.maxCycles) {
    add('cycles', cycles.length, args.maxCycles, cycles.map(c => c.join(' -> ')));
  }

  // npm packages, builtins and URLs are not a broken graph; only count the rest.
  const unresolved = graph.unresolved.filter(u => !isExternal(u));
  if (args.maxUnresolved !== undefined && unresolved.length > args.maxUnresolved) {
    add('unresolved references', unresolved.length, args.maxUnresolved,
      unresolved.map(u => `${u.from}:${u.line}  ${u.raw}`));
  }

  // Unreferenced tests, docs and config are expected; only code orphans count.
  const orphans = graph.nodes.filter(n => n.orphan && fileKind(n.id) === 'code');
  if (args.maxOrphans !== undefined && orphans.length > args.maxOrphans) {
    add('orphan code files', orphans.length, args.maxOrphans, orphans.map(n => n.id));
  }

  if (args.noDeadExports) {
    const dead = graph.nodes.filter(n => n.deadExports?.length);
    if (dead.length) {
      add('files with unused exports', dead.length, 0,
        dead.map(n => `${n.id}  ${n.deadExports!.join(', ')}`));
    }
  }

  if (args.noDuplicates) {
    const dupes = graph.duplicates ?? [];
    if (dupes.length) add('duplicate file groups', dupes.length, 0, dupes.map(g => g.join('  ==  ')));
  }

  return out;
}
