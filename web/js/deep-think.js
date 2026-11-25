// 深度思考：看全部开奖记录，画出每个号码的冷热走势，看好哪个号就留哪个号；思考过程逐段写出
// 冷热怎么算：每个号码看近 10 期、近 30 期、近 100 期和全部历史各出现几次，各自和平均水平比（1 是平均），按 4:3:2:1 加权，越近的分量越重；
// 分数最高的就是最热的号。分数一样时，遗漏期数少的（最近出过的）更热，再一样时号码小的在前。
// 全程不用随机数：同样的开奖数据，每次结果完全一样，开出新一期才会变
const HOT={windows:[10,30,100,0],weights:[4,3,2,1]} // 看哪几段：近 10 期、近 30 期、近 100 期、全部历史（0 表示全部）；各段的分量
const WEEKDAYS=["周日","周一","周二","周三","周四","周五","周六"] // 星期的写法（getUTCDay 的 0～6）
const historyCache={} // 上次读到的开奖历史：彩种 → 数据（联网失败时用）
async function loadHistory(type){ // 读取开奖历史（data/ssq.json、data/dlt.json，每期：[期号, 日期, 红球, 蓝球]，新的在前）：每次都向服务器确认最新版本，页面一直开着也能用上新开奖
  try{ // 先联网取
    const response=await fetch(`data/${type}.json`,{cache:"no-cache"}) // 向服务器确认最新版本（没变时服务器只回“没变”，很快）
    if(!response.ok) throw new Error(`HTTP ${response.status}`) // 读取失败
    const data=await response.json() // 解析 JSON
    if(!Array.isArray(data.draws)||data.draws.length<100) throw new Error("数据不完整") // 至少要有 100 期（看近 100 期）
    historyCache[type]=data // 记下，联网失败时用
    return data // 返回
  }catch(error){ // 联网失败
    if(historyCache[type]) return historyCache[type] // 用上次读到的
    throw error // 一次都没读到过
  }
}
function hotColdOf(draws,col,k,M){ // 每个号码的冷热（draws 新的在前，col 是红球 2 或蓝球 3，每期开 k 个、号码 1～M）：按从热到冷排好
  const T=draws.length,spans=HOT.windows.map(w=>w||T),total=HOT.weights.reduce((a,b)=>a+b,0) // 期数、每段多少期、分量合计
  const out=[] // 结果
  for(let n=1;n<=M;n++){ // 每个号码
    const counts=spans.map(span=>{let c=0;for(let i=0;i<span;i++)if(draws[i][col].includes(n))c++;return c}) // 每段出现了几次
    const score=HOT.weights.reduce((s,w,i)=>s+w*counts[i]/(spans[i]*k/M),0)/total // 热度：各段出现次数和平均水平的比，加权平均（1 是平均）
    let gap=draws.findIndex(d=>d[col].includes(n));if(gap<0)gap=T // 遗漏：已经连续几期没出（0 表示最新一期就出了）
    out.push({n,counts,score,gap,cls:gap<=3?"热":gap<=8?"温":"冷"}) // 走势图的常见划分：近 4 期出过是热号，遗漏 4～8 期是温号，更久是冷号
  }
  return out.sort((a,b)=>b.score-a.score||a.gap-b.gap||a.n-b.n) // 从热到冷
}
function nextDrawDate(latest,days){ // 下一期的开奖日期：从最新一期往后找第一个开奖日（节假日停售时会顺延，所以只是预计）
  const d=new Date(latest+"T00:00:00Z") // 最新一期
  do d.setUTCDate(d.getUTCDate()+1);while(!days.includes(d.getUTCDay())) // 往后一天一天找
  return d.toISOString().slice(0,10) // 年-月-日
}
function pad2(n){ // 号码补零成两位（随机选号也用）
  return String(n).padStart(2,"0") // 例如 7 → 07
}
async function generateDeep(){ // 深度思考：思考过程在下面的结果卡片里一段段“写”出来，想完在中间的卡片里给出最热的一注
  if(isRolling) return // 正在生成就忽略
  const type=getType(),rule=DEEP_RULES[type] // 开始时的彩种和规则
  isRolling=true // 标记为生成中
  showPickGhosts(true) // 一注的位置：空球呼吸，表示正在想
  toggleButtons(true) // 禁用按钮和切换
  resultInner.setAttribute("aria-busy","true") // 告诉读屏软件内容正在变化，先不播报
  const quick=matchMedia("(prefers-reduced-motion: reduce)").matches // 减弱动态效果时文字整段出现
  resultInner.innerHTML="" // 清空结果
  resultInner.className="result-inner deep" // 深度思考样式
  resultInner.scrollTop=0 // 滚回顶部
  const head=document.createElement("div") // 标题行
  head.className="deep-head" // 样式
  head.innerHTML='<span class="deep-dot"></span><span class="deep-title">深度思考中</span><span class="deep-time"></span>' // 圆点、标题（不显示实时计时）
  const title=head.querySelector(".deep-title") // 标题
  const log=document.createElement("div") // 思考过程正文
  log.className="deep-log" // 样式
  log.id="deep-log" // 供标题行的 aria-controls 引用
  resultInner.append(head,log) // 放进结果区
  const {follow}=logScroller(log) // 有新内容时滚到最新一行（往上翻看时不拽回），并更新上下渐隐
  const write=(label,text)=>new Promise(resolve=>{ // 写一段：开头是加粗的小标题，正文一个字一个字出现（每秒约 120 个字）
    const p=document.createElement("p") // 一段
    p.className="deep-p" // 样式
    if(label){const b=document.createElement("b");b.className="deep-step";b.textContent=label;p.appendChild(b)} // 小标题
    const body=document.createElement("span") // 正文
    p.appendChild(body) // 放进段落
    log.appendChild(p) // 放进思考过程
    if(quick){body.textContent=text;follow();setTimeout(()=>resolve(body),120);return} // 减弱动态效果：整段出现
    let shown=0,last=performance.now() // 已显示的字数、上一帧时间
    const step=now=>{ // 每一帧
      shown=Math.min(text.length,shown+Math.max(1,Math.round((now-last)*.12))) // 按经过的时间多显示几个字
      last=now;body.textContent=text.slice(0,shown);follow() // 显示
      if(shown<text.length) requestAnimationFrame(step) // 没写完继续
      else setTimeout(()=>resolve(body),160) // 写完停一下
    }
    requestAnimationFrame(step) // 开始
  })
  const nums=v=>v.map(pad2).join(" ") // 号码列表的写法
  const list=v=>v.map(pad2).join("、") // 号码顿号分隔的写法
  const fmt=x=>x.toLocaleString("en-US") // 千位逗号
  try{ // 尝试
    const data=await loadHistory(type),draws=data.draws,latest=draws[0],T=draws.length // 读取全部开奖记录（新的在前）、最新一期、期数
    const [kr,Mr]=rule.red,[kb,Mb]=rule.blue // 红球、蓝球的个数和范围
    const next=new Date(nextDrawDate(latest[1],rule.drawDays)+"T00:00:00Z") // 下一期预计的开奖日期
    const red=hotColdOf(draws,2,kr,Mr),blue=hotColdOf(draws,3,kb,Mb) // 红球、蓝球从热到冷
    const reds=red.slice(0,kr).map(s=>s.n).sort((a,b)=>a-b) // 最热的红球，留下
    const blueRank=blue.map(s=>s.n),jackpots=new Set(draws.map(d=>d[2].join(",")+"|"+d[3].join(","))) // 蓝球从热到冷、开过的头奖组合
    let blues=blueRank.slice(0,kb),swapped=null // 最热的蓝球；为了不撞历史头奖换掉的蓝球
    const key=()=>reds.join(",")+"|"+[...blues].sort((a,b)=>a-b).join(",") // 这一注的写法（和头奖记录一样的格式）
    for(let i=kb;jackpots.has(key())&&i<blueRank.length;i++){swapped=swapped||blues[kb-1];blues=[...blueRank.slice(0,kb-1),blueRank[i]]} // 万一和开过的头奖一模一样，最后一个蓝球换成下一个最热的
    blues=blues.sort((a,b)=>a-b) // 蓝球从小到大
    const count=c=>red.filter(s=>s.cls===c).length,coldest=red.reduce((x,y)=>y.gap>x.gap?y:x) // 红球各类的个数、遗漏最久的红球
    await write("思路",`为${rule.name}选 1 注：看全部开奖记录，画出每个号码的冷热走势，看好哪个号就留哪个号。`)
    await write("数据",`共 ${fmt(T)} 期（${draws[T-1][1]} 至 ${latest[1]}），最新第 ${latest[0]} 期：红 ${nums(latest[2])}，蓝 ${nums(latest[3])}。下一期预计 ${next.getUTCMonth()+1} 月 ${next.getUTCDate()} 日（${WEEKDAYS[next.getUTCDay()]}）开奖。`)
    await write("第一步｜看冷热走势",`每个号码都看近 10 期、近 30 期、近 100 期和全部 ${fmt(T)} 期各出现几次，越近的分量越重。红球现在热号 ${count("热")} 个、温号 ${count("温")} 个、冷号 ${count("冷")} 个：最热的 ${pad2(red[0].n)} 近 10 期出了 ${red[0].counts[0]} 次，最冷的 ${pad2(coldest.n)} 已经 ${coldest.gap} 期没出。蓝球最热的是 ${list(blueRank.slice(0,kb))}。`)
    await write("第二步｜推荐选号",`看好最热的号，就留下它们：红 ${nums(reds)}，蓝 ${nums(blues)}。`)
    const okNums=(v,[n,max])=>v.length===n&&v.every((y,i)=>y>=1&&y<=max&&(!i||y>v[i-1])) // 个数、范围、从小到大不重复
    const ok=okNums(reds,rule.red)&&okNums(blues,rule.blue)&&!jackpots.has(key()) // 自我检查
    await write("第三步｜自我检查",ok?`号码个数和范围正确，没有重复${swapped?`；原来那注和开过的头奖一样，蓝球 ${pad2(swapped)} 换成了下一个最热的`:"，也不是开过的头奖组合"}，全部通过。`:"有一项没通过，请再试一次。")
    title.textContent="已深度思考" // 标题改成已完成（不显示用时）
    resultInner.classList.add("deep-done") // 想完了（思考过程留在窗口里，可以上下滑动回看）
    showPick({red:reds,blue:blues}) // 中间的卡片填上这一注
  }catch(error){ // 读取出错
    console.warn("深度思考失败:",error) // 在控制台记录
    showPickGhosts(false) // 一注的位置恢复成空球
    resultInner.innerHTML="" // 清空
    resultInner.className="result-inner" // 普通样式
    const p=document.createElement("div") // 提示
    p.className="deep-p" // 样式
    p.style.alignSelf="stretch" // 占满宽度
    p.textContent="读取开奖历史失败，请联网后重试" // 提示内容
    resultInner.appendChild(p) // 显示
  }finally{ // 无论成败
    isRolling=false // 标记为生成结束
    resultInner.removeAttribute("aria-busy") // 读屏软件播报结果
    toggleButtons(false) // 恢复按钮和切换
  }
}
