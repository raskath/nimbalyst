/**
 * Open Projects state
 *
 * Tracks the list of workspace projects warm in the multi-project rail and
 * which one is currently visible. The rail is opt-in: when
 * `multiProjectModeAtom` is `false`, the rail stays hidden and the host
 * window keeps the legacy "one project per window" behavior.
 *
 * `activeWorkspacePathAtom` is the single source of truth for the path
 * read by per-workspace atom families (agent layout, navigation history,
 * sidebar widths, etc.). It replaces the module-level `currentWorkspacePath`
 * variables that previously lived in `agentMode.ts` and
 * `navigationHistory.ts`.
 */

import { atom, type createStore, type Getter, type Setter } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { clearWorkspaceActivityAtom } from './sessionActivity';
import { activeSessionIdAtom, selectedWorkstreamAtom } from './sessions';
import { workstreamActiveChildAtom } from './workstreamState';
import { settingAtom } from './settingAtomFamily';
import {
  buildRailEntries,
  createRailGroup,
  DEFAULT_PROJECT_RAIL_GROUP_NAME,
  dissolveRailGroup,
  flattenRailEntries,
  moveGroupInRail,
  moveProjectInRail,
  nextRailGroupColor,
  projectRailGroupsAtom,
  railStepTarget,
  removeProjectFromRailGroup,
  sortRail,
  updateRailGroup,
  type NewRailGroup,
  type RailDragItem,
  type RailDropTarget,
  type RailGroupPatch,
  type RailLayout,
} from './projectRailGroups';

type JotaiStore = ReturnType<typeof createStore>;

export interface OpenProject {
  /** Canonical absolute path; same key used by per-workspace atom families. */
  path: string;
  /** Display name. Derived from `path.basename(path)` on the renderer. */
  name: string;
  /** ms epoch when the project was added to the rail. */
  openedAt: number;
}

interface InitialWorkspaceWindowState {
  mode: 'workspace';
  workspacePath?: string;
  activeWorkspacePath?: string | null;
  openProjectPaths?: string[];
}

interface ResolveInitialOpenProjectsInput {
  persistedPaths: string[];
  persistedActivePath: string | null;
  restorePreviousProjects: boolean;
  windowState: InitialWorkspaceWindowState | null;
}

export const allowUnlimitedProjectsAtom = settingAtom('projects.allowUnlimited');

/**
 * Path of the workspace currently visible in this window.
 *
 * Read by per-workspace atom families to resolve which workspace's state
 * to expose. Written when a workspace becomes the focused project — by
 * `initAgentModeLayout` / `initNavigationHistory` for single-project flow,
 * by the project rail click handler in multi-project mode.
 */
export const activeWorkspacePathAtom = atom<string | null>(null);

/**
 * Whether multi-project mode is enabled. When false, rail UI is hidden and
 * opening a new project spawns a fresh window (legacy behavior). When true,
 * opening a project adds it to the rail in the current window.
 *
 * Persisted via `app:set-multi-project-mode` IPC; seeded from store on
 * launch by an effect that reads `app:get-multi-project-mode`.
 */
export const multiProjectModeAtom = atom<boolean>(false);

/**
 * When true, the rail rehydrates with the projects that were open at last
 * app close. When false (default), the rail starts with only the project
 * the user picked from the launch screen; additional projects are added
 * explicitly via the `+` button.
 */
export const restorePreviousProjectsAtom = atom<boolean>(false);

/**
 * Ordered list of open projects in the rail, from top to bottom.
 *
 * New additions respect the configured limit. Restored projects are preserved.
 */
export const openProjectsAtom = atom<OpenProject[]>([]);

/**
 * Convenience: the OpenProject record for the active workspace, if any.
 */
export const activeOpenProjectAtom = atom((get) => {
  const path = get(activeWorkspacePathAtom);
  if (!path) return null;
  return get(openProjectsAtom).find((p) => p.path === path) ?? null;
});

/**
 * Whether the rail is at the open-project cap. UI uses this to disable
 * the "+" button and show a hint to close a project first.
 */
export const isOpenProjectsAtCapAtom = atom((get) => {
  return !get(allowUnlimitedProjectsAtom) && get(openProjectsAtom).length >= 8;
});

/**
 * Add a project to the rail. No-op if it already exists. When the rail
 * has reached the cap, returns without adding (caller should show a UI
 * hint via `isOpenProjectsAtCapAtom`).
 *
 * Activates the added project so the renderer immediately switches to it,
 * unless `activate` is false (opening a group activates once, at the end).
 */
export const addOpenProjectAtom = atom(
  null,
  (get, set, project: OpenProject, { activate = true }: { activate?: boolean } = {}) => {
    const current = get(openProjectsAtom);

    const existing = current.find((p) => p.path === project.path);
    if (existing) {
      if (activate) set(activeWorkspacePathAtom, existing.path);
      return true;
    }

    if (get(isOpenProjectsAtCapAtom)) {
      return false;
    }

    set(openProjectsAtom, [...current, project]);
    if (activate) set(activeWorkspacePathAtom, project.path);
    return true;
  }
);

/**
 * Top-level rail entries: ungrouped projects, and groups with their open
 * members. See `projectRailGroups.ts` for where a group takes its place.
 */
export const projectRailEntriesAtom = atom((get) =>
  buildRailEntries(get(openProjectsAtom), get(projectRailGroupsAtom)));

/** Open projects in the order the rail shows them, collapsed groups included. */
export const railOrderedProjectsAtom = atom((get) => flattenRailEntries(get(projectRailEntriesAtom)));

function railLayout(get: Getter): RailLayout<OpenProject> {
  return { projects: get(openProjectsAtom), groups: get(projectRailGroupsAtom) };
}

/** Write both halves of a rail edit together; an unchanged half is not rewritten. */
function commitRailLayout(get: Getter, set: Setter, next: RailLayout<OpenProject> | null): boolean {
  if (!next) return false;
  if (next.projects !== get(openProjectsAtom)) set(openProjectsAtom, next.projects);
  if (next.groups !== get(projectRailGroupsAtom)) set(projectRailGroupsAtom, next.groups);
  return true;
}

function newRailGroup(get: Getter, options: { name?: string; color?: string | null } = {}): NewRailGroup {
  const color = options.color === undefined ? nextRailGroupColor(get(projectRailGroupsAtom)) : options.color;
  return {
    id: crypto.randomUUID(),
    name: options.name?.trim() || DEFAULT_PROJECT_RAIL_GROUP_NAME,
    ...(color ? { color } : {}),
    collapsed: false,
  };
}

/**
 * Move by identity so a project closed during a drag cannot move another one.
 * With `groupId` the project lands inside that group, otherwise at the top
 * level.
 */
export const moveOpenProjectAtom = atom(
  null,
  (get, set, { path, beforePath, groupId = null }: { path: string; beforePath: string | null; groupId?: string | null }) => {
    commitRailLayout(get, set, moveProjectInRail(railLayout(get), path, { type: 'insert', beforePath, groupId }));
  },
);

/**
 * Apply a rail drop. Returns the id of the group a merge created so the rail
 * can offer to name it, otherwise null.
 */
export const dropOnRailAtom = atom(
  null,
  (get, set, { item, target }: { item: RailDragItem; target: RailDropTarget }): string | null => {
    if (item.kind === 'group') {
      if (target.type === 'insert') commitRailLayout(get, set, moveGroupInRail(railLayout(get), item.groupId, target.beforePath));
      return null;
    }
    const group = target.type === 'merge' ? newRailGroup(get) : undefined;
    const next = moveProjectInRail(railLayout(get), item.path, target, group);
    commitRailLayout(get, set, next);
    return group && next?.groups.some((candidate) => candidate.id === group.id) ? group.id : null;
  },
);

/** "Move up" / "Move down": within a group for grouped projects, past whole groups otherwise. */
export const stepRailItemAtom = atom(
  null,
  (get, set, { item, direction }: { item: RailDragItem; direction: -1 | 1 }) => {
    const target = railStepTarget(get(projectRailEntriesAtom), item, direction);
    if (target) set(dropOnRailAtom, { item, target });
  },
);

/** Arrange once; subsequent additions and manual moves retain their own order. */
export const sortOpenProjectsAtom = atom(null, (get, set) => {
  commitRailLayout(get, set, sortRail(railLayout(get)));
});

/** Group open projects. Returns the new group's id, or null when none of the paths is open. */
export const createRailGroupAtom = atom(
  null,
  (get, set, { paths, name, color }: { paths: string[]; name?: string; color?: string | null }): string | null => {
    const group = newRailGroup(get, { name, color });
    return commitRailLayout(get, set, createRailGroup(railLayout(get), paths, group)) ? group.id : null;
  },
);

/** Move an open project to the end of a group, or out of its group with `groupId: null`. */
export const setOpenProjectGroupAtom = atom(
  null,
  (get, set, { path, groupId }: { path: string; groupId: string | null }) => {
    commitRailLayout(get, set, groupId === null
      ? removeProjectFromRailGroup(railLayout(get), path)
      : moveProjectInRail(railLayout(get), path, { type: 'join', groupId }));
  },
);

/** Rename, recolor, collapse or expand a group in every window. */
export const updateRailGroupAtom = atom(
  null,
  (get, set, { groupId, patch }: { groupId: string; patch: RailGroupPatch }) => {
    const next = updateRailGroup(get(projectRailGroupsAtom), groupId, patch);
    if (next) set(projectRailGroupsAtom, next);
  },
);

/** Remove a group; its open projects stay where they are, at the top level. */
export const dissolveRailGroupAtom = atom(null, (get, set, groupId: string) => {
  commitRailLayout(get, set, dissolveRailGroup(railLayout(get), groupId));
});

/**
 * Remove projects from the rail. If the active project is among them, the
 * nearest remaining project in rail order (after them, then before them)
 * becomes active. Group membership is kept, so a reopened project rejoins
 * its group.
 *
 * Callers are responsible for any pre-close confirmation (e.g. when a
 * project has streaming sessions).
 */
export const closeOpenProjectsAtom = atom(
  null,
  (get, set, pathsToClose: string[]) => {
    const current = get(openProjectsAtom);
    const closed = current.filter((p) => pathsToClose.includes(p.path));
    if (closed.length === 0) return;

    const ordered = get(railOrderedProjectsAtom);
    set(openProjectsAtom, current.filter((p) => !closed.includes(p)));

    const activePath = get(activeWorkspacePathAtom);
    if (activePath && pathsToClose.includes(activePath)) {
      const index = ordered.findIndex((p) => p.path === activePath);
      const remains = (p: OpenProject) => !closed.includes(p);
      const replacement = ordered.slice(index + 1).find(remains)
        ?? ordered.slice(0, Math.max(index, 0)).reverse().find(remains)
        ?? null;
      set(activeWorkspacePathAtom, replacement?.path ?? null);
    }

    // Drop the workspace's slot in the activity tracker. Other per-workspace
    // atom families (tabs slot, sidebar width, etc.) are pruned by the
    // `workspaceStatePruner` subscriber that watches `openProjectsAtom` —
    // keeping that logic outside this module avoids a cycle with the atom
    // files that already import `activeWorkspacePathAtom`.
    for (const project of closed) set(clearWorkspaceActivityAtom, project.path);
  }
);

export const closeOpenProjectAtom = atom(null, (_get, set, pathToClose: string) => {
  set(closeOpenProjectsAtom, [pathToClose]);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function basenameFromPath(p: string): string {
  // Match Node's path.basename behavior for both posix and win32 separators.
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function normalizeProjectPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}

function getWindowBootstrapState(initialState: unknown): InitialWorkspaceWindowState | null {
  if (!initialState || typeof initialState !== 'object') return null;
  const candidate = initialState as InitialWorkspaceWindowState;
  if (candidate.mode !== 'workspace') return null;
  return candidate;
}

/**
 * NIM-757: which restored rail projects must be registered with the main
 * process via `workspace:register-additional`. The window's primary workspace
 * is already registered at bootstrap, so only the non-primary restored paths
 * need it (deduped). A missing primary path means single-project mode -- in
 * which case there is nothing extra to register beyond the primary itself.
 */
export function selectProjectsToRegister(
  initialPaths: string[],
  primaryPath: string | undefined,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of initialPaths) {
    if (path === primaryPath || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function resolveInitialOpenProjectsState({
  persistedPaths,
  persistedActivePath,
  restorePreviousProjects,
  windowState,
}: ResolveInitialOpenProjectsInput): { paths: string[]; activePath: string | null } {
  const normalizedPersistedPaths = normalizeProjectPaths(persistedPaths);
  const normalizedWindowPaths = normalizeProjectPaths(windowState?.openProjectPaths ?? []);
  const normalizedWindowActivePath =
    windowState?.activeWorkspacePath && normalizedWindowPaths.includes(windowState.activeWorkspacePath)
      ? windowState.activeWorkspacePath
      : normalizedWindowPaths[0] ?? null;
  const windowHasLiveRailState =
    normalizedWindowPaths.length > 1 ||
    (windowState?.workspacePath != null &&
      normalizedWindowActivePath != null &&
      normalizedWindowActivePath !== windowState.workspacePath);

  if (windowHasLiveRailState) {
    return {
      paths: normalizedWindowPaths,
      activePath: normalizedWindowActivePath,
    };
  }

  if (restorePreviousProjects && normalizedPersistedPaths.length > 0) {
    return {
      paths: normalizedPersistedPaths,
      activePath:
        persistedActivePath && normalizedPersistedPaths.includes(persistedActivePath)
          ? persistedActivePath
          : normalizedPersistedPaths[0] ?? null,
    };
  }

  return {
    paths: normalizedWindowPaths,
    activePath: normalizedWindowActivePath,
  };
}

let initialized = false;
let unsubscribers: Array<() => void> = [];

/**
 * Load multi-project settings from disk and start persistence subscribers.
 *
 * Idempotent: subsequent calls are no-ops. Call once at renderer startup,
 * before the rail is rendered, so the first paint already has the correct
 * `multiProjectModeAtom` value.
 *
 * Returns once the initial state has been loaded.
 */
export async function initOpenProjects(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!window.electronAPI?.invoke) return;

  try {
    const [mode, restorePrev, paths, activePath, initialState] = await Promise.all([
      window.electronAPI.invoke('app:get-multi-project-mode') as Promise<boolean>,
      window.electronAPI.invoke('app:get-restore-previous-projects') as Promise<boolean>,
      window.electronAPI.invoke('app:get-open-projects') as Promise<string[]>,
      window.electronAPI.invoke('app:get-active-project-path') as Promise<string | null>,
      window.electronAPI.getInitialState?.() ?? Promise.resolve(null),
    ]);

    store.set(multiProjectModeAtom, !!mode);
    store.set(restorePreviousProjectsAtom, !!restorePrev);

    const windowState = getWindowBootstrapState(initialState);
    const { paths: initialPaths, activePath: initialActivePath } = resolveInitialOpenProjectsState({
      persistedPaths: paths,
      persistedActivePath: activePath,
      restorePreviousProjects: !!restorePrev,
      windowState,
    });

    if (initialPaths.length > 0) {
      const projects: OpenProject[] = initialPaths.map((path) => ({
        path,
        name: basenameFromPath(path),
        openedAt: Date.now(),
      }));
      store.set(openProjectsAtom, projects);

      // NIM-757 (#548 / reopen #441): register restored non-primary projects
      // with the main process BEFORE flipping the active path. The "+"-add flow
      // calls workspace:register-additional, but restored rail projects never
      // did -- so the main process knew only the startup primary,
      // workspace:set-active later rejected the unregistered path, and the
      // path-less tracker-items-list IPC stayed pinned to the startup project's
      // document service. Registering here seeds additionalWorkspacePaths and
      // the per-path document service so a later rail click rescopes correctly.
      const toRegister = selectProjectsToRegister(initialPaths, windowState?.workspacePath);
      if (toRegister.length > 0) {
        await Promise.all(
          toRegister.map((workspacePath) =>
            window.electronAPI!
              .invoke('workspace:register-additional', { workspacePath })
              .catch((err: unknown) => {
                console.error('[openProjects] register-additional failed for', workspacePath, err);
              }),
          ),
        );
      }

      // Keep the restored display order in this window's reload snapshot too.
      await window.electronAPI.invoke('app:set-open-projects', initialPaths);

      if (initialActivePath && initialPaths.includes(initialActivePath)) {
        store.set(activeWorkspacePathAtom, initialActivePath);
      } else if (projects.length > 0) {
        store.set(activeWorkspacePathAtom, projects[0].path);
      }
    }
  } catch (err) {
    console.error('[openProjects] Failed to load multi-project state:', err);
  }

  // List edits commit only on drop or a menu action, so persist immediately.
  unsubscribers.push(
    store.sub(multiProjectModeAtom, () => {
      const mode = store.get(multiProjectModeAtom);
      window.electronAPI?.invoke?.('app:set-multi-project-mode', mode).catch((err: unknown) => {
        console.error('[openProjects] Failed to persist multiProjectMode:', err);
      });
    }),
    store.sub(restorePreviousProjectsAtom, () => {
      const value = store.get(restorePreviousProjectsAtom);
      window.electronAPI?.invoke?.('app:set-restore-previous-projects', value).catch((err: unknown) => {
        console.error('[openProjects] Failed to persist restorePreviousProjects:', err);
      });
    }),
    store.sub(openProjectsAtom, () => persistOpenProjects()),
    store.sub(activeWorkspacePathAtom, () => {
      schedulePersistActivePath();
      notifyMainSetActive();
    }),
    attachWorkspaceSwitchCleanup(store),
  );

  // Initial hydration happens before the subscriptions above. Bring the main
  // process onto the restored project too, even if the user never clicks it.
  if (store.get(multiProjectModeAtom)) notifyMainSetActive();
}

/**
 * Attach a subscriber that keeps cross-workspace globals coherent when
 * `activeWorkspacePathAtom` flips. Synchronously rewrites
 * `activeSessionIdAtom` to the new workspace's selection — leaking the
 * previous workspace's session id is avoided AND the brief null window
 * between the subscriber firing and AgentMode's mount effect is closed.
 *
 * Resolution order matches AgentMode's own derivation
 * (`AgentMode.tsx:151-158`): activeChildId of the selected workstream
 * if any, otherwise the selection's own id, otherwise null. AgentMode
 * still re-asserts the same value on mount; the writes converge.
 *
 * Exported as a stand-alone unit so jotai-only tests can attach it to a
 * `createStore()` instance and assert the behavior without needing the
 * full `initOpenProjects` IPC bootstrap.
 */
export function attachWorkspaceSwitchCleanup(jotaiStore: JotaiStore): () => void {
  return jotaiStore.sub(activeWorkspacePathAtom, () => {
    const newPath = jotaiStore.get(activeWorkspacePathAtom);
    if (!newPath) {
      jotaiStore.set(activeSessionIdAtom, null);
      return;
    }
    const selection = jotaiStore.get(selectedWorkstreamAtom(newPath));
    const activeChildId = selection
      ? jotaiStore.get(workstreamActiveChildAtom(selection.id))
      : null;
    jotaiStore.set(activeSessionIdAtom, activeChildId || selection?.id || null);
  });
}

/**
 * Notify the main process about the new active workspace path so the
 * single-active-per-window resources (file watcher, runtime-global
 * FileSystemService) transition atomically. Centralized here so every
 * mutation of `activeWorkspacePathAtom` (rail click, replacement after
 * close, restore-on-launch, keyboard shortcut) goes through one path —
 * direct callers of `electronAPI.invoke('workspace:set-active', ...)`
 * are not necessary.
 */
function notifyMainSetActive(): void {
  const path = store.get(activeWorkspacePathAtom);
  if (!path) return;
  window.electronAPI?.invoke?.('workspace:set-active', { workspacePath: path }).catch((err: unknown) => {
    console.error('[openProjects] workspace:set-active failed:', err);
  });
}

function persistOpenProjects(): void {
  const paths = store.get(openProjectsAtom).map(project => project.path);
  window.electronAPI?.invoke?.('app:set-open-projects', paths).catch((err: unknown) => {
    console.error('[openProjects] Failed to persist openProjects:', err);
  });
}

function schedulePersistActivePath(): void {
  const path = store.get(activeWorkspacePathAtom);
  // No debounce needed — switches are user-driven and infrequent.
  window.electronAPI?.invoke?.('app:set-active-project-path', path).catch((err: unknown) => {
    console.error('[openProjects] Failed to persist activeProjectPath:', err);
  });
}

/**
 * Tear down persistence subscribers (e.g. for tests). Resets `initialized`
 * so the next `initOpenProjects` call re-loads from disk.
 */
export function teardownOpenProjects(): void {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
  initialized = false;
}
