/* SPDX-License-Identifier: MIT
   Copyright (c) 2025 @Tagiyyy
*/
(function(){
  const DEBUG_KEY = 'ytcm_debug';
  const DEFAULT_DEBUG = false; // 通常利用ではコンソールを汚さない

  // デバッグ設定は localStorage に保存する。
  // content script はページと同一オリジンの localStorage を参照できるため、
  // chrome.storage (= "storage" 権限) を要求せずに設定を永続化できる。
  function readFlag() {
    try {
      const value = localStorage.getItem(DEBUG_KEY);
      if (value === null) return DEFAULT_DEBUG;
      return value === '1' || value === 'true';
    } catch (e) {
      // localStorage が使えない環境 (プライベートモード等) では既定値
      return DEFAULT_DEBUG;
    }
  }

  let enabled = readFlag();

  function log(...args) {
    if (!enabled) return;
    console.log('%c[YT-CM]', 'color:#ff4040;font-weight:bold;', ...args);
  }

  function setEnabled(value) {
    enabled = !!value;
    try {
      if (enabled) {
        localStorage.setItem(DEBUG_KEY, '1');
      } else {
        localStorage.removeItem(DEBUG_KEY);
      }
    } catch (e) {}
    return enabled;
  }

  window.YTCM_LOG = { log, setEnabled };
})();
