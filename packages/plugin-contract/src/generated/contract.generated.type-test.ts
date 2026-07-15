import type { DataDeclaration } from './contract.generated.js';

const lifecycleCache: DataDeclaration = {
  name: 'compiled-cache',
  dataClass: 'cache',
  strategy: 'lifecycle',
};

const retainedUserData: DataDeclaration = {
  name: 'user-notes',
  dataClass: 'user-authored',
  strategy: 'retained',
};

// @ts-expect-error user-authored data cannot be lifecycle-scoped.
const invalidLifecycleUserData: DataDeclaration = {
  name: 'unsafe-user-notes',
  dataClass: 'user-authored',
  strategy: 'lifecycle',
};

void [lifecycleCache, retainedUserData, invalidLifecycleUserData];
