/**
 * 新建小说项目对话框：书名 / 作者 / 简介 / 存放位置。
 *
 * 两种模式：
 * - blank（默认）：创建空项目；
 * - import：从已有文档（txt / docx / md）建项并导入——
 *   选择文档后书名 / 存放位置自动预填，创建成功即进入智能导入流程。
 */
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Modal } from './Modal';
import { useAppStore } from '../store/appStore';

/** 从文件路径拆出父目录与不含扩展名的文件名 */
function splitPath(p: string): { dir: string; stem: string } {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  const dir = i > 0 ? p.slice(0, i) : p;
  const name = i >= 0 ? p.slice(i + 1) : p;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return { dir, stem };
}

export function NewProjectModal({
  onClose,
  mode = 'blank',
}: {
  onClose: () => void;
  mode?: 'blank' | 'import';
}) {
  const createProject = useAppStore((s) => s.createProject);
  const setPendingImportPath = useAppStore((s) => s.setPendingImportPath);
  const [name, setName] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [dir, setDir] = useState('');
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(false);

  const pickDir = async () => {
    const selected = await open({ directory: true, title: '选择小说项目存放位置' });
    if (typeof selected === 'string') setDir(selected);
  };

  const pickFile = async () => {
    const selected = await open({
      multiple: false,
      title: '选择要导入的小说文档',
      filters: [{ name: '小说文档', extensions: ['txt', 'docx', 'md'] }],
    });
    if (typeof selected !== 'string') return;
    const { dir: parent, stem } = splitPath(selected);
    setFile(selected);
    // 书名 / 位置未手改过则跟随文档名
    setName((prev) => (prev ? prev : stem));
    setDir((prev) => (prev ? prev : parent));
  };

  const submit = async () => {
    if (!name.trim() || !dir.trim()) return;
    if (mode === 'import' && !file) return;
    setBusy(true);
    const ok = await createProject({
      name: name.trim(),
      author: author.trim(),
      description: description.trim(),
      parentDir: dir.trim(),
    });
    setBusy(false);
    if (ok) {
      if (mode === 'import') setPendingImportPath(file);
      onClose();
    }
  };

  const fileName = file ? splitPath(file).stem : '';

  return (
    <Modal
      title={mode === 'import' ? '导入小说' : '新建小说'}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !name.trim() || !dir.trim() || (mode === 'import' && !file)}
          >
            {busy ? '创建中…' : mode === 'import' ? '创建并导入' : '创建'}
          </button>
        </>
      }
    >
      {mode === 'import' && (
        <div className="form-row">
          <label>小说文档 *</label>
          <div className="dir-picker">
            <input
              className="input"
              value={file}
              readOnly
              placeholder="选择 TXT / DOCX / MD 文档"
              title={file}
            />
            <button className="btn" onClick={pickFile}>
              浏览…
            </button>
          </div>
          <p className="form-hint">
            选中文档后自动填充书名与存放位置；创建项目后将进入智能导入，
            自动识别章节结构、跳过重复内容。
          </p>
        </div>
      )}
      <div className="form-row">
        <label>书名 *</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={mode === 'import' ? fileName || '例如：青云记' : '例如：青云记'}
          autoFocus
        />
      </div>
      <div className="form-row">
        <label>作者</label>
        <input
          className="input"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="笔名（可选）"
        />
      </div>
      <div className="form-row">
        <label>简介</label>
        <textarea
          className="input"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话简介（可选）"
        />
      </div>
      <div className="form-row">
        <label>存放位置 *</label>
        <div className="dir-picker">
          <input
            className="input"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="选择或输入文件夹路径"
          />
          <button className="btn" onClick={pickDir}>
            浏览…
          </button>
        </div>
        <p className="form-hint">项目将以独立文件夹保存，包含专属数据库，可随时迁移与备份。</p>
      </div>
    </Modal>
  );
}
