/* ============================================================
 * SmoothView — 网易云音乐 BetterNCM 界面动效插件
 * 功能：图片按位置依次渐显、鼠标滚轮丝滑滚动、切换页面淡入过渡、歌单逐行渐显、标题栏毛玻璃、
 *       修正歌单偶尔缺行（客户端 bug）
 * 兼容环境：CEF 91 (Chromium 91)
 *
 * 只动「显示」，不拦图片加载：拦 src 要改写全局 setter，太侵入，
 * 而且排队放行全是主线程 JS，正好压在客户端现有的瓶颈上。
 * ============================================================ */

(function () {
    'use strict';

    var CONFIG_KEY = 'smooth-view-settings';

    var REPO_URL = 'https://github.com/Fisnetia/SmoothView';
    var ISSUES_URL = REPO_URL + '/issues';
    var VERSION = (typeof plugin !== 'undefined' && plugin && plugin.manifest && plugin.manifest.version) || '1.0.0';

    // 不参与动效的区域：迷你播放条（AdvancedPlayBar 会换封面）、黑胶页播放条
    var EXCLUDE = '#page_pc_mini_bar, .vinyl-page-bar-wrapper, [class*="VinylPageBarWrapper"]';

    var EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

    function defaults() {
        return {
            imgEnabled: true,
            imgDuration: 360,       // 单张渐显时长 (ms)
            imgStagger: 35,         // 相邻两张错开 (ms)

            scrollEnabled: true,
            scrollSmooth: 90,       // 平滑时间常数 (ms)，越大越"滑"，约 3 倍是停稳的时间
            scrollStep: 1,          // 每格滚动距离倍数

            pageEnabled: true,
            pageDuration: 260,      // 页面淡入时长 (ms)
            pageRise: true,         // 淡入时带一点上浮

            rowEnabled: true,
            rowDuration: 280,       // 单行渐显时长 (ms)
            rowStagger: 25,         // 打开歌单时相邻两行错开 (ms)，滚动时减半

            glassEnabled: true,
            glassBlur: 20,          // 吸顶标题栏模糊半径 (px)
            glassTint: 0.55,        // 底色浓度 (0 - 1)，越大越不透

            listFix: true           // 修正歌单虚拟列表的位置偏移（见第 6 节）
        };
    }

    var state = defaults();

    // 调试计数，inspect() 里看
    var stats = {
        faded: 0, skippedParent: 0,
        wheel: 0, smoothed: 0,
        routes: 0, transitions: 0,
        rows: 0, rowsHealed: 0,
        listFixed: 0, lastListFix: '',
        lastRoute: '', lastTransition: ''
    };

    /* ------------------------------------------------------------
     * 工具
     * ---------------------------------------------------------- */
    function api() {
        return (typeof betterncm !== 'undefined' && betterncm) ? betterncm : null;
    }

    function clamp(n, min, max, fallback) {
        n = Number(n);
        if (!isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    function nodesIn(el) {
        return el.getElementsByTagName ? el.getElementsByTagName('*').length : 0;
    }

    // 窗口最小化时 rAF 会停，定时器兜底，谁先到谁执行
    function nextFrame(fn) {
        var done = false;
        function run() {
            if (done) return;
            done = true;
            fn();
        }
        if (window.requestAnimationFrame) window.requestAnimationFrame(run);
        setTimeout(run, 50);
    }

    function reducedMotion() {
        try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    }

    /* ------------------------------------------------------------
     * 配置持久化（同 AdvancedPlayBar）
     * ---------------------------------------------------------- */
    function isPlainObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    function loadSettings() {
        try {
            var raw = localStorage.getItem(CONFIG_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                if (isPlainObject(parsed)) return Promise.resolve(parsed);
            }
        } catch (e) { }

        var b = api();
        try {
            if (b && b.app && typeof b.app.readConfig === 'function') {
                return Promise.resolve(b.app.readConfig(CONFIG_KEY, null)).then(function (v) {
                    if (isPlainObject(v)) return v;
                    if (typeof v === 'string' && v && v !== '[object Object]') {
                        try {
                            var p2 = JSON.parse(v);
                            if (isPlainObject(p2)) return p2;
                        } catch (e2) { }
                    }
                    return null;
                }).catch(function () { return null; });
            }
        } catch (e3) { }
        return Promise.resolve(null);
    }

    // writeConfig 走原生接口写文件，拖动时合并成一次；localStorage 照常每次写
    var saveTimer = null;

    function saveState() {
        var json;
        try { json = JSON.stringify(state); } catch (e) { return; }
        try { localStorage.setItem(CONFIG_KEY, json); } catch (e2) { }
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, 400);
    }

    function flushSave() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        var b = api();
        try {
            if (b && b.app && typeof b.app.writeConfig === 'function') {
                b.app.writeConfig(CONFIG_KEY, JSON.stringify(state));
            }
        } catch (e) { }
    }

    function migrate(saved) {
        if (!isPlainObject(saved)) return null;
        var def = defaults();
        ['imgEnabled', 'scrollEnabled', 'pageEnabled', 'pageRise', 'rowEnabled', 'glassEnabled', 'listFix'].forEach(function (k) {
            if (typeof saved[k] !== 'boolean') saved[k] = def[k];
        });
        saved.imgDuration = clamp(saved.imgDuration, 0, 2000, def.imgDuration);
        saved.imgStagger = clamp(saved.imgStagger, 0, 120, def.imgStagger);
        saved.scrollSmooth = clamp(saved.scrollSmooth, 20, 400, def.scrollSmooth);
        saved.scrollStep = clamp(saved.scrollStep, 0.3, 3, def.scrollStep);
        saved.pageDuration = clamp(saved.pageDuration, 0, 1500, def.pageDuration);
        saved.rowDuration = clamp(saved.rowDuration, 0, 2000, def.rowDuration);
        saved.rowStagger = clamp(saved.rowStagger, 0, 120, def.rowStagger);
        saved.glassBlur = clamp(saved.glassBlur, 0, 60, def.glassBlur);
        saved.glassTint = clamp(saved.glassTint, 0, 1, def.glassTint);
        return saved;
    }

    /* ------------------------------------------------------------
     * 1. 图片渐显
     *
     * 捕获阶段的 load 监听一个就够，不用 MutationObserver 盯整页。
     * 有没有缓存都会触发 load。同一帧到的图攒成一批，按位置排好再依次错开。
     * load 之后、下一次绘制之前挂上动画，图片不会先闪一下
     * ---------------------------------------------------------- */
    var MIN_IMG = 40;           // 图标、头像这类小图不管
    var STAGGER_CAP = 12;       // 一批最多错开 12 档，再往后的一起出来，免得等太久
    var ROW_TOLERANCE = 8;      // 顶边相差 8px 以内算同一行

    var imgQueue = [];
    var imgQueued = false;

    function onImgLoad(e) {
        var img = e.target;
        if (!state.imgEnabled || !img || img.tagName !== 'IMG') return;
        imgQueue.push(img);
        if (!imgQueued) {
            imgQueued = true;
            nextFrame(flushImgs);
        }
    }

    function flushImgs() {
        imgQueued = false;
        var batch = imgQueue;
        imgQueue = [];
        if (reducedMotion()) return;

        var vw = innerWidth, vh = innerHeight;
        var items = [];
        batch.forEach(function (img) {
            if (!img.isConnected || (img.closest && img.closest(EXCLUDE))) return;
            if (parentFading(img)) { stats.skippedParent++; return; }
            var r = img.getBoundingClientRect();
            if (r.width < MIN_IMG || r.height < MIN_IMG) return;
            if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return;   // 窗口外的看不见，不用动画
            items.push({ img: img, top: r.top, left: r.left, row: 0 });
        });

        // 先按顶边分行，再行内从左到右
        items.sort(function (a, b) { return a.top - b.top; });
        var rowTop = -Infinity, row = -1;
        items.forEach(function (it) {
            if (it.top - rowTop > ROW_TOLERANCE) { row++; rowTop = it.top; }
            it.row = row;
        });
        items.sort(function (a, b) { return a.row - b.row || a.left - b.left; });

        var stagger = clamp(state.imgStagger, 0, 120, 35);
        items.forEach(function (it, i) {
            fadeIn(it.img, Math.min(i, STAGGER_CAP) * stagger);
        });
    }

    // 所在的行或新页面正在淡入（或停在透明等进视口），图片跟着它走，不再叠一层。
    // 行已经显示出来、封面才到的，照样渐显（之前滚动时一律跳过，实测九成多的图都被跳过了）
    function parentFading(img) {
        function busy(a) { return !!a && (a.playState === 'running' || a.playState === 'paused'); }
        var row = img.closest('.tr');
        if (row && busy(row.__svRow)) return true;
        return !!(lastPage && busy(lastPage.__svPage) && lastPage.contains(img));
    }

    function fadeIn(img, delay) {
        if (!img.animate) return;
        if (img.__svFade) img.__svFade.cancel();
        // 只动 opacity：图片自己可能带 transform（悬停放大之类），动画结束会跳
        img.__svFade = img.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: clamp(state.imgDuration, 0, 2000, 360),
            delay: delay,
            easing: EASE,
            fill: 'backwards'
        });
        stats.faded++;
    }

    /* ------------------------------------------------------------
     * 2. 丝滑滚动
     *
     * 只接管鼠标滚轮（一格 wheelDeltaY = ±120 的倍数），触控板本来就顺。
     * 代价：非被动 wheel 监听会让浏览器每次滚动前等主线程，
     * 客户端挂载新行那一下仍然会顿，这里只能把其余时间变顺
     * ---------------------------------------------------------- */
    var scrollAnims = [];       // { el, pos, target, set }
    var scrollLooping = false;
    var lastStepAt = 0;
    var overflowCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

    function isWheelNotch(e) {
        if (e.deltaMode === 1) return true;
        var w = e.wheelDeltaY;
        return typeof w === 'number' && w !== 0 && w % 120 === 0;
    }

    function canScroll(el) {
        if (el.scrollHeight <= el.clientHeight + 1) return false;
        if (el === document.scrollingElement) return true;
        var ok = overflowCache ? overflowCache.get(el) : undefined;
        if (ok === undefined) {
            var oy = getComputedStyle(el).overflowY;
            ok = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
            if (overflowCache) overflowCache.set(el, ok);
        }
        return ok;
    }

    function animOf(el) {
        for (var i = 0; i < scrollAnims.length; i++) {
            if (scrollAnims[i].el === el) return scrollAnims[i];
        }
        return null;
    }

    // 从事件目标往上找第一个还能往这个方向滚的容器（嵌套列表滚到头会交给外层）
    function findScroller(node, dy) {
        var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
        for (; el; el = el.parentElement) {
            if (!canScroll(el)) continue;
            var a = animOf(el);
            var at = a ? a.target : el.scrollTop;
            var maxTop = el.scrollHeight - el.clientHeight;
            if ((dy > 0 && at < maxTop - 1) || (dy < 0 && at > 0)) return el;
        }
        return null;
    }

    function onWheel(e) {
        stats.wheel++;
        if (!state.scrollEnabled || e.defaultPrevented) return;
        if (e.ctrlKey || e.shiftKey || e.altKey || !e.deltaY) return;
        if (!isWheelNotch(e)) return;
        if (e.target && e.target.closest && e.target.closest(EXCLUDE)) return;

        var dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
        dy *= clamp(state.scrollStep, 0.3, 3, 1);
        var el = findScroller(e.target, dy);
        if (!el) return;

        e.preventDefault();
        stats.smoothed++;
        var a = animOf(el);
        if (!a) {
            a = { el: el, pos: el.scrollTop, target: el.scrollTop, set: el.scrollTop };
            scrollAnims.push(a);
        }
        a.target = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, a.target + dy));

        if (!scrollLooping) {
            fixListOffsets();
            scrollLooping = true;
            lastStepAt = 0;
            requestAnimationFrame(scrollStep);
        }
    }

    function scrollStep(now) {
        var dt = lastStepAt ? Math.min(100, now - lastStepAt) : 16;
        lastStepAt = now;
        // 指数逼近、按实际帧间隔算：主线程卡一下，下一帧会补上，不会越拖越慢
        var k = 1 - Math.exp(-dt / clamp(state.scrollSmooth, 20, 400, 90));

        scrollAnims = scrollAnims.filter(function (a) {
            var el = a.el;
            if (!el.isConnected) return false;
            // 期间位置被别人改了（拖滚动条、键盘、页面自己跳），让出控制
            if (Math.abs(el.scrollTop - a.set) > 2) return false;
            var maxTop = el.scrollHeight - el.clientHeight;
            if (a.target > maxTop) a.target = maxTop;
            a.pos += (a.target - a.pos) * k;
            if (Math.abs(a.target - a.pos) < 0.5) a.pos = a.target;
            el.scrollTop = a.pos;
            a.set = a.pos;
            return a.pos !== a.target;
        });

        if (scrollAnims.length) requestAnimationFrame(scrollStep);
        else {
            scrollLooping = false;
            fixListOffsets();
            healRows();
        }
    }

    /* ------------------------------------------------------------
     * 3. 页面切换过渡
     *
     * 实测（probe-route.js）：
     *   - 每次换页都调 pushState，但 URL 恒为 app.html，只能把调用本身当信号
     *   - 新页面挂在主内容区下 1 层（#page_xxx），缓存页（ka-content）在第 3 层
     *   - 摘旧页和挂新页分两批，中间隔几百 ms
     * 所以：pushState 后临时盯主内容区子树，第一块够大的新内容就是新页面，
     * 给它做进场，然后立刻停止监听。平时不监听，滚动列表不受影响。
     * 旧页面在 React 卸载它的那一刻就没了，只能做新页面的进场
     * ---------------------------------------------------------- */
    var ARM_MS = 1500;          // 换页后最多等这么久新页面挂上来
    var ARM_DEPTH = 3;          // 新页面挂在主内容区 3 层以内；更深的是列表行之类
    var BIG_PAGE = 30;          // 节点数超过这个才算整块页面

    var mainEl = null;
    var lastPage = null;        // 最近一次做进场的页面，图片渐显据此判断要不要跳过
    var armObserver = null;
    var armTimer = null;

    function onNavigate(source) {
        stats.routes++;
        stats.lastRoute = source;
        arm();
    }

    // 只认 pushState 和后退：replaceState 常被拿来存状态，不代表换页
    function hookHistory() {
        var orig = history.pushState;
        if (typeof orig === 'function' && !orig.__svHooked) {
            var wrapped = function () {
                var ret = orig.apply(this, arguments);
                try { onNavigate('pushState'); } catch (e) { }
                return ret;
            };
            wrapped.__svHooked = true;
            history.pushState = wrapped;
        }
        window.addEventListener('popstate', function () { onNavigate('popstate'); });
        window.addEventListener('hashchange', function () { onNavigate('hashchange'); });
    }

    // 主内容区：最外层的 scrollCss_ 容器（缓存页里还嵌着同样大小的一层）
    function findMain() {
        if (mainEl && mainEl.isConnected) return mainEl;
        var list = Array.prototype.slice.call(document.querySelectorAll('[class*="scrollCss_"]'));
        var outer = list.filter(function (el) {
            return !list.some(function (o) { return o !== el && o.contains(el); });
        });
        var best = null, bestArea = 0;
        outer.forEach(function (el) {
            var r = el.getBoundingClientRect();
            if (r.width * r.height > bestArea) { best = el; bestArea = r.width * r.height; }
        });
        mainEl = best;
        return mainEl;
    }

    function depthIn(root, el) {
        var d = 0;
        for (; el && el !== root; el = el.parentElement) d++;
        return el ? d : -1;
    }

    function disarm() {
        if (armObserver) { armObserver.disconnect(); armObserver = null; }
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    }

    function arm() {
        disarm();
        if (!state.pageEnabled || reducedMotion()) return;
        var root = findMain();
        if (!root) return;

        armObserver = new MutationObserver(function (recs) {
            for (var i = 0; i < recs.length; i++) {
                var d = depthIn(root, recs[i].target);
                if (d < 0 || d > ARM_DEPTH) continue;
                var added = recs[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var n = added[j];
                    if (n.nodeType === 1 && nodesIn(n) > BIG_PAGE) {
                        disarm();
                        enter(n);
                        return;
                    }
                }
            }
        });
        try { armObserver.observe(root, { childList: true, subtree: true }); } catch (e) { disarm(); return; }
        armTimer = setTimeout(disarm, ARM_MS);
    }

    function enter(node) {
        if (!node.animate) return;
        stats.transitions++;
        var cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '';
        stats.lastTransition = node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (cls ? '.' + cls : '');

        var rise = state.pageRise;
        lastPage = node;
        node.__svPage = node.animate([
            rise ? { opacity: 0, transform: 'translateY(10px)' } : { opacity: 0 },
            rise ? { opacity: 1, transform: 'none' } : { opacity: 1 }
        ], {
            duration: clamp(state.pageDuration, 0, 1500, 260),
            easing: EASE
        });
    }

    /* ------------------------------------------------------------
     * 4. 歌单逐行渐显
     *
     * 实测歌单是虚拟列表：行是 .tbody 里的 div.tr，滚动时一行行挂上来。
     * 挂上时在屏幕内的：绘制前挂动画，按从上到下错开；
     * 挂在屏幕外的（虚拟列表预渲染的几行）：动画先暂停在透明，进视口再放。
     * 不往 style 里写 opacity，cancel() 一下就复原，关掉开关不会留下藏起来的行
     * ---------------------------------------------------------- */
    var ROW_SCOPE = '.tbody, .ReactVirtualized__Grid';
    var ROW_STAGGER_CAP = 15;   // 打开页面时最多错开 15 档

    var rowObserver = null;
    var rowIO = null;
    var observedRowRoot = null;
    var pendingRows = typeof Set !== 'undefined' ? new Set() : null;   // 暂停在透明、等进视口的行

    function isRow(n) {
        return n.nodeType === 1 && n.classList.contains('tr') && !!n.closest(ROW_SCOPE);
    }

    // 滚动时挂上来的是单行；打开页面时是整块列表，行在里面
    function rowsIn(n, loose) {
        if (n.nodeType !== 1) return [];
        if (loose ? n.classList.contains('tr') : isRow(n)) return [n];
        if (nodesIn(n) <= BIG_PAGE) return [];
        var list = Array.prototype.slice.call(n.querySelectorAll('.tr'));
        return loose ? list : list.filter(isRow);
    }

    function rowAnim(row, delay) {
        if (row.__svRow) row.__svRow.cancel();
        row.__svRow = row.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: clamp(state.rowDuration, 0, 2000, 280),
            delay: delay || 0,
            easing: EASE,
            fill: 'backwards'
        });
        return row.__svRow;
    }

    function playRows(items, stepScale) {
        items.sort(function (a, b) { return a.top - b.top; });
        var step = clamp(state.rowStagger, 0, 120, 25) * stepScale;
        items.forEach(function (it, i) {
            if (pendingRows) pendingRows.delete(it.row);
            rowAnim(it.row, Math.min(i, ROW_STAGGER_CAP) * step);
            stats.rows++;
        });
    }

    function onRowsMounted(rows) {
        if (reducedMotion()) return;
        var vh = innerHeight, now = [];
        rows.forEach(function (row) {
            if (!row.isConnected || !row.animate) return;
            var r = row.getBoundingClientRect();
            if (!r.height) return;
            if (r.bottom > 0 && r.top < vh) {
                now.push({ row: row, top: r.top });
            } else if (rowIO) {
                rowAnim(row).pause();
                if (pendingRows) pendingRows.add(row);
                rowIO.observe(row);
            }
        });
        playRows(now, 1);
    }

    // 滚动时几行一起进视口，间隔减半，免得下面的行等太久
    function onRowsVisible(entries) {
        var vis = [];
        entries.forEach(function (e) {
            if (!e.isIntersecting) return;
            rowIO.unobserve(e.target);
            vis.push({ row: e.target, top: e.boundingClientRect.top });
        });
        playRows(vis, 0.5);
    }

    // 兜底：IntersectionObserver 万一漏报，行会一直停在透明。
    // 定时、以及丝滑滚动停下时扫一遍，已经在视口里还暂停着的直接放。rowsHealed 涨了说明真漏过
    function healRows() {
        var root = observedRowRoot;
        if (!root) return;
        var vh = innerHeight, vis = [];
        Array.prototype.forEach.call(root.querySelectorAll('.tr'), function (row) {
            var a = row.__svRow;
            if (!a || a.playState !== 'paused') return;
            var r = row.getBoundingClientRect();
            if (!r.height || r.bottom <= 0 || r.top >= vh) return;
            if (rowIO) rowIO.unobserve(row);
            vis.push({ row: row, top: r.top });
        });
        if (!vis.length) return;
        stats.rowsHealed += vis.length;
        playRows(vis, 0.5);
    }

    function stopRows() {
        if (rowObserver) { rowObserver.disconnect(); rowObserver = null; }
        if (rowIO) { rowIO.disconnect(); rowIO = null; }
        if (pendingRows) {
            pendingRows.forEach(function (row) { if (row.__svRow) row.__svRow.cancel(); });
            pendingRows.clear();
        }
        observedRowRoot = null;
    }

    function syncRows() {
        var root = state.rowEnabled ? findMain() : null;
        if (root === observedRowRoot) return;
        stopRows();
        if (!root) return;
        observedRowRoot = root;
        if (typeof IntersectionObserver !== 'undefined') rowIO = new IntersectionObserver(onRowsVisible);

        rowObserver = new MutationObserver(function (recs) {
            var rows = [];
            recs.forEach(function (r) {
                Array.prototype.forEach.call(r.addedNodes, function (n) { rows.push.apply(rows, rowsIn(n)); });
                // 摘掉的行要 unobserve，不然 IntersectionObserver 一直攥着它。摘下来的节点 closest 找不到 .tbody，只看类名
                Array.prototype.forEach.call(r.removedNodes, function (n) {
                    rowsIn(n, true).forEach(function (row) {
                        if (rowIO) rowIO.unobserve(row);
                        if (pendingRows) pendingRows.delete(row);
                    });
                });
            });
            if (rows.length) onRowsMounted(rows);
        });
        try { rowObserver.observe(root, { childList: true, subtree: true }); } catch (e) { stopRows(); }
    }

    /* ------------------------------------------------------------
     * 5. 吸顶标题栏毛玻璃
     *
     * 歌单往下滚，顶部会出现吸顶栏（StyledStickyOper）。它的不透明底是
     * StyledStickyMask 里复制的一份页面背景，用 clip 裁成标题栏那一条。
     * 把这份背景调成半透明、mask 加 backdrop-filter 就是毛玻璃：
     * 位置尺寸全沿用客户端的，不用自己算；底色还是歌单封面取色的渐变，和页面接得上。
     *
     * 实测（probe-sticky.js）：吸顶栏进场是 opacity 0→1 加 translate3d(0, 5%, 0)→none，
     * 500ms ease；退场从 sticky-oper-exit 就开始。祖先透明度 < 1、或者正在做 transform
     * 动画，都会把毛玻璃截断（CEF 91），动画放完模糊才突然出现。
     * 所以吸顶栏本身钉在不透明、不位移，淡入和滑入挪到子元素和底下那条分隔线上：
     * 元素自己的透明度和位移不截断自己的毛玻璃，模糊会跟着一起渐渐出来
     * ---------------------------------------------------------- */
    var STYLE_ID = 'sv-style';
    var GLASS_ANIM = 'opacity 500ms ease, transform 500ms ease';   // 沿用客户端的时长和曲线
    var GLASS_RISE = '5px';     // 客户端是吸顶栏高度的 5%，约 5px
    var styleEl = null;
    var lastCss = null;

    function buildCss() {
        if (!state.glassEnabled) return '';
        var blur = Math.round(clamp(state.glassBlur, 0, 60, 20));
        var tint = +clamp(state.glassTint, 0, 1, 0.55).toFixed(2);
        var L = [];
        L.push('[class*="StyledStickyMask_"] {');
        L.push('  background-color: transparent !important;');
        if (blur > 0) {
            L.push('  backdrop-filter: blur(' + blur + 'px) saturate(1.4) !important;');
            L.push('  -webkit-backdrop-filter: blur(' + blur + 'px) saturate(1.4) !important;');
        }
        L.push('}');
        L.push('[class*="StyledStickyMask_"] > * { opacity: ' + tint + ' !important; }');

        // 子元素和 ::after（底部分隔线）一起动
        var OPER = '[class*="StyledStickyOper_"]';
        function parts(cls) {
            return OPER + cls + ' > *, ' + OPER + cls + '::after';
        }
        L.push(OPER + ' { opacity: 1 !important; transform: none !important; }');
        L.push(parts('') + ' { transition: ' + GLASS_ANIM + ' !important; }');
        L.push(parts('.sticky-oper-enter') + ',');
        L.push(parts('.sticky-oper-exit') + ' { opacity: 0 !important; transform: translateY(' + GLASS_RISE + ') !important; }');
        // react-transition-group 在 active 阶段同时挂着 enter 和 enter-active，要单独放回去
        L.push(parts('.sticky-oper-enter.sticky-oper-enter-active') + ' { opacity: 1 !important; transform: none !important; }');
        return L.join('\n');
    }

    // 内容没变就不写，免得无谓的样式重算
    function ensureStyle() {
        if (!styleEl || !styleEl.isConnected) {
            styleEl = document.getElementById(STYLE_ID);
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = STYLE_ID;
                (document.head || document.documentElement).appendChild(styleEl);
            }
            lastCss = null;
        }
        var css = buildCss();
        if (css !== lastCss) {
            styleEl.textContent = css;
            lastCss = css;
        }
    }

    /* ------------------------------------------------------------
     * 6. 歌单缺行修正（客户端自己的 bug）
     *
     * 现象：歌单往下滚偶尔顶上几行不渲染，往上滚又出来。
     * 实测：歌单是 react-virtualized 的 WindowScroller + Grid。WindowScroller 记着
     * "列表离滚动容器顶多远"（_positionFromTop），拿 scrollTop 减它算该画哪几行。
     * 出问题时它记的是 -72 / -204 —— 正好是列表节点不在文档里（rect 全 0）时量出来的，
     * 之后 resize 也纠正不回来；实际应是列表头上那一截的高度（约 287px）。
     * 于是它总以为多滚了这么多，最上面几行被当成"已滚出去"。
     * 这里拿列表的真实位置对一下，偏太多就改回来，再补发一个 scroll 让它重算
     * ---------------------------------------------------------- */
    var LIST_FIX_MIN = 100;     // 偏差超过 100px 才改，小偏差可能是客户端量的是别的节点，别跟它拉扯

    function fiberOf(el) {
        var keys = Object.keys(el);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].indexOf('__reactFiber') === 0 || keys[i].indexOf('__reactInternalInstance') === 0) return el[keys[i]];
        }
        return null;
    }

    function windowScrollerOf(grid) {
        for (var f = fiberOf(grid), i = 0; f && i < 20; f = f.return, i++) {
            var sn = f.stateNode;
            if (sn && typeof sn.updatePosition === 'function' && typeof sn._positionFromTop === 'number') return sn;
        }
        return null;
    }

    function fixListOffsets() {
        if (!state.listFix) return;
        var root = findMain();
        if (!root) return;
        var grids = root.querySelectorAll('.ReactVirtualized__Grid');
        for (var i = 0; i < grids.length; i++) {
            var grid = grids[i];
            if (!grid.getClientRects().length) continue;   // 缓存里没显示的页面不管
            // 页面淡入还在上浮，位置差 10px，等它放完
            if (lastPage && lastPage.__svPage && lastPage.__svPage.playState === 'running' && lastPage.contains(grid)) continue;
            var ws = windowScrollerOf(grid);
            var sc = ws && ws.props && ws.props.scrollElement;
            if (!sc || !sc.getBoundingClientRect) continue;

            var gr = grid.getBoundingClientRect(), sr = sc.getBoundingClientRect();
            var top = gr.top - sr.top + sc.scrollTop;
            var left = gr.left - sr.left + sc.scrollLeft;
            if (Math.abs(ws._positionFromTop - top) <= LIST_FIX_MIN && Math.abs(ws._positionFromLeft - left) <= LIST_FIX_MIN) continue;

            stats.listFixed++;
            stats.lastListFix = Math.round(ws._positionFromTop) + ' → ' + Math.round(top);
            ws._positionFromTop = top;
            ws._positionFromLeft = left;
            sc.dispatchEvent(new Event('scroll'));
        }
    }

    /* ------------------------------------------------------------
     * 调试接口
     * ---------------------------------------------------------- */
    function inspect() {
        var m = findMain();
        var cls = m && typeof m.className === 'string' ? m.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
        return {
            stats: stats,
            main: m ? m.tagName.toLowerCase() + (cls ? '.' + cls : '') : '(没找到主内容区)',
            armed: !!armObserver,
            rowObserver: !!rowObserver,
            rowsWaiting: pendingRows ? pendingRows.size : '?',
            scrolling: scrollAnims.length
        };
    }

    /* ------------------------------------------------------------
     * UI 面板（样式沿用 AdvancedPlayBar）
     * ---------------------------------------------------------- */
    var PANEL_CSS = [
        '.sv-panel {',
        '  --sv-ui: #ec4141; --sv-ui-rgb: 236, 65, 65;',
        '  --sv-line: rgba(128, 128, 128, 0.16);',
        '  --sv-fill: rgba(128, 128, 128, 0.07);',
        '  max-width: 660px; padding: 4px 0 24px;',
        '  font-family: inherit; font-size: 14px; line-height: 1.5; color: inherit; text-align: left;',
        '}',
        '.sv-panel *, .sv-panel *::before, .sv-panel *::after { box-sizing: border-box; }',
        '.sv-panel button { font: inherit; color: inherit; margin: 0; }',
        '.sv-panel button:focus, .sv-panel input:focus { outline: none; }',
        '.sv-panel button:focus-visible, .sv-panel input:focus-visible { outline: 2px solid rgba(var(--sv-ui-rgb), 0.55); outline-offset: 2px; }',

        '.sv-panel .sv-head { display: flex; align-items: baseline; gap: 8px; }',
        '.sv-panel .sv-title { font-size: 20px; font-weight: 700; letter-spacing: 0.01em; }',
        '.sv-panel .sv-ver { font-size: 12px; opacity: 0.5; font-variant-numeric: tabular-nums; }',
        '.sv-panel .sv-section { margin-top: 22px; }',
        '.sv-panel .sv-section-title { font-size: 12.5px; font-weight: 600; opacity: 0.62; margin: 0 4px 8px; }',
        '.sv-panel .sv-card { background: var(--sv-fill); border: 1px solid var(--sv-line); border-radius: 12px; padding: 0 16px; }',
        '.sv-panel .sv-item { border-bottom: 1px solid var(--sv-line); transition: opacity 160ms ease; }',
        '.sv-panel .sv-item:last-child { border-bottom: 0; }',
        '.sv-panel .sv-item.sv-off { opacity: 0.4; pointer-events: none; }',
        '.sv-panel .sv-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 58px; padding: 10px 0; }',
        '.sv-panel .sv-text { min-width: 150px; }',
        '.sv-panel .sv-label { font-size: 14px; font-weight: 600; }',
        '.sv-panel .sv-hint { font-size: 12px; opacity: 0.55; margin-top: 1px; }',
        '.sv-panel .sv-ctrl { display: flex; align-items: center; justify-content: flex-end; flex: 1; }',

        '.sv-panel .sv-switch { position: relative; flex: none; width: 38px; height: 22px; padding: 0; border: 0; border-radius: 999px;',
        '  background: rgba(128, 128, 128, 0.38); cursor: pointer; transition: background-color 180ms ease; }',
        '.sv-panel .sv-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;',
        '  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); transition: transform 200ms cubic-bezier(0.22, 0.61, 0.36, 1); }',
        '.sv-panel .sv-switch.on { background: var(--sv-ui); }',
        '.sv-panel .sv-switch.on::after { transform: translateX(16px); }',

        '.sv-panel .sv-range-box { display: flex; align-items: center; gap: 12px; flex: 1; justify-content: flex-end; }',
        '.sv-panel .sv-range { -webkit-appearance: none; appearance: none; flex: 1; max-width: 220px; height: 4px; margin: 0;',
        '  border-radius: 999px; outline: none; cursor: pointer;',
        '  background: linear-gradient(to right, var(--sv-ui) 0, var(--sv-ui) var(--p, 0%), rgba(128, 128, 128, 0.3) var(--p, 0%), rgba(128, 128, 128, 0.3) 100%); }',
        '.sv-panel .sv-range::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #fff;',
        '  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.1), 0 1px 4px rgba(0, 0, 0, 0.35); transition: transform 140ms ease; }',
        '.sv-panel .sv-range:hover::-webkit-slider-thumb, .sv-panel .sv-range:active::-webkit-slider-thumb { transform: scale(1.18); }',
        '.sv-panel .sv-range-val { min-width: 52px; text-align: right; font-size: 12.5px; opacity: 0.8; font-variant-numeric: tabular-nums; }',

        '.sv-panel .sv-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 22px; }',
        '.sv-panel .sv-links { display: flex; gap: 4px; }',
        '.sv-panel .sv-link { padding: 4px 10px; border: 0; border-radius: 7px; background: transparent; font-size: 12.5px; color: var(--sv-ui);',
        '  cursor: pointer; transition: background-color 160ms ease; }',
        '.sv-panel .sv-link:hover { background: rgba(var(--sv-ui-rgb), 0.12); }',
        '.sv-panel .sv-btn { padding: 7px 16px; border: 1px solid var(--sv-line); border-radius: 9px; background: rgba(128, 128, 128, 0.16); font-size: 13px;',
        '  cursor: pointer; transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease; }',
        '.sv-panel .sv-btn:hover { background: rgba(128, 128, 128, 0.24); }',
        '.sv-panel .sv-btn.warn { background: rgba(var(--sv-ui-rgb), 0.16); border-color: rgba(var(--sv-ui-rgb), 0.55); color: var(--sv-ui); }'
    ].join('\n');

    var host = null;
    var panelRoot = null;
    var panelBinds = [];

    function bindPanel(fn) {
        panelBinds.push(fn);
        fn();
    }

    function syncPanel() {
        if (!panelRoot || !panelRoot.isConnected) return;
        panelBinds.forEach(function (fn) { fn(); });
    }

    // 面板强调色跟随客户端主题色
    function paintAccent(root) {
        var raw = '';
        try { raw = getComputedStyle(document.documentElement).getPropertyValue('--colorPrimary1').trim(); } catch (e) { }
        var m = raw.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (!m) return;
        root.style.setProperty('--sv-ui', 'rgb(' + m[1] + ', ' + m[2] + ', ' + m[3] + ')');
        root.style.setProperty('--sv-ui-rgb', m[1] + ', ' + m[2] + ', ' + m[3]);
    }

    function openExternal(url) {
        var b = api();
        try {
            if (b && b.ncm && typeof b.ncm.openUrl === 'function') {
                b.ncm.openUrl(url);
                return;
            }
        } catch (e) { }
        try { window.open(url, '_blank'); } catch (e2) { }
    }

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function btn(cls, text) {
        var b = el('button', cls, text);
        b.type = 'button';
        return b;
    }

    function patchOf(key, value) {
        var p = {};
        p[key] = value;
        return p;
    }

    function item(label, hint, control, enabledWhen) {
        var wrap = el('div', 'sv-item');
        var r = el('div', 'sv-row');
        var left = el('div', 'sv-text');
        left.appendChild(el('div', 'sv-label', label));
        if (hint) left.appendChild(el('div', 'sv-hint', hint));
        r.appendChild(left);
        var right = el('div', 'sv-ctrl');
        right.appendChild(control);
        r.appendChild(right);
        wrap.appendChild(r);
        if (enabledWhen) {
            bindPanel(function () { wrap.classList.toggle('sv-off', !enabledWhen()); });
        }
        return wrap;
    }

    function switchCtl(key) {
        var b = btn('sv-switch');
        b.setAttribute('role', 'switch');
        function paint() {
            b.classList.toggle('on', !!state[key]);
            b.setAttribute('aria-checked', String(!!state[key]));
        }
        b.addEventListener('click', function () {
            update(patchOf(key, !state[key]));
            paint();
        });
        bindPanel(paint);
        return b;
    }

    function rangeCtl(min, max, step, key, format) {
        var box = el('div', 'sv-range-box');
        var input = el('input', 'sv-range');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(state[key]);
        var out = el('span', 'sv-range-val');
        var digits = (String(step).split('.')[1] || '').length;

        function paint(v) {
            out.textContent = format(v);
            input.style.setProperty('--p', ((v - min) / (max - min) * 100) + '%');
        }
        input.addEventListener('input', function () {
            var v = +Number(input.value).toFixed(digits);
            paint(v);
            update(patchOf(key, v));
        });
        paint(Number(input.value));

        box.appendChild(input);
        box.appendChild(out);
        return box;
    }

    function section(title, items) {
        var s = el('div', 'sv-section');
        s.appendChild(el('div', 'sv-section-title', title));
        var card = el('div', 'sv-card');
        items.forEach(function (it) { card.appendChild(it); });
        s.appendChild(card);
        return s;
    }

    function msFmt(v) { return v + 'ms'; }

    function buildPanel() {
        panelBinds = [];
        var root = el('div', 'sv-panel');
        panelRoot = root;
        paintAccent(root);

        var style = el('style');
        style.textContent = PANEL_CSS;
        root.appendChild(style);

        var head = el('div', 'sv-head');
        head.appendChild(el('div', 'sv-title', 'SmoothView'));
        head.appendChild(el('div', 'sv-ver', 'v' + VERSION));
        root.appendChild(head);

        function imgOn() { return state.imgEnabled; }
        function scrollOn() { return state.scrollEnabled; }
        function pageOn() { return state.pageEnabled; }
        function rowOn() { return state.rowEnabled; }
        function glassOn() { return state.glassEnabled; }

        root.appendChild(section('图片渐显', [
            item('启用', '图片加载完后按从上到下、从左到右依次淡入', switchCtl('imgEnabled')),
            item('渐显时长', '单张图片淡入用的时间', rangeCtl(100, 1000, 20, 'imgDuration', msFmt), imgOn),
            item('依次间隔', '相邻两张图片错开的时间，0 为同时出现', rangeCtl(0, 100, 5, 'imgStagger', msFmt), imgOn)
        ]));

        root.appendChild(section('丝滑滚动', [
            item('启用', '鼠标滚轮平滑滚动，触控板不受影响', switchCtl('scrollEnabled')),
            item('平滑度', '越大越顺滑，停下来也越慢', rangeCtl(40, 200, 5, 'scrollSmooth', function (v) {
                return '约 ' + Math.round(v * 3) + 'ms';
            }), scrollOn),
            item('滚动距离', '每格滚轮滚动的距离', rangeCtl(0.5, 2, 0.1, 'scrollStep', function (v) {
                return v.toFixed(1) + '×';
            }), scrollOn)
        ]));

        root.appendChild(section('页面过渡', [
            item('启用', '切换页面时新页面淡入', switchCtl('pageEnabled')),
            item('过渡时长', '新页面淡入用的时间', rangeCtl(120, 600, 20, 'pageDuration', msFmt), pageOn),
            item('轻微上浮', '淡入时从下方 10px 浮上来', switchCtl('pageRise'), pageOn)
        ]));

        root.appendChild(section('歌单逐行渐显', [
            item('启用', '打开歌单时从上到下依次淡入，滚动时新出现的行也淡入', switchCtl('rowEnabled')),
            item('渐显时长', '单行淡入用的时间', rangeCtl(100, 800, 20, 'rowDuration', msFmt), rowOn),
            item('依次间隔', '打开歌单时相邻两行错开的时间，滚动时减半', rangeCtl(0, 80, 5, 'rowStagger', msFmt), rowOn)
        ]));

        root.appendChild(section('修复', [
            item('歌单缺行修正', '客户端的列表偶尔记错自己的位置，往下滚时顶上几行不显示。检测到就纠正', switchCtl('listFix'))
        ]));

        root.appendChild(section('标题栏毛玻璃', [
            item('启用', '歌单往下滚时顶部出现的标题栏改成毛玻璃', switchCtl('glassEnabled')),
            item('模糊强度', '0 为只半透明、不模糊', rangeCtl(0, 40, 1, 'glassBlur', function (v) {
                return v === 0 ? '关闭' : v + 'px';
            }), glassOn),
            item('底色浓度', '越高越接近原来的不透明底', rangeCtl(0, 1, 0.05, 'glassTint', function (v) {
                return Math.round(v * 100) + '%';
            }), glassOn)
        ]));

        var foot = el('div', 'sv-foot');
        // 点两次才生效，防误触
        var bReset = btn('sv-btn', '恢复默认');
        var armed = null;
        bReset.addEventListener('click', function () {
            if (!armed) {
                bReset.textContent = '再点一次确认';
                bReset.classList.add('warn');
                armed = setTimeout(function () {
                    armed = null;
                    bReset.textContent = '恢复默认';
                    bReset.classList.remove('warn');
                }, 3000);
                return;
            }
            clearTimeout(armed);
            armed = null;
            state = defaults();
            saveState();
            flushSave();
            refresh();
            if (host) {
                host.textContent = '';
                host.appendChild(buildPanel());
            }
        });
        foot.appendChild(bReset);

        var links = el('div', 'sv-links');
        [['源码仓库', REPO_URL], ['问题反馈', ISSUES_URL]].forEach(function (l) {
            var a = btn('sv-link', l[0]);
            a.addEventListener('click', function () { openExternal(l[1]); });
            links.appendChild(a);
        });
        foot.appendChild(links);
        root.appendChild(foot);

        return root;
    }

    /* ------------------------------------------------------------
     * 刷新与初始化
     * ---------------------------------------------------------- */
    function refresh() {
        if (!state.pageEnabled) disarm();
        ensureStyle();
        syncRows();
        syncPanel();
    }

    function update(patch) {
        Object.keys(patch || {}).forEach(function (k) { state[k] = patch[k]; });
        saveState();
        refresh();
    }

    plugin.onLoad(function () {
        loadSettings().then(function (saved) {
            saved = migrate(saved);
            if (saved) {
                Object.keys(defaults()).forEach(function (k) {
                    if (saved[k] !== undefined) state[k] = saved[k];
                });
            }

            document.addEventListener('load', onImgLoad, true);
            window.addEventListener('wheel', onWheel, { passive: false });

            hookHistory();
            refresh();

            // 主内容区可能被整个重建、head 里的样式可能被清掉，定时检查
            setInterval(function () {
                if (mainEl && !mainEl.isConnected) mainEl = null;
                ensureStyle();
                syncRows();
                fixListOffsets();
                healRows();
            }, 1500);

            window.addEventListener('beforeunload', function () {
                if (saveTimer) flushSave();
            });
        }).catch(function (err) {
            console.warn('[SmoothView] 初始化失败：', err);
        });
    });

    plugin.onConfig(function () {
        host = el('div');
        host.style.padding = '6px 4px';
        host.appendChild(buildPanel());
        return host;
    });

    window.__smoothView = {
        get state() { return state; },
        update: update,
        inspect: inspect,
        migrate: migrate,
        get css() { return buildCss(); },
        healRows: healRows,
        fixListOffsets: fixListOffsets,
        arm: arm,
        version: VERSION
    };
})();
