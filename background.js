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
                // 归一化：保证 url/title 为字符串；优先使用 pendingUrl 兜底（例如还未加载完成的标签页）
                const normalized = (tabs || []).map((t) => ({
                    ...t,
                    url: (t && typeof t.url === 'string' && t.url) ? t.url : (t && typeof t.pendingUrl === 'string' ? t.pendingUrl : ''),
                    title: (t && typeof t.title === 'string') ? t.title : '',
                }));
                // 需求：chrome:// 等系统页面、以及“空 tab”（无 url）也纳入管理
                sendResponse({ success: true, tabs: normalized });
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
