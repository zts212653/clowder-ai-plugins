export async function openHistory(page) {
  const history = page.locator('.history-disclosure');
  await history.waitFor({ state: 'attached' });
  if (!(await history.evaluate((node) => node.open))) await history.locator(':scope > summary').click();
}

export async function openStage(page, stage) {
  const detail = page.locator(`[data-stage="${stage}"]`);
  await detail.waitFor({ state: 'attached' });
  if (await detail.evaluate((node) => node.open)) return;
  const heading = page.locator(`[data-flow-stage-select="${stage}"]`);
  if (await heading.count()) await heading.click();
  else await detail.locator(':scope > summary').click();
}

export async function openAutoMerge(page) {
  const detail = page.locator('.auto-merge-options');
  if (await detail.count() && !(await detail.evaluate((node) => node.open)))
    await detail.locator(':scope > summary').click();
}
