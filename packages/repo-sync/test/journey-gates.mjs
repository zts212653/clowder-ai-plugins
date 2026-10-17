import assert from 'node:assert/strict';

export function gate(label) {
  let reached = false,
    release;
  const blocked = new Promise((done) => {
    release = done;
  });
  return {
    entered: () => until(() => reached, Boolean, `${label} must be reached`),
    release,
    wait: () => {
      reached = true;
      return blocked;
    },
  };
}
export async function until(read, accept, message) {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((done) => setTimeout(done, 200));
  } while (Date.now() < deadline);
  assert.fail(`${message}; last status: ${value?.automation?.status ?? value?.operation?.status ?? 'unknown'}`);
}
