/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { parse } from 'yaml';

import { ext } from '../extensionVariables';

const fileExistsMock = vi.fn();
const readTextFileMock = vi.fn();
const writeTextFileMock = vi.fn();
const findRayfinProjectRootMock = vi.fn();

vi.mock('../utils/fs', () => ({
  fileExists: fileExistsMock,
  readTextFile: readTextFileMock,
  writeTextFile: writeTextFileMock,
}));

vi.mock('../services/rayfin/projectUtils', () => ({
  findRayfinProjectRoot: findRayfinProjectRootMock,
}));

describe('updateRayfinConfig deep merge', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    ext.outputChannel = {
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as unknown as vscode.OutputChannel;

    fileExistsMock.mockResolvedValue(true);
    findRayfinProjectRootMock.mockImplementation(
      async (uri: vscode.Uri) => uri
    );
    writeTextFileMock.mockResolvedValue(undefined);
  });

  it('preserves existing nested service fields while applying partial updates', async () => {
    readTextFileMock.mockResolvedValue(
      `id: sample\nname: Sample\nversion: 1.0.0\nservices:\n  auth:\n    enabled: true\n  data:\n    enabled: true\n  storage:\n    enabled: false\n`
    );

    const { updateRayfinConfig } = await import('../services/rayfin/config');

    const startUri = vscode.Uri.file('/workspace');
    const result = await updateRayfinConfig(
      {
        services: {
          auth: { enabled: true },
          data: { enabled: true, dialect: 'postgresql' },
          storage: { enabled: true },
        },
      },
      startUri
    );

    expect(result).toBe(true);
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);

    const writtenYaml = writeTextFileMock.mock.calls[0][1] as string;
    const writtenConfig = parse(writtenYaml) as {
      services?: {
        auth?: { enabled: boolean };
        data?: { enabled: boolean; dialect?: string };
        storage?: { enabled: boolean };
      };
    };

    expect(writtenConfig.services).toMatchObject({
      auth: { enabled: true },
      data: { enabled: true, dialect: 'postgresql' },
      storage: { enabled: true },
    });
  });
});
