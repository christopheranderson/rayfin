import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCliDiagnosticSession,
  type DiagnosticRetentionLimits,
  pruneDiagnosticLogs,
} from '../index.js';

const INVOCATION_ID = '550e8400-e29b-41d4-a716-446655440000';
const NOW = new Date('2026-09-01T14:30:12.123Z');

describe('createCliDiagnosticSession', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rayfin-diagnostics-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists ordered sanitized records with owner-only permissions', async () => {
    const mirrored: string[] = [];
    const session = await createCliDiagnosticSession({
      commandName: 'up db.apply',
      cliVersion: '1.2.3',
      safeParameterNames: ['--force'],
      configDir: tempDir,
      projectRoot: '/work/project',
      mirror: (line) => mirrored.push(line),
      now: () => NOW,
      invocationId: INVOCATION_ID,
    });

    session.diagnostics.debug({
      area: 'fabric.request',
      message: 'POST with Bearer secret',
      data: { authorization: 'Bearer secret', status: 429 },
    });
    await session.close({ status: 'failed', exitCode: 1 });

    expect(session.logPath).toBe(
      join(
        tempDir,
        'logs',
        `2026-09-01T143012.123Z-up-db-apply-${INVOCATION_ID}.log`
      )
    );
    const lines = (await readFile(session.logPath!, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('INFO invocation Command started');
    expect(lines[1]).toContain('DEBUG fabric.request');
    expect(lines[1]).toContain('Bearer [REDACTED]');
    expect(lines[1]).not.toContain('Bearer secret');
    expect(lines[2]).toContain('ERROR invocation Command completed');
    expect(mirrored).toHaveLength(3);
    expect(mirrored[1]).toBe(`${lines[1]}\n`);

    if (process.platform !== 'win32') {
      expect((await stat(join(tempDir, 'logs'))).mode & 0o777).toBe(0o700);
      expect((await stat(session.logPath!)).mode & 0o777).toBe(0o600);
    }
  });

  it('bounds an invocation file and records truncation', async () => {
    const session = await createCliDiagnosticSession({
      commandName: 'up',
      cliVersion: '1.2.3',
      configDir: tempDir,
      now: () => NOW,
      invocationId: INVOCATION_ID,
      limits: { maxFileBytes: 700 },
    });

    for (let index = 0; index < 20; index += 1) {
      session.diagnostics.debug({
        area: 'build',
        message: `line ${index} ${'x'.repeat(100)}`,
      });
    }
    await session.close({ status: 'success', exitCode: 0 });

    const content = await readFile(session.logPath!, 'utf8');
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(700);
    expect(content).toContain('Additional diagnostic records were truncated');
    expect(content).toContain('Command completed');
  });

  it('preserves valid UTF-8 at the file boundary', async () => {
    const session = await createCliDiagnosticSession({
      commandName: 'up',
      cliVersion: '1.2.3',
      configDir: tempDir,
      now: () => NOW,
      invocationId: INVOCATION_ID,
      limits: { maxFileBytes: 700 },
    });

    session.diagnostics.debug({ area: 'build', message: '😀'.repeat(200) });
    await session.close({ status: 'success' });

    const content = await readFile(session.logPath!);
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(content)
    ).not.toThrow();
  });

  it('drops malformed and post-close events without affecting the caller', async () => {
    const session = await createCliDiagnosticSession({
      commandName: 'up',
      cliVersion: '1.2.3',
      configDir: tempDir,
      now: () => NOW,
      invocationId: INVOCATION_ID,
    });
    const malformed = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        throw new Error('getter failed');
      },
    });

    expect(() =>
      session.diagnostics.debug({
        area: 'bad',
        message: 'bad',
        data: malformed,
      })
    ).not.toThrow();
    await expect(
      session.close({ status: 'success', error: malformed })
    ).resolves.toBeUndefined();
    expect(() =>
      session.diagnostics.debug({ area: 'late', message: 'late' })
    ).not.toThrow();

    const content = await readFile(session.logPath!, 'utf8');
    expect(content).not.toContain('getter failed');
    expect(content).not.toContain('late');
    expect(content).toContain('Command completed');
  });

  it('falls back to a sanitized mirror when persistence cannot start', async () => {
    const blocker = join(tempDir, 'not-a-directory');
    await writeFile(blocker, 'file');
    const mirrored: string[] = [];
    const session = await createCliDiagnosticSession({
      commandName: 'up',
      cliVersion: '1.2.3',
      configDir: blocker,
      mirror: (line) => mirrored.push(line),
      now: () => NOW,
      invocationId: INVOCATION_ID,
    });

    session.diagnostics.debug({
      area: 'auth',
      message: 'Bearer secret',
    });
    await expect(
      session.close({ status: 'success', exitCode: 0 })
    ).resolves.toBeUndefined();

    expect(session.logPath).toBeUndefined();
    expect(mirrored).toHaveLength(3);
    expect(mirrored[0]).toContain('INFO invocation Command started');
    expect(mirrored[1]).toContain('Bearer [REDACTED]');
    expect(mirrored[2]).toContain('INFO invocation Command completed');
    expect(mirrored[2]).toContain('"status":"success"');
    expect(mirrored[2]).toContain('"exitCode":0');
    expect(mirrored[2]).toContain('"durationMs":0');
  });
});

describe('pruneDiagnosticLogs', () => {
  let tempDir: string;
  const limits: DiagnosticRetentionLimits = {
    maxAgeMs: 14 * 24 * 60 * 60 * 1_000,
    maxFiles: 3,
    maxTotalBytes: 1_000,
    maxFileBytes: 200,
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rayfin-retention-'));
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('removes oldest recognized files and preserves unknown files', async () => {
    const names = [0, 1, 2].map(
      (index) =>
        `2026-08-${String(20 + index).padStart(2, '0')}T120000.000Z-up-550e8400-e29b-41d4-a716-44665544000${index}.log`
    );
    for (const [index, name] of names.entries()) {
      const path = join(tempDir, name);
      await writeFile(path, 'x'.repeat(100));
      const timestamp = new Date(`2026-08-${20 + index}T12:00:00Z`);
      await utimes(path, timestamp, timestamp);
    }
    await writeFile(join(tempDir, 'notes.txt'), 'keep');

    await pruneDiagnosticLogs(tempDir, limits, NOW.getTime());

    expect((await readdir(tempDir)).sort()).toEqual([
      names[1],
      names[2],
      'notes.txt',
    ]);
  });
});
