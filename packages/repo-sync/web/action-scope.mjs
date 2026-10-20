export function snapshotIdentity(snapshot) {
  return JSON.stringify([
    snapshot?.config?.bindingId,
    snapshot?.connection?.revision,
    snapshot?.state?.active?.id,
    snapshot?.state?.automation?.id,
    snapshot?.state?.queue?.[0]?.target,
  ]);
}
export function guardRenderedScope(content, snapshot, blocked) {
  for (const kind of ['click', 'submit'])
    document.addEventListener(
      kind,
      (event) => {
        if (
          !snapshot() ||
          !content.contains(event.target) ||
          content.dataset.actionScope === snapshotIdentity(snapshot())
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        blocked();
      },
      true,
    );
}
