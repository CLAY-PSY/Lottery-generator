// 深度思考：读取开奖历史，四位专家打分、回测、加权，精确计算一注，思考过程逐段写出
// ===== 深度思考：多专家 + 回测 + 贝叶斯加权 + 候选优化 + 自我检查，过程像推理模型一样实时显示 =====
// 开奖是独立随机事件，任何号码组合的中奖概率都一样，历史统计不能提高中奖概率。这里按严谨的预测流程来做，并如实显示结论：
// 1. 四位“专家”各自给下一期每个号码估概率：频率（按时间衰减加权，半衰期用回测前的数据调参）、遗漏（历史上同样遗漏时的开出率）、
//    转移（上一期开出某号后，下一期各号的开出率）、神经网络（现场训练）
// 2. 回测：最近 200 期逐期检验（每期只用它之前的数据），算各专家的对数损失和命中
// 3. 贝叶斯模型平均（按缓和系数降温）：把“均衡基准”（每个号码机会均等）也当作一个模型，按回测损失算各模型的后验权重，混合成最终概率（没本事的专家自然拿不到权重）
// 4. 选号：取最被看好的 20 个红球，枚举全部组合，去掉少见形态，按得分从高到低依次选 5 注（两两共用红球不超过上限、每个红球最多用 2 次）
// 5. 自我检查：号码规则、形态、重合、历史头奖逐项核对
// 全程不用随机数：神经网络的起点由彩种和最新期号决定，选号按得分排序。同样的开奖数据，每次点击结果完全一样，开出新一期才会变
const DEEP={window:200,tune:300,pool:20,temper:5} // 深度思考设置：回测最近 200 期、调参用回测前的 300 期、从最被看好的 20 个红球里选号、权重的缓和系数
const NN={features:10,hidden:16,epochs:6,train:1100,valid:200} // 神经网络设置：每个号码 10 项特征、隐藏层 16 个神经元、训练 6 轮、用 1100 期训练、最近 200 期留作回测（和其他专家同一段）
const historyCache={} // 已读取的开奖历史：彩种 → 数据
async function loadHistory(type){ // 读取开奖历史（data/ssq.json、data/dlt.json，每期：[期号, 日期, 红球, 蓝球]，新的在前）
  if(historyCache[type]) return historyCache[type] // 读过就直接用
  const response=await fetch(`data/${type}.json`,{cache:"no-cache"}) // 向服务器确认最新版本
  if(!response.ok) throw new Error(`HTTP ${response.status}`) // 读取失败
  const data=await response.json() // 解析 JSON
  if(!Array.isArray(data.draws)||data.draws.length<50) throw new Error("数据不完整") // 数据太少
  historyCache[type]=data // 缓存
  return data // 返回
}
function randomFloat(){ // [0,1) 内的随机小数（用加密随机数）
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
function nnTrainSpan(total){ // 训练用几期：最多 1100 期，前面至少留 100 期用来算特征
  return Math.max(100,Math.min(NN.train,total-NN.valid-100)) // 期数
}
function nnSamples(draws,col,k,max){ // 把开奖历史整理成样本：每一期的每个号码一个样本（10 项特征 → 这一期有没有开出）
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
  const rows=(T-start+1)*max // 样本数：训练 + 验证 + 最后一组（下一期，用来预测）
  const X=new Float32Array(rows*F) // 特征
  const Y=new Uint8Array(rows) // 答案：这一期开出了就是 1
  const last=new Int32Array(W).fill(-1) // 每个号码最近一次开出的期
  for(let t=0;t<=T;t++){ // 每一期（t=T 是还没开奖的下一期）
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
      X[o+7]=t>=1&&ch[t-1][col].includes(n)?1:0 // 上一期开出过
      X[o+8]=t>=2&&ch[t-2][col].includes(n)?1:0 // 上上期开出过
      X[o+9]=(n-1)/(max-1) // 号码本身的大小
      Y[r]=t<T&&ch[t][col].includes(n)?1:0 // 这一期有没有开出
    }
    if(t<T) for(const n of ch[t][col]) last[n]=t // 记下最近开出的期
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
async function trainNet(s,onEpoch,sliceMs=12,rand=randomFloat){ // 训练一个小型神经网络：10 个输入 → 16 个神经元（tanh）→ 1 个输出（这个号码这一期开出的概率）；在主线程上每算 sliceMs 毫秒让一下；rand 决定起点和样本顺序
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
function deepExperts(ch,col,k,M){ // 三位统计专家：逐期往前走，每期只用它之前的数据，给第 start～T 期（T 是下一期）的每个号码估概率
  const T=ch.length,start=T-DEEP.window,rows=T-start+1,u=k/M // 总期数、回测起点、要估的期数、平均概率
  const HL=[8,16,32,64,128,256],decay=HL.map(h=>Math.pow(.5,1/h)) // 频率专家的候选半衰期（期）和对应的衰减系数
  const S=HL.map(()=>new Float64Array(M+1)),tuneLoss=HL.map(()=>0) // 各半衰期下每个号码的衰减计数、调参期的损失
  const freq=HL.map(()=>new Float64Array(rows*M)),gap=new Float64Array(rows*M),markov=new Float64Array(rows*M) // 各专家的概率
  const last=new Int32Array(M+1).fill(-1),B=41,trials=new Float64Array(B),hits=new Float64Array(B) // 遗漏专家：每个号码上次开出的期；按遗漏期数（0～40+）统计的次数和开出数
  const C=Array.from({length:M+1},()=>new Float64Array(M+1)),occ=new Float64Array(M+1) // 转移专家：上期开出 m、下期开出 n 的次数；m 开出的次数
  const norm=raw=>{let sum=0;for(let n=1;n<=M;n++)sum+=raw[n];const p=new Float64Array(M+1);for(let n=1;n<=M;n++)p[n]=Math.min(.999,Math.max(1e-4,raw[n]*k/sum));return p} // 归一化：各号概率之和等于每期开出个数
  const bucket=(t,n)=>Math.min(B-1,last[n]<0?B-1:t-1-last[n]) // 第 t 期时号码 n 的遗漏期数（40 以上归一组）
  for(let t=0;t<=T;t++){ // 每一期
    const y=new Uint8Array(M+1) // 这期开出的号码
    if(t<T) for(const n of ch[t][col]) y[n]=1 // t=T 是还没开奖的下一期
    if(t>=Math.max(1,start-DEEP.tune)){ // 从调参期开始估
      HL.forEach((h,i)=>{ // 频率专家：每个候选半衰期
        const raw=new Float64Array(M+1);for(let n=1;n<=M;n++)raw[n]=S[i][n]+.5 // 衰减计数（加一点平滑）
        const p=norm(raw) // 概率
        if(t<start){for(let n=1;n<=M;n++)tuneLoss[i]-=Math.log(y[n]?p[n]:1-p[n])} // 调参期：累计损失
        else for(let n=1;n<=M;n++)freq[i][(t-start)*M+n-1]=p[n] // 回测期和下一期：记下概率
      })
      if(t>=start){ // 回测期和下一期
        const g=new Float64Array(M+1),mk=new Float64Array(M+1),prev=ch[t-1][col] // 遗漏、转移的原始分；上一期的号码
        for(let n=1;n<=M;n++){ // 每个号码
          const b=bucket(t,n);g[n]=(hits[b]+20*u)/(trials[b]+20) // 遗漏专家：同样遗漏期数时的历史开出率（向平均值平滑）
          let sum=0;for(const m of prev)sum+=(C[m][n]+20*u)/(occ[m]+20);mk[n]=sum/prev.length // 转移专家：上期每个号码之后 n 的开出率，取平均
        }
        const pg=norm(g),pm=norm(mk) // 归一化
        for(let n=1;n<=M;n++){gap[(t-start)*M+n-1]=pg[n];markov[(t-start)*M+n-1]=pm[n]} // 记下
      }
    }
    if(t===T) break // 下一期还没开奖，到此为止
    for(let n=1;n<=M;n++){const b=bucket(t,n);trials[b]++;hits[b]+=y[n]} // 用这期结果更新遗漏统计
    if(t>=1) for(const m of ch[t-1][col]){occ[m]++;for(let n=1;n<=M;n++)C[m][n]+=y[n]} // 更新转移统计
    HL.forEach((h,i)=>{for(let n=1;n<=M;n++)S[i][n]=S[i][n]*decay[i]+y[n]}) // 更新衰减计数
    for(const n of ch[t][col]) last[n]=t // 记下开出的期
  }
  const best=tuneLoss.indexOf(Math.min(...tuneLoss)) // 调参期损失最小的半衰期
  return {start,rows,halfLife:HL[best],freq:freq[best],gap,markov} // 结果
}
function nnWindow(net,s){ // 神经网络专家：回测期和下一期每个号码的概率（每期归一化到开出个数）
  const rows=s.valid+1,M=s.max,P=new Float64Array(rows*M) // 期数、号码数、结果
  for(let r=0;r<rows;r++){ // 每一期
    let sum=0;for(let n=0;n<M;n++){P[r*M+n]=net.forward(s.nTrain+r*M+n);sum+=P[r*M+n]} // 网络给的概率
    for(let n=0;n<M;n++)P[r*M+n]=Math.min(.999,Math.max(1e-4,P[r*M+n]*s.k/sum)) // 归一化
  }
  return P // 结果
}
async function deepPool(draws,col,k,M,onEpoch,sliceMs){ // 一种球（红球或蓝球）的完整分析：专家打分、回测、贝叶斯加权
  const ch=draws.slice().reverse(),T=ch.length,u=k/M // 按时间从早到晚、总期数、平均概率
  const E=deepExperts(ch,col,k,M) // 三位统计专家
  const s=nnSamples(draws,col,k,M) // 神经网络的样本（最近 200 期留作回测）
  const net=await trainNet(s,onEpoch,sliceMs,seededRandom(`${draws[0][0]}|${draws.length}|${col}|${k}|${M}`)) // 训练：起点由最新期号等固定下来，同样的数据每次训练出同样的网络
  const models=[{key:"uniform",name:"均衡基准",P:null},{key:"freq",name:"频率专家",P:E.freq},{key:"gap",name:"遗漏专家",P:E.gap},{key:"markov",name:"转移专家",P:E.markov},{key:"nn",name:"神经网络",P:nnWindow(net,s)}] // 参与评比的模型
  const prob=(m,r,n)=>m.P?m.P[r*M+n-1]:u // 模型 m 给第 start+r 期号码 n 的概率
  for(const m of models){ // 回测每个模型
    let loss=0,hit=0 // 对数损失、命中
    for(let r=0;r<DEEP.window;r++){ // 回测期的每一期
      const y=new Set(ch[E.start+r][col]),order=[] // 真实开出的号码
      for(let n=1;n<=M;n++){const p=prob(m,r,n);loss-=Math.log(y.has(n)?p:1-p);order.push([n,p])} // 累计损失
      order.sort((a,b)=>b[1]-a[1]);for(let q=0;q<k;q++)if(y.has(order[q][0]))hit++ // 前 k 名里开出了几个
    }
    m.loss=loss;m.hits=m.P?hit/DEEP.window:k*k/M // 均衡基准（每个号码机会均等）的命中按期望值算
    m.next=Array.from({length:M+1},(_,n)=>n?prob(m,DEEP.window,n):0) // 对下一期的看法
    m.top=m.P?m.next.map((p,n)=>[n,p]).slice(1).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n])=>n):[] // 最看好的 3 个号码
    delete m.P // 不再需要
  }
  const base=models[0].loss,minLoss=Math.min(...models.map(m=>m.loss)) // 均衡基准的损失、最小损失
  // 贝叶斯模型平均：权重 ∝ 回测似然（各模型先验相同）。200 期的成绩偶然性很大，按缓和系数 5 降温（power posterior），差距很小时权重不拉得太开
  let z=0;for(const m of models){m.w=Math.exp(-(m.loss-minLoss)/DEEP.temper);z+=m.w} // 未归一化的权重
  for(const m of models){m.weight=m.w/z;m.gain=base-m.loss;delete m.w} // 归一化；gain>0 表示比均衡基准好
  const mix=Array.from({length:M+1},(_,n)=>n?models.reduce((sum,m)=>sum+m.weight*m.next[n],0):0) // 混合后的下一期概率
  return {models,mix,halfLife:E.halfLife,nnLoss:net.loss,window:DEEP.window,span:s.train+s.valid} // 结果
}
let deepWorkerUrl=null // 后台线程的脚本地址（只生成一次）
function deepWorkerURL(){ // 把分析用到的函数拼成后台线程（Web Worker）的脚本：计算在后台跑，液体动画和思考过程的显示都不卡
  if(!deepWorkerUrl) deepWorkerUrl=URL.createObjectURL(new Blob([[ // 生成脚本地址
    `const NN=${JSON.stringify(NN)}`,`const DEEP=${JSON.stringify(DEEP)}`, // 设置
    "const randomWord=new Uint32Array(1)", // 随机数缓冲区
    randomIntUnbiased,randomFloat,seededRandom,nnTrainSpan,nnSamples,trainNet,deepExperts,nnWindow,deepPool, // 直接用页面里同一份函数代码
    `onmessage=async event=>{
  const {draws,col,k,max}=event.data
  const result=await deepPool(draws,col,k,max,(epoch,loss)=>{postMessage({epoch,loss})},1e9)
  postMessage({done:true,result})
}`, // 收到开奖数据就分析；每训练完一轮报告进度
  ].join("\n")],{type:"text/javascript"})) // 脚本类型
  return deepWorkerUrl // 返回地址
}
function runDeepPool(draws,col,k,max,onEpoch){ // 分析一种球：优先放到后台线程，不支持时在主线程上分段算
  const onMainThread=()=>deepPool(draws,col,k,max,onEpoch,12) // 在主线程上算（每 12 毫秒让一下）
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
    worker.postMessage({draws,col,k,max}) // 把开奖数据交给后台线程
  })
}
function commonSet(values){ // 历史上最常见的取值，合计占到 85% 为止
  const counts={} // 每个取值出现的次数
  values.forEach(v=>{counts[v]=(counts[v]||0)+1}) // 计数
  const order=Object.keys(counts).map(Number).sort((a,b)=>counts[b]-counts[a]) // 按次数从多到少
  const keep=new Set() // 保留的取值
  let covered=0 // 已覆盖的期数
  for(const v of order){ // 从最常见的开始
    keep.add(v) // 保留
    covered+=counts[v] // 累计
    if(covered>=values.length*.85) break // 覆盖 85% 就够了
  }
  return keep // 返回
}
function shapeOf(reds,rule){ // 一注红球的形态：和值、奇数个数、大号个数、每区个数、最长连号
  const half=rule.red[1]/2 // 大小分界：大于一半的算大号
  let run=1,longest=1 // 当前连号长度、最长连号长度
  for(let i=1;i<reds.length;i++){ // 逐个比较相邻号码
    run=reds[i]===reds[i-1]+1?run+1:1 // 连着就加一，否则重新算
    longest=Math.max(longest,run) // 记下最长
  }
  return { // 返回
    sum:reds.reduce((a,b)=>a+b,0), // 和值
    odd:reds.filter(n=>n%2).length, // 奇数个数
    big:reds.filter(n=>n>half).length, // 大号个数
    zoneMax:Math.max(...rule.zones.map(([lo,hi])=>reds.filter(n=>n>=lo&&n<=hi).length)), // 号码最多的那个区有几个
    longest, // 最长连号
  }
}
function analyze(type,data){ // 分析开奖历史，得到加权和筛选条件
  const rule=DEEP_RULES[type] // 规则
  const draws=data.draws // 全部开奖（新的在前）
  const shapes=draws.map(d=>shapeOf(d[2],rule)) // 每期红球的形态
  const sums=shapes.map(x=>x.sum).sort((a,b)=>a-b) // 和值从小到大
  const pct=q=>sums[Math.floor((sums.length-1)*q)] // 百分位数
  const zoneLimit=Math.max(...commonSet(shapes.map(x=>x.zoneMax))) // 历史 85% 的开奖里，单区最多几个号
  const runLimit=Math.max(...commonSet(shapes.map(x=>x.longest))) // 历史 85% 的开奖里，最长连号
  return { // 返回
    rule,draws, // 规则、开奖
    sumRange:[pct(.1),pct(.9)], // 历史 80% 的开奖落在这个和值范围里
    oddSet:commonSet(shapes.map(x=>x.odd)), // 常见的奇数个数
    bigSet:commonSet(shapes.map(x=>x.big)), // 常见的大号个数
    zoneLimit,runLimit, // 单区上限、连号上限
    jackpots:new Set(draws.map(d=>d[2].join(",")+"|"+d[3].join(","))), // 开出过的头奖组合
  }
}
function fitsHistory(reds,a){ // 这注红球的形态是不是历史上常见的
  const x=shapeOf(reds,a.rule) // 形态
  return x.sum>=a.sumRange[0]&&x.sum<=a.sumRange[1]&&a.oddSet.has(x.odd)&&a.bigSet.has(x.big)&&x.zoneMax<=a.zoneLimit&&x.longest<=a.runLimit // 和值、奇偶、大小、区间、连号都在常见范围内
}
function deepPick(a,red,blue,count){ // 选号（不用随机数）：从最被看好的红球里枚举全部组合，去掉少见形态，按得分从高到低依次选出彼此不太像的 count 注
  const R=a.rule,[kr,Mr]=R.red,[kb,Mb]=R.blue // 规则：红球、蓝球的个数和范围
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
  const list=all.filter(c=>fitsHistory(c.nums,a)) // 去掉少见形态
  const penalty=Math.max(.02,(list[0].score-list[Math.min(list.length,400)-1].score)/4) // 号码重复使用的扣分（按得分的分布定）
  const chosen=[],uses=new Array(Mr+1).fill(0) // 选中的、每个红球已用了几次
  const allowed=c=>!chosen.includes(c)&&c.nums.every(n=>uses[n]<2)&&chosen.every(t=>t.nums.filter(n=>c.nums.includes(n)).length<=R.maxShare) // 没选过、每个红球最多用 2 次、和已选的共用红球不超过上限
  while(chosen.length<count){ // 依次选
    let best=null,bestScore=-Infinity // 这一轮最好的
    for(const c of list){ // 从高分往低分看
      if(!allowed(c)) continue // 不符合规矩
      const adjusted=c.score-penalty*c.nums.reduce((sum,n)=>sum+uses[n],0) // 用过的号码再用要扣分：尽量多覆盖不同号码
      if(adjusted>bestScore){best=c;bestScore=adjusted} // 更好就换（一样时保留先看到的，结果固定）
    }
    best=best||list.find(c=>!chosen.includes(c)) // 实在没有合适的就放宽
    chosen.push(best) // 选中
    best.nums.forEach(n=>uses[n]++) // 记下用过的红球
  }
  const blueSets=combos(Array.from({length:Mb},(_,i)=>i+1),kb,n=>Math.log(blue.mix[n]*Mb/kb)) // 蓝球的全部组合，按得分从高到低
  const usedBlue=new Set() // 已用过的蓝球
  const tickets=chosen.map(c=>{ // 给每注配蓝球
    const fine=blueSets.filter(b=>!a.jackpots.has(c.nums.join(",")+"|"+b.nums.join(","))) // 不和这注红球凑成历史头奖
    const b=fine.find(b=>b.nums.every(n=>!usedBlue.has(n)))||fine[0] // 优先选得分最高、又没用过的
    b.nums.forEach(n=>usedBlue.add(n)) // 记下
    return {red:c.nums,blue:b.nums} // 这一注
  })
  return {tickets,pool:top.length,total:all.length,valid:list.length} // 结果和过程数据
}
function deepCheck(a,tickets){ // 自我检查：逐项核对 5 注号码
  const R=a.rule,reds=new Set(),blues=new Set(),sums=[] // 规则、覆盖的红球、蓝球、和值
  let maxShare=0,rules=true,shapes=true,jackpots=0 // 最大共用红球数、号码规则、形态、历史头奖
  const uses={} // 每个红球用了几次
  const okNums=(v,[n,max])=>v.length===n&&v.every((x,i)=>x>=1&&x<=max&&(!i||x>v[i-1])) // 个数、范围、从小到大不重复
  tickets.forEach((t,i)=>{ // 每一注
    t.red.forEach(n=>{reds.add(n);uses[n]=(uses[n]||0)+1});t.blue.forEach(n=>blues.add(n));sums.push(t.red.reduce((x,y)=>x+y,0)) // 统计
    if(!okNums(t.red,R.red)||!okNums(t.blue,R.blue)) rules=false // 号码规则
    if(!fitsHistory(t.red,a)) shapes=false // 形态
    if(a.jackpots.has(t.red.join(",")+"|"+t.blue.join(","))) jackpots++ // 历史头奖
    tickets.slice(0,i).forEach(o=>{maxShare=Math.max(maxShare,o.red.filter(n=>t.red.includes(n)).length)}) // 两两共用的红球
  })
  const maxUse=Math.max(...Object.values(uses)) // 单个红球最多用了几次
  return {reds:reds.size,blues:blues.size,sumMin:Math.min(...sums),sumMax:Math.max(...sums),maxShare,maxUse,rules,shapes,jackpots,ok:rules&&shapes&&!jackpots&&maxShare<=R.maxShare&&maxUse<=2} // 结果
}
function pad2(n){ // 号码补零成两位
  return String(n).padStart(2,"0") // 例如 7 → 07
}
function topBy(arr,count,desc){ // 按数值取前几个号码（desc=true 取最大的）
  return arr.map((v,n)=>[n,v]).filter(([n])=>n>0).sort((x,y)=>desc?y[1]-x[1]:x[1]-y[1]).slice(0,count) // [号码, 数值]
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
  const fade=()=>{ // 上面还有内容就让顶部渐隐，下面还有内容就让底部渐隐
    log.classList.toggle("fade-top",log.scrollTop>1) // 往下滚过
    log.classList.toggle("fade-bottom",log.scrollTop+log.clientHeight<log.scrollHeight-1) // 还没滚到底
  }
  const follow=()=>{log.scrollTop=log.scrollHeight;fade()} // 滚到最新一行，并更新上下渐隐
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
  try{ // 尝试
    const data=await loadHistory(type) // 读取开奖历史
    const a=analyze(type,data),draws=a.draws,latest=draws[0] // 形态统计、全部开奖（新的在前）、最新一期
    const [kr,Mr]=rule.red,[kb,Mb]=rule.blue // 红球、蓝球的个数和范围
    let epoch=0,epochLoss=0,liveLine=null // 神经网络的训练进度、显示进度的那一段
    const showEpoch=()=>{if(liveLine) liveLine.textContent=`正在学习近 ${(nnTrainSpan(draws.length)+NN.valid).toLocaleString()} 期 ${"■".repeat(epoch)}${"□".repeat(NN.epochs-epoch)} 误差 ${epoch?epochLoss.toFixed(4):"…"}`} // 更新进度
    const redJob=runDeepPool(draws,2,kr,Mr,(e,loss)=>{epoch=e;epochLoss=loss;showEpoch()}) // 红球分析（后台线程，和下面写字同时进行）
    const blueJob=runDeepPool(draws,3,kb,Mb,()=>{}) // 蓝球分析
    await write("思路",`为${rule.name}精确计算 1 注。先请四位专家给号码打分，用最近 ${DEEP.window} 期检验谁比平均水平强、就多听谁的，再从上万种组合里算出得分最高的一注并自我检查。结论只由开奖数据决定：数据不变，结论就不变，开出新一期才会更新。`)
    await write("数据",`共 ${draws.length.toLocaleString()} 期（${draws[draws.length-1][1]} 至 ${latest[1]}），最新第 ${latest[0]} 期：红 ${nums(latest[2])}，蓝 ${nums(latest[3])}。`)
    await write("第一步｜专家打分",`频率专家看谁出现得多（越近越重要）；遗漏专家看谁多久没出；转移专家看上期号码之后常跟着出谁；神经网络从 ${NN.features} 项特征里自己学。`)
    liveLine=await write("神经网络","","live") // 训练进度这一段
    showEpoch() // 先显示当前进度
    const red=await redJob // 等红球分析完成
    liveLine.textContent=`学完了（${NN.epochs} 轮，误差 ${red.nnLoss.toFixed(4)}；训练起点由第 ${latest[0]} 期固定，结果可以复现）。` // 完成
    liveLine.parentNode.classList.remove("live") // 不再是进度
    const M=key=>red.models.find(m=>m.key===key) // 按名字找模型
    const experts=["freq","gap","markov","nn"].map(M) // 四位专家
    const votes={};experts.forEach(m=>m.top.forEach(n=>{votes[n]=(votes[n]||0)+1})) // 每个号码被几位专家看好（前 3 名）
    const consensus=Object.keys(votes).map(Number).filter(n=>votes[n]>=2).sort((x,y)=>votes[y]-votes[x]||x-y) // 被两位以上专家同时看好的号码
    await write("各自看好",`频率 ${nums(M("freq").top)}｜遗漏 ${nums(M("gap").top)}｜转移 ${nums(M("markov").top)}｜神经网络 ${nums(M("nn").top)}。${consensus.length?`其中 ${list(consensus)} 被两位以上专家同时看好。`:"四位专家的意见各不相同。"}`)
    await write("第二步｜回测",`用最近 ${DEEP.window} 期逐期考试，每期只用它之前的数据，不偷看答案。前 ${kr} 名平均猜中：频率 ${M("freq").hits.toFixed(2)}、遗漏 ${M("gap").hits.toFixed(2)}、转移 ${M("markov").hits.toFixed(2)}、神经网络 ${M("nn").hits.toFixed(2)}；平均水平（每个号码机会均等）是 ${M("uniform").hits.toFixed(2)}。`)
    const blue=await blueJob // 等蓝球分析完成
    const best=experts.reduce((x,y)=>y.gain>x.gain?y:x) // 回测最好的专家
    const ranked=[...red.models].sort((x,y)=>y.weight-x.weight).map(m=>`${m.name} ${pct(m.weight)}`).join("、") // 发言权从高到低
    const blueTop=[...blue.models].sort((x,y)=>y.weight-x.weight)[0] // 蓝球发言权最高的
    await write("第三步｜分配权重",`${best.gain>1?`${best.name}略好于平均水平，但优势很小，不能全信。`:"四位专家都没有明显超过平均水平：开奖本身没有规律可循，历史上的“冷热”多半是巧合。"}所以按考试成绩分配发言权，成绩差距小就不拉开太多：${ranked}（“均衡基准”就是每个号码机会均等）。蓝球里${blueTop.name}的发言权最高（${pct(blueTop.weight)}）。`)
    const pick=deepPick(a,red,blue,1),ticket=pick.tickets[0] // 精确计算：形态常见的组合里得分最高的一注
    const inPick=consensus.filter(n=>ticket.red.includes(n)) // 多位专家共同看好、并且在这一注里的号码
    await write("第四步｜精确计算",`按加权后的分数取前 ${pick.pool} 个红球，列出全部 ${pick.total.toLocaleString()} 种组合，去掉和值、奇偶、大小、分区、连号少见的，剩 ${pick.valid.toLocaleString()} 种，逐一算分，取得分最高的一注：红 ${nums(ticket.red)}。蓝球取分数最高、又不和这注红球凑成历史头奖的：${nums(ticket.blue)}。${!consensus.length?"":inPick.length?`多位专家看好的 ${list(inPick)} 在这一注里。`:"多位专家看好的号码因为分数或形态限制，没有进入这一注。"}`)
    const check=deepCheck(a,pick.tickets) // 自我检查
    await write("第五步｜自我检查",check.ok // 检查通过
      ?`号码个数和范围正确；和值 ${check.sumMin}（常见范围 ${a.sumRange[0]}～${a.sumRange[1]}）；奇偶、大小、分区、连号都在常见范围；不是历史头奖组合。全部通过，给出结果。`
      :`有一项没通过（${[!check.rules&&"号码规则",!check.shapes&&"形态",check.jackpots&&"历史头奖"].filter(Boolean).join("、")}），结果仅供参考。`)
    title.textContent="已深度思考" // 标题改成已完成（不显示用时）
    log.onscroll=fade // 手动滚动时更新上下渐隐
    resultInner.classList.add("deep-done") // 想完了（思考过程留在窗口里，可以上下滑动回看）
    showPick(ticket) // 中间的卡片填上这一注
    resultMode="deep" // 结果来自深度思考
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
