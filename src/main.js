import path from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
} from 'electron'
import {
  APP_UPDATE_URL,
  DSH_UPDATE_COMMAND,
  compareVersions,
  decideDshUpdate,
  fetchDshDistTags,
  fetchLatestAppVersion,
  getDshVersion,
  installMarketPlugin,
  isMarketInstalled,
  isNpxFallbackCommand,
  markUpdatePrompted,
  migrateLegacyUserData,
  resolveDshCommand,
  resolvePnpmBinDir,
  shouldCheckUpdate,
  startDshService,
  supportsNoOpenFlag,
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
let onStartupPage = true // the startup page is the only place for non-blocking status lines
let updateChecksStarted = false
const updateResults = { dsh: null, app: null } // null = not settled yet
const updatePresented = { dsh: false, app: false } // card or dialog; a prompt is presented exactly once
let updateDialogOpen = false
let updateCardVisible = false
let updateCardTimer
let mainUiLoaded = false

const dshHome = path.join(app.getPath('appData'), 'Dsh', 'dsh-home')

app.setName(APP_NAME)

// Packaged builds resolve userData from package.json's `name` ("dsh-desktop")
// before main.js runs, so setName() alone cannot move it. Pin it explicitly so
// every build (packaged or `npm start`) shares one directory.
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME))

// Must come after setPath: getPath('userData') caches on first call.
const updateStateFile = path.join(app.getPath('userData'), 'update-prompt-state.json')

// File log for packaged builds (no terminal). macOS convention keeps logs out
// of Application Support: ~/Library/Logs/DSH Desktop/dsh-desktop.log
const logFile = path.join(app.getPath('logs'), APP_NAME, 'dsh-desktop.log')
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

// --- Update checks (dsh + shell app) -----------------------------------------
//
// Both checks run in parallel and never block startup: each is gated by a 24h
// per-item window (state file), times out after 5s, and fails silently. While
// the startup page is visible, "checking" status lines are streamed to it and
// prompts render as a card; once the main UI has loaded, settled prompts fall
// back to a single native dialog.

function sendUpdateStatus(key, state) {
  if (onStartupPage) mainWindow?.webContents.send('update:status', { key, state })
}

async function checkDshUpdate(currentVersion) {
  const tags = await fetchDshDistTags()
  if (!tags) return { prompt: false }
  return decideDshUpdate(currentVersion, tags)
}

async function checkAppUpdate() {
  const latest = await fetchLatestAppVersion()
  if (!latest) return { prompt: false }
  const current = app.getVersion()
  return { prompt: compareVersions(current, latest) < 0, current, latest }
}

function startUpdateChecks({ version, isNpxFallback }) {
  if (updateChecksStarted) return // a crash-restart must not re-run the checks
  updateChecksStarted = true
  const now = Date.now()
  // Skip gated items entirely: no network call, no status line (the user's
  // chosen 24h policy means most launches never touch the network here).
  const dshShouldCheck = !isNpxFallback && version != null && shouldCheckUpdate(updateStateFile, 'dsh', now)
  const appShouldCheck = shouldCheckUpdate(updateStateFile, 'app', now)
  if (dshShouldCheck) sendUpdateStatus('dsh', 'checking')
  if (appShouldCheck) sendUpdateStatus('app', 'checking')
  void Promise.all([
    dshShouldCheck ? checkDshUpdate(version) : { prompt: false },
    appShouldCheck ? checkAppUpdate() : { prompt: false },
  ]).then(([dsh, app]) => {
    settleUpdateResult('dsh', dsh)
    settleUpdateResult('app', app)
  })
}

function settleUpdateResult(key, result) {
  updateResults[key] = result
  if (result.prompt && !updatePresented[key]) {
    markUpdatePrompted(updateStateFile, key, Date.now(), result.target) // the 24h window opens when the prompt is shown
    log(`update prompt (${key}): ${result.current} -> ${result.target} (${result.line ?? ''} line)`)
    if (onStartupPage) {
      updatePresented[key] = true // presented as a card; never shown again
      updateCardVisible = true
      // Hold the page so the card is actually readable; the dsh-ready switch
      // (loadMainUiSoon) and this timer both call the idempotent loadMainUi.
      if (!updateCardTimer) updateCardTimer = setTimeout(() => loadMainUi(), 30_000)
      mainWindow?.webContents.send('update:card', {
        key,
        current: result.current,
        latest: result.target,
        line: result.line,
        command: result.command,
      })
    }
  } else if (onStartupPage && !result.prompt) {
    sendUpdateStatus(key, 'done')
  }
  if (!onStartupPage && updateResults.dsh !== null && updateResults.app !== null) {
    void maybeShowUpdateDialog()
  }
}

// Merged native-dialog fallback for prompts that settle after the main UI has
// already loaded. Runs at most once per session; card-presented items never
// reappear here (updatePresented is set when the card was shown).
async function maybeShowUpdateDialog() {
  if (updateDialogOpen) return
  const zh = app.getLocale().toLowerCase().startsWith('zh')
  const detail = []
  const buttons = []
  let openPageButtonIndex = -1

  for (const key of ['dsh', 'app']) {
    const result = updateResults[key]
    if (!result.prompt || updatePresented[key]) continue
    updatePresented[key] = true
    if (key === 'dsh') {
      const lineLabel = result.line === 'next'
        ? (zh ? 'next 尝鲜线（非稳定版本）' : 'next preview line (unstable)')
        : (zh ? 'latest 稳定线' : 'latest stable line')
      detail.push(zh ? `dsh  ${result.current} → ${result.target}（${lineLabel}）` : `dsh  ${result.current} -> ${result.target} (${lineLabel})`)
      if (result.line === 'next') {
        detail.push(zh ? '注意：next 线为非稳定版本，可能包含未完成或有问题的功能。' : 'Note: the next line is not a stable release and may contain unfinished or broken features.')
      }
      detail.push(zh ? `安装命令：${result.command}` : `Run: ${result.command}`)
    } else {
      detail.push(zh ? `DSH Desktop  ${result.current} → ${result.target}` : `DSH Desktop  ${result.current} -> ${result.target}`)
      buttons.push(zh ? '打开下载页' : 'Open download page')
      openPageButtonIndex = buttons.length - 1
    }
  }
  if (detail.length === 0) return

  buttons.push(zh ? '忽略' : 'Dismiss')
  updateDialogOpen = true
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: zh ? '检测到新版本' : 'Updates available',
    message: zh ? '检测到新版本' : 'Updates available',
    detail: detail.join('\n'),
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
  })
  updateDialogOpen = false
  if (response === openPageButtonIndex) shell.openExternal(APP_UPDATE_URL)
}

function loadMainUi() {
  if (mainUiLoaded) return
  mainUiLoaded = true
  clearTimeout(marketPromptTimer)
  clearTimeout(updateCardTimer)
  updateCardVisible = false
  onStartupPage = false
  void mainWindow?.loadURL(serviceUrl)
}

// Post-ready switch that defers while an update card is on screen, giving the
// prompt its full 30s grace before the main UI loads.
function loadMainUiSoon() {
  if (updateCardVisible) {
    if (!updateCardTimer) updateCardTimer = setTimeout(() => loadMainUi(), 30_000)
    return
  }
  loadMainUi()
}

async function launch() {
  // One-time migration from the legacy split userData dirs (see
  // migrateLegacyUserData): log + prompt state move to the unified locations.
  migrateLegacyUserData({
    legacyDirs: [
      path.join(app.getPath('appData'), 'dsh-desktop'), // v0.1.0/v0.1.1 packaged builds
      path.join(app.getPath('appData'), APP_NAME), // dev runs / old installs
    ],
    logFile,
    stateFile: updateStateFile,
    logFn: log,
  })
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
  // A crash-restart re-enters this function; allow loadMainUi to reload the
  // main UI again (the previous page shows a dead dsh connection).
  mainUiLoaded = false
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

  startUpdateChecks({ version, isNpxFallback: isNpxFallbackCommand(command) })

  try {
    // The dsh web process needs pnpm on its PATH for the plugin market at
    // runtime; GUI-launched apps do not inherit it, so inject it explicitly.
    const pnpmBinDir = await resolvePnpmBinDir()
    service = startDshService({
      command,
      dshHome,
      environment: { ...process.env },
      pathExtras: pnpmBinDir,
      // dsh >= rc.8 opens the default browser after serving; the shell embeds
      // the UI itself, so suppress that (gated for older dsh compatibility).
      noOpen: supportsNoOpenFlag(version),
    })
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
      loadMainUiSoon()
    } else {
      // First-run onboarding: keep the startup page showing the plugin-market
      // card; fall back to the UI after 30s if the user does nothing.
      marketPromptTimer = setTimeout(() => {
        loadMainUi()
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
  loadMainUi()
})

ipcMain.handle('market:restart', () => {
  app.relaunch()
  app.quit()
})

ipcMain.handle('update:copy', () => {
  clipboard.writeText(DSH_UPDATE_COMMAND)
  return true
})

ipcMain.handle('update:open', () => {
  shell.openExternal(APP_UPDATE_URL)
  return true
})

ipcMain.handle('update:dismissed', () => {
  clearTimeout(updateCardTimer)
  updateCardTimer = undefined
  updateCardVisible = false
  // With the market onboarding timer pending, that flow owns the page; only
  // the plain post-ready path (serviceUrl set, no market timer) switches now.
  if (serviceUrl && !marketPromptTimer) loadMainUi()
  return true
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
