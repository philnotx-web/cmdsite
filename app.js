(() => {
    'use strict';

    const CONFIG = {
        timeZone: 'Europe/Berlin',
        discordId: '1492904216514265128',
        // "Recently played" reads plays scrobbled from Apple Music to Last.fm.
        // Free API key: https://www.last.fm/api/account/create
        lastfmUser: 'imsolost222',
        lastfmKey: 'd7d05b5352f4a3571646f0768c53a46b',
        barcodeBase: '2026000009', // + 2-digit edition code, check digit added. Prefix 2 = in-store use, not a real product
    };

    // playlist.js provides the tracks; without it there's just the one local song
    const PLAYLIST = window.STOLE_PLAYLIST?.tracks?.length ? window.STOLE_PLAYLIST : {
        name: 'stole.cc', url: '',
        tracks: [{ id: 'local', title: 'Play Em Like Atari', artist: 'Vanish Boys', file: 'music.mp3' }],
    };

    const EDITIONS = {
        silver: { name: 'Silver', cat: 'STL-009', code: '01' },
        black: { name: 'Black', cat: 'STL-009-BK', code: '02' },
        ice: { name: 'Ice', cat: 'STL-009-IC', code: '03' },
        bootleg: { name: 'Bootleg', cat: 'STL-009-CDR', code: '04' },
    };

    // ---- helpers ------------------------------------------------------------

    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => [...r.querySelectorAll(s)];
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const SVGNS = 'http://www.w3.org/2000/svg';
    const root = document.documentElement;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
    const darkScheme = matchMedia('(prefers-color-scheme: dark)');
    const store = {
        get(k) { try { return localStorage.getItem(k); } catch { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
    };
    const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const fmtLong = (t) => `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const overHttp = /^https?:$/.test(location.protocol);

    const announcer = $('#announce');
    function announce(text) {
        announcer.textContent = '';
        requestAnimationFrame(() => { announcer.textContent = text; });
    }

    // ---- clock --------------------------------------------------------------

    const clockEl = $('#clock');
    const tzEl = $('#tz');
    const clockFmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: CONFIG.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    });
    function tickClock() {
        const parts = clockFmt.formatToParts(new Date());
        const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
        clockEl.textContent = `${get('hour')}:${get('minute')}`;
        tzEl.textContent = get('timeZoneName');
    }
    tickClock();
    setInterval(tickClock, 15000);

    // ---- seven-segment display ----------------------------------------------

    const T = 2.2, G = .45, X0 = 1.6, X1 = 10.4, Y0 = 1.6, YM = 11, Y1 = 20.4;
    const H = (x1, x2, y) => [[x1, y], [x1 + T / 2, y - T / 2], [x2 - T / 2, y - T / 2], [x2, y], [x2 - T / 2, y + T / 2], [x1 + T / 2, y + T / 2]];
    const V = (x, y1, y2) => [[x, y1], [x + T / 2, y1 + T / 2], [x + T / 2, y2 - T / 2], [x, y2], [x - T / 2, y2 - T / 2], [x - T / 2, y1 + T / 2]];
    const SEGMENTS = {
        a: H(X0 + G, X1 - G, Y0), b: V(X1, Y0 + G, YM - G), c: V(X1, YM + G, Y1 - G),
        d: H(X0 + G, X1 - G, Y1), e: V(X0, YM + G, Y1 - G), f: V(X0, Y0 + G, YM - G), g: H(X0 + G, X1 - G, YM),
    };
    const GLYPHS = {
        0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
        '-': 'g', ' ': '', n: 'ceg', o: 'cdeg', d: 'bcdeg', I: 'bc', S: 'acdfg', C: 'adef',
    };

    function makeDigits(host, count) {
        const out = [];
        for (let i = 0; i < count; i++) {
            const svg = document.createElementNS(SVGNS, 'svg');
            svg.setAttribute('viewBox', '0 0 12 22');
            svg.setAttribute('class', 'digit');
            for (const [name, pts] of Object.entries(SEGMENTS)) {
                const poly = document.createElementNS(SVGNS, 'polygon');
                poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
                poly.dataset.s = name;
                svg.appendChild(poly);
            }
            host.appendChild(svg);
            out.push(svg);
        }
        return out;
    }

    function setDigits(digits, str) {
        digits.forEach((svg, i) => {
            const ch = str[i] ?? ' ';
            if (svg._ch === ch) return;
            svg._ch = ch;
            const lit = GLYPHS[ch] ?? '';
            for (const poly of svg.children) poly.classList.toggle('on', lit.includes(poly.dataset.s));
        });
    }

    const trackDigits = makeDigits($('#segTrack'), 3);
    const timeDigits = [...makeDigits($('#tA'), 2), ...makeDigits($('#tB'), 2)];
    const colon = $('#colon');
    const timeCap = $('#timeCap');
    const icoPlay = $('#icoPlay');
    const icoPause = $('#icoPause');
    const indShuffle = $('#indShuffle');
    const indPreview = $('#indPreview');
    const indOpen = $('#indOpen');

    // ---- meters: LCD rows, spectrum, spines ----------------------------------

    const CELLS = 16;
    const meterRows = ['#mL', '#mR'].map((sel) => {
        const row = $(sel);
        const cells = [];
        for (let i = 0; i < CELLS; i++) cells.push(row.appendChild(document.createElement('i')));
        return { cells, lit: -1, peak: -1 };
    });

    const BANDS = 24;
    const SPEC_SEGS = 14;
    const F_LO = 40, F_HI = 16000;
    const bandEdge = (i) => F_LO * (F_HI / F_LO) ** (i / BANDS);
    const specCols = [];
    for (let i = 0; i < BANDS; i++) {
        const col = document.createElement('i');
        col.appendChild(document.createElement('b'));
        $('#spec').appendChild(col);
        specCols.push({ el: col, n: -1, pk: -1 });
    }

    const VU_PITCH = 5; // px per segment, matches the stripe in the CSS
    const vus = ['#vuL', '#vuR'].map((sel) => ({ el: $(sel), lit: -1, pk: -1 }));
    let vuSegs = 0;
    function measureVu() {
        vuSegs = Math.floor(vus[0].el.clientHeight / VU_PITCH);
        vus.forEach((v) => { v.lit = v.pk = -1; });
    }
    if ('ResizeObserver' in window) new ResizeObserver(measureVu).observe(vus[0].el);
    measureVu();

    // ---- LCD text line ------------------------------------------------------

    const lcdText = $('#lcdText');
    let msgTimer = 0;

    function showTicker(text) {
        lcdText.textContent = '';
        const mq = document.createElement('span');
        mq.className = 'mq';
        mq.style.setProperty('--mq', `${Math.max(8, text.length * .42)}s`);
        for (let i = 0; i < 2; i++) {
            const s = document.createElement('span');
            s.textContent = text;
            mq.appendChild(s);
        }
        lcdText.appendChild(mq);
    }

    function showIdleText() {
        msgTimer = 0;
        if (noDisc) lcdText.textContent = 'NO DISC';
        else if (current) showTicker(`${current.title} · ${current.artist}`.toUpperCase());
    }

    function lcdMessage(text, ms = 2200) {
        clearTimeout(msgTimer);
        lcdText.textContent = text.toUpperCase();
        lightUp(ms);
        msgTimer = setTimeout(showIdleText, ms);
    }

    // ---- editions -------------------------------------------------------------

    const currentEdition = () => (EDITIONS[root.dataset.edition] ? root.dataset.edition : (darkScheme.matches ? 'black' : 'silver'));
    let switchTimer = 0;

    function syncEdition() {
        const ed = currentEdition();
        const info = EDITIONS[ed];
        $$('.js-cat').forEach((el) => { el.textContent = info.cat; });
        $$('.js-ed').forEach((el) => { el.textContent = info.name; });
        const input = $(`input[name="edition"][value="${ed}"]`);
        if (input) input.checked = true;
        drawBarcode($('#barcode'), CONFIG.barcodeBase + info.code);
        paintAvatar();
        if (root.dataset.edition) {
            const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
            $$('meta[name="theme-color"]').forEach((m) => { m.content = paper; });
        }
    }

    function setEdition(ed) {
        if (!EDITIONS[ed] || (root.dataset.edition === ed)) return;
        store.set('stole:edition', ed);
        const apply = () => { root.dataset.edition = ed; syncEdition(); };
        if (document.startViewTransition && !reduceMotion.matches) {
            document.startViewTransition(apply);
        } else {
            root.classList.add('is-switching');
            apply();
            clearTimeout(switchTimer);
            switchTimer = setTimeout(() => root.classList.remove('is-switching'), 600);
        }
        lcdMessage(`${EDITIONS[ed].name} edition · ${EDITIONS[ed].cat}`);
        announce(`${EDITIONS[ed].name} edition`);
    }

    function nextEdition() {
        const keys = Object.keys(EDITIONS);
        setEdition(keys[(keys.indexOf(currentEdition()) + 1) % keys.length]);
    }

    $('#shelf').addEventListener('change', (e) => {
        if (e.target.name === 'edition') setEdition(e.target.value);
    });
    darkScheme.addEventListener?.('change', () => { if (!root.dataset.edition) syncEdition(); });

    // ---- audio ----------------------------------------------------------------

    const audio = $('#audio');
    const deck = $('#deck');
    const insert = $('#insert');
    const disc = $('#disc');
    const discRot = $('#discRot');
    const playBtn = $('#playBtn');
    const seek = $('#seek');
    const seekBox = $('#seekBox');
    const ticks = $('#ticks');
    const volIn = $('#vol');

    let playing = false;   // what the element is doing
    let wantPlay = false;  // what the listener asked for; survives track changes and load errors
    let noDisc = false;
    let scrubbing = false;
    let switching = false;
    let showRemaining = false;
    let lightTimer = 0;
    let scratch = null;    // set while a hand is on the disc

    // vinyl-style pitch bend while scratching
    audio.preservesPitch = false;
    audio.mozPreservesPitch = false;
    audio.webkitPreservesPitch = false;

    let actx; // undefined = not tried yet, null = unavailable
    let gain = null, anMain = null, anL = null, anR = null;
    let bufL, bufR, freqBuf, bandBins;

    function ensureAudioGraph() {
        if (actx !== undefined) return;
        actx = null;
        // From file:// the browser treats audio as cross-origin and Web Audio would output silence
        if (!overHttp) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try {
            actx = new AC();
            const src = actx.createMediaElementSource(audio);
            gain = actx.createGain();
            src.connect(gain).connect(actx.destination);

            anMain = actx.createAnalyser();
            anMain.fftSize = 4096;
            anMain.smoothingTimeConstant = .5;
            anMain.minDecibels = -95;
            anMain.maxDecibels = -25;
            src.connect(anMain);
            freqBuf = new Uint8Array(anMain.frequencyBinCount);
            const binHz = actx.sampleRate / anMain.fftSize;
            bandBins = Array.from({ length: BANDS }, (_, i) => {
                const lo = Math.max(1, Math.floor(bandEdge(i) / binHz));
                const hi = Math.max(lo + 1, Math.ceil(bandEdge(i + 1) / binHz));
                return [lo, Math.min(hi, freqBuf.length)];
            });

            const split = actx.createChannelSplitter(2);
            src.connect(split);
            anL = actx.createAnalyser();
            anR = actx.createAnalyser();
            anL.fftSize = anR.fftSize = 1024;
            split.connect(anL, 0);
            split.connect(anR, 1);
            bufL = new Float32Array(anL.fftSize);
            bufR = new Float32Array(anR.fftSize);
            applyVolume();
        } catch {
            actx = null;
            gain = anMain = anL = anR = null;
        }
    }

    // volume goes through a GainNode when available, because iOS ignores audio.volume
    let vol = clamp(parseInt(store.get('stole:vol') ?? '70', 10) || 0, 0, 100);
    volIn.value = vol;
    function applyVolume() {
        const v = (vol / 100) ** 2;
        if (gain) { audio.volume = 1; gain.gain.value = v; }
        else audio.volume = v;
    }
    applyVolume();
    volIn.addEventListener('input', () => {
        vol = +volIn.value;
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
        if (noDisc) {
            deck.classList.remove('is-err');
            void deck.offsetWidth;
            deck.classList.add('is-err');
            lcdMessage('No disc');
            return;
        }
        if (audio.paused) { wantPlay = true; play(); }
        else { wantPlay = false; audio.pause(); }
    }

    function lightUp(ms) {
        deck.classList.add('is-lit');
        clearTimeout(lightTimer);
        if (!playing) lightTimer = setTimeout(() => { if (!playing) deck.classList.remove('is-lit'); }, ms);
    }

    function setPlaying(p) {
        const changed = p !== playing;
        playing = p;
        deck.classList.toggle('is-playing', p);
        playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
        icoPlay.classList.toggle('on', p);
        icoPause.classList.toggle('on', !p && audio.currentTime > 0);
        if (p) { clearTimeout(lightTimer); deck.classList.add('is-lit'); }
        else lightUp(4000); // backlight times out a few seconds after pause
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'playing' : 'paused';
        wake();
        if (changed) announce(p ? `Playing ${current.title} by ${current.artist}` : 'Paused');
        renderDisplay();
    }

    function setNoDisc() {
        noDisc = true;
        wantPlay = false;
        setPlaying(false);
        seek.disabled = true;
        showIdleText();
        renderDisplay();
    }

    // stopped: total time. playing: elapsed or remaining. paused: elapsed, blinking.
    function renderDisplay(t = audio.currentTime) {
        if (noDisc) {
            setDigits(trackDigits, ' no');
            setDigits(timeDigits, 'dISC');
            colon.classList.add('off');
            timeCap.textContent = 'Time';
            deck.classList.remove('is-paused');
            return;
        }
        const dur = audio.duration;
        const known = Number.isFinite(dur) && dur > 0;
        const stopped = !playing && t === 0 && !scrubbing && !scratch;
        let v = t;
        let cap = 'Time';
        if (stopped) { v = known ? dur : 0; cap = 'Total'; }
        else if (showRemaining && known) { v = Math.max(0, dur - t); cap = 'Remain'; }
        const m = Math.min(99, Math.floor(v / 60));
        const s = Math.floor(v % 60);
        const lead = m >= 10 ? String(Math.floor(m / 10)) : (cap === 'Remain' ? '-' : ' ');
        setDigits(trackDigits, String(current?.no ?? 1).padStart(3, ' '));
        setDigits(timeDigits, stopped && !known ? ' -- ' : lead + (m % 10) + Math.floor(s / 10) + (s % 10));
        colon.classList.toggle('off', stopped && !known);
        if (timeCap.textContent !== cap) timeCap.textContent = cap;
        deck.classList.toggle('is-paused', !playing && t > 0 && !scrubbing && !scratch);
    }

    let seekLabel = '';
    let ppShown = 0;
    function renderSeek(t) {
        const dur = audio.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const p = clamp(t / dur, 0, 1);
        const v = String(Math.round(p * 1000));
        if (!scrubbing && seek.value !== v) seek.value = v;
        seekBox.style.setProperty('--p', `${(p * 100).toFixed(2)}%`);
        const pp = Math.round(p * 400) / 400;
        if (pp !== ppShown) { ppShown = pp; playBtn.style.setProperty('--pp', `${pp}turn`); }
        const label = `${fmtTime(t)} of ${fmtTime(dur)}`;
        if (label !== seekLabel) { seekLabel = label; seek.setAttribute('aria-valuetext', label); }
    }

    function buildTicks() {
        const dur = audio.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const major = dur <= 90 ? 15 : 60;
        const minor = dur <= 90 ? 5 : 10;
        ticks.textContent = '';
        for (let t = 0; t <= dur; t += minor) {
            const el = document.createElement('span');
            const isMajor = t % major === 0;
            el.className = isMajor ? 'tick major' : 'tick';
            el.style.left = `${(t / dur) * 100}%`;
            if (isMajor && (t === 0 || dur - t > dur * .12)) el.dataset.label = fmtTime(t);
            ticks.appendChild(el);
        }
    }

    // A disc's program area runs from 25 mm to 58 mm radius and fills by area, 74 minutes for the lot.
    // The visible edge of the pressed area sits where this track would end.
    function setDataEdge(seconds) {
        if (!(seconds > 0)) return;
        const r = Math.sqrt(25 ** 2 + (58 ** 2 - 25 ** 2) * Math.min(1, seconds / 60 / 74));
        disc.style.setProperty('--data-r', `${((r / 60) * 100).toFixed(2)}%`);
    }

    // ---- playlist: random from the first song on -----------------------------------

    const tracks = PLAYLIST.tracks.map((t, i) => ({ ...t, no: i + 1 }));
    const opener = tracks[Math.floor(Math.random() * tracks.length)];
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

    // ---- the disc: printed fresh for every track ------------------------------------
    // Each track gets the next of four designs, coloured from its own cover.

    const DESIGNS = ['silver', 'picture', 'center', 'flood'];
    const discBody = $('.disc-body');
    const pad3 = (n) => String(n).padStart(3, '0');
    const coverUrl = (t, size) => (t?.art ? t.art.replace('512x512bb', `${size}x${size}bb`) : '');
    const measure = document.createElement('canvas').getContext('2d');
    const FACES = { display: '"Jacquard 24"', mono: '"Martian Mono"', marker: '"Permanent Marker"' };
    let discTurn = 0;
    let discSwap = null;

    // shrink a line of print until it fits the space it has on the disc
    function fitText(el, text) {
        if (text != null) el.textContent = text;
        const size = +el.dataset.size;
        const max = +el.dataset.max;
        if (!size || !max) return;
        measure.font = `${el.dataset.weight || 400} 100px ${FACES[el.dataset.face] || FACES.mono}`;
        const str = el.textContent;
        const w = (measure.measureText(str).width / 100) * size + (+el.dataset.ls || 0) * Math.max(0, str.length - 1);
        el.style.fontSize = `${(w > max ? (size * max) / w : size).toFixed(2)}px`;
    }
    const refitDisc = () => $$('[data-max]', disc).forEach((el) => fitText(el));
    document.fonts?.ready.then(refitDisc);
    document.fonts?.addEventListener?.('loadingdone', refitDisc);

    const covers = new Map();
    function preloadCover(t) {
        const src = coverUrl(t, 600);
        if (!src) return Promise.resolve();
        if (!covers.has(src)) {
            const img = new Image();
            img.src = src;
            covers.set(src, img.decode().catch(() => {}));
        }
        return Promise.race([covers.get(src), new Promise((r) => setTimeout(r, 700))]);
    }

    function printDisc(t, turn) {
        disc.dataset.design = DESIGNS[turn % DESIGNS.length];
        disc.dataset.dye = String(turn % 4);
        disc.style.setProperty('--cv-bg', t.bg || '#14171b');
        disc.style.setProperty('--cv-fg', t.fg || '#f3f5f6');
        if (t.accent) disc.style.setProperty('--cv-accent', t.accent);
        else disc.style.removeProperty('--cv-accent');
        const art = coverUrl(t, 600);
        $$('.js-cover', disc).forEach((img) => { if (art) img.setAttribute('href', art); else img.removeAttribute('href'); });
        $$('.js-title', disc).forEach((el) => fitText(el, t.title));
        $$('.js-artist', disc).forEach((el) => fitText(el, t.artist.toUpperCase()));
        $$('.js-artist-lower', disc).forEach((el) => fitText(el, t.artist.toLowerCase()));
        $$('.js-meta', disc).forEach((el) => fitText(el, `STL-009 · TRACK ${pad3(t.no)}/${tracks.length}`));
        $$('.js-meta-marker', disc).forEach((el) => fitText(el, `#${pad3(t.no)}`));
        const core = `${t.title} · ${t.artist} · STL-009-${pad3(t.no)} · ℗ 2026 STOLE.CC · `.toUpperCase();
        let ring = core;
        while (ring.length < 110) ring += core;
        $$('.js-ring', disc).forEach((el) => { el.textContent = ring; });
        $$('.js-now-title').forEach((el) => { el.textContent = t.title; });
    }

    // a new track swaps the disc like a changer: the old one slides out, the next rolls in
    function changeDisc(t, animate) {
        if (!animate) { printDisc(t, discTurn); return; }
        const turn = ++discTurn;
        if (ejected || reduceMotion.matches || !discBody.animate) { printDisc(t, turn); return; }
        discSwap?.cancel();
        const out = discBody.animate(
            [{ transform: 'none', opacity: 1 }, { transform: 'translateX(-20%) rotate(-70deg)', opacity: 0 }],
            { duration: 240, easing: 'cubic-bezier(.5, 0, .8, .3)', fill: 'forwards' },
        );
        discSwap = out;
        Promise.all([out.finished.catch(() => {}), preloadCover(t)]).then(() => {
            if (turn !== discTurn) return; // skipped again in the meantime
            printDisc(t, turn);
            out.cancel();
            discSwap = discBody.animate(
                [{ transform: 'translateX(24%) rotate(110deg)', opacity: 0 }, { transform: 'none', opacity: 1 }],
                { duration: 520, easing: 'cubic-bezier(.16, .84, .24, 1)' },
            );
        });
    }

    function loadTrack(t, autoplay) {
        const newTrack = current !== t;
        const firstLoad = current === null;
        current = t;
        if (!queue.length) queue = shuffle(tracks.filter((x) => x !== t));
        wantPlay = autoplay;
        switching = true;
        seek.disabled = true;
        ticks.textContent = '';
        seekBox.style.setProperty('--p', '0%');
        ppShown = 0;
        playBtn.style.setProperty('--pp', '0turn');
        if (overHttp) audio.crossOrigin = 'anonymous'; // Apple's preview CDN allows it, so the analyser can listen
        audio.src = t.file || t.preview;
        setDataEdge((t.ms || 0) / 1000);
        if (newTrack) changeDisc(t, !firstLoad);
        renderTrackInfo();
        renderDisplay(0);
        if (autoplay) play();
        preloadCover(queue[0]);
    }

    function nextTrack(autoplay = wantPlay) {
        if (current) history.push(current);
        if (!queue.length) queue = shuffle(tracks.filter((t) => t !== current));
        loadTrack(queue.shift(), autoplay);
    }

    function prevTrack() {
        if (audio.currentTime > 3 || !history.length) {
            audio.currentTime = 0;
            renderSeek(0);
            renderDisplay();
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
        if (++errorStreak > 4) { setNoDisc(); return; }
        lcdMessage(t.file ? `${t.file} missing · skipped` : `${t.title} unavailable · skipped`, 2600);
        nextTrack(wantPlay);
    }

    // back of the insert: the whole playlist, CD-back style
    const plList = $('#plList');
    const plRows = tracks.map((t) => {
        const li = document.createElement('li');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'pl-row';
        const art = document.createElement('img');
        art.className = 'pl-art';
        art.alt = '';
        art.width = art.height = 28;
        art.decoding = 'async';
        art.loading = 'lazy';
        art.dataset.src = coverUrl(t, 60);
        row.appendChild(art);
        const cell = (cls, text) => {
            const s = document.createElement('span');
            s.className = cls;
            s.textContent = text;
            row.appendChild(s);
        };
        cell('pl-no', String(t.no).padStart(3, '0'));
        cell('pl-title', t.title);
        cell('pl-artist', t.artist);
        cell('pl-dur', t.ms ? fmtTime(t.ms / 1000) : '');
        row.setAttribute('aria-label', `${t.no}. ${t.title} by ${t.artist}`);
        row.addEventListener('click', () => {
            playTrack(t);
            // picking a song puts the disc back in: the case closes and it rolls into the player
            if (ejected) setTimeout(() => { setEjected(false); playBtn.focus({ preventScroll: true }); }, 280);
        });
        li.appendChild(row);
        plList.appendChild(li);
        return row;
    });
    $('#plName').textContent = PLAYLIST.name;
    $('#plMeta').textContent = `${tracks.length} tracks · ${fmtLong(tracks.reduce((s, t) => s + (t.ms || 0), 0) / 1000)}`;

    let thumbsLoaded = false;
    function loadThumbs() {
        if (thumbsLoaded) return;
        thumbsLoaded = true;
        $$('.pl-art', plList).forEach((img) => { if (img.dataset.src) img.src = img.dataset.src; });
    }

    function revealCurrentRow() {
        const row = current && plRows[current.no - 1];
        if (!row) return;
        const li = row.parentElement;
        plList.scrollTop = li.offsetTop - plList.clientHeight / 2 + li.offsetHeight / 2;
    }

    // the cover window in the display: each new cover fades in over the last one
    const lcdArt = $('#lcdArt');
    let artWanted = '';
    function showCover(t) {
        const src = coverUrl(t, 160);
        if (src === artWanted) return;
        artWanted = src;
        const old = [...lcdArt.children];
        const retire = () => old.forEach((el) => {
            if (reduceMotion.matches || !el.animate) { el.remove(); return; }
            el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 700, easing: 'ease', fill: 'forwards' })
                .finished.then(() => el.remove(), () => el.remove());
        });
        if (!src) { retire(); return; }
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.src = src;
        (img.decode ? img.decode() : Promise.resolve()).then(() => {
            if (src !== artWanted) return; // skipped on before it arrived
            lcdArt.appendChild(img);
            retire();
            if (!reduceMotion.matches && img.animate) {
                img.animate([{ opacity: 0, transform: 'scale(1.15)' }, { opacity: 1, transform: 'none' }],
                    { duration: 700, easing: 'cubic-bezier(.16, .84, .24, 1)' });
            }
        }, () => {});
    }

    const npArt = $('#npArt');
    const npTitle = $('#npTitle');
    const npArtist = $('#npArtist');
    const npNext = $('#npNext');
    let lastRow = null;
    function renderTrackInfo() {
        const t = current;
        if (!msgTimer) showIdleText();
        indShuffle.classList.toggle('on', tracks.length > 1);
        indPreview.classList.toggle('on', !t.file);
        if (lastRow) { lastRow.classList.remove('is-current'); lastRow.removeAttribute('aria-current'); }
        lastRow = plRows[t.no - 1];
        lastRow.classList.add('is-current');
        lastRow.setAttribute('aria-current', 'true');
        if (wantPlay) announce(`Now playing ${t.title} by ${t.artist}`);
        showCover(t);
        npArt.hidden = !t.art;
        if (t.art) npArt.src = coverUrl(t, 160);
        npTitle.textContent = t.title;
        npArtist.textContent = t.artist;
        const next = queue[0];
        npNext.textContent = next ? `Up next: ${next.title} — ${next.artist}` : '';
        if ('mediaSession' in navigator && 'MediaMetadata' in window) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: t.title, artist: t.artist, album: PLAYLIST.name,
                artwork: t.art ? [{ src: t.art, sizes: '512x512', type: 'image/jpeg' }] : [],
            });
        }
    }

    audio.addEventListener('loadstart', () => { switching = false; });
    audio.addEventListener('loadedmetadata', () => {
        seek.disabled = false;
        buildTicks();
        renderDisplay();
        renderSeek(audio.currentTime);
    });
    audio.addEventListener('playing', () => { errorStreak = 0; });
    audio.addEventListener('play', () => { if (!scratch) { wantPlay = true; setPlaying(true); } });
    audio.addEventListener('pause', () => {
        if (scratch || switching || audio.ended) return;
        wantPlay = false;
        setPlaying(false);
    });
    audio.addEventListener('ended', () => nextTrack(true));
    audio.addEventListener('error', onAudioError);

    playBtn.addEventListener('click', toggle);
    $('#nextBtn').addEventListener('click', () => nextTrack());
    $('#prevBtn').addEventListener('click', prevTrack);

    $('#lcd').addEventListener('click', () => {
        if (noDisc) { toggle(); return; }
        showRemaining = !showRemaining;
        lcdMessage(showRemaining ? 'Remaining time' : 'Elapsed time', 1400);
        renderDisplay();
    });

    seek.addEventListener('input', () => {
        const dur = audio.duration;
        if (!Number.isFinite(dur)) return;
        scrubbing = true;
        const t = (seek.value / 1000) * dur;
        renderDisplay(t);
        renderSeek(t);
    });
    seek.addEventListener('change', () => {
        const dur = audio.duration;
        if (Number.isFinite(dur)) audio.currentTime = (seek.value / 1000) * dur;
        scrubbing = false;
        renderDisplay();
    });

    if ('mediaSession' in navigator) {
        const ms = navigator.mediaSession;
        ms.setActionHandler('play', () => { if (audio.paused) toggle(); });
        ms.setActionHandler('pause', () => { if (!audio.paused) toggle(); });
        try {
            ms.setActionHandler('nexttrack', () => nextTrack());
            ms.setActionHandler('previoustrack', prevTrack);
        } catch { /* older browsers */ }
    }

    // ---- eject: the disc rolls out and the insert turns over ---------------------

    const faceFront = $('#faceFront');
    const faceBack = $('#faceBack');
    const ejectBtn = $('#ejectBtn');
    let ejected = false;

    function setEjected(open) {
        if (open === ejected) return;
        ejected = open;
        insert.classList.toggle('is-ejected', open);
        faceFront.inert = open;
        faceBack.inert = !open;
        faceFront.setAttribute('aria-hidden', String(open));
        faceBack.setAttribute('aria-hidden', String(!open));
        ejectBtn.setAttribute('aria-pressed', String(open));
        ejectBtn.querySelector('span').textContent = open ? 'Close' : 'Eject';
        indOpen.classList.toggle('on', open);
        if (open) { loadThumbs(); revealCurrentRow(); }
        lcdMessage(open ? `Open · ${tracks.length} tracks` : 'Close', 1600);
        announce(open ? 'Case open. The tracklist is showing.' : 'Case closed.');
    }

    ejectBtn.addEventListener('click', () => setEjected(!ejected));
    $('#closeBtn').addEventListener('click', () => { setEjected(false); ejectBtn.focus({ preventScroll: true }); });

    // ---- analysis -------------------------------------------------------------
    // Everything that reacts to the music reads from these: 24 spectrum bands,
    // left/right levels, and lows / mids / highs / kick for the rest of the page.

    const raw = new Float32Array(BANDS);
    const band = new Float32Array(BANDS);
    const bandPk = new Float32Array(BANDS);
    const bandHold = new Float32Array(BANDS);
    const lvRaw = [0, 0];
    const lv = [0, 0];
    const lvPk = [0, 0];
    const lvHold = [0, 0];
    let bass = 0, mid = 0, high = 0, kick = 0, bassSlow = 0;

    function rms(an, buf) {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return Math.sqrt(sum / buf.length);
    }
    const dbLevel = (r) => (r > 0 ? clamp((20 * Math.log10(r) + 42) / 42, 0, 1) : 0);
    const avg = (arr, a, b) => { let s = 0; for (let i = a; i < b; i++) s += arr[i]; return s / (b - a); };

    // No analyser when the page is opened straight from disk, so fake a beat that moves like music.
    function simulate(t) {
        const beat = 60 / 132;
        const ph = (t / beat) % 1;
        const kickEnv = Math.exp(-ph * 7);
        const snare = Math.floor(t / beat) % 2 ? Math.exp(-ph * 9) : 0;
        const hat = Math.exp(-((ph + .5) % 1) * 16);
        for (let i = 0; i < BANDS; i++) {
            const x = i / (BANDS - 1);
            const n = Math.random();
            let v;
            if (x < .28) v = .4 + .6 * kickEnv * (1 - x * 1.6) + .06 * n;
            else if (x < .7) v = .48 + .2 * Math.sin(t * 2.3 + i * .8) + .22 * snare + .1 * n;
            else v = .22 + .45 * hat + .18 * snare + .12 * n;
            raw[i] = clamp(v - x * .15, 0, 1);
        }
        const body = .62 + .22 * kickEnv + .08 * snare;
        lvRaw[0] = clamp(body + (Math.random() - .5) * .06, 0, 1);
        lvRaw[1] = clamp(body + (Math.random() - .5) * .06, 0, 1);
    }

    function analyse(dt) {
        const audible = !audio.paused;
        if (audible && anMain) {
            anMain.getByteFrequencyData(freqBuf);
            for (let i = 0; i < BANDS; i++) {
                const [lo, hi] = bandBins[i];
                let m = 0;
                for (let b = lo; b < hi; b++) if (freqBuf[b] > m) m = freqBuf[b];
                // small tilt per band, since music has far less energy up top
                raw[i] = clamp((m / 255 + i * .009 - .14) / .8, 0, 1);
            }
            const l = rms(anL, bufL);
            const r = rms(anR, bufR);
            lvRaw[0] = dbLevel(l);
            lvRaw[1] = dbLevel(r > 0 ? r : l); // mono files only feed the left channel
        } else if (audible) {
            simulate(audio.currentTime);
        } else {
            raw.fill(0);
            lvRaw[0] = lvRaw[1] = 0;
        }

        // instant attack, gravity on the way down, peaks hang for a moment
        for (let i = 0; i < BANDS; i++) {
            band[i] = raw[i] > band[i] ? raw[i] : Math.max(raw[i], band[i] - dt * 1.8);
            if (band[i] >= bandPk[i]) { bandPk[i] = band[i]; bandHold[i] = .55; }
            else if ((bandHold[i] -= dt) <= 0) bandPk[i] = Math.max(0, bandPk[i] - dt * .9);
        }
        for (let c = 0; c < 2; c++) {
            lv[c] = lvRaw[c] > lv[c] ? lvRaw[c] : Math.max(lvRaw[c], lv[c] - dt * 1.6);
            if (lv[c] >= lvPk[c]) { lvPk[c] = lv[c]; lvHold[c] = .7; }
            else if ((lvHold[c] -= dt) <= 0) lvPk[c] = Math.max(0, lvPk[c] - dt * .8);
        }

        bass = avg(band, 0, 6);    // 40–150 Hz
        mid = avg(band, 10, 16);   // ~500 Hz–2 kHz
        high = avg(band, 17, 23);  // ~3–12 kHz
        bassSlow += (bass - bassSlow) * (1 - Math.exp(-dt / .45));
        kick = Math.max(clamp((bass - bassSlow) * 4, 0, 1), kick - dt * 5);
    }

    // ---- rendering what the analysis found -----------------------------------

    function renderSpectrum() {
        for (let i = 0; i < BANDS; i++) {
            const col = specCols[i];
            const n = Math.round(band[i] * SPEC_SEGS);
            const pk = bandPk[i] > .03 ? Math.min(SPEC_SEGS - 1, Math.ceil(bandPk[i] * SPEC_SEGS) - 1) : -1;
            if (n !== col.n) { col.n = n; col.el.style.setProperty('--n', n); }
            if (pk !== col.pk) { col.pk = pk; col.el.style.setProperty('--pk', Math.max(0, pk)); }
            col.el.classList.toggle('has-pk', pk >= 0 && pk >= n);
        }
    }

    function renderLcdMeters() {
        for (let c = 0; c < 2; c++) {
            const row = meterRows[c];
            const lit = Math.round(lv[c] * CELLS);
            const pk = lvPk[c] > .03 ? Math.min(CELLS - 1, Math.ceil(lvPk[c] * CELLS) - 1) : -1;
            if (lit === row.lit && pk === row.peak) continue;
            row.lit = lit;
            row.peak = pk;
            row.cells.forEach((el, i) => el.classList.toggle('on', i < lit || i === pk));
        }
    }

    // the spines use the top part of the range, so typical loudness sits mid-height and moves
    const spineShape = (x) => clamp((x - .3) / .7, 0, 1);
    function renderSpines() {
        if (!vuSegs || reduceMotion.matches) return;
        for (let c = 0; c < 2; c++) {
            const v = vus[c];
            const lit = Math.round(spineShape(lv[c]) * vuSegs);
            const pk = lvPk[c] > .32 ? Math.min(vuSegs - 1, Math.ceil(spineShape(lvPk[c]) * vuSegs) - 1) : -1;
            if (lit !== v.lit) { v.lit = lit; v.el.style.setProperty('--lit', `${lit * VU_PITCH}px`); }
            if (pk !== v.pk) { v.pk = pk; v.el.style.setProperty('--pk', `${Math.max(0, pk) * VU_PITCH}px`); }
            v.el.classList.toggle('has-pk', pk > 0 && pk >= lit);
        }
    }

    // lows / mids / highs / kick go straight onto the few elements that use them (registration
    // mark, logo, leader dots, disc light), so a beat never restyles the rest of the page
    const beatTargets = [
        { els: [$('.reg'), $('.logo-word'), playBtn], prop: '--kick', get: () => kick },
        { els: [$('.track[data-key="1"] .leader')], prop: '--lv', get: () => bass },
        { els: [$('.track[data-key="2"] .leader')], prop: '--lv', get: () => mid },
        { els: [$('.track[data-key="3"] .leader')], prop: '--lv', get: () => high },
    ].map((b) => ({ ...b, els: b.els.filter(Boolean), shown: -1 }));
    const discWrap = $('.disc-wrap');
    let pulseShown = -1;
    let wrapShown = -1;
    const moved = (v, shown, step) => v !== shown && (v === 0 || Math.abs(v - shown) >= step);

    function renderBeat() {
        const still = reduceMotion.matches;
        for (const b of beatTargets) {
            const v = still ? 0 : b.get();
            if (!moved(v, b.shown, .008)) continue;
            b.shown = v;
            for (const el of b.els) el.style.setProperty(b.prop, v.toFixed(3));
        }
        const p = still ? 0 : bass * .55;
        if (moved(p, pulseShown, .008)) { pulseShown = p; dPulse.style.opacity = p.toFixed(3); }
        const s = still ? 1 : 1 + kick * .015;
        if (moved(s, wrapShown, .0003)) { wrapShown = s; discWrap.style.scale = s.toFixed(4); }
    }

    // the barcode bars rise and fall with the spectrum, and stand back up when the music stops
    let bars = [];
    let barsPath = null;
    function danceBarcode(dt) {
        const k = 1 - Math.exp(-dt / .07);
        const live = !audio.paused && !reduceMotion.matches;
        let changed = false;
        for (const bar of bars) {
            const v = live ? band[Math.min(BANDS - 1, Math.floor((bar.pos / 95) * BANDS))] : 1;
            const target = bar.base * (.3 + .7 * v);
            const d = target - bar.h;
            if (Math.abs(d) < .05) {
                if (bar.h === target) continue;
                bar.h = target;
            } else {
                bar.h += d * k;
            }
            changed = true;
        }
        if (changed) barsPath.setAttribute('d', bars.map((b) => `M${b.x} ${(b.base - b.h).toFixed(2)}h1v${b.h.toFixed(2)}h-1z`).join(''));
        return changed;
    }

    // ---- disc: spin, scratch and light --------------------------------------------

    const SPIN = 150; // deg/s at normal speed, so turning the disc this fast by hand plays at 1x
    let angle = 0;
    let vel = 0;
    let sheen = 34;
    let sheenTarget = 34;
    let sheenShown = NaN;
    let last = performance.now();
    const dMetal = $('.d-metal');
    const dSheen = $('.d-sheen');
    const dPulse = $('.d-pulse');

    // reading the disc's position forces layout, so it's remembered for a moment
    let discRect = null;
    let discRectAt = 0;
    function discBox() {
        const now = performance.now();
        if (!discRect || now - discRectAt > 250) { discRect = disc.getBoundingClientRect(); discRectAt = now; }
        return discRect;
    }
    addEventListener('resize', () => { discRect = null; }, { passive: true });

    function pointerOnDisc(e) {
        const r = discBox();
        const x = e.clientX - (r.left + r.width / 2);
        const y = e.clientY - (r.top + r.height / 2);
        return { a: Math.atan2(y, x) * 180 / Math.PI, r: Math.hypot(x, y) / (r.width / 2) };
    }

    disc.addEventListener('pointerdown', (e) => {
        if (ejected || (e.pointerType === 'mouse' && e.button !== 0)) return;
        const p = pointerOnDisc(e);
        if (p.r > 1 || p.r < .13) return; // outside the disc, or in the hole
        e.preventDefault();
        wake();
        disc.setPointerCapture(e.pointerId);
        ensureAudioGraph();
        if (actx && actx.state === 'suspended') actx.resume();
        scratch = {
            a: p.a, t: performance.now(), vel, moved: 0,
            wasPlaying: !audio.paused, time: audio.currentTime || 0,
        };
        deck.classList.add('is-scratching');
    });

    disc.addEventListener('pointermove', (e) => {
        if (!scratch) return;
        const p = pointerOnDisc(e);
        const now = performance.now();
        const dt = Math.max(.004, (now - scratch.t) / 1000);
        const d = ((p.a - scratch.a + 540) % 360) - 180;
        scratch.a = p.a;
        scratch.t = now;
        if (p.r < .1) return; // too close to the centre to tell which way it turned
        scratch.moved += Math.abs(d);
        angle = (angle + d + 360) % 360;
        scratch.vel += (d / dt - scratch.vel) * .4;
        const dur = audio.duration;
        if (Number.isFinite(dur) && !noDisc) scratch.time = clamp(scratch.time + d / SPIN, 0, Math.max(0, dur - .05));
    });

    function endScratch() {
        if (!scratch) return;
        const s = scratch;
        scratch = null;
        deck.classList.remove('is-scratching');
        audio.playbackRate = 1;
        const tap = s.moved < 3;
        const dur = audio.duration;
        if (!tap && Number.isFinite(dur) && !noDisc) audio.currentTime = s.time;
        if (noDisc) { if (tap) toggle(); return; }
        // a tap toggles play; a scratch goes back to whatever the deck was doing
        const resume = tap ? !s.wasPlaying : s.wasPlaying;
        wantPlay = resume;
        if (resume) play(); else audio.pause();
        setPlaying(resume);
        if (!tap) vel = s.vel; // a flick keeps the disc turning, then the motor takes over
    }
    disc.addEventListener('pointerup', endScratch);
    disc.addEventListener('pointercancel', endScratch);

    // forward at speed plays (pitched with the hand), held still or backwards stays silent and seeks
    function scratchAudio() {
        if (noDisc || !Number.isFinite(audio.duration)) return;
        const speed = scratch.vel / SPIN;
        if (speed > .2) {
            audio.playbackRate = clamp(speed, .25, 4);
            if (Math.abs(audio.currentTime - scratch.time) > .25) audio.currentTime = scratch.time;
            if (audio.paused) audio.play().catch(() => {});
        } else {
            if (!audio.paused) audio.pause();
            if (Math.abs(audio.currentTime - scratch.time) > .1) audio.currentTime = scratch.time;
        }
    }

    addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        const r = discBox();
        const deg = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
        sheenTarget = deg + 90; // conic 0deg points up, atan2 0deg points right
        wake();
    }, { passive: true });

    // touch screens have no pointer to follow, so the light moves with scrolling instead
    addEventListener('scroll', () => {
        discRect = null;
        if (!finePointer.matches) { sheenTarget = 34 + scrollY * .3; wake(); }
    }, { passive: true });

    // ---- Discord box (Lanyard) -------------------------------------------------------
    // Lanyard shares the live presence of accounts that joined its Discord server. On the live
    // site the box stays hidden until there's data; while testing locally it says what's missing.

    const dbox = $('#dbox');
    const dStatus = $('#dStatus');
    const dName = $('#dName');
    const dSub = $('#dSub');
    const dActs = $('#dActs');
    const dNote = $('#dNote');
    const dAvatar = $('#dAvatar');
    const testing = !overHttp || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
    const STATUS = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline' };
    const VERB = { 0: 'Playing', 1: 'Streaming', 2: 'Listening to', 3: 'Watching', 5: 'Competing in' };
    let dSig = '';
    let avatarKey = '';
    let avatarLum = null;

    function discordUnavailable(why) {
        dSig = '';
        if (!testing) { dbox.hidden = true; return; }
        dbox.hidden = false;
        dbox.dataset.state = 'setup';
        dStatus.textContent = 'Not connected';
        dStatus.dataset.status = 'none';
        dActs.textContent = '';
        dNote.hidden = false;
        dNote.textContent = `${why} This note only shows while you test locally; on the live site the box stays hidden until there's a status to show.`;
    }

    function assetUrl(a) {
        const img = a.assets?.large_image;
        if (!img) return '';
        if (img.startsWith('mp:')) return `https://media.discordapp.net/${img.slice(3)}`;
        if (img.startsWith('spotify:')) return `https://i.scdn.co/image/${img.slice(8)}`;
        return a.application_id ? `https://cdn.discordapp.com/app-assets/${a.application_id}/${img}.png` : '';
    }

    function addActivity({ label, title, detail, img, start, end, quiet }) {
        const row = document.createElement('div');
        row.className = `dact${img ? '' : ' no-img'}${quiet ? ' is-quiet' : ''}`;
        if (img) {
            const im = document.createElement('img');
            im.className = 'dact-img';
            im.alt = '';
            im.src = img;
            im.addEventListener('error', () => { im.remove(); row.classList.add('no-img'); });
            row.appendChild(im);
        }
        const text = document.createElement('div');
        text.className = 'dact-text';
        const line = (cls, s) => {
            if (!s) return null;
            const el = document.createElement('span');
            el.className = cls;
            el.textContent = s;
            return text.appendChild(el);
        };
        line('dact-label', label);
        line('dact-title', title);
        line('dact-detail', detail);
        if (start) {
            const el = line('dact-time', ' ');
            el.dataset.start = start;
            if (end) el.dataset.end = end;
        }
        row.appendChild(text);
        dActs.appendChild(row);
    }

    function tickActivityTimes() {
        const now = Date.now();
        const fmt = (s) => (s >= 3600 ? fmtLong(s) : fmtTime(s));
        $$('.dact-time', dActs).forEach((el) => {
            const start = +el.dataset.start;
            const end = +el.dataset.end;
            const t = Math.max(0, (now - start) / 1000);
            el.textContent = end ? `${fmt(Math.min(t, (end - start) / 1000))} / ${fmt((end - start) / 1000)}` : `${fmt(t)} elapsed`;
        });
    }
    setInterval(tickActivityTimes, 1000);

    function renderDiscord(d) {
        dbox.hidden = false;
        dbox.dataset.state = 'live';
        dNote.hidden = true;
        const u = d.discord_user || {};
        const sig = JSON.stringify([d.discord_status, u.avatar, u.global_name, u.username, d.activities, d.spotify?.track_id,
            d.active_on_discord_desktop, d.active_on_discord_mobile, d.active_on_discord_web]);
        if (sig === dSig) return;
        dSig = sig;

        const status = STATUS[d.discord_status] ? d.discord_status : 'offline';
        dStatus.textContent = STATUS[status];
        dStatus.dataset.status = status;
        dName.textContent = u.global_name || u.display_name || u.username || 'stole';
        const where = d.active_on_discord_desktop ? 'desktop' : d.active_on_discord_mobile ? 'phone' : d.active_on_discord_web ? 'browser' : '';
        dSub.textContent = [u.username && `@${u.username}`, status !== 'offline' && where && `on ${where}`].filter(Boolean).join(' · ');
        loadAvatar(u);

        dActs.textContent = '';
        const acts = d.activities || [];
        const custom = acts.find((a) => a.type === 4);
        if (custom?.state) addActivity({ label: 'Status', title: `${custom.emoji && !custom.emoji.id ? `${custom.emoji.name} ` : ''}${custom.state}` });
        if (d.listening_to_spotify && d.spotify) {
            const s = d.spotify;
            addActivity({ label: 'Listening on Spotify', title: s.song, detail: s.artist?.replace(/;/g, ','), img: s.album_art_url, start: s.timestamps?.start, end: s.timestamps?.end });
        }
        acts.filter((a) => a.type !== 4 && !(a.type === 2 && a.name === 'Spotify')).forEach((a) => {
            addActivity({ label: VERB[a.type] || 'Playing', title: a.name, detail: [a.details, a.state].filter(Boolean).join(' · '), img: assetUrl(a), start: a.timestamps?.start });
        });
        if (!dActs.children.length) addActivity({ title: status === 'offline' ? 'Offline right now' : 'Nothing going on right now', quiet: true });
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

    // avatar: ordered 1-bit dither, so it sits with the pixel icons and takes the edition's ink
    async function loadAvatar(u) {
        const key = `${u.id}/${u.avatar || ''}`;
        if (key === avatarKey) return;
        avatarKey = key;
        const fallback = u.id ? Number((BigInt(u.id) >> 22n) % 6n) : 0;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${fallback}.png`;
        try { await img.decode(); } catch { return; }
        const N = dAvatar.width;
        const c = document.createElement('canvas');
        c.width = c.height = N;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, N, N);
        let px;
        try { px = g.getImageData(0, 0, N, N).data; } catch { return; }
        avatarLum = new Float32Array(N * N).fill(-1); // -1 = outside the round avatar
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const i = (y * N + x) * 4;
                if (Math.hypot(x - N / 2 + .5, y - N / 2 + .5) > N / 2 || px[i + 3] < 128) continue;
                const lum = (.299 * px[i] + .587 * px[i + 1] + .114 * px[i + 2]) / 255;
                avatarLum[y * N + x] = clamp((lum - .5) * 1.35 + .5, 0, 1);
            }
        }
        paintAvatar();
    }

    // dark editions print the light parts, so the face never turns into a negative
    function paintAvatar() {
        if (!avatarLum) return;
        const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
        const N = dAvatar.width;
        const g = dAvatar.getContext('2d');
        const darkPaper = currentEdition() === 'black';
        g.clearRect(0, 0, N, N);
        g.fillStyle = getComputedStyle(root).getPropertyValue('--ink').trim() || '#101317';
        for (let i = 0; i < avatarLum.length; i++) {
            const lum = avatarLum[i];
            if (lum < 0) continue;
            const x = i % N;
            const y = Math.floor(i / N);
            const threshold = (BAYER[(y % 4) * 4 + (x % 4)] + .5) / 16;
            if (darkPaper ? lum > threshold : lum < threshold) g.fillRect(x, y, 1, 1);
        }
    }

    // the wire runs from just under the Discord icon to the box's title bar
    const dIcon = $('.track-discord .px');
    function placeWire() {
        if (dbox.hidden || ejected || !dIcon) return;
        const ic = dIcon.getBoundingClientRect();
        const bx = dbox.getBoundingClientRect();
        dbox.style.setProperty('--wire-top', `${Math.min(-6, ic.bottom + 4 - bx.top).toFixed(1)}px`);
        dbox.style.setProperty('--wire-x', `${Math.max(8, bx.left - (ic.left + ic.width / 2)).toFixed(1)}px`);
    }
    if ('ResizeObserver' in window) new ResizeObserver(placeWire).observe(dbox.closest('.track'));

    pollDiscord();
    setInterval(pollDiscord, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollDiscord(); });

    // ---- recently played (Last.fm) ------------------------------------------------------
    // Apple Music keeps listening history to itself, so plays get scrobbled to Last.fm (a
    // scrobbler app does that) and are read back from there. Covers and Apple Music links come
    // from the playlist when the song is in it, otherwise from Apple's search, then Last.fm.

    const recent = $('#recent');
    const recentList = $('#recentList');
    const recentSrc = $('#recentSrc');
    const recentNote = $('#recentNote');
    const RECENT_ROWS = 6;
    const LASTFM_BLANK = '2a96cbd8b46e442fc41c2b86b821562f'; // Last.fm's grey star placeholder
    const playedFmt = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timeZone, dateStyle: 'medium', timeStyle: 'short' });
    const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/\s*[([].*?[)\]]/g, '').replace(/\s+(feat|ft)\.?\s.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const leadArtist = (s) => norm((s || '').split(/,|&|\s+x\s+|\s+(?:feat|ft)\.?\s/i)[0]);
    const songKey = (title, artist) => `${leadArtist(artist)}|${norm(title)}`;
    const inPlaylist = new Map(tracks.map((t) => [songKey(t.title, t.artist), t]));
    const lookups = new Map();
    let recentSig = '';
    let recentLive = false;

    function ago(ms) {
        const s = Math.max(0, (Date.now() - ms) / 1000);
        if (s < 90) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400) { const h = Math.floor(s / 3600); return `${h} ${h === 1 ? 'hour' : 'hours'} ago`; }
        const d = Math.floor(s / 86400);
        return d === 1 ? 'yesterday' : `${d} days ago`;
    }

    // Apple's search is picky, so it tries "artist title" first, then the title alone
    function lookUp(item) {
        const key = songKey(item.title, item.artist);
        if (lookups.has(key)) return lookups.get(key);
        const job = (async () => {
            const t = inPlaylist.get(key);
            if (t) return { art: coverUrl(t, 120), url: `https://music.apple.com/de/song/${t.id}` };
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

    function recentRow(item, n) {
        const li = document.createElement('li');
        li.className = item.now ? 'rp is-now' : 'rp';
        const no = document.createElement('span');
        no.className = 'no';
        if (item.now) no.innerHTML = '<span class="rp-eq" aria-hidden="true"><i></i><i></i><i></i></span><span class="sr-only">Playing now:</span>';
        else no.textContent = String(n + 1).padStart(2, '0');
        const cover = document.createElement('span');
        cover.className = 'rp-art';
        const a = document.createElement('a');
        a.className = 'rp-main';
        a.target = '_blank';
        a.rel = 'noopener';
        a.href = `https://music.apple.com/de/search?term=${encodeURIComponent(`${item.artist} ${item.title}`)}`;
        const line = (cls, text) => {
            const s = document.createElement('span');
            s.className = cls;
            s.textContent = text;
            a.appendChild(s);
        };
        line('rp-title', item.title);
        line('rp-artist', item.artist);
        const meta = document.createElement('span');
        meta.className = 'rp-meta';
        meta.innerHTML = '<span class="rp-src"><span class="px px-xs" aria-hidden="true"></span>Apple Music</span><time class="rp-time"></time>';
        drawPixelIcon($('.px', meta), PIXEL_ICONS.note);
        const time = $('time', meta);
        if (!item.now) {
            time.dataset.at = item.at;
            time.dateTime = new Date(item.at).toISOString();
            a.title = `Played ${playedFmt.format(item.at)}`;
        }
        li.append(no, cover, a, meta);
        lookUp(item).then((hit) => {
            const art = hit.art || item.img;
            if (art) {
                const img = document.createElement('img');
                img.alt = '';
                img.width = img.height = 34;
                img.decoding = 'async';
                img.src = art;
                img.addEventListener('error', () => img.remove());
                cover.appendChild(img);
            }
            if (hit.url) a.href = hit.url;
        });
        return li;
    }

    function tickRecent() {
        $$('.rp-time', recentList).forEach((el) => {
            el.textContent = el.dataset.at ? ago(+el.dataset.at) : 'Playing now';
        });
    }
    setInterval(tickRecent, 30000);

    function renderRecent(items, sample) {
        recentLive = !sample;
        recent.hidden = false;
        recent.dataset.state = sample ? 'sample' : 'live';
        recentSrc.textContent = sample ? 'Sample rows' : 'via Last.fm';
        if (!sample) recentNote.hidden = true;
        const sig = JSON.stringify(items.map((i) => [i.title, i.artist, i.at, i.now]));
        if (sig !== recentSig) {
            recentSig = sig;
            recentList.textContent = '';
            items.forEach((item, n) => recentList.appendChild(recentRow(item, n)));
        }
        tickRecent();
    }

    function recentUnavailable(why) {
        if (recentLive) return; // a hiccup: keep the last list up
        if (!testing) { recent.hidden = true; return; }
        // while testing locally, sample rows from the playlist show what it will look like
        if (recent.dataset.state !== 'sample') {
            const minutes = [0, 4, 41, 150, 420, 1700];
            renderRecent(shuffle(tracks.slice()).slice(0, RECENT_ROWS).map((t, i) => (
                { title: t.title, artist: t.artist, at: Date.now() - minutes[i] * 60000, now: i === 0, img: '' })), true);
        }
        recentNote.hidden = false;
        recentNote.textContent = `${why} The rows above are samples from the playlist. Samples and this note only show while testing locally; on the live site this section stays hidden until Last.fm has plays to show.`;
    }

    async function pollRecent() {
        if (document.hidden) return;
        if (!CONFIG.lastfmUser || !CONFIG.lastfmKey) {
            recentUnavailable('Last.fm isn’t connected yet: put your Last.fm username and API key into CONFIG at the top of app.js.');
            return;
        }
        try {
            const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&format=json&limit=${RECENT_ROWS}`
                + `&user=${encodeURIComponent(CONFIG.lastfmUser)}&api_key=${encodeURIComponent(CONFIG.lastfmKey)}`;
            const body = await (await fetch(url, { cache: 'no-store' })).json();
            const list = [].concat(body.recenttracks?.track || []);
            if (!list.length) {
                recentUnavailable(body.message ? `Last.fm says: ${body.message}.` : 'Last.fm has no plays for this account yet.');
                return;
            }
            renderRecent(list.slice(0, RECENT_ROWS).map((t) => ({
                title: t.name || '',
                artist: t.artist?.['#text'] || t.artist?.name || '',
                at: t.date?.uts ? t.date.uts * 1000 : Date.now(),
                now: t['@attr']?.nowplaying === 'true',
                img: [].concat(t.image || []).reverse().find((i) => i['#text'] && !i['#text'].includes(LASTFM_BLANK))?.['#text'] || '',
            })));
        } catch {
            recentUnavailable('Last.fm couldn’t be reached.');
        }
    }

    // ---- main loop --------------------------------------------------------------------
    // Runs while something moves: music, a hand on the disc, the disc coasting, the light
    // following the pointer, meters falling back. Then it sleeps until something wakes it.

    let rafId = 0;
    function wake() {
        if (rafId) return;
        last = performance.now();
        rafId = requestAnimationFrame(frame);
    }

    const atRest = (arr) => { for (let i = 0; i < arr.length; i++) if (arr[i] !== 0) return false; return true; };

    function frame(now) {
        const dt = clamp((now - last) / 1000, 0, .064);
        last = now;

        if (scratch) {
            // the hand drives the disc; if it holds still, the disc stops under it
            if (now - scratch.t > 50) scratch.vel *= Math.exp(-dt / .06);
            vel = scratch.vel;
            discRot.style.transform = `rotate(${angle.toFixed(2)}deg)`;
            scratchAudio();
            renderDisplay(scratch.time);
            renderSeek(scratch.time);
        } else {
            // spin up quicker than it spins down, like a motor with a heavy disc on it
            const target = playing && !reduceMotion.matches ? SPIN : 0;
            vel += (target - vel) * (1 - Math.exp(-dt / (playing ? .55 : 1.2)));
            if (!target && Math.abs(vel) < .5) vel = 0; // slower than this it no longer looks like it's turning
            if (vel !== 0) {
                angle = (angle + vel * dt + 360) % 360;
                discRot.style.transform = `rotate(${angle.toFixed(2)}deg)`;
            }
            if (!scrubbing && !noDisc && playing) {
                renderDisplay();
                renderSeek(audio.currentTime);
            }
        }

        const diff = ((((sheenTarget - sheen) % 360) + 540) % 360) - 180;
        sheen += diff * (1 - Math.exp(-dt / .2));
        // a spinning disc never sits perfectly flat, so the reflection flickers a little
        const wobble = Math.abs(vel) > 1 ? Math.sin(now / 90) * .8 * Math.min(1, Math.abs(vel) / SPIN) : 0;
        const shown = sheen + wobble;
        if (!(Math.abs(shown - sheenShown) < .05)) {
            sheenShown = shown;
            const turn = `rotate(${shown.toFixed(2)}deg)`;
            dSheen.style.transform = turn;
            dPulse.style.transform = turn;
            dMetal.style.transform = `rotate(${(shown / 2).toFixed(2)}deg)`;
        }

        analyse(dt);
        renderSpectrum();
        renderLcdMeters();
        renderSpines();
        renderBeat();
        const barsMoving = danceBarcode(dt);
        iconBeat(now);

        const still = !playing && !scratch && Math.abs(vel) < .05 && Math.abs(diff) < .05 && !barsMoving
            && kick === 0 && atRest(band) && atRest(bandPk) && atRest(lv) && atRest(lvPk);
        rafId = still ? 0 : requestAnimationFrame(frame);
    }

    // ---- pixel icons ----------------------------------------------------------
    // 16×16, two frames each. X ink, w fill, o spot ink, s spot ink that casts no shadow, . empty.
    // Filled pixels drop a dithered shadow one step down and right, like old desktop icons.

    const PIXEL_ICONS = {
        telegram: [`
            ................
            ..............XX
            ............XXX.
            .........XXXwXX.
            .......XXwwwXX..
            ....XXXwwwwXoX..
            ..XXwwwwwwXoX...
            XXwwwwwwwXoX....
            .XXwwwwwXooX....
            ...XXwwXooX.....
            .....XXooX......
            ......XooX......
            ......XoX.......
            .......XX.......
            ................
            ................`, `
            ..............XX
            ............XXX.
            .........XXXwXX.
            .......XXwwwXX..
            ....XXXwwwwXoX..
            ..XXwwwwwwXoX...
            XXwwwwwwwXoX....
            .XXwwwwwXooX....
            ...XXwwXooX.....
            .....XXooX......
            ..s...XooX......
            .s....XoX.......
            ....s..XX.......
            ...s............
            .s..............
            s...............`],
        email: [`
            ................
            ................
            ................
            ................
            XXXXXXXXXXXXXXXX
            XXwwwwwwwwwwwwXX
            XwXXwwwwwwwwXXwX
            XwwwXXwwwwXXwwwX
            XwwwwwXooXwwwwwX
            XwwwwwoooowwwwwX
            XwwwwwoooowwwwwX
            XwwwXXwoowXXwwwX
            XwXXwwwwwwwwXXwX
            XXwwwwwwwwwwwwXX
            XXXXXXXXXXXXXXXX
            ................`, `
            ................
            .......XX.......
            .....XXwwXX.....
            ...XXwwwwwwXX...
            .XXwwwwwwwwwwXX.
            XwwXXXXXXXXXXwwX
            XwwXwwwwwwwwXwwX
            XwwXwoooooowXwwX
            XXXXXXXXXXXXXXXX
            XwwwwwwwwwwwwwwX
            XwwwwwwXXwwwwwwX
            XwwwwXXwwXXwwwwX
            XwwXXwwwwwwXXwwX
            XXXwwwwwwwwwwXXX
            XXXXXXXXXXXXXXXX
            ................`],
        discord: [`
            ................
            ................
            ..XX........XX..
            .XwwXXXXXXXXwwX.
            .XwwwwwwwwwwwwX.
            XwwwwwwwwwwwwwwX
            XwwwwwwwwwwwwwwX
            XwwwoowwwwoowwwX
            XwwwoowwwwoowwwX
            XwwwoowwwwoowwwX
            XwwwwwwwwwwwwwwX
            XwwwwwwwwwwwwwwX
            XwwwwXXXXXXwwwwX
            .XwwX......XwwX.
            ..XX........XX..
            ................`, `
            ................
            ................
            ..XX........XX..
            .XwwXXXXXXXXwwX.
            .XwwwwwwwwwwwwX.
            XwwwwwwwwwwwwwwX
            XwwwwwwwwwwwwwwX
            XwwwwwwwwwwwwwwX
            XwwwwwwwwwwwwwwX
            XwwwoowwwwoowwwX
            XwwwwwwwwwwwwwwX
            XwwwwwwwwwwwwwwX
            XwwwwXXXXXXwwwwX
            .XwwX......XwwX.
            ..XX........XX..
            ................`],
        note: [`
            ................
            .....XXXXXXXXXX.
            .....XooooooooX.
            .....XXXXXXXXXX.
            .....XX......XX.
            .....XX......XX.
            .....XX......XX.
            .....XX......XX.
            .....XX......XX.
            ..XXXXX...XXXXX.
            .XwwwXX..XwwwXX.
            .XwwwwX..XwwwwX.
            ..XXXX....XXXX..
            ................
            ................
            ................`],
    };

    function drawPixelIcon(host, frames) {
        const PIXEL_CLASS = { X: 'ink', w: 'fill', o: 'spot', s: 'spot' };
        const casts = (c) => c === 'X' || c === 'w' || c === 'o';
        let out = '';
        frames.forEach((art, f) => {
            const rows = art.trim().split('\n').map((r) => r.trim());
            const at = (x, y) => rows[y]?.[x] ?? '.';
            const kind = (x, y) => PIXEL_CLASS[at(x, y)]
                || (casts(at(x - 1, y - 1)) && (x + y) % 2 === 0 ? 'shadow' : null);
            const paths = { shadow: '', fill: '', ink: '', spot: '' };
            for (let y = 0; y < 17; y++) {
                for (let x = 0; x < 17;) {
                    const k = kind(x, y);
                    if (!k) { x++; continue; }
                    let len = 1;
                    while (x + len < 17 && kind(x + len, y) === k) len++;
                    paths[k] += `M${x} ${y}h${len}v1h${-len}z`;
                    x += len;
                }
            }
            out += `<g class="px-f${f}">`;
            for (const k in paths) if (paths[k]) out += `<path class="px-${k}" d="${paths[k]}"/>`;
            out += '</g>';
        });
        host.innerHTML = `<svg viewBox="0 0 17 17">${out}</svg>`;
    }

    $$('.px[data-icon]').forEach((el) => drawPixelIcon(el, PIXEL_ICONS[el.dataset.icon]));

    // while the song plays, the contact icons step to their other frame on every kick
    const beatIcons = $$('.track .px');
    let iconAlt = false;
    let beatArmed = true;
    let lastBeat = 0;
    function iconBeat(now) {
        if (!playing || reduceMotion.matches) {
            if (iconAlt) { iconAlt = false; beatIcons.forEach((el) => el.classList.remove('px-alt')); }
            return;
        }
        if (beatArmed && kick > .55 && now - lastBeat > 180) {
            beatArmed = false;
            lastBeat = now;
            iconAlt = !iconAlt;
            beatIcons.forEach((el) => el.classList.toggle('px-alt', iconAlt));
        } else if (kick < .25) {
            beatArmed = true;
        }
    }

    // ---- press A: a Bernese mountain dog and a donkey fly past ----------------------
    // 28×16 sprites, two frames each (wings up, wings down). Colours are the animals' own;
    // a 1px outline in the edition's ink keeps the black dog visible on dark paper.

    const CRITTERS = {
        dog: [`
            ......gFF...................
            ......gFFFF.................
            .......gFFFFF.........KKKK..
            ......gFgFFFFF.......KKKKKK.
            .......gFgFFFFF.....KKKKRKW.
            WWK.....gFgFFFFF...KkKKKERWK
            .WKK...KKKggFFFFKKKKkkKRRWWW
            ...KKKKKKKKKgFFFKKKKkkKRWWW.
            .....KKKKKKKKKKKKKKKKkKWWP..
            .....KKKKKKKKKKKKKKKKKWWW...
            .....KKKKKKKKKKKKKKKWWWW....
            ......KKKKKKKKKKKKKWWW......
            ...RRRKK..........WRRR......
            .WWR..................RRWW..
            ............................
            ............................`, `
            ............................
            ............................
            ......................KKKK..
            .....................KKKKKK.
            ....................KKKKRKW.
            WWK................KkKKKERWK
            .WKK...KKKKKgFFFgKKKkkKRRWWW
            ...KKKKKKKgFFFFFgKKKkkKRWWW.
            .....KKKgFFFFFFgKKKKKkKWWP..
            .....KKgFFFFFgKKKKKKKKWWW...
            .....KgFgFgFgKKKKKKKWWWW....
            ......KKKKKKKKKKKKKWWW......
            ....RRKK..........WRR.......
            ...WWR.............RWW......
            ............................
            ............................`],
        donkey: [`
            .....................DD.DD..
            .......gFF...........DGDCD..
            .......gFFFF.........DGDCD..
            ........gFFFFF.......DGGGD..
            .......gFgFFFFF.....DGGGGGG.
            ........gFgFFFFF...DDGGGEGG.
            .........gFgFFFFF.DDGGGGGGLL
            ......DDDDDggFFFFDGGGGGGLLLL
            ....DGGGGGGGGgFFFGGGGGG.LLLD
            ..DD.GGGGGGGGGGGGGGGGG..LL..
            .DDD.GGGGGGGGGGGGGGGG.......
            ..D..GGGGGGGGGGGGGGGG.......
            .....GGGLLLLLLLLLLGGG.......
            ...GGG............GGG.......
            ..DG................GGD.....
            ............................`, `
            .....................DD.DD..
            .....................DGDCD..
            .....................DGDCD..
            .....................DGGGD..
            ....................DGGGGGG.
            ...................DDGGGEGG.
            ..................DDGGGGGGLL
            ......DDDDDDDgFFFgGGGGGGLLLL
            ....DGGGGGGgFFFFFgGGGGG.LLLD
            ..DD.GGGGgFFFFFFgGGGGG..LL..
            .DDD.GGGgFFFFFgGGGGGG.......
            ..D..GGgFgFgFgGGGGGGG.......
            .....GGGLLLLLLLLLLGGG.......
            ....GG............GG........
            ...DG..............GD.......
            ............................`],
    };
    const CRITTER_COLOURS = {
        K: '#1b1b1e', k: '#42424a', W: '#f4f1ea', R: '#b5572a', P: '#e86a7a', E: '#101012',
        F: '#ffffff', g: '#bec4cc', G: '#8b8780', L: '#d0cac0', D: '#4a4642', C: '#f0e8d6',
    };

    function drawCritter(frames) {
        let out = '';
        frames.forEach((art, f) => {
            const rows = art.trim().split('\n').map((r) => r.trim());
            const at = (x, y) => rows[y]?.[x] ?? '.';
            const filled = (x, y) => at(x, y) !== '.';
            const kind = (x, y) => (filled(x, y) ? at(x, y)
                : filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1) ? 'o' : null);
            const paths = {};
            for (let y = -1; y <= rows.length; y++) {
                for (let x = -1; x <= 28;) {
                    const k = kind(x, y);
                    if (!k) { x++; continue; }
                    let len = 1;
                    while (x + len <= 28 && kind(x + len, y) === k) len++;
                    paths[k] = (paths[k] || '') + `M${x + 1} ${y + 1}h${len}v1h${-len}z`;
                    x += len;
                }
            }
            out += `<g class="cr-f${f}">`;
            for (const k in paths) out += k === 'o' ? `<path class="cr-o" d="${paths[k]}"/>` : `<path fill="${CRITTER_COLOURS[k]}" d="${paths[k]}"/>`;
            out += '</g>';
        });
        return `<svg viewBox="0 0 30 18" shape-rendering="crispEdges">${out}</svg>`;
    }

    let flyLayer = null;
    function flyBy() {
        if (!flyLayer) {
            flyLayer = document.createElement('div');
            flyLayer.className = 'flyby';
            flyLayer.setAttribute('aria-hidden', 'true');
            document.body.appendChild(flyLayer);
        }
        if (flyLayer.children.length >= 3) return; // the sky is full
        const flight = document.createElement('div');
        flight.className = 'flight';
        flight.innerHTML = ['donkey', 'dog'].map((n) => `<span class="critter critter-${n}">${drawCritter(CRITTERS[n])}</span>`).join('');
        flight.style.top = `${12 + Math.random() * 58}vh`;
        const leftward = Math.random() < .5;
        if (leftward) flight.classList.add('is-leftward');
        flyLayer.appendChild(flight);
        lcdMessage('Woof · Hee-haw', 2400);
        announce('A dog and a donkey fly past.');

        let anim;
        if (reduceMotion.matches || !flight.animate) {
            // no flying for reduced motion: they turn up in the corner and leave again
            flight.classList.add('is-still');
            anim = flight.animate?.([{ opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 1, offset: .85 }, { opacity: 0 }], { duration: 2600 });
        } else {
            const w = flight.offsetWidth;
            const from = leftward ? innerWidth : -w;
            const to = leftward ? -w : innerWidth;
            const lift = 30 + Math.random() * 50;
            anim = flight.animate([0, .25, .5, .75, 1].map((t) => ({
                transform: `translate(${(from + (to - from) * t).toFixed(1)}px, ${(-lift * Math.sin(Math.PI * t)).toFixed(1)}px)`,
            })), { duration: ((innerWidth + w) / 300) * 1000, easing: 'linear' });
        }
        if (anim) anim.finished.then(() => flight.remove(), () => flight.remove());
        else setTimeout(() => flight.remove(), 2600);
    }

    // ---- contacts -------------------------------------------------------------

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch { /* not supported */ }
            ta.remove();
            return ok;
        }
    }

    function selectText(el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    $$('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const text = btn.dataset.copy;
            const name = btn.dataset.copyName || text;
            const ok = await copyText(text);
            if (ok) {
                btn.textContent = 'Copied';
                btn.classList.add('is-done');
                lcdMessage(`Copied ${name}`);
                announce(`Copied ${name}`);
            } else {
                selectText(btn.closest('.track').querySelector('.val'));
                lcdMessage('Selected · press Ctrl+C');
                announce('Could not copy automatically. The text is selected, press Control C or Command C.');
            }
            clearTimeout(btn._t);
            btn._t = setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('is-done'); }, 1600);
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
        const el = e.target;
        const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
        const interactive = typing || el.tagName === 'BUTTON' || el.tagName === 'A';
        const key = e.key.toLowerCase();
        if (e.code === 'Space' && !interactive) {
            e.preventDefault();
            toggle();
        } else if (/^[1-3]$/.test(e.key) && !typing && !ejected) {
            const row = $(`.track[data-key="${e.key}"]`);
            if (!row) return;
            row.querySelector('[data-copy]')?.click();
            row.classList.add('is-hit');
            setTimeout(() => row.classList.remove('is-hit'), 700);
        } else if (key === 't' && !typing) {
            nextEdition();
        } else if (key === 'n' && !typing) {
            nextTrack();
        } else if (key === 'a' && !typing) {
            flyBy();
        } else if (key === 'e' && !typing) {
            setEjected(!ejected);
        } else if (e.key === 'Escape' && ejected) {
            setEjected(false);
        }
    });

    // ---- barcode (EAN-13) -----------------------------------------------------

    function drawBarcode(svg, d12) {
        const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
        const R = L.map((c) => c.replace(/./g, (b) => (b === '0' ? '1' : '0')));
        const Gc = R.map((c) => [...c].reverse().join(''));
        const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLG', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
        const d = [...d12].map(Number);
        const sum = d.reduce((s, n, i) => s + n * (i % 2 ? 3 : 1), 0);
        d.push((10 - (sum % 10)) % 10);

        let bits = '101';
        for (let i = 1; i <= 6; i++) bits += (PARITY[d[0]][i - 1] === 'L' ? L : Gc)[d[i]];
        bits += '01010';
        for (let i = 7; i <= 12; i++) bits += R[d[i]];
        bits += '101';

        const QL = 9, W = QL + bits.length + 5, BAR = 48, GUARD = 53;
        const guard = (i) => i < 3 || (i >= 45 && i < 50) || i >= 92;
        svg.setAttribute('viewBox', `0 0 ${W} 62`);
        const list = [];
        for (let i = 0; i < bits.length; i++) if (bits[i] === '1') list.push({ x: QL + i, pos: i, base: guard(i) ? GUARD : BAR });
        let out = `<path class="bars" d="${list.map((b) => `M${b.x} 0h1v${b.base}h-1z`).join('')}"/>`;
        const txt = (x, s) => `<text x="${x}" y="60" text-anchor="middle">${s}</text>`;
        out += txt(4, d[0]);
        for (let i = 0; i < 6; i++) out += txt(QL + 3 + 7 * i + 3.5, d[i + 1]);
        for (let i = 0; i < 6; i++) out += txt(QL + 50 + 7 * i + 3.5, d[i + 7]);
        svg.innerHTML = out;
        svg.setAttribute('aria-label', `Barcode ${d.join('')}`);

        barsPath = $('.bars', svg);
        bars = list.map((b) => ({ ...b, h: b.base }));
    }

    // ---- start ------------------------------------------------------------------

    syncEdition();
    loadTrack(opener, false);
    wake();
    pollRecent();
    setInterval(pollRecent, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRecent(); });
})();
