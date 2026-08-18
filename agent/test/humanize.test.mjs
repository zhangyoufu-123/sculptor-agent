// redteam 人类化指数(humanizationScore)单测:区分度 + 建议触发。
// 运行: node test/humanize.test.mjs
import assert from 'node:assert/strict';
import { audit } from '../src/redteam.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

// AI 味:套话堆积 + 逗号子句排比 + 路标式连接词链
const AI_ISH =
  '在当今社会，随着科技的快速发展，我们必须要认识到，总而言之，首先我们要重视这个问题，其次我们要解决这个问题，最后我们要反思这个问题。众所周知，创新是发展的动力，创新是进步的源泉，创新是未来的希望。';
// 自然:短句、具体细节、无套话
const NATURAL =
  '傍晚回到家，把钥匙往鞋柜上一扔，瘫进沙发里。\n\n冰箱里还有昨天剩的半盘饺子，懒得热，就着凉水吃了两个。\n\n阳台的风吹进来，带着楼下桂花树的味儿。突然想起上午那封邮件还没回——算了，明天再说。';
// 假思考:金句排比收束 + 点题顿悟
const FAKE_THINKING =
  '生命，是一场漫长的修行，是一次孤独的跋涉，是一首未完成的诗。我终于明白，原来成长才是最好的答案。';

const rAI = audit(AI_ISH);
const rNat = audit(NATURAL);
const rFake = audit(FAKE_THINKING);

// 1. 字段存在且 0-100
assert.ok(typeof rAI.humanizationScore === 'number' && rAI.humanizationScore >= 0 && rAI.humanizationScore <= 100, 'humanizationScore 范围 0-100');
ok('humanizationScore 字段存在且范围正确');

// 2. 区分度:自然 >> AI 味(≥20 分差距)
assert.ok(rNat.humanizationScore - rAI.humanizationScore >= 20, `区分度不足: 自然 ${rNat.humanizationScore} vs AI味 ${rAI.humanizationScore}`);
ok(`区分度: 自然 ${rNat.humanizationScore} vs AI味 ${rAI.humanizationScore}(≥20)`);

// 3. AI 味 <60 → 触发 humanize 建议
assert.ok(rAI.humanizationScore < 60, `AI 味应 <60, 实际 ${rAI.humanizationScore}`);
assert.ok(rAI.suggestions.some((s) => s.includes('humanize')), 'AI 味文本应触发 transform humanize 建议');
ok('AI 味文本触发 humanize 建议');

// 4. 自然文本 ≥75(不误报)
assert.ok(rNat.humanizationScore >= 75, `自然文本应 ≥75, 实际 ${rNat.humanizationScore}`);
ok(`自然文本 ${rNat.humanizationScore} ≥75(不误报)`);

// 5. 结构痕迹抓到具体类型
assert.ok(
  rAI.structuralSignals.some((s) => s.includes('同构排比')),
  'AI 味文本应命中逗号子句同构排比',
);
assert.ok(
  rAI.structuralSignals.some((s) => s.includes('路标式连接词链')),
  'AI 味文本应命中路标式连接词链',
);
ok('结构痕迹:同构排比 + 路标式连接词链均命中');

// 6. 假思考文本:金句排比 + 点题顿悟命中
assert.ok(
  rFake.structuralSignals.some((s) => s.includes('金句排比')) || rFake.structuralSignals.some((s) => s.includes('顿悟')),
  '假思考文本应命中姿态层痕迹',
);
ok('假思考文本命中姿态层痕迹(金句/顿悟)');

console.log(`\nhumanize.test.mjs 全部通过 (${passed} 项)`);
