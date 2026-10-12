/**
 * The Work Status section frame entry.
 *
 * Runs only while the panel is shown and this section is expanded, so it keeps
 * no state it cannot rebuild: `start` re-reads everything on `onReady`. The
 * frame is its own document, so the host theme is painted onto
 * `documentElement` before rendering.
 */
import { connectHost } from '@openchamber/sdk';
import { start } from './app.ts';

const host = connectHost();
const root = document.getElementById('root');

if (root) start(host, root);
