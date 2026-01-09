// 后台服务工作者
chrome.runtime.onInstalled.addListener(() => {
    console.log('Tab Manager 扩展已安装');
});

// 供独立窗口模式（popup.html?standalone=1）使用的消息接口
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            if (!message || !message.action) {
                sendResponse({ success: false, error: 'Invalid message' });
                return;
            }

            if (message.action === 'getTabs') {
                const tabs = await chrome.tabs.query({});
                const filtered = (tabs || []).filter((t) => {
                    const url = t && typeof t.url === 'string' ? t.url : '';
                    return url && !url.startsWith('chrome://');
                });
                sendResponse({ success: true, tabs: filtered });
                return;
            }

            if (message.action === 'closeTabs') {
                const tabIds = Array.isArray(message.tabIds) ? message.tabIds : [];
                if (tabIds.length === 0) {
                    sendResponse({ success: true, closedCount: 0 });
                    return;
                }
                await chrome.tabs.remove(tabIds);
                sendResponse({ success: true, closedCount: tabIds.length });
                return;
            }

            if (message.action === 'openSidePanel') {
                // popup 页面没有 sender.tab，这里取当前激活 tab 来打开侧边栏
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!activeTab || typeof activeTab.id !== 'number') {
                    sendResponse({ success: false, error: 'No active tab found' });
                    return;
                }
                if (!chrome.sidePanel || typeof chrome.sidePanel.open !== 'function') {
                    sendResponse({ success: false, error: 'Side Panel API not available' });
                    return;
                }
                await chrome.sidePanel.open({ tabId: activeTab.id });
                sendResponse({ success: true });
                return;
            }

            sendResponse({ success: false, error: `Unknown action: ${message.action}` });
        } catch (err) {
            sendResponse({ success: false, error: String(err && err.message ? err.message : err) });
        }
    })();

    // keep the message channel open for async response
    return true;
});


// 监听标签页更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 可以在这里添加标签页更新时的逻辑
    if (changeInfo.status === 'complete') {
        console.log(`标签页 ${tabId} 加载完成: ${tab.title}`);
    }
});

// 监听标签页关闭
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    console.log(`标签页 ${tabId} 已关闭`);
});

// 监听扩展图标点击
chrome.action.onClicked.addListener((tab) => {
    // 这个事件在 manifest v3 中不常用，因为我们使用了 popup
    console.log('扩展图标被点击');
});
