// 公共部分：页面元素、彩种和选号方式、分段控件动画、触摸发光、加密随机数、号码球、按钮状态
const resultInner=document.getElementById("result-inner") // 结果内容元素
const typeInputs=document.querySelectorAll('input[name="type"]') // 两个彩种单选框
let isRolling=false // 是否正在生成号码
function getType(){ // 取当前选中的彩种
  return document.querySelector('input[name="type"]:checked').value // 返回选中单选框的值：ssq 或 dlt
}
const modeInputs=document.querySelectorAll('input[name="mode"]') // 两个选号方式单选框
function getMode(){ // 取当前选中的选号方式
  return document.querySelector('input[name="mode"]:checked').value // 返回 random（随机选号）或 deep（深度思考）
}
// 两个分段控件（彩种、选号方式）共用：切换时滑块播放液态拉伸动画
document.querySelectorAll(".segmented").forEach(ctl=>{ // 每个分段控件
  const thumb=ctl.querySelector(".segmented-thumb") // 它的滑块
  ctl.querySelectorAll("input").forEach(input=>input.addEventListener("change",()=>{ // 每个单选框切换时
    thumb.classList.remove("morph") // 先去掉拉伸动画的类
    void thumb.offsetWidth // 读取一次布局，强制浏览器应用上一步，才能重新播放动画
    thumb.classList.add("morph") // 加回类，播放液态拉伸动画
    if(!isRolling){ // 不在生成中时（换了彩种或选号方式，旧号码不再对应）
      resultInner.innerHTML='' // 清空结果
      resultInner.className="result-inner" // 去掉深度思考的样式
      showPickGhosts(false) // 一注卡片放回空球（个数按当前彩种）
    }
  }))
  thumb.addEventListener("animationend",()=>thumb.classList.remove("morph")) // 拉伸动画播完后去掉类
})
;(function liquidGlassTouchLight(){ // 立即执行：触摸发光
  let lit=[] // 当前亮着的元素
  function place(el,e){ // 把光晕移到手指位置
    const r=el.getBoundingClientRect() // 元素在屏幕上的位置
    el.style.setProperty("--lx",`${e.clientX-r.left}px`) // 手指相对元素左边的距离
    el.style.setProperty("--ly",`${e.clientY-r.top}px`) // 手指相对元素上边的距离
  }
  function release(){ // 熄灭所有光晕
    lit.forEach(el=>el.classList.remove("lit")) // 去掉 lit 类
    lit=[] // 清空列表
  }
  document.addEventListener("pointerdown",e=>{ // 按下时
    release() // 先熄灭上一次的
    const ctl=e.target.closest("button,.segmented") // 找到按下的按钮或分段控件
    if(!ctl) return // 不是控件就不处理
    const isSeg=ctl.matches(".segmented") // 是不是分段控件
    if(isSeg&&ctl.querySelector("input").disabled) return // 分段控件禁用时不发光
    if(ctl.disabled) return // 按钮禁用时不发光
    const surface=isSeg?ctl.querySelector(".segmented-thumb"):ctl // 分段控件让自己的滑块发光，按钮让自己发光
    lit=[surface] // 记入列表
    const panel=ctl.closest(".glass") // 所在的玻璃面板
    if(panel) lit.push(panel) // 面板也一起带亮
    lit.forEach(el=>{ // 每个要亮的元素
      place(el,e) // 光晕移到手指位置
      el.classList.add("lit") // 亮起
    })
  })
  document.addEventListener("pointermove",e=>{ // 手指移动时
    lit.forEach(el=>place(el,e)) // 光晕跟着手指走
  })
  document.addEventListener("pointerup",release) // 松手时熄灭
  document.addEventListener("pointercancel",release) // 触摸被系统打断时熄灭
})() // 立即执行函数结束
// 加密随机数（随机选号用）
const randomWord=new Uint32Array(1) // 存放一个 32 位随机数的缓冲区，重复使用
function randomIndexWork(max){ // 取 [0,max) 的无偏随机整数，按“落点”算：把 0～2^32 的随机数平均分成 max 段，随机数落在第几段就是第几个
  const size=Math.floor(0x100000000/max),limit=size*max // 每段一样宽（size 个数）；limit 以上是分不匀的尾部，落在那里要重取
  const rejected=[] // 落在尾部、作废的数
  let x // 加密随机数
  for(;;){ // 直到取到可用的数
    crypto.getRandomValues(randomWord) // 浏览器的加密随机数生成器
    x=randomWord[0] // 0～4294967295 之间的整数
    if(x<limit) break // 可用
    rejected.push(x) // 落在尾部，作废重取
  }
  return {index:Math.floor(x/size),x,rejected} // 落在第几段（从 0 数）、随机数、作废的数；x/2^32 就是落点在整条上的位置
}
function createBall(n,color){ // 创建一个号码球
  const span=document.createElement("span") // 外层：球
  span.className=`ball ${color}` // 球的样式：ball 加颜色（red 或 blue）
  const num=document.createElement("span") // 内层：数字
  num.className="ball-num" // 数字的样式（按字形居中）
  num.textContent=String(n).padStart(2,"0") // 补零成两位数
  span.appendChild(num) // 数字放进球里
  return span // 返回这个球
}
function logScroller(log){ // 过程窗口的滚动：新内容出来时自动滚到最新一行；手指往上翻看时不再自动滚动（不会被拽回），滑回底部后继续跟随；上下还有内容时边缘渐隐
  let stick=true,auto=-1 // 是否跟随最新内容、程序自己滚到的位置
  const fade=()=>{ // 上面还有内容就让顶部渐隐，下面还有内容就让底部渐隐
    log.classList.toggle("fade-top",log.scrollTop>1) // 往下滚过
    log.classList.toggle("fade-bottom",log.scrollTop+log.clientHeight<log.scrollHeight-1) // 还没滚到底
  }
  log.addEventListener("scroll",()=>{ // 滚动时
    if(Math.abs(log.scrollTop-auto)>1) stick=log.scrollHeight-log.scrollTop-log.clientHeight<24 // 是手指滑的（不是程序滚到底）：离底部不到 24px 就继续跟随，否则停住
    fade() // 更新渐隐
  },{passive:true})
  return {fade,follow(){if(stick){log.scrollTop=log.scrollHeight;auto=log.scrollTop}fade()}} // follow：有新内容时调用；记下程序滚到的位置，滚动事件里据此区分是不是手指滑的
}
function toggleButtons(disabled){ // 统一禁用或启用按钮、彩种切换和选号方式切换
  document.getElementById("generate-btn").disabled=disabled // “生成号码”按钮
  document.getElementById("save-btn").disabled=disabled // “保存图片”按钮
  typeInputs.forEach(input=>input.disabled=disabled) // 两个彩种单选框
  modeInputs.forEach(input=>input.disabled=disabled) // 两个选号方式单选框
}
