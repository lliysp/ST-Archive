// @ts-nocheck
// 装饰配色：必须在任何界面渲染之前执行，把 --sa-* 变量写进 :root
import './theme.js';

// ==================================================
// 共享存储层
// 数据原来只存在浏览器 localStorage 里，换设备就看不到。
// 现在改为写入 SillyTavern 服务器端 settings（extension_settings），
// 同一台服务器上登录的任何设备（电脑 / 手机）刷新后都能读到同一份数据。
// localStorage 只保留一份本地缓存，用于服务器暂时不可用时的兜底与旧数据迁移。
// ==================================================

const ARCHIVE_STATE_KEY = 'st_archive';
const ARCHIVE_CACHE_KEY = 'st_archive_cache';
const ARCHIVE_MIGRATION_KEY = 'st_archive_migrated_to_server';
const ARCHIVE_STATE_VERSION = 2;
const ARCHIVE_CACHE_LIMIT = 2 * 1024 * 1024;
const ARCHIVE_DEFAULT_RENDER_LIMIT = 50;
const ARCHIVE_RENDER_LIMIT_MIN = 1;
const ARCHIVE_RENDER_LIMIT_MAX = 1000;

// 旧版本使用的 localStorage 键名，仅用于一次性迁移
const ARCHIVE_LEGACY_KEYS = {
    quotes: 'st_quotes',
    pinnedChars: 'archive_pinned',
    pinnedChats: 'archive_pinned_chats',
    fabPos: 'quote_fab_pos',
};

function getArchiveContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch (error) {
        console.warn('[ST-档案馆] 获取 SillyTavern 上下文失败', error);
        return null;
    }
}

function createArchiveState() {
    return {
        version: ARCHIVE_STATE_VERSION,
        revision: 0,
        updatedAt: 0,
        quotes: [],
        pinnedChars: [],
        pinnedChats: {},
        renderLimit: ARCHIVE_DEFAULT_RENDER_LIMIT,
    };
}

function clampArchiveRenderLimit(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return ARCHIVE_DEFAULT_RENDER_LIMIT;
    return Math.min(ARCHIVE_RENDER_LIMIT_MAX, Math.max(ARCHIVE_RENDER_LIMIT_MIN, parsed));
}

function sanitizePinnedChats(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    Object.keys(value).forEach(key => {
        if (value[key] === true) result[key] = true;
    });
    return result;
}

function sanitizeArchiveState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const state = createArchiveState();
    state.version = Number(raw.version) || ARCHIVE_STATE_VERSION;
    state.revision = Number(raw.revision) || 0;
    state.updatedAt = Number(raw.updatedAt) || 0;
    state.quotes = Array.isArray(raw.quotes) ? raw.quotes : [];
    state.pinnedChars = Array.isArray(raw.pinnedChars)
        ? raw.pinnedChars.filter(item => typeof item === 'string' && item)
        : [];
    state.pinnedChats = sanitizePinnedChats(raw.pinnedChats);
    state.renderLimit = clampArchiveRenderLimit(raw.renderLimit);
    return state;
}

function readLocalStorageJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
    } catch (error) {
        console.warn(`[ST-档案馆] 读取本地存储 ${key} 失败`, error);
        return fallback;
    }
}

function writeLocalStorageJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        console.warn(`[ST-档案馆] 写入本地存储 ${key} 失败`, error);
        return false;
    }
}

function archiveQuoteKey(quote) {
    if (!quote || typeof quote !== 'object') return '';
    const mesid = String(quote.mesid ?? '').trim();
    const char = String(quote.char ?? '').trim();
    const chatKey = String(quote.chatKey ?? '').trim();
    // 划词收藏允许在同一楼层里保存多段不同文字，正文必须参与去重键，否则会被当成重复项丢掉
    const textPart = quote.source === 'selection' ? `::${String(quote.text ?? '').slice(0, 160)}` : '';
    if (chatKey) return `chat::${chatKey}::${mesid}::${char}${textPart}`;
    return `legacy::${char}::${mesid}::${String(quote.text ?? '').slice(0, 160)}`;
}

/**
 * 把一个 fixed 弹层钉在“当前真正看得见的视口”里。
 * 手机本地部署 / 内置浏览器 / 软键盘弹出时，100vh、inset:0 可能按更大的布局视口计算，
 * 会导致弹层比屏幕还高、上半部分被顶到屏幕外。
 */
function pinLayerToVisibleViewport(element) {
    if (!element) return;

    const viewport = window.visualViewport;
    const width = Math.round((viewport ? viewport.width : window.innerWidth) || 0);
    let height = Math.round((viewport ? viewport.height : window.innerHeight) || 0);
    if (width <= 0 || height <= 0) return;

    // 没有 VisualViewport 的旧内核：innerHeight 可能被报成超大的布局视口，用屏幕高度兜底
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

function readLegacyLocalState() {
    const state = createArchiveState();

    const quotes = readLocalStorageJson(ARCHIVE_LEGACY_KEYS.quotes, null);
    if (Array.isArray(quotes)) state.quotes = quotes;

    const pinnedChars = readLocalStorageJson(ARCHIVE_LEGACY_KEYS.pinnedChars, null);
    if (Array.isArray(pinnedChars)) {
        state.pinnedChars = pinnedChars.filter(item => typeof item === 'string' && item);
    }

    state.pinnedChats = sanitizePinnedChats(readLocalStorageJson(ARCHIVE_LEGACY_KEYS.pinnedChats, null));
    return state;
}

function hasArchiveData(state) {
    return Boolean(state) && (
        state.quotes.length > 0
        || state.pinnedChars.length > 0
        || Object.keys(state.pinnedChats).length > 0
    );
}

let archiveState = null;

function attachArchiveStateToSettings() {
    const ctx = getArchiveContext();
    if (!ctx?.extensionSettings) return false;
    ctx.extensionSettings[ARCHIVE_STATE_KEY] = archiveState;
    return true;
}

/**
 * 保存共享数据：写入服务器端 settings，同时镜像一份到 localStorage 兜底。
 * @param {{ bump?: boolean, save?: boolean }} options
 * @returns {boolean} 本地缓存是否写入成功
 */
function persistArchiveState(options = {}) {
    const { bump = true, save = true } = options;
    const state = getArchiveState();

    if (bump) {
        // revision 只在本机发生真实修改时自增，用来判断“本地缓存是否比服务器数据更新”，
        // 不依赖各设备可能不一致的系统时钟。
        state.revision = (Number(state.revision) || 0) + 1;
        state.updatedAt = Date.now();
    }
    state.version = ARCHIVE_STATE_VERSION;

    const ctx = getArchiveContext();
    if (ctx?.extensionSettings) {
        ctx.extensionSettings[ARCHIVE_STATE_KEY] = state;
        if (save && typeof ctx.saveSettingsDebounced === 'function') {
            try {
                ctx.saveSettingsDebounced();
            } catch (error) {
                console.warn('[ST-档案馆] 请求保存服务器设置失败', error);
            }
        }
    }

    let cached = false;
    try {
        const serialized = JSON.stringify(state);
        if (serialized.length <= ARCHIVE_CACHE_LIMIT) {
            localStorage.setItem(ARCHIVE_CACHE_KEY, serialized);
            cached = true;
        } else {
            localStorage.removeItem(ARCHIVE_CACHE_KEY);
        }
    } catch (error) {
        console.warn('[ST-档案馆] 写入本地缓存失败', error);
    }
    return cached;
}

function clearLegacyLocalState() {
    try {
        localStorage.removeItem(ARCHIVE_LEGACY_KEYS.quotes);
        localStorage.removeItem(ARCHIVE_LEGACY_KEYS.pinnedChars);
        localStorage.removeItem(ARCHIVE_LEGACY_KEYS.pinnedChats);
    } catch (error) {
        console.warn('[ST-档案馆] 清理旧版本地数据失败', error);
    }
}

/**
 * 升级后的第一次加载：把本机旧版 localStorage 数据并入服务器数据。
 * 手机和电脑各自可能还有未同步的收藏，只合并一次，避免误删。
 */
function mergeLegacyLocalStateOnce(state) {
    let alreadyMerged = false;
    try {
        alreadyMerged = localStorage.getItem(ARCHIVE_MIGRATION_KEY) === '1';
    } catch (error) {
        alreadyMerged = false;
    }
    if (alreadyMerged) return;

    const local = readLegacyLocalState();
    let changed = false;

    if (hasArchiveData(local)) {
        const known = new Set(state.quotes.map(archiveQuoteKey));
        local.quotes.forEach(quote => {
            if (!quote || typeof quote !== 'object') return;
            const mesid = String(quote.mesid ?? '').trim();
            if (!/^\d+$/.test(mesid)) return;
            const key = archiveQuoteKey(quote);
            if (!key || known.has(key)) return;
            known.add(key);
            state.quotes.push(quote);
            changed = true;
        });

        local.pinnedChars.forEach(key => {
            if (!state.pinnedChars.includes(key)) {
                state.pinnedChars.push(key);
                changed = true;
            }
        });

        Object.keys(local.pinnedChats).forEach(key => {
            if (state.pinnedChats[key] !== true) {
                state.pinnedChats[key] = true;
                changed = true;
            }
        });
    }

    try {
        localStorage.setItem(ARCHIVE_MIGRATION_KEY, '1');
    } catch (error) {
        console.warn('[ST-档案馆] 记录迁移状态失败', error);
    }

    if (!changed) return;

    attachArchiveStateToSettings();
    const cached = persistArchiveState({ bump: true, save: true });
    if (cached) clearLegacyLocalState();
}

function getArchiveState() {
    if (archiveState) return archiveState;

    const ctx = getArchiveContext();
    const fromSettings = sanitizeArchiveState(ctx?.extensionSettings?.[ARCHIVE_STATE_KEY]);
    const fromCache = sanitizeArchiveState(readLocalStorageJson(ARCHIVE_CACHE_KEY, null));

    if (fromSettings) {
        // 本地缓存的 revision 更大：说明上次修改还没来得及写入服务器（例如保存前就关了页面），
        // 这时以本地缓存为准，并重新请求保存，避免丢收藏。
        if (fromCache && fromCache.revision > fromSettings.revision) {
            archiveState = fromCache;
            attachArchiveStateToSettings();
            persistArchiveState({ bump: false, save: true });
            return archiveState;
        }

        archiveState = fromSettings;
        mergeLegacyLocalStateOnce(archiveState);
        return archiveState;
    }

    archiveState = fromCache || readLegacyLocalState();

    // 迁移到服务器端，之后其它设备就能读到
    attachArchiveStateToSettings();
    const cached = persistArchiveState({ bump: true, save: true });
    if (cached) clearLegacyLocalState();
    return archiveState;
}

function getArchiveRenderLimit() {
    return clampArchiveRenderLimit(getArchiveState().renderLimit);
}

function setArchiveRenderLimit(value) {
    const nextLimit = clampArchiveRenderLimit(value);
    const state = getArchiveState();

    if (state.renderLimit === nextLimit) return nextLimit;

    state.renderLimit = nextLimit;
    persistArchiveState();
    return nextLimit;
}

// 🚨 防闪屏的第一道闸：扩展 CSS 由酒馆在 initExtensions 阶段注入，
// 正常情况下早于欢迎面板首次渲染；这里再同步写一份最小样式到 <head>，
// 保证即使样式表加载被推迟，原生首页也来不及露脸。
(function injectArchiveEarlyStyle() {
    if (document.getElementById('st-archive-early-style')) return;

    const style = document.createElement('style');
    style.id = 'st-archive-early-style';
    style.textContent = [
        '#chat .welcomePanel .recentChatList{display:none !important;}',
        '.mes_text .quote-underline{text-decoration-line:underline !important;',
        'text-decoration-color:rgba(var(--sa-accent-rgb, 164, 80, 80),0.75) !important;',
        'text-decoration-thickness:1.5px !important;text-underline-offset:3px !important;}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
})();

(function () {
    console.log("✨ [ST-档案馆] v1.8.0 配色版已启动！");

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        })[char]);
    }

    let archiveLimitOverlay = null;
    let archiveLimitInput = null;
    let archiveLimitReturnFocus = null;

    // 首页档案馆的界面状态：重命名存档、修改渲染上限等都会导致欢迎面板整块重绘，
    // 这里把页码 / 搜索词 / 排序 / 展开的角色组 / 滚动位置记在模块里，重建后原样恢复。
    const archiveUiState = {
        page: 1,
        search: '',
        sort: 'time-desc',
        openGroups: new Set(),
        pinnedCharKeys: new Set(),
        pinnedCharNames: new Set(),
        scrollTop: 0,
    };

    function applyArchiveLimitViewportBounds() {
        pinLayerToVisibleViewport(archiveLimitOverlay);
    }

    function refreshArchiveLimitBounds() {
        if (archiveLimitOverlay && archiveLimitOverlay.classList.contains('show')) {
            applyArchiveLimitViewportBounds();
        }
    }

    function getArchiveLimitDialog() {
        if (archiveLimitOverlay) return archiveLimitOverlay;

        const overlay = document.createElement('div');
        overlay.id = 'archive-limit-overlay';
        overlay.innerHTML = `
            <div class="archive-limit-panel" role="dialog" aria-modal="true" aria-labelledby="archive-limit-title">
                <div class="archive-limit-title" id="archive-limit-title">请输入存档渲染上限</div>
                <input type="number" class="archive-limit-input" min="${ARCHIVE_RENDER_LIMIT_MIN}" max="${ARCHIVE_RENDER_LIMIT_MAX}" step="1" inputmode="numeric" aria-label="存档渲染上限">
                <button type="button" class="archive-limit-confirm">确认</button>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('.archive-limit-input');
        const confirmBtn = overlay.querySelector('.archive-limit-confirm');

        function close(restoreFocus = true) {
            overlay.classList.remove('show');
            if (restoreFocus && archiveLimitReturnFocus?.isConnected) {
                archiveLimitReturnFocus.focus({ preventScroll: true });
            }
        }

        function confirm() {
            const nextLimit = clampArchiveRenderLimit(input.value);
            const changed = nextLimit !== getArchiveRenderLimit();

            if (changed) setArchiveRenderLimit(nextLimit);
            close(!changed);

            if (!changed) return;

            refreshArchiveAfterLimitChange();
            requestAnimationFrame(() => {
                document.querySelector('.archive-limit')?.focus({ preventScroll: true });
            });
        }

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        confirmBtn.addEventListener('click', confirm);
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            confirm();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !overlay.classList.contains('show')) return;
            event.preventDefault();
            close();
        });

        archiveLimitOverlay = overlay;
        archiveLimitInput = input;
        return overlay;
    }

    function openArchiveLimitDialog() {
        const overlay = getArchiveLimitDialog();
        archiveLimitReturnFocus = document.activeElement;
        archiveLimitInput.value = String(getArchiveRenderLimit());
        overlay.classList.add('show');
        applyArchiveLimitViewportBounds();

        requestAnimationFrame(() => {
            archiveLimitInput.focus();
            archiveLimitInput.select();
            // 软键盘弹出后可见视口会变矮，再钉一次，避免弹窗上半部分被顶出屏幕
            applyArchiveLimitViewportBounds();
        });
    }

    function refreshArchiveAfterLimitChange() {
        document.querySelector('.my-folded-wrapper')?.remove();

        const nativeList = document.querySelector('.recentChatList');
        if (nativeList) nativeList.style.display = 'none';

        renderArchiveList();
    }

    // 手机软键盘弹出、地址栏伸缩、横竖屏切换时，保持 limit 弹窗留在可见视口内
    window.addEventListener('resize', refreshArchiveLimitBounds);
    window.addEventListener('orientationchange', refreshArchiveLimitBounds);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
        window.visualViewport.addEventListener('resize', refreshArchiveLimitBounds);
        window.visualViewport.addEventListener('scroll', refreshArchiveLimitBounds);
    }

    function collectCharacterTags() {
        const tagsByChar = {};
        document.querySelectorAll('.character_select').forEach(card => {
            const nameEl = card.querySelector('.ch_name');
            if (!nameEl) return;
            const name = nameEl.textContent.trim();
            if (!name) return;

            const tags = [];
            card.querySelectorAll('.tags .tag').forEach(tag => {
                const tagName = tag.textContent.replace('✕', '').trim();
                if (tagName) tags.push(tagName);
            });

            if (tags.length > 0) tagsByChar[name] = tags;
        });
        return tagsByChar;
    }

    function getGroupInfo(item) {
        const avatar = item.getAttribute('data-avatar') || '';
        const groupId = item.getAttribute('data-group') || '';
        const nameEl = item.querySelector('.chatName .characterName');
        const avatarImg = item.querySelector('.avatar img');
        const fallbackName = avatar.replace(/\.png$/i, '').replace(/^default_/i, '');
        const name = (nameEl?.textContent || avatarImg?.alt || fallbackName || '未知角色').trim();
        const key = groupId ? `group:${groupId}` : (avatar ? `char:${avatar}` : `name:${name}`);

        return { name, key };
    }

    // 重命名存档会让酒馆重绘欢迎面板，滚动位置也会被重置；只记录“档案馆存在时”的滚动位置，
    // 重建后恢复。切到聊天页时档案馆已被移除，不会把聊天页的滚动位置误记进来。
    document.addEventListener('scroll', (event) => {
        const target = event.target;
        if (!(target instanceof Element) || target.id !== 'chat') return;
        // 只读一个缓存布尔值：滚动时不再每个事件都查一次 DOM
        if (!archiveView.wrapper?.isConnected) return;
        archiveUiState.scrollTop = target.scrollTop;
    }, { capture: true, passive: true });

    function restoreArchiveScrollPosition() {
        const target = archiveUiState.scrollTop;
        if (!(target > 0)) return;

        const chat = document.getElementById('chat');
        if (!chat) return;

        chat.scrollTop = target;
        requestAnimationFrame(() => {
            if (Math.abs(chat.scrollTop - target) > 4) chat.scrollTop = target;
        });
    }

    // ==================================================
    // 首页档案馆：数据驱动 + 分页 + 分组懒渲染
    // --------------------------------------------------
    // 旧实现每次翻页 / 搜索 / 排序，都会把所有角色组重新排序、重新挂到 DOM 上；
    // 每个角色组里的聊天行，不管这一页看不看，也会一次性全部建出来。
    // 现在：原生列表只读一次变成纯数据 → DOM 只建“当前页”的 10 个组；
    // 组里的聊天行等展开时再按 80 条一批补。存 500 条还是 5000 条，首屏都只处理 10 个组。
    // ==================================================

    const ARCHIVE_PAGE_SIZE = 10;
    const ARCHIVE_ROWS_PER_CHUNK = 80;

    const archiveView = {
        wrapper: null,
        nativeList: null,
        listContainer: null,
        searchInput: null,
        sortSelect: null,
        pageInfo: null,
        prevBtn: null,
        nextBtn: null,
        pagination: null,
        groups: [],
        groupByKey: new Map(),
        chatsByOrder: new Map(),
        observers: [],
    };

    function computeNativeSignature(nativeList) {
        if (!nativeList) return '';
        const first = nativeList.firstElementChild?.getAttribute('data-file') || '';
        const last = nativeList.lastElementChild?.getAttribute('data-file') || '';
        return `${nativeList.childElementCount}|${first}|${last}|${getArchiveRenderLimit()}`;
    }

    // 原生列表的节点只在这一步读一次：把 DOM 信息拍平成纯数据。
    // 之后翻页、搜索、排序都只动数据，不再反复读 DOM / 挪 DOM。
    function collectArchiveGroups(nativeList) {
        const renderLimit = getArchiveRenderLimit();
        const items = Array.from(nativeList.querySelectorAll('.recentChat')).slice(0, renderLimit);
        const domTags = collectCharacterTags();
        const pinnedChats = getArchiveState().pinnedChats;
        const groups = new Map();
        const groupByKey = new Map();
        const chatsByOrder = new Map();

        items.forEach((item, order) => {
            const { name, key } = getGroupInfo(item);
            const dateEl = item.querySelector('.chatDate');
            const dateStr = dateEl ? dateEl.textContent.trim() : '';
            const chatNameEl = item.querySelector('.chatName');
            const chatTitle = chatNameEl ? chatNameEl.textContent.trim() : '未命名存档';
            const avatarImg = item.querySelector('.avatar img');
            const avatarSrc = avatarImg ? avatarImg.src : '';
            const statsEl = item.querySelector('.chatStats');
            const statsHtml = statsEl ? statsEl.outerHTML : '';
            const renameNode = item.querySelector('.renameChat');
            const deleteNode = item.querySelector('.deleteChat');
            const fileKey = item.getAttribute('data-file') || chatTitle || `chat-${order}`;
            const pinKey = `${key}::${fileKey}`;
            const isPinned = pinnedChats[pinKey] === true || pinnedChats[fileKey] === true;

            let group = groups.get(key);
            if (!group) {
                group = {
                    key,
                    name,
                    tags: domTags[name] || [],
                    chats: [],
                    order,
                };
                groups.set(key, group);
                groupByKey.set(key, group);
            }

            const chat = {
                pinKey,
                fileKey,
                title: chatTitle,
                date: dateStr,
                avatar: avatarSrc,
                statsHtml,
                renameNode,
                deleteNode,
                originalNode: item,
                isPinned,
                order,
            };

            group.chats.push(chat);
            chatsByOrder.set(order, chat);
        });

        // 置顶行永远排在组内最前，其余保持原生时间顺序
        groups.forEach(group => group.chats.sort(compareArchiveChats));

        // 清理已经不存在的角色组展开状态（角色被删、或数据刷新后消失）
        [...archiveUiState.openGroups].forEach(key => {
            if (!groups.has(key)) archiveUiState.openGroups.delete(key);
        });

        return { groups: [...groups.values()], groupByKey, chatsByOrder };
    }

    function compareArchiveChats(a, b) {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return a.order - b.order;
    }

    function buildArchiveHeaderHtml(group) {
        const isPinnedChar = archiveUiState.pinnedCharKeys.has(group.key)
            || archiveUiState.pinnedCharNames.has(group.name);
        const tagsHtml = group.tags
            .map(tag => `<span class="my-tag">${escapeHtml(tag)}</span>`)
            .join('');

        return `
            <div class="my-fold-header">
                <div class="my-fold-header-left">
                    <div class="my-name-row">
                        <span class="icon">❖</span>
                        <span class="my-header-name">${escapeHtml(group.name)}</span>
                    </div>
                    <div class="my-header-tags">${tagsHtml}</div>
                </div>
                <div class="my-fold-header-right">
                    <span class="archive-count">${group.chats.length} 个存档</span>
                    <i class="fa-solid fa-star my-pin-btn ${isPinnedChar ? 'pinned' : ''}" title="置顶角色"></i>
                </div>
            </div>
        `;
    }

    function buildArchiveChatRowHtml(chat) {
        return `
            <div class="recentChat archive-chat-row ${chat.isPinned ? 'is-pinned-row' : ''}"
                 data-order="${chat.order}" data-pinned="${chat.isPinned ? 'true' : 'false'}">
                <img class="archive-avatar" src="${escapeHtml(chat.avatar)}" alt="" width="40" height="40" loading="lazy" decoding="async">
                <div class="archive-chat-main">
                    <div class="archive-chat-top">
                        <span class="archive-chat-title">${escapeHtml(chat.title)}</span>
                        <div class="archive-chat-actions">
                            <i class="fa-solid fa-thumbtack chat-pin-btn ${chat.isPinned ? 'pinned' : ''}" data-action="pin" title="置顶"></i>
                            <i class="fa-solid fa-pen-to-square" data-action="rename" title="编辑"></i>
                            <i class="fa-solid fa-trash" data-action="delete" title="删除"></i>
                        </div>
                    </div>
                    <div class="archive-chat-bottom">
                        <span class="archive-chat-date">${escapeHtml(chat.date)}</span>
                        <div class="archive-chat-stats">${chat.statsHtml}</div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * 只在元素快被滚动到时才继续放下一批。
     * 这就是“往下滑也不卡”的关键：浏览器不需要为屏幕外的东西提前排版。
     */
    function observeArchiveReveal(element, callback) {
        let revealed = false;
        let observer = null;

        const reveal = () => {
            if (revealed) return;
            revealed = true;
            if (observer) {
                try { observer.disconnect(); } catch (error) { /* 忽略 */ }
                archiveView.observers = archiveView.observers.filter(item => item !== observer);
            }
            element.remove();
            callback();
        };

        // 除了自动加载，也给用户一个“点一下也能加载”的兜底
        element.addEventListener('click', reveal);

        if (typeof IntersectionObserver !== 'function') {
            reveal();
            return;
        }

        const root = document.getElementById('chat');
        observer = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) return;
            reveal();
        }, { root: root || null, rootMargin: '700px 0px' });

        observer.observe(element);
        archiveView.observers.push(observer);
    }

    function disconnectArchiveObservers() {
        archiveView.observers.forEach(observer => {
            try { observer.disconnect(); } catch (error) { /* 忽略 */ }
        });
        archiveView.observers = [];
    }

    function appendArchiveChatRows(container, group, start) {
        const end = Math.min(group.chats.length, start + ARCHIVE_ROWS_PER_CHUNK);
        if (end <= start) return;

        const holder = document.createElement('div');
        holder.innerHTML = group.chats.slice(start, end).map(buildArchiveChatRowHtml).join('');

        const fragment = document.createDocumentFragment();
        while (holder.firstChild) fragment.appendChild(holder.firstChild);
        container.appendChild(fragment);

        if (end < group.chats.length) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'archive-load-more';
            more.textContent = '载入更多 ···';
            container.appendChild(more);
            observeArchiveReveal(more, () => appendArchiveChatRows(container, group, end));
        }
    }

    function createArchiveGroupElement(group) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'my-fold-group';
        if (archiveUiState.openGroups.has(group.key)) groupDiv.classList.add('is-open');
        groupDiv.dataset.key = group.key;
        groupDiv.dataset.name = group.name.toLowerCase();
        groupDiv.dataset.tags = group.tags.join(',').toLowerCase();
        groupDiv.dataset.order = String(group.order);
        groupDiv.innerHTML = buildArchiveHeaderHtml(group);

        const content = document.createElement('div');
        content.className = 'my-fold-content';
        const inner = document.createElement('div');
        inner.className = 'my-fold-content-inner';
        content.appendChild(inner);
        groupDiv.appendChild(content);

        // 默认收起的组不建任何聊天行；展开时才建第一批。
        if (groupDiv.classList.contains('is-open')) {
            inner.dataset.built = '1';
            appendArchiveChatRows(inner, group, 0);
        }

        return groupDiv;
    }

    function renderArchivePage() {
        const container = archiveView.listContainer;
        if (!container) return;

        disconnectArchiveObservers();
        container.replaceChildren();

        const keyword = String(archiveUiState.search || '').toLowerCase().trim();
        const sortBy = archiveUiState.sort || 'time-desc';

        const filtered = archiveView.groups.filter(group => {
            if (!keyword) return true;
            if (group.name.toLowerCase().includes(keyword)) return true;
            return group.tags.some(tag => String(tag).toLowerCase().includes(keyword));
        });

        filtered.sort((a, b) => {
            const pinnedA = archiveUiState.pinnedCharKeys.has(a.key) || archiveUiState.pinnedCharNames.has(a.name) ? 1 : 0;
            const pinnedB = archiveUiState.pinnedCharKeys.has(b.key) || archiveUiState.pinnedCharNames.has(b.name) ? 1 : 0;
            if (pinnedA !== pinnedB) return pinnedB - pinnedA;

            if (sortBy === 'time-asc') return b.order - a.order;
            if (sortBy === 'name-asc') return a.name.localeCompare(b.name);
            if (sortBy === 'name-desc') return b.name.localeCompare(a.name);
            return a.order - b.order; // time-desc
        });

        const totalPages = Math.max(1, Math.ceil(filtered.length / ARCHIVE_PAGE_SIZE));
        const page = Math.min(Math.max(1, Number(archiveUiState.page) || 1), totalPages);
        archiveUiState.page = page;

        const startIndex = (page - 1) * ARCHIVE_PAGE_SIZE;
        const pageGroups = filtered.slice(startIndex, startIndex + ARCHIVE_PAGE_SIZE);

        const fragment = document.createDocumentFragment();
        pageGroups.forEach(group => fragment.appendChild(createArchiveGroupElement(group)));
        container.appendChild(fragment);

        if (archiveView.pageInfo) archiveView.pageInfo.innerText = `${page} / ${totalPages}`;
        if (archiveView.pagination) archiveView.pagination.style.display = 'flex';

        if (archiveView.prevBtn && archiveView.nextBtn) {
            const singlePage = totalPages <= 1;
            archiveView.prevBtn.style.visibility = singlePage ? 'hidden' : 'visible';
            archiveView.nextBtn.style.visibility = singlePage ? 'hidden' : 'visible';
            archiveView.prevBtn.disabled = page === 1;
            archiveView.nextBtn.disabled = page === totalPages;
        }

        // 记住当前界面状态，供下一次重建恢复
        archiveUiState.page = page;
    }

    function refreshPinnedCharSets() {
        const pinned = getArchiveState().pinnedChars;
        archiveUiState.pinnedCharKeys = new Set(pinned);
        archiveUiState.pinnedCharNames = new Set(pinned);
    }

    function toggleArchiveCharPin(group) {
        const state = getArchiveState();
        const currentlyPinned = state.pinnedChars.includes(group.key)
            || state.pinnedChars.includes(group.name);

        if (currentlyPinned) {
            state.pinnedChars = state.pinnedChars.filter(item => item !== group.key && item !== group.name);
        } else {
            state.pinnedChars = [...state.pinnedChars, group.key];
        }

        persistArchiveState();
        refreshPinnedCharSets();
        // 置顶会让排序变化，回到第一页才能立刻看到刚置顶的角色（和旧版一致）
        archiveUiState.page = 1;
        renderArchivePage();
    }

    function toggleArchiveChatPin(chat, group) {
        const pins = getArchiveState().pinnedChats;
        const currentlyPinned = pins[chat.pinKey] === true || pins[chat.fileKey] === true;

        if (currentlyPinned) {
            delete pins[chat.pinKey];
            delete pins[chat.fileKey];
        } else {
            pins[chat.pinKey] = true;
            delete pins[chat.fileKey];
        }

        chat.isPinned = !currentlyPinned;
        if (group) group.chats.sort(compareArchiveChats);

        persistArchiveState();
        renderArchivePage();
    }

    function handleArchiveListClick(event) {
        const pinChar = event.target.closest('.my-pin-btn');
        if (pinChar) {
            event.preventDefault();
            event.stopPropagation();
            const groupEl = pinChar.closest('.my-fold-group');
            const group = archiveView.groupByKey.get(groupEl?.dataset.key);
            if (group) toggleArchiveCharPin(group);
            return;
        }

        const header = event.target.closest('.my-fold-header');
        if (header) {
            event.preventDefault();
            event.stopPropagation();
            const groupEl = header.closest('.my-fold-group');
            const key = groupEl?.dataset.key;
            if (!groupEl || !key) return;

            const isOpen = groupEl.classList.toggle('is-open');
            if (isOpen) {
                archiveUiState.openGroups.add(key);
                const inner = groupEl.querySelector('.my-fold-content-inner');
                if (inner && !inner.dataset.built) {
                    const group = archiveView.groupByKey.get(key);
                    inner.dataset.built = '1';
                    if (group) appendArchiveChatRows(inner, group, 0);
                }
            } else {
                archiveUiState.openGroups.delete(key);
            }
            return;
        }

        const row = event.target.closest('.archive-chat-row');
        if (!row) return;

        const order = Number(row.dataset.order);
        const chat = archiveView.chatsByOrder.get(order);
        if (!chat) return;

        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'pin') {
            event.preventDefault();
            event.stopPropagation();
            const group = archiveView.groupByKey.get(row.closest('.my-fold-group')?.dataset.key);
            toggleArchiveChatPin(chat, group);
            return;
        }
        if (action === 'rename') {
            event.preventDefault();
            event.stopPropagation();
            chat.renameNode?.click();
            return;
        }
        if (action === 'delete') {
            event.preventDefault();
            event.stopPropagation();
            chat.deleteNode?.click();
            return;
        }

        chat.originalNode?.click();
    }

    function createArchiveSkeleton() {
        const wrapper = document.createElement('div');
        wrapper.className = 'my-folded-wrapper';
        wrapper.style.padding = '0 12px';

        const toolbar = document.createElement('div');
        toolbar.className = 'archive-toolbar';
        toolbar.innerHTML = `
            <div class="archive-search-box">
                <input type="text" class="archive-search-input" placeholder="Search archive...">
                <button class="archive-search-btn" title="Search"><i class="fa-solid fa-magnifying-glass"></i></button>
                <button class="archive-reset-btn" title="Reset"><i class="fa-solid fa-rotate-left"></i></button>
            </div>
            <div class="archive-sort-box">
                <select class="archive-sort-select">
                    <option value="time-desc">Recent ↓</option>
                    <option value="time-asc">Oldest ↑</option>
                    <option value="name-asc">Name A-Z</option>
                    <option value="name-desc">Name Z-A</option>
                </select>
            </div>
        `;
        wrapper.appendChild(toolbar);

        const limitButton = document.createElement('button');
        limitButton.type = 'button';
        limitButton.className = 'archive-limit';
        limitButton.title = '点击修改存档渲染上限';
        limitButton.textContent = `Archive Limit: ${getArchiveRenderLimit()}`;
        limitButton.addEventListener('click', openArchiveLimitDialog);
        wrapper.appendChild(limitButton);

        const listContainer = document.createElement('div');
        wrapper.appendChild(listContainer);

        const pagination = document.createElement('div');
        pagination.className = 'archive-pagination';
        pagination.innerHTML = `
            <button class="page-btn page-prev">PREV</button>
            <span class="page-info">1 / 1</span>
            <button class="page-btn page-next">NEXT</button>
        `;
        wrapper.appendChild(pagination);

        const searchInput = wrapper.querySelector('.archive-search-input');
        const searchBtn = wrapper.querySelector('.archive-search-btn');
        const resetBtn = wrapper.querySelector('.archive-reset-btn');
        const sortSelect = wrapper.querySelector('.archive-sort-select');
        const prevBtn = wrapper.querySelector('.page-prev');
        const nextBtn = wrapper.querySelector('.page-next');
        const pageInfo = wrapper.querySelector('.page-info');

        searchInput.value = archiveUiState.search || '';
        if (archiveUiState.sort
            && Array.from(sortSelect.options).some(option => option.value === archiveUiState.sort)) {
            sortSelect.value = archiveUiState.sort;
        }

        let searchTimer = 0;
        const applySearchNow = (resetPage) => {
            archiveUiState.search = searchInput.value;
            if (resetPage) archiveUiState.page = 1;
            renderArchivePage();
        };

        searchInput.addEventListener('input', () => {
            // 输入框自己保持稳定（只重绘下面列表），再加 140ms 防抖：连打十个字也只排一次版。
            clearTimeout(searchTimer);
            archiveUiState.search = searchInput.value;
            searchTimer = setTimeout(() => applySearchNow(true), 140);
        });
        searchInput.addEventListener('keyup', (event) => {
            if (event.key !== 'Enter') return;
            clearTimeout(searchTimer);
            applySearchNow(true);
        });
        searchBtn.addEventListener('click', () => applySearchNow(true));
        resetBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearTimeout(searchTimer);
            applySearchNow(true);
        });
        sortSelect.addEventListener('change', () => {
            archiveUiState.sort = sortSelect.value;
            archiveUiState.page = 1;
            renderArchivePage();
        });
        prevBtn.addEventListener('click', () => {
            if (archiveUiState.page <= 1) return;
            archiveUiState.page -= 1;
            renderArchivePage();
        });
        nextBtn.addEventListener('click', () => {
            archiveUiState.page += 1;
            renderArchivePage();
        });

        // 整页只挂一个点击监听：哪怕一页有几百行，也不会产生几百个监听器。
        listContainer.addEventListener('click', handleArchiveListClick);

        archiveView.wrapper = wrapper;
        archiveView.nativeList = null;
        archiveView.listContainer = listContainer;
        archiveView.searchInput = searchInput;
        archiveView.sortSelect = sortSelect;
        archiveView.pageInfo = pageInfo;
        archiveView.prevBtn = prevBtn;
        archiveView.nextBtn = nextBtn;
        archiveView.pagination = pagination;

        return wrapper;
    }

    function buildArchive(nativeList, signature) {
        const collected = collectArchiveGroups(nativeList);
        if (!collected.groups.length) return;

        disconnectArchiveObservers();

        archiveView.groups = collected.groups;
        archiveView.groupByKey = collected.groupByKey;
        archiveView.chatsByOrder = collected.chatsByOrder;
        archiveView.nativeList = nativeList;

        refreshPinnedCharSets();

        archiveView.wrapper?.remove();
        const wrapper = createArchiveSkeleton();
        archiveView.nativeList = nativeList;

        nativeList.insertAdjacentElement('afterend', wrapper);
        nativeList.style.display = 'none';
        wrapper.dataset.signature = signature;

        renderArchivePage();
        restoreArchiveScrollPosition();
    }

    function renderArchiveList() {
        const nativeList = document.querySelector('.recentChatList');
        if (!nativeList) return;

        const signature = computeNativeSignature(nativeList);
        try {
            buildArchive(nativeList, signature);
        } catch (error) {
            console.warn('[ST-档案馆] 重建首页档案馆失败', error);
        }
    }

    // 进入酒馆、关闭聊天、切换角色时，原生的欢迎面板会被整块重新渲染。
    // 用 MutationObserver 在 DOM 变化的下一帧立刻重建；轮询只做兜底，而且非常便宜：
    // 没换面板时只读几个属性（子节点数 + 首尾文件名 + limit）就直接 return。
    let archiveRenderFrame = 0;

    function runArchiveRender() {
        const nativeList = document.querySelector('.recentChatList');
        if (!nativeList) return;

        const signature = computeNativeSignature(nativeList);
        const wrapper = nativeList.parentElement?.querySelector('.my-folded-wrapper');

        if (wrapper && wrapper.isConnected && wrapper.dataset.signature === signature) {
            if (nativeList.style.display !== 'none') nativeList.style.display = 'none';
            return;
        }

        try {
            buildArchive(nativeList, signature);
        } catch (error) {
            console.warn('[ST-档案馆] 重建首页档案馆失败', error);
        }
    }

    function queueArchiveRender() {
        if (archiveRenderFrame) return;

        const frame = requestAnimationFrame(() => {
            archiveRenderFrame = 0;
            runArchiveRender();
        });
        archiveRenderFrame = frame;

        // 后台标签页、被遮挡的窗口里 rAF 可能一直不触发，
        // 那样档案馆会永远停在空白页；这里用超时兜底，直接把这一帧补上。
        setTimeout(() => {
            if (archiveRenderFrame !== frame) return;
            archiveRenderFrame = 0;
            try {
                cancelAnimationFrame(frame);
            } catch (error) {
                // 忽略：帧可能已经执行或已被浏览器丢弃
            }
            runArchiveRender();
        }, 300);
    }

    function observeChatContainer() {
        const chat = document.getElementById('chat');
        if (!chat) {
            // 极端情况下扩展比 #chat 先加载，等 DOM 就绪再挂
            document.addEventListener('DOMContentLoaded', observeChatContainer, { once: true });
            return;
        }

        // 只看 #chat 的直接子节点：欢迎面板整体换掉才会触发，
        // 档案馆自己插进 welcomePanel 内部的重绘不会反过来触发自己。
        try {
            new MutationObserver(queueArchiveRender).observe(chat, { childList: true });
        } catch (error) {
            console.warn('[ST-档案馆] 监听首页容器失败', error);
        }
        queueArchiveRender();
    }

    observeChatContainer();
    // 从别的窗口切回来时补一次，避免被遮挡期间错过重建
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) queueArchiveRender();
    });
    // 兜底轮询：从 200ms 放宽到 800ms，而且命中缓存时几乎不做事。
    setInterval(queueArchiveRender, 800);
})();


(function () {
    console.log("📚 [ST-档案馆] 拾遗模块已加载（v1.6.0）！");

    if (document.getElementById('quote-fab')) return;

    // 旧版本把 .ch_name 的整段文本存了下来，会带消息时间戳，这里做一次兼容清理
    function normalizeCharName(value) {
        let name = String(value || '').trim();
        if (!name) return '未知角色';

        const timestampPatterns = [
            /\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?$/i,
            /\s*\d{4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/,
            /\s*\d{1,2}[/.]\d{1,2}[/.]\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?$/,
        ];

        for (const pattern of timestampPatterns) {
            const cleaned = name.replace(pattern, '').trim();
            if (cleaned) name = cleaned;
        }

        return name || '未知角色';
    }

    function loadQuotes() {
        const state = getArchiveState();
        const raw = Array.isArray(state.quotes) ? state.quotes : [];

        let changed = false;
        const quotes = [];

        raw.forEach(quote => {
            if (!quote || typeof quote !== 'object') {
                changed = true;
                return;
            }

            // 旧版本可能把模板按钮的 data-mesid="" 存了进来，这种记录无法定位楼层；
            // 但「划词收藏」允许收藏消息之外的文字，这类记录本身就没有楼层号，凭正文保留。
            const mesid = String(quote.mesid ?? '').trim();
            const hasText = typeof quote.text === 'string' && quote.text.trim().length > 0;
            const isFreeQuote = mesid === '' && hasText && (quote.source === 'selection' || Boolean(quote.chatKey));
            if (!/^\d+$/.test(mesid) && !isFreeQuote) {
                changed = true;
                return;
            }
            if (String(quote.mesid ?? '') !== mesid) changed = true;

            let char = normalizeCharName(quote.char);
            if (char.includes('${')) char = '未知角色';
            if (char !== quote.char) changed = true;

            quotes.push({ ...quote, mesid, char });
        });

        if (changed) {
            state.quotes = quotes;
            persistArchiveState({ bump: false });
        }
        return quotes;
    }

    // 把当前收藏写回共享状态（服务器端 + 本地缓存）
    function saveQuotes() {
        const state = getArchiveState();
        state.quotes = savedQuotes;
        // 收藏一改动，索引与“已渲染”缓存立刻作废，下一次同步会按新数据重建。
        bumpQuotesRevision();
        persistArchiveState();
    }

    function getChatContext() {
        try {
            return globalThis.SillyTavern?.getContext?.() || null;
        } catch (error) {
            console.warn('[ST-档案馆] 获取聊天上下文失败', error);
            return null;
        }
    }

    function getCurrentChatInfo() {
        const empty = {
            active: false,
            key: '',
            scope: '',
            chatId: '',
            charName: '',
            chatName: '',
        };

        const ctx = getChatContext();
        if (!ctx) return empty;

        try {
            const hasCharacter = ctx.characterId !== undefined
                && ctx.characterId !== null
                && ctx.characterId !== ''
                && ctx.characters?.[ctx.characterId];
            const character = hasCharacter ? ctx.characters[ctx.characterId] : null;
            const group = ctx.groupId
                ? ctx.groups?.find(item => String(item.id) === String(ctx.groupId))
                : null;
            const chatId = String(ctx.getCurrentChatId?.() ?? ctx.chatId ?? '').trim();
            const scope = group
                ? `group:${group.id}`
                : (character?.avatar ? `char:${character.avatar}` : '');
            const charName = String(group?.name || character?.name || ctx.name2 || '').trim();
            const chatName = chatId.replace(/\.jsonl$/i, '').trim();

            if (!scope || !chatId) return empty;

            return {
                active: true,
                key: `${scope}::${chatId}`,
                scope,
                chatId,
                charName: charName || '未知角色',
                chatName: chatName || '未命名聊天',
            };
        } catch (error) {
            console.warn('[ST-档案馆] 解析当前聊天失败', error);
            return empty;
        }
    }

    function normalizeForCompare(value) {
        return String(value || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function compactForCompare(value) {
        try {
            return normalizeForCompare(value)
                .normalize('NFKC')
                .replace(/[\s\p{P}\p{S}]+/gu, '')
                .toLowerCase();
        } catch (error) {
            return normalizeForCompare(value).replace(/\s+/g, '').toLowerCase();
        }
    }

    function quoteMatchesCurrentChat(quote, chatInfo, ctx) {
        if (!chatInfo?.active || !ctx) return false;
        if (quote.chatKey) return quote.chatKey === chatInfo.key;

        const message = ctx.chat?.[Number(quote.mesid)];
        if (!message) return false;

        // 老数据没有 chatKey，只靠“楼层号 + 正文”认领；不再比对角色名，
        // 否则角色改名后，旧收藏会因为 message.name 变了而认不回来。
        const stored = normalizeForCompare(quote.text).replace(/(?:\.\.\.|…)$/u, '').trim();
        const actual = normalizeForCompare(message.mes);
        if (!stored || !actual) return false;

        if (stored.length < 6) return actual === stored;
        if (actual.includes(stored)) return true;

        // 老版本可能在渲染后的纯文本与原始 Markdown 之间产生差异，再做一次忽略标点/空白的比较
        const compactStored = compactForCompare(stored);
        const compactActual = compactForCompare(actual);
        if (!compactStored || !compactActual) return false;
        return compactStored.length < 6
            ? compactActual === compactStored
            : compactActual.includes(compactStored);
    }

    function quoteBelongsToChat(quote, chatInfo, ctx) {
        if (!chatInfo?.active) return false;
        if (quote.chatKey) return quote.chatKey === chatInfo.key;
        return quoteMatchesCurrentChat(quote, chatInfo, ctx);
    }

    function hydrateLegacyQuotes(chatInfo, ctx) {
        if (!chatInfo?.active) return false;

        let changed = false;
        savedQuotes.forEach(quote => {
            if (quote.chatKey) return;
            if (!quoteMatchesCurrentChat(quote, chatInfo, ctx)) return;

            quote.chatKey = chatInfo.key;
            quote.chatName = chatInfo.chatName;
            quote.chatChar = chatInfo.charName;
            quote.scope = chatInfo.scope;
            changed = true;
        });

        if (changed) saveQuotes();
        return changed;
    }

    function stripChatFileExtension(value) {
        return String(value ?? '').trim().replace(/\.jsonl$/i, '');
    }

    // chatKey 的形状固定为 `${scope}::${chatId}`，scope 内部不会出现 "::"
    function splitChatKey(chatKey) {
        const key = String(chatKey ?? '');
        const index = key.lastIndexOf('::');
        if (index < 0) return { scope: '', chatId: key };
        return { scope: key.slice(0, index), chatId: key.slice(index + 2) };
    }

    // 角色名 / 群名同样取实时值：改过角色名之后，旧收藏也不该继续显示旧名字。
    // 每个 scope 只查一次角色表；3000 条收藏来自 500 个聊天时，不会做 3000 次 find。
    let liveCharNameCache = new Map();

    function getLiveCharName(scope, fallback) {
        const key = String(scope || '');
        if (!key) return fallback;

        if (liveCharNameCache.has(key)) {
            return liveCharNameCache.get(key) || fallback;
        }

        const ctx = getChatContext();
        let resolved = '';

        try {
            if (ctx && key.startsWith('char:')) {
                const avatar = key.slice(5);
                const character = ctx.characters?.find?.(item => item?.avatar === avatar);
                if (character?.name) resolved = String(character.name).trim();
            } else if (ctx && key.startsWith('group:')) {
                const groupId = key.slice(6);
                const group = ctx.groups?.find?.(item => String(item?.id) === groupId);
                if (group?.name) resolved = String(group.name).trim();
            }
        } catch (error) {
            console.warn('[ST-档案馆] 解析角色/群实时名称失败', error);
        }

        // 查不到就先不缓存：角色列表可能还没重新加载完，下次调用再试
        if (resolved) liveCharNameCache.set(key, resolved);
        return resolved || fallback;
    }

    // 聊天记录改名后文件也会改名，所以名字的唯一可靠来源是“当前渲染出来的最近聊天列表”。
    // 这里把原生列表（即使被归档面板隐藏，节点仍在 DOM 里）解析成 chatKey -> 最新名字 的索引。
    let liveChatNameCache = { at: 0, map: new Map() };

    function invalidateLiveChatNameCache() {
        liveChatNameCache = { at: 0, map: new Map() };
        liveCharNameCache = new Map();
    }

    function getLiveChatNameIndex(force = false) {
        const now = Date.now();
        if (!force && now - liveChatNameCache.at < 1200) return liveChatNameCache.map;

        const map = new Map();
        document.querySelectorAll('.recentChatList .recentChat').forEach(item => {
            const file = stripChatFileExtension(item.getAttribute('data-file'));
            if (!file) return;

            const avatar = item.getAttribute('data-avatar') || '';
            const groupId = item.getAttribute('data-group') || '';
            const scope = groupId ? `group:${groupId}` : (avatar ? `char:${avatar}` : '');
            if (!scope) return;

            // 原生结构：<div class="chatName"><strong class="characterName">角色</strong><span>-</span><span>聊天名</span></div>
            let chatName = '';
            const chatNameEl = item.querySelector('.chatName');
            if (chatNameEl) {
                const spans = chatNameEl.querySelectorAll('span');
                const lastSpan = spans.length ? spans[spans.length - 1] : null;
                chatName = String(lastSpan?.textContent || '').trim();
                if (!chatName) chatName = stripChatFileExtension(chatNameEl.getAttribute('title'));
            }
            if (!chatName) chatName = file;

            const charName = String(
                item.querySelector('.chatName .characterName')?.textContent
                || item.querySelector('.avatar img')?.getAttribute('alt')
                || ''
            ).trim();

            map.set(`${scope}::${file}`, {
                key: `${scope}::${file}`,
                scope,
                chatId: file,
                chatName,
                charName,
            });
        });

        liveChatNameCache = { at: now, map };
        return map;
    }

    /**
     * 生成拾遗条目的来源信息。
     * 名字永远现取：当前聊天上下文 > 最近聊天列表 > 收藏时存下的旧值。
     */
    function getQuoteChatInfo(quote, options = {}) {
        const legacyChar = String(quote.chatChar || quote.char || '未知角色').trim() || '未知角色';
        const storedName = String(quote.chatName || '').trim();
        const { scope: keyScope, chatId: rawChatId } = splitChatKey(quote.chatKey);
        const scope = String(quote.scope || keyScope || '').trim();
        const chatId = stripChatFileExtension(rawChatId);

        const current = options.current || getCurrentChatInfo();

        // 1) 这条收藏属于当前打开的聊天：直接问上下文，永远是最新的名字
        if (current.active && quote.chatKey && quote.chatKey === current.key) {
            return {
                key: quote.chatKey,
                char: current.charName || getLiveCharName(scope, legacyChar) || legacyChar,
                chatName: current.chatName || storedName || chatId || '未命名聊天',
            };
        }

        // 2) 从最近聊天列表里按 scope + 文件名定位同名记录
        const liveIndex = options.liveIndex || getLiveChatNameIndex();
        const liveEntry = scope && chatId ? liveIndex.get(`${scope}::${chatId}`) : null;
        if (liveEntry) {
            return {
                key: `${scope}::${chatId}`,
                char: getLiveCharName(scope, liveEntry.charName || legacyChar) || legacyChar,
                chatName: liveEntry.chatName || storedName || chatId || '未命名聊天',
            };
        }

        // 3) 兜底：文件本身还在（只是列表里暂时没渲染），文件名就是聊天名
        return {
            key: quote.chatKey || (scope && chatId ? `${scope}::${chatId}` : `legacy:${legacyChar}`),
            char: getLiveCharName(scope, legacyChar) || legacyChar,
            chatName: storedName || chatId || (quote.chatKey ? '未命名聊天' : '历史收藏'),
        };
    }

    // 聊天改名时同步改写已存收藏的 chatKey，否则收藏会从「当前聊天」里消失
    function handleChatRenamed(eventData) {
        const data = eventData?.detail && typeof eventData.detail === 'object' ? eventData.detail : eventData;
        if (!data || typeof data !== 'object') return;

        const oldId = stripChatFileExtension(data.oldFileName);
        const newId = stripChatFileExtension(data.newFileName);
        if (!oldId || !newId || oldId === newId) return;

        const renameScope = data.groupId
            ? `group:${data.groupId}`
            : (data.avatarId ? `char:${data.avatarId}` : '');

        let changed = false;
        savedQuotes.forEach(quote => {
            if (!quote.chatKey) return;

            const { scope, chatId } = splitChatKey(quote.chatKey);
            if (stripChatFileExtension(chatId) !== oldId) return;
            if (renameScope && scope && scope !== renameScope) return;

            quote.chatKey = `${scope}::${newId}`;
            quote.chatName = newId;
            if (scope) quote.scope = scope;
            changed = true;
        });

        invalidateLiveChatNameCache();

        if (changed) {
            saveQuotes();
            renderQuotes();
            // 改名后当前聊天的 chatKey 变了，让同步引擎下一轮重新判定并重画
            runtimeChatKey = '';
            refreshAllSynced();
        }
    }

    function getQuoteScope(quote) {
        const storedScope = String(quote?.scope || '').trim();
        if (storedScope) return storedScope;
        return splitChatKey(quote?.chatKey).scope;
    }

    // 角色改名时，酒馆会把头像文件一起改名，scope 从 char:旧头像 变成 char:新头像。
    // 这里只做一层收藏遍历 + 单次字符串比较（O(1)），不会出现“角色表 × 收藏表”的双层循环。
    function handleCharacterRenamed(oldAvatar, newAvatar) {
        const oldId = String(oldAvatar || '').trim();
        const newId = String(newAvatar || '').trim();
        if (!oldId || !newId) return;

        const oldScope = `char:${oldId}`;
        const newScope = `char:${newId}`;
        let changed = false;

        if (oldScope !== newScope) {
            savedQuotes.forEach(quote => {
                const storedScope = String(quote.scope || '').trim();
                const keyParts = splitChatKey(quote.chatKey);

                // scope 或 chatKey 任意一个还是旧头像，就一起迁移
                if (storedScope !== oldScope && keyParts.scope !== oldScope) return;

                quote.scope = newScope;
                if (quote.chatKey) quote.chatKey = `${newScope}::${keyParts.chatId}`;
                changed = true;
            });
        }

        if (changed) {
            saveQuotes();
            runtimeChatKey = '';
            refreshAllSynced();
        }

        invalidateLiveChatNameCache();

        // 酒馆是“先发事件、后重新拉角色列表”，所以等一下再刷新面板，
        // 让全部聊天里的 char 显示新名字，而不是事件瞬间的旧名字。
        const refreshRenamedView = (retry) => {
            invalidateLiveChatNameCache();

            const newName = getLiveCharName(newScope, '');
            if (newName) {
                let nameChanged = false;
                savedQuotes.forEach(quote => {
                    if (String(quote.scope || '') !== newScope) return;
                    if (quote.chatChar !== newName) {
                        quote.chatChar = newName;
                        nameChanged = true;
                    }
                });
                if (nameChanged) saveQuotes();
            }

            if (overlay.classList.contains('show')) renderQuotes(true);
            if (changed) refreshAllSynced();

            // 角色列表如果还没回来，再等一次；正常情况第一次就命中
            if (!newName && retry) {
                setTimeout(() => refreshRenamedView(false), 1200);
            }
        };

        setTimeout(() => refreshRenamedView(true), 700);
    }

    // 删除角色后的孤儿收藏清理：先把要删的 scope 收进 Set，
    // 再单层遍历收藏、用 Set.has 做 O(1) 命中。禁止双层循环。
    const pendingDeletedScopes = new Set();
    let orphanCleanupScheduled = false;

    function queueOrphanScopeCleanup(scope) {
        if (!scope) return;
        pendingDeletedScopes.add(scope);

        if (orphanCleanupScheduled) return;
        orphanCleanupScheduled = true;

        setTimeout(() => {
            orphanCleanupScheduled = false;
            flushOrphanScopeCleanup();
        }, 0);
    }

    function flushOrphanScopeCleanup() {
        if (!pendingDeletedScopes.size) return;

        const deletedScopes = new Set(pendingDeletedScopes);
        pendingDeletedScopes.clear();

        const before = savedQuotes.length;
        savedQuotes = savedQuotes.filter(quote => {
            if (deletedScopes.has(getQuoteScope(quote))) return false;
            // scope 万一和 chatKey 不一致，再按 chatKey 的前缀判一次；仍是 O(1) Set 命中
            if (quote.chatKey && deletedScopes.has(splitChatKey(quote.chatKey).scope)) return false;
            return true;
        });
        if (savedQuotes.length === before) return;

        saveQuotes();
        invalidateLiveChatNameCache();

        if (overlay.classList.contains('show')) renderQuotes(true);
        refreshAllSynced();
    }

    function handleCharacterDeleted(eventData) {
        const data = eventData?.detail && typeof eventData.detail === 'object' ? eventData.detail : eventData;
        const character = data?.character || data;
        const avatar = String(character?.avatar || data?.avatar || '').trim();
        if (!avatar) return;

        queueOrphanScopeCleanup(`char:${avatar}`);
    }

    function bindChatRenameListener() {
        try {
            const ctx = getChatContext();
            const eventSource = ctx?.eventSource;
            const eventTypes = ctx?.eventTypes || ctx?.event_types;

            if (!eventSource?.on || !eventTypes) return;

            if (eventTypes.CHAT_RENAMED) {
                eventSource.on(eventTypes.CHAT_RENAMED, handleChatRenamed);
            }
            if (eventTypes.CHARACTER_RENAMED) {
                eventSource.on(eventTypes.CHARACTER_RENAMED, handleCharacterRenamed);
            }
            if (eventTypes.CHARACTER_DELETED) {
                eventSource.on(eventTypes.CHARACTER_DELETED, handleCharacterDeleted);
            }

            // 群/角色其它编辑后，拾遗里显示的实时名字也要跟着换
            [eventTypes.GROUP_UPDATED, eventTypes.CHARACTER_EDITED]
                .filter(Boolean)
                .forEach(type => eventSource.on(type, invalidateLiveChatNameCache));
        } catch (error) {
            console.warn('[ST-档案馆] 监听聊天改名事件失败', error);
        }
    }

    // 整层消息收藏（无 source）与划词/划句收藏（source === 'selection'）是两类记录：
    // 楼层书签只代表“整层已收录”，不能被划词收藏点亮，取消时也不能误删划词记录。
    function isWholeMessageQuote(quote) {
        return Boolean(quote) && quote.source !== 'selection';
    }

    // 1. 注入 CSS 样式
    const style = document.createElement('style');
    style.innerHTML = `
        #quote-fab {
            position: fixed !important; 
            width: 32px !important; 
            height: 32px !important;
            background: transparent !important; 
            color: var(--sa-accent, #a45050) !important; 
            border: 1px solid var(--sa-accent, #a45050) !important; 
            border-radius: 50% !important; 
            display: flex !important; 
            justify-content: center !important; 
            align-items: center !important;
            cursor: grab !important; 
            box-shadow: none !important; 
            z-index: 999999 !important; 
            font-size: 14px !important; 
            touch-action: none !important; 
            user-select: none !important;
            opacity: 0.6; 
            transition: opacity 0.2s, background 0.2s !important;
        }
        #quote-fab:hover, #quote-fab:active {
            opacity: 1 !important;
            background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.1) !important;
            cursor: grabbing !important;
        }

        #quote-overlay {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.3); backdrop-filter: blur(3px);
            z-index: 10000; display: none; justify-content: center; align-items: center;
            opacity: 0; transition: opacity 0.2s;
        }
        #quote-overlay.show { display: flex; opacity: 1; }

        #quote-panel {
            width: 90%; max-width: 600px; height: 70vh; max-height: 80vh;
            background: var(--sa-paper, #FDFBF7); border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.4);
            border-radius: 12px; display: flex; flex-direction: column;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2); color: var(--sa-ink, #4A4A4A);
            font-family: 'Noto Serif SC', 'Songti SC', serif; overflow: hidden;
            transform: scale(0.95); transition: transform 0.2s;
        }
        #quote-overlay.show #quote-panel { transform: scale(1); }

        .quote-header {
            padding: 14px 18px; border-bottom: 1px dashed rgba(var(--sa-accent-rgb, 164, 80, 80), 0.3);
            display: flex; justify-content: space-between; align-items: center; gap: 12px;
            background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.05);
        }
        .quote-tabs { display: flex; align-items: center; gap: 2px; min-width: 0; }
        #quote-panel .quote-tab {
            appearance: none; -webkit-appearance: none; border: 0; background: transparent;
            color: rgba(var(--sa-ink-rgb, 74, 74, 74), 0.55); padding: 6px 10px; border-radius: 6px;
            font-family: inherit; font-size: 12px; letter-spacing: 1px; cursor: pointer;
            transition: color 0.2s, background 0.2s;
        }
        #quote-panel .quote-tab:hover { color: var(--sa-accent, #a45050); background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.06); }
        #quote-panel .quote-tab.active { color: var(--sa-accent, #a45050); background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.1); font-weight: 600; }
        .quote-tab-sep { color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.28); font-size: 11px; user-select: none; }
        .quote-header-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        #quote-panel .quote-header-btn {
            appearance: none; -webkit-appearance: none;
            width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
            background: transparent; color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.72);
            display: inline-flex; align-items: center; justify-content: center;
            font-size: 13px; line-height: 1; cursor: pointer;
            box-shadow: none; transition: color 0.2s, background 0.2s;
        }
        #quote-panel .quote-header-btn:hover { color: var(--sa-accent, #a45050); background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.1); }
        #quote-panel .quote-header-btn:active { background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.16); }
        #quote-panel .quote-close {
            appearance: none; -webkit-appearance: none;
            width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
            background: transparent; color: var(--sa-accent, #a45050); font-family: Arial, sans-serif;
            font-size: 22px; line-height: 1; cursor: pointer; flex-shrink: 0;
            box-shadow: none; transition: color 0.2s, background 0.2s;
        }
        #quote-panel .quote-close:hover { color: var(--sa-accent-deep, #8b3a3a); background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.08); }

        /* 拾遗检索：搜索和排序/筛选无框、同一行，各自底部一条细线 */
        #quote-toolbar {
            flex-shrink: 0;
            display: flex; align-items: center; flex-wrap: nowrap;
            gap: 6px;
            padding: 7px 14px;
            background: transparent;
        }
        #quote-toolbar:empty { display: none; }
        #quote-toolbar .quote-search-box,
        #quote-toolbar .quote-select-box {
            min-width: 0;
            display: flex; align-items: center;
            height: 28px;
            box-sizing: border-box;
            border: 0;
            border-bottom: 0.5px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.32);
            border-radius: 0;
            background: transparent;
        }
        #quote-toolbar .quote-search-box {
            flex: 1 1 0;
            overflow: hidden;
        }
        #quote-toolbar .quote-search-box:focus-within {
            border-bottom-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.6);
        }
        #quote-toolbar .quote-search-input {
            flex: 1 1 0; min-width: 0; width: 100%; height: 100%;
            background: transparent; border: 0; outline: none;
            padding: 0 8px; font-size: 11px; letter-spacing: 0.4px;
            color: var(--SmartThemeBodyColor);
            font-family: 'Courier New', Courier, monospace;
        }
        #quote-toolbar .quote-search-input::placeholder {
            color: color-mix(in srgb, var(--SmartThemeBodyColor) 30%, transparent);
            font-style: italic;
        }
        #quote-toolbar .quote-search-btn,
        #quote-toolbar .quote-reset-btn {
            appearance: none; -webkit-appearance: none;
            border: 0;
            background: transparent; color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.7);
            height: 100%; padding: 0 7px;
            display: inline-flex; align-items: center; justify-content: center;
            font-size: 11px; cursor: pointer;
            transition: color 0.2s, background 0.2s;
        }
        #quote-toolbar .quote-search-btn:hover,
        #quote-toolbar .quote-reset-btn:hover {
            color: var(--sa-accent, #a45050); background: transparent;
        }
        #quote-toolbar .quote-select-box {
            position: relative;
            flex: 0 1 auto;
            max-width: 45%;
            overflow: hidden;
        }
        #quote-toolbar .quote-select-box:focus-within {
            border-bottom-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.6);
        }
        #quote-toolbar select {
            appearance: none; -webkit-appearance: none;
            width: 100%; height: 100%; min-width: 0;
            box-sizing: border-box;
            padding: 0 6px 0 8px;
            border: 0; border-radius: 0; outline: none;
            background: transparent !important;
            background-color: transparent !important;
            box-shadow: none;
            color: var(--SmartThemeBodyColor);
            font-family: 'Courier New', Courier, monospace;
            font-size: 11px; letter-spacing: 0.4px; cursor: pointer;
            white-space: nowrap;
            text-overflow: clip;
        }
        #quote-toolbar select:hover { color: var(--SmartThemeBodyColor); }
        #quote-toolbar .quote-select-box.is-filter {
            flex: 0 0 auto;
            width: calc(3em + 14px);
            max-width: none;
            font-size: 11px;
        }
        #quote-toolbar .quote-filter-label {
            position: absolute; left: 8px; right: 4px; top: 0; bottom: 0;
            display: flex; align-items: center;
            color: var(--SmartThemeBodyColor);
            font-family: 'Courier New', Courier, monospace;
            font-size: 11px; letter-spacing: 0.4px;
            white-space: nowrap; overflow: hidden;
            pointer-events: none;
        }
        /* 原生 select 的选中文字隐藏，收起状态由上面的 label 显示最多三个字；
           下拉弹窗里的 option 仍然是完整名字 */
        #quote-toolbar .quote-select-box.is-filter select {
            position: relative; z-index: 1;
            color: transparent !important;
            -webkit-text-fill-color: transparent !important;
        }
        #quote-toolbar .quote-select-box.is-filter select option {
            color: var(--SmartThemeBodyColor);
            -webkit-text-fill-color: var(--SmartThemeBodyColor);
            background: var(--SmartThemeBlurTintColor, var(--sa-paper, #FDFBF7));
        }
        /* 手机上不换行：整体缩小，搜索和排序/筛选仍保持同一行 */
        @media (max-width: 560px) {
            #quote-toolbar { gap: 4px; padding: 6px 10px; }
            #quote-toolbar .quote-search-box,
            #quote-toolbar .quote-select-box { height: 26px; }
            #quote-toolbar .quote-search-input { padding: 0 6px; font-size: 10px; }
            #quote-toolbar .quote-search-btn,
            #quote-toolbar .quote-reset-btn { padding: 0 5px; font-size: 10px; }
            #quote-toolbar .quote-select-box { max-width: 48%; }
            #quote-toolbar .quote-select-box.is-filter { width: calc(3em + 12px); max-width: none; font-size: 10px; }
            #quote-toolbar .quote-filter-label { left: 6px; right: 3px; font-size: 10px; }
            #quote-toolbar select { padding: 0 4px 0 6px; font-size: 10px; }
        }

        .quote-content { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }

        .quote-group {
            border-left: 2px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.35);
            padding-left: 12px;
            margin-bottom: 16px;
        }
        .quote-group:last-child { margin-bottom: 0; }
        .quote-group-header {
            display: flex; justify-content: space-between; align-items: center; gap: 12px;
            padding: 8px 4px; cursor: pointer; user-select: none;
            border-bottom: 1px dashed rgba(var(--sa-accent-rgb, 164, 80, 80), 0.25);
            transition: background 0.2s;
        }
        .quote-group-header:hover { background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.04); }
        .quote-group-title { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
        .quote-group-title .icon { color: var(--sa-accent, #a45050); font-size: 12px; display: inline-block; transition: transform 0.25s; flex-shrink: 0; }
        .quote-group.is-open .quote-group-title .icon { transform: rotate(90deg); }
        .quote-group-name {
            font-size: 14px; font-weight: 600; color: var(--sa-ink, #4A4A4A); letter-spacing: 1px;
            font-family: 'Noto Serif SC', 'Songti SC', serif;
            line-height: 1.45; overflow-wrap: anywhere;
        }
        .quote-group-meta { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .quote-group-count { font-size: 11px; color: #999; font-family: 'Courier New', Courier, monospace; }
        .quote-group-chevron { font-size: 10px; color: var(--sa-accent, #a45050); transition: transform 0.25s; }
        .quote-group.is-open .quote-group-chevron { transform: rotate(180deg); }
        .quote-group-content { display: none; flex-direction: column; gap: 10px; padding: 12px 0 2px; }
        .quote-group.is-open .quote-group-content { display: flex; }

        .quote-card {
            position: relative;
            background: #ffffff; padding: 12px 38px 12px 15px;
            border-left: 3px solid var(--sa-accent, #a45050); border-radius: 6px;
            cursor: pointer;
            /* 只过渡真正会变的属性，别用 transition: all 拖累大量卡片的绘制 */
            transition: background-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
            box-shadow: 0 2px 8px rgba(0,0,0,0.03);
        }
        .quote-card:hover { background: var(--sa-paper-deep, #faf8f5); box-shadow: 0 4px 12px rgba(0,0,0,0.06); transform: translateY(-1px); }
        .quote-card .q-text {
            font-size: 14px; color: var(--sa-ink-strong, #333); line-height: 1.6; white-space: pre-wrap;
            display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden;
            overflow-wrap: anywhere;
        }
        .quote-card .q-time { font-size: 11px; color: #999; text-align: right; margin-top: 8px; font-family: monospace; }
        #quote-panel .quote-delete {
            position: absolute; top: 7px; right: 8px;
            width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%;
            background: transparent; color: var(--sa-accent, #a45050); opacity: 0.42;
            font-family: Arial, sans-serif; font-size: 16px; line-height: 20px; text-align: center;
            cursor: pointer; transition: opacity 0.2s, background 0.2s, transform 0.2s;
        }
        #quote-panel .quote-delete:hover { opacity: 1; background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.1); transform: scale(1.08); }

        .quote-poem { margin: auto; max-width: 470px; padding: 10px 8px 36px; text-align: center; }
        .quote-poem-cn {
            font-family: 'Noto Serif SC', 'Songti SC', serif;
            font-size: 15px; line-height: 2.05; color: #5f4d46; letter-spacing: 2px;
        }
        .quote-poem-en {
            margin-top: 26px;
            font-family: Georgia, 'Times New Roman', serif;
            font-size: 13px; font-style: italic; line-height: 1.95; color: #8a766c; letter-spacing: 0.35px;
        }

        .quote-empty { margin: auto; padding-bottom: 8vh; text-align: center; }
        .quote-empty-cn { font-family: 'Noto Serif SC', 'Songti SC', serif; font-size: 15px; color: #6c5951; letter-spacing: 2px; }
        .quote-empty-en { margin-top: 10px; color: #a18d83; font-family: 'Courier New', Courier, monospace; font-size: 10px; letter-spacing: 1px; }

        .mes-bookmark-btn {
            cursor: pointer; color: #888; transition: all 0.2s;
            display: inline-flex; justify-content: center; align-items: center;
            margin-left: 10px; font-size: 14px; pointer-events: auto !important;
        }
        .mes-bookmark-btn:hover { color: var(--sa-accent, #a45050); transform: scale(1.1); }
        .mes-bookmark-btn.saved { color: var(--sa-accent, #a45050); }

        #quote-detail-overlay {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0; inset: 0;
            z-index: 2147483000;
            display: none; justify-content: center; align-items: flex-start;
            /* 手机端优先按“安全居中”：放得下就居中，放不下就贴顶，绝不把标题和关闭按钮顶出屏幕 */
            align-items: safe center;
            box-sizing: border-box;
            width: 100%; height: 100%; height: 100dvh;
            max-width: none; max-height: none;
            margin: 0; padding: 16px; border: 0;
            background: rgba(42, 34, 30, 0.34);
            overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
        }
        #quote-detail-overlay[open],
        #quote-detail-overlay.show { display: flex; animation: quoteFadeIn 0.18s ease-out; }
        #quote-detail-overlay::backdrop { background: transparent; }
        /* 老浏览器没有顶层弹窗（showModal）时，关闭拾遗面板的毛玻璃，避免合成层级把详情压到下面 */
        #quote-overlay.quote-blur-off {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }
        .quote-detail-panel {
            position: relative;
            display: flex; flex-direction: column;
            box-sizing: border-box;
            width: 92vw;
            width: min(92vw, 560px);
            max-width: 560px;
            /* 依次回退：老浏览器用 vh；支持 dvh 的用动态视口；
               再用“弹窗自身高度的 100%”兜底，避免手机本地部署时 vh 异常导致高度超出屏幕 */
            max-height: 72vh;
            max-height: min(72vh, 72dvh);
            max-height: min(72vh, 100%);
            margin: 0 auto;
            overflow: hidden;
            border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.4); border-radius: 12px;
            background: linear-gradient(145deg, var(--sa-paper, #FEFCF8) 0%, var(--sa-paper-deep, #F8F2E9) 100%);
            color: var(--sa-ink, #4A4A4A); box-shadow: 0 18px 50px rgba(60, 40, 32, 0.22);
            font-family: 'Noto Serif SC', 'Songti SC', serif;
            transform: translateY(6px) scale(0.98); animation: quoteDetailIn 0.22s ease-out forwards;
        }
        #quote-detail-overlay .quote-detail-head {
            display: flex; align-items: flex-start; gap: 12px;
            padding: 22px 24px 0; flex-shrink: 0;
        }
        #quote-detail-overlay .quote-detail-close {
            margin-left: auto; flex-shrink: 0;
            width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
            background: none; color: var(--sa-accent, #a45050); font-family: Arial, sans-serif;
            font-size: 24px; line-height: 1; cursor: pointer; box-shadow: none;
        }
        #quote-detail-overlay .quote-detail-close:hover { color: var(--sa-accent-deep, #8b3a3a); }
        .quote-detail-title {
            flex: 1; min-width: 0;
            font-family: 'Noto Serif SC', 'Songti SC', serif;
            font-size: 15px; color: var(--sa-accent-deep, #8b3a3a); letter-spacing: 1.5px; line-height: 1.6;
            overflow-wrap: anywhere; word-break: break-word;
        }
        .quote-detail-title::before {
            content: "❖"; margin-right: 8px; color: var(--sa-accent, #a45050); font-size: 11px;
            vertical-align: 1px;
        }
        .quote-detail-meta {
            flex-shrink: 0;
            margin: 12px 24px 16px; padding-bottom: 12px; border-bottom: 1px dashed rgba(var(--sa-accent-rgb, 164, 80, 80), 0.28);
            color: #999; font-family: 'Courier New', Courier, monospace; font-size: 11px; letter-spacing: 0.3px;
            overflow-wrap: anywhere; word-break: break-word;
        }
        .quote-detail-text {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto; overflow-x: hidden;
            overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
            margin: 0 24px 22px; padding-left: 14px;
            border-left: 3px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.5);
            color: var(--sa-ink-strong, #333); font-size: 14px; line-height: 1.9;
            white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
        }
        @keyframes quoteFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes quoteDetailIn { to { transform: translateY(0) scale(1); } }

        .highlight-mes { animation: quoteBreathe 2s ease-in-out; }
        @keyframes quoteBreathe {
            0% { background-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0); box-shadow: inset 0 0 0 0 rgba(var(--sa-accent-rgb, 164, 80, 80), 0); }
            30% { background-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.14); box-shadow: inset 0 0 0 1px rgba(var(--sa-accent-rgb, 164, 80, 80), 0.5), 0 0 18px rgba(var(--sa-accent-rgb, 164, 80, 80), 0.18); }
            65% { background-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.05); box-shadow: inset 0 0 0 1px rgba(var(--sa-accent-rgb, 164, 80, 80), 0.25), 0 0 8px rgba(var(--sa-accent-rgb, 164, 80, 80), 0.1); }
            100% { background-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0); box-shadow: inset 0 0 0 0 rgba(var(--sa-accent-rgb, 164, 80, 80), 0); }
        }
    `;
    document.head.appendChild(style);

    // 2. 创建悬浮按钮和面板
    const fab = document.createElement('div');
    fab.id = 'quote-fab';
    fab.innerHTML = '<i class="fa-solid fa-bookmark"></i>';
    fab.title = "拾遗";
    document.body.appendChild(fab);

    const overlay = document.createElement('div');
    overlay.id = 'quote-overlay';

    const panel = document.createElement('div');
    panel.id = 'quote-panel';
        panel.innerHTML = `
        <div class="quote-header">
            <div class="quote-tabs" role="tablist" aria-label="拾遗分类">
                <button type="button" class="quote-tab active" data-tab="current" role="tab" aria-selected="true">当前聊天</button>
                <span class="quote-tab-sep">//</span>
                <button type="button" class="quote-tab" data-tab="all" role="tab" aria-selected="false">全部聊天</button>
            </div>
            <div class="quote-header-actions">
                <button type="button" class="quote-header-btn quote-export-btn" title="导出收藏（下载 JSON 备份）" aria-label="导出收藏">
                    <i class="fa-solid fa-file-export"></i>
                </button>
                <button type="button" class="quote-header-btn quote-import-btn" title="导入收藏（从 JSON 备份恢复）" aria-label="导入收藏">
                    <i class="fa-solid fa-file-import"></i>
                </button>
                <button type="button" class="quote-close" title="关闭" aria-label="关闭">&times;</button>
            </div>
        </div>
        <div class="quote-toolbar" id="quote-toolbar"></div>
        <div class="quote-content" id="quote-list"></div>
        <!-- 🚨 极简底部英文 -->
        <div class="quote-footer">
            <div class="quote-poem-en">G L E A N I N G S</div>
        </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const importFileInput = document.createElement('input');
    importFileInput.type = 'file';
    importFileInput.accept = '.json,application/json';
    importFileInput.style.display = 'none';
    importFileInput.addEventListener('change', () => {
        const file = importFileInput.files && importFileInput.files[0];
        importFileInput.value = '';
        if (file) importQuotesFromFile(file);
    });
    document.body.appendChild(importFileInput);

    // 用原生 <dialog>：showModal() 会把详情弹层放进浏览器顶层（top layer），
    // 不会被拾遗面板、毛玻璃（backdrop-filter）或任何 z-index 堆叠上下文盖住。
    // 旧浏览器不支持 showModal 时自动回退成普通 fixed 弹层。
    const detailOverlay = document.createElement('dialog');
    detailOverlay.id = 'quote-detail-overlay';
    detailOverlay.setAttribute('aria-label', '拾遗详情');
    detailOverlay.innerHTML = `
        <div class="quote-detail-panel" aria-modal="true">
            <div class="quote-detail-head">
                <div class="quote-detail-title"></div>
                <button type="button" class="quote-detail-close" title="关闭" aria-label="关闭">&times;</button>
            </div>
            <div class="quote-detail-meta"></div>
            <div class="quote-detail-text"></div>
        </div>
    `;
    document.body.appendChild(detailOverlay);

    const detailTitle = detailOverlay.querySelector('.quote-detail-title');
    const detailMeta = detailOverlay.querySelector('.quote-detail-meta');
    const detailText = detailOverlay.querySelector('.quote-detail-text');

    // 3. 核心逻辑
    let savedQuotes = loadQuotes();
    let activeQuoteTab = 'current';
    const expandedQuoteGroups = new Set();

    // 改名事件只发一次，越早挂上越好（不依赖面板是否打开）
    bindChatRenameListener();

    // ==================================================
    // 正文渲染引擎：从“每秒全书扫描”改成“事件驱动 + 只看可见”
    // --------------------------------------------------
    // 旧版每秒都把整场聊天里所有 .mes 扫一遍，每个楼层还要把几百条收藏挨个比对，
    // 收藏越多、楼越高，每秒做的无用功就越多，滚动自然掉帧。
    // 新版做四件事：
    //   1) 建索引：按楼层号直接查，不再挨个比对；
    //   2) 只处理变化：MutationObserver 告诉你哪条消息新增/改动了；
    //   3) 只算看得见：IntersectionObserver 在消息快滚进屏幕时才补书签和下划线；
    //   4) 下划线交给浏览器原生 Highlight，不再往正文里塞几千个 span。
    // ==================================================

    const EMPTY_QUOTE_INDEX = { chatKey: '', revision: -1, byMesid: new Map(), looseSelections: [] };

    let quotesRevision = 0;
    let quoteIndexCache = null;

    function bumpQuotesRevision() {
        quotesRevision++;
        quoteIndexCache = null;
    }

    function getQuoteIndexForChat(chatInfo, ctx) {
        if (!chatInfo?.active) return EMPTY_QUOTE_INDEX;

        if (quoteIndexCache
            && quoteIndexCache.chatKey === chatInfo.key
            && quoteIndexCache.revision === quotesRevision) {
            return quoteIndexCache;
        }

        const byMesid = new Map();
        const looseSelections = [];

        for (const quote of savedQuotes) {
            if (!quote || typeof quote !== 'object') continue;

            const mesid = String(quote.mesid ?? '').trim();
            if (!/^\d+$/.test(mesid)) continue;

            const chatKey = String(quote.chatKey || '');
            if (!chatKey) {
                // 老数据没有 chatKey，没法参与 O(1) 索引；交给选择判重时用文本兜底。
                if (quote.source === 'selection') looseSelections.push(quote);
                continue;
            }
            if (chatKey !== chatInfo.key) continue;

            let entry = byMesid.get(mesid);
            if (!entry) {
                entry = { whole: false, selections: [] };
                byMesid.set(mesid, entry);
            }

            if (quote.source === 'selection') {
                entry.selections.push(quote);
            } else {
                // 整层书签只认“同一聊天 + 同一楼层”，不再依赖存下来的角色名。
                // 这样重命名角色、消息里的 name 变了，书签也不会假性消失。
                entry.whole = true;
            }
        }

        quoteIndexCache = {
            chatKey: chatInfo.key,
            revision: quotesRevision,
            byMesid,
            looseSelections,
        };
        return quoteIndexCache;
    }

    function getMessageCharName(mes) {
        const nameEl = mes.querySelector('.ch_name .name_text');
        return normalizeCharName(
            (nameEl?.textContent || mes.getAttribute('ch_name') || '未知角色').trim()
        );
    }

    function isMessageBookmarked(mesid, chatInfo, ctx) {
        if (!chatInfo?.active) return false;
        const index = getQuoteIndexForChat(chatInfo, ctx);
        const entry = index.byMesid.get(String(mesid));
        return Boolean(entry && entry.whole);
    }

    let hydratedChatKey = '';

    function ensureChatHydrated(chatInfo, ctx) {
        if (!chatInfo?.active) return false;
        if (hydratedChatKey === chatInfo.key) return false;

        hydratedChatKey = chatInfo.key;
        const changed = hydrateLegacyQuotes(chatInfo, ctx);
        if (changed) {
            bumpQuotesRevision();
            refreshAllSynced();
        }
        return changed;
    }

    // ---- 消息同步队列 ----
    let messageSyncState = new WeakMap();
    const syncedMessages = new Set();
    const visibleMessages = new Set();
    const dirtyMessages = new Set();
    const forcedMessages = new Set();
    let syncFrame = 0;

    function scheduleMessageSync(mes, force = false) {
        if (!(mes instanceof Element) || !mes.classList.contains('mes')) return;
        if (!mes.isConnected) return;

        dirtyMessages.add(mes);
        if (force) forcedMessages.add(mes);
        requestSyncFlush();
    }

    function requestSyncFlush() {
        if (syncFrame) return;
        syncFrame = requestAnimationFrame(() => {
            syncFrame = 0;
            flushDirtyMessages();
        });
    }

    function flushDirtyMessages() {
        if (!dirtyMessages.size) return;

        const ctx = getChatContext();
        const chatInfo = getCurrentChatInfo();

        if (!chatInfo.active) {
            dirtyMessages.clear();
            forcedMessages.clear();
            return;
        }

        ensureChatHydrated(chatInfo, ctx);
        const index = getQuoteIndexForChat(chatInfo, ctx);

        // 一次只花 ~9ms：剩下的下一帧接着做，主线程永远不会被一条长任务堵死。
        const startedAt = performance.now();
        for (const mes of dirtyMessages) {
            dirtyMessages.delete(mes);

            if (!mes.isConnected) continue;

            const force = forcedMessages.delete(mes);
            syncMessage(mes, chatInfo, ctx, index, force);

            if (performance.now() - startedAt > 9) {
                requestSyncFlush();
                break;
            }
        }
    }

    function syncBookmarkButton(mes, mesid, charName, isSaved, isUser) {
        let btn = mes.querySelector('.mes-bookmark-btn');

        if (isUser) {
            if (btn) btn.remove();
            return true;
        }

        if (!btn) {
            const targetArea = mes.querySelector('.mes_buttons');
            // 消息还没有完全渲染出来：等一会儿再补，不能把“没按钮”写进缓存
            if (!targetArea) return false;

            btn = document.createElement('div');
            btn.className = 'mes-bookmark-btn';
            btn.title = '收录此句';
            targetArea.appendChild(btn);
        }

        if (btn.dataset.mesid !== mesid) btn.dataset.mesid = mesid;
        if (btn.dataset.char !== charName) btn.dataset.char = charName;

        if (btn.dataset.saved !== String(isSaved)) {
            btn.dataset.saved = String(isSaved);
            btn.classList.toggle('saved', isSaved);
            btn.innerHTML = isSaved
                ? '<i class="fa-solid fa-bookmark"></i>'
                : '<i class="fa-regular fa-bookmark"></i>';
        }

        return true;
    }

    function syncMessage(mes, chatInfo, ctx, index, force = false) {
        if (!mes.isConnected) return;

        if (mes.closest('.template_element') || mes.closest('#message_template')) {
            mes.querySelectorAll('.mes-bookmark-btn').forEach(btn => btn.remove());
            removeUnderlinesForMessage(mes);
            messageSyncState.delete(mes);
            return;
        }

        const mesid = String(mes.getAttribute('mesid') ?? '').trim();
        if (!mesid) return;

        const isUser = mes.getAttribute('is_user') === 'true';
        const charName = isUser ? '' : getMessageCharName(mes);
        const entry = index.byMesid.get(mesid) || null;
        const wanted = entry ? entry.selections : [];
        const wantedKey = wanted.map(archiveQuoteKey).filter(Boolean).sort().join('|');
        const isSaved = !isUser && Boolean(entry && entry.whole);

        const previous = messageSyncState.get(mes);
        const container = mes.querySelector('.mes_text');
        const containerChanged = !previous || previous.container !== container;

        // 核心：状态没变就什么都不做。滚动时绝不再重复排版 / 重画。
        const needsUnderline = wanted.length > 0 || Boolean(previous?.keys);
        const cacheValid = Boolean(previous)
            && previous.mesid === mesid
            && previous.char === charName
            && previous.saved === isSaved
            && previous.keys === wantedKey
            && !containerChanged
            && (!force || !needsUnderline);

        if (cacheValid) return;

        const buttonReady = syncBookmarkButton(mes, mesid, charName, isSaved, isUser);

        if (previous && (containerChanged || force || previous.keys !== wantedKey)) {
            removeUnderlinesForMessage(mes);
        }
        if (wanted.length) {
            syncUnderlinesForMessage(mes, wanted);
        }

        if (!buttonReady) {
            // 消息还没有 .mes_buttons：不写缓存，也不做 300ms 死循环重试。
            // 下一次“可见性检查 / 消息变化”会再补，最多晚 2 秒，绝不会拖慢滚动。
            return;
        }

        messageSyncState.set(mes, {
            mesid,
            char: charName,
            saved: isSaved,
            keys: wantedKey,
            container,
            chatKey: chatInfo.key,
        });
        syncedMessages.add(mes);
    }

    function refreshAllSynced() {
        syncedMessages.forEach(mes => {
            if (mes.isConnected) dirtyMessages.add(mes);
            else syncedMessages.delete(mes);
        });
        visibleMessages.forEach(mes => {
            if (mes.isConnected) dirtyMessages.add(mes);
        });
        requestSyncFlush();
    }

    function scheduleVisibleSync() {
        visibleMessages.forEach(mes => {
            if (mes.isConnected) scheduleMessageSync(mes);
        });
    }

    function syncMessageForMesid(mesid) {
        const id = String(mesid ?? '').trim();
        if (!/^\d+$/.test(id)) return;

        const mes = document.querySelector(`#chat .mes[mesid="${CSS.escape(id)}"]`);
        if (mes) scheduleMessageSync(mes);
    }

    // 兼容旧调用：以前叫 injectBookmarks()，现在只重算已经处理过的消息，不再全量扫。
    function injectBookmarks() {
        refreshAllSynced();
    }

    // ---- 可见性 / DOM 变化监听 ----
    let observersStarted = false;
    let messageIntersectionObserver = null;
    let chatMutationObserver = null;
    let observedMessages = new WeakSet();

    function observeMessageElement(mes) {
        if (!(mes instanceof Element) || !mes.classList.contains('mes')) return;
        if (mes.closest('.template_element') || mes.closest('#message_template')) return;
        if (observedMessages.has(mes)) return;

        observedMessages.add(mes);
        messageIntersectionObserver?.observe(mes);
    }

    function collectMesNodes(node, out) {
        if (!(node instanceof Element)) return;
        if (node.classList.contains('mes')) {
            out.push(node);
            return;
        }
        node.querySelectorAll?.('.mes').forEach(mes => out.push(mes));
    }

    function closestMesNode(node) {
        const el = node instanceof Element ? node : node?.parentElement;
        return el?.closest?.('.mes') || null;
    }

    function scanMessages(root = document.getElementById('chat')) {
        if (!root) return;
        root.querySelectorAll('.mes').forEach(observeMessageElement);
    }

    function startMessageObservers() {
        observersStarted = true;

        const chat = document.getElementById('chat');
        if (!chat) return;

        if (messageIntersectionObserver) {
            try { messageIntersectionObserver.disconnect(); } catch (error) { /* 忽略 */ }
        }
        if (chatMutationObserver) {
            try { chatMutationObserver.disconnect(); } catch (error) { /* 忽略 */ }
        }

        observedMessages = new WeakSet();

        if (typeof IntersectionObserver === 'function') {
            messageIntersectionObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    const mes = entry.target;
                    if (!(mes instanceof Element) || !mes.isConnected) continue;

                    if (entry.isIntersecting) {
                        visibleMessages.add(mes);
                        scheduleMessageSync(mes);
                    } else {
                        visibleMessages.delete(mes);
                    }
                }
            }, { root: chat, rootMargin: '800px 0px' });
        } else {
            // 非常老的浏览器：没有 IntersectionObserver，就退回“消息出现时同步一次”
            messageIntersectionObserver = {
                observe(mes) { scheduleMessageSync(mes); },
                unobserve() {},
                disconnect() {},
            };
        }

        scanMessages(chat);

        chatMutationObserver = new MutationObserver(records => {
            const touched = new Set();
            const removed = [];

            for (const record of records) {
                if (isOwnUnderlineMutation(record)) continue;

                if (record.type === 'characterData') {
                    const host = closestMesNode(record.target);
                    if (host) touched.add(host);
                    continue;
                }
                if (record.type !== 'childList') continue;

                record.addedNodes.forEach(node => {
                    if (!(node instanceof Element)) return;
                    const inside = [];
                    collectMesNodes(node, inside);
                    inside.forEach(mes => {
                        observeMessageElement(mes);
                        touched.add(mes);
                    });
                });

                record.removedNodes.forEach(node => {
                    if (!(node instanceof Element)) return;
                    collectMesNodes(node, removed);
                });

                const host = closestMesNode(record.target);
                if (host) touched.add(host);
            }

            removed.forEach(mes => messageIntersectionObserver?.unobserve(mes));

            touched.forEach(mes => {
                if (!mes.isConnected) return;
                // 新消息等 IntersectionObserver 靠近屏幕再处理；已经处理过的才需要立刻重算
                if (visibleMessages.has(mes) || messageSyncState.has(mes)) {
                    scheduleMessageSync(mes, true);
                }
            });
        });

        chatMutationObserver.observe(chat, { childList: true, subtree: true, characterData: true });
    }

    // ---- 聊天切换 ----
    let runtimeChatKey = '';

    function resetQuoteRuntime(chatInfo, ctx) {
        visibleMessages.clear();
        syncedMessages.clear();
        dirtyMessages.clear();
        forcedMessages.clear();
        messageSyncState = new WeakMap();
        hydratedChatKey = '';

        clearAllUnderlines();

        if (observersStarted) startMessageObservers();
        if (chatInfo?.active) ensureChatHydrated(chatInfo, ctx);
    }

    function ensureRuntimeChat() {
        const ctx = getChatContext();
        const chatInfo = getCurrentChatInfo();
        const key = chatInfo.active ? chatInfo.key : '';

        if (key !== runtimeChatKey) {
            runtimeChatKey = key;
            resetQuoteRuntime(chatInfo, ctx);
        }

        return { chatInfo, ctx };
    }

    function safetyTick() {
        try {
            ensureRuntimeChat();
            if (!messageIntersectionObserver) startMessageObservers();
            scanMessages();
            scheduleVisibleSync();

            if (syncedMessages.size > 256) {
                syncedMessages.forEach(mes => {
                    if (!mes.isConnected) syncedMessages.delete(mes);
                });
            }
        } catch (error) {
            console.warn('[ST-档案馆] 同步书签/下划线失败', error);
        }
    }

    function startQuoteRuntime() {
        const ctx = getChatContext();
        const chatInfo = getCurrentChatInfo();
        runtimeChatKey = chatInfo.active ? chatInfo.key : '';

        if (chatInfo.active) ensureChatHydrated(chatInfo, ctx);

        startMessageObservers();

        const eventSource = ctx?.eventSource;
        const eventTypes = ctx?.eventTypes;
        if (eventSource?.on && eventTypes) {
            [eventTypes.CHAT_CHANGED, eventTypes.CHAT_LOADED, eventTypes.MORE_MESSAGES_LOADED]
                .filter(Boolean)
                .forEach(type => {
                    eventSource.on(type, () => {
                        ensureRuntimeChat();
                        // 新面板可能还在同一帧里陆续插入，等下一帧再扫一次
                        requestAnimationFrame(() => {
                            scanMessages();
                            scheduleVisibleSync();
                        });
                    });
                });

            [eventTypes.CHARACTER_MESSAGE_RENDERED, eventTypes.USER_MESSAGE_RENDERED]
                .filter(Boolean)
                .forEach(type => {
                    eventSource.on(type, () => {
                        scanMessages();
                        scheduleVisibleSync();
                    });
                });
        }

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            scanMessages();
            scheduleVisibleSync();
        });

        // 兜底：每 2 秒只做一次“很便宜的检查”。有缓存时不会产生任何 DOM 写入。
        setInterval(safetyTick, 2000);
    }

    function renderQuotePoem(list) {
        list.innerHTML = `
            <div class="quote-poem">
                <div class="quote-poem-cn">
                    你在此处拾起一枚落叶。<br>
                    若要知晓那棵树的完整枯荣，<br>
                    请顺着根系，重返它的土壤。
                </div>
                <div class="quote-poem-en">
                    Here, you gather a single fallen leaf.<br>
                    To witness its bloom and wither,<br>
                    trace the roots back to its soil.
                </div>
            </div>
        `;
    }

    function renderQuoteEmpty(list, cn, en) {
        list.innerHTML = `
            <div class="quote-empty">
                <div class="quote-empty-cn"></div>
                <div class="quote-empty-en"></div>
            </div>
        `;
        list.querySelector('.quote-empty-cn').textContent = cn;
        list.querySelector('.quote-empty-en').textContent = en;
    }

    function isQuoteDetailOpen() {
        return detailOverlay.open === true || detailOverlay.classList.contains('show');
    }

    // 手机本地部署 / 内置浏览器里，100vh、100dvh 有时会按更大的“布局视口”计算，
    // 结果弹窗比屏幕还高、上半部分被顶到屏幕外。这里直接按“当前看得见的视口”钉住弹层。
    function applyDetailViewportBounds() {
        pinLayerToVisibleViewport(detailOverlay);
    }

    function refreshQuoteDetailBounds() {
        if (isQuoteDetailOpen()) applyDetailViewportBounds();
    }

    function openQuoteDetailLayer() {
        applyDetailViewportBounds();

        if (typeof detailOverlay.showModal === 'function') {
            if (!detailOverlay.open) {
                try {
                    detailOverlay.showModal();
                } catch (error) {
                    console.warn('[ST-档案馆] 原生详情弹窗不可用，回退到普通弹层', error);
                    overlay.classList.add('quote-blur-off');
                    detailOverlay.classList.add('show');
                }
            }
        } else {
            overlay.classList.add('quote-blur-off');
            detailOverlay.classList.add('show');
        }

        applyDetailViewportBounds();
    }

    function showQuoteDetail(quote) {
        const chat = getQuoteChatInfo(quote);
        detailTitle.textContent = `${chat.char} - ${chat.chatName}`;
        detailMeta.textContent = [
            chat.char || quote.char,
            quote.mesid !== undefined && quote.mesid !== '' ? `#${quote.mesid}` : '',
            quote.time,
        ].filter(Boolean).join(' · ');
        detailText.textContent = quote.text || '（这条拾遗没有正文）';
        detailText.scrollTop = 0;
        openQuoteDetailLayer();
    }

    function hideQuoteDetail() {
        detailOverlay.classList.remove('show');
        overlay.classList.remove('quote-blur-off');
        if (typeof detailOverlay.close === 'function' && detailOverlay.open) {
            try {
                detailOverlay.close();
            } catch (error) {
                console.warn('[ST-档案馆] 关闭详情弹窗失败', error);
            }
        }
    }

    function closeQuotePanel() {
        hideQuoteDetail();
        overlay.classList.remove('show');
        clearTimeout(quoteSearchTimer);
        // 面板关掉后没必要继续观察“加载更多”的哨兵
        if (typeof disconnectPanelObservers === 'function') disconnectPanelObservers();
    }

    // 旋转屏幕、地址栏收起/展开、软键盘变化时，重新把详情弹层钉回可见视口
    window.addEventListener('resize', refreshQuoteDetailBounds);
    window.addEventListener('orientationchange', refreshQuoteDetailBounds);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
        window.visualViewport.addEventListener('resize', refreshQuoteDetailBounds);
        window.visualViewport.addEventListener('scroll', refreshQuoteDetailBounds);
    }

    function syncBookmarkAfterDelete(quote) {
        // 只重算“这条收藏所在的楼层”，不再顺带把整场聊天扫一遍。
        syncMessageForMesid(quote?.mesid);
    }

    function deleteQuote(quote, cardEl = null) {
        savedQuotes = savedQuotes.filter(item => item !== quote);
        saveQuotes();
        syncBookmarkAfterDelete(quote);

        // 同步更新检索缓存，删完以后再搜索 / 排序不会把这条又翻出来
        const removeFromList = list => {
            const index = list.indexOf(quote);
            if (index >= 0) list.splice(index, 1);
        };
        removeFromList(quotePanelData.currentQuotes);
        quotePanelData.allGroups.forEach(group => removeFromList(group.quotes));

        // 删除单张卡片时只抠掉这一张，不重排整个面板，滚动位置和已加载的卡片都保住。
        if (cardEl instanceof Element && cardEl.isConnected) {
            const groupEl = cardEl.closest('.quote-group');
            cardEl.remove();

            if (!groupEl) return;

            const groupData = panelGroupData.get(groupEl.dataset.key);
            if (!groupData) return;

            const index = groupData.quotes.indexOf(quote);
            if (index >= 0) groupData.quotes.splice(index, 1);

            const countEl = groupEl.querySelector('.quote-group-count');
            if (countEl) countEl.textContent = `${groupData.quotes.length} 条`;

            if (!groupData.quotes.length) {
                groupEl.remove();
                panelGroupData.delete(groupEl.dataset.key);
            }
            return;
        }

        if (overlay.classList.contains('show')) renderQuotes();
    }

    // ==================================================
    // 导出 / 导入（本地 JSON 备份）
    // ==================================================

    function showArchiveToast(type, message) {
        const toastType = ['success', 'info', 'warning', 'error'].includes(type) ? type : 'info';
        try {
            if (globalThis.toastr && typeof globalThis.toastr[toastType] === 'function') {
                globalThis.toastr[toastType](message, 'ST-档案馆', { timeOut: 3200, preventDuplicates: true });
                return;
            }
        } catch (error) {
            console.warn('[ST-档案馆] 提示弹窗失败', error);
        }
        console.log(`[ST-档案馆] ${message}`);
    }

    function formatArchiveTimestamp(date = new Date()) {
        const pad = value => String(value).padStart(2, '0');
        return [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate()),
            '-',
            pad(date.getHours()),
            pad(date.getMinutes()),
            pad(date.getSeconds()),
        ].join('');
    }

    function buildArchiveExportPayload() {
        const state = getArchiveState();
        return {
            app: 'ST-Archive',
            type: 'st-archive-quotes',
            version: 1,
            exportedAt: new Date().toISOString(),
            count: savedQuotes.length,
            quotes: savedQuotes,
            pinnedChars: [...state.pinnedChars],
            pinnedChats: { ...state.pinnedChats },
        };
    }

    function exportQuotesToFile() {
        const payload = buildArchiveExportPayload();
        const fileName = `st-archive-${formatArchiveTimestamp()}.json`;

        try {
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);

            if (payload.count > 0) {
                showArchiveToast('success', `已导出 ${payload.count} 条收藏`);
            } else {
                showArchiveToast('info', '当前还没有收藏，已导出空备份');
            }
        } catch (error) {
            console.error('[ST-档案馆] 导出失败', error);
            showArchiveToast('error', '导出失败：当前浏览器不支持文件下载');
        }
    }

    function normalizeImportedQuote(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

        const mesid = String(raw.mesid ?? '').trim();
        const text = String(raw.text ?? '');
        const chatKey = String(raw.chatKey ?? '').trim();
        const isFreeQuote = mesid === '' && text.trim().length > 0
            && (raw.source === 'selection' || Boolean(chatKey));
        if (!/^\d+$/.test(mesid) && !isFreeQuote) return null;

        let char = normalizeCharName(raw.char ?? '');
        if (char.includes('${')) char = '未知角色';

        if (!text.trim()) return null;

        const quote = {
            mesid,
            char,
            text,
            time: String(raw.time ?? '').trim() || new Date().toLocaleString(),
            chatKey,
            chatName: String(raw.chatName ?? '').trim(),
            chatChar: raw.chatChar ? normalizeCharName(raw.chatChar) : char,
            scope: String(raw.scope ?? '').trim(),
        };
        if (raw.source === 'selection') quote.source = 'selection';

        const createdAt = Number(raw.createdAt);
        if (Number.isFinite(createdAt) && createdAt > 0) quote.createdAt = createdAt;

        return quote;
    }

    function mergeImportedQuotes(rawList) {
        const merged = [...savedQuotes];
        const known = new Set(merged.map(archiveQuoteKey));
        let added = 0;
        let skipped = 0;

        rawList.forEach(raw => {
            const quote = normalizeImportedQuote(raw);
            if (!quote) {
                skipped++;
                return;
            }

            const key = archiveQuoteKey(quote);
            if (!key || known.has(key)) {
                skipped++;
                return;
            }

            known.add(key);
            merged.push(quote);
            added++;
        });

        return { merged, added, skipped };
    }

    function mergeImportedPins(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 0;

        const state = getArchiveState();
        let added = 0;

        if (Array.isArray(payload.pinnedChars)) {
            payload.pinnedChars.forEach(key => {
                if (typeof key !== 'string' || !key) return;
                if (state.pinnedChars.includes(key)) return;
                state.pinnedChars.push(key);
                added++;
            });
        }

        if (payload.pinnedChats && typeof payload.pinnedChats === 'object' && !Array.isArray(payload.pinnedChats)) {
            Object.keys(payload.pinnedChats).forEach(key => {
                if (payload.pinnedChats[key] !== true) return;
                if (state.pinnedChats[key] === true) return;
                state.pinnedChats[key] = true;
                added++;
            });
        }

        return added;
    }

    function importQuotesFromFile(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            let payload;
            try {
                payload = JSON.parse(String(reader.result ?? ''));
            } catch (error) {
                showArchiveToast('error', '导入失败：文件不是合法的 JSON');
                return;
            }

            const rawList = Array.isArray(payload)
                ? payload
                : (Array.isArray(payload?.quotes) ? payload.quotes
                    : (Array.isArray(payload?.data) ? payload.data : null));

            if (!rawList) {
                showArchiveToast('error', '导入失败：文件里没有找到收藏列表');
                return;
            }

            try {
                const { merged, added, skipped } = mergeImportedQuotes(rawList);
                const pinAdded = mergeImportedPins(Array.isArray(payload) ? null : payload);

                if (added > 0) {
                    savedQuotes = merged;
                    saveQuotes();
                } else if (pinAdded > 0) {
                    persistArchiveState();
                }

                if (added > 0 || pinAdded > 0) {
                    // 备份里可能带老格式（没有 chatKey）的收藏，重新做一次“认领”
                    hydratedChatKey = '';
                    renderQuotes();
                    injectBookmarks();
                }

                const parts = [`新增 ${added} 条`];
                if (skipped > 0) parts.push(`跳过 ${skipped} 条重复或无效记录`);
                if (pinAdded > 0) parts.push(`恢复 ${pinAdded} 项置顶`);

                const toastType = (added > 0 || pinAdded > 0) ? 'success' : 'info';
                showArchiveToast(toastType, `导入完成：${parts.join('，')}`);
            } catch (error) {
                console.error('[ST-档案馆] 导入失败', error);
                showArchiveToast('error', '导入失败：数据格式异常');
            }
        };

        reader.onerror = () => showArchiveToast('error', '导入失败：无法读取文件');
        reader.readAsText(file);
    }

    // ==================================================
    // 拾遗面板：按住“看得见的那一屏”渲染
    // --------------------------------------------------
    // 旧版只要收藏有 3000 条，就会一次性建 3000 张卡片 + 6000 个监听器，
    // 打开面板必卡。现在：
    //   · 当前聊天：先建 40 张，滚到底再补下一批；
    //   · 全部聊天：只建立分组标题，点开哪组才建哪组的卡片；
    //   · 整个面板只挂一个点击监听（事件委托）。
    // ==================================================

    const QUOTE_CARD_CHUNK = 40;
    const QUOTE_GROUP_HEADER_CHUNK = 60;

    let panelObservers = [];
    let panelGroupData = new Map();
    const quoteCardMap = new WeakMap();

    // 拾遗检索状态：两个 Tab 各自记住自己的搜索词 / 排序 / 角色筛选
    const quotePanelFilters = {
        current: { search: '', sort: 'time-desc' },
        all: { search: '', char: '' },
    };
    const quotePanelData = {
        currentQuotes: [],
        allGroups: [],
        toolbarTab: '',
        toolbarChars: '',
        toolbarChatKey: '',
    };
    const quoteTimeCache = new WeakMap();
    let quoteSearchTimer = 0;

    function disconnectPanelObservers() {
        panelObservers.forEach(observer => {
            try { observer.disconnect(); } catch (error) { /* 忽略 */ }
        });
        panelObservers = [];
    }

    function observePanelSentinel(element, root, callback) {
        let revealed = false;
        let observer = null;

        const reveal = () => {
            if (revealed) return;
            revealed = true;
            if (observer) {
                try { observer.disconnect(); } catch (error) { /* 忽略 */ }
                panelObservers = panelObservers.filter(item => item !== observer);
            }
            element.remove();
            callback();
        };

        // 点击“···”也能加载：IO 万一被主题/布局影响，功能仍然可用
        element.addEventListener('click', reveal);

        if (typeof IntersectionObserver !== 'function') {
            reveal();
            return;
        }

        observer = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) return;
            reveal();
        }, { root: root || null, rootMargin: '600px 0px' });

        observer.observe(element);
        panelObservers.push(observer);
    }

    function appendQuoteCardChunk(container, quotes, start, root) {
        if (start >= quotes.length) return;

        const end = Math.min(quotes.length, start + QUOTE_CARD_CHUNK);
        const fragment = document.createDocumentFragment();

        for (let index = start; index < end; index++) {
            fragment.appendChild(createQuoteCard(quotes[index]));
        }
        container.appendChild(fragment);

        if (end >= quotes.length) return;

        const more = document.createElement('div');
        more.className = 'quote-load-more';
        more.textContent = '···';
        container.appendChild(more);

        observePanelSentinel(more, root, () => appendQuoteCardChunk(container, quotes, end, root));
    }

    function createQuoteCard(quote) {
        const card = document.createElement('div');
        card.className = 'quote-card';

        const textDiv = document.createElement('div');
        textDiv.className = 'q-text';
        textDiv.textContent = quote.text || '无内容';

        const timeDiv = document.createElement('div');
        timeDiv.className = 'q-time';
        timeDiv.textContent = quote.time || '';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'quote-delete';
        deleteBtn.title = '删除这条拾遗';
        deleteBtn.setAttribute('aria-label', '删除这条拾遗');
        deleteBtn.textContent = '×';

        card.appendChild(textDiv);
        card.appendChild(timeDiv);
        card.appendChild(deleteBtn);

        quoteCardMap.set(card, quote);
        return card;
    }

    function createQuoteGroupElement(data, root) {
        const group = document.createElement('div');
        group.className = 'quote-group';
        group.dataset.key = data.key;
        if (expandedQuoteGroups.has(data.key)) group.classList.add('is-open');

        const title = `${data.chat.char} - ${data.chat.chatName}`;

        const header = document.createElement('div');
        header.className = 'quote-group-header';
        header.title = title;
        header.innerHTML = `
            <div class="quote-group-title">
                <span class="icon">❖</span>
                <span class="quote-group-name"></span>
            </div>
            <div class="quote-group-meta">
                <span class="quote-group-count"></span>
                <i class="fa-solid fa-chevron-down quote-group-chevron"></i>
            </div>
        `;
        header.querySelector('.quote-group-name').textContent = title;
        header.querySelector('.quote-group-count').textContent = `${data.quotes.length} 条`;

        const content = document.createElement('div');
        content.className = 'quote-group-content';

        group.appendChild(header);
        group.appendChild(content);

        panelGroupData.set(data.key, data);

        // 收起的组一张卡片都不建；展开的组也只建第一批。
        if (group.classList.contains('is-open')) {
            content.dataset.built = '1';
            appendQuoteCardChunk(content, data.quotes, 0, root);
        }

        return group;
    }

    function appendQuoteGroupChunk(list, groups, start, root) {
        if (start >= groups.length) return;

        const end = Math.min(groups.length, start + QUOTE_GROUP_HEADER_CHUNK);
        const fragment = document.createDocumentFragment();

        for (let index = start; index < end; index++) {
            fragment.appendChild(createQuoteGroupElement(groups[index], root));
        }
        list.appendChild(fragment);

        if (end >= groups.length) return;

        const more = document.createElement('div');
        more.className = 'quote-load-more';
        more.textContent = '···';
        list.appendChild(more);

        observePanelSentinel(more, root, () => appendQuoteGroupChunk(list, groups, end, root));
    }

    // ---- 拾遗检索：搜索 / 排序 / 角色筛选 ----

    function normalizeQuoteSearch(value) {
        return String(value ?? '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getQuoteFloor(quote) {
        const mesid = String(quote?.mesid ?? '').trim();
        return /^\d+$/.test(mesid) ? Number(mesid) : null;
    }

    function getQuoteTime(quote) {
        if (!quote || typeof quote !== 'object') return 0;

        const raw = quote.time;
        const rawText = String(raw ?? '');
        const createdAt = Number(quote.createdAt);
        const hasCreatedAt = Number.isFinite(createdAt) && createdAt > 0;
        const cacheKey = `${hasCreatedAt ? createdAt : ''}|${rawText}`;

        const cached = quoteTimeCache.get(quote);
        if (cached && cached.raw === cacheKey) return cached.value;

        let value = 0;
        if (hasCreatedAt) {
            value = createdAt;
        } else if (typeof raw === 'number' && Number.isFinite(raw)) {
            value = raw;
        } else {
            value = Date.parse(rawText);
            if (!Number.isFinite(value)) {
                // 兼容 2026/11/15、2026-11-15 这类常见写法
                value = Date.parse(rawText.replace(/[/.]/g, '-'));
            }
            if (!Number.isFinite(value)) {
                value = Date.parse(rawText.replace(' ', 'T'));
            }
        }
        if (!Number.isFinite(value)) value = 0;

        quoteTimeCache.set(quote, { raw: cacheKey, value });
        return value;
    }

    function sortCurrentQuotes(quotes, sortKey) {
        // 用“写入 savedQuotes 的先后顺序”作为时间不可用时的兜底：
        // 旧数据的 time 格式不一定能被 Date.parse 认出来，但收录顺序一定可靠。
        const insertionOrder = new Map();
        savedQuotes.forEach((quote, index) => insertionOrder.set(quote, index));

        const byFloor = sortKey === 'floor-asc' || sortKey === 'floor-desc';
        const direction = sortKey === 'floor-asc' || sortKey === 'time-asc' ? 1 : -1;

        const items = quotes.map((quote, index) => ({
            quote,
            index,
            floor: getQuoteFloor(quote),
            time: getQuoteTime(quote),
        }));

        items.sort((a, b) => {
            if (byFloor) {
                if (a.floor === null && b.floor === null) return a.index - b.index;
                if (a.floor === null) return 1; // 没有楼层号的收藏永远排在最后
                if (b.floor === null) return -1;
                if (a.floor !== b.floor) return (a.floor - b.floor) * direction;
                return a.index - b.index; // 同一楼层：最近收录的在前
            }

            if (a.time !== b.time) {
                if (!a.time) return 1;
                if (!b.time) return -1;
                return (a.time - b.time) * direction;
            }

            const orderA = insertionOrder.get(a.quote) ?? 0;
            const orderB = insertionOrder.get(b.quote) ?? 0;
            return (orderA - orderB) * direction;
        });

        return items.map(item => item.quote);
    }

    function filterCurrentQuotes() {
        const state = quotePanelFilters.current;
        const keyword = normalizeQuoteSearch(state.search);
        const quotes = keyword
            ? quotePanelData.currentQuotes.filter(quote => normalizeQuoteSearch(quote.text).includes(keyword))
            : quotePanelData.currentQuotes;

        return sortCurrentQuotes(quotes, state.sort);
    }

    function filterAllQuoteGroups() {
        const state = quotePanelFilters.all;
        const keyword = normalizeQuoteSearch(state.search);
        const result = [];

        quotePanelData.allGroups.forEach(group => {
            if (state.char && String(group.chat.char || '').trim() !== state.char) return;

            if (!keyword) {
                result.push(group);
                return;
            }

            // 角色名 / 对话名 / “角色 - 对话”整串命中：整组都显示，
            // 避免“搜角色只搜出一句”的割裂感
            const groupTitle = `${group.chat.char} - ${group.chat.chatName}`;
            const nameMatched = normalizeQuoteSearch(group.chat.char).includes(keyword)
                || normalizeQuoteSearch(group.chat.chatName).includes(keyword)
                || normalizeQuoteSearch(groupTitle).includes(keyword);
            if (nameMatched) {
                result.push(group);
                return;
            }

            const quotes = group.quotes.filter(quote => normalizeQuoteSearch(quote.text).includes(keyword));
            if (quotes.length) {
                result.push({ key: group.key, chat: group.chat, quotes });
            }
        });

        return result;
    }

    function getQuoteCharacterNames(groups) {
        const names = new Set();
        groups.forEach(group => {
            const name = String(group.chat.char || '').trim();
            if (name) names.add(name);
        });
        return [...names].sort((a, b) => a.localeCompare(b));
    }

    // 收起状态最多只显示三个字符；下拉弹窗里仍然是完整名字
    function getCharacterFilterLabel(name) {
        return Array.from(String(name || '')).slice(0, 3).join('');
    }

    function renderQuoteNoResults(list) {
        renderQuoteEmpty(
            list,
            '没有找到匹配的书签。\n换个关键词试试。',
            'No matching gleanings found.'
        );
    }

    function renderQuoteResults(resetScroll = false) {
        const list = document.getElementById('quote-list');
        if (!list || !overlay.classList.contains('show')) return;

        disconnectPanelObservers();
        panelGroupData = new Map();
        list.replaceChildren();

        if (activeQuoteTab === 'current') {
            const chatInfo = getCurrentChatInfo();

            if (!chatInfo.active) {
                renderQuotePoem(list);
                return;
            }

            if (!quotePanelData.currentQuotes.length) {
                renderQuoteEmpty(list, '这里是寂静的荒原，\n等待第一场风暴。', 'A silent wasteland awaiting the first storm.');
                return;
            }

            const quotes = filterCurrentQuotes();
            if (!quotes.length) {
                renderQuoteNoResults(list);
            } else {
                appendQuoteCardChunk(list, quotes, 0, list);
            }

            if (resetScroll) list.scrollTop = 0;
            return;
        }

        if (!quotePanelData.allGroups.length) {
            renderQuoteEmpty(list, '这里是寂静的荒原，\n等待第一场风暴。', 'A silent wasteland awaiting the first storm.');
            return;
        }

        const groups = filterAllQuoteGroups();
        if (!groups.length) {
            renderQuoteNoResults(list);
        } else {
            appendQuoteGroupChunk(list, groups, 0, list);
        }

        if (resetScroll) list.scrollTop = 0;
    }

    function renderQuoteToolbar(tab, chars, enabled) {
        const toolbar = document.getElementById('quote-toolbar');
        if (!toolbar) return;

        if (!enabled) {
            clearTimeout(quoteSearchTimer);
            quotePanelData.toolbarTab = '';
            quotePanelData.toolbarChars = '';
            toolbar.dataset.built = '0';
            toolbar.replaceChildren();
            return;
        }

        const charsKey = chars.join('\u0001');
        if (quotePanelData.toolbarTab === tab
            && quotePanelData.toolbarChars === charsKey
            && toolbar.dataset.built === '1') {
            return;
        }

        clearTimeout(quoteSearchTimer);
        quotePanelData.toolbarTab = tab;
        quotePanelData.toolbarChars = charsKey;

        const isCurrent = tab === 'current';
        const state = isCurrent ? quotePanelFilters.current : quotePanelFilters.all;

        const sortOptions = [
            ['floor-asc', 'Floor ↑'],
            ['floor-desc', 'Floor ↓'],
            ['time-asc', 'Time ↑'],
            ['time-desc', 'Time ↓'],
        ];
        const sortValues = new Set(sortOptions.map(item => item[0]));
        if (isCurrent && !sortValues.has(state.sort)) state.sort = 'time-desc';

        const placeholder = isCurrent
            ? 'Search this chat...'
            : 'Search text / character / chat...';
        const ariaLabel = isCurrent ? '搜索当前聊天的书签' : '搜索全部书签';

        let selectHtml = '';
        if (isCurrent) {
            selectHtml = sortOptions
                .map(([value, label]) => `<option value="${value}">${label}</option>`)
                .join('');
        } else {
            selectHtml = '<option value="">char</option>';
        }

        toolbar.dataset.built = '1';
        toolbar.innerHTML = `
            <div class="quote-search-box">
                <input type="text" class="quote-search-input" placeholder="${placeholder}" aria-label="${ariaLabel}">
                <button type="button" class="quote-search-btn" title="Search" aria-label="搜索"><i class="fa-solid fa-magnifying-glass"></i></button>
                <button type="button" class="quote-reset-btn" title="Reset" aria-label="重置"><i class="fa-solid fa-rotate-left"></i></button>
            </div>
            <div class="quote-select-box${isCurrent ? '' : ' is-filter'}">
                ${isCurrent ? '' : '<span class="quote-filter-label">char</span>'}
                <select class="${isCurrent ? 'quote-sort-select' : 'quote-filter-select'}" aria-label="${isCurrent ? '排序' : '按角色筛选'}">
                    ${selectHtml}
                </select>
            </div>
        `;

        const input = toolbar.querySelector('.quote-search-input');
        const searchBtn = toolbar.querySelector('.quote-search-btn');
        const resetBtn = toolbar.querySelector('.quote-reset-btn');
        const select = toolbar.querySelector('select');
        const filterLabel = toolbar.querySelector('.quote-filter-label');

        if (!isCurrent) {
            chars.forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                // 下拉弹窗里保留完整名字；收起时靠 3 字宽的框自然截断
                option.textContent = name;
                option.title = name;
                select.appendChild(option);
            });
        }

        const updateSelectTitle = () => {
            const option = select.options[select.selectedIndex];
            const fullName = option?.title || option?.textContent || '';
            select.title = fullName;
            if (filterLabel) {
                filterLabel.textContent = option?.value ? getCharacterFilterLabel(fullName) : 'char';
            }
        };

        input.value = state.search || '';
        if (isCurrent) {
            select.value = state.sort;
        } else {
            select.value = state.char || '';
            if (select.value !== (state.char || '')) {
                state.char = '';
                select.value = '';
            }
        }
        updateSelectTitle();

        const applySearch = () => {
            clearTimeout(quoteSearchTimer);
            state.search = input.value;
            renderQuoteResults(true);
        };

        input.addEventListener('input', () => {
            state.search = input.value;
            clearTimeout(quoteSearchTimer);
            quoteSearchTimer = setTimeout(() => renderQuoteResults(true), 140);
        });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            applySearch();
        });
        searchBtn.addEventListener('click', applySearch);
        resetBtn.addEventListener('click', () => {
            clearTimeout(quoteSearchTimer);
            input.value = '';
            state.search = '';
            if (!isCurrent) {
                state.char = '';
                select.value = '';
                updateSelectTitle();
            }
            renderQuoteResults(true);
        });
        select.addEventListener('change', () => {
            if (isCurrent) state.sort = select.value;
            else state.char = select.value;
            updateSelectTitle();
            renderQuoteResults(true);
        });
    }

    function renderQuotes(force = false) {
        const list = document.getElementById('quote-list');
        if (!list) return;

        // 面板没开时不必浪费帧去建卡片；等下次打开时再按需渲染。
        if (!force && !overlay.classList.contains('show')) return;

        const ctx = getChatContext();
        const chatInfo = getCurrentChatInfo();
        ensureChatHydrated(chatInfo, ctx);

        if (activeQuoteTab === 'current') {
            quotePanelData.currentQuotes = chatInfo.active
                ? [...savedQuotes].reverse().filter(quote => quoteBelongsToChat(quote, chatInfo, ctx))
                : [];

            // 换聊天后，搜索词还留着会让人以为聊天里没书签；这里清掉搜索，排序保留。
            if (chatInfo.active && quotePanelData.toolbarChatKey !== chatInfo.key) {
                quotePanelData.toolbarChatKey = chatInfo.key;
                quotePanelFilters.current.search = '';
                quotePanelData.toolbarTab = '';
            }

            renderQuoteToolbar('current', [], chatInfo.active && quotePanelData.currentQuotes.length > 0);
            renderQuoteResults(true);
            return;
        }

        // 按聊天分组；倒序遍历，让最近收录的聊天和句子排在最前。
        const liveIndex = getLiveChatNameIndex();
        const groups = new Map();

        for (let index = savedQuotes.length - 1; index >= 0; index--) {
            const quote = savedQuotes[index];
            const chat = getQuoteChatInfo(quote, { current: chatInfo, liveIndex });
            let group = groups.get(chat.key);
            if (!group) {
                group = { key: chat.key, chat: chat, quotes: [] };
                groups.set(chat.key, group);
            }
            group.quotes.push(quote);
        }

        // 清理已经不存在的分组展开状态，避免新收藏的聊天组意外继承旧状态
        [...expandedQuoteGroups].forEach(key => {
            if (!groups.has(key)) expandedQuoteGroups.delete(key);
        });

        quotePanelData.allGroups = [...groups.values()];

        const chars = getQuoteCharacterNames(quotePanelData.allGroups);
        if (quotePanelFilters.all.char && !chars.includes(quotePanelFilters.all.char)) {
            quotePanelFilters.all.char = '';
        }

        renderQuoteToolbar('all', chars, quotePanelData.allGroups.length > 0);
        renderQuoteResults(true);
    }

    let chatScrollAnchorTimer = 0;
    let chatOriginalOverflowAnchor = null;
    let chatScrollToken = 0;

    function getChatTargetTop(chat, target) {
        const chatRect = chat.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const viewport = chat.clientHeight;
        const messageTop = chat.scrollTop + (targetRect.top - chatRect.top);
        const messageHeight = targetRect.height;
        const margin = 16;
        const desired = messageHeight > viewport * 0.7
            ? messageTop - margin
            : messageTop - Math.max(margin, (viewport - messageHeight) / 2);
        const maxTop = Math.max(0, chat.scrollHeight - viewport);
        return Math.min(maxTop, Math.max(0, desired));
    }

    // 长文本楼层可能比整个视口还高，scrollIntoView({block:'center'}) 会把
    // 它的中段对到屏幕中央，看起来就像“没跳过去”。这里直接算 #chat 内的偏移：
    // 矮楼层居中，高楼层顶部对齐，并临时关掉滚动锚定，避免长正文把平滑滚动拽回去。
    function scrollChatToMessage(target) {
        const chat = document.getElementById('chat');
        if (!chat || !target?.isConnected) {
            try { target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); } catch (error) { /* 忽略 */ }
            return;
        }

        const top = getChatTargetTop(chat, target);
        const token = ++chatScrollToken;

        clearTimeout(chatScrollAnchorTimer);
        if (chatOriginalOverflowAnchor === null) {
            chatOriginalOverflowAnchor = chat.style.overflowAnchor;
        }
        chat.style.overflowAnchor = 'none';

        try {
            if (typeof chat.scrollTo === 'function') {
                chat.scrollTo({ top, behavior: 'smooth' });
            } else {
                chat.scrollTop = top;
            }
        } catch (error) {
            chat.scrollTop = top;
        }

        chatScrollAnchorTimer = setTimeout(() => {
            chat.style.overflowAnchor = chatOriginalOverflowAnchor || '';
            chatOriginalOverflowAnchor = null;
        }, 1200);

        // 移动端软键盘/长楼层可能让平滑滚动被取消或目标位置变化；
        // 900ms 后重新量一次，不在视口里就直接补齐。
        setTimeout(() => {
            if (token !== chatScrollToken || !target.isConnected) return;
            const rect = target.getBoundingClientRect();
            const chatNow = chat.getBoundingClientRect();
            const inView = rect.bottom > chatNow.top && rect.top < chatNow.bottom;
            if (!inView) chat.scrollTop = getChatTargetTop(chat, target);
        }, 900);
    }

    function activateQuoteInChat(quote) {
        const mesid = String(quote.mesid ?? '');
        const targetMes = mesid
            ? document.querySelector(`.mes[mesid="${CSS.escape(mesid)}"]`)
            : null;

        // 划词收藏可能来自消息以外的文字（没有楼层号），这时改为打开详情而不是无声失败
        if (!targetMes) {
            showQuoteDetail(quote);
            return;
        }

        closeQuotePanel();

        // 等面板动画结束、DOM 重排完毕后再高亮
        setTimeout(() => {
            scrollChatToMessage(targetMes);
            targetMes.classList.remove('highlight-mes');
            void targetMes.offsetWidth;
            targetMes.classList.add('highlight-mes');

            setTimeout(() => {
                targetMes.classList.remove('highlight-mes');
            }, 2000);
        }, 300);
    }

    function handleQuoteListClick(event) {
        const deleteBtn = event.target.closest('.quote-delete');
        const card = event.target.closest('.quote-card');

        if (deleteBtn) {
            event.preventDefault();
            event.stopPropagation();
            const quote = card ? quoteCardMap.get(card) : null;
            if (quote) deleteQuote(quote, card);
            return;
        }

        const header = event.target.closest('.quote-group-header');
        if (header) {
            const groupEl = header.closest('.quote-group');
            const key = groupEl?.dataset.key;
            if (!groupEl || !key) return;

            const isOpen = groupEl.classList.toggle('is-open');
            if (isOpen) {
                expandedQuoteGroups.add(key);
                const content = groupEl.querySelector('.quote-group-content');
                if (content && !content.dataset.built) {
                    content.dataset.built = '1';
                    const data = panelGroupData.get(key);
                    const list = document.getElementById('quote-list');
                    if (data && list) appendQuoteCardChunk(content, data.quotes, 0, list);
                }
            } else {
                expandedQuoteGroups.delete(key);
            }
            return;
        }

        if (!card) return;

        const quote = quoteCardMap.get(card);
        if (!quote) return;

        if (activeQuoteTab === 'all') {
            showQuoteDetail(quote);
            return;
        }

        activateQuoteInChat(quote);
    }

    function setQuoteTab(tab) {
        activeQuoteTab = tab === 'all' ? 'all' : 'current';
        panel.querySelectorAll('.quote-tab').forEach(button => {
            const isActive = button.getAttribute('data-tab') === activeQuoteTab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', String(isActive));
        });
        clearTimeout(quoteSearchTimer);
        renderQuotes(true);

        const list = document.getElementById('quote-list');
        if (list) list.scrollTop = 0;
    }

    // ==================================================
    // 划词 / 划句收藏
    // 在正文里选中任意一段文字（鼠标拖动或手机长按），选区旁就会浮出一个极简收藏按钮。
    // 收藏时只保存选中的那一段，而不是整层消息。
    // ==================================================

    const SELECTION_IGNORE_SELECTOR = [
        '#quote-fab',
        '#quote-selection-btn',
        '#quote-overlay',
        '#quote-panel',
        '#quote-detail-overlay',
        '#quote-detail-overlay *',
        '.mes_buttons',
        '.mes_avatar',
        '.mes_metadata',
        'input',
        'textarea',
        'select',
        'option',
        '[contenteditable="true"]',
        '.drawer-content',
        '#send_form',
    ].join(', ');

    // ---- 收藏文字的下划线 ----
    const QUOTE_MARK_CLASS = 'quote-underline';
    const QUOTE_MARK_SELECTOR = '.mes_text .quote-underline';

    function normalizeQuoteText(value) {
        return String(value ?? '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 只有“整段划句”的收藏才在正文里画线：整层消息收藏画线只会污染整篇正文
    function getCurrentSelectionQuotes(chatInfo) {
        const info = chatInfo || getCurrentChatInfo();
        if (!info.active) return [];

        return savedQuotes.filter(quote => {
            if (quote.source !== 'selection') return false;
            if (String(quote.chatKey || '') !== String(info.key || '')) return false;
            if (!/^\d+$/.test(String(quote.mesid ?? ''))) return false;
            return normalizeQuoteText(quote.text).length > 0;
        });
    }

    // 同一条划句的判据底座：同一楼层 + 同一聊天
    function isSelectionQuoteOfMessage(quote, payload, chatInfo) {
        if (!quote || quote.source !== 'selection') return false;

        const mesid = String(payload?.mes?.getAttribute('mesid') ?? '').trim();
        if (String(quote.mesid ?? '') !== mesid) return false;
        if (quote.chatKey && chatInfo?.key && String(quote.chatKey) !== String(chatInfo.key)) return false;

        return true;
    }

    // 已归一化的收藏正文缓存：判断重复时不再把同一条长句反复压缩空格。
    const quoteTextNormCache = new WeakMap();

    function getNormalizedQuoteText(quote) {
        if (!quote || typeof quote !== 'object') return '';
        const text = String(quote.text ?? '');
        const cached = quoteTextNormCache.get(quote);
        if (cached && cached.text === text) return cached.norm;

        const norm = normalizeQuoteText(text);
        quoteTextNormCache.set(quote, { text, norm });
        return norm;
    }

    // 只取“同一楼层”的收藏来判重：不再拿全场几千条收藏逐条比。
    function getSelectionCandidates(payload, chatInfo) {
        if (!payload || !chatInfo?.active) return [];

        const mesid = String(payload.mes?.getAttribute('mesid') ?? '').trim();
        if (!/^\d+$/.test(mesid)) return [];

        const index = getQuoteIndexForChat(chatInfo, getChatContext());
        const entry = index.byMesid.get(mesid);
        const exact = entry ? entry.selections : [];
        if (!index.looseSelections.length) return exact;

        // 老数据没有 chatKey：数量通常很少，这里才做文本兜底
        const loose = index.looseSelections.filter(quote => String(quote.mesid ?? '') === mesid);
        return loose.length ? [...exact, ...loose] : exact;
    }

    // 完全同一句（空白差异不算不同）—— 只用于「再点一次取消收录」
    function isSameSelectionQuote(quote, payload, chatInfo) {
        if (!isSelectionQuoteOfMessage(quote, payload, chatInfo)) return false;
        return getNormalizedQuoteText(quote) === normalizeQuoteText(payload?.text);
    }

    function findSelectionMatches(payload, chatInfo) {
        return getSelectionCandidates(payload, chatInfo)
            .filter(quote => isSameSelectionQuote(quote, payload, chatInfo));
    }

    // 已收藏的更长语录里已经包含了这次选中的片段 → 不允许再存一条短的
    function findContainingQuotes(payload, chatInfo) {
        const selection = normalizeQuoteText(payload?.text);
        if (!selection) return [];

        return getSelectionCandidates(payload, chatInfo).filter(quote => {
            if (!isSelectionQuoteOfMessage(quote, payload, chatInfo)) return false;
            const stored = getNormalizedQuoteText(quote);
            return stored.length > selection.length && stored.includes(selection);
        });
    }

    // 这次选区比已收藏的短句更长，并且完整包含了它 → 应该升级成这条长句
    function findContainedQuotes(payload, chatInfo) {
        const selection = normalizeQuoteText(payload?.text);
        if (!selection) return [];

        const candidates = getSelectionCandidates(payload, chatInfo);
        return candidates.filter(quote => {
            if (!isSelectionQuoteOfMessage(quote, payload, chatInfo)) return false;
            const stored = getNormalizedQuoteText(quote);
            return stored.length > 0 && stored.length < selection.length && selection.includes(stored);
        });
    }

    function escapeRegExp(value) {
        return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // 把正文里的文本节点串成一条字符串，同时记住每个节点对应的区间
    function buildMessageTextMap(container) {
        const nodes = [];
        let text = '';

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                // 已经画过线的段落不再参与匹配，避免反复套娃；脚本、按钮栏也不看
                if (parent.closest(`script, style, .mes_buttons, .${QUOTE_MARK_CLASS}`)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });

        let node = walker.nextNode();
        while (node) {
            const value = String(node.nodeValue).replace(/\u00a0/g, ' ');
            nodes.push({ node, start: text.length, end: text.length + value.length });
            text += value;
            node = walker.nextNode();
        }

        return { text, nodes };
    }

    function buildCompactIndex(text) {
        const index = [];
        let compact = '';
        for (let i = 0; i < text.length; i++) {
            if (/\s/.test(text[i])) continue;
            compact += text[i];
            index.push(i);
        }
        return { compact, index };
    }

    // 在正文里定位收藏文字：空白按 \s+ 容错（换行、缩进、选区补出的空白都能对上）
    function findQuoteTextRange(map, rawText) {
        if (!map?.text) return null;

        const normalized = normalizeQuoteText(rawText);
        if (!normalized) return null;

        const pattern = normalized.split(/\s+/).map(escapeRegExp).join('\\s+');
        try {
            const match = new RegExp(pattern).exec(map.text);
            if (match) return { start: match.index, end: match.index + match[0].length };
        } catch (error) {
            // 忽略：退回下面的去空白匹配
        }

        // 兜底：DOM 里没有空白（跨 <br>、跨块元素）时，按“去掉空白”再比一次
        const { compact, index } = buildCompactIndex(map.text);
        const bare = normalized.replace(/\s+/g, '');
        if (!bare || !compact) return null;

        const at = compact.indexOf(bare);
        if (at < 0) return null;
        return { start: index[at], end: index[at + bare.length - 1] + 1 };
    }

    function wrapQuoteTextRange(map, start, end, key) {
        if (!map?.nodes?.length || !(end > start)) return;

        const segments = [];
        map.nodes.forEach(entry => {
            const from = Math.max(start, entry.start);
            const to = Math.min(end, entry.end);
            if (to <= from) return;
            segments.push({ node: entry.node, from: from - entry.start, to: to - entry.start });
        });

        segments.forEach(({ node, from, to }) => {
            if (!node.parentNode) return;

            let target = node;
            if (from > 0) target = target.splitText(from);

            const length = to - from;
            if (length > 0 && length < target.nodeValue.length) target.splitText(length);

            const mark = document.createElement('span');
            mark.className = QUOTE_MARK_CLASS;
            mark.setAttribute('data-quote-key', key);
            target.parentNode.insertBefore(mark, target);
            mark.appendChild(target);
        });
    }

    function unwrapQuoteMark(mark, options = {}) {
        const parent = mark?.parentNode;
        if (!parent) return;

        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        if (options.normalize !== false) parent.normalize();
    }

    // ==================================================
    // 正文下划线：优先用浏览器原生 Highlight（零 DOM 节点）
    // --------------------------------------------------
    // 支持 CSS Custom Highlight API 的浏览器（Edge / Chrome 105+ / Safari 17.2+）：
    // 把 Range 注册给浏览器，下划线由浏览器自己画。正文里一个 span 都不多，
    // 不触发重排、不触发 MutationObserver，划多少条都不会拖慢滚动。
    // 老浏览器自动退回“span 包裹”方案，同样只在消息进入视野时处理。
    // ==================================================

    const HIGHLIGHT_NAME = 'st-archive-quote';

    let highlightMode = false;
    let highlightRegistry = null;
    let highlightRangesByMesid = new Map();
    let underlineWriteDepth = 0;
    let underlineWriteAll = false;
    const underlineWriteRoots = new Set();

    try {
        if (typeof Highlight === 'function'
            && typeof CSS !== 'undefined'
            && CSS.highlights
            && typeof CSS.highlights.set === 'function') {
            highlightRegistry = new Highlight();
            CSS.highlights.set(HIGHLIGHT_NAME, highlightRegistry);
            highlightMode = true;
        }
    } catch (error) {
        highlightMode = false;
        highlightRegistry = null;
    }

    if (!highlightMode) {
        console.info('[ST-档案馆] 当前浏览器不支持 CSS Highlight，已回退到普通下划线模式');
    }

    function withUnderlineWrite(callback, mes = null, all = false) {
        underlineWriteDepth++;
        if (mes) underlineWriteRoots.add(mes);
        if (all) underlineWriteAll = true;

        try {
            return callback();
        } finally {
            // MutationObserver 的回调是微任务，排在这个微任务前面，能看到写入标记
            queueMicrotask(() => {
                underlineWriteDepth = Math.max(0, underlineWriteDepth - 1);
                if (mes) underlineWriteRoots.delete(mes);
                if (all) underlineWriteAll = false;
            });
        }
    }

    // 这一条 DOM 变化是不是“我们自己补下划线”造成的？
    // 只忽略自己改的那条消息，同一批里酒馆真正的更新照常处理，不会漏。
    function isOwnUnderlineMutation(record) {
        if (underlineWriteDepth <= 0) return false;
        if (underlineWriteAll) return true;
        const host = closestMesNode(record.target);
        return Boolean(host && underlineWriteRoots.has(host));
    }

    function startEntryAt(map, offset) {
        const nodes = map.nodes;
        let low = 0;
        let high = nodes.length - 1;
        let best = 0;

        while (low <= high) {
            const mid = (low + high) >> 1;
            if (nodes[mid].start <= offset) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        let entry = nodes[best];
        let index = best;
        while (entry && offset >= entry.end && index + 1 < nodes.length) {
            index++;
            entry = nodes[index];
        }
        return entry;
    }

    function endEntryAt(map, offset) {
        const nodes = map.nodes;
        let low = 0;
        let high = nodes.length - 1;
        let best = -1;

        // 结束位置取“起点严格小于 offset”的那个节点：
        // 这样 offset 刚好落在两个文本节点交界处时，不会把整段线截掉。
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (nodes[mid].start < offset) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return best >= 0 ? nodes[best] : null;
    }

    function createRangeFromOffsets(map, start, end) {
        if (!map?.nodes?.length || !(end > start)) return null;

        const startEntry = startEntryAt(map, start);
        const endEntry = endEntryAt(map, end);
        if (!startEntry || !endEntry) return null;

        const startOffset = Math.max(0, Math.min(start - startEntry.start, startEntry.node.nodeValue.length));
        const endOffset = Math.max(0, Math.min(end - endEntry.start, endEntry.node.nodeValue.length));

        const range = document.createRange();
        try {
            range.setStart(startEntry.node, startOffset);
            range.setEnd(endEntry.node, endOffset);
        } catch (error) {
            return null;
        }
        return range;
    }

    function removeUnderlinesForMessage(mes) {
        const mesid = String(mes.getAttribute('mesid') ?? '').trim();

        if (highlightMode) {
            const ranges = highlightRangesByMesid.get(mesid);
            if (!ranges) return;
            ranges.forEach(record => {
                try { highlightRegistry.delete(record.range); } catch (error) { /* 忽略 */ }
            });
            highlightRangesByMesid.delete(mesid);
            return;
        }

        const container = mes.querySelector('.mes_text');
        if (!container) return;
        const marks = container.querySelectorAll(`.${QUOTE_MARK_CLASS}`);
        if (!marks.length) return;

        withUnderlineWrite(() => {
            marks.forEach(mark => unwrapQuoteMark(mark, { normalize: false }));
            container.normalize();
        }, mes);
    }

    function clearAllUnderlines() {
        if (highlightMode) {
            highlightRangesByMesid.forEach(ranges => {
                ranges.forEach(record => {
                    try { highlightRegistry.delete(record.range); } catch (error) { /* 忽略 */ }
                });
            });
            highlightRangesByMesid = new Map();
            return;
        }

        const marks = document.querySelectorAll(QUOTE_MARK_SELECTOR);
        if (!marks.length) return;

        const containers = new Set();
        withUnderlineWrite(() => {
            marks.forEach(mark => {
                const parent = mark.parentNode;
                if (!parent) return;
                const container = parent.closest?.('.mes_text') || parent;
                if (container instanceof Element) containers.add(container);
                unwrapQuoteMark(mark, { normalize: false });
            });
            containers.forEach(container => container.normalize());
        }, null, true);
    }

    function syncUnderlinesForMessage(mes, quotes) {
        const mesid = String(mes.getAttribute('mesid') ?? '').trim();
        if (!mesid) return;

        const wanted = new Map();
        quotes.forEach(quote => {
            const key = archiveQuoteKey(quote);
            if (key && !wanted.has(key)) wanted.set(key, quote);
        });

        if (highlightMode) {
            syncHighlightRanges(mes, mesid, wanted);
            return;
        }

        const container = mes.querySelector('.mes_text');
        if (!container) return;

        withUnderlineWrite(() => {
            // 1) 先拆掉不应存在的线 / 重复的线
            const seen = new Set();
            container.querySelectorAll(`.${QUOTE_MARK_CLASS}`).forEach(mark => {
                const key = mark.getAttribute('data-quote-key') || '';
                if (!wanted.has(key) || seen.has(key)) {
                    unwrapQuoteMark(mark, { normalize: false });
                } else {
                    seen.add(key);
                }
            });

            const missing = [];
            wanted.forEach((quote, key) => {
                if (!seen.has(key)) missing.push({ key, quote });
            });

            // 2) 一次性把正文串成文本，再把所有区间找出来，从后往前包 span。
            //    这样一条消息只扫一遍，不会“一条收藏扫一遍”。
            if (missing.length) {
                const map = buildMessageTextMap(container);
                const found = [];

                missing.forEach(({ key, quote }) => {
                    const range = findQuoteTextRange(map, quote.text);
                    if (range) found.push({ key, start: range.start, end: range.end });
                });

                found.sort((a, b) => b.start - a.start);
                found.forEach(range => wrapQuoteTextRange(map, range.start, range.end, range.key));
            }

            // 3) 整条消息只 normalize 一次（旧版每条线都 normalize 一次，数量一多就是平方级）
            container.normalize();
        }, mes);
    }

    function syncHighlightRanges(mes, mesid, wanted) {
        const container = mes.querySelector('.mes_text');
        if (!container) {
            removeUnderlinesForMessage(mes);
            return;
        }

        let ranges = highlightRangesByMesid.get(mesid);

        // 消息被酒馆重绘过：旧 Range 指向已经消失的节点，全部作废重来
        if (ranges && ranges._container !== container) {
            removeUnderlinesForMessage(mes);
            ranges = null;
        }

        if (ranges) {
            ranges.forEach((record, key) => {
                if (wanted.has(key)) return;
                try { highlightRegistry.delete(record.range); } catch (error) { /* 忽略 */ }
                ranges.delete(key);
            });
        }

        if (!wanted.size) {
            if (ranges && !ranges.size) highlightRangesByMesid.delete(mesid);
            return;
        }

        if (!ranges) {
            ranges = new Map();
            ranges._container = container;
            highlightRangesByMesid.set(mesid, ranges);
        }

        let map = null;
        wanted.forEach((quote, key) => {
            if (ranges.has(key)) return;
            if (!map) map = buildMessageTextMap(container);

            const found = findQuoteTextRange(map, quote.text);
            if (!found) return;

            const range = createRangeFromOffsets(map, found.start, found.end);
            if (!range) return;

            try {
                highlightRegistry.add(range);
                ranges.set(key, { range });
            } catch (error) {
                // 跨 shadow root 等极端情况：跳过这一条，不影响其它收藏
            }
        });

        if (!ranges.size) highlightRangesByMesid.delete(mesid);
    }

    // 点划线时反查：这个坐标落在哪一条收藏的 Range 里？
    function findQuoteKeyAtPoint(mesid, node, offset) {
        const ranges = highlightRangesByMesid.get(mesid);
        if (!ranges) return '';

        for (const [key, record] of ranges) {
            try {
                if (record.range.comparePoint(node, offset) === 0) return key;
                // 点在句尾边界时补测前一个字符，避免“明明点到了却没反应”
                if (offset > 0 && record.range.comparePoint(node, offset - 1) === 0) return key;
            } catch (error) {
                // Range 已失效，忽略
            }
        }
        return '';
    }

    function selectQuoteRange(range) {
        try {
            const selection = window.getSelection();
            if (!selection) return;
            selection.removeAllRanges();
            selection.addRange(range.cloneRange());
        } catch (error) {
            console.warn('[ST-档案馆] 选中已收藏句子失败', error);
        }
    }

    // 兼容旧调用：只在需要时重算可见消息，不再做全场扫描。
    function applyQuoteUnderlines() {
        visibleMessages.forEach(mes => {
            if (mes.isConnected) scheduleMessageSync(mes);
        });
    }

    const selectionBtn = document.createElement('div');
    selectionBtn.id = 'quote-selection-btn';
    selectionBtn.title = '收录选中文字';
    selectionBtn.setAttribute('role', 'button');
    selectionBtn.setAttribute('aria-label', '收录选中文字');
    selectionBtn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
    document.body.appendChild(selectionBtn);

    let selectionPayload = null;
    let selectionCheckTimer = 0;

    function isIgnoredSelectionNode(node) {
        const el = node?.nodeType === 1 ? node : node?.parentElement;
        if (!el) return true;
        try {
            return Boolean(el.closest(SELECTION_IGNORE_SELECTOR));
        } catch (error) {
            return true;
        }
    }

    function findMessageForNode(node) {
        const el = node?.nodeType === 1 ? node : node?.parentElement;
        if (!el) return null;

        const mes = el.closest('.mes');
        if (!mes) return null;
        if (mes.closest('.template_element') || mes.closest('#message_template')) return null;
        if (!mes.isConnected) return null;
        return mes;
    }

    function captureSelection() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

        if (isIgnoredSelectionNode(selection.anchorNode) || isIgnoredSelectionNode(selection.focusNode)) {
            return null;
        }

        const text = String(selection.toString() || '').replace(/\u00a0/g, ' ').trim();
        if (!text) return null;

        let rect = null;
        try {
            const range = selection.getRangeAt(0);
            const rects = Array.from(range.getClientRects()).filter(item => item.width > 0 || item.height > 0);
            const box = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
            if (box && (box.width > 0 || box.height > 0)) {
                rect = { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
            }
        } catch (error) {
            console.warn('[ST-档案馆] 解析选区位置失败', error);
        }

        // 手机长按选词时有时拿不到 client rect，退回选区焦点所在的元素
        if (!rect) {
            const anchorEl = selection.focusNode?.nodeType === 1
                ? selection.focusNode
                : selection.focusNode?.parentElement;
            const box = anchorEl?.getBoundingClientRect?.();
            if (box && (box.width > 0 || box.height > 0)) {
                rect = { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
            }
        }

        if (!rect) return null;

        return {
            text,
            rect,
            mes: findMessageForNode(selection.anchorNode) || findMessageForNode(selection.focusNode),
        };
    }

    function placeSelectionBtn(rect) {
        const size = 34;
        const margin = 8;
        // 选区 client rect 与 position: fixed 都以布局视口为基准，这里直接用 innerWidth/innerHeight，
        // 不要混用 visualViewport 的宽高（双指缩放时会错位）
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        if (!viewportWidth || !viewportHeight) return;

        let left = rect.left + (rect.width / 2) - (size / 2);
        let top = rect.bottom + margin;

        // 下面放不下就翻到选区上方，永远不出屏幕
        if (top + size > viewportHeight - margin) top = rect.top - size - margin;

        left = Math.min(Math.max(left, margin), viewportWidth - size - margin);
        top = Math.min(Math.max(top, margin), viewportHeight - size - margin);

        selectionBtn.style.left = `${Math.round(left)}px`;
        selectionBtn.style.top = `${Math.round(top)}px`;
    }

    function showSelectionBtn(payload) {
        if (!payload) {
            hideSelectionBtn({ clear: true });
            return;
        }

        selectionPayload = payload;
        placeSelectionBtn(payload.rect);

        // 四种状态：全新收藏 / 升级更长 / 已包含在更长收藏里 / 已收过（再点取消）
        const chatInfo = getCurrentChatInfo();
        const exact = findSelectionMatches(payload, chatInfo).length > 0;
        const covering = exact ? [] : findContainingQuotes(payload, chatInfo);
        const expanding = (exact || covering.length) ? [] : findContainedQuotes(payload, chatInfo);

        let title = '收录选中文字';
        let icon = '<i class="fa-regular fa-bookmark"></i>';

        if (exact) {
            title = '取消收录';
            icon = '<i class="fa-solid fa-bookmark"></i>';
        } else if (covering.length > 0) {
            // 只是已收藏长句的一小段：不能再存一条，按钮保持实心以示“已收录”
            title = '已收录更长版本';
            icon = '<i class="fa-solid fa-bookmark"></i>';
        } else if (expanding.length > 0) {
            title = '升级为更长收藏';
        }

        selectionBtn.classList.toggle('saved', exact || covering.length > 0);
        selectionBtn.classList.toggle('covered', covering.length > 0);
        selectionBtn.classList.toggle('expand', expanding.length > 0);
        selectionBtn.title = title;
        selectionBtn.setAttribute('aria-label', title);
        selectionBtn.innerHTML = icon;
        selectionBtn.classList.add('show');
    }

    // 只负责把按钮藏起来；截获的选区文字先留着，
    // 因为触屏点按钮时浏览器会先清空选区，清空过早会让最后一次点击落空。
    function hideSelectionBtn(options = {}) {
        const clear = options && options.clear === true;
        selectionBtn.classList.remove('show');
        if (clear) selectionPayload = null;
    }

    function isQuoteUiVisible() {
        return isQuoteDetailOpen() || overlay.classList.contains('show');
    }

    function scheduleSelectionCheck(delay) {
        clearTimeout(selectionCheckTimer);
        selectionCheckTimer = setTimeout(() => {
            if (isQuoteUiVisible()) {
                hideSelectionBtn({ clear: true });
                return;
            }
            showSelectionBtn(captureSelection());
        }, delay);
    }

    function clearSelection() {
        try {
            window.getSelection()?.removeAllRanges();
        } catch (error) {
            // 忽略：部分内嵌浏览器不支持 removeAllRanges
        }
    }

    function syncSelectionMessage(mes) {
        if (mes) scheduleMessageSync(mes);
        else refreshAllSynced();
    }

    function commitSelectionQuote() {
        const payload = selectionPayload;
        if (!payload) return;

        const chatInfo = getCurrentChatInfo();
        const mes = payload.mes;

        // 这一句之前已经收过：再点一次就是取消收录（需求里“再次选择这句话取消收藏”）
        const matches = findSelectionMatches(payload, chatInfo);
        if (matches.length > 0) {
            savedQuotes = savedQuotes.filter(quote => !matches.includes(quote));
            saveQuotes();
            renderQuotes();
            syncSelectionMessage(mes);

            showArchiveToast('info', '已取消收录');
            hideSelectionBtn({ clear: true });
            clearSelection();
            return;
        }

        // 这次选得比上次长，并且完整包含了已存的短句：把那条升级成这条长句，
        // 不新增重复条目（多条被包含的短句一起并进来）
        const contained = findContainedQuotes(payload, chatInfo);
        if (contained.length > 0) {
            const keep = contained[0];
            const merged = new Set(contained.slice(1));

            savedQuotes = savedQuotes.filter(quote => !merged.has(quote));
            keep.text = payload.text;
            keep.time = new Date().toLocaleString();
            keep.createdAt = Date.now();
            if (!keep.chatKey && chatInfo.key) keep.chatKey = chatInfo.key;
            if (!keep.chatName && chatInfo.chatName) keep.chatName = chatInfo.chatName;

            saveQuotes();
            renderQuotes();
            syncSelectionMessage(mes);

            showArchiveToast('success', `已升级为更长的一段（${payload.text.length} 字）`);
            hideSelectionBtn({ clear: true });
            clearSelection();
            return;
        }

        // 这次只是已收藏长句里的一小段：禁止重复添加
        const covering = findContainingQuotes(payload, chatInfo);
        if (covering.length > 0) {
            showArchiveToast('info', '这段已包含在已收录的句子里');
            hideSelectionBtn({ clear: true });
            clearSelection();
            return;
        }

        const mesid = String(mes?.getAttribute('mesid') ?? '').trim();
        const nameEl = mes?.querySelector('.ch_name .name_text');
        const charName = normalizeCharName(
            (nameEl?.textContent || mes?.getAttribute('ch_name') || chatInfo.charName || '未知角色').trim()
        );

        const targetText = normalizeForCompare(payload.text);
        // 只在“同一楼层”的候选里判重，不再把全场收藏扫一遍
        const duplicate = getSelectionCandidates(payload, chatInfo).some(quote => (
            String(quote.mesid ?? '') === mesid
            && String(quote.chatKey ?? '') === String(chatInfo.key ?? '')
            && normalizeForCompare(quote.text) === targetText
        ));

        if (duplicate) {
            showArchiveToast('info', '这段文字已经收录过了');
            hideSelectionBtn({ clear: true });
            clearSelection();
            return;
        }

        savedQuotes.push({
            mesid,
            char: charName,
            text: payload.text,
            time: new Date().toLocaleString(),
            createdAt: Date.now(),
            chatKey: chatInfo.key || '',
            chatName: chatInfo.chatName || '',
            chatChar: chatInfo.charName || charName,
            scope: chatInfo.scope || '',
            source: 'selection',
        });

        saveQuotes();
        renderQuotes();
        syncSelectionMessage(mes);

        showArchiveToast('success', `已收录 ${payload.text.length} 字`);
        hideSelectionBtn({ clear: true });
        clearSelection();
    }

    document.addEventListener('mouseup', (event) => {
        if (event.target?.closest?.('#quote-selection-btn')) return;
        // 等浏览器把选区落定后再取，否则拿到的是上一帧的空选区
        scheduleSelectionCheck(10);
    });

    document.addEventListener('touchend', (event) => {
        if (event.target?.closest?.('#quote-selection-btn')) return;
        scheduleSelectionCheck(90);
    });

    // 右键时如果已经有选区，也把按钮放出来（原生菜单不受影响）
    document.addEventListener('contextmenu', (event) => {
        if (event.target?.closest?.('#quote-selection-btn')) return;
        scheduleSelectionCheck(10);
    });

    document.addEventListener('selectionchange', () => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) {
            hideSelectionBtn();
            return;
        }

        // 手机上拖动选区手柄时没有 mouseup/touchend，按钮要跟着选区重新贴位
        if (!selectionBtn.classList.contains('show')) return;
        clearTimeout(selectionCheckTimer);
        selectionCheckTimer = setTimeout(() => {
            if (isQuoteUiVisible()) {
                hideSelectionBtn({ clear: true });
                return;
            }
            const payload = captureSelection();
            if (payload) showSelectionBtn(payload);
        }, 80);
    });

    document.addEventListener('mousedown', (event) => {
        if (event.target?.closest?.('#quote-selection-btn')) return;
        hideSelectionBtn({ clear: true });
    });

    // 滚动时按钮跟着选区走，而不是直接消失（手机上选区常伴随小幅滚动）
    let selectionScrollTimer = 0;
    document.addEventListener('scroll', () => {
        if (!selectionBtn.classList.contains('show')) return;
        clearTimeout(selectionScrollTimer);
        selectionScrollTimer = setTimeout(() => {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed) {
                hideSelectionBtn({ clear: true });
                return;
            }
            showSelectionBtn(captureSelection());
        }, 120);
    }, true);

    window.addEventListener('resize', () => hideSelectionBtn({ clear: true }));
    window.addEventListener('orientationchange', () => hideSelectionBtn({ clear: true }));

    // 鼠标按下按钮时不要丢掉选区；触屏的选区清空无所谓，文字已经存在 payload 里
    selectionBtn.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse') event.preventDefault();
        event.stopPropagation();
    });

    selectionBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        commitSelectionQuote();
    });

    // 点一下已划线的句子：只把它选起来，交给悬浮书签做二次确认，绝不直接删除。
    // 用捕获阶段接管，避免这一下点击被消息层的其它事件吃掉。
    function caretFromPoint(event) {
        try {
            if (typeof document.caretRangeFromPoint === 'function') {
                return document.caretRangeFromPoint(event.clientX, event.clientY);
            }
            if (typeof document.caretPositionFromPoint === 'function') {
                const position = document.caretPositionFromPoint(event.clientX, event.clientY);
                if (!position) return null;
                return { startContainer: position.offsetNode, startOffset: position.offset };
            }
        } catch (error) {
            // 忽略：坐标可能落在不可放置光标的位置
        }
        return null;
    }

    document.addEventListener('click', (event) => {
        // 新版：正文里没有 span，按“点击坐标落在哪个 Range 里”反查。
        // 这样既能点划线选中，又不需要往正文塞任何节点。
        if (highlightMode) {
            if (typeof event.button === 'number' && event.button !== 0) return;

            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('a, button, input, textarea, select, .mes_buttons, #quote-fab, #quote-selection-btn, #quote-overlay, #quote-detail-overlay')) {
                return;
            }

            const textEl = target.closest('.mes_text');
            if (!textEl) return;

            const mes = textEl.closest('.mes');
            const mesid = String(mes?.getAttribute('mesid') ?? '').trim();
            if (!mesid) return;

            const caret = caretFromPoint(event);
            if (!caret || !textEl.contains(caret.startContainer)) return;

            const key = findQuoteKeyAtPoint(mesid, caret.startContainer, caret.startOffset);
            if (!key) return;

            const record = highlightRangesByMesid.get(mesid)?.get(key);
            if (!record) return;

            event.preventDefault();
            event.stopPropagation();
            selectQuoteRange(record.range);
            scheduleSelectionCheck(20);
            return;
        }

        // 旧浏览器回退路径：正文里是真正的 span，直接找最近的划线节点。
        const mark = event.target?.closest?.('.mes_text .quote-underline');
        if (!mark) return;

        event.preventDefault();
        event.stopPropagation();

        try {
            // 一条收藏可能被拆成多个 span（跨段落时每个文本节点一段），
            // 点任意一段都要选中整句，而不是只选中这一小截。
            const key = mark.getAttribute('data-quote-key') || '';
            const marks = key
                ? Array.from(document.querySelectorAll(`.mes_text .quote-underline[data-quote-key="${CSS.escape(key)}"]`))
                : [mark];
            const list = marks.length ? marks : [mark];

            const first = list[0];
            const last = list[list.length - 1];
            const startNode = first.firstChild;
            const endNode = last.lastChild;

            const range = document.createRange();
            if (startNode && endNode) {
                range.setStart(startNode, 0);
                range.setEnd(endNode, endNode.nodeType === 3 ? endNode.nodeValue.length : endNode.childNodes.length);
            } else {
                range.selectNodeContents(first);
            }

            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        } catch (error) {
            console.warn('[ST-档案馆] 选中已收藏句子失败', error);
            return;
        }

        // mousedown/mouseup 会先把按钮藏起来，这一轮事件收尾后再把它摆出来
        scheduleSelectionCheck(20);
    }, true);

    // 4. 全局事件委托（确保点击生效）
    document.body.addEventListener('click', (e) => {
        const btn = e.target.closest('.mes-bookmark-btn');
        if (!btn) return;

        const mes = btn.closest('.mes');
        if (!mes || mes.closest('.template_element') || mes.closest('#message_template')) return;

        const mesid = mes.getAttribute('mesid');
        if (mesid === null || mesid === '') return;

        e.preventDefault();
        e.stopPropagation();

        // 不信任按钮上可能残留的模板属性，点击时从所在楼层重新解析
        const nameEl = mes.querySelector('.ch_name .name_text');
        const charName = normalizeCharName(
            (nameEl?.textContent || mes.getAttribute('ch_name') || '未知角色').trim()
        );
        btn.setAttribute('data-mesid', mesid);
        btn.setAttribute('data-char', charName);

        const ctx = getChatContext();
        const chatInfo = getCurrentChatInfo();
        const isSaved = isMessageBookmarked(mesid, chatInfo, ctx);

        if (isSaved) {
            savedQuotes = savedQuotes.filter(q => !(
                isWholeMessageQuote(q) &&
                String(q.mesid) === String(mesid) &&
                (q.chatKey ? q.chatKey === chatInfo.key : q.char === charName)
            ));
            btn.classList.remove('saved');
            btn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
        } else {
            const textEl = mes.querySelector('.mes_text');
            let rawText = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';

            // 某些系统消息/自定义 UI 楼层没有可读的 .mes_text，退回真实消息数据
            if (!rawText) {
                const message = ctx?.chat?.[Number(mesid)];
                rawText = String(message?.mes || '')
                    .replace(/<[^>]*>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            }

            if (!rawText) rawText = '（未获取到正文）';

            savedQuotes.push({
                mesid: mesid,
                char: charName,
                text: rawText,
                time: new Date().toLocaleString(),
                createdAt: Date.now(),
                chatKey: chatInfo.key || '',
                chatName: chatInfo.chatName || '',
                chatChar: chatInfo.charName || charName,
                scope: chatInfo.scope || '',
            });
            btn.classList.add('saved');
            btn.innerHTML = '<i class="fa-solid fa-bookmark"></i>';
        }

        saveQuotes();
        renderQuotes();
        scheduleMessageSync(mes);
    });

    // 5. 悬浮窗事件
    fab.addEventListener('click', () => {
        if (overlay.classList.contains('show')) {
            closeQuotePanel();
            return;
        }

        // 打开面板时强制刷新一次最近聊天名字索引，避免别处刚改过名还显示旧名字
        invalidateLiveChatNameCache();
        // 先让面板可见，再渲染：renderQuotes 会跳过“关着的面板”，避免白干活
        overlay.classList.add('show');
        setQuoteTab('current');
    });

    panel.querySelector('.quote-close').addEventListener('click', closeQuotePanel);
    panel.querySelector('.quote-export-btn').addEventListener('click', exportQuotesToFile);
    panel.querySelector('.quote-import-btn').addEventListener('click', () => importFileInput.click());
    panel.querySelectorAll('.quote-tab').forEach(button => {
        button.addEventListener('click', () => setQuoteTab(button.getAttribute('data-tab')));
    });

    // 面板只挂一个点击监听：卡片、删除、分组展开都由它分发。
    // 哪怕面板里已经加载了上千张卡片，也不会多出几千个监听器。
    document.getElementById('quote-list')?.addEventListener('click', handleQuoteListClick);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeQuotePanel();
    });

    detailOverlay.querySelector('.quote-detail-close').addEventListener('click', hideQuoteDetail);
    detailOverlay.addEventListener('click', (event) => {
        if (event.target === detailOverlay) hideQuoteDetail();
    });
    // 原生 <dialog> 被浏览器自己关闭（例如 Esc）时同步清理回退用的 class
    detailOverlay.addEventListener('close', () => {
        detailOverlay.classList.remove('show');
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;

        if (isQuoteDetailOpen()) {
            hideQuoteDetail();
            return;
        }

        if (overlay.classList.contains('show')) closeQuotePanel();
    });

    // 6. 拖拽逻辑（悬浮按钮位置保持设备本地记忆，不参与云端同步）
    (function makeDraggable(el) {
        let isDragging = false, hasMoved = false;
        let startX, startY, initialLeft, initialTop;

        const savedPos = readLocalStorageJson(ARCHIVE_LEGACY_KEYS.fabPos, null);
        if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
            el.style.left = savedPos.left + 'px'; el.style.top = savedPos.top + 'px';
        } else {
            el.style.left = '20px'; el.style.top = '120px';
        }

        const onDrag = (e) => {
            if (!isDragging) return;

            const touch = e.touches && e.touches[0];
            const clientX = e.type.startsWith('mouse') ? e.clientX : touch?.clientX;
            const clientY = e.type.startsWith('mouse') ? e.clientY : touch?.clientY;
            if (clientX === undefined || clientY === undefined) return;

            const dx = clientX - startX;
            const dy = clientY - startY;

            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                hasMoved = true;
                if (e.type === 'touchmove' && e.cancelable) e.preventDefault();
            }

            let newLeft = initialLeft + dx;
            let newTop = initialTop + dy;
            const maxLeft = window.innerWidth - el.offsetWidth;
            const maxTop = window.innerHeight - el.offsetHeight;
            if (newLeft < 0) newLeft = 0;
            if (newLeft > maxLeft) newLeft = maxLeft;
            if (newTop < 0) newTop = 0;
            if (newTop > maxTop) newTop = maxTop;
            el.style.left = newLeft + 'px';
            el.style.top = newTop + 'px';
        };

        const endDrag = () => {
            if (!isDragging) return;
            isDragging = false;

            // 只在拖动期间挂 move 监听。平时 document 上没有任何 touchmove，
            // 手机的滚动就不会被 JS 拦下来等结果——这是移动端不卡的关键之一。
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', endDrag);
            document.removeEventListener('touchmove', onDrag);
            document.removeEventListener('touchend', endDrag);

            if (hasMoved) {
                writeLocalStorageJson(ARCHIVE_LEGACY_KEYS.fabPos, { left: el.offsetLeft, top: el.offsetTop });
            }
        };

        const startDrag = (e) => {
            if (isDragging) return;
            if (e.type === 'mousedown') e.preventDefault();

            const touch = e.touches && e.touches[0];
            const clientX = e.type === 'mousedown' ? e.clientX : touch?.clientX;
            const clientY = e.type === 'mousedown' ? e.clientY : touch?.clientY;
            if (clientX === undefined || clientY === undefined) return;

            isDragging = true;
            hasMoved = false;
            startX = clientX;
            startY = clientY;
            initialLeft = el.offsetLeft;
            initialTop = el.offsetTop;

            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', endDrag);
            document.addEventListener('touchmove', onDrag, { passive: false });
            document.addEventListener('touchend', endDrag);
        };

        el.addEventListener('mousedown', startDrag);
        el.addEventListener('touchstart', startDrag, { passive: false });
        el.addEventListener('click', (e) => {
            if (hasMoved) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                hasMoved = false;
            }
        }, true);
    })(fab);

    // ==================================================
    // 剧情索引（魔杖菜单）
    // --------------------------------------------------
    // 性能要点：
    //   · 打开时只复制 chat 数组引用，不遍历、不预生成几千个节点；
    //   · 固定行高 + 虚拟列表，DOM 里始终只有“当前视口 + 少量缓冲”的几十个气泡；
    //   · 每层楼的 50 字预览也是滚到附近才计算，计算后缓存；
    //   · 滚动监听用 rAF 合并，不会每个 scroll 事件都重排。
    // ==================================================

    const PLOT_ROW_HEIGHT = 64;
    const PLOT_OVERSCAN = 8;
    const PLOT_PREVIEW_LIMIT = 50;
    const PLOT_HIT_MIN_CONTEXT = 3;
    const PLOT_HIT_MAX_LEAD = 16;
    const PLOT_SEARCH_BUDGET_MS = 8;
    const PLOT_SEARCH_BATCH_MAX = 40;

    const plotIndex = {
        overlay: null,
        scroll: null,
        spacer: null,
        windowEl: null,
        empty: null,
        count: null,
        closeBtn: null,
        searchBar: null,
        searchInput: null,
        searchReset: null,
        searchResults: null,
        chat: null,
        cache: new Map(),
        textCache: new Map(),
        searchCache: new Map(),
        lastStart: -1,
        lastEnd: -1,
        frame: 0,
        returnFocus: null,
        search: {
            active: false,
            keyword: '',
            regex: null,
            generation: 0,
            nextIndex: 0,
            matchCount: 0,
            done: true,
            scanning: false,
            scanTimer: 0,
            inputTimer: 0,
            sentinel: null,
            emptyEl: null,
        },
    };

    function injectPlotIndexStyle() {
        if (document.getElementById('plot-index-style')) return;

        const style = document.createElement('style');
        style.id = 'plot-index-style';
        style.textContent = `
            #plot-index-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                width: 100%;
                height: 100%;
                height: 100dvh;
                z-index: 2147483200;
                display: none;
                align-items: stretch;
                justify-content: center;
                overflow: hidden;
                background: rgba(0, 0, 0, 0.3);
                backdrop-filter: blur(3px);
                -webkit-backdrop-filter: blur(3px);
                color: var(--SmartThemeBodyColor);
                font-family: 'Noto Serif SC', 'Songti SC', serif;
                overscroll-behavior: contain;
            }
            #plot-index-overlay.show { display: flex; }

            #plot-index-panel {
                width: 100%;
                height: 100%;
                max-height: 100%;
                display: flex;
                flex-direction: column;
                min-height: 0;
                overflow: hidden;
                background: var(--SmartThemeBlurTintColor, var(--sa-paper, #FDFBF7));
            }

            #plot-index-head {
                flex: 0 0 auto;
                width: min(92vw, 920px);
                margin: 0 auto;
                padding: 18px 28px 12px;
                box-sizing: border-box;
                display: flex; align-items: center; gap: 12px;
                border-bottom: 1px dashed rgba(var(--sa-accent-rgb, 164, 80, 80), 0.3);
                background: rgba(128, 128, 128, 0.08);
                background: color-mix(in srgb, var(--SmartThemeBodyColor) 5%, transparent);
            }
            #plot-index-title {
                flex: 1; min-width: 0;
                font-size: 15px; letter-spacing: 4px;
                color: var(--SmartThemeBodyColor);
                white-space: nowrap;
            }
            #plot-index-count {
                flex-shrink: 0;
                font-family: 'Courier New', Courier, monospace;
                font-size: 10px; letter-spacing: 1px;
                color: rgba(128, 128, 128, 0.9);
                color: color-mix(in srgb, var(--SmartThemeBodyColor) 55%, transparent);
            }
            #plot-index-close {
                appearance: none; -webkit-appearance: none;
                flex-shrink: 0;
                width: 30px; height: 30px; padding: 0;
                border: 0; border-radius: 6px;
                background: transparent;
                color: var(--sa-accent, #a45050);
                font-family: Arial, sans-serif;
                font-size: 22px; line-height: 1;
                cursor: pointer;
                transition: color 0.2s, background 0.2s;
            }
            #plot-index-close:hover { color: var(--sa-accent-deep, #8b3a3a); background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.1); }

            #plot-index-searchbar {
                flex: 0 0 auto;
                width: min(92vw, 920px);
                margin: 0 auto;
                padding: 8px 28px 10px;
                box-sizing: border-box;
            }
            .plot-index-search-box {
                display: flex;
                align-items: center;
                height: 28px;
                border: 0;
                border-bottom: 0.5px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.32);
                background: transparent;
            }
            .plot-index-search-input {
                flex: 1 1 0;
                min-width: 0;
                height: 100%;
                border: 0;
                outline: none;
                background: transparent;
                padding: 0 8px;
                color: var(--SmartThemeBodyColor);
                font-family: 'Courier New', Courier, monospace;
                font-size: 11px;
                letter-spacing: 0.4px;
            }
            .plot-index-search-input::placeholder {
                color: color-mix(in srgb, var(--SmartThemeBodyColor) 30%, transparent);
                font-style: italic;
            }
            .plot-index-search-box:focus-within {
                border-bottom-color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.6);
            }
            .plot-index-search-reset {
                flex: 0 0 auto;
                appearance: none; -webkit-appearance: none;
                height: 100%;
                padding: 0 6px;
                border: 0;
                background: transparent;
                color: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.7);
                font-size: 11px;
                cursor: pointer;
                transition: color 0.2s, background 0.2s;
            }
            .plot-index-search-reset:hover {
                color: var(--sa-accent, #a45050);
                background: transparent;
            }

            #plot-index-scroll {
                flex: 1 1 0;
                min-height: 0;
                overflow-y: auto;
                overscroll-behavior: contain;
                -webkit-overflow-scrolling: touch;
                padding: 8px 0 40px;
            }
            #plot-index-search-results {
                width: min(92vw, 920px);
                margin: 0 auto;
                padding: 4px 0 40px;
            }
            .plot-index-search-row {
                position: relative;
                height: 64px;
                display: flex;
                align-items: center;
                padding: 4px 10px;
                box-sizing: border-box;
            }
            .plot-index-search-row.is-user { justify-content: flex-end; }
            .plot-index-search-more {
                display: block;
                margin: 14px auto 20px;
                padding: 6px 18px;
                border: 1px solid rgba(var(--sa-accent-rgb, 164, 80, 80), 0.3);
                border-radius: 4px;
                background: transparent;
                color: var(--sa-accent, #a45050);
                font-family: 'Courier New', Courier, monospace;
                font-size: 11px;
                letter-spacing: 1px;
                cursor: pointer;
            }
            .plot-index-search-more:hover { background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.08); }
            .plot-index-search-empty {
                margin: 24px auto;
                padding: 12px;
                text-align: center;
                font-size: 13px;
                letter-spacing: 1px;
                color: color-mix(in srgb, var(--SmartThemeBodyColor) 60%, transparent);
            }
            .plot-index-hit {
                color: var(--sa-accent-bright, #b24747);
                background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.16);
                border-radius: 2px;
                padding: 0 1px;
                font-weight: 600;
            }
            #plot-index-spacer {
                position: relative;
                width: min(92vw, 920px);
                margin: 0 auto;
            }
            #plot-index-window {
                position: absolute; left: 0; right: 0; top: 0;
            }

            .plot-index-item {
                position: absolute; left: 0; right: 0;
                height: 64px;
                display: flex; align-items: center;
                padding: 4px 10px;
                box-sizing: border-box;
            }
            .plot-index-item.is-user { justify-content: flex-end; }

            .plot-index-bubble-wrap {
                display: flex;
                align-items: flex-end;
                gap: 6px;
                max-width: 78%;
                min-width: 0;
            }

            .plot-index-bubble {
                position: relative;
                max-width: 100%;
                min-width: 0;
                margin: 0;
                padding: 8px 12px;
                border: 0;
                border-left: 2px solid var(--sa-accent, #a45050);
                border-radius: 6px;
                background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.1);
                background: color-mix(in srgb, var(--SmartThemeBodyColor) 5%, transparent);
                color: var(--SmartThemeBodyColor);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03);
                font-family: inherit;
                font-size: 13px;
                line-height: 1.4;
                text-align: left;
                cursor: pointer;
                overflow: hidden;
                transition: background 0.2s, box-shadow 0.2s;
            }
            .plot-index-text {
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
                overflow-wrap: anywhere;
            }
            .plot-index-floor {
                flex: 0 0 auto;
                align-self: flex-end;
                margin: 0 0 1px;
                font-family: 'Courier New', Courier, monospace;
                font-size: 9px;
                letter-spacing: 0.5px;
                line-height: 1;
                color: rgba(128, 128, 128, 0.9);
                color: color-mix(in srgb, var(--SmartThemeBodyColor) 45%, transparent);
                pointer-events: none;
            }
            .plot-index-item.is-user .plot-index-floor {
                margin: 0 0 1px;
            }
            .plot-index-item.is-user .plot-index-bubble {
                border-left-color: #5f87a6;
                background: rgba(95, 135, 166, 0.12);
                background: color-mix(in srgb, var(--SmartThemeBodyColor) 8%, transparent);
            }
            .plot-index-bubble:hover {
                background: rgba(var(--sa-accent-rgb, 164, 80, 80), 0.16);
                background: color-mix(in srgb, var(--SmartThemeBodyColor) 10%, transparent);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
            }
            .plot-index-item.is-user .plot-index-bubble:hover {
                background: rgba(95, 135, 166, 0.18);
                background: color-mix(in srgb, var(--SmartThemeBodyColor) 12%, transparent);
            }
            .plot-index-item.is-system .plot-index-bubble { font-style: italic; opacity: 0.82; }

            .plot-index-empty {
                margin: auto;
                padding: 0 20px 10vh;
                text-align: center;
                font-size: 13px; line-height: 1.9;
                color: rgba(128, 128, 128, 0.9);
                color: color-mix(in srgb, var(--SmartThemeBodyColor) 60%, transparent);
                letter-spacing: 1px;
            }

            @media (max-width: 560px) {
                #plot-index-head { width: 94vw; padding: 14px 18px 10px; gap: 8px; }
                #plot-index-title { font-size: 13px; letter-spacing: 2px; }
                #plot-index-count { font-size: 9px; }
                #plot-index-searchbar { width: 94vw; padding: 6px 18px 8px; }
                .plot-index-search-input { padding: 0 6px; font-size: 10px; }
                #plot-index-spacer { width: 94vw; }
                #plot-index-search-results { width: 94vw; }
                .plot-index-item { padding: 4px 4px; }
                .plot-index-search-row { padding: 4px 4px; }
                .plot-index-bubble-wrap { max-width: 86%; }
                .plot-index-bubble { font-size: 12px; padding: 7px 10px; }
            }

            body.plot-index-open { overflow: hidden !important; }
        `;
        document.head.appendChild(style);
    }

    function ensurePlotIndexLayer() {
        if (plotIndex.overlay) return plotIndex.overlay;

        injectPlotIndexStyle();

        const overlay = document.createElement('div');
        overlay.id = 'plot-index-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', '剧情索引');
        overlay.innerHTML = `
            <div id="plot-index-panel">
                <div id="plot-index-head">
                    <div id="plot-index-title">剧 情 索 引</div>
                    <div id="plot-index-count"></div>
                    <button type="button" id="plot-index-close" title="关闭" aria-label="关闭">&times;</button>
                </div>
                <div id="plot-index-searchbar">
                    <div class="plot-index-search-box">
                        <input id="plot-index-search-input" class="plot-index-search-input" type="text" placeholder="Search this chat..." aria-label="搜索剧情索引">
                        <button type="button" id="plot-index-search-reset" class="plot-index-search-reset" title="清空搜索" aria-label="清空搜索"><i class="fa-solid fa-rotate-left"></i></button>
                    </div>
                </div>
                <div id="plot-index-scroll">
                    <div id="plot-index-spacer">
                        <div id="plot-index-window"></div>
                    </div>
                    <div id="plot-index-search-results" hidden></div>
                </div>
                <div class="plot-index-empty" id="plot-index-empty" hidden>当前聊天还没有可索引的楼层。</div>
            </div>
        `;
        document.body.appendChild(overlay);

        plotIndex.overlay = overlay;
        plotIndex.scroll = overlay.querySelector('#plot-index-scroll');
        plotIndex.spacer = overlay.querySelector('#plot-index-spacer');
        plotIndex.windowEl = overlay.querySelector('#plot-index-window');
        plotIndex.empty = overlay.querySelector('#plot-index-empty');
        plotIndex.count = overlay.querySelector('#plot-index-count');
        plotIndex.closeBtn = overlay.querySelector('#plot-index-close');
        plotIndex.searchBar = overlay.querySelector('#plot-index-searchbar');
        plotIndex.searchInput = overlay.querySelector('#plot-index-search-input');
        plotIndex.searchReset = overlay.querySelector('#plot-index-search-reset');
        plotIndex.searchResults = overlay.querySelector('#plot-index-search-results');

        plotIndex.closeBtn.addEventListener('click', closePlotIndex);

        plotIndex.searchInput.addEventListener('input', () => {
            const search = plotIndex.search;
            clearTimeout(search.inputTimer);
            search.inputTimer = setTimeout(() => {
                search.inputTimer = 0;
                beginPlotSearch(plotIndex.searchInput.value);
            }, 160);
        });
        plotIndex.searchInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            clearTimeout(plotIndex.search.inputTimer);
            plotIndex.search.inputTimer = 0;
            beginPlotSearch(plotIndex.searchInput.value);
        });
        plotIndex.searchReset.addEventListener('click', () => {
            plotIndex.searchInput.value = '';
            beginPlotSearch('');
            plotIndex.searchInput.focus({ preventScroll: true });
        });

        plotIndex.scroll.addEventListener('scroll', () => {
            if (plotIndex.frame) return;
            plotIndex.frame = requestAnimationFrame(() => {
                plotIndex.frame = 0;
                if (plotIndex.search.active) {
                    if (isSearchNearBottom()) scheduleSearchBatch(0);
                } else {
                    renderPlotWindow();
                }
            });
        }, { passive: true });

        plotIndex.scroll.addEventListener('click', (event) => {
            const bubble = event.target.closest?.('.plot-index-bubble');
            if (!bubble) return;

            const row = bubble.closest('.plot-index-item, .plot-index-search-row');
            const index = Number(row?.dataset.index);
            if (Number.isInteger(index)) jumpToPlotFloor(index);
        });

        window.addEventListener('resize', () => {
            if (overlay.classList.contains('show')) renderPlotWindow(true);
        });
        if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
            window.visualViewport.addEventListener('resize', () => {
                if (overlay.classList.contains('show')) renderPlotWindow(true);
            });
        }

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !overlay.classList.contains('show')) return;
            event.preventDefault();
            closePlotIndex();
        });

        return overlay;
    }

    function stripPlotText(value) {
        let text = String(value ?? '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#0*39;/gi, "'")
            .replace(/\s+/g, ' ')
            .trim();

        return text;
    }

    function readPlotText(index) {
        if (plotIndex.textCache.has(index)) return plotIndex.textCache.get(index);
        return stripPlotText(plotIndex.chat?.[index]?.mes);
    }

    function getPlotText(index) {
        if (plotIndex.textCache.has(index)) return plotIndex.textCache.get(index);
        const text = readPlotText(index);
        plotIndex.textCache.set(index, text);
        return text;
    }

    function getPlotMeta(index) {
        const message = plotIndex.chat?.[index] || {};
        return {
            isUser: Boolean(message.is_user),
            isSystem: Boolean(message.is_system) && !message.is_user,
        };
    }

    function buildDefaultPreview(text) {
        if (!text) {
            return { before: '（空楼层）', hit: '', after: '', leading: false, trailing: false };
        }

        const chars = Array.from(text);
        if (chars.length <= PLOT_PREVIEW_LIMIT) {
            return { before: text, hit: '', after: '', leading: false, trailing: false };
        }

        return {
            before: chars.slice(0, PLOT_PREVIEW_LIMIT).join(''),
            hit: '',
            after: '',
            leading: false,
            trailing: true,
        };
    }

    function getPlotPreview(index) {
        let item = plotIndex.cache.get(index);
        if (item) return item;

        const text = getPlotText(index);
        item = {
            preview: buildDefaultPreview(text),
            ...getPlotMeta(index),
        };
        plotIndex.cache.set(index, item);
        return item;
    }

    // 命中预览：以关键词第一次出现的位置为中心，预算 50 字，
    // 关键词之前最多留 16 字，保证关键词能落在第一行可见区域。
    function buildSearchPreview(text, match) {
        if (!text || !match) return null;

        const matchStart = match.index;
        const matchEnd = matchStart + match[0].length;
        const matchText = match[0];

        if (Array.from(text).length <= PLOT_PREVIEW_LIMIT) {
            return {
                before: text.slice(0, matchStart),
                hit: matchText,
                after: text.slice(matchEnd),
                leading: false,
                trailing: false,
            };
        }

        const matchLength = Array.from(matchText).length;
        const remaining = Math.max(PLOT_HIT_MIN_CONTEXT * 2, PLOT_PREVIEW_LIMIT - matchLength);

        let beforeWant = Math.max(PLOT_HIT_MIN_CONTEXT, Math.floor(remaining / 2));
        beforeWant = Math.min(beforeWant, PLOT_HIT_MAX_LEAD);

        const beforeTake = Math.min(beforeWant, matchStart);
        const afterWant = Math.max(PLOT_HIT_MIN_CONTEXT, remaining - beforeTake);
        const afterTake = Math.min(afterWant, text.length - matchEnd);

        const start = matchStart - beforeTake;
        const end = matchEnd + afterTake;

        return {
            before: text.slice(start, matchStart),
            hit: matchText,
            after: text.slice(matchEnd, end),
            leading: start > 0,
            trailing: end < text.length,
        };
    }

    // 三段分别用 textContent 渲染，消息里带 < > * ` 也不会破坏气泡结构。
    function appendPlotPreview(container, preview) {
        if (preview.leading) container.appendChild(document.createTextNode('…'));
        if (preview.before) container.appendChild(document.createTextNode(preview.before));

        if (preview.hit) {
            const mark = document.createElement('mark');
            mark.className = 'plot-index-hit';
            mark.textContent = preview.hit;
            container.appendChild(mark);
        }

        if (preview.after) container.appendChild(document.createTextNode(preview.after));
        if (preview.trailing) container.appendChild(document.createTextNode('…'));
    }

    function createPlotRow(index, preview, meta, searchMode = false) {
        const row = document.createElement('div');
        row.className = (searchMode ? 'plot-index-search-row' : 'plot-index-item')
            + (meta.isUser ? ' is-user' : '')
            + (meta.isSystem ? ' is-system' : '');
        row.dataset.index = String(index);

        const bubble = document.createElement('button');
        bubble.type = 'button';
        bubble.className = 'plot-index-bubble';
        bubble.title = `第 ${index} 楼`;
        bubble.setAttribute('aria-label', `跳转到第 ${index} 楼`);

        const text = document.createElement('span');
        text.className = 'plot-index-text';
        appendPlotPreview(text, preview);

        const floor = document.createElement('span');
        floor.className = 'plot-index-floor';
        floor.textContent = `#${index}`;

        bubble.appendChild(text);

        const wrap = document.createElement('div');
        wrap.className = 'plot-index-bubble-wrap';

        // 楼层号放气泡外面，并和气泡底边对齐：Char 在右，User 在左
        if (meta.isUser) {
            wrap.appendChild(floor);
            wrap.appendChild(bubble);
        } else {
            wrap.appendChild(bubble);
            wrap.appendChild(floor);
        }
        row.appendChild(wrap);

        return row;
    }

    function renderPlotWindow(force = false) {
        const state = plotIndex;
        if (!state.chat || !state.scroll || state.search.active) return;

        const total = state.chat.length;
        const viewport = state.scroll.clientHeight || window.innerHeight;
        const top = state.scroll.scrollTop;

        const start = Math.max(0, Math.floor(top / PLOT_ROW_HEIGHT) - PLOT_OVERSCAN);
        const end = Math.min(
            total,
            Math.ceil((top + viewport) / PLOT_ROW_HEIGHT) + PLOT_OVERSCAN
        );

        if (!force && start === state.lastStart && end === state.lastEnd) return;

        state.lastStart = start;
        state.lastEnd = end;

        const windowEl = state.windowEl;
        windowEl.style.transform = `translateY(${start * PLOT_ROW_HEIGHT}px)`;
        windowEl.style.height = `${Math.max(0, end - start) * PLOT_ROW_HEIGHT}px`;

        const fragment = document.createDocumentFragment();

        for (let index = start; index < end; index++) {
            const data = getPlotPreview(index);
            const row = createPlotRow(index, data.preview, data, false);
            row.style.top = `${(index - start) * PLOT_ROW_HEIGHT}px`;
            fragment.appendChild(row);
        }

        windowEl.replaceChildren(fragment);
    }

    function removePlotSearchSentinel() {
        const search = plotIndex.search;
        search.sentinel?.remove();
        search.sentinel = null;
    }

    function ensurePlotSearchSentinel() {
        const search = plotIndex.search;
        if (!search.active || search.done || search.sentinel) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'plot-index-search-more';
        button.textContent = '继续搜索…';
        button.addEventListener('click', () => schedulePlotSearchBatch(0));
        plotIndex.searchResults.appendChild(button);
        search.sentinel = button;
    }

    function isSearchNearBottom() {
        const search = plotIndex.search;
        if (!search.active || !search.sentinel?.isConnected) return false;

        const scrollRect = plotIndex.scroll.getBoundingClientRect();
        const sentinelRect = search.sentinel.getBoundingClientRect();
        return sentinelRect.top <= scrollRect.bottom + 420;
    }

    function schedulePlotSearchBatch(delay = 0) {
        const search = plotIndex.search;
        if (!search.active || search.done || search.scanning || search.scanTimer) return;

        const generation = search.generation;
        search.scanTimer = setTimeout(() => {
            search.scanTimer = 0;
            scanPlotSearchBatch(generation);
        }, delay);
    }

    function scanPlotSearchBatch(generation) {
        const search = plotIndex.search;
        if (!plotIndex.chat || !search.active || search.done || search.scanning
            || generation !== search.generation) {
            return;
        }

        search.scanning = true;
        const startedAt = performance.now();
        const fragment = document.createDocumentFragment();
        let scanned = 0;

        try {
            while (search.nextIndex < plotIndex.chat.length) {
                if (performance.now() - startedAt > PLOT_SEARCH_BUDGET_MS
                    || scanned >= PLOT_SEARCH_BATCH_MAX) {
                    break;
                }

                const index = search.nextIndex++;
                const text = readPlotText(index);
                scanned++;
                if (!text) continue;

                const match = search.regex.exec(text);
                if (!match) continue;
                plotIndex.textCache.set(index, text);

                const cacheKey = `${search.keyword}\u0000${index}`;
                let preview = plotIndex.searchCache.get(cacheKey);
                if (!preview) {
                    preview = buildSearchPreview(text, match);
                    if (!preview) continue;
                    plotIndex.searchCache.set(cacheKey, preview);
                }

                fragment.appendChild(createPlotRow(index, preview, getPlotMeta(index), true));
                search.matchCount++;
            }

            if (fragment.childNodes.length) {
                const sentinel = search.sentinel;
                if (sentinel?.isConnected) {
                    plotIndex.searchResults.insertBefore(fragment, sentinel);
                } else {
                    plotIndex.searchResults.appendChild(fragment);
                }
            }
        } finally {
            search.scanning = false;
        }

        if (search.nextIndex >= plotIndex.chat.length) {
            search.done = true;
            removePlotSearchSentinel();

            if (search.matchCount === 0) {
                const empty = document.createElement('div');
                empty.className = 'plot-index-search-empty';
                empty.textContent = '没有找到匹配的楼层。';
                plotIndex.searchResults.appendChild(empty);
                search.emptyEl = empty;
            }
            return;
        }

        ensurePlotSearchSentinel();

        // 一条都没找到时继续自动往后搜，避免“明明有却显示空”；
        // 已经有结果就停下，等用户滚到底或点“继续搜索”，不做全量预扫。
        if (search.matchCount === 0 && isSearchNearBottom()) {
            schedulePlotSearchBatch(24);
        }
    }

    function beginPlotSearch(rawKeyword) {
        if (!plotIndex.chat) return;

        const search = plotIndex.search;
        const keyword = String(rawKeyword || '').trim();

        clearTimeout(search.inputTimer);
        clearTimeout(search.scanTimer);
        search.inputTimer = 0;
        search.scanTimer = 0;
        search.generation++;
        search.scanning = false;
        search.keyword = keyword;
        search.regex = keyword ? new RegExp(escapeRegExp(keyword), 'i') : null;
        search.nextIndex = 0;
        search.matchCount = 0;
        search.done = !keyword;
        search.emptyEl?.remove();
        search.emptyEl = null;
        removePlotSearchSentinel();
        plotIndex.searchResults.replaceChildren();

        if (!keyword) {
            search.active = false;
            plotIndex.searchResults.hidden = true;
            plotIndex.spacer.hidden = false;
            plotIndex.scroll.scrollTop = 0;
            renderPlotWindow(true);
            return;
        }

        search.active = true;
        plotIndex.spacer.hidden = true;
        plotIndex.searchResults.hidden = false;
        plotIndex.scroll.scrollTop = 0;
        scanPlotSearchBatch(search.generation);
    }

    function clearPlotSearch(renderVirtual = false) {
        const search = plotIndex.search;
        search.generation++;
        clearTimeout(search.inputTimer);
        clearTimeout(search.scanTimer);
        search.inputTimer = 0;
        search.scanTimer = 0;
        search.active = false;
        search.keyword = '';
        search.regex = null;
        search.nextIndex = 0;
        search.matchCount = 0;
        search.done = true;
        search.scanning = false;
        search.emptyEl?.remove();
        search.emptyEl = null;
        removePlotSearchSentinel();
        plotIndex.searchResults?.replaceChildren();
        if (plotIndex.searchResults) plotIndex.searchResults.hidden = true;
        if (plotIndex.searchInput) plotIndex.searchInput.value = '';
        if (plotIndex.spacer) plotIndex.spacer.hidden = false;

        if (renderVirtual && plotIndex.overlay?.classList.contains('show')) {
            plotIndex.scroll.scrollTop = 0;
            renderPlotWindow(true);
        }
    }


    function openPlotIndex() {
        const ctx = getChatContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat.slice() : [];

        ensurePlotIndexLayer();

        plotIndex.chat = chat;
        plotIndex.cache.clear();
        plotIndex.textCache.clear();
        plotIndex.searchCache.clear();
        plotIndex.lastStart = -1;
        plotIndex.lastEnd = -1;
        plotIndex.returnFocus = document.activeElement;

        clearPlotSearch(false);

        plotIndex.count.textContent = `${chat.length} 层`;
        plotIndex.spacer.style.height = `${chat.length * PLOT_ROW_HEIGHT}px`;
        plotIndex.scroll.scrollTop = 0;

        const isEmpty = chat.length === 0;
        plotIndex.empty.hidden = !isEmpty;
        plotIndex.searchBar.hidden = isEmpty;
        plotIndex.scroll.style.display = isEmpty ? 'none' : '';

        plotIndex.overlay.classList.add('show');
        document.body.classList.add('plot-index-open');

        requestAnimationFrame(() => {
            renderPlotWindow(true);
            try { plotIndex.closeBtn?.focus({ preventScroll: true }); } catch (error) { /* 忽略 */ }
        });

        // 手机地址栏/软键盘会让首次布局晚一点，再补一次，保证列表一定按最终高度铺开
        setTimeout(() => {
            if (plotIndex.overlay?.classList.contains('show')) renderPlotWindow(true);
        }, 120);
    }

    function closePlotIndex() {
        const state = plotIndex;
        if (!state.overlay) return;

        state.overlay.classList.remove('show');
        document.body.classList.remove('plot-index-open');

        if (state.frame) {
            cancelAnimationFrame(state.frame);
            state.frame = 0;
        }

        // 手机上搜索框可能还带着软键盘，先收起来再让 #chat 结算高度
        state.searchInput?.blur();
        clearPlotSearch(false);

        state.chat = null;
        state.cache.clear();
        state.textCache.clear();
        state.searchCache.clear();
        state.lastStart = -1;
        state.lastEnd = -1;
        state.windowEl?.replaceChildren();
        if (state.spacer) state.spacer.style.height = '0px';

        const focus = state.returnFocus;
        state.returnFocus = null;
        if (focus?.isConnected) {
            try { focus.focus({ preventScroll: true }); } catch (error) { /* 忽略 */ }
        }
    }

    function jumpToPlotFloor(index) {
        closePlotIndex();

        const target = document.querySelector(`#chat .mes[mesid="${index}"]`);
        if (!target) {
            showArchiveToast('info', '这一楼还没有加载出来');
            return;
        }

        setTimeout(() => {
            scrollChatToMessage(target);
            target.classList.remove('highlight-mes');
            void target.offsetWidth;
            target.classList.add('highlight-mes');
            setTimeout(() => target.classList.remove('highlight-mes'), 2000);
        }, 320);
    }

    function installPlotIndexWandButton() {
        if (document.getElementById('plot-index-wand-button')) return true;

        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;

        const button = document.createElement('div');
        button.id = 'plot-index-wand-button';
        button.className = 'list-group-item flex-container flexGap5';
        button.title = '剧情索引';

        const icon = document.createElement('div');
        icon.className = 'fa-solid fa-list-ol extensionsMenuExtensionButton';

        const label = document.createElement('span');
        label.textContent = '剧情索引';

        button.appendChild(icon);
        button.appendChild(label);
        button.addEventListener('click', openPlotIndex);
        menu.appendChild(button);

        return true;
    }

    function initPlotIndex() {
        injectPlotIndexStyle();

        if (installPlotIndexWandButton()) return;

        // 扩展加载时魔杖菜单可能还没注入，等它出现后补按钮
        const observer = new MutationObserver(() => {
            if (installPlotIndexWandButton()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 15000);
    }

    initPlotIndex();

    // 7. 启动同步引擎：事件驱动 + 只处理可见消息，不再有每秒全量扫描
    startQuoteRuntime();
})();

// 卡片导出（独立文件 export.js，只做附加，不改动上面的任何逻辑）
import('./export.js').catch(error => {
    console.error('[ST-档案馆] 卡片导出模块加载失败', error);
});
