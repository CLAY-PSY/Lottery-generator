// 深度思考：研究全部开奖的走势图、开奖日期和独立性，八位专家打分、回测、加权，枚举全部组合按综合得分选出一注；窗口里只写简单的结论，计算全部在后台做
// ===== 流程（过程像推理模型一样实时显示）=====
// 开奖是独立事件，任何号码组合的中奖概率都一样，历史统计不能提高中奖概率。这里把能找到的分析方法都用上，按严谨的统计流程来做，并如实显示结论：
// 1. 走势图：逐期算出 17 张走势图（和值、和尾、跨度、AC 值、奇偶、大小、质合、区间、012 路、尾数、连号、重号、冷温热、振幅、首位、末位、蓝球），
//    做 Ljung-Box 检验（前 10 期的自相关）看走势会不会延续（振幅由和值算出，不单独检验；冷温热先扣掉热号多少的影响）；
//    再定出各图的常见范围（合起来覆盖历史上 80% 的开奖），用来筛选组合
// 2. 开奖日期：红球、蓝球分别按星期、月份、年份分组做卡方检验，再检验全部开奖是否均匀（按每期不放回抽取校正）
// 3. 独立性：游程检验、间隔检验、二维序列检验（上一期对下一期）、伴侣号检验（同一期两两同出，蒙特卡洛模拟校准）、热号命中检验
// 4. 八位专家各自给下一期每个号码估概率，逐期往前走，每期只用它之前的数据。每位手里有几种方法，用回测前的 300 期挑出最准的方法、参数和收缩比例：
//    冷热（频率、冷温热、回补、Holt 指数平滑）、遗漏（遗漏、周期、隐马尔可夫）、关联（转移、邻号、定位）、分组（尾数、012 路、区间）、
//    日期（星期、同期）、时序（灰色预测 GM(1,1)、频谱、相似形态 k 近邻）、杀号（10 个常见杀号公式）、
//    机器学习（神经网络、LSTM、梯度提升树、逻辑回归，四个模型取平均）
// 5. 回测：最近 200 期逐期检验，算各专家的对数损失和命中；最好的专家和均衡基准做配对检验（8 位里挑最好的，按 Bonferroni 校正）
// 6. 贝叶斯模型平均（按缓和系数降温）：把“均衡基准”（每个号码机会均等）也当作一个模型，按回测损失算后验权重，混合成最终概率
// 7. 选号：枚举全部红球组合，去掉走势图上少见的形态，逐一算分，取得分最高的一注；
//    蓝球取得分最高、又不和这注红球凑成历史头奖的
// 8. 自我检查：号码规则、走势图形态、历史头奖逐项核对
// 全程不用随机数：模型的起点和蒙特卡洛模拟由彩种和最新期号决定，选号按得分排序。同样的开奖数据，每次点击结果完全一样，开出新一期才会变
const DEEP={window:200,tune:300,temper:5,cover:.8,lags:10,recent:30,sims:300} // 回测最近 200 期、调参用回测前的 300 期、权重的缓和系数、走势图常见范围合起来覆盖 80% 的开奖、自相关检验看前 10 期、近期走势看 30 期、蒙特卡洛模拟 300 次
const NN={features:15,hidden:16,epochs:6,train:1100,valid:200} // 神经网络设置：每个号码 15 项特征、隐藏层 16 个神经元、训练 6 轮、用 1100 期训练、最近 200 期留作回测（和其他专家同一段）
const LSTM={steps:8,hidden:6,epochs:2,train:300,lr:.01} // LSTM 设置：看前 8 期、6 个记忆单元、训练 2 轮、用回测前的 300 期训练、学习率
const GBDT={rounds:30,depth:3,bins:32,lr:.1,lambda:1,minHess:5,train:700} // 梯度提升树设置：30 棵树、每棵 3 层、特征分 32 档、学习率、L2 正则、叶子最少的样本权重、用回测前的 700 期训练
const PRIME_LIST=[1,2,3,5,7,11,13,17,19,23,29,31] // 质合走势图的习惯：1 也算质数
const PRIME_MASK=PRIME_LIST.reduce((m,p)=>m|(1<<p),0) // 质数表（第 n 位是 1 表示 n 是质数；号码最大 35，31 以上没有质数）
const SHRINK=[0,.3,.6,.85] // 专家的概率向平均值收缩的比例（调参决定；噪声大的专家收缩多）
const CHARTS=[["sum","和值"],["sumTail","和尾"],["span","跨度"],["ac","AC 值"],["odd","奇偶"],["big","大小"],["prime","质合"],["zoneMax","区间"],["road0","012 路"],["tails","尾数"],["longest","连号"],["repeat","重号"],["hwc","冷温热"],["amp","振幅"],["first","首位"],["last","末位"],["blue","蓝球"]] // 17 张走势图：指标、名字
const RANGE_KEYS=["sum","span","amp","first","last"],SET_KEYS=["sumTail","ac","odd","big","prime","zoneMax","road","tails","longest","repeat","hwc"] // 筛选组合用的 16 张红球走势图：取值多的按百分位区间，取值少的按最常见的几个
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
function scaledChiP(stat,mean,variance){ // 没有现成分布的统计量：用蒙特卡洛模拟得到它在“完全独立”时的平均值和方差，按缩放的卡方分布（矩匹配）算 p 值
  if(!(variance>0)) return 1 // 模拟出来没有波动，无从比较
  const c=variance/(2*mean),df=2*mean*mean/variance // 缩放系数、自由度：c·χ²(df) 的均值、方差和模拟的一样
  return chiP(stat/c,df) // p 值
}
function popcount(x){ // 一个 32 位整数里有几个 1
  x=x-((x>>>1)&0x55555555);x=(x&0x33333333)+((x>>>2)&0x33333333) // 两两、四四相加
  return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24 // 汇总
}
function comb(n,k){ // 组合数 C(n,k)
  let c=1;for(let i=1;i<=k;i++)c=c*(n-k+i)/i;return Math.round(c) // 逐项相乘
}
function sigmoid(z){ // 把任意实数变成 0～1 的概率
  return 1/(1+Math.exp(-z)) // logistic 函数
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
async function pause(state,sliceMs){ // 在主线程上算时，连续算了 sliceMs 毫秒就让一下（后台线程里 sliceMs 很大，不会让）
  if(performance.now()-state.at>sliceMs){await new Promise(r=>setTimeout(r));state.at=performance.now()} // 让一下，重新计时
}
async function trainLSTM(draws,col,k,M,s,onStep,sliceMs,rand){ // LSTM（长短期记忆网络）：每个号码看前 8 期“开没开、邻号开没开”的序列，预测这一期开出的概率
  const ch=draws.slice().reverse(),T=ch.length,W=M+1,L=LSTM.steps,H=LSTM.hidden,I=2,Z=I+H+1,G=4*H // 按时间从早到晚、总期数、每期一行、步数、记忆单元数、每步输入、门的输入长度、四个门
  const pres=new Uint8Array(T*W),nb=new Uint8Array(T*W) // 每期每个号码：开没开、它的邻号开没开
  for(let t=0;t<T;t++){for(const n of ch[t][col])pres[t*W+n]=1;for(let n=1;n<=M;n++)nb[t*W+n]=(n>1&&pres[t*W+n-1])||(n<M&&pres[t*W+n+1])?1:0} // 逐期记下
  const P=new Float64Array(G*Z+H+1),m=new Float64Array(P.length),v=new Float64Array(P.length),g=new Float64Array(P.length) // 参数（门的权重、输出权重、输出偏置）、Adam 动量、梯度
  const OV=G*Z,OB=OV+H // 输出权重、输出偏置的位置
  for(let i=0;i<G*Z;i++)P[i]=(rand()*2-1)*Math.sqrt(6/(Z+H)) // 门的权重起点（由 rand 决定）
  for(let j=0;j<H;j++){P[(H+j)*Z+Z-1]=1;P[OV+j]=(rand()*2-1)*Math.sqrt(6/(H+1))} // 遗忘门偏置从 1 起步（常用做法）、输出权重起点
  const base=k/M;P[OB]=Math.log(base/(1-base)) // 输出偏置从平均概率起步
  const xs=new Float64Array(L*I),hs=new Float64Array((L+1)*H),cs=new Float64Array((L+1)*H),gate=new Float64Array(L*G),tc=new Float64Array(L*H) // 每一步的输入、记忆、细胞状态、四个门、tanh(细胞)
  const forward=(t,n)=>{ // 第 t 期号码 n：从前 8 期一步步读进来，返回开出的概率
    for(let j=0;j<H;j++){hs[j]=0;cs[j]=0} // 从零开始
    for(let q=0;q<L;q++){ // 每一步（从早到晚）
      const d=t-L+q;xs[q*I]=pres[d*W+n];xs[q*I+1]=nb[d*W+n] // 这一步的输入
      for(let r=0;r<G;r++){ // 四个门的每个单元
        let a=P[r*Z+Z-1];for(let i=0;i<I;i++)a+=P[r*Z+i]*xs[q*I+i];for(let j=0;j<H;j++)a+=P[r*Z+I+j]*hs[q*H+j] // 加权求和
        gate[q*G+r]=r<3*H?sigmoid(a):Math.tanh(a) // 输入门、遗忘门、输出门用 sigmoid，候选值用 tanh
      }
      for(let j=0;j<H;j++){ // 更新记忆
        const c=gate[q*G+H+j]*cs[q*H+j]+gate[q*G+j]*gate[q*G+3*H+j];cs[(q+1)*H+j]=c // 细胞状态：遗忘一部分、加入新的
        tc[q*H+j]=Math.tanh(c);hs[(q+1)*H+j]=gate[q*G+2*H+j]*tc[q*H+j] // 输出
      }
    }
    let z=P[OB];for(let j=0;j<H;j++)z+=P[OV+j]*hs[L*H+j] // 最后一步的记忆 → 输出
    return sigmoid(z) // 概率
  }
  const dh=new Float64Array(H),dc=new Float64Array(H),dz=new Float64Array(G),dhp=new Float64Array(H) // 反向传播用
  const backward=(p,y)=>{ // 反向传播（沿时间展开），把这个样本的梯度加到 g 上
    const dout=p-y;g[OB]+=dout // 输出层误差
    for(let j=0;j<H;j++){g[OV+j]+=dout*hs[L*H+j];dh[j]=dout*P[OV+j];dc[j]=0} // 输出权重的梯度、传回最后一步
    for(let q=L-1;q>=0;q--){ // 从最后一步往前
      for(let j=0;j<H;j++){ // 每个单元
        const i=gate[q*G+j],f=gate[q*G+H+j],o=gate[q*G+2*H+j],c=gate[q*G+3*H+j],th=tc[q*H+j] // 四个门、tanh(细胞)
        const dct=dc[j]+dh[j]*o*(1-th*th) // 细胞状态的梯度
        dz[j]=dct*c*i*(1-i);dz[H+j]=dct*cs[q*H+j]*f*(1-f);dz[2*H+j]=dh[j]*th*o*(1-o);dz[3*H+j]=dct*i*(1-c*c) // 四个门输入的梯度
        dc[j]=dct*f // 传给上一步的细胞状态
      }
      dhp.fill(0) // 传给上一步的记忆
      for(let r=0;r<G;r++){ // 每个门单元
        const d=dz[r];if(!d)continue // 没有梯度就跳过
        for(let i=0;i<I;i++)g[r*Z+i]+=d*xs[q*I+i];for(let j=0;j<H;j++){g[r*Z+I+j]+=d*hs[q*H+j];dhp[j]+=d*P[r*Z+I+j]};g[r*Z+Z-1]+=d // 权重、偏置的梯度
      }
      for(let j=0;j<H;j++)dh[j]=dhp[j] // 往前一步
    }
  }
  const start=T-s.train-s.valid,from=Math.max(start,T-s.valid-LSTM.train),order=[] // 和神经网络同一段；只用回测前的 500 期训练
  for(let t=from;t<T-s.valid;t++)for(let n=1;n<=M;n++)order.push(t*W+n) // 训练样本
  const BATCH=128,state={at:performance.now()} // 每批样本数、让一下的计时
  let step=0,loss=0 // Adam 步数、本轮误差
  for(let e=1;e<=LSTM.epochs;e++){ // 每一轮
    for(let i=order.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[order[i],order[j]]=[order[j],order[i]]} // 打乱顺序（由 rand 决定）
    loss=0 // 清零
    for(let b=0;b<order.length;b+=BATCH){ // 每一批
      g.fill(0);const end=Math.min(b+BATCH,order.length) // 梯度清零、这一批的结尾
      for(let q=b;q<end;q++){const t=Math.floor(order[q]/W),n=order[q]%W,y=pres[t*W+n],p=forward(t,n);loss-=Math.log(Math.max(y?p:1-p,1e-12));backward(p,y)} // 前向、误差、反向
      step++;const c1=1-.9**step,c2=1-.999**step,nb2=end-b // Adam 的偏差修正、批大小
      for(let i=0;i<P.length;i++){const gr=g[i]/nb2;m[i]=.9*m[i]+.1*gr;v[i]=.999*v[i]+.001*gr*gr;P[i]-=LSTM.lr*(m[i]/c1)/(Math.sqrt(v[i]/c2)+1e-8)} // Adam 更新
      await pause(state,sliceMs) // 主线程上让一下
    }
    loss/=order.length // 平均误差
    await onStep("LSTM",e,LSTM.epochs,loss) // 报告进度
  }
  const rows=s.valid+1,out=new Float64Array(rows*M) // 回测期和下一期
  for(let r=0;r<rows;r++){let sum=0;const t=T-s.valid+r;for(let n=1;n<=M;n++){out[r*M+n-1]=forward(t,n);sum+=out[r*M+n-1]}for(let n=0;n<M;n++)out[r*M+n]=Math.min(.999,Math.max(1e-4,out[r*M+n]*k/sum))} // 每期归一化到开出个数
  return {P:out,loss} // 概率、最后一轮的误差
}
async function trainGBDT(s,onStep,sliceMs){ // 梯度提升树（XGBoost 的做法）：40 棵 3 层的决策树，一棵棵修正前面的误差；特征分档后用直方图找最佳切分
  const F=NN.features,X=s.X,nT=s.nTrain,rows=X.length/F,B=GBDT.bins,lam=GBDT.lambda // 特征数、特征、训练样本数、全部样本数、分档数、L2 正则
  const t0=Math.max(0,s.train-GBDT.train)*s.max,idx0=Int32Array.from({length:nT-t0},(_,i)=>t0+i),nU=idx0.length // 只用回测前的 700 期训练（样本序号、个数）
  const th=[] // 每项特征的分档界线（按训练样本的分位数）
  for(let f=0;f<F;f++){const v=new Float32Array(nU);for(let i=0;i<nU;i++)v[i]=X[idx0[i]*F+f];v.sort();const t=[];for(let b=1;b<B;b++){const x=v[Math.floor(b*nU/B)];if(!t.length||x>t[t.length-1])t.push(x)}th.push(t)} // 去掉重复的界线
  const bin=new Uint8Array(rows*F) // 每个样本每项特征落在第几档
  for(let i=0;i<rows;i++)for(let f=0;f<F;f++){const t=th[f],x=X[i*F+f];let lo=0,hi=t.length;while(lo<hi){const mid=(lo+hi)>>1;if(t[mid]<x)lo=mid+1;else hi=mid}bin[i*F+f]=lo} // 二分查找
  const u=s.k/s.max,score=new Float64Array(rows).fill(Math.log(u/(1-u))),g=new Float64Array(nT),h=new Float64Array(nT),state={at:performance.now()} // 每个样本的对数几率（从平均概率起步）、梯度、二阶导、计时
  for(let round=1;round<=GBDT.rounds;round++){ // 每一棵树
    for(const i of idx0){const p=sigmoid(score[i]);g[i]=p-s.Y[i];h[i]=p*(1-p)} // 对数损失的一阶、二阶导
    const tree=[] // 树的节点：{f,b,l,r} 或 {v}
    const build=(idx,depth)=>{ // 在样本 idx 上长一个节点，返回它的编号
      let G=0,Hs=0;for(const i of idx){G+=g[i];Hs+=h[i]} // 梯度和、二阶导和
      const leaf=()=>{tree.push({v:-G/(Hs+lam)*GBDT.lr});return tree.length-1} // 叶子：最优值乘学习率
      if(depth===GBDT.depth||idx.length<2) return leaf() // 到最深一层
      const hg=new Float64Array(F*B),hh=new Float64Array(F*B) // 每项特征每一档的梯度和、二阶导和
      for(const i of idx)for(let f=0;f<F;f++){const b=bin[i*F+f];hg[f*B+b]+=g[i];hh[f*B+b]+=h[i]} // 直方图
      const parent=G*G/(Hs+lam);let best=1e-9,bf=-1,bb=-1 // 不切时的得分、最好的切分
      for(let f=0;f<F;f++){let gl=0,hl=0;for(let b=0;b<B-1;b++){gl+=hg[f*B+b];hl+=hh[f*B+b];const hr=Hs-hl;if(hl<GBDT.minHess||hr<GBDT.minHess)continue;const gain=gl*gl/(hl+lam)+(G-gl)**2/(hr+lam)-parent;if(gain>best){best=gain;bf=f;bb=b}}} // 每个切分点的增益
      if(bf<0) return leaf() // 没有值得切的
      let nl=0;for(const i of idx)if(bin[i*F+bf]<=bb)nl++ // 左边几个
      const L=new Int32Array(nl),R=new Int32Array(idx.length-nl);let a=0,c=0;for(const i of idx){if(bin[i*F+bf]<=bb)L[a++]=i;else R[c++]=i} // 分到两边
      const node={f:bf,b:bb};tree.push(node);const id=tree.length-1 // 这个节点
      node.l=build(L,depth+1);node.r=build(R,depth+1) // 左右子树
      return id // 编号
    }
    build(idx0,0) // 从全部训练样本开始长
    for(let i=0;i<rows;i++){let q=0;while(tree[q].v===undefined)q=bin[i*F+tree[q].f]<=tree[q].b?tree[q].l:tree[q].r;score[i]+=tree[q].v} // 全部样本加上这棵树的修正
    if(round%10===0){let loss=0;for(const i of idx0){const p=sigmoid(score[i]);loss-=Math.log(Math.max(s.Y[i]?p:1-p,1e-12))}await onStep("梯度提升树",round/10,GBDT.rounds/10,loss/nU)} // 每 10 棵报告一次
    await pause(state,sliceMs) // 主线程上让一下
  }
  let loss=0;for(const i of idx0){const p=sigmoid(score[i]);loss-=Math.log(Math.max(s.Y[i]?p:1-p,1e-12))} // 训练误差
  return {forward:i=>sigmoid(score[i]),loss:loss/nU} // 第 i 个样本的概率、误差
}
async function trainLogit(s,onStep,sliceMs){ // 逻辑回归：15 项特征的线性组合 → 概率；用牛顿法（IRLS）加 L2 正则精确求解
  const F=NN.features,D=F+1,X=s.X,n=s.nTrain,lam=1,w=new Float64Array(D),u=s.k/s.max,state={at:performance.now()} // 特征数、参数个数（含截距）、特征、训练样本数、正则、参数、平均概率、计时
  w[F]=Math.log(u/(1-u)) // 截距从平均概率起步
  const z=i=>{let a=w[F];for(let f=0;f<F;f++)a+=w[f]*X[i*F+f];return a} // 线性部分
  let loss=0 // 误差
  for(let it=1;it<=8;it++){ // 牛顿法迭代 8 次
    const gr=new Float64Array(D),He=new Float64Array(D*D);loss=0 // 梯度、海森矩阵
    for(let i=0;i<n;i++){ // 每个训练样本
      const p=sigmoid(z(i)),y=s.Y[i],r=p-y,q=p*(1-p);loss-=Math.log(Math.max(y?p:1-p,1e-12)) // 概率、残差、权重
      for(let a=0;a<D;a++){const xa=a<F?X[i*F+a]:1;gr[a]+=r*xa;for(let b=0;b<=a;b++)He[a*D+b]+=q*xa*(b<F?X[i*F+b]:1)} // 累加
    }
    for(let a=0;a<D;a++){for(let b=0;b<a;b++)He[b*D+a]=He[a*D+b];if(a<F){gr[a]+=lam*w[a];He[a*D+a]+=lam}} // 对称、加正则（截距不加）
    for(let c=0;c<D;c++){let piv=c;for(let r=c+1;r<D;r++)if(Math.abs(He[r*D+c])>Math.abs(He[piv*D+c]))piv=r;if(piv!==c){for(let b=0;b<D;b++){const t=He[c*D+b];He[c*D+b]=He[piv*D+b];He[piv*D+b]=t}const t=gr[c];gr[c]=gr[piv];gr[piv]=t}for(let r=c+1;r<D;r++){const f=He[r*D+c]/He[c*D+c];for(let b=c;b<D;b++)He[r*D+b]-=f*He[c*D+b];gr[r]-=f*gr[c]}} // 高斯消元
    for(let c=D-1;c>=0;c--){let sum=gr[c];for(let b=c+1;b<D;b++)sum-=He[c*D+b]*gr[b];gr[c]=sum/He[c*D+c]} // 回代：gr 变成牛顿步长
    for(let a=0;a<D;a++)w[a]-=gr[a] // 更新
    await pause(state,sliceMs) // 主线程上让一下
  }
  await onStep("逻辑回归",1,1,loss/n) // 报告
  return {forward:i=>sigmoid(z(i)),loss:loss/n} // 第 i 个样本的概率、误差
}
function hmmFit(y,u){ // 两状态（冷、热）隐马尔可夫模型：Baum-Welch 算法（带缩放的前向后向）估出两种状态的开出率和切换概率
  const N=y.length,al=new Float64Array(2*N),be=new Float64Array(2*N),sc=new Float64Array(N) // 期数、前向、后向、缩放系数
  let e0=u*.7,e1=Math.min(.95,u*1.3),a01=.1,a10=.1,p0=.5 // 冷、热的开出率，冷→热、热→冷的概率，起点是冷的概率
  const clip=x=>Math.min(1-1e-4,Math.max(1e-4,x)) // 不让概率变成 0 或 1
  for(let it=0;it<15;it++){ // 迭代 15 次
    for(let t=0;t<N;t++){const b0=y[t]?e0:1-e0,b1=y[t]?e1:1-e1;let x0,x1;if(!t){x0=p0*b0;x1=(1-p0)*b1}else{const q0=al[2*t-2],q1=al[2*t-1];x0=(q0*(1-a01)+q1*a10)*b0;x1=(q0*a01+q1*(1-a10))*b1}const s=x0+x1;sc[t]=s;al[2*t]=x0/s;al[2*t+1]=x1/s} // 前向
    be[2*N-2]=1;be[2*N-1]=1 // 后向的终点
    for(let t=N-2;t>=0;t--){const b0=y[t+1]?e0:1-e0,b1=y[t+1]?e1:1-e1,n0=be[2*t+2]*b0,n1=be[2*t+3]*b1;be[2*t]=((1-a01)*n0+a01*n1)/sc[t+1];be[2*t+1]=(a10*n0+(1-a10)*n1)/sc[t+1]} // 后向
    let g0=0,g1=0,g0y=0,g1y=0,f0=0,f1=0,x01=0,x10=0 // 各状态的期望次数、开出数、转移次数
    for(let t=0;t<N;t++){ // 每一期
      const c0=al[2*t]*be[2*t],c1=al[2*t+1]*be[2*t+1],s=c0+c1,q0=c0/s,q1=c1/s // 这一期在冷、热状态的后验概率
      g0+=q0;g1+=q1;if(y[t]){g0y+=q0;g1y+=q1} // 累计
      if(!t)p0=q0 // 起点
      if(t<N-1){const b0=y[t+1]?e0:1-e0,b1=y[t+1]?e1:1-e1;f0+=q0;f1+=q1;x01+=al[2*t]*a01*b1*be[2*t+3]/sc[t+1];x10+=al[2*t+1]*a10*b0*be[2*t+2]/sc[t+1]} // 转移
    }
    a01=clip(x01/f0);a10=clip(x10/f1);e0=clip(g0y/g0);e1=clip(g1y/g1);p0=clip(p0) // 更新参数
  }
  return {e0,e1,a01,a10,p0} // 参数
}
// ===== 七位专家（十九种统计、时间序列、形态识别方法） =====
function deepExperts(ch,col,k,M,zones,nextDate){ // 逐期往前走，每期只用它之前的数据，给调参期、回测期和下一期（t=T）的每个号码估概率；有参数的专家按调参期的损失挑参数
  const T=ch.length,start=T-DEEP.window,from=Math.max(60,start-DEEP.tune),rows=T-from+1,u=k/M,W=M+1,B=41 // 总期数、回测起点、调参起点、要估的期数、平均概率、每期一行、遗漏分组（0～40+）
  const day=ch.map(d=>d[1]).concat([nextDate]).map(s=>new Date(s+"T00:00:00Z")) // 每期（含下一期）的开奖日期
  const wd=day.map(d=>d.getUTCDay()),yr=day.map(d=>d.getUTCFullYear()),doy=day.map(d=>Math.round((d-Date.UTC(d.getUTCFullYear(),0,1))/864e5)) // 星期几、年份、一年里的第几天
  const sorted=ch.map(d=>[...d[col]].sort((a,b)=>a-b)) // 每期号码从小到大
  const Y=new Uint8Array(T*W);for(let t=0;t<T;t++)for(const n of ch[t][col])Y[t*W+n]=1 // 每期每个号码开没开
  const pre=new Int32Array((T+1)*W) // 前缀和：pre[t*W+n] 是前 t 期里号码 n 开出的次数
  for(let t=0;t<T;t++)for(let n=1;n<=M;n++)pre[(t+1)*W+n]=pre[t*W+n]+Y[t*W+n] // 逐期累计
  const count=(t,w,n)=>pre[t*W+n]-pre[Math.max(0,t-w)*W+n] // 第 t 期之前 w 期里号码 n 开出的次数
  const norm=raw=>{let sum=0;for(let n=1;n<=M;n++)sum+=raw[n];const p=new Float64Array(W);for(let n=1;n<=M;n++)p[n]=Math.min(.999,Math.max(1e-4,raw[n]*k/sum));return p} // 归一化：各号概率之和等于每期开出个数
  const last=new Int32Array(W).fill(-1) // 每个号码上次开出的期
  const bucket=(t,n)=>Math.min(B-1,last[n]<0?B-1:t-1-last[n]) // 第 t 期时号码 n 的遗漏期数（40 以上归一组）
  const list=[],learners=[] // 专家（每位有一个或几个参数版本）、每期开奖后更新统计的函数
  const add=(key,name,raws)=>list.push({key,name,variants:raws.map(raw=>({raw,P:new Float64Array(rows*M),loss:new Float64Array(SHRINK.length)}))}) // 加一位专家：raws 是各参数版本的打分函数（每个版本再按各收缩比例分别记调参损失）
  const each=f=>{const r=new Float64Array(W);for(let n=1;n<=M;n++)r[n]=f(n);return r} // 给每个号码打分
  const rate=(h,tr)=>(h+20*u)/(tr+20) // 开出率（向平均值平滑）
  // 频率专家：按时间衰减的出现次数，半衰期 8～256 期
  const HL=[8,16,32,64,128,256],S=HL.map(()=>new Float64Array(W)) // 候选半衰期、各自的衰减计数
  add("freq","频率",HL.map((h,i)=>()=>each(n=>S[i][n]+.5))) // 衰减计数（加一点平滑）
  learners.push(t=>HL.forEach((h,i)=>{const d=.5**(1/h);for(let n=1;n<=M;n++)S[i][n]=S[i][n]*d+Y[t*W+n]})) // 更新
  // 遗漏专家：历史上遗漏同样期数的号码，下一期开出的比例（所有号码一起统计）
  const trials=new Float64Array(B),hits=new Float64Array(B),hazard=b=>rate(hits[b],trials[b]) // 各遗漏期数的次数、开出数、开出率
  add("gap","遗漏",[t=>each(n=>hazard(bucket(t,n)))]) // 打分
  // 周期专家：每个号码自己的出号间隔规律（样本少时向整体规律收缩）
  const tn=new Float64Array(W*B),hn=new Float64Array(W*B) // 每个号码各遗漏期数的次数、开出数
  add("cycle","周期",[10,40,160].map(c=>t=>each(n=>{const b=bucket(t,n);return (hn[n*B+b]+c*hazard(b))/(tn[n*B+b]+c)}))) // 收缩强度 10～160
  learners.push(t=>{for(let n=1;n<=M;n++){const b=bucket(t,n),y=Y[t*W+n];trials[b]++;hits[b]+=y;tn[n*B+b]++;hn[n*B+b]+=y}}) // 更新遗漏和周期的统计
  // 回补专家：近 w 期出现次数低于期望的号码加分（偏差按标准差算），w 和力度由调参决定
  add("revert","回补",[30,100,300,1000].flatMap(w=>[.1,.3].map(g=>t=>{const span=Math.min(w,t),E=span*u,sd=Math.sqrt(E*(1-u))||1;return each(n=>Math.exp(-g*(count(t,w,n)-E)/sd))})))
  // 冷温热专家：按近 5 期、近 10 期的出现次数分成 9 类（冷、温、热的常见划分），各类的历史开出率
  const hwOf=(t,n)=>Math.min(2,count(t,5,n))*3+(count(t,10,n)<=1?0:count(t,10,n)<=3?1:2),hwT=new Float64Array(9),hwH=new Float64Array(9) // 分类、各类的次数和开出数
  add("hotwarm","冷温热",[t=>each(n=>{const c=hwOf(t,n);return rate(hwH[c],hwT[c])})]) // 打分
  learners.push(t=>{for(let n=1;n<=M;n++){const c=hwOf(t,n);hwT[c]++;hwH[c]+=Y[t*W+n]}}) // 更新
  // 转移专家：上期开出 m 之后，下一期开出 n 的比例，按上期每个号码取平均
  const C=Array.from({length:W},()=>new Float64Array(W)),occ=new Float64Array(W) // 上期开出 m、下期开出 n 的次数；m 开出的次数
  add("markov","转移",[t=>{const prev=ch[t-1][col];return each(n=>{let s=0;for(const m of prev)s+=(C[m][n]+20*u)/(occ[m]+20);return s/prev.length})}]) // 打分
  learners.push(t=>{if(t>=1)for(const m of ch[t-1][col]){occ[m]++;for(let n=1;n<=M;n++)C[m][n]+=Y[t*W+n]}}) // 更新
  // 邻号专家：号码和上期的关系（重号、邻号 ±1、隔号 ±2、其他）× 上上期是否开出，共 8 类，各类的历史开出率
  const relOf=(t,n)=>{const p=t-1,q=t-2,has=(d,x)=>x>=1&&x<=M&&Y[d*W+x]===1;const r=has(p,n)?0:has(p,n-1)||has(p,n+1)?1:has(p,n-2)||has(p,n+2)?2:3;return r*2+(q>=0&&has(q,n)?1:0)} // 第 t 期号码 n 属于哪一类
  const relT=new Float64Array(8),relH=new Float64Array(8) // 各类的次数、开出数
  add("neighbor","邻号",[t=>each(n=>{const c=relOf(t,n);return rate(relH[c],relT[c])})]) // 打分
  learners.push(t=>{if(t>=1)for(let n=1;n<=M;n++){const c=relOf(t,n);relT[c]++;relH[c]+=Y[t*W+n]}}) // 更新
  // 定位专家（位置振幅）：号码从小到大排好后，每个位置这期比上期变了多少，历史上这个变化量的分布
  const PH=[Infinity,256],pos=PH.map(()=>Array.from({length:k},()=>new Float64Array(2*M+1))) // 不衰减、半衰期 256 期；每个位置的变化量计数
  add("position","定位",PH.map((h,i)=>t=>{const r=new Float64Array(W),prev=sorted[t-1];for(let j=0;j<k;j++){const c=pos[i][j];let z=0;for(let n=1;n<=M;n++)z+=c[n-prev[j]+M]+.5;for(let n=1;n<=M;n++)r[n]+=(c[n-prev[j]+M]+.5)/z}return r})) // 每个位置落到各号码的概率加起来
  learners.push(t=>{if(t<1)return;PH.forEach((h,i)=>{const d=h===Infinity?1:.5**(1/h);for(let j=0;j<k;j++){const c=pos[i][j];if(d<1)for(let q=0;q<c.length;q++)c[q]*=d;c[sorted[t][j]-sorted[t-1][j]+M]++}})}) // 更新
  // 尾数、012 路、区间专家：同一组号码的衰减热度（每个号码按所在组的平均算），半衰期 16～256 期
  const groupExpert=(key,name,grp)=>{ // 按分组 grp 建一位专家
    const ids=Array.from({length:W},(_,n)=>n?grp(n):0),G=Math.max(...ids)+1,size=new Float64Array(G) // 每个号码的组、组数、每组几个号码
    for(let n=1;n<=M;n++) size[ids[n]]++ // 数每组的号码
    const HG=[16,64,256],SG=HG.map(()=>new Float64Array(G)) // 候选半衰期、各组的衰减计数
    add(key,name,HG.map((h,i)=>()=>each(n=>SG[i][ids[n]]/size[ids[n]]+.5))) // 打分
    learners.push(t=>HG.forEach((h,i)=>{const d=.5**(1/h),s=SG[i];for(let j=0;j<G;j++)s[j]*=d;for(let n=1;n<=M;n++)s[ids[n]]+=Y[t*W+n]})) // 更新
  }
  groupExpert("tail","尾数",n=>n%10) // 尾数 0～9
  groupExpert("road","012 路",n=>n%3) // 除以 3 的余数
  groupExpert("zone","区间",n=>zoneOf(zones,n)) // 所在区间
  // 星期专家：同一开奖日（星期几）的历史开出率，半衰期 64、256 期或不衰减
  const HW=[64,256,Infinity],CW=HW.map(()=>Array.from({length:7},()=>new Float64Array(W))),NW=HW.map(()=>new Float64Array(7)) // 候选半衰期、各开奖日的号码计数和期数
  add("weekday","星期",HW.map((h,i)=>t=>{const c=CW[i][wd[t]],N=NW[i][wd[t]];return each(n=>(c[n]+20*u)/(N+20))})) // 打分
  learners.push(t=>HW.forEach((h,i)=>{const d=h===Infinity?1:.5**(1/h),c=CW[i][wd[t]];for(let n=1;n<=M;n++)c[n]=c[n]*d+Y[t*W+n];NW[i][wd[t]]=NW[i][wd[t]]*d+1})) // 更新这一期所在开奖日的统计
  // 同期专家：往年同一时段（前后 7、15、30 天）的开出率
  const SD=[7,15,30];let seasonAt=-1,seasonC=null,seasonN=null // 候选时段；缓存：同一期的三个时段共用一次扫描
  const seasonOf=t=>{if(seasonAt!==t){seasonAt=t;seasonC=SD.map(()=>new Float64Array(W));seasonN=SD.map(()=>0);for(let s=0;s<t;s++){if(yr[s]>=yr[t])continue;let d=Math.abs(doy[s]-doy[t]);d=Math.min(d,365-d);if(d>SD[SD.length-1])continue;SD.forEach((D,v)=>{if(d<=D){seasonN[v]++;for(let n=1;n<=M;n++)seasonC[v][n]+=Y[s*W+n]}})}}} // 往年同一时段的开奖
  add("season","同期",SD.map((D,v)=>t=>{seasonOf(t);return each(n=>(seasonC[v][n]+20*u)/(seasonN[v]+20))}))
  // 杀号专家：网上常见的 10 个杀号公式（用上期 x、上上期 y 的号码算出一个“不会开”的号），逐个统计历史准确率，按准确率给被杀的号码降分
  const sumOf=v=>v.reduce((a,b)=>a+b,0),L1=v=>v[v.length-1],S1=v=>v[Math.min(1,v.length-1)] // 和值、最大的号、第二小的号
  const KILLS=[(x,y)=>x[0]+L1(x),(x,y)=>L1(x)-x[0],(x,y)=>sumOf(x),(x,y)=>x[0]+y[0],(x,y)=>Math.abs(x[0]-y[0]),(x,y)=>x[0]*y[0],(x,y)=>sumOf(x)+sumOf(y),(x,y)=>x[0]+Math.floor(M/2),(x,y)=>Math.abs(L1(x)-L1(y)),(x,y)=>S1(x)+S1(y)] // 首尾和、跨度、和值、两期首位和、两期首位差、两期首位积、两期和值和、首位加半、两期末位差、两期次位和
  const killOf=(f,t)=>(((f(sorted[t-1],sorted[t-2])%M)+M)%M)||M // 公式算出的号（除以 M 取余，0 当作 M）
  const kT=new Float64Array(KILLS.length),kOk=new Float64Array(KILLS.length),kAcc=i=>(kOk[i]+20*(1-u))/(kT[i]+20) // 各公式的次数、杀对的次数、准确率（向“不算也能杀对”的比例平滑）
  add("kill","杀号公式",[t=>{const r=each(()=>1);KILLS.forEach((f,i)=>{r[killOf(f,t)]*=(1-kAcc(i))/u});return r}]) // 被杀的号码：乘上“被这个公式杀了还开出”的比例 ÷ 平均开出率
  learners.push(t=>{if(t<2)return;KILLS.forEach((f,i)=>{kT[i]++;kOk[i]+=1-Y[t*W+killOf(f,t)]})}) // 更新
  // 灰色预测专家 GM(1,1)：每个号码最近 6 段（每段 10 或 20 期）的出现次数，用灰色模型预测下一段
  const gm=x=>{const m=x.length,x1=[];let s=0;for(const v of x){s+=v;x1.push(s)}let Szz=0,Sz=0,Szy=0,Sy=0;for(let i=1;i<m;i++){const z=-.5*(x1[i]+x1[i-1]);Szz+=z*z;Sz+=z;Szy+=z*x[i];Sy+=x[i]}const N=m-1,det=N*Szz-Sz*Sz;if(Math.abs(det)<1e-12)return x[m-1];const a=(N*Szy-Sz*Sy)/det,b=(Szz*Sy-Sz*Szy)/det;if(Math.abs(a)<1e-9)return b;const f=q=>(x[0]-b/a)*Math.exp(-a*q)+b/a;return f(m)-f(m-1)} // 最小二乘估发展系数 a、灰作用量 b，累加序列还原出下一个值
  add("grey","灰色预测",[10,20].map(bs=>t=>each(n=>{const x=[];for(let i=6;i>=1;i--)x.push(count(t-(i-1)*bs,bs,n)+.5);return Math.min(bs,Math.max(.05,gm(x)))/bs}))) // 预测的次数 ÷ 段长 = 每期开出率
  // 指数平滑专家（Holt 线性趋势，相当于 ARIMA(0,2,2)）：每个号码的水平和趋势，α、β 由调参决定
  const HO=[[.005,.001],[.01,.002],[.02,.005],[.05,.01]],Lv=HO.map(()=>new Float64Array(W).fill(u)),Bt=HO.map(()=>new Float64Array(W)) // 候选参数、水平、趋势
  add("holt","指数平滑",HO.map((p,i)=>()=>each(n=>Math.max(.001,Lv[i][n]+Bt[i][n])))) // 预测 = 水平 + 趋势
  learners.push(t=>HO.forEach(([al,be],i)=>{for(let n=1;n<=M;n++){const L0=Lv[i][n],B0=Bt[i][n],L2=al*Y[t*W+n]+(1-al)*(L0+B0);Bt[i][n]=be*(L2-L0)+(1-be)*B0;Lv[i][n]=L2}})) // 更新
  // 频谱专家（傅里叶周期）：每个号码最近 128 或 256 期里最强的周期（2～40 期），按这个周期外推到下一期；用滑动 DFT 逐期更新
  const PER=Array.from({length:39},(_,i)=>i+2),SN=[128,256],NF=PER.length // 候选周期、窗口长度、周期个数
  const cosT=PER.map(p=>Array.from({length:p},(_,r)=>Math.cos(2*Math.PI*r/p))),sinT=PER.map(p=>Array.from({length:p},(_,r)=>Math.sin(2*Math.PI*r/p))) // 三角函数表
  const re=SN.map(()=>new Float64Array(W*NF)),im=SN.map(()=>new Float64Array(W*NF)),specFrom=from-SN[SN.length-1]-1 // 每个窗口、每个号码、每个周期的傅里叶系数；从哪一期开始累计
  const spec=(w,gamma)=>t=>{const N=SN[w];return each(n=>{let best=-1,bf=0;for(let f=0;f<NF;f++){const a=re[w][n*NF+f],b=im[w][n*NF+f],pw=a*a+b*b;if(pw>best){best=pw;bf=f}}const P=PER[bf],r=t%P,amp=(P===2?1:2)/N;return Math.max(.001,u+gamma*amp*(re[w][n*NF+bf]*cosT[bf][r]-im[w][n*NF+bf]*sinT[bf][r]))})} // 最强周期的谐波外推
  add("spectrum","频谱",[[0,.5],[0,1],[1,.5],[1,1]].map(([w,g])=>spec(w,g))) // 窗口 × 外推力度
  learners.push(t=>{if(t<specFrom)return;SN.forEach((N,w)=>{for(let f=0;f<NF;f++){const P=PER[f],r=t%P,o=t-N;for(let n=1;n<=M;n++){const y=Y[t*W+n]-u;re[w][n*NF+f]+=y*cosT[f][r];im[w][n*NF+f]-=y*sinT[f][r];if(o>=0&&o>=specFrom){const yo=Y[o*W+n]-u,ro=o%P;re[w][n*NF+f]-=yo*cosT[f][ro];im[w][n*NF+f]+=yo*sinT[f][ro]}}}})}) // 加上新的一期、去掉滑出窗口的一期
  // 相似形态专家（k 近邻）：用每个号码近 10 期的出现次数描述“现在的样子”，在历史上找最像的 50 或 200 个时刻，看它们下一期开了什么
  const V=new Uint8Array((T+1)*W);for(let t=0;t<=T;t++)for(let n=1;n<=M;n++)V[t*W+n]=count(t,10,n) // 每个时刻的样子
  let knnAt=-1,knnKeys=null // 缓存：同一期的两个参数版本共用一次排序
  const nearest=t=>{if(knnAt!==t){knnAt=t;const keys=new Float64Array(Math.max(0,t-19));for(let s=10;s<=t-10;s++){let d=0;for(let n=1;n<=M;n++){const x=V[t*W+n]-V[s*W+n];d+=x*x}keys[s-10]=d*8192+s}keys.sort();knnKeys=keys}return knnKeys} // 按距离排好的历史时刻（不和现在的 10 期重叠）
  add("analog","相似形态",[50,200].map(K=>t=>{const o=nearest(t),c=new Float64Array(W),K2=Math.min(K,o.length);for(let q=0;q<K2;q++){const s=o[q]%8192;for(let n=1;n<=M;n++)c[n]+=Y[s*W+n]}return each(n=>(c[n]+5*u)/(K2+5))})) // 最像的 K 个时刻里各号码的开出率
  // 隐马尔可夫专家：每个号码有“冷”“热”两种看不见的状态，用调参期之前的数据（最多 1500 期）估参数，之后逐期滤波，算下一期在热状态的可能
  const fitFrom=Math.max(0,from-1500),hmmPred=new Float64Array(rows*W) // 估参数的起点、预测结果
  for(let n=1;n<=M;n++){ // 每个号码
    const y=new Uint8Array(from-fitFrom);for(let t=fitFrom;t<from;t++)y[t-fitFrom]=Y[t*W+n] // 估参数用的序列
    const {e0,e1,a01,a10,p0}=hmmFit(y,u);let q0=p0 // 参数、当前在冷状态的概率
    for(let t=fitFrom;t<=T;t++){ // 逐期滤波
      const pr0=t===fitFrom?p0:q0*(1-a01)+(1-q0)*a10 // 这一期在冷状态的先验
      if(t>=from)hmmPred[(t-from)*W+n]=pr0*e0+(1-pr0)*e1 // 预测开出的概率
      if(t<T){const b0=Y[t*W+n]?e0:1-e0,b1=Y[t*W+n]?e1:1-e1;q0=pr0*b0/(pr0*b0+(1-pr0)*b1)} // 看到这一期结果后更新
    }
  }
  add("hmm","隐马尔可夫",[t=>each(n=>hmmPred[(t-from)*W+n])]) // 打分
  for(let t=0;t<=T;t++){ // 每一期
    if(t>=from){ // 从调参期开始估
      const r=t-from // 第几行
      for(const e of list) for(const v of e.variants){ // 每位专家的每个参数版本
        const p=norm(v.raw(t)) // 概率
        for(let n=1;n<=M;n++) v.P[r*M+n-1]=p[n] // 记下
        if(t<start) SHRINK.forEach((c,i)=>{for(let n=1;n<=M;n++){const q=(1-c)*p[n]+c*u;v.loss[i]-=Math.log(Y[t*W+n]?q:1-q)}}) // 调参期：每个收缩比例分别累计损失
      }
    }
    if(t===T) break // 下一期还没开奖，到此为止
    for(const f of learners) f(t) // 用这期结果更新统计
    for(const n of ch[t][col]) last[n]=t // 记下开出的期（最后更新，遗漏分组要用开奖前的值）
  }
  const off=(start-from)*M,base=1-u,accs=KILLS.map((f,i)=>kOk[i]/kT[i]) // 回测期从第几个数开始；不算也能杀对的比例、各杀号公式的历史准确率
  return { // 结果
    start, // 回测起点
    experts:[["hot","冷热专家",["freq","hotwarm","revert","holt"]],["miss","遗漏专家",["gap","cycle","hmm"]],["link","关联专家",["markov","neighbor","position"]],["group","分组专家",["tail","road","zone"]],["date","日期专家",["weekday","season"]],["series","时序专家",["grey","spectrum","analog"]],["kill","杀号专家",["kill"]]].map(([key,name,methods])=>{ // 七位专家，每位手里有几种方法
      let bm=null,bv=null,bi=0,bl=Infinity // 调参期损失最小的方法、参数版本、收缩比例
      for(const e of list) if(methods.includes(e.key)) for(const v of e.variants) v.loss.forEach((l,i)=>{if(l<bl){bl=l;bm=e;bv=v;bi=i}}) // 方法 × 参数 × 收缩比例一起比
      const c=SHRINK[bi];return {key,name,method:bm.key,methodName:bm.name,P:bv.P.slice(off).map(p=>(1-c)*p+c*u)} // 只留回测期和下一期
    }),
    kill:{min:Math.min(...accs),max:Math.max(...accs),base,count:KILLS.length,next:[...new Set(KILLS.map(f=>killOf(f,T)))].sort((a,b)=>a-b)}, // 杀号公式：准确率范围、不算也能杀对的比例、公式个数、这次杀的号
  }
}
async function deepPool(draws,col,k,M,zones,nextDate,onStep,sliceMs){ // 一种球（红球或蓝球）的完整分析：专家打分、机器学习、回测、配对检验、贝叶斯加权
  const ch=draws.slice().reverse(),u=k/M,R=DEEP.window,seed=`${draws[0][0]}|${draws.length}|${col}|${k}|${M}` // 按时间从早到晚、平均概率、回测期数、固定起点用的文字
  const E=deepExperts(ch,col,k,M,zones,nextDate) // 七位专家（十九种统计、时间序列、形态识别方法）
  const s=nnSamples(draws,col,k,M,zones,nextDate) // 机器学习的样本（最近 200 期留作回测）
  const net=await trainNet(s,(e,loss)=>onStep("神经网络",e,NN.epochs,loss),sliceMs,seededRandom(seed)) // 神经网络：起点由最新期号等固定下来，同样的数据每次训练出同样的网络
  const lstm=await trainLSTM(draws,col,k,M,s,onStep,sliceMs,seededRandom(seed+"|lstm")) // LSTM
  const gbdt=await trainGBDT(s,onStep,sliceMs) // 梯度提升树
  const logit=await trainLogit(s,onStep,sliceMs) // 逻辑回归
  const ml=[nnWindow(net,s),lstm.P,nnWindow(gbdt,s),nnWindow(logit,s)],mlP=ml[0].map((_,i)=>ml.reduce((a,P)=>a+P[i],0)/ml.length) // 机器学习专家：四个模型的概率取平均（集成）
  const models=[{key:"uniform",name:"均衡基准",P:null},...E.experts,{key:"ml",name:"机器学习专家",method:"ml",methodName:"四个模型平均",P:mlP}] // 参与评比的模型：均衡基准 + 八位专家
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
  const test={key:best.key,name:best.name,rel:best.gain/base.loss,p:Math.min(1,one*experts.length)} // 8 位里挑最好的，p 值乘 8（Bonferroni 校正）
  const minLoss=Math.min(...models.map(m=>m.loss)) // 最小损失
  // 贝叶斯模型平均：权重 ∝ 回测似然（各模型先验相同）。200 期的成绩偶然性很大，按缓和系数 5 降温（power posterior），差距很小时权重不拉得太开
  let zsum=0;for(const m of models){m.w=Math.exp(-(m.loss-minLoss)/DEEP.temper);zsum+=m.w} // 未归一化的权重
  for(const m of models){m.weight=m.w/zsum;delete m.w;delete m.rows} // 归一化
  const mix=Array.from({length:M+1},(_,n)=>n?models.reduce((sum,m)=>sum+m.weight*m.next[n],0):0) // 混合后的下一期概率
  return {models,mix,test,kill:E.kill,losses:{nn:net.loss,lstm:lstm.loss,gbdt:gbdt.loss,logit:logit.loss}} // 结果
}
// ===== 走势图 =====
function shapeOf(reds,rule,prevSet,prevSum,cls){ // 一注红球（从小到大）在各张走势图上的指标；prevSet 是上一期红球（算重号），prevSum 是上一期和值（算振幅），cls 是开奖前各号码的冷温热（0 热、1 温、2 冷）
  const k=reds.length,half=rule.red[1]/2,e0=rule.zones[0][1],e1=rule.zones[1][1] // 个数、大小分界、第一区和第二区的最大号
  let sum=0,odd=0,big=0,prime=0,run=1,longest=1,tailMask=0,lo=0,hi=0,repeat=0,h=0,w=0,c=0,z0=0,z1=0,z2=0,r0=0,r1=0,r2=0 // 和值、奇数、大号、质数、连号、尾数、两两之差、重号、冷温热、三个区、012 路
  for(let i=0;i<k;i++){ // 每个号码
    const n=reds[i];sum+=n;if(n&1)odd++;if(n>half)big++;if(n<32&&(PRIME_MASK>>>n)&1)prime++ // 和值、奇偶、大小、质合
    if(n<=e0)z0++;else if(n<=e1)z1++;else z2++ // 区间
    const r=n%3;if(!r)r0++;else if(r===1)r1++;else r2++ // 012 路
    tailMask|=1<<(n%10) // 尾数
    if(prevSet&&prevSet[n])repeat++ // 重号
    if(cls){const q=cls[n];if(!q)h++;else if(q===1)w++;else c++} // 冷温热
    if(i){run=n===reds[i-1]+1?run+1:1;if(run>longest)longest=run} // 连号
    for(let j=0;j<i;j++){const d=n-reds[j];if(d<32)lo|=1<<d;else hi|=1<<(d-32)} // 两两之差（用二进制位记）
  }
  return { // 返回（区间比、012 路比、冷温热比写成三位数，例如 2:2:2 记作 222）
    sum,sumTail:sum%10,span:reds[k-1]-reds[0], // 和值、和尾、跨度
    ac:popcount(lo)+popcount(hi)-(k-1), // AC 值：不同差值的个数减（个数-1），越大号码越分散
    odd,big,prime,zoneMax:Math.max(z0,z1,z2),zones:z0*100+z1*10+z2, // 奇数、大号、质数个数，号码最多的区有几个、区间比
    road:r0*100+r1*10+r2,road0:r0,tails:popcount(tailMask),longest,repeat, // 012 路比、0 路个数、几种尾数、最长连号、重号个数
    hot:h,hwc:h*100+w*10+c, // 热号个数、冷温热比
    amp:prevSum==null?0:Math.abs(sum-prevSum),first:reds[0],last:reds[k-1], // 振幅（和值比上期变了多少）、首位、末位
  }
}
function ratio3(code){ // 三位数写成比例，例如 222 → 2:2:2
  return `${Math.floor(code/100)}:${Math.floor(code/10)%10}:${code%10}` // 百位、十位、个位
}
function classOf(last,t,M,cls){ // 第 t 期开奖前各号码的冷温热（走势图的常见划分：近 4 期出过是热号，遗漏 4～8 期是温号，更久是冷号）；返回热号个数
  let H=0;for(let n=1;n<=M;n++){const g=last[n]<0?99:t-1-last[n];cls[n]=g<=3?0:g<=8?1:2;if(!cls[n])H++}return H // 按遗漏期数分类
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
// ===== 独立性 =====
function independenceTests(ch,col,k,M,rand){ // 一种球的独立性检验：游程、间隔、二维序列、伴侣号；期望值都按每个号码的实际出现频率算（不受冷热号多少的影响），没有现成分布的用蒙特卡洛模拟校准（rand 是固定的序列，结果可以复现）
  const T=ch.length,W=M+1,fix=(M-1)/(M-k),real=new Uint8Array(T*k) // 期数、每期一行、不放回抽取的校正系数、真实开奖（平铺：第 t 期是 t*k 起的 k 个）
  ch.forEach((d,t)=>d[col].forEach((n,j)=>{real[t*k+j]=n})) // 平铺
  const prev=new Int8Array(W),runs=new Float64Array(W),ones=new Float64Array(W),stamp=new Int32Array(W) // 游程用：上一期状态、段数、开出次数、这一期的标记
  const runsStat=D=>{ // 游程检验：每个号码“开、没开”交替的段数和理论值的偏差（Wald-Wolfowitz，标准化后平方，再把所有号码加起来）
    prev.fill(-1);runs.fill(0);ones.fill(0);stamp.fill(0) // 清零
    for(let t=0;t<T;t++){for(let j=0;j<k;j++)stamp[D[t*k+j]]=t+1;for(let n=1;n<=M;n++){const c=stamp[n]===t+1?1:0;if(c!==prev[n])runs[n]++;prev[n]=c;ones[n]+=c}} // 数段数
    let s=0;for(let n=1;n<=M;n++){const n1=ones[n],n0=T-n1,mu=2*n1*n0/T+1,v=2*n1*n0*(2*n1*n0-T)/(T*T*(T-1));if(v>0)s+=(runs[n]-mu)**2/v}return s // 均值、方差
  }
  const O=new Float64Array(W*W),cnt=new Float64Array(W) // 伴侣号用：两两同出次数、每个号码的次数
  const pairStat=D=>{ // 伴侣号检验：同一期里每两个号码一起开出的次数，和按各自频率算的期望比
    O.fill(0);cnt.fill(0) // 清零
    for(let t=0;t<T;t++)for(let i=0;i<k;i++){const x=D[t*k+i];cnt[x]++;for(let j=0;j<i;j++){const y=D[t*k+j];O[x<y?x*W+y:y*W+x]++}} // 计数
    let sc=0,sq=0;for(let n=1;n<=M;n++){sc+=cnt[n];sq+=cnt[n]*cnt[n]}const pairs=T*k*(k-1)/2,norm=pairs/((sc*sc-sq)/2) // 总对数；期望 ∝ 两个号码各自的次数之积
    let s=0;for(let a=1;a<=M;a++)for(let b=a+1;b<=M;b++){const e=norm*cnt[a]*cnt[b];if(e>0)s+=(O[a*W+b]-e)**2/e}return s // 皮尔逊统计量
  }
  const gapP=(()=>{ // 间隔检验：两次开出之间隔了几期，和几何分布（按每个号码自己的开出率）比
    const bins=21,obs=new Float64Array(bins),exp=new Float64Array(bins),last=new Int32Array(W).fill(-1),gaps=new Float64Array(W),c=new Float64Array(W) // 0～19 期各一档、20 期以上一档
    for(let t=0;t<T;t++)for(let j=0;j<k;j++){const n=real[t*k+j];c[n]++;if(last[n]>=0){obs[Math.min(bins-1,t-last[n]-1)]++;gaps[n]++}last[n]=t} // 数间隔
    for(let n=1;n<=M;n++){const p=c[n]/T;for(let b=0;b<bins;b++)exp[b]+=gaps[n]*(b<bins-1?p*(1-p)**b:(1-p)**(bins-1))} // 期望
    let s=0;for(let b=0;b<bins;b++)if(exp[b]>0)s+=(obs[b]-exp[b])**2/exp[b];return chiP(s,bins-1) // 卡方拟合优度
  })()
  const serialP=(()=>{ // 二维序列检验：上一期开出 m、下一期开出 n 的次数，看两期之间有没有关联（列联表独立性检验）
    const C=new Float64Array(W*W),R=new Float64Array(W),Cn=new Float64Array(W);let N=0 // 计数、行和、列和、总数
    for(let t=1;t<T;t++)for(let i=0;i<k;i++)for(let j=0;j<k;j++){const m=real[(t-1)*k+i],n=real[t*k+j];C[m*W+n]++;R[m]++;Cn[n]++;N++} // 计数
    let s=0;for(let m=1;m<=M;m++)for(let n=1;n<=M;n++){const e=R[m]*Cn[n]/N;if(e>0)s+=(C[m*W+n]-e)**2/e}return chiP(s*fix*fix,(M-1)*(M-1)) // 两期都是不放回抽取，乘两次校正系数
  })()
  const pool=new Uint8Array(M),sim=new Uint8Array(T*k),rs=[],ps=[] // 抽号用的号码池、一套模拟开奖、模拟出的游程统计量、伴侣号统计量
  for(let s=0;s<DEEP.sims;s++){ // 每次模拟一整套“完全独立”的开奖
    for(let t=0;t<T;t++){for(let i=0;i<M;i++)pool[i]=i+1;for(let j=0;j<k;j++){const r=j+Math.floor(rand()*(M-j)),x=pool[r];pool[r]=pool[j];pool[j]=x;sim[t*k+j]=x}} // 每期不放回抽 k 个
    rs.push(runsStat(sim));if(k>=2)ps.push(pairStat(sim)) // 算统计量
  }
  const mv=a=>{const m=a.reduce((x,y)=>x+y,0)/a.length;return [m,a.reduce((x,y)=>x+(y-m)**2,0)/(a.length-1)]} // 平均值、方差
  return {runs:scaledChiP(runsStat(real),...mv(rs)),gap:gapP,serial:serialP,pair:k>=2?scaledChiP(pairStat(real),...mv(ps)):null} // 各项 p 值
}
function deepAnalyze({draws,rule}){ // 研究全部开奖：17 张走势图（常见范围、自相关检验）、开奖日期、独立性、下一期的冷温热、历史头奖
  const ch=draws.slice().reverse(),T=ch.length,[kr,Mr]=rule.red,[kb,Mb]=rule.blue,sumOf=v=>v.reduce((a,b)=>a+b,0) // 按时间从早到晚、期数、规则、求和
  const last=new Int32Array(Mr+1).fill(-1),cls=new Int8Array(Mr+1),prevSet=new Uint8Array(Mr+1),shapes=[],hotZ=[] // 每个号码上次开出的期、冷温热、上一期的红球、各期指标、热号命中的标准化偏差
  let hotDiff=0,hotVar=0 // 热号命中：实际比期望多几个的累计、方差累计
  for(let t=0;t<T;t++){ // 每一期
    const H=classOf(last,t,Mr,cls) // 开奖前的冷温热、热号个数
    if(t>=1){ // 从第 2 期起（重号、振幅要和上一期比）
      prevSet.fill(0);for(const n of ch[t-1][2])prevSet[n]=1 // 上一期的红球
      const x=shapeOf(ch[t][2],rule,prevSet,sumOf(ch[t-1][2]),cls);x.blue=sumOf(ch[t][3]);x.year=ch[t][1].slice(0,4);shapes.push(x) // 这一期的指标
      if(t>=10){const p=H/Mr,e=kr*p,v=kr*p*(1-p)*(Mr-kr)/(Mr-1);hotDiff+=x.hot-e;hotVar+=v;hotZ.push(v>0?(x.hot-e)/Math.sqrt(v):0)} // 热号个数和“热号有多少”决定的期望比（超几何分布）
    }
    for(const n of ch[t][2])last[n]=t // 记下开出的期
  }
  const nextCls=new Int8Array(Mr+1);classOf(last,T,Mr,nextCls) // 下一期开奖前的冷温热
  const charts=CHARTS.map(([key,name])=>({key,name,p:key==="amp"?null:ljungBox(key==="hwc"?hotZ:shapes.map(s=>s[key]),DEEP.lags)})) // 每张走势图的自相关检验（振幅由和值算出，相邻两期天然相关，不单独检验；冷温热用扣掉热号多少后的偏差）
  let cover=.85,limits=null,joint=0 // 每张图的覆盖率、常见范围、合起来覆盖的比例
  for(cover of [.85,.875,.9,.92,.94,.95,.96,.97,.975,.98,.985,.99,.993,.995,.997,1]){ // 从 85% 往上调，直到合起来覆盖历史上 80% 的开奖
    limits=limitsOf(shapes,cover);joint=shapes.filter(s=>fits(s,limits)).length/shapes.length // 各图的常见范围、合起来覆盖多少
    if(joint>=DEEP.cover) break // 够了
  }
  const mode=key=>{const c=new Map();shapes.forEach(s=>c.set(s[key],(c.get(s[key])||0)+1));return [...c.keys()].sort((a,b)=>c.get(b)-c.get(a)||(a<b?-1:1))[0]} // 最常见的取值
  const avg=v=>v.reduce((a,b)=>a+b,0)/v.length,byYear=new Map() // 平均值、各年的和值
  shapes.forEach(s=>{if(!byYear.has(s.year))byYear.set(s.year,[]);byYear.get(s.year).push(s.sum)}) // 按年分组
  const ys=[...byYear.values()].filter(v=>v.length>=50).map(avg) // 各年（至少 50 期）和值平均
  const rand=seededRandom(`${draws[0][0]}|${T}|independence`) // 蒙特卡洛模拟用的固定序列（由最新期号决定）
  const red=independenceTests(ch,2,kr,Mr,rand),blue=independenceTests(ch,3,kb,Mb,rand) // 独立性检验
  red.hot=hotVar>0?normP(hotDiff/Math.sqrt(hotVar)):1 // 热号命中检验（双侧）
  return { // 返回
    charts,limits,joint, // 自相关检验、常见范围、合起来的覆盖率
    sumAll:avg(shapes.map(s=>s.sum)),sumRecent:avg(shapes.slice(-DEEP.recent).map(s=>s.sum)),yearSums:[Math.min(...ys),Math.max(...ys)], // 和值：全部平均、近 30 期平均、各年平均的最小和最大
    oddMode:mode("odd"),bigMode:mode("big"),zoneMode:mode("zones"),hwcMode:mode("hwc"), // 最常见的奇数个数、大号个数、区间比、冷温热比
    dates:{red:dateTests(ch,2,kr,Mr),blue:dateTests(ch,3,kb,Mb)},indep:{red,blue}, // 开奖日期、独立性
    state:{cls:Array.from(nextCls),prev:[...draws[0][2]],prevSum:sumOf(draws[0][2])}, // 下一期开奖前的状态：冷温热、上一期红球、上一期和值
    jackpots:new Set(draws.map(d=>d[2].join(",")+"|"+d[3].join(","))), // 开出过的头奖组合
  }
}
// ===== 选号和自我检查 =====
function deepPickTask({rule,redMix,blueMix,limits,state,jackpots}){ // 选号（不用随机数）：枚举全部红球组合，去掉走势图上少见的形态，逐一算分，取得分最高的一注
  const [kr,Mr]=rule.red,[kb,Mb]=rule.blue,score=Array.from({length:Mr+1},(_,n)=>n?Math.log(redMix[n]*Mr/kr):0) // 规则、每个号码的分数（概率相对平均值的对数）
  const prevSet=new Uint8Array(Mr+1);state.prev.forEach(n=>prevSet[n]=1) // 上一期红球（重号走势图要用）
  const allow=SET_KEYS.map(key=>{const a=new Uint8Array(1000);limits[key].forEach(v=>{a[v]=1});return a}),lo=RANGE_KEYS.map(key=>limits[key][0]),hi=RANGE_KEYS.map(key=>limits[key][1]) // 常见范围换成查表（比逐个查集合快）
  const ok=x=>{for(let i=0;i<RANGE_KEYS.length;i++){const v=x[RANGE_KEYS[i]];if(v<lo[i]||v>hi[i])return false}for(let i=0;i<SET_KEYS.length;i++)if(!allow[i][x[SET_KEYS[i]]])return false;return true} // 和 fits 一样的判断
  const cur=new Array(kr);let valid=0,best=null,anyBest=null // 当前组合、形态常见的组合数、得分最高的一注、不筛时的最高分组合（万一全被筛掉时用）
  const walk=(start,depth,sc)=>{ // 逐个往组合里加号码（从小到大，得分一样时保留先看到的，结果固定）
    if(depth===kr){ // 凑够了
      if(!anyBest||sc>anyBest.score)anyBest={nums:cur.slice(),score:sc} // 不筛时的最高分
      if(!ok(shapeOf(cur,rule,prevSet,state.prevSum,state.cls)))return // 形态少见，去掉
      valid++ // 数一下
      if(!best||sc>best.score)best={nums:cur.slice(),score:sc} // 得分最高的
      return // 这一注看完了
    }
    for(let n=start;n<=Mr-(kr-depth)+1;n++){cur[depth]=n;walk(n+1,depth+1,sc+score[n])} // 依次尝试
  }
  walk(1,0,0) // 开始
  const chosen=best||anyBest // 万一全被筛掉，就不筛
  const byArray=(x,y)=>{for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return 0} // 两组号码按数字逐个比较（保证顺序固定）
  const blues=[],bc=[];const walkB=(s0,d,sc)=>{if(d===kb){blues.push({nums:bc.slice(),score:sc});return}for(let n=s0;n<=Mb-(kb-d)+1;n++){bc[d]=n;walkB(n+1,d+1,sc+Math.log(blueMix[n]*Mb/kb))}};walkB(1,0,0) // 蓝球的全部组合
  blues.sort((a,b)=>b.score-a.score||byArray(a.nums,b.nums)) // 按得分从高到低
  const b=blues.find(b=>!jackpots.has(chosen.nums.join(",")+"|"+b.nums.join(",")))||blues[0] // 得分最高、又不和这注红球凑成历史头奖的
  return {ticket:{red:chosen.nums,blue:b.nums},total:comb(Mr,kr),valid} // 结果和过程数据
}
function deepCheck(a,rule,ticket){ // 自我检查：逐项核对这一注
  const prevSet=new Uint8Array(rule.red[1]+1);a.state.prev.forEach(n=>prevSet[n]=1) // 上一期红球
  const x=shapeOf(ticket.red,rule,prevSet,a.state.prevSum,a.state.cls) // 这注红球的走势图指标
  const okNums=(v,[n,max])=>v.length===n&&v.every((y,i)=>y>=1&&y<=max&&(!i||y>v[i-1])) // 个数、范围、从小到大不重复
  const rules=okNums(ticket.red,rule.red)&&okNums(ticket.blue,rule.blue),shapes=fits(x,a.limits),jackpot=a.jackpots.has(ticket.red.join(",")+"|"+ticket.blue.join(",")) // 号码规则、走势图形态、历史头奖
  return {x,rules,shapes,jackpot,ok:rules&&shapes&&!jackpot} // 结果
}
function pad2(n){ // 号码补零成两位
  return String(n).padStart(2,"0") // 例如 7 → 07
}
// ===== 后台线程 =====
async function runDeepTaskHere(task,payload,onStep,sliceMs){ // 执行一项计算：analyze 研究全部开奖、pool 分析一种球、pick 选号
  if(task==="analyze") return deepAnalyze(payload) // 研究全部开奖
  if(task==="pool") return deepPool(payload.draws,payload.col,payload.k,payload.max,payload.zones,payload.nextDate,onStep,sliceMs) // 分析一种球
  return deepPickTask(payload) // 选号
}
let deepWorkerUrl=null // 后台线程的脚本地址（只生成一次）
function deepWorkerURL(){ // 把用到的函数拼成后台线程（Web Worker）的脚本：计算在后台跑，液体动画和思考过程的显示都不卡
  if(!deepWorkerUrl) deepWorkerUrl=URL.createObjectURL(new Blob([[ // 生成脚本地址
    ...Object.entries({NN,DEEP,LSTM,GBDT,PRIME_LIST,PRIME_MASK,SHRINK,CHARTS,RANGE_KEYS,SET_KEYS}).map(([name,value])=>`const ${name}=${JSON.stringify(value)}`), // 设置
    "const randomWord=new Uint32Array(1)", // 随机数缓冲区
    randomIntUnbiased,randomFloat,seededRandom,lnGamma,gammaQ,chiP,normP,scaledChiP,popcount,comb,sigmoid,zoneOf, // 工具函数
    nnTrainSpan,nnSamples,trainNet,nnWindow,pause,trainLSTM,trainGBDT,trainLogit,hmmFit,deepExperts,deepPool, // 专家和机器学习
    shapeOf,ratio3,classOf,ljungBox,commonSet,limitsOf,fits,dateTests,independenceTests,deepAnalyze,deepPickTask,runDeepTaskHere, // 走势图、检验、选号（直接用页面里同一份函数代码）
    `onmessage=async event=>{
  const {task,payload}=event.data
  const result=await runDeepTaskHere(task,payload,(stage,e,total,loss)=>{postMessage({progress:[stage,e,total,loss]})},1e9)
  postMessage({done:true,result})
}`, // 收到任务就算；训练时报告进度
  ].join("\n")],{type:"text/javascript"})) // 脚本类型
  return deepWorkerUrl // 返回地址
}
function runDeepTask(task,payload,onStep){ // 执行一项计算：优先放到后台线程，不支持时在主线程上分段算
  const onMainThread=()=>runDeepTaskHere(task,payload,onStep,12) // 在主线程上算（每 12 毫秒让一下）
  let worker // 后台线程
  try{ worker=new Worker(deepWorkerURL()) }catch(error){ return onMainThread() } // 创建不了就在主线程上算
  return new Promise((resolve,reject)=>{ // 等后台线程算完
    worker.onmessage=event=>{ // 收到后台线程的消息
      const d=event.data // 消息内容
      if(d.done){ worker.terminate(); resolve(d.result); return } // 算完：关掉线程，返回结果
      onStep(...d.progress) // 训练进度
    }
    worker.onerror=event=>{ // 后台线程出错（例如浏览器不允许）
      event.preventDefault() // 不在控制台报错
      worker.terminate() // 关掉线程
      onMainThread().then(resolve,reject) // 改在主线程上算
    }
    worker.postMessage({task,payload}) // 把任务交给后台线程
  })
}
async function generateDeep(){ // 深度思考：思考过程在下面的结果卡片里一段段“写”出来，想完在中间的卡片里给出按综合得分选出的一注
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
  const fmt=x=>x.toLocaleString("en-US") // 千位逗号
  const ratio=(x,k)=>`${x}:${k-x}` // 比例的写法，例如 3:3
  // 窗口里只写结论，说得简单；后台照样做完全部计算（17 张走势图、各项统计检验、八位专家、回测加权、枚举全部组合）
  try{ // 尝试
    const data=await loadHistory(type),draws=data.draws,latest=draws[0] // 读取开奖历史、全部开奖（新的在前）、最新一期
    const [kr,Mr]=rule.red,[kb,Mb]=rule.blue,half=M=>[[1,Math.floor(M/2)],[Math.floor(M/2)+1,M]] // 红球、蓝球的个数和范围；蓝球分成前后两区
    const nextDate=nextDrawDate(latest[1],rule.drawDays),next=new Date(nextDate+"T00:00:00Z") // 下一期预计的开奖日期
    const STAGES={"神经网络":0,"LSTM":NN.epochs,"梯度提升树":NN.epochs+LSTM.epochs,"逻辑回归":NN.epochs+LSTM.epochs+GBDT.rounds/10},STEPS=NN.epochs+LSTM.epochs+GBDT.rounds/10+1 // 四个模型依次训练：各自从第几步开始、一共几步
    let done=0,liveLine=null // 训练到第几步、显示进度的那一段
    const showStep=()=>{if(liveLine){const n=Math.round(done/STEPS*6);liveLine.textContent=`训练中 ${"■".repeat(n)}${"□".repeat(6-n)}`}} // 进度条（6 格）
    const analysisJob=runDeepTask("analyze",{draws,rule},()=>{}) // 研究全部开奖（后台线程，和下面写字同时进行）
    const redJob=runDeepTask("pool",{draws,col:2,k:kr,max:Mr,zones:rule.zones,nextDate},(s,e)=>{done=(STAGES[s]||0)+e;showStep()}) // 红球分析
    const blueJob=runDeepTask("pool",{draws,col:3,k:kb,max:Mb,zones:half(Mb),nextDate},()=>{}) // 蓝球分析
    const pickJob=Promise.all([analysisJob,redJob,blueJob]).then(([a,red,blue])=>runDeepTask("pick",{rule,redMix:red.mix,blueMix:blue.mix,limits:a.limits,state:a.state,jackpots:a.jackpots},()=>{})) // 选号：两种球都分析完就开始枚举全部组合（和写字同时进行）
    pickJob.catch(()=>{}) // 前面出错时由下面的 await 处理，这里不重复报“未处理的错误”
    await write("思路",`为${rule.name}选 1 注。先把全部开奖从头到尾复盘一遍，再请八位专家各自打分，用最近 ${DEEP.window} 期考一考谁更准，最后从所有组合里挑出综合得分最高的一注。`)
    await write("数据",`共 ${fmt(draws.length)} 期（${draws[draws.length-1][1]} 至 ${latest[1]}），最新第 ${latest[0]} 期：红 ${nums(latest[2])}，蓝 ${nums(latest[3])}。下一期预计 ${next.getUTCMonth()+1} 月 ${next.getUTCDate()} 日（${WEEKDAYS[next.getUTCDay()]}）开奖。`)
    const a=await analysisJob // 等全部开奖研究完
    const tested=a.charts.filter(c=>c.p!==null),trend=tested.filter(c=>c.p<.05/tested.length) // 做了自相关检验的走势图、校正后有显著自相关的
    const dr=a.dates.red,db=a.dates.blue,ir=a.indep.red,ib=a.indep.blue // 开奖日期、独立性的检验
    const dates=[["红球星期",dr.weekday],["红球月份",dr.month],["红球年份",dr.year],["红球整体",dr.uniform],["蓝球星期",db.weekday],["蓝球月份",db.month],["蓝球年份",db.year],["蓝球整体",db.uniform]],dateSig=dates.filter(([,p])=>p<.05/dates.length) // 8 项日期检验、校正后显著的
    const drift=dr.year<.05/dates.length,driftOnly=dateSig.every(([name])=>name==="红球年份"||name==="红球整体") // 红球随年份漂移；显著的是不是只有年份漂移带来的两项
    const indep=[["游程",ir.runs],["间隔",ir.gap],["上期对下期",ir.serial],["伴侣号",ir.pair],["热号",ir.hot],["蓝球游程",ib.runs],["蓝球间隔",ib.gap],["蓝球上期对下期",ib.serial],...(ib.pair===null?[]:[["蓝球伴侣号",ib.pair]])],indSig=indep.filter(([,p])=>p<.05/indep.length) // 独立性检验、校正后显著的
    await write("第一步｜看走势",`${CHARTS.length} 张走势图逐期看过：和值平均 ${Math.round(a.sumAll)}，最常见奇偶 ${ratio(a.oddMode,kr)}、大小 ${ratio(a.bigMode,kr)}、区间 ${ratio3(a.zoneMode)}。${trend.length?drift?`和值这些年整体在变（各年平均 ${Math.round(a.yearSums[0])}～${Math.round(a.yearSums[1])}），早年的规律不一定适用现在。`:`${trend.map(c=>c.name).join("、")}有点规律，交给专家去验证。`:""}近期偏高偏低不代表下期会怎样，所以不追走势，只去掉历史上少见的形态。`)
    const dateLine=!dateSig.length?"开奖日期（星期、月份、年份）和号码无关":drift&&driftOnly?"星期、月份和号码无关，只有早年和近年的号码分布不太一样":`开奖日期方面，${dateSig.map(([name])=>name).join("、")}有些不一样` // 日期的结论
    const indLine=!indSig.length?"上一期不影响下一期，同一期也没有固定搭配的“伴侣号”，热号也不会更容易出":`${indSig.map(([name])=>name).join("、")}有些异常，交给专家去验证` // 独立性的结论
    await write("第二步｜找规律",`${dateLine}；${indLine}。${dateSig.length||indSig.length?"":"每个号码的机会都一样。"}`)
    await write("第三步｜专家打分","八位专家各管一个角度：冷热、遗漏、关联、分组、日期、时序、杀号、机器学习。每位手里有好几种方法，先用更早的开奖比一比，只用最准的那种。")
    liveLine=await write("机器学习","","live") // 训练进度这一段
    showStep() // 先显示当前进度
    const red=await redJob // 等红球分析完成
    liveLine.textContent="训练完成，同样的数据每次结果都一样。" // 完成
    liveLine.parentNode.classList.remove("live") // 不再是进度
    const experts=red.models.filter(m=>m.key!=="uniform"),t=red.test,kill=red.kill // 八位专家、最好的专家和均衡基准的比较、杀号公式
    const votes={};experts.filter(m=>m.key!=="group"&&m.key!=="kill").forEach(m=>m.top.forEach(n=>{votes[n]=(votes[n]||0)+1})) // 每个号码被几位专家看好（各自前 3 名；分组专家只看组、杀号专家只看淡号码，不参加）
    const consensus=Object.keys(votes).map(Number).filter(n=>votes[n]>=3).sort((x,y)=>votes[y]-votes[x]||x-y) // 被三位以上专家同时看好的号码
    await write("第四步｜考一考",`用最近 ${DEEP.window} 期逐期考试，每期只用之前的数据。${t.rel>0?`成绩最好的是${t.name}，但只比“每个号码机会均等”好一点点${t.p<.05?"，算是有点真本事":"，算不上真本事"}；`:"没有一位专家比“每个号码机会均等”考得好；"}杀号公式${kill.max-kill.base<.01?"也不比随便排除一个号准":"也只准一点点"}。${consensus.length?`看好 ${list(consensus)} 的专家最多。`:"专家们的看法很分散。"}`)
    const blue=await blueJob // 等蓝球分析完成
    const ranked=[...red.models].sort((x,y)=>y.weight-x.weight) // 发言权从高到低
    await write("第五步｜综合打分",`按考试成绩分配发言权，差距小就不拉开：${ranked.slice(0,3).map(m=>`${m.key==="uniform"?"机会均等":m.name.replace("专家","")} ${pct(m.weight)}`).join("、")} 排在前面，八位专家的意见合成每个号码的最终分数。`)
    const pick=await pickJob,ticket=pick.ticket // 综合选号的结果（后台线程）
    await write("第六步｜综合选号",`把全部 ${fmt(pick.total)} 种红球组合逐一算分，去掉历史上少见的形态，取得分最高的一注：红 ${nums(ticket.red)}，蓝 ${nums(ticket.blue)}。`)
    const check=deepCheck(a,rule,ticket) // 自我检查
    await write("第七步｜自我检查",check.ok?"号码规则、走势图形态、历史头奖都核对过，全部通过。":`有一项没通过：${[!check.rules&&"号码规则",!check.shapes&&"走势图形态",check.jackpot&&"历史头奖"].filter(Boolean).join("、")}。`)
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
