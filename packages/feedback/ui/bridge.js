const channel = 'clowder-plugin-ui/v1';
const nonce = window.name;
const pending = new Map();
let sequence = 0;
window.addEventListener('message', event => {
  const data = event.data;
  if (event.source !== parent || !data || data.channel !== channel || data.nonce !== nonce) return;
  const request = pending.get(data.requestId);
  if (!request) return;
  pending.delete(data.requestId); clearTimeout(request.timer);
  if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
});
export function bridge(type, input) {
  const requestId = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('操作超时。提交结果可能待核对，请重新打开检查状态。')); }, 185000);
    pending.set(requestId, { resolve, reject, timer });
    parent.postMessage({ channel, nonce, requestId, type, ...(type === 'invoke' ? { input } : { value: input }) }, '*');
  });
}
export const call = input => bridge('invoke', input);
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children); return node;
}
export function toBase64(bytes) {
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export async function copyImage(picture) {
  const bytes = Uint8Array.from(atob(picture.base64), c => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: picture.mime }));
  try {
    if (bitmap.width * bitmap.height > 16000000) throw new Error('图片尺寸过大，请下载原图后上传');
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('图片无法复制，请下载后上传');
    await bridge('clipboard.image', toBase64(new Uint8Array(await png.arrayBuffer())));
  } finally { bitmap.close(); }
}
export async function normalizePicture(file, index) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('图片无法解码，请重新导出截图'); }
  try {
    if (bitmap.width * bitmap.height > 16000000) throw new Error('图片尺寸过大，请先裁剪');
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!png || png.size > 4000000) throw new Error('PNG 发送副本超过 4 MB，请先裁剪');
    return { mime: 'image/png', name: `screenshot-${index + 1}.png`, base64: toBase64(new Uint8Array(await png.arrayBuffer())),
      original: { mime: file.type, name: `original-${index + 1}`, base64: toBase64(new Uint8Array(await file.arrayBuffer())) } };
  } finally { bitmap.close(); }
}
