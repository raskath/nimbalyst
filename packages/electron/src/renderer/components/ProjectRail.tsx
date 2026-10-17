/**
 * ProjectRail
 *
 * Discord-style vertical rail of warm projects. Click an icon to switch
 * the visible project; the inactive projects' state is kept warm via
 * per-workspace atom families and main-process service refcounting.
 * Projects can be gathered into named, collapsible groups (see
 * `projectRailGroups.ts`).
 *
 * Hidden when multi-project mode is off (the legacy single-window flow
 * stays as a fallback).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { getShowInFileBrowserLabel } from '@nimbalyst/runtime';
import {
  useFloating,
  autoUpdate,
  FloatingPortal,
  FloatingFocusManager,
  useDismiss,
  useHover,
  useInteractions,
  useRole,
  offset,
  flip,
  shift,
  size,
  type VirtualElement,
} from '@floating-ui/react';
import { clearWindowControls, getWindowControlsZones, windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { OrgSwitcher } from './OrgSwitcher';
import {
  multiProjectModeAtom,
  openProjectsAtom,
  activeWorkspacePathAtom,
  isOpenProjectsAtCapAtom,
  addOpenProjectAtom,
  closeOpenProjectAtom,
  closeOpenProjectsAtom,
  createRailGroupAtom,
  dissolveRailGroupAtom,
  dropOnRailAtom,
  projectRailEntriesAtom,
  setOpenProjectGroupAtom,
  sortOpenProjectsAtom,
  stepRailItemAtom,
  updateRailGroupAtom,
  type OpenProject,
} from '../store/atoms/openProjects';
import {
  nextRailGroupColor,
  projectRailGroupsAtom,
  railGroupForPath,
  railStepTarget,
  type ProjectRailGroup as RailGroup,
  type RailDragItem,
  type RailDropTarget,
  type RailEntry,
} from '../store/atoms/projectRailGroups';
import {
  globalSessionActivityAtom,
  projectActivitySummaryAtom,
} from '../store/atoms/sessionActivity';
import { generateWorkspaceAccentColor, projectIconForeground } from '../../shared/projectAppearance';
import { projectAppearanceAtom } from '../store/atoms/projectAppearance';
import { openSettingsCommandAtom } from '../store/atoms/settingsNavigation';
import { ProjectIcon } from './ProjectIcon';
import { ProjectRailGroup } from './ProjectRailGroup';
import { ProjectRailGroupEditor, railGroupEditorValue } from './ProjectRailGroupEditor';
import { requestConfirmation } from '../dialogs/requestConfirmation';
import { errorNotificationService } from '../services/ErrorNotificationService';
import { useProjectRailDrag } from './hooks/useProjectRailDrag';
import './ProjectRail.css';

const REVEAL_LABEL = getShowInFileBrowserLabel();

function nameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function findGroupEntry(entries: readonly RailEntry<OpenProject>[], groupId: string) {
  return entries.find((entry): entry is Extract<RailEntry<OpenProject>, { kind: 'group' }> =>
    entry.kind === 'group' && entry.group.id === groupId);
}

type DropPosition = 'before' | 'after' | 'merge' | 'join';

/** Which rail element shows the marker for a pending drop, keyed `project:<path>` or `group:<id>`. */
function dropMarker(
  entries: readonly RailEntry<OpenProject>[],
  target: RailDropTarget | undefined,
): { key: string; position: DropPosition } | null {
  if (!target) return null;
  if (target.type === 'merge') return { key: `project:${target.targetPath}`, position: 'merge' };
  if (target.type === 'join') return { key: `group:${target.groupId}`, position: 'join' };
  const keyOf = (entry: RailEntry<OpenProject>) =>
    (entry.kind === 'project' ? `project:${entry.project.path}` : `group:${entry.group.id}`);
  if (target.groupId !== null) {
    const entry = entries.find((candidate) => candidate.kind === 'group' && candidate.group.id === target.groupId);
    if (entry?.kind !== 'group') return null;
    if (entry.group.collapsed) return { key: keyOf(entry), position: 'join' };
    if (entry.projects.some((project) => project.path === target.beforePath)) {
      return { key: `project:${target.beforePath}`, position: 'before' };
    }
    return { key: `project:${entry.projects.at(-1)!.path}`, position: 'after' };
  }
  if (target.beforePath === null) {
    const last = entries.at(-1);
    return last ? { key: keyOf(last), position: 'after' } : null;
  }
  const entry = entries.find((candidate) => (candidate.kind === 'project'
    ? candidate.project.path === target.beforePath
    : candidate.projects.some((project) => project.path === target.beforePath)));
  return entry ? { key: keyOf(entry), position: 'before' } : null;
}

interface ProjectRailIconProps {
  project: OpenProject;
  isActive: boolean;
  processingCount: number;
  unreadCount: number;
  onActivate: (path: string) => void;
  onClose: (project: OpenProject) => void;
  onContextMenu: (project: OpenProject, x: number, y: number) => void;
  isDragging: boolean;
  menuOpen: boolean;
  /** `merge` marks the project a drop would group with the dragged one. */
  dropPosition?: 'before' | 'after' | 'merge';
  onDragStart: (event: React.DragEvent, path: string) => void;
  onDragEnd: () => void;
}

function ProjectRailIcon({
  project,
  isActive,
  processingCount,
  unreadCount,
  onActivate,
  onClose,
  onContextMenu,
  isDragging,
  menuOpen,
  dropPosition,
  onDragStart,
  onDragEnd,
}: ProjectRailIconProps) {
  // Hover tooltip via floating-ui. Renders through FloatingPortal so the
  // tooltip escapes the rail container's `overflow: hidden` clip — the
  // earlier CSS-only `:hover > .project-rail-tooltip` approach was clipped
  // and never visible. Matches CLAUDE.md's floating-ui rule.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const { refs: tooltipRefs, floatingStyles: tooltipFloatingStyles, context: tooltipContext } = useFloating({
    open: tooltipOpen,
    onOpenChange: setTooltipOpen,
    placement: 'right',
    middleware: [offset(12), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const tooltipHover = useHover(tooltipContext, { enabled: !menuOpen && !isDragging, delay: { open: 200, close: 0 }, move: false });
  React.useEffect(() => { if (menuOpen) setTooltipOpen(false); }, [menuOpen]);
  const { getReferenceProps: getTooltipRefProps, getFloatingProps: getTooltipFloatingProps } =
    useInteractions([tooltipHover]);

  const handleClick = useCallback(() => {
    onActivate(project.path);
  }, [onActivate, project.path]);

  const handleClose = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onClose(project);
    },
    [onClose, project]
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.querySelector<HTMLButtonElement>('.project-rail-item-main')?.focus();
      onContextMenu(project, event.clientX, event.clientY);
    },
    [onContextMenu, project]
  );

  const appearance = useAtomValue(projectAppearanceAtom(project.path)).snapshot?.appearance ?? {};
  const className = `project-rail-item${isActive ? ' is-active' : ''}${isDragging ? ' is-dragging' : ''}`;

  // Per-project accent color, derived deterministically from the workspace
  // path so the rail icon matches the colored bar shown in the workspace
  // summary header (and in SessionHistory entries) for the same project.
  const accentColor = appearance.color || generateWorkspaceAccentColor(project.path);

  // Inactive projects show a badge when something needs attention. Active
  // projects already have the user's eyes on them so we suppress the
  // badge to keep the rail quiet.
  const showBadge = !isActive && (processingCount > 0 || unreadCount > 0);
  const badgeLabel = processingCount > 0 ? `${processingCount}` : unreadCount > 0 ? `${unreadCount}` : '';

  // Wrapper is a non-interactive container so the activate button and the
  // close button can sit as siblings. Nesting a button inside a button is
  // invalid HTML and confuses screen readers / keyboard navigation.
  return (
    <div
      ref={tooltipRefs.setReference}
      className={className}
      onContextMenu={handleContextMenu}
      data-testid="project-rail-item"
      data-project-path={project.path}
      data-drop-position={dropPosition === 'merge' ? undefined : dropPosition}
      data-drop-target={dropPosition === 'merge' ? 'merge' : undefined}
      style={{ '--rail-item-accent': accentColor, '--rail-item-foreground': projectIconForeground(appearance.color) } as React.CSSProperties}
      {...getTooltipRefProps()}
    >
      <button
        type="button"
        className="project-rail-item-main"
        onClick={handleClick}
        draggable
        onDragStart={event => { setTooltipOpen(false); onDragStart(event, project.path); }}
        onDragEnd={onDragEnd}
        onKeyDown={event => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onContextMenu(project, rect.right, rect.top);
        }}
        aria-haspopup="menu"
        aria-label={`Switch to project ${project.name}`}
        aria-current={isActive ? 'true' : undefined}
      >
        <ProjectIcon name={project.name} appearance={appearance} />
        {showBadge && (
          <span
            className="project-rail-item-badge"
            aria-label={processingCount > 0 ? `${processingCount} streaming session(s)` : `${unreadCount} unread`}
          >
            {badgeLabel}
          </span>
        )}
      </button>
      <button
        type="button"
        className="project-rail-item-close"
        onClick={handleClose}
        aria-label={`Close ${project.name}`}
      >
        ×
      </button>
      {tooltipOpen && !isDragging && !menuOpen && (
        <FloatingPortal>
          <div
            ref={tooltipRefs.setFloating}
            className="project-rail-tooltip"
            style={tooltipFloatingStyles}
            {...getTooltipFloatingProps()}
          >
            <span className="project-rail-tooltip-name">{project.name}</span>
            <span className="project-rail-tooltip-path">{project.path}</span>
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}

export function ProjectRail() {
  const openSettings = useSetAtom(openSettingsCommandAtom);
  const store = useStore();
  const isMultiProjectMode = useAtomValue(multiProjectModeAtom);
  const openProjects = useAtomValue(openProjectsAtom);
  const [activePath, setActivePath] = useAtom(activeWorkspacePathAtom);
  const atCap = useAtomValue(isOpenProjectsAtCapAtom);
  const addProject = useSetAtom(addOpenProjectAtom);
  const closeProject = useSetAtom(closeOpenProjectAtom);
  const closeProjects = useSetAtom(closeOpenProjectsAtom);
  const sortProjects = useSetAtom(sortOpenProjectsAtom);
  const dropOnRail = useSetAtom(dropOnRailAtom);
  const stepRailItem = useSetAtom(stepRailItemAtom);
  const createGroup = useSetAtom(createRailGroupAtom);
  const setProjectGroup = useSetAtom(setOpenProjectGroupAtom);
  const updateGroup = useSetAtom(updateRailGroupAtom);
  const dissolveGroup = useSetAtom(dissolveRailGroupAtom);
  const entries = useAtomValue(projectRailEntriesAtom);
  const groups = useAtomValue(projectRailGroupsAtom);
  const activity = useAtomValue(globalSessionActivityAtom);
  const activitySummary = useAtomValue(projectActivitySummaryAtom);
  const projectListRef = React.useRef<HTMLDivElement | null>(null);

  // Naming a new group, or editing an existing one.
  const [editor, setEditor] = useState<
    { mode: 'create'; path: string } | { mode: 'edit'; groupId: string; isNew?: boolean } | null
  >(null);
  const handleDrop = useCallback((item: RailDragItem, target: RailDropTarget) => {
    const createdGroupId = dropOnRail({ item, target });
    // Dropping one project onto another made a group; offer to name it.
    if (createdGroupId) setEditor({ mode: 'edit', groupId: createdGroupId, isNew: true });
  }, [dropOnRail]);
  const drag = useProjectRailDrag(projectListRef, handleDrop);

  // A collapsed group hides the active project; the folder is revealed instead.
  const hiddenActiveGroupId = useMemo(() => {
    for (const entry of entries) {
      if (entry.kind === 'group' && entry.group.collapsed && entry.projects.some((project) => project.path === activePath)) {
        return entry.group.id;
      }
    }
    return null;
  }, [entries, activePath]);

  React.useLayoutEffect(() => {
    const list = projectListRef.current;
    if (!isMultiProjectMode || !list) return;

    const revealActiveProject = () => {
      const active = list.querySelector<HTMLElement>(
        '.project-rail-item.is-active, .project-rail-group.is-collapsed.contains-active > .project-rail-group-header',
      );
      if (!active) return;
      const viewport = list.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      // Include the close button's overhang. Scroll only the project list,
      // leaving the rest of the window and keyboard focus untouched.
      const above = item.top - viewport.top - 4;
      const below = item.bottom - viewport.bottom + 4;
      if (above < 0) list.scrollTop += above;
      else if (below > 0) list.scrollTop += below;
    };

    revealActiveProject();
    const observer = new ResizeObserver(revealActiveProject);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activePath, openProjects.length, isMultiProjectMode, hiddenActiveGroupId]);

  const handleActivate = useCallback(
    (path: string) => {
      if (path === activePath) return;
      // The atom subscriber in initOpenProjects() forwards the change to
      // the main process via `workspace:set-active`, so there is no direct
      // IPC call here.
      setActivePath(path);
    },
    [activePath, setActivePath]
  );

  /** Register and add a project. Resolves true once it is on the rail. */
  const addProjectByPath = useCallback(async (workspacePath: string, activate = true): Promise<boolean> => {
    if (!window.electronAPI?.invoke) return false;
    if (store.get(isOpenProjectsAtCapAtom) && !store.get(openProjectsAtom).some(p => p.path === workspacePath)) return false;
    try {
      const reg = await window.electronAPI.invoke('workspace:register-additional', { workspacePath });
      if (!reg?.success) {
        console.error('[ProjectRail] register-additional failed:', reg?.error);
        return false;
      }

      const project: OpenProject = {
        path: workspacePath,
        name: nameFromPath(workspacePath),
        openedAt: Date.now(),
      };
      // With `activate`, `addOpenProjectAtom` flips `activeWorkspacePathAtom`
      // to this path; the atom subscriber dispatches `workspace:set-active`.
      if (addProject(project, { activate })) return true;
      // The limit can change in another window while registration is pending.
      await window.electronAPI.invoke('workspace:unregister-additional', { workspacePath });
    } catch (err) {
      console.error('[ProjectRail] addProjectByPath failed:', err);
    }
    return false;
  }, [addProject, store]);

  const handlePickFolder = useCallback(async () => {
    if (!window.electronAPI?.invoke) return;
    try {
      const result = await window.electronAPI.invoke('dialog-show-open-dialog', {
        properties: ['openDirectory'],
        title: 'Open Project',
      });
      if (result?.canceled) return;
      const picked: string | undefined = result?.filePaths?.[0];
      if (!picked) return;
      await addProjectByPath(picked);
    } catch (err) {
      console.error('[ProjectRail] handlePickFolder failed:', err);
    }
  }, [addProjectByPath]);

  const refreshRecents = useCallback(async () => {
    if (!window.electronAPI?.invoke) return;
    try {
      const items = await window.electronAPI.invoke('settings:get-recent-projects') as Array<{ path: string; name: string; timestamp?: number }>;
      setRecentProjects(Array.isArray(items) ? items : []);
    } catch (err) {
      console.error('[ProjectRail] failed to load recents:', err);
    }
  }, []);

  const handleOpenAddMenu = useCallback(() => {
    if (atCap) {
      errorNotificationService.showWarning(
        'Project limit reached',
        'The project limit is eight per window. Close a project or enable Allow unlimited projects in Settings > Advanced.',
      );
      return;
    }
    refreshRecents();
    setAddMenuOpen(true);
  }, [atCap, refreshRecents]);

  const handleClose = useCallback(
    async (project: OpenProject) => {
      // Warn if there are streaming sessions for this project. Read from the
      // cross-workspace activity tracker (kept in sync by sessionStateListeners
      // for every warm rail project) instead of `sessionRegistryAtom`, which
      // only carries the active project's sessions and would silently skip
      // the prompt when closing an inactive rail project.
      const streaming = activity.get(project.path)?.streaming.size ?? 0;
      if (streaming > 0) {
        const proceed = await requestConfirmation({
          title: 'Close project',
          message: `${project.name} has ${streaming} streaming session${streaming === 1 ? '' : 's'}. Close anyway? Sessions will be paused.`,
          confirmLabel: 'Close project',
        });
        if (!proceed) return;
      }

      const wasLast = openProjects.length <= 1;

      closeProject(project.path);

      try {
        await window.electronAPI?.invoke?.('workspace:unregister-additional', { workspacePath: project.path });
      } catch (err) {
        console.error('[ProjectRail] unregister-additional failed:', err);
      }

      // Closing the last project leaves nothing to render in this window.
      // Ask the host to close the window so the app can fall back to its
      // initial project-selection flow.
      if (wasLast) {
        try {
          await window.electronAPI?.invoke?.('workspace:close-rail-window');
        } catch (err) {
          console.error('[ProjectRail] close-rail-window failed:', err);
        }
      }
    },
    [closeProject, activity, openProjects.length]
  );

  const handleToggleGroup = useCallback((group: RailGroup) => {
    updateGroup({ groupId: group.id, patch: { collapsed: !group.collapsed } });
  }, [updateGroup]);

  // Closing a group closes its open projects; the group remembers them so
  // the "+" menu can reopen them together.
  const handleCloseGroup = useCallback(async (groupId: string) => {
    const entry = entries.find((candidate) => candidate.kind === 'group' && candidate.group.id === groupId);
    if (entry?.kind !== 'group') return;
    const paths = entry.projects.map((project) => project.path);
    const streaming = paths.reduce((sum, path) => sum + (activity.get(path)?.streaming.size ?? 0), 0);
    const closesWindow = paths.length >= openProjects.length;
    if (streaming > 0 || closesWindow) {
      const proceed = await requestConfirmation({
        title: 'Close group',
        message: [
          `Close ${paths.length === 1 ? 'the project' : `all ${paths.length} projects`} in ${entry.group.name}?`,
          streaming > 0 ? `${streaming} streaming session${streaming === 1 ? '' : 's'} will be paused.` : '',
          closesWindow ? 'No other project is open, so this window closes.' : '',
        ].filter(Boolean).join(' '),
        confirmLabel: 'Close projects',
      });
      if (!proceed) return;
    }

    closeProjects(paths);
    for (const workspacePath of paths) {
      try {
        await window.electronAPI?.invoke?.('workspace:unregister-additional', { workspacePath });
      } catch (err) {
        console.error('[ProjectRail] unregister-additional failed:', err);
      }
    }
    if (closesWindow) {
      try {
        await window.electronAPI?.invoke?.('workspace:close-rail-window');
      } catch (err) {
        console.error('[ProjectRail] close-rail-window failed:', err);
      }
    }
  }, [entries, activity, openProjects.length, closeProjects]);

  // Reopen a group's closed projects together and show the first of them.
  const handleOpenGroup = useCallback(async (group: RailGroup) => {
    const open = new Set(store.get(openProjectsAtom).map((project) => project.path));
    const closed = group.projectPaths.filter((path) => !open.has(path));
    const opened: string[] = [];
    for (const path of closed) {
      if (await addProjectByPath(path, false)) opened.push(path);
    }
    if (opened.length > 0) setActivePath(opened[0]);
    if (opened.length < closed.length) {
      errorNotificationService.showWarning(
        `Opened ${opened.length} of ${closed.length} projects in ${group.name}`,
        store.get(isOpenProjectsAtCapAtom)
          ? 'The project limit is eight per window. Close a project or enable Allow unlimited projects in Settings > Advanced.'
          : 'Some projects could not be opened. Check that their folders still exist.',
      );
    }
  }, [addProjectByPath, setActivePath, store]);

  // Right-click context menu state, for a project or a group. Anchored to a
  // virtual reference at the cursor position so it works for any rail
  // element without per-element refs.
  const [menu, setMenu] = useState<
    | { kind: 'project'; project: OpenProject; x: number; y: number }
    | { kind: 'group'; groupId: string; x: number; y: number }
    | null
  >(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuItem: RailDragItem | null = !menu ? null
    : menu.kind === 'project' ? { kind: 'project', path: menu.project.path } : { kind: 'group', groupId: menu.groupId };
  const canStepMenuItem = (direction: -1 | 1) => menuItem !== null && railStepTarget(entries, menuItem, direction) !== null;
  const stepMenuItem = (direction: -1 | 1) => {
    if (menuItem) stepRailItem({ item: menuItem, direction });
    closeMenu();
  };
  const menuProjectGroup = menu?.kind === 'project' ? railGroupForPath(groups, menu.project.path) : undefined;
  const menuGroupEntry = menu?.kind === 'group' ? findGroupEntry(entries, menu.groupId) : undefined;
  const menuGroupGone = menu?.kind === 'group' && !menuGroupEntry;
  // Another window can dissolve the group, or its last project can close.
  React.useEffect(() => { if (menuGroupGone) setMenu(null); }, [menuGroupGone]);

  // "Add project" dropdown — opens recents + folder picker action when the
  // user clicks the `+` button.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<Array<{ path: string; name: string; timestamp?: number }>>([]);
  const addButtonRef = React.useRef<HTMLButtonElement | null>(null);

  const {
    refs: addRefs,
    floatingStyles: addFloatingStyles,
    context: addContext,
  } = useFloating({
    open: addMenuOpen,
    onOpenChange: setAddMenuOpen,
    // The Add button stays at the bottom of the rail. Align the menu's
    // bottom with it, and track size changes as recent folders load.
    placement: 'right-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      windowControlsClearance(),
      size({
        padding: 8,
        apply({ availableHeight, elements, x, rects }) {
          // Reserve the controls band from the viewport's padded top, not
          // from the menu's current y: bottom alignment makes y depend on
          // height, so subtracting the last push can cause a resize loop.
          const reserved = clearWindowControls(x, 8, rects.floating.width, getWindowControlsZones()) - 8;
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight - reserved)}px`;
          elements.floating.style.overflowY = 'auto';
        },
      }),
    ],
  });
  const addDismiss = useDismiss(addContext);
  const addRole = useRole(addContext, { role: 'menu' });
  const { getFloatingProps: getAddFloatingProps } = useInteractions([addDismiss, addRole]);

  // Hover tooltip for the add button. Separate floating-ui instance from
  // the click-driven add menu above; both share `addButtonRef` as the
  // anchor element.
  const [addTooltipOpen, setAddTooltipOpen] = useState(false);
  const {
    refs: addTooltipRefs,
    floatingStyles: addTooltipFloatingStyles,
    context: addTooltipContext,
  } = useFloating({
    open: addTooltipOpen,
    onOpenChange: setAddTooltipOpen,
    placement: 'right',
    middleware: [offset(12), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const addTooltipHover = useHover(addTooltipContext, { delay: { open: 200, close: 0 }, move: false });
  const { getReferenceProps: getAddTooltipRefProps, getFloatingProps: getAddTooltipFloatingProps } =
    useInteractions([addTooltipHover]);

  React.useEffect(() => {
    if (addButtonRef.current) {
      addRefs.setReference(addButtonRef.current);
      addTooltipRefs.setReference(addButtonRef.current);
    }
  }, [addRefs, addTooltipRefs]);

  const openProjectPaths = useMemo(() => new Set(openProjects.map((p) => p.path)), [openProjects]);
  const filteredRecents = useMemo(
    () => recentProjects.filter((r) => !openProjectPaths.has(r.path)).slice(0, 8),
    [recentProjects, openProjectPaths]
  );
  // Groups with projects that are closed in this window.
  const groupsToOpen = useMemo(
    () => groups.filter((group) => group.projectPaths.some((path) => !openProjectPaths.has(path))),
    [groups, openProjectPaths],
  );

  const { refs, floatingStyles, context } = useFloating({
    open: menu !== null,
    onOpenChange: (open) => {
      if (!open) closeMenu();
    },
    placement: 'right-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });

  // Use a virtual reference at the cursor position. setPositionReference
  // accepts a VirtualElement which is the documented escape hatch.
  React.useEffect(() => {
    if (!menu) {
      refs.setPositionReference(null);
      return;
    }
    const virtual: VirtualElement = {
      getBoundingClientRect: () => DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
    };
    refs.setPositionReference(virtual);
  }, [menu, refs]);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const handleContextMenu = useCallback((project: OpenProject, x: number, y: number) => {
    setMenu({ kind: 'project', project, x, y });
  }, []);

  const handleGroupContextMenu = useCallback((group: RailGroup, x: number, y: number) => {
    setMenu({ kind: 'group', groupId: group.id, x, y });
  }, []);

  // The editor sits beside the project or group it names. Look the element
  // up after each render: a merge renders the new group only after the drop.
  const [editorAnchor, setEditorAnchor] = useState<Element | null>(null);
  React.useLayoutEffect(() => {
    if (!editor) {
      setEditorAnchor(null);
      return;
    }
    const list = projectListRef.current;
    const anchor = editor.mode === 'create'
      ? Array.from(list?.querySelectorAll<HTMLElement>('.project-rail-item') ?? [])
        .find((item) => item.dataset.projectPath === editor.path)
      : Array.from(list?.querySelectorAll<HTMLElement>('.project-rail-group') ?? [])
        .find((item) => item.dataset.groupId === editor.groupId)
        ?.querySelector('.project-rail-group-header');
    setEditorAnchor(anchor ?? null);
    // The project closed or another window removed the group.
    if (!anchor) setEditor(null);
  }, [editor, entries]);
  const editedGroup = editor?.mode === 'edit' ? groups.find((group) => group.id === editor.groupId) : undefined;

  const handleOpenInNewWindow = useCallback(async (project: OpenProject) => {
    closeMenu();
    try {
      await window.electronAPI?.invoke?.('workspace-manager:open-workspace', project.path);
    } catch (err) {
      console.error('[ProjectRail] open-workspace failed:', err);
    }
  }, [closeMenu]);

  const handleRevealInFinder = useCallback(async (project: OpenProject) => {
    closeMenu();
    try {
      await window.electronAPI?.invoke?.('show-in-finder', project.path);
    } catch (err) {
      console.error('[ProjectRail] show-in-finder failed:', err);
    }
  }, [closeMenu]);

  if (!isMultiProjectMode) return null;

  const marker = dropMarker(entries, drag.target);
  const overlayOpen = menu !== null || editor !== null;
  const renderProject = (project: OpenProject) => {
    const summary = activitySummary.get(project.path);
    const position = marker?.key === `project:${project.path}` ? marker.position : undefined;
    return (
      <ProjectRailIcon
        key={project.path}
        project={project}
        isActive={project.path === activePath}
        processingCount={summary?.processing ?? 0}
        unreadCount={summary?.unread ?? 0}
        onActivate={handleActivate}
        onClose={handleClose}
        onContextMenu={handleContextMenu}
        isDragging={drag.dragged?.kind === 'project' && drag.dragged.path === project.path}
        menuOpen={overlayOpen}
        dropPosition={position === 'join' ? undefined : position}
        onDragStart={(event, path) => { closeMenu(); drag.onDragStart(event, { kind: 'project', path }); }}
        onDragEnd={drag.onDragEnd}
      />
    );
  };
  const groupColorStyle = (group: RailGroup) =>
    (group.color ? { '--rail-group-color': group.color } as React.CSSProperties : undefined);

  return (
    <nav className="project-rail" data-testid="project-rail" aria-label="Open projects">
      {/* Epic H1: org switcher sits above the project switcher. */}
      <OrgSwitcher />
      <div ref={projectListRef} className="project-rail-projects" data-testid="project-rail-projects" {...drag.listProps}>
        {entries.map((entry) => {
          if (entry.kind === 'project') return renderProject(entry.project);
          const { group, projects } = entry;
          // As on single icons, the project the user is looking at adds no badge.
          const others = projects.filter((project) => project.path !== activePath);
          const position = marker?.key === `group:${group.id}` ? marker.position : undefined;
          return (
            <ProjectRailGroup
              key={group.id}
              group={group}
              projects={projects}
              containsActive={others.length < projects.length}
              processingCount={others.reduce((sum, project) => sum + (activitySummary.get(project.path)?.processing ?? 0), 0)}
              unreadCount={others.reduce((sum, project) => sum + (activitySummary.get(project.path)?.unread ?? 0), 0)}
              menuOpen={overlayOpen}
              isDragging={drag.dragged?.kind === 'group' && drag.dragged.groupId === group.id}
              dropPosition={position === 'merge' ? undefined : position}
              onToggle={handleToggleGroup}
              onContextMenu={handleGroupContextMenu}
              onDragStart={(event, dragged) => { closeMenu(); drag.onDragStart(event, { kind: 'group', groupId: dragged.id }); }}
              onDragEnd={drag.onDragEnd}
            >
              {projects.map(renderProject)}
            </ProjectRailGroup>
          );
        })}
      </div>
      {openProjects.length > 0 && <div className="project-rail-divider" aria-hidden="true" />}
      <button
        ref={addButtonRef}
        type="button"
        className="project-rail-add"
        onClick={handleOpenAddMenu}
        disabled={atCap}
        data-testid="project-rail-add"
        aria-label="Add project to rail"
        {...getAddTooltipRefProps()}
      >
        +
      </button>
      {addTooltipOpen && (
        <FloatingPortal>
          <div
            ref={addTooltipRefs.setFloating}
            className="project-rail-tooltip"
            style={addTooltipFloatingStyles}
            {...getAddTooltipFloatingProps()}
          >
            {atCap ? 'Eight-project limit reached. Enable Allow unlimited projects in Settings > Advanced.' : 'Add project'}
          </div>
        </FloatingPortal>
      )}

      {addMenuOpen && (
        <FloatingPortal>
          <div
            ref={addRefs.setFloating}
            className="project-rail-context-menu project-rail-add-menu"
            style={addFloatingStyles}
            data-testid="project-rail-add-menu"
            {...getAddFloatingProps()}
          >
            <button
              type="button"
              className="project-rail-context-menu-item"
              onClick={() => {
                setAddMenuOpen(false);
                handlePickFolder();
              }}
            >
              Open folder…
            </button>
            {groupsToOpen.length > 0 && (
              <>
                <div className="project-rail-context-menu-divider" />
                <div className="project-rail-context-menu-heading">Groups</div>
                {groupsToOpen.map((group) => {
                  const closed = group.projectPaths.filter((path) => !openProjectPaths.has(path));
                  return (
                    <button
                      key={group.id}
                      type="button"
                      className="project-rail-context-menu-item project-rail-context-menu-item-recent project-rail-context-menu-item-group"
                      style={groupColorStyle(group)}
                      onClick={() => {
                        setAddMenuOpen(false);
                        handleOpenGroup(group);
                      }}
                      title={closed.join('\n')}
                    >
                      <span className="project-rail-context-menu-item-name">{group.name}</span>
                      <span className="project-rail-context-menu-item-path">
                        {`Open ${closed.length === 1 ? '1 project' : `${closed.length} projects`}: ${closed.map(nameFromPath).join(', ')}`}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
            {filteredRecents.length > 0 && (
              <>
                <div className="project-rail-context-menu-divider" />
                <div className="project-rail-context-menu-heading">Recent projects</div>
                {filteredRecents.map((recent) => (
                  <button
                    key={recent.path}
                    type="button"
                    className="project-rail-context-menu-item project-rail-context-menu-item-recent"
                    onClick={() => {
                      setAddMenuOpen(false);
                      addProjectByPath(recent.path);
                    }}
                    title={recent.path}
                  >
                    <span className="project-rail-context-menu-item-name">{recent.name || recent.path}</span>
                    <span className="project-rail-context-menu-item-path">{recent.path}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </FloatingPortal>
      )}

      {menu && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
          <div
            ref={refs.setFloating}
            className="project-rail-context-menu"
            style={floatingStyles}
            data-testid="project-rail-context-menu"
            {...getFloatingProps({
              onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next]?.focus();
              },
            })}
          >
            {menu.kind === 'project' ? (
              <>
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  disabled={!canStepMenuItem(-1)} onClick={() => stepMenuItem(-1)}>
                  Move up
                </button>
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  disabled={!canStepMenuItem(1)} onClick={() => stepMenuItem(1)}>
                  Move down
                </button>
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  disabled={openProjects.length < 2} onClick={() => { sortProjects(); closeMenu(); }}>
                  Sort by name
                </button>
                <div className="project-rail-context-menu-divider" />
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  onClick={() => { setEditor({ mode: 'create', path: menu.project.path }); closeMenu(); }}>
                  New group…
                </button>
                {groups.some((group) => group !== menuProjectGroup) && (
                  <>
                    <div className="project-rail-context-menu-heading">Move to group</div>
                    {groups.filter((group) => group !== menuProjectGroup).map((group) => (
                      <button
                        key={group.id}
                        type="button"
                        role="menuitem"
                        className="project-rail-context-menu-item project-rail-context-menu-item-group"
                        style={groupColorStyle(group)}
                        onClick={() => { setProjectGroup({ path: menu.project.path, groupId: group.id }); closeMenu(); }}
                      >
                        <span className="project-rail-context-menu-item-name">{group.name}</span>
                      </button>
                    ))}
                  </>
                )}
                {menuProjectGroup && (
                  <button type="button" role="menuitem" className="project-rail-context-menu-item"
                    onClick={() => { setProjectGroup({ path: menu.project.path, groupId: null }); closeMenu(); }}>
                    Remove from group
                  </button>
                )}
                <div className="project-rail-context-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="project-rail-context-menu-item"
                  onClick={() => {
                    openSettings({ category: 'project-appearance', scope: 'project', timestamp: Date.now(),
                      destination: { scope: 'project', category: 'project-appearance', target: { kind: 'workspace', workspacePath: menu.project.path } } });
                    closeMenu();
                  }}
                >
                  Customize appearance…
                </button>
                <button
                  type="button"
                  className="project-rail-context-menu-item"
                  onClick={() => handleOpenInNewWindow(menu.project)}
                >
                  Open in new window
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="project-rail-context-menu-item"
                  onClick={() => handleRevealInFinder(menu.project)}
                >
                  {REVEAL_LABEL}
                </button>
                <div className="project-rail-context-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="project-rail-context-menu-item"
                  onClick={() => {
                    closeMenu();
                    handleClose(menu.project);
                  }}
                >
                  Close project
                </button>
              </>
            ) : menuGroupEntry && (
              <>
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  onClick={() => { handleToggleGroup(menuGroupEntry.group); closeMenu(); }}>
                  {menuGroupEntry.group.collapsed ? 'Expand group' : 'Collapse group'}
                </button>
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  onClick={() => { setEditor({ mode: 'edit', groupId: menu.groupId }); closeMenu(); }}>
                  Edit group…
                </button>
                <div className="project-rail-context-menu-divider" />
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  disabled={!canStepMenuItem(-1)} onClick={() => stepMenuItem(-1)}>
                  Move up
                </button>
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  disabled={!canStepMenuItem(1)} onClick={() => stepMenuItem(1)}>
                  Move down
                </button>
                <div className="project-rail-context-menu-divider" />
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  onClick={() => { dissolveGroup(menu.groupId); closeMenu(); }}>
                  Ungroup
                </button>
                <button type="button" role="menuitem" className="project-rail-context-menu-item"
                  onClick={() => { closeMenu(); handleCloseGroup(menu.groupId); }}>
                  {menuGroupEntry.projects.length === 1 ? 'Close project in group' : `Close ${menuGroupEntry.projects.length} projects in group`}
                </button>
              </>
            )}
          </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}

      {editor?.mode === 'create' && editorAnchor && (
        <ProjectRailGroupEditor
          key={`create:${editor.path}`}
          anchor={editorAnchor}
          title="New group"
          submitLabel="Create group"
          initial={{ ...railGroupEditorValue(), color: nextRailGroupColor(groups) }}
          projects={openProjects.filter((project) => project.path === editor.path)}
          onSubmit={(value) => {
            createGroup({ paths: [editor.path], ...value });
            setEditor(null);
          }}
          onCancel={() => setEditor(null)}
        />
      )}
      {editor?.mode === 'edit' && editedGroup && editorAnchor && (
        <ProjectRailGroupEditor
          key={`edit:${editedGroup.id}`}
          anchor={editorAnchor}
          title={editor.isNew ? 'New group' : 'Edit group'}
          submitLabel="Save"
          initial={railGroupEditorValue(editedGroup)}
          projects={findGroupEntry(entries, editedGroup.id)?.projects ?? []}
          onSubmit={(patch) => {
            updateGroup({ groupId: editedGroup.id, patch });
            setEditor(null);
          }}
          onCancel={() => setEditor(null)}
        />
      )}
    </nav>
  );
}
