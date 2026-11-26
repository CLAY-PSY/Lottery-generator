// 两种彩票的规则；中间的号码卡片：空球（依次呼吸）和填上号码（随机选号一注；深度思考 A、B 两注）
const DEEP_RULES={ // 两种彩票的规则
  ssq:{name:"双色球",red:[6,33],blue:[1,16],zones:[[1,11],[12,22],[23,33]],drawDays:[2,4,0]}, // 双色球：6 红（1～33）+ 1 蓝（1～16），红球分三区（深度思考的区间专家用）；每周二、四、日开奖（0 是周日）
  dlt:{name:"大乐透",red:[5,35],blue:[2,12],zones:[[1,12],[13,24],[25,35]],drawDays:[1,3,6]}, // 大乐透：5 红（1～35）+ 2 蓝（1～12），红球分三区；每周一、三、六开奖
}
const pickLine=document.getElementById("pick-line") // 号码卡片里放号码的地方
function pickTags(){ // 要放几注：深度思考是 A、B 两注，随机选号一注（不标字母）
  return getMode()==="deep"?["A","B"]:[""] // 每注的标签
}
function pickRow(tag){ // 新建一行（一注）：深度思考时开头有 A、B 标签
  const row=document.createElement("div") // 一行
  row.className="pick-row" // 样式
  if(tag){const t=document.createElement("span");t.className="pick-tag";t.textContent=tag;t.setAttribute("aria-label",`方案 ${tag}`);row.appendChild(t)} // 标签
  pickLine.appendChild(row) // 放进卡片
  return row // 返回这一行
}
function showPickGhosts(thinking){ // 号码的位置先放空球（几注、红球蓝球个数按当前选号方式和彩种）；thinking 为 true 时空球依次呼吸
  const rule=DEEP_RULES[getType()],[kr]=rule.red,[kb]=rule.blue // 红球、蓝球个数
  pickLine.innerHTML="" // 清空
  pickLine.classList.toggle("thinking",!!thinking) // 思考中
  pickTags().forEach((tag,r)=>{ // 每一注
    const row=pickRow(tag) // 一行
    for(let i=0;i<kr+kb;i++){ // 每个位置
      const ghost=document.createElement("span") // 空球
      ghost.className=`ball ghost ${i<kr?"red":"blue"}` // 红球或蓝球的位置
      ghost.style.animationDelay=`${(r*(kr+kb)+i)*.12}s` // 依次呼吸，像波浪（第二行接着第一行）
      row.appendChild(ghost) // 放进去
    }
  })
}
function showPick(tickets){ // 填上算出来的号码，一个个弹出来；tickets 是一注 {red,blue}，或几注 [{tag,red,blue}]
  const list=Array.isArray(tickets)?tickets:[{tag:"",...tickets}] // 统一成几注
  pickLine.classList.remove("thinking") // 不再是思考中
  pickLine.innerHTML="" // 去掉空球
  let k=0 // 第几个球（弹出的先后）
  list.forEach(t=>{ // 每一注
    const row=pickRow(t.tag) // 一行
    ;[...t.red.map(n=>[n,"red"]),...t.blue.map(n=>[n,"blue"])].forEach(([n,color])=>{ // 每个号码
      const ball=createBall(n,color) // 号码球
      ball.classList.add("reveal") // 弹出动画
      ball.style.animationDelay=`${k++*.07}s` // 一个接一个
      row.appendChild(ball) // 放进去
    })
  })
}
