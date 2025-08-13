(function () {
  /** 現在の動画IDを取得 */
  function getVideoId() {
    const url = new URL(location.href);
    return url.searchParams.get('v');
  }
  const log = (window.YTCM_LOG && window.YTCM_LOG.log) ? window.YTCM_LOG.log : (...a)=>console.log('[YT-CM]', ...a);
  
  log('content script injected');
  const COMMENT_CONTAINER_SELECTOR = '#comments #contents';
  const PROGRESS_BAR_SELECTOR = '.ytp-progress-bar';
  const COMMENT_TEXT_SELECTOR = '#content-text';

  // 00:12   1:23   1:23:45 などにマッチ
  const timestampRegex = /(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$)/;

  // 同じコメントを二重に処理しないためのセット
  let processedNodes = new WeakSet();
  let commentObserver = null;

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
  let currentVideoId = getVideoId();

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
      if (startEl) {
        range.setStartAfter(startEl);
      } else {
        range.setStart(container, 0);
      }
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

  // 行単位でアンカーに最も近い行を取得
  function nearestLine(snippet, side) {
    if (!snippet) return '';
    const lines = snippet
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return '';
    return side === 'before' ? lines[lines.length - 1] : lines[0];
  }

  // アンカーと同じ行にテキストがあるかを判定
  function hasSameLineTextBefore(rawBefore) {
    if (!rawBefore) return false;
    const segment = rawBefore.split(/\r?\n/).pop() || '';
    return segment.trim().length > 0;
  }

  function hasSameLineTextAfter(rawAfter) {
    if (!rawAfter) return false;
    const segment = rawAfter.split(/\r?\n/)[0] || '';
    return segment.trim().length > 0;
  }

  // before/after から採用するテキストを選択（"同じ行" を最優先）
  function pickSnippet(beforeLine, afterLine, sameBefore, sameAfter) {
    const beforePreview = (beforeLine || '').slice(0, 80);
    const afterPreview = (afterLine || '').slice(0, 80);

    // まず "同じ行" 判定で決定
    if (sameAfter && !sameBefore) {
      log('pickSnippet: choose after (same line)', {
        sameBefore,
        sameAfter,
        beforeLen: (beforeLine || '').length,
        afterLen: (afterLine || '').length,
        beforePreview,
        afterPreview,
      });
      return afterLine;
    }
    if (sameBefore && !sameAfter) {
      log('pickSnippet: choose before (same line)', {
        sameBefore,
        sameAfter,
        beforeLen: (beforeLine || '').length,
        afterLen: (afterLine || '').length,
        beforePreview,
        afterPreview,
      });
      return beforeLine;
    }
    if (sameBefore && sameAfter) {
      log('pickSnippet: choose after (both same line)', {
        sameBefore,
        sameAfter,
        beforeLen: (beforeLine || '').length,
        afterLen: (afterLine || '').length,
        beforePreview,
        afterPreview,
      });
      return afterLine; // 同行が両方ある場合は after を優先
    }

    // 同じ行に該当が無い場合のフォールバック
    if (afterLine && !beforeLine) {
      log('pickSnippet: choose after (fallback, before empty)', {
        sameBefore,
        sameAfter,
        beforeLen: 0,
        afterLen: afterLine.length,
        beforePreview,
        afterPreview,
      });
      return afterLine;
    }
    if (beforeLine && !afterLine) {
      log('pickSnippet: choose before (fallback, after empty)', {
        sameBefore,
        sameAfter,
        beforeLen: beforeLine.length,
        afterLen: 0,
        beforePreview,
        afterPreview,
      });
      return beforeLine;
    }
    if (!beforeLine && !afterLine) {
      log('pickSnippet: choose empty (fallback, both empty)', { sameBefore, sameAfter });
      return '';
    }

    log('pickSnippet: choose after (fallback, both present)', {
      sameBefore,
      sameAfter,
      beforeLen: beforeLine.length,
      afterLen: afterLine.length,
      beforePreview,
      afterPreview,
    });
    return afterLine;
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

    // 各タイムスタンプごとに、前後いずれか“近い行”をツールチップに採用
    for (let i = 0; i < timeAnchors.length; i++) {
      const prev = timeAnchors[i - 1]?.anchor || null;
      const current = timeAnchors[i];
      const next = timeAnchors[i + 1]?.anchor || null;

      const beforeRaw = extractTextBetween(node, prev, current.anchor);
      const afterRaw = extractTextBetween(node, current.anchor, next);

      const beforeLine = nearestLine(beforeRaw, 'before');
      const afterLine = nearestLine(afterRaw, 'after');

      const sameBefore = hasSameLineTextBefore(beforeRaw);
      const sameAfter = hasSameLineTextAfter(afterRaw);

      const chosen = pickSnippet(beforeLine, afterLine, sameBefore, sameAfter);

      const tooltipText = chosen || text.trim();
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
    // 既存の監視を解除してから張り直す
    commentObserver?.disconnect();
    commentObserver = null;

    let container;
    try {
      container = await waitForElement(COMMENT_CONTAINER_SELECTOR, 30000);
      log('Comment container found');
    } catch (e) {
      log('Comment container not found, retrying...', e?.message || e);
      setTimeout(observeCommentSection, 2000);
      return;
    }

    // まず現状をスキャン
    scanExistingComments();

    commentObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.matches?.(COMMENT_TEXT_SELECTOR)) processCommentNode(n);
          n.querySelectorAll?.(COMMENT_TEXT_SELECTOR).forEach((el) => processCommentNode(el));
        });
      }
    });

    commentObserver.observe(container, { childList: true, subtree: true });
  }

  function waitVideoReadyThenScan() {
    const tryOnce = () => {
      const video = document.querySelector('video');
      if (video && (video.readyState >= 1 || Number.isFinite(video.duration))) {
        scanExistingComments();
      } else if (video) {
        video.addEventListener('loadedmetadata', scanExistingComments, { once: true });
      } else {
        requestAnimationFrame(tryOnce);
      }
    };
    tryOnce();
  }

  function boot() {
    // URL が watch でなくても監視の張り直しは許可（実際にヒットしなければ何も起きない）
    observeCommentSection();
    waitVideoReadyThenScan();
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
      boot();
    }
  }

  window.addEventListener('yt-navigate-finish', handleNavigation);

  function init() {
    log('YT-CM init');
    boot();
  }

  if (document.readyState !== 'loading') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();

