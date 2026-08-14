const { execFileSync, spawnSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // Skip ad-hoc re-signing when the build was already signed with a real
  // Developer ID identity (CI); ad-hoc signing is only the local fallback.
  const inspect = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' })
  if (inspect.stdout.includes('Developer ID')) return

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
    stdio: 'inherit',
  })
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit',
  })
}
