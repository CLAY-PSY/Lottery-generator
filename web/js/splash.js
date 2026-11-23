// 开屏页：页面加载好、并且至少显示 1.5 秒后，进度条走满再淡出；最多 6 秒
  (function splash(){ // 立即执行
    const el=document.getElementById("splash") // 开屏页
    const start=performance.now() // 开始时间
    const quick=matchMedia("(prefers-reduced-motion: reduce)").matches // 减弱动态效果时显示得短一些
    const MIN=quick?500:1500,MAX=6000 // 最短、最长显示时间（毫秒）
    let finished=false // 是否已经开始收尾
    function finish(){ // 收尾：进度条走满，然后淡出并移除
      if(finished) return // 只做一次
      finished=true // 标记
      el.classList.add("done") // 进度条走满（0.3 秒）
      setTimeout(()=>el.classList.add("hide"),quick?0:320) // 走满后淡出
      setTimeout(()=>{el.remove();window.__splashGone=performance.now()},quick?250:800) // 淡出后从页面移除（记下时间，测试用）
    }
    function ready(){ // 页面加载好了
      setTimeout(finish,Math.max(0,MIN-(performance.now()-start))) // 不足最短时间就再等一会儿
    }
    if(document.readyState==="complete") ready() // 已经加载好
    else addEventListener("load",ready,{once:true}) // 等页面（包括图片）加载完
    setTimeout(finish,MAX) // 保险：最多显示 6 秒
  })() // 立即执行结束
