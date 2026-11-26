'use strict';

(function () {
  const tr = (zh, en) => S.lang === 'en' ? en : zh;
  const count = value => Number.isFinite(value) && value >= 0 ? value : null;

  function messageTime(ts, today) {
    const date = fmtParts(ts);
    const hm = date.hour + ':' + date.minute;
    return fmtDayNo(date) === today ? hm : tc('format.date', +date.month, +date.day) + ' ' + hm;
  }

  let checkedMinute, checkedDay;
  RUN_TICK.push(() => {
    const now = ioNow();
    const minute = Math.floor(now / 60000);
    if (minute === checkedMinute) return;
    checkedMinute = minute;
    const day = fmtDayNo(fmtParts(now));
    if (checkedDay !== undefined && checkedDay !== day) {
      document.querySelectorAll('#stream .dsh-message-meta time[datetime]').forEach(time => {
        time.textContent = messageTime(Date.parse(time.dateTime), day);
      });
    }
    checkedDay = day;
  });

  A.dshCopyMessage = (d, el) => {
    const message = chatMessageIndex.get(d.mid);
    if (message?.content && !message.recalled) copyText(message.content, el);
  };

  function recordedIdentity(metadata) {
    for (const value of [metadata.servedModel, metadata.model]) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const name = value.trim();
      if (!name.startsWith('[')) return { provider: metadata.provider, model: name };
      // ACP records the DSH selection as a serialized provider/model pair.
      try {
        const pair = JSON.parse(name);
        if (Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string' && part.trim())) {
          return { provider: pair[0].trim(), model: pair[1].trim() };
        }
      } catch {
        // An unreadable serving model can still have a recorded requested model.
      }
    }
    return { provider: metadata.provider };
  }

  function usageFooter(mid, usage, { provider, model }) {
    if (!usage) return '';
    const input = count(usage.inputTokens);
    const output = count(usage.outputTokens);
    const cached = count(usage.cacheReadTokens);
    const writes = count(usage.cacheCreationTokens);
    const total = count(usage.totalTokens) ?? (input !== null && output !== null ? input + output : null);
    const uncached = input !== null && cached !== null && writes !== null && input >= cached + writes ? input - cached - writes : null;
    const tokens = value => value === null ? null : FORMATS.num(value) + ' tok';
    const stats = [
      [tr('总用量', 'Total'), tokens(total)],
      [tr('提供方 / 模型', 'Provider / model'), [provider, model].filter(Boolean).join(' / ') || null],
      [tr('输入', 'Input'), tokens(input)],
      [tr('缓存命中', 'Cache hit'), input > 0 && cached !== null && cached <= input ? (100 * cached / input).toFixed(1) + '%' : null],
      [tr('未缓存输入', 'Uncached input'), tokens(uncached)],
      [tr('缓存读取', 'Cache read'), tokens(cached)],
      [tr('缓存写入', 'Cache write'), tokens(writes)],
      [tr('输出', 'Output'), tokens(output)],
    ].filter(([, value]) => value !== null);
    if ([input, output, cached, writes, total].every(value => value === null)) return '';
    const id = 'dsh-message-usage-' + mid;
    const short = total === null ? '' : ' ' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(total) + ' tok';
    return '<button class="dsh-message-control dsh-message-usage" type="button" popovertarget="' + h(id) +
      '" aria-label="' + h(tr('查看本条回复的 Token 用量', 'View token usage for this reply')) + '">' +
      icon('chart', 13) + '<span>' + h(tr('用量', 'Usage') + short) + '</span></button>' +
      '<div class="dsh-usage-popover" id="' + h(id) + '" popover="auto">' +
      '<strong>' + h(tr('本条回复用量', 'Reply token usage')) + '</strong><dl>' +
      stats.map(([label, value]) => '<dt>' + h(label) + '</dt><dd>' + h(value) + '</dd>').join('') + '</dl></div>';
  }

  const buildMessage = chatMessageVM;
  chatMessageVM = function (row) {
    if (row.meta?.model && row.meta.kind !== 'typing' && chatMessageIndex.get(row.mid)?.type === 'assistant') {
      // The footer displays the historical model even when the message has no execution summary.
      row = { ...row, meta: { ...row.meta, model: null } };
    }
    return buildMessage(row);
  };

  const drawMessage = msgFrame;
  msgFrame = function (options) {
    if (PV.viewId !== 'chat.stream' || options.frame !== 'msg') return drawMessage(options);
    const message = chatMessageIndex.get(options.mid);
    if ((message?.type === 'assistant' || options.running) && options.body?.includes('<table>')) {
      const label = tr('横向滚动查看表格', 'Scroll table horizontally');
      const body = options.body.replace(/<table><thead>([\s\S]*?)<\/thead>[\s\S]*?<\/table>/g, (table, headings) =>
        headings.match(/<th>/g)?.length >= 4
          ? '<div class="dsh-wide-table" role="region" tabindex="0" aria-label="' + h(label) + '">' + table + '</div>'
          : table);
      options = { ...options, body };
    }
    if (options.running || message?.recalled || !['user', 'assistant', 'connector'].includes(message?.type))
      return drawMessage(options);
    const ts = fmtTs(message.timestamp);
    let time = options.time ? '<span>' + h(options.time) + '</span>' : '';
    if (Number.isFinite(ts)) {
      const day = fmtDayNo(fmtParts(ioNow()));
      checkedDay ??= day;
      time = '<time datetime="' + new Date(ts).toISOString() + '" aria-label="' +
        h(FORMATS.datetime(ts)) + '">' + h(messageTime(ts, day)) + '</time>';
    }
    const copy = message.content?.trim() ? '<button class="dsh-message-control" type="button" aria-label="' +
      h(tr('复制消息', 'Copy message')) + '"' + actAttrs('dshCopyMessage', { mid: options.mid }) +
      '>' + icon('copy', 14) + '</button>' : '';
    let detail = '';
    if (message.type === 'assistant') {
      if (message.extra?.isExplicitPost) {
        detail = '<span class="dsh-message-model">' + h(tr('协作消息', 'Collaboration message')) + '</span>';
      } else {
        const metadata = message.metadata || {};
        const identity = recordedIdentity(metadata);
        const model = identity.model || tr('模型未记录', 'Model not recorded');
        const label = [identity.provider, identity.model].filter(Boolean).join(' / ') || model;
        detail = '<span class="dsh-message-model" title="' + h(label) + '">' + h(model) + '</span>' +
          (usageFooter(options.mid, metadata.usage, identity) ||
            '<span class="dsh-message-unreported">' + h(tr('用量未记录', 'Usage not recorded')) + '</span>');
      }
    }
    if (!time && !copy && !detail) return drawMessage(options);
    const footer = '<footer class="dsh-message-meta">' + time + detail + copy + '</footer>';
    return drawMessage({ ...options, time: null }).replace(/(<\/div>){3}$/, footer + '$&');
  };
})();
