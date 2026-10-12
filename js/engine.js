// Walkable engine: loads a GLB, applies a scene.json, and runs orbit / walk / fly modes.
// Shared by the Studio editor and the client viewer. Walk mode resolves a capsule against a BVH of the model.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { mergeScene, LIGHT_PRESETS } from './schema.js';
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const THREE_CDN = 'https://unpkg.com/three@0.170.0/examples/jsm/';
const PLAYER = { radius: 0.28, height: 1.7, runMul: 2.0, flySpeed: 4.0 };
const isTouch = matchMedia('(pointer: coarse)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeInOut = (k) => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;

export class Walkable {
  constructor(canvas) {
    this.canvas = canvas;
    this.listeners = {};
    this.frameHooks = [];
    this.data = mergeScene(null);
    this.mode = 'orbit';
    this.modelRoot = null; this.modelGroup = new THREE.Group(); this.modelGroup.name = 'model';
    this.collider = null; this.ceiling = null; this.ground = null; this.grid = null;
    this.mixer = null; this.clock = new THREE.Clock();
    this.plaqueMesh = null; this.mediaMeshes = new Map(); this.logoTexture = null; this.logoAspect = 1;
    this.selection = null; this.selectionHelper = null;
    this.tween = null;
    this.walk = { velY: 0, keys: {}, run: false, stick: new THREE.Vector2(), look: null, locked: false };
    this.bounds = { box: new THREE.Box3(), center: new THREE.Vector3(), size: new THREE.Vector3(), radius: 10 };
    this.pickHandler = null;

    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2)); r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
    this.orbit = new OrbitControls(this.camera, canvas); this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.08; this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a80, 0.5); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4); this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0005; this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.modelGroup);
    this.decals = new THREE.Group(); this.decals.name = 'decals'; this.scene.add(this.decals);

    this.loader = new GLTFLoader();
    const draco = new DRACOLoader(); draco.setDecoderPath(THREE_CDN + 'libs/draco/gltf/'); this.loader.setDRACOLoader(draco);
    const ktx2 = new KTX2Loader(); ktx2.setTranscoderPath(THREE_CDN + 'libs/basis/'); ktx2.detectSupport(r); this.loader.setKTX2Loader(ktx2);
    this.loader.setMeshoptDecoder(MeshoptDecoder);

    this.themeQuery = matchMedia('(prefers-color-scheme: dark)'); this.themeQuery.addEventListener('change', () => this.applyTheme());
    this.bindInput();
    r.setAnimationLoop(() => this.frame());
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { (this.listeners[ev] || []).forEach(f => f(...a)); }
  onFrame(fn) { this.frameHooks.push(fn); }

  // ---------- model ----------
  async loadModel(arrayBuffer) {
    const gltf = await new Promise((res, rej) => this.loader.parse(arrayBuffer, '', res, rej));
    this.unloadModel();
    const root = gltf.scene; this.modelRoot = root; this.animations = gltf.animations || [];
    let i = 0; const seen = new Set(); let tris = 0, meshes = 0; const mats = new Set(), texs = new Set();
    root.traverse(o => {
      if (!o.isMesh) return;
      meshes++; const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      let key = o.name || `mesh_${i}`; i++; while (seen.has(key)) key += '_'; seen.add(key); o.userData.key = key;
      o.castShadow = true; o.receiveShadow = true; if (o.isSkinnedMesh) o.frustumCulled = false;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      list.forEach(m => { if (!m) return; mats.add(m); m.side = THREE.DoubleSide; if (m.transparent) o.castShadow = false; for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) if (m[k]) texs.add(m[k]); });
      o.userData.origMaterial = o.material;
    });
    this.modelGroup.add(root);
    const raw = new THREE.Box3().setFromObject(root); const rs = raw.getSize(new THREE.Vector3());
    const stats = { triangles: Math.round(tris), meshes, materials: mats.size, textures: texs.size, animations: this.animations.length, rawSize: [rs.x, rs.y, rs.z].map(v => +v.toFixed(3)), bytes: arrayBuffer.byteLength };
    this.data.model.stats = stats;
    if (this.animations.length) { this.mixer = new THREE.AnimationMixer(root); this.animations.forEach(c => this.mixer.clipAction(c).play()); }
    this.applyTransform(); this.applyMaterials(); this.applyDecals(); this.applyEnv(); this.applyLights();
    if (!this.data.start) this.data.start = this.defaultStart();
    this.emit('loaded', stats);
    return stats;
  }
  unloadModel() {
    if (this.modelRoot) { this.modelGroup.remove(this.modelRoot); this.modelRoot = null; }
    if (this.collider) { this.scene.remove(this.collider); this.collider.geometry.dispose(); this.collider = null; }
    for (const o of [this.ceiling, this.ground, this.grid]) if (o) this.scene.remove(o);
    this.ceiling = this.ground = this.grid = null; this.mixer = null; this.doors = null; this.doorMeshes = []; this.select(null);
  }
  // Suggest a unit scale from the raw size: GLB should be metres; exporters sometimes leave mm or cm.
  static suggestScale(rawSize) { const m = Math.max(...rawSize); if (m > 2000) return 0.001; if (m > 200) return 0.01; return 1; }

  applyTransform() {
    const m = this.data.model; this.modelGroup.scale.setScalar(m.scale || 1); this.modelGroup.rotation.set(m.upAxis === 'z' ? -Math.PI / 2 : 0, 0, 0);
    if (!this.modelRoot) return;
    this.modelGroup.updateMatrixWorld(true);
    const b = this.bounds; b.box.setFromObject(this.modelGroup); b.box.getCenter(b.center); b.box.getSize(b.size); b.radius = Math.max(b.size.x, b.size.y, b.size.z) || 1;
    this.camera.near = Math.max(0.02, b.radius / 2000); this.camera.far = b.radius * 20; this.camera.updateProjectionMatrix();
    this.doors = null; this.invalidateCollider(); this.buildHelpers(); this.placeSun();
    if (this.mixer) this.mixer.update(0);
  }
  buildHelpers() {
    const b = this.bounds;
    for (const o of [this.ceiling, this.ground, this.grid]) if (o) this.scene.remove(o);
    this.ceiling = new THREE.Mesh(new THREE.PlaneGeometry(b.size.x + 0.4, b.size.z + 0.4), new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: 0.95, side: THREE.DoubleSide }));
    this.ceiling.rotation.x = Math.PI / 2; this.ceiling.position.set(b.center.x, b.box.max.y - 0.001, b.center.z); this.ceiling.name = 'Ceiling'; this.scene.add(this.ceiling);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(b.radius * 8, b.radius * 8), new THREE.ShadowMaterial({ opacity: 0.16, color: 0x2a2416 })); this.ground.rotation.x = -Math.PI / 2; this.ground.position.set(b.center.x, b.box.min.y - 0.002, b.center.z); this.ground.receiveShadow = true; this.scene.add(this.ground);
    const n = Math.max(4, Math.ceil(b.radius * 4)); this.grid = new THREE.GridHelper(n, n, 0xb9b3a6, 0xb9b3a6); this.grid.material.opacity = 0.35; this.grid.material.transparent = true; this.grid.position.set(b.center.x, b.box.min.y - 0.001, b.center.z); this.scene.add(this.grid);
    this.applyEnv();
  }
  applyEnv() {
    const e = this.data.env; if (!this.ceiling) return;
    const walking = this.mode === 'walk' || this.mode === 'fly';
    this.ceiling.visible = e.ceiling === 'always' || (e.ceiling === 'walk' && walking);
    this.ground.visible = !!e.ground; this.grid.visible = !!e.grid && !walking;
  }

  // ---------- lights, theme ----------
  applyLights() {
    const l = this.data.light; const b = this.bounds;
    this.renderer.toneMappingExposure = l.exposure; this.hemi.intensity = l.ambient; this.scene.environmentIntensity = l.envIntensity;
    this.sun.intensity = l.sunIntensity; this.sun.color.set(l.sunColor || '#ffffff'); this.sun.castShadow = !!l.shadows;
    this.renderer.shadowMap.enabled = !!l.shadows; this.renderer.shadowMap.needsUpdate = true;
    this.placeSun(); this.applyTheme();
  }
  placeSun() {
    const l = this.data.light, b = this.bounds; const el = THREE.MathUtils.degToRad(l.sunElev), az = THREE.MathUtils.degToRad(l.sunAzim); const d = b.radius * 2;
    this.sun.position.set(b.center.x + d * Math.cos(el) * Math.sin(az), b.center.y + d * Math.sin(el), b.center.z + d * Math.cos(el) * Math.cos(az)); this.sun.target.position.copy(b.center);
    const s = b.radius * 1.2; Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.5, far: b.radius * 8 }); this.sun.shadow.camera.updateProjectionMatrix();
  }
  isDark() { const t = this.data.theme; return t === 'dark' || (t !== 'light' && this.themeQuery.matches); }
  applyTheme() {
    const dark = this.isDark(); const root = document.documentElement;
    root.dataset.theme = this.data.theme === 'auto' ? '' : this.data.theme; root.classList.toggle('theme-dark', dark); root.classList.toggle('theme-light', !dark);
    root.classList.toggle('dark-logo-invert', !!this.data.brand.invertDark);
    const bg = this.data.light.background; this.scene.background = new THREE.Color(bg && bg !== 'auto' ? bg : (dark ? 0x141412 : 0xece9e2));
    if (this.grid) { const gc = new THREE.Color(dark ? 0x3a3934 : 0xb9b3a6); (Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material]).forEach(m => m.color = gc); }
    if (this.ceiling) this.ceiling.material.color.set(dark ? 0xd8d6d0 : 0xf4f3ef);
  }

  // ---------- materials ----------
  listMeshes() { const out = []; if (this.modelRoot) this.modelRoot.traverse(o => { if (o.isMesh) { const m = Array.isArray(o.userData.origMaterial) ? o.userData.origMaterial[0] : o.userData.origMaterial; out.push({ key: o.userData.key, material: m ? m.name : '' }); } }); return out; }
  applyMaterials() {
    if (!this.modelRoot) return; const ov = this.data.materials || {};
    this.modelRoot.traverse(o => {
      if (!o.isMesh) return; const orig = o.userData.origMaterial; const om = Array.isArray(orig) ? orig[0] : orig; if (!om) return;
      const spec = ov['mesh:' + o.userData.key] || (om.name ? ov['mat:' + om.name] : null);
      if (!spec) { o.material = orig; o.visible = true; return; }
      if (!o.userData.ovMaterial) o.userData.ovMaterial = om.clone();
      const m = o.userData.ovMaterial;
      if (spec.color) { m.color.set(spec.color); if (m.map && spec.keepTexture === false) m.map = null; } else { m.color.copy(om.color); m.map = om.map; }
      if ('roughness' in m) m.roughness = spec.roughness ?? om.roughness; if ('metalness' in m) m.metalness = spec.metalness ?? om.metalness;
      m.needsUpdate = true; o.material = m; o.visible = !spec.hidden;
    });
    this.invalidateCollider();
  }

  // ---------- decals: logo plaque, media screens ----------
  setLogoImage(img) {
    if (this.logoTexture) this.logoTexture.dispose();
    this.logoTexture = img ? new THREE.Texture(img) : null; if (this.logoTexture) { this.logoTexture.colorSpace = THREE.SRGBColorSpace; this.logoTexture.needsUpdate = true; this.logoAspect = img.naturalWidth / img.naturalHeight || (img.width / img.height) || 1; }
    this.applyDecals();
  }
  makeDecal(tex, aspect, d) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.width, d.width / aspect), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide }));
    const p = new THREE.Vector3().fromArray(d.pos), n = new THREE.Vector3().fromArray(d.normal).normalize();
    mesh.position.copy(p).addScaledVector(n, 0.006); mesh.lookAt(p.clone().add(n)); mesh.renderOrder = 2; return mesh;
  }
  applyDecals() {
    if (this.plaqueMesh) { this.decals.remove(this.plaqueMesh); this.plaqueMesh.geometry.dispose(); this.plaqueMesh = null; }
    const p = this.data.plaque; if (p && this.logoTexture) { this.plaqueMesh = this.makeDecal(this.logoTexture, this.logoAspect, p); this.plaqueMesh.name = 'plaque'; this.decals.add(this.plaqueMesh); }
    const keep = new Set((this.data.media || []).map(m => m.id));
    for (const [id, entry] of this.mediaMeshes) if (!keep.has(id)) { this.decals.remove(entry.mesh); entry.mesh.geometry.dispose(); this.mediaMeshes.delete(id); }
    for (const m of this.data.media || []) { const entry = this.mediaMeshes.get(m.id); if (!entry || !entry.tex) continue; this.decals.remove(entry.mesh); entry.mesh.geometry.dispose(); entry.mesh = this.makeDecal(entry.tex, entry.aspect, m); entry.mesh.name = 'media:' + m.id; this.decals.add(entry.mesh); }
  }
  setMediaSource(id, el) {
    const old = this.mediaMeshes.get(id); if (old) { if (old.mesh) { this.decals.remove(old.mesh); old.mesh.geometry.dispose(); } if (old.tex) old.tex.dispose(); }
    if (!el) { this.mediaMeshes.delete(id); return; }
    const isVideo = el.tagName === 'VIDEO'; const tex = isVideo ? new THREE.VideoTexture(el) : new THREE.Texture(el); tex.colorSpace = THREE.SRGBColorSpace; if (!isVideo) tex.needsUpdate = true;
    const aspect = isVideo ? (el.videoWidth / el.videoHeight || 16 / 9) : (el.naturalWidth / el.naturalHeight || 1);
    this.mediaMeshes.set(id, { tex, aspect, mesh: new THREE.Mesh(), el }); this.applyDecals();
  }

  // ---------- layouts: named furniture arrangements ----------
  // map: { nodeName: { layoutKey: [16 numbers, column-major local matrix] } }
  setLayout(map, key, animate = true) {
    if (!this.modelRoot || !map) return;
    this.layoutTweens = [];
    for (const name in map) {
      const o = this.modelRoot.getObjectByName(name); const m = map[name][key]; if (!o || !m) continue;
      const p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3(); new THREE.Matrix4().fromArray(m).decompose(p1, q1, s1);
      if (!animate || reduced) { o.position.copy(p1); o.quaternion.copy(q1); o.scale.copy(s1); }
      else this.layoutTweens.push({ o, p0: o.position.clone(), q0: o.quaternion.clone(), p1, q1, t0: performance.now() });
    }
    if (!this.layoutTweens.length) this.invalidateCollider();
  }
  stepLayout(now) {
    if (!this.layoutTweens || !this.layoutTweens.length) return;
    this.layoutTweens = this.layoutTweens.filter(({ o, p0, q0, p1, q1, t0 }) => { const k = Math.min(1, (now - t0) / 900), e = easeInOut(k); o.position.lerpVectors(p0, p1, e); o.quaternion.slerpQuaternions(q0, q1, e); o.position.y += Math.sin(e * Math.PI) * 0.06; return k < 1; });
    if (!this.layoutTweens.length) this.invalidateCollider();
  }

  // ---------- picking, selection ----------
  pick(clientX, clientY) {
    if (!this.modelRoot) return null; const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera); ray.firstHitOnly = true;
    const hits = ray.intersectObject(this.modelGroup, true).filter(h => h.object.visible);
    if (!hits.length) return null; const h = hits[0]; const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize() : new THREE.Vector3(0, 1, 0);
    if (n.dot(ray.ray.direction) > 0) n.negate();
    const om = Array.isArray(h.object.userData.origMaterial) ? h.object.userData.origMaterial[0] : h.object.userData.origMaterial;
    return { object: h.object, key: h.object.userData.key, material: om ? om.name : '', point: h.point.toArray().map(v => +v.toFixed(4)), normal: n.toArray().map(v => +v.toFixed(4)), distance: h.distance };
  }
  pickCenter() { const r = this.canvas.getBoundingClientRect(); return this.pick(r.left + r.width / 2, r.top + r.height / 2); }
  select(object) {
    if (this.selectionHelper) { this.scene.remove(this.selectionHelper); this.selectionHelper.dispose(); this.selectionHelper = null; }
    this.selection = object || null; if (object) { this.selectionHelper = new THREE.BoxHelper(object, new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1f4e79')); this.scene.add(this.selectionHelper); }
  }

  // ---------- camera: views, framing, start pose ----------
  defaultStart() { const b = this.bounds; return { pos: [b.center.x, b.box.min.y + this.data.player.eye, b.center.z], yaw: 0, pitch: 0 }; }
  frameView(kind = 'iso') {
    const b = this.bounds; const aspect = (this.canvas.clientWidth / this.canvas.clientHeight) || 1.5; const d = b.radius * 1.15 * Math.min(2.6, Math.max(1, 1.05 / aspect)); const off = kind === 'top' ? new THREE.Vector3(0, d * 1.6, 0.001) : new THREE.Vector3(-d * 0.8, d * 0.75, d * 0.9);
    return { pos: b.center.clone().add(off).toArray(), target: b.center.toArray() };
  }
  getOrbitView() { return { pos: this.camera.position.toArray().map(v => +v.toFixed(3)), target: this.orbit.target.toArray().map(v => +v.toFixed(3)) }; }
  getPose() { const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ'); return { pos: this.camera.position.toArray().map(v => +v.toFixed(3)), yaw: +e.y.toFixed(4), pitch: +e.x.toFixed(4) }; }
  setPose(p) { this.camera.position.fromArray(p.pos); this.camera.rotation.set(p.pitch || 0, p.yaw || 0, 0, 'YXZ'); this.walk.velY = 0; }
  goToView(view, animate = true) {
    if (this.mode !== 'orbit') this.setMode('orbit', false);
    const p1 = new THREE.Vector3().fromArray(view.pos), t1 = new THREE.Vector3().fromArray(view.target);
    if (!animate || reduced) { this.camera.position.copy(p1); this.orbit.target.copy(t1); this.orbit.update(); this.tween = null; return; }
    this.tween = { p0: this.camera.position.clone(), t0: this.orbit.target.clone(), p1, t1, start: performance.now(), dur: 700 };
  }

  // ---------- modes ----------
  setMode(mode, resetPose = true) {
    if (mode !== 'orbit' && !this.modelRoot) return;
    const was = this.mode; this.mode = mode; this.orbit.enabled = mode === 'orbit'; this.orbit.autoRotate = false;
    if (mode === 'walk' && !this.collider) this.collider = this.buildCollider();
    if (mode !== 'orbit') {
      if (was === 'orbit' || resetPose) { const s = this.data.start || this.defaultStart(); this.setPose(mode === 'fly' && was === 'walk' ? this.getPose() : s); }
      if (!isTouch) this.lock();
    } else { this.unlock(); if (was !== 'orbit') { const v = this.frameView('iso'); this.camera.position.fromArray(v.pos); this.orbit.target.fromArray(v.target); this.orbit.update(); } }
    this.walk.keys = {}; this.walk.stick.set(0, 0); this.applyEnv(); this.emit('mode', mode);
  }
  lock() {
    const el = this.canvas; if (this.walk.lockFailed || document.pointerLockElement === el || !el.requestPointerLock) return;
    const fail = () => { this.walk.lockFailed = true; this.emit('lock', false); };
    try { let p; try { p = el.requestPointerLock({ unadjustedMovement: true }); } catch { p = el.requestPointerLock(); } if (p && p.catch) p.catch(fail); } catch (e) { fail(); }
  }
  unlock() { if (document.pointerLockElement === this.canvas) document.exitPointerLock(); }
  invalidateCollider() { if (this.collider) { this.scene.remove(this.collider); this.collider.geometry.dispose(); this.collider = null; } if (this.mode === 'walk' && this.modelRoot) this.collider = this.buildCollider(); }
  buildCollider() {
    const geos = []; this.modelGroup.updateMatrixWorld(true); this.findDoors();
    this.modelRoot.traverse(o => {
      if (!o.isMesh || o.isSkinnedMesh || !o.visible) return;
      const s = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()); if (Math.max(s.x, s.y, s.z) < 0.25) return;   // small props do not block
      if (o.userData.door) return;   // every part of a door leaf is its own collider: it opens on a click
      let g = o.geometry.clone(); for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k); g.morphAttributes = {};
      g = g.index ? g.toNonIndexed() : g; g.applyMatrix4(o.matrixWorld); geos.push(g);
    });
    if (!geos.length) return null;
    const merged = BufferGeometryUtils.mergeGeometries(geos, false); merged.boundsTree = new MeshBVH(merged);
    const m = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ visible: false })); m.name = 'collider'; this.scene.add(m); return m;
  }
  // ---------- doors: click to open ----------
  // A leaf is the highest node that is still door-shaped, so frame, glass and handle swing together.
  findDoors() {
    if (this.doors) return this.doors; this.doors = []; if (this.modelRoot) this.modelRoot.traverse(o => { delete o.userData.door; }); if (this.data.player.doors === false || !this.modelRoot) return this.doors;
    const seen = new Set(); const size = (o) => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    this.modelRoot.traverse(o => {
      if (!o.isMesh || seen.has(o)) return; const s = size(o); if (Math.max(s.x, s.y, s.z) < 0.25 || !Walkable.isDoorLeaf(s)) return;
      let leaf = o; while (leaf.parent && leaf.parent !== this.modelRoot && Walkable.isDoorLeaf(size(leaf.parent))) leaf = leaf.parent;
      const meshes = []; leaf.traverse(m => { if (m.isMesh) { meshes.push(m); seen.add(m); } });
      if (this.doors.some(d => d.leaf === leaf)) return;
      const box = new THREE.Box3().setFromObject(leaf);
      // a frame has a hole where the leaf goes: only a part that is solid at its middle swings (frames stay put and stay walkable)
      const c = box.getCenter(new THREE.Vector3()); const thinX = (box.max.x - box.min.x) < (box.max.z - box.min.z); const dir = thinX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const ray = new THREE.Raycaster(c.clone().addScaledVector(dir, -1), dir, 0, 2); const solid = [0, 0.15, -0.15].some(dy => { ray.ray.origin.y = c.y + dy * (box.max.y - box.min.y); return ray.intersectObjects(meshes, false).length > 0; });
      if (solid) this.doors.push({ leaf, meshes, box, open: 0, target: 0, pivot: null });
    });
    // loose parts inside a leaf's outline (glazing bars, handles exported separately) belong to that leaf
    if (this.doors.length) { const grown = this.doors.map(d => d.box.clone().expandByVector(new THREE.Vector3(0.03, 0.5, 0.03)));
      this.modelRoot.traverse(o => { if (!o.isMesh || seen.has(o)) return; const bb = new THREE.Box3().setFromObject(o); const k = grown.findIndex(g => g.containsBox(bb)); if (k >= 0) { this.doors[k].meshes.push(o); (this.doors[k].extra ||= []).push(o); seen.add(o); } }); }
    // handles: a short upright bar (or a short level bar) on a panel's face. The panel with the handle is the one that moves.
    if (this.doors.length) {
      const near = (d, c) => { const b = d.box, thinX = (b.max.x - b.min.x) < (b.max.z - b.min.z); const n = thinX ? Math.max(b.min.x - c.x, c.x - b.max.x, 0) : Math.max(b.min.z - c.z, c.z - b.max.z, 0);
        const inside = thinX ? c.z > b.min.z - 0.05 && c.z < b.max.z + 0.05 : c.x > b.min.x - 0.05 && c.x < b.max.x + 0.05; return inside && c.y > b.min.y && c.y < b.max.y && n < 0.12 ? n : Infinity; };
      this.modelRoot.traverse(o => { if (!o.isMesh) return; const bb = new THREE.Box3().setFromObject(o), z = bb.getSize(new THREE.Vector3());
        const upright = z.y >= 0.08 && z.y <= 0.9 && z.x < 0.1 && z.z < 0.1, level = z.y < 0.08 && Math.max(z.x, z.z) >= 0.1 && Math.max(z.x, z.z) <= 0.5 && Math.min(z.x, z.z) < 0.1; if (!upright && !level) return;
        const c = bb.getCenter(new THREE.Vector3()); let best = null, bd = Infinity; for (const d of this.doors) { const n = near(d, c); if (n < bd) { bd = n; best = d; } } if (!best) return;
        for (const d of this.doors) { const k = d.meshes.indexOf(o); if (k >= 0 && d !== best) { d.meshes.splice(k, 1); if (d.extra) d.extra = d.extra.filter(m => m !== o); } }
        if (!best.meshes.includes(o)) { best.meshes.push(o); (best.extra ||= []).push(o); seen.add(o); } best.handle = c; });
    }
    // double doors: two leaves side by side in one plane open together
    for (const d of this.doors) d.pair = this.doors.find(o => o !== d && Walkable.pairOf(d.box, o.box)) || null;
    // panels overlapping in one doorway (a leaf and its glass, exported as two parts) swing as one
    for (const d of this.doors) d.linked = this.doors.filter(o => o !== d && o !== d.pair && Walkable.overlaps(d.box, o.box));
    // sliding doors: a leaf overlapping a panel in the next plane over. The part that reaches the floor slides over the other, which is fixed glass.
    const fixed = new Set();
    for (const d of this.doors) { const other = d.linked.find(o => Math.abs(o.box.min.y - d.box.min.y) > 0.15 || Walkable.planeGap(d.box, o.box) > 0.005); if (!other) continue;
      const anyHandle = [d, ...d.linked].some(x => x.handle);
      if (anyHandle ? !!d.handle : d.box.min.y <= other.box.min.y + 0.01) { const thinX = (d.box.max.x - d.box.min.x) < (d.box.max.z - d.box.min.z); const dc = d.box.getCenter(new THREE.Vector3()), oc = other.box.getCenter(new THREE.Vector3());
        // slide until it sits over its fixed panel (the overlapping one without a handle), else away from the handle by its width
        const fx = d.linked.filter(o => !o.handle).sort((p, q) => p.box.getCenter(new THREE.Vector3()).distanceTo(dc) - q.box.getCenter(new THREE.Vector3()).distanceTo(dc))[0];
        if (fx) { const fc = fx.box.getCenter(new THREE.Vector3()); d.slide = thinX ? new THREE.Vector3(0, 0, fc.z - dc.z) : new THREE.Vector3(fc.x - dc.x, 0, 0); }
        else { const from = d.handle || oc.clone().lerp(dc, 2); d.slide = thinX ? new THREE.Vector3(0, 0, Math.sign(dc.z - from.z) * (d.box.max.z - d.box.min.z) * 0.95) : new THREE.Vector3(Math.sign(dc.x - from.x) * (d.box.max.x - d.box.min.x) * 0.95, 0, 0); }
        for (const o of d.linked) if (!o.handle) fixed.add(o); } }
    for (const d of this.doors) if (d.slide) { d.passive = d.linked.filter(o => fixed.has(o) && !o.slide); d.blockBoxes = [d.box, ...d.passive.map(o => o.box)]; for (const o of d.passive) for (const m of o.meshes) o.owner = d; }
    const passive = this.doors.filter(d => fixed.has(d) && !d.slide);
    this.doors = this.doors.filter(d => !passive.includes(d));
    for (const d of this.doors) d.linked = d.slide ? [] : d.linked.filter(o => this.doors.includes(o));
    // centre-opening sliders: two sliders in one plane whose handles face each other open together
    for (const d of this.doors) if (d.slide && d.handle && !d.partner) { const dc = d.box.getCenter(new THREE.Vector3());
      d.partner = this.doors.find(o => o !== d && o.slide && o.handle && Walkable.planeGap(d.box, o.box) < 0.01 && Math.abs(o.box.min.y - d.box.min.y) < 0.1 && o.box.getCenter(new THREE.Vector3()).distanceTo(dc) < 2 && o.handle.distanceTo(d.handle) < dc.distanceTo(o.box.getCenter(new THREE.Vector3()))) || null;
      if (d.partner) d.partner.partner = d; }
    this.doorMeshes = this.doors.flatMap(d => [...d.meshes, ...(d.passive || []).flatMap(o => o.meshes)].map(m => (m.userData.door = d, m)));
    return this.doors;
  }
  pickDoor(clientX, clientY) {
    if (!this.doors || !this.doors.length) return null; const rect = this.canvas.getBoundingClientRect(); const ray = new THREE.Raycaster();
    if (clientX == null) ray.setFromCamera(new THREE.Vector2(0, 0), this.camera); else ray.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    const hit = ray.intersectObjects(this.doorMeshes, false)[0]; if (!hit || hit.distance > (this.mode === 'orbit' ? 1e9 : 5)) return null;
    if (this.collider) { ray.far = hit.distance; ray.firstHitOnly = true; if (ray.intersectObject(this.collider).length) return null; }   // a wall is in front of it
    return { door: hit.object.userData.door, point: hit.point };
  }
  static pairOf(a, b) {
    const thinX = (a.max.x - a.min.x) < (a.max.z - a.min.z); const close = (u, v) => Math.abs(u - v) < 0.06;
    if (!close(a.min.y, b.min.y) || !close(a.max.y, b.max.y)) return false;
    return thinX ? (close(a.min.x, b.min.x) || close(a.max.x, b.max.x)) && (close(a.max.z, b.min.z) || close(b.max.z, a.min.z))
                 : (close(a.min.z, b.min.z) || close(a.max.z, b.max.z)) && (close(a.max.x, b.min.x) || close(b.max.x, a.min.x));
  }
  static planeGap(a, b) { const thinX = (a.max.x - a.min.x) < (a.max.z - a.min.z); return thinX ? Math.max(b.min.x - a.max.x, a.min.x - b.max.x, Math.abs((a.min.x + a.max.x) - (b.min.x + b.max.x)) / 2) : Math.max(b.min.z - a.max.z, a.min.z - b.max.z, Math.abs((a.min.z + a.max.z) - (b.min.z + b.max.z)) / 2); }
  static overlaps(a, b) {
    const thinX = (a.max.x - a.min.x) < (a.max.z - a.min.z); const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
    if (ov(a.min.y, a.max.y, b.min.y, b.max.y) < 1.2) return false;
    return thinX ? ov(a.min.x, a.max.x, b.min.x, b.max.x) > -0.12 && ov(a.min.z, a.max.z, b.min.z, b.max.z) > 0.15
                 : ov(a.min.z, a.max.z, b.min.z, b.max.z) > -0.12 && ov(a.min.x, a.max.x, b.min.x, b.max.x) > 0.15;
  }
  toggleDoor(door, point, withPair = true) {
    point ||= door.box.getCenter(new THREE.Vector3());
    if (withPair) {   // the leaf, its double-door partner and any panel overlapping either swing together, to one state
      let pt = point; const set = new Set([door, ...(door.linked || []), ...(door.partner ? [door.partner] : [])]);
      if (door.pair) { const o = door.pair.box, b = door.box; pt = new THREE.Vector3((Math.max(b.min.x, o.min.x) + Math.min(b.max.x, o.max.x)) / 2, (b.min.y + b.max.y) / 2, (Math.max(b.min.z, o.min.z) + Math.min(b.max.z, o.max.z)) / 2); set.add(door.pair); for (const l of door.pair.linked || []) set.add(l); }
      if (!door.pair && set.size > 1) {   // overlapping panels share one hinge side: push the point out to the group's edge on the clicked side
        const U = [...set].reduce((u, o) => u.union(o.box), door.box.clone()), c = U.getCenter(new THREE.Vector3()); const alongX = (U.max.x - U.min.x) > (U.max.z - U.min.z);
        pt = pt.clone(); if (alongX) pt.x = pt.x > c.x ? U.max.x + 1 : U.min.x - 1; else pt.z = pt.z > c.z ? U.max.z + 1 : U.min.z - 1;
      }
      const target = door.target ? 0 : 1; for (const o of set) if (o.target !== target) this.toggleDoor(o, pt, false); return;
    }
    if (!door.pivot && door.slide) {   // sliding leaf: a group that moves along the track
      const parent = door.leaf.parent; const pivot = new THREE.Group(); parent.add(pivot); pivot.updateMatrixWorld(true); pivot.attach(door.leaf); for (const m of door.extra || []) pivot.attach(m);
      const pq = parent.getWorldQuaternion(new THREE.Quaternion()).invert(); const ps = parent.getWorldScale(new THREE.Vector3());
      door.track = door.slide.clone().applyQuaternion(pq).divide(ps); door.base = pivot.position.clone(); door.pivot = pivot;
    }
    if (!door.pivot && door.handle) point = door.handle;   // the hinge is on the edge away from the handle
    if (!door.pivot) {   // hinge on the vertical edge away from where it was clicked (the handle side), swing away from the viewer
      const b = door.box, c = b.getCenter(new THREE.Vector3()); const alongX = (b.max.x - b.min.x) > (b.max.z - b.min.z);
      const hinge = alongX ? new THREE.Vector3(point.x > c.x ? b.min.x : b.max.x, c.y, c.z) : new THREE.Vector3(c.x, c.y, point.z > c.z ? b.min.z : b.max.z);
      const parent = door.leaf.parent; const pivot = new THREE.Group(); parent.add(pivot); pivot.position.copy(parent.worldToLocal(hinge.clone())); pivot.updateMatrixWorld(true); pivot.attach(door.leaf); for (const m of door.extra || []) pivot.attach(m);
      const pq = parent.getWorldQuaternion(new THREE.Quaternion()).invert(); door.axis = new THREE.Vector3(0, 1, 0).applyQuaternion(pq).normalize(); door.base = pivot.quaternion.clone(); door.pivot = pivot;
      const free = alongX ? new THREE.Vector3(point.x > c.x ? b.max.x : b.min.x, c.y, c.z) : new THREE.Vector3(c.x, c.y, point.z > c.z ? b.max.z : b.min.z);
      const nudged = free.clone().sub(hinge).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.2).add(hinge);
      door.sign = nudged.distanceTo(this.camera.position) > free.distanceTo(this.camera.position) ? 1 : -1;
    }
    door.target = door.target ? 0 : 1; if (reduced) door.open = door.target; this.emit('door', door);
  }
  stepDoors(dt) {
    if (!this.doors) return;
    for (const d of this.doors) { if (!d.pivot || d.open === d.target) continue; d.open = d.target > d.open ? Math.min(d.target, d.open + dt / 0.6) : Math.max(d.target, d.open - dt / 0.6);
      if (d.slide) d.pivot.position.copy(d.base).addScaledVector(d.track, easeInOut(d.open));
      else d.pivot.quaternion.copy(d.base).multiply(new THREE.Quaternion().setFromAxisAngle(d.axis, d.sign * easeInOut(d.open) * Math.PI / 2)); }
  }
  // closed doors block like walls: push the capsule out of the leaf's box
  blockDoors(seg) {
    if (!this.doors) return; const r = PLAYER.radius;
    for (const d of this.doors) for (const b of (d.blockBoxes || [d.box])) { if (d.open > 0.05) continue; if (seg.end.y + r < b.min.y || seg.start.y - r > b.max.y) continue;
      const p = seg.start; const dx1 = p.x - (b.min.x - r), dx2 = (b.max.x + r) - p.x, dz1 = p.z - (b.min.z - r), dz2 = (b.max.z + r) - p.z; if (dx1 <= 0 || dx2 <= 0 || dz1 <= 0 || dz2 <= 0) continue;
      const m = Math.min(dx1, dx2, dz1, dz2); const v = m === dx1 ? [-dx1, 0] : m === dx2 ? [dx2, 0] : m === dz1 ? [0, -dz1] : [0, dz2];
      seg.start.x += v[0]; seg.end.x += v[0]; seg.start.z += v[1]; seg.end.z += v[1]; }
  }
  // A door leaf: thin, door-width, door-height. Walls, frames and furniture fail at least one of these.
  static isDoorLeaf(s) { const thin = Math.min(s.x, s.z), wide = Math.max(s.x, s.z); return thin < 0.12 && wide >= 0.5 && wide <= 1.4 && s.y >= 1.8 && s.y <= 2.8; }
  moveInput() {
    const k = this.walk.keys; let mx = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0), mz = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
    mx += this.walk.stick.x; mz -= this.walk.stick.y;
    const f = new THREE.Vector3(); this.camera.getWorldDirection(f); f.y = 0; f.normalize(); const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const mv = new THREE.Vector3().addScaledVector(f, mz).addScaledVector(r, mx); if (mv.lengthSq() > 1) mv.normalize(); return mv;
  }
  walkStep(dt) {
    const c = this.collider; if (!c) return; const eye = this.data.player.eye; const sp = this.data.player.speed * (this.walk.run ? PLAYER.runMul : 1);
    this.walk.velY = Math.max(this.walk.velY - 9.8 * dt, -8);
    const pos = this.camera.position.clone(); pos.y -= eye; const mv = this.moveInput(); pos.addScaledVector(mv, sp * dt); pos.y += this.walk.velY * dt;
    // stairs: a step up to 40 cm just ahead is climbed rather than treated as a wall
    if (mv.lengthSq() > 0.01 && this.walk.velY > -1) {
      const t2 = this._st || (this._st = { ray: new THREE.Raycaster(), o: new THREE.Vector3(), d: new THREE.Vector3(0, -1, 0) }); const feetY = this.camera.position.y - eye;
      t2.o.copy(pos).addScaledVector(mv.clone().normalize(), PLAYER.radius + 0.06); t2.o.y = feetY + 0.45; t2.ray.set(t2.o, t2.d); t2.ray.far = 0.45; t2.ray.firstHitOnly = true;
      const h = t2.ray.intersectObject(c)[0]; if (h) { const rise = t2.o.y - h.distance - feetY; if (rise > 0.02 && rise <= 0.4) { pos.y = Math.max(pos.y, feetY + rise + 0.01); this.walk.velY = 0; } }
    }
    const t = this._t || (this._t = { box: new THREE.Box3(), seg: new THREE.Line3(), v: new THREE.Vector3(), tri: new THREE.Vector3() });
    t.seg.start.set(pos.x, pos.y + PLAYER.radius, pos.z); t.seg.end.set(pos.x, pos.y + PLAYER.height - PLAYER.radius, pos.z);
    t.box.makeEmpty(); t.box.expandByPoint(t.seg.start); t.box.expandByPoint(t.seg.end); t.box.min.addScalar(-PLAYER.radius); t.box.max.addScalar(PLAYER.radius);
    let grounded = false;
    c.geometry.boundsTree.shapecast({ intersectsBounds: b => b.intersectsBox(t.box), intersectsTriangle: tri => { const d = tri.closestPointToSegment(t.seg, t.tri, t.v); if (d < PLAYER.radius) { const depth = PLAYER.radius - d; const dir = t.v.sub(t.tri).normalize(); if (dir.y < -0.5) return; /* one-way ceilings: a stair can rise through a slab */ t.seg.start.addScaledVector(dir, depth); t.seg.end.addScaledVector(dir, depth); if (dir.y > 0.5) grounded = true; } } });
    this.blockDoors(t.seg); if (grounded) this.walk.velY = 0;
    const feet = t.seg.start.clone(); feet.y -= PLAYER.radius;
    if (feet.y < this.bounds.box.min.y - 3) { const s = this.data.start || this.defaultStart(); feet.fromArray(s.pos); feet.y -= eye; this.walk.velY = 0; }   // fell out of the model
    this.camera.position.set(feet.x, feet.y + eye, feet.z);
  }
  flyStep(dt) {
    const k = this.walk.keys; const sp = PLAYER.flySpeed * (this.walk.run ? 2.5 : 1); const mv = this.moveInput(); const up = (k.KeyE || k.Space ? 1 : 0) - (k.KeyQ || k.KeyC ? 1 : 0);
    this.camera.position.addScaledVector(mv, sp * dt); this.camera.position.y += up * sp * dt;
  }
  look(dx, dy) { const eu = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ'); eu.y -= dx * 0.0025; eu.x = Math.max(-1.45, Math.min(1.45, eu.x - dy * 0.0025)); eu.z = 0; this.camera.quaternion.setFromEuler(eu); }

  bindInput() {
    const c = this.canvas; c.tabIndex = 0;
    document.addEventListener('pointerlockchange', () => { this.walk.locked = document.pointerLockElement === c; this.emit('lock', this.walk.locked); });
    c.addEventListener('mousemove', e => { if (this.walk.locked) this.look(e.movementX, e.movementY); });
    c.addEventListener('pointerdown', e => { this._down = [e.clientX, e.clientY]; if (this.mode !== 'orbit') this.emit('interact'); if (this.mode !== 'orbit' && !this.walk.locked && e.pointerType !== 'mouse') this.walk.look = { id: e.pointerId, x: e.clientX, y: e.clientY }; if (this.mode !== 'orbit' && e.pointerType === 'mouse' && !this.walk.locked) this.walk.look = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }; });
    c.addEventListener('pointermove', e => { const l = this.walk.look; if (!l || e.pointerId !== l.id) return; const dx = e.clientX - l.x, dy = e.clientY - l.y; l.x = e.clientX; l.y = e.clientY; if (l.moved !== undefined) l.moved += Math.abs(dx) + Math.abs(dy); this.look(dx * 1.6, dy * 1.6); });
    const end = () => { this.walk.look = null; }; c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('click', e => {
      if (this.pickHandler) { const hit = this.walk.locked ? this.pickCenter() : this.pick(e.clientX, e.clientY); this.pickHandler(hit, e); return; }
      if (this._down && Math.hypot(e.clientX - this._down[0], e.clientY - this._down[1]) > 6 && !this.walk.locked) return;   // that was a drag, not a click
      if (!this.doors && this.modelRoot) this.findDoors();
      const dh = this.walk.locked ? this.pickDoor() : this.pickDoor(e.clientX, e.clientY); if (dh) { this.toggleDoor(dh.door, dh.point); return; }
      if (this.mode !== 'orbit' && !this.walk.locked && !isTouch) this.lock();
    });
    addEventListener('keydown', e => { if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; this.walk.keys[e.code] = true; if (e.code.startsWith('Shift')) this.walk.run = true; if (e.code === 'Escape' && this.mode !== 'orbit' && !this.walk.locked) this.setMode('orbit'); if (e.code === 'Space' && this.mode !== 'orbit') e.preventDefault(); });
    addEventListener('keyup', e => { this.walk.keys[e.code] = false; if (e.code.startsWith('Shift')) this.walk.run = false; });
    addEventListener('blur', () => { this.walk.keys = {}; this.walk.run = false; });
  }
  bindJoystick(stick) {
    const knob = stick.querySelector('span'); let id = null;
    stick.addEventListener('pointerdown', e => { id = e.pointerId; stick.setPointerCapture(id); });
    stick.addEventListener('pointermove', e => { if (e.pointerId !== id) return; const r = stick.getBoundingClientRect(); let dx = (e.clientX - r.left - r.width / 2) / (r.width / 2), dy = (e.clientY - r.top - r.height / 2) / (r.height / 2); const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; } this.walk.stick.set(dx, dy); knob.style.transform = `translate(${dx * 34}px, ${dy * 34}px)`; });
    const end = e => { if (e.pointerId !== id) return; id = null; this.walk.stick.set(0, 0); knob.style.transform = ''; };
    stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
  }
  static get isTouch() { return isTouch; }

  // ---------- projection for HTML markers ----------
  project(arr) { const v = new THREE.Vector3().fromArray(arr).project(this.camera); const r = this.canvas.getBoundingClientRect(); return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, visible: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 }; }
  occluded(arr) { if (!this.collider) return false; const p = new THREE.Vector3().fromArray(arr); const dir = p.clone().sub(this.camera.position); const dist = dir.length(); const ray = new THREE.Raycaster(this.camera.position, dir.normalize(), 0.05, dist - 0.1); ray.firstHitOnly = true; return ray.intersectObject(this.collider).length > 0; }

  // ---------- scene data ----------
  applyScene(data) {
    this.data = mergeScene(data); if (!this.data.light.preset) this.data.light.preset = 'custom';
    this.applyTransform(); this.applyLights(); this.applyMaterials(); this.applyDecals(); this.applyEnv();
    if (this.modelRoot && !this.data.start) this.data.start = this.defaultStart();
    if (this.mixer) this.mixer.timeScale = this.data.model.animations === false ? 0 : 1;
  }
  setLightPreset(name) { const p = LIGHT_PRESETS[name]; if (!p) return; Object.assign(this.data.light, p, { preset: name }); this.applyLights(); }

  snapshot(w = 480, h = 320) {
    const r = this.renderer; const old = r.getSize(new THREE.Vector2()); const pr = r.getPixelRatio(); const asp = this.camera.aspect;
    r.setPixelRatio(1); r.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); r.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/jpeg', 0.82);
    r.setPixelRatio(pr); r.setSize(old.x, old.y, false); this.camera.aspect = asp; this.camera.updateProjectionMatrix(); return url;
  }

  frame() {
    const c = this.canvas, r = this.renderer; const w = c.clientWidth, h = c.clientHeight, pr = r.getPixelRatio();
    if (c.width !== Math.floor(w * pr) || c.height !== Math.floor(h * pr)) { r.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.mixer && this.data.model.animations !== false) this.mixer.update(dt);
    this.stepLayout(performance.now()); this.stepDoors(dt);
    if (this.tween) { const k = Math.min(1, (performance.now() - this.tween.start) / this.tween.dur), e = easeInOut(k); this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, e); this.orbit.target.lerpVectors(this.tween.t0, this.tween.t1, e); if (k >= 1) this.tween = null; }
    if (this.mode === 'walk') { for (let i = 0; i < 3; i++) this.walkStep(dt / 3); } else if (this.mode === 'fly') this.flyStep(dt); else this.orbit.update();
    if (this.selectionHelper) this.selectionHelper.update();
    for (const f of this.frameHooks) f();
    r.render(this.scene, this.camera);
  }
}
