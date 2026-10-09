# Multi-cap rows prototype — throwaway

Not the extension. It answers [#13](https://github.com/oroszgy/openchamber-litellm-usage/issues/13):
with the key, member and team budgets all enforced at once, **what should the
LiteLLM Usage section look like**, and what is the "tightest remaining" headline?

Data mirrors a proposed `/usage` schema: a single **`headline`** (the
least-remaining cap, or `unlimited`) plus **`caps[]`**, one entry per enforced
budget:

```json
{ "source": "key" | "member" | "team", "duration": "30d",
  "cap": 50, "spend": 12.5, "remaining": 37.5,
  "resetsAt": "…", "resetDerived": false,
  "softBudget": { "limit": 35, "exceeded": false } }
```

## Variants

- **A — Ledger**: the native flat-row idiom, one row per enforced budget
  (`Key balance · 30d · resets … · $12.50 / $50.00`), ordered key → member → team.
- **B — Meters**: one spend/cap progress meter per cap, with the remaining left.
- **C — Tight**: headline-first — the binding cap big, the others as compact pills.

## Run

```sh
bun run prototype:layout      # → http://localhost:5174/
```

(Or just open `index.html` in a browser.)

## Controls

- **Variant** — floating bar (`←` / `→`) or `?variant=A|B|C`.
- **Prototype panel (top-left)** — theme, frame height (24..320), panel width,
  state (normal / key-only / member+team / exhausted / soft / unlimited /
  degraded / loading / no provider / fatal error), and the selector surface.

All axes are reflected in the URL, so any view is shareable.

## Height behaviour

Rows are revealed by the frame's own height via CSS container queries: ≤34 px
keeps the provider row + headline; ~60 px adds the primary cap; taller reveals
the other caps; the `Rolling spend` expander grows the frame.

## Notes

- Throwaway. Variants and the switcher never merge; only the validated decision
  lands in `main`.
- Prototype chrome (controls, switcher, dashed clamp) is not part of the design.
