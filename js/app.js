import { createStore } from './store.js';
import { createEngine } from './engine.js';
import { createSync } from './sync.js';
import { createRecorder, recExt } from './recorder.js';
import { transcribeAudio } from './transcribe.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';
import { shortId, autoTitle, timeLabel, fmtTimer, fmtDateHeader, fmtIndexMeta, countWords, transition, toTxt, fmtCost, findPart, transcriptToSegments } from './helpers.js';

const $ = id => document.getElementById(id);
export const store = createStore(localStorage);

// Gemini API 키 우선순위: env.local.js > Supabase app_secrets(로그인 후) > localStorage(키 입력창).
let envKey = '';
import('./env.local.js').then(m => { envKey = m.GEMINI_KEY || ''; }).catch(() => {});

let remoteKey = '';
async function loadRemoteKey() {
  if (remoteKey || !sb) return;
  // allowlist RLS: 명단에 없는 사용자는 빈 결과 → 키 입력창 폴백
  const { data, error } = await sb.from('app_secrets').select('value').eq('name', 'gemini_key').maybeSingle();
  if (error) { console.error('app_secrets 조회 실패:', error); return; }
  remoteKey = data?.value || '';
}

// ---------- Supabase Auth + 동기화 ----------
// 클라이언트 초기화는 route() 이후 모듈 하단에서 비동기로 수행 —
// CDN(esm.run) 지연/행이 로컬 우선 기능(라우팅·번역·저장)을 막지 않게 한다.
export let sb = null;
let supabaseInitError = null;
let currentUser = null;
const isOAuthCallback = new URLSearchParams(location.search).has('code'); // PKCE 콜백 로드에서만 해시 복원 허용
const GATED = !!(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY); // Supabase 설정 시 로그인해야 앱 진입 (LOCAL ONLY 개발 모드는 게이트 없음)
let gateBypass = false;                    // Supabase 초기화 실패(오프라인 등) 시 로컬 열람용 우회

function onSyncSessionsChanged() {
  if (!currentId && /^#\/s\/[0-9a-f-]{36}$/.test(location.hash)) route();
  else if (!location.hash || location.hash === '#/') renderMain();
}

function onSyncState({ pending, error, signedIn = true }) {
  if (!currentId || uploading) return;    // 업로드 중에는 UPLOADING 안내를 덮지 않는다
  if (!signedIn) $('saved-at').textContent = pending ? `LOCAL SAVED · ${pending} PENDING — SIGN IN TO SYNC` : '';
  else if (error) $('saved-at').textContent = `LOCAL SAVED · SYNC ERROR (${pending} PENDING)`;
  else if (pending) $('saved-at').textContent = `LOCAL SAVED · ${pending} SYNC PENDING`;
  else $('saved-at').textContent = 'SYNCED ' + new Date().toTimeString().slice(0, 8);
}

let sync = createSync({ client: null, store, onSessionsChanged: onSyncSessionsChanged, onState: onSyncState });

export function queueChanged() {
  sync.queueChanged();
}

function paintAuth(user) {
  $('login-btn').disabled = $('login-btn-m').disabled = !sb;
  $('login-skip').hidden = $('login-skip-m').hidden = !supabaseInitError;
  const button = $('btn-signin');
  if (!sb) {
    button.textContent = supabaseInitError ? 'SYNC UNAVAILABLE' : 'LOCAL ONLY';
    button.disabled = true;
    button.title = supabaseInitError?.message || 'Supabase URL과 publishable key를 설정하면 Google 로그인을 사용할 수 있습니다.';
    return;
  }
  button.disabled = false;
  button.textContent = user ? `${(user.email || 'SIGNED IN').toUpperCase()} — SIGN OUT` : 'SIGN IN WITH GOOGLE';
}

async function renderAuth() {
  if (!sb) {
    paintAuth(null);
    return null;
  }
  const { data, error } = await sb.auth.getSession();
  currentUser = error ? null : data.session?.user ?? null;
  paintAuth(currentUser);
  return currentUser;
}

function restoreOAuthRoute() {
  const returnHash = sessionStorage.getItem('relay.authReturnHash');
  if (!returnHash) return;
  sessionStorage.removeItem('relay.authReturnHash');
  if (!isOAuthCallback) return; // 중단된 로그인 시도의 잔여 해시 — 소비만 하고 이동하지 않음 (교차 탭 SIGNED_IN 하이재킹 방지)
  history.replaceState(null, '', `${location.pathname}${returnHash}`);
  route();
}

let syncedUserId = null;
async function syncForUser(user) {
  if (!user || syncedUserId === user.id) return;
  const lastUserId = localStorage.getItem('relay.lastUserId');
  if (lastUserId && lastUserId !== user.id) {
    store.clearLocal();                    // 다른 계정: 이전 계정 데이터 혼입/유출 방지
    route();
  }
  localStorage.setItem('relay.lastUserId', user.id);
  syncedUserId = user.id;
  void loadRemoteKey();                    // 로그인 확정 시 원격 키 1회 조회 (실패해도 번역 시작 시 키 입력창 폴백)
  try {
    if (!await sync.fullSync()) syncedUserId = null;
  } catch (error) {
    syncedUserId = null;                   // 래치 해제 — 다음 auth 이벤트에서 재시도
    console.error('sync: fullSync 실패', error);
  }
}

$('btn-signin').onclick = async () => {
  if (!sb) return;
  if (currentUser) {
    const { error } = await sb.auth.signOut({ scope: 'local' }); // 이 기기만 로그아웃 — 다른 기기 세션 유지
    if (error) alert('로그아웃 실패: ' + error.message);
    else { currentUser = null; paintAuth(null); route(); } // currentUser를 선반영하므로 SIGNED_OUT 이벤트의 변화 감지가 못 잡음 — 여기서 직접 게이트 복귀
    return;
  }

  sessionStorage.setItem('relay.authReturnHash', location.hash || '#/');
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${location.origin}${location.pathname}` },
  });
  if (error) {
    sessionStorage.removeItem('relay.authReturnHash');
    alert('Google 로그인 시작 실패: ' + error.message);
  }
};

$('login-btn').onclick = () => $('btn-signin').onclick();
$('login-btn-m').onclick = async () => {
  $('login-btn-m').classList.add('busy');
  await $('btn-signin').onclick();       // 성공 시 OAuth 리다이렉트로 떠남 — 여기 도달하면 실패 경로
  $('login-btn-m').classList.remove('busy');
};
$('login-skip').onclick = $('login-skip-m').onclick = () => { gateBypass = true; route(); };

function handleAuthChange(_event, session) {
  // Auth 콜백 내부에서 다른 Supabase 호출을 직접 await하지 않고 다음 task로 넘긴다.
  setTimeout(async () => {
    const prevUserId = currentUser?.id ?? null;
    currentUser = session?.user ?? null;
    paintAuth(currentUser);
    if ((currentUser?.id ?? null) !== prevUserId) route(); // 게이트 개폐는 유저가 바뀔 때만 — TOKEN_REFRESHED 등이 라이브 세션을 끊지 않게
    if (!currentUser) {
      syncedUserId = null;
      return;
    }
    restoreOAuthRoute();
    await syncForUser(currentUser);
  }, 0);
}

// ---------- 라우터 ----------
function route() {
  const outgoing = currentId && store.getSession(currentId);
  if (outgoing && (outgoing.status === 'listening' || outgoing.status === 'paused')) {
    engine.stop();                         // paused도 스트림을 보존하므로 화면 이탈 시 반드시 해제
    const leaving = stopRecording();
    void keepAwake(false);
    stopTick();
    store.updateSession(currentId, { status: 'ready', elapsedMs: acc });
    queueChanged();
    void guardUpload(leaving);             // 화면을 떠나도 남은 파트 업로드는 지킨다
  }
  currentId = null;
  if (GATED && !currentUser && !gateBypass) { // 로그인 게이트 — 해시는 보존되어 로그인 후 원래 화면으로 이동
    $('view-main').hidden = true;
    $('view-session').hidden = true;
    $('view-login').hidden = false;
    return;
  }
  $('view-login').hidden = true;
  const m = location.hash.match(/^#\/s\/([0-9a-f-]{36})$/);
  if (m && store.getSession(m[1])) {
    $('view-main').hidden = true;
    $('view-session').hidden = false;
    renderSession(m[1]);
  } else {
    $('view-session').hidden = true;
    $('view-main').hidden = false;
    renderMain();
  }
}
window.addEventListener('hashchange', route);

// ---------- Main ----------
function renderMain() {
  $('hdr-date').textContent = fmtDateHeader(new Date());
  const rows = $('idx-rows');
  rows.replaceChildren();
  store.listSessions().forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'idx-row';
    const num = document.createElement('span');
    num.className = 'idx-num';
    num.textContent = String(i + 1).padStart(2, '0');
    const title = document.createElement('span');
    title.className = 'idx-title' + (s.title ? '' : ' idx-title-auto');
    title.textContent = s.title || autoTitle(new Date(s.createdAt));
    const meta = document.createElement('span');
    meta.className = 'mono idx-meta';
    meta.textContent = fmtIndexMeta(s);
    row.append(num, title, meta);
    row.onclick = () => { location.hash = `#/s/${s.id}`; };
    rows.append(row);
  });
}

$('btn-create').onclick = () => {
  const s = store.createSession();           // 중간 설정 화면 없이 즉시 세션 진입 (디자인 명세)
  queueChanged();
  location.hash = `#/s/${s.id}`;
};

// ---------- 모바일 홈: 원탭 시작 시트 (Relay Mobile Final.dc) ----------
const KO_LANGS = { ko: '한국어', en: '영어', ja: '일본어', 'zh-CN': '중국어', es: '스페인어' };
let sheetMode = 'live';
let autoStartId = null;                   // 시트에서 만든 세션 — renderSession이 진입 즉시 start
function openSheet() {
  const d = new Date();
  $('sheet-date').textContent = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} — 자동 기록`;
  $('sheet-mode-wrap').hidden = !sb || !currentUser; // 녹음 업로드처(Storage) 없으면 REC 선택 숨김
  $('sheet').classList.add('open');
}
$('m-mic').onclick = openSheet;
document.querySelectorAll('.m-chip').forEach(chip => { chip.onclick = openSheet; });
$('sheet-scrim').onclick = () => $('sheet').classList.remove('open');
$('sheet-mode').querySelectorAll('button').forEach(b => {
  b.onclick = () => {
    sheetMode = b.dataset.mode;
    $('sheet-mode').dataset.mode = sheetMode;
    $('sheet-mode-cap').textContent = sheetMode === 'live' ? '실시간으로 번역하며 녹음합니다' : '녹음만 — 종료 후 전사됩니다';
  };
});
$('sheet-lang').onchange = () => { $('m-chip-lang').textContent = `자동 감지 → ${KO_LANGS[$('sheet-lang').value] || $('sheet-lang').value}`; };
$('sheet-start').onclick = () => {
  const rec = sheetMode === 'rec' && sb && currentUser;
  const s = store.createSession({ targetLang: $('sheet-lang').value, mode: rec ? 'rec' : 'live' });
  queueChanged();
  $('sheet').classList.remove('open');
  autoStartId = s.id;
  location.hash = `#/s/${s.id}`;
};

// ---------- Session 컨트롤러 ----------
const LANG_NAMES = { ko: 'KOREAN', en: 'ENGLISH', ja: 'JAPANESE', 'zh-CN': 'CHINESE', es: 'SPANISH' };
let currentId = null;
let acc = 0, since = null, tick = null;   // 타이머: acc=누적ms, since=listening 시작 시각
let needFreshStart = false;               // 소스 전환으로 스트림을 버린 뒤 resume 대신 start가 필요
let autoScroll = true;
let busy = false;                         // doAction 재진입 가드 (start await 중 더블클릭 방지)
const hydrationPromises = new Map();

// 모바일: 화면이 꺼지면 iOS는 마이크 캡처를 중단한다 — listening 동안 화면 유지
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch {} // 저전력 모드 등 거부는 무시 — 기능 저하일 뿐 오류 아님
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return; // 백그라운드 전환 시 브라우저가 자동 해제
  const s = currentId && store.getSession(currentId);
  if (s?.status === 'listening') void keepAwake(true);
});

const elapsedNow = () => acc + (since ? Date.now() - since : 0);

let recParts = 0;                         // 현재 세션의 녹음 파트 수 (기존 파트 포함)
let pendingUploads = [];                  // 업로드 실패 파트 [{sessionId,seq,startMs,durMs,blob,mime,ext}]
let activeRec = null;                     // 진행 중 MediaRecorder
let recStream = null;                     // REC 모드가 직접 잡은 스트림

async function captureStream(source) {
  return source === 'tab'
    ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    : await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
}

function startRecording(stream) {
  if (!sb || !currentUser || activeRec) return;   // 로컬 전용/비로그인: 녹음 없음
  const sessionId = currentId, seq = recParts + 1, startMs = elapsedNow();
  const rec = createRecorder(stream, (blob, mime) => {
    const part = { sessionId, seq, startMs, durMs: Math.max(0, elapsedNow() - startMs), blob, mime, ext: recExt(mime) };
    return uploadPart(part);            // Promise 반환 — rec.stopped가 업로드 완료까지 늘어난다
  });
  if (rec) { activeRec = rec; recParts = seq; }
}

// 업로드 완료 Promise를 반환한다 — 호출자는 guardUpload로 감싸 이탈을 막는다.
function stopRecording() {
  const rec = activeRec;
  if (rec && rec.state !== 'inactive') rec.stop();
  activeRec = null;
  recStream?.getTracks().forEach(t => t.stop());  // REC 모드 원시 캡처도 함께 정리 (LIVE는 null — no-op)
  recStream = null;
  return rec?.stopped ?? Promise.resolve();
}

let uploading = 0;                        // 진행 중 업로드 수
const warnUnload = e => { e.preventDefault(); e.returnValue = ''; };

// 녹음 blob은 메모리에만 있어 페이지가 죽으면 영구 소실된다 (48분 세션 = 16MB, 업로드에 수십 초).
// 끝날 때까지 이탈 경고 + 화면 유지 — 모바일은 beforeunload가 안 먹으므로 wakeLock이 실질 방어다.
async function guardUpload(promise) {
  if (uploading++ === 0) {
    window.addEventListener('beforeunload', warnUnload);
    void keepAwake(true);
  }
  if (currentId) $('saved-at').textContent = 'UPLOADING RECORDING — KEEP THIS SCREEN OPEN';
  try { await promise; }
  finally {
    if (--uploading === 0) {
      window.removeEventListener('beforeunload', warnUnload);
      if (store.getSession(currentId)?.status !== 'listening') void keepAwake(false);
      if ($('saved-at').textContent.startsWith('UPLOADING')) $('saved-at').textContent = '';
    }
  }
}

async function uploadPart(part) {
  try {
    await sync.uploadRecording(part);
    if (currentId === part.sessionId) void loadRecordings(part.sessionId); // Task 7이 구현 — 그 전엔 정의만 있는 no-op
    if (part.sessionId === transcribePendingFor) void runTranscribe(part.sessionId); // Task 8 — 그 전엔 no-op
  } catch (error) {
    console.error('녹음 업로드 실패', error);
    pendingUploads.push(part);
    $('rec-retry').hidden = false;
    $('saved-at').textContent = 'RECORDING UPLOAD FAILED — RETRY BELOW';
  }
}

$('rec-retry').onclick = async () => {
  const retry = pendingUploads; pendingUploads = [];
  $('rec-retry').hidden = true;
  for (const part of retry) await uploadPart(part);
};

let transcribePendingFor = null;
let parts = [];                            // 현재 세션의 녹음 파트 (url 포함)
let pendingSeek = null;
function clearPendingSeek() {
  if (pendingSeek) { $('player').removeEventListener('loadedmetadata', pendingSeek); pendingSeek = null; }
}
async function loadRecordings(id) {
  const fetched = await sync.listRecordings(id);
  if (currentId !== id) return;
  parts = fetched;
  recParts = Math.max(recParts, parts.at(-1)?.seq ?? 0);
  const row = $('player-row');
  row.hidden = !parts.length;
  $('m-player').hidden = !parts.length;
  paintPartLabel();
  $('scroll-region').classList.toggle('has-audio', !!parts.length);
  if (store.getSession(id)?.status === 'ended') renderControls('ended'); // 미전사 파트 여부 반영 (Transcribe 버튼)
  if (!parts.length) return;
  const sel = $('player-part');
  sel.hidden = parts.length < 2;
  sel.replaceChildren(...parts.map((p, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = `PART ${p.seq}`;
    return o;
  }));
  loadPart(0);
}
function loadPart(i, at = 0, play = false) {
  clearPendingSeek();
  const p = parts[i];
  if (!p?.url) return;
  $('player-part').value = i;
  const audio = $('player');
  if (audio.dataset.path !== p.path) { audio.src = p.url; audio.dataset.path = p.path; }
  const apply = () => { pendingSeek = null; audio.currentTime = at; if (play) void audio.play(); };
  if (audio.readyState >= 1) apply();
  else { pendingSeek = apply; audio.addEventListener('loadedmetadata', apply, { once: true }); }
}
$('player-part').onchange = e => loadPart(+e.target.value);

function seekTo(tsMs) {
  const p = findPart(parts, tsMs);
  if (!p) return;
  loadPart(parts.indexOf(p), Math.max(0, (tsMs - p.startMs) / 1000), true);
}
let transcribing = false;
async function runTranscribe(id) {
  if (transcribing) return;
  transcribePendingFor = null;
  const s = store.getSession(id);
  const key = envKey || remoteKey || localStorage.getItem('gemini-key') || '';
  if (!s || !key) { if (currentId === id) { $('key-row').hidden = false; } return; }
  transcribing = true;
  if (currentId === id) $('status-line').textContent = 'TRANSCRIBING…';
  try {
    const recs = (await sync.listRecordings(id)).filter(p => !p.transcribedAt); // 증분: 전사 안 된 파트만
    for (const p of recs) {
      const blob = await (await fetch(p.url)).blob();
      const items = await transcribeAudio({ key, blob, mime: p.path.endsWith('.webm') ? 'audio/webm' : 'audio/mp4', targetLang: s.targetLang });
      for (const g of transcriptToSegments(items, p.startMs)) {
        store.addSegment(id, { ...g, srcLang: null, timeLabel: timeLabel(new Date(s.createdAt + g.tsMs)) });
      }
      // 마커 실패는 치명적이지 않음 — 다음 수동 Transcribe에서 이 파트만 중복될 수 있어 로그만 남김
      await sync.markTranscribed(id, p.seq).catch(e => console.error('전사 마커 실패', e));
    }
    queueChanged();
    if (currentId === id) { renderTranscript(id); $('status-line').textContent = 'TRANSCRIPT READY'; void loadRecordings(id); }
  } catch (error) {
    console.error('사후 전사 실패', error);
    if (currentId === id) $('status-line').textContent = 'TRANSCRIBE FAILED — PRESS TRANSCRIBE TO RETRY';
  } finally {
    transcribing = false;
  }
}

const engine = createEngine({
  getKey: () => envKey || remoteKey || localStorage.getItem('gemini-key') || '',
  getLang: () => $('lang').value,
  onStatus: () => {},                     // 상태 표시는 앱 상태머신이 담당
  onStream(stream) { startRecording(stream); },
  onPartial({ original, translated }) {
    $('cur-original').textContent = original;
    $('cur-translation').replaceChildren(document.createTextNode(translated), $('caret'));
    setFocusPartial(original, translated);
    scrollBottom();
  },
  onSegment(g) {
    if (!currentId) return;                // 라우트 이탈 뒤 도착한 늦은 flush — null 세션 기록/큐 오염 방지
    const seg = store.addSegment(currentId, {
      tsMs: elapsedNow(), timeLabel: timeLabel(new Date()), srcLang: null,
      originalText: g.originalText, translatedText: g.translatedText,
    });
    store.updateSession(currentId, { elapsedMs: elapsedNow() });
    appendSeg(seg);
    setFocusPartial('', '');               // 확정 세그먼트가 포커스 뷰의 '현재' 자리로 승격
    updateStats();
    $('saved-at').textContent = 'AUTO-SAVED ' + new Date().toTimeString().slice(0, 8);
    queueChanged();
    scrollBottom();
  },
  onError(msg) {
    if (msg === 'NO_KEY') { $('key-row').hidden = false; $('api-key').focus(); return; }
    if (msg === 'TRACK_ENDED') { doAction('pause'); return; }   // 사용자가 탭 공유 중단
    if (msg === 'NO_AUDIO_TRACK') { $('src-caption').textContent = 'TAB SHARE NEEDS "SHARE AUDIO" CHECKED'; return; }
    $('status-line').textContent = 'ERROR: ' + msg.toUpperCase().slice(0, 60);
  },
});

function renderSession(id) {
  currentId = id;
  clearPendingSeek();
  $('player').removeAttribute('src'); delete $('player').dataset.path; $('player-row').hidden = true; parts = [];
  const s = store.getSession(id);
  acc = s.elapsedMs; since = null; needFreshStart = false; autoScroll = true;
  $('scroll-region').classList.remove('show-src');
  $('toggle-src').textContent = 'SHOW ORIGINAL';
  // 레일 헤더
  renderTitle();
  const c = new Date(s.createdAt);
  $('s-meta').textContent = `${shortId(s.id)} · ${fmtDateHeader(c).split(' — ')[0]} ${timeLabel(c)} · ${fmtCost(s.elapsedMs || 0)}`;
  // 컨트롤 값 복원
  $('lang').value = s.targetLang;
  setSourceUI(s.source);
  setModeUI(s.mode || 'live');
  $('mode-sec').hidden = !sb || !currentUser;
  recParts = 0;
  $('rec-retry').hidden = !pendingUploads.some(p => p.sessionId === id); // 다른 세션 실패분은 보존 — RETRY는 전 세션 재시도
  void loadRecordings(id);
  // 모바일 리더 초기화
  readerTab = 'ko';
  document.querySelectorAll('.mr-tab[data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === 'ko'));
  renderReaderHead(id);
  closeEndSheet();
  $('m-player').hidden = true;
  $('mp-prog').style.width = '0';
  $('mp-clock').textContent = '0:00 / 0:00';
  paintPlayBtn();
  renderTranscript(id);
  $('saved-at').textContent = '';
  renderStatus(s.status === 'listening' || s.status === 'paused' ? 'ready' : s.status); // 새로고침 복원 시 진행 중이던 세션은 ready로
  if (s.status === 'listening' || s.status === 'paused')
    store.updateSession(id, { status: 'ready' }); // 로컬 복구용 다운그레이드 — 원격 push 금지 (다른 기기의 라이브 세션 row 보호)
  if (store.isRemoteSession(id)) void hydrateSegments(id); // ended뿐 아니라 모든 원격 세션 — 빈/스테일 전사 방지
  focusDismissed = false;
  if (autoStartId === id) {                 // 모바일 시트의 '녹음 시작' — 다크 포커스 뷰를 먼저 띄우고 연결
    autoStartId = null;
    $('f-state').textContent = '연결 중…';
    $('f-lang-txt').textContent = s.mode === 'rec' ? '녹음만 — 종료 후 전사됩니다' : `자동 감지 → ${KO_LANGS[s.targetLang] || s.targetLang}`;
    $('view-session').classList.add('focus-avail', 'focus-on');
    focusAtBottom = true;
    $('focus').classList.remove('scrolled');
    focusScrollBottom();
    doAction('start').then(() => {          // 키 없음/권한 거부 등으로 listening 실패 → 클래식 뷰로 폴백
      const st = store.getSession(id)?.status;
      if (currentId === id && st !== 'listening') paintFocus(st);
    });
  }
}

function renderTranscript(id) {
  $('col-original').replaceChildren();
  $('col-translation').replaceChildren();
  $('f-list').replaceChildren();
  $('mr-list').replaceChildren();
  store.getSegments(id).forEach(appendSeg);
  paintReaderEmpty(id);
  $('cur-original').textContent = '';
  $('cur-translation').replaceChildren($('caret'));
  setFocusPartial('', '');
  updateStats();
  scrollBottom();
}

async function hydrateSegments(id) {
  if (!store.isRemoteSession(id)) return true;
  if (!sb) return store.hasSegments(id); // ponytail: 오프라인/미설정이면 로컬 캐시 유무로만 판단 — 완전성 검증 불가
  if (hydrationPromises.has(id)) return hydrationPromises.get(id);

  const before = store.getSegments(id).length;
  const pending = sync.hydrateSegments(id)
    .catch(error => { console.error('hydrate 실패', error); return false; })
    .then(ok => {
      if (currentId !== id) return ok;
      if (ok && store.getSegments(id).length !== before) renderTranscript(id);
      else if (!ok) $('status-line').textContent = currentUser
        ? 'REMOTE TRANSCRIPT LOAD FAILED — REOPEN TO RETRY'
        : 'SIGN IN TO LOAD THE REMOTE TRANSCRIPT';
      return ok;
    }).finally(() => hydrationPromises.delete(id));
  hydrationPromises.set(id, pending);
  return pending;
}

function dot() { const d = document.createElement('span'); d.className = 'dot'; d.textContent = '.'; return d; }

function renderTitle() {
  const s = store.getSession(currentId);
  $('s-title').replaceChildren(document.createTextNode(s.title || autoTitle(new Date(s.createdAt))), dot());
}

function appendSeg(seg) {
  for (const [col, text] of [['col-original', seg.originalText], ['col-translation', seg.translatedText]]) {
    const p = document.createElement('p');
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = seg.timeLabel;
    ts.onclick = () => { if (parts.length) seekTo(seg.tsMs); };
    p.append(ts, text);
    $(col).append(p);
  }
  appendFocusSeg(seg);
  appendReaderSeg(seg);
}

function updateStats() {
  const segs = store.getSegments(currentId);
  $('footer-stats').textContent = `${segs.length} SEGMENTS · ${countWords(segs)} WORDS`;
}

function scrollBottom() {
  if (autoScroll) $('scroll-region').scrollTop = $('scroll-region').scrollHeight;
}
$('scroll-region').addEventListener('scroll', () => {
  const el = $('scroll-region');
  autoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
});

// ---------- 모바일 라이브 포커스 뷰 (Relay Mobile Final.dc — 03 라이브) ----------
let focusDismissed = false;               // ◇ 버튼으로 리더 뷰 전환 — 세션 상태가 live를 벗어나면 리셋
let endSheetOpen = false;                 // ■ 종료 후 다크 시트가 떠 있는 동안 오버레이 유지
let focusAtBottom = true, focusPrefix = '녹음 중';
{ // 웨이브 바 24개 — 디자인의 고정 높이/지연 값
  const hs = [6, 10, 16, 22, 28, 20, 12, 24, 32, 26, 17, 10, 14, 22, 30, 21, 12, 8, 15, 25, 29, 18, 10, 7];
  $('f-wave').replaceChildren(...hs.map((h, i) => {
    const b = document.createElement('i');
    b.style.height = h + 'px';
    b.style.animationDelay = ((i % 7) * 0.12).toFixed(2) + 's';
    return b;
  }));
}
function focusScrollBottom(smooth = false) {
  $('f-scroll').scrollTo({ top: $('f-scroll').scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}
$('f-scroll').addEventListener('scroll', () => {
  const el = $('f-scroll');
  focusAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  $('focus').classList.toggle('scrolled', !focusAtBottom);
});
$('f-pill').onclick = () => focusScrollBottom(true);
$('f-pause').onclick = () => doAction(store.getSession(currentId)?.status === 'listening' ? 'pause' : 'resume');
$('f-stop').onclick = () => {
  endSheetOpen = true;                    // doAction 중 renderStatus('ended')가 오버레이를 내리지 않게 선세팅
  doAction('end').then(() => {
    if (store.getSession(currentId)?.status === 'ended') openEndSheet();
    else endSheetOpen = false;
  });
};
$('f-exit').onclick = () => { focusDismissed = true; paintFocus(store.getSession(currentId)?.status); };
$('f-return').onclick = () => { focusDismissed = false; paintFocus(store.getSession(currentId)?.status); };
$('f-cur').onclick = () => { $('f-cur-orig').hidden = !$('f-cur-orig').hidden; };

function appendFocusSeg(seg) {
  const d = document.createElement('div');
  d.className = 'fseg';
  const tx = document.createElement('div');
  tx.className = 'ftx';
  tx.textContent = seg.translatedText;
  const orig = document.createElement('div');
  orig.className = 'f-orig';
  orig.hidden = true;
  const label = document.createElement('b');
  label.textContent = 'ORIGINAL';
  const body = document.createElement('div');
  body.textContent = seg.originalText;
  orig.append(label, body);
  d.append(tx, orig);
  d.onclick = () => { orig.hidden = !orig.hidden; };
  $('f-list').append(d);
  if (focusAtBottom) focusScrollBottom();
}

function setFocusPartial(original, translated) {
  $('f-cur').textContent = translated;
  $('f-cur').hidden = !translated;
  $('f-inner').classList.toggle('has-partial', !!translated);
  $('f-cur-orig').lastElementChild.textContent = original;
  if (!translated) $('f-cur-orig').hidden = true;
  if (focusAtBottom) focusScrollBottom();
}

function paintFocus(status) {
  const live = status === 'listening' || status === 'paused' || (status === 'ended' && endSheetOpen);
  if (!live) focusDismissed = false;
  const wasOn = $('view-session').classList.contains('focus-on');
  $('view-session').classList.toggle('focus-avail', status === 'listening' || status === 'paused');
  $('view-session').classList.toggle('focus-on', live && !focusDismissed);
  if (!wasOn && live && !focusDismissed) { // 켜지는 순간: display:none 동안 렌더된 히스토리는 scrollTop 0 — 바닥으로
    focusAtBottom = true;
    $('focus').classList.remove('scrolled');
    focusScrollBottom();
  }
  if (!live) return;
  $('focus').classList.toggle('paused', status !== 'listening');
  const rec = store.getSession(currentId)?.mode === 'rec';
  focusPrefix = status === 'ended' ? '세션 종료됨' : status === 'paused' ? '일시정지됨' : '녹음 중';
  $('f-state').textContent = `${focusPrefix} — ${fmtTimer(elapsedNow())}`;
  $('f-pause').innerHTML = status === 'listening' ? svgPause('#EFE8DA') : svgPlay('#EFE8DA');
  $('f-lang-txt').textContent = rec ? '녹음만 — 종료 후 전사됩니다' : `자동 감지 → ${KO_LANGS[$('lang').value] || $('lang').value}`;
  $('f-hint').textContent = rec ? '종료하면 자동으로 전사·번역됩니다' : '↑ 스크롤 — 지난 내용 · 탭 — 원문';
}

// ---------- 라이브 종료 시트 (03 — 세션 종료됨) ----------
function paintEndMode() {
  const mode = store.getSession(currentId)?.mode || 'live';
  $('end-mode').dataset.mode = mode;
  $('end-mode-cap').textContent = (mode === 'live' ? '실시간으로 번역하며 녹음' : '녹음만 — 종료 후 전사') + ' · 다음 구간부터 적용';
}
function openEndSheet() {
  endSheetOpen = true;
  const s = store.getSession(currentId);
  const n = store.getSegments(currentId).length;
  $('end-summary').textContent = `${fmtTimer(s.elapsedMs || 0)} · ${s.mode === 'rec' && !n ? '녹음 저장됨 — 전사 중' : `${n}문장 저장됨`}`;
  $('end-lang').value = s.targetLang;
  $('end-mode-wrap').hidden = !sb || !currentUser;
  paintEndMode();
  $('end-set').classList.remove('open');
  $('end-set-toggle').classList.remove('active');
  paintFocus('ended');
  $('end-layer').classList.add('open');
}
function closeEndSheet() {
  endSheetOpen = false;
  $('end-layer').classList.remove('open');
}
$('end-resume').onclick = () => {
  closeEndSheet();
  doAction('resume').then(() => {
    const st = store.getSession(currentId)?.status;
    if (currentId && st !== 'listening') paintFocus(st); // 재개 실패 → 리더 뷰로
  });
};
$('end-view').onclick = () => { closeEndSheet(); paintFocus('ended'); renderTranscript(currentId); }; // 최신 상태(전사 완료분/빈 상태 안내) 반영
$('end-set-toggle').onclick = () => {
  $('end-set').classList.toggle('open');
  $('end-set-toggle').classList.toggle('active');
};
$('end-lang').onchange = e => { $('lang').value = e.target.value; $('lang').dispatchEvent(new Event('change')); }; // 기존 언어 변경 경로 재사용
$('end-mode').querySelectorAll('button').forEach(b => {
  b.onclick = () => { switchMode(b.dataset.mode); paintEndMode(); };
});

// ---------- 모바일 세션 리더 (04 세션 열람) ----------
let readerTab = 'ko';
const mmss = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function renderReaderHead(id) {
  const s = store.getSession(id);
  $('mr-title').replaceChildren(document.createTextNode(s.title || autoTitle(new Date(s.createdAt))), dot());
  const c = new Date(s.createdAt);
  $('mr-meta').textContent = `${shortId(s.id)} · ${fmtDateHeader(c).split(' — ')[0]} ${timeLabel(c)} · ${Math.round((s.elapsedMs || 0) / 60000)}분 · ${fmtCost(s.elapsedMs || 0)}`;
}

function appendReaderSeg(seg) {
  $('mr-list').querySelector('.mr-empty')?.remove();
  const row = document.createElement('div');
  row.className = 'mr-row';
  row.dataset.ts = seg.tsMs;
  const ts = document.createElement('span');
  ts.className = 'mr-ts';
  ts.textContent = seg.timeLabel;
  const body = document.createElement('div');
  body.className = 'mr-body';
  if (readerTab === 'both') {
    const sub = document.createElement('span');
    sub.className = 'mr-sub';
    sub.textContent = seg.originalText;
    body.append(sub);
  }
  const main = document.createElement('span');
  main.className = 'mr-main';
  main.textContent = readerTab === 'en' ? seg.originalText : seg.translatedText;
  body.append(main);
  row.append(ts, body);
  row.onclick = () => { if (parts.length) seekTo(seg.tsMs); };
  $('mr-list').append(row);
}

function renderReaderList(id) {
  $('mr-list').replaceChildren();
  store.getSegments(id).forEach(appendReaderSeg);
  paintReaderEmpty(id);
}

// REC 종료 직후엔 전사가 백그라운드 진행 중 — 빈 화면 대신 상태를 알린다
function paintReaderEmpty(id) {
  if ($('mr-list').children.length) return;
  const s = store.getSession(id);
  if (!s) return;
  const d = document.createElement('div');
  d.className = 'mr-empty';
  d.textContent = s.mode === 'rec' && s.status === 'ended'
    ? '전사 중입니다 — 완료되면 자동으로 표시됩니다'
    : '아직 기록이 없습니다';
  $('mr-list').append(d);
}

document.querySelectorAll('.mr-tab[data-tab]').forEach(b => {
  b.onclick = () => {
    readerTab = b.dataset.tab;
    document.querySelectorAll('.mr-tab[data-tab]').forEach(x => x.classList.toggle('on', x === b));
    renderReaderList(currentId);
  };
});

$('mr-copy').onclick = async () => {
  const line = g => readerTab === 'en' ? g.originalText : readerTab === 'both' ? `${g.originalText}\n${g.translatedText}` : g.translatedText;
  await navigator.clipboard.writeText(store.getSegments(currentId).map(g => `[${g.timeLabel}] ${line(g)}`).join('\n'));
  $('mr-copy').textContent = '복사됨 ✓';
  $('mr-copy').classList.add('copied');
  setTimeout(() => { $('mr-copy').textContent = '전체 복사'; $('mr-copy').classList.remove('copied'); }, 1600);
};

$('mr-back').onclick = () => { location.hash = '#/'; };
$('mr-resume').onclick = () => {         // 리더에서 이어서 진행 (디자인 외 추가 — ← 세션 줄 우측 pill)
  const st = store.getSession(currentId)?.status;
  void doAction(st === 'ready' ? 'start' : 'resume');
};

// #status-line 미러 — 전사 진행/오류만 리더에 표시
new MutationObserver(() => {
  const t = $('status-line').textContent;
  const show = /TRANSCRIB|ERROR|FAILED|SIGN IN/.test(t);
  $('mr-status').hidden = !show;
  if (show) $('mr-status').textContent = t;
}).observe($('status-line'), { childList: true });

// 하단 플레이어 카드 — 숨겨진 <audio id="player">를 구동
// 텍스트 글리프(▶/❚❚)는 원 안에서 중심이 안 맞아 디자인의 SVG 아이콘 사용
const svgPlay = fill => `<svg width="15" height="15" viewBox="0 0 14 14" style="margin-left:2px"><path d="M3 1.5l9 5.5-9 5.5z" fill="${fill}"></path></svg>`;
const svgPause = fill => `<svg width="14" height="14" viewBox="0 0 16 16"><rect x="3" y="2.5" width="3.4" height="11" rx="1.4" fill="${fill}"></rect><rect x="9.6" y="2.5" width="3.4" height="11" rx="1.4" fill="${fill}"></rect></svg>`;
function paintPlayBtn() { $('mp-btn').innerHTML = $('player').paused ? svgPlay('#F6F2E9') : svgPause('#F6F2E9'); }
function paintPartLabel() {
  const i = +($('player-part').value || 0);
  $('mp-part').textContent = `PART ${parts[i]?.seq ?? 1}${parts.length > 1 ? ' ▾' : ''}`;
}
$('mp-btn').onclick = () => {
  const p = $('player');
  if (!p.getAttribute('src')) { if (parts.length) loadPart(0, 0, true); return; }
  if (p.paused) void p.play(); else p.pause();
};
$('mp-part').onclick = () => {
  if (parts.length > 1) { loadPart((+($('player-part').value || 0) + 1) % parts.length); paintPartLabel(); }
};
$('player').addEventListener('play', paintPlayBtn);
$('player').addEventListener('pause', paintPlayBtn);
$('player').addEventListener('timeupdate', () => {
  const p = $('player');
  const dur = p.duration || 0;
  $('mp-prog').style.width = dur ? `${p.currentTime / dur * 100}%` : '0%';
  $('mp-clock').textContent = `${mmss(p.currentTime)} / ${mmss(dur)}`;
  const engaged = !p.paused || p.currentTime > 0;
  const base = parts[+($('player-part').value || 0)]?.startMs ?? 0;
  const now = base + p.currentTime * 1000;
  let active = null;
  for (const row of $('mr-list').children) if (engaged && +row.dataset.ts <= now) active = row;
  for (const row of $('mr-list').children) row.classList.toggle('on', row === active);
});

// ---------- 상태머신 ----------
async function doAction(action) {
  if (busy) return;
  const actionId = currentId;
  const s = store.getSession(actionId);
  if (!s) return;
  const next = transition(s.status, action);
  if (!next) return;
  let endUpload = null;
  busy = true;
  try {
    if (action === 'start') {
      if (!await hydrateSegments(actionId)) return; // 원격 세션은 전사 하이드레이션 후에만 시작 — seq 충돌로 원격 전사 덮어쓰기 방지
      if (currentId !== actionId) return;
      await loadRecordings(actionId);     // recParts 복원 대기 — 기존 파트 seq 충돌(덮어쓰기) 방지
      if (currentId !== actionId) return;
      if (s.mode === 'rec') {
        recStream = await captureStream(s.source);
        const track = recStream.getAudioTracks()[0];
        if (!track) { recStream.getTracks().forEach(t => t.stop()); recStream = null; $('src-caption').textContent = 'TAB SHARE NEEDS "SHARE AUDIO" CHECKED'; return; }
        track.addEventListener('ended', () => doAction('pause'));
        startRecording(recStream);
      } else {
        await engine.start(s.source);      // onStream 콜백이 녹음 시작
      }
      if (currentId !== actionId) { engine.stop(); stopRecording(); return; }
      startTick();
    }
    else if (action === 'pause') { if (s.mode !== 'rec') engine.pause(); activeRec?.pause(); stopTick(); }
    else if (action === 'resume') {
      if (s.status !== 'paused' && !await hydrateSegments(actionId)) return; // paused는 이 기기가 라이브 작성자 — 캐시가 정본
      if (currentId !== actionId) return;
      if (s.status === 'paused' && activeRec?.state === 'paused') {
        if (s.mode !== 'rec') await engine.resume();
        activeRec.resume();
      } else {                              // ended→resume 또는 fresh start: 새 파트
        await loadRecordings(actionId);     // recParts 복원 대기 — 기존 파트 seq 충돌(덮어쓰기) 방지
        if (currentId !== actionId) return;
        if (s.mode === 'rec') {
          recStream = await captureStream(s.source);
          if (!recStream.getAudioTracks()[0]) { recStream.getTracks().forEach(t => t.stop()); recStream = null; return; }
          startRecording(recStream);
        } else if (needFreshStart || s.status === 'ended') { await engine.start(s.source); needFreshStart = false; }
        else await engine.resume();
      }
      if (currentId !== actionId) { engine.stop(); stopRecording(); return; }
      startTick();
    }
    else if (action === 'end') {
      if (s.mode === 'rec') transcribePendingFor = actionId; // 업로드 완료 후 자동 전사 — 전사 안 된 파트만 증분 처리
      if (s.mode !== 'rec') engine.stop();
      endUpload = stopRecording();       // 상태 저장은 막지 않고, 아래에서 가드만 건다
      stopTick();
    }
  } catch (e) {
    void guardUpload(stopRecording());
    if (e.message !== 'NO_KEY' && currentId === actionId)
      $('status-line').textContent = 'ERROR: ' + e.message.toUpperCase().slice(0, 60);
    return; // 상태 전이 취소
  } finally {
    busy = false;
  }
  store.updateSession(actionId, { status: next, elapsedMs: acc, ...(next === 'ended' ? { endedAt: Date.now() } : next === 'listening' ? { endedAt: null } : {}) });
  renderStatus(next);
  void keepAwake(next === 'listening');
  queueChanged();
  if (endUpload) void guardUpload(endUpload); // keepAwake 뒤 — 업로드 동안 화면을 다시 붙잡는다
}

function startTick() { since = Date.now(); tick = setInterval(() => { const t = fmtTimer(elapsedNow()); $('timer').textContent = t; $('f-state').textContent = `${focusPrefix} — ${t}`; }, 500); }
function stopTick() { if (since) acc += Date.now() - since; since = null; clearInterval(tick); $('timer').textContent = fmtTimer(acc); }

function renderStatus(status) {
  const chip = $('status-chip'), wf = $('waveform'), tm = $('timer'), line = $('status-line');
  const langName = LANG_NAMES[$('lang').value] || $('lang').value.toUpperCase();
  wf.classList.toggle('live', status === 'listening');
  $('caret').hidden = status !== 'listening';
  tm.style.color = status === 'listening' ? 'var(--ink)' : 'var(--disabled-text)';
  chip.style.color = status === 'listening' ? 'var(--acc)' : 'var(--muted)';
  const rec = store.getSession(currentId)?.mode === 'rec';
  chip.textContent = { ready: '○ READY', listening: rec ? '● RECORDING' : '● LISTENING', paused: '❚❚ PAUSED', ended: '— ENDED' }[status];
  line.style.color = status === 'listening' ? 'var(--acc)' : 'var(--muted)';
  line.textContent = status === 'listening' ? (rec ? '● RECORDING — TRANSCRIPT AFTER END' : `● TRANSLATING TO ${langName}`) : 'SOURCE LANGUAGE AUTO-DETECTED';
  $('hdr-target').textContent = langName;
  renderControls(status);
  paintFocus(status);
}

function renderControls(status) {
  const box = $('controls');
  box.replaceChildren();
  const mk = (label, cls, onclick, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    if (disabled) b.disabled = true; else b.onclick = onclick;
    box.append(b);
  };
  const rec = store.getSession(currentId)?.mode === 'rec';
  if (status === 'ready') { mk(rec ? 'Start recording' : 'Start translation', 'btn-acc', () => doAction('start')); mk('End session', '', null, true); }
  else if (status === 'listening') { mk('❚❚ Pause', 'btn-ink-line', () => doAction('pause')); mk('End session', 'btn-acc-line', () => doAction('end')); }
  else if (status === 'paused') { mk('▶ Resume', 'btn-acc', () => doAction('resume')); mk('End session', 'btn-acc-line', () => doAction('end')); }
  else {
    mk('▶ Resume session', 'btn-acc', () => doAction('resume'));
    const s = store.getSession(currentId);
    if (s?.mode === 'rec' && parts.some(p => !p.transcribedAt))
      mk('Transcribe', 'btn-acc-line', () => runTranscribe(currentId));
    else box.firstChild.style.gridColumn = '1 / -1';
  }
}

// ---------- 레일 컨트롤 이벤트 ----------
$('lang').addEventListener('change', () => {
  store.updateSession(currentId, { targetLang: $('lang').value });
  engine.restartLanguage();               // listening 중이면 새 언어로 재연결, 아니면 no-op
  renderStatus(store.getSession(currentId).status);
  queueChanged();
});

function setSourceUI(source) {
  $('src-mic').classList.toggle('seg-on', source === 'mic');
  $('src-tab').classList.toggle('seg-on', source === 'tab');
  $('src-caption').textContent = source === 'mic' ? 'INPUT: MICROPHONE' : 'INPUT: BROWSER TAB AUDIO';
}
async function switchSource(source) {
  const s = store.getSession(currentId);
  if (s.source === source) return;
  if (s.status === 'listening') await doAction('pause'); // 디자인 명세: 전환은 일시정지 후 재시작
  if (s.status !== 'ready') { engine.stop(); stopRecording(); needFreshStart = true; } // 이전 소스 스트림 폐기
  store.updateSession(currentId, { source });
  setSourceUI(source);
  queueChanged();
}
$('src-mic').onclick = () => switchSource('mic');
$('src-tab').onclick = () => switchSource('tab');

function setModeUI(mode) {
  $('mode-live').classList.toggle('seg-on', mode === 'live');
  $('mode-rec').classList.toggle('seg-on', mode === 'rec');
  $('mode-caption').textContent = mode === 'live' ? 'TRANSLATES IN REAL TIME + RECORDS' : 'RECORDS ONLY — TRANSCRIBED AFTER END';
}
function switchMode(mode) {
  const s = store.getSession(currentId);
  if (s.mode === mode) return;
  if (s.status !== 'ready' && s.status !== 'ended') return; // 진행 중 전환 금지
  store.updateSession(currentId, { mode });
  setModeUI(mode);
  renderStatus(store.getSession(currentId).status);
  queueChanged();
}
$('mode-live').onclick = () => switchMode('live');
$('mode-rec').onclick = () => switchMode('rec');

$('playback').addEventListener('change', e => engine.setPlayback(e.target.checked));

$('api-key').addEventListener('change', e => {
  localStorage.setItem('gemini-key', e.target.value.trim());
  $('key-row').hidden = true;
});

$('back-link').onclick = () => { location.hash = '#/'; };

$('toggle-src').onclick = () => {
  const on = $('scroll-region').classList.toggle('show-src');
  $('toggle-src').textContent = on ? 'SHOW TRANSLATION' : 'SHOW ORIGINAL';
};

// ---------- SAVE ----------
const currentTxt = () => {
  const s = store.getSession(currentId);
  return toTxt(s, store.getSegments(currentId));
};

$('save-txt').onclick = () => {
  const s = store.getSession(currentId);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([currentTxt()], { type: 'text/plain' }));
  a.download = `relay-${(s.title || autoTitle(new Date(s.createdAt))).replaceAll(' ', '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$('save-copy').onclick = async () => {
  await navigator.clipboard.writeText(currentTxt());
  $('save-copy').textContent = 'COPIED';
  setTimeout(() => { $('save-copy').textContent = 'COPY'; }, 1200);
};

// ---------- 제목 인라인 rename ----------
$('s-title').onclick = () => {
  if ($('s-title').querySelector('input')) return;
  const s = store.getSession(currentId);
  const input = document.createElement('input');
  input.value = s.title || '';
  input.placeholder = autoTitle(new Date(s.createdAt));
  input.style.cssText = 'font:inherit;width:100%;border:none;border-bottom:1px solid var(--ink);background:none;outline:none';
  const commit = () => {
    store.updateSession(currentId, { title: input.value.trim() || null });
    queueChanged();
    renderTitle(); // 전체 renderSession 금지 — 청취 중 rename 시 상태 리셋(새로고침 복원 로직)이 라이브 엔진과 어긋남
  };
  input.onblur = commit;
  input.onkeydown = e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.onblur = null; renderTitle(); } };
  $('s-title').replaceChildren(input);
  input.focus();
};

route();
paintAuth(null);                          // Supabase 초기화 전까지 LOCAL ONLY 표시

if (SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY) {
  (async () => {
    try {
      const { createClient } = await import('https://esm.run/@supabase/supabase-js@2');
      sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          flowType: 'pkce',                // OAuth 콜백을 query로 받아 해시 라우터와 충돌 방지
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
        },
      });
    } catch (error) {
      supabaseInitError = error;
      console.error('Supabase client initialization failed:', error);
      paintAuth(null);
      return;
    }
    sync.dispose();
    sync = createSync({ client: sb, store, onSessionsChanged: onSyncSessionsChanged, onState: onSyncState });
    sb.auth.onAuthStateChange(handleAuthChange);
    const user = await renderAuth();
    if (user) {
      route();                             // 게이트 해제 (INITIAL_SESSION 경로와 중복 호출은 무해)
      restoreOAuthRoute();
      await syncForUser(user);
    }
  })().catch(error => console.error('Supabase init 실패:', error));
}
