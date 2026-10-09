/**
 * Test preload: register a DOM for the guest tests and pin a time zone so date
 * formatting is deterministic.
 *
 * `GlobalRegistrator.register()` also replaces the global `fetch` with
 * happy-dom's same-origin-enforcing one; the service tests drive real
 * `node:http` servers, so the native fetch is restored.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

process.env.TZ = 'UTC';
const nativeFetch = globalThis.fetch;

GlobalRegistrator.register();

globalThis.fetch = nativeFetch;
