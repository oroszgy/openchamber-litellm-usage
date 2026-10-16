/**
 * The Work Status section's wiring: ask the service for the candidate providers
 * and the chosen one's usage, then render. Kept apart from `main.ts` so tests
 * can drive it with a stub host.
 *
 * Rolling spend is always shown; the key's spend figure sits behind a toggle
 * whose choice is remembered per server (`host.storage`).
 *
 * The host re-pushes `ready` when the session or theme changes, and the SDK
 * replays it to `onReady` *and* `onDirectory`. A read already on screen is kept
 * until the next one lands — a refresh never blanks the figures or resizes the
 * frame — and a burst of pushes collapses into one request.
 */
import type { HostClient } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { buildView, unconfirmedLines, type ViewRow } from './view-model.ts';
import type { ProvidersResponse, UnconfirmedRef, UsageResponse } from '../shared/wire.ts';

export type GuestHost = Pick<
  HostClient,
  'onReady' | 'onDirectory' | 'serviceRequest' | 'setHeight' | 'storage'
>;

const SHOW_SPEND_KEY = 'litellm-usage:show-spend';

export function start(host: GuestHost, root: HTMLElement): void {
  let directory: string | null = null;
  let generation = 0;
  let showSpend = false;
  let current: UsageResponse | null = null;
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

  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    directory = ctx.directory;
    if (started) {
      requestRefresh();
      return;
    }
    started = true;
    void begin();
  });

  host.onDirectory((next) => {
    // A `ready` replays the directory too, and `onReady` has already set it;
    // only a genuine project change gets past this.
    if (next === directory) return;
    directory = next;
    requestRefresh();
  });

  async function begin(): Promise<void> {
    await readPreference();
    requestRefresh();
  }

  async function readPreference(): Promise<void> {
    try {
      showSpend = (await host.storage.get(SHOW_SPEND_KEY)) === true;
    } catch {
      showSpend = false;
    }
  }

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
      if (!providers.default) {
        showNoProvider(providers.rejected ?? []);
        paintedDirectory = target;
        return;
      }
      const usage = JSON.parse(
        (await request('/usage', { provider: providers.default }, target)).body,
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
    setHeight(48);
  }

  function showNoProvider(rejected: UnconfirmedRef[]): void {
    const notes = unconfirmedLines(rejected);
    const nodes: Node[] = [line('llu-line', 'No LiteLLM provider found')];
    for (const note of notes) nodes.push(line('llu-hint', note));
    nodes.push(line('llu-hint', 'Add a LiteLLM provider to OpenCode’s config, then reopen this section.'));
    root.replaceChildren(...nodes);
    setHeight(notes.length > 0 ? 64 + notes.length * 16 : 64);
  }

  function showUsage(usage: UsageResponse): void {
    current = usage;
    const view = buildView(usage);
    const nodes: Node[] = [];

    if (view.rolling.length > 0) {
      for (const row of view.rolling) nodes.push(rowLine(row));
    } else if (view.degraded) {
      nodes.push(line('llu-hint', view.degraded));
    }

    if (showSpend) nodes.push(rowLine({ label: view.spendLabel, value: view.spendValue }));

    const label = showSpend ? 'Hide spend' : 'Show spend';
    nodes.push(actionButton('llu-toggle', label, () => void toggleSpend()));

    root.replaceChildren(...nodes);
    setHeight(root.scrollHeight || 72);
  }

  async function toggleSpend(): Promise<void> {
    showSpend = !showSpend;
    if (current) showUsage(current);
    try {
      await host.storage.set(SHOW_SPEND_KEY, showSpend);
    } catch {
      // A preference that cannot be saved is not a failure of the section.
    }
  }

  function showError(cause: unknown): void {
    root.replaceChildren(
      line('llu-error', cause instanceof Error ? cause.message : String(cause)),
      actionButton('llu-retry', 'Retry', () => retry()),
    );
    setHeight(64);
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
  label.textContent = row.label;
  const value = document.createElement('span');
  value.textContent = row.value;
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
