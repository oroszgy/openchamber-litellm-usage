/**
 * The Work Status section's wiring: ask the service for the candidate providers
 * and the chosen one's usage, then render. Kept apart from `main.ts` so tests
 * can drive it with a stub host.
 */
import type { HostClient } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { buildView, type Usage } from './view-model.ts';

export type GuestHost = Pick<HostClient, 'onReady' | 'onDirectory' | 'serviceRequest' | 'setHeight'>;

type ProvidersResponse = { providers: Array<{ id: string; name: string; host: string }>; default: string | null };

export function start(host: GuestHost, root: HTMLElement): void {
  let directory: string | null = null;
  let generation = 0;

  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    directory = ctx.directory;
    void load();
  });

  host.onDirectory((next) => {
    directory = next;
    void load();
  });

  async function load(): Promise<void> {
    const mine = (generation += 1);
    showLoading();
    try {
      const providers = JSON.parse((await request('/providers')).body) as ProvidersResponse;
      if (mine !== generation) return;
      if (!providers.default) {
        showNoProvider();
        return;
      }
      const usage = JSON.parse((await request('/usage', { provider: providers.default })).body) as Usage;
      if (mine !== generation) return;
      showUsage(usage);
    } catch (cause) {
      if (mine !== generation) return;
      showError(cause);
    }
  }

  async function request(path: string, extra?: Record<string, string>): Promise<{ status: number; body: string }> {
    const query: Record<string, string> = { ...extra };
    if (directory) query.directory = directory;
    const answer = await host.serviceRequest({
      method: 'GET',
      path,
      ...(Object.keys(query).length > 0 ? { query } : {}),
    });
    if (answer.status >= 400) {
      const parsed = safeParse(answer.body) as { error?: { message?: string } } | null;
      throw new Error(parsed?.error?.message ?? `The service returned ${answer.status}.`);
    }
    return answer;
  }

  function showLoading(): void {
    root.replaceChildren(line('llu-hint', 'Loading LiteLLM usage…'));
    setHeight(48);
  }

  function showNoProvider(): void {
    root.replaceChildren(
      line('llu-line', 'No LiteLLM provider found'),
      line('llu-hint', 'Add a LiteLLM provider to OpenCode’s config, then reopen this section.'),
    );
    setHeight(64);
  }

  function showUsage(usage: Usage): void {
    const view = buildView(usage, new Date(usage.asOf), 'UTC');
    const nodes: Node[] = [line('llu-provider', view.provider), line('llu-headline', view.headline)];

    if (view.rolling.length > 0) {
      const details = document.createElement('details');
      details.className = 'llu-rolling';
      const summary = document.createElement('summary');
      summary.textContent = 'Rolling spend';
      details.append(summary);
      for (const row of view.rolling) {
        const item = document.createElement('p');
        item.className = 'llu-row';
        const label = document.createElement('span');
        label.textContent = row.label;
        const value = document.createElement('span');
        value.textContent = row.value;
        item.append(label, value);
        details.append(item);
      }
      nodes.push(details);
    }

    if (view.degraded) nodes.push(line('llu-hint', view.degraded));
    root.replaceChildren(...nodes);
    setHeight(root.scrollHeight || 72);
  }

  function showError(cause: unknown): void {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'llu-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => void load());
    root.replaceChildren(line('llu-error', cause instanceof Error ? cause.message : String(cause)), retry);
    setHeight(64);
  }

  function setHeight(desired: number): void {
    const height = Math.min(320, Math.max(24, desired));
    void host.setHeight(height).catch(() => {
      // A host that refuses the height keeps its default; not a failure.
    });
  }
}

function line(className: string, text: string): HTMLParagraphElement {
  const node = document.createElement('p');
  node.className = className;
  node.textContent = text;
  return node;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
