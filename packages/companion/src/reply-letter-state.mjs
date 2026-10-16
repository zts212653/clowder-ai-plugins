export const projectReplyBody = row => ({
  revision: row.body?.revision ?? '',
  complete: row.body?.complete === true,
  continuation: row.body?.continuation ?? null,
});

function newestSettledPair(settledPairs, dismissedReplies, inputMessageId) {
  for (let index = settledPairs.length - 1; index >= 0; index -= 1) {
    const pair = settledPairs[index];
    if (dismissedReplies.has(pair.replyId)) continue;
    if (inputMessageId !== undefined && pair.inputMessageId !== inputMessageId) continue;
    return pair;
  }
  return undefined;
}

/** Only a newly settled relevant reply, or the reply already on screen, may take presentation focus. */
export function selectReplyPresentation({ mode, letter, reply, settledPairs, pairs, dismissedReplies }) {
  if (mode === 'compose' || mode === 'history') return undefined;
  if (mode === 'sent') {
    if (!letter) return undefined;
    return newestSettledPair(settledPairs, dismissedReplies, letter.inputMessageId);
  }
  const freshPair = newestSettledPair(settledPairs, dismissedReplies);
  if (mode === 'idle' || (mode === 'reply' && freshPair)) return freshPair;
  if (mode !== 'reply' || !reply) return undefined;
  for (const pair of pairs.values()) {
    if (pair.replyId === reply.id) return pair;
  }
  return undefined;
}

export function newestHistoryAnchor(selectedMessageId, settled, history) {
  if (selectedMessageId !== null) return selectedMessageId;
  const settledReplyId = settled.at(-1)?.replyId;
  if (settledReplyId !== undefined) return settledReplyId;
  return history.at(-1)?.id ?? null;
}
