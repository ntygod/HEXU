import { expect, type Locator, type Page } from '@playwright/test';
import type { Store } from '../../packages/db/src/store.js';

/** Read main's existing commit evidence without assuming a later history API/UI. */
export function completionEvents(store: Store, taskId: string) {
  return store.db
    .prepare(
      `SELECT id, task_id AS taskId, actor_id AS actorId, action,
              task_revision AS taskRevision, created_at AS createdAt
         FROM completion_events WHERE task_id=? ORDER BY rowid DESC`,
    )
    .all(taskId) as {
    id: string;
    taskId: string;
    actorId: string;
    action: string;
    taskRevision: number;
    createdAt: string;
  }[];
}

/** Capture the actual action after scrolling; overflow alone does not prove usability. */
export async function prepareScreenshot(page: Page, action: Locator, content: Locator) {
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  await expect(action).toBeEnabled();
  await expect(action).toBeInViewport({ ratio: 1 });
  expect(
    await action.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width >= 24 &&
        rect.height >= 24 &&
        element.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        )
      );
    }),
  ).toBe(true);
  expect((await content.boundingBox())!.width).toBeGreaterThan(240);
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
}
