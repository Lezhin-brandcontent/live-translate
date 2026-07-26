// MediaRecorder 래퍼 — 오디오 트랙만 복제해 압축 녹음. DOM 금지.
// mp4(AAC) 우선: iPhone Safari가 webm/opus를 재생하지 못하므로 교차 기기 다시듣기의 공통 포맷.
export function pickRecMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  return null;
}

export const recExt = mime => (mime === 'audio/mp4' ? 'm4a' : 'webm');

export function createRecorder(stream, onBlob) {
  const mime = pickRecMime();
  if (!mime) return null;
  // 탭 소스는 비디오 트랙 포함 — 오디오만 복제해 순수 오디오 파일을 만든다
  const rec = new MediaRecorder(new MediaStream(stream.getAudioTracks()),
    { mimeType: mime, audioBitsPerSecond: 48000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  // stopped: onBlob이 돌려준 업로드 Promise로 resolve — stop()은 즉시 반환하고 blob은
  // 비동기 onstop에서야 생기므로, 호출자가 업로드 완료를 기다리려면 이 핸들이 필요하다.
  let settle;
  rec.stopped = new Promise(resolve => { settle = resolve; });
  rec.onstop = () => settle(onBlob(new Blob(chunks, { type: mime }), mime));
  rec.start(1000); // 1s 청크 — 크래시 시 브라우저가 이미 모은 청크는 보존
  return rec;
}
