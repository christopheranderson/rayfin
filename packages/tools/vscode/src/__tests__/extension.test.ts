/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { activate } from '../extension';

describe('extension', () => {
  let context: {
    subscriptions: { dispose(): void }[];
    extension: { packageJSON: { version: string } };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      subscriptions: [],
      extension: { packageJSON: { version: '0.0.1-test' } },
    };
  });

  it('registers extension commands and tool', () => {
    activate(context as unknown as vscode.ExtensionContext);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'rayfin.signInWithMicrosoft',
      expect.any(Function)
    );
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'rayfin.up',
      expect.any(Function)
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      'rayfin_up',
      expect.any(Object)
    );
  });
});
