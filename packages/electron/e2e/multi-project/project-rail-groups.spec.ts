import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { launchElectronApp, createTempWorkspace, TEST_TIMEOUTS } from '../helpers';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Project rail groups: creating, filling, collapsing, persisting across a
 * reload, merging by drag, and closing and reopening a group. Each step also
 * saves a screenshot of the rail to the test's output directory.
 */

test.describe.configure({ mode: 'serial', timeout: 2 * TEST_TIMEOUTS.SIDEBAR_LOAD });

let app: ElectronApplication | undefined;
let page: Page;
let root: string;
let projects: string[];

async function waitForRail() {
  await page.waitForSelector('.workspace-sidebar', { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });
  await page.getByTestId('project-rail-add').waitFor();
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
}

async function railShot(name: string) {
  const viewport = page.viewportSize();
  await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    clip: { x: 0, y: 0, width: 400, height: Math.min(viewport?.height ?? 640, 640) },
  });
}

const rail = () => page.getByTestId('project-rail');
const projectButton = (name: string) => rail().getByRole('button', { name: `Switch to project ${name}`, exact: true });

async function openMenu(target: ReturnType<Page['getByRole']>) {
  await target.click({ button: 'right' });
  return page.getByTestId('project-rail-context-menu');
}

test.beforeAll(async () => {
  // Launch plus a reload: two full renderer boots.
  test.setTimeout(3 * TEST_TIMEOUTS.SIDEBAR_LOAD);
  root = await createTempWorkspace();
  await fs.writeFile(path.join(root, 'README.md'), '# Notes\n');
  projects = await Promise.all(['kunde-web', 'kunde-api', 'blog'].map(async (name) => {
    const folder = path.join(root, name);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'README.md'), `# ${name}\n`);
    return folder;
  }));

  app = await launchElectronApp({ workspace: root, permissionMode: 'allow-all' });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.electronAPI?.invoke === 'function');
  await page.evaluate(async ({ primary, extra }) => {
    await window.electronAPI.invoke('app:set-multi-project-mode', true);
    for (const workspacePath of extra) {
      const reg = await window.electronAPI.invoke('workspace:register-additional', { workspacePath });
      if (!reg?.success) throw new Error(`register-additional failed: ${JSON.stringify(reg)}`);
    }
    await window.electronAPI.invoke('app:set-open-projects', [primary, ...extra]);
    await window.electronAPI.invoke('app:set-active-project-path', primary);
  }, { primary: root, extra: projects });
  await page.reload();
  await waitForRail();
  await expect(rail().getByTestId('project-rail-item')).toHaveCount(4);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

test('creates a named group from the menu, fills it, collapses it, and keeps it across a reload', async () => {
  const menu = await openMenu(projectButton('kunde-web'));
  await menu.getByRole('menuitem', { name: 'New group…' }).click();
  const editor = page.getByRole('dialog', { name: 'New group' });
  await expect(editor.getByLabel('Name')).toBeFocused();
  await page.keyboard.type('Kunde A');
  await editor.getByRole('button', { name: 'Green' }).click();
  await editor.getByRole('button', { name: 'Create group' }).click();

  await (await openMenu(projectButton('kunde-api'))).getByRole('menuitem', { name: 'Kunde A' }).click();
  const group = rail().getByTestId('project-rail-group');
  await expect(group.getByTestId('project-rail-item')).toHaveCount(2);
  await railShot('01-group-expanded');

  await projectButton('kunde-api').click();
  const folder = rail().getByRole('button', { name: 'Group Kunde A, 2 projects' });
  await folder.click();
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await expect(folder).toHaveAttribute('aria-current', 'true');
  await expect(group.getByTestId('project-rail-item')).toHaveCount(0);
  await railShot('02-group-collapsed-holding-active');

  await (await openMenu(folder)).getByRole('menuitem', { name: 'Edit group…' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit group' })).toBeVisible();
  await railShot('03-group-editor');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.reload();
  await waitForRail();
  const restored = rail().getByRole('button', { name: 'Group Kunde A, 2 projects' });
  await expect(restored).toHaveAttribute('aria-expanded', 'false');
  await expect(restored).toHaveAttribute('aria-current', 'true');
});

test('drops one project onto another to start a second group', async () => {
  await rail().getByRole('button', { name: 'Group Kunde A, 2 projects' }).click();
  const notes = projectButton(path.basename(root));
  // The middle half of a tile merges; the outer quarters reorder.
  await projectButton('blog').dragTo(notes, { targetPosition: { x: 20, y: 20 } });
  const editor = page.getByRole('dialog', { name: 'New group' });
  await expect(editor).toBeVisible();
  await editor.getByLabel('Name').fill('Privat');
  await editor.getByRole('button', { name: 'Save' }).click();

  await expect(rail().getByTestId('project-rail-group')).toHaveCount(2);
  await expect(rail().getByRole('button', { name: 'Group Privat, 2 projects' })).toBeVisible();
  await railShot('04-two-groups');
});

test('closes a group and reopens all of its projects from the add menu', async () => {
  const folder = rail().getByRole('button', { name: 'Group Kunde A, 2 projects' });
  await (await openMenu(folder)).getByRole('menuitem', { name: 'Close 2 projects in group' }).click();
  await expect(folder).toHaveCount(0);
  await expect(rail().getByTestId('project-rail-item')).toHaveCount(2);

  await page.getByTestId('project-rail-add').click();
  const addMenu = page.getByTestId('project-rail-add-menu');
  const reopen = addMenu.getByRole('button', { name: /Kunde A.*Open 2 projects: kunde-web, kunde-api/ });
  await expect(reopen).toBeVisible();
  await railShot('05-add-menu-groups');
  await reopen.click();

  await expect(rail().getByRole('button', { name: 'Group Kunde A, 2 projects' })).toBeVisible();
  await expect(projectButton('kunde-web')).toHaveAttribute('aria-current', 'true');
  await railShot('06-group-reopened');
});
