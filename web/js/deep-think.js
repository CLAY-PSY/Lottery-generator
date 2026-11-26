// 深度思考：用彩票分析最常用的公式逐个号码计算，再让 10 个公式各自推荐号码、按回测命中率定权重、加权投票，得分最高的号留下；思考过程逐段写出
// 用到的公式（红球、蓝球分开算；N 是期数，k 是每期开出几个，M 是号码总数）：
//   理论概率 p = k ÷ M；理论平均遗漏 =（1−p）÷ p（几何分布：连续没开出的期数的期望）
//   应出次数 = N × p；标准差 = √(N × p ×（1−p）)；偏离值 Z =（出现次数 − 应出次数）÷ 标准差（二项分布的标准分）
//   当前遗漏：最近一次开出后已经过了几期；平均遗漏 = 总遗漏期数 ÷（出现次数 + 1）
//   欲出几率 = 当前遗漏 ÷ 平均遗漏；冷热指数 = 当前遗漏 ÷ 理论平均遗漏（小于 0.8 为热号，0.8～1.5 为温号，大于 1.5 为冷号）
//   遗漏概率 =（1−p）^当前遗漏（几何分布：连续这么多期没开出的可能性）
//   指数平滑：近 30 期出现情况按半衰期 8 期加权；马尔可夫一阶：按上一期开没开，统计全部历史里下一期开出的比例（拉普拉斯平滑）
// 公式投票：10 个公式各推荐 k 个号码；用近 40 期逐期回测（每期只用它之前的开奖）算各公式的命中率，越近的期分量越重（每 20 期减半），
//   再向理论命中率 p 收缩（贝叶斯平滑，伪样本 8 个），权重 = 0.3 + 2.2 × 命中率；每个号码把推荐它的公式权重加起来，得分最高的号留下。
// 全程不用随机数：同样的开奖数据，每次结果完全一样，开出新一期才会变
const VOTE={window:40,halfLife:20,prior:8,base:.3,scale:2.2} // 回测近 40 期、越近越重（每 20 期分量减半）、贝叶斯平滑的伪样本数、权重 = 0.3 + 2.2 × 命中率
const WEEKDAYS=["周日","周一","周二","周三","周四","周五","周六"] // 星期的写法（getUTCDay 的 0～6）
const historyCache={} // 上次读到的开奖历史：彩种 → 数据（联网失败时用）
async function loadHistory(type){ // 读取开奖历史（data/ssq.json、data/dlt.json，每期：[期号, 日期, 红球, 蓝球]，新的在前）：每次都向服务器确认最新版本，页面一直开着也能用上新开奖
  try{ // 先联网取
    const response=await fetch(`data/${type}.json`,{cache:"no-cache"}) // 向服务器确认最新版本（没变时服务器只回“没变”，很快）
    if(!response.ok) throw new Error(`HTTP ${response.status}`) // 读取失败
    const data=await response.json() // 解析 JSON
    if(!Array.isArray(data.draws)||data.draws.length<200) throw new Error("数据不完整") // 至少要有 200 期（近 100 期的指标 + 回测 40 期）
    historyCache[type]=data // 记下，联网失败时用
    return data // 返回
  }catch(error){ // 联网失败
    if(historyCache[type]) return historyCache[type] // 用上次读到的
    throw error // 一次都没读到过
  }
}
function ballStats(hist,col,k,M){ // 用 hist（新的在前）给每个号码算出各项指标；col 是红球 2 或蓝球 3
  const N=hist.length,W=M+1,p=k/M,lambda=.5**(1/8) // 期数、每期一行、理论概率、指数平滑的衰减（半衰期 8 期）
  const has=new Uint8Array(N*W);for(let i=0;i<N;i++)for(const n of hist[i][col])has[i*W+n]=1 // 每期每个号码开没开
  const out=[] // 结果
  for(let n=1;n<=M;n++){ // 每个号码
    let c10=0,c30=0,c100=0,call=0,gap=N,ewma=0 // 近 10、30、100 期和全部的出现次数、当前遗漏、指数平滑
    const tr=[[1,2],[1,2]] // 马尔可夫一阶：上一期没开/开了 → 下一期开出的次数、总次数（拉普拉斯平滑，各从 1/2 起）
    for(let i=0;i<N;i++){ // 从新到旧
      const y=has[i*W+n] // 这一期开没开
      if(y){call++;if(i<10)c10++;if(i<30){c30++;ewma+=lambda**i}if(i<100)c100++;if(gap===N)gap=i} // 计数；第一次碰到就是当前遗漏
      if(i+1<N){const s=has[(i+1)*W+n];tr[s][0]+=y;tr[s][1]++} // 上一期（更旧的一期）的状态 → 这一期
    }
    const z=(c,w)=>{w=Math.min(w,N);return (c-w*p)/Math.sqrt(w*p*(1-p))} // 偏离值：（出现次数 − 应出次数）÷ 标准差
    const avgGap=(N-call)/(call+1) // 平均遗漏 = 总遗漏期数 ÷（出现次数 + 1）
    const last=has[n] // 最新一期开没开（决定马尔可夫看哪一行）
    out.push({n,c10,c30,c100,call,gap,avgGap,ewma, // 基本计数
      Z30:z(c30,30),Z100:z(c100,100),Zall:z(call,N), // 三个窗口的偏离值
      want:gap/avgGap, // 欲出几率 = 当前遗漏 ÷ 平均遗漏
      heat:gap/((1-p)/p), // 冷热指数 = 当前遗漏 ÷ 理论平均遗漏
      markov:tr[last][0]/tr[last][1]}) // 马尔可夫一阶：按最新一期的状态，下一期开出的比例
  }
  return out // 每个号码一项
}
const FORMULAS=[ // 10 个公式：名字、打分（越大越看好；分数一样时遗漏少的在前，再一样号码小的在前）
  ["近 10 期热号",s=>s.c10],
  ["近 30 期偏离值",s=>s.Z30],
  ["近 100 期偏离值",s=>s.Z100],
  ["全部历史偏离值",s=>s.Zall],
  ["指数平滑",s=>s.ewma],
  ["冷热指数",s=>-s.heat], // 冷热指数越小越热
  ["欲出几率",s=>s.want],
  ["遗漏概率",s=>s.gap], // 遗漏越久，（1−p）^遗漏 越小，越“该出了”
  ["近 30 期冷号",s=>-s.c30*1000+s.gap], // 出得最少的；一样时遗漏久的在前
  ["马尔可夫转移",s=>s.markov],
]
function recommend(stats,score,k){ // 一个公式推荐的 k 个号码
  return [...stats].sort((a,b)=>score(b)-score(a)||a.gap-b.gap||a.n-b.n).slice(0,k).map(s=>s.n) // 按打分从高到低取前 k 个
}
function analyzeBall(draws,col,k,M){ // 一种球：各项指标、10 个公式回测定权重、加权投票
  const p=k/M,stats=ballStats(draws,col,k,M) // 理论概率、用全部开奖算的指标（推荐下一期用）
  const past=[];for(let i=1;i<=VOTE.window;i++)past.push({w:.5**((i-1)/VOTE.halfLife),actual:new Set(draws[i-1][col]),stats:ballStats(draws.slice(i),col,k,M)}) // 回测：第 i 期只用它之前的开奖算指标；越近的期分量越重
  const formulas=FORMULAS.map(([name,score])=>{ // 每个公式
    let wh=0,wt=0 // 加权命中数、加权推荐数
    for(const t of past){const rec=recommend(t.stats,score,k);wh+=t.w*rec.filter(n=>t.actual.has(n)).length;wt+=t.w*k} // 推荐的 k 个里开出了几个
    const rate=(wh+VOTE.prior*p)/(wt+VOTE.prior) // 命中率：向理论命中率 p 收缩（贝叶斯平滑）
    return {name,rate,weight:VOTE.base+VOTE.scale*rate,rec:recommend(stats,score,k)} // 权重、这次推荐的号码
  })
  const total=new Float64Array(M+1),votes=new Int32Array(M+1) // 每个号码的加权得分、被几个公式推荐
  formulas.forEach(f=>f.rec.forEach(n=>{total[n]+=f.weight;votes[n]++})) // 投票
  const byN=new Map(stats.map(s=>[s.n,s])) // 按号码查指标
  const ranked=Array.from({length:M},(_,i)=>i+1).sort((a,b)=>total[b]-total[a]||votes[b]-votes[a]||byN.get(b).c10-byN.get(a).c10||a-b) // 得分从高到低；一样时票数多的、近 10 期出得多的、号码小的在前
  return {p,N:draws.length,stats,formulas,total,votes,ranked} // 结果
}
function nextDrawDate(latest,days){ // 下一期的开奖日期：从最新一期往后找第一个开奖日（节假日停售时会顺延，所以只是预计）
  const d=new Date(latest+"T00:00:00Z") // 最新一期
  do d.setUTCDate(d.getUTCDate()+1);while(!days.includes(d.getUTCDay())) // 往后一天一天找
  return d.toISOString().slice(0,10) // 年-月-日
}
function pad2(n){ // 号码补零成两位（随机选号也用）
  return String(n).padStart(2,"0") // 例如 7 → 07
}
async function generateDeep(){ // 深度思考：思考过程在下面的结果卡片里一段段“写”出来，想完在中间的卡片里给出得分最高的一注
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
  const fmt=x=>x.toLocaleString("en-US") // 千位逗号
  const pct1=x=>`${(x*100).toFixed(1)}%` // 一位小数的百分比
  const sign=x=>`${x>=0?"+":"−"}${Math.abs(x).toFixed(1)}` // 带正负号、一位小数
  try{ // 尝试
    const data=await loadHistory(type),draws=data.draws,latest=draws[0],T=draws.length // 读取全部开奖记录（新的在前）、最新一期、期数
    const [kr,Mr]=rule.red,[kb,Mb]=rule.blue // 红球、蓝球的个数和范围
    const next=new Date(nextDrawDate(latest[1],rule.drawDays)+"T00:00:00Z") // 下一期预计的开奖日期
    const R=analyzeBall(draws,2,kr,Mr),B=analyzeBall(draws,3,kb,Mb) // 红球、蓝球：指标、公式权重、投票
    const reds=R.ranked.slice(0,kr).sort((a,b)=>a-b) // 得分最高的红球
    const jackpots=new Set(draws.map(d=>d[2].join(",")+"|"+d[3].join(","))) // 开过的头奖组合
    let blues=B.ranked.slice(0,kb),swapped=null // 得分最高的蓝球；为了不撞历史头奖换掉的蓝球
    const key=()=>reds.join(",")+"|"+[...blues].sort((a,b)=>a-b).join(",") // 这一注的写法（和头奖记录一样的格式）
    for(let i=kb;jackpots.has(key())&&i<B.ranked.length;i++){swapped=swapped||blues[kb-1];blues=[...B.ranked.slice(0,kb-1),B.ranked[i]]} // 万一和开过的头奖一模一样，最后一个蓝球换成下一个
    blues=blues.sort((a,b)=>a-b) // 蓝球从小到大
    const p=R.p,tg=(1-p)/p,E=T*p,sd=Math.sqrt(T*p*(1-p)),tgB=(1-B.p)/B.p // 红球理论概率、理论平均遗漏、应出次数、标准差；蓝球理论平均遗漏
    const hot=R.stats.reduce((x,y)=>y.Zall>x.Zall?y:x),cold=R.stats.reduce((x,y)=>y.Zall<x.Zall?y:x),due=R.stats.reduce((x,y)=>y.want>x.want?y:x) // 全部历史偏离值最高、最低的红球，欲出几率最高的红球
    const heatCount=(lo,hi)=>R.stats.filter(s=>s.heat>=lo&&s.heat<hi).length // 冷热指数在某个范围的红球个数
    const byRate=[...R.formulas].sort((x,y)=>y.rate-x.rate),top=R.ranked[0] // 公式按命中率排、得分最高的红球
    await write("思路",`为${rule.name}选 1 注：用彩票分析最常用的公式，逐个号码算出现次数、偏离值、遗漏、欲出几率和冷热指数，再让 10 个公式各自推荐号码，按近 ${VOTE.window} 期的命中率给公式定权重，加权投票，得分最高的号留下。`)
    await write("数据",`共 ${fmt(T)} 期（${draws[T-1][1]} 至 ${latest[1]}），最新第 ${latest[0]} 期：红 ${nums(latest[2])}，蓝 ${nums(latest[3])}。下一期预计 ${next.getUTCMonth()+1} 月 ${next.getUTCDate()} 日（${WEEKDAYS[next.getUTCDay()]}）开奖。`)
    await write("第一步｜基础公式",`红球理论概率 p = ${kr}÷${Mr} = ${pct1(p)}，理论平均遗漏 =（1−p）÷ p = ${tg.toFixed(1)} 期（几何分布）；全部 ${fmt(T)} 期里每个号码应出 N×p = ${Math.round(E)} 次，标准差 √(N×p×(1−p)) = ${sd.toFixed(1)} 次。蓝球 p = ${kb}÷${Mb} = ${pct1(B.p)}，理论平均遗漏 ${tgB.toFixed(1)} 期。`)
    await write("第二步｜逐号计算",`偏离值 Z =（出现次数 − 应出次数）÷ 标准差：全部历史最热的 ${pad2(hot.n)}（Z = ${sign(hot.Zall)}），最冷的 ${pad2(cold.n)}（Z = ${sign(cold.Zall)}）。欲出几率 = 当前遗漏 ÷ 平均遗漏：最高的 ${pad2(due.n)}（${due.gap} 期 ÷ ${due.avgGap.toFixed(1)} 期 = ${due.want.toFixed(1)}）。冷热指数 = 当前遗漏 ÷ 理论平均遗漏：热号 ${heatCount(0,.8)} 个（小于 0.8）、温号 ${heatCount(.8,1.5000001)} 个、冷号 ${heatCount(1.5000001,Infinity)} 个（大于 1.5）。`)
    await write("第三步｜公式定权重",`10 个公式各推荐 ${kr} 个红球、${kb} 个蓝球：${FORMULAS.map(f=>f[0]).join("、")}。用近 ${VOTE.window} 期逐期回测，每期只用之前的开奖；越近的期分量越重（每 ${VOTE.halfLife} 期减半），再向理论命中率 ${pct1(p)} 收缩（贝叶斯平滑），权重 = ${VOTE.base} + ${VOTE.scale} × 命中率。红球最准的「${byRate[0].name}」${pct1(byRate[0].rate)}，最弱的「${byRate[byRate.length-1].name}」${pct1(byRate[byRate.length-1].rate)}。`)
    await write("第四步｜加权投票",`每个号码把推荐它的公式的权重加起来，取得分最高的 ${kr} 个红球、${kb} 个蓝球：红 ${nums(reds)}，蓝 ${nums(blues)}。红球 ${pad2(top)} 得分最高（${R.total[top].toFixed(2)}），有 ${R.votes[top]} 个公式推荐。`)
    const okNums=(v,[n,max])=>v.length===n&&v.every((y,i)=>y>=1&&y<=max&&(!i||y>v[i-1])) // 个数、范围、从小到大不重复
    const ok=okNums(reds,rule.red)&&okNums(blues,rule.blue)&&!jackpots.has(key()) // 自我检查
    await write("第五步｜自我检查",ok?`号码个数和范围正确，没有重复${swapped?`；原来那注和开过的头奖一样，蓝球 ${pad2(swapped)} 换成了下一个`:"，也不是开过的头奖组合"}，全部通过。`:"有一项没通过，请再试一次。")
    title.textContent="已深度思考" // 标题改成已完成（不显示用时）
    resultInner.classList.add("deep-done") // 想完了（思考过程留在窗口里，可以上下滑动回看）
    showPick({red:reds,blue:blues}) // 中间的卡片填上这一注
  }catch(error){ // 读取或计算出错
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
