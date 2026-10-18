import { StdioRpcClient, type StdioRpcClientOptions, type StdioRpcTransport } from '../rpc-client.js'
import type { ClientMethods } from './protocol.js'

export type CodexClientOptions = StdioRpcClientOptions
export type CodexTransport = StdioRpcTransport<ClientMethods>

/** One owned `codex app-server` child. */
export class CodexRpcClient extends StdioRpcClient<ClientMethods> {
  constructor(options: CodexClientOptions) {
    super(options, {
      label: 'Codex app-server',
      executable: 'codex',
      args: ['app-server'],
      // requestUserInput is experimental in 0.159.3, so this chat opts in.
      initialize: { clientInfo: { name: 'commando', title: 'Commando', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } },
    })
  }
}
