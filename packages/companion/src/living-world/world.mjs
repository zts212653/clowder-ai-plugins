// F336 Phase C: the living body's world, mounted on the body window's full-work-area canvas.
// Seam: `mount(canvas, host, {data, atlasUrls})`. The card engine runs on an engine clock that stops while the window
// is hidden. Each animation frame steps him, but the canvas is repainted only when what it shows changes; the
// clickable region and the anchor go to the host client, which sends them only when they change. A semantic moment
// (scene.mjs) reports the scene at once; a context click on him opens the ordinary companion menu.
import { createEngine, DEFAULT_STAND_PX } from './engine.mjs';
import { createSceneWatch } from './scene.mjs';

const CLIMB_ATLAS = 2;

/** Engine time: the page clock with the time the window spent hidden taken out. */
export function createEngineClock(performance) {
  let away = 0;
  let pausedAt = null;
  return {
    now: () => (pausedAt ?? performance.now()) - away,
    pause() { pausedAt ??= performance.now(); },
    resume() { if (pausedAt !== null) { away += performance.now() - pausedAt; pausedAt = null; } },
  };
}

function loadImage(view, url) {
  return new Promise((resolve, reject) => {
    const image = new view.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`living world atlas did not load: ${url}`));
    image.src = url;
  });
}

export function mount(canvas, host, { data, atlasUrls, window: view = globalThis.window, standPx = DEFAULT_STAND_PX } = {}) {
  const doc = view.document;
  const clock = createEngineClock(view.performance);
  const engine = createEngine({ data, now: clock.now, standPx });
  const context = canvas.getContext('2d');
  const watch = createSceneWatch(engine, () => { void host.sceneChanged(); });
  const hidden = () => doc.visibilityState === 'hidden';
  let shownKey;
  let frameId = 0;
  const requested = new Set();

  function loadAtlas(index) {
    if (requested.has(index)) return;
    requested.add(index);
    loadImage(view, atlasUrls[index]).then(image => {
      engine.atlases[index] = image;
      schedule();
    }, error => view.console?.error?.(error.message));
  }
  function paint(now) {
    if (!context) return;
    const key = engine.renderKey(now);
    if (key === shownKey) return;
    shownKey = key;
    engine.draw(context, now);
  }
  function publish() {
    host.setHitRects(engine.hitRects());
    const anchor = engine.anchorRect();
    if (anchor) host.setAnchor(anchor);
  }
  function frame() {
    frameId = 0;
    const now = clock.now();
    engine.tick(now);
    if (engine.ball.ceil && !engine.atlases[CLIMB_ATLAS]) loadAtlas(CLIMB_ATLAS);   // the wall and ceiling frames load when he may need them
    watch.check();
    paint(now);
    publish();
    schedule();
  }
  function schedule() {
    if (!frameId && !hidden()) frameId = view.requestAnimationFrame(frame);
  }
  // body-area: the window's size and, from a Host that sizes him, how tall he stands; a size the Host has not named
  // keeps the last one (the default before any).
  let area;
  let standHeight = standPx;
  function resize(width, height, stand = standHeight) {
    const dpr = Math.min(2, view.devicePixelRatio || 1);
    if (area && area.width === width && area.height === height && area.stand === stand && area.dpr === dpr) return;
    area = { width, height, stand, dpr };
    standHeight = stand;
    engine.view.dpr = dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    engine.layout(width, height, stand);
    shownKey = undefined;   // resizing the canvas cleared it
    paint(clock.now());
    publish();
  }
  if (hidden()) clock.pause();   // a body window created hidden starts its clock when it is first shown
  doc.addEventListener('visibilitychange', () => {
    if (hidden()) {
      clock.pause();
      if (frameId) view.cancelAnimationFrame(frameId);
      frameId = 0;
    } else {
      clock.resume();
      schedule();
    }
  });

  const at = event => [event.clientX, event.clientY];
  canvas.addEventListener('pointermove', event => engine.pointerMove(...at(event)));
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) { engine.pointerMove(...at(event)); return; }
    canvas.setPointerCapture?.(event.pointerId);
    engine.pointerDown(...at(event));
  });
  const release = event => { if (event.button === 0 || event.type === 'pointercancel') engine.pointerUp(); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (engine.menuHit(...at(event))) void host.openMenu();
  });

  // Ask for the saved scene first; he is drawn and clickable while the answer is on its way.
  const started = host.start({
    snapshot: () => engine.snapshot(),
    onScene(answer) {
      if (answer.status === 'found') engine.restoreScene(answer.snapshot);
      watch.reset();   // a restored scene is what the archive already holds
    },
    onArea: resize,
  });
  resize(Math.max(1, view.innerWidth), Math.max(1, view.innerHeight));
  watch.reset();
  loadAtlas(0);
  loadAtlas(1);
  view.__xxCat = () => engine.debug();
  schedule();
  return { engine, started, get area() { return { width: engine.view.W, height: engine.view.H }; } };
}
