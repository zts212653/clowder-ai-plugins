/** Open optional inputs through the same visible control used by an owner. */
export async function expandSection(page, title) {
  const summary = page.getByText(title, { exact: true });
  if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
}
