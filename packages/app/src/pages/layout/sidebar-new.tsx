import type { Session } from "@opencode-ai/sdk/v2/client"
import { A } from "@solidjs/router"
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js"
import { base64Encode } from "@opencode-ai/util/encode"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { type LocalProject } from "@/context/layout"
import { messageAgentColor } from "@/utils/agent"
import { displayName, sortedRootSessions } from "./helpers"
import { ProjectIcon } from "./sidebar-items"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"

// ─── Section Header ───────────────────────────────────────────────────────────

const SectionHeader = (props: { label: string; action?: JSX.Element }): JSX.Element => (
  <div class="flex items-center justify-between px-3 h-7 shrink-0 select-none">
    <span class="text-11-medium text-text-weaker uppercase tracking-widest truncate">{props.label}</span>
    <Show when={props.action}>{props.action}</Show>
  </div>
)

// ─── NestedSessionItem: per-session reactive row ─────────────────────────────

const NestedSessionItem = (props: {
  session: Session
  archiveSession: (session: Session) => Promise<void>
}): JSX.Element => {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()

  const slug = base64Encode(props.session.directory)
  const [store] = globalSync.child(props.session.directory)

  const hasPerms = createMemo(
    () =>
      !!sessionPermissionRequest(
        store.session,
        store.permission,
        props.session.id,
        (item) => !permission.autoResponds(item, props.session.directory),
      ),
  )

  const isWorking = createMemo(() => {
    if (hasPerms()) return false
    const status = store.session_status[props.session.id]
    if (!status || status.type === "idle") return false
    const pending = (store.message[props.session.id] ?? []).findLast(
      (m) => m.role === "assistant" && typeof (m as { time?: { completed?: unknown } }).time?.completed !== "number",
    )
    return pending !== undefined || status.type === "busy" || status.type === "retry"
  })

  const tint = createMemo(() => messageAgentColor(store.message[props.session.id], store.agent))
  const unseen = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasErr = createMemo(() => notification.session.unseenHasError(props.session.id))

  return (
    <div class="group/session relative w-full rounded-md cursor-default pl-2 pr-3 transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <A
        href={`/${slug}/session/${props.session.id}`}
        class="flex items-center justify-between gap-3 min-w-0 text-left w-full focus:outline-none py-1.5 group-hover/session:pr-7 group-focus-within/session:pr-7"
        data-action="session-switch"
      >
        <div class="flex items-center gap-1 w-full">
          <div
            class="shrink-0 size-6 flex items-center justify-center"
            style={{ color: tint() ?? "var(--icon-interactive-base)" }}
          >
            <Switch fallback={<div class="size-1.5 rounded-full bg-current opacity-40" />}>
              <Match when={isWorking()}>
                <Spinner class="size-[15px]" />
              </Match>
              <Match when={hasPerms()}>
                <div class="size-1.5 rounded-full bg-surface-warning-strong" />
              </Match>
              <Match when={hasErr()}>
                <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
              </Match>
              <Match when={unseen() > 0}>
                <div class="size-1.5 rounded-full bg-text-interactive-base" />
              </Match>
            </Switch>
          </div>
          <span class="text-14-regular text-text-strong grow-1 min-w-0 overflow-hidden text-ellipsis truncate">
            {props.session.title || language.t("command.session.new")}
          </span>
        </div>
      </A>

      {/* Archive button – shown on hover, matches original SessionItem */}
      <div class="absolute top-1.5 right-1 flex items-center gap-0.5 transition-opacity opacity-0 pointer-events-none group-hover/session:opacity-100 group-hover/session:pointer-events-auto group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto">
        <Tooltip value={language.t("common.archive")} placement="top">
          <IconButton
            icon="archive"
            variant="ghost"
            class="size-6 rounded-md"
            aria-label={language.t("common.archive")}
            onClick={(e: MouseEvent) => {
              e.preventDefault()
              e.stopPropagation()
              void props.archiveSession(props.session)
            }}
          />
        </Tooltip>
      </div>
    </div>
  )
}

// ─── ProjectRow: expandable project with nested sessions ─────────────────────

const ProjectRow = (props: {
  project: LocalProject
  active: Accessor<boolean>
  unseen: Accessor<number>
  sortNow: Accessor<number>
  onSelect: () => void
  onNewSession: () => void
  archiveSession: (session: Session) => Promise<void>
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
}): JSX.Element => {
  const language = useLanguage()
  const globalSync = useGlobalSync()

  const [expanded, setExpanded] = createSignal(props.active())

  const store = createMemo(() => globalSync.child(props.project.worktree, { bootstrap: false })[0])
  const sessions = createMemo(() => sortedRootSessions(store(), props.sortNow()))

  return (
    <div class="flex flex-col">
      {/* Project row */}
      <ContextMenu>
        <ContextMenu.Trigger
          as="div"
          class="group flex items-center gap-0.5 px-1 py-0.5 rounded-lg transition-colors"
          classList={{
            "bg-surface-base-hover border border-border-weak-base": props.active(),
            "border border-transparent hover:bg-surface-base-hover hover:border-border-weak-base": !props.active(),
          }}
        >
          {/* Expand toggle */}
          <button
            type="button"
            class="shrink-0 size-5 flex items-center justify-center rounded hover:bg-surface-base-hover transition-colors"
            onClick={() => setExpanded((v) => !v)}
            aria-label="toggle sessions"
          >
            <Icon
              name="chevron-right"
              size="small"
              class="transition-transform duration-150"
              classList={{
                "rotate-90 text-icon-base": expanded(),
                "text-icon-weaker": !expanded(),
              }}
            />
          </button>

          {/* Project icon + name */}
          <button
            type="button"
            data-action="project-switch"
            data-project={base64Encode(props.project.worktree)}
            class="flex items-center gap-2 flex-1 min-w-0 px-1.5 py-1 rounded-md transition-colors hover:bg-surface-base-hover cursor-default"
            onClick={props.onSelect}
          >
            <ProjectIcon project={props.project} notify class="size-5 shrink-0" />
            <span class="text-14-medium truncate flex-1 min-w-0 text-text-base text-left">
              {displayName(props.project)}
            </span>
            <Show when={props.unseen() > 0}>
              <span class="shrink-0 size-1.5 rounded-full bg-text-interactive-base" />
            </Show>
          </button>

          {/* New session shortcut – visible on hover */}
          <Tooltip placement="right" value={language.t("command.session.new")}>
            <IconButton
              icon="new-session"
              variant="ghost"
              size="small"
              class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e: MouseEvent) => {
                e.stopPropagation()
                props.onNewSession()
              }}
              aria-label={language.t("command.session.new")}
            />
          </Tooltip>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => props.showEditProjectDialog(props.project)}>
              <ContextMenu.ItemLabel>{language.t("common.edit")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => props.closeProject(props.project.worktree)}>
              <ContextMenu.ItemLabel>{language.t("common.close")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>

      {/* Nested sessions */}
      <Show when={expanded()}>
        <div class="flex flex-col mt-0.5 ml-6 mr-1 mb-2 border-l border-border-weak-base pl-1">
          <For
            each={sessions()}
            fallback={
              <div class="px-2 py-1 text-12-regular text-text-weaker italic">{language.t("sidebar.tasks.empty")}</div>
            }
          >
            {(session) => <NestedSessionItem session={session} archiveSession={props.archiveSession} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ─── NewSidebar ───────────────────────────────────────────────────────────────

export const NewSidebar: Component<{
  currentDir: Accessor<string>
  projects: Accessor<LocalProject[]>
  sortNow: Accessor<number>
  onOpenProject: () => void
  onOpenSettings: () => void
  onOpenSkills: () => void
  navigateToProject: (directory: string) => void
  navigateToNewSession: (directory: string) => void
  archiveSession: (session: Session) => Promise<void>
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
}> = (props) => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const notification = useNotification()

  // ── Skills data ──────────────────────────────────────────────────────────
  const [skills] = createResource(
    () => props.currentDir() || "global",
    async () => {
      const dir = props.currentDir()
      const res = await sdk.client.app.skills(dir ? { directory: dir } : undefined)
      return res.data ?? []
    },
  )

  const skillCount = createMemo(() => skills()?.length ?? 0)

  // ── Notification helpers ─────────────────────────────────────────────────
  const projectUnseen = (project: LocalProject) => {
    const dirs = [project.worktree, ...(project.sandboxes ?? [])]
    return dirs.reduce((n, d) => n + notification.project.unseenCount(d), 0)
  }

  return (
    <div class="flex flex-col h-full bg-background-base border-r border-border-weaker-base overflow-hidden">
      {/* Scrollable sections */}
      <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar py-3 flex flex-col gap-4">
        {/* ── SKILLS ──────────────────────────────────────────────────────── */}
        <div class="flex flex-col" data-component="sidebar-skills">
          <SectionHeader label={language.t("sidebar.section.skills")} />
          <div class="px-1">
            <button
              type="button"
              class="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-left cursor-default transition-colors hover:bg-surface-base-hover"
              onClick={props.onOpenSkills}
              data-action="skills-open"
            >
              <Icon name="task" size="small" class="shrink-0 text-icon-base" />
              <span class="text-13-regular text-text-base flex-1 min-w-0">
                {language.t("sidebar.skills.count", { count: String(skillCount()) })}
              </span>
              <Icon name="chevron-right" size="small" class="shrink-0 text-icon-weak" />
            </button>
          </div>
        </div>

        {/* ── PROJECTS + nested sessions ──────────────────────────────────── */}
        <div class="flex flex-col gap-1" data-component="sidebar-projects">
          <SectionHeader
            label={language.t("sidebar.section.projects")}
            action={
              <Tooltip placement="right" value={language.t("command.project.open")}>
                <IconButton
                  icon="plus"
                  variant="ghost"
                  size="small"
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    props.onOpenProject()
                  }}
                  aria-label={language.t("command.project.open")}
                />
              </Tooltip>
            }
          />
          <div class="flex flex-col gap-0.5 px-1">
            <For
              each={props.projects()}
              fallback={
                <button
                  type="button"
                  class="flex items-center gap-2 w-full mx-2 py-2 text-left cursor-default transition-colors text-text-weaker hover:text-text-weak"
                  onClick={props.onOpenProject}
                >
                  <Icon name="plus-small" size="small" class="shrink-0" />
                  <span class="text-12-regular">{language.t("command.project.open")}</span>
                </button>
              }
            >
              {(project) => {
                const active = createMemo(() => project.worktree === props.currentDir())
                const unseen = createMemo(() => projectUnseen(project))
                return (
                  <ProjectRow
                    project={project}
                    active={active}
                    unseen={unseen}
                    sortNow={props.sortNow}
                    onSelect={() => props.navigateToProject(project.worktree)}
                    onNewSession={() => props.navigateToNewSession(project.worktree)}
                    archiveSession={props.archiveSession}
                    closeProject={props.closeProject}
                    showEditProjectDialog={props.showEditProjectDialog}
                  />
                )
              }}
            </For>
          </div>
        </div>
      </div>

      {/* ── Bottom bar ──────────────────────────────────────────────────────── */}
      <div class="shrink-0 flex items-center justify-between px-3 py-3 border-t border-border-weaker-base">
        <Tooltip placement="top" value={language.t("sidebar.settings")}>
          <IconButton
            icon="settings-gear"
            variant="ghost"
            size="large"
            onClick={props.onOpenSettings}
            aria-label={language.t("sidebar.settings")}
          />
        </Tooltip>
      </div>
    </div>
  )
}
