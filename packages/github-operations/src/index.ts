export { default, createGitHubPluginModule } from './plugin-entrypoint.js';
export type { GitHubPluginOptions } from './plugin-entrypoint.js';
export { GITHUB_SCHEDULES } from './schedules.js';
export type { GitHubScheduleId } from './schedules.js';
export { freezeGitHubSource, sourceDigest } from './migration-source.js';
export type { MigrationSource, ReadOnlySourcePort } from './migration-source.js';
