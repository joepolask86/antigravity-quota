const { app, BrowserWindow, ipcMain } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const http = require('http');
const { createTray } = require('./tray');
const { setupNotifications } = require('./notifications');

const SERVER_PORT = process.env.PORT || 3001;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

let mainWindow = null;
let serverProcess = null;
let tray = null;
let notifier = null;

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = fork(path.join(__dirname, '..', 'server.js'), [], {
      env: { ...process.env, PORT: String(SERVER_PORT), USER_DATA_DIR: app.getPath('userData') },
      stdio: 'pipe',
    });

    serverProcess.stdout.on('data', d => console.log(`[server] ${d}`));
    serverProcess.stderr.on('data', d => console.error(`[server] ${d}`));

    serverProcess.on('exit', (code) => {
      console.log(`[server] exited code=${code}`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    serverProcess.on('error', reject);

    pollServer(30, 300).then(resolve).catch(reject);
  });
}

function pollServer(retries, interval) {
  return new Promise((resolve, reject) => {
    function check(n) {
      const req = http.get(`${SERVER_URL}/api/status`, (res) => {
        if (res.statusCode === 200) return resolve();
        if (n <= 0) return reject(new Error('Server not ready'));
        setTimeout(() => check(n - 1), interval);
      });
      req.on('error', () => {
        if (n <= 0) return reject(new Error('Server not ready'));
        setTimeout(() => check(n - 1), interval);
      });
      req.end();
    }
    check(retries);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 740,
    height: 760,
    resizable: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0b0d11',
    show: false,
  });

  mainWindow.loadURL(SERVER_URL);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.antigravity.quota-tracker');
}

app.on('ready', async () => {
  try {
    console.log('[electron] Starting server...');
    await startServer();
    console.log('[electron] Server ready');

    createWindow();
    tray = createTray(mainWindow, SERVER_URL);
    notifier = setupNotifications(SERVER_URL);

    ipcMain.on('open-external', (_, url) => {
      require('electron').shell.openExternal(url);
    });

    ipcMain.on('window-minimize', () => mainWindow?.minimize());
    ipcMain.on('window-maximize', () => {
      if (mainWindow?.isMaximized()) mainWindow.unmaximize();
      else mainWindow?.maximize();
    });
    ipcMain.on('window-close', () => {
      if (mainWindow) {
        mainWindow.close();
      }
    });
  } catch (err) {
    console.error('[electron] Failed to start:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  if (tray) tray.destroy();
  if (serverProcess) serverProcess.kill();
});
