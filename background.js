// 后台服务工作者
chrome.runtime.onInstalled.addListener(() => {
    console.log('Tab Manager 扩展已安装');
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
