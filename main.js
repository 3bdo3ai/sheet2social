const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { startFacebookBot } = require('./src/lib/facebookBotElectron');

ipcMain.handle('startFacebookBot', async (event, credentials = {}) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  const pushLog = (message) => {
    if (!sourceWindow || sourceWindow.isDestroyed()) {
      return;
    }

    sourceWindow.webContents.send('bot-log', String(message));
  };

  try {
    pushLog('Starting Facebook bot workflow...');
    return await startFacebookBot(credentials, pushLog);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`Bot failed: ${message}`);
    throw new Error(`Failed to start Facebook bot: ${message}`);
  }
});

function createMainWindow() {
  const startUrl = process.env.ELECTRON_START_URL || 'http://localhost:3000';
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (startUrl.startsWith('http://') || startUrl.startsWith('https://')) {
    mainWindow.loadURL(startUrl);
    return;
  }

  mainWindow.loadFile(path.join(__dirname, 'out', 'index.html'));
}

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
