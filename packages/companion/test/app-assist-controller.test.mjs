import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppAssistController } from '../src/app-assist-controller.mjs';

const offer = (offerRef = 'offer-a', appName = 'Fixture Writer') => ({ offerRef, appName });
const snapshot = (revision, currentOffer = offer(), scopeRef = 'scope-a') => ({
  scopeRef, revision, status: 'ready', offer: currentOffer,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function fixture(overrides = {}) {
  const calls = [];
  const changes = [];
  const accepted = [];
  const client = {
    settleAppAssist: async (scopeRef, offerRef, action) => {
      calls.push({ scopeRef, offerRef, action });
      return { kind: 'app-assist-settlement', scopeRef, revision: 2, offerRef, action, outcome: 'settled' };
    },
    ...overrides.client,
  };
  const controller = new AppAssistController({
    client,
    changed: state => changes.push(structuredClone(state)),
    accepted: value => accepted.push(value),
    ...overrides,
  });
  return { controller, calls, changes, accepted };
}

test('state binds one trusted page scope and only consumes increasing revisions', () => {
  const f = fixture();
  assert.equal(f.controller.consume(snapshot(4)), true);
  assert.deepEqual(f.controller.state.offer, offer());

  assert.equal(f.controller.consume(snapshot(4, null)), false, 'an equal revision is only a repeated read');
  assert.equal(f.controller.consume(snapshot(999, null, 'foreign-scope')), false, 'a foreign page scope cannot rotate this renderer');
  assert.deepEqual(f.controller.state.offer, offer());

  assert.equal(f.controller.consume(snapshot(5, null)), true);
  assert.equal(f.controller.state.offer, null);
  assert.equal(f.controller.consume(snapshot(6, offer('offer-b', 'Fixture Sheet'))), true);
  assert.deepEqual(f.controller.state.offer, offer('offer-b', 'Fixture Sheet'));
});

test('settlement hides before the request and a lost reply cannot resurrect the old offer', async () => {
  const settlement = deferred();
  const f = fixture({ client: {
    settleAppAssist: (scopeRef, offerRef, action) => {
      f.calls.push({ scopeRef, offerRef, action });
      return settlement.promise;
    },
  } });
  f.controller.consume(snapshot(1));

  const pending = f.controller.settle('dismiss');
  assert.equal(f.controller.state.offer, null);
  assert.equal(f.controller.state.hiddenRef, 'offer-a');
  assert.deepEqual(f.calls, [{ scopeRef: 'scope-a', offerRef: 'offer-a', action: 'dismiss' }]);
  assert.equal(f.controller.consume(snapshot(2)), true);
  assert.equal(f.controller.state.offer, null, 'a newer read of the same offer remains locally hidden');

  settlement.reject(new Error('reply lost'));
  assert.equal(await pending, false);
  assert.equal(f.controller.state.hiddenRef, 'offer-a');
  f.controller.consume(snapshot(3, offer('offer-b', 'Fixture Sheet')));
  assert.deepEqual(f.controller.state.offer, offer('offer-b', 'Fixture Sheet'));
  assert.equal(f.controller.state.hiddenRef, null);
});

test('a matching same-revision accept ACK remains meaningful when cleared state arrived first', async () => {
  const settlement = deferred();
  const f = fixture({ client: { settleAppAssist: () => settlement.promise } });
  f.controller.consume(snapshot(4));
  const pending = f.controller.settle('accept');

  f.controller.consume(snapshot(5, null));
  settlement.resolve({
    kind: 'app-assist-settlement', scopeRef: 'scope-a', revision: 5,
    offerRef: 'offer-a', action: 'accept', outcome: 'settled',
  });

  assert.equal(await pending, true);
  assert.deepEqual(f.accepted, [{ scopeRef: 'scope-a', revision: 5, offerRef: 'offer-a' }]);
});

test('an older or stale accept settlement cannot act after a newer offer is visible', async () => {
  const settlement = deferred();
  const f = fixture({ client: { settleAppAssist: () => settlement.promise } });
  f.controller.consume(snapshot(1));
  const pending = f.controller.settle('accept');
  f.controller.consume(snapshot(3, offer('offer-b', 'Fixture Sheet')));
  settlement.resolve({
    kind: 'app-assist-settlement', scopeRef: 'scope-a', revision: 2,
    offerRef: 'offer-a', action: 'accept', outcome: 'settled',
  });
  assert.equal(await pending, false);
  assert.deepEqual(f.accepted, []);
  assert.deepEqual(f.controller.state.offer, offer('offer-b', 'Fixture Sheet'));

  const stale = fixture({ client: { settleAppAssist: async () => ({
    kind: 'app-assist-settlement', scopeRef: 'scope-a', revision: 2,
    offerRef: 'offer-a', action: 'accept', outcome: 'stale_offer',
  }) } });
  stale.controller.consume(snapshot(1));
  assert.equal(await stale.controller.settle('accept'), false);
  assert.deepEqual(stale.accepted, []);

  const unchanged = fixture({ client: { settleAppAssist: async () => ({
    kind: 'app-assist-settlement', scopeRef: 'scope-a', revision: 1,
    offerRef: 'offer-a', action: 'accept', outcome: 'settled',
  }) } });
  unchanged.controller.consume(snapshot(1));
  assert.equal(await unchanged.controller.settle('accept'), false,
    'settled must advance Host revision beyond the offer that was clicked');
  assert.deepEqual(unchanged.accepted, []);

  const afterPolicyLoss = deferred();
  const suspended = fixture({ client: { settleAppAssist: () => afterPolicyLoss.promise } });
  suspended.controller.consume(snapshot(1));
  const accepting = suspended.controller.settle('accept');
  suspended.controller.consume({ scopeRef: 'scope-a', revision: 2, status: 'suspended', offer: null });
  afterPolicyLoss.resolve({
    kind: 'app-assist-settlement', scopeRef: 'scope-a', revision: 2,
    offerRef: 'offer-a', action: 'accept', outcome: 'settled',
  });
  assert.equal(await accepting, false, 'a same-revision suspended state supersedes the pending accept');
  assert.deepEqual(suspended.accepted, []);
});

test('the presentation deadline is fixed and sends timeout without acquiring media authority', async () => {
  const timers = [];
  const f = fixture({
    scheduleTimeout: (callback, delay) => { timers.push({ callback, delay, cancelled: false }); return timers.length - 1; },
    cancelTimeout: id => { timers[id].cancelled = true; },
  });
  f.controller.consume(snapshot(1));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 15_000);

  f.controller.consume(snapshot(2));
  assert.equal(timers.length, 1, 'reading the same offer at a higher revision cannot extend its deadline');
  timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, [{ scopeRef: 'scope-a', offerRef: 'offer-a', action: 'timeout' }]);
  assert.equal(f.controller.state.offer, null);
  assert.deepEqual(f.accepted, []);
});
