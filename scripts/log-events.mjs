// scripts/log-events.mjs
// Log event-name migration tooling. See ADR 003 §5 Phase 1a.
//
//   node scripts/log-events.mjs extract   # scan src/, merge new names into the map
//   node scripts/log-events.mjs apply     # rewrite call sites from the map
//   node scripts/log-events.mjs check     # list any event name that is not dotted
//
// The map (scripts/event-map.json, "old name": "new.name") is the thing to
// review — one line per distinct name instead of scattered diff hunks. Names
// that already satisfy the pattern map to themselves.
//
// Only static string literals are handled: `log.<level>('...'`. Dynamic call
// sites (template literals, computed levels) are reported and must be fixed
// by hand — the lint rule rejects them afterwards anyway.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Keep in sync with LOG_EVENT_PATTERN in eslint.config.js.
const PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$/;

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const MAP_FILE = join(import.meta.dirname, 'event-map.json');

const STATIC_CALL = /\blog\.(info|warn|error|debug)\(\s*'([^'\\]*)'/g;
const DYNAMIC_CALL = /\blog(\[[^\]]+\]|\.(info|warn|error|debug))\(\s*[^'\s)]/g;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function readMap() {
  try {
    return JSON.parse(readFileSync(MAP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function scan() {
  const names = new Map(); // name → ["file:line", ...]
  const dynamic = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const match of line.matchAll(STATIC_CALL)) {
        const sites = names.get(match[2]) ?? [];
        sites.push(`${rel}:${i + 1}`);
        names.set(match[2], sites);
      }
      if (DYNAMIC_CALL.test(line)) dynamic.push(`${rel}:${i + 1}  ${line.trim()}`);
      DYNAMIC_CALL.lastIndex = 0;
    });
  }
  return { names, dynamic };
}

function extract() {
  const map = readMap();
  const { names, dynamic } = scan();
  let added = 0;
  for (const name of names.keys()) {
    // A name that is already a mapped target is not a new source name.
    if (name in map || Object.values(map).includes(name)) continue;
    map[name] = PATTERN.test(name) ? name : '';
    added += 1;
  }
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MAP_FILE, JSON.stringify(sorted, null, 2) + '\n');
  const todo = Object.entries(sorted).filter(([, to]) => to === '').length;
  console.log(`${names.size} distinct names; ${added} added; ${todo} still need a target.`);
  if (dynamic.length > 0) {
    console.log(`\nDynamic call sites — fix by hand:\n  ${dynamic.join('\n  ')}`);
  }
}

function apply() {
  const map = readMap();
  const invalid = Object.entries(map).filter(([, to]) => !PATTERN.test(to));
  if (invalid.length > 0) {
    console.error(`Map has missing or invalid targets:\n  ${invalid.map(([f]) => f).join('\n  ')}`);
    process.exit(1);
  }
  let changed = 0;
  for (const file of sourceFiles(SRC)) {
    const before = readFileSync(file, 'utf8');
    const after = before.replace(STATIC_CALL, (whole, level, name) => {
      const to = map[name];
      if (to === undefined || to === name) return whole;
      changed += 1;
      return whole.replace(`'${name}'`, `'${to}'`);
    });
    if (after !== before) writeFileSync(file, after);
  }
  console.log(`Rewrote ${changed} call site(s).`);
}

function check() {
  const { names, dynamic } = scan();
  const bad = [...names.keys()].filter((name) => !PATTERN.test(name));
  for (const name of bad) console.log(`✗ ${name}  (${names.get(name).join(', ')})`);
  for (const line of dynamic) console.log(`✗ dynamic: ${line}`);
  console.log(bad.length + dynamic.length === 0 ? 'All event names are dotted.' : '');
  process.exit(bad.length + dynamic.length === 0 ? 0 : 1);
}

const command = process.argv[2];
if (command === 'extract') extract();
else if (command === 'apply') apply();
else if (command === 'check') check();
else {
  console.error('usage: node scripts/log-events.mjs <extract|apply|check>');
  process.exit(2);
}
