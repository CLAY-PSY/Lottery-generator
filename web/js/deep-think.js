// 深度思考：一次给出两注，思考过程逐段写出
// 方案 A（冷热）：看全部开奖记录，画出每个号码的冷热走势，看好哪个号就留哪个号。
// 冷热怎么算：每个号码看近 10 期、近 30 期、近 100 期和全部历史各出现几次，各自和平均水平比（1 是平均），按 4:3:2:1 加权，越近的分量越重；
// 分数最高的就是最热的号。分数一样时，遗漏期数少的（最近出过的）更热，再一样时号码小的在前。
// 方案 B（八位专家）：冷热、遗漏、关联、分组、日期、时序、杀号、机器学习八位专家各自给下一期每个号码打分，不考试、不加权，八位的分数直接平均，
//    平均分最高的号留下。每位专家手里有几种方法，先用最近 300 期比一比，只用最准的那种（连参数、向平均值收缩的比例一起挑）；
//    机器学习专家是神经网络、LSTM、梯度提升树、逻辑回归四个模型的平均，用全部开奖训练。计算放在后台线程，和写字同时进行。
// 全程不用随机数：模型的起点由彩种和最新期号决定，同样的开奖数据，每次结果完全一样，开出新一期才会变
const HOT={windows:[10,30,100,0],weights:[4,3,2,1]} // 看哪几段：近 10 期、近 30 期、近 100 期、全部历史（0 表示全部）；各段的分量
const DEEP={window:0,tune:300} // 方案 B：不考试（不留最近的开奖做回测，window 为 0）；每位专家用最近 300 期挑方法
const NN={features:15,hidden:16,epochs:6,train:1100,valid:0} // 神经网络设置：每个号码 15 项特征、隐藏层 16 个神经元、训练 6 轮、用最近 1100 期训练（不留回测）
const LSTM={steps:8,hidden:6,epochs:2,train:300,lr:.01} // LSTM 设置：看前 8 期、6 个记忆单元、训练 2 轮、用最近 300 期训练、学习率
const GBDT={rounds:30,depth:3,bins:32,lr:.1,lambda:1,minHess:5,train:700} // 梯度提升树设置：30 棵树、每棵 3 层、特征分 32 档、学习率、L2 正则、叶子最少的样本权重、用最近 700 期训练
const SHRINK=[0,.3,.6,.85] // 专家的概率向平均值收缩的比例（每位专家自己挑；噪声大的收缩多）
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
// ===== 方案 B：八位专家 =====
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
function sigmoid(z){ // 把任意实数变成 0～1 的概率
  return 1/(1+Math.exp(-z)) // logistic 函数
}
function zoneOf(zones,n){ // 号码 n 在第几个区（从 0 数）
  return zones.findIndex(([lo,hi])=>n>=lo&&n<=hi) // 落在哪个区间
}
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
async function trainNet(s,onEpoch,sliceMs,rand){ // 训练一个小型神经网络：15 个输入 → 16 个神经元（tanh）→ 1 个输出（这个号码这一期开出的概率）；在主线程上每算 sliceMs 毫秒让一下；rand（固定序列）决定起点和样本顺序
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
function nnWindow(net,s){ // 机器学习模型：下一期每个号码的概率（每期归一化到开出个数；不留回测，所以只有下一期）
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
  const start=T-s.train-s.valid,from=Math.max(start,T-s.valid-LSTM.train),order=[] // 和神经网络同一段；只用最近 300 期训练
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
  const rows=s.valid+1,out=new Float64Array(rows*M) // 下一期（不留回测）
  for(let r=0;r<rows;r++){let sum=0;const t=T-s.valid+r;for(let n=1;n<=M;n++){out[r*M+n-1]=forward(t,n);sum+=out[r*M+n-1]}for(let n=0;n<M;n++)out[r*M+n]=Math.min(.999,Math.max(1e-4,out[r*M+n]*k/sum))} // 每期归一化到开出个数
  return {P:out,loss} // 概率、最后一轮的误差
}
async function trainGBDT(s,onStep,sliceMs){ // 梯度提升树（XGBoost 的做法）：40 棵 3 层的决策树，一棵棵修正前面的误差；特征分档后用直方图找最佳切分
  const F=NN.features,X=s.X,nT=s.nTrain,rows=X.length/F,B=GBDT.bins,lam=GBDT.lambda // 特征数、特征、训练样本数、全部样本数、分档数、L2 正则
  const t0=Math.max(0,s.train-GBDT.train)*s.max,idx0=Int32Array.from({length:nT-t0},(_,i)=>t0+i),nU=idx0.length // 只用最近 700 期训练（样本序号、个数）
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
function deepExperts(ch,col,k,M,zones,nextDate){ // 逐期往前走，每期只用它之前的数据，给最近 300 期（挑方法用）和下一期（t=T）的每个号码估概率；有参数的专家按这 300 期的损失挑方法和参数
  const T=ch.length,start=T-DEEP.window,from=Math.max(60,start-DEEP.tune),rows=T-from+1,u=k/M,W=M+1,B=41 // 总期数、下一期的位置（不留回测）、挑方法的起点、要估的期数、平均概率、每期一行、遗漏分组（0～40+）
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
  const off=(start-from)*M,base=1-u,accs=KILLS.map((f,i)=>kOk[i]/kT[i]) // 下一期从第几个数开始；不算也能杀对的比例、各杀号公式的历史准确率
  return { // 结果
    start, // 下一期的位置
    experts:[["hot","冷热专家",["freq","hotwarm","revert","holt"]],["miss","遗漏专家",["gap","cycle","hmm"]],["link","关联专家",["markov","neighbor","position"]],["group","分组专家",["tail","road","zone"]],["date","日期专家",["weekday","season"]],["series","时序专家",["grey","spectrum","analog"]],["kill","杀号专家",["kill"]]].map(([key,name,methods])=>{ // 七位专家，每位手里有几种方法
      let bm=null,bv=null,bi=0,bl=Infinity // 调参期损失最小的方法、参数版本、收缩比例
      for(const e of list) if(methods.includes(e.key)) for(const v of e.variants) v.loss.forEach((l,i)=>{if(l<bl){bl=l;bm=e;bv=v;bi=i}}) // 方法 × 参数 × 收缩比例一起比
      const c=SHRINK[bi];return {key,name,method:bm.key,methodName:bm.name,P:bv.P.slice(off).map(p=>(1-c)*p+c*u)} // 只留下一期
    }),
    kill:{min:Math.min(...accs),max:Math.max(...accs),base,count:KILLS.length,next:[...new Set(KILLS.map(f=>killOf(f,T)))].sort((a,b)=>a-b)}, // 杀号公式：准确率范围、不算也能杀对的比例、公式个数、这次杀的号
  }
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
async function deepPool(draws,col,k,M,zones,nextDate,onStep,sliceMs){ // 方案 B 的一种球（红球或蓝球）：八位专家各自给下一期每个号码打分，不考试、不加权，直接平均
  const ch=draws.slice().reverse(),seed=`${draws[0][0]}|${draws.length}|${col}|${k}|${M}` // 按时间从早到晚、固定起点用的文字
  const E=deepExperts(ch,col,k,M,zones,nextDate) // 七位专家（十九种统计、时间序列、形态识别方法）
  const s=nnSamples(draws,col,k,M,zones,nextDate) // 机器学习的样本（全部用来训练）
  const net=await trainNet(s,(e,loss)=>onStep("神经网络",e,NN.epochs,loss),sliceMs,seededRandom(seed)) // 神经网络：起点由最新期号等固定下来，同样的数据每次训练出同样的网络
  const lstm=await trainLSTM(draws,col,k,M,s,onStep,sliceMs,seededRandom(seed+"|lstm")) // LSTM
  const gbdt=await trainGBDT(s,onStep,sliceMs) // 梯度提升树
  const logit=await trainLogit(s,onStep,sliceMs) // 逻辑回归
  const ml=[nnWindow(net,s),lstm.P,nnWindow(gbdt,s),nnWindow(logit,s)] // 四个模型对下一期每个号码的概率
  const experts=[...E.experts,{key:"ml",name:"机器学习专家",methodName:"四个模型平均",P:Array.from({length:M},(_,i)=>ml.reduce((a,P)=>a+P[i],0)/ml.length)}] // 八位专家
  const mix=Array.from({length:M+1},(_,n)=>n?experts.reduce((a,e)=>a+e.P[n-1],0)/experts.length:0) // 八位的分数直接平均
  return {mix,experts:experts.map(e=>({key:e.key,name:e.name,methodName:e.methodName,top:Array.from(e.P,(p,i)=>[i+1,p]).sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,3).map(([n])=>n)}))} // 平均分、每位专家最看好的 3 个号码
}
async function runDeepTaskHere(task,payload,onStep,sliceMs){ // 执行一项计算（现在只有 pool：方案 B 的一种球）
  return deepPool(payload.draws,payload.col,payload.k,payload.max,payload.zones,payload.nextDate,onStep,sliceMs) // 方案 B
}
let deepWorkerUrl=null // 后台线程的脚本地址（只生成一次）
function deepWorkerURL(){ // 把方案 B 用到的函数拼成后台线程（Web Worker）的脚本：计算在后台跑，液体动画和思考过程的显示都不卡
  if(!deepWorkerUrl) deepWorkerUrl=URL.createObjectURL(new Blob([[ // 生成脚本地址
    ...Object.entries({DEEP,NN,LSTM,GBDT,SHRINK}).map(([name,value])=>`const ${name}=${JSON.stringify(value)}`), // 设置
    seededRandom,sigmoid,zoneOf,nnTrainSpan,nnSamples,trainNet,nnWindow,pause,trainLSTM,trainGBDT,trainLogit,hmmFit,deepExperts,deepPool,runDeepTaskHere, // 直接用页面里同一份函数代码
    `onmessage=async event=>{
  const {task,payload}=event.data
  const result=await runDeepTaskHere(task,payload,()=>{},1e9)
  postMessage({done:true,result})
}`, // 收到任务就算，算完把结果发回来
  ].join("\n")],{type:"text/javascript"})) // 脚本类型
  return deepWorkerUrl // 返回地址
}
async function generateDeep(){ // 深度思考：思考过程在下面的结果卡片里一段段“写”出来，想完在中间的卡片里给出 A、B 两注
  if(isRolling) return // 正在生成就忽略
  const type=getType(),rule=DEEP_RULES[type] // 开始时的彩种和规则
  isRolling=true // 标记为生成中
  showPickGhosts(true) // A、B 两注的位置：空球呼吸，表示正在想
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
    const [kr,Mr]=rule.red,[kb,Mb]=rule.blue,half=M=>[[1,Math.floor(M/2)],[Math.floor(M/2)+1,M]] // 红球、蓝球的个数和范围；蓝球分成前后两区（区间专家用）
    const nextDate=nextDrawDate(latest[1],rule.drawDays),next=new Date(nextDate+"T00:00:00Z") // 下一期预计的开奖日期
    const redJob=runDeepTask("pool",{draws,col:2,k:kr,max:Mr,zones:rule.zones,nextDate},()=>{}) // 方案 B 的红球（后台线程，和下面写字同时进行）
    const blueJob=runDeepTask("pool",{draws,col:3,k:kb,max:Mb,zones:half(Mb),nextDate},()=>{}) // 方案 B 的蓝球
    redJob.catch(()=>{});blueJob.catch(()=>{}) // 出错时由下面的 await 处理，这里不重复报“未处理的错误”
    const jackpots=new Set(draws.map(d=>d[2].join(",")+"|"+d[3].join(","))) // 开过的头奖组合
    const ticketOf=(redRank,blueRank)=>{ // 从最看好到最不看好排好的号码里取一注；万一和开过的头奖一模一样，最后一个蓝球换成下一个
      const reds=redRank.slice(0,kr).sort((a,b)=>a-b);let blues=blueRank.slice(0,kb),swapped=null // 红球、蓝球、换掉的蓝球
      const key=()=>reds.join(",")+"|"+[...blues].sort((a,b)=>a-b).join(",") // 这一注的写法（和头奖记录一样的格式）
      for(let i=kb;jackpots.has(key())&&i<blueRank.length;i++){swapped=swapped||blues[kb-1];blues=[...blueRank.slice(0,kb-1),blueRank[i]]} // 换蓝球
      return {red:reds,blue:blues.sort((a,b)=>a-b),swapped,jackpot:jackpots.has(key())} // 这一注
    }
    const okNums=(v,[n,max])=>v.length===n&&v.every((y,i)=>y>=1&&y<=max&&(!i||y>v[i-1])) // 个数、范围、从小到大不重复
    // 方案 A：冷热
    const red=hotColdOf(draws,2,kr,Mr),blue=hotColdOf(draws,3,kb,Mb) // 红球、蓝球从热到冷
    const A=ticketOf(red.map(s=>s.n),blue.map(s=>s.n)) // 最热的一注
    const count=c=>red.filter(s=>s.cls===c).length,coldest=red.reduce((x,y)=>y.gap>x.gap?y:x) // 红球各类的个数、遗漏最久的红球
    await write("思路",`为${rule.name}选 2 注：方案 A 看全部开奖记录的冷热走势，看好哪个号就留哪个号；方案 B 请八位专家各自打分，平均后留下最被看好的号。`)
    await write("数据",`共 ${fmt(T)} 期（${draws[T-1][1]} 至 ${latest[1]}），最新第 ${latest[0]} 期：红 ${nums(latest[2])}，蓝 ${nums(latest[3])}。下一期预计 ${next.getUTCMonth()+1} 月 ${next.getUTCDate()} 日（${WEEKDAYS[next.getUTCDay()]}）开奖。`)
    await write("方案 A｜看冷热走势",`每个号码都看近 10 期、近 30 期、近 100 期和全部 ${fmt(T)} 期各出现几次，越近的分量越重。红球现在热号 ${count("热")} 个、温号 ${count("温")} 个、冷号 ${count("冷")} 个：最热的 ${pad2(red[0].n)} 近 10 期出了 ${red[0].counts[0]} 次，最冷的 ${pad2(coldest.n)} 已经 ${coldest.gap} 期没出。蓝球最热的是 ${list(blue.slice(0,kb).map(s=>s.n))}。`)
    await write("方案 A｜推荐选号",`看好最热的号，就留下它们：红 ${nums(A.red)}，蓝 ${nums(A.blue)}。`)
    // 方案 B：八位专家
    await write("方案 B｜专家打分",`八位专家各管一个角度：冷热、遗漏、关联、分组、日期、时序、杀号、机器学习。每位先用最近 ${DEEP.tune} 期比一比，只用自己最准的方法给每个号码打分；不考试、不加权，八位的分数直接平均。`)
    const [rb,bb]=await Promise.all([redJob,blueJob]) // 等方案 B 算完（不显示进度）
    const rank=mix=>Array.from({length:mix.length-1},(_,i)=>i+1).sort((x,y)=>mix[y]-mix[x]||x-y) // 号码按平均分从高到低（一样时号码小的在前）
    const B=ticketOf(rank(rb.mix),rank(bb.mix)) // 平均分最高的一注
    const votes={};rb.experts.filter(e=>e.key!=="group"&&e.key!=="kill").forEach(e=>e.top.forEach(n=>{votes[n]=(votes[n]||0)+1})) // 每个号码被几位专家看好（各自前 3 名；分组专家只看组、杀号专家只看淡号码，不参加）
    const consensus=Object.keys(votes).map(Number).filter(n=>votes[n]>=3).sort((x,y)=>votes[y]-votes[x]||x-y) // 被三位以上专家同时看好的号码
    await write("方案 B｜推荐选号",`看好平均分最高的号，就留下它们：红 ${nums(B.red)}，蓝 ${nums(B.blue)}。${consensus.length?`其中 ${list(consensus)} 被三位以上专家同时看好。`:""}`)
    const ok=[A,B].every(t=>okNums(t.red,rule.red)&&okNums(t.blue,rule.blue)&&!t.jackpot) // 自我检查
    const notes=[["A",A],["B",B]].filter(([,t])=>t.swapped).map(([name,t])=>`方案 ${name} 原来那注和开过的头奖一样，蓝球 ${pad2(t.swapped)} 换成了下一个`) // 换过蓝球的说明
    await write("自我检查",ok?`两注的号码个数和范围都正确，没有重复${notes.length?`；${notes.join("；")}`:"，也都不是开过的头奖组合"}，全部通过。`:"有一项没通过，请再试一次。")
    title.textContent="已深度思考" // 标题改成已完成（不显示用时）
    resultInner.classList.add("deep-done") // 想完了（思考过程留在窗口里，可以上下滑动回看）
    showPick([{tag:"A",red:A.red,blue:A.blue},{tag:"B",red:B.red,blue:B.blue}]) // 中间的卡片填上 A、B 两注
  }catch(error){ // 读取或计算出错
    console.warn("深度思考失败:",error) // 在控制台记录
    showPickGhosts(false) // 号码的位置恢复成空球
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
