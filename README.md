# openchamber-litellm-usage

An [OpenChamber](https://openchamber.dev) extension that shows your self-hosted
[LiteLLM](https://docs.litellm.ai) proxy's usage and credits balance inside the
chat's **Work Status** panel (the same panel that lists Context, Project, Usage,
Turn stats, MCP and other sections).

It adds one **LiteLLM Usage** section there — no rail panel, no toolbar icon.

## What it shows

- Credits balance / remaining budget for the key or user you point it at.
- Spend and, when a budget is set, the reset window.
- Optional per-model and per-day breakdown.

Data comes from the LiteLLM proxy's own management API (`/key/info`,
`/user/info`, `/user/daily/activity`, ...), fetched by a local service so the
proxy key never reaches the sandboxed page.

## Status

Scaffold. The manifest, the status frame and the service shell exist; the actual
LiteLLM calls and rendering are still to be built.

## Development

```sh
bun install
bun run check   # typecheck + build
bun test
```

`status/main.ts` and `service/main.ts` are bundled into `status/main.js` and
`service/main.js` by `openchamber-guest-bundle` (OpenChamber never compiles an
extension). Install the folder from **Settings → Extensions**.

## License

MIT
