/**
 * 随机取名（阶段 6）：男名 / 女名 / 门派 / 地点。
 * 纯本地词典组合生成，点击名字即复制。
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { Modal } from './Modal';
import { IconCopy, IconRefresh } from './icons';
import type { NameKind } from '../types/models';

const KINDS: { key: NameKind; label: string }[] = [
  { key: 'male', label: '男名' },
  { key: 'female', label: '女名' },
  { key: 'sect', label: '门派' },
  { key: 'place', label: '地点' },
];

export function NameGeneratorModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const [kind, setKind] = useState<NameKind>('male');
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const roll = useCallback(async (k: NameKind) => {
    setBusy(true);
    try {
      setNames(await api.generateNames(k, 12));
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  }, [showToast]);

  useEffect(() => {
    void roll(kind);
  }, [kind, roll]);

  const copy = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      showToast(`已复制「${name}」`);
    } catch {
      showToast('复制失败（剪贴板不可用）', 'error');
    }
  };

  return (
    <Modal title="随机取名" onClose={onClose} width={520}>
      <div className="tabs">
        {KINDS.map((k) => (
          <button
            key={k.key}
            className={`tab${kind === k.key ? ' active' : ''}`}
            onClick={() => setKind(k.key)}
          >
            {k.label}
          </button>
        ))}
        <button
          className="btn btn-ghost tab-refresh"
          onClick={() => void roll(kind)}
          disabled={busy}
          title="换一批"
        >
          <IconRefresh size={14} /> 换一批
        </button>
      </div>
      <ul className="name-grid">
        {names.map((n) => (
          <li key={n}>
            <button className="name-chip" onClick={() => void copy(n)} title="点击复制">
              {n}
              <IconCopy size={12} />
            </button>
          </li>
        ))}
      </ul>
      <p className="form-hint">点击名字复制；人物卡中可将其设为主名或别名。</p>
    </Modal>
  );
}
