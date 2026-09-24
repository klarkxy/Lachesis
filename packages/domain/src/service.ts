import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import type {
  Application,
  ApplicationStatus,
  CreateIssueInput,
  CreateProfileInput,
  CreateProjectInput,
  Delivery,
  Evaluation,
  Evidence,
  FileChange,
  Id,
  Issue,
  IssueEvent,
  IssueStatus,
  Page,
  Profile,
  ProfileRevision,
  Project,
  Run,
  RunStatus,
  RunCheckpoint,
  SchedulerSettings,
  ProjectDispatchState,
  DispatchDecision,
  DispatchReason,
  SchedulerSnapshot,
  UpdateIssuePlanInput,
} from '@lachesis/contracts'
import { DomainError, ErrorCode } from './errors.ts'
import { MIGRATION_V1, MIGRATION_V2, SCHEMA_VERSION } from './schema.ts'
import type {
  Actor,
  ApplicationDetail,
  ApplicationOutcome,
  BindRunInput,
  Claim,
  ClaimOptions,
  DeliveryInput,
  EvaluateInput,
  IdempotencyRef,
  IssueComment,
  IssueDetail,
  ListEventsFilter,
  ListIssuesFilter,
  OpenDomainOptions,
  PendingQuestion,
  PendingQuestionItem,
  ProfileHistoryEntry,
  RecoveredRun,
  RunDetail,
  StoredMessage,
} from './types.ts'
import {
  asInt,
  asIntOrNull,
  asText,
  asTextOrNull,
  makeCursor,
  newId,
  nowIso,
  parseAfter,
  parseCursor,
  parseJson,
  sha256Json,
} from './util.ts'

type Row = Record<string, SQLOutputValue>

const LIVE_ISSUE = new Set<IssueStatus>(['starting', 'running', 'needs_input'])
const TERMINAL_ISSUE = new Set<IssueStatus>(['accepted', 'failed', 'cancelled', 'recovery_required'])
const LIVE_RUN = new Set<RunStatus>(['starting', 'running', 'needs_input', 'cancelling'])
const TERMINAL_RUN = new Set<RunStatus>(['completed', 'failed', 'cancelled', 'interrupted', 'recovery_required'])
const APPLYABLE = new Set<ApplicationStatus>(['ready'])
const DEFAULT_PAGE = 50
const OCCUPIED_RUN = "('starting','running','needs_input','cancelling','recovery_required')"

function assertRelativeFilePath(path: string): string {
  if (typeof path !== 'string' || !path || /[\0\\]/.test(path) || path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new DomainError(ErrorCode.invalidInput, 'File paths must be normalized relative paths')
  }
  return path
}

function normalizeScope(paths: string[] | undefined): string[] {
  if (paths === undefined) return []
  if (!Array.isArray(paths)) throw new DomainError(ErrorCode.invalidInput, 'Scope must be a list of paths')
  const normalized = paths.map((path) => {
    if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') ||
      /^[A-Za-z]:/.test(path) || /[\0*?\[\]{}]/.test(path)) {
      throw new DomainError(ErrorCode.invalidInput, 'Scope paths must be normalized relative paths')
    }
    const parts = path.endsWith('/') ? path.slice(0, -1).split('/') : path.split('/')
    if (parts.some((part) => !part || part === '.' || part === '..')) {
      throw new DomainError(ErrorCode.invalidInput, 'Scope paths must be normalized relative paths')
    }
    return path
  })
  return [...new Set(normalized)]
}

function pathMatches(path: string, scope: string): boolean {
  if (process.platform === 'win32') { path = path.toLowerCase(); scope = scope.toLowerCase() }
  return scope.endsWith('/') ? path.startsWith(scope) : path === scope
}

function scopesOverlap(left: string, right: string): boolean {
  if (process.platform === 'win32') { left = left.toLowerCase(); right = right.toLowerCase() }
  return left === right || (left.endsWith('/') && right.startsWith(left)) ||
    (right.endsWith('/') && left.startsWith(right))
}

function requireOperator(actor: Actor, action: string): void {
  if (actor.kind === 'worker') {
    throw new DomainError(ErrorCode.forbidden, `Workers cannot ${action}`)
  }
}

export function hasDependencyCycle(edges: Map<string, readonly string[]>): boolean {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of edges.get(id) ?? []) {
      if (visit(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  for (const id of edges.keys()) {
    if (visit(id)) return true
  }
  return false
}

export class DomainService {
  private readonly db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  static open(options: OpenDomainOptions): DomainService {
    const db = new DatabaseSync(options.databasePath, {
      timeout: options.busyTimeoutMs ?? 5000,
      enableForeignKeyConstraints: true,
    })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    const service = new DomainService(db)
    try {
      service.migrate()
      if (options.recoverInterrupted !== false) service.recoverInterrupted()
      return service
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
    return asInt(row?.version)
  }

  createProject(actor: Actor, input: CreateProjectInput): Project {
    requireOperator(actor, 'create projects')
    this.assertWorkspaceKind(input.kind)
    if (!input.name.trim()) throw new DomainError(ErrorCode.invalidInput, 'Project name is required')
    if (!input.rootPath.trim()) throw new DomainError(ErrorCode.invalidInput, 'Project rootPath is required')
    const project: Project = {
      id: newId(),
      name: input.name.trim(),
      kind: input.kind,
      rootPath: input.rootPath,
      targetBranch: input.targetBranch ?? null,
      verificationCommand: input.verificationCommand ?? null,
      createdAt: nowIso(),
    }
    this.tx(() => {
      this.db.prepare(
        `INSERT INTO projects (id, name, kind, root_path, target_branch, verification_command, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        project.id,
        project.name,
        project.kind,
        project.rootPath,
        project.targetBranch,
        project.verificationCommand,
        project.createdAt,
      )
      this.db.prepare('INSERT INTO project_dispatch (project_id, version, paused) VALUES (?, 1, 0)').run(project.id)
      this.emit(project.id, null, null, 'project.created', { name: project.name })
    })
    return project
  }

  getProject(id: Id): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    if (!row) throw new DomainError(ErrorCode.notFound, 'Project not found')
    return this.mapProject(row)
  }

  listProjects(): Page<Project> {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at ASC, id ASC').all()
    return { items: rows.map((row) => this.mapProject(row)), nextCursor: null }
  }

  getSchedulerSettings(): SchedulerSettings {
    const row = this.db.prepare('SELECT * FROM scheduler_settings WHERE id = 1').get()!
    return { version: asInt(row.version), globalMaxActive: asInt(row.global_max_active),
      profileLimits: parseJson<Record<string, number>>(row.profile_limits),
      providerLimits: parseJson<Record<string, number>>(row.provider_limits) }
  }

  updateSchedulerSettings(actor: Actor, input: Omit<SchedulerSettings, 'version'> & { expectedVersion: number }): SchedulerSettings {
    requireOperator(actor, 'change scheduler settings')
    const validLimit = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0
    if (!validLimit(input.globalMaxActive) || !Number.isSafeInteger(input.expectedVersion) ||
      !input.profileLimits || !input.providerLimits || Array.isArray(input.profileLimits) || Array.isArray(input.providerLimits)) {
      throw new DomainError(ErrorCode.invalidInput, 'Invalid scheduler settings')
    }
    for (const [profileId, limit] of Object.entries(input.profileLimits)) {
      this.getProfile(profileId)
      if (!validLimit(limit)) throw new DomainError(ErrorCode.invalidInput, 'Profile limit must be positive')
    }
    for (const [provider, limit] of Object.entries(input.providerLimits)) {
      if (!provider.trim() || !validLimit(limit)) throw new DomainError(ErrorCode.invalidInput, 'Provider limit must be positive')
    }
    return this.tx(() => {
      const current = this.getSchedulerSettings()
      if (current.version !== input.expectedVersion) throw new DomainError(ErrorCode.versionConflict, 'Scheduler version is stale')
      this.db.prepare(`UPDATE scheduler_settings SET version = version + 1, global_max_active = ?,
        profile_limits = ?, provider_limits = ? WHERE id = 1`).run(input.globalMaxActive,
        JSON.stringify(input.profileLimits), JSON.stringify(input.providerLimits))
      return this.getSchedulerSettings()
    })
  }

  getProjectDispatchState(projectId: Id): ProjectDispatchState {
    this.getProject(projectId)
    const row = this.db.prepare('SELECT * FROM project_dispatch WHERE project_id = ?').get(projectId)!
    const activeRunCount = asInt(this.db.prepare(`SELECT COUNT(*) AS count FROM runs r JOIN issues i ON i.id = r.issue_id
      WHERE i.project_id = ? AND r.status IN ${OCCUPIED_RUN}`).get(projectId)?.count)
    return { projectId, version: asInt(row.version), paused: asInt(row.paused) === 1,
      environmentBlock: row.environment_code === null ? null : { code: asText(row.environment_code),
        diagnostic: asText(row.environment_diagnostic), createdAt: asText(row.environment_created_at) },
      activeRunCount, drainComplete: activeRunCount === 0 }
  }

  setProjectPaused(actor: Actor, projectId: Id, paused: boolean, expectedVersion: number): ProjectDispatchState {
    requireOperator(actor, 'pause projects')
    if (typeof paused !== 'boolean') throw new DomainError(ErrorCode.invalidInput, 'paused must be boolean')
    return this.tx(() => {
      const current = this.getProjectDispatchState(projectId)
      if (current.version !== expectedVersion) throw new DomainError(ErrorCode.versionConflict, 'Project dispatch version is stale')
      this.db.prepare('UPDATE project_dispatch SET paused = ?, version = version + 1 WHERE project_id = ?').run(paused ? 1 : 0, projectId)
      this.emit(projectId, null, null, 'project.dispatch_updated', { paused })
      return this.getProjectDispatchState(projectId)
    })
  }

  blockProjectEnvironment(actor: Actor, projectId: Id, code: string, diagnostic: string): ProjectDispatchState {
    if (actor.kind !== 'worker') throw new DomainError(ErrorCode.forbidden, 'Only the supervisor may block an environment')
    if (!code.trim() || !diagnostic.trim()) throw new DomainError(ErrorCode.invalidInput, 'Environment diagnosis is required')
    return this.tx(() => {
      this.getProject(projectId)
      this.db.prepare(`UPDATE project_dispatch SET environment_code = ?, environment_diagnostic = ?,
        environment_created_at = ?, version = version + 1 WHERE project_id = ?`).run(code, diagnostic, nowIso(), projectId)
      this.emit(projectId, null, null, 'project.environment_blocked', { code, diagnostic })
      return this.getProjectDispatchState(projectId)
    })
  }

  clearProjectEnvironment(actor: Actor, projectId: Id, expectedVersion: number): ProjectDispatchState {
    if (actor.kind !== 'worker') throw new DomainError(ErrorCode.forbidden, 'Only the supervisor may clear an environment')
    return this.tx(() => {
      const current = this.getProjectDispatchState(projectId)
      if (current.version !== expectedVersion) throw new DomainError(ErrorCode.versionConflict, 'Project dispatch version is stale')
      this.db.prepare(`UPDATE project_dispatch SET environment_code = NULL, environment_diagnostic = NULL,
        environment_created_at = NULL, version = version + 1 WHERE project_id = ?`).run(projectId)
      this.emit(projectId, null, null, 'project.environment_cleared', {})
      return this.getProjectDispatchState(projectId)
    })
  }

  createProfile(actor: Actor, input: CreateProfileInput): Profile {
    requireOperator(actor, 'create profiles')
    this.assertProfileInput(input)
    const createdAt = nowIso()
    const profile: Profile = {
      id: newId(),
      name: input.name.trim(),
      avatarPresetId: input.avatarPresetId,
      providerRef: input.providerRef,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      revision: 1,
      disabled: false,
      createdAt,
    }
    this.tx(() => {
      this.db.prepare(
        `INSERT INTO profiles (id, name, avatar_preset_id, provider_ref, model_id, reasoning_effort, revision, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`,
      ).run(
        profile.id,
        profile.name,
        profile.avatarPresetId,
        profile.providerRef,
        profile.modelId,
        profile.reasoningEffort,
        createdAt,
      )
      this.db.prepare(
        `INSERT INTO profile_revisions (profile_id, revision, provider_ref, model_id, reasoning_effort, created_at)
         VALUES (?, 1, ?, ?, ?, ?)`,
      ).run(profile.id, profile.providerRef, profile.modelId, profile.reasoningEffort, createdAt)
    })
    return profile
  }

  getProfile(id: Id): Profile {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id)
    if (!row) throw new DomainError(ErrorCode.notFound, 'Profile not found')
    return this.mapProfile(row)
  }

  listProfiles(): Page<Profile> {
    const rows = this.db.prepare('SELECT * FROM profiles ORDER BY created_at ASC, id ASC').all()
    return { items: rows.map((row) => this.mapProfile(row)), nextCursor: null }
  }

  updateProfile(
    actor: Actor,
    id: Id,
    patch: Partial<CreateProfileInput> & { disabled?: boolean },
    expectedRevision: number,
  ): Profile {
    requireOperator(actor, 'update profiles')
    return this.tx(() => {
      const current = this.getProfile(id)
      if (current.revision !== expectedRevision) {
        throw new DomainError(ErrorCode.versionConflict, 'Profile revision is stale', {
          expectedRevision,
          actual: current.revision,
        })
      }
      const next = {
        name: patch.name !== undefined ? patch.name.trim() : current.name,
        avatarPresetId: patch.avatarPresetId ?? current.avatarPresetId,
        providerRef: patch.providerRef ?? current.providerRef,
        modelId: patch.modelId ?? current.modelId,
        reasoningEffort: patch.reasoningEffort !== undefined ? patch.reasoningEffort : current.reasoningEffort,
        disabled: patch.disabled ?? current.disabled,
      }
      if (!next.name) throw new DomainError(ErrorCode.invalidInput, 'Profile name is required')
      if (!next.avatarPresetId || !next.providerRef || !next.modelId) {
        throw new DomainError(ErrorCode.invalidInput, 'Profile configuration is incomplete')
      }
      if (next.disabled && !current.disabled) {
        const pending = this.db.prepare(
          `SELECT id FROM issues
           WHERE dispatch_mode = 'require' AND dispatch_profile_id = ? AND status IN ('queued', 'blocked')
           LIMIT 1`,
        ).get(id)
        if (pending) {
          throw new DomainError(ErrorCode.conflict, 'Resolve or cancel required issues before disabling this Profile', {
            issueId: asText(pending.id),
          })
        }
      }
      const configChanged =
        next.providerRef !== current.providerRef ||
        next.modelId !== current.modelId ||
        next.reasoningEffort !== current.reasoningEffort
      const revision = configChanged ? current.revision + 1 : current.revision
      const createdAt = nowIso()
      const result = this.db.prepare(
        `UPDATE profiles
         SET name = ?, avatar_preset_id = ?, provider_ref = ?, model_id = ?, reasoning_effort = ?, revision = ?, disabled = ?
         WHERE id = ? AND revision = ?`,
      ).run(
        next.name,
        next.avatarPresetId,
        next.providerRef,
        next.modelId,
        next.reasoningEffort,
        revision,
        next.disabled ? 1 : 0,
        id,
        expectedRevision,
      )
      if (Number(result.changes) === 0) {
        throw new DomainError(ErrorCode.versionConflict, 'Profile revision is stale')
      }
      if (configChanged) {
        this.db.prepare(
          `INSERT INTO profile_revisions (profile_id, revision, provider_ref, model_id, reasoning_effort, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, revision, next.providerRef, next.modelId, next.reasoningEffort, createdAt)
      }
      return this.getProfile(id)
    })
  }

  listProfileRevisions(id: Id): ProfileRevision[] {
    this.getProfile(id)
    return this.db.prepare('SELECT * FROM profile_revisions WHERE profile_id = ? ORDER BY revision ASC').all(id).map((row) => ({
      profileId: asText(row.profile_id),
      revision: asInt(row.revision),
      providerRef: asText(row.provider_ref),
      modelId: asText(row.model_id),
      reasoningEffort: asTextOrNull(row.reasoning_effort),
      createdAt: asText(row.created_at),
    }))
  }

  listProfileHistory(id: Id): ProfileHistoryEntry[] {
    const revisions = this.listProfileRevisions(id)
    const evals = this.db.prepare(
      'SELECT issue_id, profile_revision, score FROM evaluations WHERE profile_id = ? AND active = 1',
    ).all(id)
    const byRevision = new Map<number, { scores: number[]; issueIds: string[] }>()
    for (const row of evals) {
      const revision = asInt(row.profile_revision)
      const bucket = byRevision.get(revision) ?? { scores: [], issueIds: [] }
      bucket.scores.push(asInt(row.score))
      bucket.issueIds.push(asText(row.issue_id))
      byRevision.set(revision, bucket)
    }
    return revisions.map((revision) => {
      const bucket = byRevision.get(revision.revision)
      const evaluatedCount = bucket?.scores.length ?? 0
      return {
        revision: revision.revision,
        averageScore: evaluatedCount > 0
          ? bucket!.scores.reduce((sum, score) => sum + score, 0) / evaluatedCount
          : null,
        evaluatedCount,
        issueIds: bucket?.issueIds ?? [],
      }
    })
  }

  createIssue(actor: Actor, input: CreateIssueInput, idempotency: IdempotencyRef): Issue {
    requireOperator(actor, 'create issues')
    this.assertIssueInput(input)
    return this.withIdempotency(actor, input.projectId, 'issue.create', idempotency, () => {
      const project = this.getProject(input.projectId)
      const dependsOn = [...new Set(input.dependsOn ?? [])]
      const ownedPaths = normalizeScope(input.ownedPaths)
      const readOnlyPaths = normalizeScope(input.readOnlyPaths)
      if (input.dispatch.mode === 'require') {
        if (!input.dispatch.profileId) throw new DomainError(ErrorCode.invalidInput, 'require dispatch needs a profileId')
        this.assertRequiredProfileEnabled(input.dispatch.profileId)
      } else if (input.dispatch.profileId) {
        this.getProfile(input.dispatch.profileId)
      }
      for (const depId of dependsOn) {
        const dep = this.maybeIssue(depId)
        if (!dep) throw new DomainError(ErrorCode.notFound, 'Dependency issue not found', { dependsOn: depId })
        if (dep.projectId !== project.id) {
          throw new DomainError(ErrorCode.invalidInput, 'Dependencies must belong to the same project')
        }
      }
      const createdAt = nowIso()
      const status: IssueStatus = this.dependenciesSatisfied(dependsOn) ? 'queued' : 'blocked'
      const issueId = newId()
      this.assertAcyclic(issueId, dependsOn)
      const issue: Issue = {
        id: issueId,
        projectId: project.id,
        title: input.title.trim(),
        description: input.description,
        acceptanceCriteria: [...input.acceptanceCriteria],
        dispatch: { mode: input.dispatch.mode, profileId: input.dispatch.profileId ?? null },
        dependsOn,
        ownedPaths,
        readOnlyPaths,
        requesterRef: input.requesterRef,
        clientRequestId: input.clientRequestId ?? null,
        status,
        version: 1,
        currentRunId: null,
        acceptedDeliveryId: null,
        createdAt,
        updatedAt: createdAt,
      }
      try {
        this.db.prepare(
          `INSERT INTO issues (
            id, project_id, title, description, acceptance_criteria, dispatch_mode, dispatch_profile_id,
            requester_ref, client_request_id, status, version, generation, current_run_id, accepted_delivery_id,
            created_at, updated_at, owned_paths, read_only_paths
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?, ?, ?)`,
        ).run(
          issue.id,
          issue.projectId,
          issue.title,
          issue.description,
          JSON.stringify(issue.acceptanceCriteria),
          issue.dispatch.mode,
          issue.dispatch.profileId,
          issue.requesterRef,
          issue.clientRequestId,
          issue.status,
          createdAt,
          createdAt,
          JSON.stringify(ownedPaths),
          JSON.stringify(readOnlyPaths),
        )
      } catch (error) {
        if (isUniqueViolation(error) && issue.clientRequestId) {
          const existing = this.db.prepare(
            'SELECT * FROM issues WHERE project_id = ? AND requester_ref = ? AND client_request_id = ?',
          ).get(issue.projectId, issue.requesterRef, issue.clientRequestId)
          if (existing) return this.mapIssue(existing)
          throw new DomainError(ErrorCode.conflict, 'Duplicate clientRequestId')
        }
        throw error
      }
      for (const depId of dependsOn) {
        this.db.prepare('INSERT INTO issue_dependencies (issue_id, depends_on) VALUES (?, ?)').run(issue.id, depId)
      }
      this.emit(issue.projectId, issue.id, null, 'issue.created', { status: issue.status, title: issue.title })
      return this.getIssue(issue.id)
    })
  }

  getIssue(id: Id): Issue {
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id)
    if (!row) throw new DomainError(ErrorCode.notFound, 'Issue not found')
    return this.mapIssue(row)
  }

  updateIssuePlan(actor: Actor, issueId: Id, input: UpdateIssuePlanInput): Issue {
    requireOperator(actor, 'edit issue plans')
    return this.tx(() => {
      const issue = this.requireIssueVersion(issueId, input.expectedIssueVersion)
      if (issue.status !== 'queued' && issue.status !== 'blocked') throw new DomainError(ErrorCode.conflict, 'Only unstarted issues may be replanned')
      if (this.listRuns(issueId).length > 0) throw new DomainError(ErrorCode.conflict, 'Issue already has Run history')
      const dependsOn = input.dependsOn === undefined ? issue.dependsOn : [...new Set(input.dependsOn)]
      const ownedPaths = input.ownedPaths === undefined ? issue.ownedPaths ?? [] : normalizeScope(input.ownedPaths)
      const readOnlyPaths = input.readOnlyPaths === undefined ? issue.readOnlyPaths ?? [] : normalizeScope(input.readOnlyPaths)
      for (const depId of dependsOn) {
        const dep = this.maybeIssue(depId)
        if (!dep) throw new DomainError(ErrorCode.notFound, 'Dependency issue not found', { dependsOn: depId })
        if (dep.projectId !== issue.projectId) throw new DomainError(ErrorCode.invalidInput, 'Dependencies must belong to the same project')
      }
      this.assertAcyclic(issueId, dependsOn)
      const status = this.dependenciesSatisfied(dependsOn) ? 'queued' : 'blocked'
      this.db.prepare('DELETE FROM issue_dependencies WHERE issue_id = ?').run(issueId)
      for (const depId of dependsOn) this.db.prepare('INSERT INTO issue_dependencies (issue_id, depends_on) VALUES (?, ?)').run(issueId, depId)
      this.db.prepare(`UPDATE issues SET owned_paths = ?, read_only_paths = ?, status = ?, version = version + 1,
        updated_at = ? WHERE id = ?`).run(JSON.stringify(ownedPaths), JSON.stringify(readOnlyPaths), status, nowIso(), issueId)
      this.emit(issue.projectId, issue.id, null, 'issue.plan_updated', { dependsOn, ownedPaths, readOnlyPaths })
      return this.getIssue(issueId)
    })
  }

  getIssueDetail(id: Id): IssueDetail {
    const issue = this.getIssue(id)
    return {
      issue,
      runs: this.listRuns(id),
      deliveries: this.listDeliveries(id),
      evaluation: this.getActiveEvaluation(id),
      applications: this.listApplications(id),
      questions: this.listPendingQuestions(id),
      comments: this.listComments(id),
      checkpoints: this.listCheckpoints(id),
    }
  }

  listIssues(filter: ListIssuesFilter = {}): Page<Issue> {
    const limit = clampLimit(filter.limit)
    const params: SQLInputValue[] = []
    let sql = 'SELECT * FROM issues WHERE 1 = 1'
    if (filter.projectId) {
      sql += ' AND project_id = ?'
      params.push(filter.projectId)
    }
    if (filter.status) {
      sql += ' AND status = ?'
      params.push(filter.status)
    }
    if (filter.cursor) {
      let cursor: { createdAt: string; id: string }
      try {
        cursor = parseCursor(filter.cursor)
      } catch {
        throw new DomainError(ErrorCode.invalidInput, 'Invalid issue cursor')
      }
      sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))'
      params.push(cursor.createdAt, cursor.createdAt, cursor.id)
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'
    params.push(limit + 1)
    const rows = this.db.prepare(sql).all(...params)
    const extra = rows.length > limit
    const items = (extra ? rows.slice(0, limit) : rows).map((row) => this.mapIssue(row))
    const last = items[items.length - 1]
    return { items, nextCursor: extra && last ? makeCursor(last.createdAt, last.id) : null }
  }

  addIssueComment(actor: Actor, issueId: Id, text: string): IssueComment {
    requireOperator(actor, 'comment on issues')
    const trimmed = text.trim()
    if (!trimmed) throw new DomainError(ErrorCode.invalidInput, 'Comment text is required')
    return this.tx(() => {
      const issue = this.getIssue(issueId)
      const comment: IssueComment = {
        id: newId(),
        issueId,
        text: trimmed,
        author: actor.id,
        createdAt: nowIso(),
        delivered: false,
      }
      this.db.prepare(
        'INSERT INTO comments (id, issue_id, text, author, delivered, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      ).run(comment.id, issueId, trimmed, actor.id, comment.createdAt)
      this.emit(issue.projectId, issueId, issue.currentRunId, 'issue.commented', { commentId: comment.id })
      return comment
    })
  }

  markCommentDelivered(commentId: Id): IssueComment {
    const row = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId)
    if (!row) throw new DomainError(ErrorCode.notFound, 'Comment not found')
    this.db.prepare('UPDATE comments SET delivered = 1 WHERE id = ?').run(commentId)
    return this.mapComment(this.db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId)!)
  }

  listComments(issueId: Id): IssueComment[] {
    return this.db.prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC').all(issueId).map((row) => this.mapComment(row))
  }

  getReworkSourceDelivery(issueId: Id): Id | null {
    this.getIssue(issueId)
    const row = this.db.prepare(
      `SELECT type, data FROM events WHERE issue_id = ? AND type IN ('issue.reworked','issue.checkpoint_resumed') ORDER BY sequence DESC LIMIT 1`,
    ).get(issueId)
    if (!row) return null
    const data = parseJson<{ deliveryId?: unknown; checkpointId?: unknown }>(row.data)
    if (asText(row.type) === 'issue.checkpoint_resumed') return typeof data.checkpointId === 'string' ? data.checkpointId : null
    return typeof data.deliveryId === 'string' ? data.deliveryId : null
  }

  cancelIssue(actor: Actor, issueId: Id, expectedIssueVersion: number): Issue {
    requireOperator(actor, 'cancel issues')
    return this.tx(() => {
      const issue = this.requireIssueVersion(issueId, expectedIssueVersion)
      if (TERMINAL_ISSUE.has(issue.status)) {
        throw new DomainError(ErrorCode.conflict, 'Issue is already terminal')
      }
      const now = nowIso()
      this.advanceIssue(issue.id, 'cancelled', now)
      this.db.prepare('UPDATE issues SET accepted_delivery_id = accepted_delivery_id WHERE id = ?').run(issue.id)
      if (issue.currentRunId) {
        const run = this.getRun(issue.currentRunId).run
        if (LIVE_RUN.has(run.status)) {
          if (!this.hasConfirmedRunExit(run.id)) throw new DomainError(ErrorCode.conflict, 'Run process exit is unconfirmed')
          this.db.prepare(
            `UPDATE runs SET status = 'cancelled', ended_at = ? WHERE id = ? AND status IN ('starting','running','needs_input','cancelling')`,
          ).run(now, run.id)
          this.emit(issue.projectId, issue.id, run.id, 'run.cancelled', { reason: 'issue_cancelled' })
        }
      }
      this.emit(issue.projectId, issue.id, issue.currentRunId, 'issue.cancelled', {})
      return this.getIssue(issue.id)
    })
  }

  retryIssue(actor: Actor, issueId: Id, expectedIssueVersion: number): Issue {
    requireOperator(actor, 'retry issues')
    return this.tx(() => {
      const issue = this.requireIssueVersion(issueId, expectedIssueVersion)
      if (issue.status !== 'failed') {
        throw new DomainError(ErrorCode.conflict, 'Only failed issues can be retried')
      }
      if (issue.dispatch.mode === 'require') this.assertRequiredProfileEnabled(issue.dispatch.profileId!)
      const next: IssueStatus = this.dependenciesSatisfied(issue.dependsOn) ? 'queued' : 'blocked'
      const now = nowIso()
      this.advanceIssue(issue.id, next, now)
      this.db.prepare('UPDATE issues SET current_run_id = NULL WHERE id = ?').run(issue.id)
      this.emit(issue.projectId, issue.id, null, 'issue.retried', { previousRunId: issue.currentRunId })
      return this.getIssue(issue.id)
    })
  }

  acceptIssue(actor: Actor, issueId: Id, deliveryId: Id, expectedIssueVersion: number): Issue {
    requireOperator(actor, 'accept issues')
    return this.tx(() => {
      const issue = this.requireIssueVersion(issueId, expectedIssueVersion)
      if (issue.status !== 'awaiting_review') {
        throw new DomainError(ErrorCode.conflict, 'Issue is not awaiting review')
      }
      const delivery = this.getDelivery(deliveryId)
      if (delivery.issueId !== issue.id) throw new DomainError(ErrorCode.invalidInput, 'Delivery does not belong to this issue')
      if (delivery.runId !== issue.currentRunId) throw new DomainError(ErrorCode.conflict, 'Delivery is not from the current Run')
      this.assertDeliveryInScope(issue, delivery)
      const now = nowIso()
      this.advanceIssue(issue.id, 'accepted', now)
      this.db.prepare('UPDATE issues SET accepted_delivery_id = ? WHERE id = ?').run(delivery.id, issue.id)
      this.emit(issue.projectId, issue.id, delivery.runId, 'issue.accepted', { deliveryId: delivery.id })
      this.unblockDependents(issue.id)
      return this.getIssue(issue.id)
    })
  }

  reworkIssue(actor: Actor, issueId: Id, deliveryId: Id, instructions: string, expectedIssueVersion: number): Issue {
    requireOperator(actor, 'rework issues')
    const text = instructions.trim()
    if (!text) throw new DomainError(ErrorCode.invalidInput, 'Rework instructions are required')
    return this.tx(() => {
      const issue = this.requireIssueVersion(issueId, expectedIssueVersion)
      if (issue.status !== 'awaiting_review' && issue.status !== 'accepted') {
        throw new DomainError(ErrorCode.conflict, 'Issue is not awaiting review or accepted')
      }
      const delivery = this.getDelivery(deliveryId)
      if (delivery.issueId !== issue.id) throw new DomainError(ErrorCode.invalidInput, 'Delivery does not belong to this issue')
      if (issue.status === 'accepted') {
        if (issue.acceptedDeliveryId !== delivery.id) {
          throw new DomainError(ErrorCode.conflict, 'Rework must use the accepted delivery')
        }
        const unsafeApplication = this.db.prepare(
          `SELECT id, status FROM applications WHERE issue_id = ? AND status NOT IN ('failed', 'conflict') LIMIT 1`,
        ).get(issue.id)
        if (unsafeApplication) {
          throw new DomainError(ErrorCode.conflict, 'An integration is still active, ready, applied, or needs recovery', {
            applicationId: asText(unsafeApplication.id),
            status: asText(unsafeApplication.status),
          })
        }
        const activeDependent = this.db.prepare(
          `SELECT i.id, i.status FROM issues i
           JOIN issue_dependencies d ON d.issue_id = i.id
           WHERE d.depends_on = ? AND i.status NOT IN ('blocked', 'queued') LIMIT 1`,
        ).get(issue.id)
        if (activeDependent) {
          throw new DomainError(ErrorCode.conflict, 'A dependent issue has already started', {
            dependentIssueId: asText(activeDependent.id),
            status: asText(activeDependent.status),
          })
        }
      }
      const now = nowIso()
      const nextStatus: IssueStatus = this.dependenciesSatisfied(issue.dependsOn) ? 'queued' : 'blocked'
      if (issue.dispatch.mode === 'require') this.assertRequiredProfileEnabled(issue.dispatch.profileId!)
      this.advanceIssue(issue.id, nextStatus, now)
      if (issue.status === 'accepted') {
        this.db.prepare('UPDATE issues SET accepted_delivery_id = NULL WHERE id = ?').run(issue.id)
        const queuedDependents = this.db.prepare(
          `SELECT i.id FROM issues i JOIN issue_dependencies d ON d.issue_id = i.id
           WHERE d.depends_on = ? AND i.status = 'queued'`,
        ).all(issue.id)
        for (const row of queuedDependents) {
          const dependentId = asText(row.id)
          this.db.prepare(
            `UPDATE issues SET status = 'blocked', version = version + 1, updated_at = ? WHERE id = ?`,
          ).run(now, dependentId)
          this.emit(issue.projectId, dependentId, null, 'issue.blocked', { reworkedDependency: issue.id })
        }
      }
      this.db.prepare(
        'INSERT INTO comments (id, issue_id, text, author, delivered, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      ).run(newId(), issue.id, text, actor.id, now)
      this.emit(issue.projectId, issue.id, delivery.runId, 'issue.reworked', {
        deliveryId: delivery.id,
        previousRunId: issue.currentRunId,
      })
      return this.getIssue(issue.id)
    })
  }

  evaluateIssue(actor: Actor, issueId: Id, input: EvaluateInput, idempotency: IdempotencyRef): Evaluation {
    requireOperator(actor, 'evaluate issues')
    const issue = this.getIssue(issueId)
    return this.withIdempotency(actor, issue.projectId, 'issue.evaluate', idempotency, () => {
      const current = this.requireIssueVersion(issueId, input.expectedIssueVersion)
      if (current.status === 'cancelled') {
        throw new DomainError(ErrorCode.conflict, 'Cancelled issues cannot be evaluated')
      }
      if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
        throw new DomainError(ErrorCode.invalidInput, 'Score must be an integer from 1 to 5')
      }
      const run = this.getRun(input.runId).run
      if (run.issueId !== current.id) throw new DomainError(ErrorCode.invalidInput, 'Run does not belong to this issue')
      const deliveryId = input.deliveryId ?? null
      if (deliveryId) {
        const delivery = this.getDelivery(deliveryId)
        if (delivery.issueId !== current.id) throw new DomainError(ErrorCode.invalidInput, 'Delivery does not belong to this issue')
        if (delivery.runId !== run.id) throw new DomainError(ErrorCode.invalidInput, 'Delivery does not belong to the evaluated Run')
      }
      const previous = this.db.prepare('SELECT MAX(revision) AS revision FROM evaluations WHERE issue_id = ?').get(issueId)
      const revision = (asIntOrNull(previous?.revision) ?? 0) + 1
      const createdAt = nowIso()
      const id = newId()
      this.db.prepare('UPDATE evaluations SET active = 0 WHERE issue_id = ? AND active = 1').run(issueId)
      this.db.prepare(
        `INSERT INTO evaluations (
          id, issue_id, delivery_id, run_id, profile_id, profile_revision, score, comment, revision, active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(
        id,
        issueId,
        deliveryId,
        run.id,
        run.profileId,
        run.profileRevision,
        input.score,
        input.comment,
        revision,
        createdAt,
      )
      this.emit(current.projectId, issueId, run.id, 'evaluation.recorded', {
        score: input.score,
        revision,
        failedRun: run.status === 'failed',
      })
      return this.getActiveEvaluation(issueId)!
    })
  }

  listEvaluations(issueId: Id): Evaluation[] {
    this.getIssue(issueId)
    return this.db.prepare('SELECT * FROM evaluations WHERE issue_id = ? ORDER BY revision ASC').all(issueId).map((row) => this.mapEvaluation(row))
  }

  claimReadyIssue(actor: Actor, options: ClaimOptions): Claim | null {
    const profile = this.getProfile(options.profileId)
    if (profile.disabled) throw new DomainError(ErrorCode.conflict, 'Profile is disabled')
    return this.tx(() => {
      const rows = this.db.prepare(
        `SELECT * FROM issues
         WHERE status = 'queued'
           AND (
             (dispatch_mode = 'require' AND dispatch_profile_id = ?)
             OR dispatch_mode = 'auto'
           )
         ORDER BY created_at ASC, id ASC`,
      ).all(profile.id)
      for (const row of rows) {
        const issue = this.mapIssue(row)
        if (this.decisionFor(issue, profile).reason !== 'ready') continue
        const claimed = this.tryClaim(actor, issue, profile, options)
        if (claimed) return claimed
      }
      return null
    })
  }

  claimNextReadyIssue(actor: Actor): Claim | null {
    if (actor.kind !== 'worker') throw new DomainError(ErrorCode.forbidden, 'Only workers may claim issues')
    return this.tx(() => {
      const projects = this.listProjects().items
      const profiles = this.listProfiles().items.filter((profile) => !profile.disabled)
      const cursor = this.db.prepare('SELECT project_id, profile_id FROM scheduler_cursor WHERE id = 1').get()!
      const rotate = <T extends { id: string }>(items: T[], after: string | null): T[] => {
        const index = items.findIndex((item) => item.id === after)
        return index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index + 1)]
      }
      for (const project of rotate(projects, asTextOrNull(cursor.project_id))) {
        const issues = this.db.prepare(`SELECT * FROM issues WHERE project_id = ? AND status = 'queued'
          ORDER BY created_at ASC, id ASC`).all(project.id).map((row) => this.mapIssue(row))
        if (issues.length === 0) continue
        for (const profile of rotate(profiles, asTextOrNull(cursor.profile_id))) {
          for (const issue of issues) {
            if (this.decisionFor(issue, profile).reason !== 'ready') continue
            const claim = this.tryClaim(actor, issue, profile, { profileId: profile.id })
            if (claim) {
              this.db.prepare('UPDATE scheduler_cursor SET project_id = ?, profile_id = ? WHERE id = 1').run(project.id, profile.id)
              return claim
            }
          }
        }
      }
      return null
    })
  }

  getDispatchDecision(issueId: Id, profileId?: Id): DispatchDecision {
    const issue = this.getIssue(issueId)
    if (profileId) return this.decisionFor(issue, this.getProfile(profileId))
    const profiles = issue.dispatch.mode === 'require' && issue.dispatch.profileId
      ? [this.getProfile(issue.dispatch.profileId)] : this.listProfiles().items.filter((item) => !item.disabled)
    if (profiles.length === 0) return { issueId, profileId: null, reason: 'profile_unavailable', detail: 'No enabled Profile is available' }
    const decisions = profiles.map((profile) => this.decisionFor(issue, profile))
    return decisions.find((decision) => decision.reason === 'ready') ?? decisions[0]!
  }

  getSchedulerSnapshot(projectId?: Id): SchedulerSnapshot {
    if (projectId) this.getProject(projectId)
    const settings = this.getSchedulerSettings()
    const active = this.activeCounts()
    const projects = projectId ? [this.getProjectDispatchState(projectId)] :
      this.listProjects().items.map((project) => this.getProjectDispatchState(project.id))
    const params = projectId ? [projectId] : []
    const rows = this.db.prepare(`SELECT id FROM issues ${projectId ? 'WHERE project_id = ?' : ''}
      ORDER BY created_at ASC, id ASC`).all(...params)
    return { settings, activeRunCount: active.total, projects,
      profileActiveCounts: active.profiles, providerActiveCounts: active.providers,
      decisions: rows.map((row) => ({ ...this.getDispatchDecision(asText(row.id)), issueTitle: this.getIssue(asText(row.id)).title })) }
  }

  private activeCounts(): { total: number; profiles: Record<string, number>; providers: Record<string, number> } {
    const rows = this.db.prepare(`SELECT profile_id, provider_ref FROM runs WHERE status IN ${OCCUPIED_RUN}`).all()
    const profiles: Record<string, number> = {}
    const providers: Record<string, number> = {}
    for (const row of rows) {
      const profileId = asText(row.profile_id)
      const provider = asText(row.provider_ref)
      profiles[profileId] = (profiles[profileId] ?? 0) + 1
      providers[provider] = (providers[provider] ?? 0) + 1
    }
    return { total: rows.length, profiles, providers }
  }

  private decisionFor(issue: Issue, profile: Profile): DispatchDecision {
    const result = (reason: DispatchReason, detail: string): DispatchDecision =>
      ({ issueId: issue.id, profileId: profile.id, reason, detail })
    const statusReason: Partial<Record<IssueStatus, DispatchReason>> = {
      blocked: 'dependency', starting: 'running', running: 'running', needs_input: 'needs_input',
      awaiting_review: 'review', accepted: 'integration', failed: 'failed', cancelled: 'cancelled',
      recovery_required: 'recovery',
    }
    if (issue.status === 'accepted' && issue.acceptedDeliveryId) {
      const delivered = this.getDelivery(issue.acceptedDeliveryId)
      if (delivered.files.length === 0 || this.db.prepare(`SELECT id FROM applications WHERE issue_id = ?
        AND delivery_id = ? AND status = 'applied' LIMIT 1`).get(issue.id, delivered.id)) {
        return result('complete', 'Accepted result is applied')
      }
    }
    if (issue.status !== 'queued') return result(statusReason[issue.status] ?? 'complete', `Issue is ${issue.status}`)
    const recovery = this.projectTargetRecovery(issue.projectId)
    if (recovery) return result('recovery', `Project target requires recovery for application ${recovery.id}`)
    if (issue.dispatch.mode === 'require' && issue.dispatch.profileId !== profile.id) return result('profile_unavailable', 'Issue requires another Profile')
    if (profile.disabled) return result('profile_unavailable', 'Profile is disabled')
    if (!this.dependenciesSatisfied(issue.dependsOn)) return result('dependency', 'Dependencies must be accepted and applied')
    const dispatch = this.getProjectDispatchState(issue.projectId)
    if (dispatch.paused) return result('paused', 'Project dispatch is paused')
    if (dispatch.environmentBlock) return result('environment', dispatch.environmentBlock.diagnostic)
    const active = this.activeCounts()
    const settings = this.getSchedulerSettings()
    if (active.total >= settings.globalMaxActive) return result('global_capacity', 'Global capacity is full')
    if ((active.profiles[profile.id] ?? 0) >= (settings.profileLimits[profile.id] ?? Infinity)) return result('profile_capacity', 'Profile capacity is full')
    if ((active.providers[profile.providerRef] ?? 0) >= (settings.providerLimits[profile.providerRef] ?? Infinity)) return result('provider_capacity', 'Provider capacity is full')
    if ((issue.ownedPaths?.length ?? 0) > 0) {
      const occupied = this.db.prepare(`SELECT DISTINCT i.* FROM issues i JOIN runs r ON r.issue_id = i.id
        WHERE i.project_id = ? AND i.id != ? AND r.status IN ${OCCUPIED_RUN}`).all(issue.projectId, issue.id)
      if (occupied.some((row) => {
        const other = this.mapIssue(row)
        return (other.ownedPaths ?? []).some((path) => issue.ownedPaths!.some((own) => scopesOverlap(path, own)))
      })) return result('scope_busy', 'Declared ownership overlaps a running issue')
    }
    return result('ready', 'Ready to claim')
  }

  bindRun(_actor: Actor, runId: Id, expectedGeneration: number, input: BindRunInput): Run {
    return this.tx(() => {
      const { run, issue } = this.requireLiveClaim(runId, expectedGeneration)
      this.db.prepare(
        `UPDATE runs SET
           session_id = COALESCE(?, session_id),
           workspace_path = COALESCE(?, workspace_path),
           base_ref = COALESCE(?, base_ref)
         WHERE id = ?`,
      ).run(input.sessionId ?? null, input.workspacePath ?? null, input.baseRef ?? null, run.id)
      this.emit(issue.projectId, issue.id, run.id, 'run.bound', { sessionId: input.sessionId ?? null })
      return this.getRun(run.id).run
    })
  }

  markRunRunning(_actor: Actor, runId: Id, expectedGeneration: number): Run {
    return this.tx(() => {
      const { run, issue } = this.requireLiveClaim(runId, expectedGeneration)
      const now = nowIso()
      this.db.prepare(`UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`).run(now, run.id)
      this.db.prepare(`UPDATE issues SET status = 'running', version = version + 1, updated_at = ? WHERE id = ?`).run(now, issue.id)
      this.emit(issue.projectId, issue.id, run.id, 'run.started', {})
      this.emit(issue.projectId, issue.id, run.id, 'issue.started', {})
      return this.getRun(run.id).run
    })
  }

  askQuestion(_actor: Actor, runId: Id, expectedGeneration: number, items: PendingQuestionItem[]): PendingQuestion {
    if (items.length === 0) throw new DomainError(ErrorCode.invalidInput, 'Question items are required')
    return this.tx(() => {
      const { run, issue } = this.requireLiveClaim(runId, expectedGeneration)
      const createdAt = nowIso()
      const question: PendingQuestion = {
        id: newId(),
        runId: run.id,
        issueId: issue.id,
        createdAt,
        questions: items,
        answeredAt: null,
        answers: null,
      }
      this.db.prepare(
        `INSERT INTO questions (id, issue_id, run_id, generation, items, answers, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
      ).run(question.id, issue.id, run.id, expectedGeneration, JSON.stringify(items), createdAt)
      this.db.prepare(`UPDATE runs SET status = 'needs_input' WHERE id = ?`).run(run.id)
      this.db.prepare(`UPDATE issues SET status = 'needs_input', version = version + 1, updated_at = ? WHERE id = ?`).run(createdAt, issue.id)
      this.emit(issue.projectId, issue.id, run.id, 'question.asked', { questionId: question.id })
      return question
    })
  }

  answerQuestion(_actor: Actor, runId: Id, questionId: Id, answers: Record<string, string>): PendingQuestion {
    return this.tx(() => {
      const runRow = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
      if (!runRow) throw new DomainError(ErrorCode.notFound, 'Run not found')
      const run = this.mapRun(runRow)
      const issue = this.getIssue(run.issueId)
      if (!LIVE_RUN.has(run.status) || !LIVE_ISSUE.has(issue.status)) {
        throw new DomainError(ErrorCode.conflict, 'Question belongs to a Run that is no longer active')
      }
      const row = this.db.prepare('SELECT * FROM questions WHERE id = ? AND run_id = ?').get(questionId, runId)
      if (!row) throw new DomainError(ErrorCode.notFound, 'Question not found')
      if (asTextOrNull(row.answered_at)) {
        throw new DomainError(ErrorCode.conflict, 'Question is no longer pending')
      }
      if (asInt(row.generation) !== this.issueGeneration(issue.id) || issue.currentRunId !== run.id) {
        throw new DomainError(ErrorCode.lateResult, 'Question is stale after a newer generation')
      }
      const items = parseJson<PendingQuestionItem[]>(row.items)
      this.assertAnswers(items, answers)
      const answeredAt = nowIso()
      this.db.prepare('UPDATE questions SET answers = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL').run(
        JSON.stringify(answers),
        answeredAt,
        questionId,
      )
      const pending = this.db.prepare('SELECT COUNT(*) AS n FROM questions WHERE run_id = ? AND answered_at IS NULL').get(runId)
      if (asInt(pending?.n) === 0 && LIVE_RUN.has(run.status)) {
        this.db.prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(run.id)
        this.db.prepare(`UPDATE issues SET status = 'running', version = version + 1, updated_at = ? WHERE id = ?`).run(answeredAt, issue.id)
      }
      this.emit(issue.projectId, issue.id, run.id, 'question.answered', { questionId })
      return this.mapQuestion(this.db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId)!)
    })
  }

  addRunMessage(_actor: Actor, runId: Id, text: string): StoredMessage {
    const trimmed = text.trim()
    if (!trimmed) throw new DomainError(ErrorCode.invalidInput, 'Message text is required')
    const run = this.getRun(runId).run
    const createdAt = nowIso()
    const message: StoredMessage = {
      id: newId(),
      runId,
      text: trimmed,
      stored: true,
      delivered: false,
      createdAt,
    }
    this.db.prepare('INSERT INTO run_messages (id, run_id, text, delivered, created_at) VALUES (?, ?, ?, 0, ?)').run(
      message.id,
      run.id,
      trimmed,
      createdAt,
    )
    return message
  }

  listRunMessages(runId: Id): StoredMessage[] {
    this.getRun(runId)
    return this.db.prepare('SELECT * FROM run_messages WHERE run_id = ? ORDER BY created_at ASC, id ASC').all(runId)
      .map((row) => ({
        id: asText(row.id),
        runId: asText(row.run_id),
        text: asText(row.text),
        stored: true as const,
        delivered: asInt(row.delivered) !== 0,
        createdAt: asText(row.created_at),
      }))
  }

  markRunMessageDelivered(messageId: Id): void {
    this.db.prepare('UPDATE run_messages SET delivered = 1 WHERE id = ?').run(messageId)
  }

  completeRun(_actor: Actor, runId: Id, expectedGeneration: number, delivery: DeliveryInput): Delivery {
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM deliveries WHERE run_id = ?').get(runId)
      if (existing) {
        const current = this.mapDelivery(existing)
        const detail = this.getRun(runId)
        const issueGeneration = this.issueGeneration(detail.run.issueId)
        if (detail.facts.generation !== expectedGeneration || issueGeneration !== expectedGeneration) {
          throw new DomainError(ErrorCode.lateResult, 'Delivery belongs to a previous generation')
        }
        if (current.manifestSha256 !== delivery.manifestSha256) {
          throw new DomainError(ErrorCode.conflict, 'Run already has a different delivery')
        }
        return current
      }
      const { run, issue } = this.requireLiveClaim(runId, expectedGeneration)
      if (!LIVE_ISSUE.has(issue.status)) {
        throw new DomainError(ErrorCode.lateResult, 'Issue is no longer accepting run results')
      }
      this.assertDelivery(delivery)
      const createdAt = nowIso()
      const record: Delivery = {
        id: delivery.id ?? newId(),
        issueId: issue.id,
        runId: run.id,
        profileId: run.profileId,
        profileRevision: run.profileRevision,
        summary: delivery.summary,
        finalResponse: delivery.finalResponse ?? null,
        files: delivery.files,
        evidence: delivery.evidence,
        manifestSha256: delivery.manifestSha256,
        createdAt,
      }
      this.db.prepare(
        `INSERT INTO deliveries (
          id, issue_id, run_id, profile_id, profile_revision, summary, final_response, files, evidence, manifest_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.issueId,
        record.runId,
        record.profileId,
        record.profileRevision,
        record.summary,
        record.finalResponse,
        JSON.stringify(record.files),
        JSON.stringify(record.evidence),
        record.manifestSha256,
        createdAt,
      )
      this.db.prepare(`UPDATE runs SET status = 'completed', ended_at = ? WHERE id = ?`).run(createdAt, run.id)
      this.db.prepare(`UPDATE issues SET status = 'awaiting_review', version = version + 1, updated_at = ? WHERE id = ?`).run(createdAt, issue.id)
      this.emit(issue.projectId, issue.id, run.id, 'run.completed', { deliveryId: record.id })
      this.emit(issue.projectId, issue.id, run.id, 'issue.awaiting_review', { deliveryId: record.id })
      return record
    })
  }

  failRun(_actor: Actor, runId: Id, expectedGeneration: number, diagnostic: string): Run {
    return this.tx(() => {
      const runRow = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
      if (!runRow) throw new DomainError(ErrorCode.notFound, 'Run not found')
      const run = this.mapRun(runRow)
      if (run.status === 'failed' && asInt(runRow.generation) === expectedGeneration) return run
      const { issue } = this.requireLiveClaim(runId, expectedGeneration)
      const now = nowIso()
      this.db.prepare(`UPDATE runs SET status = 'failed', ended_at = ? WHERE id = ?`).run(now, run.id)
      this.db.prepare(`UPDATE issues SET status = 'failed', version = version + 1, updated_at = ? WHERE id = ?`).run(now, issue.id)
      this.emit(issue.projectId, issue.id, run.id, 'run.failed', { diagnostic })
      this.emit(issue.projectId, issue.id, run.id, 'issue.failed', { diagnostic })
      return this.getRun(run.id).run
    })
  }

  /** Fence a Run whose managed process range has not been proven empty. */
  requireRunRecovery(actor: Actor, runId: Id, expectedGeneration: number, diagnostic: string): Run {
    if (actor.kind !== 'worker') throw new DomainError(ErrorCode.forbidden, 'Only the run supervisor may require recovery')
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
      if (!row) throw new DomainError(ErrorCode.notFound, 'Run not found')
      const run = this.mapRun(row)
      if (run.status === 'recovery_required') return run
      const { issue } = this.requireLiveClaim(runId, expectedGeneration)
      const now = nowIso()
      this.db.prepare(`UPDATE runs SET status = 'recovery_required' WHERE id = ?`).run(run.id)
      this.db.prepare(
        `UPDATE issues SET status = 'recovery_required', version = version + 1, generation = generation + 1, updated_at = ? WHERE id = ?`,
      ).run(now, issue.id)
      this.emit(issue.projectId, issue.id, run.id, 'run.recovery_required', { diagnostic })
      this.emit(issue.projectId, issue.id, run.id, 'issue.recovery_required', { diagnostic })
      return this.getRun(run.id).run
    })
  }

  getRun(id: Id): RunDetail {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    if (!row) throw new DomainError(ErrorCode.notFound, 'Run not found')
    return {
      run: this.mapRun(row),
      facts: { generation: asInt(row.generation), claimedBy: asTextOrNull(row.claimed_by) },
    }
  }

  listRuns(issueId: Id): Run[] {
    return this.db.prepare('SELECT * FROM runs WHERE issue_id = ? ORDER BY attempt ASC').all(issueId).map((row) => this.mapRun(row))
  }

  hasConfirmedRunExit(runId: Id): boolean {
    this.getRun(runId)
    const row = this.db.prepare(`SELECT data FROM events WHERE run_id = ? AND type = 'run.process_exit'
      ORDER BY sequence DESC LIMIT 1`).get(runId)
    if (!row) return false
    return parseJson<{ rangeExited?: unknown }>(row.data).rangeExited === true
  }

  recordCheckpoint(actor: Actor, input: Omit<RunCheckpoint, 'createdAt'>): RunCheckpoint {
    if (actor.kind !== 'worker') throw new DomainError(ErrorCode.forbidden, 'Only the supervisor may record checkpoints')
    return this.tx(() => {
      const run = this.getRun(input.runId).run
      if (run.issueId !== input.issueId) throw new DomainError(ErrorCode.invalidInput, 'Checkpoint issue and Run differ')
      if (!['failed', 'cancelled', 'interrupted'].includes(run.status) || !this.hasConfirmedRunExit(run.id)) {
        throw new DomainError(ErrorCode.conflict, 'Checkpoint requires a confirmed stopped unfinished Run')
      }
      if (!/^[a-f0-9-]{36}$/i.test(input.id) || !input.manifestSha256.trim() || !Array.isArray(input.files)) {
        throw new DomainError(ErrorCode.invalidInput, 'Invalid checkpoint artifact')
      }
      const existing = this.db.prepare('SELECT * FROM run_checkpoints WHERE run_id = ?').get(run.id)
      if (existing) {
        if (asText(existing.id) === input.id && asText(existing.manifest_sha256) === input.manifestSha256) return this.mapCheckpoint(existing)
        throw new DomainError(ErrorCode.conflict, 'Run already has a checkpoint')
      }
      const createdAt = nowIso()
      this.db.prepare(`INSERT INTO run_checkpoints
        (id, issue_id, run_id, base_ref, manifest_sha256, files, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.issueId, input.runId,
        input.baseRef, input.manifestSha256, JSON.stringify(input.files), input.reason, createdAt)
      const issue = this.getIssue(input.issueId)
      this.emit(issue.projectId, issue.id, run.id, 'run.checkpoint_recorded', { checkpointId: input.id })
      return this.getCheckpoint(input.id)
    })
  }

  getCheckpoint(id: Id): RunCheckpoint {
    const row = this.db.prepare('SELECT * FROM run_checkpoints WHERE id = ?').get(id)
    if (!row) throw new DomainError(ErrorCode.notFound, 'Checkpoint not found')
    return this.mapCheckpoint(row)
  }

  listCheckpoints(issueId: Id): RunCheckpoint[] {
    this.getIssue(issueId)
    return this.db.prepare('SELECT * FROM run_checkpoints WHERE issue_id = ? ORDER BY created_at ASC, id ASC')
      .all(issueId).map((row) => this.mapCheckpoint(row))
  }

  resumeCheckpoint(actor: Actor, issueId: Id, checkpointId: Id, expectedIssueVersion: number): Issue {
    requireOperator(actor, 'resume checkpoints')
    return this.tx(() => {
      const issue = this.requireIssueVersion(issueId, expectedIssueVersion)
      const checkpoint = this.getCheckpoint(checkpointId)
      if (checkpoint.issueId !== issue.id) throw new DomainError(ErrorCode.invalidInput, 'Checkpoint belongs to another issue')
      const run = this.getRun(checkpoint.runId).run
      if (!['failed', 'cancelled', 'interrupted'].includes(run.status) || !this.hasConfirmedRunExit(run.id)) {
        throw new DomainError(ErrorCode.conflict, 'Checkpoint Run lacks confirmed exit proof')
      }
      if (!['failed', 'cancelled'].includes(issue.status) || issue.currentRunId !== run.id) {
        throw new DomainError(ErrorCode.conflict, 'Issue cannot resume this checkpoint')
      }
      if (issue.dispatch.mode === 'require') this.assertRequiredProfileEnabled(issue.dispatch.profileId!)
      const status = this.dependenciesSatisfied(issue.dependsOn) ? 'queued' : 'blocked'
      this.db.prepare(`UPDATE issues SET status = ?, current_run_id = NULL, version = version + 1,
        generation = generation + 1, updated_at = ? WHERE id = ?`).run(status, nowIso(), issue.id)
      this.emit(issue.projectId, issue.id, run.id, 'issue.checkpoint_resumed', { checkpointId })
      return this.getIssue(issue.id)
    })
  }

  getDelivery(id: Id): Delivery {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id)
    if (!row) throw new DomainError(ErrorCode.notFound, 'Delivery not found')
    return this.mapDelivery(row)
  }

  listDeliveries(issueId: Id): Delivery[] {
    return this.db.prepare('SELECT * FROM deliveries WHERE issue_id = ? ORDER BY created_at ASC, id ASC').all(issueId).map((row) => this.mapDelivery(row))
  }

  listPendingQuestions(issueId: Id): PendingQuestion[] {
    return this.db.prepare(`SELECT q.* FROM questions q
      JOIN runs r ON r.id = q.run_id
      JOIN issues i ON i.id = q.issue_id
      WHERE q.issue_id = ? AND q.answered_at IS NULL AND i.current_run_id = q.run_id
        AND r.status IN ('starting','running','needs_input','cancelling')
        AND i.status IN ('starting','running','needs_input')
      ORDER BY q.created_at ASC`).all(issueId).map((row) => this.mapQuestion(row))
  }

  createIntegration(actor: Actor, issueId: Id, deliveryId: Id, expectedIssueVersion: number, idempotency: IdempotencyRef): Application {
    requireOperator(actor, 'create integrations')
    const issue = this.getIssue(issueId)
    return this.withIdempotency(actor, issue.projectId, 'issue.integrate', idempotency, () => {
      this.assertProjectTargetSafe(issue.projectId)
      const current = this.requireIssueVersion(issueId, expectedIssueVersion)
      if (current.status !== 'accepted' || current.acceptedDeliveryId !== deliveryId) {
        throw new DomainError(ErrorCode.conflict, 'Integration requires the currently accepted delivery')
      }
      const delivery = this.getDelivery(deliveryId)
      if (delivery.issueId !== current.id) throw new DomainError(ErrorCode.invalidInput, 'Delivery does not belong to this issue')
      this.assertDeliveryInScope(current, delivery)
      const unsafe = this.db.prepare(`SELECT id, status FROM applications WHERE issue_id = ?
        AND status IN ('queued','integrating','applying','applied','recovery_required') LIMIT 1`).get(issueId)
      if (unsafe) throw new DomainError(ErrorCode.conflict, 'Another integration is active or needs recovery',
        { applicationId: asText(unsafe.id), status: asText(unsafe.status) })
      this.db.prepare(`UPDATE applications SET status = 'failed', diagnostic = 'Superseded by a new preparation',
        updated_at = ? WHERE issue_id = ? AND status = 'ready'`).run(nowIso(), issueId)
      const now = nowIso()
      const application: Application = {
        id: newId(),
        projectId: current.projectId,
        issueId: current.id,
        deliveryId: delivery.id,
        status: 'queued',
        expectedTarget: this.getProject(current.projectId).targetBranch,
        resultTarget: null,
        diagnostic: null,
        createdAt: now,
        updatedAt: now,
      }
      this.db.prepare(
        `INSERT INTO applications (
          id, project_id, issue_id, delivery_id, status, expected_target, result_target, diagnostic, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      ).run(
        application.id,
        application.projectId,
        application.issueId,
        application.deliveryId,
        application.status,
        application.expectedTarget,
        now,
        now,
      )
      this.emit(current.projectId, current.id, delivery.runId, 'application.created', { applicationId: application.id })
      return application
    })
  }

  getApplication(id: Id): Application {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id)
    if (!row) throw new DomainError(ErrorCode.notFound, 'Application not found')
    return this.mapApplication(row)
  }

  getApplicationDetail(id: Id): ApplicationDetail {
    return { application: this.getApplication(id), evidence: this.listApplicationEvidence(id) }
  }

  applyApplication(actor: Actor, applicationId: Id, expectedTarget: string | null, idempotency: IdempotencyRef): Application {
    requireOperator(actor, 'apply applications')
    const current = this.getApplication(applicationId)
    return this.withIdempotency(actor, current.projectId, 'application.apply', idempotency, () => {
      this.assertProjectTargetSafe(current.projectId)
      const application = this.getApplication(applicationId)
      if (!APPLYABLE.has(application.status)) {
        throw new DomainError(ErrorCode.conflict, 'Application cannot be applied in its current status')
      }
      const issue = this.getIssue(application.issueId)
      if (issue.status !== 'accepted' || issue.acceptedDeliveryId !== application.deliveryId) {
        throw new DomainError(ErrorCode.conflict, 'Application no longer targets the currently accepted delivery')
      }
      this.assertDeliveryInScope(issue, this.getDelivery(application.deliveryId))
      const newest = this.db.prepare('SELECT id FROM applications WHERE issue_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(application.issueId)
      if (asText(newest?.id) !== application.id) throw new DomainError(ErrorCode.conflict, 'Application was superseded')
      if (application.expectedTarget !== null && expectedTarget !== application.expectedTarget) {
        throw new DomainError(ErrorCode.versionConflict, 'expectedTarget does not match the application')
      }
      const now = nowIso()
      this.db.prepare(`UPDATE applications SET status = 'applying', updated_at = ? WHERE id = ?`).run(now, application.id)
      this.emit(application.projectId, application.issueId, null, 'application.applying', { applicationId: application.id })
      return this.getApplication(application.id)
    })
  }

  reportApplicationOutcome(_actor: Actor, applicationId: Id, outcome: ApplicationOutcome): Application {
    return this.tx(() => {
      const application = this.getApplication(applicationId)
      if (['failed', 'conflict', 'applied', 'recovery_required'].includes(application.status)) {
        throw new DomainError(ErrorCode.conflict, 'Application outcome is already final or requires recovery')
      }
      const now = nowIso()
      this.db.prepare(
        `UPDATE applications SET status = ?, expected_target = ?, result_target = ?, diagnostic = ?, updated_at = ? WHERE id = ?`,
      ).run(outcome.status, outcome.expectedTarget === undefined ? application.expectedTarget : outcome.expectedTarget,
        outcome.resultTarget ?? null, outcome.diagnostic ?? null, now, application.id)
      if (outcome.evidence) {
        this.db.prepare('DELETE FROM application_evidence WHERE application_id = ?').run(application.id)
        outcome.evidence.forEach((item, index) => {
          this.db.prepare(
            `INSERT INTO application_evidence (application_id, ordinal, kind, label, outcome, detail)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(application.id, index, item.kind, item.label, item.outcome, item.detail)
        })
      }
      this.emit(application.projectId, application.issueId, null, 'application.updated', {
        applicationId: application.id,
        status: outcome.status,
      })
      if (outcome.status === 'applied') this.unblockDependents(application.issueId)
      return this.getApplication(application.id)
    })
  }

  listApplications(issueId: Id): Application[] {
    return this.db.prepare('SELECT * FROM applications WHERE issue_id = ? ORDER BY created_at ASC, id ASC').all(issueId).map((row) => this.mapApplication(row))
  }

  private projectTargetRecovery(projectId: Id): Application | null {
    const row = this.db.prepare(`SELECT * FROM applications WHERE project_id = ? AND status = 'recovery_required'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(projectId)
    return row ? this.mapApplication(row) : null
  }

  private assertProjectTargetSafe(projectId: Id): void {
    const recovery = this.projectTargetRecovery(projectId)
    if (recovery) throw new DomainError(ErrorCode.conflict, 'Project target requires recovery before integration or application',
      { applicationId: recovery.id, issueId: recovery.issueId })
  }

  listEvents(filter: ListEventsFilter = {}): Page<IssueEvent> {
    const limit = clampLimit(filter.limit)
    let after: number
    try {
      after = parseAfter(filter.after)
    } catch {
      throw new DomainError(ErrorCode.invalidInput, 'Invalid event cursor')
    }
    const params: SQLInputValue[] = [after]
    let sql = 'SELECT * FROM events WHERE sequence > ?'
    if (filter.projectId) {
      sql += ' AND project_id = ?'
      params.push(filter.projectId)
    }
    if (filter.runId) {
      sql += ' AND run_id = ?'
      params.push(filter.runId)
    }
    sql += ' ORDER BY sequence ASC LIMIT ?'
    params.push(limit + 1)
    const rows = this.db.prepare(sql).all(...params)
    const extra = rows.length > limit
    const items = (extra ? rows.slice(0, limit) : rows).map((row) => this.mapEvent(row))
    const last = items[items.length - 1]
    return { items, nextCursor: extra && last ? String(last.sequence) : null }
  }

  recordRunEvent(actor: Actor, runId: Id, expectedGeneration: number, type: string, data: unknown): void {
    if (actor.kind !== 'worker') throw new DomainError(ErrorCode.forbidden, 'Only the run supervisor may record execution events')
    if (!type.startsWith('run.')) throw new DomainError(ErrorCode.invalidInput, 'Execution events must use the run namespace')
    if (type === 'run.process_exit' && (typeof data !== 'object' || data === null ||
      !('rangeExited' in data) || typeof data.rangeExited !== 'boolean')) {
      throw new DomainError(ErrorCode.invalidInput, 'Process exit event requires a boolean rangeExited')
    }
    this.tx(() => {
      const detail = this.getRun(runId)
      const issue = this.getIssue(detail.run.issueId)
      if (detail.facts.generation !== expectedGeneration || issue.currentRunId !== runId) {
        throw new DomainError(ErrorCode.lateResult, 'Execution event belongs to a superseded run')
      }
      this.emit(issue.projectId, issue.id, runId, type, data)
    })
  }

  recoverInterrupted(): RecoveredRun[] {
    return this.tx(() => {
      const live = this.db.prepare(
        `SELECT * FROM runs WHERE status IN ('starting','running','needs_input','cancelling','recovery_required')`,
      ).all()
      const recovered: RecoveredRun[] = []
      const now = nowIso()
      for (const row of live) {
        const run = this.mapRun(row)
        const previousStatus = run.status
        const exited = this.hasConfirmedRunExit(run.id)
        if (previousStatus === 'recovery_required' && !exited) continue
        const nextRun: RunStatus = exited ? 'interrupted' : 'recovery_required'
        this.db.prepare(`UPDATE runs SET status = ?, ended_at = ? WHERE id = ?`).run(nextRun, exited ? now : null, run.id)
        const issue = this.getIssue(run.issueId)
        if (LIVE_ISSUE.has(issue.status) || issue.status === 'recovery_required') {
          const next: IssueStatus = exited ? 'failed' : 'recovery_required'
          this.db.prepare(
            `UPDATE issues SET status = ?, version = version + 1, generation = generation + 1, updated_at = ? WHERE id = ?`,
          ).run(next, now, issue.id)
          this.emit(issue.projectId, issue.id, run.id, 'issue.recovered', { status: next })
        }
        this.emit(issue.projectId, issue.id, run.id, exited ? 'run.interrupted' : 'run.recovery_required', { previousStatus })
        recovered.push({ runId: run.id, issueId: issue.id, previousStatus })
      }
      const pending = this.db.prepare(`SELECT * FROM applications WHERE status IN ('queued','integrating','applying')`).all()
      for (const row of pending) {
        const application = this.mapApplication(row)
        const unsafe = application.status !== 'queued'
        this.db.prepare(
          `UPDATE applications SET status = ?, diagnostic = ?, updated_at = ? WHERE id = ?`,
        ).run(unsafe ? 'recovery_required' : 'failed', unsafe
          ? 'Application was interrupted after preparation began. Inspect the target and preserved backup before preparing a new candidate.'
          : 'Preparation had not begun when the service stopped; create a new candidate.', now, application.id)
        this.emit(application.projectId, application.issueId, null, unsafe ? 'application.recovery_required' : 'application.failed', {
          applicationId: application.id,
        })
      }
      return recovered
    })
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `)
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
    const version = row?.version === null || row?.version === undefined ? 0 : asInt(row.version)
    if (version > SCHEMA_VERSION) throw new DomainError(ErrorCode.conflict, 'Database schema is newer than this Lachesis version')
    if (version < 1) this.tx(() => {
      this.db.exec(MIGRATION_V1)
      this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(nowIso())
    })
    if (version < 2) this.tx(() => {
      this.db.exec(MIGRATION_V2)
      this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(nowIso())
    })
  }

  private tx<T>(fn: () => T): T {
    const nested = this.db.isTransaction
    if (!nested) this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      if (!nested) this.db.exec('COMMIT')
      return value
    } catch (error) {
      if (!nested && this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  private withIdempotency<T>(actor: Actor, projectId: Id, operation: string, ref: IdempotencyRef, fn: () => T): T {
    if (!ref.key.trim()) throw new DomainError(ErrorCode.invalidInput, 'Idempotency-Key is required')
    return this.tx(() => {
      const hash = sha256Json(ref.body)
      const existing = this.db.prepare(
        `SELECT body_hash, result_json FROM idempotency
         WHERE actor_id = ? AND project_id = ? AND operation = ? AND key = ?`,
      ).get(actor.id, projectId, operation, ref.key)
      if (existing) {
        if (asText(existing.body_hash) !== hash) {
          throw new DomainError(ErrorCode.idempotencyConflict, 'Idempotency-Key was reused with a different body')
        }
        return JSON.parse(asText(existing.result_json)) as T
      }
      const result = fn()
      this.db.prepare(
        `INSERT INTO idempotency (actor_id, project_id, operation, key, body_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(actor.id, projectId, operation, ref.key, hash, JSON.stringify(result), nowIso())
      return result
    })
  }

  private emit(projectId: string, issueId: string | null, runId: string | null, type: string, data: unknown): void {
    this.db.prepare(
      'INSERT INTO events (project_id, issue_id, run_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(projectId, issueId, runId, type, JSON.stringify(data), nowIso())
  }

  private maybeIssue(id: Id): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id)
    return row ? this.mapIssue(row) : null
  }

  private assertRequiredProfileEnabled(profileId: Id): void {
    if (this.getProfile(profileId).disabled) {
      throw new DomainError(ErrorCode.conflict, 'Required dispatch Profile is disabled', { profileId })
    }
  }

  private requireIssueVersion(id: Id, expected: number): Issue {
    const issue = this.getIssue(id)
    if (issue.version !== expected) {
      throw new DomainError(ErrorCode.versionConflict, 'Issue version is stale', { expected, actual: issue.version })
    }
    return issue
  }

  private issueGeneration(id: Id): number {
    const row = this.db.prepare('SELECT generation FROM issues WHERE id = ?').get(id)
    if (!row) throw new DomainError(ErrorCode.notFound, 'Issue not found')
    return asInt(row.generation)
  }

  private advanceIssue(id: Id, status: IssueStatus, now: string): void {
    this.db.prepare(
      `UPDATE issues SET status = ?, version = version + 1, generation = generation + 1, updated_at = ? WHERE id = ?`,
    ).run(status, now, id)
  }

  private tryClaim(actor: Actor, issue: Issue, profile: Profile, options: ClaimOptions): Claim | null {
    if (issue.dispatch.mode === 'require' && issue.dispatch.profileId !== profile.id) return null
    const now = nowIso()
    const runId = newId()
    const generation = this.issueGeneration(issue.id) + 1
    const attemptRow = this.db.prepare('SELECT COALESCE(MAX(attempt), 0) AS attempt FROM runs WHERE issue_id = ?').get(issue.id)
    const attempt = asInt(attemptRow?.attempt) + 1
    const updated = this.db.prepare(
      `UPDATE issues
       SET status = 'starting', version = version + 1, generation = ?, current_run_id = ?, updated_at = ?
       WHERE id = ? AND status = 'queued' AND generation = ?`,
    ).run(generation, runId, now, issue.id, generation - 1)
    if (Number(updated.changes) === 0) return null
    const workspacePath = options.workspacePath ?? this.getProject(issue.projectId).rootPath
    try {
      this.db.prepare(
        `INSERT INTO runs (
          id, issue_id, attempt, status, profile_id, profile_revision, provider_ref, model_id, reasoning_effort,
          session_id, workspace_path, base_ref, generation, claimed_by, started_at, ended_at
        ) VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        runId,
        issue.id,
        attempt,
        profile.id,
        profile.revision,
        profile.providerRef,
        profile.modelId,
        profile.reasoningEffort,
        workspacePath,
        options.baseRef ?? null,
        generation,
        actor.id,
      )
    } catch (error) {
      if (isUniqueViolation(error)) return null
      throw error
    }
    this.emit(issue.projectId, issue.id, runId, 'issue.claimed', {
      runId,
      generation,
      profileId: profile.id,
      attempt,
    })
    return {
      issue: this.getIssue(issue.id),
      run: this.getRun(runId).run,
      generation,
    }
  }

  private requireLiveClaim(runId: Id, expectedGeneration: number): { run: Run; issue: Issue } {
    const detail = this.getRun(runId)
    const run = detail.run
    const issue = this.getIssue(run.issueId)
    const generation = this.issueGeneration(issue.id)
    if (generation !== expectedGeneration || detail.facts.generation !== expectedGeneration) {
      throw new DomainError(ErrorCode.lateResult, 'Run generation does not match the current claim', {
        expectedGeneration,
        issueGeneration: generation,
        runGeneration: detail.facts.generation,
      })
    }
    if (issue.currentRunId !== run.id) {
      throw new DomainError(ErrorCode.lateResult, 'Run is not the current claim')
    }
    if (TERMINAL_RUN.has(run.status) || TERMINAL_ISSUE.has(issue.status)) {
      throw new DomainError(ErrorCode.lateResult, 'Run is no longer active')
    }
    return { run, issue }
  }

  private dependenciesOf(issueId: Id): string[] {
    return this.db.prepare('SELECT depends_on FROM issue_dependencies WHERE issue_id = ?').all(issueId).map((row) => asText(row.depends_on))
  }

  private allDependencyEdges(): Map<string, string[]> {
    const edges = new Map<string, string[]>()
    for (const row of this.db.prepare('SELECT id FROM issues').all()) {
      edges.set(asText(row.id), [])
    }
    for (const row of this.db.prepare('SELECT issue_id, depends_on FROM issue_dependencies').all()) {
      const list = edges.get(asText(row.issue_id)) ?? []
      list.push(asText(row.depends_on))
      edges.set(asText(row.issue_id), list)
    }
    return edges
  }

  private assertAcyclic(issueId: string, dependsOn: readonly string[]): void {
    if (dependsOn.includes(issueId)) {
      throw new DomainError(ErrorCode.circularDependency, 'An issue cannot depend on itself')
    }
    const edges = this.allDependencyEdges()
    edges.set(issueId, [...dependsOn])
    if (hasDependencyCycle(edges)) {
      throw new DomainError(ErrorCode.circularDependency, 'Issue dependencies form a cycle')
    }
  }

  private dependenciesSatisfied(dependsOn: readonly string[]): boolean {
    const edges = this.allDependencyEdges()
    if (hasDependencyCycle(edges)) {
      throw new DomainError(ErrorCode.circularDependency, 'Issue dependencies form a cycle')
    }
    for (const depId of dependsOn) {
      const dep = this.maybeIssue(depId)
      if (!dep || dep.status !== 'accepted') return false
      if (dep.acceptedDeliveryId) {
        const delivery = this.getDelivery(dep.acceptedDeliveryId)
        if (delivery.files.length > 0) {
          const applied = this.db.prepare(
            `SELECT id FROM applications WHERE issue_id = ? AND delivery_id = ? AND status = 'applied' LIMIT 1`,
          ).get(dep.id, delivery.id)
          if (!applied) return false
        }
      }
    }
    return true
  }

  private unblockDependents(acceptedId: Id): void {
    const dependents = this.db.prepare('SELECT issue_id FROM issue_dependencies WHERE depends_on = ?').all(acceptedId)
    for (const row of dependents) {
      const issue = this.getIssue(asText(row.issue_id))
      if (issue.status !== 'blocked') continue
      if (this.dependenciesSatisfied(issue.dependsOn)) {
        const now = nowIso()
        this.db.prepare(
          `UPDATE issues SET status = 'queued', version = version + 1, updated_at = ? WHERE id = ? AND status = 'blocked'`,
        ).run(now, issue.id)
        this.emit(issue.projectId, issue.id, null, 'issue.unblocked', { acceptedDependency: acceptedId })
      }
    }
  }

  private listApplicationEvidence(id: Id): Evidence[] {
    return this.db.prepare('SELECT * FROM application_evidence WHERE application_id = ? ORDER BY ordinal ASC').all(id).map((row) => ({
      kind: asText(row.kind) as Evidence['kind'],
      label: asText(row.label),
      outcome: asText(row.outcome) as Evidence['outcome'],
      detail: asTextOrNull(row.detail),
    }))
  }

  private getActiveEvaluation(issueId: Id): Evaluation | null {
    const row = this.db.prepare('SELECT * FROM evaluations WHERE issue_id = ? AND active = 1').get(issueId)
    return row ? this.mapEvaluation(row) : null
  }

  private assertWorkspaceKind(kind: string): void {
    if (kind !== 'git' && kind !== 'files') throw new DomainError(ErrorCode.invalidInput, 'Invalid workspace kind')
  }

  private assertProfileInput(input: CreateProfileInput): void {
    if (!input.name.trim()) throw new DomainError(ErrorCode.invalidInput, 'Profile name is required')
    if (!input.avatarPresetId.trim() || !input.providerRef.trim() || !input.modelId.trim()) {
      throw new DomainError(ErrorCode.invalidInput, 'Profile configuration is incomplete')
    }
  }

  private assertIssueInput(input: CreateIssueInput): void {
    if (!input.title.trim()) throw new DomainError(ErrorCode.invalidInput, 'Issue title is required')
    if (input.dispatch.mode !== 'require' && input.dispatch.mode !== 'auto') {
      throw new DomainError(ErrorCode.invalidInput, 'Invalid dispatch mode')
    }
  }

  private assertDelivery(input: DeliveryInput): void {
    if (input.id !== undefined && !/^[a-f0-9-]{36}$/i.test(input.id)) {
      throw new DomainError(ErrorCode.invalidInput, 'Delivery id must be a UUID')
    }
    if (!input.summary.trim()) throw new DomainError(ErrorCode.invalidInput, 'Delivery summary is required')
    if (!input.manifestSha256.trim()) throw new DomainError(ErrorCode.invalidInput, 'manifestSha256 is required')
    if (!Array.isArray(input.files) || !Array.isArray(input.evidence)) {
      throw new DomainError(ErrorCode.invalidInput, 'Delivery files and evidence must be arrays')
    }
  }

  private assertDeliveryInScope(issue: Issue, delivery: Delivery): void {
    const outside = delivery.files.filter((file) => {
      const path = assertRelativeFilePath(file.path)
      return (issue.readOnlyPaths ?? []).some((scope) => pathMatches(path, scope)) ||
        ((issue.ownedPaths?.length ?? 0) > 0 && !issue.ownedPaths!.some((scope) => pathMatches(path, scope)))
    }).map((file) => file.path)
    if (outside.length > 0) throw new DomainError(ErrorCode.conflict, 'Delivery changes files outside the issue scope', { files: outside })
  }

  private assertAnswers(items: PendingQuestionItem[], answers: Record<string, string>): void {
    for (const item of items) {
      if (item.required && !(answers[item.id] ?? '').trim()) {
        throw new DomainError(ErrorCode.invalidInput, `Answer required for ${item.id}`)
      }
    }
  }

  private mapProject(row: Row): Project {
    return {
      id: asText(row.id),
      name: asText(row.name),
      kind: asText(row.kind) as Project['kind'],
      rootPath: asText(row.root_path),
      targetBranch: asTextOrNull(row.target_branch),
      verificationCommand: asTextOrNull(row.verification_command),
      createdAt: asText(row.created_at),
    }
  }

  private mapProfile(row: Row): Profile {
    return {
      id: asText(row.id),
      name: asText(row.name),
      avatarPresetId: asText(row.avatar_preset_id),
      providerRef: asText(row.provider_ref),
      modelId: asText(row.model_id),
      reasoningEffort: asTextOrNull(row.reasoning_effort),
      revision: asInt(row.revision),
      disabled: asInt(row.disabled) === 1,
      createdAt: asText(row.created_at),
    }
  }

  private mapIssue(row: Row): Issue {
    const id = asText(row.id)
    return {
      id,
      projectId: asText(row.project_id),
      title: asText(row.title),
      description: asText(row.description),
      acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria),
      dispatch: {
        mode: asText(row.dispatch_mode) as Issue['dispatch']['mode'],
        profileId: asTextOrNull(row.dispatch_profile_id),
      },
      dependsOn: this.dependenciesOf(id),
      ownedPaths: parseJson<string[]>(row.owned_paths),
      readOnlyPaths: parseJson<string[]>(row.read_only_paths),
      requesterRef: asText(row.requester_ref),
      clientRequestId: asTextOrNull(row.client_request_id),
      status: asText(row.status) as IssueStatus,
      version: asInt(row.version),
      currentRunId: asTextOrNull(row.current_run_id),
      acceptedDeliveryId: asTextOrNull(row.accepted_delivery_id),
      createdAt: asText(row.created_at),
      updatedAt: asText(row.updated_at),
    }
  }

  private mapRun(row: Row): Run {
    return {
      id: asText(row.id),
      issueId: asText(row.issue_id),
      attempt: asInt(row.attempt),
      status: asText(row.status) as RunStatus,
      profileId: asText(row.profile_id),
      profileRevision: asInt(row.profile_revision),
      providerRef: asText(row.provider_ref),
      modelId: asText(row.model_id),
      reasoningEffort: asTextOrNull(row.reasoning_effort),
      sessionId: asTextOrNull(row.session_id),
      workspacePath: asText(row.workspace_path),
      baseRef: asTextOrNull(row.base_ref),
      startedAt: asTextOrNull(row.started_at),
      endedAt: asTextOrNull(row.ended_at),
    }
  }

  private mapDelivery(row: Row): Delivery {
    return {
      id: asText(row.id),
      issueId: asText(row.issue_id),
      runId: asText(row.run_id),
      profileId: asText(row.profile_id),
      profileRevision: asInt(row.profile_revision),
      summary: asText(row.summary),
      finalResponse: asTextOrNull(row.final_response),
      files: parseJson<FileChange[]>(row.files),
      evidence: parseJson<Evidence[]>(row.evidence),
      manifestSha256: asText(row.manifest_sha256),
      createdAt: asText(row.created_at),
    }
  }

  private mapCheckpoint(row: Row): RunCheckpoint {
    return { id: asText(row.id), issueId: asText(row.issue_id), runId: asText(row.run_id),
      baseRef: asTextOrNull(row.base_ref), manifestSha256: asText(row.manifest_sha256),
      files: parseJson<FileChange[]>(row.files), reason: asText(row.reason), createdAt: asText(row.created_at) }
  }

  private mapEvaluation(row: Row): Evaluation {
    return {
      id: asText(row.id),
      issueId: asText(row.issue_id),
      deliveryId: asTextOrNull(row.delivery_id),
      runId: asText(row.run_id),
      profileId: asText(row.profile_id),
      profileRevision: asInt(row.profile_revision),
      score: asInt(row.score),
      comment: asText(row.comment),
      revision: asInt(row.revision),
      active: asInt(row.active) === 1,
      createdAt: asText(row.created_at),
    }
  }

  private mapApplication(row: Row): Application {
    return {
      id: asText(row.id),
      projectId: asText(row.project_id),
      issueId: asText(row.issue_id),
      deliveryId: asText(row.delivery_id),
      status: asText(row.status) as ApplicationStatus,
      expectedTarget: asTextOrNull(row.expected_target),
      resultTarget: asTextOrNull(row.result_target),
      diagnostic: asTextOrNull(row.diagnostic),
      createdAt: asText(row.created_at),
      updatedAt: asText(row.updated_at),
    }
  }

  private mapEvent(row: Row): IssueEvent {
    return {
      sequence: asInt(row.sequence),
      projectId: asText(row.project_id),
      issueId: asTextOrNull(row.issue_id),
      runId: asTextOrNull(row.run_id),
      type: asText(row.type),
      data: JSON.parse(asText(row.data)) as unknown,
      createdAt: asText(row.created_at),
    }
  }

  private mapComment(row: Row): IssueComment {
    return {
      id: asText(row.id),
      issueId: asText(row.issue_id),
      text: asText(row.text),
      author: asText(row.author),
      createdAt: asText(row.created_at),
      delivered: asInt(row.delivered) === 1,
    }
  }

  private mapQuestion(row: Row): PendingQuestion {
    return {
      id: asText(row.id),
      runId: asText(row.run_id),
      issueId: asText(row.issue_id),
      createdAt: asText(row.created_at),
      questions: parseJson<PendingQuestionItem[]>(row.items),
      answeredAt: asTextOrNull(row.answered_at),
      answers: row.answers === null ? null : parseJson<Record<string, string>>(row.answers),
    }
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE
  return Math.min(Math.max(1, Math.floor(limit)), 200)
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}
