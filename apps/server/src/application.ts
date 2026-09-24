import { isAbsolute, join, relative } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type {
  CreateIssueInput,
  CreateProfileInput,
  CreateProjectInput,
  Id,
  IssueEvent,
  Page,
  SchedulerSettings,
  UpdateIssuePlanInput,
} from '@lachesis/contracts'
import { openDomain, type DomainService, type IdempotencyRef } from '@lachesis/domain'
import type { Actor as AuthActor } from './auth.js'
import { RunSupervisor } from './supervisor.js'
import { DataRootLease } from './instance.js'
import { RangeExitUnconfirmedError, type DshAcpExecutor } from '@lachesis/runtime'

export class ApplicationError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
  }
}

export interface OperationContext {
  actor: AuthActor
  idempotencyKey: string | null
}

export interface OperationInvoker {
  invoke(operation: string, input: Record<string, unknown>, context: OperationContext): Promise<unknown>
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApplicationError('invalid_input', 400, `${key} must be a nonempty string`)
  }
  return value
}

function number(input: Record<string, unknown>, key: string): number {
  const value = input[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApplicationError('invalid_input', 400, `${key} must be an integer`)
  }
  return value
}

export class LachesisApplication implements OperationInvoker {
  readonly domain: DomainService
  readonly supervisor: RunSupervisor
  private registrationQueue: Promise<unknown> = Promise.resolve()
  private readonly operations = new Set<Promise<unknown>>()
  private stopping = false
  private operationRangeUnconfirmed = false
  private closing: Promise<void> | null = null

  static async open(dataRoot: string, runtime?: DshAcpExecutor): Promise<LachesisApplication> {
    const lease = await DataRootLease.acquire(dataRoot)
    try {
      return new LachesisApplication(lease, runtime)
    } catch (error) {
      await lease.release()
      throw error
    }
  }

  private constructor(private readonly lease: DataRootLease, runtime?: DshAcpExecutor) {
    const domain = openDomain(join(lease.dataRoot, 'lachesis.sqlite'))
    try {
      this.supervisor = new RunSupervisor(domain, lease.dataRoot, runtime)
      this.domain = domain
    } catch (error) {
      domain.close()
      throw error
    }
  }

  get dataRoot(): string { return this.lease.dataRoot }

  start(): void {
    this.supervisor.start()
  }

  async close(): Promise<void> {
    this.stopping = true
    this.closing ??= (async () => {
      // Keep the process-lifetime lease if range shutdown failed. Releasing it
      // would let a second service recover the database while an old Job may live.
      let failure: unknown
      try { await this.supervisor.stop() } catch (error) { failure = error }
      // Preparation, application and verification may outlive an HTTP client.
      // Keep both the database and the process lease until accepted work settles.
      await Promise.allSettled([...this.operations])
      if (this.operationRangeUnconfirmed) throw new RangeExitUnconfirmedError('Verification process exit is unconfirmed; the data lease is retained')
      if (failure) throw failure
      try { this.domain.close() }
      finally { await this.lease.release() }
    })()
    await this.closing
  }

  private perform<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new ApplicationError('service_stopping', 503, 'Lachesis is stopping'))
    const operation = Promise.resolve().then(work)
    this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => {})
    return operation
  }

  private async serialProject<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    return this.supervisor.workspace.withTargetLock(this.domain.getProject(projectId).rootPath, work)
  }

  private targetNeedsRecovery(projectId: string, excludingId: string): boolean {
    // Evaluate after acquiring the target lock: another candidate may have failed
    // after this request passed its initial domain transition.
    let cursor: string | null = null
    do {
      const page = this.domain.listIssues({ projectId, limit: 100, ...(cursor ? { cursor } : {}) })
      for (const issue of page.items) {
        if (this.domain.listApplications(issue.id).some((item) => item.id !== excludingId && item.status === 'recovery_required')) return true
      }
      cursor = page.nextCursor
    } while (cursor)
    return false
  }

  private async createProject(actor: { kind: 'operator'; id: string }, input: CreateProjectInput) {
    const create = async () => {
      if (typeof input.rootPath !== 'string' || !isAbsolute(input.rootPath)) throw new ApplicationError('invalid_path', 400, 'Project path must be absolute')
      const rootPath = await realpath(input.rootPath)
      if (!(await stat(rootPath)).isDirectory()) throw new ApplicationError('invalid_path', 400, 'Project path must be a directory')
      const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
      const overlaps = (a: string, b: string) => {
        const rel = relative(key(a), key(b))
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel))
      }
      const dataPath = await realpath(this.dataRoot)
      if (overlaps(dataPath, rootPath) || overlaps(rootPath, dataPath)) {
        throw new ApplicationError('invalid_path', 400, 'Project and service data directories must not overlap')
      }
      for (const project of this.domain.listProjects().items) {
        const existing = await realpath(project.rootPath)
        if (overlaps(existing, rootPath) || overlaps(rootPath, existing)) {
          throw new ApplicationError('target_overlap', 409, 'This target overlaps a registered project; use that project')
        }
      }
      return this.domain.createProject(actor, { ...input, rootPath })
    }
    const pending = this.registrationQueue.catch(() => {}).then(create)
    this.registrationQueue = pending
    return pending
  }

  private guardPermission(actor: AuthActor, operation: string): void {
    if (actor.kind !== 'token') return
    const map: Record<string, string> = {
      'project.list': 'project.read', 'project.get': 'project.read', 'project.create': 'project.create',
      'profile.list': 'profile.read', 'profile.get': 'profile.read', 'profile.history': 'profile.read',
      'profile.create': 'profile.create', 'profile.update': 'profile.update',
      'issue.list': 'issue.read', 'issue.get': 'issue.read', 'issue.create': 'issue.create',
      'issue.comment': 'issue.comment', 'issue.cancel': 'issue.cancel', 'issue.retry': 'issue.retry',
      'issue.accept': 'issue.accept', 'issue.rework': 'issue.rework', 'issue.evaluate': 'issue.evaluate',
      'run.get': 'run.read', 'run.events': 'run.read', 'run.message': 'run.message',
      'question.answer': 'question.answer', 'application.prepare': 'application.prepare',
      'application.get': 'application.read', 'application.apply': 'application.apply',
      'events.list': 'events.read', 'events.wait': 'events.read',
      'scheduler.get': 'scheduler.read', 'scheduler.update': 'scheduler.write',
      'project.dispatch': 'project.read', 'project.pause': 'project.control', 'project.readiness': 'project.control',
      'issue.plan': 'issue.create', 'issue.checkpoints': 'issue.read', 'issue.resume': 'issue.retry',
      'run.checkpoint': 'issue.rework', 'application.verification': 'application.read',
    }
    const permission = map[operation]
    if (!permission || (!actor.permissions?.includes(permission) && !actor.permissions?.includes('*'))) {
      throw new ApplicationError('permission_denied', 403, 'This token cannot perform the requested action')
    }
  }

  private guardProject(actor: AuthActor, projectId: Id): void {
    if (actor.projectIds !== null && !actor.projectIds.includes(projectId)) {
      throw new ApplicationError('project_denied', 403, 'This client cannot access the project')
    }
  }

  private guardIssue(actor: AuthActor, issueId: Id): void {
    this.guardProject(actor, this.domain.getIssue(issueId).projectId)
  }

  private guardRun(actor: AuthActor, runId: Id): void {
    this.guardIssue(actor, this.domain.getRun(runId).run.issueId)
  }

  private guardApplication(actor: AuthActor, id: Id): void {
    this.guardProject(actor, this.domain.getApplication(id).projectId)
  }

  readDeliveryFile(actor: AuthActor, deliveryId: Id, path: string) {
    return this.perform(async () => {
      const delivery = this.domain.getDelivery(deliveryId)
      this.guardIssue(actor, delivery.issueId)
      return this.supervisor.workspace.readDeliveryFile(deliveryId, path)
    })
  }

  readCheckpointFile(actor: AuthActor, checkpointId: Id, path: string) {
    return this.perform(async () => {
      const checkpoint = this.domain.getCheckpoint(checkpointId)
      this.guardIssue(actor, checkpoint.issueId)
      return this.supervisor.workspace.readDeliveryFile(checkpoint.id, path)
    })
  }

  private idem(context: OperationContext, body: unknown): IdempotencyRef {
    if (!context.idempotencyKey) {
      throw new ApplicationError('idempotency_key_required', 400, 'Idempotency-Key is required')
    }
    return { key: context.idempotencyKey, body }
  }

  async invoke(operation: string, input: Record<string, unknown>, context: OperationContext): Promise<unknown> {
    return this.perform(() => this.invokeOpen(operation, input, context))
  }

  private async invokeOpen(operation: string, input: Record<string, unknown>, context: OperationContext): Promise<unknown> {
    this.guardPermission(context.actor, operation)
    const actor = { kind: 'operator' as const, id: context.actor.id }
    switch (operation) {
      case 'scheduler.get': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : undefined
        if (projectId) this.guardProject(context.actor, projectId)
        if (!projectId && context.actor.projectIds !== null) {
          throw new ApplicationError('project_required', 400, 'Specify a project for scheduler access')
        }
        return this.domain.getSchedulerSnapshot(projectId)
      }
      case 'scheduler.update': {
        if (context.actor.kind !== 'browser') throw new ApplicationError('permission_denied', 403, 'Only the local operator can change service capacity')
        const settings = this.domain.updateSchedulerSettings(actor, input as unknown as Omit<SchedulerSettings, 'version'> & { expectedVersion: number })
        this.supervisor.wake()
        return settings
      }
      case 'project.dispatch': {
        const projectId = text(input, 'projectId')
        this.guardProject(context.actor, projectId)
        return this.domain.getProjectDispatchState(projectId)
      }
      case 'project.pause': {
        const projectId = text(input, 'projectId')
        this.guardProject(context.actor, projectId)
        if (typeof input.paused !== 'boolean') throw new ApplicationError('invalid_input', 400, 'paused must be a boolean')
        const state = this.domain.setProjectPaused(actor, projectId, input.paused, number(input, 'expectedVersion'))
        this.supervisor.wake()
        return state
      }
      case 'project.readiness': {
        const projectId = text(input, 'projectId')
        this.guardProject(context.actor, projectId)
        const result = await this.supervisor.checkProjectReadiness(projectId, number(input, 'expectedVersion'))
        this.supervisor.wake()
        return result
      }
      case 'project.list': {
        const result = this.domain.listProjects()
        return context.actor.projectIds === null ? result : {
          items: result.items.filter((project) => context.actor.projectIds?.includes(project.id)),
          nextCursor: null,
        }
      }
      case 'project.get': {
        const project = this.domain.getProject(text(input, 'projectId'))
        this.guardProject(context.actor, project.id)
        return project
      }
      case 'project.create': {
        if (context.actor.kind !== 'browser') throw new ApplicationError('permission_denied', 403, 'Only the local operator can create projects')
        return this.createProject(actor, input as unknown as CreateProjectInput)
      }
      case 'profile.list': return this.domain.listProfiles()
      case 'profile.capabilities': {
        if (context.actor.kind !== 'browser') throw new ApplicationError('permission_denied', 403, 'Only the local operator can inspect model capabilities')
        return this.supervisor.probeProfileCapabilities(text(input, 'providerRef'), text(input, 'modelId'))
      }
      case 'profile.get': return this.domain.getProfile(text(input, 'profileId'))
      case 'profile.create': {
        if (context.actor.kind !== 'browser') throw new ApplicationError('permission_denied', 403, 'Only the local operator can create profiles')
        return this.domain.createProfile(actor, input as unknown as CreateProfileInput)
      }
      case 'profile.update': {
        if (context.actor.kind !== 'browser') throw new ApplicationError('permission_denied', 403, 'Only the local operator can edit profiles')
        const profileId = text(input, 'profileId')
        const expectedRevision = number(input, 'expectedRevision')
        const { profileId: _id, expectedRevision: _version, ...changes } = input
        return this.domain.updateProfile(actor, profileId, changes as Partial<CreateProfileInput> & { disabled?: boolean }, expectedRevision)
      }
      case 'profile.history': return this.domain.listProfileHistory(text(input, 'profileId'))
      case 'issue.list': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : undefined
        const status = typeof input.status === 'string' ? input.status : undefined
        const cursor = typeof input.cursor === 'string' ? input.cursor : undefined
        const parsedLimit = typeof input.limit === 'string' ? Number(input.limit) : input.limit
        const limit = typeof parsedLimit === 'number' && Number.isInteger(parsedLimit) ? parsedLimit : undefined
        if (projectId) this.guardProject(context.actor, projectId)
        if (!projectId && context.actor.projectIds !== null) {
          const groups = context.actor.projectIds.map((id) => this.domain.listIssues({ projectId: id,
            ...(status ? { status: status as any } : {}) }).items)
          return { items: groups.flat(), nextCursor: null }
        }
        return this.domain.listIssues({ ...(projectId ? { projectId } : {}), ...(status ? { status: status as any } : {}),
          ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) })
      }
      case 'issue.create': {
        const projectId = text(input, 'projectId')
        this.guardProject(context.actor, projectId)
        const issue = this.domain.createIssue(actor, input as unknown as CreateIssueInput, this.idem(context, input))
        this.supervisor.wake()
        return issue
      }
      case 'issue.get': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        return this.domain.getIssueDetail(issueId)
      }
      case 'issue.plan': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        const issue = this.domain.updateIssuePlan(actor, issueId, input as unknown as UpdateIssuePlanInput)
        this.supervisor.wake()
        return issue
      }
      case 'issue.checkpoints': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        return this.domain.listCheckpoints(issueId)
      }
      case 'issue.resume': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        const issue = this.domain.resumeCheckpoint(actor, issueId, text(input, 'checkpointId'), number(input, 'expectedIssueVersion'))
        this.supervisor.wake()
        return issue
      }
      case 'issue.comment': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        return this.domain.addIssueComment(actor, issueId, text(input, 'text'))
      }
      case 'issue.cancel': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        return this.supervisor.cancel(issueId, number(input, 'expectedIssueVersion'), actor.id)
      }
      case 'issue.retry': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        const issue = this.domain.retryIssue(actor, issueId, number(input, 'expectedIssueVersion'))
        this.supervisor.wake()
        return issue
      }
      case 'issue.accept': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        return this.domain.acceptIssue(actor, issueId, text(input, 'deliveryId'), number(input, 'expectedIssueVersion'))
      }
      case 'issue.rework': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        const deliveryId = text(input, 'deliveryId')
        const latestFailure = this.domain.listApplications(issueId).filter((item) => item.deliveryId === deliveryId &&
          ['failed', 'conflict'].includes(item.status)).at(-1)
        const report = latestFailure ? await this.supervisor.workspace.readVerification(latestFailure.id) : null
        const instructions = [text(input, 'instructions'), latestFailure ?
          `Integration failure (${latestFailure.id}):\n${report?.summary ?? latestFailure.diagnostic ?? latestFailure.status}` : '',
          report ? `Verification command: ${JSON.stringify(report.command)}\nExit: ${report.exitCode ?? report.signal ?? 'unknown'}; output truncated: ${report.truncated}` : '',
        ].filter(Boolean).join('\n\n')
        const issue = this.domain.reworkIssue(actor, issueId, deliveryId, instructions, number(input, 'expectedIssueVersion'))
        this.supervisor.wake()
        return issue
      }
      case 'issue.evaluate': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        const body = {
          runId: text(input, 'runId'),
          deliveryId: typeof input.deliveryId === 'string' ? input.deliveryId : null,
          score: number(input, 'score'),
          comment: typeof input.comment === 'string' ? input.comment : '',
          expectedIssueVersion: number(input, 'expectedIssueVersion'),
        }
        return this.domain.evaluateIssue(actor, issueId, body, this.idem(context, input))
      }
      case 'run.get': {
        const runId = text(input, 'runId')
        this.guardRun(context.actor, runId)
        return this.domain.getRun(runId)
      }
      case 'run.checkpoint': {
        const runId = text(input, 'runId')
        this.guardRun(context.actor, runId)
        return this.supervisor.createCheckpoint(runId)
      }
      case 'run.events': {
        const runId = text(input, 'runId')
        this.guardRun(context.actor, runId)
        return this.domain.listEvents({ runId, after: typeof input.after === 'string' ? input.after : null,
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}) })
      }
      case 'run.message': {
        const runId = text(input, 'runId')
        this.guardRun(context.actor, runId)
        return this.domain.addRunMessage(actor, runId, text(input, 'text'))
      }
      case 'question.answer': {
        const runId = text(input, 'runId')
        this.guardRun(context.actor, runId)
        if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) {
          throw new ApplicationError('invalid_input', 400, 'answers must be an object')
        }
        return this.supervisor.answerQuestion(runId, text(input, 'questionId'), input.answers as Record<string, string>, actor.id)
      }
      case 'application.prepare': {
        const issueId = text(input, 'issueId')
        this.guardIssue(context.actor, issueId)
        const issue = this.domain.getIssue(issueId)
        if (issue.status !== 'accepted') throw new ApplicationError('not_accepted', 409, 'Accept the delivery before preparing an application')
        const application = this.domain.createIntegration(actor, issueId, text(input, 'deliveryId'), number(input, 'expectedIssueVersion'), this.idem(context, input))
        return this.serialProject(application.projectId, async () => {
          const current = this.domain.getApplication(application.id)
          if (current.status !== 'queued') return current
          if (this.targetNeedsRecovery(current.projectId, current.id)) {
            return this.domain.reportApplicationOutcome(actor, current.id, { status: 'failed', diagnostic: 'Project target requires recovery before further integration' })
          }
          const project = this.domain.getProject(current.projectId)
          this.domain.reportApplicationOutcome(actor, current.id, { status: 'integrating' })
          try {
            const outcome = await this.supervisor.workspace.integrate({
              applicationId: current.id,
              deliveryId: current.deliveryId,
              projectRoot: project.rootPath,
              targetBranch: project.targetBranch,
              verificationCommand: project.verificationCommand,
            })
            return this.domain.reportApplicationOutcome(actor, current.id, outcome)
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'recovery_required') this.operationRangeUnconfirmed = true
            return this.domain.reportApplicationOutcome(actor, current.id, {
              status: error instanceof Error && 'code' in error && error.code === 'recovery_required' ? 'recovery_required' : 'failed',
              diagnostic: error instanceof Error ? error.message : String(error),
            })
          }
        })
      }
      case 'application.get': {
        const id = text(input, 'applicationId')
        this.guardApplication(context.actor, id)
        return this.domain.getApplicationDetail(id)
      }
      case 'application.verification': {
        const id = text(input, 'applicationId')
        this.guardApplication(context.actor, id)
        return this.supervisor.workspace.readVerification(id)
      }
      case 'application.apply': {
        const id = text(input, 'applicationId')
        this.guardApplication(context.actor, id)
        const expectedTarget = input.expectedTarget === null ? null : text(input, 'expectedTarget')
        const application = this.domain.applyApplication(actor, id, expectedTarget, this.idem(context, input))
        return this.serialProject(application.projectId, async () => {
          const current = this.domain.getApplication(id)
          if (current.status !== 'applying') return current
          if (this.targetNeedsRecovery(current.projectId, current.id)) {
            return this.domain.reportApplicationOutcome(actor, current.id, { status: 'failed', diagnostic: 'Project target requires recovery before further application' })
          }
          const project = this.domain.getProject(current.projectId)
          try {
            const outcome = await this.supervisor.workspace.apply({
              applicationId: current.id,
              expectedTarget,
              verificationCommand: project.verificationCommand,
            })
            return this.domain.reportApplicationOutcome(actor, current.id, outcome)
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'recovery_required') this.operationRangeUnconfirmed = true
            return this.domain.reportApplicationOutcome(actor, current.id, {
              status: 'recovery_required', diagnostic: error instanceof Error ? error.message : String(error),
            })
          }
        })
      }
      case 'events.list': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : undefined
        if (projectId) this.guardProject(context.actor, projectId)
        if (!projectId && context.actor.projectIds !== null) {
          throw new ApplicationError('project_required', 400, 'Specify a project for event access')
        }
        return this.domain.listEvents({ ...(projectId ? { projectId } : {}), after: typeof input.after === 'string' ? input.after : null })
      }
      case 'events.wait': {
        const maxWaitMs = Math.min(Math.max(typeof input.timeoutMs === 'number' ? input.timeoutMs : 15_000, 0), 30_000)
        const deadline = Date.now() + maxWaitMs
        do {
          const page = await this.invoke('events.list', input, context) as Page<IssueEvent>
          if (page.items.length > 0 || Date.now() >= deadline) return page
          await new Promise((resolve) => setTimeout(resolve, 250))
        } while (true)
      }
      default: throw new ApplicationError('unknown_operation', 404, `Unknown operation: ${operation}`)
    }
  }
}
