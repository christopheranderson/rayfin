import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import { TodoForm } from '../components/TodoForm';

describe('TodoForm', () => {
  it('calls onAdd with the entered title when submitted', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(undefined);

    render(<TodoForm onAdd={onAdd} />);

    await user.type(screen.getByPlaceholderText('Add new item'), 'Buy milk');
    await user.click(screen.getByRole('button'));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('Buy milk');
  });

  it('shows a validation error and does not call onAdd when the title is empty', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();

    render(<TodoForm onAdd={onAdd} />);

    await user.click(screen.getByRole('button'));

    expect(onAdd).not.toHaveBeenCalled();
    // Validation message comes from the schema generated from the Todo entity
    // (title has `min: 1`), so we only assert that *some* error is rendered.
    const errorEl = document.querySelector('p.text-red-600');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent?.length).toBeGreaterThan(0);
  });
});
