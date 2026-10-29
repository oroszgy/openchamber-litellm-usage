import { expect, test } from 'bun:test';
import type { GuestStatusControl, GuestStatusControlEvent, HostReadyContext } from '@openchamber/sdk';
import { start, type GuestHost } from '../status/app';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function readyContext(features?: { statusControls?: true }): HostReadyContext {
  return {
    directory: '/proj',
    theme: { mode: 'dark', tokens: new Proxy({}, { get: () => '' }) },
    surface: 'status',
    ...(features ? { features } : {}),
  } as unknown as HostReadyContext;
}

const providers = {
  providers: [{ id: 'litellm', name: 'LiteLLM' }],
  default: 'litellm',
};

const twoProviders = {
  providers: [
    { id: 'litellm', name: 'LiteLLM' },
    { id: 'claude-proxy', name: 'Claude proxy' },
  ],
  default: 'litellm',
};

const usage = {
  rolling: { day: 1.2, week: 8.4, month: 21 },
};

type HostStub = {
  host: GuestHost;
  heights: number[];
  requests: string[];
  stored: Array<[string, unknown]>;
  controls: GuestStatusControl[][];
  /** Push `ready`, the way the host does on a session or theme change. */
  emitReady: (context?: HostReadyContext) => void;
  /** Push a `directory` change. */
  emitDirectory: (directory: string | null) => void;
  /** Activate a host-rendered control. */
  emitStatusControl: (event: GuestStatusControlEvent) => void;
};

function hostStub(answers: {
  providers: unknown;
  usage?: unknown;
  stored?: Record<string, unknown>;
  /** Status for `/usage`; non-200 stands in for a failing proxy. */
  usageStatus?: () => number;
  features?: { statusControls?: true };
  controlsError?: boolean;
}): HostStub {
  const heights: number[] = [];
  const requests: string[] = [];
  const stored: Array<[string, unknown]> = [];
  const controls: GuestStatusControl[][] = [];
  const readStored: Record<string, unknown> = { ...answers.stored };
  const readyListeners = new Set<(context: HostReadyContext) => void>();
  const directoryListeners = new Set<(directory: string | null) => void>();
  const controlListeners = new Set<(event: GuestStatusControlEvent) => void>();
  let lastReady: HostReadyContext | undefined;

  const host = {
    onReady: (listener: (context: HostReadyContext) => void) => {
      readyListeners.add(listener);
      if (lastReady) listener(lastReady);
      return () => readyListeners.delete(listener);
    },
    onDirectory: (listener: (directory: string | null) => void) => {
      directoryListeners.add(listener);
      if (lastReady) listener(lastReady.directory);
      return () => directoryListeners.delete(listener);
    },
    onStatusControl: (listener: (event: GuestStatusControlEvent) => void) => {
      controlListeners.add(listener);
      return () => controlListeners.delete(listener);
    },
    setStatusControls: async (next: GuestStatusControl[]) => {
      controls.push(next);
      if (answers.controlsError) throw new Error('UNSUPPORTED');
    },
    serviceRequest: async (request: { path: string; query?: Record<string, string> }) => {
      requests.push(`${request.path}?${new URLSearchParams(request.query ?? {}).toString()}`);
      if (request.path === '/providers') return { status: 200, body: JSON.stringify(answers.providers) };
      if (request.path === '/usage') {
        const status = answers.usageStatus?.() ?? 200;
        if (status >= 400) {
          return {
            status,
            body: JSON.stringify({ error: { code: 'upstream_error', message: 'The LiteLLM proxy could not be reached.' } }),
          };
        }
        return { status, body: JSON.stringify(answers.usage) };
      }
      return { status: 404, body: '{}' };
    },
    setHeight: async (height: number) => {
      heights.push(height);
    },
    storage: {
      get: async (key: string) => readStored[key],
      set: async (key: string, value: unknown) => {
        stored.push([key, value]);
        readStored[key] = value;
      },
      delete: async () => {},
      keys: async () => [],
    },
  } as unknown as GuestHost;

  // One `ready` replays to `onReady` *and* `onDirectory`, as the SDK does.
  const emitReady = (context: HostReadyContext = readyContext(answers.features)): void => {
    lastReady = context;
    for (const listener of readyListeners) listener(context);
    for (const listener of directoryListeners) listener(context.directory);
  };
  const emitDirectory = (directory: string | null): void => {
    if (lastReady) lastReady = { ...lastReady, directory };
    for (const listener of directoryListeners) listener(directory);
  };
  const emitStatusControl = (event: GuestStatusControlEvent): void => {
    for (const listener of controlListeners) listener(event);
  };

  // Push the first ready once `start` has registered its listeners.
  queueMicrotask(() => emitReady());

  return { host, heights, requests, stored, controls, emitReady, emitDirectory, emitStatusControl };
}

test('shows the three rolling rows and has no spend toggle', async () => {
  const { host, heights, requests, stored } = hostStub({ providers, usage });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  const rows = [...root.querySelectorAll('.llu-row')];
  expect(rows.map((row) => row.querySelector('.llu-label')?.textContent)).toEqual([
    'Today',
    'Last 7 days',
    'Last 30 days',
  ]);
  expect(rows.map((row) => row.querySelector('.llu-value')?.textContent)).toEqual([
    '$1.20',
    '$8.40',
    '$21.00',
  ]);
  expect(root.querySelector('.llu-toggle')).toBeNull();
  expect(stored).toEqual([]);
  expect(requests[0]).toBe('/providers?directory=%2Fproj');
  expect(requests[1]).toBe('/usage?provider=litellm&directory=%2Fproj');
  expect(heights.at(-1)).toBe(84);
});

test('a budget window renders the percentage, detail and tone', async () => {
  const { host } = hostStub({
    providers,
    usage: {
      rolling: { day: 0, week: 18, month: 21 },
      budgets: {
        day: { cap: 10, spend: 8.4 },
        month: { cap: 100, spend: 21 },
      },
    },
  });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  const rows = [...root.querySelectorAll('.llu-row')];
  expect(rows[0]?.querySelector('.llu-label')?.textContent).toBe('Today $8.40 of $10.00');
  expect(rows[0]?.querySelector('.llu-value')?.textContent).toBe('84%');
  expect((rows[0]?.querySelector('.llu-value') as HTMLElement).dataset.tone).toBe('error');
  expect(rows[1]?.querySelector('.llu-value')?.textContent).toBe('$18.00');
  expect(rows[2]?.querySelector('.llu-label')?.textContent).toBe('Last 30 days $21.00 of $100.00');
  expect(rows[2]?.querySelector('.llu-value')?.textContent).toBe('21%');
  expect((rows[2]?.querySelector('.llu-value') as HTMLElement).dataset.tone).toBeUndefined();
});

test('a single ready loads the section once, though it reaches both listeners', async () => {
  const { host, requests } = hostStub({ providers, usage });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(requests.filter((path) => path.startsWith('/providers'))).toHaveLength(1);
});

test('a repeated ready refreshes in place without blanking the figures', async () => {
  const { host, heights, requests, emitReady } = hostStub({ providers, usage });
  const root = document.createElement('div');

  start(host, root);
  await settle();
  const painted = [...root.querySelectorAll('.llu-row')].map((row) => row.textContent);
  expect(painted).toHaveLength(3);
  const heightsAfterFirstPaint = heights.length;
  const providerCalls = requests.filter((path) => path.startsWith('/providers')).length;

  emitReady();

  // Synchronously: the figures are still on screen, no loading line.
  expect([...root.querySelectorAll('.llu-row')]).toHaveLength(3);
  expect(root.textContent).not.toContain('Loading');

  await settle();

  expect([...root.querySelectorAll('.llu-row')].map((row) => row.textContent)).toEqual(painted);
  expect(requests.filter((path) => path.startsWith('/providers'))).toHaveLength(providerCalls + 1);
  expect(heights).toHaveLength(heightsAfterFirstPaint);
});

test('a failed refresh keeps the last figures on screen', async () => {
  let failing = false;
  const { host, emitReady } = hostStub({ providers, usage, usageStatus: () => (failing ? 502 : 200) });
  const root = document.createElement('div');

  start(host, root);
  await settle();
  const painted = [...root.querySelectorAll('.llu-row')].map((row) => row.textContent);

  failing = true;
  emitReady();
  await settle();

  expect([...root.querySelectorAll('.llu-row')].map((row) => row.textContent)).toEqual(painted);
  expect(root.querySelector('.llu-error')).toBeNull();
});

test('a project change reloads for the new directory', async () => {
  const { host, requests, emitDirectory } = hostStub({ providers, usage });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  emitDirectory('/other');
  await settle();

  const providerCalls = requests.filter((path) => path.startsWith('/providers'));
  expect(providerCalls.at(-1)).toBe('/providers?directory=%2Fother');
  expect(requests.at(-1)).toBe('/usage?provider=litellm&directory=%2Fother');
  expect([...root.querySelectorAll('.llu-row')]).toHaveLength(3);
});

test('shows the notice when rolling spend is unavailable', async () => {
  const { host, heights } = hostStub({
    providers,
    usage: {
      budgets: { month: { cap: 100, spend: 21 } },
      notice: 'Rolling spend is unavailable for this key.',
    },
  });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(root.querySelectorAll('.llu-row')).toHaveLength(1);
  expect(root.textContent).toContain('Rolling spend is unavailable for this key.');
  expect(heights.at(-1)).toBe(56);
});

test('renders the no-provider hint without a rejected list', async () => {
  const { host, heights } = hostStub({ providers: { providers: [], default: null } });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(root.textContent).toContain('No LiteLLM provider found');
  expect(root.textContent).toContain('Add a LiteLLM provider');
  expect(root.textContent).not.toContain('rejected');
  expect(heights.at(-1)).toBe(56);
});

test('renders a service error with a retry', async () => {
  const root = document.createElement('div');
  const host = {
    onReady: (listener: (context: HostReadyContext) => void) => {
      listener(readyContext());
      return () => {};
    },
    onDirectory: () => () => {},
    onStatusControl: () => () => {},
    setStatusControls: async () => {},
    serviceRequest: async () => ({
      status: 502,
      body: JSON.stringify({ error: { code: 'unauthorized', message: 'The LiteLLM key was rejected.' } }),
    }),
    setHeight: async () => {},
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
    },
  } as unknown as GuestHost;

  start(host, root);
  await settle();

  expect(root.querySelector('.llu-error')?.textContent).toBe('The LiteLLM key was rejected.');
  expect(root.querySelector('.llu-retry')).not.toBeNull();
});

test('publishes a provider select when more than one target is confirmed', async () => {
  const { host, controls } = hostStub({ providers: twoProviders, usage, features: { statusControls: true } });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  const last = controls.at(-1);
  expect(last).toHaveLength(1);
  expect(last?.[0]).toMatchObject({
    kind: 'select',
    id: 'litellm-provider',
    label: 'Provider',
    value: 'litellm',
  });
  expect(last?.[0]?.kind === 'select' ? last[0].options.map((option) => option.value) : []).toEqual([
    'litellm',
    'claude-proxy',
  ]);
});

test('choosing a provider stores it, republishes and refetches', async () => {
  const { host, controls, stored, requests, emitStatusControl } = hostStub({
    providers: twoProviders,
    usage,
    features: { statusControls: true },
  });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  emitStatusControl({ id: 'litellm-provider', value: 'claude-proxy' });
  await settle();

  expect(stored).toEqual([['litellm-usage:provider', 'claude-proxy']]);
  expect(controls.at(-1)?.[0]).toMatchObject({ value: 'claude-proxy' });
  expect(requests.at(-1)).toBe('/usage?provider=claude-proxy&directory=%2Fproj');
});

test('uses a stored provider on first load', async () => {
  const { host, requests } = hostStub({
    providers: twoProviders,
    usage,
    stored: { 'litellm-usage:provider': 'claude-proxy' },
    features: { statusControls: true },
  });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(requests.at(-1)).toBe('/usage?provider=claude-proxy&directory=%2Fproj');
});

test('falls back to the default when the stored provider is gone', async () => {
  const { host, requests } = hostStub({
    providers: twoProviders,
    usage,
    stored: { 'litellm-usage:provider': 'removed' },
    features: { statusControls: true },
  });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(requests.at(-1)).toBe('/usage?provider=litellm&directory=%2Fproj');
});

test('hides the picker when the host does not advertise status controls', async () => {
  const { host, controls, requests } = hostStub({ providers: twoProviders, usage });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(controls).toEqual([]);
  expect(requests.at(-1)).toBe('/usage?provider=litellm&directory=%2Fproj');
});

test('clears the picker when only one target is confirmed', async () => {
  const { host, controls } = hostStub({ providers, usage, features: { statusControls: true } });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(controls.at(-1)).toEqual([]);
});

test('a host that rejects controls still loads the default', async () => {
  const { host, requests } = hostStub({
    providers: twoProviders,
    usage,
    features: { statusControls: true },
    controlsError: true,
  });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(requests.at(-1)).toBe('/usage?provider=litellm&directory=%2Fproj');
  expect(root.querySelector('.llu-error')).toBeNull();
});
