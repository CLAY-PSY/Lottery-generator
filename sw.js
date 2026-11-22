// 离线缓存：从主屏幕打开时，没有网络也能用
// 页面优先联网取最新版（有更新时自动用上），断网时才用缓存；图标和清单优先用缓存
const CACHE="lottery-v7" // 缓存名称：缓存的文件有变化时把版本号加 1，旧缓存会被清掉（v2 加入开奖历史，v3 加入开屏图片，v4 换新图标，v5 应用改名“幸运选号”，v6 深度思考改用本机大模型，v7 页面加跨源隔离）
const FILES=[ // 安装时预先缓存的文件
  "./", // 首页
  "./index.html", // 页面本身
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
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("lottery-")&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())) // 删掉本应用旧版本的缓存（大模型存在 webllm 开头的缓存里，不能删），并立即接管已打开的页面
})
// 跨源隔离：给页面加上 COOP / COEP 两个响应头，浏览器才允许 SharedArrayBuffer，CPU 跑大模型时才能用上多个核。
// GitHub Pages 不能自己设置响应头，所以由这里加；页面只加载本站文件和允许跨源的下载（模型文件），不受影响
function isolate(response){ // 复制一份带隔离响应头的页面响应
  if(!response||response.status===0) return response // 不透明响应改不了
  const headers=new Headers(response.headers) // 原来的响应头
  headers.set("Cross-Origin-Opener-Policy","same-origin") // 不和其他网站的窗口共用进程
  headers.set("Cross-Origin-Embedder-Policy","require-corp") // 只加载同源或明确允许跨源的资源
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers}) // 新响应
}
self.addEventListener("fetch",event=>{ // 页面发出请求时
  const request=event.request // 这个请求
  if(request.method==="GET"&&new URL(request.url).origin===location.origin&&/\/vendor\/web-llm-[^/]+\/index\.js$/.test(new URL(request.url).pathname)){ // 深度思考用的大模型库：目录带版本号、内容不会变，缓存优先，断网也能用（模型显卡程序由库自己缓存）
    event.respondWith(caches.open("webllm-lib").then(cache=>cache.match(request).then(hit=>hit||fetch(request).then(response=>{ // 缓存里有就用，没有再联网
      if(response.ok) cache.put(request,response.clone()) // 取到了就存起来
      return response // 返回
    })))) // 结束
    return // 结束
  }
  if(request.method!=="GET"||new URL(request.url).origin!==location.origin) return // 其他只处理本站的 GET 请求
  if(request.mode==="navigate"){ // 打开页面
    // 带 no-cache 向服务器确认是否有新版：GitHub Pages 的页面在浏览器缓存里能存 10 分钟，不加的话刚发布的修改要过一会儿才生效
    event.respondWith(fetch(request.url,{cache:"no-cache",credentials:"same-origin"}).then(response=>{ // 先联网取最新版
      if(response.ok){ // 取到了
        const copy=response.clone() // 复制一份
        caches.open(CACHE).then(cache=>cache.put("./index.html",copy)) // 更新缓存里的页面
      }
      return isolate(response) // 返回联网取到的页面（加上隔离响应头）
    }).catch(()=>caches.match("./index.html").then(isolate))) // 断网时用缓存里的页面
    return // 结束
  }
  if(new URL(request.url).pathname.includes("/data/")){ // 开奖历史：每天会更新
    event.respondWith(fetch(request.url,{cache:"no-cache",credentials:"same-origin"}).then(response=>{ // 先联网取最新的
      if(response.ok){ // 取到了
        const copy=response.clone() // 复制一份
        caches.open(CACHE).then(cache=>cache.put(request,copy)) // 更新缓存
      }
      return response // 返回联网取到的数据
    }).catch(()=>caches.match(request,{ignoreSearch:true}))) // 断网时用缓存
    return // 结束
  }
  event.respondWith(caches.match(request).then(hit=>hit||fetch(request))) // 其他文件：缓存里有就用缓存，没有再联网
})
