# Which LiteLLM endpoints back budget, spend and rolling windows

Research for `openchamber-litellm-usage` (wayfinder ticket
[#3](https://github.com/oroszgy/openchamber-litellm-usage/issues/3)). Question:
for a single configured **non-admin virtual key**, how do we get the current
budget-window spend, lifetime spend, remaining budget, next reset time, and
rolling day/week/month spend — and which of these a non-admin key can reach.

## Provenance

- **Version relied on:** LiteLLM **v1.104.2**, the latest stable release at the
  time of writing (published 2026-10-08). All source links are pinned to that
  tag.
- **Primary sources:** the LiteLLM source at tag `v1.104.2` and the official
  docs. Each claim below cites the file that owns it.
- The repo's map notes "LiteLLM ~v1.104.2", so this is the version we target.
  Version-dependence is called out inline and summarised at the end.

Source files used (all at `v1.104.2`):

- [`litellm/proxy/management_endpoints/key_management_endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/key_management_endpoints.py) — `/key/info`
- [`litellm/proxy/management_endpoints/internal_user_endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/internal_user_endpoints.py) — `/user/info`, `/v2/user/info`, `/user/daily/activity`
- [`litellm/proxy/management_endpoints/common_daily_activity.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/common_daily_activity.py) — daily-activity query/totals
- [`litellm/proxy/spend_tracking/spend_management_endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/spend_tracking/spend_management_endpoints.py) — `/spend/logs/v2`, `/key/spend/report`, `/user/spend/report`
- [`litellm/proxy/_types.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/_types.py) — route allow-lists, `UserInfoV2Response`
- [`litellm/proxy/schema.prisma`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/schema.prisma) — DB columns (`spend`, `total_spend`, `soft_budget` locations)
- [`litellm/proxy/db/db_spend_update_writer.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/db/db_spend_update_writer.py) — what increments on each request
- [`litellm/proxy/common_utils/reset_budget_job.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/common_utils/reset_budget_job.py) — what a reset zeroes
- [`db_scripts/backfill_key_total_spend.sql`](https://github.com/BerriAI/litellm/blob/v1.104.2/db_scripts/backfill_key_total_spend.sql) — `total_spend` introduction/backfill
- [`tests/e2e/quota_management/budgets/BUDGET_CODE_MATRIX.md`](https://github.com/BerriAI/litellm/blob/v1.104.2/tests/e2e/quota_management/budgets/BUDGET_CODE_MATRIX.md) — first-party table of what is stored/enforced where
- Docs: [Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys), [Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users)

## TL;DR

For a key-bound (`user_id` set), `internal_user`-role virtual key, **two calls per
refresh** cover every figure:

1. `GET /key/info` with **no `key` param** (the key reads itself) → current-window
   `spend`, `max_budget`, `total_spend` (lifetime), `budget_duration`,
   `budget_reset_at` (next reset), `budget_limits_usage`, and
   `litellm_budget_table.soft_budget`. Derive `remaining = max_budget - spend`.
2. `GET /user/daily/activity?api_key=<hash>&start_date=<window start>&end_date=<today>`
   (or `/user/daily/activity/aggregated`), one call over the widest window, then
   bucket `results[].date` client-side into day/week/month sums.

`/spend/logs/v2` is for per-request detail, **not** for totalling windows.
`/v2/user/info` is the user-scoped counterpart when the panel wants the owner's
figures (all keys) rather than the key's.

The catch: (2) is user-scoped and requires the key to have a `user_id`. A
service-account or ownerless key gets `403` there; fall back to
`/key/spend/report` (spend-logs based, still role-gated), or degrade.

## Endpoint-by-endpoint

### `GET /key/info` — key-scoped, self-serve, the anchor

Handler `info_key_fn` (`key_management_endpoints.py`). Passing no `key` defaults
to `user_api_key_dict.api_key`, and `_can_user_query_key_info` returns `True` when
`user_api_key_dict.api_key == key`, so **a virtual key can read itself with no
`key` param and no master key**. It can also read keys sharing its `user_id`, or
its team's keys when it holds the team permission.

Response shape: `{ "key": <as passed>, "info": <key row minus the hashed token> }`.
The row is a raw dump of `LiteLLM_VerificationToken`, so every column below is
present. Fields the panel needs:

| Field in `info` | Meaning |
| --- | --- |
| `spend` | **Current budget-window spend.** The handler docstring: "Amount spent by the key. When `budget_duration` is set this covers only the current budget window, not the key's lifetime." With no `budget_duration` it is the lifetime value, because nothing resets it. |
| `total_spend` | **Lifetime spend.** Separate counter incremented on every request regardless of budget resets. Present as a top-level key here. |
| `max_budget` | Hard cap, compared against `spend`. `null` means no key-level cap (user/team budgets may still apply). |
| `budget_duration` | Reset period (`"30d"`, `"1h"`, …), or `null` for a never-resetting budget. |
| `budget_reset_at` | **Next** reset instant, not the last one. Only meaningful when a duration is set. Reset times snap to boundaries: `30d`/`1mo` → 1st of month, `7d` → Monday, `1h` → the hour (handler docstring; docs [Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users)). |
| `budget_limits` | Stored list of concurrent windows, e.g. `[{"budget_duration":"24h","max_budget":10}, …]`. Returned untouched. |
| `budget_limits_usage` | Present only when the key has `budget_limits`: current-window spend per window, e.g. `{"24h": {"current_spend": 0.0009}}`. Read from the same cross-pod counter enforcement uses. |
| `model_max_budget_usage` | Present only when the key has per-model budgets: current-period spend per model. |
| `budget_id`, `litellm_budget_table` | The linked budget tier. **`soft_budget` lives here, nested** (see below). |
| `status`, `key_alias`, `last_active`, `expires`, `models`, `tpm_limit`, `rpm_limit` | Panel chrome. |

**Remaining budget** is not a field; compute `max_budget - spend`. Guard the
`max_budget is null` case (see “when no endpoint yields a figure”).

Source: [`key_management_endpoints.py` `info_key_fn`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/key_management_endpoints.py) (route at ~L4354, docstring lists every field).

#### Where `soft_budget` actually is (the moved field)

`soft_budget` is **not a column on the key row**. It lives on
`LiteLLM_BudgetTable`, linked by `LiteLLM_VerificationToken.budget_id`
([`schema.prisma`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/schema.prisma), models `LiteLLM_BudgetTable` and `LiteLLM_VerificationToken`).
When a key is created/updated with `soft_budget`, LiteLLM creates (or updates) a
budget row and points the key at it (`generate_key_helper_fn` ~L1352;
`_update_key_soft_budget`/`_apply_soft_budget_update` ~L2384).

Consequences for the panel:

- On `/key/info`, read it as **`info.litellm_budget_table.soft_budget`**. There is
  no top-level `info.soft_budget` — even though `/key/generate` does add a
  top-level `response["soft_budget"]`, and the merged auth view
  `LiteLLM_VerificationTokenView` exposes one. `info_key_fn` fetches
  `include={"litellm_budget_table": True}` and dumps the `LiteLLM_VerificationToken`
  model, so the budget table arrives nested.
- `max_budget` and `budget_duration` for the key normally stay top-level columns;
  a key linked to a tier without its own explicit `budget_duration` follows the
  tier's schedule, so also check `info.litellm_budget_table.budget_reset_at`
  (`reset_budget_for_litellm_budget_table` advances the tier's reset).
- `soft_budget` is an **alert only** (Slack/email + an 80%-of-max alert), never a
  block — [`BUDGET_CODE_MATRIX.md`](https://github.com/BerriAI/litellm/blob/v1.104.2/tests/e2e/quota_management/budgets/BUDGET_CODE_MATRIX.md).

#### What increments, and what a reset zeroes

- Each request's cost is added to both counters on the key row:
  `data={"spend": increment, "total_spend": increment, "last_active": now}` in
  [`db_spend_update_writer.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/db/db_spend_update_writer.py) (~L2078).
- The reset job **zeroes `spend`** (or leaves the overage above `max_budget` when
  the proxy-wide `budget_rollover` setting is on) and **advances
  `budget_reset_at`**; it never touches `total_spend`
  ([`reset_budget_job.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/common_utils/reset_budget_job.py);
  documented in [`BUDGET_CODE_MATRIX.md`](https://github.com/BerriAI/litellm/blob/v1.104.2/tests/e2e/quota_management/budgets/BUDGET_CODE_MATRIX.md), “Reset by duration”).

So `total_spend` is the honest lifetime key spend, and `spend` is the
since-last-reset counter the budget is enforced against.

### `GET /user/info` — user-scoped, heavy (v1)

Handler `user_info` (`internal_user_endpoints.py`). Returns
`UserInfoResponse { user_id, user_info, keys, teams }` where `user_info` is the
`LiteLLM_UserTable` row and `keys` is every key the user owns (full rows, via
`_process_keys_for_user_info`). `user_info` carries the user's `spend`,
`max_budget`, `budget_duration`, `budget_reset_at`, and `model_max_budget_usage`.

- Access: route gate compares a `user_id` query param against the caller; the
  handler re-checks ownership (`_enforce_user_info_access`). Non-admins can only
  read themselves.
- Because it loads all keys and teams it is the “god endpoint” the v2 replaced;
  avoid polling it for a status panel.
- `LiteLLM_UserTable` has **no `soft_budget` column**, so there is no user soft
  budget here.

### `GET /v2/user/info` — user-scoped, lightweight (preferred if you need user figures)

Handler `user_info_v2`. Returns only the user object: `user_id`, `user_email`,
`user_alias`, `user_role`, `spend`, `max_budget`, `models`, `budget_duration`,
`budget_reset_at`, `metadata`, `created_at`, `updated_at`, `sso_user_id`, `teams`,
`object_permission`, `model_max_budget`, `model_max_budget_usage`. **No `keys`,
no `teams` objects, no `soft_budget`.**

Access RBAC is in the handler: admins any user, team admins their teams' users,
internal users only themselves (defaults to self when `user_id` omitted). A key
with no `user_id` gets `400` ("user_id is required").

Semantics the handler states explicitly: `spend` is the user's **running budget
counter**, reset by the budget job (to zero, or the overage with
`budget_rollover`). It is **not** lifetime or per-period history, and it
aggregates *all* the user's keys — its total diverges from any single key's
`spend`, and from the daily-activity totals once a reset has happened.

### `GET /user/daily/activity` and `/user/daily/activity/aggregated` — the rolling-window source

Handlers `get_user_daily_activity` / `get_user_daily_activity_aggregated`
(`internal_user_endpoints.py`). Both require **`start_date` and `end_date`**
(else `400`), accept optional `model`, `api_key`, `user_id`, `timezone`,
`include_current_utc_day`. The paginated one takes `page`/`page_size` (default
50, max 1000); the `/aggregated` one returns the full set with page metadata set
to a single page and does the aggregation in SQL.

Response `SpendAnalyticsPaginatedResponse`:

- `results[]` — one `DailySpendData` per day: `date` plus `metrics.spend`,
  token/request counts, and per-model/per-api_key breakdowns.
- `metadata.total_spend` — summed spend across the range; also token/request
  totals.

Key-scoping: the route is **user-scoped** (`table_name="litellm_dailyuserspend"`,
`entity_id_field="user_id"`). Non-admins are forced to their own `user_id`
(`require_caller_user_id_for_non_admin`), which returns `403` when the caller has
no `user_id` — explicitly to stop service-account keys from seeing every tenant.
Passing `api_key=<key sha256 hash>` narrows the query to that one key (the daily
table stores the key hash in its `api_key` column; exact match).

Crucially, the handler docstring and the code comments say these daily rows
**only ever accumulate and are never affected by budget resets**, so their total
can legitimately exceed `/v2/user/info`'s `spend`. That makes this the right
source for rolling day/week/month spend.

### `GET /key/spend/report` — key-scoped rolling spend from spend logs

Handler `get_key_spend_report` (`spend_management_endpoints.py`). Callable by a
key; non-admins are always scoped to their own `api_key` by
`_resolve_spend_report_scope`. Optional `start_date`/`end_date` (`YYYY-MM-DD`),
optional `api_key` (admins only may point it at another key; pass the sha256
hash). Returns per-model rows with `api_key`, `total_cost`,
`total_input_tokens`, `total_output_tokens`, `model_details` — SQL over
`LiteLLM_SpendLogs` for `[start, end+1 day)`. Sum client-side across models.
Route is in `spend_tracking_routes`, so it needs the internal-user role (see
reachability). Range is bounded to 366 days (`_SPEND_REPORT_MAX_RANGE_DAYS`), and
spend-log retention bounds history.

Its sibling `GET /user/spend/report` is the user-scoped version (grouped by
api_key).

### `GET /spend/logs/v2` (and `/spend/logs`, `/spend/logs/ui`) — detail, not totals

Handler `ui_view_spend_logs` (`spend_management_endpoints.py`), registered on both
`/spend/logs/v2` and the UI-only `/spend/logs/ui`. `start_date` + `end_date`
required; v2 accepts `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS` (the UI path only the
latter). Returns a paginated envelope of raw spend-log rows (`spend`, `api_key`,
`user`, `model`, `startTime`, `endTime`, tokens, status, …).

Non-admin scoping: `_can_user_view_spend_log` admits `internal_user` /
`internal_user_viewer` with a non-null `user_id`; the query is then pinned to
`user = caller.user_id` (or the caller's permitted teams). `api_key=<hash>`
narrows further to one key.

This is fine for showing recent requests or proving a figure, but **wrong for
window totals** — you would have to page every row and sum. `GET /spend/logs`
(no version) is the legacy form and self-describes as truncated (“result
truncated to the N most recent rows; use `/spend/logs/v2`”).
`/spend/logs/ui` is `include_in_schema=False` and UI-shaped.

## Figure → endpoint map

| Figure | Cheapest correct source | Notes |
| --- | --- | --- |
| Current budget-window spend | `GET /key/info` → `info.spend` | Key's own counter; resets with the key's budget. |
| Lifetime spend | `GET /key/info` → `info.total_spend` | New counter, v1.103.0+. Fallback below. |
| Remaining budget | `info.max_budget - info.spend` | No server-computed field; `null` max_budget means no key cap. |
| Next reset time | `info.budget_reset_at`; else `info.litellm_budget_table.budget_reset_at` | `null` when no duration anywhere. |
| Soft-budget warning line | `info.litellm_budget_table.soft_budget` | Nested, alert-only. |
| Per-window spend (multi-window keys) | `info.budget_limits_usage` | Keyed by duration. |
| Per-model spend (current period) | `info.model_max_budget_usage` | Only for keys with per-model budgets. |
| Owner's spend/budget/reset (all keys) | `GET /v2/user/info` | User counter, resets on reset. |
| Rolling day/week/month spend | `GET /user/daily/activity` (+`api_key`) or `/aggregated` | User-scoped; requires a `user_id`. |
| Rolling key spend, no owner user | `GET /key/spend/report` | Spend-logs based, role-gated. |
| Recent per-request detail | `GET /spend/logs/v2` | Don't sum it for windows. |

## Non-admin reachability

`RouteChecks.non_proxy_admin_allowed_routes_check`
([`route_checks.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/auth/route_checks.py))
with the allow-lists in [`_types.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/_types.py):

- `/key/info`, `/user/info`, `/v2/user/info` are **info routes**, permitted
  regardless of role, with ownership checks inside the handlers.
- `/user/daily/activity` and `/user/daily/activity/aggregated` are in
  `self_managed_routes`: permitted to any authenticated caller; the handler
  enforces own-user scoping.
- `/spend/logs/v2`, `/spend/logs`, `/key/spend/report`, `/user/spend/report` are
  in `spend_tracking_routes` → reachable only by keys whose **owner role** is
  `internal_user` or `internal_user_viewer` (or an admin), unless the key carries
  explicit `allowed_routes`.

So the reachable set depends on the owner:

| Configured key | `/key/info` self | `/v2/user/info` self | `/user/daily/activity` | `/spend/logs/v2`, `/key/spend/report` |
| --- | --- | --- | --- | --- |
| Owner `internal_user` / viewer, `user_id` set | ✅ | ✅ (self) | ✅ | ✅ |
| Owner role `null` (admin-created key with no `user_id`) | ✅ | ❌ `400` | ❌ `403` (no user_id) | ❌ `403` (role gated) |
| Service-account key (`user_id` forced `null`) | ✅ | ❌ `400` | ❌ `403` (guard) | ❌ (role/no user_id) |

A key can widen this if an admin sets `allowed_routes`, but that is not the
default for the extension's single configured key.

Phase 1's needs (`/key/info` only) are satisfied for **every** non-admin key,
including ownerless and service-account keys. Only the rolling-window phase
depends on the owner having a `user_id` and an internal-user role.

## Cheapest combination for a refreshing panel

1. **Phase 1 (budget/spend/reset): one request.** `GET /key/info` with the bearer
   key, no query params. One primary-key row read plus at most one join
   (`litellm_budget_table`). Compute `remaining` locally. This is also the
   lightest endpoint and the one the proxy's own docs point at.
2. **Phase 2 (rolling windows): one request.** `GET /user/daily/activity` (or
   `/aggregated`) with `api_key=<key sha256 hash>`, `start_date` = first day of
   the widest window you show (e.g. start of month), `end_date` = today, and a
   `page_size` ≥ days in range. Bucket `results[].date` into day/week/month sums
   from the same response — no need for three calls. Reading pre-aggregated daily
   rows is cheaper than scanning spend logs per window.
3. Refresh cadence: `/key/info` is cheap enough to poll per panel refresh;
   daily-activity can refresh more slowly (spend rows are batch-upserted, so
   sub-minute polling buys nothing).

Total steady state: **two GETs**. Neither is `/spend/logs/v2`.

## When no single endpoint yields a figure

- **`max_budget` is `null` → no key cap.** Don't print a number. The owner's
  `/v2/user/info.max_budget` or `/team/info` may carry the real cap (a key on a
  team is governed by team/team-member budgets, not the personal user budget —
  docs [Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users)).
- **Next reset `null` but a budget exists.** The key may be following a linked
  tier: read `info.litellm_budget_table.budget_reset_at`. If still null, the
  budget never resets.
- **Lifetime `total_spend` missing or `0` on an older/unbackfilled proxy.** The
  column arrived in v1.103.0 with `DEFAULT 0` and **no automatic backfill**
  ([`backfill_key_total_spend.sql`](https://github.com/BerriAI/litellm/blob/v1.104.2/db_scripts/backfill_key_total_spend.sql)).
  Without the backfill, a key created before the upgrade under-reports lifetime.
  Fall back to summing `/user/daily/activity` over the available history, or
  `/key/spend/report` (≤366 days per call, bounded further by spend-log
  retention). The backfill script itself can only recover earlier periods from
  `LiteLLM_SpendLogs`, so retention still bounds it.
- **Rolling windows 403 (ownerless/service-account key).** `/user/daily/activity`
  requires a caller `user_id`; use `/key/spend/report` when the role permits, and
  otherwise degrade to Phase 1 only — `/key/info` cannot produce rolling windows.

## Version dependence and uncertainties

- **`total_spend` (lifetime) is new and backfill-gated.** Introduced in
  **v1.103.0** (migration `20260916000000_add_key_total_spend`; see the backfill
  script header). On older proxies the field is absent; on v1.103.0+ without the
  backfill it only reflects spend since the upgrade (or current period for
  resetting keys). Treat it as best-effort and degrade as above.
- **`soft_budget` has been on the linked budget table for a long time** (present
  in v1.60.0's `/key/info` fetch with `include={"litellm_budget_table": True}`),
  but callers that expect a top-level `soft_budget` will not find one on
  `/key/info`. `/key/generate` and the merged auth view differ. The schema has
  never had a `soft_budget` column on `LiteLLM_VerificationToken` in the versions
  checked (v1.50.0, v1.60.0, v1.104.2).
- **Multi-window budgets (`budget_limits`, `budget_limits_usage`) and
  `include_current_utc_day` are newer** than the v1-era endpoints; on an older
  proxy those fields/params are absent. They are additive, so a client that
  treats them as optional degrades cleanly.
- **`/user/daily/activity/aggregated`** is newer than the paginated endpoint;
  older proxies only have `/user/daily/activity` (sum `results[]` instead).
- **Uncertain / not verified on a live proxy:** the exact response when
  `api_key` is passed to `/user/daily/activity` for a key whose hash differs from
  the one recorded in `litellm_dailyuserspend` (older spend paths re-hashed the
  digest — noted in the backfill script). Do a live check against the target
  proxy before relying on the `api_key` filter; the fallback is to filter
  `results[].breakdown.api_keys` client-side.
- **Discarded-alternative note:** `/spend/logs/v2` returns raw rows and supports
  `api_key`, but totalling it means paginating and summing; it is intentionally
  not part of the recommended refresh path.
