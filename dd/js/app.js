/* 화면 + 저장 + 타이머. 로테이션 판단은 engine.js(DealerEngine)에 맡긴다. */
(function () {
  'use strict';

  const E = window.DealerEngine;
  const EV = window.DealerEvents;
  const AC = window.DealerAccount;
  const S = window.DealerSync;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const VIEW = params.get('view');
  // Holdem TD(토너먼트 관리 프로그램) 안에 iframe 으로 들어가 있으면 '내장 모드' — 맨 아래 'Holdem TD 내장 모드' 다리가 부모와 통신한다
  const embedded = (() => { try { return window.parent !== window; } catch (e) { return false; } })();
  if (embedded) document.documentElement.classList.add('embedded');
  const isBoard = VIEW === 'board'; // 딜러룸 TV
  const SHOW_TV = false; // TV용(보드 화면)은 당분간 숨김 — 버튼·링크만 감추고 기능(?view=board)은 그대로 (사용자 요청 2026-10-18)
  const isMe = VIEW === 'me';       // 딜러 휴대폰
  const ME_KEY = 'dealer-director:me';
  const PUBLIC_URL = 'https://dealer-director.web.app/'; // 배포 주소 (Firebase Hosting)
  const TABS = ['rotation', 'attendance', 'notice'];

  function loadJson(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
  }
  function saveJson(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { /* 저장 불가 */ }
  }

  // 이 사이트의 파이어베이스 (웹 설정값은 공개용 — 보안은 보안 규칙이 맡는다).
  // 이 PC(localhost)에서 시험할 때만 에뮬레이터로 바꿀 수 있다 (dealer-director:dev)
  const FB = (function () {
    const live = { apiKey: 'AIzaSyB3Rz0s_JtayM3uZnOREFPIg9aTUv1IpQs', databaseURL: 'https://dealer-director-default-rtdb.asia-southeast1.firebasedatabase.app' };
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return live;
    const dev = loadJson('dealer-director:dev');
    if (!dev || !dev.databaseURL) return live;
    if (dev.authBase) S.setEndpoints({ auth: dev.authBase, token: dev.tokenBase });
    return { apiKey: dev.apiKey || 'dev', databaseURL: dev.databaseURL };
  })();

  // 예전 '딜러 DB'(연락처·계좌)는 기능째 없앴다 — 이 브라우저에 남아 있던 개인정보도 지운다
  try { localStorage.removeItem('dealer-director:db'); } catch (e) { /* 저장소를 못 쓰는 환경 */ }
  // 계정 기능 전(로그인 없이) 쓰던 데이터: 이벤트 기능 전 것이면 '기존 대회' 이벤트로 바꿔 둔다 → 로그인할 때 계정으로 옮김
  try { EV.migrateLegacy(localStorage, Date.now()); } catch (e) { /* 저장소를 못 쓰는 환경 */ }

  // ---------- 계정 (로그인) ----------
  // 판매자가 만들어 준 DD 계정으로 로그인한다. 이 PC의 저장도 계정마다 따로(store).
  // 딜러 휴대폰·딜러룸 TV(공유 링크로 연 것)는 로그인 없이 본다.
  const AUTH_KEY = 'dealer-director:auth';         // {uid, email, refreshToken, sid, name, until, admin}
  const EMAIL_KEY = 'dealer-director:last-email';  // 로그인 칸에 미리 넣어 둘 이메일
  const READ_KEY = 'dealer-director:sync-read';    // 딜러 휴대폰·보드: {db, room}

  // 읽기 전용 화면(딜러 휴대폰·보드)이 공유 방을 보는 경우 — 링크에 방 정보가 있거나, 휴대폰이 기억하고 있을 때
  let remote = null;
  if (isMe || isBoard) {
    if (params.get('db') && params.get('r')) {
      remote = { db: params.get('db'), room: params.get('r') };
      saveJson(READ_KEY, remote);
    } else if (isMe) {
      remote = loadJson(READ_KEY);
    }
  }

  let auth = remote ? null : loadJson(AUTH_KEY);
  if (auth && !(auth.uid && auth.refreshToken && auth.sid)) auth = null;
  let store = auth ? AC.scoped(localStorage, auth.uid) : null;
  const needLogin = !auth && !remote && !isMe;    // 로그인 화면
  const isAdminView = !!auth && !isMe && !isBoard && params.has('admin'); // 판매자 관리자 화면
  const isDirector = !!auth && !isMe && !isBoard; // 디렉터 PC (목록·이벤트·관리자) — 한 PC 확인·이용 기간 확인

  // ---------- 이벤트 ----------
  // 디렉터 화면은 이벤트 하나를 열어서 쓴다 (주소 ?e=이벤트id). 없으면 이벤트 목록 화면.
  // 이벤트마다 로테이션·출퇴근·기록과 딜러용 링크(QR)가 따로다.
  function eventList() {
    try { return store ? EV.list(store) : []; } catch (e) { return []; }
  }
  // (?view=me&e= / ?view=board&e= 는 같은 브라우저에서 그 이벤트를 휴대폰·TV 화면으로 미리 볼 때)
  const wantEvent = auth ? params.get('e') : null;
  let event = wantEvent ? EV.find(eventList(), wantEvent) : null;
  // 이 PC에 아직 없는 이벤트(다른 PC에서 만든 것 등) → 계정에서 받아 온 뒤 다시 연다
  const needFetch = isDirector && !isAdminView && !!wantEvent && (!event || store.getItem(EV.stateKey(wantEvent)) == null);
  if (needFetch) event = null;
  const isList = isDirector && !isAdminView && !wantEvent; // 이벤트 목록 화면
  const KEY = event ? EV.stateKey(event.id) : null;
  const homeUrl = () => location.pathname; // 이벤트 목록 (주소에서 ?e= 를 뺀 것)
  const eventUrl = id => `${location.pathname}?e=${encodeURIComponent(id)}#rotation`;

  const PAST_COLS = 3;   // 표에 보여줄 지난 교대 수
  const FUTURE_COLS = 6; // 표에 보여줄 예정 교대 수

  // ---------- 저장 (이 PC + 계정, 같은 브라우저의 다른 탭/창과 자동 동기화) ----------
  // 바뀔 때마다 이 PC(계정 전용 공간)에 바로 저장하고, 잠시 뒤 계정(클라우드)에도 올린다 (아래 '계정에 저장')

  function load() {
    if (!KEY) return null;
    try { return JSON.parse(store.getItem(KEY)); } catch (e) { return null; }
  }
  let saveFailed = false; // 저장이 안 되면 새로 고칠 때 대회가 사라진다 → 화면 위에 계속 경고
  function save(s) {
    if (!KEY) return;
    try {
      store.setItem(KEY, JSON.stringify(s));
      saveFailed = false;
    } catch (e) {
      saveFailed = true; // 저장 불가 환경(시크릿 창 등): 메모리로만 동작
    }
  }

  let state = E.migrate(load());
  let warnedFor = null;
  let dueAlertFor = null;
  let sheetView = 'dealer'; // 항상 딜러 이름이 왼쪽인 표로 시작 (테이블별은 눌렀을 때만 잠깐)
  let pick = null;          // 로테이션 표에서 끌고 있거나 눌러서 고른 휴식 칸 {n, id}
  let assignTableId = null;
  let meWarnedFor = null;
  let meEoSeen = null;
  let inboxKey = null;      // 휴대폰 답·출근 체크 받는 함을 연 방 (안 열었으면 null) — syncInbox
  let guestRoomChecked = false; // 같이 쓰기에 들어온 이벤트: 주인의 딜러 QR 방을 이번에 받아 왔나

  // label이 있으면 되돌리기 목록에 쌓는다 (디렉터 작업). 교대·퇴근 희망 표시 등은 label 없이
  function commit(next, label) {
    if (!next || next === state || blocked) return; // 로그아웃된 화면에서는 바꾸지 않는다
    if (label) next = E.remember(state, next, label, Date.now());
    state = next;
    save(state);
    if (event) markChanged(event.id);
    schedulePublish();
    render();
  }

  // 같은 브라우저의 다른 창에서 바뀐 것 반영 (이 이벤트 상태, 이벤트 목록, 로그인)
  window.addEventListener('storage', e => {
    if (remote) return;
    if (e.key === AUTH_KEY) {
      const next = loadJson(AUTH_KEY);
      // 비밀번호를 바꿔 로그인 열쇠만 새로 받은 경우는 그대로 이어서, 로그아웃·다시 로그인이면 화면을 새로
      if (auth && next && next.uid === auth.uid && next.sid === auth.sid) {
        auth = next;
        idTok = null;
      } else if (auth || next) {
        location.reload();
      }
      return;
    }
    if (!store || blocked) return;
    if (KEY && e.key === store.key(KEY)) {
      const fresh = load();
      if (fresh) state = E.migrate(fresh);
    } else if (e.key === store.key(EV.LIST_KEY)) {
      if (event) {
        event = EV.find(eventList(), event.id);
        if (!event) { // 다른 창에서 이 이벤트를 지웠다
          location.href = homeUrl();
          return;
        }
      }
    } else {
      return;
    }
    render();
  });

  // ---------- 로그인 열쇠 · 한 번에 한 PC만 · 이용 기간 ----------

  let idTok = null;        // 1시간짜리 로그인 열쇠 (refreshToken으로 새로 받는다)
  let tokenPending = null; // 동시에 여러 곳에서 불러도 갱신은 한 번만
  async function syncIdToken() {
    if (idTok && idTok.expiresAt - Date.now() > 5 * 60000) return idTok.idToken;
    if (!tokenPending) tokenPending = S.refreshToken(FB.apiKey, auth.refreshToken).finally(() => { tokenPending = null; });
    let t;
    try {
      t = await tokenPending;
    } catch (e) {
      // 비밀번호가 바뀌었거나 계정이 지워진 경우 → 다시 로그인
      if (/TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_REFRESH_TOKEN/.test(e.message)) block('login');
      throw e;
    }
    idTok = t;
    if (t.refreshToken && t.refreshToken !== auth.refreshToken) {
      auth.refreshToken = t.refreshToken;
      saveJson(AUTH_KEY, auth);
    }
    return t.idToken;
  }

  // 로그인할 때 users/{uid}/session.id에 이 PC의 표시(sid)를 남긴다. 다른 PC(브라우저)에서 로그인하면 바뀐다
  // → 20초마다, 그리고 올리기 전에(마지막 확인이 15초보다 오래됐으면) 확인해서 다르면 이 PC는 로그아웃
  //   (인터넷이 끊긴 사이 다른 PC가 이어받았는데 이 PC가 옛 내용을 올려 덮어쓰는 일을 막는다)
  let blocked = null;      // 'kicked'(다른 PC 로그인) · 'expired' · 'off'(정지) · 'none'(등록 안 됨) · 'login'(다시 로그인 필요)
  let sessionAt = 0;       // 마지막으로 '아직 이 PC가 로그인 중'을 확인한 시각
  let sessionPending = null;
  function checkSession() {
    if (!auth || blocked) return Promise.resolve(false);
    if (!sessionPending) {
      sessionPending = (async () => {
        const id = await S.get(FB.databaseURL, `users/${auth.uid}/session/id`, await syncIdToken());
        if (id !== auth.sid) {
          block('kicked');
          return false;
        }
        sessionAt = Date.now();
        return true;
      })().finally(() => { sessionPending = null; });
    }
    return sessionPending;
  }
  const sessionOk = () => (blocked ? Promise.resolve(false) : Date.now() - sessionAt < 15000 ? Promise.resolve(true) : checkSession());

  // 이용 기간 — 판매자가 연장·정지하면 몇 분 안에 반영 (기간이 지나면 인터넷이 없어도 막는다)
  let licenseAt = 0;
  async function checkLicense() {
    licenseAt = Date.now();
    const acc = await S.get(FB.databaseURL, `accounts/${auth.uid}`, await syncIdToken());
    const l = AC.license(acc, Date.now());
    if (acc && (acc.until !== auth.until || acc.name !== auth.name)) {
      auth.until = acc.until;
      auth.name = acc.name;
      saveJson(AUTH_KEY, auth);
    }
    if (l.state !== 'ok') block(l.state);
    return l;
  }

  function block(reason) {
    if (blocked) return;
    blocked = reason;
    clearTimeout(publishTimer);
    if (stopInbox) stopInbox();
    if (stopCiInbox) stopCiInbox();
    stopInbox = null;
    stopCiInbox = null;
    inboxKey = null;
    renderGate();
  }

  const GATE = {
    kicked: ['다른 PC에서 로그인했습니다', '이 계정으로 다른 PC(또는 다른 브라우저)에서 로그인해서 이 화면은 로그아웃되었습니다. 한 계정은 한 번에 한 PC에서만 쓸 수 있습니다.<br>이 PC에서 이어서 하려면 다시 로그인하세요 (그러면 다른 PC가 로그아웃됩니다).'],
    expired: ['이용 기간이 끝났습니다', '연장은 판매자에게 문의하세요. 연장되면 \'다시 확인\'을 누르세요.'],
    off: ['사용이 정지된 계정입니다', '판매자에게 문의하세요.'],
    none: ['등록되지 않은 계정입니다', '판매자에게 문의하세요.'],
    login: ['다시 로그인해 주세요', '로그인이 만료되었습니다 (비밀번호가 바뀌었거나 계정이 바뀜).'],
  };
  function renderGate() {
    const g = $('gate');
    if (!blocked) {
      g.hidden = true;
      return;
    }
    const [title, text] = GATE[blocked];
    const until = blocked === 'expired' && auth.until > 0 ? ` (${AC.dateStr(auth.until)}까지였음)` : '';
    g.innerHTML = `<div class="gate-box"><h2>${esc(title)}</h2><p>${text}${esc(until)}</p>
      <div class="row-actions">
        ${blocked === 'expired' || blocked === 'off' ? '<button type="button" data-act="gate-check">다시 확인</button>' : ''}
        <button type="button" class="primary" data-act="relogin">${blocked === 'kicked' || blocked === 'login' ? '다시 로그인' : '로그아웃'}</button>
      </div></div>`;
    g.hidden = false;
  }

  // ---------- 계정에 저장 (클라우드 users/{uid}) ----------
  // 이벤트가 바뀌면 rev를 올리고 1.5초 뒤 목록 항목 + 상태 전체를 한 번에 올린다.
  // 인터넷이 끊겨 있으면 이 PC에 남겨 두고(rev > cloudRev) 연결되면 올린다.

  let cloudError = '';
  const cloudTimers = {};
  const cloudChain = {}; // 이벤트마다 올리기를 차례로 (늦게 끝난 옛 내용이 새 내용을 덮지 않게)
  let cloudTryAt = 0;

  function markChanged(id) {
    const ev = EV.find(eventList(), id);
    if (!ev) return;
    const upd = EV.update(store, id, { rev: (ev.rev || 0) + 1 });
    if (event && event.id === id && upd) event = upd;
    scheduleCloud(id, ev.share ? 300 : undefined); // 같이 쓰는 중이면 빨리 올린다 (상대 화면이 늦게 따라오지 않게)
  }

  function scheduleCloud(id, ms) {
    clearTimeout(cloudTimers[id]);
    cloudTimers[id] = setTimeout(() => pushEvent(id), ms == null ? 1500 : ms);
  }

  function pushEvent(id) {
    cloudChain[id] = (cloudChain[id] || Promise.resolve()).then(() => pushNow(id));
    return cloudChain[id];
  }

  async function pushNow(id) {
    const ev = EV.find(eventList(), id);
    if (!ev || !AC.dirty(ev) || !auth || blocked) return;
    // 같이 쓰는 이벤트는 내용이 shared/{코드}에 있다 — 내 계정에는 목록 항목만 둔다
    if (ev.share) { await pushShared(id); await pushMeta(id); return; }
    const rev = ev.rev;
    const raw = store.getItem(EV.stateKey(id));
    cloudTryAt = Date.now();
    try {
      if (!(await sessionOk())) return;
      let st = null;
      try { st = JSON.parse(raw); } catch (e) { /* 빈 이벤트로 */ }
      await S.patch(FB.databaseURL, `users/${auth.uid}`, {
        [`events/${id}`]: AC.cloudMeta(ev, EV.summary(st)),
        [`states/${id}`]: raw || 'null',
      }, await syncIdToken());
      const cur = EV.update(store, id, { cloudRev: rev });
      if (event && event.id === id && cur) event = cur;
      cloudError = '';
    } catch (e) {
      cloudError = S.explainError(e.message);
    }
  }

  // 목록 맞추기: 다른 PC에서 만든·고친·지운 이벤트를 반영하고, 이 PC에만 있는 변경은 올린다
  let listSync = 'idle'; // 'loading' | 'ok' | 'error'
  async function syncList() {
    listSync = 'loading';
    render();
    try {
      if (!(await sessionOk())) return;
      const cloud = await S.get(FB.databaseURL, `users/${auth.uid}/events`, await syncIdToken());
      const r = AC.reconcile(eventList(), cloud);
      EV.saveList(store, r.list);
      r.drop.concat(r.fetch).forEach(id => store.removeItem(EV.stateKey(id))); // 받아 올 것은 열 때 새로
      listSync = 'ok';
      render();
      await Promise.all(r.push.map(id => pushEvent(id)));
    } catch (e) {
      listSync = 'error';
      cloudError = S.explainError(e.message);
    }
    render();
  }

  // 이 PC에 없는 이벤트를 계정에서 받아 온다 (다른 PC에서 만들었거나 다른 PC에서 고친 것)
  async function fetchEvent(id) {
    if (!EV.find(eventList(), id)) await syncList();
    if (!EV.find(eventList(), id)) return false;
    if (store.getItem(EV.stateKey(id)) == null) {
      if (!(await sessionOk())) return false;
      const shared = EV.find(eventList(), id);
      if (shared && shared.share) { // 같이 쓰는 이벤트는 내용이 shared/{코드}에 있다
        await pullShared(id, false).catch(() => {});
        return store.getItem(EV.stateKey(id)) != null;
      }
      const raw = await S.get(FB.databaseURL, `users/${auth.uid}/states/${id}`, await syncIdToken());
      store.setItem(EV.stateKey(id), typeof raw === 'string' && raw !== 'null' ? raw : JSON.stringify(E.createState()));
    }
    return true;
  }

  // ---------- 이벤트 같이 쓰기 (참가 코드) ----------
  // 코드를 아는 DD 계정이 shared/{코드}에 스스로 들어와 같은 이벤트를 함께 조작한다 (2026-10-11 사용자 요청).
  //  - 이벤트가 통째로 한 덩어리 JSON이라 head/rev를 꼭 +1로 올려 쓴다 → 둘이 거의 동시에 누르면 한쪽이
  //    서버에서 거부되고 받아서 다시 그린다. 이 장치가 없으면 늦게 끝난 쪽이 상대 작업을 통째로 지운다
  //  - 2초마다 head(수십 바이트)만 확인하고 rev가 바뀌었을 때만 내용을 받는다 (실시간 연결은 열지 않는다)
  //  - 교대 시계는 PC 한 대만 돌린다(head/run). 둘 다 돌리면 교대가 두 번 되고 음성 안내도 겹친다.
    //  주인을 가져갈 때는 바로 내 것으로 치지 않고 다음 확인에서 읽어 확인한다 (둘이 같이 가져가는 것을 막는다)
  const SHARE_POLL_MS = 2000;
  const RUN_STALE_MS = 25000;
  const RUN_BEAT_MS = 8000;
  let sharePollAt = 0;
  let shareBeatAt = 0;
  let shareBusy = false;
  let shareRun = null;   // {uid, sid, at} — 지금 교대 시계를 돌리는 PC
  let shareError = '';
  let shareGone = false; // 주인이 같이 쓰기를 껐다

  const sharedCode = () => (event && event.share) || null;
  const mySid = () => (auth && auth.sid) || '';
  // 같이 쓰는 중이 아니면 당연히 이 PC가 돌린다
  const iRunClock = () => !sharedCode() || !!(shareRun && auth && shareRun.uid === auth.uid && shareRun.sid === mySid());

  // 목록 항목만 올린다 (내용은 shared/{코드}에)
  async function pushMeta(id) {
    const ev = EV.find(eventList(), id);
    if (!ev || !auth || blocked) return;
    let st = null;
    try { st = JSON.parse(store.getItem(EV.stateKey(id))); } catch (e) { /* 요약 없이 */ }
    try {
      await S.patch(FB.databaseURL, `users/${auth.uid}`, { [`events/${id}`]: AC.cloudMeta(ev, EV.summary(st)) }, await syncIdToken());
      cloudError = '';
    } catch (e) { cloudError = S.explainError(e.message); }
  }

  async function pushShared(id) {
    const ev = EV.find(eventList(), id);
    if (!ev || !ev.share || !auth || blocked || shareGone) return;
    const raw = store.getItem(EV.stateKey(id));
    const rev = ev.rev;
    cloudTryAt = Date.now();
    try {
      if (!(await sessionOk())) return;
      const next = (ev.sharedRev || 0) + 1;
      await S.patch(FB.databaseURL, `shared/${ev.share}`, {
        'head/rev': next,
        'head/by': String((auth.name || auth.email || '')).slice(0, 60),
        'head/at': Date.now(),
        state: raw || 'null',
        name: ev.name,
      }, await syncIdToken());
      const cur = EV.update(store, id, { cloudRev: rev, sharedRev: next });
      if (event && event.id === id && cur) event = cur;
      shareError = '';
      shareGone = false;
    } catch (e) {
      // rev가 안 맞으면 같이 쓰는 분이 먼저 바꾼 것 → 받아서 다시 그린다 (내 작업은 취소)
      const head = await S.get(FB.databaseURL, `shared/${ev.share}/head`, await syncIdToken()).catch(() => null);
      if (head && Number(head.rev) !== (ev.sharedRev || 0)) { await pullShared(id, true); return; }
      if (shareEnded(e.message)) { shareGone = true; shareRun = null; render(); return; }
      shareError = S.explainError(e.message);
    }
  }

  async function pullShared(id, clash) {
    const ev = EV.find(eventList(), id);
    if (!ev || !ev.share || !auth) return;
    const node = await S.get(FB.databaseURL, `shared/${ev.share}`, await syncIdToken());
    if (!node || !node.owner) { shareGone = true; render(); return; }
    shareGone = false;
    const raw = typeof node.state === 'string' ? node.state : 'null';
    store.setItem(EV.stateKey(id), raw);
    const p = { sharedRev: Number(node.head && node.head.rev) || 0, rev: 1, cloudRev: 1 };
    if (node.name) p.name = String(node.name);
    if (ev.guest && node.room && node.room !== ev.room) p.room = String(node.room); // 들어온 계정은 주인의 딜러 QR 방을 같이 쓴다
    const cur = EV.update(store, id, p);
    shareRun = (node.head && node.head.run) || null;
    if (event && event.id === id) {
      if (cur) event = cur;
      try { state = E.migrate(JSON.parse(raw)); } catch (err) { /* 못 읽으면 그대로 둔다 */ }
      takeCheckIns(true); // 받아 온 내용에 아직 없는 휴대폰 출근 체크는 다시 반영
      render();
    }
    if (clash) toast('같이 쓰는 분이 먼저 바꿔서 방금 작업은 취소됐습니다 — 화면을 보고 다시 해 주세요');
  }

  // 주인이 같이 쓰기를 끄면 노드가 사라져 읽기가 거부된다 — 끝난 것으로 보고 그만 두드린다
  const shareEnded = msg => /permission|denied|권한|401|403/i.test(String(msg || ''));

  async function pollShared(now) {
    const code = sharedCode();
    if (!code || !auth || blocked || shareBusy || !event || shareGone) return;
    shareBusy = true;
    try {
      const head = await S.get(FB.databaseURL, `shared/${code}/head`, await syncIdToken());
      if (head == null) { shareGone = true; shareRun = null; return; }
      shareGone = false;
      shareRun = head.run || null;
      shareError = '';
      // 들어온 계정: 주인의 딜러 QR 방을 한 번 받아 온다 (예전에 참가했거나 예전 버전이 따로 만든 방을 쓰고 있을 수 있다)
      if (event.guest && !guestRoomChecked) {
        guestRoomChecked = true;
        const r = await S.get(FB.databaseURL, `shared/${code}/room`, await syncIdToken()).catch(() => null);
        if (r && String(r) !== event.room) event = EV.update(store, event.id, { room: String(r), shareOff: false }) || event;
      }
      if (Number(head.rev) !== (event.sharedRev || 0) && !AC.dirty(event)) await pullShared(event.id, false);
      // 교대 시계 주인: 비었거나 소식이 끊기면 가져오고, 내가 주인이면 살아 있다고 알린다
      if (!shareRun || now - (shareRun.at || 0) > RUN_STALE_MS) await claimRun(now);
      else if (iRunClock() && now - shareBeatAt > RUN_BEAT_MS) await claimRun(now);
    } catch (e) {
      if (shareEnded(e.message)) { shareGone = true; shareRun = null; render(); }
      else shareError = S.explainError(e.message);
    } finally {
      shareBusy = false;
    }
  }

  // 주인을 가져간다 — 바로 내 것으로 치지 않는다. 둘이 같이 가져가도 다음 확인에서 한쪽으로 정해진다
  async function claimRun(now) {
    const code = sharedCode();
    if (!code || !auth) return;
    shareBeatAt = now;
    await S.patch(FB.databaseURL, `shared/${code}/head`, { run: { uid: auth.uid, sid: mySid(), at: Date.now() } },
      await syncIdToken()).catch(() => {});
  }

  // ---------- 딜러 휴대폰·딜러룸 TV: 볼 때만 받아 오기 ----------
  // 실시간 연결을 열어 두지 않는다 (파이어베이스 무료 요금제는 동시 연결 100개 → 딜러 수천 명도 볼 수 있게).
  // 화면이 켜져 있는 동안만, 겹치는 것 없이 필요한 것 하나씩 (형식은 phoneview.js 맨 위):
  //  - 휴대폰: 30초마다 p/{내 id} 하나 (보통 150바이트 안팎). 이름을 고를 때만 names. 전체 표(sheet)는 받지 않는다
  //  - 딜러룸 TV: 15초마다 pulse(수십 바이트)를 보고, 바뀌었을 때만 sheet
  const PV = window.DealerPhoneView;
  const POLL_MS = isBoard ? 15000 : 30000;
  let pollAt = 0;          // 마지막 확인 시작 (이 기기 시계)
  let pollOkAt = 0;        // 마지막 성공
  let pollFailSince = 0;   // 실패가 이어진 시작 (0 = 정상)
  let pollBusy = false;
  let fastUntil = 0;       // 퇴근 희망을 보낸 직후에는 3초마다 (디렉터가 반영했는지 빨리 보이게)
  let remoteSeen = false;  // 한 번이라도 받았나
  let liveAt = null;       // 받은 데이터의 디렉터 시각(초) — 디렉터 PC가 살아 있는지, 시계 차이
  let mine = null;         // 휴대폰: 내 것 (p/{id})
  let myId = null;
  let names = null;        // 휴대폰: 이름 고르기용 {t, d}
  let sheet = null;        // 딜러룸 TV용 표
  let sheetVer = null;     // 받은 표의 v
  let myReply = null;      // 내가 보낸 퇴근 희망 답 {w, k, at(서버 시각)} — 디렉터가 반영했는지 보려고
  let meEoSending = null;  // 지금 보내는 중인 내 답
  // 디렉터 PC 시계 − 이 기기 시계. 교대 시각은 모두 디렉터 PC 시계로 찍혀 있으므로
  // 휴대폰 시계가 몇 분 틀려도 남은 시간·연결 끊김 판단이 맞게 디렉터 PC 기준으로 계산한다.
  // 디렉터 시각(at)이 바뀐 것을 처음 본 때: 디렉터가 지난 확인과 이번 확인 사이에 썼다 → 차이의 범위를 좁혀 간다
  // (at은 초 단위로 반올림돼 있어 ±0.5초를 더 둔다)
  let remoteOffset = 0;
  let offLo = -Infinity;
  let offHi = Infinity;
  const nowMs = () => Date.now() + (remote ? remoteOffset : 0);
  function clockSample(at, from, to) {
    let lo = Math.max(offLo, at - 500 - to);
    let hi = Math.min(offHi, at + 500 - from);
    if (lo > hi) { // 어느 쪽 시계가 바뀌었다 → 이번 것으로 다시
      lo = at - 500 - to;
      hi = at + 500 - from;
    }
    offLo = lo;
    offHi = hi;
    remoteOffset = Math.round((lo + hi) / 2);
  }

  // 디렉터 PC: 이벤트마다 방(room)을 만들어 그 이벤트의 로테이션을 올린다 (방 주인 = 이 계정)
  const hasAccount = () => !!auth && !blocked;
  const room = () => (event && event.room) || null;
  // 같이 쓰는 중이면 교대 시계를 든 PC만 딜러 휴대폰·TV를 갱신한다 (둘이 올리면 번갈아 덮어쓴다)
  const isPublisher = () => !!(hasAccount() && room() && iRunClock());
  let syncStatus = isPublisher() ? 'connecting' : 'off';
  let syncError = '';
  let publishTimer = null;

  function setSync(status, err) {
    syncStatus = status;
    syncError = err ? S.explainError(err) : '';
    renderControls();
    if ($('dlgShare').open) renderShare();
  }

  let syncDirty = false; // 아직 못 올린 변경이 있음 (인터넷이 끊겼다 돌아오면 다시 올림)
  let lastVer = 0;       // 마지막으로 내용이 바뀐 시각 (pulse.v, p.v — TV·'전체 표'가 다시 받을지)
  let lastBeatAt = 0;

  function schedulePublish() {
    if (!isPublisher()) return;
    syncDirty = true;
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => publish(false), 400);
  }

  // 딜러별 휴대폰 데이터(p) + 이름 목록 + 전체 표 + pulse를 한 번에 (phoneview.js). 바뀐 게 없어도 30초마다
  // p(시간이 흐르는 값을 지금 기준으로)와 pulse.at을 다시 써서 '디렉터 PC 살아 있음'을 알린다.
  // beatOnly여도 못 올린 변경이 있으면 전부 올린다
  async function publish(beatOnly) {
    if (!isPublisher()) return;
    const full = !beatOnly || syncDirty;
    if (full) syncDirty = false;
    lastBeatAt = Date.now();
    try {
      if (!(await sessionOk())) return;
      const t = await syncIdToken();
      const now = Date.now();
      if (full) lastVer = now;
      const v = PV.build(state, event.name, now, lastVer); // lastVer는 pulse용
      const at = Math.round(now / 1000);
      await S.patch(FB.databaseURL, `rooms/${room()}`, full
        ? { p: v.p, names: v.names, sheet: v.sheet, pulse: { v: lastVer, at }, state: null, view: null, beat: null } // 예전 형식은 지운다
        : { p: v.p, 'pulse/at': at }, t);
      if (syncStatus !== 'live') setSync('live');
    } catch (e) {
      if (full) syncDirty = true;
      setSync('error', e.message);
    }
  }

  window.addEventListener('online', () => {
    publish(false);
    if (isList) syncList();
    else if (event) pushEvent(event.id);
  });

  // 이 이벤트의 공유 방(딜러용 링크·QR) 만들기
  async function openRoom() {
    setSync('connecting');
    try {
      if (!(await sessionOk())) return;
      const t = await syncIdToken();
      const id = S.randomId(20);
      await S.put(FB.databaseURL, `rooms/${id}/owner`, auth.uid, t);
      event = EV.update(store, event.id, { room: id, shareOff: false }) || event;
      markChanged(event.id);
      if (event.share && !event.guest) await linkShareRoom(event);
      await publish(false);
      startInbox();
      if (syncStatus === 'live') toast(`실시간 공유 연결됨 — '${event.name}' 딜러용 링크(QR)를 보내세요`);
    } catch (e) {
      setSync('error', e.message);
    }
    if ($('dlgShare').open) renderShare();
  }

  // 같이 쓰는 이벤트의 딜러 QR 방을 같이 쓰기에 이어 둔다 (주인만):
  //  roomShare/{방} = 코드 → 들어온 계정도 이 방에 올릴 수 있고, shared/{코드}/room = 방 → 들어온 계정이 새 방을 만들지 않는다.
  //  예전에는 코드를 rooms/{방}/share(링크만 있으면 누구나 읽음)에 적었다 → 지운다 (2026-10-24 검토)
  async function linkShareRoom(ev) {
    if (!ev || !ev.share || ev.guest || !ev.room || !auth) return;
    try {
      const t = await syncIdToken();
      await S.put(FB.databaseURL, `roomShare/${ev.room}`, ev.share, t);
      await S.put(FB.databaseURL, `shared/${ev.share}/room`, ev.room, t);
      await S.put(FB.databaseURL, `rooms/${ev.room}/share`, null, t).catch(() => {});
    } catch (e) { /* 다음에 열 때 다시 */ }
  }

  // 이 이벤트만 공유를 끊는다 (다른 이벤트의 방은 그대로)
  function disconnectSync() {
    if (event.guest) return; // 같이 쓰는 방은 주인 것 — 들어온 계정이 끊지 않는다
    const r = room();
    if (r && hasAccount()) clearRoom(r);
    event = EV.update(store, event.id, { room: null, shareOff: true }) || event;
    markChanged(event.id);
    setSync('off');
    startInbox();
    renderShare();
  }

  // 방에 남은 내용은 비워 둔다 (실패해도 무시 — 링크를 모르면 아무도 못 봄)
  function clearRoom(r) {
    syncIdToken()
      .then(t => S.patch(FB.databaseURL, `rooms/${r}`, { p: null, names: null, sheet: null, pulse: null, eo: null, ci: null, state: null, view: null, beat: null }, t))
      .catch(() => {});
  }

  // 디렉터 PC: 딜러 휴대폰에서 온 퇴근 희망 답 받기 (rooms/{방}/eo)
  let eoInbox = null;
  let stopInbox = null;

  // 휴대폰 출근 체크 (rooms/{방}/ci) — 연결을 하나 더 연다 (디렉터 PC만)
  let ciInbox = null;
  let stopCiInbox = null;

  // 받는 함을 연 조건(방 id, 이 PC가 올리는 쪽일 때만 — inboxKey). 같이 쓰기에서는 처음 열 때 아직 시계 주인이 안 정해져 있다가
  // 나중에 이 PC가 가져가므로, 1초 박자마다 견줘서 바뀌면 다시 연다 (안 그러면 아무 PC도 휴대폰 답을 못 받는다 — 2026-10-24 검토)
  function syncInbox() {
    const key = !blocked && isPublisher() ? room() : null;
    if (key === inboxKey) return;
    startInbox();
    if (key) publish(false); // 이제 이 PC가 올린다 — 딜러 휴대폰·TV를 바로 지금 모습으로
  }

  function startInbox() {
    if (stopInbox) stopInbox();
    if (stopCiInbox) stopCiInbox();
    stopInbox = null;
    stopCiInbox = null;
    eoInbox = null;
    ciInbox = null;
    inboxKey = !blocked && isPublisher() ? room() : null;
    if (!inboxKey) return;
    stopInbox = S.subscribe(FB.databaseURL, room(), data => {
      eoInbox = data;
      takeReplies();
    }, () => {}, 'eo');
    stopCiInbox = S.subscribe(FB.databaseURL, room(), data => {
      ciInbox = data;
      takeCheckIns();
    }, () => {}, 'ci');
  }

  // 일찍 체크한 딜러는 예정 시각에, 늦게 체크한 딜러는 바로 출근 (엔진 applyCheckIns)
  function takeCheckIns(quiet) {
    if (!ciInbox) return;
    const res = E.applyCheckIns(state, ciInbox, Date.now());
    if (!res.done.length) return;
    commit(res.state);
    if (state !== res.state || quiet) return; // 막힌 화면이라 반영 안 됐으면 알리지 않는다
    chime(1);
    toast(`휴대폰 출근 체크 · ${res.done.map(x => (x.waitUntil ? `${x.name} (${hhmm(x.waitUntil)}부터 투입)` : `${x.name} 출근`)).join(' · ')}`);
  }

  function takeReplies() {
    if (!eoInbox) return;
    const res = E.applyEoReplies(state, eoInbox, Date.now());
    if (res.state === state) return;
    commit(res.state);
    chime(1);
    toast(`휴대폰 · ${res.replies.map(r => r.text).join(' · ')}`);
  }

  const rdb = () => S.normDb(remote.db);
  const rpath = p => `rooms/${encodeURIComponent(remote.room)}/${p}`;

  // anyway: 화면이 꺼져 있어도 (처음 열 때), refetch: 바뀌지 않았어도 표까지 다시 받기 (이름을 고른 직후 등)
  async function pollRemote(anyway, refetch) {
    if (pollBusy || (!anyway && document.hidden)) return;
    pollBusy = true;
    const prevAt = pollAt;
    pollAt = Date.now();
    try {
      const at = isBoard ? await pollBoard(refetch) : await pollPhone(refetch);
      if (at != null) {
        if (liveAt != null && at !== liveAt && prevAt && Date.now() - prevAt < 45000) clockSample(at * 1000, prevAt, Date.now());
        liveAt = at;
      }
      pollOkAt = Date.now();
      pollFailSince = 0;
    } catch (e) {
      if (!pollFailSince) pollFailSince = Date.now();
    }
    pollBusy = false;
    render();
  }

  // 딜러룸 TV: pulse를 보고 바뀌었으면 표. 돌려주는 값 = 디렉터 시각(초)
  async function pollBoard(refetch) {
    const p = await S.get(rdb(), rpath('pulse'));
    if (!p) return null;
    if (p.v !== sheetVer || refetch) {
      sheet = PV.normSheet(await S.get(rdb(), rpath('sheet')));
      sheetVer = p.v;
    }
    remoteSeen = true;
    return p.at;
  }

  // 휴대폰: 내 것 하나. 처음이거나 내 이름이 없어졌으면(퇴근·초기화로 id가 바뀜) 이름 목록에서 찾는다
  async function pollPhone(refetch) {
    const saved = loadMe();
    let id = saved ? myId || saved.id : null;
    let node = id ? await S.get(rdb(), rpath(`p/${id}`)) : null;
    if (saved && (!node || node.n !== saved.name)) {
      names = PV.normNames(await S.get(rdb(), rpath('names')));
      id = PV.findName(names, saved);
      node = id ? await S.get(rdb(), rpath(`p/${id}`)) : null;
    } else if (!saved) {
      names = PV.normNames(await S.get(rdb(), rpath('names'))); // 이름 고르는 중: 새로 출근한 사람도 보이게
    }
    mine = PV.normMe(node);
    myId = mine ? id : null;
    if (mine) {
      if (mine.k && !myReply) myReply = await S.get(rdb(), rpath(`eo/${myId}`)).catch(() => null);
      // 휴대폰은 전체 표(sheet)를 받지 않는다 — 다른 사람 로테이션은 딜러에게 보여주지 않는다 (사용자 요청)
    }
    remoteSeen = !!(mine || names);
    return mine ? mine.at : null;
  }

  // 같은 브라우저에서 휴대폰·TV 화면 미리 보기(?view=me&e= / ?view=board&e=): 이 PC의 상태로 바로 만든다
  let localCache = { state: null, v: null };
  function localView() {
    if (localCache.state !== state) localCache = { state, v: PV.build(state, event ? event.name : '', Date.now()) };
    return localCache.v;
  }
  // 휴대폰 화면에 쓸 것 {me, id, names}
  function meData() {
    if (remote) return { me: mine, id: myId, names };
    const v = localView();
    const nm = PV.normNames(v.names);
    const id = PV.findName(nm, loadMe());
    return { me: id ? PV.normMe(v.p[id]) : null, id, names: nm };
  }
  const boardSheet = () => (remote ? sheet : PV.normSheet(localView().sheet));

  // 딜러 휴대폰·보드에 보여 줄 연결 상태
  function remoteNote(now) {
    if (!remote) return '';
    if (!remoteSeen) return `<p class="conn ${pollFailSince ? 'bad' : ''}">디렉터 화면에 연결하는 중…</p>`;
    // 잠깐 실패한 건 보여 주지 않는다 (10초 넘게 못 받을 때만)
    if (pollFailSince && Date.now() - pollFailSince > 10000) return '<p class="conn bad">인터넷이 불안정합니다 — 다시 연결하는 중</p>';
    // 화면을 다시 켠 직후 등 한동안 확인을 못 했으면, 끊겼다고 하기 전에 먼저 확인
    if (Date.now() - pollOkAt > POLL_MS + 10000) return '<p class="conn">새로 확인하는 중…</p>';
    const age = liveAt != null ? now - liveAt * 1000 : null;
    if (age != null && age > 90000) {
      return `<p class="conn bad">디렉터 화면 연결 끊김 — ${minutes(age)}분 전 마지막 갱신. 디렉터에게 확인하세요</p>`;
    }
    return `<p class="conn ok">연결됨 · ${POLL_MS / 1000}초마다 새로 확인</p>`;
  }

  // ---------- 포맷 ----------

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const minutes = ms => Math.max(0, Math.floor(ms / E.MIN));
  const hue = no => Math.round((no * 137.508) % 360); // 테이블마다 다른 색
  function mmss(ms) {
    const t = Math.floor(Math.abs(ms) / 1000);
    return (ms < 0 ? '-' : '') + pad(Math.floor(t / 60)) + ':' + pad(t % 60);
  }
  function hhmm(t) {
    const d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function hm(ms) {
    const m = minutes(ms);
    return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
  }
  const nameOf = id => {
    const d = id && E.dealerOf(state, id);
    return d ? d.name : '—';
  };
  const tchip = no => `<span class="tchip" style="--h:${hue(no)}">${no}</span>`;
  const KIND = {
    in: ['휴식 복귀', 'in'],
    'short-rest': ['휴식 부족', 'warn'],
    vacant: ['공석', 'danger'],
    trade: ['테이블 맞바꿈', 'info'], // 표에서 직접 정한 것 — 앉아 있던 딜러가 다른 테이블로
  };

  // 바뀐 부분만 다시 그린다 — 매초 innerHTML을 갈아끼우면 버튼 클릭이 씹힌다
  const htmlCache = new Map();
  function setHTML(el, html) {
    if (htmlCache.get(el) === html) return false;
    htmlCache.set(el, html);
    el.innerHTML = html;
    return true;
  }

  // 앞으로의 교대 예측 — state가 바뀔 때만 다시 계산
  let projCache = { state: null, slots: [] };
  function projection() {
    const now = Date.now();
    // 예정 시각이 지났는데 체크 안 한 딜러가 생기면 미리보기에서 빠지므로 그때도 다시 계산
    const late = state.dealers.filter(d => d.status === 'planned' && d.planAt != null && d.planAt <= now && d.checkAt == null).length;
    if (projCache.state !== state || projCache.late !== late) projCache = { state, late, slots: E.project(state, FUTURE_COLS, now) };
    return projCache.slots;
  }
  const nextPlan = () => (projection()[0] || {}).plan || null;

  // ---------- 로테이션 표 (엑셀식) ----------

  function sheetColumns() {
    const hist = state.history;
    const cols = hist.slice(Math.max(0, hist.length - 1 - PAST_COLS), Math.max(0, hist.length - 1))
      .map(h => ({ at: h.at, cls: 'past', sub: '', a: h.a }));
    const cur = hist[hist.length - 1];
    cols.push({ at: cur ? cur.at : null, cls: 'now', sub: state.clock.running ? '진행 중' : '현재', a: E.snapshot(state) });
    projection().forEach(p => cols.push({ at: p.at, cls: 'future', sub: '예정', a: p.a }));
    return cols;
  }

  // meId가 있으면 그 딜러 줄을 맨 위로 올리고 강조 (딜러 휴대폰 화면). list: [{id, name, grade}] (없으면 이 PC의 상태)
  // edit = 디렉터 화면 — 예정 칸에 '몇 번째 교대·누구'를 달아 휴식을 끌어다 놓을 수 있게 한다
  // 출근 예정(출근 전)도 아래쪽에 — 예정 시각 뒤 가장 가까운 교대부터 자리가 보인다
  function dealerRows(cols, meId, list, edit) {
    const dealers = (list || state.dealers.filter(d => d.status !== 'off')
      .sort((a, b) => (a.status === 'planned') - (b.status === 'planned'))).slice()
      .sort((a, b) => (b.id === meId) - (a.id === meId));
    if (!dealers.length) return `<tr><td class="empty-row" colspan="${cols.length + 1}">출근한 딜러가 없습니다</td></tr>`;
    let k = 0;
    // 지금 칸은 0, 예정 칸은 1·2·3… — 지난 칸(null)은 손댈 수 없다
    const ns = cols.map(c => (c.cls === 'future' ? ++k : c.cls === 'now' ? 0 : null));
    const fixed = edit ? ns.map(n => (n ? E.plannedIds(state, n) : null)) : null;
    return dealers.map(d => {
      let prev;
      const cells = cols.map((c, i) => {
        const v = c.a[d.id];
        const chg = prev !== undefined && v !== undefined && v !== prev ? ' chg' : '';
        prev = v;
        if (v === undefined) return `<td class="${c.cls} na"></td>`;
        if (v === E.DUTY) return `<td class="${c.cls} duty${chg}" title="다른 업무 중 — 끌어다 놓을 수 없음">업무</td>`;
        const n = edit ? ns[i] : null;
        const fix = n && fixed[i].has(d.id) ? ' fixed' : '';
        const tag = n == null ? '' : ` data-n="${n}" data-d="${d.id}"`;
        const grab = n == null ? '' : ` draggable="true" title="${n ? '끌거나 눌러서 이 교대를 직접 정하기' : '끌거나 눌러서 지금 당장 자리 바꾸기'}"`;
        if (v === 0) return `<td class="${c.cls} rest${chg}${fix}"${tag}${grab}>휴식</td>`;
        return `<td class="${c.cls} tb${chg}${fix}"${tag}${grab} style="--h:${hue(v)}">${v}</td>`;
      }).join('');
      const plan = d.status === 'planned' ? `<small class="plan-at">${d.planAt == null ? '출근 전' : `${hhmm(d.planAt)} 출근 예정`}</small>` : '';
      return `<tr class="${d.id === meId ? 'mine' : ''}"><th class="rowhead">${esc(d.name)} <span class="grade">${esc(d.grade)}</span>${plan}</th>${cells}</tr>`;
    }).join('');
  }

  // 테이블별 표. 대기 테이블도 넣는다 — 예정 칸을 누르면 그 교대에 사용 시작·대기·깨기 (edit = 디렉터 화면)
  function tableRows(cols, edit) {
    const tables = E.activeTables(state);
    if (!tables.length) return `<tr><td class="empty-row" colspan="${cols.length + 1}">열린 테이블이 없습니다</td></tr>`;
    let k = 0;
    const ns = cols.map(c => (c.cls === 'future' ? ++k : c.cls === 'now' ? 0 : null)); // 앞으로 몇 번째 교대 뒤 (지금 = 0)
    const byTable = cols.map(c => {
      const m = {};
      for (const id in c.a) if (c.a[id] > 0) m[c.a[id]] = id;
      return m;
    });
    return tables.map(t => {
      let prev;
      const cells = cols.map((c, i) => {
        const n = ns[i];
        const pick = edit && n > 0 ? ` data-t="${t.id}" data-tn="${n}" title="눌러서 이 교대에 사용 시작·대기·깨기"` : '';
        const sel = pick ? ' tsel' : '';
        if (n != null && E.tableClosedAt(t, n)) return `<td class="${c.cls} closedc${sel}"${pick}>깨짐</td>`;
        if (n != null && !E.tableUsedAt(t, n)) return `<td class="${c.cls} idlec${sel}"${pick}>대기</td>`;
        const id = byTable[i][t.no];
        const chg = prev !== undefined && id !== undefined && id !== prev ? ' chg' : '';
        prev = id;
        if (!id) return c.cls === 'past' ? `<td class="${c.cls} na"></td>` : `<td class="${c.cls} vac${sel}"${pick}>공석</td>`;
        return `<td class="${c.cls} who${chg}${sel}"${pick}>${esc(nameOf(id))}</td>`;
      }).join('');
      const sched = t.sched ? `<em class="sched">${esc(schedText(t))}</em>` : '';
      return `<tr><th class="rowhead">${tchip(t.no)}${t.feature ? '<em>피처</em>' : ''}${t.locked ? '<em>고정</em>' : ''}${t.use === false ? '<em>대기</em>' : ''}${sched}</th>${cells}</tr>`;
    }).join('');
  }

  // 앞으로 n번째 교대의 시각 (표의 예정 열과 같은 계산)
  const pushAtN = n => (projection()[n - 1] || {}).at || null;
  const SCHED_LABEL = { use: '사용 시작', idle: '대기로', close: '깨기' };
  const schedText = t => (t && t.sched ? `${pushAtN(t.sched.n) ? hhmm(pushAtN(t.sched.n)) : `${t.sched.n}번째`} 교대에 ${SCHED_LABEL[t.sched.act]}` : '');

  function sheetHTML(view, meId, given, edit) {
    const cols = given ? given.cols : sheetColumns();
    let k = 0;
    // 디렉터 화면에서는 예정 시각 머리를 누르면 그 교대에 테이블 사용 시작·대기·깨기 (교대 때 바꾸기)
    const head = `<tr><th class="corner">${view === 'table' ? '테이블' : '딜러'}</th>${cols.map(c => {
      const n = c.cls === 'future' ? ++k : 0;
      const pick = edit && n ? ` data-coln="${n}" title="눌러서 이 교대에 테이블 사용 시작·대기·깨기"` : '';
      return `<th class="${c.cls}${pick ? ' colpick' : ''}"${pick}>${c.at ? hhmm(c.at) : '—'}${c.sub ? `<small>${c.sub}</small>` : ''}</th>`;
    }).join('')}</tr>`;
    const body = view === 'table' ? tableRows(cols, edit) : dealerRows(cols, meId, given && given.dealers, edit);
    return `<div class="sheet-wrap"><table class="sheet ${view}"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  // 휴대폰·TV가 받은 표(sheet, phoneview.js) → sheetHTML이 쓰는 모양
  // 받은 표(sheet) → sheetHTML이 쓰는 모양 (딜러룸 TV 전용 — 휴대폰은 표를 보지 않는다)
  function phoneSheet(sh) {
    const kind = { p: ['past', ''], n: ['now', sh.c ? '진행 중' : '현재'], f: ['future', '예정'] };
    const cols = PV.sheetCols(sh);
    return {
      cols: cols.map((col, i) => ({
        at: col.at,
        cls: kind[col.kind][0],
        sub: kind[col.kind][1],
        a: Object.fromEntries(sh.r.filter(r => r[3][i] !== -1 && r[3][i] != null).map(r => [r[0], r[3][i]])),
      })),
      dealers: sh.r.map(r => ({ id: r[0], name: r[1], grade: r[2] })),
    };
  }

  // ---------- 렌더: 공통 ----------

  function currentTab() {
    const h = location.hash.slice(1);
    return TABS.includes(h) ? h : 'rotation';
  }

  function applyTab() {
    const tab = currentTab();
    document.querySelectorAll('[data-page]').forEach(el => { el.hidden = el.dataset.page !== tab; });
    document.querySelectorAll('[data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  }

  function renderClock(now) {
    const c = state.clock;
    const box = $('pushClock');
    if (!c.running) {
      $('countdown').textContent = '--:--';
      $('pushAt').textContent = '로테이션 시작 전';
      box.className = 'push-clock';
      return;
    }
    const left = E.msToPush(state, now);
    $('countdown').textContent = mmss(left);
    $('pushAt').textContent = c.paused ? '일시정지 중' : `${hhmm(c.nextPushAt)} 교대`;
    const warnMs = state.settings.warnBeforeMinutes * E.MIN;
    box.className = 'push-clock' + (c.paused ? ' paused' : left <= 0 ? ' due' : left <= warnMs ? ' soon' : '');
  }

  function renderControls() {
    const c = state.clock;
    $('btnClock').textContent = !c.running ? '로테이션 시작' : c.paused ? '재개' : '일시정지';
    $('btnClock').title = c.running && !c.paused ? '대회 브레이크 — 교대 시계·근무시간·장부가 멈춥니다' : '';
    $('btnPush').disabled = !c.running || c.paused;
    const step = E.lastStep(state);
    const rb = $('btnRevert');
    rb.disabled = !step;
    rb.title = step ? `되돌리기: ${hhmm(step.at)} ${step.label} (Ctrl+Z)` : '되돌릴 작업 없음 — 교대가 실행되면 그 전 작업은 되돌릴 수 없습니다';
    const every = $('pushEvery');
    if (document.activeElement !== every) every.value = state.settings.pushMinutes;
    const ip = state.clock.intervalPlan;
    const ipb = $('intervalPlan');
    ipb.hidden = !ip;
    if (ip) {
      ipb.textContent = `${hhmm(ip.at)}부터 ${ip.minutes}분`;
      ipb.title = `교대 간격 예약 — ${hhmm(ip.at)}에 교대하고 그 뒤 ${ip.minutes}분마다. 누르면 예약 취소`;
    }
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === sheetView));
    const cp = $('btnClearPlans');
    const np = E.planCount(state);
    cp.hidden = !np;
    cp.textContent = `직접 정한 교대 ${np}건 취소`;
    const sb = $('btnShare');
    const err = syncStatus === 'error';
    sb.textContent = err ? 'QR 공유 오류' : '딜러 QR';
    sb.title = isPublisher() ? (err ? syncError : '딜러 휴대폰에 공유 중 — 눌러서 QR·링크 보기') : '딜러 휴대폰 공유 (QR)';
    sb.className = err ? 'sync-err' : isPublisher() ? 'sync-live' : '';
  }

  // 진행 화면의 공지 줄 — 여기서 바로 지울 수 있게 (공지 탭까지 가지 않도록)
  function noticeItems(limit) {
    return state.notices.slice(0, limit)
      .map(n => `<li><time>${hhmm(n.at)}</time><span>${esc(n.text)}</span>
        <button class="mini danger" data-act="delnotice" data-id="${n.id}" title="이 공지 지우기">삭제</button></li>`).join('');
  }

  function renderNoticeBar() {
    const items = noticeItems(3);
    const warn = [];
    if (saveFailed) warn.push('저장 실패 — 이 브라우저에 저장할 수 없습니다 (시크릿 창이거나 저장 공간 부족). 새로 고치면 사라지니 설정 → 백업 파일 저장');
    if (event && AC.dirty(event) && cloudError) warn.push(`계정에 저장하지 못했습니다 (${cloudError}) — 이 PC에는 저장되어 있고, 연결되면 자동으로 올립니다`);
    const lic = AC.license({ until: auth && auth.until }, Date.now());
    if (lic.state === 'ok' && lic.daysLeft <= 3) warn.push(`이용 기간이 ${lic.daysLeft}일 남았습니다 (${AC.dateStr(lic.until)}까지) — 연장은 판매자에게 문의하세요`);
    if (Date.now() - otherDirectorAt < 12000) {
      warn.push('이 이벤트가 이 PC의 창 두 개에 열려 있습니다 — 하나는 닫아 주세요 (교대·음성 안내가 두 번 될 수 있음)');
    }
    const stall = stalled
      ? `<p class="conn bad big-warn">디렉터 PC가 ${minutes(stalled.ms)}분 동안 멈춰 있었습니다 (절전·화면 꺼짐·노트북 덮개 닫음) — 그동안 자동 교대·음성 안내·딜러 휴대폰 갱신이 멈췄습니다. 테이블과 교대 시각을 확인하세요 <button type="button" class="mini" data-act="stall-ok">확인</button></p>`
      : '';
    const sleepHint = state.clock.running && (wakeState === 'unsupported' || wakeState === 'failed')
      ? '<p class="conn">이 브라우저는 화면 꺼짐을 막지 못합니다 — 윈도우 설정 → 전원에서 화면 끄기·절전을 "안 함"으로 해 두세요 (노트북 덮개도 닫지 마세요)</p>'
      : '';
    const code = sharedCode();
    const shareLine = !code ? ''
      : shareGone
        ? '<p class="conn bad">같이 쓰기가 끝났습니다 (주인이 껐습니다) — 지금 화면은 그대로 두고, 내 이벤트로 보관해 두면 이어서 쓸 수 있습니다'
          + ' <button type="button" class="mini" data-act="team-keep">내 이벤트로 보관</button></p>'
        : `<p class="conn ${iRunClock() ? 'ok' : ''}">같이 쓰는 중 · 코드 <b>${esc(S.codeText(code))}</b> · ${iRunClock()
          ? '교대 시계는 이 PC가 돌립니다'
          : '교대 시계는 다른 PC가 돌립니다 <button type="button" class="mini" data-act="run-take">이 PC에서 돌리기</button>'
        }${shareError ? ` · <span class="warn-text">${esc(shareError)}</span>` : ''}</p>`;
    setHTML($('noticeBar'), stall + warn.map(w => `<p class="conn bad">${esc(w)}</p>`).join('') + shareLine + sleepHint + (items ? `<ul>${items}</ul>` : ''));
  }

  // 같은 브라우저에 디렉터 화면이 또 열려 있는지 서로 알린다 (보드·휴대폰 화면은 제외).
  // 뒤에 가려진 창은 일반 타이머가 늦춰지므로 1초 박자(tick, Worker)에 맞춰 5초마다 보낸다
  let otherDirectorAt = 0;
  let lastHelloAt = 0;
  const directorChannel = event && !isBoard && !isMe && 'BroadcastChannel' in window ? new BroadcastChannel('dealer-director') : null;
  const hello = event ? `director:${event.id}` : '';
  if (directorChannel) directorChannel.onmessage = e => { if (e.data === hello) otherDirectorAt = Date.now(); };
  function helloOtherDirectors() {
    if (!directorChannel || Date.now() - lastHelloAt < 5000) return;
    lastHelloAt = Date.now();
    directorChannel.postMessage(hello);
  }


  // ---------- 렌더: 로테이션 탭 ----------

  // 한 줄 요약 (예전의 숫자 카드 6개)
  function renderStats() {
    const st = E.staffing(state);
    const cls = st.available < st.tables ? 'danger' : st.diff < 0 ? 'warn' : 'ok';
    const item = (label, value, extra, title) =>
      `<span class="${extra || ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)} <b>${esc(value)}</b></span>`;
    const btn = state.button
      ? `<button type="button" class="btn-today" data-act="button-draw" title="오늘 버튼 — 1~9번 중 무작위로 뽑았습니다 (딜러 휴대폰에도 보임). 눌러서 다시 뽑기">버튼 <b>${state.button.no}번</b></button>`
      : '';
    setHTML($('stats'), [
      btn,
      item('테이블', st.tables, '', st.idle ? '사용 중인 테이블 (대기 제외)' : ''),
      st.idle ? item('대기', st.idle, 'idle', '열려 있지만 딜러를 넣지 않은 테이블 — 칸에서 [사용]을 체크하면 투입') : '',
      item('근무', st.working),
      item('휴식', st.onBreak),
      st.onTask ? item('업무', st.onTask, 'duty', '다른 업무 중 — 테이블에는 없지만 근무로 계산') : '',
      st.planned ? item('출근 예정', st.planned, 'idle', '아직 출근 전') : '',
      st.limited
        ? item('권장', st.recommended, '', `최대 ${state.settings.maxWorkMinutes}분 근무 기준 권장 인원`)
        : item('필요', st.recommended, '', '최대 근무 제한 없음 — 테이블 수만큼 있으면 되고, 남는 만큼 교대'),
      item(st.limited ? '여유/부족' : '쉴 수 있는 인원', (st.diff > 0 ? '+' : '') + st.diff, cls),
    ].join(''));
  }

  function renderAlerts(now) {
    const html = E.suggestions(state, now).map(a =>
      `<div class="alert ${a.level}"><span>${esc(a.text)}</span>${a.actions
        .map(x => `<button data-act="${x.type}" data-id="${x.id}">${esc(x.label)}</button>`).join('')}</div>`).join('');
    setHTML($('alerts'), html);
  }

  // 테이블 칸: 번호·딜러·연속 근무·다음 교대에 들어올 사람. 칸을 누르면 메뉴(지정·교체·바로잡기·고정), [사용] 체크와 자주 쓰는 [깨기]는 칸에
  function renderTables(now) {
    const limited = E.hasWorkLimit(state);
    const maxMs = E.maxWorkMs(state);
    const plan = nextPlan();
    const incoming = new Map(plan ? plan.moves.filter(m => m.toDealerId).map(m => [m.tableId, m.toDealerId]) : []);
    const workedOf = d => (d && state.clock.running ? E.workedMs(state, d, now) : 0);
    // 제한이 없으면 막대는 '지금 가장 오래 일한 사람' 기준 (꽉 찬 막대 = 다음 휴식 후보)
    const scale = limited ? maxMs : Math.max(E.MIN, ...E.working(state).map(workedOf));
    const html = E.activeTables(state).map(t => {
      if (t.use === false) return idleCard(t, incoming.get(t.id));
      const d = t.dealerId ? E.dealerOf(state, t.dealerId) : null;
      const w = workedOf(d);
      const pct = Math.min(100, Math.round((w / scale) * 100));
      const nextIn = incoming.get(t.id);
      const fresh = !!E.undoInfo(state, t.id, now); // 방금 교대된 테이블
      const cls = ['tcard', t.feature && 'feature', t.locked && 'locked', !d && 'vacant', d && w >= maxMs && 'over', nextIn && 'going', fresh && 'fresh']
        .filter(Boolean).join(' ');
      const tags = [t.feature && '<em>피처</em>', t.locked && '<em class="lock">고정</em>'].filter(Boolean).join('');
      return `<div class="${cls}" data-table="${t.id}" role="button" tabindex="0" title="눌러서 지정·교체·바로잡기·고정">
        <div class="tno">${tchip(t.no)}${tags}${useBox(t)}<button class="mini danger" data-act="close" data-id="${t.id}" title="${t.no}번 테이블 깨기">깨기</button></div>
        <div class="tdealer">${d ? `${esc(d.name)} <span class="grade">${esc(d.grade)}</span>${eoTags(d)}` : '공석 · 눌러서 넣기'}</div>
        <div class="tmeta">${d ? `${minutes(w)}분 근무${limited ? ` / ${state.settings.maxWorkMinutes}분` : ''}` : ''}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        ${nextIn ? `<div class="tnext">다음 → <b>${esc(nameOf(nextIn))}</b></div>` : ''}
        ${t.sched ? `<div class="tsched">예약 · ${esc(schedText(t))}</div>` : ''}
      </div>`;
    }).join('');
    setHTML($('tables'), html || '<p class="empty">오픈된 테이블이 없습니다. 위에서 테이블 번호를 입력하세요.</p>');
  }

  // [사용] 체크: 켜면 다음 순서 딜러 투입, 끄면 딜러는 휴식 (테이블은 열린 채 대기)
  const useBox = t => `<label class="use-chk" title="${t.use === false
    ? '체크하면 다음 순서 딜러가 바로 들어갑니다' : '끄면 딜러는 휴식으로 가고 테이블은 열린 채 대기합니다'}"><input type="checkbox" data-use="${t.id}"${t.use === false ? '' : ' checked'}> 사용</label>`;

  // 대기 테이블: 열려 있지만 딜러를 넣지 않음
  function idleCard(t, nextIn) {
    const tags = [t.feature && '<em>피처</em>', t.locked && '<em class="lock">고정</em>'].filter(Boolean).join('');
    return `<div class="tcard idle${t.feature ? ' feature' : ''}" data-table="${t.id}" role="button" tabindex="0" title="눌러서 사용·교대 때 사용 시작·딜러 지정·깨기">
        <div class="tno">${tchip(t.no)}${tags}${useBox(t)}<button class="mini danger" data-act="close" data-id="${t.id}" title="${t.no}번 테이블 깨기">깨기</button></div>
        <div class="tdealer">대기 · 딜러 없음</div>
        <div class="tmeta">${t.sched ? '' : '사용을 체크하면 바로 투입 · 눌러서 교대 때 사용 시작'}</div>
        <div class="bar"><i style="width:0%"></i></div>
        ${t.sched ? `<div class="tsched">예약 · ${esc(schedText(t))}</div>` : ''}
        ${nextIn ? `<div class="tnext">다음 → <b>${esc(nameOf(nextIn))}</b></div>` : ''}
      </div>`;
  }

  // 사용 체크 바꾸기. 딜러가 앉아 있는 테이블을 끌 때만 한 번 묻는다 (되돌리기도 됨)
  function setUse(ids, use) {
    const list = ids.map(id => E.tableOf(state, id)).filter(t => t && t.status === 'open' && (t.use !== false) !== use);
    if (!list.length) return false;
    const what = `${E.rangeText(list.map(t => t.no))}번`;
    const seated = list.filter(t => t.dealerId).map(t => `${t.no}번 ${nameOf(t.dealerId)}`);
    if (!use && seated.length && !confirm(`${what} 테이블 사용을 끌까요?\n${seated.join(', ')}은(는) 휴식으로 가고, 테이블은 열린 채 대기합니다.`)) return false;
    commit(E.setTableUse(state, list.map(t => t.id), use, Date.now()), `${what} ${use ? '사용' : '사용 안 함'}`);
    toast(use ? `${what} 사용 — 딜러 투입` : `${what} 대기${seated.length ? ' — 딜러는 휴식' : ''}`, true);
    return true;
  }

  document.addEventListener('change', e => {
    const auto = e.target.closest && e.target.closest('input[data-auto-arrive]');
    if (auto) {
      commit(E.updateSettings(state, { autoArrive: auto.checked }, Date.now()));
      toast(auto.checked ? '체크 없이 출근 — 예정 시각이 되면 출근 처리하고 다음 교대에 넣습니다' : '출근 체크해야 투입 — 딜러가 휴대폰에서 출근 체크하거나 명단의 [출근]');
      return;
    }
    const box = e.target.closest && e.target.closest('input[data-use]');
    if (!box) return;
    if (!setUse([box.dataset.use], box.checked)) box.checked = !box.checked; // 취소하면 원래대로
  });

  // 다음 교대: 딜러 이름이 왼쪽 (들어가는 딜러 → 테이블, 나오는 딜러는 휴식). 평소 교대는 표시 없이, 주의할 것만 표시
  function renderPreview() {
    const plan = nextPlan();
    $('previewTitle').innerHTML = plan
      ? `다음 교대 <b class="ptime">${hhmm(plan.at)}</b> <small class="muted">${plan.moves.length}테이블 교대 · ${plan.kept}테이블 유지</small>`
      : '다음 교대';
    if (!plan) {
      setHTML($('preview'), '<p class="empty">로테이션을 시작하면 다음 교대가 여기에 미리 보입니다.</p>');
      return;
    }
    const seatAfter = new Map(plan.moves.filter(m => m.toDealerId).map(m => [m.toDealerId, m.tableNo]));
    const rows = plan.moves.map(m => {
      const [label, cls] = KIND[m.kind] || KIND.in;
      // 나간 사람이 다른 테이블로 옮겨 앉으면(테이블 맞바꿈) 휴식이 아니라 그 테이블
      const out = !m.fromDealerId ? '빈자리' : seatAfter.has(m.fromDealerId)
        ? `${esc(nameOf(m.fromDealerId))} → ${seatAfter.get(m.fromDealerId)}번` : `${esc(nameOf(m.fromDealerId))} 휴식`;
      return `<tr><td><b>${m.toDealerId ? esc(nameOf(m.toDealerId)) : '—'}</b></td><td>→ ${tchip(m.tableNo)}</td>
        <td class="muted">${out}</td><td>${m.kind === 'in' ? '' : `<span class="tag ${cls}">${label}</span>`}</td></tr>`;
    }).join('');
    const warn = plan.warnings.map(w => `<p class="warn-text">주의 · ${esc(w)}</p>`).join('');
    setHTML($('preview'), (rows ? `<table class="ptable"><tbody>${rows}</tbody></table>` : '<p class="empty">교대할 테이블 없음</p>') + warn);
  }

  // 퇴근 희망 순번 — 먼저 말한 사람이 1번
  let eoCache = { state: null, no: new Map() };
  function eoNo(id) {
    if (eoCache.state !== state) eoCache = { state, no: new Map(E.eoOrder(state).map((d, i) => [d.id, i + 1])) };
    return eoCache.no.get(id) || 0;
  }

  // 퇴근 희망 표시: 희망(순번) / 휴대폰 답변 대기 / 물어봤더니 계속 근무
  const eoTags = d => [
    d.earlyOut && `<span class="tag info">퇴근 희망 ${eoNo(d.id)}번</span>`,
    d.eoAsk && '<span class="tag warn">답변 대기</span>',
    d.eoStay && '<span class="tag">계속 근무</span>',
  ].filter(Boolean).join(' ');

  // 퇴근 희망 받기 (모든 딜러 휴대폰) + 희망자 목록
  function renderEoPanel() {
    const call = state.eoCall;
    const on = state.dealers.filter(d => d.status === 'working' || d.status === 'break' || d.status === 'duty');
    const wanted = E.eoOrder(state); // 먼저 말한 사람부터
    const asked = on.filter(d => d.eoAsk);
    const where = d => (d.status === 'working' ? `${E.tableOf(state, d.tableId).no}번 근무 중` : d.status === 'duty' ? '다른 업무' : '휴식');
    const head = call.open
      ? `<div class="eo-head"><b>휴대폰으로 받는 중</b><span class="muted">${hhmm(call.at)}부터 · ${wanted.length}명</span>
           <button data-act="eo-close">마감</button></div>`
      : `<div class="eo-head"><span class="muted">${wanted.length ? `희망 ${wanted.length}명` : '희망자 없음'}</span>
           <button data-act="eo-call"${isPublisher() ? '' : ' disabled'}>휴대폰으로 받기</button></div>`;
    const notes = [];
    if (!isPublisher()) notes.push('<p class="hint">딜러용 링크(실시간 공유)를 연결하면 모든 딜러 휴대폰에 [퇴근 희망] 버튼을 띄울 수 있습니다.</p>');
    const list = wanted.map((d, i) => `<li><div><span class="pno">${i + 1}</span> <b>${esc(d.name)}</b>
          <span class="meta">${where(d)}${d.eoAt ? ` · ${hhmm(d.eoAt)} 신청` : ''}</span></div>
        <div class="row-actions"><button data-act="eo" data-id="${d.id}">희망 취소</button><button data-act="home" data-id="${d.id}">퇴근</button></div></li>`);
    if (asked.length) list.push(`<li class="wait"><span class="meta">휴대폰 답변 대기: ${asked.map(d => esc(d.name)).join(', ')}</span></li>`);
    setHTML($('eoPanel'), `<div class="eo-panel${call.open ? ' open' : ''}">${head}${notes.join('')}
      ${list.length ? `<ul class="people">${list.join('')}</ul>` : ''}</div>`);
  }

  // 휴식 목록은 실제 투입 순서대로: 쉰 사람 → 덜 쉰 사람 → 보류
  function poolInOrder(now) {
    const pool = E.breakPool(state, now);
    const rank = d => (d.hold ? 2 : E.isRested(state, d, now) ? 0 : 1);
    return pool.map((d, i) => [d, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
  }

  function renderPool(now) {
    const min = state.settings.minRestMinutes;
    const plan = nextPlan();
    const goingIn = new Set(plan ? plan.moves.map(m => m.toDealerId) : []);
    const html = poolInOrder(now).map((d, i) => {
      const ok = E.isRested(state, d, now);
      const tags = [
        goingIn.has(d.id) && '<span class="tag in">다음 투입</span>',
        d.hold && '<span class="tag warn">보류</span>',
        eoTags(d),
      ].filter(Boolean).join(' ');
      const eoBtn = d.earlyOut ? `<button class="mini" data-act="eo" data-id="${d.id}" title="퇴근 희망 취소">희망 취소</button>`
        : d.eoAsk ? `<button class="mini" data-act="eo-unask" data-id="${d.id}">묻기 취소</button>`
          : `<button class="mini" data-act="eo-open" data-id="${d.id}" title="퇴근 희망 표시 또는 휴대폰으로 묻기">퇴근 희망</button>`;
      return `<li class="${d.hold ? 'held' : ok ? 'ok' : 'short'}">
        <div class="prow"><span class="pno">${i + 1}</span><b>${esc(d.name)}</b> <span class="grade">${esc(d.grade)}</span> ${tags}</div>
        <div class="prow2">
          <span class="meta">휴식 ${minutes(E.restedMs(d, now))}분${ok ? '' : ` / ${min}분`}</span>
          <span class="pacts">
            <button class="mini" data-act="hold" data-id="${d.id}" title="${d.hold ? '다시 자동으로 투입' : '자동으로 투입하지 않음 (식사·개인 사정)'}">${d.hold ? '보류 해제' : '보류'}</button>
            ${eoBtn}
            <button class="mini" data-act="home" data-id="${d.id}">퇴근</button>
          </span>
        </div>
      </li>`;
    }).join('');
    setHTML($('pool'), html || '<li class="empty">휴식 중인 딜러 없음</li>');
  }

  function renderLog() {
    setHTML($('log'), state.log.slice(0, 150)
      .map(l => `<li class="${l.type}"><time>${hhmm(l.at)}</time>${esc(l.msg)}</li>`).join(''));
  }

  // ---------- 렌더: 출퇴근 탭 ----------

  // 출근 예정 딜러 상태 글귀 — 딜러 현황판과 같은 말로
  function planLabel(d, now) {
    if (d.planAt == null) return d.checkAt != null ? '✓체크 · 다음 교대부터' : '출근 전';
    if (d.checkAt != null) return `✓체크 · ${hhmm(d.planAt)}부터`;
    return d.planAt <= now ? `${hhmm(d.planAt)} 지남 · 체크 안 함` : `${hhmm(d.planAt)} 출근 예정`;
  }

  function onDutyMs(d, now) { // 근무시간 (출근–퇴근)
    return d.sessions.reduce((sum, x) => sum + ((x.out == null ? now : x.out) - x.in), 0);
  }
  function dealingMs(d, now) {
    return d.totalWorkMs + (d.status === 'working' && state.clock.running ? Math.max(0, E.clockNow(state, now) - d.since) : 0);
  }
  function restMs(d, now) {
    return d.totalRestMs + (d.status === 'break' && state.clock.running ? E.restedMs(d, now) : 0);
  }

  // 출근자 명단 — 체크하면 출근, 풀면 퇴근. 체크 상태는 엔진이 dealers에서 뽑아 준다
  function renderRoster() {
    const list = E.rosterView(state);
    if (!list.length) {
      setHTML($('roster'), '<p class="empty">명단이 비어 있습니다. 위에 이름을 적어 추가한 뒤, 온 사람을 체크하면 출근 처리됩니다.</p>');
      return;
    }
    const came = list.filter(r => r.state === 'in').length;
    const label = { in: '출근', off: '퇴근함', none: '아직', plan: '출근 예정' };
    const rows = list.map(r => `<li class="r-${r.state}">
      <label class="chk">
        <input type="checkbox" data-act="attend" data-name="${esc(r.name)}"${r.state === 'in' || r.checked ? ' checked' : ''}>
        <b>${esc(r.name)}</b> <span class="grade">${esc(r.grade)}</span>
      </label>
      <span class="r-state">${r.state !== 'plan' ? label[r.state] : planLabel(E.dealerOf(state, r.id), Date.now())}</span>
      <button class="mini" data-act="roster-del" data-name="${esc(r.name)}" title="명단에서 빼기">×</button>
    </li>`).join('');
    setHTML($('roster'), `<p class="muted roster-sum">${came} / ${list.length}명 출근</p><ul class="roster">${rows}</ul>`);
  }
  function dutyMs(d, now) {
    return (d.totalDutyMs || 0) + (d.status === 'duty' ? Math.max(0, E.clockNow(state, now) - d.since) : 0);
  }

  function renderAttendance(now) {
    const ord = d => (d.status === 'off' ? 2 : d.status === 'planned' ? 1 : 0);
    const list = state.dealers.slice()
      .sort((a, b) => ord(a) - ord(b) || (a.checkInAt || a.planAt || 0) - (b.checkInAt || b.planAt || 0));
    if (!list.length) {
      setHTML($('attendanceList'), '<p class="empty">아직 출근한 딜러가 없습니다.</p>');
      return;
    }
    const rows = list.map(d => {
      const where = d.status === 'working' ? `${tchip(E.tableOf(state, d.tableId).no)} 근무`
        : d.status === 'break' ? (d.hold ? '휴식 (보류)' : '휴식')
          : d.status === 'duty' ? `업무 · ${esc(d.task)}`
            : d.status === 'planned' ? planLabel(d, now) : '퇴근';
      const sessions = d.sessions.map(x => `${hhmm(x.in)}–${x.out == null ? '' : hhmm(x.out)}`).join(', ');
      const fix = d.sessions.length ? `<button class="mini" data-act="times-open" data-id="${d.id}" title="실제 출퇴근 시각으로 고치기">시간 고치기</button>` : '';
      const actions = `<span class="pacts">${fix}${d.status === 'off'
        ? `<button class="mini" data-act="back" data-id="${d.id}">복귀</button>`
        : d.status === 'planned'
          ? `${d.checkAt != null ? '' : `<button class="mini" data-act="arrive" data-id="${d.id}">출근</button>`}<button class="mini" data-act="dealer-open" data-id="${d.id}">출근 시간</button>`
          : `${E.canDelay(state, d.id, Date.now()) ? `<button class="mini" data-act="dealer-open" data-id="${d.id}" title="늦게 오면 — 바꾼 시각에 출근, 로테이션도 그에 맞춰">출근 시간 변경</button>` : ''}<button class="mini" data-act="home" data-id="${d.id}">퇴근</button>`}</span>`;
      const duty = dutyMs(d, now);
      return `<tr class="${d.status}">
        <th>${esc(d.name)}</th><td>${esc(d.grade)}</td><td>${where}</td><td>${sessions}</td>
        <td>${hm(onDutyMs(d, now))}</td><td>${hm(dealingMs(d, now))}${duty ? ` <small class="muted">+업무 ${hm(duty)}</small>` : ''}</td><td>${hm(restMs(d, now))}</td>
        <td>${actions}</td></tr>`;
    }).join('');
    setHTML($('attendanceList'), `<div class="scroll"><table class="grid">
      <thead><tr><th>이름</th><th>등급</th><th>상태</th><th>출근–퇴근</th><th>근무시간</th><th>딜링</th><th>휴식</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`);
  }

  // 출퇴근 시각 직접 적기 — 웹에서 누른 시각이 아니라 실제 시각으로 (근무시간 기록·CSV만 바뀌고 로테이션 장부는 그대로)
  let timesDealer = null;
  function openTimes(dealerId) {
    const d = E.dealerOf(state, dealerId);
    if (!d) return;
    timesDealer = d.id;
    $('timesTitle').textContent = `${d.name} 출퇴근 시각`;
    $('timesBody').innerHTML = d.sessions.map((x, i) => `<div class="times-row">
        ${d.sessions.length > 1 ? `<span class="muted">${i + 1}</span>` : ''}
        <label>출근 <input type="time" name="in${i}" value="${hhmm(x.in)}" required></label>
        ${x.out == null
          ? '<span class="muted">– 근무 중 (퇴근은 퇴근 버튼으로)</span>'
          : `<label>퇴근 <input type="time" name="out${i}" value="${hhmm(x.out)}" required></label>`}
      </div>`).join('');
    $('timesMsg').textContent = '';
    $('dlgTimes').showModal();
  }

  $('formTimes').addEventListener('submit', e => {
    if (!e.submitter || e.submitter.value !== 'save') return;
    e.preventDefault();
    const d = E.dealerOf(state, timesDealer);
    if (!d) return;
    const f = e.target.elements;
    const list = d.sessions.map((x, i) => ({
      in: E.nearTime(x.in, f[`in${i}`].value),
      out: x.out == null ? null : E.nearTime(x.out, f[`out${i}`].value),
    }));
    const res = E.editSessions(state, d.id, list, Date.now());
    if (res.error) {
      $('timesMsg').textContent = res.error;
      return;
    }
    $('dlgTimes').close();
    if (res.state === state) return;
    commit(res.state, `${d.name} 출퇴근 시각`);
    toast(`${d.name} 출퇴근 시각을 고쳤습니다`, true);
  });

  // ---------- 렌더: 공지 탭 ----------

  function renderNotices() {
    const html = state.notices.map(n =>
      `<li><time>${hhmm(n.at)}</time><span>${esc(n.text)}</span><button data-act="delnotice" data-id="${n.id}" class="danger">삭제</button></li>`).join('');
    setHTML($('notices'), html || '<li class="empty">등록된 공지가 없습니다</li>');
  }

  // ---------- 렌더: 보드 (딜러룸 TV) ----------
  // 받은 표(sheet) 하나로 그린다 — 다른 컴퓨터의 TV는 방에서 받은 것, 같은 브라우저의 보드는 이 PC의 상태로 만든 것

  function renderBoardClock(sh, now) {
    const box = $('pushClock');
    if (!sh || !sh.c) {
      $('countdown').textContent = '--:--';
      $('pushAt').textContent = '로테이션 시작 전';
      box.className = 'push-clock';
      return;
    }
    const paused = sh.c === 2;
    const nextAt = PV.abs(sh, sh.n);
    const left = paused ? sh.n * 1000 : nextAt - now;
    $('countdown').textContent = mmss(left);
    $('pushAt').textContent = paused ? '일시정지 중' : `${hhmm(nextAt)} 교대`;
    box.className = 'push-clock' + (paused ? ' paused' : left <= 0 ? ' due' : left <= sh.w * E.MIN ? ' soon' : '');
  }

  function renderBoard(now) {
    const sh = boardSheet();
    $('eventName').textContent = (sh && sh.t) || (event && event.name) || ''; // 어느 이벤트 보드인지
    renderBoardClock(sh, now);
    const moves = sh ? PV.nextMoves(sh) : null;
    const lines = [];
    const from = v => (v > 0 ? tchip(v) : '휴식');
    if (moves) {
      moves.tables.forEach(t => {
        t.in.forEach(m => lines.push(`<li><b>${esc(m.name)}</b><span>${from(m.from)} → ${tchip(t.no)}</span></li>`));
        t.out.forEach(m => lines.push(`<li class="out"><b>${esc(m.name)}</b><span>${tchip(t.no)} → 휴식</span></li>`));
      });
    }
    const notices = sh ? sh.nt.map(([at, text]) => `<li><time>${hhmm(PV.abs(sh, at))}</time><span>${esc(text)}</span></li>`).join('') : '';
    setHTML($('board'), `
      ${remoteNote(now)}
      ${notices ? `<section class="notice-bar big"><ul>${notices}</ul></section>` : ''}
      <section><h2>다음 교대${moves ? ' · ' + hhmm(moves.at) : ''}</h2>
        ${lines.length ? `<ul class="bmoves">${lines.join('')}</ul>` : '<p class="empty">—</p>'}</section>
      <section><h2>로테이션 표</h2>${sh ? sheetHTML('dealer', null, phoneSheet(sh)) : '<p class="muted">표를 받는 중…</p>'}</section>`);
  }

  // ---------- 렌더: 딜러 휴대폰 (내 순서) ----------

  function loadMe() {
    try { return JSON.parse(localStorage.getItem(ME_KEY)); } catch (e) { return null; }
  }
  function saveMe(d) {
    try {
      if (d) localStorage.setItem(ME_KEY, JSON.stringify({ id: d.id, name: d.name }));
      else localStorage.removeItem(ME_KEY);
    } catch (e) { /* 기억 못 해도 화면은 동작 */ }
  }
  // -1 = 그때 없음 (휴대폰에서는 아직 출근 전), -2 = 다른 업무
  const placeText = v => (v == null || v === -1 ? '출근 전' : v === 0 ? '휴식' : v === E.DUTY ? '다른 업무' : `${v}번 테이블`);
  const placeChip = v => (v == null || v === -1 ? '<span class="place off">출근 전</span>'
    : v === 0 ? '<span class="place rest">휴식</span>'
      : v === E.DUTY ? '<span class="place duty">업무</span>'
        : `<span class="place tb" style="--h:${hue(v)}">${v}</span>`);

  // 퇴근 희망 카드 — 디렉터가 받기를 열었거나 나에게 물어봤을 때 버튼이 뜬다 (me.k = 지금 답할 수 있는 질문, me.q = 나에게 온 묻기)
  function meEoHtml(me) {
    const k = me.k;
    const pending = meEoSending || (k && myReply && myReply.k === k && myReply.at !== me.ea ? myReply : null);
    const card = (cls, label, body, buttons) => `<section class="me-eo ${cls}"><span class="label">${label}</span>${body}
      ${buttons ? `<div class="me-eo-actions">${buttons}</div>` : ''}</section>`;
    if (!k) return me.e ? card('done', '퇴근 희망', '<b>접수됨</b><small>디렉터가 순서를 정해 알려 줍니다</small>') : '';
    if (pending) {
      const what = pending.w ? '퇴근 희망' : me.q ? '계속 일할게요' : '퇴근 희망 취소';
      return card('', '퇴근 희망', `<b>${what}</b><small>디렉터 화면에 전달하는 중…</small>`);
    }
    if (me.q) {
      return card('ask', '디렉터가 물어봐요', '<b>오늘 먼저 퇴근할래요?</b>',
        '<button class="primary" data-act="me-eo" data-w="1">퇴근할게요</button><button data-act="me-eo" data-w="0">계속 일할게요</button>');
    }
    return me.e
      ? card('done', '퇴근 희망 받는 중', '<b>퇴근 희망 접수됨</b><small>디렉터가 순서를 정해 알려 줍니다</small>',
        '<button data-act="me-eo" data-w="0">취소</button>')
      : card('ask', '퇴근 희망 받는 중', '<b>일찍 퇴근하고 싶으면 눌러 주세요</b>',
        '<button class="primary" data-act="me-eo" data-w="1">퇴근 희망</button>');
  }

  // 출근 체크 카드 — 출근 예정인 딜러 휴대폰에 (딜러 QR로 연 화면 그대로). 일찍 눌러도 예정 시각에 투입
  let meCiSending = false;
  let myCheck = null; // 내가 보낸 출근 체크 {id, at(이 기기 시각)} — 디렉터가 반영할 때까지 '전달하는 중'
  function meCheckHtml(me, id) {
    if (!me.pl) return '';
    const when = me.pa != null ? hhmm(PV.abs(me, me.pa)) : null;
    const card = (cls, body, buttons) => `<section class="me-eo ${cls}"><span class="label">출근 체크</span>${body}
      ${buttons ? `<div class="me-eo-actions">${buttons}</div>` : ''}</section>`;
    if (me.ci) return card('done', `<b>출근 체크됨</b><small>${when ? `${when}부터 로테에 들어갑니다` : '곧 로테에 들어갑니다'}</small>`);
    if (meCiSending || (myCheck && myCheck.id === id && Date.now() - myCheck.at < 120000)) {
      return card('', '<b>출근 체크</b><small>디렉터 화면에 전달하는 중…</small>');
    }
    if (!remote) return card('', '<b>출근 전</b><small>딜러 QR로 연 휴대폰에서 출근 체크합니다</small>');
    const early = me.pa != null && PV.abs(me, me.pa) > nowMs();
    return card('ask', `<b>출근했으면 눌러 주세요</b><small>${early ? `일찍 눌러도 ${when}부터 투입됩니다` : '누르면 다음 교대부터 투입됩니다'}</small>`,
      '<button class="primary" data-act="me-checkin">출근 체크</button>');
  }

  async function sendMyCheckIn() {
    if (!remote || !myId || meCiSending) return;
    const id = myId;
    meCiSending = true;
    render();
    try {
      await S.sendCheckIn(rdb(), remote.room, id);
      myCheck = { id, at: Date.now() };
      fastUntil = Date.now() + 30000;
    } catch (err) {
      toast(/Permission denied/i.test(err.message)
        ? '출근 체크를 보내지 못했습니다 — 이미 출근 처리됐거나 출근 예정 명단에 없습니다. 디렉터에게 말해 주세요'
        : '보내지 못했습니다 — 인터넷 연결을 확인하세요');
    }
    meCiSending = false;
    render();
  }

  // 보낸 뒤 서버 시각(at)을 받아 둔다 → 디렉터가 반영하면(내 것의 ea가 같아지면) '전달하는 중'이 사라진다
  async function sendMyEo(w) {
    const k = remote && mine ? mine.k : null;
    if (!k || meEoSending) return;
    const id = myId;
    meEoSending = { w };
    render();
    try {
      await S.sendEoReply(rdb(), remote.room, id, w, k);
      myReply = (await S.get(rdb(), rpath(`eo/${id}`)).catch(() => null)) || { w, k, at: -1 };
      fastUntil = Date.now() + 30000;
    } catch (err) {
      toast(/Permission denied/i.test(err.message)
        ? '보내지 못했습니다 — 디렉터가 마감했거나 설정이 필요합니다. 디렉터에게 말해 주세요'
        : '보내지 못했습니다 — 인터넷 연결을 확인하세요');
    }
    meEoSending = null;
    render();
  }

  function renderMe(now) {
    const box = $('me');
    const data = meData();
    const me = data.me;
    if (!me) {
      const nm = data.names;
      const list = nm ? Object.entries(nm.d).sort((a, b) => a[1].localeCompare(b[1], 'ko')) : [];
      const empty = !remote
        ? '디렉터에게 받은 <b>딜러용 링크(QR)</b>로 열어 주세요.<br><small>그냥 주소로 열면 디렉터 화면과 연결되지 않습니다.</small>'
        : remoteSeen
          ? '아직 출근 명단이 없습니다.<br>디렉터가 출근 처리를 하면 여기에 이름이 나타납니다.'
          : '디렉터 화면에 연결하는 중입니다…';
      // 이 휴대폰이 골라 둔 딜러가 명단에 없으면 (퇴근 처리됨) 그렇다고 알려 준다
      const saved = loadMe();
      const gone = saved && nm && remoteSeen
        ? `<p class="conn">${esc(saved.name)} 님은 지금 출근 명단에 없습니다 (퇴근 처리됨). 다시 출근하면 자동으로 내 순서가 보입니다.</p>` : '';
      setHTML(box, `
        <header class="me-head"><b>내 순서</b><span class="muted">${esc((nm && nm.t) || '딜러 디렉터')}</span></header>
        ${remoteNote(now)}
        ${gone}
        <h1 class="me-title">${saved && nm && remoteSeen ? '다른 이름으로 보기' : '내 이름을 선택하세요'}</h1>
        ${list.length
          ? `<div class="me-pick">${list.map(([id, name]) => `<button data-act="me-pick" data-id="${esc(id)}" data-name="${esc(name)}">${esc(name)}</button>`).join('')}</div>
             <p class="muted">한 번 고르면 이 휴대폰이 기억합니다.</p>`
          : `<p class="me-empty">${empty}</p>`}`);
      return;
    }

    const notices = me.nt.map(([at, text]) => `<li><time>${hhmm(PV.abs(me, at))}</time><span>${esc(text)}</span></li>`).join('');
    const noticeHtml = remoteNote(now) + (notices ? `<section class="notice-bar"><ul>${notices}</ul></section>` : '');
    const running = me.c > 0;
    const paused = me.c === 2;
    const next = PV.nextChange(me); // [시각, 자리]
    const soon = !!(next && me.c === 1 && next[0] - now <= me.w * E.MIN);
    // 일한 시간·쉰 시간은 딜러에게 보여주지 않는다 (사용자 요청) — 지금 상태만
    const nowLine = me.pl ? (me.pa != null ? `${hhmm(PV.abs(me, me.pa))} 출근 예정` : '출근하면 내 순서가 보입니다')
      : me.x === E.DUTY ? esc(me.tk)
        : !running ? '로테이션 시작 전'
          : me.h ? '투입 보류 중'
            : me.x > 0 ? '근무 중' : '';

    const nextHtml = !running ? '' : next
      ? `<section class="me-next ${soon ? 'soon' : ''}">
           <span class="label">${soon ? '곧 이동하세요' : '다음 이동'}</span>
           <div class="me-next-body">${placeChip(next[1])}
             <div><b>${hhmm(next[0])}부터 ${placeText(next[1])}</b><small id="meCountdown"></small></div></div>
         </section>`
      : `<section class="me-next"><span class="label">다음 이동</span>
           <div class="me-next-body"><b>${me.pl ? '출근 체크하면 내 순서가 보입니다' : me.x === E.DUTY ? '업무가 끝나면 휴식 후 다시 순서대로' : '아직 이동 예정이 없습니다'}</b></div></section>`;

    setHTML(box, `
      <header class="me-head"><b>${esc(me.n)}</b><button class="mini" data-act="me-change">다른 이름</button></header>
      ${me.t ? `<p class="me-event">${esc(me.t)}</p>` : ''}
      ${me.bt ? `<p class="me-button">오늘 버튼 <b>${me.bt}번</b></p>` : ''}
      ${noticeHtml}
      ${meCheckHtml(me, data.id)}
      ${meEoHtml(me)}
      <section class="me-now">
        <span class="label">지금</span>
        <div class="me-now-body">${placeChip(me.x)}<div><b>${placeText(me.x)}</b><small>${nowLine}</small></div></div>
      </section>
      ${nextHtml}`);
    // 초 단위로 바뀌는 건 글자만 갈아끼운다 (전체를 다시 그리면 펼친 표가 접힘)
    const cd = $('meCountdown');
    if (cd && next) {
      // 교대가 조금 늦어지면 음수 대신 안내 (디렉터가 교대 버튼을 누르기 전 등)
      cd.textContent = paused ? '일시정지 중' : next[0] > now ? `${mmss(next[0] - now)} 후` : '교대 시간 — 디렉터 확인 중';
    }
  }

  function render(now) {
    if (td) setTimeout(td.report, 0); // Holdem TD 내장 모드: 그린 뒤 상태를 부모에게
    if (needLogin || needFetch) return;
    if (isAdminView) {
      renderAdmin();
      return;
    }
    if (isList) {
      renderEvents();
      return;
    }
    now = now || nowMs();
    if (!isBoard) renderClock(now); // 보드는 받은 표의 시계로 (renderBoard)
    if (isBoard) {
      renderBoard(now);
      return;
    }
    if (isMe) {
      renderMe(now);
      return;
    }
    renderControls();
    renderNoticeBar();
    switch (currentTab()) {
      case 'rotation':
        renderStats();
        renderAlerts(now);
        if (setHTML($('sheet'), sheetHTML(sheetView, null, null, true))) refreshPick();
        renderTables(now);
        renderDealerBoard(now);
        renderPreview();
        renderEoPanel();
        renderPool(now);
        renderLog();
        break;
      case 'attendance':
        renderRoster();
        renderAttendance(now);
        break;
      case 'notice':
        renderNotices();
        break;
    }
  }

  // ---------- 소리/음성 ----------

  let audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* 소리 없이 동작 */ }
  }
  function chime(times) {
    if (!audioCtx) return;
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      const t0 = audioCtx.currentTime + i * 0.35;
      o.frequency.value = 880;
      o.connect(g);
      g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      o.start(t0);
      o.stop(t0 + 0.32);
    }
  }
  function speak(text) {
    if (!state.settings.voice || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }
  function announce(plan) {
    const lines = plan.moves.filter(m => m.toDealerId).map(m => `${nameOf(m.toDealerId)}, ${m.tableNo}번`);
    speak(lines.length ? '교대 시간입니다. ' + lines.join('. ') : '교대 시간입니다. 교대할 테이블이 없습니다.');
  }

  // ---------- 디렉터 PC 화면 꺼짐·절전 막기 ----------
  // 자동 교대·음성 안내·딜러 휴대폰 갱신은 이 화면에서만 돌아간다 → 로테이션이 도는 동안 화면이 꺼지지 않게 한다.
  // 그래도 PC가 멈췄다 돌아오면(노트북 덮개 닫음 등) 1초 박자가 크게 끊기므로 알아채서 위쪽에 경고한다.
  let wakeLock = null;
  let wakePending = false;
  let wakeState = 'off'; // 'on' | 'off' | 'unsupported' | 'failed'
  function keepAwake() {
    const want = isDirector && !!event && !blocked && state.clock.running && !document.hidden;
    if (!want) {
      if (wakeLock) wakeLock.release().catch(() => {});
      wakeLock = null;
      return;
    }
    if (wakeLock || wakePending) return;
    if (!('wakeLock' in navigator)) {
      wakeState = 'unsupported';
      return;
    }
    wakePending = true;
    navigator.wakeLock.request('screen').then(lock => {
      wakeLock = lock;
      wakeState = 'on';
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; }); // 창을 가리면 브라우저가 풀고, 다시 보이면 다시 건다
    }, () => { wakeState = 'failed'; }).finally(() => { wakePending = false; });
  }

  let lastTickAt = 0;
  let stalled = null; // {ms} PC가 멈춰 있었던 시간
  function watchStall(wall) {
    if (lastTickAt && wall - lastTickAt > 60000 && state.clock.running && !state.clock.paused) stalled = { ms: wall - lastTickAt };
    lastTickAt = wall;
  }

  // ---------- 교대 / 타이머 ----------

  function doPush(now) {
    // 다른 탭이 방금 교대했으면 그 결과를 따른다 (중복 교대 방지)
    const fresh = E.migrate(load());
    if (fresh.clock.nextPushAt && state.clock.nextPushAt && fresh.clock.nextPushAt > state.clock.nextPushAt) {
      state = fresh;
      render(now);
      return;
    }
    const res = E.executePush(state, now);
    commit(res.state);
    chime(3);
    announce(res.plan);
  }

  // 딜러 휴대폰: 내 자리가 바뀌기 직전에 진동 + 알림음 (교대 실행은 디렉터 화면만 한다)
  function meTick(now) {
    const me = meData().me;
    if (!me) return;
    // 퇴근 희망 버튼이 새로 뜨면 한 번 알려 준다 (화면을 열어 둔 동안만)
    if (me.k && me.k !== meEoSeen) {
      meEoSeen = me.k;
      try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* 진동 미지원 */ }
      chime(1);
    }
    if (me.c !== 1) return;
    const next = PV.nextChange(me);
    const left = next ? next[0] - now : -1;
    if (left > 0 && left <= me.w * E.MIN && meWarnedFor !== next[0]) {
      meWarnedFor = next[0];
      try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch (e) { /* 진동 미지원 */ }
      chime(2);
    }
  }

  function tick() {
    const wall = Date.now();
    if (isDirector && !blocked) {
      if (wall - sessionAt > 20000 && !sessionPending) checkSession().catch(() => {});
      // 이용 기간: 5분마다, 끝나는 시각이 지나면 바로 (인터넷이 없어도 기간이 지났으면 막는다)
      const over = auth.until > 0 && wall > auth.until;
      if (wall - licenseAt > (over ? 15000 : 5 * 60000)) {
        checkLicense().then(() => { if (isList || isAdminView) render(); }).catch(() => { if (over) block('expired'); });
      }
      if (event && AC.dirty(event) && wall - cloudTryAt > 30000) pushEvent(event.id); // 못 올린 변경 다시
      if (event && event.share && wall - sharePollAt >= SHARE_POLL_MS) { sharePollAt = wall; pollShared(wall); }
      if (event) syncInbox(); // 같이 쓰기에서 교대 시계를 가져가거나 넘겨주면 받는 함도 따라간다
    }
    if (isList || isAdminView || blocked) return; // 목록·관리자 화면은 매초 다시 그릴 필요 없음
    if (isDirector && event) {
      watchStall(wall);
      keepAwake();
    }
    if (remote && !document.hidden) {
      const every = wall < fastUntil ? 3000 : pollFailSince ? 5000 : POLL_MS;
      if (wall - pollAt >= every) pollRemote();
    }
    const now = nowMs();
    const c = state.clock;
    helloOtherDirectors();
    if (isMe) meTick(now);
    if (isDirector && event && iRunClock()) { // 같이 쓰는 중이면 시계를 든 PC에서만 (두 번 처리되지 않게)
      // 출근 예정 시각이 된 딜러 자동 출근 → 교대보다 먼저 (이번 교대에 바로 들어가게)
      const arrived = E.arriveDue(state, now);
      if (arrived !== state) {
        const names = state.dealers.filter(d => d.status === 'planned' && E.dealerOf(arrived, d.id).status !== 'planned').map(d => d.name);
        commit(arrived);
        chime(1);
        toast(`출근: ${names.join(', ')} (예정 시각${state.settings.autoArrive ? ' — 체크 없이 자동. 안 왔으면 명단에서 눌러 출근 시간 변경' : ' — 출근 체크함'})`);
      }
      if (!state.button) commit(E.drawButton(state, Date.now(), Math.random())); // 오늘 버튼 (이벤트마다 한 번)
    }
    // 같이 쓰는 중이면 교대·예고 음성은 시계를 든 PC에서만 (두 번 교대·겹치는 안내를 막는다)
    if (!isBoard && !isMe && iRunClock() && c.running && !c.paused && c.nextPushAt != null) {
      const left = c.nextPushAt - now;
      const warnMs = state.settings.warnBeforeMinutes * E.MIN;
      if (warnMs > 0 && left > 0 && left <= warnMs && warnedFor !== c.nextPushAt) {
        warnedFor = c.nextPushAt;
        chime(2);
        speak(`교대 ${state.settings.warnBeforeMinutes}분 전입니다.`);
      }
      if (left <= 0 && state.settings.autoPush) {
        doPush(now);
      } else if (left <= 0 && dueAlertFor !== c.nextPushAt) {
        dueAlertFor = c.nextPushAt;
        chime(3);
        speak('교대 시간입니다. 지금 교대 버튼을 눌러주세요.');
      }
    }
    if (isPublisher() && now - lastBeatAt >= 30000) publish(true); // 디렉터 PC가 살아 있다는 표시
    if (!document.hidden) render(now);
  }

  // 1초 타이머. 창이 가려지면 브라우저가 화면 쪽 타이머를 1분에 한 번으로 늦추므로
  // 늦추지 않는 별도 스레드(Worker)에서 박자를 받는다. 안 되면 일반 타이머로.
  function startTicker(fn) {
    try {
      const src = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000);'], { type: 'text/javascript' }));
      const w = new Worker(src);
      w.onmessage = fn;
      w.onerror = () => setInterval(fn, 1000);
      return;
    } catch (e) { /* Worker를 못 쓰는 환경 */ }
    setInterval(fn, 1000);
  }

  // ---------- 입력 ----------

  let toastTimer = null;
  // withRevert면 방금 한 작업을 바로 되돌리는 버튼을 같이 (깨기·퇴근처럼 실수하면 큰 작업)
  function toast(msg, withRevert) {
    const t = $('toast');
    const step = withRevert ? E.lastStep(state) : null;
    t.innerHTML = esc(msg) + (step ? ` <button class="mini" data-act="revert" data-at="${step.at}">되돌리기</button>` : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, step ? 6000 : 3000);
  }

  // 작업 되돌리기. at이 방금 토스트로 보여 준 작업과 같으면 묻지 않고 바로
  function revertLast(at) {
    const step = E.lastStep(state);
    if (!step) {
      toast('되돌릴 작업이 없습니다 (교대가 실행되면 그 전 작업은 되돌릴 수 없습니다)');
      return;
    }
    if (String(step.at) !== String(at) && !confirm(`이 작업을 되돌릴까요?\n\n${hhmm(step.at)} ${step.label}`)) return;
    commit(E.revert(state, Date.now()));
    takeCheckIns(true); // 되돌린 작업 뒤에 들어온 휴대폰 출근 체크는 그대로 살린다 (되돌리면 checkAt도 그 전으로 가므로)
    $('toast').hidden = true;
    toast(`되돌림: ${step.label}`);
  }

  // "1-10, 15" → [1..10, 15]
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const today = () => new Date().toISOString().slice(0, 10);

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`복사됨: ${text}`);
    } catch (e) {
      window.prompt('복사하세요', text);
    }
  }

  // 출근 처리: 예정 시각(at)이 지금보다 뒤면 '출근 예정'(그 시각에 자동 출근), 아니면 바로 출근.
  // 출근 예정이던 사람은 출근(또는 시각 바꾸기), 퇴근했던 사람이면 복귀, 이미 출근 중이면 건너뜀
  function checkIn(entries) {
    const now = Date.now();
    let next = state;
    const fresh = [];
    const msgs = [];
    for (const e of entries) {
      const later = e.at != null && e.at > now;
      const plan = later ? `${e.name} ${hhmm(e.at)} 출근 예정` : null;
      const existing = next.dealers.find(d => d.name === e.name && d.status !== 'off') || next.dealers.find(d => d.name === e.name);
      if (existing && existing.status === 'planned') {
        // 시각 없이 적으면 다른 [출근]과 같은 '출근 체크' — 예정 시각 전이면 그 시각에 투입
        next = later ? E.setPlanAt(next, existing.id, e.at, now) : E.checkInDealer(next, existing.id, now, now);
        const nd = E.dealerOf(next, existing.id);
        msgs.push(plan || (nd.status === 'planned' ? `${e.name} 출근 체크 — ${hhmm(nd.planAt)}부터 투입` : `${e.name} 출근`));
      } else if (existing && existing.status !== 'off') {
        msgs.push(`${e.name} 이미 출근 중`);
      } else if (existing) {
        next = later ? E.setPlanAt(next, existing.id, e.at, now) : E.checkBack(next, existing.id, now);
        msgs.push(plan || `${e.name} 복귀`);
      } else {
        fresh.push(e);
        if (plan) msgs.push(plan);
      }
    }
    if (fresh.length) next = E.addDealers(next, fresh, now);
    const allPlanned = entries.every(e => e.at != null && e.at > now);
    commit(next, `${entries.map(e => e.name).join(', ')} ${allPlanned ? '출근 예정' : '출근'}`);
    if (msgs.length) toast(msgs.join(' · '));
  }

  // '김민수 18:00' → {name: '김민수', at}. 이름 뒤에 시각이 없으면 칸의 예정 시각(fallbackAt)
  function parseEntry(text, grade, fallbackAt, now) {
    const m = text.match(/^(.*?)\s*(\d{1,2}:\d{2})$/);
    const at = m ? E.planTime(now, m[2]) : null;
    return { name: (m && at != null ? m[1] : text).trim(), grade, at: at != null ? at : fallbackAt };
  }

  // 엑셀·카톡에서 한 줄에 한 명씩 복사한 명단을 붙여 넣으면 입력칸이 줄바꿈을 지워 이름이 하나로 붙는다
  // → 붙여 넣을 때 줄바꿈·탭을 쉼표로 바꿔 넣는다
  document.querySelectorAll('input[name="names"]').forEach(input => input.addEventListener('paste', e => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!/[\r\n\t]/.test(text)) return;
    e.preventDefault();
    const list = text.split(/[\r\n\t,]+/).map(s => s.trim()).filter(Boolean).join(', ');
    const v = input.value;
    const a = input.selectionStart ?? v.length;
    const b = input.selectionEnd ?? v.length;
    const before = v.slice(0, a).replace(/[\s,]*$/, '');
    const after = v.slice(b).replace(/^[\s,]*/, '');
    input.value = [before, list, after].filter(Boolean).join(', ');
  }));

  // 명단에 이름만 올린다 (출근 처리는 체크할 때)
  document.querySelector('.roster-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    const names = f.names.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    if (!names.length) return;
    const grade = f.grade.value || 'B';
    const next = E.addRoster(state, names, Date.now(), grade);
    if (next === state) toast('이미 명단에 있는 이름입니다');
    else commit(next, `명단에 ${names.join(', ')} 추가`);
    f.names.value = '';
  });

  // 명단 체크 — 켜면 출근(왔다 간 사람이면 복귀), 끄면 퇴근
  $('roster').addEventListener('change', e => {
    const box = e.target.closest('input[data-act="attend"]');
    if (!box) return;
    const name = box.dataset.name;
    const want = box.checked;
    const plan = (E.rosterView(state).find(r => r.name === name) || {}).state === 'plan';
    if (!want && !confirm(plan ? `${name} 출근 예정을 취소할까요?` : `${name} 퇴근 처리할까요?`)) {
      box.checked = true;
      return;
    }
    const next = E.attend(state, name, Date.now(), want);
    if (next === state) {
      render();
      return;
    }
    const after = E.rosterView(next).find(r => r.name === name) || {};
    const what = !want ? (plan ? '출근 예정 취소' : '퇴근') : after.checked ? `출근 체크 — ${hhmm(after.planAt)}부터 투입` : '출근';
    commit(next, `${name} ${what}`);
    toast(`${name} ${what}`, true);
  });

  document.querySelectorAll('.checkin-form').forEach(form => form.addEventListener('submit', e => {
    e.preventDefault();
    const f = form.elements;
    const now = Date.now();
    const at = f.at && f.at.value ? E.planTime(now, f.at.value) : null;
    const entries = f.names.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
      .map(text => parseEntry(text, f.grade.value || 'B', at, now)).filter(x => x.name);
    if (!entries.length) return;
    checkIn(entries);
    f.names.value = '';
    if (f.at) f.at.value = '';
  }));

  document.addEventListener('click', e => {
    unlockAudio();
    const v = e.target.closest('button[data-view]');
    if (v) {
      sheetView = v.dataset.view;
      render();
      return;
    }
    const b = e.target.closest('button[data-act]');
    if (!b) {
      if (e.target.closest('.use-chk')) return; // [사용] 체크는 change에서
      const tile = e.target.closest('[data-table]');
      if (tile) openTableMenu(tile.dataset.table);
      return;
    }
    // 시각을 적는 버튼은 검사를 통과했을 때만 닫는다 (틀리면 창을 남겨 다시 적게)
    if (b.closest('#dlgTable') && !['roster-plan', 'arrive-time', 'plan-save'].includes(b.dataset.act)) $('dlgTable').close();
    const id = b.dataset.id;
    const t = id ? E.tableOf(state, id) : null;
    const d = id ? E.dealerOf(state, id) : null;
    switch (b.dataset.act) {
      case 'relieve':
        if (t) commit(E.relieveTable(state, id, Date.now()), `${t.no}번 교체`);
        break;
      case 'close':
        if (t && confirm(`${t.no}번 테이블을 깨겠습니까?`)) {
          commit(E.closeTable(state, id, Date.now()), `${t.no}번 테이블 깨기`);
          toast(`${t.no}번 테이블 깨짐`, true);
        }
        break;
      case 'lock':
        if (t) commit(E.toggleTableLock(state, id, Date.now()), `${t.no}번 ${t.locked ? '고정 해제' : '고정'}`);
        break;
      case 'use':
      case 'unuse':
        if (t) setUse([t.id], b.dataset.act === 'use');
        break;
      case 'use-all':
        setUse(E.idleTables(state).map(x => x.id), true);
        break;
      case 'assign-open':
        openAssign(id);
        break;
      case 'undo-open':
        openFix(id);
        break;
      case 'fix': {
        e.preventDefault();
        const who = E.dealerOf(state, b.dataset.who);
        const next = E.fixSeat(state, id, b.dataset.who, Date.now());
        if (next === state || !who) break;
        commit(next, `${t ? t.no : ''}번 바로잡기 (${who.name})`);
        $('dlgUndo').close();
        toast(`${t ? t.no : ''}번 바로잡음 — ${who.name}`, true);
        break;
      }
      case 'times-open':
        openTimes(id);
        break;
      case 'stall-ok':
        stalled = null;
        render();
        break;
      case 'undo-replace':
      case 'undo-keep':
        e.preventDefault();
        commit(E.undoSeat(state, id, Date.now(), { replace: b.dataset.act === 'undo-replace' }), `${t ? t.no : ''}번 미투입 처리`);
        $('dlgUndo').close();
        break;
      case 'assign': {
        e.preventDefault();
        const at = E.tableOf(state, assignTableId);
        commit(E.assignDealer(state, assignTableId, id, Date.now()), `${at ? at.no : ''}번에 ${d ? d.name : ''} 지정`);
        $('dlgAssign').close();
        break;
      }
      case 'hold':
        if (d) commit(E.toggleHold(state, id, Date.now()), `${d.name} ${d.hold ? '보류 해제' : '투입 보류'}`);
        break;
      case 'home':
        if (d && confirm(`${d.name} 퇴근 처리할까요?`)) {
          commit(E.sendHome(state, id, Date.now()), `${d.name} 퇴근`);
          toast(`${d.name} 퇴근`, true);
        }
        break;
      case 'eo':
        commit(E.toggleEarlyOut(state, id, Date.now()));
        break;
      case 'eo-open':
        openEo(id);
        break;
      case 'eo-ask':
        e.preventDefault();
        commit(E.askEarlyOut(state, id, Date.now()));
        $('dlgEo').close();
        if (d) toast(`${d.name} 휴대폰에 '퇴근할게요 / 계속 일할게요' 버튼을 띄웠습니다`);
        break;
      case 'eo-mark':
        e.preventDefault();
        commit(E.toggleEarlyOut(state, id, Date.now()));
        $('dlgEo').close();
        break;
      case 'eo-unask':
        commit(E.cancelEoAsk(state, id, Date.now()));
        break;
      case 'eo-call':
        commit(E.openEoCall(state, Date.now()));
        toast('모든 딜러 휴대폰에 [퇴근 희망] 버튼을 띄웠습니다 — 다 받으면 마감을 누르세요');
        break;
      case 'eo-close':
        commit(E.closeEoCall(state, Date.now()));
        break;
      case 'revert':
        revertLast(b.dataset.at);
        break;
      case 'me-eo':
        sendMyEo(b.dataset.w === '1');
        break;
      case 'me-checkin':
        sendMyCheckIn();
        break;
      case 'back':
        if (d) commit(E.checkBack(state, id, Date.now()), `${d.name} 복귀`);
        break;
      case 'roster-del': {
        const who = b.dataset.name;
        if (who && confirm(`${who} 님을 명단에서 뺄까요? (오늘 출퇴근 기록은 그대로 남습니다)`)) {
          commit(E.removeRoster(state, who, Date.now()), `명단에서 ${who} 뺌`);
        }
        break;
      }
      case 'ev-team':
        openTeam(id);
        break;
      case 'team-on':
        teamOn(id);
        break;
      case 'team-off':
        teamOff(id);
        break;
      case 'team-keep': {
        const cur = EV.update(store, event.id, { share: null, guest: false, sharedRev: 0 });
        if (cur) event = cur;
        shareGone = false;
        shareRun = null;
        markChanged(event.id);
        toast('내 이벤트로 보관했습니다 — 이제 이 계정에만 저장됩니다');
        break;
      }
      case 'run-take':
        claimRun(Date.now()).then(() => toast('이 PC에서 교대를 돌립니다 (몇 초 뒤 반영됩니다)'));
        break;
      case 'dealer-open':
        openDealerMenu(id);
        break;
      case 'sched-open':
        openSched(Number(b.dataset.n) || 1, t ? t.id : null);
        break;
      case 'cmd-help':
        openCmd('');
        break;
      case 'cmd-run': {
        // 지금 state로 다시 알아듣고 차례로 실행. 교대 간격(설정)은 위쪽 칸처럼 되돌리기 기록 없이, 나머지는 한 번에 되돌릴 수 있게
        const now = Date.now();
        const res = CMD.parse(cmdText, state, now);
        const before = state;
        let x = state;
        for (const st of res.steps) if (st.kind === 'setting') x = st.run(x, now);
        if (x !== state) commit(x);
        let y = state;
        for (const st of res.steps) if (st.kind !== 'setting') y = st.run(y, now);
        if (y !== state) commit(y, `명령: ${cmdText.slice(0, 40)}`);
        if (state === before) {
          toast('바뀐 것이 없습니다 — 그 사이 상황이 달라졌을 수 있습니다');
          break;
        }
        $('formCmd').elements.cmd.value = '';
        toast(`실행 · ${res.steps.map(st => st.desc).join(' · ')}`, true);
        break;
      }
      case 'interval-cancel': {
        const ip = state.clock.intervalPlan;
        if (ip && confirm(`${hhmm(ip.at)}부터 교대 간격 ${ip.minutes}분 — 예약을 취소할까요?`)) {
          commit(E.cancelIntervalPlan(state, Date.now()), '간격 예약 취소');
        }
        break;
      }
      case 'tsched': {
        if (!t) break;
        const n = Number(($('schedN') || {}).value) || 1;
        const act = b.dataset.sched;
        const next = E.scheduleTable(state, t.id, n, act, Date.now());
        if (next === state) {
          toast('이 테이블에는 그 예약을 할 수 없습니다');
          break;
        }
        commit(next, `${t.no}번 ${SCHED_LABEL[act]} 예약`);
        const at = pushAtN(n);
        toast(`${t.no}번 테이블 — ${at ? hhmm(at) : `${n}번째`} 교대에 ${SCHED_LABEL[act]}${act === 'use' ? ' (그때 오래 쉰 딜러가 들어갑니다)' : ' (앉아 있던 딜러는 그때 휴식)'}`, true);
        break;
      }
      case 'tsched-cancel':
        if (t) commit(E.unscheduleTable(state, t.id, Date.now()), `${t.no}번 예약 취소`);
        break;
      case 'roster-open':
        openRosterMenu(b.dataset.name);
        break;
      case 'roster-in':
      case 'roster-plan': {
        const r = E.rosterView(state).find(x => x.name === b.dataset.name);
        if (!r) break;
        const v = b.dataset.act === 'roster-plan' && $('planAt') ? $('planAt').value : '';
        const at = v ? E.planTime(Date.now(), v) : null;
        if (b.dataset.act === 'roster-plan' && at == null) {
          toast('출근 예정 시각을 적으세요');
          break;
        }
        $('dlgTable').close();
        checkIn([{ name: r.name, grade: r.grade, at }]);
        break;
      }
      case 'arrive': // 출근 체크: 예정 시각 전이면 그 시각에 투입, 아니면 지금 출근
      case 'arrive-now':
        if (d && d.status === 'planned') {
          const now = Date.now();
          commit(b.dataset.act === 'arrive-now' ? E.arrive(state, [d.id], now) : E.checkInDealer(state, d.id, now, now), `${d.name} 출근`);
          const nd = E.dealerOf(state, d.id);
          toast(nd.status === 'planned' ? `${d.name} 출근 체크 — ${hhmm(nd.planAt)}부터 투입`
            : `${d.name} 출근 — ${nd.status === 'working' ? `${E.tableOf(state, nd.tableId).no}번 투입` : '다음 교대에 첫 번째로'}`, true);
        }
        break;
      case 'arrive-time': { // 이미 출근 처리된 딜러의 출근 시간을 뒤로 → 그 시각에 다시 출근
        if (!d) break;
        const now = Date.now();
        const v = $('arriveAt') ? $('arriveAt').value : '';
        const at = v ? E.planTime(now, v) : null;
        if (at == null || at <= now) {
          toast('지금보다 뒤 시각을 적으세요 — 이미 지난 출근 시각을 고치려면 출퇴근 탭의 \'시간 고치기\'');
          break;
        }
        $('dlgTable').close();
        const from = d.status === 'working' ? E.tableOf(state, d.tableId).no : 0;
        commit(E.delayArrival(state, d.id, at, now), `${d.name} 출근 시간 변경`);
        toast(`${d.name} ${hhmm(at)} 출근으로 변경 — 그 뒤 교대부터 투입${from ? ` (${from}번은 원래 딜러가 계속)` : ''}`, true);
        break;
      }
      case 'plan-save': {
        if (!d) break;
        const v = $('planAt') ? $('planAt').value : '';
        const at = v ? E.planTime(Date.now(), v) : null;
        $('dlgTable').close();
        commit(E.setPlanAt(state, d.id, at, Date.now()), `${d.name} 출근 예정 시각`);
        toast(at == null ? `${d.name} 예정 시각 지움 (출근 전)` : `${d.name} ${hhmm(at)} 출근 예정${at <= Date.now() && state.settings.autoArrive !== false ? ' — 시각이 지나 바로 출근' : ''}`);
        break;
      }
      case 'plan-remove':
        if (d && confirm(`${d.name} 출근 예정을 취소할까요?`)) commit(E.removePlanned(state, d.id, Date.now()), `${d.name} 출근 예정 취소`);
        break;
      case 'duty-open':
        openDuty(id);
        break;
      case 'duty-start': {
        if (!d) break;
        const task = (b.dataset.task || ($('dutyTask') ? $('dutyTask').value : '')).trim() || '다른 업무';
        const from = d.status === 'working' ? E.tableOf(state, d.tableId).no : 0;
        commit(E.startDuty(state, d.id, task, Date.now()), `${d.name} 다른 업무`);
        toast(`${d.name} — ${task}${from ? ` (${from}번은 다음 순서 딜러로)` : ''}`, true);
        break;
      }
      case 'duty-end':
        if (d) {
          commit(E.endDuty(state, d.id, Date.now()), `${d.name} 업무 끝`);
          toast(`${d.name} 업무 끝 — 휴식 (업무한 만큼 근무로 계산)`, true);
        }
        break;
      case 'button-draw':
        if (confirm(`오늘 버튼을 다시 뽑을까요? (지금 ${state.button ? `${state.button.no}번` : '없음'})\n딜러 휴대폰에도 새 번호가 보입니다.`)) {
          commit(E.drawButton(state, Date.now(), Math.random()));
          toast(`오늘 버튼 ${state.button.no}번`);
        }
        break;
      case 'delnotice':
        commit(E.removeNotice(state, id));
        break;
      case 'copy':
        copyText(b.dataset.text);
        break;
      case 'me-pick':
        saveMe({ id, name: b.dataset.name });
        myId = null;
        mine = null;
        myReply = null;
        if (remote) pollRemote(true, true); // 내 것 받기
        render();
        window.scrollTo(0, 0);
        break;
      case 'me-change':
        saveMe(null);
        myId = null;
        mine = null;
        myReply = null;
        if (remote) pollRemote(true); // 이름 목록
        render();
        break;
      case 'sync-room':
        openRoom();
        break;
      case 'sync-off':
        if (confirm(`'${event.name}' 이벤트의 실시간 공유를 끊을까요? 이 이벤트 딜러 휴대폰에는 더 이상 갱신되지 않습니다.\n다시 공유하면 새 링크(QR)가 만들어집니다. (다른 이벤트는 그대로)`)) disconnectSync();
        break;
      case 'backup-save':
        saveBackup();
        break;
      case 'ev-rename': {
        const ev = EV.find(eventList(), id);
        const name = ev ? prompt('이벤트 이름', ev.name) : null;
        if (name && name.trim()) {
          EV.update(store, id, { name: name.trim() });
          markChanged(id);
          render();
        }
        break;
      }
      case 'ev-del':
        deleteEvent(id);
        break;
      case 'list-retry':
        syncList();
        break;
      case 'logout':
        logout();
        break;
      case 'relogin':
        saveJson(AUTH_KEY, null); // 이 PC의 이벤트는 남겨 둔다 (다시 로그인하면 계정과 맞춤)
        location.href = homeUrl();
        break;
      case 'gate-check':
        checkLicense().then(l => { if (l.state === 'ok') location.reload(); }).catch(e => toast(S.explainError(e.message)));
        break;
      case 'pw-open':
        $('formPw').reset();
        $('pwMsg').textContent = '';
        $('dlgPw').showModal();
        break;
      case 'forgot':
        forgotPassword();
        break;
      case 'acc-gen':
        $('formAccount').elements.password.value = AC.makePassword(10);
        break;
      case 'acc-ext':
      case 'acc-date':
      case 'acc-off':
      case 'acc-edit':
      case 'acc-reset':
        accountAction(b.dataset.act, b.dataset.uid, b.dataset.m);
        break;
      case 'acc-reload':
        loadAccounts();
        break;
    }
  });

  // 삭제는 계정(클라우드)에서도 지워야 하므로 인터넷이 필요하다
  async function deleteEvent(id) {
    const ev = EV.find(eventList(), id);
    if (!ev || !confirm(`'${ev.name}' 이벤트를 삭제할까요?\n테이블·딜러·출퇴근·기록·공지가 모두 지워지고 되돌릴 수 없습니다 (다른 PC에서도).${ev.room
      ? '\n이 이벤트의 딜러 휴대폰 링크(QR)도 더 이상 동작하지 않습니다.' : ''}`)) return;
    return removeEvent(id);
  }
  async function removeEvent(id) {
    const ev = EV.find(eventList(), id);
    if (!ev) return false;
    try {
      if (!(await sessionOk())) return;
      await S.patch(FB.databaseURL, `users/${auth.uid}`, { [`events/${id}`]: null, [`states/${id}`]: null }, await syncIdToken());
    } catch (e) {
      toast(`삭제하지 못했습니다 — ${S.explainError(e.message)}`);
      return false;
    }
    if (ev.share) { // 같이 쓰던 이벤트: 주인이 지우면 같이 쓰기도 끄고, 들어온 계정이 지우면 나가기만
      const t = await syncIdToken().catch(() => null);
      if (t && ev.guest) await S.put(FB.databaseURL, `shared/${ev.share}/members/${auth.uid}`, null, t).catch(() => {});
      else if (t) {
        await S.put(FB.databaseURL, `shared/${ev.share}`, null, t).catch(() => {});
        if (ev.room) await S.put(FB.databaseURL, `roomShare/${ev.room}`, null, t).catch(() => {});
      }
    }
    if (ev.room && !ev.guest) clearRoom(ev.room); // 들어온 계정은 주인의 방을 비우지 않는다
    EV.remove(store, id);
    render();
    toast(`'${ev.name}' 삭제됨`);
    return true;
  }

  document.addEventListener('keydown', e => {
    const tile = (e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('[data-table]');
    if (!tile || e.target.closest('button, input')) return;
    e.preventDefault();
    openTableMenu(tile.dataset.table);
  });

  // ---------- 이벤트 목록 화면 ----------

  function renderEvents() {
    renderAccountBar();
    const l = eventList();
    const items = l.map(ev => {
      let s = null;
      try { s = EV.loadState(store, ev.id); } catch (e) { /* 못 읽으면 계정에 올라간 요약으로 */ }
      const sum = s ? EV.summary(s) : ev.sum || EV.summary(null);
      const made = new Date(ev.createdAt);
      const unsaved = AC.dirty(ev) ? ' · <span class="warn-text">계정에 아직 저장 안 됨</span>' : '';
      return `<li class="${sum.status === '진행 중' ? 'live' : ''}">
        <a class="ev-open" href="${esc(eventUrl(ev.id))}">
          <b>${esc(ev.name)}</b>
          <span class="meta">${made.getMonth() + 1}/${made.getDate()} ${hhmm(ev.createdAt)} 만듦 · 테이블 ${sum.tables} · 딜러 ${sum.dealers}${ev.room ? ' · 딜러 QR 있음' : ''}${unsaved}</span>
          <span class="tag ${sum.status === '진행 중' ? 'in' : sum.status === '일시정지' ? 'warn' : ''}">${sum.status}</span>
        </a>
        <div class="row-actions">
          <a class="btn primary" href="${esc(eventUrl(ev.id))}">열기</a>
          <button data-act="ev-team" data-id="${esc(ev.id)}"${ev.share ? ' class="sync-live"' : ''}>${ev.share ? (ev.guest ? '같이 쓰는 중' : esc(S.codeText(ev.share))) : '같이 쓰기'}</button>
          <button data-act="ev-rename" data-id="${esc(ev.id)}">이름 바꾸기</button>
          <button data-act="ev-del" data-id="${esc(ev.id)}" class="danger">삭제</button>
        </div>
      </li>`;
    }).join('');
    const empty = listSync === 'loading' || listSync === 'idle' ? '<li class="empty">계정에서 이벤트를 불러오는 중…</li>'
      : '<li class="empty">아직 이벤트가 없습니다. 위에서 새 이벤트를 만드세요.</li>';
    setHTML($('eventList'), items || empty);
    setHTML($('eventsNote'), listSync === 'error'
      ? `<p class="conn bad">계정에서 이벤트 목록을 받지 못했습니다 (${esc(cloudError)}) — 이 PC에 있는 것만 보입니다
          <button type="button" class="mini" data-act="list-retry">다시 시도</button></p>`
      : '<p class="conn ok">이벤트는 계정에 저장되어 다른 PC에서 로그인해도 그대로입니다. 이벤트를 열면 그 이벤트용 딜러 링크·QR이 자동으로 만들어집니다.</p>');
  }

  // 로그인한 계정 · 이용 기간 · 비밀번호 바꾸기 · 로그아웃 (목록과 관리자 화면 위쪽)
  function renderAccountBar() {
    const l = AC.license({ until: auth.until }, Date.now());
    const left = l.state === 'ok' ? `${AC.dateStr(l.until)}까지 (${l.daysLeft}일 남음)` : '이용 기간 확인 필요';
    setHTML($('accountBar'), `<div class="account-bar">
      <span><b>${esc(auth.name || '')}</b> <span class="muted">${esc(auth.email || '')}</span></span>
      <span class="${l.state === 'ok' && l.daysLeft > 7 ? 'muted' : 'warn-text'}">이용 기간 ${esc(left)}</span>
      <span class="row-actions">
        ${auth.admin ? (isAdminView ? `<a class="btn" href="${esc(homeUrl())}">이벤트 목록</a>` : `<a class="btn" href="${esc(homeUrl())}?admin">관리자 화면</a>`) : ''}
        <button type="button" data-act="pw-open">비밀번호 바꾸기</button>
        <button type="button" data-act="logout">로그아웃</button>
      </span></div>`);
  }

  $('formEvent').addEventListener('submit', e => {
    e.preventDefault();
    let ev;
    try {
      // 새 이벤트는 가장 최근 이벤트의 출근자 명단을 물려받는다 (대회마다 다시 적지 않게)
      const fresh = E.createState();
      const prev = EV.list(store)[0];
      const prevState = prev ? EV.loadState(store, prev.id) : null;
      if (prevState) fresh.roster = E.rosterEntries(prevState.roster);
      ev = EV.create(store, e.target.elements.name.value, Date.now(), fresh);
    } catch (err) {
      toast('이벤트를 만들지 못했습니다 — 이 브라우저에 저장할 수 없습니다 (시크릿 창 등)');
      return;
    }
    location.href = eventUrl(ev.id); // 계정에는 이벤트 화면이 열리면서 올린다
  });

  // ---------- 딜러 현황 (테이블 오른쪽) ----------
  // 출근 예정(시각 순) → 출근(테이블 · 다른 업무 · 휴식) → 명단에서 아직 안 온 사람.
  // 누르면 딜러 메뉴, 출근 예정·명단은 [출근] 바로. 출퇴근 탭의 '출근자 명단'(state.roster)과 같은 사람들이다

  function renderDealerBoard(now) {
    const plan = state.dealers.filter(d => d.status === 'planned')
      .sort((a, b) => (a.planAt == null) - (b.planAt == null) || (a.planAt || 0) - (b.planAt || 0) || a.name.localeCompare(b.name, 'ko'));
    const rank = d => (d.status === 'working' ? 0 : d.status === 'duty' ? 1 : 2);
    const order = poolInOrder(now).map(d => d.id);
    const tno = d => (d.status === 'working' ? E.tableOf(state, d.tableId).no : 0);
    const on = state.dealers.filter(d => d.status === 'working' || d.status === 'duty' || d.status === 'break')
      .sort((a, b) => rank(a) - rank(b) || tno(a) - tno(b) || order.indexOf(a.id) - order.indexOf(b.id));
    const chip = (d, cls, sub, extra) => `<div class="rbtn ${cls}"><button type="button" data-act="dealer-open" data-id="${d.id}"
      title="${esc(d.name)} — 눌러서 출근·출근 시간·다른 업무·퇴근"><b>${esc(d.name)}</b><small>${sub}</small></button>${extra || ''}</div>`;
    const planHtml = plan.map(d => {
      const checked = d.checkAt != null;
      const due = d.planAt != null && d.planAt <= now && !checked;
      const sub = d.planAt == null ? '출근 전' : `${hhmm(d.planAt)}${checked ? ' ✓체크' : due ? ' 체크 안 함' : ''}`;
      return chip(d, `plan${due ? ' due' : ''}${checked ? ' checked' : ''}`, sub, checked ? ''
        : `<button type="button" class="mini" data-act="arrive" data-id="${d.id}" title="${d.planAt != null && d.planAt > now
          ? `출근 체크 — ${hhmm(d.planAt)}부터 투입` : '지금 출근'}">출근</button>`);
    }).join('');
    const onHtml = on.map(d => (d.status === 'working' ? chip(d, 'work', `${tno(d)}번`)
      : d.status === 'duty' ? chip(d, 'duty', esc(d.task || '업무'))
        : chip(d, `rest${d.hold ? ' held' : ''}`, d.hold ? '보류' : `휴식 ${minutes(E.restedMs(d, now))}분`))).join('');
    const wait = E.rosterView(state).filter(r => r.state === 'none' || r.state === 'off');
    const waitHtml = wait.map(r => (r.state === 'off'
      ? chip(E.dealerOf(state, r.id), 'wait', '퇴근함', `<button type="button" class="mini" data-act="back" data-id="${r.id}" title="다시 출근">복귀</button>`)
      : `<div class="rbtn wait"><button type="button" data-act="roster-open" data-name="${esc(r.name)}"
          title="${esc(r.name)} — 눌러서 출근·출근 예정 시각"><b>${esc(r.name)}</b><small>아직</small></button><button type="button" class="mini" data-act="roster-in" data-name="${esc(r.name)}" title="지금 출근">출근</button></div>`)).join('');
    setHTML($('dealerBoard'), `<div class="dboard-head"><b>딜러 현황</b></div>
      <p class="dboard-note">딜러가 휴대폰(딜러 QR)에서 <b>출근 체크</b>해야 투입 · 일찍 체크해도 예정 시각에</p>
      <label class="chk dboard-auto" title="켜면 출근 체크가 없어도 예정 시각에 출근 처리합니다 (안 온 딜러는 눌러서 출근 시간 변경)"><input type="checkbox" data-auto-arrive${state.settings.autoArrive ? ' checked' : ''}> 체크 없이 출근</label>
      <h3>출근 예정 ${plan.length}</h3>
      <div class="rlist">${planHtml || '<p class="empty">출근 칸에 이름 + 예정 시각</p>'}</div>
      <h3>출근 ${on.length}</h3>
      <div class="rlist">${onHtml || '<p class="empty">없음</p>'}</div>
      ${wait.length ? `<h3>명단 · 아직 ${wait.length}</h3><div class="rlist">${waitHtml}</div>` : ''}`);
  }

  // 명단에만 있고 아직 안 온 사람: 지금 출근 / 출근 예정 시각
  function openRosterMenu(name) {
    const r = E.rosterView(state).find(x => x.name === name);
    if (!r) return;
    $('tableTitle').innerHTML = `${esc(r.name)} <span class="grade">${esc(r.grade)}</span> <span class="muted">명단 · 아직 안 옴</span>`;
    $('tableBody').innerHTML = `<div class="menu">
      <button type="button" class="primary" data-act="roster-in" data-name="${esc(r.name)}"><b>출근</b><small>지금 출근 — 공석이 있으면 바로, 없으면 다음 교대에 첫 번째로</small></button>
      <div class="plan-edit"><label>출근 예정 시간 <input type="time" id="planAt"></label>
        <button type="button" data-act="roster-plan" data-name="${esc(r.name)}">저장</button><small class="muted">그 시각에 출근 · 그 뒤 가장 가까운 교대부터</small></div>
    </div>`;
    $('dlgTable').showModal();
  }

  // 딜러 메뉴 (명단을 눌렀을 때): 출근 예정 → 출근·출근 시간·취소 / 출근 → 출근 시간 변경·다른 업무·보류·퇴근 희망·퇴근 / 퇴근 → 복귀·출근 예정
  function openDealerMenu(dealerId) {
    const d = E.dealerOf(state, dealerId);
    if (!d) return;
    const item = (act, title, desc, cls) => `<button type="button" data-act="${act}" data-id="${d.id}"${cls ? ` class="${cls}"` : ''}>
      <b>${title}</b><small>${desc}</small></button>`;
    const planEdit = `<div class="plan-edit"><label>출근 시간 <input type="time" id="planAt" value="${d.planAt == null ? '' : hhmm(d.planAt)}"></label>
      <button type="button" data-act="plan-save" data-id="${d.id}">저장</button><small class="muted">출근 체크하면 그 시각부터 투입 · 비우면 시각 없이 '출근 전'</small></div>`;
    let where;
    const items = [];
    if (d.status === 'planned') {
      const early = d.planAt != null && d.planAt > Date.now();
      where = d.planAt == null ? '출근 전' : `${hhmm(d.planAt)} 출근 예정${d.checkAt != null ? ` · ${hhmm(d.checkAt)} 출근 체크함` : ''}`;
      if (early && d.checkAt == null) items.push(item('arrive', '출근 체크', `왔으면 — ${hhmm(d.planAt)}부터 투입 (휴대폰 출근 체크와 같음)`, 'primary'));
      if (early) items.push(item('arrive-now', '지금 바로 투입', '예정 시각 전이라도 지금 출근 — 공석이 있으면 바로, 없으면 다음 교대에 첫 번째로'));
      else items.push(item('arrive', '출근', '지금 출근 — 공석이 있으면 바로, 없으면 다음 교대에 첫 번째로', 'primary'));
      items.push(planEdit, item('plan-remove', '출근 예정 취소', d.sessions.length ? '오늘 출근 기록은 남기고 퇴근 상태로' : '출근 예정만 지움 (출근자 명단에는 남음)', 'danger'));
    } else if (d.status === 'off') {
      where = '퇴근';
      items.push(item('back', '복귀', '지금 다시 출근'), planEdit);
    } else {
      where = d.status === 'working' ? `${E.tableOf(state, d.tableId).no}번 근무 중` : d.status === 'duty' ? `다른 업무 · ${d.task}` : '휴식 중';
      if (E.canDelay(state, d.id, Date.now())) {
        const last = d.sessions[d.sessions.length - 1];
        items.push(`<div class="plan-edit warn-box"><label>출근 시간 변경 <input type="time" id="arriveAt" value="${hhmm(last.in)}"></label>
          <button type="button" class="warn" data-act="arrive-time" data-id="${d.id}">변경</button>
          <small class="muted">늦게 오면 — 바꾼 시각에 출근하고 로테이션도 그 뒤 교대부터${d.status === 'working' ? ` (${E.tableOf(state, d.tableId).no}번은 원래 딜러가 계속)` : ''}</small></div>`);
      }
      if (d.status === 'duty') {
        items.push(item('duty-end', '업무 끝', '휴식으로 — 업무한 시간은 근무로 계산 (그만큼 더 쉼)', 'primary'),
          item('duty-open', '업무 내용 바꾸기', esc(d.task)));
      } else {
        items.push(item('duty-open', '다른 업무', `${d.status === 'working' ? '테이블에서 빼고 ' : ''}칩 정리·등록 등 — 로테에 들어간 것처럼 근무로 계산`));
      }
      if (d.status === 'break') items.push(item('hold', d.hold ? '보류 해제' : '투입 보류', d.hold ? '다시 자동으로 투입' : '자동으로 투입하지 않음 (식사·개인 사정)'));
      items.push(item('eo-open', '퇴근 희망', '표시하거나 휴대폰으로 묻기'), item('home', '퇴근', '퇴근 처리', 'danger'));
    }
    $('tableTitle').innerHTML = `${esc(d.name)} <span class="grade">${esc(d.grade)}</span> <span class="muted">${esc(where)}</span>`;
    $('tableBody').innerHTML = `<div class="menu">${items.join('')}</div>`;
    $('dlgTable').showModal();
  }

  // 다른 업무 창: 내용을 적거나 자주 쓰는 것을 고른다
  const DUTY_PICKS = ['칩 정리', '등록·바이인', '플로어', '테이블 세팅', '카드 교체'];
  function openDuty(dealerId) {
    const d = E.dealerOf(state, dealerId);
    if (!d) return;
    const picks = [...new Set(state.dealers.filter(x => x.status === 'duty').map(x => x.task).concat(DUTY_PICKS))];
    $('tableTitle').innerHTML = `${esc(d.name)} 다른 업무`;
    $('tableBody').innerHTML = `<p class="hint">테이블에는 안 들어가지만 로테에 들어간 것처럼 근무로 계산합니다${d.status === 'working'
      ? ` (${E.tableOf(state, d.tableId).no}번은 다음 순서 딜러로)` : ''}. 끝나면 명단에서 눌러 [업무 끝] — 일한 만큼 더 쉽니다.</p>
      <div class="duty-edit"><input id="dutyTask" maxlength="30" placeholder="업무 내용 (예: 칩 정리)" value="${esc(d.task || '')}" autocomplete="off">
        <button type="button" class="primary" data-act="duty-start" data-id="${d.id}">시작</button></div>
      <div class="picks">${picks.map(p => `<button type="button" data-act="duty-start" data-id="${d.id}" data-task="${esc(p)}">${esc(p)}</button>`).join('')}</div>`;
    $('dlgTable').showModal();
    setTimeout(() => { const i = $('dutyTask'); if (i) i.focus(); }, 0);
  }

  // 창 안의 입력칸에서 Enter = 옆의 저장/시작 버튼 (그냥 두면 창이 닫히기만 한다)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.matches || !e.target.matches('#dutyTask, #planAt, #arriveAt')) return;
    e.preventDefault();
    const b = e.target.closest('.duty-edit, .plan-edit').querySelector('button[data-act]');
    if (b) b.click();
  });

  // ---------- 테이블 메뉴 (테이블 칸을 눌렀을 때) ----------

  function openTableMenu(tableId) {
    const t = E.tableOf(state, tableId);
    if (!t || t.status !== 'open') return;
    const d = t.dealerId ? E.dealerOf(state, t.dealerId) : null;
    const item = (act, title, desc, cls) => `<button type="button" data-act="${act}" data-id="${t.id}"${cls ? ` class="${cls}"` : ''}>
      <b>${title}</b><small>${desc}</small></button>`;
    if (t.use === false) {
      $('tableTitle').innerHTML = `${tchip(t.no)} 대기 <span class="muted">열려 있지만 딜러 없음</span>`;
      $('tableBody').innerHTML = `<div class="menu">
        ${item('use', '지금 사용', '다음 순서 딜러를 바로 넣기', 'primary')}
        ${item('sched-open', '교대 때 사용 시작', '고른 교대에 — 그 교대 계획 안에서 오래 쉰 딜러가 들어감 (로테가 꼬이지 않게)')}
        ${item('assign-open', '딜러 지정', '넣을 딜러를 직접 고르기 (사용으로 바뀜)')}
        ${item('lock', t.locked ? '고정 해제' : '고정', t.locked ? '다시 자동 교대에 넣기' : '자동 교대에서 빼기 (파이널 테이블 등)')}
        ${item('close', '깨기', '테이블을 닫기', 'danger')}
      </div>`;
      $('dlgTable').showModal();
      return;
    }
    if (!d) {
      openAssign(tableId); // 공석이면 바로 딜러 넣기
      return;
    }
    const now = Date.now();
    const plan = nextPlan();
    const m = plan && plan.moves.find(x => x.tableId === t.id && x.toDealerId);
    $('tableTitle').innerHTML = `${tchip(t.no)} ${esc(d.name)} <span class="grade">${esc(d.grade)}</span>`;
    $('tableBody').innerHTML = `
      <p class="meta">연속 ${minutes(E.workedMs(state, d, now))}분 근무${m
        ? ` · 다음 교대(${hhmm(plan.at)})에 <b>${esc(nameOf(m.toDealerId))}</b>와 교대` : ''}</p>
      <div class="menu">
        ${item('assign-open', '딜러 지정', '이 테이블에 넣을 딜러를 직접 고르기 (근무 중인 딜러면 자리 교환)')}
        ${item('relieve', '지금 교체', `다음 순서 딜러를 바로 넣고 ${esc(d.name)}은(는) 휴식`)}
        ${item('undo-open', '바로잡기', '앉아 있는 사람이 화면과 다를 때 — 교대 안 함 · 다른 사람 · 자리 바뀜', E.undoInfo(state, t.id, now) ? 'warn' : '')}
        ${item('lock', t.locked ? '고정 해제' : '고정', t.locked ? '다시 자동 교대에 넣기' : '자동 교대에서 빼기 (파이널 테이블 등)')}
        <button type="button" data-act="duty-open" data-id="${d.id}"><b>다른 업무</b><small>${esc(d.name)}은(는) 테이블에서 빠져 다른 업무 — 로테에 들어간 것처럼 근무로 계산</small></button>
        ${E.canDelay(state, d.id, Date.now()) ? `<button type="button" class="warn" data-act="dealer-open" data-id="${d.id}"><b>출근 시간 변경</b><small>${esc(d.name)}이(가) 늦게 옴 — 바꾼 시각에 출근, 로테이션도 그에 맞춰</small></button>` : ''}
        ${item('sched-open', '교대 때 대기·깨기', `고른 교대에 — ${esc(d.name)}은(는) 그때 휴식`)}
        ${item('unuse', '사용 안 함', `${esc(d.name)}은(는) 휴식, 테이블은 열린 채 대기 (다시 체크하면 투입)`)}
        ${item('close', '깨기', `테이블을 닫고 ${esc(d.name)}은(는) 휴식`, 'danger')}
      </div>`;
    $('dlgTable').showModal();
  }

  // ---------- 명령 입력칸 ----------
  // 정해진 말투를 알아듣고(js/command.js) 먼저 '이렇게 할까요?'로 보여 준 뒤 [실행]을 눌러야 바뀐다 (되돌리기 한 번에 그 전으로)
  const CMD = window.DealerCommand;
  let cmdText = '';
  function openCmd(text) {
    const r = CMD.parse(text, state, Date.now());
    cmdText = text;
    const li = (cls, x) => `<li class="${cls}">${esc(x)}</li>`;
    const examples = `<p class="hint">이렇게 말하면 됩니다 (여러 개는 쉼표로): ${r.examples.map(x => `<code>${esc(x)}</code>`).join(' ')}</p>`;
    $('tableTitle').textContent = !text ? '명령 예시' : r.steps.length ? '이렇게 할까요?' : '알아듣지 못했습니다';
    $('tableBody').innerHTML = `${text ? `<p class="muted cmd-said">“${esc(text)}”</p>` : ''}
      ${r.steps.length ? `<ul class="cmd-list ok">${r.steps.map(x => li('ok', x.desc)).join('')}</ul>` : ''}
      ${r.notes.length ? `<ul class="cmd-list note">${r.notes.map(x => li('note', x)).join('')}</ul>` : ''}
      ${r.problems.length ? `<ul class="cmd-list bad">${r.problems.map(x => li('bad', x)).join('')}</ul>` : ''}
      ${!text || r.problems.length || !r.steps.length ? examples : ''}
      ${r.steps.length ? '<div class="dialog-actions"><button type="button" class="primary" data-act="cmd-run">실행</button></div>' : ''}`;
    $('dlgTable').showModal();
  }
  $('formCmd').addEventListener('submit', e => {
    e.preventDefault();
    const text = e.target.elements.cmd.value.trim();
    if (text) openCmd(text);
  });

  // ---------- 교대 때 테이블 바꾸기 (예약) ----------
  // 표의 예정 시각 머리·테이블별 표의 예정 칸·테이블 칸 메뉴에서. 1시에 열 테이블을 지금 [사용]하면 그 순간 쉬던 딜러가 들어가
  // 로테가 꼬인다 → 1시 교대에 같이 바꾼다 (2026-10-24 사용자 요청). tableId가 있으면 그 테이블만
  function openSched(n, tableId) {
    if (!state.clock.running) {
      toast('로테이션을 시작하면 교대 때 테이블을 바꿀 수 있습니다 — 지금은 [사용] 체크로 바로');
      return;
    }
    const slots = projection();
    if (!slots.length) return;
    n = Math.min(Math.max(1, n || 1), slots.length);
    const tables = (tableId ? [E.tableOf(state, tableId)] : E.activeTables(state)).filter(t => t && t.status === 'open');
    const opts = slots.map((p, i) => `<option value="${i + 1}"${i + 1 === n ? ' selected' : ''}>${hhmm(p.at)} 교대${i === 0 ? ' (다음)' : ''}</option>`).join('');
    const btn = (t, act, cls) => `<button type="button" class="mini${cls ? ` ${cls}` : ''}" data-act="tsched" data-id="${t.id}" data-sched="${act}">${SCHED_LABEL[act]}</button>`;
    const rows = tables.map(t => {
      const now = t.use === false ? '대기' : t.dealerId ? esc(nameOf(t.dealerId)) : '공석';
      const acts = t.use === false ? btn(t, 'use', 'primary') + btn(t, 'close', 'danger') : btn(t, 'idle') + btn(t, 'close', 'danger');
      const has = t.sched ? `<span class="tag info">예약 · ${esc(schedText(t))}</span><button type="button" class="mini" data-act="tsched-cancel" data-id="${t.id}">예약 취소</button>` : '';
      return `<div class="sched-row">${tchip(t.no)}<span class="muted">${now}</span>${has}<span class="acts">${acts}</span></div>`;
    }).join('');
    $('tableTitle').innerHTML = tableId && tables[0] ? `${tchip(tables[0].no)} 교대 때 바꾸기` : '교대 때 테이블 바꾸기';
    $('tableBody').innerHTML = `<p class="hint">지금 바로가 아니라 고른 교대에 바뀝니다. <b>사용 시작</b>이면 그 교대에 오래 쉰 딜러가 들어가고,
      <b>대기로·깨기</b>면 앉아 있던 딜러가 그 교대에 쉽니다. 로테이션 표에 미리 보입니다.</p>
      <label class="sched-when">언제 <select id="schedN">${opts}</select></label>
      <div class="sched-list">${rows || '<p class="empty">열린 테이블이 없습니다</p>'}</div>`;
    $('dlgTable').showModal();
  }

  // ---------- 딜러 지정 창 ----------

  function openAssign(tableId) {
    const t = E.tableOf(state, tableId);
    if (!t) return;
    assignTableId = tableId;
    const now = Date.now();
    const cur = t.dealerId ? E.dealerOf(state, t.dealerId) : null;
    $('assignTitle').textContent = `${t.no}번 테이블에 딜러 지정${cur ? ` (지금: ${cur.name})` : ''}`;
    const btn = (d, sub) => `<button type="button" class="pick" data-act="assign" data-id="${d.id}">
      <b>${esc(d.name)}</b> <span class="grade">${esc(d.grade)}</span><small>${sub}</small></button>`;
    const pool = poolInOrder(now).map(d => btn(d,
      `휴식 ${minutes(E.restedMs(d, now))}분${E.isRested(state, d, now) ? '' : ' · 덜 쉼'}${d.hold ? ' · 보류' : ''}`));
    const workers = E.working(state).filter(d => d.tableId !== t.id)
      .sort((a, b) => E.tableOf(state, a.tableId).no - E.tableOf(state, b.tableId).no)
      .map(d => btn(d, `${E.tableOf(state, d.tableId).no}번 근무 중 → 자리 교환`));
    const onTask = state.dealers.filter(d => d.status === 'duty').map(d => btn(d, `업무 · ${esc(d.task)} → 끝내고 투입`));
    $('assignBody').innerHTML = `
      <h3>휴식 중 <small class="muted">넣으면 ${cur ? esc(cur.name) + '은(는) 휴식' : '바로 투입'}</small></h3>
      <div class="picks">${pool.join('') || '<p class="empty">없음</p>'}</div>
      ${onTask.length ? `<h3>다른 업무 중</h3><div class="picks">${onTask.join('')}</div>` : ''}
      <h3>근무 중</h3>
      <div class="picks">${workers.join('') || '<p class="empty">없음</p>'}</div>`;
    $('dlgAssign').showModal();
  }

  // ---------- 퇴근 희망 창 (한 딜러) ----------

  function openEo(dealerId) {
    const d = E.dealerOf(state, dealerId);
    if (!d) return;
    const canAsk = isPublisher();
    $('eoTitle').textContent = `${d.name} 퇴근 희망`;
    $('eoBody').innerHTML = `
      <p><b>휴대폰으로 묻기</b> — ${esc(d.name)} 휴대폰에만 <b>[퇴근할게요] / [계속 일할게요]</b> 버튼이 뜨고, 답이 오면 여기에 표시됩니다.</p>
      <p><b>바로 표시</b> — ${esc(d.name)}에게 직접 들었을 때.</p>
      ${canAsk ? '' : '<p class="hint">휴대폰으로 물으려면 먼저 딜러용 링크(실시간 공유)를 연결하세요.</p>'}`;
    $('eoActions').innerHTML = `<button value="cancel">취소</button>
      <button type="button" data-act="eo-mark" data-id="${d.id}">바로 표시</button>
      <button type="button" class="primary" data-act="eo-ask" data-id="${d.id}"${canAsk ? '' : ' disabled'}>휴대폰으로 묻기</button>`;
    $('dlgEo').showModal();
  }

  // ---------- 바로잡기 창 ----------
  // 테이블에 실제로 앉아 있는 사람이 화면과 다를 때 (언제든): 교대를 안 했거나(미투입), 다른 사람이 앉았거나, 자리가 바뀌었거나

  function openFix(tableId) {
    const now = Date.now();
    const t = E.tableOf(state, tableId);
    const p = t && t.dealerId ? E.dealerOf(state, t.dealerId) : null;
    if (!p) return;
    const info = E.undoInfo(state, tableId, now);
    const y = info && info.out; // 교대 전에 이 자리에 있던 딜러 (아직 쉬는 중)
    const parts = [`<p>화면에는 <b>${esc(p.name)}</b>이(가) ${hhmm(p.since)}부터 앉아 있습니다. 실제와 다르면 아래에서 고르세요.
      잘못 골라도 위쪽 '되돌리기'로 취소할 수 있습니다.</p>`];

    if (info) {
      const mins = minutes(E.clockNow(state, now) - p.since);
      const sub = poolInOrder(now).find(x => !x.hold && (!y || x.id !== y.id) && E.isRested(state, x, now));
      const lines = [`<p><b>${esc(p.name)}</b>은(는) 계속 쉰 것으로 되돌리고 <b>투입 보류</b>합니다 (보류를 풀기 전까지 자동으로 안 들어감).</p>`];
      let actions;
      if (y) {
        lines.push(`<p><b>${esc(y.name)}</b>은(는) 그동안 ${mins}분 더 일한 것으로 기록되어, 나중에 그만큼 더 쉬게 됩니다.</p>`);
        actions = [
          sub ? `<button type="button" class="primary" data-act="undo-replace" data-id="${t.id}">${esc(sub.name)} 바로 투입, ${esc(y.name)} 휴식</button>` : '',
          `<button type="button"${sub ? '' : ' class="primary"'} data-act="undo-keep" data-id="${t.id}">${esc(y.name)} 계속 (다음 교대 때 우선 휴식)</button>`,
        ];
      } else {
        lines.push('<p class="muted">원래 이 자리에 있던 딜러는 이미 다른 데 있어서, 다음 순서 딜러가 들어갑니다.</p>');
        actions = [`<button type="button" data-act="undo-keep" data-id="${t.id}">미투입 처리</button>`];
      }
      parts.push(`<h3>교대를 안 했어요${y ? ` — ${esc(y.name)}이(가) 계속 앉아 있음` : ''}</h3>${lines.join('')}
        <div class="row-actions">${actions.join('')}</div>`);
    }

    const resting = poolInOrder(now).filter(x => !(y && x.id === y.id));
    parts.push(`<h3>다른 사람이 앉아 있어요</h3>
      <p class="hint">고른 딜러가 ${esc(p.name)} 대신 앉아 있던 것으로, 그 시간만큼 두 사람의 근무·휴식을 서로 바꿔 고칩니다.</p>
      <div class="picks">${resting.map(x => `<button type="button" data-act="fix" data-id="${t.id}" data-who="${x.id}">${esc(x.name)}${x.since > p.since
        ? ` <small>${hhmm(x.since)}부터</small>` : ''}</button>`).join('') || '<p class="empty">쉬는 딜러 없음</p>'}</div>`);

    const workers = E.working(state).filter(x => x.id !== p.id)
      .sort((a, b) => E.tableOf(state, a.tableId).no - E.tableOf(state, b.tableId).no);
    parts.push(`<h3>다른 테이블 딜러와 자리가 바뀌었어요</h3>
      <p class="hint">두 사람의 테이블만 맞바꿉니다 (둘 다 계속 일했으므로 근무시간은 그대로).</p>
      <div class="picks">${workers.map(x => `<button type="button" data-act="fix" data-id="${t.id}" data-who="${x.id}">${esc(x.name)} <small>${E.tableOf(state, x.tableId).no}번</small></button>`).join('')
        || '<p class="empty">없음</p>'}</div>`);

    $('undoTitle').textContent = `${t.no}번 바로잡기`;
    $('undoBody').innerHTML = parts.join('');
    $('undoActions').innerHTML = '<button value="cancel">닫기</button>';
    $('dlgUndo').showModal();
  }

  // ---------- 폼 ----------

  // 테이블 오픈: '빼고' 칸의 번호(쓰지 않는 테이블)는 이 이벤트에 기억해 두고 다음에 열 때도 뺀다
  const skipText = () => state.settings.skipTables || '';
  $('formTables').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    const want = E.parseNos(f.nos.value);
    const skip = E.parseNos(f.skip.value);
    if (!want.length) {
      toast('테이블 번호를 확인하세요 (예: 1-100)');
      return;
    }
    const nos = want.filter(no => !skip.includes(no));
    const skipped = want.filter(no => skip.includes(no));
    if (!nos.length) {
      toast(`${E.rangeText(skipped)}번은 '빼고' 칸에 들어 있습니다 — 열려면 '빼고' 칸에서 지우세요`);
      return;
    }
    const keep = skip.length ? E.rangeText(skip) : '';
    const use = f.use.checked;
    const opened = nos.filter(no => !E.activeTables(state).some(t => t.no === no));
    const started = use ? nos.filter(no => E.idleTables(state).some(t => t.no === no)) : [];
    let next = E.openTable(state, nos, Date.now(), { feature: f.feature.checked, use });
    if (keep !== skipText()) next = E.updateSettings(next, { skipTables: keep });
    if (use !== !!state.settings.openUse) next = E.updateSettings(next, { openUse: use });
    commit(next, `${E.rangeText(nos)}번 테이블 오픈${use ? '' : ' (대기)'}`);
    e.target.reset();
    f.skip.value = keep;
    f.use.checked = use;
    const msg = [
      opened.length && `${opened.length}개 테이블 오픈${use ? '' : ' — 대기 (칸에서 [사용]을 체크하면 딜러 투입)'}`,
      started.length && `${E.rangeText(started)}번 사용 — 딜러 투입`,
      skipped.length && `${E.rangeText(skipped)}번은 뺌`,
    ].filter(Boolean);
    toast(msg.join(' · ') || '이미 열려 있습니다');
  });

  $('formQuickNotice').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    commit(E.addNotice(state, f.text.value, Date.now()));
    f.text.value = '';
    toast('공지 등록됨 — 딜러 휴대폰에 보입니다');
  });

  $('formNotice').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    commit(E.addNotice(state, f.text.value, Date.now()));
    f.text.value = '';
    toast('공지 등록됨');
  });

  $('btnPayroll').addEventListener('click', () => {
    const now = Date.now();
    const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [['이름', '등급', '출근–퇴근', '근무시간(분)', '딜링(분)', '다른 업무(분)', '휴식(분)']];
    for (const d of state.dealers.filter(x => x.sessions.length)) { // 출근한 적 없는 출근 예정자는 빼고
      rows.push([d.name, d.grade, d.sessions.map(x => `${hhmm(x.in)}-${x.out == null ? '' : hhmm(x.out)}`).join(' / '),
        minutes(onDutyMs(d, now)), minutes(dealingMs(d, now)), minutes(dutyMs(d, now)), minutes(restMs(d, now))]);
    }
    download(`work-hours-${today()}.csv`, '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n'), 'text/csv');
  });

  // 로테이션 시작 — 시작 시각을 정할 수 있다 (과거 시각이면 그때부터 지금까지 채운다)
  $('formStart').addEventListener('submit', e => {
    if (!e.submitter || e.submitter.value !== 'go') return;
    const now = Date.now();
    const at = E.nearTime(now, $('startAt').value);
    const stop = msg => {
      e.preventDefault();
      $('startMsg').textContent = msg;
    };
    if (at == null) return stop('시각을 HH:MM으로 적어 주세요');
    if (at > now + 60000) return stop('앞으로의 시각은 적을 수 없습니다 — 지금 시작하려면 지금 시각을 적으세요');
    const from = Math.min(at, now);
    const next = E.startClockAt(state, from, now);
    if (next === state) return stop('하루보다 더 전의 시각은 채울 수 없습니다');
    commit(next, '로테이션 시작');
    const back = Math.round((now - from) / E.MIN);
    toast(back >= 1 ? `${hhmm(from)}부터 지금까지 ${back}분을 채웠습니다` : '로테이션 시작', true);
    return undefined;
  });

  $('btnClock').addEventListener('click', () => {
    const c = state.clock;
    const now = Date.now();
    if (!c.running) {
      if (!E.activeTables(state).length) {
        toast('먼저 테이블을 오픈하세요');
        return;
      }
      $('startAt').value = hhmm(now);
      $('startMsg').textContent = '';
      $('dlgStart').showModal();
    } else if (c.paused) {
      commit(E.resumeClock(state, now), '재개');
    } else {
      commit(E.pauseClock(state, now), '일시정지');
    }
  });

  $('btnPush').addEventListener('click', () => {
    if (confirm('지금 바로 교대할까요?')) doPush(Date.now());
  });

  $('btnRevert').addEventListener('click', () => revertLast());

  // 교대 간격 — 진행 중인 교대 기준으로 다음 교대 시각이 바로 옮겨진다 (설정 창과 같은 값)
  $('pushEvery').addEventListener('change', () => {
    const box = $('pushEvery');
    const v = Math.round(Number(box.value));
    if (!Number.isFinite(v) || v < 5 || v > 120) { box.value = state.settings.pushMinutes; return; }
    if (v === state.settings.pushMinutes) return;
    commit(E.updateSettings(state, { pushMinutes: v }, Date.now()));
    const at = state.clock.nextPushAt;
    toast(state.clock.running && at ? `교대 간격 ${v}분 — 다음 교대 ${hhmm(at)}` : `교대 간격 ${v}분`);
  });

  $('btnClearPlans').addEventListener('click', () => {
    commit(E.clearPlans(state, Date.now()), '직접 정한 교대 취소');
    toast('직접 정한 교대를 모두 취소했습니다 — 예정이 다시 계산됩니다', true);
  });

  // ---------- 로테이션 표에서 휴식 옮기기 ----------
  // 끌어다 놓아도 되고(마우스), 휴식 칸을 눌러 고른 뒤 놓을 칸을 눌러도 된다 (끌기가 안 되는 화면·글자만 잡힐 때).
  //  · 예정 칸의 휴식 → 같은 시각 다른 딜러면 자리 맞바꿈, 같은 딜러 다른 시각이면 휴식 옮기기 (뒤의 예정 다시 계산)
  //  · 지금 칸의 휴식 → 같은 시각 다른 딜러 자리에 놓으면 당장 그 자리에 투입 (테이블 칸 메뉴의 '지정'과 같다)
  const sheetCell = e => (e.target && e.target.closest ? e.target.closest('#sheet td[data-n]') : null);
  const isRest = td => !!td && td.classList.contains('rest');

  function dropOk(td) {
    if (!pick || !td) return false;
    const n = Number(td.dataset.n);
    const rest = td.classList.contains('rest');
    if (td.dataset.d === pick.id) {
      // 같은 딜러의 다른 시각 — 휴식을 다른 교대로 옮기는 것만 뜻이 통한다
      return pick.rest && !rest && pick.n >= 1 && n >= 1 && n !== pick.n;
    }
    if (n !== pick.n) return false;      // 다른 딜러 + 다른 시각은 무슨 뜻인지 알 수 없다
    // 휴식끼리는 바꿀 게 없다. 예정 칸의 '테이블 ↔ 테이블'은 그 교대에 두 사람의 테이블 맞바꿈 (2026-10-24 사용자 요청)
    return !(pick.rest && rest);
  }

  function setPick(td) {
    document.querySelectorAll('#sheet td.picked, #sheet td.drop-ok, #sheet td.drag-over')
      .forEach(x => x.classList.remove('picked', 'drop-ok', 'drag-over'));
    pick = td ? { n: Number(td.dataset.n), id: td.dataset.d, rest: td.classList.contains('rest') } : null;
    if (!td) return;
    td.classList.add('picked');
    document.querySelectorAll('#sheet td[data-n]').forEach(x => x.classList.toggle('drop-ok', dropOk(x)));
  }

  // 표를 다시 그리면 골라 둔 표시가 날아간다 → 같은 칸이 아직 있으면 다시 칠하고, 없으면 고른 것을 푼다
  function refreshPick() {
    if (!pick) return;
    const td = document.querySelector(`#sheet td[data-n="${pick.n}"][data-d="${pick.id}"]`);
    setPick(td && td.classList.contains('rest') === pick.rest ? td : null);
  }

  function applyMove(from, td) {
    const n = Number(td.dataset.n);
    const id = td.dataset.d;
    const rest = td.classList.contains('rest');
    const now = Date.now();
    setPick(null);
    if (from.n === 0) { // 지금 — 기다리지 않고 당장 바꾼다 ('지정'과 같은 동작)
      // 끌어온 쪽이 앉아 있고 놓은 쪽이 쉬고 있으면 "내 자리를 넘긴다", 그 밖에는 "내가 저 자리로 간다"
      const goes = !from.rest && rest ? id : from.id;
      const gives = goes === from.id ? id : from.id;
      const d = E.dealerOf(state, gives);
      if (!d || d.status !== 'working') return;
      const t = E.tableOf(state, d.tableId);
      commit(E.assignDealer(state, t.id, goes, now), `${nameOf(goes)} → ${t.no}번 지정`);
      const after = E.snapshot(state)[gives];
      toast(`지금 ${t.no}번 ${nameOf(goes)} · ${nameOf(gives)} ${after ? `${after}번` : '휴식'}`, true);
      return;
    }
    const at = (projection()[n - 1] || {}).at;
    const when = at ? `${hhmm(at)} 교대` : `${n}번째 교대`;
    // 직접 정한 탓에 연이어 두 번 쉬게 되면 알려 준다 (일부러 그럴 수도 있으므로 막지는 않는다)
    const warn = who => {
      const p = projection();
      const seat = i => (i === 0 ? E.snapshot(state)[who] : (p[i - 1] || { a: {} }).a[who]);
      return seat(n) === 0 && (seat(n - 1) === 0 || seat(n + 1) === 0) ? ' · 연이어 두 번 쉬게 됩니다' : '';
    };
    if (n === from.n && !from.rest && !rest) {
      // 테이블 칸 ↔ 테이블 칸: 그 교대 뒤 두 사람의 테이블을 맞바꾼다
      const before = (projection()[n - 1] || { a: {} }).a;
      commit(E.planTrade(state, n, from.id, id, now), `${nameOf(from.id)} ↔ ${nameOf(id)} 테이블 맞바꿈`);
      const p = (projection()[n - 1] || { a: {} }).a;
      if (p[from.id] === before[from.id]) {
        toast(`${when} — 바꾸지 못했습니다: 그 사이 상황이 달라져 두 사람이 그 교대에 함께 앉지 않습니다`, true);
      } else {
        toast(`${when} — 테이블 맞바꿈: ${nameOf(from.id)} ${p[from.id]}번 · ${nameOf(id)} ${p[id]}번`, true);
      }
    } else if (n === from.n) {
      // 쉬는 칸 쪽이 '쉬지 않을 사람'(a), 앉은 칸 쪽이 '대신 쉴 사람'(b) — 어느 쪽을 끌었든 같다
      const a = from.rest ? from.id : id;
      const b = from.rest ? id : from.id;
      commit(E.planSwap(state, n, a, b, now), `${nameOf(b)}에게 휴식 넘김`);
      // 앉아 있던 사람은 테이블을 옮기지 않으므로 끌어온 사람이 꼭 그 자리로 가지는 않는다 → 결과를 그대로 알려 준다
      const p = (projection()[n - 1] || { a: {} }).a;
      if (p[b] !== 0) {
        toast(`${when} — 바꾸지 못했습니다: 그 사이 상황이 달라져 ${nameOf(b)}를 쉬게 할 수 없습니다`, true);
      } else {
        toast(`${when} — ${nameOf(b)} 휴식, ${nameOf(a)} ${p[a] ? `${p[a]}번` : '휴식'}${warn(b)}`, true);
      }
    } else {
      commit(E.planMoveRest(state, from.n, n, from.id, now), `${nameOf(from.id)} 휴식 옮김`);
      toast(`${nameOf(from.id)}의 휴식을 ${when}로 옮겼습니다${warn(from.id)}`, true);
    }
  }

  $('sheet').addEventListener('dragstart', e => {
    const td = sheetCell(e);
    if (!td) {
      e.preventDefault();
      const old = e.target.closest && e.target.closest('#sheet td.past');
      if (old) toast('지난 교대는 못 바꿉니다 — 진행 중·예정 칸만 옮길 수 있습니다');
      return;
    }
    setPick(td);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', td.textContent.trim());
  });
  $('sheet').addEventListener('dragend', () => setPick(null));

  $('sheet').addEventListener('dragover', e => {
    const td = sheetCell(e);
    if (!dropOk(td)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (td.classList.contains('drag-over')) return;
    document.querySelectorAll('#sheet td.drag-over').forEach(x => x.classList.remove('drag-over'));
    td.classList.add('drag-over');
  });

  $('sheet').addEventListener('drop', e => {
    const td = sheetCell(e);
    if (!dropOk(td)) return;
    e.preventDefault();
    applyMove(pick, td);
  });

  // 눌러서 고르고 놓기 — 끌기가 안 되는 화면에서도, 끌다가 글자만 잡혔을 때도 이쪽으로 된다
  $('sheet').addEventListener('click', e => {
    const th = e.target.closest && e.target.closest('#sheet th[data-coln]');
    if (th) { setPick(null); openSched(Number(th.dataset.coln)); return; }
    const tc = e.target.closest && e.target.closest('#sheet td[data-tn]');
    if (tc) { setPick(null); openSched(Number(tc.dataset.tn), tc.dataset.t); return; }
    const td = sheetCell(e);
    if (pick && dropOk(td)) { applyMove(pick, td); return; }
    if (!td) { setPick(null); return; }
    const same = pick && pick.id === td.dataset.d && pick.n === Number(td.dataset.n);
    setPick(same ? null : td); // 고른 칸을 다시 누르면 취소
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pick) setPick(null); });

  // ---------- 같이 쓰기 창 ----------
  function openTeam(id) {
    renderTeam(id);
    $('dlgTeam').showModal();
  }

  function renderTeam(id) {
    const ev = EV.find(eventList(), id);
    if (!ev) return;
    const code = ev.share;
    setHTML($('teamBody'), !code
      ? `<p class="hint"><b>${esc(ev.name)}</b></p>
         <div class="dialog-actions"><button type="button" class="primary" data-act="team-on" data-id="${esc(id)}">참가 코드 만들기</button></div>`
      : `<p class="code-box">${esc(S.codeText(code))}</p>
         <p class="hint">${ev.guest
            ? '다른 계정이 만든 이벤트입니다. 나가면 내 목록에서만 사라지고 대회는 그대로입니다.'
            : '이 코드를 아는 DD 계정이 들어와 함께 조작합니다. 끄면 들어온 계정은 더 이상 쓸 수 없습니다.'}</p>
         <div class="dialog-actions">
           <button type="button" data-act="copy" data-text="${esc(S.codeText(code))}">코드 복사</button>
           <button type="button" class="danger" data-act="team-off" data-id="${esc(id)}">${ev.guest ? '나가기' : '같이 쓰기 끄기'}</button>
         </div>`);
  }

  async function teamOn(id) {
    const ev = EV.find(eventList(), id);
    if (!ev || !auth || ev.share) return;
    const code = S.shareCode();
    try {
      const token = await syncIdToken();
      await S.put(FB.databaseURL, `shared/${code}`, {
        owner: auth.uid,
        members: { [auth.uid]: true },
        name: ev.name,
        at: Date.now(),
        head: { rev: 1, by: String(auth.name || auth.email || '').slice(0, 60), at: Date.now() },
        state: store.getItem(EV.stateKey(id)) || 'null',
      }, token);
      const cur = EV.update(store, id, { share: code, sharedRev: 1, rev: (ev.rev || 0) + 1 });
      if (event && event.id === id && cur) event = cur;
      // 딜러 방도 같이 쓰게 (교대 시계를 가져간 쪽이 딜러 휴대폰·TV를 갱신해야 한다)
      await linkShareRoom(cur || ev);
      pushMeta(id);
      renderTeam(id);
      render();
      toast(`참가 코드 ${S.codeText(code)} — 다른 계정에서 이 코드로 들어옵니다`);
    } catch (e) {
      toast(`코드를 만들지 못했습니다 — ${S.explainError(e.message)}`);
    }
  }

  async function teamOff(id) {
    const ev = EV.find(eventList(), id);
    if (!ev || !ev.share || !auth) return;
    const guest = !!ev.guest;
    if (!confirm(guest ? '이 이벤트에서 나갈까요? (내 목록에서만 사라지고 대회는 그대로입니다)'
      : '같이 쓰기를 끌까요?\n코드로 들어온 계정은 더 이상 이 이벤트를 쓸 수 없습니다.')) return;
    const token = await syncIdToken();
    try {
      if (guest) {
        await S.put(FB.databaseURL, `shared/${ev.share}/members/${auth.uid}`, null, token).catch(() => {});
        EV.remove(store, id);
        await S.patch(FB.databaseURL, `users/${auth.uid}`, { [`events/${id}`]: null }, token).catch(() => {});
        location.href = homeUrl();
        return;
      }
      await S.put(FB.databaseURL, `shared/${ev.share}`, null, token).catch(() => {});
      if (ev.room) {
        await S.put(FB.databaseURL, `roomShare/${ev.room}`, null, token).catch(() => {});
        await S.put(FB.databaseURL, `rooms/${ev.room}/share`, null, token).catch(() => {});
      }
      const cur = EV.update(store, id, { share: null, sharedRev: 0, rev: (ev.rev || 0) + 1 });
      if (event && event.id === id && cur) event = cur;
      shareRun = null;
      shareGone = false;
      scheduleCloud(id, 0); // 내용을 내 계정으로 되돌려 둔다
      renderTeam(id);
      render();
      toast('같이 쓰기를 껐습니다');
    } catch (e) {
      toast(`끄지 못했습니다 — ${S.explainError(e.message)}`);
    }
  }

  $('btnJoin').addEventListener('click', () => {
    $('joinCode').value = '';
    $('joinMsg').textContent = '';
    $('dlgJoin').showModal();
  });

  $('formJoin').addEventListener('submit', e => {
    if (!e.submitter || e.submitter.value !== 'go') return;
    e.preventDefault();
    joinShared($('joinCode').value);
  });

  async function joinShared(input) {
    const code = S.normCode(input);
    const say = t => { $('joinMsg').textContent = t; };
    if (!code) { say('코드는 영문·숫자 8자입니다 (예: ABCD-EFGH)'); return; }
    if (!auth) { say('로그인이 필요합니다'); return; }
    const had = eventList().find(x => x.share === code);
    if (had) { $('dlgJoin').close(); location.href = eventUrl(had.id); return; }
    say('들어가는 중…');
    try {
      const token = await syncIdToken();
      await S.put(FB.databaseURL, `shared/${code}/members/${auth.uid}`, true, token);
      const node = await S.get(FB.databaseURL, `shared/${code}`, token);
      if (!node || !node.owner) { say('그런 코드가 없습니다 — 다시 확인해 주세요'); return; }
      let st = null;
      try { st = JSON.parse(typeof node.state === 'string' ? node.state : 'null'); } catch (err) { st = null; }
      const ev = EV.create(store, node.name || '같이 쓰는 이벤트', Date.now(), st || E.createState(), {
        id: `sh-${code}`, share: code, guest: true, sharedRev: Number(node.head && node.head.rev) || 0,
        room: node.room ? String(node.room) : null, // 새 방을 만들지 않고 주인의 딜러 QR 방을 같이 쓴다
      });
      pushMeta(ev.id);
      $('dlgJoin').close();
      location.href = eventUrl(ev.id);
    } catch (err) {
      say(/permission|denied|401|403/i.test(err.message)
        ? '그런 코드가 없거나 들어갈 수 없습니다 (코드와 이용 기간을 확인해 주세요)'
        : S.explainError(err.message));
    }
  }

  $('btnBoard').addEventListener('click', () => window.open(`?view=board&e=${encodeURIComponent(event.id)}`, `dealer-board-${event.id}`));

  // 이벤트 목록으로 — 로테이션이 돌고 있으면 이 화면의 자동 교대가 멈추므로 한 번 묻는다
  $('btnEvents').addEventListener('click', () => {
    const c = state.clock;
    if (c.running && !c.paused && !confirm('로테이션이 진행 중입니다.\n이벤트 목록으로 나가면 이 화면의 자동 교대·음성 안내가 멈추고 딜러 휴대폰도 갱신되지 않습니다.\n(이 이벤트를 다시 열면 이어서 진행)\n\n나갈까요?')) return;
    location.href = homeUrl();
  });

  const NUM_SETTINGS = ['pushMinutes', 'maxWorkMinutes', 'minRestMinutes', 'shortSeatMinutes', 'warnBeforeMinutes'];

  $('btnSettings').addEventListener('click', () => {
    const f = $('formSettings').elements;
    const s = state.settings;
    NUM_SETTINGS.forEach(k => { f[k].value = s[k]; });
    f.autoPush.checked = s.autoPush;
    f.voice.checked = s.voice;
    $('dlgSettings').showModal();
  });

  $('formSettings').addEventListener('submit', e => {
    if (!e.submitter || e.submitter.value !== 'save') return;
    const f = e.target.elements;
    const patch = {};
    NUM_SETTINGS.forEach(k => { patch[k] = Number(f[k].value); });
    patch.autoPush = f.autoPush.checked;
    patch.voice = f.voice.checked;
    commit(E.updateSettings(state, patch, Date.now()));
    toast('설정 저장됨');
  });

  // ---------- 백업 파일 · 계정 없이 쓰던 이벤트 옮기기 ----------
  // 이벤트는 계정에 저장되므로 PC를 바꿀 때는 로그인만 하면 된다. 백업 파일은 보관용
  // (이벤트 목록 화면과 설정 창 양쪽에 버튼)

  const BK = window.DealerBackup;

  // 이벤트들을 이 계정에 넣고 올린다 (백업 파일, 계정 기능 전에 이 PC에서 쓰던 것).
  // 딜러용 링크(QR)의 방: 이 계정이 주인이면 그대로, 아니면 넘겨받기를 시도하고(관리자 계정만 됨)
  // 안 되면 비운다 → 그 이벤트를 열면 새 QR이 생긴다
  async function takeIn(events) {
    const t = await syncIdToken();
    const list = events.map(ev => Object.assign({}, ev));
    for (const ev of list) {
      if (!ev.room) continue;
      try {
        const owner = await S.get(FB.databaseURL, `rooms/${ev.room}/owner`, t);
        if (owner !== auth.uid) await S.put(FB.databaseURL, `rooms/${ev.room}/owner`, auth.uid, t);
      } catch (e) {
        if (!/Permission denied/i.test(e.message)) throw e; // 인터넷 문제면 멈춘다 (다음에 다시)
        ev.room = null;
      }
    }
    EV.importEvents(store, list);
    await Promise.all(list.map(ev => pushEvent(ev.id)));
    return list;
  }

  async function saveBackup() {
    const now = Date.now();
    try {
      // 이 PC에 아직 안 받은 이벤트(다른 PC에서 만든 것)는 먼저 받아 온다
      for (const ev of eventList()) if (store.getItem(EV.stateKey(ev.id)) == null) await fetchEvent(ev.id);
    } catch (e) {
      toast(`백업하지 못했습니다 — ${S.explainError(e.message)}`);
      return;
    }
    const events = eventList().map(ev => Object.assign({}, ev, { state: EV.loadState(store, ev.id) }));
    download(BK.fileName(now), JSON.stringify(BK.makeBackup(events, now)), 'application/json');
    toast(`백업 파일 저장됨 (이벤트 ${events.length}개)`);
  }

  function loadBackup(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let b;
      try {
        b = BK.readBackup(String(reader.result), () => EV.newId(Date.now()));
      } catch (err) {
        toast(err.message);
        return;
      }
      const when = b.exportedAt ? new Date(b.exportedAt).toLocaleString('ko-KR') : '알 수 없음';
      const names = b.events.map(x => x.name).join(', ') || '없음';
      if (!confirm(`${when}에 저장한 백업을 이 계정(${auth.email})에 불러옵니다.\n이벤트 ${b.events.length}개: ${names}\n\n` +
        '같은 이벤트는 백업 내용으로 바뀌고, 없는 이벤트는 추가됩니다.')) return;
      try {
        if (!(await sessionOk())) return;
        await takeIn(b.events);
      } catch (err) {
        toast(`불러오지 못했습니다 — ${S.explainError(err.message)}`);
        return;
      }
      location.reload(); // 불러온 이벤트로 화면을 처음부터 다시
    };
    reader.readAsText(file, 'utf-8');
  }

  document.querySelectorAll('.backup-file').forEach(input => input.addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) loadBackup(file);
  }));

  $('btnReset').addEventListener('click', () => {
    if (!confirm(`'${event.name}' 이벤트의 테이블·딜러 출퇴근·기록·공지를 지웁니다 (다른 이벤트는 그대로). 계속할까요?`)) return;
    $('dlgSettings').close();
    commit(E.resetState(state, Date.now()));
    toast('초기화됨', true);
  });

  // ---------- 딜러용 링크 · 실시간 공유 ----------

  function linkFor(view) {
    const base = /^https?:$/.test(location.protocol) ? location.origin + location.pathname.replace(/index\.html$/, '') : PUBLIC_URL;
    return `${base}?view=${view}&db=${encodeURIComponent(S.dbHost(FB.databaseURL))}&r=${room()}`;
  }

  function urlBox(url) {
    return `<div class="share-url"><code>${esc(url)}</code><button type="button" data-act="copy" data-text="${esc(url)}">복사</button></div>`;
  }

  function renderShare() {
    const body = $('shareBody');
    const forEvent = `<p class="hint">이벤트 <b>${esc(event.name)}</b> 전용 링크·QR입니다. 다른 이벤트는 그 이벤트를 열어서 따로 만듭니다.</p>`;
    // 같이 쓰는 중에는 시계를 든 PC가 딜러 휴대폰을 갱신한다 — 다른 PC도 같은 링크·QR을 보여 주기만 (새 방을 만들지 않는다)
    if (room() && (isPublisher() || event.share)) {
      const me = linkFor('me');
      const status = !isPublisher() ? '<p class="conn ok">같이 쓰는 중 — 교대 시계를 든 PC가 딜러 휴대폰을 갱신합니다</p>'
        : syncStatus === 'error' ? `<p class="conn bad">공유 오류 · ${esc(syncError)}</p>`
          : syncStatus === 'live' ? '<p class="conn ok">공유 중 — 이 PC에서 바꾸는 내용이 딜러 휴대폰에 30초 안에 보입니다</p>'
            : '<p class="conn">연결하는 중…</p>';
      body.innerHTML = `${status}${forEvent}
        <p class="hint">딜러는 휴대폰 카메라로 아래 QR을 찍거나 링크를 열고, 자기 이름을 한 번 고르면 됩니다.
          '홈 화면에 추가'하면 다음부터 앱처럼 바로 열립니다.</p>
        <h3>딜러 휴대폰</h3>${urlBox(me)}
        ${SHOW_TV ? `<h3>딜러룸 TV (다른 컴퓨터에서 열 때)</h3>${urlBox(linkFor('board'))}` : ''}
        ${event.guest ? '' : '<div class="row-actions"><button type="button" class="danger" data-act="sync-off">이 이벤트 공유 끊기</button></div>'}`;
      drawQr(me);
      return;
    }
    if (event.guest) { // 주인 PC가 아직 링크를 이어 두지 않았다 (주인이 이 이벤트를 한 번 열면 생긴다)
      $('shareQr').innerHTML = '';
      body.innerHTML = `${forEvent}<p class="hint">같이 쓰는 이벤트입니다. 딜러 링크·QR은 주인 계정의 것을 함께 씁니다 —
        주인 PC에서 이 이벤트를 한 번 열면 여기에도 보입니다.</p>`;
      return;
    }
    $('shareQr').innerHTML = '';
    const busy = syncStatus === 'connecting';
    body.innerHTML = `${syncStatus === 'error' ? `<p class="conn bad">연결 실패 · ${esc(syncError)}</p>` : ''}${forEvent}
      ${busy ? '<p class="conn">연결하는 중…</p>' : '<p>이 이벤트용 딜러 링크·QR을 만들까요?</p>'}
      <div class="row-actions">
        <button type="button" class="primary" data-act="sync-room"${busy || !hasAccount() ? ' disabled' : ''}>이 이벤트 공유 시작</button>
      </div>`;
  }

  let qrLib = null;
  function loadQrLib() {
    if (window.QRCode) return Promise.resolve();
    if (!qrLib) {
      qrLib = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
        s.onload = resolve;
        s.onerror = () => { qrLib = null; reject(new Error('QR 라이브러리 로드 실패')); };
        document.head.appendChild(s);
      });
    }
    return qrLib;
  }

  let qrDrawn = null;
  function drawQr(url) {
    if (qrDrawn === url && $('shareQr').childElementCount) return;
    qrDrawn = url;
    $('shareQr').innerHTML = '';
    loadQrLib()
      .then(() => new window.QRCode($('shareQr'), { text: url, width: 240, height: 240, correctLevel: window.QRCode.CorrectLevel.M }))
      .catch(() => {
        $('shareQr').innerHTML = '<p class="muted">QR 코드를 불러오지 못했습니다 (인터넷 연결 확인). 위 링크를 복사해서 보내세요.</p>';
      });
  }

  $('btnShare').addEventListener('click', () => {
    qrDrawn = null;
    renderShare();
    $('dlgShare').showModal();
  });

  // ---------- 로그인 · 로그아웃 · 비밀번호 ----------

  function deviceName() {
    const ua = navigator.userAgent;
    const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
      : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '기타';
    const br = /Edg\//.test(ua) ? '엣지' : /Whale\//.test(ua) ? '웨일' : /SamsungBrowser/.test(ua) ? '삼성 인터넷'
      : /Chrome\//.test(ua) ? '크롬' : /Firefox\//.test(ua) ? '파이어폭스' : /Safari\//.test(ua) ? '사파리' : '브라우저';
    return `${os} · ${br}`;
  }

  function loginMsg(text, bad) {
    $('loginMsg').innerHTML = text ? `<p class="conn ${bad ? 'bad' : ''}">${esc(text)}</p>` : '';
  }

  async function login(email, password) {
    const a = await S.signIn(FB.apiKey, email, password);
    const acc = await S.get(FB.databaseURL, `accounts/${a.uid}`, a.idToken);
    const l = AC.license(acc, Date.now());
    if (l.state === 'none') throw new Error('등록되지 않은 계정입니다 — 판매자에게 문의하세요');
    if (l.state === 'off') throw new Error('사용이 정지된 계정입니다 — 판매자에게 문의하세요');
    if (l.state === 'expired') throw new Error(`이용 기간이 끝났습니다 (${AC.dateStr(l.until)}까지) — 연장은 판매자에게 문의하세요`);
    const admin = (await S.get(FB.databaseURL, `admins/${a.uid}`, a.idToken).catch(() => null)) === true;
    // 이 PC가 이 계정을 쓰는 PC — 먼저 쓰던 PC는 20초 안에 로그아웃된다
    const sid = S.randomId(12);
    await S.put(FB.databaseURL, `users/${a.uid}/session`, { id: sid, at: { '.sv': 'timestamp' }, ua: deviceName() }, a.idToken);
    auth = { uid: a.uid, email: a.email || email, refreshToken: a.refreshToken, sid, name: acc.name, until: acc.until, admin };
    store = AC.scoped(localStorage, a.uid);
    idTok = a;
    sessionAt = Date.now();
    saveJson(AUTH_KEY, auth);
    saveJson(EMAIL_KEY, auth.email);
    try {
      await offerLegacy();
    } catch (e) {
      alert(`예전 이벤트를 옮기지 못했습니다 (${S.explainError(e.message)}).\n다음에 로그인할 때 다시 묻습니다.`);
    }
    location.href = homeUrl();
  }

  // 계정 기능 전에 이 PC에서 (로그인 없이) 쓰던 이벤트가 있으면 이 계정으로 옮길지 묻는다
  async function offerLegacy() {
    let legacy = [];
    try { legacy = EV.list(localStorage); } catch (e) { return; }
    if (!legacy.length) return;
    if (!confirm(`이 PC에 로그인 전에 쓰던 이벤트 ${legacy.length}개가 있습니다: ${legacy.map(ev => ev.name).join(', ')}\n\n` +
      `이 계정(${auth.email})으로 옮길까요? 옮기면 계정에 저장되어 다른 PC에서도 보입니다.${auth.admin ? '\n딜러용 링크(QR)도 그대로 이어집니다.' : ''}\n` +
      '(취소하면 다음에 로그인할 때 다시 묻습니다)')) return;
    loginMsg('이벤트를 계정으로 옮기는 중…');
    const events = legacy.map(ev => Object.assign({}, ev, { state: EV.loadState(localStorage, ev.id) }));
    await takeIn(events);
    // 옮긴 것과 예전 익명 로그인 정보는 이 PC의 계정 없는 자리에서 지운다
    events.forEach(ev => localStorage.removeItem(EV.stateKey(ev.id)));
    localStorage.removeItem(EV.LIST_KEY);
    localStorage.removeItem(EV.SYNC_KEY);
  }

  $('formLogin').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    loginMsg('로그인하는 중…');
    $('btnLogin').disabled = true;
    try {
      await login(f.email.value.trim(), f.password.value);
    } catch (err) {
      loginMsg(S.explainError(err.message), true);
    }
    $('btnLogin').disabled = false;
  });

  async function forgotPassword() {
    const email = $('formLogin').elements.email.value.trim();
    if (!email) {
      loginMsg('위에 이메일을 먼저 적어 주세요', true);
      return;
    }
    try {
      await S.sendPasswordReset(FB.apiKey, email);
      loginMsg(`${email} 로 비밀번호 재설정 메일을 보냈습니다 — 메일의 링크에서 새 비밀번호를 정하세요 (스팸함도 확인)`);
    } catch (e) {
      loginMsg(/EMAIL_NOT_FOUND/.test(e.message) ? '등록되지 않은 이메일입니다' : S.explainError(e.message), true);
    }
  }

  // 아직 계정에 못 올린 변경이 있으면 올려 보고, 그래도 남으면 물어본다.
  // 다 올렸으면 이 PC에서 이 계정의 저장분을 지운다 (다른 사람이 같은 PC를 쓸 수 있으므로)
  async function logout() {
    const pending = eventList().filter(AC.dirty);
    if (pending.length) await Promise.all(pending.map(ev => pushEvent(ev.id)));
    const left = eventList().filter(AC.dirty);
    if (left.length && !confirm(`계정에 아직 저장하지 못한 이벤트가 있습니다: ${left.map(ev => ev.name).join(', ')} (인터넷 연결 확인)\n\n` +
      '로그아웃해도 이 PC에는 남아 있어서, 다음에 이 PC에서 이 계정으로 로그인하면 올립니다. 로그아웃할까요?')) return;
    if (!left.length) AC.clearScoped(localStorage, auth.uid);
    saveJson(AUTH_KEY, null);
    location.href = homeUrl();
  }

  $('formPw').addEventListener('submit', async e => {
    if (!e.submitter || e.submitter.value !== 'save') return;
    e.preventDefault();
    const f = e.target.elements;
    if (f.next.value !== f.next2.value) {
      $('pwMsg').textContent = '새 비밀번호 두 칸이 다릅니다';
      return;
    }
    $('pwMsg').textContent = '바꾸는 중…';
    try {
      const a = await S.signIn(FB.apiKey, auth.email, f.cur.value).catch(err => {
        throw new Error(/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD/.test(err.message) ? '지금 비밀번호가 맞지 않습니다' : err.message);
      });
      const b = await S.changePassword(FB.apiKey, a.idToken, f.next.value);
      auth.refreshToken = b.refreshToken; // 비밀번호를 바꾸면 예전 로그인 열쇠는 못 쓴다
      idTok = b;
      saveJson(AUTH_KEY, auth);
      $('dlgPw').close();
      toast('비밀번호를 바꿨습니다');
    } catch (err) {
      $('pwMsg').textContent = S.explainError(err.message);
    }
  });

  // ---------- 관리자 화면 (판매자): DD 계정 만들기 · 기간 연장 · 정지 ----------
  // 계정 = 로그인(이메일·비밀번호) + accounts/{uid}(이름·이용 기간). 고객의 이벤트 내용은 볼 수 없다

  let accounts = null; // {uid: {email, name, until, createdAt, memo}}
  let sessions = {};   // {uid: {at, ua}} 최근 로그인

  async function loadAccounts() {
    try {
      const t = await syncIdToken();
      const all = (await S.get(FB.databaseURL, 'accounts', t)) || {};
      const uids = Object.keys(all);
      const ss = await Promise.all(uids.map(u => S.get(FB.databaseURL, `users/${u}/session`, t).catch(() => null)));
      accounts = all;
      sessions = Object.fromEntries(uids.map((u, i) => [u, ss[i]]));
    } catch (e) {
      toast(`계정 목록을 받지 못했습니다 — ${S.explainError(e.message)}`);
    }
    renderAdmin();
  }

  const md = t => {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  function renderAdmin() {
    renderAccountBar();
    if (!auth.admin) {
      $('admin').querySelector('.acc-new').hidden = true;
      setHTML($('accountList'), '<p class="conn bad">관리자(판매자) 계정만 볼 수 있습니다.</p>');
      return;
    }
    if (!accounts) {
      setHTML($('accountList'), '<p class="muted">불러오는 중…</p>');
      return;
    }
    const now = Date.now();
    const rows = Object.entries(accounts).sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0)).map(([uid, a]) => {
      const l = AC.license(a, now);
      const ss = sessions[uid];
      const seen = ss && ss.at ? `${md(ss.at)} ${hhmm(ss.at)}${ss.ua ? ` · ${esc(ss.ua)}` : ''}` : '—';
      const me = uid === auth.uid;
      return `<tr class="lic-${l.state}${l.state === 'ok' && l.daysLeft <= 7 ? ' soon' : ''}">
        <td><b>${esc(a.name)}</b>${me ? ' <span class="tag">나</span>' : ''}${a.memo ? `<br><small class="muted">${esc(a.memo)}</small>` : ''}</td>
        <td>${esc(a.email)}</td>
        <td class="lic">${esc(AC.licenseText(a, now))}</td>
        <td><small>${seen}</small></td>
        <td><div class="row-actions">
          <button class="mini" data-act="acc-ext" data-uid="${esc(uid)}" data-m="1">+1개월</button>
          <button class="mini" data-act="acc-ext" data-uid="${esc(uid)}" data-m="3">+3개월</button>
          <button class="mini" data-act="acc-date" data-uid="${esc(uid)}">날짜 지정</button>
          <button class="mini" data-act="acc-edit" data-uid="${esc(uid)}">이름·메모</button>
          <button class="mini" data-act="acc-reset" data-uid="${esc(uid)}">비밀번호 재설정 메일</button>
          ${me ? '' : `<button class="mini danger" data-act="acc-off" data-uid="${esc(uid)}"${l.state === 'off' ? ' disabled' : ''}>정지</button>`}
        </div></td></tr>`;
    });
    setHTML($('accountList'), rows.length
      ? `<div class="sheet-wrap"><table class="acc-table"><thead><tr><th>업체·이름</th><th>이메일 (로그인)</th><th>이용 기간</th><th>최근 로그인</th><th></th></tr></thead>
          <tbody>${rows.join('')}</tbody></table></div>`
      : '<p class="empty">아직 계정이 없습니다.</p>');
  }

  async function accountAction(act, uid, m) {
    const a = accounts && accounts[uid];
    if (!a) return;
    const now = Date.now();
    let patch = null;
    if (act === 'acc-reset') {
      if (!confirm(`${a.email} 로 비밀번호 재설정 메일을 보낼까요?\n고객이 메일의 링크에서 새 비밀번호를 정합니다.`)) return;
      try {
        await S.sendPasswordReset(FB.apiKey, a.email);
        toast('비밀번호 재설정 메일을 보냈습니다');
      } catch (e) {
        toast(S.explainError(e.message));
      }
      return;
    }
    if (act === 'acc-ext') patch = { until: AC.extend(a.until, Number(m), now) };
    if (act === 'acc-date') {
      const v = prompt(`${a.name} — 이용 기간 마지막 날 (예: ${AC.dateStr(AC.addMonths(now, 1))})`, a.until > 0 ? AC.dateStr(a.until) : '');
      if (v == null) return;
      const until = AC.endOfDay(v.trim());
      if (!until) {
        toast('날짜는 2026-11-07 모양으로 적어 주세요');
        return;
      }
      patch = { until };
    }
    if (act === 'acc-off') {
      if (!confirm(`${a.name} (${a.email}) 계정을 정지할까요?\n몇 분 안에 로그인·공유·저장이 막힙니다. 다시 쓰게 하려면 기간을 연장하세요.`)) return;
      patch = { until: 0 };
    }
    if (act === 'acc-edit') {
      const name = prompt('업체·이름', a.name);
      if (name == null || !name.trim()) return;
      const memo = prompt('메모 (판매자만 봄 — 입금일 등)', a.memo || '');
      if (memo == null) return;
      patch = { name: name.trim().slice(0, 60), memo: memo.trim().slice(0, 200) };
    }
    try {
      await S.patch(FB.databaseURL, `accounts/${uid}`, patch, await syncIdToken());
      accounts[uid] = Object.assign({}, a, patch);
      renderAdmin();
      toast(`${accounts[uid].name}: ${'until' in patch ? AC.licenseText(accounts[uid], Date.now()) : '저장됨'}`);
    } catch (e) {
      toast(`저장하지 못했습니다 — ${S.explainError(e.message)}`);
    }
  }

  $('formAccount').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const f = form.elements;
    const name = f.name.value.trim();
    const email = f.email.value.trim();
    const password = f.password.value;
    const months = Number(f.months.value);
    const until = months > 0 ? AC.addMonths(Date.now(), months) : AC.endOfDay(f.until.value);
    if (!until) {
      toast('이용 기간 마지막 날을 고르세요');
      return;
    }
    $('btnAccount').disabled = true;
    setHTML($('accountMade'), '<p class="conn">만드는 중…</p>');
    try {
      let uid;
      try {
        uid = (await S.signUp(FB.apiKey, email, password)).uid;
      } catch (err) {
        if (!/EMAIL_EXISTS/.test(err.message)) throw err;
        // 이미 있는 이메일(만들다 끊긴 경우 등): 같은 비밀번호면 그 계정을 다시 등록
        uid = (await S.signIn(FB.apiKey, email, password).catch(() => { throw new Error('EMAIL_EXISTS'); })).uid;
      }
      await S.put(FB.databaseURL, `accounts/${uid}`, { email, name, until, createdAt: { '.sv': 'timestamp' }, memo: '' }, await syncIdToken());
      const text = `딜러 디렉터 로그인 정보\n주소: ${PUBLIC_URL}\n이메일: ${email}\n비밀번호: ${password}\n이용 기간: ${AC.dateStr(until)}까지\n` +
        '처음 로그인한 뒤 \'비밀번호 바꾸기\'로 바꿔 주세요. 한 계정은 한 번에 한 PC에서만 쓸 수 있습니다.';
      setHTML($('accountMade'), `<div class="made"><p class="conn ok">${esc(name)} 계정을 만들었습니다 — 고객에게 아래 내용을 보내세요</p>
        <pre>${esc(text)}</pre><button type="button" data-act="copy" data-text="${esc(text)}">복사</button></div>`);
      form.reset();
      f.until.hidden = true;
      f.password.value = AC.makePassword(10);
      loadAccounts();
    } catch (err) {
      setHTML($('accountMade'), `<p class="conn bad">만들지 못했습니다 — ${esc(S.explainError(err.message))}</p>`);
    }
    $('btnAccount').disabled = false;
  });

  $('formAccount').elements.months.addEventListener('change', e => {
    $('formAccount').elements.until.hidden = e.target.value !== '0';
  });

  // ---------- Holdem TD 내장 모드 (postMessage 다리) ----------
  // Holdem TD(토너먼트 관리 프로그램, thstjdals09-lang/tournament)가 이 앱을 통째로 복사해(`dd/`) 딜러 탭 iframe 으로 연다.
  // 단독으로 열면(부모 창 없음) 아무것도 하지 않는다. 딜러 휴대폰·TV 화면도 마찬가지.
  //  TD → DD  {td:'dd', type:'event', id, name}        TD 이벤트 하나 = DD 이벤트 하나(id 는 TD 가 정한다). 없으면 계정에서 받아 오고,
  //                                                   그래도 없으면 새로 만들어 연다. 열려 있으면 이름만 맞춘다
  //           {td:'dd', type:'tables', event, open:[…]} TD 에서 열린 테이블 번호 — 그 이벤트가 열려 있을 때만 DD 테이블을 열고 닫는다
  //                                                   (열면 쉬는 딜러가 자동으로 앉고, 깨면 그 딜러는 휴식)
  //           {td:'dd', type:'deleteEvent', id} · {type:'logout'} · {type:'settings'} · {type:'share'} · {type:'hello'}
  //  DD → TD  {dd:'td', type:'state', page:'event', event:{id,name}, account, blocked, tables:[{no,dealer,since,feature}],
  //                     staffing, dealers, clock, room}                그릴 때마다(바뀐 것만)
  //           {dd:'td', type:'page', page:'login'|'fetch'|'list'|'admin'|'view', account, blocked, height}  이벤트가 열려 있지 않을 때
  //           {dd:'td', type:'ready'}                                  시작 끝
  // 부모가 '로그인 전'(page:'login')이나 blocked 를 받으면 앱 전체를 막는다 — 판매자가 승인한 DD 계정만 TD 를 쓸 수 있다.
  const td = (() => {
    if (!embedded) return null;
    const origin = /^https?:$/.test(location.protocol) ? location.origin : '*';
    const post = msg => { try { window.parent.postMessage(Object.assign({ dd: 'td' }, msg), origin); } catch (e) { /* 부모 없음 */ } };
    let lastSig = '';
    let opening = null; // 지금 열러 가는 이벤트 id (같은 요청이 겹쳐 와도 한 번만)
    const page = needLogin ? 'login' : needFetch ? 'fetch' : isAdminView ? 'admin' : isList ? 'list' : (isBoard || isMe) ? 'view' : 'event';
    const accountInfo = () => (auth ? { name: auth.name || '', email: auth.email || '', until: auth.until || 0, admin: !!auth.admin } : null);
    function send(msg) {
      const sig = JSON.stringify(msg);
      if (sig === lastSig) return;
      lastSig = sig;
      post(msg);
    }
    function report() {
      if (page !== 'event') {
        send({ type: 'page', page, account: accountInfo(), blocked, height: document.documentElement.scrollHeight });
        return;
      }
      const now = nowMs();
      const tables = E.activeTables(state).map(t => {
        const d = t.dealerId ? E.dealerOf(state, t.dealerId) : null;
        return { no: t.no, dealer: d ? d.name : null, since: d ? d.since : null, feature: !!t.feature };
      });
      const st = E.staffing(state);
      const c = state.clock;
      send({ type: 'state', page, event: { id: event.id, name: event.name }, account: accountInfo(), blocked,
        tables, staffing: { tables: st.tables, working: st.working, onBreak: st.onBreak, diff: st.diff },
        dealers: state.dealers.filter(d => d.status !== 'off').length,
        clock: { running: c.running, paused: c.paused, nextPushAt: c.nextPushAt, offset: now - Date.now() }, room: room() });
    }
    // TD 이벤트 → DD 이벤트. 이 PC 에 있으면 바로, 계정(다른 PC)에 있으면 받아서, 없으면 새로 만들어 연다
    function openEvent(id, name) {
      if (!isDirector || blocked || !id) return;
      if (page === 'event' && event.id === id) {
        if (name && name !== event.name) setEventName(name);
        return;
      }
      if (opening === id) return;
      opening = id;
      const go = () => { location.href = eventUrl(id); };
      if (EV.find(eventList(), id) && store.getItem(EV.stateKey(id)) != null) return go();
      fetchEvent(id).catch(() => false).then(ok => {
        if (!ok) createEvent(id, name);
        go();
      });
    }
    function createEvent(id, name) {
      // 새 이벤트는 가장 최근 이벤트의 출근자 명단을 물려받는다 (formEvent 와 같다)
      const fresh = E.createState();
      const prev = EV.list(store)[0];
      const prevState = prev ? EV.loadState(store, prev.id) : null;
      if (prevState) fresh.roster = E.rosterEntries(prevState.roster);
      EV.create(store, name, Date.now(), fresh, { id });
    }
    function setEventName(name) {
      EV.update(store, event.id, { name });
      markChanged(event.id);
      $('eventName').textContent = name;
      document.title = `${name} · 딜러 디렉터`;
      report();
    }
    // 부모의 열린 테이블 번호 ↔ DD 열린 테이블. 없는 번호는 열고(쉬는 딜러가 자동으로 앉는다), 부모에 없는 테이블은 깬다
    function syncTables(evId, open) {
      if (page !== 'event' || blocked || (evId && event.id !== evId)) return;
      const want = Array.from(new Set((open || []).map(Number).filter(n => n > 0))).sort((a, b) => a - b);
      const now = Date.now();
      let next = state;
      const have = E.activeTables(next).map(t => t.no);
      for (const no of have) if (!want.includes(no)) next = E.closeTable(next, 't' + no, now);
      const add = want.filter(no => !have.includes(no));
      if (add.length) next = E.openTable(next, add, now);
      if (next !== state) commit(next); // 부모(레지·테이블 탭)가 한 일이므로 DD 되돌리기 목록에는 넣지 않는다
      report();
    }
    async function dropEvent(id) {
      if (!isDirector || !id) return;
      const ok = await removeEvent(id); // TD 가 이미 물어봤으므로 확인 없이
      if (ok && page === 'event' && event.id === id) location.href = homeUrl();
    }
    window.addEventListener('message', e => {
      const m = e.data;
      if (!m || m.td !== 'dd') return;
      if (origin !== '*' && e.origin !== origin) return;
      if (m.type === 'event') openEvent(String(m.id || ''), String(m.name || ''));
      else if (m.type === 'tables') syncTables(m.event ? String(m.event) : null, m.open);
      else if (m.type === 'deleteEvent') dropEvent(String(m.id || ''));
      else if (m.type === 'logout') { if (isDirector) logout(); }
      else if (m.type === 'settings' && page === 'event') $('btnSettings').click();
      else if (m.type === 'share' && page === 'event') $('btnShare').click();
      else if (m.type === 'hello') report();
    });
    // 계정 차단(다른 PC 로그인·기간 만료·정지)과 관리자 화면(계정 목록 받은 뒤)은 render 를 거치지 않으므로 직접 보고
    const renderGate0 = renderGate;
    renderGate = function () { renderGate0(); report(); };
    const renderAdmin0 = renderAdmin;
    renderAdmin = function () { renderAdmin0(); report(); };
    return { report, hello: () => { report(); post({ type: 'ready' }); } };
  })();

  // ---------- 시작 ----------

  if (window.ResizeObserver) {
    new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', $('topbar').offsetHeight + 'px')).observe($('topbar'));
  }

  const showMain = id => ['control', 'events', 'board', 'me', 'login', 'admin'].forEach(m => { $(m).hidden = m !== id; });

  if (needLogin) {
    document.body.classList.add('is-login');
    $('topbar').hidden = true;
    $('tabs').hidden = true;
    showMain('login');
    const f = $('formLogin').elements;
    f.email.value = loadJson(EMAIL_KEY) || '';
    (f.email.value ? f.password : f.email).focus();
    if (td) td.report(); // 내장 모드: '로그인 전'을 부모에게 (부모는 앱 전체를 막는다)
    return;
  }

  if (needFetch) {
    // 이 PC에 없는 이벤트 → 계정에서 받아 와서 다시 연다
    $('topbar').hidden = true;
    $('tabs').hidden = true;
    showMain(null);
    const g = $('gate');
    const back = `<a class="btn" href="${esc(homeUrl())}">이벤트 목록</a>`;
    g.innerHTML = '<div class="gate-box"><h2>이벤트를 불러오는 중…</h2></div>';
    g.hidden = false;
    if (td) td.report();
    fetchEvent(wantEvent).then(ok => {
      if (blocked) return;
      if (ok) location.reload();
      else g.innerHTML = `<div class="gate-box"><h2>이벤트를 찾을 수 없습니다</h2><p>다른 PC에서 지웠을 수 있습니다.</p><div class="row-actions">${back}</div></div>`;
    }, e => {
      if (blocked) return;
      g.innerHTML = `<div class="gate-box"><h2>이벤트를 불러오지 못했습니다</h2><p>${esc(S.explainError(e.message))}</p>
        <div class="row-actions">${back}<button type="button" class="primary" onclick="location.reload()">다시 시도</button></div></div>`;
    });
    return;
  }

  if (isAdminView) {
    document.body.classList.add('is-list', 'is-admin');
    $('controls').hidden = true;
    $('pushClock').hidden = true;
    $('eventBar').hidden = true;
    $('tabs').hidden = true;
    showMain('admin');
    $('accountBar').hidden = false;
    $('formAccount').elements.password.value = AC.makePassword(10);
    document.title = '관리자 · 딜러 디렉터';
    loadAccounts();
  } else if (isList) {
    document.body.classList.add('is-list');
    $('controls').hidden = true;
    $('pushClock').hidden = true;
    $('eventBar').hidden = true;
    $('tabs').hidden = true;
    showMain('events');
    $('accountBar').hidden = false;
    syncList();
  } else if (isBoard) {
    document.body.classList.add('is-board');
    $('btnEvents').hidden = true;
    $('controls').hidden = true;
    $('tabs').hidden = true;
    showMain('board');
  } else if (isMe) {
    document.body.classList.add('is-me');
    $('topbar').hidden = true;
    $('tabs').hidden = true;
    showMain('me');
  } else {
    $('eventName').textContent = event.name;
    $('formTables').elements.skip.value = skipText();
    $('formTables').elements.use.checked = !!state.settings.openUse;
    document.title = `${event.name} · 딜러 디렉터`;
    applyTab();
    window.addEventListener('hashchange', () => {
      applyTab();
      render();
    });
    // Ctrl+Z = 작업 되돌리기 (글자 입력 중이거나 창이 떠 있을 때는 제외)
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
      if (e.target.closest('input, textarea, select') || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      revertLast();
    });
  }
  if (remote) {
    state = E.migrate(null); // 공유 방을 볼 때는 이 기기의 로컬 데이터를 섞지 않는다
    pollRemote(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRemote(); }); // 화면을 다시 켜면 바로 확인
    window.addEventListener('online', () => pollRemote());
  }
  if (isDirector) {
    checkSession().catch(() => {}); // 다른 PC에서 로그인했으면 바로 알 수 있게
    checkLicense().then(() => { if (isList || isAdminView) render(); }).catch(() => {});
  }
  if (event && isDirector) {
    if (AC.dirty(event)) scheduleCloud(event.id, 0); // 방금 만든 이벤트·못 올린 변경
    if (isPublisher()) publish(false);
    startInbox();
    // 이 이벤트의 딜러 링크(QR)가 아직 없으면 바로 만든다 ('공유 끊기'한 이벤트, 같이 쓰기에 들어온 이벤트는 제외 — 주인의 방을 쓴다)
    if (!room() && !event.shareOff && !event.guest) openRoom();
    if (event.share && !event.guest && room()) linkShareRoom(event); // 예전에 켠 같이 쓰기도 새 방식으로 이어 둔다
  }
  render();
  if (td) td.hello();
  startTicker(() => tick());
})();
