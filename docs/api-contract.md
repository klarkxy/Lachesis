# Lachesis v1 HTTP and MCP contract

This document fixes the shared wire surface for the server and web client. All
HTTP responses use `{ "data": value }` on success and
`{ "error": { "code": string, "message": string, "details"?: unknown } }`
on failure. The public types live in `@lachesis/contracts`. Timestamps are ISO
8601 UTC strings; identifiers are opaque. Mutations return the stored record.

## HTTP

All paths below have the `/api/v1` prefix. Project and profile creation are
operator actions. Query results are `{ data: { items, nextCursor } }`.

| Method and path | Input or result |
| --- | --- |
| `GET /health` | readiness and pinned runtime version |
| `GET /session` / `POST /session` | current browser session with CSRF token / pair with `{ code }` |
| `POST /session/pairing-code` | authenticated local operator issues another one-time browser code |
| `GET /tokens` / `POST /tokens` / `DELETE /tokens/:id` | list, issue once, or revoke project-scoped bearer tokens |
| `GET /projects` / `POST /projects` | paged `Project` list / `CreateProjectInput` |
| `GET /scheduler?projectId=` | `SchedulerSnapshot`: global/profile/provider occupancy, limits and per-Issue waiting reasons; scoped tokens must select an allowed project |
| `PUT /scheduler` | browser operator only; `{ expectedVersion, globalMaxActive, profileLimits, providerLimits }`; positive integer limits, missing map entry means no additional limit |
| `GET /projects/:id/dispatch` | durable pause/environment block plus active count and drain completion |
| `PATCH /projects/:id/dispatch` | `{ paused, expectedVersion }`; pausing prevents new claims without cancelling live runs |
| `POST /projects/:id/readiness` | `{ expectedVersion }`; no model request; checks a private isolated work directory and clears its environment block only on success |
| `GET /profiles` / `POST /profiles` | paged `Profile` list / `CreateProfileInput` |
| `POST /profiles/capabilities` | local browser operator only; `{ providerRef, modelId }` probes a prompt-free ACP session and returns available `reasoningOptions` |
| `PATCH /profiles/:id` | partial profile edit plus `expectedRevision` |
| `GET /profiles/:id/history` | per-revision score, count, and contributing issue IDs |
| `GET /issues?projectId=&status=&cursor=` / `POST /issues` | paged `Issue` list / `CreateIssueInput` |
| `GET /issues/:id` | `{ issue, runs, deliveries, evaluation, applications, questions, comments, checkpoints }` |
| `PATCH /issues/:id/plan` | `{ expectedIssueVersion, dependsOn?, ownedPaths?, readOnlyPaths? }`; only queued/blocked Issues with no previous Run |
| `GET /issues/:id/checkpoints` | immutable unfinished artifacts; never accepted Deliveries |
| `POST /issues/:id/resume` | `{ checkpointId, expectedIssueVersion }`; explicit new Run seeded from a confirmed stopped checkpoint |
| `POST /issues/:id/comments` | `{ text }`; store first, report delivery separately |
| `POST /issues/:id/cancel` | `{ expectedIssueVersion }` |
| `POST /issues/:id/retry` | `{ expectedIssueVersion }`; explicit retry of a failed issue |
| `POST /issues/:id/accept` | `{ deliveryId, expectedIssueVersion }` |
| `POST /issues/:id/rework` | `{ deliveryId, instructions, expectedIssueVersion }` |
| `PUT /issues/:id/evaluation` | `{ runId, deliveryId?, score, comment, expectedIssueVersion }` |
| `POST /issues/:id/integrations` | `{ deliveryId, expectedIssueVersion }`; create a candidate |
| `GET /applications/:id` | `Application` and verification evidence |
| `GET /applications/:id/verification` | bounded redacted `VerificationReport` with exit status, retained output and truncation metadata, or null; apply report takes precedence when present |
| `POST /applications/:id/apply` | `{ expectedTarget }`; explicit local apply |
| `GET /runs/:id` | `Run` and observed execution facts |
| `POST /runs/:id/checkpoint` | freeze failed/cancelled unfinished work only after durable managed-range exit proof; repeated request returns the existing checkpoint |
| `GET /runs/:id/events?after=` | durable observations from that Run |
| `POST /runs/:id/messages` | `{ text }`; returns stored versus delivered state |
| `POST /runs/:id/questions/:questionId/answer` | `{ answers }`; exact pending question only |
| `GET /events?projectId=&after=` | durable event page with monotonic cursor |
| `GET /events/stream?projectId=&after=` | SSE using the same event IDs |
| `GET /deliveries/:id/files/:path` | authorized content-addressed file download |
| `GET /checkpoints/:id/files/:path` | authorized unfinished artifact download; separate identity from Deliveries |

`Idempotency-Key` is required on issue creation, evaluation, integration, and
application requests. A repeated key with the same actor, project, operation,
and body returns the same stored entity at its current state; a different body conflicts. Every state
changing request checks the caller's project and action scope. A stale expected
version returns HTTP 409 with a stable error code. The API never exposes a
filesystem path as an authorization token.

Issue creation accepts optional `ownedPaths` and `readOnlyPaths`: exact relative
file names or directory prefixes ending in `/`, without glob or traversal syntax.
An empty owned list preserves legacy unrestricted scope; read-only paths remain
excluded. This is a scheduling and delivery constraint, not an OS sandbox.
Dependency release still requires the exact accepted file-changing Delivery to
have been applied. Repreparing against a changed target creates a new Application
identity and requires a new explicit apply request; prior verification is not reused.

Capacity counts include starting, running, waiting-for-input, cancelling and
unconfirmed-recovery Runs. Service restart does not establish managed-range exit
proof. Pauses and environment blockers survive restart; client disconnect never
requests cancellation. Project target registrations reject overlapping canonical
directories within this service.

Model text streamed as ACP updates is represented in durable events by update
metadata without raw text, because a credential can be split across chunks.
The finished assistant reply is redacted before becoming Delivery text.

## Browser session and external clients

The operator pairs the first browser session with a one-time local setup code.
The server returns an HttpOnly, SameSite=Strict cookie and a CSRF token. Writes
from the browser require a matching origin and CSRF header. External HTTP and
MCP clients use revocable project-scoped bearer tokens; worker processes never
receive them. API credentials and setup codes are not emitted in events or logs.

## MCP

MCP is a second adapter over the same application service and permission
checks. Its tools map to `project.list`, `profile.list/get`, `issue.create/get/list`,
`issue.comment/cancel/accept/rework/evaluate`, `run.get/events`,
`question.answer`, and `application.prepare/get/apply`. Long execution is never
held inside an `issue.create` call. `events.wait` has a timeout and cursor and
always reads the durable event store. A stdio connector forwards to the local
authenticated MCP endpoint without owning another business state machine.

Additional MCP tools expose `scheduler.get`, `project.dispatch/pause/readiness`,
`issue.plan/checkpoints/resume/retry`, `run.checkpoint` and
`application.verification`. Global capacity changes remain browser-operator only.
Project dispatch changes require `project.control`, scheduler reads require
`scheduler.read`, plan edits reuse `issue.create`, checkpoint continuation reuses
`issue.retry`, and checkpoint capture reuses `issue.rework` permissions.
