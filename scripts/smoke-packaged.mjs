import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDshCommand, startDshService } from '../src/dsh-service.js'

const command = await resolveDshCommand()
const dshHome = mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'))

const service = startDshService({
  command,
  dshHome,
  environment: {
    ...process.env,
    NODE_OPTIONS: '',
    NODE_PATH: '',
  },
})

try {
  const url = await service.ready
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`dsh returned HTTP ${response.status}`)
  }
  const html = await response.text()
  if (!html.includes('__DSH_BOOT__')) {
    throw new Error('dsh did not return its Web UI')
  }
  console.log(`smoke: ${response.status} ${url}`)
} finally {
  await service.stop()
  rmSync(dshHome, { recursive: true, force: true })
}
