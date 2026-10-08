/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Checklist, type ChecklistRow } from '../webviews/components/Checklist';

describe('Checklist', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders rows with name, description, and action button', () => {
    const onClick = vi.fn();
    const rows: ChecklistRow[] = [
      {
        key: 'node',
        name: 'Node.js',
        status: 'fail',
        description: 'Install Node.js 20 or later',
        action: { label: 'Install', onClick },
      },
    ];

    render(<Checklist rows={rows} ariaLabel="Setup checklist" />);

    const item = screen.getByLabelText('Node.js');
    expect(within(item).getByText('Node.js')).toBeDefined();
    expect(within(item).getByText('Install Node.js 20 or later')).toBeDefined();

    const button = within(item).getByRole('button', { name: 'Install' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('disables the action button while checking', () => {
    const onClick = vi.fn();
    const rows: ChecklistRow[] = [
      {
        key: 'node',
        name: 'Node.js',
        status: 'checking',
        description: 'Checking…',
        action: { label: 'Install', onClick },
      },
    ];

    render(<Checklist rows={rows} ariaLabel="Setup checklist" />);

    const button = screen.getByRole('button', { name: 'Install' });
    expect(button).toHaveProperty('disabled', true);
  });

  it('does not render an action button when action is undefined', () => {
    const rows: ChecklistRow[] = [
      {
        key: 'node',
        name: 'Node.js',
        status: 'pass',
        description: 'v22.0.0',
      },
    ];

    render(<Checklist rows={rows} ariaLabel="Setup checklist" />);

    const item = screen.getByLabelText('Node.js');
    expect(within(item).queryByRole('button')).toBeNull();
  });
});
