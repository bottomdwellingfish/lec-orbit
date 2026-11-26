import { describe, expect, test } from 'bun:test';
import { formatMemberDisplayName } from '../src/shared/punch';

describe('formatMemberDisplayName', () => {
  test('同时存在真名与历史昵称时仅展示真名，不再拼接括号昵称', () => {
    expect(formatMemberDisplayName({ realName: '王硕', displayName: '沉底的鱼', username: 'wangshuo' })).toBe(
      '王硕',
    );
    expect(formatMemberDisplayName({ realName: '  陈美琳 ', displayName: ' dragon ', username: 'dragon' })).toBe(
      '陈美琳',
    );
  });

  test('真名与昵称相同或未设昵称时仅展示真名', () => {
    expect(formatMemberDisplayName({ realName: '林佳政', displayName: '林佳政', username: 'ljz' })).toBe('林佳政');
    expect(formatMemberDisplayName({ realName: '陈俊材', displayName: '', username: 'cjc' })).toBe('陈俊材');
  });

  test('缺少真名时依次回退昵称、用户名与默认称呼', () => {
    expect(formatMemberDisplayName({ displayName: 'FuBot', username: 'fubot' })).toBe('FuBot');
    expect(formatMemberDisplayName({ username: '17hwliao' })).toBe('17hwliao');
    expect(formatMemberDisplayName({})).toBe('工作室成员');
  });
});
