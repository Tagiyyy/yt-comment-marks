(function () {
  /** 現在の動画IDを取得 */
  function getVideoId() {
    const url = new URL(location.href);
    return url.searchParams.get('v');
  }
  const log = (window.YTCM_LOG && window.YTCM_LOG.log) ? window.YTCM_LOG.log : (...a)=>console.log('[YT-CM]', ...a);
  console.log('[YT-CM] content script injected');
  const COMMENT_CONTAINER_SELECTOR = '#comments #contents';
  const PROGRESS_BAR_SELECTOR = '.ytp-progress-bar';
  const COMMENT_TEXT_SELECTOR = '#content-text';

  // 00:12   1:23   1:23:45 などにマッチ
  const timestampRegex = /(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$)/;

  // 同じコメントを二重に処理しないためのセット
  let processedNodes = new WeakSet();

  /**
   * "1:23:45" のような文字列を秒数に変換
   * @param {string} ts
   * @returns {number|null}
   */
  function parseTimestamp(ts) {
    if (!ts) return null;
    const parts = ts.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 2) {
      // MM:SS
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      // HH:MM:SS
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return null;
  }

  /**
   * 指定した秒位置が既にバッファされているか
   * @param {HTMLVideoElement} video
   * @param {number} time
   * @returns {boolean}
   */
  function isTimeBuffered(video, time) {
    if (!video || !video.buffered) return false;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= time && time <= video.buffered.end(i)) {
        return true;
      }
    }
    return false;
  }

  /**
   * シークバーにマーカーを描画
   * @param {number} seconds
   * @param {string} tooltipText
   */
  let activeTooltip = null;
  let currentVideoId = getVideoId();

  function showTooltip(markerEl) {
    const text = markerEl.getAttribute('data-tooltip');
    if (!text) return;
    hideTooltip();
    const rect = markerEl.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.className = 'ytcm-tooltip';
    tip.textContent = text;
    document.body.appendChild(tip);
    // 位置計算
    const tipRect = tip.getBoundingClientRect();
    tip.style.left = `${rect.left + rect.width / 2}px`;
    tip.style.top = `${rect.top - 4}px`;
    activeTooltip = tip;
  }

  function hideTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  function addMarker(seconds, tooltipText) {
    const video = document.querySelector('video');
    if (!video) return;

    const duration = video.duration;
    if (!duration || seconds > duration) return;

    const bar = document.querySelector(PROGRESS_BAR_SELECTOR);
    if (!bar) return;

    const percent = (seconds / duration) * 100;

    // 既にほぼ同じ位置にマーカーがある場合はスキップ (重複描画防止)
    const existing = bar.querySelectorAll('.ytcm-marker');
    for (const el of existing) {
      const left = parseFloat(el.style.left);
      if (Math.abs(left - percent) < 0.2) return; // 0.2% 以内なら同一とみなす
    }

    const marker = document.createElement('div');
    marker.className = 'ytcm-marker';
    marker.style.left = `${percent}%`;
    marker.setAttribute('data-tooltip', tooltipText);
    marker.style.cursor = 'pointer';

    // クリックでシーク
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = document.querySelector('video');
      if (!vid) return;
      const target = seconds;
      const buffered = isTimeBuffered(vid, target);
      // シーク
      if (buffered) {
        vid.currentTime = target;
        log('currentTime set', { target, buffered });
      }
    });


    bar.appendChild(marker);
    log('Marker added', { seconds, percent: percent.toFixed(2), text: tooltipText });
  }

  /**
   * コメントノードを処理して、タイムスタンプが含まれていればマーカーを追加
   * @param {HTMLElement} node
   */
  function processCommentNode(node) {
    if (!node || processedNodes.has(node)) return;
    processedNodes.add(node);

    const text = node.innerText;
    if (!text) return;

    const match = text.match(timestampRegex);
    if (!match) return;

    const tsString = match[1];
    const seconds = parseTimestamp(tsString);
    log('Timestamp found', { tsString, seconds, comment: text.trim().slice(0, 50) });
    if (seconds == null) return;

    addMarker(seconds, text.trim());
  }

  /** 既に表示されているコメントを一括スキャン */
  function scanExistingComments() {
    const nodes = document.querySelectorAll(COMMENT_TEXT_SELECTOR);
    log('Scanning existing comments', nodes.length);
    nodes.forEach((node) => {
      processCommentNode(node);
    });
  }

  /** 指定 selector の要素が現れるまで待つユーティリティ */
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error('Element not found: ' + selector));
      }, timeout);
    });
  }

  /** コメント欄の後続読み込みに対応するための監視 */
  async function observeCommentSection() {
    let container;
    try {
      container = await waitForElement(COMMENT_CONTAINER_SELECTOR, 15000);
      log('Comment container found');
    } catch (e) {
      log('Comment container not found', e);
      return;
    }

    // 既存コメントをまずスキャン
    scanExistingComments();

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          // 追加ノード自身がコメントテキスト
          if (n.matches && n.matches(COMMENT_TEXT_SELECTOR)) {
            processCommentNode(n);
          }
          // 子孫にコメントテキストがある場合
          n.querySelectorAll?.(COMMENT_TEXT_SELECTOR).forEach((el) => processCommentNode(el));
        });
      }
    });

    observer.observe(container, { childList: true, subtree: true });
  }

  /** YouTube 視聴ページかどうか & コメント欄が存在するかを判定して初期化 */
  function cleanupMarkers() {
    document.querySelectorAll('.ytcm-marker').forEach((el) => el.remove());
    // reset processedNodes so comments will be re-parsed on new video
    processedNodes = new WeakSet();
  }

  function handleNavigation() {
    const vid = getVideoId();
    if (vid && vid !== currentVideoId) {
      log('Video changed', { from: currentVideoId, to: vid });
      currentVideoId = vid;
      cleanupMarkers();
      // コメント欄は SPA 遷移後に再構築されるため、少し遅延してスキャン
      setTimeout(scanExistingComments, 1000);
    }
  }

  window.addEventListener('yt-navigate-finish', handleNavigation);

  function init() {
    log('YT-CM init');
    if (!location.href.includes('youtube.com/watch')) return;

    // 動画のメタデータが読み込まれてから処理を開始
    const video = document.querySelector('video');
    if (video && video.readyState >= 1) {
      scanExistingComments();
    } else if (video) {
      video.addEventListener('loadedmetadata', scanExistingComments, { once: true });
    }

    observeCommentSection();
  }

  if (document.readyState !== 'loading') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();

