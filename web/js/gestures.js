// 禁止页面缩放：双指缩放、双击放大；生成号码时不让页面被拖动
  (function disableZoom() { // 立即执行：禁止页面缩放
  let lastTouchEnd = 0; // 上一次手指离开屏幕的时间
  // 过程窗口（深度思考、随机选号的过程）可以上下滑动：在它里面按下时不拦（否则快速连续滑动时，后一下会被当成双击整个拦掉，表现为“断触”），
  // 改为在“点完松手”时判断双击：手指几乎没动、和上一次点相隔不到 0.35 秒才拦，滑动永远不拦；生成过程中也允许滑它（页面其他地方照旧不能拖）
  const inLog = (e) => !!(e.target && e.target.closest && e.target.closest(".deep-log")); // 手指是不是按在过程窗口里
  let logStart = null; // 在过程窗口里按下的位置
  let logLastTap = 0; // 在过程窗口里上一次“点”（不是滑）松手的时间
  document.addEventListener( // 监听
    "gesturestart", // Safari 的双指缩放开始事件
    function (e) { // 事件处理函数
      e.preventDefault(); // 阻止缩放
    },
    { passive: false } // 不设为被动监听，才能调用 preventDefault
  );
  document.addEventListener( // 监听
    "gesturechange", // Safari 的双指缩放进行中事件
    function (e) { // 事件处理函数
      e.preventDefault(); // 阻止缩放
    },
    { passive: false } // 不设为被动监听
  );
  document.addEventListener( // 监听
    "gestureend", // Safari 的双指缩放结束事件
    function (e) { // 事件处理函数
      e.preventDefault(); // 阻止缩放
    },
    { passive: false } // 不设为被动监听
  );
  document.addEventListener( // 监听
    "touchstart", // 手指按下事件
    function (e) { // 事件处理函数
      if (e.touches.length > 1) { // 两根及以上手指
        e.preventDefault(); // 阻止（防止双指缩放）
        return; // 不再往下处理
      }
      if (inLog(e)) { // 在过程窗口里：放行，快速连续滑动不会被拦
        logStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }; // 记下按下的位置，松手时判断是点还是滑
        return; // 不再往下处理
      }
      const now = Date.now(); // 当前时间
      if (now - lastTouchEnd < 350) { // 距上次松手不到 350 毫秒（双击）
        e.preventDefault(); // 阻止（防止双击放大）
      }
    },
    { passive: false } // 不设为被动监听
  );
  document.addEventListener( // 监听
    "touchmove", // 手指移动事件
    function (e) { // 事件处理函数
      if (e.touches.length > 1) { // 两根及以上手指
        e.preventDefault(); // 阻止（防止双指缩放）
        return; // 不再往下处理
      }
      if ( // 如果
        typeof isRolling !== "undefined" && // isRolling 已定义
        isRolling && // 并且正在生成号码
        !inLog(e) // 并且不是在滑过程窗口
      ) { // 条件结束，满足时
        e.preventDefault(); // 阻止页面拖动
      }
    },
    { passive: false } // 不设为被动监听
  );
  document.addEventListener( // 监听
    "touchend", // 手指离开事件
    function (e) { // 事件处理函数
      const now = Date.now(); // 当前时间
      if (logStart && inLog(e) && e.changedTouches.length) { // 在过程窗口里松手
        const t = e.changedTouches[0]; // 松开的手指
        const tap = Math.abs(t.clientX - logStart.x) < 10 && Math.abs(t.clientY - logStart.y) < 10; // 几乎没动：是“点”，不是“滑”
        if (tap && now - logLastTap < 350) e.preventDefault(); // 0.35 秒内点了第二下：是双击，拦掉放大（滑动不受影响）
        logLastTap = tap ? now : 0; // 记下这次点的时间（滑动不算）
        logStart = null; // 清掉
      }
      lastTouchEnd = now; // 记下松手时间，用于判断双击
    },
    { passive: false } // 不设为被动监听
  );
  document.addEventListener( // 监听
    "dblclick", // 鼠标双击事件
    function (e) { // 事件处理函数
      e.preventDefault(); // 阻止双击放大
    },
    { passive: false } // 不设为被动监听
  );
})(); // 立即执行函数结束
