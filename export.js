// @ts-nocheck
/* ============================================================
 * ST-档案馆 · 拾遗卡片导出（v1.0.0）
 *
 * 独立模块，不参与原有拾遗 / 档案馆逻辑：
 *   1. 书签详情弹窗右上角注入「导出」按钮
 *   2. 八套卡片模板（档案馆 / 拍立得 / 信纸 / 小报 / 明信片 / 日记 / 朋友圈 / 晋江评论）
 *   3. 微调：字号三档、字体四款、三块配色、占位文案
 *   4. 预览 → 保存为图片
 *
 * 加载方式：由 index.js 末尾 `import('./export.js')` 引入，
 * 保证原插件先完成初始化，本模块只做「附加」。
 * 依赖：SillyTavern 全局上下文 + 浏览器原生 Canvas2D，无第三方库。
 * ============================================================ */

import { openColorPicker } from './color-picker.js';

const CARD = 1080; // 兼容旧调用：默认设计宽度
const CARD_W = 1080; // 卡片逻辑宽度；宽度不是硬约束，模板按它布局
const CARD_H_MIN = 1080; // 短文本仍保持方形
const CARD_H_MAX = 1920; // 16:9 竖屏上限；导出最高 3840，避开 iOS 4096 限制
const STATE_KEY = 'st_archive'; // 与 index.js 的 ARCHIVE_STATE_KEY 保持一致
const EXPORT_SETTINGS_KEY = 'st_archive_export'; // 导出偏好（模板/字号/字体/配色）
const EXPORT_PIXEL_RATIO = 2; // 导出倍率：1080 → 2160，最高 2160×3840
const TOAST_MS = 2200;

// 设计稿里固定出现的装饰文案：这里的文字作为默认值，用户可在「微调 · 文案」里改写
const DECOR_COMMENT = '满堂花醉三千客，一剑霜寒十四州';
const DECOR_TEXT = {
    polaroid: 'just a flicker of light in the vast dark',
    collage: 'I have been collecting words like others collect coins, each one a small treasure pressed between the pages of my memory.',
    diaryMargin: 'a quiet little page',
    momentsComment: DECOR_COMMENT,
    jinjiangComment: DECOR_COMMENT,
};

// 拍立得互动栏：设计稿上的装饰数字，不接真实数据
const DECOR_STATS = { like: '520', comment: '1314', star: '999' };

// 每套模板可自定义的装饰文案；key 同时用于保存到导出偏好
const TEMPLATE_TEXT_FIELDS = {
    polaroid: [
        { key: 'polaroidFooter', label: '底部一行', def: DECOR_TEXT.polaroid },
    ],
    collage: [
        { key: 'collageQuote', label: '右侧摘抄', def: DECOR_TEXT.collage, multiline: true },
    ],
    diary: [
        { key: 'diaryNote', label: '便签英文', def: DECOR_TEXT.polaroid, multiline: true },
        { key: 'diaryMargin', label: '旁注', def: DECOR_TEXT.diaryMargin },
    ],
    moments: [
        { key: 'momentsComment', label: '评论', def: DECOR_TEXT.momentsComment },
    ],
    jinjiang: [
        { key: 'jinjiangComment', label: '评论', def: DECOR_TEXT.jinjiangComment },
    ],
};

const DEFAULT_DECOR_TEXTS = Object.values(TEMPLATE_TEXT_FIELDS)
    .flat()
    .reduce((acc, field) => { acc[field.key] = field.def; return acc; }, {});

/** 合并用户文案与默认值：留空 / 非字符串时回退到默认语句 */
function resolveDecorTexts(texts) {
    const resolved = { ...DEFAULT_DECOR_TEXTS };
    if (texts && typeof texts === 'object') {
        Object.keys(resolved).forEach(key => {
            const value = texts[key];
            if (typeof value === 'string' && value.trim()) resolved[key] = value.trim();
        });
    }
    return resolved;
}

const MONO_STACK = "'Courier New',Consolas,'Noto Sans Mono CJK SC','Sarasa Mono SC',monospace";
const SERIF_EN = "Georgia,'Times New Roman',serif";

// 可选的内置楷体：放了 fonts/LXGWWenKaiLite-Regular.ttf 就用它，没放就回退系统楷体。
// 见 fonts/README.md。
const BUNDLED_KAI_FAMILY = 'SA Kai';
const BUNDLED_KAI_FILE = 'LXGWWenKaiLite-Regular.ttf';
const BUNDLED_KAI_URL = (() => {
    try {
        return new URL(`./fonts/${BUNDLED_KAI_FILE}`, import.meta.url).href;
    } catch (error) {
        return `fonts/${BUNDLED_KAI_FILE}`;
    }
})();

let bundledKaiPromise = null;

/** 尝试注册内置楷体；返回 Promise<boolean>（是否可用）。只加载一次。 */
function ensureBundledKai() {
    if (bundledKaiPromise) return bundledKaiPromise;

    bundledKaiPromise = (async () => {
        if (typeof FontFace !== 'function' || typeof document.fonts?.add !== 'function') return false;
        try {
            const face = new FontFace(BUNDLED_KAI_FAMILY, `url("${BUNDLED_KAI_URL}")`, { display: 'swap' });
            await face.load();
            document.fonts.add(face);
            return true;
        } catch (error) {
            console.info(
                `[ST-档案馆·导出] 未找到内置楷体（fonts/${BUNDLED_KAI_FILE}），本次回退系统楷体。`
                + '想要各设备一致，按 fonts/README.md 放进字体文件即可。',
            );
            return false;
        }
    })();

    return bundledKaiPromise;
}

const FONT_STYLES = [
    { key: 'song', label: '宋体', stack: "'Noto Serif SC','Source Han Serif SC','Songti SC','STSong',SimSun,serif" },
    { key: 'kai', label: '楷体', stack: `'${BUNDLED_KAI_FAMILY}','Kaiti SC','STKaiti',KaiTi,'Kaiti TC','Noto Serif SC',serif` },
    { key: 'hei', label: '黑体', stack: "'PingFang SC','Noto Sans SC','Source Han Sans SC','Microsoft YaHei',Heiti,sans-serif" },
    { key: 'mono', label: '等宽', stack: "'Courier New',Consolas,'Noto Sans Mono CJK SC','Sarasa Mono SC',monospace" },
];
const FONT_BY_KEY = FONT_STYLES.reduce((acc, item) => { acc[item.key] = item; return acc; }, {});

const SIZE_STEPS = [
    { key: 's', label: '小', scale: 0.86 },
    { key: 'm', label: '中', scale: 1 },
    { key: 'l', label: '大', scale: 1.16 },
];

// ============================================================
// 一、基础工具
// ============================================================

function hexToRgb(hex) {
    let raw = String(hex || '').trim().replace(/^#/, '');
    if (raw.length === 3) raw = raw.split('').map(ch => ch + ch).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(raw)) raw = 'a45050';
    return {
        r: parseInt(raw.slice(0, 2), 16),
        g: parseInt(raw.slice(2, 4), 16),
        b: parseInt(raw.slice(4, 6), 16),
    };
}

function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}


function mixColor(from, to, ratio) {
    const a = hexToRgb(from);
    const b = hexToRgb(to);
    const t = Math.min(1, Math.max(0, ratio));
    const channel = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`;
}

function normalizeText(value) {
    return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeFileSegment(value, fallback) {
    const cleaned = String(value ?? '')
        .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || fallback;
}

// ============================================================
// 二、文字排版
// 画布没有 CSS 排版，断行 / 居中 / 缩放全部自己算。
// 中文没有空格，按「字」断；英文按「词」断。
// ============================================================

const NO_LINE_START = '，。、；：？！）」』】》〉…—～·,.!?;:)]}%';

function setFont(ctx, size, stack, weight = '400', style = 'normal') {
    ctx.font = `${style} ${weight} ${Math.max(1, size).toFixed(2)}px ${stack}`;
}

function measureTracked(ctx, str, tracking = 0) {
    if (!str) return 0;
    // 没有字距时整串一次量完：比逐字相加快得多，也更接近实际 fillText 的宽度
    if (!tracking) return ctx.measureText(str).width;
    let width = 0;
    for (const ch of str) width += ctx.measureText(ch).width + tracking;
    return width;
}

function drawTracked(ctx, str, x, y, tracking) {
    if (!tracking) {
        ctx.fillText(str, x, y);
        return;
    }
    let cursor = x;
    for (const ch of str) {
        ctx.fillText(ch, cursor, y);
        cursor += ctx.measureText(ch).width + tracking;
    }
}

/**
 * 画一行文字（带字距、对齐）。
 * o: { size, stack, weight, style, color, tracking, align }
 */
function text(ctx, str, x, y, o) {
    if (str === undefined || str === null || str === '') return;
    setFont(ctx, o.size, o.stack, o.weight, o.style);
    ctx.fillStyle = o.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    const tracking = o.tracking || 0;
    const total = measureTracked(ctx, str, tracking);
    let startX = x;
    if (o.align === 'center') startX = x - total / 2;
    else if (o.align === 'right') startX = x - total;
    drawTracked(ctx, str, startX, y, tracking);
}


function splitUnits(para, maxWidth) {
    // 把段落切成不可再分的排版单元：英文单词 / 单字 / 空格
    const units = [];
    const chars = Array.from(String(para));
    let buffer = '';

    const flushWord = () => {
        if (!buffer) return;
        units.push(buffer);
        buffer = '';
    };

    for (const ch of chars) {
        if (/\s/.test(ch)) {
            flushWord();
            units.push(' ');
            continue;
        }
        // 拉丁字母 / 数字 / 连字符 视为一个词的组成部分
        if (/[A-Za-z0-9'’\-_@#&/.%+]/.test(ch)) {
            buffer += ch;
            continue;
        }
        flushWord();
        units.push(ch);
    }
    flushWord();

    return units;
}

/**
 * 按宽度断行，返回行数组。
 * 支持显式换行（\n）与中文避头标点。
 */
function wrapText(ctx, str, maxWidth, size, stack, weight, tracking, style = 'normal') {
    setFont(ctx, size, stack, weight, style);
    const lines = [];
    const paragraphs = String(str ?? '').split(/\r?\n/);

    // 同一次断行里同一个字/词会反复出现（中文尤其明显），量一次就够。
    const widthCache = new Map();
    const widthOf = (unit) => {
        let w = widthCache.get(unit);
        if (w === undefined) {
            w = tracking ? measureTracked(ctx, unit, tracking) : ctx.measureText(unit).width;
            widthCache.set(unit, w);
        }
        return w;
    };

    for (const para of paragraphs) {
        if (!para.trim()) {
            lines.push('');
            continue;
        }

        const units = splitUnits(para);
        let line = '';
        let lineWidth = 0;
        let hasContent = false;

        for (const unit of units) {
            if (unit === ' ') {
                if (!hasContent) continue; // 行首空格丢掉
                line += unit;
                lineWidth += widthOf(unit);
                continue;
            }

            const unitWidth = widthOf(unit);
            const unitChars = Array.from(unit);

            // 超长英文串直接按字硬断，避免戳出卡片
            if (unitWidth > maxWidth && unitChars.length > 1) {
                for (const ch of unitChars) {
                    const chWidth = widthOf(ch);
                    if (lineWidth + chWidth > maxWidth && hasContent) {
                        lines.push(line.replace(/\s+$/, ''));
                        line = ch;
                        lineWidth = chWidth;
                        hasContent = true;
                    } else {
                        line += ch;
                        lineWidth += chWidth;
                        hasContent = true;
                    }
                }
                continue;
            }

            if (lineWidth + unitWidth > maxWidth && hasContent) {
                // 避头：标点不该出现在行首，允许轻微挤压到上一行
                if (NO_LINE_START.includes(unit[0]) && lineWidth + unitWidth <= maxWidth * 1.06) {
                    line += unit;
                    lineWidth += unitWidth;
                    continue;
                }
                lines.push(line.replace(/\s+$/, ''));
                line = unit;
                lineWidth = unitWidth;
                hasContent = true;
            } else {
                line += unit;
                lineWidth += unitWidth;
                hasContent = true;
            }
        }

        if (line.trim()) lines.push(line.replace(/\s+$/, ''));
        else if (!lines.length) lines.push('');
    }

    return lines;
}

let lastRenderTruncated = false;

function isLastRenderTruncated() {
    return lastRenderTruncated;
}

// 布局阶段用的离屏上下文：只做文字测量，不参与最终绘制。
let measureContext = null;
function getMeasureContext() {
    if (measureContext) return measureContext;
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    measureContext = canvas.getContext('2d');
    return measureContext;
}

// 按指定倍率排一次：字号、行高、断行结果。
function layoutAtScale(ctx, str, o, scale) {
    const size = o.size * scale;
    const lh = o.lineGap ?? (size * (o.lineHeight ?? 1.85));
    const lines = wrapText(ctx, str, o.width, size, o.stack, o.weight, o.tracking || 0, o.style || 'normal');
    return { size, lh, lines };
}

/**
 * 自适应字号：从基准字号往下收，直到行数 * 行高放得下。
 * 收到下限还放不下就截断并补省略号（不出长图）。
 *
 * 不再从 1 开始每 0.045 试一遍：先按「高度 ≈ 字号²」估一个接近的倍率，
 * 再往下微调。超长文本通常一两次排版就能判定要截断，手机上少卡很多。
 */
function fitTextBlock(ctx, str, o, base = null) {
    const { maxHeight, minScale = 0.6 } = o;

    const first = base || layoutAtScale(ctx, str, o, 1);
    if (first.lines.length * first.lh <= maxHeight) {
        return { ...first, truncated: false };
    }

    // 固定行距（信纸）时高度随字号线性变化；普通行高时高度约与字号平方成正比
    const actualH = Math.max(1, first.lines.length * first.lh);
    const targetH = Math.max(1, maxHeight);
    const estimate = o.lineGap != null
        ? targetH / actualH
        : Math.sqrt(targetH / actualH);

    // 从估算值上方一点开始往下扫，估偏了也能兜住
    let start = Math.min(1, Math.max(0, estimate) * 1.12 + 0.02);
    for (let scale = start; scale >= minScale - 1e-6; scale -= 0.045) {
        const candidate = layoutAtScale(ctx, str, o, scale);
        if (candidate.lines.length * candidate.lh <= maxHeight) {
            return { ...candidate, truncated: false };
        }
    }

    // 收到下限仍然放不下：截断
    const last = layoutAtScale(ctx, str, o, minScale);
    const { size, lh } = last;
    const maxLines = Math.max(1, Math.floor(maxHeight / lh));
    let lines = last.lines;
    const truncated = lines.length > maxLines;
    if (truncated) {
        lines = lines.slice(0, maxLines);
        const tail = lines[maxLines - 1] ?? '';
        lines[maxLines - 1] = ellipsize(ctx, tail, o.width, size, o.stack, o.weight, o.tracking || 0, o.style || 'normal');
    }
    return { size, lh, lines, truncated };
}

/**
 * 可变高度版：先按基准字号完整排版，放得下就保留原字号；
 * 只有超过 maxHeight 时才缩字号，缩到下限仍放不下才截断。
 */
function fitTextBlockAuto(ctx, str, o) {
    const first = layoutAtScale(ctx, str, o, 1);
    if (first.lines.length * first.lh <= o.maxHeight) {
        return { ...first, truncated: false };
    }
    return fitTextBlock(ctx, str, o, first);
}

function ellipsize(ctx, line, width, size, stack, weight, tracking, style = 'normal') {
    setFont(ctx, size, stack, weight, style);
    let chars = Array.from(line);
    // 去掉一个字符，留位置给省略号
    while (chars.length > 1 && measureTracked(ctx, chars.join('') + '…', tracking) > width) {
        chars.pop();
    }
    return chars.join('').replace(/\s+$/, '') + '…';
}

/** 单行标题：超出宽度就缩字号 */
function fitSingleLine(ctx, str, o) {
    const minSize = o.minSize ?? 16;
    let size = o.size;
    setFont(ctx, size, o.stack, o.weight, o.style);
    while (size > minSize && measureTracked(ctx, str, o.tracking || 0) > o.width) {
        size -= 1;
        setFont(ctx, size, o.stack, o.weight, o.style);
    }
    return size;
}

/**
 * 画一个文字块。top 是块顶边，行高由 block.lh 决定。
 * 基线位置按 (lh - size)/2 + 0.86 * size 估算，中英文都能落在视觉中线上。
 */
function drawTextBlock(ctx, block, x, top, o) {
    const align = o.align || 'left';
    block.lines.forEach((line, index) => {
        const baseline = top + index * block.lh + (block.lh - block.size) / 2 + block.size * 0.86;
        text(ctx, line, x, baseline, {
            size: block.size,
            stack: o.stack,
            weight: o.weight,
            style: o.style,
            color: o.color,
            tracking: o.tracking || 0,
            align,
        });
    });
}

// ============================================================
// 三、绘制零件
// ============================================================

function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
}

function strokeDashRect(ctx, x, y, w, h, color, lineWidth, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
}

function dashedLine(ctx, x1, y1, x2, y2, color, lineWidth, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
}

function drawHeart(ctx, cx, cy, size, color) {
    const s = size / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, s * 0.86);
    ctx.bezierCurveTo(-s * 1.65, -s * 0.32, -s * 0.62, -s * 1.34, 0, -s * 0.44);
    ctx.bezierCurveTo(s * 0.62, -s * 1.34, s * 1.65, -s * 0.32, 0, s * 0.86);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function drawBubble(ctx, cx, cy, w, color, lineWidth) {
    const h = w * 0.78;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, w * 0.24);
    ctx.stroke();
    // 小尾巴
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.18, cy + h / 2 - 1);
    ctx.lineTo(cx - w * 0.26, cy + h / 2 + w * 0.2);
    ctx.lineTo(cx - w * 0.02, cy + h / 2 - 1);
    ctx.stroke();
    // 三个点
    ctx.fillStyle = color;
    [-1, 0, 1].forEach(offset => {
        ctx.beginPath();
        ctx.arc(cx + offset * w * 0.21, cy, w * 0.052, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

function drawStar(ctx, cx, cy, radius, color, lineWidth) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? radius : radius * 0.44;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
}

/** 翻页指示：< ○ ● ○ >，中间实心是当前页 */
function drawPager(ctx, cx, cy, size, color) {
    const r = size * 0.26;
    const sp = r * 2.6;
    const bw = size * 0.3;
    const bh = size * 0.46;
    const pad = size * 0.16;
    const width = bw * 2 + pad * 2 + r * 2 * 3 + (sp - r * 2) * 2;

    let x = cx - width / 2;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.6, size * 0.08);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // <
    ctx.beginPath();
    ctx.moveTo(x + bw, cy - bh / 2);
    ctx.lineTo(x, cy);
    ctx.lineTo(x + bw, cy + bh / 2);
    ctx.stroke();
    x += bw + pad + r;

    // ○ ● ○
    [false, true, false].forEach((solid, index) => {
        const px = x + index * sp;
        ctx.beginPath();
        ctx.arc(px, cy, r * 0.88, 0, Math.PI * 2);
        if (solid) ctx.fill();
        else ctx.stroke();
    });
    x += sp * 2 + r + pad;

    // >
    ctx.beginPath();
    ctx.moveTo(x, cy - bh / 2);
    ctx.lineTo(x + bw, cy);
    ctx.lineTo(x, cy + bh / 2);
    ctx.stroke();

    ctx.restore();
}

/** 信纸右下角的羽毛（羽片 + 羽轴 + 两侧羽枝） */
function drawFeather(ctx, cx, cy, height, angle, color) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    const h = height;
    const w = h * 0.24;

    // 羽片：上窄下宽的柳叶形，左右对称
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.5);
    ctx.bezierCurveTo(w * 1.28, -h * 0.3, w * 1.02, h * 0.04, w * 0.16, h * 0.32);
    ctx.lineTo(0, h * 0.4);
    ctx.lineTo(-w * 0.16, h * 0.32);
    ctx.bezierCurveTo(-w * 1.02, h * 0.04, -w * 1.28, -h * 0.3, 0, -h * 0.5);
    ctx.closePath();
    ctx.fillStyle = rgba(color, 0.12);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.42);
    ctx.lineWidth = Math.max(1, h * 0.008);
    ctx.stroke();

    // 羽轴（下段露出来的羽柄）
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.52);
    ctx.quadraticCurveTo(w * 0.06, h * 0.1, w * 0.02, h * 0.66);
    ctx.strokeStyle = rgba(color, 0.58);
    ctx.lineWidth = Math.max(1, h * 0.011);
    ctx.stroke();

    // 两侧羽枝
    for (let i = 0; i < 9; i++) {
        const t = 0.04 + i * 0.052;
        const baseY = -h * 0.46 + h * 0.86 * t;
        const spread = w * (1.15 - Math.abs(t - 0.42) * 1.05);
        [1, -1].forEach(side => {
            ctx.beginPath();
            ctx.moveTo(0, baseY);
            ctx.quadraticCurveTo(side * spread * 0.55, baseY - h * 0.035, side * spread, baseY - h * 0.1);
            ctx.strokeStyle = rgba(color, 0.28);
            ctx.lineWidth = Math.max(0.7, h * 0.005);
            ctx.stroke();
        });
    }

    ctx.restore();
}

/** 小报左上角的图钉 */
function drawPushpin(ctx, cx, cy, size, accent) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.3);

    // 针尖
    ctx.beginPath();
    ctx.moveTo(-size * 0.05, size * 0.18);
    ctx.lineTo(size * 0.05, size * 0.18);
    ctx.lineTo(size * 0.015, size * 0.72);
    ctx.lineTo(-size * 0.015, size * 0.72);
    ctx.closePath();
    ctx.fillStyle = rgba('#3a2a22', 0.5);
    ctx.fill();

    // 钉帽投影
    ctx.beginPath();
    ctx.ellipse(size * 0.1, size * 0.26, size * 0.44, size * 0.16, 0.18, 0, Math.PI * 2);
    ctx.fillStyle = rgba('#3a2a22', 0.12);
    ctx.fill();

    // 钉帽
    const gradient = ctx.createRadialGradient(-size * 0.16, -size * 0.2, size * 0.05, 0, 0, size * 0.62);
    gradient.addColorStop(0, mixColor(accent, '#ffffff', 0.5));
    gradient.addColorStop(0.5, accent);
    gradient.addColorStop(1, mixColor(accent, '#2a1414', 0.42));
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.4, size * 0.34, -0.12, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // 高光
    ctx.beginPath();
    ctx.ellipse(-size * 0.12, -size * 0.11, size * 0.1, size * 0.07, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = rgba('#ffffff', 0.6);
    ctx.fill();

    ctx.restore();
}

/** 胶带标签（小报右上的 "char"）：不透明底色，才像真贴了一条纸胶带 */
function drawTape(ctx, cx, cy, w, h, angle, fill, border, label, labelColor, stack) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    ctx.fillStyle = fill;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2, -h / 2);
    ctx.moveTo(-w / 2, h / 2); ctx.lineTo(w / 2, h / 2);
    ctx.stroke();

    const labelSize = fitSingleLine(ctx, label, {
        size: h * 0.56, width: w * 0.82, stack, weight: '400', tracking: 1.4, minSize: 10,
    });
    text(ctx, label, 0, labelSize * 0.36, {
        size: labelSize,
        stack,
        color: labelColor,
        tracking: 1.4,
        align: 'center',
    });

    ctx.restore();
}

function drawImageCover(ctx, image, x, y, w, h, radius) {
    if (!image) return false;
    ctx.save();
    if (radius) roundRectPath(ctx, x, y, w, h, radius);
    else {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
    }
    ctx.clip();

    const iw = image.naturalWidth || image.width || 0;
    const ih = image.naturalHeight || image.height || 0;
    if (!iw || !ih) {
        ctx.restore();
        return false;
    }
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
    return true;
}

function drawAvatarFallback(ctx, x, y, w, h, radius, char, t) {
    ctx.save();
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.fillStyle = mixColor(t.paper, t.ink, 0.07);
    ctx.fill();
    const label = (String(char || '？').trim()[0] || '？');
    text(ctx, label, x + w / 2, y + h / 2 + w * 0.13, {
        size: Math.min(w, h) * 0.4,
        stack: SERIF_EN,
        color: rgba(t.accent, 0.85),
        align: 'center',
    });
    ctx.restore();
}

/** 导航栏返回箭头（‹） */
function drawNavBack(ctx, x, y, size, color, lineWidth) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x + size * 0.32, y - size * 0.5);
    ctx.lineTo(x - size * 0.18, y);
    ctx.lineTo(x + size * 0.32, y + size * 0.5);
    ctx.stroke();
    ctx.restore();
}

/** 右上角「···」 */
function drawMoreDots(ctx, cx, cy, radius, gap, color) {
    ctx.save();
    ctx.fillStyle = color;
    [-1, 0, 1].forEach(offset => {
        ctx.beginPath();
        ctx.arc(cx + offset * gap, cy, radius, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

/** 空心爱心（朋友圈点赞图标） */
function drawHeartOutline(ctx, cx, cy, size, color, lineWidth) {
    const s = size / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(0, s * 0.86);
    ctx.bezierCurveTo(-s * 1.65, -s * 0.32, -s * 0.62, -s * 1.34, 0, -s * 0.44);
    ctx.bezierCurveTo(s * 0.62, -s * 1.34, s * 1.65, -s * 0.32, 0, s * 0.86);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
}

/** 空心对话气泡（评论图标） */
function drawSpeechOutline(ctx, cx, cy, w, color, lineWidth) {
    const h = w * 0.8;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, w * 0.24);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.16, cy + h / 2 - 1);
    ctx.lineTo(cx - w * 0.24, cy + h / 2 + w * 0.18);
    ctx.lineTo(cx - w * 0.02, cy + h / 2 - 1);
    ctx.stroke();
    ctx.restore();
}

/** 用户头像：有人设图片就裁成圆角矩形，没有就退回首字兜底头像 */
function drawUserAvatar(ctx, image, x, y, size, radius, name, t) {
    if (drawImageCover(ctx, image, x, y, size, size, radius)) return;
    drawAvatarFallback(ctx, x, y, size, size, radius, name, t);
}

/** 晋江顶部的四宫格图标 */
function drawGridIcon(ctx, x, y, size, color) {
    const gap = size * 0.16;
    const cell = (size - gap) / 2;
    ctx.save();
    ctx.fillStyle = color;
    [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([col, row]) => {
        ctx.fillRect(x + col * (cell + gap), y + row * (cell + gap), cell, cell);
    });
    ctx.restore();
}

// ============================================================
// 四、八套模板
// ============================================================

/**
 * 模板 1 · 档案馆原生
 * 无头像；标题 / 元信息 / 竖条正文 / 右下「—— user 摘」
 */
function layoutArchive(ctx, d, maxHeight) {
    const scale = d.font.scale;
    const block = fitTextBlockAuto(ctx, d.text, {
        width: 852,
        maxHeight: Math.max(1, maxHeight - 392 - 140),
        size: 42 * scale,
        lineHeight: 1.9,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.4,
    });
    const bodyH = block.lines.length * block.lh;
    const height = Math.max(CARD_H_MIN, Math.min(maxHeight, 392 + bodyH + 140));
    return { height, block, bodyH };
}

function drawArchive(ctx, d, t, layout) {
    const height = layout.height;
    const block = layout.block;
    const bodyH = layout.bodyH;

    ctx.fillStyle = t.paper;
    ctx.fillRect(0, 0, CARD_W, height);

    const scale = d.font.scale;

    // 标题（菱形直接复用详情弹窗标题前的 ❖，和插件本体同一个字形）
    // 只保留对话名：角色名已经出现在下方的元信息里
    const title = d.chatName || d.char;
    const titleSize = fitSingleLine(ctx, title, {
        size: 48 * Math.min(1, scale + 0.06),
        width: 800,
        stack: d.font.stack,
        weight: '600',
        tracking: 2,
    });
    const markSize = titleSize * 0.62;
    setFont(ctx, markSize, d.font.stack, '600');
    // 用墨迹范围定位：❖ 的字符宽度比实际图形宽，按字符宽度排会留出一大截空隙
    const mark = ctx.measureText('❖');
    const inkLeft = Number.isFinite(mark.actualBoundingBoxLeft) ? mark.actualBoundingBoxLeft : 0;
    const inkRight = Number.isFinite(mark.actualBoundingBoxRight) ? mark.actualBoundingBoxRight : mark.width;
    text(ctx, '❖', 100 + inkLeft, 162, {
        size: markSize,
        stack: d.font.stack,
        weight: '600',
        color: t.accent,
    });
    text(ctx, title, 100 + inkLeft + inkRight + 14, 162, {
        size: titleSize,
        stack: d.font.stack,
        weight: '600',
        color: mixColor(t.ink, t.accent, 0.35),
        tracking: 2,
    });

    // 元信息
    const meta = [d.char, d.mesid ? `#${d.mesid}` : '', d.time].filter(Boolean).join(' · ');
    text(ctx, meta, 104, 246, {
        size: 27 * scale,
        stack: MONO_STACK,
        color: rgba(t.ink, 0.44),
        tracking: 0.6,
    });

    dashedLine(ctx, 104, 300, 976, 300, rgba(t.accent, 0.3), 2, [7, 9]);

    // 竖条跟着正文走：从第一行上沿到末行下沿
    const barTop = 392 + (block.lh - block.size) / 2 - 8;
    ctx.save();
    ctx.fillStyle = rgba(t.accent, 0.6);
    roundRectPath(ctx, 76, barTop, 12, Math.max(2, bodyH - 10), 6);
    ctx.fill();
    ctx.restore();

    drawTextBlock(ctx, block, 132, 392, {
        stack: d.font.stack,
        weight: '400',
        color: t.ink,
        tracking: 0.4,
    });

    // 落款
    text(ctx, `—— ${d.user} 摘`, 976, height - 76, {
        size: 29 * scale,
        stack: d.font.stack,
        color: rgba(t.accent, 0.9),
        tracking: 1.2,
        align: 'right',
    });
}

/**
 * 模板 2 · 拍立得
 * 顶部圆形头像 + 标题；中间方框正文；互动栏（装饰数字）；底部一行英文
 */
function layoutPolaroid(ctx, d, maxHeight) {
    const scale = d.font.scale;
    const maxFrameH = Math.max(608, maxHeight - 254 - 218);
    const block = fitTextBlockAuto(ctx, d.text, {
        width: 840,
        maxHeight: Math.max(1, maxFrameH - 68),
        size: 44 * scale,
        lineHeight: 1.85,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.4,
    });
    const bodyH = block.lines.length * block.lh;
    const frameH = Math.max(608, Math.min(maxFrameH, bodyH + 68));
    const height = Math.max(CARD_H_MIN, Math.min(maxHeight, 254 + frameH + 218));
    return { height, block, bodyH, frameH };
}

function drawPolaroid(ctx, d, t, layout) {
    const height = layout.height;
    const block = layout.block;
    const bodyH = layout.bodyH;
    const frameH = layout.frameH;

    ctx.fillStyle = t.paper;
    ctx.fillRect(0, 0, CARD_W, height);

    const scale = d.font.scale;

    // 外框
    ctx.save();
    ctx.strokeStyle = rgba(t.accent, 0.45);
    ctx.lineWidth = 3;
    roundRectPath(ctx, 11, 11, CARD_W - 22, height - 22, 18);
    ctx.stroke();
    ctx.restore();

    // 头像
    const avatarR = 56;
    ctx.save();
    ctx.beginPath();
    ctx.arc(150, 148, avatarR, 0, Math.PI * 2);
    ctx.clip();
    if (!drawImageCover(ctx, d.avatar, 150 - avatarR, 148 - avatarR, avatarR * 2, avatarR * 2, 0)) {
        ctx.fillStyle = mixColor(t.paper, t.ink, 0.07);
        ctx.fillRect(150 - avatarR, 148 - avatarR, avatarR * 2, avatarR * 2);
        text(ctx, (d.char || '？')[0], 150, 168, {
            size: 46, stack: SERIF_EN, color: rgba(t.accent, 0.85), align: 'center',
        });
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(150, 148, avatarR, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(t.accent, 0.3);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // 标题：只保留对话名
    const title = d.chatName || d.char;
    const titleSize = fitSingleLine(ctx, title, {
        size: 46 * Math.min(1, scale + 0.04),
        width: 700,
        stack: d.font.stack,
        weight: '600',
        tracking: 1,
    });
    text(ctx, title, 232, 152, {
        size: titleSize,
        stack: d.font.stack,
        weight: '600',
        color: mixColor(t.ink, t.accent, 0.3),
        tracking: 1,
    });

    // 右上角省略号
    text(ctx, '···', 1000, 142, {
        size: 32, stack: MONO_STACK, color: rgba(t.ink, 0.4), tracking: 1, align: 'right',
    });

    // 副信息
    const meta = [d.char, d.mesid ? `#${d.mesid}` : '', d.time].filter(Boolean).join(' · ');
    text(ctx, meta, 232, 216, {
        size: 24 * scale,
        stack: MONO_STACK,
        color: rgba(t.ink, 0.42),
        tracking: 0.4,
    });

    // 中间方框
    const frameX = 80;
    const frameY = 254;
    const frameW = 920;
    ctx.save();
    ctx.strokeStyle = rgba(t.accent, 0.45);
    ctx.lineWidth = 2;
    ctx.strokeRect(frameX, frameY, frameW, frameH);
    ctx.restore();

    const textX = frameX + 40;
    const textW = frameW - 80;

    // 正文（框内上下居中、左对齐）
    drawTextBlock(ctx, block, textX, frameY + (frameH - bodyH) / 2, {
        stack: d.font.stack,
        weight: '400',
        color: t.ink,
        tracking: 0.4,
        align: 'left',
    });

    // 互动栏（设计稿装饰数字，不接真实数据）；左边缘和正文左边对齐
    const rowY = height - 162;
    const iconColor = rgba(t.accent, 0.85);
    drawHeart(ctx, textX + 24, rowY - 12, 48, iconColor);
    text(ctx, DECOR_STATS.like, textX + 62, rowY, {
        size: 33 * scale, stack: MONO_STACK, color: rgba(t.ink, 0.72), tracking: 0.5,
    });
    drawBubble(ctx, textX + 190, rowY - 12, 46, iconColor, 2.4);
    text(ctx, DECOR_STATS.comment, textX + 226, rowY, {
        size: 33 * scale, stack: MONO_STACK, color: rgba(t.ink, 0.72), tracking: 0.5,
    });
    // 翻页指示：< ○ ● ○ >，中间那颗实心表示当前页
    drawPager(ctx, textX + 470, rowY - 12, 34 * Math.min(1.1, scale), rgba(t.accent, 0.8));
    drawStar(ctx, 872, rowY - 12, 27, iconColor, 2.6);
    text(ctx, DECOR_STATS.star, 910, rowY, {
        size: 33 * scale, stack: MONO_STACK, color: rgba(t.ink, 0.72), tracking: 0.5,
    });

    dashedLine(ctx, 100, height - 118, 980, height - 118, rgba(t.accent, 0.16), 1.4, [4, 7]);

    // 底部一行英文（user 前缀替换为实际用户名，太长时自动缩；文案可自定义）
    const decorLine = `${d.user}: ${d.decor?.polaroidFooter || DECOR_TEXT.polaroid}`;
    const decorSize = fitSingleLine(ctx, decorLine, {
        size: 25 * scale, width: 860, stack: MONO_STACK, weight: '400', tracking: 0.3, minSize: 14,
    });
    text(ctx, decorLine, 100, height - 58, {
        size: decorSize,
        stack: MONO_STACK,
        color: rgba(t.ink, 0.42),
        tracking: 0.3,
    });
}

/**
 * 模板 3 · 信纸
 * 虚线外框 + To user + 横格线（正文写在格子上）+ 右下 char/时间 + 羽毛
 */
function layoutLetter(ctx, d, maxHeight) {
    const scale = d.font.scale;
    const ruleGap = 100;
    const maxLines = Math.max(7, Math.floor((maxHeight - 380) / ruleGap));
    const block = fitTextBlockAuto(ctx, d.text, {
        width: 800,
        maxHeight: maxLines * ruleGap,
        size: 36 * scale,
        lineHeight: 1.85,
        lineGap: ruleGap,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.4,
    });
    const lines = Math.max(1, block.lines.length);
    const height = Math.max(CARD_H_MIN, Math.min(maxHeight, 380 + lines * ruleGap));
    return { height, block, ruleCount: Math.max(7, lines) };
}

function drawLetter(ctx, d, t, layout) {
    const height = layout.height;
    const block = layout.block;

    ctx.fillStyle = t.paper;
    ctx.fillRect(0, 0, CARD_W, height);

    const scale = d.font.scale;

    // 外框
    strokeDashRect(ctx, 46, 46, CARD_W - 92, height - 92, rgba(t.accent, 0.45), 2, [7, 7]);

    // To user
    const toText = `To ${d.user}`;
    const toSize = fitSingleLine(ctx, toText, {
        size: 38 * scale, width: 460, stack: d.font.stack, weight: '500', tracking: 0.8,
    });
    text(ctx, toText, 118, 152, {
        size: toSize,
        stack: d.font.stack,
        weight: '500',
        color: mixColor(t.ink, t.accent, 0.32),
        tracking: 0.8,
    });
    setFont(ctx, toSize, d.font.stack, '500');
    const toWidth = measureTracked(ctx, toText, 0.8);
    ctx.save();
    ctx.strokeStyle = rgba(t.accent, 0.45);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(118, 174);
    ctx.lineTo(118 + toWidth, 174);
    ctx.stroke();
    ctx.restore();

    // 右上角楼层
    if (d.mesid) {
        text(ctx, `#${d.mesid}`, 952, 146, {
            size: 25, stack: MONO_STACK, color: rgba(t.ink, 0.34), tracking: 0.5, align: 'right',
        });
    }

    // 横格线
    const ruleTop = 262;
    const ruleGap = 100;
    const ruleCount = layout.ruleCount;
    for (let i = 0; i < ruleCount; i++) {
        const y = ruleTop + i * ruleGap;
        dashedLine(ctx, 118, y, 952, y, rgba(t.accent, 0.26), 1.3, [5, 7]);
    }

    // 正文：一行一格，正好压在横线上
    block.lines.forEach((line, index) => {
        const ruleY = ruleTop + index * ruleGap;
        text(ctx, line, 138, ruleY - 22, {
            size: block.size,
            stack: d.font.stack,
            weight: '400',
            color: t.ink,
            tracking: 0.4,
        });
    });

    // 右下落款
    text(ctx, d.char, 952, height - 118, {
        size: 24 * scale, stack: MONO_STACK, color: rgba(t.ink, 0.45), tracking: 0.6, align: 'right',
    });
    text(ctx, d.time, 952, height - 76, {
        size: 21 * scale, stack: MONO_STACK, color: rgba(t.ink, 0.36), tracking: 0.4, align: 'right',
    });

    // 羽毛
    drawFeather(ctx, 986, 470, 152, 0.22, t.accent);
    drawFeather(ctx, 1000, height - 288, 110, -0.36, t.accent);
}

/**
 * 模板 4 · 小报拼贴
 * 两张纸叠着：下面那张小一圈、转 5°，四个角从上面那张底下露出来。
 * 上面那张再画图钉 / 虚线标题框 / 正文框 / 头像胶带。
 */
const COLLAGE_SCALE = 960 / CARD_W;

function layoutCollage(ctx, d, maxHeight) {
    const scale = d.font.scale;
    const sheetHMax = (maxHeight - 120) / COLLAGE_SCALE;
    const frameHMax = Math.max(738, sheetHMax - 342);
    const block = fitTextBlockAuto(ctx, d.text, {
        width: 522,
        maxHeight: Math.max(1, frameHMax - 82),
        size: 46 * scale,
        lineHeight: 1.85,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.4,
    });
    const bodyH = block.lines.length * block.lh;
    const frameH = Math.max(738, Math.min(frameHMax, bodyH + 82));
    const sheetH = 342 + frameH;
    const height = Math.max(CARD_H_MIN, Math.min(maxHeight, 120 + COLLAGE_SCALE * sheetH));
    return { height, block, bodyH, frameH, sheetH };
}

function drawCollage(ctx, d, t, layout) {
    const height = layout.height;

    // 纸外的底：纯白，固定不跟配色走
    ctx.fillStyle = '#f7f4ee';
    ctx.fillRect(0, 0, CARD_W, height);

    // 下面那张纸：小一圈 + 转 5°，靠边缘线交代它是另一张。
    // 卡片变高时把纸略微收窄，保证旋转后的包围盒仍在 1080 宽度内。
    const tH = Math.max(0, Math.min(1, (height - CARD_H_MIN) / (CARD_H_MAX - CARD_H_MIN)));
    const backW = 940 - 60 * tH;
    const backH = height - 140;

    ctx.save();
    ctx.translate(CARD_W / 2, height / 2);
    ctx.rotate(-0.087);
    ctx.fillStyle = t.paper;
    ctx.fillRect(-backW / 2, -backH / 2, backW, backH);
    ctx.strokeStyle = rgba(t.accent, 0.3);
    ctx.lineWidth = 1.4;
    ctx.strokeRect(-backW / 2, -backH / 2, backW, backH);
    ctx.restore();

    // 上面那张纸：原来的整张卡内容，整体缩进 60px 让出叠纸的缝
    ctx.save();
    ctx.translate(60, 60);
    ctx.scale(COLLAGE_SCALE, COLLAGE_SCALE);
    drawCollageSheet(ctx, d, t, layout);
    ctx.restore();
}

function drawCollageSheet(ctx, d, t, layout) {
    const sheetH = layout.sheetH;
    const block = layout.block;
    const bodyH = layout.bodyH;

    ctx.fillStyle = t.paper;
    ctx.fillRect(0, 0, CARD_W, sheetH);

    const scale = d.font.scale;

    // 外框
    ctx.save();
    ctx.strokeStyle = rgba(t.accent, 0.42);
    ctx.lineWidth = 1.6;
    ctx.strokeRect(34, 34, CARD_W - 68, sheetH - 68);
    ctx.restore();

    // 标题虚线框
    strokeDashRect(ctx, 70, 62, 940, 152, rgba(t.accent, 0.38), 2, [9, 7]);

    // 标题：只保留对话名
    const title = d.chatName || d.char;
    const titleSize = fitSingleLine(ctx, title, {
        size: 56 * scale, width: 860, stack: d.font.stack, weight: '600', tracking: 3,
    });
    // 基线按「框的视觉中心」推：中文字面大约占 0.88em，中心对齐要往下让 0.38em
    text(ctx, title, CARD_W / 2, 62 + 152 / 2 + titleSize * 0.38, {
        size: titleSize,
        stack: d.font.stack,
        weight: '600',
        color: mixColor(t.ink, t.accent, 0.3),
        tracking: 3,
        align: 'center',
    });

    // 图钉
    drawPushpin(ctx, 90, 74, 42, t.accent);

    // 标题下面一行小字：时间 / 楼层
    text(ctx, d.time, 70, 262, {
        size: 25 * scale, stack: MONO_STACK, color: rgba(t.ink, 0.42), tracking: 0.4,
    });
    if (d.mesid) {
        text(ctx, `#${d.mesid}`, 1010, 262, {
            size: 25 * scale, stack: MONO_STACK, color: rgba(t.ink, 0.42), tracking: 0.4, align: 'right',
        });
    }

    // 分隔线（通栏）+ 正文框
    ctx.save();
    ctx.strokeStyle = rgba(t.accent, 0.45);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(70, 292);
    ctx.lineTo(1010, 292);
    ctx.stroke();
    ctx.strokeStyle = rgba(t.accent, 0.3);
    ctx.lineWidth = 1.3;
    ctx.strokeRect(70, 292, 590, layout.frameH);
    ctx.restore();

    // 正文：整栏往下排，放不下自动缩字号；短句则垂直居中，避免下半截空一大片
    drawTextBlock(ctx, block, 104, 334 + (layout.frameH - 82 - bodyH) / 2, {
        stack: d.font.stack,
        weight: '400',
        color: t.ink,
        tracking: 0.4,
    });

    // 右侧头像
    const boxX = 694;
    const boxY = 330;
    const boxW = 250;
    const boxH = 300;
    if (!drawImageCover(ctx, d.avatar, boxX, boxY, boxW, boxH, 0)) {
        drawAvatarFallback(ctx, boxX, boxY, boxW, boxH, 0, d.char, t);
    }
    ctx.save();
    ctx.strokeStyle = rgba(t.accent, 0.42);
    ctx.lineWidth = 2;
    ctx.strokeRect(boxX, boxY, boxW, boxH);
    ctx.restore();

    // 胶带：不透明纸胶带，45° 斜贴，只压住头像框左上角，不进正文框
    drawTape(
        ctx, boxX + 22, boxY + 10, 112, 38, -Math.PI / 4,
        mixColor(t.paper, t.accent, 0.14), rgba(t.accent, 0.3),
        d.char, rgba(t.accent, 0.9), d.font.stack,
    );

    // 右侧英文摘抄：固定贴在头像下方，不随卡片长高往下漂；文案可自定义。
    const userY = 706;
    const enTop = userY + 20;
    text(ctx, `${d.user}:`, boxX, userY, {
        size: 28 * scale, stack: d.font.stack, color: rgba(t.accent, 0.86), tracking: 0.6,
    });

    const enBlock = fitTextBlock(ctx, d.decor?.collageQuote || DECOR_TEXT.collage, {
        width: 250,
        // 方形卡片里也留足位置，把整段英文完整排出来（原来 100 会被截断）
        maxHeight: Math.max(100, 292 + layout.frameH - enTop - 16),
        size: 20,
        lineHeight: 1.5,
        stack: SERIF_EN,
        weight: '400',
        style: 'italic',
        tracking: 0.2,
        minScale: 0.88,
    });
    drawTextBlock(ctx, enBlock, boxX, enTop, {
        stack: SERIF_EN,
        weight: '400',
        style: 'italic',
        color: rgba(t.ink, 0.55),
        tracking: 0.2,
    });
}

/**
 * 模板 5 · 明信片
 * 固定 1080×660 横版：左上角一小块邮编格 + 左侧竖排标题 + 中间正文，
 * 右侧头像 / 楼层 / To·From / 日期。标题与正文不加边框；
 * 虚线只用于横线，虚线框只保留头像。
 */
const POSTCARD_H = 660;

function layoutPostcard(ctx, d) {
    const scale = d.font.scale;
    const block = fitTextBlock(ctx, d.text, {
        width: 480,
        maxHeight: 444,
        size: 34 * scale,
        lineHeight: 1.85,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.4,
        minScale: 0.58,
    });
    return {
        height: POSTCARD_H,
        block,
        bodyH: block.lines.length * block.lh,
    };
}

function drawPostcard(ctx, d, t, layout) {
    const height = layout.height;
    const scale = d.font.scale;

    ctx.fillStyle = t.paper;
    ctx.fillRect(0, 0, CARD_W, height);

    // 外框：一条实线 + 一条细内线
    ctx.save();
    ctx.strokeStyle = rgba(t.accent, 0.55);
    ctx.lineWidth = 2.4;
    ctx.strokeRect(18, 18, CARD_W - 36, height - 36);
    ctx.strokeStyle = rgba(t.accent, 0.22);
    ctx.lineWidth = 1.1;
    ctx.strokeRect(27, 27, CARD_W - 54, height - 54);
    ctx.restore();

    // 左上角邮编格：只占很小一块，实线框（虚线框只属于头像）
    const zipX = 52;
    const zipY = 48;
    const zipW = 36;
    const zipH = 34;
    const zipGap = 6;
    ctx.save();
    ctx.strokeStyle = rgba(t.accent, 0.38);
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 6; i++) {
        const x = zipX + i * (zipW + zipGap);
        ctx.fillStyle = rgba(t.accent, 0.04);
        ctx.fillRect(x, zipY, zipW, zipH);
        ctx.strokeRect(x, zipY, zipW, zipH);
    }
    ctx.restore();
    text(ctx, '邮政编码', zipX + 6 * (zipW + zipGap) + 4, zipY + zipH - 7, {
        size: 12, stack: d.font.stack, color: rgba(t.ink, 0.36), tracking: 1.2,
    });

    // 左侧竖排标题：文字从上往下堆叠，但每个字形保持直立（不再整体旋转 90°）
    // 标题只保留对话名；过长时自动缩字号，仍放不下则末尾补省略号
    const title = String(d.chatName || d.char || '');
    const titleChars = Array.from(title);
    const titleTop = 104;
    const titleMaxH = 504;
    const titleStepRatio = 1.2;
    let titleSize = 34 * scale;
    while (titleSize > 16 && titleChars.length * titleSize * titleStepRatio > titleMaxH) {
        titleSize -= 1;
    }
    const titleStep = titleSize * titleStepRatio;
    const titleMaxCount = Math.max(1, Math.floor(titleMaxH / titleStep));
    let titleShown = titleChars;
    if (titleShown.length > titleMaxCount) {
        titleShown = titleShown.slice(0, titleMaxCount);
        titleShown[titleMaxCount - 1] = '…';
    }
    ctx.save();
    setFont(ctx, titleSize, d.font.stack, '600');
    ctx.fillStyle = mixColor(t.ink, t.accent, 0.32);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    titleShown.forEach((ch, index) => {
        ctx.fillText(ch, 104, titleTop + titleStep / 2 + index * titleStep);
    });
    ctx.restore();

    // 中间正文：不加边框，左对齐
    const bodyTop = 152 + Math.max(0, (444 - layout.bodyH) / 2);
    drawTextBlock(ctx, layout.block, 190, bodyTop, {
        stack: d.font.stack,
        weight: '400',
        color: t.ink,
        tracking: 0.4,
    });

    // 右栏：头像（唯一保留的虚线框）
    const avatarX = 860;
    const avatarY = 48;
    const avatarW = 190;
    const avatarH = 250;
    if (!drawImageCover(ctx, d.avatar, avatarX, avatarY, avatarW, avatarH, 0)) {
        drawAvatarFallback(ctx, avatarX, avatarY, avatarW, avatarH, 0, d.char, t);
    }
    strokeDashRect(ctx, avatarX, avatarY, avatarW, avatarH, rgba(t.accent, 0.42), 1.4, [6, 5]);

    // 楼层
    if (d.mesid) {
        text(ctx, `#${d.mesid}`, avatarX + avatarW / 2, 328, {
            size: 21, stack: MONO_STACK, color: rgba(t.ink, 0.42), tracking: 0.5, align: 'center',
        });
    }

    // To / From：标签和冒号留在虚线外面，后面的值压在虚线上
    const fieldRight = 1048;
    const drawField = (label, value, lineY) => {
        text(ctx, label, 720, lineY - 6, {
            size: 26 * scale, stack: d.font.stack, weight: '600', color: rgba(t.accent, 0.86), tracking: 0.4,
        });
        setFont(ctx, 26 * scale, d.font.stack, '600');
        const labelW = measureTracked(ctx, label, 0.4);
        const valueX = 724 + labelW + 10;
        const valueSize = fitSingleLine(ctx, value, {
            size: 21 * scale, width: fieldRight - valueX - 8, stack: MONO_STACK, weight: '400',
            style: 'italic', tracking: 0.4, minSize: 13,
        });
        text(ctx, value, valueX, lineY - 6, {
            size: valueSize, stack: MONO_STACK, weight: '400', style: 'italic',
            color: rgba(t.ink, 0.72), tracking: 0.4,
        });
        dashedLine(ctx, valueX, lineY, fieldRight, lineY, rgba(t.accent, 0.34), 1.3, [5, 5]);
    };
    drawField('To:', d.user, 424);
    drawField('From:', d.char, 524);

    // 日期
    text(ctx, d.time, fieldRight, 596, {
        size: 18, stack: MONO_STACK, style: 'italic', color: rgba(t.ink, 0.42), tracking: 0.3, align: 'right',
    });
}

/**
 * 模板 6 · 日记
 * 错开叠放的两张纸 + 夹在纸间的 #n 标签；首行只有居中标题，标题和正文下方都有横虚线，
 * 正文走到哪画到哪，不留空线；右下角旋转便签（To 角色 / 装饰英文 / 日期 / —— user），
 * 便签本身无边框。左侧不打孔。
 */
const DIARY_TITLE_BASELINE = 150;
const DIARY_TITLE_RULE = 192;
const DIARY_RULE_TOP = 254;
const DIARY_RULE_GAP = 62;
const DIARY_NOTE_RESERVE = 380;

function layoutDiary(ctx, d, maxHeight) {
    const scale = d.font.scale;
    const maxLines = Math.max(
        1,
        Math.floor((maxHeight - DIARY_RULE_TOP - DIARY_NOTE_RESERVE) / DIARY_RULE_GAP),
    );
    const block = fitTextBlockAuto(ctx, d.text, {
        width: 820,
        maxHeight: maxLines * DIARY_RULE_GAP,
        size: 34 * scale,
        lineHeight: 1.85,
        lineGap: DIARY_RULE_GAP,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.4,
    });
    const lines = Math.max(1, block.lines.length);
    const height = Math.max(
        CARD_H_MIN,
        Math.min(maxHeight, DIARY_RULE_TOP + lines * DIARY_RULE_GAP + DIARY_NOTE_RESERVE),
    );
    return { height, block, ruleCount: lines };
}

function drawDiary(ctx, d, t, layout) {
    const height = layout.height;
    const block = layout.block;
    const scale = d.font.scale;

    // 桌面底色
    ctx.fillStyle = mixColor(t.paper, t.ink, 0.05);
    ctx.fillRect(0, 0, CARD_W, height);

    // 后面那张纸：右下错开，露出两条边
    ctx.save();
    ctx.fillStyle = mixColor(t.paper, t.ink, 0.02);
    ctx.fillRect(70, 68, 968, height - 104);
    ctx.strokeStyle = rgba(t.accent, 0.22);
    ctx.lineWidth = 1.4;
    ctx.strokeRect(70, 68, 968, height - 104);
    ctx.restore();

    // #n 标签：画在两张纸之间，右侧从上层纸下面露出来
    if (d.mesid) {
        ctx.save();
        ctx.translate(990, 125);
        ctx.rotate(0.38);
        ctx.fillStyle = mixColor(t.paper, t.accent, 0.2);
        ctx.fillRect(-78, -28, 156, 56);
        ctx.strokeStyle = rgba(t.accent, 0.42);
        ctx.lineWidth = 1.4;
        ctx.strokeRect(-78, -28, 156, 56);
        text(ctx, `#${d.mesid}`, 46, 7, {
            size: 21, stack: MONO_STACK, color: rgba(t.accent, 0.85), tracking: 0.6, align: 'center',
        });
        ctx.restore();
    }

    // 上面那张纸：盖住标签左半边
    ctx.fillStyle = t.paper;
    ctx.fillRect(40, 40, 968, height - 96);
    ctx.save();
    ctx.strokeStyle = rgba(t.accent, 0.38);
    ctx.lineWidth = 1.6;
    ctx.strokeRect(40, 40, 968, height - 96);
    ctx.restore();

    // 首行只有标题，居中；只保留对话名
    const title = d.chatName || d.char;
    const titleSize = fitSingleLine(ctx, title, {
        size: 46 * scale, width: 760, stack: d.font.stack, weight: '600', tracking: 2, minSize: 20,
    });
    text(ctx, title, CARD_W / 2, DIARY_TITLE_BASELINE, {
        size: titleSize,
        stack: d.font.stack,
        weight: '600',
        color: mixColor(t.ink, t.accent, 0.3),
        tracking: 2,
        align: 'center',
    });
    dashedLine(ctx, 118, DIARY_TITLE_RULE, 960, DIARY_TITLE_RULE, rgba(t.accent, 0.42), 1.6, [6, 6]);

    // 正文：一行一格，每行下面都压一条虚线；没有正文的地方不画空线
    const ruleTop = DIARY_RULE_TOP;
    const ruleGap = DIARY_RULE_GAP;
    block.lines.forEach((line, index) => {
        const ruleY = ruleTop + index * ruleGap;
        text(ctx, line, 138, ruleY - 18, {
            size: block.size,
            stack: d.font.stack,
            weight: '400',
            color: t.ink,
            tracking: 0.4,
        });
        dashedLine(ctx, 118, ruleY, 960, ruleY, rgba(t.accent, 0.24), 1.3, [5, 7]);
    });

    // 便签左侧的窄空位：正文排不进来，补一点小装饰
    const decorY = height - 262;
    text(ctx, '(｡･ω･｡)', 150, decorY, {
        size: 30 * scale,
        stack: d.font.stack,
        color: rgba(t.accent, 0.36),
        tracking: 1,
    });
    const marginText = d.decor?.diaryMargin || DECOR_TEXT.diaryMargin;
    const marginSize = fitSingleLine(ctx, marginText, {
        size: 20, width: 380, stack: SERIF_EN, weight: '400', style: 'italic', tracking: 0.8, minSize: 12,
    });
    text(ctx, marginText, 150, decorY + 38, {
        size: marginSize,
        stack: SERIF_EN,
        style: 'italic',
        color: rgba(t.ink, 0.34),
        tracking: 0.8,
    });

    // 右下角旋转便签：无边框
    ctx.save();
    ctx.translate(800, height - 214);
    ctx.rotate(-0.13);

    ctx.fillStyle = mixColor(t.paper, t.accent, 0.08);
    ctx.fillRect(-210, -150, 420, 300);

    text(ctx, `To ${d.char}:`, -188, -104, {
        size: 30 * scale,
        stack: d.font.stack,
        weight: '500',
        color: mixColor(t.ink, t.accent, 0.32),
        tracking: 0.5,
    });

    const decor = fitTextBlock(ctx, d.decor?.diaryNote || DECOR_TEXT.polaroid, {
        width: 344,
        maxHeight: 110,
        size: 18,
        lineHeight: 1.5,
        stack: SERIF_EN,
        weight: '400',
        style: 'italic',
        tracking: 0.2,
        minScale: 0.8,
    });
    const decorH = decor.lines.length * decor.lh;
    drawTextBlock(ctx, decor, 0, -66 + Math.max(0, (110 - decorH) / 2), {
        stack: SERIF_EN,
        weight: '400',
        style: 'italic',
        color: rgba(t.ink, 0.55),
        tracking: 0.2,
        align: 'center',
    });

    // 日期挪到便签上，单独一行
    text(ctx, d.time, 0, 74, {
        size: 19,
        stack: MONO_STACK,
        style: 'italic',
        color: rgba(t.ink, 0.5),
        tracking: 0.4,
        align: 'center',
    });

    text(ctx, `—— ${d.user}`, 188, 132, {
        size: 26 * scale,
        stack: d.font.stack,
        color: rgba(t.accent, 0.9),
        tracking: 1,
        align: 'right',
    });
    ctx.restore();
}

/**
 * 模板 7 · 朋友圈
 * 手机动态详情页：灰色导航栏 + 方形头像 + 正文 + 点赞 / 评论。
 */
const MOMENTS_HEAD_H = 120;
const MOMENTS_PAD = 48;
const MOMENTS_AVATAR = 156;
const MOMENTS_AVATAR_Y = MOMENTS_HEAD_H + 48;
const MOMENTS_CONTENT_X = MOMENTS_PAD + MOMENTS_AVATAR + 30;
const MOMENTS_CONTENT_W = CARD_W - MOMENTS_CONTENT_X - MOMENTS_PAD;
const MOMENTS_BODY_TOP = MOMENTS_HEAD_H + 168;
const MOMENTS_COMMENT_X = MOMENTS_PAD + 56 + 52 + 16;
const MOMENTS_COMMENT_W = CARD_W - MOMENTS_COMMENT_X - MOMENTS_PAD;

function layoutMoments(ctx, d, maxHeight) {
    const scale = d.font.scale;
    const commentBlock = fitTextBlock(ctx, d.decor?.momentsComment || DECOR_TEXT.momentsComment, {
        width: MOMENTS_COMMENT_W - 32,
        maxHeight: 120,
        size: 27 * scale,
        lineHeight: 1.5,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.3,
        minScale: 0.85,
    });
    const commentH = Math.max(38, commentBlock.lines.length * commentBlock.lh);
    const footerH = 178 + commentH;
    const bodyMax = Math.max(120, maxHeight - MOMENTS_BODY_TOP - 96 - footerH);
    const block = fitTextBlockAuto(ctx, d.text, {
        width: MOMENTS_CONTENT_W,
        maxHeight: bodyMax,
        size: 38 * scale,
        lineHeight: 1.75,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.4,
    });
    const bodyH = block.lines.length * block.lh;
    const height = Math.max(
        CARD_H_MIN,
        Math.min(maxHeight, MOMENTS_BODY_TOP + bodyH + 96 + footerH),
    );
    return { height, block, bodyH, commentBlock, commentH, footerH };
}

function drawMoments(ctx, d, t, layout) {
    const height = layout.height;
    const scale = d.font.scale;

    ctx.fillStyle = t.paper;
    ctx.fillRect(0, 0, CARD_W, height);

    // 顶部导航栏
    ctx.fillStyle = mixColor(t.paper, t.ink, 0.07);
    ctx.fillRect(0, 0, CARD_W, MOMENTS_HEAD_H);
    ctx.save();
    ctx.strokeStyle = rgba(t.ink, 0.08);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, MOMENTS_HEAD_H - 0.5);
    ctx.lineTo(CARD_W, MOMENTS_HEAD_H - 0.5);
    ctx.stroke();
    ctx.restore();

    drawNavBack(ctx, 58, MOMENTS_HEAD_H / 2, 26, rgba(t.ink, 0.78), 3);
    text(ctx, '详情', CARD_W / 2, MOMENTS_HEAD_H / 2 + 12, {
        size: 34 * Math.min(1, scale + 0.04),
        stack: d.font.stack,
        weight: '500',
        color: t.ink,
        tracking: 1.5,
        align: 'center',
    });
    drawMoreDots(ctx, 1010, MOMENTS_HEAD_H / 2, 4.5, 16, rgba(t.ink, 0.72));

    // 角色头像
    const avatarX = MOMENTS_PAD;
    const avatarY = MOMENTS_AVATAR_Y;
    if (!drawImageCover(ctx, d.avatar, avatarX, avatarY, MOMENTS_AVATAR, MOMENTS_AVATAR, 6)) {
        drawAvatarFallback(ctx, avatarX, avatarY, MOMENTS_AVATAR, MOMENTS_AVATAR, 6, d.char, t);
    }
    ctx.save();
    roundRectPath(ctx, avatarX, avatarY, MOMENTS_AVATAR, MOMENTS_AVATAR, 6);
    ctx.strokeStyle = rgba(t.ink, 0.10);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // 角色名
    text(ctx, d.char, MOMENTS_CONTENT_X, avatarY + 46, {
        size: 42 * scale,
        stack: d.font.stack,
        weight: '500',
        color: t.accent,
        tracking: 0.8,
    });

    // 正文
    drawTextBlock(ctx, layout.block, MOMENTS_CONTENT_X, MOMENTS_BODY_TOP, {
        stack: d.font.stack,
        weight: '400',
        color: t.ink,
        tracking: 0.4,
    });

    // 时间 / 楼层 / 更多
    const stamp = [d.time, d.mesid ? `#${d.mesid}` : ''].filter(Boolean).join('  ');
    const stampBaseline = MOMENTS_BODY_TOP + layout.bodyH + 58;
    text(ctx, stamp, MOMENTS_CONTENT_X, stampBaseline, {
        size: 24 * scale,
        stack: MONO_STACK,
        color: rgba(t.ink, 0.38),
        tracking: 0.4,
    });
    text(ctx, '···', CARD_W - MOMENTS_PAD, stampBaseline, {
        size: 26,
        stack: MONO_STACK,
        color: rgba(t.ink, 0.28),
        tracking: 1,
        align: 'right',
    });

    // 点赞 / 评论区（固定在卡片底部，短文本时留出和截图一样的空白）
    const sectionTop = height - layout.footerH;
    ctx.fillStyle = mixColor(t.paper, t.ink, 0.05);
    ctx.fillRect(0, sectionTop, CARD_W, layout.footerH);

    const likeCenter = sectionTop + 52;
    drawHeartOutline(ctx, MOMENTS_PAD + 22, likeCenter - 2, 40, t.accent, 2.2);
    drawUserAvatar(ctx, d.userAvatar, MOMENTS_PAD + 56, likeCenter - 26, 52, 6, d.user, t);

    const commentTop = sectionTop + 96;
    drawSpeechOutline(ctx, MOMENTS_PAD + 22, commentTop + 26, 38, t.accent, 2.2);
    drawUserAvatar(ctx, d.userAvatar, MOMENTS_PAD + 56, commentTop, 52, 6, d.user, t);
    text(ctx, d.user, MOMENTS_PAD + 56 + 52 + 16, commentTop + 34, {
        size: 28 * scale,
        stack: d.font.stack,
        weight: '500',
        color: t.accent,
        tracking: 0.4,
    });

    // 虚线框只是示意，不画边框，也不改背景色；评论直接写在浅灰区域上
    drawTextBlock(ctx, layout.commentBlock, MOMENTS_COMMENT_X, commentTop + 62, {
        stack: d.font.stack,
        weight: '400',
        color: t.ink,
        tracking: 0.3,
    });
}

/**
 * 模板 8 · 晋江评论
 * 绿色书评界面：标题栏 + 分类胶囊 + 圆形头像 + 正文 + 评论。
 */
const JJ_HEAD_H = 148;
const JJ_NAV_H = 96;
const JJ_PAD = 48;
const JJ_AVATAR = 84;
const JJ_CONTENT_TOP = JJ_HEAD_H + JJ_NAV_H;
const JJ_AVATAR_Y = JJ_CONTENT_TOP + 24;
const JJ_PANEL_TOP = JJ_CONTENT_TOP + 136;
const JJ_PANEL_W = CARD_W - JJ_PAD * 2;
const JJ_BODY_PAD = 36;
const JJ_BODY_W = JJ_PANEL_W - JJ_BODY_PAD * 2;
const JJ_ACTION_H = 100;
const JJ_COMMENT_W = CARD_W - JJ_PAD - 160;
const JJ_COMMENT_TEXT_W = JJ_COMMENT_W - 40;

function layoutJinjiang(ctx, d, maxHeight) {
    const scale = d.font.scale;
    const commentBlock = fitTextBlock(ctx, d.decor?.jinjiangComment || DECOR_TEXT.jinjiangComment, {
        width: JJ_COMMENT_TEXT_W,
        maxHeight: 120,
        size: 28 * scale,
        lineHeight: 1.5,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.3,
        minScale: 0.85,
    });
    const commentH = Math.max(42, commentBlock.lines.length * commentBlock.lh);
    const commentBoxH = Math.max(96, commentH + 48);
    const footerH = 112 + commentBoxH;
    const bodyMax = Math.max(
        160,
        maxHeight - JJ_PANEL_TOP - JJ_BODY_PAD * 2 - JJ_ACTION_H - footerH,
    );
    const block = fitTextBlockAuto(ctx, d.text, {
        width: JJ_BODY_W,
        maxHeight: bodyMax,
        size: 36 * scale,
        lineHeight: 1.8,
        stack: d.font.stack,
        weight: '400',
        tracking: 0.4,
    });
    const bodyH = block.lines.length * block.lh;
    const minPanelH = Math.max(0, CARD_H_MIN - JJ_PANEL_TOP - JJ_ACTION_H - footerH);
    const panelH = Math.max(bodyH + JJ_BODY_PAD * 2, minPanelH);
    const height = Math.max(
        CARD_H_MIN,
        Math.min(maxHeight, JJ_PANEL_TOP + panelH + JJ_ACTION_H + footerH),
    );
    return { height, block, bodyH, panelH, commentBlock, commentH, commentBoxH, footerH };
}

function drawJinjiang(ctx, d, t, layout) {
    const height = layout.height;
    const scale = d.font.scale;

    ctx.fillStyle = t.paper;
    ctx.fillRect(0, 0, CARD_W, height);

    // 顶部绿色标题栏
    ctx.fillStyle = t.accent;
    ctx.fillRect(0, 0, CARD_W, JJ_HEAD_H);
    drawNavBack(ctx, 58, JJ_HEAD_H / 2, 30, '#ffffff', 3.4);

    const title = d.chatName || d.char || '标题';
    const titleSize = fitSingleLine(ctx, title, {
        size: 48 * Math.min(1, scale + 0.06),
        width: 660,
        stack: d.font.stack,
        weight: '600',
        tracking: 2,
        minSize: 26,
    });
    text(ctx, title, CARD_W / 2, JJ_HEAD_H / 2 + titleSize * 0.36, {
        size: titleSize,
        stack: d.font.stack,
        weight: '600',
        color: '#ffffff',
        tracking: 2,
        align: 'center',
    });

    if (d.mesid) {
        text(ctx, `#${d.mesid}`, 944, JJ_HEAD_H / 2 + 10, {
            size: 26 * scale,
            stack: MONO_STACK,
            color: 'rgba(255,255,255,0.88)',
            tracking: 0.5,
            align: 'right',
        });
    }
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.moveTo(968, JJ_HEAD_H / 2 - 11);
    ctx.lineTo(1014, JJ_HEAD_H / 2 - 11);
    ctx.lineTo(991, JJ_HEAD_H / 2 + 18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 分类胶囊
    ctx.fillStyle = t.paper;
    ctx.fillRect(0, JJ_HEAD_H, CARD_W, JJ_NAV_H);
    ctx.save();
    ctx.strokeStyle = rgba(t.ink, 0.08);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, JJ_CONTENT_TOP - 0.5);
    ctx.lineTo(CARD_W, JJ_CONTENT_TOP - 0.5);
    ctx.stroke();
    ctx.restore();

    const pills = ['章评', '段评', '话题', '长评', '加精'];
    const pillW = 140;
    const pillH = 54;
    const pillGap = 20;
    const pillX = 28;
    const pillY = JJ_HEAD_H + (JJ_NAV_H - pillH) / 2;
    const pillFill = mixColor(t.accent, '#ffffff', 0.30);
    pills.forEach((label, index) => {
        const x = pillX + index * (pillW + pillGap);
        ctx.save();
        roundRectPath(ctx, x, pillY, pillW, pillH, pillH / 2);
        ctx.fillStyle = pillFill;
        ctx.fill();
        ctx.restore();
        text(ctx, label, x + pillW / 2, pillY + pillH / 2 + 9, {
            size: 26 * scale,
            stack: d.font.stack,
            weight: '500',
            color: '#ffffff',
            tracking: 1.5,
            align: 'center',
        });
    });
    drawGridIcon(ctx, 948, JJ_HEAD_H + (JJ_NAV_H - 46) / 2, 46, t.accent);

    // 圆形头像 + 角色名 + 时间
    const avatarX = JJ_PAD;
    const avatarY = JJ_AVATAR_Y;
    if (!drawImageCover(ctx, d.avatar, avatarX, avatarY, JJ_AVATAR, JJ_AVATAR, JJ_AVATAR / 2)) {
        drawAvatarFallback(ctx, avatarX, avatarY, JJ_AVATAR, JJ_AVATAR, JJ_AVATAR / 2, d.char, t);
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + JJ_AVATAR / 2, avatarY + JJ_AVATAR / 2, JJ_AVATAR / 2, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(t.accent, 0.45);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    text(ctx, d.char, avatarX + JJ_AVATAR + 28, avatarY + JJ_AVATAR / 2 + 11, {
        size: 30 * scale,
        stack: d.font.stack,
        weight: '600',
        color: rgba(t.ink, 0.55),
        tracking: 0.7,
    });
    text(ctx, d.time, CARD_W - JJ_PAD, avatarY + JJ_AVATAR / 2 + 8, {
        size: 22 * scale,
        stack: MONO_STACK,
        color: rgba(t.ink, 0.35),
        tracking: 0.3,
        align: 'right',
    });

    // 正文虚线框只是示意，不画边框 / 底色；正文直接排在白底上
    const panelX = JJ_PAD;
    const panelY = JJ_PANEL_TOP;
    const panelH = layout.panelH;

    const bodyTop = panelY + Math.max(JJ_BODY_PAD, (panelH - layout.bodyH) / 2);
    // 短句像截图一样居中，长评仍左对齐，避免整段文字居中后难读
    const centerBody = layout.block.lines.length <= 2;
    drawTextBlock(ctx, layout.block, centerBody ? CARD_W / 2 : panelX + JJ_BODY_PAD, bodyTop, {
        stack: d.font.stack,
        weight: '400',
        color: t.ink,
        tracking: 0.4,
        align: centerBody ? 'center' : 'left',
    });

    // 正文下方的爱心 / 更多
    const actionY = panelY + panelH + JJ_ACTION_H / 2;
    drawHeart(ctx, CARD_W - 150, actionY, 66, t.accent);
    drawMoreDots(ctx, CARD_W - 68, actionY, 5, 17, rgba(t.ink, 0.55));

    // 评论区
    const sectionTop = height - layout.footerH;
    ctx.fillStyle = mixColor(t.paper, t.ink, 0.045);
    ctx.fillRect(0, sectionTop, CARD_W, layout.footerH);
    ctx.save();
    ctx.strokeStyle = rgba(t.ink, 0.07);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, sectionTop + 0.5);
    ctx.lineTo(CARD_W, sectionTop + 0.5);
    ctx.stroke();
    ctx.restore();

    text(ctx, d.user, JJ_PAD, sectionTop + 54, {
        size: 30 * scale,
        stack: d.font.stack,
        weight: '500',
        color: rgba(t.ink, 0.50),
        tracking: 0.5,
    });

    const boxY = sectionTop + 76;
    const boxH = layout.commentBoxH;
    // 评论虚线框只是示意，不画边框 / 底色；文字直接写在浅灰区域上
    drawTextBlock(ctx, layout.commentBlock, JJ_PAD, boxY + 24, {
        stack: d.font.stack,
        weight: '400',
        color: t.ink,
        tracking: 0.3,
    });

    const commentCenter = boxY + boxH / 2;
    drawHeart(ctx, 984, commentCenter, 52, t.accent);
    drawMoreDots(ctx, 1040, commentCenter, 4.5, 16, rgba(t.ink, 0.5));
}

const TEMPLATES = [
    {
        id: 'archive',
        name: '档案馆',
        desc: '原生样式 · 无头像',
        defaults: { paper: '#FDFBF7', ink: '#3B322D', accent: '#A45050' },
        layout: layoutArchive,
        draw: drawArchive,
    },
    {
        id: 'polaroid',
        name: '社媒',
        desc: '圆形头像 · 互动栏',
        defaults: { paper: '#FEFCF8', ink: '#3B322D', accent: '#A45050' },
        layout: layoutPolaroid,
        draw: drawPolaroid,
    },
    {
        id: 'letter',
        name: '信纸',
        desc: '横格线 · 羽毛',
        defaults: { paper: '#FCFAF6', ink: '#3B322D', accent: '#A45050' },
        layout: layoutLetter,
        draw: drawLetter,
    },
    {
        id: 'collage',
        name: '小报',
        desc: '头像 · 图钉 · 折角',
        defaults: { paper: '#FDFBF7', ink: '#3B322D', accent: '#A45050' },
        layout: layoutCollage,
        draw: drawCollage,
    },
    {
        id: 'postcard',
        name: '明信片',
        desc: '固定横版 · 邮编格',
        defaults: { paper: '#FDFBF7', ink: '#3B322D', accent: '#A45050' },
        layout: layoutPostcard,
        draw: drawPostcard,
    },
    {
        id: 'diary',
        name: '日记',
        desc: '叠纸 · 横格 · 便签',
        defaults: { paper: '#FCFAF4', ink: '#3B322D', accent: '#A45050' },
        layout: layoutDiary,
        draw: drawDiary,
    },
    {
        id: 'moments',
        name: '朋友圈',
        desc: '动态详情 · 点赞评论',
        defaults: { paper: '#FFFFFF', ink: '#1B1B1B', accent: '#576B95' },
        layout: layoutMoments,
        draw: drawMoments,
    },
    {
        id: 'jinjiang',
        name: '晋江评论',
        desc: '书评界面 · 章评标签',
        defaults: { paper: '#FFFFFF', ink: '#3A3A3A', accent: '#5BA58F' },
        layout: layoutJinjiang,
        draw: drawJinjiang,
    },
];

const TEMPLATE_BY_ID = TEMPLATES.reduce((acc, item) => { acc[item.id] = item; return acc; }, {});

function makeTheme(template, colors) {
    const base = template.defaults;
    const paper = colors?.paper || base.paper;
    const ink = colors?.ink || base.ink;
    const accent = colors?.accent || base.accent;
    return {
        paper,
        ink,
        accent,
        paperDeep: mixColor(paper, ink, 0.06),
        inkSoft: rgba(ink, 0.62),
        accentSoft: rgba(accent, 0.5),
    };
}

/**
 * 读取外观设置（theme.js）落到 :root 的变量。
 * 外观还是默认值时返回 null —— 这样卡片的默认样子和之前完全一样；
 * 一旦用户改过配色，卡片就跟着主题走，不至于"界面绿了、卡片还是红的"。
 */
function readGlobalPalette() {
    try {
        const style = getComputedStyle(document.documentElement);
        const read = (name) => String(style.getPropertyValue(name) || '').trim().toLowerCase();
        const accent = read('--sa-accent');
        const paper = read('--sa-paper');
        const ink = read('--sa-ink');
        if (!accent || !paper || !ink) return null;
        if (accent === '#a45050' && paper === '#fdfbf7' && ink === '#4a4a4a') return null;
        return { accent, paper, ink };
    } catch (error) {
        return null;
    }
}

// ============================================================
// 五、渲染入口
// ============================================================

/**
 * 先排版、再决定卡片高度。返回的 layout 会传给对应模板的 draw。
 * @param {'templateId'} templateId
 * @param {object} data 文案数据
 * @param {{sizeKey:string,fontKey:string,colors:object}} appearance
 * @param {{maxHeight?:number}} options
 */
function layoutCard(templateId, data, appearance, options = {}) {
    const template = TEMPLATE_BY_ID[templateId] || TEMPLATES[0];
    const font = FONT_BY_KEY[appearance?.fontKey] || FONT_STYLES[0];
    const step = SIZE_STEPS.find(item => item.key === appearance?.sizeKey) || SIZE_STEPS[1];
    const maxHeight = Math.max(CARD_H_MIN, Math.min(CARD_H_MAX, options.maxHeight ?? CARD_H_MAX));
    const ctx = getMeasureContext();
    const layout = template.layout(ctx, {
        ...data,
        font: { stack: font.stack, key: font.key, scale: step.scale },
        decor: resolveDecorTexts(appearance?.texts),
    }, maxHeight);
    layout.width = CARD_W;
    layout.truncated = Boolean(layout.block?.truncated);
    return layout;
}

/**
 * 把卡片画进一个 canvas。
 * @param {HTMLCanvasElement} canvas
 * @param {number} pixelWidth 像素宽度（1080 为原尺寸；高度按布局自动算）
 * @param {'templateId'} templateId
 * @param {object} data 文案数据
 * @param {{sizeKey:string,fontKey:string,colors:object}} appearance
 * @param {{autoHeight?:boolean, maxHeight?:number, layout?:object}} options
 */
function renderCard(canvas, pixelWidth, templateId, data, appearance, options = {}) {
    const template = TEMPLATE_BY_ID[templateId] || TEMPLATES[0];
    const font = FONT_BY_KEY[appearance?.fontKey] || FONT_STYLES[0];
    const step = SIZE_STEPS.find(item => item.key === appearance?.sizeKey) || SIZE_STEPS[1];
    const theme = makeTheme(template, appearance?.colors);

    const maxHeight = options.autoHeight
        ? Math.max(CARD_H_MIN, Math.min(CARD_H_MAX, options.maxHeight ?? CARD_H_MAX))
        : CARD_H_MIN;
    const layout = options.layout || layoutCard(templateId, data, appearance, { maxHeight });

    const pxW = Math.max(1, Math.round(pixelWidth));
    const scale = pxW / CARD_W;
    const pxH = Math.max(1, Math.round(layout.height * scale));
    if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
    }

    lastRenderTruncated = Boolean(layout.truncated);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pxW, pxH);
    ctx.save();
    ctx.scale(scale, scale);
    template.draw(ctx, {
        ...data,
        font: { stack: font.stack, key: font.key, scale: step.scale },
        decor: resolveDecorTexts(appearance?.texts),
    }, theme, layout);
    ctx.restore();
    return canvas;
}

// ============================================================
// 六、数据层：从详情弹窗还原当前收藏 + 角色头像
// ============================================================

function getShContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch (error) {
        console.warn('[ST-档案馆·导出] 读取酒馆上下文失败', error);
        return null;
    }
}

function readArchiveQuotes() {
    const ctx = getShContext();
    const state = ctx?.extensionSettings?.[STATE_KEY];
    return Array.isArray(state?.quotes) ? state.quotes : [];
}

function readDetailSnapshot() {
    const dialog = document.getElementById('quote-detail-overlay');
    if (!dialog) return null;

    const title = (dialog.querySelector('.quote-detail-title')?.textContent || '').trim();
    const meta = (dialog.querySelector('.quote-detail-meta')?.textContent || '').trim();
    const body = (dialog.querySelector('.quote-detail-text')?.textContent || '').trim();

    const parts = meta.split('·').map(part => part.trim()).filter(Boolean);
    let mesid = '';
    let char = '';
    let time = '';

    parts.forEach(part => {
        if (/^#\d+$/.test(part)) mesid = part.slice(1);
    });
    if (parts.length) char = parts[0];
    if (parts.length > 1) time = parts[parts.length - 1] === char ? '' : parts[parts.length - 1];

    // 标题固定是「角色 - 对话名」；角色名里可能也含「 - 」，优先按角色名剥前缀
    let chatName = '';
    if (char && title.startsWith(`${char} - `)) {
        chatName = title.slice(char.length + 3).trim();
    } else if (title.includes(' - ')) {
        const index = title.indexOf(' - ');
        chatName = title.slice(index + 3).trim();
    }
    if (!chatName) chatName = title;

    return { title, meta, body, char, chatName, mesid, time };
}

function resolveCurrentQuote() {
    const snapshot = readDetailSnapshot();
    if (!snapshot) return null;

    const bodyKey = normalizeText(snapshot.body);
    const quotes = readQuotesSafe().filter(item => normalizeText(item.text) === bodyKey);

    let matched = null;
    if (quotes.length === 1) {
        matched = quotes[0];
    } else if (quotes.length > 1) {
        matched = quotes.find(item => String(item.mesid ?? '') === snapshot.mesid)
            || quotes.find(item => String(item.time ?? '') === snapshot.time)
            || quotes[0];
    }

    const char = matched?.char || snapshot.char || '未知角色';
    const chatName = matched?.chatName || snapshot.chatName || '未命名聊天';

    return {
        char: String(char).trim() || '未知角色',
        chatName: String(chatName).trim() || '未命名聊天',
        text: matched?.text || snapshot.body || '',
        time: matched?.time || snapshot.time || '',
        mesid: String(matched?.mesid ?? snapshot.mesid ?? ''),
        scope: matched?.scope || '',
        chatKey: matched?.chatKey || '',
    };
}

function readQuotesSafe() {
    try {
        return readArchiveQuotes();
    } catch (error) {
        console.warn('[ST-档案馆·导出] 读取收藏失败', error);
        return [];
    }
}

function toThumbUrl(ctx, type, file) {
    if (!file) return '';
    try {
        const url = ctx?.getThumbnailUrl?.(type, file);
        if (typeof url === 'string' && url) return url;
    } catch (error) {
        /* 忽略：走兜底路径 */
    }
    return `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`;
}

/** 从 scope（char:xxx.png / group:12）解析角色头像 URL */
function resolveAvatarUrl(quote, ctx) {
    const scope = String(quote.scope || '').trim()
        || String(quote.chatKey || '').split('::')[0]
        || '';

    if (scope.startsWith('char:')) return toThumbUrl(ctx, 'avatar', scope.slice(5));

    if (scope.startsWith('group:')) {
        const groupId = scope.slice(6);
        const group = ctx?.groups?.find?.(item => String(item?.id) === groupId);
        const file = group?.avatar_url || group?.avatar;
        if (file) return toThumbUrl(ctx, 'avatar', file);
        return '';
    }

    // 旧数据没有 scope：退化成「当前角色」
    const current = ctx?.characters?.[ctx?.characterId];
    if (current?.avatar) return toThumbUrl(ctx, 'avatar', current.avatar);
    return '';
}

/**
 * 当前用户（persona）头像 URL：优先用人设面板里选中的 persona，
 * 其次是本聊天锁定的 persona，最后退到默认 persona。
 * 都没有时返回空字符串，由调用方画首字兜底头像。
 */
function resolveUserAvatarUrl(ctx) {
    const domSelected = document
        .querySelector('#user_avatar_block .avatar-container.selected')
        ?.getAttribute('data-avatar-id') || '';
    const file = String(
        domSelected
        || ctx?.chatMetadata?.persona
        || ctx?.powerUserSettings?.default_persona
        || '',
    ).trim();
    return toThumbUrl(ctx, 'persona', file);
}

function loadImage(url) {
    return new Promise(resolve => {
        if (!url) {
            resolve(null);
            return;
        }
        const image = new Image();
        image.decoding = 'sync';
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = url;
    });
}

async function buildCardData(quote) {
    const ctx = getShContext();
    const user = String(ctx?.name1 || ctx?.name || '').trim() || 'user';
    const [avatar, userAvatar] = await Promise.all([
        loadImage(resolveAvatarUrl(quote, ctx)),
        loadImage(resolveUserAvatarUrl(ctx)),
    ]);

    return {
        char: quote.char,
        chatName: quote.chatName,
        text: quote.text,
        time: quote.time,
        mesid: quote.mesid,
        user,
        avatar,
        userAvatar,
    };
}

// ============================================================
// 七、导出偏好（模板 / 字号 / 字体 / 配色 / 文案）
// ============================================================

function readExportSettings() {
    const ctx = getShContext();
    const raw = ctx?.extensionSettings?.[EXPORT_SETTINGS_KEY];
    if (!raw || typeof raw !== 'object') {
        return { templateId: 'archive', sizeKey: 'm', fontKey: 'song', colors: {}, texts: {} };
    }
    return {
        templateId: TEMPLATE_BY_ID[raw.templateId] ? raw.templateId : 'archive',
        sizeKey: SIZE_STEPS.some(step => step.key === raw.sizeKey) ? raw.sizeKey : 'm',
        fontKey: FONT_BY_KEY[raw.fontKey] ? raw.fontKey : 'song',
        colors: (raw.colors && typeof raw.colors === 'object') ? raw.colors : {},
        texts: (raw.texts && typeof raw.texts === 'object') ? raw.texts : {},
    };
}

function saveExportSettings(patch) {
    const ctx = getShContext();
    if (!ctx?.extensionSettings) return;
    const next = { ...readExportSettings(), ...patch };
    ctx.extensionSettings[EXPORT_SETTINGS_KEY] = next;
    try {
        ctx.saveSettingsDebounced?.();
    } catch (error) {
        console.warn('[ST-档案馆·导出] 保存导出偏好失败', error);
    }
}

// ============================================================
// 八、导出 / 保存
// ============================================================

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        if (typeof canvas.toBlob === 'function') {
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('图片编码失败'));
            }, 'image/png');
            return;
        }
        try {
            const dataUrl = canvas.toDataURL('image/png');
            const base64 = dataUrl.split(',')[1] || '';
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            resolve(new Blob([bytes], { type: 'image/png' }));
        } catch (error) {
            reject(error);
        }
    });
}

function buildFileName(data) {
    const stamp = String(data.time || '').replace(/[^\d]/g, '').slice(0, 14) || String(Date.now());
    return `拾遗-${safeFileSegment(data.char, '角色')}-${safeFileSegment(data.chatName, '聊天')}-${stamp}.png`;
}

function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(url);
    }, 15000);
}

// ============================================================
// 九、浮层 UI
// ============================================================

const UI_STYLE_ID = 'st-archive-export-style';

const UI_CSS = `
#quote-detail-overlay .sa-detail-export {
    margin: 0 2px 0 0;
    flex-shrink: 0;
    width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
    background: none; color: var(--sa-accent, #a45050);
    font-size: 14px; line-height: 1; cursor: pointer; box-shadow: none;
    display: inline-flex; align-items: center; justify-content: center;
    transition: color .2s, background .2s;
}
#quote-detail-overlay .sa-detail-export:hover {
    color: var(--sa-accent-deep, #8b3a3a);
    background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.08);
}
/* 详情弹窗一打开焦点会落在第一个可聚焦元素（就是这个按钮），别让它自带黑框 */
#quote-detail-overlay .sa-detail-export:focus { outline: none; }
#quote-detail-overlay .sa-detail-export:focus-visible {
    outline: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.55);
    outline-offset: 2px;
}

#sa-export-overlay {
    position: fixed; inset: 0;
    width: 100%; height: 100%; height: 100dvh;
    max-width: none; max-height: none;
    margin: 0; padding: 10px;
    border: 0;
    background: transparent;
    z-index: 2147483001;
    box-sizing: border-box;
    display: none;
    justify-content: center;
    align-items: safe center;
    overflow: hidden;
}
#sa-export-overlay[open] { display: flex; }
#sa-export-overlay::backdrop {
    background: rgba(28, 22, 20, .5);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
}
#sa-export-overlay .sa-export-panel {
    position: relative;
    display: flex; flex-direction: column;
    width: min(94vw, 520px);
    max-height: min(92dvh, 100%);
    margin: auto;
    background: var(--sa-paper, #FDFBF7);
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.40);
    border-radius: 14px;
    overflow: hidden;
    color: var(--sa-ink, #4A4A4A);
    font-family: 'Noto Serif SC', 'Songti SC', 'Microsoft YaHei', serif;
    box-shadow: 0 20px 60px rgba(40, 26, 20, .3);
    animation: saExportIn .2s ease-out;
}
@keyframes saExportIn {
    from { opacity: 0; transform: translateY(8px) scale(.985); }
    to { opacity: 1; transform: none; }
}
#sa-export-overlay .sa-export-head {
    flex-shrink: 0;
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px 10px;
    border-bottom: 1px dashed rgba(var(--sa-accent-rgb, 164, 80, 80), 0.22);
}
#sa-export-overlay .sa-export-back,
#sa-export-overlay .sa-export-close {
    flex-shrink: 0;
    width: 28px; height: 28px; padding: 0;
    border: 0; border-radius: 6px; background: transparent;
    color: var(--sa-accent, #a45050);
    font-size: 15px; line-height: 1; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    box-shadow: none;
}
#sa-export-overlay .sa-export-close { margin-left: auto; font-size: 22px; font-family: Arial, sans-serif; }
#sa-export-overlay .sa-export-back[hidden] { display: none; }
#sa-export-overlay .sa-export-back:hover,
#sa-export-overlay .sa-export-close:hover {
    background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.10);
}
/* 弹层里不需要浏览器默认的粗黑焦点框，键盘操作时给一条细线即可 */
#sa-export-overlay button:focus,
#sa-export-overlay .sa-export-panel:focus { outline: none; }
#sa-export-overlay button:focus-visible {
    outline: 1.5px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.50);
    outline-offset: 2px;
}
#sa-export-overlay button svg { display: block; pointer-events: none; }
#sa-export-overlay .sa-export-heading { min-width: 0; flex: 1; }
#sa-export-overlay .sa-export-title {
    font-size: 14px; letter-spacing: 1.6px;
    color: var(--sa-accent-deep, #8b3a3a);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#sa-export-overlay .sa-export-sub {
    margin-top: 3px; font-size: 10px; letter-spacing: .6px;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.45);
    font-family: 'Courier New', Courier, monospace;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#sa-export-overlay .sa-export-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
    scrollbar-width: thin;
    padding: 14px;
}
#sa-export-overlay .sa-step { display: none; }
#sa-export-overlay .sa-step.is-on { display: block; }

/* 模板选择 */
#sa-export-overlay .sa-tpl-grid {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    align-content: start; gap: 12px;
}
#sa-export-overlay .sa-tpl {
    display: block; width: 100%;
    padding: 8px; border-radius: 10px;
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.18);
    background: rgba(255, 255, 255, .35);
    cursor: pointer; text-align: left;
    transition: border-color .18s, background .18s, transform .18s;
}
#sa-export-overlay .sa-tpl:hover {
    border-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.50);
    background: rgba(255, 255, 255, .7);
}
#sa-export-overlay .sa-tpl:active { transform: scale(.985); }
#sa-export-overlay .sa-tpl canvas {
    display: block; width: 100%; height: auto;
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(60, 40, 30, .12);
    background: #fff;
}
#sa-export-overlay .sa-tpl-name {
    margin-top: 7px; font-size: 12px; letter-spacing: 1px;
    color: var(--sa-accent-deep, #8b3a3a);
}
#sa-export-overlay .sa-tpl-desc {
    margin-top: 2px; font-size: 9.5px; letter-spacing: .2px;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.45);
    font-family: 'Courier New', Courier, monospace;
}

/* 微调 */
#sa-export-overlay .sa-adjust-preview {
    display: flex; flex-direction: column; align-items: center; gap: 7px;
    padding: 2px 0 14px;
}
#sa-export-overlay .sa-adjust-preview canvas {
    width: auto; height: auto;
    max-width: min(78vw, 300px);
    max-height: 52vh;
    max-height: 52dvh;
    display: block;
    border-radius: 8px;
    box-shadow: 0 4px 18px rgba(60, 40, 30, .16);
    background: #fff;
    cursor: zoom-in;
}
#sa-export-overlay .sa-zoom-hint {
    font-size: 9.5px; letter-spacing: 1px;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.35);
    font-family: 'Courier New', Courier, monospace;
}

/* 轻点放大：铺满整个面板的一层，专门给手机看小字用 */
#sa-export-overlay .sa-zoom {
    position: absolute; inset: 0; z-index: 8;
    display: none; align-items: center; justify-content: center;
    background: rgba(24, 18, 16, .88);
    padding: 12px; cursor: zoom-out;
}
#sa-export-overlay .sa-zoom.is-on { display: flex; }
#sa-export-overlay .sa-zoom canvas {
    width: auto; height: auto;
    max-width: 100%;
    max-height: 100%;
    border-radius: 8px;
    box-shadow: 0 12px 44px rgba(0, 0, 0, .45);
}
#sa-export-overlay .sa-rows { display: flex; flex-direction: column; gap: 12px; }
#sa-export-overlay .sa-row {
    display: flex; align-items: center; gap: 10px;
}
#sa-export-overlay .sa-row-label {
    flex-shrink: 0; width: 40px;
    font-size: 11px; letter-spacing: 1.4px;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.55);
}
#sa-export-overlay .sa-seg,
#sa-export-overlay .sa-chips {
    display: flex; gap: 4px; flex-wrap: wrap; flex: 1;
}
#sa-export-overlay .sa-seg button,
#sa-export-overlay .sa-chips button {
    appearance: none; -webkit-appearance: none;
    min-width: 44px; height: 28px; padding: 0 10px;
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.18);
    border-radius: 6px;
    background: transparent;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.60);
    font-family: inherit; font-size: 11.5px; letter-spacing: .8px;
    cursor: pointer; box-shadow: none;
    transition: all .18s;
}
#sa-export-overlay .sa-seg button:hover,
#sa-export-overlay .sa-chips button:hover {
    border-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.45);
    color: var(--sa-accent-deep, #8b3a3a);
}
#sa-export-overlay .sa-seg button.is-on,
#sa-export-overlay .sa-chips button.is-on {
    background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.10);
    border-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.55);
    color: var(--sa-accent-deep, #8b3a3a);
    font-weight: 600;
}
#sa-export-overlay .sa-colors { display: flex; gap: 8px; flex: 1; align-items: center; flex-wrap: wrap; }
#sa-export-overlay .sa-color-badge {
    font-size: 9.5px; letter-spacing: .6px; line-height: 1.6;
    padding: 2px 8px; border-radius: 10px;
    color: rgba(var(--sa-accent-rgb, 164, 80, 80), .9);
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), .32);
    background: rgba(var(--sa-accent-rgb, 164, 80, 80), .07);
    white-space: nowrap;
}
#sa-export-overlay .sa-color-badge[hidden] { display: none; }
#sa-export-overlay .sa-color {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 7px 3px 5px;
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.18);
    border-radius: 6px;
    font-size: 10.5px; letter-spacing: .6px;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.55);
    cursor: pointer;
}
#sa-export-overlay .sa-color-dot {
    width: 18px; height: 18px; border-radius: 4px;
    border: 1px solid rgba(0, 0, 0, .18);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35);
}


#sa-export-overlay .sa-color-reset {
    appearance: none; -webkit-appearance: none;
    height: 26px; padding: 0 8px;
    border: 1px dashed rgba(var(--sa-accent-rgb, 164, 80, 80), 0.30);
    border-radius: 6px; background: transparent;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.45);
    font-family: inherit; font-size: 10.5px; cursor: pointer; box-shadow: none;
}
#sa-export-overlay .sa-row[hidden] { display: none; }
#sa-export-overlay .sa-texts {
    display: flex; flex-direction: column; gap: 7px;
    flex: 1; min-width: 0;
}
#sa-export-overlay .sa-text-field {
    display: flex; flex-direction: column; gap: 3px;
}
#sa-export-overlay .sa-text-label {
    font-size: 9.5px; letter-spacing: .8px;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.40);
}
#sa-export-overlay .sa-text-input {
    width: 100%; box-sizing: border-box;
    padding: 5px 8px;
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.22);
    border-radius: 6px;
    background: rgba(255, 255, 255, .45);
    color: var(--sa-ink, #4A4A4A);
    font-family: inherit; font-size: 11.5px; line-height: 1.5;
    resize: none; outline: none;
    transition: border-color .18s, background .18s;
}
#sa-export-overlay .sa-text-input:focus {
    border-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.55);
    background: rgba(255, 255, 255, .8);
}
#sa-export-overlay .sa-text-input::placeholder {
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.28);
}
#sa-export-overlay .sa-text-reset {
    align-self: flex-start;
    appearance: none; -webkit-appearance: none;
    height: 24px; padding: 0 8px;
    border: 1px dashed rgba(var(--sa-accent-rgb, 164, 80, 80), 0.30);
    border-radius: 6px; background: transparent;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.45);
    font-family: inherit; font-size: 10px; cursor: pointer; box-shadow: none;
}
#sa-export-overlay .sa-text-reset:hover {
    color: var(--sa-accent-deep, #8b3a3a);
    border-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.50);
}
#sa-export-overlay .sa-hint {
    margin-top: 14px; font-size: 9.5px; line-height: 1.6;
    color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.35);
    font-family: 'Courier New', Courier, monospace;
}
#sa-export-overlay .sa-note {
    margin-top: 8px;
    font-size: 10.5px; line-height: 1.6; letter-spacing: .3px;
    color: var(--sa-accent-deep, #8b3a3a);
    text-align: center;
}
#sa-export-overlay .sa-note[hidden] { display: none; }

/* 预览 */
#sa-export-overlay .sa-preview-wrap {
    display: flex; justify-content: center;
    padding: 4px 0 6px;
}
#sa-export-overlay .sa-preview-wrap canvas {
    width: auto; height: auto;
    max-width: min(100%, 400px);
    max-height: 62vh;
    max-height: 62dvh;
    display: block;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(60, 40, 30, .18);
    background: #fff;
}

/* 底部按钮 */
#sa-export-overlay .sa-export-foot {
    flex-shrink: 0;
    display: flex; gap: 8px;
    padding: 10px 14px 12px;
    border-top: 1px dashed rgba(var(--sa-accent-rgb, 164, 80, 80), 0.22);
}
#sa-export-overlay .sa-btn {
    appearance: none; -webkit-appearance: none;
    flex: 1; height: 38px; padding: 0 12px;
    border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.40);
    border-radius: 8px;
    background: transparent;
    color: var(--sa-accent-deep, #8b3a3a);
    font-family: inherit; font-size: 12px; letter-spacing: 1.4px;
    cursor: pointer; box-shadow: none;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: background .18s, color .18s, opacity .18s;
}
#sa-export-overlay .sa-btn:hover { background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.08); }
#sa-export-overlay .sa-btn:active { background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.16); }
#sa-export-overlay .sa-btn.is-primary {
    background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.85);
    border-color: transparent;
    color: #fff;
}
#sa-export-overlay .sa-btn.is-primary:hover { background: var(--sa-accent, #a45050); }
#sa-export-overlay .sa-btn[disabled] { opacity: .5; pointer-events: none; }
#sa-export-overlay .sa-export-foot:empty { display: none; }

/* toast */
#sa-export-overlay .sa-toast {
    position: absolute; left: 50%; bottom: 74px;
    transform: translateX(-50%);
    max-width: calc(100% - 32px);
    padding: 8px 16px; border-radius: 20px;
    background: rgba(48, 34, 30, .9);
    color: #fff; font-size: 12px; letter-spacing: .6px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    box-shadow: 0 6px 22px rgba(0, 0, 0, .25);
    opacity: 0; pointer-events: none;
    transition: opacity .2s, transform .2s;
    z-index: 5;
}
#sa-export-overlay .sa-toast.is-on { opacity: 1; transform: translateX(-50%) translateY(-4px); }
#sa-export-overlay .sa-toast.is-error { background: rgba(120, 40, 34, .95); }

@media (max-width: 380px) {
    #sa-export-overlay .sa-export-body { padding: 10px; }
    #sa-export-overlay .sa-tpl-grid { gap: 8px; }
    #sa-export-overlay .sa-row-label { width: 34px; }
}

/* 宽屏：面板跟着视口放大，不然 4K / 超宽屏上会缩成一小块 */
@media (min-width: 820px) {
    #sa-export-overlay { padding: 18px; }
    #sa-export-overlay .sa-export-panel {
        width: min(94vw, clamp(540px, 42vw, 780px));
        border-radius: 16px;
    }
    #sa-export-overlay .sa-export-head { padding: 16px 20px 13px; gap: 10px; }
    #sa-export-overlay .sa-export-title { font-size: 16px; letter-spacing: 2px; }
    #sa-export-overlay .sa-export-sub { font-size: 11px; margin-top: 4px; }
    #sa-export-overlay .sa-export-back,
    #sa-export-overlay .sa-export-close { width: 32px; height: 32px; font-size: 17px; }
    #sa-export-overlay .sa-export-close { font-size: 26px; }
    #sa-export-overlay .sa-export-body { padding: 18px; }
    #sa-export-overlay .sa-tpl-grid { gap: 16px; }
    #sa-export-overlay .sa-tpl { padding: 10px; border-radius: 12px; }
    #sa-export-overlay .sa-tpl-name { margin-top: 9px; font-size: 13.5px; letter-spacing: 1.4px; }
    #sa-export-overlay .sa-tpl-desc { margin-top: 3px; font-size: 10.5px; }
    #sa-export-overlay .sa-adjust-preview { padding: 2px 0 18px; }
    #sa-export-overlay .sa-adjust-preview canvas {
        max-width: clamp(220px, 26vw, 340px);
        max-height: 60vh;
        max-height: 60dvh;
    }
    #sa-export-overlay .sa-preview-wrap canvas { max-width: 560px; }
    #sa-export-overlay .sa-rows { gap: 14px; }
    #sa-export-overlay .sa-row { gap: 14px; }
    #sa-export-overlay .sa-row-label { width: 52px; font-size: 12.5px; }
    #sa-export-overlay .sa-seg button,
    #sa-export-overlay .sa-chips button {
        height: 34px; min-width: 56px; padding: 0 14px; font-size: 13px; border-radius: 7px;
    }
    #sa-export-overlay .sa-colors { gap: 10px; }
    #sa-export-overlay .sa-color {
        padding: 4px 10px 4px 6px; font-size: 11.5px; border-radius: 7px; gap: 7px;
    }
    #sa-export-overlay .sa-color input[type="color"] { width: 26px; height: 24px; }
    #sa-export-overlay .sa-color-reset { height: 30px; padding: 0 11px; font-size: 11.5px; }
    #sa-export-overlay .sa-text-label { font-size: 10.5px; }
    #sa-export-overlay .sa-text-input { padding: 7px 10px; font-size: 13px; border-radius: 7px; }
    #sa-export-overlay .sa-text-reset { height: 27px; padding: 0 10px; font-size: 11px; }
    #sa-export-overlay .sa-hint { margin-top: 18px; font-size: 11px; line-height: 1.7; }
    #sa-export-overlay .sa-export-foot { padding: 12px 18px 14px; gap: 10px; }
    #sa-export-overlay .sa-btn { height: 44px; font-size: 13px; letter-spacing: 1.6px; border-radius: 9px; }
    #sa-export-overlay .sa-toast { bottom: 88px; font-size: 13px; padding: 9px 18px; }
}
`;

function injectUiStyle() {
    if (document.getElementById(UI_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = UI_STYLE_ID;
    style.textContent = UI_CSS;
    document.head.appendChild(style);
}

/** 手机 / 内置浏览器：把弹层钉在「当前真正看得见的视口」里 */
function pinToVisibleViewport(element) {
    if (!element) return;
    const viewport = window.visualViewport;
    const width = Math.round((viewport ? viewport.width : window.innerWidth) || 0);
    let height = Math.round((viewport ? viewport.height : window.innerHeight) || 0);
    if (width <= 0 || height <= 0) return;
    if (!viewport) {
        const screenHeight = Math.round(Number(window.screen?.height) || 0);
        if (screenHeight > 0 && height > screenHeight * 1.1) height = screenHeight;
    }
    element.style.top = `${Math.round(viewport ? viewport.offsetTop : 0)}px`;
    element.style.left = `${Math.round(viewport ? viewport.offsetLeft : 0)}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
}

class ExportPanel {
    constructor() {
        this.dialog = null;
        this.data = null;
        this.settings = readExportSettings();
        this.step = 'template';
        this.toastTimer = 0;
        this.textRepaintTimer = 0;
        this.renderToken = 0;
        this.busy = false;
        this.layoutCache = null;
        this.textControlsFor = '';
        this.build();
    }

    build() {
        if (this.dialog) return;

        const dialog = document.createElement('dialog');
        dialog.id = 'sa-export-overlay';
        dialog.setAttribute('aria-label', '导出卡片');
        dialog.innerHTML = `
            <div class="sa-export-panel" role="document" tabindex="-1">
                <div class="sa-export-head">
                    <button type="button" class="sa-export-back" aria-label="返回" hidden>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M15 5l-7 7 7 7" />
                        </svg>
                    </button>
                    <div class="sa-export-heading">
                        <div class="sa-export-title">导出卡片</div>
                        <div class="sa-export-sub"></div>
                    </div>
                    <button type="button" class="sa-export-close" aria-label="关闭">&times;</button>
                </div>
                <div class="sa-export-body">
                    <section class="sa-step" data-step="template">
                        <div class="sa-tpl-grid"></div>
                    </section>
                    <section class="sa-step" data-step="adjust">
                        <div class="sa-adjust-preview">
                            <canvas></canvas>
                            <span class="sa-zoom-hint">轻点预览可放大</span>
                        </div>
                        <div class="sa-rows">
                            <div class="sa-row">
                                <div class="sa-row-label">字号</div>
                                <div class="sa-seg" data-group="size"></div>
                            </div>
                            <div class="sa-row">
                                <div class="sa-row-label">字体</div>
                                <div class="sa-chips" data-group="font"></div>
                            </div>
                            <div class="sa-row" data-row="text" hidden>
                                <div class="sa-row-label">文案</div>
                                <div class="sa-texts"></div>
                            </div>
                            <div class="sa-row">
                                <div class="sa-row-label">配色</div>
                                <div class="sa-colors"></div>
                            </div>
                        </div>
                        <div class="sa-hint">字形取决于当前系统已安装的字体；卡片会随正文自动长高，最高到手机一屏；配色可分别调整纸色、墨色与强调色；占位文案留空即恢复默认。</div>
                        <div class="sa-note" hidden></div>
                    </section>
                    <section class="sa-step" data-step="preview">
                        <div class="sa-preview-wrap"><canvas></canvas></div>
                        <div class="sa-note" hidden></div>
                    </section>
                </div>
                <div class="sa-export-foot"></div>
                <div class="sa-toast" role="status"></div>
                <div class="sa-zoom"><canvas></canvas></div>
            </div>
        `;
        document.body.appendChild(dialog);
        this.dialog = dialog;

        this.$title = dialog.querySelector('.sa-export-title');
        this.$sub = dialog.querySelector('.sa-export-sub');
        this.$back = dialog.querySelector('.sa-export-back');
        this.$foot = dialog.querySelector('.sa-export-foot');
        this.$toast = dialog.querySelector('.sa-toast');
        this.$grid = dialog.querySelector('.sa-tpl-grid');
        this.$steps = Array.from(dialog.querySelectorAll('.sa-step'));
        this.$textRow = dialog.querySelector('.sa-row[data-row="text"]');
        this.$texts = dialog.querySelector('.sa-texts');
        this.$adjustPreview = dialog.querySelector('.sa-adjust-preview canvas');
        this.$previewCanvas = dialog.querySelector('.sa-preview-wrap canvas');
        this.$zoom = dialog.querySelector('.sa-zoom');
        this.$zoomCanvas = dialog.querySelector('.sa-zoom canvas');

        dialog.querySelector('.sa-export-close').addEventListener('click', () => this.close());
        this.$back.addEventListener('click', () => this.goBack());
        this.$adjustPreview.addEventListener('click', () => this.openZoom());
        this.$zoom.addEventListener('click', () => this.closeZoom());
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) this.close();
        });
        dialog.addEventListener('cancel', (event) => {
            // ESC：先关放大层，再关面板
            if (this.$zoom.classList.contains('is-on')) {
                event.preventDefault();
                this.closeZoom();
            }
        });
        dialog.addEventListener('close', () => this.onClosed());
        window.addEventListener('resize', () => this.repin());
        window.addEventListener('orientationchange', () => this.repin());
        window.visualViewport?.addEventListener?.('resize', () => this.repin());

        this.buildGrid();
        this.buildAdjustControls();
    }

    // ---- 模板选择 ----
    buildGrid() {
        this.$grid.innerHTML = '';
        this.thumbCanvases = new Map();

        TEMPLATES.forEach(template => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'sa-tpl';
            item.dataset.template = template.id;
            item.innerHTML = `
                <canvas width="540" height="540"></canvas>
                <div class="sa-tpl-name"></div>
                <div class="sa-tpl-desc"></div>
            `;
            item.querySelector('.sa-tpl-name').textContent = template.name;
            item.querySelector('.sa-tpl-desc').textContent = template.desc;
            item.addEventListener('click', () => this.selectTemplate(template.id));
            this.$grid.appendChild(item);
            this.thumbCanvases.set(template.id, item.querySelector('canvas'));
        });
    }

    paintThumbnails() {
        const token = ++this.renderToken;
        const ids = TEMPLATES.map(template => template.id);
        const paintNext = (index) => {
            if (token !== this.renderToken || index >= ids.length || !this.data) return;
            const id = ids[index];
            const canvas = this.thumbCanvases.get(id);
            if (canvas) {
                renderCard(canvas, 540, id, this.data, this.appearanceFor(id));
            }
            requestAnimationFrame(() => paintNext(index + 1));
        };
        paintNext(0);
    }

    /** 当前模板实际生效的三色：模板默认 ← 外观主题 ← 该模板的手动覆盖 */
    effectiveColors(templateId) {
        const template = TEMPLATE_BY_ID[templateId] || TEMPLATES[0];
        const global = readGlobalPalette();
        return { ...template.defaults, ...(global || {}), ...(this.settings.colors[templateId] || {}) };
    }

    appearanceFor(templateId) {
        return {
            sizeKey: this.settings.sizeKey,
            fontKey: this.settings.fontKey,
            colors: this.effectiveColors(templateId),
            texts: this.settings.texts,
        };
    }

    // ---- 微调控件 ----
    buildAdjustControls() {
        const sizeBox = this.dialog.querySelector('.sa-seg[data-group="size"]');
        SIZE_STEPS.forEach(step => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.dataset.value = step.key;
            btn.textContent = step.label;
            btn.addEventListener('click', () => {
                this.settings.sizeKey = step.key;
                saveExportSettings({ sizeKey: step.key });
                this.syncAdjustSelection();
                this.repaintAdjust();
            });
            sizeBox.appendChild(btn);
        });

        const fontBox = this.dialog.querySelector('.sa-chips[data-group="font"]');
        FONT_STYLES.forEach(font => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.dataset.value = font.key;
            btn.textContent = font.label;
            btn.style.fontFamily = font.stack;
            btn.addEventListener('click', async () => {
                this.settings.fontKey = font.key;
                saveExportSettings({ fontKey: font.key });
                this.syncAdjustSelection();
                // 切到楷体时先把内置字体准备好，否则第一张会用回退字形渲染
                if (font.key === 'kai') await ensureBundledKai();
                this.repaintAdjust();
            });
            fontBox.appendChild(btn);
        });

        const colorBox = this.dialog.querySelector('.sa-colors');
        const slots = [
            { key: 'paper', label: '纸' },
            { key: 'ink', label: '墨' },
            { key: 'accent', label: '强调' },
        ];
        this.colorInputs = {};
        this.colorDots = {};
        slots.forEach(slot => {
            // 不用原生 <input type=color>：安卓上会弹系统取色器，样式完全不归我们管
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sa-color';
            button.dataset.slot = slot.key;
            const dot = document.createElement('span');
            dot.className = 'sa-color-dot';
            const label = document.createElement('span');
            label.textContent = slot.label;
            button.appendChild(dot);
            button.appendChild(label);
            colorBox.appendChild(button);
            this.colorDots[slot.key] = dot;

            button.addEventListener('click', () => {
                openColorPicker({
                    title: `选择颜色 · ${slot.label}`,
                    value: this.effectiveColors(this.settings.templateId)[slot.key],
                    onConfirm: (hex) => {
                        this.setColor(slot.key, hex);
                        this.syncColorInputs();
                    },
                });
            });
        });

        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'sa-color-reset';
        reset.textContent = '恢复默认';
        reset.addEventListener('click', () => {
            const id = this.settings.templateId;
            delete this.settings.colors[id];
            saveExportSettings({ colors: this.settings.colors });
            this.syncColorInputs();
            this.repaintAdjust();
        });
        colorBox.appendChild(reset);

        // 该模板被单独改过色时给个标记，免得「为什么这个模板不跟主题」找不到原因
        const badge = document.createElement('span');
        badge.className = 'sa-color-badge';
        badge.hidden = true;
        badge.textContent = '已自定义';
        badge.title = '这个模板的配色被单独改过；点「恢复默认」可回到主题色';
        colorBox.appendChild(badge);
        this.$colorBadge = badge;
    }

    setColor(slot, value) {
        const id = this.settings.templateId;
        const next = this.effectiveColors(id);
        next[slot] = value;
        this.settings.colors[id] = next;
        saveExportSettings({ colors: this.settings.colors });
        this.repaintAdjust();
    }

    syncAdjustSelection() {
        this.dialog.querySelectorAll('.sa-seg button').forEach(btn => {
            btn.classList.toggle('is-on', btn.dataset.value === this.settings.sizeKey);
        });
        this.dialog.querySelectorAll('.sa-chips button').forEach(btn => {
            btn.classList.toggle('is-on', btn.dataset.value === this.settings.fontKey);
        });
        this.syncTextControls();
        this.syncColorInputs();
    }

    /** 当前模板的装饰文案输入框；只有切换模板时才重建，避免打字时丢焦点 */
    syncTextControls() {
        const id = this.settings.templateId;
        if (this.textControlsFor === id) return;
        this.textControlsFor = id;

        const fields = TEMPLATE_TEXT_FIELDS[id] || [];
        this.$textRow.hidden = fields.length === 0;
        this.$texts.innerHTML = '';
        this.textInputs = {};

        fields.forEach(field => {
            const wrap = document.createElement('label');
            wrap.className = 'sa-text-field';

            const label = document.createElement('span');
            label.className = 'sa-text-label';
            label.textContent = field.label;

            const input = document.createElement(field.multiline ? 'textarea' : 'input');
            if (field.multiline) input.rows = 2;
            else input.type = 'text';
            input.className = 'sa-text-input';
            input.value = this.decorValue(field.key);
            input.placeholder = field.def;
            input.spellcheck = false;

            const autosize = () => {
                if (!field.multiline) return;
                input.style.height = 'auto';
                input.style.height = `${Math.min(140, Math.max(44, input.scrollHeight))}px`;
            };

            input.addEventListener('input', () => {
                this.setDecorText(field.key, input.value);
                autosize();
            });

            wrap.appendChild(label);
            wrap.appendChild(input);
            this.$texts.appendChild(wrap);
            this.textInputs[field.key] = input;
            autosize();
        });

        // 留空同样会回退到默认文案；这里再给一个一键恢复的入口
        if (fields.length) {
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'sa-text-reset';
            reset.textContent = '恢复默认文案';
            reset.addEventListener('click', () => {
                const next = { ...(this.settings.texts || {}) };
                fields.forEach(field => { delete next[field.key]; });
                this.settings.texts = next;
                saveExportSettings({ texts: next });
                this.layoutCache = null;
                fields.forEach(field => {
                    const input = this.textInputs[field.key];
                    if (!input) return;
                    input.value = '';
                    if (input.tagName === 'TEXTAREA') input.style.height = '';
                });
                this.repaintAdjust();
            });
            this.$texts.appendChild(reset);
        }
    }

    decorValue(key) {
        const raw = this.settings.texts?.[key];
        return typeof raw === 'string' ? raw : '';
    }

    setDecorText(key, value) {
        const next = { ...(this.settings.texts || {}), [key]: value };
        this.settings.texts = next;
        saveExportSettings({ texts: next });
        this.layoutCache = null;
        clearTimeout(this.textRepaintTimer);
        this.textRepaintTimer = setTimeout(() => this.repaintAdjust(), 240);
    }

    syncColorInputs() {
        const colors = this.effectiveColors(this.settings.templateId);
        Object.keys(this.colorDots || {}).forEach(slot => {
            this.colorDots[slot].style.background = colors[slot];
        });
        if (this.$colorBadge) {
            this.$colorBadge.hidden = !this.settings.colors[this.settings.templateId];
        }
    }

    /**
     * 同一份文案 + 同一套外观只排版一次：微调预览、放大、最终预览、保存共用，
     * 既省掉重复断行，也保证保存出来的尺寸和预览完全一致。
     */
    layoutFor(data) {
        const id = this.settings.templateId;
        const appearance = this.appearanceFor(id);
        const colors = appearance.colors;
        const cache = this.layoutCache;
        if (cache
            && cache.data === data
            && cache.templateId === id
            && cache.sizeKey === appearance.sizeKey
            && cache.fontKey === appearance.fontKey
            && cache.paper === colors.paper
            && cache.ink === colors.ink
            && cache.accent === colors.accent) {
            return cache.layout;
        }
        const layout = layoutCard(id, data, appearance, { maxHeight: CARD_H_MAX });
        this.layoutCache = {
            data,
            templateId: id,
            sizeKey: appearance.sizeKey,
            fontKey: appearance.fontKey,
            paper: colors.paper,
            ink: colors.ink,
            accent: colors.accent,
            layout,
        };
        return layout;
    }

    repaintAdjust() {
        if (!this.data) return;
        requestAnimationFrame(() => {
            renderCard(
                this.$adjustPreview, 720, this.settings.templateId, this.data,
                this.appearanceFor(this.settings.templateId),
                { autoHeight: true, layout: this.layoutFor(this.data) },
            );
            this.updateTruncNote();
        });
    }

    /**
     * 正文被截断时在浮层里说明一句（不画进图片）。
     * 用户看到卡片末尾只有个「…」，至少要知道发生了什么、能怎么调。
     */
    updateTruncNote() {
        const truncated = isLastRenderTruncated();
        const text = truncated
            ? '正文过长：已到最大高度并缩到最小字号仍放不下，末尾文字被省略。可试试切换到「小」字号，或挑一段更短的文字。'
            : '';
        this.dialog.querySelectorAll('.sa-note').forEach(note => {
            note.textContent = text;
            note.hidden = !truncated;
        });
    }

    // ---- 轻点放大（手机上看小字用） ----
    openZoom() {
        if (!this.data) return;
        this.$zoom.classList.add('is-on');
        requestAnimationFrame(() => {
            renderCard(
                this.$zoomCanvas, 1320, this.settings.templateId, this.data,
                this.appearanceFor(this.settings.templateId),
                { autoHeight: true, layout: this.layoutFor(this.data) },
            );
        });
    }

    closeZoom() {
        this.$zoom.classList.remove('is-on');
    }

    // ---- 步骤切换 ----
    setStep(step) {
        this.step = step;
        this.$steps.forEach(section => {
            section.classList.toggle('is-on', section.dataset.step === step);
        });
        this.$back.hidden = step === 'template';
        this.dialog.querySelector('.sa-export-body').scrollTop = 0;

        if (step === 'template') {
            this.$title.textContent = '选择模板';
            this.$sub.textContent = `${this.data?.char || ''} · 共 ${TEMPLATES.length} 套`;
            this.$foot.innerHTML = '';
            this.paintThumbnails();
            return;
        }

        if (step === 'adjust') {
            this.$title.textContent = '微调';
            const template = TEMPLATE_BY_ID[this.settings.templateId];
            this.$sub.textContent = template ? template.name : '';
            this.$foot.innerHTML = '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sa-btn is-primary';
            btn.textContent = '生成预览';
            btn.addEventListener('click', () => this.setStep('preview'));
            this.$foot.appendChild(btn);
            this.syncAdjustSelection();
            this.repaintAdjust();
            return;
        }

        // preview
        this.$title.textContent = '预览';
        const template = TEMPLATE_BY_ID[this.settings.templateId];
        const appearance = this.appearanceFor(this.settings.templateId);
        const layout = this.layoutFor(this.data);
        this.$sub.textContent = template
            ? `${template.name} · ${CARD_W * EXPORT_PIXEL_RATIO}×${Math.round(layout.height * EXPORT_PIXEL_RATIO)} PNG`
            : '';
        this.$foot.innerHTML = `
            <button type="button" class="sa-btn" data-act="back">返回调整</button>
            <button type="button" class="sa-btn is-primary" data-act="save">保存</button>
        `;
        this.$foot.querySelector('[data-act="back"]').addEventListener('click', () => this.setStep('adjust'));
        this.$foot.querySelector('[data-act="save"]').addEventListener('click', (event) => this.handleSave(event.currentTarget));

        renderCard(this.$previewCanvas, CARD_W, this.settings.templateId, this.data, appearance, {
            autoHeight: true,
            layout,
        });
        this.updateTruncNote();
    }

    goBack() {
        if (this.step === 'preview') this.setStep('adjust');
        else if (this.step === 'adjust') this.setStep('template');
    }

    // ---- 打开 / 关闭 ----
    async open(data) {
        this.data = data;
        this.layoutCache = null;
        this.textControlsFor = '';
        this.settings = readExportSettings();
        if (this.settings.fontKey === 'kai') await ensureBundledKai();
        this.setStep('template');

        if (typeof this.dialog.showModal === 'function') {
            if (!this.dialog.open) {
                try {
                    this.dialog.showModal();
                } catch (error) {
                    console.warn('[ST-档案馆·导出] 原生弹层不可用，回退普通弹层', error);
                    this.dialog.setAttribute('open', '');
                }
            }
        } else {
            this.dialog.setAttribute('open', '');
        }
        this.repin();

        // 焦点落在面板本身，避免关闭按钮一进来就被画出焦点框
        try {
            this.dialog.querySelector('.sa-export-panel')?.focus({ preventScroll: true });
        } catch (error) {
            /* 老浏览器不支持 preventScroll */
        }
    }

    close() {
        if (typeof this.dialog.close === 'function' && this.dialog.open) {
            try {
                this.dialog.close();
                return;
            } catch (error) {
                /* 落到下面的移除逻辑 */
            }
        }
        this.dialog.removeAttribute('open');
        this.onClosed();
    }

    onClosed() {
        this.dialog.classList.remove('is-on');
        this.$zoom?.classList.remove('is-on');
        this.hideToast();
        clearTimeout(this.textRepaintTimer);
        this.data = null;
        this.layoutCache = null;
    }

    repin() {
        if (this.dialog?.open) pinToVisibleViewport(this.dialog);
    }

    // ---- toast ----
    showToast(message, type = 'info') {
        if (!this.$toast) return;
        this.$toast.textContent = message;
        this.$toast.classList.toggle('is-error', type === 'error');
        this.$toast.classList.add('is-on');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.hideToast(), TOAST_MS);
    }

    hideToast() {
        this.$toast?.classList.remove('is-on');
    }

    // ---- 保存 ----
    async makeBlob(data) {
        const canvas = document.createElement('canvas');
        const appearance = this.appearanceFor(this.settings.templateId);
        const layout = this.layoutFor(data);
        renderCard(canvas, CARD_W * EXPORT_PIXEL_RATIO, this.settings.templateId, data, appearance, {
            autoHeight: true,
            layout,
        });
        return canvasToBlob(canvas);
    }

    async handleSave(button) {
        if (this.busy) return;
        const data = this.data;
        if (!data) return;
        this.busy = true;
        button.disabled = true;
        button.textContent = '生成中…';
        try {
            // 先让「生成中…」画出来，再开始 2160 宽的同步绘制，避免点击后像卡住
            await new Promise(resolve => requestAnimationFrame(() => resolve()));
            const blob = await this.makeBlob(data);
            downloadBlob(blob, buildFileName(data));
            this.showToast('已保存为图片');
        } catch (error) {
            console.warn('[ST-档案馆·导出] 保存失败', error);
            this.showToast(`保存失败：${error?.message || '未知错误'}`, 'error');
        } finally {
            this.busy = false;
            button.disabled = false;
            button.textContent = '保存';
        }
    }

    selectTemplate(id) {
        this.settings.templateId = id;
        saveExportSettings({ templateId: id });
        this.setStep('adjust');
    }
}

let exportPanel = null;

function openExportPanel(data) {
    injectUiStyle();
    if (!exportPanel) exportPanel = new ExportPanel();
    exportPanel.open(data);
}

// ============================================================
// 十、详情弹窗注入
// ============================================================

function injectDetailButton() {
    const dialog = document.getElementById('quote-detail-overlay');
    if (!dialog) return false;
    const head = dialog.querySelector('.quote-detail-head');
    if (!head) return false;
    if (head.querySelector('.sa-detail-export')) return true;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sa-detail-export';
    button.title = '导出为卡片';
    button.setAttribute('aria-label', '导出为卡片');
    // 内联 SVG：不依赖 Font Awesome，任何主题下都能显示
    button.innerHTML = `
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
            <circle cx="8.4" cy="9.6" r="1.5" />
            <path d="M20.6 15.2l-4.4-4.1L7.2 19.6" />
        </svg>`;

    button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const quote = resolveCurrentQuote();
        if (!quote) {
            console.warn('[ST-档案馆·导出] 无法定位当前拾遗');
            return;
        }
        const data = await buildCardData(quote);
        openExportPanel(data);
    });

    const closeButton = head.querySelector('.quote-detail-close');
    head.insertBefore(button, closeButton || null);
    return true;
}

function watchDetailDialog() {
    if (injectDetailButton()) return;

    // 详情弹窗由 index.js 在启动时创建；万一还没建好，等它出现
    const observer = new MutationObserver(() => {
        if (injectDetailButton()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 20000);
}

// ============================================================
// 十一、启动
// ============================================================

function start() {
    injectUiStyle();
    watchDetailDialog();

    // 字体到位后再渲染，否则首次测量会用到 fallback 字形
    if (document.fonts?.ready) {
        document.fonts.ready.catch(() => { });
    }

    // 上次就选的楷体：页面空闲时提前把内置字体拉下来，
    // 等用户点开导出面板时已经就绪，不会卡在第一次渲染上。
    if (readExportSettings().fontKey === 'kai') {
        const warmUp = () => { ensureBundledKai(); };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(warmUp, { timeout: 4000 });
        else setTimeout(warmUp, 2500);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
    start();
}

// 调试 / 自测入口（也是 _dev 预览脚本的调用口）
globalThis.STArchiveExport = Object.freeze({
    CARD,
    CARD_W,
    CARD_H_MIN,
    CARD_H_MAX,
    TEMPLATES,
    FONT_STYLES,
    SIZE_STEPS,
    layoutCard,
    renderCard,
    resolveCurrentQuote,
    buildCardData,
    open: openExportPanel,
    ensureKai: ensureBundledKai,
});
