import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeConnectorArtifacts } from '../services/connector-artifacts';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-connector-artifacts-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function seedConnectorArtifacts(name: string): {
  connectorDir: string;
  tempDir: string;
} {
  const connectorDir = join(projectRoot, 'rayfin', 'connectors', name);
  const tempDir = join(projectRoot, 'rayfin', '.temp', 'sources', name);
  mkdirSync(connectorDir, { recursive: true });
  writeFileSync(join(connectorDir, 'schema.ts'), 'export const schema = [];');
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, 'metadata.json'), '{}');
  return { connectorDir, tempDir };
}

describe('removeConnectorArtifacts', () => {
  it('deletes both connector and temp directories when they exist', () => {
    const { connectorDir, tempDir } = seedConnectorArtifacts('salesdb');

    const result = removeConnectorArtifacts(projectRoot, 'salesdb');

    expect(result).toEqual({
      connectorDirRemoved: true,
      tempDirRemoved: true,
    });
    expect(existsSync(connectorDir)).toBe(false);
    expect(existsSync(tempDir)).toBe(false);
  });

  it('returns false flags when neither directory exists', () => {
    const result = removeConnectorArtifacts(projectRoot, 'ghost');

    expect(result).toEqual({
      connectorDirRemoved: false,
      tempDirRemoved: false,
    });
  });

  it('preserves the connector directory when keepConnectorDir is true', () => {
    const { connectorDir, tempDir } = seedConnectorArtifacts('salesdb');

    const result = removeConnectorArtifacts(projectRoot, 'salesdb', {
      keepConnectorDir: true,
    });

    expect(result).toEqual({
      connectorDirRemoved: false,
      tempDirRemoved: true,
    });
    expect(existsSync(connectorDir)).toBe(true);
    expect(existsSync(tempDir)).toBe(false);
  });

  it('does not touch rayfin.yml', () => {
    const rayfinYml = join(projectRoot, 'rayfin', 'rayfin.yml');
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(
      rayfinYml,
      'connectors:\n  salesdb:\n    connector: fabric-sqldatabase\n'
    );
    seedConnectorArtifacts('salesdb');

    removeConnectorArtifacts(projectRoot, 'salesdb');

    expect(existsSync(rayfinYml)).toBe(true);
    expect(readFileSync(rayfinYml, 'utf-8')).toContain('salesdb');
  });
});
