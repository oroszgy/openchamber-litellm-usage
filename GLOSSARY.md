# LiteLLM Usage

The OpenChamber extension that shows one configured LiteLLM virtual key's spend
inside the chat's Work Status panel: rolling day/week/month totals, and the
key's own budget windows when it has them.

Team and member budgets, remaining budget, reset windows and soft budgets are
not part of the extension. The narrow scope is recorded in
[ADR-0004](docs/adr/0004-narrow-to-one-key-and-key-budget-windows.md).

## Language

**Spend**:
The amount spent in a period or in a budget window's current cycle.
_Avoid_: Usage, cost

**Rolling spend window**:
A trailing period — today, the last 7 days, the last 30 days, each a local
calendar day — over which spend is totalled for display. Distinct from a budget
window.
_Avoid_: Activity, report

**Budget window**:
A time-boxed spend cap on a virtual key that resets on its own schedule. Only
the key's own windows are shown.
_Avoid_: Rate limit, quota window

**Quota**:
The cap amount of a budget window, in USD.
_Avoid_: Limit, budget

**Quota used**:
The share of a budget window's quota spent in its current cycle, as a
percentage.
_Avoid_: Usage, burn

**Lifetime cap**:
A key's spend cap with no reset; a total, not a period. Shown as a separate
total row.
_Avoid_: Lifetime budget, total budget

**Unbudgeted key**:
A virtual key with neither a budget window nor a lifetime cap. Its section shows
rolling spend only.
_Avoid_: Unlimited key, no-limit key

**Virtual key**:
A LiteLLM-issued credential that identifies a caller and can read its own spend.
_Avoid_: Token, API key

**Provider**:
An entry in OpenCode's configuration naming a model endpoint; the extension
reads a LiteLLM provider's URL and key from it.
_Avoid_: Config, connection

**Candidate**:
A provider that might be a LiteLLM proxy, before a probe confirms it.
_Avoid_: Match, hit

**Target**:
A candidate a probe has confirmed is a LiteLLM proxy, together with the virtual
key used to read it.
_Avoid_: Endpoint, upstream

**Unconfirmed candidate**:
A candidate the probe did not confirm. The service keeps it out of the section
and logs the reason.
_Avoid_: Rejected provider, failed provider

**Management root**:
The proxy's management-API base: the provider's `baseURL` with a trailing `/v1`
removed.
_Avoid_: API root, base URL
