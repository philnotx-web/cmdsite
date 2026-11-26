// The 3D record player on stole.cc.
//
// Source for ../../turntable.js. Rebuild after editing:
//     cd tools/turntable && npm install && npm run build
//
// Units are centimetres, y up, the plinth's top at y = 0 and the viewer towards +z.
// The page drives it through the object createTurntable() returns; it calls back for
// plays, pauses and scratches. It only renders while something moves.

import {
    WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Color, Vector2, Vector3, Plane, Raycaster,
    MeshPhysicalMaterial, MeshStandardMaterial, MeshBasicMaterial,
    CylinderGeometry, CircleGeometry, RingGeometry, BoxGeometry, PlaneGeometry, SphereGeometry, ExtrudeGeometry, Shape,
    DirectionalLight, PMREMGenerator, CanvasTexture, DataTexture,
    SRGBColorSpace, NeutralToneMapping, PCFShadowMap, RGBAFormat, LinearFilter, LinearMipmapLinearFilter,
    RepeatWrapping, DoubleSide,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const SPIN = 200;              // deg/s: 33⅓ rpm
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// layout
const PLINTH = { w: 46, d: 35, h: 4.2, r: 2.4, bevel: .45 };
const C = new Vector3(-6, 0, .3);       // platter centre
const PLATTER = { r: 15.9, y0: .25, h: 1.7 };
const MAT_TOP = PLATTER.y0 + PLATTER.h + .2;
const RECORD = { r: 15, label: 5, h: .2 };
const RECORD_TOP = MAT_TOP + RECORD.h;
const GROOVES = { lead: 14.6, start: 14.45, end: 6.5, runout: 6.1 };
const PIVOT = new Vector3(15.6, 0, -10.2); // tone arm
const ARM = { len: 22.8, y: RECORD_TOP + 1.5, lift: -.055, down: 0 };

const ease = (x) => 1 - (1 - x) ** 3;
const smooth = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
const wrapDeg = (d) => ((d + 540) % 360) - 180;

export function createTurntable(host, opts) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', 'Record player. Tap the record to play or pause, drag it to scratch.');
    canvas.setAttribute('role', 'img');
    host.appendChild(canvas);

    let renderer;
    try {
        renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (err) {
        canvas.remove();
        throw err;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.setClearColor(0x000000, 0);

    const scene = new Scene();
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
    pmrem.dispose();

    const camera = new PerspectiveCamera(24, 1, 5, 400);
    const deckRoot = new Group();       // everything; tilts a little with the pointer
    scene.add(deckRoot);

    // ---- materials ----------------------------------------------------------------

    const M = {
        body: new MeshPhysicalMaterial({ color: 0xe7e7e3, roughness: .9, metalness: .5, clearcoat: .2, clearcoatRoughness: .3, anisotropy: .8 }),
        trim: new MeshStandardMaterial({ color: 0xc9cacd, roughness: .4, metalness: .2 }),
        metal: new MeshStandardMaterial({ color: 0xc8cbcf, roughness: .22, metalness: 1 }),
        darkMetal: new MeshStandardMaterial({ color: 0x2b2d31, roughness: .35, metalness: .85 }),
        black: new MeshStandardMaterial({ color: 0x141416, roughness: .5 }),
        felt: new MeshPhysicalMaterial({ color: 0x1c1c1e, roughness: 1, sheen: 1, sheenRoughness: .8, sheenColor: new Color(0x555555) }),
        accent: new MeshStandardMaterial({ color: 0xe8551d, roughness: .4 }),
        led: new MeshStandardMaterial({ color: 0x222222, emissive: 0xe8551d, emissiveIntensity: 0 }),
        vinylEdge: new MeshPhysicalMaterial({ color: 0x0b0b0c, roughness: .3, clearcoat: .6, clearcoatRoughness: .2 }),
    };

    const decals = []; // printed text, repainted when the theme changes

    // ---- plinth --------------------------------------------------------------------

    function roundedRect(w, d, r) {
        const s = new Shape();
        const x = -w / 2, y = -d / 2;
        s.moveTo(x + r, y);
        s.lineTo(x + w - r, y);
        s.quadraticCurveTo(x + w, y, x + w, y + r);
        s.lineTo(x + w, y + d - r);
        s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
        s.lineTo(x + r, y + d);
        s.quadraticCurveTo(x, y + d, x, y + d - r);
        s.lineTo(x, y + r);
        s.quadraticCurveTo(x, y, x + r, y);
        return s;
    }
    // a rounded slab: footprint w × d, height h, its top at y = 0
    function slab(w, d, h, r, bevel, mat) {
        const geo = new ExtrudeGeometry(roundedRect(w - bevel * 2, d - bevel * 2, Math.max(.01, r - bevel)), {
            depth: h - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 10,
        });
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, -h + bevel, 0);
        const m = new Mesh(geo, mat);
        m.castShadow = m.receiveShadow = true;
        return m;
    }

    // brushed finish: fine streaks along the deck, in the roughness and a touch of relief
    const brushed = (() => {
        const N = 1024;
        const cv = document.createElement('canvas');
        cv.width = cv.height = N;
        const g = cv.getContext('2d');
        g.fillStyle = 'rgb(128,128,128)';
        g.fillRect(0, 0, N, N);
        for (let i = 0; i < 16000; i++) {
            const x = Math.random() * N;
            const y = Math.random() * N;
            const len = 80 + Math.random() * 600;
            const v = (128 + (Math.random() - .5) * 200) | 0;
            g.strokeStyle = `rgba(${v},${v},${v},${.3 + Math.random() * .5})`;
            g.lineWidth = .5 + Math.random();
            for (const dx of [0, -N]) { // drawn twice so streaks wrap round the tile's edge
                g.beginPath();
                g.moveTo(x + dx, y);
                g.lineTo(x + dx + len, y + (Math.random() - .5));
                g.stroke();
            }
        }
        const t = new CanvasTexture(cv);
        t.wrapS = t.wrapT = RepeatWrapping;
        t.repeat.set(1 / 26, 1 / 26); // the plinth's UVs are in centimetres: one tile per 26 cm
        t.anisotropy = 8;
        return t;
    })();
    M.body.roughnessMap = brushed;
    M.body.bumpMap = brushed;
    M.body.bumpScale = 1.2;

    const plinth = slab(PLINTH.w, PLINTH.d, PLINTH.h, PLINTH.r, PLINTH.bevel, M.body);
    deckRoot.add(plinth);

    for (const [x, z] of [[-19.5, 14], [19.5, 14], [-19.5, -14], [19.5, -14]]) {
        const foot = new Mesh(new CylinderGeometry(2.2, 2.4, 1.1, 32), M.black);
        foot.position.set(x, -PLINTH.h - .5, z);
        foot.castShadow = true;
        deckRoot.add(foot);
    }

    // soft shadow on the page under the player
    const shadowTex = (() => {
        // the blur has to fade out well inside the canvas, or the plane's edge shows
        const cv = document.createElement('canvas');
        cv.width = 512;
        cv.height = 420;
        const g = cv.getContext('2d');
        g.filter = 'blur(26px)';
        g.fillStyle = '#000';
        g.beginPath();
        g.roundRect(110, 100, 292, 220, 30);
        g.fill();
        const img = g.getImageData(0, 0, cv.width, cv.height);
        for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 6) img.data[i] = 0;
        g.putImageData(img, 0, 0);
        return new CanvasTexture(cv);
    })();
    const floorShadow = new Mesh(new PlaneGeometry(PLINTH.w * 1.75, PLINTH.d * 1.9),
        new MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: .32, depthWrite: false, color: 0x000000 }));
    floorShadow.rotation.x = -Math.PI / 2;
    floorShadow.position.set(0, -PLINTH.h - 1.06, 1.2);
    deckRoot.add(floorShadow);

    // ---- platter, mat and record ------------------------------------------------------

    const spinner = new Group();   // turns: platter, mat, record
    spinner.position.copy(C);
    deckRoot.add(spinner);

    // strobe dots round the platter's rim, like on the classic decks
    const strobeTex = (() => {
        const cv = document.createElement('canvas');
        cv.width = 2048;
        cv.height = 64;
        const g = cv.getContext('2d');
        g.fillStyle = '#c4c7cb';
        g.fillRect(0, 0, 2048, 64);
        for (const [y, n] of [[16, 180], [32, 183], [48, 186]]) {
            g.fillStyle = 'rgba(40,42,46,.85)';
            for (let i = 0; i < n; i++) g.fillRect((i / n) * 2048, y - 3, 2048 / n / 2, 6);
        }
        const t = new CanvasTexture(cv);
        t.colorSpace = SRGBColorSpace;
        t.wrapS = RepeatWrapping;
        t.anisotropy = 8;
        return t;
    })();
    const platterSide = new MeshStandardMaterial({ map: strobeTex, roughness: .35, metalness: .9 });
    const platter = new Mesh(new CylinderGeometry(PLATTER.r, PLATTER.r - .25, PLATTER.h, 160, 1), [platterSide, M.metal, M.metal]);
    platter.position.y = PLATTER.y0 + PLATTER.h / 2;
    platter.castShadow = platter.receiveShadow = true;
    spinner.add(platter);

    const mat = new Mesh(new CylinderGeometry(15.2, 15.2, .2, 128), M.felt);
    mat.position.y = MAT_TOP - .1;
    mat.receiveShadow = true;
    spinner.add(mat);

    const spindle = new Mesh(new CylinderGeometry(.36, .36, 1.2, 24), M.metal);
    spindle.position.y = RECORD_TOP + .35;
    spinner.add(spindle);
    const spindleCap = new Mesh(new SphereGeometry(.36, 24, 12, 0, TAU, 0, Math.PI / 2), M.metal);
    spindleCap.position.y = RECORD_TOP + .95;
    spinner.add(spindleCap);

    // the grooves: roughness rings (glossy gaps between songs, smooth lead-in and run-out)
    // and a circular anisotropy map, which gives vinyl its light streak across the grooves
    const MAP = 1024;
    const rOf = (px) => (px / (MAP / 2)) * RECORD.r;
    const roughTex = (() => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = MAP;
        const g = cv.getContext('2d');
        g.fillStyle = 'rgb(70,70,70)';
        g.fillRect(0, 0, MAP, MAP);
        const gaps = [12.1, 9.4];
        for (let px = MAP / 2; px > 0; px--) {
            const r = rOf(px);
            let v;
            if (r > GROOVES.lead) v = 50;                                // the edge and lead-in
            else if (r < GROOVES.runout) v = 40;                         // run-out
            else if (gaps.some((x) => Math.abs(r - x) < .09)) v = 34;     // between songs
            else v = 92 + (Math.random() - .5) * 26;                    // grooves
            g.strokeStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
            g.lineWidth = 1.2;
            g.beginPath();
            g.arc(MAP / 2, MAP / 2, px, 0, TAU);
            g.stroke();
        }
        const t = new CanvasTexture(cv);
        t.anisotropy = 8;
        return t;
    })();
    const anisoTex = (() => {
        const N = 512;
        const data = new Uint8Array(N * N * 4);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const dx = (x + .5) / N - .5;
                const dy = (y + .5) / N - .5;
                const len = Math.hypot(dx, dy) || 1;
                const r = len * 2 * RECORD.r;
                const i = (y * N + x) * 4;
                data[i] = ((-dy / len) * .5 + .5) * 255;   // along the groove
                data[i + 1] = ((dx / len) * .5 + .5) * 255;
                data[i + 2] = r > GROOVES.lead || r < GROOVES.runout ? 90 : 255;
                data[i + 3] = 255;
            }
        }
        const t = new DataTexture(data, N, N, RGBAFormat);
        t.minFilter = LinearMipmapLinearFilter;
        t.magFilter = LinearFilter;
        t.generateMipmaps = true;
        t.needsUpdate = true;
        return t;
    })();
    const vinylTop = new MeshPhysicalMaterial({
        color: 0x0a0a0b, roughness: 1, roughnessMap: roughTex, metalness: 0,
        anisotropy: .9, anisotropyMap: anisoTex,
        clearcoat: .25, clearcoatRoughness: .3, specularIntensity: 1,
    });

    const record = new Group();
    record.position.y = MAT_TOP;
    spinner.add(record);
    const recordFace = new Mesh(new RingGeometry(RECORD.label - .01, RECORD.r, 256, 1), vinylTop);
    recordFace.rotation.x = -Math.PI / 2;
    recordFace.position.y = RECORD.h;
    recordFace.receiveShadow = true;
    record.add(recordFace);
    const recordEdge = new Mesh(new CylinderGeometry(RECORD.r, RECORD.r, RECORD.h, 160, 1, true), M.vinylEdge);
    recordEdge.position.y = RECORD.h / 2;
    recordEdge.castShadow = true;
    record.add(recordEdge);
    const labelMat = new MeshStandardMaterial({ color: 0xffffff, roughness: .75 });
    const label = new Mesh(new CircleGeometry(RECORD.label, 96), labelMat);
    label.rotation.x = -Math.PI / 2;
    label.position.y = RECORD.h + .004;
    label.receiveShadow = true;
    record.add(label);
    const recordMats = [vinylTop, M.vinylEdge, labelMat];

    // ---- tone arm -------------------------------------------------------------------

    const armBase = new Group();
    armBase.position.copy(PIVOT);
    deckRoot.add(armBase);
    const plate = new Mesh(new CylinderGeometry(3.1, 3.2, .35, 64), M.darkMetal);
    plate.position.y = .17;
    plate.castShadow = plate.receiveShadow = true;
    armBase.add(plate);
    const collar = new Mesh(new CylinderGeometry(2.1, 2.1, .9, 48), M.metal);
    collar.position.y = .8;
    collar.castShadow = true;
    armBase.add(collar);
    const post = new Mesh(new CylinderGeometry(1.05, 1.15, ARM.y - 1.2, 32), M.darkMetal);
    post.position.y = 1.2 + (ARM.y - 1.2) / 2;
    post.castShadow = true;
    armBase.add(post);

    const armYaw = new Group();      // swings across the record
    armYaw.position.y = ARM.y;
    armBase.add(armYaw);
    const armPitch = new Group();    // lifts and lowers
    armYaw.add(armPitch);

    const gimbal = new Mesh(new BoxGeometry(1.7, 1.3, 1.7), M.metal);
    gimbal.castShadow = true;
    armPitch.add(gimbal);
    const tubeLen = ARM.len - 3.2;
    const tube = new Mesh(new CylinderGeometry(.3, .3, tubeLen, 20), M.metal);
    tube.rotation.x = Math.PI / 2;
    tube.position.z = tubeLen / 2 + .4;
    tube.castShadow = true;
    armPitch.add(tube);
    const stub = new Mesh(new CylinderGeometry(.42, .42, 4.6, 20), M.metal);
    stub.rotation.x = Math.PI / 2;
    stub.position.z = -2.3;
    armPitch.add(stub);
    const weight = new Mesh(new CylinderGeometry(1.35, 1.35, 2.6, 40), M.darkMetal);
    weight.rotation.x = Math.PI / 2;
    weight.position.z = -4.4;
    weight.castShadow = true;
    armPitch.add(weight);

    // headshell and cartridge, turned in by the offset angle so the stylus sits along the groove
    const head = new Group();
    head.position.z = ARM.len;
    head.rotation.y = -22 * DEG;
    armPitch.add(head);
    const shell = new Mesh(new BoxGeometry(1.9, .28, 3.4), M.metal);
    shell.position.set(0, .05, -1.2);
    shell.castShadow = true;
    head.add(shell);
    const cart = new Mesh(new BoxGeometry(1.45, 1.05, 2.3), M.accent);
    cart.position.set(0, -.6, -.7);
    cart.castShadow = true;
    head.add(cart);
    const stylus = new Mesh(new CylinderGeometry(.05, .02, .45, 8), M.metal);
    stylus.position.set(0, -1.3, 0);
    head.add(stylus);
    const fingerLift = new Mesh(new BoxGeometry(1.7, .1, .45), M.metal);
    fingerLift.position.set(1.6, .05, -2.4);
    head.add(fingerLift);

    // arm rest, where the arm lies when it's off the record
    const restZ = 15;
    const rest = new Mesh(new CylinderGeometry(.35, .4, ARM.y - .3, 16), M.darkMetal);
    rest.position.set(PIVOT.x, (ARM.y - .3) / 2, PIVOT.z + restZ);
    rest.castShadow = true;
    deckRoot.add(rest);
    const cradle = new Mesh(new BoxGeometry(1.3, .35, .6), M.black);
    cradle.position.set(PIVOT.x, ARM.y - .45, PIVOT.z + restZ);
    deckRoot.add(cradle);

    // ---- controls on the plinth ------------------------------------------------------

    const startBtn = slab(4.4, 2.8, .6, .5, .15, M.trim);
    startBtn.position.set(-18.4, .45, 14.4);
    deckRoot.add(startBtn);
    const startText = textDecal('START · STOP', 4.2, .9, { size: 34, weight: 600 });
    startText.position.set(0, .012, 0); // rides on the key, so it goes down with it
    startBtn.add(startText);

    // two keys where a deck has 33 and 45: the song's number in the playlist, and when it was
    // last played (from Last.fm). The page fills them in with setInfo().
    const info = { no: '', last: '' };
    for (const k of [
        { x: -14.5, caption: 'NO.', value: () => info.no || '–' },
        { x: -11.9, caption: 'LAST PLAYED', value: () => info.last || '–' },
    ]) {
        const b = slab(2.4, 1.5, .45, .3, .1, M.trim);
        b.position.set(k.x, .3, 16.3);
        deckRoot.add(b);
        const d = decal(2.3, 1.4, (g, w, h, ink) => {
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillStyle = ink.soft;
            g.font = `600 ${Math.round(h * .19)}px Geist, system-ui, sans-serif`;
            if ('letterSpacing' in g) g.letterSpacing = '1px';
            g.fillText(k.caption, w / 2, h * .27);
            g.fillStyle = ink.strong;
            g.font = `650 ${Math.round(h * .42)}px Geist, system-ui, sans-serif`;
            if ('letterSpacing' in g) g.letterSpacing = '0px';
            g.fillText(k.value(), w / 2, h * .64);
        });
        d.position.set(k.x, .31, 16.3);
        deckRoot.add(d);
    }
    const led = new Mesh(new CylinderGeometry(.22, .22, .12, 16), M.led);
    led.position.set(-14.5, .06, 15.1);
    deckRoot.add(led);

    // pitch fader on the right
    const slot = new Mesh(new BoxGeometry(.4, .06, 10), M.darkMetal);
    slot.position.set(19.6, .02, 6.4);
    deckRoot.add(slot);
    const knob = slab(1.9, 1.2, .7, .3, .12, M.trim);
    knob.position.set(19.6, .6, 6.4);
    deckRoot.add(knob);
    const brand = textDecal('stole.cc', 8, 1.6, { size: 64, weight: 600, align: 'right' });
    brand.position.set(17.6, .005, 15.4);
    deckRoot.add(brand);

    // text printed onto the plinth, in a colour the theme sets
    // something printed onto the plinth, repainted in the theme's inks
    function decal(w, h, paint) {
        const cv = document.createElement('canvas');
        cv.width = Math.round(w * 96);
        cv.height = Math.round(h * 96);
        const tex = new CanvasTexture(cv);
        tex.colorSpace = SRGBColorSpace;
        tex.anisotropy = 8;
        const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
        m.rotation.x = -Math.PI / 2;
        m.userData.paint = (ink) => {
            const g = cv.getContext('2d');
            g.clearRect(0, 0, cv.width, cv.height);
            paint(g, cv.width, cv.height, ink);
            tex.needsUpdate = true;
        };
        decals.push(m);
        return m;
    }
    function textDecal(text, w, h, { size, weight, align = 'center' }) {
        return decal(w, h, (g, cw, ch, ink) => {
            g.fillStyle = ink.soft;
            g.font = `${weight} ${size * 1.5}px Geist, system-ui, sans-serif`;
            g.textAlign = align;
            g.textBaseline = 'middle';
            if ('letterSpacing' in g) g.letterSpacing = '3px';
            g.fillText(text, align === 'right' ? cw - 6 : cw / 2, ch / 2 + 3);
        });
    }

    // ---- light --------------------------------------------------------------------

    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(-26, 52, 26);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -34;
    key.shadow.camera.right = 34;
    key.shadow.camera.top = 30;
    key.shadow.camera.bottom = -30;
    key.shadow.camera.near = 20;
    key.shadow.camera.far = 120;
    key.shadow.radius = 5;
    key.shadow.bias = -.0004;
    key.shadow.normalBias = .03;
    scene.add(key);
    // a low light from behind, grazing the grooves
    const rim = new DirectionalLight(0xffffff, .9);
    rim.position.set(34, 18, -30);
    scene.add(rim);

    // ---- label: printed for each song from its cover and colours ------------------------

    const LABEL_PX = 1024;
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = labelCanvas.height = LABEL_PX;
    const labelTex = new CanvasTexture(labelCanvas);
    labelTex.colorSpace = SRGBColorSpace;
    labelTex.anisotropy = 8;
    labelMat.map = labelTex;
    const covers = new Map();

    function loadCover(url) {
        if (!url) return Promise.resolve(null);
        if (!covers.has(url)) {
            covers.set(url, new Promise((ok) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.decoding = 'async';
                img.onload = () => ok(img);
                img.onerror = () => ok(null);
                img.src = url;
            }));
        }
        return covers.get(url);
    }

    // text round the label: along the top, or along the bottom still reading left to right
    function arcText(g, text, radius, { size, weight, color, bottom }) {
        g.save();
        g.fillStyle = color;
        g.textBaseline = 'middle';
        g.textAlign = 'center';
        let px = size;
        let str = text;
        const room = radius * Math.PI * .8;
        const width = () => {
            g.font = `${weight} ${px}px Geist, system-ui, sans-serif`;
            return [...str].reduce((w, ch) => w + g.measureText(ch).width + px * .14, 0);
        };
        while (width() > room && px > size * .64) px -= 2;
        while (width() > room && str.length > 4) str = `${str.slice(0, -2).trimEnd()}…`;
        const spacing = px * .14;
        const total = width() - spacing;
        const dir = bottom ? -1 : 1;
        let a = -dir * total / radius / 2;
        g.translate(LABEL_PX / 2, LABEL_PX / 2);
        for (const ch of str) {
            const w = g.measureText(ch).width;
            g.save();
            g.rotate(a + dir * (w / 2) / radius);
            g.translate(0, bottom ? radius : -radius);
            g.fillText(ch, 0, 0);
            g.restore();
            a += dir * (w + spacing) / radius;
        }
        g.restore();
    }

    function paintLabel(t, img) {
        const g = labelCanvas.getContext('2d');
        const R = LABEL_PX / 2;
        const bg = t?.bg || '#e8e8e8';
        const fg = t?.fg || '#111111';
        g.clearRect(0, 0, LABEL_PX, LABEL_PX);
        g.fillStyle = bg;
        g.beginPath();
        g.arc(R, R, R, 0, TAU);
        g.fill();
        const inner = R * .7;
        if (img) {
            g.save();
            g.beginPath();
            g.arc(R, R, inner, 0, TAU);
            g.clip();
            g.drawImage(img, R - inner, R - inner, inner * 2, inner * 2);
            g.restore();
            g.strokeStyle = fg;
            g.globalAlpha = .18;
            g.lineWidth = 3;
            g.beginPath();
            g.arc(R, R, inner + 2, 0, TAU);
            g.stroke();
            g.globalAlpha = 1;
        }
        if (t) {
            const ring = (R + inner) / 2 + 2;
            arcText(g, (t.title || '').toUpperCase(), ring, { size: 50, weight: 650, color: fg });
            arcText(g, `${(t.artist || '').toUpperCase()}  ·  33⅓`, ring, { size: 38, weight: 500, color: fg, bottom: true });
            if (!img) {
                g.fillStyle = t.accent || fg;
                g.globalAlpha = .9;
                g.beginPath();
                g.arc(R, R, inner * .62, 0, TAU);
                g.fill();
                g.globalAlpha = 1;
            }
        }
        // the spindle hole, and a faint pressing ring round it
        g.fillStyle = 'rgba(0,0,0,.08)';
        g.beginPath();
        g.arc(R, R, R * .19, 0, TAU);
        g.fill();
        g.fillStyle = '#0d0d0e';
        g.beginPath();
        g.arc(R, R, R * .075, 0, TAU);
        g.fill();
        labelTex.needsUpdate = true;
    }

    let labelTurn = 0;
    async function printLabel(t) {
        const turn = ++labelTurn;
        const url = t?.art ? t.art.replace(/\/\d+x\d+bb\./, '/600x600bb.') : '';
        try { await document.fonts?.load('600 40px Geist'); } catch { /* system font then */ }
        const img = await loadCover(url);
        if (turn !== labelTurn) return false;
        paintLabel(t, img);
        return true;
    }

    // ---- camera: framed so the whole deck fits, from the front and a little above -------

    const target = new Vector3(0, -1.6, 1.2);
    const view = new Vector3(Math.sin(.16) * Math.cos(.98), Math.sin(.98), Math.cos(.16) * Math.cos(.98)).normalize();
    const corners = [];
    for (const x of [-PLINTH.w / 2, PLINTH.w / 2]) for (const y of [-PLINTH.h - 1, ARM.y + 1]) for (const z of [-PLINTH.d / 2, PLINTH.d / 2]) corners.push(new Vector3(x, y, z));
    function frame() {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        let lo = 40, hi = 400;
        for (let i = 0; i < 24; i++) {
            const dist = (lo + hi) / 2;
            camera.position.copy(target).addScaledVector(view, dist);
            camera.lookAt(target);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld();
            const fits = corners.every((c) => {
                const p = c.clone().project(camera);
                return Math.abs(p.x) < .96 && Math.abs(p.y) < .95;
            });
            if (fits) hi = dist; else lo = dist;
        }
        camera.position.copy(target).addScaledVector(view, hi);
        camera.lookAt(target);
        camera.updateProjectionMatrix();
        wake();
    }

    // ---- state ------------------------------------------------------------------------

    let playing = false;
    let progress = 0;
    let angle = 0;         // record, degrees clockwise from above
    let vel = 0;           // deg/s
    let yaw = 0;
    let pitch = ARM.down;
    let armStage = 'rest';
    let swap = null;       // record change in progress
    let lastPitchGoal = ARM.down;
    let landing = false;   // the arm is on its way down: a sound when it gets there
    let keyAt = -1e9;      // when the start/stop key was last pressed
    let scratch = null;
    let tiltX = 0, tiltY = 0, tiltTX = 0, tiltTY = 0;
    let visible = true;
    let rafId = 0;
    let last = performance.now();
    const motion = () => !opts.reduceMotion?.matches;

    // yaw that puts the stylus at radius r from the spindle
    function yawFor(r) {
        let lo = Math.atan2(C.x - PIVOT.x, C.z - PIVOT.z); // pointing at the spindle: closest
        let hi = 0;
        const dist = (y) => Math.hypot(PIVOT.x + ARM.len * Math.sin(y) - C.x, PIVOT.z + ARM.len * Math.cos(y) - C.z);
        for (let i = 0; i < 30; i++) {
            const mid = (lo + hi) / 2;
            if (dist(mid) > r) hi = mid; else lo = mid;
        }
        return (lo + hi) / 2;
    }
    const grooveYaw = (p) => yawFor(GROOVES.start - (GROOVES.start - GROOVES.end) * Math.min(1, Math.max(0, p)));

    function armWanted() {
        if (swap) return null;
        if (playing || progress > .002) return grooveYaw(progress);
        return null;
    }

    // The arm lifts, swings and lowers like a cueing lever would: off the rest onto the
    // groove when music starts, along the groove as it plays, and home when it's done.
    // armStage: 'rest' | 'cue' (lifting, swinging, lowering) | 'tracking' (stylus in the groove)
    function stepArm(dt) {
        const want = armWanted();
        let yawGoal, pitchGoal;
        if (want === null) {
            armStage = 'rest';
            if (Math.abs(yaw) > .01) {
                pitch = smooth(pitch, ARM.lift, dt, .12);
                if (pitch < ARM.lift * .7) yaw = smooth(yaw, 0, dt, .3);
                yawGoal = 0; pitchGoal = ARM.lift;
            } else {
                yaw = smooth(yaw, 0, dt, .1);
                pitch = smooth(pitch, ARM.down, dt, .14);
                yawGoal = 0; pitchGoal = ARM.down;
            }
        } else if (armStage === 'tracking') {
            yaw = smooth(yaw, want, dt, .25);
            pitch = smooth(pitch, ARM.down, dt, .1);
            if (Math.abs(yaw - want) > .05) armStage = 'cue'; // a seek: lift it and move
            yawGoal = want; pitchGoal = ARM.down;
        } else {
            armStage = 'cue';
            // the groove moves inwards while the music plays, so "over it" has to allow for
            // the arm trailing a little behind; closer than this it lowers and keeps following
            if (Math.abs(yaw - want) > .02) {
                pitch = smooth(pitch, ARM.lift, dt, .12);
                if (pitch < ARM.lift * .7) yaw = smooth(yaw, want, dt, .3);
                yawGoal = want; pitchGoal = ARM.lift;
            } else {
                yaw = smooth(yaw, want, dt, .1);
                pitch = smooth(pitch, ARM.down, dt, .16);
                if (Math.abs(pitch - ARM.down) < .001) armStage = 'tracking';
                yawGoal = want; pitchGoal = ARM.down;
            }
        }
        // sounds: the arm leaving the groove or the rest, and the stylus (or the arm) landing
        if (pitchGoal !== lastPitchGoal) {
            if (pitchGoal === ARM.lift) { opts.onSound?.('lift'); landing = false; } else landing = true;
            lastPitchGoal = pitchGoal;
        }
        if (landing && Math.abs(pitch - ARM.down) < .004) {
            landing = false;
            opts.onSound?.(want === null ? 'rest' : 'drop');
        }
        armYaw.rotation.y = yaw;
        armPitch.rotation.x = pitch;
        return armStage === 'cue' || Math.abs(yaw - yawGoal) > .0005 || Math.abs(pitch - pitchGoal) > .0005;
    }

    function stepSwap(now) {
        if (!swap) return false;
        const s = swap;
        if (s.stage === 'arm') {
            if (Math.abs(yaw) < .02 || now - s.t0 > 1400) { s.stage = 'out'; s.t0 = now; recordMats.forEach((m) => { m.transparent = true; }); }
        }
        if (s.stage === 'out') {
            const k = Math.min(1, (now - s.t0) / 380);
            record.position.y = MAT_TOP + ease(k) * 7;
            record.position.x = -ease(k) * 4;
            recordMats.forEach((m) => { m.opacity = 1 - k; });
            if (k >= 1 && s.ready) { s.stage = 'in'; s.t0 = now; }
        }
        if (s.stage === 'in') {
            const k = Math.min(1, (now - s.t0) / 560);
            const e = ease(k);
            record.position.y = MAT_TOP + (1 - e) * 7;
            record.position.x = (1 - e) * 4;
            recordMats.forEach((m) => { m.opacity = Math.min(1, k * 1.6); });
            if (k >= 1) {
                record.position.set(0, MAT_TOP, 0);
                recordMats.forEach((m) => { m.transparent = false; m.opacity = 1; });
                swap = null;
                opts.onSound?.('place');
            }
        }
        return true;
    }

    function tick(now) {
        rafId = 0;
        const dt = Math.min(.064, Math.max(0, (now - last) / 1000));
        last = now;
        let busy = false;

        if (scratch) {
            if (now - scratch.t > 50) scratch.vel *= Math.exp(-dt / .06); // a still hand stops the record under it
            vel = scratch.vel;
            opts.onScratchMove?.(scratch.vel / SPIN);
            busy = true;
        } else {
            // spins up quicker than it spins down, like a motor with a heavy platter
            const goal = playing && motion() ? SPIN : 0;
            vel = smooth(vel, goal, dt, playing ? .5 : 1.1);
            if (!goal && Math.abs(vel) < .5) vel = 0;
            angle = (angle + vel * dt) % 360;
            busy ||= vel !== 0;
        }
        spinner.rotation.y = -angle * DEG;

        busy = stepArm(dt) || busy;

        // the start/stop key goes down and comes back up
        const press = (now - keyAt) / 180;
        startBtn.position.y = .45 - (press < 1 ? .14 * Math.sin(Math.PI * press) : 0);
        busy ||= press < 1;
        busy = stepSwap(now) || busy;

        if (motion()) {
            tiltX = smooth(tiltX, tiltTX, dt, .35);
            tiltY = smooth(tiltY, tiltTY, dt, .35);
            busy ||= Math.abs(tiltX - tiltTX) > .0003 || Math.abs(tiltY - tiltTY) > .0003;
        }
        deckRoot.rotation.set(tiltX, tiltY, 0);

        M.led.emissiveIntensity = smooth(M.led.emissiveIntensity, playing ? 2.2 : 0, dt, .2);
        busy ||= Math.abs(M.led.emissiveIntensity - (playing ? 2.2 : 0)) > .01;

        if (visible) renderer.render(scene, camera);
        if (busy || needsFrame) { needsFrame = false; rafId = requestAnimationFrame(tick); }
    }
    let needsFrame = false;
    function wake() {
        needsFrame = true;
        if (rafId) return;
        last = performance.now();
        rafId = requestAnimationFrame(tick);
    }

    // ---- pointer: tap to play or pause, drag the record to scratch ---------------------

    const ray = new Raycaster();
    const ndc = new Vector2();
    const hitPlane = new Plane(new Vector3(0, 1, 0), 0);
    const hitPoint = new Vector3();
    const hitTargets = [recordFace, label, startBtn];

    function aim(e) {
        const r = canvas.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
    }
    // where the pointer is on the record, as an angle round the spindle
    function recordAngle(e) {
        aim(e);
        deckRoot.updateMatrixWorld();
        const top = new Vector3(C.x, RECORD_TOP, C.z).applyMatrix4(deckRoot.matrixWorld);
        const up = new Vector3(0, 1, 0).applyQuaternion(deckRoot.quaternion);
        hitPlane.setFromNormalAndCoplanarPoint(up, top);
        if (!ray.ray.intersectPlane(hitPlane, hitPoint)) return null;
        const p = deckRoot.worldToLocal(hitPoint.clone());
        return { a: Math.atan2(p.z - C.z, p.x - C.x) / DEG, r: Math.hypot(p.x - C.x, p.z - C.z) };
    }
    function hitAt(e) {
        aim(e);
        const hit = ray.intersectObjects(hitTargets, false)[0];
        if (!hit) return null;
        if (hit.object === startBtn) return 'button';
        return 'record';
    }

    canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const what = hitAt(e);
        if (!what) return;
        if (what === 'button') {
            keyAt = performance.now();
            opts.onSound?.('key');
            opts.onToggle?.();
            wake();
            return;
        }
        if (swap) return;
        const p = recordAngle(e);
        if (!p || p.r > RECORD.r) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        scratch = { a: p.a, t: performance.now(), vel, moved: 0 };
        canvas.style.cursor = 'grabbing';
        opts.onScratchStart?.();
        wake();
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!scratch) {
            if (e.pointerType === 'mouse') {
                const what = hitAt(e);
                canvas.style.cursor = what === 'record' ? 'grab' : what === 'button' ? 'pointer' : '';
            }
            return;
        }
        const p = recordAngle(e);
        if (!p) return;
        const now = performance.now();
        const dt = Math.max(.004, (now - scratch.t) / 1000);
        const d = wrapDeg(p.a - scratch.a);
        scratch.a = p.a;
        scratch.t = now;
        if (p.r < 1.5) return; // too close to the spindle to tell which way it turned
        scratch.moved += Math.abs(d);
        angle = (angle + d + 360) % 360;
        scratch.vel += (d / dt - scratch.vel) * .4;
        wake();
    });
    function endScratch() {
        if (!scratch) return;
        const s = scratch;
        scratch = null;
        canvas.style.cursor = 'grab';
        opts.onScratchEnd?.();
        if (s.moved < 3) { opts.onToggle?.(); return; } // a tap plays or pauses
        vel = s.vel; // a flick keeps it turning, then the motor takes over
        wake();
    }
    canvas.addEventListener('pointerup', endScratch);
    canvas.addEventListener('pointercancel', endScratch);
    canvas.addEventListener('lostpointercapture', endScratch);

    // the whole deck leans a little towards the pointer
    addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse' || !motion()) return;
        tiltTY = ((e.clientX / innerWidth) - .5) * .07;
        tiltTX = ((e.clientY / innerHeight) - .5) * .05;
        wake();
    }, { passive: true });

    new ResizeObserver(frame).observe(host);
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) wake(); }).observe(host);
    document.fonts?.ready.then(() => { paintDecals(); wake(); });

    // ---- theme ------------------------------------------------------------------------

    const decalInk = { soft: '#8f939a', strong: '#5c5f66' };
    function paintDecals() { decals.forEach((d) => d.userData.paint(decalInk)); }
    function setTheme(c) {
        if (!c) return;
        const set = (m, v) => { if (v) m.color.set(v); };
        set(M.body, c.body);
        set(M.felt, c.mat);
        set(M.trim, c.trim);
        set(M.accent, c.accent);
        if (c.accent) M.led.emissive.set(c.accent);
        M.felt.sheenColor.set(c.mat || '#555').offsetHSL(0, 0, .15);
        scene.environmentIntensity = c.dark ? .55 : .95;
        key.intensity = c.dark ? 1.6 : 2.1;
        floorShadow.material.opacity = c.dark ? .6 : .3;
        if (c.ink) decalInk.soft = c.ink;
        if (c.inkStrong) decalInk.strong = c.inkStrong;
        if (Number.isFinite(c.metal)) M.body.metalness = c.metal;
        if (Number.isFinite(c.rough)) M.body.roughness = c.rough;
        paintDecals();
        wake();
    }

    setTheme(opts.colors);
    paintLabel(null, null);
    frame();

    // ---- what the page uses ---------------------------------------------------------------

    return {
        setTrack(t, animate) {
            if (!animate || !motion()) {
                printLabel(t).then(wake);
                return;
            }
            const job = { stage: 'arm', t0: performance.now(), ready: false };
            swap = job;
            const minOut = new Promise((ok) => setTimeout(ok, 380));
            Promise.race([Promise.all([printLabel(t), minOut]), new Promise((ok) => setTimeout(ok, 2500))])
                .then(() => { if (swap === job) job.ready = true; wake(); });
            wake();
        },
        setPlaying(p) {
            playing = !!p;
            wake();
        },
        setProgress(p) {
            if (!Number.isFinite(p)) return;
            progress = p;
            wake();
        },
        setTheme,
        setInfo({ no, last } = {}) {
            if (no !== undefined) info.no = String(no);
            if (last !== undefined) info.last = String(last);
            paintDecals();
            wake();
        },
    };
}
