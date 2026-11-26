'use strict';

(function () {
  const widthKey = 'dsh-workbench.conversation-width';
  const minimum = 640;
  const gutterBudget = 176;
  const saved = store.get(widthKey, null);
  let preferred = Number.isFinite(saved) && saved >= minimum ? saved : null;
  let mounted;

  const drawChat = PDL_BLOCKS.chatpage;
  PDL_BLOCKS.chatpage = function (block, scope, root) {
    const html = drawChat(block, scope, root);
    if ((block.key || 'main.chat') !== 'main.chat') return html;
    // Keyed children keep pointer capture when the host updates the chat or Workspace.
    const handles = ['left', 'right'].map(side => {
      const label = S.lang === 'en'
        ? `Resize conversation width (${side} edge)`
        : `调整会话正文宽度（${side === 'left' ? '左' : '右'}侧）`;
      return `<div data-k="dsh-reading-${side}" data-dsh-width-handle="${side}" role="separator" aria-orientation="vertical" aria-label="${h(label)}" data-tip="${h(label)}" tabindex="0" hidden></div>`;
    }).join('');
    return html.slice(0, -6) + handles + '</div>';
  };

  onRender(() => {
    const surface = document.querySelector('.chat[data-ocontainer="main.chat"]:not(.layer-covered *)');
    if (mounted && mounted.handles.every(handle => handle.parentElement === surface)) {
      mounted.sync();
      return;
    }
    mounted?.observer.disconnect();
    mounted = null;
    if (!surface) return;

    const handles = [...surface.querySelectorAll(':scope > [data-dsh-width-handle]')];
    if (!handles.length) return;
    const maxWidth = () => Math.max(minimum, surface.clientWidth - gutterBudget);
    const clamp = width => Math.round(Math.min(maxWidth(), Math.max(minimum, width)));
    let drag;

    function paint(width) {
      const resolved = clamp(width ?? Math.max(680, Math.min(surface.clientWidth * 0.64, 920)));
      surface.style.setProperty('--dsh-reading-width', `${resolved}px`);
      const maximum = maxWidth();
      handles.forEach(handle => {
        handle.hidden = maximum <= minimum;
        handle.setAttribute('aria-valuemin', minimum);
        handle.setAttribute('aria-valuemax', maximum);
        handle.setAttribute('aria-valuenow', resolved);
      });
      if (drag) {
        drag.handle.setAttribute('data-dragging', '');
        drag.handle.style.setProperty('--dsh-width-marker-y', `${drag.markerY}px`);
      }
    }

    function commit(width) {
      preferred = clamp(width);
      store.set(widthKey, preferred);
      paint(preferred);
    }

    handles.forEach(handle => {
      const direction = handle.dataset.dshWidthHandle === 'right' ? 1 : -1;
      const dragWidth = x => drag.start + 2 * direction * (x - drag.x);
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || drag) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const width = Number(handle.getAttribute('aria-valuenow'));
        drag = { id: event.pointerId, handle, x: event.clientX, start: width, width, markerY: event.clientY - handle.getBoundingClientRect().top };
        paint(width);
      });
      handle.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        drag.width = dragWidth(event.clientX);
        drag.markerY = event.clientY - handle.getBoundingClientRect().top;
        paint(drag.width);
      });
      const stopDrag = event => {
        if (drag?.id !== event.pointerId) return;
        const width = dragWidth(event.clientX);
        const changed = clamp(width) !== drag.start;
        drag = null;
        handle.removeAttribute('data-dragging');
        handle.style.removeProperty('--dsh-width-marker-y');
        if (event.type === 'pointerup' && changed) commit(width);
        else paint(preferred);
      };
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => handle.addEventListener(type, stopDrag));
      handle.addEventListener('keydown', event => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const width = Number(handle.getAttribute('aria-valuenow'));
        const next = clamp(width + step * direction * 16);
        if (next !== width) commit(next);
      });
      handle.addEventListener('wheel', event => {
        if (event.ctrlKey || !event.deltaY) return;
        const stream = surface.querySelector(':scope > #stream');
        event.preventDefault();
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stream.clientHeight : 1;
        stream.scrollBy({ top: event.deltaY * scale });
      });
    });

    const sync = () => paint(drag?.width ?? preferred);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(surface);
    mounted = { handles, observer, sync };
  });
})();
