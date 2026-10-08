import inquirer from 'inquirer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  promptWorkspaceResolution,
  promptWorkspaceSelection,
} from '../prompts.js';

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

const mockPrompt = inquirer.prompt as unknown as ReturnType<typeof vi.fn>;

describe('promptWorkspaceResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the recommended new workspace before the existing workspace picker', async () => {
    mockPrompt.mockResolvedValue({ workspaceResolution: 'existing' });

    const chosen = await promptWorkspaceResolution();

    expect(chosen).toBe('existing');
    const question = mockPrompt.mock.calls[0][0][0];
    expect(question).toMatchObject({
      type: 'rawlist',
      message: 'Choose a Fabric workspace for this deployment:',
      choices: [
        { name: 'Use new workspace [Recommended]', value: 'new' },
        { name: 'Select existing workspace', value: 'existing' },
      ],
    });
  });

  it('uses the host picker with an explicit numbered choice requirement', async () => {
    const ui = {
      prompt: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn().mockResolvedValue('new'),
    };

    const chosen = await promptWorkspaceResolution(ui);

    expect(chosen).toBe('new');
    expect(ui.select).toHaveBeenCalledWith(
      'Choose a Fabric workspace for this deployment:',
      [
        { label: 'Use new workspace [Recommended]', value: 'new' },
        { label: 'Select existing workspace', value: 'existing' },
      ],
      { requireExplicitChoice: true }
    );
    expect(mockPrompt).not.toHaveBeenCalled();
  });
});

describe('promptWorkspaceSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a numbered picker sorted case-insensitively by display name', async () => {
    mockPrompt.mockResolvedValue({
      selectedWorkspace: { id: 'ws-a', displayName: 'alpha' },
    });

    const chosen = await promptWorkspaceSelection([
      { id: 'ws-c', displayName: 'charlie' },
      { id: 'ws-a', displayName: 'alpha' },
      { id: 'ws-b', displayName: 'Bravo' },
    ]);

    expect(chosen).toEqual({ id: 'ws-a', displayName: 'alpha' });

    const question = mockPrompt.mock.calls[0][0][0];
    // `rawlist` lets the user select by typing a number, per the ask.
    expect(question.type).toBe('rawlist');
    // Sorted case-insensitively: alpha, Bravo, charlie (not ASCII B < a < c).
    expect(question.choices.map((c: { name: string }) => c.name)).toEqual([
      'alpha',
      'Bravo',
      'charlie',
    ]);
    // Each entry carries the full workspace object as its selectable value.
    expect(question.choices[0].value).toEqual({
      id: 'ws-a',
      displayName: 'alpha',
    });
  });

  it('does not mutate the caller-supplied workspace array', async () => {
    mockPrompt.mockResolvedValue({
      selectedWorkspace: { id: 'ws-b', displayName: 'Bravo' },
    });
    const input = [
      { id: 'ws-c', displayName: 'charlie' },
      { id: 'ws-a', displayName: 'alpha' },
    ];

    await promptWorkspaceSelection(input);

    expect(input).toEqual([
      { id: 'ws-c', displayName: 'charlie' },
      { id: 'ws-a', displayName: 'alpha' },
    ]);
  });

  it('disambiguates duplicate display names while preserving workspace values', async () => {
    const selectedWorkspace = { id: 'ws-2', displayName: 'prod' };
    mockPrompt.mockResolvedValue({ selectedWorkspace });

    const chosen = await promptWorkspaceSelection([
      { id: 'ws-1', displayName: 'Prod' },
      selectedWorkspace,
      { id: 'ws-3', displayName: 'Test' },
    ]);

    const question = mockPrompt.mock.calls[0][0][0];
    expect(question.choices).toEqual([
      { name: 'Prod (ws-1)', value: { id: 'ws-1', displayName: 'Prod' } },
      { name: 'prod (ws-2)', value: selectedWorkspace },
      { name: 'Test', value: { id: 'ws-3', displayName: 'Test' } },
    ]);
    expect(chosen).toBe(selectedWorkspace);
  });
});
