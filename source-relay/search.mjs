// source-relay/search.mjs
// 多源搜索：一次输入，同时在接力链上的每个音源里搜，结果按音源分组排开。
//
// 宿主的搜索浮层没有对模组开放的钩子（只有歌词、播放前、音源解析几个钩子），也改不了它选中的音源，
// 所以这里做的是一个键盘优先、可以绑到全局快捷键的整页搜索：一键唤起、直接打字、回车就播。
// 搜到的每一首都带着自己的 ref，直接交给 playback.playSong / enqueue 就能放、能入队，
// 不需要先切到那个音源，也不会清队列。

import { el, button, formatSeconds, identityOf } from './ui.mjs';

/** 每个音源一页读多少条。 */
const PAGE_LIMIT = 20;
/** 边打字边搜的等待时间（毫秒）。 */
const TYPE_DELAY = 350;

const TEXT = {
  zh: {
    placeholder: '搜歌名、歌手…试试「爱是」',
    search: '搜索',
    searching: '搜索中…',
    empty: '输入歌名或歌手，一次搜遍链上的每个音源。',
    across: (names) => `同时在 ${names} 里搜，按接力顺序排。`,
    noSources: '链上没有可用的在线音源：先在「设置 → 模组 → 音源接力」和音源面板里登录一次。',
    perSource: (count, total) => (total === null ? `${count} 首` : `${count} / ${total} 首`),
    waiting: '等待…',
    nothing: '没有结果',
    more: '更多',
    loadingMore: '读取中…',
    play: '播放',
    queue: '入队',
    playing: '正在放',
    current: '当前音源',
    vip: '会员 / 限制',
    down: '已下架',
    keys: '↑↓ 选一首 · 回车播放 · Esc 清空',
    globalHint: '在「设置 → 快捷操作 → 全局快捷键」里给「多源搜索」绑一个键，就能随时一键唤起。',
    stale: '这一版已经失效了，重新搜一次。',
    enqueueFailed: '这首歌的 ref 失效了，没有入队。',
    errors: {
      unsupported: '这个音源不支持搜索',
      unavailable: '音源接不了请求',
      'region-restricted': '地区不支持',
      'not-signed-in': '要先在 Folia 里登录这个音源',
      'session-expired': '登录已过期',
      'vip-required': '平台说要会员',
      'rate-limited': '请求太频繁，歇一会儿再搜',
      network: '没有拿到回答',
      'account-changed': '途中换了账号或音源',
      'stale-ref': '游标已失效，重新搜一次',
      aborted: '已取消',
    },
  },
  en: {
    placeholder: 'Song or artist…',
    search: 'Search',
    searching: 'Searching…',
    empty: 'Type a song or artist to search every source in the chain at once.',
    across: (names) => `Searching ${names} at the same time, in relay order.`,
    noSources: 'No online source in the chain: sign in to one in Folia first.',
    perSource: (count, total) => (total === null ? `${count} songs` : `${count} / ${total}`),
    waiting: 'Waiting…',
    nothing: 'No results',
    more: 'More',
    loadingMore: 'Loading…',
    play: 'Play',
    queue: 'Queue',
    playing: 'Playing',
    current: 'current source',
    vip: 'members only',
    down: 'taken down',
    keys: '↑↓ pick · Enter play · Esc clear',
    globalHint: 'Bind "Search everywhere" in Settings → Shortcuts → Global shortcuts to open it with one key.',
    stale: 'That version expired; search again.',
    enqueueFailed: 'That ref expired; nothing was queued.',
    errors: {
      unsupported: 'this source cannot search',
      unavailable: 'the source is not available',
      'region-restricted': 'not available here',
      'not-signed-in': 'sign in to it in Folia first',
      'session-expired': 'the sign-in expired',
      'vip-required': 'the platform wants a membership',
      'rate-limited': 'too many requests, wait a moment',
      network: 'no answer',
      'account-changed': 'the account or source changed mid-request',
      'stale-ref': 'the cursor expired; search again',
      aborted: 'cancelled',
    },
  },
};

const guessLang = () => (String(globalThis.navigator?.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en');

/**
 * 搜索状态与请求。界面只读 state、订阅 notify。
 * @param {object} folium
 * @param {{ getChain: () => Array<object>, refreshChain?: () => void }} hooks 接力链（顺序就是用户的接力顺序）
 */
export function createSearch(folium, hooks) {
  const { omni, playback, ui, log } = folium;
  const listeners = new Set();
  const detailsCache = new Map();

  let lang = guessLang();
  let controller = null;
  let pendingQuery = null;

  const state = {
    query: '',
    results: new Map(),
    searching: false,
    seq: 0,
  };

  const t = () => TEXT[lang] ?? TEXT.zh;
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log.error('search page render failed', error);
      }
    }
  };

  const detail = (song) => {
    const key = identityOf(song);
    if (detailsCache.has(key)) return detailsCache.get(key);
    let value = null;
    try {
      value = omni.describeSong(song) ?? null;
    } catch (error) {
      value = null;
    }
    detailsCache.set(key, value);
    if (detailsCache.size > 600) detailsCache.clear();
    return value;
  };

  /** 链上能搜的音源，按接力顺序。 */
  const sources = () => hooks.getChain().filter((row) => row.enabled && row.supports?.search && row.configured !== false);

  const run = async (query) => {
    const text = String(query ?? '').trim();
    state.query = text;
    const rows = sources();
    const token = ++state.seq;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;

    if (!text || rows.length === 0) {
      state.results = new Map();
      state.searching = false;
      notify();
      return;
    }

    state.results = new Map(rows.map((row) => [row.providerId, { status: 'searching', items: [], nextCursor: null, total: null }]));
    state.searching = true;
    notify();

    await Promise.all(
      rows.map(async (row) => {
        try {
          const page = await omni.searchSongs(text, { providerId: row.providerId, limit: PAGE_LIMIT, signal });
          if (token !== state.seq) return;
          state.results.set(row.providerId, { status: 'ready', items: [...page.items], nextCursor: page.nextCursor, total: page.total });
        } catch (error) {
          if (token !== state.seq) return;
          state.results.set(row.providerId, { status: 'error', code: error?.code ?? 'network', items: [], nextCursor: null, total: null });
        }
        notify();
      }),
    );
    if (token !== state.seq) return;
    state.searching = false;
    notify();
  };

  const more = async (providerId) => {
    const entry = state.results.get(providerId);
    if (!entry || entry.status !== 'ready' || !entry.nextCursor || entry.loadingMore) return;
    const token = state.seq;
    state.results.set(providerId, { ...entry, loadingMore: true });
    notify();
    try {
      const page = await omni.searchSongs(state.query, {
        providerId,
        cursor: entry.nextCursor,
        signal: controller?.signal,
      });
      if (token !== state.seq) return;
      const current = state.results.get(providerId);
      if (!current) return;
      state.results.set(providerId, {
        ...current,
        status: 'ready',
        loadingMore: false,
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
        total: page.total ?? current.total,
      });
    } catch (error) {
      if (token !== state.seq) return;
      const current = state.results.get(providerId);
      if (!current) return;
      state.results.set(providerId, { ...current, loadingMore: false, code: error?.code ?? 'network' });
    }
    notify();
  };

  const play = async (song) => {
    if (!song) return;
    try {
      const played = await playback.playSong(song);
      if (!played) ui.toast(t().stale, { type: 'error' });
    } catch (error) {
      log.warn('playSong failed', error);
      ui.toast(t().errors.network, { type: 'error' });
    }
  };

  const enqueue = (song) => {
    try {
      if (!playback.enqueue(song)) ui.toast(t().enqueueFailed, { type: 'error' });
    } catch (error) {
      log.warn('enqueue failed', error);
      ui.toast(t().errors.network, { type: 'error' });
    }
  };

  folium.events.on('playback.songChanged', notify);

  return {
    state,
    t,
    detail,
    sources,
    run,
    more,
    play,
    enqueue,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLocale(locale) {
      const next = String(locale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      if (next !== lang) {
        lang = next;
        notify();
      }
    },
    /** 打开页面时带着一个现成的搜索词（面板上的「搜这首歌」）。 */
    prefill(text) {
      pendingQuery = String(text ?? '').trim() || null;
    },
    takePrefill() {
      const value = pendingQuery;
      pendingQuery = null;
      return value;
    },
    /** 接力顺序变了：只重画，不重搜。 */
    refresh() {
      notify();
    },
    /** 打开页面前先让接力链跟上宿主当前的音源列表。 */
    prime() {
      hooks.refreshChain?.();
    },
    dispose() {
      state.seq += 1;
      controller?.abort();
      listeners.clear();
    },
  };
}

const STYLE = `
* { box-sizing: border-box; }
.multi {
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 20px 24px;
  font: 14px/1.55 var(--folium-font, sans-serif);
  color: var(--folium-primary, currentColor);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, currentColor 30%, transparent) transparent;
}
.bar { display: flex; gap: 8px; align-items: center; }
.bar input {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  font-size: 15px;
  color: inherit;
  background: color-mix(in srgb, currentColor 6%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 999px;
  padding: 8px 16px;
}
.bar input:focus-visible, button:focus-visible { outline: 2px solid var(--folium-accent, currentColor); outline-offset: 2px; }
.hint { margin: 0; font-size: 12px; opacity: 0.62; }
.tips { margin: 0; font-size: 11px; opacity: 0.45; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 12px;
  align-items: start;
}
.card {
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 14px;
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.head { display: flex; align-items: baseline; gap: 8px; }
.name { font-size: 13px; font-weight: 600; }
.count { font-size: 11px; opacity: 0.55; margin-left: auto; }
.state { margin: 0; font-size: 12px; opacity: 0.6; }
.results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.results li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  padding: 6px 8px;
  margin: 0 -8px;
  border-radius: 9px;
  align-items: center;
  cursor: pointer;
}
.results li + li { border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
.results li:hover { background: color-mix(in srgb, currentColor 7%, transparent); }
.results li.sel { background: color-mix(in srgb, var(--folium-accent, currentColor) 16%, transparent); }
.title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 11px; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; gap: 4px; align-items: center; }
.tag {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, currentColor 26%, transparent);
  opacity: 0.8;
  white-space: nowrap;
}
.tag.on { background: color-mix(in srgb, currentColor 14%, transparent); opacity: 1; }
button {
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: transparent;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 999px;
  padding: 2px 10px;
  cursor: pointer;
  white-space: nowrap;
}
button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 10%, transparent); }
button.primary { border-color: var(--folium-accent, currentColor); color: var(--folium-accent, currentColor); }
button:disabled { opacity: 0.35; cursor: default; }
.more { align-self: flex-start; margin-top: 2px; }
`;

/**
 * 首页上的「多源搜索」整页。键盘优先：唤起就能打字，↑↓ 选，回车播放。
 * @param {object} folium
 * @param {ReturnType<typeof createSearch>} search
 */
export function mountSearchPage(folium, search, container, ctx) {
  search.setLocale(ctx.locale);
  const t = search.t();
  const state = search.state;

  const root = el('div', 'multi');
  const form = el('form', 'bar');
  const input = el('input');
  input.type = 'search';
  input.placeholder = t.placeholder;
  input.setAttribute('aria-label', t.search);
  input.value = state.query;
  const submit = el('button', '', t.search);
  submit.type = 'submit';
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (cursor >= 0 && flat[cursor]) {
      void search.play(flat[cursor]);
      return;
    }
    void search.run(input.value);
  });

  const hint = el('p', 'hint');
  const tips = el('p', 'tips', `${t.keys} — ${t.globalHint}`);
  const grid = el('div', 'grid');
  root.append(form, hint, grid, tips);
  const style = el('style', '', STYLE);
  container.append(style, root);

  const errorText = (code) => t.errors[code] ?? t.errors.network;

  let cursor = -1;
  let flat = [];
  let nodes = [];
  let timer = null;

  const setCursor = (next) => {
    if (flat.length === 0) {
      cursor = -1;
      return;
    }
    cursor = Math.max(0, Math.min(flat.length - 1, next));
    nodes.forEach((node, index) => node.classList.toggle('sel', index === cursor));
    nodes[cursor]?.scrollIntoView?.({ block: 'nearest' });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void search.run(input.value);
    }, TYPE_DELAY);
  };

  input.addEventListener('input', () => {
    cursor = -1;
    if (input.value.trim().length === 0) {
      if (timer) clearTimeout(timer);
      timer = null;
      void search.run('');
      return;
    }
    schedule();
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (timer) {
        clearTimeout(timer);
        timer = null;
        void search.run(input.value);
      }
      setCursor(cursor + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor(cursor - 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (timer) clearTimeout(timer);
      timer = null;
      input.value = '';
      cursor = -1;
      void search.run('');
      input.focus?.({ preventScroll: true });
    }
  });

  const resultNode = (song, playing) => {
    const item = el('li');
    const meta = el('div');
    meta.append(el('div', 'title', song.title || '—'));
    const details = search.detail(song);
    const bits = [song.artist, formatSeconds((details?.durationMs ?? 0) / 1000)].filter(Boolean);
    meta.append(el('div', 'sub', bits.join(' · ')));
    item.append(meta);

    const actions = el('div', 'actions');
    if (details?.availability === 'taken-down') actions.append(el('span', 'tag', t.down));
    else if (details?.availability === 'restricted') actions.append(el('span', 'tag', t.vip));
    if (identityOf(song) === identityOf(playing)) actions.append(el('span', 'tag on', t.playing));

    const playButton = button(t.play, (event) => {
      event?.stopPropagation?.();
      void search.play(song);
    }, `play:${identityOf(song)}`);
    const queueButton = button(t.queue, (event) => {
      event?.stopPropagation?.();
      search.enqueue(song);
    }, `queue:${identityOf(song)}`);
    actions.append(playButton, queueButton);
    item.append(actions);

    // 整行就是「播这一首」：搜索结果该点哪一行都行。
    item.addEventListener('click', () => void search.play(song));
    return item;
  };

  const sourceCard = (row, playing) => {
    const entry = state.results.get(row.providerId);
    const card = el('section', 'card');
    const head = el('div', 'head');
    head.append(el('span', 'name', row.shortName || row.displayName || row.providerId));
    if (row.selected) head.append(el('span', 'tag', t.current));
    const items = entry?.items ?? [];
    if (entry?.status === 'ready') head.append(el('span', 'count', t.perSource(items.length, entry.total)));
    card.append(head);

    if (!entry) {
      card.append(el('p', 'state', t.waiting));
      return { card, entries: [] };
    }
    if (entry.status === 'searching') {
      card.append(el('p', 'state', t.searching));
      return { card, entries: [] };
    }
    if (entry.status === 'error' && items.length === 0) {
      card.append(el('p', 'state', errorText(entry.code)));
      return { card, entries: [] };
    }
    if (items.length === 0) {
      card.append(el('p', 'state', t.nothing));
      return { card, entries: [] };
    }

    const list = el('ul', 'results');
    const entries = items.map((song) => {
      const node = resultNode(song, playing);
      list.append(node);
      return { song, node };
    });
    card.append(list);

    if (entry.status === 'error' && entry.code) card.append(el('p', 'state', errorText(entry.code)));
    if (entry.nextCursor) {
      const more = button(entry.loadingMore ? t.loadingMore : t.more, () => void search.more(row.providerId), `more:${row.providerId}`);
      more.disabled = entry.loadingMore === true;
      more.classList.add('more');
      card.append(more);
    }
    return { card, entries };
  };

  const render = () => {
    const playing = folium.playback.getState().song;
    const rows = search.sources();
    submit.disabled = state.searching;
    submit.textContent = state.searching ? t.searching : t.search;
    hint.textContent = rows.length === 0
      ? t.noSources
      : state.query
        ? t.across(rows.map((row) => row.shortName || row.displayName || row.providerId).join(' / '))
        : t.empty;

    // 键盘选中要跨音源连续：按屏幕上出现的顺序把「歌 + 行」拍平。
    flat = [];
    nodes = [];
    const cards = rows.map((row) => {
      const { card, entries } = sourceCard(row, playing);
      for (const entry of entries) {
        flat.push(entry.song);
        nodes.push(entry.node);
      }
      return card;
    });
    grid.replaceChildren(...cards);

    if (cursor >= flat.length) cursor = flat.length - 1;
    nodes.forEach((node, index) => node.classList.toggle('sel', index === cursor));

    const active = container.getRootNode().activeElement;
    const focus = active?.dataset?.focus;
    if (focus && !active.isConnected) {
      [...root.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === focus)?.focus();
    }
  };

  const unsubscribe = search.subscribe(render);
  render();

  const prefilled = search.takePrefill();
  if (prefilled) {
    input.value = prefilled;
    void search.run(prefilled);
  } else if (state.query && state.results.size === 0) {
    // 回到这一页时结果还在就不重搜，省一次额度。
    void search.run(state.query);
  }

  // 唤起就能打字：这是它替代宿主搜索框的关键一步。
  const focusTimer = setTimeout(() => {
    try {
      input.focus({ preventScroll: true });
    } catch (error) {
      /* 宿主可能不给焦点，忽略 */
    }
  }, 0);

  return () => {
    if (timer) clearTimeout(timer);
    clearTimeout(focusTimer);
    unsubscribe();
    root.remove();
    style.remove();
  };
}
