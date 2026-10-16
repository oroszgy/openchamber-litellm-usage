/**
 * Probe-gated discovery: read the config candidates and keep as targets only
 * those whose `/key/info` probe answers with the LiteLLM shape. Every other
 * candidate is reported as unconfirmed, with the reason — so a typo'd or
 * half-configured provider is explained rather than silently missing.
 *
 * The probe result is cached per management root and key for a short window, so
 * `/providers` and the `/usage` that follows it share one probe, and each panel
 * expand within the window re-uses it. Successes and failures are both cached.
 */
import { readCandidates, type Candidate, type ConfigDeps } from './config.ts';
import { readKeyInfo, type KeyInfo, type KeyInfoFailure } from './litellm.ts';

export type UnconfirmedCode = KeyInfoFailure | 'no_key';

type KeyInfoOk = Extract<KeyInfo, { ok: true }>;
type ProbeResult = KeyInfo | { ok: false; code: 'no_key' };

/** A candidate the probe confirmed is a LiteLLM proxy; its read is kept. */
export type Target = { id: string; name: string; host: string; key: string; info: KeyInfoOk };

/** A candidate the probe did not confirm. */
export type Unconfirmed = { id: string; name: string; host: string; code: UnconfirmedCode };

export type Discovery = { confirmed: Target[]; unconfirmed: Unconfirmed[] };

/** How long a probe's outcome is trusted, in milliseconds. */
export const PROBE_CACHE_MS = 60_000;

export type DiscoveryDeps = ConfigDeps & {
  fetch: typeof fetch;
  /** Epoch milliseconds the cache is measured against; defaults to `Date.now`. */
  now?: (() => number) | undefined;
};

/**
 * Build a `discover(directory)` bound to one probe cache, so a service instance
 * re-uses outcomes across the `/providers` and `/usage` pair.
 */
export function createDiscovery(deps: DiscoveryDeps): (directory: string | null) => Promise<Discovery> {
  const cache = new Map<string, { at: number; result: ProbeResult }>();
  const now = deps.now ?? Date.now;

  async function probe(candidate: Candidate, at: number): Promise<ProbeResult> {
    if (candidate.key === null) return { ok: false, code: 'no_key' };
    const cacheKey = `${candidate.host}\u0000${candidate.key}`;
    const cached = cache.get(cacheKey);
    if (cached && at - cached.at < PROBE_CACHE_MS) return cached.result;

    const result = await readKeyInfo(deps.fetch, { host: candidate.host, key: candidate.key });
    cache.set(cacheKey, { at, result });
    return result;
  }

  return async function discover(directory: string | null): Promise<Discovery> {
    const candidates = await readCandidates(directory, deps);
    const at = now();
    const probed = await Promise.all(
      candidates.map(async (candidate) => ({ candidate, result: await probe(candidate, at) })),
    );

    const confirmed: Target[] = [];
    const unconfirmed: Unconfirmed[] = [];
    for (const { candidate, result } of probed) {
      if (result.ok && candidate.key !== null) {
        confirmed.push({
          id: candidate.id,
          name: candidate.name,
          host: candidate.host,
          key: candidate.key,
          info: result,
        });
      } else {
        unconfirmed.push({
          id: candidate.id,
          name: candidate.name,
          host: candidate.host,
          code: result.ok ? 'no_key' : result.code,
        });
      }
    }
    return { confirmed, unconfirmed };
  };
}
