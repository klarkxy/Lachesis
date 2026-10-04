# Phase 1 workspace storage — integration notes

Workspace storage integration notes for the completed Phase 1 implementation. Shared contracts, Domain SQLite reservations and scheduler wiring are implemented in their respective packages.

## Layout

Artifact store (`storeRoot`, plugin default `<dataRoot>/artifacts`):

- `blobs/`, `baselines/<id>/manifest.json`, `deliveries/`, `checkpoints/`, `staging/`
- `runs/<runId>/control.json` (legacy `meta.json` is still loaded)
- `git/<projectKey>/repo.git` bare service repository
- `integrations/`, `apply/` unchanged

There is no `storage/owner.json` or `storage/ledger.json`. Reservations are not a second store.

Worker root (`executionRoot`, default the sibling directory `execution` of the artifact store, so `<dataRoot>/execution` when the store is `<dataRoot>/artifacts`):

- `execution/<runId>/box/work`
- `execution/<runId>/box/state/home`
- `execution/<runId>/tmp`
- `execution/<runId>/box/state/output`

`executionRoot` is never inside the artifact store. Prepare rejects a project that contains either directory.

## API primary should call

`WorkspaceOptions` still accepts optional `executionRoot` and `storagePolicy`. The Cordis plugin still constructs `Workspace` with `storeRoot` only. The policy object is an in-memory mirror; production loads the durable policy from Domain and calls `setStoragePolicy`. Defaults are permissive.

`workspace.configureStorageBackend(backend)` installs the Domain reservation adapter before claim. Without it, standalone runs keep an in-memory backend. No owner pid file is written.

Admission before claim:

- `workspace.estimateRunReservation({ kind, projectRoot, targetBranch, seedDeliveryId?, pinnedBaseRef? })` returns `{ requiredBytes, sourceRef }`. It does not create an execution directory or call a model. `requiredBytes` is a conservative allocation estimate: cluster-rounded files, the directories prepare will create, CAS blob and baseline metadata for a fresh files capture, private control, and future room. `sourceRef` is the git commit that will be materialized, or the files baseline ref for rework, or null for a fresh files tree.
- `workspace.ledger.observe()` returns `StorageObservation`. It measures every artifact directory and every execution directory with `lstat` only. `stat.blocks * 512` is used when the platform reports a positive block count; otherwise size is rounded up to the volume cluster. That number is an allocation estimate, not exact physical occupancy. `freeBytes` is raw volume free space. Different resolved drive letters or UNC shares are rejected before the `stat.dev` comparison. A matching drive, UNC share, or device id does not prove a junction stays on one volume. Windows often reports `dev` as 0.

`prepareRun` calls `backend.acquire`. A row that already holds at least the estimated bytes is reused, so claim plus prepare does not charge twice. A larger estimate is an atomic top-up of the difference. A domain `disk_capacity` error from `acquire` is not rewritten. After the work tree exists, prepare calls `backend.materialized(runId, remainingBytes, executionBaseBytes)` with the future dirty/output/publish room and the measured execution directory, then `assertHeld`. If that recheck fails, prepare deletes the private execution and run directory and releases the reservation only when both deletes are confirmed. The failure stays `disk_capacity`. Later admission uses `max(0, remainingBytes - max(0, currentRunBytes - executionBaseBytes))`. `currentRunBytes` is that run's execution directory (work, home, state). Managed bytes include execution plus artifacts, integrations, and apply. Free space subtracts only that unused future room. `artifactReady` keeps the row and contributes no future room.

`setStoragePolicy` and `storageStatus` remain. `status` does not delete anything.

- `readDeliveryFile` reads `deliveries/<id>` and, when that directory is absent, `checkpoints/<id>`. The server's checkpoint file read can keep calling `readDeliveryFile`.
- `readBaselineBytes(runId, posixPath)` for a shared files baseline. `baselinePath` is null on new files runs.
- `serviceGitDir(projectRoot)` for the bare repo. `refs/lachesis/deliveries/<id>` and `refs/lachesis/bases/<commit>` live only there.
- `saveCheckpoint({ runId, checkpointId, worker })` writes `checkpoints/<id>` and pins `refs/lachesis/checkpoints/<id>` for git. It does not delete execution or release the reservation.
- `executionRoot` is public. `runWorkspacePath(runId)` is `execution/<runId>/box/work`.

`PreparedWorkspace` adds optional `baselineId`, `executionPath`, `homePath`, `tmpPath`, `outputPath`.

Admission errors use `disk_capacity`. An unreadable reservation authority or an unsupported cross-volume layout uses `storage_unavailable`. `ENOSPC` / `EDQUOT` during a write uses `storage_full`. No checkpoint directory is created when admission fails. A denied prepare does not leave an execution directory.

## Scheduler wiring

- Call `estimateRunReservation`, then `ledger.observe()`, and admit in Domain before claim. `storageStatus().canDispatch` is the same gate for a standalone probe, not an OS quota. The claim transaction should `acquire` the same run id; prepare reuses that row.
- The declared private sandbox root is `<executionPath>/box`; temp grants use the sibling `tmp` directory. Cleanup and accounting cover the entire `executionPath`. In explicit `native-tools` mode the harness is trusted host code and native tools use `workspacePath` as their project boundary. Windows tool enforcement is partial; read-only/full policies are rejected before dispatch.
- The scheduler points the worker home, temp and output at `homePath`, `tmpPath` and `outputPath`; active Phase 1 runs do not use the old `<dataRoot>/run-homes` layout.
- Do not read a worker `meta.json` or a `.git` inside `work`. The control record is `runs/<runId>/control.json`.
- `freezeDelivery` still has the same arguments. On success it calls `artifactReady` (workspace `markPublished`). That does not delete execution, does not release the reservation, and does not mean the Domain delivery row is committed. `executionRetentionHours` and `checkpointRetentionDays` are not applied here. Checkpoints and unconfirmed bytes are not removed on a timer.
- `disposeRun` is the only release. It calls `backend.assertCleanupAllowed(runId)` before any recursive delete. Domain rejects an unconfirmed worker and a completed run whose delivery is not committed. The memory backend only checks that the reservation row exists. Release runs only after the execution directory is confirmed gone. A failed delete keeps the reservation and the residue. The standalone caller uses the same method after Domain has committed the delivery and the worker has exited.
- `saveCheckpoint` still writes `checkpoints/<id>` and does not delete execution or release the reservation.
- `inputDigest(runId)` is `snapshotTree` of the private work view, including a rework overlay, before the worker starts.
- `pinnedBaseRef` on prepare and estimate is the claim-pinned git commit. `targetBranch` stays the branch name. Git materialize and files capture both skip sensitive paths (`.env`, private keys), including a tracked git file. Those bytes are not stored in the files baseline and are not copied into worker work. Their absence is not a published deletion. Untracked excluded directories are not copied and are not published as deletions. Service git history stays in the service repository. Files integrate still copies the operator tree, including sensitive files, into the integration directory so the three-way merge does not treat them as deletions.
- Git integrate no longer adds an operator worktree. Apply copies the result commit into the operator repository and then fast-forwards. Operator remotes, credential helpers, and delivery refs are not written before that apply.
- `.dsh` under the work tree is an excluded directory, so the scheduler's verification directory there is not a delivery file.

## Legacy data

Records without `layout: "phase1"` keep the old operator worktree and per-run baseline directory. Those directories are not deleted. New rework of a legacy files delivery copies that directory, checks `files:<snapshot>`, and still refuses a tampered baseline. New git objects are imported only when the commit is still present.
