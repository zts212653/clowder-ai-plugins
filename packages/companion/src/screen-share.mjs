export class ScreenShare {
  constructor(api, onState, media = navigator.mediaDevices, elements = document) {
    this.api = api;
    this.onState = onState;
    this.media = media;
    this.elements = elements;
    this.epoch = 0;
  }
  async start() {
    if (this.pending || this.stream) return;
    const stopped = this.stop();
    const selection = this.api.screenRequest();
    const epoch = this.epoch;
    this.pending = true;
    this.onState({ sharing: false, pending: true, message: '请在系统选择器中选择窗口或屏幕' });
    let stream;
    try {
      const [, selectionId] = await Promise.all([stopped, selection]);
      if (epoch !== this.epoch) return;
      // macOS system picker supplies the exact source. Audio has a separate grant.
      stream = await this.media.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
      if (epoch !== this.epoch) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('没有取得共享画面');
      const checkTrack = () => {
        if (track.readyState !== 'live' || track.muted) throw new Error('共享画面已结束');
      };
      const ended = () => void this.stop('画面已不可用 · 共享已停止').catch(() => {
        this.onState({ sharing: false, pending: false, message: '画面已停止 · Host撤销尚未确认' });
      });
      track.onended = ended;
      track.onmute = ended;
      checkTrack();
      const label = track.label || '所选画面';
      await this.api.screenStart(selectionId, label);
      if (epoch !== this.epoch) return;
      checkTrack();
      this.video = this.elements.createElement('video');
      this.video.muted = true;
      this.video.srcObject = stream;
      await this.video.play();
      if (epoch !== this.epoch) return;
      this.canvas = this.elements.createElement('canvas');
      const capture = async () => {
        if (epoch !== this.epoch) return;
        checkTrack();
        const { videoWidth: width, videoHeight: height } = this.video;
        if (!width || !height) throw new Error('暂时没有可用画面');
        const scale = Math.min(1, 1280 / Math.max(width, height));
        this.canvas.width = Math.max(1, Math.round(width * scale));
        this.canvas.height = Math.max(1, Math.round(height * scale));
        this.canvas.getContext('2d').drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
        await this.api.screenFrame(selectionId, {
          width: this.canvas.width,
          height: this.canvas.height,
          image: this.canvas.toDataURL('image/jpeg', 0.7),
        });
        if (epoch === this.epoch)
          this.timer = setTimeout(() => void capture().catch(() => this.stop('画面暂不可用 · 共享已停止')), 1500);
      };
      await capture();
      if (epoch !== this.epoch) return;
      this.pending = false;
      this.onState({ sharing: true, pending: false, label });
    } catch (error) {
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
      if (epoch === this.epoch)
        await this.stop(
          error.name === 'NotAllowedError'
            ? '未能开始共享：没有选定画面或系统未允许。可点共享屏幕重试。'
            : '未能开始共享 · 请重试',
        );
    }
  }
  async stop(message = '未共享屏幕') {
    this.epoch++;
    this.pending = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.onmute = null;
      track.stop();
    });
    this.stream = undefined;
    this.video?.pause();
    if (this.video) this.video.srcObject = null;
    this.video = undefined;
    this.canvas = undefined;
    this.onState({ sharing: false, pending: false, message });
    await this.api.screenStop();
  }
}
