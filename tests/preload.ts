/**
 * Test preload: register a DOM for the guest tests and pin a time zone so date
 * formatting is deterministic.
 *
 * `GlobalRegistrator.register()` also replaces the global `fetch`, `AbortSignal`
 * and `AbortController` with happy-dom's; the service tests drive real
 * `node:http` servers and pass abort signals to the native `fetch`, which
 * rejects a foreign `AbortSignal`, so the native ones are restored.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

process.env.TZ = 'UTC';
const nativeFetch = globalThis.fetch;
const nativeAbortSignal = globalThis.AbortSignal;
const nativeAbortController = globalThis.AbortController;

GlobalRegistrator.register();

globalThis.fetch = nativeFetch;
globalThis.AbortSignal = nativeAbortSignal;
globalThis.AbortController = nativeAbortController;
