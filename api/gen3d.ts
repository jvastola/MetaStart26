/**
 * Text-to-3D proxy for Conjure (Vercel serverless function, Web handler API).
 *
 * Keeps the Meshy / Tripo API keys on the server. Deploy the app to Vercel
 * and set MESHY_API_KEY and/or TRIPO_API_KEY in the project's environment.
 *
 *   POST /api/gen3d            { provider, prompt }  -> { id }
 *   GET  /api/gen3d?provider=&id=                    -> { status, progress, modelUrl? }
 *   GET  /api/gen3d?download=<url>                   -> the GLB bytes (CORS-safe)
 *
 * Downloads are limited to the providers' asset hosts so this cannot be used
 * as an open proxy. Not yet exercised against the live APIs: check the
 * response shapes against the providers' current docs before relying on it.
 */

type Provider = 'meshy' | 'tripo';

const ALLOWED_DOWNLOAD_SUFFIXES = (process.env.GEN3D_ALLOWED_HOSTS ?? 'meshy.ai,tripo3d.ai,tripo3d.com,tripo3d.net')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CORS = {
  'access-control-allow-origin': process.env.GEN3D_ALLOWED_ORIGIN ?? '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
}

function key(provider: Provider): string | undefined {
  return provider === 'meshy' ? process.env.MESHY_API_KEY : process.env.TRIPO_API_KEY;
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request: Request): Promise<Response> {
  const { provider = 'meshy', prompt } = (await request.json().catch(() => ({}))) as { provider?: Provider; prompt?: string };
  if (!prompt || prompt.length > 600) return json({ error: 'A prompt of up to 600 characters is required.' }, 400);
  const apiKey = key(provider);
  if (!apiKey) return json({ error: `No API key configured for ${provider}.` }, 501);

  if (provider === 'meshy') {
    const res = await fetch('https://api.meshy.ai/openapi/v2/text-to-3d', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'preview', prompt, should_remesh: true, topology: 'triangle', target_polycount: 30000 }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: string; message?: string };
    if (!res.ok || !body.result) return json({ error: body.message ?? `Meshy error ${res.status}` }, 502);
    return json({ id: body.result });
  }

  const res = await fetch('https://api.tripo3d.ai/v2/openapi/task', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'text_to_model', prompt }),
  });
  const body = (await res.json().catch(() => ({}))) as { code?: number; data?: { task_id?: string }; message?: string };
  if (!res.ok || !body.data?.task_id) return json({ error: body.message ?? `Tripo error ${res.status}` }, 502);
  return json({ id: body.data.task_id });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const download = url.searchParams.get('download');
  if (download) return proxyDownload(download);

  const provider = (url.searchParams.get('provider') ?? 'meshy') as Provider;
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Missing id.' }, 400);
  const apiKey = key(provider);
  if (!apiKey) return json({ error: `No API key configured for ${provider}.` }, 501);
  const proxied = (u: string | undefined) => (u ? `?download=${encodeURIComponent(u)}` : undefined);

  if (provider === 'meshy') {
    const res = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const t = (await res.json().catch(() => ({}))) as {
      status?: string;
      progress?: number;
      model_urls?: { glb?: string };
      task_error?: { message?: string };
    };
    if (!res.ok) return json({ status: 'failed', progress: 0, error: `Meshy error ${res.status}` });
    const status = t.status === 'SUCCEEDED' ? 'succeeded' : t.status === 'FAILED' || t.status === 'CANCELED' ? 'failed' : t.status === 'IN_PROGRESS' ? 'running' : 'pending';
    return json({ status, progress: (t.progress ?? 0) / 100, modelUrl: proxied(t.model_urls?.glb), error: t.task_error?.message || undefined });
  }

  const res = await fetch(`https://api.tripo3d.ai/v2/openapi/task/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const t = (await res.json().catch(() => ({}))) as {
    data?: { status?: string; progress?: number; output?: { model?: string; pbr_model?: string; base_model?: string } };
  };
  if (!res.ok || !t.data) return json({ status: 'failed', progress: 0, error: `Tripo error ${res.status}` });
  const s = t.data.status;
  const status = s === 'success' ? 'succeeded' : s === 'running' ? 'running' : s === 'queued' ? 'pending' : 'failed';
  const model = t.data.output?.pbr_model ?? t.data.output?.model ?? t.data.output?.base_model;
  return json({ status, progress: (t.data.progress ?? 0) / 100, modelUrl: proxied(model) });
}

async function proxyDownload(target: string): Promise<Response> {
  let host: string;
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:') throw new Error('https only');
    host = parsed.hostname;
  } catch {
    return json({ error: 'Bad download URL.' }, 400);
  }
  if (!ALLOWED_DOWNLOAD_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return json({ error: 'Host not allowed.' }, 403);
  }
  const res = await fetch(target);
  if (!res.ok || !res.body) return json({ error: `Download failed (${res.status})` }, 502);
  return new Response(res.body, {
    headers: { 'content-type': 'model/gltf-binary', 'cache-control': 'public, max-age=86400', ...CORS },
  });
}
