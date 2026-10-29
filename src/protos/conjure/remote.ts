/**
 * Remote text-to-3D (Meshy or Tripo) for Conjure.
 *
 * Two ways to reach a provider:
 *   1. A proxy that holds the keys (`api/gen3d.ts` on Vercel). Used when an
 *      endpoint is configured: VITE_GEN3D_ENDPOINT, the settings dialog, or
 *      same-origin `/api/gen3d` on *.vercel.app.
 *   2. Your own API key, entered in the settings dialog on the page. It is
 *      stored only in this browser and sent straight to the provider. This
 *      is what makes AI work on a static host such as GitHub Pages.
 *
 * Direct calls depend on the provider allowing browser (CORS) requests; if
 * one does not, the error says so and the proxy is the fallback.
 */

import { store } from '../../core/context.js';

export type Provider = 'meshy' | 'tripo';
export const PROVIDERS: Provider[] = ['meshy', 'tripo'];

export interface JobStatus {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  progress: number;
  modelUrl?: string;
  error?: string;
}

export interface Gen3DSettings {
  endpoint: string;
  keys: Partial<Record<Provider, string>>;
}

const SETTINGS_KEY = 'gen3d-settings-v1';

export function loadSettings(): Gen3DSettings {
  const saved = store.get<Gen3DSettings | null>(SETTINGS_KEY, null);
  return { endpoint: saved?.endpoint ?? store.get<string>('gen3d-endpoint', ''), keys: saved?.keys ?? {} };
}

export function saveSettings(settings: Gen3DSettings): void {
  store.set(SETTINGS_KEY, settings);
}

export function gen3dEndpoint(): string | null {
  const fromEnv = (import.meta.env.VITE_GEN3D_ENDPOINT as string | undefined)?.trim();
  if (fromEnv) return fromEnv;
  const fromSettings = loadSettings().endpoint.trim();
  if (fromSettings) return fromSettings;
  if (typeof location !== 'undefined' && location.hostname.endsWith('.vercel.app')) return '/api/gen3d';
  return null;
}

/** Providers you can use right now (through the proxy, or with your key). */
export function availableProviders(): Provider[] {
  if (gen3dEndpoint()) return PROVIDERS;
  const { keys } = loadSettings();
  return PROVIDERS.filter((p) => (keys[p] ?? '').trim().length > 0);
}

export async function startJob(provider: Provider, prompt: string): Promise<string> {
  const endpoint = gen3dEndpoint();
  if (endpoint) {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, prompt }) });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok || !body.id) throw new Error(body.error ?? `Generation request failed (${res.status})`);
    return body.id;
  }
  const key = requireKey(provider);
  if (provider === 'meshy') {
    const body = await direct<{ result?: string; message?: string }>('https://api.meshy.ai/openapi/v2/text-to-3d', key, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preview', prompt, should_remesh: true, topology: 'triangle', target_polycount: 30000 }),
    });
    if (!body.result) throw new Error(body.message ?? 'Meshy did not return a task id');
    return body.result;
  }
  const body = await direct<{ data?: { task_id?: string }; message?: string }>('https://api.tripo3d.ai/v2/openapi/task', key, {
    method: 'POST',
    body: JSON.stringify({ type: 'text_to_model', prompt }),
  });
  if (!body.data?.task_id) throw new Error(body.message ?? 'Tripo did not return a task id');
  return body.data.task_id;
}

export async function pollJob(provider: Provider, id: string): Promise<JobStatus> {
  const endpoint = gen3dEndpoint();
  if (endpoint) {
    const res = await fetch(`${endpoint}?provider=${provider}&id=${encodeURIComponent(id)}`);
    const body = (await res.json().catch(() => ({}))) as Partial<JobStatus> & { error?: string };
    if (!res.ok) return { status: 'failed', progress: 0, error: body.error ?? `Status check failed (${res.status})` };
    let modelUrl = body.modelUrl;
    if (modelUrl?.startsWith('?')) modelUrl = `${endpoint}${modelUrl}`;
    return { status: body.status ?? 'pending', progress: body.progress ?? 0, modelUrl, error: body.error };
  }
  const key = requireKey(provider);
  if (provider === 'meshy') {
    const t = await direct<{ status?: string; progress?: number; model_urls?: { glb?: string }; task_error?: { message?: string } }>(
      `https://api.meshy.ai/openapi/v2/text-to-3d/${encodeURIComponent(id)}`,
      key,
    );
    const status = t.status === 'SUCCEEDED' ? 'succeeded' : t.status === 'FAILED' || t.status === 'CANCELED' ? 'failed' : t.status === 'IN_PROGRESS' ? 'running' : 'pending';
    return { status, progress: (t.progress ?? 0) / 100, modelUrl: t.model_urls?.glb, error: t.task_error?.message || undefined };
  }
  const t = await direct<{ data?: { status?: string; progress?: number; output?: { model?: string; pbr_model?: string; base_model?: string } } }>(
    `https://api.tripo3d.ai/v2/openapi/task/${encodeURIComponent(id)}`,
    key,
  );
  const s = t.data?.status;
  const status = s === 'success' ? 'succeeded' : s === 'running' ? 'running' : s === 'queued' ? 'pending' : 'failed';
  const out = t.data?.output;
  return { status, progress: (t.data?.progress ?? 0) / 100, modelUrl: out?.pbr_model ?? out?.model ?? out?.base_model };
}

function requireKey(provider: Provider): string {
  const key = (loadSettings().keys[provider] ?? '').trim();
  if (!key) throw new Error(`no ${provider} key set (Settings on the page)`);
  return key;
}

async function direct<T>(url: string, key: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
  } catch {
    throw new Error('the provider blocked a direct browser request (CORS); use the proxy instead');
  }
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (res.status === 401 || res.status === 403) throw new Error('the API key was rejected');
  if (!res.ok) throw new Error(body.message ?? `request failed (${res.status})`);
  return body;
}
