/* SPDX-License-Identifier: MIT
   Copyright (c) 2025 @Tagiyyy
*/
(function () {
  /** 現在の動画IDを取得 */
  function getVideoId() {
    try {
      return new URL(location.href).searchParams.get('v');
    } catch (_) {
      return null;
    }
  }

  /** 視聴ページかどうか（それ以外では監視・待機を一切行わない） */
  function isWatchPage() {
    return location.pathname === '/watch';
  }

  const log = (window.YTCM_LOG && window.YTCM_LOG.log) ? window.YTCM_LOG.log : (...a)=>console.log('[YT-CM]', ...a);

  log('content script injected');
  const COMMENT_CONTAINER_SELECTOR = '#comments #contents';
  const COMMENT_TEXT_SELECTOR = '#content-text';
  const COMMENT_WAIT_TIMEOUT = 30000; // コメント欄の出現を待つ最大時間
  const COMMENT_RETRY_INTERVAL = 2000; // コメント欄が見つからない場合の再試行間隔
  const COMMENT_RETRY_LIMIT = 5; // 無限リトライを避けるための上限
  const VIDEO_WAIT_TIMEOUT = 30000; // <video> の出現を待つ最大時間
  const VIDEO_POLL_INTERVAL = 500; // <video> 探索のポーリング間隔

  // 00:12   1:23   1:23:45 などにマッチ
  const timestampRegex = /(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$)/;

  // 処理済みコメント。値は処理時点のテキスト。
  // YouTube はスクロール時にコメント要素を使い回すことがあるため、
  // 「ノードが同じでもテキストが変われば再処理する」形にしておく。
  let processedNodes = new WeakMap();
  let commentObserver = null;
  let commentRetryTimer = null;
  let commentRetryCount = 0;
  let videoWaitTimer = null;
  let watchedVideo = null;
  // マーカーを描画したときの動画の長さ（これが変わったら描き直す）
  let lastRenderedDuration = 0;
  // ページ遷移をまたいだ非同期処理を無効化するための世代番号
  let bootToken = 0;
  let currentVideoId = getVideoId();

  /**
   * "1:23:45" のような文字列を秒数に変換
   * @param {string} ts
   * @returns {number|null}
   */
  function parseTimestamp(ts) {
    if (!ts) return null;
    const parts = ts.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
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
   * YouTube の t / start パラメータを秒数に変換
   * 例: 1h2m3s, 90s, 123
   * @param {string} value
   * @returns {number|null}
   */
  function parseYouTubeTimeParam(value) {
    const match = String(value).match(/^(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s)?$|^([0-9]+)$/);
    if (!match) return null;
    if (match[4]) return parseInt(match[4], 10);
    // 空文字にマッチしただけの場合は無効扱い
    if (!match[1] && !match[2] && !match[3]) return null;
    const h = parseInt(match[1] || '0', 10);
    const m = parseInt(match[2] || '0', 10);
    const s = parseInt(match[3] || '0', 10);
    return h * 3600 + m * 60 + s;
  }

  /**
   * リンクが現在再生中の動画を指しているか
   * 別の動画・外部サイトへのリンクは、このシークバー上の位置とは無関係なので除外する
   * @param {URL} url
   * @returns {boolean}
   */
  function isSameVideoLink(url) {
    const videoId = getVideoId();
    if (!videoId) return false;
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') {
      return url.pathname.replace(/^\//, '') === videoId;
    }
    if (host !== 'youtube.com') return false;
    const v = url.searchParams.get('v');
    // v を持たないリンク（ページ内アンカーなど）は現在の動画とみなす
    return !v || v === videoId;
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

  /** 広告再生中かどうか（広告中は duration が広告のものになる） */
  function isAdShowing() {
    return !!document.querySelector('.html5-video-player.ad-showing');
  }

  /**
   * シークバーにマーカーを描画
   * @param {number} seconds
   * @param {string} tooltipText
   * @param {HTMLAnchorElement|null} linkEl
   * @returns {boolean} false の場合は「まだ描画できない」ので後で再試行する
   */
  function addMarker(seconds, tooltipText, linkEl) {
    const video = document.querySelector('video');
    if (!video) return false;

    const duration = video.duration;
    // メタデータ未読み込み (NaN/0) やライブ配信 (Infinity) では位置を計算できない
    if (!Number.isFinite(duration) || duration <= 0) return false;

    // 広告再生中は duration が広告の長さなので、正しい位置を計算できない
    if (isAdShowing()) return false;

    const bar = document.querySelector('.ytp-progress-bar');
    if (!bar) return false;

    // 動画長を超えるタイムスタンプはこの動画では描画対象外（再試行しても変わらない）
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration) return true;

    const percent = (seconds / duration) * 100;

    // 既にほぼ同じ位置にマーカーがある場合はスキップ (重複描画防止)
    const existing = bar.querySelectorAll('.ytcm-marker');
    for (const el of existing) {
      const left = parseFloat(el.style.left);
      if (Math.abs(left - percent) < 0.2) return true; // 0.2% 以内なら同一とみなす
    }

    const marker = document.createElement('div');
    marker.className = 'ytcm-marker';
    marker.style.left = `${percent}%`;
    marker.style.cursor = 'pointer';
    marker.tabIndex = 0;
    marker.setAttribute('role', 'button');
    marker.setAttribute('aria-label', tooltipText);

    const tooltip = document.createElement('div');
    tooltip.className = 'ytcm-tooltip';
    tooltip.textContent = tooltipText;
    marker.appendChild(tooltip);

    const adjustTooltipPosition = () => {
      tooltip.style.removeProperty('--ytcm-shift');
      const rect = tooltip.getBoundingClientRect();
      if (!rect || !rect.width) return;
      const margin = 12;
      const container =
        marker.closest('.html5-video-player') ||
        marker.closest('.ytp-chrome-bottom') ||
        document.querySelector('.html5-video-player');
      const containerRect = container?.getBoundingClientRect();
      if (!containerRect) return;

      const minLeft = containerRect.left + margin;
      const maxRight = containerRect.right - margin;
      let shift = 0;
      if (rect.left < minLeft) {
        shift = minLeft - rect.left;
      } else if (rect.right > maxRight) {
        shift = maxRight - rect.right;
      }
      if (shift !== 0) {
        tooltip.style.setProperty('--ytcm-shift', `${shift}px`);
      }
    };

    const resetTooltipShift = () => {
      tooltip.style.removeProperty('--ytcm-shift');
    };

    marker.addEventListener('mouseenter', adjustTooltipPosition);
    marker.addEventListener('focus', adjustTooltipPosition);
    marker.addEventListener('touchstart', adjustTooltipPosition, { passive: true });
    marker.addEventListener('mouseleave', resetTooltipShift);
    marker.addEventListener('blur', resetTooltipShift);

    // シークバー本体のドラッグシークが同時に走らないように止める
    const stopEvent = (e) => e.stopPropagation();
    marker.addEventListener('mousedown', stopEvent);
    marker.addEventListener('pointerdown', stopEvent);

    // クリックでシーク
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      marker.blur();
      // 元の <a> に合成クリックを送る（YouTube のハンドラを発火させる）
      if (linkEl && linkEl.isConnected) {
        try {
          const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 });
          linkEl.dispatchEvent(ev);
          return;
        } catch (err) {
          // フォールバックに進む
        }
      }

      // フォールバック: 直接シーク（未バッファの位置でもシーク自体は可能）
      const vid = document.querySelector('video');
      if (!vid) return;
      try {
        vid.currentTime = seconds;
        log('currentTime set (fallback)', { seconds, buffered: isTimeBuffered(vid, seconds) });
      } catch (err) {
        log('seek failed', err?.message || err);
      }
    });

    bar.appendChild(marker);
    log('Marker added', { seconds, percent: percent.toFixed(2), text: tooltipText });
    return true;
  }

  /**
   * コメントノード内で、あるアンカーの直後から次のアンカー直前までのテキストを抜き出す
   * 改行 (<br>) は改行文字へ変換し、行単位の判定ができるようにする
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
      const fragment = range.cloneContents();
      // Range.toString() は <br> を無視するため、明示的に改行へ置き換える
      fragment.querySelectorAll('br').forEach((br) => {
        br.replaceWith(document.createTextNode('\n'));
      });
      return fragment.textContent || '';
    } catch (_) {
      // 失敗時はコンテナ全文を返す
      return container.innerText || container.textContent || '';
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
    if (!node) return;

    // innerText はレイアウトを強制するため、判定にはコストの低い textContent を使う
    const text = node.textContent || '';
    if (!text.trim()) return;
    if (processedNodes.get(node) === text) return;

    // コメント内のタイムスタンプリンク(<a>)をすべて検出
    const anchors = Array.from(node.querySelectorAll('a'));
    const timeAnchors = [];
    for (const a of anchors) {
      const label = a.textContent?.trim() || '';
      const href = a.getAttribute('href') || '';

      let linkUrl = null;
      if (href) {
        try {
          linkUrl = new URL(href, location.href);
        } catch (_) {
          continue; // URL として解釈できないリンクは無視
        }
      }
      // 別の動画や外部サイトへのリンクは対象外（現在のシークバー上の位置と対応しないため）
      if (linkUrl && !isSameVideoLink(linkUrl)) continue;

      const textMatch = label.match(timestampRegex);
      const tParam = linkUrl ? (linkUrl.searchParams.get('t') || linkUrl.searchParams.get('start')) : null;
      if (!textMatch && !tParam) continue;

      // 秒数の取得: テキスト優先、無ければ URL の t/start パラメータ
      let seconds = textMatch ? parseTimestamp(textMatch[1]) : null;
      if (seconds == null && tParam) {
        const parsed = parseYouTubeTimeParam(tParam);
        if (parsed != null) seconds = parsed;
      }

      if (seconds != null) {
        timeAnchors.push({ anchor: a, seconds });
      }
    }

    if (timeAnchors.length === 0) {
      processedNodes.set(node, text); // タイムスタンプが無いコメントは再走査不要
      return;
    }

    // 各タイムスタンプごとに、前後いずれか“近い行”をツールチップに採用
    let allRendered = true;
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
      if (!addMarker(current.seconds, tooltipText, current.anchor)) {
        allRendered = false;
      }
    }

    // 動画メタデータ待ちなどで描画できなかった場合は処理済みにせず、次回の走査で再試行する
    if (allRendered) {
      processedNodes.set(node, text);
    }
  }

  /** 既に表示されているコメントを一括スキャン */
  function scanExistingComments() {
    const duration = document.querySelector('video')?.duration;
    // どの長さを基準に描画したかを覚えておく（長さが変われば描き直しが必要）
    if (Number.isFinite(duration) && duration > 0) lastRenderedDuration = duration;
    const nodes = document.querySelectorAll(COMMENT_TEXT_SELECTOR);
    log('Scanning existing comments', nodes.length);
    nodes.forEach((node) => {
      processCommentNode(node);
    });
  }

  /**
   * マーカーを全て描き直す
   * 動画の長さが変わると既存マーカーの位置は基準がずれてしまうため、
   * 一度片付けてから描画し直す
   */
  function rescanAll(reason) {
    log('Rescan triggered', reason);
    cleanupMarkers();
    scanExistingComments();
  }

  /** 指定 selector の要素が現れるまで待つユーティリティ */
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      let timer = null;
      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Element not found: ' + selector));
      }, timeout);
    });
  }

  /** コメント欄の後続読み込みに対応するための監視 */
  async function observeCommentSection(token) {
    // 既存の監視を解除してから張り直す
    commentObserver?.disconnect();
    commentObserver = null;

    let container;
    try {
      container = await waitForElement(COMMENT_CONTAINER_SELECTOR, COMMENT_WAIT_TIMEOUT);
      log('Comment container found');
    } catch (e) {
      if (token !== bootToken) return; // 待機中にページが変わっていた
      if (commentRetryCount >= COMMENT_RETRY_LIMIT) {
        log('Comment container not found, giving up');
        return;
      }
      commentRetryCount++;
      log('Comment container not found, retrying...', e?.message || e);
      clearTimeout(commentRetryTimer);
      commentRetryTimer = setTimeout(() => {
        if (token === bootToken) observeCommentSection(token);
      }, COMMENT_RETRY_INTERVAL);
      return;
    }

    if (token !== bootToken) return; // 待機中にページが変わっていた
    commentRetryCount = 0;

    // まず現状をスキャン
    scanExistingComments();

    commentObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          // 要素が使い回されてテキストだけ差し替わる場合にも追従する
          if (n.nodeType === 3) {
            const owner = n.parentElement?.closest?.(COMMENT_TEXT_SELECTOR);
            if (owner) processCommentNode(owner);
            return;
          }
          if (n.nodeType !== 1) return;
          if (n.matches?.(COMMENT_TEXT_SELECTOR)) processCommentNode(n);
          n.querySelectorAll?.(COMMENT_TEXT_SELECTOR).forEach((el) => processCommentNode(el));
        });
      }
    });

    commentObserver.observe(container, { childList: true, subtree: true });
  }

  /** 動画の長さが確定／変化したときにマーカーを描き直す */
  const handleVideoReady = (event) => {
    const video = event?.target || watchedVideo;
    const duration = video?.duration;
    if (!Number.isFinite(duration) || duration <= 0) return; // 未確定なら待つ
    if (duration === lastRenderedDuration) return; // 基準が変わっていなければ何もしない
    rescanAll({ from: lastRenderedDuration, to: duration });
  };

  function attachVideoListeners(video) {
    if (watchedVideo === video) return;
    detachVideoListeners();
    watchedVideo = video;
    // 広告の開始／終了でも duration が変わるため durationchange も監視する
    watchedVideo.addEventListener('loadedmetadata', handleVideoReady);
    watchedVideo.addEventListener('durationchange', handleVideoReady);
  }

  function detachVideoListeners() {
    if (!watchedVideo) return;
    watchedVideo.removeEventListener('loadedmetadata', handleVideoReady);
    watchedVideo.removeEventListener('durationchange', handleVideoReady);
    watchedVideo = null;
  }

  /** <video> の準備を待ってスキャン。以降は長さの変化にも追従する */
  function waitVideoReadyThenScan(token) {
    clearTimeout(videoWaitTimer);
    videoWaitTimer = null;
    const deadline = Date.now() + VIDEO_WAIT_TIMEOUT;

    const tryOnce = () => {
      videoWaitTimer = null;
      if (token !== bootToken) return;

      const video = document.querySelector('video');
      if (video) {
        attachVideoListeners(video);
        if (video.readyState >= 1 || Number.isFinite(video.duration)) {
          scanExistingComments();
        }
        return; // 以降は loadedmetadata / durationchange で追従する
      }

      if (Date.now() >= deadline) {
        log('Video element not found, giving up');
        return;
      }
      videoWaitTimer = setTimeout(tryOnce, VIDEO_POLL_INTERVAL);
    };
    tryOnce();
  }

  function boot() {
    if (!isWatchPage()) {
      log('Not a watch page, skip boot');
      return;
    }
    const token = ++bootToken;
    commentRetryCount = 0;
    observeCommentSection(token);
    waitVideoReadyThenScan(token);
  }

  function cleanupMarkers() {
    document.querySelectorAll('.ytcm-marker').forEach((el) => el.remove());
    // reset processedNodes so comments will be re-parsed on new video
    processedNodes = new WeakMap();
    lastRenderedDuration = 0;
  }

  /** マーカー・監視・タイマーをすべて片付ける */
  function teardown() {
    bootToken++; // 進行中の待機処理を無効化する
    cleanupMarkers();
    commentObserver?.disconnect();
    commentObserver = null;
    clearTimeout(commentRetryTimer);
    commentRetryTimer = null;
    commentRetryCount = 0;
    clearTimeout(videoWaitTimer);
    videoWaitTimer = null;
    detachVideoListeners();
  }

  function handleNavigation() {
    const vid = getVideoId();
    if (vid === currentVideoId) return; // 同じ動画のままなら何もしない
    log('Video changed', { from: currentVideoId, to: vid });
    currentVideoId = vid;
    teardown();
    if (vid) boot(); // 視聴ページ以外へ遷移した場合は片付けるだけ
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
