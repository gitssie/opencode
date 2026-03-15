export function buildRuntimeRouting() {
  return {
    resolveAgentRoute(params: {
      channel: string
      accountId?: string | null
      peer?: { kind: string; id: string } | null
    }) {
      const acct = (params.accountId ?? "default").trim().toLowerCase()
      const kind = (params.peer?.kind ?? "direct").trim().toLowerCase()
      const id = (params.peer?.id ?? "").trim().toLowerCase()
      const key = `${params.channel}:${acct}:${kind}:${id}`
      return { sessionKey: key, agentId: "main" }
    },
  }
}
