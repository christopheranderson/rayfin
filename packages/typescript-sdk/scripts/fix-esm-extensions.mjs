#!/usr/bin/env node
/**
 * fix-esm-extensions.mjs
 *
 * Post-build helper that rewrites relative imports in emitted `.js` and
 * `.d.ts` files to include explicit `.js` extensions. Without this, Node ESM
 * and TypeScript `moduleResolution: NodeNext`/`Node16` consumers fail to
 * resolve workspace SDK packages because TypeScript itself does not add the
 * extensions when emitting under `moduleResolution: bundler`.
 *
 * Usage:
 *   node fix-esm-extensions.mjs <distDir>
 *
 * Rules:
 *   - Only relative paths (starting with `./` or `../`) are rewritten.
 *   - Imports that already end in `.js`, `.json`, `.mjs`, `.cjs`, or `.node`
 *     are left alone.
 *   - Imports targeting a directory (e.g. `./foo`) are rewritten to
 *     `./foo/index.js` only if `<resolvedDir>/index.js` exists in the dist
 *     output; otherwise they receive `.js`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const distArg = process.argv[2];
if (!distArg) {
  console.error('Usage: node fix-esm-extensions.mjs <distDir>');
  process.exit(1);
}
const distDir = path.resolve(distArg);

const RELATIVE_IMPORT_RE =
  /(\b(?:from|import)\s*\(?\s*|\bexport\s+(?:[\w*\s{},$]+?\s+from\s+))(['"])(\.{1,2}\/[^'"\n]+?)\2/g;

const PRESERVED_EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.node']);

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))
    ) {
      files.push(full);
    }
  }
  return files;
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveSpecifier(currentFile, spec) {
  const ext = path.extname(spec);
  if (PRESERVED_EXTS.has(ext)) {
    return spec;
  }
  const fromDir = path.dirname(currentFile);
  const abs = path.resolve(fromDir, spec);
  if (await pathExists(path.join(abs, 'index.js'))) {
    return spec.replace(/\/?$/, '/index.js');
  }
  return `${spec}.js`;
}

async function rewriteFile(file) {
  const original = await fs.readFile(file, 'utf8');
  const matches = [...original.matchAll(RELATIVE_IMPORT_RE)];
  if (matches.length === 0) return false;

  // Resolve specifiers in parallel, then splice back into the source.
  const replacements = await Promise.all(
    matches.map(async (m) => {
      const [, prefix, quote, spec] = m;
      const fixed = await resolveSpecifier(file, spec);
      return { match: m, replacement: `${prefix}${quote}${fixed}${quote}` };
    })
  );

  let next = '';
  let cursor = 0;
  for (const { match, replacement } of replacements) {
    const start = match.index;
    next += original.slice(cursor, start);
    next += replacement;
    cursor = start + match[0].length;
  }
  next += original.slice(cursor);

  if (next === original) return false;
  await fs.writeFile(file, next, 'utf8');
  return true;
}

(async () => {
  if (!(await pathExists(distDir))) {
    // Nothing to do — e.g. clean run before tsc emit. Treat as a no-op.
    return;
  }
  const files = await walk(distDir);
  let touched = 0;
  for (const file of files) {
    if (await rewriteFile(file)) touched++;
  }
  if (process.env.RAYFIN_VERBOSE === '1') {
    console.log(
      `fix-esm-extensions: rewrote ${touched}/${files.length} files in ${distDir}`
    );
  }
})();
