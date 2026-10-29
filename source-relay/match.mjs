// source-relay/match.mjs
// 音源接力用到的纯函数：把「一首歌」和「另一个平台上搜到的候选」比对成 0–1 的分。
// 这个文件不碰 DOM、不碰 folium，可以直接在 Node 里跑测试（见 tests/run.mjs）。
//
// 判断标准只有三条：歌名像不像、歌手重叠多少、时长差多少。
// 歌名先做 NFKC + 去标点空白 + 去括号内容（Live / Remastered / 伴奏 之类的版本后缀）再比，
// 所以「晴天」「晴天 (Live)」「晴天 - Live」在同一档；但「晴天」和「晴天 (伴奏)」不会因为
// 去掉括号就混为一谈 —— 时长会把它们分开。

/** 空白、标点、符号：比较前全部去掉。 */
const PUNCTUATION = /[\s\p{P}\p{S}]+/gu;

/** 括号里的内容（中英文半角全角都算），例如「(Live)」「【伴奏】」「[Remastered]」。 */
const BRACKETED = /[（(【[][^）)】\]]*[）)】\]]/g;

/** 歌名末尾的版本后缀：只在写明是版本词时才切掉，避免误伤「A - B」这种正常歌名。 */
const VERSION_SUFFIX =
  /\s*[-–—~]\s*(?:live|remaster(?:ed)?(?:\s+\d{4})?|instrumental|off\s*vocal|karaoke|remix|acoustic|demo|edit|version|ver\.?|伴奏|纯音乐|现场|翻自|剪辑版|试听版|片段)\b.*$/iu;

/** 歌名/歌手比较用的规范形式：小写、去标点空白。 */
export function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(PUNCTUATION, '');
}

/** 去掉版本后缀后的歌名；切完太短就退回原样，避免把整首歌名吃掉。 */
export function baseTitle(title) {
  const text = String(title ?? '').trim();
  const stripped = text.replace(BRACKETED, ' ').replace(VERSION_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length >= 2 ? stripped : text;
}

/** 歌手串拆成词：「A / B」「A & B」「A、B」「A feat. B」都拆开，各自规范化。 */
export function artistTokens(artist) {
  return String(artist ?? '')
    .split(/[/,、;；&|]+|\s+[xX×]\s+|feat\.?|ft\.?/i)
    .map((part) => normalize(part))
    .filter((part) => part.length > 0);
}

/** 二元组多重集。 */
function bigrams(text) {
  const counts = new Map();
  for (let index = 0; index + 1 < text.length; index += 1) {
    const gram = text.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Sørensen–Dice（按二元组的多重集算），0–1。 */
export function diceCoefficient(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = bigrams(left);
  const b = bigrams(right);
  let overlap = 0;
  let total = 0;
  for (const [gram, count] of a) {
    total += count;
    overlap += Math.min(count, b.get(gram) ?? 0);
  }
  for (const count of b.values()) total += count;
  return total === 0 ? 0 : (2 * overlap) / total;
}

/**
 * 歌名相似度：原名、去版本后缀的名字各比一次取高的。
 * 完全相等 1；一方完整包含另一方（歌名够长时）0.88；否则按 Dice。
 */
export function titleSimilarity(titleA, titleB) {
  const pairs = [
    [normalize(titleA), normalize(titleB)],
    [normalize(baseTitle(titleA)), normalize(baseTitle(titleB))],
  ];
  let best = 0;
  for (const [left, right] of pairs) {
    if (!left || !right) continue;
    if (left === right) {
      best = 1;
      continue;
    }
    const shorter = left.length <= right.length ? left : right;
    const longer = shorter === left ? right : left;
    if (shorter.length >= 3 && longer.includes(shorter)) best = Math.max(best, 0.88);
    best = Math.max(best, diceCoefficient(left, right));
  }
  return best;
}

/**
 * 歌手相似度：当前歌的每个歌手词，在候选里找到一个相同或互相包含的就算命中。
 * 一边没有歌手信息时给 0.5（不知道，不奖不罚）。
 */
export function artistSimilarity(artistA, artistB) {
  const left = artistTokens(artistA);
  const right = artistTokens(artistB);
  if (left.length === 0 || right.length === 0) return 0.5;
  let hits = 0;
  for (const token of left) {
    const hit = right.some(
      (other) => other === token || (token.length >= 2 && other.length >= 2 && (other.includes(token) || token.includes(other))),
    );
    if (hit) hits += 1;
  }
  const ratio = hits / left.length;
  const fullLeft = normalize(artistA);
  const fullRight = normalize(artistB);
  const same = fullLeft && fullRight && (fullLeft === fullRight || (fullLeft.length >= 4 && fullRight.includes(fullLeft)) || (fullRight.length >= 4 && fullLeft.includes(fullRight)));
  return same ? Math.max(ratio, 1) : ratio;
}

const isDuration = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** 时长相似度；任一边不知道时长时返回 null（不计入总分，权重摊给歌名和歌手）。 */
export function durationSimilarity(leftMs, rightMs) {
  if (!isDuration(leftMs) || !isDuration(rightMs)) return null;
  const seconds = Math.abs(leftMs - rightMs) / 1000;
  if (seconds <= 2) return 1;
  if (seconds <= 5) return 0.82;
  if (seconds <= 12) return 0.45;
  if (seconds <= 25) return 0.16;
  return 0;
}

/** 可接受的下限：低于它就不自动播，免得把另一首歌当成同一首。 */
export const ACCEPT_SCORE = 0.75;
/** 足够确定：命中它就不再往下搜。 */
export const STRONG_SCORE = 0.86;
/** 歌名至少得像到这个程度，否则歌手再对也不算。 */
export const MIN_TITLE = 0.62;

/**
 * 给一个候选打分。
 * @param {{ title?: string, artist?: string, durationMs?: number | null }} target 当前正在放的歌
 * @param {{ title?: string, artist?: string, durationMs?: number | null }} candidate 候选
 */
export function scoreCandidate(target, candidate) {
  const title = titleSimilarity(target.title, candidate.title);
  const artist = artistSimilarity(target.artist, candidate.artist);
  const duration = durationSimilarity(target.durationMs, candidate.durationMs);
  const score = duration === null ? title * 0.68 + artist * 0.32 : title * 0.6 + artist * 0.28 + duration * 0.12;
  const acceptable = title >= MIN_TITLE && score >= ACCEPT_SCORE;
  return { score, title, artist, duration, acceptable, strong: acceptable && score >= STRONG_SCORE };
}

/** 按分数从高到低排序，顺手带上打分结果。 */
export function rankCandidates(target, candidates) {
  return candidates
    .map((candidate) => ({ candidate, match: scoreCandidate(target, candidate) }))
    .sort((left, right) => right.match.score - left.match.score);
}

/**
 * 给某个平台准备的搜索词：默认「歌名 主歌手」；歌名带版本后缀时再补一条去掉后缀的。
 * 平台搜索对空格和顺序敏感，所以把歌手放在后面，且只放第一个歌手。
 */
export function queriesFor(target) {
  const title = String(target.title ?? '').trim();
  if (!title) return [];
  const artist = String(target.artist ?? '')
    .split(/[/,、;；&|]/)[0]
    ?.trim();
  const build = (name) => (artist ? `${name} ${artist}` : name).replace(/\s+/g, ' ').trim().slice(0, 200);
  const queries = [build(title)];
  const base = baseTitle(title).trim();
  if (base && normalize(base) !== normalize(title)) queries.push(build(base));
  return [...new Set(queries)].filter((query) => query.length > 0);
}
