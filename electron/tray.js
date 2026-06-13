const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const http = require('http');

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

function createTrayIcon() {
  const iconPath = path.join(__dirname, '..', 'icons', 'png', '32x32.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) return icon.resize({ width: 16, height: 16 });
  const canvas = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYPj/n4EBBJgYKAQM' +
    'FAMGShWQazg5BoD8QK4B5BoC1gUkpwsGFBUQAADJ4AQB2+EMmQAAAABJRU5ErkJggg==',
    'base64'
  );
  return nativeImage.createFromBuffer(canvas);
}

function createTray(mainWindow, serverUrl) {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip('Antigravity Quota Tracker');

  function updateMenu() {
    fetchJson(`${serverUrl}/api/quota`).then((data) => {
      const items = [];

      items.push({
        label: 'Antigravity Quota Tracker',
        enabled: false,
      });

      items.push({ type: 'separator' });

      items.push({
        label: 'Open Dashboard',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      });

      items.push({
        label: 'Refresh Now',
        click: () => {
          fetchJson(`${serverUrl}/api/refresh`);
        },
      });

      items.push({ type: 'separator' });

      if (data && data.accounts) {
        for (const acc of data.accounts) {
          if (!acc.connected) continue;
          items.push({
            label: acc.email,
            enabled: false,
          });
          for (const m of (acc.models || []).slice(0, 3)) {
            const pct = m.remainingFraction !== null && m.remainingFraction !== undefined
              ? Math.round(m.remainingFraction * 100) : 0;
            const icon = pct < 15 ? '🔴' : pct < 35 ? '🟡' : '🟢';
            items.push({
              label: `  ${icon} ${m.label}: ${pct}%`,
              enabled: false,
            });
          }
          if ((acc.models || []).length > 3) {
            items.push({
              label: `  ... +${acc.models.length - 3} more`,
              enabled: false,
            });
          }
        }
      }

      items.push({ type: 'separator' });
      items.push({
        label: 'Quit',
        click: () => {
          const { app } = require('electron');
          app.isQuitting = true;
          app.quit();
        },
      });

      const menu = Menu.buildFromTemplate(items);
      tray.setContextMenu(menu);
    });
  }

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });

  tray.on('right-click', updateMenu);

  updateMenu();

  setInterval(updateMenu, 30000);

  return tray;
}

module.exports = { createTray };
