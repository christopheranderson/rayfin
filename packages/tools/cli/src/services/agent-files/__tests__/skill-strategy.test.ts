/**
 * Tests for SkillStrategy — frontmatter sigil, line-ending normalization, file ops.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { skillStrategy } from '../strategies/skill.js';
import type { Descriptor } from '../types.js';

const DESCRIPTOR: Descriptor = {
  kind: 'skill',
  name: 'rayfin',
  bundledAsset: 'skills/rayfin/SKILL.md',
};

let projectRoot: string;
const skillFilePath = (root: string) =>
  join(root, '.agents', 'skills', 'rayfin', 'SKILL.md');

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-skill-strategy-test-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const BUNDLED_RAW = `---
name: rayfin
description: Test skill
---

# Body
Hello.
`;

describe('read', () => {
  it('returns null when the file is absent', () => {
    expect(skillStrategy.read(projectRoot, DESCRIPTOR)).toBeNull();
  });

  it('returns the file content when present', () => {
    skillStrategy.write(projectRoot, DESCRIPTOR, BUNDLED_RAW);
    const content = skillStrategy.read(projectRoot, DESCRIPTOR);
    expect(content).not.toBeNull();
    expect(content).toContain('# Body');
  });

  it('normalizes CRLF to LF', () => {
    mkdirSync(join(projectRoot, '.agents', 'skills', 'rayfin'), {
      recursive: true,
    });
    writeFileSync(
      skillFilePath(projectRoot),
      BUNDLED_RAW.replace(/\n/g, '\r\n'),
      'utf8'
    );
    const content = skillStrategy.read(projectRoot, DESCRIPTOR)!;
    expect(content).not.toContain('\r');
  });
});

describe('write', () => {
  it('creates the parent directory', () => {
    skillStrategy.write(projectRoot, DESCRIPTOR, BUNDLED_RAW);
    expect(existsSync(skillFilePath(projectRoot))).toBe(true);
  });

  it('stamps rayfin-managed: true into existing frontmatter', () => {
    skillStrategy.write(projectRoot, DESCRIPTOR, BUNDLED_RAW);
    const content = readFileSync(skillFilePath(projectRoot), 'utf8');
    expect(content).toMatch(/rayfin-managed:\s*true/);
    expect(content).toContain('# Body');
  });

  it('overwrites an existing rayfin-managed: false flag', () => {
    const raw = `---
name: rayfin
rayfin-managed: false
---

body
`;
    skillStrategy.write(projectRoot, DESCRIPTOR, raw);
    const content = readFileSync(skillFilePath(projectRoot), 'utf8');
    expect(content).toMatch(/rayfin-managed:\s*true/);
    expect(content).not.toMatch(/rayfin-managed:\s*false/);
  });

  it('adds frontmatter when none exists', () => {
    skillStrategy.write(
      projectRoot,
      DESCRIPTOR,
      '# Just a body\nNo frontmatter.\n'
    );
    const content = readFileSync(skillFilePath(projectRoot), 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toMatch(/rayfin-managed:\s*true/);
  });

  it('returns the canonical content', () => {
    const canonical = skillStrategy.write(projectRoot, DESCRIPTOR, BUNDLED_RAW);
    expect(canonical).toMatch(/rayfin-managed:\s*true/);
    expect(skillStrategy.hash(canonical)).toBe(
      skillStrategy.hash(skillStrategy.read(projectRoot, DESCRIPTOR)!)
    );
  });
});

describe('hash', () => {
  it('is deterministic', () => {
    const content = 'hello world\n';
    expect(skillStrategy.hash(content)).toBe(skillStrategy.hash(content));
  });

  it('differs for different content', () => {
    expect(skillStrategy.hash('a')).not.toBe(skillStrategy.hash('b'));
  });
});

describe('hasManagedSigil', () => {
  it('returns true when rayfin-managed: true is present', () => {
    expect(
      skillStrategy.hasManagedSigil(`---\nrayfin-managed: true\n---\n\nbody`)
    ).toBe(true);
  });

  it('returns false when the flag is missing', () => {
    expect(skillStrategy.hasManagedSigil(`---\nname: x\n---\n\nbody`)).toBe(
      false
    );
  });

  it('returns false when the flag is false', () => {
    expect(
      skillStrategy.hasManagedSigil(`---\nrayfin-managed: false\n---\n\nbody`)
    ).toBe(false);
  });

  it('returns false for content with no frontmatter', () => {
    expect(
      skillStrategy.hasManagedSigil('# body\nrayfin-managed: true\n')
    ).toBe(false);
  });

  it('rejects the string "true" — sigil must be the boolean true', () => {
    // With proper YAML parsing (vs the older regex), only the boolean true
    // satisfies the sigil. A user who writes `rayfin-managed: "true"` is
    // intentionally writing a string, which we don't treat as opt-in.
    expect(
      skillStrategy.hasManagedSigil(`---\nrayfin-managed: "true"\n---\n\nbody`)
    ).toBe(false);
  });

  it('rejects malformed YAML frontmatter', () => {
    expect(
      skillStrategy.hasManagedSigil(
        `---\nrayfin-managed: true\n  bad: indent\n: missing-key\n---\n\nbody`
      )
    ).toBe(false);
  });
});

describe('delete', () => {
  it('removes the entire skill folder', () => {
    skillStrategy.write(projectRoot, DESCRIPTOR, BUNDLED_RAW);
    skillStrategy.delete(projectRoot, DESCRIPTOR);
    expect(existsSync(join(projectRoot, '.agents', 'skills', 'rayfin'))).toBe(
      false
    );
  });

  it('is a no-op when the folder is already absent', () => {
    expect(() => skillStrategy.delete(projectRoot, DESCRIPTOR)).not.toThrow();
  });
});
