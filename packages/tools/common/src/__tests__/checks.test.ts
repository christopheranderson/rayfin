import { describe, expect, it } from 'vitest';

import {
  evaluatePrereq,
  parseMajorVersion,
  type CommandOutput,
  type PrereqDefinition,
} from '../checks/index.js';

// ── parseMajorVersion ───────────────────────────────────────────────

describe('parseMajorVersion', () => {
  it('parses "v20.11.0" → 20', () => {
    expect(parseMajorVersion('v20.11.0')).toBe(20);
  });

  it('parses "Docker version 24.0.7, build afdd53b" → 24', () => {
    expect(parseMajorVersion('Docker version 24.0.7, build afdd53b')).toBe(24);
  });

  it('returns null for empty string', () => {
    expect(parseMajorVersion('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseMajorVersion('no version here')).toBeNull();
  });
});

// ── evaluatePrereq ──────────────────────────────────────────────────

describe('evaluatePrereq', () => {
  const nodeDef: PrereqDefinition = {
    name: 'Node.js',
    command: 'node --version',
    installUrl: 'https://nodejs.org',
    minMajorVersion: 20,
  };

  const dockerDef: PrereqDefinition = {
    name: 'Docker',
    command: 'docker --version',
    installUrl: 'https://docker.com',
  };

  it('returns pass when version meets minimum', () => {
    const output: CommandOutput = {
      stdout: 'v20.11.0',
      stderr: '',
      exitCode: 0,
    };
    const result = evaluatePrereq(nodeDef, output);
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('v20.11.0');
  });

  it('returns warn when version is below minimum', () => {
    const output: CommandOutput = {
      stdout: 'v18.19.0',
      stderr: '',
      exitCode: 0,
    };
    const result = evaluatePrereq(nodeDef, output);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('20+ required');
    expect(result.installUrl).toBe('https://nodejs.org');
  });

  it('returns fail when command exits non-zero', () => {
    const output: CommandOutput = {
      stdout: '',
      stderr: 'command not found',
      exitCode: 127,
    };
    const result = evaluatePrereq(nodeDef, output);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('Not found');
  });

  it('returns pass for prereq without version constraint', () => {
    const output: CommandOutput = {
      stdout: 'Docker version 24.0.7, build afdd53b',
      stderr: '',
      exitCode: 0,
    };
    const result = evaluatePrereq(dockerDef, output);
    expect(result.status).toBe('pass');
  });

  it('falls back to stderr when stdout is empty', () => {
    const output: CommandOutput = {
      stdout: '',
      stderr: 'v22.0.0',
      exitCode: 0,
    };
    const result = evaluatePrereq(nodeDef, output);
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('v22.0.0');
  });
});
