/**
 * Plugin auto-installer: bun add --exact --cwd <cacheDir> <pkg>@<version>
 */

import path from "node:path"
import { $ } from "bun"
import { xdgCache } from "xdg-basedir"

const cacheDir = path.join(xdgCache!, "opencode")

export async function installPlugin(pkg: string, version = "latest"): Promise<string> {
  const modPath = path.join(cacheDir, "node_modules", pkg)
  if (await Bun.file(path.join(modPath, "package.json")).exists()) return modPath
  await $`bun add --exact --cwd ${cacheDir} ${pkg}@${version}`
  return modPath
}
