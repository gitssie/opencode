import { createMemo, createResource, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import type { McpStatus } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { SettingsList } from "./settings-list"

type View = "list" | "add"
type McpType = "local" | "remote"

export const SettingsMcp: Component = () => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const platform = usePlatform()

  const [store, setStore] = createStore({
    view: "list" as View,
    addType: "local" as McpType,
    name: "",
    command: "",
    url: "",
    error: undefined as string | undefined,
    saving: false,
  })

  const [status, actions] = createResource(async () => {
    const res = await sdk.client.mcp.status()
    return res.data ?? {}
  })

  const remove = (name: string) => {
    if (!platform.removeMcp) return
    void platform
      .removeMcp(name)
      .then(() => actions.refetch())
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: msg })
      })
  }

  const entries = createMemo(() => Object.entries(status() ?? {}))

  const color = (s: McpStatus) => {
    if (s.status === "connected") return "text-text-success"
    if (s.status === "failed") return "text-text-error"
    if (s.status === "disabled") return "text-text-weak"
    return "text-text-warning"
  }

  const label = (s: McpStatus) => {
    if (s.status === "connected") return language.t("settings.mcp.status.connected")
    if (s.status === "disabled") return language.t("settings.mcp.status.disabled")
    if (s.status === "failed") return language.t("settings.mcp.status.failed")
    if (s.status === "needs_auth") return language.t("settings.mcp.status.needs_auth")
    return language.t("settings.mcp.status.needs_client_registration")
  }

  const submit = (e: SubmitEvent) => {
    e.preventDefault()
    if (store.saving) return

    if (!store.name.trim()) {
      setStore("error", language.t("settings.mcp.add.name.required"))
      return
    }

    if (store.addType === "local" && !store.command.trim()) {
      setStore("error", language.t("settings.mcp.add.command.required"))
      return
    }

    if (store.addType === "remote" && !store.url.trim()) {
      setStore("error", language.t("settings.mcp.add.url.required"))
      return
    }

    setStore({ error: undefined, saving: true })

    const cfg =
      store.addType === "local"
        ? { type: "local" as const, command: store.command.trim().split(/\s+/) }
        : { type: "remote" as const, url: store.url.trim() }

    void sdk.client.mcp
      .add({ name: store.name.trim(), config: cfg })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.mcp.title"),
          description: store.name,
        })
        setStore({ view: "list", name: "", command: "", url: "", saving: false })
        actions.refetch()
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setStore({ error: msg, saving: false })
      })
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.mcp.title")}</h2>
          <Show when={store.view === "list"}>
            <Button
              size="large"
              variant="secondary"
              icon="plus-small"
              onClick={() => setStore({ view: "add", error: undefined })}
            >
              {language.t("settings.mcp.add.button")}
            </Button>
          </Show>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <Show when={store.view === "list"}>
          <div class="flex flex-col gap-1" data-component="mcp-server-list">
            <SettingsList>
              <Show
                when={entries().length > 0}
                fallback={<div class="py-4 text-14-regular text-text-weak">{language.t("settings.mcp.empty")}</div>}
              >
                <For each={entries()}>
                  {([name, s]) => (
                    <div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                      <div class="flex items-center gap-3 min-w-0">
                        <span class="text-14-medium text-text-strong truncate">{name}</span>
                        <Tag>
                          <span class={color(s)}>{label(s)}</span>
                        </Tag>
                        <Show when={s.status === "failed"}>
                          <span class="text-12-regular text-text-error truncate max-w-[200px]">
                            {(s as { status: "failed"; error: string }).error}
                          </span>
                        </Show>
                      </div>
                      <Show when={platform.removeMcp}>
                        <div class="flex items-center gap-2">
                          <Button size="large" variant="ghost" data-action="mcp-remove" onClick={() => remove(name)}>
                            {language.t("common.remove")}
                          </Button>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </SettingsList>
          </div>
        </Show>

        <Show when={store.view === "add"}>
          <form onSubmit={submit} class="flex flex-col gap-6">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.mcp.add.title")}</h3>

            <div class="flex gap-3">
              <Button
                type="button"
                size="large"
                variant={store.addType === "local" ? "primary" : "secondary"}
                onClick={() => setStore("addType", "local")}
              >
                {language.t("settings.mcp.add.type.local")}
              </Button>
              <Button
                type="button"
                size="large"
                variant={store.addType === "remote" ? "primary" : "secondary"}
                onClick={() => setStore("addType", "remote")}
              >
                {language.t("settings.mcp.add.type.remote")}
              </Button>
            </div>

            <TextField
              label={language.t("settings.mcp.add.name.label")}
              value={store.name}
              onChange={(v) => setStore("name", v)}
              placeholder={language.t("settings.mcp.add.name.placeholder")}
            />

            <Show when={store.addType === "local"}>
              <div class="flex flex-col gap-2">
                <TextField
                  label={language.t("settings.mcp.add.command.label")}
                  value={store.command}
                  onChange={(v) => setStore("command", v)}
                  placeholder={language.t("settings.mcp.add.command.placeholder")}
                />
                <Show when={platform.platform === "desktop"}>
                  <Button
                    type="button"
                    variant="ghost"
                    class="px-0 self-start text-14-medium text-text-interactive-base hover:bg-transparent active:bg-transparent"
                    onClick={() =>
                      void platform.openFilePickerDialog?.().then((p) => {
                        if (p && !Array.isArray(p)) setStore("command", p)
                        else if (Array.isArray(p) && p.length > 0) setStore("command", p[0])
                      })
                    }
                  >
                    {language.t("settings.mcp.add.command.browse")}
                  </Button>
                </Show>
              </div>
            </Show>

            <Show when={store.addType === "remote"}>
              <TextField
                label={language.t("settings.mcp.add.url.label")}
                value={store.url}
                onChange={(v) => setStore("url", v)}
                placeholder={language.t("settings.mcp.add.url.placeholder")}
              />
            </Show>

            <Show when={store.error}>
              <p class="text-12-regular text-text-error">{store.error}</p>
            </Show>

            <div class="flex gap-3">
              <Button type="submit" size="large" variant="primary" disabled={store.saving}>
                {store.saving ? language.t("common.saving") : language.t("common.save")}
              </Button>
              <Button
                type="button"
                size="large"
                variant="ghost"
                onClick={() => setStore({ view: "list", name: "", command: "", url: "", error: undefined })}
              >
                {language.t("common.cancel")}
              </Button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  )
}
