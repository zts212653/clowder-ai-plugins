/* 快捷用语的 console 部分：浮层读插件自己的接口 /api/plugins/official.quick-phrases/phrases（宿主只转发）；
   点一条用语插进输入框（宿主的 insert）并告诉插件选了它（按选用次数排序），新增、删除写回同一个接口。读取跟着投影：浮层画出来才读 */
'use strict';
(function () {
  const key = 'quickPhrases',
    route = '/api/plugins/official.quick-phrases/phrases';
  let q = '',
    page = 1;
  function read() {
    return api.get(route, { q: q, page: String(page) }).then(
      function (r) {
        pushProjectData({ [key]: { load: '', items: r.items, page: r.page, totalPages: r.totalPages } });
      },
      function () {
        pushProjectData({ [key]: { load: 'error' } });
      },
    );
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf(key) >= 0) settleHold(read());
  });
  VM.quickPhrases = function () {
    if (projectionNeeded) projectionNeeded.add(key);
    const held = projectData(key);
    if (!held || held.load) return { load: held ? held.load : 'loading' };
    return {
      q: q,
      items: held.items,
      page: held.page,
      totalPages: held.totalPages,
      paged: held.totalPages > 1,
      first: held.page <= 1,
      last: held.page >= held.totalPages,
    };
  };
  INPUTS.quickPhrasesQ = function (e) {
    q = e.target.value;
    page = 1;
    return read();
  };
  A.quickPhrasesPage = function (d) {
    page += Number(d.v);
    return read();
  };
  A.quickPhraseAdd = function () {
    const field = document.getElementById('qp-add'),
      text = field.value;
    if (!text.trim()) return false;
    return api.post(route, { method: 'POST' }, { text: text }).then(function () {
      field.value = '';
      page = 1;
      return read();
    });
  };
  A.quickPhrasePick = function (d) {
    A.insert({ into: 'chat-input', text: d.text });
    return api.post(route, { method: 'POST' }, { id: d.id });
  };
  A.quickPhraseRemove = function (d) {
    return api.post(route, { method: 'DELETE' }, { id: d.id }).then(read);
  };
})();
