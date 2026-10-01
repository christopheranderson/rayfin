/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { ext } from '../extensionVariables';

/**
 * Run a static hosting build command via the VS Code Task API.
 * Returns the process exit code (0 = success).
 */
export async function runStaticBuild(
  buildCommand: string,
  cwd: vscode.Uri
): Promise<number> {
  ext.outputChannel.appendLine(`Running static build command: ${buildCommand}`);

  const taskDefinition: vscode.TaskDefinition = {
    type: 'rayfin-static-build',
  };

  const execution = new vscode.ShellExecution(buildCommand, {
    cwd: cwd.fsPath,
  });

  const task = new vscode.Task(
    taskDefinition,
    vscode.TaskScope.Workspace,
    'Static Build',
    'Rayfin',
    execution
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Silent,
    panel: vscode.TaskPanelKind.Shared,
    clear: true,
  };

  return new Promise<number>((resolve, reject) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task === task) {
        disposable.dispose();
        resolve(event.exitCode ?? 1);
      }
    });

    vscode.tasks.executeTask(task).then(undefined, (error: unknown) => {
      disposable.dispose();
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      reject(new Error(`Failed to start static build task: ${errorMessage}`));
    });
  });
}
