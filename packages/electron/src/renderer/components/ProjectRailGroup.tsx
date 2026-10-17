/**
 * ProjectRailGroup
 *
 * A Discord-style folder in the project rail. Collapsed, it is one tile with
 * up to four miniature project icons, or the group's own initials, icon or
 * image, plus a combined activity badge; expanded, the tile stays the same,
 * marked with a small open-folder badge, and its projects stack below it on a
 * band of the group's color. Clicking the tile toggles it; the rail owns
 * menus, dragging and drops.
 */

import React, { useCallback, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  flip,
  FloatingPortal,
  offset,
  shift,
  useFloating,
  useHover,
  useInteractions,
} from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { generateWorkspaceAccentColor, projectIconForeground, projectInitials } from '../../shared/projectAppearance';
import { projectAppearanceAtom } from '../store/atoms/projectAppearance';
import type { OpenProject } from '../store/atoms/openProjects';
import {
  PROJECT_RAIL_GROUP_ICONS,
  type ProjectRailGroup as RailGroup,
  type RailGroupDisplay,
} from '../store/atoms/projectRailGroups';
import { ProjectIcon } from './ProjectIcon';

function GroupMiniIcon({ project }: { project: OpenProject }) {
  const appearance = useAtomValue(projectAppearanceAtom(project.path)).snapshot?.appearance ?? {};
  return (
    <span
      className="project-rail-group-mini"
      style={{
        '--rail-item-accent': appearance.color || generateWorkspaceAccentColor(project.path),
        '--rail-item-foreground': projectIconForeground(appearance.color),
      } as React.CSSProperties}
    >
      <ProjectIcon name={project.name} appearance={appearance} />
    </span>
  );
}

/** A stored group, or the group editor's draft (which uses null for unset values). */
export interface RailGroupTileSource {
  name: string;
  display?: RailGroupDisplay;
  initials?: string | null;
  icon?: string | null;
  image?: string | null;
}

/** What a collapsed folder shows. Shared with the group editor's preview. */
export function ProjectRailGroupTile({ group, projects }: { group: RailGroupTileSource; projects: OpenProject[] }) {
  // A broken image falls back to the icon, like project images fall back to initials.
  const [failedImage, setFailedImage] = useState<string | null>(null);
  if (group.display === 'initials') {
    return <span className="project-rail-group-initials">{group.initials?.trim() || projectInitials(group.name)}</span>;
  }
  if (group.display === 'icon') {
    const { image } = group;
    return image && failedImage !== image
      ? <img className="project-rail-group-image" src={image} alt="" draggable={false} onError={() => setFailedImage(image)} />
      : <MaterialSymbol icon={group.icon || PROJECT_RAIL_GROUP_ICONS[0].icon} size={22} className="project-rail-group-symbol" />;
  }
  return (
    <span className="project-rail-group-grid" aria-hidden="true">
      {projects.slice(0, 4).map((project) => <GroupMiniIcon key={project.path} project={project} />)}
    </span>
  );
}

interface ProjectRailGroupProps {
  group: RailGroup;
  /** Open members in rail order. */
  projects: OpenProject[];
  containsActive: boolean;
  /** Activity of the members the user is not looking at. */
  processingCount: number;
  unreadCount: number;
  menuOpen: boolean;
  isDragging: boolean;
  dropPosition?: 'before' | 'after' | 'join';
  onToggle: (group: RailGroup) => void;
  onContextMenu: (group: RailGroup, x: number, y: number) => void;
  onDragStart: (event: React.DragEvent, group: RailGroup) => void;
  onDragEnd: () => void;
  /** The member icons, rendered while the group is expanded. */
  children?: React.ReactNode;
}

export function ProjectRailGroup({
  group,
  projects,
  containsActive,
  processingCount,
  unreadCount,
  menuOpen,
  isDragging,
  dropPosition,
  onToggle,
  onContextMenu,
  onDragStart,
  onDragEnd,
  children,
}: ProjectRailGroupProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open: tooltipOpen,
    onOpenChange: setTooltipOpen,
    placement: 'right',
    middleware: [offset(12), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const hover = useHover(context, { enabled: !menuOpen && !isDragging, delay: { open: 200, close: 0 }, move: false });
  React.useEffect(() => { if (menuOpen) setTooltipOpen(false); }, [menuOpen]);
  const { getReferenceProps, getFloatingProps } = useInteractions([hover]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.querySelector<HTMLButtonElement>('.project-rail-group-toggle')?.focus();
    onContextMenu(group, event.clientX, event.clientY);
  }, [group, onContextMenu]);

  const { collapsed } = group;
  const showBadge = collapsed && (processingCount > 0 || unreadCount > 0);
  const count = `${projects.length} project${projects.length === 1 ? '' : 's'}`;
  const className = `project-rail-group ${collapsed ? 'is-collapsed' : 'is-expanded'}`
    + `${containsActive ? ' contains-active' : ''}${isDragging ? ' is-dragging' : ''}`;

  return (
    <div
      className={className}
      role="group"
      aria-label={group.name}
      data-testid="project-rail-group"
      data-group-id={group.id}
      data-first-path={projects[0]?.path}
      data-collapsed={String(collapsed)}
      data-drop-position={dropPosition === 'join' ? undefined : dropPosition}
      style={group.color ? { '--rail-group-color': group.color } as React.CSSProperties : undefined}
    >
      <div
        ref={refs.setReference}
        className="project-rail-group-header"
        data-drop-target={dropPosition === 'join' ? 'join' : undefined}
        onContextMenu={handleContextMenu}
        {...getReferenceProps()}
      >
        <button
          type="button"
          className="project-rail-group-toggle"
          draggable
          onClick={() => onToggle(group)}
          onDragStart={(event) => { setTooltipOpen(false); onDragStart(event, group); }}
          onDragEnd={onDragEnd}
          onKeyDown={(event) => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onContextMenu(group, rect.right, rect.top);
          }}
          aria-expanded={!collapsed}
          aria-haspopup="menu"
          aria-label={`Group ${group.name}, ${count}`}
          aria-current={collapsed && containsActive ? 'true' : undefined}
        >
          <ProjectRailGroupTile group={group} projects={projects} />
          {/* Same corner as the activity badge, which only a collapsed group shows. */}
          {!collapsed && (
            <span className="project-rail-group-open-badge" data-testid="project-rail-group-open-badge" aria-hidden="true">
              <MaterialSymbol icon="folder_open" size={10} opticalSize={20} />
            </span>
          )}
          {showBadge && (
            <span
              className="project-rail-item-badge"
              aria-label={processingCount > 0 ? `${processingCount} streaming session(s)` : `${unreadCount} unread`}
            >
              {processingCount > 0 ? processingCount : unreadCount}
            </span>
          )}
        </button>
      </div>
      {!collapsed && children}
      {tooltipOpen && !isDragging && !menuOpen && (
        <FloatingPortal>
          <div ref={refs.setFloating} className="project-rail-tooltip" style={floatingStyles} {...getFloatingProps()}>
            <span className="project-rail-tooltip-name">{group.name}</span>
            <span className="project-rail-tooltip-path">
              {collapsed ? projects.map((project) => project.name).join(', ') : count}
            </span>
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
