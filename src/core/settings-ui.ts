/**
 * Settings dialog on the 2D page (typing is easiest before entering MR).
 *
 * Holds the optional AI keys for Conjure. Keys stay in this browser's
 * localStorage and are only ever sent to the provider they belong to.
 */

import { type Gen3DSettings, loadSettings, saveSettings } from '../protos/conjure/remote.js';

const CSS = `
.lab-settings{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:20;font:15px system-ui,sans-serif}
.lab-settings .card{background:#1d2027;color:#eef0f3;border:1px solid #3a3f4a;border-radius:16px;padding:20px 22px;width:min(460px,calc(100% - 32px));box-shadow:0 20px 60px rgba(0,0,0,.5)}
.lab-settings h2{margin:0 0 4px;font-size:20px}
.lab-settings p{margin:6px 0 14px;color:#aeb3bd;line-height:1.4;font-size:13px}
.lab-settings label{display:block;margin:12px 0 4px;font-weight:600;font-size:13px}
.lab-settings input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #3a3f4a;background:#14161b;color:#eef0f3;font:14px ui-monospace,monospace}
.lab-settings .row{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
.lab-settings button{border:0;border-radius:10px;padding:10px 14px;font:600 14px system-ui,sans-serif;cursor:pointer;background:#2b2f38;color:#eef0f3}
.lab-settings button.primary{background:#2f7d5d}
.lab-settings .msg{margin-top:10px;font-size:13px;color:#7fe0b5;min-height:1em}
`;

export function openSettings(onSaved: () => void): void {
  if (document.querySelector('.lab-settings')) return;
  if (!document.getElementById('lab-settings-css')) {
    const style = document.createElement('style');
    style.id = 'lab-settings-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const current = loadSettings();
  const root = document.createElement('div');
  root.className = 'lab-settings';
  root.innerHTML = `
    <div class="card" role="dialog" aria-modal="true" aria-labelledby="lab-settings-title">
      <h2 id="lab-settings-title">Conjure AI settings</h2>
      <p>Optional. Add your own Meshy or Tripo API key so Conjure can generate full 3D models.
      Keys are stored only in this browser and sent only to that provider. Use a key you can revoke.
      Without a key, Conjure makes offline sketches.</p>
      <label for="lab-meshy">Meshy API key</label>
      <input id="lab-meshy" type="password" autocomplete="off" spellcheck="false" placeholder="msy_...">
      <label for="lab-tripo">Tripo API key</label>
      <input id="lab-tripo" type="password" autocomplete="off" spellcheck="false" placeholder="tsk_...">
      <label for="lab-endpoint">Proxy URL (optional, instead of keys)</label>
      <input id="lab-endpoint" type="url" autocomplete="off" spellcheck="false" placeholder="https://your-app.vercel.app/api/gen3d">
      <div class="row">
        <button class="primary" data-act="save">Save</button>
        <button data-act="show">Show keys</button>
        <button data-act="clear">Remove keys</button>
        <button data-act="close">Close</button>
      </div>
      <div class="msg" aria-live="polite"></div>
    </div>`;
  document.body.appendChild(root);
  const $ = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
  $('lab-meshy').value = current.keys.meshy ?? '';
  $('lab-tripo').value = current.keys.tripo ?? '';
  $('lab-endpoint').value = current.endpoint;
  const msg = root.querySelector<HTMLDivElement>('.msg')!;
  const close = () => root.remove();
  root.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).dataset.act;
    if (e.target === root || act === 'close') close();
    if (act === 'show') {
      for (const id of ['lab-meshy', 'lab-tripo']) $(id).type = $(id).type === 'password' ? 'text' : 'password';
    }
    if (act === 'clear') {
      saveSettings({ endpoint: '', keys: {} });
      $('lab-meshy').value = $('lab-tripo').value = $('lab-endpoint').value = '';
      msg.textContent = 'Keys removed from this browser.';
      onSaved();
    }
    if (act === 'save') {
      const next: Gen3DSettings = {
        endpoint: $('lab-endpoint').value.trim(),
        keys: { meshy: $('lab-meshy').value.trim(), tripo: $('lab-tripo').value.trim() },
      };
      saveSettings(next);
      const which = [next.keys.meshy && 'Meshy', next.keys.tripo && 'Tripo'].filter(Boolean).join(' and ');
      msg.textContent = next.endpoint ? 'Saved. Conjure will use your proxy.' : which ? `Saved. Conjure can now use ${which}.` : 'Saved. No keys set: offline sketches only.';
      onSaved();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  $('lab-meshy').focus();
}
