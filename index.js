// @ts-nocheck
(function() {
    console.log("✨ [绝密档案馆] 终极组内置顶版已启动！");

    setInterval(function() {
        const items = Array.from(document.querySelectorAll('.recentChat'));
        if (items.length === 0) return; 

        const container = items[0].parentElement;
        if (!container || container.style.display === 'none') return;

        // 1. 抓取标签
        const domTags = {};
        document.querySelectorAll('.character_select').forEach(card => {
            let nameEl = card.querySelector('.ch_name');
            if (!nameEl) return;
            let name = nameEl.innerText.trim();
            let tags = [];
            card.querySelectorAll('.tags .tag').forEach(t => {
                let tagName = t.innerText.replace('✕', '').trim(); 
                if (tagName) tags.push(tagName);
            });
            if (tags.length > 0) domTags[name] = tags;
        });

        // 咱们自己的置顶记录
        const pinnedChats = JSON.parse(localStorage.getItem('archive_pinned_chats') || '{}');

        // 2. 提取数据
        const grouped = {};
        items.forEach(item => {
            let charName = item.getAttribute('data-avatar') || '未知角色';
            charName = charName.replace('.png', '').replace('default_', '');
            
            let dateEl = item.querySelector('.chatDate');
            let dateStr = dateEl ? dateEl.innerText : "";
            let timeStamp = dateStr ? new Date(dateStr).getTime() : 0;
            
            let chatNameEl = item.querySelector('.chatName');
            let chatTitle = chatNameEl ? chatNameEl.innerText : "未命名存档";
            
            let avatarImg = item.querySelector('.avatar img') ? item.querySelector('.avatar img').src : '';
            let statsEl = item.querySelector('.chatStats');
            let statsHtml = statsEl ? statsEl.outerHTML : '';
            
            let renameNode = item.querySelector('.renameChat');
            let deleteNode = item.querySelector('.deleteChat');
            
            let fileKey = item.getAttribute('data-file') || chatTitle;
            let isPinned = pinnedChats[fileKey] === true;

            if (!grouped[charName]) grouped[charName] = { chats: [], tags: domTags[charName] || [], lastTime: 0 };
            grouped[charName].chats.push({ 
                fileKey: fileKey, title: chatTitle, date: dateStr, avatar: avatarImg, 
                statsHtml: statsHtml, renameNode, deleteNode, originalNode: item,
                isPinned: isPinned
            });
            grouped[charName].lastTime = Math.max(grouped[charName].lastTime, timeStamp);
        });

        // 3. 构建外层框架
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

        // 4. 渲染角色组
        const pinnedChars = JSON.parse(localStorage.getItem('archive_pinned') || '[]');
        
        Object.entries(grouped).forEach(([charName, data]) => {
            // 🚨 核心：渲染前，先把该角色下已经置顶的记录拎到最前面
            data.chats.sort((a, b) => {
                if (a.isPinned && !b.isPinned) return -1;
                if (!a.isPinned && b.isPinned) return 1;
                return 0;
            });

            const groupDiv = document.createElement('div');
            groupDiv.className = 'my-fold-group';
            groupDiv.setAttribute('data-name', charName.toLowerCase());
            groupDiv.setAttribute('data-tags', data.tags.join(',').toLowerCase());
            groupDiv.setAttribute('data-time', data.lastTime);

            const isPinnedChar = pinnedChars.includes(charName);
            if (isPinnedChar) groupDiv.setAttribute('data-pinned', 'true');

            let tagsHtml = '';
            data.tags.forEach(t => { tagsHtml += `<span class="my-tag">${t}</span>`; });

            const header = document.createElement('div');
            header.className = 'my-fold-header';
            header.innerHTML = `
                <div class="my-fold-header-left">
                    <div class="my-name-row">
                        <span class="icon">❖</span>
                        <span class="my-header-name">${charName}</span>
                    </div>
                    <div class="my-header-tags">${tagsHtml}</div>
                </div>
                <div class="my-fold-header-right">
                    <span style="font-size:11px; color:#999; margin-right:12px;">${data.chats.length} 个存档</span>
                    <i class="fa-solid fa-star my-pin-btn ${isPinnedChar ? 'pinned' : ''}" title="置顶角色"></i>
                </div>
            `;

            const pinBtn = header.querySelector('.my-pin-btn');
            pinBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                let pins = JSON.parse(localStorage.getItem('archive_pinned') || '[]');
                if (pins.includes(charName)) {
                    pins = pins.filter(p => p !== charName);
                    pinBtn.classList.remove('pinned');
                    groupDiv.removeAttribute('data-pinned');
                } else {
                    pins.push(charName);
                    pinBtn.classList.add('pinned');
                    groupDiv.setAttribute('data-pinned', 'true');
                }
                localStorage.setItem('archive_pinned', JSON.stringify(pins));
                applySortAndFilter(); 
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
                chatItem.style.cssText = "display: flex !important; align-items: center; width: 100%; padding: 10px 16px; box-sizing: border-box; border-bottom: 1px solid rgba(120,120,120,0.2); cursor: pointer;";
                
                chatItem.innerHTML = `
                    <img src="${chat.avatar}" style="width: 40px; height: 40px; border-radius: 6px; margin-right: 12px; object-fit: cover; flex-shrink: 0;">
                    <div style="flex:1; display:flex; flex-direction:column; min-width:0;">
                        <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                            <span style="font-size:14px; color:var(--SmartThemeBodyColor); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; font-family: 'Noto Serif SC', 'Songti SC', 'SimSun', serif; letter-spacing: 1px;">${chat.title}</span>
                            <div class="action-group" style="display:flex; gap:10px; flex-shrink:0; margin-left: 10px; opacity: 0.5; transition: opacity 0.2s;">
                                <i class="fa-solid fa-thumbtack chat-pin-btn ${chat.isPinned ? 'pinned' : ''}" title="置顶"></i>
                                <i class="fa-solid fa-pen-to-square" style="color: rgba(var(--SmartThemeBodyColor), 0.4);" title="编辑"></i>
                                <i class="fa-solid fa-trash" style="color: rgba(var(--SmartThemeBodyColor), 0.4);" title="删除"></i>
                            </div>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:center; width:100%; margin-top:6px;">
                            <span style="font-size:11px; color:rgba(var(--SmartThemeBodyColor),0.5); font-family: 'Courier New', Courier, monospace;">${chat.date}</span>
                            <div style="font-size:11px; color:rgba(var(--SmartThemeBodyColor),0.5); transform: scale(0.9); transform-origin: right center; font-family: 'Courier New', Courier, monospace;">${chat.statsHtml}</div>
                        </div>
                    </div>
                `;

                chatItem.addEventListener('mouseenter', () => chatItem.querySelector('.action-group').style.opacity = '1');
                chatItem.addEventListener('mouseleave', () => chatItem.querySelector('.action-group').style.opacity = '0.5');
                chatItem.addEventListener('click', () => chat.originalNode.click());

                const btns = chatItem.querySelectorAll('.action-group i');
                
                // 🚨 组内置顶逻辑：完全脱离原生
                btns[0].addEventListener('click', (e) => { 
                    e.stopPropagation(); 
                    
                    // 1. 更新咱们自己的记忆
                    let currentPinnedChats = JSON.parse(localStorage.getItem('archive_pinned_chats') || '{}');
                    let newState = !currentPinnedChats[chat.fileKey];
                    
                    if (newState) {
                        currentPinnedChats[chat.fileKey] = true;
                    } else {
                        delete currentPinnedChats[chat.fileKey];
                    }
                    localStorage.setItem('archive_pinned_chats', JSON.stringify(currentPinnedChats));

                    // 2. 立刻反转 UI
                    chatItem.classList.toggle('is-pinned-row', newState);
                    btns[0].classList.toggle('pinned', newState);

                    // 3. 🚨 实时的 DOM 移动
                    if (newState) {
                        contentInner.prepend(chatItem); // 置顶：直接飞到最前
                    } else {
                        contentInner.appendChild(chatItem); // 取消置顶：扔回最后
                    }
                });
                
                btns[1].addEventListener('click', (e) => { e.stopPropagation(); if(chat.renameNode) chat.renameNode.click(); });
                btns[2].addEventListener('click', (e) => { e.stopPropagation(); if(chat.deleteNode) chat.deleteNode.click(); });

                contentInner.appendChild(chatItem);
            });

            contentOuter.appendChild(contentInner);
            groupDiv.appendChild(header);
            groupDiv.appendChild(contentOuter);
            listContainer.appendChild(groupDiv);
        });

        // 5. 分页、搜索与排序
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

            let visibleGroups = [];
            groups.forEach(g => {
                const name = g.getAttribute('data-name');
                const tags = g.getAttribute('data-tags');
                if (name.includes(keyword) || tags.includes(keyword)) visibleGroups.push(g);
                else g.style.display = 'none'; 
            });

            visibleGroups.sort((a, b) => {
                const pinA = a.hasAttribute('data-pinned') ? 1 : 0;
                const pinB = b.hasAttribute('data-pinned') ? 1 : 0;
                if (pinA !== pinB) return pinB - pinA; 
                if (sortBy === 'time-desc') return b.getAttribute('data-time') - a.getAttribute('data-time');
                if (sortBy === 'time-asc') return a.getAttribute('data-time') - b.getAttribute('data-time');
                if (sortBy === 'name-asc') return a.getAttribute('data-name').localeCompare(b.getAttribute('data-name'));
                if (sortBy === 'name-desc') return b.getAttribute('data-name').localeCompare(a.getAttribute('data-name'));
                return 0;
            });

            const totalPages = Math.ceil(visibleGroups.length / pageSize) || 1;
            if (currentPage > totalPages) currentPage = totalPages;
            if (currentPage < 1) currentPage = 1;

            const startIndex = (currentPage - 1) * pageSize;
            const endIndex = startIndex + pageSize;

            visibleGroups.forEach((g, index) => {
                g.style.display = (index >= startIndex && index < endIndex) ? 'block' : 'none';
                listContainer.appendChild(g); 
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

        container.style.display = 'none'; 
        container.parentNode.insertBefore(wrapper, container.nextSibling);
        applySortAndFilter(true);
    }, 200); 
})();