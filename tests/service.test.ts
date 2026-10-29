import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createService, type ServiceDeps } from '../service/app';

const TOKEN = 'test-token';
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

const cleaners: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleaners.length > 0) await cleaners.pop()!();
});

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

type Fake = {
  url: string;
  calls: string[];
  auth: Array<string | undefined>;
  setInfo: (info: Record<string, unknown>) => void;
  setActivity: (activity: Record<string, unknown>) => void;
  setActivityStatus: (status: number) => void;
  setActivityPage: (page: (page: number) => Record<string, unknown>) => void;
};

async function fakeLitellm(seed?: {
  info?: Record<string, unknown>;
  activity?: Record<string, unknown>;
  activityStatus?: number;
}): Promise<Fake> {
  const calls: string[] = [];
  const auth: Array<string | undefined> = [];
  let info = seed?.info ?? { spend: 1536.61, user_id: 'u1' };
  let activity = seed?.activity ?? { results: [] };
  let activityStatus = seed?.activityStatus ?? 200;
  let activityPage: ((page: number) => Record<string, unknown>) | null = null;

  const server = createServer((req, res) => {
    calls.push(req.url ?? '');
    auth.push(req.headers.authorization);
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/key/info') return send({ key: 'sk-test', info });
    if (url.pathname === '/user/daily/activity') {
      if (activityPage) return send(activityPage(Number(url.searchParams.get('page') ?? '1')), activityStatus);
      return send(activity, activityStatus);
    }
    return send({ error: 'not found' }, 404);
  });
  const url = await listen(server);
  cleaners.push(() => new Promise((resolve) => server.close(() => resolve())));
  return {
    url,
    calls,
    auth,
    setInfo: (next) => {
      info = next;
    },
    setActivity: (next) => {
      activity = next;
    },
    setActivityStatus: (next) => {
      activityStatus = next;
    },
    setActivityPage: (next) => {
      activityPage = next;
    },
  };
}

type Harness = { url: string; reads: string[]; fake: Fake };

async function service(
  fake: Fake,
  files: Record<string, string>,
  env: Partial<ServiceDeps['env']> = {},
): Promise<Harness> {
  const reads: string[] = [];
  const deps: ServiceDeps = {
    token: TOKEN,
    fetch,
    now: () => new Date('2026-10-09T12:00:00.000Z'),
    env: {
      home: '/home/test',
      xdgConfigHome: '/home/test/.config',
      xdgDataHome: '/home/test/.local/share',
      vars: {},
      timeZone: 'UTC',
      ...env,
    },
    readText: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
  };
  const server = createServer(createService(deps));
  const url = await listen(server);
  cleaners.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url, reads, fake };
}

function opencodeConfig(baseURL: string, id = 'litellm', name = 'LiteLLM'): string {
  return JSON.stringify({
    provider: { [id]: { name, options: { baseURL: `${baseURL}/v1`, apiKey: 'sk-test' } } },
  });
}

type Usage = {
  rolling?: { day: number; week: number; month: number };
  budgets?: Record<string, { cap: number; spend: number }>;
  notice?: string;
};

test('health is pure liveness and requires the bearer', async () => {
  const fake = await fakeLitellm();
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const unauth = await fetch(`${h.url}/health`);
  expect(unauth.status).toBe(401);

  const ok = await fetch(`${h.url}/health`, { headers: auth() });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });

  expect(fake.calls).toHaveLength(0);
  expect(h.reads).toHaveLength(0);
});

test('providers lists confirmed targets without the host or key', async () => {
  const fake = await fakeLitellm();
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/providers?directory=/proj`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { providers: unknown[]; default: string; rejected?: unknown };

  expect(body.default).toBe('litellm');
  expect(body.providers).toEqual([{ id: 'litellm', name: 'LiteLLM' }]);
  expect(body.rejected).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('sk-test');
  expect(JSON.stringify(body)).not.toContain(fake.url);
  expect(fake.calls.filter((call) => call === '/key/info')).toHaveLength(1);
});

test('usage buckets the rolling windows and keeps the activity query', async () => {
  const fake = await fakeLitellm({
    info: { spend: 1536.61, user_id: 'u1' },
    activity: {
      results: [
        { date: '2026-10-09', metrics: { spend: 1.2 } },
        { date: '2026-10-08', metrics: { spend: 1.0 } },
        { date: '2026-10-05', metrics: { spend: 0.5 } },
        { date: '2026-09-20', metrics: { spend: 3.0 } },
        { date: '2026-08-01', metrics: { spend: 9.0 } },
      ],
    },
  });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Usage;

  expect(body.rolling?.day).toBeCloseTo(1.2);
  expect(body.rolling?.week).toBeCloseTo(2.7);
  expect(body.rolling?.month).toBeCloseTo(5.7);
  expect(body.budgets).toBeUndefined();
  expect(body.notice).toBeUndefined();

  const hash = createHash('sha256').update('sk-test').digest('hex');
  const activityIndex = fake.calls.findIndex((call) => call.startsWith('/user/daily/activity'));
  const activity = fake.calls[activityIndex]!;
  expect(activity).toContain(`api_key=${hash}`);
  expect(activity).toContain('start_date=');
  expect(activity).toContain('end_date=2026-10-09');
  expect(activity).toContain('include_current_utc_day=true');
  expect(activity).toContain('timezone=0');
  expect(activity).toContain('page=1');
  expect(fake.auth[activityIndex]).toBe('Bearer sk-test');
});

test('activity pages are read to the end and the boundary date is counted once', async () => {
  const fake = await fakeLitellm({
    info: { spend: 0, user_id: 'u1' },
    activity: { results: [], metadata: { has_more: false } },
  });
  const pages: Record<number, Record<string, unknown>> = {
    1: {
      results: [
        { date: '2026-10-09', metrics: { spend: 1.2 } },
        { date: '2026-10-08', metrics: { spend: 1.0 } },
      ],
      metadata: { has_more: true },
    },
    2: {
      results: [
        { date: '2026-10-08', metrics: { spend: 1.0 } },
        { date: '2026-09-20', metrics: { spend: 3.0 } },
      ],
      metadata: { has_more: false },
    },
  };
  fake.setActivityPage((page) => pages[page] ?? { results: [], metadata: { has_more: false } });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  const body = (await res.json()) as Usage;

  expect(body.rolling?.day).toBeCloseTo(1.2);
  expect(body.rolling?.week).toBeCloseTo(2.2);
  expect(body.rolling?.month).toBeCloseTo(5.2);
  expect(fake.calls.filter((call) => call.startsWith('/user/daily/activity'))).toHaveLength(2);
});

test('a legacy max_budget + budget_duration maps to its period', async () => {
  const fake = await fakeLitellm({
    info: { spend: 8.4, user_id: 'u1', max_budget: 10, budget_duration: '24h' },
  });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  const body = (await res.json()) as Usage;
  expect(body.budgets).toEqual({ day: { cap: 10, spend: 8.4 } });
});

test('budget_limits pairs each window with its usage', async () => {
  const fake = await fakeLitellm({
    info: {
      spend: 0,
      user_id: 'u1',
      budget_limits: [
        { budget_duration: '24h', max_budget: 10 },
        { budget_duration: '30d', max_budget: 100 },
        { budget_duration: '5h', max_budget: 2 },
      ],
      budget_limits_usage: {
        '24h': { current_spend: 8.4 },
        '30d': { current_spend: 21 },
        '5h': { current_spend: 1 },
      },
    },
  });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  const body = (await res.json()) as Usage;
  expect(body.budgets).toEqual({
    day: { cap: 10, spend: 8.4 },
    month: { cap: 100, spend: 21 },
  });
});

test('the tighter window wins when two forms cover the same period', async () => {
  const fake = await fakeLitellm({
    info: {
      spend: 8.4,
      user_id: 'u1',
      max_budget: 10,
      budget_duration: '24h',
      budget_limits: [{ budget_duration: '24h', max_budget: 20 }],
      budget_limits_usage: { '24h': { current_spend: 10 } },
    },
  });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  const body = (await res.json()) as Usage;
  expect(body.budgets).toEqual({ day: { cap: 10, spend: 8.4 } });
});

test('a max_budget without a duration is a total window', async () => {
  const fake = await fakeLitellm({ info: { spend: 42, user_id: 'u1', max_budget: 100 } });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  const body = (await res.json()) as Usage;
  expect(body.budgets).toEqual({ total: { cap: 100, spend: 42 } });
});

test('a multi-window without reported usage is not shown', async () => {
  const fake = await fakeLitellm({
    info: {
      spend: 0,
      user_id: 'u1',
      budget_limits: [{ budget_duration: '30d', max_budget: 100 }],
    },
  });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  const body = (await res.json()) as Usage;
  expect(body.budgets).toBeUndefined();
});

test('a key with no readable spend is not confirmed; /providers is empty', async () => {
  const fake = await fakeLitellm({ info: {} });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const providers = await fetch(`${h.url}/providers?directory=/proj`, { headers: auth() });
  expect(providers.status).toBe(200);
  const listed = (await providers.json()) as {
    providers: unknown[];
    default: string | null;
    rejected?: unknown;
  };
  expect(listed.providers).toEqual([]);
  expect(listed.default).toBeNull();
  expect(listed.rejected).toBeUndefined();

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('no_provider');
});

test('unknown provider is a fatal no_provider', async () => {
  const fake = await fakeLitellm();
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=nope&directory=/proj`, { headers: auth() });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('no_provider');
});

test('a failed activity call degrades rolling without failing the read', async () => {
  const fake = await fakeLitellm({ info: { spend: 5, user_id: 'u1' } });
  fake.setActivityStatus(403);
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Usage;
  expect(body.rolling).toBeUndefined();
  expect(body.notice).toBe('Rolling spend is unavailable for this key.');
});

test('a key without a user_id degrades rolling without calling activity', async () => {
  const fake = await fakeLitellm({ info: { spend: 5 } });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Usage;
  expect(body.rolling).toBeUndefined();
  expect(body.notice).toBe('Rolling spend is unavailable for this key.');
  expect(fake.calls.some((call) => call.startsWith('/user/daily/activity'))).toBe(false);
});

test('an unreadable config is a fatal config_read_error, not "no provider"', async () => {
  const fake = await fakeLitellm();
  const h = await service(fake, { '/proj/opencode.json': '{ this is not json' });

  const providers = await fetch(`${h.url}/providers?directory=/proj`, { headers: auth() });
  expect(providers.status).toBe(500);
  expect(((await providers.json()) as { error: { code: string } }).error.code).toBe('config_read_error');

  const usage = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  expect(usage.status).toBe(500);
  expect(((await usage.json()) as { error: { code: string } }).error.code).toBe('config_read_error');
});

test('no config at all is an empty provider list, and /usage says no_provider', async () => {
  const fake = await fakeLitellm();
  const h = await service(fake, {});

  const providers = await fetch(`${h.url}/providers?directory=/proj`, { headers: auth() });
  expect(providers.status).toBe(200);
  expect(await providers.json()).toEqual({ providers: [], default: null });

  const usage = await fetch(`${h.url}/usage?directory=/proj`, { headers: auth() });
  expect(usage.status).toBe(404);
  expect(((await usage.json()) as { error: { code: string } }).error.code).toBe('no_provider');
});

test("a typo'd provider name is still found, because the probe recognizes it", async () => {
  const fake = await fakeLitellm();
  const h = await service(fake, {
    '/proj/opencode.json': JSON.stringify({
      provider: { litelm: { name: 'Litelm', options: { baseURL: `${fake.url}/v1`, apiKey: 'sk-test' } } },
    }),
  });

  const res = await fetch(`${h.url}/providers?directory=/proj`, { headers: auth() });
  const body = (await res.json()) as { providers: unknown[]; default: string };
  expect(body.default).toBe('litelm');
  expect(body.providers).toEqual([{ id: 'litelm', name: 'Litelm' }]);
});

test('a candidate the probe rejects stays out of the list, without leaking its key or host', async () => {
  const fake = await fakeLitellm();
  const h = await service(fake, {
    '/proj/opencode.json': JSON.stringify({
      provider: {
        litellm: { name: 'LiteLLM', options: { baseURL: `${fake.url}/v1`, apiKey: 'sk-test' } },
        other: { name: 'Other proxy', options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'sk-other' } },
      },
    }),
  });

  const res = await fetch(`${h.url}/providers?directory=/proj`, { headers: auth() });
  const body = (await res.json()) as { providers: Array<{ id: string }>; rejected?: unknown };
  expect(body.providers.map((provider) => provider.id)).toEqual(['litellm']);
  expect(body.rejected).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('sk-other');
  expect(JSON.stringify(body)).not.toContain('127.0.0.1:1');
});

test('a provider added to .opencode/opencode.json is found', async () => {
  const fake = await fakeLitellm();
  const h = await service(fake, { '/proj/.opencode/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/providers?directory=/proj`, { headers: auth() });
  const body = (await res.json()) as { providers: unknown[]; default: string };
  expect(body.default).toBe('litellm');
});

test('a provider in the custom OPENCODE_CONFIG file is found', async () => {
  const fake = await fakeLitellm();
  const h = await service(
    fake,
    { '/custom/cfg.json': opencodeConfig(fake.url) },
    { vars: { OPENCODE_CONFIG: '/custom/cfg.json' } },
  );

  const res = await fetch(`${h.url}/providers?directory=/proj`, { headers: auth() });
  const body = (await res.json()) as { providers: unknown[]; default: string };
  expect(body.default).toBe('litellm');
});
