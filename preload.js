const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startFacebookBot(credentials = {}) {
    return ipcRenderer.invoke('startFacebookBot', credentials);
  },
  onBotLog(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }

    const channelListener = (_event, message) => {
      listener(String(message));
    };

    ipcRenderer.on('bot-log', channelListener);
    return () => {
      ipcRenderer.removeListener('bot-log', channelListener);
    };
  },
});
