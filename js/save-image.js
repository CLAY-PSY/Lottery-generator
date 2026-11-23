// 保存图片：把中间的一注画成图片；iPhone、iPad 弹出预览长按保存，其他设备直接下载
function formatDateLocal(date){ // 时间格式化为 2026-10-30_123456
  const y=date.getFullYear() // 年
  const m=String(date.getMonth()+1).padStart(2,"0") // 月，补零
  const d=String(date.getDate()).padStart(2,"0") // 日，补零
  const h=String(date.getHours()).padStart(2,"0") // 时，补零
  const min=String(date.getMinutes()).padStart(2,"0") // 分，补零
  const s=String(date.getSeconds()).padStart(2,"0") // 秒，补零
  return `${y}-${m}-${d}_${h}${min}${s}` // 拼成字符串
}
// 导出图片直接用 Canvas 画：版式与原来的截图一致，配色随当前深浅模式。
// 不用 html2canvas 截图：它按自己估算的字体基线画字，iPhone 的苹方、SF 字体上数字会明显偏下
const EXPORT_LAYOUT={ball:28,gap:8,rowGap:12,padX:16,padY:20,titleSize:16,titleHeight:22,titleGap:16,numberSize:13.6} // 导出图片的版式：球直径、球间距、行间距、左右留白、上下留白、标题字号、标题行高、标题与号码的间距、数字字号
// 按字形实际的上下边界垂直居中，不依赖各字体不同的基线和行高
function fillTextCentered(ctx,text,x,cy){ // 在 (x, cy) 处画文字，按字形上下边界垂直居中
  ctx.textBaseline="alphabetic" // 以字母基线为准
  const m=ctx.measureText(text) // 量出文字的尺寸
  if(m.actualBoundingBoxAscent!==undefined){ // 浏览器支持字形的实际上下边界时
    ctx.fillText(text,x,cy+(m.actualBoundingBoxAscent-m.actualBoundingBoxDescent)/2) // 基线下移半个（上沿高度 − 下沿深度），让字形正好居中
  }else{ // 不支持时
    ctx.textBaseline="middle" // 退回以行框中线为准
    ctx.fillText(text,x,cy) // 画文字
  }
}
// 把 CSS 的 linear-gradient(角度, 颜色 位置%, ...) 换成 Canvas 渐变，渐变线长度与 CSS 的算法相同
function canvasLinearGradient(ctx,css,width,height){ // CSS 线性渐变 → Canvas 渐变
  const angle=parseFloat((css.match(/([\d.]+)deg/)||[0,180])[1])*Math.PI/180 // 取角度并换成弧度，没写时默认 180 度（从上到下）
  const dx=Math.sin(angle) // 渐变方向的 x 分量（CSS 0 度朝上，顺时针）
  const dy=-Math.cos(angle) // 渐变方向的 y 分量
  const half=(Math.abs(width*dx)+Math.abs(height*dy))/2 // 渐变线的半长：让渐变刚好覆盖整个矩形的角
  const g=ctx.createLinearGradient(width/2-dx*half,height/2-dy*half,width/2+dx*half,height/2+dy*half) // 从中心沿方向往两边各延伸半长，建立渐变
  for(const m of css.matchAll(/(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s+([\d.]+)%/gi)) g.addColorStop(parseFloat(m[2])/100,m[1]) // 逐个取出“颜色 位置%”，加为色标
  return g // 返回渐变
}
// 与 .red、.blue 的 radial-gradient(circle at 32% 26%, ...) 相同，半径到最远的角；投影与页面上的号码球相同
function drawExportBall(ctx,theme,scale,color,number,x,y,r){ // 画一个导出图片里的号码球
  const gx=x-r+2*r*.32 // 高光中心 x：球左边 + 32% 直径
  const gy=y-r+2*r*.26 // 高光中心 y：球上边 + 26% 直径
  const g=ctx.createRadialGradient(gx,gy,0,gx,gy,Math.hypot(x+r-gx,y+r-gy)) // 径向渐变，半径到最远的角（右下角）
  g.addColorStop(0,theme.getPropertyValue(`--${color}-hi`).trim()) // 0%：高光色
  g.addColorStop(.55,theme.getPropertyValue(`--${color}`).trim()) // 55%：主色
  g.addColorStop(1,theme.getPropertyValue(`--${color}-lo`).trim()) // 100%：暗部色
  ctx.save() // 保存画布状态（阴影设置之后恢复）
  // Canvas 的阴影参数不随缩放变化，按导出倍数换算
  ctx.shadowColor="rgba(15,23,42,.18)" // 投影颜色
  ctx.shadowOffsetY=2*scale // 投影向下 2px
  ctx.shadowBlur=5*scale // 投影模糊 5px
  ctx.fillStyle=g // 用渐变填充
  ctx.beginPath() // 开始画路径
  ctx.arc(x,y,r,0,Math.PI*2) // 圆
  ctx.fill() // 填充球
  ctx.shadowColor="rgba(0,0,0,.18)" // 数字阴影颜色
  ctx.shadowOffsetY=scale // 数字阴影向下 1px
  ctx.shadowBlur=scale // 数字阴影模糊 1px
  ctx.fillStyle="#fff" // 白色数字
  fillTextCentered(ctx,number,x,y) // 在球心画数字，按字形居中
  ctx.restore() // 恢复画布状态，去掉阴影
}
function exportRows(){ // 要保存的号码行：中间卡片里的一注（随机选号、深度思考都是）
  return pickLine.querySelector(".ball:not(.ghost)")&&!pickLine.querySelector(".ghost")?[pickLine]:[] // 一注卡片里的号码（抽完、算完才算数）
}
function drawExportImage(title){ // 画出导出图片，返回画布
  const L=EXPORT_LAYOUT // 版式参数的简写
  const theme=getComputedStyle(document.documentElement) // 当前深浅模式下的 CSS 变量
  const font=getComputedStyle(document.body).fontFamily // 页面使用的字体
  const lines=exportRows().map(line=>[...line.children].map(ball=>({ // 从页面读出每行的号码球（不含深度思考的标题和思考过程）
    number:ball.textContent, // 号码文字
    color:ball.classList.contains("blue")?"blue":"red" // 颜色：有 blue 类就是蓝球，否则是红球
  })))
  // 至少 2 倍；iPhone 等 3 倍屏按 3 倍导出，图片更清晰
  const scale=Math.min(Math.max(window.devicePixelRatio||1,2),3) // 导出倍数：至少 2，最多 3，跟随屏幕像素密度
  const canvas=document.createElement("canvas") // 新建画布
  const ctx=canvas.getContext("2d") // 取 2D 绘图上下文
  const titleFont=`600 ${L.titleSize}px ${font}` // 标题字体：粗体 16px
  ctx.font=titleFont // 先设好字体，用来量标题宽度
  const columns=Math.max(...lines.map(line=>line.length)) // 最多一行有几个球
  const width=Math.ceil(Math.max(columns*(L.ball+L.gap),ctx.measureText(title).width)+L.padX*2) // 图片宽度：号码行和标题取较宽者，再加左右留白
  const height=L.padY*2+L.titleHeight+L.titleGap+lines.length*L.ball+(lines.length-1)*L.rowGap // 图片高度：上下留白 + 标题 + 间距 + 各行号码 + 行间距
  canvas.width=width*scale // 画布实际像素宽度
  canvas.height=height*scale // 画布实际像素高度
  ctx.scale(scale,scale) // 之后按 CSS 像素坐标作画
  ctx.fillStyle=theme.getPropertyValue("--export-base").trim() // 底色
  ctx.fillRect(0,0,width,height) // 先铺底色
  ctx.fillStyle=canvasLinearGradient(ctx,theme.getPropertyValue("--export-bg"),width,height) // 背景渐变
  ctx.fillRect(0,0,width,height) // 再铺渐变
  ctx.textAlign="center" // 文字水平居中
  ctx.font=titleFont // 标题字体
  ctx.fillStyle=theme.getPropertyValue("--export-title").trim() // 标题颜色
  fillTextCentered(ctx,title,width/2,L.padY+L.titleHeight/2) // 画标题，在标题行内垂直居中
  ctx.font=`600 ${L.numberSize}px ${font}` // 号码数字字体：粗体 13.6px
  const top=L.padY+L.titleHeight+L.titleGap // 第一行号码的顶部位置
  lines.forEach((line,row)=>{ // 每一行
    const left=(width-line.length*(L.ball+L.gap))/2+L.gap/2 // 这一行最左边球的左边缘，让整行水平居中
    line.forEach((ball,i)=>{ // 这一行的每个球
      drawExportBall(ctx,theme,scale,ball.color,ball.number,left+i*(L.ball+L.gap)+L.ball/2,top+row*(L.ball+L.rowGap)+L.ball/2,L.ball/2) // 画球：圆心 x、圆心 y、半径
    })
  })
  return canvas // 返回画好的画布
}
function saveAsImage(){ // 保存图片
  if(isRolling){ // 正在生成时
    alert("请等待生成完成再保存") // 提示等待
    return // 不保存
  }
  if(!exportRows().length){ // 还没有生成号码时（只有提示文字、空球也不算）
    alert("当前没有生成结果") // 提示没有结果
    return // 不保存
  }
  const type=getType() // 当前彩种
  const typeText=type==="ssq"?"双色球":"大乐透" // 彩种的中文名
  const modeText=resultMode==="deep"?"深度思考":"随机选号" // 这组号码是用哪种方式生成的
  const dateText=formatDateLocal(new Date()) // 当前时间，用在标题和文件名里
  let canvas // 导出用的画布
  try{ // 尝试
    canvas=drawExportImage(`${dateText} ${typeText} ${modeText}`) // 画出导出图片，标题为“时间 彩种 选号方式”
  }catch(error){ // 画图出错时
    console.error("保存图片失败:",error) // 在控制台记录错误
    alert("图片生成失败，请重试") // 提示失败
    return // 不保存
  }
  // iPadOS 默认伪装成 Mac 的 UA，用触摸点数区分
  const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1) // 是否 iOS：UA 含 iPad/iPhone/iPod，或者是带多点触摸的“Mac”（iPadOS）
  if(isIOS){ // iOS 上
    showSavePreview(canvas.toDataURL("image/png"),`${typeText} ${modeText} ${dateText} 号码图片`) // 弹出预览，让用户长按保存到相册
    return // 结束
  }
  canvas.toBlob(blob=>{ // 其他设备：把画布转成 PNG 文件
    if(!blob){ // 转换失败时
      alert("图片生成失败，请重试") // 提示失败
      return // 结束
    }
    const url=URL.createObjectURL(blob) // 为文件生成临时地址
    const a=document.createElement("a") // 新建一个链接
    a.href=url // 链接指向文件
    a.download=`lottery-${typeText}-${modeText}-${dateText}.png` // 下载时的文件名，带上彩种和选号方式
    document.body.appendChild(a) // 链接放进页面（部分浏览器要求）
    a.click() // 模拟点击，开始下载
    document.body.removeChild(a) // 移除链接
    setTimeout(()=>{ // 稍后
      URL.revokeObjectURL(url) // 释放临时地址
    },1000) // 1 秒后
  },"image/png") // 输出 PNG 格式
}
// iOS 不能直接下载到相册：弹出预览，长按图片保存
function showSavePreview(src,alt){ // 弹出保存预览：src 为图片地址，alt 为图片的文字说明
  // 关闭后把焦点还给触发保存的按钮
  const opener=document.activeElement // 当前获得焦点的元素（保存按钮）
  const overlay=document.createElement("div") // 遮罩
  overlay.className="ios-save-overlay" // 遮罩样式
  const blur=document.createElement("div") // 弹窗后面的模糊层
  blur.className="ios-save-blur" // 模糊层样式
  const stage=document.createElement("div") // 弹窗的居中区域
  stage.className="ios-save-stage" // 居中区域样式
  const modal=document.createElement("div") // 弹窗
  modal.className="ios-save-modal" // 弹窗样式
  modal.setAttribute("role","dialog") // 读屏软件当作对话框
  modal.setAttribute("aria-modal","true") // 对话框打开时，背后的内容不可操作
  modal.setAttribute("aria-label","保存图片") // 对话框的名称
  const preview=document.createElement("img") // 预览图
  preview.className="ios-save-preview" // 预览图样式
  preview.alt=alt // 图片的文字说明
  preview.src=src // 图片内容
  const tip=document.createElement("div") // 提示文字
  tip.className="ios-save-tip" // 提示文字样式
  tip.textContent="长按图片即可保存到相册" // 提示内容
  const closeBtn=document.createElement("button") // 关闭按钮
  closeBtn.type="button" // 普通按钮，不提交表单
  closeBtn.className="ios-save-close" // 关闭按钮样式
  closeBtn.textContent="关闭" // 按钮文字
  let closing=false // 是否正在关闭（防止重复关闭）
  function onKey(e){ // 键盘按下时
    if(e.key==="Escape") closePreview() // 按 Esc 关闭
  }
  function closePreview(){ // 关闭弹窗
    if(closing) return // 已经在关闭就忽略
    closing=true // 标记为正在关闭
    document.removeEventListener("keydown",onKey) // 不再监听键盘
    overlay.classList.remove("show") // 遮罩开始淡出
    stage.classList.remove("show") // 弹窗开始淡出
    setTimeout(()=>{ // 等淡出动画结束
      overlay.remove() // 移除遮罩
      stage.remove() // 移除弹窗
      if(opener&&opener.focus) opener.focus() // 把焦点还给保存按钮
    },230) // 230 毫秒，比淡出动画稍长
  }
  document.addEventListener("keydown",onKey) // 监听键盘
  closeBtn.addEventListener("click",closePreview) // 点关闭按钮时关闭
  overlay.addEventListener("click",e=>{ // 点击遮罩时
    if(e.target===overlay) closePreview() // 点在弹窗外面才关闭
  })
  modal.addEventListener("click",e=>e.stopPropagation()) // 点击弹窗内部不往外传，不触发关闭
  modal.appendChild(preview) // 放入预览图
  modal.appendChild(tip) // 放入提示文字
  modal.appendChild(closeBtn) // 放入关闭按钮
  overlay.appendChild(blur) // 模糊层放进遮罩
  stage.appendChild(modal) // 弹窗放进居中区域（和遮罩并列，弹窗的玻璃仍能透出后面）
  document.body.appendChild(overlay) // 遮罩放进页面
  document.body.appendChild(stage) // 弹窗放进页面（盖在遮罩上面）
  requestAnimationFrame(()=>{ // 等下一帧
    requestAnimationFrame(()=>{ // 再等一帧，确保初始样式已生效，淡入动画才会播放
      overlay.classList.add("show") // 遮罩淡入
      stage.classList.add("show") // 弹窗淡入
      closeBtn.focus({preventScroll:true}) // 焦点移到关闭按钮，不滚动页面
    })
  })
}
