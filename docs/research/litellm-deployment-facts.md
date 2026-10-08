# LiteLLM deployment facts

Gathered 2026-10-08 for [#10](https://github.com/oroszgy/openchamber-litellm-usage/issues/10),
by probing the configured proxy **read-only** (the key was never written down here).

## Provider

- Provider id `litellm` ("LiteLLM"), `baseURL = https://litellm.doris.dev.cnect.eu/v1`
  → management root **`https://litellm.doris.dev.cnect.eu`**.
- A second candidate `litellm-claude` ("LiteLLM Claude") points at the **same** host.
- Key from the provider's inline `apiKey` (an entry also exists in `auth.json`).

## Facts

- **LiteLLM version: `1.104.2`** — read from `GET /openapi.json` → `info.version`.
  No `x-litellm-version` response header is exposed (stripped at the edge).
- **Database connected: yes.** Evidence: persisted keys/teams/spend, a non-empty
  `/key/info` `spend`, and `/user/daily/activity` returning DB-backed spend logs.
- **Credential is a virtual key**, not the master key — alias "Gyorgy DEV",
  `user_id` / `team_id` ("Doris") / `object_permission_id` set, `key_type: null`.
  It reads its own `GET /key/info` with **no** `key` param. `auto_rotate: true`,
  `rotation_interval: "90d"`.
- **`/user/daily/activity` is permitted** for the key, with two gotchas:
  - `api_key` must be the **hash** (the `key` field of `/key/info`), not the raw key;
  - `start_date` and `end_date` are **required** (omitting them → `400
    {"detail":{"error":"Please provide start_date and end_date"}}`).
  `include_current_utc_day=true` is accepted. Response shape:
  `{"results":[{"date":"2026-10-08","metrics":{"spend":…,"total_tokens":…,"api_requests":…}}]}`.
  A year-long range returned only the most recent **~12 days** (2026-10-08 … 2026-09-23),
  summing to ≈ `$370.9` — the endpoint appears to retain/return a bounded window.
- **Proxy timezone: not exposed** by any API. The service resolves the timezone from
  its own host (`Intl.DateTimeFormat().resolvedOptions().timeZone`) per
  [#5](https://github.com/oroszgy/openchamber-litellm-usage/issues/5); LiteLLM snaps
  reset boundaries in *its* configured timezone, which is not discoverable here.
- **No budgets anywhere.** The key **and** the team ("Doris") both report
  `max_budget: null`, `budget_duration: null`, `budget_reset_at: null`, and the key has
  no `litellm_budget_table`. So this deployment's real state is **unbudgeted**
  (`balance.kind = "unlimited"`): there is no remaining budget and no reset window to
  show; the section's headline is spend, plus the rolling totals.
- **`spend` vs `total_spend` disagree.** `info.spend = 1536.605…`,
  `info.total_spend = 20.662…`. LiteLLM documents `spend` as the key's spend (the
  current budget window only when `budget_duration` is set, otherwise the key's own
  spend) — this key has no `budget_duration`. Neither value matches the ~12-day
  activity sum (≈ `$370.9`). Flagged for
  [#8](https://github.com/oroszgy/openchamber-litellm-usage/issues/8) to reconcile
  against the version.
- **`/health` is expensive**: `200` after ≈ **36 s**, calling every upstream model and
  returning `healthy_endpoints`. Confirms the service's own `/health` must stay a pure
  liveness check that never touches LiteLLM (as decided in
  [#5](https://github.com/oroszgy/openchamber-litellm-usage/issues/5)).

## Sample

`sample-key-info.json` is the captured `GET /key/info` body with identifiers redacted
(key hash, key name, user/team/permission ids). The shape and all numeric fields are
as returned by `1.104.2`.
