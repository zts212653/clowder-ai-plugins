const el = id => document.getElementById(id);
let actor = 'sender', latest, busy = false;
const reportNames = { accepted: '明确接手', working: '处理中', blocked: '受阻', ready: '待验证' };
function options(select, rows) {
  const old = select.value, signature = JSON.stringify(rows);
  if (select.dataset.signature === signature) return;
  select.replaceChildren(...rows.map(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }));
  if (rows.some(([v]) => v === old)) select.value = old;
  select.dataset.signature = signature;
}
function render(s) {
  latest = s;
  el('cat-mode').value = s.catMode; el('network').checked = s.offline;
  el('enabled').checked = s.participants[actor].enabled;
  el('live').textContent = (s.offline ? '模拟网络离线' : '模拟网络在线') + ' · ' + s.comments.length + ' 条模拟评论';
  el('data-root').textContent = '数据持久保存在：' + s.root + '。关闭页面不会清除，服务重启后继续。';
  options(el('source'), s.issues.map(i => [String(i.number), '#' + i.number + ' ' + i.title]));
  const source = s.issues.find(i => String(i.number) === el('source').value);
  el('toggle-source').textContent = source?.state === 'CLOSED' ? '重新打开选中问题' : '关闭选中问题';
  const inbox = s.participants.receiver.rows.filter(r => r.kind === 'inbox' && r.status === 'delivered');
  options(el('inbox'), inbox.length ? inbox.map(r => [r.id, '#' + r.issue.number + ' ' + r.issue.title]) : [['', '暂无待回报收件，请先从发送端邀请 alice']]);
  el('report-submit').disabled = busy || !inbox.length;
  el('comments').replaceChildren(...s.comments.map(c => {
    const article = document.createElement('article'), title = document.createElement('strong'), body = document.createElement('pre');
    title.textContent = c.user.login + ' · 模拟评论 #' + c.id; body.textContent = c.body;
    article.append(title, body); return article;
  }));
  const error = s.participants[actor].error;
  if (!busy) { el('error').textContent = error ?? ''; el('error').hidden = !error; }
}
async function control(body) {
  busy = true; el('error').hidden = true;
  try {
    const response = await fetch('/sandbox/control', { method: 'POST', headers: { 'content-type': 'application/json', 'x-issue-sandbox': 'simulation' }, body: JSON.stringify(body) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? '模拟操作失败'); render(value); return value;
  } catch (e) { el('error').textContent = e.message; el('error').hidden = false; throw e; }
  finally { busy = false; if (latest) el('report-submit').disabled = !el('inbox').value; }
}
function selectActor(next) {
  actor = next;
  for (const a of ['sender', 'receiver']) { el(a + '-tab').setAttribute('aria-pressed', String(a === actor)); el(a + '-frame').hidden = a !== actor; }
  el('receiver-tools').hidden = actor !== 'receiver';
  el('journey').textContent = actor === 'sender'
    ? '先选一条问题，查看自动分类，或选择「猫猫研判」补充分析；再用「通知成员接手」邀请 alice。'
    : '接收端会自动补收邀请。填写下方说明并发送回执，随后切回发送端查看；通知不会自动替你接手。';
  if (latest) render(latest);
}
for (const a of ['sender', 'receiver']) el(a + '-tab').onclick = () => selectActor(a);
el('cat-mode').onchange = e => control({ action: 'mode', value: e.target.value }).catch(() => {});
el('network').onchange = e => control({ action: 'network', offline: e.target.checked }).catch(() => {});
el('enabled').onchange = e => control({ action: 'enabled', actor, enabled: e.target.checked }).catch(() => {});
el('tick').onclick = () => control({ action: 'tick' }).catch(() => {});
el('recover').onclick = async () => { try { await control({ action: 'mode', value: 'success' }); await control({ action: 'tick' }); } catch {} };
el('source').onchange = () => latest && render(latest);
el('toggle-source').onclick = () => {
  const issue = latest.issues.find(i => String(i.number) === el('source').value);
  control({ action: 'source', number: issue.number, state: issue.state === 'CLOSED' ? 'open' : 'closed' }).catch(() => {});
};
el('report-form').onsubmit = async e => {
  e.preventDefault(); const summary = el('report-summary').value, status = el('report-status').value;
  try { await control({ action: 'report', actor: 'receiver', id: el('inbox').value, status, summary });
    el('report-receipt').textContent = '模拟回执已保存并发布：' + reportNames[status] + ' · ' + summary;
  } catch {}
};
async function refresh() {
  try { if (!busy) { const r = await fetch('/sandbox/state'); if (!r.ok) throw new Error('试用服务不可用'); render(await r.json()); } }
  catch (e) { el('error').textContent = e.message + '；已有记录保留，服务恢复后继续。'; el('error').hidden = false; }
  setTimeout(refresh, 4000);
}
refresh();
