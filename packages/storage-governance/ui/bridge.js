(function () {
  'use strict';
  var channel = 'clowder-plugin-ui/v1';
  var nonce = window.name;
  var pending = new Map();
  var sequence = 0;

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.channel !== channel || data.nonce !== nonce) return;
    var request = pending.get(data.requestId);
    if (!request) return;
    pending.delete(data.requestId);
    clearTimeout(request.timer);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  });

  function bridge(type, input) {
    var requestId = ++sequence;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pending.delete(requestId);
        reject(new Error('操作超时。扫描可能仍在进行，请重新打开本页查看。'));
      }, 185000);
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      parent.postMessage(
        {
          channel: channel,
          nonce: nonce,
          requestId: requestId,
          type: type,
          ...(type === 'http' ? { request: input } : { value: input }),
        },
        '*',
      );
    });
  }

  async function request(method, path, body) {
    var response = await bridge('http', body === undefined ? { method: method, path: path } : { method: method, path: path, body: body });
    if (!response || response.status < 200 || response.status >= 300) {
      var payload = response && response.body;
      var message = payload && payload.error ? payload.error : '存储清单操作未完成。';
      throw Object.assign(new Error(message), { code: payload && payload.code });
    }
    return response.body;
  }

  async function copy(value) {
    await bridge('clipboard.text', value);
  }

  window.SGBridge = { request: request, copy: copy };
})();
