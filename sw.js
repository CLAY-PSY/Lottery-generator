// 离线缓存：从主屏幕打开时，没有网络也能用
// 页面、样式、脚本、开奖历史优先联网取最新版（有更新时自动用上），断网时才用缓存；图标、图片和清单优先用缓存
const CACHE="lottery-v8" // 缓存名称：缓存的文件有变化时把版本号加 1，旧缓存会被清掉（v2 加入开奖历史，v3 加入开屏图片，v4 换新图标，v5 应用改名“幸运选号”，v8 样式和脚本拆成单独的文件；v6、v7 用过，跳过）
const FILES=[ // 安装时预先缓存的文件
  "./", // 首页
  "./index.html", // 页面本身
  "./css/base.css", // 样式
  "./css/layout.css", // 样式
  "./css/glass.css", // 样式
  "./css/controls.css", // 样式
  "./css/process.css", // 样式
  "./css/buttons.css", // 样式
  "./css/balls.css", // 样式
  "./css/landscape.css", // 样式
  "./css/save-dialog.css", // 样式
  "./css/splash.css", // 样式
  "./js/ios-app.js", // 脚本
  "./js/splash.js", // 脚本
  "./js/gestures.js", // 脚本
  "./js/common.js", // 脚本
  "./js/pick-card.js", // 脚本
  "./js/random-pick.js", // 脚本
  "./js/deep-think.js", // 脚本
  "./js/save-image.js", // 脚本
  "./js/liquid-glass.js", // 脚本
  "./js/main.js", // 脚本
  "./manifest.webmanifest", // 网页应用清单
  "./icons/apple-touch-icon.png?v=2", // 主屏幕图标（地址和页面里引用的一致，带版本号）
  "./icons/icon-192.png?v=2", // 192 图标
  "./icons/icon-512.png?v=2", // 512 图标
  "./icons/icon-maskable-512.png?v=2", // 安卓自适应图标
  "./icons/favicon-32.png?v=2", // 标签页图标
  "./images/splash.jpg", // 开屏图片
  "./data/ssq.json", // 双色球开奖历史（深度思考用）
  "./data/dlt.json" // 大乐透开奖历史
]
self.addEventListener("install",event=>{ // 安装时
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())) // 缓存全部文件，然后立即启用新版本
})
self.addEventListener("activate",event=>{ // 启用时
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())) // 删掉旧版本的缓存，并立即接管已打开的页面
})
self.addEventListener("fetch",event=>{ // 页面发出请求时
  const request=event.request // 这个请求
  if(request.method!=="GET"||new URL(request.url).origin!==location.origin) return // 只处理本站的 GET 请求
  if(request.mode==="navigate"){ // 打开页面
    // 带 no-cache 向服务器确认是否有新版：GitHub Pages 的页面在浏览器缓存里能存 10 分钟，不加的话刚发布的修改要过一会儿才生效
    event.respondWith(fetch(request.url,{cache:"no-cache",credentials:"same-origin"}).then(response=>{ // 先联网取最新版
      if(response.ok){ // 取到了
        const copy=response.clone() // 复制一份
        caches.open(CACHE).then(cache=>cache.put("./index.html",copy)) // 更新缓存里的页面
      }
      return response // 返回联网取到的页面
    }).catch(()=>caches.match("./index.html"))) // 断网时用缓存里的页面
    return // 结束
  }
  const path=new URL(request.url).pathname // 请求的路径
  if(path.includes("/data/")||/\.(css|js)$/.test(path)){ // 开奖历史（每天会更新）、样式和脚本（改代码后要马上用上）
    event.respondWith(fetch(request.url,{cache:"no-cache",credentials:"same-origin"}).then(response=>{ // 先联网取最新的
      if(response.ok){ // 取到了
        const copy=response.clone() // 复制一份
        caches.open(CACHE).then(cache=>cache.put(request,copy)) // 更新缓存
      }
      return response // 返回联网取到的
    }).catch(()=>caches.match(request,{ignoreSearch:true}))) // 断网时用缓存
    return // 结束
  }
  event.respondWith(caches.match(request).then(hit=>hit||fetch(request))) // 其他文件（图标、图片、清单）：缓存里有就用缓存，没有再联网
})
