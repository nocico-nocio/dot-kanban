import { requestJson } from "./api-client";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  editableSettings,
  type RoutingSettings,
  type RoutingResult,
  type Service,
} from "../worker/routing";
import {
  detectLocale,
  formatDate,
  formatElapsed,
  formatNumber,
  initialLocale,
  locales,
  t,
  type Locale,
} from "./i18n";
import { ProjectsScreen } from "./ProjectsScreen";
import { McpConnectionsScreen } from "./McpConnectionsScreen";
import { SettingsScreen } from "./SettingsScreen";
import { ServiceIcon } from "./ServiceIcon";
import { TaskProjectEditor } from "./TaskProjectEditor";
import { useLiveRefresh } from "./useLiveRefresh";
import { usePullToRefresh } from "./usePullToRefresh";
import { ConnectionPicker } from "./ConnectionPicker";
import type { ConnectionState } from "../worker/connections";
import { TaskExecutionBadge } from "./TaskExecutionBadge";
import { TaskStatusEditor } from "./TaskStatusEditor";
import { InlineText } from "./InlineText";
import { DescriptionEditor, DescriptionContent } from "./DescriptionEditor";
import { OverflowMenu } from "./OverflowMenu";
import { PwaStatus } from "./Pwa";
import "./style.css";

type Status = "backlog" | "todo" | "in_progress" | "review" | "done" | "stopped";
type TaskType = "general" | "coding" | "research" | "writing";
type Task = {
  id: string;
  title: string;
  description: string;
  project: string;
  due_date: string | null;
  status: Status;
  dispatch: "draft" | "requested";
  approval_required: number;
  depends_on: string[];
  archived_at: string | null;
  version: number;
  updated_at: string;
  created_at: string;
  status_changed_at: string | null;
  task_type: TaskType;
  mcp_connection_id: string | null;
  agent_preference: string;
  model_preference: string;
  target_preference: string;
  routing?: RoutingResult;
};
type Event = {
  id: string;
  kind: string;
  body: string;
  result_url: string | null;
  actor: string;
  created_at: string;
};
type TaskForm = Omit<
  Task,
  | "id"
  | "version"
  | "updated_at"
  | "created_at"
  | "status_changed_at"
  | "archived_at"
  | "routing"
  | "approval_required"
  | "due_date"
> & { approval_required: boolean; due_date: string };
const columns: Status[] = ["backlog", "todo", "in_progress", "done"];
const taskTypes: TaskType[] = ["general", "coding", "research", "writing"];
const blank: TaskForm = {
  title: "",
  description: "",
  project: "",
  due_date: "",
  status: "backlog",
  dispatch: "draft",
  approval_required: false,
  depends_on: [],
  task_type: "general",
  mcp_connection_id: null,
  agent_preference: "auto",
  model_preference: "auto",
  target_preference: "auto",
};
const movable = (status: Status) => status === "backlog" || status === "todo";
const canMove = (from: Status, to: Status) =>
  (movable(from) && movable(to)) ||
  ((from === "review" || from === "stopped") && (to === "todo" || to === "done"));
const panelStatus = (status: Status): Status =>
  status === "review" || status === "stopped" ? "in_progress" : status;
const attentionRank = (status: Status) => (status === "review" ? 0 : status === "stopped" ? 1 : 2);

function TaskBoard({
  connections,
  assignTask,
  locale,
  services,
  settings,
  tasks,
  visible,
  mobileStatus,
  openTask,
  moveTask,
  reorderTask,
  restoreTask,
  archiveTasks,
  showArchived,
  setShowArchived,
  archivedCount,
  busy,
}: {
  connections: ConnectionState;
  assignTask: (task: Task, id: string) => Promise<void>;
  locale: Locale;
  services: Service[];
  settings: RoutingSettings;
  tasks: Task[];
  visible: Task[];
  mobileStatus: Status;
  openTask: (task: Task) => void;
  moveTask: (task: Task, status: Status) => Promise<void>;
  reorderTask: (task: Task, status: Status, beforeId: string | null) => Promise<void>;
  restoreTask: (task: Task) => Promise<void>;
  archiveTasks: (task?: Task) => Promise<void>;
  showArchived: boolean;
  setShowArchived: (show: boolean) => void;
  archivedCount: number;
  busy: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [activePanel, setActivePanel] = useState(() => columns.indexOf(panelStatus(mobileStatus)));
  useEffect(() => {
    const surface = scroll.current;
    if (!surface) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const panels = surface.querySelectorAll<HTMLElement>(".column");
        if (panels.length < 2) return;
        const step = panels[1].offsetLeft - panels[0].offsetLeft;
        if (step > 0)
          setActivePanel(
            Math.max(0, Math.min(columns.length - 1, Math.round(surface.scrollLeft / step))),
          );
      });
    };
    surface.addEventListener("scroll", sync, { passive: true });
    const resize = new ResizeObserver(sync);
    resize.observe(surface);
    sync();
    return () => {
      surface.removeEventListener("scroll", sync);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  useEffect(() => {
    if (!window.matchMedia("(max-width: 800px)").matches) return;
    const surface = scroll.current;
    const panel = surface?.querySelector<HTMLElement>(
      `[data-drop-status="${panelStatus(mobileStatus)}"]`,
    );
    if (surface && panel)
      surface.scrollTo({
        left:
          surface.scrollLeft +
          panel.getBoundingClientRect().left -
          surface.getBoundingClientRect().left,
      });
  }, [mobileStatus]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const [overCard, setOverCard] = useState<string | null>(null);
  const touchDrag = useRef<{
    task: Task;
    identifier: number;
    startX: number;
    startY: number;
    active: boolean;
    target: { status: Status; beforeId: string | null } | null;
    timer: ReturnType<typeof setTimeout>;
    cleanup: () => void;
  } | null>(null);
  const suppressClick = useRef(false);
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const draggedTask = tasks.find((task) => task.id === dragging);
  const validTarget = (status: Status) =>
    Boolean(
      draggedTask &&
      (panelStatus(draggedTask.status) === status || canMove(draggedTask.status, status)),
    );
  const clearDrag = () => {
    setDragging(null);
    setOver(null);
    setOverCard(null);
  };
  const drop = (status: Status, beforeId: string | null = null) => {
    if (draggedTask && validTarget(status)) {
      if (panelStatus(draggedTask.status) === status)
        void reorderTask(
          draggedTask,
          draggedTask.status,
          tasks.find((task) => task.id === beforeId)?.status === draggedTask.status
            ? beforeId
            : null,
        );
      else void moveTask(draggedTask, status);
    }
    clearDrag();
  };
  const dropProps = (status: Status) => ({
    "data-drop-status": status,
    onDragOver: (e: React.DragEvent) => {
      if (validTarget(status)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(status);
        const id = (e.target as HTMLElement).closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
        setOverCard(id && id !== dragging ? id : null);
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
      drop(status, id && id !== dragging ? id : null);
    },
  });
  useEffect(() => () => touchDrag.current?.cleanup(), []);
  const startTouchDrag = (e: React.TouchEvent<HTMLButtonElement>, task: Task) => {
    if (busy || task.archived_at || e.touches.length !== 1) return;
    touchDrag.current?.cleanup();
    const touch = e.touches[0];
    const current = {
      task,
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      active: false,
      lastPan: 0,
      target: null as { status: Status; beforeId: string | null } | null,
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
      cleanup: () => {},
    };
    const cleanup = () => {
      clearTimeout(current.timer);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", cancel);
      if (touchDrag.current === current) touchDrag.current = null;
    };
    const move = (event: TouchEvent) => {
      const point = Array.from(event.touches).find(
        (item) => item.identifier === current.identifier,
      );
      if (!point) return;
      if (!current.active) {
        if (Math.hypot(point.clientX - current.startX, point.clientY - current.startY) > 8)
          cleanup();
        return;
      }
      event.preventDefault();
      // A held card can still cross panels now that mobile status tabs are gone.
      const surface = scroll.current;
      if (
        surface &&
        window.matchMedia("(max-width: 800px)").matches &&
        Date.now() - current.lastPan > 600
      ) {
        const box = surface.getBoundingClientRect();
        const direction =
          point.clientX < box.left + 24 ? -1 : point.clientX > box.right - 24 ? 1 : 0;
        if (direction) {
          const panels = surface.querySelectorAll<HTMLElement>(".column");
          const step = panels.length > 1 ? panels[1].offsetLeft - panels[0].offsetLeft : box.width;
          surface.scrollBy({ left: direction * step });
          current.lastPan = Date.now();
        }
      }
      const element = document.elementFromPoint(point.clientX, point.clientY);
      const status = element?.closest<HTMLElement>("[data-drop-status]")?.dataset.dropStatus as
        Status | undefined;
      const beforeId = element?.closest<HTMLElement>("[data-task-id]")?.dataset.taskId ?? null;
      const valid =
        status &&
        (panelStatus(task.status) === status || canMove(task.status, status)) &&
        beforeId !== task.id;
      current.target = valid ? { status, beforeId } : null;
      setOver(valid ? status : null);
      setOverCard(valid ? beforeId : null);
    };
    const end = (event: TouchEvent) => {
      if (!Array.from(event.changedTouches).some((item) => item.identifier === current.identifier))
        return;
      const target = current.target;
      const active = current.active;
      if (active) event.preventDefault();
      cleanup();
      if (!active) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 700);
      clearDrag();
      if (target) {
        if (panelStatus(task.status) === target.status)
          void reorderTask(
            task,
            task.status,
            tasks.find((item) => item.id === target.beforeId)?.status === task.status
              ? target.beforeId
              : null,
          );
        else void moveTask(task, target.status);
      }
    };
    const cancel = () => {
      cleanup();
      clearDrag();
    };
    current.cleanup = cleanup;
    current.timer = window.setTimeout(() => {
      current.active = true;
      setDragging(task.id);
    }, 300);
    touchDrag.current = current;
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end, { passive: false });
    window.addEventListener("touchcancel", cancel);
  };

  const count = (status: Status) =>
    tasks.filter((task) => panelStatus(task.status) === status).length;
  return (
    <>
      <div className="mobile-panel-heading">
        <span
          className="mobile-panel-highlight"
          aria-hidden="true"
          style={{ transform: `translateX(${activePanel * 100}%)` }}
        />
        <ol className="mobile-panel-labels">
          {columns.map((status, index) => (
            <li key={status} aria-current={activePanel === index ? "step" : undefined}>
              <button
                type="button"
                aria-label={t(locale, status)}
                aria-pressed={activePanel === index}
                aria-controls={`board-panel-${status}`}
                onClick={() => {
                  const surface = scroll.current;
                  const panel = surface?.querySelector<HTMLElement>(
                    `[data-drop-status="${status}"]`,
                  );
                  if (surface && panel)
                    surface.scrollTo({
                      left:
                        surface.scrollLeft +
                        panel.getBoundingClientRect().left -
                        surface.getBoundingClientRect().left,
                      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                        ? "auto"
                        : "smooth",
                    });
                }}
              >
                <span className="mobile-panel-name">
                  <span className={`status-dot ${status}`} aria-hidden="true" />
                  {t(locale, status)}
                </span>
                <span className="count">{formatNumber(locale, count(status))}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="board-scroll" ref={scroll}>
        <section className="board">
          {columns.map((status) => (
            <div
              key={status}
              id={`board-panel-${status}`}
              {...dropProps(status)}
              className={`column ${over === status ? "drop-over" : ""}`}
            >
              <div className="column-head">
                <div>
                  <span className={`status-dot ${status}`} />
                  <h2>{t(locale, status)}</h2>
                  <span className="count">{formatNumber(locale, count(status))}</span>
                </div>
                {status === "done" && (
                  <OverflowMenu label={t(locale, "completedMenu")}>
                    <button
                      role="menuitem"
                      disabled={
                        busy || !tasks.some((task) => task.status === "done" && !task.archived_at)
                      }
                      onClick={() => void archiveTasks()}
                    >
                      {t(locale, "archiveAll")}
                    </button>
                    <button
                      role="menuitemcheckbox"
                      aria-checked={showArchived}
                      onClick={() => setShowArchived(!showArchived)}
                    >
                      {showArchived ? "✓ " : ""}
                      {t(locale, "showArchived")} ({formatNumber(locale, archivedCount)})
                    </button>
                  </OverflowMenu>
                )}
              </div>
              <div className="cards">
                {visible
                  .filter((task) => panelStatus(task.status) === status)
                  .sort((a, b) => attentionRank(a.status) - attentionRank(b.status))
                  .map((task) => (
                    <div
                      data-task-id={task.id}
                      className={`task-wrap task-state-${task.status} ${dragging === task.id ? "dragging" : ""} ${overCard === task.id ? "drop-before" : ""} ${task.archived_at ? "archived" : ""}`}
                      key={task.id}
                    >
                      <button
                        className="task-card"
                        draggable={!coarsePointer && !busy && !task.archived_at}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", task.id);
                          setDragging(task.id);
                        }}
                        onDragEnd={clearDrag}
                        onTouchStart={(e) => startTouchDrag(e, task)}
                        onClick={(e) => {
                          if (suppressClick.current) {
                            e.preventDefault();
                            suppressClick.current = false;
                            return;
                          }
                          openTask(task);
                        }}
                      >
                        <h3 className="issue-title">
                          <span
                            className="issue-project-icon"
                            title={task.project || t(locale, "projectUnset")}
                            role="img"
                            aria-label={task.project || t(locale, "projectUnset")}
                          >
                            <ServiceIcon
                              name={task.project}
                              icon={
                                services.find((service) => service.name === task.project)?.icon ||
                                "symbol:folder"
                              }
                            />
                          </span>
                          <span>{task.title}</span>
                        </h3>
                        <TaskExecutionBadge
                          task={task}
                          settings={settings}
                          locale={locale}
                          connections={connections}
                        />
                        {(task.status === "review" || task.status === "stopped") && (
                          <span className="card-state-label">{t(locale, task.status)}</span>
                        )}
                        {Boolean(task.approval_required) && (
                          <div className="approval">◇ {t(locale, "approval")}</div>
                        )}
                        {task.archived_at && (
                          <div className="archived-mark">{t(locale, "archived")}</div>
                        )}
                        <time
                          className="card-panel-time"
                          dateTime={task.status_changed_at || task.created_at}
                          title={`${t(locale, "panelMovedAt")}: ${formatDate(locale, task.status_changed_at || task.created_at)}`}
                        >
                          {formatElapsed(locale, task.status_changed_at || task.created_at, now)}
                        </time>
                      </button>
                      {(connections.connections.length > 0 || task.mcp_connection_id) && (
                        <div className="card-agent">
                          <ConnectionPicker
                            iconOnly
                            locale={locale}
                            state={connections}
                            value={task.mcp_connection_id}
                            disabled={
                              busy || task.status === "in_progress" || Boolean(task.archived_at)
                            }
                            onChange={(id) => void assignTask(task, id)}
                          />
                        </div>
                      )}
                      {["done", "review", "stopped"].includes(task.status) && (
                        <OverflowMenu label={`${task.title}: ${t(locale, "taskMenu")}`}>
                          {task.status !== "done" ? (
                            <button
                              role="menuitem"
                              disabled={busy}
                              onClick={() => void moveTask(task, "todo")}
                            >
                              {t(locale, "returnToTodo")}
                            </button>
                          ) : (
                            <button
                              role="menuitem"
                              disabled={busy}
                              onClick={() =>
                                task.archived_at ? void restoreTask(task) : void archiveTasks(task)
                              }
                            >
                              {t(locale, task.archived_at ? "restore" : "archiveMenu")}
                            </button>
                          )}
                        </OverflowMenu>
                      )}
                    </div>
                  ))}
                {!visible.some((task) => panelStatus(task.status) === status) && (
                  <div className="empty">{t(locale, "noTasks")}</div>
                )}
              </div>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
const navigation = [
  {
    view: "board",
    path: "/",
    label: "board",
    icon: "M3 4h18v16H3ZM9 4v16M15 4v16",
  },
  {
    view: "projects",
    path: "/projects",
    label: "services",
    icon: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z",
  },
  {
    view: "connections",
    path: "/connections",
    label: "mcpConnections",
    icon: "M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0ZM12 16v5",
  },
  {
    view: "settings",
    path: "/settings",
    label: "settings",
    icon: "M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4M10 16v4",
  },
] as const;
function NavigationIcon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function MobileNavigation({
  locale,
  view,
  navigate,
}: {
  locale: Locale;
  view: string;
  navigate: (path: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => dialog.current?.close();
  const brand = (
    <>
      <img className="brand-symbol" src="/icon.svg?v=2" alt="" aria-hidden="true" />
      <span>{t(locale, "app")}</span>
    </>
  );
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const media = window.matchMedia("(max-width: 800px)");
    const resized = () => {
      if (!media.matches) close();
    };
    media.addEventListener("change", resized);
    return () => {
      document.body.style.overflow = previous;
      media.removeEventListener("change", resized);
    };
  }, [open]);
  return (
    <>
      <header className="mobile-header">
        {view === "board" ? (
          <div className="brand">{brand}</div>
        ) : (
          <a
            className="brand mobile-home-link"
            href="/"
            aria-label={`${t(locale, "app")}: ${t(locale, "board")}`}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate("/");
            }}
          >
            {brand}
          </a>
        )}
        <button
          ref={trigger}
          type="button"
          className="icon-button mobile-menu-toggle"
          aria-label={t(locale, "openMenu")}
          aria-expanded={open}
          aria-controls="mobile-navigation"
          onClick={() => {
            dialog.current?.showModal();
            setOpen(true);
          }}
        >
          <NavigationIcon path="M4 6h16M4 12h16M4 18h16" />
        </button>
      </header>
      <dialog
        ref={dialog}
        className="mobile-menu"
        aria-label={t(locale, "openMenu")}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const box = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < box.left ||
              event.clientX > box.right ||
              event.clientY < box.top ||
              event.clientY > box.bottom
            )
              close();
          }
        }}
      >
        <div className="mobile-menu-head">
          <div className="brand">
            <img className="brand-symbol" src="/icon.svg?v=2" alt="" aria-hidden="true" />
            <span>{t(locale, "app")}</span>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t(locale, "closeMenu")}
            onClick={close}
          >
            <NavigationIcon path="m6 6 12 12M18 6 6 18" />
          </button>
        </div>
        <nav id="mobile-navigation">
          {navigation.map((item) => (
            <button
              key={item.view}
              type="button"
              aria-current={view === item.view ? "page" : undefined}
              className={view === item.view ? "nav-active" : ""}
              onClick={() => {
                close();
                navigate(item.path);
              }}
            >
              <NavigationIcon path={item.icon} />
              <span>{t(locale, item.label)}</span>
            </button>
          ))}
        </nav>
      </dialog>
    </>
  );
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [locale, setLocale] = useState<Locale>(() =>
    initialLocale(localStorage, navigator.language),
  );
  const [route, setRoute] = useState(() => window.location.pathname);
  const view =
    route === "/settings"
      ? "settings"
      : route === "/projects"
        ? "projects"
        : route === "/connections"
          ? "connections"
          : "board";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [orderVersions, setOrderVersions] = useState<Partial<Record<Status, number>>>({});
  const [connections, setConnections] = useState<ConnectionState>({
    connections: [],
    default_connection_id: null,
    version: 1,
  });
  const [settings, setSettings] = useState<RoutingSettings>({
    services: [],
    targets: [],
    agents: [],
    models: [],
    rules: [],
  });
  const [selected, setSelected] = useState<Task | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [form, setForm] = useState<TaskForm>({ ...blank });
  const [imageUploading, setImageUploading] = useState(false);
  const [formIcon, setFormIcon] = useState("symbol:folder");
  const [projectUploading, setProjectUploading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [mobileStatus, setMobileStatus] = useState<Status>("backlog");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const moving = useRef(false);
  const selectedRef = useRef<Task | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const changeLocale = (value: string) => {
    const next = locales.includes(value as Locale) ? (value as Locale) : detectLocale(value);
    localStorage.setItem("dot-kanban-locale", next);
    setLocale(next);
  };
  function call<T>(path: string, options: RequestInit = {}) {
    return requestJson<T>(path, locale, options);
  }

  const reloadSequence = useRef(0);
  async function reload(
    options: { signal?: AbortSignal; automatic?: boolean } = {},
  ): Promise<boolean> {
    const sequence = ++reloadSequence.current;
    const request = { signal: options.signal };
    try {
      const [board, routing, archive, connections] = await Promise.all([
        call<{
          tasks: Task[];
          archived_count: number;
          order_versions: Record<Status, number>;
        }>("/api/tasks", request),
        call<{ config: RoutingSettings }>("/api/routing", request),
        showArchived
          ? call<{ tasks: Task[] }>("/api/tasks?archived=1", request)
          : Promise.resolve(null),
        call<ConnectionState>("/api/connections", request),
      ]);
      if (options.signal?.aborted || sequence !== reloadSequence.current) return false;
      setTasks([...board.tasks, ...(archive?.tasks ?? [])]);
      setArchivedCount(board.archived_count);
      setOrderVersions(board.order_versions);
      setSettings(routing.config);
      setConnections(connections);
      if (!options.automatic) setError("");
      return true;
    } catch (error) {
      if (!options.automatic && !options.signal?.aborted && sequence === reloadSequence.current)
        setError((error as Error).message);
      return false;
    }
  }
  useEffect(() => {
    if (view === "board") void reload();
  }, [view, showArchived]);
  const pullRefresh = usePullToRefresh(route === "/" && !busy, (signal) => reload({ signal }));
  useLiveRefresh(route === "/" && !busy && !pullRefresh.refreshing, (signal) =>
    reload({ signal, automatic: true }),
  );
  function navigate(path: string, replace = false) {
    if (window.location.pathname !== path)
      window.history[replace ? "replaceState" : "pushState"](null, "", path);
    setRoute(path);
  }
  useEffect(() => {
    const restore = () => setRoute(window.location.pathname);
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    let cancelled = false;
    selectedRef.current = null;
    setSelected(null);
    setEvents([]);
    setFieldError("");
    setError("");
    setShowForm(route === "/tasks/new");
    if (route === "/tasks/new") {
      setForm({
        ...blank,
        mcp_connection_id: connections.default_connection_id,
      });
      setFormIcon("symbol:folder");
      setProjectUploading(false);
    }
    const match = route.match(/^\/tasks\/([0-9a-f-]{36})$/);
    if (match)
      void call<{ task: Task; events: Event[] }>(`/api/tasks/${match[1]}`)
        .then((detail) => {
          if (cancelled) return;
          selectedRef.current = detail.task;
          setSelected(detail.task);
          setEvents(detail.events);
          setMobileStatus(detail.task.status);
        })
        .catch((error) => {
          if (!cancelled) setError((error as Error).message);
        });
    return () => {
      cancelled = true;
    };
  }, [route]);
  useEffect(() => {
    if (route === "/tasks/new")
      setForm((current) =>
        current.mcp_connection_id
          ? current
          : {
              ...current,
              mcp_connection_id: connections.default_connection_id,
            },
      );
  }, [connections.default_connection_id, route]);
  function closeDrawer() {
    navigate("/");
  }
  function openNew() {
    navigate("/tasks/new");
  }
  async function openTask(task: Task, replace = false) {
    navigate(`/tasks/${task.id}`, replace);
  }
  function updateSelected(patch: Partial<Task>, prepare?: () => Promise<Partial<Task>>) {
    const original = selectedRef.current;
    if (!original || original.archived_at)
      return Promise.reject(new Error(t(locale, "server_error")));
    const update = queue.current
      .catch(() => {})
      .then(async () => {
        // Use the latest version after any preceding inline save.
        const task = selectedRef.current?.id === original.id ? selectedRef.current : original;
        const fields = prepare ? await prepare() : patch;
        if (Object.entries(fields).every(([key, value]) => task[key as keyof Task] === value))
          return;
        try {
          const result = await call<{ task: Task }>(`/api/tasks/${task.id}`, {
            method: "PATCH",
            headers: { "if-match": String(task.version) },
            body: JSON.stringify(fields),
          });
          setTasks((current) => current.map((item) => (item.id === task.id ? result.task : item)));
          if (selectedRef.current?.id === task.id) {
            selectedRef.current = result.task;
            setSelected(result.task);
          }
        } catch (error) {
          // Refresh the version after a conflict so retrying does not repeat a stale write.
          try {
            const detail = await call<{ task: Task; events: Event[] }>(`/api/tasks/${task.id}`);
            if (selectedRef.current?.id === task.id) {
              selectedRef.current = detail.task;
              setSelected(detail.task);
              setEvents(detail.events);
            }
          } catch {
            /* preserve the original error */
          }
          throw error;
        }
      });
    queue.current = update;
    return update;
  }
  async function ensureProject(name: string, icon: string) {
    const project = name.trim();
    if (!project) return "";
    const latest = await call<{ config: RoutingSettings }>("/api/routing");
    const existing = latest.config.services.find(
      (service) => service.name.toLowerCase() === project.toLowerCase(),
    );
    if (existing) {
      setSettings(latest.config);
      return existing.name;
    }
    const added = await call<{ service: Service; config: RoutingSettings }>("/api/services", {
      method: "POST",
      body: JSON.stringify({
        id: `s-${crypto.randomUUID()}`,
        name: project,
        repository: "",
        icon,
      }),
    });
    setSettings(added.config);
    return added.service.name;
  }
  async function saveTaskProject(project: string, icon: string) {
    await updateSelected({}, async () => ({
      project: await ensureProject(project, icon),
    }));
  }
  async function saveServiceIcon(service: Service, icon: string) {
    const latest = await call<{ version: number; config: RoutingSettings }>("/api/settings");
    const current = latest.config.services.find((item) => item.id === service.id);
    if (!current || (current.icon !== service.icon && current.icon !== icon)) {
      setSettings(latest.config);
      throw new Error(t(locale, "settings_conflict"));
    }
    if (current.icon === icon) {
      setSettings(latest.config);
      return;
    }
    const result = await call<{ config: RoutingSettings }>("/api/settings", {
      method: "PUT",
      headers: { "if-match": String(latest.version) },
      body: JSON.stringify({
        ...editableSettings(latest.config),
        services: latest.config.services.map((item) =>
          item.id === service.id ? { ...item, icon } : item,
        ),
      }),
    });
    setSettings(result.config);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || projectUploading || imageUploading) return;
    setBusy(true);
    setError("");
    try {
      const project = await ensureProject(form.project, formIcon);
      const { dispatch: _, ...fields } = form;
      const data = await call<{ task: Task }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          ...fields,
          project,
          status: "backlog",
          due_date: null,
        }),
      });
      setShowForm(false);
      await reload();
      setMobileStatus("backlog");
      await openTask(data.task, true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function assignTask(task: Task, id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await call<{ task: Task }>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "if-match": String(task.version) },
        body: JSON.stringify({ mcp_connection_id: id }),
      });
      setTasks((current) => current.map((item) => (item.id === task.id ? result.task : item)));
    } catch (error) {
      await reload();
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function moveTask(task: Task, status: Status) {
    if (moving.current || !canMove(task.status, status) || panelStatus(task.status) === status)
      return;
    moving.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await call<{ task: Task }>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "if-match": String(task.version) },
        body: JSON.stringify({ status }),
      });
      await reload();
      if (selected?.id === task.id) {
        const detail = await call<{ task: Task; events: Event[] }>(`/api/tasks/${task.id}`);
        selectedRef.current = detail.task;
        setSelected(detail.task);
        setEvents(detail.events);
      }
      setMobileStatus(data.task.status);
    } catch (e) {
      await reload();
      setError((e as Error).message);
    } finally {
      moving.current = false;
      setBusy(false);
    }
  }
  async function reorderTask(task: Task, status: Status, beforeId: string | null) {
    const version = orderVersions[status];
    if (moving.current || task.status !== status || !version || beforeId === task.id) return;
    moving.current = true;
    setBusy(true);
    setError("");
    try {
      await call("/api/tasks/reorder", {
        method: "POST",
        headers: { "if-match": String(version) },
        body: JSON.stringify({
          id: task.id,
          status,
          before_id: beforeId,
          task_version: task.version,
        }),
      });
      await reload();
    } catch (e) {
      await reload();
      setError((e as Error).message);
    } finally {
      moving.current = false;
      setBusy(false);
    }
  }

  async function archiveTasks(task?: Task) {
    if (busy || (task && (task.status !== "done" || task.archived_at))) return;
    setBusy(true);
    setError("");
    try {
      await call("/api/tasks/archive", {
        method: "POST",
        body: JSON.stringify(
          task ? { tasks: [{ id: task.id, version: task.version }] } : { all: true },
        ),
      });
      await reload();
    } catch (error) {
      await reload();
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function restoreTask(task: Task) {
    if (busy || !task.archived_at) return;
    setBusy(true);
    setError("");
    try {
      await call("/api/tasks/unarchive", {
        method: "POST",
        body: JSON.stringify({ id: task.id, version: task.version }),
      });
      closeDrawer();
      await reload();
    } catch (e) {
      await reload();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const visible = tasks.filter((task) =>
    `${task.title} ${task.project} ${task.description}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const history = events
    .filter((event) => event.kind !== "routing" && event.kind !== "updated")
    .reverse();

  return (
    <div className={`app view-${view} ${menuOpen ? "menu-open" : "menu-closed"}`} lang={locale}>
      <aside className="rail">
        <div className="brand">
          <img className="brand-symbol" src="/icon.svg?v=2" alt="" aria-hidden="true" />
          <span>{t(locale, "app")}</span>
        </div>
        <nav id="side-navigation">
          {navigation.map((item) => (
            <button
              key={item.view}
              aria-label={t(locale, item.label)}
              title={t(locale, item.label)}
              aria-current={view === item.view ? "page" : undefined}
              className={view === item.view ? "nav-active" : ""}
              onClick={() => navigate(item.path)}
            >
              <NavigationIcon path={item.icon} />
              <span>{t(locale, item.label)}</span>
            </button>
          ))}
        </nav>
        <button
          className="rail-toggle"
          type="button"
          aria-label={t(locale, menuOpen ? "closeMenu" : "openMenu")}
          title={t(locale, menuOpen ? "closeMenu" : "openMenu")}
          aria-expanded={menuOpen}
          aria-controls="side-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {menuOpen ? <path d="m15 6-6 6 6 6" /> : <path d="m9 6 6 6-6 6" />}
          </svg>
        </button>
      </aside>
      <main className="main" ref={pullRefresh.surface}>
        <div
          className={`pull-refresh pull-refresh-${pullRefresh.phase}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {pullRefresh.phase !== "idle" && (
            <>
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {pullRefresh.phase === "done" ? (
                  <path d="m5 12 4 4L19 6" />
                ) : (
                  <path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7" />
                )}
              </svg>
              <span>
                {t(
                  locale,
                  pullRefresh.phase === "refreshing"
                    ? "pullRefreshing"
                    : pullRefresh.phase === "ready"
                      ? "pullRelease"
                      : pullRefresh.phase === "done"
                        ? "pullUpdated"
                        : pullRefresh.phase === "failed"
                          ? "server_error"
                          : "pullToRefresh",
                )}
              </span>
            </>
          )}
        </div>
        <MobileNavigation locale={locale} view={view} navigate={navigate} />
        <PwaStatus locale={locale} />
        {view === "settings" ? (
          <SettingsScreen locale={locale} onLocaleChange={changeLocale} />
        ) : view === "projects" ? (
          <ProjectsScreen locale={locale} call={call} />
        ) : view === "connections" ? (
          <McpConnectionsScreen locale={locale} call={call} />
        ) : (
          <>
            <header className="board-header">
              <div className="toolbar-actions">
                <input
                  aria-label={t(locale, "search")}
                  placeholder={t(locale, "search")}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <button className="primary" onClick={openNew}>
                ＋ {t(locale, "newTask")}
              </button>
            </header>
            {error && (
              <div className="banner-error" role="alert">
                {error}
                <button onClick={() => setError("")}>{t(locale, "close")}</button>
              </div>
            )}
            <TaskBoard
              connections={connections}
              assignTask={assignTask}
              locale={locale}
              services={settings.services}
              settings={settings}
              tasks={tasks}
              visible={visible}
              mobileStatus={mobileStatus}
              openTask={(task) => void openTask(task)}
              moveTask={moveTask}
              reorderTask={reorderTask}
              restoreTask={restoreTask}
              archiveTasks={archiveTasks}
              showArchived={showArchived}
              setShowArchived={setShowArchived}
              archivedCount={archivedCount}
              busy={busy}
            />
          </>
        )}
      </main>
      {(showForm || selected) && view === "board" && (
        <div
          className="overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeDrawer();
          }}
        >
          <div
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t(locale, showForm ? "newTask" : "detail")}
          >
            <div className="drawer-head">
              {showForm ? (
                <span className="eyebrow">{t(locale, "newTask")}</span>
              ) : selected?.status === "backlog" && !selected.archived_at ? (
                <InlineText
                  key={selected.id}
                  locale={locale}
                  value={selected.title}
                  label={t(locale, "title")}
                  onSave={(title) => updateSelected({ title })}
                />
              ) : (
                <h2 className="detail-title">{selected?.title}</h2>
              )}
              <button className="icon-button" aria-label={t(locale, "close")} onClick={closeDrawer}>
                <NavigationIcon path="m6 6 12 12M18 6 6 18" />
              </button>
            </div>
            {showForm ? (
              <form className="task-form" onSubmit={save}>
                <div className="drawer-project-row">
                  <TaskProjectEditor
                    locale={locale}
                    project={form.project}
                    icon={formIcon}
                    onBusyChange={setProjectUploading}
                    onServiceIconSave={saveServiceIcon}
                    services={settings.services}
                    call={call}
                    onDraftChange={(project, icon) => {
                      setForm((current) => ({ ...current, project }));
                      setFormIcon(icon);
                    }}
                    disabled={busy}
                  />
                  <ConnectionPicker
                    iconOnly
                    locale={locale}
                    state={connections}
                    value={form.mcp_connection_id}
                    disabled={busy}
                    onChange={(id) =>
                      setForm((current) => ({
                        ...current,
                        mcp_connection_id: id,
                      }))
                    }
                  />
                </div>
                <label>
                  {t(locale, "title")} *
                  <input
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    maxLength={160}
                    required
                    autoFocus
                  />
                </label>
                <div>
                  <span className="description-label">{t(locale, "description")}</span>
                  <DescriptionEditor
                    locale={locale}
                    value={form.description}
                    call={call}
                    disabled={busy}
                    onBusyChange={setImageUploading}
                    onChange={(description) => setForm((current) => ({ ...current, description }))}
                  />
                </div>
                <details className="task-advanced">
                  <summary>{t(locale, "taskOptions")}</summary>
                  <label>
                    {t(locale, "taskType")}
                    <select
                      value={form.task_type}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          task_type: e.target.value as TaskType,
                        })
                      }
                    >
                      {taskTypes.map((value) => (
                        <option value={value} key={value}>
                          {t(locale, value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset>
                    <legend>{t(locale, "dependencies")}</legend>
                    {tasks.map((task) => (
                      <label className="check" key={task.id}>
                        <input
                          type="checkbox"
                          checked={form.depends_on.includes(task.id)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              depends_on: e.target.checked
                                ? [...form.depends_on, task.id]
                                : form.depends_on.filter((id) => id !== task.id),
                            })
                          }
                        />
                        {task.title}
                      </label>
                    ))}
                  </fieldset>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={form.approval_required}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          approval_required: e.target.checked,
                        })
                      }
                    />
                    {t(locale, "approvalCheck")}
                  </label>
                </details>
                {error && (
                  <p className="project-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="form-actions">
                  <button type="button" onClick={closeDrawer}>
                    {t(locale, "cancel")}
                  </button>
                  <button className="primary" disabled={busy || projectUploading || imageUploading}>
                    {t(locale, busy ? "saving" : "create")}
                  </button>
                </div>
              </form>
            ) : (
              selected && (
                <div className="detail" key={selected.id}>
                  <div className="drawer-project-row">
                    <TaskProjectEditor
                      locale={locale}
                      project={selected.project}
                      services={settings.services}
                      call={call}
                      onSave={saveTaskProject}
                      onServiceIconSave={saveServiceIcon}
                      disabled={Boolean(selected.archived_at)}
                    />
                    <ConnectionPicker
                      iconOnly
                      locale={locale}
                      state={connections}
                      value={selected.mcp_connection_id}
                      disabled={selected.status === "in_progress" || Boolean(selected.archived_at)}
                      onChange={(id) => {
                        setFieldError("");
                        void updateSelected({ mcp_connection_id: id }).catch((error) =>
                          setFieldError(error.message),
                        );
                      }}
                    />
                  </div>
                  <TaskStatusEditor
                    key={selected.id}
                    locale={locale}
                    value={selected.status}
                    options={(
                      ["backlog", "todo", "in_progress", "review", "done", "stopped"] as Status[]
                    ).filter(
                      (status) =>
                        status === selected.status ||
                        (!selected.archived_at &&
                          movable(selected.status) &&
                          canMove(selected.status, status)),
                    )}
                    disabled={busy || Boolean(selected.archived_at)}
                    onSave={async (status) => {
                      await updateSelected({ status: status as Status });
                      if (selectedRef.current) setMobileStatus(selectedRef.current.status);
                    }}
                  />
                  {selected.status === "backlog" && !selected.archived_at ? (
                    <DescriptionEditor
                      locale={locale}
                      value={selected.description}
                      call={call}
                      onCommit={(description) => updateSelected({ description })}
                    />
                  ) : (
                    <DescriptionContent value={selected.description} locale={locale} />
                  )}
                  {fieldError && (
                    <p className="project-error" role="alert">
                      {fieldError}
                    </p>
                  )}
                  {selected.depends_on?.length > 0 && (
                    <p className="detail-dependencies">
                      {t(locale, "dependencies")}:{" "}
                      {selected.depends_on
                        .map((id) => tasks.find((task) => task.id === id)?.title || id)
                        .join(", ")}
                    </p>
                  )}
                  {Boolean(selected.approval_required) && (
                    <p className="approval-detail">◇ {t(locale, "approval")}</p>
                  )}
                  {!selected.archived_at && ["review", "stopped"].includes(selected.status) && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void moveTask(selected, "todo")}
                    >
                      {t(locale, "returnToTodo")}
                    </button>
                  )}
                  {selected.archived_at && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void restoreTask(selected)}
                    >
                      {t(locale, "restore")}
                    </button>
                  )}
                  <h3 className="section-title">
                    {t(locale, "history")} <span>{formatNumber(locale, history.length)}</span>
                  </h3>
                  <div className="timeline">
                    {history.map((event) => (
                      <div className="timeline-item" key={event.id}>
                        <time>{formatDate(locale, event.created_at)}</time>
                        <p>{event.body}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
