/**
 * The wire contract between the local service and the guest section: the JSON
 * shapes that cross the host's `serviceRequest` bridge.
 *
 * Types only. Both sides import them with `import type`, so the bundler erases
 * the import and nothing here reaches either runtime.
 */

export type ProviderRef = { id: string; name: string };

/**
 * `GET /providers`: the confirmed targets and the one to use when the user has
 * not picked one. Unconfirmed candidates stay in the service.
 */
export type ProvidersResponse = {
  providers: ProviderRef[];
  default: string | null;
};

/** Today, the last 7 days and the last 30 days, each a local calendar day. */
export type Rolling = { day: number; week: number; month: number };

/** A key's own budget window, mapped onto one of the section's periods. */
export type BudgetPeriod = 'day' | 'week' | 'month' | 'total';

/** A cap and the spend against it in the window's current cycle. */
export type Budget = { cap: number; spend: number };

/** Only the periods the key actually has a window for. */
export type Budgets = Partial<Record<BudgetPeriod, Budget>>;

/**
 * `GET /usage`: everything the section renders, already normalised. `rolling`
 * is absent when the activity read is unavailable; `notice` then explains it.
 */
export type UsageResponse = {
  rolling?: Rolling;
  budgets?: Budgets;
  notice?: string;
};
