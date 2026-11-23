// 随机选号：用加密随机数逐个抽号；下面的窗口把抽号过程画出来——号码池、随机数落在哪一段、抽中哪个号码，抽完后一注一起填上
const RANDOM_MS=5000 // 随机选号的过程一共 5 秒：每个球一步，最后一步收尾
async function generateRandom(){ // 随机选号
  if(isRolling) return // 正在生成就忽略
  const type=getType(),rule=DEEP_RULES[type],[kr,Mr]=rule.red,[kb,Mb]=rule.blue // 彩种、红球蓝球的个数和范围
  isRolling=true // 标记为生成中
  toggleButtons(true) // 禁用按钮和切换
  resultInner.setAttribute("aria-busy","true") // 告诉读屏软件内容正在变化，先不播报
  const quick=matchMedia("(prefers-reduced-motion: reduce)").matches // 减弱动态效果时不停顿、不做动画
  const t0=performance.now(),steps=kr+kb+1,D=RANDOM_MS/steps // 开始时间、一共几步、每步多长
  const at=ms=>quick?Promise.resolve():new Promise(resolve=>setTimeout(resolve,Math.max(0,t0+ms-performance.now()))) // 等到开始后第 ms 毫秒
  resultInner.innerHTML="" // 清空过程窗口
  resultInner.className="result-inner deep" // 和深度思考一样的过程窗口样式（标题行 + 左侧竖线）
  const head=document.createElement("div") // 标题行
  head.className="deep-head" // 样式
  head.innerHTML='<span class="deep-dot"></span><span class="deep-title">随机选号中</span><span class="deep-time"></span>' // 圆点、标题（不显示用时）
  const title=head.querySelector(".deep-title") // 标题
  const view=document.createElement("div") // 可视化区域
  view.className="rp" // 样式
  resultInner.append(head,view) // 放进窗口（先放进去，才量得出宽度）
  const pool=(M,color,cols)=>{ // 号码池：每个号码一格
    const el=document.createElement("div") // 池子
    el.className=`rp-pool rp-${color}` // 红球池或蓝球池（不用 red、blue 这两个类名：它们是号码球的底色，会把整个池子染色）
    el.style.setProperty("--cols",cols) // 每行几格
    const cells=[] // 每个号码的格子
    for(let n=1;n<=M;n++){const c=document.createElement("span");c.className="rp-cell";c.textContent=pad2(n);el.appendChild(c);cells.push(c)} // 01～M
    view.appendChild(el) // 放进去
    return {el,cells} // 池子和格子
  }
  const red=pool(Mr,"red",Math.ceil(Mr/3)) // 红球池：按三个区排三行（双色球 01–11、12–22、23–33；大乐透 01–12、13–24、25–35）
  const blue=pool(Mb,"blue",view.clientWidth-13>=Mb*15+(Mb-1)*3?Mb:Math.ceil(Mb/2)) // 蓝球池：每格至少 15px 放得下就一行，太窄就两行
  const bar=document.createElement("div") // 随机数落点条：整条代表全部可能的随机数
  bar.className="rp-bar" // 样式
  bar.innerHTML='<div class="rp-segs"></div><i class="rp-mark"><b class="rp-tag"></b></i>' // 分段、落点（竖线 + 号码标签）
  const segs=bar.querySelector(".rp-segs"),mark=bar.querySelector(".rp-mark"),tag=bar.querySelector(".rp-tag") // 分段、落点、标签
  const status=document.createElement("div") // 当前这一步
  status.className="rp-status" // 样式
  const sr=document.createElement("span") // 给读屏软件的结果（不显示）
  sr.className="sr-only" // 只给读屏软件
  view.append(bar,status,sr) // 放进去
  const drop=(x,label,reject)=>{ // 落点：随机数 x 在整条上的位置（x/2^32）
    const pct=x/0x100000000*100 // 百分比
    mark.style.left=`${pct}%` // 位置
    tag.textContent=label // 标签
    tag.style.transform=`translateX(${pct<6?-12:pct>94?-88:-50}%)` // 贴边时标签往里挪，不被裁掉
    mark.className="rp-mark" // 先收起
    void mark.offsetWidth // 让浏览器先画出收起的样子，再落下（动画才会重新播放）
    mark.className=`rp-mark show${reject?" reject":""}` // 落下
  }
  showPickGhosts(true) // 一注卡片先全是空球，抽号时依次呼吸
  const reds=[],blues=[] // 抽出的红球、蓝球
  let step=0 // 第几步
  const run=async(M,k,picked,P,other,color,name)=>{ // 抽一种颜色的球
    const left=Array.from({length:M},(_,i)=>i+1) // 号码池里还在的号码
    P.el.classList.remove("idle") // 轮到的池子亮起
    other.el.classList.add("idle") // 另一个池子变淡
    segs.className=`rp-segs rp-${color}` // 分段条的颜色
    for(let i=0;i<k;i++){ // 抽 k 个
      const s0=D*step++ // 这一步的开始时刻
      const m=left.length,w=randomIndexWork(m),n=left[w.index] // 还剩几个、加密随机数落在第几段、对应的号码
      segs.innerHTML="<span></span>".repeat(m) // 整条平均分成 m 段：剩下的每个号码一段，一样宽，机会一样
      mark.className="rp-mark" // 收起上一次的落点
      status.innerHTML=`${k>1?`第 ${i+1} 个${name}`:name}<span>${m} 选 1</span>` // 这一步：第几个球、几选一
      await at(s0+D*.12) // 稍等，让分段先显示出来
      if(w.rejected.length){drop(w.rejected[0],"作废",true);await at(s0+D*.27)} // 极少见：落在分不匀的尾部，作废重取
      drop(w.x,pad2(n)) // 随机数落下
      await at(s0+D*.42) // 落稳
      segs.children[w.index].classList.add("hit") // 落中的那一段亮起
      P.cells[n-1].classList.add("drawn","hit") // 号码池里对应的号码填上颜色
      status.insertAdjacentHTML("beforeend",`<b>→ ${pad2(n)}</b>`) // 这一步抽中的号码
      left.splice(w.index,1) // 拿出号码池，不会重复
      picked.push(n) // 记下
      await at(s0+D) // 等到这一步结束
    }
  }
  await run(Mr,kr,reds,red,blue,"red","红球") // 先抽红球
  await run(Mb,kb,blues,blue,red,"blue","蓝球") // 再抽蓝球
  const ticket={red:[...reds].sort((x,y)=>x-y),blue:[...blues].sort((x,y)=>x-y)} // 这一注（从小到大）
  red.el.classList.remove("idle") // 两个池子都亮着：一眼看到抽中了哪些
  blue.el.classList.remove("idle") // 同上
  bar.classList.add("done") // 落点条收起
  status.innerHTML=`抽完 ${kr} 红 ${kb} 蓝<span>每个号码机会均等</span>` // 收尾
  sr.textContent=`红球 ${ticket.red.map(pad2).join(" ")}，蓝球 ${ticket.blue.map(pad2).join(" ")}` // 读屏软件读出这一注
  showPick(ticket) // 全部抽完：一注一起填上（一个个弹出来）
  await at(RANDOM_MS) // 正好 5 秒
  title.textContent="已随机选号" // 标题改成已完成（不显示用时）
  resultInner.classList.add("deep-done") // 抽完了（号码池和抽中的号码留在窗口里）
  isRolling=false // 标记为生成结束
  resultInner.removeAttribute("aria-busy") // 读屏软件播报
  toggleButtons(false) // 恢复按钮和切换
}
