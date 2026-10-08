# Layout prototype — throwaway

Not the extension. It answers [#7](https://github.com/oroszgy/openchamber-litellm-usage/issues/7):
what should the LiteLLM Usage Work Status section look like inside its
**24..320 px height** clamp, across states, and where should the provider
selector live?

The target look is the OpenChamber **Usage** panel (screenshot supplied
2026-10-08): a provider row, then window rows of
`label · reset-date · right-aligned value` (e.g. OpenCode Go's
`Weekly  Mon, Oct 12, 02:00  28%`).

## The decision

Variant **B (Native + expand)** is the chosen design:

- one provider row (`LiteLLM`), a header **selector + refresh** (in-panel
  fallback on hosts without `features.statusControls`);
- one row per budget window: `<duration>  <reset date>  $spend / $cap`;
- a `Credits balance` row: `$remaining left`;
- rolling totals behind a `Rolling spend` expander (opening it grows the frame,
  as the real guest would `setHeight`).

## Variants

- **A — Native**: same rows, rolling inline (for comparison).
- **B — Native + expand**: the decision (rolling behind the expander).
- **C — Strip**: compact single-strip fallback for the 24 px floor.

## Run

```sh
bun run prototype:layout      # → http://localhost:5174/
```

(Or just open `index.html` in a browser.)

## Controls

- **Variant** — the floating bar at the bottom, `←` / `→`, or `?variant=A|B|C`.
- **Prototype panel (top-left)** — theme, frame height (24..320), panel width,
  state (normal / exhausted / unbudgeted / degraded / loading / no provider /
  fatal error), and the selector surface (header control vs in-panel select).

All axes are reflected in the URL, so any view is shareable.

## Height behaviour

Rows are revealed by the frame's own height (CSS container queries), not by an
interaction:

| frame height | shown |
| --- | --- |
| ≤ 34 px | provider row + headline (`$37.50 left`) |
| ~ 60 px | + the primary window row |
| > 96 px | + the other window rows |
| > 96 px | + `Credits balance` and the `Rolling spend` expander |

## Notes

- Data mirrors the normalised `/usage` schema from
  [#5](https://github.com/oroszgy/openchamber-litellm-usage/issues/5); USD is two
  decimals, four under `$1`, and reset dates use the native format
  (`Thu, Nov 5, 14:50`, or time-only when the reset is today).
- The dashed outline marks the frame's height clamp; turn it off to judge the
  design. Prototype chrome (controls, switcher, outline) is not part of the design.
