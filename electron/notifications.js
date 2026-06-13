const { Notification, BrowserWindow } = require('electron');
const http = require('http');

const prevStates = new Map();
const DEBOUNCE_MS = 30 * 60 * 1000;

function fetchJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function shouldSkip() {
  const win = BrowserWindow.getFocusedWindow();
  return win && !win.isDestroyed();
}

function setupNotifications(serverUrl) {
  let tally = { critical: 0, exhausted: 0, reset: 0 };

  async function poll() {
    const data = await fetchJson(`${serverUrl}/api/quota`);
    if (!data || !data.accounts) return;

    const now = Date.now();

    for (const acc of data.accounts) {
      if (!acc.email || !acc.models) continue;

      const prev = prevStates.get(acc.email) || new Map();
      const lastBatch = prev.get('_batch') || 0;
      if (now - lastBatch < DEBOUNCE_MS) continue;

      const exhaustedModels = [];
      const resetModels = [];
      const criticalModels = [];

      for (const m of acc.models) {
        const curFrac = m.remainingFraction;
        const prevFrac = prev.get(m.label);

        if (prevFrac !== undefined && prevFrac !== null) {
          if (curFrac !== null && curFrac > 0 && (prevFrac === 0 || prevFrac === null)) {
            resetModels.push(m.label);
          } else if (curFrac !== null && curFrac < 0.15 && curFrac > 0 && prevFrac >= 0.15) {
            criticalModels.push(m.label);
          } else if ((curFrac === null || curFrac === 0) && prevFrac > 0) {
            exhaustedModels.push(m.label);
          }
        }

        prev.set(m.label, curFrac);
      }

      prevStates.set(acc.email, prev);

      if (shouldSkip()) continue;

      if (resetModels.length > 0) {
        const body = resetModels.length <= 3
          ? `${resetModels.join(', ')} on ${acc.email}`
          : `${resetModels.length} models on ${acc.email}`;
        new Notification({ title: '✅ Quota Reset', body }).show();
        tally.reset++;
        prev.set('_batch', now);
      }

      if (criticalModels.length > 0) {
        const body = criticalModels.length <= 3
          ? `${criticalModels.join(', ')} on ${acc.email} running low`
          : `${criticalModels.length} models on ${acc.email} running low`;
        new Notification({ title: '⚠️ Quota Critical', body }).show();
        tally.critical++;
        prev.set('_batch', now);
      }

      if (exhaustedModels.length > 0) {
        const body = exhaustedModels.length <= 3
          ? `${exhaustedModels.join(', ')} on ${acc.email} used up`
          : `${exhaustedModels.length} models on ${acc.email} used up`;
        new Notification({ title: '🔴 Quota Exhausted', body }).show();
        tally.exhausted++;
        prev.set('_batch', now);
      }
    }
  }

  setInterval(poll, 30000);
  poll();

  return {
    getTally: () => ({ ...tally }),
    resetTally: () => { tally = { critical: 0, exhausted: 0, reset: 0 }; },
  };
}

module.exports = { setupNotifications };
