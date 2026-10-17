// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import {
  openProjectsAtom,
  allowUnlimitedProjectsAtom,
  activeWorkspacePathAtom,
  activeOpenProjectAtom,
  addOpenProjectAtom,
  closeOpenProjectAtom,
  closeOpenProjectsAtom,
  createRailGroupAtom,
  dissolveRailGroupAtom,
  dropOnRailAtom,
  moveOpenProjectAtom,
  projectRailEntriesAtom,
  railOrderedProjectsAtom,
  setOpenProjectGroupAtom,
  sortOpenProjectsAtom,
  stepRailItemAtom,
  updateRailGroupAtom,
  isOpenProjectsAtCapAtom,
  attachWorkspaceSwitchCleanup,
  resolveInitialOpenProjectsState,
  selectProjectsToRegister,
  type OpenProject,
} from '../openProjects';
import { PROJECT_RAIL_GROUP_COLORS, projectRailGroupsAtom } from '../projectRailGroups';
import { activeSessionIdAtom, selectedWorkstreamAtom } from '../sessions';

const MAX_OPEN_PROJECTS = 8;

function project(path: string, openedAt = 0): OpenProject {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  return { path, name, openedAt };
}

describe('openProjects atoms', () => {
  let jotaiStore: ReturnType<typeof createStore>;

  beforeEach(() => {
    jotaiStore = createStore();
  });

  describe('addOpenProjectAtom', () => {
    it('adds a new project and activates it', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));

      expect(jotaiStore.get(openProjectsAtom)).toEqual([project('/ws/a')]);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });

    it('appends in order for multiple distinct projects', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/c'));

      const open = jotaiStore.get(openProjectsAtom);
      expect(open.map((p) => p.path)).toEqual(['/ws/a', '/ws/b', '/ws/c']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/c');
    });

    it('dedups when path is already open and just activates it', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));

      const open = jotaiStore.get(openProjectsAtom);
      expect(open).toHaveLength(2);
      expect(open.map((p) => p.path)).toEqual(['/ws/a', '/ws/b']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });

    it('rejects new projects beyond the cap without altering active', () => {
      for (let i = 0; i < MAX_OPEN_PROJECTS; i++) {
        jotaiStore.set(addOpenProjectAtom, project(`/ws/${i}`));
      }
      expect(jotaiStore.get(openProjectsAtom)).toHaveLength(MAX_OPEN_PROJECTS);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe(`/ws/${MAX_OPEN_PROJECTS - 1}`);

      jotaiStore.set(addOpenProjectAtom, project('/ws/overflow'));

      expect(jotaiStore.get(openProjectsAtom)).toHaveLength(MAX_OPEN_PROJECTS);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe(`/ws/${MAX_OPEN_PROJECTS - 1}`);
    });
  });

  it('allows unlimited projects and preserves them when the default cap is restored', () => {
    jotaiStore.set(allowUnlimitedProjectsAtom, true);
    for (let i = 0; i < 16; i++) jotaiStore.set(addOpenProjectAtom, project(`/ws/${i}`));
    expect(jotaiStore.get(openProjectsAtom)).toHaveLength(16);
    expect(jotaiStore.get(isOpenProjectsAtCapAtom)).toBe(false);
    jotaiStore.set(allowUnlimitedProjectsAtom, false);
    expect(jotaiStore.get(isOpenProjectsAtCapAtom)).toBe(true);
    expect(jotaiStore.get(openProjectsAtom)).toHaveLength(16);
    jotaiStore.set(addOpenProjectAtom, project('/ws/0'));
    expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/0');
    jotaiStore.set(addOpenProjectAtom, project('/ws/extra'));
    expect(jotaiStore.get(openProjectsAtom)).toHaveLength(16);
    jotaiStore.set(allowUnlimitedProjectsAtom, true);
    for (let i = 16; i < 40; i++) jotaiStore.set(addOpenProjectAtom, project(`/ws/${i}`));
    expect(jotaiStore.get(openProjectsAtom)).toHaveLength(40);
    expect(jotaiStore.get(isOpenProjectsAtCapAtom)).toBe(false);
  });

  it.each([false, true])('restores all saved projects and the active project (live window: %s)', (live) => {
    const paths = Array.from({ length: 32 }, (_,i) => `/ws/${i}`);
    const result = resolveInitialOpenProjectsState({
      persistedPaths: [...paths, paths[0]], persistedActivePath: paths[31],
      restorePreviousProjects: true,
      windowState: { mode: 'workspace', workspacePath: paths[0],
        openProjectPaths: live ? [...paths, paths[0]] : [paths[0]],
        activeWorkspacePath: live ? paths[31] : paths[0] },
    });
    expect(result).toEqual({ paths, activePath: paths[31] });
    expect(selectProjectsToRegister(result.paths, paths[0])).toHaveLength(31);
  });

  it('moves projects in either direction without switching or recreating them', () => {
    const projects = ['/ws/a', '/ws/b', '/ws/c'].map(path => project(path));
    jotaiStore.set(openProjectsAtom, projects);
    jotaiStore.set(activeWorkspacePathAtom, '/ws/b');
    jotaiStore.set(moveOpenProjectAtom, { path: '/ws/c', beforePath: '/ws/a' });
    expect(jotaiStore.get(openProjectsAtom)).toEqual([projects[2], projects[0], projects[1]]);
    jotaiStore.set(moveOpenProjectAtom, { path: '/ws/c', beforePath: null });
    expect(jotaiStore.get(openProjectsAtom)).toEqual(projects);
    expect(jotaiStore.get(openProjectsAtom)[2]).toBe(projects[2]);
    expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/b');
  });

  it('ignores stale drag paths and drops that do not change the order', () => {
    const projects = ['/ws/a', '/ws/b'].map(path => project(path));
    jotaiStore.set(openProjectsAtom, projects);
    for (const move of [
      { path: '/ws/missing', beforePath: '/ws/a' },
      { path: '/ws/a', beforePath: '/ws/missing' },
      { path: '/ws/a', beforePath: '/ws/a' },
      { path: '/ws/a', beforePath: '/ws/b' },
      { path: '/ws/b', beforePath: null },
    ]) {
      jotaiStore.set(moveOpenProjectAtom, move);
      expect(jotaiStore.get(openProjectsAtom)).toBe(projects);
    }
  });

  it('sorts names naturally, preserves equal-name order, and keeps the active project', () => {
    const projects = ['/ws/Zebra', '/ws/Project 10', '/ws/Project 2', '/one/alpha', '/two/Alpha'].map(path => project(path));
    jotaiStore.set(openProjectsAtom, projects);
    jotaiStore.set(activeWorkspacePathAtom, '/ws/Project 10');
    jotaiStore.set(sortOpenProjectsAtom);
    expect(jotaiStore.get(openProjectsAtom)).toEqual([projects[3], projects[4], projects[2], projects[1], projects[0]]);
    expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/Project 10');
    const sorted = jotaiStore.get(openProjectsAtom);
    jotaiStore.set(sortOpenProjectsAtom);
    expect(jotaiStore.get(openProjectsAtom)).toBe(sorted);
    // Sorting is a one-time action; new projects still append.
    jotaiStore.set(addOpenProjectAtom, project('/ws/Aardvark'));
    expect(jotaiStore.get(openProjectsAtom).at(-1)?.path).toBe('/ws/Aardvark');
  });

  describe('rail groups', () => {
    const paths = (atom: typeof railOrderedProjectsAtom) => jotaiStore.get(atom).map((p) => p.path);

    beforeEach(() => {
      jotaiStore.set(openProjectsAtom, ['/ws/a', '/ws/b', '/ws/c', '/ws/d'].map((path) => project(path)));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
    });

    it('merges by drag into a colored group, names it, and keeps the active project', () => {
      const groupId = jotaiStore.set(dropOnRailAtom, { item: { kind: 'project', path: '/ws/d' }, target: { type: 'merge', targetPath: '/ws/b' } });
      expect(groupId).toEqual(expect.any(String));
      expect(jotaiStore.get(projectRailGroupsAtom)).toEqual([
        { id: groupId, name: 'New group', color: PROJECT_RAIL_GROUP_COLORS[0].value, collapsed: false, projectPaths: ['/ws/b', '/ws/d'] },
      ]);
      expect(paths(railOrderedProjectsAtom)).toEqual(['/ws/a', '/ws/b', '/ws/d', '/ws/c']);
      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/a', '/ws/b', '/ws/d', '/ws/c']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');

      jotaiStore.set(updateRailGroupAtom, { groupId: groupId!, patch: { name: 'Kunde A', collapsed: true } });
      const [entry] = jotaiStore.get(projectRailEntriesAtom).filter((e) => e.kind === 'group');
      expect(entry).toMatchObject({ group: { name: 'Kunde A', collapsed: true } });
      // A drop that changes nothing creates no group and writes nothing.
      const before = jotaiStore.get(openProjectsAtom);
      expect(jotaiStore.set(dropOnRailAtom, { item: { kind: 'project', path: '/ws/a' }, target: { type: 'merge', targetPath: '/ws/a' } })).toBeNull();
      expect(jotaiStore.get(openProjectsAtom)).toBe(before);
    });

    it('rejoins a remembered group when a closed project is reopened', () => {
      jotaiStore.set(createRailGroupAtom, { paths: ['/ws/a', '/ws/b'], name: 'Kunde' });
      jotaiStore.set(closeOpenProjectAtom, '/ws/a');
      expect(jotaiStore.get(projectRailGroupsAtom)[0].projectPaths).toEqual(['/ws/a', '/ws/b']);
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      expect(paths(railOrderedProjectsAtom)).toEqual(['/ws/b', '/ws/a', '/ws/c', '/ws/d']);
    });

    it('closes a whole group and activates the nearest project outside it', () => {
      const groupId = jotaiStore.set(createRailGroupAtom, { paths: ['/ws/b', '/ws/c'] })!;
      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');
      jotaiStore.set(closeOpenProjectsAtom, ['/ws/b', '/ws/c']);
      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/a', '/ws/d']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/d');
      expect(jotaiStore.get(projectRailGroupsAtom).map((g) => g.id)).toEqual([groupId]);
    });

    it('moves, steps, ungroups and dissolves through the rail actions', () => {
      const groupId = jotaiStore.set(createRailGroupAtom, { paths: ['/ws/c', '/ws/d'], color: null })!;
      expect(jotaiStore.get(projectRailGroupsAtom)[0]).not.toHaveProperty('color');
      jotaiStore.set(dropOnRailAtom, { item: { kind: 'group', groupId }, target: { type: 'insert', beforePath: '/ws/a', groupId: null } });
      expect(paths(railOrderedProjectsAtom)).toEqual(['/ws/c', '/ws/d', '/ws/a', '/ws/b']);
      jotaiStore.set(stepRailItemAtom, { item: { kind: 'project', path: '/ws/d' }, direction: -1 });
      expect(paths(railOrderedProjectsAtom)).toEqual(['/ws/d', '/ws/c', '/ws/a', '/ws/b']);
      jotaiStore.set(moveOpenProjectAtom, { path: '/ws/b', beforePath: '/ws/c', groupId });
      expect(jotaiStore.get(projectRailGroupsAtom)[0].projectPaths).toEqual(['/ws/d', '/ws/b', '/ws/c']);
      jotaiStore.set(setOpenProjectGroupAtom, { path: '/ws/d', groupId: null });
      expect(paths(railOrderedProjectsAtom)).toEqual(['/ws/b', '/ws/c', '/ws/d', '/ws/a']);
      jotaiStore.set(setOpenProjectGroupAtom, { path: '/ws/a', groupId });
      expect(jotaiStore.get(projectRailGroupsAtom)[0].projectPaths).toEqual(['/ws/b', '/ws/c', '/ws/a']);
      jotaiStore.set(sortOpenProjectsAtom);
      expect(paths(railOrderedProjectsAtom)).toEqual(['/ws/d', '/ws/a', '/ws/b', '/ws/c']);
      jotaiStore.set(dissolveRailGroupAtom, groupId);
      expect(jotaiStore.get(projectRailGroupsAtom)).toEqual([]);
      expect(paths(railOrderedProjectsAtom)).toEqual(['/ws/d', '/ws/a', '/ws/b', '/ws/c']);
    });
  });

  describe('closeOpenProjectAtom', () => {
    it('removes the project from the list', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));

      jotaiStore.set(closeOpenProjectAtom, '/ws/a');

      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/b']);
    });

    it('promotes the next project when closing the active one', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/c'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');

      jotaiStore.set(closeOpenProjectAtom, '/ws/b');

      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/c');
    });

    it('falls back to the previous project when closing the last one', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/c'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/c');

      jotaiStore.set(closeOpenProjectAtom, '/ws/c');

      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/b');
    });

    it('clears active when the last open project is closed', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/only'));

      jotaiStore.set(closeOpenProjectAtom, '/ws/only');

      expect(jotaiStore.get(openProjectsAtom)).toHaveLength(0);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBeNull();
    });

    it('leaves active untouched when closing an inactive project', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');

      jotaiStore.set(closeOpenProjectAtom, '/ws/b');

      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });

    it('is a no-op when path is not in the rail', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(closeOpenProjectAtom, '/ws/missing');

      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/a']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });
  });

  describe('derived atoms', () => {
    it('isOpenProjectsAtCapAtom flips at the cap', () => {
      expect(jotaiStore.get(isOpenProjectsAtCapAtom)).toBe(false);
      for (let i = 0; i < MAX_OPEN_PROJECTS - 1; i++) {
        jotaiStore.set(addOpenProjectAtom, project(`/ws/${i}`));
      }
      expect(jotaiStore.get(isOpenProjectsAtCapAtom)).toBe(false);

      jotaiStore.set(addOpenProjectAtom, project(`/ws/${MAX_OPEN_PROJECTS - 1}`));
      expect(jotaiStore.get(isOpenProjectsAtCapAtom)).toBe(true);
    });

    it('activeOpenProjectAtom returns null with no active path', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(activeWorkspacePathAtom, null);

      expect(jotaiStore.get(activeOpenProjectAtom)).toBeNull();
    });

    it('activeOpenProjectAtom returns the matching project for the active path', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');

      expect(jotaiStore.get(activeOpenProjectAtom)?.path).toBe('/ws/b');
    });

    it('activeOpenProjectAtom returns null when active path is not in the rail', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/zombie');

      expect(jotaiStore.get(activeOpenProjectAtom)).toBeNull();
    });
  });

  describe('attachWorkspaceSwitchCleanup', () => {
    // Regression: prior to the multi-project rail fix, switching the rail
    // to a workspace whose `selectedWorkstreamAtom` was null left
    // `activeSessionIdAtom` pointing at the previous workspace's session.
    // The renderer then sent that stale id to `ai:sendMessage` against
    // the new workspace's path and SessionManager rejected it as
    // "Session ... not found". The subscriber synchronously rewrites
    // the global atom to the new workspace's selection (or null if no
    // selection), which closes the transient-null window AgentMode's
    // mount effect would otherwise leave open.
    it('clears activeSessionIdAtom when flipping to a workspace with no selection', () => {
      const unsub = attachWorkspaceSwitchCleanup(jotaiStore);

      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
      jotaiStore.set(activeSessionIdAtom, 'session-from-a');
      expect(jotaiStore.get(activeSessionIdAtom)).toBe('session-from-a');

      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');
      expect(jotaiStore.get(activeSessionIdAtom)).toBeNull();

      unsub();
    });

    it('also clears when activeWorkspacePathAtom flips back to null', () => {
      const unsub = attachWorkspaceSwitchCleanup(jotaiStore);

      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
      jotaiStore.set(activeSessionIdAtom, 'session-from-a');

      jotaiStore.set(activeWorkspacePathAtom, null);
      expect(jotaiStore.get(activeSessionIdAtom)).toBeNull();

      unsub();
    });

    it('repopulates activeSessionIdAtom from the new workspace selection synchronously', () => {
      // Pre-seed /ws/b's selection BEFORE attaching so the subscriber sees
      // a non-empty selectedWorkstreamAtom on the flip.
      jotaiStore.set(selectedWorkstreamAtom('/ws/b'), { type: 'session', id: 'session-b-root' });

      const unsub = attachWorkspaceSwitchCleanup(jotaiStore);
      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
      jotaiStore.set(activeSessionIdAtom, 'session-from-a');

      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');
      // Synchronous after the subscriber fires — no React or AgentMode
      // effect required.
      expect(jotaiStore.get(activeSessionIdAtom)).toBe('session-b-root');

      unsub();
    });

    // Note: the active-child priority branch
    // (`workstreamActiveChildAtom(selection.id) || selection.id`) is not
    // unit-tested here because writing to the workstream state requires
    // the IPC-bootstrapped `initWorkstreamState`. The branch is exercised
    // via AgentMode's existing integration coverage.

    it('stops updating once the returned unsubscribe is invoked', () => {
      const unsub = attachWorkspaceSwitchCleanup(jotaiStore);
      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
      jotaiStore.set(activeSessionIdAtom, 'session-from-a');

      unsub();
      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');

      expect(jotaiStore.get(activeSessionIdAtom)).toBe('session-from-a');
    });
  });

  describe('resolveInitialOpenProjectsState', () => {
    it('prefers the live window rail state during a renderer reload', () => {
      const result = resolveInitialOpenProjectsState({
        persistedPaths: ['/ws/a', '/ws/b'],
        persistedActivePath: '/ws/b',
        restorePreviousProjects: false,
        windowState: {
          mode: 'workspace',
          workspacePath: '/ws/a',
          activeWorkspacePath: '/ws/b',
          openProjectPaths: ['/ws/a', '/ws/b'],
        },
      });

      expect(result).toEqual({
        paths: ['/ws/a', '/ws/b'],
        activePath: '/ws/b',
      });
    });

    it('uses persisted state on launch when restore previous projects is enabled', () => {
      const result = resolveInitialOpenProjectsState({
        persistedPaths: ['/ws/a', '/ws/b'],
        persistedActivePath: '/ws/b',
        restorePreviousProjects: true,
        windowState: {
          mode: 'workspace',
          workspacePath: '/ws/a',
          activeWorkspacePath: '/ws/a',
          openProjectPaths: ['/ws/a'],
        },
      });

      expect(result).toEqual({
        paths: ['/ws/a', '/ws/b'],
        activePath: '/ws/b',
      });
    });

    it('falls back to the current window workspace when restore previous projects is off', () => {
      const result = resolveInitialOpenProjectsState({
        persistedPaths: ['/ws/a', '/ws/b'],
        persistedActivePath: '/ws/b',
        restorePreviousProjects: false,
        windowState: {
          mode: 'workspace',
          workspacePath: '/ws/a',
          activeWorkspacePath: '/ws/a',
          openProjectPaths: ['/ws/a'],
        },
      });

      expect(result).toEqual({
        paths: ['/ws/a'],
        activePath: '/ws/a',
      });
    });
  });

  // NIM-757 (#548): restored non-primary rail projects must be registered with
  // the main process so a later rail click can rescope the (path-less) Trackers
  // panel. The primary is already registered at bootstrap.
  describe('selectProjectsToRegister', () => {
    it('returns the non-primary restored projects', () => {
      expect(selectProjectsToRegister(['/ws/a', '/ws/b', '/ws/c'], '/ws/a')).toEqual([
        '/ws/b',
        '/ws/c',
      ]);
    });

    it('returns nothing for a single-project (primary-only) rail', () => {
      expect(selectProjectsToRegister(['/ws/a'], '/ws/a')).toEqual([]);
    });

    it('dedups and registers all when the primary is unknown', () => {
      expect(selectProjectsToRegister(['/ws/a', '/ws/a', '/ws/b'], undefined)).toEqual([
        '/ws/a',
        '/ws/b',
      ]);
    });
  });
});
