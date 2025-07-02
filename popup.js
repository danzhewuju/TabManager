class TabManager {
    constructor() {
        this.tabs = [];
        this.selectedTabs = new Set();
        this.filteredTabs = [];
        this.isRegexMode = false;
        this.isCaseSensitive = false;
        this.init();
    }

    async init() {
        this.bindEvents();
        await this.loadTabs();
        this.renderTabs();
        this.updateStats();
        this.showKeyboardShortcuts();
    }

    bindEvents() {
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

    async loadTabs() {
        try {
            if (this.isStandalone) {
                // 在独立标签页模式下，通过消息获取标签页
                const response = await this.sendMessage({ action: 'getTabs' });
                if (response.success) {
                    this.tabs = response.tabs;
                    this.filteredTabs = [...this.tabs];
                } else {
                    throw new Error(response.error);
                }
            } else {
                // 在 popup 模式下，直接获取标签页
                const tabs = await chrome.tabs.query({});
                this.tabs = tabs.filter(tab => !tab.url.startsWith('chrome://'));
                this.filteredTabs = [...this.tabs];
            }
        } catch (error) {
            console.error('加载标签页失败:', error);
            this.showError('加载标签页失败');
        }
    }

    sendMessage(message) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(message, (response) => {
                resolve(response);
            });
        });
    }

    renderTabs() {
        const tabsList = document.getElementById('tabsList');
        
        if (this.filteredTabs.length === 0) {
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
        });
        this.syncSelectAllCheckbox();
    }

    createTabElement(tab) {
        const isSelected = this.selectedTabs.has(tab.id);
        const favicon = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23ccc"/></svg>';
        
        return `
            <div class="tab-item ${isSelected ? 'selected' : ''}" data-tab-id="${tab.id}">
                <input type="checkbox" 
                       id="tab-${tab.id}" 
                       class="tab-checkbox" 
                       ${isSelected ? 'checked' : ''}>
                <img src="${favicon}" alt="favicon" class="tab-favicon" onerror="this.style.display='none'">
                <div class="tab-content">
                    <div class="tab-title" title="${tab.title}">${this.escapeHtml(tab.title)}</div>
                    <div class="tab-url" title="${tab.url}">${this.escapeHtml(this.getDomain(tab.url))}</div>
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
                    
                    this.filterTabs(document.getElementById('searchInput').value);
                    this.renderTabs();
                    this.updateStats();
                    this.updateDeleteButton();
                    
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
                
                this.filterTabs(document.getElementById('searchInput').value);
                this.renderTabs();
                this.updateStats();
                this.updateDeleteButton();
                
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
        totalCount.textContent = `总计: ${this.filteredTabs.length}`;
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
            const urlObj = new URL(url);
            return urlObj.hostname;
        } catch {
            return url;
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