// 深度思考：照 GitHub 上星标最多的彩票预测项目 zepen/predict_Lottery_ticket（AI 彩票号码预测，约 1.1k 星）的模型来算；思考过程逐段写出
// 原项目的做法（config.py、modeling.py、run_train_model.py），这里按同样的结构和参数用 JavaScript 重写，在浏览器后台线程里训练：
//   样本：窗口 3 期，用前 3 期的号码（新的一期在前）预测下一期；号码减 1 当成类别
//   红球（LstmWithCRFModel）：嵌入层（号码数 × 32）→ 每个位置一个 LSTM(32) 看前 3 期 → 一个 LSTM(32) 把各位置串成序列 → 全连接（号码数）→ CRF（学号码之间的转移矩阵），
//     损失是 CRF 负对数似然，预测用维特比解码
//   蓝球：双色球（SignalLstmModel）嵌入层 16×32 → 三层 LSTM(32)（最后一层循环 dropout 0.2）→ softmax 16 类，交叉熵损失，取概率最高的号；
//     大乐透和红球一样用 LSTM + CRF（2 个位置、12 类）
//   训练：Adam（学习率 0.001，β1 0.9，β2 0.999，ε 1e-8），每批 1 个样本，1 轮；初始化和 Keras 默认一样（Glorot 均匀、循环权重正交、遗忘门偏置 1）
// 和原项目不同的地方：原项目用前 70% 的开奖训练、后 30% 测试；这里按时间顺序把全部开奖逐期“先预测、再学习”，全部历史都学一遍，每期也都当了一次测试；
//   维特比解码万一出现重复的红球，改取不重复的路径里得分最高的一条（原项目没有处理）
// 初始化和 dropout 用固定种子：同样的开奖数据，每次结果完全一样，开出新一期才会变
const WEEKDAYS=["周日","周一","周二","周三","周四","周五","周六"] // 星期的写法（getUTCDay 的 0～6）
const historyCache={} // 上次读到的开奖历史：彩种 → 数据（联网失败时用）
async function loadHistory(type){ // 读取开奖历史（data/ssq.json、data/dlt.json，每期：[期号, 日期, 红球, 蓝球]，新的在前）：每次都向服务器确认最新版本，页面一直开着也能用上新开奖
  try{ // 先联网取
    const response=await fetch(`data/${type}.json`,{cache:"no-cache"}) // 向服务器确认最新版本（没变时服务器只回“没变”，很快）
    if(!response.ok) throw new Error(`HTTP ${response.status}`) // 读取失败
    const data=await response.json() // 解析 JSON
    if(!Array.isArray(data.draws)||data.draws.length<200) throw new Error("数据不完整") // 至少要有 200 期（逐期学习要有足够的样本）
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
function lottoNet(job){ // 一种球的模型：按时间顺序逐期先预测、再学习全部开奖，最后预测下一期（在后台线程里运行，不能用外面的变量）
  const {seqs,kind,S,C,seed}=job // 每期这种球的号码（从早到晚，从小到大）、模型（crf：LSTM + CRF；lstm3：三层 LSTM）、每期几个号、号码总数、固定种子
  const E=32,H=32,G=4*H,WIN=3,LR=.001,B1=.9,B2=.999,EPS=1e-8 // 嵌入 32 维、LSTM 32 维、四个门、窗口 3 期、Adam 的参数（和原项目一样）
  let st=seed>>>0;const rnd=()=>{st=(st+0x6D2B79F5)>>>0;let t=st;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296} // 固定种子的数列（mulberry32）：初始化和 dropout 用
  const nrm=()=>{let u=0;while(u===0)u=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*rnd())} // 标准正态（Box–Muller，正交初始化用）
  const P=[] // 全部参数（Adam 逐个更新）
  const param=(n,init)=>{const w=new Float64Array(n);if(init)init(w);const p={w,g:new Float64Array(n),m:new Float64Array(n),v:new Float64Array(n)};P.push(p);return p} // 一组参数：值、梯度、Adam 的一阶和二阶矩
  const glorot=(fi,fo)=>w=>{const l=Math.sqrt(6/(fi+fo));for(let i=0;i<w.length;i++)w[i]=(rnd()*2-1)*l} // Glorot 均匀初始化（Keras 默认）
  const orth=w=>{const A=Array.from({length:H},()=>Float64Array.from({length:G},nrm)) // 循环权重的正交初始化（Keras 默认）：正态矩阵做 Gram–Schmidt 正交化
    for(let j=0;j<H;j++){for(let k=0;k<j;k++){let d=0;for(let i=0;i<G;i++)d+=A[j][i]*A[k][i];for(let i=0;i<G;i++)A[j][i]-=d*A[k][i]}let n=0;for(let i=0;i<G;i++)n+=A[j][i]*A[j][i];n=Math.sqrt(n);for(let i=0;i<G;i++)A[j][i]/=n}
    for(let j=0;j<H;j++)for(let i=0;i<G;i++)w[j*G+i]=A[j][i]}
  const ZH=new Float64Array(H) // 全 0 的初始状态
  const lstm=(I,T)=>({I,T,W:param(I*G,glorot(I,G)),U:param(H*G,orth),b:param(G,w=>{for(let i=H;i<2*H;i++)w[i]=1}), // 一层 LSTM：输入权重、循环权重、偏置（遗忘门偏置 1）
    X:new Float64Array(T*I),HM:new Float64Array(T*H),GA:new Float64Array(T*G),TC:new Float64Array(T*H),HO:new Float64Array(T*H),CO:new Float64Array(T*H), // 每步的输入、（dropout 后的）上一步输出、门、tanh(c)、输出、细胞状态
    DH:new Float64Array(T*H),DX:new Float64Array(T*I),dz:new Float64Array(G),dhn:new Float64Array(H),dcn:new Float64Array(H)}) // 反向传播用的缓冲
  function fwd(L,mask){const {I,T,X,HM,GA,TC,HO,CO}=L,W=L.W.w,U=L.U.w,b=L.b.w // LSTM 前向：门的顺序 i、f、c、o（和 Keras 一样）
    for(let t=0;t<T;t++){const z=GA.subarray(t*G,t*G+G);z.set(b);const xo=t*I,ho=t*H,hp=t?HO.subarray((t-1)*H,t*H):ZH,cp=t?CO.subarray((t-1)*H,t*H):ZH
      for(let i=0;i<I;i++){const xi=X[xo+i],o=i*G;for(let j=0;j<G;j++)z[j]+=xi*W[o+j]} // x·W
      for(let i=0;i<H;i++){const hi=mask?hp[i]*mask[i]:hp[i];HM[ho+i]=hi;const o=i*G;for(let j=0;j<G;j++)z[j]+=hi*U[o+j]} // h·U（循环 dropout 只作用在这里）
      for(let k=0;k<H;k++){const ig=1/(1+Math.exp(-z[k])),fg=1/(1+Math.exp(-z[H+k])),gg=Math.tanh(z[2*H+k]),og=1/(1+Math.exp(-z[3*H+k])) // 输入门、遗忘门、候选值、输出门
        z[k]=ig;z[H+k]=fg;z[2*H+k]=gg;z[3*H+k]=og;const c=fg*cp[k]+ig*gg,tc=Math.tanh(c);CO[ho+k]=c;TC[ho+k]=tc;HO[ho+k]=og*tc}}} // c = f·c' + i·g，h = o·tanh(c)
  function bwd(L,mask){const {I,T,X,HM,GA,TC,CO,DH,DX,dz,dhn,dcn}=L,W=L.W.w,U=L.U.w,gW=L.W.g,gU=L.U.g,gb=L.b.g;dhn.fill(0);dcn.fill(0) // LSTM 反向（沿时间反向传播）：DH 是每步输出的梯度，算出每步输入的梯度 DX，并累加参数梯度
    for(let t=T-1;t>=0;t--){const go=t*G,ho=t*H,xo=t*I,cp=t?CO.subarray((t-1)*H,t*H):ZH
      for(let k=0;k<H;k++){const d=DH[ho+k]+dhn[k],ig=GA[go+k],fg=GA[go+H+k],gg=GA[go+2*H+k],og=GA[go+3*H+k],tc=TC[ho+k],dc=dcn[k]+d*og*(1-tc*tc)
        dz[3*H+k]=d*tc*og*(1-og);dz[k]=dc*gg*ig*(1-ig);dz[H+k]=dc*cp[k]*fg*(1-fg);dz[2*H+k]=dc*ig*(1-gg*gg);dcn[k]=dc*fg}
      for(let j=0;j<G;j++)gb[j]+=dz[j]
      for(let i=0;i<I;i++){const xi=X[xo+i],o=i*G;let s=0;for(let j=0;j<G;j++){s+=W[o+j]*dz[j];gW[o+j]+=xi*dz[j]}DX[xo+i]=s}
      for(let i=0;i<H;i++){const hi=HM[ho+i],o=i*G;let s=0;for(let j=0;j<G;j++){s+=U[o+j]*dz[j];gU[o+j]+=hi*dz[j]}dhn[i]=mask?s*mask[i]:s}}}
  const emb=param(C*E,w=>{for(let i=0;i<w.length;i++)w[i]=(rnd()*2-1)*.05}) // 嵌入层（Keras 默认均匀 ±0.05）
  let slots,top,l1,l2,l3,trans // 各层
  if(kind==='crf'){slots=Array.from({length:S},()=>lstm(E,WIN));top=lstm(H,S)}else{l1=lstm(E,WIN);l2=lstm(H,WIN);l3=lstm(H,WIN)} // LSTM + CRF：每个位置一个 LSTM，再一个跨位置的 LSTM；三层 LSTM
  const DW=param(H*C,glorot(H,C)),DB=param(C) // 全连接层
  if(kind==='crf')trans=param(C*C,glorot(C,C)) // CRF 转移矩阵
  const nParams=P.reduce((a,p)=>a+p.w.length,0) // 参数个数
  const SS=kind==='crf'?S:1,u=new Float64Array(SS*C),du=new Float64Array(SS*C),al=new Float64Array(S*C),be=new Float64Array(S*C),eu=new Float64Array(S*C),eA=new Float64Array(C*C),zs=new Float64Array(S) // 每个位置每个号码的分、梯度，CRF 前向后向的缓冲
  function dense(h,ho,uo){for(let c=0;c<C;c++)u[uo+c]=DB.w[c];for(let i=0;i<H;i++){const hi=h[ho+i],o=i*C;for(let c=0;c<C;c++)u[uo+c]+=hi*DW.w[o+c]}} // 全连接前向
  function denseB(h,ho,uo,out,oo){for(let c=0;c<C;c++)DB.g[c]+=du[uo+c];for(let i=0;i<H;i++){const hi=h[ho+i],o=i*C;let s=0;for(let c=0;c<C;c++){s+=DW.w[o+c]*du[uo+c];DW.g[o+c]+=hi*du[uo+c]}out[oo+i]=s}} // 全连接反向
  const vd=new Float64Array(C),vn=new Float64Array(C),vb=new Int32Array(S*C) // 维特比的缓冲
  function viterbi(){const A=trans.w;for(let c=0;c<C;c++)vd[c]=u[c] // 维特比解码（原项目的 crf_decode）
    for(let s=1;s<S;s++){for(let c=0;c<C;c++){let best=-Infinity,bi=0;for(let i=0;i<C;i++){const v=vd[i]+A[i*C+c];if(v>best){best=v;bi=i}}vn[c]=best+u[s*C+c];vb[s*C+c]=bi}vd.set(vn)}
    let c=0;for(let i=1;i<C;i++)if(vd[i]>vd[c])c=i;const path=new Array(S);path[S-1]=c;for(let s=S-1;s>0;s--){c=vb[s*C+c];path[s-1]=c}return path}
  function uniquePaths(){const A=trans.w;let beams=[{s:0,p:[]}] // 不重复号码的路径：束搜索（宽 512），按 CRF 得分从高到低
    for(let s=0;s<S;s++){const nb=[];for(const b of beams)for(let c=0;c<C;c++){if(b.p.includes(c))continue;nb.push({s:b.s+u[s*C+c]+(s?A[b.p[s-1]*C+c]:0),p:[...b.p,c]})}nb.sort((x,y)=>y.s-x.s);beams=nb.slice(0,512)}
    return beams.slice(0,6).map(b=>b.p)}
  let mask=null;const MK=new Float64Array(H) // 循环 dropout 的遮罩
  function forward(inp,train){ // 前向：inp 是前 3 期（新的在前），每期 S 个号码（从 0 起）
    if(kind==='crf'){
      for(let s=0;s<S;s++){const L=slots[s];for(let t=0;t<WIN;t++)L.X.set(emb.w.subarray(inp[t][s]*E,inp[t][s]*E+E),t*E);fwd(L,null);top.X.set(L.HO.subarray((WIN-1)*H,WIN*H),s*H)} // 每个位置的 LSTM 看前 3 期，取最后的输出
      fwd(top,null);for(let s=0;s<S;s++)dense(top.HO,s*H,s*C)} // 跨位置的 LSTM，再接全连接
    else{for(let t=0;t<WIN;t++)l1.X.set(emb.w.subarray(inp[t][0]*E,inp[t][0]*E+E),t*E);fwd(l1,null);l2.X.set(l1.HO);fwd(l2,null);l3.X.set(l2.HO) // 三层 LSTM
      if(train){for(let i=0;i<H;i++)MK[i]=rnd()<.2?0:1/.8;mask=MK}else mask=null // 训练时最后一层用循环 dropout 0.2
      fwd(l3,mask);dense(l3.HO,(WIN-1)*H,0)}}
  function backward(inp,target){ // 反向：算损失，梯度累加到各参数
    if(kind==='crf'){const A=trans.w;let amax=-Infinity;for(let i=0;i<C*C;i++)if(A[i]>amax)amax=A[i];for(let i=0;i<C*C;i++)eA[i]=Math.exp(A[i]-amax) // CRF：缩放的前向后向算法
      let logZ=(S-1)*amax
      for(let s=0;s<S;s++){let mu=-Infinity;for(let c=0;c<C;c++)if(u[s*C+c]>mu)mu=u[s*C+c];for(let c=0;c<C;c++)eu[s*C+c]=Math.exp(u[s*C+c]-mu);logZ+=mu}
      let z=0;for(let c=0;c<C;c++){al[c]=eu[c];z+=al[c]}for(let c=0;c<C;c++)al[c]/=z;zs[0]=z;logZ+=Math.log(z)
      for(let s=1;s<S;s++){z=0;for(let c=0;c<C;c++){let v=0;for(let i=0;i<C;i++)v+=al[(s-1)*C+i]*eA[i*C+c];v*=eu[s*C+c];al[s*C+c]=v;z+=v}for(let c=0;c<C;c++)al[s*C+c]/=z;zs[s]=z;logZ+=Math.log(z)}
      for(let c=0;c<C;c++)be[(S-1)*C+c]=1
      for(let s=S-2;s>=0;s--)for(let i=0;i<C;i++){let v=0;for(let c=0;c<C;c++)v+=eA[i*C+c]*eu[(s+1)*C+c]*be[(s+1)*C+c];be[s*C+i]=v/zs[s+1]}
      let gold=0;for(let s=0;s<S;s++){gold+=u[s*C+target[s]];if(s)gold+=A[target[s-1]*C+target[s]]} // 真实号码序列的得分
      for(let s=0;s<S;s++)for(let c=0;c<C;c++)du[s*C+c]=al[s*C+c]*be[s*C+c]-(c===target[s]?1:0) // 每个位置的梯度 = 边缘概率 − 真实
      for(let s=1;s<S;s++){const k=1/zs[s];for(let i=0;i<C;i++){const a=al[(s-1)*C+i]*k;for(let c=0;c<C;c++)trans.g[i*C+c]+=a*eA[i*C+c]*eu[s*C+c]*be[s*C+c]}trans.g[target[s-1]*C+target[s]]-=1} // 转移矩阵的梯度
      top.DH.fill(0);for(let s=0;s<S;s++)denseB(top.HO,s*H,s*C,top.DH,s*H);bwd(top,null)
      for(let s=0;s<S;s++){const L=slots[s];L.DH.fill(0);L.DH.set(top.DX.subarray(s*H,s*H+H),(WIN-1)*H);bwd(L,null);for(let t=0;t<WIN;t++){const o=inp[t][s]*E;for(let k=0;k<E;k++)emb.g[o+k]+=L.DX[t*E+k]}}
      return logZ-gold} // 负对数似然
    let m=-Infinity;for(let c=0;c<C;c++)if(u[c]>m)m=u[c];let sum=0;for(let c=0;c<C;c++){du[c]=Math.exp(u[c]-m);sum+=du[c]}for(let c=0;c<C;c++)du[c]/=sum // softmax
    const loss=-Math.log(du[target[0]]);du[target[0]]-=1 // 交叉熵
    l3.DH.fill(0);denseB(l3.HO,(WIN-1)*H,0,l3.DH,(WIN-1)*H);bwd(l3,mask);l2.DH.set(l3.DX);bwd(l2,null);l1.DH.set(l2.DX);bwd(l1,null)
    for(let t=0;t<WIN;t++){const o=inp[t][0]*E;for(let k=0;k<E;k++)emb.g[o+k]+=l1.DX[t*E+k]}
    return loss}
  const order=()=>Array.from({length:C},(_,c)=>c).sort((a,b)=>u[b]-u[a]||a-b) // 三层 LSTM：号码按概率从高到低
  let it=0
  function adam(){it++;const lt=LR*Math.sqrt(1-B2**it)/(1-B1**it);for(const p of P){const {w,g,m,v}=p;for(let i=0;i<w.length;i++){const gi=g[i],mi=B1*m[i]+(1-B1)*gi,vi=B2*v[i]+(1-B2)*gi*gi;m[i]=mi;v[i]=vi;w[i]-=lt*mi/(Math.sqrt(vi)+EPS);g[i]=0}}} // Adam 一步（每批 1 个样本）
  const ids=seqs.map(d=>d.map(n=>n-1)),N=ids.length // 号码减 1 当类别
  let hit=0,cnt=0,lossA=0,lossB=0,nA=0,nB=0 // 回测：命中个数、样本数，前 100 个和最后 100 个样本的平均损失
  for(let t=WIN;t<N;t++){const inp=[ids[t-1],ids[t-2],ids[t-3]],tg=ids[t] // 第 t 期：用前 3 期（新的在前）
    forward(inp,true);const pred=kind==='crf'?viterbi():[order()[0]] // 先预测
    for(const c of pred)if(tg.includes(c))hit++ // 中了几个号
    const loss=backward(inp,tg);cnt++;if(t<WIN+100){lossA+=loss;nA++}if(t>=N-100){lossB+=loss;nB++} // 再学习
    adam()}
  forward([ids[N-1],ids[N-2],ids[N-3]],false) // 下一期：输入最近 3 期
  const plain=kind==='crf'?viterbi():[order()[0]],alts=kind==='crf'?uniquePaths():order().slice(0,6).map(c=>[c]) // 原项目的解码结果、不重复的备选（从好到差）
  return {plain:plain.map(c=>c+1),alts:alts.map(p=>p.map(c=>c+1)),dup:new Set(plain).size<plain.length,samples:cnt,hitPer:hit/cnt,lossFirst:lossA/nA,lossLast:lossB/nB,params:nParams} // 结果
}
let netWorkerUrl=null // 后台线程的脚本地址（只生成一次）
function runNet(job){ // 在后台线程里训练一种球的模型（不卡页面）；浏览器不支持时在页面里算
  return new Promise((resolve,reject)=>{
    try{
      if(!netWorkerUrl) netWorkerUrl=URL.createObjectURL(new Blob([`${lottoNet.toString()}\nonmessage=e=>postMessage(lottoNet(e.data))`],{type:"text/javascript"})) // 把模型函数做成后台线程的脚本
      const w=new Worker(netWorkerUrl) // 新开一个后台线程
      w.onmessage=e=>{resolve(e.data);w.terminate()} // 算完就关掉
      w.onerror=e=>{w.terminate();e.preventDefault();setTimeout(()=>{try{resolve(lottoNet(job))}catch(err){reject(err)}},0)} // 后台线程出错：改在页面里算
      w.postMessage(job) // 开始
    }catch(error){setTimeout(()=>{try{resolve(lottoNet(job))}catch(err){reject(err)}},0)} // 不支持后台线程：在页面里算
  })
}
const netCache={} // 算过的结果：彩种和最新一期 → 红球、蓝球的结果（同样的数据结果一样，不用重算）
function trainFor(type,draws,rule){ // 一种彩票的红球、蓝球模型（两个后台线程同时训练）
  const key=`${type}|${draws[0][0]}|${draws.length}` // 彩种、最新期号、期数
  if(!netCache[key]){const seq=col=>draws.map(d=>d[col]).reverse() // 每期的号码，从早到晚
    netCache[key]=Promise.all([runNet({seqs:seq(2),kind:"crf",S:rule.red[0],C:rule.red[1],seed:1}),runNet({seqs:seq(3),kind:rule.blue[0]>1?"crf":"lstm3",S:rule.blue[0],C:rule.blue[1],seed:2})]) // 红球 LSTM + CRF；蓝球一个号用三层 LSTM，两个号用 LSTM + CRF
    netCache[key].catch(()=>{delete netCache[key]})} // 出错时下次重算
  return netCache[key]
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
  try{ // 尝试
    const data=await loadHistory(type),draws=data.draws,latest=draws[0],T=draws.length // 读取全部开奖记录（新的在前）、最新一期、期数
    const [kr,Mr]=rule.red,[kb,Mb]=rule.blue // 红球、蓝球的个数和范围
    const next=new Date(nextDrawDate(latest[1],rule.drawDays)+"T00:00:00Z") // 下一期预计的开奖日期
    const job=trainFor(type,draws,rule) // 开始训练（后台线程，和下面写字同时进行）
    job.catch(()=>{}) // 出错时由下面的 await 处理，这里不重复报“未处理的错误”
    const crfParams=(S,C)=>C*32+S*8320+8320+32*C+C+C*C,lstm3Params=C=>C*32+3*8320+32*C+C // 参数个数：嵌入、LSTM（每层 32×128×2 + 128）、全连接、CRF 转移矩阵
    const blueOne=kb===1 // 双色球蓝球只有一个号：三层 LSTM
    const nParams=crfParams(kr,Mr)+(blueOne?lstm3Params(Mb):crfParams(kb,Mb)) // 两个模型的参数总数
    await write("思路",`为${rule.name}选 1 注：用神经网络模型把全部 ${fmt(T)} 期开奖按时间顺序一期一期学一遍，红球用 LSTM + CRF 把 ${kr} 个号当成一组一起看，蓝球用${blueOne?"三层 LSTM":"同样的 LSTM + CRF"}，学完后预测下一期。`)
    await write("数据",`共 ${fmt(T)} 期（${draws[T-1][1]} 至 ${latest[1]}），最新第 ${latest[0]} 期：红 ${nums(latest[2])}，蓝 ${nums(latest[3])}。下一期预计 ${next.getUTCMonth()+1} 月 ${next.getUTCDate()} 日（${WEEKDAYS[next.getUTCDay()]}）开奖。`)
    await write("第一步｜整理样本",`每次拿连续 3 期的号码去推下一期，全部历史整理出 ${fmt(T-3)} 组样本。`)
    await write("第二步｜搭建模型",`红球：每个位置先用 LSTM 记住最近 3 期的走势，再把 ${kr} 个位置连成一串，用 CRF 学号码之间的搭配规律。蓝球：${blueOne?"三层 LSTM 看最近 3 期的变化，算出每个号的概率":`同样用 LSTM + CRF，把 ${kb} 个号连起来看`}。两个模型共约 ${(nParams/1e4).toFixed(1)} 万个参数。`)
    await write("第三步｜逐期学习",`从第 4 期开始，每一期先让模型预测，再对照真实开奖用 Adam 修正参数，一期一期学到最新一期；每期只学一次，分量都一样。`)
    const [R,B]=await job // 等训练完（不显示进度）
    const jackpots=new Set(draws.map(d=>d[2].join(",")+"|"+d[3].join(","))) // 开过的头奖组合
    const reds=[...R.alts[0]].sort((a,b)=>a-b) // 红球：不重复的最高分路径，从小到大
    let blues=[...B.alts[0]].sort((a,b)=>a-b),swapped=false // 蓝球
    const key=()=>reds.join(",")+"|"+blues.join(",") // 这一注的写法（和头奖记录一样的格式）
    for(let i=1;jackpots.has(key())&&i<B.alts.length;i++){blues=[...B.alts[i]].sort((a,b)=>a-b);swapped=true} // 万一和开过的头奖一模一样，蓝球换成下一个备选
    const expR=kr*kr/Mr,expB=kb*kb/Mb // 理论上每期平均中几个
    await write("第四步｜检验成绩",`学完全部历史，红球的误差从开始的 ${R.lossFirst.toFixed(1)} 降到 ${R.lossLast.toFixed(1)}。每期预测和真实开奖对照：红球平均每期中 ${R.hitPer.toFixed(2)} 个（理论 ${expR.toFixed(2)} 个），蓝球 ${B.hitPer.toFixed(2)} 个（理论 ${expB.toFixed(2)} 个）。`)
    await write("第五步｜预测下一期",`把最近 3 期交给模型：红球用维特比算法找整体得分最高的一组${R.dup?"（结果里有重复的号，换成不重复的最高分组合）":""}，红 ${nums(reds)}；蓝球${blueOne?"取概率最高的号":"同样取整体得分最高的一组"}，蓝 ${nums(blues)}。`)
    const okNums=(v,[n,max])=>v.length===n&&v.every((y,i)=>y>=1&&y<=max&&(!i||y>v[i-1])) // 个数、范围、从小到大不重复
    const ok=okNums(reds,rule.red)&&okNums(blues,rule.blue)&&!jackpots.has(key()) // 自我检查
    await write("第六步｜自我检查",ok?`号码个数和范围正确，没有重复${swapped?"；原来那注和开过的头奖一样，蓝球换成了下一个备选":"，也不是开过的头奖组合"}，全部通过。`:"有一项没通过，请再试一次。")
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
