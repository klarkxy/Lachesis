import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_STORAGE_POLICY, type Evidence, type Issue, type Run, type RunCheckpoint, type StorageAdmission } from '@lachesis/contracts'
import { DomainError, ErrorCode, type Claim, type DomainService } from '@lachesis/plugin-domain'
import { ACP_REASONING_CONFIG_ID, RangeExitUnconfirmedError, RuntimeEnvironmentError, classifyRuntimeEnvironmentError, type DshAcpExecutor, type RunEvent, type RunHandle } from '@lachesis/plugin-runtime-dsh'
import { Workspace, prepareNativeSandboxDirectory } from '@lachesis/plugin-workspace'
import { ApplicationError } from './errors.ts'
import { visibleAssistantReply } from './response.ts'

const worker = { kind: 'worker' as const, id: 'lachesis-supervisor' }

interface ActiveRun {
  handle: RunHandle
  questions: Map<string, { requestId: string; optionIds: Set<string> }>
  finalText: string[]
  observed: Promise<void>
  environmentFailure: string | null
}

function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

function eventData(event: RunEvent): unknown {
  const json = JSON.stringify(event)
  if (json.length > 32_000) return { type: event.type, truncated: true, byteLength: json.length }
  const record = JSON.parse(json) as {
    type: string
    update?: { content?: { type?: string; text?: string } }
  }
  // ACP text arrives in arbitrary chunks. Per-event replacement cannot spot a
  // credential split across two chunks, so keep its metadata and omit the text.
  if (record.type === 'acp_update' && record.update?.content?.type === 'text') {
    record.update.content.text = '[stream text omitted; see delivery]'
  }
  return JSON.parse(redact(JSON.stringify(record)))
}

function redact(value: string): string {
  let text = value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ds)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && secret && secret.length >= 8) {
      text = text.replaceAll(secret, '[redacted]')
    }
  }
  return text
}

function promptFor(issue: Issue): string {
  const criteria = issue.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join('\n')
  return [
    `Work on this issue in the current workspace. The workspace is isolated from the project target.`,
    `Title: ${issue.title}`,
    `Request:\n${issue.description}`,
    criteria ? `Acceptance criteria:\n${criteria}` : '',
    issue.ownedPaths?.length ? `Allowed write paths (exact file or directory ending in /):\n${issue.ownedPaths.join('\n')}` : '',
    issue.readOnlyPaths?.length ? `Read-only paths; do not change:\n${issue.readOnlyPaths.join('\n')}` : '',
    `Make the required edits and run relevant checks. Finish with a concise report of changes and verification.`,
  ].filter(Boolean).join('\n\n')
}

/** Owns Run process ranges and the boundary between live work and immutable delivery. */
export class RunSupervisor {
  private readonly domain: DomainService
  private readonly dataRoot: string
  private readonly tickIntervalMs: number
  readonly workspace: Workspace
  private readonly runtime: DshAcpExecutor
  private readonly active = new Map<string, ActiveRun>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly cancelling = new Set<string>()
  private readonly probes = new Set<Promise<unknown>>()
  private readonly checkpointTasks = new Map<string, Promise<RunCheckpoint>>()
  private probeRangeUnconfirmed = false
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private stopping = false

  /**
   * @param workspace — the process-wide Workspace; a second instance would stop
   *   excluding the first on the in-memory project target lock.
   * @param dataRoot — the service data directory, for Run dsh homes and probes.
   * @param runtime — the harness executor, supplied by the caller so the
   *   scheduler never imports a concrete harness.
   * @param tickIntervalMs — how often to look for newly ready Issues.
   */
  constructor(
    domain: DomainService,
    workspace: Workspace,
    dataRoot: string,
    runtime: DshAcpExecutor,
    tickIntervalMs = 1_000,
  ) {
    this.domain = domain
    this.workspace = workspace
    this.dataRoot = dataRoot
    this.runtime = runtime
    this.tickIntervalMs = tickIntervalMs
    this.workspace.configureStorageBackend(this.domain.storageReservationBackend())
    this.workspace.ledger.setManagedRoot(this.dataRoot)
    this.workspace.setStoragePolicy(this.domain.getStoragePolicy() ?? DEFAULT_STORAGE_POLICY)
    this.domain.setExecutionPolicySupport((policy) => {
      const support = (this.runtime as DshAcpExecutor & {
        executionPolicySupport?: (request: typeof policy) => { supported: boolean; diagnostic: string | null }
      }).executionPolicySupport?.(policy)
      if (!support && (policy.accessMode === 'read-only' || policy.requireFull)) return 'Execution policy capabilities are unknown'
      return support?.supported === false ? support.diagnostic ?? 'Native DSH cannot enforce this execution policy' : null
    })
  }

  start(): void {
    if (this.timer || this.stopping) return
    this.timer = setInterval(() => this.wake(), this.tickIntervalMs)
    this.timer.unref()
    this.wake()
  }

  wake(): void {
    void this.tick().catch((error) => {
      process.stderr.write(`Lachesis scheduler: ${errorText(error)}\n`)
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    let closeError: unknown
    try { await this.runtime.closeAll() } catch (error) { closeError = error }
    await Promise.allSettled([...this.tasks.values(), ...this.probes])
    // A probe can be inside start() when the first closeAll() runs. It checks
    // stopping after startup and closes its own handle; this second pass covers
    // executors with a delayed registration step as well.
    try { await this.runtime.closeAll() } catch (error) { closeError ??= error }
    if (this.probeRangeUnconfirmed) {
      throw new RangeExitUnconfirmedError('A profile capability probe could not confirm worker range exit')
    }
    if (closeError) throw closeError
  }

  probeProfileCapabilities(providerRef: string, modelId: string, boundaryMode: 'whole-range' | 'native-tools' = 'whole-range'): Promise<{
    providerRef: string
    modelId: string
    reasoningOptions: Array<{ value: string; name: string }>
  }> {
    if (this.stopping) throw new ApplicationError('service_stopping', 503, 'Lachesis is stopping')
    if (this.probeRangeUnconfirmed) {
      throw new ApplicationError('range_unconfirmed', 503, 'Worker exit is unconfirmed; restart Lachesis before probing again')
    }
    if (this.probes.size > 0) throw new ApplicationError('probe_busy', 409, 'A model capability probe is already running')
    const probe = this.runProfileProbe(providerRef, modelId, boundaryMode)
    this.probes.add(probe)
    void probe.finally(() => this.probes.delete(probe)).catch(() => {})
    return probe
  }

  private async runProfileProbe(providerRef: string, modelId: string, boundaryMode: 'whole-range' | 'native-tools'): Promise<{
    providerRef: string
    modelId: string
    reasoningOptions: Array<{ value: string; name: string }>
  }> {
    let root: string | null = null
    let handle: RunHandle | null = null
    let rangeExited = true
    let result: { providerRef: string; modelId: string; reasoningOptions: Array<{ value: string; name: string }> } | null = null
    let failure: unknown = null
    try {
      const parent = join(this.dataRoot, 'profile-probes')
      await mkdir(parent, { recursive: true })
      root = await mkdtemp(join(parent, 'probe-'))
      const box = join(root, 'box')
      const cwd = join(box, 'work')
      const dshHome = join(box, 'state', 'home')
      const tempRoot = join(root, 'tmp')
      await Promise.all([mkdir(cwd, { recursive: true }), mkdir(dshHome, { recursive: true }), mkdir(tempRoot, { recursive: true })])
      await prepareNativeSandboxDirectory(box, dshHome, tempRoot)
      try {
        await copyFile(join(this.dataRoot, 'dsh', 'cordis.patch.yml'), join(dshHome, 'cordis.patch.yml'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (this.stopping) throw new ApplicationError('service_stopping', 503, 'Lachesis is stopping')
      const ocgKey = process.env.OCG_GATEWAY_KEY
      await this.workspace.ledger.assertHeld()
      handle = await this.runtime.start({
        cwd, dshHome, provider: providerRef, model: modelId,
        sandbox: { mode: 'workspace-write', workspaceRoot: box, tempRoot, boundaryMode, accessMode: 'workspace-write', requireFull: false },
        ...(ocgKey ? { env: { OCG_GATEWAY_KEY: ocgKey } } : {}),
        permissionMode: 'reject-once',
      })
      if (this.stopping) throw new ApplicationError('service_stopping', 503, 'Lachesis is stopping')
      const route = handle.route
      if (!route || route.provider !== providerRef || route.model !== modelId) {
        throw new Error('ACP did not confirm the selected provider and model')
      }
      const option = route.configOptions.find((item) => item.id === ACP_REASONING_CONFIG_ID && item.type === 'select')
      const reasoningOptions = option?.type === 'select'
        ? option.options.flatMap((item) => 'options' in item ? item.options : [item])
          .map(({ value, name }) => ({ value, name }))
        : []
      result = { providerRef, modelId, reasoningOptions }
    } catch (error) {
      if (error instanceof RangeExitUnconfirmedError) {
        rangeExited = false
        this.probeRangeUnconfirmed = true
      }
      failure = error
    } finally {
      if (handle) {
        try { await handle.close() } catch (error) { failure ??= error }
        try {
          const outcome = await handle.done
          rangeExited = outcome.rangeExited
        } catch (error) {
          rangeExited = false
          failure ??= error
        }
        if (!rangeExited) this.probeRangeUnconfirmed = true
      }
      // Never remove a home that could still be in use by a worker range.
      if (root && rangeExited) {
        try { await rm(root, { recursive: true, force: true }) }
        catch (error) { failure ??= error }
      }
    }
    if (!rangeExited) throw new ApplicationError('range_unconfirmed', 503, 'Worker exit is unconfirmed; restart Lachesis before probing again')
    if (failure) {
      if (failure instanceof ApplicationError) throw failure
      throw new ApplicationError('capability_probe_failed', 502, 'Could not inspect this provider and model through dsh ACP')
    }
    return result!
  }

  async cancel(issueId: string, expectedVersion: number, actorId: string): Promise<Issue> {
    const issue = this.domain.getIssue(issueId)
    if (issue.version !== expectedVersion) throw new ApplicationError('version_conflict', 409, 'Issue changed; refresh it before cancelling')
    const runId = issue.currentRunId
    let markedRunId: string | null = null
    try {
      if (runId) {
        const run = this.domain.getRun(runId).run
        if (['starting', 'running', 'needs_input', 'cancelling'].includes(run.status)) {
          if (this.cancelling.has(runId)) {
            throw new ApplicationError('already_cancelling', 409, 'This Run is already being cancelled')
          }
          const active = this.active.get(runId)
          if (!active) throw new ApplicationError('run_starting', 409, 'The Run is starting; retry cancellation shortly')
          this.cancelling.add(runId)
          markedRunId = runId
          // ACP cancellation is cooperative. A timed-out notification must not
          // skip the managed-range close and leave the Issue falsely running.
          try { await active.handle.cancel() } catch { /* Range close is authoritative. */ }
          try { await active.handle.close() } catch { /* Inspect the settled range below. */ }
          const outcome = await active.handle.done
          await active.observed
          this.domain.recordRunEvent(worker, runId, this.domain.getRun(runId).facts.generation,
            'run.process_exit', { rangeExited: outcome.rangeExited })
          if (!outcome.rangeExited) {
            const generation = this.domain.getRun(runId).facts.generation
            this.domain.requireRunRecovery(worker, runId, generation, 'Cancellation could not confirm that the worker process range exited')
            throw new ApplicationError('range_unconfirmed', 409, 'Worker exit is unconfirmed; restart Lachesis before retrying this issue')
          }
        }
      }
      // The caller's version was checked before the asynchronous close. A
      // permission transition may increment it while the worker is stopping.
      // Recheck the Run identity, then use the current version synchronously.
      const current = this.domain.getIssue(issueId)
      if (current.currentRunId !== runId) {
        throw new ApplicationError('version_conflict', 409, 'Issue changed; refresh it before cancelling')
      }
      const cancelled = this.domain.cancelIssue({ kind: 'operator', id: actorId }, issueId, current.version)
      if (runId && this.domain.hasConfirmedRunExit(runId)) {
        await this.createCheckpoint(runId, 'Work preserved after explicit cancellation').catch(() => {})
      }
      return cancelled
    } finally {
      if (markedRunId) this.cancelling.delete(markedRunId)
    }
  }

  async answerQuestion(runId: string, questionId: string, answers: Record<string, string>, actorId: string): Promise<unknown> {
    const active = this.active.get(runId)
    const question = active?.questions.get(questionId)
    if (!active || !question) throw new ApplicationError('run_not_live', 409, 'This question is no longer attached to a live Run')
    const optionId = answers.optionId
    if (!optionId || !question.optionIds.has(optionId)) {
      throw new ApplicationError('invalid_input', 400, 'Choose one of the offered permission options')
    }
    const answered = this.domain.answerQuestion({ kind: 'operator', id: actorId }, runId, questionId, answers)
    active.questions.delete(questionId)
    await active.handle.answerPermission(question.requestId, { optionId })
    return answered
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.ticking) return
    this.ticking = true
    try {
      await this.refreshStorageAdmissions()
      while (!this.stopping && this.tasks.size < this.domain.getSchedulerSettings().globalMaxActive) {
        const claim = this.domain.claimNextReadyIssue(worker)
        if (!claim) break
        const task = this.execute(claim)
        this.tasks.set(claim.run.id, task)
        void task.finally(() => {
          this.tasks.delete(claim.run.id)
          if (!this.stopping) this.wake()
        }).catch((error) => {
          process.stderr.write(`Lachesis Run ${claim.run.id}: ${errorText(error)}\n`)
        })
      }
    } finally {
      this.ticking = false
    }
  }

  private async refreshStorageAdmissions(): Promise<void> {
    this.workspace.setStoragePolicy(this.domain.getStoragePolicy() ?? DEFAULT_STORAGE_POLICY)
    const policyDigest = this.domain.storagePolicyDigest()
    this.domain.setStorageAdmissions(null)
    const candidates = this.domain.getSchedulerSnapshot().decisions.filter((item) => item.reason === 'ready')
    const estimates = new Map<string, { requiredBytes: number; sourceRef: string | null }>()
    const sources = new Map<string, { requiredBytes: number; sourceRef: string | null }>()
    for (const candidate of candidates) {
      if (this.stopping) break
      const issue = this.domain.getIssue(candidate.issueId)
      const project = this.domain.getProject(issue.projectId)
      const seedDeliveryId = this.domain.getReworkSourceDelivery(issue.id)
      try {
        const key = `${project.id}:${seedDeliveryId ?? ''}`
        const estimate = sources.get(key) ?? await this.workspace.estimateRunReservation({ kind: project.kind, projectRoot: project.rootPath,
          targetBranch: project.targetBranch, ...(seedDeliveryId ? { seedDeliveryId } : {}) })
        sources.set(key, estimate)
        estimates.set(issue.id, estimate)
      } catch { /* An unavailable source or measurement is not a failed model execution. */ }
    }
    const admissions = new Map<string, StorageAdmission>()
    try {
      const observation = await this.workspace.ledger.observe()
      for (const [id, estimate] of estimates) admissions.set(id, { ...estimate, observation, policyDigest })
    } catch { /* Fail closed; the next tick can obtain a fresh observation. */ }
    this.domain.setStorageAdmissions(admissions)
  }

  private async prepareDshHome(runId: string, privateHome = join(this.workspace.executionRoot, runId, 'box', 'state', 'home')): Promise<string> {
    const home = privateHome
    await mkdir(home, { recursive: true })
    // The operator can place provider configuration in the service-owned dsh home.
    // Each Run receives a snapshot, while session and conversation data stay isolated.
    try {
      await copyFile(join(this.dataRoot, 'dsh', 'cordis.patch.yml'), join(home, 'cordis.patch.yml'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return home
  }

  private async execute(claim: Claim): Promise<void> {
    const { run, issue, generation } = claim
    let handle: RunHandle | null = null
    let live: ActiveRun | null = null
    try {
      const project = this.domain.getProject(issue.projectId)
      const reworkDeliveryId = this.domain.getReworkSourceDelivery(issue.id)
      const prepared = await this.workspace.withTargetLock(project.rootPath, () => this.workspace.prepareRun({
        runId: run.id,
        kind: project.kind,
        projectRoot: project.rootPath,
        targetBranch: project.targetBranch,
        ...(run.executionSnapshot?.sourceSelection.baseRef ? { pinnedBaseRef: run.executionSnapshot.sourceSelection.baseRef } : {}),
        ...(reworkDeliveryId ? { seedDeliveryId: reworkDeliveryId } : {}),
      }))
      if (this.stopping) throw new Error('Service stopped before worker startup')
      this.domain.bindRun(worker, run.id, generation, {
        workspacePath: prepared.workspacePath,
        baseRef: prepared.baseRef,
      })
      const home = await this.prepareDshHome(run.id, prepared.homePath)
      await prepareNativeSandboxDirectory(join(prepared.executionPath!, 'box'), home, prepared.tmpPath!)
      const sandbox = { mode: 'workspace-write' as const,
        boundaryMode: run.executionSnapshot?.boundaryMode ?? 'whole-range',
        workspaceRoot: run.executionSnapshot?.accessMode === 'read-only'
          ? join(prepared.executionPath!, 'box', 'state') : join(prepared.executionPath!, 'box'),
        tempRoot: prepared.tmpPath!,
        accessMode: run.executionSnapshot?.accessMode ?? 'workspace-write',
        requireFull: run.executionSnapshot?.isolationRequirement === 'full' }
      let verificationFeedback = ''
      const failedApplication = reworkDeliveryId ? this.domain.listApplications(issue.id)
        .filter((item) => item.deliveryId === reworkDeliveryId && ['failed', 'conflict'].includes(item.status)).at(-1) : null
      if (failedApplication) {
        const report = await this.workspace.readVerification(failedApplication.id)
        if (report) {
          // .dsh is excluded from delivery manifests, but readable by the confined worker.
          const directory = join(prepared.workspacePath, '.dsh')
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'lachesis-verification.json'), redact(JSON.stringify(report, null, 2)), 'utf8')
          verificationFeedback = 'Read-only verification evidence: .dsh/lachesis-verification.json. Read the failure details; do not modify or deliver this diagnostic file.'
        }
      }
      if (this.stopping) throw new Error('Service stopped before worker startup')
      let harnessConfigDigest: string | null = null
      try { harnessConfigDigest = createHash('sha256').update(await readFile(join(home, 'cordis.patch.yml'))).digest('hex') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      this.domain.bindRunInput(worker, run.id, generation, {
        executionSnapshotDigest: this.domain.executionSnapshotDigest(run.id), baseRef: prepared.baseRef,
        materializedDigest: await this.workspace.inputDigest(run.id), harnessConfigDigest,
        captureGuarantee: project.kind === 'git' ? 'fixed-commit' : 'captured-bytes', boundAt: new Date().toISOString(),
      })
      if (this.runtime.checkReadiness) {
        const readiness = await this.runtime.checkReadiness({ cwd: prepared.workspacePath, dshHome: home, sandbox })
        if (!readiness.ready) {
          const diagnostic = redact(readiness.diagnostic ?? 'The worker environment is not ready')
          throw new RuntimeEnvironmentError(readiness.code ?? 'environment_unavailable', diagnostic)
        }
      }
      if (this.stopping) throw new Error('Service stopped after readiness check')
      // dsh-subprocess scrubs credential-shaped ambient variables. Forward only
      // this explicitly configured local gateway credential to the ACP process.
      const ocgKey = process.env.OCG_GATEWAY_KEY
      await this.workspace.ledger.assertHeld()
      handle = await this.runtime.start({
        cwd: prepared.workspacePath,
        dshHome: home,
        provider: run.providerRef,
        model: run.modelId,
        ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
        ...(ocgKey ? { env: { OCG_GATEWAY_KEY: ocgKey } } : {}),
        permissionMode: run.executionSnapshot?.attendance === 'bounded-unattended' ? 'allow-once' : 'defer',
        sandbox,
      })
      if (this.stopping) throw new Error('Service stopped before worker prompt')
      live = { handle, questions: new Map(), finalText: [], observed: Promise.resolve(), environmentFailure: null }
      this.active.set(run.id, live)
      const observed = this.collectEvents(run, generation, live)
      live.observed = observed
      this.domain.bindRun(worker, run.id, generation, { sessionId: handle.sessionId ?? null })
      if (handle.processFacts) this.domain.recordRunEvent(worker, run.id, generation, 'run.process_facts', handle.processFacts)
      this.domain.markRunRunning(worker, run.id, generation)
      const initialComments = this.domain.listComments(issue.id).filter((comment) => !comment.delivered)
      const initialPrompt = [
        promptFor(issue),
        ...initialComments.map((comment) => `Operator follow-up:\n${comment.text}`),
        verificationFeedback,
      ].join('\n\n')
      const first = await handle.send(initialPrompt)
      if (live.environmentFailure) throw new Error(live.environmentFailure)
      if (first.stopReason !== 'end_turn') throw new Error(`Run ended with ${first.stopReason}`)
      for (const comment of initialComments) this.domain.markCommentDelivered(comment.id)
      await this.drainMessages(run, issue, handle)
      await handle.close()
      const outcome = await handle.done
      await observed
      this.domain.recordRunEvent(worker, run.id, generation, 'run.process_exit', { rangeExited: outcome.rangeExited })
      if (!outcome.rangeExited) throw new Error('Worker process range did not exit')
      // Confinement stopped the range, so whatever it managed to leave in the
      // workspace is untrusted and must never become a delivery.
      if (outcome.sandboxViolation) {
        throw new Error(outcome.error ?? `Worker violated its ${outcome.sandboxViolation.mode} sandbox`)
      }
      if (this.cancelling.has(run.id)) return
      if (this.stopping) throw new Error('Service stopped after the worker exited; unfinished work was preserved')
      if (live.environmentFailure) throw new Error(live.environmentFailure)
      const deliveryId = randomUUID()
      const manifest = await this.workspace.freezeDelivery({
        runId: run.id,
        deliveryId,
        worker: { rangeExited: outcome.rangeExited },
      })
      const finalResponse = redact(visibleAssistantReply(live.finalText.join(''))) || null
      const evidence: Evidence[] = [{
        kind: 'lifecycle',
        label: 'dsh ACP process range exited',
        outcome: 'passed',
        detail: `stopReason=${first.stopReason}`,
      }]
      this.domain.completeRun(worker, run.id, generation, {
        id: deliveryId,
        summary: finalResponse?.slice(0, 1_000) ?? 'Run completed; inspect the frozen changes.',
        finalResponse,
        files: manifest.files,
        evidence,
        manifestSha256: manifest.manifestSha256,
      })
      await this.workspace.withTargetLock(project.rootPath, () => this.workspace.disposeRun(run.id)).catch(() => {})
    } catch (error) {
      let rangeExited = !(error instanceof RangeExitUnconfirmedError)
      if (!handle && error && typeof error === 'object' && 'code' in error && error.code === 'disk_capacity') {
        this.domain.recordRunEvent(worker, run.id, generation, 'run.process_exit', { rangeExited: true, workerStarted: false })
        await this.cleanupUnstartedRun(run.id, issue.projectId)
        this.domain.deferUnstartedRun(worker, run.id, generation, errorText(error))
        return
      }
      const environment = classifyRuntimeEnvironmentError(error)
      if (environment && !live?.environmentFailure) this.domain.blockProjectEnvironment(worker, issue.projectId, environment.code, environment.message)
      if (handle) {
        try { await handle.close() } catch { /* The range outcome below is authoritative. */ }
        rangeExited = (await handle.done).rangeExited
        await live?.observed
      }
      try {
        // Keep proof behind the generation check if cancellation won this race.
        this.domain.recordRunEvent(worker, run.id, generation, 'run.process_exit', { rangeExited, workerStarted: handle !== null })
        if (!rangeExited) {
          this.domain.requireRunRecovery(worker, run.id, generation, errorText(error))
        } else if (!this.cancelling.has(run.id)) {
          this.domain.failRun(worker, run.id, generation, errorText(error))
          if (!handle) await this.cleanupUnstartedRun(run.id, issue.projectId)
          if (handle) {
            try { await this.createCheckpoint(run.id, errorText(error)) }
            catch (checkpointError) {
              this.domain.recordRunEvent(worker, run.id, generation, 'run.checkpoint_failed', { diagnostic: errorText(checkpointError) })
            }
          }
        }
      } catch (failure) {
        if (!(failure instanceof DomainError && failure.code === ErrorCode.lateResult)) throw failure
      }
    } finally {
      if (handle) await handle.close().catch(() => {})
      this.active.delete(run.id)
    }
  }

  private async cleanupUnstartedRun(runId: string, projectId: string): Promise<void> {
    if (!this.domain.listStorageReservations().some((row) => row.runId === runId)) return
    const project = this.domain.getProject(projectId)
    try {
      await this.workspace.withTargetLock(project.rootPath, () => this.workspace.disposeRun(runId))
    } catch (error) {
      const { lstat } = await import('node:fs/promises')
      try { await lstat(join(this.workspace.executionRoot, runId)) }
      catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') this.domain.storageReservationBackend().release(runId)
      }
    }
  }

  private async drainMessages(run: Run, issue: Issue, handle: RunHandle): Promise<void> {
    for (;;) {
      const comments = this.domain.listComments(issue.id).filter((comment) => !comment.delivered)
      const messages = this.domain.listRunMessages(run.id).filter((message) => !message.delivered)
      if (comments.length === 0 && messages.length === 0) return
      const receipt = await handle.send([...comments.map((item) => item.text), ...messages.map((item) => item.text)].join('\n\n'))
      if (receipt.stopReason !== 'end_turn') throw new Error(`Follow-up ended with ${receipt.stopReason}`)
      for (const comment of comments) this.domain.markCommentDelivered(comment.id)
      for (const message of messages) this.domain.markRunMessageDelivered(message.id)
    }
  }

  private async collectEvents(run: Run, generation: number, live: ActiveRun): Promise<void> {
    for await (const event of live.handle.events) {
      if (event.type === 'acp_update') {
        const update = event.update as unknown as { sessionUpdate?: string; content?: { type?: string; text?: string } }
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text) {
          if (live.finalText.join('').length < 100_000) live.finalText.push(update.content.text)
        }
        const raw = event.update as unknown as { sessionUpdate?: string; status?: string; content?: unknown }
        if (raw.sessionUpdate === 'tool_call_update' && raw.status === 'failed' && !live.environmentFailure) {
          const environment = classifyRuntimeEnvironmentError(JSON.stringify(raw.content ?? ''))
          if (environment) {
            live.environmentFailure = environment.message
            this.domain.blockProjectEnvironment(worker, this.domain.getIssue(run.issueId).projectId,
              environment.code, live.environmentFailure)
            // Do not await close from the stream it must close.
            void live.handle.close().catch(() => {})
          }
        }
      }
      if (event.type === 'permission') {
        try {
          const question = this.domain.askQuestion(worker, run.id, generation, [{
            id: 'optionId',
            text: 'Allow this dsh tool action?',
            options: event.options.map((option) => option.optionId),
            required: true,
          }])
          live.questions.set(question.id, {
            requestId: event.requestId,
            optionIds: new Set(event.options.map((option) => option.optionId)),
          })
        } catch { /* A cancelled or superseded Run cannot ask new questions. */ }
      }
      try { this.domain.recordRunEvent(worker, run.id, generation, `run.${event.type}`, eventData(event)) }
      catch { /* The Run was cancelled or superseded; late observations are dropped. */ }
    }
  }

  createCheckpoint(runId: string, reason = 'Explicit snapshot of unfinished work'): Promise<RunCheckpoint> {
    const existing = this.checkpointTasks.get(runId)
    if (existing) return existing
    const task = this.freezeCheckpoint(runId, reason)
    this.checkpointTasks.set(runId, task)
    void task.finally(() => this.checkpointTasks.delete(runId)).catch(() => {})
    return task
  }

  private async freezeCheckpoint(runId: string, reason: string): Promise<RunCheckpoint> {
    const { run } = this.domain.getRun(runId)
    const prior = this.domain.listCheckpoints(run.issueId).find((item) => item.runId === runId)
    if (prior) return prior
    if (!['failed', 'cancelled', 'interrupted'].includes(run.status) || !this.domain.hasConfirmedRunExit(runId)) {
      throw new ApplicationError('range_unconfirmed', 409, 'Only confirmed stopped unfinished runs can produce a checkpoint')
    }
    const id = randomUUID()
    const manifest = await this.workspace.saveCheckpoint({ runId, checkpointId: id, worker: { rangeExited: true } })
    return this.domain.recordCheckpoint(worker, { id, runId, issueId: run.issueId,
      baseRef: run.baseRef, files: manifest.files, manifestSha256: manifest.manifestSha256, reason: redact(reason) })
  }

  async checkProjectReadiness(projectId: string, expectedVersion: number) {
    if (this.stopping) throw new ApplicationError('service_stopping', 503, 'Lachesis is stopping')
    const before = this.domain.getProjectDispatchState(projectId)
    if (before.version !== expectedVersion) throw new ApplicationError('version_conflict', 409, 'Dispatch settings changed')
    const project = this.domain.getProject(projectId)
    const runId = randomUUID()
    const task = (async () => {
      let rangeExited = true
      const estimate = await this.workspace.estimateRunReservation({ kind: project.kind, projectRoot: project.rootPath,
        targetBranch: project.targetBranch })
      this.domain.reserveStorageOperation(runId, { ...estimate, observation: await this.workspace.ledger.observe(),
        policyDigest: this.domain.storagePolicyDigest() })
      try {
        const prepared = await this.workspace.withTargetLock(project.rootPath, () => this.workspace.prepareRun({
          runId, kind: project.kind, projectRoot: project.rootPath, targetBranch: project.targetBranch,
          ...(estimate.sourceRef ? { pinnedBaseRef: estimate.sourceRef } : {}),
        }))
        const home = await this.prepareDshHome(runId, prepared.homePath)
        await prepareNativeSandboxDirectory(join(prepared.executionPath!, 'box'), home, prepared.tmpPath!)
        const readiness = this.runtime.checkReadiness
          ? await this.runtime.checkReadiness({ cwd: prepared.workspacePath, dshHome: home,
            sandbox: { mode: 'workspace-write', workspaceRoot: join(prepared.executionPath!, 'box'), tempRoot: prepared.tmpPath!, accessMode: 'workspace-write', requireFull: false } })
          : { ready: false, code: 'readiness_unsupported', diagnostic: 'This executor does not implement environment checks' }
        if (this.stopping) throw new ApplicationError('service_stopping', 503, 'Lachesis stopped during the check')
        if (readiness.ready) this.domain.clearProjectEnvironment(worker, projectId, expectedVersion)
        else this.domain.blockProjectEnvironment(worker, projectId, readiness.code ?? 'environment_unavailable', redact(readiness.diagnostic ?? 'Not ready'))
        return { readiness, dispatch: this.domain.getProjectDispatchState(projectId) }
      } catch (error) {
        if (error instanceof RangeExitUnconfirmedError) {
          rangeExited = false
          this.probeRangeUnconfirmed = true
          this.domain.blockProjectEnvironment(worker, projectId, 'range_exit_unconfirmed', errorText(error))
        }
        throw error
      } finally {
        if (rangeExited) {
          this.domain.confirmStorageOperationExit(runId)
          try {
            await this.workspace.withTargetLock(project.rootPath, () => this.workspace.disposeRun(runId))
          } catch (error) {
            // Preparation can fail before writing its control record. Release
            // only when the private execution directory is actually absent.
            const { lstat } = await import('node:fs/promises')
            try { await lstat(join(this.workspace.executionRoot, runId)) }
            catch (missing) {
              if ((missing as NodeJS.ErrnoException).code === 'ENOENT'
                && this.domain.listStorageReservations().some((row) => row.runId === runId)) {
                this.domain.storageReservationBackend().release(runId)
              }
            }
          }
        }
      }
    })()
    this.probes.add(task)
    try { return await task } finally { this.probes.delete(task) }
  }
}
