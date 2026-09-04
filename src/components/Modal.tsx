/** 模态对话框（新建项目 / 重命名 / 删除确认 / 显示设置共用） */
import { type ReactNode, useEffect } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Modal({ title, onClose, children, footer, width = 460 }: ModalProps) {
  // Esc 关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
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
  confirmText = '确定',
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
              const input = document.getElementById('modal-prompt-input') as HTMLInputElement;
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
          if (e.key === 'Enter') {
            const input = e.currentTarget;
            onConfirm(input.value);
          }
        }}
      />
    </Modal>
  );
}
