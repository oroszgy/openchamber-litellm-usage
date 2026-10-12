import { expect, test } from 'bun:test';
import type { HostReadyContext } from '@openchamber/sdk';
import { start, type GuestHost } from '../status/app';

const readyContext = {
  directory: '/proj',
  theme: { mode: 'dark', tokens: new Proxy({}, { get: () => '' }) },
  surface: 'status',
} as unknown as HostReadyContext;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const providers = {
  providers: [{ id: 'litellm', name: 'LiteLLM', host: 'https://x' }],
  default: 'litellm',
};

const usage = {
  provider: { id: 'litellm', name: 'LiteLLM', host: 'https://x' },
  asOf: '2026-10-09T12:00:00.000Z',
  spend: 1536.61,
  spendKind: 'lifetime',
  rolling: { day: 1.2, week: 8.4, month: 21 },
};

type HostStub = {
  host: GuestHost;
  heights: number[];
  requests: string[];
  stored: Array<[string, unknown]>;
  /** Push `ready`, the way the host does on a session or theme change. */
  emitReady: (context?: HostReadyContext) => void;
  /** Push a `directory` change. */
  emitDirectory: (directory: string | null) => void;
};

function hostStub(answers: {
  providers: unknown;
  usage?: unknown;
  stored?: unknown;
  /** Status for `/usage`; non-200 stands in for a failing proxy. */
  usageStatus?: () => number;
}): HostStub {
  const heights: number[] = [];
  const requests: string[] = [];
  const stored: Array<[string, unknown]> = [];
  const readyListeners = new Set<(context: HostReadyContext) => void>();
  const directoryListeners = new Set<(directory: string | null) => void>();
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
      get: async () => answers.stored,
      set: async (key: string, value: unknown) => {
        stored.push([key, value]);
      },
      delete: async () => {},
      keys: async () => [],
    },
  } as unknown as GuestHost;

  // One `ready` replays to `onReady` *and* `onDirectory`, as the SDK does.
  const emitReady = (context: HostReadyContext = readyContext): void => {
    lastReady = context;
    for (const listener of readyListeners) listener(context);
    for (const listener of directoryListeners) listener(context.directory);
  };
  const emitDirectory = (directory: string | null): void => {
    if (lastReady) lastReady = { ...lastReady, directory };
    for (const listener of directoryListeners) listener(directory);
  };

  // Push the first ready once `start` has registered both listeners.
  queueMicrotask(() => emitReady());

  return { host, heights, requests, stored, emitReady, emitDirectory };
}

test('shows rolling spend at all times and hides the spend figure by default', async () => {
  const { host, heights, requests } = hostStub({ providers, usage });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  const rows = [...root.querySelectorAll('.llu-row')].map((row) => row.textContent);
  expect(rows).toEqual(['Today$1.20', 'Last 7 days$8.40', 'Last 30 days$21.00']);
  expect(root.querySelector('.llu-toggle')?.textContent).toBe('Show spend');
  expect(requests[0]).toBe('/providers?directory=%2Fproj');
  expect(heights.length).toBeGreaterThan(0);
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

test('reveals the spend figure when toggled and remembers it', async () => {
  const { host, stored } = hostStub({ providers, usage });
  const root = document.createElement('div');

  start(host, root);
  await settle();
  expect(root.textContent).not.toContain('Lifetime spend');

  (root.querySelector('.llu-toggle') as HTMLButtonElement).click();
  await settle();

  const rows = [...root.querySelectorAll('.llu-row')].map((row) => row.textContent);
  expect(rows.at(-1)).toBe('Lifetime spend$1,536.61');
  expect(root.querySelector('.llu-toggle')?.textContent).toBe('Hide spend');
  expect(stored).toEqual([['litellm-usage:show-spend', true]]);
});

test('a windowed key labels the revealed figure Spend', async () => {
  const { host } = hostStub({
    providers,
    usage: { ...usage, spend: 12.5, spendKind: 'window' },
    stored: true,
  });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  const rows = [...root.querySelectorAll('.llu-row')].map((row) => row.textContent);
  expect(rows.at(-1)).toBe('Spend$12.50');
});

test('honours a stored preference to show the spend figure', async () => {
  const { host } = hostStub({ providers, usage, stored: true });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  const rows = [...root.querySelectorAll('.llu-row')].map((row) => row.textContent);
  expect(rows.at(-1)).toBe('Lifetime spend$1,536.61');
  expect(root.querySelector('.llu-toggle')?.textContent).toBe('Hide spend');
});

test('shows the degraded note when rolling spend is unavailable', async () => {
  const { host } = hostStub({
    providers,
    usage: {
      provider: { id: 'litellm', name: 'LiteLLM', host: 'https://x' },
      asOf: '2026-10-09T12:00:00.000Z',
      spend: 5,
      spendKind: 'lifetime',
      degraded: [
        { figure: 'rolling', code: 'rolling_unavailable', message: 'Rolling spend is unavailable for this key.' },
      ],
    },
  });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(root.querySelectorAll('.llu-row').length).toBe(0);
  expect(root.textContent).toContain('Rolling spend is unavailable for this key.');
  expect(root.querySelector('.llu-toggle')).not.toBeNull();
});

test('renders the no-provider hint', async () => {
  const { host } = hostStub({ providers: { providers: [], default: null } });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(root.textContent).toContain('No LiteLLM provider found');
});

test('renders a service error with a retry', async () => {
  const root = document.createElement('div');
  const host = {
    onReady: (listener: (context: HostReadyContext) => void) => {
      listener(readyContext);
      return () => {};
    },
    onDirectory: () => () => {},
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
