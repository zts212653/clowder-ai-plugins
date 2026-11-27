(function () {
  'use strict';
  var UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  var countFormatter = new Intl.NumberFormat('zh-CN');
  var dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  function bytes(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    var amount = value;
    var unit = 0;
    while (amount >= 1024 && unit < UNITS.length - 1) {
      amount = amount / 1024;
      unit += 1;
    }
    return { value: amount, unit: UNITS[unit] };
  }

  function bytesText(value) {
    var parsed = bytes(value);
    if (parsed === null) return '未知';
    var showFraction = parsed.value < 10 || ['GB', 'TB', 'PB'].includes(parsed.unit);
    var digits = parsed.unit === 'B' || !showFraction ? 0 : 1;
    return parsed.value.toFixed(digits) + ' ' + parsed.unit;
  }

  function countText(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
    return countFormatter.format(value);
  }

  function percent(part, total) {
    if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
    return Math.min(100, Math.max(0, (part / total) * 100));
  }

  function percentText(part, total) {
    var value = percent(part, total);
    if (value === null) return '未知';
    if (value > 0 && value < 1) return '<1%';
    return Math.round(value) + '%';
  }

  function dateText(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
    return dateFormatter.format(new Date(value));
  }

  function durationText(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
    var seconds = Math.max(0, Math.round(value / 1000));
    if (seconds < 1) return '<1 秒';
    if (seconds < 60) return seconds + ' 秒';
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    if (minutes < 60) return rest === 0 ? minutes + ' 分钟' : minutes + ' 分 ' + rest + ' 秒';
    var hours = Math.floor(minutes / 60);
    var minuteRest = minutes % 60;
    return minuteRest === 0 ? hours + ' 小时' : hours + ' 小时 ' + minuteRest + ' 分';
  }

  function stateText(state) {
    var labels = {
      idle: '尚未扫描',
      queued: '等待扫描',
      scanning: '正在扫描',
      complete: '扫描完成',
      partial: '部分完成',
      failed: '扫描失败',
      cancelled: '已停止',
    };
    return labels[state] || '状态未知';
  }

  window.SGFormat = {
    bytes: bytes,
    bytesText: bytesText,
    countText: countText,
    percent: percent,
    percentText: percentText,
    dateText: dateText,
    durationText: durationText,
    stateText: stateText,
  };
})();
