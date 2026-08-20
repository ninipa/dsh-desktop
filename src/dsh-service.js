import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync, appendFileSync, copyFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const READY_PATTERN = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)\b/m
const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/
const EXEC_TIMEOUT_MS = 15_000
const INSTALL_GUIDANCE = 'dsh was not found. Install Node.js, then: npm install -g @deepseek-ai/dsh'

const execFileAsync = promisify(execFile)

// Interactive shells may print banner lines (e.g. zsh session restore) to
// stdout before the probed command runs; keep only the command's output.
const lastLine = (output) => {
  const lines = String(output).trim().split('\n')
  return lines[lines.length - 1]?.trim() ?? ''
}

export function extractReadyUrl(output) {
  return READY_PATTERN.exec(output)?.[1]
}

export async function resolveDshCommand({
  shellPath = '/bin/zsh',
  probeDsh = 'command -v dsh',
  probeNpx = 'command -v npx',
  probeNode = 'command -v node',
} = {}) {
  const probe = (probeCommand) =>
    // -i is required: .zshrc (which sets up fnm/node on PATH) is only read by
    // interactive shells; plain `zsh -l -c` would miss it under a clean PATH.
    execFileAsync(shellPath, ['-l', '-i', '-c', probeCommand], { timeout: EXEC_TIMEOUT_MS })

  let node
  try {
    node = lastLine((await probe(probeNode)).stdout)
  } catch {
    // no node means no dsh script can run; treat it as not installed
  }
  // Always run dsh/npx through node explicitly: GUI-launched apps do not
  // inherit the shell PATH, so a `#!/usr/bin/env node` shebang fails with 127.
  if (node) {
    try {
      const { stdout } = await probe(probeDsh)
      const dsh = lastLine(stdout)
      if (dsh) return [node, dsh]
    } catch {
      // dsh is not on the login shell PATH; fall through to the npx probe
    }
  }

  if (node) {
    try {
      const { stdout } = await probe(probeNpx)
      const npx = lastLine(stdout)
      if (npx) return [node, npx, '--yes', '@deepseek-ai/dsh@latest']
    } catch {
      // npx is not available either
    }
  }

  throw new Error(INSTALL_GUIDANCE)
}

export async function getDshVersion(command) {
  const result = spawnSync(command[0], [...command.slice(1), '--version'], {
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
  })
  const match = String(result.stdout ?? '').match(VERSION_PATTERN)
  return match ? match[0] : null
}

export function compareVersions(a, b) {
  const parse = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(version))
    if (!match) return null
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ? match[4].split(/[.-]/) : [],
    }
  }

  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0 // unparseable versions count as equal so the version guard passes

  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }

  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1 // a release is newer than any prerelease of the same core
  if (pb.pre.length === 0) return -1

  const max = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < max; i += 1) {
    const sa = pa.pre[i]
    const sb = pb.pre[i]
    if (sa === undefined) return -1 // shorter prerelease wins when all shared segments are equal
    if (sb === undefined) return 1
    const numericA = /^\d+$/.test(sa)
    const numericB = /^\d+$/.test(sb)
    if (numericA && numericB) {
      const na = Number(sa)
      const nb = Number(sb)
      if (na !== nb) return na < nb ? -1 : 1
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1
    }
  }
  return 0
}

// dsh 0.1.0-rc.8 changed `dsh web` to open the default browser after serving;
// it added `--no-open` to disable that. Older releases neither open a browser
// nor know the flag (commander rejects unknown options), so the flag is only
// appended when the resolved version supports it.
const NO_OPEN_SINCE = '0.1.0-rc.8'

export function supportsNoOpenFlag(version) {
  return !!version && compareVersions(version, NO_OPEN_SINCE) >= 0
}

export function buildDshArgs(command, { noOpen = false } = {}) {
  return [...command, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', ...(noOpen ? ['--no-open'] : [])]
}

export function startDshService({
  command,
  dshHome,
  environment = process.env,
  timeoutMs = 60_000,
  pathExtras = '',
  noOpen = false,
} = {}) {
  if (!command || command.length === 0) {
    throw new Error('command is required')
  }
  if (!dshHome) {
    throw new Error('dshHome is required')
  }

  mkdirSync(dshHome, { recursive: true })

  const pidfile = path.join(dshHome, 'dsh.pid')

  let existingPid = null
  try {
    existingPid = Number(readFileSync(pidfile, 'utf8').trim())
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  if (existingPid) {
    let alive = false
    try {
      process.kill(existingPid, 0) // probe the pid without signalling it
      alive = true
    } catch (error) {
      alive = error.code !== 'ESRCH'
    }
    if (alive) {
      // A force-killed previous run left its dsh orphan behind. Under the
      // single-instance lock this is always our own leftover process, so
      // reclaim it instead of failing the launch.
      try {
        process.kill(-existingPid, 'SIGKILL')
      } catch {
        try {
          process.kill(existingPid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    try {
      unlinkSync(pidfile) // stale pidfile left behind by a crashed run
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  const args = buildDshArgs(command, { noOpen }).slice(1)
  const child = spawn(command[0], args, {
    env: {
      ...environment,
      DSH_HOME: dshHome,
      NODE_OPTIONS: '', // neutralise any NODE_OPTIONS inherited from the caller's environment
      DSH_DESKTOP: '1',
      ...(pathExtras ? { PATH: `${pathExtras}:${environment.PATH ?? ''}` } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group so stop() can terminate every descendant
  })

  const cleanupPidfile = () => {
    try {
      unlinkSync(pidfile)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  child.once('error', cleanupPidfile)
  child.once('exit', cleanupPidfile)

  if (child.exitCode === null && !child.killed) {
    writeFileSync(pidfile, String(child.pid))
  }

  let output = ''
  let settled = false

  const ready = new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(poll)
      callback(value)
    }

    const inspect = (chunk) => {
      output += chunk.toString()
      const url = extractReadyUrl(output)
      if (url) confirmAndResolve(url)
    }

    const confirmAndResolve = (url) => {
      // A regex hit already proves readiness; the GET is only a confirmation and
      // must not block resolution, so the fetch runs without gating the promise.
      finish(resolve, url)
      fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {})
    }

    const poll = setInterval(() => {
      // Backup channel: resolve once a discovered loopback URL actually serves,
      // even if the anchored ready line was never matched in the output.
      const candidate = /https?:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]
      if (!candidate) return
      fetch(candidate, { signal: AbortSignal.timeout(2000) })
        .then((response) => {
          if (response.ok) finish(resolve, candidate)
        })
        .catch(() => {
          // not serving yet; keep polling
        })
    }, 500)

    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code, signal) => {
      finish(
        reject,
        new Error(`DSH stopped before it was ready (code ${String(code)}, signal ${String(signal)}).\n${output}`),
      )
    })

    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // the process group may already be gone (ESRCH) if the child exited on its own
        if (child.exitCode === null) {
          try {
            child.kill('SIGTERM')
          } catch {
            // already dead
          }
        }
      }
      finish(reject, new Error(`DSH did not become ready within ${timeoutMs}ms.\n${output}`))
    }, timeoutMs)
  })

  const waitForExit = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
    if (child.exitCode !== null) {
      clearTimeout(timer)
      resolve(true)
    }
  })

  const stop = async () => {
    if (child.exitCode !== null) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      if (child.exitCode === null) {
        try {
          child.kill('SIGTERM')
        } catch {
          // already exited
        }
      }
    }
    let exited = await waitForExit(5000)
    if (!exited) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        if (child.exitCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // already exited
          }
        }
      }
      await waitForExit(5000)
    }
  }

  return { child, ready, stop }
}

export function isMarketInstalled(dshHome) {
  // dshmarket is installed into <dshHome>/profiles/web/node_modules/dshmarket
  return existsSync(path.join(dshHome, 'profiles', 'web', 'node_modules', 'dshmarket'))
}

// pnpm is used by dsh plugin commands and by the plugin market at runtime, but
// GUI-launched apps cannot find it on the inherited PATH. Resolve it through
// the login shell and return its bin directory ('' when unresolvable).
export async function resolvePnpmBinDir({
  shellPath = '/bin/zsh',
  probePnpm = 'command -v pnpm',
} = {}) {
  try {
    const { stdout } = await execFileAsync(shellPath, ['-l', '-i', '-c', probePnpm], { timeout: EXEC_TIMEOUT_MS })
    const pnpm = lastLine(stdout)
    return pnpm ? path.dirname(pnpm) : ''
  } catch {
    return ''
  }
}

// pnpm 11's minimumReleaseAge supply-chain policy blocks freshly published
// packages unless they are whitelisted per version. The plugin market ships
// updates very frequently, so per-version whitelisting is impractical;
// disable the age gate for the isolated profile instead. Without this, market
// updates silently no-op ("Already up to date") and the UI loops forever.
export function ensureMinimumReleaseAgeDisabled(dshHome) {
  const yamlPath = path.join(dshHome, 'profiles', 'web', 'pnpm-workspace.yaml')
  try {
    const content = readFileSync(yamlPath, 'utf8')
    if (/^minimumReleaseAge:/m.test(content)) return // already set
    appendFileSync(yamlPath, 'minimumReleaseAge: 0\n')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // no workspace file yet; dsh creates it on first plugin operation
  }
}

// --- Update checks -----------------------------------------------------------
//
// Two independent lines: dsh (npm registry latest vs. the resolved dsh) and the
// shell app itself (GitHub release tag vs. app.getVersion()). Both prompt at
// most once per 24h per item, so a frequently-released prerelease chain never
// nags on every launch. All network paths fail silently: an offline or slow
// connection must never delay or break startup.

export const UPDATE_PROMPT_WINDOW_MS = 24 * 60 * 60 * 1000
export const DSH_UPDATE_COMMAND = 'npm update -g @deepseek-ai/dsh'
export const DSH_NEXT_UPDATE_COMMAND = 'npm install -g @deepseek-ai/dsh@next'
export const APP_UPDATE_URL = 'https://github.com/ninipa/dsh-desktop/releases/latest'

// The npx fallback (`npx --yes @deepseek-ai/dsh@latest`) always runs the latest
// release, so an update prompt would be meaningless; only system-installed dsh
// (npm -g) can lag behind and needs the check.
export function isNpxFallbackCommand(command) {
  return Array.isArray(command) && command.some((part) => part.includes('@deepseek-ai/dsh@latest'))
}

// dsh publishes two dist-tags: `latest` (the stable line, what `npm update -g`
// installs) and `next` (a preview line). Both are probed so the user can also
// be told about preview releases, clearly labelled as unstable.
export async function fetchDshDistTags({
  fetchImpl = fetch,
  timeoutMs = 5_000,
  registryUrl = 'https://registry.npmjs.org/@deepseek-ai/dsh',
} = {}) {
  try {
    const response = await fetchImpl(registryUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      // install-v1 keeps the response small (abbreviated metadata)
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!response.ok) return null
    const data = await response.json()
    const distTags = data['dist-tags']
    if (!distTags || typeof distTags !== 'object') return null
    return {
      latest: typeof distTags.latest === 'string' ? distTags.latest : null,
      next: typeof distTags.next === 'string' ? distTags.next : null,
    }
  } catch {
    return null // offline, timeout or bad payload: no information, never block startup
  }
}

// Prefer the stable line: only when the installed dsh already satisfies
// `latest` do we suggest the `next` preview line (clearly marked unstable).
export function decideDshUpdate(currentVersion, tags) {
  const latest = tags?.latest ?? null
  if (!latest || !currentVersion) return { prompt: false }
  if (compareVersions(currentVersion, latest) < 0) {
    return {
      prompt: true,
      line: 'latest',
      current: currentVersion,
      target: latest,
      command: DSH_UPDATE_COMMAND,
    }
  }
  const next = tags?.next ?? null
  if (next && compareVersions(currentVersion, next) < 0) {
    return {
      prompt: true,
      line: 'next',
      current: currentVersion,
      target: next,
      command: DSH_NEXT_UPDATE_COMMAND,
    }
  }
  return { prompt: false }
}

export async function fetchLatestAppVersion({
  fetchImpl = fetch,
  timeoutMs = 5_000,
  apiUrl = 'https://api.github.com/repos/ninipa/dsh-desktop/releases/latest',
} = {}) {
  try {
    const response = await fetchImpl(apiUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-desktop' },
    })
    if (!response.ok) return null
    const data = await response.json()
    if (typeof data.tag_name !== 'string') return null
    return data.tag_name.replace(/^v/, '')
  } catch {
    return null
  }
}

// Prompt state lives in <userData>/update-prompt-state.json:
// { "dsh": { "promptedAt": <ms>, "version": "..." }, "app": { ... } }
// Both items are de-duplicated independently.
export function readPromptState(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {} // missing or corrupted file means "no state": allow the check
  }
}

export function shouldCheckUpdate(stateFile, key, nowMs) {
  const entry = readPromptState(stateFile)[key]
  if (!entry || typeof entry.promptedAt !== 'number') return true
  return nowMs - entry.promptedAt >= UPDATE_PROMPT_WINDOW_MS
}

// Best-effort by design: an unwritable state file must never crash the prompt
// path, only degrade to "may prompt again next launch".
export function markUpdatePrompted(stateFile, key, nowMs, version) {
  try {
    const state = readPromptState(stateFile)
    state[key] = { promptedAt: nowMs, ...(version ? { version } : {}) }
    mkdirSync(path.dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, JSON.stringify(state, null, 2))
  } catch {
    // ignore: see above
  }
}

// --- Legacy userData migration ----------------------------------------------
//
// v0.1.0/v0.1.1 packaged builds resolved userData from package.json's `name`
// ("dsh-desktop") because Electron caches that path before main.js runs, while
// `npm start` dev runs used setName() ("DSH Desktop"). One-time, idempotent
// migration copies the only files worth keeping (the log and the 24h prompt
// state) into the unified locations; leftover cache directories are
// disposable and are deleted by hand once no old instance runs.
export function migrateLegacyUserData({ legacyDirs, logFile, stateFile, logFn = () => {} } = {}) {
  const copyIfMissing = (from, to) => {
    try {
      if (from && to && !existsSync(to) && existsSync(from)) {
        mkdirSync(path.dirname(to), { recursive: true })
        copyFileSync(from, to)
      }
    } catch (error) {
      logFn(`legacy migration failed (${from}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const dir of legacyDirs ?? []) {
    copyIfMissing(path.join(dir, 'dsh-desktop.log'), logFile)
    copyIfMissing(path.join(dir, 'update-prompt-state.json'), stateFile)
  }
}

export async function installMarketPlugin({
  command,
  dshHome,
  environment = process.env,
  shellPath = '/bin/zsh',
  probePnpm = 'command -v pnpm',
} = {}) {
  // dsh plugin shells out to pnpm, which GUI-launched apps cannot find on the
  // inherited PATH; resolve it through the login shell and prepend its bin dir.
  const pnpmBinDir = await resolvePnpmBinDir({ shellPath, probePnpm })

  return new Promise((resolve) => {
    const child = spawn(command[0], [...command.slice(1), 'plugin', '--profile', 'web', 'add', 'dshmarket'], {
      env: {
        ...environment,
        DSH_HOME: dshHome,
        PATH: pnpmBinDir ? `${pnpmBinDir}:${environment.PATH ?? ''}` : environment.PATH,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.once('error', (error) => resolve({ ok: false, output: String(error) }))
    child.once('exit', (code) => {
      const ok = code === 0
      if (ok) ensureMinimumReleaseAgeDisabled(dshHome)
      resolve({ ok, output })
    })
  })
}
