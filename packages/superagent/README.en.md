# Superagent

[Chinese guide](README.md)

Superagent adds a resident assistant at the top of the Clowder AI conversation list. Enable the plugin, save the work it may handle, choose an Assistant Agent, choose Execution Agents and source conversations in their separate sections, then explicitly start following work.

Choose one Assistant Agent to understand requests, follow progress and delegate work. Choose one or more Execution Agents to perform tasks. One member may fill both roles. Choose source conversations separately to control where work is received. Selections are saved immediately; selecting them alone does not start monitoring or delegation.

The chosen agents distinguish new requests, feedback on existing work, background and tentative ideas. Independent work gets its own execution conversation and canonical Task. Necessary decisions and results return to the source conversation, while the main assistant conversation keeps the follow-up history.

Pause stops new intake and delegation while existing work can still report results. Subscriptions remain while paused. Disabling stops the plugin and removes subscriptions without deleting conversations, work or history. A normal restart rebuilds the selected subscriptions and resumes pending operations. The plugin cannot keep running while the local Host is closed.

Install the exact version offered by the plugin catalog in Settings. Installation needs network access to obtain the dependencies in the publisher lock; users do not install SDK or Contract packages manually. The Host must support the generic `thread-sidebar.top` entry and the declared settings operations. Catalog availability does not imply compatibility with every older Host; update an incompatible Host first.

Upgrading the same `official.superagent` preserves the assistant name, responsibility, selected members and conversations, and durable work records. This version does not change storage formats. The plugin uses Host access to selected conversations and members, with no separate external account login. The selected members' providers may process these messages and consume quota. New work must stay within the configured responsibility; publishing, deleting data and other significant actions still require their existing authorization.

Maintained by Clowder AI. Report issues and feature requests in the [plugin repository](https://github.com/zts212653/clowder-ai-plugins/issues). This is an officially cataloged prerelease, without a claim that real models reliably detect every anomaly or automatically complete recovery across members.

For development, run `npm run typecheck`, `npm test` and `npm run build`. Runtime dependencies use exact published SDK, Contract and Zod versions with `npm-shrinkwrap.json`. Use the pinned artifact toolchain and canonical packer described in the repository contribution guide. Unit tests script model decisions; real-model semantics, complete Host journeys and cross-platform acceptance are recorded separately. Candidate publication, catalog activation and actual installation are separate verification boundaries.
