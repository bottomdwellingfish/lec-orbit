import { useEffect, useState } from 'react';
import { Button, Card, TextArea } from '@lec-space/liquidglass';
import { orbitServerApi } from '@/services/orbitServerApi';

export function DutyScheduleCard() {
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('读取排班中…');
  useEffect(() => {
    let active = true;
    orbitServerApi.getDutySchedule().then(result => {
      if (!active) return;
      const text = result.groups.map(names => names.join('、')).join('\n');
      setDraft(text); setSaved(text); setMessage('');
    }).catch(() => { if (active) setMessage('未能读取排班，请检查服务连接后重试。'); });
    return () => { active = false; };
  }, [attempt]);

  async function save() {
    const groups = draft.split('\n').filter(line => line.trim()).map(line => line.split(/[、,，]/).map(s => s.trim()).filter(Boolean));
    if (groups.length > 100 || groups.some(g => !g.length || g.length > 100 || g.some(n => n.length > 80))) {
      setMessage('最多 100 组，每组需填写 1–100 个姓名，每个姓名不超过 80 字。'); return;
    }
    setBusy(true);
    try {
      await orbitServerApi.saveDutySchedule(groups);
      const text = groups.map(names => names.join('、')).join('\n');
      setDraft(text); setSaved(text); setMessage(groups.length ? `已保存 ${groups.length} 组排班` : '已清空排班');
    } catch { setMessage('保存失败，请检查队长权限和服务连接后重试。'); }
    finally { setBusy(false); }
  }

  return <Card title="值日生管理" description="每行一组，组内姓名用顿号分隔。首次保存时第 1 组值本周，之后每周一按行序循环。清空后保存可取消排班。">
    <TextArea aria-label="按轮换顺序填写值日小组" rows={5} value={draft} disabled={saved === null || busy}
      placeholder={'张三、李四\n王五、赵六'} onValueChange={text => { setDraft(text); setMessage(''); }} />
    <Button disabled={saved === null || saved === draft || busy} loading={busy} onClick={() => void save()}>保存排班</Button>
    {saved === null && message.startsWith('未能') && <Button onClick={() => { setMessage('读取排班中…'); setAttempt(n => n + 1); }}>重试</Button>}
    <span role="status">{message}</span>
  </Card>;
}
