console.log('App initialized');

/**
 * 复制代码到剪贴板
 * @param {HTMLElement} element - 触发复制的元素，通常是一个包含代码的 <code> 标签
 * @param {string} [realText] - 可选参数，指定要复制的文本内容。如果不提供，则默认使用元素的 innerText 作为要复制的内容
 * @returns {void}
 * @description
 * 该函数使用现代浏览器的 Clipboard API 将指定元素的文本内容复制到系统剪贴板。
 * 当用户点击一个包含代码的 <code> 标签时，调用此函数会将该标签内的文本复制到剪贴板，并显示一个 Toast 提示用户复制成功。
 * 使用时需要确保页面中有一个 id 为 'toast-container' 的元素作为 Toast 的容器。
 * 示例用法：<code onclick="copyCode(this)">要复制的代码</code>
 * @example
 * // 在页面上创建一个可点击的代码块，点击后复制内容到剪贴板
 * <code onclick="copyCode(this)">这是要复制的代码</code>
 */
function copyCode(element, realText = '') {
    const textToCopy = realText || element.innerText;

    // 1. 优先使用现代的 Clipboard API（如果是 HTTPS 或 Localhost）
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCopy)
            .then(() => handleCopySuccess(textToCopy))
            .catch(err => console.error('现代复制API失败:', err));
    } else {
        // 2. 降级方案：针对 HTTP 环境或老旧浏览器
        // 创建一个隐藏的 input 元素
        const textArea = document.createElement("textarea");
        textArea.value = textToCopy;
        
        // 避开滚动条影响，将其定位到屏幕外
        textArea.style.position = "fixed";
        textArea.style.top = "-9999px";
        document.body.appendChild(textArea);
        
        // 选中文字并执行复制命令
        textArea.focus();
        textArea.select();
        
        try {
            const successful = document.execCommand('copy');
            if (successful) {
                handleCopySuccess(textToCopy);
            } else {
                toast('复制失败，请手动复制');
            }
        } catch (err) {
            console.error('降级复制方案失败:', err);
        }
        
        // 移除临时创建的元素
        document.body.removeChild(textArea);
    }
}

// 统一的成功提示函数（可以对接你上一问的 Bootstrap Toast）
function handleCopySuccess(text) {
    console.log('复制成功:', text);
    // 如果你有 toast 函数，可以在这里调用：
    toast(`成功复制: ${text}`);
}

/**
 * 全局通用确认弹窗
 * @param {string} message 提示内容
 * @param {string} title 提示标题（可选，默认为 '提示'）
 * @returns {Promise<boolean>} 返回一个 Promise，用户点击确定返回 true，点击取消返回 false
 */
function showConfirm(message, title = '提示') {
    return new Promise((resolve) => {
        // 1. 获取 DOM 元素
        const modalEl = document.getElementById('globalConfirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const messageEl = document.getElementById('confirmMessage');
        const btnOk = document.getElementById('confirmBtnOk');
        const btnCancel = document.getElementById('confirmBtnCancel');
        const btnClose = modalEl.querySelector('.btn-close');

        // 2. 动态修改文字内容
        titleEl.innerText = title;
        messageEl.innerHTML = message; // 支持传入 HTML 结构（如加粗文字）

        // 3. 初始化 Bootstrap Modal 实例
        const bsModal = new bootstrap.Modal(modalEl);

        // 4. 定义事件清理函数（防止多次绑定导致内存泄漏和逻辑混乱）
        function cleanup(result) {
            resolve(result);
            bsModal.hide(); // 隐藏弹窗
            // 移除所有按钮的点击事件，防止下次调用叠加
            btnOk.onclick = null;
            btnCancel.onclick = null;
            btnClose.onclick = null;
        }

        // 5. 绑定点击事件
        btnOk.onclick = () => cleanup(true);
        btnCancel.onclick = () => cleanup(false);
        btnClose.onclick = () => cleanup(false);

        // 6. 显示弹窗
        bsModal.show();
    });
}

/**
 * 显示一个 Bootstrap Toast 提示
 * @param {string} message - Toast 内容
 * @param {string} title - (可选) 标题，默认显示 "提示"
 * @example
 * // 在页面上显示一个提示消息
 * toast('这是一个提示消息');
 */
function toast(message, title = '提示') {
    // 1. 确保页面存在 toast-container，若不存在则创建一个
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container position-fixed bottom-0 end-0 p-3';
        document.body.appendChild(container);
    }

    // 2. 创建 Toast DOM 结构
    const toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'alert');
    toastEl.setAttribute('aria-live', 'assertive');
    toastEl.setAttribute('aria-atomic', 'true');
    
    toastEl.innerHTML = `
        <div class="toast-header">
            <strong class="me-auto">${title}</strong>
            <small class="text-muted">刚刚</small>
            <button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
        <div class="toast-body">
            ${message}
        </div>
    `;

    container.appendChild(toastEl);

    // 3. 初始化并显示
    const bsToast = new bootstrap.Toast(toastEl, { delay: 3000 });
    bsToast.show();

    // 4. 彻底销毁逻辑：不仅隐藏，还要从 DOM 中移除
    toastEl.addEventListener('hidden.bs.toast', () => {
        toastEl.remove();
    });
}