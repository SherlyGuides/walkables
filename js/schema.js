// Scene schema: what a Walkable scene bundle looks like. scene.json in every scene folder follows this.
export const SCHEMA_VERSION = 1;

export const LIGHT_PRESETS = {
  daylight: { sunElev: 55, sunAzim: 210, sunIntensity: 1.4, sunColor: '#fff6e8', ambient: 0.5, envIntensity: 1.0, exposure: 1.05, shadows: true, interior: false, tone: 'aces' },
  overcast: { sunElev: 70, sunAzim: 180, sunIntensity: 0.4, sunColor: '#f2f5fa', ambient: 1.0, envIntensity: 1.2, exposure: 1.0, shadows: false, interior: false, tone: 'aces' },
  evening:  { sunElev: 14, sunAzim: 260, sunIntensity: 1.7, sunColor: '#ffc98a', ambient: 0.3, envIntensity: 0.6, exposure: 0.95, shadows: true, interior: false, tone: 'aces' },
  studio:   { sunElev: 60, sunAzim: 200, sunIntensity: 0.0, sunColor: '#ffffff', ambient: 0.9, envIntensity: 1.4, exposure: 1.0, shadows: false, interior: false, tone: 'aces' },
  // indoors: light falls through the ceiling like a skylight so furniture and walls cast soft shadows; colours mapped true
  interior: { sunElev: 64, sunAzim: 215, sunIntensity: 2.0, sunColor: '#fff3e2', ambient: 0.34, envIntensity: 0.6, exposure: 0.92, shadows: true, interior: true, tone: 'neutral' },
};

export function defaultScene() {
  return {
    version: SCHEMA_VERSION,
    name: 'Untitled scene',
    caption: '',
    theme: 'auto',                                    // auto | light | dark
    brand: { firm: '', logo: null, accent: '#1f4e79', invertDark: false, watermark: true },
    model: { file: 'model.glb', scale: 1, upAxis: 'y', animations: true, stats: null },
    start: null,                                      // { pos:[x,y,z], yaw, pitch } eye position, set by the architect
    player: { eye: 1.45, speed: 2.2, doors: true },   // doors: walk through door leaves
    light: { preset: 'interior', ...LIGHT_PRESETS.interior, background: 'auto' },
    env: { ceiling: 'walk', ground: true, grid: true, edges: true, garden: true },   // ceiling: walk | always | off; edges: soft lines on corners; garden: lawn and sky outside
    materials: {},                                    // 'mesh:<key>' | 'mat:<name>' -> { color, roughness, metalness, hidden }
    plaque: null,                                     // { pos, normal, width }
    media: [],                                        // { id, file, kind:'image'|'video', pos, normal, width, loop }
    views: [],                                        // { name, pos:[...], target:[...] }
    notes: [],                                        // { id, pos:[...], title, text }
    plan: null,                                       // file name of the floor plan image or pdf
    attachments: [],                                  // { name, file }
    layouts: null,                                    // { file, default, options:[{ key, name }] } furniture arrangements: file maps node name -> { key: 16-number matrix }
    modes: { default: 'walk', walk: true, fly: true, orbit: true },
  };
}

export function mergeScene(partial) {
  const d = defaultScene();
  if (!partial || typeof partial !== 'object') return d;
  const out = { ...d, ...partial };
  for (const k of ['brand', 'model', 'player', 'light', 'env', 'modes']) out[k] = { ...d[k], ...(partial[k] || {}) };
  if (partial.light && partial.light.preset && LIGHT_PRESETS[partial.light.preset]) out.light = { ...d.light, ...LIGHT_PRESETS[partial.light.preset], ...partial.light };   // a saved preset keeps its own interior/tone
  out.materials = partial.materials || {};
  out.media = Array.isArray(partial.media) ? partial.media : [];
  out.views = Array.isArray(partial.views) ? partial.views : [];
  out.notes = Array.isArray(partial.notes) ? partial.notes : [];
  out.attachments = Array.isArray(partial.attachments) ? partial.attachments : [];
  out.layouts = partial.layouts && Array.isArray(partial.layouts.options) && partial.layouts.file ? partial.layouts : null;
  return out;
}

export function uid() { return Math.random().toString(36).slice(2, 10); }

// relative luminance contrast, used to decide whether the firm's accent can be used as a fill
export function contrast(hexA, hexB) {
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); const c = [16, 8, 0].map(s => ((n >> s) & 255) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const a = lum(hexA), b = lum(hexB); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
