export { Workspace } from './workspace.ts'
export { WorkspaceError, isWorkspaceError } from './errors.ts'
export { LachesisWorkspace, type Config as LachesisWorkspaceConfig } from './plugin.ts'
export { default } from './plugin.ts'
export { isSensitivePath } from './filter.ts'
export { parseArgv, spawnArgv } from './spawn.ts'
export { assertAbsolutePath, assertRelativePosix, assertSafeId, isInside } from './paths.ts'
export { assertWorkerStopped } from './worker.ts'
export { checkDeliveryScope } from './scope.ts'

export type {
  ApplyInput,
  ApplyOutcome,
  CommandResult,
  DeliveryFileBytes,
  FilteredPath,
  FreezeDeliveryInput,
  FrozenManifest,
  IntegrateInput,
  IntegrationOutcome,
  PrepareRunInput,
  PreparedWorkspace,
  WorkerStopProof,
  WorkspaceOptions,
} from './types.ts'
