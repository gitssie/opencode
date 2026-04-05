import { Effect } from "effect"
import { ulid } from "ulid"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { MessageV2 } from "./message-v2"
import { PartID } from "./schema"
import { Session } from "."

export namespace LoopExit {
  interface Input {
    lastAssistant: MessageV2.WithParts
    tool: {
      create: (input: {
        tool: string
        input: Record<string, unknown>
        title?: string
        metadata?: Record<string, unknown>
      }) => Promise<MessageV2.ToolPart>
      complete: (
        part: MessageV2.ToolPart,
        input?: {
          title?: string
          output?: string
          metadata?: Record<string, unknown>
        },
      ) => Promise<MessageV2.ToolPart>
      error: (
        part: MessageV2.ToolPart,
        input?: {
          error?: string
          metadata?: Record<string, unknown>
        },
      ) => Promise<MessageV2.ToolPart>
    }
    question: {
      ask: (
        part: MessageV2.ToolPart,
        questions: Array<{
          question: string
          header: string
          options: Array<{ label: string; description: string }>
          multiple?: boolean
        }>,
      ) => Promise<string[][]>
    }
  }

  type Trigger = (
    name: "experimental.chat.loop.exit",
    input: Input,
    output: { exit: boolean },
  ) => Effect.Effect<{ exit: boolean }>

  interface RunInput {
    plugin: Plugin.Interface
    session: Session.Info
    sessions: Session.Interface
    question: Question.Interface
    lastAssistant?: MessageV2.WithParts
    lastUser: MessageV2.User
  }

  export const shouldExit = Effect.fn("LoopExit.shouldExit")(function* (input: RunInput) {
    if (input.session.parentID) return true
    if (!input.lastAssistant) return true
    if (input.lastUser.tools?.question === false) return true
    const lastAssistant = input.lastAssistant

    const sync = (part: MessageV2.ToolPart) => {
      const idx = lastAssistant.parts.findIndex((item) => item.id === part.id)
      if (idx === -1) lastAssistant.parts.push(part)
      else lastAssistant.parts[idx] = part
      return part
    }

    const update = (part: MessageV2.ToolPart) =>
      Effect.runPromise(input.sessions.updatePart(part)).then(sync) as Promise<MessageV2.ToolPart>

    const tool: Input["tool"] = {
      create: async (value) => {
        return update({
          id: PartID.ascending(),
          sessionID: lastAssistant.info.sessionID,
          messageID: lastAssistant.info.id,
          type: "tool",
          callID: ulid(),
          tool: value.tool,
          state: {
            status: "running",
            input: value.input,
            title: value.title,
            metadata: value.metadata,
            time: { start: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      },
      complete: async (part, value) => {
        const title =
          part.state.status === "running" || part.state.status === "completed" ? (part.state.title ?? "") : ""
        const metadata =
          part.state.status === "running" || part.state.status === "completed" ? (part.state.metadata ?? {}) : {}
        return update({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: value?.title ?? title,
            output: value?.output ?? (part.state.status === "completed" ? part.state.output : ""),
            metadata: value?.metadata ?? metadata,
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
          },
        } satisfies MessageV2.ToolPart)
      },
      error: async (part, value) => {
        return update({
          ...part,
          state: {
            status: "error",
            input: part.state.input,
            error: value?.error ?? (part.state.status === "error" ? part.state.error : "Error"),
            metadata:
              value?.metadata ??
              (part.state.status === "running" || part.state.status === "error" ? part.state.metadata : undefined),
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
          },
        } satisfies MessageV2.ToolPart)
      },
    }

    const questionTool: Input["question"] = {
      ask: async (part, questions) => {
        return Effect.runPromise(
          input.question.ask({
            sessionID: lastAssistant.info.sessionID,
            questions,
            tool: {
              messageID: part.messageID,
              callID: part.callID,
            },
          }),
        )
      },
    }

    const trigger = input.plugin.trigger as unknown as Trigger
    const output = yield* trigger(
      "experimental.chat.loop.exit",
      {
        lastAssistant,
        tool,
        question: questionTool,
      },
      { exit: true },
    )

    return output.exit
  })
}
