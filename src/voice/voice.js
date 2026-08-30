// src/voice/voice.js — 傩文化数字博物馆 · 语音科普交互模块（自包含，无外部依赖）
//
// 用法（在 main.js 中集成）:
//   import { initVoiceGuide } from './voice/voice.js';
//   initVoiceGuide();            // 返回调试句柄, 同时挂 window.__voiceGuide
//
// 知识库: ./kb.json (与音频 public/audio/tts/{id}.mp3 一一对应)
// 交互: 点击按钮开启麦克风 → 说问题 → 关键词匹配 → 播放对应 mp3 + 显示讲解稿 8 秒
// 状态机: idle → listening → thinking → speaking → listening …（手动关闭回到 idle）

import kb from './kb.json';

const GOLD = '#e8e8e8';
const GOLD_DIM = 'rgba(232,232,232,.4)';
const AUDIO_DIR = 'audio/tts'; // public 目录, 运行时按 document.baseURI 解析(兼容子路径部署)
const TEXT_SHOW_MS = 8000;     // 讲解文本展示时长

const STATE = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
};

let handle = null; // 单例句柄, 防止重复 init

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function audioUrl(id) {
  try {
    return new URL(`${AUDIO_DIR}/${id}.mp3`, document.baseURI).href;
  } catch {
    return `${AUDIO_DIR}/${id}.mp3`;
  }
}

/** 归一化文本: 去空白与标点, 便于包含匹配 */
function normalize(text) {
  return String(text || '')
    .replace(/[\s，。？！、；：,.!?;:~～"'“”‘’()（）【】\[\]]/g, '');
}

/** 关键词匹配: 命中 keyword 数最多者胜, 平局比命中词总长度 */
function matchEntry(rawText) {
  const text = normalize(rawText);
  if (!text) return null;
  let best = null;
  let bestHits = 0;
  let bestLen = 0;
  for (const entry of kb) {
    if (entry.id === 'fallback' || !Array.isArray(entry.keywords)) continue;
    let hits = 0;
    let len = 0;
    for (const kw of entry.keywords) {
      const k = normalize(kw);
      if (k && text.includes(k)) {
        hits += 1;
        len += k.length;
      }
    }
    if (hits > 0 && (hits > bestHits || (hits === bestHits && len > bestLen))) {
      best = entry;
      bestHits = hits;
      bestLen = len;
    }
  }
  return best;
}

function getFallback() {
  return kb.find((e) => e.id === 'fallback') || { id: 'fallback', answer: '请换个问法试试。' };
}

/* ------------------------------------------------------------------ */
/* UI 构造（vg- 前缀, 样式全部注入, 不污染宿主页面）                        */
/* ------------------------------------------------------------------ */

const CSS = `
.vg-root {
  position: fixed;
  right: calc(340px + 24px); /* 避开右侧 340px 面板 */
  bottom: 24px;              /* 避开左下 150px 手部视图(右下角无冲突) */
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Helvetica Neue', Arial, sans-serif;
  pointer-events: none;
  user-select: none;
}
@media (max-width: 900px) {
  .vg-root { right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); }
}
.vg-root * { pointer-events: auto; }

.vg-bubble { position:relative;
  max-width: min(340px, 72vw);
  max-height: 42vh;
  overflow-y: auto;
  padding: 10px 14px;
  background: rgba(26, 26, 26, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  color: #efefef;
  font-size: 13px;
  line-height: 1.7;
  letter-spacing: 0.5px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25);
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 0.35s ease, transform 0.35s ease;
  pointer-events: none;
}
.vg-bubble.vg-show { opacity: 1; transform: translateY(0); pointer-events: auto; }
.vg-bubble .vg-q {
  display: block;
  color: ${GOLD};
  font-size: 12px;
  opacity: 0.85;
  margin-bottom: 4px;
}

.vg-btn {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 1.5px solid ${GOLD_DIM};
  background: rgba(18, 10, 6, 0.82);
  color: ${GOLD};
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5), inset 0 0 12px rgba(217, 176, 108, 0.08);
  transition: border-color 0.3s ease, box-shadow 0.3s ease, transform 0.15s ease;
  -webkit-tap-highlight-color: transparent;
}
.vg-btn:hover { border-color: ${GOLD}; }
.vg-btn:active { transform: scale(0.94); }
.vg-btn svg { width: 24px; height: 24px; display: block; }
.vg-btn.vg-disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* listening: 金色呼吸 */
.vg-btn.vg-listening {
  border-color: ${GOLD};
  animation: vg-breathe 1.8s ease-in-out infinite;
}
@keyframes vg-breathe {
  0%, 100% { box-shadow: 0 0 0 0 rgba(217, 176, 108, 0.45), 0 4px 18px rgba(0, 0, 0, 0.5); }
  50%      { box-shadow: 0 0 0 12px rgba(217, 176, 108, 0.0), 0 4px 22px rgba(217, 176, 108, 0.35); }
}

/* thinking: 边框旋转微光 */
.vg-btn.vg-thinking {
  border-color: ${GOLD};
  animation: vg-think 1s linear infinite;
}
@keyframes vg-think {
  0%   { box-shadow: 0 0 6px 0 rgba(217, 176, 108, 0.25); }
  50%  { box-shadow: 0 0 16px 4px rgba(217, 176, 108, 0.45); }
  100% { box-shadow: 0 0 6px 0 rgba(217, 176, 108, 0.25); }
}

/* speaking: 波形字符 ~ */
.vg-wave {
  display: inline-flex;
  gap: 3px;
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}
.vg-wave span {
  display: inline-block;
  color: ${GOLD};
  animation: vg-wave 0.9s ease-in-out infinite;
}
.vg-wave span:nth-child(2) { animation-delay: 0.15s; }
.vg-wave span:nth-child(3) { animation-delay: 0.3s; }
@keyframes vg-wave {
  0%, 100% { transform: translateY(3px); opacity: 0.5; }
  50%      { transform: translateY(-3px); opacity: 1; }
}
`;

const MIC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="9" y="2.5" width="6" height="11" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0"/>
  <line x1="12" y1="18" x2="12" y2="21.5"/>
</svg>`;

const WAVE_SVG = `<span class="vg-wave"><span>~</span><span>~</span><span>~</span></span>`;

/* ------------------------------------------------------------------ */
/* 模块主体                                                            */
/* ------------------------------------------------------------------ */

export function initVoiceGuide() {
  if (handle) return handle; // 幂等

  /* ---------- 样式注入 ---------- */
  const style = document.createElement('style');
  style.id = 'vg-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  /* ---------- DOM ---------- */
  const root = document.createElement('div');
  root.className = 'vg-root';
  root.innerHTML = `
    <div class="vg-bubble" role="status" aria-live="polite"></div>
    <button class="vg-btn" type="button" aria-label="语音讲解开关">${MIC_SVG}</button>
  `;
  document.body.appendChild(root);
  const bubble = root.querySelector('.vg-bubble');
  const btn = root.querySelector('.vg-btn');

  /* ---------- 内部状态 ---------- */
  let state = STATE.IDLE;        // idle | listening | thinking | speaking
  let sessionActive = false;     // true = 用户开启会话(自动重开麦克风)
  let suppressRestart = false;   // 播报期间主动 stop, 不触发自动重开
  let unlocked = false;          // 首次手势后音频已解锁
  let recognition = null;
  let audio = null;              // 当前播放的 Audio(打断上一条)
  let textTimer = 0;

  /* ---------- 状态机 ---------- */
  function setState(next) {
    state = next;
    btn.classList.remove('vg-listening', 'vg-thinking');
    if (next === STATE.LISTENING) {
      btn.classList.add('vg-listening');
      btn.innerHTML = MIC_SVG;
      setBubble('正在聆听，请说出您的问题…', '', true);
    } else if (next === STATE.THINKING) {
      btn.classList.add('vg-thinking');
      btn.innerHTML = MIC_SVG;
      setBubble('正在思考…', '', true);
    } else if (next === STATE.SPEAKING) {
      btn.innerHTML = WAVE_SVG;
    } else {
      btn.innerHTML = MIC_SVG;
    }
  }

  function setBubble(text, question, sticky, skippable) {
    clearTimeout(textTimer);
    const skip = skippable
      ? '<button class="vg-skip" aria-label="跳过讲解" title="跳过">✕</button>'
      : '';
    bubble.innerHTML = (question ? `<span class="vg-q">您问：${escapeHtml(question)}</span>` : '') + escapeHtml(text) + skip;
    bubble.classList.add('vg-show');
    const skipBtn = bubble.querySelector('.vg-skip');
    if (skipBtn) {
      skipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (audio) {
          audio.onended = null;
          audio.onerror = null;
          duckBgm(false);
          try { audio.pause(); } catch { /* 忽略 */ }
        }
        hideBubble();
        if (sessionActive) startListening();
        else setState(STATE.IDLE);
      });
    }
    if (!sticky) {
      textTimer = setTimeout(() => bubble.classList.remove('vg-show'), TEXT_SHOW_MS);
    }
  }

  function hideBubble() {
    clearTimeout(textTimer);
    bubble.classList.remove('vg-show');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------- 音频 ---------- */
  function unlockAudio() {
    if (unlocked) return;
    unlocked = true;
    try {
      // 首次用户手势内播放极短静音, 解锁后续程序化播放(浏览器自动播放策略)
      const silent = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
      silent.volume = 0;
      silent.play().then(() => silent.pause()).catch(() => {});
    } catch { /* 忽略 */ }
  }

  function duckBgm(on) {
    const bgm = window.__bgm;
    if (!bgm) return;
    try {
      if (on) {
        bgm._savedVol = bgm.volume;
        bgm.volume = Math.min(bgm.volume, 0.07);
      } else if (bgm._savedVol !== undefined) {
        bgm.volume = bgm._savedVol;
        delete bgm._savedVol;
      }
    } catch { /* 忽略 */ }
  }

  function playEntry(entry, question) {
    try {
      if (audio) {
        // 先摘回调再清 src: 防 error 异步派发穿透到 done() 重开麦克风(自听自答)
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.src = '';
      }
      duckBgm(true);
      audio = new Audio(audioUrl(entry.id));
      audio.play().catch(() => { /* 播放失败时至少保留文本 */ });

      setState(STATE.SPEAKING);
      setBubble(entry.answer, question, true, true);

      const done = () => {
        if (state !== STATE.SPEAKING) return;
        duckBgm(false);
        if (sessionActive) startListening();
        else setState(STATE.IDLE);
      };
      audio.onended = done;
      audio.onerror = done;
    } catch {
      // 音频异常: 仍展示文本, 会话继续
      setState(STATE.SPEAKING);
      setBubble(entry.answer, question, false);
      setTimeout(() => {
        if (sessionActive) startListening();
        else setState(STATE.IDLE);
      }, 2500);
    }
  }

  /* ---------- 语音识别 ---------- */
  function getRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function startListening() {
    if (!getRecognitionCtor()) return;
    try {
      if (!recognition) {
        const Ctor = getRecognitionCtor();
        recognition = new Ctor();
        recognition.lang = 'zh-CN';
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onresult = (event) => {
          try {
            const transcript = event.results?.[0]?.[0]?.transcript || '';
            if (!transcript) return;
            setState(STATE.THINKING);
            stopRecognition(); // 播报期间暂停收音, 避免拾取自身声音
            const entry = matchEntry(transcript) || getFallback();
            playEntry(entry, transcript);
          } catch (err) {
            console.warn('[voiceGuide] onresult error:', err);
            if (sessionActive) startListening();
          }
        };

        recognition.onerror = (event) => {
          try {
            const code = event?.error || 'unknown';
            if (code === 'no-speech' || code === 'aborted') return; // onend 会重开
            if (code === 'not-allowed' || code === 'service-not-allowed') {
              sessionActive = false;
              setState(STATE.IDLE);
              setBubble('麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试。', '', false);
            } else if (code === 'audio-capture') {
              sessionActive = false;
              setState(STATE.IDLE);
              setBubble('未检测到麦克风设备，无法开启语音讲解。', '', false);
            } else if (code === 'network') {
              sessionActive = false; // 防止 onend 无限重开
              setState(STATE.IDLE);
              setBubble('语音服务网络异常，请检查网络后再试。', '', false);
            }
          } catch (err) {
            console.warn('[voiceGuide] onerror handle failed:', err);
          }
        };

        recognition.onend = () => {
          // 自动重开, 除非手动关闭或正在播报(播报结束由 playEntry 负责重开)
          if (sessionActive && !suppressRestart && state === STATE.LISTENING) {
            try { recognition.start(); } catch { /* 连续 start 抛错时忽略 */ }
          }
        };
      }
      suppressRestart = false;
      recognition.start();
      setState(STATE.LISTENING);
    } catch (err) {
      console.warn('[voiceGuide] startListening failed:', err);
      // 冷启动竞态: start 未落定前再次 start 会抛 InvalidStateError, 稍后由 onend 兜底
    }
  }

  function stopRecognition() {
    suppressRestart = true;
    try { recognition?.stop(); } catch { /* 忽略 */ }
  }

  /* ---------- 会话开关 ---------- */
  function open() {
    unlockAudio();
    sessionActive = true;
    startListening();
  }

  function close() {
    sessionActive = false;
    stopRecognition();
    if (audio) { try { audio.pause(); } catch { /* 忽略 */ } }
    setState(STATE.IDLE);
    hideBubble();
  }

  function toggle() {
    if (!getRecognitionCtor()) {
      setBubble('本浏览器不支持语音识别，建议使用 Chrome 或 Edge。', '', false);
      return;
    }
    if (sessionActive) close();
    else open();
  }

  btn.addEventListener('click', () => {
    try { toggle(); } catch (err) { console.warn('[voiceGuide] toggle failed:', err); }
  });

  /* ---------- 不支持语音识别时 ---------- */
  if (!getRecognitionCtor()) {
    btn.classList.add('vg-disabled');
    btn.title = '本浏览器不支持语音识别';
    setBubble('本浏览器不支持语音，建议使用 Chrome 或 Edge 访问。', '', false);
  }

  /* ---------- 调试句柄 ---------- */
  handle = {
    version: '1.0.0',
    kb,
    get state() { return state; },
    get sessionActive() { return sessionActive; },
    elements: { root, btn, bubble },
    open,
    close,
    toggle,
    play: (id) => {
      const entry = kb.find((e) => e.id === id);
      if (entry) { unlockAudio(); playEntry(entry, ''); }
    },
    ask: (text) => { // 调试: 模拟一次提问
      const entry = matchEntry(text) || getFallback();
      unlockAudio();
      playEntry(entry, text);
      return entry.id;
    },
    match: matchEntry,
  };
  window.__voiceGuide = handle;
  return handle;
}

export default initVoiceGuide;
