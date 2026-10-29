/**
 * The Work Status section's wiring: ask the service for the confirmed providers
 * and the chosen one's usage, then render. Kept apart from `main.ts` so tests
 * can drive it with a stub host.
 *
 * The section draws three rows — Today, Last 7 days, Last 30 days — with a key
 * budget window's percentage where one matches. The provider picker is a
 * host-rendered header select, shown only when more than one target is
 * confirmed and remembered per server.
 *
 * The host re-pushes `ready` when the session or theme changes, and the SDK
 * replays it to `onReady` *and* `onDirectory`. A read already on screen is kept
 * until the next one lands — a refresh never blanks the figures or resizes the
 * frame — and a burst of pushes collapses into one request.
 */
import type { HostClient } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { buildView, type ViewRow } from './view-model.ts';
import type { ProviderRef, ProvidersResponse, UsageResponse } from '../shared/wire.ts';

export type GuestHost = Pick<
  HostClient,
  'onReady' | 'onDirectory' | 'serviceRequest' | 'setHeight' | 'storage' | 'onStatusControl' | 'setStatusControls'
>;

const PROVIDER_KEY = 'litellm-usage:provider';
const PROVIDER_CONTROL = 'litellm-provider';

export function start(host: GuestHost, root: HTMLElement): void {
  let directory: string | null = null;
  let generation = 0;
  let started = false;
  /**
   * The directory whose outcome is painted on screen. A repeated `ready`
   * replays the same directory, so this is what lets a refresh keep the
   * figures instead of blanking them.
   */
  let paintedDirectory: string | null | undefined;
  let inFlight = false;
  let queued = false;
  let lastHeight = 0;
  let features: { statusControls?: true } | undefined;
  let knownProviders: ProviderRef[] = [];
  let chosen: string | null = null;

  host.onStatusControl((event) => {
    if (event.id !== PROVIDER_CONTROL || typeof event.value !== 'string') return;
    void chooseProvider(event.value);
  });

  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    directory = ctx.directory;
    // Keep the last advertised capabilities: a theme-only snapshot may omit them.
    if (ctx.features) features = ctx.features;
    if (started) {
      requestRefresh();
      return;
    }
    started = true;
    requestRefresh();
  });

  host.onDirectory((next) => {
    // A `ready` replays the directory too, and `onReady` has already set it;
    // only a genuine project change gets past this.
    if (next === directory) return;
    directory = next;
    requestRefresh();
  });

  /**
   * Re-read unless one is already running; queue a single follow-up so a burst
   * of host pushes collapses into one extra request.
   */
  function requestRefresh(): void {
    if (inFlight) {
      queued = true;
      return;
    }
    void load();
  }

  async function load(): Promise<void> {
    const mine = (generation += 1);
    const target = directory;
    inFlight = true;
    // Blank only when nothing current is on screen for this directory; a live
    // refresh keeps the figures until the new ones arrive.
    if (paintedDirectory !== target) showLoading();
    try {
      const providers = JSON.parse((await request('/providers', undefined, target)).body) as ProvidersResponse;
      if (mine !== generation) return;
      knownProviders = providers.providers;
      chosen = await resolveProvider(providers);
      await publishControls();
      if (mine !== generation) return;
      if (!chosen) {
        showNoProvider();
        paintedDirectory = target;
        return;
      }
      const usage = JSON.parse(
        (await request('/usage', { provider: chosen }, target)).body,
      ) as UsageResponse;
      if (mine !== generation) return;
      showUsage(usage);
      paintedDirectory = target;
    } catch (cause) {
      if (mine !== generation) return;
      // A failed refresh keeps the last figures; only an empty view shows it.
      if (paintedDirectory === target) return;
      showError(cause);
      paintedDirectory = target;
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void load();
      }
    }
  }

  async function resolveProvider(providers: ProvidersResponse): Promise<string | null> {
    const stored = await host.storage.get(PROVIDER_KEY).catch(() => undefined);
    const storedId = typeof stored === 'string' ? stored : null;
    if (storedId && providers.providers.some((provider) => provider.id === storedId)) return storedId;
    if (providers.default && providers.providers.some((provider) => provider.id === providers.default)) {
      return providers.default;
    }
    return providers.providers[0]?.id ?? null;
  }

  async function chooseProvider(id: string): Promise<void> {
    if (id === chosen) return;
    if (!knownProviders.some((provider) => provider.id === id)) return;
    chosen = id;
    // Invalidate a read already in flight for the previous choice.
    generation += 1;
    await host.storage.set(PROVIDER_KEY, id).catch(() => {
      // A preference that cannot be saved is not a failure of the section.
    });
    await publishControls();
    requestRefresh();
  }

  async function publishControls(): Promise<void> {
    if (features?.statusControls !== true) return;
    const controls =
      knownProviders.length > 1 && chosen
        ? [
            {
              kind: 'select' as const,
              id: PROVIDER_CONTROL,
              label: 'Provider',
              value: chosen,
              options: knownProviders.slice(0, 16).map((provider) => ({
                value: provider.id,
                label: (provider.name || provider.id).slice(0, 60),
              })),
            },
          ]
        : [];
    try {
      await host.setStatusControls(controls);
    } catch {
      // A host that does not accept controls keeps the default; not a failure.
    }
  }

  async function request(
    path: string,
    extra: Record<string, string> | undefined,
    forDirectory: string | null,
  ): Promise<{ status: number; body: string }> {
    const query: Record<string, string> = { ...extra };
    if (forDirectory) query.directory = forDirectory;
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
    setHeight(28);
  }

  function showNoProvider(): void {
    root.replaceChildren(
      line('llu-line', 'No LiteLLM provider found'),
      line('llu-hint', 'Add a LiteLLM provider to OpenCode’s config.'),
    );
    setHeight(56);
  }

  function showUsage(usage: UsageResponse): void {
    const view = buildView(usage);
    const nodes: Node[] = view.rows.map(rowLine);
    if (view.notice) nodes.push(line('llu-hint', view.notice));
    if (nodes.length === 0) nodes.push(line('llu-hint', 'No spend data.'));
    root.replaceChildren(...nodes);
    setHeight(Math.max(1, view.rows.length + (view.notice ? 1 : 0)) * 28);
  }

  function showError(cause: unknown): void {
    root.replaceChildren(
      line('llu-error', cause instanceof Error ? cause.message : String(cause)),
      actionButton('llu-retry', 'Retry', () => retry()),
    );
    setHeight(56);
  }

  /** Retry is a fresh start: blank to the loading line so it reads as work. */
  function retry(): void {
    paintedDirectory = undefined;
    requestRefresh();
  }

  function setHeight(desired: number): void {
    const height = Math.min(320, Math.max(24, desired));
    if (height === lastHeight) return;
    lastHeight = height;
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

/** A section-styled action control; the flex column must not stretch it. */
function actionButton(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function rowLine(row: ViewRow): HTMLParagraphElement {
  const item = document.createElement('p');
  item.className = 'llu-row';
  const label = document.createElement('span');
  label.className = 'llu-label';
  label.textContent = row.label;
  if (row.detail) {
    const detail = document.createElement('span');
    detail.className = 'llu-detail';
    detail.textContent = ` ${row.detail}`;
    label.append(detail);
  }
  const value = document.createElement('span');
  value.className = 'llu-value';
  value.textContent = row.value;
  if (row.tone) value.dataset.tone = row.tone;
  item.append(label, value);
  return item;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
