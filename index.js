// @ts-nocheck
(function () {
    console.log("✨ [ST-档案馆] 终极组内置顶版已启动！");

    const PINNED_CHARS_KEY = 'archive_pinned';
    const PINNED_CHATS_KEY = 'archive_pinned_chats';

    function readJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return parsed ?? fallback;
        } catch (error) {
            console.warn(`[ST-档案馆] 读取 ${key} 失败`, error);
            return fallback;
        }
    }

    function writeJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn(`[ST-档案馆] 写入 ${key} 失败`, error);
        }
    }

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

    setInterval(function () {
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
        const pinnedChats = readJson(PINNED_CHATS_KEY, {});
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
        const pinnedChars = readJson(PINNED_CHARS_KEY, []);

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

                let pins = readJson(PINNED_CHARS_KEY, []);
                const currentlyPinned = pins.includes(data.key) || pins.includes(data.name);

                if (currentlyPinned) {
                    pins = pins.filter(p => p !== data.key && p !== data.name);
                    pinBtn.classList.remove('pinned');
                    groupDiv.removeAttribute('data-pinned');
                } else {
                    pins.push(data.key);
                    pinBtn.classList.add('pinned');
                    groupDiv.setAttribute('data-pinned', 'true');
                }

                writeJson(PINNED_CHARS_KEY, pins);
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

                    let pins = readJson(PINNED_CHATS_KEY, {});
                    const currentlyPinned = pins[chat.pinKey] === true || pins[chat.fileKey] === true;
                    const newState = !currentlyPinned;

                    if (newState) {
                        pins[chat.pinKey] = true;
                    } else {
                        delete pins[chat.pinKey];
                        delete pins[chat.fileKey];
                    }
                    writeJson(PINNED_CHATS_KEY, pins);

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
    }, 200);
})();

(function () {
    console.log("📚 [ST-档案馆] 拾遗模块已加载！");

    if (document.getElementById('quote-fab')) return;

    const QUOTES_KEY = 'st_quotes';
    const FAB_POS_KEY = 'quote_fab_pos';

    function readJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return parsed ?? fallback;
        } catch (error) {
            console.warn(`[ST-档案馆] 读取 ${key} 失败`, error);
            return fallback;
        }
    }

    function writeJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn(`[ST-档案馆] 写入 ${key} 失败`, error);
        }
    }

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
        const raw = readJson(QUOTES_KEY, []);
        if (!Array.isArray(raw)) return [];

        let changed = false;
        const quotes = [];

        raw.forEach(quote => {
            if (!quote || typeof quote !== 'object') {
                changed = true;
                return;
            }

            // 旧版本可能把模板按钮的 data-mesid="" 存了进来，这种记录无法定位楼层
            const mesid = String(quote.mesid ?? '').trim();
            if (!/^\d+$/.test(mesid)) {
                changed = true;
                return;
            }

            let char = normalizeCharName(quote.char);
            if (char.includes('${')) char = '未知角色';
            if (char !== quote.char) changed = true;

            quotes.push({ ...quote, mesid, char });
        });

        if (changed) writeJson(QUOTES_KEY, quotes);
        return quotes;
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

        if (changed) writeJson(QUOTES_KEY, savedQuotes);
    }

    function getQuoteChatInfo(quote) {
        const char = String(quote.chatChar || quote.char || '未知角色').trim() || '未知角色';
        const chatName = String(quote.chatName || '').trim()
            || (quote.chatKey ? '未命名聊天' : '历史收藏');

        return {
            key: quote.chatKey || `legacy:${char}`,
            char,
            chatName,
        };
    }

    function messageHasQuote(mesid, charName, chatInfo, ctx) {
        if (!chatInfo?.active) return false;

        return savedQuotes.some(quote => {
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
        .quote-close { cursor: pointer; font-size: 24px; color: #a45050; line-height: 1; flex-shrink: 0; padding: 0 2px; }
        .quote-close:hover { color: #8b3a3a; }

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
            position: fixed; inset: 0; z-index: 1000000;
            display: none; justify-content: center; align-items: center;
            padding: 24px; background: rgba(42, 34, 30, 0.34);
        }
        #quote-detail-overlay.show { display: flex; animation: quoteFadeIn 0.18s ease-out; }
        .quote-detail-panel {
            position: relative; width: min(90vw, 560px); max-height: 72vh; overflow-y: auto;
            padding: 24px 26px 22px; border: 1px solid rgba(164, 80, 80, 0.4); border-radius: 12px;
            background: linear-gradient(145deg, #FEFCF8 0%, #F8F2E9 100%);
            color: #4A4A4A; box-shadow: 0 18px 50px rgba(60, 40, 32, 0.22);
            font-family: 'Noto Serif SC', 'Songti SC', serif;
            transform: translateY(6px) scale(0.98); animation: quoteDetailIn 0.22s ease-out forwards;
        }
        #quote-detail-overlay .quote-detail-close {
            position: absolute; top: 10px; right: 14px; padding: 0; border: 0;
            background: none; color: #a45050; font-size: 24px; line-height: 1; cursor: pointer;
        }
        #quote-detail-overlay .quote-detail-close:hover { color: #8b3a3a; }
        .quote-detail-title {
            padding-right: 30px; font-family: 'Noto Serif SC', 'Songti SC', serif;
            font-size: 15px; color: #8b3a3a; letter-spacing: 1.5px; line-height: 1.6;
        }
        .quote-detail-title::before {
            content: "❖"; margin-right: 8px; color: #a45050; font-size: 11px;
            vertical-align: 1px;
        }
        .quote-detail-meta {
            margin: 12px 0 16px; padding-bottom: 12px; border-bottom: 1px dashed rgba(164, 80, 80, 0.28);
            color: #999; font-family: 'Courier New', Courier, monospace; font-size: 11px; letter-spacing: 0.3px;
        }
        .quote-detail-text {
            border-left: 3px solid rgba(164, 80, 80, 0.5); padding-left: 14px;
            color: #333; font-size: 14px; line-height: 1.9;
            white-space: pre-wrap; overflow-wrap: anywhere;
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
            <div class="quote-close" title="关闭">&times;</div>
        </div>
        <div class="quote-content" id="quote-list"></div>
        <!-- 🚨 极简底部英文 -->
        <div class="quote-footer">
            <div class="quote-poem-en">G L E A N I N G S</div>
        </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const detailOverlay = document.createElement('div');
    detailOverlay.id = 'quote-detail-overlay';
    detailOverlay.innerHTML = `
        <div class="quote-detail-panel" role="dialog" aria-modal="true" aria-label="拾遗详情">
            <button type="button" class="quote-detail-close" title="关闭">&times;</button>
            <div class="quote-detail-title"></div>
            <div class="quote-detail-meta"></div>
            <div class="quote-detail-text"></div>
        </div>
    `;
    document.body.appendChild(detailOverlay);

    const detailPanel = detailOverlay.querySelector('.quote-detail-panel');
    const detailTitle = detailOverlay.querySelector('.quote-detail-title');
    const detailMeta = detailOverlay.querySelector('.quote-detail-meta');
    const detailText = detailOverlay.querySelector('.quote-detail-text');

    // 3. 核心逻辑
    let savedQuotes = loadQuotes();
    let activeQuoteTab = 'current';
    const expandedQuoteGroups = new Set();

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

    function showQuoteDetail(quote) {
        const chat = getQuoteChatInfo(quote);
        detailTitle.textContent = `${chat.char} - ${chat.chatName}`;
        detailMeta.textContent = [
            quote.char || chat.char,
            quote.mesid !== undefined && quote.mesid !== '' ? `#${quote.mesid}` : '',
            quote.time,
        ].filter(Boolean).join(' · ');
        detailText.textContent = quote.text || '（这条拾遗没有正文）';
        detailPanel.scrollTop = 0;
        detailOverlay.classList.add('show');
    }

    function hideQuoteDetail() {
        detailOverlay.classList.remove('show');
    }

    function closeQuotePanel() {
        hideQuoteDetail();
        overlay.classList.remove('show');
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
        writeJson(QUOTES_KEY, savedQuotes);
        syncBookmarkAfterDelete(quote, chatInfo, ctx);
        renderQuotes();
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
            const targetMes = document.querySelector(`.mes[mesid="${CSS.escape(mesid)}"]`);
            if (!targetMes) return;

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

        writeJson(QUOTES_KEY, savedQuotes);
        renderQuotes();
    });

    // 5. 悬浮窗事件
    fab.addEventListener('click', () => {
        if (overlay.classList.contains('show')) {
            closeQuotePanel();
            return;
        }

        setQuoteTab('current');
        overlay.classList.add('show');
    });

    panel.querySelector('.quote-close').addEventListener('click', closeQuotePanel);
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

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;

        if (detailOverlay.classList.contains('show')) {
            hideQuoteDetail();
            return;
        }

        if (overlay.classList.contains('show')) closeQuotePanel();
    });

    // 6. 拖拽逻辑（保持不变）
    (function makeDraggable(el) {
        let isDragging = false, hasMoved = false;
        let startX, startY, initialLeft, initialTop;
        const savedPos = readJson(FAB_POS_KEY, null);
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
                writeJson(FAB_POS_KEY, { left: el.offsetLeft, top: el.offsetTop });
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
