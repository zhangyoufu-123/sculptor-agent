// 网络文档阅读 + 文段吸收 + 英文套话检测 单测。
// 运行: node test/ingest-sample.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchUrlInput, isUrl, isPrivateHost } from '../src/io.js';
import * as ws from '../src/workspace.js';
import { audit, isEnglishText, EN_BLACKLIST } from '../src/redteam.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

// 1. isUrl
assert.equal(isUrl('https://example.com/a.docx'), true);
assert.equal(isUrl('http://x/y.md'), true);
assert.equal(isUrl('/local/file.md'), false);
assert.equal(isUrl('file.docx'), false);
ok('isUrl 判断正确');

// 2. fetchUrlInput:本地 HTTP 服务器模拟下载 md
const http = await import('node:http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/markdown' });
  res.end('# 网络文档\n这是从网络下载的一段好文字。');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const r = await fetchUrlInput(`http://127.0.0.1:${port}/doc.md`, { timeoutMs: 5000 });
server.close();
assert.equal(r.kind, 'text');
assert.ok(r.text.includes('网络文档'), '下载并提取 md 内容');
assert.equal(r.downloaded, true);
assert.equal(r.sourceUrl, `http://127.0.0.1:${port}/doc.md`);
ok('fetchUrlInput 下载并提取 md');

// 3. fetchUrlInput:非 URL 返回 unsupported
const bad = await fetchUrlInput('not-a-url', {});
assert.equal(bad.kind, 'unsupported');
assert.ok(bad.hint.includes('不是有效 URL'));
ok('fetchUrlInput 非 URL 优雅降级');

// 3b. SSRF 防护:私网判定
assert.equal(isPrivateHost('127.0.0.1'), true);
assert.equal(isPrivateHost('localhost'), true);
assert.equal(isPrivateHost('10.0.0.1'), true);
assert.equal(isPrivateHost('192.168.1.1'), true);
assert.equal(isPrivateHost('172.16.0.1'), true);
assert.equal(isPrivateHost('example.com'), false);
assert.equal(isPrivateHost('registry.npmjs.org'), false);
ok('isPrivateHost 私网判定(127/10/192.168/172.16/localhost vs 公网)');

// 3c. 严格模式:STYLOTRACE_BLOCK_PRIVATE_URL=1 拒绝私网
const blocked = await fetchUrlInput(`http://127.0.0.1:${port}/doc.md`, { blockPrivateUrl: '1', timeoutMs: 5000 });
assert.equal(blocked.kind, 'unsupported');
assert.ok(blocked.hint.includes('私网地址被拒绝'));
ok('严格模式拒绝私网地址(SSRF 防护)');

// 4. absorbSample:文段进风格样本
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-abs-'));
const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, 'vault'), { recursive: true });
const f = ws.absorbSample(wsDir, '其实地上本没有路，走的人多了，也便成了路。', { author: '鲁迅', source: '《故乡》' });
assert.ok(fs.existsSync(f), '样本文件落盘');
const content = fs.readFileSync(f, 'utf8');
assert.ok(content.includes('鲁迅'), '含作者');
assert.ok(content.includes('其实地上本没有路'), '含文段');
const f2 = ws.absorbSample(wsDir, '第二段喜欢的文字。');
assert.notEqual(f, f2, '每次吸收生成独立文件');
ok('absorbSample 吸收文段进风格样本(含作者/出处)');

// 5. isEnglishText
assert.equal(isEnglishText('In today\'s world, this is a robust and seamless solution.'), true);
assert.equal(isEnglishText('在当今社会，这是一个很好的方案。'), false);
ok('isEnglishText 区分中英文');

// 6. 英文套话检测
const enText = 'In today\'s fast-paced world, it\'s worth noting that leveraging the power of AI is a game-changer. Furthermore, this robust, seamless, holistic approach unlocks the potential. In conclusion, it is a testament to innovation.';
const enAudit = audit(enText);
assert.ok(enAudit.blacklistHits.length >= 5, `英文套话应命中多个,实际 ${enAudit.blacklistHits.length}`);
const hitPhrases = enAudit.blacklistHits.map((h) => h.phrase);
assert.ok(hitPhrases.some((p) => p.includes('fast-paced')), '命中 In today\'s fast-paced world');
assert.ok(hitPhrases.some((p) => p === 'game-changer'), '命中 game-changer');
assert.ok(hitPhrases.some((p) => p === 'robust'), '命中 robust');
ok('英文套话检测命中(多语言优化)');

// 7. 英文文本人类化指数应偏低(套话多)
assert.ok(enAudit.humanizationScore < 60, `英文套话文本人类化指数应 <60,实际 ${enAudit.humanizationScore}`);
ok('英文套话文本人类化指数偏低');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ningest-sample.test.mjs 全部通过 (${passed} 项)`);
