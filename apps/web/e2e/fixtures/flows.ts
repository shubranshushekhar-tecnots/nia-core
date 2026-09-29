import { type Page, expect } from '@playwright/test';

/**
 * The dashboard's old "New workflow" / sidebar "New" dropdown (Sidebar.tsx)
 * was removed by the home-dashboard redesign (commit 3040260) — Sidebar's
 * own `showCreateWorkflow` state is dead code today (nothing ever calls
 * `setShowCreateWorkflow`). The real current path to a new workflow goes
 * through the Projects page: "New project" (ProjectsListClient.tsx) -> open
 * the new project -> "New workflow" (ProjectDetailClient.tsx:57-58), whose
 * dialog defaults its project dropdown to the project you're already on
 * (`defaultProjectId`), so no manual project selection is needed here the
 * way the old dropdown-triggered dialog required.
 *
 * Leaves the caller on the project detail page (new workflow visible in its
 * list) — callers that need to actually enter the canvas call gotoWorkflow
 * next, same as they would for any pre-seeded workflow.
 */
export async function createProjectAndWorkflow(page: Page, projectName: string, workflowName: string) {
  await page.goto('/app/projects');
  // exact:true: the sidebar's own "+ New project" button (Sidebar.tsx) is
  // also on screen (navProjectsOpen defaults true) and its accessible name
  // contains "New project" as a substring — an unscoped match resolves to
  // both buttons.
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('#project-name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();

  const projectLink = page.getByRole('link', { name: projectName, exact: true });
  await expect(projectLink).toBeVisible();
  await projectLink.click();
  await page.waitForURL(/\/app\/projects\/[0-9a-f-]{36}/);

  await page.getByRole('button', { name: 'New workflow' }).click();
  await page.locator('#workflow-name').fill(workflowName);
  await page.getByRole('button', { name: 'Create workflow' }).click();
  // exact:true: the project detail page's own workflow list row
  // (ProjectDetailClient.tsx) renders the name, status ("draft"), and date
  // all inside the same <a>, so its accessible name is
  // "<name> draft <date>" — an unscoped match resolves to both that row and
  // the sidebar's plain-name link for the same href.
  await expect(page.getByRole('link', { name: workflowName, exact: true })).toBeVisible();
}

/**
 * Navigates via real UI links (project list -> project detail -> workflow),
 * not a hardcoded /app/workflows/:id URL — workflow ids are gen_random_uuid()
 * at seed time, so the id is only knowable by actually clicking through.
 *
 * Waits for the intermediate /app/projects/:id navigation to settle before
 * clicking the workflow link. Without this wait, the sidebar's
 * toggleOpenProject (synchronous local state, store.ts) expands the
 * project's workflow links immediately on the first click, while the actual
 * page navigation to /app/projects/:id is still an in-flight, async
 * Next.js client-side transition (RSC fetch + dev-mode on-demand route
 * compile, observed taking up to ~1s) — firing the second click before that
 * settles can match the sidebar's already-visible workflow link and start a
 * second, concurrent navigation that races the first, leaving the router on
 * a stale URL. Proven live (framenavigated/request tracing) and reproduced
 * deterministically in isolated runs — not suite-order flakiness.
 */
export async function gotoWorkflow(page: Page, projectName: string, workflowName: string) {
  await page.goto('/app/projects');
  await page.getByRole('link', { name: projectName, exact: true }).click();
  await page.waitForURL(/\/app\/projects\/[0-9a-f-]{36}/);
  // .first(): the sidebar's project tree can already be expanded around this
  // project (persisted openProject UI state) at the same time the project
  // detail page's own workflow list renders it too — both links share the
  // same href, so either is a valid click target.
  await page.getByRole('link', { name: workflowName }).first().click();
  await expect(page).toHaveURL(/\/app\/workflows\/[0-9a-f-]{36}/);
}
