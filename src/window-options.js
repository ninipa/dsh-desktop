import { fileURLToPath } from 'node:url'

const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url))

export function createWindowOptions(platform = process.platform, useDarkColors = false) {
  const isMac = platform === 'darwin'

  return {
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'DSH Desktop',
    backgroundColor: useDarkColors ? '#151517' : '#ffffff',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    titleBarOverlay: isMac,
    autoHideMenuBar: platform === 'win32',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD,
    },
  }
}
