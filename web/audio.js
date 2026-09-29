/* 用户音频轨（自己导入的音频）—— 纯逻辑 + Web Audio 播放引擎。
 *
 * 分两层：
 *   1) 纯函数（tick <-> 秒、裁剪、吸附、播放排期、峰值提取）：不碰 DOM / 音频设备，
 *      验证脚本可以直接调它们做断言。
 *   2) audioEngine：一份 AudioContext + 解码好的 AudioBuffer 缓存，按"排期"起停
 *      BufferSource。**声音靠它**，所以它只做三件事：加载、按计划起播、停。
 *
 * 时间语义（关键约定，和契约 docs/01-data-contract.md v0.6 对齐）：
 *   - 片段的**位置**用工程 tick 表示（跟着速度轨走，能对齐小节线）；
 *   - 片段的**音频内容**用源文件的秒数表示（srcOffsetSec 起、取 lengthSec 秒）。
 *   于是"左裁剪"= 位置和源内偏移同时变（内容在时间轴上不动），"改速度轨"不会
 *   把音频拉伸（dawview 只做对齐，不做变速拉伸，和宿主里关掉音乐模式的音频一致）。
 *   片段在界面上的宽度 = [起点秒, 起点秒 + lengthSec) 这段真实时间换算回 tick 的宽度。
 */

const AUDIO_MIN_LEN = 0.05;        // 单段最短长度（秒）：再短就没法拖了
const AUDIO_PEAK_BUCKETS = 4096;   // 波形峰值桶数（整个文件）
const AUDIO_MAX_BYTES = 512 * 1024 * 1024;   // 单个文件上限（前端先拦一道）
const AUDIO_EXT_RE = /\.(mp3|wav|wave|ogg|oga|opus|flac|m4a|aac|aif|aiff|weba)$/i;

function audioClamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// 文件扩展名认不认（前端先过滤，服务端还会再卡一遍）
function audioExtOk(name) {
  return AUDIO_EXT_RE.test(String(name || ''));
}

/* ------------------------------------------------------------ tick <-> 秒 */

function audioSecAtTick(tempo, tick) {
  return tempo ? tempo.secAt(tick) : Number(tick || 0) / 480;
}

function audioStartSec(tempo, clip) {
  return audioSecAtTick(tempo, clip.startTick);
}

function audioEndSec(tempo, clip) {
  return audioStartSec(tempo, clip) + Number(clip.lengthSec || 0);
}

// 片段右缘的 tick：由"开始秒 + 取多长"反算 —— 播放和画法用的是同一套数学
function audioEndTick(tempo, clip) {
  if (!tempo) return Number(clip.startTick || 0) + 1;
  return tempo.tickAtSec(audioEndSec(tempo, clip));
}

function audioSnapTick(tick, gridTicks) {
  if (!(gridTicks > 0)) return tick;
  return Math.round(tick / gridTicks) * gridTicks;
}

/* ---------------------------------------------------------- 移动 / 裁剪 */

// 挪位置：只改 tick（内容跟着整体走）
function audioMoveTo(clip, tick) {
  return Object.assign({}, clip, { startTick: Math.max(0, Math.round(tick)) });
}

// 左裁剪：拖左缘到 newStartTick。**内容在时间轴上不动** ——
// 起点往右挪多少秒，就从源文件里多跳过多少秒（长度同步减掉）；
// 往左拉出去也只能拉到源文件开头为止（srcOffset 不能为负）。
// 起点先夹到 >= 0：时间轴没有负 tick，拿负数算 delta 会把内容错位。
function audioTrimLeft(tempo, clip, newStartTick, srcDur) {
  const dur = Number(srcDur) > 0 ? Number(srcDur) : Infinity;
  const startTick = Math.max(0, Math.round(Number(newStartTick) || 0));
  const delta = audioSecAtTick(tempo, startTick) - audioStartSec(tempo, clip);
  const step = audioClamp(delta, -clip.srcOffsetSec, clip.lengthSec - AUDIO_MIN_LEN);
  const offset = clip.srcOffsetSec + step;
  const length = audioClamp(clip.lengthSec - step, AUDIO_MIN_LEN, Math.max(AUDIO_MIN_LEN, dur - offset));
  return Object.assign({}, clip, {
    startTick,
    srcOffsetSec: Math.round(offset * 1e6) / 1e6,
    lengthSec: Math.round(length * 1e6) / 1e6,
  });
}

// 右裁剪：拖右缘到 newEndTick，只改长度（起点与源内偏移都不动）
function audioTrimRight(tempo, clip, newEndTick, srcDur) {
  const dur = Number(srcDur) > 0 ? Number(srcDur) : Infinity;
  const length = audioClamp(audioSecAtTick(tempo, newEndTick) - audioStartSec(tempo, clip),
                            AUDIO_MIN_LEN, Math.max(AUDIO_MIN_LEN, dur - clip.srcOffsetSec));
  return Object.assign({}, clip, { lengthSec: Math.round(length * 1e6) / 1e6 });
}

/* ------------------------------------------------------------ 播放排期 */

/* 从"工程第 fromSec 秒"开始播，算出每个片段该怎么起：
 *   when      距离现在多久开始（墙钟秒；播放速度 x2 时工程时间走得快两倍）
 *   offsetSec 从源文件第几秒开始取
 *   durSec    取多长（源文件秒）
 *   rate      播放速率（= 播放速度倍率：慢了声音也慢，和宿主里一样是磁带式变速）
 * 纯函数：输入够就行，不碰 AudioContext —— 验证脚本直接比对这条排期。
 */
function audioPlan(lanes, tempo, fromSec, speed) {
  const rate = speed > 0 ? speed : 1;
  const out = [];
  for (const lane of lanes || []) {
    if (!lane || lane.muted) continue;
    for (const clip of lane.clips || []) {
      const startSec = audioStartSec(tempo, clip);
      const endSec = startSec + Number(clip.lengthSec || 0);
      if (!(endSec > fromSec)) continue;                 // 已经过去了
      const late = Math.max(0, fromSec - startSec);      // 从片段中间开始播
      const entry = {
        laneId: lane.id, clipId: clip.id, file: clip.file, rate,
        when: (startSec - fromSec) / rate,
        offsetSec: Number(clip.srcOffsetSec || 0) + late,
        durSec: endSec - startSec - late,
      };
      if (entry.durSec > 0.002) out.push(entry);
    }
  }
  return out.sort((a, b) => a.when - b.when);
}

/* ------------------------------------------------------------ 数据收窄 */

// 服务端已经收窄过一遍，这里再夹一次：前端也得能扛住手改过的 sidecar
function normAudioLanes(raw) {
  if (!Array.isArray(raw)) return [];
  const lanes = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' && item.id ? item.id : `al${lanes.length + 1}`;
    const clips = [];
    for (const c of Array.isArray(item.clips) ? item.clips : []) {
      if (!c || typeof c !== 'object') continue;
      if (typeof c.file !== 'string' || !/^media\/[A-Za-z0-9._-]+$/.test(c.file)) continue;
      const length = Number(c.lengthSec);
      if (!isFinite(length) || length <= 0) continue;
      const clip = {
        id: typeof c.id === 'string' && c.id ? c.id : `ac${clips.length + 1}`,
        name: typeof c.name === 'string' ? c.name : c.file.split('/').pop(),
        file: c.file,
        startTick: Math.max(0, Math.round(Number(c.startTick) || 0)),
        srcOffsetSec: Math.max(0, Number(c.srcOffsetSec) || 0),
        lengthSec: length,
      };
      if (isFinite(Number(c.srcDurSec)) && Number(c.srcDurSec) > 0) clip.srcDurSec = Number(c.srcDurSec);
      clips.push(clip);
    }
    lanes.push({
      id, name: typeof item.name === 'string' && item.name ? item.name : `音频 ${lanes.length + 1}`,
      muted: !!item.muted, clips,
    });
  }
  return lanes;
}

/* ---------------------------------------------------- 波形峰值（画波形用） */

/* 把解码出来的声道压成 buckets 个 min/max 桶 —— 画波形时按像素列取即可。
 * 一列一列扫原始样本会卡（5 分钟的文件 1300 万采样），预处理一次就够。 */
function computePeaks(channels, buckets = AUDIO_PEAK_BUCKETS) {
  const n = channels[0] ? channels[0].length : 0;
  const mins = new Float32Array(buckets);
  const maxs = new Float32Array(buckets);
  if (!n) return { min: mins, max: maxs, buckets };
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * n) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets));
    let lo = 1;
    let hi = -1;
    for (const ch of channels) {
      for (let i = from; i < to && i < n; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    mins[b] = lo === 1 ? 0 : lo;
    maxs[b] = hi === -1 ? 0 : hi;
  }
  return { min: mins, max: maxs, buckets };
}

// 取 [f0, f1) 这段（0..1 的源内比例）在 buckets 里的极值
function peakRange(peaks, f0, f1) {
  const b = peaks.buckets;
  let b0 = Math.floor(audioClamp(f0, 0, 1) * b);
  let b1 = Math.ceil(audioClamp(f1, 0, 1) * b);
  if (b1 <= b0) b1 = b0 + 1;
  let lo = 0;
  let hi = 0;
  for (let i = b0; i < b1 && i < b; i++) {
    if (i < 0) continue;
    if (peaks.min[i] < lo) lo = peaks.min[i];
    if (peaks.max[i] > hi) hi = peaks.max[i];
  }
  return [lo, hi];
}

/* ---------------------------------------------------------------- 播放引擎 */

/* 一份 AudioContext + 文件缓存。加载走 /media/<名字>（本地服务），
 * 解码后缓存峰值，画波形和播放共用同一份 AudioBuffer。 */
const audioEngine = {
  ctx: null,
  master: null,
  buffers: new Map(),        // file -> {buffer, peaks, durSec}
  failed: new Map(),         // file -> 错误原因（界面上标"文件缺失 / 解不了"）
  loading: new Map(),        // file -> Promise（同一份别重复下）
  sources: [],
  lastPlan: [],
  plays: 0,

  available() {
    return typeof (window.AudioContext || window.webkitAudioContext) === 'function';
  },

  // 尽量早建上下文：浏览器的自动播放策略要求"用户操作过"才能出声，
  // 但解码不需要出声，所以导入时就建（此时已经有点击/拖放了）。
  ensureCtx() {
    if (this.ctx) return this.ctx;
    if (!this.available()) return null;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  },

  info(file) {
    return this.buffers.get(file) || null;
  },

  error(file) {
    return this.failed.get(file) || '';
  },

  // 下载 + 解码一份音频；返回 null 表示这份用不了（原因记在 failed 里）
  async load(file) {
    if (this.buffers.has(file)) return this.buffers.get(file);
    if (this.loading.has(file)) return this.loading.get(file);
    const job = (async () => {
      const ctx = this.ensureCtx();
      if (!ctx) throw new Error('这个浏览器没有 Web Audio');
      const res = await fetch(`/media/${encodeURIComponent(file.split('/').pop())}`,
                              { cache: 'force-cache' });
      if (!res.ok) throw new Error(`读不到音频文件（HTTP ${res.status}）`);
      const bytes = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      const channels = [];
      for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
      const info = { buffer, peaks: computePeaks(channels), durSec: buffer.duration };
      this.buffers.set(file, info);
      this.failed.delete(file);
      return info;
    })().catch((err) => {
      this.failed.set(file, err && err.message ? err.message : String(err));
      return null;
    }).finally(() => this.loading.delete(file));
    this.loading.set(file, job);
    return job;
  },

  // 把这份 lanes 里所有片段的文件都加载一遍；每加载好一份就回调一次（界面重画波形）
  async loadAll(lanes, onOne) {
    const files = [...new Set((lanes || []).flatMap((l) => (l.clips || []).map((c) => c.file)))];
    await Promise.all(files.map(async (f) => {
      await this.load(f);
      if (typeof onOne === 'function') onOne(f);
    }));
    return files.length;
  },

  /* 从"当前播放头位置"起播。plan 由 audioPlan() 算好（纯函数，可单独验）。
   * 留 60ms 提前量：立刻起播的片段排在 ctx 时钟的未来一点，避免 "start 时刻已过" 的咔哒。 */
  play(plan, offsetSec = 0.06) {
    this.stop();
    const ctx = this.ensureCtx();
    if (!ctx || !plan || !plan.length) return 0;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + Math.max(0, offsetSec);
    let started = 0;
    for (const e of plan) {
      const info = this.buffers.get(e.file);
      if (!info) continue;                                  // 还没加载好：这一份这次不响
      const dur = info.buffer.duration;
      const offset = audioClamp(e.offsetSec, 0, Math.max(0, dur - 0.001));
      const length = Math.min(e.durSec, dur - offset);
      if (length <= 0.002) continue;
      const src = ctx.createBufferSource();
      src.buffer = info.buffer;
      src.playbackRate.value = e.rate;
      src.connect(this.master);
      try {
        src.start(t0 + Math.max(0, e.when), offset, length);
      } catch (err) {
        continue;                                           // 参数越界之类：跳过这一份
      }
      this.sources.push(src);
      started++;
    }
    this.lastPlan = plan;
    if (started) this.plays++;
    return started;
  },

  stop() {
    for (const src of this.sources) {
      try { src.stop(); } catch (err) { /* 已经停了 */ }
      try { src.disconnect(); } catch (err) { /* 忽略 */ }
    }
    this.sources = [];
  },

  // 验证脚本读它：当前有几路在响、上下文状态、缓存了哪些文件
  snapshot() {
    const files = [];
    for (const [file, info] of this.buffers) {
      files.push({ file, durSec: Math.round(info.durSec * 1000) / 1000 });
    }
    return {
      ready: !!this.ctx,
      state: this.ctx ? this.ctx.state : 'none',
      sampleRate: this.ctx ? this.ctx.sampleRate : 0,
      now: this.ctx ? Math.round(this.ctx.currentTime * 1000) / 1000 : 0,
      sources: this.sources.length,
      plays: this.plays,
      files,
      failed: [...this.failed.entries()],
      lastPlan: this.lastPlan.map((e) => ({
        clipId: e.clipId, file: e.file,
        when: Math.round(e.when * 1000) / 1000,
        offsetSec: Math.round(e.offsetSec * 1000) / 1000,
        durSec: Math.round(e.durSec * 1000) / 1000,
        rate: e.rate,
      })),
    };
  },
};

if (typeof module !== 'undefined') {
  module.exports = {
    AUDIO_MIN_LEN, AUDIO_PEAK_BUCKETS, AUDIO_MAX_BYTES, audioExtOk,
    audioSecAtTick, audioStartSec, audioEndSec, audioEndTick, audioSnapTick,
    audioMoveTo, audioTrimLeft, audioTrimRight, audioPlan,
    normAudioLanes, computePeaks, peakRange, audioEngine,
  };
}
