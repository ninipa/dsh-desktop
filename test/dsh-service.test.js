import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  UPDATE_PROMPT_WINDOW_MS,
  buildDshArgs,
  compareVersions,
  decideDshUpdate,
  ensureMinimumReleaseAgeDisabled,
  extractReadyUrl,
  fetchDshDistTags,
  fetchLatestAppVersion,
  isMarketInstalled,
  isNpxFallbackCommand,
  markUpdatePrompted,
  migrateLegacyUserData,
  resolveDshCommand,
  shouldCheckUpdate,
} from '../src/dsh-service.js'

test('extractReadyUrl reads the canonical loopback readiness URL', () => {
  assert.equal(
    extractReadyUrl('booting\ndsh web: http://127.0.0.1:60882\n'),
    'http://127.0.0.1:60882',
  )
})

test('extractReadyUrl ignores non-loopback output', () => {
  assert.equal(extractReadyUrl('dsh web: http://192.168.1.10:3080'), undefined)
})

test('buildDshArgs appends the web profile flags to a direct dsh command', () => {
  assert.deepEqual(buildDshArgs(['/usr/local/bin/dsh']), [
    '/usr/local/bin/dsh',
    '--profile',
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ])
})

test('buildDshArgs preserves an npx launcher prefix', () => {
  assert.deepEqual(buildDshArgs(['/path/npx', '--yes', '@deepseek-ai/dsh@latest']), [
    '/path/npx',
    '--yes',
    '@deepseek-ai/dsh@latest',
    '--profile',
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ])
})

test('compareVersions orders prereleases within the same release line', () => {
  assert.equal(compareVersions('0.1.0-rc.5', '0.1.0-rc.6'), -1)
  assert.equal(compareVersions('0.1.0-rc.6', '0.1.0-rc.5'), 1)
})

test('compareVersions compares numeric prerelease segments numerically', () => {
  assert.equal(compareVersions('0.1.0-rc.9', '0.1.0-rc.10'), -1)
})

test('compareVersions ranks a release above its prereleases', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0-rc.6'), 1)
})

test('compareVersions compares the core segments numerically', () => {
  assert.equal(compareVersions('0.2.0', '0.1.99'), 1)
})

test('compareVersions treats equal versions as equal', () => {
  assert.equal(compareVersions('0.1.0-rc.6', '0.1.0-rc.6'), 0)
})

test('compareVersions treats unparseable versions as equal', () => {
  assert.equal(compareVersions('garbage', '0.1.0'), 0)
})

test('resolveDshCommand returns node plus the dsh script from the login shell', async () => {
  const command = await resolveDshCommand({
    probeDsh: "printf '/fake/dsh'",
    probeNode: "printf '/fake/node'",
  })
  assert.deepEqual(command, ['/fake/node', '/fake/dsh'])
})

test('resolveDshCommand falls back to node plus npx when dsh is missing', async () => {
  const command = await resolveDshCommand({
    probeDsh: 'exit 1',
    probeNpx: "printf '/fake/npx'",
    probeNode: "printf '/fake/node'",
  })
  assert.deepEqual(command, ['/fake/node', '/fake/npx', '--yes', '@deepseek-ai/dsh@latest'])
})

test('resolveDshCommand rejects with install guidance when dsh and npx are missing', async () => {
  await assert.rejects(
    resolveDshCommand({
      probeDsh: 'exit 1',
      probeNpx: 'exit 1',
      probeNode: "printf '/fake/node'",
    }),
    /npm install -g @deepseek-ai\/dsh/,
  )
})

test('resolveDshCommand rejects with install guidance when node is missing', async () => {
  await assert.rejects(
    resolveDshCommand({ probeDsh: 'exit 1', probeNpx: 'exit 1', probeNode: 'exit 1' }),
    /Install Node\.js/,
  )
})

test('isMarketInstalled detects dshmarket in the web profile', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-market-test-'))
  try {
    assert.equal(isMarketInstalled(home), false)
    mkdirSync(path.join(home, 'profiles', 'web', 'node_modules', 'dshmarket'), { recursive: true })
    writeFileSync(path.join(home, 'profiles', 'web', 'node_modules', 'dshmarket', 'package.json'), '{}')
    assert.equal(isMarketInstalled(home), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureMinimumReleaseAgeDisabled appends the gate-off setting once', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-mra-test-'))
  const yaml = path.join(home, 'profiles', 'web', 'pnpm-workspace.yaml')
  try {
    mkdirSync(path.dirname(yaml), { recursive: true })
    writeFileSync(yaml, 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dshmarket@1.0.3\n')
    ensureMinimumReleaseAgeDisabled(home)
    const content = readFileSync(yaml, 'utf8')
    assert.match(content, /^minimumReleaseAge: 0$/m)
    assert.equal((content.match(/^minimumReleaseAge: 0$/gm) ?? []).length, 1)
    // idempotent: calling again must not duplicate the line
    ensureMinimumReleaseAgeDisabled(home)
    const again = readFileSync(yaml, 'utf8')
    assert.equal((again.match(/^minimumReleaseAge: 0$/gm) ?? []).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureMinimumReleaseAgeDisabled is a no-op when the workspace file is missing', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-mra-empty-'))
  try {
    assert.doesNotThrow(() => ensureMinimumReleaseAgeDisabled(home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('isNpxFallbackCommand detects the npx fallback launcher', () => {
  assert.equal(isNpxFallbackCommand(['/fake/node', '/fake/npx', '--yes', '@deepseek-ai/dsh@latest']), true)
  assert.equal(isNpxFallbackCommand(['/fake/node', '/fake/dsh']), false)
})

test('fetchDshDistTags returns the latest and next dist-tags', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ 'dist-tags': { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' } }),
  })
  assert.deepEqual(await fetchDshDistTags({ fetchImpl }), { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' })
})

test('fetchDshDistTags tolerates a missing next tag', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ 'dist-tags': { latest: '0.1.0' } }),
  })
  assert.deepEqual(await fetchDshDistTags({ fetchImpl }), { latest: '0.1.0', next: null })
})

test('fetchDshDistTags returns null on non-OK responses', async () => {
  const fetchImpl = async () => ({ ok: false })
  assert.equal(await fetchDshDistTags({ fetchImpl }), null)
})

test('fetchDshDistTags returns null when the payload has no dist-tags', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: 'nope' }) })
  assert.equal(await fetchDshDistTags({ fetchImpl }), null)
})

test('fetchDshDistTags returns null when the network fails', async () => {
  const fetchImpl = async () => {
    throw new Error('offline')
  }
  assert.equal(await fetchDshDistTags({ fetchImpl }), null)
})

test('decideDshUpdate suggests the latest stable line when behind it', () => {
  const result = decideDshUpdate('0.1.0-rc.6', { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' })
  assert.equal(result.prompt, true)
  assert.equal(result.line, 'latest')
  assert.equal(result.target, '0.1.0-rc.7')
  assert.match(result.command, /^npm update -g /)
})

test('decideDshUpdate suggests the next preview line only when latest is satisfied', () => {
  const result = decideDshUpdate('0.1.0-rc.7', { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' })
  assert.equal(result.prompt, true)
  assert.equal(result.line, 'next')
  assert.equal(result.target, '0.1.0-rc.8')
  assert.match(result.command, /@next$/)
})

test('decideDshUpdate does not prompt when current is at or beyond next', () => {
  assert.equal(decideDshUpdate('0.1.0-rc.8', { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' }).prompt, false)
  assert.equal(decideDshUpdate('0.1.0-rc.9', { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' }).prompt, false)
})

test('decideDshUpdate does not prompt when next is missing and latest is satisfied', () => {
  assert.equal(decideDshUpdate('0.1.0', { latest: '0.1.0', next: null }).prompt, false)
})

test('decideDshUpdate does not prompt on missing input', () => {
  assert.equal(decideDshUpdate('0.1.0-rc.6', null).prompt, false)
  assert.equal(decideDshUpdate(null, { latest: '0.1.0-rc.7', next: null }).prompt, false)
})

test('fetchLatestAppVersion strips the leading v from the GitHub release tag', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tag_name: 'v0.1.1' }) })
  assert.equal(await fetchLatestAppVersion({ fetchImpl }), '0.1.1')
})

test('fetchLatestAppVersion accepts tags without a v prefix', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tag_name: '0.1.1' }) })
  assert.equal(await fetchLatestAppVersion({ fetchImpl }), '0.1.1')
})

test('fetchLatestAppVersion returns null on failure', async () => {
  const fetchImpl = async () => {
    throw new Error('rate limited')
  }
  assert.equal(await fetchLatestAppVersion({ fetchImpl }), null)
})

test('shouldCheckUpdate allows a check when no prompt state exists', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-upstate-'))
  try {
    assert.equal(shouldCheckUpdate(path.join(dir, 'state.json'), 'dsh', 1_000), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shouldCheckUpdate suppresses a check within 24h of the last prompt', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-upstate-'))
  const stateFile = path.join(dir, 'state.json')
  try {
    markUpdatePrompted(stateFile, 'dsh', 2 * UPDATE_PROMPT_WINDOW_MS, '0.1.0-rc.7')
    assert.equal(shouldCheckUpdate(stateFile, 'dsh', 2 * UPDATE_PROMPT_WINDOW_MS + UPDATE_PROMPT_WINDOW_MS - 1), false)
    assert.equal(shouldCheckUpdate(stateFile, 'dsh', 2 * UPDATE_PROMPT_WINDOW_MS + UPDATE_PROMPT_WINDOW_MS), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shouldCheckUpdate tracks dsh and app independently', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-upstate-'))
  const stateFile = path.join(dir, 'state.json')
  try {
    const now = 2 * UPDATE_PROMPT_WINDOW_MS
    markUpdatePrompted(stateFile, 'dsh', now, '0.1.0-rc.7')
    assert.equal(shouldCheckUpdate(stateFile, 'app', now + 1_000), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shouldCheckUpdate treats a corrupted state file as empty', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-upstate-'))
  const stateFile = path.join(dir, 'state.json')
  try {
    writeFileSync(stateFile, 'not json {')
    assert.equal(shouldCheckUpdate(stateFile, 'dsh', 1_000), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrateLegacyUserData copies log and state from legacy dirs once', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-'))
  try {
    const legacy = path.join(dir, 'legacy')
    const legacyCapital = path.join(dir, 'legacy-capital')
    const newUserData = path.join(dir, 'new')
    mkdirSync(path.join(legacy), { recursive: true })
    mkdirSync(path.join(legacyCapital), { recursive: true })
    writeFileSync(path.join(legacy, 'dsh-desktop.log'), 'old log\n')
    writeFileSync(path.join(legacy, 'update-prompt-state.json'), '{"dsh":{"promptedAt":1}}')
    writeFileSync(path.join(legacyCapital, 'dsh-desktop.log'), 'capital log\n')

    const logFile = path.join(newUserData, 'logs', 'dsh-desktop.log')
    const stateFile = path.join(newUserData, 'update-prompt-state.json')
    migrateLegacyUserData({ legacyDirs: [legacy, legacyCapital], logFile, stateFile })

    assert.equal(readFileSync(logFile, 'utf8'), 'old log\n') // first legacy dir wins
    assert.equal(readFileSync(stateFile, 'utf8'), '{"dsh":{"promptedAt":1}}')

    // idempotent: a second run must not overwrite an existing destination
    writeFileSync(logFile, 'new log\n')
    migrateLegacyUserData({ legacyDirs: [legacy], logFile, stateFile })
    assert.equal(readFileSync(logFile, 'utf8'), 'new log\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrateLegacyUserData is a no-op without legacy files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-empty-'))
  try {
    const newDir = path.join(dir, 'new')
    migrateLegacyUserData({
      legacyDirs: [path.join(dir, 'missing-a'), path.join(dir, 'missing-b')],
      logFile: path.join(newDir, 'dsh-desktop.log'),
      stateFile: path.join(newDir, 'update-prompt-state.json'),
    })
    assert.equal(existsSync(path.join(newDir, 'dsh-desktop.log')), false)
    assert.equal(existsSync(path.join(newDir, 'update-prompt-state.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
