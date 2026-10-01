import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createAcpClient,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ClientContext,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

export { methods, PROTOCOL_VERSION }

export interface AcpClientHooks {
  onUpdate(notification: SessionNotification): void
  onPermission(request: RequestPermissionRequest, requestId: string): Promise<RequestPermissionResponse>
}

export function connectAcpClient(child: SubprocessHandle, hooks: AcpClientHooks): ClientConnection {
  if (child.stdin === undefined || child.stdout === undefined) {
    throw new Error('subprocess-local dropped ACP stdin/stdout pipes')
  }
  const app = createAcpClient({ name: 'lachesis-runtime' })
    .onNotification(methods.client.session.update, ({ params }) => {
      hooks.onUpdate(params)
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params, requestId }) => {
      return hooks.onPermission(params, String(requestId))
    })
  return app.connect(ndJsonStream(
    NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
}

export type AcpAgent = ClientContext
