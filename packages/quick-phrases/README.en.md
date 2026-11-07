# Quick phrases

[Chinese](README.md)

Save instructions you use repeatedly and bring them back into the chat composer.

1. Install and enable the plugin on a Clowder AI Host that supports the Quick phrases entry.
2. With text in the composer, click the bookmark icon and choose **Yes** to save the text. You can keep editing the draft.
3. With no text in the composer, click the same icon to browse your phrases. The list shows five per page, newest first, and updates as you type in the search field. Select a phrase to fill the draft. Images and other attachments stay in place.
4. To remove a phrase, click the delete button at the end of its row and confirm.

The plugin needs no configuration or external account. Phrases stay in the plugin's private Host storage, scoped to the current user, and survive disabling the plugin. A phrase can be as long as one chat message. Each user has 1 MiB of storage for saved phrases.

## Development and installation

The plugin is maintained in `packages/quick-phrases`. See [Host Issue #1898](https://github.com/zts212653/clowder-ai/issues/1898) for the tracked work.

```sh
pnpm --filter @clowder-ai/quick-phrases typecheck
pnpm --filter @clowder-ai/quick-phrases test
pnpm --filter @clowder-ai/quick-phrases build
```

Build the package, then install this directory through the Host plugin manager. The Host must support the `composer.quick-phrases` entry. The plugin uses the existing plugin resource dispatcher for listing, saving, and deleting phrases.
