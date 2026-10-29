// source-relay/ui.mjs
// 接力面板与多源搜索页共用的小工具：建节点、建按钮、格式化时长、歌曲身份。

/** 建一个元素；`text` 给了就写 textContent。 */
export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * 建一个按钮。`focus` 是重画之后把键盘焦点还回来的标记（见各处的 data-focus）。
 */
export const button = (label, onClick, focus) => {
  const node = el('button', '', label);
  node.type = 'button';
  if (focus) node.dataset.focus = focus;
  node.addEventListener('click', onClick);
  return node;
};

export const formatSeconds = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/**
 * 歌曲的可移植身份：source + id，绝不比较 ref。
 * 同一首歌两次读到的 ref 可能不一样，判断是不是同一首要看这个。
 */
export const identityOf = (song) => {
  if (!song) return '';
  const source = song.source ?? '';
  if (song.id) return `${source}#${song.id}`;
  return `${source}#${song.title ?? ''}|${song.artist ?? ''}`;
};
