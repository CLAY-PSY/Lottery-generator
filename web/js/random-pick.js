// 随机选号：用加密随机数逐个抽号，下面的窗口像控制台跑代码一样写出过程（逐字敲出命令、返回结果），抽完后一注一起填上
const RANDOM_MS=5000 // 随机选号的过程一共 5 秒
async function generateRandom(){ // 随机选号
  if(isRolling) return // 正在生成就忽略
  const type=getType(),rule=DEEP_RULES[type],[kr,Mr]=rule.red,[kb,Mb]=rule.blue // 彩种、红球蓝球的个数和范围
  isRolling=true // 标记为生成中
  toggleButtons(true) // 禁用按钮和切换
  resultInner.setAttribute("aria-busy","true") // 告诉读屏软件内容正在变化，先不播报
  const quick=matchMedia("(prefers-reduced-motion: reduce)").matches // 减弱动态效果时不逐字敲，直接出结果
  const t0=performance.now() // 开始时间
  const at=ms=>quick?Promise.resolve():new Promise(resolve=>setTimeout(resolve,Math.max(0,t0+ms-performance.now()))) // 等到开始后第 ms 毫秒
  resultInner.innerHTML="" // 清空过程窗口
  resultInner.className="result-inner deep" // 和深度思考一样的过程窗口样式
  const head=document.createElement("div") // 标题行
  head.className="deep-head" // 样式
  head.innerHTML='<span class="deep-dot"></span><span class="deep-title">随机选号中</span><span class="deep-time"></span>' // 圆点、标题（不显示用时）
  const title=head.querySelector(".deep-title") // 标题
  const log=document.createElement("div") // 控制台
  log.className="deep-log code" // 样式：等宽字体、语法高亮
  resultInner.append(head,log) // 放进窗口
  const {follow}=logScroller(log) // 有新内容时滚到最新一行（往上翻看时不拽回），并更新上下渐隐
  const hex=x=>"0x"+x.toString(16).padStart(8,"0") // 32 位随机数写成十六进制
  const nums=v=>v.map(pad2).join(" ") // 号码列表的写法
  const comb=(n,k)=>{let c=1;for(let i=1;i<=k;i++)c=c*(n-k+i)/i;return Math.round(c)} // 组合数 C(n,k)
  // 先把要“执行”的每一行准备好：kind 是 in（输入的命令，逐字敲出）、out（返回结果）、note（注释）；parts 是 [文字, 高亮样式]
  const script=[] // 每一行
  const cmd=(...parts)=>script.push({kind:"in",parts:[["> ","c-p"],...parts]}) // 命令行
  const out=(...parts)=>script.push({kind:"out",parts:[["< ","c-p"],...parts]}) // 返回结果
  const note=text=>script.push({kind:"note",parts:[[text,"c-c"]]}) // 注释
  const reds=[],blues=[] // 抽出的红球、蓝球
  const pool=(name,M,k,picked)=>{ // 建一个号码池并抽 k 个
    cmd(["const ","c-k"],[`${name} = `],["pool","c-f"],["("],["1","c-n"],[", "],[String(M),"c-n"],[")"]) // const red = pool(1, 33)
    out(["Pool(","c-o"],[String(M),"c-n"],[") [01 … ","c-o"],[pad2(M),"c-o"],["]","c-o"]) // Pool(33) [01 … 33]
    const left=Array.from({length:M},(_,i)=>i+1) // 池子里还在的号码
    for(let i=0;i<k;i++){ // 抽 k 个
      const m=left.length,w=randomIndexWork(m),n=left.splice(w.index,1)[0] // 还剩几个；加密随机数落在第几个区间；取出对应号码（无放回）
      picked.push(n) // 记下
      cmd([`${name}.`],["draw","c-f"],["()"],[`${name==="red"?"  ":" "} // ${hex(w.x)}`,"c-c"]) // red.draw()   // 0x8f3a21c4（这次的加密随机数）
      w.rejected.forEach(x=>note(`// ${hex(x)} 在尾部，作废重抽`)) // 极少见：落在分不匀的尾部，拒绝采样
      out([pad2(n),name==="red"?"c-r":"c-b"],[`   // ${m} 选 1`,"c-c"]) // < 19   // 33 选 1（红球红色、蓝球蓝色）
    }
  }
  note(`// ${rule.name} · ${kr} 红 + ${kb} 蓝`) // 开头的注释：彩种、个数
  note("// 熵源 crypto.getRandomValues") // 随机数来源：浏览器的加密随机数生成器
  pool("red",Mr,kr,reds) // 红球池
  pool("blue",Mb,kb,blues) // 蓝球池
  const ticket={red:[...reds].sort((x,y)=>x-y),blue:[...blues].sort((x,y)=>x-y)} // 这一注（从小到大）
  cmd(["ticket","c-f"],[".sort()"]) // 排序
  out(["红 [","c-o"],[nums(ticket.red),"c-r"],["] 蓝 [","c-o"],[nums(ticket.blue),"c-b"],["]","c-o"]) // 结果
  note(`// ${(comb(Mr,kr)*comb(Mb,kb)).toLocaleString("en-US")} 种组合之一 · 机会均等 ✓`) // 组合总数：每种组合机会相同
  // 排时间：命令按字数逐字敲，结果和注释稍停后出现；全部加起来正好 5 秒（最后留一点停顿）
  const len=l=>l.parts.reduce((s,[t])=>s+t.length,0) // 一行有几个字
  const weight=l=>l.kind==="in"?90+len(l)*14:l.kind==="out"?110:60+len(l)*4 // 每行占的时间（相对值）
  const total=script.reduce((s,l)=>s+weight(l),0),scale=(RANDOM_MS-250)/total // 按比例缩放到 5 秒
  showPickGhosts(true) // 一注卡片先全是空球，抽号时依次呼吸
  const cursor=document.createElement("span") // 闪烁的光标
  cursor.className="c-cur" // 样式
  let clock=0,finishPrev=()=>{} // 已经排到第几毫秒；把上一行立刻补全的函数
  for(const l of script){ // 一行一行“执行”：每行按排好的时刻开始，不等动画，总时长不会因为设备慢而拖长
    const dur=weight(l)*scale,start=clock // 这一行占多久、从第几毫秒开始
    clock+=dur // 下一行的开始时刻
    const row=document.createElement("div") // 一行
    row.className=`c-line ${l.kind}` // 样式
    const spans=l.parts.map(([t,cls])=>{const s=document.createElement("span");if(cls)s.className=cls;row.appendChild(s);return s}) // 每一小段文字
    const full=()=>{l.parts.forEach(([t],i)=>{spans[i].textContent=t});follow()} // 整行显示出来
    if(t0+start>performance.now()) await at(start) // 等到这一行开始（已经晚了就不再等：设备很慢时一次补上好几行，总时长不被拖长）
    finishPrev() // 上一行如果还没敲完（设备慢、掉帧），直接补全
    log.appendChild(row) // 放进控制台
    row.appendChild(cursor) // 光标跟在这一行后面
    if(l.kind==="in"&&!quick){ // 命令：逐字敲出来
      const n=len(l),typeMs=dur*.75,s0=t0+start // 一共几个字、敲字用多久（剩下的是回车前的停顿）、按排好的时刻算进度
      let done=false // 敲完没有
      const tick=now=>{ // 每一帧
        if(done) return // 已经补全了
        const c=Math.min(n,Math.ceil(n*(now-s0)/typeMs)) // 按时间该显示到第几个字
        let left=c // 还能显示几个字
        l.parts.forEach(([t],i)=>{spans[i].textContent=t.slice(0,Math.max(0,left));left-=t.length}) // 逐段填
        follow() // 滚到最新
        if(c<n) requestAnimationFrame(tick);else done=true // 没敲完继续
      }
      requestAnimationFrame(tick) // 开始敲
      finishPrev=()=>{if(!done){done=true;full()}} // 下一行开始时还没敲完就补全
    }else{full();finishPrev=()=>{}} // 结果和注释：整行出现
  }
  await at(RANDOM_MS-250) // 全部写完
  finishPrev() // 最后一行补全
  cursor.remove() // 收起光标
  showPick(ticket) // 一注一起填上（一个个弹出来）
  await at(RANDOM_MS) // 正好 5 秒
  title.textContent="已随机选号" // 标题改成已完成（不显示用时）
  resultInner.classList.add("deep-done") // 抽完了（过程留在窗口里，可以上下滑动回看）
  isRolling=false // 标记为生成结束
  resultInner.removeAttribute("aria-busy") // 读屏软件播报
  toggleButtons(false) // 恢复按钮和切换
}
