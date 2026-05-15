import { Layer } from "effect"
import { SandboxFs } from "./fs"
import { SandboxSpawner } from "./spawner"

export const layer = Layer.mergeAll(SandboxFs.layer, SandboxSpawner.layer)

export * as Sandbox from "."
