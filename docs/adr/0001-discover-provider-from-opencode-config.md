# 1. Discover the provider from OpenCode's config, not a credential form

- **Status**: Accepted — implemented. The recognition rule, source list and
  precedence below are corrected by
  [ADR-0003](0003-probe-gated-discovery.md); the selector surface is settled by
  [ADR-0004](0004-narrow-to-one-key-and-key-budget-windows.md).
- **Date**: 2026-10-09
- **Ticket**: [#2](https://github.com/oroszgy/openchamber-litellm-usage/issues/2)
- **Map**: [#1](https://github.com/oroszgy/openchamber-litellm-usage/issues/1)

## Context

The extension is a status-section-only guest: it has no settings page, no rail
panel and no `contributes.integration.settings`. The host spawns the local
service with **no host config and no secrets** — only
`OPENCHAMBER_SERVICE_PORT` / `OPENCHAMBER_SERVICE_TOKEN` — though the service runs
with the user's own rights and can reach the proxy directly. The guest cannot
reach the network except through the service.

So the proxy **base URL** and **virtual key** must come from somewhere, and three
channels were weighed:

- a section-rendered form → `host.storage` → forwarded per request (the key
  crosses the host proxy and is stored server-side);
- an extension-specific config file the service reads from disk (the key never
  leaves disk, but the user must create and place a file);
- `contributes.integration.settings` (needs the status+integration conflict
  resolved, and `apiOrigin` is a static origin, so a user-specific URL may not
  fit).

Separately, users who already call the proxy from OpenCode have its URL and key
configured in OpenCode's own provider config.

## Decision

**Auto-discover the provider from OpenCode's own configuration.** There is no
credential-entry form, no extension-specific config file and no environment
override.

Scan each source as `.json` **and** `.jsonc`, in precedence order — project
`<ctx.directory>/opencode.json(c)` > global
`$XDG_CONFIG_HOME/opencode/opencode.json(c)` (default `~/.config/opencode/`) >
OpenChamber managed `~/.config/openchamber/opencode.managed.json(c)`. The same
provider id in a more specific source wins; candidates dedupe by id.

Per provider, the base URL is `provider.<id>.options.baseURL`; the key is that
entry's `options.apiKey`, falling back to OpenCode's credential store
`$XDG_DATA_HOME/opencode/auth.json` (`<id>.key`, default
`~/.local/share/opencode/`). The **management root** is the base URL with a
trailing `/v1` stripped.

A candidate is **confirmed by a self-scoped `GET /key/info` probe** with its key;
its name only ranks the default (corrected by
[ADR-0003](0003-probe-gated-discovery.md)). The chosen provider id lives in
`host.storage` (instance scope) and is sent to the service on every request
together with `ctx.directory`, so the service can read project-level config.
Default when unset: the candidate with the least edit distance to the string
`litellm`. When nothing matches, the section shows a short hint pointing at the
OpenCode provider config.

The service re-reads the sources on every discovery; only the probe outcome is
cached, for 60 seconds. Any bearer key is accepted; a LiteLLM **virtual key**
(which can read only itself) is intended.

## Consequences

- **Zero-config** for the common case: a user who already calls the proxy from
  OpenCode gets the section working with no new credential entry.
- The service **reads another application's credential file at rest**
  (`auth.json`, or an inline `apiKey` in `opencode.json`). This does not widen the
  existing local trust boundary — any process running as the user can already
  read those files — but it couples the extension to OpenCode's config layout and
  credential-store format, which may change between releases.
- Discovery is a **probe-gated static list**: a proxy that answers `/key/info`
  but wants a non-bearer scheme is not offered. A failing probe hides the
  candidate rather than surfacing a partial one.
- Offering a proxy that OpenCode is not configured for requires adding it to
  OpenCode's config first.
- The provider selector is the only user choice. It is a host-rendered header
  select, shown when more than one target is confirmed and hidden when there is
  one; there is no in-panel fallback. See
  [ADR-0004](0004-narrow-to-one-key-and-key-budget-windows.md).

## Implementation note (2026-10-29)

The decision is implemented:

- The `/key/info` probe runs at discovery, so `GET /providers` returns confirmed
  targets only ([ADR-0003](0003-probe-gated-discovery.md)).
- The picker is a `setStatusControls` select beside the section title, persisted
  in `host.storage` under `litellm-usage:provider`. A stored id that no longer
  resolves falls back to the nearest-`litellm` default. On a host that does not
  advertise `features.statusControls`, the picker is hidden and the default is
  used.
