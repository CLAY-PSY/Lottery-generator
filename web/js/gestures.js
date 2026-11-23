// 禁止页面缩放：双指缩放、双击放大；生成号码时不让页面被拖动
  (function disableZoom() { // 立即执行：禁止页面缩放
  let lastTouchEnd = 0; // 上一次手指离开屏幕的时间
  // 过程窗口（深度思考、随机选号的过程）可以上下滑动：在它里面不做防双击拦截（它的 touch-action: pan-y 已经禁止双击放大），
  // 否则快速连续滑动时，后一下会被当成双击整个拦掉，表现为“断触”；生成过程中也允许滑它（页面其他地方照旧不能拖）
  const inLog = (e) => !!(e.target && e.target.closest && e.target.closest(".deep-log")); // 手指是不是按在过程窗口里
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
      if (inLog(e)) return; // 在过程窗口里：放行，快速连续滑动不会被拦
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
    function () { // 事件处理函数
      lastTouchEnd = Date.now(); // 记下松手时间，用于判断双击
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
