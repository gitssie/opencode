import { Layer } from "effect"
import { SandboxSpawner } from "./spawner"

// SandboxFs is disabled pending re-port onto upstream's new FileSystem/FSUtil
// architecture (see opencode-3j8). Only the spawner sandbox is active.
export const layer = Layer.mergeAll(SandboxSpawner.layer)

export * as Sandbox from "."
