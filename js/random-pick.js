// 随机选号：用加密随机数逐个抽号，下面的窗口逐字写出每个球的计算过程，抽完后一注一起填上
const RANDOM_MS=5000 // 随机选号的过程一共 5 秒：每个球的计算一个字一个字写出来，写完时中间的卡片填上这个球
async function generateRandom(){ // 随机选号：一个个球抽出来，中间的卡片出一注，下面的窗口写出每个球是从哪些号码里抽出来的、怎么算的
  if(isRolling) return // 正在生成就忽略
  const type=getType(),rule=DEEP_RULES[type],[kr,Mr]=rule.red,[kb,Mb]=rule.blue // 彩种、红球蓝球的个数和范围
  isRolling=true // 标记为生成中
  toggleButtons(true) // 禁用按钮和切换
  resultInner.setAttribute("aria-busy","true") // 告诉读屏软件内容正在变化，先不播报
  const quick=matchMedia("(prefers-reduced-motion: reduce)").matches // 减弱动态效果时不停顿、不逐字写
  const t0=performance.now(),steps=kr+kb+1 // 开始时间、一共几步（每个球一步，最后的结果一步）
  const until=k=>quick?Promise.resolve():new Promise(resolve=>setTimeout(resolve,Math.max(0,t0+RANDOM_MS*k/steps-performance.now()))) // 等到第 k 步该结束的时刻（总时长平均分给每一步）
  resultInner.innerHTML="" // 清空过程窗口
  resultInner.className="result-inner deep" // 和深度思考一样的过程窗口样式
  const head=document.createElement("div") // 标题行
  head.className="deep-head" // 样式
  head.innerHTML='<span class="deep-dot"></span><span class="deep-title">随机选号中</span><span class="deep-time"></span>' // 圆点、标题（不显示实时计时）
  const title=head.querySelector(".deep-title") // 标题
  const log=document.createElement("div") // 过程正文
  log.className="deep-log" // 样式
  resultInner.append(head,log) // 放进窗口
  const fade=()=>{ // 上面还有内容就让顶部渐隐，下面还有内容就让底部渐隐
    log.classList.toggle("fade-top",log.scrollTop>1) // 往下滚过
    log.classList.toggle("fade-bottom",log.scrollTop+log.clientHeight<log.scrollHeight-1) // 还没滚到底
  }
  const line=(label,parts,ms)=>new Promise(resolve=>{ // 写一段：加粗的小标题 + 正文；parts 是 [文字, 样式] 的列表，在 ms 毫秒内一个字一个字写出来
    const p=document.createElement("p") // 一段
    p.className="deep-p" // 样式
    const b=document.createElement("b") // 小标题
    b.className="deep-step" // 样式
    b.textContent=label // 文字
    p.appendChild(b) // 小标题
    const els=parts.map(([text,cls])=>{const e=document.createElement("span");if(cls) e.className=cls;p.appendChild(e);return e}) // 每一小段文字的位置
    log.appendChild(p) // 放进窗口
    const total=parts.reduce((sum,[text])=>sum+text.length,0),start=performance.now() // 一共多少字、开始时间
    const show=count=>{ // 显示前 count 个字
      let left=count // 还能显示几个字
      parts.forEach(([text],i)=>{els[i].textContent=text.slice(0,Math.max(0,left));left-=text.length}) // 逐段填
      log.scrollTop=log.scrollHeight // 滚到最新
      fade() // 更新渐隐
    }
    if(quick||ms<=0){show(total);resolve();return} // 不逐字写：整段出现
    const tick=now=>{ // 每一帧
      const count=Math.min(total,Math.ceil(total*(now-start)/ms)) // 按时间该显示到第几个字
      show(count) // 显示
      if(count<total) requestAnimationFrame(tick);else resolve() // 没写完继续
    }
    requestAnimationFrame(tick) // 开始
  })
  const fmt=x=>x.toLocaleString("en-US") // 大数加千位逗号
  const nums=v=>v.map(pad2).join(" ") // 号码列表的写法
  showPickGhosts(true) // 一注卡片先全是空球，抽号时依次呼吸
  const reds=[],blues=[] // 抽出的红球、蓝球
  let step=0 // 第几步
  const draw=async(M,k,picked,color,name)=>{ // 抽一种颜色的球
    const pool=Array.from({length:M},(_,i)=>i+1) // 号码池：1～M
    for(let i=0;i<k;i++){ // 抽 k 个
      const m=pool.length,left=nums(pool) // 剩下几个、是哪些
      const w=randomIndexWork(m) // 加密随机数和计算过程
      const n=pool.splice(w.index,1)[0] // 抽出剩下号码里的第 index+1 个，拿出号码池
      picked.push(n) // 记下
      step++ // 这是第几步
      const end=t0+RANDOM_MS*step/steps // 这一步该结束的时刻
      await line(k>1?`第 ${i+1} 个${name}`:name,[ // 写出这一步：在这一步的时间里一个字一个字写完（留 0.15 秒停顿）
        [`剩下 ${m} 个号码：`],[left,"draw-pool"],["。"], // 从哪些号码里抽
        [w.rejected.length?`先取到的 ${w.rejected.map(fmt).join("、")} 落在除不尽的尾部，丢掉重取。`:""], // 重取过（极少见）
        [`x＝${fmt(w.x)}，${fmt(w.x)}＝${m}×${fmt(w.quotient)}＋${w.index}，余数 ${w.index}，取第 ${w.index+1} 个 → `],[pad2(n),"draw-hit"], // 计算和结果
      ],end-performance.now()-150)
      await until(step) // 等到这一步结束
    }
  }
  await draw(Mr,kr,reds,"red","红球") // 先抽红球
  await draw(Mb,kb,blues,"blue","蓝球") // 再抽蓝球
  await line("结果",[[`红球从小到大排好：${nums([...reds].sort((x,y)=>x-y))}；蓝球：${nums([...blues].sort((x,y)=>x-y))}。`]],t0+RANDOM_MS-performance.now()-150) // 最后一步：结果
  showPick({red:[...reds].sort((x,y)=>x-y),blue:[...blues].sort((x,y)=>x-y)}) // 全部抽完：一注一起填上（和深度思考一样一个个弹出来）
  await until(steps) // 正好 5 秒
  title.textContent="已随机选号" // 标题改成已完成（不显示用时）
  resultInner.classList.add("deep-done") // 抽完了（过程留在窗口里，可以上下滑动回看）
  log.onscroll=fade // 手动滚动时更新上下渐隐
  isRolling=false // 标记为生成结束
  resultInner.removeAttribute("aria-busy") // 读屏软件播报
  toggleButtons(false) // 恢复按钮和切换
}
