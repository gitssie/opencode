import { createMemo, createResource, createSignal, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import type { Agent } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { SettingsList } from "./settings-list"

type View = "list" | "detail" | "form"

interface FormState {
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
  prompt: string
  color: string
  hidden: boolean
  error: string | undefined
  saving: boolean
  deleting: boolean
  confirmDelete: boolean
}

const MODES = ["primary", "subagent", "all"] as const

const sourceOf = (agent: Agent) => {
  if (agent.native) return "native"
  return "config"
}

const isEditable = (agent: Agent) => !agent.native

export const SettingsAgents: Component = () => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()

  const [view, setView] = createSignal<View>("list")
  const [selected, setSelected] = createSignal<Agent | null>(null)
  const [isNew, setIsNew] = createSignal(false)
  const [query, setQuery] = createSignal("")

  const [form, setForm] = createStore<FormState>({
    name: "",
    description: "",
    mode: "all",
    prompt: "",
    color: "",
    hidden: false,
    error: undefined,
    saving: false,
    deleting: false,
    confirmDelete: false,
  })

  const [agents, actions] = createResource(async () => {
    const res = await sdk.client.app.agents()
    return (res.data ?? []) as Agent[]
  })

  const filtered = createMemo(() => {
    const q = query().toLowerCase()
    return (agents() ?? []).filter((a) => !a.hidden && (!q || a.name.toLowerCase().includes(q)))
  })

  const openCreate = () => {
    setForm({
      name: "",
      description: "",
      mode: "all",
      prompt: "",
      color: "",
      hidden: false,
      error: undefined,
      saving: false,
      deleting: false,
      confirmDelete: false,
    })
    setIsNew(true)
    setView("form")
  }

  const openEdit = (agent: Agent) => {
    setForm({
      name: agent.name,
      description: agent.description ?? "",
      mode: (agent.mode as "primary" | "subagent" | "all") ?? "all",
      prompt: agent.prompt ?? "",
      color: agent.color ?? "",
      hidden: agent.hidden ?? false,
      error: undefined,
      saving: false,
      deleting: false,
      confirmDelete: false,
    })
    setIsNew(false)
    setSelected(agent)
    setView("form")
  }

  const openDetail = (agent: Agent) => {
    setSelected(agent)
    setView("detail")
  }

  const backToList = () => {
    setView("list")
    setSelected(null)
  }

  const save = () => {
    if (form.saving) return

    if (!form.name.trim()) {
      setForm("error", language.t("settings.agents.form.name.required"))
      return
    }

    if (!/^[a-zA-Z0-9-]+$/.test(form.name.trim())) {
      setForm("error", language.t("settings.agents.form.name.invalid"))
      return
    }

    if (isNew()) {
      const existing = (agents() ?? []).map((a) => a.name)
      if (existing.includes(form.name.trim())) {
        setForm("error", language.t("settings.agents.form.name.duplicate"))
        return
      }
    }

    setForm({ error: undefined, saving: true })

    const cfg = {
      description: form.description || undefined,
      mode: form.mode,
      prompt: form.prompt || undefined,
      color: form.color || undefined,
      hidden: form.hidden || undefined,
    }

    const current = sync.data.config
    void sync
      .updateConfig({
        ...current,
        agent: { ...current.agent, [form.name.trim()]: cfg },
      })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("toast.agents.saved.title"),
        })
        setForm("saving", false)
        actions.refetch()
        backToList()
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setForm({ error: msg, saving: false })
      })
  }

  const deleteAgent = () => {
    if (!form.confirmDelete) {
      setForm("confirmDelete", true)
      return
    }

    setForm({ deleting: true, confirmDelete: false })

    const current = sync.data.config
    const agent = { ...(current.agent ?? {}) }
    delete agent[form.name]

    void sync
      .updateConfig({ ...current, agent })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("toast.agents.deleted.title"),
        })
        setForm("deleting", false)
        actions.refetch()
        backToList()
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setForm({ error: msg, deleting: false })
      })
  }

  const sourceLabel = (agent: Agent) => {
    const src = sourceOf(agent)
    if (src === "native") return language.t("settings.agents.source.native")
    return language.t("settings.agents.source.config")
  }

  const modeLabel = (mode: string) => {
    if (mode === "primary") return language.t("settings.agents.mode.primary")
    if (mode === "subagent") return language.t("settings.agents.mode.subagent")
    return language.t("settings.agents.mode.all")
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between pt-6 pb-8 max-w-[720px]">
          <div class="flex items-center gap-3">
            <Show when={view() !== "list"}>
              <Button
                variant="ghost"
                size="large"
                icon="arrow-left"
                onClick={backToList}
                class="px-0 hover:bg-transparent active:bg-transparent"
              >
                {language.t("common.back")}
              </Button>
            </Show>
            <h2 class="text-16-medium text-text-strong">
              <Show when={view() === "list"}>{language.t("settings.agents.title")}</Show>
              <Show when={view() === "detail"}>{selected()?.name}</Show>
              <Show when={view() === "form"}>
                {isNew()
                  ? language.t("settings.agents.form.create.title")
                  : language.t("settings.agents.form.edit.title")}
              </Show>
            </h2>
          </div>
          <Show when={view() === "list"}>
            <Button size="large" variant="secondary" icon="plus-small" onClick={openCreate}>
              {language.t("settings.agents.create.button")}
            </Button>
          </Show>
          <Show when={view() === "detail" && isEditable(selected()!)}>
            <Button size="large" variant="secondary" icon="pencil-line" onClick={() => openEdit(selected()!)}>
              {language.t("common.edit")}
            </Button>
          </Show>
        </div>
      </div>

      <div class="flex flex-col gap-4 max-w-[720px]">
        {/* LIST VIEW */}
        <Show when={view() === "list"}>
          <input
            type="text"
            class="w-full px-3 py-2 rounded-md bg-surface-base border border-border-weak-base text-14-regular text-text-strong placeholder:text-text-weak outline-none focus:border-border-base"
            placeholder={language.t("settings.agents.search.placeholder")}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <SettingsList>
            <Show
              when={filtered().length > 0}
              fallback={<div class="py-4 text-14-regular text-text-weak">{language.t("settings.agents.empty")}</div>}
            >
              <For each={filtered()}>
                {(agent) => (
                  <div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                    <button
                      class="flex items-center gap-3 min-w-0 flex-1 text-left"
                      onClick={() => openDetail(agent)}
                      data-action="agent-detail"
                    >
                      <Show when={agent.color}>
                        <span class="size-3 rounded-full shrink-0 inline-block" style={{ background: agent.color }} />
                      </Show>
                      <span class="text-14-medium text-text-strong truncate">{agent.name}</span>
                      <Tag>{sourceLabel(agent)}</Tag>
                      <Tag>{modeLabel(agent.mode)}</Tag>
                    </button>
                    <Show when={isEditable(agent)}>
                      <Button
                        size="large"
                        variant="ghost"
                        icon="pencil-line"
                        onClick={() => openEdit(agent)}
                        data-action="agent-edit"
                      />
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </SettingsList>
        </Show>

        {/* DETAIL VIEW */}
        <Show when={view() === "detail" && selected()}>
          {(agent) => (
            <div class="flex flex-col gap-6" data-component="agent-detail">
              <SettingsList>
                <div class="flex flex-col gap-4 py-4">
                  <div class="flex flex-wrap gap-2">
                    <Tag>{sourceLabel(agent())}</Tag>
                    <Tag>{modeLabel(agent().mode)}</Tag>
                    <Show when={agent().hidden}>
                      <Tag>{language.t("settings.agents.tag.hidden")}</Tag>
                    </Show>
                  </div>
                  <Show when={agent().description}>
                    <p class="text-14-regular text-text-base">{agent().description}</p>
                  </Show>
                  <Show when={agent().color}>
                    <div class="flex items-center gap-2">
                      <span class="text-12-medium text-text-weak">{language.t("settings.agents.detail.color")}</span>
                      <span class="size-4 rounded-full inline-block" style={{ background: agent().color }} />
                      <span class="text-12-regular text-text-base">{agent().color}</span>
                    </div>
                  </Show>
                  <Show when={agent().model}>
                    <div class="flex flex-col gap-1">
                      <span class="text-12-medium text-text-weak">{language.t("settings.agents.detail.model")}</span>
                      <span class="text-14-regular text-text-base">
                        {agent().model?.modelID} / {agent().model?.providerID}
                      </span>
                    </div>
                  </Show>
                  <Show when={!agent().model} fallback={null}>
                    <div class="flex flex-col gap-1">
                      <span class="text-12-medium text-text-weak">{language.t("settings.agents.detail.model")}</span>
                      <span class="text-14-regular text-text-weak">
                        {language.t("settings.agents.detail.model.inherited")}
                      </span>
                    </div>
                  </Show>
                  <Show when={agent().prompt}>
                    <div class="flex flex-col gap-2">
                      <span class="text-12-medium text-text-weak">{language.t("settings.agents.detail.prompt")}</span>
                      <pre class="text-12-regular text-text-base whitespace-pre-wrap bg-surface-base rounded-md p-3 max-h-64 overflow-y-auto">
                        {agent().prompt}
                      </pre>
                    </div>
                  </Show>
                </div>
              </SettingsList>
            </div>
          )}
        </Show>

        {/* FORM VIEW */}
        <Show when={view() === "form"}>
          <div class="flex flex-col gap-6" data-component="agent-form">
            <TextField
              label={language.t("settings.agents.form.name.label")}
              value={form.name}
              onChange={(v) => setForm("name", v)}
              placeholder={language.t("settings.agents.form.name.placeholder")}
              disabled={!isNew()}
              readOnly={!isNew()}
            />

            <TextField
              label={language.t("settings.agents.form.description.label")}
              value={form.description}
              onChange={(v) => setForm("description", v)}
              placeholder={language.t("settings.agents.form.description.placeholder")}
            />

            <div class="flex flex-col gap-2">
              <span class="text-12-medium text-text-weak">{language.t("settings.agents.form.mode.label")}</span>
              <div class="flex gap-2">
                <For each={MODES}>
                  {(m) => (
                    <Button
                      type="button"
                      size="large"
                      variant={form.mode === m ? "primary" : "secondary"}
                      onClick={() => setForm("mode", m)}
                    >
                      {modeLabel(m)}
                    </Button>
                  )}
                </For>
              </div>
            </div>

            <TextField
              label={language.t("settings.agents.form.prompt.label")}
              value={form.prompt}
              onChange={(v) => setForm("prompt", v)}
              placeholder={language.t("settings.agents.form.prompt.placeholder")}
              multiline
            />

            <div class="flex flex-col gap-2">
              <span class="text-12-medium text-text-weak">{language.t("settings.agents.form.color.label")}</span>
              <div class="flex items-center gap-3">
                <input
                  type="color"
                  class="size-8 rounded cursor-pointer border border-border-weak-base"
                  value={form.color || "#6366f1"}
                  onInput={(e) => setForm("color", e.currentTarget.value)}
                />
                <TextField
                  value={form.color}
                  onChange={(v) => setForm("color", v)}
                  placeholder="#rrggbb"
                  class="flex-1"
                />
              </div>
            </div>

            <label class="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                class="size-4 rounded accent-text-interactive-base"
                checked={form.hidden}
                onChange={(e) => setForm("hidden", e.currentTarget.checked)}
              />
              <span class="text-14-regular text-text-base">{language.t("settings.agents.form.hidden.label")}</span>
            </label>

            <Show when={form.error}>
              <p class="text-12-regular text-text-error">{form.error}</p>
            </Show>

            <div class="flex items-center justify-between gap-4 flex-wrap">
              <div class="flex gap-3">
                <Button size="large" variant="primary" disabled={form.saving} onClick={save}>
                  {form.saving ? language.t("common.saving") : language.t("common.save")}
                </Button>
                <Button size="large" variant="ghost" onClick={backToList}>
                  {language.t("common.cancel")}
                </Button>
              </div>
              <Show when={!isNew()}>
                <Button
                  size="large"
                  variant="ghost"
                  disabled={form.deleting}
                  class="text-text-error hover:bg-transparent"
                  onClick={deleteAgent}
                  data-action="agent-delete"
                >
                  {form.confirmDelete
                    ? language.t("settings.agents.form.delete.confirm")
                    : form.deleting
                      ? language.t("common.deleting")
                      : language.t("common.delete")}
                </Button>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
