/**
 * Client for remote text-to-3D (Meshy or Tripo) through our own proxy.
 *
 * API keys must never ship in a web page, so the browser talks to
 * `api/gen3d.ts` (a serverless function deployed next to the app), which
 * holds the keys, starts the job, reports progress and streams the GLB back.
 *
 * The endpoint comes from, in order: VITE_GEN3D_ENDPOINT at build time, the
 * `gen3d-endpoint` localStorage key, or same-origin `/api/gen3d` when the app
 * itself is hosted on Vercel.
 */

import { store } from '../../core/context.js';

export type Provider = 'meshy' | 'tripo';

export interface JobStatus {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  progress: number;
  /** Proxied GLB URL once succeeded. */
  modelUrl?: string;
  error?: string;
}

export function gen3dEndpoint(): string | null {
  const fromEnv = (import.meta.env.VITE_GEN3D_ENDPOINT as string | undefined)?.trim();
  if (fromEnv) return fromEnv;
  const fromStore = store.get<string | null>('gen3d-endpoint', null);
  if (fromStore) return fromStore;
  if (typeof location !== 'undefined' && location.hostname.endsWith('.vercel.app')) return '/api/gen3d';
  return null;
}

export async function startJob(endpoint: string, provider: Provider, prompt: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, prompt }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `Generation request failed (${res.status})`);
  return body.id;
}

export async function pollJob(endpoint: string, provider: Provider, id: string): Promise<JobStatus> {
  const url = `${endpoint}?provider=${provider}&id=${encodeURIComponent(id)}`;
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as Partial<JobStatus> & { error?: string };
  if (!res.ok) return { status: 'failed', progress: 0, error: body.error ?? `Status check failed (${res.status})` };
  let modelUrl = body.modelUrl;
  // Relative proxy URLs resolve against the endpoint.
  if (modelUrl && modelUrl.startsWith('?')) modelUrl = `${endpoint}${modelUrl}`;
  return { status: body.status ?? 'pending', progress: body.progress ?? 0, modelUrl, error: body.error };
}
