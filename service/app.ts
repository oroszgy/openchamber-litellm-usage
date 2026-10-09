/**
 * The service's routes, behind a `createService(deps)` seam so tests can drive
 * real HTTP against a fake LiteLLM with an injected filesystem and clock.
 *
 * `service/main.ts` is the thin bootstrap that binds loopback.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { defaultProviderId, discoverProviders, type ConfigEnv, type Provider } from './config.ts';
import {
  bucketRolling,
  localDate,
  readDailyActivity,
  readKeyInfo,
  shiftDate,
  type KeyInfoFailure,
} from './litellm.ts';

export type ServiceDeps = {
  token: string;
  fetch: typeof fetch;
  readText: (path: string) => Promise<string | null>;
  now: () => Date;
  env: ConfigEnv & { timeZone?: string | undefined };
};

type Answer = { status: number; body: unknown };

const error = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
});

const MESSAGES: Record<KeyInfoFailure, string> = {
  unauthorized: 'The LiteLLM key was rejected.',
  unsupported_proxy: 'The proxy did not return a readable key.',
  provider_unreachable: 'The LiteLLM proxy could not be reached.',
  upstream_error: 'The LiteLLM proxy returned an unexpected response.',
};

export function createService(deps: ServiceDeps): RequestListener {
  return (request, response) => {
    void handle(deps, request)
      .then((answer) => send(response, answer))
      .catch((cause: unknown) => send(response, error(500, 'upstream_error', String(cause))));
  };
}

async function handle(deps: ServiceDeps, request: IncomingMessage): Promise<Answer> {
  if (request.headers.authorization !== `Bearer ${deps.token}`) {
    return error(401, 'unauthorized', 'Missing or invalid bearer token.');
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method !== 'GET') return error(404, 'not_found', 'Not found.');

  if (url.pathname === '/health') return { status: 200, body: { ok: true } };
  if (url.pathname === '/providers') return listProviders(deps, url.searchParams.get('directory'));
  if (url.pathname === '/usage') return usage(deps, url);
  return error(404, 'not_found', 'Not found.');
}

async function listProviders(deps: ServiceDeps, directory: string | null): Promise<Answer> {
  const providers = await discoverProviders(directory, deps);
  return {
    status: 200,
    body: {
      providers: providers.map(({ id, name, host }) => ({ id, name, host })),
      default: defaultProviderId(providers.map((provider) => provider.id)),
    },
  };
}

async function usage(deps: ServiceDeps, url: URL): Promise<Answer> {
  const directory = url.searchParams.get('directory');
  const providers = await discoverProviders(directory, deps);
  const requested = url.searchParams.get('provider') ?? defaultProviderId(providers.map((p) => p.id));
  const provider = providers.find((candidate) => candidate.id === requested);
  if (!provider) return error(404, 'no_provider', `No LiteLLM provider matching '${requested ?? ''}'.`);

  const info = await readKeyInfo(deps.fetch, provider.host, provider.key);
  if (!info.ok) return error(502, info.code, MESSAGES[info.code]);

  const now = deps.now();
  const timeZone = deps.env.timeZone ?? 'UTC';
  const today = localDate(now, timeZone);

  const body: Record<string, unknown> = {
    provider: publicProvider(provider),
    asOf: now.toISOString(),
    spend: info.spend,
  };

  if (info.userId) {
    const buckets = await readDailyActivity(
      deps.fetch,
      provider.host,
      provider.key,
      shiftDate(today, -29),
      today,
      now.getTimezoneOffset(),
    );
    if (buckets) {
      body.rolling = bucketRolling(buckets, today);
    } else {
      body.degraded = [
        {
          figure: 'rolling',
          code: 'rolling_unavailable',
          message: 'Daily activity is unavailable for this key.',
        },
      ];
    }
  }

  return { status: 200, body };
}

function publicProvider(provider: Provider): { id: string; name: string; host: string } {
  return { id: provider.id, name: provider.name, host: provider.host };
}

function send(response: ServerResponse, answer: Answer): void {
  response.writeHead(answer.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(answer.body));
}
