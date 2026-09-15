/*
 * sfx.js —— 程序化音效引擎
 *
 * 不加载任何音频文件。全部由 Web Audio 的噪声源 + 滤波器 + 包络实时合成：
 *   翻页沙沙声 = 白噪声 → 带通扫频（1700 → 3600Hz）
 *   落页定音   = 低通噪声 + 128 → 56Hz 正弦短促下坠
 *   开书声     = 低频噪声缓入缓出 + 尾部轻 thud
 *
 * 每次触发施加 ±15% 的随机扰动，避免连续翻页时听出机械重复。
 *
 * AudioContext 必须在用户手势中创建/恢复，因此由「翻开封面」那一次点击来解锁。
 */
(function (global) {
  'use strict';

  var NOISE_SECONDS = 2;

  var SFX = {
    ctx: null,
    master: null,
    comp: null,
    _noise: null,

    enabled: true,
    supported: true,
    unlocked: false,

    /* ---------------------------------------------------------------- 基础 */

    init: function () {
      if (this.ctx) return this.ctx;
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) { this.supported = false; return null; }

      try {
        this.ctx = new AC();
      } catch (e) {
        this.supported = false;
        return null;
      }

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;

      /* 连翻时多个音效会叠加，挂一个压缩器兜底防削波 */
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -12;
      this.comp.ratio.value = 6;
      this.comp.attack.value = 0.003;
      this.comp.release.value = 0.12;

      this.master.connect(this.comp);
      this.comp.connect(this.ctx.destination);

      this._noise = this._makeNoise(NOISE_SECONDS);
      return this.ctx;
    },

    unlock: function () {
      var ctx = this.init();
      if (!ctx) return;
      this.unlocked = true;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    },

    setEnabled: function (on) {
      this.enabled = !!on;
      if (this.enabled) this.unlock();
      return this.enabled;
    },

    toggle: function () {
      return this.setEnabled(!this.enabled);
    },

    _ready: function () {
      if (!this.enabled) return false;
      var ctx = this.init();
      if (!ctx) return false;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return true;
    },

    /* 预生成一段白噪声，所有音效复用同一个 buffer（随机取起点） */
    _makeNoise: function (sec) {
      var len = Math.floor(this.ctx.sampleRate * sec);
      var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    },

    /* 一段带滤波扫频与包络的噪声 */
    _noiseHit: function (t, dur, opt) {
      var ctx = this.ctx;
      var src = ctx.createBufferSource();
      src.buffer = this._noise;
      src.loop = true;

      var offset = Math.random() * Math.max(0, NOISE_SECONDS - dur - 0.05);

      var filt = ctx.createBiquadFilter();
      filt.type = opt.type || 'bandpass';
      filt.Q.value = opt.q || 0.8;

      var f0 = Math.max(40, opt.f0 || 1800);
      filt.frequency.setValueAtTime(f0, t);
      if (opt.f1) {
        filt.frequency.exponentialRampToValueAtTime(
          Math.max(40, opt.f1), t + dur);
      }

      var g = ctx.createGain();
      var peak = Math.max(0.0002, opt.peak || 0.25);
      var attack = opt.attack || 0.012;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      src.connect(filt);
      filt.connect(g);
      g.connect(this.master);

      src.start(t, offset);
      src.stop(t + dur + 0.03);
    },

    /* 低频下坠的闷响 */
    _thud: function (t, f0, f1, dur, peak) {
      var ctx = this.ctx;
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + dur);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },

    /* -------------------------------------------------------------- 音效库 */

    /* 翻页沙沙声。intensity 用于快速连翻时统一压低音量 */
    playFlip: function (intensity) {
      if (!this._ready()) return;
      var t = this.ctx.currentTime;
      var v = 1 + (Math.random() - 0.5) * 0.3;
      var k = (intensity == null) ? 1 : intensity;
      var dur = 0.17 / v;

      this._noiseHit(t, dur, {
        type: 'bandpass',
        f0: 1700 * v, f1: 3600 * v, q: 0.8,
        peak: 0.24 * k, attack: 0.012
      });

      /* 叠一层高频摩擦细节，让"纸"的颗粒感更强 */
      this._noiseHit(t + 0.008, 0.055, {
        type: 'highpass',
        f0: 4300 * v, q: 0.7,
        peak: 0.072 * k, attack: 0.004
      });
    },

    /* 落页定音：纸拍在对面页上 */
    playLand: function () {
      if (!this._ready()) return;
      var t = this.ctx.currentTime;
      var v = 1 + (Math.random() - 0.5) * 0.24;

      this._noiseHit(t, 0.1, {
        type: 'lowpass', f0: 1300 * v, q: 0.7,
        peak: 0.3, attack: 0.006
      });
      this._thud(t, 128 * v, 56 * v, 0.11, 0.2);
    },

    /* 开书：封面掀开的低频摩擦 + 落定 */
    playOpen: function () {
      if (!this._ready()) return;
      var t = this.ctx.currentTime;
      var v = 1 + (Math.random() - 0.5) * 0.2;

      this._noiseHit(t, 0.46, {
        type: 'lowpass', f0: 460 * v, f1: 240 * v, q: 0.9,
        peak: 0.22, attack: 0.09
      });
      this._noiseHit(t + 0.05, 0.3, {
        type: 'bandpass', f0: 1200 * v, f1: 2200 * v, q: 0.9,
        peak: 0.085, attack: 0.1
      });
      this._thud(t + 0.42, 96 * v, 44 * v, 0.16, 0.14);
    },

    /* 合书：短促、更闷 */
    playClose: function () {
      if (!this._ready()) return;
      var t = this.ctx.currentTime;
      var v = 1 + (Math.random() - 0.5) * 0.2;

      this._noiseHit(t, 0.2, {
        type: 'lowpass', f0: 380 * v, f1: 160 * v, q: 0.9,
        peak: 0.22, attack: 0.05
      });
      this._thud(t + 0.16, 110 * v, 48 * v, 0.15, 0.18);
    },

    /* 答案浮现：极轻的纸面呼吸声，几乎只是"有一点动静" */
    playBreath: function () {
      if (!this._ready()) return;
      var t = this.ctx.currentTime;
      var v = 1 + (Math.random() - 0.5) * 0.2;

      this._noiseHit(t, 0.34, {
        type: 'bandpass', f0: 900 * v, f1: 1900 * v, q: 1.1,
        peak: 0.05, attack: 0.12
      });
    }
  };

  global.SFX = SFX;
})(window);
