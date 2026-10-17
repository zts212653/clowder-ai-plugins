import assert from 'node:assert/strict';

export async function inspectBaseline(page, upstream, internal) {
  if (upstream !== undefined) await page.locator('#upstream').fill(upstream);
  if (internal !== undefined) await page.locator('#internal').fill(internal);
  await page.getByRole('button', { name: '核验起点并查看文件 →', exact: true }).click();
  await page.locator('#baseline-differences').waitFor({ timeout: 30000 });
}

export async function activateBaseline(page, receiver) {
  if (receiver) assert.equal(await receiver.status(), null, 'read-only inspection cannot adopt the baseline');
  await page.getByRole('button', { name: '继续确认启用 →', exact: true }).click();
  await page.getByRole('heading', { name: '3 · 确认启用', exact: true }).waitFor();
  if (receiver) assert.equal(await receiver.status(), null, 'confirmation cannot adopt before explicit activation');
  await page.getByRole('button', { name: '启用并进入同步工作台 →', exact: true }).click();
  await page.locator('[data-form="adopt"]').waitFor({ state: 'hidden', timeout: 30000 });
  if (receiver) {
    let state;
    for (let attempt = 0; attempt < 300 && !state; attempt++) {
      state = await receiver.status();
      if (!state) await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(state, 'explicit activation must register a durable baseline');
  }
}

export async function inspectAndActivate(page, upstream, internal, receiver) {
  await inspectBaseline(page, upstream, internal);
  await page.getByRole('button', { name: '继续确认启用 →', exact: true }).waitFor({ timeout: 30000 });
  await activateBaseline(page, receiver);
}
