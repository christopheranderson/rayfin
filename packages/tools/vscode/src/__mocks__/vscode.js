/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vi } from 'vitest';

const outputChannel = {
  appendLine: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
};

const defaultWorkspaceUri = {
  scheme: 'file',
  path: '/workspace',
  fsPath: '/workspace',
  toString: vi.fn(() => 'file:///workspace'),
};

const taskEndListeners = [];

const commands = {
  registerCommand: vi.fn((_id, _handler) => ({ dispose: vi.fn() })),
};

const window = {
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showQuickPick: vi.fn(),
  createOutputChannel: vi.fn(() => outputChannel),
  createTerminal: vi.fn(() => ({
    shellIntegration: undefined,
    sendText: vi.fn(),
    dispose: vi.fn(),
  })),
  onDidChangeTerminalShellIntegration: vi.fn(() => ({ dispose: vi.fn() })),
  onDidEndTerminalShellExecution: vi.fn(() => ({ dispose: vi.fn() })),
  withProgress: vi.fn(async (_options, task) =>
    task(
      { report: vi.fn() },
      {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
      }
    )
  ),
  registerUriHandler: vi.fn(() => ({ dispose: vi.fn() })),
  terminals: [],
};

const l10n = {
  t: vi.fn((message, ...args) => {
    let result = message;
    args.forEach((arg, index) => {
      result = result.replace(`{${index}}`, String(arg));
    });
    return result;
  }),
  uri: undefined,
  bundle: undefined,
};

const authentication = {
  getSession: vi.fn(async () => ({
    accessToken: 'mock-token',
    account: { label: 'mock-user' },
  })),
};

const workspace = {
  workspaceFolders: [{ uri: defaultWorkspaceUri }],
  isTrusted: true,
  onDidGrantWorkspaceTrust: vi.fn(() => ({ dispose: vi.fn() })),
  getConfiguration: vi.fn(() => ({
    get: vi.fn((_key, defaultValue) => defaultValue),
    has: vi.fn(() => false),
    inspect: vi.fn(() => undefined),
    update: vi.fn(async () => undefined),
  })),
  fs: {
    stat: vi.fn(),
    readFile: vi.fn(async () => new TextEncoder().encode('')),
    writeFile: vi.fn(async () => undefined),
    readDirectory: vi.fn(async () => []),
  },
};

const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

const env = {
  openExternal: vi.fn(async () => true),
  uiKind: 1,
};

const UIKind = {
  Desktop: 1,
  Web: 2,
};

const ProgressLocation = {
  Notification: 15,
};

const TaskScope = {
  Workspace: 3,
};

const TaskRevealKind = {
  Silent: 2,
};

const TaskPanelKind = {
  Shared: 1,
};

const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
};

class ShellExecution {
  constructor(commandLineOrCommand, args = [], options = {}) {
    this.commandLine = commandLineOrCommand;
    this.args = args;
    this.options = options;
  }
}

class Task {
  constructor(definition, scope, name, source, execution) {
    this.definition = definition;
    this.scope = scope;
    this.name = name;
    this.source = source;
    this.execution = execution;
    this.presentationOptions = {};
  }
}

class CancellationError extends Error {
  constructor(message = 'Canceled') {
    super(message);
    this.name = 'CancellationError';
  }
}

class CancellationTokenSource {
  constructor() {
    this._listeners = [];
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn((listener) => {
        this._listeners.push(listener);
        return {
          dispose: () => {
            const i = this._listeners.indexOf(listener);
            if (i >= 0) this._listeners.splice(i, 1);
          },
        };
      }),
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this._listeners.forEach((l) => l());
  }
  dispose() {}
}

const tasks = {
  executeTask: vi.fn(async (task) => {
    const execution = { task };
    Promise.resolve().then(() => {
      taskEndListeners.forEach((listener) =>
        listener({ execution, exitCode: 0 })
      );
    });
    return execution;
  }),
  onDidEndTaskProcess: vi.fn((listener) => {
    taskEndListeners.push(listener);
    return {
      dispose: () => {
        const index = taskEndListeners.indexOf(listener);
        if (index >= 0) {
          taskEndListeners.splice(index, 1);
        }
      },
    };
  }),
};

const lm = {
  registerTool: vi.fn((_name, _tool) => ({ dispose: vi.fn() })),
};

const Uri = {
  file: vi.fn((path) => ({ scheme: 'file', path })),
  joinPath: vi.fn((...parts) => ({ scheme: 'file', path: parts.join('/') })),
  parse: vi.fn((value) => ({
    scheme: 'https',
    path: value,
    toString: () => value,
  })),
};

const Disposable = class {
  constructor() {}
  dispose() {}
};

const LanguageModelToolResult = class {
  constructor(parts) {
    this.parts = parts;
  }
};

const LanguageModelTextPart = class {
  constructor(value) {
    this.value = value;
  }
};

/** Reset task listeners between tests (vi.clearAllMocks cannot reach plain arrays). */
function __resetTaskListeners() {
  taskEndListeners.length = 0;
}

export {
  __resetTaskListeners,
  authentication,
  CancellationError,
  CancellationTokenSource,
  commands,
  ConfigurationTarget,
  Disposable,
  env,
  FileType,
  l10n,
  LanguageModelTextPart,
  LanguageModelToolResult,
  lm,
  ProgressLocation,
  ShellExecution,
  Task,
  TaskPanelKind,
  TaskRevealKind,
  TaskScope,
  tasks,
  UIKind,
  Uri,
  window,
  workspace,
};
