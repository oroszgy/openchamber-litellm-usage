# LiteLLM Usage

The OpenChamber extension that shows one configured LiteLLM proxy key's budget,
spend and reset window inside the chat's Work Status panel.

## Language

**Remaining budget**:
The amount left in the key's current budget window, `max_budget − spend`. Never
shown negative.
_Avoid_: Credits, balance

**Spend**:
The amount spent within the key's current budget window. Resets when the budget
window resets.
_Avoid_: Usage, cost

**Lifetime spend**:
The total amount spent over the key's whole life; it never resets.
_Avoid_: Total spend, total usage

**Budget window**:
The period a budget resets over, given by its duration and ending at the next
reset time.
_Avoid_: Period, cycle

**Soft budget**:
An advisory spending threshold that raises an alert but never blocks.
_Avoid_: Warning budget, limit

**Rolling spend window**:
A trailing period — today, the last 7 days, the last 30 days, each a local
calendar day — over which spend is totalled for display. Distinct from the budget
window.
_Avoid_: Activity, report

**Virtual key**:
A LiteLLM-issued credential that identifies a caller and can read its own budget
and spend.
_Avoid_: Token, API key

**Provider**:
An entry in OpenCode's configuration naming a model endpoint; the extension
reads a LiteLLM provider's URL and key from it.
_Avoid_: Config, connection
