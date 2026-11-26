/** 可搜索成员下拉选择器（替代原生 select，支持按真名 / Handle / 届别即时过滤与键盘导航）。 */
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import styles from './MemberCombobox.module.css';

export interface MemberComboboxOption {
  id: string;
  name: string;
  username?: string;
  enrollYear?: number;
  avatar?: string | null;
}

interface MemberComboboxProps {
  label: string;
  placeholder?: string;
  value: string;
  options: readonly MemberComboboxOption[];
  onChange: (value: string) => void;
}

export function MemberCombobox({
  label,
  placeholder = '搜索成员姓名、Handle 或届别…',
  value,
  options,
  onChange,
}: MemberComboboxProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = useMemo(
    () => options.find((opt) => opt.id === value) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((opt) => {
      const hay = [
        opt.name,
        opt.username ?? '',
        opt.enrollYear ? `${opt.enrollYear}级` : '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [options, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const handleSelect = (opt: MemberComboboxOption) => {
    onChange(opt.id);
    setOpen(false);
    setQuery('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((idx) => (filtered.length > 0 ? (idx + 1) % filtered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((idx) =>
        filtered.length > 0 ? (idx - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (e.key === 'Enter' && open && filtered[activeIndex]) {
      e.preventDefault();
      handleSelect(filtered[activeIndex]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div ref={wrapRef} className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div
        className={`${styles.control} ${open ? styles.controlOpen : ''}`}
        onClick={() => {
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        <Search size={13} className={styles.searchIcon} aria-hidden="true" />
        {!open && selected ? (
          <div className={styles.selectedDisplay}>
            <span className={styles.miniAvatar} aria-hidden="true">
              {selected.avatar ? (
                <img src={selected.avatar} alt="" className={styles.miniAvatarImg} />
              ) : (
                Array.from(selected.name)[0]?.toLocaleUpperCase() || '?'
              )}
            </span>
            <span className={styles.selectedName}>{selected.name}</span>
            {selected.enrollYear ? (
              <span className={styles.gradeTag}>{selected.enrollYear}级</span>
            ) : null}
            {selected.username ? (
              <span className={styles.handleText}>@{selected.username}</span>
            ) : null}
          </div>
        ) : (
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            value={query}
            placeholder={selected ? `已选：${selected.name}（输入重新搜索）` : placeholder}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={handleKeyDown}
          />
        )}
        {value ? (
          <button
            type="button"
            className={styles.clearBtn}
            aria-label="清除已选成员"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              setQuery('');
              setOpen(true);
              inputRef.current?.focus();
            }}
          >
            <X size={13} />
          </button>
        ) : (
          <ChevronDown size={14} className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} />
        )}
      </div>

      {open && (
        <div className={styles.dropdown} role="listbox" aria-label={label}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>未找到匹配的队友</div>
          ) : (
            filtered.map((opt, idx) => {
              const isSelected = opt.id === value;
              const isHighlighted = idx === activeIndex;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`${styles.option} ${isHighlighted ? styles.optionActive : ''} ${
                    isSelected ? styles.optionSelected : ''
                  }`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect(opt);
                  }}
                >
                  <span className={styles.miniAvatar} aria-hidden="true">
                    {opt.avatar ? (
                      <img src={opt.avatar} alt="" className={styles.miniAvatarImg} />
                    ) : (
                      Array.from(opt.name)[0]?.toLocaleUpperCase() || '?'
                    )}
                  </span>
                  <span className={styles.optionMain}>
                    <span className={styles.optionName}>{opt.name}</span>
                    {opt.username && <span className={styles.optionHandle}>@{opt.username}</span>}
                  </span>
                  {opt.enrollYear ? (
                    <span className={styles.gradeTag}>{opt.enrollYear}级</span>
                  ) : null}
                  {isSelected && <Check size={13} className={styles.checkIcon} />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
