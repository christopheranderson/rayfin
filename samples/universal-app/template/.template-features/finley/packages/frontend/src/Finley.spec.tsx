//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmptyStatePreview } from './EmptyStatePreview';
import { Finley } from './Finley';
import { Welcome } from './Welcome';
import {
  AREAS,
  describeChange,
  parseActivity,
  type ActivityChange,
  type SourceActivity,
} from './Welcome.activity';

const preference = { reduced: false, listeners: new Set<() => void>() };

function FinleyWelcome(props: ComponentProps<typeof Welcome>) {
  return <Welcome companion={Finley} companionName="Finley" {...props} />;
}

beforeEach(() => {
  preference.reduced = false;
  preference.listeners.clear();
  vi.useFakeTimers({
    toFake: [
      'Date',
      'performance',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
  // The internal dev hook polls fetch; make it fail so injected props drive the tests.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Local illustration');
    })
  );
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return preference.reduced;
    },
    addEventListener(_name: string, listener: () => void) {
      preference.listeners.add(listener);
    },
    removeEventListener(_name: string, listener: () => void) {
      preference.listeners.delete(listener);
    },
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const helper = () =>
  screen.getByRole('button', { name: /your app builder\. Say hello/ });
const tick = (time: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(time);
  });
const change = (
  family: ActivityChange['family'],
  id: string = family,
  kind: ActivityChange['kind'] = 'add'
): ActivityChange => ({ id, family, kind, at: new Date().toISOString() });

function activity(changes: ActivityChange[] = []): SourceActivity {
  return {
    structure: AREAS.map(({ family }) => ({
      family,
      count: changes.some((item) => item.family === family) ? 1 : 0,
      lastChangedAt: changes.find((item) => item.family === family)?.at ?? null,
      ...(family === 'connections' ? { names: [] } : {}),
    })),
    changes,
    generatedAt: new Date().toISOString(),
  };
}

describe('FinleyWelcome illustration and interaction', () => {
  it('uses the mascot selection recorded by scaffolding', () => {
    vi.stubEnv('DEV', false);
    render(<EmptyStatePreview />);
    expect(
      screen.queryByRole('button', { name: /Finley, your app builder/ }) !==
        null
    ).toBe(true);
  });

  it('shows the new blueprint without Finley when disabled', () => {
    const { container } = render(<Welcome activity={null} />);
    expect(
      screen.getByRole('heading', { name: 'Your app is taking shape' })
    ).toBeVisible();
    expect(screen.getByText('See each piece as it takes shape.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Finley/ })).toBeNull();
    expect(container.querySelector('.app-welcome__trail')).toBeNull();
    expect(container.textContent).not.toContain('Finley');
    act(() => vi.advanceTimersByTime(12_000));
    expect(container.textContent).not.toContain('Finley');
  });

  it('keeps live activity and changed tiles when the mascot is disabled', async () => {
    const { container } = render(
      <Welcome activity={activity([change('logic', 'calc', 'update')])} />
    );
    await tick(0);
    expect(screen.getByText('Live activity')).toBeVisible();
    expect(container.querySelector('[data-family="logic"]')).toHaveAttribute(
      'data-active',
      'true'
    );
    expect(screen.getByText('Updated the calculations')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Finley/ })).toBeNull();
  });

  it('keeps the headline and blueprint, names Finley, and drops the host tour', () => {
    render(<FinleyWelcome activity={null} />);
    expect(
      screen.getByRole('heading', { name: 'Your app is taking shape' })
    ).toBeVisible();
    for (const area of AREAS)
      expect(
        screen.getByRole('heading', { name: area.label })
      ).toBeInTheDocument();
    expect(
      screen.getByText('A typical journey, not a live update.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Finley sketches each piece as it appears.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // The factory host tour, publishing actions, and chat prompt are gone.
    for (const label of [
      'Files',
      'Build log',
      'Services',
      'Open',
      'Manage in Fabric',
      'Tell Copilot in the chat',
    ]) {
      expect(
        screen.queryByText(label, { exact: false })
      ).not.toBeInTheDocument();
    }
  });

  it('keeps visible copy and accessible labels free of host or internal terms, with no em dash', () => {
    const { container } = render(<FinleyWelcome activity={null} connecting />);
    const labels = Array.from(
      container.querySelectorAll('[aria-label], [title]')
    ).map(
      (node) =>
        `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`
    );
    expect([container.textContent, ...labels].join(' ')).not.toMatch(
      /\u2014|\b(?:MCP|Cowork|factory|agentd|widget|harness|sandbox|container|Rayfin)\b/i
    );
  });

  it('names Finley in both visible copy and the mascot accessible label', () => {
    const { container } = render(<FinleyWelcome activity={null} />);
    const name = helper().getAttribute('aria-label')!.split(',')[0];
    expect(name).toBe('Finley');
    expect(container.textContent).toContain('Finley');
    expect(helper()).toHaveAttribute('title', 'Say hello to Finley');
  });

  it('measures time since mount without presenting a build ETA', () => {
    render(<FinleyWelcome activity={null} />);
    act(() => vi.advanceTimersByTime(72_000));
    expect(screen.getByRole('timer')).toHaveTextContent('Time here 1m 12s');
    expect(
      screen.getByLabelText('Typical build steps, not live build status')
    ).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('cycles typical steps indefinitely and preserves partial step time while paused', () => {
    const { container } = render(<FinleyWelcome activity={null} />);
    const phase = () =>
      container.querySelector('.app-welcome__phase')?.textContent;
    expect(phase()).toBe('Getting to know your idea');
    act(() => vi.advanceTimersByTime(4000));
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep the page still' })
    );
    act(() => vi.advanceTimersByTime(20_000));
    expect(phase()).toBe('Getting to know your idea');
    expect(screen.getByRole('timer')).toHaveTextContent('0m 24s');
    expect(screen.getByRole('main')).toHaveAttribute('data-static', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Let the page move' }));
    act(() => vi.advanceTimersByTime(2000));
    expect(phase()).toBe('Making a space for your work');
  });

  it('keeps a static helper, manual steps and a ticking clock under reduced motion', () => {
    preference.reduced = true;
    const { container } = render(<FinleyWelcome activity={null} />);
    expect(screen.getByRole('main')).toHaveAttribute('data-static', 'true');
    expect(helper()).toHaveAttribute('data-behavior', 'idle');
    expect(
      screen.queryByRole('button', { name: 'Keep the page still' })
    ).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(12_000));
    expect(screen.getByRole('timer')).toHaveTextContent('0m 12s');
    fireEvent.click(
      screen.getByRole('button', { name: 'Bringing your data together' })
    );
    expect(
      screen.getByRole('button', { name: 'Bringing your data together' })
    ).toHaveAttribute('aria-pressed', 'true');
    act(() => vi.advanceTimersByTime(12_000));
    expect(container.querySelector('.app-welcome__phase')).toHaveTextContent(
      'Bringing your data together'
    );
    fireEvent.click(helper());
    expect(helper()).toHaveAttribute('data-reaction', 'wink');
    act(() => vi.advanceTimersByTime(900));
    expect(helper()).toHaveAttribute('data-reaction', 'none');
  });

  it('greets on hover and holds the current scene until the pointer leaves', () => {
    render(<FinleyWelcome activity={null} />);
    act(() => vi.advanceTimersByTime(1000));
    const character = helper();
    fireEvent.pointerEnter(character);
    expect(screen.getByRole('main')).toHaveAttribute('data-moving', 'false');
    expect(character.closest('.app-welcome__trail')).toHaveAttribute(
      'data-greeting',
      'true'
    );
    expect(character).toHaveAttribute('data-reaction', 'wave');
    fireEvent.pointerLeave(character);
    act(() => vi.advanceTimersByTime(1599));
    expect(helper()).toHaveAttribute('data-behavior', 'idle');
    act(() => vi.advanceTimersByTime(1));
    expect(helper()).toHaveAttribute('data-behavior', 'walk');
  });

  it('holds keyboard focus through a greeting and visibility changes', () => {
    render(<FinleyWelcome activity={null} />);
    const character = helper();
    vi.spyOn(character, 'matches').mockImplementation(
      (selector) => selector === ':focus-visible'
    );
    act(() => character.focus());
    expect(character).toHaveAttribute('data-reaction', 'wave');
    expect(screen.getByRole('main')).toHaveAttribute('data-moving', 'false');
    fireEvent.click(character);
    act(() => vi.advanceTimersByTime(10_000));
    expect(character).toHaveFocus();
    act(() => character.blur());
    expect(screen.getByRole('main')).toHaveAttribute('data-moving', 'true');
  });

  it('celebrates an illustrative step change, but never implies a measured milestone', () => {
    render(<FinleyWelcome activity={null} />);
    act(() => vi.advanceTimersByTime(6000));
    expect(helper()).toHaveAttribute('data-reaction', 'celebrate');
    act(() => vi.advanceTimersByTime(900));
    expect(helper()).toHaveAttribute('data-reaction', 'none');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('FinleyWelcome live blueprint (injected feed)', () => {
  const live = (value = activity()) =>
    render(<FinleyWelcome activity={value} />);

  it('replaces the illustrative loop with observed activity and never claims completion', () => {
    live(activity([change('logic', 'calc', 'update')]));
    expect(screen.getByText('Live activity')).toBeInTheDocument();
    expect(
      screen.queryByText('A typical journey, not a live update.')
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('fills changed areas, correlates the ticker and pulse, then walks, builds, looks and waves', async () => {
    const { container } = live(activity([change('logic', 'calc', 'update')]));
    const tile = container.querySelector('[data-family="logic"]')!;
    expect(tile).toHaveAttribute('data-filled', 'true');
    expect(tile).toHaveAttribute('data-active', 'true');
    expect(tile).toHaveTextContent('Just updated');
    expect(tile.querySelector('.app-welcome__area-pulse')).not.toBeNull();
    expect(screen.getByText('Updated the calculations')).toBeInTheDocument();
    expect(helper()).toHaveAttribute('data-target', 'logic');
    expect(helper()).toHaveAttribute('data-behavior', 'walk');
    await tick(1600);
    expect(helper()).toHaveAttribute('data-behavior', 'build');
    await tick(1400);
    expect(helper()).toHaveAttribute('data-behavior', 'look');
    await tick(700);
    expect(helper()).toHaveAttribute('data-behavior', 'wave');
  });

  it('shows connector settings copy that never claims a live connection, path, or raw identifier', () => {
    const value = activity([change('connections')]);
    value.structure.find((area) => area.family === 'connections')!.names = [
      'Contoso Retail Sales',
    ];
    const { container } = live(value);
    expect(
      screen.getByText('Configured for Contoso Retail Sales')
    ).toBeInTheDocument();
    expect(screen.getByText('Added connection settings')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(
      /src\/|rayfin\/|apply_patch|Connected to|Connected a/
    );
    expect(describeChange(change('connections', 'gone', 'delete'))).toBe(
      'Removed connection settings'
    );
    expect(describeChange(change('connections', 'edited', 'update'))).toBe(
      'Updated connection settings'
    );
    expect(describeChange(change('screens', 'removed', 'delete'))).toBe(
      'Removed a screen'
    );
    expect(describeChange(change('styling', 'changed', 'update'))).toBe(
      'Refined the look and feel'
    );
  });

  it('keeps updates live while reduced motion holds the helper in place', () => {
    preference.reduced = true;
    const { container } = live(activity([change('data')]));
    expect(helper()).toHaveAttribute('data-target', 'screens');
    expect(screen.getByRole('main')).toHaveAttribute('data-static', 'true');
    expect(container.querySelector('[data-family="data"]')).toHaveAttribute(
      'data-filled',
      'true'
    );
    expect(helper()).not.toHaveAttribute('data-behavior', 'walk');
  });

  it('rejects malformed feed data rather than crashing the page', () => {
    expect(parseActivity(activity())).not.toBeNull();
    for (const value of [
      null,
      {},
      '<html/>',
      { ...activity(), changes: [{ family: 'unknown' }] },
      { ...activity(), structure: [] },
      { ...activity(), generatedAt: 'not-a-date' },
    ]) {
      expect(parseActivity(value)).toBeNull();
    }
  });
});

describe('FinleyWelcome dev activity endpoint', () => {
  const validPayload = () => JSON.stringify(activity([change('styling')]));

  it('does not poll when a caller supplies its own activity or illustration', async () => {
    const { rerender } = render(<FinleyWelcome activity={null} />);
    await tick(5000);
    rerender(<FinleyWelcome activity={activity()} />);
    await tick(5000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('polls only the base-relative dev endpoint every 2.5 seconds while running under vite dev', async () => {
    vi.stubEnv('BASE_URL', '/apps/sample/');
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(validPayload(), {
          headers: { 'Content-Type': 'application/json' },
        })
    );
    render(<FinleyWelcome />);
    await tick(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      '/apps/sample/@fabric-app/source-activity',
      expect.objectContaining({
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      })
    );
    expect(screen.getByText('Live activity')).toBeInTheDocument();
    await tick(2499);
    expect(fetch).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to illustration on HTML or errors and never leaves a hung request or timer', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>Local preview</html>')
    );
    const { unmount } = render(<FinleyWelcome />);
    await tick(0);
    expect(
      screen.getByText('A typical journey, not a live update.')
    ).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes no request in a production build where there is no dev endpoint', async () => {
    vi.stubEnv('DEV', false);
    render(<FinleyWelcome />);
    await tick(5000);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      screen.getByText('A typical journey, not a live update.')
    ).toBeInTheDocument();
  });
});

describe('FinleyWelcome connection notice', () => {
  it('shows connection failures immediately and escapes provider markup', () => {
    const { rerender, container } = render(
      <FinleyWelcome
        activity={null}
        connecting={{ error: 'Connection unavailable.' }}
      />
    );
    expect(
      screen.queryByText("We're getting connected to your data.")
    ).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Connection unavailable.'
    );
    rerender(
      <FinleyWelcome
        activity={null}
        connecting={{ error: '<b>Another connection problem.</b>' }}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      '<b>Another connection problem.</b>'
    );
    expect(
      container.querySelector('.app-welcome__connection-error b')
    ).toBeNull();
  });
});
