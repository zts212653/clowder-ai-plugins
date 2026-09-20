// Interaction experiment only. No Host, media capture, or durable chat store.
export function createInteraction() {
  let state = { panel: 'none', call: 'idle', muted: false, sharing: false, hidden: false, draft: '', messages: [], documents: true };
  return {
    get state() { return state; },
    dispatch(event) {
      if (state.hidden && event.type !== 'restore') return state;
      const update = patch => { state = { ...state, ...patch }; };
      switch (event.type) {
        case 'tap': update({ panel: state.panel === 'actions' ? 'none' : 'actions' }); break;
        case 'menu': update({ panel: 'menu' }); break;
        case 'write': case 'history': update({ panel: 'chat' }); break;
        case 'dismiss': case 'drag': update({ panel: 'none' }); break;
        case 'begin':
          if (['idle', 'failed'].includes(state.call)) update({ call: 'connecting', panel: 'none', muted: false });
          break;
        case 'connected': if (state.call === 'connecting') update({ call: 'talking' }); break;
        case 'failed': if (state.call === 'connecting') update({ call: 'failed', panel: 'actions' }); break;
        case 'stop': update({ call: 'idle', sharing: false, panel: 'none', muted: false }); break;
        case 'mute': if (state.call === 'talking') update({ muted: !state.muted }); break;
        case 'share': if (state.call === 'talking') update({ sharing: !state.sharing, panel: 'none' }); break;
        case 'documents': update({ documents: !state.documents }); break;
        case 'draft': update({ draft: event.text.slice(0, 8000) }); break;
        case 'send': {
          const text = state.draft.trim();
          if (text) update({ draft: '', messages: [...state.messages, { role: 'user', text }] });
          break;
        }
        case 'hide': update({ hidden: true, call: 'idle', sharing: false, panel: 'none' }); break;
        case 'restore': update({ hidden: false, panel: 'none' }); break;
      }
      return state;
    },
  };
}
