// F336 Phase C: the living body's world, mounted on the body window's full-work-area canvas.
// Seam: `mount(canvas, host)`. The card engine (sprites, paper ball, box, solo play) replaces the
// placeholder scene behind this function; the host client and its Host protocol stay as they are.
// The canvas repaints only when the scene, the area or the scale changes; there is no frame loop.
import { createPlaceholderScene } from './placeholder-scene.mjs';

const INK = '#4a3b33';
const FUR = '#f4ece2';
const POINT = '#8a6e5c';
const HAT = '#3f7d4e';

function drawPlaceholder(context, scene, area) {
  const rect = scene.catRect(area);
  const { x, y, width, height } = rect;
  const head = height * 0.4;
  context.lineWidth = 3;
  context.strokeStyle = INK;
  context.fillStyle = FUR;
  // Body resting on the floor.
  context.beginPath();
  context.ellipse(x + width / 2, y + head + (height - head) / 2, width * 0.42, (height - head) / 2 - 2, 0, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  // Head and ears.
  const cx = x + width / 2;
  const cy = y + head * 0.62;
  const radius = head * 0.38;
  context.fillStyle = POINT;
  for (const side of [-1, 1]) {
    context.beginPath();
    context.moveTo(cx + side * radius * 0.9, cy - radius * 0.2);
    context.lineTo(cx + side * radius * 0.7, cy - radius * 1.25);
    context.lineTo(cx + side * radius * 0.2, cy - radius * 0.85);
    context.closePath();
    context.fill();
    context.stroke();
  }
  context.fillStyle = FUR;
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  // Hat: straight, or knocked askew by a rub.
  context.save();
  context.translate(cx, cy - radius * 0.95);
  context.rotate(scene.hat.askew ? -0.45 : 0);
  context.fillStyle = HAT;
  context.fillRect(-radius * 0.55, -radius * 0.5, radius * 1.1, radius * 0.5);
  context.strokeRect(-radius * 0.55, -radius * 0.5, radius * 1.1, radius * 0.5);
  context.restore();
}

export function mount(canvas, host, { window: view = globalThis.window } = {}) {
  const scene = createPlaceholderScene();
  const context = canvas.getContext('2d');
  let area = { width: Math.max(1, view.innerWidth), height: Math.max(1, view.innerHeight) };
  let scale = 0;

  function draw() {
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, area.width, area.height);
    drawPlaceholder(context, scene, area);
  }
  /** Tell the Host where the cat can be clicked and where his body is. */
  function publish() {
    const rect = scene.catRect(area);
    host.setHitRects([rect]);
    host.setAnchor(rect);
  }
  function resize(width, height) {
    area = { width, height };
    scale = view.devicePixelRatio || 1;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    draw();
    publish();
  }
  const pointOf = event => ({ x: event.clientX, y: event.clientY });

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || scene.hitTest(area, pointOf(event)) !== 'head') return;
    scene.rubHat();
    draw();
    void host.sceneChanged();
  });
  canvas.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (scene.hitTest(area, pointOf(event))) void host.openMenu();
  });

  // Ask for the saved scene first; the cat is drawn and clickable while the answer is on its way.
  const started = host.start({
    snapshot: () => scene.snapshot(),
    onScene(answer) {
      if (answer.status === 'found') scene.restore(answer.snapshot);
      draw();
      publish();
    },
    onArea: resize,
  });
  resize(area.width, area.height);
  return { scene, started, redraw: draw, get area() { return { ...area }; } };
}
