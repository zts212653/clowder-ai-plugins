import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendRequest, sendControlsFixture } from './helpers/send-controls-fixture.mjs';

test('recognizes the current Chinese form submit button without a test ID', async (t) => {
  const fixture = sendControlsFixture();
  t.after(() => fixture.dom.window.close());
  const result = await fixture.adapter.appendMessage(appendRequest);
  assert.equal(result.hostMessageId, 'fixture-host-message');
  assert.equal(fixture.clicks.length, 1);
  assert.equal(fixture.clicks[0].getAttribute('aria-label'), '发送');
});

for (const attributes of [
  { 'data-testid': 'send-button', type: 'button' },
  { 'aria-label': 'Send prompt', type: 'button' },
  { 'aria-label': '发送提示', type: 'button' },
]) {
  test(`preserves the legacy layout ${JSON.stringify(attributes)}`, async (t) => {
    const fixture = sendControlsFixture({ form: false, render({ initial, button }) { initial.remove(); button(attributes); } });
    t.after(() => fixture.dom.window.close());
    await fixture.adapter.appendMessage(appendRequest);
    assert.equal(fixture.clicks.length, 1);
  });
}

test('ignores a legacy-looking button outside the composer form', async (t) => {
  const fixture = sendControlsFixture({ outsideLegacy: true });
  t.after(() => fixture.dom.window.close());
  await fixture.adapter.appendMessage(appendRequest);
  assert.equal(fixture.clicks.length, 1);
  assert.notEqual(fixture.clicks[0], fixture.foreign);
  assert.equal(fixture.clicks[0].closest('form'), fixture.controls);
});

test('does not escape the composer form when it has no send control', async (t) => {
  const fixture = sendControlsFixture({ outsideLegacy: true, render() {} });
  t.after(() => fixture.dom.window.close());
  await assert.rejects(fixture.adapter.appendMessage(appendRequest), { code: 'SEND_BUTTON_NOT_FOUND' });
  assert.equal(fixture.clicks.length, 0);
  assert.equal(fixture.composer.textContent, '');
});

test('refuses ambiguous submit controls and restores without clicking either', async (t) => {
  const fixture = sendControlsFixture({ render({ initial, button }) { initial.remove(); button(); button(); } });
  t.after(() => fixture.dom.window.close());
  await assert.rejects(fixture.adapter.appendMessage(appendRequest), { code: 'SEND_BUTTON_INVALID' });
  assert.equal(fixture.clicks.length, 0);
  assert.equal(fixture.composer.textContent, '');
});

test('refuses ambiguous legacy controls without a form', async (t) => {
  const fixture = sendControlsFixture({ form: false, render({ initial, button }) { initial.remove(); button({ 'data-testid': 'send-button' }); button({ 'aria-label': 'Send prompt' }); } });
  t.after(() => fixture.dom.window.close());
  await assert.rejects(fixture.adapter.appendMessage(appendRequest), { code: 'SEND_BUTTON_INVALID' });
  assert.equal(fixture.clicks.length, 0);
  assert.equal(fixture.composer.textContent, '');
});

test('observes a voice control changing its type and label in place', async (t) => {
  const fixture = sendControlsFixture({ render({ initial }) {
    setTimeout(() => { initial.type = 'submit'; initial.setAttribute('aria-label', '发送'); }, 5);
  } });
  t.after(() => fixture.dom.window.close());
  await fixture.adapter.appendMessage(appendRequest);
  assert.equal(fixture.clicks.length, 1);
});

for (const attributes of [{ disabled: '' }, { 'aria-disabled': 'true' }]) {
  test(`waits for disabled current controls ${JSON.stringify(attributes)}`, async (t) => {
    const fixture = sendControlsFixture({ render({ initial, button }) { initial.remove(); button({ type: 'submit', 'aria-label': '发送', ...attributes }); } });
    t.after(() => fixture.dom.window.close());
    await assert.rejects(fixture.adapter.appendMessage(appendRequest), { code: 'SEND_BUTTON_DISABLED' });
    assert.equal(fixture.clicks.length, 0);
    assert.equal(fixture.composer.textContent, '');
  });
}

for (const [change, mutate] of [
  ['disconnects', ({ controls }) => controls.querySelector('button[type="submit"]').remove()],
  ['moves outside the form', ({ controls, document }) => document.body.append(controls.querySelector('button[type="submit"]'))],
  ['becomes ambiguous', ({ button }) => button()],
]) {
  test(`refuses a control that ${change} before submission`, async (t) => {
    const fixture = sendControlsFixture({ afterSelection: mutate });
    t.after(() => fixture.dom.window.close());
    await assert.rejects(fixture.adapter.appendMessage(appendRequest), { code: 'SEND_BUTTON_INVALID' });
    assert.equal(fixture.clicks.length, 0);
    assert.equal(fixture.composer.textContent, '');
  });
}
