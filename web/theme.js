/* 配色主题：每个主题只给 CSS 变量，画布也从这些变量取色，故一套主题全站生效。
   字段：
     kind    'dark' | 'light' —— 设置菜单里按它分「深色 / 浅色」两组，也用于校验
     label   菜单里显示的名字
     vars    --bg 底 / --panel 面板 / --panel-2 控件 / --border 边线 / --grid 小节线 /
             --grid-beat 拍线 / --text 正文 / --muted 次要文字 / --accent 主色（播放头、选中态）/
             --clip-midi 片段（MIDI）/ --clip-audio 片段（音频）/
             --clip-auto 片段（自动化）/ --note 音符
   --clip-auto 是给 FL 工程里那类"自动化片段"用的（万古城：3274 条里 1418 条）：
   它必须和 --clip-midi / --clip-audio 明显不同色，否则走带上一眼分不出来。
   加主题的硬要求（scripts/verify.mjs 逐条卡）：13 个变量齐全，且
   正文/底 ≥ 10:1、次要文字/底 ≥ 3.5:1、主色/底 ≥ 3:1、音符/底 ≥ 4:1、
   片段色/底 ≥ 3:1（音频 2.8:1）、音符压在片段底色上 ≥ 2:1（WCAG 对比度）。
   浅色主题注意：钢琴键栏白键用 --text 画、键上音名用 --bg 画，两者要分得开。 */

const THEMES = {
  /* ---------------------------------------------------------- 深色 */
  aqua: {
    kind: 'dark',
    label: '水蓝',
    vars: {
      '--bg': '#0f1720', '--panel': '#16212c', '--panel-2': '#1b2836',
      '--border': '#263747', '--grid': '#1f2e3c', '--grid-beat': '#182533',
      '--text': '#e8eef5', '--muted': '#8ea3b8',
      '--accent': '#3389d1', '--clip-midi': '#3389d1', '--clip-audio': '#4fb3a6',
      '--clip-auto': '#d9a94a',
      '--note': '#7cc4f5',
    },
  },
  midnight: {
    kind: 'dark',
    label: '深夜',
    vars: {
      '--bg': '#0a0a0c', '--panel': '#131317', '--panel-2': '#191920',
      '--border': '#26262f', '--grid': '#1b1b22', '--grid-beat': '#151519',
      '--text': '#e6e6ee', '--muted': '#7e7e91',
      '--accent': '#8b7cf6', '--clip-midi': '#8b7cf6', '--clip-audio': '#f0876b',
      '--clip-auto': '#4fc3d9',
      '--note': '#b3a8ff',
    },
  },
  abyss: {
    kind: 'dark',
    label: '深海',
    vars: {
      '--bg': '#061016', '--panel': '#0c1c26', '--panel-2': '#122632',
      '--border': '#1d3d4e', '--grid': '#12303c', '--grid-beat': '#0e2530',
      '--text': '#dff1f8', '--muted': '#7fa6ba',
      '--accent': '#2fc4d8', '--clip-midi': '#2fc4d8', '--clip-audio': '#4f9ee0',
      '--clip-auto': '#d8b25c',
      '--note': '#7fe3ef',
    },
  },
  neon: {
    kind: 'dark',
    label: '霓虹',
    vars: {
      '--bg': '#0b0710', '--panel': '#150d1c', '--panel-2': '#1e1228',
      '--border': '#3a2152', '--grid': '#251637', '--grid-beat': '#1b1029',
      '--text': '#f2e8ff', '--muted': '#a08cbd',
      '--accent': '#ff4fa3', '--clip-midi': '#ff4fa3', '--clip-audio': '#4fe0c0',
      '--clip-auto': '#e8d44d',
      '--note': '#ff9ecb',
    },
  },
  forest: {
    kind: 'dark',
    label: '苔原',
    vars: {
      '--bg': '#0e1512', '--panel': '#141e19', '--panel-2': '#1a2620',
      '--border': '#25352c', '--grid': '#1b2a23', '--grid-beat': '#16221c',
      '--text': '#e6efe9', '--muted': '#8aa596',
      '--accent': '#5fa87a', '--clip-midi': '#5fa87a', '--clip-audio': '#c9a15a',
      '--clip-auto': '#6fa8d6',
      '--note': '#9ed4b3',
    },
  },
  sunset: {
    kind: 'dark',
    label: '落日',
    vars: {
      '--bg': '#181114', '--panel': '#211619', '--panel-2': '#2a1c20',
      '--border': '#3a272d', '--grid': '#2a1c21', '--grid-beat': '#221619',
      '--text': '#f2e6e8', '--muted': '#b0919a',
      '--accent': '#e2705f', '--clip-midi': '#e2705f', '--clip-audio': '#d9a04f',
      '--clip-auto': '#57b3ab',
      '--note': '#f3a08e',
    },
  },
  mocha: {
    kind: 'dark',
    label: '摩卡',
    vars: {
      '--bg': '#14100d', '--panel': '#1f1814', '--panel-2': '#29201a',
      '--border': '#3d3026', '--grid': '#2c221b', '--grid-beat': '#221a14',
      '--text': '#f4ece3', '--muted': '#b39a89',
      '--accent': '#dd9450', '--clip-midi': '#dd9450', '--clip-audio': '#8fae72',
      '--clip-auto': '#7f9ec4',
      '--note': '#f0bd8a',
    },
  },

  /* ---------------------------------------------------------- 浅色 */
  day: {
    kind: 'light',
    label: '晨雾',
    vars: {
      '--bg': '#f6f8fa', '--panel': '#ffffff', '--panel-2': '#eef2f6',
      '--border': '#d6dee7', '--grid': '#e7edf3', '--grid-beat': '#eff4f8',
      '--text': '#1d2833', '--muted': '#6b7c8d',
      '--accent': '#3389d1', '--clip-midi': '#3389d1', '--clip-audio': '#2f9c8f',
      '--clip-auto': '#a8721c',
      '--note': '#1f6fb2',
    },
  },
  paper: {
    kind: 'light',
    label: '象牙',
    vars: {
      '--bg': '#f0eee6', '--panel': '#faf9f5', '--panel-2': '#e9e5d9',
      '--border': '#d8d2c2', '--grid': '#e5e0d2', '--grid-beat': '#eeeadf',
      '--text': '#232019', '--muted': '#6f6a5b',
      '--accent': '#c15f3c', '--clip-midi': '#c15f3c', '--clip-audio': '#3d7a68',
      '--clip-auto': '#4a5aa8',
      '--note': '#9c4223',
    },
  },
  mint: {
    kind: 'light',
    label: '薄荷',
    vars: {
      '--bg': '#f1f7f3', '--panel': '#ffffff', '--panel-2': '#e6efe9',
      '--border': '#cddfd4', '--grid': '#e1ece5', '--grid-beat': '#ebf3ee',
      '--text': '#1c2a22', '--muted': '#5e7367',
      '--accent': '#2f8f68', '--clip-midi': '#2f8f68', '--clip-audio': '#9c7028',
      '--clip-auto': '#6a5aa8',
      '--note': '#1d6a4c',
    },
  },
  sakura: {
    kind: 'light',
    label: '樱花',
    vars: {
      '--bg': '#faf4f6', '--panel': '#ffffff', '--panel-2': '#f4e7eb',
      '--border': '#e4ccd4', '--grid': '#f0e2e7', '--grid-beat': '#f7ecf0',
      '--text': '#2b1f24', '--muted': '#7d6670',
      '--accent': '#c2506f', '--clip-midi': '#c2506f', '--clip-audio': '#6f6bb5',
      '--clip-auto': '#2f7f7a',
      '--note': '#a03b5c',
    },
  },
  slate: {
    kind: 'light',
    label: '青灰',
    vars: {
      '--bg': '#f3f5f8', '--panel': '#ffffff', '--panel-2': '#e8edf3',
      '--border': '#d2dae3', '--grid': '#e3e9f0', '--grid-beat': '#edf1f6',
      '--text': '#1b212a', '--muted': '#646f7c',
      '--accent': '#4a5f9e', '--clip-midi': '#4a5f9e', '--clip-audio': '#2f7f7a',
      '--clip-auto': '#9c6a20',
      '--note': '#3b4f8a',
    },
  },
};

// 设置菜单里主题下拉框的分组（数组顺序 = 菜单里的顺序）
const THEME_GROUPS = [
  { label: '深色', kind: 'dark' },
  { label: '浅色', kind: 'light' },
];

function themeOptions() {
  return THEME_GROUPS.map((g) => ({
    label: g.label,
    options: Object.entries(THEMES)
      .filter(([, t]) => (t.kind || 'dark') === g.kind)
      .map(([k, t]) => [k, t.label]),
  }));
}

const STORE_KEY = 'dawview.theme';

function applyTheme(name, custom) {
  const root = document.documentElement;
  const theme = THEMES[name] || THEMES.aqua;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  if (custom) {
    for (const [k, v] of Object.entries(custom)) if (v) root.style.setProperty(k, v);
  }
  return theme;
}

function saveTheme(state) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式忽略 */ }
}

function loadTheme() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* 忽略 */ }
  return { name: 'aqua', custom: {} };
}

function readVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
