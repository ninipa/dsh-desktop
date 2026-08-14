// Preload bridge for the startup page (sandboxed renderer): exposes a minimal
// API for the plugin-market onboarding card. CJS on purpose: sandboxed
// preload scripts cannot use ESM imports.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopShell', {
  isMarketEnabled: () => ipcRenderer.invoke('market:status'),
  installMarket: () => ipcRenderer.invoke('market:install'),
  skipMarket: () => ipcRenderer.invoke('market:skip'),
  restartApp: () => ipcRenderer.invoke('market:restart'),
})
