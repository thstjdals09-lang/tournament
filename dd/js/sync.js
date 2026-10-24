/*
 * 파이어베이스 통신 — Realtime Database와 로그인(Authentication)을 SDK 없이 REST로 쓴다.
 *  - DD(디렉터) 계정: 판매자가 관리자 화면에서 이메일·비밀번호로 만들어 준다 (accounts/{uid}에 이용 기간)
 *  - 계정마다 이벤트를 users/{uid}에 따로 보관 → 로그인하면 어느 PC에서든 그대로
 *  - 디렉터 PC: 이벤트마다 방(room)을 만들고 주인으로 등록 → 바뀔 때마다(그리고 30초마다) 휴대폰·TV용 데이터를 올림
 *  - 딜러 휴대폰/보드: 로그인 없이, 화면이 켜져 있는 동안만 가끔 받는다 (실시간 연결을 열어 두지 않음 —
 *    무료 요금제의 동시 연결 100개 안에서 딜러 수천 명이 볼 수 있게). 방의 형식은 phoneview.js 맨 위
 *  - 딜러 휴대폰 → 디렉터: 퇴근 희망 답만 rooms/{방}/eo/{딜러id}에 쓴다 (그 딜러에게 지금 열린 질문에만)
 * 방에 올리는 건 로테이션·공지 등 화면에 필요한 것뿐 (연락처·계좌 같은 개인정보는 앱에 아예 없다).
 * 보안 규칙은 아래 RULES = database.rules.json (이용 기간이 남은 계정만 쓰기, 관리자만 계정 관리).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DealerSync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // http:// 는 이 PC에서 돌리는 에뮬레이터(시험용)만
  function normDb(url) {
    const u = String(url || '').trim().replace(/\/+$/, '').replace(/\/+\?/, '?');
    if (!u) return '';
    if (/^https?:\/\//.test(u)) return u;
    return (/^(localhost|127\.0\.0\.1)(:|\?|\/|$)/.test(u) ? 'http://' : 'https://') + u;
  }

  // 휴대폰 링크에는 https:// 를 뺀 호스트만 넣는다
  const dbHost = url => normDb(url).replace(/^https?:\/\//, '');

  // DB 주소 + 경로 → REST 주소 (에뮬레이터는 주소에 ?ns= 가 붙어 있다)
  function urlOf(dbUrl, path, query) {
    const [base, qs] = normDb(dbUrl).split('?');
    const p = new URLSearchParams(qs || '');
    for (const [k, v] of Object.entries(query || {})) if (v != null) p.set(k, v);
    const s = p.toString();
    return `${base}/${path}.json${s ? `?${s}` : ''}`;
  }

  function randomId(len) {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(len || 20);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => chars[b % chars.length]).join('');
  }

  // ---------- 로그인 (이메일·비밀번호) ----------

  // 로그인 서버 주소 — 시험할 때만 에뮬레이터로 바꾼다 (setEndpoints)
  const ep = {
    auth: 'https://identitytoolkit.googleapis.com/v1',
    token: 'https://securetoken.googleapis.com/v1',
  };
  const setEndpoints = o => Object.assign(ep, o);

  async function postJson(url, body, form, headers) {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, headers || {}),
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && (data.error.message || data.error)) || `HTTP ${res.status}`);
    return data;
  }

  const session = d => ({
    uid: d.localId,
    email: d.email,
    idToken: d.idToken,
    refreshToken: d.refreshToken,
    expiresAt: Date.now() + Number(d.expiresIn) * 1000,
  });

  const signIn = async (apiKey, email, password) => session(await postJson(`${ep.auth}/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    { email, password, returnSecureToken: true }));

  // 관리자가 고객 계정을 만들 때 (만든 계정의 로그인 정보는 쓰지 않는다)
  const signUp = async (apiKey, email, password) => session(await postJson(`${ep.auth}/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
    { email, password, returnSecureToken: true }));

  async function refreshToken(apiKey, token) {
    const d = await postJson(`${ep.token}/token?key=${encodeURIComponent(apiKey)}`,
      { grant_type: 'refresh_token', refresh_token: token }, true);
    return { uid: d.user_id, idToken: d.id_token, refreshToken: d.refresh_token, expiresAt: Date.now() + Number(d.expires_in) * 1000 };
  }

  // 비밀번호 재설정 메일 (한국어 메일)
  const sendPasswordReset = (apiKey, email) => postJson(`${ep.auth}/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`,
    { requestType: 'PASSWORD_RESET', email }, false, { 'X-Firebase-Locale': 'ko' });

  // 비밀번호 바꾸기 — 방금 로그인한 idToken이어야 한다 (오래된 로그인이면 거부됨)
  const changePassword = async (apiKey, idToken, password) => session(await postJson(`${ep.auth}/accounts:update?key=${encodeURIComponent(apiKey)}`,
    { idToken, password, returnSecureToken: true }));

  // ---------- 읽기 / 쓰기 ----------

  async function request(method, dbUrl, path, data, idToken) {
    const res = await fetch(urlOf(dbUrl, path, { auth: idToken || null }), {
      method,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body;
  }

  const get = (dbUrl, path, idToken) => request('GET', dbUrl, path, undefined, idToken);
  // idToken이 없으면 로그인 없이 쓴다 (딜러 휴대폰의 퇴근 희망 답)
  const put = (dbUrl, path, data, idToken) => request('PUT', dbUrl, path, data, idToken);
  // 여러 곳을 한 번에 (키에 하위 경로, 값이 null이면 지움)
  const patch = (dbUrl, path, data, idToken) => request('PATCH', dbUrl, path, data, idToken);

  // 딜러 휴대폰 → 디렉터: 퇴근 희망 답. at은 서버 시각 (휴대폰 시계가 틀려도 순서가 맞게)
  const eoReply = (w, k) => ({ w: !!w, k: String(k), at: { '.sv': 'timestamp' } });
  const sendEoReply = (dbUrl, room, dealerId, w, k) =>
    put(dbUrl, `rooms/${encodeURIComponent(room)}/eo/${encodeURIComponent(dealerId)}`, eoReply(w, k));

  // 딜러 휴대폰 → 디렉터: 출근 체크 (출근 예정인 딜러만 — 보안 규칙이 p/{딜러id}/pl로 확인). at은 서버 시각
  const sendCheckIn = (dbUrl, room, dealerId) =>
    put(dbUrl, `rooms/${encodeURIComponent(room)}/ci/${encodeURIComponent(dealerId)}`, { at: { '.sv': 'timestamp' } });

  // Firebase 스트리밍 이벤트(put/patch)를 로컬 객체에 반영
  function applyEvent(obj, type, payload) {
    const parts = String(payload.path || '/').split('/').filter(Boolean);
    const setAt = (target, keys, value) => {
      if (!keys.length) return value;
      const base = target && typeof target === 'object' ? Object.assign({}, target) : {};
      const [k, ...rest] = keys;
      const next = setAt(base[k], rest, value);
      if (next === null || next === undefined) delete base[k];
      else base[k] = next;
      return base;
    };
    if (type === 'put') return setAt(obj, parts, payload.data);
    if (type === 'patch') {
      let out = obj;
      for (const [k, v] of Object.entries(payload.data || {})) out = setAt(out, parts.concat(k.split('/').filter(Boolean)), v);
      return out;
    }
    return obj;
  }

  // 방 구독 (지금은 디렉터 PC가 휴대폰 답 eo·출근 체크 ci만 받을 때 씀). onData(roomObject, {type, path}), onStatus('live' | 'reconnecting' | 'error')
  // sub를 주면 방 안의 그 부분만 (디렉터 PC가 휴대폰 답 eo·ci만 받을 때)
  // 휴대폰은 화면이 꺼지거나 통신망이 바뀌면 연결이 소리 없이 끊기기도 해서 직접 다시 잇는다:
  //  - 브라우저가 다시 잇지 않고 닫아 버리면(서버 오류 응답 등) 3초 뒤 새로 연결
  //  - 한동안 아무것도 안 오면 끊긴 것으로 보고 새로 연결 (방 전체는 디렉터가 30초마다 beat를 보냄)
  //  - 화면이 다시 켜졌을 때 오래 조용했으면 바로 새로 연결
  function subscribe(dbUrl, room, onData, onStatus, sub) {
    const url = urlOf(dbUrl, `rooms/${encodeURIComponent(room)}${sub ? '/' + sub : ''}`);
    const staleMs = sub ? 300000 : 75000;
    const doc = typeof document !== 'undefined' ? document : null;
    let data = null;
    let es = null;
    let lastAt = Date.now();
    let retry = null;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      clearTimeout(retry);
      if (es) es.close();
      lastAt = Date.now();
      es = new EventSource(url);
      const handle = type => e => {
        lastAt = Date.now();
        try {
          const payload = JSON.parse(e.data);
          data = applyEvent(data, type, payload);
          onData(data, { type, path: payload.path });
          onStatus('live');
        } catch (err) {
          onStatus('error');
        }
      };
      es.addEventListener('put', handle('put'));
      es.addEventListener('patch', handle('patch'));
      es.addEventListener('keep-alive', () => {
        lastAt = Date.now();
        onStatus('live');
      });
      es.addEventListener('cancel', () => onStatus('error'));
      es.onerror = () => {
        onStatus('reconnecting');
        if (es.readyState === 2) retry = setTimeout(connect, 3000); // 2 = CLOSED (브라우저가 포기함)
      };
    };
    const watchdog = setInterval(() => { if (Date.now() - lastAt > staleMs) connect(); }, 15000);
    const onVisible = () => { if (!doc.hidden && Date.now() - lastAt > 35000) connect(); };
    if (doc) doc.addEventListener('visibilitychange', onVisible);
    connect();
    return () => {
      stopped = true;
      clearInterval(watchdog);
      clearTimeout(retry);
      if (doc) doc.removeEventListener('visibilitychange', onVisible);
      es.close();
    };
  }

  // ---------- 이벤트 참가 코드 ----------
  // 사람이 불러 주고 받아 적는 코드라 헷갈리는 글자(I·O·0·1)를 뺀 대문자 8자.
  // 32^8 ≈ 1.1조 가지 — 코드를 아는 것이 곧 참가 자격이므로(딜러 방과 같은 방식) 짧게 만들지 말 것.
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 8;
  function shareCode() {
    const bytes = new Uint8Array(CODE_LEN);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  }
  // 받아 적은 코드 다듬기: 소문자·공백·붙임표를 받아 주고, 모양이 틀리면 null
  function normCode(v) {
    const c = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return c.length === CODE_LEN && [...c].every(ch => CODE_CHARS.includes(ch)) ? c : null;
  }
  // 보여 줄 때는 네 자씩 끊어서 (ABCD-EFGH)
  const codeText = c => (normCode(c) ? `${c.slice(0, 4)}-${c.slice(4)}` : '');

  // ---------- 보안 규칙 (database.rules.json과 같아야 함 — 테스트로 확인) ----------
  //  - admins/{uid}: true  판매자(관리자). 콘솔·CLI로만 넣는다
  //  - accounts/{uid}      DD 계정의 이름·이메일·이용 기간(until). 관리자만 쓰고, 본인은 읽기만
  //  - users/{uid}         그 계정의 이벤트(events = 목록, states = 내용)와 로그인한 PC(session). 본인만
  //  - rooms/{방}          딜러 휴대폰·TV 공유 (phoneview.js). 누구나 읽기(긴 방 id를 알아야), 쓰기는 방 주인만
  //  - shared/{코드}       이벤트 같이 쓰기. 코드를 아는 DD 계정이 스스로 들어오고, 들어온 계정끼리 같이 읽고 쓴다.
  //                        head = {rev, by, at, run} 작은 머리말(2초마다 이것만 읽는다), state = 이벤트 한 덩어리.
  //                        head/rev는 쓸 때마다 정확히 +1이어야 한다 → 둘이 동시에 쓰면 한쪽이 거부되고 다시 읽어 온다
  // 쓰기는 모두 이용 기간이 남은 계정만 (기간이 끝나면 공유·저장이 멈춘다)
  const ADMIN = "auth != null && root.child('admins').child(auth.uid).val() === true";
  const LICENSED = "root.child('accounts').child(auth.uid).child('until').val() > now";
  // 방에 올릴 수 있는 사람: 방 주인, 또는 그 방을 쓰는 이벤트를 같이 쓰는 계정
  //   (같이 쓰기에서 교대 시계를 가져간 쪽도 딜러 휴대폰·TV를 갱신해야 하므로)
  // 방 → 같이 쓰기 코드는 roomShare/{방}에 둔다 — rooms/{방}은 링크만 있으면 누구나 읽으므로 거기 두면 참가 코드가 새 나간다.
  // 그 코드의 주인이 방 주인과 같아야 한다 (코드가 지워진 뒤 다른 계정이 같은 코드로 새로 만들어 남의 방에 쓰는 것을 막는다)
  const SHARE_OF_ROOM = "root.child('roomShare').child($room).val()";
  const ROOM_SHARE = `(root.child('roomShare').child($room).exists() && `
    + `root.child('shared').child(${SHARE_OF_ROOM}).child('members').child(auth.uid).val() === true && `
    + `root.child('shared').child(${SHARE_OF_ROOM}).child('owner').val() === root.child('rooms').child($room).child('owner').val())`;
  const OWNER = `auth != null && (root.child('rooms').child($room).child('owner').val() === auth.uid || ${ROOM_SHARE}) && ${LICENSED}`;
  const ROOM_OWNER = "auth != null && root.child('rooms').child($room).child('owner').val() === auth.uid && " + LICENSED;
  // 이벤트 같이 쓰기: 코드가 8자 이상이고, 그 코드에 들어온 계정이어야 한다
  const MEMBER = "auth != null && $code.length >= 8 && root.child('shared').child($code).child('members').child(auth.uid).val() === true && " + LICENSED;
  // 같이 쓰기 통째로(만들기·끄기·다른 사람 빼기)는 주인만 — 들어온 계정은 머리말·내용·이름만 바꾼다 (지우기는 못 함)
  const SHARE_OWNER = "auth != null && $code.length >= 8 && root.child('shared').child($code).child('owner').val() === auth.uid && " + LICENSED;
  const RULES = {
    rules: {
      admins: {
        $uid: { '.read': 'auth != null && auth.uid === $uid' },
      },
      accounts: {
        '.read': ADMIN,
        $uid: {
          '.read': 'auth != null && auth.uid === $uid',
          '.write': ADMIN,
          '.validate': "newData.hasChildren(['email', 'name', 'until'])",
          email: { '.validate': 'newData.isString() && newData.val().length <= 100' },
          name: { '.validate': 'newData.isString() && newData.val().length <= 60' },
          until: { '.validate': 'newData.isNumber()' },
          createdAt: { '.validate': 'newData.isNumber()' },
          memo: { '.validate': 'newData.isString() && newData.val().length <= 200' },
          $other: { '.validate': false },
        },
      },
      users: {
        $uid: {
          '.read': 'auth != null && auth.uid === $uid',
          '.write': 'auth != null && auth.uid === $uid && ' + LICENSED,
          session: { '.read': ADMIN },
        },
      },
      // 이벤트 같이 쓰기 — 코드를 아는 DD 계정이 members에 스스로 들어온다 (딜러 방과 같은 방식)
      shared: {
        $code: {
          // 들어온 계정만 읽는다. 통째로 쓰기(지우기 포함)는 주인만, 처음 만들 때는 자기를 주인으로 적는 한 번만 허용
          '.read': MEMBER,
          '.write': `(${SHARE_OWNER}) || (auth != null && !data.exists() && newData.child('owner').val() === auth.uid && ${LICENSED})`,
          // 주인은 한 번 정해지면 안 바뀐다
          owner: { '.validate': 'newData.val() === (data.exists() ? data.val() : auth.uid)' },
          members: {
            // 코드를 아는 사람은 스스로 들어올 수 있다 (없는 코드로는 못 만든다). 빼는 건 주인도 가능
            $m: {
              '.write': `auth != null && auth.uid === $m && ${LICENSED} && root.child('shared').child($code).child('owner').exists()`,
              '.validate': `newData.isBoolean() && (auth.uid === $m || root.child('shared').child($code).child('owner').val() === auth.uid)`,
            },
          },
          // 머리말 — 2초마다 이것만 읽는다 (수십 바이트). 내용(state)은 rev가 바뀌었을 때만 받는다
          head: {
            '.write': `${MEMBER} && newData.exists()`,
            // 쓸 때마다 정확히 +1 — 둘이 동시에 쓰면 한쪽만 통과한다 (덮어쓰기로 로테이션이 날아가지 않게)
            rev: { '.validate': 'newData.isNumber() && (!data.exists() || newData.val() === data.val() + 1)' },
            by: { '.validate': 'newData.isString() && newData.val().length <= 60' },
            at: { '.validate': 'newData.isNumber()' },
            // 교대 시계를 돌리는 PC 하나 (둘 다 돌리면 교대가 두 번 된다). at이 한참 지나면 다른 쪽이 가져간다
            run: {
              '.validate': "newData.hasChildren(['uid', 'sid', 'at'])",
              uid: { '.validate': 'newData.isString() && newData.val().length <= 60' },
              sid: { '.validate': 'newData.isString() && newData.val().length <= 60' },
              at: { '.validate': 'newData.isNumber()' },
              $other: { '.validate': false },
            },
            $other: { '.validate': false },
          },
          state: { '.write': `${MEMBER} && newData.exists()`, '.validate': 'newData.isString() && newData.val().length <= 2000000' },
          name: { '.write': `${MEMBER} && newData.exists()`, '.validate': 'newData.isString() && newData.val().length <= 60' },
          at: { '.validate': 'newData.isNumber()' },
          // 딜러 QR 방 — 들어온 계정도 새 방을 만들지 않고 이 방을 같이 쓴다 (주인이 적는다)
          room: { '.validate': 'newData.isString() && newData.val().length >= 16 && newData.val().length <= 40' },
          $other: { '.validate': false },
        },
      },
      // 방 → 같이 쓰기 코드 (규칙만 읽는다 — 아무도 읽을 수 없다). 방 주인만 적는다
      roomShare: {
        $room: {
          '.write': `auth != null && root.child('rooms').child($room).child('owner').val() === auth.uid && ${LICENSED}`,
          '.validate': 'newData.isString() && newData.val().length >= 8 && newData.val().length <= 20',
        },
      },
      rooms: {
        $room: {
          '.read': '$room.length >= 16',
          // 새 방은 그 계정이 주인. 이미 있는 방은 관리자만 넘겨받을 수 있다 (계정 기능 전에 만든 방)
          owner: {
            '.write': `auth != null && newData.val() === auth.uid && ${LICENSED} && (!data.exists() || ${ADMIN})`,
          },
          // 예전에 여기 적던 같이 쓰기 코드 — 누구나 읽을 수 있는 자리라 이제 roomShare로 옮겼다. 방 주인이 지우기만 한다
          share: { '.write': ROOM_OWNER + ' && !newData.exists()' },
          // 휴대폰·TV용 (phoneview.js): 딜러별 p, 이름 목록, 전체 표, '바뀌었나' 확인 {v, at}
          p: { '.write': OWNER },
          names: { '.write': OWNER },
          sheet: { '.write': OWNER },
          pulse: {
            '.write': OWNER,
            '.validate': "newData.hasChildren(['v', 'at'])",
            v: { '.validate': 'newData.isNumber()' },
            at: { '.validate': 'newData.isNumber()' },
            $other: { '.validate': false },
          },
          // 퇴근 희망 답: 그 딜러에게 지금 열린 질문(p/{딜러id}/k — 받기 또는 묻기)에 대한 답만, 정해진 모양으로만 (로그인 없이)
          eo: {
            '.write': OWNER,
            $dealer: {
              '.write': "root.child('rooms').child($room).child('p').child($dealer).child('k').exists() && newData.child('k').val() === root.child('rooms').child($room).child('p').child($dealer).child('k').val()",
              '.validate': "$dealer.matches(/^d[0-9]+$/) && $dealer.length <= 8 && newData.hasChildren(['w', 'k', 'at'])",
              w: { '.validate': 'newData.isBoolean()' },
              k: { '.validate': 'newData.isString() && newData.val().length <= 20' },
              at: { '.validate': 'newData.isNumber() && newData.val() <= now' },
              $other: { '.validate': false },
            },
          },
          // 출근 체크: 지금 출근 예정인 딜러(p/{딜러id}/pl = 1)만, 서버 시각 하나로만 (로그인 없이)
          ci: {
            '.write': OWNER,
            $dealer: {
              '.write': "root.child('rooms').child($room).child('p').child($dealer).child('pl').val() === 1",
              '.validate': "$dealer.matches(/^d[0-9]+$/) && $dealer.length <= 8 && newData.hasChildren(['at'])",
              at: { '.validate': 'newData.isNumber() && newData.val() <= now' },
              $other: { '.validate': false },
            },
          },
          // 예전 형식(state·view·beat 등)은 방 주인이 지우기만 할 수 있다
          $old: { '.write': OWNER + ' && !newData.exists()' },
        },
      },
    },
  };

  // 실패 메시지를 사람이 알아들을 말로
  function explainError(msg) {
    const m = String(msg || '');
    if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/.test(m)) return '이메일 또는 비밀번호가 맞지 않습니다';
    if (/USER_DISABLED/.test(m)) return '사용이 정지된 계정입니다';
    if (/TOO_MANY_ATTEMPTS/.test(m)) return '로그인 시도가 너무 많습니다 — 잠시 뒤에 다시 해 주세요';
    if (/EMAIL_EXISTS/.test(m)) return '이미 있는 이메일입니다';
    if (/INVALID_EMAIL|MISSING_EMAIL/.test(m)) return '이메일 형식이 맞지 않습니다';
    if (/WEAK_PASSWORD|MISSING_PASSWORD/.test(m)) return '비밀번호는 6자 이상이어야 합니다';
    if (/CREDENTIAL_TOO_OLD|TOKEN_EXPIRED|INVALID_ID_TOKEN|USER_NOT_FOUND|INVALID_REFRESH_TOKEN/.test(m)) return '로그인이 만료되었습니다 — 다시 로그인해 주세요';
    if (/OPERATION_NOT_ALLOWED|ADMIN_ONLY_OPERATION|CONFIGURATION_NOT_FOUND/.test(m)) return '파이어베이스에서 이메일 로그인이 꺼져 있습니다 (판매자 설정 필요)';
    if (/Permission denied/i.test(m)) return '권한이 없습니다 — 이용 기간이 끝났거나 등록되지 않은 계정입니다';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '인터넷 연결을 확인해 주세요';
    return m;
  }

  return {
    normDb, dbHost, urlOf, randomId,
    setEndpoints, signIn, signUp, refreshToken, sendPasswordReset, changePassword,
    get, put, patch, eoReply, sendEoReply, sendCheckIn, applyEvent, subscribe, RULES, explainError,
    shareCode, normCode, codeText,
  };
});
