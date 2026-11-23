// 防缩放和触摸手势（全平台一套规则）：
//   iPhone、iPad（Safari、主屏幕 App、微信等 App 里的浏览器）、安卓（Chrome、各家自带浏览器、微信）、电脑（Chrome、Edge、Firefox、Safari，鼠标、触控板、触摸屏）
// 规则：
//   1. 双击：任何地方快速点两下都拦，不放大；慢慢点两下、滑动都不拦
//   2. 缩放：任何地方都拦——手机两指捏合、电脑触控板捏合、Ctrl＋滚轮
//   3. 过程窗口随时能上下滑（生成中也能滑），快速连续滑不会断触；生成中页面其他地方不能拖
// 第一道防线是样式里的 touch-action（页面 none、过程窗口 pan-y）；这里给不认它、或者只认一部分的浏览器补第二道
;(function () { // 立即执行
  const DOUBLE_TAP_MS = 350 // 上一次点松手后，不到这么久又按下就是双击（各家浏览器判断双击放大用的时间都在 300 毫秒左右，留点余量）
  const TAP_SLOP = 10 // 手指移动不超过这么多像素算“点”，超过算“滑”
  const opt = { passive: false } // 不设为被动监听，才能拦（Chrome、安卓默认把页面上的触摸和滚轮监听当成被动的，拦不住）
  const on = (type, fn) => document.addEventListener(type, fn, opt) // 在整个页面上监听
  const stop = (e) => { if (e.cancelable) e.preventDefault() } // 能拦才拦（已经开始滚动的触摸拦不了，硬拦浏览器会报警告）
  const logOf = (e) => (e.target && e.target.closest ? e.target.closest(".deep-log") : null) // 手指按在哪个过程窗口里（不在就是 null）
  const rolling = () => typeof isRolling !== "undefined" && isRolling // 是否正在生成号码（isRolling 在 common.js 里）
  const contain = !!(window.CSS && CSS.supports && CSS.supports("overscroll-behavior", "contain")) // 浏览器认不认“滚到头不带动页面”（iOS 16 以前的 Safari 不认）

  let touch = null // 这次触摸：按下的位置和时间、有没有滑过、有没有用两根手指
  let lastTap = 0 // 上一次“点”松手的时间（滑动、两指都不算点）

  // Safari（iPhone、iPad、Mac 触控板）捏合缩放有自己的事件：直接拦
  ;["gesturestart", "gesturechange", "gestureend"].forEach((type) => on(type, stop))

  // 电脑：触控板捏合在 Chrome、Edge、Firefox 里是“按着 Ctrl 的滚轮”；鼠标 Ctrl＋滚轮、Mac 上 Firefox 的 Command＋滚轮也是缩放：都拦
  on("wheel", (e) => { if (e.ctrlKey || e.metaKey) stop(e) }) // 普通滚轮不拦，过程窗口照常滚

  on("touchstart", (e) => { // 手指按下
    if (e.touches.length > 1) { // 第二根手指也按下了：是两指缩放
      stop(e) // 拦掉
      if (touch) touch.multi = true // 这次不算点
      return // 不再往下处理
    }
    const t = e.touches[0] // 按下的手指
    touch = { x: t.clientX, y: t.clientY, at: Date.now(), moved: false, multi: false } // 记下按下的位置和时间
  })

  on("touchmove", (e) => { // 手指移动
    if (e.touches.length > 1) { stop(e); return } // 两根手指：拦掉缩放
    const t = e.touches[0] // 移动的手指
    if (touch && (Math.abs(t.clientX - touch.x) > TAP_SLOP || Math.abs(t.clientY - touch.y) > TAP_SLOP)) touch.moved = true // 移动超过 10 像素：是滑，不是点
    const log = logOf(e) // 这次触摸是不是从过程窗口里开始的
    if (log) { // 在过程窗口里滑：放行（生成中也能滑），快速连续滑也不拦
      if (!contain && touch && atEnd(log, t.clientY - touch.y)) stop(e) // 旧浏览器：窗口已经滚到头还往外滑，只会带动整个页面回弹，拦掉（往还有内容的方向滑照常）
      return // 不再往下处理
    }
    if (rolling()) stop(e) // 生成中：页面其他地方不能拖
  })

  on("touchend", (e) => { // 手指松开
    if (!touch) return // 没有记录（两根手指同时按下的）
    if (e.touches.length) { touch.multi = true; return } // 还有手指没松开（两指松开一根）：不算点
    const t = e.changedTouches[0] // 松开的手指
    const tap = !touch.multi && !touch.moved && !!t && Math.abs(t.clientX - touch.x) <= TAP_SLOP && Math.abs(t.clientY - touch.y) <= TAP_SLOP // 一根手指、几乎没动：是“点”
    if (tap && touch.at - lastTap < DOUBLE_TAP_MS) stop(e) // 上一次点松手后不到 0.35 秒又按下：是双击，拦掉（不放大，也不会连着触发两次点击）
    lastTap = tap ? Date.now() : 0 // 记下这次点松手的时间；滑动、两指不算，下一次点不会被当成双击
    touch = null // 这次触摸结束
  })

  on("touchcancel", () => { touch = null; lastTap = 0 }) // 触摸被系统打断（来电、切出 App 等）：清掉记录

  on("dblclick", stop) // 鼠标双击：不放大、不选中文字

  function atEnd(log, dy) { // 旧浏览器（不认 overscroll-behavior）用：窗口是不是已经滚到头、手指还在往外滑（不改滚动位置，不影响“跟随最新一行”）
    const max = log.scrollHeight - log.clientHeight // 最多能滚多远
    if (max <= 1) return true // 内容还不够滚：滑了只会带动页面
    if (dy > 0) return log.scrollTop <= 0 // 手指往下（看上面的内容）：已经在最上面
    if (dy < 0) return log.scrollTop >= max - 1 // 手指往上（看下面的内容）：已经在最下面
    return false // 没有上下移动
  }
})() // 立即执行函数结束
