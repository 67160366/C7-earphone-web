/*
 * 3D axes of the sensors for collect.html (ES module, needs http). No head model: each sensor is drawn
 * as its own x/y/z triad plus a small board, turned by its quaternion in the BNO world frame.
 *
 * World = ENU as the BNO085 rotation vector reports it by default: x = east, y = magnetic north, z = up.
 * The scene uses that frame directly (camera.up = +z), so nothing here swaps or flips an axis.
 * The accel arrow is drawn in the world frame (q · acc): at rest it should point straight up.
 */
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const SPLIT = { L: new THREE.Vector3(-1.75, 0, 0.9), C: new THREE.Vector3(0, -0.2, 0.9), R: new THREE.Vector3(1.75, 0, 0.9) };
const OVERLAY = new THREE.Vector3(0, 0, 0.9);
const G = 9.80665;

function cssColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    return {
        x: v('--sx', '#C2410C'), y: v('--sy', '#0F6E66'), z: v('--sz', '#5B4BB7'),
        ink: v('--ink', '#13221E'), ink2: v('--ink-2', '#4A5B56'), line: v('--line', '#CBD5D1'),
        lineStrong: v('--line-strong', '#9AABA5'), surface: v('--surface', '#FFFFFF'), accent: v('--accent', '#0F6E66'),
        font: v('--font', 'sans-serif'),
    };
}

/** Text as a camera-facing sprite. height = world units of one text line. */
function textSprite(text, color, font, height = 0.22, weight = 600) {
    const c = document.createElement('canvas');
    const px = 64, g0 = c.getContext('2d');
    g0.font = `${weight} ${px}px ${font}`;
    const w = Math.ceil(g0.measureText(text).width) + 24;
    c.width = w; c.height = px + 24;
    const g = c.getContext('2d');
    g.font = `${weight} ${px}px ${font}`;
    g.fillStyle = color; g.textBaseline = 'middle'; g.textAlign = 'center';
    g.fillText(text, w / 2, c.height / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.scale.set(height * w / c.height, height, 1);
    sprite.userData.text = text;
    return sprite;
}
function disposeSprite(s) { s.material.map.dispose(); s.material.dispose(); }

/** Solid arrow along +x of its own frame, length 1 (scale.x sets the length). */
function arrowMesh(color, radius = 0.028) {
    const grp = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.8, 12), mat);
    shaft.rotation.z = -Math.PI / 2; shaft.position.x = 0.4;
    const head = new THREE.Mesh(new THREE.ConeGeometry(radius * 2.6, 0.2, 16), mat);
    head.rotation.z = -Math.PI / 2; head.position.x = 0.9;
    grp.add(shaft, head);
    grp.userData.mat = mat;
    return grp;
}

export function createAxesView(canvas, { names = { L: 'หูซ้าย', R: 'หูขวา', C: 'ต้นคอ C7' } } = {}) {
    const stage = canvas.parentElement;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
    camera.up.set(0, 0, 1);
    camera.position.set(2.6, -6.4, 3.6);
    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 0, 0.75);
    controls.enableDamping = true; controls.enablePan = false;
    controls.minDistance = 3; controls.maxDistance = 14;
    controls.update();

    let colors = cssColors();
    const world = new THREE.Group(); scene.add(world);

    /* ---------- ground: grid on the horizontal plane + compass words ---------- */
    let grid = null;
    const compass = [];
    function buildGround() {
        if (grid) { world.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
        grid = new THREE.GridHelper(6, 12, colors.lineStrong, colors.line);
        grid.rotation.x = Math.PI / 2; // GridHelper lies on XZ; turn it onto the ENU horizontal plane (XY)
        world.add(grid);
        compass.forEach((s) => { world.remove(s); disposeSprite(s); });
        compass.length = 0;
        const words = [['เหนือ (y+)', 0, 3.35], ['ใต้', 0, -3.35], ['ตะวันออก (x+)', 3.55, 0], ['ตะวันตก', -3.55, 0]];
        for (const [t, x, y] of words) {
            const s = textSprite(t, colors.ink2, colors.font, 0.24, 500);
            s.position.set(x, y, 0.02);
            world.add(s); compass.push(s);
        }
        const up = textSprite('ขึ้น (z+)', colors.ink2, colors.font, 0.24, 500);
        up.position.set(-2.9, 2.9, 2.35); world.add(up); compass.push(up);
        upLine.position.set(-2.9, 2.9, 0);
    }
    const upLine = arrowMesh(0x888888, 0.014);
    upLine.rotation.y = -Math.PI / 2; upLine.scale.setScalar(2.1);
    world.add(upLine);

    /* ---------- one sensor ---------- */
    function makeSensor(key) {
        const anchor = new THREE.Group();       // position only, never rotates (world frame)
        const body = new THREE.Group();         // turned by the sensor quaternion
        anchor.add(body); world.add(anchor);
        const arrows = ['x', 'y', 'z'].map((k, i) => {
            const a = arrowMesh(colors[k]);
            if (i === 1) a.rotation.z = Math.PI / 2;        // +x -> +y
            if (i === 2) a.rotation.y = -Math.PI / 2;       // +x -> +z
            a.scale.setScalar(0.95);
            body.add(a);
            return a;
        });
        const boardMat = new THREE.MeshBasicMaterial({ color: colors.surface, transparent: true, opacity: 0.55, depthWrite: false });
        const board = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.42, 0.06), boardMat);
        const edgeMat = new THREE.LineBasicMaterial({ color: colors.ink2, transparent: true });
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(board.geometry), edgeMat);
        body.add(board, edges);
        const acc = arrowMesh(colors.ink, 0.02);
        anchor.add(acc);
        const s = { key, anchor, body, arrows, board, edges, boardMat, edgeMat, acc, labels: [], name: null, visible: true, ghost: false };
        buildLabels(s);
        return s;
    }
    function buildLabels(s) {
        s.labels.forEach((l) => { l.parent.remove(l); disposeSprite(l); });
        s.labels = ['x', 'y', 'z'].map((k, i) => {
            const l = textSprite(k, colors[k], colors.font, 0.22, 700);
            l.position.set(i === 0 ? 1.08 : 0, i === 1 ? 1.08 : 0, i === 2 ? 1.08 : 0);
            s.body.add(l);
            return l;
        });
        if (s.name) { s.anchor.remove(s.name); disposeSprite(s.name); }
        s.name = textSprite(names[s.key], colors.ink, colors.font, 0.24, 600);
        s.name.position.set(0, 0, -0.62);
        s.anchor.add(s.name);
        if (s.accLabel) { s.acc.remove(s.accLabel); disposeSprite(s.accLabel); }
        s.accLabel = textSprite('a', colors.ink, colors.font, 0.18, 600);
        s.accLabel.position.set(1.12, 0, 0);
        s.acc.add(s.accLabel);
    }
    const sensors = { L: makeSensor('L'), R: makeSensor('R'), C: makeSensor('C') };

    let layout = 'split';
    function placeAll() {
        for (const k in sensors) {
            const s = sensors[k];
            s.anchor.position.copy(layout === 'split' ? SPLIT[k] : OVERLAY);
            // overlay: name labels spread out so they do not sit on top of each other
            s.name.position.set(layout === 'split' ? 0 : (k === 'L' ? -0.8 : k === 'R' ? 0.8 : 0), 0, -0.62 - (layout === 'split' ? 0 : (k === 'C' ? 0.28 : 0)));
        }
    }

    const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), X = new THREE.Vector3(1, 0, 0);
    function applyLook(s) {
        const op = !s.live ? 0.18 : s.ghost ? 0.5 : 1;
        s.arrows.forEach((a) => { a.userData.mat.opacity = op; });
        s.labels.forEach((l) => { l.material.opacity = op; });
        s.boardMat.opacity = s.ghost ? 0 : 0.55 * op; s.edgeMat.opacity = s.ghost ? 0.25 : op;
        s.name.material.opacity = s.live ? 1 : 0.45;
        s.anchor.visible = s.visible;
    }

    /* ---------- render on demand ---------- */
    let dirty = true;
    controls.addEventListener('change', () => { dirty = true; });
    function resize() {
        const w = stage.clientWidth, h = stage.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h; camera.updateProjectionMatrix();
        dirty = true;
    }
    new ResizeObserver(resize).observe(stage);
    resize();
    (function frame() {
        controls.update();
        if (dirty) { renderer.render(scene, camera); dirty = false; }
        requestAnimationFrame(frame);
    })();

    buildGround(); placeAll();
    for (const k in sensors) { sensors[k].live = false; applyLook(sensors[k]); }

    return {
        /**
         * q = [w, x, y, z] in the world frame (null = no value), accWorld = accel already turned to the world (m/s²),
         * live = value is current, visible = draw at all, ghost = faint, no board (the second sensor when overlaid).
         */
        setSensor(key, { q = null, accWorld = null, live = false, visible = true, ghost = false } = {}) {
            const s = sensors[key];
            if (!s) return;
            s.live = live && !!q; s.visible = visible; s.ghost = ghost;
            if (q) s.body.quaternion.copy(tmpQ.set(q[1], q[2], q[3], q[0]).normalize());
            const n = accWorld ? Math.hypot(accWorld[0], accWorld[1], accWorld[2]) : 0;
            s.acc.visible = !!accWorld && n > 0.05 && s.live && !ghost;
            if (s.acc.visible) {
                s.acc.quaternion.setFromUnitVectors(X, tmpV.set(accWorld[0], accWorld[1], accWorld[2]).normalize());
                s.acc.scale.setScalar(Math.min(2.4, 1.45 * n / G)); // longer than the axes so it never hides behind one
            }
            applyLook(s);
            dirty = true;
        },
        setLayout(next) { layout = next === 'overlay' ? 'overlay' : 'split'; placeAll(); dirty = true; },
        resetView() { camera.position.set(2.6, -6.4, 3.6); controls.target.set(0, 0, 0.75); controls.update(); dirty = true; },
        refreshTheme() {
            colors = cssColors();
            buildGround();
            for (const k in sensors) {
                const s = sensors[k];
                s.arrows.forEach((a, i) => a.userData.mat.color.set(colors['xyz'[i]]));
                s.acc.userData.mat.color.set(colors.ink);
                s.boardMat.color.set(colors.surface); s.edgeMat.color.set(colors.ink2);
                buildLabels(s); applyLook(s);
            }
            placeAll();
            dirty = true;
        },
    };
}
