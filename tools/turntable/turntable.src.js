// The 3D record player on stole.cc.
//
// Source for ../../turntable.js. Rebuild after editing:
//     cd tools/turntable && npm install && npm run build
//
// Units are centimetres, y up, the plinth's top at y = 0 and the viewer towards +z.
// The page drives it through the object createTurntable() returns; it calls back when the
// record or the start key is tapped. Every movement is a keyframed tween (fixed duration,
// easing curve), and it only renders while something moves.

import {
    WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Color, Vector2, Vector3, Plane, Raycaster,
    MeshPhysicalMaterial, MeshStandardMaterial, MeshBasicMaterial,
    CylinderGeometry, CircleGeometry, PlaneGeometry, SphereGeometry, ExtrudeGeometry, LatheGeometry, TubeGeometry, Shape,
    CatmullRomCurve3,
    DirectionalLight, PMREMGenerator, CanvasTexture, DataTexture, Euler,
    SRGBColorSpace, NeutralToneMapping, PCFShadowMap, RGBAFormat, LinearFilter, LinearMipmapLinearFilter,
    RepeatWrapping, BackSide,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

const SPIN = 200;              // deg/s: 33⅓ rpm
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// layout
const PLINTH = { w: 46, d: 35, h: 4.2, r: 2.4, bevel: .45 };
const C = new Vector3(-6, 0, .3);       // platter centre
const PLATTER = { r: 15.9, y0: .25, h: 1.7 };
const MAT_TOP = PLATTER.y0 + PLATTER.h + .2;
const RECORD = { r: 15, h: .2 };
const RECORD_TOP = MAT_TOP + RECORD.h;
const GROOVES = { lead: 14.6, start: 14.45, end: 6.5, runout: 6.1 };
const PIVOT = new Vector3(15.6, 0, -10.2); // tone arm
const ARM = { len: 22.8, y: RECORD_TOP + 1.5, lift: -.055, down: 0 };

// easing curves for the keyframes
const EASE = {
    inOut: (x) => (x < .5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
    out: (x) => 1 - (1 - x) ** 3,
    outQuint: (x) => 1 - (1 - x) ** 5,
    in: (x) => x ** 3,
    inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
};
const smooth = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// how far the deck turns when dragged (radians)
const TURN = { yaw: .42, tiltUp: .16, tiltDown: -.1 };

export function createTurntable(host, opts) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', 'Record player. Tap the record or the start key to play or pause, drag to turn it.');
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
        arm: new MeshPhysicalMaterial({ color: 0x26282c, roughness: .32, metalness: .55, clearcoat: .4, clearcoatRoughness: .25 }),
        slot: new MeshStandardMaterial({ color: 0xb9babd, roughness: .6 }),
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
    // a picture disc: the cover printed across the whole record, under clear, grooved vinyl
    const DISC_PX = 2048;
    const discCanvas = document.createElement('canvas');
    discCanvas.width = discCanvas.height = DISC_PX;
    const discTex = new CanvasTexture(discCanvas);
    discTex.colorSpace = SRGBColorSpace;
    discTex.anisotropy = 8;
    const vinylTop = new MeshPhysicalMaterial({
        color: 0xffffff, map: discTex, roughness: .62, roughnessMap: roughTex, metalness: 0,
        anisotropy: .7, anisotropyMap: anisoTex,
        clearcoat: .55, clearcoatRoughness: .18, specularIntensity: .8,
    });

    const record = new Group();
    record.position.y = MAT_TOP;
    spinner.add(record);
    const recordFace = new Mesh(new CircleGeometry(RECORD.r, 256), vinylTop);
    recordFace.rotation.x = -Math.PI / 2;
    recordFace.position.y = RECORD.h;
    recordFace.receiveShadow = true;
    record.add(recordFace);
    const recordEdge = new Mesh(new CylinderGeometry(RECORD.r, RECORD.r, RECORD.h, 160, 1, true), M.vinylEdge);
    recordEdge.position.y = RECORD.h / 2;
    recordEdge.castShadow = true;
    record.add(recordEdge);
    const recordMats = [vinylTop, M.vinylEdge];

    // ---- tone arm: slim and turned, in one satin finish, the cartridge the only colour ----------

    // a cylinder with rounded edges, so the parts look turned rather than cut
    function turned(r, h, edge, mat, seg = 48) {
        const pts = [new Vector2(0, 0)];
        for (let i = 0; i <= 6; i++) {
            const a = (Math.PI / 2) * (i / 6);
            pts.push(new Vector2(r - edge + Math.sin(a) * edge, edge - Math.cos(a) * edge));
        }
        for (let i = 0; i <= 6; i++) {
            const a = (Math.PI / 2) * (i / 6);
            pts.push(new Vector2(r - edge + Math.cos(a) * edge, h - edge + Math.sin(a) * edge));
        }
        pts.push(new Vector2(0, h));
        const m = new Mesh(new LatheGeometry(pts, seg), mat);
        m.castShadow = true;
        return m;
    }

    const armBase = new Group();
    armBase.position.copy(PIVOT);
    deckRoot.add(armBase);
    const plate = turned(2.5, .28, .12, M.trim, 64);
    plate.receiveShadow = true;
    armBase.add(plate);
    const column = turned(.72, ARM.y - .28 + .5, .3, M.arm);
    column.position.y = .28;
    armBase.add(column);

    const armYaw = new Group();      // swings across the record
    armYaw.position.y = ARM.y;
    armBase.add(armYaw);
    const armPitch = new Group();    // lifts and lowers
    armYaw.add(armPitch);

    // the bearing: a short, rounded axle across the arm
    const hub = turned(.5, 1.6, .22, M.arm, 32);
    hub.rotation.z = Math.PI / 2;
    hub.position.x = .8;
    armPitch.add(hub);
    // the tube tapers towards the headshell
    const tubeEnd = ARM.len - 2.5;
    const tube = new Mesh(new CylinderGeometry(.16, .23, tubeEnd - .4, 24), M.arm);
    tube.rotation.x = Math.PI / 2;
    tube.position.z = (tubeEnd + .4) / 2;
    tube.castShadow = true;
    armPitch.add(tube);
    const tubeCap = new Mesh(new SphereGeometry(.16, 16, 12), M.arm);
    tubeCap.position.z = tubeEnd;
    armPitch.add(tubeCap);
    const stub = new Mesh(new CylinderGeometry(.18, .18, 2.8, 16), M.arm);
    stub.rotation.x = Math.PI / 2;
    stub.position.z = -1.6;
    armPitch.add(stub);
    const weight = turned(1.02, 2.1, .4, M.arm);
    weight.rotation.x = -Math.PI / 2;
    weight.position.z = -2.7;
    armPitch.add(weight);
    const weightRing = new Mesh(new CylinderGeometry(1.03, 1.03, .07, 48), M.trim);
    weightRing.rotation.x = Math.PI / 2;
    weightRing.position.z = -2.95;
    armPitch.add(weightRing);

    // headshell: a tapered plate, turned in by the offset angle so the stylus sits along the groove
    const head = new Group();
    head.position.z = ARM.len;
    head.rotation.y = -22 * DEG;
    armPitch.add(head);
    const shellShape = new Shape();
    shellShape.moveTo(-.55, -.75);
    shellShape.lineTo(.55, -.75);
    shellShape.quadraticCurveTo(.8, -.75, .78, -.5);
    shellShape.lineTo(.24, 2.55);
    shellShape.absarc(0, 2.55, .24, 0, Math.PI, false);
    shellShape.lineTo(-.78, -.5);
    shellShape.quadraticCurveTo(-.8, -.75, -.55, -.75);
    const shellGeo = new ExtrudeGeometry(shellShape, { depth: .12, bevelEnabled: true, bevelThickness: .04, bevelSize: .04, bevelSegments: 3, curveSegments: 12 });
    shellGeo.rotateX(-Math.PI / 2);
    const shell = new Mesh(shellGeo, M.arm);
    shell.position.y = -.12;
    shell.castShadow = true;
    head.add(shell);
    const cart = slab(1.0, 1.6, 1.0, .22, .08, M.accent);
    cart.position.set(0, -.2, -.1);
    head.add(cart);
    const stylus = new Mesh(new CylinderGeometry(.06, .015, .3, 8), M.metal);
    stylus.position.set(0, -1.35, .45);
    head.add(stylus);
    // a thin finger lift, curving up and out from the side of the headshell
    const lift = new Mesh(new TubeGeometry(new CatmullRomCurve3([
        new Vector3(.55, -.04, .1), new Vector3(1.05, .02, .15), new Vector3(1.4, .32, .2),
    ]), 16, .055, 8), M.arm);
    lift.castShadow = true;
    head.add(lift);

    // arm rest: a slim post with a small rounded cup the tube settles into
    const restZ = 15;
    const restPost = turned(.2, ARM.y - .6, .08, M.arm, 24);
    restPost.position.set(PIVOT.x, 0, PIVOT.z + restZ);
    deckRoot.add(restPost);
    const restCup = turned(.42, .32, .14, M.trim, 32);
    restCup.position.set(PIVOT.x, ARM.y - .58, PIVOT.z + restZ);
    deckRoot.add(restCup);

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
            g.font = `600 ${Math.round(h * .19)}px Inter, system-ui, sans-serif`;
            if ('letterSpacing' in g) g.letterSpacing = '1px';
            g.fillText(k.caption, w / 2, h * .27);
            g.fillStyle = ink.strong;
            if ('letterSpacing' in g) g.letterSpacing = '0px';
            let px = Math.round(h * .42);
            do g.font = `650 ${px}px Inter, system-ui, sans-serif`;
            while (g.measureText(k.value()).width > w * .88 && (px -= 2) > h * .2);
            g.fillText(k.value(), w / 2, h * .64);
        });
        d.position.set(k.x, .31, 16.3);
        deckRoot.add(d);
    }
    const led = new Mesh(new CylinderGeometry(.22, .22, .12, 16), M.led);
    led.position.set(-14.5, .06, 15.1);
    deckRoot.add(led);

    // pitch fader on the right: a fine slot and a small rounded knob
    const slot = slab(.36, 9.4, .04, .18, .01, M.slot);
    slot.position.set(19.6, .03, 6.4);
    deckRoot.add(slot);
    const knob = slab(1.5, .9, .5, .3, .1, M.arm);
    knob.position.set(19.6, .5, 6.4);
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
            g.font = `${weight} ${size * 1.5}px Inter, system-ui, sans-serif`;
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


    // ---- the picture disc: printed for each song from its cover ---------------------------

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

    // small print running along the rim, centred at the top
    function rimText(g, text, radius, px, color) {
        g.save();
        g.fillStyle = color;
        g.font = `600 ${px}px Inter, system-ui, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        const spacing = px * .18;
        const chars = [...text];
        const widths = chars.map((ch) => g.measureText(ch).width);
        const total = widths.reduce((a, w) => a + w + spacing, -spacing);
        let a = -total / radius / 2;
        g.translate(DISC_PX / 2, DISC_PX / 2);
        chars.forEach((ch, i) => {
            g.save();
            g.rotate(a + widths[i] / 2 / radius);
            g.translate(0, -radius);
            g.fillText(ch, 0, 0);
            g.restore();
            a += (widths[i] + spacing) / radius;
        });
        g.restore();
    }

    const cmPx = DISC_PX / 2 / RECORD.r; // canvas pixels per centimetre of record

    function paintDisc(g, t, img) {
        const N = DISC_PX;
        const R = N / 2;
        g.clearRect(0, 0, N, N);
        g.save();
        g.beginPath();
        g.arc(R, R, R, 0, TAU);
        g.clip();
        g.fillStyle = t?.bg || '#1b1b1d';
        g.fillRect(0, 0, N, N);
        if (img) g.drawImage(img, 0, 0, N, N);
        else if (t) {
            g.fillStyle = t.accent || t.fg || '#888';
            g.globalAlpha = .5;
            g.beginPath();
            g.arc(R, R, R * .62, 0, TAU);
            g.fill();
            g.globalAlpha = 1;
        }
        // grooves pressed over the print: fine rings, with the gaps between songs a little deeper
        for (let r = GROOVES.runout * cmPx; r < GROOVES.lead * cmPx; r += 3) {
            g.strokeStyle = (r / 3) % 2 < 1 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.035)';
            g.lineWidth = 1.4;
            g.beginPath();
            g.arc(R, R, r, 0, TAU);
            g.stroke();
        }
        for (const cm of [12.1, 9.4]) {
            g.strokeStyle = 'rgba(0,0,0,.22)';
            g.lineWidth = 3;
            g.beginPath();
            g.arc(R, R, cm * cmPx, 0, TAU);
            g.stroke();
        }
        // the clear rim, darker where the print stops
        const rim = g.createRadialGradient(R, R, GROOVES.lead * cmPx, R, R, R);
        rim.addColorStop(0, 'rgba(8,8,10,0)');
        rim.addColorStop(.35, 'rgba(8,8,10,.55)');
        rim.addColorStop(1, 'rgba(8,8,10,.85)');
        g.fillStyle = rim;
        g.fillRect(0, 0, N, N);
        g.restore();
        if (t) rimText(g, `${t.title}  ·  ${t.artist}  ·  33⅓`.toUpperCase(), (GROOVES.lead + .2) * cmPx, 22, 'rgba(255,255,255,.62)');
        // the centre: a thin pressing ring and the spindle hole
        g.strokeStyle = 'rgba(255,255,255,.22)';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(R, R, 1.1 * cmPx, 0, TAU);
        g.stroke();
        g.fillStyle = '#0c0c0d';
        g.beginPath();
        g.arc(R, R, .4 * cmPx, 0, TAU);
        g.fill();
    }

    // printed off to the side first, so the record on the deck doesn't change while it's still showing
    const nextCanvas = document.createElement('canvas');
    nextCanvas.width = nextCanvas.height = DISC_PX;
    let printTurn = 0;
    async function printDisc(t) {
        const turn = ++printTurn;
        const url = t?.art ? t.art.replace(/\/\d+x\d+bb\./, '/1200x1200bb.') : '';
        try { await document.fonts?.load('600 22px Inter'); } catch { /* system font then */ }
        const img = await loadCover(url);
        if (turn !== printTurn) return false;
        paintDisc(nextCanvas.getContext('2d'), t, img);
        return true;
    }
    function showPrinted() {
        const g = discCanvas.getContext('2d');
        g.clearRect(0, 0, DISC_PX, DISC_PX);
        g.drawImage(nextCanvas, 0, 0);
        discTex.needsUpdate = true;
    }

    // ---- camera: the whole deck in view, also when it's turned as far as it goes -----------

    const target = new Vector3(0, -1.6, 1.2);
    const view = new Vector3(Math.sin(.16) * Math.cos(.98), Math.sin(.98), Math.cos(.16) * Math.cos(.98)).normalize();
    const corners = [];
    for (const x of [-PLINTH.w / 2, PLINTH.w / 2]) for (const y of [-PLINTH.h - 1, ARM.y + 1]) for (const z of [-PLINTH.d / 2, PLINTH.d / 2]) corners.push(new Vector3(x, y, z));
    const poses = [];
    for (const yawP of [-TURN.yaw, 0, TURN.yaw]) for (const tiltP of [TURN.tiltDown, 0, TURN.tiltUp]) poses.push(new Euler(tiltP, yawP, 0));
    const framingPoints = poses.flatMap((e) => corners.map((c) => c.clone().applyEuler(e)));
    function frame() {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        let lo = 40, hi = 500;
        for (let i = 0; i < 24; i++) {
            const dist = (lo + hi) / 2;
            camera.position.copy(target).addScaledVector(view, dist);
            camera.lookAt(target);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld();
            const fits = framingPoints.every((c) => {
                const p = c.clone().project(camera);
                return Math.abs(p.x) < .98 && Math.abs(p.y) < .97;
            });
            if (fits) hi = dist; else lo = dist;
        }
        camera.position.copy(target).addScaledVector(view, hi);
        camera.lookAt(target);
        camera.updateProjectionMatrix();
        wake();
    }

    // ---- keyframes ---------------------------------------------------------------------
    // Every move is a tween: a fixed duration on an easing curve, chained into sequences, so it
    // lands exactly where it should, the same way every time.

    const motion = () => !opts.reduceMotion?.matches;
    const tweens = new Set();
    function tween(ms, ease, apply) {
        return new Promise((done) => {
            tweens.add({ t0: performance.now(), ms: motion() ? ms : 1, ease, apply, done });
            wake();
        });
    }
    function stepTweens(now) {
        for (const tw of tweens) {
            const k = Math.min(1, (now - tw.t0) / tw.ms);
            tw.apply(tw.ease(k), k);
            if (k >= 1) { tweens.delete(tw); tw.done(); }
        }
        return tweens.size > 0;
    }
    const lerp = (a, b, k) => a + (b - a) * k;

    // ---- state ------------------------------------------------------------------------

    let playing = false;
    let prog = { p: 0, at: performance.now(), dur: 30 };   // where the song is, and since when
    let angle = 0;          // record, degrees clockwise from above
    let vel = 0;            // deg/s
    let spin = { from: 0, to: 0, t0: 0, ms: 1 };
    let yaw = 0;
    let pitch = ARM.down;
    let armMode = 'rest';   // rest | moving | tracking
    let armIntent = 'rest'; // where the current sequence is taking it
    let armJob = 0;
    let swapping = false;
    let pendingTrack;       // a song picked while the record was still being changed
    let shownTrack = null;
    let turn = { yaw: 0, tilt: 0, yawT: 0, tiltT: 0 }; // how the deck is turned, and where it's headed
    let drag = null;
    let homeTimer = 0;
    let scrollTurn = false; // on phones the page turns the deck as it scrolls, so it stays put after a swipe
    let visible = true;
    let rafId = 0;
    let needsFrame = false;
    let last = performance.now();

    const progressNow = () => Math.min(1, prog.p + (playing && prog.dur ? (performance.now() - prog.at) / 1000 / prog.dur : 0));

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
    const grooveYaw = () => yawFor(GROOVES.start - (GROOVES.start - GROOVES.end) * progressNow());

    // ---- tone arm: lift, swing, lower --------------------------------------------------------

    // intent: 'groove' (lower onto the record), 'rest' (lie on the rest), 'park' (hover just off
    // the record's edge while the record is changed)
    const parkYaw = () => yawFor(RECORD.r + 1.2);
    async function armSequence(intent) {
        const job = ++armJob;
        armIntent = intent;
        armMode = 'moving';
        const live = () => job === armJob;
        const goal = intent === 'groove' ? grooveYaw : intent === 'park' ? parkYaw : () => 0;
        const p0 = pitch;
        if (Math.abs(pitch - ARM.lift) > .001) await tween(110, EASE.out, (k) => { pitch = lerp(p0, ARM.lift, k); });
        if (!live()) return;
        const from = yaw;
        await tween(160 + Math.abs(goal() - from) * 420, EASE.inOut, (k) => { yaw = lerp(from, goal(), k); });
        if (!live()) return;
        if (intent === 'park') { armMode = 'parked'; trace('arm parked'); return; }
        await tween(150, EASE.inOutSine, (k) => { pitch = lerp(ARM.lift, ARM.down, k); });
        if (!live()) return;
        armMode = intent === 'groove' ? 'tracking' : 'rest';
        trace(`arm ${armMode}`);
    }

    // decides where the arm belongs: on the groove while a song is on, otherwise on its rest
    function placeArm() {
        const want = swapping ? 'park' : playing || prog.p > .002 ? 'groove' : 'rest';
        if (want === armIntent && armMode !== 'tracking') return; // already on its way
        if (want === 'groove' && armMode === 'tracking') {
            if (Math.abs(grooveYaw() - yaw) > .04) armSequence('groove'); // a seek: lift it and move
            return;
        }
        if (want !== armIntent || armMode === 'tracking') armSequence(want);
    }

    // ---- the motor --------------------------------------------------------------------------

    function setMotor(on) {
        spin = { from: vel, to: on && motion() ? SPIN : 0, t0: performance.now(), ms: on ? 500 : 900 };
    }

    // ---- changing the record ------------------------------------------------------------------

    const setRecordOpacity = (o) => recordMats.forEach((m) => { m.opacity = o; });
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const trace = (what) => window.__ttTrace?.(what, performance.now());
    // starts the moment the song changes: the arm lifts and parks beside the record while the old
    // record lifts off and the new one drops on, then the arm goes back down
    async function changeRecord(t) {
        trace('change start');
        swapping = true;
        placeArm();
        let ready = false;
        const printed = printDisc(t).then((ok) => {
            ready = ok;
            if (ok && shownTrack === t && !swapping) showPrinted(); // the cover arrived after the record landed
            return ok;
        });
        recordMats.forEach((m) => { m.transparent = true; });
        await sleep(motion() ? 70 : 0); // the stylus clears the groove first
        await tween(240, EASE.in, (k) => {
            record.position.set(-6 * k, MAT_TOP + 2.5 * k, 0);
            setRecordOpacity(1 - k);
        });
        await Promise.race([printed, sleep(220)]);
        if (ready) showPrinted();
        else { paintDisc(discCanvas.getContext('2d'), t, null); discTex.needsUpdate = true; }
        shownTrack = t;
        // the arm heads back while the record settles: by then it's almost down
        let armSent = false;
        await tween(340, EASE.outQuint, (k, raw) => {
            record.position.set(5 * (1 - k), MAT_TOP + 2.5 * (1 - k), 0);
            setRecordOpacity(Math.min(1, k * 1.8));
            if (raw >= .45 && !armSent && !pendingTrack) { armSent = true; swapping = false; placeArm(); }
        });
        record.position.set(0, MAT_TOP, 0);
        trace(`record landed${ready ? '' : ' (cover still loading)'}`);
        recordMats.forEach((m) => { m.transparent = false; m.opacity = 1; });
        swapping = false;
        if (ready) showPrinted();
        if (pendingTrack && pendingTrack !== shownTrack) {
            const next = pendingTrack;
            pendingTrack = undefined;
            changeRecord(next);
            return;
        }
        pendingTrack = undefined;
        placeArm();
    }

    // ---- frame loop ----------------------------------------------------------------------------

    function tick(now) {
        rafId = 0;
        const dt = Math.min(.064, Math.max(0, (now - last) / 1000));
        last = now;
        let busy = stepTweens(now);

        const k = Math.min(1, (now - spin.t0) / spin.ms);
        vel = lerp(spin.from, spin.to, EASE.out(k));
        angle = (angle + vel * dt) % 360;
        spinner.rotation.y = -angle * DEG;
        busy ||= vel !== 0;

        if (armMode === 'tracking') yaw = grooveYaw();
        armYaw.rotation.y = yaw;
        armPitch.rotation.x = pitch;

        // the deck follows the hand closely, and settles without overshooting
        turn.yaw = smooth(turn.yaw, turn.yawT, dt, .045);
        turn.tilt = smooth(turn.tilt, turn.tiltT, dt, .045);
        if (Math.abs(turn.yaw - turn.yawT) < 1e-4) turn.yaw = turn.yawT;
        if (Math.abs(turn.tilt - turn.tiltT) < 1e-4) turn.tilt = turn.tiltT;
        busy ||= turn.yaw !== turn.yawT || turn.tilt !== turn.tiltT;
        deckRoot.rotation.set(turn.tilt, turn.yaw, 0);

        const ledOn = playing ? 2.2 : 0;
        M.led.emissiveIntensity = smooth(M.led.emissiveIntensity, ledOn, dt, .15);
        busy ||= Math.abs(M.led.emissiveIntensity - ledOn) > .01;

        if (visible) renderer.render(scene, camera);
        if (busy || needsFrame) { needsFrame = false; rafId = requestAnimationFrame(tick); }
    }
    function wake() {
        needsFrame = true;
        if (rafId) return;
        last = performance.now();
        rafId = requestAnimationFrame(tick);
    }

    // ---- pointer: drag to turn the deck, tap the record or the key to play or pause ------------

    const ray = new Raycaster();
    const ndc = new Vector2();
    function hitAt(e) {
        const r = canvas.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        const hit = ray.intersectObjects([recordFace, startBtn, plinth, platter], false)[0];
        if (!hit) return null;
        if (hit.object === startBtn) return 'key';
        if (hit.object === recordFace || hit.object === platter) return 'record';
        return 'deck';
    }

    function pressKey() {
        const y0 = .45;
        tween(70, EASE.out, (k) => { startBtn.position.y = y0 - .14 * k; })
            .then(() => tween(200, EASE.outQuint, (k) => { startBtn.position.y = y0 - .14 * (1 - k); }));
    }

    function goHomeLater() {
        clearTimeout(homeTimer);
        if (scrollTurn) return;
        homeTimer = setTimeout(() => {
            if (drag) return;
            const from = { y: turn.yawT, t: turn.tiltT };
            tween(700, EASE.inOut, (k) => {
                turn.yawT = lerp(from.y, 0, k);
                turn.tiltT = lerp(from.t, 0, k);
            });
        }, 1800);
    }

    canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const what = hitAt(e) || 'none'; // the empty space round the deck turns it too
        clearTimeout(homeTimer);
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: turn.yawT, tilt: turn.tiltT, moved: 0, what };
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!drag) {
            if (e.pointerType === 'mouse') {
                const what = hitAt(e);
                canvas.style.cursor = what === 'key' || what === 'record' ? 'pointer' : what ? 'grab' : '';
            }
            return;
        }
        if (e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
        if (drag.moved < 4) return;
        const w = canvas.clientWidth || 1;
        turn.yawT = clamp(drag.yaw + (dx / w) * 1.6, -TURN.yaw, TURN.yaw);
        turn.tiltT = clamp(drag.tilt + (dy / w) * 1.1, TURN.tiltDown, TURN.tiltUp);
        wake();
    });
    function endDrag(e) {
        if (!drag || (e && e.pointerId !== drag.id)) return;
        const d = drag;
        drag = null;
        canvas.style.cursor = '';
        if (d.moved < 4 && e?.type === 'pointerup') {
            if (d.what === 'key') { pressKey(); opts.onToggle?.(); }
            else if (d.what === 'record') opts.onToggle?.();
        }
        goHomeLater();
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    new ResizeObserver(frame).observe(host);
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) wake(); }).observe(host);
    document.fonts?.ready.then(() => { paintDecals(); wake(); });

    // ---- theme: colours glide to the new ones --------------------------------------------------

    const decalInk = { soft: '#8f939a', strong: '#5c5f66' };
    function paintDecals() { decals.forEach((d) => d.userData.paint(decalInk)); }
    let themeJob = 0;
    function setTheme(c, animate = true) {
        if (!c) return;
        const job = ++themeJob;
        const slotColor = c.trim ? new Color(c.trim).offsetHSL(0, 0, c.dark ? -.06 : -.12).getStyle() : null;
        const pairs = [[M.body, c.body], [M.felt, c.mat], [M.trim, c.trim], [M.accent, c.accent], [M.arm, c.arm], [M.slot, slotColor]]
            .filter(([, v]) => v)
            .map(([m, v]) => [m, m.color.clone(), new Color(v)]);
        const metal = [M.body.metalness, Number.isFinite(c.metal) ? c.metal : M.body.metalness];
        const rough = [M.body.roughness, Number.isFinite(c.rough) ? c.rough : M.body.roughness];
        const env = [scene.environmentIntensity, c.dark ? .55 : .95];
        const keyI = [key.intensity, c.dark ? 1.6 : 2.1];
        const shadow = [floorShadow.material.opacity, c.dark ? .6 : .3];
        if (c.accent) M.led.emissive.set(c.accent);
        if (c.ink) decalInk.soft = c.ink;
        if (c.inkStrong) decalInk.strong = c.inkStrong;
        paintDecals();
        tween(animate ? 300 : 1, EASE.inOut, (k) => {
            if (job !== themeJob) return;
            pairs.forEach(([m, from, to]) => m.color.lerpColors(from, to, k));
            M.felt.sheenColor.copy(M.felt.color).offsetHSL(0, 0, .15);
            M.body.metalness = lerp(metal[0], metal[1], k);
            M.body.roughness = lerp(rough[0], rough[1], k);
            scene.environmentIntensity = lerp(env[0], env[1], k);
            key.intensity = lerp(keyI[0], keyI[1], k);
            floorShadow.material.opacity = lerp(shadow[0], shadow[1], k);
        });
    }

    setTheme(opts.colors, false);
    paintDisc(discCanvas.getContext('2d'), null, null);
    discTex.needsUpdate = true;
    frame();

    // the deck turns in once, the first time it's shown
    if (motion()) {
        turn.yaw = turn.yawT = -.32;
        turn.tilt = turn.tiltT = .08;
        tween(900, EASE.outQuint, (k) => { turn.yawT = lerp(-.32, 0, k); turn.tiltT = lerp(.08, 0, k); });
    }

    // ---- what the page uses ---------------------------------------------------------------

    return {
        setTrack(t, animate) {
            if (swapping) { pendingTrack = t; return; }
            if (!animate || !motion() || !shownTrack) {
                printDisc(t).then((ok) => { if (ok) { showPrinted(); shownTrack = t; wake(); } });
                return;
            }
            changeRecord(t);
        },
        setPlaying(p) {
            p = !!p;
            if (p === playing) return;
            prog = { ...prog, p: progressNow(), at: performance.now() };
            playing = p;
            setMotor(p);
            placeArm();
            wake();
        },
        setProgress(p, durationSec) {
            if (!Number.isFinite(p)) return;
            prog = { p, at: performance.now(), dur: durationSec > 0 ? durationSec : prog.dur };
            placeArm();
            wake();
        },
        setInfo({ no, last } = {}) {
            if (no !== undefined) info.no = String(no);
            if (last !== undefined) info.last = String(last);
            paintDecals();
            wake();
        },
        setTheme,
        // turn the deck from outside (yaw, tilt in radians); null hands it back to the pointer
        setTurn(yaw, tilt) {
            if (yaw === null) {
                scrollTurn = false;
                goHomeLater();
                return;
            }
            scrollTurn = true;
            if (drag) return;
            turn.yawT = clamp(yaw, -TURN.yaw, TURN.yaw);
            turn.tiltT = clamp(tilt, TURN.tiltDown, TURN.tiltUp);
            wake();
        },
        preload(t) {
            if (t?.art) loadCover(t.art.replace(/\/\d+x\d+bb\./, '/1200x1200bb.'));
        },
    };
}

// ---- the logo: a small rounded glass box ----------------------------------------------------
// stole.cc on its front; on hover it rolls up a quarter turn to show its underside, which
// carries the song that's on. Real rounded geometry, lit like the deck, rendered only while
// it moves.

const MARK_BODY = typeof Path2D === 'function' ? new Path2D('M7 3h8.5v13.5H29V25a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z') : null;

export function createLogoBox(host, opts = {}) {
    const canvas = document.createElement('canvas');
    canvas.className = 'logo-canvas';
    host.appendChild(canvas);
    let renderer;
    try {
        renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (err) {
        canvas.remove();
        throw err;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2.5));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    renderer.setClearColor(0x000000, 0);

    const scene = new Scene();
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
    pmrem.dispose();
    const keyLight = new DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(-2, 6, 5);
    scene.add(keyLight);

    // box proportions follow the CSS box (--w × --h); depth equals height, so the underside is as tall as the front
    const BW = 3.75, BH = 1, BD = 1;
    const box = new Group();
    scene.add(box);
    const glass = new MeshPhysicalMaterial({
        color: 0xffffff, transparent: true, opacity: .62, roughness: .14, metalness: 0,
        clearcoat: 1, clearcoatRoughness: .08, iridescence: .35, iridescenceIOR: 1.3,
        specularIntensity: 1, envMapIntensity: 1.2,
    });
    const shell = new Mesh(new RoundedBoxGeometry(BW, BH, BD, 6, .26), glass);
    box.add(shell);
    // a fine darker rim round the edges, as thick glass shows where it turns away
    const rimMat = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .1, side: BackSide, depthWrite: false });
    const rimShell = new Mesh(new RoundedBoxGeometry(BW + .05, BH + .05, BD + .05, 6, .285), rimMat);
    box.add(rimShell);
    // the reflection: a bright streak along the top edge and a soft sheen across the face, printed
    // on a sheet just in front of the front and of the underside, so it turns with the box
    const sheenTex = (() => {
        const cv = document.createElement('canvas');
        cv.width = 1024;
        cv.height = 280;
        const g = cv.getContext('2d');
        const along = g.createLinearGradient(0, 0, cv.width, 0); // fades out towards both ends
        along.addColorStop(0, 'rgba(255,255,255,0)');
        along.addColorStop(.12, 'rgba(255,255,255,1)');
        along.addColorStop(.75, 'rgba(255,255,255,.85)');
        along.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = along;
        g.filter = 'blur(3px)';
        g.fillRect(40, 30, cv.width - 80, 7);
        g.fillRect(40, 30, cv.width - 80, 7); // twice, so the line itself is bright
        g.filter = 'blur(14px)';
        g.globalAlpha = .35;
        g.fillRect(60, 40, cv.width - 120, 46);
        // below the bright edge, the darker band of the room it mirrors: on light glass the
        // reflection reads through this contrast
        const band = g.createLinearGradient(0, 0, cv.width, 0);
        band.addColorStop(0, 'rgba(25,32,45,0)');
        band.addColorStop(.2, 'rgba(25,32,45,1)');
        band.addColorStop(.8, 'rgba(25,32,45,1)');
        band.addColorStop(1, 'rgba(25,32,45,0)');
        g.fillStyle = band;
        g.filter = 'blur(9px)';
        g.globalAlpha = .13;
        g.fillRect(70, 64, cv.width - 140, 26);
        g.filter = 'none';
        g.globalAlpha = 1;
        const tex = new CanvasTexture(cv);
        tex.colorSpace = SRGBColorSpace;
        return tex;
    })();
    const sheenH = (BW - .1) * 280 / 1024;
    function sheenSheet(onUnderside) {
        const mat = new MeshBasicMaterial({ map: sheenTex, transparent: true, depthWrite: false, opacity: .9 });
        const m = new Mesh(new PlaneGeometry(BW - .1, sheenH), mat);
        if (onUnderside) {
            // the underside's top edge, once it has rolled up, is the one along the front
            m.rotation.x = Math.PI / 2;
            m.position.set(0, -BH / 2 - .006, BD / 2 - sheenH / 2 + .02);
        } else m.position.set(0, BH / 2 - sheenH / 2 + .02, BD / 2 + .006);
        box.add(m);
        return mat;
    }
    const sheen = sheenSheet(false);
    const sheenUnder = sheenSheet(true);

    // the two printed faces
    const PX = 160; // canvas pixels per unit
    function face(normalY) {
        const cv = document.createElement('canvas');
        cv.width = Math.round((BW - .1) * PX);
        cv.height = Math.round((BH - .1) * PX);
        const tex = new CanvasTexture(cv);
        tex.colorSpace = SRGBColorSpace;
        tex.anisotropy = 4;
        const m = new Mesh(new PlaneGeometry(BW - .1, BH - .1), new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
        if (normalY) { m.rotation.x = Math.PI / 2; m.position.y = -BH / 2 - .003; } else m.position.z = BD / 2 + .003;
        box.add(m);
        return { cv, tex, g: cv.getContext('2d'), mat: m.material };
    }
    const front = face(0);
    const under = face(-1);

    let colors = { ink: '#111214', dot: '#c98262', tld: '#98a2ad', glass: '#ffffff', glassA: .62, dark: false };
    let song = null;
    let songImg = null;

    function paintFront() {
        const { g, cv, tex } = front;
        const h = cv.height;
        g.clearRect(0, 0, cv.width, cv.height);
        const fs = Math.round(h * .42);
        g.font = `600 ${fs}px Inter, system-ui, sans-serif`;
        g.textBaseline = 'middle';
        const parts = [['stole', colors.ink], ['.', colors.dot], ['cc', colors.tld]];
        const disc = h * .5;
        const gap = h * .25;
        const textW = parts.reduce((w, [t]) => w + g.measureText(t).width, 0);
        let x = (cv.width - (disc + gap + textW)) / 2;
        const cy = h / 2;
        // the mark: a square with a corner taken, the piece floating off beside it (32-unit grid, as icon.svg)
        g.save();
        g.translate(x, cy - disc / 2);
        g.scale(disc / 32, disc / 32);
        g.fillStyle = colors.ink;
        g.fill(MARK_BODY);
        g.translate(24, 8);
        g.rotate(14 * DEG);
        g.fillStyle = colors.dot;
        g.beginPath();
        g.roundRect(-4.5, -4.5, 9, 9, 2.2);
        g.fill();
        g.restore();
        x += disc + gap;
        for (const [t, c] of parts) {
            g.fillStyle = c;
            g.fillText(t, x, cy + fs * .04);
            x += g.measureText(t).width;
        }
        tex.needsUpdate = true;
    }

    function paintUnder() {
        const { g, cv, tex } = under;
        const h = cv.height;
        g.clearRect(0, 0, cv.width, cv.height);
        const pad = h * .26;
        let x = pad;
        const art = h * .58;
        if (songImg) {
            g.save();
            g.beginPath();
            g.roundRect(x, (h - art) / 2, art, art, art * .22);
            g.clip();
            g.drawImage(songImg, x, (h - art) / 2, art, art);
            g.restore();
            x += art + h * .2;
        }
        const fs = Math.round(h * .34);
        g.font = `600 ${fs}px Inter, system-ui, sans-serif`;
        g.textBaseline = 'middle';
        g.fillStyle = colors.ink;
        let title = song?.title || 'stole.cc';
        const room = cv.width - x - pad;
        if (g.measureText(title).width > room) {
            while (title.length > 1 && g.measureText(`${title}…`).width > room) title = title.slice(0, -1);
            title = `${title.trimEnd()}…`;
        }
        g.fillText(title, x, h / 2 + fs * .04);
        tex.needsUpdate = true;
    }

    // camera: a touch above, framed so the box fills most of the canvas width
    const camera = new PerspectiveCamera(30, 1, .1, 100);
    function frame() {
        const w = canvas.clientWidth || 1;
        const h = canvas.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        // the box stands in for the CSS box it's drawn over (host), so it's sized to match it
        // (a little smaller, since it's seen at an angle and its near corners come forward)
        const visibleW = (BW * w) / ((host.clientWidth || w * .8) * .9);
        const dist = visibleW / camera.aspect / 2 / Math.tan((camera.fov * DEG) / 2);
        camera.position.set(0, dist * .3, dist);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        render();
    }

    let rafId = 0;
    let anim = null;
    let roll = 0;                 // 0 = front, 1 = rolled up to the underside
    let sheenBase = .9;
    const REST = { x: .16, y: -.2 }; // a three-quarter view: some of the top and the right end
    const lean = { x: 0, y: 0, tx: 0, ty: 0 };
    const hand = { x: 0, y: 0, tx: 0, ty: 0 }; // how far it has been turned by dragging
    let drag = null;
    let home = null;      // gliding back after a drag
    let homeTimer = 0;
    let last = performance.now();
    const motion = () => !opts.reduceMotion?.matches;
    // a soft overshoot at the end, like something with a little weight settling
    const easeOutBack = (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
    function render() {
        const rot = REST.x + lean.x + hand.x - (Math.PI / 2) * roll;
        box.rotation.set(rot, REST.y * (1 - roll * .35) + lean.y + hand.y, 0);
        // each printed side fades as it turns away, so no sliver of it shows along the edge
        // (seen from a little above, so a side that has rolled to the top still faces the camera a bit)
        front.mat.opacity = clamp(Math.cos(rot) * 2.2 - .75, 0, 1);
        sheen.opacity = sheenBase * clamp(Math.cos(rot) * 2 - .6, 0, 1);
        sheenUnder.opacity = sheenBase * clamp(-Math.sin(rot) * 2 - .6, 0, 1);
        under.mat.opacity = clamp(-Math.sin(rot) * 2.2 - .75, 0, 1);
        renderer.render(scene, camera);
    }
    function loop(now) {
        rafId = 0;
        const dt = Math.min(.064, (now - last) / 1000);
        last = now;
        if (anim) {
            const k = Math.min(1, (now - anim.t0) / anim.ms);
            roll = anim.from + (anim.to - anim.from) * easeOutBack(k);
            if (k >= 1) anim = null;
        }
        if (home) {
            const k = Math.min(1, (now - home.t0) / home.ms);
            const e = k < .5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
            hand.tx = home.x * (1 - e);
            hand.ty = home.y * (1 - e);
            if (k >= 1) home = null;
        }
        const f = 1 - Math.exp(-dt / .12);
        lean.x += (lean.tx - lean.x) * f;
        lean.y += (lean.ty - lean.y) * f;
        // the hand is followed closely, like the deck
        const fh = 1 - Math.exp(-dt / .045);
        hand.x += (hand.tx - hand.x) * fh;
        hand.y += (hand.ty - hand.y) * fh;
        const settled = Math.abs(lean.tx - lean.x) < 1e-4 && Math.abs(lean.ty - lean.y) < 1e-4
            && Math.abs(hand.tx - hand.x) < 1e-4 && Math.abs(hand.ty - hand.y) < 1e-4;
        render();
        if (anim || home || !settled) wake();
    }
    function wake() {
        if (rafId) return;
        last = performance.now();
        rafId = requestAnimationFrame(loop);
    }
    // it leans a little towards the pointer, wherever it is on the page
    addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse' || !motion()) return;
        const r = host.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / innerWidth;
        const dy = (e.clientY - (r.top + r.height / 2)) / innerHeight;
        lean.ty = clamp(dx * .9, -.3, .45);
        lean.tx = clamp(dy * .5, -.12, .2);
        wake();
    }, { passive: true });
    function flip(up) {
        anim = { from: roll, to: up ? 1 : 0, t0: performance.now(), ms: motion() ? 520 : 1 };
        wake();
    }

    // drag to turn it a little, like the deck; it holds a moment after letting go, then glides back
    const grip = opts.grip || host;
    grip.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        clearTimeout(homeTimer);
        home = null;
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, hx: hand.tx, hy: hand.ty };
        grip.setPointerCapture(e.pointerId);
        grip.classList.add('is-grabbed');
    });
    grip.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const w = grip.clientWidth || 150;
        hand.ty = clamp(drag.hy + ((e.clientX - drag.x) / w) * .9, -.35, .35);
        hand.tx = clamp(drag.hx + ((e.clientY - drag.y) / w) * .9, -.2, .2);
        wake();
    });
    function letGo(e) {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        grip.classList.remove('is-grabbed');
        clearTimeout(homeTimer);
        homeTimer = setTimeout(() => {
            home = { x: hand.tx, y: hand.ty, t0: performance.now(), ms: motion() ? 700 : 1 };
            wake();
        }, 1800);
    }
    grip.addEventListener('pointerup', letGo);
    grip.addEventListener('pointercancel', letGo);

    function setTheme(c) {
        colors = { ...colors, ...c };
        glass.color.set(colors.glass);
        glass.opacity = colors.glassA;
        scene.environmentIntensity = colors.dark ? .6 : 1.35;
        rimMat.opacity = colors.dark ? .35 : .09;
        sheenBase = colors.dark ? .45 : .95;
        paintFront();
        paintUnder();
        render();
    }

    async function setSong(t) {
        song = t;
        songImg = null;
        paintUnder();
        render();
        if (!t?.art) return;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = t.art.replace(/\/\d+x\d+bb\./, '/120x120bb.');
        try { await img.decode(); } catch { return; }
        if (song !== t) return;
        songImg = img;
        paintUnder();
        render();
    }

    new ResizeObserver(frame).observe(host);
    document.fonts?.ready.then(() => { paintFront(); paintUnder(); render(); });
    setTheme(opts.colors || {});
    frame();
    return { flip, setTheme, setSong };
}
