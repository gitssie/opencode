import { Layer } from "effect"
import { SandboxFs } from "./fs"
import { SandboxSpawner } from "./spawner"

// Both sandbox layers are gated internally on the OPENCODE_SANDBOX runtime flag:
// when sandbox mode is off they pass through to the real services unchanged.
export const layer = Layer.mergeAll(SandboxFs.layer, SandboxSpawner.layer)

export * as Sandbox from "."
