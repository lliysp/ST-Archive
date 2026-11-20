// @ts-nocheck
/* ============================================================
 * ST-档案馆 · 自绘取色器
 *
 * 色相条 + 明彩面 + 十六进制输入，桌面和手机长得一样。
 * 不用 <input type="color">：安卓点开会弹系统那个三滑块对话框，
 * 样式完全不受控，也很难对准。
 *
 * 用法：
 *   import { openColorPicker } from './color-picker.js';
 *   openColorPicker({ title: '强调色', value: '#a45050', onConfirm: (hex) => {…} });
 * ============================================================ */

const STYLE_ID = 'sa-color-picker-style';

const CSS = `
.sa-cp-dialog {
    position: fixed; inset: 0;
    width: fit-content; height: fit-content;
    border: 0; padding: 0; margin: auto;
    max-width: none; max-height: none;
    background: transparent;
    overflow: visible;
}
.sa-cp-dialog::backdrop {
    background: rgba(24, 18, 16, .62);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
}
.sa-cp-card {
    width: min(92vw, 300px);
    padding: 14px;
    border-radius: 12px;
    box-sizing: border-box;
    background: var(--sa-paper, #FDFBF7);
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), .35);
    box-shadow: 0 18px 50px rgba(0, 0, 0, .38);
    color: var(--sa-ink, #4A4A4A);
    font-family: 'Noto Serif SC', 'Songti SC', serif;
}
.sa-cp-title {
    margin-bottom: 10px;
    font-size: 11px; letter-spacing: 1.6px;
    color: var(--sa-accent-deep, #8b3a3a);
}
.sa-cp-sv {
    position: relative; width: 100%; height: 132px;
    border-radius: 8px; cursor: crosshair; touch-action: none;
    background: linear-gradient(to top, #000, rgba(0, 0, 0, 0)),
        linear-gradient(to right, #fff, #f00);
}
.sa-cp-sv-dot,
.sa-cp-hue-dot {
    position: absolute;
    width: 14px; height: 14px; margin: -7px 0 0 -7px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .35);
    pointer-events: none;
}
.sa-cp-hue {
    position: relative; height: 14px; margin-top: 12px;
    border-radius: 7px; cursor: pointer; touch-action: none;
    background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
}
.sa-cp-hue-dot { top: 50%; }
.sa-cp-io { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.sa-cp-preview {
    width: 34px; height: 30px; flex-shrink: 0;
    border-radius: 6px;
    border: 1px solid rgba(0, 0, 0, .18);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35);
}
.sa-cp-hex {
    flex: 1; min-width: 0; height: 30px; padding: 0 9px;
    border-radius: 6px;
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), .32);
    background: transparent;
    color: var(--sa-ink, #4A4A4A);
    font-family: 'Courier New', Courier, monospace;
    font-size: 12px; letter-spacing: .6px;
    outline: none;
}
.sa-cp-hex:focus { border-color: rgba(var(--sa-accent-rgb, 164, 80, 80), .65); }
.sa-cp-actions { display: flex; gap: 8px; margin-top: 12px; }
.sa-cp-btn {
    flex: 1; height: 36px; padding: 0 12px;
    display: inline-flex; align-items: center; justify-content: center;
    appearance: none; -webkit-appearance: none;
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), .4);
    border-radius: 8px;
    background: transparent;
    color: var(--sa-accent-deep, #8b3a3a);
    font-family: inherit; font-size: 12px; letter-spacing: 1.4px;
    cursor: pointer; box-shadow: none;
    transition: background .18s, opacity .18s;
}
.sa-cp-btn:hover { background: rgba(var(--sa-accent-rgb, 164, 80, 80), .08); }
.sa-cp-btn.is-primary {
    background: rgba(var(--sa-accent-rgb, 164, 80, 80), .85);
    border-color: transparent;
    color: #fff;
}
.sa-cp-btn.is-primary:hover { background: var(--sa-accent, #a45050); }
`;

// ============================================================
// 颜色换算
// ============================================================

function normalizeHex(value) {
    const raw = String(value || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(raw)) {
        return `#${raw.split('').map(ch => ch + ch).join('').toLowerCase()}`;
    }
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
    return '';
}

function hexToRgb(hex) {
    const raw = (normalizeHex(hex) || '#a45050').slice(1);
    return {
        r: parseInt(raw.slice(0, 2), 16),
        g: parseInt(raw.slice(2, 4), 16),
        b: parseInt(raw.slice(4, 6), 16),
    };
}

function hexToHsv(hex) {
    const { r, g, b } = hexToRgb(hex);
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
        if (max === rn) h = ((gn - bn) / delta) % 6;
        else if (max === gn) h = (bn - rn) / delta + 2;
        else h = (rn - gn) / delta + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function hsvToHex(h, s, v) {
    const sat = Math.min(1, Math.max(0, s));
    const val = Math.min(1, Math.max(0, v));
    const c = val * sat;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = val - c;

    let r = 0;
    let g = 0;
    let b = 0;
    if (hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];

    const to = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return `#${to(r)}${to(g)}${to(b)}`;
}

// ============================================================
// 单例 UI
// ============================================================

let dialogEl = null;
let refs = null;
let state = null;

function injectStyle() {
    if (document.getElementById(STYLE_ID) || !document.head) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

function build() {
    if (dialogEl) return;

    injectStyle();

    const dialog = document.createElement('dialog');
    dialog.className = 'sa-cp-dialog';
    dialog.setAttribute('aria-label', '选择颜色');
    dialog.innerHTML = `
        <div class="sa-cp-card">
            <div class="sa-cp-title"></div>
            <div class="sa-cp-sv"><span class="sa-cp-sv-dot"></span></div>
            <div class="sa-cp-hue"><span class="sa-cp-hue-dot"></span></div>
            <div class="sa-cp-io">
                <span class="sa-cp-preview"></span>
                <input type="text" class="sa-cp-hex" maxlength="7" spellcheck="false"
                    autocomplete="off" aria-label="十六进制颜色">
            </div>
            <div class="sa-cp-actions">
                <button type="button" class="sa-cp-btn" data-act="cancel">取消</button>
                <button type="button" class="sa-cp-btn is-primary" data-act="ok">确定</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    dialogEl = dialog;

    refs = {
        title: dialog.querySelector('.sa-cp-title'),
        sv: dialog.querySelector('.sa-cp-sv'),
        svDot: dialog.querySelector('.sa-cp-sv-dot'),
        hue: dialog.querySelector('.sa-cp-hue'),
        hueDot: dialog.querySelector('.sa-cp-hue-dot'),
        preview: dialog.querySelector('.sa-cp-preview'),
        hex: dialog.querySelector('.sa-cp-hex'),
    };

    const track = (el, handler) => {
        const run = (event) => {
            const rect = el.getBoundingClientRect();
            const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
            handler(x, y);
        };
        el.addEventListener('pointerdown', (event) => {
            if (!state) return;
            event.preventDefault();
            try { el.setPointerCapture(event.pointerId); } catch (error) { /* 老浏览器 */ }
            run(event);
        });
        el.addEventListener('pointermove', (event) => {
            if (!state) return;
            if (event.buttons === 0 && !el.hasPointerCapture?.(event.pointerId)) return;
            run(event);
        });
    };

    track(refs.sv, (x, y) => {
        state.hsv.s = x;
        state.hsv.v = 1 - y;
        sync();
    });
    track(refs.hue, (x) => {
        state.hsv.h = x * 360;
        sync();
    });

    refs.hex.addEventListener('input', () => {
        const hex = normalizeHex(refs.hex.value);
        if (!hex) return;
        state.hsv = hexToHsv(hex);
        sync({ keepHex: true });
    });

    dialog.querySelector('[data-act="cancel"]').addEventListener('click', () => close());
    dialog.querySelector('[data-act="ok"]').addEventListener('click', () => {
        const hex = state?.hex;
        const callback = state?.onConfirm;
        close();
        if (hex && typeof callback === 'function') callback(hex);
    });
    dialog.addEventListener('close', () => { state = null; });
}

function sync(options = {}) {
    if (!state) return;
    const { h, s, v } = state.hsv;
    const hex = hsvToHex(h, s, v);
    state.hex = hex;

    refs.sv.style.background = `linear-gradient(to top, #000, rgba(0, 0, 0, 0)), `
        + `linear-gradient(to right, #fff, ${hsvToHex(h, 1, 1)})`;
    refs.svDot.style.left = `${s * 100}%`;
    refs.svDot.style.top = `${(1 - v) * 100}%`;
    refs.hueDot.style.left = `${(h / 360) * 100}%`;
    refs.preview.style.background = hex;
    if (!options.keepHex) refs.hex.value = hex.toUpperCase();
}

function close() {
    if (!dialogEl) return;
    if (typeof dialogEl.close === 'function' && dialogEl.open) {
        try { dialogEl.close(); return; } catch (error) { /* 落到下面 */ }
    }
    dialogEl.removeAttribute('open');
    state = null;
}

/**
 * 打开取色器。
 * @param {{ title?: string, value?: string, onConfirm?: (hex: string) => void }} options
 */
export function openColorPicker(options = {}) {
    build();

    const value = normalizeHex(options.value) || '#a45050';
    state = {
        hsv: hexToHsv(value),
        hex: value,
        onConfirm: options.onConfirm,
    };

    refs.title.textContent = options.title || '选择颜色';
    sync();

    if (typeof dialogEl.showModal === 'function') {
        if (!dialogEl.open) {
            try { dialogEl.showModal(); } catch (error) { dialogEl.setAttribute('open', ''); }
        }
    } else {
        dialogEl.setAttribute('open', '');
    }
    return dialogEl;
}

export { normalizeHex as normalizePickerHex, hsvToHex, hexToHsv };
