# Quick phrases

[Chinese](README.md)

Save instructions you use repeatedly and bring them back into the chat composer.

1. On a Clowder AI Host with PDL plugin support, find **Quick phrases** in the plugin manager, then install and enable it.
2. Click the bookmark icon next to the chat composer. Choose **Add a phrase** to type a new phrase, or **Save current input** to save text already in the composer.
3. Search or browse your saved phrases. The list shows five per page, most-used first, with newer phrases first when counts tie. Hover over a phrase to read the full text, or click it to fill the draft.
4. To remove a phrase, click the delete button at the end of its row.

The plugin needs no configuration or external account. Phrases stay in the plugin's private Host storage, scoped to the current user, and survive disabling the plugin. A phrase can be as long as one chat message. Each user has 1 MiB of storage for saved phrases.

Selection counts are stored with each phrase. An existing phrase without a count starts at zero. Browsing, searching, and saving a duplicate do not increase the count.

## Development and installation

The plugin is maintained in `packages/quick-phrases`. See [Host Issue #1898](https://github.com/zts212653/clowder-ai/issues/1898) for the tracked work.

```sh
pnpm --filter @clowder-ai/quick-phrases typecheck
pnpm --filter @clowder-ai/quick-phrases test
pnpm --filter @clowder-ai/quick-phrases build
```

The plugin contributes to `chat.composer.tools` through `console/pdl.yaml`. The `phrases` resource accepts `POST { "text": "…" }` to save or `POST { "id": "<phrase-id>" }` to select a phrase. Selection attempts to count one use and returns the Host's `insert` action with the full text. The plugin makes up to three attempts on a count write conflict, and insertion still works if the count write fails. Save and delete return `409` on write conflict.
