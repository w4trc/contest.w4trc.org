const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  fetchConditions:   () => ipcRenderer.invoke('fetch-conditions'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
});
