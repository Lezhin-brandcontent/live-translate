import { test } from 'node:test';
import assert from 'node:assert/strict';

// recorder.js가 쓰는 브라우저 전역 두 개만 대역으로 세운다 (import 전에 필요).
class FakeRecorder {
  static isTypeSupported() { return true; }
  constructor(stream, opts) { this.stream = stream; this.opts = opts; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop(); }
}
globalThis.MediaRecorder = FakeRecorder;
globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };

const { createRecorder } = await import('../js/recorder.js');
const flush = () => new Promise(r => setImmediate(r));
const fakeStream = { getAudioTracks: () => ['audio'] };

// 회귀 방지: 이 계약이 깨지면 END 직후 페이지를 떠날 때 녹음이 통째로 소실된다.
test('stopped: onBlob이 돌려준 업로드 Promise가 끝나야 resolve', async () => {
  let finishUpload;
  const upload = new Promise(r => { finishUpload = r; });
  const rec = createRecorder(fakeStream, () => upload);

  let done = false;
  rec.stopped.then(() => { done = true; });

  rec.stop();
  await flush();
  assert.equal(done, false, 'stop() 직후엔 업로드가 아직 진행 중이어야 한다');

  finishUpload();
  await rec.stopped;
  assert.equal(done, true, '업로드가 끝나면 stopped도 완료된다');
});

test('stopped: onBlob에 blob과 mime이 전달된다', async () => {
  let got = null;
  const rec = createRecorder(fakeStream, (blob, mime) => { got = { blob, mime }; });
  rec.stop();
  await rec.stopped;
  assert.equal(got.mime, 'audio/mp4');
  assert.ok(got.blob instanceof Blob);
});
