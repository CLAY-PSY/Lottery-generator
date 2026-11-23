// 液态背景和玻璃：WebGL 画液体和玻璃面板，不支持时用 2D 兜底；跟随深浅模式和减弱动态效果
// 监听系统设置（深浅模式、减弱动态效果、降低透明度）的变化；iOS 13 及更早只有 addListener
function onMediaChange(mql,fn,options){ // 监听系统设置的变化：mql 为媒体查询，fn 为回调
  if(mql.addEventListener) mql.addEventListener("change",fn,options) // 支持 addEventListener 时用它（可带 options，例如用 signal 移除）
  else if(mql.addListener) mql.addListener(fn) // 旧版 Safari 用 addListener
}
// 液态背景：整屏流动的彩色液体。多层正弦扭曲坐标（domain warp）做出丝绸般的流动，
// 十种颜色按扭曲后的坐标平滑混合，任何时刻都铺满全屏，没有液滴的边界
// 扭曲和配色的相位都由随机速度推动，速度每隔几秒随机变化并平滑过渡，
// 所以每次打开都不同，也不会循环重复
// 着色公式在 WebGL 着色器（fieldSrc）和 2D 兜底画法（shade）里各写了一份，改动时两边要保持一致
// 液体颜色的种类数：对应 CSS 变量 --liquid-1 ～ --liquid-10，WebGL 着色器的数组大小也由它决定
const LIQUID_COUNT=10 // 液体颜色的种类数
const liquidBackdrop=(function(){ // 液态背景模块（含 2D 兜底画法），返回给 WebGL 使用的接口
  const backdrop=document.querySelector(".backdrop") // 背景容器
  const reduceMotion=matchMedia("(prefers-reduced-motion: reduce)") // 系统“减弱动态效果”设置
  // 液体很平滑，低分辨率计算后放大即可：兜底画法每个画布像素对应 7 个 CSS 像素（颜色种类多了，逐像素计算更费时，降一点分辨率抵消）
  const FALLBACK_SCALE=7 // 兜底画法的缩小倍数
  // 五层扭曲的幅度和频率：低频大幅度决定大的流向，高频小幅度带出细的涟漪
  const WARP=[[.9,1],[.6,1.45],[.42,2.1],[.3,3],[.2,4.3]] // 每层扭曲：[幅度, 频率]
  // 坐标缩放（每个短边长度内的波数）、配色条纹频率、配色锐度、丝绸褶皱的明暗幅度
  const SHAPE=[2.4,1.6,5,.1] // [坐标缩放, 条纹频率, 锐度, 褶皱幅度]
  // 流动速度：每层扭曲、每种颜色条纹的相位速度（弧度/秒）在 ±最大值内随机
  const WARP_SPEED=.9 // 扭曲的最大相位速度（最初 0.3，现为 3 倍）
  const TINT_SPEED=.75 // 颜色条纹的最大相位速度（最初 0.25，现为 3 倍）
  const warps=WARP.map(()=>{ // 每层扭曲的运动状态
    const tx=rand(-WARP_SPEED,WARP_SPEED) // 初始 x 方向速度，随机
    const ty=rand(-WARP_SPEED,WARP_SPEED) // 初始 y 方向速度，随机
    return {px:rand(0,6.28),py:rand(0,6.28),vx:tx,vy:ty,tx,ty,turn:rand(3,7)} // 相位随机；当前速度、目标速度；距下次换方向 3～7 秒
  })
  const tints=Array.from({length:LIQUID_COUNT},()=>{ // 每种颜色条纹的运动状态
    const a=rand(0,6.28) // 条纹方向随机
    const f=rand(.65,1.45) // 条纹宽窄随机：有的宽成大片，有的细成丝带，看起来是不同的液体
    const tv=rand(-TINT_SPEED,TINT_SPEED) // 初始速度，随机
    return {dx:Math.cos(a)*f,dy:Math.sin(a)*f,p:rand(0,6.28),v:tv,tv,turn:rand(3,7)} // 方向向量（乘上宽窄倍数）、相位随机、当前速度、目标速度、距下次变速的时间
  })
  let width=backdrop.clientWidth // 背景宽度
  let height=backdrop.clientHeight // 背景高度
  let colors=[] // 各种液体颜色（0～1 的 RGB）
  let chroma=[] // 各种颜色各自的饱和度
  let tone=[1,0] // 调色：颜色倍率、混白比例
  let active=false // 兜底画法是否在运行
  let canvas=null // 兜底画布
  let ctx=null // 兜底画布的 2D 上下文
  let image=null // 兜底画布的像素数据
  let raf=0 // 动画帧编号
  let lastStep=performance.now() // 上一次更新运动的时间
  let lastDraw=0 // 上一次绘制的时间
  function rand(a,b){ // [a,b) 内的随机小数
    return a+Math.random()*(b-a) // 返回随机数
  }
  function hex(s){ // #rrggbb → [r,g,b]（0～1）
    s=s.trim().replace("#","") // 去掉空格和 #
    return [0,2,4].map(i=>parseInt(s.slice(i,i+2),16)/255) // 每两位十六进制换算成 0～1
  }
  function readTheme(){ // 读取当前深浅模式的颜色
    const cs=getComputedStyle(document.documentElement) // 根元素的样式
    colors=Array.from({length:LIQUID_COUNT},(_,i)=>hex(cs.getPropertyValue(`--liquid-${i+1}`))) // 读取各种液体颜色
    // 每种颜色的饱和度（到同亮度灰色的距离），混色后用来补回饱和度
    chroma=colors.map(c=>{ // 计算每种颜色的饱和度
      const l=luma(c) // 这个颜色的亮度
      return Math.hypot(c[0]-l,c[1]-l,c[2]-l) // 到同亮度灰色的距离
    })
    tone=cs.getPropertyValue("--liquid-tone").trim().split(/\s+/).map(Number) // 读取调色：颜色倍率、混白比例
  }
  function luma(c){ // 颜色的亮度（Rec.709 系数）
    return c[0]*.2126+c[1]*.7152+c[2]*.0722 // 红绿蓝按人眼敏感度加权
  }
  function step(now){ // 推进一帧运动：now 为当前时间（毫秒）
    const dt=Math.min((now-lastStep)/1000,.1) // 距上一帧的秒数，最多按 0.1 秒算（页面切回前台时不会突然跳一大步）
    lastStep=now // 记下本帧时间
    if(reduceMotion.matches||dt<=0) return // 减弱动态效果时或时间没前进时不动
    const ease=Math.min(1,dt*.5) // 速度向目标靠拢的比例，约 2 秒过渡完
    warps.forEach(w=>{ // 每层扭曲
      w.turn-=dt // 倒计时
      if(w.turn<=0){ // 到时间了
        w.tx=rand(-WARP_SPEED,WARP_SPEED) // 随机新的 x 方向目标速度
        w.ty=rand(-WARP_SPEED,WARP_SPEED) // 随机新的 y 方向目标速度
        w.turn=rand(3,7) // 下次换方向在 3～7 秒后
      }
      w.vx+=(w.tx-w.vx)*ease // x 速度平滑靠向目标
      w.vy+=(w.ty-w.vy)*ease // y 速度平滑靠向目标
      w.px+=w.vx*dt // 推进 x 相位
      w.py+=w.vy*dt // 推进 y 相位
    })
    tints.forEach(c=>{ // 每种颜色条纹
      c.turn-=dt // 倒计时
      if(c.turn<=0){ // 到时间了
        c.tv=rand(-TINT_SPEED,TINT_SPEED) // 随机新的目标速度
        c.turn=rand(3,7) // 下次变速在 3～7 秒后
      }
      c.v+=(c.tv-c.v)*ease // 速度平滑靠向目标
      c.p+=c.v*dt // 推进相位
    })
  }
  // 着色器用到的参数：spec 只在尺寸或主题变化时更新，phases 逐帧更新
  function spec(){ // 不常变化的参数
    return { // 返回
      warp:WARP.flat(), // 扭曲的幅度和频率，展开成一维数组
      tintDir:tints.flatMap(c=>[c.dx,c.dy]), // 各条纹方向，展开成一维数组
      shape:SHAPE, // 形状参数
      colors:colors.flat(), // 各种颜色，展开成一维数组
      chroma, // 各种颜色的饱和度
      tone // 调色参数
    }
  }
  function phases(){ // 逐帧变化的相位
    return {warp:warps.flatMap(w=>[w.px,w.py]),tint:tints.map(c=>c.p)} // 五层扭曲的 x、y 相位，各条纹的相位
  }
  // 与着色器 fieldSrc 相同：扭曲坐标 → 各色按条纹平滑混合 → 补回饱和度 → 丝绸褶皱的明暗（未做深浅调色）
  function shade(qx,qy){ // 计算 (qx, qy) 处液体的颜色
    for(let i=0;i<WARP.length;i++){ // 五层扭曲
      const [a,f]=WARP[i] // 这一层的幅度和频率
      const nx=qx+a*Math.sin(qy*f+warps[i].px) // 新的 x：沿 y 方向的正弦波推动
      qy+=a*Math.sin(qx*f+warps[i].py) // 新的 y：沿 x 方向的正弦波推动（用的是旧的 x）
      qx=nx // 更新 x
    }
    let r=0,g=0,b=0,w=0,ch=0 // 颜色累加：红、绿、蓝、权重、饱和度
    for(let k=0;k<LIQUID_COUNT;k++){ // 每种颜色
      const t=tints[k] // 这种颜色的条纹
      const s=Math.pow(Math.max(.5+.5*Math.sin((qx*t.dx+qy*t.dy)*SHAPE[1]+t.p),0),SHAPE[2]) // 条纹强度：沿条纹方向的正弦波，取 5 次方让条纹更集中
      const c=colors[k] // 这种颜色
      r+=c[0]*s // 累加红
      g+=c[1]*s // 累加绿
      b+=c[2]*s // 累加蓝
      ch+=chroma[k]*s // 累加饱和度
      w+=s // 累加权重
    }
    w=Math.max(w,1e-6) // 权重不为零
    r/=w // 平均红
    g/=w // 平均绿
    b/=w // 平均蓝
    // 互补色平均会互相抵消、发灰（橙 + 蓝 ≈ 灰），按参与混合的颜色的平均饱和度补回来
    const l=luma([r,g,b]) // 混合后的亮度
    const boost=Math.min(ch/w/Math.max(Math.hypot(r-l,g-l,b-l),1e-4),2.5) // 饱和度放大倍数：期望饱和度 ÷ 实际饱和度，最多 2.5 倍
    const fold=1+SHAPE[3]*Math.sin(qx*2.3-qy*1.7) // 丝绸褶皱：明暗起伏 ±10%
    return [(l+(r-l)*boost)*fold,(l+(g-l)*boost)*fold,(l+(b-l)*boost)*fold] // 从亮度出发放大颜色偏移，再乘褶皱明暗
  }
  function resize(){ // 背景尺寸变化时
    width=backdrop.clientWidth // 新的宽度
    height=backdrop.clientHeight // 新的高度
    if(canvas&&active){ // 兜底画法在运行时
      canvas.width=Math.max(1,Math.ceil(width/FALLBACK_SCALE)) // 画布宽度：缩小 6 倍，至少 1（尺寸为 0 时 createImageData 会报错）
      canvas.height=Math.max(1,Math.ceil(height/FALLBACK_SCALE)) // 画布高度：缩小 6 倍，至少 1
      image=ctx.createImageData(canvas.width,canvas.height) // 新建同尺寸的像素数据
      drawFallback() // 立即重画
    }
  }
  // 不支持 WebGL 时，在低分辨率 2D 画布上逐像素算出同样的液体，再由浏览器平滑放大
  function drawFallback(){ // 画一帧兜底背景
    const data=image.data // 像素数组
    const inv=SHAPE[0]/Math.min(width,height) // CSS 像素 → 液体坐标的缩放
    const [mul,white]=tone // 调色参数
    let o=0 // 像素数组的写入位置
    for(let j=0;j<canvas.height;j++){ // 每一行像素
      const y=(j+.5)*FALLBACK_SCALE*inv // 这一行中心对应的液体 y 坐标
      for(let i=0;i<canvas.width;i++){ // 这一行的每个像素
        const c=shade((i+.5)*FALLBACK_SCALE*inv,y) // 算出这个像素的颜色
        data[o]=255*Math.min(1,Math.max(0,c[0])*mul*(1-white)+white)+Math.random()-.5 // 红：调色后加 ±0.5 的抖动写入（0～255），放大后不出现色阶条纹
        data[o+1]=255*Math.min(1,Math.max(0,c[1])*mul*(1-white)+white)+Math.random()-.5 // 绿
        data[o+2]=255*Math.min(1,Math.max(0,c[2])*mul*(1-white)+white)+Math.random()-.5 // 蓝
        data[o+3]=255 // 不透明
        o+=4 // 下一个像素
      }
    }
    ctx.putImageData(image,0,0) // 整张写回画布
  }
  // 兜底画法用 JS 逐像素计算，开销大（每帧约 10 毫秒），保持每秒 30 帧，不和按钮动画抢主线程
  function loop(now){ // 兜底画法的动画循环
    raf=requestAnimationFrame(loop) // 预约下一帧
    if(now-lastDraw<33) return // 距上次绘制不到 33 毫秒就跳过（每秒最多 30 帧）
    lastDraw=now // 记下绘制时间
    step(now) // 推进运动
    drawFallback() // 重画
  }
  function start(){ // 启动兜底画法
    active=true // 标记为运行中
    if(!canvas){ // 还没有画布时
      canvas=document.createElement("canvas") // 新建画布
      backdrop.appendChild(canvas) // 放进背景容器
      ctx=canvas.getContext("2d") // 取 2D 上下文
    }
    resize() // 按当前尺寸设置画布并画第一帧
    lastStep=performance.now() // 从现在开始计时
    if(!raf&&!reduceMotion.matches) raf=requestAnimationFrame(loop) // 没在循环且没开减弱动态效果时，开始动画循环
  }
  function stop(){ // 停止兜底画法（WebGL 接管时）
    active=false // 标记为停止
    cancelAnimationFrame(raf) // 取消下一帧
    raf=0 // 清空帧编号
  }
  readTheme() // 读取当前深浅模式的颜色
  window.addEventListener("resize",resize) // 窗口尺寸变化时调整
  // 背景尺寸可能在没有 resize 事件时改变（iOS Safari 工具栏调整），直接观察容器尺寸
  if(window.ResizeObserver) new ResizeObserver(()=>{ // 浏览器支持 ResizeObserver 时，观察背景容器
    if(backdrop.clientWidth!==width||backdrop.clientHeight!==height) resize() // 尺寸确实变了才调整
  }).observe(backdrop) // 观察背景容器
  onMediaChange(matchMedia("(prefers-color-scheme: dark)"),()=>{ // 系统深浅模式切换时
    readTheme() // 重新读取颜色
    if(active) drawFallback() // 运行中就立即重画
  })
  onMediaChange(reduceMotion,()=>{ // 系统“减弱动态效果”切换时
    if(!active) return // 没在运行就不管
    stop() // 先停止
    start() // 再按新设置启动（开启时只画静止的一帧）
  })
  return {step,spec,phases,start,stop,readTheme} // 对外提供的接口
})() // 立即执行，得到液态背景模块
// WebGL 先在低分辨率纹理里算出液态背景，再整屏放大，并画出玻璃面板：
// 边缘透镜折射、色散、轻度磨砂、高光和投影
// 创建失败时返回 null；成功时返回 {destroy}，WebGL 上下文丢失时调用 onLost
function createLiquidGlass(onLost){ // 创建 WebGL 液体玻璃
  const canvas=document.createElement("canvas") // 新建画布
  canvas.className="lg-canvas" // 画布样式
  canvas.setAttribute("aria-hidden","true") // 读屏软件忽略
  const gl=canvas.getContext("webgl",{alpha:false,antialias:false,depth:false,stencil:false,premultipliedAlpha:false,powerPreference:"low-power"}) // 取 WebGL 上下文：不透明、不抗锯齿、不需要深度和模板缓冲、优先省电
  if(!gl) return null // 不支持 WebGL 就返回 null
  // 液体纹理每个像素对应 2 个 CSS 像素：再粗的话，放大后能看出纹理像素的网格
  const FIELD_SCALE=2 // 液体纹理的缩小倍数
  const vertSrc=`attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}` // 顶点着色器：一个盖住整个屏幕的三角形
  const fieldSrc=` // 液体着色器：把整屏液体画进低分辨率纹理
precision highp float; // 使用高精度浮点数
uniform vec2 uFieldRes; // 液体纹理的尺寸（像素）
uniform float uFieldScale; // 每个纹理像素对应的 CSS 像素
uniform vec4 uShape; // 形状参数：坐标缩放、条纹频率、锐度、褶皱幅度
uniform vec2 uWarp[5]; // 五层扭曲的幅度和频率
uniform vec2 uWarpP[5]; // 五层扭曲的 x、y 相位
// 每种条纹的参数打包成一个 vec4：手机 GPU 的 uniform 槽位有限（iPhone 为 64 个），分开传会接近上限
uniform vec4 uTint[${LIQUID_COUNT}]; // 每种颜色条纹：方向 x、方向 y（已乘宽窄倍数）、相位、饱和度
uniform vec3 uCol[${LIQUID_COUNT}]; // 各种液体颜色
uniform vec2 uTone; // 调色：颜色倍率、混白比例
const vec3 LUMA=vec3(.2126,.7152,.0722); // 亮度系数
void main(){ // 每个纹理像素
  vec2 q=vec2(gl_FragCoord.x,uFieldRes.y-gl_FragCoord.y)*uFieldScale*uShape.x; // 换算成液体坐标（纹理 y 轴朝上，翻转成朝下）
  for(int i=0;i<5;i++){ // 五层扭曲
    q+=uWarp[i].x*vec2(sin(q.y*uWarp[i].y+uWarpP[i].x),sin(q.x*uWarp[i].y+uWarpP[i].y)); // 新的 x、y 都用旧的坐标计算（与 JS 的 shade 相同）
  }
  vec3 c=vec3(0.); // 颜色累加
  float w=0.; // 权重累加
  float ch=0.; // 饱和度累加
  for(int k=0;k<${LIQUID_COUNT};k++){ // 每种颜色
    float s=pow(max(.5+.5*sin(dot(q,uTint[k].xy)*uShape.y+uTint[k].z),0.),uShape.z); // 条纹强度：正弦波取 5 次方
    c+=uCol[k]*s; // 累加颜色
    ch+=uTint[k].w*s; // 累加饱和度
    w+=s; // 累加权重
  }
  w=max(w,1e-6); // 权重不为零
  c/=w; // 加权平均颜色
  // 互补色平均会互相抵消、发灰（橙 + 蓝 ≈ 灰），按参与混合的颜色的平均饱和度补回来
  float l=dot(c,LUMA); // 混合后的亮度
  vec3 dc=c-l; // 颜色相对亮度的偏移
  c=(l+dc*min(ch/w/max(length(dc),1e-4),2.5))*(1.+uShape.w*sin(q.x*2.3-q.y*1.7)); // 按平均饱和度放大偏移（最多 2.5 倍），再乘丝绸褶皱的明暗
  vec3 o=clamp(mix(max(c,0.)*uTone.x,vec3(1.),uTone.y),0.,1.); // 调色（乘倍率、混白），限制在 0～1
  // 用 8 位纹理时每个颜色只有 256 级：缓慢的渐变会变成一级一级的台阶，放大后出现条纹和色块，写入前加抖动打散台阶
  gl_FragColor=vec4(o+(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5)/255.,1.); // 加上 ±0.5/255 的随机抖动后输出
}` // 液体着色器源码结束
  const glassSrc=` // 玻璃着色器：整屏背景加两块玻璃面板
precision highp float; // 使用高精度浮点数
uniform sampler2D uField; // 液体纹理
uniform vec2 uFieldSize; // 液体纹理覆盖的 CSS 尺寸
uniform vec2 uRes; // 画布的实际像素尺寸
uniform float uDpr; // 屏幕像素密度
uniform vec4 uPanel[3]; // 最多三块面板：中心 x、中心 y、半宽、半高
uniform float uPanelR[3]; // 各块面板的圆角半径
uniform int uPanelN; // 面板数量
uniform vec4 uTint; // 玻璃底色（RGB 和不透明度）
uniform vec4 uLook; // 玻璃参数：磨砂半径、高光、顶部反光、提亮
uniform vec4 uShadow; // 面板投影颜色（RGB 和不透明度）
uniform float uSheen; // 边缘反光取玻璃里背景颜色的比例：0 为纯白光
const float SAT=1.1; // 玻璃里的颜色饱和度倍数
// 玻璃边缘是一圈超椭圆（squircle，与 Apple 液态玻璃相同）形的凸起斜面：边缘处几乎竖直，往里 28px 平滑变平；玻璃直接压在背景上
// 斜面宽度不超过面板圆角（窄屏 29px），转角处的法线才连续
const float BEZEL=28.; // 斜面宽度（px）：边缘这一圈会折射
const float THICK=80.; // 玻璃厚度（px）：越厚，边缘斜面越陡，折射越强；背景是柔和的大色块，弯折要够强才看得出来
const vec3 IOR=vec3(1.47,1.5,1.53); // 红、绿、蓝三色的折射率：蓝光折得最多，形成色散
const vec2 LIGHT=vec2(-.61,-.79); // 光源方向：左上
vec3 bg(vec2 p){ // 取背景纹理在 CSS 坐标 p 处的颜色
  return texture2D(uField,vec2(p.x/uFieldSize.x,1.-p.y/uFieldSize.y)).rgb; // 换算成纹理坐标（y 轴翻转）
}
// 九点采样的轻度磨砂
vec3 frost(vec2 p,float r){ // 磨砂：在 p 周围半径 r 处取 8 个点加中心点做加权平均
  vec2 a=vec2(r,0.); // 水平偏移
  vec2 b=vec2(.7071*r,.7071*r); // 右下对角偏移
  vec2 c=vec2(-b.x,b.y); // 左下对角偏移
  return bg(p)*.2+(bg(p+a)+bg(p-a)+bg(p+a.yx)+bg(p-a.yx)+bg(p+b)+bg(p-b)+bg(p+c)+bg(p-c))*.1; // 中心占 20%，周围 8 个点各占 10%
}
float sdBox(vec2 q,vec2 b,float r){ // 圆角矩形的有向距离：q 相对中心的坐标，b 为半宽高，r 为圆角；里面为负、外面为正
  vec2 k=abs(q)-b+r; // 到圆角内收矩形的距离分量
  return length(max(k,0.))+min(max(k.x,k.y),0.)-r; // 外面用欧氏距离，里面用最近边的距离，再减去圆角
}
void main(){ // 每个屏幕像素
  vec2 p=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uDpr; // 换算成 CSS 坐标（y 轴朝下）
  vec3 col=bg(p); // 先取背景
  for(int i=0;i<3;i++){ // 各块面板的投影
    if(i>=uPanelN) break; // 超过面板数量就停止
    float ds=sdBox(p-uPanel[i].xy-vec2(0.,12.),uPanel[i].zw,uPanelR[i]); // 到“下移 12px 的面板”的距离
    col=mix(col,uShadow.rgb,(1.-smoothstep(-14.,30.,ds))*uShadow.a); // 距离越近投影越深，在面板外 30px 内淡出
  }
  for(int i=0;i<3;i++){ // 各块玻璃面板
    if(i>=uPanelN) break; // 超过面板数量就停止
    vec2 q=p-uPanel[i].xy; // 相对面板中心的坐标
    vec2 b=uPanel[i].zw; // 面板半宽、半高
    float r=uPanelR[i]; // 圆角半径
    float d=sdBox(q,b,r); // 到面板边缘的距离
    if(d>1.) continue; // 在面板外面就跳过
    vec2 n=normalize(vec2(sdBox(q+vec2(.5,0.),b,r)-sdBox(q-vec2(.5,0.),b,r),sdBox(q+vec2(0.,.5),b,r)-sdBox(q-vec2(0.,.5),b,r))+1e-6); // 边缘法线：距离函数在 x、y 方向的差分
    float e=1.-clamp(-d/BEZEL,0.,1.); // 离边缘多近：边缘处为 1，进入 28px 后为 0
    float lens=e*e; // 透镜强度，越靠边缘越强（用于磨砂和高光）
    // 真实厚玻璃的边缘：视线在斜面上向里折射。最外一圈把一段背景压成一条细线，往里是一段被压缩、倒过来的背景，再往里放大后逐渐恢复正常
    vec3 g; // 玻璃里看到的颜色
    float F=0.; // 菲涅尔反射率：中间平面上为 0
    if(e>.001){ // 在斜面上
      float u=max(1.-lens*lens,1e-6); // 1-(1-t)^4，t 为进入斜面的比例
      float h=sqrt(sqrt(u)); // 超椭圆斜面的高度（0～1）：(1-(1-t)^4)^(1/4)
      float th=atan(THICK/BEZEL*e*e*e*pow(u,-.75)); // 表面倾角：高度对距离求导得到斜率，边缘处接近 90°
      vec3 D=h*THICK*tan(th-asin(sin(th)/IOR)); // 斯涅尔定律：三色视线进入玻璃后偏离竖直方向，穿过这里的玻璃厚度落到背景上，偏移多少（px）
      float fr=uLook.x*(1.+lens); // 越靠边缘光线越发散，磨砂稍强
      g.r=frost(p-n*D.r,fr).r; // 红光折射最少（沿法线往里偏）
      g.g=frost(p-n*D.g,fr).g; // 绿光居中
      g.b=frost(p-n*D.b,fr).b; // 蓝光折射最多，三色错开形成彩边
      // 只算倾斜带来的那部分反射：平面上为 0，与中间的平面连续。带上 4% 的基础反射时，斜面与平面交界处亮度会突变，深色下看得出一个方框
      F=pow(1.-cos(th),5.); // 菲涅尔反射（Schlick 近似去掉基础值）：表面越斜反射越强，最外一圈接近全反射
    }else{ // 在中间的平面上
      g=frost(p,uLook.x); // 不折射，只做轻度磨砂
    }
    float l=dot(g,vec3(.2126,.7152,.0722)); // 亮度
    g=clamp(mix(vec3(l),g,SAT)*uLook.w,0.,1.); // 略微提饱和，再按参数提亮
    g=mix(g,uTint.rgb,uTint.a); // 叠上玻璃底色
    // 反光的颜色：深色下为白光；浅色下带上玻璃里背景的颜色（同色相、最亮的那个颜色），提亮但不洗白
    vec3 sheen=mix(vec3(1.),g/max(max(g.r,max(g.g,g.b)),.001),uSheen); // 反光颜色
    g+=uLook.z*(1.-smoothstep(0.,.55,length((q-vec2(-.64*b.x,-b.y))/(vec2(2.4,1.7)*b))))*sheen; // 左上角的顶部反光：椭圆形的柔光，边界平滑淡出（线性淡出会在面板中间留下一圈椭圆形的边）
    // 高光：迎光的左上边缘最亮，右下边缘有反光，侧对光源的右上角和左下角也保留一圈底光，边缘不会断开
    g+=uLook.y*pow(e,6.)*(.3+.7*max(dot(n,LIGHT),0.)+.3*max(dot(n,-LIGHT),0.))*sheen; // 边缘高光：只贴着边缘一窄条（不盖住折射），整圈 30% 底光，朝光源的一侧最亮，背光的一侧有反光
    g=mix(g,sheen,F*uLook.y*1.5); // 菲涅尔反射：最外一圈反射周围的亮光，表面越斜越亮
    col=mix(col,clamp(g,0.,1.),clamp(.5-d*uDpr,0.,1.)); // 把玻璃颜色画到面板范围内，边缘按 1 个像素抗锯齿
  }
  // 轻微抖动，避免 8 位纹理放大后的平滑渐变出现色带
  col+=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5)/255.; // 加上 ±0.5/255 的随机抖动
  gl_FragColor=vec4(col,1.); // 输出像素颜色
}` // 玻璃着色器源码结束
  function compile(type,src){ // 编译着色器
    const s=gl.createShader(type) // 新建着色器
    gl.shaderSource(s,src) // 设置源码
    gl.compileShader(s) // 编译
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){ // 编译失败时
      console.warn("液体玻璃着色器编译失败:",gl.getShaderInfoLog(s)) // 在控制台输出错误信息
      return null // 返回 null
    }
    return s // 返回着色器
  }
  function link(vs,fs,names){ // 链接着色器程序，并取出 names 中各个 uniform 的位置
    const prog=gl.createProgram() // 新建程序
    gl.attachShader(prog,vs) // 附加顶点着色器
    gl.attachShader(prog,fs) // 附加片元着色器
    gl.bindAttribLocation(prog,0,"a") // 顶点属性 a 固定在位置 0，两个程序共用同一个顶点缓冲
    gl.linkProgram(prog) // 链接
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) return null // 链接失败就返回 null
    const u={} // uniform 位置表
    names.forEach(name=>{ // 每个 uniform 名称
      u[name]=gl.getUniformLocation(prog,name) // 取出位置
    })
    return {prog,u} // 返回程序和位置表
  }
  const vs=compile(gl.VERTEX_SHADER,vertSrc) // 编译顶点着色器
  const fieldFs=compile(gl.FRAGMENT_SHADER,fieldSrc) // 编译液体着色器
  const glassFs=compile(gl.FRAGMENT_SHADER,glassSrc) // 编译玻璃着色器
  if(!vs||!fieldFs||!glassFs) return null // 任一编译失败就返回 null
  const field=link(vs,fieldFs,["uFieldRes","uFieldScale","uShape","uWarp","uWarpP","uTint","uCol","uTone"]) // 液体程序和它的 uniform
  const glass=link(vs,glassFs,["uField","uFieldSize","uRes","uDpr","uPanel","uPanelR","uPanelN","uTint","uLook","uShadow","uSheen"]) // 玻璃程序和它的 uniform
  if(!field||!glass) return null // 任一链接失败就返回 null
  gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer()) // 新建顶点缓冲并绑定
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW) // 三个顶点组成一个盖住整个屏幕的大三角形
  gl.enableVertexAttribArray(0) // 启用位置 0 的顶点属性
  gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0) // 每个顶点 2 个浮点数
  // 优先用半精度浮点纹理存液体：8 位纹理每个颜色只有 256 级，缓慢的渐变放大后会出现一圈圈台阶
  const half=gl.getExtension("OES_texture_half_float") // 半精度浮点纹理扩展
  let fieldType=half&&gl.getExtension("OES_texture_half_float_linear")?half.HALF_FLOAT_OES:gl.UNSIGNED_BYTE // 半精度纹理还能线性插值才用它，否则用 8 位纹理
  gl.getExtension("EXT_color_buffer_half_float") // 开启渲染到半精度纹理（部分浏览器要先开启）
  const fieldTex=gl.createTexture() // 新建液体纹理
  gl.bindTexture(gl.TEXTURE_2D,fieldTex) // 绑定纹理
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR) // 缩小时线性插值
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR) // 放大时线性插值（低分辨率纹理放大后平滑）
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE) // 横向超出时取边缘像素
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE) // 纵向超出时取边缘像素
  const fbo=gl.createFramebuffer() // 新建帧缓冲，用来把液体画进纹理
  const panels=[...document.querySelectorAll(".glass")].slice(0,3) // 玻璃面板元素：表单、深度思考的一注、结果（中间那块只在深度思考时显示）
  const reduceMotion=matchMedia("(prefers-reduced-motion: reduce)") // 系统“减弱动态效果”设置
  // 销毁时一次性移除所有监听
  const listeners=new AbortController() // 用来一次性移除所有监听的控制器
  const on={signal:listeners.signal} // 带上 signal 的监听选项
  const observers=[] // 尺寸观察器列表
  let raf=0 // 动画帧编号
  let sizeW=0 // 画布当前的 CSS 宽度
  let sizeH=0 // 画布当前的 CSS 高度
  let sizeDpr=0 // 画布当前的像素密度
  const tintBuf=new Float32Array(LIQUID_COUNT*4) // 条纹参数（每种 4 个数）：方向 x、方向 y、相位、饱和度
  let fieldW=1 // 液体纹理宽度
  let fieldH=1 // 液体纹理高度
  function rgba(s){ // 解析 CSS 颜色 rgb(a)(...) → [r,g,b,a]（0～1）
    const v=(s.match(/[\d.]+/g)||[]).map(Number) // 取出所有数字
    return [(v[0]||0)/255,(v[1]||0)/255,(v[2]||0)/255,v.length>3?v[3]:1] // 前三个除以 255，第四个是不透明度，没有就是 1
  }
  // 液体参数来自 liquidBackdrop，颜色和玻璃参数从 CSS 变量读取，深浅模式各一套
  function readTheme(){ // 读取颜色和玻璃参数，设置到着色器
    const cs=getComputedStyle(document.documentElement) // 根元素的样式
    liquidBackdrop.readTheme() // 先让液态背景模块重新读取颜色
    const sp=liquidBackdrop.spec() // 取液体参数
    gl.useProgram(field.prog) // 切换到液体程序
    gl.uniform4f(field.u.uShape,sp.shape[0]/Math.min(sizeW,sizeH),sp.shape[1],sp.shape[2],sp.shape[3]) // 形状参数：坐标缩放按屏幕短边换算
    gl.uniform2fv(field.u.uWarp,sp.warp) // 扭曲的幅度和频率
    for(let k=0;k<LIQUID_COUNT;k++){ // 每种颜色条纹：方向和饱和度不常变，记在 tintBuf 里，相位逐帧填入
      tintBuf[k*4]=sp.tintDir[k*2] // 方向 x
      tintBuf[k*4+1]=sp.tintDir[k*2+1] // 方向 y
      tintBuf[k*4+3]=sp.chroma[k] // 饱和度
    }
    gl.uniform3fv(field.u.uCol,sp.colors) // 液体颜色
    gl.uniform2fv(field.u.uTone,sp.tone) // 调色参数
    gl.useProgram(glass.prog) // 切换到玻璃程序
    gl.uniform4f(glass.u.uTint,...rgba(cs.getPropertyValue("--gl-tint"))) // 玻璃底色
    gl.uniform4f(glass.u.uLook,...cs.getPropertyValue("--gl-look").trim().split(/\s+/).map(Number)) // 玻璃参数
    gl.uniform4f(glass.u.uShadow,...rgba(cs.getPropertyValue("--gl-shadow"))) // 面板投影颜色
    gl.uniform1f(glass.u.uSheen,parseFloat(cs.getPropertyValue("--gl-sheen"))||0) // 边缘反光取背景颜色的比例
  }
  function resize(){ // 画布尺寸变化时重新设置
    const dpr=Math.min(window.devicePixelRatio||1,2) // 像素密度，最高 2 倍（再高看不出差别，只会更耗电）
    sizeW=canvas.clientWidth // 记下 CSS 宽度
    sizeH=canvas.clientHeight // 记下 CSS 高度
    sizeDpr=dpr // 记下像素密度
    canvas.width=Math.round(sizeW*dpr) // 画布像素宽度
    canvas.height=Math.round(sizeH*dpr) // 画布像素高度
    fieldW=Math.max(1,Math.ceil(sizeW/FIELD_SCALE)) // 液体纹理宽度
    fieldH=Math.max(1,Math.ceil(sizeH/FIELD_SCALE)) // 液体纹理高度
    gl.bindTexture(gl.TEXTURE_2D,fieldTex) // 绑定液体纹理
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,fieldW,fieldH,0,gl.RGBA,fieldType,null) // 按新尺寸分配纹理（不填内容）
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo) // 绑定帧缓冲
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,fieldTex,0) // 把纹理接到帧缓冲上，之后画进帧缓冲就是画进纹理
    if(fieldType!==gl.UNSIGNED_BYTE&&gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){ // 设备不能渲染到半精度纹理时
      fieldType=gl.UNSIGNED_BYTE // 改用 8 位纹理
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,fieldW,fieldH,0,gl.RGBA,fieldType,null) // 重新分配纹理
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null) // 恢复画到屏幕
    gl.useProgram(field.prog) // 切换到液体程序
    gl.uniform2f(field.u.uFieldRes,fieldW,fieldH) // 纹理尺寸
    gl.uniform1f(field.u.uFieldScale,FIELD_SCALE) // 每个纹理像素对应的 CSS 像素
    gl.useProgram(glass.prog) // 切换到玻璃程序
    gl.uniform1i(glass.u.uField,0) // 液体纹理使用 0 号纹理单元
    gl.uniform2f(glass.u.uFieldSize,fieldW*FIELD_SCALE,fieldH*FIELD_SCALE) // 液体纹理覆盖的 CSS 尺寸
    gl.uniform2f(glass.u.uRes,canvas.width,canvas.height) // 画布像素尺寸
    gl.uniform1f(glass.u.uDpr,dpr) // 像素密度
    readTheme() // 读取颜色和参数
    draw(performance.now()) // 立即画一帧
  }
  function draw(now){ // 画一帧：now 为当前时间
    // iOS Safari 首次打开时，工具栏调整会改变画布尺寸，却不一定触发 resize 事件。
    // 尺寸不一致时画面会被拉伸，玻璃和卡片错位，所以每次绘制前都核对一遍
    if(canvas.clientWidth!==sizeW||canvas.clientHeight!==sizeH||Math.min(window.devicePixelRatio||1,2)!==sizeDpr){ // 画布尺寸或像素密度和记录的不一致
      resize() // 重新设置（resize 里会再画）
      return // 本次不再往下画
    }
    liquidBackdrop.step(now) // 推进液体运动
    const ph=liquidBackdrop.phases() // 取当前相位
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo) // 画到液体纹理里
    gl.viewport(0,0,fieldW,fieldH) // 视口为纹理尺寸
    gl.useProgram(field.prog) // 用液体程序
    gl.uniform2fv(field.u.uWarpP,ph.warp) // 五层扭曲的相位
    ph.tint.forEach((p,k)=>{tintBuf[k*4+2]=p}) // 各条纹的相位
    gl.uniform4fv(field.u.uTint,tintBuf) // 条纹参数：方向、相位、饱和度
    gl.drawArrays(gl.TRIANGLES,0,3) // 画满整个纹理
    gl.bindFramebuffer(gl.FRAMEBUFFER,null) // 改为画到屏幕
    gl.viewport(0,0,canvas.width,canvas.height) // 视口为画布尺寸
    gl.useProgram(glass.prog) // 用玻璃程序
    gl.bindTexture(gl.TEXTURE_2D,fieldTex) // 使用刚画好的液体纹理
    // 面板位置按画布自身的位置换算：iOS 主屏幕 App 里画布不一定正好从屏幕顶端开始，按屏幕坐标算玻璃会和面板错开
    const cr=canvas.getBoundingClientRect() // 画布在屏幕上的位置
    const shown=panels.filter(el=>el.getClientRects().length) // 正在显示的面板（隐藏的不画）
    gl.uniform1i(glass.u.uPanelN,shown.length) // 面板数量
    gl.uniform1fv(glass.u.uPanelR,shown.map(el=>parseFloat(getComputedStyle(el).borderTopLeftRadius)||0).concat([0,0,0]).slice(0,3)) // 各块面板的圆角半径（从 CSS 读取，不足三块补 0）
    gl.uniform4fv(glass.u.uPanel,shown.flatMap(el=>{ // 各块面板的位置
      const r=el.getBoundingClientRect() // 面板在屏幕上的位置
      return [r.left-cr.left+r.width/2,r.top-cr.top+r.height/2,r.width/2,r.height/2] // 相对画布的中心 x、中心 y，半宽、半高
    }).concat(new Array(12).fill(0)).slice(0,12)) // 不足三块补 0
    gl.drawArrays(gl.TRIANGLES,0,3) // 画满整个屏幕
  }
  // 帧率不设上限：屏幕每刷新一次就画一帧（60Hz 屏 60 帧，高刷屏跟随浏览器给的刷新率）
  function loop(now){ // WebGL 的动画循环
    raf=requestAnimationFrame(loop) // 预约下一帧
    draw(now) // 画这一帧
  }
  function start(){ // 开始动画循环
    if(!raf&&!reduceMotion.matches) raf=requestAnimationFrame(loop) // 没在循环且没开减弱动态效果时才开始
  }
  function stop(){ // 停止动画循环
    cancelAnimationFrame(raf) // 取消下一帧
    raf=0 // 清空帧编号
  }
  function destroy(){ // 销毁 WebGL：停止动画、移除监听、释放资源
    stop() // 停止动画
    listeners.abort() // 移除所有带 signal 的监听
    observers.forEach(o=>o.disconnect()) // 断开所有尺寸观察器
    canvas.remove() // 移除画布
    document.documentElement.classList.remove("lg-webgl") // 去掉 WebGL 生效的标记，CSS 玻璃恢复
    const lose=gl.getExtension("WEBGL_lose_context") // 取“主动丢弃上下文”扩展
    if(lose&&!gl.isContextLost()) lose.loseContext() // 上下文还在就主动丢弃，立即释放显存
  }
  document.body.insertBefore(canvas,document.body.firstChild) // 画布放到页面最前面（在内容下层）
  resize() // 设置尺寸并画第一帧
  // 极少数设备不能渲染到纹理，此时改用 2D 兜底画法
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbo) // 绑定帧缓冲
  const fboOk=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE // 检查能否渲染到纹理
  gl.bindFramebuffer(gl.FRAMEBUFFER,null) // 恢复画到屏幕
  if(!fboOk){ // 不能渲染到纹理时
    destroy() // 销毁
    return null // 返回 null，改用兜底
  }
  canvas.addEventListener("webglcontextlost",()=>{ // WebGL 上下文丢失时（例如 iOS 后台回收）
    destroy() // 销毁
    onLost() // 通知控制器改用兜底
  },on) // 监听可一次性移除
  document.documentElement.classList.add("lg-webgl") // 标记 WebGL 生效，CSS 去掉玻璃底色和模糊
  start() // 开始动画
  window.addEventListener("resize",resize,on) // 窗口尺寸变化时重新设置
  if(window.visualViewport) visualViewport.addEventListener("resize",resize,on) // 可视区域尺寸变化时（iOS 工具栏收起展开）重新设置
  if(window.ResizeObserver){ // 浏览器支持 ResizeObserver 时
    ;[document.querySelector(".container"),canvas].forEach(el=>{ // 观察内容容器（面板位置变化）和画布（画布尺寸变化）
      const o=new ResizeObserver(()=>draw(performance.now())) // 尺寸变化时重画
      o.observe(el) // 开始观察
      observers.push(o) // 记入列表，销毁时断开
    })
  }
  // 旧版 Safari 不支持用 signal 移除监听，所以回调里先确认 WebGL 仍在使用
  onMediaChange(matchMedia("(prefers-color-scheme: dark)"),()=>{ // 系统深浅模式切换时
    if(listeners.signal.aborted) return // 已销毁就不管
    readTheme() // 重新读取颜色
    draw(performance.now()) // 重画
  },on) // 监听可一次性移除
  onMediaChange(reduceMotion,()=>{ // 系统“减弱动态效果”切换时
    if(listeners.signal.aborted) return // 已销毁就不管
    stop() // 先停止
    start() // 按新设置重新开始
    draw(performance.now()) // 立即画一帧
  },on) // 监听可一次性移除
  return {destroy} // 返回销毁接口
}
// 优先用 WebGL；不支持、上下文丢失或系统要求降低透明度时，用 2D 兜底背景和 CSS 玻璃。
// "降低透明度"可以随时切换，切换后立即生效。
// iOS Safari 常在页面切到后台后回收 WebGL 上下文，回到前台时重新创建
;(function liquidGlassController(){ // 立即执行：决定用 WebGL 还是兜底
  const reduceTransparency=matchMedia("(prefers-reduced-transparency: reduce)") // 系统“降低透明度”设置
  // WebGL 创建失败或运行中丢失时，先用兜底背景顶上，再按这些间隔自动重试；用完后等下次回到前台再试。
  // iOS 刚启动或从后台切回时偶尔建不起来，原来失败一次就再也不试，只剩没有折射的磨砂玻璃
  const RETRY_DELAYS=[500,1500,4000,10000] // 第 1～4 次重试前等待的毫秒数
  let webgl=null // 当前的 WebGL 实例
  let retries=0 // 已经安排过几次重试（WebGL 成功运行或回到前台时清零）
  let retryTimer=0 // 下一次重试的计时器
  function scheduleRetry(){ // 安排下一次重试
    clearTimeout(retryTimer) // 取消已安排的重试
    if(retries>=RETRY_DELAYS.length) return // 次数用完：等下次回到前台再试
    retryTimer=setTimeout(apply,RETRY_DELAYS[retries++]) // 依次等 0.5、1.5、4、10 秒再试
  }
  function onLost(){ // WebGL 运行中丢失时（例如 iOS 回收显存）
    webgl=null // 清掉 WebGL 实例
    liquidBackdrop.start() // 先用兜底背景顶上
    scheduleRetry() // 稍后重建
  }
  function create(){ // 创建 WebGL，出错时清理干净
    try{ // 尝试
      return createLiquidGlass(onLost) // 创建，丢失时调用 onLost
    }catch(error){ // 初始化出错时
      console.warn("液体玻璃初始化失败:",error) // 在控制台记录
      document.querySelectorAll(".lg-canvas").forEach(c=>c.remove()) // 移除可能残留的画布
      document.documentElement.classList.remove("lg-webgl") // 去掉 WebGL 生效的标记
      return null // 返回 null
    }
  }
  function apply(){ // 根据当前设置选择 WebGL 或兜底
    clearTimeout(retryTimer) // 这次就是在处理，取消已安排的重试
    if(reduceTransparency.matches){ // 开启了降低透明度
      if(webgl) webgl.destroy() // 有 WebGL 就销毁
      webgl=null // 清掉 WebGL 实例
      liquidBackdrop.start() // 改用兜底（实底玻璃）
      return // 结束
    }
    if(webgl) return // WebGL 已在运行就不处理
    webgl=create() // 尝试创建 WebGL
    if(webgl){ // 创建成功
      retries=0 // 重试次数清零
      liquidBackdrop.stop() // 停止兜底背景
    }else{ // 创建失败
      liquidBackdrop.start() // 先用兜底背景
      scheduleRetry() // 稍后再试
    }
  }
  apply() // 页面加载时先选一次
  onMediaChange(reduceTransparency,apply) // 降低透明度切换时重新选
  document.addEventListener("visibilitychange",()=>{ // 页面可见性变化时
    if(document.visibilityState!=="visible") return // 切到后台时不处理
    retries=0 // 回到前台：重试次数重新算
    apply() // 重新选（WebGL 被回收后会重建）
  })
  addEventListener("pageshow",event=>{ // 页面显示时（含从后退缓存恢复）
    if(!event.persisted) return // 只处理从缓存恢复的情况，首次加载已经处理过
    retries=0 // 重试次数重新算
    apply() // 重新选
  })
})() // 立即执行函数结束
