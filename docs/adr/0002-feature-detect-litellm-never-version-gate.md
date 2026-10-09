# 2. Feature-detect LiteLLM capabilities, never gate on version

- **Status**: Accepted
- **Date**: 2026-10-09
- **Ticket**: [#8](https://github.com/oroszgy/openchamber-litellm-usage/issues/8)
- **Map**: [#1](https://github.com/oroszgy/openchamber-litellm-usage/issues/1)

## Context

LiteLLM moves fields between releases. On the verified target
(**LiteLLM `1.104.2`**) the key's `spend` (`1536.61`) and `total_spend`
(`20.66`) already diverge and neither matches its activity sum; `soft_budget` is
nested under `litellm_budget_table` rather than top-level; and `total_spend`
itself only exists since v1.103.0 and is **not backfilled**. A `budget_duration`
may or may not be set, so `spend` is sometimes a current-window figure and
sometimes a lifetime one.

Two strategies were available: **gate** on a known-good version range (reject
anything outside it), or **detect** the fields actually present and degrade
per field. A gate would reject proxies that work, and would need maintenance on
every LiteLLM release.

## Decision

The service **reads exactly the fields the section renders and degrades per
missing field**. It never parses or compares LiteLLM versions.
`GET /openapi.json` → `info.version` may be read best-effort **only** to name the
proxy in a diagnostic message.

**Required** — the presence test for "is this a LiteLLM key endpoint":

- `info.spend` (a number). Absent, or no readable `info` at all, means the proxy
  is unsupported → fatal `unsupported_proxy`.

**Optional** — each omitted rather than nulled, and its absence handled, not
fatal:

| field | absent ⇒ |
| --- | --- |
| `info.max_budget` | `balance.kind: "unlimited"` (unbudgeted) |
| `info.budget_reset_at` | `window` omitted |
| `info.litellm_budget_table.soft_budget` | `softBudget` omitted |
| `budget_limits` | `budgetWindows` omitted |
| `info.user_id` | no rolling attempt → `rolling_unavailable` |
| `info.team_id` | present ⇒ team fallback; `/team/info` failure ⇒ `team_lookup_failed` degraded |

`info.total_spend` is **never read**, so the target's divergence is inert.

**Fatal vs degraded for `/key/info`:** 401/403 → `unauthorized` (502); 404 or an
unreadable shape → `unsupported_proxy` (502); unreachable/timeout →
`provider_unreachable` (502). A failing rolling source
(`/user/daily/activity` 403/404/500, database off, no `user_id`) is **never
fatal** — it degrades to `rolling_unavailable` on a 200.

There is no version or shape gate at config discovery; the `/key/info` probe
confirmed by [#2](https://github.com/oroszgy/openchamber-litellm-usage/issues/2)
establishes only that a candidate is LiteLLM-shaped.

## Consequences

- Works across LiteLLM releases without release-tracking upkeep, and keeps
  working on a database-less or partially-featured proxy.
- Compatibility bugs surface at **read time** as a precise code
  (`unauthorized` / `unsupported_proxy` / `provider_unreachable`) rather than
  being hidden behind a vague "no provider" hint at discovery time.
- More per-field branching in the service than a version check would need.
- A proxy that answers `/key/info` with an unexpected shape is treated as
  unsupported rather than partially rendered — the required-field contract is
  the only hard gate.
