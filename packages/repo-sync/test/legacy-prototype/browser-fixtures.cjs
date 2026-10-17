async function showDemo(page) {
  if (!(await page.locator('#demo-controls').isVisible())) await page.locator('#demo-toggle').click();
}
async function fixture(page, scenario) {
  await showDemo(page);
  await page.locator('#scenario').selectOption(scenario);
  await page.locator('#overview').waitFor({ state: 'visible' });
}
module.exports = { fixture, showDemo };
