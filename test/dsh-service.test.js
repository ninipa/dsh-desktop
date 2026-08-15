import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildDshArgs,
  compareVersions,
  ensureMinimumReleaseAgeDisabled,
  extractReadyUrl,
  isMarketInstalled,
  resolveDshCommand,
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
