export const MAC_TITLEBAR_HEIGHT = 38

export const MAC_TITLEBAR_CSS = `
  html {
    background-color: Canvas;
  }

  body {
    box-sizing: border-box !important;
    height: 100vh !important;
    padding-top: env(titlebar-area-height, ${MAC_TITLEBAR_HEIGHT}px) !important;
    background-color: var(--dsw-alias-bg-base, Canvas) !important;
    overflow: hidden !important;
  }
`

export async function applyMacTitleBarStyle(webContents) {
  await webContents.insertCSS(MAC_TITLEBAR_CSS)
}
