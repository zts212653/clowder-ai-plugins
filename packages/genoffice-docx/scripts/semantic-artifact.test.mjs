import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { materializeDocx } from '../renderer/semantic-worker.js';

const root = new URL('../', import.meta.url);
const lock = JSON.parse(await readFile(new URL('source-lock.json', root), 'utf8'));
const fixture = await readFile(new URL(`.tmp/source/${lock.rootDirectory}/fixtures/generated/kitchen-sink.docx`, root));
const base = {
  protocolVersion: '1.0.0', requestId: 'test-request',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  bytesBase64: fixture.toString('base64'), operation: { kind: 'inspect', cursor: 0, limit: 32 },
};
const attribution = { author: 'codex-astra', operationId: 'semantic-test-1', timestamp: '2026-09-06T00:00:00.000Z' };

async function inspectArchive(bytes) {
  const script = 'import sys,zipfile,io,json,hashlib; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({p:{"digest":hashlib.sha256(z.read(p)).hexdigest(),"xml":z.read(p).decode("utf8") if p in ["word/document.xml","word/comments.xml"] else None} for p in z.namelist()}))';
  const { stdout } = await new Promise((resolve, reject) => {
    const child = execFile('python3', ['-c', script], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve({ stdout }));
    child.stdin.end(bytes);
  });
  return JSON.parse(stdout);
}

async function decorateFixture(mode) {
  const script = `import sys,zipfile,io,re
source=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as target:
 for part in source.namelist():
  data=source.read(part)
  if sys.argv[1]=='protected' and part=='word/settings.xml': continue
  if sys.argv[1]=='protected' and part=='[Content_Types].xml':
   data=data.replace(b'</Types>', b'<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>')
  if sys.argv[1]=='protected' and part=='word/_rels/document.xml.rels':
   data=data.replace(b'</Relationships>', b'<Relationship Id="rIdProtectionFixture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>')
  if sys.argv[1]=='bookmark' and part=='word/document.xml':
   data=re.sub(rb'(<w:p(?:\\s[^>]*)?>)', rb'\\1<w:bookmarkStart w:id="60000" w:name="keep_me"/>', data, count=1)
  if sys.argv[1] in ['single-quoted-revision','aliased-revision'] and part=='word/document.xml':
   revision=b"<w:p><w:ins w:id='0' w:author='existing'><w:r><w:t>Existing revision</w:t></w:r></w:ins></w:p>"
   if sys.argv[1]=='aliased-revision':
    revision=b"<w:p><w:ins xmlns:rev='http://schemas.openxmlformats.org/wordprocessingml/2006/main' rev:id='&#48;0' w:author='existing'><w:r><w:t>Existing revision</w:t></w:r></w:ins></w:p>"
   data=data.replace(b'<w:body>',b'<w:body>'+revision)
  target.writestr(part,data)
 if sys.argv[1]=='protected':
  target.writestr('word/settings.xml',b'<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>')
 target.writestr('customXml/unknown-preserved.xml',b'<opaque vendor="test">retain exact bytes</opaque>')
sys.stdout.buffer.write(out.getvalue())`;
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-c', script, mode], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(fixture);
  });
}

test('same frozen engine produces independently anchored tracked changes and comments without losing unrelated parts', async () => {
  const inspection = await materializeDocx(base);
  assert.equal(inspection.result.kind, 'inspection');
  const target = inspection.result.paragraphs.find(row => row.editable).target;
  const operation = { kind: 'tracked-change', target, replacement: '独立猫猫修订 < & >', attribution };
  const changed = await materializeDocx({ ...base, operation });
  assert.equal(changed.result.kind, 'document');
  const before = await inspectArchive(fixture);
  const after = await inspectArchive(Buffer.from(changed.result.bytesBase64, 'base64'));
  assert.match(after['word/document.xml'].xml, /<w:ins\b[^>]*w:author="codex-astra"/);
  assert.match(after['word/document.xml'].xml, /<w:del\b[^>]*w:author="codex-astra"/);
  assert.match(after['word/document.xml'].xml, /独立猫猫修订/);
  for (const [part, original] of Object.entries(before)) {
    if (!['word/document.xml', 'docProps/core.xml'].includes(part)) assert.equal(after[part]?.digest, original.digest, part);
  }
  const replay = await materializeDocx({ ...base, operation });
  assert.equal(replay.result.bytesBase64, changed.result.bytesBase64, 'same operation must have reproducible bytes');
  const reread = await materializeDocx({ ...base, bytesBase64: changed.result.bytesBase64 });
  assert.equal(reread.result.kind, 'inspection');
  const changedTarget = reread.result.paragraphs.find(row => row.target.textQuote === operation.replacement).target;
  const comment = await materializeDocx({ ...base, bytesBase64: changed.result.bytesBase64, operation: { kind: 'comment', target: changedTarget, body: '请核对这段修改', attribution: { ...attribution, operationId: 'comment-1' } } });
  assert.equal(comment.result.kind, 'document');
  const commented = await inspectArchive(Buffer.from(comment.result.bytesBase64, 'base64'));
  assert.match(commented['word/comments.xml'].xml, /codex-astra/);
  assert.match(commented['word/comments.xml'].xml, /请核对这段修改/);
  assert.match(commented['word/document.xml'].xml, /w:commentRangeStart/);
  assert.match(commented['word/document.xml'].xml, /w:ins\b/);
  const commentReplay = await materializeDocx({ ...base, bytesBase64: changed.result.bytesBase64, operation: { kind: 'comment', target: changedTarget, body: '请核对这段修改', attribution: { ...attribution, operationId: 'comment-1' } } });
  assert.equal(commentReplay.result.bytesBase64, comment.result.bytesBase64);
});

test('protected and structurally unsupported targets are honestly non-editable', async () => {
  for (const mode of ['protected', 'bookmark']) {
    const bytes = await decorateFixture(mode);
    const request = { ...base, bytesBase64: bytes.toString('base64') };
    const inspected = await materializeDocx(request);
    assert.equal(inspected.result.kind, 'inspection');
    const target = inspected.result.paragraphs[0];
    assert.equal(target.editable, false, mode);
    const changed = await materializeDocx({ ...request, operation: { kind: 'comment', target: target.target, body: 'Must reject', attribution } });
    assert.deepEqual(changed.result, { kind: 'rejected', code: 'UNSUPPORTED_TARGET' });
  }
});

test('unknown OOXML parts survive an independent semantic edit byte for byte', async () => {
  const bytes = await decorateFixture('unknown');
  const request = { ...base, bytesBase64: bytes.toString('base64') };
  const inspected = await materializeDocx(request);
  const target = inspected.result.paragraphs.find(row => row.editable).target;
  const changed = await materializeDocx({ ...request, operation: { kind: 'tracked-change', target, replacement: 'Preserve opaque parts', attribution } });
  assert.equal(changed.result.kind, 'document');
  const before = await inspectArchive(bytes);
  const after = await inspectArchive(Buffer.from(changed.result.bytesBase64, 'base64'));
  assert.equal(after['customXml/unknown-preserved.xml'].digest, before['customXml/unknown-preserved.xml'].digest);
});

test('stale target and malformed DOCX are typed rejections, not arbitrary replacements', async () => {
  const inspection = await materializeDocx(base);
  const target = inspection.result.paragraphs.find(row => row.editable).target;
  const mismatch = await materializeDocx({ ...base, operation: { kind: 'tracked-change', target: { ...target, textQuote: 'Wrong original' }, replacement: 'No', attribution } });
  assert.deepEqual(mismatch.result, { kind: 'rejected', code: 'TARGET_MISMATCH' });
  const invalid = await materializeDocx({ ...base, bytesBase64: Buffer.from('not a ZIP').toString('base64') });
  assert.deepEqual(invalid.result, { kind: 'rejected', code: 'INVALID_DOCX' });
});

test('worker rejects lossy XML text before touching the archive, including colliding author inputs', async () => {
  const inspection = await materializeDocx(base);
  const target = inspection.result.paragraphs.find(row => row.editable).target;
  for (const bad of ['\u0000', '\u000b', '\ud800', '\udfff', '\ufffe', '\uffff', '\r']) {
    for (const operation of [
      { kind: 'tracked-change', target, replacement: `bad${bad}text`, attribution },
      { kind: 'comment', target, body: `bad${bad}comment`, attribution },
      { kind: 'comment', target, body: 'Comment', attribution: { ...attribution, author: `named${bad}-cat` } },
    ]) {
      const result = await materializeDocx({ ...base, operation });
      assert.deepEqual(result.result, { kind: 'rejected', code: 'INVALID_REQUEST' }, JSON.stringify(operation));
      const beforeParse = await materializeDocx({ ...base, bytesBase64: 'bm90LXppcA==', operation });
      assert.deepEqual(beforeParse.result, result.result, 'invalid text must be rejected before archive parsing');
    }
  }
  const valid = await materializeDocx({ ...base, operation: { kind: 'comment', target, body: 'Valid 中文 🐾', attribution: { ...attribution, author: 'named-cat' } } });
  assert.equal(valid.result.kind, 'document');
  const parts = await inspectArchive(Buffer.from(valid.result.bytesBase64, 'base64'));
  assert.match(parts['word/comments.xml'].xml, /Valid 中文 🐾/);
  assert.match(parts['word/comments.xml'].xml, /w:author="named-cat"/);
});

test('revision IDs account for single quotes, namespace aliases and numeric XML attribute values', async () => {
  for (const mode of ['single-quoted-revision', 'aliased-revision']) {
    const bytes = await decorateFixture(mode);
    const request = { ...base, bytesBase64: bytes.toString('base64') };
    const inspected = await materializeDocx(request);
    const target = inspected.result.paragraphs.find(row => row.editable && row.target.textQuote !== 'Existing revision').target;
    const changed = await materializeDocx({ ...request, operation: { kind: 'tracked-change', target, replacement: 'Distinct revision IDs', attribution } });
    assert.equal(changed.result.kind, 'document');
    const script = 'import sys,io,zipfile,json,xml.etree.ElementTree as E; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); d=E.fromstring(z.read("word/document.xml")); ns="{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"; print(json.dumps([int(e.attrib[ns+"id"]) for e in d.iter() if e.tag in [ns+"ins",ns+"del"]]))';
    const ids = await new Promise((resolve, reject) => {
      const child = execFile('python3', ['-c', script], (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
      child.stdin.end(Buffer.from(changed.result.bytesBase64, 'base64'));
    });
    assert.equal(ids.length, 3, mode);
    assert.equal(new Set(ids).size, 3, mode);
    assert.ok(ids.includes(0), 'original revision is retained');
  }
});
