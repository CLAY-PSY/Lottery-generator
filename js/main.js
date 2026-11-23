// 启动：绑定两个按钮，一注卡片先放空球，注册离线缓存
document.getElementById("generate-btn").onclick=()=>getMode()==="deep"?generateDeep():generateRandom() // 点击“生成号码”：按选号方式生成
showPickGhosts(false) // 打开页面时一注卡片先放空球
document.getElementById("save-btn").onclick=saveAsImage // 点击“保存图片”时保存
// 离线缓存：添加到主屏幕后，没有网络也能打开。只在网址为 http(s) 时注册，直接打开本地文件时跳过
if("serviceWorker" in navigator&&location.protocol.startsWith("http")){ // 浏览器支持且通过网址打开时
  navigator.serviceWorker.register("sw.js").catch(error=>console.warn("离线缓存注册失败:",error)) // 注册离线缓存，失败不影响使用
}
