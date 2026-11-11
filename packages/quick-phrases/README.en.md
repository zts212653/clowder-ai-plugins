# Quick phrases

[Chinese](README.md)

Save instructions you use repeatedly and bring them back into the chat composer.

1. Install and enable the plugin on a Clowder AI Host that supports the Quick phrases entry.
2. With text in the composer, click the bookmark icon and choose **Yes** to save the text. You can keep editing the draft.
3. With no text in the composer, click the same icon to browse your phrases. The list shows five per page, most-used first, with newer phrases first when counts tie, and updates as you type in the search field. Select a phrase to fill the draft. Images and other attachments stay in place.
4. To remove a phrase, click the delete button at the end of its row and confirm.

The plugin needs no configuration or external account. Phrases stay in the plugin's private Host storage, scoped to the current user, and survive disabling the plugin. A phrase can be as long as one chat message. Each user has 1 MiB of storage for saved phrases.

Selection counts are stored with each phrase. Existing phrases start at zero; browsing, searching, and saving a duplicate do not increase the count. Counting requires a Host that sends selection notifications. Older Hosts can still save, search, and select phrases without updating counts.

## Development and installation

The plugin is maintained in `packages/quick-phrases`. See [Host Issue #1898](https://github.com/zts212653/clowder-ai/issues/1898) for the tracked work.

```sh
pnpm --filter @clowder-ai/quick-phrases typecheck
pnpm --filter @clowder-ai/quick-phrases test
pnpm --filter @clowder-ai/quick-phrases build
```

Build the package, then install this directory through the Host plugin manager. The Host must support the `composer.quick-phrases` entry. The plugin uses the existing plugin resource dispatcher for listing, saving, and deleting phrases.

The same `phrases` resource accepts `POST { "text": "…" }` to save and `POST { "id": "<phrase-id>" }` to record one selection. Counts are scoped to the current user, and results are ranked before filtering pages. Conflicting writes retain the existing `409` retry response.
