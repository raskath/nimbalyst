// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { hydrateSettingsAtoms } from '../settingAtomFamily';
import {
  buildRailEntries,
  createRailGroup,
  dissolveRailGroup,
  moveGroupInRail,
  moveProjectInRail,
  nextRailGroupColor,
  normalizeRailGroups,
  orderRailProjects,
  PROJECT_RAIL_GROUP_COLORS,
  projectRailGroupsAtom,
  railStepTarget,
  removeProjectFromRailGroup,
  sortRail,
  updateRailGroup,
  type ProjectRailGroup,
  type RailLayout,
} from '../projectRailGroups';

interface P { path: string; name: string }

const project = (name: string): P => ({ path: `/ws/${name}`, name });
const group = (id: string, names: string[], extra: Partial<ProjectRailGroup> = {}): ProjectRailGroup =>
  ({ id, name: id, collapsed: false, projectPaths: names.map((name) => `/ws/${name}`), ...extra });
const names = (layout: RailLayout<P> | null) => layout?.projects.map((p) => p.name);
const members = (layout: RailLayout<P> | null, id: string) =>
  layout?.groups.find((g) => g.id === id)?.projectPaths.map((path) => path.slice('/ws/'.length));
const NEW_GROUP = { id: 'new', name: 'New group', collapsed: false };

function layout(projectNames: string[], groups: ProjectRailGroup[] = []): RailLayout<P> {
  return { projects: projectNames.map(project), groups };
}

describe('rail derivation', () => {
  it('places a group at its first open member and skips closed members', () => {
    const groups = [group('g', ['b', 'closed', 'd'])];
    const entries = buildRailEntries(['a', 'b', 'c', 'd'].map(project), groups);
    expect(entries.map((entry) => (entry.kind === 'project' ? entry.project.name : `${entry.group.id}:${entry.projects.map((p) => p.name).join(',')}`)))
      .toEqual(['a', 'g:b,d', 'c']);
    expect(orderRailProjects(['a', 'b', 'c', 'd'].map(project), groups).map((p) => p.name)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('normalizes duplicate ids and paths so no project renders twice', () => {
    const kept = group('x', ['c']);
    const normalized = normalizeRailGroups([group('g', ['a', 'b']), group('g', ['c']), group('h', ['b']), kept, group('empty', [])]);
    expect(normalized.map((g) => g.id)).toEqual(['g', 'x']);
    expect(normalized[1]).toBe(kept);
  });

  it('assigns unused palette colors first, then cycles', () => {
    expect(nextRailGroupColor([group('g', ['a'], { color: PROJECT_RAIL_GROUP_COLORS[0].value })])).toBe(PROJECT_RAIL_GROUP_COLORS[1].value);
    const all = PROJECT_RAIL_GROUP_COLORS.map((color, i) => group(`g${i}`, [`p${i}`], { color: color.value }));
    expect(nextRailGroupColor(all)).toBe(PROJECT_RAIL_GROUP_COLORS[0].value);
  });
});

describe('moving projects', () => {
  const base = () => layout(['a', 'b', 'c', 'd'], [group('g', ['b', 'c'])]);

  it('inserts into a group, leaves it for the top level, and lands at a group end', () => {
    const into = moveProjectInRail(base(), '/ws/d', { type: 'insert', beforePath: '/ws/c', groupId: 'g' });
    expect(names(into)).toEqual(['a', 'b', 'd', 'c']);
    expect(members(into, 'g')).toEqual(['b', 'd', 'c']);

    const out = moveProjectInRail(base(), '/ws/c', { type: 'insert', beforePath: '/ws/b', groupId: null });
    expect(names(out)).toEqual(['a', 'c', 'b', 'd']);
    expect(members(out, 'g')).toEqual(['b']);

    const end = moveProjectInRail(base(), '/ws/a', { type: 'insert', beforePath: '/ws/d', groupId: 'g' });
    expect(names(end)).toEqual(['b', 'c', 'a', 'd']);
    expect(members(end, 'g')).toEqual(['b', 'c', 'a']);
  });

  it('returns null for drops that change nothing or name missing items', () => {
    const start = base();
    for (const target of [
      { type: 'insert', beforePath: '/ws/d', groupId: 'g' },
      { type: 'insert', beforePath: '/ws/c', groupId: null },
      { type: 'insert', beforePath: '/ws/missing', groupId: null },
      { type: 'insert', beforePath: '/ws/a', groupId: 'missing' },
      { type: 'join', groupId: 'g' },
      { type: 'merge', targetPath: '/ws/c' },
    ] as const) {
      expect(moveProjectInRail(start, target.type === 'join' ? '/ws/b' : '/ws/c', target, NEW_GROUP)).toBeNull();
    }
    expect(moveProjectInRail(start, '/ws/missing', { type: 'insert', beforePath: null, groupId: null })).toBeNull();
  });

  it('merges two projects into a new group and drops a group its last member leaves', () => {
    const start = layout(['a', 'b', 'c'], [group('g', ['c'])]);
    const merged = moveProjectInRail(start, '/ws/c', { type: 'merge', targetPath: '/ws/a' }, NEW_GROUP);
    expect(names(merged)).toEqual(['a', 'c', 'b']);
    expect(merged?.groups.map((g) => g.id)).toEqual(['new']);
    expect(members(merged, 'new')).toEqual(['a', 'c']);
    // Merging onto a grouped project joins its group instead.
    const joined = moveProjectInRail(base(), '/ws/a', { type: 'merge', targetPath: '/ws/c' }, NEW_GROUP);
    expect(members(joined, 'g')).toEqual(['b', 'c', 'a']);
    expect(joined?.groups).toHaveLength(1);
  });

  it('joins after the last open member, or at the end for a group with no open member', () => {
    const start = layout(['a', 'b', 'c', 'd'], [group('g', ['a', 'b', 'gone']), group('hidden', ['closed'])]);
    const joined = moveProjectInRail(start, '/ws/d', { type: 'join', groupId: 'g' });
    expect(names(joined)).toEqual(['a', 'b', 'd', 'c']);
    expect(members(joined, 'g')).toEqual(['a', 'b', 'gone', 'd']);
    const revived = moveProjectInRail(start, '/ws/a', { type: 'join', groupId: 'hidden' });
    expect(names(revived)).toEqual(['b', 'c', 'd', 'a']);
    expect(members(revived, 'hidden')).toEqual(['closed', 'a']);
  });

  it('removes a project to just below its group and keeps remembered members', () => {
    const start = layout(['a', 'b', 'c', 'd'], [group('g', ['a', 'b', 'closed'])]);
    const removed = removeProjectFromRailGroup(start, '/ws/a');
    expect(names(removed)).toEqual(['b', 'a', 'c', 'd']);
    expect(members(removed, 'g')).toEqual(['b', 'closed']);
    const lastOpen = removeProjectFromRailGroup(layout(['x', 'a', 'y'], [group('g', ['a', 'closed'])]), '/ws/a');
    expect(names(lastOpen)).toEqual(['x', 'a', 'y']);
    expect(members(lastOpen, 'g')).toEqual(['closed']);
    expect(removeProjectFromRailGroup(start, '/ws/c')).toBeNull();
  });
});

describe('group operations', () => {
  it('moves a whole group and refuses to drop it inside itself', () => {
    const start = layout(['a', 'b', 'c', 'd'], [group('g', ['c', 'd'])]);
    expect(names(moveGroupInRail(start, 'g', '/ws/a'))).toEqual(['c', 'd', 'a', 'b']);
    expect(moveGroupInRail(start, 'g', '/ws/d')).toBeNull();
    expect(moveGroupInRail(start, 'g', null)).toBeNull();
    expect(names(moveGroupInRail(layout(['c', 'd', 'a'], [group('g', ['c', 'd'])]), 'g', null))).toEqual(['a', 'c', 'd']);
  });

  it('creates a group where its first member is, taking members from other groups', () => {
    const start = layout(['a', 'b', 'c'], [group('g', ['a', 'b'])]);
    const created = createRailGroup(start, ['/ws/c'], NEW_GROUP);
    expect(members(created, 'new')).toEqual(['c']);
    const moved = createRailGroup(start, ['/ws/a'], NEW_GROUP);
    expect(buildRailEntries(moved!.projects, moved!.groups).map((entry) => (entry.kind === 'group' ? entry.group.id : entry.project.name)))
      .toEqual(['new', 'g', 'c']);
    expect(members(moved, 'g')).toEqual(['b']);
    expect(createRailGroup(start, ['/ws/closed'], NEW_GROUP)).toBeNull();
  });

  it('dissolves a group without moving its projects', () => {
    const start = layout(['a', 'c', 'b'], [group('g', ['a', 'b'])]);
    const dissolved = dissolveRailGroup(start, 'g');
    expect(names(dissolved)).toEqual(['a', 'b', 'c']);
    expect(dissolved?.groups).toEqual([]);
    expect(dissolveRailGroup(start, 'missing')).toBeNull();
  });

  it('sorts entries and group members by name, and is idempotent', () => {
    const start = layout(['zeta', 'beta', 'alpha', 'Mid'], [group('Kunde', ['beta', 'alpha'])]);
    const sorted = sortRail(start);
    expect(names(sorted)).toEqual(['alpha', 'beta', 'Mid', 'zeta']);
    expect(sortRail(sorted!)).toBeNull();
  });

  it('renames, recolors and collapses, returning null for no-ops', () => {
    const groups = [group('g', ['a'], { color: '#3b82f6' })];
    expect(updateRailGroup(groups, 'g', { name: '  Kunde A ' })?.[0].name).toBe('Kunde A');
    expect(updateRailGroup(groups, 'g', { name: '   ' })?.[0].name).toBe('New group');
    expect(updateRailGroup(groups, 'g', { color: null })?.[0]).not.toHaveProperty('color');
    expect(updateRailGroup(groups, 'g', { collapsed: true })?.[0].collapsed).toBe(true);
    expect(updateRailGroup(groups, 'g', { name: 'g', color: '#3b82f6', collapsed: false })).toBeNull();
    expect(updateRailGroup(groups, 'missing', { collapsed: true })).toBeNull();
  });

  it('steps top-level entries past whole groups and grouped projects within their group', () => {
    const entries = buildRailEntries(['a', 'b', 'c', 'd'].map(project), [group('g', ['b', 'c'])]);
    expect(railStepTarget(entries, { kind: 'project', path: '/ws/a' }, -1)).toBeNull();
    expect(railStepTarget(entries, { kind: 'project', path: '/ws/a' }, 1)).toEqual({ type: 'insert', beforePath: '/ws/d', groupId: null });
    expect(railStepTarget(entries, { kind: 'project', path: '/ws/d' }, -1)).toEqual({ type: 'insert', beforePath: '/ws/b', groupId: null });
    expect(railStepTarget(entries, { kind: 'group', groupId: 'g' }, 1)).toEqual({ type: 'insert', beforePath: null, groupId: null });
    expect(railStepTarget(entries, { kind: 'project', path: '/ws/b' }, -1)).toBeNull();
    expect(railStepTarget(entries, { kind: 'project', path: '/ws/b' }, 1)).toEqual({ type: 'insert', beforePath: '/ws/d', groupId: 'g' });
    expect(railStepTarget(entries, { kind: 'project', path: '/ws/c' }, -1)).toEqual({ type: 'insert', beforePath: '/ws/b', groupId: 'g' });
    expect(railStepTarget(entries, { kind: 'project', path: '/ws/c' }, 1)).toBeNull();
  });
});

describe('projectRailGroupsAtom', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    hydrateSettingsAtoms({ 'projects.railGroups': [] });
  });

  it('shows a write at once and keeps the stored value the broadcast delivers', async () => {
    let finish!: () => void;
    const settingsSet = vi.fn((key: string, value: unknown) => new Promise<void>((resolve) => {
      finish = () => { hydrateSettingsAtoms({ [key]: value }); resolve(); };
    }));
    vi.stubGlobal('window', { electronAPI: { settingsSet } });
    const next = [group('g', ['a'])];
    store.set(projectRailGroupsAtom, next);
    expect(store.get(projectRailGroupsAtom)).toEqual(next);
    expect(settingsSet).toHaveBeenCalledWith('projects.railGroups', next);
    // Another window writing meanwhile does not override the pending local edit.
    hydrateSettingsAtoms({ 'projects.railGroups': [group('other', ['z'])] });
    expect(store.get(projectRailGroupsAtom)).toEqual(next);
    finish();
    await vi.waitFor(() => expect(store.get(projectRailGroupsAtom)).toEqual(next));
  });

  it('falls back to the stored groups when the write is refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('window', { electronAPI: { settingsSet: vi.fn().mockRejectedValue(new Error('invalid')) } });
    const stored = [group('stored', ['a'])];
    hydrateSettingsAtoms({ 'projects.railGroups': stored });
    store.set(projectRailGroupsAtom, [group('g', ['b'])]);
    await vi.waitFor(() => expect(store.get(projectRailGroupsAtom)).toEqual(stored));
    expect(error).toHaveBeenCalled();
  });
});
