// 随机选号：用加密随机数逐个抽号，下面的窗口逐字讲清每一步的抽样逻辑（熵源、等分区间、无放回、独立、拒绝采样），抽完后一注一起填上
const RANDOM_MS=5000 // 随机选号的过程一共 5 秒：每个球一步，一个字一个字写出来
async function generateRandom(){ // 随机选号：一个个球抽出来，中间的卡片出一注，下面的窗口讲每一步的抽样逻辑
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
  const {follow}=logScroller(log) // 有新内容时滚到最新一行（往上翻看时不拽回），并更新上下渐隐
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
      follow() // 滚到最新（往上翻看时不拽回），更新渐隐
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
  const comb=(n,k)=>{let c=1;for(let i=1;i<=k;i++)c=c*(n-k+i)/i;return Math.round(c)} // 组合数 C(n,k)
  // 每一步讲一个抽样环节，只写必要的数字（几选一），过程中不显示抽中的号码；第 i 个红球用第 i 句，最后一个红球单独一句
  const redWhy=[
    (M,m)=>`从 ${M} 个号码中等概率抽取：浏览器的加密随机数生成器（CSPRNG）给出一个 32 位整数，整个取值范围均分成 ${m} 个区间，落在哪个区间就取哪个号码`, // 熵源、等分区间
    (M,m)=>`无放回抽样：上一个号码移出号码池，样本空间缩小到 ${m} 个，重新均分区间`, // 无放回
    (M,m)=>`每次抽取相互独立，前面的结果不影响这一次，${m} 个号码的概率都是 1/${m}`, // 独立性
    ()=>`随机数落在分不匀的尾部会作废重抽（拒绝采样），没有取模偏差，保证严格等概率`, // 拒绝采样
    (M,m)=>`不参考冷热、遗漏等历史统计，${m} 个号码一视同仁`, // 不看历史
  ]
  const blueWhy=[
    (M,m)=>`蓝球是独立的号码池（01–${pad2(M)}），和红球互不影响，${m} 选 1`, // 独立号码池
    (M,m)=>`无放回：上一个蓝球移出蓝球池，${m} 选 1`, // 无放回
  ]
  showPickGhosts(true) // 一注卡片先全是空球，抽号时依次呼吸
  const reds=[],blues=[] // 抽出的红球、蓝球
  let step=0 // 第几步
  const draw=async(M,k,picked,why,name)=>{ // 抽一种颜色的球
    const pool=Array.from({length:M},(_,i)=>i+1) // 号码池：1～M
    for(let i=0;i<k;i++){ // 抽 k 个
      const m=pool.length // 池子里还剩几个
      const w=randomIndexWork(m) // 加密随机数落在第几个区间（分不匀的尾部作废重取）
      const n=pool.splice(w.index,1)[0] // 取出对应的号码，移出号码池
      picked.push(n) // 记下
      step++ // 这是第几步
      const end=t0+RANDOM_MS*step/steps // 这一步该结束的时刻
      const say=i===k-1&&k>2?`最后一个${name}，${m} 选 1`:(why[i]||why[why.length-1])(M,m) // 这一步讲什么
      await line(k>1?`第 ${i+1} 个${name}`:name,[ // 写出这一步：在这一步的时间里一个字一个字写完（留 0.15 秒停顿）
        [say+(w.rejected.length?`（这次确实作废重抽了 ${w.rejected.length} 次）`:"")+"。"], // 抽样逻辑（不显示抽中的号码）
      ],end-performance.now()-150)
      await until(step) // 等到这一步结束
    }
  }
  await draw(Mr,kr,reds,redWhy,"红球") // 先抽红球
  await draw(Mb,kb,blues,blueWhy,"蓝球") // 再抽蓝球
  const total=comb(Mr,kr)*comb(Mb,kb) // 一共有多少种不同的组合
  await line("结果",[[`红球从小到大：${nums([...reds].sort((x,y)=>x-y))}；蓝球：${nums([...blues].sort((x,y)=>x-y))}。这一注是 ${fmt(total)} 种组合之一，每种组合被抽中的机会完全相同。`]],t0+RANDOM_MS-performance.now()-150) // 最后一步：结果
  showPick({red:[...reds].sort((x,y)=>x-y),blue:[...blues].sort((x,y)=>x-y)}) // 全部抽完：一注一起填上（和深度思考一样一个个弹出来）
  await until(steps) // 正好 5 秒
  title.textContent="已随机选号" // 标题改成已完成（不显示用时）
  resultInner.classList.add("deep-done") // 抽完了（过程留在窗口里，可以上下滑动回看）
  isRolling=false // 标记为生成结束
  resultInner.removeAttribute("aria-busy") // 读屏软件播报
  toggleButtons(false) // 恢复按钮和切换
}
