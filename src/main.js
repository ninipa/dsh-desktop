import path from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
} from 'electron'
import {
  compareVersions,
  getDshVersion,
  installMarketPlugin,
  isMarketInstalled,
  resolveDshCommand,
  resolvePnpmBinDir,
  startDshService,
} from './dsh-service.js'
import { applyMacTitleBarStyle } from './mac-titlebar.js'
import { createWindowOptions } from './window-options.js'
import { createTrayMenuTemplate, shouldHideWindowOnClose } from './window-lifecycle.js'

const APP_NAME = 'DSH Desktop'
const MIN_DSH_VERSION = '0.1.0-rc.5'
const STARTUP_PAGE = fileURLToPath(new URL('./startup.html', import.meta.url))
const APP_ICON = fileURLToPath(new URL('../assets/icon.png', import.meta.url))
const TRAY_ICON = fileURLToPath(new URL('../assets/tray.png', import.meta.url))
const TRAY_TEMPLATE_ICON = fileURLToPath(new URL('../assets/trayTemplate.png', import.meta.url))

let mainWindow
let service
let serviceUrl
let tray
let trayAvailable = false
let isQuitting = false
let restartCount = 0
let stopping = false
let quitting = false
let marketPromptTimer

const dshHome = path.join(app.getPath('appData'), 'Dsh', 'dsh-home')

app.setName(APP_NAME)

// File log for packaged builds (no terminal): ~/Library/Application Support/DSH Desktop/dsh-desktop.log
const logFile = path.join(app.getPath('userData'), 'dsh-desktop.log')
function log(message) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true })
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // logging must never break startup
  }
}

async function showMainWindow() {
  if (!mainWindow) {
    await createWindow()
    if (serviceUrl) await mainWindow?.loadURL(serviceUrl)
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow() {
  if (process.platform === 'win32') Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow(createWindowOptions(process.platform, nativeTheme.shouldUseDarkColors))

  if (process.platform === 'win32') {
    mainWindow.setMenu(null)
    mainWindow.setMenuBarVisibility(false)
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (currentUrl && new URL(url).origin !== new URL(currentUrl).origin) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    if (process.platform === 'darwin') void applyMacTitleBarStyle(mainWindow.webContents)
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (!shouldHideWindowOnClose(isQuitting, trayAvailable)) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })

  return mainWindow.loadFile(STARTUP_PAGE)
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(
    process.platform === 'darwin' ? TRAY_TEMPLATE_ICON : TRAY_ICON,
  )
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate({
    locale: app.getLocale(),
    showWindow: () => void showMainWindow(),
    hideWindow: () => mainWindow?.hide(),
    quit: () => {
      isQuitting = true
      app.quit()
    },
  })))
  tray.on('click', () => void showMainWindow())
  trayAvailable = true
}

async function showStartupError(message, error) {
  await dialog.showMessageBox({
    type: 'error',
    title: `${APP_NAME} failed to start`,
    message,
    detail: error instanceof Error ? error.message : String(error),
  })
}

async function launch() {
  // Only dev mode (no .app bundle) needs an explicit dock icon. Packaged
  // builds use their own icon.icns, which macOS already renders with the
  // rounded-rect dock mask; calling setIcon() here would override that with
  // a raw square image.
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock?.setIcon(APP_ICON)
    } catch (error) {
      // a missing or unreadable icon must never block startup
      log(`dock icon failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const startupReady = createWindow()
  try {
    createTray()
  } catch (error) {
    console.warn(`System tray is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  await startupReady
  await startAndLoad()
}

async function startAndLoad() {
  let command
  try {
    command = await resolveDshCommand()
    log(`resolved command: ${command.join(' ')}`)
  } catch (error) {
    log(`resolve failed: ${error instanceof Error ? error.message : String(error)}`)
    stopping = true
    await showStartupError('DSH could not start.', error)
    app.quit()
    return
  }

  const version = await getDshVersion(command)
  log(`dsh version: ${version ?? 'unknown'}`)
  if (version && compareVersions(version, MIN_DSH_VERSION) < 0) {
    console.warn(`dsh version ${version} is older than the supported minimum ${MIN_DSH_VERSION}; continuing anyway`)
  }

  try {
    // The dsh web process needs pnpm on its PATH for the plugin market at
    // runtime; GUI-launched apps do not inherit it, so inject it explicitly.
    const pnpmBinDir = await resolvePnpmBinDir()
    service = startDshService({ command, dshHome, environment: { ...process.env }, pathExtras: pnpmBinDir })
    const current = service
    current.child.on('exit', () => {
      if (stopping || isQuitting) return
      if (service !== current) return // a replaced service must not schedule a restart
      restartCount += 1
      if (restartCount > 3) {
        stopping = true
        void dialog.showMessageBox({
          type: 'error',
          title: `${APP_NAME} failed to start`,
          message: 'DSH keeps crashing.',
          detail: `The dsh process exited ${restartCount} times; restarting was aborted.`,
        }).then(() => app.quit())
        return
      }
      const delay = 1000 * 2 ** (restartCount - 1)
      setTimeout(() => {
        void startAndLoad()
      }, delay)
    })

    serviceUrl = await current.ready
    log(`ready: ${serviceUrl}`)
    restartCount = 0 // a healthy run resets the crash counter
    if (isMarketInstalled(dshHome)) {
      await mainWindow?.loadURL(serviceUrl)
    } else {
      // First-run onboarding: keep the startup page showing the plugin-market
      // card; fall back to the UI after 30s if the user does nothing.
      marketPromptTimer = setTimeout(() => {
        void mainWindow?.loadURL(serviceUrl)
      }, 30_000)
    }
  } catch (error) {
    log(`start failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    stopping = true
    await showStartupError('DSH could not start.', error)
    app.quit()
  }
}

ipcMain.handle('market:status', () => isMarketInstalled(dshHome))

ipcMain.handle('market:install', async () => {
  try {
    const command = await resolveDshCommand()
    return await installMarketPlugin({ command, dshHome, environment: { ...process.env } })
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('market:skip', () => {
  clearTimeout(marketPromptTimer)
  void mainWindow?.loadURL(serviceUrl)
})

ipcMain.handle('market:restart', () => {
  app.relaunch()
  app.quit()
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    void showMainWindow()
  })

  app.whenReady().then(launch)
}

app.on('activate', () => {
  void showMainWindow()
})

app.on('window-all-closed', () => {
  if (isQuitting || (!trayAvailable && process.platform !== 'darwin')) app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  if (!service) return
  event.preventDefault()
  quitting = true
  isQuitting = true
  stopping = true
  void Promise.race([
    service.stop(),
    new Promise((resolve) => setTimeout(resolve, 6000)),
  ]).finally(() => app.quit())
})
