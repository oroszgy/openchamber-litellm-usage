/**
 * The Work Status section frame.
 *
 * It runs only while the panel is shown and this section is expanded, so it
 * keeps no state it cannot rebuild: every mount re-reads everything on
 * `onReady`. The frame is its own document, so it paints the host theme onto
 * `documentElement` before rendering.
 */
import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.getElementById('root');

function line(className: string, text: string): void {
  if (!root) return;
  root.replaceChildren();
  const node = document.createElement('p');
  node.className = className;
  node.textContent = text;
  root.append(node);
}

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  // TODO: read LiteLLM usage through the service and render the section.
  line('llu-hint', 'LiteLLM usage: not wired yet.');
  void host.setHeight(64).catch(() => {
    // A host that refuses the height keeps its default; not a failure.
  });
});
