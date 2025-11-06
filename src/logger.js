/* SPDX-License-Identifier: MIT
   Copyright (c) 2025 @Tagiyyy
*/
(function(){
  const DEBUG_KEY = 'ytcm_debug';
  const DEFAULT_DEBUG = true;
  let enabled = DEFAULT_DEBUG;

  // 可能存在しない場合があるので try-catch
  try {
    chrome.storage.sync.get([DEBUG_KEY], (res) => {
      if (typeof res[DEBUG_KEY] === 'boolean') {
        enabled = res[DEBUG_KEY];
      }
    });
  } catch (e) {
    // chrome.storage が使えない環境 (テスト環境) など
  }

  function log(...args) {
    if (!enabled) return;
    console.log('%c[YT-CM]', 'color:#ff4040;font-weight:bold;', ...args);
  }

  function setEnabled(value) {
    enabled = !!value;
    try {
      chrome.storage.sync.set({ [DEBUG_KEY]: enabled });
    } catch (e) {}
  }

  window.YTCM_LOG = { log, setEnabled };
})();
