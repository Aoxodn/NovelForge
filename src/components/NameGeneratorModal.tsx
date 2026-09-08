/**
 * 随机取名（0.7.0 扩展）：人名 / 地名 / 势力 / 功法 / 装备 / 丹药 / 动物 / 灵植。
 * 人名支持性别 / 国家 / 姓数 / 指定姓氏与名字筛选；点击名字即复制。
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { Modal } from './Modal';
import { IconCopy, IconRefresh } from './icons';
import type { NameGenre, NameKind, NameParams } from '../types/models';

const TABS: { key: NameKind; label: string }[] = [
  { key: 'person', label: '人名' },
  { key: 'place', label: '地名' },
  { key: 'sect', label: '势力' },
  { key: 'technique', label: '功法' },
  { key: 'item', label: '装备' },
  { key: 'pill', label: '丹药' },
  { key: 'beast', label: '动物' },
  { key: 'plant', label: '灵植' },
];

type Gender = NonNullable<NameParams['gender']>;
type Country = NonNullable<NameParams['country']>;
type SurnameType = NonNullable<NameParams['surnameType']>;

/** 筛选选项组 */
function FilterGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { v: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="filter-group">
      <span className="filter-label">{label}</span>
      <div className="filter-chips">
        {options.map((o) => (
          <button
            key={o.v}
            className={`chip${value === o.v ? ' active' : ''}`}
            onClick={() => onChange(o.v)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function NameGeneratorModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const [kind, setKind] = useState<NameKind>('person');
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // 题材（组合类）：后端拉取清单，未建设题材置灰
  const [genres, setGenres] = useState<NameGenre[]>([]);
  const [genre, setGenre] = useState('xuanhuan');

  // 人名筛选
  const [gender, setGender] = useState<Gender>('any');
  const [country, setCountry] = useState<Country>('cn');
  const [surnameType, setSurnameType] = useState<SurnameType>('any');
  const [surname, setSurname] = useState('');
  const [given, setGiven] = useState('');

  useEffect(() => {
    api
      .listNameGenres()
      .then(setGenres)
      .catch(() => setGenres([]));
  }, []);

  const roll = useCallback(
    async (k: NameKind, useInputs: boolean) => {
      setBusy(true);
      try {
        const params: NameParams | undefined =
          k === 'person'
            ? {
                gender,
                country,
                surnameType,
                surname: useInputs && surname ? surname.trim() : undefined,
                given: useInputs && given ? given.trim() : undefined,
              }
            : { genre };
        setNames(await api.generateNames(k, 15, params));
      } catch (e) {
        showToast(String(e), 'error');
      } finally {
        setBusy(false);
      }
    },
    [genre, gender, country, surnameType, surname, given, showToast],
  );

  // 切换类目 / 题材 / 点筛选时立即重掷；输入框内容变化不自动掷（点「生成」）
  useEffect(() => {
    void roll(kind, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, genre, gender, country, surnameType]);

  const copy = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      showToast(`已复制「${name}」`);
    } catch {
      showToast('复制失败（剪贴板不可用）', 'error');
    }
  };

  return (
    <Modal title="随机取名" onClose={onClose} width={640}>
      <div className="tabs namegen-tabs">
        {TABS.map((k) => (
          <button
            key={k.key}
            className={`tab${kind === k.key ? ' active' : ''}`}
            onClick={() => setKind(k.key)}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="namegen-body">
        <div className="namegen-filters">
          {kind === 'person' ? (
            <>
              <FilterGroup
                label="性别"
                value={gender}
                options={[
                  { v: 'any', label: '任意' },
                  { v: 'male', label: '男' },
                  { v: 'female', label: '女' },
                ]}
                onChange={(v) => setGender(v as Gender)}
              />
              <FilterGroup
                label="国家"
                value={country}
                options={[
                  { v: 'cn', label: '中国' },
                  { v: 'jp', label: '日本' },
                  { v: 'west', label: '欧美' },
                ]}
                onChange={(v) => setCountry(v as Country)}
              />
              {country === 'cn' && (
                <FilterGroup
                  label="姓数"
                  value={surnameType}
                  options={[
                    { v: 'any', label: '任意' },
                    { v: 'single', label: '单姓' },
                    { v: 'compound', label: '复姓' },
                  ]}
                  onChange={(v) => setSurnameType(v as SurnameType)}
                />
              )}
              <div className="filter-group">
                <span className="filter-label">姓氏（可选）</span>
                <input
                  className="input"
                  value={surname}
                  onChange={(e) => setSurname(e.target.value)}
                  placeholder="指定姓氏"
                />
              </div>
              <div className="filter-group">
                <span className="filter-label">名字（可选）</span>
                <input
                  className="input"
                  value={given}
                  onChange={(e) => setGiven(e.target.value)}
                  placeholder="指定名字"
                />
              </div>
              <button
                className="namegen-generate"
                disabled={busy}
                onClick={() => void roll(kind, true)}
              >
                生成
              </button>
            </>
          ) : (
            <>
              <div className="filter-group">
                <span className="filter-label">题材</span>
                <select
                  className="select"
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                >
                  {genres.map((g) => (
                    <option key={g.key} value={g.key} disabled={!g.ready}>
                      {g.core ? '★' : '☆'}
                      {g.label}
                      {g.ready ? '' : '（词典建设中）'}
                    </option>
                  ))}
                </select>
              </div>
              <p className="namegen-hint">
                {kind === 'place' && '山川城镇、秘境关卡，按题材审美随机组合地名。'}
                {kind === 'sect' && '宗门教派、山庄书院，按题材审美随机组合势力名。'}
                {kind === 'technique' && '功法武学、心法神通，按题材审美随机组合。'}
                {kind === 'item' && '神兵利器、法宝奇物，按题材审美随机组合。'}
                {kind === 'pill' && '灵丹妙药，按题材审美随机组合。'}
                {kind === 'beast' && '妖兽灵禽，按题材审美随机组合。'}
                {kind === 'plant' && '灵草仙株，按题材审美随机组合。'}
              </p>
            </>
          )}
        </div>

        <ul className="name-grid namegen-grid">
          {names.map((n) => (
            <li key={n}>
              <button className="name-chip" onClick={() => void copy(n)} title="点击复制">
                {n}
                <IconCopy size={12} />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <button
        className="btn btn-ghost tab-refresh namegen-refresh"
        onClick={() => void roll(kind, false)}
        disabled={busy}
        title="换一批"
      >
        <IconRefresh size={14} /> 换一批
      </button>
      <p className="form-hint">点击名字复制；人物卡中可将其设为主名或别名。</p>
    </Modal>
  );
}
