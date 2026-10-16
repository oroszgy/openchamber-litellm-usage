# LiteLLM Usage

The OpenChamber extension that shows one configured LiteLLM virtual key's spend —
lifetime and rolling — inside the chat's Work Status panel.

Budget, remaining and reset-window vocabulary is not part of what ships yet; its
design lives in the [architecture spec](https://github.com/oroszgy/openchamber-litellm-usage/issues/12).

## Language

**Spend**:
The amount spent within a budget's current window. Resets when the budget window
resets. Shown as the section's spend figure when the key carries a
`budget_duration`.
_Avoid_: Usage, cost

**Lifetime spend**:
The total amount spent over the key's whole life; it never resets. Shown as the
section's spend figure when the key has no `budget_duration`.
_Avoid_: Total spend, total usage

**Rolling spend window**:
A trailing period — today, the last 7 days, the last 30 days, each a local
calendar day — over which spend is totalled for display. Distinct from a budget
window.
_Avoid_: Activity, report

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
A candidate the probe did not confirm; the probe's reason travels with it.
_Avoid_: Rejected provider, failed provider

**Management root**:
The proxy's management-API base: the provider's `baseURL` with a trailing `/v1`
removed.
_Avoid_: API root, base URL
