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
                    // Side Panel API 不可用时，自动降级为“常驻窗口版”
                    if (!chrome.sidePanel || typeof chrome.sidePanel.open !== 'function') {
                        await this.openStandaloneWindow();
                        this.showSuccess('侧边栏不可用：已打开常驻窗口');
                        return;
                    }

                    await this.openSidePanel();
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

    // 新增：标签页排序方法
    sortTabs(tabs) {
        return tabs.sort((a, b) => {
            // 首先将激活的标签页置顶
            if (a.active && !b.active) return -1;
            if (!a.active && b.active) return 1;
            
            // 获取当前窗口（通常是最近使用的窗口）
            // 这里我们假设 windowId 较大的是较新的窗口
            const currentWindowIds = [...new Set(tabs.map(tab => tab.windowId))].sort((x, y) => y - x);
            const currentWindowId = currentWindowIds[0];
            
            // 当前窗口的标签页优先
            const aIsCurrent = a.windowId === currentWindowId;
            const bIsCurrent = b.windowId === currentWindowId;
            
            if (aIsCurrent && !bIsCurrent) return -1;
            if (!aIsCurrent && bIsCurrent) return 1;
            
            // 在同一窗口内，按标签页位置排序：右边的标签页（index大的）优先
            if (a.windowId === b.windowId) {
                return b.index - a.index;
            }
            
            // 不同窗口间，按窗口ID排序（较新的窗口优先）
            return b.windowId - a.windowId;
        });
    }

    async loadTabs() {
        try {
            if (this.isStandalone) {
                // 在独立标签页模式下，通过消息获取标签页
                const response = await this.sendMessage({ action: 'getTabs' });
                if (response.success) {
                    this.tabs = this.sortTabs(response.tabs);
                    this.filteredTabs = [...this.tabs];
                } else {
                    throw new Error(response.error);
                }
            } else {
                // 在 popup 模式下，直接获取标签页
                const tabs = await chrome.tabs.query({});
                this.tabs = this.sortTabs(tabs.filter(tab => !tab.url.startsWith('chrome://')));
                this.filteredTabs = [...this.tabs];
            }
            
            // 清除关键词缓存，强制重新计算
            this.keywordCache = null;
            this.lastTabsHash = null;
            
            this.renderKeywordSuggestions();
        } catch (error) {
            console.error('加载标签页失败:', error, error && error.stack, this.tabs);
            this.showError('加载标签页失败');
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
            // 绑定 tab-item 点击事件（排除复选框）
            const tabItem = document.querySelector(`.tab-item[data-tab-id="${tab.id}"]`);
            if (tabItem) {
                tabItem.addEventListener('click', (e) => {
                    // 如果点击的是复选框，忽略
                    if (e.target.classList.contains('tab-checkbox')) return;
                    // 激活标签页
                    chrome.tabs.update(tab.id, {active: true});
                    // 激活窗口（如果不在当前窗口）
                    if (tab.windowId !== undefined) {
                        chrome.windows.update(tab.windowId, {focused: true});
                    }
                });
            }
        });
        this.syncSelectAllCheckbox();
        this.renderKeywordSuggestions();
        // 同步决定首帧布局，避免“先单列后双列”的闪动
        this.updateTwoColumnLayout();
        // 兜底：favicon/字体等晚到的布局变化，再补一次
        setTimeout(() => this.updateTwoColumnLayout(), 200);
    }

    createTabElement(tab) {
        const isSelected = this.selectedTabs.has(tab.id);
        const favicon = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23ccc"/></svg>';
        
        // 获取该窗口的标签页总数，计算相对位置
        const windowTabs = this.tabs.filter(t => t.windowId === tab.windowId);
        const totalTabsInWindow = windowTabs.length;
        const isRightSideTab = tab.index >= Math.floor(totalTabsInWindow / 2);
        
        // 添加激活标签页和位置指示器
        const activeIndicator = tab.active ? '<span class="active-indicator" title="当前激活的标签页">🔹</span>' : '';
        const positionClass = tab.active ? 'active-tab' : (isRightSideTab ? 'right-tab' : '');
        
        return `
            <div class="tab-item ${isSelected ? 'selected' : ''} ${positionClass}" data-tab-id="${tab.id}" data-tooltip="点击跳转">
                <input type="checkbox" 
                       id="tab-${tab.id}" 
                       class="tab-checkbox" 
                       ${isSelected ? 'checked' : ''}>
                <img src="${favicon}" alt="favicon" class="tab-favicon" onerror="this.style.display='none'">
                <div class="tab-content">
                    <div class="tab-title-row">
                        <span class="tab-title" title="${tab.title}">${this.escapeHtml(tab.title)}</span>
                        ${activeIndicator}
                        <span class="tab-position" title="标签页位置: ${tab.index + 1}/${totalTabsInWindow}">#${tab.index + 1}</span>
                    </div>
                    <span class="tab-url" title="${tab.url}">${this.escapeHtml(this.getDomain(tab.url))}</span>
                </div>
            </div>
        `;
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
        
        // 对筛选后的结果也进行排序
        this.filteredTabs = this.sortTabs(this.filteredTabs);
        
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
            if (!url) return '';
            const urlObj = new URL(url);
            return urlObj.hostname;
        } catch {
            return '';
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