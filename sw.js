// 离线缓存：从主屏幕打开时，没有网络也能用
// 页面优先联网取最新版（有更新时自动用上），断网时才用缓存；图标和清单优先用缓存
const CACHE="lottery-v1" // 缓存名称：缓存的文件列表有变化时把版本号加 1，旧缓存会被清掉
const FILES=[ // 安装时预先缓存的文件
  "./", // 首页
  "./index.html", // 页面本身
  "./manifest.webmanifest", // 网页应用清单
  "./icons/apple-touch-icon.png", // 主屏幕图标
  "./icons/icon-192.png", // 192 图标
  "./icons/icon-512.png", // 512 图标
  "./icons/favicon-32.png" // 标签页图标
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
    event.respondWith(fetch(request).then(response=>{ // 先联网取最新版
      if(response.ok){ // 取到了
        const copy=response.clone() // 复制一份
        caches.open(CACHE).then(cache=>cache.put("./index.html",copy)) // 更新缓存里的页面
      }
      return response // 返回联网取到的页面
    }).catch(()=>caches.match("./index.html"))) // 断网时用缓存里的页面
    return // 结束
  }
  event.respondWith(caches.match(request).then(hit=>hit||fetch(request))) // 其他文件：缓存里有就用缓存，没有再联网
})
