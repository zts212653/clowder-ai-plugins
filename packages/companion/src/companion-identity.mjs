const named = value => typeof value === 'string' && value.trim().length > 0;
const actor = value => value && named(value.catId) && named(value.displayName);
const model = value => value === null || (named(value) && value.length <= 160);
const snapshotActor = value => actor(value) && value.catId.length <= 160 && value.displayName.length <= 160;

function validSnapshot(value) {
  return value?.v === 1 && value.name === '猫猫球'
    && snapshotActor(value.partner) && named(value.partner.skin) && value.partner.skin.length <= 160
    && snapshotActor(value.live) && value.live.transport === 'gpt_live_v3' && model(value.live.verifiedModel)
    && snapshotActor(value.deep) && value.deep.catId === value.partner.catId && model(value.deep.verifiedModel);
}

function display(snapshot, partnerLabel) {
  return {
    title: snapshot.name,
    companionKnown: true,
    partnerLabel,
    avatarCatId: snapshot.partner.catId,
    skin: snapshot.partner.skin,
    liveLabel: `Live 快端：${snapshot.live.displayName} · ${snapshot.live.verifiedModel ?? '型号未核实'}`,
    deepLabel: `深思端：${snapshot.deep.displayName} · ${snapshot.deep.verifiedModel ?? '型号未核实'}`,
  };
}

/** The current face comes from the Host's selected duty, never the background carrier. */
export function currentCompanionIdentity(state) {
  if (!actor(state?.duty) || !actor(state?.carrier) || !named(state.skin)
    || state.liveTransport?.kind !== 'gpt_live_v3' || !model(state.liveTransport.verifiedModel)) return null;
  const snapshot = {
    v: 1, name: '猫猫球',
    partner: { ...state.duty, skin: state.skin },
    live: { ...state.carrier, transport: state.liveTransport.kind, verifiedModel: state.liveTransport.verifiedModel },
    deep: { ...state.duty, verifiedModel: null },
  };
  return display(snapshot, `${snapshot.partner.displayName}陪伴中`);
}

/** A missing old snapshot never borrows today's preference. Keep the message's real author visible. */
export function historicalCompanionIdentity(snapshot, authorLabel) {
  if (!validSnapshot(snapshot)) return { authorLabel, companionKnown: false };
  return { ...display(snapshot, `当时由${snapshot.partner.displayName}陪伴`), authorLabel };
}
