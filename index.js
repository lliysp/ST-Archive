// @ts-nocheck
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
    };
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
        'text-decoration-color:rgba(164,80,80,0.75) !important;',
        'text-decoration-thickness:1.5px !important;text-underline-offset:3px !important;}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
})();

(function () {
    console.log("✨ [ST-档案馆] 终极组内置顶版已启动！");

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        })[char]);
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

    function renderArchiveList() {
        const nativeList = document.querySelector('.recentChatList');
        if (!nativeList) return;

        const items = Array.from(nativeList.querySelectorAll('.recentChat'));
        if (items.length === 0) return;

        // 已经重构过：只保证原生列表隐藏，避免重复插入
        const existingWrapper = nativeList.parentElement?.querySelector('.my-folded-wrapper');
        if (existingWrapper) {
            if (nativeList.style.display !== 'none') nativeList.style.display = 'none';
            return;
        }

        const domTags = collectCharacterTags();
        const pinnedChats = getArchiveState().pinnedChats;
        const grouped = new Map();

        // 1. 提取数据（原生列表本身已按时间排序，直接保留顺序）
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

            if (!grouped.has(key)) {
                grouped.set(key, {
                    key,
                    name,
                    tags: domTags[name] || [],
                    chats: [],
                    order,
                });
            }

            grouped.get(key).chats.push({
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
            });
        });

        // 2. 构建外层框架
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

        const timestamp = document.createElement('div');
        timestamp.className = 'archive-timestamp';
        timestamp.innerText = `SYSTEM TIME: ${new Date().toLocaleString()} // ACCESS GRANTED`;
        wrapper.appendChild(timestamp);

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

        // 3. 渲染角色组
        const pinnedChars = getArchiveState().pinnedChars;

        grouped.forEach(data => {
            // 置顶记录排在组内最前，其余保持原生时间顺序
            data.chats.sort((a, b) => {
                if (a.isPinned && !b.isPinned) return -1;
                if (!a.isPinned && b.isPinned) return 1;
                return a.order - b.order;
            });

            const groupDiv = document.createElement('div');
            groupDiv.className = 'my-fold-group';
            groupDiv.setAttribute('data-name', data.name.toLowerCase());
            groupDiv.setAttribute('data-tags', data.tags.join(',').toLowerCase());
            groupDiv.setAttribute('data-order', String(data.order));
            groupDiv.setAttribute('data-key', data.key);

            const isPinnedChar = pinnedChars.includes(data.key) || pinnedChars.includes(data.name);
            if (isPinnedChar) groupDiv.setAttribute('data-pinned', 'true');

            const tagsHtml = data.tags
                .map(tag => `<span class="my-tag">${escapeHtml(tag)}</span>`)
                .join('');

            const header = document.createElement('div');
            header.className = 'my-fold-header';
            header.innerHTML = `
                <div class="my-fold-header-left">
                    <div class="my-name-row">
                        <span class="icon">❖</span>
                        <span class="my-header-name">${escapeHtml(data.name)}</span>
                    </div>
                    <div class="my-header-tags">${tagsHtml}</div>
                </div>
                <div class="my-fold-header-right">
                    <span class="archive-count">${data.chats.length} 个存档</span>
                    <i class="fa-solid fa-star my-pin-btn ${isPinnedChar ? 'pinned' : ''}" title="置顶角色"></i>
                </div>
            `;

            const pinBtn = header.querySelector('.my-pin-btn');
            pinBtn.addEventListener('click', (e) => {
                e.stopPropagation();

                const state = getArchiveState();
                const currentlyPinned = state.pinnedChars.includes(data.key)
                    || state.pinnedChars.includes(data.name);

                if (currentlyPinned) {
                    state.pinnedChars = state.pinnedChars.filter(p => p !== data.key && p !== data.name);
                    pinBtn.classList.remove('pinned');
                    groupDiv.removeAttribute('data-pinned');
                } else {
                    state.pinnedChars = [...state.pinnedChars, data.key];
                    pinBtn.classList.add('pinned');
                    groupDiv.setAttribute('data-pinned', 'true');
                }

                persistArchiveState();
                applySortAndFilter(true);
            });

            header.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                groupDiv.classList.toggle('is-open');
            });

            const contentOuter = document.createElement('div');
            contentOuter.className = 'my-fold-content';
            const contentInner = document.createElement('div');
            contentInner.className = 'my-fold-content-inner';

            // 手搓聊天条目
            data.chats.forEach(chat => {
                const chatItem = document.createElement('div');
                chatItem.className = `recentChat ${chat.isPinned ? 'is-pinned-row' : ''}`;
                chatItem.dataset.order = String(chat.order);
                chatItem.dataset.pinned = chat.isPinned ? 'true' : 'false';
                chatItem.style.cssText = "display: flex !important; align-items: center; width: 100%; padding: 10px 16px; box-sizing: border-box; border-bottom: 1px solid rgba(120,120,120,0.2); cursor: pointer;";

                chatItem.innerHTML = `
                    <img src="${escapeHtml(chat.avatar)}" alt="" style="width: 40px; height: 40px; border-radius: 6px; margin-right: 12px; object-fit: cover; flex-shrink: 0;">
                    <div style="flex:1; display:flex; flex-direction:column; min-width:0;">
                        <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                            <span style="font-size:14px; color:var(--SmartThemeBodyColor); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; font-family: 'Noto Serif SC', 'Songti SC', 'SimSun', serif; letter-spacing: 1px;">${escapeHtml(chat.title)}</span>
                            <div class="action-group" style="display:flex; gap:10px; flex-shrink:0; margin-left: 10px; opacity: 0.5; transition: opacity 0.2s;">
                                <i class="fa-solid fa-thumbtack chat-pin-btn ${chat.isPinned ? 'pinned' : ''}" title="置顶"></i>
                                <i class="fa-solid fa-pen-to-square" style="color: color-mix(in srgb, var(--SmartThemeBodyColor) 40%, transparent);" title="编辑"></i>
                                <i class="fa-solid fa-trash" style="color: color-mix(in srgb, var(--SmartThemeBodyColor) 40%, transparent);" title="删除"></i>
                            </div>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:center; width:100%; margin-top:6px;">
                            <span style="font-size:11px; color:color-mix(in srgb, var(--SmartThemeBodyColor) 50%, transparent); font-family: 'Courier New', Courier, monospace;">${escapeHtml(chat.date)}</span>
                            <div style="font-size:11px; color:color-mix(in srgb, var(--SmartThemeBodyColor) 50%, transparent); transform: scale(0.9); transform-origin: right center; font-family: 'Courier New', Courier, monospace;">${chat.statsHtml}</div>
                        </div>
                    </div>
                `;

                chatItem.addEventListener('mouseenter', () => chatItem.querySelector('.action-group').style.opacity = '1');
                chatItem.addEventListener('mouseleave', () => chatItem.querySelector('.action-group').style.opacity = '0.5');
                chatItem.addEventListener('click', () => chat.originalNode.click());

                const btns = chatItem.querySelectorAll('.action-group i');

                // 组内置顶：完全脱离原生
                btns[0].addEventListener('click', (e) => {
                    e.stopPropagation();

                    const state = getArchiveState();
                    const pins = state.pinnedChats;
                    const currentlyPinned = pins[chat.pinKey] === true || pins[chat.fileKey] === true;
                    const newState = !currentlyPinned;

                    if (newState) {
                        pins[chat.pinKey] = true;
                    } else {
                        delete pins[chat.pinKey];
                        delete pins[chat.fileKey];
                    }
                    persistArchiveState();

                    chat.isPinned = newState;
                    chatItem.classList.toggle('is-pinned-row', newState);
                    chatItem.dataset.pinned = newState ? 'true' : 'false';
                    btns[0].classList.toggle('pinned', newState);

                    if (newState) {
                        contentInner.prepend(chatItem);
                    } else {
                        // 取消置顶后放回原本的时间位置，而不是直接扔到最后
                        const anchor = Array.from(contentInner.children).find(row => {
                            if (row === chatItem) return false;
                            if (row.dataset.pinned === 'true') return false;
                            return Number(row.dataset.order) > chat.order;
                        });
                        contentInner.insertBefore(chatItem, anchor || null);
                    }
                });

                btns[1].addEventListener('click', (e) => { e.stopPropagation(); if (chat.renameNode) chat.renameNode.click(); });
                btns[2].addEventListener('click', (e) => { e.stopPropagation(); if (chat.deleteNode) chat.deleteNode.click(); });

                contentInner.appendChild(chatItem);
            });

            contentOuter.appendChild(contentInner);
            groupDiv.appendChild(header);
            groupDiv.appendChild(contentOuter);
            listContainer.appendChild(groupDiv);
        });

        // 4. 分页、搜索与排序
        const searchInput = wrapper.querySelector('.archive-search-input');
        const searchBtn = wrapper.querySelector('.archive-search-btn');
        const resetBtn = wrapper.querySelector('.archive-reset-btn');
        const sortSelect = wrapper.querySelector('.archive-sort-select');
        const prevBtn = wrapper.querySelector('.page-prev');
        const nextBtn = wrapper.querySelector('.page-next');
        const pageInfo = wrapper.querySelector('.page-info');

        let currentPage = 1;
        const pageSize = 10;

        function applySortAndFilter(resetPage = false) {
            if (resetPage) currentPage = 1;
            const keyword = searchInput.value.toLowerCase().trim();
            const sortBy = sortSelect.value;
            const groups = Array.from(listContainer.querySelectorAll('.my-fold-group'));

            const visibleGroups = [];
            groups.forEach(group => {
                const name = group.getAttribute('data-name') || '';
                const tags = group.getAttribute('data-tags') || '';
                if (name.includes(keyword) || tags.includes(keyword)) {
                    visibleGroups.push(group);
                } else {
                    group.style.display = 'none';
                }
            });

            visibleGroups.sort((a, b) => {
                const pinnedA = a.hasAttribute('data-pinned') ? 1 : 0;
                const pinnedB = b.hasAttribute('data-pinned') ? 1 : 0;
                if (pinnedA !== pinnedB) return pinnedB - pinnedA;

                const orderA = Number(a.getAttribute('data-order')) || 0;
                const orderB = Number(b.getAttribute('data-order')) || 0;

                if (sortBy === 'time-desc') return orderA - orderB;
                if (sortBy === 'time-asc') return orderB - orderA;
                if (sortBy === 'name-asc') return (a.getAttribute('data-name') || '').localeCompare(b.getAttribute('data-name') || '');
                if (sortBy === 'name-desc') return (b.getAttribute('data-name') || '').localeCompare(a.getAttribute('data-name') || '');
                return 0;
            });

            const totalPages = Math.ceil(visibleGroups.length / pageSize) || 1;
            if (currentPage > totalPages) currentPage = totalPages;
            if (currentPage < 1) currentPage = 1;

            const startIndex = (currentPage - 1) * pageSize;
            const endIndex = startIndex + pageSize;

            visibleGroups.forEach((group, index) => {
                group.style.display = (index >= startIndex && index < endIndex) ? 'block' : 'none';
                listContainer.appendChild(group);
            });

            pageInfo.innerText = `${currentPage} / ${totalPages}`;
            pagination.style.display = 'flex';

            if (totalPages <= 1) {
                prevBtn.style.visibility = 'hidden';
                nextBtn.style.visibility = 'hidden';
            } else {
                prevBtn.style.visibility = 'visible';
                nextBtn.style.visibility = 'visible';
            }

            prevBtn.disabled = currentPage === 1;
            nextBtn.disabled = currentPage === totalPages;
        }

        searchBtn.addEventListener('click', () => applySortAndFilter(true));
        searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') applySortAndFilter(true); });
        resetBtn.addEventListener('click', () => { searchInput.value = ''; applySortAndFilter(true); });
        sortSelect.addEventListener('change', () => applySortAndFilter(true));
        prevBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; applySortAndFilter(); } });
        nextBtn.addEventListener('click', () => { currentPage++; applySortAndFilter(); });

        nativeList.insertAdjacentElement('afterend', wrapper);
        nativeList.style.display = 'none';
        applySortAndFilter(true);
    }

    // 进入酒馆、关闭聊天、切换角色时，原生的欢迎面板会被整块重新渲染。
    // 之前靠 200ms 轮询，最坏要等两帧才重建，中间那段空白就是“闪一下”的来源。
    // 这里用 MutationObserver 在 DOM 变化的下一帧立刻重建，轮询只作为兜底。
    let archiveRenderFrame = 0;

    function runArchiveRender() {
        try {
            renderArchiveList();
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
    setInterval(queueArchiveRender, 200);
})();

(function () {
    console.log("📚 [ST-档案馆] 拾遗模块已加载！");

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

        const messageName = normalizeCharName(message.name || '');
        if (quote.char && quote.char !== '未知角色' && messageName !== quote.char) return false;

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
        if (!chatInfo?.active) return;

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

    // 角色名 / 群名同样取实时值：改过角色名之后，旧收藏也不该继续显示旧名字
    function getLiveCharName(scope, fallback) {
        const key = String(scope || '');
        const ctx = getChatContext();

        try {
            if (ctx && key.startsWith('char:')) {
                const avatar = key.slice(5);
                const character = ctx.characters?.find?.(item => item?.avatar === avatar);
                if (character?.name) return String(character.name).trim();
            } else if (ctx && key.startsWith('group:')) {
                const groupId = key.slice(6);
                const group = ctx.groups?.find?.(item => String(item?.id) === groupId);
                if (group?.name) return String(group.name).trim();
            }
        } catch (error) {
            console.warn('[ST-档案馆] 解析角色/群实时名称失败', error);
        }

        return fallback;
    }

    // 聊天记录改名后文件也会改名，所以名字的唯一可靠来源是“当前渲染出来的最近聊天列表”。
    // 这里把原生列表（即使被归档面板隐藏，节点仍在 DOM 里）解析成 chatKey -> 最新名字 的索引。
    let liveChatNameCache = { at: 0, map: new Map() };

    function invalidateLiveChatNameCache() {
        liveChatNameCache = { at: 0, map: new Map() };
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
        }
    }

    function bindChatRenameListener() {
        try {
            const ctx = getChatContext();
            const eventSource = ctx?.eventSource;
            const eventTypes = ctx?.eventTypes || ctx?.event_types;
            if (eventSource?.on && eventTypes?.CHAT_RENAMED) {
                eventSource.on(eventTypes.CHAT_RENAMED, handleChatRenamed);
            }
        } catch (error) {
            console.warn('[ST-档案馆] 监听聊天改名事件失败', error);
        }
    }

    // 整层消息收藏（无 source）与划词/划句收藏（source === 'selection'）是两类记录：
    // 楼层书签只代表“整层已收录”，不能被划词收藏点亮，取消时也不能误删划词记录。
    function isWholeMessageQuote(quote) {
        return Boolean(quote) && quote.source !== 'selection';
    }

    function messageHasQuote(mesid, charName, chatInfo, ctx) {
        if (!chatInfo?.active) return false;

        return savedQuotes.some(quote => {
            if (!isWholeMessageQuote(quote)) return false;
            if (String(quote.mesid) !== String(mesid) || quote.char !== charName) return false;
            if (quote.chatKey) return quote.chatKey === chatInfo.key;
            return quoteMatchesCurrentChat(quote, chatInfo, ctx);
        });
    }

    // 1. 注入 CSS 样式
    const style = document.createElement('style');
    style.innerHTML = `
        #quote-fab {
            position: fixed !important; 
            width: 32px !important; 
            height: 32px !important;
            background: transparent !important; 
            color: #a45050 !important; 
            border: 1px solid #a45050 !important; 
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
            background: rgba(164, 80, 80, 0.1) !important;
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
            background: #FDFBF7; border: 1px solid rgba(164, 80, 80, 0.4);
            border-radius: 12px; display: flex; flex-direction: column;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2); color: #4A4A4A;
            font-family: 'Noto Serif SC', 'Songti SC', serif; overflow: hidden;
            transform: scale(0.95); transition: transform 0.2s;
        }
        #quote-overlay.show #quote-panel { transform: scale(1); }

        .quote-header {
            padding: 14px 18px; border-bottom: 1px dashed rgba(164, 80, 80, 0.3);
            display: flex; justify-content: space-between; align-items: center; gap: 12px;
            background: rgba(164, 80, 80, 0.05);
        }
        .quote-tabs { display: flex; align-items: center; gap: 2px; min-width: 0; }
        #quote-panel .quote-tab {
            appearance: none; -webkit-appearance: none; border: 0; background: transparent;
            color: rgba(74, 74, 74, 0.55); padding: 6px 10px; border-radius: 6px;
            font-family: inherit; font-size: 12px; letter-spacing: 1px; cursor: pointer;
            transition: color 0.2s, background 0.2s;
        }
        #quote-panel .quote-tab:hover { color: #a45050; background: rgba(164, 80, 80, 0.06); }
        #quote-panel .quote-tab.active { color: #a45050; background: rgba(164, 80, 80, 0.1); font-weight: 600; }
        .quote-tab-sep { color: rgba(164, 80, 80, 0.28); font-size: 11px; user-select: none; }
        .quote-header-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        #quote-panel .quote-header-btn {
            appearance: none; -webkit-appearance: none;
            width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
            background: transparent; color: rgba(164, 80, 80, 0.72);
            display: inline-flex; align-items: center; justify-content: center;
            font-size: 13px; line-height: 1; cursor: pointer;
            box-shadow: none; transition: color 0.2s, background 0.2s;
        }
        #quote-panel .quote-header-btn:hover { color: #a45050; background: rgba(164, 80, 80, 0.1); }
        #quote-panel .quote-header-btn:active { background: rgba(164, 80, 80, 0.16); }
        #quote-panel .quote-close {
            appearance: none; -webkit-appearance: none;
            width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
            background: transparent; color: #a45050; font-family: Arial, sans-serif;
            font-size: 22px; line-height: 1; cursor: pointer; flex-shrink: 0;
            box-shadow: none; transition: color 0.2s, background 0.2s;
        }
        #quote-panel .quote-close:hover { color: #8b3a3a; background: rgba(164, 80, 80, 0.08); }

        .quote-content { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }

        .quote-group {
            border-left: 2px solid rgba(164, 80, 80, 0.35);
            padding-left: 12px;
            margin-bottom: 16px;
        }
        .quote-group:last-child { margin-bottom: 0; }
        .quote-group-header {
            display: flex; justify-content: space-between; align-items: center; gap: 12px;
            padding: 8px 4px; cursor: pointer; user-select: none;
            border-bottom: 1px dashed rgba(164, 80, 80, 0.25);
            transition: background 0.2s;
        }
        .quote-group-header:hover { background: rgba(164, 80, 80, 0.04); }
        .quote-group-title { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
        .quote-group-title .icon { color: #a45050; font-size: 12px; display: inline-block; transition: transform 0.25s; flex-shrink: 0; }
        .quote-group.is-open .quote-group-title .icon { transform: rotate(90deg); }
        .quote-group-name {
            font-size: 14px; font-weight: 600; color: #4A4A4A; letter-spacing: 1px;
            font-family: 'Noto Serif SC', 'Songti SC', serif;
            line-height: 1.45; overflow-wrap: anywhere;
        }
        .quote-group-meta { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .quote-group-count { font-size: 11px; color: #999; font-family: 'Courier New', Courier, monospace; }
        .quote-group-chevron { font-size: 10px; color: #a45050; transition: transform 0.25s; }
        .quote-group.is-open .quote-group-chevron { transform: rotate(180deg); }
        .quote-group-content { display: none; flex-direction: column; gap: 10px; padding: 12px 0 2px; }
        .quote-group.is-open .quote-group-content { display: flex; }

        .quote-card {
            position: relative;
            background: #ffffff; padding: 12px 38px 12px 15px;
            border-left: 3px solid #a45050; border-radius: 6px;
            cursor: pointer; transition: all 0.2s;
            box-shadow: 0 2px 8px rgba(0,0,0,0.03);
        }
        .quote-card:hover { background: #faf8f5; box-shadow: 0 4px 12px rgba(0,0,0,0.06); transform: translateY(-1px); }
        .quote-card .q-text {
            font-size: 14px; color: #333; line-height: 1.6; white-space: pre-wrap;
            display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden;
            overflow-wrap: anywhere;
        }
        .quote-card .q-time { font-size: 11px; color: #999; text-align: right; margin-top: 8px; font-family: monospace; }
        #quote-panel .quote-delete {
            position: absolute; top: 7px; right: 8px;
            width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%;
            background: transparent; color: #a45050; opacity: 0.42;
            font-family: Arial, sans-serif; font-size: 16px; line-height: 20px; text-align: center;
            cursor: pointer; transition: opacity 0.2s, background 0.2s, transform 0.2s;
        }
        #quote-panel .quote-delete:hover { opacity: 1; background: rgba(164, 80, 80, 0.1); transform: scale(1.08); }

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
        .mes-bookmark-btn:hover { color: #a45050; transform: scale(1.1); }
        .mes-bookmark-btn.saved { color: #a45050; }

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
            border: 1px solid rgba(164, 80, 80, 0.4); border-radius: 12px;
            background: linear-gradient(145deg, #FEFCF8 0%, #F8F2E9 100%);
            color: #4A4A4A; box-shadow: 0 18px 50px rgba(60, 40, 32, 0.22);
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
            background: none; color: #a45050; font-family: Arial, sans-serif;
            font-size: 24px; line-height: 1; cursor: pointer; box-shadow: none;
        }
        #quote-detail-overlay .quote-detail-close:hover { color: #8b3a3a; }
        .quote-detail-title {
            flex: 1; min-width: 0;
            font-family: 'Noto Serif SC', 'Songti SC', serif;
            font-size: 15px; color: #8b3a3a; letter-spacing: 1.5px; line-height: 1.6;
            overflow-wrap: anywhere; word-break: break-word;
        }
        .quote-detail-title::before {
            content: "❖"; margin-right: 8px; color: #a45050; font-size: 11px;
            vertical-align: 1px;
        }
        .quote-detail-meta {
            flex-shrink: 0;
            margin: 12px 24px 16px; padding-bottom: 12px; border-bottom: 1px dashed rgba(164, 80, 80, 0.28);
            color: #999; font-family: 'Courier New', Courier, monospace; font-size: 11px; letter-spacing: 0.3px;
            overflow-wrap: anywhere; word-break: break-word;
        }
        .quote-detail-text {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto; overflow-x: hidden;
            overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
            margin: 0 24px 22px; padding-left: 14px;
            border-left: 3px solid rgba(164, 80, 80, 0.5);
            color: #333; font-size: 14px; line-height: 1.9;
            white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
        }
        @keyframes quoteFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes quoteDetailIn { to { transform: translateY(0) scale(1); } }

        .highlight-mes { animation: quoteBreathe 2s ease-in-out; }
        @keyframes quoteBreathe {
            0% { background-color: rgba(164, 80, 80, 0); box-shadow: inset 0 0 0 0 rgba(164, 80, 80, 0); }
            30% { background-color: rgba(164, 80, 80, 0.14); box-shadow: inset 0 0 0 1px rgba(164, 80, 80, 0.5), 0 0 18px rgba(164, 80, 80, 0.18); }
            65% { background-color: rgba(164, 80, 80, 0.05); box-shadow: inset 0 0 0 1px rgba(164, 80, 80, 0.25), 0 0 8px rgba(164, 80, 80, 0.1); }
            100% { background-color: rgba(164, 80, 80, 0); box-shadow: inset 0 0 0 0 rgba(164, 80, 80, 0); }
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

    function injectBookmarks() {
        const ctx = getChatContext();
        const chatInfo = getCurrentChatInfo();

        document.querySelectorAll('.mes').forEach(mes => {
            // 绝不能给隐藏的消息模板注入按钮：模板会在创建新楼层时被整块克隆
            if (mes.closest('.template_element') || mes.closest('#message_template')) {
                mes.querySelectorAll('.mes-bookmark-btn').forEach(btn => btn.remove());
                return;
            }

            if (mes.getAttribute('is_user') === 'true') {
                mes.querySelectorAll('.mes-bookmark-btn').forEach(btn => btn.remove());
                return;
            }

            const mesid = mes.getAttribute('mesid');
            if (mesid === null || mesid === '') return;

            // 始终以真实楼层为准，兼容从模板克隆出来的旧按钮
            const nameEl = mes.querySelector('.ch_name .name_text');
            const charName = normalizeCharName(
                (nameEl?.textContent || mes.getAttribute('ch_name') || '未知角色').trim()
            );
            const isSaved = messageHasQuote(mesid, charName, chatInfo, ctx);

            const existingBtn = mes.querySelector('.mes-bookmark-btn');
            if (existingBtn) {
                existingBtn.setAttribute('data-mesid', mesid);
                existingBtn.setAttribute('data-char', charName);
                existingBtn.classList.toggle('saved', isSaved);
                existingBtn.innerHTML = isSaved
                    ? '<i class="fa-solid fa-bookmark"></i>'
                    : '<i class="fa-regular fa-bookmark"></i>';
                return;
            }

            const targetArea = mes.querySelector('.mes_buttons');
            if (!targetArea) return;

            const btn = document.createElement('div');
            btn.className = 'mes-bookmark-btn';
            btn.setAttribute('data-mesid', mesid);
            btn.setAttribute('data-char', charName);
            btn.title = "收录此句";
            btn.classList.toggle('saved', isSaved);
            btn.innerHTML = isSaved
                ? '<i class="fa-solid fa-bookmark"></i>'
                : '<i class="fa-regular fa-bookmark"></i>';

            targetArea.appendChild(btn);
        });

        // 每次同步楼层书签时顺手校准正文下划线（稳态下不做任何 DOM 修改）
        applyQuoteUnderlines();
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
        const viewport = window.visualViewport;
        const viewportWidth = Math.round((viewport ? viewport.width : window.innerWidth) || 0);
        let viewportHeight = Math.round((viewport ? viewport.height : window.innerHeight) || 0);
        if (viewportWidth <= 0 || viewportHeight <= 0) return;

        // 极端回退：没有 VisualViewport 的旧内核里，innerHeight 可能被报成超大的布局视口，
        // 这时再用屏幕高度兜底，保证弹窗不会高于手机屏幕。
        if (!viewport) {
            const screenHeight = Math.round(Number(window.screen?.height) || 0);
            if (screenHeight > 0 && viewportHeight > screenHeight * 1.1) {
                viewportHeight = screenHeight;
            }
        }

        detailOverlay.style.top = `${Math.round(viewport ? viewport.offsetTop : 0)}px`;
        detailOverlay.style.left = `${Math.round(viewport ? viewport.offsetLeft : 0)}px`;
        detailOverlay.style.right = 'auto';
        detailOverlay.style.bottom = 'auto';
        detailOverlay.style.width = `${viewportWidth}px`;
        detailOverlay.style.height = `${viewportHeight}px`;
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
            quote.char || chat.char,
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
    }

    // 旋转屏幕、地址栏收起/展开、软键盘变化时，重新把详情弹层钉回可见视口
    window.addEventListener('resize', refreshQuoteDetailBounds);
    window.addEventListener('orientationchange', refreshQuoteDetailBounds);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
        window.visualViewport.addEventListener('resize', refreshQuoteDetailBounds);
        window.visualViewport.addEventListener('scroll', refreshQuoteDetailBounds);
    }

    function syncBookmarkAfterDelete(quote, chatInfo, ctx) {
        if (!chatInfo?.active) return;

        const belongs = quote.chatKey
            ? quote.chatKey === chatInfo.key
            : quoteMatchesCurrentChat(quote, chatInfo, ctx);
        if (!belongs) return;

        const mesid = String(quote.mesid ?? '');
        const mes = document.querySelector(`.mes[mesid="${CSS.escape(mesid)}"]`);
        if (!mes) return;

        const btn = mes.querySelector('.mes-bookmark-btn');
        if (!btn) return;

        const nameEl = mes.querySelector('.ch_name .name_text');
        const charName = normalizeCharName(
            (nameEl?.textContent || mes.getAttribute('ch_name') || '未知角色').trim()
        );
        const stillSaved = messageHasQuote(mesid, charName, chatInfo, ctx);

        btn.setAttribute('data-mesid', mesid);
        btn.setAttribute('data-char', charName);
        btn.classList.toggle('saved', stillSaved);
        btn.innerHTML = stillSaved
            ? '<i class="fa-solid fa-bookmark"></i>'
            : '<i class="fa-regular fa-bookmark"></i>';
    }

    function deleteQuote(quote, chatInfo) {
        const ctx = getChatContext();
        savedQuotes = savedQuotes.filter(item => item !== quote);
        saveQuotes();
        syncBookmarkAfterDelete(quote, chatInfo, ctx);
        renderQuotes();
        // 取消收藏后正文里的下划线要立刻消失
        applyQuoteUnderlines();
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

    function createQuoteCard(quote, mode, chatInfo) {
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

        card.addEventListener('click', () => {
            if (mode === 'all') {
                showQuoteDetail(quote);
                return;
            }

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
            
            // 🚨 加个延迟，等面板动画结束、DOM重排完毕后再高亮
            setTimeout(() => {
                targetMes.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetMes.classList.remove('highlight-mes');
                void targetMes.offsetWidth; 
                targetMes.classList.add('highlight-mes');
                
                // 🚨 核心：2秒后自动移除类名，彻底清理特效残留！
                setTimeout(() => {
                    targetMes.classList.remove('highlight-mes');
                }, 2000);

            }, 300);
        });

        deleteBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            deleteQuote(quote, chatInfo);
        });

        return card;
    }

    function renderQuotes() {
        const list = document.getElementById('quote-list');
        if (!list) return;

        list.innerHTML = '';

        const ctx = getChatContext();
        const chatInfo = getCurrentChatInfo();
        hydrateLegacyQuotes(chatInfo, ctx);

        if (activeQuoteTab === 'current') {
            if (!chatInfo.active) {
                renderQuotePoem(list);
                return;
            }

            const quotes = [...savedQuotes]
                .reverse()
                .filter(quote => quoteBelongsToChat(quote, chatInfo, ctx));

            if (quotes.length === 0) {
                renderQuoteEmpty(list, '这里是寂静的荒原，\n等待第一场风暴。', 'A silent wasteland awaiting the first storm.');
                return;
            }

            quotes.forEach(quote => list.appendChild(createQuoteCard(quote, 'current', chatInfo)));
            return;
        }

        if (savedQuotes.length === 0) {
            renderQuoteEmpty(list, '这里是寂静的荒原，\n等待第一场风暴。', 'A silent wasteland awaiting the first storm.');
            return;
        }

        // 按聊天分组；倒序遍历，让最近收录的聊天和句子排在最前
        const groups = new Map();
        [...savedQuotes].reverse().forEach(quote => {
            const chat = getQuoteChatInfo(quote);
            if (!groups.has(chat.key)) {
                groups.set(chat.key, { chat, quotes: [] });
            }
            groups.get(chat.key).quotes.push(quote);
        });

        // 清理已经不存在的分组展开状态，避免新收藏的聊天组意外继承旧状态
        [...expandedQuoteGroups].forEach(key => {
            if (!groups.has(key)) expandedQuoteGroups.delete(key);
        });

        groups.forEach(({ chat, quotes }) => {
            const group = document.createElement('div');
            group.className = 'quote-group';
            if (expandedQuoteGroups.has(chat.key)) group.classList.add('is-open');

            const title = `${chat.char} - ${chat.chatName}`;

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
            header.querySelector('.quote-group-count').textContent = `${quotes.length} 条`;

            header.addEventListener('click', () => {
                const isOpen = group.classList.toggle('is-open');
                if (isOpen) expandedQuoteGroups.add(chat.key);
                else expandedQuoteGroups.delete(chat.key);
            });

            const content = document.createElement('div');
            content.className = 'quote-group-content';
            quotes.forEach(quote => content.appendChild(createQuoteCard(quote, 'all', chatInfo)));

            group.appendChild(header);
            group.appendChild(content);
            list.appendChild(group);
        });
    }

    function setQuoteTab(tab) {
        activeQuoteTab = tab === 'all' ? 'all' : 'current';
        panel.querySelectorAll('.quote-tab').forEach(button => {
            const isActive = button.getAttribute('data-tab') === activeQuoteTab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', String(isActive));
        });
        renderQuotes();

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
    let underlineBusy = false;

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

    // 完全同一句（空白差异不算不同）—— 只用于「再点一次取消收录」
    function isSameSelectionQuote(quote, payload, chatInfo) {
        if (!isSelectionQuoteOfMessage(quote, payload, chatInfo)) return false;
        return normalizeQuoteText(quote.text) === normalizeQuoteText(payload?.text);
    }

    function findSelectionMatches(payload, chatInfo) {
        return savedQuotes.filter(quote => isSameSelectionQuote(quote, payload, chatInfo));
    }

    // 已收藏的更长语录里已经包含了这次选中的片段 → 不允许再存一条短的
    function findContainingQuotes(payload, chatInfo) {
        const selection = normalizeQuoteText(payload?.text);
        if (!selection) return [];

        return savedQuotes.filter(quote => {
            if (!isSelectionQuoteOfMessage(quote, payload, chatInfo)) return false;
            const stored = normalizeQuoteText(quote.text);
            return stored.length > selection.length && stored.includes(selection);
        });
    }

    // 这次选区比已收藏的短句更长，并且完整包含了它 → 应该升级成这条长句
    function findContainedQuotes(payload, chatInfo) {
        const selection = normalizeQuoteText(payload?.text);
        if (!selection) return [];

        return savedQuotes.filter(quote => {
            if (!isSelectionQuoteOfMessage(quote, payload, chatInfo)) return false;
            const stored = normalizeQuoteText(quote.text);
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

    function unwrapQuoteMark(mark) {
        const parent = mark?.parentNode;
        if (!parent) return;

        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
    }

    /**
     * 让正文下划线与收藏列表保持一致：
     * 有收藏但没线 → 补上；收藏被取消 / 切到别的聊天 / 消息重绘 → 去掉。
     * 稳态下这里不碰任何 DOM，所以不会打断正在拖动的选区。
     */
    function applyQuoteUnderlines() {
        if (underlineBusy) return;
        underlineBusy = true;

        try {
            const chatInfo = getCurrentChatInfo();
            const wanted = new Map();

            getCurrentSelectionQuotes(chatInfo).forEach(quote => {
                const key = archiveQuoteKey(quote);
                if (key && !wanted.has(key)) wanted.set(key, quote);
            });

            // 1. 拆掉不该存在的线
            document.querySelectorAll(QUOTE_MARK_SELECTOR).forEach(mark => {
                const key = mark.getAttribute('data-quote-key') || '';
                if (!wanted.has(key)) unwrapQuoteMark(mark);
            });

            if (!wanted.size) return;

            // 2. 补上缺的线；长句优先，避免短句先占位把长句的匹配切断
            const existing = new Set(
                Array.from(document.querySelectorAll(QUOTE_MARK_SELECTOR))
                    .map(mark => mark.getAttribute('data-quote-key') || '')
            );

            const pending = Array.from(wanted.entries())
                .filter(([key]) => !existing.has(key))
                .sort((a, b) => String(b[1].text || '').length - String(a[1].text || '').length);

            pending.forEach(([key, quote]) => {
                const mesid = String(quote.mesid ?? '');
                if (!/^\d+$/.test(mesid)) return;

                const container = document.querySelector(`.mes[mesid="${CSS.escape(mesid)}"] .mes_text`);
                if (!container) return;

                const map = buildMessageTextMap(container);
                const range = findQuoteTextRange(map, quote.text);
                if (!range) return;

                wrapQuoteTextRange(map, range.start, range.end, key);
            });
        } catch (error) {
            console.warn('[ST-档案馆] 绘制收藏下划线失败', error);
        } finally {
            underlineBusy = false;
        }
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
            injectBookmarks();
            applyQuoteUnderlines();

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
            if (!keep.chatKey && chatInfo.key) keep.chatKey = chatInfo.key;
            if (!keep.chatName && chatInfo.chatName) keep.chatName = chatInfo.chatName;

            saveQuotes();
            renderQuotes();
            injectBookmarks();
            applyQuoteUnderlines();

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
        const duplicate = savedQuotes.some(quote => (
            String(quote.mesid ?? '') === mesid
            && quote.char === charName
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
            chatKey: chatInfo.key || '',
            chatName: chatInfo.chatName || '',
            chatChar: chatInfo.charName || charName,
            scope: chatInfo.scope || '',
            source: 'selection',
        });

        saveQuotes();
        renderQuotes();
        injectBookmarks();

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
    document.addEventListener('click', (event) => {
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
        const isSaved = messageHasQuote(mesid, charName, chatInfo, ctx);

        if (isSaved) {
            savedQuotes = savedQuotes.filter(q => !(
                isWholeMessageQuote(q) &&
                String(q.mesid) === String(mesid) &&
                q.char === charName &&
                (q.chatKey ? q.chatKey === chatInfo.key : true)
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
        applyQuoteUnderlines();
    });

    // 5. 悬浮窗事件
    fab.addEventListener('click', () => {
        if (overlay.classList.contains('show')) {
            closeQuotePanel();
            return;
        }

        // 打开面板时强制刷新一次最近聊天名字索引，避免别处刚改过名还显示旧名字
        invalidateLiveChatNameCache();
        setQuoteTab('current');
        overlay.classList.add('show');
    });

    panel.querySelector('.quote-close').addEventListener('click', closeQuotePanel);
    panel.querySelector('.quote-export-btn').addEventListener('click', exportQuotesToFile);
    panel.querySelector('.quote-import-btn').addEventListener('click', () => importFileInput.click());
    panel.querySelectorAll('.quote-tab').forEach(button => {
        button.addEventListener('click', () => setQuoteTab(button.getAttribute('data-tab')));
    });

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

        const startDrag = (e) => {
            if (e.type === 'mousedown') e.preventDefault();
            isDragging = true; hasMoved = false;
            const clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
            const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
            startX = clientX; startY = clientY;
            initialLeft = el.offsetLeft; initialTop = el.offsetTop;
        };

        const onDrag = (e) => {
            if (!isDragging) return;
            const clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
            const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
            let dx = clientX - startX, dy = clientY - startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                hasMoved = true;
                if (e.type.includes('touch') && e.cancelable) e.preventDefault();
            }
            let newLeft = initialLeft + dx, newTop = initialTop + dy;
            const maxLeft = window.innerWidth - el.offsetWidth;
            const maxTop = window.innerHeight - el.offsetHeight;
            if (newLeft < 0) newLeft = 0; if (newLeft > maxLeft) newLeft = maxLeft;
            if (newTop < 0) newTop = 0; if (newTop > maxTop) newTop = maxTop;
            el.style.left = newLeft + 'px'; el.style.top = newTop + 'px';
        };

        const endDrag = () => {
            if (!isDragging) return;
            isDragging = false;
            if (hasMoved) {
                writeLocalStorageJson(ARCHIVE_LEGACY_KEYS.fabPos, { left: el.offsetLeft, top: el.offsetTop });
            }
        };

        el.addEventListener('mousedown', startDrag);
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', endDrag);
        el.addEventListener('touchstart', startDrag, { passive: false });
        document.addEventListener('touchmove', onDrag, { passive: false });
        document.addEventListener('touchend', endDrag);
        el.addEventListener('click', (e) => {
            if (hasMoved) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                hasMoved = false;
            }
        }, true);
    })(fab);

    // 7. 启动定时器
    setInterval(injectBookmarks, 1000);
})();
