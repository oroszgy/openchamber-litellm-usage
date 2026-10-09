import { expect, test } from 'bun:test';
import type { HostReadyContext } from '@openchamber/sdk';
import { start, type GuestHost } from '../status/app';

const readyContext = {
  directory: '/proj',
  theme: { mode: 'dark', tokens: new Proxy({}, { get: () => '' }) },
  surface: 'status',
} as unknown as HostReadyContext;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function hostStub(answers: {
  providers: unknown;
  usage?: unknown;
}): { host: GuestHost; heights: number[]; requests: string[] } {
  const heights: number[] = [];
  const requests: string[] = [];
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
  } as unknown as GuestHost;
  return { host, heights, requests };
}

test('renders the provider, spend and rolling rows from the service', async () => {
  const { host, heights, requests } = hostStub({
    providers: { providers: [{ id: 'litellm', name: 'LiteLLM', host: 'https://x' }], default: 'litellm' },
    usage: {
      provider: { id: 'litellm', name: 'LiteLLM', host: 'https://x' },
      asOf: '2026-10-09T12:00:00.000Z',
      spend: 1536.61,
      rolling: { day: 1.2, week: 8.4, month: 21 },
    },
  });
  const root = document.createElement('div');

  start(host, root);
  await settle();

  expect(root.querySelector('.llu-provider')?.textContent).toBe('LiteLLM');
  expect(root.querySelector('.llu-headline')?.textContent).toBe('$1,536.61 spent');
  const rows = [...root.querySelectorAll('.llu-row')].map((row) => row.textContent);
  expect(rows).toEqual(['Today$1.20', 'Last 7 days$8.40', 'Last 30 days$21.00']);
  expect(requests[0]).toBe('/providers?directory=%2Fproj');
  expect(heights.length).toBeGreaterThan(0);
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
  } as unknown as GuestHost;

  start(host, root);
  await settle();

  expect(root.querySelector('.llu-error')?.textContent).toBe('The LiteLLM key was rejected.');
  expect(root.querySelector('.llu-retry')).not.toBeNull();
});
