(() => {
    'use strict';

    const CONFIG = {
        timeZone: 'Europe/Berlin',
        discordId: '1492904216514265128',
        // Listening stats and "Recently played" read plays scrobbled from Apple Music to Last.fm.
        // Free API key: https://www.last.fm/api/account/create
        lastfmUser: 'imsolost222',
        lastfmKey: 'd7d05b5352f4a3571646f0768c53a46b',
    };

    // playlist.js provides the tracks; without it there's just the one local song
    const PLAYLIST = window.STOLE_PLAYLIST?.tracks?.length ? window.STOLE_PLAYLIST : {
        name: 'stole.cc', url: '',
        tracks: [{ id: 'local', title: 'Play Em Like Atari', artist: 'Vanish Boys', file: 'music.mp3' }],
    };

    // ---- helpers ------------------------------------------------------------------

    const $ = (s, el = document) => el.querySelector(s);
    const $$ = (s, el = document) => [...el.querySelectorAll(s)];
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const root = document.documentElement;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const overHttp = location.protocol.startsWith('http');
    const testing = !overHttp || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
    const store = {
        get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
        set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    };
    const fmtTime = (s) => {
        s = Math.max(0, Math.floor(s || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const fmtLong = (s) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h ? `${h} h ${m} min` : `${m} min`;
    };
    const fmtNum = (n) => new Intl.NumberFormat('en-US').format(n);
    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    };
    // Apple's artwork URLs take any size: …/512x512bb.jpg
    const coverUrl = (t, px) => (t?.art ? t.art.replace(/\/\d+x\d+bb\./, `/${px}x${px}bb.`) : '');

    const toastEl = $('#toast');
    let toastTimer = 0;
    function toast(text) {
        toastEl.textContent = text;
        toastEl.classList.add('on');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
    }

    // ---- theme ---------------------------------------------------------------------

    const THEMES = ['light', 'dark', 'sky'];
    const systemDark = matchMedia('(prefers-color-scheme: dark)');
    const themeColor = $('meta[name="theme-color"]');
    let turntable = null;

    function applyTheme(t, save) {
        root.dataset.theme = t;
        if (save) store.set('stole:theme', t);
        $$('.theme-pick').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.pick === t)));
        themeColor.content = getComputedStyle(root).getPropertyValue('--bg').trim();
        turntable?.setTheme(readTurntableColors());
    }
    function readTurntableColors() {
        const cs = getComputedStyle(root);
        const v = (n) => cs.getPropertyValue(n).trim();
        return {
            body: v('--tt-body'), mat: v('--tt-mat'), trim: v('--tt-trim'), accent: v('--accent'),
            ink: v('--ink-3'), inkStrong: v('--ink-2'), metal: parseFloat(v('--tt-metal')), rough: parseFloat(v('--tt-rough')),
            dark: root.dataset.theme === 'dark',
        };
    }
    $$('.theme-pick').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.pick, true)));
    systemDark.addEventListener('change', () => {
        if (!THEMES.includes(store.get('stole:theme'))) applyTheme(systemDark.matches ? 'dark' : 'light', false);
    });
    applyTheme(root.dataset.theme || 'light', false);

    // ---- clock ---------------------------------------------------------------------

    const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timeZone, hour: '2-digit', minute: '2-digit' });
    function tickClock() { $('#clock').textContent = clockFmt.format(new Date()); }
    tickClock();
    setInterval(tickClock, 10000);

    // ---- contact -------------------------------------------------------------------

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            const ta = el('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        }
    }
    $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
        const ok = await copyText(btn.dataset.copy);
        toast(ok ? `Copied ${btn.dataset.copyName || btn.dataset.copy}` : 'Couldn’t copy');
        if (!ok) return;
        btn.textContent = 'Copied';
        btn.classList.add('is-done');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('is-done'); }, 1400);
    }));

    // ---- audio ---------------------------------------------------------------------

    const audio = $('#audio');
    const deck = $('.deck');
    const player = $('.player');
    const playBtn = $('#playBtn');
    const seek = $('#seek');
    const volIn = $('#vol');
    const tCur = $('#tCur');
    const tDur = $('#tDur');

    let playing = false;  // what the element is doing
    let wantPlay = false; // what the listener asked for; survives track changes and load errors
    let seeking = false;

    let actx; // undefined = not tried yet, null = unavailable
    let gain = null;
    let fxGain = null; // the scratch, alongside the music

    function ensureAudioGraph() {
        if (actx !== undefined) return;
        actx = null;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try {
            actx = new AC();
            fxGain = actx.createGain();
            fxGain.gain.value = (vol / 100) ** 2;
            fxGain.connect(actx.destination);
        } catch {
            actx = fxGain = null;
            return;
        }
        // iOS mutes Web Audio with the ring switch unless the page says it plays media, like the music
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
        (window.requestIdleCallback || ((fn) => setTimeout(fn, 1000)))(ensureScratchVoice);
        // from file:// the browser treats audio as cross-origin and Web Audio would output silence
        if (!overHttp) return;
        try {
            const src = actx.createMediaElementSource(audio);
            gain = actx.createGain();
            src.connect(gain).connect(actx.destination);
            applyVolume();
        } catch {
            gain = null;
        }
    }

    // volume goes through a GainNode when available, because iOS ignores audio.volume.
    // While a hand is on the record the music dips, so the scratch sits on top of it like a DJ's.
    let vol = clamp(parseInt(store.get('stole:vol') ?? '70', 10) || 0, 0, 100);
    let duck = 1;
    volIn.value = vol;
    const paintRange = (input) => input.style.setProperty('--p', `${(input.value - input.min) / (input.max - input.min) * 100}%`);
    paintRange(volIn);
    function applyVolume() {
        const v = (vol / 100) ** 2;
        if (gain) { audio.volume = 1; gain.gain.setTargetAtTime(v * duck, actx.currentTime, .04); }
        else audio.volume = v;
        fxGain?.gain.setTargetAtTime(v, actx.currentTime, .02);
    }
    applyVolume();
    volIn.addEventListener('input', () => {
        vol = +volIn.value;
        paintRange(volIn);
        applyVolume();
        store.set('stole:vol', String(vol));
    });

    async function play() {
        ensureAudioGraph();
        if (actx && actx.state === 'suspended') actx.resume();
        try { await audio.play(); }
        catch (err) { if (err.name === 'NotAllowedError') wantPlay = false; } // load failures arrive as 'error' events
    }

    function toggle() {
        if (audio.paused) { wantPlay = true; play(); }
        else { wantPlay = false; audio.pause(); }
    }

    function setPlaying(p) {
        playing = p;
        player.classList.toggle('is-playing', p);
        playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'playing' : 'paused';
        turntable?.setPlaying(p);
        flatRecord.classList.toggle('is-spinning', p && !turntable && !reduceMotion.matches);
    }

    function duration() {
        return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (current?.preview && !current.file ? 30 : (current?.ms || 0) / 1000);
    }

    function renderTime() {
        const d = duration();
        const t = audio.currentTime || 0;
        tCur.textContent = fmtTime(t);
        tDur.textContent = fmtTime(d);
        if (!seeking) {
            seek.value = d ? Math.round((t / d) * 1000) : 0;
            paintRange(seek);
        }
        turntable?.setProgress(d ? t / d : 0);
    }

    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('playing', () => { errorStreak = 0; setPlaying(true); });
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('timeupdate', renderTime);
    audio.addEventListener('loadedmetadata', () => { seek.disabled = false; renderTime(); });
    audio.addEventListener('ended', () => nextTrack(true));
    audio.addEventListener('error', onAudioError);

    seek.addEventListener('input', () => {
        seeking = true;
        paintRange(seek);
        tCur.textContent = fmtTime((seek.value / 1000) * duration());
    });
    seek.addEventListener('change', () => {
        const d = duration();
        if (d) audio.currentTime = (seek.value / 1000) * d;
        seeking = false;
        renderTime();
    });

    playBtn.addEventListener('click', () => { sfx('click'); toggle(); });
    $('#nextBtn').addEventListener('click', () => { sfx('click'); nextTrack(); });
    $('#prevBtn').addEventListener('click', () => { sfx('click'); prevTrack(); });

    // ---- playlist: random from the first song on ------------------------------------

    const tracks = PLAYLIST.tracks.map((t, i) => ({ ...t, no: i + 1 }));
    const history = [];
    let queue = [];
    let current = null;
    let errorStreak = 0;

    function shuffle(list) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }

    const npArt = $('#npArt');
    const flatRecord = $('#flatRecord');
    const flatLabel = $('#flatLabel');

    function renderTrackInfo() {
        const t = current;
        $('#npTitle').textContent = t.title;
        $('#npArtist').textContent = t.artist;
        const art = coverUrl(t, 160);
        if (art) npArt.src = art; else npArt.removeAttribute('src');
        if (art) flatLabel.src = coverUrl(t, 300);
        renderPlayedInfo();
        plRows.forEach((r) => r.classList.toggle('is-current', r._track === t));
        revealCurrentRow();
        if ('mediaSession' in navigator && 'MediaMetadata' in window) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: t.title,
                artist: t.artist,
                album: PLAYLIST.name,
                artwork: t.art ? [{ src: coverUrl(t, 512), sizes: '512x512', type: 'image/jpeg' }] : [],
            });
        }
    }

    function loadTrack(t, autoplay) {
        const first = current === null;
        const changed = current !== t;
        current = t;
        if (!queue.length) queue = shuffle(tracks.filter((x) => x !== t));
        wantPlay = autoplay;
        seek.disabled = true;
        seek.value = 0;
        paintRange(seek);
        if (overHttp) audio.crossOrigin = 'anonymous'; // Apple's preview CDN allows it, so the volume can go through Web Audio
        audio.src = t.file || t.preview;
        renderTrackInfo();
        renderTime();
        if (changed) turntable?.setTrack(t, !first);
        if (autoplay) play();
    }

    function nextTrack(autoplay = wantPlay) {
        if (current) history.push(current);
        if (!queue.length) queue = shuffle(tracks.filter((t) => t !== current));
        loadTrack(queue.shift(), autoplay);
    }

    function prevTrack() {
        if (audio.currentTime > 3 || !history.length) {
            audio.currentTime = 0;
            renderTime();
            return;
        }
        queue.unshift(current);
        loadTrack(history.pop(), wantPlay);
    }

    function playTrack(t) {
        if (t === current) {
            if (audio.paused) { wantPlay = true; play(); }
            return;
        }
        if (current) history.push(current);
        queue = queue.filter((q) => q !== t);
        loadTrack(t, true);
    }

    // preview links expire now and then; Apple's lookup API hands out fresh ones
    async function freshPreview(id) {
        try {
            const res = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=de&entity=song`);
            const data = await res.json();
            return data.results?.find((r) => r.previewUrl)?.previewUrl || null;
        } catch {
            return null;
        }
    }

    async function onAudioError() {
        const t = current;
        if (!t || !audio.error) return;
        if (!t.file && !t.refreshed) {
            t.refreshed = true;
            const fresh = await freshPreview(t.id);
            if (fresh && current === t) {
                t.preview = fresh;
                loadTrack(t, wantPlay);
                return;
            }
        }
        if (++errorStreak > 4) { wantPlay = false; setPlaying(false); toast('Playback isn’t working right now'); return; }
        toast(`${t.title} isn’t available · skipped`);
        nextTrack(wantPlay);
    }

    if ('mediaSession' in navigator) {
        const ms = navigator.mediaSession;
        const on = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* not supported */ } };
        on('play', () => { wantPlay = true; play(); });
        on('pause', () => { wantPlay = false; audio.pause(); });
        on('nexttrack', () => nextTrack(true));
        on('previoustrack', prevTrack);
    }

    // ---- the playlist list -----------------------------------------------------------

    const plList = $('#plList');
    const plRows = tracks.map((t) => {
        const li = el('li');
        const row = el('button', 'pl-row');
        row.type = 'button';
        row._track = t;
        const art = el('img', 'pl-art');
        art.alt = '';
        art.width = art.height = 40;
        art.loading = 'lazy';
        art.decoding = 'async';
        if (t.art) art.src = coverUrl(t, 80);
        const text = el('span', 'pl-text');
        text.append(el('span', 'pl-title', t.title), el('span', 'pl-artist', t.artist));
        row.append(el('span', 'pl-no', String(t.no)), art, text, el('span', 'pl-dur', t.ms ? fmtTime(t.ms / 1000) : ''));
        row.setAttribute('aria-label', `${t.no}. ${t.title} by ${t.artist}`);
        row.addEventListener('click', () => playTrack(t));
        li.appendChild(row);
        plList.appendChild(li);
        return row;
    });
    // keeps the song that's on in view inside the list, without moving the page
    function revealCurrentRow() {
        const row = plRows.find((r) => r._track === current);
        if (!row || row.parentElement.hidden) return;
        const li = row.parentElement;
        const top = li.offsetTop;
        if (top < plList.scrollTop || top + li.offsetHeight > plList.scrollTop + plList.clientHeight) {
            plList.scrollTo({ top: top - plList.clientHeight / 2 + li.offsetHeight / 2, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
        }
    }

    const plEmpty = el('li', 'pl-empty', 'No songs match');
    plEmpty.hidden = true;
    plList.appendChild(plEmpty);

    $('#plName').textContent = PLAYLIST.name;
    $('#plMeta').textContent = `${tracks.length} songs · ${fmtLong(tracks.reduce((s, t) => s + (t.ms || 0), 0) / 1000)}`;
    const plOpen = $('#plOpen');
    if (PLAYLIST.url) plOpen.href = PLAYLIST.url; else plOpen.hidden = true;

    const fold = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    $('#plFilter').addEventListener('input', (e) => {
        const q = fold(e.target.value.trim());
        let shown = 0;
        plRows.forEach((row) => {
            const hit = !q || fold(`${row._track.title} ${row._track.artist}`).includes(q);
            row.parentElement.hidden = !hit;
            if (hit) shown++;
        });
        plEmpty.hidden = shown > 0;
    });

    // ---- the scratch: a sung "ahh" a hand plays over the music ---------------------
    // Harmonics of a pitch curve, each weighted by how near it sits to the mouth's resonances
    // (formants), plus breath. Scratching never touches the song itself: a stream can't seek
    // that fast without breaking up. The read head follows the hand instead: forward plays the
    // cut, backward plays it reversed, still is silent, and the pitch goes with the speed.

    function formantVoice(rate, dur, { pitch, formants, amp, breath = 0 }) {
        const n = Math.round(rate * dur);
        const out = new Float32Array(n);
        const amps = new Float32Array(64);
        let ph = 0, lp = 0, lp2 = 0, kMax = 0, peak = 0;
        for (let i = 0; i < n; i++) {
            const t = i / rate;
            const f0 = pitch(t);
            if (i % 32 === 0) {
                const fm = formants(t);
                kMax = Math.min(64, Math.floor(5500 / f0));
                for (let k = 1; k <= kMax; k++) {
                    let h = 0;
                    for (const [F, B, g] of fm) { const x = (k * f0 - F) / (B / 2); h += g / (1 + x * x); }
                    amps[k - 1] = h / k;
                }
            }
            ph = (ph + f0 / rate) % 1;
            // sin(kθ) for every harmonic from one sin and one cos: sin(kθ) = 2cosθ·sin((k−1)θ) − sin((k−2)θ)
            const c2 = 2 * Math.cos(2 * Math.PI * ph);
            let sk = Math.sin(2 * Math.PI * ph), sk1 = 0, s = 0;
            for (let k = 1; k <= kMax; k++) {
                s += amps[k - 1] * sk;
                const next = c2 * sk - sk1;
                sk1 = sk;
                sk = next;
            }
            lp += (Math.random() * 2 - 1 - lp) * .35;
            lp2 += (lp - lp2) * .05;
            s = (s + (lp - lp2) * breath) * amp(t);
            out[i] = s;
            peak = Math.max(peak, Math.abs(s));
        }
        for (let i = 0; i < n; i++) out[i] = (out[i] / (peak || 1)) * .9;
        return out;
    }

    const CUT = { lead: .03, len: .4, tail: .07 };
    function scratchSample(rate) {
        const { lead, len, tail } = CUT;
        return formantVoice(rate, lead + len + tail, {
            pitch: (t) => 150 * (1 + .05 * clamp(1 - (t - lead) / len, 0, 1)) * (1 + .008 * Math.sin(2 * Math.PI * 5.5 * t)),
            formants: () => [[730, 110, 1], [1090, 130, .6], [2440, 180, .3], [3400, 260, .15]],
            amp: (t) => {
                const x = t - lead;
                return x < 0 || x > len ? 0 : Math.min(1, x / .012) * Math.min(1, (len - x) / .09) ** 1.5;
            },
            breath: .06,
        });
    }

    // kept as a plain class so the same code runs in an AudioWorklet or, without one, a ScriptProcessor
    class ScratchHead {
        constructor(data, rate) {
            this.data = data;
            this.pos = 0;
            this.speed = 0;
            this.target = 0;
            this.follow = 1 - Math.exp(-1 / (rate * .01)); // trails the hand by ~10 ms, so jumps glide
        }

        message(m) {
            if (m.speed !== undefined) this.target = m.speed;
            if (m.cue !== undefined && Math.abs(this.speed) < .02) this.pos = m.cue;
        }

        render(out) {
            const d = this.data;
            const n = d.length;
            for (let i = 0; i < out.length; i++) {
                this.speed += (this.target - this.speed) * this.follow;
                this.pos += this.speed;
                if (this.pos >= n) this.pos -= n;
                else if (this.pos < 0) this.pos += n;
                const i0 = Math.floor(this.pos);
                const s = d[i0] + (d[(i0 + 1) % n] - d[i0]) * (this.pos - i0);
                // like a cartridge, louder with speed: a still record is silent, a slow one quiet
                out[i] = s * Math.min(1, Math.abs(this.speed) * 2.5);
            }
        }
    }

    const SCRATCH_WORKLET = `${ScratchHead}
registerProcessor('scratch-head', class extends AudioWorkletProcessor {
    constructor(opts) {
        super();
        this.head = new ScratchHead(opts.processorOptions.data, sampleRate);
        this.port.onmessage = (e) => this.head.message(e.data);
    }
    process(inputs, outputs) {
        this.head.render(outputs[0][0]);
        return true;
    }
});`;

    let scratchVoice; // undefined = not built yet, null = building or unavailable
    function ensureScratchVoice() {
        if (scratchVoice !== undefined || !actx) return;
        scratchVoice = null;
        const rate = actx.sampleRate;
        const data = scratchSample(rate);
        const cue = Math.round(rate * CUT.lead);
        const voice = (send) => ({
            cue: () => send({ cue }),
            // hand speed eases off towards 4x, past which the cut turns to chirps
            move: (speed) => send({ speed: Number.isFinite(speed) ? 4 * Math.tanh(speed / 4) : 0 }),
        });
        const fallback = () => {
            try {
                const head = new ScratchHead(data, rate);
                const node = actx.createScriptProcessor(1024, 1, 1);
                node.onaudioprocess = (e) => head.render(e.outputBuffer.getChannelData(0));
                node.connect(fxGain);
                scratchVoice = voice((m) => head.message(m));
            } catch { /* no way to play it; scratching stays silent */ }
        };
        if (!actx.audioWorklet) { fallback(); return; }
        const url = URL.createObjectURL(new Blob([SCRATCH_WORKLET], { type: 'text/javascript' }));
        actx.audioWorklet.addModule(url).then(() => {
            const node = new AudioWorkletNode(actx, 'scratch-head', {
                numberOfInputs: 0, outputChannelCount: [1], processorOptions: { data },
            });
            node.connect(fxGain);
            scratchVoice = voice((m) => node.port.postMessage(m));
        }).catch(fallback).finally(() => URL.revokeObjectURL(url));
    }

    function setDuck(on) {
        const d = on && scratchVoice ? .5 : 1;
        if (d === duck) return;
        duck = d;
        applyVolume();
    }

    // ---- deck sounds: dull and creamy --------------------------------------------------------
    // Made on the spot, so there's nothing to load: a low, soft "thock" for the keys, a muffled
    // tock when the arm lifts or comes to rest, a thud with a little crackle when the stylus
    // lands, and the record settling onto the felt. Everything is low-passed so nothing clicks
    // sharply, and it all goes through the volume control.

    let noiseBuf = null;
    function noiseSource() {
        if (!noiseBuf) {
            const n = actx.sampleRate;
            noiseBuf = actx.createBuffer(1, n, actx.sampleRate);
            const d = noiseBuf.getChannelData(0);
            for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        }
        const src = actx.createBufferSource();
        src.buffer = noiseBuf;
        return src;
    }
    function envelope(param, t0, peak, attack, decay) {
        param.setValueAtTime(.0001, t0);
        param.exponentialRampToValueAtTime(peak, t0 + attack);
        param.exponentialRampToValueAtTime(.0001, t0 + attack + decay);
    }

    // a pitched body that drops as it fades, a rounder overtone and a soft, filtered knock
    function thock(t0, { f = 190, drop = .55, level = .5, len = .09, tone = 1400, knock = .12 } = {}) {
        const out = actx.createBiquadFilter();
        out.type = 'lowpass';
        out.frequency.value = tone;
        out.Q.value = .4;
        out.connect(fxGain);
        const end = t0 + len + .06;
        const body = actx.createOscillator();
        body.frequency.setValueAtTime(f, t0);
        body.frequency.exponentialRampToValueAtTime(f * drop, t0 + len * .6);
        const bg = actx.createGain();
        envelope(bg.gain, t0, level, .003, len);
        body.connect(bg).connect(out);
        body.start(t0);
        body.stop(end);
        const over = actx.createOscillator();
        over.type = 'triangle';
        over.frequency.setValueAtTime(f * 1.5, t0);
        over.frequency.exponentialRampToValueAtTime(f * drop * 1.5, t0 + len * .5);
        const og = actx.createGain();
        envelope(og.gain, t0, level * .22, .002, len * .6);
        over.connect(og).connect(out);
        over.start(t0);
        over.stop(end);
        if (knock) {
            const n = noiseSource();
            const nf = actx.createBiquadFilter();
            nf.type = 'bandpass';
            nf.frequency.value = Math.min(tone, 900);
            nf.Q.value = .7;
            const ng = actx.createGain();
            envelope(ng.gain, t0, knock, .001, .028);
            n.connect(nf).connect(ng).connect(out);
            n.start(t0, Math.random() * .8);
            n.stop(t0 + .07);
        }
    }

    // a few soft pops and a breath of surface noise, as the stylus finds the groove
    function crackle(t0, dur) {
        const n = noiseSource();
        const hp = actx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 400;
        const lp = actx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2400;
        const g = actx.createGain();
        g.gain.setValueAtTime(.0001, t0);
        g.gain.exponentialRampToValueAtTime(.025, t0 + .03);
        g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
        n.connect(hp).connect(lp).connect(g).connect(fxGain);
        n.start(t0, Math.random() * .3);
        n.stop(t0 + dur + .05);
        for (let i = 0; i < 7; i++) {
            const at = t0 + .02 + Math.random() * dur * .8;
            thock(at, { f: 900 + Math.random() * 900, drop: .8, level: .02 + Math.random() * .03, len: .006, tone: 2600, knock: .02 });
        }
    }

    const SOUNDS = {
        click(t) { // a key going down, then a quieter one as it springs back
            const f = 185 * (1 + (Math.random() - .5) * .08);
            thock(t, { f, level: .5 });
            thock(t + .07, { f: f * 1.18, level: .14, len: .05, knock: .05 });
        },
        lift(t) { thock(t, { f: 250, drop: .7, level: .2, len: .05, tone: 1500, knock: .06 }); },
        rest(t) { thock(t, { f: 210, drop: .6, level: .2, len: .06, tone: 1100, knock: .05 }); },
        drop(t) {
            thock(t, { f: 92, drop: .5, level: .5, len: .16, tone: 650, knock: .18 });
            crackle(t + .02, .7);
        },
        place(t) { thock(t, { f: 78, drop: .6, level: .38, len: .14, tone: 450, knock: .25 }); },
    };
    SOUNDS.key = SOUNDS.click;

    function sfx(name) {
        if (!SOUNDS[name]) return;
        ensureAudioGraph();
        if (!actx || !fxGain) return;
        if (actx.state === 'suspended') actx.resume();
        try { SOUNDS[name](actx.currentTime + .005); } catch { /* an old browser: stay quiet */ }
    }

    // ---- the turntable ---------------------------------------------------------------
    // turntable.js is the 3D record player (three.js, bundled). Without WebGL, or if it fails
    // to load, the flat record stays and still plays and pauses on a tap.

    const ttHost = $('#tt');
    const scratchHooks = {
        onToggle: toggle,
        onScratchStart() {
            ensureAudioGraph();
            if (actx && actx.state === 'suspended') actx.resume();
            ensureScratchVoice();
            scratchVoice?.cue();
        },
        onScratchMove(speed) {   // 1 = the record's own speed forward
            scratchVoice?.move(speed);
            setDuck(Math.abs(speed) > .05);
        },
        onScratchEnd() {
            scratchVoice?.move(0);
            setDuck(false);
        },
        onSound: sfx,
    };
    flatRecord.addEventListener('click', () => { sfx('click'); toggle(); });

    import('./turntable.js')
        .then(({ createTurntable }) => createTurntable(ttHost, { ...scratchHooks, colors: readTurntableColors(), reduceMotion }))
        .then((tt) => {
            turntable = tt;
            if (current) { tt.setTrack(current, false); renderPlayedInfo(); }
            tt.setPlaying(playing);
            flatRecord.classList.remove('is-spinning');
            ttHost.classList.add('is-3d');
        })
        .catch((err) => { console.warn('3D turntable unavailable:', err); });

    // ---- keyboard ----------------------------------------------------------------------

    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
        const t = e.target;
        const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
        const interactive = typing || t.tagName === 'BUTTON' || t.tagName === 'A';
        const key = e.key.toLowerCase();
        if (e.code === 'Space' && !interactive) {
            e.preventDefault();
            sfx('click');
            toggle();
        } else if (/^[1-3]$/.test(e.key) && !typing) {
            const row = $(`.link[data-key="${e.key}"]`);
            if (!row) return;
            row.querySelector('[data-copy]')?.click();
            row.classList.add('is-hit');
            setTimeout(() => row.classList.remove('is-hit'), 700);
        } else if (key === 'n' && !typing) {
            sfx('click');
            nextTrack();
        } else if (key === 'p' && !typing) {
            sfx('click');
            prevTrack();
        }
    });

    // ---- Discord (Lanyard) -----------------------------------------------------------------
    // Lanyard shares the live presence of accounts that joined its Discord server. On the live
    // site the card stays hidden until there's data; while testing locally it says what's missing.

    const dbox = $('#dbox');
    const STATUS = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline' };
    const VERB = { 0: 'Playing', 1: 'Streaming', 2: 'Listening to', 3: 'Watching', 5: 'Competing in' };
    let dSig = '';

    function discordUnavailable(why) {
        dSig = '';
        if (!testing) { dbox.hidden = true; return; }
        dbox.hidden = false;
        $('#dName').textContent = 'Discord';
        $('#dSub').textContent = 'Not connected';
        $('#dStatus').textContent = '';
        $('#dActs').textContent = '';
        const note = $('#dNote');
        note.hidden = false;
        note.textContent = `${why} This note only shows while testing locally.`;
    }

    function assetUrl(a) {
        const img = a.assets?.large_image;
        if (!img) return '';
        if (img.startsWith('mp:')) return `https://media.discordapp.net/${img.slice(3)}`;
        if (img.startsWith('spotify:')) return `https://i.scdn.co/image/${img.slice(8)}`;
        return a.application_id ? `https://cdn.discordapp.com/app-assets/${a.application_id}/${img}.png` : '';
    }

    function addActivity({ label, title, detail, img, start, end, quiet }) {
        const row = el('div', `dact${quiet ? ' is-quiet' : ''}`);
        if (img) {
            const im = el('img', 'dact-img');
            im.alt = '';
            im.src = img;
            im.addEventListener('error', () => im.remove());
            row.appendChild(im);
        }
        const text = el('div', 'dact-text');
        if (label) text.appendChild(el('span', 'dact-label', label));
        if (title) text.appendChild(el('span', 'dact-title', title));
        if (detail) text.appendChild(el('span', 'dact-detail', detail));
        if (start) {
            const time = el('span', 'dact-time', ' ');
            time.dataset.start = start;
            if (end) time.dataset.end = end;
            text.appendChild(time);
        }
        row.appendChild(text);
        $('#dActs').appendChild(row);
    }

    function tickActivityTimes() {
        const now = Date.now();
        const fmt = (s) => (s >= 3600 ? fmtLong(s) : fmtTime(s));
        $$('.dact-time', dbox).forEach((t) => {
            const start = +t.dataset.start;
            const end = +t.dataset.end;
            const s = Math.max(0, (now - start) / 1000);
            t.textContent = end ? `${fmt(Math.min(s, (end - start) / 1000))} / ${fmt((end - start) / 1000)}` : `${fmt(s)} elapsed`;
        });
    }
    setInterval(tickActivityTimes, 1000);

    function renderDiscord(d) {
        dbox.hidden = false;
        $('#dNote').hidden = true;
        const u = d.discord_user || {};
        const sig = JSON.stringify([d.discord_status, u.avatar, u.global_name, u.username, d.activities, d.spotify?.track_id,
            d.active_on_discord_desktop, d.active_on_discord_mobile, d.active_on_discord_web]);
        if (sig === dSig) return;
        dSig = sig;

        const status = STATUS[d.discord_status] ? d.discord_status : 'offline';
        $('#dStatus').textContent = STATUS[status];
        $('#dDot').dataset.status = status;
        $('#dName').textContent = u.global_name || u.display_name || u.username || 'stole';
        const where = d.active_on_discord_desktop ? 'desktop' : d.active_on_discord_mobile ? 'phone' : d.active_on_discord_web ? 'browser' : '';
        $('#dSub').textContent = [u.username && `@${u.username}`, status !== 'offline' && where && `on ${where}`].filter(Boolean).join(' · ');
        const fallback = u.id ? Number((BigInt(u.id) >> 22n) % 6n) : 0;
        const av = $('#dAvatar');
        const src = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
            : `https://cdn.discordapp.com/embed/avatars/${fallback}.png`;
        if (av.getAttribute('src') !== src) av.src = src;

        const acts = $('#dActs');
        acts.textContent = '';
        const list = d.activities || [];
        const custom = list.find((a) => a.type === 4);
        if (custom?.state) addActivity({ label: 'Status', title: `${custom.emoji && !custom.emoji.id ? `${custom.emoji.name} ` : ''}${custom.state}` });
        if (d.listening_to_spotify && d.spotify) {
            const s = d.spotify;
            addActivity({ label: 'Listening on Spotify', title: s.song, detail: s.artist?.replace(/;/g, ','), img: s.album_art_url, start: s.timestamps?.start, end: s.timestamps?.end });
        }
        list.filter((a) => a.type !== 4 && !(a.type === 2 && a.name === 'Spotify')).forEach((a) => {
            addActivity({ label: VERB[a.type] || 'Playing', title: a.name, detail: [a.details, a.state].filter(Boolean).join(' · '), img: assetUrl(a), start: a.timestamps?.start });
        });
        if (!acts.children.length) addActivity({ title: status === 'offline' ? 'Offline right now' : 'Nothing going on right now', quiet: true });
        tickActivityTimes();
    }

    async function pollDiscord() {
        if (document.hidden) return;
        try {
            const res = await fetch(`https://api.lanyard.rest/v1/users/${CONFIG.discordId}`, { cache: 'no-store' });
            const body = await res.json();
            if (body.success && body.data) renderDiscord(body.data);
            else discordUnavailable(body.error?.code === 'user_not_monitored'
                ? 'Lanyard isn’t watching this account yet. Join discord.gg/lanyard with it and the live status shows up here.'
                : 'Lanyard answered with an error.');
        } catch {
            discordUnavailable('Lanyard couldn’t be reached.');
        }
    }
    pollDiscord();
    setInterval(pollDiscord, 20000);

    // ---- Last.fm: listening stats and recently played -----------------------------------
    // Apple Music keeps listening history to itself, so plays get scrobbled to Last.fm (a
    // scrobbler app does that) and are read back from there. Covers and Apple Music links come
    // from the playlist when the song is in it, otherwise from Apple's search.

    const stats = $('#stats');
    const statsNote = $('#statsNote');
    const LASTFM_BLANK = '2a96cbd8b46e442fc41c2b86b821562f'; // Last.fm's grey star placeholder
    const PERIODS = {
        '7day': { days: 7, label: 'last 7 days' },
        '1month': { days: 30, label: 'last 30 days' },
        '12month': { days: 365, label: 'last 12 months' },
        overall: { days: 0, label: 'all time' },
    };
    let period = PERIODS[store.get('stole:period')] ? store.get('stole:period') : '1month';
    const norm = (s) => fold(s).replace(/\s*[([].*?[)\]]/g, '').replace(/\s+(feat|ft)\.?\s.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const leadArtist = (s) => norm((s || '').split(/,|&|\s+x\s+|\s+(?:feat|ft)\.?\s/i)[0]);
    const songKey = (title, artist) => `${leadArtist(artist)}|${norm(title)}`;
    const inPlaylist = new Map(tracks.map((t) => [songKey(t.title, t.artist), t]));
    const lookups = new Map();
    const lastfmImg = (imgs) => [].concat(imgs || []).reverse().find((i) => i['#text'] && !i['#text'].includes(LASTFM_BLANK))?.['#text'] || '';

    async function lastfm(method, params = {}) {
        const q = new URLSearchParams({ method, format: 'json', user: CONFIG.lastfmUser, api_key: CONFIG.lastfmKey, ...params });
        const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${q}`, { cache: 'no-store' });
        const body = await res.json();
        if (body.error) throw new Error(body.message || `Last.fm error ${body.error}`);
        return body;
    }

    // Apple's search is picky, so it tries "artist title" first, then the title alone
    function lookUp(item) {
        const key = songKey(item.title, item.artist);
        if (lookups.has(key)) return lookups.get(key);
        const job = (async () => {
            const t = inPlaylist.get(key);
            if (t) return { art: coverUrl(t, 120), url: `https://music.apple.com/de/song/${t.id}`, track: t };
            const saved = store.get(`stole:song:${key}`);
            if (saved) { try { return JSON.parse(saved); } catch { /* look it up again */ } }
            const hit = { art: '', url: '' };
            try {
                for (const term of [`${item.artist} ${item.title}`, item.title]) {
                    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=25&country=de`);
                    const data = await res.json();
                    const r = (data.results || []).find((x) => norm(x.trackName) === norm(item.title) && norm(x.artistName).includes(leadArtist(item.artist)));
                    if (r) { hit.art = (r.artworkUrl100 || '').replace('100x100bb', '120x120bb'); hit.url = r.trackViewUrl || ''; break; }
                }
            } catch {
                lookups.delete(key); // offline: try again next time rather than remember a miss
                return hit;
            }
            store.set(`stole:song:${key}`, JSON.stringify(hit));
            return hit;
        })();
        lookups.set(key, job);
        return job;
    }

    function ago(ms) {
        const s = Math.max(0, (Date.now() - ms) / 1000);
        if (s < 90) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400) { const h = Math.floor(s / 3600); return `${h} h ago`; }
        const d = Math.floor(s / 86400);
        return d === 1 ? 'yesterday' : `${d} days ago`;
    }

    // a song row: cover, title, artist, and something on the right (plays, or when)
    function songRow(item, meta) {
        const li = el('li', `row${item.now ? ' is-now' : ''}`);
        const art = el('span', 'row-art');
        const main = el('a', 'row-main');
        main.target = '_blank';
        main.rel = 'noopener';
        main.href = `https://music.apple.com/de/search?term=${encodeURIComponent(`${item.artist} ${item.title}`)}`;
        main.append(el('span', 'row-title', item.title), el('span', 'row-sub', item.artist));
        const m = el('span', 'row-meta');
        if (item.now) m.innerHTML = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>Now';
        else m.textContent = meta;
        if (item.at) m.dataset.at = item.at;
        li.append(art, main, m);
        lookUp(item).then((hit) => {
            const src = hit.art || item.img;
            if (src) {
                const img = el('img');
                img.alt = '';
                img.decoding = 'async';
                img.src = src;
                img.addEventListener('error', () => img.remove());
                art.appendChild(img);
            }
            if (hit.url) main.href = hit.url;
        });
        return li;
    }

    // top artists: ranked bars, one hue, the value at the tip and in a tooltip on hover
    const tip = el('div', 'tip');
    document.body.appendChild(tip);
    function showTip(e, text) {
        tip.textContent = text;
        tip.style.left = `${e.clientX}px`;
        tip.style.top = `${e.clientY}px`;
        tip.classList.add('on');
    }
    const hideTip = () => tip.classList.remove('on');

    function renderTopArtists(list, total) {
        const ol = $('#topArtists');
        ol.textContent = '';
        const max = Math.max(1, ...list.map((a) => a.plays));
        list.forEach((a, i) => {
            const li = el('li', 'bar-row');
            li.style.setProperty('--i', i);
            const name = el('a', 'name', a.name);
            name.href = a.url;
            name.target = '_blank';
            name.rel = 'noopener';
            const bar = el('span', 'track');
            const fill = el('span', 'fill');
            fill.style.setProperty('--w', `${(a.plays / max) * 100}%`);
            bar.appendChild(fill);
            li.append(el('span', 'no', String(i + 1)), name, el('span', 'v', fmtNum(a.plays)), bar);
            const share = total ? ` · ${Math.round((a.plays / total) * 100)}% of plays` : '';
            li.addEventListener('pointermove', (e) => showTip(e, `${a.name} · ${fmtNum(a.plays)} ${a.plays === 1 ? 'play' : 'plays'}${share}`));
            li.addEventListener('pointerleave', hideTip);
            ol.appendChild(li);
        });
        if (!list.length) ol.appendChild(el('li', 'row-sub', 'No plays in this period'));
    }

    function renderTopTracks(list) {
        const ol = $('#topTracks');
        ol.textContent = '';
        list.forEach((t) => ol.appendChild(songRow(t, `${fmtNum(t.plays)}×`)));
        if (!list.length) ol.appendChild(el('li', 'row-sub', 'No plays in this period'));
    }

    let recentSig = '';
    function renderRecent(list) {
        const sig = JSON.stringify(list.map((i) => [i.title, i.artist, i.at, i.now]));
        if (sig === recentSig) { tickRecent(); return; }
        recentSig = sig;
        const ol = $('#recentList');
        ol.textContent = '';
        list.forEach((t) => ol.appendChild(songRow(t, '')));
        tickRecent();
    }
    function tickRecent() {
        $$('#recentList .row-meta').forEach((m) => { if (m.dataset.at) m.textContent = ago(+m.dataset.at); });
    }
    setInterval(tickRecent, 30000);

    function statsUnavailable(why) {
        if (!testing) { stats.hidden = true; return; }
        stats.hidden = false;
        statsNote.hidden = false;
        statsNote.textContent = `${why} This note only shows while testing locally; on the live site this section stays hidden until Last.fm answers.`;
    }

    const periodBtns = $$('#period button');
    function paintPeriod() {
        periodBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.period === period)));
        const label = PERIODS[period].label;
        $('#tileScrobblesLabel').textContent = `Scrobbles, ${label}`;
        $('#tileArtistsLabel').textContent = `Artists, ${label}`;
    }
    periodBtns.forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.period === period) return;
        period = b.dataset.period;
        store.set('stole:period', period);
        paintPeriod();
        loadTops();
    }));
    paintPeriod();

    let topsTurn = 0;
    async function loadTops() {
        const turn = ++topsTurn;
        const p = period;
        const from = PERIODS[p].days ? Math.floor(Date.now() / 1000 - PERIODS[p].days * 86400) : 0;
        try {
            const [artists, top, count] = await Promise.all([
                lastfm('user.gettopartists', { period: p, limit: 8 }),
                lastfm('user.gettoptracks', { period: p, limit: 6 }),
                from ? lastfm('user.getrecenttracks', { from, limit: 1 }) : null,
            ]);
            if (turn !== topsTurn) return;
            const artistList = [].concat(artists.topartists?.artist || []).map((a) => ({ name: a.name, plays: +a.playcount || 0, url: a.url }));
            const trackList = [].concat(top.toptracks?.track || []).map((t) => ({
                title: t.name, artist: t.artist?.name || '', plays: +t.playcount || 0, img: lastfmImg(t.image),
            }));
            const scrobbles = count ? +count.recenttracks?.['@attr']?.total || 0 : totalScrobbles;
            $('#tileScrobbles').textContent = scrobbles != null ? fmtNum(scrobbles) : '–';
            $('#tileArtists').textContent = fmtNum(+artists.topartists?.['@attr']?.total || artistList.length);
            renderTopArtists(artistList, scrobbles);
            renderTopTracks(trackList);
            stats.hidden = false;
        } catch (err) {
            if (turn === topsTurn && stats.hidden) statsUnavailable(`Last.fm couldn’t be read (${err.message}).`);
        }
    }

    let totalScrobbles = null;
    async function loadInfo() {
        try {
            const info = await lastfm('user.getinfo');
            totalScrobbles = +info.user?.playcount || 0;
            $('#tileTotal').textContent = fmtNum(totalScrobbles);
            if (period === 'overall') $('#tileScrobbles').textContent = fmtNum(totalScrobbles);
            if (info.user?.url) $('#lfmLink').href = info.user.url;
        } catch { /* the tile keeps its dash */ }
    }

    // ---- when each song was last played: the newest 1,000 plays from Last.fm ----------------

    const lastPlayed = new Map(); // songKey -> time in ms
    let nowPlayingKey = '';
    let historyState = 'loading'; // loading | complete (every play read) | partial | failed

    function notePlay(title, artist, at, now) {
        const key = songKey(title, artist);
        if (now) nowPlayingKey = key;
        if (at > (lastPlayed.get(key) || 0)) lastPlayed.set(key, at);
    }

    async function loadHistory() {
        try {
            for (let page = 1; page <= 5; page++) {
                const body = await lastfm('user.getrecenttracks', { limit: 200, page });
                [].concat(body.recenttracks?.track || []).forEach((t) => {
                    if (t.date?.uts) notePlay(t.name, t.artist?.['#text'] || t.artist?.name, t.date.uts * 1000, false);
                });
                const pages = +body.recenttracks?.['@attr']?.totalPages || 1;
                if (page >= pages) { historyState = 'complete'; break; }
                historyState = 'partial';
            }
        } catch {
            historyState = 'failed';
        }
        renderPlayedInfo();
    }

    // 18h, 3d, 2w: short enough for the key on the deck
    function shortAgo(ms) {
        const s = Math.max(0, (Date.now() - ms) / 1000);
        if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
        if (s < 86400) return `${Math.floor(s / 3600)}h`;
        if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
        if (s < 86400 * 60) return `${Math.floor(s / 86400 / 7)}w`;
        if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo`;
        return `${Math.floor(s / 86400 / 365)}y`;
    }

    function renderPlayedInfo() {
        const t = current;
        if (!t) return;
        const key = songKey(t.title, t.artist);
        const at = lastPlayed.get(key);
        let short = '';
        let long = '';
        if (key === nowPlayingKey) { short = 'now'; long = 'Playing on Apple Music right now'; }
        else if (at) { short = shortAgo(at); long = `Last played ${ago(at)}`; }
        else if (historyState === 'complete') { short = 'never'; long = 'Not played yet'; }
        $('#npMeta').textContent = [`No. ${t.no}`, long].filter(Boolean).join(' · ');
        turntable?.setInfo({ no: t.no, last: short });
    }
    setInterval(renderPlayedInfo, 60000);

    async function pollRecent() {
        if (document.hidden) return;
        try {
            const body = await lastfm('user.getrecenttracks', { limit: 6 });
            const list = [].concat(body.recenttracks?.track || []).slice(0, 6).map((t) => ({
                title: t.name || '',
                artist: t.artist?.['#text'] || t.artist?.name || '',
                at: t.date?.uts ? t.date.uts * 1000 : 0,
                now: t['@attr']?.nowplaying === 'true',
                img: lastfmImg(t.image),
            }));
            renderRecent(list);
            nowPlayingKey = '';
            list.forEach((t) => notePlay(t.title, t.artist, t.at || Date.now(), t.now));
            renderPlayedInfo();
        } catch { /* keep the last list up */ }
    }

    if (CONFIG.lastfmUser && CONFIG.lastfmKey) {
        loadInfo().then(loadTops);
        pollRecent();
        loadHistory();
        setInterval(pollRecent, 60000);
    } else {
        statsUnavailable('Last.fm isn’t connected: put a Last.fm username and API key into CONFIG at the top of app.js.');
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        pollDiscord();
        pollRecent();
    });

    // ---- start -------------------------------------------------------------------------

    loadTrack(tracks[Math.floor(Math.random() * tracks.length)], false);
})();
