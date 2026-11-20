// @ts-nocheck
/* ============================================================
 * ST-档案馆 · 外观配色（theme.js）
 *
 * 三块可调：强调色（暗红那套）/ 纸色 / 墨色。
 * 全部写进 :root 的 CSS 变量，style.css 与 index.js 里的样式
 * 都用 var(--sa-*, 原色) 取值，所以换色即时生效、且解耦。
 *
 * 由 index.js 顶部静态 import：保证在任何界面渲染之前写好变量，
 * 不会出现「先红一下再变绿」的闪烁。
 * ============================================================ */

import { openColorPicker } from './color-picker.js';

const THEME_KEY = 'st_archive_theme';

// 默认值 = 插件原本写死的颜色，一像素都不变
const DEFAULT_THEME = Object.freeze({
    accent: '#a45050',
    paper: '#FDFBF7',
    ink: '#4A4A4A',
    deep: '#8b3a3a',
    bright: '#b24747',
    paperDeep: '#F8F2E9',
    inkStrong: '#333333',
});

const THEME_PRESETS = [
    { name: '暗红', accent: '#a45050', paper: '#FDFBF7', ink: '#4A4A4A' },
    { name: '松绿', accent: '#4E7A5E', paper: '#F7F9F5', ink: '#33453A' },
    { name: '藏青', accent: '#3F5C7A', paper: '#F6F8FA', ink: '#2F3D4A' },
    { name: '墨紫', accent: '#6B4A72', paper: '#F8F5F9', ink: '#413145' },
    { name: '茶褐', accent: '#8A6A45', paper: '#FAF6EF', ink: '#443A2E' },
    { name: '素灰', accent: '#6E6E6E', paper: '#F7F7F6', ink: '#383838' },
];

// ============================================================
// 颜色小工具
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
    const raw = normalizeHex(hex) || DEFAULT_THEME.accent;
    const value = raw.slice(1);
    return {
        r: parseInt(value.slice(0, 2), 16),
        g: parseInt(value.slice(2, 4), 16),
        b: parseInt(value.slice(4, 6), 16),
    };
}

function rgbTriplet(hex) {
    const { r, g, b } = hexToRgb(hex);
    return `${r}, ${g}, ${b}`;
}

function mixHex(from, to, ratio) {
    const a = hexToRgb(from);
    const b = hexToRgb(to);
    const t = Math.min(1, Math.max(0, ratio));
    const channel = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`;
}

function relativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const channel = (value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground, background) {
    const l1 = relativeLuminance(foreground);
    const l2 = relativeLuminance(background);
    const light = Math.max(l1, l2);
    const dark = Math.min(l1, l2);
    return (light + 0.05) / (dark + 0.05);
}

// ============================================================
// 读写与派生
// ============================================================

function getThemeContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch (error) {
        console.warn('[ST-档案馆·外观] 读取酒馆上下文失败', error);
        return null;
    }
}

function readTheme() {
    const ctx = getThemeContext();
    const raw = ctx?.extensionSettings?.[THEME_KEY];
    const accent = normalizeHex(raw?.accent) || DEFAULT_THEME.accent;
    const paper = normalizeHex(raw?.paper) || DEFAULT_THEME.paper;
    const ink = normalizeHex(raw?.ink) || DEFAULT_THEME.ink;
    return { accent, paper, ink };
}

function saveTheme(theme) {
    const ctx = getThemeContext();
    if (!ctx?.extensionSettings) return;
    ctx.extensionSettings[THEME_KEY] = { ...theme };
    try {
        ctx.saveSettingsDebounced?.();
    } catch (error) {
        console.warn('[ST-档案馆·外观] 保存配色失败', error);
    }
}

/**
 * 由三个主色派生出全部色阶。
 * 三个主色都等于默认值时，直接返回插件原本的写死色，保证零视觉变化。
 */
function deriveTheme(theme) {
    const accent = normalizeHex(theme.accent) || DEFAULT_THEME.accent;
    const paper = normalizeHex(theme.paper) || DEFAULT_THEME.paper;
    const ink = normalizeHex(theme.ink) || DEFAULT_THEME.ink;
    const isDefault = accent === DEFAULT_THEME.accent
        && paper === DEFAULT_THEME.paper
        && ink === DEFAULT_THEME.ink;

    return {
        accent,
        paper,
        ink,
        deep: isDefault ? DEFAULT_THEME.deep : mixHex(accent, '#000000', 0.15),
        bright: isDefault ? DEFAULT_THEME.bright : mixHex(accent, '#ffffff', 0.12),
        paperDeep: isDefault ? DEFAULT_THEME.paperDeep : mixHex(paper, ink, 0.045),
        inkStrong: isDefault ? DEFAULT_THEME.inkStrong : mixHex(ink, '#000000', 0.2),
    };
}

function applyTheme(theme) {
    const derived = deriveTheme(theme);
    const root = document.documentElement;
    if (!root) return derived;

    const set = (name, value) => root.style.setProperty(name, value);
    set('--sa-accent', derived.accent);
    set('--sa-accent-rgb', rgbTriplet(derived.accent));
    set('--sa-accent-deep', derived.deep);
    set('--sa-accent-bright', derived.bright);
    set('--sa-paper', derived.paper);
    set('--sa-paper-deep', derived.paperDeep);
    set('--sa-ink', derived.ink);
    set('--sa-ink-rgb', rgbTriplet(derived.ink));
    set('--sa-ink-strong', derived.inkStrong);

    return derived;
}

/**
 * 纸色 / 墨色的生效范围（重要）：
 * 只作用于「导出」——导出浮层与导出卡片。
 * 拾遗面板、详情弹窗、首页档案馆刻意做成半透明 + 跟随酒馆主题，
 * 这里不接管、不覆盖，避免破坏原设计的通透感。
 */

// ============================================================
// 设置面板
// ============================================================

const SETTINGS_HOST_IDS = ['extensions_settings2', 'extensions_settings'];
let settingsAttempts = 0;

function settingsStyle() {
    if (document.getElementById('sa-theme-style')) return;
    const style = document.createElement('style');
    style.id = 'sa-theme-style';
    style.textContent = `
        #sa-theme-settings .sa-theme-row {
            display: flex; align-items: center; gap: 8px;
            margin: 7px 0; font-size: 13px;
        }
        #sa-theme-settings .sa-theme-row > span:first-child {
            min-width: 52px; opacity: .85;
        }
        #sa-theme-settings .sa-theme-swatch {
            width: 46px; height: 24px; padding: 0;
            border-radius: 4px;
            border: 1px solid rgba(0, 0, 0, .18);
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35);
            cursor: pointer;
            background: #a45050;
            transition: transform .15s;
        }
        #sa-theme-settings .sa-theme-swatch:hover { transform: scale(1.06); }
        #sa-theme-settings .sa-theme-hex {
            font-family: 'Courier New', Courier, monospace;
            font-size: 11px; opacity: .55; letter-spacing: .5px;
        }
        #sa-theme-settings .sa-theme-presets {
            display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0 8px;
        }
        #sa-theme-settings .sa-theme-preset {
            width: 26px; height: 26px; padding: 0; border-radius: 50%;
            border: 1px solid rgba(128, 128, 128, .35);
            cursor: pointer; box-shadow: none;
        }
        #sa-theme-settings .sa-theme-preset:hover {
            transform: scale(1.12);
            border-color: var(--sa-accent, #a45050);
        }
        /* 恢复默认：跟色卡同尺寸的圆形图标按钮 */
        #sa-theme-settings .sa-theme-reset {
            width: 26px; height: 26px; padding: 0;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 50%; cursor: pointer; box-shadow: none;
            border: 1px dashed rgba(var(--sa-ink-rgb, 74, 74, 74), 0.45);
            background: transparent;
            color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.75);
            transition: color 0.2s, border-color 0.2s, transform 0.2s;
        }
        #sa-theme-settings .sa-theme-reset:hover {
            color: var(--sa-accent, #a45050);
            border-color: var(--sa-accent, #a45050);
            transform: rotate(-30deg);
        }
        #sa-theme-settings .sa-theme-reset svg { display: block; pointer-events: none; }
        #sa-theme-settings .sa-theme-preview {
            display: flex; align-items: center; gap: 8px;
            margin: 10px 0 6px; padding: 9px 11px;
            border: 1px solid var(--sa-accent, #a45050);
            border-left-width: 3px;
            border-radius: 6px;
            background: var(--sa-paper, #FDFBF7);
            color: var(--sa-ink, #4A4A4A);
            font-family: 'Noto Serif SC', 'Songti SC', serif;
            font-size: 12px; letter-spacing: 1px;
        }
        #sa-theme-settings .sa-theme-preview em {
            margin-left: auto; font-style: normal; font-size: 10px;
            color: var(--sa-accent, #a45050);
            font-family: 'Courier New', Courier, monospace;
        }
        #sa-theme-settings .sa-theme-warn {
            margin: 6px 0 0; font-size: 11px; line-height: 1.6;
            color: #c0392b;
        }
        #sa-theme-settings .sa-theme-hint {
            margin: 8px 0 0; font-size: 11px; line-height: 1.6;
            opacity: .55;
        }
        #sa-theme-settings .sa-theme-footer {
            display: flex; align-items: center; gap: 8px; margin-top: 10px;
        }
    `;
    document.head.appendChild(style);
}

function buildSettingsPanel() {
    if (document.getElementById('sa-theme-settings')) return;

    const host = SETTINGS_HOST_IDS
        .map(id => document.getElementById(id))
        .find(Boolean);

    if (!host) {
        if (settingsAttempts++ < 40) setTimeout(buildSettingsPanel, 500);
        return;
    }

    settingsStyle();

    const wrap = document.createElement('div');
    wrap.id = 'sa-theme-settings';
    wrap.className = 'sa-theme-settings';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>ST-档案馆 · 外观</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="sa-theme-row">
                    <span>强调色</span>
                    <button type="button" class="sa-theme-swatch" data-slot="accent" data-label="强调色" aria-label="强调色"></button>
                    <span class="sa-theme-hex" data-hex="accent"></span>
                </div>
                <div class="sa-theme-row">
                    <span>纸色</span>
                    <button type="button" class="sa-theme-swatch" data-slot="paper" data-label="纸色" aria-label="纸色"></button>
                    <span class="sa-theme-hex" data-hex="paper"></span>
                </div>
                <div class="sa-theme-row">
                    <span>墨色</span>
                    <button type="button" class="sa-theme-swatch" data-slot="ink" data-label="墨色" aria-label="墨色"></button>
                    <span class="sa-theme-hex" data-hex="ink"></span>
                </div>
                <div class="sa-theme-presets"></div>
                <div class="sa-theme-preview">
                    <span>拾遗 · 档案馆</span>
                    <em>CONFIDENTIAL</em>
                </div>
                <div class="sa-theme-warn" hidden></div>
                <p class="sa-theme-hint">强调色作用于所有暗红元素；纸色 / 墨色只作用于导出浮层与导出卡片 —— 拾遗面板、详情弹窗这些半透明的底保持跟随酒馆主题，不受影响。</p>
            </div>
        </div>
    `;
    host.appendChild(wrap);

    const swatches = {};
    wrap.querySelectorAll('.sa-theme-swatch').forEach(button => {
        const slot = button.dataset.slot;
        swatches[slot] = button;
        button.addEventListener('click', () => {
            openColorPicker({
                title: `${button.dataset.label || slot}`,
                value: readTheme()[slot],
                onConfirm: (hex) => {
                    const theme = readTheme();
                    theme[slot] = hex;
                    applyTheme(theme);
                    saveTheme(theme);
                    syncPanel();
                },
            });
        });
    });

    const presetBox = wrap.querySelector('.sa-theme-presets');
    THEME_PRESETS.forEach(preset => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sa-theme-preset';
        button.title = preset.name;
        button.setAttribute('aria-label', preset.name);
        button.style.background = `linear-gradient(135deg, ${preset.accent} 0 50%, ${preset.paper} 50% 100%)`;
        button.addEventListener('click', () => {
            const next = { accent: preset.accent, paper: preset.paper, ink: preset.ink };
            applyTheme(next);
            saveTheme(next);
            syncPanel();
        });
        presetBox.appendChild(button);
    });

    // 恢复默认：圆形图标按钮，跟在色卡后面
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'sa-theme-reset';
    resetButton.title = '恢复默认配色';
    resetButton.setAttribute('aria-label', '恢复默认配色');
    resetButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3.2 12a8.8 8.8 0 1 0 2.9-6.5" />
            <path d="M3 4.2v4.6h4.6" />
        </svg>`;
    presetBox.appendChild(resetButton);

    resetButton.addEventListener('click', () => {
        const next = { ...DEFAULT_THEME };
        applyTheme(next);
        saveTheme({ accent: next.accent, paper: next.paper, ink: next.ink });
        syncPanel();
    });

    function syncPanel() {
        const theme = readTheme();
        Object.entries(swatches).forEach(([slot, button]) => {
            button.style.background = theme[slot];
        });
        wrap.querySelectorAll('[data-hex]').forEach(label => {
            label.textContent = theme[label.dataset.hex].toUpperCase();
        });

        const ratio = contrastRatio(theme.ink, theme.paper);
        const warn = wrap.querySelector('.sa-theme-warn');
        if (ratio < 3) {
            warn.hidden = false;
            warn.textContent = `墨色与纸色对比度只有 ${ratio.toFixed(1)}:1，字会看不清，建议把墨色调更亮或纸色调更暗。`;
        } else {
            warn.hidden = true;
            warn.textContent = '';
        }
    }

    syncPanel();
}

// ============================================================
// 启动
// ============================================================

// 先落变量：这一步必须早于 index.js 建界面
applyTheme(readTheme());

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildSettingsPanel, { once: true });
} else {
    buildSettingsPanel();
}

// 调试用
globalThis.STArchiveTheme = Object.freeze({
    DEFAULT_THEME,
    PRESETS: THEME_PRESETS,
    read: readTheme,
    apply: applyTheme,
    contrast: contrastRatio,
});
