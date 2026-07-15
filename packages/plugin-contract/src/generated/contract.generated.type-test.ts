import type { DataDeclaration, RuntimeDeclaration } from './contract.generated.js';

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

const builtinRuntime: RuntimeDeclaration = {
  transport: 'builtin',
};

const externalRuntime: RuntimeDeclaration = {
  transport: 'stdio',
  entrypoint: 'dist/plugin.js',
};

// @ts-expect-error external runtimes require a launch entrypoint.
const invalidExternalRuntime: RuntimeDeclaration = {
  transport: 'ipc',
};

void [
  lifecycleCache,
  retainedUserData,
  invalidLifecycleUserData,
  builtinRuntime,
  externalRuntime,
  invalidExternalRuntime,
];
