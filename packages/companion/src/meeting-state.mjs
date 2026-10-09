export function meetingPresentation(meeting) {
  if (!meeting || meeting.kind === 'idle') return null;
  if (meeting.kind === 'running') {
    if (meeting.paused) return { label: '会议记录已暂停', sourceLabel: meeting.sourceLabel, tone: 'quiet' };
    return meeting.sharing
      ? { label: '听会中', sourceLabel: meeting.sourceLabel, tone: 'active' }
      : { label: '会议记录中 · 未接入通话', sourceLabel: meeting.sourceLabel, tone: 'active' };
  }
  if (meeting.kind === 'stopped') return { label: '会议记录已停止', sourceLabel: null, tone: 'quiet' };
  if (meeting.kind === 'unconfirmed') return { label: '会议记录状态未确认', sourceLabel: null, tone: 'warning' };
  if (meeting.kind === 'needs_source') return { label: '需要确认会议所在的 App', sourceLabel: null, tone: 'warning' };
  return null;
}

const meetingPrefixes = ['call', 'menu-call', 'chat-call', 'transcript-call', 'settings-call'];
export function renderMeetingStatus(document, presentation) {
  for (const prefix of meetingPrefixes) {
    const row = document.getElementById(`${prefix}-meeting`);
    const source = document.getElementById(`${prefix}-meeting-source`);
    row.hidden = presentation === null;
    row.dataset.tone = presentation?.tone ?? '';
    document.getElementById(`${prefix}-meeting-label`).textContent = presentation?.label ?? '';
    source.textContent = presentation?.sourceLabel ? ` · ${presentation.sourceLabel}` : '';
    source.hidden = !presentation?.sourceLabel;
  }
}

/** Keeps the stopped acknowledgement transient without hiding uncertain or active capture truth. */
export class MeetingStatus {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.previousKind = null;
    this.stoppedUntil = 0;
  }

  update(meeting) {
    const kind = meeting?.kind ?? 'idle';
    if (kind === 'idle') {
      this.previousKind = 'idle';
      this.stoppedUntil = 0;
      return null;
    }
    if (kind === 'stopped') {
      if (this.previousKind !== 'stopped') {
        this.stoppedUntil = this.previousKind !== null && this.previousKind !== 'idle'
          ? this.now() + 10_000 : 0;
      }
      this.previousKind = 'stopped';
      return this.now() < this.stoppedUntil ? meetingPresentation(meeting) : null;
    }
    this.previousKind = kind;
    this.stoppedUntil = 0;
    return meetingPresentation(meeting);
  }
}
