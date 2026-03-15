import path from "node:path"
import { xdgConfig } from "xdg-basedir"
import { writeJsonFileAtomically } from "../shims/openclaw-plugin-sdk.ts"

const configPath = path.join(xdgConfig!, "opencode", "openclaw.json")

export function buildRuntimeConfig() {
  return {
    async writeConfigFile(cfg: unknown) {
      await writeJsonFileAtomically(configPath, cfg)
    },
  }
}
