(() => {
    'use strict';

    const CONFIG = {
        timeZone: 'Europe/Berlin',
        discordId: '832332232982528000',
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

    // sections below the first screen fade up once, as they scroll into view
    if ('IntersectionObserver' in window && !reduceMotion.matches) {
        const io = new IntersectionObserver((entries) => entries.forEach((e) => {
            if (!e.isIntersecting) return;
            e.target.classList.add('in');
            io.unobserve(e.target);
        }), { rootMargin: '0px 0px -12% 0px' });
        $$('.reveal').forEach((el) => io.observe(el));
    } else {
        $$('.reveal').forEach((el) => el.classList.add('in'));
    }

    // ---- theme ---------------------------------------------------------------------

    const THEMES = ['light', 'dark', 'sky'];
    const systemDark = matchMedia('(prefers-color-scheme: dark)');
    const themeColor = $('meta[name="theme-color"]');
    let turntable = null;
    let logoBox = null;

    function applyTheme(t, save) {
        root.dataset.theme = t;
        if (save) store.set('stole:theme', t);
        $$('.theme-pick').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.pick === t)));
        themeColor.content = getComputedStyle(root).getPropertyValue('--bg').trim();
        turntable?.setTheme(readTurntableColors());
        logoBox?.setTheme(readLogoColors());
    }
    function readLogoColors() {
        const cs = getComputedStyle(root);
        const v = (n) => cs.getPropertyValue(n).trim();
        return {
            ink: v('--ink'), dot: v('--wm-dot'), tld: v('--wm-tld'), glass: v('--glass-tint'),
            glassA: parseFloat(v('--glass-a')) || .62, dark: root.dataset.theme === 'dark',
        };
    }
    function readTurntableColors() {
        const cs = getComputedStyle(root);
        const v = (n) => cs.getPropertyValue(n).trim();
        return {
            body: v('--tt-body'), mat: v('--tt-mat'), trim: v('--tt-trim'), accent: v('--accent'), arm: v('--tt-arm'),
            ink: v('--ink-3'), inkStrong: v('--ink-2'), metal: parseFloat(v('--tt-metal')), rough: parseFloat(v('--tt-rough')),
            dark: root.dataset.theme === 'dark',
        };
    }
    // a new theme opens as a circle from where it was picked (or the middle, from the keyboard)
    function switchTheme(t, from) {
        if (t === root.dataset.theme) return;
        if (!document.startViewTransition || reduceMotion.matches) { applyTheme(t, true); return; }
        const x = from ? from.left + from.width / 2 : innerWidth / 2;
        const y = from ? from.top + from.height / 2 : innerHeight / 2;
        root.style.setProperty('--vt-x', `${x}px`);
        root.style.setProperty('--vt-y', `${y}px`);
        root.style.setProperty('--vt-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
        document.startViewTransition(() => applyTheme(t, true));
    }
    const cycleTheme = () => switchTheme(THEMES[(THEMES.indexOf(root.dataset.theme) + 1) % THEMES.length]);
    $$('.theme-pick').forEach((b) => b.addEventListener('click', () => switchTheme(b.dataset.pick, b.getBoundingClientRect())));
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

    function ensureAudioGraph() {
        if (actx !== undefined) return;
        actx = null;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try {
            actx = new AC();
        } catch {
            actx = null;
            return;
        }
        // iOS mutes Web Audio with the ring switch unless the page says it plays media, like the music
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
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

    // volume goes through a GainNode when available, because iOS ignores audio.volume
    let vol = clamp(parseInt(store.get('stole:vol') ?? '70', 10) || 0, 0, 100);
    volIn.value = vol;
    const paintRange = (input) => input.style.setProperty('--p', `${(input.value - input.min) / (input.max - input.min) * 100}%`);
    paintRange(volIn);
    function applyVolume() {
        const v = (vol / 100) ** 2;
        if (gain) { audio.volume = 1; gain.gain.setTargetAtTime(v, actx.currentTime, .04); }
        else audio.volume = v;
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
        document.body.classList.toggle('is-playing-page', p);
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
        turntable?.setProgress(d ? t / d : 0, d);
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

    playBtn.addEventListener('click', toggle);
    $('#nextBtn').addEventListener('click', () => nextTrack());
    $('#prevBtn').addEventListener('click', prevTrack);

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
        $('#logoTitle').textContent = t.title;
        logoBox?.setSong(t);
        const logoArt = $('#logoArt');
        if (art) logoArt.src = coverUrl(t, 80); else logoArt.removeAttribute('src');
        renderPlayedInfo();
        plRows.forEach((r) => r.classList.toggle('is-current', r._track === t));
        // the title and artist slide in fresh for each song
        const npText = $('.np-text');
        npText.classList.remove('is-new');
        void npText.offsetWidth;
        npText.classList.add('is-new');
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
        turntable?.preload(queue[0]);
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

    // ---- the playlist: a grid of covers, folded to a few rows until it's opened ----------

    const plList = $('#plList');
    const plWrap = $('#plWrap');
    const plMore = $('#plMore');
    const plRows = tracks.map((t, i) => {
        const li = el('li');
        li.style.setProperty('--i', String(i % 24));
        const card = el('button', 'song');
        card.type = 'button';
        card._track = t;
        const cover = el('span', 'song-cover');
        const art = el('img');
        art.alt = '';
        art.width = art.height = 300;
        art.loading = 'lazy';
        art.decoding = 'async';
        if (t.art) art.src = coverUrl(t, 300);
        if (t.bg) cover.style.background = t.bg;
        cover.append(art, el('span', 'song-play'));
        const text = el('span', 'song-text');
        text.append(el('span', 'song-title', t.title), el('span', 'song-artist', t.artist));
        card.append(cover, text);
        card.setAttribute('aria-label', `${t.no}. ${t.title} by ${t.artist}`);
        card.addEventListener('click', () => playTrack(t));
        card.addEventListener('pointerenter', () => turntable?.preload(t), { passive: true });
        li.appendChild(card);
        plList.appendChild(li);
        return card;
    });

    const plEmpty = el('li', 'pl-empty', 'No songs match');
    plEmpty.hidden = true;
    plList.appendChild(plEmpty);

    $('#plName').textContent = PLAYLIST.name;
    $('#plMeta').textContent = `${tracks.length} songs · ${fmtLong(tracks.reduce((s, t) => s + (t.ms || 0), 0) / 1000)}`;
    const plOpen = $('#plOpen');
    if (PLAYLIST.url) plOpen.href = PLAYLIST.url; else plOpen.hidden = true;

    function measureFold() {
        const first = plList.firstElementChild;
        if (!first) return;
        const gap = parseFloat(getComputedStyle(plList).rowGap) || 0;
        plWrap.style.setProperty('--fold', `${Math.round(first.offsetHeight * 2.6 + gap * 2)}px`);
    }
    if ('ResizeObserver' in window) new ResizeObserver(measureFold).observe(plList);
    measureFold();

    // opening and folding the grid: its height glides between the two
    function setOpen(open, animate = true) {
        const from = plWrap.getBoundingClientRect().height;
        plWrap.classList.toggle('is-open', open);
        plMore.textContent = open ? 'Show less' : `Show all ${tracks.length} songs`;
        plMore.setAttribute('aria-expanded', String(open));
        if (!animate || reduceMotion.matches || !plWrap.animate) return;
        const to = plWrap.getBoundingClientRect().height;
        plWrap.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 380, easing: 'cubic-bezier(.65, 0, .35, 1)' });
    }
    plMore.addEventListener('click', () => {
        const open = !plWrap.classList.contains('is-open');
        setOpen(open);
        if (!open) plWrap.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    });
    setOpen(false, false);

    const fold = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    $('#plFilter').addEventListener('input', (e) => {
        const q = fold(e.target.value.trim());
        let shown = 0;
        plRows.forEach((card) => {
            const hit = !q || fold(`${card._track.title} ${card._track.artist}`).includes(q);
            card.parentElement.hidden = !hit;
            if (hit) shown++;
        });
        plEmpty.hidden = shown > 0;
        plWrap.classList.toggle('is-filtered', !!q); // a search shows every match, folded or not
        plMore.hidden = !!q;
    });

    // ---- the turntable ---------------------------------------------------------------
    // turntable.js is the 3D record player (three.js, bundled). Without WebGL, or if it fails
    // to load, the flat record stays and still plays and pauses on a tap.

    const ttHost = $('#tt');
    flatRecord.addEventListener('click', toggle);

    const deckModule = import('./turntable.js');

    // the logo: a rounded glass box that rolls up on hover to show the song that's on
    const brand = $('.brand');
    deckModule
        .then(({ createLogoBox }) => {
            logoBox = createLogoBox($('.logo3d'), { colors: readLogoColors(), reduceMotion, grip: brand });
            if (current) logoBox.setSong(current);
            // shown once the lettering is in and drawn, so it appears whole
            const show = () => requestAnimationFrame(() => requestAnimationFrame(() => $('.logo3d').classList.add('is-3d')));
            (document.fonts?.ready || Promise.resolve()).then(show, show);
            const up = () => logoBox.flip(true);
            const down = () => logoBox.flip(false);
            brand.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') up(); });
            brand.addEventListener('pointerleave', (e) => { if (!brand.classList.contains('is-grabbed')) down(); });
            brand.addEventListener('lostpointercapture', () => { if (!brand.matches(':hover')) down(); });
        })
        .catch(() => { $('.logo3d').classList.add('no-3d'); }); // no WebGL: the flat box

    deckModule
        .then(({ createTurntable }) => createTurntable(ttHost, { onToggle: toggle, colors: readTurntableColors(), reduceMotion }))
        .then((tt) => {
            turntable = tt;
            if (current) { tt.setTrack(current, false); renderPlayedInfo(); renderTime(); }
            tt.setPlaying(playing);
            flatRecord.classList.remove('is-spinning');
            // shown once the first record is on, cover and all (or after a moment, if the cover is slow)
            Promise.race([tt.ready, new Promise((ok) => setTimeout(ok, 1500))])
                .then(() => requestAnimationFrame(() => ttHost.classList.add('is-3d')));
            setTimeout(queueScrollTurn, 950); // once it has turned in
        })
        .catch((err) => {
            console.warn('3D turntable unavailable:', err);
            ttHost.classList.add('no-3d'); // the flat record
            flatRecord.classList.toggle('is-spinning', playing && !reduceMotion.matches);
        });

    // ---- on phones the deck turns as the page scrolls past it ---------------------------------
    // From a little turned one way as it comes up the screen to the other way as it leaves.

    const scrollTurnQuery = matchMedia('(max-width: 960px), (hover: none)');
    let scrollTurnQueued = false;
    function scrollTurn() {
        scrollTurnQueued = false;
        if (!turntable) return;
        if (!scrollTurnQuery.matches || reduceMotion.matches) { turntable.setTurn(null); return; }
        const r = ttHost.getBoundingClientRect();
        const p = clamp((innerHeight - r.top) / (innerHeight + r.height), 0, 1);
        turntable.setTurn(-.4 + .8 * p, .13 - .21 * p);
    }
    const queueScrollTurn = () => {
        if (scrollTurnQueued) return;
        scrollTurnQueued = true;
        requestAnimationFrame(scrollTurn);
    };
    addEventListener('scroll', queueScrollTurn, { passive: true });
    addEventListener('resize', queueScrollTurn, { passive: true });
    scrollTurnQuery.addEventListener('change', queueScrollTurn);

    // ---- keyboard ----------------------------------------------------------------------

    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
        const t = e.target;
        const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
        const interactive = typing || t.tagName === 'BUTTON' || t.tagName === 'A';
        const key = e.key.toLowerCase();
        if (e.code === 'Space' && !interactive) {
            e.preventDefault();
            toggle();
        } else if (/^[1-3]$/.test(e.key) && !typing) {
            const row = $(`.link[data-key="${e.key}"]`);
            if (!row) return;
            row.querySelector('[data-copy]')?.click();
            row.classList.add('is-hit');
            setTimeout(() => row.classList.remove('is-hit'), 700);
        } else if (key === 'n' && !typing) {
            nextTrack();
        } else if (key === 'p' && !typing) {
            prevTrack();
        } else if (key === 'm' && !typing) {
            cycleTheme();
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

    // ---- Last.fm: what's been on lately -----------------------------------------------------
    // Apple Music keeps listening history to itself, so plays get scrobbled to Last.fm (a
    // scrobbler app does that) and are read back from there. Covers and Apple Music links come
    // from the playlist when the song is in it, otherwise from Apple's search.

    const stats = $('#stats');
    const statsNote = $('#statsNote');
    const LASTFM_BLANK = '2a96cbd8b46e442fc41c2b86b821562f'; // Last.fm's grey star placeholder
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

    // top artists of the month: ranked, the bar shows how they compare, no numbers
    function renderTopArtists(list) {
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
            li.append(el('span', 'no', String(i + 1)), name, bar);
            ol.appendChild(li);
        });
        if (!list.length) ol.appendChild(el('li', 'row-sub', 'Nothing this month yet'));
    }

    function renderTopTracks(list) {
        const ol = $('#topTracks');
        ol.textContent = '';
        list.forEach((t) => ol.appendChild(songRow(t, '')));
        if (!list.length) ol.appendChild(el('li', 'row-sub', 'Nothing this month yet'));
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

    async function loadTops() {
        try {
            const [artists, top] = await Promise.all([
                lastfm('user.gettopartists', { period: '1month', limit: 6 }),
                lastfm('user.gettoptracks', { period: '1month', limit: 5 }),
            ]);
            renderTopArtists([].concat(artists.topartists?.artist || []).map((a) => ({ name: a.name, plays: +a.playcount || 0, url: a.url })));
            renderTopTracks([].concat(top.toptracks?.track || []).map((t) => ({ title: t.name, artist: t.artist?.name || '', img: lastfmImg(t.image) })));
            stats.hidden = false;
        } catch (err) {
            if (stats.hidden) statsUnavailable(`Last.fm couldn’t be read (${err.message}).`);
        }
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
        else if (historyState === 'complete') { short = 'long ago'; long = 'Played a long time ago'; }
        $('#npMeta').textContent = long;
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
            stats.hidden = false;
            nowPlayingKey = '';
            list.forEach((t) => notePlay(t.title, t.artist, t.at || Date.now(), t.now));
            renderPlayedInfo();
        } catch { /* keep the last list up */ }
    }

    if (CONFIG.lastfmUser && CONFIG.lastfmKey) {
        loadTops();
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
