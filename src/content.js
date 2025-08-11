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

  function addMarker(seconds, tooltipText, linkEl) {
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
      // 元の <a> に合成クリックを送る（YouTube のハンドラを発火させる）
      if (linkEl) {
        try {
          const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 });
          linkEl.dispatchEvent(ev);
          return;
        } catch (err) {
          // フォールバックに進む
        }
      }

      // フォールバック: 直接シーク
      const vid = document.querySelector('video');
      if (!vid) return;
      const target = seconds;
      const buffered = isTimeBuffered(vid, target);
      if (buffered) {
        vid.currentTime = target;
        log('currentTime set (fallback)', { target, buffered });
      }
    });


    bar.appendChild(marker);
    log('Marker added', { seconds, percent: percent.toFixed(2), text: tooltipText });
  }

  /**
   * コメントノード内で、あるアンカーの直後から次のアンカー直前までのテキストを抜き出す
   * @param {HTMLElement} container コメント全体のコンテナ
   * @param {HTMLElement} startEl 範囲開始となるアンカー
   * @param {HTMLElement|null} endEl 次のタイムスタンプアンカー（無ければコメント末尾）
   * @returns {string}
   */
  function extractTextBetween(container, startEl, endEl) {
    try {
      const range = document.createRange();
      range.setStartAfter(startEl);
      if (endEl) {
        range.setEndBefore(endEl);
      } else {
        // container の末尾まで
        range.setEnd(container, container.childNodes.length);
      }
      return range.toString();
    } catch (_) {
      // 失敗時はコンテナ全文を返す
      return container.innerText || '';
    }
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

    // コメント内のタイムスタンプリンク(<a>)をすべて検出
    const anchors = Array.from(node.querySelectorAll('a'));
    const timeAnchors = [];
    for (const a of anchors) {
      const label = a.textContent?.trim() || '';
      const href = a.getAttribute('href') || '';
      const textMatch = label.match(timestampRegex);
      const hasTParam = /[?&#]t=|[?&#]start=/.test(href);
      if (!(textMatch || hasTParam)) continue;

      // 秒数の取得: テキスト優先、無ければ URL の t/start パラメータ
      let seconds = null;
      if (textMatch) {
        seconds = parseTimestamp(textMatch[1]);
      }
      if (seconds == null) {
        try {
          const url = new URL(href, location.href);
          const tParam = url.searchParams.get('t') || url.searchParams.get('start');
          if (tParam) {
            const parsed = (function parseYouTubeTimeParam(v) {
              // 例: 1h2m3s, 90s, 123
              const match = String(v).match(/^(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s)?$|^([0-9]+)$/);
              if (!match) return null;
              if (match[4]) return parseInt(match[4], 10);
              const h = parseInt(match[1] || '0', 10);
              const m = parseInt(match[2] || '0', 10);
              const s = parseInt(match[3] || '0', 10);
              return h * 3600 + m * 60 + s;
            })(tParam);
            if (Number.isFinite(parsed)) seconds = parsed;
          }
        } catch (_) {
          // ignore URL parse errors
        }
      }

      if (seconds != null) {
        timeAnchors.push({ anchor: a, seconds });
      }
    }

    if (timeAnchors.length === 0) return; // タイムスタンプが無い場合はスキップ

    // 各タイムスタンプごとに、次のタイムスタンプ直前までの文字列をツールチップにする
    for (let i = 0; i < timeAnchors.length; i++) {
      const current = timeAnchors[i];
      const next = timeAnchors[i + 1]?.anchor || null;
      const snippet = extractTextBetween(node, current.anchor, next).trim();
      const tooltipText = snippet || text.trim();
      log('Timestamp found via link', { seconds: current.seconds, comment: tooltipText.slice(0, 50) });
      addMarker(current.seconds, tooltipText, current.anchor);
    }
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

