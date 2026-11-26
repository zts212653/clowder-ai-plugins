'use strict';

(function () {
  const tr = (zh, en) => S.lang === 'en' ? en : zh;
  const drawQueue = PDL_COMPONENTS.queue;
  const drawBox = PDL_BLOCKS.box;
  let appending = false;

  PDL_BLOCKS.box = function (block, scope, root) {
    if (block.variant !== 'composer') return drawBox(block, scope, root);
    const lanes = block.blocks.find(child => child.key === 'composer.lanes');
    const lane = lanes?.lanes.find(child => child.name === 'queue');
    const dock = lane ? pvBlocks(lane.items, scope, root) : '';
    if (!dock) return drawBox(block, scope, root);
    const status = pvBlocks([{ ...lanes, lanes: lanes.lanes.filter(child => child !== lane) }], scope, root);
    const composer = drawBox({ ...block, blocks: block.blocks.filter(child => child !== lanes) }, scope, root);
    return '<div class="dsh-queue-stack" data-k="dsh-queue-stack">' + status + dock + composer + '</div>';
  };

  PDL_COMPONENTS.queue = function (props, scope, root) {
    const items = pv(props.items, scope, root);
    if (!items.length) return '';
    const key = 'dsh-queue:' + pv(props.key, scope, root);
    const label = pv(props.label, scope, root);
    const send = props.actions.find(action => action.act === 'cafeQueueSend');
    const actions = props.actions.filter(action => action !== send).map(action => {
      if (action.act === 'cafeQueue') return { ...action, act: 'dshQueueAction', args: { ...action.args, id: '@key' } };
      if (action.type === 'more' && send) return { ...action, items: [...action.items, send] };
      return action;
    });
    actions.push({
      label: tr('插话发送', 'Send into the current reply'), icon: 'up', act: 'dshQueueContinue',
      args: { id: '@key' }, when: '@queued'
    });
    const template = document.createElement('template');
    template.innerHTML = drawQueue({ ...props, actions }, scope, root);
    const list = template.content.querySelector('.qlist');
    const pending = projectChatData().queue;
    list.querySelectorAll('.qitem').forEach((row, index) => {
      const item = items[index];
      const entry = pending.find(entry => entry.id === item.key);
      const insert = row.querySelector('[data-act="dshQueueContinue"]');
      if (insert && !entry?.lifecycleActions?.append) {
        insert.disabled = true;
        insert.title = tr('当前回复暂时无法接收补充', 'The current reply cannot accept an insert');
      }
      const preview = entry?.messagePreview;
      const attachments = (preview?.contentBlocks || []).filter(block => block.type === 'image' || block.type === 'file');
      if (attachments.length) {
        const strip = document.createElement('span');
        strip.className = 'dsh-queue-attachments';
        attachments.slice(0, 3).forEach(block => {
          if (block.type === 'image') {
            const thumb = document.createElement('img');
            thumb.alt = block.alt || tr('待发图片', 'Queued image');
            thumb.src = api.file(block.url);
            strip.append(thumb);
          } else {
            const file = document.createElement('span');
            file.className = 'dsh-queue-file';
            file.textContent = block.fileName;
            file.title = block.fileName;
            strip.append(file);
          }
        });
        if (attachments.length > 3) strip.append('+' + (attachments.length - 3));
        row.querySelector('.lr-title').before(strip);
      }
    });
    const open = items.length === 1 || S.folds[key] !== false;
    const header = items.length === 1 ? '' : '<button class="dsh-queue-toggle" type="button" aria-expanded="' + open + '"' +
      actAttrs('dshQueueToggle', { key }) + '>' + h(label) + ' · ' + items.length + icon(open ? 'chevup' : 'down', 12) + '</button>';
    return '<section class="dsh-queue-dock" data-k="' + h(key) + '" aria-label="' + h(label) + '">' +
      header + (open ? list.outerHTML : '') + '</section>';
  };
  PDL_COMPONENTS.queue.catalog = drawQueue.catalog;

  A.dshQueueToggle = function (d) {
    S.folds[d.key] = S.folds[d.key] === false;
    render(true);
  };
  A.dshQueueAction = function (d) {
    return chatAction('cafeQueue', { id: d.id, v: d.v === 'edit' ? 'recall' : 'remove' });
  };
  async function appendEntries(threadId, queue, ids) {
    appending = true;
    const path = '/api/threads/' + encodeURIComponent(threadId) + '/queue';
    try {
      for (let i = 0; i < ids.length; i++) {
        if (projectChatData().threadId !== threadId) return;
        const id = ids[i];
        const append = queue.find(entry => entry.id === id)?.lifecycleActions?.append;
        if (!append) {
          toast(tr('队列或当前回复已变化，剩余消息仍在排队', 'The queue or reply changed. Remaining messages are still queued.'));
          return;
        }
        const { expectedQueueRevision, expectedRuns } = append;
        const receipt = await api.post(path + '/' + encodeURIComponent(id) + '/append', {}, { expectedQueueRevision, expectedRuns });
        if (receipt.outcome !== 'appended') {
          toast(tr('正在核对插话是否送达', 'Checking whether the insert was delivered'));
          return;
        }
        if (i + 1 < ids.length) queue = (await api.get(path)).queue;
      }
    } catch (error) {
      toast(error.message, null, 'danger');
    } finally {
      if (projectChatData().threadId === threadId) await chatAction('refresh', { k: 'queue' });
      appending = false;
    }
  }
  A.dshQueueContinue = function (d, button) {
    if (appending || button.disabled) return;
    const { threadId, queue } = projectChatData();
    button.disabled = true;
    return appendEntries(threadId, queue, [d.id]).finally(() => { button.disabled = false; });
  };
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey ||
        event.isComposing || event.target.id !== 'chat-input' || event.target.value.trim() ||
        !event.target.closest('.dsh-queue-stack') || chatRead('chatComposer').input.draft.any) return;
    const { threadId, queue } = projectChatData();
    if (!queue.length || !queue.every(entry => entry.lifecycleActions?.append?.expectedRuns.length === entry.targetCats.length)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!appending && !event.repeat) void appendEntries(threadId, queue, queue.map(entry => entry.id));
  }, true);
})();
