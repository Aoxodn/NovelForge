/** 模态对话框（新建项目 / 重命名 / 删除确认 / 显示设置共用） */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 460,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();

  // 将焦点带入对话框，并在关闭时交还给触发控件。
  useEffect(() => {
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => {
      const root = modalRef.current;
      if (!root) return;
      const target = root.querySelector<HTMLElement>(
        '[autofocus], input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
      );
      (target ?? root).focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      previouslyFocused.current?.focus();
    };
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const root = modalRef.current;
    if (!root) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === root)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={modalRef}
        className="modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span id={titleId}>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** 通用：带输入框的对话框（重命名 / 新建等） */
export function PromptModal({
  title,
  initial,
  placeholder,
  confirmText = "确定",
  onCancel,
  onConfirm,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  confirmText?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={400}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              const input = document.getElementById(
                "modal-prompt-input",
              ) as HTMLInputElement;
              onConfirm(input.value);
            }}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <input
        id="modal-prompt-input"
        className="input"
        defaultValue={initial}
        placeholder={placeholder}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const input = e.currentTarget;
            onConfirm(input.value);
          }
        }}
      />
    </Modal>
  );
}
