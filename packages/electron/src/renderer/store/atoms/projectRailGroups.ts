/**
 * Project rail groups
 *
 * Named, collapsible folders in the multi-project rail. Groups are global:
 * every window reads the same `projects.railGroups` setting. Membership is
 * kept for closed projects, so a project reopened later lands in its group
 * again, and a group whose projects are all closed can be reopened as a set.
 *
 * The rail's visual order is derived. `openProjectsAtom` keeps this window's
 * order of open projects; a group renders at the position of its first open
 * member and gathers its other open members behind it in their relative
 * order. Rail actions write that derived order back, so after any rail edit
 * the stored order and the visible order agree.
 *
 * The functions below are pure and work on any `{ path }` list. The atoms
 * that apply them to `openProjectsAtom` live in `openProjects.ts`, which owns
 * the open-project list and imports this module (not the other way round).
 */

import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import type { ProjectRailGroup } from '../../../shared/settings/keys';
import { settingAtom } from './settingAtomFamily';

export type { ProjectRailGroup };

/** Folder colors offered by the group editor. New groups take the first unused one. */
export const PROJECT_RAIL_GROUP_COLORS = [
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Slate', value: '#64748b' },
] as const;

export const DEFAULT_PROJECT_RAIL_GROUP_NAME = 'New group';

export type RailEntry<P extends { path: string }> =
  | { kind: 'project'; project: P }
  | { kind: 'group'; group: ProjectRailGroup; projects: P[] };

export type RailDragItem = { kind: 'project'; path: string } | { kind: 'group'; groupId: string };

/** Where a dragged project or group lands. Paths refer to rail order. */
export type RailDropTarget =
  /** Before `beforePath` (null: the end), inside `groupId` or at the top level. */
  | { type: 'insert'; beforePath: string | null; groupId: string | null }
  /** A new group made of the target project and the dragged one. */
  | { type: 'merge'; targetPath: string }
  /** The end of an existing group. */
  | { type: 'join'; groupId: string };

export interface RailLayout<P extends { path: string }> {
  projects: P[];
  groups: ProjectRailGroup[];
}

export type NewRailGroup = Omit<ProjectRailGroup, 'projectPaths'>;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Drop duplicate ids, give each path to the first group that lists it, and
 * remove groups without members, so a hand-edited or stale setting can never
 * render a project twice.
 */
export function normalizeRailGroups(groups: readonly ProjectRailGroup[]): ProjectRailGroup[] {
  const ids = new Set<string>();
  const claimed = new Set<string>();
  const result: ProjectRailGroup[] = [];
  for (const group of groups) {
    if (ids.has(group.id)) continue;
    const projectPaths = group.projectPaths.filter((path) => {
      if (claimed.has(path)) return false;
      claimed.add(path);
      return true;
    });
    if (projectPaths.length === 0) continue;
    ids.add(group.id);
    result.push(projectPaths.length === group.projectPaths.length ? group : { ...group, projectPaths });
  }
  return result;
}

export function railGroupForPath(groups: readonly ProjectRailGroup[], path: string): ProjectRailGroup | undefined {
  return groups.find((group) => group.projectPaths.includes(path));
}

/** Top-level rail entries: a group sits where its first open member is. */
export function buildRailEntries<P extends { path: string }>(
  projects: readonly P[],
  groups: readonly ProjectRailGroup[],
): RailEntry<P>[] {
  const groupByPath = new Map<string, ProjectRailGroup>();
  for (const group of groups) {
    for (const path of group.projectPaths) {
      if (!groupByPath.has(path)) groupByPath.set(path, group);
    }
  }
  const entries: RailEntry<P>[] = [];
  const groupEntries = new Map<string, P[]>();
  for (const project of projects) {
    const group = groupByPath.get(project.path);
    if (!group) {
      entries.push({ kind: 'project', project });
      continue;
    }
    const members = groupEntries.get(group.id);
    if (members) {
      members.push(project);
      continue;
    }
    const entry = { kind: 'group' as const, group, projects: [project] };
    groupEntries.set(group.id, entry.projects);
    entries.push(entry);
  }
  return entries;
}

export function flattenRailEntries<P extends { path: string }>(entries: readonly RailEntry<P>[]): P[] {
  return entries.flatMap((entry) => (entry.kind === 'project' ? [entry.project] : entry.projects));
}

/** Open projects in the order the rail shows them. */
export function orderRailProjects<P extends { path: string }>(
  projects: readonly P[],
  groups: readonly ProjectRailGroup[],
): P[] {
  return flattenRailEntries(buildRailEntries(projects, groups));
}

export function railEntryFirstPath<P extends { path: string }>(entry: RailEntry<P> | undefined): string | null {
  if (!entry) return null;
  return entry.kind === 'project' ? entry.project.path : entry.projects[0]?.path ?? null;
}

/** First palette color no group uses yet; cycles once all are taken. */
export function nextRailGroupColor(groups: readonly ProjectRailGroup[]): string {
  const used = new Set(groups.map((group) => group.color?.toLowerCase()));
  return (PROJECT_RAIL_GROUP_COLORS.find((color) => !used.has(color.value))
    ?? PROJECT_RAIL_GROUP_COLORS[groups.length % PROJECT_RAIL_GROUP_COLORS.length]).value;
}

// ---------------------------------------------------------------------------
// Layout changes. Each returns null when nothing would change, so callers
// never write an identical list (subscribers persist on every write).
// ---------------------------------------------------------------------------

function sameGroup(a: ProjectRailGroup, b: ProjectRailGroup): boolean {
  return a === b || (
    a.id === b.id && a.name === b.name && a.color === b.color && a.collapsed === b.collapsed
    && a.projectPaths.length === b.projectPaths.length
    && a.projectPaths.every((path, index) => path === b.projectPaths[index])
  );
}

function sameGroups(a: readonly ProjectRailGroup[], b: readonly ProjectRailGroup[]): boolean {
  return a === b || (a.length === b.length && a.every((group, index) => sameGroup(group, b[index])));
}

/** Normalize the order for `groups` and keep unchanged references. */
function settle<P extends { path: string }>(
  layout: RailLayout<P>,
  projects: readonly P[],
  groups: ProjectRailGroup[],
): RailLayout<P> | null {
  const ordered = orderRailProjects(projects, groups);
  const sameOrder = ordered.length === layout.projects.length
    && ordered.every((project, index) => project === layout.projects[index]);
  const unchangedGroups = sameGroups(groups, layout.groups);
  if (sameOrder && unchangedGroups) return null;
  return {
    projects: sameOrder ? layout.projects : ordered,
    groups: unchangedGroups ? layout.groups : groups,
  };
}

/** Remove `path` from every group, then add it to `groupId` before `beforePath` (or last). */
function assignPath(
  groups: readonly ProjectRailGroup[],
  path: string,
  groupId: string | null,
  beforePath: string | null,
): ProjectRailGroup[] {
  return groups.flatMap((group) => {
    let projectPaths = group.projectPaths.filter((member) => member !== path);
    if (group.id === groupId) {
      const at = beforePath === null ? -1 : projectPaths.indexOf(beforePath);
      projectPaths = at < 0 ? [...projectPaths, path] : [...projectPaths.slice(0, at), path, ...projectPaths.slice(at)];
    }
    return projectPaths.length > 0 ? [{ ...group, projectPaths }] : [];
  });
}

function insertBefore<P extends { path: string }>(
  projects: readonly P[],
  moving: readonly P[],
  beforePath: string | null,
): P[] | null {
  const rest = projects.filter((project) => !moving.includes(project));
  const at = beforePath === null ? rest.length : rest.findIndex((project) => project.path === beforePath);
  if (at < 0) return null;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

function lastIndexIn<P extends { path: string }>(projects: readonly P[], group: ProjectRailGroup): number {
  return projects.reduce((last, project, index) => (group.projectPaths.includes(project.path) ? index : last), -1);
}

/**
 * Move an open project. `newGroup` names the group a merge creates; a merge
 * without it, or onto a project that is already grouped, joins instead.
 */
export function moveProjectInRail<P extends { path: string }>(
  layout: RailLayout<P>,
  path: string,
  target: RailDropTarget,
  newGroup?: NewRailGroup,
): RailLayout<P> | null {
  const ordered = orderRailProjects(layout.projects, layout.groups);
  const project = ordered.find((candidate) => candidate.path === path);
  if (!project) return null;

  if (target.type === 'merge') {
    if (target.targetPath === path) return null;
    const existing = railGroupForPath(layout.groups, target.targetPath);
    if (existing) return moveProjectInRail(layout, path, { type: 'join', groupId: existing.id });
    if (!newGroup) return null;
    const rest = ordered.filter((candidate) => candidate !== project);
    const targetIndex = rest.findIndex((candidate) => candidate.path === target.targetPath);
    if (targetIndex < 0) return null;
    const groups = [
      ...assignPath(layout.groups, path, null, null),
      { ...newGroup, projectPaths: [target.targetPath, path] },
    ];
    return settle(layout, [...rest.slice(0, targetIndex + 1), project, ...rest.slice(targetIndex + 1)], groups);
  }

  if (target.type === 'join') {
    const group = layout.groups.find((candidate) => candidate.id === target.groupId);
    if (!group || group.projectPaths.includes(path)) return null;
    const rest = ordered.filter((candidate) => candidate !== project);
    // After the group's last open member, or last when none of them is open.
    const last = lastIndexIn(rest, group);
    const at = last < 0 ? rest.length : last + 1;
    return settle(layout, [...rest.slice(0, at), project, ...rest.slice(at)], assignPath(layout.groups, path, group.id, null));
  }

  if (target.beforePath === path) return null;
  if (target.groupId !== null && !layout.groups.some((group) => group.id === target.groupId)) return null;
  const projects = insertBefore(ordered, [project], target.beforePath);
  if (!projects) return null;
  return settle(layout, projects, assignPath(layout.groups, path, target.groupId, target.beforePath));
}

/** Move a whole group before `beforePath` (null: the end). Groups never nest. */
export function moveGroupInRail<P extends { path: string }>(
  layout: RailLayout<P>,
  groupId: string,
  beforePath: string | null,
): RailLayout<P> | null {
  const group = layout.groups.find((candidate) => candidate.id === groupId);
  if (!group || (beforePath !== null && group.projectPaths.includes(beforePath))) return null;
  const ordered = orderRailProjects(layout.projects, layout.groups);
  const members = ordered.filter((project) => group.projectPaths.includes(project.path));
  if (members.length === 0) return null;
  const projects = insertBefore(ordered, members, beforePath);
  return projects ? settle(layout, projects, layout.groups) : null;
}

/** Take a project out of its group; it lands right below the group. */
export function removeProjectFromRailGroup<P extends { path: string }>(
  layout: RailLayout<P>,
  path: string,
): RailLayout<P> | null {
  const group = railGroupForPath(layout.groups, path);
  if (!group) return null;
  const ordered = orderRailProjects(layout.projects, layout.groups);
  const index = ordered.findIndex((project) => project.path === path);
  if (index < 0) return null;
  const rest = ordered.filter((project) => project.path !== path);
  const last = lastIndexIn(rest, group);
  // Without another open member the project keeps its place.
  const beforePath = last < 0 ? ordered[index + 1]?.path ?? null : rest[last + 1]?.path ?? null;
  return moveProjectInRail(layout, path, { type: 'insert', beforePath, groupId: null });
}

/** Make a group of open projects; it appears where the first of them is. */
export function createRailGroup<P extends { path: string }>(
  layout: RailLayout<P>,
  paths: readonly string[],
  newGroup: NewRailGroup,
): RailLayout<P> | null {
  const ordered = orderRailProjects(layout.projects, layout.groups);
  const members = ordered.filter((project) => paths.includes(project.path));
  if (members.length === 0) return null;
  const memberPaths = members.map((project) => project.path);
  const first = ordered.indexOf(members[0]);
  const rest = ordered.filter((project) => !members.includes(project));
  const groups = [
    ...layout.groups.flatMap((group) => {
      const projectPaths = group.projectPaths.filter((path) => !memberPaths.includes(path));
      return projectPaths.length > 0 ? [{ ...group, projectPaths }] : [];
    }),
    { ...newGroup, projectPaths: memberPaths },
  ];
  return settle(layout, [...rest.slice(0, first), ...members, ...rest.slice(first)], groups);
}

/** Remove a group; its open projects stay where they are. */
export function dissolveRailGroup<P extends { path: string }>(
  layout: RailLayout<P>,
  groupId: string,
): RailLayout<P> | null {
  if (!layout.groups.some((group) => group.id === groupId)) return null;
  return settle(
    layout,
    orderRailProjects(layout.projects, layout.groups),
    layout.groups.filter((group) => group.id !== groupId),
  );
}

/** Sort top-level entries by name, and each group's projects within it. */
export function sortRail<P extends { path: string; name: string }>(layout: RailLayout<P>): RailLayout<P> | null {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);
  const projects = buildRailEntries(layout.projects, layout.groups)
    .map((entry) => (entry.kind === 'project'
      ? { name: entry.project.name, projects: [entry.project] }
      : { name: entry.group.name, projects: [...entry.projects].sort(byName) }))
    .sort(byName)
    .flatMap((entry) => entry.projects);
  return settle(layout, projects, layout.groups);
}

export interface RailGroupPatch {
  name?: string;
  /** null removes the color. */
  color?: string | null;
  collapsed?: boolean;
}

export function updateRailGroup(
  groups: readonly ProjectRailGroup[],
  groupId: string,
  patch: RailGroupPatch,
): ProjectRailGroup[] | null {
  const group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return null;
  const next: ProjectRailGroup = {
    ...group,
    ...(patch.name !== undefined ? { name: patch.name.trim() || DEFAULT_PROJECT_RAIL_GROUP_NAME } : {}),
    ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed } : {}),
  };
  if (patch.color === null) delete next.color;
  else if (patch.color !== undefined) next.color = patch.color;
  if (sameGroup(group, next)) return null;
  return groups.map((candidate) => (candidate === group ? next : candidate));
}

/**
 * Where "Move up" / "Move down" sends a project or group, or null at an edge.
 * A grouped project moves within its group; top-level entries step past
 * whole groups.
 */
export function railStepTarget<P extends { path: string }>(
  entries: readonly RailEntry<P>[],
  item: RailDragItem,
  direction: -1 | 1,
): RailDropTarget | null {
  const index = entries.findIndex((entry) => (item.kind === 'group'
    ? entry.kind === 'group' && entry.group.id === item.groupId
    : entry.kind === 'project' ? entry.project.path === item.path : entry.projects.some((project) => project.path === item.path)));
  const entry = entries[index];
  if (!entry) return null;

  if (item.kind === 'group' || entry.kind === 'project') {
    if (direction === -1) {
      return index === 0 ? null : { type: 'insert', beforePath: railEntryFirstPath(entries[index - 1]), groupId: null };
    }
    return index === entries.length - 1 ? null : { type: 'insert', beforePath: railEntryFirstPath(entries[index + 2]), groupId: null };
  }

  const members = entry.projects;
  const at = members.findIndex((project) => project.path === item.path);
  if (direction === -1) {
    return at === 0 ? null : { type: 'insert', beforePath: members[at - 1].path, groupId: entry.group.id };
  }
  if (at === members.length - 1) return null;
  return {
    type: 'insert',
    beforePath: members[at + 2]?.path ?? railEntryFirstPath(entries[index + 1]),
    groupId: entry.group.id,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const railGroupsSettingAtom = settingAtom('projects.railGroups');

/**
 * The value written locally while its settings write is in flight. Settings
 * writes are server-authoritative (the stored atom only changes when main
 * broadcasts), so without this a rail edit that moves a project and changes
 * its group in one step would render the two halves a frame apart.
 */
const pendingRailGroupsAtom = atom<{ groups: ProjectRailGroup[]; writes: number } | null>(null);

/**
 * Equal content keeps the previous array, so a write settling into the
 * stored value, or the broadcast echo of this window's own write, does not
 * re-render the rail.
 */
const railGroupsAtom = selectAtom(
  atom((get) => normalizeRailGroups(get(pendingRailGroupsAtom)?.groups ?? get(railGroupsSettingAtom))),
  (groups) => groups,
  sameGroups,
);

/**
 * Groups as this window should render them. Writes persist through the
 * settings service, which broadcasts to every window; this window shows its
 * own value until the write settles and the stored value takes over.
 */
export const projectRailGroupsAtom = atom(
  (get) => get(railGroupsAtom),
  (get, set, next: ProjectRailGroup[]) => {
    const groups = normalizeRailGroups(next);
    set(pendingRailGroupsAtom, { groups, writes: (get(pendingRailGroupsAtom)?.writes ?? 0) + 1 });
    const settled = () => {
      const pending = get(pendingRailGroupsAtom);
      if (!pending) return;
      set(pendingRailGroupsAtom, pending.writes > 1 ? { ...pending, writes: pending.writes - 1 } : null);
    };
    Promise.resolve(set(railGroupsSettingAtom, groups)).then(settled, (error: unknown) => {
      console.error('[projectRailGroups] Failed to persist rail groups:', error);
      settled();
    });
  },
);
