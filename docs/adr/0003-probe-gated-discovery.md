# 3. Probe-gated discovery: a candidate is a target only if `/key/info` confirms it

- **Status**: Accepted — amended 2026-10-29 (confirmed targets only; see
  [ADR-0004](0004-narrow-to-one-key-and-key-budget-windows.md)).
- **Date**: 2026-10-16
- **Supersedes**: ADR-0002's consequence *"no version or shape gate at config
  discovery"*; corrects the "static list" note in ADR-0001.

## Context

Users add a LiteLLM provider through **OpenChamber's own UI**, which writes
OpenCode's configuration, not the extension's. Which file that lands in depends
on the scope chosen there:

- **user** — `<config-dir>/opencode.json(c)`, `$OPENCODE_CONFIG_DIR` else
  `$XDG_CONFIG_HOME/opencode`;
- **project** — `<project>/opencode.json(c)` or, for a new file,
  `<project>/.opencode/opencode.json(c)`;
- **custom** — the file named by `$OPENCODE_CONFIG`.

The extension previously read only the project root, the global config and a
hard-coded managed file, so a UI-added provider in `.opencode/` or in
`OPENCODE_CONFIG` was invisible; a key written as `{env:NAME}` or `{file:path}`
was used as a literal; and OpenCode's real merge order — `user < project <
OPENCODE_CONFIG`, so a custom/managed entry **wins** — was inverted. Separately,
a candidate was recognised by the substring `litellm` in its id or name, so a
single typo hid a perfectly working proxy.

ADR-0001 already named the probe as the recogniser; only the read-time half was
built.

## Decision

**Recognition is the probe.** Any provider with a base URL is a **candidate**;
name similarity only ranks the default. Every candidate is probed at
`GET <management-root>/key/info` in parallel — a 2 s deadline, and the outcome
(success or failure) cached for 60 s per management root and key. A candidate
whose probe returns the LiteLLM shape is a **target**; every other is an
**unconfirmed candidate**, logged with the reason (`unauthorized`,
`unsupported_proxy`, `provider_unreachable`, `upstream_error`, `no_key`).

Sources are read as OpenCode reads them: the global, project (root **and**
`.opencode/`) and `$OPENCODE_CONFIG` (else the managed file) layers, in
OpenCode's precedence. `options.apiKey` (or `settings.apiKey`) has its
`{env:}`/`{file:}` references resolved, falling back to `auth.json`.

`GET /providers` returns the confirmed targets and the default, and no
unconfirmed candidates (amended 2026-10-29); `GET /usage` re-uses the probe's
read instead of calling `/key/info` again.

## Consequences

- A UI-added provider is found wherever OpenChamber put it, and a typo'd name no
  longer hides it.
- **Read-time precision moves to discovery.** `unauthorized`,
  `unsupported_proxy` and `provider_unreachable` no longer arise on `/usage`
  (which only ever receives a confirmed id); they describe an unconfirmed
  candidate in the service log. A proxy that is down reads as *"No LiteLLM
  provider found"* plus a configuration hint, not as a fatal
  `provider_unreachable`. This is the trade ADR-0002 argued against; it is taken
  deliberately, for typo tolerance.
- `/providers` is **no longer a static list**: it probes, so it can take up to
  the probe deadline on a cold cache.
- Unconfirmed candidates stay in the service. Their id, name and host are not
  returned to the sandboxed guest, and their keys are never returned at all.
- A proxy that answers `/key/info` badly is hidden from the selector rather than
  offered and failed at read time.

## Amendment (2026-10-29)

The narrow scope in
[ADR-0004](0004-narrow-to-one-key-and-key-budget-windows.md) drops the
unconfirmed-candidate list from `GET /providers`. The probe still uses the
reason internally and logs it; the section shows one hint when nothing is
confirmed. This removes the host disclosure the original consequence accepted.
