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

function hostStub(answers: {
  providers: unknown;
  usage?: unknown;
  stored?: unknown;
}): { host: GuestHost; heights: number[]; requests: string[]; stored: Array<[string, unknown]> } {
  const heights: number[] = [];
  const requests: string[] = [];
  const stored: Array<[string, unknown]> = [];
  const host = {
    onReady: (listener: (context: HostReadyContext) => void) => {
      listener(readyContext);
      return () => {};
    },
    onDirectory: () => () => {},
    serviceRequest: async (request: { path: string; query?: Record<string, string> }) => {
      requests.push(`${request.path}?${new URLSearchParams(request.query ?? {}).toString()}`);
      if (request.path === '/providers') return { status: 200, body: JSON.stringify(answers.providers) };
      if (request.path === '/usage') return { status: 200, body: JSON.stringify(answers.usage) };
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
  return { host, heights, requests, stored };
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
