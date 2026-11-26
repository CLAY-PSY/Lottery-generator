// 深度思考：参考 GitHub 上开源彩票分析项目常用的方法，整理成 16 个公式，用全部开奖历史从头到尾逐期回测，按真实命中率给公式定权重，加权投票选出一注；思考过程逐段写出
// 16 个公式（红球、蓝球分开算；每个公式给每个号码打分，取分最高的 k 个作为它的推荐；N 是期数，k 是每期开出几个，M 是号码总数，p = k ÷ M）：
//   近 10 期热号、近 30 / 100 期和全部历史的偏离值 Z =（出现次数 − 应出次数）÷ √(期数 × p ×（1−p）)（二项分布的标准分）
//   指数平滑（半衰期 8 期）、冷热指数 = 当前遗漏 ÷ 理论平均遗漏（1−p）÷ p、欲出几率 = 当前遗漏 ÷ 平均遗漏、遗漏概率（遗漏越久越看好）、近 30 期冷号
//   一阶 / 二阶马尔可夫：按这个号码上一期（上两期）开没开，统计全部历史里下一期开出的比例（拉普拉斯平滑）
//   朴素贝叶斯：用“上期开没开、当前遗漏分档、近 10 期次数分档”三个特征，按全部历史算开出的后验概率（拉普拉斯平滑）
//   关联规则：上一期开出的每个号码，在全部历史里下一期带出这个号码的提升度（条件概率 ÷ p）取平均
//   傅里叶周期：每个号码的出现序列在 2～40 期的周期上做离散傅里叶变换，取能量最强的周期，推算下一期的波动值
//   形态走势：奇偶、大小、012 路、尾数、区间五种分组的指数平滑热度，号码所在分组越热分越高
//   逻辑回归：用前面的指标当特征，按时间顺序逐期学习全部历史（在线梯度下降），输出开出的概率
// 回测：从第 101 期起，每一期只用它之前的开奖算出 16 个公式的推荐，和这一期的开奖比对，一直做到最新一期（全部历史，不留窗口）
// 定权重：Hedge 指数加权算法（“预测专家”问题的经典方法）：每期按各公式命中数比平均多少调整权重，学习率 η = √(8 ln 16 ÷ 回测期数) ÷ k
// 投票：每个号码把推荐它的公式的权重加起来，得分最高的号留下。全程不用随机数：同样的开奖数据，每次结果完全一样，开出新一期才会变
const ENGINE={start:100,halfLife:8,periods:40,assocPrior:10,lr:.02} // 从第 101 期开始回测、指数平滑半衰期 8 期、傅里叶最长周期 40 期、关联规则的伪样本数、逻辑回归的学习率
const FORMULAS=["近 10 期热号","近 30 期偏离值","近 100 期偏离值","全部历史偏离值","指数平滑","冷热指数","欲出几率","遗漏概率","近 30 期冷号","一阶马尔可夫","二阶马尔可夫","朴素贝叶斯","关联规则","傅里叶周期","形态走势","逻辑回归"] // 16 个公式的名字（顺序和下面打分的顺序一致）
const WEEKDAYS=["周日","周一","周二","周三","周四","周五","周六"] // 星期的写法（getUTCDay 的 0～6）
const historyCache={} // 上次读到的开奖历史：彩种 → 数据（联网失败时用）
async function loadHistory(type){ // 读取开奖历史（data/ssq.json、data/dlt.json，每期：[期号, 日期, 红球, 蓝球]，新的在前）：每次都向服务器确认最新版本，页面一直开着也能用上新开奖
  try{ // 先联网取
    const response=await fetch(`data/${type}.json`,{cache:"no-cache"}) // 向服务器确认最新版本（没变时服务器只回“没变”，很快）
    if(!response.ok) throw new Error(`HTTP ${response.status}`) // 读取失败
    const data=await response.json() // 解析 JSON
    if(!Array.isArray(data.draws)||data.draws.length<200) throw new Error("数据不完整") // 至少要有 200 期（前 100 期打底，之后逐期回测）
    historyCache[type]=data // 记下，联网失败时用
    return data // 返回
  }catch(error){ // 联网失败
    if(historyCache[type]) return historyCache[type] // 用上次读到的
    throw error // 一次都没读到过
  }
}
function gapBucket(g){ // 当前遗漏分档（朴素贝叶斯用）：0、1～2、3～5、6～10、11～20、21 期以上
  return g===0?0:g<=2?1:g<=5?2:g<=10?3:g<=20?4:5 // 六档
}
async function analyzeBall(draws,col,k,M){ // 一种球（col 是红球 2 或蓝球 3）：按时间从早到晚走一遍全部开奖，逐期回测 16 个公式、Hedge 定权重，最后给下一期打分投票
  const N=draws.length,W=M+1,F=FORMULAS.length,p=k/M,tg=(1-p)/p,lambda=.5**(1/ENGINE.halfLife),NP=ENGINE.periods-1 // 期数、数组宽度、公式数、理论概率、理论平均遗漏、指数平滑衰减、周期个数（2～40）
  const seq=draws.map(d=>d[col]).reverse() // 每期开出的号码，从早到晚
  const cnt=new Int32Array(W),last=new Int32Array(W).fill(-1),ewma=new Float64Array(W) // 出现次数、最近一次开出在第几期、指数平滑
  const WINS=[10,30,100],win=WINS.map(()=>new Int32Array(W)) // 近 10、30、100 期的出现次数
  const x1=new Uint8Array(W),x2=new Uint8Array(W) // 上一期、上两期开没开
  const m1a=new Float64Array(W*2),m1t=new Float64Array(W*2),m2a=new Float64Array(W*4),m2t=new Float64Array(W*4) // 马尔可夫一阶、二阶：各状态下开出次数、总次数
  const nbY=new Float64Array(2),nbA=new Float64Array(4),nbB=new Float64Array(12),nbC=new Float64Array(8) // 朴素贝叶斯的计数：类别、上期开没开、遗漏分档、近 10 期次数分档
  const co=new Float64Array(W*W),occ=new Float64Array(W) // 关联规则：上期开出 m、这期开出 n 的次数，m 开出（且有下一期）的次数
  const fc=new Float64Array(W*NP),fs=new Float64Array(W*NP) // 傅里叶：每个号码在每个周期上的余弦、正弦累加
  const ATTR=[[2,n=>n%2],[2,n=>n>M/2?1:0],[3,n=>n%3],[10,n=>n%10],[3,n=>Math.floor((n-1)*3/M)]] // 形态分组：奇偶、大小、012 路、尾数、区间（分组数、号码 → 组）
  const gSize=ATTR.map(([G,f])=>{const a=new Float64Array(G);for(let n=1;n<=M;n++)a[f(n)]++;return a}),gE=ATTR.map(([G])=>new Float64Array(G)) // 每组有几个号码、每组的指数平滑热度
  const LF=10,wl=new Float64Array(LF);wl[0]=Math.log(p/(1-p)) // 逻辑回归：10 个特征的系数（截距从理论概率起步）
  const feats=new Float64Array(W*LF),score=Array.from({length:F},()=>new Float64Array(W)),gapNow=new Int32Array(W) // 每个号码的特征、16 个公式的打分、当前遗漏
  const hits=new Float64Array(F),logw=new Float64Array(F) // 各公式回测命中数、Hedge 的对数权重
  const BT=N-ENGINE.start,eta=Math.sqrt(8*Math.log(F)/BT)/k // 回测期数、Hedge 学习率
  let prev=[],tick=performance.now() // 上一期开出的号码、上次让出主线程的时间
  const sig=x=>1/(1+Math.exp(-x)) // S 形函数
  const pick=(sc)=>{const out=[],used=new Uint8Array(W);for(let r=0;r<k;r++){let b=0;for(let n=1;n<=M;n++){if(used[n])continue;if(!b||sc[n]>sc[b]||sc[n]===sc[b]&&(gapNow[n]<gapNow[b]||gapNow[n]===gapNow[b]&&n<b))b=n}used[b]=1;out.push(b)}return out} // 一个公式推荐的 k 个号码：分高的在前；一样时遗漏少的、号码小的在前
  const scoreAll=t=>{ // 用第 t 期之前的开奖，给每个号码算 16 个公式的分（t 期还没开）
    const avgGapOf=n=>(t-cnt[n])/(cnt[n]+1) // 平均遗漏 = 总遗漏期数 ÷（出现次数 + 1）
    const z=(c,w)=>{w=Math.min(w,t);return w?(c-w*p)/Math.sqrt(w*p*(1-p)):0} // 偏离值
    const gMean=gE.map((e,a)=>{let s=0;for(let g=0;g<e.length;g++)s+=e[g];return s/e.length||1}) // 每种分组的平均热度
    const nbPrior=Math.log((nbY[1]+1)/(nbY[0]+1)) // 朴素贝叶斯的先验对数几率
    for(let n=1;n<=M;n++){
      const gap=last[n]<0?t:t-1-last[n];gapNow[n]=gap // 当前遗漏
      const c10=win[0][n],c30=win[1][n],c100=win[2][n] // 近 10、30、100 期次数
      const s1=x1[n],s2=x2[n]*2+x1[n],m1=(m1a[n*2+s1]+1)/(m1t[n*2+s1]+2),m2=(m2a[n*4+s2]+1)/(m2t[n*4+s2]+2) // 马尔可夫一阶、二阶的概率
      const B=gapBucket(gap),C=Math.min(c10,3) // 遗漏分档、近 10 期次数分档（朴素贝叶斯的特征）
      const nb=sig(nbPrior+Math.log((nbA[2+s1]+1)/(nbY[1]+2))-Math.log((nbA[s1]+1)/(nbY[0]+2))+Math.log((nbB[6+B]+1)/(nbY[1]+6))-Math.log((nbB[B]+1)/(nbY[0]+6))+Math.log((nbC[4+C]+1)/(nbY[1]+4))-Math.log((nbC[C]+1)/(nbY[0]+4))) // 后验概率
      let lift=1;if(prev.length){lift=0;for(const m of prev)lift+=(co[m*W+n]+ENGINE.assocPrior*p)/(occ[m]+ENGINE.assocPrior)/p;lift/=prev.length} // 关联规则：上期号码带出它的平均提升度
      let four=0;if(t>=2){let bj=0,bp=-1;for(let j=0;j<NP;j++){const q=fc[n*NP+j]**2+fs[n*NP+j]**2;if(q>bp){bp=q;bj=j}}const P=bj+2,ang=2*Math.PI*t/P;four=cnt[n]/t+2/t*(fc[n*NP+bj]*Math.cos(ang)+fs[n*NP+bj]*Math.sin(ang))} // 傅里叶：最强周期推算的下一期值
      let attr=0;ATTR.forEach(([G,f],a)=>{attr+=gE[a][f(n)]/gMean[a]-1}) // 形态走势：所在分组比平均热多少
      const zAll=z(cnt[n],t),ew=ewma[n]*(1-lambda) // 全部历史偏离值、指数平滑折算成比例
      const fe=feats.subarray(n*LF,n*LF+LF);fe[0]=1;fe[1]=c10/10-p;fe[2]=c30/Math.max(1,Math.min(30,t))-p;fe[3]=c100/Math.max(1,Math.min(100,t))-p;fe[4]=zAll/3;fe[5]=Math.min(gap/tg,4)/4;fe[6]=ew-p;fe[7]=s1;fe[8]=m1-p;fe[9]=lift-1 // 逻辑回归的 10 个特征
      let lin=0;for(let i=0;i<LF;i++)lin+=wl[i]*fe[i] // 线性部分
      const v=[c10,z(c30,30),z(c100,100),zAll,ewma[n],-gap/tg,avgGapOf(n)>0?gap/avgGapOf(n):0,gap,-c30*1000+gap,m1,m2,nb,lift,four,attr,sig(lin)] // 16 个公式的分（越大越看好）
      for(let f=0;f<F;f++)score[f][n]=v[f]
    }
  }
  for(let t=0;t<N;t++){ // 逐期：先用之前的开奖打分、回测，再把这一期加进历史
    if(performance.now()-tick>12){await new Promise(r=>setTimeout(r));tick=performance.now()} // 每算 12 毫秒歇一下，液体动画和空球呼吸不卡
    const cur=seq[t],y=new Uint8Array(W);for(const n of cur)y[n]=1 // 这一期开出的号码
    scoreAll(t)
    if(t>=ENGINE.start){ // 回测：16 个公式的推荐和这一期比对
      const h=new Float64Array(F);let mean=0
      for(let f=0;f<F;f++){for(const n of pick(score[f]))h[f]+=y[n];hits[f]+=h[f];mean+=h[f]/F} // 每个公式命中几个
      for(let f=0;f<F;f++)logw[f]+=eta*(h[f]-mean) // Hedge：比平均多中就加权，少中就减权
    }
    for(let n=1;n<=M;n++){ // 学习这一期
      const fe=feats.subarray(n*LF,n*LF+LF);let lin=0;for(let i=0;i<LF;i++)lin+=wl[i]*fe[i];const g=ENGINE.lr*(y[n]-sig(lin));for(let i=0;i<LF;i++)wl[i]+=g*fe[i] // 逻辑回归：在线梯度下降
      const s1=x1[n],s2=x2[n]*2+x1[n],gap=gapNow[n];nbY[y[n]]++;nbA[y[n]*2+s1]++;nbB[y[n]*6+gapBucket(gap)]++;nbC[y[n]*4+Math.min(win[0][n],3)]++ // 朴素贝叶斯计数
      m1t[n*2+s1]++;m1a[n*2+s1]+=y[n];m2t[n*4+s2]++;m2a[n*4+s2]+=y[n] // 马尔可夫计数
      ewma[n]=lambda*ewma[n]+y[n];x2[n]=x1[n];x1[n]=y[n] // 指数平滑、上两期状态
    }
    for(const m of prev){occ[m]++;for(const n of cur)co[m*W+n]++} // 关联规则计数
    for(const n of cur){cnt[n]++;last[n]=t;for(let j=0;j<NP;j++){const ang=2*Math.PI*t/(j+2);fc[n*NP+j]+=Math.cos(ang);fs[n*NP+j]+=Math.sin(ang)}} // 出现次数、最近一次、傅里叶累加
    WINS.forEach((w,i)=>{for(const n of cur)win[i][n]++;if(t-w>=0)for(const n of seq[t-w])win[i][n]--}) // 窗口计数
    ATTR.forEach(([G,f],a)=>{const c=new Float64Array(G);for(const n of cur)c[f(n)]++;for(let g=0;g<G;g++)gE[a][g]=lambda*gE[a][g]+c[g]/gSize[a][g]}) // 形态分组热度
    prev=cur // 这一期成为“上一期”
  }
  scoreAll(N) // 给下一期打分
  const mx=Math.max(...logw),ex=Array.from(logw,v=>Math.exp(v-mx)),sum=ex.reduce((a,b)=>a+b,0) // Hedge 权重归一化
  const formulas=FORMULAS.map((name,f)=>({name,rate:hits[f]/(BT*k),z:(hits[f]-BT*k*p)/Math.sqrt(BT*k*p*(1-p)),weight:ex[f]/sum*F,rec:pick(score[f])})) // 每个公式：全部历史命中率、和理论比的标准分、权重（平均 1）、这次推荐的号码
  const total=new Float64Array(W),votes=new Int32Array(W) // 每个号码的加权得分、被几个公式推荐
  formulas.forEach(f=>f.rec.forEach(n=>{total[n]+=f.weight;votes[n]++})) // 投票
  const ranked=Array.from({length:M},(_,i)=>i+1).sort((a,b)=>total[b]-total[a]||votes[b]-votes[a]||win[0][b]-win[0][a]||a-b) // 得分从高到低；一样时票数多的、近 10 期出得多的、号码小的在前
  const stats=Array.from({length:M},(_,i)=>{const n=i+1,gap=gapNow[n],avgGap=(N-cnt[n])/(cnt[n]+1);return {n,call:cnt[n],gap,avgGap,Zall:(cnt[n]-N*p)/Math.sqrt(N*p*(1-p)),want:gap/avgGap,heat:gap/tg}}) // 每个号码的指标（写思考过程用）
  let chi=0;for(let n=1;n<=M;n++)chi+=(cnt[n]-N*p)**2/(N*p) // 卡方：全部历史每个号码的出现次数和应出次数比
  let per={n:1,P:2,amp:0};for(let n=1;n<=M;n++)for(let j=0;j<NP;j++){const amp=2*Math.hypot(fc[n*NP+j],fs[n*NP+j])/N;if(amp>per.amp)per={n,P:j+2,amp}} // 全部历史里周期性最强的号码和周期
  return {p,N,BT,eta,stats,formulas,total,votes,ranked,chi,df:M-1,per,samples:N*M} // 结果
}
function chiP(x,df){ // 卡方分布右尾概率（Wilson–Hilferty 近似：把卡方变换成近似标准正态）
  const z=(Math.cbrt(x/df)-(1-2/(9*df)))/Math.sqrt(2/(9*df)),t=1/(1+.3275911*Math.abs(z)/Math.SQRT2) // 标准分、误差函数近似的中间量
  const erf=1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-z*z/2) // 误差函数（Abramowitz–Stegun 7.1.26）
  return z>=0?(1-erf)/2:(1+erf)/2 // 右尾概率
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
    const job=(async()=>[await analyzeBall(draws,2,kr,Mr),await analyzeBall(draws,3,kb,Mb)])() // 红球、蓝球：全部历史逐期回测、公式权重、投票（分段计算，和下面写字同时进行）
    job.catch(()=>{}) // 出错时由下面的 await 处理，这里不重复报“未处理的错误”
    await write("思路",`为${rule.name}选 1 注：参考 GitHub 上开源彩票分析项目常用的方法（统计指标、马尔可夫链、贝叶斯、关联规则、傅里叶周期、逻辑回归），整理成 16 个公式；用全部 ${fmt(T)} 期开奖从头到尾逐期回测，按每个公式在全部历史里的真实命中率定权重，加权投票，得分最高的号留下。`)
    await write("数据",`共 ${fmt(T)} 期（${draws[T-1][1]} 至 ${latest[1]}），最新第 ${latest[0]} 期：红 ${nums(latest[2])}，蓝 ${nums(latest[3])}。下一期预计 ${next.getUTCMonth()+1} 月 ${next.getUTCDate()} 日（${WEEKDAYS[next.getUTCDay()]}）开奖。`)
    const [R,B]=await job // 等回测算完（不显示进度）
    const reds=R.ranked.slice(0,kr).sort((a,b)=>a-b) // 得分最高的红球
    const jackpots=new Set(draws.map(d=>d[2].join(",")+"|"+d[3].join(","))) // 开过的头奖组合
    let blues=B.ranked.slice(0,kb),swapped=null // 得分最高的蓝球；为了不撞历史头奖换掉的蓝球
    const key=()=>reds.join(",")+"|"+[...blues].sort((a,b)=>a-b).join(",") // 这一注的写法（和头奖记录一样的格式）
    for(let i=kb;jackpots.has(key())&&i<B.ranked.length;i++){swapped=swapped||blues[kb-1];blues=[...B.ranked.slice(0,kb-1),B.ranked[i]]} // 万一和开过的头奖一模一样，最后一个蓝球换成下一个
    blues=blues.sort((a,b)=>a-b) // 蓝球从小到大
    const p=R.p,tg=(1-p)/p,E=T*p,sd=Math.sqrt(T*p*(1-p)),tgB=(1-B.p)/B.p // 红球理论概率、理论平均遗漏、应出次数、标准差；蓝球理论平均遗漏
    const hot=R.stats.reduce((x,y)=>y.Zall>x.Zall?y:x),cold=R.stats.reduce((x,y)=>y.Zall<x.Zall?y:x),due=R.stats.reduce((x,y)=>y.want>x.want?y:x) // 全部历史偏离值最高、最低的红球，欲出几率最高的红球
    const heatCount=(lo,hi)=>R.stats.filter(s=>s.heat>=lo&&s.heat<hi).length // 冷热指数在某个范围的红球个数
    const byRate=[...R.formulas].sort((x,y)=>y.rate-x.rate),byW=[...R.formulas].sort((x,y)=>y.weight-x.weight),top=R.ranked[0] // 公式按命中率排、按权重排；得分最高的红球
    const pv=chiP(R.chi,R.df) // 全部历史红球分布的卡方检验 p 值
    await write("第一步｜基础公式",`红球理论概率 p = ${kr}÷${Mr} = ${pct1(p)}，理论平均遗漏 =（1−p）÷ p = ${tg.toFixed(1)} 期；全部 ${fmt(T)} 期里每个号码应出 N×p = ${Math.round(E)} 次，标准差 ${sd.toFixed(1)} 次。卡方检验 χ² = Σ（出现次数 − 应出次数）² ÷ 应出次数 = ${R.chi.toFixed(1)}（自由度 ${R.df}，p ${pv<.01?"< 0.01":"= "+pv.toFixed(2)}）。蓝球 p = ${kb}÷${Mb} = ${pct1(B.p)}，理论平均遗漏 ${tgB.toFixed(1)} 期。`)
    await write("第二步｜逐号计算",`全部历史偏离值最热的 ${pad2(hot.n)}（Z = ${sign(hot.Zall)}），最冷的 ${pad2(cold.n)}（Z = ${sign(cold.Zall)}）；欲出几率最高的 ${pad2(due.n)}（${due.gap} 期 ÷ ${due.avgGap.toFixed(1)} 期 = ${due.want.toFixed(1)}）；冷热指数：热号 ${heatCount(0,.8)} 个、温号 ${heatCount(.8,1.5000001)} 个、冷号 ${heatCount(1.5000001,Infinity)} 个。傅里叶变换找到周期最明显的是 ${pad2(R.per.n)}（约每 ${R.per.P} 期一个起伏）。`)
    await write("第三步｜全部历史回测",`16 个公式：${FORMULAS.join("、")}。从第 ${ENGINE.start+1} 期起，每期只用它之前的开奖算推荐，逐期回测到最新一期，共 ${fmt(R.BT)} 期；逻辑回归边回测边学习，共学了 ${fmt(R.samples+B.samples)} 个样本。红球命中率最高的「${byRate[0].name}」${pct1(byRate[0].rate)}（Z = ${sign(byRate[0].z)}）、「${byRate[1].name}」${pct1(byRate[1].rate)}、「${byRate[2].name}」${pct1(byRate[2].rate)}，理论 ${pct1(p)}。`)
    await write("第四步｜公式定权重",`用 Hedge 指数加权算法：每期命中比平均多的公式加权、少的减权，学习率 η = √(8 ln 16 ÷ 回测期数) ÷ ${kr} = ${R.eta.toFixed(4)}。全部历史走完，红球权重最高的「${byW[0].name}」×${byW[0].weight.toFixed(2)}、「${byW[1].name}」×${byW[1].weight.toFixed(2)}、「${byW[2].name}」×${byW[2].weight.toFixed(2)}（平均 1.00）。`)
    await write("第五步｜加权投票",`每个号码把推荐它的公式的权重加起来，取得分最高的 ${kr} 个红球、${kb} 个蓝球：红 ${nums(reds)}，蓝 ${nums(blues)}。红球 ${pad2(top)} 得分最高（${R.total[top].toFixed(2)}），有 ${R.votes[top]} 个公式推荐。`)
    const okNums=(v,[n,max])=>v.length===n&&v.every((y,i)=>y>=1&&y<=max&&(!i||y>v[i-1])) // 个数、范围、从小到大不重复
    const ok=okNums(reds,rule.red)&&okNums(blues,rule.blue)&&!jackpots.has(key()) // 自我检查
    await write("第六步｜自我检查",ok?`号码个数和范围正确，没有重复${swapped?`；原来那注和开过的头奖一样，蓝球 ${pad2(swapped)} 换成了下一个`:"，也不是开过的头奖组合"}，全部通过。`:"有一项没通过，请再试一次。")
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
