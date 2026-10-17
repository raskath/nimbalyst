import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import type { RailDragItem, RailDropTarget } from '../../store/atoms/projectRailGroups';

const PROJECT_DRAG_TYPE = 'application/x-nimbalyst-rail-project';

interface Span { top: number; bottom: number }

/** A top-level rail element, as the drop hit test sees it. */
export interface RailHitSlot extends Span {
  kind: 'project' | 'group';
  /** Project path or group id. */
  id: string;
  /** The project itself, or the group's first open member. */
  firstPath: string;
  collapsed?: boolean;
  /** The group's folder tile. */
  header?: Span;
  /** An expanded group's rendered members. */
  members?: Array<Span & { path: string }>;
}

/**
 * Where a drag at `y` lands. The outer quarters of a tile insert before or
 * after it; the middle of a project merges the two into a new group, and the
 * middle of a folder tile adds to that group. Inside an expanded group,
 * members split at their midpoints. A dragged group only moves between
 * top-level entries, so groups never nest.
 */
export function railDropTargetAt(slots: readonly RailHitSlot[], y: number, dragged: RailDragItem): RailDropTarget {
  const draggedPath = dragged.kind === 'project' ? dragged.path : null;
  const visible = slots.filter((slot) => (dragged.kind === 'project'
    ? !(slot.kind === 'project' && slot.id === dragged.path)
    : !(slot.kind === 'group' && slot.id === dragged.groupId)));
  // The first path at or after a slot, skipping the dragged project, which
  // may be the first member of an expanded group.
  const firstPathFrom = (index: number): string | null => {
    for (const slot of visible.slice(index)) {
      if (slot.kind === 'project') return slot.id;
      const path = slot.collapsed ? slot.firstPath : slot.members?.find((member) => member.path !== draggedPath)?.path;
      if (path) return path;
    }
    return null;
  };

  for (let index = 0; index < visible.length; index++) {
    const slot = visible[index];
    if (dragged.kind === 'group') {
      if (y < (slot.top + slot.bottom) / 2) return { type: 'insert', beforePath: firstPathFrom(index), groupId: null };
      continue;
    }
    const tile = slot.header ?? slot;
    const quarter = (tile.bottom - tile.top) / 4;
    if (y < tile.top + quarter) return { type: 'insert', beforePath: firstPathFrom(index), groupId: null };
    if (slot.kind === 'project') {
      if (y < tile.bottom - quarter) return { type: 'merge', targetPath: slot.id };
      continue;
    }
    if (slot.collapsed) {
      if (y < tile.bottom - quarter) return { type: 'join', groupId: slot.id };
      continue;
    }
    if (y < tile.bottom) return { type: 'join', groupId: slot.id };
    if (y >= slot.bottom) continue;
    const member = slot.members?.find((candidate) => candidate.path !== draggedPath && y < (candidate.top + candidate.bottom) / 2);
    return { type: 'insert', beforePath: member?.path ?? firstPathFrom(index + 1), groupId: slot.id };
  }
  return { type: 'insert', beforePath: null, groupId: null };
}

function span(element: Element): Span {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/** Read the rail's top-level projects and groups from the DOM. */
export function collectRailSlots(list: HTMLElement): RailHitSlot[] {
  return Array.from(list.children).flatMap((element): RailHitSlot[] => {
    if (!(element instanceof HTMLElement)) return [];
    const { groupId, firstPath, projectPath } = element.dataset;
    if (groupId && firstPath) {
      const header = element.querySelector('.project-rail-group-header');
      return [{
        kind: 'group',
        id: groupId,
        firstPath,
        collapsed: element.dataset.collapsed === 'true',
        ...span(element),
        header: header ? span(header) : undefined,
        members: Array.from(element.querySelectorAll<HTMLElement>('.project-rail-item'))
          .map((item) => ({ path: item.dataset.projectPath ?? '', ...span(item) })),
      }];
    }
    return projectPath ? [{ kind: 'project', id: projectPath, firstPath: projectPath, ...span(element) }] : [];
  });
}

function sameTarget(a: RailDropTarget | undefined, b: RailDropTarget | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.type === 'insert' && b.type === 'insert') return a.beforePath === b.beforePath && a.groupId === b.groupId;
  if (a.type === 'merge' && b.type === 'merge') return a.targetPath === b.targetPath;
  return a.type === 'join' && b.type === 'join' && a.groupId === b.groupId;
}

/** Native drag with drop markers and frame-based scrolling at list edges. */
export function useProjectRailDrag(
  listRef: RefObject<HTMLDivElement | null>,
  drop: (item: RailDragItem, target: RailDropTarget) => void,
) {
  const [dragged, setDragged] = useState<RailDragItem | null>(null);
  const [target, setTargetState] = useState<RailDropTarget | undefined>();
  const drag = useRef<{ item: RailDragItem; y: number; inside: boolean } | null>(null);
  const frame = useRef<number | null>(null);

  // dragover fires continuously; only re-render when the target changes.
  const setTarget = useCallback((next: RailDropTarget | undefined) => {
    setTargetState((current) => (sameTarget(current, next) ? current : next));
  }, []);

  const clear = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    setDragged(null);
    setTargetState(undefined);
  }, []);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const targetAt = useCallback((y: number): RailDropTarget | undefined => {
    const list = listRef.current;
    const current = drag.current;
    if (!list || !current) return undefined;
    return railDropTargetAt(collectRailSlots(list), y, current.item);
  }, [listRef]);

  const tick = useCallback(() => {
    const list = listRef.current;
    const current = drag.current;
    if (!list || !current?.inside) { frame.current = null; return; }
    const rect = list.getBoundingClientRect();
    const edge = Math.min(32, rect.height / 4);
    const speed = current.y < rect.top + edge
      ? -Math.min(10, (rect.top + edge - current.y) / 3)
      : current.y > rect.bottom - edge
        ? Math.min(10, (current.y - rect.bottom + edge) / 3)
        : 0;
    if (speed) {
      list.scrollTop += speed;
      setTarget(targetAt(current.y));
    }
    frame.current = requestAnimationFrame(tick);
  }, [listRef, targetAt, setTarget]);

  const onDragStart = useCallback((event: DragEvent, item: RailDragItem) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROJECT_DRAG_TYPE, item.kind === 'project' ? item.path : item.groupId);
    drag.current = { item, y: event.clientY, inside: false };
    setDragged(item);
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    if (!drag.current) return; // Files and drags from other windows are not rail moves.
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    drag.current.y = event.clientY;
    drag.current.inside = true;
    setTarget(targetAt(event.clientY));
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  }, [targetAt, tick, setTarget]);

  const onDragLeave = useCallback((event: DragEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    // Native drags can report a null relatedTarget between children.
    if (event.clientX >= bounds.left && event.clientX < bounds.right
      && event.clientY >= bounds.top && event.clientY < bounds.bottom) return;
    if (drag.current) drag.current.inside = false;
    setTarget(undefined);
  }, [setTarget]);

  const onDrop = useCallback((event: DragEvent) => {
    const current = drag.current;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    const dropTarget = targetAt(event.clientY);
    if (dropTarget) drop(current.item, dropTarget);
    clear();
  }, [drop, targetAt, clear]);

  return { dragged, target, onDragStart, onDragEnd: clear, listProps: { onDragOver, onDragLeave, onDrop } };
}
