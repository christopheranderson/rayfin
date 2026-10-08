/**
 * Guards the Category A aggregate-schema guidance so every copyable example
 * uses the entity-class form.
 *
 * `connectorConfig.entities` takes the generated entity classes (value imported
 * and re-exported from `schema.ts`), e.g. `entities: { Order, Customer }`. The
 * client reads each class for the default column selection and relationship
 * cardinality. The stale property-name-array form (`entities: { Order: [...] }`)
 * must not reappear in the guidance.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root, from packages/tools/cli/src/services/agent-files/__tests__. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..', '..');

const GUIDE = join(
  REPO_ROOT,
  'packages',
  'typescript-sdk',
  'connector-fabric-graphql',
  'assets',
  'docs',
  'index.md'
);

/** TypeScript examples in the guide that declare a connector aggregate schema. */
function aggregateSchemaBlocks(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map(
    (m) => m[1]!
  );
  return blocks.filter(
    (b) => b.includes('connectorConfig') && b.includes('GraphQLBackedConnector')
  );
}

/**
 * A relative value import (not `import type`). Entity classes must be value
 * imported so they can be listed in the entities map.
 */
const VALUE_IMPORT = /^import\s+(?!type\b)[^;]*from\s+'\.\/[^']+'/gm;
const VALUE_REEXPORT = /^export\s+(?!type\b)[^;]*from\s+'\.\/[^']+'/gm;

describe('Category A aggregate schema guidance', () => {
  const guide = readFileSync(GUIDE, 'utf8');
  const examples = aggregateSchemaBlocks(guide);

  // Asserted inside single tests rather than `it.each`, which fails at
  // collection time with an opaque error when the guide has no examples.
  it('documents at least one aggregate schema example', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it('imports the entity classes as values, not types', () => {
    for (const [index, block] of examples.entries()) {
      expect(
        block.match(VALUE_IMPORT) ?? [],
        `example ${index}: entity classes must be value-imported so they can be listed in the entities map`
      ).not.toEqual([]);
    }
  });

  it('re-exports the entity classes as values, not types', () => {
    for (const [index, block] of examples.entries()) {
      expect(
        block.match(VALUE_REEXPORT) ?? [],
        `example ${index}: entity classes must be re-exported as values`
      ).not.toEqual([]);
    }
  });

  it('lists entity classes in the entities map, not column-name arrays', () => {
    for (const [index, block] of examples.entries()) {
      // The map is what makes a no-selection read work, so it must be present.
      expect(block, `example ${index}: entities map is required`).toMatch(
        /^\s*entities:\s*\{/m
      );
      const map = block.match(/entities:\s*\{([^}]*)\}/);
      expect(
        map,
        `example ${index}: could not read the entities map`
      ).not.toBeNull();
      // Class references are bare identifiers. A `[` here would be the stale
      // column-name-array form.
      expect(
        map![1],
        `example ${index}: entities values must be entity classes, not column-name arrays`
      ).not.toContain('[');
      const classes = [...map![1]!.matchAll(/\b(\w+)\b/g)].map((m) => m[1]);
      expect(
        classes,
        `example ${index}: entities map must list at least one entity class`
      ).not.toEqual([]);
    }
  });

  it('still exports connectorConfig as a value', () => {
    for (const [index, block] of examples.entries()) {
      expect(block, `example ${index}`).toMatch(
        /export const connectorConfig\b/
      );
    }
  });

  it('documents the entity classes as the default column selection', () => {
    expect(guide).toMatch(/entity\s+\*\*class(es)?\*\*|entity class/i);
    expect(guide).toContain('SELECTION_REQUIRED');
  });
});
