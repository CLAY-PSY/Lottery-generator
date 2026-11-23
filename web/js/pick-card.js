// 两种彩票的规则；中间的一注卡片：空球（依次呼吸）和填上号码
const DEEP_RULES={ // 两种彩票的规则
  ssq:{name:"双色球",red:[6,33],blue:[1,16],zones:[[1,11],[12,22],[23,33]],maxShare:3}, // 双色球：6 红（1～33）+ 1 蓝（1～16），红球分三区；5 注之间最多共用 3 个红球
  dlt:{name:"大乐透",red:[5,35],blue:[2,12],zones:[[1,12],[13,24],[25,35]],maxShare:2}, // 大乐透：5 红（1～35）+ 2 蓝（1～12）；最多共用 2 个红球
}
const pickLine=document.getElementById("pick-line") // 深度思考的一注
function showPickGhosts(thinking){ // 一注的位置先放空球（红球、蓝球个数按当前彩种）；thinking 为 true 时空球依次呼吸
  const rule=DEEP_RULES[getType()],[kr]=rule.red,[kb]=rule.blue // 红球、蓝球个数
  pickLine.innerHTML="" // 清空
  pickLine.classList.toggle("thinking",!!thinking) // 思考中
  for(let i=0;i<kr+kb;i++){ // 每个位置
    const ghost=document.createElement("span") // 空球
    ghost.className=`ball ghost ${i<kr?"red":"blue"}` // 红球或蓝球的位置
    ghost.style.animationDelay=`${i*.12}s` // 依次呼吸，像波浪
    pickLine.appendChild(ghost) // 放进去
  }
}
function showPick(ticket){ // 填上算出来的一注，一个个弹出来
  pickLine.classList.remove("thinking") // 不再是思考中
  pickLine.innerHTML="" // 去掉空球
  ;[...ticket.red.map(n=>[n,"red"]),...ticket.blue.map(n=>[n,"blue"])].forEach(([n,color],i)=>{ // 每个号码
    const ball=createBall(n,color) // 号码球
    ball.classList.add("reveal") // 弹出动画
    ball.style.animationDelay=`${i*.07}s` // 一个接一个
    pickLine.appendChild(ball) // 放进去
  })
}
