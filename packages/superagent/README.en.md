# Superagent

The package console adds an assistant entry with a badge for unresolved questions. The retained coordination conversation appears as an ordinary thread on this Host. Questions for the user still go to the assistant conversation.

[Chinese guide](README.md)

Choose watched conversations in Settings. An upgrade keeps previously saved manual choices and roles until you update them. Select any pinned conversations you still want the assistant to follow.

The overview starts with counts of user actions and items needing attention. Every watched source appears by default in short tables grouped as decisions/acceptance, blocked, ongoing, unknown, quiet and completed. There is no top-three cutoff or count-only remainder. Subjects, Issue/PR references, concise progress and next steps remain visible. Waiting for a maintainer is not a user action; full background is available on demand.

The package console opens the existing assistant conversation. Notifications and the overview retain links to their source conversations. History is retained across upgrade.

The assistant conversation shows a one-time connection status without invoking a model. Opening it does not rescan history or redispatch work. Cross-conversation event IDs, tool instructions and coordinator narration go to a separate plugin-managed coordination conversation rather than the user's assistant inbox. Users do not maintain or select that conversation as a watched source. Events already handled by their original owner stay quiet. A failed judgment produces one source-linked notification with a concrete retry instruction, retaining the event without another automatic model turn. In-flight main-conversation judgments from before the upgrade can finish in place; history is retained.

After starting or upgrading, every selected source is assessed exactly once, including conversations without Tasks or currently unavailable sources. The full snapshot retains background, progress, blockers and next actions; the main conversation receives only the brief. Ask to expand user actions, blockers or the full overview to read the submitted details without starting new work. Related work-thread Tasks and questions are folded into the source. An open canonical Task cannot be declared completed from a model turn.

The configured assistant interprets recent source messages and Task facts, consuming its provider quota. Read-only checks run about once a minute; changes coalesce into at most one new summary per ten minutes, with unchanged summaries suppressed. Scope changes refresh the full coverage. Ask for global progress or a refresh in the assistant. Unknown evidence remains explicitly unknown; no invented blockers or deadlines. Failed summaries preserve the previous result without an automatic paid retry. Pausing stops checks and restarting preserves snapshots.

Routine member updates, review handoffs and system notices no longer wake the coordinator one by one; read-only task snapshots follow their states. Structured member failures still reach judgment, and feedback on existing plugin work stays on its original path. Only the current user's message can authorize a new work source; member speech cannot admit new work. Unapplied non-user starts retained from an older version are also refused with an audit record. Outcomes without task records need source review when the user asks; a finished model response is not sufficient evidence of completion.

Ordinary worker narration in plugin work conversations does not wake the coordinator, including when one member fills both roles. Native result reports and real failure reports keep their original delivery paths. A completed model turn alone does not prove that work finished or failed; ordinary receipts preserve its existing Task state without guessing that a deliverable is missing.

Result, question and failure notifications identify the issue, link the titled source conversation, include the existing work outcome as background, and state the specific next action. A result awaiting acceptance is distinct from a confirmed completion. Long results use a labelled first-paragraph excerpt with a link to the full source report. When work was requested in the main inbox, its full long report is retained in the work conversation instead.

Superagent adds a resident assistant at the top of the Clowder AI conversation list. Enable the plugin, save the work it may handle, choose an Assistant Agent, choose Execution Agents and source conversations in their separate sections, then explicitly start following work.

Choose an Assistant Agent, one or more Execution Agents and the watched conversations in Settings. Save these settings, then confirm start. Selecting roles and sources alone leaves monitoring and delegation paused.

Watched conversations retain their original thread and owner; observing them cannot start duplicate Tasks or work threads. Only independent work explicitly requested in the assistant's main conversation can create new execution conversations and canonical Tasks. Existing plugin Work and cross-conversation feedback retain their original references. Ordinary source results and errors stay at their source and enter the next overview, rather than being copied one by one into the assistant; explicit questions can still notify promptly. Directly delegated assistant work returns its result there, with long details retained in its work conversation.

Pause stops new intake and delegation while existing work can still report results. Subscriptions remain while paused. Disabling stops the plugin and removes subscriptions without deleting conversations, work or history. A normal restart rebuilds the selected subscriptions and resumes pending operations. The plugin cannot keep running while the local Host is closed.

Install an exact locally built archive on a next Host with package consoles and native member and conversation selectors. Installation materializes the locked dependencies. Public catalog admission is tracked in [#214](https://github.com/zts212653/clowder-ai-plugins/issues/214).

Upgrading the same `official.superagent` preserves the assistant name, responsibility, selected members and conversations, and durable work records. Preference and work formats remain unchanged; runtime state gains a durable coordination-conversation coordinate. That conversation is reused across restarts and excluded from the source picker. The plugin uses Host access to selected conversations and members, with no separate external account login. The selected members' providers may process these messages and consume quota. New work must stay within the configured responsibility; publishing, deleting data and other significant actions still require their existing authorization.

Report issues and feature requests in the [plugin repository](https://github.com/zts212653/clowder-ai-plugins/issues). This is a local-archive trial without official catalog admission, without a claim that real models reliably detect every anomaly or automatically complete recovery across members.

For development, run `npm run typecheck`, `npm test` and `npm run build`. Runtime dependencies use exact published SDK, Contract and Zod versions with `npm-shrinkwrap.json`. Use the pinned artifact toolchain and canonical packer described in the repository contribution guide. Unit tests script model decisions; real-model semantics, complete Host journeys and cross-platform acceptance are recorded separately. Candidate publication, catalog activation and actual installation are separate verification boundaries.
