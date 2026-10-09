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
};

async function fakeLitellm(seed?: {
  info?: Record<string, unknown>;
  activity?: Record<string, unknown>;
  activityStatus?: number;
}): Promise<Fake> {
  const calls: string[] = [];
  const auth: Array<string | undefined> = [];
  let info = seed?.info ?? { spend: 1536.61, user_id: 'u1', team_id: 't1' };
  let activity = seed?.activity ?? { results: [] };
  let activityStatus = seed?.activityStatus ?? 200;

  const server = createServer((req, res) => {
    calls.push(req.url ?? '');
    auth.push(req.headers.authorization);
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/key/info') return send({ key: 'sk-test', info });
    if (url.pathname === '/user/daily/activity') return send(activity, activityStatus);
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
  };
}

type Harness = { url: string; reads: string[]; fake: Fake };

async function service(fake: Fake, files: Record<string, string>): Promise<Harness> {
  const reads: string[] = [];
  const deps: ServiceDeps = {
    token: TOKEN,
    fetch,
    now: () => new Date('2026-10-09T12:00:00.000Z'),
    env: {
      home: '/home/test',
      xdgConfigHome: '/home/test/.config',
      xdgDataHome: '/home/test/.local/share',
      timeZone: 'UTC',
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

test('providers lists candidates by management root and never leaks the key', async () => {
  const fake = await fakeLitellm();
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/providers?directory=/proj`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { providers: unknown[]; default: string };

  expect(body.default).toBe('litellm');
  expect(body.providers).toEqual([{ id: 'litellm', name: 'LiteLLM', host: fake.url }]);
  expect(JSON.stringify(body)).not.toContain('sk-test');
  expect(fake.calls).toHaveLength(0);
});

test('usage reads spend and buckets rolling windows', async () => {
  const fake = await fakeLitellm({
    info: { spend: 1536.61, user_id: 'u1', team_id: 't1' },
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
  const body = (await res.json()) as {
    provider: unknown;
    asOf: string;
    spend: number;
    rolling: { day: number; week: number; month: number };
  };

  expect(body.provider).toEqual({ id: 'litellm', name: 'LiteLLM', host: fake.url });
  expect(body.asOf).toBe('2026-10-09T12:00:00.000Z');
  expect(body.spend).toBe(1536.61);
  expect(body.rolling.day).toBeCloseTo(1.2);
  expect(body.rolling.week).toBeCloseTo(2.7);
  expect(body.rolling.month).toBeCloseTo(5.7);

  const hash = createHash('sha256').update('sk-test').digest('hex');
  const activityIndex = fake.calls.findIndex((call) => call.startsWith('/user/daily/activity'));
  const activity = fake.calls[activityIndex];
  expect(activity).toContain(`api_key=${hash}`);
  expect(activity).toContain('start_date=');
  expect(activity).toContain('end_date=2026-10-09');
  expect(activity).toContain('include_current_utc_day=true');
  expect(activity).toContain('timezone=0');
  expect(fake.auth[activityIndex]).toBe('Bearer sk-test');
});

test('a key with no readable spend is a fatal unsupported_proxy', async () => {
  const fake = await fakeLitellm({ info: {} });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('unsupported_proxy');
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
  const body = (await res.json()) as {
    spend: number;
    rolling?: unknown;
    degraded?: Array<{ figure: string; code: string }>;
  };
  expect(body.spend).toBe(5);
  expect(body.rolling).toBeUndefined();
  expect(body.degraded?.[0]?.code).toBe('rolling_unavailable');
});

test('a key without a user_id degrades rolling without calling activity', async () => {
  const fake = await fakeLitellm({ info: { spend: 5 } });
  const h = await service(fake, { '/proj/opencode.json': opencodeConfig(fake.url) });

  const res = await fetch(`${h.url}/usage?provider=litellm&directory=/proj`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    rolling?: unknown;
    degraded?: Array<{ code: string }>;
  };
  expect(body.rolling).toBeUndefined();
  expect(body.degraded?.[0]?.code).toBe('rolling_unavailable');
  expect(fake.calls.some((call) => call.startsWith('/user/daily/activity'))).toBe(false);
});
