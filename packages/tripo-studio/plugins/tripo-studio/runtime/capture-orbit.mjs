import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSameModelPage } from './contract.mjs';

export async function captureOrbitViews(cdp, rect, number, directory, { source, signal, foreground, delay }) {
  const during = [];
  const screenshots = [];
  const x = Math.round(rect.x + rect.width * 0.5),
    y = Math.round(rect.y + rect.height * 0.5);
  for (let view = 0; view < 4; view++) {
    signal.throwIfAborted();
    assertSameModelPage(await cdp.evaluate('location.href'), source.modelId);
    during.push(await foreground({ includeChromeWindows: false }));
    if (view) {
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      for (let step = 1; step <= 12; step++)
        await cdp.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: x + step * 8,
          y,
          button: 'left',
          buttons: 1,
        });
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: x + 96,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await delay(400);
    }
    assertSameModelPage(await cdp.evaluate('location.href'), source.modelId);
    const shot = await cdp.call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.min(1200 - Math.max(0, rect.x), rect.width),
        height: Math.min(900 - Math.max(0, rect.y), rect.height),
        scale: 1,
      },
    });
    assertSameModelPage(await cdp.evaluate('location.href'), source.modelId);
    signal.throwIfAborted();
    const bytes = Buffer.from(shot.data, 'base64');
    const filename = `${number}-orbit-${view}.png`;
    await writeFile(join(directory, filename), bytes, { flag: 'wx', mode: 0o600 });
    screenshots.push({
      view: `orbit-step-${view}`,
      file: filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  if (new Set(screenshots.map((s) => s.sha256)).size < 3) throw new Error('ORBIT_NOT_OBSERVED');
  return { screenshots, during };
}
