import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { DomainError, ErrorCode, openDomain } from '../src/index.ts'
import { DEFAULT_HARNESS_ID, MIGRATION_V1, MIGRATION_V2, SCHEMA_VERSION } from '../src/schema.ts'
import { openTemp, operator, profileInput } from './helpers.ts'

function v2Database(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'lachesis-v2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const databasePath = join(dir, 'domain.sqlite')
  const db = new DatabaseSync(databasePath)
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
    INSERT INTO schema_migrations VALUES (1, '2026-01-01T00:00:00Z');
    INSERT INTO schema_migrations VALUES (2, '2026-01-01T00:00:00Z');`)
  db.exec(MIGRATION_V1)
  db.exec(MIGRATION_V2)
  db.prepare(
    `INSERT INTO profiles (id, name, avatar_preset_id, provider_ref, model_id, reasoning_effort, revision, disabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`,
  ).run('p-effort', 'Reasoner', 'preset-1', 'local-ocg', 'test-model', 'high', '2026-01-01T00:00:00.000Z')
  db.prepare(
    `INSERT INTO profiles (id, name, avatar_preset_id, provider_ref, model_id, reasoning_effort, revision, disabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`,
  ).run('p-default', 'Default', 'preset-1', 'deepseek', 'v3', null, '2026-01-01T00:00:00.000Z')
  db.close()
  return databasePath
}

test('V3 migration packs legacy ACP fields into config_json', (t) => {
  const databasePath = v2Database(t)
  const before = new DatabaseSync(databasePath)
  assert.equal(
    (before.prepare("SELECT COUNT(*) AS total FROM pragma_table_info('profiles') WHERE name IN ('harness_id', 'config_json')")
      .get() as { total: number }).total,
    0,
  )
  before.close()

  const domain = openDomain({ databasePath, recoverInterrupted: false })
  try {
    assert.equal(domain.schemaVersion(), SCHEMA_VERSION)

    const withEffort = domain.getProfile('p-effort')
    assert.equal(withEffort.harnessId, DEFAULT_HARNESS_ID)
    assert.equal(withEffort.configJson, '{"providerRef":"local-ocg","modelId":"test-model","reasoningEffort":"high"}')
    assert.equal(withEffort.providerRef, 'local-ocg')
    assert.equal(withEffort.modelId, 'test-model')
    assert.equal(withEffort.reasoningEffort, 'high')

    const withoutEffort = domain.getProfile('p-default')
    assert.equal(withoutEffort.configJson, '{"providerRef":"deepseek","modelId":"v3","reasoningEffort":null}')
    assert.equal(withoutEffort.reasoningEffort, null)

    const migrated = new DatabaseSync(databasePath)
    try {
      const columns = migrated.prepare(
        "SELECT name, dflt_value FROM pragma_table_info('profiles') WHERE name IN ('harness_id', 'config_json') ORDER BY name",
      ).all() as Array<{ name: string; dflt_value: string }>
      assert.equal(columns.length, 2)
      assert.equal(columns[0].name, 'config_json')
      assert.equal(columns[0].dflt_value, "'{}'")
      assert.equal(columns[1].name, 'harness_id')
      assert.equal(columns[1].dflt_value, `'${DEFAULT_HARNESS_ID}'`)
      const raw = migrated.prepare('SELECT harness_id, config_json FROM profiles WHERE id = ?').get('p-effort') as
        { harness_id: string; config_json: string }
      assert.equal(raw.harness_id, DEFAULT_HARNESS_ID)
      assert.equal(raw.config_json, '{"providerRef":"local-ocg","modelId":"test-model","reasoningEffort":"high"}')
    } finally {
      migrated.close()
    }
  } finally {
    domain.close()
  }
})

test('rows without a stored harness config are rebuilt from the ACP columns', (t) => {
  const { domain, databasePath } = openTemp(t)
  const created = domain.createProfile(operator, profileInput())
  domain.close()
  const raw = new DatabaseSync(databasePath)
  raw.prepare('UPDATE profiles SET config_json = ?, provider_ref = ?, model_id = ? WHERE id = ?')
    .run('{}', 'local-ocg', 'recovered-model', created.id)
  raw.close()

  const reopened = openDomain({ databasePath, recoverInterrupted: false })
  t.after(() => reopened.close())
  const profile = reopened.getProfile(created.id)
  assert.equal(profile.harnessId, DEFAULT_HARNESS_ID)
  assert.equal(profile.configJson, '{"providerRef":"local-ocg","modelId":"recovered-model","reasoningEffort":null}')
  assert.equal(profile.providerRef, 'local-ocg')
  assert.equal(profile.modelId, 'recovered-model')
  assert.equal(profile.reasoningEffort, null)
})

test('profiles without harness input keep the dsh ACP contract', (t) => {
  const { domain } = openTemp(t)
  const profile = domain.createProfile(operator, profileInput())
  assert.equal(profile.harnessId, DEFAULT_HARNESS_ID)
  assert.deepEqual(JSON.parse(profile.configJson), { providerRef: 'deepseek', modelId: 'v3', reasoningEffort: null })
  const stored = domain.getProfile(profile.id)
  assert.deepEqual(stored, profile)
  assert.throws(
    () => domain.createProfile(operator, { ...profileInput('Broken'), modelId: '' }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.invalidInput,
  )
})

test('createProfile stores a foreign harness config without the dsh keys', (t) => {
  const { domain } = openTemp(t)
  const config = { model: 'gpt-5-codex', args: ['--yes-always'], autoCommits: false }
  const profile = domain.createProfile(operator, {
    name: 'Aider', avatarPresetId: 'preset-2', providerRef: '', modelId: '', reasoningEffort: null,
    harnessId: 'aider-0.86', configJson: JSON.stringify(config),
  })
  assert.equal(profile.harnessId, 'aider-0.86')
  assert.deepEqual(JSON.parse(profile.configJson), config)
  assert.equal(profile.providerRef, '')
  const listed = domain.listProfiles().items.find((item) => item.id === profile.id)
  assert.deepEqual(listed, profile)
})

test('createProfile derives the ACP columns from a dsh harness config', (t) => {
  const { domain } = openTemp(t)
  const config = { providerRef: 'local-ocg', modelId: 'v4', reasoningEffort: 'low' }
  const profile = domain.createProfile(operator, {
    name: 'From config', avatarPresetId: 'preset-3',
    providerRef: '', modelId: '', reasoningEffort: null,
    harnessId: DEFAULT_HARNESS_ID, configJson: JSON.stringify(config),
  })
  assert.equal(profile.providerRef, 'local-ocg')
  assert.equal(profile.modelId, 'v4')
  assert.equal(profile.reasoningEffort, 'low')
  assert.deepEqual(JSON.parse(profile.configJson), config)
})

test('harness input is validated', (t) => {
  const { domain } = openTemp(t)
  assert.throws(
    () => domain.createProfile(operator, { ...profileInput('Bad json'), configJson: 'not-json' }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.invalidInput,
  )
  assert.throws(
    () => domain.createProfile(operator, { ...profileInput('Bad shape'), configJson: '[1,2]' }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.invalidInput,
  )
  assert.throws(
    () => domain.createProfile(operator, { ...profileInput('No harness'), harnessId: '   ' }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.invalidInput,
  )
  assert.equal(domain.listProfiles().items.length, 0)
})

test('updateProfile keeps config_json in step with the ACP fields', (t) => {
  const { domain } = openTemp(t)
  const profile = domain.createProfile(operator, { ...profileInput(), reasoningEffort: 'low' })
  assert.deepEqual(JSON.parse(profile.configJson), { providerRef: 'deepseek', modelId: 'v3', reasoningEffort: 'low' })

  const renamed = domain.updateProfile(operator, profile.id, { name: 'Renamed' }, profile.revision)
  assert.equal(renamed.name, 'Renamed')
  assert.equal(renamed.revision, profile.revision)
  assert.deepEqual(JSON.parse(renamed.configJson), { providerRef: 'deepseek', modelId: 'v3', reasoningEffort: 'low' })

  const changed = domain.updateProfile(operator, profile.id, { modelId: 'v4', reasoningEffort: null }, renamed.revision)
  assert.equal(changed.revision, renamed.revision + 1)
  assert.deepEqual(JSON.parse(changed.configJson), { providerRef: 'deepseek', modelId: 'v4', reasoningEffort: null })
  assert.equal(domain.getProfile(profile.id).modelId, 'v4')
  const revisions = domain.listProfileRevisions(profile.id)
  assert.deepEqual(revisions.map((item) => item.revision), [1, 2])
  assert.deepEqual(revisions.map((item) => item.modelId), ['v3', 'v4'])
})

test('updateProfile can switch a profile to another harness', (t) => {
  const { domain } = openTemp(t)
  const profile = domain.createProfile(operator, profileInput())
  const switched = domain.updateProfile(operator, profile.id, {
    harnessId: 'aider-0.86', configJson: '{"model":"gpt-5-codex"}', providerRef: '', modelId: '',
  }, profile.revision)
  assert.equal(switched.harnessId, 'aider-0.86')
  assert.deepEqual(JSON.parse(switched.configJson), { model: 'gpt-5-codex' })
  assert.equal(switched.providerRef, '')

  const disabled = domain.updateProfile(operator, profile.id, { disabled: true }, switched.revision)
  assert.equal(disabled.revision, switched.revision)
  assert.equal(disabled.disabled, true)
  assert.deepEqual(JSON.parse(domain.getProfile(profile.id).configJson), { model: 'gpt-5-codex' })
})
