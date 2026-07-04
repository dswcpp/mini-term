import { t } from "../i18n";

interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
}

let promptId = 0;
const promptStack: HTMLDivElement[] = [];

function configureDialog(dialog: HTMLDivElement, titleEl: HTMLDivElement): void {
  const titleId = `prompt-title-${++promptId}`;
  titleEl.id = titleId;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
}

function restoreFocus(previousFocus: Element | null): void {
  if (previousFocus instanceof HTMLElement && document.contains(previousFocus)) {
    previousFocus.focus();
  }
}

function mountPromptOverlay(overlay: HTMLDivElement): void {
  promptStack.push(overlay);
  document.body.appendChild(overlay);
}

function unmountPromptOverlay(overlay: HTMLDivElement): void {
  const idx = promptStack.lastIndexOf(overlay);
  if (idx >= 0) promptStack.splice(idx, 1);
  overlay.remove();
}

function isTopPromptOverlay(overlay: HTMLDivElement): boolean {
  return promptStack[promptStack.length - 1] === overlay;
}

/**
 * 自定义 confirm 弹窗，替代 window.confirm
 * 返回 Promise<boolean>
 */
export function showConfirm(title: string, message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'prompt-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'prompt-dialog';

    const titleEl = document.createElement('div');
    titleEl.className = 'prompt-title';
    titleEl.textContent = title;
    configureDialog(dialog, titleEl);
    dialog.appendChild(titleEl);

    const msgEl = document.createElement('div');
    msgEl.className = 'prompt-message';
    msgEl.textContent = message;
    dialog.appendChild(msgEl);

    const buttons = document.createElement('div');
    buttons.className = 'prompt-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'prompt-btn prompt-btn-cancel';
    cancelBtn.textContent = options.cancelLabel ?? t("prompt.cancel");

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'prompt-btn prompt-btn-confirm';
    confirmBtn.textContent = options.confirmLabel ?? t("prompt.confirm");

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    mountPromptOverlay(overlay);

    confirmBtn.focus();

    let settled = false;

    const cleanup = (value: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', keydownHandler);
      unmountPromptOverlay(overlay);
      restoreFocus(previousFocus);
      resolve(value);
    };

    const keydownHandler = (e: KeyboardEvent) => {
      if (!isTopPromptOverlay(overlay)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(true);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(false);
      }
    };

    confirmBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    document.addEventListener('keydown', keydownHandler);
  });
}

/**
 * 自定义信息提示弹窗，替代 window.alert
 * 只有一个「知道了」按钮，返回 Promise<void>
 */
export function showAlert(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'prompt-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'prompt-dialog';

    const titleEl = document.createElement('div');
    titleEl.className = 'prompt-title';
    titleEl.textContent = title;
    configureDialog(dialog, titleEl);
    dialog.appendChild(titleEl);

    const msgEl = document.createElement('div');
    msgEl.className = 'prompt-message';
    msgEl.textContent = message;
    dialog.appendChild(msgEl);

    const buttons = document.createElement('div');
    buttons.className = 'prompt-buttons';

    const okBtn = document.createElement('button');
    okBtn.className = 'prompt-btn prompt-btn-confirm';
    okBtn.textContent = t("prompt.ok");

    buttons.appendChild(okBtn);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    mountPromptOverlay(overlay);

    okBtn.focus();

    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', keydownHandler);
      unmountPromptOverlay(overlay);
      restoreFocus(previousFocus);
      resolve();
    };

    const keydownHandler = (e: KeyboardEvent) => {
      if (!isTopPromptOverlay(overlay)) return;
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      }
    };

    okBtn.onclick = cleanup;
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };
    document.addEventListener('keydown', keydownHandler);
  });
}

/**
 * 自定义 prompt 弹窗，替代 window.prompt
 * 返回 Promise<string | null>，取消返回 null
 */
export function showPrompt(title: string, placeholder?: string, defaultValue?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    // 遮罩层
    const overlay = document.createElement('div');
    overlay.className = 'prompt-overlay';

    // 弹窗
    const dialog = document.createElement('div');
    dialog.className = 'prompt-dialog';

    // 标题
    const titleEl = document.createElement('div');
    titleEl.className = 'prompt-title';
    titleEl.textContent = title;
    configureDialog(dialog, titleEl);
    dialog.appendChild(titleEl);

    // 输入框
    const input = document.createElement('input');
    input.className = 'prompt-input';
    input.placeholder = placeholder ?? '';
    input.spellcheck = false;
    if (defaultValue) {
      input.value = defaultValue;
    }
    dialog.appendChild(input);

    // 按钮区
    const buttons = document.createElement('div');
    buttons.className = 'prompt-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'prompt-btn prompt-btn-cancel';
    cancelBtn.textContent = t("prompt.cancel");

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'prompt-btn prompt-btn-confirm';
    confirmBtn.textContent = t("prompt.confirm");

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    mountPromptOverlay(overlay);

    input.focus();

    let settled = false;

    const cleanup = (value: string | null) => {
      if (settled) return;
      settled = true;
      unmountPromptOverlay(overlay);
      restoreFocus(previousFocus);
      resolve(value);
    };

    confirmBtn.onclick = () => cleanup(input.value || null);
    cancelBtn.onclick = () => cleanup(null);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
    input.onkeydown = (e) => {
      if (!isTopPromptOverlay(overlay)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(input.value || null);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(null);
      }
    };
  });
}
