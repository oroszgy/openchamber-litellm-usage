/**
 * The service's routes, behind a `createService(deps)` seam so tests can drive
 * real HTTP against a fake LiteLLM with an injected filesystem and clock.
 *
 * `service/main.ts` is the thin bootstrap that binds loopback.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  ConfigReadError,
  defaultProviderId,
  discoverProviders,
  type ConfigEnv,
  type Provider,
} from './config.ts';
import { bucketRolling, localDate, offsetMinutes, shiftDate } from './dates.ts';
import { readDailyActivity, readKeyInfo, type KeyInfoFailure, type Target } from './litellm.ts';
import type { ProviderRef, ProvidersResponse, UsageResponse } from '../shared/wire.ts';

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
      .catch((cause: unknown) => {
        // Log locally; never hand the guest an internal message.
        console.error('[litellm-usage] unhandled service error:', cause);
        send(response, error(502, 'upstream_error', 'The service could not complete the request.'));
      });
  };
}

async function handle(deps: ServiceDeps, request: IncomingMessage): Promise<Answer> {
  if (request.headers.authorization !== `Bearer ${deps.token}`) {
    return error(401, 'unauthorized', 'Missing or invalid bearer token.');
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method !== 'GET') return error(404, 'not_found', 'Not found.');

  try {
    if (url.pathname === '/health') return { status: 200, body: { ok: true } };
    if (url.pathname === '/providers') return await listProviders(deps, url.searchParams.get('directory'));
    if (url.pathname === '/usage') return await usage(deps, url);
  } catch (cause) {
    if (cause instanceof ConfigReadError) {
      return error(500, 'config_read_error', 'The OpenCode configuration could not be read.');
    }
    throw cause;
  }
  return error(404, 'not_found', 'Not found.');
}

async function listProviders(deps: ServiceDeps, directory: string | null): Promise<Answer> {
  const providers = await discoverProviders(directory, deps);
  const body: ProvidersResponse = {
    providers: providers.map(publicProvider),
    default: defaultProviderId(providers.map((provider) => provider.id)),
  };
  return { status: 200, body };
}

async function usage(deps: ServiceDeps, url: URL): Promise<Answer> {
  const directory = url.searchParams.get('directory');
  const providers = await discoverProviders(directory, deps);
  const requested = url.searchParams.get('provider') ?? defaultProviderId(providers.map((p) => p.id));
  const provider = providers.find((candidate) => candidate.id === requested);
  if (!provider) return error(404, 'no_provider', `No LiteLLM provider matching '${requested ?? ''}'.`);

  const target: Target = { host: provider.host, key: provider.key };
  const info = await readKeyInfo(deps.fetch, target);
  if (!info.ok) return error(502, info.code, MESSAGES[info.code]);

  const now = deps.now();
  const timeZone = deps.env.timeZone ?? 'UTC';
  const today = localDate(now, timeZone);

  const body: UsageResponse = {
    provider: publicProvider(provider),
    asOf: now.toISOString(),
    spend: info.spend,
    spendKind: info.spendKind,
  };

  const rollingDegraded = {
    figure: 'rolling',
    code: 'rolling_unavailable',
    message: 'Rolling spend is unavailable for this key.',
  };

  if (!info.userId) {
    body.degraded = [rollingDegraded];
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
      body.degraded = [rollingDegraded];
    }
  }

  return { status: 200, body };
}

function publicProvider(provider: Provider): ProviderRef {
  return { id: provider.id, name: provider.name, host: provider.host };
}

function send(response: ServerResponse, answer: Answer): void {
  response.writeHead(answer.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(answer.body));
}
