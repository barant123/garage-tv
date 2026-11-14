/* Garage TV canvas player: drive-mode playback without a <video> element.

   The Tesla browser pauses <video> elements while the car is in Drive. This player never
   creates one. Pipeline:
     fetch HLS playlist -> fetch MPEG-TS segments -> demux (H.264 + AAC/MP3)
       video: WebCodecs VideoDecoder in a Worker -> OffscreenCanvas (or posted frames -> canvas)
       audio: WebCodecs AudioDecoder (or decodeAudioData) -> Web Audio, which also drives the clock
     frames are presented with setTimeout against the audio clock, so A/V stay in sync.

   API (window.CanvasPlayer):
     CanvasPlayer.supported()       true when this browser has what the player needs
     CanvasPlayer.isCarBrowser()    rough guess that this is a car browser (Tesla / QtCarBrowser / plain Linux Chrome)
     CanvasPlayer.unlockAudio()     call inside a tap so the AudioContext may start
     const p = CanvasPlayer.create(canvas, { onPlaying, onError, onEnded, onInfo })
     p.load(url, { relay, maxHeight, forceRelay })   start (stops anything already playing)
     p.stop()                        stop and free everything; the player can load() again
     p.playing, p.currentTime        state for the page (currentTime = seconds of media played)

   Limits: H.264 video only (no HEVC), AAC or MP3 audio (AC-3 plays silent), TS segments only
   (no fMP4 / CMAF). AES-128 encrypted HLS works; SAMPLE-AES and DRM do not.
   p.pause() / p.resume(); p.seek(sec) inside a finished or growing (EVENT) playlist (p.seekable).
   Original code written for Garage TV. */

(function (global) {
'use strict';

/* ======================================================================
   WORKER (stringified into a Blob so the page stays one script file)
   ====================================================================== */
function workerMain() {
  'use strict';
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const WRAP = 8589934592; // 2^33, PTS wrap
  let S = null;

  const post = (o, tr) => self.postMessage(o, tr || []);
  const now = () => performance.timeOrigin + performance.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hex = n => n.toString(16).padStart(2, '0');

  self.onmessage = e => {
    const m = e.data || {};
    if (m.t === 'start') start(m);
    else if (m.t === 'clock' && S) { S.aClock = m.m; S.aEnd = m.end; S.aAt = m.at; }
    else if (m.t === 'audioFailed' && S) { S.hasAudio = false; }
    else if (m.t === 'pause' && S) setPaused(!!m.on);
    else if (m.t === 'seek' && S && !S.progressive && !S.live) { S.gen = m.gen; S.seekTo = Math.max(0, +m.to || 0); S.seekDrop = S.seekTo; if (S.paused) S.pauseC = S.seekTo; }
    else if (m.t === 'stop') { stop(); self.close(); }
  };

  function start(m) {
    stop();
    S = {
      url: m.url, relay: (m.relay || '').replace(/\/+$/, ''), httpsPage: !!m.httpsPage, maxH: m.maxHeight || 720,
      viaRelay: !!(m.forceRelay && m.relay), ac: new AbortController(), stopped: false,
      canvas: m.canvas || null, ctx: null,
      dmx: { pmt: -1, vpid: -1, apid: -1, atype: '', pes: {} },
      vq: [], aq: [], fq: [], dec: null, sps: null, pps: null, cfgDirty: true, needKey: true, decErrors: 0,
      ref: null, base: null, off: 0, lastEnd: null, discPending: false,
      hasAudio: false, aClock: null, aEnd: null, aAt: 0, frozenSince: null, wall0: null, wallT0: 0,
      firstFrameAt: 0, started: false, preview: false, eos: false, frames: 0, dropped: 0, live: true,
      startedAt: now(), statAt: now(), statFrames: 0, lastBufState: '',
      paused: false, pauseC: 0, gen: 0, seekTo: null, seekDrop: null, avail: 0, plEnded: false,
    };
    if (S.canvas) { try { S.ctx = S.canvas.getContext('2d', { alpha: false }); } catch (_) { S.ctx = null; } }
    if (typeof VideoDecoder !== 'function') { fatal('VideoDecoder is not available in this browser'); return; }
    const me = S;
    loader().catch(e => { if (!me.stopped && S === me) fatal(e && e.message || String(e)); });
    tick();
  }

  function stop() {
    if (!S) return;
    S.stopped = true;
    try { S.ac.abort(); } catch (_) {}
    clearTimeout(S.timer);
    try { if (S.dec && S.dec.state !== 'closed') S.dec.close(); } catch (_) {}
    for (const f of S.fq) { try { f.close(); } catch (_) {} }
    S.fq = []; S.vq = []; S.aq = [];
    S = null;
  }

  function fatal(msg) { if (!S || S.stopped) return; post({ t: 'error', msg }); const s = S; stop(); void s; }

  // Pause freezes the presentation clock; the loader keeps filling the buffer up to its limit.
  function setPaused(on) {
    if (on === S.paused) return;
    if (on) { const c = clock(); S.pauseC = c == null ? (S.lastShown || 0) : c; S.paused = true; return; }
    S.paused = false; S.frozenSince = null;
    if (S.aClock != null) { S.aClock = S.pauseC; S.aAt = now(); }
    if (S.wall0 != null) { S.wall0 = now(); S.wallT0 = S.pauseC; }
    if (S.wc != null) S.wc = S.pauseC;
  }
  // Seek inside the playlist we already have: drop everything queued and restart from the segment
  // that holds the target time. Frames and audio before the target are decoded but not shown.
  function resetForSeek(to) {
    S.dmx.pes = {}; S.pendV = null; S.aq = []; S.vq = [];
    for (const f of S.fq) { try { f.close(); } catch (_) {} }
    S.fq = [];
    try { if (S.dec && S.dec.state !== 'closed') S.dec.close(); } catch (_) {}
    S.dec = null; S.cfgDirty = true; S.needKey = true;
    S.lastEnd = null; S.lastVraw = null; S.discPending = false; S.seekDrop = to;
    S.aClock = null; S.aEnd = null; S.wall0 = null; S.wc = null; S.frozenSince = null; S.firstFrameAt = 0;
    S.preview = false; S.eos = false; S.lastBufState = '';
    if (S.paused) S.pauseC = to;
  }

  /* ---------------- network ---------------- */
  const isRelayed = u => S.relay && u.startsWith(S.relay + '/');
  async function get(u, kind) {
    let tries = 0;
    for (;;) {
      if (!S || S.stopped) throw new Error('stopped');
      let target = u;
      const mustRelay = S.viaRelay || (S.httpsPage && /^http:/i.test(u));
      if (!isRelayed(u) && mustRelay) {
        if (!S.relay) throw new Error('plain http stream needs the media relay (Settings)');
        target = S.relay + '/media?u=' + encodeURIComponent(u);
      }
      // per-request timeout so one stuck segment cannot freeze the channel
      const ctl = new AbortController(), parent = S.ac.signal;
      const onAbort = () => ctl.abort();
      parent.addEventListener('abort', onAbort);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, kind === 'text' ? 10000 : 20000);
      try {
        const r = await fetch(target, { signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
        if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        if (kind === 'text' && /video\/mp2t|video\/MP2T|octet-stream/i.test(r.headers.get('Content-Type') || '')) {
          try { r.body.cancel(); } catch (_) {}
          const e = new Error('not an HLS playlist'); e.notM3U = true; throw e;
        }
        const body = kind === 'text' ? await r.text() : new Uint8Array(await r.arrayBuffer());
        return { body, base: target === u ? (r.url || u) : u };
      } catch (e0) {
        let e = e0;
        if (!S || S.stopped) throw e;
        if (timedOut) e = new Error('source too slow (timed out)');
        // a TypeError here is almost always CORS: switch the whole session to the relay
        if (e instanceof TypeError && !S.viaRelay && S.relay && !isRelayed(u)) { S.viaRelay = true; post({ t: 'info', relay: true }); continue; }
        if (e.notM3U) throw e;
        const st = e.status || 0;
        if (++tries > 3 || (st >= 400 && st < 500 && st !== 408 && st !== 429)) {
          if (e instanceof TypeError && !S.relay) e.message = 'blocked by the source (CORS); set the media relay in Settings';
          throw e;
        }
        await sleep(400 * tries);
      } finally {
        clearTimeout(timer);
        parent.removeEventListener('abort', onAbort);
      }
    }
  }

  /* ---------------- playlists ---------------- */
  function attrs(s) { const o = {}; s.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, (_, k, v) => { o[k] = v.replace(/^"|"$/g, ''); }); return o; }
  function parseM3U(text, base) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
      const e = new Error('not an HLS playlist'); e.notM3U = true; throw e;
    }
    const abs = u => new URL(u, base).href;
    const pl = { variants: [], segs: [], target: 6, seq: 0, ended: false, type: '', key: null, map: false };
    let inf = null, vattr = null, disc = false, key = null;
    for (const l of lines) {
      if (l.startsWith('#EXT-X-STREAM-INF:')) vattr = attrs(l.slice(18));
      else if (l.startsWith('#EXT-X-TARGETDURATION:')) pl.target = parseFloat(l.slice(22)) || 6;
      else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) pl.seq = parseInt(l.slice(22), 10) || 0;
      else if (l.startsWith('#EXT-X-ENDLIST')) pl.ended = true;
      else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) pl.type = l.slice(21).trim();
      else if (l.startsWith('#EXT-X-KEY:')) {
        const a = attrs(l.slice(11));
        if (!a.METHOD || a.METHOD === 'NONE') key = null;
        else if (a.METHOD === 'AES-128' && a.URI) key = { uri: abs(a.URI), iv: a.IV || '' };
        else pl.key = a.METHOD; // SAMPLE-AES / DRM: not playable here
      }
      else if (l.startsWith('#EXT-X-MAP:')) pl.map = true;
      else if (l === '#EXT-X-DISCONTINUITY') disc = true;
      else if (l.startsWith('#EXTINF:')) inf = parseFloat(l.slice(8)) || 0;
      else if (l[0] !== '#') {
        if (vattr) {
          pl.variants.push({ url: abs(l), bw: +vattr.BANDWIDTH || 0, h: +((vattr.RESOLUTION || '').split('x')[1]) || 0, codecs: vattr.CODECS || '' });
          vattr = null;
        } else {
          pl.segs.push({ url: abs(l), dur: inf == null ? pl.target : inf, sn: pl.seq + pl.segs.length, disc, key });
          inf = null; disc = false;
        }
      }
    }
    return pl;
  }
  function pickVariant(vs, maxH) {
    let c = vs.filter(v => !v.codecs || /avc[13]/i.test(v.codecs));
    c = c.filter(v => !(v.codecs && /mp4a/i.test(v.codecs) && !/avc/i.test(v.codecs)));
    if (!c.length) c = vs.filter(v => !/hvc1|hev1|av01|vp09/i.test(v.codecs));
    if (!c.length) throw new Error('stream offers no H.264 version');
    const fit = c.filter(v => !v.h || v.h <= maxH);
    if (fit.length) return fit.sort((a, b) => (b.h - a.h) || (b.bw - a.bw))[0];
    return c.sort((a, b) => (a.h - b.h) || (a.bw - b.bw))[0];
  }
  async function loadMedia(url) {
    let r = await get(url, 'text');
    let pl = parseM3U(r.body, r.base);
    if (pl.variants.length) {
      const v = pickVariant(pl.variants, S.maxH);
      post({ t: 'info', variant: { h: v.h, bw: v.bw, codecs: v.codecs } });
      S.mediaUrl = v.url;
      r = await get(v.url, 'text');
      pl = parseM3U(r.body, r.base);
    } else S.mediaUrl = url;
    if (pl.key) throw new Error('encrypted stream (' + pl.key + ') is not supported');
    if (pl.map) throw new Error('fMP4 (CMAF) HLS is not supported yet');
    return pl;
  }

  // HLS AES-128: whole segments encrypted with AES-CBC; IV from the playlist or the sequence number
  const keyCache = new Map();
  async function decrypt(buf, seg) {
    let k = keyCache.get(seg.key.uri);
    if (!k) {
      const r = await get(seg.key.uri, 'buf');
      if (r.body.length !== 16) throw new Error('bad AES key (' + r.body.length + ' bytes)');
      k = await crypto.subtle.importKey('raw', r.body, { name: 'AES-CBC' }, false, ['decrypt']);
      keyCache.set(seg.key.uri, k);
      if (keyCache.size > 20) keyCache.delete(keyCache.keys().next().value);
    }
    const iv = new Uint8Array(16);
    if (seg.key.iv) {
      const h = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
      for (let i = 0; i < 16; i++) iv[i] = parseInt(h.substr(i * 2, 2), 16);
    } else { let n = seg.sn; for (let i = 15; i >= 12; i--) { iv[i] = n & 0xff; n = Math.floor(n / 256); } }
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, buf));
  }

  function bufferedAhead() {
    if (S.lastEnd == null) return 0;
    const c = clock();
    return S.lastEnd - (c == null ? (S.fq.length ? S.fq[0].timestamp / 1e6 : S.lastEnd) : c);
  }

  async function loader() {
    const me = S;
    let pl;
    if (/\.ts($|\?)/i.test(new URL(S.url).pathname)) { await progressive(); return; }
    try { pl = await loadMedia(S.url); }
    catch (e) {
      if (e.notM3U) { await progressive(); return; } // a plain .ts stream
      throw e;
    }
    S.live = !pl.ended && pl.type !== 'EVENT';
    post({ t: 'info', live: S.live });
    const maxAhead = S.live ? 20 : 30;
    const noteAvail = () => { if (!S.live) { S.avail = pl.segs.reduce((n, s) => n + s.dur, 0); S.plEnded = pl.ended; } };
    noteAvail();
    let next = S.live && pl.segs.length ? pl.segs[Math.max(0, pl.segs.length - 3)].sn : pl.seq;
    let fails = 0;
    while (!me.stopped) {
      if (S.seekTo != null && !S.live && pl.segs.length) {
        const to = S.seekTo; S.seekTo = null;
        let acc = 0, target = pl.segs[0];
        for (const s of pl.segs) { target = s; if (acc + s.dur > to) break; acc += s.dur; }
        next = target.sn; resetForSeek(to);
        continue;
      }
      const seg = pl.segs.find(s => s.sn === next);
      if (seg) {
        while (!me.stopped && S.seekTo == null && bufferedAhead() > maxAhead) await sleep(250);
        if (me.stopped) return;
        if (S.seekTo != null) continue;
        const g = S.gen;
        try {
          const r = await get(seg.url, 'buf');
          if (me.stopped) return;
          if (seg.key) r.body = await decrypt(r.body, seg);
          if (me.stopped) return;
          if (S.gen !== g || S.seekTo != null) continue; // a seek arrived while this segment loaded
          fails = 0;
          if (seg.disc) S.discPending = true;
          demux(r.body);
          postAudio();
        } catch (e) {
          if (me.stopped) return;
          if (++fails > 5) throw e;
          post({ t: 'info', warn: 'segment failed: ' + (e.message || e) });
        }
        next++;
        continue;
      }
      const last = pl.segs.length ? pl.segs[pl.segs.length - 1].sn : pl.seq - 1;
      if (pl.ended && next > last) { S.eos = true; return; }
      if (pl.segs.length && next < pl.segs[0].sn) { next = S.live ? pl.segs[Math.max(0, pl.segs.length - 3)].sn : pl.segs[0].sn; continue; }
      await sleep(Math.max(1000, pl.target * 500));
      if (me.stopped) return;
      const r = await get(S.mediaUrl, 'text');
      pl = parseM3U(r.body, r.base);
      noteAvail();
    }
  }

  // Plain MPEG-TS over one long HTTP response (e.g. /yt/<id>.ts from the YouTube helper).
  async function progressive() {
    const me = S;
    let target = S.url;
    if (S.viaRelay || (S.httpsPage && /^http:/i.test(target))) target = S.relay + '/media?u=' + encodeURIComponent(S.url);
    const r = await fetch(target, { signal: S.ac.signal, cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    S.live = false; S.progressive = true;
    const reader = r.body.getReader();
    let carry = new Uint8Array(0);
    for (;;) {
      while (!me.stopped && bufferedAhead() > 30) await sleep(250);
      if (me.stopped) { try { reader.cancel(); } catch (_) {} return; }
      const { done, value } = await reader.read();
      if (done) break;
      const buf = new Uint8Array(carry.length + value.length); buf.set(carry); buf.set(value, carry.length);
      const usable = buf.length - (buf.length % 188);
      demux(buf.subarray(0, usable), true);
      carry = buf.slice(usable);
      postAudio();
    }
    flushAllPES(); postAudio();
    S.eos = true;
  }

  /* ---------------- MPEG-TS demux ---------------- */
  function demux(buf, streaming) {
    const d = S.dmx;
    let i = 0;
    while (i < buf.length && buf[i] !== 0x47) i++;
    for (; i + 188 <= buf.length; i += 188) {
      if (buf[i] !== 0x47) { let j = i + 1; while (j < buf.length && buf[j] !== 0x47) j++; i = j - 188; continue; }
      const pusi = buf[i + 1] & 0x40, pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2], afc = (buf[i + 3] >> 4) & 3;
      let p = i + 4;
      if (afc === 0 || afc === 2) continue;
      if (afc === 3) p += buf[p] + 1;
      if (p >= i + 188) continue;
      if (pid === 0) { if (pusi) p += buf[p] + 1; parsePAT(buf, p); }
      else if (pid === d.pmt) { if (pusi) p += buf[p] + 1; parsePMT(buf, p); }
      else if (pid === d.vpid || pid === d.apid) {
        let st = d.pes[pid];
        if (pusi) { if (st && st.len) flushPES(pid); st = d.pes[pid] = { parts: [], len: 0 }; }
        if (!st) continue;
        const part = buf.subarray(p, i + 188);
        st.parts.push(streaming ? part.slice() : part); st.len += part.length;
      }
    }
    if (!streaming) flushAllPES();
  }
  function flushAllPES() { const d = S.dmx; for (const pid of Object.keys(d.pes)) if (d.pes[pid] && d.pes[pid].len) flushPES(+pid); d.pes = {}; finishVideo(); }
  function parsePAT(b, p) {
    const len = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
    for (let k = p + 8; k + 4 <= Math.min(p + 3 + len - 4, b.length); k += 4) {
      const prog = (b[k] << 8) | b[k + 1];
      if (prog !== 0) { S.dmx.pmt = ((b[k + 2] & 0x1f) << 8) | b[k + 3]; return; }
    }
  }
  function parsePMT(b, p) {
    const d = S.dmx;
    const len = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
    const pil = ((b[p + 10] & 0x0f) << 8) | b[p + 11];
    const end = Math.min(p + 3 + len - 4, b.length);
    let hevc = false, ac3 = false;
    for (let k = p + 12 + pil; k + 5 <= end;) {
      const type = b[k], pid = ((b[k + 1] & 0x1f) << 8) | b[k + 2], esl = ((b[k + 3] & 0x0f) << 8) | b[k + 4];
      if (type === 0x1b && d.vpid < 0) d.vpid = pid;
      else if (type === 0x24) hevc = true;
      else if (type === 0x0f && d.apid < 0) { d.apid = pid; d.atype = 'aac'; }
      else if ((type === 0x03 || type === 0x04) && d.apid < 0) { d.apid = pid; d.atype = 'mp3'; }
      else if (type === 0x81 || type === 0x87) ac3 = true;
      k += 5 + esl;
    }
    if (d.vpid < 0 && !S.noVideoWarned) {
      S.noVideoWarned = true;
      fatal(hevc ? 'this channel is HEVC (H.265); only H.264 plays in drive mode' : 'no H.264 video in this stream');
      return;
    }
    if (d.apid >= 0) S.hasAudio = true;
    else if (ac3 && !S.ac3Warned) { S.ac3Warned = true; post({ t: 'info', warn: 'AC-3 audio is not supported; playing without sound' }); }
  }
  function readPts(b, o) { return (b[o] & 0x0e) * 536870912 + (b[o + 1] << 22) + ((b[o + 2] & 0xfe) << 14) + (b[o + 3] << 7) + ((b[o + 4] & 0xfe) >> 1); }
  function flushPES(pid) {
    const d = S.dmx, st = d.pes[pid]; d.pes[pid] = null;
    if (!st || !st.len) return;
    let data;
    if (st.parts.length === 1) data = st.parts[0];
    else { data = new Uint8Array(st.len); let o = 0; for (const x of st.parts) { data.set(x, o); o += x.length; } }
    if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return;
    const flags = data[7], hl = data[8];
    let pts = null;
    if (flags & 0x80) pts = readPts(data, 9);
    const payload = data.subarray(9 + hl);
    if (pid === d.vpid) onVideo(pts, payload);
    else onAudio(pts, payload);
  }

  function mapTime(raw) {
    let v = raw;
    if (S.ref != null && !S.discPending) { while (v - S.ref > WRAP / 2) v -= WRAP; while (S.ref - v > WRAP / 2) v += WRAP; }
    if (S.base == null) S.base = v;
    let t = (v - S.base) / 90000 + S.off;
    // tagged discontinuity, or an untagged jump of more than 10 s: continue from where we were
    if (S.lastEnd != null && (S.discPending || t > S.lastEnd + 10 || t < S.lastEnd - 10)) {
      S.off += (S.lastEnd + 0.04) - t;
      t = S.lastEnd + 0.04;
      S.discPending = false;
    }
    S.ref = v;
    return t;
  }

  /* ---------------- H.264 ---------------- */
  const SC = new Uint8Array([0, 0, 0, 1]);
  function splitNals(b) {
    const out = []; let i = 0, s = -1; const n = b.length;
    while (i + 2 < n) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
        if (s >= 0) { let e = i; if (e > s && b[e - 1] === 0) e--; if (e > s) out.push(b.subarray(s, e)); }
        i += 3; s = i;
      } else i++;
    }
    if (s >= 0 && s < n) out.push(b.subarray(s, n));
    return out;
  }
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
  // Big frames can be split over several PES packets; the follow-on packets do not start with a
  // start code. Hold each frame until the next one begins, gluing continuations on.
  function onVideo(pts, payload) {
    const sc = payload.length > 3 && payload[0] === 0 && payload[1] === 0 && (payload[2] === 1 || (payload[2] === 0 && payload[3] === 1));
    if (!sc && S.pendV) { S.pendV.parts.push(payload.slice()); return; }
    finishVideo();
    S.pendV = { pts, parts: [payload.slice()] };
  }
  function finishVideo() {
    const pv = S.pendV; if (!pv) return;
    S.pendV = null;
    let payload = pv.parts[0], pts = pv.pts;
    if (pv.parts.length > 1) {
      payload = new Uint8Array(pv.parts.reduce((n, x) => n + x.length, 0));
      let o = 0; for (const x of pv.parts) { payload.set(x, o); o += x.length; }
    }
    const nals = splitNals(payload);
    if (!nals.length) return;
    let key = false, hasSps = false, hasPps = false;
    for (const n of nals) {
      const t = n[0] & 0x1f;
      if (t === 7) { hasSps = true; if (!same(S.sps, n)) { S.sps = n.slice(); S.cfgDirty = true; } }
      else if (t === 8) { hasPps = true; S.pps = n.slice(); }
      else if (t === 5) key = true;
    }
    if (pts == null) pts = S.lastVraw != null ? S.lastVraw + 3003 : 0;
    S.lastVraw = pts;
    let data;
    if (key && (!hasSps || !hasPps) && S.sps && S.pps) {
      data = new Uint8Array(8 + S.sps.length + S.pps.length + payload.length);
      let o = 0; for (const x of [SC, S.sps, SC, S.pps, payload]) { data.set(x, o); o += x.length; }
    } else data = payload;
    const t = mapTime(pts);
    S.vq.push({ t, key, data });
    if (S.lastEnd == null || t > S.lastEnd) S.lastEnd = t;
  }

  /* ---------------- audio (sent to the page, which owns Web Audio) ---------------- */
  function onAudio(pts, payload) {
    if (pts == null) return;
    const t0 = mapTime(pts);
    if (S.dmx.atype === 'mp3') { if (S.seekDrop == null || t0 >= S.seekDrop - 0.05) S.aq.push({ t: t0, d: payload.slice() }); return; }
    let i = 0, k = 0;
    while (i + 7 <= payload.length) {
      if (payload[i] !== 0xff || (payload[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
      const prot = payload[i + 1] & 1, prof = (payload[i + 2] >> 6) & 3, fi = (payload[i + 2] >> 2) & 0x0f;
      const ch = ((payload[i + 2] & 1) << 2) | (payload[i + 3] >> 6);
      const len = ((payload[i + 3] & 3) << 11) | (payload[i + 4] << 3) | (payload[i + 5] >> 5);
      const rate = RATES[fi];
      if (len < 7 || i + len > payload.length || !rate) break;
      S.acfg = { aot: prof + 1, fi, ch: ch || 2, rate, hdr: prot ? 7 : 9 };
      const ft = t0 + (k * 1024) / rate;
      if (S.seekDrop == null || ft >= S.seekDrop - 0.03) S.aq.push({ t: ft, d: payload.slice(i, i + len) });
      k++; i += len;
    }
  }
  function postAudio() {
    if (!S || !S.aq.length) return;
    const frames = S.aq; S.aq = [];
    post({ t: 'audio', gen: S.gen, codec: S.dmx.atype, cfg: S.acfg || null, frames }, frames.map(f => f.d.buffer));
  }

  /* ---------------- decode + present ---------------- */
  function configure() {
    if (!S.sps || S.sps.length < 4) return false;
    try { if (S.dec && S.dec.state !== 'closed') S.dec.close(); } catch (_) {}
    const codec = 'avc1.' + hex(S.sps[1]) + hex(S.sps[2]) + hex(S.sps[3]);
    const me = S;
    S.dec = new VideoDecoder({ output: f => onFrame(me, f), error: e => decErr(me, e) });
    S.dec.configure({ codec, optimizeForLatency: true }); // no description = Annex B input
    S.cfgDirty = false; S.needKey = true;
    if (S.codec !== codec) { S.codec = codec; post({ t: 'info', codec }); }
    return true;
  }
  function decErr(me, e) {
    if (me.stopped || S !== me) return;
    if (++S.decErrors > 4) { fatal('video decoder: ' + (e && e.message || e)); return; }
    S.dec = null; S.cfgDirty = true; S.needKey = true;
  }
  function onFrame(me, f) {
    if (me.stopped || S !== me) { f.close(); return; }
    if (S.seekDrop != null && f.timestamp / 1e6 < S.seekDrop - 0.02) { f.close(); return; } // before the seek target
    if (!S.firstFrameAt) S.firstFrameAt = now();
    S.fq.push(f);
    if (S.fq.length > 1 && S.fq[S.fq.length - 2].timestamp > f.timestamp) S.fq.sort((a, b) => a.timestamp - b.timestamp);
  }
  function pump() {
    while (S.vq.length) {
      if (!S.dec || S.dec.state === 'closed' || (S.cfgDirty && S.vq[0].key)) { if (!configure()) return; }
      if (S.dec.decodeQueueSize >= 6 || S.fq.length + S.dec.decodeQueueSize >= 16) return;
      const s = S.vq.shift();
      if (S.needKey) { if (!s.key) continue; S.needKey = false; }
      try { S.dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.t * 1e6), data: s.data })); }
      catch (e) { decErr(S, e); return; }
    }
  }

  function clock() {
    if (S.paused) return S.pauseC;
    const t = now();
    if (S.hasAudio && S.aClock != null) {
      let c = S.aClock + (t - S.aAt) / 1000;
      const frozen = S.aEnd != null && c >= S.aEnd;
      if (!frozen) { S.frozenSince = null; S.wall0 = null; S.wc = null; S.clockSrc = 'audio'; return c; }
      c = S.aEnd;
      if (S.frozenSince == null) S.frozenSince = t;
      S.clockSrc = 'audio-stalled';
      if (t - S.frozenSince < 3000) return c;
      return wallClock(t, c); // audio stopped but the picture may go on (e.g. a stream that lost its sound)
    }
    if (S.hasAudio && S.firstFrameAt && t - S.firstFrameAt < 2500) return null; // give audio a moment to start
    if (!S.fq.length && S.wall0 == null && S.wc == null) return null;
    return wallClock(t, S.wc != null ? S.wc : S.fq[0].timestamp / 1e6);
  }
  // Wall-clock fallback. It holds still while there is nothing decoded to show, so a network stall
  // pauses the picture instead of running the clock past the frames that are still on the way.
  function wallClock(t, from) {
    S.clockSrc = 'wall';
    if (!S.fq.length) { if (S.wall0 != null) { S.wc = S.wallT0 + (t - S.wall0) / 1000; S.wall0 = null; } return S.wc != null ? S.wc : from; }
    if (S.wall0 == null) { S.wall0 = t; S.wallT0 = S.wc != null ? S.wc : from; }
    S.wc = S.wallT0 + (t - S.wall0) / 1000;
    return S.wc;
  }

  function draw(f, keep) {
    const w = f.displayWidth, h = f.displayHeight;
    S.lastShown = f.timestamp / 1e6;
    if (S.ctx) {
      if (S.canvas.width !== w || S.canvas.height !== h) { S.canvas.width = w; S.canvas.height = h; }
      S.ctx.drawImage(f, 0, 0, w, h);
      if (!keep) f.close();
    } else {
      const g = keep ? f.clone() : f;
      post({ t: 'frame', f: g }, [g]);
    }
    if (!keep) { S.frames++; S.statFrames++; }
    if (!S.started && !keep) { S.started = true; post({ t: 'playing', w, h, codec: S.codec }); }
  }

  function tick() {
    if (!S || S.stopped) return;
    const me = S;
    pump();
    const c = clock();
    if (c != null) {
      let pick = null;
      while (S.fq.length && S.fq[0].timestamp / 1e6 <= c + 0.008) { if (pick) { pick.close(); S.dropped++; } pick = S.fq.shift(); }
      if (pick) draw(pick);
    } else if (!S.preview && S.fq.length) { S.preview = true; draw(S.fq[0], true); }
    const t = now();
    if (t - S.statAt > 1000) {
      const fps = S.statFrames * 1000 / (t - S.statAt);
      post({ t: 'stats', fps: Math.round(fps * 10) / 10, buffered: Math.round(bufferedAhead() * 10) / 10, dropped: S.dropped, frames: S.frames, clock: c, src: S.clockSrc || '', relay: S.viaRelay, paused: S.paused, avail: S.avail, plEnded: S.plEnded, live: S.live });
      S.statAt = t; S.statFrames = 0;
      const bs = S.started && !S.paused && !S.fq.length && !S.vq.length && !S.eos ? 'buffering' : 'ok';
      if (bs !== S.lastBufState) { S.lastBufState = bs; post({ t: 'buffer', state: bs }); }
      if (!S.started && t - S.startedAt > 30000) { fatal('no picture after 30 s'); return; }
    }
    if (S.eos && !S.vq.length && !S.fq.length && (!S.dec || S.dec.decodeQueueSize === 0) && S.started) { post({ t: 'ended' }); stop(); return; }
    let delay = 10;
    if (c != null && S.fq.length) delay = Math.min(40, Math.max(2, (S.fq[0].timestamp / 1e6 - c) * 1000));
    if (S === me) S.timer = setTimeout(tick, delay); // setTimeout, not rAF: keeps running when the car throttles animation frames
  }
}

/* ======================================================================
   PAGE SIDE
   ====================================================================== */
const AC = global.AudioContext || global.webkitAudioContext;
let sharedCtx = null, workerUrl = null;

function unlockAudio() {
  if (!AC) return null;
  if (!sharedCtx) {
    try { sharedCtx = new AC({ latencyHint: 'playback' }); } catch (_) { try { sharedCtx = new AC(); } catch (_) { return null; } }
    sharedCtx.gtvPaused = false;
    // the browser may suspend or interrupt audio on its own; take it back unless the user paused
    sharedCtx.addEventListener('statechange', () => {
      const c = sharedCtx;
      if (!c.gtvPaused && c.state !== 'running' && c.state !== 'closed') setTimeout(() => { if (!c.gtvPaused && c.state !== 'running' && c.state !== 'closed') c.resume().catch(() => {}); }, 300);
    });
  }
  if (sharedCtx.state !== 'running' && sharedCtx.state !== 'closed' && !sharedCtx.gtvPaused) sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

function supported() {
  return !!(global.isSecureContext && typeof global.Worker === 'function' && typeof global.VideoDecoder === 'function' &&
    typeof global.EncodedVideoChunk === 'function' && AC);
}
function isCarBrowser() {
  const ua = navigator.userAgent || '';
  if (/Tesla|QtCarBrowser/i.test(ua)) return true;
  // The Tesla browser reports itself as plain desktop Linux Chrome. So does desktop Linux, which is harmless here.
  return /X11; ?Linux x86_64/.test(ua) && /Chrome\//.test(ua) && !/Android|CrOS/.test(ua);
}

// Decoded audio waits in a queue and is handed to Web Audio just in time (about one second ahead),
// joined into ~0.5 s buffers. Scheduling every 21 ms AAC frame as soon as it was decoded left
// 1000+ pending AudioBufferSourceNodes when the buffer ran 30 s ahead; Chrome processes every
// pending node on each render quantum, which overloads the audio thread on a slow car computer
// and the sound drops out while the picture keeps going.
const LOOKAHEAD = 1.5, MERGE = 0.5;
function pcmPlanes(d) {
  const n = d.numberOfFrames, nc = d.numberOfChannels, out = [];
  try {
    for (let c = 0; c < nc; c++) { const a = new Float32Array(n); d.copyTo(a, { planeIndex: c, format: 'f32-planar' }); out.push(a); }
    return out;
  } catch (_) { out.length = 0; }
  // older engines cannot convert in copyTo: read the native format and convert here
  const f = d.format || 'f32', planar = /-planar$/.test(f);
  const T = /^s16/.test(f) ? Int16Array : /^s32/.test(f) ? Int32Array : /^u8/.test(f) ? Uint8Array : Float32Array;
  const conv = T === Int16Array ? v => v / 32768 : T === Int32Array ? v => v / 2147483648 : T === Uint8Array ? v => (v - 128) / 128 : v => v;
  if (planar) {
    for (let c = 0; c < nc; c++) { const b = new T(n); d.copyTo(b, { planeIndex: c }); const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = conv(b[i]); out.push(a); }
  } else {
    const b = new T(n * nc); d.copyTo(b, { planeIndex: 0 });
    for (let c = 0; c < nc; c++) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = conv(b[i * nc + c]); out.push(a); }
  }
  return out;
}

class AudioOut {
  constructor(ctx, onFail) {
    this.ctx = ctx; this.onFail = onFail; this.gain = ctx.createGain(); this.gain.connect(ctx.destination);
    this.srcs = new Set(); this.q = []; this.anchor = null; this.endMedia = null; this.schedEnd = null; this.lastMediaEnd = null;
    this.dec = null; this.decKey = ''; this.gen = 0; this.pcmFails = 0;
    this.chain = Promise.resolve(); this.closed = false; this.useDecoder = typeof global.AudioDecoder === 'function';
    this.fails = 0; this.st = { pushed: 0, decoded: 0, scheduled: 0, underruns: 0, dropped: 0 };
    this.timer = setInterval(() => this.pump(), 50);
  }
  push(m) {
    if (this.closed || !m.frames.length || (m.gen || 0) !== this.gen) return;
    this.st.pushed += m.frames.length;
    if (m.codec === 'aac' && m.cfg && this.useDecoder && this.ensureDecoder(m.cfg)) {
      for (const f of m.frames) {
        try { this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(f.t * 1e6), data: new Uint8Array(f.d).subarray(m.cfg.hdr) })); }
        catch (_) { this.useDecoder = false; break; }
      }
      if (this.useDecoder) return;
    }
    // fallback: let the browser decode a batch of ADTS / MP3 frames at once
    const total = m.frames.reduce((n, f) => n + f.d.byteLength, 0);
    const all = new Uint8Array(total); let o = 0;
    for (const f of m.frames) { all.set(new Uint8Array(f.d), o); o += f.d.byteLength; }
    const t0 = m.frames[0].t, gen = this.gen;
    this.chain = this.chain.then(() => this.closed ? null : this.ctx.decodeAudioData(all.buffer).then(buf => {
      if (gen !== this.gen || this.closed) return;
      const planes = []; for (let c = 0; c < buf.numberOfChannels; c++) planes.push(buf.getChannelData(c));
      this.enqueue(t0, planes, buf.sampleRate);
    })).catch(() => { if (++this.fails >= 3 && this.onFail) { this.onFail(); this.onFail = null; } });
  }
  ensureDecoder(cfg) {
    const key = cfg.aot + '/' + cfg.fi + '/' + cfg.ch;
    if (this.dec && this.decKey === key && this.dec.state === 'configured') return true;
    try {
      if (this.dec && this.dec.state !== 'closed') this.dec.close();
      const asc = new Uint8Array([(cfg.aot << 3) | (cfg.fi >> 1), ((cfg.fi & 1) << 7) | (cfg.ch << 3)]);
      const gen = this.gen;
      this.dec = new AudioDecoder({
        output: d => this.onData(d, gen),
        error: () => { this.useDecoder = false; },
      });
      this.dec.configure({ codec: 'mp4a.40.' + cfg.aot, sampleRate: cfg.rate, numberOfChannels: cfg.ch, description: asc });
      this.decKey = key;
      return true;
    } catch (_) { this.useDecoder = false; return false; }
  }
  onData(d, gen) {
    try {
      if (this.closed || gen !== this.gen) return;
      const planes = pcmPlanes(d);
      this.pcmFails = 0;
      this.enqueue(d.timestamp / 1e6, planes, d.sampleRate);
    } catch (_) {
      if (++this.pcmFails >= 5) this.useDecoder = false; // cannot read decoder output: use decodeAudioData instead
    } finally { d.close(); }
  }
  enqueue(t, planes, rate) {
    if (!planes.length || !planes[0].length) return;
    const it = { t, planes, rate, dur: planes[0].length / rate };
    const q = this.q;
    if (!q.length || q[q.length - 1].t <= t) q.push(it);
    else { let i = q.length; while (i > 0 && q[i - 1].t > t) i--; q.splice(i, 0, it); }
    this.st.decoded++;
    const end = t + it.dur;
    if (this.endMedia == null || end > this.endMedia) this.endMedia = end;
    if (this.schedEnd == null || this.schedEnd < this.ctx.currentTime + 0.2) this.pump();
  }
  pump() {
    if (this.closed || !this.q.length || this.ctx.state !== 'running') return;
    const ctx = this.ctx, q = this.q;
    for (;;) {
      const nowT = ctx.currentTime;
      if (!q.length || (this.schedEnd != null && this.schedEnd > nowT + LOOKAHEAD)) return;
      const a = q[0];
      // already covered by audio we scheduled (overlap / duplicate): drop or trim it
      let skip = this.lastMediaEnd != null ? this.lastMediaEnd - a.t : 0;
      if (skip >= a.dur - 1e-4) { q.shift(); this.st.dropped++; continue; }
      if (skip < 0.002) skip = 0;
      let when = this.anchor ? this.anchor.ctx + (a.t + skip - this.anchor.media) : -1;
      if (!this.anchor || when < nowT + 0.005) {
        // first audio, or we ran dry: (re)start the audio clock with this chunk
        if (this.anchor) this.st.underruns++;
        this.anchor = { ctx: nowT + 0.08, media: a.t + skip }; when = this.anchor.ctx;
      }
      // join back-to-back chunks into one buffer
      const nc = a.planes.length, rate = a.rate, parts = [a];
      let frames = a.planes[0].length, endT = a.t + a.dur;
      q.shift();
      while (q.length && frames / rate < MERGE) {
        const b = q[0];
        if (b.rate !== rate || b.planes.length !== nc || Math.abs(b.t - endT) > 0.004) break;
        parts.push(b); frames += b.planes[0].length; endT = b.t + b.dur; q.shift();
      }
      const buf = ctx.createBuffer(nc, frames, rate);
      for (let c = 0; c < nc; c++) {
        const dst = buf.getChannelData(c); let o = 0;
        for (const p of parts) { dst.set(p.planes[c], o); o += p.planes[c].length; }
      }
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(this.gain);
      src.start(when, skip);
      this.srcs.add(src); src.onended = () => { this.srcs.delete(src); try { src.disconnect(); } catch (_) {} };
      this.st.scheduled++;
      this.schedEnd = when + buf.duration - skip;
      this.lastMediaEnd = a.t + buf.duration;
    }
  }
  clock() {
    if (!this.anchor || this.closed) return null;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return { m: this.anchor.media + (this.ctx.currentTime - lat - this.anchor.ctx), end: this.endMedia };
  }
  info() {
    return Object.assign({ ctx: this.ctx.state, t: +this.ctx.currentTime.toFixed(2), queued: this.q.length, live: this.srcs.size,
      ahead: this.schedEnd == null ? 0 : +(this.schedEnd - this.ctx.currentTime).toFixed(2), path: this.useDecoder ? 'AudioDecoder' : 'decodeAudioData' }, this.st);
  }
  flush() {
    this.gen++;
    for (const s of this.srcs) { try { s.stop(); } catch (_) {} }
    this.srcs.clear(); this.q = []; this.anchor = null; this.endMedia = null; this.schedEnd = null; this.lastMediaEnd = null;
    try { if (this.dec && this.dec.state !== 'closed') this.dec.close(); } catch (_) {}
    this.dec = null; this.decKey = '';
    return this.gen;
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    for (const s of this.srcs) { try { s.stop(); } catch (_) {} }
    this.srcs.clear(); this.q = [];
    try { this.gain.disconnect(); } catch (_) {}
    try { if (this.dec && this.dec.state !== 'closed') this.dec.close(); } catch (_) {}
  }
}

function create(canvasEl, cb = {}) {
  let canvas = canvasEl, worker = null, audio = null, clockTimer = null, ctx2d = null;
  const p = { playing: false, paused: false, currentTime: 0, stats: null, info: {}, live: true, seekable: 0, complete: false,
    get canvas() { return canvas; } };

  function freshCanvas() {
    // a canvas can hand its drawing surface to a worker only once, so swap in a clone each start
    if (canvas.dataset.cpUsed) { const c = canvas.cloneNode(false); delete c.dataset.cpUsed; canvas.replaceWith(c); canvas = c; }
    return canvas;
  }

  p.load = function (url, opts = {}) {
    p.stop();
    const actx = unlockAudio();
    if (!workerUrl) workerUrl = URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')()'], { type: 'text/javascript' }));
    worker = new Worker(workerUrl);
    const c = freshCanvas();
    let off = null;
    if (c.transferControlToOffscreen && !opts.noOffscreen) { try { off = c.transferControlToOffscreen(); c.dataset.cpUsed = '1'; } catch (_) { off = null; } }
    ctx2d = off ? null : c.getContext('2d', { alpha: false });
    const w = worker;
    if (actx) audio = new AudioOut(actx, () => { if (worker === w) w.postMessage({ t: 'audioFailed' }); });
    const a = audio;
    p.playing = false; p.paused = false; p.currentTime = 0; p.info = {}; p.live = true; p.seekable = 0; p.complete = false;
    if (actx) actx.gtvPaused = false;
    w.onmessage = e => {
      if (worker !== w) return;
      const m = e.data;
      switch (m.t) {
        case 'audio': if (a) a.push(m); else w.postMessage({ t: 'audioFailed' }); break;
        case 'frame':
          if (ctx2d) { if (c.width !== m.f.displayWidth) { c.width = m.f.displayWidth; c.height = m.f.displayHeight; } ctx2d.drawImage(m.f, 0, 0, c.width, c.height); }
          m.f.close(); break;
        case 'playing': p.playing = true; cb.onPlaying && cb.onPlaying(m); break;
        case 'stats':
          p.stats = m;
          if (m.clock != null && !p.seeking) p.currentTime = Math.max(0, m.clock);
          p.live = !!m.live; p.seekable = m.avail || 0; p.complete = !!m.plEnded;
          cb.onInfo && cb.onInfo({ stats: m });
          break;
        case 'info': Object.assign(p.info, m); delete p.info.t; cb.onInfo && cb.onInfo(m); break;
        case 'buffer': if (m.state === 'ok') p.seeking = false; cb.onInfo && cb.onInfo({ buffer: m.state }); break;
        case 'ended': p.playing = false; teardown(); cb.onEnded && cb.onEnded(); break;
        case 'error': p.playing = false; teardown(); cb.onError && cb.onError(m.msg || 'playback error'); break;
      }
    };
    w.onerror = e => { if (worker !== w) return; p.playing = false; teardown(); cb.onError && cb.onError((e && e.message) || 'player worker failed'); };
    const abs = new URL(url, location.href).href;
    const msg = { t: 'start', url: abs, relay: opts.relay || '', maxHeight: opts.maxHeight || 720, httpsPage: location.protocol === 'https:', forceRelay: !!opts.forceRelay, canvas: off };
    w.postMessage(msg, off ? [off] : []);
    clockTimer = setInterval(() => {
      if (!a || worker !== w) return;
      const k = a.clock();
      if (k) w.postMessage({ t: 'clock', m: k.m, end: k.end, at: performance.timeOrigin + performance.now() });
    }, 40);
  };

  function teardown() {
    clearInterval(clockTimer); clockTimer = null;
    if (worker) { try { worker.postMessage({ t: 'stop' }); } catch (_) {} const w = worker; setTimeout(() => { try { w.terminate(); } catch (_) {} }, 200); }
    worker = null;
    if (audio) { audio.close(); audio = null; }
  }
  p.stop = function () { teardown(); p.playing = false; p.paused = false; if (sharedCtx) sharedCtx.gtvPaused = false; };
  // pause / resume: the audio clock stops (AudioContext suspended), so the picture holds too
  p.pause = function () {
    if (!worker || p.paused) return;
    p.paused = true; worker.postMessage({ t: 'pause', on: true });
    if (audio) { audio.ctx.gtvPaused = true; audio.ctx.suspend().catch(() => {}); }
  };
  p.resume = function () {
    if (!worker || !p.paused) return;
    p.paused = false;
    if (audio) { audio.ctx.gtvPaused = false; audio.ctx.resume().catch(() => {}); }
    worker.postMessage({ t: 'pause', on: false });
  };
  // seek to a media time (seconds from the start of this stream). Works on finished or growing
  // (EVENT) playlists inside what the playlist already lists; p.seekable is how far that goes.
  p.seek = function (to) {
    if (!worker || p.live) return false;
    to = Math.max(0, Math.min(+to || 0, p.seekable ? p.seekable - 0.5 : +to || 0));
    const gen = audio ? audio.flush() : 0;
    worker.postMessage({ t: 'seek', to, gen });
    p.currentTime = to; p.seeking = true;
    return true;
  };
  p.audioInfo = () => audio ? audio.info() : null;
  p.destroy = p.stop;
  return p;
}

global.CanvasPlayer = { version: '1.1.0', supported, isCarBrowser, unlockAudio, create };
})(window);
