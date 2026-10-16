/**
 * The wire contract between the local service and the guest section: the JSON
 * shapes that cross the host's `serviceRequest` bridge.
 *
 * Types only. Both sides import them with `import type`, so the bundler erases
 * the import and nothing here reaches either runtime.
 */

export type ProviderRef = { id: string; name: string; host: string };

/** Why a candidate was not confirmed as a LiteLLM proxy. */
export type UnconfirmedCode =
  | 'unauthorized'
  | 'unsupported_proxy'
  | 'provider_unreachable'
  | 'upstream_error'
  | 'no_key';

/** A candidate the probe did not confirm; the key is never returned. */
export type UnconfirmedRef = { id: string; name: string; host: string; code: UnconfirmedCode };

/**
 * `GET /providers`: the confirmed targets, the one to use when none is
 * requested, and the candidates that were found but not confirmed.
 */
export type ProvidersResponse = {
  providers: ProviderRef[];
  default: string | null;
  /** Omitted when every candidate was confirmed. */
  rejected?: UnconfirmedRef[];
};

/**
 * What `spend` is. LiteLLM reports a key's `info.spend` as the current budget
 * window's figure when it has a `budget_duration`, and as the never-resetting
 * total when it does not.
 */
export type SpendKind = 'window' | 'lifetime';

/** Today, the last 7 days and the last 30 days, each a local calendar day. */
export type Rolling = { day: number; week: number; month: number };

/** A figure the service could not read, with a code and a human message. */
export type Degraded = { figure: string; code: string; message: string };

/** `GET /usage`: everything the section renders, already normalised. */
export type UsageResponse = {
  provider: ProviderRef;
  asOf: string;
  spend: number;
  spendKind: SpendKind;
  rolling?: Rolling;
  degraded?: Degraded[];
};
