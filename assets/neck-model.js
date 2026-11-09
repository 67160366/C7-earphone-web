/*
 * 3D neck and head view for the user page (ES module, vendored Three.js, no CDN).
 * Axis convention (docs/SENSOR_AXES.md): head faces +Z, Y up, Euler order YXZ;
 *   +pitch = chin down, +roll = right ear toward right shoulder, +yaw = face turns to the person's left.
 *
 * The whole head scan is ONE skinned mesh (no cut, no separate neck tube), so the skin stretches like
 * muscle instead of breaking at a joint. Bones follow CVA geometry 1 from c7-core.js (window.C7):
 *   chest -> c7 -> c5 -> c3 -> head(C0)   along the line C7 -> C0 (length L, phi0 from vertical).
 * The neck-line change (tilt) is spread over the lower bones (C4-C7 bend most), corrected so the
 * C0 joint lands exactly where the formula puts it; the head bone then makes the skull's world pitch
 * equal to the measured head pitch. The CVA overlay is drawn from C7.cvaParts(), so the drawn angle
 * is the number on screen.
 * The head scan is Lee Perry-Smith's "Infinite" scan (CC BY 3.0).
 */
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';

const C7 = globalThis.C7;
const rad = THREE.MathUtils.degToRad;
const VIEWS = { angle: [2.7, 2.35, 4.5], side: [5.4, 1.85, 0.25], front: [0.01, 2.05, 5.4] };
const TARGET_Y = 1.62;

// Where the scan sits in the scene (scan normalised to 1.95 units tall, base at y = 0).
const SCAN_HEIGHT = 1.95, SCAN_SCALE = 1.22, SCAN_OFFSET = new THREE.Vector3(0, 0.516, -0.04);
// Neck bones: share of the neck-line change each one takes (sum of cumulative shares = 3, so the
// chord C7 -> C0 turns by the full tilt), and share of yaw / roll (sums to 1 with the head bone).
const NECK = [
    { name: 'c7', at: 0, pitch: 0.6, yaw: 0.1, roll: 0.3 },
    { name: 'c5', at: 1 / 3, pitch: 0.45, yaw: 0.2, roll: 0.3 },
    { name: 'c3', at: 2 / 3, pitch: 0.3, yaw: 0.3, roll: 0.2 },
];
const BLEND = 0.16;      // half width of the smooth skin hand-over between neighbouring bones (in neck lengths)
const SLICE_TILT = 25;   // neck cross-sections tilt (front lower), degrees

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function cssColor(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    try { return new THREE.Color(v || fallback); } catch (e) { return new THREE.Color(fallback); }
}

/**
 * Landmarks of the normalised scan, measured from its vertices:
 *   ear = centre of the outermost vertices at ear height, c7 = back of the neck where it meets the shoulders.
 */
function scanLandmarks(pos) {
    // The scan is sparse at the midline, so the back of the neck is the rearmost vertex in a band.
    const C7_Y = 0.6;
    let ex = 0, ey = 0, ez = 0, en = 0, back = Infinity;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (Math.abs(x) > 0.42 && y > 1.15 && y < 1.45) { ex += Math.abs(x); ey += y; ez += z; en++; }
        if (Math.abs(x) < 0.2 && Math.abs(y - C7_Y) < 0.06) back = Math.min(back, z);
    }
    return {
        earX: en ? ex / en : 0.46,
        ear: new THREE.Vector2(en ? ez / en : -0.01, en ? ey / en : 1.32),
        c7: new THREE.Vector2(Number.isFinite(back) ? back : -0.47, C7_Y),
    };
}

export async function createNeckModel(canvas, { modelUrl, normalUrl } = {}) {
    if (!C7 || !C7.cvaParts) throw new Error('c7-core.js must load before neck-model.js');
    const stage = canvas.parentElement;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(...VIEWS.angle);
    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, TARGET_Y, 0);
    controls.enableDamping = true; controls.enablePan = false;
    controls.minDistance = 3.2; controls.maxDistance = 9; controls.maxPolarAngle = Math.PI * 0.6;

    scene.add(new THREE.HemisphereLight(0xeef6f4, 0x2a3633, 2.2));
    const key = new THREE.DirectionalLight(0xfff1e2, 3.6);
    key.position.set(3, 6, 5); key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -3, right: 3, top: 4, bottom: -2 });
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fd8cf, 2.4); rim.position.set(-4, 3, -4); scene.add(rim);

    // Everything that can be mirrored lives under root (a negative scale flips the scene like a mirror).
    const root = new THREE.Group(); scene.add(root);
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9dfdd, roughness: 0.6, metalness: 0.04 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x24423d, roughness: 0.85 });
    const podMat = new THREE.MeshStandardMaterial({ color: 0x0f6e66, roughness: 0.35, metalness: 0.25 });

    const floor = new THREE.Mesh(new THREE.CircleGeometry(2.6, 72), new THREE.ShadowMaterial({ opacity: 0.18 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.5; floor.receiveShadow = true; scene.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.85, 1.87, 120), new THREE.MeshBasicMaterial({ color: 0x8aa39c, transparent: true, opacity: 0.35 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = -0.495; scene.add(ring);

    /* ---------- geometry and rig ---------- */
    let geo = null, earX = 0.56, model = 'scan';
    let c7W, earW; // C7 skin point and tragus in root space (scene units), bind pose
    try {
        const gltf = await new GLTFLoader().loadAsync(modelUrl);
        const original = gltf.scene.getObjectByProperty('isMesh', true);
        geo = original.geometry.clone(); geo.computeBoundingBox();
        const box = geo.boundingBox, center = box.getCenter(new THREE.Vector3()), s = SCAN_HEIGHT / (box.max.y - box.min.y);
        geo.translate(-center.x, -box.min.y, -center.z); geo.scale(s, s, s);
        const lm = scanLandmarks(geo.attributes.position);
        geo.scale(SCAN_SCALE, SCAN_SCALE, SCAN_SCALE); geo.translate(SCAN_OFFSET.x, SCAN_OFFSET.y, SCAN_OFFSET.z);
        const toW = (v) => new THREE.Vector2(v.x * SCAN_SCALE + SCAN_OFFSET.z, v.y * SCAN_SCALE + SCAN_OFFSET.y);
        c7W = toW(lm.c7); earW = toW(lm.ear); earX = lm.earX * SCAN_SCALE;
    } catch (error) {
        console.warn('Head scan unavailable, using a simple head.', error);
        model = 'fallback';
        c7W = new THREE.Vector2(-0.45, 1.07); earW = new THREE.Vector2(0.0, 1.95);
    }
    canvas.dataset.model = model;

    // Fit geometry 1 to the scan: the scan's own C7 -> ear line becomes the zero posture.
    // Rotating the scan (about its C7) to that line keeps the drawn CVA equal to the formula.
    const zero = C7.cvaParts(0, 0);
    const tCm = new THREE.Vector2(zero.t.z, zero.t.y);
    const scanVec = earW.clone().sub(c7W);
    const S = scanVec.length() / tCm.length();                   // scene units per cm
    const fit = Math.atan2(scanVec.y, scanVec.x) - Math.atan2(tCm.y, tCm.x); // + = scan stands more upright than 52.05
    if (geo) {
        // Lean the scan forward about C7 by `fit` so its ear sits on the formula's tragus.
        const m = new THREE.Matrix4().makeTranslation(0, c7W.y, c7W.x)
            .multiply(new THREE.Matrix4().makeRotationX(fit))
            .multiply(new THREE.Matrix4().makeTranslation(0, -c7W.y, -c7W.x));
        geo.applyMatrix4(m);
        geo.computeVertexNormals();
    }
    canvas.dataset.fitDeg = (fit / THREE.MathUtils.DEG2RAD).toFixed(2);
    const cm = (z, y) => new THREE.Vector3(0, c7W.y + y * S, c7W.x + z * S); // formula cm -> root space
    const c0 = cm(zero.c0.z, zero.c0.y);
    const L = C7.GEOMETRY.neckLength.value * S, phi0 = rad(zero.phi0);
    const axis = new THREE.Vector3(0, Math.cos(phi0), Math.sin(phi0));

    const bones = {};
    const chest = new THREE.Bone(); chest.name = 'chest'; chest.position.set(0, c7W.y - 0.6, c7W.x + 0.3);
    let parent = chest, parentPos = chest.position.clone();
    for (const b of NECK) {
        const bone = new THREE.Bone(); bone.name = b.name;
        const p = cm(0, 0).addScaledVector(axis, L * b.at);
        bone.position.copy(p).sub(parentPos); parent.add(bone);
        bones[b.name] = bone; parent = bone; parentPos = p;
    }
    const headBone = new THREE.Bone(); headBone.name = 'head';
    headBone.position.copy(c0).sub(parentPos); parent.add(headBone);
    const boneList = [chest, bones.c7, bones.c5, bones.c3, headBone];

    // Skin weights. u = position along the neck (0 at C7, 1 at C0) on slices tilted SLICE_TILT;
    // h = 1 above the jaw/occiput line, which follows the head.
    const sliceN = new THREE.Vector2(Math.sin(rad(SLICE_TILT)), Math.cos(rad(SLICE_TILT))); // (z, y)
    const c0Level = (c0.z - c7W.x) * sliceN.x + (c0.y - c7W.y) * sliceN.y;
    const jawA = cm(-5.0, zero.c0.y + 0.2), jawB = cm(10.5, zero.c0.y - 3.4); // occiput base -> under the chin
    const jawDir = new THREE.Vector2(jawB.z - jawA.z, jawB.y - jawA.y).normalize();
    function weightsFor(y, z) {
        const u = ((z - c7W.x) * sliceN.x + (y - c7W.y) * sliceN.y) / c0Level;
        const above = (z - jawA.z) * -jawDir.y + (y - jawA.y) * jawDir.x; // signed distance to the jaw line
        const h = smooth(-0.05, 0.07, above) * smooth(0.55, 0.9, u);
        // partition of unity over chest | c7 | c5 | c3 along u
        const t = [0, 1 / 3, 2 / 3].map((k) => smooth(k - BLEND, k + BLEND, u));
        const w = [1 - t[0], t[0] * (1 - t[1]), t[1] * (1 - t[2]), t[2]].map((v) => v * (1 - h));
        w.push(h);
        return w;
    }
    function skinGeometry(g) {
        const pos = g.attributes.position, n = pos.count;
        const idx = new Uint16Array(n * 4), wt = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const w = weightsFor(pos.getY(i), pos.getZ(i));
            const top = w.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0]).slice(0, 4);
            const sum = top.reduce((a, [v]) => a + v, 0) || 1;
            top.forEach(([v, k], j) => { idx[i * 4 + j] = k; wt[i * 4 + j] = v / sum; });
        }
        g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
        g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wt, 4));
    }

    const skeleton = new THREE.Skeleton(boneList);
    const meshes = [];
    const addSkinned = (g, mat) => {
        skinGeometry(g);
        const mesh = new THREE.SkinnedMesh(g, mat);
        mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
        root.add(mesh); meshes.push(mesh);
        return mesh;
    };
    if (geo) {
        const body = addSkinned(geo, skin);
        body.add(chest); body.bind(skeleton);
        if (normalUrl) new THREE.TextureLoader().load(normalUrl, (normal) => { normal.flipY = false; skin.normalMap = normal; skin.normalScale.set(0.45, 0.45); skin.needsUpdate = true; });
    } else {
        // Fallback: a torso, a neck tube bent by the same skeleton, and a head on the head bone.
        const torso = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), cloth);
        torso.scale.set(1.25, 0.62, 0.58); torso.position.set(0, 0.62, -0.06); torso.castShadow = true; root.add(torso);
        const tube = new THREE.CylinderGeometry(0.3, 0.36, L * 1.5, 40, 24);
        tube.applyMatrix4(new THREE.Matrix4().makeRotationX(phi0));
        tube.translate(0, (c7W.y + c0.y) / 2 + 0.02, (c7W.x + c0.z) / 2 + 0.3);
        const neck = addSkinned(tube, skin); neck.add(chest); neck.bind(skeleton);
        const h = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), skin); h.scale.set(0.56, 0.72, 0.66); h.position.set(0, 0.42, 0.18); headBone.add(h);
    }

    // Earphone pods at the tragus (the product's sensors) and the C7 landmark, carried by the bones.
    const earLocal = cm(zero.t.z, zero.t.y).sub(c0);
    const pods = {};
    for (const side of ['left', 'right']) {
        const pod = new THREE.Group();
        pod.position.set(side === 'left' ? earX : -earX, earLocal.y, earLocal.z);
        const shell = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.05, 8, 20), podMat.clone());
        shell.rotation.z = Math.PI / 2; shell.castShadow = true; pod.add(shell);
        const led = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 12), new THREE.MeshStandardMaterial({ color: 0x4ade80, emissive: 0x4ade80, emissiveIntensity: 1 }));
        led.position.set(side === 'left' ? 0.075 : -0.075, 0.015, 0); pod.add(led);
        headBone.add(pod); pods[side] = { pod, led };
    }
    const dotMat = (color) => new THREE.MeshBasicMaterial({ color, depthTest: false });
    const c7Dot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 16), dotMat(0xf5b83d)); c7Dot.renderOrder = 10; root.add(c7Dot);
    const c0Dot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), dotMat(0x8a948f)); c0Dot.renderOrder = 10; root.add(c0Dot);
    const tDot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), dotMat(0xf5b83d)); tDot.renderOrder = 10; root.add(tDot);

    // CVA overlay in the sagittal plane: horizontal from C7, neck line C7 -> C0 -> tragus, arc.
    const lineMat = new THREE.LineBasicMaterial({ color: 0x13221e, depthTest: false, transparent: true, opacity: 0.9 });
    const dashMat = new THREE.LineDashedMaterial({ color: 0x13221e, dashSize: 0.06, gapSize: 0.05, depthTest: false, transparent: true, opacity: 0.55 });
    const thinMat = new THREE.LineBasicMaterial({ color: 0x13221e, depthTest: false, transparent: true, opacity: 0.35 });
    const mkLine = (mat) => { const l = new THREE.Line(new THREE.BufferGeometry(), mat); l.renderOrder = 9; root.add(l); return l; };
    const cvaLine = mkLine(lineMat), horizon = mkLine(dashMat), arc = mkLine(lineMat), linkLine = mkLine(thinMat);

    function applyTheme() {
        const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
        skin.color.set(dark ? 0xc9d3d0 : 0xdfe5e3);
        cloth.color.copy(cssColor('--surface-2', '#1C2724')).lerp(new THREE.Color(dark ? 0x2c4a44 : 0x2f5a53), 0.85);
        podMat.color.copy(cssColor('--accent', '#0F6E66'));
        const ink = cssColor('--ink', '#13221E');
        lineMat.color.copy(ink); dashMat.color.copy(ink); thinMat.color.copy(ink);
        ring.material.color.copy(cssColor('--line-strong', '#9AABA5'));
        floor.material.opacity = dark ? 0.35 : 0.16;
    }
    applyTheme();
    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

    /* ---------- pose ---------- */
    const target = { tilt: 0, pitch: 0, roll: 0, yaw: 0 };
    const shown = { ...target };
    let live = false, dirty = true, view = 'angle';
    const e = new THREE.Euler(0, 0, 0, 'YXZ'), q = new THREE.Quaternion(), qChain = new THREE.Quaternion(), qSkull = new THREE.Quaternion();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const arcAnchor = new THREE.Vector3();
    let parts = zero;

    // Angle (deg) the bent chain's chord C7 -> C0 turns by when bone i takes pitch a_i (sagittal plane).
    function chordTurn(angles) {
        let z = 0, y = 0, cum = 0;
        for (const a of angles) { cum += a; z += Math.sin(phi0 + rad(cum)); y += Math.cos(phi0 + rad(cum)); }
        return Math.atan2(z, y) / THREE.MathUtils.DEG2RAD - zero.phi0;
    }

    function applyPose(p) {
        parts = C7.cvaParts(p.tilt, p.pitch);
        const dPhi = parts.phi - parts.phi0;
        const a = NECK.map((b) => b.pitch * dPhi);
        a[0] += dPhi - chordTurn(a); // tiny correction so C0 sits exactly where the formula puts it
        qChain.identity();
        NECK.forEach((b, i) => {
            e.set(rad(a[i]), rad(p.yaw * b.yaw), rad(p.roll * b.roll), 'YXZ');
            bones[b.name].quaternion.setFromEuler(e);
            qChain.multiply(bones[b.name].quaternion);
        });
        e.set(rad(p.pitch), rad(p.yaw), rad(p.roll), 'YXZ'); qSkull.setFromEuler(e);
        headBone.quaternion.copy(qChain).invert().multiply(qSkull); // world skull rotation = measured head
    }

    function updateOverlay() {
        const c7p = cm(0, 0), c0p = cm(parts.c0.z, parts.c0.y), tp = cm(parts.t.z, parts.t.y);
        c7Dot.position.copy(c7p); c0Dot.position.copy(c0p); tDot.position.copy(tp);
        const set = (line, pts) => { line.geometry.dispose(); line.geometry = new THREE.BufferGeometry().setFromPoints(pts); };
        set(cvaLine, [c7p, tp]);
        set(linkLine, [c7p, c0p, tp]);
        set(horizon, [c7p, c7p.clone().add(new THREE.Vector3(0, 0, 1.25))]); horizon.computeLineDistances();
        const ang = rad(parts.cva), r = 0.32, pts = [];
        for (let i = 0; i <= 32; i++) { const t = (ang * i) / 32; pts.push(new THREE.Vector3(0, c7p.y + Math.sin(t) * r, c7p.z + Math.cos(t) * r)); }
        set(arc, pts);
        arcAnchor.set(0, c7p.y + Math.sin(ang / 2) * (r + 0.22), c7p.z + Math.cos(ang / 2) * (r + 0.22));
        root.localToWorld(arcAnchor);
        const show = view === 'side';
        for (const o of [cvaLine, horizon, arc, linkLine, c7Dot, c0Dot, tDot]) o.visible = show;
    }

    const resize = () => {
        const w = stage.clientWidth, h = stage.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
    };
    new ResizeObserver(resize).observe(stage); resize();
    controls.addEventListener('change', () => { dirty = true; });

    let last = performance.now(), labelCb = null;
    function frame(now) {
        const dt = Math.min((now - last) / 1000, 0.1); last = now;
        const k = reduced.matches ? 1 : 1 - Math.exp(-dt * 9);
        let moving = false;
        for (const key of Object.keys(target)) {
            const d = target[key] - shown[key];
            if (Math.abs(d) > 0.01) { shown[key] += d * k; moving = true; }
        }
        controls.update();
        if (moving || dirty) {
            applyPose(shown);
            updateOverlay();
            renderer.render(scene, camera);
            if (labelCb) {
                const p = arcAnchor.clone().project(camera);
                labelCb({ x: (p.x * 0.5 + 0.5) * stage.clientWidth, y: (-p.y * 0.5 + 0.5) * stage.clientHeight, visible: p.z < 1 && view === 'side' });
            }
            dirty = false;
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return {
        /** tilt = MPU change since zero (deg) or the estimate from c7-core; pitch/roll/yaw = head (deg). */
        setPose({ tilt, pitch, roll, yaw }) {
            Object.assign(target, { tilt: Number.isFinite(tilt) ? tilt : 0, pitch, roll, yaw });
        },
        setLive(on) {
            live = on;
            for (const s of Object.values(pods)) { s.led.material.color.set(on ? 0x4ade80 : 0x8a948f); s.led.material.emissiveIntensity = on ? 1 : 0; }
            dirty = true;
        },
        setSensors(sensors = {}) {
            for (const side of ['left', 'right']) {
                const fresh = sensors[`${side}_fresh`] === true && live;
                const { led } = pods[side]; led.material.color.set(fresh ? 0x4ade80 : 0x8a948f); led.material.emissiveIntensity = fresh ? 1 : 0;
            }
            dirty = true;
        },
        setView(name) { view = VIEWS[name] ? name : 'angle'; camera.position.set(...VIEWS[view]); controls.target.set(0, TARGET_Y, 0); controls.update(); dirty = true; },
        setMirror(on) { root.scale.x = on ? -1 : 1; dirty = true; },
        onLabel(cb) { labelCb = cb; dirty = true; },
        refreshTheme() { applyTheme(); dirty = true; },
        /** Debug/inspection: what the model is using (scene units per cm, scan fit, current formula parts). */
        info() { return { model, scenePerCm: S, fitDeg: fit / THREE.MathUtils.DEG2RAD, parts }; },
    };
}
