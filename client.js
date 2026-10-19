/**
 * dsh-tts 的客户端一半：在输入框按钮排里塞一个「掐断朗读」按钮。
 *
 * 为什么在客户端做：host 侧的插件改不了 GUI 的 DOM，这排按钮归 Web 前端管。
 * 按钮只做一件事——GET http://127.0.0.1:9889/stop（index.js 起的本地旁路，
 * 只绑 127.0.0.1）。跨端口靠 host 那边回的 access-control-allow-origin。
 *
 * 定位策略是「克隆最左边那个圆形按钮」：白拿尺寸、边框、hover 和主题色，
 * 免得自己调 CSS 跟 DSH 的样式打架。React 重渲染把按钮冲掉时，
 * MutationObserver 会把它补回去。
 */
window.__ModuleLoader__.load({
  id: "@dsh-tts/speech",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    "use strict";

    var MOUNT_FLAG = "__DSH_TTS_STOP_MOUNTED__";
    var BTN_ATTR = "data-dsh-tts-stop";
    var STOP_URL = "http://127.0.0.1:9889/stop";
    var RETRY_MS = 120;

    var ICON =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M11 5 6 9H2v6h4l5 4V5z"/>' +
      '<line x1="22" y1="9" x2="16" y2="15"/>' +
      '<line x1="16" y1="9" x2="22" y2="15"/>' +
      "</svg>";

    var CSS = [
      "[" + BTN_ATTR + "] { transition: color .15s ease, opacity .15s ease; }",
      "[" + BTN_ATTR + "]:hover { color: #ff8f8f; }",
      "[" + BTN_ATTR + "][data-flash] { color: #ff6b6b !important; }",
      "[" + BTN_ATTR + "] svg { pointer-events: none; }",
    ].join("\n");

    function stopSpeech(btn) {
      var flash = function () {
        btn.setAttribute("data-flash", "1");
        setTimeout(function () { btn.removeAttribute("data-flash"); }, 420);
      };
      var url = STOP_URL + "?t=" + Date.now();
      fetch(url, { mode: "cors", cache: "no-store" }).then(flash, function () {
        // 跨域读不到就退回 opaque 请求：读不到响应，但请求照样落地
        fetch(url, { mode: "no-cors", cache: "no-store" }).then(flash, flash);
      });
    }

    function findSeat() {
      return document.querySelector("[data-composer-seat]");
    }

    // 最左边那个按钮 = 附件「+」。它右边通常跟着「⊘」，两者同属左侧按钮组。
    function leftmostButton(seat) {
      var btns = seat.querySelectorAll("button");
      var best = null;
      var bestLeft = Infinity;
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.hasAttribute(BTN_ATTR)) continue;
        var r = b.getBoundingClientRect();
        if (r.width < 16 || r.height < 16) continue;
        if (r.left < bestLeft) { bestLeft = r.left; best = b; }
      }
      return best;
    }

    function isButtonish(el) {
      if (!el) return false;
      if (el.tagName === "BUTTON") return true;
      return !!(el.querySelector && el.querySelector("button:not([" + BTN_ATTR + "])"));
    }

    // 从最左按钮往右走，跳过同组的按钮/容器，停在组尾
    function leftGroupTail(anchor) {
      var node = anchor;
      var last = anchor;
      var limit = window.innerWidth * 0.45;
      for (var guard = 0; guard < 8; guard++) {
        var next = node.nextElementSibling;
        if (!isButtonish(next)) break;
        var r = next.getBoundingClientRect();
        if (r.width < 1 || r.left > limit) break;
        last = next;
        node = next;
      }
      return last;
    }

    function makeButton(template) {
      var btn;
      try {
        btn = template.cloneNode(true);
      } catch (_e) {
        btn = document.createElement("button");
      }
      btn.setAttribute(BTN_ATTR, "1");
      btn.setAttribute("type", "button");
      btn.setAttribute("title", "掐断朗读");
      btn.setAttribute("aria-label", "掐断朗读");
      btn.innerHTML = ICON;
      if (btn.removeAttribute) {
        btn.removeAttribute("data-state");
        btn.removeAttribute("aria-pressed");
        btn.removeAttribute("disabled");
      }
      if (!btn.className) {
        btn.style.cssText =
          "width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;" +
          "justify-content:center;background:transparent;border:1px solid currentColor;" +
          "opacity:.72;cursor:pointer;padding:0;";
      }
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        stopSpeech(btn);
      });
      return btn;
    }

    function mount() {
      var seat = findSeat();
      if (!seat) return false;
      if (seat.querySelector("[" + BTN_ATTR + "]")) return true;
      var anchor = leftmostButton(seat);
      if (!anchor) return false;
      var btn = makeButton(anchor);
      var tail = leftGroupTail(anchor);
      try {
        if (tail.nextSibling) tail.parentNode.insertBefore(btn, tail.nextSibling);
        else tail.parentNode.appendChild(btn);
      } catch (_e) {
        anchor.after(btn);
      }
      return true;
    }

    function boot() {
      if (window[MOUNT_FLAG]) return;
      window[MOUNT_FLAG] = true;

      var styleEl = document.createElement("style");
      styleEl.setAttribute("data-dsh-tts-stop-style", "1");
      styleEl.textContent = CSS;
      (document.head || document.documentElement).appendChild(styleEl);

      var timer = 0;
      var tick = function () {
        timer = 0;
        try { mount(); } catch (_e) { /* 页面还没到时候，下一轮再说 */ }
      };
      var schedule = function () {
        if (timer) return;
        timer = setTimeout(tick, RETRY_MS);
      };

      schedule();
      var mo = new MutationObserver(schedule);
      mo.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
      window.addEventListener("resize", schedule);

      console.info("[dsh-tts] 掐音按钮已挂载");

      return function dispose() {
        mo.disconnect();
        window.removeEventListener("resize", schedule);
        if (timer) clearTimeout(timer);
        var btn = document.querySelector("[" + BTN_ATTR + "]");
        if (btn && btn.parentNode) btn.remove();
        if (styleEl.parentNode) styleEl.remove();
        try { delete window[MOUNT_FLAG]; } catch (_e) { window[MOUNT_FLAG] = false; }
      };
    }

    var inject = [];
    function apply() {
      try {
        return boot();
      } catch (error) {
        console.error("[dsh-tts] 掐音按钮启动失败：", error);
        return undefined;
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
