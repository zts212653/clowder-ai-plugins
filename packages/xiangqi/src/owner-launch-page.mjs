/** C1 webhooks allow same-origin relative redirects, not loopback redirects. */
export function ownerLaunchPage(address) {
  const url = new URL(address);
  if (url.protocol !== 'http:' || !/^xq-[a-f0-9]{32}\.localhost$/.test(url.hostname) ||
    !url.port || url.username || url.password || url.pathname !== '/' || url.search ||
    !/^#session=[a-f0-9]{64}$/.test(url.hash)) throw new Error('无效的本地棋盘地址');
  return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>打开象棋棋盘</title><style>body{max-width:34rem;margin:15vh auto;padding:1.5rem;background:#f5f0e6;color:#382e24;font:18px/1.7 system-ui}a{display:inline-block;padding:.7rem 1.3rem;background:#6c422c;color:white;border-radius:.5rem;text-decoration:none}p{color:#65594d}</style></head>
<body><main><h1>棋盘准备好了</h1><p>在这台电脑上打开独立棋盘。聊天仍留在原对话，确认落子后会通知所选猫。</p>
<a id="open-board" href="${url.href}" rel="noreferrer">打开本地棋盘</a>
<p>链接失效时，请回原对话重新打开。</p></main></body></html>` };
}
