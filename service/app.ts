/**
 * The service's routes, behind a `createService(deps)` seam so tests can drive
 * real HTTP against a fake LiteLLM with an injected filesystem and clock.
 *
 * `service/main.ts` is the thin bootstrap that binds loopback.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { ConfigReadError, defaultProviderId, type ConfigEnv } from './config.ts';
import { createDiscovery, type Discovery, type Target } from './discovery.ts';
import { bucketRolling, localDate, offsetMinutes, shiftDate } from './dates.ts';
import { readDailyActivity } from './litellm.ts';
import type { ProviderRef, ProvidersResponse, UsageResponse } from '../shared/wire.ts';

export type ServiceDeps = {
  token: string;
  fetch: typeof fetch;
  readText: (path: string) => Promise<string | null>;
  now: () => Date;
  env: ConfigEnv & { timeZone?: string | undefined };
};

type Answer = { status: number; body: unknown };
type Discover = (directory: string | null) => Promise<Discovery>;

const ROLLING_UNAVAILABLE = 'Rolling spend is unavailable for this key.';

const error = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
});

export function createService(deps: ServiceDeps): RequestListener {
  const discover = createDiscovery({
    readText: deps.readText,
    env: deps.env,
    fetch: deps.fetch,
    now: () => deps.now().getTime(),
  });
  return (request, response) => {
    void handle(deps, discover, request)
      .then((answer) => send(response, answer))
      .catch((cause: unknown) => {
        // Log locally; never hand the guest an internal message.
        console.error('[litellm-usage] unhandled service error:', cause);
        send(response, error(502, 'upstream_error', 'The service could not complete the request.'));
      });
  };
}

async function handle(deps: ServiceDeps, discover: Discover, request: IncomingMessage): Promise<Answer> {
  if (request.headers.authorization !== `Bearer ${deps.token}`) {
    return error(401, 'unauthorized', 'Missing or invalid bearer token.');
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method !== 'GET') return error(404, 'not_found', 'Not found.');

  try {
    if (url.pathname === '/health') return { status: 200, body: { ok: true } };
    if (url.pathname === '/providers') return await listProviders(discover, url.searchParams.get('directory'));
    if (url.pathname === '/usage') return await usage(deps, discover, url);
  } catch (cause) {
    if (cause instanceof ConfigReadError) {
      return error(500, 'config_read_error', 'The OpenCode configuration could not be read.');
    }
    throw cause;
  }
  return error(404, 'not_found', 'Not found.');
}

async function listProviders(discover: Discover, directory: string | null): Promise<Answer> {
  const { confirmed } = await discover(directory);
  const body: ProvidersResponse = {
    providers: confirmed.map(publicTarget),
    default: defaultProviderId(confirmed.map((target) => target.id)),
  };
  return { status: 200, body };
}

async function usage(deps: ServiceDeps, discover: Discover, url: URL): Promise<Answer> {
  const directory = url.searchParams.get('directory');
  const { confirmed } = await discover(directory);
  const requested = url.searchParams.get('provider') ?? defaultProviderId(confirmed.map((target) => target.id));
  const target = confirmed.find((candidate) => candidate.id === requested);
  if (!target) return error(404, 'no_provider', `No LiteLLM provider matching '${requested ?? ''}'.`);

  const now = deps.now();
  const timeZone = deps.env.timeZone ?? 'UTC';
  const today = localDate(now, timeZone);

  const body: UsageResponse = {};
  if (target.info.budgets) body.budgets = target.info.budgets;

  if (!target.info.userId) {
    body.notice = ROLLING_UNAVAILABLE;
  } else {
    const buckets = await readDailyActivity(
      deps.fetch,
      target,
      shiftDate(today, -29),
      today,
      offsetMinutes(now, timeZone),
    );
    if (buckets) {
      body.rolling = bucketRolling(buckets, today);
    } else {
      body.notice = ROLLING_UNAVAILABLE;
    }
  }

  return { status: 200, body };
}

function publicTarget(target: Target): ProviderRef {
  return { id: target.id, name: target.name };
}

function send(response: ServerResponse, answer: Answer): void {
  response.writeHead(answer.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(answer.body));
}
