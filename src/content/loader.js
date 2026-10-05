// 自动加载：替用户往下滚，攒够样本。对风控友好是第一原则：
//   · 只做普通的程序滚动（产生的是可信的 scroll 事件），绝不伪造鼠标滚轮等输入事件
//   · 随机间隔，每 5 轮多歇一会儿；有上限
//   · 发现登录墙 / 验证码立即停，说人话，不自动重试
//   · 切页面、标签页切到后台时停
// 决策逻辑 decide() 是纯函数，便于单测；计时与滚动由 create() 驱动。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});

  const STALL_TICKS = 6;   // 连续多少轮没有新数据算"卡住"
  const END_TICKS = 2;     // 接口已说没有更多，再确认几轮

  // obs：{ count, cap, blocked, hasMore }；st：{ last, still }
  // 返回 { action: 'continue' | 'stop', reason?, st }
  function decide(st, obs) {
    const next = { last: obs.count, still: obs.count === st.last ? st.still + 1 : 0 };
    if (obs.blocked) return { action: 'stop', reason: obs.blocked === 'captcha' ? 'captcha' : 'login', st: next };
    if (obs.count >= obs.cap) return { action: 'stop', reason: 'cap', st: next };
    if (obs.hasMore === false && next.still >= END_TICKS) return { action: 'stop', reason: 'end', st: next };
    if (next.still >= STALL_TICKS) return { action: 'stop', reason: 'stalled', st: next };
    return { action: 'continue', st: next };
  }

  // 结束原因 → 给人看的话
  const REASONS = {
    cap: (n) => `已加载 ${n} 条，达到上限`,
    end: (n) => `已经到底了，共 ${n} 条`,
    stalled: (n) => `连续几次没有新结果（已 ${n} 条）。可以手动往下滚一下再试`,
    login: (n) => `抖音要求登录才能继续加载（已 ${n} 条）。登录后再点"继续加载"`,
    captcha: (n) => `抖音弹出了安全验证（已 ${n} 条）。请先手动完成验证`,
    user: (n) => `已停止，共 ${n} 条`,
    route: () => '',
    hidden: (n) => `页面切到后台，已暂停（已 ${n} 条）`,
  };

  // opts：{ count(), scroll(round), blocked(), hasMore(), cap(), onChange(state), delay: [min,max] }
  function create(opts) {
    const L = { running: false, reason: '', round: 0, startCount: 0, timer: 0, st: { last: -1, still: 0 } };
    const delay = opts.delay || [1800, 3600];

    function emit() { if (opts.onChange) opts.onChange(L); }
    function stop(reason) {
      if (!L.running) return;
      L.running = false;
      L.reason = reason || 'user';
      clearTimeout(L.timer);
      emit();
    }
    function tick() {
      if (!L.running) return;
      const obs = { count: opts.count(), cap: opts.cap(), blocked: opts.blocked(), hasMore: opts.hasMore ? opts.hasMore() : undefined };
      const r = decide(L.st, obs);
      L.st = r.st;
      if (r.action === 'stop') return stop(r.reason);
      try { opts.scroll(L.round++); } catch (e) { /* 滚动失败不致命，下一轮再试 */ }
      emit();
      let wait = delay[0] + Math.random() * (delay[1] - delay[0]);
      if (L.round % 5 === 0) wait += 1500 + Math.random() * 1500; // 每 5 轮多歇一会儿，节奏更像人
      L.timer = setTimeout(tick, wait);
    }
    L.start = function () {
      if (L.running) return;
      L.running = true;
      L.reason = '';
      L.round = 0;
      L.startCount = opts.count();
      L.st = { last: -1, still: 0 };
      emit();
      tick();
    };
    L.stop = stop;
    L.message = () => (REASONS[L.reason] ? REASONS[L.reason](opts.count()) : '');
    return L;
  }

  // 通用的"往下滚"：窗口滚到底 → 把最后一张卡滚进视野 → 找可滚动的祖先滚到底；
  // 每隔一轮先往回滚一点再滚到底，让"到底才加载"的触发器重新感知到进入视野
  // 对"真正在滚动的那个元素"操作（可能是某个容器、body 或 html），window.scrollTo 只作补充
  function scrollToEnd(lastEl, round) {
    const sc = (lastEl && DSP.adapters && DSP.adapters.scrollerOf(lastEl)) || document.scrollingElement || document.documentElement;
    const toEnd = () => {
      sc.scrollTop = sc.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      if (lastEl && lastEl.isConnected) lastEl.scrollIntoView({ block: 'end' });
    };
    if (round % 2 === 1) {
      sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - 700);
      setTimeout(toEnd, 160);
    } else toEnd();
  }

  DSP.loader = { decide, create, scrollToEnd, REASONS, STALL_TICKS };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') module.exports = DSP.loader;
})();
