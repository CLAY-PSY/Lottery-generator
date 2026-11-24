// 深度思考：读取全部开奖历史，研究走势图和开奖日期，十二位专家打分、回测、加权，精确计算一注，思考过程逐段写出
// ===== 流程（过程像推理模型一样实时显示）=====
// 开奖是独立事件，任何号码组合的中奖概率都一样，历史统计不能提高中奖概率。这里按严谨的统计流程来做，并如实显示结论：
// 1. 走势图：逐期算出 12 张走势图（和值、跨度、AC 值、奇偶、大小、质合、区间、012 路、尾数、连号、重号、蓝球），
//    每张图做 Ljung-Box 检验（前 10 期的自相关）看走势会不会延续；再定出各图的常见范围（合起来覆盖历史上 80% 的开奖），用来筛选组合
// 2. 开奖日期：红球、蓝球分别按星期、月份、年份分组做卡方检验，再检验全部开奖是否均匀（按每期不放回抽取校正）
// 3. 十二位专家各自给下一期每个号码估概率，逐期往前走，每期只用它之前的数据：
//    频率（按时间衰减）、遗漏（同样遗漏期数时的开出率）、周期（每个号码自己的出号间隔）、回补（长期少出的号）、
//    转移（上期开出某号后的开出率）、邻号（和上期号码的重号、邻号、隔号关系）、尾数、012 路、区间（同组号码的热度）、
//    星期（同一开奖日）、同期（往年同一时段）、神经网络（现场训练）；有参数的专家先用回测前的 300 期挑出最准的参数
// 4. 回测：最近 200 期逐期检验，算各专家的对数损失和命中；最好的专家和均衡基准做配对检验（12 位里挑最好的，按 Bonferroni 校正）
// 5. 贝叶斯模型平均（按缓和系数降温）：把“均衡基准”（每个号码机会均等）也当作一个模型，按回测损失算后验权重，混合成最终概率
// 6. 选号：取最被看好的 20 个红球，枚举全部组合，去掉走势图上少见的形态，取得分最高的一注；蓝球取得分最高、又不和这注红球凑成历史头奖的
// 7. 自我检查：号码规则、走势图形态、历史头奖逐项核对
// 全程不用随机数：神经网络的起点由彩种和最新期号决定，选号按得分排序。同样的开奖数据，每次点击结果完全一样，开出新一期才会变
const DEEP={window:200,tune:300,pool:20,temper:5,cover:.8,lags:10,recent:30} // 回测最近 200 期、调参用回测前的 300 期、从最被看好的 20 个红球里选号、权重的缓和系数、走势图常见范围合起来覆盖 80% 的开奖、自相关检验看前 10 期、近期走势看 30 期
const NN={features:15,hidden:16,epochs:6,train:1100,valid:200} // 神经网络设置：每个号码 15 项特征、隐藏层 16 个神经元、训练 6 轮、用 1100 期训练、最近 200 期留作回测（和其他专家同一段）
const WEEKDAYS=["周日","周一","周二","周三","周四","周五","周六"] // 星期的写法（getUTCDay 的 0～6）
const historyCache={} // 已读取的开奖历史：彩种 → 数据
async function loadHistory(type){ // 读取开奖历史（data/ssq.json、data/dlt.json，每期：[期号, 日期, 红球, 蓝球]，新的在前）
  if(historyCache[type]) return historyCache[type] // 读过就直接用
  const response=await fetch(`data/${type}.json`,{cache:"no-cache"}) // 向服务器确认最新版本
  if(!response.ok) throw new Error(`HTTP ${response.status}`) // 读取失败
  const data=await response.json() // 解析 JSON
  if(!Array.isArray(data.draws)||data.draws.length<600) throw new Error("数据不完整") // 数据太少（回测 200 期 + 调参 300 期 + 起步）
  historyCache[type]=data // 缓存
  return data // 返回
}
function randomFloat(){ // [0,1) 内的随机小数（用加密随机数；trainNet 的默认参数，深度思考里传入固定序列，不会用到）
  return randomIntUnbiased(0x100000000)/0x100000000 // 32 位随机整数除以 2^32
}
function seededRandom(text){ // 由一段文字得到固定的“随机数”序列：同样的文字，每次得到的序列完全一样（神经网络的起点用它，结果可以复现）
  let h=2166136261 // FNV-1a 哈希的初始值
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)} // 把文字哈希成 32 位整数
  let a=h>>>0 // 种子
  return ()=>{ // 每调用一次给出下一个 [0,1) 的小数（mulberry32 算法）
    a=(a+0x6D2B79F5)>>>0 // 推进状态
    let t=Math.imul(a^a>>>15,a|1) // 打乱
    t^=t+Math.imul(t^t>>>7,t|61) // 再打乱
    return ((t^t>>>14)>>>0)/4294967296 // 转成 [0,1)
  }
}
// ===== 统计检验用的函数 =====
function lnGamma(x){ // ln Γ(x)（Lanczos 近似，精度约 15 位）
  const c=[.99999999999980993,676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7] // 系数
  if(x<.5) return Math.log(Math.PI/Math.sin(Math.PI*x))-lnGamma(1-x) // 反射公式
  x-=1 // 公式里用 x-1
  let a=c[0] // 级数
  for(let i=1;i<9;i++) a+=c[i]/(x+i) // 累加
  const t=x+7.5 // g=7
  return .5*Math.log(2*Math.PI)+(x+.5)*Math.log(t)-t+Math.log(a) // 结果
}
function gammaQ(a,x){ // 正则化上不完全伽马函数 Q(a,x)：卡方分布、正态分布的尾部概率都由它算
  if(x<=0) return 1 // 边界
  const front=Math.exp(-x+a*Math.log(x)-lnGamma(a)) // 公共因子
  if(x<a+1){ // x 较小：用级数算 P，再 Q=1-P
    let sum=1/a,term=sum // 级数和、当前项
    for(let n=1;n<1000;n++){term*=x/(a+n);sum+=term;if(Math.abs(term)<Math.abs(sum)*1e-15)break} // 累加到收敛
    return Math.max(0,1-sum*front) // Q
  }
  let b=x+1-a,c=1e300,d=1/b,h=d // x 较大：用连分式（Lentz 算法）
  for(let i=1;i<1000;i++){ // 迭代到收敛
    const an=-i*(i-a) // 分子
    b+=2;d=an*d+b;if(Math.abs(d)<1e-300)d=1e-300;c=b+an/c;if(Math.abs(c)<1e-300)c=1e-300 // 推进
    d=1/d;const del=d*c;h*=del;if(Math.abs(del-1)<1e-15)break // 收敛就停
  }
  return front*h // Q
}
function chiP(stat,df){ // 卡方检验的 p 值：自由度 df 的卡方分布里，比 stat 更大的概率
  return gammaQ(df/2,stat/2) // P(χ² ≥ stat)
}
function normP(z){ // 标准正态分布的双侧 p 值：P(|Z| ≥ |z|)
  return gammaQ(.5,z*z/2) // erfc(|z|/√2)
}
function zoneOf(zones,n){ // 号码 n 在第几个区（从 0 数）
  return zones.findIndex(([lo,hi])=>n>=lo&&n<=hi) // 落在哪个区间
}
// ===== 神经网络 =====
function nnTrainSpan(total){ // 训练用几期：最多 1100 期，前面至少留 100 期用来算特征
  return Math.max(100,Math.min(NN.train,total-NN.valid-100)) // 期数
}
function nnSamples(draws,col,k,max,zones,nextDate){ // 把开奖历史整理成样本：每一期的每个号码一个样本（15 项特征 → 这一期有没有开出）
  const F=NN.features // 特征个数
  const ch=draws.slice().reverse() // 按时间从早到晚排列
  const T=ch.length // 总期数
  const valid=NN.valid // 验证期数
  const train=nnTrainSpan(T) // 训练期数
  const start=T-train-valid // 第一个样本所在的期
  const W=max+1 // 每期一行（下标 0 不用）
  const pre=new Int32Array((T+1)*W) // 前缀和：pre[t*W+n] 是前 t 期里号码 n 开出的次数
  for(let t=0;t<T;t++){ // 每一期
    for(let n=1;n<=max;n++) pre[(t+1)*W+n]=pre[t*W+n] // 先抄上一行
    for(const n of ch[t][col]) pre[(t+1)*W+n]++ // 这一期开出的号码加一
  }
  const count=(t,w,n)=>pre[t*W+n]-pre[Math.max(0,t-w)*W+n] // 第 t 期之前 w 期里号码 n 开出的次数
  const expect=w=>w*k/max // w 期里每个号码平均开出的次数
  const groups=[n=>n%10,n=>n%3,n=>zoneOf(zones,n)] // 尾数、012 路、区间
  const mates=groups.map(g=>Array.from({length:W},(_,n)=>{const out=[];if(n)for(let m=1;m<=max;m++)if(g(m)===g(n))out.push(m);return out})) // 每个号码的同组号码（含自己）
  const weekday=t=>new Date((t<T?ch[t][1]:nextDate)+"T00:00:00Z").getUTCDay() // 第 t 期是星期几（t=T 是下一期）
  const wdCount=Array.from({length:7},()=>new Float64Array(W)),wdDraws=new Float64Array(7) // 每个开奖日：各号码开出次数、开奖期数
  const rows=(T-start+1)*max // 样本数：训练 + 验证 + 最后一组（下一期，用来预测）
  const X=new Float32Array(rows*F) // 特征
  const Y=new Uint8Array(rows) // 答案：这一期开出了就是 1
  const last=new Int32Array(W).fill(-1) // 每个号码最近一次开出的期
  for(let t=0;t<=T;t++){ // 每一期（t=T 是还没开奖的下一期）
    const w=weekday(t),prev=t>=1?ch[t-1][col]:[] // 星期几、上一期的号码
    if(t>=start) for(let n=1;n<=max;n++){ // 进入样本范围后的每个号码
      const r=(t-start)*max+n-1 // 样本序号
      const o=r*F // 这个样本的特征从这里开始
      const all=pre[t*W+n] // 之前一共开出几次
      const gap=last[n]<0?t:t-1-last[n] // 遗漏：已经连续几期没开出
      X[o]=count(t,5,n)/expect(5) // 近 5 期热度（1 为平均）
      X[o+1]=count(t,10,n)/expect(10) // 近 10 期热度
      X[o+2]=count(t,30,n)/expect(30) // 近 30 期热度
      X[o+3]=count(t,100,n)/expect(100) // 近 100 期热度
      X[o+4]=all/expect(t) // 长期频率
      X[o+5]=Math.min(gap*Math.max(all,1)/t,5) // 遗漏 ÷ 平均间隔（最多按 5 算）
      X[o+6]=Math.min(gap,60)/60 // 遗漏期数（最多按 60 算）
      X[o+7]=prev.includes(n)?1:0 // 上一期开出过（重号）
      X[o+8]=t>=2&&ch[t-2][col].includes(n)?1:0 // 上上期开出过
      X[o+9]=(n-1)/(max-1) // 号码本身的大小
      X[o+10]=prev.includes(n-1)||prev.includes(n+1)?1:0 // 上一期开出过它的邻号
      for(let g=0;g<3;g++){let c=0;for(const m of mates[g][n])c+=count(t,30,m);X[o+11+g]=c/(expect(30)*mates[g][n].length)} // 同尾数、同 012 路、同区间号码的近 30 期热度
      X[o+14]=wdDraws[w]?wdCount[w][n]/(wdDraws[w]*k/max):1 // 同一开奖日（星期几）的出现率（1 为平均）
      Y[r]=t<T&&ch[t][col].includes(n)?1:0 // 这一期有没有开出
    }
    if(t<T){for(const n of ch[t][col]){last[n]=t;wdCount[w][n]++};wdDraws[w]++} // 记下最近开出的期、开奖日统计
  }
  const nTrain=train*max // 训练样本数（排在最前面）
  for(let f=0;f<F;f++){ // 每项特征按训练样本标准化：减平均、除标准差，网络更好学
    let mean=0,sq=0 // 平均值、平方和
    for(let i=0;i<nTrain;i++) mean+=X[i*F+f] // 求和
    mean/=nTrain // 平均值
    for(let i=0;i<nTrain;i++) sq+=(X[i*F+f]-mean)**2 // 平方和
    const sd=Math.sqrt(sq/nTrain)||1 // 标准差（全一样时按 1 算）
    for(let i=0;i<rows;i++) X[i*F+f]=(X[i*F+f]-mean)/sd // 标准化全部样本
  }
  return {X,Y,k,max,train,valid,nTrain,predictAt:(T-start)*max} // 样本、号码规则、训练和验证期数、下一期样本的位置
}
async function trainNet(s,onEpoch,sliceMs=12,rand=randomFloat){ // 训练一个小型神经网络：15 个输入 → 16 个神经元（tanh）→ 1 个输出（这个号码这一期开出的概率）；在主线程上每算 sliceMs 毫秒让一下；rand 决定起点和样本顺序
  const F=NN.features,H=NN.hidden // 输入个数、隐藏层神经元个数
  const W2=H*F,B1=W2+H,B2=B1+H,size=B2+1 // 参数排布：[输入→隐藏的权重 | 隐藏→输出的权重 | 隐藏层偏置 | 输出偏置]，共 size 个
  const w=new Float64Array(size),m=new Float64Array(size),v=new Float64Array(size),g=new Float64Array(size) // 参数、Adam 的一阶和二阶动量、梯度
  for(let i=0;i<B1;i++) w[i]=(rand()*2-1)*Math.sqrt(6/(i<W2?F+H:H+1)) // 权重起点（Xavier 初始化），由 rand 决定
  const base=s.k/s.max // 平均开出概率
  w[B2]=Math.log(base/(1-base)) // 输出偏置从平均概率起步
  const X=s.X,h=new Float64Array(H) // 特征、隐藏层输出
  const forward=i=>{ // 前向计算第 i 个样本，返回开出的概率
    let z=w[B2] // 输出层从偏置开始
    for(let j=0;j<H;j++){ // 每个隐藏神经元
      let a=w[B1+j] // 偏置
      for(let f=0;f<F;f++) a+=w[j*F+f]*X[i*F+f] // 加权求和
      h[j]=Math.tanh(a) // 激活
      z+=w[W2+j]*h[j] // 汇总到输出
    }
    return 1/(1+Math.exp(-z)) // sigmoid 转成概率
  }
  const order=Array.from({length:s.nTrain},(_,i)=>i) // 训练样本的顺序
  const BATCH=128,LR=.005 // 每批样本数、学习率
  let step=0,loss=0,slice=performance.now() // Adam 步数、本轮误差、这一段计算的开始时间
  for(let e=1;e<=NN.epochs;e++){ // 每一轮
    for(let i=order.length-1;i>0;i--){ // 打乱样本顺序
      const j=Math.floor(rand()*(i+1)) // 交换的位置（由 rand 决定）
      ;[order[i],order[j]]=[order[j],order[i]] // 交换
    }
    loss=0 // 本轮误差清零
    for(let b=0;b<order.length;b+=BATCH){ // 每一批
      g.fill(0) // 梯度清零
      const end=Math.min(b+BATCH,order.length) // 这一批的结尾
      for(let q=b;q<end;q++){ // 批里的每个样本
        const i=order[q],p=forward(i),y=s.Y[i] // 样本、预测概率、答案
        loss-=Math.log(Math.max(y?p:1-p,1e-12)) // 交叉熵误差
        const dz=p-y // 输出层的误差信号
        g[B2]+=dz // 输出偏置的梯度
        for(let j=0;j<H;j++){ // 反向传播到每个隐藏神经元
          g[W2+j]+=dz*h[j] // 隐藏→输出权重的梯度
          const dh=dz*w[W2+j]*(1-h[j]*h[j]) // 隐藏神经元的误差信号（tanh 的导数）
          g[B1+j]+=dh // 隐藏层偏置的梯度
          for(let f=0;f<F;f++) g[j*F+f]+=dh*X[i*F+f] // 输入→隐藏权重的梯度
        }
      }
      step++ // Adam 步数加一
      const n=end-b,c1=1-.9**step,c2=1-.999**step // 批大小、动量的偏差修正
      for(let p=0;p<size;p++){ // 用 Adam 更新每个参数
        const gr=g[p]/n // 平均梯度
        m[p]=.9*m[p]+.1*gr // 一阶动量
        v[p]=.999*v[p]+.001*gr*gr // 二阶动量
        w[p]-=LR*(m[p]/c1)/(Math.sqrt(v[p]/c2)+1e-8) // 更新
      }
      if(performance.now()-slice>sliceMs){ // 连续算了 sliceMs 毫秒
        await new Promise(r=>setTimeout(r)) // 让一下，液体动画和页面不卡
        slice=performance.now() // 重新计时
      }
    }
    loss/=order.length // 本轮平均误差
    await onEpoch(e,loss) // 报告进度
    slice=performance.now() // 重新计时
  }
  return {forward,loss} // 网络（前向计算）和最后一轮的误差
}
function nnWindow(net,s){ // 神经网络专家：回测期和下一期每个号码的概率（每期归一化到开出个数）
  const rows=s.valid+1,M=s.max,P=new Float64Array(rows*M) // 期数、号码数、结果
  for(let r=0;r<rows;r++){ // 每一期
    let sum=0;for(let n=0;n<M;n++){P[r*M+n]=net.forward(s.nTrain+r*M+n);sum+=P[r*M+n]} // 网络给的概率
    for(let n=0;n<M;n++)P[r*M+n]=Math.min(.999,Math.max(1e-4,P[r*M+n]*s.k/sum)) // 归一化
  }
  return P // 结果
}
// ===== 十一位统计专家 =====
function deepExperts(ch,col,k,M,zones,nextDate){ // 逐期往前走，每期只用它之前的数据，给调参期、回测期和下一期（t=T）的每个号码估概率；有参数的专家按调参期的损失挑参数
  const T=ch.length,start=T-DEEP.window,from=Math.max(2,start-DEEP.tune),rows=T-from+1,u=k/M,W=M+1,B=41 // 总期数、回测起点、调参起点、要估的期数、平均概率、每期一行、遗漏分组（0～40+）
  const day=ch.map(d=>d[1]).concat([nextDate]).map(s=>new Date(s+"T00:00:00Z")) // 每期（含下一期）的开奖日期
  const wd=day.map(d=>d.getUTCDay()),yr=day.map(d=>d.getUTCFullYear()),doy=day.map(d=>Math.round((d-Date.UTC(d.getUTCFullYear(),0,1))/864e5)) // 星期几、年份、一年里的第几天
  const pre=new Int32Array((T+1)*W) // 前缀和：pre[t*W+n] 是前 t 期里号码 n 开出的次数
  for(let t=0;t<T;t++){for(let n=1;n<=M;n++)pre[(t+1)*W+n]=pre[t*W+n];for(const n of ch[t][col])pre[(t+1)*W+n]++} // 逐期累计
  const count=(t,w,n)=>pre[t*W+n]-pre[Math.max(0,t-w)*W+n] // 第 t 期之前 w 期里号码 n 开出的次数
  const norm=raw=>{let sum=0;for(let n=1;n<=M;n++)sum+=raw[n];const p=new Float64Array(W);for(let n=1;n<=M;n++)p[n]=Math.min(.999,Math.max(1e-4,raw[n]*k/sum));return p} // 归一化：各号概率之和等于每期开出个数
  const last=new Int32Array(W).fill(-1) // 每个号码上次开出的期
  const bucket=(t,n)=>Math.min(B-1,last[n]<0?B-1:t-1-last[n]) // 第 t 期时号码 n 的遗漏期数（40 以上归一组）
  const list=[],learners=[] // 专家（每位有一个或几个参数版本）、每期开奖后更新统计的函数
  const add=(key,name,raws)=>list.push({key,name,variants:raws.map(raw=>({raw,P:new Float64Array(rows*M),loss:0}))}) // 加一位专家：raws 是各参数版本的打分函数
  const each=f=>{const r=new Float64Array(W);for(let n=1;n<=M;n++)r[n]=f(n);return r} // 给每个号码打分
  // 频率专家：按时间衰减的出现次数，半衰期 8～256 期
  const HL=[8,16,32,64,128,256],S=HL.map(()=>new Float64Array(W)) // 候选半衰期、各自的衰减计数
  add("freq","频率专家",HL.map((h,i)=>()=>each(n=>S[i][n]+.5))) // 衰减计数（加一点平滑）
  learners.push(y=>HL.forEach((h,i)=>{const d=.5**(1/h);for(let n=1;n<=M;n++)S[i][n]=S[i][n]*d+y[n]})) // 更新
  // 遗漏专家：历史上遗漏同样期数的号码，下一期开出的比例（所有号码一起统计）
  const trials=new Float64Array(B),hits=new Float64Array(B) // 各遗漏期数的次数、开出数
  const hazard=b=>(hits[b]+20*u)/(trials[b]+20) // 开出率（向平均值平滑）
  add("gap","遗漏专家",[t=>each(n=>hazard(bucket(t,n)))]) // 打分
  // 周期专家：每个号码自己的出号间隔规律（样本少时向遗漏专家的整体规律收缩）
  const tn=new Float64Array(W*B),hn=new Float64Array(W*B) // 每个号码各遗漏期数的次数、开出数
  add("cycle","周期专家",[10,40,160].map(c=>t=>each(n=>{const b=bucket(t,n);return (hn[n*B+b]+c*hazard(b))/(tn[n*B+b]+c)}))) // 收缩强度 10～160
  learners.push((y,t)=>{for(let n=1;n<=M;n++){const b=bucket(t,n);trials[b]++;hits[b]+=y[n];tn[n*B+b]++;hn[n*B+b]+=y[n]}}) // 更新遗漏和周期的统计
  // 回补专家：近 w 期出现次数低于期望的号码加分（偏差按标准差算），w 和力度由调参决定
  add("revert","回补专家",[30,100,300,1000].flatMap(w=>[.1,.3].map(g=>t=>{const span=Math.min(w,t),E=span*u,sd=Math.sqrt(E*(1-u))||1;return each(n=>Math.exp(-g*(count(t,w,n)-E)/sd))})))
  // 转移专家：上期开出 m 之后，下一期开出 n 的比例，按上期每个号码取平均
  const C=Array.from({length:W},()=>new Float64Array(W)),occ=new Float64Array(W) // 上期开出 m、下期开出 n 的次数；m 开出的次数
  add("markov","转移专家",[t=>{const prev=ch[t-1][col];return each(n=>{let s=0;for(const m of prev)s+=(C[m][n]+20*u)/(occ[m]+20);return s/prev.length})}]) // 打分
  learners.push((y,t)=>{if(t>=1)for(const m of ch[t-1][col]){occ[m]++;for(let n=1;n<=M;n++)C[m][n]+=y[n]}}) // 更新
  // 邻号专家：号码和上期的关系（重号、邻号 ±1、隔号 ±2、其他）× 上上期是否开出，共 8 类，各类的历史开出率
  const relOf=(t,n)=>{const p=ch[t-1][col],q=t>=2?ch[t-2][col]:[];const r=p.includes(n)?0:p.includes(n-1)||p.includes(n+1)?1:p.includes(n-2)||p.includes(n+2)?2:3;return r*2+(q.includes(n)?1:0)} // 第 t 期号码 n 属于哪一类
  const relTrials=new Float64Array(8),relHits=new Float64Array(8) // 各类的次数、开出数
  add("neighbor","邻号专家",[t=>each(n=>{const c=relOf(t,n);return (relHits[c]+20*u)/(relTrials[c]+20)})]) // 打分
  learners.push((y,t)=>{if(t>=1)for(let n=1;n<=M;n++){const c=relOf(t,n);relTrials[c]++;relHits[c]+=y[n]}}) // 更新
  // 尾数、012 路、区间专家：同一组号码的衰减热度（每个号码按所在组的平均算），半衰期 16～256 期
  const groupExpert=(key,name,g)=>{ // 按分组 g 建一位专家
    const ids=Array.from({length:W},(_,n)=>n?g(n):0),G=Math.max(...ids)+1,size=new Float64Array(G) // 每个号码的组、组数、每组几个号码
    for(let n=1;n<=M;n++) size[ids[n]]++ // 数每组的号码
    const HG=[16,64,256],SG=HG.map(()=>new Float64Array(G)) // 候选半衰期、各组的衰减计数
    add(key,name,HG.map((h,i)=>()=>each(n=>SG[i][ids[n]]/size[ids[n]]+.5))) // 打分
    learners.push(y=>HG.forEach((h,i)=>{const d=.5**(1/h),s=SG[i];for(let j=0;j<G;j++)s[j]*=d;for(let n=1;n<=M;n++)s[ids[n]]+=y[n]})) // 更新
  }
  groupExpert("tail","尾数专家",n=>n%10) // 尾数 0～9
  groupExpert("road","012 路专家",n=>n%3) // 除以 3 的余数
  groupExpert("zone","区间专家",n=>zoneOf(zones,n)) // 所在区间
  // 星期专家：同一开奖日（星期几）的历史开出率，半衰期 64、256 期或不衰减
  const HW=[64,256,Infinity],CW=HW.map(()=>Array.from({length:7},()=>new Float64Array(W))),NW=HW.map(()=>new Float64Array(7)) // 候选半衰期、各开奖日的号码计数和期数
  add("weekday","星期专家",HW.map((h,i)=>t=>{const c=CW[i][wd[t]],N=NW[i][wd[t]];return each(n=>(c[n]+20*u)/(N+20))})) // 打分
  learners.push((y,t)=>HW.forEach((h,i)=>{const d=h===Infinity?1:.5**(1/h),c=CW[i][wd[t]];for(let n=1;n<=M;n++)c[n]=c[n]*d+y[n];NW[i][wd[t]]=NW[i][wd[t]]*d+1})) // 更新这一期所在开奖日的统计
  // 同期专家：往年同一时段（前后 7、15、30 天）的开出率
  add("season","同期专家",[7,15,30].map(D=>t=>{ // 每个候选时段
    const c=new Float64Array(W);let N=0 // 号码计数、期数
    for(let s=0;s<t;s++){if(yr[s]>=yr[t])continue;let d=Math.abs(doy[s]-doy[t]);d=Math.min(d,365-d);if(d>D)continue;N++;for(const n of ch[s][col])c[n]++} // 往年同一时段的开奖
    return each(n=>(c[n]+20*u)/(N+20)) // 开出率（向平均值平滑）
  }))
  for(let t=0;t<=T;t++){ // 每一期
    const y=new Uint8Array(W) // 这期开出的号码
    if(t<T) for(const n of ch[t][col]) y[n]=1 // t=T 是还没开奖的下一期
    if(t>=from){ // 从调参期开始估
      const r=t-from // 第几行
      for(const e of list) for(const v of e.variants){ // 每位专家的每个参数版本
        const p=norm(v.raw(t)) // 概率
        for(let n=1;n<=M;n++) v.P[r*M+n-1]=p[n] // 记下
        if(t<start) for(let n=1;n<=M;n++) v.loss-=Math.log(y[n]?p[n]:1-p[n]) // 调参期：累计损失
      }
    }
    if(t===T) break // 下一期还没开奖，到此为止
    for(const f of learners) f(y,t) // 用这期结果更新统计
    for(const n of ch[t][col]) last[n]=t // 记下开出的期（最后更新，遗漏分组要用开奖前的值）
  }
  const off=(start-from)*M // 回测期从第几个数开始
  return {start,experts:list.map(e=>{const v=e.variants.reduce((x,y)=>y.loss<x.loss?y:x);return {key:e.key,name:e.name,P:v.P.slice(off)}})} // 每位专家取调参期损失最小的版本，只留回测期和下一期
}
async function deepPool(draws,col,k,M,zones,nextDate,onEpoch,sliceMs){ // 一种球（红球或蓝球）的完整分析：专家打分、回测、配对检验、贝叶斯加权
  const ch=draws.slice().reverse(),u=k/M,R=DEEP.window // 按时间从早到晚、平均概率、回测期数
  const E=deepExperts(ch,col,k,M,zones,nextDate) // 十一位统计专家
  const s=nnSamples(draws,col,k,M,zones,nextDate) // 神经网络的样本（最近 200 期留作回测）
  const net=await trainNet(s,onEpoch,sliceMs,seededRandom(`${draws[0][0]}|${draws.length}|${col}|${k}|${M}`)) // 训练：起点由最新期号等固定下来，同样的数据每次训练出同样的网络
  const models=[{key:"uniform",name:"均衡基准",P:null},...E.experts,{key:"nn",name:"神经网络",P:nnWindow(net,s)}] // 参与评比的模型
  const prob=(m,r,n)=>m.P?m.P[r*M+n-1]:u // 模型 m 给第 start+r 期号码 n 的概率
  for(const m of models){ // 回测每个模型
    let hit=0;m.rows=new Float64Array(R) // 命中、每期的对数损失
    for(let r=0;r<R;r++){ // 回测期的每一期
      const y=new Set(ch[E.start+r][col]),order=[] // 真实开出的号码
      for(let n=1;n<=M;n++){const p=prob(m,r,n);m.rows[r]-=Math.log(y.has(n)?p:1-p);order.push([n,p])} // 这一期的损失
      order.sort((a,b)=>b[1]-a[1]||a[0]-b[0]);for(let q=0;q<k;q++)if(y.has(order[q][0]))hit++ // 前 k 名里开出了几个
    }
    m.loss=m.rows.reduce((a,b)=>a+b,0);m.hits=m.P?hit/R:k*k/M // 总损失；均衡基准（每个号码机会均等）的命中按期望值算
    m.next=Array.from({length:M+1},(_,n)=>n?prob(m,R,n):0) // 对下一期的看法
    m.top=m.P?m.next.map((p,n)=>[n,p]).slice(1).sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,3).map(([n])=>n):[] // 最看好的 3 个号码
    delete m.P // 不再需要
  }
  const base=models[0],experts=models.slice(1) // 均衡基准、各位专家
  for(const m of models) m.gain=base.loss-m.loss // 比均衡基准少了多少损失（>0 表示更好）
  const best=experts.reduce((x,y)=>y.gain>x.gain?y:x) // 回测最好的专家
  const d=Array.from(base.rows,(b,r)=>b-best.rows[r]),mean=d.reduce((a,b)=>a+b,0)/R,sd=Math.sqrt(d.reduce((a,b)=>a+(b-mean)**2,0)/(R-1))||1e-12 // 逐期损失差：平均值、标准差
  const z=mean/(sd/Math.sqrt(R)),one=z>0?normP(z)/2:1-normP(z)/2 // 配对检验（单侧：最好的专家真的比均衡基准好吗）
  const test={key:best.key,name:best.name,rel:best.gain/base.loss,p:Math.min(1,one*experts.length)} // 12 位里挑最好的，p 值乘 12（Bonferroni 校正）
  const minLoss=Math.min(...models.map(m=>m.loss)) // 最小损失
  // 贝叶斯模型平均：权重 ∝ 回测似然（各模型先验相同）。200 期的成绩偶然性很大，按缓和系数 5 降温（power posterior），差距很小时权重不拉得太开
  let zsum=0;for(const m of models){m.w=Math.exp(-(m.loss-minLoss)/DEEP.temper);zsum+=m.w} // 未归一化的权重
  for(const m of models){m.weight=m.w/zsum;delete m.w;delete m.rows} // 归一化
  const mix=Array.from({length:M+1},(_,n)=>n?models.reduce((sum,m)=>sum+m.weight*m.next[n],0):0) // 混合后的下一期概率
  return {models,mix,test,nnLoss:net.loss} // 结果
}
let deepWorkerUrl=null // 后台线程的脚本地址（只生成一次）
function deepWorkerURL(){ // 把分析用到的函数拼成后台线程（Web Worker）的脚本：计算在后台跑，液体动画和思考过程的显示都不卡
  if(!deepWorkerUrl) deepWorkerUrl=URL.createObjectURL(new Blob([[ // 生成脚本地址
    `const NN=${JSON.stringify(NN)}`,`const DEEP=${JSON.stringify(DEEP)}`, // 设置
    "const randomWord=new Uint32Array(1)", // 随机数缓冲区
    randomIntUnbiased,randomFloat,seededRandom,lnGamma,gammaQ,normP,zoneOf,nnTrainSpan,nnSamples,trainNet,nnWindow,deepExperts,deepPool, // 直接用页面里同一份函数代码
    `onmessage=async event=>{
  const {draws,col,k,max,zones,nextDate}=event.data
  const result=await deepPool(draws,col,k,max,zones,nextDate,(epoch,loss)=>{postMessage({epoch,loss})},1e9)
  postMessage({done:true,result})
}`, // 收到开奖数据就分析；每训练完一轮报告进度
  ].join("\n")],{type:"text/javascript"})) // 脚本类型
  return deepWorkerUrl // 返回地址
}
function runDeepPool(draws,col,k,max,zones,nextDate,onEpoch){ // 分析一种球：优先放到后台线程，不支持时在主线程上分段算
  const onMainThread=()=>deepPool(draws,col,k,max,zones,nextDate,onEpoch,12) // 在主线程上算（每 12 毫秒让一下）
  let worker // 后台线程
  try{ worker=new Worker(deepWorkerURL()) }catch(error){ return onMainThread() } // 创建不了就在主线程上算
  return new Promise((resolve,reject)=>{ // 等后台线程算完
    worker.onmessage=event=>{ // 收到后台线程的消息
      const d=event.data // 消息内容
      if(d.done){ worker.terminate(); resolve(d.result); return } // 算完：关掉线程，返回结果
      onEpoch(d.epoch,d.loss) // 训练进度
    }
    worker.onerror=event=>{ // 后台线程出错（例如浏览器不允许）
      event.preventDefault() // 不在控制台报错
      worker.terminate() // 关掉线程
      onMainThread().then(resolve,reject) // 改在主线程上算
    }
    worker.postMessage({draws,col,k,max,zones,nextDate}) // 把开奖数据交给后台线程
  })
}
// ===== 走势图 =====
const PRIMES=new Set([1,2,3,5,7,11,13,17,19,23,29,31]) // 质合走势图的习惯：1 也算质数
const CHARTS=[["sum","和值"],["span","跨度"],["ac","AC 值"],["odd","奇偶"],["big","大小"],["prime","质合"],["zoneMax","区间"],["road0","012 路"],["tails","尾数"],["longest","连号"],["repeat","重号"],["blue","蓝球"]] // 12 张走势图：指标、名字（数值型指标用来做自相关检验）
const RANGE_KEYS=["sum","span"],SET_KEYS=["ac","odd","big","prime","zoneMax","road","tails","longest","repeat"] // 筛选组合用的指标：取值多的按百分位区间，取值少的按最常见的几个
function shapeOf(reds,rule,prev){ // 一注红球在各张走势图上的指标（prev 是上一期的红球，算重号用）
  const half=rule.red[1]/2,k=reds.length // 大小分界：大于一半的算大号；红球个数
  let run=1,longest=1 // 当前连号长度、最长连号长度
  for(let i=1;i<k;i++){run=reds[i]===reds[i-1]+1?run+1:1;longest=Math.max(longest,run)} // 逐个比较相邻号码
  const diffs=new Set();for(let i=0;i<k;i++)for(let j=i+1;j<k;j++)diffs.add(reds[j]-reds[i]) // 两两之差
  const zones=rule.zones.map(([lo,hi])=>reds.filter(n=>n>=lo&&n<=hi).length) // 每区几个号
  const roads=[0,1,2].map(r=>reds.filter(n=>n%3===r).length) // 0、1、2 路各几个号
  return { // 返回
    sum:reds.reduce((a,b)=>a+b,0), // 和值
    span:reds[k-1]-reds[0], // 跨度：最大减最小
    ac:diffs.size-(k-1), // AC 值：不同差值的个数减（个数-1），越大号码越分散
    odd:reds.filter(n=>n%2).length, // 奇数个数
    big:reds.filter(n=>n>half).length, // 大号个数
    prime:reds.filter(n=>PRIMES.has(n)).length, // 质数个数
    zoneMax:Math.max(...zones), // 号码最多的那个区有几个
    zones:zones.join(":"), // 区间比
    road:roads.join(":"), // 012 路比
    road0:roads[0], // 0 路个数
    tails:new Set(reds.map(n=>n%10)).size, // 有几种尾数
    longest, // 最长连号
    repeat:prev?reds.filter(n=>prev.includes(n)).length:0, // 和上一期相同的号码（重号）个数
  }
}
function ljungBox(x,h){ // Ljung-Box 检验：前 h 期的自相关是否都为零（走势会不会延续），返回 p 值
  const n=x.length,mean=x.reduce((a,b)=>a+b,0)/n,c=x.map(v=>v-mean),c0=c.reduce((a,v)=>a+v*v,0) // 期数、平均值、去中心、方差和
  if(!c0) return 1 // 全一样，没有走势
  let q=0;for(let lag=1;lag<=h;lag++){let s=0;for(let t=lag;t<n;t++)s+=c[t]*c[t-lag];q+=(s/c0)**2/(n-lag)} // 各期自相关的平方
  return chiP(n*(n+2)*q,h) // Q 统计量服从自由度 h 的卡方分布
}
function commonSet(values,cover){ // 最常见的取值，合计占到 cover 为止
  const counts=new Map() // 每个取值出现的次数
  values.forEach(v=>counts.set(v,(counts.get(v)||0)+1)) // 计数
  const order=[...counts.keys()].sort((a,b)=>counts.get(b)-counts.get(a)||(a<b?-1:1)) // 按次数从多到少（一样时按取值，顺序固定）
  const keep=new Set() // 保留的取值
  let covered=0 // 已覆盖的期数
  for(const v of order){keep.add(v);covered+=counts.get(v);if(covered>=values.length*cover)break} // 从最常见的开始，够了就停
  return keep // 返回
}
function limitsOf(shapes,cover){ // 每张走势图的常见范围：和值、跨度取中间 cover 的区间，其余取最常见的几个值
  const lim={} // 结果
  RANGE_KEYS.forEach(key=>{const v=shapes.map(s=>s[key]).sort((a,b)=>a-b),q=(1-cover)/2;lim[key]=[v[Math.floor((v.length-1)*q)],v[Math.ceil((v.length-1)*(1-q))]]}) // 百分位区间
  SET_KEYS.forEach(key=>{lim[key]=commonSet(shapes.map(s=>s[key]),cover)}) // 常见取值
  return lim // 返回
}
function fits(x,lim){ // 这注红球的形态在不在全部走势图的常见范围里
  return RANGE_KEYS.every(k=>x[k]>=lim[k][0]&&x[k]<=lim[k][1])&&SET_KEYS.every(k=>lim[k].has(x[k])) // 每张图都要在范围内
}
// ===== 开奖日期 =====
function dateTests(ch,col,k,M){ // 一种球的 4 项卡方检验：按星期、月份、年份分组号码分布有没有差别，全部开奖是否均匀；返回各项 p 值
  const fix=(M-1)/(M-k) // 每期不放回抽 k 个：号码之间负相关，皮尔逊统计量要乘这个系数才服从卡方分布
  const grouped=keyOf=>{ // 按 keyOf(开奖日期) 分组，做齐性检验
    const groups=new Map() // 组 → {期数, 各号码次数}
    for(const d of ch){const g=keyOf(d[1]);if(!groups.has(g))groups.set(g,{n:0,c:new Float64Array(M+1)});const x=groups.get(g);x.n++;for(const n of d[col])x.c[n]++} // 计数
    const kept=[...groups.values()].filter(x=>x.n*k/M>=5) // 每格期望次数至少 5 的组才参加（例如个别改期的开奖日不算）
    if(kept.length<2) return 1 // 只有一组，无从比较
    const N=kept.reduce((a,x)=>a+x.n,0),tot=new Float64Array(M+1);kept.forEach(x=>{for(let n=1;n<=M;n++)tot[n]+=x.c[n]}) // 总期数、各号码总次数
    let stat=0;kept.forEach(x=>{for(let n=1;n<=M;n++){const e=x.n*tot[n]/N;if(e>0)stat+=(x.c[n]-e)**2/e}}) // 皮尔逊卡方统计量
    return chiP(stat*fix,(M-1)*(kept.length-1)) // p 值
  }
  const all=new Float64Array(M+1);for(const d of ch)for(const n of d[col])all[n]++ // 全部开奖里各号码的次数
  const E=ch.length*k/M;let stat=0;for(let n=1;n<=M;n++)stat+=(all[n]-E)**2/E // 和均匀分布比
  return { // 结果
    weekday:grouped(s=>new Date(s+"T00:00:00Z").getUTCDay()), // 星期
    month:grouped(s=>s.slice(5,7)), // 月份
    year:grouped(s=>s.slice(0,4)), // 年份
    uniform:chiP(stat*fix,M-1), // 整体均匀
  }
}
function nextDrawDate(latest,days){ // 下一期的开奖日期：从最新一期往后找第一个开奖日（节假日停售时会顺延，所以只是预计）
  const d=new Date(latest+"T00:00:00Z") // 最新一期
  do d.setUTCDate(d.getUTCDate()+1);while(!days.includes(d.getUTCDay())) // 往后一天一天找
  return d.toISOString().slice(0,10) // 年-月-日
}
function analyze(type,data){ // 研究全部开奖：走势图（常见范围和自相关检验）、开奖日期（卡方检验）、下一期日期、历史头奖
  const rule=DEEP_RULES[type],[kr,Mr]=rule.red,[kb,Mb]=rule.blue // 规则
  const draws=data.draws,ch=draws.slice().reverse() // 全部开奖（新的在前）、按时间从早到晚
  const shapes=ch.slice(1).map((d,i)=>({...shapeOf(d[2],rule,ch[i][2]),blue:d[3].reduce((a,b)=>a+b,0)})) // 每期（从第 2 期起，重号要和上一期比）在各张走势图上的指标
  const charts=CHARTS.map(([key,name])=>({key,name,p:ljungBox(shapes.map(s=>s[key]),DEEP.lags)})) // 每张走势图的自相关检验
  let cover=.85,limits=null,joint=0 // 每张图的覆盖率、常见范围、合起来覆盖的比例
  for(cover of [.85,.875,.9,.92,.94,.95,.96,.97,.975,.98,.985,.99,.995,1]){ // 从 85% 往上调，直到合起来覆盖历史上 80% 的开奖
    limits=limitsOf(shapes,cover) // 各图的常见范围
    joint=shapes.filter(s=>fits(s,limits)).length/shapes.length // 合起来覆盖多少
    if(joint>=DEEP.cover) break // 够了
  }
  const mode=key=>{const c=new Map();shapes.forEach(s=>c.set(s[key],(c.get(s[key])||0)+1));return [...c.keys()].sort((a,b)=>c.get(b)-c.get(a)||(a<b?-1:1))[0]} // 最常见的取值
  const avg=v=>v.reduce((a,b)=>a+b,0)/v.length // 平均值
  return { // 返回
    rule,draws,shapes,charts,limits,joint, // 规则、开奖、各期指标、自相关检验、常见范围、合起来的覆盖率
    sumAll:avg(shapes.map(s=>s.sum)),sumRecent:avg(shapes.slice(-DEEP.recent).map(s=>s.sum)), // 和值：全部平均、近 30 期平均
    yearSums:(()=>{const by=new Map();ch.slice(1).forEach((d,i)=>{const y=d[1].slice(0,4);if(!by.has(y))by.set(y,[]);by.get(y).push(shapes[i].sum)});const v=[...by.values()].filter(x=>x.length>=50).map(avg);return [Math.min(...v),Math.max(...v)]})(), // 各年（至少 50 期）和值平均的最小、最大值：看整体水平有没有随年份漂移
    oddMode:mode("odd"),bigMode:mode("big"),zoneMode:mode("zones"), // 最常见的奇数个数、大号个数、区间比
    dates:{red:dateTests(ch,2,kr,Mr),blue:dateTests(ch,3,kb,Mb)}, // 开奖日期的卡方检验
    nextDate:nextDrawDate(draws[0][1],rule.drawDays), // 下一期预计的开奖日期
    jackpots:new Set(draws.map(d=>d[2].join(",")+"|"+d[3].join(","))), // 开出过的头奖组合
  }
}
// ===== 选号和自我检查 =====
function deepPick(a,red,blue){ // 选号（不用随机数）：从最被看好的红球里枚举全部组合，去掉走势图上少见的形态，取得分最高的一注
  const R=a.rule,[kr,Mr]=R.red,[kb,Mb]=R.blue,latest=a.draws[0][2] // 规则、最新一期的红球（算重号用）
  const byArray=(x,y)=>{for(let i=0;i<x.length;i++) if(x[i]!==y[i]) return x[i]-y[i];return 0} // 两组号码按数字逐个比较（得分一样时用，保证顺序固定）
  const rank=(mix,M)=>Array.from({length:M},(_,i)=>i+1).sort((x,y)=>mix[y]-mix[x]||x-y) // 号码按被看好程度从高到低（一样时号码小的在前）
  const combos=(nums,size,score)=>{ // 列出 nums 里取 size 个的全部组合，算好得分，按得分从高到低排好
    const out=[],cur=[] // 结果、当前组合
    const walk=start=>{ // 逐个往组合里加号码
      if(cur.length===size){out.push({nums:cur.slice(),score:cur.reduce((sum,n)=>sum+score(n),0)});return} // 凑够了
      for(let i=start;i<=nums.length-(size-cur.length);i++){cur.push(nums[i]);walk(i+1);cur.pop()} // 依次尝试
    }
    walk(0) // 开始
    return out.sort((x,y)=>y.score-x.score||byArray(x.nums,y.nums)) // 得分从高到低
  }
  const top=rank(red.mix,Mr).slice(0,DEEP.pool).sort((x,y)=>x-y) // 最被看好的 20 个红球
  const all=combos(top,kr,n=>Math.log(red.mix[n]*Mr/kr)) // 它们的全部组合（得分：各号概率相对平均值的对数之和）
  const list=all.filter(c=>fits(shapeOf(c.nums,R,latest),a.limits)) // 去掉走势图上少见的形态
  const best=list[0]||all[0] // 得分最高的一注（万一全被去掉，就不筛）
  const blueSets=combos(Array.from({length:Mb},(_,i)=>i+1),kb,n=>Math.log(blue.mix[n]*Mb/kb)) // 蓝球的全部组合，按得分从高到低
  const b=blueSets.find(b=>!a.jackpots.has(best.nums.join(",")+"|"+b.nums.join(",")))||blueSets[0] // 得分最高、又不和这注红球凑成历史头奖的
  return {ticket:{red:best.nums,blue:b.nums},pool:top.length,total:all.length,valid:list.length} // 结果和过程数据
}
function deepCheck(a,ticket){ // 自我检查：逐项核对这一注
  const R=a.rule,x=shapeOf(ticket.red,R,a.draws[0][2]) // 规则、这注红球的走势图指标
  const okNums=(v,[n,max])=>v.length===n&&v.every((y,i)=>y>=1&&y<=max&&(!i||y>v[i-1])) // 个数、范围、从小到大不重复
  const rules=okNums(ticket.red,R.red)&&okNums(ticket.blue,R.blue) // 号码规则
  const shapes=fits(x,a.limits) // 走势图形态
  const jackpot=a.jackpots.has(ticket.red.join(",")+"|"+ticket.blue.join(",")) // 历史头奖
  return {x,rules,shapes,jackpot,ok:rules&&shapes&&!jackpot} // 结果
}
function pad2(n){ // 号码补零成两位
  return String(n).padStart(2,"0") // 例如 7 → 07
}
async function generateDeep(){ // 深度思考：思考过程在下面的结果卡片里一段段“写”出来，想完在中间的卡片里给出精确计算的一注
  if(isRolling) return // 正在生成就忽略
  const type=getType(),rule=DEEP_RULES[type] // 开始时的彩种和规则
  isRolling=true // 标记为生成中
  showPickGhosts(true) // 一注的位置：空球呼吸，表示正在算
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
  const write=(label,text,cls="")=>new Promise(resolve=>{ // 写一段：开头是加粗的小标题，正文一个字一个字出现（每秒约 120 个字）
    const p=document.createElement("p") // 一段
    p.className=`deep-p ${cls}` // 样式
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
  const pct=x=>`${Math.round(x*100)}%` // 百分比
  const pv=p=>p<.001?"<0.001":p<.01?p.toFixed(3):p.toFixed(2) // p 值的写法
  const pt=p=>{const v=pv(p);return v[0]==="<"?`p${v}`:`p=${v}`} // 带“p=”的写法（很小时写 p<0.001）
  const ratio=(x,k)=>`${x}:${k-x}` // 比例的写法，例如 3:3
  try{ // 尝试
    const data=await loadHistory(type) // 读取开奖历史
    const a=analyze(type,data),draws=a.draws,latest=draws[0] // 走势图和开奖日期的分析、全部开奖（新的在前）、最新一期
    const [kr,Mr]=rule.red,[kb,Mb]=rule.blue // 红球、蓝球的个数和范围
    const half=M=>[[1,Math.floor(M/2)],[Math.floor(M/2)+1,M]] // 蓝球分成前后两区
    let epoch=0,epochLoss=0,liveLine=null // 神经网络的训练进度、显示进度的那一段
    const showEpoch=()=>{if(liveLine) liveLine.textContent=`正在学习近 ${(nnTrainSpan(draws.length)+NN.valid).toLocaleString()} 期 ${"■".repeat(epoch)}${"□".repeat(NN.epochs-epoch)} 误差 ${epoch?epochLoss.toFixed(4):"…"}`} // 更新进度
    const redJob=runDeepPool(draws,2,kr,Mr,rule.zones,a.nextDate,(e,loss)=>{epoch=e;epochLoss=loss;showEpoch()}) // 红球分析（后台线程，和下面写字同时进行）
    const blueJob=runDeepPool(draws,3,kb,Mb,half(Mb),a.nextDate,()=>{}) // 蓝球分析
    const next=new Date(a.nextDate+"T00:00:00Z") // 下一期预计的开奖日期
    await write("思路",`为${rule.name}精确计算 1 注。先研究全部开奖的走势图和开奖日期，再请十二位专家各从一个角度给号码打分，用最近 ${DEEP.window} 期考试决定多听谁的，最后从上万种组合里算出得分最高的一注并自我检查。结论只由开奖数据决定：数据不变，结论就不变，开出新一期才会更新。`)
    await write("数据",`共 ${draws.length.toLocaleString()} 期（${draws[draws.length-1][1]} 至 ${latest[1]}），最新第 ${latest[0]} 期：红 ${nums(latest[2])}，蓝 ${nums(latest[3])}。下一期预计 ${next.getUTCMonth()+1} 月 ${next.getUTCDate()} 日（${WEEKDAYS[next.getUTCDay()]}）开奖。`)
    const alpha=.05/CHARTS.length,trend=a.charts.filter(c=>c.p<alpha),minChart=a.charts.reduce((x,y)=>y.p<x.p?y:x) // 12 张图同时检验的显著水平、有显著自相关的图、p 值最小的图
    await write("第一步｜研究走势图",`把全部开奖逐期画成 ${CHARTS.length} 张走势图：${CHARTS.map(c=>c[1]).join("、")}。和值历史平均 ${Math.round(a.sumAll)}、近 ${DEEP.recent} 期 ${Math.round(a.sumRecent)}，最常见的是奇偶 ${ratio(a.oddMode,kr)}、大小 ${ratio(a.bigMode,kr)}、区间 ${a.zoneMode}。走势会不会延续？每张图都检验前 ${DEEP.lags} 期的自相关（Ljung-Box）：${trend.length?`${trend.map(c=>`${c.name}（${pt(c.p)}）`).join("、")}有显著自相关，其余都没有；${a.dates.red.year<.05/8?`再看各年和值平均在 ${Math.round(a.yearSums[0])}～${Math.round(a.yearSums[1])} 之间，是整体水平随年份漂移，不是能追的短期走势。`:"这么多张图里出现一两张，也可能只是巧合，交给专家在回测里验证。"}`:`最小的是${minChart.name} ${pt(minChart.p)}，按 ${CHARTS.length} 张图同时检验校正后都不显著，近期偏高偏低不代表接下来会怎样。`}所以不追近期走势，只用全部历史定出每张图的常见范围，合起来覆盖历史上 ${pct(a.joint)} 的开奖，用来筛选组合。`)
    const dr=a.dates.red,db=a.dates.blue,tests=[["红球星期",dr.weekday],["红球月份",dr.month],["红球年份",dr.year],["红球整体均匀",dr.uniform],["蓝球星期",db.weekday],["蓝球月份",db.month],["蓝球年份",db.year],["蓝球整体均匀",db.uniform]],dateSig=tests.filter(([,p])=>p<.05/tests.length),drift=dateSig.some(([name])=>name.endsWith("年份")) // 8 项检验、校正后显著的项、是不是随年份变化
    await write("第二步｜分析开奖日期",`按开奖日期把 ${draws.length.toLocaleString()} 期分组：星期（${rule.drawDays.map(d=>WEEKDAYS[d]).join("、")}）、月份、年份，检验号码分布有没有差别，再检验全部开奖是否均匀。卡方检验（已按每期不放回抽取校正）的 p 值依次是：红球 ${pv(dr.weekday)}、${pv(dr.month)}、${pv(dr.year)}、${pv(dr.uniform)}，蓝球 ${pv(db.weekday)}、${pv(db.month)}、${pv(db.year)}、${pv(db.uniform)}。${dateSig.length?`按 8 项同时检验校正后，${dateSig.map(([name])=>name).join("、")}显著${drift?"：号码分布在不同年份不一样，早年的特点不一定适用于现在，交给按时间衰减的专家在回测里验证。":"，交给专家们在回测里验证。"}`:"按 8 项同时检验校正后都不显著：号码和开奖日期无关，每个号码出现的机会一样。"}`)
    await write("第三步｜专家打分",`十二位专家各管一个角度：频率（越近越重要）、遗漏（多久没出）、周期（每个号码自己的出号间隔）、回补（长期少出的号）、转移（上期号码之后常跟着出谁）、邻号（上期的重号、邻号、隔号）、尾数、012 路、区间（同组号码的热度）、星期（同一开奖日）、同期（往年同一时段），还有神经网络从 ${NN.features} 项特征里自己学。有参数的专家先用回测前的 ${DEEP.tune} 期挑出最准的参数。`)
    liveLine=await write("神经网络","","live") // 训练进度这一段
    showEpoch() // 先显示当前进度
    const red=await redJob // 等红球分析完成
    liveLine.textContent=`学完了（${NN.epochs} 轮，误差 ${red.nnLoss.toFixed(4)}；训练起点由第 ${latest[0]} 期固定，结果可以复现）。` // 完成
    liveLine.parentNode.classList.remove("live") // 不再是进度
    const experts=red.models.filter(m=>m.key!=="uniform") // 十二位专家
    const short=m=>m.name.replace("专家","") // 简称
    const GROUPS={tail:n=>`${n%10} 尾`,road:n=>`${n%3} 路`,zone:n=>`第${"一二三"[zoneOf(rule.zones,n)]}区`} // 分组专家：同组号码分数一样，说它看好哪一组（最看好的号码所在的组）
    const view=m=>GROUPS[m.key]?GROUPS[m.key](m.top[0]):nums(m.top) // 每位专家看好什么
    const votes={};experts.filter(m=>!GROUPS[m.key]).forEach(m=>m.top.forEach(n=>{votes[n]=(votes[n]||0)+1})) // 每个号码被几位专家看好（前 3 名；分组专家只看组，不参加）
    const consensus=Object.keys(votes).map(Number).filter(n=>votes[n]>=3).sort((x,y)=>votes[y]-votes[x]||x-y) // 被三位以上专家同时看好的号码
    await write("各自看好",`${experts.map(m=>`${short(m)} ${view(m)}`).join("｜")}。${consensus.length?`其中 ${list(consensus)} 被三位以上专家同时看好。`:"意见很分散，没有号码被三位以上专家同时看好。"}`)
    const byHits=[...experts].sort((x,y)=>y.hits-x.hits),t=red.test // 按命中排序、配对检验
    await write("第四步｜回测",`用最近 ${DEEP.window} 期逐期考试，每期只用它之前的数据，不偷看答案。前 ${kr} 名平均猜中：最好的${byHits.slice(0,3).map(m=>`${short(m)} ${m.hits.toFixed(2)}`).join("、")}，最差的${short(byHits[byHits.length-1])} ${byHits[byHits.length-1].hits.toFixed(2)}；均衡基准（每个号码机会均等）是 ${(kr*kr/Mr).toFixed(2)}。${t.rel>0?`按误差算，最好的${t.name}比均衡基准低 ${(t.rel*100).toFixed(2)}%，配对检验 ${pt(t.p)}（12 位里挑最好的，已校正），${t.p<.05?"达到显著":"不显著"}。`:"按误差算，没有一位专家比均衡基准低。"}`)
    const blue=await blueJob // 等蓝球分析完成
    const ranked=[...red.models].sort((x,y)=>y.weight-x.weight),head5=ranked.slice(0,5),rest=ranked.slice(5) // 发言权从高到低：前 5 位、其余
    const blueTop=[...blue.models].sort((x,y)=>y.weight-x.weight)[0] // 蓝球发言权最高的
    await write("第五步｜分配权重",`${t.rel>0&&t.p<.05?`${t.name}显著好于平均水平，但优势很小，不能全信。`:drift?"十二位专家都没有显著超过平均水平：年份漂移是很多年里慢慢形成的整体变化，对下一期几乎没有帮助，历史上的“冷热”多半是巧合。":"十二位专家都没有显著超过平均水平：开奖本身没有规律可循，历史上的“冷热”多半是巧合。"}所以按考试成绩分配发言权，成绩差距小就不拉开太多：${head5.map(m=>`${m.name} ${pct(m.weight)}`).join("、")}，其余 ${rest.length} 位合计 ${pct(rest.reduce((s,m)=>s+m.weight,0))}。蓝球里${blueTop.name}的发言权最高（${pct(blueTop.weight)}）。`)
    const pick=deepPick(a,red,blue),ticket=pick.ticket // 精确计算：走势图形态常见的组合里得分最高的一注
    const inPick=consensus.filter(n=>ticket.red.includes(n)) // 多位专家共同看好、并且在这一注里的号码
    await write("第六步｜精确计算",`按加权后的分数取前 ${pick.pool} 个红球，列出全部 ${pick.total.toLocaleString()} 种组合，用 ${CHARTS.length-1} 张红球走势图的常见范围去掉少见形态，剩 ${pick.valid.toLocaleString()} 种，逐一算分，取得分最高的一注：红 ${nums(ticket.red)}。蓝球取分数最高、又不和这注红球凑成历史头奖的：${nums(ticket.blue)}。${!consensus.length?"":inPick.length?`三位以上专家看好的 ${list(inPick)} 在这一注里。`:"三位以上专家看好的号码因为分数或形态限制，没有进入这一注。"}`)
    const check=deepCheck(a,ticket),x=check.x,L=a.limits // 自我检查、这注的指标、常见范围
    await write("第七步｜自我检查",check.ok // 检查通过
      ?`号码个数和范围正确；和值 ${x.sum}（常见 ${L.sum[0]}～${L.sum[1]}）、跨度 ${x.span}（常见 ${L.span[0]}～${L.span[1]}）、AC 值 ${x.ac}、奇偶 ${ratio(x.odd,kr)}、区间 ${x.zones}、012 路 ${x.road}、重号 ${x.repeat} 个，全部走势图都在常见范围；不是历史头奖组合。全部通过，给出结果。`
      :`有一项没通过（${[!check.rules&&"号码规则",!check.shapes&&"走势图形态",check.jackpot&&"历史头奖"].filter(Boolean).join("、")}），结果仅供参考。`)
    title.textContent="已深度思考" // 标题改成已完成（不显示用时）
    resultInner.classList.add("deep-done") // 想完了（思考过程留在窗口里，可以上下滑动回看）
    showPick(ticket) // 中间的卡片填上这一注
  }catch(error){ // 读取或分析出错
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
