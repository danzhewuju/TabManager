const TOP_KEYWORDS_COUNT = 5; // 可根据需要修改显示数量

class TabManager {
    constructor() {
        this.isStandalone = new URLSearchParams(window.location.search).get('standalone') === '1';
        this.isPanel = new URLSearchParams(window.location.search).get('panel') === '1';
        this.tabs = [];
        this.selectedTabs = new Set();
        this.filteredTabs = [];
        this.isRegexMode = false;
        this.isCaseSensitive = false;
        this.keywordCache = null; // 关键词缓存
        this.lastTabsHash = null; // 标签页数据哈希，用于判断是否需要重新计算
        this._layoutRaf = null;
        this._tabsRefreshTimer = null;
        this._tabsRefreshInFlight = false;
        this._tabsRefreshQueued = false;
        this._suppressClickUntil = 0;
        this.currentTabId = null; // 当前激活的 tab id（用于高亮定位）
        this.currentWindowId = null; // 当前激活 tab 所在 window id
        this._scrolledToCurrentOnce = false;
        this._drag = {
            pressTimer: null,
            active: false,
            pointerId: null,
            startX: 0,
            startY: 0,
            offsetX: 0,
            offsetY: 0,
            tabId: null,
            tabIds: [],
            windowId: null,
            sourceEl: null,
            sourceEls: [],
            placeholderEl: null,
            placeholderEls: [],
            ghostEl: null,
            cleanupMoveUp: null,
        };

        if (this.isStandalone) {
            document.documentElement.classList.add('standalone');
            document.body.classList.add('standalone');
        }
        if (this.isPanel) {
            document.documentElement.classList.add('panel');
            document.body.classList.add('panel');
        }

        this.init();
    }

    async init() {
        this.bindEvents();
        this.enableLiveTabRefresh();
        await this.loadTabs();
        this.renderTabs();
        this.updateStats();
        this.renderKeywordSuggestions();
        this.showKeyboardShortcuts();
    }

    bindEvents() {
        // 侧边栏打开（侧边栏里跳转不会关闭）
        const openSidePanelBtn = document.getElementById('openSidePanel');
        if (openSidePanelBtn) {
            openSidePanelBtn.addEventListener('click', async () => {
                try {
                    // 在 popup / 独立窗口里点击“侧边栏”后，自动关闭当前界面；
                    // 但在侧边栏自身（panel=1）里不要关闭自己。
                    const shouldCloseAfterOpen = !this.isPanel;

                    // Side Panel API 不可用时，自动降级为“常驻窗口版”
                    if (!chrome.sidePanel || typeof chrome.sidePanel.open !== 'function') {
                        await this.openStandaloneWindow();
                        if (shouldCloseAfterOpen) {
                            window.close();
                            return;
                        }
                        this.showSuccess('侧边栏不可用：已打开常驻窗口');
                        return;
                    }

                    await this.openSidePanel();
                    if (shouldCloseAfterOpen) {
                        window.close();
                        return;
                    }
                    this.showSuccess('已在侧边栏打开');
                } catch (e) {
                    this.showError(`打开侧边栏失败：${String(e && e.message ? e.message : e)}`);
                }
            });
        }

        // 全选按钮
        document.getElementById('selectAll').addEventListener('click', () => {
            this.selectAllTabs();
        });

        // 取消全选按钮
        document.getElementById('selectNone').addEventListener('click', () => {
            this.clearSelection();
        });

        // 反选按钮（对当前筛选结果逐个取反）
        const invertSelectionBtn = document.getElementById('invertSelection');
        if (invertSelectionBtn) {
            invertSelectionBtn.addEventListener('click', () => {
                this.invertSelection();
            });
        }

        // 删除选中按钮
        document.getElementById('deleteSelected').addEventListener('click', () => {
            this.deleteSelectedTabs();
        });

        // 关闭按钮
        document.getElementById('closePopup').addEventListener('click', () => {
            if (this.isStandalone) {
                window.close();
            } else {
                window.close();
            }
        });

        // 正则匹配切换按钮
        document.getElementById('regexToggle').addEventListener('click', () => {
            this.toggleRegexMode();
        });

        // 搜索功能
        document.getElementById('searchInput').addEventListener('input', (e) => {
            this.filterTabs(e.target.value);
        });

        // 键盘快捷键
        document.addEventListener('keydown', (e) => {
            this.handleKeyboardShortcuts(e);
        });

        // 全选复选框
        document.getElementById('selectAllCheckbox').addEventListener('change', (e) => {
            if (e.target.checked) {
                this.selectAllTabs();
            } else {
                this.clearSelection();
            }
            this.syncSelectAllCheckbox();
        });

        // 视口变化时重新评估是否需要两列（主要用于独立标签页模式）
        window.addEventListener('resize', () => {
            this.scheduleLayoutUpdate();
        });
    }

    // 说明：Chrome 扩展 popup 在切换焦点（激活标签页/窗口）时会自动关闭，无法阻止。
    // 如果未来需要“常驻窗口版”，可以再恢复独立窗口逻辑。

    enableLiveTabRefresh() {
        // 只有“常驻”的页面才需要实时刷新：侧边栏 & 常驻窗口
        if (!this.isPanel && !this.isStandalone) return;
        if (!chrome || !chrome.tabs) return;

        const schedule = () => this.scheduleTabsRefresh();

        // 新建/关闭/移动/跨窗口移动
        if (chrome.tabs.onCreated) chrome.tabs.onCreated.addListener(schedule);
        if (chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(schedule);
        if (chrome.tabs.onMoved) chrome.tabs.onMoved.addListener(schedule);
        if (chrome.tabs.onAttached) chrome.tabs.onAttached.addListener(schedule);
        if (chrome.tabs.onDetached) chrome.tabs.onDetached.addListener(schedule);

        // 激活标签页/切换窗口可能会影响“展示顺序”（跟随 Chrome 的返回顺序/窗口聚焦变化）
        if (chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(schedule);
        if (chrome.windows && chrome.windows.onFocusChanged) chrome.windows.onFocusChanged.addListener(schedule);

        // 更新事件很频繁：只在会影响展示的字段变化时刷新
        if (chrome.tabs.onUpdated) {
            chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
                if (!changeInfo) return;
                if (
                    changeInfo.status === 'complete' ||
                    typeof changeInfo.title === 'string' ||
                    typeof changeInfo.url === 'string' ||
                    typeof changeInfo.favIconUrl === 'string'
                ) {
                    schedule();
                }
            });
        }
    }

    scheduleTabsRefresh() {
        // 拖拽中不要刷新，避免 DOM 被重绘打断拖拽
        if (this._drag.active) {
            this._tabsRefreshQueued = true;
            return;
        }
        // 150ms 去抖：避免 onUpdated 等事件造成频繁重绘
        if (this._tabsRefreshTimer) clearTimeout(this._tabsRefreshTimer);
        this._tabsRefreshTimer = setTimeout(() => {
            this._tabsRefreshTimer = null;
            this.refreshTabsSilently();
        }, 150);
    }

    async refreshTabsSilently() {
        // 合并并发刷新：如果上一次刷新还没结束，则只排队一次
        if (this._tabsRefreshInFlight) {
            this._tabsRefreshQueued = true;
            return;
        }
        this._tabsRefreshInFlight = true;
        this._tabsRefreshQueued = false;

        try {
            const searchTerm = (document.getElementById('searchInput')?.value ?? '').toString();
            await this.loadTabs({ silent: true });

            // 剔除已不存在的选中项
            const idSet = new Set(this.tabs.map(t => t.id));
            for (const id of Array.from(this.selectedTabs)) {
                if (!idSet.has(id)) this.selectedTabs.delete(id);
            }

            // 保留当前筛选条件并刷新 UI
            this.filterTabs(searchTerm);
            this.updateDeleteButton();
        } catch (err) {
            console.warn('实时刷新标签页失败:', err);
        } finally {
            this._tabsRefreshInFlight = false;
            if (this._tabsRefreshQueued) {
                // 如果刷新过程中又来了事件，再补一次（依然走去抖）
                this.scheduleTabsRefresh();
            }
        }
    }

    scheduleLayoutUpdate() {
        if (this._layoutRaf) cancelAnimationFrame(this._layoutRaf);
        this._layoutRaf = requestAnimationFrame(() => {
            this._layoutRaf = null;
            this.updateTwoColumnLayout();
        });
    }

    updateTwoColumnLayout() {
        const tabsContainer = document.querySelector('.tabs-container');
        const tabsList = document.getElementById('tabsList');
        if (!tabsContainer || !tabsList) return;

        // 规则：如果“单列布局”会溢出（需要滚动），则启用两列。
        // 注意：两列会改变 scrollHeight，因此必须以“单列”作为判断基准，避免抖动。
        const hadTwoColumn = tabsContainer.classList.contains('two-column');
        tabsContainer.classList.remove('two-column');

        const overflowInSingleColumn = tabsContainer.scrollHeight > tabsContainer.clientHeight + 8;

        if (overflowInSingleColumn) {
            tabsContainer.classList.add('two-column');
        } else {
            tabsContainer.classList.remove('two-column');
        }

        // 如果之前是两列，但单列不溢出，则保持移除即可（上面已处理）。
        // hadTwoColumn 仅用于表达意图，防止未来改逻辑时误用。
        void hadTwoColumn;
    }

    showKeyboardShortcuts() {
        // 在独立标签页模式下显示快捷键说明
        if (this.isStandalone) {
            const shortcutsInfo = document.createElement('div');
            shortcutsInfo.className = 'shortcuts-info';
            shortcutsInfo.innerHTML = `
                <div class="shortcuts-title">全局快捷键</div>
                <div class="shortcuts-list">
                    <div class="shortcut-item">
                        <kbd>Ctrl+Shift+T</kbd> (Mac: <kbd>Cmd+Shift+T</kbd>) - 打开标签页管理器
                    </div>
                    <div class="shortcut-item">
                        <kbd>Ctrl+Shift+Delete</kbd> (Mac: <kbd>Cmd+Shift+Delete</kbd>) - 快速关闭当前标签页
                    </div>
                </div>
            `;
            
            // 插入到容器顶部
            const container = document.querySelector('.container');
            container.insertBefore(shortcutsInfo, container.firstChild);
        }
    }

    toggleRegexMode() {
        this.isRegexMode = !this.isRegexMode;
        const regexButton = document.getElementById('regexToggle');
        const regexIcon = document.getElementById('regexIcon');
        
        if (this.isRegexMode) {
            regexButton.classList.add('active');
            regexIcon.textContent = '.*';
            regexButton.title = '当前：正则匹配模式';
        } else {
            regexButton.classList.remove('active');
            regexIcon.textContent = '.*';
            regexButton.title = '当前：普通搜索模式';
        }
        
        // 重新应用当前搜索
        this.filterTabs(document.getElementById('searchInput').value);
    }

    async loadTabs({ silent = false } = {}) {
        try {
            const normalizeTab = (tab) => {
                const url =
                    (tab && typeof tab.url === 'string' && tab.url) ? tab.url :
                    (tab && typeof tab.pendingUrl === 'string' ? tab.pendingUrl : '');
                const title = (tab && typeof tab.title === 'string') ? tab.title : '';
                return { ...tab, url, title };
            };

            if (this.isStandalone) {
                // 在独立标签页模式下，通过消息获取标签页
                const response = await this.sendMessage({ action: 'getTabs' });
                if (response.success) {
                    this.tabs = (response.tabs || []).map(normalizeTab);
                    this.filteredTabs = [...this.tabs];
                } else {
                    throw new Error(response.error);
                }
            } else {
                // 在 popup 模式下，直接获取标签页
                const tabs = await chrome.tabs.query({});
                // 需求：chrome:// 等系统页面、以及“空 tab”（无 url）也纳入管理
                this.tabs = (tabs || []).map(normalizeTab);
                this.filteredTabs = [...this.tabs];
            }

            // 同步当前激活 tab（用于列表高亮/标识）
            await this.updateCurrentActiveTab();
            
            // 清除关键词缓存，强制重新计算
            this.keywordCache = null;
            this.lastTabsHash = null;
            
            this.renderKeywordSuggestions();
        } catch (error) {
            console.error('加载标签页失败:', error, error && error.stack, this.tabs);
            if (!silent) this.showError('加载标签页失败');
        }
    }

    sendMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, (response) => {
                const err = chrome.runtime.lastError;
                if (err) return reject(err);
                resolve(response);
            });
        });
    }

    async updateCurrentActiveTab() {
        try {
            if (!chrome || !chrome.tabs || typeof chrome.tabs.query !== 'function') return;

            // 优先取“最近聚焦窗口”的激活 tab（比 currentWindow 更贴近真实用户视角）
            let activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (!activeTabs || activeTabs.length === 0) {
                activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
            }

            const t = activeTabs && activeTabs[0];
            this.currentTabId = (t && typeof t.id === 'number') ? t.id : null;
            this.currentWindowId = (t && typeof t.windowId === 'number') ? t.windowId : null;
        } catch (e) {
            // 不阻断主流程：失败就不高亮
            this.currentTabId = null;
            this.currentWindowId = null;
        }
    }

    async openSidePanel() {
        if (!chrome.sidePanel || typeof chrome.sidePanel.open !== 'function') {
            throw new Error('Side Panel API not available（请升级 Chrome）');
        }

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || typeof activeTab.id !== 'number') {
            throw new Error('No active tab found');
        }

        // 先设置 side panel 的内容页（manifest 的 default_path 在部分版本/场景下不会立即生效）
        await new Promise((resolve, reject) => {
            chrome.sidePanel.setOptions(
                { tabId: activeTab.id, path: 'popup.html?panel=1', enabled: true },
                () => {
                    const err = chrome.runtime.lastError;
                    if (err) return reject(err);
                    resolve();
                }
            );
        });

        await new Promise((resolve, reject) => {
            chrome.sidePanel.open({ tabId: activeTab.id }, () => {
                const err = chrome.runtime.lastError;
                if (err) return reject(err);
                resolve();
            });
        });
    }

    async openStandaloneWindow() {
        const url = chrome.runtime.getURL('popup.html?standalone=1');
        await new Promise((resolve, reject) => {
            chrome.windows.create(
                { url, type: 'popup', width: 560, height: 720, focused: true },
                () => {
                    const err = chrome.runtime.lastError;
                    if (err) return reject(err);
                    resolve();
                }
            );
        });
    }

    renderTabs() {
        const tabsList = document.getElementById('tabsList');
        const tabsContainer = document.querySelector('.tabs-container');
        
        if (this.filteredTabs.length === 0) {
            if (tabsContainer) tabsContainer.classList.remove('two-column');
            tabsList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📄</div>
                    <p>没有找到标签页</p>
                </div>
            `;
            return;
        }

        tabsList.innerHTML = this.filteredTabs.map(tab => this.createTabElement(tab)).join('');
        
        // 绑定复选框事件
        this.filteredTabs.forEach(tab => {
            const checkbox = document.getElementById(`tab-${tab.id}`);
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    this.toggleTabSelection(tab.id, e.target.checked);
                    this.syncSelectAllCheckbox();
                });
            }
            
            // 绑定选择区域点击事件（复选框 + favicon 区域）
            const selectArea = document.querySelector(`.tab-select-area[data-tab-id="${tab.id}"]`);
            if (selectArea) {
                selectArea.addEventListener('click', (e) => {
                    if (Date.now() < this._suppressClickUntil) return;
                    // 如果点击的是复选框本身，让复选框自己处理
                    if (e.target.classList.contains('tab-checkbox')) return;
                    // 阻止事件冒泡到 tab-item（避免触发跳转）
                    e.stopPropagation();
                    // 切换选中状态
                    const newState = !this.selectedTabs.has(tab.id);
                    this.toggleTabSelection(tab.id, newState);
                    if (checkbox) checkbox.checked = newState;
                    this.syncSelectAllCheckbox();
                });
            }
            
            // 绑定 tab-item 点击事件（排除选择区域）
            const tabItem = document.querySelector(`.tab-item[data-tab-id="${tab.id}"]`);
            if (tabItem) {
                tabItem.addEventListener('click', (e) => {
                    if (Date.now() < this._suppressClickUntil) return;
                    // 如果点击的是选择区域（复选框或 favicon），忽略（已在 selectArea 处理）
                    if (e.target.closest('.tab-select-area')) return;
                    // 激活标签页
                    chrome.tabs.update(tab.id, {active: true});
                    // 激活窗口（如果不在当前窗口）
                    if (tab.windowId !== undefined) {
                        chrome.windows.update(tab.windowId, {focused: true});
                    }
                });

                // 长按拖拽排序（仅同一窗口内）
                this.bindLongPressDrag(tabItem, tab);
            }
        });
        this.syncSelectAllCheckbox();
        this.renderKeywordSuggestions();
        // 同步决定首帧布局，避免“先单列后双列”的闪动
        this.updateTwoColumnLayout();
        // 兜底：favicon/字体等晚到的布局变化，再补一次
        setTimeout(() => this.updateTwoColumnLayout(), 200);

        // 在侧边栏/常驻窗口里，首帧自动把“当前 tab”滚到可见区域（便于快速定位）
        this.maybeScrollToCurrentTab();
    }

    createTabElement(tab) {
        const isSelected = this.selectedTabs.has(tab.id);
        const isCurrent = (typeof this.currentTabId === 'number')
            && tab.id === this.currentTabId
            && (this.currentWindowId == null || tab.windowId === this.currentWindowId);
        const favicon = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23ccc"/></svg>';
        
        // 获取该窗口的标签页总数，计算位置提示
        const windowTabs = this.tabs.filter(t => t.windowId === tab.windowId);
        const totalTabsInWindow = windowTabs.length;
        
        const safeTitle = (tab.title && String(tab.title).trim().length > 0)
            ? tab.title
            : (tab.url && String(tab.url).trim().length > 0 ? tab.url : '(空白标签页)');

        return `
            <div class="tab-item ${isSelected ? 'selected' : ''} ${isCurrent ? 'is-current' : ''}" data-tab-id="${tab.id}" data-window-id="${tab.windowId}" data-tooltip="点击跳转（长按可拖动排序）">
                <div class="tab-select-area" data-tab-id="${tab.id}" title="点击选中/取消选中">
                    <input type="checkbox" 
                           id="tab-${tab.id}" 
                           class="tab-checkbox" 
                           ${isSelected ? 'checked' : ''}>
                    <img src="${favicon}" alt="favicon" class="tab-favicon" onerror="this.style.display='none'">
                </div>
                <div class="tab-content">
                    <div class="tab-title-row">
                        <span class="tab-title" title="${this.escapeHtml(safeTitle)}">${this.escapeHtml(safeTitle)}</span>
                        ${isCurrent ? '<span class="tab-current-badge" title="当前标签页">当前</span>' : ''}
                        <span class="tab-position" title="标签页位置: ${tab.index + 1}/${totalTabsInWindow}">#${tab.index + 1}</span>
                    </div>
                    <span class="tab-url" title="${this.escapeHtml(tab.url || '')}">${this.escapeHtml(this.getDomain(tab.url))}</span>
                </div>
            </div>
        `;
    }

    maybeScrollToCurrentTab() {
        if (this._scrolledToCurrentOnce) return;
        if (!this.isPanel && !this.isStandalone) return;

        const term = String(document.getElementById('searchInput')?.value ?? '').trim();
        if (term.length > 0) return;
        if (typeof this.currentTabId !== 'number') return;

        const el = document.querySelector(`.tab-item[data-tab-id="${this.currentTabId}"]`);
        if (!el) return;

        this._scrolledToCurrentOnce = true;
        setTimeout(() => {
            try {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } catch {
                el.scrollIntoView();
            }
        }, 50);
    }

    bindLongPressDrag(tabItem, tab) {
        // 搜索过滤时无法可靠计算 window 内 index（会漏掉隐藏的 tab），因此仅允许“无搜索”时拖拽
        const isFiltering = () => {
            const v = document.getElementById('searchInput')?.value ?? '';
            return String(v).trim().length > 0;
        };

        tabItem.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return; // 只响应左键/触摸
            if (this._drag.active) return;
            if (Date.now() < this._suppressClickUntil) return;

            // 点击复选框不进入拖拽
            if (e.target && (e.target.classList?.contains('tab-checkbox') || e.target.closest?.('.tab-checkbox'))) {
                return;
            }

            if (isFiltering()) {
                // 轻提示：清空搜索后再拖拽
                this.showError('请先清空搜索，再长按拖动排序');
                return;
            }

            const startX = e.clientX;
            const startY = e.clientY;
            const pointerId = e.pointerId;

            this._drag.pointerId = pointerId;
            this._drag.startX = startX;
            this._drag.startY = startY;
            this._drag.sourceEl = tabItem;
            this._drag.tabId = tab.id;
            this._drag.windowId = tab.windowId;
            this._drag.tabIds = [];
            this._drag.sourceEls = [];
            this._drag.placeholderEls = [];

            const cancelPress = () => {
                if (this._drag.pressTimer) {
                    clearTimeout(this._drag.pressTimer);
                    this._drag.pressTimer = null;
                }
            };

            const onMoveBeforeStart = (ev) => {
                if (ev.pointerId !== pointerId) return;
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (Math.hypot(dx, dy) > 8) {
                    cancelPress();
                    window.removeEventListener('pointermove', onMoveBeforeStart, true);
                    window.removeEventListener('pointerup', onUpBeforeStart, true);
                    window.removeEventListener('pointercancel', onUpBeforeStart, true);
                }
            };
            const onUpBeforeStart = (ev) => {
                if (ev.pointerId !== pointerId) return;
                cancelPress();
                window.removeEventListener('pointermove', onMoveBeforeStart, true);
                window.removeEventListener('pointerup', onUpBeforeStart, true);
                window.removeEventListener('pointercancel', onUpBeforeStart, true);
            };

            window.addEventListener('pointermove', onMoveBeforeStart, true);
            window.addEventListener('pointerup', onUpBeforeStart, true);
            window.addEventListener('pointercancel', onUpBeforeStart, true);

            // 280ms 长按进入拖拽
            this._drag.pressTimer = setTimeout(() => {
                this._drag.pressTimer = null;
                window.removeEventListener('pointermove', onMoveBeforeStart, true);
                window.removeEventListener('pointerup', onUpBeforeStart, true);
                window.removeEventListener('pointercancel', onUpBeforeStart, true);
                this.startTabDrag(e);
            }, 280);
        }, { passive: true });
    }

    startTabDrag(startEvent) {
        const sourceEl = this._drag.sourceEl;
        if (!sourceEl) return;

        const tabsList = document.getElementById('tabsList');
        if (!tabsList) return;

        // 计算“拖拽集合”：如果长按的是已选中的 tab，并且同窗口存在多选，则整体拖动
        const pressedId = this._drag.tabId;
        const pressedWindowId = this._drag.windowId;
        const selectedInSameWindow = Array.from(this.selectedTabs).filter((id) => {
            const t = this.tabs.find(x => x.id === id);
            return t && t.windowId === pressedWindowId;
        });

        const isPressedSelected = pressedId != null && this.selectedTabs.has(pressedId);
        const dragIds = (isPressedSelected && selectedInSameWindow.length > 1)
            ? selectedInSameWindow
            : [pressedId];

        this._drag.tabIds = dragIds.filter((x) => typeof x === 'number');
        this._drag.sourceEls = this._drag.tabIds
            .map((id) => document.querySelector(`.tab-item[data-tab-id="${id}"]`))
            .filter(Boolean);

        // 如果没找到对应 DOM（极少数情况下），回退为单个
        if (this._drag.sourceEls.length === 0) {
            this._drag.tabIds = [pressedId];
            this._drag.sourceEls = [sourceEl];
        }

        const rect = sourceEl.getBoundingClientRect();
        this._drag.offsetX = startEvent.clientX - rect.left;
        this._drag.offsetY = startEvent.clientY - rect.top;

        // placeholders（支持多选整体拖动：用 N 个占位块表示）
        const placeholders = this._drag.tabIds.map(() => {
            const ph = document.createElement('div');
            ph.className = 'tab-item tab-drag-placeholder';
            ph.setAttribute('data-window-id', String(this._drag.windowId));
            ph.style.height = `${rect.height}px`;
            ph.style.width = `${rect.width}px`;
            return ph;
        });
        this._drag.placeholderEls = placeholders;
        this._drag.placeholderEl = placeholders[0] || null;
        // 把 placeholders 插到 sourceEl 后面，保持拖拽的“插入点”默认在原位置附近
        let insertRef = sourceEl.nextSibling;
        placeholders.forEach((ph) => {
            tabsList.insertBefore(ph, insertRef);
        });

        // ghost
        const ghost = sourceEl.cloneNode(true);
        ghost.classList.add('tab-drag-ghost');
        if (this._drag.tabIds.length > 1) {
            const badge = document.createElement('div');
            badge.className = 'tab-drag-badge';
            badge.textContent = `${this._drag.tabIds.length} 个`;
            ghost.appendChild(badge);
        }
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        ghost.style.left = `${rect.left}px`;
        ghost.style.top = `${rect.top}px`;
        ghost.style.transform = 'translate3d(0,0,0)';
        ghost.style.pointerEvents = 'none';
        document.body.appendChild(ghost);
        this._drag.ghostEl = ghost;

        // hide sources from layout（不参与 index 计算）
        this._drag.sourceEls.forEach((el) => {
            el.classList.add('tab-drag-hidden');
            el.style.display = 'none';
        });
        tabsList.classList.add('is-dragging');

        this._drag.active = true;

        const onMove = (e) => this.updateTabDrag(e);
        const onUp = (e) => this.endTabDrag(e);
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
        this._drag.cleanupMoveUp = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
        };
    }

    updateTabDrag(e) {
        if (!this._drag.active) return;
        if (this._drag.pointerId !== null && e.pointerId !== this._drag.pointerId) return;

        const ghost = this._drag.ghostEl;
        const placeholder = this._drag.placeholderEl;
        const placeholders = this._drag.placeholderEls;
        const windowId = String(this._drag.windowId);
        if (!ghost || !placeholder || !placeholders || placeholders.length === 0) return;

        const x = e.clientX - this._drag.offsetX;
        const y = e.clientY - this._drag.offsetY;
        ghost.style.transform = `translate3d(${x - parseFloat(ghost.style.left)}px, ${y - parseFloat(ghost.style.top)}px, 0)`;

        const el = document.elementFromPoint(e.clientX, e.clientY);
        const overItem = el && el.closest ? el.closest('.tab-item') : null;
        if (!overItem) return;
        if (overItem === placeholder) return;
        if (overItem.classList.contains('tab-drag-ghost') || overItem.classList.contains('tab-drag-placeholder')) return;
        if (overItem.classList.contains('tab-drag-hidden')) return;
        if ((overItem.getAttribute('data-window-id') ?? '') !== windowId) return; // 只允许同一窗口内拖拽

        const rect = overItem.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        const parent = overItem.parentNode;
        if (!parent) return;

        const ensureContiguousPlaceholders = () => {
            // 把剩余 placeholders 放到 anchor 后面，保持块状连续
            for (let i = placeholders.length - 1; i >= 1; i--) {
                parent.insertBefore(placeholders[i], placeholder.nextSibling);
            }
        };

        if (before) {
            if (placeholder !== overItem.previousSibling) {
                parent.insertBefore(placeholder, overItem);
                ensureContiguousPlaceholders();
            }
        } else {
            if (placeholder !== overItem.nextSibling) {
                parent.insertBefore(placeholder, overItem.nextSibling);
                ensureContiguousPlaceholders();
            }
        }
    }

    async endTabDrag(e) {
        if (!this._drag.active) return;
        if (this._drag.pointerId !== null && e.pointerId !== this._drag.pointerId) return;

        const tabsList = document.getElementById('tabsList');
        const placeholder = this._drag.placeholderEl;
        const placeholders = this._drag.placeholderEls;
        const sourceEl = this._drag.sourceEl;
        const ghost = this._drag.ghostEl;
        const tabId = this._drag.tabId;
        const tabIds = this._drag.tabIds;
        const windowId = this._drag.windowId;

        // 先清理事件监听
        if (this._drag.cleanupMoveUp) this._drag.cleanupMoveUp();
        this._drag.cleanupMoveUp = null;

        // 防止拖拽结束触发 click 激活
        this._suppressClickUntil = Date.now() + 400;

        try {
            if (!tabsList || !placeholder || windowId == null) return;

            // 计算 placeholder 在同一窗口 tab 的顺序位置（0-based index）
            const items = Array.from(tabsList.querySelectorAll('.tab-item'))
                .filter((el) => !el.classList.contains('tab-drag-hidden'));
            const sameWindow = items.filter((el) => (el.getAttribute('data-window-id') ?? '') === String(windowId));
            const newIndex = sameWindow.findIndex((el) => el === placeholder);
            if (newIndex >= 0) {
                // 多选整体拖动：按当前 index 升序保持相对顺序
                const idsToMove = Array.isArray(tabIds) && tabIds.length > 0 ? tabIds : (tabId != null ? [tabId] : []);
                const sortedIds = idsToMove
                    .map((id) => this.tabs.find(t => t.id === id))
                    .filter((t) => t && t.windowId === windowId)
                    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
                    .map((t) => t.id);

                if (sortedIds.length > 0) {
                    await chrome.tabs.move(sortedIds, { windowId, index: newIndex });
                }
            }
        } catch (err) {
            console.warn('拖拽移动标签页失败:', err);
            this.showError('拖拽调整标签页失败');
        } finally {
            // UI 清理：移除 ghost/placeholder，恢复 source（随后刷新会重绘）
            if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
            if (Array.isArray(placeholders)) {
                placeholders.forEach((ph) => {
                    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
                });
            } else if (placeholder && placeholder.parentNode) {
                placeholder.parentNode.removeChild(placeholder);
            }
            // 恢复隐藏的源元素（即使马上会 refresh 重绘，也先恢复以防闪烁）
            this._drag.sourceEls.forEach((el) => {
                el.style.display = '';
                el.classList.remove('tab-drag-hidden');
            });
            void sourceEl;
            if (tabsList) tabsList.classList.remove('is-dragging');

            this._drag.active = false;
            this._drag.pointerId = null;
            this._drag.tabId = null;
            this._drag.tabIds = [];
            this._drag.windowId = null;
            this._drag.sourceEl = null;
            this._drag.sourceEls = [];
            this._drag.placeholderEl = null;
            this._drag.placeholderEls = [];
            this._drag.ghostEl = null;

            // 结束后强制刷新一次，确保 index/顺序与浏览器一致
            await this.refreshTabsSilently();
        }
    }

    toggleTabSelection(tabId, isSelected) {
        if (isSelected) {
            this.selectedTabs.add(tabId);
        } else {
            this.selectedTabs.delete(tabId);
        }
        
        this.updateStats();
        this.updateDeleteButton();
        this.updateTabItemStyle(tabId, isSelected);
    }

    selectAllTabs() {
        this.filteredTabs.forEach(tab => {
            this.selectedTabs.add(tab.id);
        });
        this.renderTabs();
        this.syncSelectAllCheckbox();
        this.updateStats();
        this.updateDeleteButton();
    }

    clearSelection() {
        // 只取消当前筛选结果的选中状态
        this.filteredTabs.forEach(tab => {
            this.selectedTabs.delete(tab.id);
        });
        this.renderTabs();
        this.syncSelectAllCheckbox();
        this.updateStats();
        this.updateDeleteButton();
    }

    invertSelection() {
        // 只对当前筛选结果反选，不影响未显示的标签页
        this.filteredTabs.forEach(tab => {
            if (this.selectedTabs.has(tab.id)) {
                this.selectedTabs.delete(tab.id);
            } else {
                this.selectedTabs.add(tab.id);
            }
        });
        this.renderTabs();
        this.syncSelectAllCheckbox();
        this.updateStats();
        this.updateDeleteButton();
    }

    async deleteSelectedTabs() {
        if (this.selectedTabs.size === 0) return;

        const confirmed = confirm(`确定要删除选中的 ${this.selectedTabs.size} 个标签页吗？`);
        if (!confirmed) return;

        try {
            const tabIds = Array.from(this.selectedTabs);
            
            if (this.isStandalone) {
                // 在独立标签页模式下，通过消息关闭标签页
                const response = await this.sendMessage({ 
                    action: 'closeTabs', 
                    tabIds: tabIds 
                });
                
                if (response.success) {
                    // 从本地数据中移除已删除的标签页
                    this.tabs = this.tabs.filter(tab => !this.selectedTabs.has(tab.id));
                    this.selectedTabs.clear();
                    
                    // 清除关键词缓存
                    this.keywordCache = null;
                    this.lastTabsHash = null;
                    
                    this.filterTabs(document.getElementById('searchInput').value);
                    this.renderTabs();
                    this.updateStats();
                    this.updateDeleteButton();
                    this.renderKeywordSuggestions();
                    
                    this.showSuccess(`成功删除 ${response.closedCount} 个标签页`);
                } else {
                    throw new Error(response.error);
                }
            } else {
                // 在 popup 模式下，直接关闭标签页
                await chrome.tabs.remove(tabIds);
                
                // 从本地数据中移除已删除的标签页
                this.tabs = this.tabs.filter(tab => !this.selectedTabs.has(tab.id));
                this.selectedTabs.clear();
                
                // 清除关键词缓存
                this.keywordCache = null;
                this.lastTabsHash = null;
                
                this.filterTabs(document.getElementById('searchInput').value);
                this.renderTabs();
                this.updateStats();
                this.updateDeleteButton();
                this.renderKeywordSuggestions();
                
                this.showSuccess(`成功删除 ${tabIds.length} 个标签页`);
            }
        } catch (error) {
            console.error('删除标签页失败:', error);
            this.showError('删除标签页失败');
        }
    }

    filterTabs(searchTerm) {
        if (!searchTerm.trim()) {
            this.filteredTabs = [...this.tabs];
        } else {
            if (this.isRegexMode) {
                this.filteredTabs = this.tabs.filter(tab => this.matchesRegex(tab, searchTerm));
            } else {
                const term = this.isCaseSensitive ? searchTerm : searchTerm.toLowerCase();
                this.filteredTabs = this.tabs.filter(tab => {
                    const title = this.isCaseSensitive ? tab.title : tab.title.toLowerCase();
                    const url = this.isCaseSensitive ? tab.url : tab.url.toLowerCase();
                    return title.includes(term) || url.includes(term);
                });
            }
        }

        this.renderTabs();
        this.updateStats();
        this.renderKeywordSuggestions();
    }

    matchesRegex(tab, pattern) {
        try {
            const flags = this.isCaseSensitive ? 'g' : 'gi';
            const regex = new RegExp(pattern, flags);
            
            return regex.test(tab.title) || regex.test(tab.url);
        } catch (error) {
            // 如果正则表达式无效，回退到普通搜索
            console.warn('无效的正则表达式:', pattern);
            const term = this.isCaseSensitive ? pattern : pattern.toLowerCase();
            const title = this.isCaseSensitive ? tab.title : tab.title.toLowerCase();
            const url = this.isCaseSensitive ? tab.url : tab.url.toLowerCase();
            return title.includes(term) || url.includes(term);
        }
    }

    updateStats() {
        const selectedCount = document.getElementById('selectedCount');
        const totalCount = document.getElementById('totalCount');
        
        selectedCount.textContent = `已选择: ${this.selectedTabs.size}`;
        totalCount.textContent = `总计: ${this.tabs.length}`;
    }

    updateDeleteButton() {
        const deleteButton = document.getElementById('deleteSelected');
        const count = this.selectedTabs.size;
        
        deleteButton.textContent = `删除选中 (${count})`;
        deleteButton.disabled = count === 0;
    }

    updateTabItemStyle(tabId, isSelected) {
        const tabItem = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (tabItem) {
            if (isSelected) {
                tabItem.classList.add('selected');
            } else {
                tabItem.classList.remove('selected');
            }
        }
    }

    handleKeyboardShortcuts(e) {
        // Ctrl/Cmd + A: 全选
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            this.selectAllTabs();
        }
        
        // Delete: 删除选中
        if (e.key === 'Delete' && this.selectedTabs.size > 0) {
            e.preventDefault();
            this.deleteSelectedTabs();
        }
        
        // Escape: 关闭弹窗
        if (e.key === 'Escape') {
            window.close();
        }

        // Ctrl/Cmd + R: 切换正则模式
        if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
            e.preventDefault();
            this.toggleRegexMode();
        }
    }

    getDomain(url) {
        try {
            if (!url) return '(空白标签页)';
            if (url === 'about:blank') return 'about:blank';
            const urlObj = new URL(url);
            // about: / file: 等 scheme 没有 hostname，用 “protocol + pathname” 做展示
            if (!urlObj.hostname) {
                const protocol = urlObj.protocol ? urlObj.protocol.replace(/:$/, '') : '';
                const path = urlObj.pathname || urlObj.href || '';
                return protocol ? `${protocol}:${path}` : (path || url);
            }
            return urlObj.hostname;
        } catch {
            return url ? String(url) : '(空白标签页)';
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showSuccess(message) {
        this.showNotification(message, 'success');
    }

    showError(message) {
        this.showNotification(message, 'error');
    }

    showNotification(message, type) {
        // 创建通知元素
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 6px;
            color: white;
            font-size: 14px;
            z-index: 1000;
            animation: slideIn 0.3s ease;
            background-color: ${type === 'success' ? '#28a745' : '#dc3545'};
        `;

        document.body.appendChild(notification);

        // 3秒后自动移除
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    }

    // 新增：同步全选复选框状态
    syncSelectAllCheckbox() {
        const selectAllCheckbox = document.getElementById('selectAllCheckbox');
        if (!selectAllCheckbox) return;
        const allSelected = this.filteredTabs.length > 0 && this.filteredTabs.every(tab => this.selectedTabs.has(tab.id));
        selectAllCheckbox.checked = allSelected;
    }

    // 计算标签页数据哈希，用于判断是否需要重新计算关键词
    calculateTabsHash() {
        if (!this.tabs.length) return '';
        
        // 创建一个简化的标签页数据用于哈希计算
        const tabsData = this.tabs.map(tab => ({
            id: tab.id,
            url: tab.url,
            title: tab.title
        }));
        
        // 简单的哈希算法
        return JSON.stringify(tabsData).split('').reduce((hash, char) => {
            return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
        }, 0).toString(36);
    }

    // 关键词提取与渲染
    extractKeywords() {
        // 检查缓存是否有效
        const currentHash = this.calculateTabsHash();
        if (this.keywordCache && this.lastTabsHash === currentHash) {
            return this.keywordCache;
        }

        const siteMap = new Map(); // 主域名 => { domainKeyword, titleKeywords, tabIds }
        const stopWords = new Set([
            'www', 'com', 'cn', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'uk', 'us', 'de', 'fr', 'jp', 'ru', 'br', 'in', 'it', 'au', 'ca', 'mx', 'kr', 'es', 'se', 'nl', 'ch', 'at', 'be', 'dk', 'no', 'pl', 'pt', 'tr', 'ar', 'cl', 'pe', 've', 'co', 'ec', 'bo', 'py', 'uy', 'gy', 'sr', 'gf', 'pf', 'nc', 're', 'yt', 'pm', 'wf', 'tf', 'bl', 'mf', 'sx', 'cw', 'aw', 'bq', 'cw', 'sx', 'bq', 'aw', 'mf', 'bl', 'pm', 'yt', 're', 'nc', 'pf', 'gf', 'sr', 'gy', 'uy', 'py', 'bo', 'ec', 'co', 've', 'pe', 'cl', 'ar', 'tr', 'pt', 'pl', 'no', 'dk', 'be', 'at', 'ch', 'nl', 'se', 'es', 'kr', 'mx', 'ca', 'au', 'it', 'in', 'br', 'ru', 'jp', 'fr', 'de', 'us', 'uk', 'io', 'mil', 'gov', 'edu', 'org', 'net', 'cn', 'com', 'www'
        ]);
        const commonSubdomains = new Set(['www', 'm', 'mobile', 'app', 'api', 'cdn', 'static', 'img', 'images', 'js', 'css', 'blog', 'shop', 'store', 'news', 'help', 'support', 'docs', 'dev', 'test', 'staging', 'beta', 'alpha']);

        // 域名关键词提取，返回主域名关键词和主域名
        const extractDomainKeywordAndRoot = (hostname) => {
            if (!hostname) return { root: null, keyword: null };
            hostname = hostname.split(':')[0];
            const parts = hostname.split('.').filter(part => part.length > 0);
            if (parts.length === 0) return { root: null, keyword: null };
            let keyword = null;
            let root = null;
            if (parts.length === 1) {
                keyword = parts[0];
                root = parts[0];
            } else if (parts.length === 2) {
                keyword = parts[0];
                root = parts[0];
            } else {
                if (commonSubdomains.has(parts[0])) {
                    keyword = parts[1];
                    root = parts.slice(-2).join('.');
                } else if (parts.length >= 3 && commonSubdomains.has(parts[1])) {
                    keyword = parts[0];
                    root = parts.slice(-2).join('.');
                } else {
                    keyword = parts[parts.length - 2];
                    root = parts.slice(-2).join('.');
                }
            }
            if (!keyword || stopWords.has(keyword.toLowerCase()) || keyword.length < 2) {
                return { root: null, keyword: null };
            }
            return { root: keyword.toLowerCase(), keyword: keyword.toLowerCase() };
        };

        // 标题关键词提取
        const extractTitleKeywords = (title) => {
            if (!title) return [];
            const cleanTitle = title.replace(/[^\w\s\u4e00-\u9fff]/g, ' ').toLowerCase();
            const words = cleanTitle.split(/\s+/).filter(word => {
                return word.length >= 2 && !stopWords.has(word) && !/^\d+$/.test(word);
            });
            const wordCount = {};
            words.forEach(word => {
                wordCount[word] = (wordCount[word] || 0) + 1;
            });
            return Object.entries(wordCount)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 1) // 只取一个标题关键词
                .map(([word, count]) => ({ word, count }));
        };

        // 以主域名为分组依据
        this.tabs.forEach(tab => {
            try {
                const hostname = tab.url ? this.getDomain(tab.url) : '';
                const { root, keyword: domainKeyword } = extractDomainKeywordAndRoot(hostname);
                if (!root) return;
                if (!siteMap.has(root)) {
                    siteMap.set(root, { domainKeyword: null, titleKeywords: [], tabIds: [] });
                }
                const group = siteMap.get(root);
                group.tabIds.push(tab.id);
                // 域名关键词
                if (!group.domainKeyword && domainKeyword) {
                    group.domainKeyword = domainKeyword;
                }
                // 标题关键词
                if (tab.title) {
                    const tkArr = extractTitleKeywords(tab.title);
                    tkArr.forEach(({ word }) => {
                        if (!group.titleKeywords.includes(word)) {
                            group.titleKeywords.push(word);
                        }
                    });
                }
            } catch (e) {
                // 跳过异常 tab
            }
        });

        // 只保留每个主域名一个关键词，优先域名
        const keywordList = [];
        for (const [root, group] of siteMap.entries()) {
            if (group.domainKeyword) {
                keywordList.push({
                    keyword: group.domainKeyword,
                    count: group.tabIds.length,
                    tabIds: group.tabIds,
                    type: 'domain'
                });
            } else if (group.titleKeywords.length > 0) {
                keywordList.push({
                    keyword: group.titleKeywords[0],
                    count: group.tabIds.length,
                    tabIds: group.tabIds,
                    type: 'title'
                });
            }
        }

        // 按数量排序，取前N个
        const result = keywordList.sort((a, b) => b.count - a.count).slice(0, TOP_KEYWORDS_COUNT);
        this.keywordCache = result;
        this.lastTabsHash = currentHash;
        return result;
    }

    renderKeywordSuggestions() {
        const container = document.getElementById('keywordSuggestions');
        if (!container) return;
        const keywords = this.extractKeywords();
        if (keywords.length === 0) {
            container.innerHTML = '';
            return;
        }
        
        // 计算最大最小数量
        const counts = keywords.map(k => k.count);
        const maxCount = Math.max(...counts);
        const minCount = Math.min(...counts);
        
        // 改进的颜色插值函数：根据关键词类型和数量设置不同颜色
        function getKeywordStyle(keyword) {
            const count = keyword.count;
            let baseColor, textColor, borderColor;
            
            if (keyword.type === 'domain') {
                // 域名关键词：蓝色系
                if (maxCount === minCount) {
                    baseColor = '#e3f2fd';
                    textColor = '#1976d2';
                    borderColor = '#bbdefb';
                } else {
                    const intensity = (count - minCount) / (maxCount - minCount);
                    const lightness = 95 - intensity * 15; // 95% -> 80%
                    baseColor = `hsl(210, 100%, ${lightness}%)`;
                    textColor = '#1976d2';
                    borderColor = `hsl(210, 100%, ${lightness - 10}%)`;
                }
            } else {
                // 标题关键词：绿色系
                if (maxCount === minCount) {
                    baseColor = '#e8f5e8';
                    textColor = '#2e7d32';
                    borderColor = '#c8e6c9';
                } else {
                    const intensity = (count - minCount) / (maxCount - minCount);
                    const lightness = 95 - intensity * 15; // 95% -> 80%
                    baseColor = `hsl(120, 100%, ${lightness}%)`;
                    textColor = '#2e7d32';
                    borderColor = `hsl(120, 100%, ${lightness - 10}%)`;
                }
            }
            
            return `background: ${baseColor}; color: ${textColor}; border: 1px solid ${borderColor};`;
        }
        
        container.innerHTML = keywords.map(k => {
            const allSelected = k.tabIds.every(id => this.selectedTabs.has(id));
            const typeIcon = k.type === 'domain' ? '🌐' : '📄';
            const typeClass = k.type === 'domain' ? 'domain-keyword' : 'title-keyword';
            
            return `
                <button class="keyword-btn ${typeClass}${allSelected ? ' active' : ''}" 
                        data-keyword="${k.keyword}" 
                        data-type="${k.type}"
                        title="${k.type === 'domain' ? '域名关键词' : '标题关键词'}: ${k.keyword} (${k.count}个标签页)" 
                        style="${getKeywordStyle(k)}">
                    <span class="keyword-icon">${typeIcon}</span>
                    <span class="keyword-text">${k.keyword}</span>
                    <span class="keyword-count">(${k.count})</span>
                </button>
            `;
        }).join('');
        
        // 绑定点击事件
        container.querySelectorAll('.keyword-btn').forEach(btn => {
            btn.onclick = (e) => {
                const keyword = btn.getAttribute('data-keyword');
                const k = keywords.find(x => x.keyword === keyword);
                if (k && k.tabIds.every(id => this.selectedTabs.has(id))) {
                    // 如果全部已选中，则取消选中
                    k.tabIds.forEach(id => this.selectedTabs.delete(id));
                } else if (k) {
                    // 否则选中所有相关标签页
                    k.tabIds.forEach(id => this.selectedTabs.add(id));
                }
                this.renderTabs();
                this.syncSelectAllCheckbox();
                this.updateStats();
                this.updateDeleteButton();
                this.renderKeywordSuggestions();
            };
        });
    }
}

// 添加动画样式
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new TabManager();
}); 