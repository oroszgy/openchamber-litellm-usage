# LiteLLM Usage

The OpenChamber extension that shows the budgets applying to one configured
LiteLLM virtual key — their spend and reset windows — inside the chat's Work
Status panel.

## Language

**Remaining budget**:
The amount left in a budget: `max_budget − spend`, never shown negative. Every
enforced budget has its own.
_Avoid_: Credits, balance

**Spend**:
The amount spent within a budget's current window. Resets when the budget window
resets.
_Avoid_: Usage, cost

**Lifetime spend**:
The total amount spent over the key's whole life; it never resets.
_Avoid_: Total spend, total usage

**Budget window**:
The period a budget resets over, given by its duration and ending at the next
reset time.
_Avoid_: Period, cycle

**Key budget**:
The budget set on the virtual key itself.
_Avoid_: Key limit, personal budget

**Member budget**:
The budget set on a user's team membership, shared by every virtual key that user
holds in the team.
_Avoid_: User budget, personal budget

**Team budget**:
The budget set on the team.
_Avoid_: Group budget

**Enforced budget**:
A budget that applies to the virtual key's requests. LiteLLM enforces every
applicable key, member and team budget at once — any exhausted one blocks the
request.
_Avoid_: Active budget, applicable budget

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
