export async function openHistory(page) {
  const already = await page.locator('.records-page').count();
  if (already) return;
  await page.locator('.shell-nav [data-view="records"]').click();
  await page.locator('.records-page').waitFor({ state: 'attached' });
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
  // 本轮参数改为常驻可见，不再需要展开折叠
  await page.locator('.auto-merge-choice').first().waitFor({ state: 'attached' });
}
