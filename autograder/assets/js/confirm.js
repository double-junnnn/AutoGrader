/* AutoGrader · 应用内对话框（替代原生 confirm / prompt）
 *
 * 为什么不用原生 confirm / prompt / alert：
 *   1. 部分环境会静默抑制原生对话框并**立即返回 false / null / undefined** ——
 *      微信 / 企业微信内置浏览器、浏览器「阻止弹出式对话框」设置、缺 allow-modals
 *      的 iframe、自动化预览沙箱等。结果是「清空报告 / 删除类型 / 清除 API Key」
 *      点了完全没反应，用户以为按钮坏了（prompt 则表现为"新增维度"直接没加）。
 *   2. 原生对话框阻塞主线程、样式不可控、深浅主题下观感割裂。
 *
 * 对外 API（都返回 Promise）：
 *   await AG.confirm({ title, message, okText, cancelText, danger })
 *       -> true（确定）/ false（取消 / Esc / 点遮罩）
 *   await AG.ask({ title, message, placeholder, value, okText, cancelText, maxlength })
 *       -> string（确定时的输入）/ null（取消）
 *   AG.dialogInit()  // 绑定弹窗自身事件，init 阶段调用一次
 *
 * 约定：
 *   - 同一时刻只允许一个对话框；已有未决对话框时先按"取消"结算旧的，避免 Promise 悬挂。
 *   - 键盘：Enter 确定、Esc 取消；输入型对话框里 Enter 提交、Shift+Enter 不生效（单行）。
 *   - 危险操作（danger）确定按钮标红。
 *   - 焦点归还给触发元素（可访问性）。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});

  let pending = null;   // { resolve, opener }

  function $(sel) { return document.querySelector(sel); }

  /** 关闭弹窗并结算 Promise */
  function settle(result) {
    const mask = $('#dialogMask');
    if (mask) mask.classList.remove('on');
    if (!pending) return;
    const { resolve, opener } = pending;
    pending = null;
    if (opener && document.contains(opener)) { try { opener.focus(); } catch (_) {} }
    resolve(result);
  }

  /**
   * 打开对话框。opts.mode === 'ask' 时显示输入框，否则纯确认。
   * 统一入口，confirm / ask 都是它的薄封装。
   */
  function openDialog(opts) {
    opts = opts || {};
    const isAsk = opts.mode === 'ask';
    const mask = $('#dialogMask');

    // 极端兜底：DOM 缺失（理论上不会）时退回原生，至少不静默丢操作
    if (!mask || !mask.querySelector('.modal')) {
      if (isAsk) {
        /* eslint-disable no-alert */
        const r = global.prompt ? global.prompt(opts.message || '', opts.value || '') : null;
        return Promise.resolve(r);
      }
      const r = global.confirm ? global.confirm(opts.message || '') : true;
      return Promise.resolve(!!r);
    }

    if (pending) settle(isAsk ? null : false);

    const opener = document.activeElement;
    const titleEl = $('#dialogTitle');
    const msgEl = $('#dialogMsg');
    const inputEl = $('#dialogInput');
    const okBtn = $('#dialogOk');
    const cancelBtn = $('#dialogCancel');

    titleEl.textContent = opts.title || (isAsk ? '请输入' : '确认操作');
    msgEl.textContent = opts.message || '';
    msgEl.hidden = !opts.message;
    okBtn.textContent = opts.okText || '确定';
    okBtn.className = 'btn ' + (opts.danger ? 'danger-solid' : 'primary');
    cancelBtn.textContent = opts.cancelText || '取消';

    if (isAsk) {
      inputEl.hidden = false;
      inputEl.placeholder = opts.placeholder || '';
      inputEl.value = opts.value != null ? String(opts.value) : '';
      if (opts.maxlength) inputEl.setAttribute('maxlength', String(opts.maxlength));
      else inputEl.removeAttribute('maxlength');
    } else {
      inputEl.hidden = true;
      inputEl.value = '';
    }

    // 弹窗从触发源位置弹簧展开（Apple 流体：出入场路径对称）
    const modal = mask.querySelector('.modal');
    if (opener && opener.getBoundingClientRect) {
      const r = opener.getBoundingClientRect();
      if (r.width || r.height) {
        modal.style.transformOrigin =
          (((r.left + r.width / 2) / (global.innerWidth || 1)) * 100).toFixed(1) + '% ' +
          (((r.top + r.height / 2) / (global.innerHeight || 1)) * 100).toFixed(1) + '%';
      } else {
        modal.style.transformOrigin = 'center';
      }
    }

    mask.classList.add('on');

    return new Promise((resolve) => {
      pending = {
        resolve: (result) => resolve(isAsk ? (result ? inputEl.value.trim() : null) : !!result),
        opener,
      };
      // 输入型聚焦文本框并全选，方便直接改写；确认型聚焦"确定"
      if (isAsk) { inputEl.focus(); try { inputEl.select(); } catch (_) {} }
      else okBtn.focus();
    });
  }

  function confirm(opts) {
    opts = opts || {};
    return openDialog(Object.assign({}, opts, { mode: 'confirm' }));
  }
  function ask(opts) {
    opts = opts || {};
    return openDialog(Object.assign({}, opts, { mode: 'ask' }));
  }

  /** 绑定对话框自身的按钮/键盘（只做一次） */
  function dialogInit() {
    const mask = $('#dialogMask');
    if (!mask || mask.__dlgBound) return;
    mask.__dlgBound = true;

    $('#dialogOk').addEventListener('click', () => settle(true));
    $('#dialogCancel').addEventListener('click', () => settle(false));
    // 点遮罩空白处 = 取消
    mask.addEventListener('click', (e) => { if (e.target === mask) settle(false); });
    // 键盘：Enter 确定 / Esc 取消
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); settle(false); }
      else if (e.key === 'Enter' && e.target.id !== 'dialogCancel') { e.preventDefault(); settle(true); }
    });
  }

  AG.confirm = confirm;
  AG.ask = ask;
  AG.dialogInit = dialogInit;
  AG.ui = AG.ui || {};
  AG.ui.confirm = confirm;
  AG.ui.ask = ask;
})(window);
