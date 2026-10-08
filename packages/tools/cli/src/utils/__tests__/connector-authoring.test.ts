/**
 * Verifies the connector authoring gate: which types a Builder can reach
 * through `connector add`, `connector types` and `connector search`.
 *
 * The gate is a pure read of the catalog and needs no environment setup.
 * Vocabulary file handling uses temporary documentation fixtures.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { CONNECTOR_CATALOG } from '@microsoft/rayfin-tools-common/_internal/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  heldConnectorTypeMessage,
  isKnownConnectorType,
  listAuthorableConnectorTypes,
} from '../connector-authoring.js';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../..'
);
const connectorTypePattern = /(?<![-\w])fabric-[a-z0-9-]+\b/gu;
const connectorTypeCodeSpanPattern = /`(fabric-[a-z0-9-]+)`/gu;
const connectorTypeQuotedPattern = /(['"])(fabric-[a-z0-9-]+)\1/gu;
const optionalVocabularyRfc =
  'docs/rfc/connectors/01_connectors-cli-sdk-surface.md';
const publicVocabularyFiles = [
  'openspec/specs/schema-discovery/spec.md',
  'openspec/specs/sources-yaml-schema/spec.md',
  'packages/guide/assets/docs/cli/connectors/index.md',
  'packages/typescript-sdk/connector-fabric-graphql/README.md',
  'packages/typescript-sdk/connector-fabric-graphql/assets/docs/index.md',
];
const vocabularyFiles = [optionalVocabularyRfc, ...publicVocabularyFiles];

function extractConnectorTypeTokens(
  content: string,
  options: { includeExactCodeSpans: boolean }
): Set<string> {
  const tokens = new Set<string>();

  if (options.includeExactCodeSpans) {
    for (const match of content.matchAll(connectorTypeCodeSpanPattern)) {
      tokens.add(match[1]!);
    }
  }
  for (const match of content.matchAll(connectorTypeQuotedPattern)) {
    tokens.add(match[2]!);
  }
  for (const line of content.split(/\r?\n/u)) {
    if (
      !/--type\b|(?:connector|type):\s*`?fabric-|\|\s*Types\s*\|/iu.test(line)
    ) {
      continue;
    }
    for (const match of line.matchAll(connectorTypePattern)) {
      tokens.add(match[0]);
    }
  }

  return tokens;
}

function validateConnectorVocabulary(root: string): void {
  for (const relativePath of vocabularyFiles) {
    let content: string;
    try {
      content = readFileSync(resolve(root, relativePath), 'utf8');
    } catch (error) {
      if (
        relativePath === optionalVocabularyRfc &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
    const tokens = extractConnectorTypeTokens(content, {
      includeExactCodeSpans: true,
    });
    for (const type of tokens) {
      expect(
        isKnownConnectorType(type),
        `${relativePath} presents unknown connector type "${type}"`
      ).toBe(true);
    }
  }
}

describe('connector authoring gate', () => {
  it('hides a held type, keeping every released type', () => {
    const types = listAuthorableConnectorTypes();

    expect(types).not.toContain('kusto');
    expect(types).toContain('fabric-semanticmodel');
    expect(types).toContain('fabric-sqlanalytics');
    expect(types).toContain('fabric-warehouse');
    expect(types).toContain('fabric-sqldatabase');
  });

  it('matches the catalog exactly, so a policy change is the only way to move a type', () => {
    const expected = Object.entries(CONNECTOR_CATALOG)
      .filter(([, meta]) => meta.authoring === 'released')
      .map(([type]) => type);

    expect(listAuthorableConnectorTypes()).toEqual(expected);
  });

  it('keeps agent-facing fabric connector authoring aligned with the catalog', () => {
    const skillFiles = [
      {
        path: resolve(
          repoRoot,
          'samples/universal-app/template/.agents/skills/connectors/SKILL.md'
        ),
        includeExactCodeSpans: true,
      },
      {
        path: resolve(
          repoRoot,
          'samples/universal-app/template/.agents/skills/analytics/SKILL.md'
        ),
        includeExactCodeSpans: false,
      },
      {
        path: resolve(
          repoRoot,
          'samples/universal-app/template/.agents/skills/dax-authoring/SKILL.md'
        ),
        includeExactCodeSpans: false,
      },
      {
        path: resolve(
          repoRoot,
          'samples/universal-app/template/.agents/skills/schema-discovery/SKILL.md'
        ),
        includeExactCodeSpans: false,
      },
      {
        path: resolve(
          repoRoot,
          'packages/tools/cli/assets/agent-files/skills/rayfin-connectors/SKILL.md'
        ),
        includeExactCodeSpans: true,
      },
    ];
    const mentionedTypes = new Set<string>();

    for (const skillFile of skillFiles) {
      const tokens = extractConnectorTypeTokens(
        readFileSync(skillFile.path, 'utf8'),
        skillFile
      );
      for (const type of tokens) {
        mentionedTypes.add(type);
        expect(
          isKnownConnectorType(type),
          `${skillFile.path} presents unknown connector type "${type}"`
        ).toBe(true);
      }
    }

    const releasedFabricTypes = listAuthorableConnectorTypes()
      .filter((type) => type.startsWith('fabric-'))
      .sort();
    expect([...mentionedTypes]).toEqual(
      expect.arrayContaining(releasedFabricTypes)
    );
  });

  it('keeps authoritative connector vocabulary aligned with the catalog', () => {
    validateConnectorVocabulary(repoRoot);
  });

  describe('authoritative connector vocabulary file handling', () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(resolve(tmpdir(), 'rayfin-connector-vocabulary-'));
      for (const relativePath of vocabularyFiles) {
        const filePath = resolve(root, relativePath);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, '`fabric-semanticmodel`');
      }
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('validates the RFC when present', () => {
      expect(() => validateConnectorVocabulary(root)).not.toThrow();
      writeFileSync(resolve(root, optionalVocabularyRfc), '`fabric-unknown`');
      expect(() => validateConnectorVocabulary(root)).toThrow(
        `${optionalVocabularyRfc} presents unknown connector type`
      );
    });

    it('allows only the RFC to be absent', () => {
      unlinkSync(resolve(root, optionalVocabularyRfc));
      expect(() => validateConnectorVocabulary(root)).not.toThrow();
    });

    it.each(publicVocabularyFiles)(
      'still requires %s when the RFC is absent',
      (relativePath) => {
        unlinkSync(resolve(root, optionalVocabularyRfc));
        unlinkSync(resolve(root, relativePath));
        expect(() => validateConnectorVocabulary(root)).toThrow(
          expect.objectContaining({ code: 'ENOENT' })
        );
      }
    );

    it.each(publicVocabularyFiles)(
      'still validates %s when the RFC is absent',
      (relativePath) => {
        unlinkSync(resolve(root, optionalVocabularyRfc));
        writeFileSync(resolve(root, relativePath), '`fabric-unknown`');
        expect(() => validateConnectorVocabulary(root)).toThrow(
          `${relativePath} presents unknown connector type`
        );
      }
    );

    it('does not ignore other RFC read errors', () => {
      const filePath = resolve(root, optionalVocabularyRfc);
      unlinkSync(filePath);
      mkdirSync(filePath);
      expect(() => validateConnectorVocabulary(root)).toThrow(
        expect.objectContaining({ code: 'EISDIR' })
      );
    });
  });

  it('rejects a type the catalog does not have at all', () => {
    expect(listAuthorableConnectorTypes() as string[]).not.toContain(
      'not-a-connector'
    );
    expect(isKnownConnectorType('not-a-connector')).toBe(false);
  });

  it('does not treat an inherited object key as a real connector type', () => {
    // `type in CONNECTOR_CATALOG` matches Object.prototype members, so a
    // `--type constructor` used to reach the held branch and throw a TypeError
    // past the handled-error path - in --json mode that escapes the envelope.
    for (const inherited of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
    ]) {
      expect(isKnownConnectorType(inherited)).toBe(false);
      expect(listAuthorableConnectorTypes() as string[]).not.toContain(
        inherited
      );
      expect(() => heldConnectorTypeMessage(inherited)).not.toThrow();
    }
  });

  it('recognises every real catalog key as known', () => {
    for (const type of Object.keys(CONNECTOR_CATALOG)) {
      expect(isKnownConnectorType(type)).toBe(true);
    }
  });

  it('explains a held type rather than calling it a typo', () => {
    expect(heldConnectorTypeMessage('kusto')).toContain(
      'not available in this release'
    );
  });

  it('names what is available, so a held type is not a dead end', () => {
    // The adjacent unknown-type path lists the supported set, so without this
    // the Builder who typed a real-but-held name got less help than one who
    // made a typo.
    const message = heldConnectorTypeMessage('kusto');
    for (const type of listAuthorableConnectorTypes()) {
      expect(message).toContain(type);
    }
    // The held type is named as the problem, so it must not also appear inside
    // the list of what to use instead.
    const supported = message.slice(message.indexOf('['));
    expect(supported).not.toContain('kusto');
  });

  it('leaves the catalog itself complete, so validation still accepts the type', () => {
    expect(CONNECTOR_CATALOG).toHaveProperty('kusto');
  });
});
