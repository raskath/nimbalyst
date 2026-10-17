import React from 'react';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { openSettingsCommandAtom } from '../../store/atoms/settingsNavigation';
import { projectAppearanceAtom } from '../../store/atoms/projectAppearance';
import { ProjectRail } from '../ProjectRail';
import { activeWorkspacePathAtom, multiProjectModeAtom, openProjectsAtom } from '../../store/atoms/openProjects';
import { projectRailGroupsAtom, type ProjectRailGroup } from '../../store/atoms/projectRailGroups';
import { globalSessionActivityAtom } from '../../store/atoms/sessionActivity';
import { railDropTargetAt, type RailHitSlot } from '../hooks/useProjectRailDrag';

const importImageThumbnail = vi.hoisted(() => vi.fn());
vi.mock('@nimbalyst/runtime', () => ({ getShowInFileBrowserLabel: () => 'Show in Finder' }));
// jsdom has no canvas; the E2E spec covers the real image pipeline.
vi.mock('../../utils/imageThumbnail', () => ({ importImageThumbnail }));
vi.mock('../OrgSwitcher', () => ({ OrgSwitcher: () => null }));
vi.mock('../WorkspaceSummaryHeader', () => ({ generateWorkspaceAccentColor: () => '#123456' }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reveals restored and newly selected projects, handles resize, and leaves manual scrolling alone', () => {
  const store = createStore();
  const projects = Array.from({ length: 32 }, (_, i) => ({ path: `/p/${i}`, name: `Project ${i}`, openedAt: i }));
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, projects);
  store.set(activeWorkspacePathAtom, projects[31].path);
  let height = 400;
  let resized = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.classList.contains('project-rail-projects')) return { top: 100, bottom: 100 + height } as DOMRect;
    if (this.classList.contains('project-rail-item')) {
      const index = Number(this.dataset.projectPath!.split('/').pop());
      const list = this.closest('.project-rail-projects')!;
      const top = 104 + index * 48 - list.scrollTop;
      return { top, bottom: top + 40 } as DOMRect;
    }
    return { top: 0, bottom: 0 } as DOMRect;
  });
  const tree = <Provider store={store}><ProjectRail /></Provider>;
  const view = render(tree);
  const list = view.getByTestId('project-rail-projects');
  const visible = (index: number) => {
    const item = view.getByRole('button', { name: `Switch to project Project ${index}` }).parentElement!;
    expect(item.getBoundingClientRect().top).toBeGreaterThanOrEqual(100);
    expect(item.getBoundingClientRect().bottom).toBeLessThanOrEqual(100 + height);
  };
  visible(31);
  act(() => store.set(activeWorkspacePathAtom, projects[0].path));
  visible(0);
  act(() => store.set(activeWorkspacePathAtom, projects[31].path));
  visible(31);
  act(() => { height = 200; resized(); });
  visible(31);
  list.scrollTop = 0; // Browsing other projects must not snap back to the selection.
  view.rerender(<Provider store={store}><ProjectRail /></Provider>);
  expect(list.scrollTop).toBe(0);
  view.unmount();
  expect(disconnect).toHaveBeenCalled();
});


it('moves and sorts from the keyboard menu without activating the targeted project', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const store = createStore();
  const projects = ['Zebra', 'Alpha', 'Beta'].map(name => ({ path: `/p/${name}`, name, openedAt: 0 }));
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, projects);
  store.set(activeWorkspacePathAtom, projects[0].path);
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  const alpha = view.getByRole('button', { name: 'Switch to project Alpha' });
  alpha.focus();
  fireEvent.keyDown(alpha, { key: 'F10', shiftKey: true });
  const up = await view.findByRole('menuitem', { name: 'Move up' });
  await waitFor(() => expect(document.activeElement).toBe(up));
  fireEvent.click(up);
  expect(store.get(openProjectsAtom).map(p => p.name)).toEqual(['Alpha', 'Zebra', 'Beta']);
  expect(store.get(activeWorkspacePathAtom)).toBe(projects[0].path);
  await waitFor(() => expect(document.activeElement).toBe(alpha));
  fireEvent.keyDown(alpha, { key: 'ContextMenu' });
  expect((await view.findByRole('menuitem', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view.getByRole('menuitem', { name: 'Move down' }));
  expect(store.get(openProjectsAtom).map(p => p.name)).toEqual(['Zebra', 'Alpha', 'Beta']);
  fireEvent.contextMenu(alpha, { clientX: 40, clientY: 100 });
  const down = await view.findByRole('menuitem', { name: 'Move down' });
  down.focus();
  fireEvent.keyDown(down, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(view.getByRole('menuitem', { name: 'Sort by name' }));
  fireEvent.click(view.getByRole('menuitem', { name: 'Sort by name' }));
  expect(store.get(openProjectsAtom).map(p => p.name)).toEqual(['Alpha', 'Beta', 'Zebra']);
  expect(store.get(activeWorkspacePathAtom)).toBe(projects[0].path);
});

it('commits a native drag only on drop, and ignores external drops and cancellation', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const store = createStore();
  const projects = ['A', 'B', 'C'].map(name => ({ path: `/p/${name}`, name, openedAt: 0 }));
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, projects);
  store.set(activeWorkspacePathAtom, projects[0].path);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const index = projects.findIndex(p => p.path === this.dataset.projectPath);
    return { top: index * 48, bottom: index * 48 + 40, height: 40, left: 0, right: 56 } as DOMRect;
  });
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  const list = view.getByTestId('project-rail-projects');
  const source = view.getByRole('button', { name: 'Switch to project C' });
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  fireEvent(list, Object.assign(new MouseEvent('drop', { bubbles: true, clientY: 0 }), { dataTransfer }));
  expect(store.get(openProjectsAtom)).toBe(projects);
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(list, { clientY: 0, dataTransfer });
  expect(store.get(openProjectsAtom)).toBe(projects);
  fireEvent.dragEnd(source);
  expect(store.get(openProjectsAtom)).toBe(projects);
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent(list, Object.assign(new MouseEvent('drop', { bubbles: true, clientY: 0 }), { dataTransfer }));
  expect(store.get(openProjectsAtom).map(p => p.name)).toEqual(['C', 'A', 'B']);
  expect(store.get(activeWorkspacePathAtom)).toBe(projects[0].path);
});

it('customizes an inactive project without switching or editing the active project', () => {
  const store = createStore();
  const projects = [{ path: '/p/active', name: 'Active', openedAt: 0 }, { path: '/p/FileRocket', name: 'FileRocket', openedAt: 1 }];
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, projects);
  store.set(activeWorkspacePathAtom, projects[0].path);
  for (const project of projects) store.set(projectAppearanceAtom(project.path), { snapshot: { revision: 0, appearance: {} } });
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  fireEvent.contextMenu(view.getByRole('button', { name: 'Switch to project FileRocket' }));
  fireEvent.click(view.getByText('Customize appearance…'));
  expect(store.get(openSettingsCommandAtom)?.destination).toEqual({ scope: 'project', category: 'project-appearance', target: { kind: 'workspace', workspacePath: projects[1].path } });
  expect(store.get(activeWorkspacePathAtom)).toBe(projects[0].path);
});

function railStore(names: string[], groups: ProjectRailGroup[] = []) {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const store = createStore();
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, names.map(name => ({ path: `/p/${name}`, name, openedAt: 0 })));
  store.set(activeWorkspacePathAtom, `/p/${names[0]}`);
  store.set(projectRailGroupsAtom, groups);
  return store;
}

const railGroup = (name: string, members: string[], extra: Partial<ProjectRailGroup> = {}): ProjectRailGroup =>
  ({ id: name, name, collapsed: false, projectPaths: members.map(member => `/p/${member}`), ...extra });
const openNames = (store: ReturnType<typeof createStore>) => store.get(openProjectsAtom).map(p => p.name);
const memberNames = (store: ReturnType<typeof createStore>) =>
  store.get(projectRailGroupsAtom).map(g => g.projectPaths.map(path => path.slice(3)));

/** Lay the rail out like the stylesheet: 40px tiles, 8px gaps, groups as tile plus members. */
function mockRailLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const rects = new Map<Element, { top: number; bottom: number }>();
    let y = 0;
    for (const child of Array.from(document.querySelector('.project-rail-projects')?.children ?? [])) {
      const top = y;
      if (child.classList.contains('project-rail-group')) {
        rects.set(child.querySelector('.project-rail-group-header')!, { top: y, bottom: y + 40 });
        y += 48;
        for (const item of Array.from(child.querySelectorAll('.project-rail-item'))) {
          rects.set(item, { top: y, bottom: y + 40 });
          y += 48;
        }
        rects.set(child, { top, bottom: y });
        y += 8;
      } else {
        rects.set(child, { top, bottom: top + 40 });
        y += 48;
      }
    }
    const { top, bottom } = rects.get(this) ?? { top: 0, bottom: 0 };
    return { top, bottom, height: bottom - top, left: 0, right: 56, width: 56 } as DOMRect;
  });
}

it('groups projects from the menus, names and colors groups, and moves projects in and out', async () => {
  const store = railStore(['A', 'B', 'C']);
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  const openMenu = async (name: string) => {
    fireEvent.contextMenu(view.getByRole('button', { name }));
    return view.findByTestId('project-rail-context-menu');
  };

  fireEvent.click(within(await openMenu('Switch to project B')).getByRole('menuitem', { name: 'New group…' }));
  let editor = await view.findByRole('dialog', { name: 'New group' });
  // The closing menu returns focus first; the name field must still end up focused for typing.
  await waitFor(() => expect(document.activeElement).toBe(within(editor).getByLabelText('Name')));
  fireEvent.change(within(editor).getByLabelText('Name'), { target: { value: 'Kunde A' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Green' }));
  fireEvent.click(within(editor).getByRole('button', { name: 'Create group' }));
  expect(store.get(projectRailGroupsAtom)).toEqual([
    { id: expect.any(String), name: 'Kunde A', color: '#22c55e', collapsed: false, projectPaths: ['/p/B'] },
  ]);
  expect(view.queryByRole('dialog')).toBeNull();

  // Cancelling the editor creates nothing.
  fireEvent.click(within(await openMenu('Switch to project C')).getByRole('menuitem', { name: 'New group…' }));
  fireEvent.click(within(await view.findByRole('dialog', { name: 'New group' })).getByRole('button', { name: 'Cancel' }));
  expect(store.get(projectRailGroupsAtom)).toHaveLength(1);

  fireEvent.click(within(await openMenu('Switch to project C')).getByRole('menuitem', { name: 'Kunde A' }));
  expect(memberNames(store)).toEqual([['B', 'C']]);
  fireEvent.click(within(await openMenu('Switch to project C')).getByRole('menuitem', { name: 'Move up' }));
  expect(openNames(store)).toEqual(['A', 'C', 'B']);
  expect(memberNames(store)).toEqual([['C', 'B']]);
  fireEvent.click(within(await openMenu('Switch to project B')).getByRole('menuitem', { name: 'Remove from group' }));
  expect(memberNames(store)).toEqual([['C']]);
  expect(store.get(activeWorkspacePathAtom)).toBe('/p/A');

  fireEvent.click(within(await openMenu('Group Kunde A, 1 project')).getByRole('menuitem', { name: 'Collapse group' }));
  expect(store.get(projectRailGroupsAtom)[0].collapsed).toBe(true);
  expect(view.queryByRole('button', { name: 'Switch to project C' })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Group Kunde A, 1 project' }));
  expect(view.getAllByTestId('project-rail-item').map(item => item.dataset.projectPath)).toEqual(['/p/A', '/p/C', '/p/B']);

  fireEvent.click(within(await openMenu('Group Kunde A, 1 project')).getByRole('menuitem', { name: 'Edit group…' }));
  editor = await view.findByRole('dialog', { name: 'Edit group' });
  expect(within(editor).getByRole('button', { name: 'Green' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.change(within(editor).getByLabelText('Name'), { target: { value: 'Kunde B' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'No color' }));
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(store.get(projectRailGroupsAtom)[0]).toEqual({ id: expect.any(String), name: 'Kunde B', collapsed: false, projectPaths: ['/p/C'] });

  fireEvent.click(within(await openMenu('Group Kunde B, 1 project')).getByRole('menuitem', { name: 'Ungroup' }));
  expect(store.get(projectRailGroupsAtom)).toEqual([]);
  expect(openNames(store)).toEqual(['A', 'C', 'B']);
});

it('merges by drag, offers to name the new group, and drags projects and whole groups', async () => {
  const store = railStore(['A', 'B', 'C', 'D']);
  mockRailLayout();
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  const list = view.getByTestId('project-rail-projects');
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  const dragTo = (source: HTMLElement, clientY: number) => {
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(list, { clientY, dataTransfer });
    fireEvent(list, Object.assign(new MouseEvent('drop', { bubbles: true, clientY }), { dataTransfer }));
  };

  // The middle of B (48-88) merges; Escape keeps the default name.
  dragTo(view.getByRole('button', { name: 'Switch to project D' }), 68);
  expect(memberNames(store)).toEqual([['B', 'D']]);
  expect(openNames(store)).toEqual(['A', 'B', 'D', 'C']);
  const editor = await view.findByRole('dialog', { name: 'New group' });
  fireEvent.keyDown(editor, { key: 'Escape' });
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
  expect(store.get(projectRailGroupsAtom)[0].name).toBe('New group');

  // A: 0-40, group tile 48-88, B 96-136, D 144-184, C 192-232. Above D's middle lands before D.
  dragTo(view.getByRole('button', { name: 'Switch to project A' }), 150);
  expect(memberNames(store)).toEqual([['B', 'A', 'D']]);
  expect(openNames(store)).toEqual(['B', 'A', 'D', 'C']);

  // A whole group moves past C to the end.
  dragTo(view.getByRole('button', { name: 'Group New group, 3 projects' }), 500);
  expect(openNames(store)).toEqual(['C', 'B', 'A', 'D']);

  // C: 0-40, tile 48-88, B, A, D. The tile's top quarter is the slot above the group.
  dragTo(view.getByRole('button', { name: 'Switch to project A' }), 50);
  expect(openNames(store)).toEqual(['C', 'A', 'B', 'D']);
  expect(memberNames(store)).toEqual([['B', 'D']]);
  expect(store.get(activeWorkspacePathAtom)).toBe('/p/A');
});

it('closes a group, remembers its projects, and reopens them together from the add menu', async () => {
  const invoke = vi.fn(async (channel: string) => (channel === 'settings:get-recent-projects' ? [] : { success: true }));
  vi.stubGlobal('electronAPI', { invoke });
  const store = railStore(['A', 'B', 'C'], [railGroup('Kunde', ['B', 'C'])]);
  const view = render(<Provider store={store}><ProjectRail /></Provider>);

  fireEvent.contextMenu(view.getByRole('button', { name: 'Group Kunde, 2 projects' }));
  fireEvent.click(await view.findByRole('menuitem', { name: 'Close 2 projects in group' }));
  expect(openNames(store)).toEqual(['A']);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('workspace:unregister-additional', { workspacePath: '/p/C' }));
  expect(invoke).toHaveBeenCalledWith('workspace:unregister-additional', { workspacePath: '/p/B' });
  expect(memberNames(store)).toEqual([['B', 'C']]);
  expect(view.queryByRole('button', { name: /^Group Kunde/ })).toBeNull();

  fireEvent.click(view.getByTestId('project-rail-add'));
  fireEvent.click(await view.findByRole('button', { name: /Kunde.*Open 2 projects: B, C/ }));
  await waitFor(() => expect(openNames(store)).toEqual(['A', 'B', 'C']));
  expect(invoke).toHaveBeenCalledWith('workspace:register-additional', { workspacePath: '/p/B' });
  expect(store.get(activeWorkspacePathAtom)).toBe('/p/B');
  expect(view.getByTestId('project-rail-group').dataset.groupId).toBe('Kunde');
  expect(view.getAllByTestId('project-rail-item').map(item => item.dataset.projectPath)).toEqual(['/p/A', '/p/B', '/p/C']);
});

it('resolves drop zones around collapsed and expanded groups, and never nests a dragged group', () => {
  const slots: RailHitSlot[] = [
    { kind: 'project', id: '/p/A', firstPath: '/p/A', top: 0, bottom: 40 },
    { kind: 'group', id: 'g', firstPath: '/p/B', collapsed: true, top: 48, bottom: 88, header: { top: 48, bottom: 88 }, members: [] },
    {
      kind: 'group', id: 'h', firstPath: '/p/C', collapsed: false, top: 96, bottom: 232, header: { top: 96, bottom: 136 },
      members: [{ path: '/p/C', top: 144, bottom: 184 }, { path: '/p/D', top: 192, bottom: 232 }],
    },
    { kind: 'project', id: '/p/E', firstPath: '/p/E', top: 240, bottom: 280 },
  ];
  const dragging = (path: string) => ({ kind: 'project' as const, path });
  // A collapsed folder: the top quarter inserts before it, the middle joins, the bottom quarter falls through.
  expect(railDropTargetAt(slots, 50, dragging('/p/E'))).toEqual({ type: 'insert', beforePath: '/p/B', groupId: null });
  expect(railDropTargetAt(slots, 68, dragging('/p/E'))).toEqual({ type: 'join', groupId: 'g' });
  expect(railDropTargetAt(slots, 86, dragging('/p/E'))).toEqual({ type: 'insert', beforePath: '/p/C', groupId: null });
  // An expanded group: its tile joins, members split at midpoints, below the last member is the group's end.
  expect(railDropTargetAt(slots, 120, dragging('/p/A'))).toEqual({ type: 'join', groupId: 'h' });
  expect(railDropTargetAt(slots, 200, dragging('/p/A'))).toEqual({ type: 'insert', beforePath: '/p/D', groupId: 'h' });
  expect(railDropTargetAt(slots, 220, dragging('/p/A'))).toEqual({ type: 'insert', beforePath: '/p/E', groupId: 'h' });
  // Dragging a group's first member out above the group skips the member itself.
  expect(railDropTargetAt(slots, 98, dragging('/p/C'))).toEqual({ type: 'insert', beforePath: '/p/D', groupId: null });
  const group = { kind: 'group' as const, groupId: 'g' };
  expect(railDropTargetAt(slots, 10, group)).toEqual({ type: 'insert', beforePath: '/p/A', groupId: null });
  expect(railDropTargetAt(slots, 200, group)).toEqual({ type: 'insert', beforePath: '/p/E', groupId: null });
  expect(railDropTargetAt(slots, 300, group)).toEqual({ type: 'insert', beforePath: null, groupId: null });
});

it('shows initials, a chosen icon, or an uploaded image on a collapsed group instead of its projects', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  importImageThumbnail.mockResolvedValue(png);
  const store = railStore(['A', 'B'], [railGroup('Kunde', ['A', 'B'], { collapsed: true })]);
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  const folder = () => view.getByRole('button', { name: 'Group Kunde, 2 projects' });
  const stored = () => store.get(projectRailGroupsAtom)[0];
  const edit = async () => {
    fireEvent.contextMenu(folder());
    fireEvent.click(await view.findByRole('menuitem', { name: 'Edit group…' }));
    return view.findByRole('dialog', { name: 'Edit group' });
  };
  expect(folder().textContent).toBe('AB'); // The projects' own initials, in miniature.

  let editor = await edit();
  fireEvent.click(within(editor).getByRole('radio', { name: 'Initials' }));
  const initials = within(editor).getByRole('textbox', { name: 'Initials' });
  expect(initials.getAttribute('placeholder')).toBe('KU');
  fireEvent.change(initials, { target: { value: 'ABCD' } });
  expect((within(editor).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(initials, { target: { value: 'KX' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(stored()).toMatchObject({ display: 'initials', initials: 'KX' });
  expect(folder().textContent).toBe('KX');

  editor = await edit();
  fireEvent.click(within(editor).getByRole('radio', { name: 'Icon' }));
  fireEvent.click(within(editor).getByRole('button', { name: 'Rocket' }));
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(stored()).toMatchObject({ display: 'icon', icon: 'rocket_launch' });
  expect(stored()).not.toHaveProperty('initials'); // Only the chosen tile's values are kept.
  expect(folder().textContent).toBe('rocket_launch');

  editor = await edit();
  fireEvent.change(within(editor).getByLabelText('Group image'), { target: { files: [new File(['png'], 'logo.png', { type: 'image/png' })] } });
  await within(editor).findByRole('button', { name: 'Remove image' });
  expect(importImageThumbnail).toHaveBeenCalledWith(expect.any(File), 96);
  expect(within(editor).getByRole('button', { name: 'Rocket' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(stored()).toMatchObject({ display: 'icon', image: png });
  expect(stored()).not.toHaveProperty('icon');
  expect(folder().querySelector('img')?.getAttribute('src')).toBe(png);
});

it('sums the activity of a collapsed group and marks it while it holds the visible project', () => {
  const store = railStore(['A', 'B', 'C', 'D'], [railGroup('Kunde', ['A', 'B', 'C'], { collapsed: true })]);
  const streaming = (count: number) => ({ streaming: new Set(Array.from({ length: count }, (_, i) => `s${i}`)), unread: new Set<string>() });
  store.set(globalSessionActivityAtom, new Map([['/p/A', streaming(5)], ['/p/B', streaming(2)], ['/p/C', streaming(1)]]));
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  const folder = view.getByRole('button', { name: 'Group Kunde, 3 projects' });
  expect(folder.getAttribute('aria-current')).toBe('true');
  // The active project's own sessions do not count, as on a single icon.
  expect(within(folder).getByLabelText(/streaming session/).textContent).toBe('3');
  act(() => store.set(activeWorkspacePathAtom, '/p/D'));
  expect(folder.getAttribute('aria-current')).toBeNull();
  expect(within(folder).getByLabelText(/streaming session/).textContent).toBe('8');
});
