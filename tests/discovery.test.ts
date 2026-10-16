import { expect, test } from 'bun:test';
import { createDiscovery, PROBE_CACHE_MS } from '../service/discovery';
import type { ConfigEnv } from '../service/config';

const env: ConfigEnv = {
  home: '/home/test',
  xdgConfigHome: '/home/test/.config',
  xdgDataHome: '/home/test/.local/share',
  vars: {},
};

type Reply = { status?: number; body?: unknown };
/** A fetch stub keyed by the exact URL it is called with; a missing entry throws. */
function stubFetch(replies: Record<string, Reply>): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const reply = replies[url];
    if (!reply) throw new Error(`no stub for ${url}`);
    const status = reply.status ?? 200;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function config(entries: Record<string, unknown>): Record<string, string> {
  return { '/proj/opencode.json': JSON.stringify({ provider: entries }) };
}

function discoveryFor(files: Record<string, string>, impl: typeof fetch, now = () => 0) {
  return createDiscovery({ readText: async (path) => files[path] ?? null, env, fetch: impl, now });
}

test('a candidate whose probe answers with the LiteLLM shape is confirmed', async () => {
  const files = config({ litellm: { options: { baseURL: 'https://h/v1', apiKey: 'sk-test' } } });
  const { impl } = stubFetch({ 'https://h/key/info': { body: { info: { spend: 5, user_id: 'u1' } } } });

  const { confirmed, unconfirmed } = await discoveryFor(files, impl)('/proj');

  expect(unconfirmed).toEqual([]);
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]).toMatchObject({ id: 'litellm', name: 'litellm', host: 'https://h', key: 'sk-test' });
  expect(confirmed[0]?.info).toMatchObject({ ok: true, spend: 5, userId: 'u1' });
});

test('a typo in the name does not matter: the probe confirms it', async () => {
  const files = config({ litelm: { name: 'Litelm Proxy', options: { baseURL: 'https://h/v1', apiKey: 'sk-test' } } });
  const { impl } = stubFetch({ 'https://h/key/info': { body: { info: { spend: 1 } } } });

  const { confirmed } = await discoveryFor(files, impl)('/proj');

  expect(confirmed.map((target) => target.id)).toEqual(['litelm']);
});

test('each probe failure is reported with its code', async () => {
  const files = config({
    unauth: { options: { baseURL: 'https://a/v1', apiKey: 'k' } },
    missing: { options: { baseURL: 'https://b/v1', apiKey: 'k' } },
    unshaped: { options: { baseURL: 'https://c/v1', apiKey: 'k' } },
    broke: { options: { baseURL: 'https://d/v1', apiKey: 'k' } },
    down: { options: { baseURL: 'https://e/v1', apiKey: 'k' } },
    keyless: { options: { baseURL: 'https://f/v1' } },
  });
  const { impl } = stubFetch({
    'https://a/key/info': { status: 401 },
    'https://b/key/info': { status: 404 },
    'https://c/key/info': { body: {} },
    'https://d/key/info': { status: 500 },
    // https://e is not stubbed: the stub throws, standing in for unreachable.
  });

  const { confirmed, unconfirmed } = await discoveryFor(files, impl)('/proj');

  expect(confirmed).toEqual([]);
  expect(Object.fromEntries(unconfirmed.map((entry) => [entry.id, entry.code]))).toEqual({
    unauth: 'unauthorized',
    missing: 'unsupported_proxy',
    unshaped: 'unsupported_proxy',
    broke: 'upstream_error',
    down: 'provider_unreachable',
    keyless: 'no_key',
  });
});

test('a keyless candidate is never probed', async () => {
  const files = config({ keyless: { options: { baseURL: 'https://f/v1' } } });
  const { impl, calls } = stubFetch({});

  const { unconfirmed } = await discoveryFor(files, impl)('/proj');

  expect(calls).toEqual([]);
  expect(unconfirmed[0]?.code).toBe('no_key');
});

test('a probe outcome is cached until the window elapses', async () => {
  const files = config({ litellm: { options: { baseURL: 'https://h/v1', apiKey: 'sk-test' } } });
  const { impl, calls } = stubFetch({ 'https://h/key/info': { body: { info: { spend: 5 } } } });

  let now = 1000;
  const discover = discoveryFor(files, impl, () => now);

  await discover('/proj');
  now += PROBE_CACHE_MS - 1;
  await discover('/proj');
  expect(calls).toHaveLength(1);

  now += 2;
  await discover('/proj');
  expect(calls).toHaveLength(2);
});

test('a failed probe is cached too, so a dead proxy is not re-probed each time', async () => {
  const files = config({ litellm: { options: { baseURL: 'https://h/v1', apiKey: 'sk-test' } } });
  const { impl, calls } = stubFetch({ 'https://h/key/info': { status: 401 } });

  const discover = discoveryFor(files, impl, () => 0);
  await discover('/proj');
  await discover('/proj');

  expect(calls).toHaveLength(1);
});
