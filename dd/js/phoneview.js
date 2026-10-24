/*
 * 딜러 휴대폰·딜러룸 TV에 보낼 데이터 — 디렉터 PC가 미리 계산해서 방에 올린다. 받는 쪽은 엔진 계산 없이 그대로 그린다.
 * 파이어베이스 무료 요금제(내려받기 월 10GB) 안에서 딜러 수천 명이 보도록 겹치는 것 없이 최대한 작게:
 *
 *   rooms/{방}/p/{딜러id}  휴대폰 한 대가 30초마다 받는 것 전부 (요청 한 번, 보통 200바이트 안팎)
 *   rooms/{방}/names       이름 고르기용 {t: 이벤트 이름, d: {딜러id: 이름}} — 이름을 고를 때만
 *   rooms/{방}/sheet       전체 로테이션 표 — 딜러룸 TV, 휴대폰은 '전체 표 보기'를 열 때만
 *   rooms/{방}/pulse       {v: 마지막으로 바뀐 시각(ms), at} — TV가 15초마다 확인해서 v가 바뀌면 sheet를 받는다
 *
 * 시각: at = 디렉터 PC 시각(초). 다른 시각은 모두 at에서 몇 초 뒤(앞)인지로 (13자리 대신 몇 자리)
 * 자리: 테이블 번호, 0 = 휴식, -2 = 다른 업무, -1 = 그때는 없음(퇴근·아직 출근 전)
 * 0·빈 값은 보내지 않는다 (받는 쪽 norm*이 기본값을 채움)
 *
 * p/{딜러id}: 딜러가 보는 건 "지금 어디, 다음에 어디" 뿐이다 (2026-10-11 사용자 요청).
 *   일한 시간·쉰 시간·다른 사람 로테이션은 화면에 없을 뿐 아니라 아예 보내지 않는다.
 *   n 이름 · t 이벤트 이름 · at
 *   c 1 진행 중 / 2 일시정지 (없으면 시작 전) · w 교대 몇 분 전 알림 · nt 공지 [[초, 글]] (최근 3개) · bt 오늘 버튼 번호
 *   x 지금 자리 · ts 앞으로 가야 할 교대 시각 [초] · y 그때 내 자리 [ts와 같은 순서]
 *     (ts·y는 자리가 처음 바뀌는 한 번만 — 그 뒤 예정은 보내지 않는다. 안 바뀌면 둘 다 빈 배열)
 *   h 1 = 투입 보류
 *   k 지금 답할 수 있는 퇴근 희망 질문 id (나에게 온 묻기 → 모두에게 받기 순) · q 1 = 그게 나에게 온 묻기
 *   e 1 = 퇴근 희망 접수됨 · ea 디렉터가 반영한 내 답의 서버 시각(ms)
 *   pl 1 = 아직 출근 전 · pa 출근 예정 시각(초, 정해 둔 경우) · ci 1 = 출근 체크함(예정 시각에 투입) · tk 다른 업무 내용
 *   (보안 규칙은 p/{딜러id}/pl로 '이 딜러가 지금 출근 체크할 수 있나'를 확인한다)
 *   (보안 규칙도 p/{딜러id}/k로 '이 딜러가 지금 답할 수 있나'를 확인한다)
 * sheet:
 *   t · at · c · n 다음 교대까지 초(일시정지면 남은 시간) · w · nt · bt
 *   pc 지난 교대 시각 [초] · nc 지금 배치의 시각(초, 없으면 생략) · ts 예정 시각 [초]
 *   r 줄 [[딜러id, 이름, 등급, [자리 — 지난 것들, 지금, 예정들]]]
 * 휴대폰은 시간이 흐르면 바뀌는 값을 더 받지 않는다 — 남은 시간은 교대 시각(ts)에서 직접 센다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.DealerPhoneView = factory(root.DealerEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const FUTURE = 6; // 앞으로 보여 줄 교대 수
  const PAST = 3;   // 표에 보여 줄 지난 교대 수
  const place = v => (v === undefined ? -1 : v);
  const sec = ms => Math.round(ms / 1000);

  // 0·빈 값을 뺀 객체
  function compact(o) {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === 0 || v === '' || v == null || v === false || (Array.isArray(v) && !v.length)) continue;
      out[k] = v;
    }
    return out;
  }

  function build(s, title, now, v) { // v: pulse용 버전 (휴대폰 p에는 더 넣지 않는다)
    const c = s.clock;
    const at = sec(now);
    const rel = t => sec(t) - at; // 디렉터 시각(ms) → at에서 몇 초
    const slots = E.project(s, FUTURE, now);
    const snap = E.snapshot(s);
    const on = s.dealers.filter(x => x.status !== 'off'); // 출근 예정(출근 전)도 — 자기 이름을 미리 골라 둘 수 있게
    const cn = E.clockNow(s, now);
    const clock = c.running ? (c.paused ? 2 : 1) : 0;
    const ts = slots.map(p => rel(p.at));
    const nt = s.notices.slice(0, 3).map(n => [rel(n.at), n.text]);
    const callId = s.eoCall && s.eoCall.open ? s.eoCall.id : '';
    const head = { t: title || '', at, c: clock, w: s.settings.warnBeforeMinutes, nt, bt: s.button ? s.button.no : 0 };

    const p = {};
    for (const x of on) {
      const away = x.status === 'planned';
      // 딜러에게는 '지금 자리'와 '앞으로 가야 할 자리' 한 번만 보낸다 (사용자 요청)
      const mine = place(snap[x.id]);
      const chg = slots.find(q => place(q.a[x.id]) !== mine);
      p[x.id] = compact(Object.assign({ n: x.name }, head, {
        x: mine,
        ts: chg ? [rel(chg.at)] : [],
        y: chg ? [place(chg.a[x.id])] : [],
        h: x.hold ? 1 : 0,
        k: away ? '' : x.eoAsk || callId,
        q: x.eoAsk ? 1 : 0,
        e: x.earlyOut ? 1 : 0,
        ea: x.eoAt || 0,
        pl: away ? 1 : 0,
        pa: away && x.planAt != null ? rel(x.planAt) : null,
        ci: away && x.checkAt != null ? 1 : 0,
        tk: x.status === 'duty' ? x.task : '',
      }));
    }

    const hist = s.history;
    const past = hist.slice(Math.max(0, hist.length - 1 - PAST), Math.max(0, hist.length - 1));
    const cur = hist[hist.length - 1];
    const cols = past.map(h => h.a).concat([snap], slots.map(q => q.a));
    const sheet = compact({
      t: head.t,
      at,
      c: clock,
      n: c.running && c.nextPushAt != null ? sec(c.nextPushAt - cn) : 0,
      w: head.w,
      nt,
      bt: head.bt,
      pc: past.map(h => rel(h.at)),
      nc: cur ? rel(cur.at) : null,
      ts,
      r: on.map(x => [x.id, x.name, x.grade, cols.map(a => place(a[x.id]))]),
    });

    return {
      p,
      names: compact({ t: head.t, d: Object.fromEntries(on.map(x => [x.id, x.name])) }),
      sheet,
    };
  }

  // ---------- 받는 쪽 ----------

  const abs = (base, off) => (base.at + off) * 1000; // at 기준 초 → 디렉터 시각(ms)

  // 파이어베이스는 빈 배열 등을 저장하지 않고, 0·빈 값은 애초에 안 보냈다 → 기본값
  function normMe(m) {
    if (!m) return null;
    return Object.assign({ n: '', t: '', at: 0, c: 0, w: 0, x: 0, h: 0, k: '', q: 0, e: 0, ea: 0, pl: 0, pa: null, ci: 0, tk: '', bt: 0 }, m,
      { nt: m.nt || [], ts: m.ts || [], y: m.y || [] });
  }
  function normNames(n) {
    if (!n) return null;
    return { t: n.t || '', d: n.d || {} };
  }
  function normSheet(sh) {
    if (!sh) return null;
    return Object.assign({ t: '', at: 0, c: 0, n: 0, w: 0, nc: null, bt: 0 }, sh, {
      nt: sh.nt || [],
      pc: sh.pc || [],
      ts: sh.ts || [],
      r: (sh.r || []).map(r => [r[0], r[1], r[2], r[3] || []]),
    });
  }

  // 앞으로 내 자리가 처음 바뀌는 교대 [시각(ms), 자리] (디렉터가 그 한 번만 보낸다)
  function nextChange(me) {
    const i = me.y.findIndex(v => v !== me.x);
    return i < 0 ? null : [abs(me, me.ts[i]), me.y[i]];
  }

  // 저장해 둔 내 딜러 {id, 이름} → 지금 id (이벤트를 초기화해 id가 바뀌었으면 이름으로)
  function findName(names, saved) {
    if (!names || !saved) return null;
    if (names.d[saved.id] === saved.name) return saved.id;
    const hit = Object.entries(names.d).find(([, name]) => name === saved.name);
    return hit ? hit[0] : null;
  }

  // 표의 열: 지난 교대들, 지금, 예정들 → [{at(ms|null), kind: 'p'|'n'|'f'}]
  function sheetCols(sh) {
    return sh.pc.map(o => ({ at: abs(sh, o), kind: 'p' }))
      .concat([{ at: sh.nc == null ? null : abs(sh, sh.nc), kind: 'n' }], sh.ts.map(o => ({ at: abs(sh, o), kind: 'f' })));
  }

  // 다음 교대에 움직이는 사람 (딜러룸 TV) — 테이블 순, 들어가는 사람(어디서) → 쉬러 나가는 사람
  function nextMoves(sh) {
    if (!sh.ts.length) return null;
    const i = sh.pc.length; // 지금 열
    const tables = {};
    for (const [, name, , cells] of sh.r) {
      const a = cells[i];
      const b = cells[i + 1];
      if (a === b) continue;
      if (b > 0) (tables[b] = tables[b] || { no: b, in: [], out: [] }).in.push({ name, from: a });
      else if (a > 0) (tables[a] = tables[a] || { no: a, in: [], out: [] }).out.push({ name });
    }
    return { at: abs(sh, sh.ts[0]), tables: Object.values(tables).sort((x, y) => x.no - y.no) };
  }

  return { FUTURE, PAST, build, abs, normMe, normNames, normSheet, nextChange, findName, sheetCols, nextMoves };
});
