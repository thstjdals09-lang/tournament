/*
 * 명령 입력칸 — 디렉터가 적은 말을 알아듣고 할 일 목록으로 바꾼다 (AI 없이 정해진 말투, 2026-10-24 사용자 요청).
 *   "3시부터 15분 간격으로 로테 돌게 해줘" · "1시에 7번 열어" · "7-9번 1시 사용" · "2번 1시 깨기" · "3번 2시 대기"
 *   "김민수 6시 출근" · "김민수, 이영희 퇴근" · "일시정지" · "재개" — 여러 개는 쉼표·줄바꿈으로
 *
 * parse(text, state, now) → { steps: [{desc, run(s, now) → s}], problems: [글], notes: [글] }
 *   steps는 앞에서부터 차례로 적용해 보며 설명을 만든다 (간격을 바꾼 뒤의 교대 시각으로 테이블 예약 시각을 보여 주게).
 *   앱은 [실행]을 누를 때 지금 state로 다시 parse 해서 steps.run을 차례로 적용한다 — 엔진 함수만 쓰므로 되돌리기도 된다.
 *   교대 때 하는 일은 '그 시각 이후 첫 교대'로 정한다 (run 할 때 다시 계산 — 그 사이 교대가 지나가도 시각 기준 그대로)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.DealerCommand = factory(root.DealerEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const MIN = E.MIN;
  const SLACK = 10 * MIN; // '3시'라고 3시 5분에 말해도 방금 지난 3시로 본다
  const hhmm = t => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const EXAMPLES = ['3시부터 15분 간격', '1시에 7번 열어', '7-9번 1시 사용', '2번 1시 깨기', '3번 2시 대기',
    '김민수 6시 출근', '김민수 퇴근', '일시정지', '재개'];

  // ---------- 시각 ----------
  // '15:00' · '3시' · '3시 반' · '3시 30분' · '오후 3시' · '오전 10시 30분' → {at, rest}. 오전·오후가 없으면 가장 가까운 앞으로의 시각
  const TIME_RE = /(오전|오후|아침|저녁|밤|낮|새벽)?\s*(?:(\d{1,2}):(\d{2})|(\d{1,2})\s*시(?:\s*(반|(\d{1,2})\s*분))?)/;
  function findTime(text, now) {
    const m = text.match(TIME_RE);
    if (!m) return null;
    const ampm = m[1] || '';
    const colon = m[2] != null;
    const h = Number(colon ? m[2] : m[4]);
    const min = colon ? Number(m[3]) : m[5] === '반' ? 30 : m[6] != null ? Number(m[6]) : 0;
    if (h > 24 || min > 59) return null;
    let hours;
    if (h >= 13 || (colon && /^0/.test(m[2]))) hours = [h % 24];          // 24시간제로 적은 것
    else if (/오후|저녁|밤|낮/.test(ampm)) hours = [h === 12 ? 12 : h + 12];
    else if (/오전|아침|새벽/.test(ampm)) hours = [h === 12 ? 0 : h];
    else hours = h === 12 ? [12, 0] : [h, h + 12];
    let best = null;
    for (const hh of hours) {
      const d = new Date(now);
      d.setHours(hh, min, 0, 0);
      let t = d.getTime();
      while (t < now - SLACK) t += 24 * 60 * MIN;
      if (best == null || t < best) best = t;
    }
    return { at: best, rest: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
  }

  // ---------- 조각 나누기 ----------
  const VERB_RE = /출근|퇴근|간격|마다|번|일시\s*정지|멈춰|정지|재개|다시\s*시작|교대|취소/;
  function splitClauses(text) {
    // 쉼표마다 나누고, 할 일이 없는 조각(숫자·이름만)은 뒤 조각과 다시 합친다 ('7, 8번 열어' · '김민수, 이영희 6시 출근')
    const parts = String(text || '').split(/\n|;|그리고|,/).map(x => x.trim()).filter(Boolean);
    const out = [];
    let carry = '';
    for (const p of parts) {
      if (!VERB_RE.test(p)) {
        carry = carry ? `${carry}, ${p}` : p;
        continue;
      }
      out.push(carry ? `${carry}, ${p}` : p);
      carry = '';
    }
    if (carry) out.push(carry);
    return out;
  }

  // 이름 목록: '김민수, 이영희' · '김민수님 이영희는' — 호칭·조사는 뗀다. '이·가'는 떼고 나서 아는 이름일 때만
  // (이름이 '…이'로 끝나는 사람도 있으므로 — 예: 김하이)
  function names(text, s) {
    const known = new Set(s.dealers.map(d => d.name).concat((s.roster || []).map(r => r.name)));
    return text.split(/[,\s]+/).map(w => {
      let x = w.trim().replace(/(님|씨)$/, '').replace(/(은|는|을|를|도)$/, '');
      if (!known.has(x) && /(이|가)$/.test(x) && known.has(x.slice(0, -1))) x = x.slice(0, -1);
      return x.replace(/(님|씨)$/, '');
    }).filter(w => w && !/^(오늘|지금|바로|좀|딜러|다시)$/.test(w));
  }

  const tableByNo = (s, no) => s.tables.find(t => t.no === no) || null;
  const isOpen = (s, no) => { const t = tableByNo(s, no); return !!t && t.status === 'open'; };

  // 그 시각 이후 첫 교대가 앞으로 몇 번째인지 (예정 표와 같은 계산). 없으면 null
  function slotOf(s, at, now) {
    if (!s.clock.running) return null;
    const slots = E.project(s, 40, now);
    const i = slots.findIndex(p => p.at >= at - 30000);
    return i < 0 ? null : { n: i + 1, at: slots[i].at };
  }

  // ---------- 해석 ----------
  function parse(text, state, now) {
    const steps = [];
    const problems = [];
    const notes = [];
    let cur = state;
    const add = (desc, run, kind) => {
      const next = run(cur, now);
      if (!next || next === cur) return false;
      steps.push({ desc, run, kind: kind || '' });
      cur = next;
      return true;
    };

    for (const clause of splitClauses(text)) {
      const tm = findTime(clause, now);
      const at = tm ? tm.at : null;
      const rest = tm ? tm.rest : clause;

      // 0) 예약 취소: '간격 예약 취소' · '7번 예약 취소'
      if (/취소/.test(rest)) {
        const tn = rest.match(/((?:\d+\s*(?:[-~]\s*\d+)?\s*,?\s*)+)\s*번/);
        if (tn) {
          const nos = E.parseNos(tn[1]);
          add(`${E.rangeText(nos)}번 테이블 예약 취소`, (s, t) => nos.reduce((x, no) => {
            const y = tableByNo(x, no);
            return y && y.sched ? E.unscheduleTable(x, y.id, t) : x;
          }, s)) || notes.push(`${E.rangeText(nos)}번에는 예약이 없습니다`);
        } else if (/간격/.test(rest)) {
          add('교대 간격 예약 취소', (s, t) => E.cancelIntervalPlan(s, t)) || notes.push('교대 간격 예약이 없습니다');
        } else {
          problems.push(`'${clause}' — 무엇을 취소할지 적어 주세요 (간격 예약 취소 · 7번 예약 취소)`);
        }
        continue;
      }

      // 1) 교대 간격: '15분 간격' · '15분마다' · '교대 간격 15분' · '3시부터 15분 간격으로 로테 돌게'
      const iv = rest.match(/(\d{1,3})\s*분\s*(?:간격|마다|씩|주기)/) || (/간격|교대|로테/.test(rest) ? rest.match(/(\d{1,3})\s*분/) : null);
      if (iv) {
        const m = Number(iv[1]);
        if (!(m >= 5 && m <= 120)) { problems.push(`'${clause}' — 교대 간격은 5~120분입니다`); continue; }
        if (!cur.clock.running) {
          add(`교대 간격 ${m}분 (설정 — 되돌리기 대상 아님)`, (s, t) => E.updateSettings(s, { pushMinutes: m }, t), 'setting') || notes.push(`교대 간격은 이미 ${m}분입니다`);
          if (at != null) notes.push(`로테이션 시작 전입니다 — ${hhmm(at)}에 [로테이션 시작]을 누르세요 (시작 시각을 적어도 됩니다)`);
          continue;
        }
        if (at == null && cur.settings.pushMinutes === m) { notes.push(`교대 간격은 이미 ${m}분입니다`); continue; }
        if (at != null && at > now + 60000) {
          const ok = add(`${hhmm(Math.round(at / (5 * MIN)) * 5 * MIN)}부터 교대 간격 ${m}분 — 그 시각에 교대하고 그 뒤 ${m}분마다`,
            (s, t) => E.scheduleInterval(s, at, m, t));
          if (!ok) problems.push(`'${clause}' — 그 시각으로는 간격을 예약할 수 없습니다`);
        } else {
          // 위쪽 교대 간격 칸에 숫자를 넣은 것과 같다 — 설정은 되돌리기 대상이 아니다 (CLAUDE.md 사용자 규칙)
          const ok = add(`지금부터 교대 간격 ${m}분 (설정 — 되돌리기 대상 아님, 숫자를 다시 넣으면 됩니다)`, (s, t) => E.updateSettings(s, { pushMinutes: m }, t), 'setting');
          if (!ok) notes.push(`교대 간격은 이미 ${m}분입니다`);
        }
        continue;
      }

      // 2) 일시정지 · 재개 (시각을 정한 일시정지는 하지 않는다 — 사용자가 '대회 브레이크 예약'은 원하지 않음)
      if (/일시\s*정지|멈춰|멈추|정지/.test(rest) || /재개|다시\s*시작|다시\s*돌/.test(rest)) {
        if (at != null) { problems.push(`'${clause}' — 시각을 정한 일시정지·재개는 하지 않습니다. 그때 [일시정지]를 눌러 주세요`); continue; }
        const resume = /재개|다시\s*시작|다시\s*돌/.test(rest);
        const ok = resume ? add('재개', (s, t) => E.resumeClock(s, t)) : add('일시정지', (s, t) => E.pauseClock(s, t));
        if (!ok) notes.push(resume ? '일시정지 중이 아닙니다' : '로테이션이 돌고 있지 않거나 이미 일시정지입니다');
        continue;
      }

      // 3) 테이블: '7번 열어' · '7-9번 1시 사용' · '2번 1시 깨기' · '3번 대기'
      const tb = rest.match(/((?:\d+\s*(?:[-~]\s*\d+)?\s*,?\s*)+)\s*번/);
      if (tb) {
        const nos = E.parseNos(tb[1]);
        const what = /깨|닫|폐쇄|클로즈/.test(rest) ? 'close' : /대기|사용\s*안|안\s*써|쉬게/.test(rest) ? 'idle'
          : /열|오픈|사용|시작|추가|투입/.test(rest) ? 'use' : null;
        if (!nos.length || !what) { problems.push(`'${clause}' — 테이블을 어떻게 할지 모르겠습니다 (열어 · 깨기 · 대기)`); continue; }
        const range = E.rangeText(nos);
        if (at == null) { // 지금 바로
          if (what === 'use') {
            add(`지금 ${range}번 테이블 사용 — 바로 딜러 투입`, (s, t) => {
              let x = s;
              const shut = nos.filter(no => !isOpen(x, no));
              if (shut.length) x = E.openTable(x, shut, t, { use: true });
              const idle = nos.map(no => tableByNo(x, no)).filter(y => y && y.status === 'open' && y.use === false).map(y => y.id);
              return idle.length ? E.setTableUse(x, idle, true, t) : x;
            }) || notes.push(`${range}번은 이미 사용 중입니다`);
          } else if (what === 'idle') {
            add(`지금 ${range}번 테이블 대기로 — 앉아 있던 딜러는 휴식`, (s, t) => {
              const ids = nos.map(no => tableByNo(s, no)).filter(y => y && y.status === 'open' && y.use !== false).map(y => y.id);
              return ids.length ? E.setTableUse(s, ids, false, t) : s;
            }) || notes.push(`${range}번은 사용 중인 테이블이 아닙니다`);
          } else {
            add(`지금 ${range}번 테이블 깨기`, (s, t) => nos.reduce((x, no) => (isOpen(x, no) ? E.closeTable(x, tableByNo(x, no).id, t) : x), s))
              || notes.push(`${range}번은 열린 테이블이 아닙니다`);
          }
          continue;
        }
        if (!cur.clock.running) { problems.push(`'${clause}' — 로테이션을 시작한 뒤에 교대 때로 예약할 수 있습니다`); continue; }
        const slot = slotOf(cur, at, now);
        if (!slot) { problems.push(`'${clause}' — 너무 먼 시각입니다 (앞으로 40번 교대 안)`); continue; }
        const when = `${hhmm(slot.at)} 교대${Math.abs(slot.at - at) > 60000 ? ` (${hhmm(at)} 뒤 첫 교대)` : ''}`;
        const run = (s, t) => {
          const sl = slotOf(s, at, t);
          if (!sl) return s;
          let x = s;
          if (what === 'use') {
            const shut = nos.filter(no => !isOpen(x, no));
            if (shut.length) x = E.openTable(x, shut, t, { use: false }); // 지금은 대기로 열어 두고 그 교대에 사용 시작
          }
          for (const no of nos) {
            const y = tableByNo(x, no);
            if (y && y.status === 'open') x = E.scheduleTable(x, y.id, sl.n, what, t);
          }
          return x;
        };
        const label = { use: '사용 시작', idle: '대기로', close: '깨기' }[what];
        const shutNow = what === 'use' ? nos.filter(no => !isOpen(cur, no)) : [];
        const ok = add(`${when}에 ${range}번 테이블 ${label}${shutNow.length ? ` (${E.rangeText(shutNow)}번은 지금 대기로 열어 둠)` : ''}`, run);
        if (!ok) problems.push(`'${clause}' — ${range}번은 ${what === 'use' ? '이미 사용 중입니다' : '열린 테이블이 아니거나 이미 그렇게 됩니다'}`);
        continue;
      }

      // 4) 출근 · 퇴근: '김민수 6시 출근' · '김민수, 이영희 퇴근'
      const ci = rest.match(/^(.*?)\s*(출근|퇴근)/);
      if (ci) {
        const who = names(ci[1], cur);
        if (!who.length) { problems.push(`'${clause}' — 누구인지 이름을 적어 주세요`); continue; }
        if (ci[2] === '퇴근') {
          if (at != null && at > now + SLACK) { problems.push(`'${clause}' — 퇴근 예약은 아직 없습니다. 그때 [퇴근]을 눌러 주세요`); continue; }
          for (const name of who) {
            add(`${name} 퇴근`, (s, t) => {
              const d = s.dealers.find(x => x.name === name && x.status !== 'off');
              if (!d) return s;
              return d.status === 'planned' ? E.removePlanned(s, d.id, t) : E.sendHome(s, d.id, t);
            }) || problems.push(`${name} — 출근해 있는 딜러가 아닙니다`);
          }
          continue;
        }
        for (const name of who) {
          const later = at != null && at > now;
          add(later ? `${name} ${hhmm(at)} 출근 예정` : `${name} 출근${at != null ? ` (${hhmm(at)})` : ''}`, (s, t) => {
            const d = s.dealers.find(x => x.name === name && x.status !== 'off') || s.dealers.find(x => x.name === name);
            const soon = at != null && at > t;
            if (d && d.status === 'planned') return soon ? E.setPlanAt(s, d.id, at, t) : E.checkInDealer(s, d.id, t, t);
            if (d && d.status !== 'off') return s;
            if (d) return soon ? E.setPlanAt(s, d.id, at, t) : E.checkBack(s, d.id, t);
            const r = (s.roster || []).find(x => x.name === name);
            return E.addDealers(s, [{ name, grade: (r && r.grade) || 'B', at }], t);
          }) || notes.push(`${name}은(는) 이미 출근해 있습니다`);
        }
        continue;
      }

      problems.push(`'${clause}' — 알아듣지 못했습니다`);
    }
    return { steps, problems, notes, examples: EXAMPLES };
  }

  // 같은 말을 지금 state에 실행 (실행 직전에 다시 parse — 그 사이 교대가 지나가도 시각 기준으로 다시 정한다)
  function run(text, state, now) {
    const res = parse(text, state, now);
    let s = state;
    for (const st of res.steps) s = st.run(s, now);
    return { state: s, res };
  }

  return { parse, run, findTime, splitClauses, EXAMPLES };
});
