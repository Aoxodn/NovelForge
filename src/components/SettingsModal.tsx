/** 显示设置：编辑器字体 / 字号 / 行距（写作舒适度优化） */
import { Modal } from './Modal';
import { useAppStore } from '../store/appStore';

const FONTS = [
  { label: '雅黑（无衬线）', value: "'Microsoft YaHei', 'PingFang SC', sans-serif" },
  { label: '思源宋体（衬线）', value: "'Noto Serif SC', 'Source Han Serif SC', '思源宋体', 'Songti SC', 'SimSun', serif" },
  { label: '宋体', value: "'SimSun', 'Songti SC', serif" },
  { label: '楷体', value: "'KaiTi', 'Kaiti SC', serif" },
  { label: '仿宋', value: "'FangSong', 'Fangsong SC', serif" },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const editorSettings = useAppStore((s) => s.editorSettings);
  const update = useAppStore((s) => s.updateEditorSettings);
  const writerSettings = useAppStore((s) => s.writerSettings);
  const updateWriter = useAppStore((s) => s.updateWriterSettings);

  return (
    <Modal title="设置" onClose={onClose} width={440}>
      <h4 className="settings-section">显示</h4>
      <div className="form-row">
        <label>正文字体</label>
        <select
          className="select"
          value={editorSettings.fontFamily}
          onChange={(e) => update({ fontFamily: e.target.value })}
        >
          {FONTS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>字号：{editorSettings.fontSize}px</label>
        <input
          type="range"
          min={14}
          max={26}
          step={1}
          value={editorSettings.fontSize}
          onChange={(e) => update({ fontSize: Number(e.target.value) })}
        />
      </div>
      <div className="form-row">
        <label>行距：{editorSettings.lineHeight.toFixed(1)}</label>
        <input
          type="range"
          min={1.4}
          max={2.6}
          step={0.1}
          value={editorSettings.lineHeight}
          onChange={(e) => update({ lineHeight: Number(e.target.value) })}
        />
      </div>

      <h4 className="settings-section">码字</h4>
      <div className="form-row">
        <label>日更目标（字，0 为不设置）</label>
        <input
          className="input"
          type="number"
          min={0}
          step={500}
          value={writerSettings.dailyGoal || ''}
          placeholder="如 4000"
          onChange={(e) => updateWriter({ dailyGoal: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>
      <div className="form-row">
        <label>稿费单价（元 / 千字，0 为不显示）</label>
        <input
          className="input"
          type="number"
          min={0}
          step={1}
          value={writerSettings.feePerK || ''}
          placeholder="如 30"
          onChange={(e) => updateWriter({ feePerK: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>
      <div className="form-row">
        <label>摸鱼提醒（空闲超过 N 分钟提醒）</label>
        <select
          className="select"
          value={writerSettings.idleReminderMin}
          onChange={(e) => updateWriter({ idleReminderMin: Number(e.target.value) })}
        >
          <option value={0}>关闭</option>
          <option value={5}>5 分钟</option>
          <option value={10}>10 分钟</option>
          <option value={15}>15 分钟</option>
          <option value={30}>30 分钟</option>
        </select>
      </div>

      <p className="form-hint">设置即时生效并保存在本机，不影响小说数据。</p>
    </Modal>
  );
}
