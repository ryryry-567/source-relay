// source-relay/client.mjs
// 音源接力 —— 把网易云、酷狗、QQ 音乐（以及宿主里任何在线音源）串成一条链：
//
//   1. 正在放的这首歌在它自己的音源上放不了（要会员、已下架、要登录、网络抽风），
//      自动拿「歌名 + 歌手」去链上的其它音源找同一首，找到就接着放，不打断听歌。
//   2. 播放页面板里列着这首歌在每个音源上的版本与匹配度，点一下就换到那一版。
//   3. 一个按键 / 命令就能做同样的事，不用打开宿主的音源切换器。
//
// 全部走 folium.omni（只读、稳定接口）和 folium.playback.playSong：
// 换的只是「这首歌从哪个平台播」，宿主选中的音源、队列、登录状态都不动。
//
// 权限：playback.control（播放替代版本）、filesystem.data（记住接力顺序）。
// folium.omni 不需要权限，但会以你在 Folia 登录的平台账号发搜索请求。

import { queriesFor, scoreCandidate } from './match.mjs';
import { el, button, formatSeconds, identityOf } from './ui.mjs';
import { createSearch, mountSearchPage } from './search.mjs';

const CHAIN_KEY = 'chain';
/** 同一首歌连续失败时，自动接力之间的最短间隔（毫秒）。 */
const RELAY_GUARD_MS = 8000;
/** 面板里同一首歌的查找结果缓存多久（毫秒）。 */
const SURVEY_TTL_MS = 90_000;
/** 每个音源最多读几条搜索结果。 */
const SEARCH_LIMIT = 12;
/** 比最高分低这么多的音源，仍然按接力顺序优先。 */
const SCORE_TOLERANCE = 0.06;

const TEXT = {
  zh: {
    noSong: '现在没有正在播放的歌。',
    nothingToDo: '这台 Folia 没有可用的在线音源。',
    unsupported: '这个模组需要 Folium 1.7 及以上。',
    aborted: '已经取消了。',
    panelNow: '正在播放',
    panelCandidates: '其它音源上的同一首',
    panelChain: '接力顺序',
    panelEmpty: '播放一首在线歌曲后，这里会列出它在其它音源上的版本。',
    noCandidates: '没有可以接力的其它音源。',
    searching: '查找中…',
    notFound: '没找到同一首',
    notConfigured: '未配置',
    off: '不参与',
    play: '播放',
    playing: '正在放',
    relayNow: '换一个音源播放',
    searchThis: '在多源搜索里找',
    refresh: '重新查找',
    chainHint: '自动接力按从上到下的顺序找，排在前面的音源有同一首就用它。',
    chainNote: '这里换的只是这首歌从哪个平台播：宿主选中的音源、播放队列和账号都不会动。',
    up: '上移',
    down: '下移',
    reset: '恢复宿主顺序',
    match: (score) => `匹配度 ${Math.round(score * 100)}%`,
    currentTag: '当前音源',
    statusIdle: '播放失败时自动换源；也可以随时点「换一个音源播放」。',
    statusRelaying: (title) => `「${title}」放不了，正在其它音源里找…`,
    statusRelayed: (title, to) => `已换到${to}接着放「${title}」`,
    statusNone: (title) => `其它音源里没找到「${title}」的同一首`,
    exchanged: (title, from, to) => `${from}放不了「${title}」，已换到${to}`,
    noMatch: (title) => `其它音源里没找到「${title}」的同一首`,
    staleRef: '这一版已经失效了，点「重新查找」。',
    exhausted: (title) => `「${title}」在其它音源里也没有可播的版本`,
    backendMissing: (name) => `没有能用上的音源（${name}）`,
    okRelay: (to) => `已换到${to}`,
    errors: {
      unsupported: '这个音源不支持搜索',
      unavailable: '音源现在接不了请求',
      'region-restricted': '地区不支持',
      'not-signed-in': '要先在 Folia 里登录',
      'session-expired': '登录已过期',
      'vip-required': '平台说要会员',
      'rate-limited': '请求太频繁，稍后再试',
      network: '网络没有回答',
      'account-changed': '途中换了账号',
      'stale-ref': '结果已失效',
      aborted: '已取消',
    },
    failures: {
      auth: '要登录',
      restricted: '要会员或地区限制',
      'taken-down': '已下架',
      network: '网络问题',
      unknown: '放不了',
    },
  },
  en: {
    noSong: 'Nothing is playing right now.',
    nothingToDo: 'This Folia has no online source to relay to.',
    unsupported: 'This mod needs Folium 1.7 or later.',
    aborted: 'Cancelled.',
    panelNow: 'Now playing',
    panelCandidates: 'The same song on other sources',
    panelChain: 'Relay order',
    panelEmpty: 'Play an online song and its versions on the other sources show up here.',
    noCandidates: 'No other source to relay to.',
    searching: 'Looking…',
    notFound: 'No match',
    notConfigured: 'Not set up',
    off: 'Skipped',
    play: 'Play',
    playing: 'Playing',
    relayNow: 'Play from another source',
    searchThis: 'Search everywhere',
    refresh: 'Look again',
    chainHint: 'A relay walks the list from the top; the first source with the same song wins.',
    chainNote: 'Switching here only changes which platform plays this song: the selected source, the queue and your accounts stay as they are.',
    up: 'Up',
    down: 'Down',
    reset: 'Host order',
    match: (score) => `${Math.round(score * 100)}% match`,
    currentTag: 'current source',
    statusIdle: 'Failed songs relay automatically; you can also press "Play from another source" any time.',
    statusRelaying: (title) => `"${title}" would not play; looking at the other sources…`,
    statusRelayed: (title, to) => `Now playing "${title}" from ${to}`,
    statusNone: (title) => `No other source has "${title}"`,
    exchanged: (title, from, to) => `${from} could not play "${title}"; relayed to ${to}`,
    noMatch: (title) => `No other source has a matching "${title}"`,
    staleRef: 'That version expired; press "Look again".',
    exhausted: (title) => `No source has a playable "${title}"`,
    backendMissing: (name) => `No usable source (${name})`,
    okRelay: (to) => `Relayed to ${to}`,
    errors: {
      unsupported: 'this source cannot search',
      unavailable: 'the source is not available',
      'region-restricted': 'not available in this region',
      'not-signed-in': 'sign in to it in Folia first',
      'session-expired': 'the sign-in expired',
      'vip-required': 'the platform wants a membership',
      'rate-limited': 'too many requests, try later',
      network: 'no answer from the network',
      'account-changed': 'the account changed mid-request',
      'stale-ref': 'the result expired',
      aborted: 'cancelled',
    },
    failures: {
      auth: 'sign-in needed',
      restricted: 'membership or region',
      'taken-down': 'taken down',
      network: 'network problem',
      unknown: 'would not play',
    },
  },
};

const guessLang = () => (String(globalThis.navigator?.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en');

/* ---------------------------------------------------------------- 引擎 */

function createRelay(folium) {
  const { omni, playback, ui, events, log } = folium;
  const listeners = new Set();
  const chainListeners = new Set();
  const surveyCache = new Map();
  const lastAttempt = new Map();

  let lang = guessLang();
  let prefs = { autoRelay: true, relayOnNetwork: true };
  let chainPrefs = { order: [], off: [] };
  let surveyToken = 0;
  let surveyController = null;
  let relayController = null;
  let panelAttached = false;
  let expectedSubstitute = '';
  /** 这一次「同一首歌的接力」里已经试过的音源：A→B→C 不会绕回 A。 */
  let chainRun = null;

  const t = () => TEXT[lang] ?? TEXT.zh;

  const state = {
    song: null,
    details: null,
    chain: [],
    candidates: new Map(),
    notice: { kind: 'idle' },
    loading: false,
  };

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log.error('panel render failed', error);
      }
    }
  };

  const chainChanged = () => {
    for (const listener of chainListeners) {
      try {
        listener();
      } catch (error) {
        log.error('chain listener failed', error);
      }
    }
  };

  const supported = () => folium.host.folium.minor >= 7 && typeof omni?.listProviders === 'function';

  const nameOf = (providerId) => {
    const info = state.chain.find((row) => row.providerId === providerId) ?? omni.listProviders().find((row) => row.providerId === providerId);
    return info ? info.shortName || info.displayName || providerId : String(providerId ?? '');
  };

  const describe = (song) => {
    try {
      return omni.describeSong(song) ?? null;
    } catch (error) {
      return null;
    }
  };

  const targetOf = (song, details) => ({
    title: song?.title ?? '',
    artist: song?.artist ?? '',
    durationMs: details?.durationMs ?? null,
  });

  const buildChain = () => {
    if (!supported()) return [];
    const providers = omni.listProviders().filter((info) => info.supports?.search);
    const known = new Set(providers.map((info) => info.providerId));
    const rows = [];
    for (const providerId of chainPrefs.order) {
      const info = providers.find((entry) => entry.providerId === providerId);
      if (info) rows.push(info);
    }
    for (const info of providers) if (!rows.includes(info)) rows.push(info);
    state.chain = rows.map((info) => ({ ...info, enabled: !chainPrefs.off.includes(info.providerId) }));
    // 标记当前歌曲所在的音源，面板里好显示「正在放」。
    return state.chain;
  };

  const persistChain = () => {
    chainPrefs = { order: state.chain.map((row) => row.providerId), off: state.chain.filter((row) => !row.enabled).map((row) => row.providerId) };
    void folium.storage.set(CHAIN_KEY, chainPrefs).catch((error) => log.warn('could not store the relay order', error));
  };

  /**
   * 在某个音源上找这首歌。
   * @param {{ title: string, artist: string, durationMs: number | null }} target
   * @param {object} row 接力链上的一项
   * @param {AbortSignal | undefined} signal
   * @param {Set<string>} exclude 已经试过（或者就是当前这首）的身份，不再当候选
   * @returns {Promise<{ status: 'found'|'none'|'error', song?: object, match?: object, details?: object|null, code?: string }>}
   */
  async function searchProvider(target, row, signal, exclude) {
    if (row.configured === false) return { status: 'error', code: 'unavailable' };
    let best = null;
    let failure = null;
    for (const query of queriesFor(target)) {
      let page;
      try {
        page = await omni.searchSongs(query, { providerId: row.providerId, limit: SEARCH_LIMIT, signal });
      } catch (error) {
        if (error?.code === 'aborted' || signal?.aborted) throw error;
        failure = error;
        break;
      }
      for (const song of page.items) {
        if (exclude?.has(identityOf(song))) continue;
        const details = describe(song);
        // 平台已经标了下架，放也放不了，别把它当成候选。
        if (details?.availability === 'taken-down') continue;
        const match = scoreCandidate(target, {
          title: song.title,
          artist: song.artist,
          durationMs: details?.durationMs ?? null,
        });
        if (!match.acceptable) continue;
        if (!best || match.score > best.match.score) best = { song, match, details };
      }
      if (best) break;
    }
    if (best) return { status: 'found', ...best };
    if (failure) return { status: 'error', code: failure?.code ?? 'network' };
    return { status: 'none' };
  }

  /** 每个音源都问一遍，结果进 state.candidates（面板用）。 */
  async function survey({ force = false } = {}) {
    buildChain();
    const song = state.song;
    if (!song || !supported()) {
      state.candidates = new Map();
      notify();
      return;
    }
    const identity = identityOf(song);
    const cached = surveyCache.get(identity);
    if (!force && cached && Date.now() - cached.at < SURVEY_TTL_MS) {
      state.candidates = new Map(cached.entries);
      notify();
      return;
    }

    const token = ++surveyToken;
    surveyController?.abort();
    surveyController = new AbortController();
    const { signal } = surveyController;

    const targets = state.chain.filter((row) => row.enabled && row.supports?.search && row.configured !== false && row.providerId !== song.source);
    const target = targetOf(song, state.details);
    state.candidates = new Map(state.chain.map((row) => [row.providerId, { status: row.enabled ? 'searching' : 'off' }]));
    state.loading = true;
    notify();

    const settled = await Promise.all(
      targets.map(async (row) => {
        try {
          return [row.providerId, await searchProvider(target, row, signal, new Set([identityOf(song)]))];
        } catch (error) {
          return [row.providerId, { status: 'error', code: error?.code ?? 'network' }];
        }
      }),
    );
    if (token !== surveyToken || signal.aborted) return;

    const next = new Map(state.candidates);
    for (const [providerId, result] of settled) next.set(providerId, result);
    state.candidates = next;
    state.loading = false;
    surveyCache.set(identity, { at: Date.now(), entries: settled });
    if (surveyCache.size > 40) surveyCache.clear();
    notify();
  }

  /**
   * 换源：在接力链上找同一首，放到第一个够格的候选。
   * @param {object} song
   * @param {{ manual?: boolean, reason?: string }} options
   */
  async function relayFrom(song, options = {}) {
    const manual = options.manual === true;
    if (!song?.title) {
      const message = t().noSong;
      if (manual) ui.toast(message, { type: 'error' });
      return { ok: false, kind: 'no-song', message };
    }
    if (!supported()) {
      const message = t().unsupported;
      if (manual) ui.toast(message, { type: 'error' });
      return { ok: false, kind: 'unsupported', message };
    }

    // 音源只在模组注册/注销时增减、宿主换选中音源也不发事件：每次接力都用的时候读一遍。
    buildChain();
    const identity = identityOf(song);
    const now = Date.now();
    const previous = lastAttempt.get(identity);
    if (!manual && previous && now - previous < RELAY_GUARD_MS) return { ok: false, kind: 'cooldown' };
    lastAttempt.set(identity, now);
    if (lastAttempt.size > 80) lastAttempt.clear();

    const run =
      chainRun && chainRun.identities.has(identity)
        ? chainRun
        : { providers: new Set(), identities: new Set([identity]) };
    chainRun = run;

    const details = state.song && identityOf(state.song) === identity ? state.details : describe(song);
    const target = targetOf(song, details);
    const targets = state.chain.filter(
      (row) => row.enabled && row.supports?.search && row.configured !== false && row.providerId !== song.source && !run.providers.has(row.providerId),
    );

    if (targets.length === 0) {
      const message = t().exhausted(song.title);
      state.notice = { kind: 'none', title: song.title };
      notify();
      if (manual) ui.toast(message, { type: 'info' });
      return { ok: false, kind: 'exhausted', message };
    }

    relayController?.abort();
    relayController = new AbortController();
    const { signal } = relayController;
    state.notice = { kind: 'relaying', title: song.title };
    notify();

    const settled = await Promise.all(
      targets.map(async (row) => {
        try {
          return { row, result: await searchProvider(target, row, signal, run.identities) };
        } catch (error) {
          return { row, result: { status: 'error', code: error?.code ?? 'network' } };
        }
      }),
    );
    if (signal.aborted) return { ok: false, kind: 'aborted', message: t().aborted };

    const found = settled.filter((entry) => entry.result.status === 'found');
    if (found.length === 0) {
      const message = manual ? t().noMatch(song.title) : '';
      state.notice = { kind: 'none', title: song.title };
      notify();
      if (manual) ui.toast(message, { type: 'info' });
      return { ok: false, kind: 'no-match', message };
    }

    // 接力顺序优先，但只让排在前面、分数又没落后太多（SCORE_TOLERANCE）的音源抢先。
    const bestScore = Math.max(...found.map((entry) => entry.result.match.score));
    const order = found.filter((entry) => entry.result.match.score >= bestScore - SCORE_TOLERANCE);

    for (const entry of order) {
      const substitute = entry.result.song;
      expectedSubstitute = identityOf(substitute);
      const played = await playback.playSong(substitute);
      if (!played) {
        expectedSubstitute = '';
        log.warn('playSong refused the substitute', { source: substitute.source, id: substitute.id });
        continue;
      }
      run.providers.add(entry.row.providerId);
      run.identities.add(identityOf(substitute));
      chainRun = run;
      state.notice = { kind: 'relayed', title: song.title, to: entry.row.providerId };
      notify();
      const message = t().exchanged(song.title, nameOf(song.source), nameOf(entry.row.providerId));
      ui.toast(message, { type: 'success' });
      return { ok: true, kind: 'relayed', message, to: entry.row.providerId };
    }

    const message = t().exhausted(song.title);
    state.notice = { kind: 'none', title: song.title };
    notify();
    if (manual) ui.toast(message, { type: 'info' });
    return { ok: false, kind: 'no-match', message };
  }

  const relayNow = async () => {
    const song = state.song ?? playback.getState().song;
    return relayFrom(song, { manual: true, reason: 'manual' });
  };

  const setSong = (song) => {
    state.song = song ?? null;
    state.details = song ? describe(song) : null;
    state.candidates = new Map();
    if (panelAttached) void survey({ force: false });
    notify();
  };

  const onFailure = (event) => {
    if (!prefs.autoRelay) return;
    if (event?.reason === 'network' && !prefs.relayOnNetwork) return;
    const song = event?.song ?? state.song ?? playback.getState().song;
    if (!song?.title) return;
    void relayFrom(song, { manual: false, reason: event?.reason ?? 'unknown' });
  };

  const onSongChanged = (event) => {
    const song = event?.song ?? null;
    const identity = identityOf(song);
    if (identity && identity === expectedSubstitute) {
      // 是我们换上去的那一版：接力链继续往下走，不重置。
      expectedSubstitute = '';
      setSong(song);
      return;
    }
    expectedSubstitute = '';
    chainRun = null;
    setSong(song);
  };

  const initialise = async () => {
    try {
      const stored = await folium.storage.get(CHAIN_KEY);
      if (stored && typeof stored === 'object') {
        chainPrefs = {
          order: Array.isArray(stored.order) ? stored.order.filter((id) => typeof id === 'string') : [],
          off: Array.isArray(stored.off) ? stored.off.filter((id) => typeof id === 'string') : [],
        };
      }
    } catch (error) {
      log.warn('could not read the relay order', error);
    }
    buildChain();
    setSong(playback.getState().song);
    notify();
  };

  return {
    state,
    TEXT,
    get lang() {
      return lang;
    },
    setLocale(locale) {
      const next = String(locale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      if (next !== lang) {
        lang = next;
        notify();
      }
    },
    t,
    supported,
    nameOf,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachPanel() {
      panelAttached = true;
      if (state.song) void survey();
    },
    detachPanel() {
      panelAttached = false;
      surveyToken += 1;
      surveyController?.abort();
    },
    bindSettings(access) {
      const read = () => {
        const values = access.get() ?? {};
        prefs = { autoRelay: values.autoRelay !== false, relayOnNetwork: values.relayOnNetwork !== false };
      };
      read();
      access.onChange(() => {
        read();
        notify();
      });
    },
    refreshChain() {
      buildChain();
      chainChanged();
      notify();
    },
    chainRows() {
      return state.chain.map((row) => ({ ...row, current: row.providerId === state.song?.source }));
    },
    chainMove(providerId, delta) {
      const index = state.chain.findIndex((row) => row.providerId === providerId);
      const next = index + delta;
      if (index < 0 || next < 0 || next >= state.chain.length) return;
      const rows = [...state.chain];
      const [row] = rows.splice(index, 1);
      rows.splice(next, 0, row);
      state.chain = rows;
      persistChain();
      chainChanged();
      notify();
    },
    chainToggle(providerId, enabled) {
      state.chain = state.chain.map((row) => (row.providerId === providerId ? { ...row, enabled: enabled === true } : row));
      persistChain();
      chainChanged();
      notify();
    },
    chainReset() {
      chainPrefs = { order: [], off: [] };
      buildChain();
      persistChain();
      chainChanged();
      notify();
    },
    /** 接力顺序变了就通知一声：多源搜索页按同一份顺序排。 */
    onChainChange(listener) {
      chainListeners.add(listener);
      return () => chainListeners.delete(listener);
    },
    survey,
    relayNow,
    dispose() {
      surveyToken += 1;
      surveyController?.abort();
      relayController?.abort();
      listeners.clear();
    },
    start() {
      events.on('playback.songChanged', onSongChanged);
      events.on('playback.failed', onFailure);
      void initialise();
    },
  };
}

/* ---------------------------------------------------------------- 面板 */

const STYLE = `
* { box-sizing: border-box; }
.relay {
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px 22px;
  font: 14px/1.55 var(--folium-font, sans-serif);
  color: var(--folium-primary, currentColor);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, currentColor 30%, transparent) transparent;
}
.card {
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 14px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
h2 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; opacity: 0.7; text-transform: uppercase; }
h3 { margin: 0; font-size: 13px; font-weight: 600; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.note { margin: 0; font-size: 12px; opacity: 0.62; }
.now-title { font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag {
  font-size: 11px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  opacity: 0.85;
  white-space: nowrap;
}
.tag.on { background: color-mix(in srgb, currentColor 14%, transparent); opacity: 1; }
.cands { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.cands li { display: grid; grid-template-columns: 88px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 5px 0; }
.cands .name { font-size: 12px; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cands .what { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cands .what .sub { opacity: 0.6; }
.chain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.chain li { display: grid; grid-template-columns: auto 20px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 3px 0; }
.chain .name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chain .off .name { opacity: 0.45; text-decoration: line-through; }
.chain .moves { display: flex; gap: 2px; }
.chain .moves button { padding: 0 6px; line-height: 1.4; }
button {
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: transparent;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 999px;
  padding: 3px 11px;
  cursor: pointer;
  white-space: nowrap;
}
button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 10%, transparent); }
button.primary { border-color: var(--folium-accent, currentColor); color: var(--folium-accent, currentColor); }
button:disabled { opacity: 0.35; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--folium-accent, currentColor); outline-offset: 2px; }
input[type="checkbox"] { accent-color: var(--folium-accent, currentColor); }
`;

function mountPanel(folium, relay, container, ctx, onSearchSong) {
  relay.setLocale(ctx.locale);
  const t = relay.t();
  const state = relay.state;

  const root = el('div', 'relay');

  // 正在播放
  const nowTitle = el('div', 'now-title');
  const nowMeta = el('p', 'note');
  const nowTags = el('div', 'row');
  const statusLine = el('p', 'note');
  const relayButton = button(t.relayNow, () => {
    relayButton.disabled = true;
    void relay.relayNow().finally(() => {
      relayButton.disabled = false;
      render();
    });
  }, 'relay-now');
  relayButton.classList.add('primary');
  const refreshButton = button(t.refresh, () => {
    void relay.survey({ force: true });
  }, 'refresh');
  const nowActions = el('div', 'row');
  const searchButton = button(t.searchThis, () => {
    if (!state.song) return;
    onSearchSong?.([state.song.title, state.song.artist].filter(Boolean).join(' '));
  }, 'search-song');
  nowActions.append(relayButton, searchButton, refreshButton);
  const nowCard = el('section', 'card');
  nowCard.append(el('h2', '', t.panelNow), nowTitle, nowMeta, nowTags, nowActions, statusLine);

  // 候选
  const candidateList = el('ul', 'cands');
  const emptyNote = el('p', 'note', t.panelEmpty);
  const candidateCard = el('section', 'card');
  candidateCard.append(el('h2', '', t.panelCandidates), emptyNote, candidateList);

  // 接力顺序
  const chainList = el('ul', 'chain');
  const resetButton = button(t.reset, () => relay.chainReset(), 'reset');
  const chainCard = el('section', 'card');
  chainCard.append(el('h2', '', t.panelChain), el('p', 'note', t.chainHint), chainList, resetButton, el('p', 'note', t.chainNote));

  root.append(nowCard, candidateCard, chainCard);
  const style = el('style', '', STYLE);
  container.append(style, root);

  const errorText = (code) => t.errors[code] ?? t.errors.network;

  const candidateNode = (row) => {
    const item = el('li');
    const name = el('span', 'name', row.shortName || row.displayName || row.providerId);
    item.append(name);
    if (row.current) {
      item.append(el('span', 'what', state.song ? `${state.song.title} · ${t.playing}` : t.playing));
      item.append(el('span', 'tag on', t.currentTag));
      return item;
    }
    const result = state.candidates.get(row.providerId);
    const what = el('span', 'what');
    let action = null;
    if (!row.enabled) {
      what.textContent = t.off;
    } else if (row.configured === false) {
      what.textContent = t.notConfigured;
    } else if (!result || result.status === 'searching') {
      what.textContent = t.searching;
    } else if (result.status === 'error') {
      what.textContent = errorText(result.code);
    } else if (result.status === 'none') {
      what.textContent = t.notFound;
    } else {
      what.append(document.createTextNode(result.song.title || ''));
      const sub = el('span', 'sub');
      const parts = [result.song.artist, formatSeconds((result.details?.durationMs ?? 0) / 1000), t.match(result.match.score)].filter(Boolean);
      sub.textContent = parts.length ? ` · ${parts.join(' · ')}` : '';
      what.append(sub);
      action = button(t.play, () => {
        void folium.playback
          .playSong(result.song)
          .then((played) => {
            if (!played) folium.ui.toast(t.staleRef, { type: 'error' });
          })
          .catch((error) => {
            folium.log.warn('playSong failed', error);
            folium.ui.toast(t.errors.network, { type: 'error' });
          });
      }, `play:${row.providerId}`);
    }
    item.append(what);
    if (action) item.append(action);
    else item.append(el('span'));
    return item;
  };

  const chainNode = (row, index) => {
    const item = el('li', row.enabled ? '' : 'off');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = row.enabled;
    box.setAttribute('aria-label', row.displayName || row.providerId);
    box.addEventListener('change', () => relay.chainToggle(row.providerId, box.checked));
    const moves = el('span', 'moves');
    const up = button('▲', () => relay.chainMove(row.providerId, -1), `up:${row.providerId}`);
    up.disabled = index === 0;
    const down = button('▼', () => relay.chainMove(row.providerId, 1), `down:${row.providerId}`);
    down.disabled = index === state.chain.length - 1;
    moves.append(up, down);
    item.append(box, moves);
    const label = el('span', 'name', row.displayName || row.providerId);
    item.append(label);
    item.append(el('span', 'note', row.configured === false ? t.notConfigured : row.current ? t.currentTag : ''));
    return item;
  };

  const render = () => {
    const song = state.song;
    nowTitle.textContent = song ? song.title : t.noSong;
    nowMeta.textContent = song ? [song.artist, formatSeconds((state.details?.durationMs ?? 0) / 1000)].filter(Boolean).join(' · ') : '';
    nowTags.replaceChildren(...(song?.source ? [el('span', 'tag on', relay.nameOf(song.source))] : []));
    const notice = state.notice ?? { kind: 'idle' };
    if (notice.kind === 'relaying') statusLine.textContent = t.statusRelaying(notice.title);
    else if (notice.kind === 'relayed') statusLine.textContent = t.statusRelayed(notice.title, relay.nameOf(notice.to));
    else if (notice.kind === 'none') statusLine.textContent = t.statusNone(notice.title);
    else statusLine.textContent = t.statusIdle;
    relayButton.disabled = !song;
    searchButton.disabled = !song;
    refreshButton.disabled = !song || state.loading;

    const rows = relay.chainRows();
    const visible = rows.filter((row) => row.enabled || row.current);
    candidateList.replaceChildren(...visible.map(candidateNode));
    const hasCandidates = visible.some((row) => !row.current);
    emptyNote.textContent = song ? t.noCandidates : t.panelEmpty;
    emptyNote.hidden = hasCandidates;
    chainList.replaceChildren(...rows.map(chainNode));

    // 列表每次重画都会换掉按钮：把键盘焦点还给同一个。
    const active = container.getRootNode().activeElement;
    const focus = active?.dataset?.focus;
    if (focus && !active.isConnected) {
      [...root.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === focus)?.focus();
    }
  };

  const unsubscribe = relay.subscribe(render);
  render();
  relay.attachPanel();

  return () => {
    relay.detachPanel();
    unsubscribe();
    root.remove();
    style.remove();
  };
}

/* ---------------------------------------------------------------- 入口 */

export default function activate(folium) {
  if (folium.host.folium.minor < 7) {
    folium.log.warn('音源接力需要 Folium 1.7（folium.omni）；这个宿主太旧，什么也没注册。');
    return undefined;
  }
  if (folium.env.context !== 'main') return undefined;

  const relay = createRelay(folium);

  const section = folium.registries.settingsSections.register({
    id: 'relay',
    label: { 'zh-CN': '音源接力', en: 'Source relay' },
    description: {
      'zh-CN': '一首歌在它的音源上放不了时，自动到其它音源找同一首接着放。',
      en: 'When a song will not play at its own source, play the same song from another one.',
    },
    settings: [
      {
        key: 'autoRelay',
        type: 'boolean',
        label: { 'zh-CN': '放不了就自动换源', en: 'Relay automatically when a song fails' },
        description: {
          'zh-CN': '要会员、已下架、要登录、播放中途断流，都会试着换到链上的下一个音源。',
          en: 'A song that needs a membership, was taken down, needs a sign-in or dies mid-play is retried at the next source in the chain.',
        },
        defaultValue: true,
      },
      {
        key: 'relayOnNetwork',
        type: 'boolean',
        label: { 'zh-CN': '网络问题时也换源', en: 'Relay on network problems too' },
        description: {
          'zh-CN': '关掉后，只是网络抖一下的歌不会换源（有些歌的其它版本可能音质不同）。',
          en: 'Turn off to leave songs that only hiccuped on the network alone.',
        },
        defaultValue: true,
      },
    ],
  });
  relay.bindSettings(section.settings);

  relay.start();

  const search = createSearch(folium, {
    getChain: () => relay.state.chain,
    refreshChain: () => relay.refreshChain(),
  });
  relay.onChainChange(() => search.refresh());

  folium.registries.playerPanelTabs.register({
    id: 'relay',
    label: { 'zh-CN': '音源接力', en: 'Source relay' },
    order: 480,
    mount: (container, ctx) =>
      mountPanel(folium, relay, container, ctx, (text) => {
        search.prefill(text);
        folium.ui.openHomeTab('search');
      }),
  });

  folium.registries.homeTabs.register({
    id: 'search',
    label: { 'zh-CN': '多源搜索', en: 'Search everywhere' },
    order: 340,
    mount: (container, ctx) => {
      search.prime();
      return mountSearchPage(folium, search, container, ctx);
    },
  });

  folium.registries.commands.register({
    id: 'search',
    label: { 'zh-CN': '多源搜索', en: 'Search everywhere' },
    description: {
      'zh-CN': '一次输入，在链上的每个音源里同时搜，结果按音源分组。',
      en: 'One query, searched on every source in the chain, grouped by source.',
    },
    keywords: ['search', 'multi', '搜索', '多源', '音源'],
    globalShortcut: true,
    run: () => {
      folium.ui.openHomeTab('search');
      return { message: relay.t().panelCandidates };
    },
  });

  folium.registries.commands.register({
    id: 'relay-now',
    label: { 'zh-CN': '换一个音源播放', en: 'Play from another source' },
    description: {
      'zh-CN': '给正在播放的歌换一个音源，不动宿主的音源选择、队列和账号。',
      en: 'Play the current song from another source without touching the selected source, the queue or your accounts.',
    },
    keywords: ['relay', 'source', 'failover', '音源', '换源', '接力', '备用'],
    globalShortcut: true,
    run: async () => (await relay.relayNow()).message || relay.t().noSong,
  });

  folium.registries.commands.register({
    id: 'open-panel',
    label: { 'zh-CN': '打开音源接力面板', en: 'Open the source relay panel' },
    description: {
      'zh-CN': '看这首歌在每个音源上的版本，调接力顺序。',
      en: 'See this song on every source and adjust the relay order.',
    },
    keywords: ['relay', 'panel', '音源', '面板'],
    run: () => {
      folium.ui.openPlayerPanel('relay');
      return { message: relay.t().panelCandidates };
    },
  });

  return () => {
    search.dispose();
    relay.dispose();
  };
}
