import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { DatabaseTesting } from "@opencode-ai/core/database/testing"
import { Integration } from "@opencode-ai/core/integration"
import { it } from "./lib/effect"

function layer() {
  return Credential.layer.pipe(Layer.provide(DatabaseTesting.layer.pipe(Layer.fresh)))
}

describe("Credential", () => {
  it.live("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("openai")
          const created = yield* credentials.create({
            integrationID,
            label: "Work",
            value: new Credential.Key({ type: "key", key: "secret" }),
          })

          expect(yield* credentials.list(integrationID)).toEqual([created])
          yield* credentials.update(created.id, { label: "Personal" })
          expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

          const replacement = yield* credentials.create({
            integrationID,
            label: "Replacement",
            value: new Credential.Key({ type: "key", key: "replacement" }),
          })
          expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }).pipe(Effect.provide(layer())),
  )
})
