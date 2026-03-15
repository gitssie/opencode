import { createMemo, createResource, createSignal, For, Show, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { SettingsList } from "./settings-list"

// ── skills.sh + GitHub types ─────────────────────────────────────────────────

type HubSkill = {
  slug: string // slug = source (owner/repo), used as install name
  name: string
  description: string
  installs: number
  source: string // "owner/repo"
}

type HubSkillFile = {
  path: string
  content: string
}

// ── skills.sh API ─────────────────────────────────────────────────────────────

const DEFAULT_QUERY = "skill"

async function fetchHub(q: string, fetcher = fetch): Promise<HubSkill[]> {
  // skills.sh requires a non-empty query; use a broad default when empty
  const query = q.trim() || DEFAULT_QUERY
  const url = `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`
  const res = await fetcher(url)
  if (!res.ok) throw new Error(`skills.sh: ${res.status}`)
  const json = await res.json()
  const list = (json.skills ?? []) as { id: string; name: string; installs: number; source: string }[]
  return list.map((s) => ({
    slug: s.id ?? s.source,
    name: s.name,
    description: "",
    installs: s.installs ?? 0,
    source: s.source,
  }))
}

// Fetch SKILL.md from GitHub raw content using source = "owner/repo"
async function fetchHubFiles(source: string, fetcher = fetch): Promise<HubSkillFile[]> {
  const candidates = [
    `https://raw.githubusercontent.com/${source}/main/SKILL.md`,
    `https://raw.githubusercontent.com/${source}/master/SKILL.md`,
    `https://raw.githubusercontent.com/${source}/main/skills/SKILL.md`,
  ]
  for (const url of candidates) {
    const res = await fetcher(url)
    if (res.ok) {
      const content = await res.text()
      return [{ path: "SKILL.md", content }]
    }
  }
  throw new Error(`Could not find SKILL.md in ${source}`)
}

// ── Installed skill type ──────────────────────────────────────────────────────

type InstalledSkill = {
  name: string
  location: string
  description: string
  content: string
}

const sdkSource = (location: string): "global" | "project" | "hub" => {
  if (location.includes("/.config/opencode") || location.includes(".config/opencode")) return "global"
  if (location.includes("/.opencode/")) return "project"
  return "hub"
}

// ── Component ─────────────────────────────────────────────────────────────────

type Tab = "installed" | "browse"

export const SettingsSkills: Component = () => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const platform = usePlatform()

  const [tab, setTab] = createSignal<Tab>("installed")
  const [search, setSearch] = createSignal("")
  const [pending, setPending] = createSignal<Record<string, boolean>>({})

  // ── Installed list from SDK (shows all sources) ───────────────────────────

  const [installed, installedActions] = createResource(async () => {
    const res = await sdk.client.app.skills()
    return (res.data ?? []) as InstalledSkill[]
  })

  // Installed names set (for "already installed" badge on Browse tab)
  const installedNames = createMemo(() => new Set((installed() ?? []).map((s) => s.name.toLowerCase())))

  // ── Browse: hub skills (fetched when tab = browse) ────────────────────────

  const fetcher = platform.fetch ?? fetch
  const [hubQuery, setHubQuery] = createSignal("")
  const [hubError, setHubError] = createSignal<string | undefined>(undefined)

  const [hubSkills, hubActions] = createResource(
    () => (tab() === "browse" ? hubQuery() : undefined),
    async (q) => {
      setHubError(undefined)
      return fetchHub(q, fetcher).catch((err: unknown) => {
        setHubError(err instanceof Error ? err.message : String(err))
        return [] as HubSkill[]
      })
    },
  )

  // ── Actions ───────────────────────────────────────────────────────────────

  const removeInstalled = (name: string) => {
    if (!platform.removeSkill) return
    void platform
      .removeSkill(name)
      .then(() => installedActions.refetch())
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  const install = (skill: HubSkill) => {
    if (!platform.installSkill) return
    setPending((prev) => ({ ...prev, [skill.slug]: true }))
    const localName = skill.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
    void fetchHubFiles(skill.source, fetcher)
      .then((files) => platform.installSkill!(localName, files))
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.skills.install.success"),
          description: skill.name,
        })
        installedActions.refetch()
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setPending((prev) => ({ ...prev, [skill.slug]: false })))
  }

  const uninstallHub = (_skill: HubSkill, localName: string) => {
    if (!platform.removeSkill) return
    void platform
      .removeSkill(localName)
      .then(() => installedActions.refetch())
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  const doSearch = () => {
    setHubQuery(search())
    hubActions.refetch()
  }

  const sourceLabel = (loc: string) => {
    const s = sdkSource(loc)
    if (s === "global") return language.t("settings.skills.source.global")
    if (s === "project") return language.t("settings.skills.source.project")
    return language.t("settings.skills.source.hub")
  }

  const sourceColor = (loc: string) => {
    const s = sdkSource(loc)
    if (s === "global") return "text-text-interactive-base"
    if (s === "project") return "text-text-success"
    return "text-text-weak"
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      {/* Header */}
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between pt-6 pb-4 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.skills.title")}</h2>
        </div>
        {/* Tab bar */}
        <div class="flex gap-1 pb-4 max-w-[720px]">
          <Button
            type="button"
            size="large"
            variant={tab() === "installed" ? "primary" : "secondary"}
            onClick={() => setTab("installed")}
          >
            {language.t("settings.skills.tab.installed")}
          </Button>
          <Button
            type="button"
            size="large"
            variant={tab() === "browse" ? "primary" : "secondary"}
            onClick={() => setTab("browse")}
          >
            {language.t("settings.skills.tab.browse")}
          </Button>
        </div>
      </div>

      <div class="flex flex-col gap-6 max-w-[720px]">
        {/* ── Installed Tab ─────────────────────────────────────────────── */}
        <Show when={tab() === "installed"}>
          <Show
            when={(installed()?.length ?? 0) > 0}
            fallback={
              <Show when={!installed.loading} fallback={<Spinner class="mt-8 mx-auto" />}>
                <div class="py-4 text-14-regular text-text-weak">{language.t("settings.skills.empty")}</div>
              </Show>
            }
          >
            <SettingsList>
              <For each={installed()}>
                {(skill) => (
                  <div
                    class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none"
                    data-component="skill-row"
                  >
                    <div class="flex flex-col gap-1 min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="text-14-medium text-text-strong truncate">{skill.name}</span>
                        <Tag>
                          <span class={sourceColor(skill.location)}>{sourceLabel(skill.location)}</span>
                        </Tag>
                      </div>
                      <Show when={skill.description}>
                        <span class="text-13-regular text-text-weak truncate">{skill.description}</span>
                      </Show>
                    </div>
                    <Show when={platform.removeSkill && sdkSource(skill.location) === "global"}>
                      <Button
                        size="large"
                        variant="ghost"
                        data-action="skill-remove"
                        onClick={() => removeInstalled(skill.name)}
                      >
                        {language.t("common.remove")}
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </SettingsList>
          </Show>
        </Show>

        {/* ── Browse Tab ────────────────────────────────────────────────── */}
        <Show when={tab() === "browse"}>
          <Show
            when={platform.platform === "desktop"}
            fallback={
              <div class="py-4 text-14-regular text-text-weak">{language.t("settings.skills.browse.desktopOnly")}</div>
            }
          >
            {/* Search bar */}
            <div class="flex gap-2">
              <div class="flex-1">
                <TextField
                  value={search()}
                  onChange={setSearch}
                  placeholder={language.t("settings.skills.browse.search")}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter") doSearch()
                  }}
                />
              </div>
              <Button size="large" variant="secondary" onClick={doSearch}>
                {language.t("settings.skills.browse.searchButton")}
              </Button>
            </div>

            <Show when={hubSkills.loading}>
              <Spinner class="mt-4 mx-auto" />
            </Show>

            <Show when={hubError()}>
              <div class="py-4 text-14-regular text-text-error">{hubError()}</div>
            </Show>

            <Show when={!hubSkills.loading}>
              <Show
                when={(hubSkills()?.length ?? 0) > 0}
                fallback={
                  <div class="py-4 text-14-regular text-text-weak">{language.t("settings.skills.browse.empty")}</div>
                }
              >
                <SettingsList>
                  <For each={hubSkills()}>
                    {(skill) => {
                      const localName = skill.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
                      const installed_ = createMemo(() => installedNames().has(localName))
                      const loading_ = createMemo(() => !!pending()[skill.slug])
                      return (
                        <div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                          <div class="flex flex-col gap-1 min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <span class="text-14-medium text-text-strong truncate">{skill.name || skill.slug}</span>
                              <Show when={installed_()}>
                                <Tag>
                                  <span class="text-text-success">
                                    {language.t("settings.skills.browse.installed")}
                                  </span>
                                </Tag>
                              </Show>
                            </div>
                            <Show when={skill.description}>
                              <span class="text-13-regular text-text-weak truncate">{skill.description}</span>
                            </Show>
                            <Show when={skill.installs > 0}>
                              <span class="text-12-regular text-text-weaker">↓ {skill.installs}</span>
                            </Show>
                          </div>
                          <Show when={platform.installSkill}>
                            <Show
                              when={!installed_()}
                              fallback={
                                <Button
                                  size="large"
                                  variant="ghost"
                                  data-action="skill-uninstall"
                                  onClick={() => uninstallHub(skill, localName)}
                                >
                                  {language.t("common.remove")}
                                </Button>
                              }
                            >
                              <Button
                                size="large"
                                variant="secondary"
                                data-action="skill-install"
                                disabled={loading_()}
                                onClick={() => install(skill)}
                              >
                                <Show when={loading_()} fallback={language.t("settings.skills.browse.install")}>
                                  <Spinner class="size-4" />
                                </Show>
                              </Button>
                            </Show>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </SettingsList>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}
