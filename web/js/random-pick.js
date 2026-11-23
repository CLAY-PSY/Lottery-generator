// 随机选号：和深度思考一样分步讲规则（思路、准备号码池、生成随机数、抽红球、抽蓝球、自我检查），不写抽号过程、不显示抽中的号码，抽完后一注一起填上
const RANDOM_MS=5000 // 随机选号的过程一共 5 秒
async function generateRandom(){ // 随机选号
  if(isRolling) return // 正在生成就忽略
  const type=getType(),rule=DEEP_RULES[type],[kr,Mr]=rule.red,[kb,Mb]=rule.blue // 彩种、红球蓝球的个数和范围
  isRolling=true // 标记为生成中
  toggleButtons(true) // 禁用按钮和切换
  resultInner.setAttribute("aria-busy","true") // 告诉读屏软件内容正在变化，先不播报
  const quick=matchMedia("(prefers-reduced-motion: reduce)").matches // 减弱动态效果时整段出现、不停顿
  const t0=performance.now() // 开始时间
  const at=ms=>quick||t0+ms<=performance.now()?Promise.resolve():new Promise(resolve=>setTimeout(resolve,t0+ms-performance.now())) // 等到开始后第 ms 毫秒（已经过了就不等）
  resultInner.innerHTML="" // 清空过程窗口
  resultInner.className="result-inner deep" // 和深度思考一样的过程窗口样式
  const head=document.createElement("div") // 标题行
  head.className="deep-head" // 样式
  head.innerHTML='<span class="deep-dot"></span><span class="deep-title">随机选号中</span><span class="deep-time"></span>' // 圆点、标题（不显示用时）
  const title=head.querySelector(".deep-title") // 标题
  const log=document.createElement("div") // 过程正文
  log.className="deep-log" // 样式
  resultInner.append(head,log) // 放进窗口
  const {follow}=logScroller(log) // 有新内容时滚到最新一行（往上翻看时不拽回），并更新上下渐隐
  const para=label=>{ // 新起一段：加粗的小标题 + 正文
    const p=document.createElement("p") // 一段
    p.className="deep-p" // 样式
    const b=document.createElement("b") // 小标题
    b.className="deep-step" // 样式
    b.textContent=label // 文字
    const body=document.createElement("span") // 正文
    p.append(b,body) // 放进段落
    log.appendChild(p) // 放进窗口
    follow() // 滚到最新
    return {p,body} // 段落和正文
  }
  const fmt=x=>x.toLocaleString("en-US") // 大数加千位逗号
  const comb=(n,k)=>{let c=1;for(let i=1;i<=k;i++)c=c*(n-k+i)/i;return Math.round(c)} // 组合数 C(n,k)
  const reds=[],blues=[] // 抽出的红球、蓝球
  let rejected=0 // 作废重抽的次数（落在分不匀的尾部，极少见）
  const draw=(M,k,picked)=>{ // 在后台抽号（窗口里只讲规则，不写抽号过程）
    const pool=Array.from({length:M},(_,i)=>i+1) // 号码池
    for(let j=0;j<k;j++){ // 抽 k 个
      const w=randomIndexWork(pool.length) // 加密随机数落在第几个区间（分不匀的尾部作废重取）
      rejected+=w.rejected.length // 记下作废的次数
      picked.push(pool.splice(w.index,1)[0]) // 取出对应号码，移出号码池（无放回）
    }
  }
  draw(Mr,kr,reds) // 抽红球
  draw(Mb,kb,blues) // 抽蓝球
  // 要写的每一段：只讲规则，逐字写出
  const plan=[
    {label:"思路",text:`为${rule.name}随机抽 1 注：${kr} 个红球 + ${kb} 个蓝球。先准备号码池，再用加密随机数逐个等概率抽取，最后自我检查。不参考冷热、遗漏等历史数据，每个号码机会完全相同，结果事先无法预测。`},
    {label:"第一步｜准备号码池",text:`红球 01–${pad2(Mr)} 共 ${Mr} 个，蓝球 01–${pad2(Mb)} 共 ${Mb} 个，分成两个互不影响的号码池。`},
    {label:"第二步｜生成随机数",text:"用浏览器的加密随机数生成器（CSPRNG），每次取一个 32 位整数，约 43 亿种取值，无法预测。把取值范围均分成和剩余号码一样多的区间，落在哪个区间就取哪个号码。"},
    {label:"第三步｜抽红球",text:`无放回抽样：每抽出一个就移出号码池，在剩下的号码里重新均分区间，${Mr} 选 1、${Mr-1} 选 1……${Mr-kr+1} 选 1，共 ${kr} 个。`},
    {label:"第四步｜抽蓝球",text:kb>1?`蓝球池单独抽，同样无放回：${Mb} 选 1、${Mb-1} 选 1，共 ${kb} 个。`:`蓝球池单独抽，${Mb} 选 1，和红球互不影响。`},
    {label:"第五步｜自我检查",text:()=>`${kr} 个红球都在 01–${pad2(Mr)}、${kb} 个蓝球都在 01–${pad2(Mb)}，没有重复；落在分不匀尾部的随机数已作废重抽（本次 ${rejected} 次），没有取模偏差。这一注是 ${fmt(comb(Mr,kr)*comb(Mb,kb))} 种组合之一，每种组合机会相同。全部通过，给出结果。`},
  ]
  // 排时间：按字数分配，全部加起来正好 5 秒（最后留一点停顿）
  const weight=s=>60+(typeof s.text==="function"?s.text():s.text).length*10 // 每段占的时间（相对值）
  const total=plan.reduce((sum,s)=>sum+weight(s),0),scale=(RANDOM_MS-200)/total // 缩放到 5 秒
  showPickGhosts(true) // 一注卡片先全是空球，抽号时依次呼吸
  let clock=0,finishPrev=()=>{} // 已经排到第几毫秒；把上一段立刻写完的函数
  for(const s of plan){ // 一段一段写：每段按排好的时刻开始，不等动画，设备慢时总时长也不被拖长
    const dur=weight(s)*scale,start=clock // 这一段占多久、从第几毫秒开始
    clock+=dur // 下一段的开始时刻
    await at(start) // 等到这一段开始
    finishPrev() // 上一段如果还没写完（设备慢、掉帧），直接补全
    finishPrev=()=>{} // 清空
    // 一个字一个字写出来
    const text=typeof s.text==="function"?s.text():s.text,{body}=para(s.label) // 正文（自我检查里写作废重抽了几次）、新起一段
    if(quick){body.textContent=text;follow();continue} // 减弱动态效果：整段出现
    let done=false // 写完没有
    const typeMs=dur-120,s0=t0+start // 写字用多久（留一点停顿）、按排好的时刻算进度
    const tick=now=>{ // 每一帧
      if(done) return // 已经补全了
      const n=Math.min(text.length,Math.ceil(text.length*(now-s0)/typeMs)) // 按时间该显示到第几个字
      body.textContent=text.slice(0,n);follow() // 显示
      if(n<text.length) requestAnimationFrame(tick);else done=true // 没写完继续
    }
    requestAnimationFrame(tick) // 开始写
    finishPrev=()=>{if(!done){done=true;body.textContent=text;follow()}} // 下一段开始时还没写完就补全
  }
  await at(RANDOM_MS-200) // 全部写完
  finishPrev() // 最后一段补全
  showPick({red:[...reds].sort((x,y)=>x-y),blue:[...blues].sort((x,y)=>x-y)}) // 一注一起填上（一个个弹出来）
  await at(RANDOM_MS) // 正好 5 秒
  title.textContent="已随机选号" // 标题改成已完成（不显示用时）
  resultInner.classList.add("deep-done") // 抽完了（过程留在窗口里，可以上下滑动回看）
  isRolling=false // 标记为生成结束
  resultInner.removeAttribute("aria-busy") // 读屏软件播报
  toggleButtons(false) // 恢复按钮和切换
}
