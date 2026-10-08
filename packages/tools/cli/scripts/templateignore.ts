import { existsSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import { Minimatch } from 'minimatch';

export interface TemplateIgnoreFileResult {
  source: string;
  patterns: string[];
  exists: boolean;
}

export interface TemplateIgnoreSource {
  source: string;
  patterns: string[];
}

export interface TemplateIgnoreMatcher {
  shouldExclude: (absolutePath: string, isDirectory: boolean) => boolean;
  warnings: string[];
}

export interface TemplateIgnoreSummary {
  directories: Set<string>;
  files: Set<string>;
}

const MINIMATCH_OPTIONS = { dot: true } as const;

function normalizeCopyPath(value: string): string {
  if (process.platform !== 'win32') return value;
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

export function readTemplateIgnoreFile(
  filePath: string
): TemplateIgnoreFileResult {
  if (!existsSync(filePath)) {
    return { source: filePath, patterns: [], exists: false };
  }

  const content = readFileSync(filePath, 'utf8');
  const patterns: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const commentIndex = rawLine.indexOf('#');
    const withoutComment =
      commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine;
    const line = withoutComment.trim();

    if (!line) {
      continue;
    }

    patterns.push(line);
  }

  return { source: filePath, patterns, exists: true };
}

interface CompiledPattern {
  matchers: Minimatch[];
  warnings: string[];
}

function hasUnbalancedPair(
  pattern: string,
  open: string,
  close: string
): boolean {
  const openCount = (pattern.match(new RegExp(`\\${open}`, 'g')) ?? []).length;
  const closeCount = (pattern.match(new RegExp(`\\${close}`, 'g')) ?? [])
    .length;

  if (openCount === closeCount) {
    return false;
  }

  return openCount > 0 || closeCount > 0;
}

function compilePatterns(source: TemplateIgnoreSource): CompiledPattern {
  const matchers: Minimatch[] = [];
  const warnings: string[] = [];

  for (const candidate of source.patterns) {
    const pattern = candidate.trim();
    if (!pattern) {
      continue;
    }

    if (
      hasUnbalancedPair(pattern, '[', ']') ||
      hasUnbalancedPair(pattern, '{', '}') ||
      hasUnbalancedPair(pattern, '(', ')')
    ) {
      warnings.push(
        `[${source.source}] Invalid .templateignore pattern "${pattern}": unbalanced glob tokens`
      );
      continue;
    }

    try {
      const matcher = new Minimatch(pattern, MINIMATCH_OPTIONS);
      const compiled = matcher.makeRe();

      if (!compiled) {
        warnings.push(
          `[${source.source}] Invalid .templateignore pattern "${pattern}": could not compile expression`
        );
        continue;
      }

      matchers.push(matcher);
    } catch (error) {
      warnings.push(
        `[${source.source}] Invalid .templateignore pattern "${pattern}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { matchers, warnings };
}

export function createTemplateIgnoreMatcher(
  rootPath: string,
  sources: TemplateIgnoreSource[]
): TemplateIgnoreMatcher {
  const normalizedRootPath = normalizeCopyPath(rootPath);
  const matchers: Minimatch[] = [];
  const warnings: string[] = [];

  for (const source of sources) {
    const { matchers: compiled, warnings: compileWarnings } =
      compilePatterns(source);
    matchers.push(...compiled);
    warnings.push(...compileWarnings);
  }

  if (matchers.length === 0) {
    return { warnings, shouldExclude: () => false };
  }

  return {
    warnings,
    shouldExclude: (absolutePath: string, isDirectory: boolean) => {
      const relPath = relative(
        normalizedRootPath,
        normalizeCopyPath(absolutePath)
      );
      if (!relPath || relPath.startsWith('..')) {
        return false;
      }

      const normalized = relPath.split(sep).join('/');
      if (!normalized) {
        return false;
      }

      const base = normalized.replace(/\/$/, '');
      const candidates = new Set<string>();
      candidates.add(base);
      if (isDirectory) {
        candidates.add(`${base}/`);
      }

      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }

        if (matchers.some((matcher) => matcher.match(candidate))) {
          return true;
        }
      }

      return false;
    },
  };
}

export function summarizeTemplateIgnorePatterns(
  sources: TemplateIgnoreSource[]
): TemplateIgnoreSummary {
  const directories = new Set<string>();
  const files = new Set<string>();

  for (const source of sources) {
    for (const rawPattern of source.patterns) {
      const pattern = rawPattern.trim();

      if (!pattern) {
        continue;
      }

      if (pattern.endsWith('/')) {
        const dirName = pattern.replace(/\/+$/, '').split('/').pop();
        if (dirName) {
          directories.add(dirName);
        }
      } else {
        const fileName = pattern.split('/').pop();
        if (fileName) {
          files.add(fileName);
        }
      }
    }
  }

  return { directories, files };
}
