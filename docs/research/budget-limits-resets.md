# Budget-limit reset times (`budget_limits` windows)

Research for the map "LiteLLM Usage extension architecture"
([#14](https://github.com/oroszgy/openchamber-litellm-usage/issues/14)).
Question: for a virtual key's `budget_limits` (per-window budget limits, each entry
carrying `budget_duration` and `max_budget` and, apparently, no reset timestamp in
`GET /key/info`) — **does the LiteLLM proxy itself compute and enforce a reset time
per window, and is it exposed by the management API?**

## Provenance

- **Version relied on:** LiteLLM **v1.104.2** (the target deployment, per
  [#10](https://github.com/oroszgy/openchamber-litellm-usage/issues/10)). All source
  links are pinned to that tag; `pyproject.toml` on the tag reads `version = "1.104.2"`.
- **Primary sources:** the LiteLLM source at tag `v1.104.2` and the official docs.
  Every claim cites the file that owns it (path + line range) or the doc URL.
- Docs are published from `main`, not from the tag, so slight drift is possible;
  the source pin is authoritative for v1.104.2. Version caveats are collected at the end.

Source files used (all at `v1.104.2`):

- [`litellm/models/team.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/models/team.py) — `BudgetLimitEntry`, team `budget_limits`
- [`litellm/models/verification_token.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/models/verification_token.py) — key row (`budget_limits`, `budget_reset_at`)
- [`litellm/litellm_core_utils/duration_parser.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/litellm_core_utils/duration_parser.py) — `get_next_standardized_reset_time` (the boundary rule)
- [`litellm/proxy/common_utils/timezone_utils.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/common_utils/timezone_utils.py) — timezone/reset-time config
- [`litellm/proxy/common_utils/reset_budget_job.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/common_utils/reset_budget_job.py) — the reset job and window reset
- [`litellm/proxy/spend_tracking/budget_reservation.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/spend_tracking/budget_reservation.py) — window-start derivation and counters
- [`litellm/proxy/management_endpoints/key_management_endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/key_management_endpoints.py) — `/key/info`, `/key/generate`, `/key/update`, reset-spend
- [`litellm/proxy/management_endpoints/team_endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/team_endpoints.py) — team window init/update
- [`litellm/proxy/proxy_server.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/proxy_server.py) and [`litellm/constants.py`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/constants.py) — reset job scheduling
- Migrations [`20260401000000_add_budget_limits`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm-proxy-extras/litellm_proxy_extras/migrations/20260401000000_add_budget_limits/migration.sql) and [`20260804162853_add_budget_window_spend_table`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm-proxy-extras/litellm_proxy_extras/migrations/20260804162853_add_budget_window_spend_table/migration.sql) — DB columns/tables
- Docs: [Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users), [Budget Reset Times and Timezones](https://docs.litellm.ai/docs/proxy/budget_reset_and_tz)

## TL;DR

1. **Yes — the proxy computes each window's reset time and enforces it.** Every
   `budget_limits` entry carries its own `reset_at`. A background `ResetBudgetJob`
   zeroes that window's spend counter when `reset_at <= now` and advances `reset_at`
   to the next boundary. Windows are independent: only the expired one is reset.
2. **The reset time *is* exposed — as `reset_at` inside each `budget_limits` entry**
   in `/key/info` (and `/team/info`), returned verbatim ("exactly as stored").
   `/key/info` additionally returns `budget_limits_usage`, a map keyed by
   `budget_duration` with `{"current_spend": …}` for the current window.
   There is **no** separate `budget_reset_at` per window; the single-budget
   `info.budget_reset_at` field is the *key-level* budget's next reset and is
   `null` when only `budget_limits` is used.
3. **The anchor is calendar boundaries, not creation + N days.** `30d` and `1mo`
   land on the **1st of the month**; `7d` on **Monday**; `1d`/`24h` at the next
   midnight; sub-day durations roll forward by their interval. The first window
   after creation is therefore partial (creation → next boundary).
4. **Timezone:** `litellm_settings.timezone` (IANA, via `zoneinfo`), defaulting to
   **UTC**; the wall-clock time defaults to **midnight** and is configurable with
   `litellm_settings.budget_reset_time` (`"HH:MM"`).

## 1. Are resets computed and enforced per window?

Yes. `budget_limits` is a list of windows; each window is stored independently and
reset by the scheduled job.

`ResetBudgetJob.reset_budget` is registered as an APScheduler interval job
(`reset_budget_job`) at startup and, every tick, resets key/user/team budgets and
then calls `reset_budget_windows()`:

```python
# litellm/proxy/common_utils/reset_budget_job.py:525-552
await self.reset_budget_for_litellm_keys()
await self.reset_budget_for_litellm_users()
await self.reset_budget_for_litellm_teams()
await self.reset_budget_for_litellm_budget_table()
await self.reset_budget_windows()
```

Registration: [`proxy_server.py:10358-10375`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/proxy_server.py#L10358-L10375).
Tick interval: `PROXY_BUDGET_RESCHEDULER_MIN_TIME` + jitter, default **597–605 s**
(≈10 min) — [`constants.py:1788`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/constants.py#L1788)
and [`constants.py:1818`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/constants.py#L1818); the docs
state "every 10 minutes" ([Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users)).

The per-window reset (`reset_budget_windows`, `_reset_expired_window`) reads each
window's `reset_at`, skips it if still in the future, and on expiry zeroes the
window's spend counter and advances `reset_at` to the next boundary:

```python
# litellm/proxy/common_utils/reset_budget_job.py:1375-1410
reset_at_str = window.get("reset_at")
if not reset_at_str:
    return False
reset_at = datetime.fromisoformat(reset_at_str.replace("Z", "+00:00")).replace(tzinfo=None)
if reset_at > now:
    return False
...
next_reset_at = compute_budget_reset_at(budget_duration=budget_duration, settings=reset_settings)
window["reset_at"] = next_reset_at.isoformat()
```

Only expired windows are touched; the row's `budget_limits` JSON is written back
only when something changed ([`reset_budget_job.py:1530-1554`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/common_utils/reset_budget_job.py#L1530-L1554)).
Spend is tracked in a cross-pod counter keyed
`spend:{key|team}:{id}:window:{budget_duration}` and anchored by `window_start`
([`budget_reservation.py:863-901`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/spend_tracking/budget_reservation.py#L863-L901));
the counter is what enforcement compares against `max_budget`. The DB side uses a
`LiteLLM_BudgetWindowSpend` table (`entity_type`, `entity_id`, `window_duration`,
`window_start`, `spend`).

The window's start is derived as `reset_at - duration_in_seconds(budget_duration)`
([`budget_reservation.py:1159-1174`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/spend_tracking/budget_reservation.py#L1159-L1174)).
Note this uses the *seconds* form of the duration, so for calendar durations it is an
approximation of the true window start (see caveats).

## 2. Is the reset time exposed via the management API?

Yes. The reset time is the `reset_at` field **inside each `budget_limits` entry**.

- The key row model stores `budget_limits` opaquely, so `reset_at` round-trips:
  `budget_limits: list[dict] | None` ([`verification_token.py:65`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/models/verification_token.py#L65)).
- It is initialised on create/update:

  ```python
  # litellm/proxy/management_endpoints/key_management_endpoints.py:2531-2540
  for window in raw_windows:
      w = window if isinstance(window, dict) else window.model_dump()
      w["reset_at"] = get_budget_reset_time(budget_duration=w["budget_duration"]).isoformat()
  ```

  Same logic on `/key/generate` ([`key_management_endpoints.py:4656-4663`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/key_management_endpoints.py#L4656-L4663))
  and on team create/update ([`team_endpoints.py:1742-1751`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/team_endpoints.py#L1742-L1751),
  [`team_endpoints.py:2684-2702`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/team_endpoints.py#L2684-L2702)).
- `/key/info` returns the row dump and adds `budget_limits_usage`; the handler
  docstring documents both fields:

  ```
  - budget_limits: list | None - Concurrent budget windows, exactly as stored
  - budget_limits_usage: dict | None - Current-window spend per budget window, e.g.
    {"1h": {"current_spend": 0.0009}}, present only when the key has budget windows
  ```

  ([`key_management_endpoints.py:4370-4404`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/key_management_endpoints.py#L4370-L4404);
  attachment at [`4478-4483`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/key_management_endpoints.py#L4478-L4483)).

**Field names, precisely:**

| Field | Level | Meaning |
| --- | --- | --- |
| `info.budget_limits[i].reset_at` | per window | Next reset of that window. This is the per-limit timestamp. |
| `info.budget_limits[i].budget_duration` | per window | Window length, e.g. `"24h"`, `"30d"`. |
| `info.budget_limits[i].max_budget` | per window | Cap for that window. |
| `info.budget_limits_usage[budget_duration].current_spend` | per window | Current-window spend, from the enforcement counter. |
| `info.budget_reset_at` | key (single budget) | Next reset **only** when the key has a top-level `budget_duration`; `null` when only `budget_limits` is used. |

So the ticket's premise ("apparently NO reset timestamp in `GET /key/info`") holds
only for the deployment in #10 because that key/team has no budgets at all. A key
*with* `budget_limits` does expose `reset_at` per window. `budget_limits_usage`
does **not** repeat `reset_at`; a consumer needs to join it to `budget_limits` by
`budget_duration`. Teams expose `budget_limits` (with `reset_at`) but, in v1.104.2,
do **not** get a `budget_limits_usage` field — that addition is key-only
([`key_management_endpoints.py:4239-4253`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/key_management_endpoints.py#L4239-L4253)).

### Reset time on write vs. the scheduled job

- On **create/update**, `reset_at` = `get_budget_reset_time(duration)` computed from
  *now* → the next calendar boundary.
- On the **scheduled reset**, `reset_at` is recomputed the same way from the job's
  `now` → the next calendar boundary.
- There is one exception: `POST /key/{key}/reset_spend` manually expires the key's
  windows by setting `reset_at = now + duration_in_seconds(duration)` (a *floating*
  window), deliberately different from the calendar boundary so the manual reset does
  not re-include the spend that triggered it
  ([`key_management_endpoints.py:6115-6140`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/key_management_endpoints.py#L6115-L6140)).

## 3. Exact JSON shape of `budget_limits` (v1.104.2)

Request (`/key/generate`, `/key/update`, `/team/new`, `/team/update`) accepts a list
of `{budget_duration, max_budget}` objects ([docs](https://docs.litellm.ai/docs/proxy/users)):

```json
{
  "budget_limits": [
    {"budget_duration": "24h", "max_budget": 10},
    {"budget_duration": "30d", "max_budget": 100}
  ]
}
```

Stored/returned form: the same entries **plus a server-managed `reset_at`** (an
ISO-8601 datetime string). The typed model is:

```python
# litellm/models/team.py:45-50
class BudgetLimitEntry(LiteLLMPydanticObjectBase):
    """A single budget window with its own limit and independent reset schedule."""
    budget_duration: str
    max_budget: float
    reset_at: datetime | None = None
```

A realistic `/key/info` `info` fragment:

```json
{
  "budget_limits": [
    {"budget_duration": "24h", "max_budget": 10.0, "reset_at": "2026-10-10T00:00:00+00:00"},
    {"budget_duration": "30d", "max_budget": 100.0, "reset_at": "2026-11-01T00:00:00+00:00"}
  ],
  "budget_limits_usage": {
    "24h": {"current_spend": 0.1234},
    "30d": {"current_spend": 12.34}
  }
}
```

(The `budget_limits_usage` values are `round(..., 4)`.) For keys, the DB column is
JSONB and Prisma hands the handler an already-parsed list, so the API emits a real
JSON array; a raw SQL reader may instead see a JSON string
([`key_management_endpoints.py:6100-6110`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/key_management_endpoints.py#L6100-L6110)).
The column is added to both `LiteLLM_VerificationToken` and `LiteLLM_TeamTable` by
migration [`20260401000000_add_budget_limits`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm-proxy-extras/litellm_proxy_extras/migrations/20260401000000_add_budget_limits/migration.sql).
Users do **not** support `budget_limits` in v1.104.2 (the user table has only the
single `budget_duration` / `budget_reset_at`; user multi-window was requested in
[BerriAI/litellm#28235](https://github.com/BerriAI/litellm/issues/28235) and closed
as not planned).

## 4. The boundary rule and timezone

The rule lives in `get_next_standardized_reset_time`
([`duration_parser.py:109-166`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/litellm_core_utils/duration_parser.py#L109-L166)),
called through `compute_budget_reset_at`
([`timezone_utils.py:64-72`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/common_utils/timezone_utils.py#L64-L72)):

| `budget_duration` | Boundary (v1.104.2) | Code |
| --- | --- | --- |
| `1d` (or alias `daily`) | Next midnight at `reset_time_of_day` | `_handle_day_reset` value 1 |
| `24h` | Next midnight (aligned hour) | `_handle_hour_reset` value 24 |
| `7d` (or `weekly`) | Next **Monday** at `reset_time_of_day` | `_handle_day_reset` value 7 |
| `30d` (or `monthly`) | **1st of next month** at `reset_time_of_day` | `_handle_day_reset` value 30 → `_handle_month_reset` |
| `1mo` | **1st of next month** at `reset_time_of_day` | `_handle_month_reset` |
| `Nd` other (e.g. `14d`) | Midnight today + N days, at `reset_time_of_day` | `_handle_day_reset` else-branch |
| `Nh` (e.g. `2h`) | Next hour boundary divisible by N | `_handle_hour_reset` |
| `Nm` / `Ns` | Next minute/second boundary | `_handle_minute_reset` / `_handle_second_reset` |

Key points:

- **Not** "rolling N days from first spend". `30d` is a **calendar month anchored to
  the 1st**, and `7d` to **Monday** — the anchor is the boundary, not the key's
  creation or first spend. The docs agree: `30d` → "1st of every month at midnight UTC",
  `7d` → "Every Monday" ([Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users),
  [Budget Reset Times and Timezones](https://docs.litellm.ai/docs/proxy/budget_reset_and_tz)).
- Because `reset_at` is recomputed from "now" at each reset, the window effectively
  floats to the next boundary each period. A window created mid-period has a short
  first window (creation → next boundary).
- `get_next_standardized_reset_time` computes in the configured timezone; the returned
  datetime is timezone-aware and is stored via `.isoformat()` (so it carries an
  offset; with the default UTC config it is `+00:00`).
- `_handle_month_reset` raises `ValueError` for month counts other than 1, so
  e.g. `3mo` is rejected at write time (`validate_budget_duration`,
  [`common_utils.py:27-41`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/management_endpoints/common_utils.py#L27-L41),
  [`timezone_utils.py:95-104`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/common_utils/timezone_utils.py#L95-L104)).
  Use `30d`/`1mo` for calendar months.

**Timezone source.** `litellm_settings.timezone` (any IANA name),
defaulting to `UTC`; and `litellm_settings.budget_reset_time` (`"HH:MM"`, default
midnight). See `get_budget_reset_timezone` / `parse_budget_reset_time`
([`timezone_utils.py:44-61`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/proxy/common_utils/timezone_utils.py#L44-L61))
and `_setup_timezone` (`zoneinfo.ZoneInfo`,
[`duration_parser.py:169-189`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/litellm_core_utils/duration_parser.py#L169-L189)).
Docs: [Budget Reset Times and Timezones](https://docs.litellm.ai/docs/proxy/budget_reset_and_tz).
The proxy timezone is **not** exposed by any API, so a client cannot discover it
(also noted in [#10](https://github.com/oroszgy/openchamber-litellm-usage/issues/10)).

## Confidence and caveats

**Confidence: high** for the mechanism, the field name, and the boundary rule — all
read directly from the v1.104.2 tag, with matching official docs.

Caveats / version notes:

- **Docs are for `main`, source is pinned to v1.104.2.** The `budget_reset_time`
  setting and the multi-window behavior are documented as recent additions; verify
  against the deployed version before relying on them.
- **`reset_at` is server-managed.** The write allow-list deliberately keeps
  `budget_reset_at` off the user-settable `LiteLLM_BudgetTable`, and the endpoints
  overwrite `reset_at` for every window on create/update, so a client cannot set a
  window's reset time ([`litellm/models/budget.py:16-36`](https://github.com/BerriAI/litellm/blob/v1.104.2/litellm/models/budget.py#L16-L36)).
- **Window start is approximate for calendar durations.** `get_budget_window_start`
  subtracts `duration_in_seconds("30d")` = 30×86400 s from `reset_at`, whereas the
  reset boundary is the 1st of the month. For `30d` those coincide only in months of
  30 days. Enforcement primarily trusts the per-window counter, which is reset by the
  job, so this mostly affects the stale-counter fallback aggregate, not the reset
  itself.
- **TZ handling in the job.** `_reset_expired_window` parses `reset_at` and then
  `.replace(tzinfo=None)` before comparing to `datetime.utcnow()`. With the default
  UTC config the stored value is `+00:00`, so this is consistent; a non-UTC
  `timezone` setting could make the naive comparison skew (untested here).
- **Teams vs keys.** `budget_limits_usage` (current spend) is key-only in v1.104.2;
  teams return `budget_limits` (with `reset_at`) but no usage map. The configured
  deployment key in #10 has no budgets, so none of these fields appear there today.
- **No separate `budget_reset_at` per window.** The per-window field is named
  `reset_at`; `budget_reset_at` is the key/team/user single-budget field. Don't
  confuse the two when parsing `/key/info`.
