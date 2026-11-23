// 主屏幕 App 底部白边修正：放在页面最前面加载，第一帧就生效
  // iOS 26 主屏幕 App 的问题（WebKit Bug 301108）：页面本身比屏幕矮时，iOS 把可视区域缩短一个状态栏的高度，
  // 固定定位的背景也画到那条边为止，底部露出一条与状态栏等高的空白（灵动岛机型 59px）。
  // 页面原来是 height:100%，而 100% 在这种情况下正好少了状态栏的高度，所以页面“比屏幕矮”。
  // 解决：在 iOS 主屏幕 App 里让页面至少和屏幕一样高（--screen-h，用 JS 量屏幕高度，
  // 不用 env(safe-area-inset-top)：iOS 26.1 起它可能返回 0）。见 html.ios-app 样式
  (function fitScreen(){ // 立即执行：判断是否为主屏幕 App，并在尺寸变化时更新
    const root=document.documentElement // 根元素
    const ua=navigator.userAgent // 浏览器标识
    const isIOS=/iPad|iPhone|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1) // 是否 iOS / iPadOS（iPadOS 伪装成 Mac，用触摸点数区分）
    const probe=document.createElement("div") // 用来量 CSS 的 100lvh 实际有多高
    probe.style.cssText="position:fixed;top:0;left:0;width:0;height:100vh;height:100lvh;visibility:hidden;pointer-events:none" // 不可见、不占布局；不支持 lvh 时用 vh
    function update(){ // 更新
      if(!isIOS) return // 只处理 iOS
      const landscape=innerWidth>innerHeight // 是否横屏
      const screenH=landscape?Math.min(screen.width,screen.height):Math.max(screen.width,screen.height) // 当前方向下屏幕的高度（iOS 的 screen 尺寸固定按竖屏给出）
      root.appendChild(probe) // 放进页面才能量
      const view=Math.min(innerHeight,probe.offsetHeight||innerHeight) // 视口高度：CSS 和 JS 给的取较小者
      probe.remove() // 量完移除
      const gap=screenH-view // 屏幕比视口高出的部分
      // 三种迹象任一出现就当作主屏幕 App：系统标记、显示模式、视口正好比屏幕矮一个状态栏（1～80px，再大是 Safari 工具栏或 iPad 分屏）
      const standalone=navigator.standalone===true||matchMedia("(display-mode: standalone)").matches||matchMedia("(display-mode: fullscreen)").matches // 系统给出的主屏幕 App 标记
      // 一旦认定就不再撤销：页面撑高后缺口会消失，撤销会让页面又变矮、来回跳
      if(standalone||(gap>0&&gap<=80)) root.classList.add("ios-app") // 认定为主屏幕 App
      root.style.setProperty("--screen-h",`${screenH}px`) // 当前方向的屏幕高度
      root.style.setProperty("--screen-extra",`${gap>0&&gap<=80?gap:0}px`) // 视口比屏幕矮的部分：固定背景层再往下多铺这么多（保险）
    }
    update() // 先算一次
    addEventListener("resize",update) // 旋转屏幕等尺寸变化时重新计算
  })() // 立即执行函数结束
