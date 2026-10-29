# 4. Narrow to one key: rolling spend and key budget windows

- **Status**: Accepted
- **Date**: 2026-10-29
- **Supersedes**: the budget-row parts of the architecture spec
  ([#12](https://github.com/oroszgy/openchamber-litellm-usage/issues/12)),
  *Budget precedence: per-member team budgets*
  ([#13](https://github.com/oroszgy/openchamber-litellm-usage/issues/13)),
  *Reset derivation: per-window reset times for budget_limits*
  ([#14](https://github.com/oroszgy/openchamber-litellm-usage/issues/14)), and
  the lifetime-spend toggle.

## Context

The architecture spec grew to show **every** budget that applies to one virtual
key — key, member and team — with remaining budget, reset windows, soft budgets
and a tightest-remaining headline, plus a hidden lifetime-spend toggle and a row
set revealed by the frame's height. That is a lot of surface for a Work Status
readout.

The verified target key is **unbudgeted**: `/key/info` returns no `max_budget`,
`budget_duration` or `budget_limits`. The figures that answer "what am I
spending?" are the rolling day/week/month totals. The figure that answers "how
much of my quota is left?" only exists when the key itself carries a budget
window. Team and member budgets need another LiteLLM call and another set of
rows, and the target does not use them.

## Decision

The section reads **one virtual key on one proxy** and shows:

- **Rolling spend** — today, the last 7 days and the last 30 days, from
  `/user/daily/activity`, paginated and summed by date.
- **Key budget windows** — the key's own `max_budget` + `budget_duration` and
  each `budget_limits` entry, paired with
  `budget_limits_usage[duration].current_spend`. `24h`/`1d` maps to today,
  `7d` to the last 7 days, `30d`/`1mo` to the last 30 days; a `max_budget` with
  no duration is a separate total. Other durations are ignored. When both the
  legacy window and a `budget_limits` entry cover a period, the tighter one
  (the higher used percentage) is shown.

The section asks for three rows — **Today**, **Last 7 days** and **Last 30
days**. A row with a matching window shows the window's spend, its cap and the
used percentage; a row without one shows rolling spend. The percentage is a
whole number clamped to 0..100 and is toned at the native 50% / 80% thresholds.
A row with no data is omitted when rolling is unavailable.

**Not read or shown**: team and member budgets, remaining budget, reset
windows, soft budgets, per-model budgets, TPM/RPM limits, lifetime spend, and
the height-driven row set.

The **provider** is auto-discovered from OpenCode's config and confirmed by the
`/key/info` probe (ADR-0003). When more than one target is confirmed, a header
select picks one; the choice lives in `host.storage`. There is no settings page
and no in-panel picker.

The section follows the native Work Status row idiom: 28 px rows, 13 px text, a
muted label and a right-aligned tabular value, with no padding of its own beyond
the host's `mx-1`.

## Consequences

- The service needs one LiteLLM call for the key's windows (the discovery
  probe's `/key/info` read) and one paginated activity call; no `/team/info`.
- A user whose key is governed by a team or member budget sees their own key's
  spend and windows, but not the binding team/member quota. The section no
  longer claims to show the tightest remaining budget.
- A key with only a 5-hour or 12-hour window shows rolling spend, not a
  percentage. A `1mo` window is shown on the Last 30 days row as its current
  calendar-month cycle, not a trailing 30-day sum.
- The lifetime-spend toggle and its stored preference are gone. On the verified
  target `spend` (1907.99) and `total_spend` (392.05) disagree, so the old
  headline was not a trustworthy lifetime figure.
- The 30-day total is correct: the activity endpoint pages at roughly 15 days
  and can split one day across pages, so the service reads every page and sums
  the buckets by date.
- `GET /providers` returns confirmed targets only; unconfirmed candidates are
  logged locally rather than exposed to the sandboxed guest.
